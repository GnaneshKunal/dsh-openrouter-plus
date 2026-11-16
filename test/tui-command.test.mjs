/**
 * The slash command as data: parsing, dispatch, and the exact sentences.
 *
 * Two layers are asserted here and nowhere else. Dispatch is checked against a
 * recording control client, so a verb cannot quietly call the wrong route, skip
 * the key a write needs, or write without a Session. The formatters are checked
 * against hand-written answers shaped like the control API's, because in a
 * terminal the transcript *is* the interface: a wording change is a behaviour
 * change, and a fixture is how it stays reviewable.
 *
 * There is no network here. Every client is the recorder below and every answer
 * is an object literal copied from what the Host really sends.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ControlRejected, ControlUnavailable } from '../lib/control-client.js'
import {
  TUI_LINE_WIDTH,
  formatHelp,
  formatPrecisionCatalog,
  formatPresetCatalog,
  formatProviders,
  formatRouteResult,
  formatRoutes,
  formatSpend,
  formatStatus,
  formatUserTracking,
  parseInvocation,
  runTuiCommand,
} from '../lib/tui-command.js'

const SESSION = 'sess-1'
const RELAY = 'http://127.0.0.1:8791'
const UPSTREAM = 'https://openrouter.ai/api/v1'

/** `/status`: the identity, the address that answered, and a usage snapshot. */
const STATUS = {
  ok: true,
  bound: true,
  version: '0.9.0',
  uptimeMs: 373_000,
  upstream: UPSTREAM,
  address: { host: '127.0.0.1', port: 8791, origin: RELAY },
  metrics: { todayUsd: 1.2345, costUsd: 12.5, requests: 142, errors: 3 },
}

/** `/status` with the full retained window `spend` reads. */
const SPEND_STATUS = {
  ...STATUS,
  metrics: {
    todayUsd: 1.25,
    costUsd: 12.5,
    requests: 142,
    errors: 3,
    promptTokens: 1_234_567,
    completionTokens: 345_678,
    days: ['2026-11-14', '2026-11-15', '2026-11-16'],
    effectiveMultiplier: 0.55,
    byTier: {
      flex: { requests: 120, costUsd: 9.5 },
      priority: { requests: 4, costUsd: 2.5 },
      unset: { requests: 2, costUsd: 0.5 },
      standard: { requests: 16, costUsd: 0.25 },
      cheapest: { requests: 2, costUsd: 0.1 },
      ultra: { requests: 1, costUsd: 0.05 },
    },
  },
}

/** `GET /tier?session=…`: the preset in force, where it came from, and the profile default. */
const TIER = {
  ok: true,
  session: SESSION,
  preset: 'flex',
  wire: { serviceTier: 'flex', sort: null, variant: null },
  chosen: 'flex',
  default: 'standard',
  presets: ['none', 'standard', 'fastest', 'fastest-standard', 'cheapest', 'flex', 'priority', 'ultra', 'floor'],
}

/** `GET /precision?session=…`: the floor, its origin, and the profile default. */
const PRECISION = {
  ok: true,
  session: SESSION,
  precision: {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  },
  inherited: false,
  source: 'session',
  default: { floor: 'any', includeUnknown: false, allow: null },
  floors: ['any', 'no-four-bit', 'eight-bit-up', 'full-width'],
}

/**
 * `/targets` as the Host answers it.
 *
 * The real answer also carries `tier.presets` (the preset a new Session
 * inherits); this fixture leaves that hint out so the rendered block is the row
 * list alone. The hint has its own formatter test below.
 */
const TARGETS = {
  ok: true,
  available: true,
  sources: [{ key: 'openrouter', baseURL: `${RELAY}/t/primary/v1`, modelCount: 42 }],
  created: [
    { name: 'OpenRouter Plus', tier: '', baseURL: `${RELAY}/t/primary/v1`, modelCount: 42, missingReasoning: 0 },
    { name: 'openrouter-flex', tier: 'flex', baseURL: `${RELAY}/t/flex/v1`, modelCount: 7, missingReasoning: 2 },
  ],
  custom: [
    { id: 'primary', upstream: UPSTREAM, tier: null, baseURL: `${RELAY}/t/primary/v1`, route: 'OpenRouter Plus' },
  ],
}

/** `POST /precision` after a clear: the effective floor is the profile default. */
const CLEARED_PRECISION = {
  ok: true,
  session: SESSION,
  precision: { floor: 'any' },
  inherited: true,
  source: 'default',
  default: { floor: 'any' },
}

