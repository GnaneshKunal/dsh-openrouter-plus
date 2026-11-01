/**
 * The endpoint listing behind a *provider pin*, read for display rather than admission.
 *
 * `lib/endpoints.js` already reads the same public, keyless GET, but keeps only the four
 * fields admission control needs (`provider_name`, `tag`, `quantization`, `status`).
 * A picker cannot offer a choice with those: which endpoints exist is not the question,
 * which one to *route to* is, and that needs the price it bills at, how fast it is, and
 * how often it is up. So this module parses the same body into the full row.
 *
 *   GET <upstream>/models/<author>/<slug>/endpoints
 *   { data: { endpoints: [{ tag, provider_name, quantization, service_tier,
 *                           pricing: { prompt, completion, input_cache_read, discount },
 *                           context_length, max_completion_tokens,
 *                           uptime_last_5m, uptime_last_30m, uptime_last_1d, status, … }] } }
 *
 * Note that `status` is *not* availability: it is a health code the API leaves unexplained,
 * and the endpoint it marks most negatively may be the one carrying most of the traffic.
 *
 * The two readers are deliberately separate. Admission must stay synchronous and cheap —
 * it runs on a miss on the request path — while this one is allowed to be a fat, lazy,
 * cached read that only happens when an operator opens the provider menu. Sharing a
 * parser would have meant widening the request-path cache with fields no request reads.
 *
 * Pure by construction: no I/O in the parsing half, and the one fetch takes an injectable
 * `fetch`, exactly as `lib/models-sync.js` and `lib/endpoints.js` established.
 */

import { QUANTIZATION_LEVELS } from './quantization.js'

/** The levels a listing may report, for coercing a value nobody anticipated. */
const QUANTIZATION_LEVEL_SET = new Set(QUANTIZATION_LEVELS)

/**
 * Largest provider listing this plugin will read.
 *
 * A model with 42 endpoints is 47 KB today, so the real bound is the cap on *endpoints*
 * rather than bytes; this exists so an upstream that never stops writing cannot make the
 * Host buffer without bound. Larger than `ENDPOINTS_MAX_BYTES` on purpose: same URL,
 * but this reader keeps every field while admission keeps four.
 */
export const PROVIDERS_MAX_BYTES = 2 * 1024 * 1024

/**
 * How long one provider listing read may take before it is abandoned.
 *
 * This read happens while an operator is looking at a menu, so it is allowed to be
 * slower than the admission read — but it still has to end, because the page awaits it.
 */
export const PROVIDERS_TIMEOUT_MS = 8_000

/** How long one listing is trusted before the menu reads it again. */
export const PROVIDERS_TTL_MS = 10 * 60 * 1000

/**
 * How many models keep a listing.
 *
 * Much lower than the admission cache: an entry here is the full row set (tens of KB),
 * and only models an operator actually opened the menu on are ever in it.
 */
export const PROVIDERS_CACHE_LIMIT = 24

/**
 * The groups a menu renders, in order.
 *
 * `unavailable` is last and is not a tier: OpenRouter reports endpoints it will not use
 * in standard routing (a flex lane whose pool is closed, an endpoint it has stopped
 * serving) and the site shows them under a "not used" heading. Hiding them would make
 * the picker disagree with the model page; putting them last keeps them honest and out
 * of the way.
 */
export const PROVIDER_GROUPS = Object.freeze(['standard', 'flex', 'priority', 'unavailable'])

/** Tiers OpenRouter reports, and the only ones a pin can name. `null` means standard. */
const TIER_SET = new Set(['standard', 'flex', 'priority'])

/**
 * Path segments in a provider tag that name something other than a region.
 *
 * `deepinfra/fp8/flex` is a quantization and a tier; `deepinfra/turbo` and
 * `fireworks/spot` are endpoint variants; `inference-net/us` and `sail-research/fp4/us`
 * are regions. All of them are *inside* the tag, so telling them apart is what lets the
 * menu show "US" beside a provider that has two North American endpoints.
 */
