/**
 * Tests for lib/config-bridge.js against a fake `ctx.configEditor`.
 *
 * The fake mirrors the two behaviours this module depends on:
 *   configuration() -> [{ entry, inherited, override }]
 *   edit(entry, change) -> change(current, inherited) is persisted through the
 *   Loader as that row's raw `config` (so the fake stores `next` as
 *   `entry.options.config`, exactly like the real editor does).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import { createConfigBridge, planRepoint, planRestore } from '../lib/config-bridge.js'

const PROFILE_PLUGIN = '@deepseek-ai/dsh-llm-pi-ai'
const RELAY = 'http://127.0.0.1:8791'
const TIERS = ['flex', 'priority']

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

function sourceRoute(overrides = {}) {
  return {
    displayName: 'openrouter-custom',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    api: 'openai-responses',
    baseURL: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://harness.example', 'X-Title': 'DeepSeek Harness' },
    models: [
      { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731', contextWindow: 1048576 },
      { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', contextWindow: 1048576 },
    ],
    ...overrides,
  }
}

/**
 * @param {{ config?: object, inherited?: object, entryShape?: 'name' | 'options', noExplicitConfig?: boolean }} [options]
 */
function createFakeEditor({ config = {}, inherited = {}, entryShape = 'name', noExplicitConfig = false } = {}) {
  const state = { config: clone(config), inherited: clone(inherited), edits: [] }
  // A row with no `config` of its own runs the inherited layer, and the real
  // editor then reports that composed config as the entry's own config.
  const options = {
    id: 'llm-pi-ai',
    name: PROFILE_PLUGIN,
    config: noExplicitConfig ? clone(inherited) : state.config,
  }
  const entry = entryShape === 'name'
    ? { name: PROFILE_PLUGIN, options }
    : { options }

  const editor = {
    entry,
    state,
    configuration() {
      return [{ entry, inherited: clone(state.inherited), override: clone(entry.options.config) }]
    },
    entries() {
      return [entry]
    },
    async edit(targetEntry, change) {
      assert.equal(targetEntry, entry, 'edit must receive the entry that configuration() returned')
      const current = clone(targetEntry.options.config ?? {})
      const inheritedLayer = clone(state.inherited)
      const next = change(current, inheritedLayer)
      state.edits.push({ current, inherited: inheritedLayer, next: clone(next) })
      targetEntry.options = { ...targetEntry.options, config: clone(next) }
      state.config = clone(next)
    },
  }
  return { editor, entry, state, edits: state.edits }
}

function contextFor(editor) {
  return { get: (key) => (key === 'configEditor' ? editor : undefined), configEditor: editor }
}

function bridgeFor(editor, { tiers = TIERS, origin = () => ({ host: '127.0.0.1', port: 8791 }), log, reasoningEfforts } = {}) {
  const logged = []
  const bridge = createConfigBridge({
    ctx: editor === null ? { get: () => undefined } : contextFor(editor),
    origin,
    tiers,
    reasoningEfforts,
    log: (level, message, detail) => {
      logged.push([level, message, detail])
      if (log) log(level, message, detail)
    },
  })
  return { bridge, logged }
}

function openRouterWorld(overrides = {}) {
  return createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute() } },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

test('available() is true when configEditor resolves through ctx.get', () => {
  const { editor } = openRouterWorld()
  assert.equal(bridgeFor(editor).bridge.available(), true)
})

test('available() is false without configEditor and reads stay empty', async () => {
  const bridge = createConfigBridge({
    ctx: { get: () => undefined },
    origin: () => ({ host: '127.0.0.1', port: 8791 }),
    tiers: TIERS,
  })
  assert.equal(bridge.available(), false)
  assert.deepEqual(await bridge.targets(), { sources: [], created: [] })
  assert.deepEqual(await bridge.listRoutes(), [])
  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' }),
    /configuration editor is not available/i,
  )
  await assert.rejects(
    () => bridge.removeRoute({ name: 'openrouter-custom-flex' }),
    /configuration editor is not available/i,
  )
})

test('available() survives a throwing ctx.get, a throwing getter and a bare context', () => {
  const throwingGet = { get() { throw new Error('service not injected') } }
  assert.equal(createConfigBridge({ ctx: throwingGet, origin: () => ({}), tiers: TIERS }).available(), false)

  const throwingProperty = {
    get: () => undefined,
    get configEditor() { throw new Error('cannot get property "configEditor" without inject') },
  }
  assert.equal(createConfigBridge({ ctx: throwingProperty, origin: () => ({}), tiers: TIERS }).available(), false)

  assert.equal(createConfigBridge({}).available(), false)
  assert.equal(createConfigBridge({ ctx: {} }).available(), false)
})

test('reads stay empty (and never throw) when the llm-pi-ai row is missing', async () => {
  const { editor } = createFakeEditor({ config: {} })
  editor.configuration = () => [
    { entry: { name: 'some-other-plugin', options: { config: {} } }, inherited: {}, override: {} },
  ]
  const { bridge, logged } = bridgeFor(editor)

  assert.deepEqual(await bridge.targets(), { sources: [], created: [] })
  assert.ok(logged.some(([level]) => level === 'warn'))
  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' }),
    /cannot find the @deepseek-ai\/dsh-llm-pi-ai configuration/i,
  )
})

// ---------------------------------------------------------------------------
// targets()
// ---------------------------------------------------------------------------

test('targets() lists the running routes with counts and marks relay-attached tiers', async () => {
  const { editor } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        'openrouter-flex': sourceRoute({
          displayName: 'openrouter-custom (flex) — OpenRouter Plus',
          baseURL: `${RELAY}/flex/v1`,
        }),
        'minimal-route': { apiKeyEnv: 'MINIMAL_API_KEY' },
      },
    },
    // An inherited-only route is not running (the explicit layer replaces the
    // inherited one at runtime), so it is not reported as a source.
    inherited: { providers: { 'bundle-route': { api: 'openai-completions', baseURL: 'https://bundle.example/v1' } } },
  })
  const { bridge } = bridgeFor(editor)
  const snapshot = await bridge.targets()

  assert.deepEqual(snapshot.sources, [
    {
      key: 'openrouter-custom',
      displayName: 'openrouter-custom',
      api: 'openai-responses',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      modelCount: 2,
    },
    {
      key: 'openrouter-flex',
      displayName: 'openrouter-custom (flex) — OpenRouter Plus',
      api: 'openai-responses',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      attachedTier: 'flex',
    },
    {
      key: 'minimal-route',
      displayName: 'minimal-route',
      api: null,
      apiKeyEnv: 'MINIMAL_API_KEY',
      baseURL: null,
      modelCount: 0,
    },
  ])

  assert.deepEqual(snapshot.created, [
    {
      name: 'openrouter-flex',
      source: 'openrouter-custom',
      tier: 'flex',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      missingReasoning: 2,
      missingReasoning: 2,
    },
  ])
})

test('targets() attributes a custom-named relay route through its display name', async () => {
  const { editor } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        'my-fast-route': sourceRoute({
          displayName: 'openrouter-custom (priority) — OpenRouter Plus',
          baseURL: `${RELAY}/priority/v1`,
        }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)
  const [created] = (await bridge.targets()).created

  assert.deepEqual(created, {
    name: 'my-fast-route',
    source: 'openrouter-custom',
    tier: 'priority',
    baseURL: `${RELAY}/priority/v1`,
    modelCount: 2,
    missingReasoning: 2,
  })
})

// ---------------------------------------------------------------------------
// createRoute()
// ---------------------------------------------------------------------------

