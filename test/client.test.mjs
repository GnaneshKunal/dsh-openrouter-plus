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
  /* The chip's three facets: the readers behind them, and the two dictionaries a new key
     has to land in together. */
  baseModelId,
  chipBadgeLabel,
  chipBadgeParts,
  chipFacetRows,
  chipPaneAfterKey,
  chipPaneRoot,
  chipPanes,
  chipRootCells,
  dictionaries,
  normalizePrecisionState,
  normalizeProviderList,
  normalizeProviderPin,
  normalizeProviderState,
  pinnedProviderLabel,
  precisionFloorOf,
  precisionFloors,
  precisionPostBody,
  precisionShortLabel,
  precisionWireLevels,
  providerHint,
  providerPinForModel,
  providerPrecisions,
  providerTiers,
} = module.__test

/**
 * A `t()` over the real English (or Chinese) dictionary, failing loud on a key the
 * dictionaries do not carry: a missing key renders its own name in the chip, which is the
 * bug these tests exist to prevent rather than reproduce.
 */
const translate = (dictionary) => (key, vars) => {
  const template = dictionary[key]
  assert.equal(typeof template, 'string', 'no dictionary entry for ' + key)
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : match,
  )
}
const en = translate(dictionaries.en)
const zh = translate(dictionaries.zh)

/** The preset ids the tier facet lists, inherit excluded. */
const PRESET_ROWS = [
  'none',
  'standard',
  'fastest',
  'fastest-standard',
  'cheapest',
  'flex',
  'priority',
  'ultra',
  'floor',
]

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

test('the collapsed badge composes the preset with the precision, and hides it for any', () => {
  /* One trigger, so the badge is the only place both choices meet. The trigger paints the two
     halves as separate spans — the preset in the primary tone, the floor in the caption tone,
     the way the model seat prints "model  effort" — and these are the strings those spans
     carry. The halves are glued by the row's own `gap`, so there is no punctuation between
     them: `any` must leave no separator and no trailing space behind. */
  const preset = 'Cheapest'
  const badge = (precision) => chipBadgeLabel(en, preset, precision)

  assert.equal(badge({ floor: 'any' }), 'Cheapest')
  assert.equal(badge(null), 'Cheapest', 'a failed fetch must not decorate the chip')
  assert.equal(badge({ floor: 'no-four-bit' }), 'Cheapest \u22656-bit')
  assert.equal(badge({ floor: 'eight-bit-up' }), 'Cheapest \u22658-bit')
  assert.equal(badge({ floor: 'full-width' }), 'Cheapest FP16+')

  /* `any` leaves no second half behind: it is absent, not empty, and never a stray separator. */
  assert.equal(badge({ floor: 'any' }).includes('\u00b7'), false)
  assert.equal(badge({ floor: 'any' }).includes(' '), false)
  /* A floor from a newer relay is not allowed to render a raw i18n key. */
  assert.equal(badge({ floor: 'future-floor' }), 'Cheapest')

  assert.equal(precisionShortLabel(en, 'any'), '', 'any is hidden, not labelled')
  assert.equal(precisionShortLabel(en, 'full-width'), 'FP16+')
  assert.equal(precisionFloorOf(undefined), 'any')
  assert.equal(precisionFloorOf('EIGHT-BIT-UP'), 'eight-bit-up')
})

test('the two drilled panes are two distinct lists', () => {
  /* Tier lists the nine presets behind the inherit row; Precision lists four floors with
     the wire levels each admits. Drilling into one or the other swaps the rows, never the
     trigger. */
  const view = {
    presetLabel: (id) => en('preset.' + id),
    profileDefault: 'standard',
    chosenPreset: 'cheapest',
    precisionFloor: 'eight-bit-up',
  }
  const tier = chipFacetRows(en, 'tier', view)
  const precision = chipFacetRows(en, 'precision', view)

  assert.equal(tier.length, PRESET_ROWS.length + 1, 'inherit, then every preset')
  assert.equal(tier[0].value, '', 'the inherit row is the empty value, as the POST expects')
  assert.equal(tier[0].label, 'Profile default (Standard)')
  assert.deepEqual(tier.slice(1).map((row) => row.value), PRESET_ROWS)
  assert.deepEqual(tier.filter((row) => row.selected).map((row) => row.value), ['cheapest'])
  assert.equal(tier[1].hint, '', 'a preset row stays one line')

  assert.deepEqual(precision.map((row) => row.value), [...precisionFloors])
  assert.deepEqual(precision.map((row) => row.label), [
    'Any',
    'No four-bit',
    'Eight-bit up',
    'Full width',
  ])
  assert.deepEqual(precision.filter((row) => row.selected).map((row) => row.value), [
    'eight-bit-up',
  ])
  /* Every row names what it admits, from the relay's own wire vocabulary. */
  assert.equal(precision[0].hint, 'No filter: every endpoint stays eligible.')
  assert.equal(
    precision[1].hint,
    'Admits ' + precisionWireLevels['no-four-bit'].join(', '),
    'fp6 is 4-bit-adjacent but above it: the no-four-bit floor admits it',
  )
  assert.equal(precision[2].hint, 'Admits ' + precisionWireLevels['eight-bit-up'].join(', '))
  assert.equal(precision[3].hint, 'Admits ' + precisionWireLevels['full-width'].join(', '))
  /* Each floor is a strictly narrower list than the one before it. */
  assert.ok(precisionWireLevels['full-width'].length < precisionWireLevels['eight-bit-up'].length)
  assert.ok(precisionWireLevels['eight-bit-up'].length < precisionWireLevels['no-four-bit'].length)
  assert.deepEqual(precisionWireLevels.any, [])

  /* The swap is real: the two facets never show the same rows. */
  assert.notDeepEqual(
    tier.map((row) => row.value),
    precision.map((row) => row.value),
  )
  /* The Chinese chip renders Chinese facet and row copy, not English. */
  assert.equal(zh('chip.facet.precision'), '精度')
  assert.equal(chipFacetRows(zh, 'precision', view)[1].label, '不含四位')
})

