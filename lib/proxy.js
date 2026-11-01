/**
 * The loopback relay.
 *
 * Responsibilities, in the order a request meets them:
 *   1. control endpoints (`/__openrouter-plus/*`) — exact pathname match;
 *   2. per-target mounts (`/t/<targetId>[/<tier>]/v1/...`) — the destination
 *      comes from the caller's `resolveTarget`, so one listener can front any
 *      number of providers without the relay ever reading plugin config;
 *   3. mount resolution — the longest `routes` key that matches on a segment
 *      boundary, stripped from the path and appended to the upstream base;
 *   4. recipe injection — the top-level `service_tier`, the merged
 *      `provider.sort`/`provider.quantizations` and the model variant;
 *   5. streaming passthrough — the upstream body is piped unbuffered.
 *
 * The relay is deliberately dumb about providers: it never inspects model names,
 * never rewrites a response, and never retries. Its only opinions are the tier
 * and, behind a target mount, the upstream the resolver names. It also never
 * fetches anything: which quantizations a model can actually serve is a public
 * listing the Host resolves before it fills in the recipe, so a floor arrives
 * here already admitted (or already withheld as `null`).
 */
import http from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Headers that belong to one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** How much of a response tail is kept for usage sniffing. */
const SNIFF_TAIL_BYTES = 64 * 1024

/**
 * How much of a response head is kept. The tail is where the usage block lands; the
 * head is where the generation id is, and a long stream evicts it from any fixed tail.
 */
const SNIFF_HEAD_BYTES = 8 * 1024

/**
 * The reserved namespace for per-target mounts. Checked before the configured
 * mounts, so a `routes` key can never shadow a target, and deliberately not part
 * of `resolveRoute`: that function answers for config, and a target is not config
 * the relay can see.
 */
const TARGET_PREFIX = '/t/'

/** Target ids are quoted from the config API: lowercase and path-segment safe. */
const TARGET_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * A tier segment only ever becomes the value of a JSON string, so it has to be a
 * plain token — never a path, a query, or an empty segment.
 */
const TIER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * Headers a pi-ai client uses to advertise the Session it is generating for. The
 * Harness hands the LLM adapter `options.sessionId`, and pi-ai spells that id out
 * one of these ways depending on the wire protocol and its own compat switches.
 * Checked in order, first non-empty wins.
 */
const SESSION_HEADERS = ['x-session-id', 'x-session-affinity', 'session_id', 'x-client-request-id']

/** A session key is only ever a Map key and a config key: bounded, never trusted as a path. */
const SESSION_KEY_MAX = 128

/**
 * The Session a request belongs to, or '' when the client advertised none.
 *
 * The id travels in a header for most protocols, and every OpenAI-flavoured body
 * carries `prompt_cache_key` derived from the very same `options.sessionId` (pi-ai
 * clamps it to 64 characters, and a DSH session id is shorter than that, so it
 * arrives verbatim). Reading both means per-Session tier routing works even when a
 * protocol is configured without session-affinity headers.
 *
 * @param {import('node:http').IncomingHttpHeaders | Record<string, unknown> | undefined} headers
 * @param {unknown} [body] parsed JSON request body, when there was one
 * @returns {string}
 */
export function sessionKeyOf(headers, body) {
  for (const name of SESSION_HEADERS) {
    const raw = headers === undefined || headers === null ? undefined : headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    const text = typeof value === 'string' ? value.trim() : ''
    if (text !== '') return text.slice(0, SESSION_KEY_MAX)
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const raw = /** @type {{ prompt_cache_key?: unknown }} */ (body).prompt_cache_key
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text !== '') return text.slice(0, SESSION_KEY_MAX)
  }
  return ''
}

/**
 * Split a reserved-namespace pathname into the mount and the remainder the target
 * upstream should receive.
 *
 *   /t/<id>/v1/<rest>        → { tier: null,     upstreamPath: '/<rest>' }
 *   /t/<id>/<tier>/v1/<rest> → { tier: '<tier>', upstreamPath: '/<rest>' }
 *
 * The remainder is sliced out of the original pathname rather than rebuilt from
 * split segments, so percent-encoding and repeated slashes survive untouched. The
 * mount's own `/v1` is consumed: the target upstream is the base the provider
 * route was built from, and it carries its own version prefix.
 *
 * @param {string} pathname
 * @returns {{ targetId: string, tier: string|null, upstreamPath: string } | null}
 */
function parseTargetMount(pathname) {
  if (!pathname.startsWith(TARGET_PREFIX)) return null
  const rest = pathname.slice(TARGET_PREFIX.length)
  const slash = rest.indexOf('/')
  const targetId = slash === -1 ? rest : rest.slice(0, slash)
  if (!TARGET_ID.test(targetId)) return null

  const after = slash === -1 ? '' : rest.slice(slash + 1)
  if (after === 'v1') return { targetId, tier: null, upstreamPath: '' }
  if (after.startsWith('v1/')) return { targetId, tier: null, upstreamPath: after.slice(2) }

  const boundary = after.indexOf('/')
  if (boundary === -1) return null
  const tier = after.slice(0, boundary)
  if (!TIER_SEGMENT.test(tier)) return null
  const version = after.slice(boundary + 1)
  if (version === 'v1') return { targetId, tier, upstreamPath: '' }
  if (version.startsWith('v1/')) return { targetId, tier, upstreamPath: version.slice(2) }
  return null
}

/**
 * @typedef {object} UpstreamBase
 * @property {URL} url
 * @property {string} origin  scheme and authority only — safe to echo in a header
 * @property {string} pathname  the base path, never ending in a slash
 * @property {string} search  the base query, including '?' or ''
 */

/**
 * Parse a target upstream: absolute http(s), no credentials (a fetch URL cannot
 * carry them — a provider key belongs in the Authorization header the client
 * already sends), and its path kept without a trailing slash so a join can never
 * double one.
 *
 * @param {unknown} value
 * @returns {UpstreamBase | null}
 */
function parseUpstreamBase(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return {
    url,
    origin: `${url.protocol}//${url.host}`,
    pathname: url.pathname.replace(/\/+$/, ''),
    search: url.search,
  }
}

/**
 * Append the request's remainder to a target base without inventing or doubling a
 * slash: `https://gw/api/v1` plus `/chat/completions` is
 * `https://gw/api/v1/chat/completions`, and an exact mount appends nothing. A
 * query the base itself carries is kept and extended by the request's query.
 *
 * @param {UpstreamBase} base
 * @param {string} upstreamPath  '' or a path that starts with '/'
 * @param {string} search        the request's query, including '?' or ''
 * @returns {string}
 */
function buildTargetUrl(base, upstreamPath, search) {
  let query = base.search
  if (search) query = query ? `${query}&${search.slice(1)}` : search
  return `${base.origin}${base.pathname}${upstreamPath}${query}`
}

/**
 * Names that can only mean this machine. Deliberately narrow: accepting a hostname
 * would need a DNS lookup on the request path, and the mistake this guards against
 * is a mount pointed at a loopback address.
 *
 * @param {string} hostname
 */
