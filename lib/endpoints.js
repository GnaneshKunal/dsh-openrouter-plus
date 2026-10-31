/**
 * The endpoint listing behind a precision floor, and why anything reads it at all.
 *
 * `provider.quantizations` is an *include* list, so a floor is only sendable when the
 * model still has an endpoint inside it: no surviving endpoint means the request fails
 * upstream with a 404 rather than falling back. A relay cannot learn that from the
 * request body it is rewriting — the body names a model, not the endpoints behind it —
 * so one public, keyless GET supplies it:
 *
 *   GET <upstream>/models/<author>/<slug>/endpoints
 *   { data: { endpoints: [{ provider_name, tag, quantization, status, … }] } }
 *
 * Parsing is pure, and the single fetch is bounded (byte cap plus timeout), which is
 * the shape `lib/models-sync.js` already established for a public OpenRouter listing.
 * The README's untouched-profiles guarantee depends on the split: the Host decides
 * *when* to read and caches the answer, so nothing here ever runs on the relay's
 * request path and an `any` floor reads nothing at all.
 */
import { QUANTIZATION_LEVELS } from './quantization.js'

/**
 * Largest endpoint listing this plugin will read.
 *
 * The real body is a few kilobytes even for a model with a dozen providers; the cap
 * exists so an upstream that never stops writing cannot make the Host buffer without
 * bound, exactly as the `/models` cap does for the catalogue.
 */
export const ENDPOINTS_MAX_BYTES = 256 * 1024

/**
 * How long one listing read may take before it is abandoned.
 *
 * This read happens off the request path, so the timeout is not protecting a turn; it
 * is protecting the single-flight slot. A fetch that never settles would keep that
 * model "warming" forever, and its floor would stay bypassed with no other symptom.
 */
export const ENDPOINTS_TIMEOUT_MS = 5_000

/** The levels a listing may report, for coercing a value nobody anticipated. */
const LEVEL_SET = new Set(QUANTIZATION_LEVELS)

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * One reported quantization, normalised.
 *
 * A value outside the known vocabulary is recorded as `unknown` instead of being
 * dropped: it is still an endpoint, and "we cannot judge this precision" is exactly
 * what `unknown` means here. Dropping it would under-count the model's endpoints, and
 * an under-count disables the floor for that model — a quiet failure of the feature.
 *
 * @param {unknown} value
 * @returns {string}
 */
function quantizationOf(value) {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return LEVEL_SET.has(level) ? level : 'unknown'
}

/**
 * The path segment for one model's endpoint listing, or null when the id cannot be one.
 *
 * OpenRouter model ids are `<author>/<slug>`; a slug may carry a variant suffix
 * (`:free`), which is a legitimate path character here. The check is deliberately
 * narrow — an id that could smuggle a path or a query into the URL is refused rather
 * than encoded into something surprising.
 *
 * @param {unknown} model
 * @returns {string | null}
 */
function endpointPathOf(model) {
  const text = typeof model === 'string' ? model.trim() : ''
  const cut = text.indexOf('/')
  if (cut <= 0 || cut === text.length - 1) return null
  const author = text.slice(0, cut)
  const slug = text.slice(cut + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(author)) return null
  if (!/^[A-Za-z0-9._:-]+$/.test(slug)) return null
  return `models/${author}/${slug}/endpoints`
}

/**
 * Read a `/models/<author>/<slug>/endpoints` body into plain endpoint records.
 *
 * Accepts the raw body text or an already-parsed body, because two callers exist: the
 * fetch below holds the bytes and wants the cap enforced *before* a large body is
 * parsed, while a test (or a caller replaying a snapshot) already has an object and
 * should not have to re-serialise it. When the payload is already parsed the cap has
 * nothing left to protect, so `maxBytes` is simply unused — the caller already paid for
 * the buffer.
 *
 * `status` is carried through verbatim and deliberately not interpreted: it is in the
 * listing, but its vocabulary is not part of this relay's contract, and guessing which
 * values mean "unusable" could erase a healthy endpoint from the pool (or admit a dead
 * one). Admission uses every endpoint the model declares.
 *
 * @param {unknown} payload raw body text, a Buffer, or a parsed listing
 * @param {number} [maxBytes=ENDPOINTS_MAX_BYTES]
 * @returns {Array<{ provider_name: string | null, tag: string | null, quantization: string, status: string | null }>}
 * @throws {TypeError} when the body is larger than the cap or is not an endpoint listing
 */
