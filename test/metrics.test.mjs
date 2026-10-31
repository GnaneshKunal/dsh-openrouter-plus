/**
 * Unit tests for the cost half of the telemetry.
 *
 * `at` is injected everywhere: the module buckets by the LOCAL calendar day, so a
 * fixture that used `Date.now()` would only be correct until the next midnight. Every
 * money assertion is an exact decimal the module itself rounds to, which is the same
 * value a person reads off the card.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { USAGE_DAY_LIMIT, USAGE_MODEL_LIMIT, createMetrics } from '../lib/metrics.js'

/**
 * Local noon of the day containing `at`, shifted by `offset` days. Noon rather than
 * midnight: a timezone whose clocks move still cannot land on a neighbour's date.
 *
 * @param {number} at
 * @param {number} [offset]
 */
function localDay(at, offset = 0) {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12, 0, 0, 0).getTime()
}

/** The local-day key for a timestamp, built without the module under test. */
function localDate(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Captured once, so "today" cannot drift between two `localDay(0)` calls. */
const NOW = Date.now()

test('cost is summed only from what a response actually reported', () => {
  const metrics = createMetrics()
  metrics.record({ model: 'a', promptTokens: 10, completionTokens: 5, costUsd: 0.0012 })
  metrics.record({ model: 'a', promptTokens: 10, completionTokens: 5, costUsd: null })

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.costUsd, 0.0012, 'an unreported amount adds no money')
  assert.equal(snapshot.todayUsd, 0.0012)
  assert.equal(snapshot.requests, 2)
  assert.equal(snapshot.promptTokens, 20, 'the unreported call still moved the token counters')
  // The recent row keeps the raw value, which is how the dialog says "not reported".
  assert.equal(snapshot.recent[0].costUsd, null)
  assert.equal(snapshot.recent[1].costUsd, 0.0012)
  assert.equal(snapshot.days[0].costUsd, 0.0012)
})

test('days are local calendar days, listed newest first', () => {
  const metrics = createMetrics()
  const yesterday = localDay(NOW, -1)
  const today = localDay(NOW, 0)
  metrics.record({ at: yesterday, model: 'm', promptTokens: 100, completionTokens: 50, costUsd: 0.25 })
  metrics.record({ at: today, model: 'm', promptTokens: 10, completionTokens: 5, costUsd: 0.75 })
  metrics.record({ at: today, model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.25 })

  const snapshot = metrics.snapshot()
  assert.deepEqual(snapshot.days.map((day) => day.date), [localDate(today), localDate(yesterday)])
  assert.equal(snapshot.days[0].costUsd, 1, 'both of today\'s requests land in one bucket')
  assert.equal(snapshot.days[0].requests, 2)
  assert.equal(snapshot.days[1].costUsd, 0.25)
  assert.equal(snapshot.costUsd, 1.25, 'the window total, across buckets')
  assert.equal(snapshot.todayUsd, 1, 'today means the local day in progress')
  // Exported so a caller can put a timestamp in the same bucket the module would.
  assert.equal(metrics.dayKey(today), localDate(today))
})

test('byModel is today and byModelAll is the retained window', () => {
  const metrics = createMetrics()
  const yesterday = localDay(NOW, -1)
  const today = localDay(NOW, 0)
  metrics.record({ at: yesterday, model: 'old/model', promptTokens: 10, completionTokens: 10, costUsd: 2 })
  metrics.record({
    at: today,
    model: 'asked/model',
    servedModel: 'served/model',
    promptTokens: 10,
    completionTokens: 10,
    costUsd: 1,
  })

  const snapshot = metrics.snapshot()
  assert.deepEqual(snapshot.byModel.map((row) => row.model), ['served/model'], 'only the day in progress')
  assert.deepEqual(snapshot.byModelAll.map((row) => row.model), ['old/model', 'served/model'], 'the whole window')
  // The model that answered is what was billed, so it is the row's identity.
  assert.equal(snapshot.byModel[0].requests, 1)
  assert.equal(snapshot.byModelAll[0].costUsd, 2)
  assert.equal(snapshot.byModelAll[1].costUsd, 1)
})

