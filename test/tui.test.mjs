/**
 * The terminal outlet's wiring: the Session a command runs for, the two names it
 * registers, and how a registry that is absent, late or hostile is handled.
 *
 * The command text itself is asserted in `tui-command.test.mjs`; this file is
 * about the seam. The last test is the one that matters most: it drives the
 * definition the installer actually registered, with an injected `fetch`, and
 * proves the handler resolved an origin before it read anything — not merely
 * that a function was returned.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { TUI_COMMAND_ALIAS, TUI_COMMAND_NAME } from '../lib/tui-command.js'
import { installTui, sessionIdOf, tuiCommandDefinitions } from '../lib/tui.js'

/** A log sink that keeps `(level, message)` pairs; the installer must never print. */
function logCollector() {
  const entries = []
  return {
    entries,
    log: (level, message) => entries.push({ level, message }),
  }
}

/**
 * A command registry that records what it was given and what it tore down.
 *
 * @param {(definition: { name: string }) => boolean} [refuse] names to reject, as a collision would
 */
function recordingRegistry(refuse = () => false) {
  const registered = []
  const disposed = []
  return {
    registered,
    disposed,
    register(definition) {
      if (refuse(definition)) throw new Error(`/${definition.name} is already registered`)
      registered.push(definition)
      return () => disposed.push(definition.name)
    },
  }
}

/** A context with the direct probe and nothing else: the fallback path installTui takes. */
function probingContext(registry) {
  return { get: (name) => (name === 'commands' ? registry : undefined) }
}

/** A client that records calls; used to prove that pure text touches nothing. */
function spyClient() {
  const calls = []
  return {
    calls,
    get(path, query) {
      calls.push(['GET', path, query])
      return Promise.resolve({})
    },
    post(path, body) {
      calls.push(['POST', path, body])
      return Promise.resolve({})
    },
  }
}

test('sessionIdOf() reads the Session the UI dispatched for', () => {
  // The real shape: `Agent` is `{ id }` and carries `session` at runtime; the
  // shipped plugins read `agent.session.id`. Both must land on the same id — a
  // wrong guess here silently disables every Session verb.
  assert.equal(sessionIdOf({ agent: { id: 'sess-1', session: { id: 'sess-1' } } }), 'sess-1')
  assert.equal(sessionIdOf({ agent: { id: 'sess-1' } }), 'sess-1')
  assert.equal(sessionIdOf({ agent: { session: { id: 'sess-1' } } }), 'sess-1')
  // Kept for a Host whose invocation spells the id directly.
  assert.equal(sessionIdOf({ agent: { sessionId: 'sess-1' } }), 'sess-1')
  // An id that is not a string would become the literal "undefined" in a query,
  // which is a different Session from the one the person is typing in.
  assert.equal(sessionIdOf({ agent: { id: '' } }), '')
})

test('sessionIdOf() answers an empty string when there is no usable id', () => {
  assert.equal(sessionIdOf({}), '')
  assert.equal(sessionIdOf(undefined), '')
  assert.equal(sessionIdOf({ agent: { id: 7 } }), '')
  assert.equal(sessionIdOf({ agent: null }), '')
})

test('tuiCommandDefinitions() registers the primary name and the alias, both complete', () => {
  const definitions = tuiCommandDefinitions({ client: spyClient() })
  assert.equal(definitions.length, 2)
  assert.deepEqual(definitions.map((definition) => definition.name), [TUI_COMMAND_NAME, TUI_COMMAND_ALIAS])
  for (const definition of definitions) {
    assert.ok(definition.description.length > 0, `${definition.name} needs a description for the palette`)
    assert.ok(definition.input.hint.length > 0, `${definition.name} needs a hint for the composer`)
    assert.equal(typeof definition.handler, 'function')
  }
})

test('both handlers answer help from text and call nothing', async () => {
  const client = spyClient()
  for (const definition of tuiCommandDefinitions({ client })) {
    const result = await definition.handler({ rawInput: 'help', agent: { id: 'sess-1', session: { id: 'sess-1' } } })
    assert.equal(result.kind, 'success')
    assert.equal(typeof result.text, 'string')
    assert.ok(result.text.includes(`/${TUI_COMMAND_NAME}`))
  }
  assert.deepEqual(client.calls, [], 'help is pure text and must not ask the relay')
})

test('installTui() registers both names and its disposer removes each exactly once', () => {
  const registry = recordingRegistry()
  const dispose = installTui(probingContext(registry), { log: () => {} })

  assert.equal(typeof dispose, 'function')
  assert.deepEqual(registry.registered.map((definition) => definition.name), [TUI_COMMAND_NAME, TUI_COMMAND_ALIAS])
  assert.deepEqual(registry.disposed, [], 'nothing is torn down until the plugin row unloads')

  dispose()
  assert.deepEqual(registry.disposed, [TUI_COMMAND_NAME, TUI_COMMAND_ALIAS])
  // A profile reload can dispose a row it already disposed; the second call is
  // the one that must not throw.
  assert.doesNotThrow(() => dispose())
  assert.equal(registry.disposed.length, 2, 'each command is removed once, not twice')
})

