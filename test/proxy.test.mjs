import { strict as assert } from 'node:assert'
import http from 'node:http'
import { after, test } from 'node:test'

import { createMetrics } from '../lib/metrics.js'
import { applyRecipe, baseModelId, createRelay, findGenerationId, findUsage, normalizeRecipe, sessionKeyOf } from '../lib/proxy.js'

/** The "provider reported nothing" shape, so token-only fixtures stay readable. */
const emptyUsage = () => ({
  promptTokens: null,
  completionTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costUsd: null,
  upstreamCostUsd: null,
  upstreamPromptCostUsd: null,
  upstreamCompletionCostUsd: null,
  serverToolCostUsd: null,
  byok: false,
  servedTier: null,
  servedModel: null,
  providerName: null,
  genId: null,
})

/** @type {Array<() => Promise<void>>} */
const cleanups = []
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

/**
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: http.Server, origin: string, port: number, close: () => Promise<void> }>}
 */
async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  const close = async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve(undefined))
    })
  }
  cleanups.push(close)
  return { server, origin: `http://127.0.0.1:${address.port}`, port: address.port, close }
}

/**
 * @param {string} upstream
 * @param {Record<string, string|null>} [routes]
 * @param {Record<string, unknown>} [extra]
 */
async function startRelay(upstream, routes, extra = {}) {
  const metrics = createMetrics({ recentLimit: 5 })
  const relay = createRelay({
    host: '127.0.0.1',
    port: 0,
    portFallback: false,
    upstream,
    routes: routes ?? { '/flex/v1': 'flex', '/v1': null },
    onRecord: (entry) => metrics.record(entry),
    ...extra,
  })
  const address = await relay.start()
  cleanups.push(() => relay.stop())
  return { relay, address, metrics }
}

/** @param {import('node:http').IncomingMessage} req */
async function readRequestBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('injects service_tier into the JSON body and fixes content-length', async () => {
  /** @type {{ body: string, headers: http.IncomingHttpHeaders } | undefined} */
  let received
  const upstream = await startServer(async (req, res) => {
    const raw = await readRequestBody(req)
    received = { body: raw.toString('utf8'), headers: req.headers }
    const payload = JSON.stringify({ ok: true })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  })

  const { address } = await startRelay(upstream.origin)
  const body = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] })
  const response = await fetch(`${address.origin}/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body,
  })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), '{"ok":true}')
  assert.ok(received, 'upstream received nothing')
  const parsed = JSON.parse(received.body)
  assert.equal(parsed.service_tier, 'flex')
  assert.equal(parsed.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(Number(received.headers['content-length']), Buffer.byteLength(received.body))
  assert.equal(received.headers.authorization, 'Bearer sk-test', 'authorization must pass through verbatim')
  assert.equal(received.headers['accept-encoding'], 'identity')
  assert.equal(response.headers.get('x-oorp-tier'), 'flex')
})

test('passthrough mount sends no service_tier key at all', async () => {
  /** @type {string | undefined} */
  let receivedBody
  const upstream = await startServer(async (req, res) => {
    receivedBody = (await readRequestBody(req)).toString('utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  const { address } = await startRelay(upstream.origin)
  await fetch(`${address.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),
  })

  assert.ok(receivedBody)
  const parsed = JSON.parse(receivedBody)
  assert.equal('service_tier' in parsed, false, 'a null tier must not write the key')
})