function isLoopbackHost(hostname) {
  const name = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (name === 'localhost' || name === '::1' || name === '0.0.0.0' || name === '::') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * @param {object} options
 * @param {string} [options.host='127.0.0.1']
 * @param {number} [options.port=8791]
 * @param {boolean} [options.portFallback=true]
 * @param {string} options.upstream
 * @param {Record<string, string|null>} [options.routes]
 * @param {Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown>} [options.control]
 * @param {(entry: object) => void} [options.onRecord]
 * @param {(model: string, authorization: string | null, destination: string) => void} [options.onModelSeen]
 *        Called once per forwarded request that named a model in its body, with the
 *        caller's `Authorization` value (verbatim) or `null` when it carried none, and the
 *        absolute URL the request is being forwarded to. The relay neither awaits the
 *        answer nor fails the request on it: this is a hint that a model was used, and the
 *        caller may spend it warming a cache whose only consumer is a page. `destination`
 *        is what lets that caller refuse to spend a key somewhere it was never meant for —
 *        a mount can point at any upstream, and the key the client sent belongs to that
 *        one. A throw is logged and otherwise ignored.
 * @param {(level: 'info'|'warn'|'error', message: string, detail?: unknown) => void} [options.log]
 * @param {number} [options.upstreamTimeoutMs=0]
 * @param {string} [options.version]
 * @param {(targetId: string) => unknown} [options.resolveTarget]
 *        Resolves a `/t/<targetId>/...` mount to `{ upstream, tier }`, or `null`
 *        when the id is unknown. The relay never inspects the result beyond those
 *        fields, so all target knowledge stays with the caller.
 * @param {(session: string, model: string|null) => unknown} [options.resolveSessionRecipe]
 *        Resolves the Session advertised on a request (see {@link sessionKeyOf}) —
 *        and the model it named — to the routing recipe it should run on:
 *        `{ preset, serviceTier, sort, variant, precision, quantizations }`, or a bare
 *        tier string from a tier-era caller. Only consulted when the mount itself pins
 *        no tier, so an explicit path still wins; a rejected promise leaves the body
 *        untouched rather than failing the request. The model is passed because a
 *        precision floor has to be admitted per model, and the relay is the only place
 *        that knows which model the request asked for.
 */
/**
 * The relay-owned model variants. These are the only suffixes this proxy adds, and
 * the only ones it strips back off — a caller's own `:online`/`:thinking` survives.
 */
const RELAY_VARIANTS = Object.freeze(['floor', 'nitro'])

/**
 * A model id with a relay-owned variant removed (`deepseek/x:floor` → `deepseek/x`).
 * @param {string} model
 * @returns {string}
 */
export function baseModelId(model) {
  const text = model.trim()
  const cut = text.lastIndexOf(':')
  if (cut <= 0) return text
  const suffix = text.slice(cut + 1).trim().toLowerCase()
  return RELAY_VARIANTS.includes(suffix) ? text.slice(0, cut) : text
}

/**
 * The `provider.quantizations` include list a recipe may carry, or null.
 *
 * Lowercased and de-duplicated because it is written straight into the JSON body and
 * compared against what a caller already put there. Which levels are real is *not*
 * decided here — the relay has no vocabulary of precisions, and a floor that reached
 * it has already been admitted by the Host, so this only has to be a clean list of
 * tokens or nothing at all.
 *
 * An array that yields no usable entry is `null`, the same as a non-array: an empty
 * include list would mean "no endpoint is eligible", which is never what a relay
 * wants to send.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizeQuantizations(value) {
  if (!Array.isArray(value)) return null
  /** @type {string[]} */
  const levels = []
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    if (text !== '' && !levels.includes(text)) levels.push(text)
  }
  return levels.length === 0 ? null : levels
}

/**
 * Coerce whatever a Session resolver answered into the recipe this relay applies.
 *
 * A bare string is a tier name (the tier-era contract) and means "send exactly this".
 * An object carries the four independent levers — `serviceTier` (pool eligibility,
 * lane precedence and billing rate), `sort` (the comparator over the pool), `variant`
 * (`:floor`/`:nitro`, which admit a tier *and* sort) and the precision floor's
 * `quantizations` include list — so one preset can never be mistaken for a combination
 * of the others. `preset` and `precision` are carried for logs and the two response
 * headers; `precision` is the floor that was *configured* while `quantizations` is the
 * list that was actually *admitted*, and keeping them apart is what lets the response
 * say "bypassed" instead of pretending nothing was asked for.
 *
 * `pin` is a fifth lever that *subsumes* the other four rather than combining with them.
 * An upstream endpoint slug (`relace/fp4`) names one ISO provider, and the endpoint it
 * names already has a tier and a precision — so a pin in force makes the tier, the
 * comparator, the floor and the variant not just redundant but contradictory. `pin` is
 * therefore the slug that was *admitted* (it survived the Host's check that the model
 * still lists it) and `pinChosen` the one that was *configured*; the same split as
 * `quantizations`/`precision`, for the same reason, so a withheld pin can be reported
 * instead of looking like nobody asked.
 *
 * @param {unknown} value
 * @returns {{
 *   preset: string|null, serviceTier: string|null, sort: string|null, variant: string|null,
 *   precision: string|null, quantizations: string[]|null,
 *   pin: string|null, pinChosen: string|null,
 * } | null}
 */
