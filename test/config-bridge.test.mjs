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

import { createConfigBridge } from '../lib/config-bridge.js'

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
