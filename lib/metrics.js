/**
 * Aggregated relay telemetry.
 *
 * Two different facts live here, and the code keeps them apart on purpose:
 *
 * - **Cost** is what OpenRouter actually charged. It is read off each response's
 *   `usage.cost`, which is authoritative per request: it already reflects the endpoint
 *   that served the call — flex, priority, ultrafast, a cheap `:floor` endpoint, an
 *   upstream fallback — and no token×price table can reconstruct that after the fact.
 *   It is kept in local-day buckets so a Host reload hydrates rather than showing zero.
 * - **Tokens** are counters since this process started, plus a `multiplier` view used
 *   only to compare tiers with each other. A multiplier is a weight, not money, and it
 *   is never allowed to stand in for `costUsd`.
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

/** How many local days of cost are retained and persisted. */
export const USAGE_DAY_LIMIT = 14

/** How many sessions the in-memory rollup keeps (the costliest are kept). */
export const SESSION_ROLLUP_LIMIT = 100

/** How many distinct models one day keeps before the cheapest tail is dropped. */
export const USAGE_MODEL_LIMIT = 40

/**
 * @param {object} [options]
 * @param {number} [options.recentLimit=50]
 * @param {Record<string, number>} [options.tierMultipliers]
 * @param {number} [options.dayLimit=USAGE_DAY_LIMIT]
 */