/** The user-tracking answer, envelope and all, as `GET`/`POST` send it. */
/** `/providers`: three endpoints of one model, one of them not routable. */
const ENDPOINTS = {
  ok: true,
  model: 'deepseek/deepseek-v3.2',
  cached: false,
  groups: [
    { id: 'standard', tags: ['deepinfra/fp8', 'together/fp8'] },
    { id: 'flex', tags: ['fireworks/fp8/flex'] },
    { id: 'priority', tags: ['baseten/fast'] },
    { id: 'unavailable', tags: ['bad/endpoint'] },
  ],
  providers: [
    {
      tag: 'deepinfra/fp8',
      tier: 'standard',
      precision: 'fp8',
      inputPrice: 0.3,
      outputPrice: 1.2,
      throughput: { p50: 142, p90: 190 },
      latency: { p50: 310, p90: 520 },
      uptime1d: 99.81,
      available: true,
      group: 'standard',
    },
    {
      tag: 'together/fp8',
      tier: 'standard',
      precision: 'fp8',
      inputPrice: 0.25,
      outputPrice: 1,
      throughput: { p50: 88, p90: null },
      latency: { p50: 420, p90: null },
      uptime1d: 98.2,
      available: true,
      group: 'standard',
    },
    {
      tag: 'fireworks/fp8/flex',
      tier: 'flex',
      precision: null,
      inputPrice: 0,
      outputPrice: 0.6,
      throughput: null,
      latency: null,
      uptime1d: null,
      available: true,
      group: 'flex',
    },
    {
      // A priority row whose slug says "fast": the tag alone does not name the lane,
      // which is why the table carries one.
      tag: 'baseten/fast',
      tier: 'priority',
      precision: 'unknown',
      inputPrice: 0.6,
      outputPrice: 2.4,
      throughput: { p50: 419, p90: 85 },
      latency: { p50: 331, p90: 2102 },
      uptime1d: 100,
      available: true,
      group: 'priority',
    },
    {
      tag: 'bad/endpoint',
      tier: 'standard',
      precision: 'unknown',
      inputPrice: 2.5,
      outputPrice: 9,
      throughput: { p50: 10, p90: 12 },
      latency: { p50: 900, p90: 900 },
      uptime1d: 41,
      available: false,
      group: 'unavailable',
    },
  ],
}

const USER_TRACKING = { ok: true, userTracking: { enabled: true, id: 'user_2f8c1d' } }

/** Every route the command may call, with an answer shaped like the Host's. */
const ROUTES = {
  'GET /status': STATUS,
  'GET /tier': TIER,
  'GET /precision': PRECISION,
  'GET /targets': TARGETS,
  'GET /user-tracking': USER_TRACKING,
  'POST /tier': { ok: true, session: SESSION, preset: 'flex', chosen: 'flex', default: 'standard' },
  'POST /tier/default': { ok: true, default: 'flex' },
  'POST /precision': {
    ok: true,
    session: SESSION,
    precision: { floor: 'eight-bit-up' },
    inherited: false,
    source: 'session',
    default: { floor: 'any' },
  },
  'POST /precision/default': { ok: true, default: { floor: 'any' } },
  'POST /routes/attach': { ok: true, route: 'openrouter', baseURL: `${RELAY}/t/primary/v1`, changed: true },
  'POST /routes/detach': { ok: true, route: 'openrouter', baseURL: UPSTREAM, changed: true },
  'POST /routes/repair': { ok: true, patched: ['openrouter'] },
  'POST /user-tracking': USER_TRACKING,
}

/**
 * @param {Record<string, unknown>} [overrides] answers that a case needs changed
 * @returns {Record<string, unknown>}
 */
function controlRoutes(overrides = {}) {
  return { ...ROUTES, ...overrides }
}

/**
 * A control client that answers from a route table and records every call.
 *
 * Keys are `'GET /tier'`; a value is the payload to answer with, a function of
 * the call, or an `Error` instance to throw — the last one is how both failure
 * paths are exercised without a socket. The payload is the query for a GET and
 * the body for a POST, and is omitted when the caller sent neither, so a whole
 * call list reads as one `deepEqual`.
 *
 * @param {Record<string, unknown>} routes
 */
function recorder(routes) {
  /** @type {Array<{ method: string, path: string, payload?: unknown }>} */
  const calls = []

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {unknown} payload
   */
  const answer = async (method, path, payload) => {
    /** @type {{ method: string, path: string, payload?: unknown }} */
    const call = { method, path }
    if (payload !== undefined) call.payload = payload
    calls.push(call)
    const key = `${method} ${path}`
    if (!Object.hasOwn(routes, key)) throw new Error(`unexpected control call: ${key}`)
    const entry = routes[key]
    const value = typeof entry === 'function' ? await entry(call) : entry
    if (value instanceof Error) throw value
    return value
  }

  return {
    calls,
    client: {
      get: (path, query) => answer('GET', path, query),
      post: (path, body) => answer('POST', path, body),
    },
  }
}

/**
 * Run one line with a recorder, returning the result and what it called.
 *
 * The Session defaults to a real one because that is the only way the
 * Session-scoped writes are exercised; the cases that prove they need one pass
 * `''` on purpose.
 *
 * @param {string} rawInput
 * @param {{ sessionId?: string, routes?: Record<string, unknown>, client?: any }} [options]
 */
async function dispatch(rawInput, options = {}) {
  const control = recorder(options.routes ?? controlRoutes())
  const invalidations = []
  const result = await runTuiCommand({
    rawInput,
    sessionId: options.sessionId ?? SESSION,
    client: options.client ?? control.client,
    invalidateOrigin: () => invalidations.push(1),
    log: () => {},
  })
  return { result, calls: control.calls, invalidations }
}

