/**
 * Which relay on this machine is "the" relay?
 *
 * Two processes on one machine cannot share a port, so the second falls forward and
 * serves its own, different Sessions. A control call must therefore address the relay
 * that carries the traffic, which is the one the provider rows name. These tests pin
 * the pure decisions — loopback, URL shape, candidate order — and then the resolver's
 * ordering, caching and stale-answer rules with an injected probe, so no socket is
 * opened and no real relay has to exist.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  ORIGIN_CACHE_MS,
  PORT_SCAN_LIMIT,
  RELAY_PROBE_TIMEOUT_MS,
  createOriginResolver,
  isLoopbackHostname,
  loopbackOriginsOf,
  originOf,
  parseOrigin,
  probeRelay,
} from '../lib/control-origin.js'

/** A probe that records every origin it was asked about and answers from a predicate. */
function recordingProbe(healthy) {
  const asked = []
  const probe = async (origin) => {
    asked.push(origin)
    return typeof healthy === 'function' ? healthy(origin) : healthy
  }
  return { asked, probe }
}

test('the probe, cache and scan limits are bounded tunables', () => {
  assert.equal(Number.isFinite(RELAY_PROBE_TIMEOUT_MS), true)
  assert.ok(RELAY_PROBE_TIMEOUT_MS > 0, 'a probe runs before a keystroke lands, but it does end')
  assert.equal(Number.isFinite(ORIGIN_CACHE_MS), true)
  assert.ok(ORIGIN_CACHE_MS >= RELAY_PROBE_TIMEOUT_MS, 'a cache shorter than a probe would only add latency')
  assert.equal(Number.isInteger(PORT_SCAN_LIMIT), true)
  assert.ok(PORT_SCAN_LIMIT > 0 && PORT_SCAN_LIMIT < 100, 'the fallback range is a guess, kept small')
})

test('isLoopbackHostname() answers only for names that mean this machine', () => {
  for (const hostname of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHostname(hostname), true, `${hostname} is this machine`)
  }
  // A provider row pointing at OpenRouter is a route, not a relay to probe.
  for (const hostname of ['api.openrouter.ai', '127.0.0.1.nip.io', '', undefined, null, 7]) {
    assert.equal(isLoopbackHostname(hostname), false, `${String(hostname)} is not this machine`)
  }
})

test('parseOrigin() keeps a scheme and an authority, and nothing else', () => {
  assert.equal(parseOrigin('http://127.0.0.1:8791/t/abc/v1'), 'http://127.0.0.1:8791')
  assert.equal(parseOrigin('https://example.com/a?b=1#c'), 'https://example.com')
  // A baseURL pasted with spaces around it is a hand-edited profile, not a new URL.
  assert.equal(parseOrigin('  http://127.0.0.1:8791  '), 'http://127.0.0.1:8791')

  assert.equal(parseOrigin('not a url'), null)
  assert.equal(parseOrigin('ftp://h/p'), null, 'the relay is an http server, so another scheme is not a candidate')
  assert.equal(parseOrigin(''), null)
  assert.equal(parseOrigin('   '), null)
  assert.equal(parseOrigin(null), null)
  assert.equal(parseOrigin(undefined), null)
  assert.equal(parseOrigin(42), null)
})

test('loopbackOriginsOf() keeps declaration order, dedupes and drops the rest', () => {
  const rows = [
    'http://127.0.0.1:8791/t/abc/v1',
    'https://api.openrouter.ai/api/v1',
    'http://localhost:8792/t/def/v1',
    'http://127.0.0.1:8791/t/other/v1',
    'not a url',
    null,
    '',
    'ftp://127.0.0.1:8793/x',
    'http://[::1]:8793/t/x/v1',
  ]
  // The first row is usually the route the person actually uses, so order is the
  // probe order and must not be rearranged.
  assert.deepEqual(loopbackOriginsOf(rows), [
    'http://127.0.0.1:8791',
    'http://localhost:8792',
    'http://[::1]:8793',
  ])

  // A relay the caller already knows about is skipped, not merely moved last.
  assert.deepEqual(loopbackOriginsOf(rows, { skip: ['http://127.0.0.1:8791'] }), [
    'http://localhost:8792',
    'http://[::1]:8793',
  ])

  assert.deepEqual(loopbackOriginsOf(undefined), [])
  assert.deepEqual(loopbackOriginsOf(new Set(['http://127.0.0.1:8791'])), ['http://127.0.0.1:8791'])
})