test('the precision POST names the floor and that floor\u2019s own unknown default', () => {
  /* The frozen body: { session, precision: { floor, includeUnknown } }. `allow` is the
     relay's materialised wire list and is deliberately never sent from here. */
  assert.deepEqual(precisionPostBody('sess-1', 'eight-bit-up'), {
    session: 'sess-1',
    precision: { floor: 'eight-bit-up', includeUnknown: true },
  })
  assert.deepEqual(precisionPostBody('sess-1', 'no-four-bit').precision, {
    floor: 'no-four-bit',
    includeUnknown: true,
  })
  /* "Full width" that admits undeclared precision is not a floor. */
  assert.deepEqual(precisionPostBody('sess-1', 'full-width').precision, {
    floor: 'full-width',
    includeUnknown: false,
  })
  /* `any` is the released behaviour: no list is sent, so the relay's own default (off)
     is named rather than inventing a true the Host would not have produced. */
  assert.deepEqual(precisionPostBody('sess-1', 'any'), {
    session: 'sess-1',
    precision: { floor: 'any', includeUnknown: false },
  })
  /* The per-floor table is the relay's (`lib/quantization.js`): unknown is admitted by
     the two middle floors only. */
  assert.equal(precisionPostBody('s', 'any').precision.includeUnknown, false)
  assert.equal(precisionPostBody('s', 'no-four-bit').precision.includeUnknown, true)
  assert.equal(precisionPostBody('s', 'eight-bit-up').precision.includeUnknown, true)
  assert.equal(precisionPostBody('s', 'full-width').precision.includeUnknown, false)
  assert.equal(precisionPostBody('sess-1', 'nonsense').precision.floor, 'any')
  assert.equal(Object.prototype.hasOwnProperty.call(precisionPostBody('s', 'any').precision, 'allow'), false)
})

test('a failed precision fetch leaves the chip exactly as it shipped', () => {
  /* The chip must never be the thing that breaks the composer: every junk answer reads as
     "no answer", and the badge then renders the preset alone. */
  for (const junk of [null, undefined, 'x', 42, [], {}, { ok: false }, { precision: null }, { precision: 'x' }]) {
    assert.equal(normalizePrecisionState(junk), null)
  }
  assert.equal(chipBadgeLabel(en, en('preset.cheapest'), null), 'Cheapest')

  const full = normalizePrecisionState({
    precision: {
      floor: 'eight-bit-up',
      includeUnknown: true,
      allow: ['int8', ' fp8 ', ''],
    },
    inherited: true,
    source: 'session',
  })
  assert.deepEqual(full, {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8'],
    inherited: true,
    source: 'session',
  })
  /* A relay that reports the floor without the switch still gets the documented default. */
  assert.equal(normalizePrecisionState({ precision: { floor: 'full-width' } }).includeUnknown, false)
  assert.equal(normalizePrecisionState({ precision: { floor: 'no-four-bit' } }).includeUnknown, true)
  assert.equal(normalizePrecisionState({ precision: { floor: 'any' } }).includeUnknown, false)
  /* `allow: null` is the materialised "sends nothing" of `any`, not a parse failure. */
  assert.equal(normalizePrecisionState({ precision: { floor: 'any', allow: null } }).allow, null)
  assert.equal(normalizePrecisionState({ precision: { floor: 'any' } }).inherited, false)
  assert.equal(normalizePrecisionState({ precision: { floor: 'any' } }).source, 'default')
})