/**
 * A success whose text is printable at all: no colour, and no `undefined`
 * where a missing field should have been a dash.
 *
 * @param {{ kind: string, text: string }} result
 * @returns {string}
 */
function succeeded(result) {
  assert.equal(result.kind, 'success', `expected a success, got: ${result.text}`)
  assert.equal(typeof result.text, 'string')
  assert.doesNotMatch(result.text, /\u001b/, 'the TUI owns colour; a command never emits an escape code')
  assert.doesNotMatch(result.text, /\bundefined\b/, 'a missing answer must read as a dash, never as undefined')
  return result.text
}

/**
 * The same, plus the module's own width contract. A wrapped line in a prompt is
 * a line nobody reads twice, which is why this is asserted on every success.
 *
 * @param {{ kind: string, text: string }} result
 * @returns {string}
 */
function printed(result) {
  const value = succeeded(result)
  for (const line of value.split('\n')) {
    assert.ok(
      line.length <= TUI_LINE_WIDTH,
      `a line is ${line.length} columns, over the ${TUI_LINE_WIDTH}-column contract: ${JSON.stringify(line)}`,
    )
  }
  return value
}

/**
 * @param {string} text
 * @param {number} width
 */
function assertWidth(text, width = TUI_LINE_WIDTH) {
  for (const line of text.split('\n')) {
    assert.ok(line.length <= width, `a line is ${line.length} columns: ${JSON.stringify(line)}`)
  }
}

test('parseInvocation() reads an empty remainder as no verb at all', () => {
  assert.deepEqual(parseInvocation(''), { verb: '', args: [] })
  assert.deepEqual(parseInvocation('   '), { verb: '', args: [] })
  // A handler can be invoked with no input object; that is still "nothing typed".
  assert.deepEqual(parseInvocation(undefined), { verb: '', args: [] })
})

test('parseInvocation() splits on runs of whitespace and never yields an empty argument', () => {
  assert.deepEqual(parseInvocation('  preset   flex  '), { verb: 'preset', args: ['flex'] })
  assert.deepEqual(parseInvocation('\tpreset\n\nflex   standard '), { verb: 'preset', args: ['flex', 'standard'] })
  // The separating space is part of what the composer hands over, so a trailing
  // one must not become an argument that a verb reads as a value.
  assert.deepEqual(parseInvocation('preset '), { verb: 'preset', args: [] })
})

test('parseInvocation() lowercases the verb and leaves every argument as typed', () => {
  assert.deepEqual(parseInvocation('PRESET'), { verb: 'preset', args: [] })
  assert.deepEqual(parseInvocation('Precision Eight-Bit-Up'), { verb: 'precision', args: ['Eight-Bit-Up'] })
  // A provider key is case-sensitive on the profile, so the case folding must
  // stop at the verb.
  assert.deepEqual(parseInvocation('route OpenRouter'), { verb: 'route', args: ['OpenRouter'] })
})

/**
 * One row per verb: the exact calls it may make, and a fragment of the sentence
 * it answers with. `width: false` marks a confirmation that is known to be
 * wider than 80 columns today; that finding is reported with this change.
 */