test('originOf() maps a wildcard bind onto loopback and refuses impossible ports', () => {
  // A wildcard bind is still reachable on loopback, and that is the only address a
  // terminal should ever use.
  assert.equal(originOf('0.0.0.0', 8791), 'http://127.0.0.1:8791')
  assert.equal(originOf('::', 8792), 'http://127.0.0.1:8792')
  assert.equal(originOf('[::]', 8793), 'http://127.0.0.1:8793')
  assert.equal(originOf('', 8794), 'http://127.0.0.1:8794')
  assert.equal(originOf('localhost', 8795), 'http://localhost:8795')
  assert.equal(originOf('127.0.0.1', 65_535), 'http://127.0.0.1:65535')

  // A concrete IPv6 literal has to be bracketed to be a URL at all; an unbracketed
  // `http://::1:8791` is exactly the address the client refuses to parse.
  assert.equal(originOf('::1', 8796), 'http://[::1]:8796')
  assert.equal(originOf('[::1]', 8797), 'http://[::1]:8797', 'an already-bracketed host is not bracketed twice')
  assert.equal(originOf('fe80::1', 8798), 'http://[fe80::1]:8798')
  for (const host of ['::1', '[::1]', 'fe80::1']) {
    assert.equal(new URL(originOf(host, 8799)).hostname, host.startsWith('[') ? host : `[${host}]`)
  }

  // A port that cannot be bound must not become a URL that cannot be fetched.
  for (const port of [0, -1, 70_000, Number.NaN, 1.5, '8791', undefined, null, 65_536]) {
    assert.equal(originOf('127.0.0.1', port), null, `${String(port)} is not a port`)
  }
})

test('originOf() refuses a host that was mistyped as host:port', () => {
  // A `host` option carrying `denorm:port` would otherwise be bracketed by the IPv6
  // rule and become a string every later layer fails on for a different-looking
  // reason. Building the URL and asking the parser is the one honest test.
  assert.equal(originOf('denorm:8791', 8792), null)
  assert.equal(originOf('localhost:8791', 8792), null)
  // The bracketing rule still ignores names that merely contain a colon.
  assert.equal(originOf('localhost', 8792), 'http://localhost:8792')
})

