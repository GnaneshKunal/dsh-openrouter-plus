/**
 * dsh-openrouter-plus — Host half.
 *
 * One loopback HTTP relay + one status/control API. The relay exists because the
 * only request-body seam a third-party plugin can reach is a provider route's
 * `baseURL`: we point a cloned pi-ai provider route at
 * `http://127.0.0.1:<port>/<tier>/v1`, and the relay writes the
 * `service_tier` key into the body on the way upstream. See docs/ARCHITECTURE.md
 * and deepseek-harness discussion #9787.
 *
 * Nothing is mounted on the DSH web server, so the GUI's auth fence and this
 * plugin cannot interfere with each other.
 */
import { createMetrics } from './lib/metrics.js'
import { createRelay } from './lib/proxy.js'
import { createConfigBridge } from './lib/config-bridge.js'
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

/** Tier names the OpenAI-compatible protocols accept, per discussion #9787. */
const KNOWN_TIERS = ['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast']

const VERSION = '0.5.0'

/** Largest control-POST body we will read; these are tiny JSON documents. */
const MAX_CONTROL_BODY = 64 * 1024

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/**
 * @param {Record<string, unknown>} [raw] the Loader row config
 * @returns {{
 *   enabled: boolean, host: string, port: number, portFallback: boolean,
 *   upstream: string, routes: Record<string, string|null>, upstreamTimeoutMs: number,
 *   autoRepairReasoning: boolean,
 * }}
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const upstream = typeof config.upstream === 'string' && config.upstream.trim()
    ? config.upstream.trim().replace(/\/+$/, '')
    : DEFAULT_UPSTREAM
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
  }
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
      sendJson(res, 200, {
        ok: state.error === undefined,
        version: VERSION,
        controlPrefix: CONTROL_PREFIX,
        address: relay.address() ?? { host: config.host, port: config.port, origin: originOf(config.host, config.port) },
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
        // What a repair would fill: `false` = never, `null` = only from evidence
        // already declared elsewhere in the profile, object = the fallback map.
        reasoning: {
          fill: config.reasoningEfforts === false ? 'never' : config.reasoningEfforts === null ? 'evidence' : 'default',
          levels: config.reasoningEfforts === false ? [] : Object.keys(config.reasoningEfforts ?? {}),
        },
      })
    }),

    [`${CONTROL_PREFIX}/routes/create`]: controlRoute(async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const created = await outsideHmrTransaction(ctx, () =>
        bridge.createRoute({
          source: typeof body.source === 'string' ? body.source : '',
          tier: typeof body.tier === 'string' ? body.tier : '',
          name: typeof body.name === 'string' ? body.name : undefined,
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        }),
      )
      log('info', 'created provider route', created)
      sendJson(res, 200, { ok: true, ...created })
    }),

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

    // ── attaching a provider endpoint to this relay ────────────────────────
    // The Models page's own provider form calls these: registering an upstream
    // is what makes a mount exist, and `/routes/attach` is what moves a provider
    // row onto that mount without the operator editing YAML.
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
      const registered = await outsideHmrTransaction(ctx, () => ensureTarget(request))
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
      const baseURL = baseUrlFor(registered.target.id, registered.target.tier)
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