test('both dictionaries carry every key, and the Chinese copy is Chinese', () => {
  /* A key in one language only renders its own name for the other reader. The zh side must
     be real Chinese; the one exemption is a unit (`FP16+`), which is not a translation. */
  const keys = Object.keys(dictionaries.en).sort()
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), keys, 'same key set in both languages')

  const added = keys.filter(
    (key) =>
      key.startsWith('precision.') || key.startsWith('chip.') || key.startsWith('provider.'),
  )
  assert.ok(added.length >= 15, 'the chip keys are registered, not inlined')
  for (const key of added) {
    if (key === 'precision.short.full-width') continue
    assert.match(dictionaries.zh[key], /[\u4e00-\u9fff]/, key + ' is not Chinese')
    assert.notEqual(dictionaries.zh[key], dictionaries.en[key], key + ' is the English string again')
  }
  assert.equal(dictionaries.en['precision.short.full-width'], 'FP16+')
  assert.equal(dictionaries.zh['precision.short.full-width'], 'FP16+')

  /* The provider facet's frozen copy. The cell says `Auto`, the row it opens names what
     that means, and the badge uses the same two halves as the cell. */
  assert.equal(dictionaries.en['chip.facet.provider'], 'Provider')
  assert.equal(dictionaries.zh['chip.facet.provider'], '\u63d0\u4f9b\u5546')
  assert.equal(dictionaries.en['provider.auto'], 'Auto')
  assert.equal(dictionaries.zh['provider.auto'], '\u81ea\u52a8')
  assert.equal(dictionaries.en['provider.autoRow'], 'Auto (OpenRouter routing)')

  /* The frozen short labels, exactly as the collapsed badge shows them. */
  assert.equal(dictionaries.en['precision.short.no-four-bit'], '\u22656-bit')
  assert.equal(dictionaries.en['precision.short.eight-bit-up'], '\u22658-bit')
  assert.equal(dictionaries.en['chip.facet.tier'], 'Tier')
  assert.equal(dictionaries.en['chip.facet.precision'], 'Precision')
  assert.equal(dictionaries.en['precision.unknownAdmitted'], 'Unknown precision is admitted')
})

/** The endpoint row a pinned Session carries, as `/provider` reports it. */
const PIN = {
  tag: 'relace/fp4',
  name: 'Relace',
  tier: 'standard',
  precision: 'fp4',
}

test('the root pane is three cells, and a pin owns the pair it overrides', () => {
  /* The menu opens on the cells, never on a list. Each cell carries the value the trigger
     badges — the preset label, the floor's short label, the endpoint — plus the drill-in
     target. A pinned endpoint decides its own tier and precision, so those two cells state
     the endpoint's values and are disabled; the Provider cell stays open, because it is the
     one that can undo the pin. */
  const view = (overrides) => ({
    presetLabel: (id) => en('preset.' + id),
    activePreset: 'cheapest',
    switchingPreset: false,
    floor: 'any',
    provider: null,
    ...(overrides || {}),
  })

  const cells = chipRootCells(en, view())
  assert.equal(cells.length, 3, 'Tier, Precision then Provider')
  assert.deepEqual(cells.map((cell) => cell.facet), ['tier', 'precision', 'provider'])
  assert.deepEqual(cells.map((cell) => cell.label), ['Tier', 'Precision', 'Provider'])
  assert.deepEqual(cells.map((cell) => cell.value), ['Cheapest', 'Any', 'Auto'])
  assert.deepEqual(cells.map((cell) => cell.ariaLabel), [
    'Tier: Cheapest',
    'Precision: Any',
    'Provider: Auto',
  ])
  /* Nothing pinned: nothing is disabled, so the released chip still offers both lists. */
  assert.deepEqual(cells.map((cell) => cell.disabled === true), [false, false, false])
  /* The cells drill into exactly the drilled panes, and root is the pane they sit on. */
  assert.deepEqual(cells.map((cell) => cell.facet), chipPanes.filter((pane) => pane !== chipPaneRoot))
  assert.equal(chipPaneRoot, 'root')
  assert.equal(chipPanes[0], chipPaneRoot, 'root is the pane the popover opens on')

  /* The floor half reuses the badge's shorthand, not the row's long label. */
  assert.equal(chipRootCells(en, view({ floor: 'eight-bit-up' }))[1].value, '\u22658-bit')
  assert.equal(chipRootCells(en, view({ floor: 'no-four-bit' }))[1].value, '\u22656-bit')
  assert.equal(chipRootCells(en, view({ floor: 'full-width' }))[1].value, 'FP16+')
  assert.equal(chipRootCells(en, view({ floor: 'future-floor' }))[1].value, 'Any')
  /* A Host that never answered reads as `any`, exactly like the badge. */
  assert.equal(chipRootCells(en, view({ floor: null }))[1].value, 'Any')
  /* A preset in flight says so, matching the trigger. */
  assert.equal(
    chipRootCells(en, view({ switchingPreset: true }))[0].value,
    'Switching preset\u2026',
  )

  /* Pinned: the endpoint's own tier and precision stand in, both cells are disabled, and
     the Provider cell is the one control left. */
  const pinned = chipRootCells(en, view({ provider: PIN }))
  assert.deepEqual(pinned.map((cell) => cell.value), ['Standard', 'fp4', 'Relace \u00b7 fp4'])
  assert.deepEqual(pinned.map((cell) => cell.disabled === true), [true, true, false])
  /* A pin whose row declared nothing still states something, rather than an empty cell. */
  const bare = chipRootCells(en, view({ provider: { tag: 'x/y' } }))
  assert.deepEqual(bare.map((cell) => cell.value), ['\u2014', 'unknown', 'x/y \u00b7 unknown'])
  assert.deepEqual(bare.map((cell) => cell.disabled === true), [true, true, false])
  /* A body without a tag is not a pin: the released cells come back. */
  assert.deepEqual(
    chipRootCells(en, view({ provider: { name: 'Relace' } })).map((cell) => cell.value),
    ['Cheapest', 'Any', 'Auto'],
  )

  /* The Chinese cell names itself in Chinese. */
  assert.equal(
    chipRootCells(zh, view({ floor: 'eight-bit-up' }))[1].ariaLabel,
    '\u7cbe\u5ea6\uff08\u5f53\u524d \u22658\u4f4d\uff09',
  )
  assert.equal(chipRootCells(zh, view())[2].label, '\u63d0\u4f9b\u5546')
  assert.equal(chipRootCells(zh, view({ provider: PIN }))[2].value, 'Relace \u00b7 fp4')
})