export function normalizeRecipe(value) {
  if (typeof value === 'string') {
    const tier = value.trim().toLowerCase()
    return tier === ''
      ? null
      : {
          preset: tier, serviceTier: tier, sort: null, variant: null,
          precision: null, quantizations: null, pin: null, pinChosen: null,
        }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const text = (/** @type {unknown} */ field) =>
    typeof field === 'string' && field.trim() !== '' ? field.trim().toLowerCase() : null
  /**
   * A provider slug is matched against the upstream's own `tag` values, so it is trimmed
   * but *not* lowercased: every tag OpenRouter reports is already lowercase, and
   * rewriting the case of one that ever is not would send a slug that does not exist.
   */
  const slug = (/** @type {unknown} */ field) =>
    typeof field === 'string' && field.trim() !== '' ? field.trim() : null
  const preset = text(value.preset)
  const serviceTier = text(value.serviceTier)
  const sort = text(value.sort)
  const variant = text(value.variant)
  const precision = text(value.precision)
  const quantizations = normalizeQuantizations(value.quantizations)
  const pin = slug(value.pin)
  const pinChosen = slug(value.pinChosen)
  if (
    preset === null &&
    serviceTier === null &&
    sort === null &&
    variant === null &&
    precision === null &&
    quantizations === null &&
    pin === null &&
    pinChosen === null
  ) {
    return null
  }
  return { preset, serviceTier, sort, variant, precision, quantizations, pin, pinChosen }
}

/**
 * The upstream endpoint slug a recipe pins to, or null.
 *
 * Read defensively rather than as `recipe.pin !== null`: an older caller, a hand-built
 * recipe in a test, or the tier-era bare-string form can all reach the relay without the
 * field at all, and `undefined !== null` would turn "no pin" into a pin of nothing.
 *
 * @param {ReturnType<typeof normalizeRecipe>} recipe
 * @returns {string | null}
 */
function pinOf(recipe) {
  if (recipe === null || recipe === undefined) return null
  const value = /** @type {{ pin?: unknown }} */ (recipe).pin
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The request's `provider` object, without creating one.
 *
 * A body that omitted `provider` must not gain an empty one: this relay re-serialises
 * only when it changed something, and an empty block would be a change with no meaning.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown> | null}
 */
function providerObjectOf(body) {
  const value = body.provider
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/**
 * Whether the body's `only` list is already exactly this one slug.
 *
 * Positional and case-sensitive because a provider slug is an identity, not a level: the
 * comparison exists only so an unchanged body is not re-serialised on every request.
 *
 * @param {unknown} current
 * @param {string} tag
 * @returns {boolean}
 */
function sameOnly(current, tag) {
  return Array.isArray(current) && current.length === 1 && current[0] === tag
}

/**
 * Write a hard pin: this one endpoint, and no fallback away from it.
 *
 * `only` + `allow_fallbacks: false` is the pair OpenRouter documents for "use this
 * endpoint directly" — the allowlist is what makes the slug a *choice* rather than a
 * preference, and `allow_fallbacks: false` is what stops the router from quietly serving
 * a different provider when the chosen one is unavailable. Without the second field a pin
 * would look like it worked, which is the one failure mode worth spending a field on.
 *
 * The conflicting levers are then *removed*, not left to fight the pin:
 *
 * - `quantizations` is an include list, so a floor of `fp8` beside a pinned `fp4`
 *   endpoint would exclude the endpoint that was explicitly asked for — a 404, not a
 *   degrade.
 * - `ignore` cannot change where a one-element allowlist routes except by excluding the
 *   pinned slug itself, which is the same failure. It is redundant under a pin, so it
 *   goes.
 * - `service_tier` names a pool, and the pinned endpoint is already in one. Sending both
 *   asks the router to resolve a contradiction it may answer with an error.
 * - A `:floor`/`:nitro` model variant routes *across* a pool, which is the opposite of
 *   pinning one endpoint. The base id is what a pin can be combined with.
 *
 * `sort`, `order` and the parameter filters are left exactly as the caller sent them:
 * over a one-element allowlist they are inert, and this relay does not police fields it
 * did not write.
 *
 * @param {Record<string, unknown>} body
 * @param {string} tag
 * @returns {boolean} whether the body changed and must be re-serialised
 */
function applyPin(body, tag) {
  let changed = false
  const provider = providerObjectOf(body) ?? {}

  if (!sameOnly(provider.only, tag)) {
    provider.only = [tag]
    body.provider = provider
    changed = true
  }
  if (provider.allow_fallbacks !== false) {
    provider.allow_fallbacks = false
    body.provider = provider
    changed = true
  }
  for (const key of ['quantizations', 'ignore']) {
    if (Object.hasOwn(provider, key)) {
      delete provider[key]
      changed = true
    }
  }
  if (Object.hasOwn(body, 'service_tier')) {
    delete body.service_tier
    changed = true
  }
  if (typeof body.model === 'string') {
    const base = baseModelId(body.model)
    if (body.model !== base) {
      body.model = base
      changed = true
    }
  }
  return changed
}

/**
 * Apply one recipe to a parsed request body.
 *
 * The relay owns exactly four things — `service_tier`, the `provider.sort`
 * comparator, the `provider.quantizations` include list, and the tier variants — and
 * leaves every other field as the caller sent it. `provider` is merged, never
 * replaced, so `only`/`order`/`allow_fallbacks` survive a preset switch. Both
 * `service_tier: null` and `quantizations: null` mean "send none", which is what makes
 * the pass-through preset honest: it strips a tier or a filter the client pinned
 * itself, because a floor this relay did not admit must not ride a request it is
 * accountable for.
 *
 * A recipe with a `quantizations` list is only ever built after the Host confirmed the
 * model still has an endpoint in it; this function simply writes it down.
 *
 * A recipe with a `pin` is a different shape of answer, not a fifth lever beside the
 * others: {@link applyPin} replaces all four of them at once.
 *
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof normalizeRecipe>} recipe
 * @returns {boolean} whether the body changed and must be re-serialised
 */
export function applyRecipe(body, recipe) {
  if (recipe === null) return false

  /* A pin subsumes the other four levers, so it is applied alone and returns before the
     preset branches below can put back a tier or a filter that would contradict it. The
     endpoint a slug names already *is* a tier and a precision — that is the whole reason
     the picker can disable those cells — so sending `service_tier` beside `only` is at
     best redundant and at worst an error upstream. */
  const pin = pinOf(recipe)
  if (pin !== null) return applyPin(body, pin)

  let changed = false

  if (recipe.serviceTier === null) {
    if (Object.hasOwn(body, 'service_tier')) {
      delete body.service_tier
      changed = true
    }
  } else if (body.service_tier !== recipe.serviceTier) {
    body.service_tier = recipe.serviceTier
    changed = true
  }

  if (recipe.sort !== null) {
    const provider = body.provider !== null && typeof body.provider === 'object' && !Array.isArray(body.provider)
      ? /** @type {Record<string, unknown>} */ (body.provider)
      : {}
    if (provider.sort !== recipe.sort) {
      provider.sort = recipe.sort
      body.provider = provider
      changed = true
    }
  }

  if (recipe.quantizations !== null) {
    const provider = body.provider !== null && typeof body.provider === 'object' && !Array.isArray(body.provider)
      ? /** @type {Record<string, unknown>} */ (body.provider)
      : {}
    if (!sameLevels(provider.quantizations, recipe.quantizations)) {
      provider.quantizations = [...recipe.quantizations]
      body.provider = provider
      changed = true
    }
  } else if (body.provider !== null && typeof body.provider === 'object' && !Array.isArray(body.provider)) {
    // Never create a `provider` object just to strip from it: with no floor there may
    // be no provider block at all, and adding an empty one would change a body this
    // relay was asked to pass through.
    const provider = /** @type {Record<string, unknown>} */ (body.provider)
    if (Object.hasOwn(provider, 'quantizations')) {
      delete provider.quantizations
      changed = true
    }
  }

  if (typeof body.model === 'string') {
    const base = baseModelId(body.model)
    if (recipe.variant !== null) {
      const wanted = `${base}:${recipe.variant}`
      if (body.model !== wanted) {
        body.model = wanted
        changed = true
      }
    } else if (body.model !== base) {
      // Drop a relay-owned variant a previous preset left on the id.
      body.model = base
      changed = true
    }
  }

  return changed
}

/**
 * Whether the body already carries exactly the include list this recipe wants.
 *
 * Compared case-insensitively and positionally: a caller that wrote `["FP8"]` would
 * otherwise be rewritten on every request (and re-serialised, which is the one thing
 * this relay promises not to do for an unchanged body).
 *
 * @param {unknown} current
 * @param {readonly string[]} wanted
 * @returns {boolean}
 */
function sameLevels(current, wanted) {
  if (!Array.isArray(current) || current.length !== wanted.length) return false
  for (let index = 0; index < wanted.length; index += 1) {
    const value = current[index]
    if (typeof value !== 'string' || value.trim().toLowerCase() !== wanted[index]) return false
  }
  return true
}

/**
 * The `x-oorp-precision` value for one request: which floor was *enforced*.
 *
 * `bypass` is the interesting answer, and the reason this cannot be derived from the
 * body: a floor was configured but no include list went out — the endpoint listing had
 * not been read yet, or nothing in it survived. Reporting `any` there would hide
 * exactly the case an operator is troubleshooting, and reporting the floor id would
 * claim a filter that was never sent.
 *
 * A pin is the one case that is deliberately *not* a bypass. The pin subsumes the floor,
 * so a configured floor is not withheld by mistake — it is not in play. Saying `any`
 * there is literally true (no include list rode the request) and `x-oorp-pin` names the
 * reason; saying `bypass` would report a healthy pin as a broken floor.
 *
 * Follows the `x-oorp-tier` rule that the header is always present rather than
 * conditional: an older Host's page can then read one key without checking for it.
 *
 * @param {ReturnType<typeof normalizeRecipe>} recipe
 * @returns {string}
 */
function precisionHeaderOf(recipe) {
  if (recipe === null) return 'any'
  if (pinOf(recipe) !== null) return 'any'
  if (recipe.quantizations !== null) return recipe.precision ?? 'any'
  return recipe.precision !== null && recipe.precision !== 'any' ? 'bypass' : 'any'
}

/**
 * The `x-oorp-pin` value for one request: which endpoint was *routed to*, if any.
 *
 * Three answers, and the middle one is why the field exists: the slug actually enforced,
 * `bypass` when a pin was configured but withheld (the listing has not been read yet, or
 * the model no longer lists that endpoint), and `none` when nobody asked. A withheld pin
 * falls back to the Session's own preset rather than failing, so without this header the
 * only symptom would be a request that quietly went somewhere else.
 *
 * @param {ReturnType<typeof normalizeRecipe>} recipe
 * @returns {string}
 */
function pinHeaderOf(recipe) {
  if (recipe === null) return 'none'
  const enforced = pinOf(recipe)
  if (enforced !== null) return enforced
  const chosen = typeof recipe.pinChosen === 'string' ? recipe.pinChosen.trim() : ''
  return chosen !== '' ? 'bypass' : 'none'
}

export function createRelay(options) {
  const host = options.host ?? '127.0.0.1'
  const basePort = Number.isInteger(options.port) ? options.port : 8791
  const portFallback = options.portFallback !== false
  const upstream = String(options.upstream ?? '').replace(/\/+$/, '')
  const routes = options.routes ?? {}
  const control = options.control ?? {}
  const resolveTarget = typeof options.resolveTarget === 'function' ? options.resolveTarget : null
  /**
   * Per-request recipe lookup, keyed by the Session the client advertised. A bare
   * mount asks this on every request, so the routing shape is a runtime choice like
   * `reasoningEffort` instead of a property of the provider row. A longer-lived
   * caller may still answer a bare tier string; {@link normalizeRecipe} accepts both.
   */
  const resolveSessionRecipe =
    typeof options.resolveSessionRecipe === 'function'
      ? options.resolveSessionRecipe
      : typeof options.resolveSessionTier === 'function'
        ? options.resolveSessionTier
        : null
  const onRecord = options.onRecord
  /** A hint that a request named a model, and with which key — never awaited. */
  const onModelSeen = options.onModelSeen
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 0
  /**
   * Whether a request whose response did not name its provider (or its bill) may be
   * reconciled against OpenRouter's generation record. On by default because the
   * Responses API never names a provider at all, which would leave the Requests tab's
   * Provider column permanently empty on such a route.
   */
  const generationLookup = options.generationLookup !== false
  const log = options.log ?? (() => {})
  const version = options.version ?? '0.0.0'

  /** Longest mount first, so a shorter prefix can never shadow a longer one. */
  const mounts = Object.keys(routes).sort((a, b) => b.length - a.length)

  /** @type {{ server: import('node:http').Server, sockets: Set<import('node:net').Socket>, port: number } | undefined} */
  let live

  /** @type {{ host: string, port: number, origin: string } | undefined} */
  let bound

  /**
   * @param {string} pathname
   * @returns {{ prefix: string, tier: string|null, upstreamPath: string } | null}
   */
  function resolveRoute(pathname) {
    for (const prefix of mounts) {
      if (pathname === prefix) {
        return { prefix, tier: routes[prefix] ?? null, upstreamPath: '/' }
      }
      if (pathname.startsWith(prefix + '/')) {
        return { prefix, tier: routes[prefix] ?? null, upstreamPath: pathname.slice(prefix.length) }
      }
    }
    return null
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const pathname = url.pathname

    const handler = control[pathname]
    if (typeof handler === 'function') {
      await handler(req, res)
      return
    }

    // Reserved namespace first: a configured mount must never shadow a target.
    if (pathname.startsWith(TARGET_PREFIX)) {
      await forwardTarget(req, res, pathname, url.search)
      return
    }

    const match = resolveRoute(pathname)
    if (!match) {
      sendError(res, 404, `no mount matches ${pathname}; mounts: ${mounts.join(', ') || '(none)'}`)
      return
    }

    await forward(req, res, {
      url: `${upstream}${match.upstreamPath}${url.search}`,
      tier: match.tier,
      targetId: null,
      upstreamLabel: upstream,
    })
  }

  /**
   * Serve the reserved namespace: `/t/<targetId>/v1/...` forwards to the target's
   * upstream with no tier, and `/t/<targetId>/<tier>/v1/...` pins one.
   *
   * The resolver is the only place target knowledge can come from, and it is
   * allowed to answer asynchronously because the caller's config API is async.
   * Everything below the destination — headers, body, streaming, metrics — is the
   * same path a configured mount takes.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @param {string} search
   */
  async function forwardTarget(req, res, pathname, search) {
    const mount = parseTargetMount(pathname)
    if (!mount) {
      sendError(res, 404, `not a relay target mount: ${pathname} (expected /t/<target>/v1/... or /t/<target>/<tier>/v1/...)`)
      return
    }

    let resolved = resolveTarget ? resolveTarget(mount.targetId) : null
    if (resolved && typeof (/** @type {{ then?: unknown }} */ (resolved)).then === 'function') {
      resolved = await /** @type {Promise<unknown>} */ (resolved)
    }
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      sendError(res, 404, `unknown relay target "${mount.targetId}"; targets are configured by the plugin, not by the relay`)
      return
    }

    const target = /** @type {{ upstream?: unknown }} */ (resolved)
    const base = parseUpstreamBase(target.upstream)
    if (!base) {
      sendError(res, 400, `relay target "${mount.targetId}" has no usable upstream (needs an absolute http(s) URL without credentials)`)
      return
    }
    // The one misconfiguration that would turn the relay into an unbounded
    // request loop instead of a proxy.
    if (pointsAtRelay(base)) {
      sendError(res, 400, `relay target "${mount.targetId}" points back at this relay (${base.origin}); refusing to proxy it to itself`)
      return
    }

    // Only the path can pin a tier, and only when it names one (`/t/<id>/flex/v1`):
    // the legacy pinned mount keeps working for rows that still point at it. The bare
    // mount pins nothing — not even a leftover `tier` in the target table — because
    // the tier is Session state now, and `forward` is where that choice is read.
    await forward(req, res, {
      url: buildTargetUrl(base, mount.upstreamPath, search),
      tier: mount.tier,
      targetId: mount.targetId,
      upstreamLabel: base.origin,
    })
  }

  /**
   * True when a target upstream would send this relay's traffic back into its own
   * listener: the same port on this machine, named either by a loopback address or
   * by the address the listener was told to bind. That is the shape a relay mount
   * always has, and the one misconfiguration that recurses instead of proxying.
   *
   * @param {UpstreamBase} base
   */
  function pointsAtRelay(base) {
    if (!bound) return false
    const port = Number(base.url.port || (base.url.protocol === 'https:' ? 443 : 80))
    if (port !== bound.port) return false
    if (isLoopbackHost(base.url.hostname)) return true
    const boundHost = bound.host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
    if (!boundHost || boundHost === '0.0.0.0' || boundHost === '::') return false
    return base.url.hostname.toLowerCase() === boundHost
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ url: string, tier: string|null, targetId: string|null, upstreamLabel: string }} plan
   */
  async function forward(req, res, plan) {
    const startedAt = Date.now()
    const method = req.method ?? 'GET'
    const sendsBody = method !== 'GET' && method !== 'HEAD'

    let rawBody = Buffer.alloc(0)
    if (sendsBody) {
      try {
        rawBody = await readBody(req)
      } catch (error) {
        sendError(res, 400, `could not read request body: ${errorText(error)}`)
        return
      }
    }

    /**
     * `model` is what the request asked for; `servedModel` is what answered, which a
     * fallback can change. The cost fields stay null unless the response reported them:
     * a missing amount is a fact, and zero would be a lie.
     *
     * @type {{
     *   tier: string|null, preset: string|null, session: boolean, sessionId: string|null,
     *   model: string|null, servedModel: string|null, servedTier: string|null, providerName: string|null,
     *   streaming: boolean, status: number, ms: number, bytes: number,
     *   promptTokens: number|null, completionTokens: number|null,
     *   cacheReadTokens: number|null, cacheWriteTokens: number|null, reasoningTokens: number|null,
     *   costUsd: number|null, upstreamCostUsd: number|null,
     *   upstreamPromptCostUsd: number|null, upstreamCompletionCostUsd: number|null,
     *   serverToolCostUsd: number|null, byok: boolean, genId: string|null, at: number,
     * }}
     */
    const record = {
      tier: plan.tier,
      preset: null,
      session: false,
      sessionId: null,
      model: null,
      servedModel: null,
      servedTier: null,
      streaming: false,
      status: 0,
      ms: 0,
      bytes: 0,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
      upstreamCostUsd: null,
      upstreamPromptCostUsd: null,
      upstreamCompletionCostUsd: null,
      serverToolCostUsd: null,
      byok: false,
      providerName: null,
      genId: null,
      at: Date.now(),
    }

    /** @type {Buffer} */
    let forwardedBody = rawBody

    // ---- recipe resolution --------------------------------------------------
    // An explicit mount (`/t/<id>/flex/v1`) still names a tier outright. A bare
    // mount decided only *that* a preset may be chosen, so the Session carrying the
    // request decides now — the same way `reasoningEffort` rides the selection
    // instead of the provider row.
    /** @type {ReturnType<typeof normalizeRecipe>} */
    let recipe = plan.tier === null
      ? null
      : { preset: null, serviceTier: plan.tier, sort: null, variant: null, precision: null, quantizations: null }

    // ---- recipe injection ---------------------------------------------------
    if (sendsBody && rawBody.length > 0) {
      const parsed = tryJson(rawBody)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const session = sessionKeyOf(req.headers, parsed)
        record.session = session !== ''
        // The id itself, not just its presence: the usage card needs to answer "what did
        // this Session cost" and the Session is the only handle the Host and the page share.
        if (record.session) record.sessionId = session
        if (recipe === null && record.session && resolveSessionRecipe !== null) {
          try {
            // The model goes along because a precision floor is admitted per model:
            // the Host has to know which id to look up before it can decide whether an
            // include list is safe to send. A request that named none passes null.
            const requested = typeof parsed.model === 'string' ? parsed.model : null
            recipe = normalizeRecipe(await resolveSessionRecipe(session, requested))
          } catch {
            // A lookup that fails must not fail the request: the body simply goes out
            // exactly as the client wrote it, which is what this relay did before
            // Sessions could choose.
          }
        }
        if (applyRecipe(parsed, recipe)) {
          forwardedBody = Buffer.from(JSON.stringify(parsed), 'utf8')
        }
        // The model id is read after the recipe applies, so a variant preset logs the
        // id that actually went upstream.
        if (typeof parsed.model === 'string') {
          record.model = parsed.model
          // Told after `record.model` is assigned so the hint and the usage entry name the
          // same id, and never awaited: this is a hint about what a page may ask for later,
          // not part of answering the request.
          noteModelSeen(parsed.model, req.headers.authorization ?? null, plan.url)
        }
      }
    }
    record.tier = recipe === null ? null : recipe.serviceTier
    record.preset = recipe === null ? null : recipe.preset

    // ---- upstream request ---------------------------------------------------
    /** @type {Record<string, string>} */
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase()
      if (value === undefined) continue
      if (key === 'host' || key === 'accept-encoding' || key === 'content-length') continue
      if (HOP_BY_HOP.has(key)) continue
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    // Identity on purpose: the relay must never touch response bytes, so it must
    // never receive a compressed body it would have to decode.
    headers['accept-encoding'] = 'identity'

    const controller = new AbortController()
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    if (upstreamTimeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error(`upstream timed out after ${upstreamTimeoutMs}ms`)), upstreamTimeoutMs)
      timer.unref?.()
    }
    // A browser or agent that walks away cancels the upstream request too.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client closed the connection'))
    })

    const target = plan.url

    /** @type {Response} */
    let upstreamResponse
    try {
      upstreamResponse = await fetch(target, {
        method,
        headers,
        body: sendsBody && forwardedBody.length > 0 ? forwardedBody : undefined,
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch (error) {
      if (timer) clearTimeout(timer)
      record.status = 502
      record.ms = Date.now() - startedAt
      report(record)
      sendError(res, 502, `upstream unreachable (${plan.upstreamLabel}): ${errorText(error)}`)
      return
    }
    if (timer) clearTimeout(timer)

    record.status = upstreamResponse.status

    // ---- response passthrough ----------------------------------------------
    const outHeaders = {}
    for (const [name, value] of upstreamResponse.headers) {
      const key = name.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      if (key === 'content-encoding') continue
      outHeaders[key] = value
    }
    if (upstreamResponse.headers.has('content-encoding')) {
      // fetch already decoded it; the original length no longer describes the bytes.
      delete outHeaders['content-length']
    }
    outHeaders['x-oorp-tier'] = (recipe === null ? null : recipe.serviceTier ?? recipe.sort ?? recipe.variant) ?? 'passthrough'
    // Which floor actually took effect: the id when the include list went out, `bypass`
    // when a floor was asked for but withheld, `any` when no floor applied.
    outHeaders['x-oorp-precision'] = precisionHeaderOf(recipe)
    // Which endpoint actually got the request: the slug, `bypass` when a pin was withheld,
    // `none` when nobody pinned anything.
    outHeaders['x-oorp-pin'] = pinHeaderOf(recipe)
    if (recipe !== null && recipe.preset !== null) outHeaders['x-oorp-preset'] = recipe.preset
    outHeaders['x-oorp-upstream'] = plan.upstreamLabel
    if (plan.targetId) outHeaders['x-oorp-target'] = plan.targetId

    const contentType = upstreamResponse.headers.get('content-type') ?? ''
    record.streaming = contentType.includes('text/event-stream')

    try {
      res.writeHead(upstreamResponse.status, outHeaders)
    } catch (error) {
      sendError(res, 502, `could not write response head: ${errorText(error)}`)
      report({ ...record, ms: Date.now() - startedAt })
      return
    }

    if (!upstreamResponse.body || method === 'HEAD') {
      res.end()
      record.ms = Date.now() - startedAt
      if (generationLookup) await enrichFromGeneration(record, lookupContext(req))
      report(record)
      return
    }

    const sniffer = createUsageSniffer()
    try {
      await pipeline(Readable.fromWeb(upstreamResponse.body), sniffer.stream, res)
    } catch {
      // Aborted or broken pipe: the status is already on the wire. Nothing to do
      // beyond recording what happened.
    }

    record.ms = Date.now() - startedAt
    record.bytes = sniffer.bytes
    record.promptTokens = sniffer.usage.promptTokens
    record.completionTokens = sniffer.usage.completionTokens
    record.cacheReadTokens = sniffer.usage.cacheReadTokens
    record.cacheWriteTokens = sniffer.usage.cacheWriteTokens
    record.reasoningTokens = sniffer.usage.reasoningTokens
    record.costUsd = sniffer.usage.costUsd
    record.upstreamCostUsd = sniffer.usage.upstreamCostUsd
    record.upstreamPromptCostUsd = sniffer.usage.upstreamPromptCostUsd
    record.upstreamCompletionCostUsd = sniffer.usage.upstreamCompletionCostUsd
    record.serverToolCostUsd = sniffer.usage.serverToolCostUsd
    record.byok = sniffer.usage.byok
    record.servedTier = sniffer.usage.servedTier
    record.servedModel = sniffer.usage.servedModel
    /* OpenRouter puts two facts on the response headers rather than in the body, and
     * advertises them via `access-control-expose-headers: X-Generation-Id,X-Provider-Name`.
     * The body only sometimes repeats them — a Chat Completions chunk carries `provider`,
     * a Responses event carries neither — so the header is the only per-request source for
     * "who actually served this" and "which generation do I ask about". Reading them here
     * is what makes the Requests tab answerable for `api: openai-responses` routes. */
    record.providerName = sniffer.usage.providerName ?? headerOf(upstreamResponse, 'x-provider-name')
    record.genId = sniffer.usage.genId ?? headerOf(upstreamResponse, 'x-generation-id')
    if (generationLookup) await enrichFromGeneration(record, lookupContext(req))
    report(record)
  }

  /**
   * What {@link enrichFromGeneration} needs, taken from the request being answered.
   *
   * The caller's `Authorization` is read here and used for exactly one follow-up call; it
   * is never written anywhere, which keeps the "forwards the caller's key, stores none"
   * promise intact.
   *
   * @param {import('node:http').IncomingMessage} req
   */
  function lookupContext(req) {
    return {
      upstream,
      authorization: req.headers.authorization,
      fetchImpl: globalThis.fetch,
      timeoutMs: 2500,
    }
  }

  /** @param {object} entry */
  function report(entry) {
    if (typeof onRecord !== 'function') return
    try {
      onRecord(entry)
    } catch (error) {
      log('warn', 'metrics sink threw', errorText(error))
    }
  }

  /**
   * Tell the caller which model a request named, and with which key.
   *
   * Same rule as {@link report}, one report earlier: never awaited and never allowed to
   * fail the request. When it answers a promise that promise is drained here too, because
   * an unhandled rejection from a display read is a process-level event this relay's
   * request had no part in.
   *
   * @param {string} model
   * @param {string | null} authorization
   * @param {string} destination  the absolute URL this request is forwarded to
   */
  function noteModelSeen(model, authorization, destination) {
    if (typeof onModelSeen !== 'function') return
    try {
      const answer = onModelSeen(model, authorization, destination)
      if (typeof (/** @type {{ then?: unknown }} */ (answer))?.then === 'function') {
        /** @type {Promise<unknown>} */ (answer).catch((error) => {
          log('warn', 'model-seen sink threw', errorText(error))
        })
      }
    } catch (error) {
      log('warn', 'model-seen sink threw', errorText(error))
    }
  }

  /**
   * In-flight bind, so `stop()` during a start cannot leave a listener behind.
   * @type {Promise<{host: string, port: number, origin: string}>|undefined}
   */
  let starting

  /** Bind the listener, falling forward over busy ports when allowed. */
  async function start() {
    if (live) return bound ?? { host, port: basePort, origin: originOf(host, basePort) }
    if (starting !== undefined) return starting
    starting = bind().finally(() => {
      starting = undefined
    })
    return starting
  }

  /** @returns {Promise<{host: string, port: number, origin: string}>} */
  async function bind() {
    const attempts = portFallback ? 21 : 1
    /** @type {NodeJS.ErrnoException | undefined} */
    let lastError

    for (let offset = 0; offset < attempts; offset += 1) {
      const port = basePort + offset
      if (port > 65535) break
      const created = createServer()
      try {
        await listen(created.server, port, host)
        // `listen(0)` is how the tests get an isolated listener: trust the socket
        // rather than the requested port.
        const assigned = created.server.address()
        const actualPort = assigned && typeof assigned === 'object' ? assigned.port : port
        live = { server: created.server, sockets: created.sockets, port: actualPort }
        bound = { host, port: actualPort, origin: originOf(host, actualPort) }
        return bound
      } catch (error) {
        destroy(created.server, created.sockets)
        const code = /** @type {NodeJS.ErrnoException} */ (error).code
        if (code !== 'EADDRINUSE' || offset === attempts - 1) {
          lastError = /** @type {NodeJS.ErrnoException} */ (error)
          if (code !== 'EADDRINUSE') break
        }
      }
    }

    throw lastError ?? new Error(`could not bind ${host}:${basePort}`)
  }

  function createServer() {
    const server = http.createServer((req, res) => {
      void handle(req, res).catch((error) => {
        log('error', 'unhandled relay error', errorText(error))
        sendError(res, 500, errorText(error))
      })
    })

    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        // the socket was already gone
      }
    })

    // Long completions are the normal case; never time a response out.
    server.requestTimeout = 0
    server.headersTimeout = 60_000
    server.keepAliveTimeout = 65_000

    return { server, sockets }
  }

  async function stop() {
    // A reload can dispose while the first bind is still in flight; letting that
    // start finish first is what keeps the listener from outliving its plugin.
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // the start failed on its own; there is nothing bound to close
      }
    }
    const current = live
    if (!current) {
      bound = undefined
      return
    }
    live = undefined
    bound = undefined
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve(undefined)
      }
      try {
        current.server.close(done)
      } catch {
        done()
      }
      // Keep-alive sockets would otherwise hold the listener open indefinitely.
      for (const socket of current.sockets) {
        try {
          socket.destroy()
        } catch {
          // already closed
        }
      }
      setTimeout(done, 1_000).unref?.()
    })
  }

  return {
    start,
    stop,
    address: () => bound,
    resolveRoute,
    routes,
    version,
  }

}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(undefined)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Tear down a server that never started listening.
 *
 * @param {import('node:http').Server} server
 * @param {Set<import('node:net').Socket>} sockets
 */