test('targets() reports the inherited layer when the row has no config of its own', async () => {
  const { editor } = createFakeEditor({
    config: {},
    noExplicitConfig: true,
    inherited: {
      providers: {
        'bundle-route': sourceRoute({
          displayName: 'Bundle route',
          baseURL: `${RELAY}/flex/v1`,
        }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)

  const snapshot = await bridge.targets()
  assert.deepEqual(snapshot.sources, [
    {
      key: 'bundle-route',
      displayName: 'Bundle route',
      api: 'openai-responses',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      attachedTier: 'flex',
    },
  ])
  assert.deepEqual(snapshot.created, [
    {
      name: 'bundle-route',
      source: null,
      tier: 'flex',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      missingReasoning: 2,
    },
  ])
})

test('createRoute() clones the source route for the relay under the default name', async () => {
  const { editor, state, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })

  assert.deepEqual(result, {
    name: 'openrouter-custom-flex',
    baseURL: `${RELAY}/flex/v1`,
    source: 'openrouter-custom',
    tier: 'flex',
    // The fixtures declare no reasoningEfforts anywhere, so evidence-only
    // filling adds nothing and reports every model as still unresolved.
    reasoning: {
      filled: [],
      unresolved: ['deepseek/deepseek-v4-flash-0731', 'google/gemini-3.8-flash'],
    },
  })
  assert.equal(edits.length, 1)

  const created = edits[0].next.providers['openrouter-custom-flex']
  assert.equal(created.baseURL, `${RELAY}/flex/v1`)
  assert.equal(created.displayName, 'openrouter-custom (flex) — OpenRouter Plus')

  // Cloned verbatim.
  assert.equal(created.api, 'openai-responses')
  assert.equal(created.apiKeyEnv, 'OPENROUTER_API_KEY')
  assert.deepEqual(created.headers, {
    'HTTP-Referer': 'https://harness.example',
    'X-Title': 'DeepSeek Harness',
  })

  // models is a deep copy, not a shared reference.
  const sourceModels = state.config.providers['openrouter-custom'].models
  assert.deepEqual(created.models, sourceModels)
  assert.notEqual(created.models, sourceModels)
  assert.notEqual(created.models[0], sourceModels[0])
  created.models[0].name = 'mutated'
  assert.equal(sourceModels[0].name, 'DeepSeek: DeepSeek V4 Flash 0731')

  // The untouched source route survives.
  assert.deepEqual(edits[0].next.providers['openrouter-custom'], sourceRoute())

  // The edit payload is the whole effective row config, providers included.
  assert.deepEqual(Object.keys(edits[0].next), ['providers'])
})

test('createRoute() drops displayName/serviceTier from the clone and honours overrides', async () => {
  const { editor, edits } = createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute({ serviceTier: 'flex' }) } },
  })
  const { bridge } = bridgeFor(editor)

  await bridge.createRoute({
    source: 'openrouter-custom',
    tier: 'priority',
    name: 'custom-fast',
    displayName: '  Fast lane  ',
  })

  const created = edits[0].next.providers['custom-fast']
  assert.equal(created.displayName, 'Fast lane')
  assert.equal(created.baseURL, `${RELAY}/priority/v1`)
  assert.equal(Object.hasOwn(created, 'serviceTier'), false)
  // Only the clone is rewritten; the source keeps its own fields.
  assert.equal(edits[0].next.providers['openrouter-custom'].serviceTier, 'flex')
})

test('createRoute() accepts a tier case-insensitively and canonicalises it', async () => {
  const { editor } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'FLEX' })
  assert.equal(result.tier, 'flex')
  assert.equal(result.baseURL, `${RELAY}/flex/v1`)
})

test('createRoute() rejects a duplicate name without writing', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  assert.equal(edits.length, 1)

  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' }),
    /already exists/i,
  )
  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'openrouter-custom' }),
    /already exists/i,
  )
  assert.equal(edits.length, 1, 'a rejected create must not write')
})

test('createRoute() rejects a name that only collides after trimming', async () => {
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        'openrouter-flex ': sourceRoute(), // hand-edited key with a trailing space
      },
    },
  })
  const { bridge } = bridgeFor(editor)

  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'openrouter-flex' }),
    /collides with the existing route "openrouter-flex "/i,
  )
  assert.equal(edits.length, 0)
})

test('createRoute() rejects a duplicate that only exists in the inherited layer', async () => {
  const { editor, edits } = createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute() } },
    inherited: { providers: { 'openrouter-custom-flex': sourceRoute({ baseURL: `${RELAY}/flex/v1` }) } },
  })
  const { bridge } = bridgeFor(editor)

  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' }),
    /already exists/i,
  )
  assert.equal(edits.length, 0)
})

test('createRoute() rejects an unknown source, an unknown tier and missing input', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  await assert.rejects(
    () => bridge.createRoute({ source: 'does-not-exist', tier: 'flex' }),
    /Provider route "does-not-exist" does not exist/i,
  )
  // The message names the routes that do exist so the user can correct it.
  await assert.rejects(
    () => bridge.createRoute({ source: 'does-not-exist', tier: 'flex' }),
    /Existing routes: openrouter-custom/,
  )
  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'turbo' }),
    /Service tier "turbo" is not enabled\. Choose one of: flex, priority\./,
  )
  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom' }),
    /Choose a service tier before linking a route: flex, priority\./,
  )
  await assert.rejects(() => bridge.createRoute(), /Choose the existing provider route to copy/i)
  assert.equal(edits.length, 0)
})

test('createRoute() preserves routes and keys that only exist in the inherited layer', async () => {
  const inheritedRoute = {
    api: 'openai-completions',
    apiKeyEnv: 'BUNDLE_API_KEY',
    baseURL: 'https://bundle.example/v1',
    models: [{ id: 'bundle/model' }],
  }
  const { editor, edits } = createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute() }, retryPolicy: { mode: 'normal' } },
    inherited: {
      providers: { 'bundle-route': inheritedRoute },
      retryPolicy: { mode: 'inherited' },
      futureTopLevelKey: { kept: true },
    },
  })
  const { bridge } = bridgeFor(editor)

  await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })

  const next = edits[0].next
  assert.deepEqual(next.providers['bundle-route'], inheritedRoute)
  assert.deepEqual(Object.keys(next.providers).sort(), ['bundle-route', 'openrouter-custom', 'openrouter-custom-flex'])
  // Explicit keys win; inherited-only keys are carried over so the write is lossless.
  assert.deepEqual(next.retryPolicy, { mode: 'normal' })
  assert.deepEqual(next.futureTopLevelKey, { kept: true })
})

test('createRoute() rejects when the relay has no address yet', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor, { origin: () => undefined })

  await assert.rejects(
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' }),
    /relay has no address/i,
  )
  assert.equal(edits.length, 0)
  // Nothing can be attributed to the relay while it has no address.
  assert.deepEqual((await bridge.targets()).created, [])
})

test('createRoute() works with the real Loader entry shape (options.name only)', async () => {
  const { editor, edits } = openRouterWorld({ entryShape: 'options' })
  const { bridge } = bridgeFor(editor)

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  assert.equal(result.name, 'openrouter-custom-flex')
  assert.equal(edits.length, 1)
})

// ---------------------------------------------------------------------------
// removeRoute()
// ---------------------------------------------------------------------------

test('removeRoute() refuses a route the plugin did not create', async () => {
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        'openrouter-custom-flex': sourceRoute({
          displayName: 'openrouter-custom (flex) — OpenRouter Plus',
          baseURL: `${RELAY}/flex/v1`,
        }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)

  await assert.rejects(
    () => bridge.removeRoute({ name: 'openrouter-custom' }),
    /is not managed by OpenRouter Plus/i,
  )
  await assert.rejects(
    () => bridge.removeRoute({ name: 'openrouter-custom' }),
    /Edit or remove it in the Models settings page instead/,
  )
  assert.equal(edits.length, 0)
  assert.deepEqual(await bridge.listRoutes(), [
    {
      name: 'openrouter-custom-flex',
      source: 'openrouter-custom',
      tier: 'flex',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      missingReasoning: 2,
    },
  ])
})