test('a pinned endpoint badges as the endpoint, and the released badge is untouched', () => {
  /* One trigger, so the badge is the only place the three choices meet. Pinned, the
     endpoint replaces both halves — it outranks the tier and the floor — and keeps a
     separator the released badge does not have. Unpinned, the composition is byte-for-byte
     the string the chip shipped with, which is what keeps an unconfigured chip identical. */
  const preset = 'Cheapest'
  assert.deepEqual(chipBadgeParts(en, preset, { floor: 'eight-bit-up' }), {
    label: 'Cheapest',
    precision: '\u22658-bit',
  })
  assert.deepEqual(chipBadgeParts(en, preset, { floor: 'any' }), {
    label: 'Cheapest',
    precision: '',
  })
  assert.equal(chipBadgeLabel(en, preset, { floor: 'any' }), 'Cheapest', 'no separator crept in')

  assert.deepEqual(chipBadgeParts(en, preset, { floor: 'eight-bit-up' }, PIN), {
    label: 'Relace',
    precision: '\u00b7 fp4',
  })
  assert.equal(chipBadgeLabel(en, preset, { floor: 'eight-bit-up' }, PIN), 'Relace \u00b7 fp4')
  /* A pin stands even when the Host never reported a preset or a floor. */
  assert.equal(chipBadgeLabel(en, preset, null, PIN), 'Relace \u00b7 fp4')
  /* The precision is a shorthand, so it is never translated; `unknown` is a word. */
  assert.equal(chipBadgeLabel(en, preset, null, { tag: 'x/y', precision: 'bf16' }), 'x/y \u00b7 bf16')
  assert.equal(chipBadgeLabel(en, preset, null, { tag: 'x/y' }), 'x/y \u00b7 unknown')
  assert.equal(chipBadgeLabel(zh, preset, null, { tag: 'x/y' }), 'x/y \u00b7 \u672a\u77e5')
  /* Not a tag, not a pin: the ordinary badge is what renders. */
  assert.equal(chipBadgeLabel(en, preset, { floor: 'any' }, { name: 'Relace' }), preset)
  assert.equal(chipBadgeLabel(en, preset, { floor: 'any' }, null), preset)

  /* The Provider cell states exactly what the pinned badge states. */
  assert.equal(pinnedProviderLabel(en, PIN), 'Relace \u00b7 fp4')
  assert.equal(pinnedProviderLabel(en, null), 'Auto')
  assert.equal(pinnedProviderLabel(en, { name: 'Relace' }), 'Auto', 'a body without a tag is no pin')
})