function destroy(server, sockets) {
  try {
    server.close()
  } catch {
    // never listened
  }
  for (const socket of sockets) {
    try {
      socket.destroy()
    } catch {
      // already closed
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
}

/**
 * Usage sniffing that never alters the stream: every chunk is passed through
 * untouched, and only a bounded tail copy is inspected once the stream ends.
 */
/**
 * One response header as a non-empty string, or null.
 *
 * @param {Response} response
 * @param {string} name
 * @returns {string | null}
 */
function headerOf(response, name) {
  try {
    const value = response.headers.get(name)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * How many generation lookups may be in flight at once.
 *
 * The lookup exists because some facts are not in the response at all (see
 * {@link enrichFromGeneration}), so it runs on the request path's tail rather than behind
 * a user action. A cap keeps a burst of completions from turning into a burst of
 * authenticated GETs against the same account.
 */
const GENERATION_LOOKUP_LIMIT = 8

/**
 * How long a generation record may take to become readable, in retry delays.
 *
 * The record is eventually consistent — measured on this account, `GET /generation`
 * answers 404 for roughly the first five seconds after a completion and 200 from about
 * seven. A single attempt would therefore miss almost every request, which is how a
 * lookup that works from `curl` a minute later can still fill nothing in practice. The
 * delays are cumulative, so the last attempt lands around eight seconds after the stream
 * ended; the whole thing runs after the response has been sent, so nobody waits on it.
 */
const GENERATION_LOOKUP_RETRY_MS = Object.freeze([0, 1200, 2600, 4200, 6000])

/** In-flight generation lookups, process-wide. */
let generationLookupsInFlight = 0

/**
 * Fill in what the response did not report, from OpenRouter's own generation record.
 *
 * Two facts are not in a Responses-API body: the provider that served the request, and —
 * when a stream is cut short or its final event is too large for the sniffer's tail —
 * anything at all. The model page's Providers tab and the Requests tab both need the
 * first, and the second is the difference between a billed row and "not reported".
 *
 * `GET <upstream>/generation?id=<genId>` answers both authoritatively, and the relay
 * already holds everything it needs to ask: the generation id (body or `X-Generation-Id`
 * header) and the caller's own `Authorization`, forwarded verbatim and never stored.
 *
 * Only *missing* fields are filled. The stream is the better source for anything it did
 * report — it is the number the caller can see — so a backfilled value never overwrites
 * one. Every failure is silent: a lookup that 404s, times out or is rate-limited leaves
 * the record exactly as the stream left it.
 *
 * @param {Record<string, any>} record
 * @param {{ upstream: string, authorization: string|undefined, fetchImpl: typeof globalThis.fetch, timeoutMs: number }} context
 * @returns {Promise<void>}
 */
async function enrichFromGeneration(record, context) {
  if (typeof record.genId !== 'string' || record.genId === '') return
  // Nothing to learn: the stream already answered both questions this lookup exists for.
  if (record.providerName !== null && record.costUsd !== null) return
  const authorization = typeof context.authorization === 'string' ? context.authorization.trim() : ''
  if (authorization === '') return
  if (generationLookupsInFlight >= GENERATION_LOOKUP_LIMIT) return

  const base = String(context.upstream ?? '').replace(/\/+$/, '')
  if (base === '') return
  const url = `${base}/generation?id=${encodeURIComponent(record.genId)}`
  generationLookupsInFlight += 1
  try {
    for (const delay of GENERATION_LOOKUP_RETRY_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const data = await readGeneration(context, url, authorization)
      if (data === null) continue
      const fill = (key, value) => {
        if (record[key] === null || record[key] === undefined) record[key] = value
      }
      fill('providerName', firstString(data.provider_name))
      fill('costUsd', firstMoney(data.total_cost))
      fill('upstreamCostUsd', firstMoney(data.upstream_inference_cost))
      // `native_*` is what the caller was billed for; `tokens_*` is the provider's own
      // count after its own cache accounting, and it is smaller. The stream reports the
      // native figure, so the backfill matches it rather than mixing the two.
      fill('promptTokens', firstCount(data.native_tokens_prompt))
      fill('completionTokens', firstCount(data.native_tokens_completion))
      fill('reasoningTokens', firstCount(data.native_tokens_reasoning))
      fill('cacheReadTokens', firstCount(data.native_tokens_cached))
      fill('servedModel', firstString(data.model))
      fill('servedTier', firstString(data.service_tier))
      return
    }
  } catch {
    /* A lookup is an enrichment, never a requirement. */
  } finally {
    generationLookupsInFlight -= 1
  }
}

/**
 * One attempt at the generation record. `null` means "not readable yet, or never".
 *
 * @param {{ fetchImpl: typeof globalThis.fetch, timeoutMs: number }} context
 * @param {string} url
 * @param {string} authorization
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readGeneration(context, url, authorization) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), context.timeoutMs)
  try {
    const response = await context.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization },
      signal: controller === null ? undefined : controller.signal,
    })
    if (!response.ok) return null
    const payload = await response.json()
    const data = payload !== null && typeof payload === 'object' ? payload.data ?? payload : null
    return data !== null && typeof data === 'object' ? /** @type {Record<string, unknown>} */ (data) : null
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function createUsageSniffer() {
  let tail = ''
  let head = ''
  let bytes = 0
  const usage = emptyUsage()

  /** @type {Transform} */
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        bytes += chunk.length
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-SNIFF_TAIL_BYTES)
        // The generation id is stamped on the first chunk, and a long stream pushes it
        // far out of the tail. Keeping a small head copy is what still lets an aborted
        // stream be looked up later by id.
        if (head.length < SNIFF_HEAD_BYTES) head = (head + text).slice(0, SNIFF_HEAD_BYTES)
      } catch {
        // sniffing is best-effort; a decode failure must not break the response
      }
      callback(null, chunk)
    },
    flush(callback) {
      try {
        Object.assign(usage, findUsage(tail))
        if (usage.genId === null) usage.genId = findGenerationId(head) ?? findGenerationId(tail)
      } catch {
        // ignore
      }
      callback()
    },
  })

  return {
    stream,
    get bytes() {
      return bytes
    },
    usage,
  }
}