const DISPATCH = [
  {
    name: 'a bare invocation reads the relay, the Session preset and the precision floor',
    rawInput: '',
    calls: [
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/tier', payload: { session: SESSION } },
      { method: 'GET', path: '/precision', payload: { session: SESSION } },
    ],
    includes: [
      'OpenRouter Plus 0.9.0',
      RELAY,
      'flex (chosen for this Session)',
      'eight-bit-up (chosen for this Session)',
    ],
  },
  {
    name: '`status` asks the same three questions as a bare invocation',
    rawInput: 'status',
    calls: [
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/tier', payload: { session: SESSION } },
      { method: 'GET', path: '/precision', payload: { session: SESSION } },
    ],
    includes: ['$1.23 today · $12.50 retained · 142 requests'],
  },
  {
    name: '`preset` alone reads the catalogue and writes nothing',
    rawInput: 'preset',
    calls: [{ method: 'GET', path: '/tier', payload: { session: SESSION } }],
    includes: ['Presets a Session may pick', 'current   flex (chosen for this Session)', 'default   standard'],
  },
  {
    name: '`preset flex` writes the preset for this Session',
    rawInput: 'preset flex',
    calls: [{ method: 'POST', path: '/tier', payload: { session: SESSION, preset: 'flex' } }],
    includes: ['This Session now runs on «flex»'],
  },
  {
    name: '`preset default flex` writes the profile default without needing a Session',
    rawInput: 'preset default flex',
    sessionId: '',
    calls: [{ method: 'POST', path: '/tier/default', payload: { preset: 'flex' } }],
    includes: ['Profile default preset is flex', 'a new Session inherits it'],
  },
  {
    name: '`preset clear` hands this Session back to the profile default',
    rawInput: 'preset clear',
    calls: [{ method: 'POST', path: '/tier', payload: { session: SESSION, preset: null } }],
    includes: ['This Session\'s preset is cleared', 'inherits standard'],
  },
  {
    name: '`precision` alone reads the floors and writes nothing',
    rawInput: 'precision',
    calls: [{ method: 'GET', path: '/precision', payload: { session: SESSION } }],
    includes: ['Precision floors', 'current   eight-bit-up (chosen for this Session)'],
  },
  {
    name: '`precision eight-bit-up` writes the floor for this Session',
    rawInput: 'precision eight-bit-up',
    calls: [{ method: 'POST', path: '/precision', payload: { session: SESSION, precision: 'eight-bit-up' } }],
    includes: ['This Session\'s precision floor is eight-bit-up'],
  },
  {
    name: '`precision default any` writes the profile floor without needing a Session',
    rawInput: 'precision default any',
    sessionId: '',
    calls: [{ method: 'POST', path: '/precision/default', payload: { precision: 'any' } }],
    includes: ['Profile default floor is any'],
  },
  {
    name: '`precision clear` hands this Session back to the profile floor',
    rawInput: 'precision clear',
    calls: [{ method: 'POST', path: '/precision', payload: { session: SESSION, precision: null } }],
    routes: controlRoutes({ 'POST /precision': CLEARED_PRECISION }),
    includes: ['This Session\'s floor is cleared', 'inherits any'],
  },
  {
    name: '`routes` reads the provider table and the registered targets',
    rawInput: 'routes',
    calls: [{ method: 'GET', path: '/targets' }],
    includes: [
      'Provider rows through the relay (2):',
      'per-Session preset',
      'pinned flex',
      'Targets registered (1):',
      'row: OpenRouter Plus',
    ],
  },
  {
    name: '`route openrouter` points one provider row at the relay',
    rawInput: 'route openrouter',
    calls: [{ method: 'POST', path: '/routes/attach', payload: { route: 'openrouter' } }],
    includes: ['openrouter now routes through the relay', `${RELAY}/t/primary/v1`],
  },
  {
    name: '`unroute openrouter` restores the endpoint that row had before',
    rawInput: 'unroute openrouter',
    calls: [{ method: 'POST', path: '/routes/detach', payload: { route: 'openrouter' } }],
    includes: ['openrouter is back on its own endpoint', UPSTREAM],
  },
  {
    name: '`spend` reads the relay status snapshot',
    rawInput: 'spend',
    calls: [{ method: 'GET', path: '/status' }],
    routes: controlRoutes({ 'GET /status': SPEND_STATUS }),
    includes: ['over 3 days', '142 (3 errors)', 'by preset', '×0.55 of list price'],
  },
  {
    name: '`user` reads the tracking switch without writing it',
    rawInput: 'user',
    calls: [{ method: 'GET', path: '/user-tracking' }],
    includes: ['User tracking on', 'user_2f8c1d', 'Turn off: /openrouter-plus user off'],
  },
  {
    name: '`user on` writes the tracking switch on',
    rawInput: 'user on',
    calls: [{ method: 'POST', path: '/user-tracking', payload: { enabled: true } }],
    includes: ['User tracking on', 'user_2f8c1d'],
  },
  {
    name: '`user off` writes the tracking switch off',
    rawInput: 'user off',
    calls: [{ method: 'POST', path: '/user-tracking', payload: { enabled: false } }],
    includes: ['User tracking off', 'The stored one is kept'],
  },
  {
    name: '`repair` refills the reasoning efforts a relay route is missing',
    rawInput: 'repair',
    calls: [{ method: 'POST', path: '/routes/repair', payload: {} }],
    includes: ['Added reasoning efforts to 1 route: openrouter'],
  },
]

for (const verb of DISPATCH) {
  test(verb.name, async () => {
    const { result, calls, invalidations } = await dispatch(verb.rawInput, {
      sessionId: verb.sessionId,
      routes: verb.routes,
    })
    assert.deepEqual(calls, verb.calls)
    assert.deepEqual(invalidations, [], 'a successful call must not drop the cached origin')
    const text = printed(result)
    for (const fragment of verb.includes ?? []) {
      assert.ok(text.includes(fragment), `expected ${JSON.stringify(fragment)} in:\n${text}`)
    }
  })
}

