import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REASONING_LEVELS,
  collectReasoningEvidence,
  isUsableReasoningEfforts as isReasoningEfforts,
  modelsMissingReasoning,
  normalizeReasoningEfforts,
  optedOutOfReasoning,
  resolveReasoningFor,
  splitModelId,
  fillReasoning,
} from '../lib/reasoning.js'

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test('splitModelId separates an OpenRouter variant suffix from the base id', () => {
  assert.deepEqual(splitModelId('google/gemini-4-argon:flex'), { base: 'google/gemini-4-argon', variant: 'flex' })
  assert.deepEqual(splitModelId('deepseek/deepseek-v4.1-flash-1017:nitro'), {
    base: 'deepseek/deepseek-v4.1-flash-1017',
    variant: 'nitro',
  })
  assert.deepEqual(splitModelId('deepseek/deepseek-v4-flash-0731'), { base: 'deepseek/deepseek-v4-flash-0731', variant: null })
  // A vendor namespace separator is not a variant.
  assert.deepEqual(splitModelId('anthropic/claude-4'), { base: 'anthropic/claude-4', variant: null })
  // Degenerate ids must not throw or produce an empty base.
  assert.deepEqual(splitModelId(''), { base: '', variant: null })
  assert.deepEqual(splitModelId(':flex'), { base: ':flex', variant: null })
  assert.deepEqual(splitModelId('a/b:'), { base: 'a/b:', variant: null })
  assert.deepEqual(splitModelId(undefined), { base: '', variant: null })
})

// ---------------------------------------------------------------------------
// normalisation of the configured option
// ---------------------------------------------------------------------------

test('normalizeReasoningEfforts maps the three documented shapes', () => {
  assert.equal(normalizeReasoningEfforts(false), false)
  assert.equal(normalizeReasoningEfforts(undefined), null)
  assert.equal(normalizeReasoningEfforts(null), null)
  assert.deepEqual(normalizeReasoningEfforts({ off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }), {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  })
})

test('normalizeReasoningEfforts drops unknown levels, empty wires and unusable maps', () => {
  assert.deepEqual(normalizeReasoningEfforts({ off: null, low: 'low', bogus: 'x' }), { off: null, low: 'low' })
  // Empty / blank wire values are dropped, and a map left with only `off`
  // cannot declare a thinking level, so it degrades to "no fallback".
  assert.equal(normalizeReasoningEfforts({ off: null, high: '   ' }), null)
  assert.equal(normalizeReasoningEfforts({ off: null }), null)
  // `off` may be a wire value as well as null.
  assert.deepEqual(normalizeReasoningEfforts({ off: 'none', high: 'high' }), { off: 'none', high: 'high' })
  // Non-objects are "no fallback" rather than a crash.
  assert.equal(normalizeReasoningEfforts('flex'), null)
  assert.equal(normalizeReasoningEfforts([]), null)
  assert.equal(normalizeReasoningEfforts(0), null)
})

test('isUsableReasoningEfforts requires one level beyond off', () => {
  assert.equal(isReasoningEfforts({ off: null, low: 'low' }), true)
  assert.equal(isReasoningEfforts({ off: null }), false)
  assert.equal(isReasoningEfforts({ low: '' }), false)
  assert.equal(isReasoningEfforts(false), false)
  assert.equal(isReasoningEfforts(undefined), false)
  assert.equal(isReasoningEfforts(null), false)
  assert.equal(isReasoningEfforts('low'), false)
})

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

test('collectReasoningEvidence indexes declarations by id and by base id', () => {
  const providers = {
    a: { models: [{ id: 'vendor/one', reasoningEfforts: { off: null, low: 'low' } }] },
    b: { models: [{ id: 'google/gemini-4-argon:flex', reasoningEfforts: { off: null, medium: 'medium' } }] },
    c: { models: [{ id: 'vendor/three' }, { id: 'vendor/four', reasoningEfforts: { off: null } }] },
  }
  const { byId, byBase } = collectReasoningEvidence(providers)
  assert.deepEqual([...byId.keys()], ['vendor/one', 'google/gemini-4-argon:flex'])
  // `vendor/four` declares only `off`, which is not evidence; it adds no base entry.
  assert.deepEqual([...byBase.keys()], ['vendor/one', 'google/gemini-4-argon'])
})

test('collectReasoningEvidence survives malformed routes and never aliases the source', () => {
  const shared = { off: null, low: 'low' }
  const providers = { a: { models: [{ id: 'vendor/one', reasoningEfforts: shared }] }, b: null, c: 'nope', d: { models: 'nope' } }
  const { byId } = collectReasoningEvidence(providers)
  assert.notEqual(byId.get('vendor/one'), shared)
  byId.get('vendor/one').low = 'mutated'
  assert.equal(shared.low, 'low')
  assert.deepEqual([...collectReasoningEvidence(undefined).byId.keys()], [])
})

