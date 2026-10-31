/**
 * Integration test for the Host entry: it boots the real `apply()` against a
 * minimal stand-in for a cordis context and talks to the resulting listener over
 * HTTP, exactly as the Models card does.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

import { apply, normalizeConfig, normalizeRoutes, normalizeSessionPrecisions, normalizeUsageWidget } from '../index.js'

/* Every boot in this file writes the usage snapshot under `$DSH_HOME`. Point that at a
   throwaway directory so a test run can neither read nor overwrite the real one. */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-openrouter-plus-test-'))

/** The version the package declares, so `/health` is compared against the truth and not a literal. */
const { version: PACKAGE_VERSION } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

/** Reserve a port by binding it, then hand it over. */
async function freePort() {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}

/**
 * The smallest cordis-shaped context `apply()` needs.
 *
 * @param {{ configEditor?: any }} [options] an editor stub, when the test drives
 *   the endpoints that read and write config (the relay never touches it)
 */
function createFakeContext(options = {}) {
  /** @type {Array<() => unknown>} */
  const disposers = []
  /** @type {string[]} */
  const logs = []
  const sink = (level) => (...args) => logs.push(`${level}: ${args.map(String).join(' ')}`)
  return {
    ctx: {
      logger: { info: sink('info'), warn: sink('warn'), error: sink('error') },
      get: (name) => (name === 'configEditor' ? options.configEditor : undefined),
      on: () => () => {},
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
    },
    logs,
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

/**
 * A `ctx.configEditor` stub over plain rows: `edit` applies the planner to the
 * entry's config in place, exactly the contract `config-bridge` relies on.
 * @param {Array<any>} rows
 */
function createFakeEditor(rows) {
  const writes = []
  return {
    rows,
    writes,
    configuration: () => rows,
    async edit(entry, change) {
      const before = entry?.options?.config ?? {}
      const next = change(before, entry?.inherited ?? {})
      writes.push({ entry, before, next })
      if (entry?.options) entry.options.config = next
      return next
    },
  }
}

/** The plugin's own row, as the Loader builds it. */
function ownRow(options = {}) {
  return { entry: { options: { id: 'openrouter-plus', name: 'dsh-openrouter-plus', config: options } }, inherited: {}, override: options }
}

/** The `llm-pi-ai` row with the given providers. */
function piAiRow(providers) {
  const config = { providers }
  return { entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config } }, inherited: {}, override: config }
}

/** The suffix every clone's display name carries exactly once. */
const DISPLAY_SUFFIX = ' — OpenRouter Plus'

/** Count the non-overlapping occurrences of `needle` in `haystack`. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * A synthetic tier family on one per-endpoint mount. `tid1` is never registered:
 * the bridge reads the target out of the base URL alone, which keeps these tests
 * about naming rather than about the target registry.
 *
 * @param {string} origin relay origin, e.g. `http://127.0.0.1:8791`
 * @param {Record<string, unknown>} [extra] further provider rows for the fixture
 */
function familyProviders(origin, extra = {}) {
  return {
    root: {
      displayName: 'openrouter-test',
      api: 'openai-completions',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: `${origin}/t/tid1/flex/v1`,
      models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' }],
    },
    plain: {
      displayName: 'Plain',
      api: 'openai-completions',
      baseURL: 'https://api.plain.dev/v1',
      models: [{ id: 'plain-large', name: 'Plain Large' }],
    },
    ...extra,
  }
}

/** Post JSON with the guard header the control layer requires. */
function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oorp-client': 'web' },
    body: JSON.stringify(body),
  })
}

/** Wait until `probe()` resolves truthy, or fail after `timeoutMs`. */
async function waitFor(probe, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the relay')
}

/** Drain a request body; the relay forwards JSON and the fake upstreams read it back. */
async function readRequestBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** One `/models/<author>/<slug>/endpoints` answer for a set of precisions. */
function endpointListing(levels) {
  return {
    data: {
      endpoints: levels.map((quantization, index) => ({
        provider_name: `provider-${index}`,
        tag: `provider-${index}/${quantization}`,
        quantization,
        status: 'active',
      })),
    },
  }
}

test('normalizeConfig applies defaults and rejects nonsense', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 8791)
  assert.equal(defaults.upstream, 'https://openrouter.ai/api/v1')
  assert.equal(defaults.routes['/flex/v1'], 'flex')
  assert.equal(defaults.routes['/v1'], null)

  const custom = normalizeConfig({ port: 'nope', upstream: 'https://example.test/api/', routes: { 'flex/v1': 'FLEX' } })
  assert.equal(custom.port, 8791, 'a non-integer port falls back')
  assert.equal(custom.upstream, 'https://example.test/api', 'trailing slash is stripped')
  assert.equal(custom.routes['/flex/v1'], 'flex', 'mounts are normalised and tiers lowercased')

  assert.deepEqual(normalizeRoutes({}), normalizeConfig(undefined).routes, 'an empty map keeps the defaults')

  // Reasoning filling: `false` disables it, absent means evidence-only, a map is
  // the blanket fallback. Unknown levels and blank wires are dropped.
  assert.equal(normalizeConfig(undefined).reasoningEfforts, null)
  assert.equal(normalizeConfig({ reasoningEfforts: false }).reasoningEfforts, false)
  assert.deepEqual(
    normalizeConfig({ reasoningEfforts: { off: null, low: 'low', medium: '   ', bogus: 'x' } }).reasoningEfforts,
    { off: null, low: 'low' },
  )
})

test('the sidebar card is on unless it was switched off', () => {
  // Absent means on: the card is part of the feature, not an opt-in.
  assert.equal(normalizeConfig(undefined).usageWidget.enabled, true)
  assert.equal(normalizeConfig({}).usageWidget.enabled, true)
  assert.equal(normalizeConfig({ usageWidget: { enabled: true } }).usageWidget.enabled, true)
  assert.equal(normalizeConfig({ usageWidget: { enabled: false } }).usageWidget.enabled, false)
  // A hand-edited row may write the whole setting as the bare boolean; both read the
  // same, and anything else stays on rather than hiding the card by accident.
  assert.equal(normalizeConfig({ usageWidget: false }).usageWidget.enabled, false)
  assert.equal(normalizeUsageWidget(false), false)
  assert.equal(normalizeUsageWidget({ enabled: false }), false)
  assert.equal(normalizeUsageWidget('false'), true)
  assert.equal(normalizeUsageWidget({ enabled: 'no' }), true)
  assert.equal(normalizeUsageWidget(null), true)
  // `/status` answers the object, so the card has one shape to read either way.
  assert.deepEqual(normalizeConfig({ usageWidget: false }).usageWidget, { enabled: false })
})

