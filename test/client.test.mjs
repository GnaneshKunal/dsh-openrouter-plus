import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The browser half is a loader registration, not an ES module export, so the test
 * stands in for `window.__ModuleLoader__`, captures the definition and calls the
 * factory with a React stub. Only the pure payload readers are exercised: they are
 * where a relay/client version skew has to be absorbed instead of thrown.
 */
const captured = []
globalThis.window = { __ModuleLoader__: { load: (definition) => captured.push(definition) } }

await import('../client.js')

assert.equal(captured.length, 1)
const definition = captured[0]
assert.equal(definition.id, 'dsh-openrouter-plus')

class ReactComponent {
  constructor(props) {
    this.props = props
  }
  setState() {}
}
const reactStub = {
  Component: ReactComponent,
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
}
const module = definition.factory((id) => {
  assert.equal(id, 'react')
  return reactStub
})
const {
  normalizeMounts,
  normalizePresetTable,
  normalizePresetState,
  normalizeUsageRecent,
  normalizeUsageStatus,
  pinnedMounts,
  presetFromLegacyTier,
} = module.__test

test('a preset id or a tier name both name a preset', () => {
  assert.equal(presetFromLegacyTier('cheapest'), 'cheapest')
  assert.equal(presetFromLegacyTier('fastest-standard'), 'fastest-standard')
  assert.equal(presetFromLegacyTier('FAST'), 'priority')
  assert.equal(presetFromLegacyTier('priority'), 'priority')
  assert.equal(presetFromLegacyTier('auto'), 'none')
  assert.equal(presetFromLegacyTier('scale'), 'none')
  assert.equal(presetFromLegacyTier('default'), 'standard')
  assert.equal(presetFromLegacyTier(null), null)
  assert.equal(presetFromLegacyTier('nonsense'), null)
})

test('the settings table degrades to the built-in list instead of throwing', () => {
  const modern = normalizePresetTable({
    default: 'cheapest',
    presets: ['none', 'cheapest', 'floor'],
  })
  assert.deepEqual(modern, { presets: ['none', 'cheapest', 'floor'], default: 'cheapest' })

  // A relay from before presets answers `{ default, tiers }` and has no `presets` key.
  const legacy = normalizePresetTable({ default: 'flex', tiers: ['auto', 'flex'] })
  assert.deepEqual(legacy.presets, [
    'none',
    'standard',
    'fastest',
    'fastest-standard',
    'cheapest',
    'flex',
    'priority',
    'ultra',
    'floor',
  ])
  assert.equal(legacy.default, 'flex')

  for (const junk of [null, undefined, 'x', 42, {}, { presets: 'nope' }, { presets: [] }]) {
    const table = normalizePresetTable(junk)
    assert.equal(table.presets.length, 9)
    assert.equal(table.default, 'none')
  }

  // An id this client cannot label must not reach a menu that would render blank.
  assert.deepEqual(normalizePresetTable({ presets: ['future-preset'] }).presets.length, 9)
  // A default outside the advertised list falls back to a preset that is in it.
  const narrowed = normalizePresetTable({ default: 'ultra', presets: ['none', 'floor'] })
  assert.equal(narrowed.default, 'none')
})

test('the chip reads both answer shapes', () => {
  const modern = normalizePresetState({
    ok: true,
    preset: 'cheapest',
    chosen: 'cheapest',
    default: 'priority',
  })
  assert.deepEqual(modern, { chosen: 'cheapest', default: 'priority', preset: 'cheapest' })

  const inherited = normalizePresetState({ ok: true, preset: 'priority', chosen: null, default: 'priority' })
  assert.deepEqual(inherited, { chosen: null, default: 'priority', preset: 'priority' })

  // A tier-era relay answered `{ tier, chosen, default }` with raw tier names.
  const legacy = normalizePresetState({ ok: true, tier: 'fast', chosen: 'flex', default: 'auto' })
  assert.deepEqual(legacy, { chosen: 'flex', default: 'none', preset: 'priority' })

  const passthrough = normalizePresetState({ ok: true, tier: null, chosen: null, default: null })
  assert.deepEqual(passthrough, { chosen: null, default: 'none', preset: 'none' })

  for (const junk of [null, undefined, 'x', { ok: false }, { ok: true }]) {
    assert.equal(normalizePresetState(junk), null)
  }
})