const TAG_WORD_SET = new Set([
  'fp4',
  'fp8',
  'fp16',
  'bf16',
  'mxfp4',
  'int4',
  'int8',
  'unknown',
  'flex',
  'priority',
  'turbo',
  'spot',
  'fast',
  'standard',
  'default',
])

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * A price reported per token, as dollars per million tokens.
 *
 * OpenRouter quotes token prices as strings of dollars *per token* (`"0.000000035"`), and
 * the menu has to show `$0.035`. Multiplying by 1e6 is not exact in binary floating point
 * (`0.000000035 * 1e6` is `0.034999999999999996`), so the result is rounded to six
 * decimals — a token price finer than a millionth of a dollar is not a number any label
 * should print, and rounding is what keeps a displayed price equal to the one the API
 * reported instead of one ulp off it.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function perMillion(value) {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(raw) || raw < 0) return null
  return Number((raw * 1_000_000).toFixed(6))
}

/** A count, or null when the upstream did not report one. */
function asCount(value) {
  const raw = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : null
}

/** A percentage as reported, or null. Kept unrounded: the caller decides precision. */
function asPercent(value) {
  const raw = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(raw) ? raw : null
}

/**
 * The tier an endpoint belongs to. Absent means standard: OpenRouter omits
 * `service_tier` on the default pool rather than spelling it out.
 *
 * @param {unknown} value
 * @returns {'standard' | 'flex' | 'priority'}
 */
function tierOf(value) {
  const text = asText(value)
  const lowered = text === null ? null : text.toLowerCase()
  return lowered !== null && TIER_SET.has(lowered)
    ? /** @type {'standard' | 'flex' | 'priority'} */ (lowered)
    : 'standard'
}

/**
 * The precision an endpoint reports, lowercased.
 *
 * A value outside the known vocabulary is kept as its own lowercase token rather than
 * collapsed to `unknown`: the menu is a list of facts about endpoints, and "this one
 * says `int4`, which the floor vocabulary has no name for" is more useful than a row of
 * identical `unknown`s. The floor's own `unknown` still means "the endpoint did not say".
 *
 * @param {unknown} value
 * @returns {string}
 */
function precisionOf(value) {
  const text = asText(value)
  return text === null ? 'unknown' : text.toLowerCase()
}

/**
 * The region segment inside a provider tag, if it has one.
 *
 * Only a trailing 2–3 character segment that is not a known tag word counts, which is
 * what separates `inference-net/us` from `deepinfra/fp8` and `fireworks/spot`.
 *
 * @param {string | null} tag
 * @returns {string | null}
 */
function regionOf(tag) {
  if (tag === null) return null
  const segments = tag.split('/').slice(1)
  if (segments.length === 0) return null
  const last = segments[segments.length - 1].toLowerCase()
  if (TAG_WORD_SET.has(last)) return null
  return /^[a-z]{2,3}[0-9]?$/.test(last) ? last.toUpperCase() : null
}

/**
 * Whether an endpoint is answering right now.
 *
 * Read from the uptime windows, **never** from `status`. `status` is carried through
 * verbatim and deliberately not interpreted, the same rule `lib/endpoints.js` follows —
 * and there is measured evidence for that rule: on DeepSeek V4.1 Flash 1017 the endpoint
 * OpenRouter serves a third of the model's tokens from reports `status: -5` with 92%
 * one-day uptime. Treating a non-zero status as "not routed" would mark the model's
 * primary provider dead and draw it quiet in a menu whose whole purpose is to offer it.
 *
 * An endpoint that reported no uptime at all counts as available: the menu offers
 * choices, and hiding an endpoint because it could not be judged is the one failure this
 * field is allowed to cause.
 *
 * @param {number | null} uptime5m
 * @param {number | null} uptime1d
 * @returns {boolean}
 */
function availableOf(uptime5m, uptime1d) {
  const windows = [uptime5m, uptime1d].filter((value) => value !== null)
  if (windows.length === 0) return true
  return windows.some((value) => value > 0)
}

/**
 * One endpoint, normalised into the row a menu renders.
 *
 * `tag` is the important field: it is the slug a request names in `provider.only`, so it
 * is the pin's identity and its value on the wire. Everything else is display.
 *
 * @param {unknown} row
 * @param {number} index  the position in the listing, used only as a stable tiebreak
 * @returns {{
 *   tag: string, name: string, tier: 'standard' | 'flex' | 'priority', precision: string,
 *   inputPrice: number | null, outputPrice: number | null, cacheReadPrice: number | null,
 *   discount: number, contextLength: number | null, maxCompletionTokens: number | null,
 *   uptime1d: number | null, uptime30m: number | null, uptime5m: number | null,
 *   status: number | null, available: boolean, region: string | null,
 *   group: 'standard' | 'flex' | 'priority' | 'unavailable',
 *   supportedParameters: string[], order: number,
 * } | null}
 */