test('`providers` answers with price, speed and uptime per endpoint', async () => {
  const { result, calls } = await dispatch('providers deepseek/deepseek-v3.2', {
    routes: controlRoutes({ 'GET /providers': ENDPOINTS }),
  })
  assert.deepEqual(calls, [
    { method: 'GET', path: '/providers', payload: { model: 'deepseek/deepseek-v3.2' } },
  ])
  const text = printed(result)
  // The facts a routing choice is made with, in the order the table promises them.
  for (const fragment of [
    'deepseek/deepseek-v3.2: 5 endpoints',
    'lane',
    'in',
    'out',
    'tok/s',
    '0.300',
    '1.20',
    '142/190',
    '310/520',
    '99.8',
    'standard 2 · flex 1 · priority 1 · unavailable 1',
  ]) {
    assert.ok(text.includes(fragment), `expected ${JSON.stringify(fragment)} in:
${text}`)
  }
  // A listing that omits a fact must not print a zero for it: "0 tok/s" is a
  // claim, and the endpoint simply did not report.
  const unnoticed = text.split('\n').find((line) => line.includes('fireworks/fp8/flex'))
  assert.ok(unnoticed !== undefined)
  assert.ok(!/\b0\b/.test(unnoticed.replace('0.120', '').replace('0.600', '')), 'no invented zeros')
  assert.ok(unnoticed.includes('free'), 'a zero price is free, not a blank')
  // The lane a row belongs to, for the endpoints whose slug does not say it.
  assert.ok(text.includes('std'), 'a standard row says so')
  assert.ok(text.includes('prio'), 'and so does a priority row with an invented slug')
  // The endpoint OpenRouter will not route to is marked, not hidden.
  assert.ok(text.includes('bad/endpoint'))
  assert.ok(text.includes('!'))
  assertWidth(text)
})

test('`providers` remembers the model this Session routed last', async () => {
  const { result, calls } = await dispatch('providers', {
    routes: controlRoutes({
      'GET /status': {
        ...STATUS,
        metrics: {
          ...STATUS.metrics,
          recent: [
            { at: 3, sessionId: 'another-session', model: 'x/y' },
            { at: 2, sessionId: SESSION, model: 'deepseek/deepseek-v3.2' },
            { at: 1, sessionId: SESSION, model: 'older/model' },
          ],
        },
      },
      'GET /providers': ENDPOINTS,
    }),
  })
  // Newest first, and matched on this Session: the other session's row is skipped.
  assert.deepEqual(calls[1], { method: 'GET', path: '/providers', payload: { model: 'deepseek/deepseek-v3.2' } })
  assert.ok(printed(result).includes("this Session's last model"))
})

test('`providers` with nothing to go on asks for a model instead of guessing', async () => {
  const { result, calls } = await dispatch('providers', {
    routes: controlRoutes({ 'GET /status': STATUS }),
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /providers <author\/slug>/)
  assert.deepEqual(calls, [{ method: 'GET', path: '/status' }])
})

test('`providers` refuses an id that cannot be an OpenRouter model, without asking', async () => {
  const { result, calls } = await dispatch('providers gpt', { routes: controlRoutes() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /author\/slug/)
  assert.deepEqual(calls, [], 'a malformed id is answered from the text alone')
})

test('`providers` reports an empty listing with the reason the upstream gave', () => {
  const text = printed({
    kind: 'success',
    text: formatProviders({
      answer: { model: 'x/y', providers: [], groups: [], error: 'the upstream answered 502' },
    }),
  })
  assert.ok(text.includes('No endpoint listing for x/y.'))
  assert.ok(text.replace(/\s+/g, ' ').includes('the upstream answered 502'))
  assertWidth(text)
})

test('`models` and `help` answer from text and never reach the relay', async () => {
  for (const rawInput of ['models', 'help']) {
    const { result, calls } = await dispatch(rawInput, { routes: {} })
    assert.deepEqual(calls, [], `${rawInput} has nothing to ask the relay`)
    const text = printed(result)
    assert.ok(text.length > 0)
  }
})

test('an unknown verb is refused with a pointer to help', async () => {
  const { result, calls } = await dispatch('nope', { routes: {} })
  assert.equal(result.kind, 'error')
  assert.deepEqual(calls, [], 'a typo never reaches the relay')
  assert.match(result.text, /help/)
  assert.match(result.text, /"nope"/)
})

test('`route` with no provider names the argument it needs', async () => {
  const { result, calls } = await dispatch('route', { routes: {} })
  assert.equal(result.kind, 'error')
  assert.deepEqual(calls, [])
  assert.match(result.text, /route <provider>/)
  assert.match(result.text, /routes/)
})

test('`user maybe` is refused without a write', async () => {
  const { result, calls } = await dispatch('user maybe', { routes: {} })
  assert.equal(result.kind, 'error')
  assert.deepEqual(calls, [])
  assert.match(result.text, /user on or off/)
})

test('a refused call becomes the refusal sentence and keeps the cached origin', async () => {
  const refusal = new ControlRejected('unknown preset "turbo"; use one of none, standard, flex', {
    status: 400,
    path: '/tier',
  })
  const { result, calls, invalidations } = await dispatch('preset turbo', {
    routes: controlRoutes({ 'POST /tier': refusal }),
  })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, refusal.message, 'the API sentence is the transcript, not "HTTP 400"')
  assert.deepEqual(calls, [{ method: 'POST', path: '/tier', payload: { session: SESSION, preset: 'turbo' } }])
  // A 400 says the argument was wrong, not that the address moved: dropping the
  // cached origin for it would cost a probe sweep per typo.
  assert.deepEqual(invalidations, [], 'a refusal says nothing about the cached origin')
})

test('an unreachable relay becomes its sentence instead of a thrown handler', async () => {
  const fault = new ControlUnavailable(
    'OpenRouter Plus could not reach its relay at http://127.0.0.1:8791. Is the plugin still running?',
  )
  const { result, calls, invalidations } = await dispatch('', {
    routes: controlRoutes({ 'GET /status': fault }),
  })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, fault.message)
  assert.equal(calls[0].path, '/status', 'the failure is the call that was attempted')
  assert.equal(invalidations.length, 1)
})

