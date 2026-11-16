/**
 * dsh-openrouter-plus — the terminal outlet.
 *
 * The Host half of this plugin is front-door neutral: a relay plus a control
 * API. The browser half is `client.js`, a React page. A terminal has neither a
 * page nor an `<input>` the plugin can reach, but it does have a command
 * registry — the one seam that is *already* wired in both front doors. So the
 * terminal half is a slash command and nothing else: no framework, no render
 * tree, no second settings store.
 *
 * Why a command rather than a panel or a scene:
 *
 * - It is the only surface whose lifetime the plugin does not own. The TUI
 *   mounts its own screen, and a plugin that registers into it has to survive
 *   scene switches, minimal mode and a backend swap; a registered command is
 *   inert until somebody types it.
 * - It works in the Web palette too, because both front doors resolve
 *   `@deepseek-ai/dsh-commands`. One implementation, two front doors, no
 *   platform flag to maintain.
 * - It degrades by absence. A composition without a command registry — a bare
 *   `cordis.yml` start, a test fixture — simply never registers, and the relay
 *   keeps working exactly as before.
 *
 * The services are probed softly and never injected by the Host half, because
 * the relay must start whether or not a UI exists. `ctx.inject(['commands'])`
 * is used when the context offers it (so a command registry that activates
 * after this plugin still finds the command), and the direct probe is the
 * fallback for contexts that do not (tests, embedded hosts).
 *
 * Plain ESM, Node >= 20 built-ins only.
 */

import { createControlClient } from './control-client.js'
import { createOriginResolver, loopbackOriginsOf, probeRelay } from './control-origin.js'
import { TUI_COMMAND_ALIAS, TUI_COMMAND_NAME, TUI_INPUT_HINT, runTuiCommand } from './tui-command.js'

/**
 * The Session id a command invocation carries, or `''`.
 *
 * `@deepseek-ai/dsh-commands` hands the handler the exact agent the UI
 * dispatched for, and an agent knows its session — that is the key the relay
 * looks a preset up by, so it is the key a write must use.
 *
 * @param {unknown} invocation
 * @returns {string}
 */
export function sessionIdOf(invocation) {
  const agent = /** @type {{ agent?: { sessionId?: unknown } }} */ (invocation ?? {})?.agent
  const id = agent?.sessionId
  return typeof id === 'string' ? id : ''
}

/**
 * The command definitions this plugin registers, as data.
 *
 * Exported separately from {@link installTui} so a test can assert the surface
 * without a context, and so the alias cannot drift from the primary name.
 *
 * @param {{
 *   client: Parameters<typeof runTuiCommand>[0]['client'],
 *   invalidateOrigin?: () => void,
 *   log?: (level: string, message: string, detail?: unknown) => void,
 * }} options
 * @returns {Array<{ name: string, description: string, input: { hint: string }, handler: (invocation: any) => Promise<{ kind: 'success'|'error', text: string }> }>}
 */
export function tuiCommandDefinitions(options) {
  const { client, invalidateOrigin, log } = options
  /**
   * @param {unknown} invocation
   */
  const handler = async (invocation) => {
    const invocationOptions = /** @type {{ rawInput?: unknown, signal?: AbortSignal }} */ (invocation ?? {})
    return runTuiCommand({
      rawInput: invocationOptions.rawInput,
      sessionId: sessionIdOf(invocation),
      client,
      signal: invocationOptions.signal,
      invalidateOrigin,
      log,
    })
  }
  return [
    {
      name: TUI_COMMAND_NAME,
      description:
        'OpenRouter Plus: relay state, the preset this Session runs on, the precision floor, and provider routing',
      input: { hint: TUI_INPUT_HINT },
      handler,
    },
    {
      name: TUI_COMMAND_ALIAS,
      description: `Short alias of /${TUI_COMMAND_NAME}`,
      input: { hint: TUI_INPUT_HINT },
      handler,
    },
  ]
}

/**
 * Mount the terminal outlet.
 *
 * Safe to call in any composition: with no command registry it logs one line
 * and returns a disposer that does nothing, which is what keeps the plugin
 * bootable on a headless Host.
 *
 * @param {any} ctx the plugin's cordis context
 * @param {{
 *   ownOrigin?: () => string | null,
 *   sources?: () => Promise<Iterable<unknown>>,
 *   host?: string,
 *   port?: number,
 *   portFallback?: boolean,
 *   fetchImpl?: typeof globalThis.fetch,
 *   log?: (level: string, message: string, detail?: unknown) => void,
 *   commands?: { register: (definition: object) => (() => void) | void },
 *   cacheMs?: number,
 * }} options
 * @returns {() => void}
 */
