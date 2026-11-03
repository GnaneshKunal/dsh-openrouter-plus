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
import { fetchEndpoints, survives } from './lib/endpoints.js'
import {
  PROVIDERS_CACHE_LIMIT,
  PROVIDERS_STATS_TTL_MS,
  PROVIDERS_TTL_MS,
  findProvider,
  groupProviders,
  precisionLevels,
  readProviders,
  tagsOf,
} from './lib/providers.js'
import { createMetrics } from './lib/metrics.js'
import { baseModelId, createRelay } from './lib/proxy.js'
import { createConfigBridge } from './lib/config-bridge.js'
import { MODEL_LISTING_MAX_BYTES, annotateLive, readLiveModels } from './lib/models-sync.js'
import { PRECISION_IDS, normalizePrecision, precisionLabel } from './lib/quantization.js'
import { normalizeReasoningEfforts } from './lib/reasoning.js'
import { createAutoRepair } from './lib/auto-repair.js'
import { readUsageStoreSync, usageStorePath, writeUsageStore, writeUsageStoreSync } from './lib/usage-store.js'

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

/* Kept equal to package.json's version: `/health` reports it and a release commit is the
   one moment this literal and the manifest must agree. */
const VERSION = '0.7.1'

/**
 * How long a burst of relayed calls is coalesced before the usage snapshot is written.
 * A tool-using turn is dozens of requests, and the file is a rollup, not an audit log.
 */
const USAGE_WRITE_DELAY_MS = 5000

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
 *   controlDiagnostics: boolean,
 *   generationLookup: boolean,
 *   autoRepairReasoning: boolean, defaultPreset: string|null,
 *   sessionPresets: Record<string, string>, sessionPresetStamp: Record<string, number>,
 *   precisionFloor: { floor: string, includeUnknown: boolean, allow: string[]|null },
 *   sessionPrecisions: Record<string, { floor: string, includeUnknown: boolean }>,
 *   sessionPrecisionStamp: Record<string, number>,
 *   usageWidget: { enabled: boolean },
 *   providerFacts: ReturnType<typeof normalizeProviderFacts>,
 * }}
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const upstream = typeof config.upstream === 'string' && config.upstream.trim()
    ? config.upstream.trim().replace(/\/+$/, '')
    : DEFAULT_UPSTREAM
  const sessionPresets = normalizeSessionPresets(config.sessionPresets)
  const sessionPrecisions = normalizeSessionPrecisions(config.sessionPrecisions)
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
    // Record control-API timings and log slow calls. Off by default: this plugin also runs
    // where RAM and metered I/O matter, and the failure it explains is one an operator
    // opts into debugging.
    controlDiagnostics: config.controlDiagnostics === true,
    // Reconcile a request the response did not fully describe against OpenRouter's own
    // generation record. On by default: the Responses API names no provider anywhere in
    // its body, so without this the Requests tab's Provider column stays empty forever on
    // such a route. One authenticated GET per affected request, never blocking the caller.
    generationLookup: config.generationLookup !== false,
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
    // The precision floor every unchosen Session inherits. Absent means `any`, which
    // sends nothing at all — a profile that predates this feature reads exactly as it
    // did before, which is the whole compatibility promise.
    precisionFloor: normalizePrecision(config.precisionFloor),
    sessionPrecisions: sessionPrecisions.precisions,
    sessionPrecisionStamp: sessionPrecisions.stamp,
    // Whether the sidebar card is drawn. The flag hides the card, never the numbers:
    // the settings page shows the same spend whether or not the card is on.
    usageWidget: { enabled: normalizeUsageWidget(config.usageWidget) },
    // Which facts a provider row states beside its name, and how many percentiles of a
    // speed it prints. Display only: the relay never reads this, and a fact that is off
    // is simply not painted, not withheld from the listing.
    providerFacts: normalizeProviderFacts(config.providerFacts),
  }
}

/**
 * The sidebar card is on unless it was switched off. A bare `false` is accepted as the
 * whole setting so a hand-edited row reads the same as `{ enabled: false }`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function normalizeUsageWidget(value) {
  if (value === false) return false
  if (isPlainObject(value) && value.enabled === false) return false
  return true
}

/**
 * Which facts a provider row states, and how many percentiles of a speed it prints.
 *
 * Tolerant by design and on by default, one flag per fact: a row that does not mention a
 * fact shows it when the listing reports one, and a fact the listing omits is already
 * dropped row by row — so "on" never prints an empty column, it only stops one appearing
 * late. Only an explicit `false` turns a fact off, which means a hand-edited row that
 * writes `providerFacts: { latency: false }` reads exactly as the page's checkboxes do,
 * and a typo cannot hide a whole column.
 *
 * `percentiles` is a choice rather than a flag: `p50` is the honest single number for both
 * speed fields, and `p50p90` adds the tail. Anything else falls back to `p50`, which is the
 * narrower answer and the one a label can always fit.
 *
 * `sort` is the one field here that is not a fact: it is the order the same list is read in,
 * so it belongs with the vocabulary rather than beside the routing presets — one Apply writes
 * both, and the page that decides what a row says also decides which row comes first.
 *
 * @param {unknown} raw
 * @returns {{
 *   precision: boolean, price: boolean, uptime: boolean, throughput: boolean,
 *   latency: boolean, percentiles: 'p50' | 'p50p90', sort: ReturnType<typeof normalizeProviderSort>,
 * }}
 */
export function normalizeProviderFacts(raw) {
  const facts = isPlainObject(raw) ? raw : {}
  return {
    precision: facts.precision !== false,
    price: facts.price !== false,
    uptime: facts.uptime !== false,
    throughput: facts.throughput !== false,
    latency: facts.latency !== false,
    percentiles: facts.percentiles === 'p50p90' ? 'p50p90' : 'p50',
    sort: normalizeProviderSort(facts.sort),
  }
}

/**
 * The orders an endpoint list may be read in.
 *
 * `default` is the Host's own order — cheapest input first, then output — and is what a
 * listing with no speed facts still reads as. Every other id names one fact, and the fact
 * carries its own direction: throughput and uptime read best-high, the prices and latency
 * best-low, so there is no second "ascending" control to get wrong.
 */
export const PROVIDER_SORTS = Object.freeze([
  'default',
  'throughput',
  'latency',
  'uptime',
  'input',
  'output',
  'cacheRead',
])

/**
 * Normalise a sort id, tolerating anything a hand-edited row may hold.
 * @param {unknown} value
 * @returns {(typeof PROVIDER_SORTS)[number]}
 */