test('boots the relay, serves control endpoints, and stops cleanly', async (t) => {
  const port = await freePort()
  const { ctx, logs, dispose } = createFakeContext()

  /* A failure anywhere below would otherwise skip `dispose()` and leave the listener
     bound, which keeps the process alive: the suite hangs instead of reporting a
     failure. The test still asserts the shutdown itself; this is only the net. */
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await dispose()
  }
  t.after(stop)

  apply(ctx, { port, portFallback: false })

  const origin = `http://127.0.0.1:${port}`
  const status = await waitFor(async () => {
    try {
      const response = await fetch(`${origin}/__openrouter-plus/status`)
      return response.ok ? response : null
    } catch {
      return null
    }
  })

  const payload = await status.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.address.port, port)
  assert.equal(payload.upstream, 'https://openrouter.ai/api/v1')
  assert.deepEqual(payload.tiers.sort(), ['auto', 'default', 'fast', 'flex', 'priority', 'scale', 'ultrafast'])
  assert.equal(payload.metrics.requests, 0)
  assert.equal(payload.metrics.effectiveMultiplier, 0)
  assert.ok(logs.some((line) => line.includes('relay listening')), 'startup is logged')

  const health = await (await fetch(`${origin}/__openrouter-plus/health`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.version, PACKAGE_VERSION, '/health reports the version package.json ships')
  assert.equal(typeof health.uptimeMs, 'number')

  // CORS is reflected for a loopback GUI origin only
  const loopback = await fetch(`${origin}/__openrouter-plus/health`, {
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(loopback.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
  const foreign = await fetch(`${origin}/__openrouter-plus/health`, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)

  // A preflight is answered for the GUI, and a POST without the guard header is refused.
  const preflight = await fetch(`${origin}/__openrouter-plus/routes/attach`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(preflight.status, 204)
  const unguarded = await fetch(`${origin}/__openrouter-plus/routes/attach`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(unguarded.status, 403)

  // targets answers even when configEditor is unavailable
  const targets = await (await fetch(`${origin}/__openrouter-plus/targets`)).json()
  assert.equal(targets.available, false)
  assert.deepEqual(targets.sources, [])
  assert.ok(targets.reason.includes('configEditor'))

  // the repair endpoint answers to the same guard: no header, no write
  const unguardedRepair = await fetch(`${origin}/__openrouter-plus/routes/repair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(unguardedRepair.status, 403)
  const guardedRepair = await fetch(`${origin}/__openrouter-plus/routes/repair`, {
    method: 'POST',
    headers: { 'x-oorp-client': 'web' },
  })
  assert.equal(guardedRepair.status, 500, 'without configEditor a repair fails loudly')
  assert.match((await guardedRepair.json()).error.message, /configuration editor is not available/i)

  // a guarded attach validates the row before it touches config: no such row is a 400,
  // and the read it needs an editor for is what a repair reports as a 500 (above)
  const attach = await fetch(`${origin}/__openrouter-plus/routes/attach`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oorp-client': 'web' },
    body: JSON.stringify({ route: 'openrouter', upstream: 'https://openrouter.ai/api/v1' }),
  })
  assert.equal(attach.status, 400)
  assert.match((await attach.json()).error.message, /no provider route named "openrouter"/)

  // The preset table answers with no configEditor at all: it is Session state, not config.
  const tier = await (await fetch(`${origin}/__openrouter-plus/tier?session=abc`)).json()
  assert.equal(tier.ok, true)
  assert.equal(tier.session, 'abc')
  assert.equal(tier.chosen, null, 'a fresh Session has chosen nothing')
  assert.equal(tier.default, 'none', 'an unconfigured profile passes through')
  assert.equal(tier.preset, tier.default, 'and therefore runs on the configured default')
  assert.deepEqual(tier.presets, [
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
  assert.deepEqual(tier.wire, { serviceTier: null, sort: null, variant: null })

  // A POST records the choice for that Session only, and a blank preset clears it.
  const chosen = await postJson(`${origin}/__openrouter-plus/tier`, { session: 'abc', preset: 'priority' })
  assert.equal(chosen.status, 200)
  const chosenBody = await chosen.json()
  assert.equal(chosenBody.chosen, 'priority')
  assert.equal(chosenBody.preset, 'priority')
  assert.deepEqual(chosenBody.wire, { serviceTier: 'priority', sort: null, variant: null })

  // The tier-era spelling still maps onto the preset that sends the same thing.
  const legacy = await (await postJson(`${origin}/__openrouter-plus/tier`, { session: 'abc', tier: 'fast' })).json()
  assert.equal(legacy.preset, 'priority', '`fast` is a spelling of priority')

  // A sort preset names no tier: the wire recipe is where that asymmetry is kept.
  const cheapest = await (
    await postJson(`${origin}/__openrouter-plus/tier`, { session: 'abc', preset: 'cheapest' })
  ).json()
  assert.equal(cheapest.preset, 'cheapest')
  assert.deepEqual(cheapest.wire, { serviceTier: null, sort: 'price', variant: null })

  const other = await (await fetch(`${origin}/__openrouter-plus/tier?session=def`)).json()
  assert.equal(other.chosen, null, 'another Session keeps its own choice')
  const cleared = await (await postJson(`${origin}/__openrouter-plus/tier`, { session: 'abc' })).json()
  assert.equal(cleared.chosen, null)
  assert.equal(cleared.preset, cleared.default)
  const badPreset = await postJson(`${origin}/__openrouter-plus/tier`, { session: 'abc', preset: 'turbo' })
  assert.equal(badPreset.status, 400, 'an unknown preset is refused')
  const noSession = await postJson(`${origin}/__openrouter-plus/tier`, { preset: 'priority' })
  assert.equal(noSession.status, 400, 'the Session is required')

  await stop()

  await waitFor(async () => {
    try {
      await fetch(`${origin}/__openrouter-plus/health`)
      return false
    } catch {
      return true
    }
  })
})

test('the sidebar flag is written through the guarded control API, and only to the plugin row', async (t) => {
  const port = await freePort()
  const editor = createFakeEditor([ownRow({ host: '127.0.0.1', port })])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  // A leaked listener keeps the runner's event loop alive, so cleanup is registered
  // before the first assertion can throw.
  t.after(dispose)
  apply(ctx, { port, portFallback: false })

  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  // The card reads the flag off /status: one object shape whether the config wrote a
  // bare boolean or `{ enabled }`.
  assert.deepEqual((await (await fetch(`${origin}/__openrouter-plus/status`)).json()).usageWidget, { enabled: true })

  const widgetUrl = `${origin}/__openrouter-plus/widget`
  // Every control write carries the guard header; without it nothing is written.
  const unguarded = await fetch(widgetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(unguarded.status, 403)
  assert.equal(editor.writes.length, 0, 'an unguarded write must not reach the config')

  // The flag hides a card, so `enabled` must be a real boolean rather than a value
  // that happens to be falsy.
  for (const body of [{}, { enabled: 'false' }, { enabled: 0 }]) {
    assert.equal((await postJson(widgetUrl, body)).status, 400, `${JSON.stringify(body)} is a bad request`)
  }
  assert.equal(editor.writes.length, 0)

  // The accepted shape is one config edit on the plugin's own row, and nothing else
  // in the profile is touched.
  const written = await postJson(widgetUrl, { enabled: false })
  assert.equal(written.status, 200)
  assert.deepEqual(await written.json(), { ok: true, usageWidget: { enabled: false } })
  assert.equal(editor.writes.length, 1)
  assert.equal(editor.writes[0].entry, editor.rows[0].entry, 'the plugin row is the only row written')
  assert.deepEqual(editor.writes[0].next, { host: '127.0.0.1', port, usageWidget: { enabled: false } })
  // The next boot reads the flag back off the row, bare or boxed.
  assert.equal(normalizeConfig(editor.writes[0].next).usageWidget.enabled, false)
})

test('booting with the card switched off still reports the cost telemetry', async (t) => {
  // Hiding the card hides a surface, not the numbers: the settings page shows the
  // same spend, so /status keeps its full metrics contract.
  const port = await freePort()
  const { ctx, dispose } = createFakeContext()
  t.after(dispose)
  apply(ctx, { port, portFallback: false, usageWidget: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const payload = await (await fetch(`${origin}/__openrouter-plus/status`)).json()
  assert.deepEqual(payload.usageWidget, { enabled: false })
  for (const key of ['costUsd', 'todayUsd', 'byModel', 'byModelAll', 'days', 'byTier']) {
    assert.equal(key in payload.metrics, true, `metrics.${key} is part of /status`)
  }
  assert.equal(Array.isArray(payload.metrics.days), true)
  assert.equal(Array.isArray(payload.metrics.byModel), true)
})

test('enabled: false binds nothing', async () => {
  const port = await freePort()
  const { ctx, logs, dispose } = createFakeContext()

  apply(ctx, { enabled: false, port })

  let listening = true
  try {
    await fetch(`http://127.0.0.1:${port}/__openrouter-plus/health`)
  } catch {
    listening = false
  }
  assert.equal(listening, false, 'enabled: false must not bind a port')
  assert.ok(logs.some((line) => line.includes('disabled by config')))
  await dispose()
})

test('config writes escape the HMR transaction context the listener inherited', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const { outsideHmrTransaction } = await import('../index.js')
  const executing = new AsyncLocalStorage()

  // A listener created inside `runExclusive` inherits the store, so every later
  // request looks like a nested transaction and configEditor.edit() refuses.
  const asNestedRequest = () => executing.run(true, async () => outsideHmrTransaction(ctx, () => executing.getStore()))

  const ctx = { get: () => ({ executing }) }
  assert.equal(await asNestedRequest(), undefined, 'the mutation runs with an empty store')

  // Without HMR the plain call is already correct.
  const bare = { get: () => undefined }
  assert.equal(outsideHmrTransaction(bare, () => 'plain'), 'plain')

  // A throwing or absent `get` must not break route creation.
  assert.equal(outsideHmrTransaction({ get: () => { throw new Error('no such service') } }, () => 'safe'), 'safe')
  assert.equal(outsideHmrTransaction(undefined, () => 'safe'), 'safe')

  // An unexpected hmr shape falls back instead of throwing.
  assert.equal(outsideHmrTransaction({ get: () => ({}) }, () => 'fallback'), 'fallback')
})

test('normalizeTargets keeps only usable mounts', () => {
  const config = normalizeConfig({
    targets: {
      'acme-gw-9f3a': { upstream: 'https://api.acme.dev/v1/', tier: 'FLEX' },
      'passthrough': { upstream: 'http://127.0.0.1:9000/v1' },
      'Bad Id': { upstream: 'https://example.test/v1' },
      '../escape': { upstream: 'https://example.test/v1' },
      'ftp-target': { upstream: 'ftp://example.test/v1' },
      'no-url': {},
      'bad-tier': { upstream: 'https://example.test/v1', tier: 'turbo' },
    },
  })
  assert.deepEqual(Object.keys(config.targets).sort(), ['acme-gw-9f3a', 'bad-tier', 'passthrough'])
  assert.deepEqual(config.targets['acme-gw-9f3a'], { upstream: 'https://api.acme.dev/v1', tier: 'flex' })
  assert.equal(config.targets.passthrough.tier, null, 'no tier is a passthrough mount')
  assert.equal(config.targets['bad-tier'].tier, null, 'an unknown tier is not guessed at')
})

test('registers a target, attaches a provider, and detaches it again', async () => {
  const port = await freePort()
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow({
      acme: {
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL: 'https://api.acme.dev/v1',
        models: [{ id: 'acme-large', name: 'Acme Large' }],
      },
    }),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`

  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  // 1. Register the endpoint the operator typed. No tier means pure passthrough.
  const registered = await postJson(`${origin}/__openrouter-plus/targets/register`, {
    upstream: 'https://api.acme.dev/v1',
  })
  assert.equal(registered.status, 200)
  const registration = await registered.json()
  assert.equal(registration.ok, true)
  assert.equal(registration.target.upstream, 'https://api.acme.dev/v1')
  assert.equal(registration.target.tier, null)
  assert.match(registration.target.id, /^[a-z0-9][a-z0-9_-]{0,31}$/)
  assert.equal(registration.baseURL, `${origin}/t/${registration.target.id}/v1`)
  assert.deepEqual(editor.rows[0].entry.options.config.targets, {
    [registration.target.id]: { upstream: 'https://api.acme.dev/v1', tier: null },
  })

  // The same endpoint again is the same target: registering is idempotent.
  const again = await (await postJson(`${origin}/__openrouter-plus/targets/register`, {
    upstream: 'https://api.acme.dev/v1',
  })).json()
  assert.equal(again.target.id, registration.target.id)
  assert.equal(again.created, false)
  assert.equal(editor.writes.length, 1, 'a repeat registration writes nothing')

  // 2. Attach a provider row: its base URL becomes the mount, nothing else changes.
  //    A tier in the body is ignored — the tier is a per-Session wire field now, so the
  //    row goes to the bare mount and one row serves every tier.
  const attached = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: 'https://api.acme.dev/v1',
    tier: 'flex',
  })
  assert.equal(attached.status, 200)
  const attachResult = await attached.json()
  const mount = `${origin}/t/${registration.target.id}/v1`
  assert.equal(attachResult.baseURL, mount)
  assert.equal(attachResult.changed, true)
  assert.equal(attachResult.target.tier, null, 'attaching pins no tier')
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers.acme.baseURL, mount)
  assert.equal(providers.acme.api, 'openai-completions', 'the protocol is untouched')
  assert.deepEqual(providers.acme.models, [{ id: 'acme-large', name: 'Acme Large' }], 'models are untouched')

  // 3. The target table reports which row is on it, derived from the profile.
  const snapshot = await (await fetch(`${origin}/__openrouter-plus/targets`)).json()
  assert.equal(snapshot.custom.length, 1)
  assert.equal(snapshot.custom[0].route, 'acme')
  assert.equal(snapshot.custom[0].tier, null)
  assert.equal(snapshot.custom[0].baseURL, mount)

  // 3b. Re-attaching is idempotent and still pins no tier: a caller that echoes the mount
  //     back as `upstream` is understood (the registry holds the real endpoint).
  const writesBefore = editor.writes.length
  const retiered = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: mount,
    tier: 'fast',
  })
  assert.equal(retiered.status, 200)
  const retieredBody = await retiered.json()
  assert.equal(retieredBody.target.id, registration.target.id, 'the same endpoint keeps the same target')
  assert.equal(retieredBody.target.tier, null)
  assert.equal(retieredBody.baseURL, mount)
  assert.equal(retieredBody.changed, false, 'the row already sits on the bare mount')
  assert.equal(editor.writes.length, writesBefore, 'a no-op attach writes nothing')
  assert.equal(editor.rows[1].entry.options.config.providers.acme.api, 'openai-completions')

  // 4. Detach without an id: the target is derived from the mount the row sits on.
  const detached = await postJson(`${origin}/__openrouter-plus/routes/detach`, { route: 'acme' })
  assert.equal(detached.status, 200)
  const detachedBody = await detached.json()
  assert.equal(detachedBody.changed, true)
  assert.equal(detachedBody.target.id, registration.target.id)
  assert.equal(detachedBody.baseURL, 'https://api.acme.dev/v1')
  assert.equal(
    editor.rows[1].entry.options.config.providers.acme.baseURL,
    'https://api.acme.dev/v1',
    'the provider is back on its own endpoint',
  )

  await dispose()
})

test('refuses to attach an endpoint that is not http(s) or is this relay', async () => {
  const port = await freePort()
  const editor = createFakeEditor([ownRow({ host: '127.0.0.1', port }), piAiRow({ acme: { baseURL: 'https://api.acme.dev/v1' } })])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  for (const body of [
    { route: 'acme', upstream: 'not-a-url' },
    { route: 'acme', upstream: 'ftp://example.test/v1' },
    { route: 'acme', upstream: `${origin}/flex/v1` },
    { route: 'acme', upstream: 'https://api.acme.dev/v1', tier: 'turbo' },
  ]) {
    const response = await postJson(`${origin}/__openrouter-plus/routes/attach`, body)
    assert.equal(response.status, 400, `${JSON.stringify(body)} is a client error`)
    assert.equal(editor.writes.length, 0, 'a rejected attach writes nothing')
  }

  await dispose()
})

test('a typo cannot leave a target behind, and a foreign target cannot be restored', async () => {
  const port = await freePort()
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow({ acme: { baseURL: 'https://api.acme.dev/v1' } }),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  // An unknown provider must not register a target: the row has to exist first.
  const typo = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acmee',
    upstream: 'https://api.acme.dev/v1',
    tier: 'flex',
  })
  assert.equal(typo.status, 400)
  assert.match((await typo.json()).error.message, /no provider route named "acmee"/)
  assert.equal(editor.writes.length, 0, 'a typo writes nothing at all')

  // Detaching a row that never went through the relay is refused, not guessed at.
  const stray = await postJson(`${origin}/__openrouter-plus/routes/detach`, { route: 'acme' })
  assert.equal(stray.status, 400)
  assert.match((await stray.json()).error.message, /nothing to restore/)

  // Attach for real, then try to re-point the same row at a DIFFERENT endpoint.
  const attached = await (await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: 'https://api.acme.dev/v1',
    tier: 'flex',
  })).json()
  const elsewhere = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: 'https://other.example/v1',
    tier: 'flex',
  })
  assert.equal(elsewhere.status, 400, 'a routed row may be re-tiered, not re-homed')
  assert.match((await elsewhere.json()).error.message, /detach it before routing it to a different endpoint/)
  assert.equal(
    editor.rows[1].entry.options.config.providers.acme.baseURL,
    attached.baseURL,
    'the row keeps the mount it had',
  )

  await dispose()
})

test('switching a Session tier writes no config; only the default is persisted', async () => {
  const port = await freePort()
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow({ acme: { baseURL: 'https://api.acme.dev/v1' } }),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const set = (body) => postJson(`${origin}/__openrouter-plus/tier`, body)

  // A Session's choice is runtime state: writing the plugin row here would reload the
  // plugin and restart the listener on every switch, mid-conversation.
  assert.equal((await set({ session: 'a', preset: 'flex' })).status, 200)
  assert.equal((await set({ session: 'b', preset: 'priority' })).status, 200)
  // The tier-era body shape is still understood, and still writes nothing.
  assert.equal((await set({ session: 'c', tier: 'ultrafast' })).status, 200)
  assert.equal((await set({ session: 'a' })).status, 200)
  assert.equal(editor.writes.length, 0, 'a preset switch must not write the config')

  // The profile-level default is a preference, so it does write — once.
  const chosen = await postJson(`${origin}/__openrouter-plus/tier/default`, { preset: 'flex' })
  assert.equal(chosen.status, 200)
  assert.equal((await chosen.json()).default, 'flex')
  assert.equal(editor.writes.length, 1)
  assert.equal(editor.writes[0].next.defaultPreset, 'flex')
  assert.equal(editor.writes[0].next.sessionPresets, undefined, 'the memory table is never persisted')

  // A tier-era default is read forward rather than rejected.
  const legacy = await postJson(`${origin}/__openrouter-plus/tier/default`, { tier: 'default' })
  assert.equal(legacy.status, 200)
  assert.equal((await legacy.json()).default, 'standard', '`default` is the standard tier, not the profile default')

  const refused = await postJson(`${origin}/__openrouter-plus/tier/default`, { preset: 'turbo' })
  assert.equal(refused.status, 400)
  assert.equal(editor.writes.length, 2, 'a refused default writes nothing')

  // Clearing the default is a legitimate write: pass-through is the answer, not null.
  const cleared = await postJson(`${origin}/__openrouter-plus/tier/default`, {})
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).default, 'none')
  assert.equal(editor.writes.length, 3)
  assert.equal(editor.writes[2].next.defaultPreset, 'none')

  await dispose()
})

test('lists live models and adds only the ones the caller picks', async (t) => {
  const port = await freePort()
  const upstreamPort = await freePort()

  /* A stand-in OpenRouter: a live listing carrying two models the bundled pi-ai
     snapshot does not describe, plus one batch endpoint that must never be offered. */
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        {
          id: 'moonshotai/kimi-k3.1-pro',
          name: 'MoonshotAI: Kimi K3.1 Pro',
          context_length: 1048576,
          architecture: { input_modalities: ['text', 'image', 'video'] },
          top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
        },
        {
          id: 'openai/gpt-6.1-terra',
          name: 'OpenAI: GPT 6.1 Terra',
          context_length: 400000,
          top_provider: { max_completion_tokens: 128000 },
        },
        { id: 'openai/gpt-6.1-terra:batch', name: 'OpenAI: GPT 6.1 Terra (batch)' },
      ],
    }))
  })
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  const declared = { id: 'deepseek/deepseek-v4-flash-0731', name: 'Kept exactly as written' }
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port, reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' } }),
    piAiRow({
      openrouter: {
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
        models: [declared],
      },
    }),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  // Cleanup is registered before anything can throw: a leaked listener keeps the
  // test runner's event loop alive and turns one failed assertion into a timeout.
  t.after(async () => {
    await new Promise((resolve) => upstream.close(() => resolve(undefined)))
    await dispose()
  })
  /* A new model has no capability by inheritance, so the profile's fallback map is
     what gives it an effort selector; without one it stays unresolved (and that is
     the correct behaviour, which `reasoningEfforts: false` also exercises). */
  apply(ctx, {
    port,
    portFallback: false,
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  /* The picker's read: the whole live catalogue, marked with what the route has. */
  const catalogue = await (await fetch(`${origin}/__openrouter-plus/models?route=openrouter`)).json()
  assert.equal(catalogue.ok, true)
  assert.equal(catalogue.source, 'route', 'an unrouted row answers with its own baseURL')
  assert.equal(catalogue.live.count, 2, 'the batch endpoint is not a chat model')
  assert.equal(catalogue.live.skipped, 1)
  assert.deepEqual(
    catalogue.models.map((model) => [model.id, model.inRoute]),
    [['moonshotai/kimi-k3.1-pro', false], ['openai/gpt-6.1-terra', false]],
  )
  assert.equal(editor.writes.length, 0, 'reading the catalogue writes nothing')

  /* An unknown route is a client error, not a 500. */
  assert.equal((await fetch(`${origin}/__openrouter-plus/models?route=openrouter-x`)).status, 400)
  /* The guard header is required on the write. */
  assert.equal((await fetch(`${origin}/__openrouter-plus/models/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ route: 'openrouter', models: ['openai/gpt-6.1-terra'] }),
  })).status, 403)
  /* An empty selection is refused rather than treated as "everything". */
  const empty = await postJson(`${origin}/__openrouter-plus/models/add`, {
    route: 'openrouter',
    models: [],
  })
  const emptyBody = await empty.json()
  assert.equal(empty.status, 400, JSON.stringify(emptyBody))

  /* Pick exactly one, and leave the other alone. */
  const added = await postJson(`${origin}/__openrouter-plus/models/add`, {
    route: 'openrouter',
    models: ['openai/gpt-6.1-terra'],
  })
  assert.equal(added.status, 200)
  const result = await added.json()
  assert.equal(result.ok, true)
  assert.equal(result.upstream, `http://127.0.0.1:${upstreamPort}/v1`)
  assert.deepEqual(result.added, ['openai/gpt-6.1-terra'])
  assert.equal(result.total, 2)

  const row = editor.rows.find((candidate) => candidate.entry?.options?.id === 'llm-pi-ai')
  const models = row.entry.options.config.providers.openrouter.models
  assert.equal(models.length, 2)
  /* The hand-written entry is byte-identical and still first: additions append. */
  assert.deepEqual(models[0], declared)
  assert.deepEqual(models.map((model) => model.id), ['deepseek/deepseek-v4-flash-0731', 'openai/gpt-6.1-terra'])
  /* The route gains the protocol its new model needs: `llm-pi-ai` reads the route's
     `api`, never the entry's, and `openrouter`'s catalog spans two protocols so no
     shared value can be inherited. Without this the write is rejected. */
  assert.equal(row.entry.options.config.providers.openrouter.api, 'openai-completions')
  /* A new model also gets an effort selector, or it materialises as reasoning: false. */
  const grown = models.find((model) => model.id === 'openai/gpt-6.1-terra')
  assert.deepEqual(Object.keys(grown.reasoningEfforts || {}), ['off', 'low', 'medium', 'high', 'max'])
  /* The unselected live model was not added, and no batch endpoint ever is. */
  assert.equal(models.some((model) => model.id === 'moonshotai/kimi-k3.1-pro'), false)
  assert.equal(models.some((model) => model.id.endsWith(':batch')), false)

  /* Adding the same id again is a no-op, not a duplicate. */
  const again = await (await postJson(`${origin}/__openrouter-plus/models/add`, {
    route: 'openrouter',
    models: ['openai/gpt-6.1-terra'],
  })).json()
  assert.deepEqual(again.added, [])
  assert.deepEqual(again.already, ['openai/gpt-6.1-terra'])
  assert.equal(editor.rows.find((c) => c.entry?.options?.id === 'llm-pi-ai')
    .entry.options.config.providers.openrouter.models.length, 2)
})


