/**
 * dsh-openrouter-plus — the control API, from a front door that is not a browser.
 *
 * The settings page talks to `/__openrouter-plus/*` with `fetch` on its own
 * origin. A terminal has no origin, so the TUI half needs something smaller: a
 * client that knows the mount prefix, the one header the control layer requires
 * on a write, a timeout that cannot hang the composer, and error messages that
 * read like sentences because they land in a transcript rather than a console.
 *
 * Three rules the rest of this module keeps:
 *
 * - **The prefix has one spelling.** {@link CONTROL_PREFIX} is exported from
 *   here and imported by the Host, so a rename cannot leave the page and the
 *   terminal addressing two different APIs.
 * - **A fault is an outcome, not an exception.** `get`/`post` reject with
 *   {@link ControlUnavailable} (no origin, no answer, timeout) or
 *   {@link ControlRejected} (the API answered non-2xx), and both carry a
 *   message written for a person. A command handler turns one into
 *   `{ kind: 'error' }` and never needs to inspect the failure.
 * - **Nothing here decides where the relay is.** `origin` is a function, so the
 *   caller can probe, cache, or re-resolve between two keystrokes; see
 *   `control-origin.js`, which is what resolves a multi-instance machine onto
 *   the relay that actually serves the traffic.
 *
 * Plain ESM, Node >= 20 built-ins only.
 */

/** The mount the Host serves the control API under. */
export const CONTROL_PREFIX = '/__openrouter-plus'

/** The header that marks a request as coming from a plugin-owned front door. */
export const CONTROL_CLIENT_HEADER = 'x-oorp-client'

/** Which front doors the control layer accepts on a write. */
export const CONTROL_CLIENTS = Object.freeze(['web', 'tui'])

/** The value this client sends. Kept beside the list above so the two agree. */
export const CONTROL_CLIENT = 'tui'

/** How long one control call may take before it is reported as unanswered. */
export const CONTROL_TIMEOUT_MS = 5_000

/**
 * The relay is not answering, or there is nowhere to send the request.
 *
 * Distinct from {@link ControlRejected} because the remedy is different: this
 * one is "the plugin is not running (or not on this port)", which a person
 * fixes by starting the profile, not by correcting an argument.
 */