test('removeRoute() refuses a route without a baseURL and an unknown name', async () => {
  const { editor, edits } = createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute(), 'no-base': { api: 'openai-completions' } } },
  })
  const { bridge } = bridgeFor(editor)

  await assert.rejects(
    () => bridge.removeRoute({ name: 'no-base' }),
    /its baseURL is no baseURL, not the local relay at http:\/\/127\.0\.0\.1:8791/,
  )
  await assert.rejects(
    () => bridge.removeRoute({ name: 'ghost-route' }),
    /No provider route named "ghost-route" is configured, so there is nothing to remove\./,
  )
  await assert.rejects(() => bridge.removeRoute({}), /A provider route name is required to remove one\./)
  await assert.rejects(() => bridge.removeRoute(), /A provider route name is required to remove one\./)
  assert.equal(edits.length, 0)
})

test('removeRoute() removes an owned route and keeps every other route', async () => {
  const { editor, state, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  const removed = await bridge.removeRoute({ name: 'openrouter-custom-flex' })

  assert.deepEqual(removed, { name: 'openrouter-custom-flex' })
  assert.equal(edits.length, 2)

  // The page after the write no longer carries the clone...
  assert.deepEqual(Object.keys(edits[1].next.providers), ['openrouter-custom'])
  assert.deepEqual(state.config.providers['openrouter-custom'], sourceRoute())
  assert.deepEqual(await bridge.listRoutes(), [])
})

test('removeRoute() can remove an inherited-only relay route by shadowing the inherited map', async () => {
  const { editor, edits } = createFakeEditor({
    config: { providers: { 'openrouter-custom': sourceRoute() } },
    inherited: {
      providers: {
        'bundle-flex-route': sourceRoute({ baseURL: `${RELAY}/flex/v1` }),
        'bundle-route': { baseURL: 'https://bundle.example/v1' },
      },
    },
  })
  const { bridge } = bridgeFor(editor)

  assert.deepEqual(await bridge.removeRoute({ name: 'bundle-flex-route' }), { name: 'bundle-flex-route' })
  const next = edits[0].next
  assert.equal(Object.hasOwn(next.providers, 'bundle-flex-route'), false)
  assert.deepEqual(next.providers['bundle-route'], { baseURL: 'https://bundle.example/v1' })
  assert.deepEqual(await bridge.listRoutes(), [])
})

test('removeRoute() stops treating a route as owned when the relay origin changes', async () => {
  const { editor, edits } = openRouterWorld()
  await bridgeFor(editor).bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })

  const moved = bridgeFor(editor, { origin: () => ({ host: '127.0.0.1', port: 8792 }) }).bridge
  await assert.rejects(
    () => moved.removeRoute({ name: 'openrouter-custom-flex' }),
    /is not managed by OpenRouter Plus/i,
  )
  assert.equal(edits.length, 1)
})

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

test('every write really changes the config, and rejections never write', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'lane-flex' })
  await bridge.createRoute({ source: 'openrouter-custom', tier: 'priority', name: 'lane-priority' })
  await assert.rejects(() => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'lane-flex' }))
  await assert.rejects(() => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'openrouter-custom' }))
  await assert.rejects(() => bridge.removeRoute({ name: 'openrouter-custom' }))
  await bridge.removeRoute({ name: 'lane-priority' })

  assert.equal(edits.length, 3)
  for (const edit of edits) {
    const effective = { ...edit.inherited, ...edit.current, providers: { ...(edit.inherited.providers ?? {}), ...(edit.current.providers ?? {}) } }
    assert.equal(
      isDeepStrictEqual(edit.next, effective),
      false,
      'the bridge must never ask the Loader to persist an unchanged config',
    )
    assert.notDeepEqual(edit.next, edit.current)
  }
})

test('error messages are user-readable and never leak internal values', async () => {
  const { editor } = openRouterWorld()
  const { bridge } = bridgeFor(editor)

  const cases = [
    () => bridge.createRoute({}),
    () => bridge.createRoute({ source: 'nope', tier: 'flex' }),
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'nope' }),
    () => bridge.createRoute({ source: 'openrouter-custom', tier: 'flex', name: 'not a route' }),
    () => bridge.removeRoute({ name: 'ghost' }),
    () => bridge.removeRoute({ name: 'openrouter-custom' }),
  ]
  for (const run of cases) {
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof Error)
      assert.equal(typeof error.message, 'string')
      assert.ok(error.message.length > 20, `message too short: ${error.message}`)
      assert.equal(
        /undefined|null|\[object Object\]/.test(error.message),
        false,
        `leaky message: ${error.message}`,
      )
      return true
    })
  }
})

test('listRoutes() reports only plugin-owned routes', async () => {
  const { editor } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        'openrouter-custom-flex': sourceRoute({
          displayName: 'openrouter-custom (flex) — OpenRouter Plus',
          baseURL: `${RELAY}/flex/v1`,
        }),
        // A different port on the same host is a different relay: not ours.
        'other-relay-port': sourceRoute({ baseURL: 'http://127.0.0.1:87910/flex/v1' }),
        // The relay origin itself carries no tier, so it is owned but untiered.
        'relay-root': sourceRoute({ baseURL: `${RELAY}/` }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)

  assert.deepEqual(await bridge.listRoutes(), [
    {
      name: 'openrouter-custom-flex',
      source: 'openrouter-custom',
      tier: 'flex',
      baseURL: `${RELAY}/flex/v1`,
      modelCount: 2,
      missingReasoning: 2,
    },
  ])
})

// ---------------------------------------------------------------------------
// reasoning capability
// ---------------------------------------------------------------------------

const EFFORTS = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }

test('createRoute() carries a capability the source models already declare', async () => {
  const source = sourceRoute({
    models: [{ id: 'google/gemini-4-argon:flex', name: 'Gemini 4 Argon', reasoningEfforts: { off: null, medium: 'medium' } }],
  })
  const { editor, edits } = createFakeEditor({ config: { providers: { 'openrouter-custom': source } } })
  const { bridge } = bridgeFor(editor)

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  // Nothing to fill: the clone already carries the declaration verbatim.
  assert.deepEqual(result.reasoning, { filled: [], unresolved: [] })

  // The clone keeps the declaration it inherited from the source models.
  const created = edits[0].next.providers['openrouter-custom-flex']
  assert.deepEqual(created.models[0].reasoningEfforts, { off: null, medium: 'medium' })
  assert.deepEqual(edits[0].next.providers['openrouter-custom'], source, 'the source route is untouched')
})

test('createRoute() fills from the configured fallback map when nothing can be inferred', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor, { reasoningEfforts: EFFORTS })

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  assert.deepEqual(result.reasoning, {
    filled: [
      { id: 'deepseek/deepseek-v4-flash-0731', from: 'default' },
      { id: 'google/gemini-3.8-flash', from: 'default' },
    ],
    unresolved: [],
  })
  const created = edits[0].next.providers['openrouter-custom-flex']
  assert.deepEqual(created.models.map((model) => model.reasoningEfforts), [EFFORTS, EFFORTS])
})

test('createRoute() leaves models alone when filling is disabled', async () => {
  const { editor, edits } = openRouterWorld()
  const { bridge } = bridgeFor(editor, { reasoningEfforts: false })

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  assert.deepEqual(result.reasoning.filled, [])
  assert.deepEqual(result.reasoning.unresolved, [
    'deepseek/deepseek-v4-flash-0731',
    'google/gemini-3.8-flash',
  ])
  const created = edits[0].next.providers['openrouter-custom-flex']
  assert.equal(created.models[0].reasoningEfforts, undefined)
})

test('createRoute() never overwrites a capability the model already declares', async () => {
  const source = sourceRoute({
    models: [{ id: 'vendor/one', reasoningEfforts: { off: null, max: 'max' } }],
  })
  const { editor, edits } = createFakeEditor({ config: { providers: { 'openrouter-custom': source } } })
  const { bridge } = bridgeFor(editor, { reasoningEfforts: EFFORTS })

  const result = await bridge.createRoute({ source: 'openrouter-custom', tier: 'flex' })
  assert.deepEqual(result.reasoning, { filled: [], unresolved: [] })
  assert.deepEqual(edits[0].next.providers['openrouter-custom-flex'].models[0].reasoningEfforts, {
    off: null,
    max: 'max',
  })
})