test('streams an SSE body through without buffering', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ]
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let index = 0
    const tick = () => {
      if (index === frames.length) {
        response.end()
        return
      }
      response.write(frames[index])
      index += 1
      setTimeout(tick, 15)
    }
    tick()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port
  cleanups.push(() => new Promise((resolve) => {
    upstream.closeAllConnections?.()
    upstream.close(() => resolve(undefined))
  }))

  const records = []
  const { address } = await startRelay(`http://127.0.0.1:${upstreamPort}`, { '/flex/v1': 'flex' }, {
    onRecord: (entry) => records.push(entry),
  })

  const response = await fetch(`${address.origin}/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'streamed', stream: true }),
  })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')

  /** @type {Uint8Array[]} */
  const seen = []
  for await (const chunk of /** @type {any} */ (response.body)) seen.push(chunk)
  assert.equal(Buffer.concat(seen).toString('utf8'), frames.join(''), 'every byte must survive in order')

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(records.length, 1)
  assert.equal(records[0].streaming, true)
  assert.equal(records[0].model, 'streamed')
  assert.equal(records[0].promptTokens, 11)
  assert.equal(records[0].completionTokens, 7)
})

test('resolveRoute matches on segment boundaries and prefers the longest mount', () => {
  const relay = createRelay({
    upstream: 'http://127.0.0.1:1',
    routes: { '/flex/v1': 'flex', '/v1': null, '/flex/v1/priority': 'ultrafast' },
  })

  assert.deepEqual(relay.resolveRoute('/flex/v1/chat/completions'), {
    prefix: '/flex/v1',
    tier: 'flex',
    upstreamPath: '/chat/completions',
  })
  assert.deepEqual(relay.resolveRoute('/v1/models'), { prefix: '/v1', tier: null, upstreamPath: '/models' })
  assert.deepEqual(relay.resolveRoute('/flex/v1/priority/chat'), {
    prefix: '/flex/v1/priority',
    tier: 'ultrafast',
    upstreamPath: '/chat',
  })
  assert.equal(relay.resolveRoute('/flexible/v1/chat'), null, 'a near-miss must not match')
  assert.equal(relay.resolveRoute('/flex/v1extra'), null)
  assert.equal(relay.resolveRoute('/totally/else'), null)
})

test('metrics aggregate tiers with multipliers and cap the recent ring', () => {
  const metrics = createMetrics({ recentLimit: 3 })
  const record = (tier, prompt, completion) =>
    metrics.record({ tier, status: 200, ms: 10, bytes: 5, streaming: false, promptTokens: prompt, completionTokens: completion })

  record('flex', 100, 100)
  record('flex', 50, 50)
  record('priority', 200, 0)
  record(null, 10, 0)

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.requests, 4)
  assert.equal(snapshot.errors, 0)
  assert.equal(snapshot.promptTokens, 360)
  assert.equal(snapshot.completionTokens, 150)
  assert.equal(snapshot.byTier.flex.requests, 2)
  assert.equal(snapshot.byTier.flex.multiplier, 0.5)
  assert.equal(snapshot.byTier.flex.effectiveTokens, 150)
  assert.equal(snapshot.byTier.priority.multiplier, 2)
  assert.equal(snapshot.byTier.priority.effectiveTokens, 400)
  assert.equal(snapshot.byTier.unset.multiplier, 1)
  assert.equal(snapshot.recent.length, 3, 'ring buffer must be capped')
  assert.equal(snapshot.recent[0].tier, null, 'newest first')
  // (150 + 400 + 10) / 510 tokens
  assert.equal(snapshot.effectiveMultiplier, 1.098)
})

test('answers 502 when the upstream is unreachable', async () => {
  const probe = await startServer((_req, res) => res.end('never'))
  const deadPort = probe.port
  await probe.close()

  const { address } = await startRelay(`http://127.0.0.1:${deadPort}`)
  const response = await fetch(`${address.origin}/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"x"}',
  })

  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.match(payload.error.message, /upstream unreachable/)
})

test('serves a control endpoint and 404s an unmounted path', async () => {
  const { origin } = await startServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url }))
  })

  const relay = createRelay({
    upstream: origin,
    routes: { '/v1': null },
    control: {
      '/__oorp/health': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    },
  })
  const address = await relay.start()
  cleanups.push(() => relay.stop())

  const health = await fetch(`${address.origin}/__oorp/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })

  const missing = await fetch(`${address.origin}/nope/v1/chat`)
  assert.equal(missing.status, 404)
})

test('findUsage reads SSE transcripts and plain JSON bodies', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
    'data: [DONE]',
  ].join('\n')
  assert.deepEqual(findUsage(sse), {
    promptTokens: 9,
    completionTokens: 4,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    upstreamCostUsd: null,
    upstreamPromptCostUsd: null,
    upstreamCompletionCostUsd: null,
    serverToolCostUsd: null,
    byok: false,
    servedTier: null,
    servedModel: null,
    providerName: null,
    genId: null,
  })
  assert.deepEqual(
    findUsage('{"id":"x","usage":{"prompt_tokens":3,"completion_tokens":2},"model":"m"}'),
    {
      promptTokens: 3,
      completionTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
      upstreamCostUsd: null,
      upstreamPromptCostUsd: null,
      upstreamCompletionCostUsd: null,
      serverToolCostUsd: null,
      byok: false,
      servedTier: null,
      servedModel: 'm',
      providerName: null,
      genId: null,
    },
  )
  assert.deepEqual(findUsage('no usage here'), emptyUsage())
  assert.deepEqual(findUsage(''), emptyUsage())
})

