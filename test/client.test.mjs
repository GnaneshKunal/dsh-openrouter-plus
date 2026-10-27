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
