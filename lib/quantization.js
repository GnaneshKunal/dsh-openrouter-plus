/**
 * Precision floors: the vocabulary and the policy, with no I/O.
 *
 * Why this exists. `provider.sort` reorders whatever endpoints a model has; it cannot
 * exclude one, so "do not run this Session on a 4-bit endpoint" had no wire form at
 * all. OpenRouter does expose one — `provider.quantizations`, an include list — but a
 * relay may not simply forward it: excluding every endpoint of a model is a hard
 * failure upstream (no provider satisfies the request), not a silent fallback. The
 * floor therefore splits in two halves, and this file is only the first one:
 *
 *   1. *policy* — which levels a named floor admits, and what `unknown` means for it;
 *   2. *admission control* — whether this model still has an endpoint in that set,
 *      which needs the public endpoint listing and belongs to the caller.
 *
 * Keeping the policy here (and pure) is what lets the Host and the tests agree on the
 * wire list without either of them reading a network response, and it keeps
 * `lib/proxy.js` — the relay — free of any opinion about which levels exist.
 */

/**
 * Every quantization OpenRouter reports for an endpoint.
 *
 * `unknown` is a real value, not a parse failure: a provider that does not state a
 * precision is reported as `unknown`, and on the models this plugin routes for that is
 * roughly 40% of the endpoints. It is therefore a level a floor can admit or exclude —
 * the single most consequential decision in this file.
 */
export const QUANTIZATION_LEVELS = Object.freeze([
  'int4',
  'int8',
  'fp4',
  'mxfp4',
  'nvfp4',
  'fp6',
  'fp8',
  'mxfp8',
  'fp16',
  'bf16',
  'fp32',
  'unknown',
])

/**
 * The floors, as the include lists they materialise.
 *
 * Ordered by what each one is *for*, not by precision: `no-four-bit` drops the 4-bit
 * family but keeps every eight-bit-and-better encoding (`fp6` included, which is why
 * it is not spelled `eight-bit-up`); `eight-bit-up` drops `fp6` too; `full-width`
 * keeps only the uncompressed formats. `any` is `null`, not an empty list — a floor
 * that names nothing must send nothing at all, and `null` is how that is said without
 * reserving a special value inside the wire list.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string> | null>>}
 */
export const FLOORS = Object.freeze({
  any: null,
  'no-four-bit': Object.freeze(['int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32']),
  'eight-bit-up': Object.freeze(['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32']),
  'full-width': Object.freeze(['fp16', 'bf16', 'fp32']),
})

/** Floor ids, in the order a picker offers them: least to most restrictive. */
export const PRECISION_IDS = Object.freeze(Object.keys(FLOORS))

/**
 * Whether a floor admits endpoints whose precision nobody declared.
 *
 * On by default for the two middle floors because `unknown` is a large share of the
 * real pool: a floor that silently halved it would look broken. Off for `full-width`
 * (admitting an undeclared endpoint there contradicts the floor's own name) and for
 * `any` (which sends no list, so the flag has nothing to append to).
 *
 * @type {Readonly<Record<string, boolean>>}
 */
const INCLUDE_UNKNOWN_DEFAULT = Object.freeze({
  any: false,
  'no-four-bit': true,
  'eight-bit-up': true,
  'full-width': false,
})

/**
 * English labels, matching the settings page's wording. The page localises its own
 * strings, so this is for Host-side logs and for any payload that wants a readable
 * name next to an id — never a substitute for the locale namespace.
 *
 * @type {Readonly<Record<string, string>>}
 */
const LABELS = Object.freeze({
  any: 'Any',
  'no-four-bit': 'No four-bit',
  'eight-bit-up': 'Eight-bit up',
  'full-width': 'Full width',
})

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coerce whatever a config row or a control body said into the one shape the rest of
 * the Host uses: `{ floor, includeUnknown, allow }`.
 *
 * Tolerance is deliberate, because this reads hand-edited YAML as well as JSON from
 * the page: a bare string is the whole floor, and `{ floor, includeUnknown }` is the
 * full form. An unknown floor becomes `any` rather than throwing — config is read at
 * boot, and refusing to start the relay over a misspelled preference would turn a
 * cosmetic mistake into an outage. (Control writes do refuse a typo; see index.js.)
 *
 * `allow` is materialised here, once, so that "sends nothing" has a value (`null`)
 * instead of having to be re-derived at every use.
 *
 * @param {unknown} raw
 * @returns {{ floor: string, includeUnknown: boolean, allow: string[] | null }}
 */
export function normalizePrecision(raw) {
  const source = typeof raw === 'string' ? { floor: raw } : isPlainObject(raw) ? raw : {}
  const wanted = typeof source.floor === 'string' ? source.floor.trim().toLowerCase() : ''
  const floor = Object.hasOwn(FLOORS, wanted) ? wanted : 'any'
  const includeUnknown = typeof source.includeUnknown === 'boolean'
    ? source.includeUnknown
    : INCLUDE_UNKNOWN_DEFAULT[floor]
  const levels = FLOORS[floor]
  const allow = levels === null ? null : includeUnknown ? [...levels, 'unknown'] : [...levels]
  return { floor, includeUnknown, allow }
}

/**
 * A readable name for a floor, from any spelling of it.
 *
 * Exists so a log line or a status payload never has to carry its own copy of the
 * floor table and drift from this one; an unrecognised value reads as `Any` for the
 * same reason {@link normalizePrecision} falls back to it.
 *
 * @param {unknown} value a floor id, or a normalised precision
 * @returns {string}
 */
export function precisionLabel(value) {
  return LABELS[normalizePrecision(value).floor]
}
