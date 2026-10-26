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

const VERSION = '0.3.0'

/** Largest control-POST body we will read; these are tiny JSON documents. */
const MAX_CONTROL_BODY = 64 * 1024

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/**
 * @param {Record<string, unknown>} [raw] the Loader row config
 * @returns {{
 *   enabled: boolean, host: string, port: number, portFallback: boolean,
 *   upstream: string, routes: Record<string, string|null>, upstreamTimeoutMs: number,
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
      sendJson(res, 500, {
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
      if (!bridge.available()) {
        sendJson(res, 200, {
          available: false,
          reason: 'configEditor is not available in this Host; create routes by editing the llm-pi-ai providers manually',
          sources: [],
          created: [],
        })
        return
      }
      const targets = await bridge.targets()
      sendJson(res, 200, {
        available: true,
        ...targets,
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
      void relay.stop().catch((error) => log('warn', 'relay stop failed', error))
    }
  })
}

/** @param {string} host @param {number} port */
function originOf(host, port) {
  const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${name}:${port}`
}