test('a client missing either verb is refused, not crashed into', async () => {
  const clients = [{}, { get: async () => ({}) }, { post: async () => ({}) }, null]
  for (const client of clients) {
    const result = await runTuiCommand({ rawInput: 'status', sessionId: SESSION, client })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /control client/)
  }
})

test('a Session-scoped write is refused before any control call when there is no Session', async () => {
  for (const rawInput of ['preset flex', 'precision any', 'precision clear']) {
    const verb = rawInput.split(' ')[0]
    const { result, calls } = await dispatch(rawInput, { sessionId: '', routes: {} })
    assert.equal(result.kind, 'error', rawInput)
    assert.deepEqual(calls, [], `${rawInput} must not write without a Session`)
    assert.match(result.text, /not running in one/)
    assertWidth(result.text)
    assert.ok(result.text.includes(`/openrouter-plus ${verb} default <id>`), 'the refusal offers the profile write')
  }
})

test('`preset clear` without a Session is refused like every other Session write', async () => {
    const { result, calls } = await dispatch('preset clear', { sessionId: '', routes: {} })
    assert.equal(result.kind, 'error')
    assert.deepEqual(calls, [], 'a write with an empty Session must not reach the relay')
    assertWidth(result.text)
  },
)

test('reads and profile writes still work from a palette with no Session', async () => {
  const preset = await dispatch('preset', { sessionId: '' })
  assert.deepEqual(preset.calls, [{ method: 'GET', path: '/tier', payload: { session: '' } }])
  printed(preset.result)

  const presetDefault = await dispatch('preset default flex', { sessionId: '' })
  assert.deepEqual(presetDefault.calls, [{ method: 'POST', path: '/tier/default', payload: { preset: 'flex' } }])
  printed(presetDefault.result)

  const precision = await dispatch('precision', { sessionId: '' })
  assert.deepEqual(precision.calls, [{ method: 'GET', path: '/precision', payload: { session: '' } }])
  printed(precision.result)

  const precisionDefault = await dispatch('precision default any', { sessionId: '' })
  assert.deepEqual(precisionDefault.calls, [
    { method: 'POST', path: '/precision/default', payload: { precision: 'any' } },
  ])
  printed(precisionDefault.result)
})

test('the command fits the 80-column transcript for every verb', async () => {
    const rawInputs = [
      '',
      'status',
      'preset',
      'preset flex',
      'preset default flex',
      'preset clear',
      'precision',
      'precision eight-bit-up',
      'precision default any',
      'precision clear',
      'routes',
      'route openrouter',
      'unroute openrouter',
      'spend',
      'user',
      'user on',
      'user off',
      'repair',
      'providers deepseek/deepseek-v3.2',
      'models',
      'help',
    ]
    /** @type {string[]} */
    const over = []
    for (const rawInput of rawInputs) {
      // The width sweep has to answer `precision clear` the way the Host does,
      // or the stale fixture (a floor still named eight-bit-up) invents a long line.
      const routes =
        rawInput === 'precision clear'
          ? controlRoutes({ 'POST /precision': CLEARED_PRECISION })
          : rawInput.startsWith('providers')
            ? controlRoutes({ 'GET /providers': ENDPOINTS })
            : undefined
      const { result } = await dispatch(rawInput, { routes })
      if (result.kind !== 'success') {
        over.push(`${JSON.stringify(rawInput)}: ${result.kind}`)
        continue
      }
      for (const line of result.text.split('\n')) {
        if (line.length > TUI_LINE_WIDTH) over.push(`${JSON.stringify(rawInput)}: ${line.length} columns: ${line}`)
      }
    }
    assert.deepEqual(over, [])
  },
)

test('formatStatus() names the relay, both preferences and the spend in one block', () => {
  const text = formatStatus({ status: STATUS, tier: TIER, precision: PRECISION, sessionId: SESSION })
  const lines = text.split('\n')
  assert.equal(lines[0], `OpenRouter Plus 0.9.0 · up 6m 13s · ${RELAY}`)
  assert.equal(lines[1], `upstream   ${UPSTREAM}`)
  assert.ok(text.includes('preset     flex (chosen for this Session)'))
  assert.ok(text.includes('precision  eight-bit-up (chosen for this Session)'))
  assert.ok(text.includes('spend      $1.23 today · $12.50 retained · 142 requests'))
  assert.ok(text.includes('Switch this Session: /openrouter-plus preset flex'))
  assertWidth(text)
})

test('formatStatus() says the relay is not listening rather than naming an address', () => {
  const text = formatStatus({ status: { ...STATUS, bound: false }, tier: {}, precision: {} })
  assert.equal(text.split('\n')[0], 'OpenRouter Plus 0.9.0 · relay is not listening')
  assertWidth(text)
})