export class ControlUnavailable extends Error {
  /**
   * @param {string} message a sentence for the transcript
   * @param {{ origin?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'ControlUnavailable'
    this.origin = details.origin ?? null
  }
}

/**
 * The relay answered, and refused.
 *
 * `status` is the HTTP status and `message` is the API's own `error.message`
 * when it sent one, so a bad preset name reads exactly as it does on the
 * settings page instead of as "HTTP 400".
 */
export class ControlRejected extends Error {
  /**
   * @param {string} message a sentence for the transcript
   * @param {{ status: number, path: string, body?: unknown }} details
   */
  constructor(message, details) {
    super(message)
    this.name = 'ControlRejected'
    this.status = details.status
    this.path = details.path
    this.body = details.body ?? null
  }
}

/** @param {unknown} value @returns {boolean} */
function isFunction(value) {
  return typeof value === 'function'
}

/**
 * Strip the trailing slashes an origin may carry, so `${origin}${path}` is one
 * slash and not two.
 *
 * @param {string} value
 * @returns {string}
 */
function trimOrigin(value) {
  return value.replace(/\/+$/, '')
}

/**
 * The message the API put in a refusal, when it sent one.
 *
 * @param {unknown} body
 * @returns {string | null}
 */
function refusalOf(body) {
  if (typeof body !== 'object' || body === null) return null
  const error = /** @type {{ error?: unknown }} */ (body).error
  if (typeof error === 'string' && error !== '') return error
  if (typeof error === 'object' && error !== null) {
    const message = /** @type {{ message?: unknown }} */ (error).message
    if (typeof message === 'string' && message !== '') return message
  }
  return null
}

/**
 * A control client bound to whatever origin `options.origin` answers.
 *
 * @param {{
 *   origin: () => string | null | Promise<string | null>,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof globalThis.fetch,
 *   log?: (level: string, message: string, detail?: unknown) => void,
 * }} options
 * @returns {{
 *   get: (path: string, query?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>,
 *   post: (path: string, body?: unknown, options?: { signal?: AbortSignal }) => Promise<any>,
 *   origin: (signal?: AbortSignal) => Promise<string>,
 *   request: (method: string, path: string, options?: { query?: Record<string, unknown>, body?: unknown, signal?: AbortSignal }) => Promise<any>,
 * }}
 */
export function createControlClient(options) {
  const opts = typeof options === 'object' && options !== null ? options : {}
  const originOf = isFunction(opts.origin) ? opts.origin : () => null
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : CONTROL_TIMEOUT_MS
  const fetchImpl = isFunction(opts.fetchImpl) ? opts.fetchImpl : globalThis.fetch
  const log = isFunction(opts.log) ? opts.log : () => {}

  /**
   * The origin to address, or a refusal that names the problem.
   *
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<string>}
   */
  async function origin(signal) {
    // `throwIfAborted` throws the *caller's* reason, which would escape the
    // "every fault is one of this module's two errors" rule; name it instead.
    try {
      signal?.throwIfAborted?.()
    } catch (error) {
      throw new ControlUnavailable('OpenRouter Plus cancelled that request.', { cause: error })
    }
    let value
    try {
      value = await originOf()
    } catch (error) {
      throw new ControlUnavailable(
        'OpenRouter Plus could not work out which relay to talk to; the plugin may be starting up — try again in a moment.',
        { cause: error },
      )
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ControlUnavailable(
        'OpenRouter Plus has no reachable relay. Start the profile that runs the plugin, or check `enabled` and `port` in its config.',
      )
    }
    const trimmed = trimOrigin(value.trim())
    // A caller that hands back something that is not a URL would otherwise fail
    // inside `new URL` with a message about invalid URLs; name the real fault.
    if (!/^https?:\/\/[^/]+/.test(trimmed)) {
      throw new ControlUnavailable(`OpenRouter Plus was given a relay address it cannot use: ${JSON.stringify(value)}.`)
    }
    return trimmed
  }

  /**
   * Run one call: URL, header, timeout, parsed answer or a refusal.
   *
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, unknown>, body?: unknown, signal?: AbortSignal }} [requestOptions]
   * @returns {Promise<any>}
   */
  async function request(method, path, requestOptions = {}) {
    const options = typeof requestOptions === 'object' && requestOptions !== null ? requestOptions : {}
    const base = await origin(options.signal)
    /* Callers name a route (`/status`), not a mount: the prefix is this module's
       business, so a rename lands in one place. A caller that already spells the
       whole mount keeps working, which is what makes a hand-written `curl` and
       this client interchangeable. */
    const mounted = path === CONTROL_PREFIX || path.startsWith(`${CONTROL_PREFIX}/`)
      ? path
      : `${CONTROL_PREFIX}${path.startsWith('/') ? '' : '/'}${path}`
    /** @type {URL} */
    let url
    try {
      url = new URL(`${base}${mounted}`)
    } catch (error) {
      throw new ControlUnavailable(`OpenRouter Plus cannot address ${JSON.stringify(mounted)} on ${base}.`, {
        origin: base,
        cause: error,
      })
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    /* Its own controller so a slow relay cannot hold the composer forever, and
       the caller's signal forwarded by hand: a command handler's signal is
       owned by the dispatching UI, and `AbortSignal.any` would tie this module
       to a newer Node than the package's floor. */
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    const forward = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) forward()
    else options.signal?.addEventListener?.('abort', forward, { once: true })

    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json', [CONTROL_CLIENT_HEADER]: CONTROL_CLIENT }
    /** @type {string | undefined} */
    let payload
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(options.body)
    }

    /** @type {Response} */
    let response
    try {
      response = await fetchImpl(url.href, { method, headers, body: payload, signal: controller.signal })
    } catch (error) {
      const aborted = options.signal?.aborted === true
      throw new ControlUnavailable(
        aborted
          ? 'OpenRouter Plus cancelled that request.'
          : `OpenRouter Plus could not reach its relay at ${base}. Is the plugin still running?`,
        { origin: base, cause: error },
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', forward)
    }

    /* The API answers JSON on every route, including its refusals. Read the
       text first: a proxy in between can answer HTML, and `response.json()`
       would then throw with a parse error instead of the status that matters. */
    let text = ''
    try {
      text = await response.text()
    } catch (error) {
      throw new ControlUnavailable(`OpenRouter Plus lost the relay's answer from ${base}.`, {
        origin: base,
        cause: error,
      })
    }
    /** @type {unknown} */
    let body
    if (text.trim() === '') body = null
    else {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }

    if (!response.ok) {
      const refusal = refusalOf(body)
      const message = refusal
        ?? `OpenRouter Plus refused ${method} ${path} with HTTP ${response.status} and no explanation.`
      log('warn', 'control call was refused', { method, path, status: response.status, reason: message })
      throw new ControlRejected(message, { status: response.status, path, body })
    }
    return body
  }

  return {
    request,
    origin,
    get: (path, query, requestOptions) => request('GET', path, { ...requestOptions, query }),
    post: (path, body, requestOptions) => request('POST', path, { ...requestOptions, body }),
  }
}