test('targets() counts the models a repair would fix', async () => {
  const { editor } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute({
          models: [
            { id: 'vendor/declared', reasoningEfforts: EFFORTS },
            { id: 'vendor/missing' },
            { id: 'vendor/missing-too' },
          ],
        }),
        'openrouter-flex': sourceRoute({
          baseURL: `${RELAY}/flex/v1`,
          models: [{ id: 'vendor/declared', reasoningEfforts: EFFORTS }, { id: 'vendor/missing' }],
        }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)
  const { created } = await bridge.targets()
  assert.deepEqual(created.map((route) => route.missingReasoning), [1])
})

test('repairRoutes() fills owned routes only and reports what it could not infer', async () => {
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        // A hand-written route pointing upstream: never touched.
        'openrouter-custom': sourceRoute({
          models: [{ id: 'vendor/source-only' }],
        }),
        // Owned, one declared + two missing, one of which has a variant sibling.
        'openrouter-flex': sourceRoute({
          displayName: 'openrouter-custom (flex) — OpenRouter Plus',
          baseURL: `${RELAY}/flex/v1`,
          models: [
            { id: 'vendor/declared', reasoningEfforts: { off: null, high: 'high' } },
            { id: 'google/gemini-4-argon:flex' },
            { id: 'vendor/no-evidence' },
          ],
        }),
      },
      inherited: {},
    },
  })
  // Evidence for the sibling variant lives on another owned route.
  editor.state.config.providers['openrouter-priority'] = sourceRoute({
    baseURL: `${RELAY}/priority/v1`,
    models: [{ id: 'google/gemini-4-argon', reasoningEfforts: { off: null, low: 'low' } }],
  })
  editor.entry.options.config = clone(editor.state.config)

  const { bridge } = bridgeFor(editor, { reasoningEfforts: EFFORTS })
  const result = await bridge.repairRoutes()

  assert.equal(result.changed, true)
  assert.deepEqual(result.owned.sort(), ['openrouter-flex', 'openrouter-priority'])
  assert.deepEqual(result.patched, [
    {
      name: 'openrouter-flex',
      models: [
        { id: 'google/gemini-4-argon:flex', from: 'variant' },
        { id: 'vendor/no-evidence', from: 'default' },
      ],
    },
  ])
  assert.deepEqual(result.unresolved, [])

  const patched = edits[0].next.providers['openrouter-flex']
  assert.deepEqual(patched.models[0].reasoningEfforts, { off: null, high: 'high' }, 'declared maps are kept verbatim')
  assert.deepEqual(patched.models[1].reasoningEfforts, { off: null, low: 'low' })
  assert.deepEqual(patched.models[2].reasoningEfforts, EFFORTS)

  // The hand-written route is byte-identical.
  assert.deepEqual(edits[0].next.providers['openrouter-custom'], editor.state.config.providers['openrouter-custom'])
})

test('repairRoutes() writes nothing when every owned model already declares a capability', async () => {
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        'openrouter-flex': sourceRoute({
          baseURL: `${RELAY}/flex/v1`,
          models: [{ id: 'vendor/one', reasoningEfforts: EFFORTS }],
        }),
      },
    },
  })
  const { bridge, logged } = bridgeFor(editor)
  const result = await bridge.repairRoutes()

  assert.deepEqual(result.patched, [])
  assert.equal(result.changed, false)
  assert.equal(edits.length, 0, 'a no-op repair must not rewrite the profile')
  assert.ok(logged.some(([level, message]) => level === 'debug' && /no-op/.test(message)))
})

test('repairRoutes() reports an unrepairable model instead of inventing a capability', async () => {
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        'openrouter-flex': sourceRoute({
          baseURL: `${RELAY}/flex/v1`,
          models: [{ id: 'vendor/one' }],
        }),
      },
    },
  })
  // Filling disabled: nothing may be written, and the gap is reported instead.
  const { bridge } = bridgeFor(editor, { reasoningEfforts: false })
  const disabled = await bridge.repairRoutes()
  assert.deepEqual(disabled.patched, [])
  assert.deepEqual(disabled.unresolved, [{ name: 'openrouter-flex', model: 'vendor/one' }])
  assert.equal(edits.length, 0)

  // Evidence-only filling has no evidence for this id either.
  const { bridge: evidenceOnly } = bridgeFor(editor)
  const unresolved = await evidenceOnly.repairRoutes()
  assert.deepEqual(unresolved.patched, [])
  assert.deepEqual(unresolved.unresolved, [{ name: 'openrouter-flex', model: 'vendor/one' }])
  assert.equal(edits.length, 0)
})

// ---------------------------------------------------------------------------
// repoint / restore
// ---------------------------------------------------------------------------

/** A provider the user created through the normal "add custom provider" flow. */
const ACME = 'https://api.acme.dev/v1'

/** A relay mount: what a repointed route is pointed at, path and tier included. */
const MOUNT = `${RELAY}/t/acme-gw-9f3a/flex/v1`

function acmeRoute(overrides = {}) {
  return {
    displayName: 'acme gateway',
    apiKeyEnv: 'ACME_API_KEY',
    api: 'openai-responses',
    baseURL: ACME,
    models: [{ id: 'acme-gw-large', name: 'Acme GW Large', contextWindow: 200000 }],
    ...overrides,
  }
}

/** Two providers: one to move, one that must never be touched. */
function repointWorld(overrides = {}) {
  return createFakeEditor({
    config: { providers: { acme: acmeRoute(), 'openrouter-custom': sourceRoute() } },
    ...overrides,
  })
}

test('planRepoint() moves only the base URL and leaves every other route alone', () => {
  const current = { providers: { acme: acmeRoute(), 'openrouter-custom': sourceRoute() } }
  const before = clone(current)

  const { next, result } = planRepoint(current, {}, { route: 'acme', baseURL: MOUNT }, RELAY)

  assert.deepEqual(result, { name: 'acme', from: ACME, to: MOUNT, changed: true })
  assert.equal(next.providers.acme.baseURL, MOUNT)
  // The entry keeps exactly the fields pi-ai knows: nothing of the plugin's own.
  assert.deepEqual(Object.keys(next.providers.acme), Object.keys(acmeRoute()))
  const { baseURL: _moved, ...rest } = next.providers.acme
  const { baseURL: _was, ...expected } = acmeRoute()
  assert.deepEqual(rest, expected)
  assert.deepEqual(next.providers['openrouter-custom'], current.providers['openrouter-custom'])
  // The plan is pure: the layers it was handed are not mutated.
  assert.deepEqual(current, before)
})

test('planRepoint() reports changed:false and a no-op config when already there', () => {
  const current = { providers: { acme: acmeRoute() } }
  // A trailing slash is the same endpoint, so it must not produce a write either.
  for (const baseURL of [ACME, `${ACME}/`]) {
    const { next, result } = planRepoint(current, {}, { route: 'acme', baseURL }, RELAY)
    assert.deepEqual(result, { name: 'acme', from: ACME, to: baseURL, changed: false })
    assert.equal(next.providers.acme.baseURL, ACME, 'the stored value is left exactly as it was')
    // commit() skips the write only when the plan deep-equals the merged snapshot.
    assert.ok(isDeepStrictEqual(next, current))
  }
})

test('planRepoint() refuses an unknown, blank or padded route name', () => {
  const current = { providers: { acme: acmeRoute(), 'openrouter-custom': sourceRoute() } }
  assert.throws(
    () => planRepoint(current, {}, { route: 'nope', baseURL: MOUNT }, RELAY),
    /Provider route "nope" is not configured in @deepseek-ai\/dsh-llm-pi-ai, so there is nothing to repoint\. Existing routes: acme, openrouter-custom\./,
  )
  assert.throws(
    () => planRepoint(current, {}, {}, RELAY),
    /A provider route name is required to repoint one/,
  )
  assert.throws(
    () => planRepoint({ providers: {} }, {}, { route: 'acme', baseURL: MOUNT }, RELAY),
    /There is no provider route to repoint: the @deepseek-ai\/dsh-llm-pi-ai configuration has no routes yet/,
  )
  // A key that only differs by surrounding whitespace still resolves, and the
  // plan reports the key that is really stored.
  const padded = { providers: { ' acme ': acmeRoute() } }
  assert.equal(planRepoint(padded, {}, { route: 'acme', baseURL: MOUNT }, RELAY).result.name, ' acme ')
})