/**
 * Find the last billed `usage` object in a response head or tail, handling both a plain
 * JSON body and an SSE transcript.
 *
 * The fields beyond token counts are the point of this function: OpenRouter reports the
 * credit amount it actually charged (`usage.cost`), the upstream breakdown, BYOK, and the
 * service tier that served the request. Billing follows the endpoint that won, so those
 * numbers cannot be derived from the token counts afterwards.
 *
 * @param {string} text
 * @returns {ReturnType<typeof emptyUsage>}
 */
export function findUsage(text) {
  if (!text) return emptyUsage()

  const candidates = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'data: [DONE]') continue
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!payload.startsWith('{')) continue
    const parsed = tryJson(Buffer.from(payload, 'utf8'))
    if (parsed && typeof parsed === 'object') candidates.push(parsed)
  }
  // A JSON body may also arrive as a single line too long to be one SSE payload;
  // fall back to locating the key directly.
  if (candidates.length === 0) {
    const anchored = lastObjectAfterKey(text, 'usage')
    if (anchored) candidates.push(anchored)
  }

  // Newest first, but keep one envelope of identity in reserve: the final chunk of an
  // aborted stream can carry the generation id without a usage block.
  let envelope = null
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const found = normalizeUsage(candidates[index])
    if (found.promptTokens !== null || found.completionTokens !== null || found.costUsd !== null) {
      if (found.genId === null && envelope !== null) {
        found.genId = envelope.genId
        found.servedModel = found.servedModel ?? envelope.servedModel
        found.servedTier = found.servedTier ?? envelope.servedTier
        found.providerName = found.providerName ?? envelope.providerName
      }
      return found
    }
    if (envelope === null && (found.genId !== null || found.servedModel !== null || found.servedTier !== null)) {
      envelope = found
    }
  }
  return envelope ?? emptyUsage()
}