test('findUsage reports the billed amount, the served tier and the identity', () => {
  // The shape OpenRouter appends to a streamed completion: the amount charged is in
  // `usage.cost`, and the tier that actually served it sits at the top level.
  const final = {
    id: 'gen-abc-123',
    object: 'chat.completion.chunk',
    model: 'saostar/gpt-test-2026',
    provider: 'DigitalOcean',
    service_tier: 'priority',
    choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 194,
      completion_tokens: 2,
      total_tokens: 196,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      cost: 0.00042,
      is_byok: false,
      cost_details: {
        upstream_inference_cost: 0.0003,
        upstream_inference_prompt_cost: 0.0002,
        upstream_inference_completions_cost: 0.0001,
        server_tool_cost: null,
      },
    },
  }
  const text = ['data: {"choices":[{"delta":{"content":"a"}}]}', `data: ${JSON.stringify(final)}`, 'data: [DONE]'].join('\n')
  assert.deepEqual(findUsage(text), {
    promptTokens: 194,
    completionTokens: 2,
    cacheReadTokens: 100,
    cacheWriteTokens: 7,
    reasoningTokens: 3,
    costUsd: 0.00042,
    upstreamCostUsd: 0.0003,
    upstreamPromptCostUsd: 0.0002,
    upstreamCompletionCostUsd: 0.0001,
    serverToolCostUsd: null,
    byok: false,
    servedTier: 'priority',
    servedModel: 'saostar/gpt-test-2026',
    providerName: 'DigitalOcean',
    genId: 'gen-abc-123',
  })
  // A free endpoint reports 0, which is an amount, not a missing one.
  assert.equal(findUsage('{"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}').costUsd, 0)
  // An aborted stream has no usage block left, but the identity is still worth keeping.
  assert.deepEqual(findUsage('data: {"id":"gen-aborted-1","model":"m","choices":[{"delta":{"content":"x"}}]}'), {
    ...emptyUsage(),
    servedModel: 'm',
    genId: 'gen-aborted-1',
  })
})

test('findGenerationId reads the id from the first chunk', () => {
  assert.equal(findGenerationId('data: {"id":"gen-1a2B3c","model":"m"}'), 'gen-1a2B3c')
  assert.equal(findGenerationId('data: {"id":"not-a-generation"}'), null)
  assert.equal(findGenerationId(''), null)
})

// ---- per-target mounts: /t/<targetId>[/<tier>]/v1 ------------------------

test('a target mount forwards to that target upstream and pins its tier', async () => {
  /** @type {{ body: string, url: string, headers: http.IncomingHttpHeaders } | undefined} */
  let received
  const gateway = await startServer(async (req, res) => {
    received = { body: (await readRequestBody(req)).toString('utf8'), url: req.url ?? '', headers: req.headers }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })

  /** @type {object[]} */
  const records = []
  const { address } = await startRelay(gateway.origin, { '/flex/v1': 'flex' }, {
    resolveTarget: (id) => (id === 'acme' ? { upstream: `${gateway.origin}/api/v1`, tier: 'flex' } : null),
    onRecord: (entry) => records.push(entry),
  })

  const response = await fetch(`${address.origin}/t/acme/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-acme' },
    body: JSON.stringify({ model: 'acme/large', messages: [] }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-oorp-tier'), 'flex')
  assert.equal(response.headers.get('x-oorp-target'), 'acme')
  assert.equal(response.headers.get('x-oorp-upstream'), gateway.origin, 'the header must not leak the upstream path')
  assert.ok(received, 'the target upstream received nothing')
  assert.equal(received.url, '/api/v1/chat/completions', 'the mount is stripped, the upstream path is kept')
  assert.equal(received.headers.authorization, 'Bearer sk-acme', 'authorization passes through verbatim')
  const parsed = JSON.parse(received.body)
  assert.equal(parsed.service_tier, 'flex')
  assert.equal(parsed.model, 'acme/large')
  assert.equal(Number(received.headers['content-length']), Buffer.byteLength(received.body))

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(records.length, 1)
  assert.equal(records[0].tier, 'flex')
  assert.equal(records[0].model, 'acme/large')
  assert.equal(records[0].status, 200)
})

test('the no-tier target mount writes no service_tier key at all', async () => {
  /** @type {string | undefined} */
  let receivedBody
  /** @type {string | undefined} */
  let receivedUrl
  const gateway = await startServer(async (req, res) => {
    receivedBody = (await readRequestBody(req)).toString('utf8')
    receivedUrl = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  // A leftover `tier` in the target table must not write anything behind the plain
  // mount: the path decides, and a bare path names no tier.
  const { address, metrics } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: () => ({ upstream: `${gateway.origin}/api/v1`, tier: 'flex' }),
  })

  const response = await fetch(`${address.origin}/t/acme/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'acme/large' }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-oorp-tier'), 'passthrough')
  assert.equal(receivedUrl, '/api/v1/chat/completions')
  const parsed = JSON.parse(String(receivedBody))
  assert.equal('service_tier' in parsed, false)
  assert.equal(parsed.model, 'acme/large', 'the body still arrives, just unmodified')

  await new Promise((resolve) => setTimeout(resolve, 60))
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.byTier.unset.requests, 1, 'an unpinned target is accounted as unset')
  assert.equal(snapshot.byTier.unset.multiplier, 1)
})