test('planRepoint() refuses an empty or non-http base URL', () => {
  const current = { providers: { acme: acmeRoute() } }
  assert.throws(
    () => planRepoint(current, {}, { route: 'acme', baseURL: '  ' }, RELAY),
    /Enter the base URL that provider route "acme" should point at/,
  )
  for (const bad of ['api.acme.dev/v1', '/v1', 'ftp://api.acme.dev/v1', 'mailto:ops@acme.dev', 'not a url']) {
    assert.throws(
      () => planRepoint(current, {}, { route: 'acme', baseURL: bad }, RELAY),
      /is not usable: enter an absolute http:\/\/ or https:\/\/ URL/,
    )
  }
})

test('planRepoint() refuses a route this plugin created', () => {
  const current = { providers: { 'acme-flex': acmeRoute({ baseURL: `${RELAY}/flex/v1` }) } }
  assert.throws(
    () => planRepoint(current, {}, { route: 'acme-flex', baseURL: MOUNT }, RELAY),
    /already points at the OpenRouter Plus relay .*so the plugin owns it and it cannot be repointed/,
  )
})

test('planRepoint() refuses the relay bare origin but accepts a mount', () => {
  const current = { providers: { acme: acmeRoute() } }
  for (const origin of [RELAY, `${RELAY}/`]) {
    assert.throws(
      () => planRepoint(current, {}, { route: 'acme', baseURL: origin }, RELAY),
      /Refusing to point provider route "acme" at the OpenRouter Plus relay itself/,
    )
  }
  const mounted = planRepoint(current, {}, { route: 'acme', baseURL: MOUNT }, RELAY)
  assert.equal(mounted.result.changed, true)
  assert.equal(mounted.next.providers.acme.baseURL, MOUNT)
})

test('planRestore() moves a relay-backed route back and round-trips byte-identically', () => {
  const original = { providers: { acme: acmeRoute(), 'openrouter-custom': sourceRoute() } }
  const routed = planRepoint(original, {}, { route: 'acme', baseURL: MOUNT }, RELAY)

  const restored = planRestore(routed.next, {}, { route: 'acme', baseURL: ACME }, RELAY)

  assert.deepEqual(restored.result, { name: 'acme', from: MOUNT, to: ACME, changed: true })
  assert.deepEqual(restored.next.providers, original.providers)
})

test('planRestore() refuses a route that is not relay-backed', () => {
  const current = {
    providers: {
      acme: acmeRoute(),
      naked: { api: 'openai-responses', models: [] },
    },
  }
  assert.throws(
    () => planRestore(current, {}, { route: 'acme', baseURL: ACME }, RELAY),
    /Provider route "acme" is not routed through OpenRouter Plus \(its base URL is "https:\/\/api\.acme\.dev\/v1"\), so there is nothing to restore/,
  )
  assert.throws(
    () => planRestore(current, {}, { route: 'naked', baseURL: ACME }, RELAY),
    /Provider route "naked" is not routed through OpenRouter Plus \(its base URL is no base URL\), so there is nothing to restore/,
  )
  assert.throws(
    () => planRestore(current, {}, { route: 'nope', baseURL: ACME }, RELAY),
    /nothing to restore\. Existing routes: acme, naked\./,
  )
})

test('planRestore() reports changed:false when the route already reads as the target', () => {
  const current = { providers: { routed: acmeRoute({ baseURL: MOUNT }) } }
  const { next, result } = planRestore(current, {}, { route: 'routed', baseURL: `${MOUNT}/` }, RELAY)
  assert.deepEqual(result, { name: 'routed', from: MOUNT, to: `${MOUNT}/`, changed: false })
  assert.ok(isDeepStrictEqual(next, current))
  assert.throws(
    () => planRestore(current, {}, { route: 'routed', baseURL: '' }, RELAY),
    /Enter the base URL that provider route "routed" should be restored to/,
  )
  assert.throws(
    () => planRestore(current, {}, { route: 'routed', baseURL: 'ftp://api.acme.dev/v1' }, RELAY),
    /is not usable: enter an absolute http:\/\/ or https:\/\/ URL/,
  )
})

test('the planners refuse without a relay address', () => {
  const current = { providers: { acme: acmeRoute(), routed: acmeRoute({ baseURL: MOUNT }) } }
  for (const missing of [undefined, null, '']) {
    assert.throws(
      () => planRepoint(current, {}, { route: 'acme', baseURL: MOUNT }, missing),
      /cannot repoint a provider route right now: the loopback relay has no address/,
    )
    assert.throws(
      () => planRestore(current, {}, { route: 'routed', baseURL: ACME }, missing),
      /cannot restore a provider route right now: the loopback relay has no address/,
    )
  }
})

test('the planners preserve routes and keys that only exist in the inherited layer', () => {
  const inherited = {
    providers: { bundle: sourceRoute({ displayName: 'bundle', baseURL: 'https://bundle.dev/v1' }) },
  }
  const current = { providers: { acme: acmeRoute() } }

  const repointed = planRepoint(current, inherited, { route: 'bundle', baseURL: MOUNT }, RELAY)
  assert.equal(repointed.result.changed, true)
  assert.equal(repointed.next.providers.bundle.baseURL, MOUNT)
  // The inherited route keeps the rest of its own definition, and the explicit
  // route beside it is untouched.
  assert.equal(repointed.next.providers.bundle.displayName, 'bundle')
  assert.deepEqual(repointed.next.providers.acme, current.providers.acme)

  const restored = planRestore(repointed.next, inherited, { route: 'bundle', baseURL: 'https://bundle.dev/v1' }, RELAY)
  assert.deepEqual(restored.next.providers.bundle, inherited.providers.bundle)
})

test('repointRoute() commits the plan, restoreRoute() undoes it', async () => {
  const { editor, edits } = repointWorld()
  const { bridge } = bridgeFor(editor)

  const repointed = await bridge.repointRoute({ route: 'acme', baseURL: MOUNT })
  assert.deepEqual(repointed, { name: 'acme', from: ACME, to: MOUNT, changed: true })
  assert.equal(edits.length, 1)

  // What reached the editor: the entry gained no plugin field, nothing else moved.
  assert.deepEqual(Object.keys(edits[0].next.providers.acme), Object.keys(acmeRoute()))
  assert.deepEqual(edits[0].next.providers['openrouter-custom'], sourceRoute())
  assert.deepEqual(edits[0].next.providers.acme.models, acmeRoute().models)

  const restored = await bridge.restoreRoute({ route: 'acme', baseURL: ACME })
  assert.deepEqual(restored, { name: 'acme', from: MOUNT, to: ACME, changed: true })
  assert.equal(edits.length, 2)
  assert.deepEqual(edits[1].next.providers, { acme: acmeRoute(), 'openrouter-custom': sourceRoute() })

  // A refusal reaches the caller unchanged: the endpoints show error.message,
  // so it must not be re-wrapped as a generic save failure.
  await assert.rejects(
    () => bridge.repointRoute({ route: 'missing', baseURL: MOUNT }),
    /Provider route "missing" is not configured in @deepseek-ai\/dsh-llm-pi-ai/,
  )
  assert.equal(edits.length, 2, 'a refused plan never writes')
})