test('model rows sort by spend, then by tokens', () => {
  const metrics = createMetrics()
  const at = localDay(NOW, 0)
  metrics.record({ at, model: 'cheap-busy', promptTokens: 1000, completionTokens: 1000, costUsd: null })
  metrics.record({ at, model: 'pricier-quiet', promptTokens: 1, completionTokens: 1, costUsd: 0.01 })
  metrics.record({ at, model: 'cheap-idle', promptTokens: 5, completionTokens: 5, costUsd: 0 })

  const snapshot = metrics.snapshot()
  // Spend first, so a free model with traffic is not pushed under a cheap paid one;
  // tokens break the tie between the free rows.
  assert.deepEqual(
    snapshot.byModel.map((row) => row.model),
    ['pricier-quiet', 'cheap-busy', 'cheap-idle'],
  )
  assert.deepEqual(snapshot.byModelAll.map((row) => row.model), ['pricier-quiet', 'cheap-busy', 'cheap-idle'])
  assert.equal(snapshot.byModel[1].costUsd, 0)
  assert.equal(snapshot.byModel[1].promptTokens + snapshot.byModel[1].completionTokens, 2000)
})

test('byTier carries the real money next to the multiplier view', () => {
  const metrics = createMetrics({ tierMultipliers: { flex: 0.5 } })
  metrics.record({ tier: 'flex', promptTokens: 100, completionTokens: 100, costUsd: 0.4 })
  metrics.record({ tier: 'priority', promptTokens: 50, completionTokens: 50, costUsd: 0.8 })

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.byTier.flex.costUsd, 0.4)
  assert.equal(snapshot.byTier.priority.costUsd, 0.8)
  assert.equal(snapshot.byTier.flex.multiplier, 0.5)
  // A multiplier is a weight for comparing tiers; it is never allowed to stand in
  // for the billed amount.
  assert.equal(snapshot.byTier.flex.effectiveTokens, 100)
  assert.equal(snapshot.byTier.priority.effectiveTokens, 200)
  assert.equal(snapshot.effectiveMultiplier, 1)
  // A request that sent no tier still gets a bucket, under `unset`.
  metrics.record({ promptTokens: 10, completionTokens: 0, costUsd: 0 })
  assert.equal(metrics.snapshot().byTier.unset.multiplier, 1)
})

test('the day window is pruned at the limit, oldest first', () => {
  assert.equal(USAGE_DAY_LIMIT, 14)
  const metrics = createMetrics({ dayLimit: 3 })
  for (const offset of [-4, -3, -2, -1, 0]) {
    metrics.record({ at: localDay(NOW, offset), promptTokens: 1, costUsd: 0.1 })
  }

  const snapshot = metrics.snapshot()
  assert.deepEqual(
    snapshot.days.map((day) => day.date),
    [localDay(NOW, 0), localDay(NOW, -1), localDay(NOW, -2)].map(localDate),
  )
  assert.equal(snapshot.costUsd, 0.3, 'the dropped days took their money with them')

  // A late arrival older than the window is dropped as its own bucket is created:
  // keeping it would evict a day that is inside the window.
  metrics.record({ at: localDay(NOW, -30), promptTokens: 1, costUsd: 5 })
  const after = metrics.snapshot()
  assert.equal(after.days.some((day) => day.date === localDate(localDay(NOW, -30))), false)
  assert.equal(after.costUsd, 0.3)
})

test('one day keeps at most USAGE_MODEL_LIMIT models, dropping the cheapest', () => {
  assert.equal(USAGE_MODEL_LIMIT, 40)
  const metrics = createMetrics()
  const at = localDay(NOW, 0)
  for (let index = 0; index <= USAGE_MODEL_LIMIT; index += 1) {
    metrics.record({ at, model: `model-${index}`, promptTokens: 1, costUsd: 0.0001 * (index + 1) })
  }

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.byModel.length, USAGE_MODEL_LIMIT)
  assert.equal(snapshot.byModel.some((row) => row.model === 'model-0'), false, 'the cheapest was dropped')
  assert.equal(snapshot.byModel[0].model, `model-${USAGE_MODEL_LIMIT}`)
  // The cap is a display rollup, not accounting: the day still counted every request.
  assert.equal(snapshot.days[0].requests, USAGE_MODEL_LIMIT + 1)
  assert.equal(snapshot.requests, USAGE_MODEL_LIMIT + 1)
})