test('an add steps out of the HMR transaction before writing', async (t) => {
  const port = await freePort()
  const upstreamPort = await freePort()
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'a/one', name: 'A One', context_length: 1024 }] }))
  })
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow({ openrouter: { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, models: [] } }),
  ])
  /* A Loader that refuses a nested transaction: `configEditor.edit` serialises through
     HMR, and a listener that inherited the activation async context looks nested. */
  let exits = 0
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  const realGet = ctx.get
  ctx.get = (name) => (name === 'hmr'
    ? { executing: { exit: (op) => { exits += 1; return op() } } }
    : editor !== undefined && name === 'configEditor' ? editor : realGet(name))

  t.after(async () => {
    await new Promise((resolve) => upstream.close(() => resolve(undefined)))
    await dispose()
  })
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const response = await postJson(`${origin}/__openrouter-plus/models/add`, {
    route: 'openrouter',
    models: ['a/one'],
  })
  assert.equal(response.status, 200)
  assert.ok(exits > 0, 'the write left the loader transaction before editing config')
})

// ---- precision floor ------------------------------------------------------

test('a precision floor is config, and the Session table is bounded and typo-proof', () => {
  // Absent means `any`: the profile behaves exactly as it did before the feature.
  const defaults = normalizeConfig(undefined)
  assert.deepEqual(defaults.precisionFloor, { floor: 'any', includeUnknown: false, allow: null })
  assert.deepEqual(defaults.sessionPrecisions, {})

  // A bare string is the whole setting (it is what the patched row ships), and the
  // middle floors admit `unknown` by default.
  const bare = normalizeConfig({ precisionFloor: 'eight-bit-up' })
  assert.deepEqual(bare.precisionFloor, {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  })
  // The boxed form can turn the flag off, and `full-width` starts there anyway.
  assert.deepEqual(normalizeConfig({ precisionFloor: { floor: 'no-four-bit', includeUnknown: false } }).precisionFloor.allow, [
    'int8',
    'fp6',
    'fp8',
    'mxfp8',
    'fp16',
    'bf16',
    'fp32',
  ])
  assert.deepEqual(normalizeConfig({ precisionFloor: 'full-width' }).precisionFloor.allow, ['fp16', 'bf16', 'fp32'])
  // A misspelled floor degrades to `any` rather than refusing to boot the relay.
  assert.equal(normalizeConfig({ precisionFloor: 'turbo' }).precisionFloor.floor, 'any')

  // The per-Session table mirrors the preset table: objects with a stamp, a bare string
  // accepted, an unknown floor dropped (a typo must not silently disable the floor) and
  // `any` kept (opting out of a stricter default is a real choice).
  const table = normalizeConfig({
    sessionPrecisions: {
      chosen: { floor: 'Full-Width', includeUnknown: true, at: 20 },
      bare: 'no-four-bit',
      optedOut: { floor: 'any', at: 10 },
      typo: { floor: 'turbo', at: 30 },
      '': { floor: 'fp16', at: 40 },
    },
  })
  assert.deepEqual(table.sessionPrecisions.chosen, { floor: 'full-width', includeUnknown: true })
  assert.deepEqual(table.sessionPrecisions.bare, { floor: 'no-four-bit', includeUnknown: true })
  assert.deepEqual(table.sessionPrecisions.optedOut, { floor: 'any', includeUnknown: false })
  assert.equal('typo' in table.sessionPrecisions, false)
  assert.equal('' in table.sessionPrecisions, false)
  assert.equal(table.sessionPrecisionStamp.chosen, 20)

  // Bounded: the oldest choices are dropped past 200, so a long-lived Host cannot grow
  // a row for every Session it ever ran.
  const many = {}
  for (let index = 0; index < 205; index += 1) many[`s-${index}`] = { floor: 'eight-bit-up', at: index }
  const bounded = normalizeSessionPrecisions(many)
  assert.equal(Object.keys(bounded.precisions).length, 200)
  assert.equal('s-0' in bounded.precisions, false, 'the oldest choice is the one dropped')
  assert.equal('s-204' in bounded.precisions, true)
  assert.deepEqual(normalizeSessionPrecisions(null), { precisions: {}, stamp: {} })
})