test('the bridge wrappers never write when nothing changes', async () => {
  const { editor, edits } = repointWorld()
  const { bridge } = bridgeFor(editor)
  const noop = await bridge.repointRoute({ route: 'acme', baseURL: ACME })
  assert.deepEqual(noop, { name: 'acme', from: ACME, to: ACME, changed: false })
  assert.equal(edits.length, 0, 'a no-op repoint must not touch the profile')

  const routed = repointWorld({ config: { providers: { acme: acmeRoute({ baseURL: MOUNT }) } } })
  const { bridge: routedBridge } = bridgeFor(routed.editor)
  const restored = await routedBridge.restoreRoute({ route: 'acme', baseURL: `${MOUNT}/` })
  assert.equal(restored.changed, false)
  assert.equal(routed.edits.length, 0, 'a no-op restore must not touch the profile')
})

test('the bridge wrappers reject with a user-readable message when unavailable', async () => {
  const { bridge } = bridgeFor(null)
  assert.equal(bridge.available(), false)
  await assert.rejects(
    () => bridge.repointRoute({ route: 'acme', baseURL: MOUNT }),
    /configuration editor is not available/i,
  )
  await assert.rejects(
    () => bridge.restoreRoute({ route: 'acme', baseURL: ACME }),
    /configuration editor is not available/i,
  )
})

// ---------------------------------------------------------------------------
// relay mounts: /t/<targetId>/<tier>/v1 (the relay's second URL family)
// ---------------------------------------------------------------------------

test('targets() reads a /t/<id>/<tier>/v1 mount as that tier plus its target id', async () => {
  const tierless = `${RELAY}/t/acme-gw-9f3a/v1`
  const { editor } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute(),
        acme: sourceRoute({ baseURL: MOUNT }),
        passthrough: sourceRoute({ baseURL: tierless }),
        legacy: sourceRoute({
          displayName: 'openrouter-custom (priority) — OpenRouter Plus',
          baseURL: `${RELAY}/priority/v1`,
        }),
      },
    },
  })
  const { bridge } = bridgeFor(editor)
  const { sources, created } = await bridge.targets()

  const source = Object.fromEntries(sources.map((entry) => [entry.key, entry]))
  assert.equal(source.acme.attachedTier, 'flex', 'the tier after the target id, never the "t" segment')
  assert.equal(source.acme.targetId, 'acme-gw-9f3a')
  assert.equal(source.passthrough.attachedTier, undefined, '/t/<id>/v1 pins no tier')
  assert.equal(source.passthrough.targetId, 'acme-gw-9f3a')
  assert.equal(source.legacy.attachedTier, 'priority', 'the legacy leg still parses its first segment')
  assert.equal(Object.hasOwn(source.legacy, 'targetId'), false)
  assert.equal(source['openrouter-custom'].attachedTier, undefined)
  assert.ok(sources.every((entry) => entry.attachedTier !== 't'), 'the mount segment never leaks as a tier')

  const route = Object.fromEntries(created.map((entry) => [entry.name, entry]))
  assert.deepEqual(route.acme, {
    name: 'acme',
    // A repointed route is not a clone: it has no `${source}-${tier}` origin.
    source: null,
    tier: 'flex',
    baseURL: MOUNT,
    modelCount: 2,
    missingReasoning: 2,
    targetId: 'acme-gw-9f3a',
  })
  assert.deepEqual(route.passthrough, {
    name: 'passthrough',
    source: null,
    tier: null,
    baseURL: tierless,
    modelCount: 2,
    missingReasoning: 2,
    targetId: 'acme-gw-9f3a',
  })
  assert.equal(route.legacy.tier, 'priority')
  assert.equal(route.legacy.source, 'openrouter-custom', 'legacy clones are still attributed')
  assert.equal(route['openrouter-custom'], undefined, 'a route pointing upstream is never ours')

  // listRoutes() is that same list, so a tierless mount is reported too.
  assert.deepEqual((await bridge.listRoutes()).map((entry) => entry.name).sort(), ['acme', 'legacy', 'passthrough'])

  // Degenerate mounts: `/t` alone pins no target and no tier — it must not fall
  // through to the legacy parse and come back as the tier "t". A mount with no
  // `/v1` (which the relay would 404) also reads as no tier, not an invented one.
  for (const [baseURL, targetId] of [
    [`${RELAY}/t`, undefined],
    [`${RELAY}/t/acme-gw-9f3a`, 'acme-gw-9f3a'],
    [`${RELAY}/t/acme-gw-9f3a/flex`, 'acme-gw-9f3a'],
  ]) {
    const { editor: odd } = createFakeEditor({ config: { providers: { acme: sourceRoute({ baseURL }) } } })
    const [entry] = (await bridgeFor(odd).bridge.targets()).sources
    assert.equal(entry.attachedTier, undefined, `${baseURL} pins no tier`)
    assert.equal(entry.targetId, targetId, `${baseURL} names its target`)
  }
})

test('repairRoutes() owns a target mount and never rewrites its base URL', async () => {
  const tierless = `${RELAY}/t/acme-gw-9f3a/v1`
  const { editor, edits } = createFakeEditor({
    config: {
      providers: {
        'openrouter-custom': sourceRoute({ models: [{ id: 'vendor/source-only' }] }),
        acme: sourceRoute({ baseURL: MOUNT, models: [{ id: 'vendor/acme-large' }] }),
        passthrough: sourceRoute({ baseURL: tierless, models: [{ id: 'vendor/acme-small' }] }),
      },
    },
  })
  const { bridge } = bridgeFor(editor, { reasoningEfforts: EFFORTS })
  const result = await bridge.repairRoutes()

  assert.equal(result.changed, true)
  assert.deepEqual(result.owned.sort(), ['acme', 'passthrough'], 'a mount is ours by prefix, tier or not')
  assert.deepEqual(result.unresolved, [])

  const next = edits[0].next.providers
  assert.equal(next.acme.baseURL, MOUNT, 'the mount URL is left exactly as it was')
  assert.equal(next.passthrough.baseURL, tierless)
  assert.deepEqual(next.acme.models[0].reasoningEfforts, EFFORTS, 'only the reasoning capability is filled')
  assert.deepEqual(next.passthrough.models[0].reasoningEfforts, EFFORTS)
  assert.deepEqual(next['openrouter-custom'], editor.state.config.providers['openrouter-custom'], 'upstream routes stay byte-identical')
})

test('repoint/restore treat a /t/<id>/<tier>/v1 mount as relay-owned', () => {
  const mounted = { providers: { acme: acmeRoute({ baseURL: MOUNT }) } }
  assert.throws(
    () => planRepoint(mounted, {}, { route: 'acme', baseURL: ACME }, RELAY),
    /already points at the OpenRouter Plus relay \("http:\/\/127\.0\.0\.1:8791\/t\/acme-gw-9f3a\/flex\/v1"\)/,
  )

  // A tierless mount is equally ours, and restore is the only way off the relay.
  const tierless = `${RELAY}/t/acme-gw-9f3a/v1`
  const passthrough = { providers: { acme: acmeRoute({ baseURL: tierless }) } }
  assert.throws(
    () => planRepoint(passthrough, {}, { route: 'acme', baseURL: ACME }, RELAY),
    /already points at the OpenRouter Plus relay/,
  )
  const restored = planRestore(passthrough, {}, { route: 'acme', baseURL: ACME }, RELAY)
  assert.deepEqual(restored.result, { name: 'acme', from: tierless, to: ACME, changed: true })
  assert.equal(restored.next.providers.acme.baseURL, ACME)

  // A route already on its own endpoint has nothing to undo.
  assert.throws(
    () => planRestore({ providers: { acme: acmeRoute() } }, {}, { route: 'acme', baseURL: ACME }, RELAY),
    /is not routed through OpenRouter Plus/,
  )
})
// ---------------------------------------------------------------------------
// retiering an attached provider: same relay target, one write
// ---------------------------------------------------------------------------

const TARGET_A = `${RELAY}/t/acme-gw-9f3a/v1`
const TARGET_A_FLEX = `${RELAY}/t/acme-gw-9f3a/flex/v1`
const TARGET_A_PRIORITY = `${RELAY}/t/acme-gw-9f3a/priority/v1`
const TARGET_B_FLEX = `${RELAY}/t/other-gw-1a2b/flex/v1`