test('a target upstream keeps its own path and the join never doubles a slash', async () => {
  /** @type {string[]} */
  const seen = []
  const gateway = await startServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  const { address } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: (id) => {
      if (id === 'nested') return { upstream: `${gateway.origin}/gateway/api/v1/`, tier: 'scale' }
      if (id === 'bare') return { upstream: gateway.origin, tier: null }
      return null
    },
  })

  const query = await fetch(`${address.origin}/t/nested/scale/v1/models?limit=3`)
  assert.equal(query.status, 200)
  const exact = await fetch(`${address.origin}/t/nested/scale/v1`)
  assert.equal(exact.status, 200)
  const noPath = await fetch(`${address.origin}/t/bare/v1/embeddings`)
  assert.equal(noPath.status, 200)

  assert.deepEqual(seen, ['/gateway/api/v1/models?limit=3', '/gateway/api/v1', '/embeddings'])
})

test('an unknown or malformed target is a clear JSON error, never proxied', async () => {
  let hits = 0
  const gateway = await startServer((_req, res) => {
    hits += 1
    res.end('{}')
  })

  const { address } = await startRelay(gateway.origin, { '/v1': null }, { resolveTarget: () => null })

  const unknown = await fetch(`${address.origin}/t/ghost/v1/chat/completions`)
  assert.equal(unknown.status, 404)
  assert.match((await unknown.json()).error.message, /unknown relay target "ghost"/)

  const malformed = await fetch(`${address.origin}/t/acme/notv1/chat`)
  assert.equal(malformed.status, 404)
  assert.match((await malformed.json()).error.message, /not a relay target mount/)

  const badId = await fetch(`${address.origin}/t/Nope!/v1/chat`)
  assert.equal(badId.status, 404)

  // A relay built without a resolver simply has no targets to serve.
  const { address: plain } = await startRelay(gateway.origin, { '/v1': null })
  const disabled = await fetch(`${plain.origin}/t/acme/v1/chat`)
  assert.equal(disabled.status, 404)

  assert.equal(hits, 0, 'a rejected target must never reach an upstream')
})

test('a target pointed back at the relay is refused instead of looping', async () => {
  /** @type {{ origin: string, port: number }} */
  const self = { origin: '', port: 0 }
  const { address } = await startRelay('http://127.0.0.1:9', { '/v1': null }, {
    resolveTarget: (id) => {
      if (id === 'numeric') return { upstream: `${self.origin}/v1`, tier: 'flex' }
      if (id === 'named') return { upstream: `http://localhost:${self.port}/v1`, tier: 'flex' }
      return null
    },
  })
  self.origin = address.origin
  self.port = address.port

  const numeric = await fetch(`${address.origin}/t/numeric/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"x"}',
  })
  assert.equal(numeric.status, 400)
  assert.match((await numeric.json()).error.message, /points back at this relay/)

  const named = await fetch(`${address.origin}/t/named/flex/v1/models`)
  assert.equal(named.status, 400, 'the loopback name is the same listener')

  const unpinned = await fetch(`${address.origin}/t/numeric/v1/models`)
  assert.equal(unpinned.status, 400, 'a plain target mount loops just the same')
  assert.match((await unpinned.json()).error.message, /refusing to proxy it to itself/)
})

test('the legacy tier mount is unchanged and never consults the resolver', async () => {
  /** @type {Array<{ url: string, body: string }>} */
  const seen = []
  const gateway = await startServer(async (req, res) => {
    seen.push({ url: req.url ?? '', body: (await readRequestBody(req)).toString('utf8') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  let targetCalls = 0
  const { address, metrics } = await startRelay(gateway.origin, { '/flex/v1': 'flex', '/v1': null }, {
    resolveTarget: () => {
      targetCalls += 1
      return { upstream: `${gateway.origin}/elsewhere`, tier: 'priority' }
    },
  })

  const tiered = await fetch(`${address.origin}/flex/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'legacy/tiered' }),
  })
  const plain = await fetch(`${address.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'legacy/plain' }),
  })

  assert.equal(tiered.status, 200)
  assert.equal(plain.status, 200)
  assert.equal(tiered.headers.get('x-oorp-tier'), 'flex')
  assert.equal(plain.headers.get('x-oorp-tier'), 'passthrough')
  assert.equal(tiered.headers.get('x-oorp-target'), null, 'only a target mount names a target')
  assert.deepEqual(seen.map((entry) => entry.url), ['/chat/completions', '/chat/completions'])
  assert.equal(JSON.parse(seen[0].body).service_tier, 'flex')
  assert.equal('service_tier' in JSON.parse(seen[1].body), false)
  assert.equal(targetCalls, 0, 'the mounted upstream must stay the configured one')

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(metrics.snapshot().byTier.flex.requests, 1)
  assert.equal(metrics.snapshot().byTier.unset.requests, 1)
})

test('the mount segment decides the tier, and the target table never does', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const bodies = []
  const gateway = await startServer(async (req, res) => {
    bodies.push(JSON.parse((await readRequestBody(req)).toString('utf8')))
    res.end('{}')
  })

  const { address } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: (id) => {
      if (id === 'pinned') return { upstream: gateway.origin, tier: 'flex' }
      if (id === 'open') return { upstream: gateway.origin, tier: null }
      return null
    },
  })

  const send = (path) => fetch(`${address.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  })

  // A legacy row still on a pinned path keeps the tier that path names, even when the
  // target table disagrees: the URL is what the row actually points at.
  assert.equal((await send('/t/pinned/priority/v1/chat')).status, 200)
  assert.equal((await send('/t/open/priority/v1/chat')).status, 200)
  // The bare mount writes nothing, whatever the target table still carries.
  assert.equal((await send('/t/pinned/v1/chat')).status, 200)

  assert.equal(bodies[0].service_tier, 'priority', 'the mount segment wins over the target table')
  assert.equal(bodies[1].service_tier, 'priority', 'and it is the only thing a bare target has')
  assert.equal('service_tier' in bodies[2], false, 'a bare mount writes no tier at all')
})