test('exportState/hydrate round-trips the whole telemetry snapshot', () => {
  const metrics = createMetrics()
  const yesterday = localDay(NOW, -1)
  const today = localDay(NOW, 0)
  metrics.record({
    at: yesterday,
    model: 'm1',
    promptTokens: 3,
    completionTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
    costUsd: 0.2,
  })
  metrics.record({ at: today, model: 'm2', promptTokens: 1, completionTokens: 2, costUsd: 0.3 })

  const state = metrics.exportState()
  assert.equal(state.version, 2)
  assert.deepEqual(state.days.map((day) => day.date), [localDate(yesterday), localDate(today)], 'oldest first on disk')

  const restored = createMetrics()
  restored.hydrate(state)
  const before = metrics.snapshot()
  const after = restored.snapshot()
  assert.equal(after.costUsd, before.costUsd)
  assert.equal(after.todayUsd, before.todayUsd)
  assert.deepEqual(after.byModel, before.byModel)
  assert.deepEqual(after.byModelAll, before.byModelAll)
  assert.deepEqual(after.days, before.days)
  // Cache-token rollups are part of a day, so they survive the reload too.
  const cached = after.byModelAll.find((row) => row.model === 'm1')
  assert.equal(cached.cacheReadTokens, 5)
  assert.equal(cached.cacheWriteTokens, 6)
  // Counters, the recent ring and the session rollup are persisted too: the dialog must not
  // open empty after a restart, which is exactly what a day-only file used to cause.
  assert.deepEqual(after.recent, before.recent)
  assert.equal(after.requests, before.requests)
  assert.deepEqual(after.bySession, before.bySession)
})

test('hydrate ignores malformed rows instead of poisoning the snapshot', () => {
  const metrics = createMetrics()
  metrics.record({ model: 'live', promptTokens: 1, costUsd: 0.5 })
  metrics.hydrate({
    days: [
      null,
      'not a day',
      { date: 'not-a-date', costUsd: 9 },
      { date: '2026-2-3', costUsd: 9 },
      {
        date: '2026-02-03',
        requests: 'many',
        promptTokens: -5,
        completionTokens: 'x',
        costUsd: -1,
        models: [null, { model: '' }, { model: 'kept', promptTokens: -2, costUsd: 'free' }],
      },
    ],
  })

  const snapshot = metrics.snapshot()
  // Hydrate replaces the table, so the bucket recorded before it is gone on purpose:
  // it is called at start, before traffic exists.
  assert.deepEqual(snapshot.days.map((day) => day.date), ['2026-02-03'])
  assert.equal(snapshot.days[0].requests, 0, 'an unusable count becomes the documented zero')
  assert.equal(snapshot.days[0].costUsd, 0)
  assert.deepEqual(snapshot.byModelAll.map((row) => row.model), ['kept'])
  assert.equal(snapshot.byModelAll[0].costUsd, 0)
  assert.equal(snapshot.byModelAll[0].promptTokens, 0)

  // A non-object state is the same as an empty one, never a throw at boot.
  metrics.hydrate(null)
  assert.deepEqual(metrics.snapshot().days, [])
  assert.equal(metrics.snapshot().costUsd, 0)
})

