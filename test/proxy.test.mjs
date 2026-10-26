import { strict as assert } from 'node:assert'
import http from 'node:http'
import { after, test } from 'node:test'

import { createMetrics } from '../lib/metrics.js'
import { createRelay, findUsage } from '../lib/proxy.js'

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
  assert.deepEqual(findUsage(sse), { promptTokens: 9, completionTokens: 4 })
  assert.deepEqual(
    findUsage('{"id":"x","usage":{"prompt_tokens":3,"completion_tokens":2},"model":"m"}'),
    { promptTokens: 3, completionTokens: 2 },
  )
  assert.deepEqual(findUsage('no usage here'), { promptTokens: null, completionTokens: null })
  assert.deepEqual(findUsage(''), { promptTokens: null, completionTokens: null })
})