function normalizeProvider(row, index) {
  if (!isPlainObject(row)) return null
  const tag = asText(row.tag)
  // A row with no slug cannot be pinned, so it is not a choice this menu can offer. It is
  // also the only field whose absence is fatal: every other one degrades to a null the
  // label omits.
  if (tag === null) return null
  const pricing = isPlainObject(row.pricing) ? row.pricing : {}
  const tier = tierOf(row.service_tier)
  const uptime1d = asPercent(row.uptime_last_1d)
  const uptime30m = asPercent(row.uptime_last_30m)
  const uptime5m = asPercent(row.uptime_last_5m)
  const available = availableOf(uptime5m, uptime1d)
  const rawStatus = typeof row.status === 'number' ? row.status : Number.NaN
  const discount = typeof pricing.discount === 'number' && Number.isFinite(pricing.discount)
    ? Math.min(Math.max(pricing.discount, 0), 1)
    : 0
  return {
    tag,
    // `provider_name` is the company; `name` is "<company> | <model>" and is far too long
    // for a menu row, so the company is preferred and the tag is the last resort.
    name: asText(row.provider_name) ?? tag.split('/')[0] ?? tag,
    tier,
    precision: precisionOf(row.quantization),
    inputPrice: perMillion(pricing.prompt),
    outputPrice: perMillion(pricing.completion),
    cacheReadPrice: perMillion(pricing.input_cache_read),
    discount,
    contextLength: asCount(row.context_length),
    maxCompletionTokens: asCount(row.max_completion_tokens),
    uptime1d,
    uptime30m,
    uptime5m,
    status: Number.isFinite(rawStatus) ? rawStatus : null,
    available,
    region: regionOf(tag),
    group: available ? tier : 'unavailable',
    supportedParameters: Array.isArray(row.supported_parameters)
      ? row.supported_parameters.filter((entry) => typeof entry === 'string')
      : [],
    order: index,
  }
}

/**
 * Read one model's endpoint listing into provider rows.
 *
 * Takes the parsed body (or its text, or a JSON string) because both the Host's fetch and
 * a test hand it the same thing, and throws on a shape it cannot read — the caller turns
 * every throw into the same 502, so the message is for a log rather than a user.
 *
 * @param {unknown} payload
 * @param {number} [maxBytes]
 * @returns {ReturnType<typeof normalizeProvider>[]}
 */
export function parseProviders(payload, maxBytes = PROVIDERS_MAX_BYTES) {
  let body = payload
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      throw new TypeError(`this endpoint listing is larger than ${maxBytes} bytes`)
    }
    try {
      body = JSON.parse(body)
    } catch {
      throw new TypeError('this endpoint did not answer with JSON')
    }
  }
  const data = isPlainObject(body) ? body.data : undefined
  const rows = isPlainObject(data) ? data.endpoints : undefined
  if (!Array.isArray(rows)) {
    throw new TypeError('this endpoint did not answer with an endpoint listing (no "data.endpoints" array)')
  }
  const providers = []
  for (let index = 0; index < rows.length; index += 1) {
    const provider = normalizeProvider(rows[index], index)
    if (provider !== null) providers.push(provider)
  }
  return providers
}

/**
 * Providers sorted the way a menu should read them.
 *
 * Cheapest first is the useful default — the whole reason to open this list is usually
 * "which provider is serving this cheapest" — with unavailable rows last regardless of
 * price, because a price you cannot route to is not a cheaper option. Ties break on
 * output price then tag so the order is stable across reads rather than dependent on
 * whatever order the upstream happened to answer in.
 *
 * @param {readonly ReturnType<typeof normalizeProvider>[]} providers
 */
export function sortProviders(providers) {
  const list = Array.isArray(providers) ? providers.filter((entry) => entry !== null) : []
  return [...list].sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1
    const leftIn = left.inputPrice ?? Number.POSITIVE_INFINITY
    const rightIn = right.inputPrice ?? Number.POSITIVE_INFINITY
    if (leftIn !== rightIn) return leftIn - rightIn
    const leftOut = left.outputPrice ?? Number.POSITIVE_INFINITY
    const rightOut = right.outputPrice ?? Number.POSITIVE_INFINITY
    if (leftOut !== rightOut) return leftOut - rightOut
    if (left.order !== right.order) return left.order - right.order
    return left.tag.localeCompare(right.tag)
  })
}