test('probeRelay() recognises our relay by its own `ok` statement', async () => {
  const calls = []
  const probe = await probeRelay('http://127.0.0.1:8791', {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.equal(probe, true)
  assert.equal(calls[0].url, 'http://127.0.0.1:8791/__openrouter-plus/health')
  // The Host's write fence looks for this exact header pair; a probe that omitted it
  // would not be testing the relay the TUI actually talks to.
  assert.equal(calls[0].init.headers['x-oorp-client'], 'tui')
})

test('probeRelay() trims a trailing slash from the origin it was given', async () => {
  const calls = []
  const healthy = await probeRelay('http://127.0.0.1:8791/', {
    fetchImpl: async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.equal(healthy, true, 'a healthy relay must not be missed over a stray slash')
  assert.equal(calls[0], 'http://127.0.0.1:8791/__openrouter-plus/health', 'one slash, not two')
})

test('probeRelay() returns false for anything that is not a healthy plugin relay', async () => {
  const answer = (body, status = 200) =>
    probeRelay('http://127.0.0.1:8791', {
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    })

  assert.equal(await answer({ ok: false }), false)
  assert.equal(await answer({ ok: true }, 500), false, 'a 500 is not a relay even when the body says so')
  assert.equal(await answer({ status: 'ok' }), false, 'a look-alike body is not enough')
  assert.equal(await answer({}), false)

  // Some other server on the same port answering HTML is precisely the case the
  // `ok` field exists to reject.
  const html = await probeRelay('http://127.0.0.1:8791', {
    fetchImpl: async () => new Response('<html>hello</html>', { status: 200 }),
  })
  assert.equal(html, false)
})

test('probeRelay() treats a refused socket or a silence as "not this one"', async () => {
  const refused = await probeRelay('http://127.0.0.1:8791', {
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  assert.equal(refused, false, 'an unreachable candidate is a no, not a fault to report')

  const started = Date.now()
  const silent = await probeRelay('http://127.0.0.1:8791', {
    timeoutMs: 25,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason)
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
  })
  assert.equal(silent, false)
  assert.ok(Date.now() - started < 1_000, 'a probe cannot outlive its own deadline')
})

test('the resolver asks the declared rows, then its own listener, then the fallback range', async () => {
  const { asked, probe } = recordingProbe(false)
  const resolver = createOriginResolver({
    // An async reader, as the profile bridge is, and a duplicate row on purpose.
    candidates: async () => ['http://127.0.0.1:9001', 'http://127.0.0.1:9001'],
    ownOrigin: () => 'http://127.0.0.1:9002',
    host: '127.0.0.1',
    port: 9100,
    portFallback: true,
    probe,
  })

  assert.equal(await resolver.resolve(), null)
  const expected = [
    'http://127.0.0.1:9001',
    'http://127.0.0.1:9002',
    ...Array.from({ length: PORT_SCAN_LIMIT }, (_, offset) => `http://127.0.0.1:${9100 + offset}`),
  ]
  assert.deepEqual(asked, expected, 'declared rows first, own listener second, guesses last')
  assert.deepEqual(await resolver.candidates(), expected, 'the list itself is deduped and ordered')
})

test('a process that fell forward still scans from the configured port', async () => {
  // Configured 8791, bound 8792 after a fall-forward. The sibling that owns 8791 is
  // the instance the provider rows dial, so the range has to start there — starting
  // at the bound port would look at 8792..8801 and never see it.
  const { asked, probe } = recordingProbe((origin) => origin === 'http://127.0.0.1:8791')
  const resolver = createOriginResolver({
    candidates: () => [],
    ownOrigin: () => 'http://127.0.0.1:8792',
    host: '127.0.0.1',
    port: 8791,
    portFallback: true,
    probe,
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8791')
  assert.equal(asked[0], 'http://127.0.0.1:8792', 'its own bound address is still tried first')
  assert.ok(asked.includes('http://127.0.0.1:8791'), 'the configured port is inside the range')
})

test('the fallback range is not scanned unless it was asked for', async () => {
  const { asked, probe } = recordingProbe(false)
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:9001'],
    ownOrigin: () => null,
    host: '127.0.0.1',
    port: 9100,
    probe,
  })

  assert.equal(await resolver.resolve(), null)
  // A single-instance machine never reaches the scan, so it never pays for it.
  assert.deepEqual(asked, ['http://127.0.0.1:9001'])
})

test('the resolver never probes a candidate that is not on this machine', async () => {
  const { asked, probe } = recordingProbe(false)
  const resolver = createOriginResolver({
    // Raw provider rows: the resolver is the last place before a socket opens, so it
    // must not trust a caller to have filtered them first.
    candidates: () => [
      'https://api.openrouter.ai/api/v1',
      'http://127.0.0.1:8791',
      'http://example.com:9000/v1',
      'http://[::1]:8792',
      'not a url',
    ],
    ownOrigin: () => 'https://openrouter.ai',
    probe,
  })

  assert.equal(await resolver.resolve(), null)
  assert.deepEqual(asked, ['http://127.0.0.1:8791', 'http://[::1]:8792'], 'only loopback rows are relays')
  assert.deepEqual(await resolver.candidates(), ['http://127.0.0.1:8791', 'http://[::1]:8792'])
})

test('a candidate given as a mounted baseURL is probed at its origin', async () => {
  // The real caller reads provider rows, whose `baseURL` carries the mount path
  // (`/t/<id>/flex/v1`). Probing that string would append `/__openrouter-plus/health`
  // to a relay mount and 404 against a perfectly healthy relay.
  const { asked, probe } = recordingProbe(true)
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:8791/t/openrouter-ai-1xu3/flex/v1', 'http://127.0.0.1:8791/v1'],
    probe,
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8791')
  assert.deepEqual(asked, ['http://127.0.0.1:8791'], 'two mounts of one relay are one origin, and the path is dropped')
})

test('the first healthy origin is remembered for the length of the cache window', async () => {
  let clock = 1_000
  const { asked, probe } = recordingProbe((origin) => origin === 'http://127.0.0.1:8792')
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:8791', 'http://127.0.0.1:8792'],
    ownOrigin: () => 'http://127.0.0.1:8793',
    probe,
    cacheMs: 30_000,
    now: () => clock,
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8792')
  assert.deepEqual(asked, ['http://127.0.0.1:8791', 'http://127.0.0.1:8792'])
  assert.equal(resolver.known(), 'http://127.0.0.1:8792')

  const probes = asked.length
  clock = 30_999 // 29 999 ms after the cache was written
  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8792')
  assert.equal(asked.length, probes, 'inside the window the answer is reused, not probed again')

  clock = 31_000 // exactly at the boundary
  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8792')
  assert.equal(asked.length, probes + 2, 'at the end of the window the next call looks again')
})

test('invalidate() makes the next call look again', async () => {
  let clock = 0
  let healthy = 'http://127.0.0.1:8791'
  const { asked, probe } = recordingProbe((origin) => origin === healthy)
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:8791', 'http://127.0.0.1:8792'],
    probe,
    cacheMs: 30_000,
    now: () => clock,
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8791')
  healthy = 'http://127.0.0.1:8792'
  // Without the invalidation the cache would keep answering 8791 for another 30 s,
  // which is exactly the "switch that does nothing" this resolver exists to avoid.
  resolver.invalidate()
  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8792')
  assert.deepEqual(asked.slice(-2), ['http://127.0.0.1:8791', 'http://127.0.0.1:8792'])
})

test('a stale answer beats no answer when every probe has gone quiet', async () => {
  let clock = 0
  let healthy = true
  const logs = []
  const { probe } = recordingProbe(() => healthy)
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:8791'],
    probe,
    cacheMs: 1_000,
    now: () => clock,
    log: (level, message) => logs.push({ level, message }),
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8791')
  healthy = false
  clock += 5_000
  // The client's own message ("cannot reach <origin>") is more useful than a shrug,
  // so the last known origin survives a failed re-probe.
  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8791')
  assert.equal(resolver.known(), 'http://127.0.0.1:8791')
  assert.equal(
    logs.some((entry) => entry.level === 'warn' && /last known origin/.test(entry.message)),
    true,
  )
})

test('a machine with no relay anywhere resolves to nothing, quietly', async () => {
  const { probe } = recordingProbe(false)
  const logs = []
  const resolver = createOriginResolver({
    candidates: () => ['http://127.0.0.1:8791'],
    probe,
    log: (level) => logs.push(level),
  })

  assert.equal(await resolver.resolve(), null)
  assert.equal(resolver.known(), null)
  // A disabled plugin is ordinary, not a warning printed on every keystroke.
  assert.deepEqual(logs, [])
})

test('a profile that cannot be read is a warning, and the own listener is still tried', async () => {
  const details = []
  const { asked, probe } = recordingProbe((origin) => origin === 'http://127.0.0.1:8792')
  const resolver = createOriginResolver({
    candidates: () => {
      throw new Error('profile unreadable')
    },
    ownOrigin: () => 'http://127.0.0.1:8792',
    probe,
    log: (level, message, detail) => details.push({ level, message, detail }),
  })

  assert.equal(await resolver.resolve(), 'http://127.0.0.1:8792')
  assert.deepEqual(asked, ['http://127.0.0.1:8792'], 'one unreadable row set does not hide this process')
  assert.equal(details[0].level, 'warn')
  assert.match(details[0].message, /provider rows/)
  assert.match(details[0].detail.reason, /profile unreadable/)
})
