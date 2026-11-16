/**
 * dsh-openrouter-plus — which relay is "the" relay?
 *
 * One relay per process is the design, and the port is the rendezvous: a
 * provider row says `http://127.0.0.1:8791/t/<id>/v1`, and whichever process
 * owns 8791 is the one that carries that row's traffic. A second process on the
 * same machine — the web GUI, a terminal, another profile — cannot bind the
 * same port, so it falls forward to 8792 (see `portFallback`) and serves its
 * own, different set of Sessions.
 *
 * That is fine for routing and fatal for a *control* surface that guesses: a
 * preset written into the process that is not serving the traffic is a switch
 * that does nothing, and the person who flipped it has no way to see that from
 * the transcript. So the front end resolves the relay the same way the traffic
 * does — from the provider rows, then its own listener, then the fallback
 * range — and only then talks to it.
 *
 * Two details the resolver keeps:
 *
 * - **Only loopback.** A provider row pointing at `https://api.openrouter.ai`
 *   is not a candidate, and nothing here probes a host that is not this
 *   machine. That is the same posture as the relay itself.
 * - **A probe decides, not a string match.** Any URL that looks like a mount
 *   could belong to a profile whose plugin row was disabled; one
 *   `GET /__openrouter-plus/health` separates "our relay" from "a URL we like
 *   the shape of".
 *
 * Plain ESM, Node >= 20 built-ins only.
 */

import { CONTROL_CLIENT_HEADER, CONTROL_CLIENT, CONTROL_PREFIX } from './control-client.js'

/** How long one health probe may take. Short: it runs before a keystroke lands. */
export const RELAY_PROBE_TIMEOUT_MS = 1_200

/** How long a resolved origin is reused before the next invocation re-probes. */
export const ORIGIN_CACHE_MS = 30_000

/** How far past the configured port to look when `portFallback` is on. */
export const PORT_SCAN_LIMIT = 10

/** Hostnames that mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '[::]', '::'])

/**
 * Whether a URL hostname names this machine.
 *
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

/**
 * The origin of a URL string, or null when it is not one.
 *
 * A malformed `baseURL` in a hand-edited profile must not stop the resolver:
 * one bad row is skipped, the rest still answer.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * The distinct loopback origins a set of provider rows points at, in the order
 * the rows declare them.
 *
 * Order is meaningful: the first row is usually the route the person actually
 * uses, so its relay is the likeliest answer and the first probe.
 *
 * @param {Iterable<unknown>} baseURLs
 * @param {{ skip?: Iterable<string> }} [options]
 * @returns {string[]}
 */
export function loopbackOriginsOf(baseURLs, options = {}) {
  const skip = new Set(options.skip ?? [])
  /** @type {string[]} */
  const origins = []
  const seen = new Set()
  for (const value of baseURLs ?? []) {
    const origin = parseOrigin(value)
    if (origin === null || seen.has(origin) || skip.has(origin)) continue
    let hostname
    try {
      hostname = new URL(origin).hostname
    } catch {
      continue
    }
    if (!isLoopbackHostname(hostname)) continue
    seen.add(origin)
    origins.push(origin)
  }
  return origins
}

/**
 * The origin a relay on `host:port` would answer on.
 *
 * A wildcard bind is still reachable on loopback, and that is the only address
 * a terminal should ever use.
 *
 * @param {string} host
 * @param {number} port
 * @returns {string | null}
 */
export function originOf(host, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]'
  let name = wildcard || typeof host !== 'string' || host === '' ? '127.0.0.1' : host
  /* A concrete IPv6 literal has to be bracketed to be a URL: `http://::1:8791` is
     not one, and the client refuses an address it cannot parse. The test is the
     literal's own alphabet rather than "contains a colon", so a host somebody
     mistyped as `localhost:8791` is not bracketed into an impossible address. */
  const literal = /^[0-9a-fA-F:.]+$/.test(name) && name.includes(':')
  if (literal && !name.startsWith('[')) name = `[${name}]`
  /* Build, then ask the URL parser whether that was an address at all: a host
     someone mistyped as `host:port` would otherwise become a string every later
     layer fails on for a different-looking reason. */
  try {
    return new URL(`http://${name}:${port}`).origin
  } catch {
    return null
  }
}

/**
 * Whether a relay answers on `origin`.
 *
 * Answers a boolean and never throws: an unreachable candidate is an ordinary
 * "not this one", not a fault worth reporting.
 *
 * @param {string} origin
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function probeRelay(origin, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : RELAY_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), timeoutMs)
  timer.unref?.()
  const forward = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forward()
  else options.signal?.addEventListener?.('abort', forward, { once: true })
  try {
    const response = await fetchImpl(`${origin.replace(/\/+$/, '')}${CONTROL_PREFIX}/health`, {
      method: 'GET',
      headers: { accept: 'application/json', [CONTROL_CLIENT_HEADER]: CONTROL_CLIENT },
      signal: controller.signal,
    })
    if (!response.ok) return false
    /** @type {unknown} */
    const body = await response.json().catch(() => null)
    // `ok` is the plugin's own statement that this is its relay, and it is the one
    // field `/health` cannot answer by accident: a 200 from some other server on the
    // same port would have to guess the route *and* the shape.
    return typeof body === 'object' && body !== null && /** @type {{ ok?: unknown }} */ (body).ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', forward)
  }
}

