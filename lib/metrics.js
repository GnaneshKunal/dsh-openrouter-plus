/**
 * Aggregated relay telemetry.
 *
 * The relay does not know per-model prices and must not pretend to: it reports
 * *token-weighted multipliers* instead of invented dollar amounts. `flex` at 0.5×
 * means "this traffic would have cost twice as much at list price".
 */

/** @type {Record<string, number>} */
export const DEFAULT_TIER_MULTIPLIERS = {
  flex: 0.5,
  scale: 1,
  auto: 1,
  default: 1,
  priority: 2,
  fast: 2,
  ultrafast: 4,
}

/**
 * @param {object} [options]
 * @param {number} [options.recentLimit=50]
 * @param {Record<string, number>} [options.tierMultipliers]
 */
export function createMetrics(options = {}) {
  const recentLimit = Number.isInteger(options.recentLimit) && options.recentLimit > 0
    ? options.recentLimit
    : 50
  const multipliers = { ...DEFAULT_TIER_MULTIPLIERS, ...(options.tierMultipliers ?? {}) }
  const startedAt = Date.now()

  /** Totals. */
  let requests = 0
  let errors = 0
  let streamingRequests = 0
  let promptTokens = 0
  let completionTokens = 0
  let bytes = 0

  /** @type {Map<string, { requests: number, promptTokens: number, completionTokens: number }>} */
  const tiers = new Map()

  /** @type {object[]} newest first, capped at recentLimit */
  const recent = []

  /** @param {string|null|undefined} tier */
  function multiplierFor(tier) {
    if (!tier) return 1
    const value = multipliers[tier]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  }

  /**
   * Record one proxied request.
   *
   * @param {{
   *   at?: number, tier?: string|null, model?: string|null, status?: number,
   *   ms?: number, bytes?: number, streaming?: boolean,
   *   promptTokens?: number|null, completionTokens?: number|null,
   * }} entry
   */
  function record(entry) {
    const prompt = toCount(entry.promptTokens)
    const completion = toCount(entry.completionTokens)
    const size = toCount(entry.bytes)
    const status = Number.isInteger(entry.status) ? entry.status : 0
    const key = entry.tier ?? 'unset'

    requests += 1
    if (status >= 400) errors += 1
    if (entry.streaming) streamingRequests += 1
    promptTokens += prompt
    completionTokens += completion
    bytes += size

    const bucket = tiers.get(key) ?? { requests: 0, promptTokens: 0, completionTokens: 0 }
    bucket.requests += 1
    bucket.promptTokens += prompt
    bucket.completionTokens += completion
    tiers.set(key, bucket)

    recent.unshift({
      at: Number.isFinite(entry.at) ? entry.at : Date.now(),
      // `tier` is the wire field that was sent, if any; `preset` is the outcome a person
      // picked, which is what the page shows (a sort preset sends no tier at all).
      tier: entry.tier ?? null,
      preset: typeof entry.preset === 'string' && entry.preset !== '' ? entry.preset : null,
      model: typeof entry.model === 'string' ? entry.model : null,
      status,
      ms: toCount(entry.ms),
      bytes: size,
      streaming: Boolean(entry.streaming),
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
    })
    if (recent.length > recentLimit) recent.length = recentLimit
  }

  /** Cheap, non-throwing snapshot for a stats endpoint polled every few seconds. */
  function snapshot() {
    /** @type {Record<string, object>} */
    const byTier = {}
    let weightedTokens = 0
    let totalTokens = 0

    for (const [tier, bucket] of tiers) {
      const multiplier = multiplierFor(tier === 'unset' ? null : tier)
      const tokens = bucket.promptTokens + bucket.completionTokens
      byTier[tier] = {
        requests: bucket.requests,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        tokens,
        multiplier,
        effectiveTokens: Math.round(tokens * multiplier),
      }
      weightedTokens += tokens * multiplier
      totalTokens += tokens
    }

    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      requests,
      errors,
      streamingRequests,
      promptTokens,
      completionTokens,
      tokens: totalTokens,
      bytes,
      byTier,
      effectiveMultiplier: totalTokens > 0 ? round(weightedTokens / totalTokens) : 0,
      tierMultipliers: { ...multipliers },
      recent: recent.slice(),
    }
  }

  return { record, snapshot, recentLimit }
}

/** @param {unknown} value */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000
}
