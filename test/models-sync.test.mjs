import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MODEL_LISTING_MAX_BYTES,
  annotateLive,
  isModelListing,
  readLiveModels,
  selectModels,
  synthesizeModel,
} from '../lib/models-sync.js'

/** One OpenRouter `/models` entry, trimmed to the fields this plugin reads. */
function liveEntry(id, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    context_length: overrides.context_length ?? 1048576,
    architecture: { input_modalities: overrides.input_modalities ?? ['text'] },
    top_provider: {
      context_length: overrides.top_context ?? 1048576,
      max_completion_tokens: overrides.max_completion_tokens ?? 943718,
    },
  }
}

// ---------------------------------------------------------------------------
// listing detection
// ---------------------------------------------------------------------------

test('isModelListing accepts both listing shapes and nothing else', () => {
  assert.equal(isModelListing({ data: [] }), true)
  assert.equal(isModelListing({ models: [] }), true)
  // A proxy error page or an unrelated JSON body must not read as an empty catalog.
  assert.equal(isModelListing({ error: { message: 'unauthorized' } }), false)
  assert.equal(isModelListing({}), false)
  assert.equal(isModelListing(null), false)
  assert.equal(isModelListing([]), false)
  assert.equal(isModelListing('{}'), false)
})

// ---------------------------------------------------------------------------
// reading the live listing
// ---------------------------------------------------------------------------

