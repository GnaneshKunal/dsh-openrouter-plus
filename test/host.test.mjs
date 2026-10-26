/**
 * Integration test for the Host entry: it boots the real `apply()` against a
 * minimal stand-in for a cordis context and talks to the resulting listener over
 * HTTP, exactly as the Models card does.
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { test } from 'node:test'

import { apply, normalizeConfig, normalizeRoutes } from '../index.js'

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

test('boots the relay, serves control endpoints, and stops cleanly', async () => {
  const port = await freePort()
  const { ctx, logs, dispose } = createFakeContext()

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
  assert.equal(health.version, '0.9.0')
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

  // The 0.8.0 spelling still maps onto the preset that sends the same thing.
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

  await dispose()

  await waitFor(async () => {
    try {
      await fetch(`${origin}/__openrouter-plus/health`)
      return false
    } catch {
      return true
    }
  })
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
  // The 0.8.0 body shape is still understood, and still writes nothing.
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

  // A 0.8.0 default is read forward rather than rejected.
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