test('the precision control API reports, sets and persists the floor', async (t) => {
  const port = await freePort()
  const editor = createFakeEditor([ownRow({ host: '127.0.0.1', port })])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  t.after(dispose)
  apply(ctx, { port, portFallback: false })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const precisionUrl = `${origin}/__openrouter-plus/precision`

  // 1. The default read. `allow: null` is the wire answer for "sends nothing", and
  //    `inherited` is how the chip tells a choice from an inheritance.
  const fresh = await (await fetch(`${precisionUrl}?session=s1`)).json()
  assert.equal(fresh.ok, true)
  assert.deepEqual(fresh.precision, { floor: 'any', includeUnknown: false, allow: null })
  assert.equal(fresh.inherited, true)
  assert.equal(fresh.source, 'default')
  assert.equal(fresh.chosen, null)
  assert.deepEqual(fresh.floors, ['any', 'no-four-bit', 'eight-bit-up', 'full-width'])

  // /status carries the default and the bypass counter the page shows.
  const status = await (await fetch(`${origin}/__openrouter-plus/status`)).json()
  assert.deepEqual(status.precision.default, { floor: 'any', includeUnknown: false, allow: null })
  assert.deepEqual(status.precision.floorBypassed, { count: 0, byModel: [] })

  // 2. Every write carries the guard header, like every other control POST.
  assert.equal((await fetch(precisionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 's1', precision: { floor: 'eight-bit-up' } }),
  })).status, 403)

  // 3. A Session's floor is memory only: no config write, and it composes with any tier.
  const chosen = await postJson(precisionUrl, { session: 's1', precision: { floor: 'eight-bit-up' } })
  assert.equal(chosen.status, 200)
  const chosenBody = await chosen.json()
  assert.deepEqual(chosenBody.precision, {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  })
  assert.equal(chosenBody.inherited, false)
  assert.equal(chosenBody.source, 'session')
  assert.deepEqual(chosenBody.chosen, { floor: 'eight-bit-up', includeUnknown: true })
  assert.equal(editor.writes.length, 0, 'a floor switch must not write the config')

  const readBack = await (await fetch(`${precisionUrl}?session=s1`)).json()
  assert.equal(readBack.precision.floor, 'eight-bit-up')
  assert.equal(readBack.inherited, false)
  // Another Session is untouched and still inherits.
  assert.equal((await (await fetch(`${precisionUrl}?session=s2`)).json()).inherited, true)
  assert.equal(editor.writes.length, 0)

  // A bare floor id is accepted too, because a curl is not the picker.
  const bare = await postJson(precisionUrl, { session: 's1', precision: 'full-width' })
  assert.equal(bare.status, 200)
  assert.equal((await bare.json()).precision.floor, 'full-width')

  // 4. Refusals are client errors and write nothing: a typo must not become `any`.
  for (const body of [
    { session: 's1', precision: { floor: 'turbo' } },
    { session: 's1', precision: { floor: 'full-width', includeUnknown: 'yes' } },
    { session: 's1', precision: { includeUnknown: true } },
    { precision: { floor: 'full-width' } },
    { session: 'x'.repeat(129), precision: { floor: 'full-width' } },
  ]) {
    assert.equal((await postJson(precisionUrl, body)).status, 400, `${JSON.stringify(body)} is a bad request`)
  }
  assert.equal(editor.writes.length, 0)

  // 5. An absent/null precision clears the choice and hands the Session back.
  const cleared = await (await postJson(precisionUrl, { session: 's1' })).json()
  assert.equal(cleared.inherited, true)
  assert.equal(cleared.source, 'default')
  assert.deepEqual(cleared.precision, { floor: 'any', includeUnknown: false, allow: null })

  // `any` is a real choice, not a clear: it must survive as `chosen`.
  assert.equal((await postJson(precisionUrl, { session: 's1', precision: 'any' })).status, 200)
  const optedOut = await (await fetch(`${precisionUrl}?session=s1`)).json()
  assert.equal(optedOut.inherited, false)
  assert.deepEqual(optedOut.chosen, { floor: 'any', includeUnknown: false })

  // 6. The profile default is a preference, so it is the one precision write that
  //    lands on the plugin's own row — the same path `/tier/default` takes.
  const defaulted = await postJson(`${origin}/__openrouter-plus/precision/default`, {
    precision: { floor: 'no-four-bit' },
  })
  assert.equal(defaulted.status, 200)
  const defaultBody = await defaulted.json()
  assert.equal(defaultBody.default.floor, 'no-four-bit')
  assert.equal(defaultBody.default.allow.includes('unknown'), true)
  assert.equal(editor.writes.length, 1)
  assert.equal(editor.writes[0].entry, editor.rows[0].entry, 'the plugin row is the only row written')
  assert.deepEqual(editor.writes[0].next.precisionFloor, { floor: 'no-four-bit', includeUnknown: true })
  // The next boot reads it back as the normalised shape.
  assert.deepEqual(normalizeConfig(editor.writes[0].next).precisionFloor, defaultBody.default)

  const refused = await postJson(`${origin}/__openrouter-plus/precision/default`, { precision: { floor: 'turbo' } })
  assert.equal(refused.status, 400)
  assert.equal(editor.writes.length, 1, 'a refused default writes nothing')

  // Clearing the default is a legitimate write: `any` is the answer, not null.
  const reset = await postJson(`${origin}/__openrouter-plus/precision/default`, {})
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).default.floor, 'any')
  assert.equal(editor.writes.length, 2)
  assert.deepEqual(editor.writes[1].next.precisionFloor, { floor: 'any', includeUnknown: false })
})

