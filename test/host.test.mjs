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
  assert.equal(health.version, '0.7.0')
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
  const preflight = await fetch(`${origin}/__openrouter-plus/routes/create`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(preflight.status, 204)
  const unguarded = await fetch(`${origin}/__openrouter-plus/routes/create`, {
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

  // a guarded create with no configEditor fails loudly instead of silently
  const create = await fetch(`${origin}/__openrouter-plus/routes/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oorp-client': 'web' },
    body: JSON.stringify({ source: 'openrouter', tier: 'flex' }),
  })
  assert.equal(create.status, 500)
  assert.ok((await create.json()).error.message.length > 0)

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
  const attached = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: 'https://api.acme.dev/v1',
    tier: 'flex',
  })
  assert.equal(attached.status, 200)
  const attachResult = await attached.json()
  const mount = `${origin}/t/${registration.target.id}/flex/v1`
  assert.equal(attachResult.baseURL, mount)
  assert.equal(attachResult.changed, true)
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers.acme.baseURL, mount)
  assert.equal(providers.acme.api, 'openai-completions', 'the protocol is untouched')
  assert.deepEqual(providers.acme.models, [{ id: 'acme-large', name: 'Acme Large' }], 'models are untouched')

  // 3. The target table reports which row is on it, derived from the profile.
  const snapshot = await (await fetch(`${origin}/__openrouter-plus/targets`)).json()
  assert.equal(snapshot.custom.length, 1)
  assert.equal(snapshot.custom[0].route, 'acme')
  assert.equal(snapshot.custom[0].tier, 'flex')
  assert.equal(snapshot.custom[0].baseURL, mount)

  // 3b. Switching the tier of an attached row is one write on the same target,
  // and a caller that echoes the mount back as `upstream` is understood: the
  // registry holds the real endpoint, so it wins.
  const retiered = await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: mount,
    tier: 'fast',
  })
  assert.equal(retiered.status, 200)
  const retieredBody = await retiered.json()
  assert.equal(retieredBody.target.id, registration.target.id, 'the same endpoint keeps the same target')
  assert.equal(retieredBody.target.tier, 'fast')
  assert.equal(
    editor.rows[1].entry.options.config.providers.acme.baseURL,
    `${origin}/t/${registration.target.id}/fast/v1`,
    'the row moved to the new tier mount in place',
  )
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

test('the composer tier chip gets an idempotent sibling provider for another tier', async () => {
  const port = await freePort()
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow({
      acme: {
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        apiKeyEnv: 'ACME_API_KEY',
        baseURL: 'https://api.acme.dev/v1',
        models: [{ id: 'acme-large', name: 'Acme Large', reasoningEfforts: { low: 'low', high: 'high' } }],
      },
      plain: {
        displayName: 'Plain',
        api: 'openai-completions',
        baseURL: 'https://api.plain.dev/v1',
        models: [{ id: 'plain-large', name: 'Plain Large' }],
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

  const registration = await (await postJson(`${origin}/__openrouter-plus/targets/register`, {
    upstream: 'https://api.acme.dev/v1',
  })).json()
  const targetId = registration.target.id

  // Route the row onto a flex mount first: only a per-endpoint mount has a family.
  const attached = await (await postJson(`${origin}/__openrouter-plus/routes/attach`, {
    route: 'acme',
    upstream: 'https://api.acme.dev/v1',
    tier: 'flex',
  })).json()
  assert.equal(attached.baseURL, `${origin}/t/${targetId}/flex/v1`)
  const writesAfterAttach = editor.writes.length

  // 1. A twin for another tier is cloned from the routed row, models included.
  const twinned = await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'acme', tier: 'priority' })
  assert.equal(twinned.status, 200)
  const twin = await twinned.json()
  assert.equal(twin.ok, true)
  assert.equal(twin.created, true)
  assert.equal(twin.name, 'acme-priority')
  assert.equal(twin.tier, 'priority')
  assert.equal(twin.source, 'acme')
  assert.equal(twin.baseURL, `${origin}/t/${targetId}/priority/v1`)
  const clone = editor.rows[1].entry.options.config.providers['acme-priority']
  assert.equal(clone.baseURL, `${origin}/t/${targetId}/priority/v1`)
  assert.equal(clone.api, 'openai-completions')
  assert.equal(clone.apiKeyEnv, 'ACME_API_KEY')
  assert.equal(clone.models[0].id, 'acme-large')
  assert.deepEqual(clone.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  assert.equal(editor.writes.length, writesAfterAttach + 1)

  // 2. Asking again reuses that sibling: same key, no second write. The chip
  //    always posts here, so this is the common path once a tier exists.
  const again = await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'acme', tier: 'priority' })
  assert.equal(again.status, 200)
  const reused = await again.json()
  assert.equal(reused.created, false)
  assert.equal(reused.name, 'acme-priority')
  assert.equal(editor.writes.length, writesAfterAttach + 1, 'an existing sibling writes nothing')

  // 3. The pass-through sibling is its own row on the tierless mount.
  const pass = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'acme', tier: '' })).json()
  assert.equal(pass.created, true)
  assert.equal(pass.tier, null)
  assert.equal(pass.baseURL, `${origin}/t/${targetId}/v1`)

  // 4. Refusals are 400s and write nothing: a row outside the relay has no
  //    family, an unknown tier is not a tier, and a typo is not a route.
  const writesBeforeRefusals = editor.writes.length
  for (const [body, pattern] of [
    [{ route: 'plain', tier: 'flex' }, /not routed|target/i],
    [{ route: 'acme', tier: 'turbo' }, /tier/i],
    [{ route: 'nope', tier: 'flex' }, /no provider route named/i],
  ]) {
    const response = await postJson(`${origin}/__openrouter-plus/routes/twin`, body)
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    const payload = await response.json()
    assert.match(payload.error.message, pattern)
  }
  assert.equal(editor.writes.length, writesBeforeRefusals, 'refusals write nothing')

  await dispose()
})

test('a chained tier switch names the sibling after the family root', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const editor = createFakeEditor([ownRow({ host: '127.0.0.1', port }), piAiRow(familyProviders(origin))])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  // root -> priority: the first sibling is named after the root, as it always was.
  const priority = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'root', tier: 'priority' })).json()
  assert.equal(priority.created, true)
  assert.equal(priority.name, 'root-priority')
  assert.equal(priority.baseURL, `${origin}/t/tid1/priority/v1`)

  // priority -> ultrafast: named from the root, not from the sibling it came from.
  const ultrafast = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'root-priority', tier: 'ultrafast' })).json()
  assert.equal(ultrafast.created, true)
  assert.equal(ultrafast.name, 'root-ultrafast', 'the key does not chain with the incoming sibling')
  assert.equal(ultrafast.source, 'root-priority', 'the clone still comes from the incoming sibling')
  assert.equal(ultrafast.baseURL, `${origin}/t/tid1/ultrafast/v1`)

  const providers = editor.rows[1].entry.options.config.providers
  const ultrafastRow = providers['root-ultrafast']
  assert.ok(ultrafastRow, 'the sibling is stored under the root-derived key')
  assert.equal(providers['root-priority-ultrafast'], undefined, 'no chained key is created')
  assert.equal(ultrafastRow.apiKeyEnv, 'OPENROUTER_API_KEY', 'the clone keeps the source credentials')
  assert.deepEqual(ultrafastRow.models.map((model) => model.id), ['deepseek/deepseek-v4-flash-0731'])
  assert.equal(ultrafastRow.displayName, 'openrouter-test (ultrafast) — OpenRouter Plus')
  assert.equal(countOf(ultrafastRow.displayName, DISPLAY_SUFFIX), 1, 'the suffix appears exactly once')
  assert.equal(countOf(ultrafastRow.displayName, '('), 1, 'one tier parenthetical, never a stack')

  // ultrafast -> fast: one more hop still lands on a root-named sibling.
  const fast = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'root-ultrafast', tier: 'fast' })).json()
  assert.equal(fast.created, true)
  assert.equal(fast.name, 'root-fast')
  const afterFast = editor.rows[1].entry.options.config.providers
  assert.equal(afterFast['root-ultrafast-fast'], undefined)
  assert.equal(afterFast['root-fast'].displayName, 'openrouter-test (fast) — OpenRouter Plus')
  assert.equal(countOf(afterFast['root-fast'].displayName, DISPLAY_SUFFIX), 1)

  await dispose()
})

test('an existing sibling at the requested tier is reused even with a chained key', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const chained = {
    displayName: 'openrouter-test (priority) — OpenRouter Plus (ultrafast) — OpenRouter Plus',
    api: 'openai-completions',
    baseURL: `${origin}/t/tid1/ultrafast/v1`,
    models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' }],
  }
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow(familyProviders(origin, { 'root-priority-ultrafast': chained })),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const writesBefore = editor.writes.length
  const reused = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'root', tier: 'ultrafast' })).json()
  assert.equal(reused.created, false)
  assert.equal(reused.name, 'root-priority-ultrafast', 'the row that already holds the tier keeps its key')
  assert.equal(reused.baseURL, `${origin}/t/tid1/ultrafast/v1`)
  assert.equal(reused.source, 'root')
  assert.equal(editor.writes.length, writesBefore, 'reusing a sibling writes nothing')
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers['root-ultrafast'], undefined, 'no second row is added for the same tier')
  assert.equal(providers['root-priority-ultrafast'].displayName, chained.displayName, 'the reused row is untouched')

  await dispose()
})

test('an explicitly requested route name wins unchanged', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow(familyProviders(origin, {
      'root-priority': {
        displayName: 'openrouter-test (priority) — OpenRouter Plus',
        api: 'openai-completions',
        baseURL: `${origin}/t/tid1/priority/v1`,
        models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' }],
      },
    })),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const named = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, {
    route: 'root-priority',
    tier: 'scale',
    name: 'custom-scale',
  })).json()
  assert.equal(named.created, true)
  assert.equal(named.name, 'custom-scale', 'the caller-chosen key is not rewritten')
  assert.equal(named.source, 'root-priority')
  assert.equal(named.baseURL, `${origin}/t/tid1/scale/v1`)
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers['root-scale'], undefined, 'a requested name suppresses the derived one')
  // The display name still comes from the family root, with one tier marker only.
  assert.equal(providers['custom-scale'].displayName, 'openrouter-test (scale) — OpenRouter Plus')
  assert.equal(countOf(providers['custom-scale'].displayName, DISPLAY_SUFFIX), 1)

  await dispose()
})

test('a source key that is not on a target mount still fails with the existing error', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const editor = createFakeEditor([ownRow({ host: '127.0.0.1', port }), piAiRow(familyProviders(origin))])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const writesBefore = editor.writes.length
  const response = await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'plain', tier: 'fast' })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /is not routed through a per-endpoint target yet/)
  assert.equal(editor.writes.length, writesBefore, 'a refused twin writes nothing')

  await dispose()
})

test('a root display that already carries the suffix gets one suffix, not two', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow(familyProviders(origin, {
      suffixed: {
        displayName: 'Suffixed — OpenRouter Plus',
        api: 'openai-completions',
        baseURL: `${origin}/t/tid2/flex/v1`,
        models: [{ id: 'suffixed-large', name: 'Suffixed Large' }],
      },
    })),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  const twinned = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, { route: 'suffixed', tier: 'priority' })).json()
  assert.equal(twinned.created, true)
  assert.equal(twinned.name, 'suffixed-priority')
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers['suffixed-priority'].displayName, 'Suffixed (priority) — OpenRouter Plus')
  assert.equal(countOf(providers['suffixed-priority'].displayName, DISPLAY_SUFFIX), 1)

  await dispose()
})

test('a sibling chained by the old naming still resolves through to the root', async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const editor = createFakeEditor([
    ownRow({ host: '127.0.0.1', port }),
    piAiRow(familyProviders(origin, {
      'root-priority': {
        displayName: 'openrouter-test (priority) — OpenRouter Plus',
        api: 'openai-completions',
        baseURL: `${origin}/t/tid1/priority/v1`,
        models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' }],
      },
      // The exact shape the pre-fix code produced: one tier suffix per switch.
      'root-priority-ultrafast': {
        displayName: 'openrouter-test (priority) — OpenRouter Plus (ultrafast) — OpenRouter Plus',
        api: 'openai-completions',
        baseURL: `${origin}/t/tid1/ultrafast/v1`,
        models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' }],
      },
    })),
  ])
  const { ctx, dispose } = createFakeContext({ configEditor: editor })
  apply(ctx, { port, portFallback: false })
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/__openrouter-plus/health`)).ok
    } catch {
      return false
    }
  })

  // Two suffixes are peeled, not one: a legacy chain must not grow a third.
  const switched = await (await postJson(`${origin}/__openrouter-plus/routes/twin`, {
    route: 'root-priority-ultrafast',
    tier: 'fast',
  })).json()
  assert.equal(switched.created, true)
  assert.equal(switched.name, 'root-fast')
  assert.equal(switched.source, 'root-priority-ultrafast', 'the clone still comes from the incoming sibling')
  const providers = editor.rows[1].entry.options.config.providers
  assert.equal(providers['root-priority-ultrafast-fast'], undefined)
  assert.equal(providers['root-fast'].displayName, 'openrouter-test (fast) — OpenRouter Plus')
  assert.equal(countOf(providers['root-fast'].displayName, DISPLAY_SUFFIX), 1)

  await dispose()
})
