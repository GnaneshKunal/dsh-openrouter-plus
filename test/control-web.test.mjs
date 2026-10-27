/**
 * The control API on the DSH web server's own origin.
 *
 * The point of this mount is that the page and the API share an origin, so the
 * browser never has to reach the relay's loopback port. These tests boot the real
 * `apply()` against a stand-in web server and a stand-in `ctx.connection`, then
 * speak HTTP to the mounted route exactly as the settings page, `curl`, and a
 * foreign web page would.
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Reserve a port by binding it, then hand it over. */
async function freePort() {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}

/**
 * The fence a real `ctx.connection` applies, reduced to its decisions: the Host
 * must be ours (loopback or a declared authority), a cross-site or mismatched
 * Origin is refused, and anything without the session cookie is unauthenticated.
 */
function createFakeConnection(options = {}) {
  const trusted = options.trusted ?? /^(?:127(?:\.\d{1,3}){3}|localhost)(?::\d+)?$/
  return {
    requestRejection(req) {
      const host = String(req.headers.host ?? '')
      const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      const authority = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])$/i.test(name) || trusted.test(host)
      if (!authority) return 403
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = req.headers.origin
      if (origin !== undefined) {
        const originHost = (() => {
          try {
            return new URL(origin).host
          } catch {
            return ''
          }
        })()
        if (originHost !== host) return 403
      }
      return typeof req.headers.cookie === 'string' && req.headers.cookie.includes('dsh-auth-')
        ? undefined
        : 401
    },
  }
}

/**
 * The smallest web server `ctx.webServer` needs, with the two contracts the mount
 * relies on: duplicate `(kind, path)` throws, and the disposer removes the route.
 *
 * @param {{ trusted?: RegExp }} [options]
 */
function createHarness(options = {}) {
  /** @type {Array<{kind: string, path: string, handler: Function}>} */
  const routes = []
  /** @type {Array<() => unknown>} */
  const disposers = []
  /** @type {string[]} */
  const logs = []
  const connection = createFakeConnection(options)

  const webServer = {
    register(route) {
      if (routes.some((known) => known.kind === route.kind && known.path === route.path)) {
        throw new Error(`duplicate route ${route.kind} ${route.path}`)
      }
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }

  const ctx = {
    logger: {
      info: (...args) => logs.push(`info: ${args.map(String).join(' ')}`),
      warn: (...args) => logs.push(`warn: ${args.map(String).join(' ')}`),
      error: (...args) => logs.push(`error: ${args.map(String).join(' ')}`),
    },
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
    on: () => () => {},
    inject(deps, callback) {
      const scope = {
        get: ctx.get,
        webServer: deps.includes('webServer') ? webServer : undefined,
      }
      callback(scope)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  return {
    ctx,
    routes,
    logs,
    connection,
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

/** Serve the registered prefix route over a real socket, as DSH's server would. */
async function serveMounted(harness) {
  const route = harness.routes[0]
  assert.ok(route, 'the control API registered a route')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/__openrouter-plus')

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    const matched = handlerFor(harness.routes, pathname)
    if (matched === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void matched(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined))
        // `fetch` keeps its socket alive between assertions; without this the
        // close callback would wait on an idle connection and the runner would
        // never exit.
        server.closeAllConnections()
      })
    },
  }
}

/** Longest-prefix match over the fake route table. */
function handlerFor(routes, pathname) {
  const route = routes.find(
    (entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`),
  )
  if (route === undefined) return undefined
  return route.handler
}

/**
 * One HTTP request with full control of Host and Origin — `fetch` refuses to set
 * Host, and the fence is precisely what those two headers decide.
 *
 * @param {{origin: string}} server
 * @param {string} path
 * @param {Record<string, string>} headers
 * @returns {Promise<{status: number, body: string}>}
 */
function rawRequest(server, path, headers) {
  const url = new URL(path, server.origin)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        // No pooled socket to leak into the next test.
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

test('the control API is mounted on the web origin, not another port', async () => {
  const harness = createHarness()
  const port = await freePort()
  apply(harness.ctx, { port, enabled: true })
  try {
    assert.equal(harness.routes.length, 1)
    assert.equal(harness.routes[0].path, '/__openrouter-plus')
    assert.equal(harness.routes[0].kind, 'prefix')
  } finally {
    await harness.dispose()
  }
})

test('a local process may read the control API without a cookie, as before', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    const response = await fetch(`${server.origin}/__openrouter-plus/health`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('a browser session passes the GUI fence and reads the same API', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    const response = await fetch(`${server.origin}/__openrouter-plus/status`, {
      headers: { cookie: 'dsh-auth-abc=token', origin: server.origin },
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.bound, true, 'the relay owns a socket')
    assert.equal(typeof payload.port, 'number')
    assert.equal(payload.controlPrefix, '/__openrouter-plus')
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('a page on another origin cannot read the control API', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    // A foreign page carries its own Origin, which the fence refuses. The
    // unauthenticated-local-process exemption must not rescue it: the rejection
    // is 403, not 401.
    const forged = await fetch(`${server.origin}/__openrouter-plus/status`, {
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(forged.status, 403)

    const crossed = await fetch(`${server.origin}/__openrouter-plus/status`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossed.status, 403)
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('an unauthenticated remote page is refused, not exempted', async () => {
  // A Tailscale authority: trusted for the Host fence, but a request from it with
  // no session cookie is 401 and, not being loopback, gets no exemption.
  const harness = createHarness({ trusted: /^gnaneshs-macbook-pro\.tailc03322\.ts\.net$/ })
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    const anonymous = await rawRequest(server, '/__openrouter-plus/health', {
      host: 'gnaneshs-macbook-pro.tailc03322.ts.net',
      origin: 'https://gnaneshs-macbook-pro.tailc03322.ts.net',
    })
    assert.equal(anonymous.status, 401, 'trusted host, no cookie: unauthenticated and not exempted')
    assert.match(anonymous.body, /not authenticated/)
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('an unknown path under the prefix is a 404, not a proxy attempt', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    const response = await fetch(`${server.origin}/__openrouter-plus/nope`)
    assert.equal(response.status, 404)
    const payload = await response.json()
    assert.match(payload.error.message, /unknown control endpoint/)
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('the write guard still applies through the web mount', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  const server = await serveMounted(harness)
  try {
    const unguarded = await fetch(`${server.origin}/__openrouter-plus/routes/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(unguarded.status, 403)
  } finally {
    await server.close()
    await harness.dispose()
  }
})

test('a live patch reload can re-register the route without a duplicate', async () => {
  const harness = createHarness()
  apply(harness.ctx, { port: await freePort(), enabled: true })
  assert.equal(harness.routes.length, 1)
  await harness.dispose()
  assert.equal(harness.routes.length, 0, 'unloading removes the route')
  // The same fake server throws on a duplicate, so this only passes when the
  // disposer ran before the second mount.
  apply(harness.ctx, { port: await freePort(), enabled: true })
  try {
    assert.equal(harness.routes.length, 1)
  } finally {
    await harness.dispose()
  }
})