/**
 * The groups a menu renders, each with its rows and in {@link PROVIDER_GROUPS} order.
 *
 * An empty group is omitted rather than returned empty: a model served only by standard
 * endpoints should not get a "Flex" heading with nothing under it.
 *
 * @param {readonly ReturnType<typeof normalizeProvider>[]} providers
 * @returns {Array<{ id: string, providers: NonNullable<ReturnType<typeof normalizeProvider>>[] }>}
 */
export function groupProviders(providers) {
  const sorted = sortProviders(providers)
  const groups = []
  for (const id of PROVIDER_GROUPS) {
    const rows = sorted.filter((provider) => provider.group === id)
    if (rows.length > 0) groups.push({ id, providers: rows })
  }
  return groups
}

/**
 * One provider by slug, or null.
 *
 * @param {readonly ReturnType<typeof normalizeProvider>[]} providers
 * @param {unknown} tag
 */
export function findProvider(providers, tag) {
  const wanted = asText(tag)
  if (wanted === null) return null
  const list = Array.isArray(providers) ? providers : []
  return list.find((provider) => provider !== null && provider.tag === wanted) ?? null
}

/**
 * The tier and precision to *display* while an endpoint is pinned.
 *
 * This is the whole reason the Tier and Precision cells are disabled rather than blanked
 * when a provider is chosen: the pin already decided both. `deepinfra/fp8/priority`
 * cannot be anything but the priority lane at fp8, so the cell states that as a fact
 * instead of offering a lever that would contradict it.
 *
 * @param {unknown} provider a row from {@link parseProviders}, or anything else
 * @returns {{ tier: 'standard' | 'flex' | 'priority', precision: string } | null}
 */
export function pinnedFacets(provider) {
  if (!isPlainObject(provider)) return null
  const tag = asText(provider.tag)
  if (tag === null) return null
  return {
    tier: tierOf(provider.tier),
    precision: precisionOf(provider.precision),
  }
}

/**
 * Read one model's provider listing from an OpenRouter-compatible upstream.
 *
 * Deliberately the same shape as `readEndpoints`: injected `fetch`, a byte cap, a timeout,
 * and every failure as a rejected promise. The difference is only what the caller does
 * with a failure — admission treats it as "no levels", the picker as "no list", and
 * neither is allowed to become a thrown response on the request path.
 *
 * @param {string} upstream the relay's upstream, e.g. 'https://openrouter.ai/api/v1'
 * @param {string} model a model id, `<author>/<slug>`
 * @param {{ fetch?: typeof globalThis.fetch, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ url: string, providers: ReturnType<typeof parseProviders> }>}
 */
export async function readProviders(upstream, model, options = {}) {
  const doFetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : PROVIDERS_TIMEOUT_MS
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : PROVIDERS_MAX_BYTES
  const base = String(upstream ?? '').replace(/\/+$/, '')
  const id = String(model ?? '').trim().replace(/^\/+/, '')
  const url = `${base}/models/${id}/endpoints`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller === null ? undefined : controller.signal,
    })
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = await response.text()
  return { url, providers: parseProviders(text, maxBytes) }
}

/**
 * The precisions these endpoints report, coerced into the floor's own vocabulary.
 *
 * Deliberately the *same* coercion `lib/endpoints.js` applies (`mxfp4` is a level,
 * `fp9` becomes `unknown`), because this set is written into the admission cache: a
 * floor is admitted by intersecting its include list with these tokens, so a value that
 * landed here in a shape `levelsFrom` would not have produced could silently disable the
 * floor for a model. Importing the vocabulary rather than restating it is what keeps the
 * two readers agreeing about what an endpoint's precision *is*.
 *
 * @param {readonly unknown[]} providers
 * @returns {Set<string>}
 */
export function precisionLevels(providers) {
  const levels = new Set()
  for (const provider of Array.isArray(providers) ? providers : []) {
    const raw = isPlainObject(provider) && typeof provider.precision === 'string'
      ? provider.precision.trim().toLowerCase()
      : ''
    levels.add(QUANTIZATION_LEVEL_SET.has(raw) ? raw : 'unknown')
  }
  return levels
}

/**
 * The slugs these endpoints can be pinned by.
 *
 * @param {readonly unknown[]} providers
 * @returns {Set<string>}
 */
export function tagsOf(providers) {
  const tags = new Set()
  for (const provider of Array.isArray(providers) ? providers : []) {
    const tag = isPlainObject(provider) ? asText(provider.tag) : null
    if (tag !== null) tags.add(tag)
  }
  return tags
}