/** A `/providers` body with everything the pane has to place: groups, duplicates, junk. */
const PROVIDER_PAYLOAD = {
  ok: true,
  model: 'deepseek/deepseek-v4',
  fetchedAt: 1_700_000_000_000,
  cached: true,
  providers: [
    {
      tag: 'relace/fp4',
      name: 'Relace',
      tier: 'standard',
      precision: 'fp4',
      inputPrice: 0.035,
      outputPrice: 0.5,
      uptime1d: 100,
      status: 0,
    },
    {
      tag: 'deepinfra/bf16',
      name: 'DeepInfra',
      tier: 'standard',
      precision: 'bf16',
      inputPrice: 0.27,
      outputPrice: 1.1,
      uptime1d: 99.5,
      status: 0,
    },
    {
      tag: 'slowco/fp8',
      name: 'Slowco',
      tier: 'flex',
      precision: 'fp8',
      inputPrice: 0.1,
      outputPrice: 0.2,
      uptime1d: null,
      /* The Host read a zeroed uptime and said so. `status` rides along and is never
         promoted to availability: a negative health code is common on endpoints that
         serve most of a model's traffic. */
      available: false,
      status: 3,
    },
    { tag: 'loose/mxfp4', name: 'Loose', tier: 'priority', precision: 'mxfp4', status: 0 },
    { tag: 'stray/fp16', name: 'Stray', tier: 'standard', precision: 'fp16' },
    { tag: '   ', name: 'No tag' },
  ],
  groups: [
    { id: 'standard', tags: ['relace/fp4', 'deepinfra/bf16', 'not-listed/fp8'] },
    { id: 'flex', tags: ['deepinfra/bf16'] },
    { id: 'unavailable', tags: ['slowco/fp8'] },
    { id: 'free', tags: ['loose/mxfp4'] },
  ],
}

test('the endpoint pane lists the clear row, then every group the host ordered', () => {
  /* One flat list: a heading row per group the Host declared, the endpoints under it, and
     anything the Host did not place appended at the end. Nothing is dropped — a hidden
     endpoint is a pin nobody can clear — and an endpoint outside standard routing is drawn
     quiet rather than withheld. */
  const list = normalizeProviderList(PROVIDER_PAYLOAD)
  const view = (overrides) => ({ providerList: list, pinnedTag: '', ...(overrides || {}) })

  const rows = chipFacetRows(en, 'provider', view({ pinnedTag: 'relace/fp4' }))
  assert.deepEqual(
    rows.map((row) => (row.header === true ? '#' + row.label : row.label)),
    [
      'Auto (OpenRouter routing)',
      '#Standard',
      'Relace',
      'DeepInfra',
      '#Unavailable',
      'Slowco',
      'Loose',
      'Stray',
    ],
    'the clear row first, then the Host order, then whatever no group claimed',
  )
  /* The headings are labels, not options: they carry no value and cannot be picked. */
  assert.deepEqual(
    rows.filter((row) => row.header === true).map((row) => row.value),
    ['', ''],
  )
  assert.equal(rows[0].value, '', 'the clear row posts the empty tag, as the API expects')
  /* Only the pinned tag is ticked, and the clear row is not. */
  assert.deepEqual(rows.filter((row) => row.selected === true).map((row) => row.value), [
    'relace/fp4',
  ])

  /* A row names its trade: precision, price per million and the day's uptime. A field the
     Host did not report is left out rather than printed as a dash. */
  const relace = rows.find((row) => row.value === 'relace/fp4')
  assert.equal(relace.hint, 'fp4 \u00b7 $0.035/$0.5 per M \u00b7 100%')
  assert.equal(rows.find((row) => row.value === 'slowco/fp8').hint, 'fp8 \u00b7 $0.1/$0.2 per M')
  assert.equal(rows.find((row) => row.value === 'loose/mxfp4').hint, 'mxfp4')
  assert.equal(relace.unavailable, false)
  assert.equal(rows.find((row) => row.value === 'slowco/fp8').unavailable, true, 'the Host reported it as not answering')
  assert.equal(rows.find((row) => row.value === 'stray/fp16').unavailable, false)

  /* No pin: the clear row is the ticked one. */
  assert.deepEqual(
    chipFacetRows(en, 'provider', view()).filter((row) => row.selected === true).map((row) => row.value),
    [''],
  )

  /* A Host that 404s the route holds exactly one row — the one that clears a pin — and
     still renders: the menu never depends on a route that may not exist. */
  const empty = chipFacetRows(en, 'provider', { providerList: normalizeProviderList(null) })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].label, 'Auto (OpenRouter routing)')
  assert.equal(empty[0].selected, true)
  /* A view without any list at all is the same pane, not a crash. */
  assert.equal(chipFacetRows(en, 'provider', {}).length, 1)
  /* A pin the Host no longer lists leaves nothing ticked, and the clear row is still there
     to undo it — the chip never invents an endpoint row it cannot verify. */
  const stale = chipFacetRows(en, 'provider', {
    providerList: normalizeProviderList(null),
    pinnedTag: 'relace/fp4',
  })
  assert.deepEqual(stale.filter((row) => row.selected === true), [])
  assert.equal(stale[0].label, 'Auto (OpenRouter routing)')

  /* The headings are translated: the tier words are the preset table's, and the last one
     is the facet's own. */
  const zhRows = chipFacetRows(zh, 'provider', view())
  assert.deepEqual(
    zhRows.filter((row) => row.header === true).map((row) => row.label),
    ['\u6807\u51c6', '\u4e0d\u53ef\u7528'],
  )
  assert.equal(zhRows[0].label, '\u81ea\u52a8\uff08OpenRouter \u8def\u7531\uff09')
})