test('formatStatus() prints the relay error on its own line and never the word undefined', () => {
  const text = formatStatus({
    status: { ...STATUS, bound: false, error: 'listen EADDRINUSE: address already in use 127.0.0.1:8791' },
    tier: {},
    precision: {},
  })
  assert.ok(text.includes('relay      listen EADDRINUSE: address already in use 127.0.0.1:8791'))
  assert.doesNotMatch(text, /\bundefined\b/)
  assertWidth(text)
})

test('formatStatus() prints a dash, not an invented default, when no Session answered', () => {
  const text = formatStatus({ status: STATUS, tier: {}, precision: {} })
  assert.ok(text.includes('preset     -'))
  assert.ok(text.includes('precision  -'))
  assert.doesNotMatch(text, /\bundefined\b/)
  assertWidth(text)
})

test('formatPresetCatalog() marks a Session choice as chosen and a missing one as inherited', () => {
  const chosen = formatPresetCatalog({ tier: { preset: 'flex', chosen: 'flex', default: 'standard' } })
  assert.ok(chosen.includes('current   flex (chosen for this Session)'))
  assert.ok(chosen.includes('default   standard (what a new Session inherits)'))
  assert.ok(chosen.includes('Set:      /openrouter-plus preset flex'))
  assert.ok(chosen.includes('Profile:  /openrouter-plus preset default flex'))
  assertWidth(chosen)

  const inherited = formatPresetCatalog({ tier: { preset: 'standard', chosen: null, default: 'standard' } })
  assert.ok(inherited.includes('current   standard (inherited from the profile default)'))
  // The catalogue is the one read that works from a palette with no conversation
  // open, so its current line must still say where the value came from.
  assert.doesNotMatch(inherited, /chosen for this Session/)
  assertWidth(inherited)
})

test('formatPrecisionCatalog() marks the floor by its origin, not by its value', () => {
  const chosen = formatPrecisionCatalog({ precision: PRECISION })
  assert.ok(chosen.includes('current   eight-bit-up (chosen for this Session)'))
  assert.ok(chosen.includes('Clear:    /openrouter-plus precision clear'))
  assertWidth(chosen)

  const inherited = formatPrecisionCatalog({
    precision: {
      precision: { floor: 'full-width' },
      inherited: true,
      source: 'default',
      default: { floor: 'full-width' },
    },
  })
  assert.ok(inherited.includes('current   full-width (inherited from the profile default)'))
  assertWidth(inherited)

  // `source` alone is enough: an answer that omits `inherited` still reads as
  // inherited when it says the floor came from the default.
  const bySource = formatPrecisionCatalog({
    precision: { precision: { floor: 'any' }, source: 'default', default: { floor: 'any' } },
  })
  assert.ok(bySource.includes('current   any (inherited from the profile default)'))
})

test('formatSpend() reports today, the retained window and the traffic by preset', () => {
  const text = formatSpend({ status: SPEND_STATUS })
  assert.ok(text.includes('spend      $1.25 today · $12.50 over 3 days'))
  assert.ok(text.includes('requests   142 (3 errors) · tokens 1.2M in / 345.7k out'))
  assert.ok(text.includes('effective  ×0.55 of list price'))
  assert.ok(text.includes('flex $9.50 (120)'))
  assert.ok(text.includes('priority $2.50 (4)'))
  assert.ok(text.includes('none $0.5000 (2)'), 'the `unset` bucket reads as none, not as a preset id')

  // Six buckets cannot all be printed, so the marker has to account for every
  // row that was left out; otherwise the breakdown silently loses traffic.
  const marker = text.match(/\+(\d+) more/)
  assert.ok(marker, `expected a "+N more" marker in:\n${text}`)
  const shown = ['flex', 'priority', 'none', 'standard', 'cheapest', 'ultra'].filter((name) =>
    text.includes(`${name} $`),
  ).length
  assert.equal(shown + Number(marker[1]), 6)
  assertWidth(text)
})

test('formatRoutes() with no rows points at the command that creates one', () => {
  const text = formatRoutes({ available: true, created: [], custom: [] })
  assert.equal(text.split('\n')[0], 'No provider row points at this relay yet.')
  assert.ok(text.includes('Route one: /openrouter-plus route <provider>'))
  assertWidth(text)
})

test('formatRoutes() lists each row with its model count and its preset scope', () => {
  const text = formatRoutes(TARGETS)
  assert.ok(text.includes('Provider rows through the relay (2):'))
  assert.ok(text.includes('OpenRouter Plus  42 models   per-Session preset'))
  assert.ok(text.includes('openrouter-flex  7 models    pinned flex'))
  assert.ok(text.includes('Detach: /openrouter-plus unroute <provider>'))
  assert.ok(text.includes('Targets registered (1):'))
  assert.ok(text.includes('primary → https://openrouter.ai/api/v1 (row: OpenRouter Plus)'))
  assertWidth(text)
})