test('planRepoint() retiers a route inside the same relay target', () => {
  // flex -> priority: one plan, and everything but `baseURL` is byte-identical.
  const current = {
    providers: { acme: acmeRoute({ baseURL: TARGET_A_FLEX }), 'openrouter-custom': sourceRoute() },
  }
  const { next, result } = planRepoint(current, {}, { route: 'acme', baseURL: TARGET_A_PRIORITY }, RELAY)
  assert.deepEqual(result, { name: 'acme', from: TARGET_A_FLEX, to: TARGET_A_PRIORITY, changed: true })
  assert.deepEqual(Object.keys(next.providers.acme), Object.keys(acmeRoute()), 'still only pi-ai fields')
  const { baseURL: _moved, ...rest } = next.providers.acme
  const { baseURL: _was, ...expected } = acmeRoute()
  assert.deepEqual(rest, expected)
  assert.deepEqual(next.providers['openrouter-custom'], current.providers['openrouter-custom'])

  // Both mount spellings count, in both directions, so pass-through <-> tier is
  // the same one-write operation as tier <-> tier.
  for (const [from, to] of [
    [TARGET_A, TARGET_A_FLEX],
    [TARGET_A_FLEX, TARGET_A],
    [TARGET_A, TARGET_A_PRIORITY],
    [TARGET_A_PRIORITY, TARGET_A],
  ]) {
    const plan = planRepoint({ providers: { acme: acmeRoute({ baseURL: from }) } }, {}, { route: 'acme', baseURL: to }, RELAY)
    assert.deepEqual(plan.result, { name: 'acme', from, to, changed: true }, `${from} -> ${to}`)
    assert.equal(plan.next.providers.acme.baseURL, to)
  }
})

test('repointing to the mount the route already has is a no-op, not a write', async () => {
  const snapshot = { providers: { acme: acmeRoute({ baseURL: MOUNT }) } }
  const planned = planRepoint(snapshot, {}, { route: 'acme', baseURL: MOUNT }, RELAY)
  assert.deepEqual(planned.result, { name: 'acme', from: MOUNT, to: MOUNT, changed: false })
  assert.equal(planned.next.providers.acme.baseURL, MOUNT)
  assert.ok(isDeepStrictEqual(planned.next, snapshot), 'a no-op plan deep-equals the snapshot, so commit() skips the write')

  const world = repointWorld({ config: { providers: { acme: acmeRoute({ baseURL: MOUNT }) } } })
  const { bridge } = bridgeFor(world.editor)
  const again = await bridge.repointRoute({ route: 'acme', baseURL: `${MOUNT}/` })
  assert.deepEqual(again, { name: 'acme', from: MOUNT, to: `${MOUNT}/`, changed: false })
  assert.equal(world.edits.length, 0, 'an idempotent attach must not touch the profile')
})

test('planRepoint() still refuses a different target, a legacy mount, or leaving the relay', () => {
  const attached = { providers: { acme: acmeRoute({ baseURL: TARGET_A_FLEX }) } }
  const refusal = /already points at the OpenRouter Plus relay .*so the plugin owns it and it cannot be repointed/

  // A different target: that is another owner's mount, so detach first.
  assert.throws(() => planRepoint(attached, {}, { route: 'acme', baseURL: TARGET_B_FLEX }, RELAY), refusal)
  // A legacy catalog leg names no target, on either side.
  assert.throws(
    () => planRepoint({ providers: { acme: acmeRoute({ baseURL: `${RELAY}/flex/v1` }) } }, {}, { route: 'acme', baseURL: TARGET_A_FLEX }, RELAY),
    refusal,
  )
  assert.throws(() => planRepoint(attached, {}, { route: 'acme', baseURL: `${RELAY}/priority/v1` }, RELAY), refusal)
  // Off the relay entirely is a restore, never a repoint.
  assert.throws(() => planRepoint(attached, {}, { route: 'acme', baseURL: ACME }, RELAY), refusal)
  // planRestore is still that one way back.
  const restored = planRestore({ providers: { acme: acmeRoute({ baseURL: TARGET_A_FLEX }) } }, {}, { route: 'acme', baseURL: ACME }, RELAY)
  assert.deepEqual(restored.result, { name: 'acme', from: TARGET_A_FLEX, to: ACME, changed: true })
  assert.equal(restored.next.providers.acme.baseURL, ACME)
})

test('repointRoute() retiers an attached provider with exactly one write', async () => {
  const world = repointWorld({ config: { providers: { acme: acmeRoute({ baseURL: MOUNT }), 'openrouter-custom': sourceRoute() } } })
  const { bridge } = bridgeFor(world.editor)

  const retiered = await bridge.repointRoute({ route: 'acme', baseURL: TARGET_A_PRIORITY })
  assert.deepEqual(retiered, { name: 'acme', from: MOUNT, to: TARGET_A_PRIORITY, changed: true })
  assert.equal(world.edits.length, 1, 'a tier change is one write, not detach + attach')
  assert.equal(world.edits[0].next.providers.acme.baseURL, TARGET_A_PRIORITY)
  assert.deepEqual(world.edits[0].next.providers.acme.models, acmeRoute().models)
  assert.deepEqual(world.edits[0].next.providers['openrouter-custom'], sourceRoute())

  // Back down to the pass-through mount is one write too.
  const back = await bridge.repointRoute({ route: 'acme', baseURL: TARGET_A })
  assert.deepEqual(back, { name: 'acme', from: TARGET_A_PRIORITY, to: TARGET_A, changed: true })
  assert.equal(world.edits.length, 2)
  assert.equal(world.edits[1].next.providers.acme.baseURL, TARGET_A)
})

test('describeSources() reports the stored base URL verbatim, mounts included', async () => {
  const padded = `  ${MOUNT}  `
  const { editor } = createFakeEditor({
    config: {
      providers: {
        acme: acmeRoute({ baseURL: MOUNT }),
        padded: acmeRoute({ baseURL: padded }),
        legacy: acmeRoute({ baseURL: `${RELAY}/priority/v1` }),
        upstream: acmeRoute(),
      },
    },
  })
  const [acme, paddedRow, legacy, upstream] = (await bridgeFor(editor).bridge.targets()).sources

  // The Models row strip feeds this to `attach` as `upstream`, so it must be the
  // value the profile actually holds — never normalised, never rewritten to an origin.
  assert.equal(acme.baseURL, MOUNT)
  assert.equal(paddedRow.baseURL, padded, 'stored padding survives; only the truthiness check trims')
  assert.equal(legacy.baseURL, `${RELAY}/priority/v1`)
  assert.equal(upstream.baseURL, ACME)
  // Which is exactly why an attached row is identified by targetId, not by baseURL.
  assert.equal(acme.targetId, 'acme-gw-9f3a')
  assert.equal(paddedRow.targetId, 'acme-gw-9f3a')
  assert.equal(Object.hasOwn(legacy, 'targetId'), false)
  assert.equal(Object.hasOwn(upstream, 'targetId'), false)
})

// ---------------------------------------------------------------------------
// twinRoute(): the idempotent per-tier sibling provider
// ---------------------------------------------------------------------------

/** A target-mounted source row: the pass-through mount of one relay target. */
function twinWorld(providers = {}) {
  return createFakeEditor({
    config: {
      providers: {
        acme: acmeRoute({ baseURL: TARGET_A }),
        'openrouter-custom': sourceRoute(),
        ...providers,
      },
    },
  })
}

