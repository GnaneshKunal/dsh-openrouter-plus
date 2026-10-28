/**
 * dsh-openrouter-plus — Host half.
 *
 * One loopback HTTP relay + one status/control API. The relay exists because the
 * only request-body seam a third-party plugin can reach is a provider route's
 * `baseURL`: we point a pi-ai provider route at `http://127.0.0.1:<port>/t/<id>/v1`,
 * and the relay applies that Session's preset to the body on the way upstream —
 * `service_tier`, `provider.sort`, or the `:floor` model suffix. See
 * docs/ARCHITECTURE.md and deepseek-harness discussion #9787.
 *
 * Two listeners, two jobs. The relay is a loopback HTTP origin because pi-ai
 * dials it from this process and it forwards the caller's Authorization verbatim;
 * it is never reachable from a browser on another machine, by design. The control
 * API is different: it has to be reachable from wherever the page is, so the Host
 * mounts it on the DSH web server's own origin (see `controlOnWeb`) and the relay
 * keeps a copy only for `curl` and for compositions with no web GUI. That split is
 * what makes Settings → OpenRouter Plus work behind Tailscale.
 */
import { createMetrics } from './lib/metrics.js'
import { createRelay } from './lib/proxy.js'
import { createConfigBridge } from './lib/config-bridge.js'
import { MODEL_LISTING_MAX_BYTES, annotateLive, readLiveModels } from './lib/models-sync.js'
import { normalizeReasoningEfforts } from './lib/reasoning.js'
import { createAutoRepair } from './lib/auto-repair.js'

/** Must match the string client.js probes and the docs advertise. */
const CONTROL_PREFIX = '/__openrouter-plus'

const DEFAULT_ROUTES = {
  '/flex/v1': 'flex',
  '/priority/v1': 'priority',
  '/fast/v1': 'fast',
  '/ultrafast/v1': 'ultrafast',
  '/scale/v1': 'scale',
  '/auto/v1': 'auto',
  '/default/v1': 'default',
  '/v1': null,
}

const DEFAULT_UPSTREAM = 'https://openrouter.ai/api/v1'

/** Tier names an explicit `/t/<id>/<tier>/v1` mount may still pin. */
const KNOWN_TIERS = ['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast']

/**
 * What each preset actually sends.
 *
 * A preset is an outcome a person picks; the fields are this relay's business.
 * `service_tier`, `provider.sort` and a model variant are three separate levers with
 * three separate contracts — pool eligibility plus lane precedence, the comparator
 * over that pool, and the two "admit a tier *and* sort" slugs the API does not let a
 * parameter express. Keeping them as one recipe per outcome is what stops a picker
 * from offering `:nitro` alongside `service_tier: "priority"`, a combination the API
 * never defines.
 *
 * - `none`             send nothing; OpenRouter's own routing decides.
 * - `standard`         pin the standard tier — priority endpoints excluded.
 * - `fastest`          sort the whole pool by throughput. This *is* nitro for an
 *                      open-weight model (its priority endpoints already compete in
 *                      default routing) and stops short of it for a closed-weight one.
 * - `fastest-standard` the same race with priority endpoints excluded: no premium.
 * - `cheapest`         sort the whole pool by price; never admits a flex endpoint,
 *                      so it cannot reach a flex rate.
 * - `flex`             flex endpoints only. Not necessarily the cheapest, and a flex
 *                      capacity error surfaces instead of falling back.
 * - `priority`         priority endpoints first, then standard; billing follows the
 *                      endpoint that actually served.
 * - `ultra`            ultrafast, then priority, then standard; needs `max_tokens`
 *                      or it silently degrades to priority.
 * - `floor`            the `:floor` slug: blind price sort over standard + flex. No
 *                      parameter form exists for it, which is why it is a variant.
 *
 * @type {Readonly<Record<string, { serviceTier: string|null, sort: string|null, variant: string|null }>>}
 */
export const PRESET_WIRE = Object.freeze({
  none: { serviceTier: null, sort: null, variant: null },
  standard: { serviceTier: 'default', sort: null, variant: null },
  fastest: { serviceTier: null, sort: 'throughput', variant: null },
  'fastest-standard': { serviceTier: 'default', sort: 'throughput', variant: null },
  cheapest: { serviceTier: null, sort: 'price', variant: null },
  flex: { serviceTier: 'flex', sort: null, variant: null },
  priority: { serviceTier: 'priority', sort: null, variant: null },
  ultra: { serviceTier: 'ultrafast', sort: null, variant: null },
  floor: { serviceTier: null, sort: null, variant: 'floor' },
})

/** Preset ids, in the order the composer offers them. */
export const PRESET_IDS = Object.freeze(Object.keys(PRESET_WIRE))

/**
 * Tier strings still accepted from a tier-based config or a hand-written call, mapped onto
 * the preset that sends the same thing. `scale` has no endpoints, so it maps to the
 * pass-through preset rather than pretending to be a request.
 */
const LEGACY_TIER_PRESET = Object.freeze({
  auto: 'none',
  default: 'standard',
  flex: 'flex',
  priority: 'priority',
  fast: 'priority',
  ultrafast: 'ultra',
  scale: 'none',
})

const VERSION = '0.2.3'

/** Largest control-POST body we will read; these are tiny JSON documents. */
const MAX_CONTROL_BODY = 64 * 1024

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/** A Host header naming this machine; only the local-process exemption reads it. */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/i