test('formatRoutes() reports why the provider table is unreadable, and keeps the rows that are readable', () => {
  const reason =
    'configEditor is not available in this Host; create routes by editing the llm-pi-ai providers manually'
  const text = formatRoutes({
    available: false,
    reason,
    created: [],
    custom: [{ id: 'primary', upstream: 'https://openrouter.ai/api/v1', route: 'openrouter' }],
  })
  assert.match(text, /not readable here/)
  // The reason is a sentence, not a column: it wraps, so compare on the words.
  assert.ok(
    text.replace(/\s+/g, ' ').includes(reason),
    'a withheld table without its reason looks like an empty profile',
  )
  // The target table is this plugin's own config and is reported in this branch too;
  // hiding it because the *provider* table is unreadable would be the wrong failure.
  assert.ok(text.includes('Targets registered (1):'))
  assert.ok(text.includes('primary → https://openrouter.ai/api/v1 (row: openrouter)'))
  assertWidth(text)
})

test('formatRoutes() names the preset a new Session inherits when the answer carries the table', () => {
  const text = formatRoutes({
    available: true,
    created: [{ name: 'OpenRouter Plus', tier: '', baseURL: `${RELAY}/t/primary/v1`, modelCount: 42 }],
    custom: [],
    tier: { default: 'standard', presets: ['none', 'standard', 'flex'] },
  })
  assert.ok(text.includes('New Sessions inherit the preset «standard».'))
  assert.ok(text.includes('Switch this Session: /openrouter-plus preset <id>'))
  assertWidth(text)
})

test('formatRouteResult() confirms an attach, a no-op attach, a detach and a no-op detach', () => {
  const baseURL = `${RELAY}/t/primary/v1`
  const attach = formatRouteResult({ action: 'attach', answer: { route: 'openrouter', baseURL, changed: true } })
  const applies = 'The preset this Session carries applies to it from the next request.'
  // The mount URL has its own line: a `/t/<id>/<tier>/v1` path would otherwise push
  // the sentence past the transcript margin on a narrow terminal.
  assert.equal(attach, `openrouter now routes through the relay:\n  ${baseURL}\n${applies}`)
  assertWidth(attach)

  const unchangedAttach = formatRouteResult({
    action: 'attach',
    answer: { route: 'openrouter', baseURL, changed: false },
  })
  assert.ok(unchangedAttach.includes('was already routed through the relay:'))
  assert.ok(unchangedAttach.includes(baseURL))
  assertWidth(unchangedAttach)

  const detach = formatRouteResult({
    action: 'detach',
    answer: { route: 'openrouter', baseURL: UPSTREAM, changed: true },
  })
  assert.equal(detach, `openrouter is back on its own endpoint:\n  ${UPSTREAM}`)
  assertWidth(detach)

  const unchangedDetach = formatRouteResult({
    action: 'detach',
    answer: { route: 'openrouter', baseURL: UPSTREAM, changed: false },
  })
  assert.ok(unchangedDetach.includes('was already on its own endpoint'))
  assert.ok(unchangedDetach.includes('nothing changed'))
  assertWidth(unchangedDetach)
})

test('formatUserTracking() reads the switch, turns it on, turns it off and handles a missing id', () => {
  const read = formatUserTracking({ userTracking: { enabled: true, id: 'user_2f8c1d' } })
  assert.ok(read.includes('User tracking on — every request carries user_2f8c1d.'))
  assert.ok(read.includes('Turn off: /openrouter-plus user off'))

  const off = formatUserTracking({ userTracking: { enabled: false, id: 'user_2f8c1d' } })
  assert.ok(off.includes('User tracking off — no identifier is sent.'))
  assert.ok(off.includes('Turn on:  /openrouter-plus user on'))

  const turnedOn = formatUserTracking({ userTracking: { enabled: true, id: 'user_2f8c1d' }, action: 'on' })
  assert.ok(turnedOn.includes('every request now carries user_2f8c1d'))
  assert.ok(turnedOn.includes('OpenRouter hashes it before forwarding'))
  assertWidth(turnedOn)

  // "On" can be true while the profile minted nothing: saying so is the point of
  // the sentence, because every request would otherwise silently omit the id.
  const noIdentifier = formatUserTracking({ userTracking: { enabled: true, id: '' }, action: 'on' })
  assert.equal(
    noIdentifier,
    'User tracking on, but no identifier was minted; the relay logs a warning and sends nothing.',
  )

  const turnedOff = formatUserTracking({ userTracking: { enabled: false }, action: 'off' })
  assert.ok(turnedOff.includes('The stored one is kept'))
  assertWidth(turnedOff)
})

test('formatHelp() lists every verb the dispatcher understands', () => {
  const help = formatHelp()
  const rows = [
    '/openrouter-plus preset',
    '/openrouter-plus precision',
    '/openrouter-plus routes',
    '/openrouter-plus route <provider>',
    '/openrouter-plus unroute <provider>',
    '/openrouter-plus spend',
    '/openrouter-plus user',
    '/openrouter-plus repair',
    '/openrouter-plus models',
  ]
  for (const row of rows) assert.ok(help.includes(row), `help must mention ${row}`)
  assert.ok(help.includes('/oorp'), 'the alias is discoverable from the help text')
  assertWidth(help)
})
