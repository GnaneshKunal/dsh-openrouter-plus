/**
 * The terminal's way into the control API: `/__openrouter-plus/*` over plain HTTP.
 *
 * What matters here is the wire form and the two ways a call can fail. A TUI has no
 * browser origin and no console, so the client owns the mount prefix, the one header
 * the control layer requires on a write, and a timeout that ends a call instead of
 * freezing the composer. Every case runs against an injected `fetch` except the last,
 * which binds a real `node:http` server on port 0 to prove the mounted path, header
 * and body actually leave the process.
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { test } from 'node:test'

import {
  CONTROL_CLIENTS,
  CONTROL_CLIENT,
  CONTROL_CLIENT_HEADER,
  CONTROL_PREFIX,
  CONTROL_TIMEOUT_MS,
  ControlRejected,
  ControlUnavailable,
  createControlClient,
} from '../lib/control-client.js'

/** A JSON answer with a status, as the control API sends on every route. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A `fetch` stand-in that records what it was asked to do, then runs `respond`. */
function stubFetch(respond) {
  const calls = []
  // Record the input exactly as it arrived: the type is part of the transport
  // contract, and `String(url)` here would hide a regression back to a URL object.
  const fetchImpl = async (input, init) => {
    calls.push({ url: input, init })
    return respond(String(input), init)
  }
  return { calls, fetchImpl }
}

/** A `fetch` that stays pending until its signal aborts, exactly like the real one. */
function pendingFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason)
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
}

test('the control vocabulary is one contract the page and the terminal share', () => {
  assert.equal(CONTROL_PREFIX, '/__openrouter-plus')
  assert.equal(CONTROL_CLIENT, 'tui')
  assert.deepEqual([...CONTROL_CLIENTS], ['web', 'tui'])
  // Frozen on purpose: this list is the control layer's allow-list, and a caller
  // adding to it at runtime would be changing a security decision in place.
  assert.equal(Object.isFrozen(CONTROL_CLIENTS), true)
  assert.throws(() => CONTROL_CLIENTS.push('script'), TypeError)

  assert.equal(Number.isFinite(CONTROL_TIMEOUT_MS), true)
  assert.ok(CONTROL_TIMEOUT_MS > 0, 'a call has a deadline, never an infinite wait')
})

test('a GET addresses the mount and identifies itself as the terminal', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true, bound: true }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  assert.deepEqual(await client.get('/status'), { ok: true, bound: true })
  assert.equal(stub.calls.length, 1)
  assert.equal(typeof stub.calls[0].url, 'string', 'a transport gets the href as a string, not a URL object')
  assert.equal(stub.calls[0].url, 'http://127.0.0.1:8791/__openrouter-plus/status')
  assert.equal(stub.calls[0].init.method, 'GET')
  assert.equal(stub.calls[0].init.headers['accept'], 'application/json')
  assert.equal(stub.calls[0].init.headers[CONTROL_CLIENT_HEADER], 'tui')
  assert.equal(stub.calls[0].init.body, undefined, 'a GET carries no body')
})

test('an origin that is resolved asynchronously is awaited before the call', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true }))
  // `createOriginResolver().resolve()` is async, so this is the shape the TUI actually
  // passes: a promise, not a string.
  const client = createControlClient({
    origin: async () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  assert.deepEqual(await client.get('/status'), { ok: true })
  assert.equal(stub.calls[0].url, 'http://127.0.0.1:8791/__openrouter-plus/status')
})

test('a path that already spells the mount is not prefixed twice', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  // A hand-written `curl` spells the whole mount; this client must accept that too.
  await client.get('/__openrouter-plus/status')
  await client.get('/__openrouter-plus')
  // A route without a leading slash is still a route, not a URL concatenation bug.
  await client.get('presets')

  assert.deepEqual(stub.calls.map((call) => call.url), [
    'http://127.0.0.1:8791/__openrouter-plus/status',
    'http://127.0.0.1:8791/__openrouter-plus',
    'http://127.0.0.1:8791/__openrouter-plus/presets',
  ])
})