/**
 * Resolve — and remember — the relay a terminal front end should address.
 *
 * @param {{
 *   candidates: () => Iterable<string> | Promise<Iterable<string>>,
 *   ownOrigin?: () => string | null,
 *   host?: string,
 *   port?: number,
 *   portFallback?: boolean,
 *   probe?: (origin: string, options?: { signal?: AbortSignal }) => Promise<boolean>,
 *   cacheMs?: number,
 *   now?: () => number,
 *   log?: (level: string, message: string, detail?: unknown) => void,
 * }} options
 * @returns {{
 *   resolve: (signal?: AbortSignal) => Promise<string | null>,
 *   invalidate: () => void,
 *   known: () => string | null,
 *   candidates: (signal?: AbortSignal) => Promise<string[]>,
 * }}
 */
export function createOriginResolver(options) {
  const opts = typeof options === 'object' && options !== null ? options : {}
  const candidatesOf = typeof opts.candidates === 'function' ? opts.candidates : () => []
  const ownOrigin = typeof opts.ownOrigin === 'function' ? opts.ownOrigin : () => null
  const probe = typeof opts.probe === 'function' ? opts.probe : probeRelay
  const cacheMs = Number.isFinite(opts.cacheMs) && opts.cacheMs >= 0 ? opts.cacheMs : ORIGIN_CACHE_MS
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  /** @type {{ origin: string, at: number } | null} */
  let cached = null
  /** @type {string | null} */
  let lastGood = null

  /**
   * Every origin worth trying, most likely first, deduped.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string[]>}
   */
  async function candidates(signal) {
    /** @type {string[]} */
    const list = []
    /** @type {Set<string>} */
    const seen = new Set()
    /**
     * Accept one candidate, but only if it names this machine.
     *
     * Two jobs, and both belong here rather than only in the caller: **normalise**
     * (a provider row's `baseURL` carries a mount path — `/t/<id>/flex/v1` — and a
     * probe appended to that path would 404 against a perfectly healthy relay) and
     * **filter** (this is the last step before a socket opens, so a caller passing
     * raw provider rows must not be able to turn a health check into a request to
     * a remote API).
     *
     * @param {unknown} value
     */
    const push = (value) => {
      const origin = parseOrigin(value)
      if (origin === null) return
      if (seen.has(origin)) return
      let hostname
      try {
        hostname = new URL(origin).hostname
      } catch {
        return
      }
      if (!isLoopbackHostname(hostname)) return
      seen.add(origin)
      list.push(origin)
    }

    let declared = []
    try {
      declared = [...(await candidatesOf())]
    } catch (error) {
      log('warn', 'could not read provider rows while resolving the control origin', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    for (const origin of declared) push(origin)
    push(ownOrigin())

    /* The fallback range is only a guess, so it goes last: a row that names its
     * relay has already been tried, and the common single-instance case never
     * reaches this loop at all. */
    if (opts.portFallback === true && Number.isInteger(opts.port)) {
      for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) push(originOf(opts.host ?? '127.0.0.1', opts.port + offset))
    }
    signal?.throwIfAborted?.()
    return list
  }

  /**
   * The origin to address right now, or null when nothing answers.
   *
   * A stale-but-known answer is returned when every probe fails: a relay under
   * load deserves a precise "cannot reach <origin>" from the client rather than
   * a shrug here, and a 30 s cache would otherwise make one slow health check
   * look like a missing plugin.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string | null>}
   */
  async function resolve(signal) {
    const at = now()
    if (cached !== null && at - cached.at < cacheMs) return cached.origin
    const list = await candidates(signal)
    for (const origin of list) {
      signal?.throwIfAborted?.()
      // Probes are ordered on purpose; `Promise.all` would race them and lose
      // the "first row wins" rule the candidate list is built on.
      if (await probe(origin, { signal })) {
        cached = { origin, at: now() }
        lastGood = origin
        log('info', 'control origin resolved', { origin, candidates: list.length })
        return origin
      }
    }
    if (lastGood !== null) {
      log('warn', 'no relay answered; reusing the last known origin', { origin: lastGood })
      return lastGood
    }
    return null
  }

  return {
    resolve,
    candidates,
    invalidate: () => {
      cached = null
    },
    known: () => (cached === null ? lastGood : cached.origin),
  }
}