test('one pinned row per outcome, aliases folded away', () => {
  // The shape `/status` reports: a path → tier-name map, including the older names the
  // relay still serves.
  const mounts = normalizeMounts(
    {
      '/ultrafast/v1': 'ultrafast',
      '/priority/v1': 'priority',
      '/default/v1': 'default',
      '/scale/v1': 'scale',
      '/flex/v1': 'flex',
      '/auto/v1': 'auto',
      '/fast/v1': 'fast',
      '/v1': null,
    },
    {},
  )
  const rows = pinnedMounts(mounts).map((row) => [row.preset, row.mount.path])
  assert.deepEqual(rows, [
    ['none', '/v1'],
    ['standard', '/default/v1'],
    ['flex', '/flex/v1'],
    ['priority', '/priority/v1'],
    ['ultra', '/ultrafast/v1'],
  ])

  // A relay that mounts only some tiers yields only those rows, in preset order.
  const partial = normalizeMounts({ '/flex/v1': 'flex', '/v1': null }, {})
  assert.deepEqual(
    pinnedMounts(partial).map((row) => row.preset),
    ['none', 'flex'],
  )

  // Each row carries the traffic counters of its mount, and nothing else.
  const counted = normalizeMounts({ '/flex/v1': 'flex' }, {
    flex: { multiplier: 0.5, requests: 3, promptTokens: 10, completionTokens: 5 },
  })
  assert.deepEqual(pinnedMounts(counted)[0].mount, {
    path: '/flex/v1',
    tier: 'flex',
    requests: 3,
    promptTokens: 10,
    completionTokens: 5,
  })
})

test('the control API is addressed on this page origin, never a port', () => {
  const { controlBase, controlUrl } = module.__test
  assert.equal(controlBase, '', 'the base is this document origin, not an absolute URL')
  assert.equal(controlUrl('/health'), '/__openrouter-plus/health')
  assert.equal(controlUrl('/tier?session=abc'), '/__openrouter-plus/tier?session=abc')
  assert.equal(controlUrl(''), '/__openrouter-plus')
})

test('the browser half names no loopback address or relay port', async () => {
  /* The failure this pins: a page served from another machine cannot resolve
     `127.0.0.1` to the Host, so any absolute loopback URL in the bundle is a bug
     that only shows up on a phone. */
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(/127\.0\.0\.1/.test(source), false, 'no loopback literal')
  assert.equal(/\b879[1-4]\b/.test(source), false, 'no relay port')
  assert.equal(/localhost/.test(source), false, 'no localhost literal')
})

test('the page drops its own title and intro inside the Plugins frame', () => {
  /* The same body answers Settings → OpenRouter Plus and the bundle's Plugins page.
     Only the first frame is empty: the Settings shell supplies no copy of its own, so
     the page has to draw its own `h2` and intro line. The Plugins page draws the
     package title, its version and its `package.json` description above the body, so
     both would print twice. */
  const { pageChrome } = module.__test
  assert.deepEqual(pageChrome('settings'), { title: true, intro: true })
  assert.deepEqual(pageChrome(undefined), { title: true, intro: true }, 'the Settings seat is the default')
  assert.deepEqual(pageChrome('plugins'), { title: false, intro: false })
})

test('the page answers both the Settings nav and the bundle page', () => {
  /* `plugins.bundle.config` is keyed by the BUNDLE's package name — not the row id the
     patch declares (`openrouter-plus`) and not the locale namespace. A wrong key does not
     error: the seat renders nothing, and the plugin's card in Installed plugins keeps
     showing a version and an Uninstall button with nothing to configure. */
  const registrations = []
  const pending = []
  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, factory) => {
        pending.push({ name, factory })
        return () => {}
      },
      register: (entry, component) => {
        registrations.push({ entry, component })
        return () => {}
      },
    },
    inject: () => {},
  }

  module.apply(ctx)
  for (const { factory } of pending) factory()

  const byName = (name) => registrations.find((registration) => registration.entry.name === name)
  const section = byName('settings.section')
  assert.equal(section.entry.id, 'openrouter-plus')
  assert.equal(typeof section.component, 'function')

  const bundle = byName('plugins.bundle.config')
  assert.ok(bundle, 'the bundle page has no body without this registration')
  assert.equal(bundle.entry.key, 'dsh-openrouter-plus', 'keyed by the bundle package name')
  assert.equal(bundle.entry.key, definition.id, 'and the loader id is that same package')
  assert.equal(typeof bundle.component, 'function')

  /* Two registrations, two components: the seat travels as a prop, so the Plugins one
     must not be the Settings page handed over again without it. */
  assert.notEqual(bundle.component, section.component)
})

test('the Sync control is offered only on a provider row routed through the relay', async () => {
  /* The rule: the **Route through OpenRouter Plus** switch is on every `llm-pi-ai`
     card, and the live-model picker (button and panel alike) waits for that switch.
     Pinned structurally because the strip is a slot registration, not an export:
     two readers of one `canSyncModels` predicate cannot drift apart unnoticed. */
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const canSyncModels = ticked && modelEndpoint !== '';/)
  const reads = source.match(/canSyncModels/g) || []
  assert.equal(reads.length, 3, 'one declaration, and the button plus the picker reading it')
  /* The pre-fix shape offered the button on any row with an endpoint. */
  assert.equal(/modelEndpoint === ''\s*\n\s*\? null/.test(source), false, 'no ungated button')
})