test('query values are appended, and empty ones are left out', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  await client.get('/sessions', {
    session: 'abc',
    preset: 'flex',
    off: undefined,
    none: null,
    blank: '',
  })
  const url = new URL(stub.calls[0].url)
  assert.equal(url.pathname, '/__openrouter-plus/sessions')
  assert.equal(url.search, '?session=abc&preset=flex')
  // The distinction is deliberate: an absent filter is not the filter `?x=`.
  assert.equal(url.searchParams.has('off'), false)
  assert.equal(url.searchParams.has('none'), false)
  assert.equal(url.searchParams.has('blank'), false)

  // Zero is a value, not an absence, and must survive the same filter.
  await client.get('/sessions', { limit: 0 })
  assert.equal(new URL(stub.calls[1].url).search, '?limit=0')
})

test('a trailing slash on the origin does not become a double slash', async () => {
  const slashed = stubFetch(() => jsonResponse({ ok: true }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791/',
    fetchImpl: slashed.fetchImpl,
  })
  await client.get('/status')
  assert.equal(slashed.calls[0].url, 'http://127.0.0.1:8791/__openrouter-plus/status')

  // Surrounding whitespace is a hand-edited config, not a different address.
  const padded = stubFetch(() => jsonResponse({ ok: true }))
  const paddedClient = createControlClient({
    origin: () => '  http://127.0.0.1:8791//  ',
    fetchImpl: padded.fetchImpl,
  })
  await paddedClient.get('/status')
  assert.equal(padded.calls[0].url, 'http://127.0.0.1:8791/__openrouter-plus/status')
})

test('a POST sends the JSON body, its content type and the terminal header', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true, preset: 'flex' }))
  const body = { preset: 'flex', precision: { floor: 'eight-bit-up' } }
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  assert.deepEqual(await client.post('/preset', body), { ok: true, preset: 'flex' })
  assert.equal(stub.calls[0].init.method, 'POST')
  assert.equal(stub.calls[0].init.headers['content-type'], 'application/json')
  assert.equal(stub.calls[0].init.headers[CONTROL_CLIENT_HEADER], 'tui')
  // Exactly the serialised body: the control layer's write guard and the route both
  // read this byte for byte.
  assert.equal(stub.calls[0].init.body, JSON.stringify(body))
})

test('a refusal keeps the status, the path and the API`s own explanation', async () => {
  const refusal = { error: { message: 'unknown preset "turbo"' } }
  const stub = stubFetch(() => jsonResponse(refusal, 400))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  await assert.rejects(
    client.post('/preset', { preset: 'turbo' }),
    (error) => {
      assert.ok(error instanceof ControlRejected)
      assert.equal(error.status, 400)
      assert.equal(error.path, '/preset')
      // The transcript repeats what the API said, not "HTTP 400": a person can act on
      // a bad preset name and cannot act on a status code.
      assert.equal(error.message, 'unknown preset "turbo"')
      assert.deepEqual(error.body, refusal)
      return true
    },
  )
})

test('a refusal without a JSON body still says what was refused', async () => {
  const stub = stubFetch(
    () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  )
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  // A proxy in between can answer HTML; that must not turn into "Unexpected token <".
  await assert.rejects(client.get('/status'), (error) => {
    assert.ok(error instanceof ControlRejected)
    assert.equal(error.status, 502)
    assert.match(error.message, /GET/)
    assert.match(error.message, /\/status/)
    assert.match(error.message, /502/)
    assert.equal(error.body, null)
    return true
  })
})

test('a relay that refuses the socket is unavailable, and the origin is named', async () => {
  const failure = new Error('connect ECONNREFUSED 127.0.0.1:8791')
  const stub = stubFetch(() => {
    throw failure
  })
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  await assert.rejects(client.get('/status'), (error) => {
    assert.ok(error instanceof ControlUnavailable)
    // The origin is the one fact a person needs to fix this: the wrong port looks
    // exactly like a plugin that is not running.
    assert.match(error.message, /http:\/\/127\.0\.0\.1:8791/)
    assert.equal(error.origin, 'http://127.0.0.1:8791')
    assert.equal(error.cause, failure)
    return true
  })
})

test('a relay that never answers is abandoned at the timeout, not left pending', async () => {
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    timeoutMs: 25,
    fetchImpl: pendingFetch,
  })

  const started = Date.now()
  await assert.rejects(client.get('/status'), (error) => {
    assert.ok(error instanceof ControlUnavailable)
    assert.match(error.message, /could not reach/)
    return true
  })
  // The point of the timeout is that the composer gets an answer at all.
  assert.ok(Date.now() - started < 1_000, 'the call ends at its own deadline')
})