test('readLiveModels keeps upstream order and maps the fields a route needs', () => {
  const { models } = readLiveModels({
    data: [
      liveEntry('moonshotai/kimi-k3.1-pro', { name: 'MoonshotAI: Kimi K3.1 Pro', input_modalities: ['text', 'image', 'video'] }),
      liveEntry('deepseek/deepseek-v4.1-flash-1017', { name: 'DeepSeek: V4.1 Flash' }),
    ],
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['moonshotai/kimi-k3.1-pro', 'deepseek/deepseek-v4.1-flash-1017'],
  )
  assert.deepEqual(models[0], {
    id: 'moonshotai/kimi-k3.1-pro',
    name: 'MoonshotAI: Kimi K3.1 Pro',
    contextWindow: 1048576,
    maxTokens: 943718,
    // `video` has no DSH equivalent; it is dropped rather than declared.
    input: ['image'],
  })
  // Text-only models carry no `input` field at all, matching hand-written entries.
  assert.equal('input' in models[1], false)
})

test('readLiveModels drops batch endpoints by default and keeps other variants', () => {
  const payload = {
    data: [
      liveEntry('openai/gpt-6.1-terra'),
      liveEntry('openai/gpt-6.1-terra:batch'),
      liveEntry('openai/gpt-6.1-terra:free'),
      liveEntry('~deepseek/deepseek-pro-latest'),
    ],
  }
  const { models, skipped } = readLiveModels(payload)
  assert.deepEqual(
    models.map((model) => model.id),
    ['openai/gpt-6.1-terra', 'openai/gpt-6.1-terra:free', '~deepseek/deepseek-pro-latest'],
  )
  assert.equal(skipped, 1)

  // The escape hatch exists for an operator who wants the batch endpoints too.
  const all = readLiveModels(payload, { includeBatch: true })
  assert.equal(all.models.length, 4)
})

test('readLiveModels tolerates junk entries without throwing', () => {
  const { models, duplicates } = readLiveModels({
    data: [
      null,
      {},
      { id: '' },
      { id: 'no-vendor-separator' },
      { id: 42 },
      liveEntry('a/one'),
      liveEntry('a/one'),
    ],
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['a/one'],
  )
  assert.equal(duplicates, 1)
})

test('readLiveModels omits unusable dimensions instead of passing them through', () => {
  const { models } = readLiveModels({
    data: [
      liveEntry('a/zero-window', { top_context: 0, context_length: 0, max_completion_tokens: -5 }),
      liveEntry('a/string-window', { top_context: '2048', max_completion_tokens: '512' }),
    ],
  })
  // A non-positive value is omitted: `llm-pi-ai` rejects the whole write otherwise.
  assert.equal('contextWindow' in models[0], false)
  assert.equal('maxTokens' in models[0], false)
  // A numeric string is coerced, because upstream has been seen to send one.
  assert.equal(models[1].contextWindow, 2048)
  assert.equal(models[1].maxTokens, 512)
})

test('readLiveModels refuses a body that is not a listing', () => {
  assert.throws(() => readLiveModels({ error: 'nope' }), TypeError)
})

test('synthesizeModel invents nothing the upstream did not report', () => {
  assert.deepEqual(synthesizeModel('a/bare', {}), { id: 'a/bare' })
  assert.deepEqual(synthesizeModel('a/named', { name: '  Named  ' }), { id: 'a/named', name: 'Named' })
})

test('the byte cap is exported for the caller that bounds the response', () => {
  assert.equal(MODEL_LISTING_MAX_BYTES, 8 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

test('selectModels adds only the ids the user picked', () => {
  const declared = {
    id: 'deepseek/deepseek-v4.1-flash-1017',
    name: 'Hand-written name',
    contextWindow: 1048576,
    reasoningEfforts: { off: null, low: 'low' },
  }
  const { models, diff, changed } = selectModels({
    live: [
      liveEntry('deepseek/deepseek-v4.1-flash-1017'),
      liveEntry('moonshotai/kimi-k3.1-pro'),
      liveEntry('openai/gpt-6.1-terra'),
    ],
    existing: [structuredClone(declared)],
    // One already present, one new, one the endpoint does not list.
    selected: ['deepseek/deepseek-v4.1-flash-1017', 'moonshotai/kimi-k3.1-pro', 'ghost/model'],
  })
  assert.equal(changed, true)
  assert.deepEqual(diff.added, ['moonshotai/kimi-k3.1-pro'])
  assert.deepEqual(diff.already, ['deepseek/deepseek-v4.1-flash-1017'])
  assert.deepEqual(diff.unknown, ['ghost/model'])
  assert.equal(diff.total, 2)
  // The curated entry survives byte for byte…
  assert.deepEqual(models[0], declared)
  // …the unselected live model is not added…
  assert.equal(models.some((model) => model.id === 'openai/gpt-6.1-terra'), false)
  // …and the existing list keeps its order, with additions appended.
  assert.deepEqual(models.map((model) => model.id), [
    'deepseek/deepseek-v4.1-flash-1017',
    'moonshotai/kimi-k3.1-pro',
  ])
})

test('selectModels can remove a model the user unticked', () => {
  const { models, diff, changed } = selectModels({
    live: [liveEntry('a/keep'), liveEntry('a/drop')],
    existing: [{ id: 'a/keep' }, { id: 'a/drop', name: 'Curated' }],
    selected: [],
    remove: ['a/drop'],
  })
  assert.equal(changed, true)
  assert.deepEqual(diff.removed, ['a/drop'])
  assert.deepEqual(diff.added, [])
  assert.deepEqual(models.map((model) => model.id), ['a/keep'])
})

test('selectModels adds and removes in one pass', () => {
  const { models, diff } = selectModels({
    live: [liveEntry('a/keep'), liveEntry('a/new')],
    existing: [{ id: 'a/keep' }, { id: 'a/old' }],
    selected: ['a/new'],
    remove: ['a/old'],
  })
  assert.deepEqual(diff.added, ['a/new'])
  assert.deepEqual(diff.removed, ['a/old'])
  // The removal happens in place, the addition appends.
  assert.deepEqual(models.map((model) => model.id), ['a/keep', 'a/new'])
})

test('unticking then reticking an existing model cancels out', () => {
  const { models, diff, changed } = selectModels({
    live: [],
    existing: [{ id: 'a/have', name: 'Mine' }],
    selected: ['a/keep'],
    remove: [],
  })
  // Selecting an id that is already declared must not duplicate or delete it.
  assert.deepEqual(models.map((model) => model.id), ['a/have'])
  assert.deepEqual(diff.added, [])
})

test('selectModels changes nothing when the selection is empty', () => {
  const existing = [{ id: 'a/one', name: 'Kept' }]
  const { models, diff, changed } = selectModels({ live: [liveEntry('a/two')], existing, selected: [] })
  assert.equal(changed, false)
  assert.deepEqual(models, existing)
  assert.deepEqual(diff.added, [])
})

test('selectModels never duplicates an id or rewrites a declared entry', () => {
  const { models, diff } = selectModels({
    live: [liveEntry('a/one'), liveEntry('a/one')],
    existing: [{ id: 'a/one', name: 'Mine', contextWindow: 1 }],
    selected: ['a/one', 'a/one'],
  })
  assert.deepEqual(diff.added, [])
  assert.deepEqual(models, [{ id: 'a/one', name: 'Mine', contextWindow: 1 }])
})

test('selectModels survives empty and malformed input', () => {
  assert.deepEqual(selectModels({ live: [], existing: [], selected: [] }).diff, {
    added: [],
    removed: [],
    already: [],
    unknown: [],
    total: 0,
  })
  const { models } = selectModels({
    live: [liveEntry('a/pick')],
    existing: [null, {}, { id: '' }],
    selected: ['a/pick', '', '   ', null],
  })
  assert.deepEqual(models.map((model) => model.id), ['a/pick'])
})

test('annotateLive marks the ids the route already declares', () => {
  const models = annotateLive([liveEntry('a/have'), liveEntry('a/new')], [{ id: 'a/have' }])
  assert.deepEqual(
    models.map((model) => [model.id, model.inRoute]),
    [['a/have', true], ['a/new', false]],
  )
  // A catalogue read out of an empty or nonsensical route marks nothing.
  assert.deepEqual(annotateLive([liveEntry('a/x')], undefined).map((m) => m.inRoute), [false])
  assert.deepEqual(annotateLive(undefined, [{ id: 'a/x' }]), [])
})