export function installTui(ctx, options) {
  const opts = typeof options === 'object' && options !== null ? options : {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const resolver = createOriginResolver({
    // Provider rows are read per resolution, not once: a row can be attached,
    // detached or re-pointed while this process keeps running.
    candidates: async () => {
      const sources = typeof opts.sources === 'function' ? await opts.sources() : []
      const baseURLs = []
      for (const source of sources ?? []) {
        const baseURL = /** @type {{ baseURL?: unknown }} */ (source ?? {})?.baseURL
        if (typeof baseURL === 'string') baseURLs.push(baseURL)
      }
      return loopbackOriginsOf(baseURLs)
    },
    ownOrigin: typeof opts.ownOrigin === 'function' ? opts.ownOrigin : () => null,
    host: opts.host,
    port: opts.port,
    portFallback: opts.portFallback === true,
    ...(Number.isFinite(opts.cacheMs) ? { cacheMs: opts.cacheMs } : {}),
    ...(typeof opts.fetchImpl === 'function'
      ? { probe: (origin, probeOptions) => probeRelay(origin, { ...probeOptions, fetchImpl: opts.fetchImpl }) }
      : {}),
    log,
  })
  const client = createControlClient({
    origin: () => resolver.resolve(),
    ...(typeof opts.fetchImpl === 'function' ? { fetchImpl: opts.fetchImpl } : {}),
    log,
  })
  const definitions = tuiCommandDefinitions({
    client,
    invalidateOrigin: () => resolver.invalidate(),
    log,
  })

  /** @type {Array<() => void>} */
  const disposers = []
  let closed = false

  /** @param {any} registry */
  function registerAll(registry) {
    if (closed) return
    if (registry === null || registry === undefined || typeof registry.register !== 'function') {
      log('info', 'no command registry in this composition; the terminal outlet stays off')
      return
    }
    let registered = 0
    for (const definition of definitions) {
      try {
        const dispose = registry.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
        registered += 1
      } catch (error) {
        // A name collision is the only realistic refusal, and it must not take
        // the relay down with it: the other front doors keep working.
        log('warn', `could not register /${definition.name}`, {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Counted, not assumed: a partial registration reported as success would send
    // somebody looking for a command that is not there.
    log(
      'info',
      registered === definitions.length
        ? `terminal outlet registered: /${TUI_COMMAND_NAME} (alias /${TUI_COMMAND_ALIAS})`
        : `terminal outlet registered ${registered} of ${definitions.length} commands`,
    )
  }

  if (ctx !== null && typeof ctx === 'object' && typeof ctx.inject === 'function') {
    try {
      // `inject` rather than a read: the command registry may activate after this
      // row, and a probe taken at apply() time would then miss it for the whole
      // process. The registration is scoped to the injected fiber, so a profile
      // reload tears it down without this module keeping the disposers.
      //
      // Logged before the wait as well as after it: a composition that mounts no
      // registry leaves the callback unrun, and without this line the only
      // symptom would be a terminal saying "unknown command" with no Host-side
      // breadcrumb explaining why.
      log('info', 'offering the terminal outlet to the command registry')
      ctx.inject(['commands'], (injected) => {
        const registry = injected?.commands ?? (typeof ctx.get === 'function' ? ctx.get('commands') : undefined)
        registerAll(registry)
      })
      return () => {
        closed = true
        for (const dispose of disposers.splice(0)) safeDispose(dispose, log)
      }
    } catch (error) {
      log('warn', 'could not inject the command registry; falling back to a direct probe', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const registry = opts.commands ?? (typeof ctx?.get === 'function' ? ctx.get('commands') : undefined)
  registerAll(registry)
  return () => {
    closed = true
    for (const dispose of disposers.splice(0)) safeDispose(dispose, log)
  }
}

/** @param {() => void} dispose @param {(level: string, message: string, detail?: unknown) => void} log */
function safeDispose(dispose, log) {
  try {
    dispose()
  } catch (error) {
    log('warn', 'could not unregister a command', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