export function createMetrics(options = {}) {
  const recentLimit = Number.isInteger(options.recentLimit) && options.recentLimit > 0
    ? options.recentLimit
    : 50
  const dayLimit = Number.isInteger(options.dayLimit) && options.dayLimit > 0
    ? options.dayLimit
    : USAGE_DAY_LIMIT
  const multipliers = { ...DEFAULT_TIER_MULTIPLIERS, ...(options.tierMultipliers ?? {}) }
  const startedAt = Date.now()

  /** Counters since start. Tokens only; cost is day-based (see snapshot). */
  let requests = 0
  let errors = 0
  let streamingRequests = 0
  let promptTokens = 0
  let completionTokens = 0
  let bytes = 0

  /** @type {Map<string, { requests: number, promptTokens: number, completionTokens: number, costUsd: number }>} */
  const tiers = new Map()

  /**
   * Spend per relayed session. The relay knows the session from the request envelope, so a
   * session's bill can be summed without joining anything; like `byTier` this is
   * process-local (the persisted buckets are per day, not per session).
   */
  const sessions = new Map()

  /**
   * Local-day buckets. `models` is a per-day rollup so "Today" can still list rows
   * after a restart; a Map keeps the hot path allocation-free.
   *
   * @type {Map<string, { date: string, requests: number, promptTokens: number,
   *   completionTokens: number, costUsd: number,
   *   models: Map<string, { requests: number, promptTokens: number, completionTokens: number,
   *     cacheReadTokens: number, cacheWriteTokens: number, costUsd: number }> }>}
   */
  const days = new Map()

  /** @type {object[]} newest first, capped at recentLimit */
  const recent = []

  /** @param {string|null|undefined} tier */
  function multiplierFor(tier) {
    if (!tier) return 1
    const value = multipliers[tier]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  }

  /**
   * The local calendar day an event belongs to. Local, not UTC: every surface that
   * reads this ("today", the sidebar card) is phrased in the user's own day.
   *
   * @param {number} atMs
   */
  function dayKey(atMs) {
    const date = new Date(Number.isFinite(atMs) ? atMs : Date.now())
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  /** @param {string} date */
  function dayBucket(date) {
    let bucket = days.get(date)
    if (bucket === undefined) {
      bucket = { date, requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, models: new Map() }
      days.set(date, bucket)
      trimDays()
    }
    return bucket
  }

  /**
   * Keep the retained window bounded. Sorting date strings works because the keys are
   * zero-padded `YYYY-MM-DD`.
   */
  function trimDays() {
    if (days.size <= dayLimit) return
    const ordered = [...days.keys()].sort()
    for (const date of ordered.slice(0, days.size - dayLimit)) days.delete(date)
  }

  /**
   * @param {{ models: Map<string, { costUsd: number }> }} day
   */
  function trimModels(day) {
    if (day.models.size <= USAGE_MODEL_LIMIT) return
    const ordered = [...day.models.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd)
    for (const [name] of ordered.slice(USAGE_MODEL_LIMIT)) day.models.delete(name)
  }

  /**
   * Record one proxied request.
   *
   * `costUsd` stays nullable on purpose: a call that failed, or a stream the caller
   * aborted before the usage chunk, has no billed amount to report, and inventing zero
   * would be a claim. The recent row keeps it empty so the dialog can say "not reported".
   *
   * @param {{
   *   at?: number, tier?: string|null, preset?: string|null, model?: string|null,
   *   servedModel?: string|null, servedTier?: string|null, providerName?: string|null, sessionId?: string|null,
   *   status?: number, ms?: number, bytes?: number, streaming?: boolean,
   *   promptTokens?: number|null, completionTokens?: number|null,
   *   cacheReadTokens?: number|null, cacheWriteTokens?: number|null,
   *   reasoningTokens?: number|null, costUsd?: number|null, upstreamCostUsd?: number|null,
   *   serverToolCostUsd?: number|null, byok?: boolean, genId?: string|null,
   * }} entry
   */
  function record(entry) {
    const prompt = toCount(entry.promptTokens)
    const completion = toCount(entry.completionTokens)
    const cacheRead = toCount(entry.cacheReadTokens)
    const cacheWrite = toCount(entry.cacheWriteTokens)
    const size = toCount(entry.bytes)
    const status = Number.isInteger(entry.status) ? entry.status : 0
    const key = entry.tier ?? 'unset'
    const at = Number.isFinite(entry.at) ? Number(entry.at) : Date.now()
    const cost = toMoney(entry.costUsd)

    requests += 1
    if (status >= 400) errors += 1
    if (entry.streaming) streamingRequests += 1
    promptTokens += prompt
    completionTokens += completion
    bytes += size

    const bucket = tiers.get(key) ?? { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }
    bucket.requests += 1
    bucket.promptTokens += prompt
    bucket.completionTokens += completion
    bucket.costUsd += cost
    tiers.set(key, bucket)

    // Only billed rows move the money. The token counters still count every record,
    // because a failed call did spend whatever reached the provider before it broke.
    const day = dayBucket(dayKey(at))
    day.requests += 1
    day.promptTokens += prompt
    day.completionTokens += completion
    day.costUsd += cost
    const sessionId = nonEmpty(entry.sessionId)
    if (sessionId !== null) {
      const session = sessions.get(sessionId) ?? {
        session: sessionId,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        lastAt: 0,
      }
      session.requests += 1
      session.promptTokens += prompt
      session.completionTokens += completion
      session.costUsd += cost
      session.lastAt = Math.max(session.lastAt, at)
      sessions.set(sessionId, session)
      if (sessions.size > SESSION_ROLLUP_LIMIT) {
        const oldest = [...sessions.values()].sort((left, right) => left.lastAt - right.lastAt)
        for (const row of oldest.slice(0, sessions.size - SESSION_ROLLUP_LIMIT)) sessions.delete(row.session)
      }
    }

    const modelName = nonEmpty(entry.servedModel) ?? nonEmpty(entry.model)
    // A failed call has a model but nothing to say about it: no tokens, no money. Creating
    // a row for it would put an empty line on the card and push a real model down.
    const modelTokens = prompt + completion + cacheRead + cacheWrite
    if (modelName !== null && (modelTokens > 0 || cost > 0)) {
      const model = day.models.get(modelName) ?? {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      }
      model.requests += 1
      model.promptTokens += prompt
      model.completionTokens += completion
      model.cacheReadTokens += cacheRead
      model.cacheWriteTokens += cacheWrite
      model.costUsd += cost
      day.models.set(modelName, model)
      trimModels(day)
    }

    recent.unshift({
      at,
      // `tier` is the wire field that was sent, if any; `preset` is the outcome a person
      // picked, which is what the page shows (a sort preset sends no tier at all).
      tier: entry.tier ?? null,
      preset: nonEmpty(entry.preset),
      model: nonEmpty(entry.model),
      servedModel: nonEmpty(entry.servedModel),
      servedTier: nonEmpty(entry.servedTier),
      sessionId: nonEmpty(entry.sessionId),
      providerName: nonEmpty(entry.providerName),
      status,
      ms: toCount(entry.ms),
      bytes: size,
      streaming: Boolean(entry.streaming),
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      cacheReadTokens: entry.cacheReadTokens ?? null,
      cacheWriteTokens: entry.cacheWriteTokens ?? null,
      reasoningTokens: entry.reasoningTokens ?? null,
      costUsd: entry.costUsd ?? null,
      upstreamCostUsd: entry.upstreamCostUsd ?? null,
      // The per-side split the dialog shows when the response carried one. The relay
      // names them upstream*; the page reads the short names first.
      promptCostUsd: entry.promptCostUsd ?? entry.upstreamPromptCostUsd ?? null,
      completionCostUsd: entry.completionCostUsd ?? entry.upstreamCompletionCostUsd ?? null,
      serverToolCostUsd: entry.serverToolCostUsd ?? null,
      byok: entry.byok === true,
      genId: nonEmpty(entry.genId),
    })
    if (recent.length > recentLimit) recent.length = recentLimit
  }

  /**
   * Cheap, non-throwing snapshot for a stats endpoint polled every few seconds.
   *
   * Cost is summed across the retained day buckets, so the number survives a reload
   * and "today" means the local calendar day rather than "since this process started".
   */
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
        costUsd: roundMoney(bucket.costUsd),
      }
      weightedTokens += tokens * multiplier
      totalTokens += tokens
    }

    const todayKey = dayKey(Date.now())
    let costUsd = 0
    /** @type {object[]} */
    const dayRows = []
    /**
     * @type {Map<string, { model: string, requests: number, promptTokens: number,
     *   completionTokens: number, cacheReadTokens: number, cacheWriteTokens: number,
     *   costUsd: number }>}
     */
    const allModels = new Map()

    for (const day of days.values()) {
      costUsd += day.costUsd
      dayRows.push({
        date: day.date,
        requests: day.requests,
        promptTokens: day.promptTokens,
        completionTokens: day.completionTokens,
        costUsd: roundMoney(day.costUsd),
      })
      for (const [model, bucket] of day.models) {
        const into = allModels.get(model) ?? {
          model,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        }
        into.requests += bucket.requests
        into.promptTokens += bucket.promptTokens
        into.completionTokens += bucket.completionTokens
        into.cacheReadTokens += bucket.cacheReadTokens
        into.cacheWriteTokens += bucket.cacheWriteTokens
        into.costUsd += bucket.costUsd
        allModels.set(model, into)
      }
    }
    // Newest first: the page draws a short "last N days" strip, not a calendar.
    dayRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

    const todayBucket = days.get(todayKey)
    const todayModels = todayBucket === undefined
      ? []
      : [...todayBucket.models.entries()].map(([model, bucket]) => ({
        model,
        requests: bucket.requests,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        costUsd: roundMoney(bucket.costUsd),
      }))

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
      // Money, not multipliers: what OpenRouter charged across the retained window,
      // and how much of it belongs to the local day in progress.
      costUsd: roundMoney(costUsd),
      todayUsd: roundMoney(todayBucket === undefined ? 0 : todayBucket.costUsd),
      byTier,
      byModel: sortByCost(todayModels),
      byModelAll: sortByCost([...allModels.values()].map((row) => ({ ...row, costUsd: roundMoney(row.costUsd) }))),
      /* Newest-first is wrong here: the question is "which session cost most", so cost
         leads and recency only breaks ties. */
      bySession: [...sessions.values()]
        .map((row) => ({ ...row, costUsd: roundMoney(row.costUsd) }))
        .sort((left, right) => (right.costUsd - left.costUsd) || (right.lastAt - left.lastAt))
        .slice(0, SESSION_ROLLUP_LIMIT),
      days: dayRows,
      effectiveMultiplier: totalTokens > 0 ? round(weightedTokens / totalTokens) : 0,
      tierMultipliers: { ...multipliers },
      recent: recent.slice(),
    }
  }

  /**
   * The persisted half of this module: local-day buckets only. Counters and the recent
   * ring stay process-local — replaying request rows after a reload would attribute them
   * to requests that no longer exist.
   *
   * @returns {{ version: 1, days: object[] }}
   */
  function exportState() {
    return {
      version: 2,
      /* Everything a reload would otherwise forget: the counters, the tier split, the
         session rollup and the recent ring. Cost alone surviving was an accident of what
         the first version needed; the dialog is useless with an empty log. */
      counters: { requests, errors, streamingRequests, promptTokens, completionTokens, bytes },
      tiers: [...tiers.entries()].map(([tier, bucket]) => ({ tier, ...bucket })),
      sessions: [...sessions.values()],
      recent: recent.slice(),
      days: [...days.values()]
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((day) => ({
          date: day.date,
          requests: day.requests,
          promptTokens: day.promptTokens,
          completionTokens: day.completionTokens,
          costUsd: day.costUsd,
          models: [...day.models.entries()].map(([model, bucket]) => ({ model, ...bucket })),
        })),
    }
  }

  /**
   * Replace the day table with a decoded snapshot. Called at start, before traffic is
   * expected, so replacement cannot lose a live bucket; malformed rows are skipped
   * rather than allowed to poison every later snapshot.
   *
   * @param {{ days?: object[], counters?: object, tiers?: object[], sessions?: object[], recent?: object[] } | null} state
   */
  function hydrate(state) {
    const counters = state?.counters ?? {}
    requests = toCount(counters.requests)
    errors = toCount(counters.errors)
    streamingRequests = toCount(counters.streamingRequests)
    promptTokens = toCount(counters.promptTokens)
    completionTokens = toCount(counters.completionTokens)
    bytes = toCount(counters.bytes)

    tiers.clear()
    for (const row of Array.isArray(state?.tiers) ? state.tiers : []) {
      const tier = nonEmpty(row?.tier) ?? 'unset'
      tiers.set(tier, {
        requests: toCount(row.requests),
        promptTokens: toCount(row.promptTokens),
        completionTokens: toCount(row.completionTokens),
        costUsd: toMoney(row.costUsd),
      })
    }

    sessions.clear()
    for (const row of Array.isArray(state?.sessions) ? state.sessions : []) {
      const session = nonEmpty(row?.session)
      if (session === null) continue
      sessions.set(session, {
        session,
        requests: toCount(row.requests),
        promptTokens: toCount(row.promptTokens),
        completionTokens: toCount(row.completionTokens),
        costUsd: toMoney(row.costUsd),
        lastAt: toCount(row.lastAt),
      })
    }

    recent.length = 0
    for (const row of Array.isArray(state?.recent) ? state.recent : []) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      if (!Number.isFinite(row.at)) continue
      recent.push(row)
      if (recent.length >= recentLimit) break
    }

    const rows = Array.isArray(state?.days) ? state.days : []
    days.clear()
    for (const row of rows) {
      const date = typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null
      if (date === null) continue
      const bucket = {
        date,
        requests: toCount(row.requests),
        promptTokens: toCount(row.promptTokens),
        completionTokens: toCount(row.completionTokens),
        costUsd: toMoney(row.costUsd),
        models: new Map(),
      }
      for (const model of Array.isArray(row.models) ? row.models : []) {
        const name = nonEmpty(model?.model)
        if (name === null) continue
        bucket.models.set(name, {
          requests: toCount(model.requests),
          promptTokens: toCount(model.promptTokens),
          completionTokens: toCount(model.completionTokens),
          cacheReadTokens: toCount(model.cacheReadTokens),
          cacheWriteTokens: toCount(model.cacheWriteTokens),
          costUsd: toMoney(model.costUsd),
        })
      }
      days.set(date, bucket)
    }
    trimDays()
  }

  return { record, snapshot, exportState, hydrate, dayKey, recentLimit, dayLimit }
}

/** @param {unknown} value */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Money keeps full precision; only absurd or non-finite values are dropped, because a
 * wrong cost is worse than a missing one.
 *
 * @param {unknown} value
 */
function toMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e6 ? value : 0
}

/** @param {number} value */
function roundMoney(value) {
  return Math.round(value * 1e9) / 1e9
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Sort a model rollup by spend, then by tokens, so a free model with traffic is not
 * pushed off the card by a cheap paid one.
 *
 * @param {object[]} rows
 */
function sortByCost(rows) {
  return rows.sort((a, b) => (b.costUsd - a.costUsd)
    || ((b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens)))
}