test('an origin that cannot be named is a refusal, and nothing is sent', async () => {
  const origins = [
    () => null,
    () => '',
    () => {
      throw new Error('profile unreadable')
    },
  ]
  for (const origin of origins) {
    const stub = stubFetch(() => jsonResponse({ ok: true }))
    const client = createControlClient({ origin, fetchImpl: stub.fetchImpl })
    await assert.rejects(client.get('/status'), (error) => {
      assert.ok(error instanceof ControlUnavailable)
      assert.equal(error.origin, null)
      return true
    })
    assert.equal(stub.calls.length, 0, 'no address, no request')
  }
})

test('an origin that is not http(s) is refused before anything is sent', async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true }))
  const client = createControlClient({
    origin: () => 'ftp://x',
    fetchImpl: stub.fetchImpl,
  })

  await assert.rejects(client.get('/status'), (error) => {
    assert.ok(error instanceof ControlUnavailable)
    assert.match(error.message, /cannot use/)
    assert.match(error.message, /ftp:\/\/x/)
    return true
  })
  assert.equal(stub.calls.length, 0)
})

test('a 200 that is not JSON resolves as nothing instead of a parse error', async () => {
  const html = stubFetch(() => new Response('<!doctype html><title>hello</title>', { status: 200 }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: html.fetchImpl,
  })
  assert.equal(await client.get('/status'), null, 'an unreadable answer is still an answer')

  // An empty body is the same case: some proxies strip the JSON on a 200.
  const empty = stubFetch(() => new Response('', { status: 200 }))
  const emptyClient = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: empty.fetchImpl,
  })
  assert.equal(await emptyClient.get('/status'), null)
})

test('aborting the caller signal reports a cancellation, not a network fault', async () => {
  const controller = new AbortController()
  let release
  const started = new Promise((resolve) => {
    release = resolve
  })
  const fetchImpl = (_url, init) => {
    release()
    return pendingFetch(_url, init)
  }
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    timeoutMs: 5_000,
    fetchImpl,
  })

  const pending = client.get('/status', {}, { signal: controller.signal })
  await started
  controller.abort(new Error('the composer moved on'))

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof ControlUnavailable)
    // "Cancelled" and "unreachable" need different words: one is the person's doing,
    // the other is the plugin's.
    assert.match(error.message, /cancelled/)
    assert.equal(error.origin, 'http://127.0.0.1:8791')
    return true
  })
})

test('a signal that is already aborted is a cancellation before anything is sent', async () => {
  const controller = new AbortController()
  const callerReason = new Error('the composer moved on')
  controller.abort(callerReason)
  const stub = stubFetch(() => jsonResponse({ ok: true }))
  const client = createControlClient({
    origin: () => 'http://127.0.0.1:8791',
    fetchImpl: stub.fetchImpl,
  })

  await assert.rejects(client.get('/status', {}, { signal: controller.signal }), (error) => {
    // `throwIfAborted()` alone would leak the caller's own error type into a command
    // handler that only knows the two control faults.
    assert.ok(error instanceof ControlUnavailable)
    assert.match(error.message, /cancelled/)
    assert.equal(error.cause, callerReason)
    return true
  })
  assert.equal(stub.calls.length, 0, 'a cancelled call never reaches the wire')
})

test('a real server sees the mounted path, the header and the JSON body', async (t) => {
  /** @type {Array<{url: string, headers: import('node:http').IncomingHttpHeaders, body: string}>} */
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined))
        // `fetch` keeps its socket alive between calls; without this the close
        // callback waits on an idle connection and the runner never exits.
        server.closeAllConnections()
      }),
  )

  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  const client = createControlClient({ origin: () => `http://127.0.0.1:${port}` })

  assert.deepEqual(await client.get('/status', { session: 'abc' }), { ok: true })
  assert.deepEqual(await client.post('/preset', { preset: 'flex' }), { ok: true })

  assert.equal(seen[0].url, '/__openrouter-plus/status?session=abc')
  assert.equal(seen[0].headers[CONTROL_CLIENT_HEADER], 'tui')
  assert.equal(seen[1].url, '/__openrouter-plus/preset')
  assert.equal(seen[1].headers['content-type'], 'application/json')
  assert.equal(seen[1].body, '{"preset":"flex"}')
})