/**
 * @param {Record<string, unknown>} [raw] the Loader row config
 * @returns {{
 *   enabled: boolean, host: string, port: number, portFallback: boolean,
 *   upstream: string, routes: Record<string, string|null>, upstreamTimeoutMs: number,
 *   autoRepairReasoning: boolean, defaultPreset: string|null,
 *   sessionPresets: Record<string, string>, sessionPresetStamp: Record<string, number>,
 * }}
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const upstream = typeof config.upstream === 'string' && config.upstream.trim()
    ? config.upstream.trim().replace(/\/+$/, '')
    : DEFAULT_UPSTREAM
  const sessionPresets = normalizeSessionPresets(config.sessionPresets)
  return {
    enabled: config.enabled !== false,
    host: typeof config.host === 'string' && config.host.trim() ? config.host.trim() : '127.0.0.1',
    port: Number.isInteger(config.port) && config.port > 0 && config.port < 65536 ? config.port : 8791,
    portFallback: config.portFallback !== false,
    upstream,
    routes: normalizeRoutes(config.routes),
    upstreamTimeoutMs: Number.isFinite(config.upstreamTimeoutMs) && config.upstreamTimeoutMs > 0
      ? config.upstreamTimeoutMs
      : 0,
    // `false` never fills, absent/`null` fills only from evidence found in the
    // profile, a map is the blanket fallback for models with no evidence.
    reasoningEfforts: normalizeReasoningEfforts(config.reasoningEfforts),
    // Re-fill after any profile edit: the Models page's model picker rebuilds a
    // picked row from its catalog and drops `reasoningEfforts` on the way, which
    // is exactly how a working effort selector disappears.
    autoRepairReasoning: config.autoRepairReasoning !== false,
    // Extra upstreams this relay forwards to, keyed by the id used in their
    // mount path. Written by the control API when a provider is attached.
    targets: normalizeTargets(config.targets),
    // The preset a Session runs on when it has not chosen one. A preset is a runtime
    // decision, so it lives here next to the table rather than in any provider row.
    // `defaultTier` is the tier-era spelling and still normalises forward.
    defaultPreset: normalizePresetId(config.defaultPreset ?? config.defaultTier),
    sessionPresets: sessionPresets.presets,
    sessionPresetStamp: sessionPresets.stamp,
  }
}

/**
 * Normalise a tier name against the tiers an explicit mount may pin, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeTierName(value) {
  const tier = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return KNOWN_TIERS.includes(tier) ? tier : null
}

/**
 * Normalise a preset id, accepting the tier spellings so a hand-written config keeps
 * working: `flex`, `priority` and `ultrafast` are still preset ids and are left alone;
 * `default` becomes `standard`; `auto` and `scale` become the pass-through preset.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePresetId(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === '') return null
  if (Object.hasOwn(PRESET_WIRE, text)) return text
  return LEGACY_TIER_PRESET[text] ?? null
}

/** How many Sessions keep a chosen preset before the oldest choices are dropped. */
export const SESSION_PRESET_LIMIT = 200

/**
 * Normalise the per-Session preset table. Entries are `{ preset, at }` objects written
 * by the control API; a bare string is accepted too so a hand-edited config still
 * works, and a `{ tier }` body is read forward. Oldest entries are dropped past
 * {@link SESSION_PRESET_LIMIT} so the table cannot grow without bound as Sessions are
 * created.
 *
 * @param {unknown} raw
 * @returns {{ presets: Record<string, string>, stamp: Record<string, number> }}
 */
export function normalizeSessionPresets(raw) {
  if (!isPlainObject(raw)) return { presets: {}, stamp: {} }
  /** @type {Array<[string, string, number]>} */
  const kept = []
  for (const [rawId, value] of Object.entries(raw)) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (!id || id.length > 128) continue
    const object = isPlainObject(value) ? value : { preset: value }
    const preset = normalizePresetId(object.preset ?? object.tier)
    if (preset === null) continue
    const at = Number.isFinite(object.at) ? Number(object.at) : 0
    kept.push([id, preset, at])
  }
  kept.sort((a, b) => b[2] - a[2])
  /** @type {Record<string, string>} */
  const presets = {}
  /** @type {Record<string, number>} */
  const stamp = {}
  for (const [id, preset, at] of kept.slice(0, SESSION_PRESET_LIMIT)) {
    presets[id] = preset
    stamp[id] = at
  }
  return { presets, stamp }
}

/**
 * Normalise the mount table: leading slash required, only `null` or a non-empty
 * tier string accepted, longest mount first so the relay's own ordering fallback
 * cannot pick a shorter mount by accident.
 *
 * @param {unknown} routes
 * @returns {Record<string, string|null>}
 */
export function normalizeRoutes(routes) {
  if (!isPlainObject(routes)) return { ...DEFAULT_ROUTES }
  /** @type {Record<string, string|null>} */
  const next = {}
  for (const [rawPath, rawTier] of Object.entries(routes)) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const path = ('/' + rawPath.trim().replace(/^\/+/, '').replace(/\/+$/, '')).trim()
    if (path === '/') continue
    if (rawTier === null || rawTier === undefined || rawTier === '' || rawTier === false) {
      next[path] = null
      continue
    }
    if (typeof rawTier !== 'string') continue
    next[path] = rawTier.trim().toLowerCase()
  }
  if (Object.keys(next).length === 0) return { ...DEFAULT_ROUTES }
  /** @type {Record<string, string|null>} */
  const ordered = {}
  for (const path of Object.keys(next).sort((a, b) => b.length - a.length)) ordered[path] = next[path]
  return ordered
}

/** Shape of a target id: safe in a path segment, lowercase, no separators at the ends. */
const TARGET_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** This plugin's profile row: the target table is written into its own config. */
const OWN_ENTRY_ID = 'openrouter-plus'
const OWN_PACKAGE = 'dsh-openrouter-plus'

/**
 * Normalise a target id, or return null when it cannot be one.
 * @param {unknown} value
 */
function targetId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TARGET_ID.test(id) ? id : null
}

/**
 * Normalise a destination URL: absolute http(s), no trailing slash.
 * @param {unknown} value
 * @returns {string | null}
 */
