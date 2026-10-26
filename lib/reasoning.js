/**
 * Reasoning-capability filling for provider routes this plugin creates.
 *
 * A model's effort selector in the composer is driven by one thing on the
 * materialized model: `reasoning` + `thinkingLevelMap`, which `@deepseek-ai/dsh-llm-pi-ai`
 * derives from `entry.reasoningEfforts`. Omit that field and it falls back to the
 * *installed catalog* entry for the same provider key — which is empty for a
 * provider key this plugin just invented — so the model materializes as
 * `reasoning: false` and `dsh-client-ui-model-selection` renders
 * "This model provides no reasoning effort levels."
 *
 * Filling the field is therefore the difference between a route you can pick a
 * tier for and one you can also pick an effort on. Two sources, in this order:
 *
 *   1. evidence — the same model id, declared with `reasoningEfforts` somewhere
 *      else in the profile (another route, or another variant of the id such as
 *      `google/gemini-4-argon:flex` vs `google/gemini-4-argon`);
 *   2. fallback — the plugin's configured default map, applied to every model
 *      that has no evidence at all.
 *
 * Both are opt-out (`reasoningEfforts: false` disables filling entirely), and
 * neither ever overwrites a map the route already declares.
 */

/** Levels pi-ai accepts, in display order. `off` is the only one allowed to be null. */
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'max']

/**
 * Split an OpenRouter model id into its base id and variant suffix.
 *
 * OpenRouter serves variants as `vendor/model:variant` (`:flex`, `:nitro`,
 * `:floor`, `:online` …). The variant usually only changes routing or price,
 * not what the model can do, so a capability declared for one variant is the
 * best evidence available for its siblings.
 *
 * @param {string} id
 * @returns {{ base: string, variant: string | null }}
 */
export function splitModelId(id) {
  const value = typeof id === 'string' ? id.trim() : ''
  const index = value.lastIndexOf(':')
  if (index <= 0 || index === value.length - 1) return { base: value, variant: null }
  return { base: value.slice(0, index), variant: value.slice(index + 1) }
}

/**
 * Normalize the configured `reasoningEfforts` option.
 *
 * @param {unknown} raw
 * @returns {false | Readonly<Record<string, string | null>> | null} `false` disables
 *   filling, `null` keeps it evidence-only, an object is the blanket fallback.
 */
export function normalizeReasoningEfforts(raw) {
  if (raw === false) return false
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  /** @type {Record<string, string | null>} */
  const map = {}
  let thinking = false
  for (const level of REASONING_LEVELS) {
    if (!Object.hasOwn(raw, level)) continue
    const wire = raw[level]
    if (level === 'off') {
      if (wire === null) map.off = null
      else if (typeof wire === 'string' && wire.trim()) map.off = wire.trim()
      continue
    }
    if (typeof wire !== 'string' || !wire.trim()) continue
    map[level] = wire.trim()
    thinking = true
  }
  // A map with no level beyond `off` is invalid for pi-ai and useless here.
  return thinking ? map : null
}

/**
 * True when a value is a usable `reasoningEfforts` declaration: a map with at
 * least one level beyond `off` whose wire values are non-empty.
 *
 * @param {unknown} value
 */
export function isUsableReasoningEfforts(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value === false) return false
  let thinking = false
  for (const [level, wire] of Object.entries(value)) {
    if (!REASONING_LEVELS.includes(level)) continue
    if (level === 'off') continue
    if (typeof wire === 'string' && wire.trim()) thinking = true
  }
  return thinking
}

/**
 * Whether a model explicitly opted out of reasoning.
 *
 * `false` is the documented way to say "this model has no effort levels, never
 * fill it": the adapter then keeps the installed catalog's capability instead of
 * a declared one. It is not a gap, so no fill or repair may overwrite it.
 *
 * @param {any} model
 * @returns {boolean}
 */