test('the endpoint readers absorb an older host instead of throwing', () => {
  /* Every refusal — a 404 from a Host that predates the route, the route's own 502, a body
     that is not this API — has to read as "nothing listed", because the Provider cell then
     says `Auto` and the pane keeps its clear row. */
  const empty = {
    model: '',
    fetchedAt: null,
    cached: false,
    providers: [],
    groups: [],
  }
  for (const junk of [
    null,
    undefined,
    'x',
    42,
    [],
    {},
    { ok: false },
    { error: 'not found' },
    { providers: 'nope', groups: 'nope' },
    { providers: [null, 'x', { tag: '   ' }] },
  ]) {
    assert.deepEqual(normalizeProviderList(junk), empty, 'a non-answer is an empty list')
  }

  const list = normalizeProviderList(PROVIDER_PAYLOAD)
  assert.equal(list.model, 'deepseek/deepseek-v4')
  assert.equal(list.providers.length, 5, 'a row that cannot name a tag is not a row')
  assert.deepEqual(list.providers.map((row) => row.tag), [
    'relace/fp4',
    'deepinfra/bf16',
    'slowco/fp8',
    'loose/mxfp4',
    'stray/fp16',
  ])
  /* Group order is the Host's; a tag listed twice stays under its first group, a tag the
     list does not carry is dropped, and a tag no group claimed gets a group of its own so
     it renders instead of vanishing. */
  assert.deepEqual(list.groups, [
    { id: 'standard', tags: ['relace/fp4', 'deepinfra/bf16'] },
    { id: 'unavailable', tags: ['slowco/fp8'] },
    { id: 'free', tags: ['loose/mxfp4'] },
    { id: '', tags: ['stray/fp16'] },
  ])
  assert.equal(list.fetchedAt, 1_700_000_000_000)
  assert.equal(list.cached, true)

  /* Availability is the Host's answer, derived from uptime. `status` is never promoted to
     it — the real DeepSeek V4.1 Flash listing reports -5 on the endpoint carrying a third
     of that model's tokens — and an absent `available` is treated as alive rather than dead. */
  assert.equal(list.providers[0].available, true)
  assert.equal(list.providers[2].available, false)
  assert.equal(normalizeProviderList({ providers: [{ tag: 'a/b', available: false }] }).providers[0].available, false)
  assert.equal(normalizeProviderList({ providers: [{ tag: 'a/b', status: -5 }] }).providers[0].available, true, 'a health code is not a verdict')
  assert.equal(normalizeProviderList({ providers: [{ tag: 'a/b', status: 0 }] }).providers[0].available, true)
  /* An unrecognised precision is its own value, not the loss of one. */
  assert.equal(normalizeProviderList({ providers: [{ tag: 'a/b', precision: 'fp17' }] }).providers[0].precision, 'unknown')
  assert.equal(normalizeProviderList({ providers: [{ tag: 'a/b', name: '  ' }] }).providers[0].name, 'a/b')

  /* `/provider`: a Session pin, a clear, and a body that is not this API. */
  for (const junk of [null, undefined, 'x', 42, [], {}, { ok: false }]) {
    assert.equal(normalizeProviderState(junk), null)
  }
  assert.equal(
    normalizeProviderState(PROVIDER_PAYLOAD),
    null,
    'a `/providers` body is not a pin answer',
  )
  assert.deepEqual(
    normalizeProviderState({
      ok: true,
      session: 'sess-1',
      provider: { tag: 'relace/fp4', name: 'Relace', tier: 'standard', precision: 'fp4' },
      chosen: 'relace/fp4',
      model: 'deepseek/deepseek-v4',
      available: true,
    }),
    {
      provider: { tag: 'relace/fp4', name: 'Relace', tier: 'standard', precision: 'fp4' },
      chosen: 'relace/fp4',
      model: 'deepseek/deepseek-v4',
      available: true,
    },
  )
  assert.deepEqual(normalizeProviderState({ ok: true, provider: null, chosen: null, model: null }), {
    provider: null,
    chosen: null,
    model: null,
    available: true,
  })
  assert.equal(normalizeProviderState({ ok: true, provider: null }).available, true)
  assert.equal(
    normalizeProviderState({ ok: true, provider: null, available: false }).available,
    false,
  )
  assert.equal(normalizeProviderPin({ name: 'Relace' }), null, 'a pin is its tag')
  assert.equal(normalizeProviderPin('relace/fp4'), null)
})