test('twinRoute() creates the sibling of a target-mounted route for one tier', async () => {
  const world = twinWorld()
  const { bridge } = bridgeFor(world.editor)

  const twin = await bridge.twinRoute({ route: 'acme', tier: 'flex' })

  assert.deepEqual(twin, {
    name: 'acme-flex',
    baseURL: TARGET_A_FLEX,
    tier: 'flex',
    source: 'acme',
    created: true,
    // Evidence-only filling: the fixture declares no reasoningEfforts anywhere.
    reasoning: { filled: [], unresolved: ['acme-gw-large'] },
  })
  assert.equal(world.edits.length, 1)

  const created = world.edits[0].next.providers['acme-flex']
  assert.equal(created.baseURL, TARGET_A_FLEX)
  assert.equal(created.displayName, 'acme gateway (flex) — OpenRouter Plus')
  // Cloned verbatim, like every other relay route this module writes.
  assert.equal(created.api, 'openai-responses')
  assert.equal(created.apiKeyEnv, 'ACME_API_KEY')
  const sourceModels = world.state.config.providers.acme.models
  assert.deepEqual(created.models, sourceModels)
  assert.notEqual(created.models, sourceModels, 'models is a deep copy, not a shared reference')
  assert.notEqual(created.models[0], sourceModels[0])
  // The source and the unrelated route are untouched.
  assert.deepEqual(world.edits[0].next.providers.acme, acmeRoute({ baseURL: TARGET_A }))
  assert.deepEqual(world.edits[0].next.providers['openrouter-custom'], sourceRoute())
})

test('twinRoute() is idempotent: the second identical call writes nothing', async () => {
  const world = twinWorld()
  const { bridge } = bridgeFor(world.editor)

  const first = await bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.equal(first.created, true)
  assert.equal(world.edits.length, 1)

  const second = await bridge.twinRoute({ route: 'acme', tier: 'flex' })
  // Reuse computes nothing, so it reports an empty fill against the same row.
  assert.deepEqual(second, { ...first, created: false, reasoning: { filled: [], unresolved: [] } })
  assert.equal(world.edits.length, 1, 'the second POST must not call editor.edit at all')

  // A sibling that already exists under a non-default key is reused by mount,
  // not duplicated: the tier family is the target id, not the route name.
  const custom = createFakeEditor({
    config: {
      providers: {
        acme: acmeRoute({ baseURL: TARGET_A }),
        'renamed-flex': acmeRoute({ baseURL: TARGET_A_FLEX }),
      },
    },
  })
  const reused = await bridgeFor(custom.editor).bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.deepEqual(reused, {
    name: 'renamed-flex',
    baseURL: TARGET_A_FLEX,
    tier: 'flex',
    source: 'acme',
    created: false,
    reasoning: { filled: [], unresolved: [] },
  })
  assert.equal(custom.edits.length, 0)
})

test('twinRoute() supports the tierless mount as one tier of the family', async () => {
  const world = twinWorld({ acme: acmeRoute({ baseURL: TARGET_A_FLEX }) })
  const { bridge } = bridgeFor(world.editor)

  const twin = await bridge.twinRoute({ route: 'acme', tier: '' })
  assert.deepEqual(twin, {
    name: 'acme-pass',
    baseURL: TARGET_A,
    tier: null,
    source: 'acme',
    created: true,
    reasoning: { filled: [], unresolved: ['acme-gw-large'] },
  })
  assert.equal(world.edits[0].next.providers['acme-pass'].baseURL, TARGET_A)
  assert.equal(world.edits[0].next.providers['acme-pass'].displayName, 'acme gateway (pass-through) — OpenRouter Plus')

  // Asking again for the tierless row finds it (undefined behaves like '').
  const again = await bridgeFor(world.editor).bridge.twinRoute({ route: 'acme' })
  assert.equal(again.name, 'acme-pass')
  assert.equal(again.created, false)
  assert.equal(world.edits.length, 1)
})

test('twinRoute() is family-scoped: another target or another tier is not reused', async () => {
  const otherTarget = twinWorld({ 'other-flex': acmeRoute({ baseURL: TARGET_B_FLEX }) })
  const { bridge } = bridgeFor(otherTarget.editor)
  const twin = await bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.equal(twin.name, 'acme-flex', 'a sibling of a different target is not this family')
  assert.equal(twin.created, true)
  assert.equal(otherTarget.edits[0].next.providers['acme-flex'].baseURL, TARGET_A_FLEX)

  const otherTier = twinWorld({ 'acme-priority': acmeRoute({ baseURL: TARGET_A_PRIORITY }) })
  const tiered = await bridgeFor(otherTier.editor).bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.equal(tiered.name, 'acme-flex', 'a sibling of the same target at another tier is not reused')
  assert.equal(tiered.created, true)

  // The tier the source row pins itself is its own twin, so nothing is created.
  const sourceAtFlex = twinWorld({ acme: acmeRoute({ baseURL: TARGET_A_FLEX }) })
  const itself = await bridgeFor(sourceAtFlex.editor).bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.deepEqual(itself, {
    name: 'acme',
    baseURL: TARGET_A_FLEX,
    tier: 'flex',
    source: 'acme',
    created: false,
    reasoning: { filled: [], unresolved: [] },
  })
  assert.equal(sourceAtFlex.edits.length, 0)
})

test('twinRoute() refuses a route with no tier family, an unknown tier or a taken name', async () => {
  const notAFamily = twinWorld({ legacy: acmeRoute({ baseURL: `${RELAY}/flex/v1` }), plain: acmeRoute() })
  const { bridge } = bridgeFor(notAFamily.editor)
  const noFamily = /is not routed through a per-endpoint target yet, so it has no tier family; route it from Settings → Models first\./
  await assert.rejects(() => bridge.twinRoute({ route: 'legacy', tier: 'flex' }), noFamily)
  await assert.rejects(() => bridge.twinRoute({ route: 'plain', tier: 'flex' }), noFamily)
  await assert.rejects(() => bridge.twinRoute({ route: 'openrouter-custom', tier: 'flex' }), noFamily)
  assert.equal(notAFamily.edits.length, 0, 'a refusal never writes')

  const world = twinWorld({ 'acme-priority': acmeRoute({ baseURL: TARGET_A_PRIORITY }) })
  const familyBridge = bridgeFor(world.editor).bridge
  await assert.rejects(
    () => familyBridge.twinRoute({ route: 'acme', tier: 'turbo' }),
    /Service tier "turbo" is not enabled\. Choose one of: flex, priority\./,
  )
  await assert.rejects(
    () => familyBridge.twinRoute({ route: 'acme', tier: 'flex', name: 'acme-priority' }),
    /A provider route named "acme-priority" already exists\./,
  )
  await assert.rejects(
    () => familyBridge.twinRoute({ route: 'ghost', tier: 'flex' }),
    /No provider route named "ghost" is configured, so there is no tier family to clone\./,
  )
  await assert.rejects(
    () => familyBridge.twinRoute({ tier: 'flex' }),
    /Choose the provider route to derive a tier sibling from\./,
  )
  assert.equal(world.edits.length, 0, 'no refusal may reach the editor')
})

test('twinRoute() honours an explicit name and fills reasoning like createRoute()', async () => {
  const world = twinWorld()
  const filled = await bridgeFor(world.editor, { reasoningEfforts: EFFORTS }).bridge.twinRoute({ route: 'acme', tier: 'flex', name: 'acme-fast' })
  assert.equal(filled.name, 'acme-fast')
  assert.deepEqual(filled.reasoning, { filled: [{ id: 'acme-gw-large', from: 'default' }], unresolved: [] })
  assert.equal(world.edits[0].next.providers['acme-fast'].baseURL, TARGET_A_FLEX)
  assert.deepEqual(world.edits[0].next.providers['acme-fast'].models[0].reasoningEfforts, EFFORTS)

  // reasoningEfforts: false is an opt-out, and the result names what stays bare.
  const optedOut = twinWorld()
  const bare = await bridgeFor(optedOut.editor, { reasoningEfforts: false }).bridge.twinRoute({ route: 'acme', tier: 'flex' })
  assert.deepEqual(bare.reasoning, { filled: [], unresolved: ['acme-gw-large'] })
  assert.equal(optedOut.edits[0].next.providers['acme-flex'].models[0].reasoningEfforts, undefined)
})