/**
 * The generation id of a response, from its head or tail. Used as the fallback when a
 * stream ended without a usage block (caller abort), so the cost can be asked for later.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function findGenerationId(text) {
  if (!text) return null
  const match = /"id"\s*:\s*"(gen-[A-Za-z0-9-]+)"/.exec(text)
  return match ? match[1] : null
}

/**
 * @param {unknown} value
 * @returns {ReturnType<typeof emptyUsage>}
 */
function normalizeUsage(value) {
  const result = emptyUsage()
  if (!value || typeof value !== 'object') return result
  const envelope = /** @type {Record<string, unknown>} */ (value)

  /* Two wire shapes reach this function, and the difference is where the facts live.
   *
   * Chat Completions puts them at the top level of the chunk: `id`, `model`, `provider`,
   * `service_tier` and `usage` are siblings, and the final chunk carries the bill.
   *
   * The Responses API wraps each event in an envelope — `{ type: 'response.completed',
   * response: { … } }` — so `usage` is at `response.usage`, and reading `envelope.usage`
   * finds nothing. That is not a cosmetic difference: a route configured with
   * `api: openai-responses` would report every request as "cost not reported" while
   * the bill sat one level down. `inner` is whichever object actually holds the facts. */
  const response = asObject(envelope.response)
  const inner = response ?? envelope
  const usage = asObject(inner.usage) ?? asObject(envelope.usage)
  const source = usage ?? {}
  result.promptTokens = firstCount(source.prompt_tokens, source.promptTokens, source.input_tokens)
  result.completionTokens = firstCount(source.completion_tokens, source.completionTokens, source.output_tokens)
  // Chat spells them `prompt_tokens_details`, Responses `input_tokens_details`; the
  // numbers inside mean the same things.
  const promptDetails = asObject(source.prompt_tokens_details) ?? asObject(source.input_tokens_details) ?? {}
  result.cacheReadTokens = firstCount(promptDetails.cached_tokens, promptDetails.cache_read_tokens)
  result.cacheWriteTokens = firstCount(promptDetails.cache_write_tokens)
  const completionDetails =
    asObject(source.completion_tokens_details) ?? asObject(source.output_tokens_details) ?? {}
  result.reasoningTokens = firstCount(completionDetails.reasoning_tokens)
  // Cost is in credits (USD). Zero is a real answer for a free endpoint, so it is kept
  // as 0 instead of collapsing into "not reported".
  result.costUsd = firstMoney(source.cost)
  const details = asObject(source.cost_details) ?? {}
  result.upstreamCostUsd = firstMoney(details.upstream_inference_cost)
  result.upstreamPromptCostUsd = firstMoney(
    details.upstream_inference_prompt_cost,
    details.upstream_inference_input_cost,
  )
  result.upstreamCompletionCostUsd = firstMoney(
    details.upstream_inference_completions_cost,
    details.upstream_inference_output_cost,
  )
  result.serverToolCostUsd = firstMoney(details.server_tool_cost)
  result.byok = source.is_byok === true
  // Chat Completions puts the served tier at the top level; the Messages API puts it in
  // `usage`, and the Responses envelope puts it beside its own `usage`, so all three are
  // read — deepest object first, then outward.
  result.servedTier =
    firstString(inner.service_tier) ?? firstString(envelope.service_tier) ?? firstString(source.service_tier)
  result.servedModel = firstString(inner.model) ?? firstString(envelope.model)
  // The upstream that actually answered. The chat body carries it; the Responses body
  // does not carry it anywhere, which is why the relay also reads `X-Provider-Name`.
  result.providerName = firstString(inner.provider) ?? firstString(envelope.provider)
  const id = firstString(inner.id) ?? firstString(envelope.id)
  result.genId = id !== null && id.startsWith('gen-') ? id : null
  return result
}