test('the recent ring is bounded and keeps the per-request identity fields', () => {
  const metrics = createMetrics({ recentLimit: 3 })
  for (let index = 0; index < 5; index += 1) {
    metrics.record({
      at: 1_000 + index,
      tier: 'flex',
      preset: 'fastest',
      model: 'asked/model',
      servedModel: 'served/model',
      servedTier: 'priority',
      sessionId: 'session-1',
      status: 200,
      ms: 12,
      bytes: 9,
      streaming: true,
      promptTokens: 10,
      completionTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
      costUsd: 0.01,
      upstreamCostUsd: 0.008,
      upstreamPromptCostUsd: 0.004,
      upstreamCompletionCostUsd: 0.005,
      serverToolCostUsd: 0.001,
      byok: true,
      genId: 'gen-abc',
    })
  }

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.recent.length, 3, 'the ring never grows past recentLimit')
  assert.deepEqual(snapshot.recent.map((row) => row.at), [1_004, 1_003, 1_002], 'newest first')
  const row = snapshot.recent[0]
  assert.equal(row.tier, 'flex')
  assert.equal(row.preset, 'fastest')
  assert.equal(row.model, 'asked/model')
  assert.equal(row.servedModel, 'served/model')
  assert.equal(row.servedTier, 'priority')
  assert.equal(row.sessionId, 'session-1')
  assert.equal(row.status, 200)
  assert.equal(row.ms, 12)
  assert.equal(row.bytes, 9)
  assert.equal(row.streaming, true)
  assert.equal(row.promptTokens, 10)
  assert.equal(row.completionTokens, 5)
  assert.equal(row.cacheReadTokens, 2)
  assert.equal(row.cacheWriteTokens, 3)
  assert.equal(row.reasoningTokens, 4)
  assert.equal(row.costUsd, 0.01)
  assert.equal(row.upstreamCostUsd, 0.008)
  // The upstream leg's prompt/completion split is forwarded under the short names the
  // dialog reads, so it does not have to know the relay's `upstream*` spelling.
  assert.equal(row.promptCostUsd, 0.004)
  assert.equal(row.completionCostUsd, 0.005)
  assert.equal(row.serverToolCostUsd, 0.001)
  assert.equal(row.byok, true)
  assert.equal(row.genId, 'gen-abc')

  // A caller that already speaks the short names is taken as-is.
  metrics.record({ at: 1_005, model: 'short/model', promptCostUsd: 0.006 })
  assert.equal(metrics.snapshot().recent[0].promptCostUsd, 0.006)
  assert.equal(metrics.snapshot().recent[0].completionCostUsd, null)
})

test('null means not reported and zero means free', () => {
  const metrics = createMetrics()
  const at = localDay(NOW, 0)
  metrics.record({ at, model: 'free/model', promptTokens: 10, completionTokens: 5, costUsd: 0 })
  metrics.record({ at, model: 'silent/model', promptTokens: 1, completionTokens: 1, costUsd: null })

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.recent[0].costUsd, null, 'the response said nothing, so the row says null')
  assert.equal(snapshot.recent[1].costUsd, 0, 'a free endpoint is a real zero')
  assert.equal(snapshot.costUsd, 0, 'neither is money')
  // A free model with traffic is still a row: "cost 0" is an answer worth drawing.
  const free = snapshot.byModel.find((row) => row.model === 'free/model')
  assert.ok(free)
  assert.equal(free.costUsd, 0)
  assert.equal(free.costUsd === 0 && snapshot.recent[0].costUsd === null, true)
})

test('a call that reported nothing moves the request count, not a model row', () => {
  const metrics = createMetrics()
  const at = localDay(NOW, 0)
  metrics.record({ at, model: 'failed/model', status: 502 })

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.requests, 1)
  assert.equal(snapshot.errors, 1)
  assert.deepEqual(snapshot.days.map((day) => day.date), [localDate(at)])
  assert.equal(snapshot.days[0].requests, 1, 'the day still counts the attempt')
  assert.equal(snapshot.todayUsd, 0)
  // No tokens and no money: a row here would be an empty line that pushes a real
  // model down the card.
  assert.deepEqual(snapshot.byModel, [])
  assert.deepEqual(snapshot.byModelAll, [])
})

test('bySession sums spend per relayed session and recent rows carry the provider', () => {
  const metrics = createMetrics()
  const now = Date.now()
  metrics.record({ at: now, model: 'a/one', providerName: 'DeepInfra', sessionId: 'session-a', promptTokens: 10, completionTokens: 2, costUsd: 0.5 })
  metrics.record({ at: now, model: 'a/one', providerName: 'Together', sessionId: 'session-a', promptTokens: 10, completionTokens: 2, costUsd: 0.25 })
  metrics.record({ at: now, model: 'a/two', sessionId: 'session-b', promptTokens: 4, completionTokens: 1, costUsd: 0.1 })
  const snapshot = metrics.snapshot()
  assert.deepEqual(
    snapshot.bySession.map((row) => [row.session, row.requests, row.costUsd]),
    [['session-a', 2, 0.75], ['session-b', 1, 0.1]],
  )
  const together = snapshot.recent.find((row) => row.providerName === 'Together')
  assert.ok(together, 'the recent ring keeps the provider that answered')
  assert.equal(together.sessionId, 'session-a')
})