test('the floor is only sent once a model is known to have an endpoint above it', async (t) => {
  const port = await freePort()
  const upstreamPort = await freePort()

  /* A stand-in OpenRouter. The listings carry the real distribution: V3.2 has fp8 and
     fp4 providers, `tiny/fp4-only` has nothing above four bit, and `ghost/model` is a
     name the endpoint API does not know. */
  const fixtures = {
    'deepseek/deepseek-v3.2': endpointListing(['fp8', 'fp8', 'fp8', 'fp8', 'fp4', 'unknown', 'unknown', 'unknown', 'unknown']),
    'tiny/fp4-only': endpointListing(['fp4', 'int4']),
  }
  /** @type {string[]} */
  const endpointHits = []
  /** @type {Array<Record<string, any>>} */
  const bodies = []
  const upstream = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/v1/models/') && url.endsWith('/endpoints')) {
      const model = url.slice('/v1/models/'.length, -'/endpoints'.length)
      endpointHits.push(model)
      const payload = fixtures[model]
      res.writeHead(payload === undefined ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload ?? { error: 'not found' }))
      return
    }
    bodies.push(JSON.parse((await readRequestBody(req)).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  const { ctx, logs, dispose } = createFakeContext()
  t.after(async () => {
    await new Promise((resolve) => {
      upstream.closeAllConnections?.()
      upstream.close(() => resolve(undefined))
    })
    await dispose()
  })

  apply(ctx, {
    port,
    portFallback: false,
    upstream: `http://127.0.0.1:${upstreamPort}/v1`,
    precisionFloor: 'eight-bit-up',
  })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const chat = (model, session = 'sess-1') => fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': session },
    body: JSON.stringify({ model, messages: [] }),
  })
  const status = async () => (await fetch(`${origin}/__openrouter-plus/status`)).json()

  // 1. Cold: the listing has never been read, so the floor is withheld, the request goes
  //    out exactly as written, and the cache warms behind it. The read is never awaited.
  const cold = await chat('deepseek/deepseek-v3.2')
  assert.equal(cold.status, 200)
  assert.equal(cold.headers.get('x-oorp-precision'), 'bypass')
  assert.equal('provider' in bodies[0], false, 'a floor that was not admitted is never sent')
  await waitFor(() => endpointHits.includes('deepseek/deepseek-v3.2'))

  // The bypass is counted per model and exposed on /status, so a floor that is not
  // being honoured shows up instead of quietly doing nothing.
  const coldStatus = await status()
  assert.equal(coldStatus.precision.default.floor, 'eight-bit-up')
  assert.equal(coldStatus.precision.floorBypassed.count, 1)
  assert.deepEqual(coldStatus.precision.floorBypassed.byModel, [{ model: 'deepseek/deepseek-v3.2', count: 1 }])
  // A cold bypass is logged once per model per TTL, so the unfiltered request is
  // visible in the log and not only in a counter nobody reads.
  assert.equal(
    logs.filter((line) => line.includes('precision floor withheld while the endpoint listing is read')).length,
    1,
  )

  // 2. Warm: the same model now carries the include list, and it is the only new field.
  const warm = await chat('deepseek/deepseek-v3.2')
  assert.equal(warm.headers.get('x-oorp-precision'), 'eight-bit-up')
  assert.deepEqual(bodies[1], {
    model: 'deepseek/deepseek-v3.2',
    messages: [],
    provider: { quantizations: coldStatus.precision.default.allow },
  })
  assert.equal((await status()).precision.floorBypassed.count, 1, 'an enforced floor is not a bypass')
  assert.equal(
    endpointHits.filter((model) => model === 'deepseek/deepseek-v3.2').length,
    1,
    'one public read per model per TTL, not one per request',
  )

  // 3. Every endpoint below the floor: the turn still completes, unfiltered and counted.
  assert.equal((await chat('tiny/fp4-only')).headers.get('x-oorp-precision'), 'bypass')
  await waitFor(() => endpointHits.includes('tiny/fp4-only'))
  const below = await chat('tiny/fp4-only')
  assert.equal(below.status, 200)
  assert.equal(below.headers.get('x-oorp-precision'), 'bypass')
  assert.equal('provider' in bodies[3], false, 'sending that list would exclude every provider')
  const belowStatus = await status()
  assert.equal(belowStatus.precision.floorBypassed.count, 3)
  assert.deepEqual(
    belowStatus.precision.floorBypassed.byModel.find((row) => row.model === 'tiny/fp4-only'),
    { model: 'tiny/fp4-only', count: 2 },
  )

  // 4. A model with no listing is remembered as unknown for the TTL, so two requests
  //    are one read — a 404 must not become a fetch per turn.
  assert.equal((await chat('ghost/model')).status, 200)
  await waitFor(() => endpointHits.includes('ghost/model'))
  assert.equal((await chat('ghost/model')).status, 200)
  assert.equal(endpointHits.filter((model) => model === 'ghost/model').length, 1)
  assert.ok(
    logs.some((line) => line.includes('could not read the endpoint listing')),
    'the failure is logged instead of being swallowed',
  )
  assert.equal('provider' in bodies[5], false)
})

