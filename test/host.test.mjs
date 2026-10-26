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

/** The smallest cordis-shaped context `apply()` needs. */
function createFakeContext() {
  /** @type {Array<() => unknown>} */
  const disposers = []
  /** @type {string[]} */
  const logs = []
  const sink = (level) => (...args) => logs.push(`${level}: ${args.map(String).join(' ')}`)
  return {
    ctx: {
      logger: { info: sink('info'), warn: sink('warn'), error: sink('error') },
      get: () => undefined,
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
  assert.equal(health.version, '0.2.0')
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