test('an unusable target upstream is a clear 400, and an async resolver works', async () => {
  /** @type {string[]} */
  const seen = []
  const gateway = await startServer(async (req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  const { address } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: async (id) => {
      if (id === 'async') return { upstream: `${gateway.origin}/api/v1`, tier: 'scale' }
      if (id === 'badurl') return { upstream: 'not-a-url' }
      if (id === 'ftp') return { upstream: 'ftp://example.test/v1' }
      if (id === 'credentialed') return { upstream: 'http://user:pass@127.0.0.1:1/v1' }
      return {}
    },
  })

  const ok = await fetch(`${address.origin}/t/async/scale/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  })
  assert.equal(ok.status, 200, 'a resolver may answer with a promise')
  assert.equal(ok.headers.get('x-oorp-tier'), 'scale')
  assert.deepEqual(seen, ['/api/v1/chat/completions'])

  for (const id of ['badurl', 'ftp', 'credentialed', 'empty']) {
    const response = await fetch(`${address.origin}/t/${id}/v1/chat`)
    assert.equal(response.status, 400, `${id} must be refused`)
    assert.match((await response.json()).error.message, /no usable upstream/)
  }
})

test('streams a target mount through byte for byte', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]
  const gateway = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(frames[0])
    setTimeout(() => {
      res.write(frames[1] + frames[2])
      res.end()
    }, 10)
  })

  /** @type {object[]} */
  const records = []
  const { address } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: () => ({ upstream: `${gateway.origin}/api/v1`, tier: null }),
    onRecord: (entry) => records.push(entry),
  })

  const response = await fetch(`${address.origin}/t/acme/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'streamed-target', stream: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')

  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of /** @type {any} */ (response.body)) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString('utf8'), frames.join(''), 'every byte must survive in order')

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(records.length, 1)
  assert.equal(records[0].streaming, true)
  assert.equal(records[0].tier, null)
  assert.equal(records[0].model, 'streamed-target')
  assert.equal(records[0].promptTokens, 5)
  assert.equal(records[0].completionTokens, 2)
})

test('sessionKeyOf() reads a Session header first, then prompt_cache_key', () => {
  assert.equal(sessionKeyOf({ 'x-session-id': 'abc' }, {}), 'abc')
  assert.equal(sessionKeyOf({ 'x-session-affinity': 'aff' }, {}), 'aff', 'affinity is the next signal')
  assert.equal(sessionKeyOf({}, { prompt_cache_key: 'pck-1' }), 'pck-1', 'pi-ai sends the session as a prompt cache key')
  assert.equal(sessionKeyOf({ 'x-session-id': '  ' }, { prompt_cache_key: 'pck-2' }), 'pck-2', 'a blank header falls through')
  assert.equal(sessionKeyOf({ 'x-session-id': 'head' }, { prompt_cache_key: 'pck-3' }), 'head', 'a header wins over the body')
  assert.equal(sessionKeyOf({}, {}), '', 'no identity is an empty key, never an invented one')
  assert.equal(sessionKeyOf(undefined, null), '')
  assert.equal(sessionKeyOf({ 'x-session-id': 'x'.repeat(400) }, {}).length, 128, 'the key is clamped')
})