test('the endpoint list is asked for per model, not per preset variant', () => {
  /* `:floor` and `:nitro` are levers the relay applies itself: every variant of one model
     lands on the same endpoints, so a variant inside the id would mint one fetch and one
     cache row per preset the Session ever tried. Any other suffix is part of the id. */
  assert.equal(baseModelId('deepseek/deepseek-v4:floor'), 'deepseek/deepseek-v4')
  assert.equal(baseModelId('deepseek/deepseek-v4:nitro'), 'deepseek/deepseek-v4')
  assert.equal(baseModelId(' deepseek/deepseek-v4:floor '), 'deepseek/deepseek-v4')
  assert.equal(baseModelId('deepseek/deepseek-v4'), 'deepseek/deepseek-v4')
  assert.equal(baseModelId('openai/gpt-5:online'), 'openai/gpt-5:online', 'only price variants are stripped')
  assert.equal(baseModelId(':floor'), ':floor', 'a bare suffix is not a variant of a model')
  assert.equal(baseModelId(null), '')
  assert.equal(baseModelId(undefined), '')

  /* The vocabularies the cells and the rows are read against. */
  assert.deepEqual([...providerTiers], ['standard', 'flex', 'priority'])
  assert.deepEqual([...providerPrecisions], ['fp4', 'fp8', 'mxfp4', 'bf16', 'unknown'])
  /* A row's hint never invents a fact: what is missing is missing. */
  assert.equal(providerHint(en, { precision: 'unknown' }), 'unknown')
  assert.equal(providerHint(en, null), '')

  /* A pin belongs to the model it was pinned for: the Host reports the id, so a pin left
     over from another model is not this model's endpoint. A missing id is trusted. */
  const pinned = { ok: true, provider: PIN, chosen: PIN.tag, model: 'deepseek/deepseek-v4' }
  assert.deepEqual(providerPinForModel(pinned, 'deepseek/deepseek-v4'), PIN)
  assert.deepEqual(
    providerPinForModel(pinned, 'deepseek/deepseek-v4:floor'),
    PIN,
    'a variant is the same model: the id is compared without its suffix',
  )
  assert.deepEqual(
    providerPinForModel({ ...pinned, model: 'deepseek/deepseek-v4:floor' }, 'deepseek/deepseek-v4'),
    PIN,
  )
  assert.equal(
    providerPinForModel(pinned, 'deepseek/deepseek-v5'),
    null,
    "another model's pin is not this chip's endpoint",
  )
  assert.deepEqual(providerPinForModel({ ...pinned, model: null }, 'deepseek/deepseek-v4'), PIN)
  assert.equal(providerPinForModel({ ok: true, provider: null }, 'deepseek/deepseek-v4'), null)
  assert.equal(providerPinForModel(null, 'deepseek/deepseek-v4'), null)
  assert.equal(providerPinForModel({ provider: { name: 'Relace' } }, 'deepseek/deepseek-v4'), null)
})

test('Escape and Shift+Tab leave a drilled pane before they close the popover', () => {
  /* The model picker's ladder: the first press backs out of a list to the cell that opened
     it, the second closes. Anything else leaves the pane alone. */
  assert.equal(chipPaneAfterKey('tier', 'Escape', false), chipPaneRoot)
  assert.equal(chipPaneAfterKey('precision', 'Escape', false), chipPaneRoot)
  assert.equal(chipPaneAfterKey('tier', 'Tab', true), chipPaneRoot, 'Shift+Tab backs out too')
  assert.equal(chipPaneAfterKey('precision', 'Tab', true), chipPaneRoot)
  assert.equal(chipPaneAfterKey('provider', 'Escape', false), chipPaneRoot)
  assert.equal(chipPaneAfterKey('provider', 'Tab', true), chipPaneRoot)
  assert.equal(chipPaneAfterKey(chipPaneRoot, 'Escape', false), null, 'the second press closes')
  assert.equal(chipPaneAfterKey(chipPaneRoot, 'Tab', true), null, 'Shift+Tab closes from root')
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab', 'a']) {
    assert.equal(chipPaneAfterKey('precision', key, false), 'precision', key + ' stays drilled')
    assert.equal(chipPaneAfterKey('provider', key, false), 'provider', key + ' stays drilled')
  }
  assert.equal(chipPaneAfterKey(chipPaneRoot, 'Tab', false), chipPaneRoot, 'Tab alone moves on')
})