test('installTui() without a command registry logs one line and stays a no-op disposer', () => {
  const collector = logCollector()
  const contexts = [probingContext(undefined), {}]
  for (const ctx of contexts) {
    const dispose = installTui(ctx, { log: collector.log })
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  }
  assert.equal(collector.entries.length, 2, 'one line per install')
  for (const entry of collector.entries) {
    assert.equal(entry.level, 'info')
    assert.match(entry.message, /no command registry/)
  }
})

test('a registry that refuses one name still registers the other and logs a warning', () => {
  const collector = logCollector()
  const registry = recordingRegistry((definition) => definition.name === TUI_COMMAND_ALIAS)

  // `assert.doesNotThrow` is the point: a name collision is a Host problem, and
  // taking the relay down with it would lose the HTTP front door too.
  assert.doesNotThrow(() => {
    installTui(probingContext(registry), { log: collector.log })
  })

  assert.deepEqual(registry.registered.map((definition) => definition.name), [TUI_COMMAND_NAME])
  const warning = collector.entries.find((entry) => entry.level === 'warn')
  assert.ok(warning, 'the refusal is visible in the Host log')
  assert.match(warning.message, new RegExp(`could not register /${TUI_COMMAND_ALIAS}`))
})

test('installTui() injects the registry instead of probing for it when it can', () => {
  const injections = []
  const ctx = {
    get: () => undefined,
    inject(services, callback) {
      injections.push({ services, callback })
    },
  }
  const collector = logCollector()
  const registry = recordingRegistry()
  const dispose = installTui(ctx, { log: collector.log })

  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].services, ['commands'], 'the service is named once, as a list')
  assert.deepEqual(registry.registered, [], 'the registry may activate later; nothing is registered yet')

  injections[0].callback({ commands: registry })
  assert.deepEqual(registry.registered.map((definition) => definition.name), [TUI_COMMAND_NAME, TUI_COMMAND_ALIAS])

  dispose()
  assert.deepEqual(registry.disposed, [TUI_COMMAND_NAME, TUI_COMMAND_ALIAS])

  // A registry that activates after the row unloaded must not resurrect the
  // command; the closed flag is what makes dispose final.
  const late = recordingRegistry()
  injections[0].callback({ commands: late })
  assert.deepEqual(late.registered, [])
})

test('a registered command resolves the relay through an injected fetch and names it', async () => {
  const origin = 'http://127.0.0.1:9'
  /** @type {string[]} */
  const requests = []

  /* A plain fetch stand-in: it inspects the URL and the method, and every answer
     is a JSON body. No mock library, no timers, no sockets. */
  function fetchImpl(url, init = {}) {
    const address = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${address}`)
    const answer = (body) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (address === `${origin}/__openrouter-plus/health`) return Promise.resolve(answer({ ok: true }))
    if (address === `${origin}/__openrouter-plus/status`) {
      return Promise.resolve(
        answer({
          ok: true,
          bound: true,
          version: '0.9.0',
          uptimeMs: 5_000,
          upstream: 'https://openrouter.ai/api/v1',
          address: { host: '127.0.0.1', port: 9, origin },
          metrics: { todayUsd: 0, costUsd: 0, requests: 0, errors: 0 },
        }),
      )
    }
    if (address.startsWith(`${origin}/__openrouter-plus/tier`)) {
      return Promise.resolve(
        answer({ ok: true, session: 'sess-1', preset: 'standard', chosen: null, default: 'standard' }),
      )
    }
    if (address.startsWith(`${origin}/__openrouter-plus/precision`)) {
      return Promise.resolve(
        answer({
          ok: true,
          session: 'sess-1',
          precision: { floor: 'any' },
          inherited: true,
          source: 'default',
          default: { floor: 'any' },
        }),
      )
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => null, text: async () => '' })
  }

  const registry = recordingRegistry()
  installTui(probingContext(registry), {
    ownOrigin: () => origin,
    fetchImpl,
    log: () => {},
  })

  const definition = registry.registered.find((entry) => entry.name === TUI_COMMAND_NAME)
  assert.ok(definition, 'the primary command is registered')

  const result = await definition.handler({ rawInput: '', agent: { id: 'sess-1', session: { id: 'sess-1' } } })

  assert.equal(result.kind, 'success', result.text)
  // Naming the relay is the point of the status block: two profiles are two
  // relays, and a switch written into the wrong one looks like it worked.
  assert.ok(result.text.includes(origin), `the status block must name ${origin}:\n${result.text}`)
  assert.ok(result.text.includes('standard (inherited from the profile default)'))
  assert.equal(requests[0], `GET ${origin}/__openrouter-plus/health`, 'the origin is probed before it is used')
  assert.ok(requests.includes(`GET ${origin}/__openrouter-plus/status`))
  assert.ok(
    requests.some((entry) => entry.startsWith(`GET ${origin}/__openrouter-plus/tier?session=sess-1`)),
    `the Session is passed to the tier read:\n${requests.join('\n')}`,
  )
})