test('an `any` floor reads no listings and leaves the request body byte-identical', async (t) => {
  const port = await freePort()
  const upstreamPort = await freePort()

  /** @type {string[]} */
  const endpointHits = []
  /** @type {string[]} */
  const bodies = []
  const upstream = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url.includes('/endpoints')) {
      endpointHits.push(url)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    bodies.push((await readRequestBody(req)).toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

  const { ctx, dispose } = createFakeContext()
  t.after(async () => {
    await new Promise((resolve) => {
      upstream.closeAllConnections?.()
      upstream.close(() => resolve(undefined))
    })
    await dispose()
  })

  // No precisionFloor key at all: the pre-feature profile.
  apply(ctx, { port, portFallback: false, upstream: `http://127.0.0.1:${upstreamPort}/v1` })
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const send = (model) => fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'sess-1' },
    body: JSON.stringify({ model, messages: [] }),
  })

  const response = await send('deepseek/deepseek-v3.2')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-oorp-precision'), 'any')
  assert.equal((await send('openai/gpt-4o')).status, 200)
  // Give any stray background read time to show up, then prove there was none.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(endpointHits, [], '`any` must not cost a single public read')
  assert.deepEqual(bodies, [
    JSON.stringify({ model: 'deepseek/deepseek-v3.2', messages: [] }),
    JSON.stringify({ model: 'openai/gpt-4o', messages: [] }),
  ], 'the body is exactly what the client wrote')

  const status = await (await fetch(`${origin}/__openrouter-plus/status`)).json()
  assert.deepEqual(status.precision.default, { floor: 'any', includeUnknown: false, allow: null })
  assert.deepEqual(status.precision.floorBypassed, { count: 0, byModel: [] })
})