test('a bare target mount asks the resolver per Session and applies that recipe', async () => {
  /** @type {Array<{ body: Record<string, unknown>, url: string }>} */
  const seen = []
  const gateway = await startServer(async (req, res) => {
    seen.push({ body: JSON.parse((await readRequestBody(req)).toString('utf8')), url: req.url ?? '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  /** @type {string[]} */
  const asked = []
  const { address } = await startRelay(gateway.origin, { '/v1': null }, {
    resolveTarget: () => ({ upstream: gateway.origin }),
    resolveSessionRecipe: (session) => {
      asked.push(session)
      if (session === 'flex') return { preset: 'flex', serviceTier: 'flex', sort: null, variant: null }
      if (session === 'fast') return { preset: 'fastest', serviceTier: null, sort: 'throughput', variant: null }
      if (session === 'floor') return { preset: 'floor', serviceTier: null, sort: null, variant: 'floor' }
      if (session === 'legacy') return 'priority'
      // The pass-through preset answers too: it is an answer, not a missing one.
      return { preset: 'none', serviceTier: null, sort: null, variant: null }
    },
  })

  const send = (headers, body = { model: 'm' }) => fetch(`${address.origin}/t/one/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  assert.equal((await send({ 'x-session-id': 'flex' })).status, 200)
  assert.equal((await send({}, { model: 'm', prompt_cache_key: 'fast' })).status, 200)
  assert.equal((await send({ 'x-session-id': 'floor' })).status, 200)
  assert.equal((await send({ 'x-session-id': 'legacy' })).status, 200)
  // A client that pinned its own tier is not trusted to outlive the picker.
  assert.equal((await send({ 'x-session-id': 'none' }, { model: 'm', service_tier: 'priority' })).status, 200)

  assert.deepEqual(asked, ['flex', 'fast', 'floor', 'legacy', 'none'], 'one lookup per request, keyed by the Session')
  assert.equal(seen[0].body.service_tier, 'flex')
  assert.equal(seen[1].body.service_tier, undefined, 'a sort preset writes no tier')
  assert.deepEqual(seen[1].body.provider, { sort: 'throughput' }, 'the comparator rides provider.sort')
  assert.equal(seen[2].body.model, 'm:floor', 'the floor preset is a model variant, not a parameter')
  assert.equal(seen[3].body.service_tier, 'priority', 'a bare tier string still works')
  assert.equal('service_tier' in seen[4].body, false, 'pass-through strips a tier the client pinned')
  assert.equal(seen[0].body.model, 'm', 'every other body field survives the rewrite')
})

test('normalizeRecipe() accepts a bare tier and keeps the levers apart', () => {
  assert.deepEqual(normalizeRecipe('flex'), {
    preset: 'flex',
    serviceTier: 'flex',
    sort: null,
    variant: null,
    precision: null,
    quantizations: null,
  })
  assert.equal(normalizeRecipe(''), null)
  assert.equal(normalizeRecipe(null), null)
  assert.deepEqual(normalizeRecipe({ preset: 'none' }), {
    preset: 'none',
    serviceTier: null,
    sort: null,
    variant: null,
    precision: null,
    quantizations: null,
  })
  assert.deepEqual(normalizeRecipe({ serviceTier: 'PRIORITY' }), {
    preset: null,
    serviceTier: 'priority',
    sort: null,
    variant: null,
    precision: null,
    quantizations: null,
  })
  assert.deepEqual(normalizeRecipe({ sort: 'throughput', variant: 'floor', preset: 'x' }), {
    preset: 'x',
    serviceTier: null,
    sort: 'throughput',
    variant: 'floor',
    precision: null,
    quantizations: null,
  })
  assert.equal(normalizeRecipe({}), null, 'an empty recipe names nothing, so it is no recipe')
})

test('normalizeRecipe() carries the precision floor and its admitted include list', () => {
  // The floor id and the wire list travel together but are not the same fact: the id is
  // what the response header reports, the list is what may be written into the body.
  assert.deepEqual(normalizeRecipe({ precision: 'Eight-Bit-Up', quantizations: ['FP8', 'fp8', 'fp16', ''] }), {
    preset: null,
    serviceTier: null,
    sort: null,
    variant: null,
    precision: 'eight-bit-up',
    quantizations: ['fp8', 'fp16'],
  })
  // A floor with no admitted list is still a recipe: that is the bypass state.
  assert.deepEqual(normalizeRecipe({ precision: 'full-width' }), {
    preset: null,
    serviceTier: null,
    sort: null,
    variant: null,
    precision: 'full-width',
    quantizations: null,
  })
  // Garbage in the list is "no list", never an empty one: an empty include list would
  // mean "no endpoint is eligible", which is a request this relay must never send.
  assert.equal(normalizeRecipe({ quantizations: [] }), null)
  assert.equal(normalizeRecipe({ quantizations: ['  '] }), null)
  assert.equal(normalizeRecipe({ quantizations: 'fp8' }), null, 'a bare string is not an include list')
  assert.deepEqual(normalizeRecipe({ quantizations: ['int8'] })?.quantizations, ['int8'])
})

test('applyRecipe() merges the quantization include list and never clobbers the caller`s provider block', () => {
  const body = {
    model: 'vendor/model',
    provider: { only: ['deepinfra'], order: ['a', 'b'], allow_fallbacks: false },
  }
  const withFloor = normalizeRecipe({ precision: 'eight-bit-up', quantizations: ['fp8', 'fp16'] })

  assert.equal(applyRecipe(body, withFloor), true)
  assert.deepEqual(body.provider, {
    only: ['deepinfra'],
    order: ['a', 'b'],
    allow_fallbacks: false,
    quantizations: ['fp8', 'fp16'],
  }, 'only/order/allow_fallbacks survive; the include list is merged in')
  assert.equal(applyRecipe(body, withFloor), false, 'idempotent')
  assert.equal(applyRecipe(body, normalizeRecipe({ quantizations: ['FP8', 'FP16'] })), false, 'case does not churn the body')

  // The floor list is replaced as a whole when the Session's floor changes.
  assert.equal(applyRecipe(body, normalizeRecipe({ quantizations: ['bf16'] })), true)
  assert.deepEqual(body.provider.quantizations, ['bf16'])
  assert.equal(body.provider.only.length, 1, 'the rest of the block is still the caller`s')

  // A floor that was withheld (`null`) strips a list the caller pinned, mirroring the
  // way `service_tier: null` strips a tier — the relay owns this field while it runs.
  assert.equal(applyRecipe(body, normalizeRecipe({ preset: 'none' })), true)
  assert.equal('quantizations' in body.provider, false)
  assert.deepEqual(body.provider, { only: ['deepinfra'], order: ['a', 'b'], allow_fallbacks: false })
  assert.equal(applyRecipe(body, normalizeRecipe({ preset: 'none' })), false, 'nothing left to strip')

  // ...but it never creates a provider object just to delete from it.
  const bare = { model: 'vendor/model' }
  assert.equal(applyRecipe(bare, normalizeRecipe({ preset: 'none' })), false)
  assert.equal('provider' in bare, false)
  // A provider block with any other field is left alone by a null list.
  const pinned = { provider: { data_collection: 'deny' } }
  assert.equal(applyRecipe(pinned, normalizeRecipe({ preset: 'none' })), false)
  assert.deepEqual(pinned.provider, { data_collection: 'deny' })

  // Creating the provider block is the floor's job when there is none yet.
  const fresh = { model: 'vendor/model' }
  assert.equal(applyRecipe(fresh, withFloor), true)
  assert.deepEqual(fresh.provider, { quantizations: ['fp8', 'fp16'] })
})

test('applyRecipe() merges provider fields and never clobbers the caller`s own', () => {
  const body = {
    model: 'vendor/model',
    provider: { only: ['deepinfra'], order: ['a', 'b'], allow_fallbacks: false },
  }
  assert.equal(applyRecipe(body, normalizeRecipe({ preset: 'cheapest' })), false, 'a preset-only recipe names no lever')
  assert.deepEqual(body.provider, { only: ['deepinfra'], order: ['a', 'b'], allow_fallbacks: false }, 'nothing to do')

  assert.equal(applyRecipe(body, normalizeRecipe({ sort: 'price' })), true)
  assert.deepEqual(body.provider, { only: ['deepinfra'], order: ['a', 'b'], allow_fallbacks: false, sort: 'price' })
  assert.equal('service_tier' in body, false)

  assert.equal(applyRecipe(body, normalizeRecipe({ serviceTier: 'default' })), true)
  assert.equal(body.service_tier, 'default')
  assert.equal(applyRecipe(body, normalizeRecipe({ serviceTier: 'default' })), false, 'idempotent')

  assert.equal(applyRecipe(body, normalizeRecipe({ variant: 'floor' })), true)
  assert.equal(body.model, 'vendor/model:floor')
  assert.equal(applyRecipe(body, normalizeRecipe({ variant: 'floor' })), false, 'idempotent')

  // Dropping the variant and the tier is how the pass-through preset gets honest again.
  assert.equal(applyRecipe(body, normalizeRecipe({ preset: 'none' })), true)
  assert.equal(body.model, 'vendor/model')
  assert.equal('service_tier' in body, false)
})

test('baseModelId() only strips the two relay-owned variants', () => {
  assert.equal(baseModelId('vendor/model:floor'), 'vendor/model')
  assert.equal(baseModelId('vendor/model:nitro'), 'vendor/model')
  assert.equal(baseModelId('vendor/model:online'), 'vendor/model:online', 'a caller suffix survives')
  assert.equal(baseModelId('vendor/model:free'), 'vendor/model:free')
  assert.equal(baseModelId('vendor/model'), 'vendor/model')
})

test('x-oorp-precision reports the floor that was actually enforced', async () => {
  /** @type {Array<Record<string, any>>} */
  const bodies = []
  const gateway = await startServer(async (req, res) => {
    bodies.push(JSON.parse((await readRequestBody(req)).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  /** @type {string[]} */
  const asked = []
  const { address } = await startRelay(gateway.origin, { '/flex/v1': 'flex', '/v1': null }, {
    resolveSessionRecipe: (session, model) => {
      asked.push(`${session}:${model ?? 'null'}`)
      // A floor that was admitted: the floor id goes on the header because a filter
      // really was sent.
      if (session === 'enforced') {
        return { preset: 'none', serviceTier: null, sort: null, variant: null, precision: 'eight-bit-up', quantizations: ['fp8', 'fp16'] }
      }
      // A floor that was configured but withheld: the header must say so, because the
      // body carries nothing and `any` would hide the case worth troubleshooting.
      if (session === 'bypassed') {
        return { preset: 'none', serviceTier: null, sort: null, variant: null, precision: 'full-width', quantizations: null }
      }
      if (session === 'any') {
        return { preset: 'none', serviceTier: null, sort: null, variant: null, precision: 'any', quantizations: null }
      }
      // Tier-era caller: a bare string names no floor.
      return 'flex'
    },
  })

  const send = (path, session, body = { model: 'deepseek/deepseek-v3.2' }) => fetch(`${address.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': session },
    body: JSON.stringify(body),
  })

  const enforced = await send('/v1/chat/completions', 'enforced')
  assert.equal(enforced.status, 200)
  assert.equal(enforced.headers.get('x-oorp-precision'), 'eight-bit-up', 'the floor id when a filter went out')
  assert.deepEqual(bodies[0].provider, { quantizations: ['fp8', 'fp16'] })

  const bypassed = await send('/v1/chat/completions', 'bypassed')
  assert.equal(bypassed.headers.get('x-oorp-precision'), 'bypass', 'a configured floor that was not sent')
  assert.equal('provider' in bodies[1], false, 'a withheld floor sends nothing at all')

  const any = await send('/v1/chat/completions', 'any')
  assert.equal(any.headers.get('x-oorp-precision'), 'any')
  assert.equal('provider' in bodies[2], false)

  // A legacy recipe names no floor, so the header falls back to `any` rather than
  // `bypass`: nothing was configured to withhold.
  const legacy = await send('/v1/chat/completions', 'legacy')
  assert.equal(legacy.headers.get('x-oorp-precision'), 'any')
  assert.equal(bodies[3].service_tier, 'flex')

  // The resolver is only consulted on a bare mount, so a pinned mount reports `any`.
  const pinned = await send('/flex/v1/chat/completions', 'enforced')
  assert.equal(pinned.headers.get('x-oorp-precision'), 'any')
  assert.equal(bodies[4].service_tier, 'flex', 'the mount still wins over the Session recipe')

  // The model travels with the Session: admission is per model, and the relay is the
  // only party that knows which model this request asked for.
  assert.deepEqual(asked, [
    'enforced:deepseek/deepseek-v3.2',
    'bypassed:deepseek/deepseek-v3.2',
    'any:deepseek/deepseek-v3.2',
    'legacy:deepseek/deepseek-v3.2',
  ])
  // A request that names no model passes null rather than inventing an id.
  const anonymous = await fetch(`${address.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'enforced' },
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(anonymous.status, 200)
  assert.equal(asked.at(-1), 'enforced:null')
})

test('a relay with no resolver adds no precision header value beyond any', async () => {
  /** @type {string | undefined} */
  let receivedBody
  const gateway = await startServer(async (req, res) => {
    receivedBody = (await readRequestBody(req)).toString('utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  const { address } = await startRelay(gateway.origin)
  const response = await fetch(`${address.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v3.2', messages: [] }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-oorp-precision'), 'any')
  // Byte-identical to a pre-feature relay: no provider block, no floor.
  assert.equal(receivedBody, JSON.stringify({ model: 'deepseek/deepseek-v3.2', messages: [] }))
})
