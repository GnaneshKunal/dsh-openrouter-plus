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
 *   4. tier injection — the top-level `service_tier` key in a JSON body;
 *   5. streaming passthrough — the upstream body is piped unbuffered.
 *
 * The relay is deliberately dumb about providers: it never inspects model names,
 * never rewrites a response, and never retries. Its only opinions are the tier
 * and, behind a target mount, the upstream the resolver names.
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
 * @param {(level: 'info'|'warn'|'error', message: string, detail?: unknown) => void} [options.log]
 * @param {number} [options.upstreamTimeoutMs=0]
 * @param {string} [options.version]
 * @param {(targetId: string) => unknown} [options.resolveTarget]
 *        Resolves a `/t/<targetId>/...` mount to `{ upstream, tier }`, or `null`
 *        when the id is unknown. The relay never inspects the result beyond those
 *        fields, so all target knowledge stays with the caller.
 * @param {(session: string) => unknown} [options.resolveSessionTier]
 *        Resolves the Session advertised on a request (see {@link sessionKeyOf})
 *        to the tier it should run on, or `null`/`undefined` for no tier. Only
 *        consulted when the mount itself pins no tier, so an explicit path still
 *        wins; a rejected promise is treated as "no tier" rather than failing the
 *        request.
 */
export function createRelay(options) {
  const host = options.host ?? '127.0.0.1'
  const basePort = Number.isInteger(options.port) ? options.port : 8791
  const portFallback = options.portFallback !== false
  const upstream = String(options.upstream ?? '').replace(/\/+$/, '')
  const routes = options.routes ?? {}
  const control = options.control ?? {}
  const resolveTarget = typeof options.resolveTarget === 'function' ? options.resolveTarget : null
  /**
   * Per-request tier lookup, keyed by the Session the client advertised. A mount
   * with no tier of its own asks this on every request, so the tier is a runtime
   * choice like `reasoningEffort` instead of a property of the provider row.
   */
  const resolveSessionTier = typeof options.resolveSessionTier === 'function' ? options.resolveSessionTier : null
  const onRecord = options.onRecord
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 0
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

    /** @type {{ tier: string|null, session: boolean, model: string|null, streaming: boolean, status: number, ms: number, bytes: number, promptTokens: number|null, completionTokens: number|null, at: number }} */
    const record = {
      tier: plan.tier,
      session: false,
      model: null,
      streaming: false,
      status: 0,
      ms: 0,
      bytes: 0,
      promptTokens: null,
      completionTokens: null,
      at: Date.now(),
    }

    /** @type {Buffer} */
    let forwardedBody = rawBody

    // ---- tier resolution ----------------------------------------------------
    // An explicit mount (`/t/<id>/flex/v1`) or a target pinned to a tier already
    // decided *which* tier this request runs on. A bare mount decided only *that*
    // a tier may be chosen, so the Session carrying the request decides now — the
    // same way `reasoningEffort` rides the selection instead of the provider row.
    let tier = plan.tier

    // ---- tier injection -----------------------------------------------------
    if (sendsBody && rawBody.length > 0) {
      const parsed = tryJson(rawBody)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.model === 'string') record.model = parsed.model
        const session = sessionKeyOf(req.headers, parsed)
        record.session = session !== ''
        if (tier === null && record.session && resolveSessionTier !== null) {
          try {
            const chosen = await resolveSessionTier(session)
            if (typeof chosen === 'string' && chosen.trim() !== '') tier = chosen.trim()
          } catch {
            // A lookup that fails must not fail the request: an untiered proxy hop is
            // exactly what this relay did before Sessions could choose.
          }
        }
        if (tier !== null) {
          parsed.service_tier = tier
          forwardedBody = Buffer.from(JSON.stringify(parsed), 'utf8')
        }
      }
    }
    record.tier = tier

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
    outHeaders['x-oorp-tier'] = tier ?? 'passthrough'
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
    report(record)
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

  /** Bind the listener, falling forward over busy ports when allowed. */
  async function start() {
    if (live) return bound ?? { host, port: basePort, origin: originOf(host, basePort) }
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
function createUsageSniffer() {
  let tail = ''
  let bytes = 0
  const usage = { promptTokens: null, completionTokens: null }

  /** @type {Transform} */
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        bytes += chunk.length
        tail = (tail + chunk.toString('utf8')).slice(-SNIFF_TAIL_BYTES)
      } catch {
        // sniffing is best-effort; a decode failure must not break the response
      }
      callback(null, chunk)
    },
    flush(callback) {
      try {
        Object.assign(usage, findUsage(tail))
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
 * Find the last `usage` object in a response tail, handling both a plain JSON
 * body and an SSE transcript.
 *
 * @param {string} text
 * @returns {{ promptTokens: number|null, completionTokens: number|null }}
 */
export function findUsage(text) {
  const empty = { promptTokens: null, completionTokens: null }
  if (!text) return empty

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

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const found = normalizeUsage(candidates[index])
    if (found.promptTokens !== null || found.completionTokens !== null) return found
  }
  return empty
}

/**
 * @param {unknown} value
 * @returns {{ promptTokens: number|null, completionTokens: number|null }}
 */
function normalizeUsage(value) {
  const result = { promptTokens: null, completionTokens: null }
  if (!value || typeof value !== 'object') return result
  const usage = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (value).usage ?? {})
  if (!usage || typeof usage !== 'object') return result
  const source = /** @type {Record<string, unknown>} */ (usage)
  result.promptTokens = firstCount(source.prompt_tokens, source.promptTokens, source.input_tokens)
  result.completionTokens = firstCount(source.completion_tokens, source.completionTokens, source.output_tokens)
  return result
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