function targetUrl(value) {
  const url = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

/**
 * Normalise the target table: `{ id: { upstream, tier } }`.
 *
 * A target is one HTTP endpoint behind a relay mount: `upstream` is where the
 * relay forwards, `tier` is the `service_tier` it pins (`null` = pure passthrough,
 * the only correct choice for an endpoint that is not an OpenAI-compatible
 * provider with tiers). Nothing here is trusted: an id that would escape its path
 * segment, a URL that is not http(s), or an unknown tier is dropped rather than
 * guessed at.
 *
 * @param {unknown} raw
 * @returns {Record<string, { upstream: string, tier: string | null }>}
 */
export function normalizeTargets(raw) {
  if (!isPlainObject(raw)) return {}
  /** @type {Record<string, { upstream: string, tier: string | null }>} */
  const out = {}
  for (const [rawId, value] of Object.entries(raw)) {
    const id = targetId(rawId)
    if (!id || !isPlainObject(value)) continue
    const upstream = targetUrl(value.upstream)
    if (!upstream) continue
    const tier = typeof value.tier === 'string' && KNOWN_TIERS.includes(value.tier.trim().toLowerCase())
      ? value.tier.trim().toLowerCase()
      : null
    out[id] = { upstream, tier }
  }
  return out
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
function createLogger(ctx) {
  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @param {unknown} [detail]
   */
  return (level, message, detail) => {
    const line = `[openrouter-plus] ${message}`
    try {
      const logger = /** @type {any} */ (ctx).logger
      const emit = logger?.[level] ?? logger?.log
      if (typeof emit === 'function') {
        if (detail === undefined) emit.call(logger, line)
        else emit.call(logger, line, detail)
        return
      }
    } catch {
      // fall through to the console: a logging shim must never fail a request
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(detail === undefined ? line : `${line} ${safeJson(detail)}`)
  }
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Read and parse a small JSON control body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_CONTROL_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const parsed = JSON.parse(text)
        if (!isPlainObject(parsed)) return reject(new Error('expected a JSON object'))
        resolve(parsed)
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(safeJson(payload), 'utf8')
  if (!res.headersSent) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
  }
  res.end(body)
}

/**
 * An error the control layer should answer with its own status, not a 500.
 * @param {string} message
 * @param {number} [status]
 */
function badRequest(message, status = 400) {
  const rejection = /** @type {Error & { status?: number }} */ (new Error(message))
  rejection.status = status
  return rejection
}

/**
 * CORS for the control endpoints only: the DSH GUI runs on loopback at an
 * arbitrary port, so any loopback origin is reflected. A non-loopback origin is
 * never echoed, which keeps a public page from reading relay telemetry.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function applyCors(req, res) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && LOOPBACK_ORIGIN.test(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-oorp-client')
  res.setHeader('access-control-max-age', '600')
}

/**
 * Wrap a control handler with CORS, the preflight answer, the cross-site guard
 * and error containment. The guard is a custom header: a foreign origin cannot
 * add it without a preflight this relay refuses to approve.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>|void} handler
 */
function controlRoute(handler) {
  return async (req, res) => {
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'POST' && req.headers['x-oorp-client'] !== 'web') {
      sendJson(res, 403, { error: { message: 'missing x-oorp-client header' } })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      const status = Number.isInteger(/** @type {any} */ (error)?.status)
        ? /** @type {any} */ (error).status
        : 500
      sendJson(res, status, {
        error: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/**
 * Run `operation` outside the async context this listener inherited.
 *
 * `configEditor.edit()` serialises its write through the HMR service, which refuses
 * to start while another transaction is already executing ("HMR transactions cannot
 * be nested"). An HTTP listener created during plugin activation inherits that
 * activation's async context, so every request it later serves looks like a nested
 * transaction. Stepping out of the HMR store for the duration of the call is the
 * difference between "cannot save the route" and a working button.
 *
 * The exit is synchronous, which is all that matters: `runExclusive` reads the store
 * when it is called, then owns its own context for the actual work.
 *
 * @template T
 * @param {any} ctx
 * @param {() => T} operation
 * @returns {T}
 */
export function outsideHmrTransaction(ctx, operation) {
  try {
    const hmr = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
    const storage = hmr?.executing
    if (storage && typeof storage.exit === 'function') return storage.exit(operation)
  } catch {
    // No HMR (or an unexpected shape): the plain call is correct in that case.
  }
  return operation()
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} method
 */
function requireMethod(req, res, method) {
  if (req.method === method) return true
  sendJson(res, 405, { error: { message: `use ${method}` } })
  return false
}

/**
 * Whether the request arrived over loopback, judged from its Host header.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isLoopbackRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const close = host.startsWith('[') ? host.indexOf(']') + 1 : host.indexOf(':')
  const name = close > 0 ? host.slice(0, close) : host
  return LOOPBACK_HOST.test(name)
}

/**
 * The fence in front of the control API when it is mounted on the web server.
 *
 * Anything carrying an `Origin` is a browser page and must pass the same admission
 * the DSH GUI's own API uses, so a foreign page cannot read this relay's telemetry
 * or drive a config write. A request with a loopback Host and no `Origin` is a local
 * process (`curl`, a script, the troubleshooting row in the README); that is the
 * privilege it already had on the relay listener, so it is allowed through
 * unauthenticated. Browsers always send `Origin` on a cross-origin request, and the
 * fence refuses a mismatched one before this exemption is ever consulted.
 *
 * @param {unknown} connection the `ctx.connection` service, when one is mounted
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|null} the status to answer with, or null to proceed
 */
function controlRejection(connection, req) {
  const service = /** @type {{ requestRejection?: (request: import('node:http').IncomingMessage) => unknown }|undefined} */ (
    connection
  )
  if (service === undefined || service === null || typeof service.requestRejection !== 'function') return null
  const rejection = service.requestRejection(req)
  if (typeof rejection !== 'number') return null
  if (rejection === 401 && req.headers.origin === undefined && isLoopbackRequest(req)) return null
  return rejection
}

/**
 * Host plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(ctx)

  if (!config.enabled) {
    log('info', 'disabled by config (enabled: false); no listener bound')
    return
  }

  const metrics = createMetrics({ recentLimit: 50 })
  const startedAt = Date.now()

  /** Live state the control endpoints report. @type {{ error: string|undefined }} */
  const state = { error: undefined }

  const bridge = createConfigBridge({
    ctx,
    log,
    origin: () => {
      const address = relay.address()
      return address ? { host: address.host, port: address.port } : { host: config.host, port: config.port }
    },
    tiers: KNOWN_TIERS,
    reasoningEfforts: config.reasoningEfforts,
  })

  // The effort selector disappears the moment a model is re-picked in Settings →
  // Models, and that edit happens on another page; so the capability is restored
  // without being asked. Every pass is idempotent — with nothing missing it writes
  // nothing — which is what makes it safe to run on every config settle.
  const autoRepair = createAutoRepair({
    repair: async () => {
      // No editor, no writes: a Host without one would otherwise log the same
      // failure on every config settle.
      if (!bridge.available()) return { patched: [] }
      return outsideHmrTransaction(ctx, () => bridge.repairRoutes())
    },
    onPatched: (repaired) => log('info', 'restored reasoning capability on provider routes', repaired.patched),
    onError: (error) => log('warn', 'automatic reasoning repair failed', error),
  })

  // ── secondary mounts ─────────────────────────────────────────────────────
  // A "target" is a provider endpoint the operator attached to this relay (see
  // the settings UI). The relay gets only a lookup function; the table lives in
  // this plugin's own config, so it survives a restart with the profile instead
  // of being rebuilt by whoever happens to open the page.

  /** Live relay origin, or the configured one before the listener binds. */
  function currentOrigin() {
    const address = relay.address()
    if (address && typeof address.origin === 'string') return address.origin
    return originOf(config.host, config.port)
  }

  /**
   * Mount path a target is served on. Pure: a caller that has just written the
   * table (and therefore cannot read the reloaded config yet) still gets the
   * path the next request will use.
   * @param {string} id
   * @param {string | null} tier
   */
  function mountFor(id, tier) {
    return tier ? `/t/${id}/${tier}` : `/t/${id}`
  }

  /** Absolute base URL to hand to a provider row (includes the API version). */
  function baseUrlFor(id, tier) {
    return `${currentOrigin()}${mountFor(id, tier)}/v1`
  }

  /** Absolute base URL of a configured target. */
  function targetBaseUrl(id) {
    const target = config.targets[id]
    return target ? baseUrlFor(id, target.tier) : null
  }

  /**
   * Resolve a mount to its forwarding destination.
   *
   * `null` means "unknown or unsafe": the relay answers 404 instead of inventing
   * an upstream. A target that points back at this listener is refused here for
   * the same reason — forwarding to ourselves would recurse forever.
   */
  function resolveTarget(rawId) {
    const id = targetId(rawId)
    const target = id ? config.targets[id] : undefined
    if (!target) return null
    if (target.upstream.startsWith(currentOrigin())) return null
    return { upstream: target.upstream, tier: target.tier }
  }

  /**
   * Write the target table into this plugin's own profile row.
   *
   * The table is the only durable state this feature needs, so it goes where the
   * rest of the plugin config lives rather than into a dotfile. A write bounces
   * this entry (the Loader applies patches live), which is why the control layer
   * only calls it when the table really changed.
   *
   * @param {(targets: Record<string, { upstream: string, tier: string | null }>) => Record<string, { upstream: string, tier: string | null }>} mutate
   */
  /**
   * This plugin's own profile row and editor, or null when the Host cannot be
   * edited (the target table is the only thing that needs it).
   */
  function ownRow() {
    const editor = (() => {
      try {
        const viaGet = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
        if (viaGet) return viaGet
      } catch {
        // fall through to the direct property
      }
      try {
        return ctx.configEditor
      } catch {
        return null
      }
    })()
    if (!editor || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
      throw new Error('OpenRouter Plus cannot save relay targets: the Harness configuration editor is not available in this session.')
    }
    const rows = editor.configuration()
    const row = (Array.isArray(rows) ? rows : []).find((candidate) => {
      const options = candidate?.entry?.options
      const id = typeof options?.id === 'string' ? options.id : ''
      const name = typeof options?.name === 'string' ? options.name : ''
      return id === OWN_ENTRY_ID || name === OWN_PACKAGE
    })
    if (!row) {
      throw new Error(`OpenRouter Plus cannot save relay targets: its own ${OWN_ENTRY_ID} row is not in this profile.`)
    }
    const current = isPlainObject(row?.entry?.options?.config) ? row.entry.options.config : {}
    return { editor, entry: row.entry, current }
  }

  /**
   * The target table as it is ON DISK, not as this fiber booted with: a control
   * request may follow a write this same process made, and `config.targets` is
   * frozen at boot. Falls back to the loaded copy when there is no editor.
   */
  function ownTargets() {
    try {
      return normalizeTargets(ownRow().current.targets)
    } catch {
      return config.targets
    }
  }

  /** The live provider row for `route`, as /targets describes it. */
  async function sourceOf(route) {
    if (!bridge.available()) return null
    const live = await bridge.targets()
    return (live.sources ?? []).find((source) => source.key === route) ?? null
  }

  /**
   * The preset each Session chose, live in memory so a request never pays for a
   * config read, and mirrored into this plugin's own row so a restart keeps it.
   * The preset is a runtime decision — the same shape `reasoningEffort` has — so it
   * is deliberately *not* a property of any provider row.
   *
   * @type {Map<string, string>}
   */
  const sessionPresets = new Map(Object.entries(config.sessionPresets ?? {}))

  /** When each choice was made, for bounded eviction. @type {Map<string, number>} */
  const sessionPresetStamp = new Map(Object.entries(config.sessionPresetStamp ?? {}))

  /** The preset a Session runs on when it has chosen nothing. */
  function defaultPreset() {
    return normalizePresetId(config.defaultPreset) ?? 'none'
  }

  /**
   * Persist the preset every unchosen Session inherits.
   *
   * Written into this plugin's own row because it is a preference, not a request
   * property: unlike a Session's choice there is nothing to keep in memory, so the
   * next request reads it straight from the reloaded config.
   *
   * @param {string} preset
   */
  async function writeDefaultPreset(preset) {
    const { editor, entry, current } = ownRow()
    await editor.edit(entry, (currentConfig) => ({
      ...(isPlainObject(currentConfig) ? currentConfig : current),
      defaultPreset: preset,
    }))
  }

  /**
   * The preset one Session runs on: its own choice, else the configured default.
   * An unknown/blank Session gets the default — a proxy hop with no session is still
   * the correct answer, never an error.
   *
   * @param {unknown} session
   * @returns {string}
   */
  function presetForSession(session) {
    const key = typeof session === 'string' ? session.trim() : ''
    if (key !== '') {
      const chosen = sessionPresets.get(key)
      if (chosen !== undefined) return chosen
    }
    return defaultPreset()
  }

  /**
   * The recipe one Session's request must carry, expanded through {@link PRESET_WIRE}.
   * There is no "no answer" case: the pass-through preset is an answer, and it is what
   * keeps a tier pinned by the client from surviving the picker.
   *
   * @param {unknown} session
   */
  function recipeForSession(session) {
    const preset = presetForSession(session)
    const wire = PRESET_WIRE[preset] ?? PRESET_WIRE.none
    return { preset, serviceTier: wire.serviceTier, sort: wire.sort, variant: wire.variant }
  }

  /**
   * Record one Session's preset — or clear it, which hands that Session back to the
   * configured default.
   *
   * Deliberately memory-only. A Session's choice is runtime state, exactly like
   * `reasoningEffort`; persisting it would write the plugin row on every switch, and
   * that write reloads this plugin and restarts the listener mid-conversation. The one
   * preset setting that outlives a restart is `POST /tier/default`.
   *
   * @param {string} session
   * @param {string | null} preset
   */
  function writeSessionPreset(session, preset) {
    if (preset === null) {
      sessionPresets.delete(session)
      sessionPresetStamp.delete(session)
      return
    }
    sessionPresets.set(session, preset)
    sessionPresetStamp.set(session, Date.now())
    // Evict the oldest choices past the cap so a long-lived Host cannot grow a table
    // of every Session it ever ran.
    if (sessionPresets.size > SESSION_PRESET_LIMIT) {
      const ordered = [...sessionPresetStamp.entries()].sort((a, b) => a[1] - b[1])
      for (const [key] of ordered.slice(0, sessionPresets.size - SESSION_PRESET_LIMIT)) {
        sessionPresets.delete(key)
        sessionPresetStamp.delete(key)
      }
    }
  }

  /**
   * The target mount a baseURL names, if it is one of ours.
   * @param {unknown} value
   * @returns {{ targetId: string, tier: string | null } | null}
   */
  function relayMountOf(value) {
    if (typeof value !== 'string' || !value.startsWith(`${currentOrigin()}/t/`)) return null
    const rest = value.slice(`${currentOrigin()}/t/`.length).split('/')
    const mountId = targetId(rest[0])
    if (!mountId) return null
    const tier = rest.length > 2 && KNOWN_TIERS.includes(rest[1]) ? rest[1] : null
    return { targetId: mountId, tier }
  }

  // ── live model listing ───────────────────────────────────────────────────
  // `dsh-llm-pi-ai` answers "Fetch available models" for a catalog provider from
  // the snapshot baked into `@earendil-works/pi-ai`, and it answers *before* it
  // reads the route's `baseURL` — so a row pointed at this relay still reports the
  // bundled snapshot, and every model OpenRouter has added since pi-ai was last
  // published is invisible. A plugin cannot change that function. It can write the
  // other half: a route that declares `models` serves exactly that list.

  /**
   * The endpoint a route's model listing should be read from.
   *
   * A routed row has no endpoint of its own left — its `baseURL` is one of our
   * mounts — so the target registry answers with what the relay forwards to. A row
   * that is not routed answers with its own `baseURL`. A catalog row that declares
   * none (the stock `openrouter` row resolves its endpoint from the installed
   * catalog) falls back to the one the caller read off the card, which is the only
   * endpoint that row honestly has.
   *
   * @param {string} route
   * @param {unknown} supplied - the endpoint the caller already knows, if any.
   * @returns {Promise<{ upstream: string, source: 'target' | 'route' | 'request' } | null>}
   */
  async function upstreamOf(route, supplied) {
    const source = await sourceOf(route)
    const baseURL = typeof source?.baseURL === 'string' ? source.baseURL : ''
    const mount = relayMountOf(baseURL)
    if (mount) {
      const registered = targetUrl(ownTargets()[mount.targetId]?.upstream)
      if (registered) return { upstream: registered, source: 'target' }
    }
    const own = targetUrl(baseURL)
    if (own) return { upstream: own, source: 'route' }
    const shared = targetUrl(supplied)
    if (shared) return { upstream: shared, source: 'request' }
    return null
  }

  /**
   * Read one upstream's live model listing.
   *
   * Bounded on purpose: the reply is buffered so its size can be checked before it
   * is parsed. OpenRouter's full listing is already ~780 KB, so an upstream that
   * streams without end must not be able to exhaust the Host process.
   *
   * @param {string} upstream - normalised endpoint, no trailing slash.
   * @returns {Promise<{ models: Array<Record<string, any>>, skipped: number, duplicates: number, url: string }>}
   */
  async function fetchListing(upstream) {
    const url = `${upstream}/models`
    let response
    try {
      response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw badRequest(`could not reach ${url}: ${reason}`, 502)
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '; this endpoint needs a credential' : ''
      throw badRequest(`${url} answered ${response.status}${hint}`, 502)
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MODEL_LISTING_MAX_BYTES) {
      throw badRequest(`${url} answered with more than ${MODEL_LISTING_MAX_BYTES} bytes`, 502)
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw badRequest(`${url} did not answer with JSON`, 502)
    }
    try {
      return { ...readLiveModels(payload), url }
    } catch (error) {
      throw badRequest(`${url}: ${error instanceof Error ? error.message : String(error)}`, 502)
    }
  }

  /**
   * The route a model-sync request names.
   *
   * Only emptiness is refused here: whether the name exists in the profile is the
   * bridge's answer, and it already reports the routes that do exist.
   */
  function requireRoute(value) {
    const route = typeof value === 'string' ? value.trim() : ''
    if (!route) throw badRequest('route is required: the provider id whose models to read')
    return route
  }

  /**
   * Run a bridge mutation and turn its user-facing refusals into 400s. The bridge
   * throws plain messages (no status) on purpose, so the mapping lives here.
   *
   * @param {() => Promise<{ name: string, from: string | null, to: string, changed: boolean }>} operation
   */
  async function providerWrite(operation) {
    try {
      return await outsideHmrTransaction(ctx, operation)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error))
    }
  }

  async function writeTargets(mutate) {
    const { editor, entry, current } = ownRow()
    const before = normalizeTargets(current.targets)
    const next = mutate(JSON.parse(JSON.stringify(before)))
    if (JSON.stringify(before) === JSON.stringify(next)) return next
    await editor.edit(entry, (currentConfig) => ({
      ...(isPlainObject(currentConfig) ? currentConfig : current),
      targets: next,
    }))
    return next
  }

  /**
   * Register (or reuse) the target for an upstream and report what to hand a
   * provider row.
   *
   * Idempotent by construction: the same endpoint, or the same request twice,
   * maps to one id, so pressing the checkbox again cannot fork the table.
   *
   * @param {{ upstream?: unknown, tier?: unknown }} body
   */
  async function ensureTarget(body) {
    const upstream = targetUrl(body?.upstream)
    if (!upstream) {
      throw badRequest('upstream must be an absolute http(s) URL, for example https://gateway.example/v1')
    }
    if (upstream.startsWith(currentOrigin())) {
      throw badRequest('that endpoint is this relay; pick the provider base URL instead of the relay URL')
    }
    const rawTier = typeof body?.tier === 'string' ? body.tier.trim().toLowerCase() : ''
    if (rawTier && !KNOWN_TIERS.includes(rawTier)) {
      throw badRequest(`unknown service tier ${JSON.stringify(rawTier)}; use one of ${KNOWN_TIERS.join(', ')} or no tier`)
    }
    const tier = rawTier || null
    const table = ownTargets()
    const existing = Object.entries(table)
      .find(([, target]) => target.upstream === upstream)?.[0]
    const requested = targetId(body?.id)
    const id = requested && table[requested]
      ? requested
      : (requested ?? existing ?? idForTarget(upstream))
    const configured = table[id]
    const created = !configured
    if (!configured || configured.tier !== tier) {
      await writeTargets((targets) => {
        targets[id] = { upstream, tier }
        return targets
      })
    }
    const target = { id, upstream, tier }
    return {
      created,
      target,
      mount: mountFor(id, tier),
      baseURL: baseUrlFor(id, tier),
      summary: { id, upstream, tier, created },
    }
  }

  /**
   * Deterministic id for an upstream: a readable slug of the host plus a short
   * digest, so the same endpoint always reuses its mount (and its provider row
   * never has to be repointed twice for one checkbox).
   */
  function idForTarget(upstream) {
    let host = 'target'
    try {
      host = new URL(upstream).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    } catch {
      // `targetUrl` already validated it; keep the generic slug.
    }
    let digest = 0
    for (let index = 0; index < upstream.length; index += 1) {
      digest = (Math.imul(digest, 31) + upstream.charCodeAt(index)) >>> 0
    }
    const suffix = digest.toString(36).slice(-4).padStart(4, '0')
    const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 26) || 'target'
    return targetId(`${slug}-${suffix}`) ?? `target-${suffix}`
  }

  const control = {
    [`${CONTROL_PREFIX}/health`]: controlRoute((req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      sendJson(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - startedAt })
    }),

    [`${CONTROL_PREFIX}/status`]: controlRoute((req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const bound = relay.address()
      const address = bound ?? {
        host: config.host,
        port: config.port,
        origin: originOf(config.host, config.port),
      }
      sendJson(res, 200, {
        ok: state.error === undefined,
        version: VERSION,
        controlPrefix: CONTROL_PREFIX,
        address,
        // Whether the relay actually owns a socket, which is the one fact a browser
        // can not infer: this answer can arrive while the relay failed to bind.
        bound: bound !== undefined,
        port: address.port,
        upstream: config.upstream,
        routes: config.routes,
        tiers: [...new Set(Object.values(config.routes).filter((tier) => tier !== null))],
        startedAt,
        uptimeMs: Date.now() - startedAt,
        error: state.error ?? null,
        metrics: metrics.snapshot(),
      })
    }),

    [`${CONTROL_PREFIX}/targets`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      // The custom table is reported even without an editor: it is our own config,
      // and the page can show (or delete) what is already there.
      const custom = Object.entries(ownTargets()).map(([id, target]) => ({
        id,
        upstream: target.upstream,
        tier: target.tier,
        mount: mountFor(id, target.tier),
        baseURL: baseUrlFor(id, target.tier),
        // Which provider row is currently pointed here, when one is: the link is
        // derived from the live profile rather than stored twice.
        route: null,
      }))
      if (!bridge.available()) {
        sendJson(res, 200, {
          available: false,
          reason: 'configEditor is not available in this Host; create routes by editing the llm-pi-ai providers manually',
          sources: [],
          created: [],
          custom,
        })
        return
      }
      const targets = await bridge.targets()
      for (const entry of custom) {
        const owner = (targets.sources ?? []).find((source) => source.baseURL === entry.baseURL)
        if (owner) entry.route = owner.key
      }
      sendJson(res, 200, {
        available: true,
        ...targets,
        custom,
        // The preset is a Session-level runtime choice, so the page only needs to know
        // what new Sessions inherit and which presets a Session may pick.
        tier: { default: defaultPreset(), presets: PRESET_IDS },
        // What a repair would fill: `false` = never, `null` = only from evidence
        // already declared elsewhere in the profile, object = the fallback map.
        reasoning: {
          fill: config.reasoningEfforts === false ? 'never' : config.reasoningEfforts === null ? 'evidence' : 'default',
          levels: config.reasoningEfforts === false ? [] : Object.keys(config.reasoningEfforts ?? {}),
        },
      })
    }),

    /**
     * The service-tier preset one Session runs on.
     *
     * `GET ?session=<id>` reports what that Session would send right now; `POST` with
     * `{ session, preset }` chooses it, and `preset: null` hands the Session back to
     * the configured default. Nothing here touches a provider row: the relay writes
     * `service_tier`, `provider.sort` or a model variant into the request body on the
     * way out, so switching is a runtime change like `reasoningEffort` rather than a
     * new provider.
     */
    [`${CONTROL_PREFIX}/tier`]: controlRoute(async (req, res) => {
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://relay.invalid').searchParams
        const session = (query.get('session') ?? '').trim()
        const recipe = recipeForSession(session)
        sendJson(res, 200, {
          ok: true,
          session,
          preset: recipe.preset,
          wire: { serviceTier: recipe.serviceTier, sort: recipe.sort, variant: recipe.variant },
          chosen: sessionPresets.get(session) ?? null,
          default: defaultPreset(),
          presets: PRESET_IDS,
        })
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      if (!session) {
        sendJson(res, 400, { error: { message: 'session is required: the Session whose preset is being set' } })
        return
      }
      if (session.length > 128) {
        sendJson(res, 400, { error: { message: 'session must be at most 128 characters' } })
        return
      }
      // `tier` is the tier-era spelling and still maps onto the preset that sends it.
      const raw = typeof body.preset === 'string' ? body.preset : typeof body.tier === 'string' ? body.tier : ''
      const text = raw.trim().toLowerCase()
      const preset = text === '' ? null : normalizePresetId(text)
      if (text !== '' && preset === null) {
        sendJson(res, 400, {
          error: { message: `unknown preset ${JSON.stringify(text)}; use one of ${PRESET_IDS.join(', ')} or null for the profile default` },
        })
        return
      }
      // No config write and no transaction escape: this touches memory only.
      writeSessionPreset(session, preset)
      log('info', 'chose service tier preset for session', { session, preset })
      const recipe = recipeForSession(session)
      sendJson(res, 200, {
        ok: true,
        session,
        preset: recipe.preset,
        wire: { serviceTier: recipe.serviceTier, sort: recipe.sort, variant: recipe.variant },
        chosen: preset,
        default: defaultPreset(),
        presets: PRESET_IDS,
      })
    }),

    // The preset an unchosen Session inherits. Separate from `/tier` because it is a
    // profile preference rather than one Session's choice, and it is the only preset
    // setting that outlives a restart by design.
    [`${CONTROL_PREFIX}/tier/default`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const raw = typeof body.preset === 'string' ? body.preset : typeof body.tier === 'string' ? body.tier : ''
      const text = raw.trim().toLowerCase()
      const preset = text === '' ? 'none' : normalizePresetId(text)
      if (preset === null) {
        sendJson(res, 400, {
          error: { message: `unknown preset ${JSON.stringify(text)}; use one of ${PRESET_IDS.join(', ')} or none` },
        })
        return
      }
      await outsideHmrTransaction(ctx, () => writeDefaultPreset(preset))
      log('info', 'chose the default service tier preset', { preset })
      sendJson(res, 200, { ok: true, default: preset, presets: PRESET_IDS })
    }),

    // There is deliberately no `/routes/twin`: switching a Session's tier must not
    // mint a provider route. The relay writes the tier into the request body, so the
    // only state a switch touches is the Session tier table (`POST /tier`).

    [`${CONTROL_PREFIX}/routes/remove`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const removed = await outsideHmrTransaction(ctx, () =>
        bridge.removeRoute({ name: typeof body.name === 'string' ? body.name : '' }),
      )
      log('info', 'removed provider route', removed)
      sendJson(res, 200, { ok: true, ...removed })
    }),

    // Models on a relay route get no reasoning capability by inheritance (the
    // provider key is new to the installed catalog), so the composer offers no
    // effort levels. This adds the capability a route is missing.
    [`${CONTROL_PREFIX}/routes/repair`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const repaired = await outsideHmrTransaction(ctx, () => bridge.repairRoutes())
      if (repaired.patched.length > 0) log('info', 'added reasoning to provider routes', repaired.patched)
      sendJson(res, 200, { ok: true, ...repaired })
    }),

    // ── live model catalogue ────────────────────────────────────────────────
    // The Models page's own "Fetch available models" is answered from the pi-ai
    // snapshot for any catalog-backed route, before that route's baseURL is even
    // read, so it cannot be corrected from a plugin. These two endpoints are the
    // plugin's own answer: read OpenRouter live, reconcile against what the route
    // already declares, and write it through the normal Loader path.
    [`${CONTROL_PREFIX}/models`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const query = new URL(req.url ?? '/', 'http://relay.invalid').searchParams
      const route = requireRoute(query.get('route'))
      if (!bridge.available()) {
        throw badRequest('live model discovery needs the Host config editor, which this plain Host does not provide')
      }
      const endpoint = await upstreamOf(route, query.get('upstream'))
      if (!endpoint) {
        throw badRequest(`cannot tell where provider route ${JSON.stringify(route)} points: it declares no baseURL and none was supplied`)
      }
      const listing = await fetchListing(endpoint.upstream)
      // `inRoute` is what the picker renders as "already added": the full live
      // catalogue stays visible, and the ids this route already declares are marked
      // so they cannot be added twice.
      const models = annotateLive(listing.models, bridge.declaredModels(route))
      sendJson(res, 200, {
        ok: true,
        route,
        upstream: endpoint.upstream,
        source: endpoint.source,
        live: {
          count: models.length,
          skipped: listing.skipped,
          duplicates: listing.duplicates,
          present: models.filter((model) => model.inRoute === true).length,
        },
        models,
      })
    }),

    // The write takes an explicit selection: nothing is added that the caller did
    // not name, so the model list stays something the user curates rather than
    // something a sync dumps on them.
    [`${CONTROL_PREFIX}/models/add`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const route = requireRoute(body.route)
      const selected = Array.isArray(body.models) ? body.models : []
      const remove = Array.isArray(body.remove) ? body.remove : []
      if (selected.length === 0 && remove.length === 0) {
        throw badRequest('nothing to apply: send models to add, remove to drop, or both')
      }
      if (remove.length > 0 && body.confirmRemove !== true) {
        throw badRequest('removing models needs confirmRemove: true; an untick is a destructive edit')
      }
      if (!bridge.available()) {
        throw badRequest('adding models needs the provider config editor')
      }
      const endpoint = await upstreamOf(route, body.upstream)
      if (!endpoint) {
        throw badRequest(`cannot tell where provider route ${JSON.stringify(route)} points: it declares no baseURL and none was supplied`)
      }
      const catalogue = await fetchListing(endpoint.upstream)
      const result = await outsideHmrTransaction(ctx, () =>
        bridge.addModels({
          route,
          live: catalogue.models,
          selected,
          remove,
        }),
      )
      log('info', 'edited a provider route model list', {
        route,
        added: result.added.length,
        removed: result.removed.length,
        total: result.total,
      })
      sendJson(res, 200, { ok: true, route, upstream: endpoint.upstream, ...result })
    }),

    [`${CONTROL_PREFIX}/targets/register`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const registered = await outsideHmrTransaction(ctx, () => ensureTarget(body))
      log('info', registered.created ? 'registered relay target' : 'reused relay target', registered.summary)
      sendJson(res, 200, { ok: true, ...registered })
    }),

    [`${CONTROL_PREFIX}/targets/remove`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const id = targetId(body.id)
      if (!id || !ownTargets()[id]) {
        sendJson(res, 404, { error: { message: `no relay target named ${JSON.stringify(String(body.id ?? ''))}` } })
        return
      }
      // Refuse while a provider row still points here: removing the mount first
      // would break that row's next request with a 404 from this same listener.
      if (bridge.available()) {
        const live = await bridge.targets()
        const owner = (live.sources ?? []).find((source) => source.baseURL === targetBaseUrl(id))
        if (owner) {
          sendJson(res, 409, {
            error: {
              message: `provider ${JSON.stringify(owner.key)} still routes through this target; detach it first`,
            },
            route: owner.key,
          })
          return
        }
      }
      await outsideHmrTransaction(ctx, () =>
        writeTargets((targets) => {
          delete targets[id]
          return targets
        }),
      )
      log('info', 'removed relay target', { id })
      sendJson(res, 200, { ok: true, id })
    }),

    [`${CONTROL_PREFIX}/routes/attach`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const route = typeof body.route === 'string' ? body.route.trim() : ''
      if (!route) {
        sendJson(res, 400, { error: { message: 'route is required: the provider id to point at this relay' } })
        return
      }
      // A typo must not leave a target behind: the row has to exist first.
      const source = await sourceOf(route)
      if (!source) {
        sendJson(res, 400, { error: { message: `no provider route named ${JSON.stringify(route)}` } })
        return
      }
      // The upstream to remember is what the row points at today. A row already
      // on one of our mounts has no own endpoint left to discover, so it may only
      // be re-tiered — never re-attached to a different target.
      const current = relayMountOf(source.baseURL)
      let request = body
      if (current) {
        const known = ownTargets()[current.targetId]
        if (!known) {
          sendJson(res, 400, {
            error: {
              message:
                `${JSON.stringify(route)} is routed through target ${JSON.stringify(current.targetId)}, ` +
                'which is no longer registered; register the endpoint again or detach the row',
            },
          })
          return
        }
        // A caller that only knows the row sends the mount back as `upstream`; that
        // is not an endpoint, so the registry wins. A real, different endpoint is a
        // re-home request, which is refused below instead of silently applied.
        const supplied = targetUrl(body.upstream)
        const informative = supplied && !supplied.startsWith(`${currentOrigin()}/`)
        if (informative && supplied !== known.upstream) {
          sendJson(res, 400, {
            error: {
              message:
                `${JSON.stringify(route)} is already routed through target ${JSON.stringify(current.targetId)}; ` +
                'detach it before routing it to a different endpoint',
            },
          })
          return
        }
        request = { ...body, upstream: known.upstream }
      }
      // No tier is pinned on the way in: one target serves every tier, and which one a
      // request runs on is decided per Session by the relay.
      // A tier in the body is accepted and ignored (older clients still send one), but it
      // is validated: silently swallowing a typo would teach the caller the wrong thing.
      const suppliedTier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : ''
      if (suppliedTier && !KNOWN_TIERS.includes(suppliedTier)) {
        sendJson(res, 400, {
          error: { message: `unknown service tier ${JSON.stringify(suppliedTier)}; use one of ${KNOWN_TIERS.join(', ')} or no tier` },
        })
        return
      }
      const registered = await outsideHmrTransaction(ctx, () =>
        ensureTarget({ upstream: request.upstream, id: typeof body.id === 'string' ? body.id : undefined }),
      )
      if (current && current.targetId !== registered.target.id) {
        sendJson(res, 400, {
          error: {
            message:
              `${JSON.stringify(route)} is already routed through target ${JSON.stringify(current.targetId)}; ` +
              'detach it before routing it to a different endpoint',
          },
        })
        return
      }
      // The row is pointed at the *bare* per-target mount on purpose: which preset a
      // request applies is the Session's choice, applied by the relay while the body
      // is on its way out. A row per preset would be a provider per preset, which is
      // exactly what the preset feature must never need.
      const baseURL = baseUrlFor(registered.target.id, null)
      const planned = await providerWrite(() => bridge.repointRoute({ route, baseURL }))
      log('info', 'routed provider through the relay', { route, baseURL, changed: planned.changed })
      sendJson(res, 200, { ok: true, route, baseURL, changed: planned.changed, target: registered.target })
    }),

    [`${CONTROL_PREFIX}/routes/detach`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const route = typeof body.route === 'string' ? body.route.trim() : ''
      if (!route) {
        sendJson(res, 400, { error: { message: 'route is required: the provider id to restore' } })
        return
      }
      // `id` is optional: a caller that only knows the row gets it derived from the
      // mount the row currently sits on, which is the only id it can legitimately be.
      const source = await sourceOf(route)
      if (!source) {
        sendJson(res, 400, { error: { message: `no provider route named ${JSON.stringify(route)}` } })
        return
      }
      const mount = relayMountOf(source.baseURL)
      const id = targetId(body.id) ?? mount?.targetId
      const target = id ? ownTargets()[id] : undefined
      if (!target) {
        const known = id
          ? `target ${JSON.stringify(id)} is not registered`
          : `${JSON.stringify(route)} is not routed through a known target`
        sendJson(res, 400, { error: { message: `${known}; nothing to restore` } })
        return
      }
      if (mount && mount.targetId !== id) {
        sendJson(res, 400, {
          error: {
            message:
              `${JSON.stringify(route)} sits on target ${JSON.stringify(mount.targetId)}, not ${JSON.stringify(id)}; ` +
              'refusing to restore it to a foreign endpoint',
          },
        })
        return
      }
      const planned = await providerWrite(() => bridge.restoreRoute({ route, baseURL: target.upstream }))
      log('info', 'restored provider endpoint', { route, baseURL: target.upstream, changed: planned.changed })
      sendJson(res, 200, {
        ok: true,
        route,
        baseURL: target.upstream,
        changed: planned.changed,
        target: { id, upstream: target.upstream, tier: target.tier },
      })
    }),
  }

  /**
   * Dispatch one control request by exact pathname.
   *
   * The table is keyed by the full path, so the same table serves both listeners:
   * the web server's prefix route and the relay's debug copy.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const serveControl = (req, res) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://control.invalid').pathname
    } catch {
      pathname = ''
    }
    const handler = control[pathname]
    if (handler === undefined) {
      sendJson(res, 404, { error: { message: `unknown control endpoint ${pathname}` } })
      return undefined
    }
    return handler(req, res)
  }

  /**
   * The web-server face of the control API: same handlers, on the page's own
   * origin, behind the GUI's own Host/Origin fence.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const controlOnWeb = (req, res) => {
    const rejection = controlRejection(controlConnection(), req)
    if (rejection !== null) {
      sendJson(res, rejection, {
        error: {
          message:
            rejection === 401
              ? 'this page is not authenticated for the control API'
              : 'refused by the Host origin fence',
        },
      })
      return
    }
    void serveControl(req, res)
  }

  /**
   * The live `connection` service, read per request: the route outlives a Host
   * reload, so the fence must follow the service rather than capture it.
   *
   * @returns {unknown}
   */
  function controlConnection() {
    return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  }

  /*
   * Mount the control API on the web server's own origin. The page calling it is
   * then same-origin with the API, so there is no second port to reach, no CORS and
   * no "can this device reach 127.0.0.1" question: behind Tailscale, on another
   * machine, anywhere the GUI itself is reachable, the control API is too.
   *
   * `inject` rather than a plain read: a composition without a web server (a
   * headless Host, the TUI) simply never runs this, and the relay keeps the same
   * endpoints for `curl`. `effect` owns the registration so a live patch reload
   * unregisters before the next mount — registering the same prefix twice throws.
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer ?? (typeof webCtx.get === 'function' ? webCtx.get('webServer') : undefined)
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
      ctx.effect(() =>
        webServer.register({ kind: 'prefix', path: CONTROL_PREFIX, handler: controlOnWeb }),
      )
      log('info', `control API mounted on the web server at ${CONTROL_PREFIX}`)
    })
  }

  /** @type {ReturnType<typeof createRelay>} */
  const relay = createRelay({
    host: config.host,
    port: config.port,
    portFallback: config.portFallback,
    upstream: config.upstream,
    routes: config.routes,
    control,
    version: VERSION,
    log,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    resolveTarget,
    // The tier a bare mount should use for the Session carrying the request. The
    // relay only asks; every choice lives here, in this plugin's own config.
    resolveSessionRecipe: (session) => recipeForSession(session),
    onRecord: (entry) => metrics.record(entry),
  })

  ctx.effect(() => {
    let disposed = false
    /** @type {Promise<{host: string, port: number, origin: string}>|undefined} */
    const started = relay
      .start()
      .then((address) => {
        log(
          'info',
          `relay listening on ${address.origin} → ${config.upstream} (${Object.keys(config.routes).length} mounts)`,
        )
        return address
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        state.error = message
        log('error', `relay failed to start: ${message}`, error)
        // Keep the plugin loaded: the Models card surfaces this error instead of
        // the whole profile failing to boot on a taken port.
        return { host: config.host, port: config.port, origin: originOf(config.host, config.port) }
      })

    // Three settle signals, one debounced pass: a profile write reloads the
    // patches, the settings snapshot moves when a config revision lands, and
    // adding or removing a route changes the adapter topology. Repair is
    // idempotent, so overlapping reasons cost nothing.
    /** @type {Array<(() => void) | undefined>} */
    const unwatch = []
    if (config.autoRepairReasoning) {
      unwatch.push(
        ctx.on('settings/document-updated', () => autoRepair.schedule()),
        ctx.on('app-boot/config-reload', () => autoRepair.schedule()),
        ctx.on('llm/adapters-updated', () => autoRepair.schedule()),
      )
      // A profile that already lost its capability is fixed at startup rather
      // than waiting for the owner's next edit.
      void started.then(() => autoRepair.flush()).catch(() => {})
    }

    // Warn about routes that only work while this plugin runs, so the owner sees
    // it before disabling the plugin breaks their default model.
    void started
      .then(() => bridge.targets())
      .then((targets) => {
        if (disposed) return
        if (targets.created.length > 0) {
          log(
            'warn',
            `${targets.created.length} provider route(s) point at this relay (${targets.created
              .map((route) => route.name)
              .join(', ')}); disabling the plugin will break them until you remove them in Settings → Models`,
          )
        }
      })
      .catch(() => {})

    return () => {
      disposed = true
      for (const off of unwatch) off?.()
      autoRepair.dispose()
      void relay.stop().catch((error) => log('warn', 'relay stop failed', error))
    }
  })
}

/** @param {string} host @param {number} port */
function originOf(host, port) {
  const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${name}:${port}`
}