test('resolveReasoningFor prefers a declaration, then a sibling variant, then the fallback', () => {
  const providers = {
    a: { models: [{ id: 'vendor/one', reasoningEfforts: { off: null, low: 'low' } }] },
    b: { models: [{ id: 'google/gemini-4-argon:flex', reasoningEfforts: { off: null, medium: 'medium' } }] },
  }
  const evidence = collectReasoningEvidence(providers)
  const fallback = { off: null, max: 'max' }

  assert.deepEqual(resolveReasoningFor('vendor/one', evidence, fallback), {
    map: { off: null, low: 'low' },
    from: 'declared',
  })
  // The base id has no declaration of its own, but its `:flex` sibling does.
  assert.deepEqual(resolveReasoningFor('google/gemini-4-argon', evidence, fallback), {
    map: { off: null, medium: 'medium' },
    from: 'variant',
  })
  assert.deepEqual(resolveReasoningFor('unknown/model', evidence, fallback), {
    map: { off: null, max: 'max' },
    from: 'default',
  })
  assert.equal(resolveReasoningFor('unknown/model', evidence, null), null)
})

// ---------------------------------------------------------------------------
// filling
// ---------------------------------------------------------------------------

test('fillReasoning fills only the models that need it and reports every outcome', () => {
  const providers = {
    source: { models: [{ id: 'google/gemini-4-argon:flex', reasoningEfforts: { off: null, medium: 'medium' } }] },
  }
  const evidence = collectReasoningEvidence(providers)
  const route = {
    models: [
      { id: 'vendor/keeps', reasoningEfforts: { off: null, high: 'high' } },
      { id: 'google/gemini-4-argon' },
      { id: 'unknown/model' },
      { id: '' },
      { name: 'no id at all' },
    ],
  }
  const result = fillReasoning(route, { evidence, fallback: null })
  assert.deepEqual(result.filled, [{ id: 'google/gemini-4-argon', from: 'variant' }])
  assert.deepEqual(result.unresolved, ['unknown/model'])
  // The model that already declared a capability is byte-identical.
  assert.deepEqual(result.route.models[0], { id: 'vendor/keeps', reasoningEfforts: { off: null, high: 'high' } })
  assert.deepEqual(result.route.models[1], { id: 'google/gemini-4-argon', reasoningEfforts: { off: null, medium: 'medium' } })
  // Untouched: nothing to infer, and entries without an id are not our business.
  assert.deepEqual(result.route.models[2], { id: 'unknown/model' })
  assert.deepEqual(result.route.models[3], { id: '' })
  assert.deepEqual(result.route.models[4], { name: 'no id at all' })
  // The input route is never mutated.
  assert.equal(route.models[1].reasoningEfforts, undefined)
})

test('fillReasoning applies a configured fallback to models with no evidence', () => {
  const result = fillReasoning({ models: [{ id: 'unknown/model' }] }, {
    evidence: collectReasoningEvidence({}),
    fallback: { off: null, low: 'low' },
  })
  assert.deepEqual(result.filled, [{ id: 'unknown/model', from: 'default' }])
  assert.deepEqual(result.unresolved, [])
})

test('fillReasoning tolerates a route without a models list', () => {
  for (const route of [undefined, null, {}, { models: 'nope' }, 7]) {
    const result = fillReasoning(route, { evidence: collectReasoningEvidence({}), fallback: { off: null, low: 'low' } })
    assert.deepEqual(result.filled, [])
    assert.deepEqual(result.unresolved, [])
  }
})

test('modelsMissingReasoning lists exactly the models the composer cannot offer effort for', () => {
  assert.deepEqual(modelsMissingReasoning({
    models: [
      { id: 'a/one', reasoningEfforts: { off: null, low: 'low' } },
      { id: 'a/two' },
      { id: 'a/three', reasoningEfforts: { off: null } },
      { name: 'no id' },
    ],
  }), ['a/two', 'a/three'])
  assert.deepEqual(modelsMissingReasoning({}), [])
  assert.deepEqual(modelsMissingReasoning(undefined), [])
})

test('the five levels pi-ai accepts are the ones this module writes', () => {
  assert.deepEqual(REASONING_LEVELS, ['off', 'low', 'medium', 'high', 'max'])
})


// ---------------------------------------------------------------------------
// an explicit opt-out is not a gap
// ---------------------------------------------------------------------------

test('reasoningEfforts: false is an opt-out, not a missing capability', () => {
  const route = {
    models: [
      { id: 'qwen/qwen-image-3-pro', reasoningEfforts: false },
      { id: 'deepseek/deepseek-v4-flash-0731' },
    ],
  }
  assert.equal(optedOutOfReasoning(route.models[0]), true)
  assert.equal(optedOutOfReasoning(route.models[1]), false)
  // Only the undeclared model counts as missing.
  assert.deepEqual(modelsMissingReasoning(route), ['deepseek/deepseek-v4-flash-0731'])
})

test('fillReasoning never rewrites an explicit opt-out', () => {
  const route = {
    models: [
      { id: 'qwen/qwen-image-3-pro', reasoningEfforts: false },
      { id: 'x-ai/grok-imagine-image-2.0', reasoningEfforts: false },
      { id: 'deepseek/deepseek-v4-flash-0731' },
    ],
  }
  const fallback = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }
  const filled = fillReasoning(route, { evidence: collectReasoningEvidence({}), fallback })
  assert.deepEqual(filled.filled, [{ id: 'deepseek/deepseek-v4-flash-0731', from: 'default' }])
  assert.deepEqual(filled.unresolved, [])
  // The opt-out rows survive byte-identical.
  assert.deepEqual(filled.route.models.slice(0, 2), route.models.slice(0, 2))
})