test('the sidebar card draws nothing unless the Host reports a usable status', () => {
  /* Each clause is a Host reality the card cannot explain in a sidebar footer, so
     `null` (render nothing) is the answer rather than a confident `$0.00`. */
  const base = {
    ok: true,
    bound: true,
    usageWidget: { enabled: true },
    metrics: { costUsd: 0, todayUsd: 0 },
  }
  assert.equal(normalizeUsageStatus(null), null)
  assert.equal(normalizeUsageStatus({ ...base, ok: false }), null, 'the Host reports a failure')
  assert.equal(normalizeUsageStatus({ ...base, bound: false }), null, 'the relay owns no socket')
  assert.equal(normalizeUsageStatus({ ...base, usageWidget: undefined }), null, 'a Host from before the flag')
  assert.equal(normalizeUsageStatus({ ...base, usageWidget: { enabled: false } }), null, 'the card is off')
  assert.equal(normalizeUsageStatus({ ...base, metrics: {} }), null, 'a Host from before the money fields')
  assert.equal(normalizeUsageStatus({ ...base, metrics: { costUsd: '0.5' } }), null, 'a non-number is not cost')

  const usage = normalizeUsageStatus(base)
  assert.equal(usage.totalUsd, 0, 'a real zero is usable: the feature is present and the window is empty')
  assert.equal(usage.todayUsd, 0)
  /* A Host that reports the total without today: the card says "not reported" for the
     day rather than $0.00. */
  assert.equal(normalizeUsageStatus({ ...base, metrics: { costUsd: 0.5 } }).todayUsd, null)
})

test('the sidebar rollups keep their order and drop rows they cannot label', () => {
  const usage = normalizeUsageStatus({
    ok: true,
    bound: true,
    usageWidget: { enabled: true },
    metrics: {
      costUsd: 0.9,
      todayUsd: 0.4,
      byModel: [
        { model: 'a/model', requests: '3', promptTokens: 1, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 5, costUsd: 0.4 },
        { model: '', requests: 9, costUsd: 9 },
        null,
        { model: 'b/model', costUsd: null },
      ],
      byTier: {
        flex: { requests: 2, costUsd: 0.1, multiplier: 0.5 },
        priority: { requests: 1, costUsd: 0.3, multiplier: 2 },
        idle: { requests: 0, costUsd: 5, multiplier: 1 },
        broken: null,
      },
      recent: [],
    },
  })

  assert.deepEqual(usage.byModel.map((row) => row.model), ['a/model', 'b/model'])
  assert.equal(usage.byModel[0].promptTokens, 1, 'counts are numbers; a missing one defaults to 0')
  assert.equal(usage.byModel[0].cacheReadTokens, 4)
  assert.equal(usage.byModel[1].costUsd, null, 'a model row with no money stays null, not 0')
  /* Cost first, so the expensive preset is not lost at the bottom of a long list; a
     tier with no requests is not shown, because that bucket never carried traffic. */
  assert.deepEqual(usage.byTier.map((row) => row.tier), ['priority', 'flex'])
  assert.equal(usage.byTier[0].multiplier, 2)
})

test('a recent request keeps its raw cost fields, under either spelling', () => {
  /* The Host forwards the sniffer's camelCase view; a payload may also carry the wire's
     snake_case `cost_details`. Both are read, because the dialog must not say "not
     reported" for a field the payload actually carried. */
  const direct = normalizeUsageRecent({
    at: 1_700_000_000_000,
    tier: '',
    preset: 'flex',
    model: 'asked/model',
    servedModel: 'served/model',
    servedTier: 'flex',
    status: 200,
    ms: 12,
    streaming: true,
    promptTokens: 10,
    completionTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    costUsd: null,
    upstreamCostUsd: 0.002,
    costDetails: { server_tool_cost: 0.001 },
    byok: true,
    genId: ' gen-abc ',
  })
  assert.equal(direct.costUsd, null, 'a failed or aborted call is not free')
  assert.equal(direct.upstreamCostUsd, 0.002)
  assert.equal(direct.toolCostUsd, 0.001, 'a snake_case detail key is understood')
  assert.equal(direct.byok, true)
  assert.equal(direct.genId, 'gen-abc', 'the id is trimmed')
  assert.equal(direct.tier, null, 'an empty tier is not a wire tier')
  assert.equal(direct.preset, 'flex')
  assert.equal(direct.servedModel, 'served/model')

  const wire = normalizeUsageRecent({ cost_details: { upstream_inference_completions_cost: 0.004 } })
  assert.equal(wire.completionCostUsd, 0.004)
  assert.equal(wire.upstreamCostUsd, null, 'a detail that was not reported stays null')
  assert.equal(wire.byok, false, 'only a real true opts the row into BYOK')
  assert.equal(normalizeUsageRecent(null), null)
  assert.equal(normalizeUsageRecent('nope'), null)
})