export function optedOutOfReasoning(model) {
  return typeof model === 'object' && model !== null && model.reasoningEfforts === false
}

/**
 * Build the lookup of capabilities declared anywhere else in the profile.
 *
 * @param {Record<string, any>} providers - every provider route, keyed by name.
 * @returns {{ byId: Map<string, any>, byBase: Map<string, any> }}
 */
export function collectReasoningEvidence(providers) {
  const byId = new Map()
  const byBase = new Map()
  for (const route of Object.values(providers ?? {})) {
    if (typeof route !== 'object' || route === null) continue
    for (const model of Array.isArray(route.models) ? route.models : []) {
      if (typeof model !== 'object' || model === null) continue
      const id = typeof model.id === 'string' ? model.id.trim() : ''
      if (!id || !isUsableReasoningEfforts(model.reasoningEfforts)) continue
      const copy = structuredClone(model.reasoningEfforts)
      if (!byId.has(id)) byId.set(id, copy)
      const { base } = splitModelId(id)
      // A variant-specific declaration wins over a bare one; first writer wins.
      if (base && base !== id && !byBase.has(base)) byBase.set(base, copy)
      else if (base === id && !byBase.has(base)) byBase.set(base, copy)
    }
  }
  return { byId, byBase }
}

/**
 * Resolve the map to attach to one model id.
 *
 * @param {string} id
 * @param {{ byId: Map<string, any>, byBase: Map<string, any> }} evidence
 * @param {Readonly<Record<string, string | null>> | null} fallback
 * @returns {{ map: any, from: 'declared' | 'variant' | 'default' } | null}
 */
export function resolveReasoningFor(id, evidence, fallback) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (value) {
    if (evidence.byId.has(value)) return { map: structuredClone(evidence.byId.get(value)), from: 'declared' }
    const { base } = splitModelId(value)
    if (base && evidence.byBase.has(base)) return { map: structuredClone(evidence.byBase.get(base)), from: 'variant' }
  }
  if (fallback) return { map: structuredClone(fallback), from: 'default' }
  return null
}

/**
 * Model ids in a route that carry no reasoning capability.
 *
 * @param {any} route
 * @returns {string[]}
 */
export function modelsMissingReasoning(route) {
  if (typeof route !== 'object' || route === null) return []
  const missing = []
  for (const model of Array.isArray(route.models) ? route.models : []) {
    if (typeof model !== 'object' || model === null) continue
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    if (optedOutOfReasoning(model)) continue
    if (!isUsableReasoningEfforts(model.reasoningEfforts)) missing.push(id)
  }
  return missing
}

/**
 * Return a copy of `route` whose models all declare `reasoningEfforts`.
 *
 * Models that already declare a usable map are left byte-identical; models with
 * no resolvable map are left as they are and reported as `unresolved`, so the
 * caller can tell the operator which ids need a hand-written capability.
 *
 * @param {any} route
 * @param {{ evidence: { byId: Map<string, any>, byBase: Map<string, any> }, fallback: Readonly<Record<string, string | null>> | null }} options
 * @returns {{ route: any, filled: { id: string, from: 'declared' | 'variant' | 'default' }[], unresolved: string[] }}
 */
export function fillReasoning(route, options) {
  const source = typeof route === 'object' && route !== null ? route : {}
  const next = structuredClone(source)
  const filled = []
  const unresolved = []
  if (!Array.isArray(next.models)) return { route: next, filled, unresolved }
  for (const model of next.models) {
    if (typeof model !== 'object' || model === null) continue
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    if (optedOutOfReasoning(model)) continue
    if (isUsableReasoningEfforts(model.reasoningEfforts)) continue
    const resolved = resolveReasoningFor(id, options.evidence, options.fallback)
    if (resolved === null) {
      unresolved.push(id)
      continue
    }
    model.reasoningEfforts = resolved.map
    filled.push({ id, from: resolved.from })
  }
  return { route: next, filled, unresolved }
}