export function parseEndpoints(payload, maxBytes = ENDPOINTS_MAX_BYTES) {
  let body = payload
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new TypeError(`the endpoint listing is larger than ${maxBytes} bytes`)
    }
    try {
      body = JSON.parse(text)
    } catch {
      throw new TypeError('this endpoint did not answer with JSON')
    }
  }
  const data = isPlainObject(body) ? body.data : undefined
  const rows = isPlainObject(data) ? data.endpoints : undefined
  if (!Array.isArray(rows)) {
    throw new TypeError('this endpoint did not answer with an endpoint listing (no "data.endpoints" array)')
  }
  const endpoints = []
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    endpoints.push({
      provider_name: asText(row.provider_name),
      tag: asText(row.tag),
      quantization: quantizationOf(row.quantization),
      status: asText(row.status),
    })
  }
  return endpoints
}

/**
 * The set of precisions one model's endpoints report.
 *
 * A *set* is the right shape because several providers commonly report the same level
 * (four `fp8` endpoints on DeepSeek V3.2), and admission only asks whether any of them
 * survives a floor. Endpoints whose value is missing or unrecognised land on `unknown`,
 * which is a level a floor can admit or exclude like any other.
 *
 * @param {unknown} endpoints an array from {@link parseEndpoints}, or anything else
 * @returns {Set<string>}
 */
export function levelsFrom(endpoints) {
  const levels = new Set()
  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    levels.add(quantizationOf(isPlainObject(endpoint) ? endpoint.quantization : undefined))
  }
  return levels
}

/**
 * Whether a floor would leave at least one endpoint of a model eligible.
 *
 * This is the admission rule, and it is the reason this feature can ship at all: with
 * `allow === null` the floor names nothing, so nothing is filtered and the answer is
 * `true` — "any" is a floor that admits everything, not an absence of one. With a list,
 * one matching level is enough; an empty or unknown listing is `false`, which makes the
 * caller send no list rather than an empty one.
 *
 * @param {readonly string[] | null | undefined} allow
 * @param {Set<string> | readonly string[] | null | undefined} levels
 * @returns {boolean}
 */
export function survives(allow, levels) {
  // A floor that named no list (`any`, or a caller with nothing to say) filters nothing.
  if (!Array.isArray(allow)) return true
  const known = levels instanceof Set ? levels : new Set(Array.isArray(levels) ? levels : [])
  for (const level of allow) {
    if (typeof level === 'string' && known.has(level)) return true
  }
  return false
}

/**
 * Read one model's endpoint listing from an OpenRouter-compatible upstream.
 *
 * `fetch` is injectable so a test never has to reach the network, and the timeout
 * defaults to a finite bound for the reason above. Everything that can fail here
 * (unreachable, non-JSON, wrong shape) fails as a rejected promise: the caller treats
 * every failure the same way — "no known levels for this model" — because to a relay
 * that is rewriting a body, an unknown precision and an unreachable listing are the
 * same fact.
 *
 * @param {string} upstream the relay's upstream, e.g. 'https://openrouter.ai/api/v1'
 * @param {string} model a model id, `<author>/<slug>`
 * @param {{ fetch?: typeof globalThis.fetch, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{
 *   url: string,
 *   endpoints: ReturnType<typeof parseEndpoints>,
 *   levels: Set<string>,
 * }>}
 */
export async function fetchEndpoints(upstream, model, options = {}) {
  const base = typeof upstream === 'string' ? upstream.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\/\S+$/i.test(base)) {
    throw new TypeError(`the relay upstream is not an absolute http(s) URL: ${JSON.stringify(String(upstream ?? ''))}`)
  }
  const pathname = endpointPathOf(model)
  if (pathname === null) {
    throw new TypeError(`not a routable model id: ${JSON.stringify(String(model ?? ''))}`)
  }
  const url = `${base}/${pathname}`
  const doFetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TypeError('no fetch implementation is available in this runtime')
  }

  /** @type {RequestInit} */
  const request = { method: 'GET', headers: { accept: 'application/json' } }
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Number(options.maxBytes)
    : ENDPOINTS_MAX_BYTES
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs)
    : ENDPOINTS_TIMEOUT_MS
  request.signal = AbortSignal.timeout(timeoutMs)

  let response
  try {
    response = await doFetch(url, request)
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = await response.text()
  // The cap is checked on the text before the parser sees it, so the error names the URL
  // that misbehaved rather than only the parser's own refusal.
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`${url} answered with more than ${maxBytes} bytes`)
  }
  const endpoints = parseEndpoints(text, maxBytes)
  return { url, endpoints, levels: levelsFrom(endpoints) }
}
