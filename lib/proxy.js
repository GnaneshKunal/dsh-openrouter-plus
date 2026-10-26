/**
 * The loopback relay.
 *
 * Responsibilities, in the order a request meets them:
 *   1. control endpoints (`/__openrouter-plus/*`) — exact pathname match;
 *   2. mount resolution — the longest `routes` key that matches on a segment
 *      boundary, stripped from the path and appended to the upstream base;
 *   3. tier injection — the top-level `service_tier` key in a JSON body;
 *   4. streaming passthrough — the upstream body is piped unbuffered.
 *
 * The relay is deliberately dumb about providers: it never inspects model names,
 * never rewrites a response, and never retries. Its only opinion is the tier.
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
 */
export function createRelay(options) {
  const host = options.host ?? '127.0.0.1'
  const basePort = Number.isInteger(options.port) ? options.port : 8791
  const portFallback = options.portFallback !== false
  const upstream = String(options.upstream ?? '').replace(/\/+$/, '')
  const routes = options.routes ?? {}
  const control = options.control ?? {}
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

    const match = resolveRoute(pathname)
    if (!match) {
      sendError(res, 404, `no mount matches ${pathname}; mounts: ${mounts.join(', ') || '(none)'}`)
      return
    }

    await forward(req, res, match, url.search)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ prefix: string, tier: string|null, upstreamPath: string }} match
   * @param {string} search
   */
  async function forward(req, res, match, search) {
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

    /** @type {{ tier: string|null, model: string|null, streaming: boolean, status: number, ms: number, bytes: number, promptTokens: number|null, completionTokens: number|null, at: number }} */
    const record = {
      tier: match.tier,
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

    // ---- tier injection -----------------------------------------------------
    if (sendsBody && rawBody.length > 0) {
      const parsed = tryJson(rawBody)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.model === 'string') record.model = parsed.model
        if (match.tier !== null) {
          parsed.service_tier = match.tier
          forwardedBody = Buffer.from(JSON.stringify(parsed), 'utf8')
        }
      }
    }

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

    const target = `${upstream}${match.upstreamPath}${search}`

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
      sendError(res, 502, `upstream unreachable (${upstream}): ${errorText(error)}`)
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
    outHeaders['x-oorp-tier'] = match.tier ?? 'passthrough'
    outHeaders['x-oorp-upstream'] = upstream

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