test('the chip is one trigger over a two-level root-cell menu that drills in', async () => {
  /* Structural pins for what a unit test cannot render: one composer control, a root pane
     of menuitem cells over a real listbox, both control routes addressed, and a pick that
     returns to the root cells without closing. The tab idiom is gone from the chip for good
     (the usage dialog's own tabs are a different surface and stay). */
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chip = source.slice(
    source.indexOf('function ChipOption'),
    source.indexOf('/* ----------------------------------------- sidebar spend card'),
  )
  assert.ok(chip.includes('function TierChip'), 'the slice covers the chip and both row types')

  assert.equal((source.match(/style: chipStyle\(/g) || []).length, 1, 'one chip, not a second control')
  assert.match(chip, /'aria-haspopup': 'menu'/, 'the trigger opens a menu')
  assert.match(chip, /'aria-expanded': open/)

  /* The idle trigger prints both choices: the preset in the primary tone and the floor in the
     caption tone, the way the model seat prints "model  effort". The floor span is conditional,
     so `any` renders the first half alone and an unconfigured chip cannot grow a stray gap. */
  assert.match(chip, /style: CHIP_TEXT_STYLE \}, badgeParts\.label/)
  assert.match(chip, /style: CHIP_PRECISION_STYLE \}, badgeParts\.precision/)
  assert.match(chip, /badgeParts\.precision === ''/)
  assert.match(source, /caption: 'var\(--dsw-alias-label-caption/)

  /* Root pane: a menu whose cells are buttons with label, current value and a chevron. */
  assert.match(chip, /role: 'menu'/)
  assert.match(chip, /role: 'menuitem'/)
  assert.match(chip, /CHIP_CELL_LABEL_STYLE/)
  assert.match(chip, /CHIP_CELL_VALUE_STYLE/)
  assert.match(chip, /CHIP_CELL_CHEVRON_STYLE/)
  assert.match(source, /function chipCellStyle/, 'the cell keeps the 34px full-width anatomy')

  /* Drilled pane: still a real listbox of options. */
  assert.match(chip, /role: 'listbox'/)
  assert.match(chip, /role: 'option'/)
  assert.equal(/role: 'tablist'/.test(chip), false, 'no tablist role')
  assert.equal(/role: 'tab'/.test(chip), false, 'no tab role')
  assert.equal(/role: 'tabpanel'/.test(chip), false, 'no tabpanel role')
  assert.equal(/aria-controls/.test(chip), false, 'no tab wiring left behind')

  /* Opening always lands on the root pane, and each cell drills into its own list. */
  assert.match(chip, /useState\(CHIP_PANE_ROOT\)/)
  assert.match(chip, /const drill = \(next\) => \{/)
  assert.match(chip, /drill\('tier'\)/)
  assert.match(chip, /drill\('precision'\)/)
  assert.match(chip, /chipPaneAfterKey\(pane, event\.key/)
  assert.match(chip, /pendingFocusRef\.current = from/, 'back hands focus to the opening cell')
  assert.match(
    chip,
    /\[role="option"\]\[aria-selected="true"\]:not\(\[disabled\]\)/,
    'a drill focuses the ticked row',
  )

  /* Both cells address the control API on this page origin, and neither writes config. */
  assert.match(chip, /CONTROL_PREFIX \+ '\/precision\?session='/)
  assert.match(chip, /postControl\('\/precision'/)
  assert.match(chip, /postControl\('\/tier'/)

  /* The endpoint facet addresses both of its routes, asks for the base model id, and joins
     the same one-mutation guard: a pin and a floor can never be written at once. */
  assert.match(chip, /CONTROL_PREFIX \+ '\/providers\?model='/)
  assert.match(chip, /CONTROL_PREFIX \+ '\/provider\?session='/)
  assert.match(chip, /postControl\('\/provider'/)
  assert.match(chip, /baseModelId\(modelKey\)/)
  assert.match(
    chip,
    /const busy = pendingTier !== null \|\| pendingPrecision !== null \|\| pendingProvider !== null;/,
  )
  /* A cell a pin owns launches no list, and the render says so in the same place the
     keyboard's `:not([disabled])` walk does. */
  assert.match(chip, /cell !== undefined && cell\.disabled === true/)
  assert.match(chip, /disabled: cells\[0\]\.disabled/)
  assert.match(chip, /disabled: cells\[1\]\.disabled/)
  assert.match(chip, /disabled: cells\[2\]\.disabled/)
  assert.match(chip, /value: cells\[2\]\.value/, 'the third cell is rendered')
  /* The endpoint pane's headings are labels the arrow keys must not land on. */
  assert.match(chip, /role: 'presentation'/)

  /* The switch handlers never close the popover; a pick returns to the root cells and
     leaves it open, which is the one deliberate difference from the model picker. */
  const sw = chip.slice(
    chip.indexOf('const switchTier = async'),
    chip.indexOf('/* The focusable items of the pane'),
  )
  assert.ok(sw.includes('const switchPrecision'), 'both switch handlers are in the slice')
  assert.equal(sw.includes('setOpen(false)'), false, 'a pick never closes')

  const pick = chip.slice(
    chip.indexOf('const chooseRow'),
    chip.indexOf('const menuStyle = Object.assign'),
  )
  assert.ok(pick.length > 0)
  assert.match(pick, /setPane\(CHIP_PANE_ROOT\)/, 'a pick comes back to the root cells')
})