/**
 * The one shape every reader of this file agrees on. Null means "the provider did not
 * report it", which is different from a zero.
 */
function emptyUsage() {
  return {
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    upstreamCostUsd: null,
    upstreamPromptCostUsd: null,
    upstreamCompletionCostUsd: null,
    serverToolCostUsd: null,
    byok: false,
    servedTier: null,
    servedModel: null,
    providerName: null,
    genId: null,
  }
}

/**
 * @param {string} text
 * @param {string} key
 * @returns {object | null}
 */
function lastObjectAfterKey(text, key) {
  const marker = `"${key}"`
  let index = text.lastIndexOf(marker)
  while (index !== -1) {
    const brace = text.indexOf('{', index + marker.length)
    if (brace !== -1) {
      const slice = text.slice(brace)
      const depthEnd = matchingBrace(slice)
      if (depthEnd > 0) {
        const parsed = tryJson(Buffer.from(slice.slice(0, depthEnd + 1), 'utf8'))
        if (parsed && typeof parsed === 'object') return parsed
      }
    }
    index = index === 0 ? -1 : text.lastIndexOf(marker, index - 1)
  }
  return null
}

/** @param {string} text */
function matchingBrace(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** @param {unknown} ...values */
function firstCount(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  }
  return null
}

/** @param {unknown} ...values */
function firstMoney(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/** @param {unknown} ...values */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** @param {unknown} value */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

/** @param {Buffer} buffer */
function tryJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
function sendError(res, status, message) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // ignore
    }
    return
  }
  const body = Buffer.from(JSON.stringify({ error: { message } }), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** @param {string} host @param {number} port */
function originOf(host, port) {
  const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${name}:${port}`
}

/** @param {unknown} error */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