export function normalizeProviderSort(value) {
  const sort = typeof value === 'string' ? value.trim() : ''
  return PROVIDER_SORTS.find((known) => known === sort) ?? 'default'
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
 * How many Sessions keep a chosen precision before the oldest choices are dropped.
 * Same bound as the preset table: both are runtime state keyed by Session id.
 */
export const SESSION_PRECISION_LIMIT = 200

/**
 * Normalise the per-Session precision table. Entries are `{ floor, includeUnknown, at }`
 * objects written by the control API; a bare floor string is accepted too so a
 * hand-edited config still works. Oldest entries are dropped past
 * {@link SESSION_PRECISION_LIMIT}, exactly like the preset table, because a long-lived
 * Host would otherwise grow a row for every Session it ever ran.
 *
 * A floor this build does not know is *dropped* rather than normalised to `any`: a typo
 * must not silently turn a strict floor off, and an absent row simply means the Session
 * inherits the profile default. `any` is a real choice and is kept — it is how a Session
 * opts out of a stricter default.
 *
 * @param {unknown} raw
 * @returns {{
 *   precisions: Record<string, { floor: string, includeUnknown: boolean }>,
 *   stamp: Record<string, number>,
 * }}
 */
export function normalizeSessionPrecisions(raw) {
  if (!isPlainObject(raw)) return { precisions: {}, stamp: {} }
  /** @type {Array<[string, { floor: string, includeUnknown: boolean }, number]>} */
  const kept = []
  for (const [rawId, value] of Object.entries(raw)) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (!id || id.length > 128) continue
    const object = isPlainObject(value) ? value : { floor: value }
    const floor = typeof object.floor === 'string' ? object.floor.trim().toLowerCase() : ''
    if (!PRECISION_IDS.includes(floor)) continue
    const precision = normalizePrecision(object)
    const at = Number.isFinite(object.at) ? Number(object.at) : 0
    kept.push([id, { floor: precision.floor, includeUnknown: precision.includeUnknown }, at])
  }
  kept.sort((a, b) => b[2] - a[2])
  /** @type {Record<string, { floor: string, includeUnknown: boolean }>} */
  const precisions = {}
  /** @type {Record<string, number>} */
  const stamp = {}
  for (const [id, precision, at] of kept.slice(0, SESSION_PRECISION_LIMIT)) {
    precisions[id] = precision
    stamp[id] = at
  }
  return { precisions, stamp }
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
/**
 * Whether the control API records its own timings and logs its slow calls.
 *
 * **Off by default.** This plugin also runs on metered, memory-tight hosts where a
 * diagnostic that costs nothing on a laptop is still cost with no upside — and the
 * failure it explains ("not answering" while the Host is merely busy) is one an operator
 * opts into debugging. On: a bounded ring of 20 entries, no disk, one log line per slow
 * or failed call. Off: a single boolean test per request.
 */
let controlDiagnostics = false

/** @param {unknown} value */
function setControlDiagnostics(value) {
  controlDiagnostics = value === true
}

/**
 * How slow a control-API call has to be before it is worth recording.
 *
 * The page gives up on `/status` after a couple of seconds, and a Host chewing through a
 * turn can be slow to schedule anything else. That is the failure mode this exists to
 * make visible: without it, "not answering" is indistinguishable from a crash, a refusal,
 * or a dead listener.
 */
const CONTROL_SLOW_MS = 1000

/** How many slow or failed control calls to keep for `/status`. */
const CONTROL_TIMING_LIMIT = 20

/**
 * The last slow or failed control calls, oldest first. Reported by `/status` under
 * `control`, so an operator can tell "the Host was busy" from "the route threw".
 *
 * @type {Array<{ at: number, path: string, ms: number, status: number }>}
 */
const controlTimings = []

/** @param {string} path @param {number} ms @param {number} status */
function noteControlTiming(path, ms, status) {
  if (!controlDiagnostics) return
  if (ms < CONTROL_SLOW_MS && status < 500) return
  controlTimings.push({ at: Date.now(), path, ms, status })
  if (controlTimings.length > CONTROL_TIMING_LIMIT) controlTimings.shift()
}

/**
 * The Host logger, when a plugin instance has provided one.
 *
 * `controlRoute` is module-level so the route table can be built at definition time, but
 * the logger only exists once `apply()` has run. A no-op default keeps a route callable
 * before that — and keeps a *logged* failure from becoming an uncaught exception, which
 * is exactly what a direct `log(...)` here used to do.
 *
 * @type {(level: string, message: string, fields?: Record<string, unknown>) => void}
 */
let controlLog = () => {}

/** @param {(level: string, message: string, fields?: Record<string, unknown>) => void} fn */
function setControlLog(fn) {
  controlLog = typeof fn === 'function' ? fn : () => {}
}

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
    /* Nothing is attached at all when the diagnostic is off: one boolean, no listener,
       no clock reading. */
    const measured = controlDiagnostics === true
    const startedAt = measured ? Date.now() : 0
    const path = measured ? (req.url ?? '').split('?')[0] : ''
    if (measured) {
      res.once?.('finish', () => {
        const ms = Date.now() - startedAt
        noteControlTiming(path, ms, res.statusCode)
        if (ms >= CONTROL_SLOW_MS) {
          controlLog('warn', 'control API call was slow', { path, ms, method: req.method })
        }
      })
    }
    try {
      await handler(req, res)
    } catch (error) {
      const status = Number.isInteger(/** @type {any} */ (error)?.status)
        ? /** @type {any} */ (error).status
        : 500
      if (measured) {
        noteControlTiming(path, Date.now() - startedAt, status)
        controlLog('warn', 'control API call failed', {
          path,
          ms: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
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
  // The control-API timing lines have to go somewhere; this is the only place a logger
  // exists, so the module-level route wrapper reads it from here.
  setControlLog(log)
  // Off unless the profile asks for it: see `setControlDiagnostics`.
  setControlDiagnostics(config.controlDiagnostics)

  if (!config.enabled) {
    log('info', 'disabled by config (enabled: false); no listener bound')
    return
  }

  const metrics = createMetrics({ recentLimit: 50 })
  const startedAt = Date.now()

  // ── usage snapshot ───────────────────────────────────────────────────────
  // Money is the one thing this relay cannot recompute later: it comes from the
  // response, so the day buckets are read back before the first call and written on a
  // debounce. A missing or unreadable file simply means "no history yet".
  const usagePath = usageStorePath()
  const persistedUsage = readUsageStoreSync(usagePath)
  if (persistedUsage !== null) {
    metrics.hydrate(persistedUsage)
    /* One line at boot so a restart that restored a log is distinguishable from one that
       started empty; the dialog itself is the visible proof. */
    log('info', 'restored the usage snapshot', {
      days: persistedUsage.days.length,
      recent: persistedUsage.recent?.length ?? 0,
      sessions: persistedUsage.sessions?.length ?? 0,
    })
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let usageWriteTimer = null

  /** Write the day table now: used by the debounce and on dispose. */
  function flushUsage() {
    if (usageWriteTimer !== null) {
      clearTimeout(usageWriteTimer)
      usageWriteTimer = null
    }
    const state = metrics.exportState()
    // Nothing seen yet means nothing to say. This also keeps a Host that never carried
    // a request from creating an empty file in the user's home directory.
    if (state.days.length === 0) return Promise.resolve(true)
    return writeUsageStore(usagePath, state)
  }

  /**
   * Session titles live in the Host's session store, not in the relay: the relay only ever
   * sees the id advertised on the request. Resolving here keeps conversation text out of the
   * persisted usage file, and a Host without the service simply reports no title.
   *
   * The store's surface differs between Host versions (a synchronous `get`, an async one,
   * or a resolver method), so the lookup is deliberately tolerant and its answer is cached:
   * a title changes rarely and the status endpoint is polled every few seconds.
   *
   * @type {Map<string, { title: string, at: number }>}
   */
  const sessionTitles = new Map()

  /** How long a resolved title is trusted before the store is asked again. */
  const SESSION_TITLE_TTL_MS = 60000

  /**
   * How long `/status` may spend refreshing titles before it answers without them.
   *
   * A title is decoration; the counters are the answer. Resolving one is a Host service
   * round trip, and during a turn those are the busiest calls in the process — awaiting
   * every one of them unbounded is how `/status` answered in 86 ms when idle and blew the
   * page's 2.5 s budget exactly when someone was watching a running turn. Whatever a
   * lookup misses here arrives on the next poll; the page polls every few seconds.
   */
  const SESSION_TITLE_WAIT_MS = 600

  /** @param {string} id */
  async function sessionTitleOf(id) {
    if (typeof id !== 'string' || id === '') return ''
    const cached = sessionTitles.get(id)
    if (cached !== undefined && Date.now() - cached.at < SESSION_TITLE_TTL_MS) return cached.title

    /** One service lookup that treats a missing/foreign context as "not provided". */
    const service = (name) => {
      try {
        return typeof ctx.get === 'function' ? (ctx.get(name) ?? ctx[name]) : ctx[name]
      } catch {
        return undefined
      }
    }

    const sessions = service('sessions')
    const query = service('sessionQuery')
    const projections = service('sessionProjections')

    /* The live session, when the registry still has it. Methods differ across Host versions,
       so the known spellings are tried; a registry with only `list()` is scanned instead. */
    let session
    if (sessions !== undefined && sessions !== null) {
      for (const method of ['get', 'session', 'resolve', 'find', 'read', 'load', 'peek']) {
        if (typeof sessions[method] !== 'function') continue
        try {
          session = await sessions[method](id)
        } catch {
          session = undefined
        }
        if (session !== undefined && session !== null) break
      }
      if ((session === undefined || session === null) && typeof sessions.list === 'function') {
        try {
          const rows = await sessions.list()
          if (Array.isArray(rows)) session = rows.find((row) => (row?.header?.id ?? row?.id) === id)
        } catch {
          session = undefined
        }
      }
    }

    let title = ''
    /* 1. The name the sidebar shows is folded from `session/title` events in the log, and
          `sessionQuery.readTitleSnapshot` is the Host service that folds it. */
    if (query !== undefined && query !== null && typeof query.readTitleSnapshot === 'function') {
      try {
        const snapshot = await query.readTitleSnapshot(id)
        /* `readTitleSnapshot` answers `{ session, title?: SessionTitleSnapshot }`, and the
           snapshot itself is `{ title, messageSeqs, source, eventSeq, updatedAt }` — the
           text is one level down. `readTitle` is the same object, so both shapes are read. */
        const value = snapshot?.title?.title ?? snapshot?.title ?? snapshot?.session?.title
        if (typeof value === 'string') title = value
      } catch {
        title = ''
      }
    }
    /* 2. The same title as a projection (`key: "title"`), which is what the live shell reads. */
    if (title === '' && projections !== undefined && projections !== null && session !== undefined && session !== null) {
      try {
        const snapshot = await projections.snapshot?.(session, ['title'])
        const projected = snapshot?.values?.title
        if (typeof projected === 'string') title = projected
      } catch {
        /* a projection generation may be replacing itself */
      }
    }
    /* 3. A header title, for a Host that keeps one. */
    if (title === '' && session !== undefined && session !== null) {
      const value = session?.header?.title
        ?? session?.title
        ?? session?.header?.name
        ?? session?.name
      if (typeof value === 'string') title = value
    }

    sessionTitles.set(id, { title, at: Date.now() })
    if (sessionTitles.size > 400) {
      const oldest = [...sessionTitles.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [key] of oldest.slice(0, sessionTitles.size - 400)) sessionTitles.delete(key)
    }
    return title
  }

  /**
   * The status copy of the metrics, with session titles attached where the Host knows them.
   * Titles are resolved once per unique id per poll; the arrays themselves are copies.
   */
  async function usageSnapshot() {
    const snapshot = metrics.snapshot()
    const bySession = snapshot.bySession ?? []
    const recent = snapshot.recent ?? []
    const ids = new Set()
    for (const row of bySession) if (row.session !== null) ids.add(row.session)
    for (const row of recent) if (row.sessionId !== null) ids.add(row.sessionId)
    const titles = new Map()
    const stale = []
    for (const id of [...ids].slice(0, 80)) {
      const cached = sessionTitles.get(id)
      if (cached !== undefined) titles.set(id, cached.title)
      if (cached === undefined || Date.now() - cached.at >= SESSION_TITLE_TTL_MS) stale.push(id)
    }
    if (stale.length > 0) {
      await Promise.race([
        Promise.all(stale.map(async (id) => {
          titles.set(id, await sessionTitleOf(id))
        })),
        new Promise((resolve) => setTimeout(resolve, SESSION_TITLE_WAIT_MS)),
      ])
    }
    return {
      ...snapshot,
      bySession: bySession.map((row) => ({ ...row, title: titles.get(row.session) ?? '' })),
      recent: recent.map((row) => (row.sessionId === null
        ? row
        : { ...row, sessionTitle: titles.get(row.sessionId) ?? '' })),
    }
  }

  /** Coalesce a burst of calls into one write; a tool-using turn is dozens of requests. */
  function scheduleUsageWrite() {
    if (usageWriteTimer !== null) return
    usageWriteTimer = setTimeout(() => {
      usageWriteTimer = null
      flushUsage().catch(() => {
        // A failed write is not a failed request: the numbers stay in memory for the
        // next flush.
      })
    }, USAGE_WRITE_DELAY_MS)
    usageWriteTimer.unref?.()
  }

  /* Disposal is synchronous, and an exiting process does not await a floating promise. This is
     the one write that must land before the Host is gone, so it blocks until the rename lands —
     otherwise the final requests of a session are lost exactly when a restart is what the user is
     doing, which reads as "everything resets". */
  ctx.effect(() => () => {
    if (usageWriteTimer !== null) {
      clearTimeout(usageWriteTimer)
      usageWriteTimer = null
    }
    const state = metrics.exportState()
    if (state.days.length > 0) writeUsageStoreSync(usagePath, state)
  })

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

  /**
   * The upstream endpoint each Session pinned, by OpenRouter slug (`relace/fp4`).
   *
   * A third per-Session lever beside the preset and the floor, and memory-only for the
   * same reason as both: it is runtime state, and a config write per switch would reload
   * this plugin mid-conversation. It is *not* merged with the other two — a pin subsumes
   * them, and the chip disables their cells while one is set — so this table is the only
   * place the choice lives.
   *
   * @type {Map<string, { tag: string, name: string, tier: string, precision: string }>}
   */
  const sessionPins = new Map()

  /** When each pin was chosen, for bounded eviction. @type {Map<string, number>} */
  const sessionPinStamp = new Map()

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
   * Persist the sidebar-card flag. Like the default preset it is a preference, so it
   * belongs in this plugin's own row and survives a restart with the profile.
   *
   * @param {boolean} enabled
   */
  async function writeUsageWidget(enabled) {
    const { editor, entry, current } = ownRow()
    await editor.edit(entry, (currentConfig) => ({
      ...(isPlainObject(currentConfig) ? currentConfig : current),
      usageWidget: { enabled },
    }))
  }

  /**
   * Persist the provider-facts display preferences.
   *
   * Another preference in the plugin's own row, for the same reason as the sidebar flag:
   * it decides what a row *shows*, never what the relay sends, so nothing on the request
   * path has any use for it. The object written is the normalised one, so the row reads
   * back with five named flags, a percentile choice and a sort on the next boot instead of
   * whatever subset the page sent.
   *
   * @param {ReturnType<typeof normalizeProviderFacts>} next
   */
  async function writeProviderFacts(next) {
    const { editor, entry, current } = ownRow()
    await editor.edit(entry, (currentConfig) => ({
      ...(isPlainObject(currentConfig) ? currentConfig : current),
      providerFacts: next,
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
   * The precision floor rides the same answer, because it is decided from the same two
   * facts — which Session, which model — and the relay applies both in one pass. The
   * floor id is always reported; `quantizations` is the include list that may actually
   * be sent, which is `null` until admission control has confirmed the model still has
   * an endpoint inside it.
   *
   * @param {unknown} session
   * @param {unknown} model  the model the request named, if it named one
   */
  function recipeForSession(session, model) {
    const preset = presetForSession(session)
    const wire = PRESET_WIRE[preset] ?? PRESET_WIRE.none
    const precision = precisionForSession(session)
    const pin = pinForSession(session)
    return {
      preset,
      serviceTier: wire.serviceTier,
      sort: wire.sort,
      variant: wire.variant,
      precision: precision.floor,
      quantizations: admittedQuantizations(precision, model),
      // Admitted, not merely chosen: the relay writes `only` from this field, and a slug
      // the listing does not back would exclude every endpoint. `pinChosen` is what the
      // page and the response header report, so a withheld pin is visible rather than
      // looking like nobody asked.
      pin: admittedPin(pin === null ? null : pin.tag, model),
      pinChosen: pin === null ? null : pin.tag,
    }
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
   * The endpoint one Session pinned, or null.
   *
   * The record carries the display facts (`name`, `tier`, `precision`) beside the slug
   * because they were known when the pin was chosen: a Session's chip has to paint
   * "Relace · fp4" on load, and re-reading a 47 KB listing to recover the name of a slug
   * this process already resolved would make the chip depend on a network round trip for
   * something it decided itself. They are read as a *report* of the choice, never as the
   * thing that routes — the relay pins by `tag` alone.
   *
   * @param {unknown} session
   * @returns {{ tag: string, name: string, tier: string, precision: string } | null}
   */
  function pinForSession(session) {
    const key = typeof session === 'string' ? session.trim() : ''
    if (key === '') return null
    const chosen = sessionPins.get(key)
    if (!isPlainObject(chosen)) return null
    const tag = typeof chosen.tag === 'string' ? chosen.tag.trim() : ''
    if (tag === '') return null
    return {
      tag,
      name: typeof chosen.name === 'string' && chosen.name !== '' ? chosen.name : tag.split('/')[0],
      tier: typeof chosen.tier === 'string' && chosen.tier !== '' ? chosen.tier : 'standard',
      precision: typeof chosen.precision === 'string' && chosen.precision !== '' ? chosen.precision : 'unknown',
    }
  }

  /**
   * Record one Session's pinned endpoint — or clear it, which hands that Session back to
   * its preset and floor (both of which the chip disabled while the pin was set, so
   * clearing restores exactly what was there before).
   *
   * Memory only, like {@link writeSessionPreset} and for the same reason.
   *
   * @param {string} session
   * @param {{ tag: string, name: string, tier: string, precision: string } | null} pin
   */
  function writeSessionPin(session, pin) {
    if (pin === null) {
      sessionPins.delete(session)
      sessionPinStamp.delete(session)
      return
    }
    sessionPins.set(session, pin)
    sessionPinStamp.set(session, Date.now())
    // Bounded eviction, as for presets: a long-lived Host must not grow a table of every
    // Session it ever ran.
    if (sessionPins.size > SESSION_PRESET_LIMIT) {
      const ordered = [...sessionPinStamp.entries()].sort((a, b) => a[1] - b[1])
      for (const [key] of ordered.slice(0, sessionPins.size - SESSION_PRESET_LIMIT)) {
        sessionPins.delete(key)
        sessionPinStamp.delete(key)
      }
    }
  }

  /**
   * The precision floor each Session chose, mirroring the preset table above: memory
   * only, because it is a runtime choice like `reasoningEffort`, and a config write per
   * switch would reload this plugin mid-conversation.
   *
   * @type {Map<string, { floor: string, includeUnknown: boolean }>}
   */
  const sessionPrecisions = new Map(Object.entries(config.sessionPrecisions ?? {}))

  /** When each choice was made, for bounded eviction. @type {Map<string, number>} */
  const sessionPrecisionStamp = new Map(Object.entries(config.sessionPrecisionStamp ?? {}))

  /** The floor a Session runs on when it has chosen nothing. */
  function defaultPrecision() {
    return normalizePrecision(config.precisionFloor)
  }

  /**
   * The precision one Session runs on: its own choice, else the configured default.
   * An unknown/blank Session gets the default — a proxy hop with no Session is still
   * the correct answer, never an error.
   *
   * @param {unknown} session
   * @returns {{ floor: string, includeUnknown: boolean, allow: string[] | null }}
   */
  function precisionForSession(session) {
    const key = typeof session === 'string' ? session.trim() : ''
    if (key !== '') {
      const chosen = sessionPrecisions.get(key)
      if (chosen !== undefined) return normalizePrecision(chosen)
    }
    return defaultPrecision()
  }

  /**
   * Record one Session's floor — or clear it, which hands that Session back to the
   * configured default. `null` is a clear, not a floor: `any` is how a Session says
   * "no floor for me", and it must stay distinguishable from "no choice".
   *
   * @param {string} session
   * @param {{ floor: string, includeUnknown: boolean } | null} precision
   */
  function writeSessionPrecision(session, precision) {
    if (precision === null) {
      sessionPrecisions.delete(session)
      sessionPrecisionStamp.delete(session)
      return
    }
    sessionPrecisions.set(session, { floor: precision.floor, includeUnknown: precision.includeUnknown })
    sessionPrecisionStamp.set(session, Date.now())
    if (sessionPrecisions.size > SESSION_PRECISION_LIMIT) {
      const ordered = [...sessionPrecisionStamp.entries()].sort((a, b) => a[1] - b[1])
      for (const [key] of ordered.slice(0, sessionPrecisions.size - SESSION_PRECISION_LIMIT)) {
        sessionPrecisions.delete(key)
        sessionPrecisionStamp.delete(key)
      }
    }
  }

  // ── precision admission control ──────────────────────────────────────────
  // The one rule that makes a floor safe to ship: `provider.quantizations` is a hard
  // include list, so if no endpoint of the model matches it the request *fails*
  // upstream instead of falling back. A floor is therefore only attached once this
  // process has seen that at least one endpoint survives it, which it learns from the
  // public, keyless endpoint listing (lib/endpoints.js).
  //
  // The lookup never runs on the request path. A miss sends the request unfiltered,
  // counts a bypass and warms the cache for the next one: one unfiltered turn per
  // model per TTL is cheaper than stalling every turn on a public API, and much
  // cheaper than a 404. `any` reads nothing and counts nothing, so an untouched
  // profile behaves exactly as it did before this feature existed.

  /** How long one endpoint listing is trusted before it is read again. */
  const ENDPOINTS_TTL_MS = 10 * 60 * 1000

  /** How many models keep a listing. Same order of magnitude as the Session tables. */
  const ENDPOINTS_CACHE_LIMIT = 200

  /** How many models the bypass table reports; a client can name any model id at all. */
  const FLOOR_BYPASS_MODEL_LIMIT = 40

  /**
   * What the last endpoint listing said about one model, and when it was read.
   * An empty `levels` is a real, cached answer ("no listing", or no endpoints) so a
   * model that cannot be filtered is not re-read on every single request.
   *
   * `tags` rides along because a pin needs a different question answered from the same
   * read: the floor asks *which precisions* are out there, a pin asks *which endpoints*.
   * Both are answered from one listing, so one public GET serves both features and a
   * pinned Session pays nothing extra on the request path.
   *
   * @type {Map<string, { at: number, levels: Set<string>, tags: Set<string> }>}
   */
  const endpointLevels = new Map()

  /** In-flight reads, keyed by model: one public GET per model at a time. @type {Map<string, Promise<void>>} */
  const endpointReads = new Map()

  /** Requests a floor was configured for but no filter was sent, process-wide. */
  let floorBypassed = 0

  /** The same count per model, bounded. @type {Map<string, number>} */
  const floorBypassedByModel = new Map()

  /**
   * Remember one model's precisions and endpoint slugs, with bounded eviction. The
   * timestamp is what makes this a TTL cache rather than a permanent claim about a model:
   * OpenRouter adds and removes endpoints, and a stale listing is the difference between
   * routing correctly and excluding every provider — or pinning one that is gone.
   *
   * @param {string} model
   * @param {Set<string>} levels
   * @param {Set<string>} tags
   */
  function rememberEndpoints(model, levels, tags) {
    endpointLevels.set(model, { at: Date.now(), levels, tags })
    if (endpointLevels.size > ENDPOINTS_CACHE_LIMIT) {
      const ordered = [...endpointLevels.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [key] of ordered.slice(0, endpointLevels.size - ENDPOINTS_CACHE_LIMIT)) {
        endpointLevels.delete(key)
      }
    }
  }

  /**
   * Count one request whose floor was not sent. The per-model table is bounded because
   * the model id is client-supplied: without a cap a script could grow this Map without
   * end, and the counter is only useful for the handful of models a Session actually
   * runs on.
   *
   * @param {string} model
   */
  function noteFloorBypassed(model) {
    floorBypassed += 1
    if (model === '') return
    floorBypassedByModel.set(model, (floorBypassedByModel.get(model) ?? 0) + 1)
    if (floorBypassedByModel.size > FLOOR_BYPASS_MODEL_LIMIT) {
      const ordered = [...floorBypassedByModel.entries()].sort((a, b) => a[1] - b[1])
      for (const [key] of ordered.slice(0, floorBypassedByModel.size - FLOOR_BYPASS_MODEL_LIMIT)) {
        floorBypassedByModel.delete(key)
      }
    }
  }

  /** The `/status` copy of the bypass counter, busiest model first. */
  function floorBypassedSnapshot() {
    return {
      count: floorBypassed,
      byModel: [...floorBypassedByModel.entries()]
        .map(([model, count]) => ({ model, count }))
        .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
    }
  }

  /**
   * Read one model's endpoint listing in the background.
   *
   * Single-flight per model: a burst of requests for the same uncached model must not
   * become a burst of public GETs. A failed read is remembered as "no known levels" for
   * the same TTL instead of being retried on every request — a model that has no
   * listing (another provider's namespace, a name OpenRouter does not route) must not
   * turn every turn into a fetch.
   *
   * @param {string} model
   */
  function warmEndpoints(model) {
    if (endpointReads.has(model)) return
    // Exactly one line per model per TTL: this only runs on a miss (a fresh cache never
    // gets here), and the single-flight guard above keeps a burst to one read. Without
    // it a cold bypass is invisible — the body simply goes out unfiltered.
    log('info', 'precision floor withheld while the endpoint listing is read', { model })
    const read = fetchEndpoints(config.upstream, model)
      .then((listing) => {
        // `tagsOf` reads any row carrying a `tag`, which the admission listing's rows do.
        rememberEndpoints(model, listing.levels, tagsOf(listing.endpoints))
      })
      .catch((error) => {
        rememberEndpoints(model, new Set(), new Set())
        log(
          'warn',
          'could not read the endpoint listing; the precision floor and any provider pin are bypassed for this model',
          { model, reason: error instanceof Error ? error.message : String(error) },
        )
      })
      .finally(() => {
        endpointReads.delete(model)
      })
    endpointReads.set(model, read)
  }

  /**
   * The include list this request may send, or `null` when it must send none.
   *
   * This *is* the safety rule of the feature, so it is worth reading as one sentence:
   * a floor is sent only if the cached listing says an endpoint survives it. Everything
   * else — a floor of `any`, an unknown model, an unread or stale listing, a model whose
   * endpoints all sit below the floor — resolves to `null`, which makes the request go
   * out exactly as the client wrote it. The function is synchronous on purpose: the
   * relay awaits whatever the resolver returns, and the request path must never wait on
   * this fetch.
   *
   * @param {{ floor: string, allow: string[] | null }} precision
   * @param {unknown} model
   * @returns {string[] | null}
   */
  function admittedQuantizations(precision, model) {
    // `any` is not a floor: no read, no filter, and nothing to report as bypassed.
    if (precision.allow === null) return null
    const wanted = typeof model === 'string' ? baseModelId(model).trim() : ''
    // Without a model there is nothing to admit against; a body with no model is not a
    // completion request, so it is not counted either.
    if (wanted === '') return null
    // Every model this plugin can filter is `<author>/<slug>`. Anything else (a
    // single-segment id on another provider's upstream) has no OpenRouter listing to
    // read, so the floor stays bypassed without warming anything.
    if (!wanted.includes('/')) {
      noteFloorBypassed(wanted)
      return null
    }

    const cached = endpointLevels.get(wanted)
    if (cached !== undefined && Date.now() - cached.at < ENDPOINTS_TTL_MS) {
      if (survives(precision.allow, cached.levels)) return precision.allow
      // Known, and nothing in it survives: sending the list would exclude every
      // provider, so this request goes out unfiltered on purpose.
      noteFloorBypassed(wanted)
      return null
    }

    noteFloorBypassed(wanted)
    warmEndpoints(wanted)
    return null
  }

  /**
   * The pinned slug this request may send, or `null` when it must pin nothing.
   *
   * The same rule as the floor, for the same reason, one field over: `only` is an
   * allowlist, so a slug the model no longer lists would exclude every endpoint and fail
   * upstream instead of falling back. A pin is therefore attached only once this process
   * has seen that tag in the cached listing; everything else — no pin, no model, a miss,
   * a stale or empty listing, a slug that has since disappeared — resolves to `null` and
   * the request goes out on the Session's own preset.
   *
   * Synchronous on purpose: the relay awaits whatever the resolver returns and the
   * request path must never wait on a public GET, exactly as with the floor.
   *
   * @param {string | null} pin the slug this Session chose, if any
   * @param {unknown} model the model the request named, if it named one
   * @returns {string | null}
   */
  function admittedPin(pin, model) {
    if (pin === null) return null
    const wanted = typeof model === 'string' ? baseModelId(model).trim() : ''
    // No model, or an id on another provider's namespace: nothing to admit against, and
    // no OpenRouter listing to read. The pin stays withheld rather than guessing.
    if (wanted === '' || !wanted.includes('/')) return null

    const cached = endpointLevels.get(wanted)
    if (cached !== undefined && Date.now() - cached.at < ENDPOINTS_TTL_MS) {
      if (cached.tags.has(pin)) return pin
      // Warm cache and the slug is gone: this is the interesting case, because the menu
      // still offers it and only a log can say why the request was not pinned.
      log('info', 'provider pin withheld: this model no longer lists that endpoint', {
        model: wanted,
        pin,
      })
      return null
    }

    warmEndpoints(wanted)
    return null
  }

  // ── the provider menu's listing ──────────────────────────────────────────
  // Choosing a pin needs a question the request path never asks: not "does anything
  // survive this filter" but "what are all the endpoints, and what does each cost and
  // report". That listing is the same GET, parsed wider (lib/providers.js) and cached
  // apart from the admission cache above — this one holds tens of kilobytes per model,
  // is read when an operator opens the menu, and is never *consulted* by a request.
  // Keeping them separate is what lets admission stay synchronous and cheap.
  //
  // There is one exception, and it is a warm-up rather than a read: the speed fields are
  // populated only when the GET is authenticated, so a relayed request that carried the
  // caller's key reads the listing for the model it named (see `onModelSeen` below) and
  // leaves it here. That read is fire-and-forget, so no request ever waits on it — the
  // point is only that the menu opened afterwards has numbers in it.

  /**
   * One model's rows, and whether the read that produced them carried a key.
   *
   * `authed` decides two things beyond what is stored: a listing with speed outlives the
   * row TTL (see {@link PROVIDERS_STATS_TTL_MS}), and an anonymous read may not replace it
   * while it is inside that window. Without that second rule a menu refresh would keep
   * replacing the only rows that carry speed with identical rows that do not, and every
   * open would throw the numbers away.
   *
   * @type {Map<string, { at: number, providers: unknown[], authed: boolean }>}
   */
  const providerListings = new Map()

  /**
   * In-flight reads, keyed by {@link providerReadKey}: one GET per model and kind at a
   * time. An authenticated caller must never join an anonymous flight, or it would be
   * handed exactly the rows whose speed fields are null.
   *
   * @type {Map<string, Promise<void>>}
   */
  const providerReads = new Map()

  /**
   * The in-flight key for one read: the model, and whether the read is authenticated.
   *
   * Serialised as a pair rather than glued together with a separator, so no model id —
   * however odd — can name the other kind's flight.
   *
   * @param {string} model
   * @param {boolean} authed
   */
  function providerReadKey(model, authed) {
    return JSON.stringify([model, authed])
  }

  /**
   * Remember one model's provider rows, with bounded eviction.
   *
   * An empty array is a real, cached answer — the read was attempted and failed — so a
   * model whose listing 502s is not re-read on every menu open. The menu shows "no
   * providers" instead, which is the truth.
   *
   * An anonymous read does not replace an authenticated one while that one is still within
   * {@link PROVIDERS_STATS_TTL_MS}: the rows would come back identical except for the
   * speed, so the replacement would trade facts for a freshness those facts do not have to
   * satisfy. Past that window the numbers have rolled anyway and either read is as honest
   * as the other. An entry with no rows is exempt: a failed read has no numbers to protect,
   * and holding the menu to it for half an hour would turn one bad read into a menu that
   * never retries.
   *
   * @param {string} model
   * @param {unknown[]} providers
   * @param {boolean} authed  whether the read that produced these rows carried a key
   */
  function rememberProviders(model, providers, authed) {
    const existing = providerListings.get(model)
    /* A failed read may not replace rows that are still fresh. Before the warm-up existed
       this could not happen — a read only ran when the cache was empty — but an authenticated
       read deliberately runs *through* a fresh anonymous entry to upgrade it, so a rejected
       one (a 429, a blip on the endpoints API) would otherwise blank a working menu for the
       whole row TTL. An entry that is already stale is still replaced by the failure, which is
       what keeps a bad read from being retried on every menu open. */
    if (
      providers.length === 0 &&
      existing !== undefined &&
      existing.providers.length > 0 &&
      Date.now() - existing.at < PROVIDERS_TTL_MS
    ) {
      return
    }
    if (
      authed !== true &&
      existing?.authed === true &&
      existing.providers.length > 0 &&
      Date.now() - existing.at < PROVIDERS_STATS_TTL_MS
    ) {
      return
    }
    providerListings.set(model, { at: Date.now(), providers, authed: authed === true })
    if (providerListings.size > PROVIDERS_CACHE_LIMIT) {
      const ordered = [...providerListings.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [key] of ordered.slice(0, providerListings.size - PROVIDERS_CACHE_LIMIT)) {
        providerListings.delete(key)
      }
    }
  }

  /**
   * One model's listing if it is still usable, else null.
   *
   * Two windows: the row TTL for any listing, and the longer stats window for one read
   * with a key, whose speed numbers are a rolling 30-minute average and so still describe
   * the window a fresh read would. The longer window is for rows that carry that report —
   * an empty answer is a failed read, and it stays cached for the ordinary TTL so a bad
   * read cannot keep the menu blank for half an hour.
   */
  function cachedProviders(model) {
    const cached = providerListings.get(model)
    if (cached === undefined) return null
    const age = Date.now() - cached.at
    if (age < PROVIDERS_TTL_MS) return cached
    return cached.authed === true && cached.providers.length > 0 && age < PROVIDERS_STATS_TTL_MS
      ? cached
      : null
  }

  /**
   * Read one model's provider listing, waiting for it when it is not cached.
   *
   * Unlike the admission read this one *is* awaited, because the answer is the response —
   * a menu with no rows is worse than a slow one. Single-flight, so a page that asks for
   * the same model twice (a reload, two tabs) still costs one GET.
   *
   * `authorization` is the caller's own key, forwarded verbatim for the one read and
   * stored nowhere. It does not make the read slower to answer: an anonymous entry is
   * still an answer to an anonymous question, but not to an authenticated one — those rows
   * have the speed fields nulled — so an authed call reads through and *upgrades* the
   * entry instead of joining it. That upgrade is what keeps a menu opened right after a
   * request from showing a warm listing with no numbers in it.
   *
   * @param {string} model
   * @param {string | null} [authorization]
   * @returns {Promise<{ providers: unknown[], fetchedAt: number, cached: boolean, error?: string }>}
   */
  async function providerListing(model, authorization = null) {
    const authed = typeof authorization === 'string' && authorization.trim() !== ''
    const fresh = cachedProviders(model)
    if (fresh !== null && (!authed || fresh.authed === true)) {
      return { providers: fresh.providers, fetchedAt: fresh.at, cached: true }
    }
    const key = providerReadKey(model, authed)
    if (!providerReads.has(key)) {
      const read = readProviders(config.upstream, model, authed ? { authorization } : {})
        .then((listing) => {
          rememberProviders(model, listing.providers, authed)
          /* The same GET answers both questions, so it seeds both caches. Without this the
             two readers would cost two public GETs per model per TTL — and, worse, the
             first request after a pin would be *unpinned*, because admission would still
             consider the listing unread. Opening the menu now admits a floor too, which is
             a strict improvement for the other feature. */
          if (listing.providers.length > 0) {
            rememberEndpoints(model, precisionLevels(listing.providers), tagsOf(listing.providers))
          }
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error)
          rememberProviders(model, [], authed)
          log('warn', 'could not read the provider listing for the menu', { model, reason })
        })
        .finally(() => {
          providerReads.delete(key)
        })
      providerReads.set(key, read)
    }
    await providerReads.get(key)
    const after = cachedProviders(model)
    if (after === null) return { providers: [], fetchedAt: Date.now(), cached: false, error: 'the listing was not readable' }
    return { providers: after.providers, fetchedAt: after.at, cached: false }
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

  /**
   * Validate and normalise a floor a caller asked to set.
   *
   * A typo is refused instead of being normalised: {@link normalizePrecision} falls
   * back to `any`, which would turn "no 4-bit" into "no filter" and report success —
   * the one failure mode this feature must not have. Boot-time config keeps the
   * tolerant behaviour on purpose, because refusing to start the relay over a stale key
   * is worse than ignoring it.
   *
   * @param {unknown} raw a bare floor id, or `{ floor, includeUnknown }`
   * @returns {{ floor: string, includeUnknown: boolean, allow: string[] | null }}
   */
  function precisionInput(raw) {
    const object = isPlainObject(raw) ? raw : { floor: raw }
    const floor = typeof object.floor === 'string' ? object.floor.trim().toLowerCase() : ''
    if (!PRECISION_IDS.includes(floor)) {
      throw badRequest(`unknown precision floor ${JSON.stringify(floor)}; use one of ${PRECISION_IDS.join(', ')}`)
    }
    if (object.includeUnknown !== undefined && typeof object.includeUnknown !== 'boolean') {
      throw badRequest('includeUnknown must be a boolean')
    }
    return normalizePrecision(
      typeof object.includeUnknown === 'boolean' ? { floor, includeUnknown: object.includeUnknown } : { floor },
    )
  }

  /**
   * Persist the precision floor every unchosen Session inherits.
   *
   * Written into this plugin's own row for the same reason the default preset is: it is
   * a preference, not a request property, so the next request reads it straight from the
   * reloaded config instead of from memory that dies with the process.
   *
   * @param {{ floor: string, includeUnknown: boolean }} precision
   */
  async function writeDefaultPrecision(precision) {
    const { editor, entry, current } = ownRow()
    await editor.edit(entry, (currentConfig) => ({
      ...(isPlainObject(currentConfig) ? currentConfig : current),
      precisionFloor: { floor: precision.floor, includeUnknown: precision.includeUnknown },
    }))
  }

  const control = {
    [`${CONTROL_PREFIX}/health`]: controlRoute((req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      sendJson(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - startedAt })
    }),

    [`${CONTROL_PREFIX}/status`]: controlRoute(async (req, res) => {
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
        /* Present only when `controlDiagnostics` is on: the last slow or failed control
           calls, so "not answering" can be told apart from a crash. Absent by default. */
        ...(controlDiagnostics
          ? { control: { slowMs: CONTROL_SLOW_MS, recent: [...controlTimings] } }
          : {}),
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
        // The flag the sidebar card reads. It is part of /status rather than a separate
        // round trip because the card already polls this endpoint.
        usageWidget: config.usageWidget,
        // What the composer chip and the settings page read for the precision floor:
        // the default every unchosen Session inherits, and whether any request went out
        // with a configured floor withheld. A floor that is never honoured must be
        // visible somewhere, or it looks like it works.
        precision: {
          default: defaultPrecision(),
          floorBypassed: floorBypassedSnapshot(),
        },
        metrics: await usageSnapshot(),
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

    // The floor an unchosen Session inherits. A preference, so it is the one precision
    // setting that writes the profile row — the same path `/tier/default` takes.
    [`${CONTROL_PREFIX}/precision/default`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const precision = body.precision === undefined || body.precision === null
        ? normalizePrecision('any')
        : precisionInput(body.precision)
      await outsideHmrTransaction(ctx, () => writeDefaultPrecision(precision))
      log('info', 'chose the default precision floor', { precision: precisionLabel(precision.floor) })
      sendJson(res, 200, { ok: true, default: precision, floors: PRECISION_IDS })
    }),

    /**
     * The precision floor one Session runs on.
     *
     * A sibling of `/tier` rather than a field of it: a preset is an outcome (a tier, a
     * comparator, a slug) while a floor constrains which endpoints that outcome may pick
     * from, so the chip sets them independently and either one alone is a meaningful
     * request. `GET ?session=<id>` reports the floor in force — `inherited` says whether
     * it came from this Session or the profile — and `POST { session, precision }`
     * chooses it, with an absent or `null` precision handing the Session back to the
     * default. Memory only, like `/tier`: a switch must not reload the plugin
     * mid-conversation.
     */
    [`${CONTROL_PREFIX}/precision`]: controlRoute(async (req, res) => {
      const answer = (session) => {
        const chosen = sessionPrecisions.get(session)
        return {
          ok: true,
          session,
          // `allow` is the materialised wire list, null for `any`: "sends nothing" is a
          // value the page renders, not a missing field.
          precision: precisionForSession(session),
          inherited: chosen === undefined,
          source: chosen === undefined ? 'default' : 'session',
          chosen: chosen ?? null,
          default: defaultPrecision(),
          floors: PRECISION_IDS,
        }
      }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://relay.invalid').searchParams
        sendJson(res, 200, answer((query.get('session') ?? '').trim()))
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      if (!session) {
        sendJson(res, 400, { error: { message: 'session is required: the Session whose precision floor is being set' } })
        return
      }
      if (session.length > 128) {
        sendJson(res, 400, { error: { message: 'session must be at most 128 characters' } })
        return
      }
      // Absent/null clears the choice; a bare floor id is accepted too, because a curl
      // is not the picker. No config write and no transaction escape: memory only.
      const precision = body.precision === undefined || body.precision === null
        ? null
        : precisionInput(body.precision)
      writeSessionPrecision(session, precision)
      log('info', 'chose a precision floor for session', {
        session,
        precision: precision === null ? null : precisionLabel(precision.floor),
      })
      sendJson(res, 200, answer(session))
    }),

    /**
     * The endpoints one model can be pinned to.
     *
     * The menu's whole data source: one row per OpenRouter endpoint, grouped the way the
     * model page groups them (standard, flex, priority, and the ones it will not route
     * to), each carrying the slug a pin names plus the price and uptime that make the
     * choice legible. Read on demand and cached for {@link PROVIDERS_TTL_MS} — this is the
     * one listing in this plugin that is display rather than admission.
     *
     * A read that fails answers 200 with an empty list and an `error` rather than a 502:
     * the menu then says "no providers", which is something an operator can act on, and a
     * failure that repeated on every open would be worse than one quiet empty answer. The
     * page treats an empty list as "nothing to choose from" either way.
     */
    [`${CONTROL_PREFIX}/providers`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const query = new URL(req.url ?? '/', 'http://relay.invalid').searchParams
      const model = baseModelId((query.get('model') ?? '').trim())
      // Every model this plugin can pin is `<author>/<slug>`; anything else has no
      // OpenRouter listing to read, so it is a bad request rather than an empty menu.
      if (model === '' || !model.includes('/')) {
        sendJson(res, 400, {
          error: { message: 'model is required: the model id whose endpoints to list, e.g. "deepseek/deepseek-v3.2"' },
        })
        return
      }
      const listing = await providerListing(model)
      // Groups carry tag lists rather than row copies: the rows are already in
      // `providers`, and a second copy would double a 47 KB payload to say "these first".
      const groups = groupProviders(listing.providers).map((group) => ({
        id: group.id,
        tags: group.providers.map((provider) => provider.tag),
      }))
      sendJson(res, 200, {
        ok: true,
        model,
        fetchedAt: listing.fetchedAt,
        cached: listing.cached === true,
        providers: listing.providers,
        groups,
        ...(listing.error === undefined ? {} : { error: listing.error }),
      })
    }),

    /**
     * The endpoint one Session pinned.
     *
     * A sibling of `/tier` and `/precision` rather than a field of either, because a pin
     * is not a fifth value on the same axis — it *subsumes* them, which is exactly why the
     * chip disables those two cells while it is set. `GET ?session=<id>` reports what the
     * Session routes to (`provider` is null when nothing is pinned) and, when `model` is
     * also named, whether that slug is still listed for it. `POST { session, provider }`
     * pins one slug, or clears it with `null`. Memory only, like its two siblings.
     *
     * The record stored beside the slug is the row's own `name`/`tier`/`precision`, so the
     * chip can paint "Relace · fp4" on load without waiting for a 47 KB listing. Those
     * three fields are a report of the choice, never the thing that routes: the relay pins
     * by `tag` alone.
     */
    [`${CONTROL_PREFIX}/provider`]: controlRoute(async (req, res) => {
      /**
       * @param {string} session
       * @param {string | null} model
       */
      const answer = async (session, model) => {
        const record = pinForSession(session)
        let available = true
        if (record !== null && model !== null) {
          /* Read the cache, never the network. This is the chip's mount path — it runs
             beside `/tier` and `/precision` to paint the cell — and waiting on an 8 s
             public GET to answer "is that endpoint still listed" would stall the only
             thing the page is trying to show. An unread listing therefore reports
             `available: true`: unknown is not the same claim as gone, and the menu's own
             `/providers` read is what supplies the definitive answer a moment later. */
          const cached = cachedProviders(model)
          if (cached !== null && cached.providers.length > 0) {
            available = findProvider(cached.providers, record.tag) !== null
          }
        }
        return {
          ok: true,
          session,
          provider: record,
          chosen: record === null ? null : record.tag,
          model,
          available,
        }
      }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://relay.invalid').searchParams
        const rawModel = (query.get('model') ?? '').trim()
        sendJson(res, 200, await answer(
          (query.get('session') ?? '').trim(),
          rawModel === '' ? null : baseModelId(rawModel),
        ))
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      if (!session) {
        sendJson(res, 400, { error: { message: 'session is required: the Session whose pinned endpoint is being set' } })
        return
      }
      if (session.length > 128) {
        sendJson(res, 400, { error: { message: 'session must be at most 128 characters' } })
        return
      }
      const rawModel = typeof body.model === 'string' ? body.model.trim() : ''
      const model = rawModel === '' ? null : baseModelId(rawModel)
      // Absent or null clears the pin; a bare slug pins it. No config write and no
      // transaction escape: this touches memory only, like `/tier` and `/precision`.
      const raw = body.provider === undefined || body.provider === null ? null : body.provider
      if (raw === null) {
        writeSessionPin(session, null)
        log('info', 'cleared the pinned endpoint for a session', { session })
        sendJson(res, 200, await answer(session, model))
        return
      }
      const tag = typeof raw === 'string' ? raw.trim() : ''
      if (tag === '') {
        sendJson(res, 400, { error: { message: 'provider must be a non-empty endpoint slug, or null to clear the pin' } })
        return
      }
      if (tag.length > 128) {
        sendJson(res, 400, { error: { message: 'provider must be at most 128 characters' } })
        return
      }
      /** @type {{ tag: string, name: string, tier: string, precision: string } | null} */
      let record = null
      if (model !== null) {
        const listing = await providerListing(model)
        const row = findProvider(listing.providers, tag)
        if (row !== null) {
          record = { tag: row.tag, name: row.name, tier: row.tier, precision: row.precision }
        } else if (listing.providers.length > 0) {
          // Readable, and this model does not offer the slug: pinning it could only ever
          // be withheld later, so it is refused here while the operator can still see the
          // list they picked from.
          sendJson(res, 404, {
            error: { message: `model ${JSON.stringify(model)} does not list an endpoint named ${JSON.stringify(tag)}` },
          })
          return
        }
      }
      // No model, or an unreadable listing: keep the pin with what the slug itself says.
      // Refusing here would make a legitimate choice depend on a public read succeeding.
      if (record === null) {
        record = { tag, name: tag.split('/')[0], tier: 'standard', precision: 'unknown' }
      }
      writeSessionPin(session, record)
      log('info', 'pinned an endpoint for a session', { session, pin: record.tag })
      sendJson(res, 200, await answer(session, model))
    }),

    // The sidebar card is a preference, not traffic state: one config key, and the
    // reloaded config is what the next /status reports back to the page.
    [`${CONTROL_PREFIX}/widget`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: { message: 'enabled must be a boolean' } })
        return
      }
      await outsideHmrTransaction(ctx, () => writeUsageWidget(body.enabled))
      log('info', 'set the usage widget flag', { enabled: body.enabled })
      sendJson(res, 200, { ok: true, usageWidget: { enabled: body.enabled } })
    }),

    /**
     * Which facts a provider row states, how many percentiles it prints, and the order the
     * list reads in.
     *
     * A sibling of `/widget` rather than a field of `/status`: the sidebar card polls that
     * endpoint and has no use for this, while the provider menu needs it at the moment it
     * paints a row. `GET` answers the whole vocabulary whether the row wrote a subset or
     * nothing at all; `POST { providerFacts }` stores the normalised object, so the next boot
     * reads back exactly what the page just sent.
     */
    [`${CONTROL_PREFIX}/provider-facts`]: controlRoute(async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, providerFacts: normalizeProviderFacts(config.providerFacts) })
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const next = normalizeProviderFacts(body.providerFacts)
      await outsideHmrTransaction(ctx, () => writeProviderFacts(next))
      log('info', 'set the provider-facts display preferences', { providerFacts: next })
      sendJson(res, 200, { ok: true, providerFacts: next })
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
    generationLookup: config.generationLookup,
    resolveTarget,
    // The tier and precision a bare mount should apply for the Session carrying the
    // request. The relay only asks; every choice, and the admission decision behind the
    // precision filter, lives here in the plugin.
    resolveSessionRecipe: (session, model) => recipeForSession(session, model),
    onRecord: (entry) => {
      metrics.record(entry)
      scheduleUsageWrite()
    },
    /* The caller's key, spent on one listing read for the model it just used. This is the
       only moment the speed fields are populated: the same GET answered without a key
       reports them null on every endpoint, so a menu that only ever read anonymously would
       never have a number to show. Nothing is awaited and nothing is stored but the rows —
       the key lives exactly as long as the call, like the generation lookup above. */
    onModelSeen: (model, authorization, destination) => {
      if (typeof authorization !== 'string' || authorization === '') return
      /* Only for a request this plugin forwarded to its own upstream. A target mount can be
         pointed at any API, and the key the client sent belongs to *that* one — spending it
         on OpenRouter would hand another provider's credential to a host it was never meant
         for. A listing is only readable at the configured upstream anyway, so the guard
         costs nothing but the check. */
      if (typeof destination !== 'string' || !destination.startsWith(`${config.upstream}/`)) return
      const id = baseModelId(model).trim()
      // A model this relay cannot read an OpenRouter listing for — one on another
      // provider's namespace, or no model at all — is simply not warmed.
      if (id === '' || !id.includes('/')) return
      void providerListing(id, authorization).catch(() => {})
    },
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
