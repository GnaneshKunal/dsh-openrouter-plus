/**
 * dsh-openrouter-plus — the slash command, as text.
 *
 * Everything a person can do on the settings page has a sentence here, because
 * in a terminal the transcript *is* the interface: no chip, no switch, no card.
 * So this module is deliberately two layers and nothing in between:
 *
 * - **Formatters** turn one control-API answer into lines a terminal can print.
 *   They are pure, exported, and tested against fixtures — the reason a change
 *   to the wording is reviewable without a running relay.
 * - **Dispatch** maps `/openrouter-plus <verb> …` onto the control API, using
 *   the client passed in. It never guesses an origin, never parses a provider
 *   row, and never opens a socket itself.
 *
 * Three constraints run through every string here:
 *
 * - **80 columns.** A terminal is not the settings page: a line that wraps in a
 *   prompt is a line nobody reads twice. `assertLines` in the tests enforces it.
 * - **No colour, no boxes.** The TUI owns the theme; a command's text is
 *   rendered as a transcript block. Plain text also keeps copy-paste honest.
 * - **A failure is a sentence.** {@link runTuiCommand} resolves with
 *   `{ kind: 'error', text }` — the message the control client wrote — instead
 *   of throwing, because a thrown handler would be reported by the UI as a
 *   generic failure and lose the reason.
 *
 * Plain ESM, Node >= 20 built-ins only.
 */

import { ControlRejected, ControlUnavailable } from './control-client.js'

/** The command's name, without the slash. */
export const TUI_COMMAND_NAME = 'openrouter-plus'

/**
 * A short alias. The primary name is discoverable in a palette; the alias is
 * what a person actually types in a terminal for the fifth time today.
 */
export const TUI_COMMAND_ALIAS = 'oorp'

/** What the composer shows after the command name. */
export const TUI_INPUT_HINT =
  'status | preset [<id>] | precision [<id>] | providers [<model>] | routes | route <provider> | spend | user [on|off]'

/** The widest line this module will emit. */
export const TUI_LINE_WIDTH = 80

/**
 * One line per preset, in the order a Session may pick them.
 *
 * The wording is the relay's own contract, not marketing: `flex` really does
 * restrict the pool, `priority` really is billed higher, and `floor` really is
 * a model-variant slug rather than a parameter.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TUI_PRESET_HELP = Object.freeze({
  none: 'send nothing; OpenRouter decides',
  standard: 'pin the standard tier',
  fastest: 'sort the whole pool by throughput',
  'fastest-standard': 'throughput, priority endpoints excluded',
  cheapest: 'sort the pool by price',
  flex: 'flex endpoints only (half price, slower pool)',
  priority: 'priority endpoints first (billed higher)',
  ultra: 'ultrafast, then priority, then standard',
  floor: 'the :floor slug: blind price sort over standard + flex',
})

/**
 * One line per precision floor.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TUI_PRECISION_HELP = Object.freeze({
  any: 'no filter; every endpoint admitted',
  'no-four-bit': 'drop the 4-bit family (fp4, mxfp4, nvfp4)',
  'eight-bit-up': 'fp8 and wider (drops fp6)',
  'full-width': 'uncompressed formats only (fp16, bf16, fp32)',
})

/** The preset ids, in the relay's own order, used when an answer omits them. */
const PRESET_ORDER = Object.freeze([
  'none',
  'standard',
  'fastest',
  'fastest-standard',
  'cheapest',
  'flex',
  'priority',
  'ultra',
  'floor',
])

/** The floor ids, in the relay's own order. */
const PRECISION_ORDER = Object.freeze(['any', 'no-four-bit', 'eight-bit-up', 'full-width'])

// ---------------------------------------------------------------------------
// small formatting helpers
// ---------------------------------------------------------------------------

/**
 * A number, or null when there is no number to show.
 *
 * `Number(null)` is `0` and `Number('')` is `0`, so a coerced read would print a
 * missing uptime as "0.0" — a claim about an endpoint rather than an absence. The
 * listing omits facts it does not have, and the table has to omit them too.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Group digits the way a price list does, without depending on the host locale.
 *
 * @param {unknown} value
 * @returns {string}
 */
function count(value) {
  const number = finite(value)
  if (number === null) return '-'
  const rounded = Math.round(number)
  const text = String(Math.abs(rounded))
  let grouped = ''
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && (text.length - index) % 3 === 0) grouped += ','
    grouped += text[index]
  }
  return rounded < 0 ? `-${grouped}` : grouped
}

/**
 * A token count that fits a column.
 *
 * @param {unknown} value
 * @returns {string}
 */
function tokens(value) {
  const number = finite(value)
  if (number === null) return '-'
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number))
}

/**
 * A dollar amount with enough precision to be useful at both ends: four
 * decimals while a day's spend is cents, fewer once it is not.
 *
 * @param {unknown} value
 * @returns {string}
 */
function usd(value) {
  const number = finite(value)
  if (number === null) return '-'
  if (number === 0) return '$0'
  if (number >= 100) return `$${number.toFixed(0)}`
  if (number >= 1) return `$${number.toFixed(2)}`
  return `$${number.toFixed(4)}`
}

/**
 * Uptime in the shape a status line uses.
 *
 * @param {unknown} ms
 * @returns {string}
 */
function duration(ms) {
  const total = finite(ms)
  if (total === null || total < 0) return '-'
  const seconds = Math.floor(total / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`
}

/**
 * `label` padded to one column so a block reads as a block.
 *
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
function line(label, value) {
  return `${label.padEnd(11)}${value}`.replace(/\s+$/, '')
}

/**
 * A labelled list that wraps instead of running off the right edge.
 *
 * `spend`'s per-preset row is the one line whose length depends on the traffic,
 * and a line that wraps at the terminal's own margin loses the alignment the
 * label exists to give. Continuations are indented under the first cell, so the
 * block still reads as one row of facts.
 *
 * @param {string} label
 * @param {readonly string[]} cells
 * @param {number} [width]
 * @returns {string[]}
 */
function packed(label, cells, width = TUI_LINE_WIDTH) {
  const indent = ' '.repeat(11)
  /** @type {string[]} */
  const lines = []
  let current = label.padEnd(11)
  let fresh = true
  for (const cell of cells) {
    const addition = fresh ? cell : ` · ${cell}`
    if (!fresh && current.length + addition.length > width) {
      lines.push(current)
      current = `${indent}${cell}`
      continue
    }
    current += addition
    fresh = false
  }
  if (!fresh) lines.push(current)
  return lines
}

/**
 * Cut one line at the transcript margin.
 *
 * Provider keys and upstream URLs are user-supplied and unbounded; a table row
 * built from them must not be the one thing that breaks the 80-column rule. The
 * truncated value is still identifiable, and the full one is one verb away
 * (`routes` prints it in the target block, and `/provider` owns it).
 *
 * @param {string} value
 * @param {number} [width]
 * @returns {string}
 */
function clip(value, width = TUI_LINE_WIDTH) {
  const text = String(value)
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/**
 * A labelled paragraph that wraps around its label.
 *
 * The reason a table was withheld (`formatRoutes`) and a minted identifier can
 * both be arbitrarily long, and a transcript line that wraps at the terminal's
 * own margin loses the hang the label gives it.
 *
 * @param {string} label
 * @param {string} prose
 * @param {number} [width]
 * @returns {string[]}
 */
function wrapped(label, prose, width = TUI_LINE_WIDTH) {
  const indent = ' '.repeat(11)
  const words = text(prose).trim().split(/\s+/).filter((word) => word !== '')
  /** @type {string[]} */
  const lines = []
  let current = label.padEnd(11)
  let fresh = true
  for (const word of words) {
    const addition = fresh ? word : ` ${word}`
    if (!fresh && current.length + addition.length > width) {
      lines.push(current)
      current = `${indent}${word}`
      continue
    }
    current += addition
    fresh = false
  }
  if (!fresh) lines.push(current)
  return lines
}

/**
 * One noun or its plural, without a library.
 *
 * @param {number} value
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function noun(value, one, many) {
  return `${count(value)} ${value === 1 ? one : many ?? `${one}s`}`
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} value @returns {any[]} */
function list(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Render the preset an answer reports, with where it came from.
 *
 * `chosen` is the Session's own choice; `null` means "inherits". Saying which
 * of the two it is is the whole point of the line: a Session on `flex` from the
 * profile default is a different fact from a Session somebody switched.
 *
 * @param {{ chosen?: unknown, preset?: unknown, default?: unknown }} tier
 * @returns {string}
 */
function presetSentence(tier) {
  const chosen = typeof tier.chosen === 'string' ? tier.chosen : null
  const active = text(tier.preset) || chosen || text(tier.default) || 'none'
  if (chosen !== null) return `${active} (chosen for this Session)`
  return `${active} (inherited from the profile default)`
}

/**
 * The same distinction for a precision floor.
 *
 * @param {{ inherited?: unknown, source?: unknown, precision?: unknown, chosen?: unknown }} precision
 * @returns {string}
 */
function precisionSentence(precision) {
  const floor = text(record(precision.precision).floor) || text(precision.default === undefined ? '' : record(precision.default).floor)
  const active = floor || 'any'
  const inherited = precision.inherited === true || precision.source === 'default'
  return inherited ? `${active} (inherited from the profile default)` : `${active} (chosen for this Session)`
}

// ---------------------------------------------------------------------------
// formatters — one control-API answer in, printable lines out
// ---------------------------------------------------------------------------

/**
 * The four-line answer to a bare `/openrouter-plus`.
 *
 * @param {{ status?: unknown, tier?: unknown, precision?: unknown, sessionId?: string }} input
 * @returns {string}
 */
export function formatStatus(input) {
  const status = record(record(input).status)
  const tier = record(record(input).tier)
  const precision = record(record(input).precision)
  const metrics = record(status.metrics)
  const address = record(status.address)
  const relay = text(address.origin) || text(status.upstream)
  const version = text(status.version) || '?'

  /** @type {string[]} */
  const lines = []
  const bound = status.bound !== false && text(status.error) === ''
  lines.push(
    bound
      ? `OpenRouter Plus ${version} · up ${duration(status.uptimeMs)} · ${relay}`
      : `OpenRouter Plus ${version} · relay is not listening`,
  )
  if (text(status.error) !== '') lines.push(line('relay', status.error))
  lines.push(line('upstream', text(status.upstream) || '-'))
  // A Host that answered without a Session (or without either preference route)
  // leaves these two empty; printing a dash beats inventing a default.
  lines.push(line('preset', Object.keys(tier).length === 0 ? '-' : presetSentence(tier)))
  lines.push(line('precision', Object.keys(precision).length === 0 ? '-' : precisionSentence(precision)))
  lines.push(
    line(
      'spend',
      `${usd(metrics.todayUsd)} today · ${usd(metrics.costUsd)} retained · ${noun(finite(metrics.requests) ?? 0, 'request')}`,
    ),
  )
  lines.push('')
  lines.push(`Switch this Session: /${TUI_COMMAND_NAME} preset flex`)
  return lines.join('\n')
}

/**
 * The preset catalogue, with the current choice marked.
 *
 * @param {{ tier: unknown, presets?: readonly string[] }} input
 * @returns {string}
 */
export function formatPresetCatalog(input) {
  const tier = record(input.tier)
  // The list rides on the answer itself (`/tier` sends `presets`), so a Host that
  // learns a preset renders it here without this module being re-released.
  const ids = list(tier.presets).length > 0 ? list(tier.presets).map(String) : PRESET_ORDER
  const width = Math.max(...ids.map((id) => id.length))
  /** @type {string[]} */
  const lines = ['Presets a Session may pick (the relay applies one per request):', '']
  for (const id of ids) {
    lines.push(`  ${id.padEnd(width + 2)}${TUI_PRESET_HELP[id] ?? ''}`.replace(/\s+$/, ''))
  }
  lines.push('')
  lines.push(`current   ${presetSentence(tier)}`)
  lines.push(`default   ${text(tier.default) || 'none'} (what a new Session inherits)`)
  lines.push('')
  lines.push(`Set:      /${TUI_COMMAND_NAME} preset flex`)
  lines.push(`Clear:    /${TUI_COMMAND_NAME} preset clear`)
  lines.push(`Profile:  /${TUI_COMMAND_NAME} preset default flex`)
  return lines.join('\n')
}

/**
 * The one-line confirmation after a preset write.
 *
 * @param {{ tier: unknown, scope: 'session'|'default'|'clear' }} input
 * @returns {string}
 */
export function formatPresetResult(input) {
  const tier = record(input.tier)
  if (input.scope === 'default') {
    return `Profile default preset is ${text(tier.default) || 'none'}; a new Session inherits it (the row reloads).`
  }
  if (input.scope === 'clear') {
    return `This Session's preset is cleared; it inherits ${text(tier.default) || 'nothing'} from the profile default.`
  }
  return `This Session now runs on «${text(tier.preset) || 'none'}»; its next request carries that preset.`
}

/**
 * The precision catalogue.
 *
 * @param {{ precision: unknown, floors?: readonly string[] }} input
 * @returns {string}
 */
export function formatPrecisionCatalog(input) {
  const precision = record(input.precision)
  // Same rule as the preset catalogue: `/precision` ships its own floor list.
  const ids = list(precision.floors).length > 0 ? list(precision.floors).map(String) : PRECISION_ORDER
  const width = Math.max(...ids.map((id) => id.length))
  /** @type {string[]} */
  const lines = ['Precision floors (the relay admits only endpoints inside the one in force):', '']
  for (const id of ids) lines.push(`  ${id.padEnd(width + 2)}${TUI_PRECISION_HELP[id] ?? ''}`.replace(/\s+$/, ''))
  lines.push('')
  lines.push(`current   ${precisionSentence(precision)}`)
  lines.push('')
  lines.push(`Set:      /${TUI_COMMAND_NAME} precision eight-bit-up`)
  lines.push(`Clear:    /${TUI_COMMAND_NAME} precision clear`)
  lines.push(`Profile:  /${TUI_COMMAND_NAME} precision default any`)
  return lines.join('\n')
}

/**
 * The one-line confirmation after a floor write.
 *
 * @param {{ precision: unknown, scope: 'session'|'default'|'clear' }} input
 * @returns {string}
 */
export function formatPrecisionResult(input) {
  const precision = record(input.precision)
  const floor = text(record(precision.precision).floor) || text(record(precision.default).floor) || 'any'
  if (input.scope === 'default') {
    return `Profile default floor is ${floor}; new Sessions inherit it (the row reloads).`
  }
  if (input.scope === 'clear') {
    return `This Session's floor is cleared; it inherits ${floor} from the profile default.`
  }
  return [
    `This Session's precision floor is ${floor}.`,
    'The relay admits no endpoint outside it from the next request.',
  ].join('\n')
}

/**
 * Where the money went, from the relay's own snapshot.
 *
 * @param {{ status: unknown }} input
 * @returns {string}
 */
export function formatSpend(input) {
  const metrics = record(record(input).status)
  const snapshot = record(metrics.metrics)
  const byTier = record(snapshot.byTier)
  const days = list(snapshot.days).length
  /** @type {string[]} */
  const lines = [
    line('spend', `${usd(snapshot.todayUsd)} today · ${usd(snapshot.costUsd)} over ${days} day${days === 1 ? '' : 's'}`),
    line(
      'requests',
      `${count(snapshot.requests)} (${count(snapshot.errors)} errors) · tokens ${tokens(snapshot.promptTokens)} in / ${tokens(snapshot.completionTokens)} out`,
    ),
  ]
  const multiplier = finite(snapshot.effectiveMultiplier)
  lines.push(line('effective', multiplier === null || multiplier === 0 ? '-' : `×${multiplier.toFixed(2)} of list price`))

  const rows = Object.entries(byTier)
    .map(([name, bucket]) => ({ name, ...record(bucket) }))
    .filter((row) => (finite(row.requests) ?? 0) > 0)
    .sort((left, right) => (finite(right.costUsd) ?? 0) - (finite(left.costUsd) ?? 0))
  if (rows.length > 0) {
    const shown = rows.slice(0, 3)
    const cells = shown.map((row) => `${row.name === 'unset' ? 'none' : row.name} ${usd(row.costUsd)} (${count(row.requests)})`)
    if (rows.length > shown.length) cells.push(`+${rows.length - shown.length} more`)
    lines.push(...packed('by preset', cells))
  }
  return lines.join('\n')
}

/**
 * The provider rows this relay carries, and the targets behind them.
 *
 * @param {unknown} targets the `/targets` answer
 * @returns {string}
 */
export function formatRoutes(targets) {
  const answer = record(targets)
  const created = list(answer.created)
  const custom = list(answer.custom)
  /** @type {string[]} */
  const lines = []
  /* A Host without an editor still reports the target table it owns itself, so
     the withheld branch keeps printing those rows: hiding what *is* readable
     because one half is not would be the wrong failure. */
  if (answer.available === false) {
    const reason = text(answer.reason) || 'configEditor is unavailable'
    lines.push('The provider table is not readable here:')
    lines.push(...wrapped('reason', reason))
    lines.push(...targetLines(custom))
    return lines.join('\n')
  }
  if (created.length === 0) {
    lines.push('No provider row points at this relay yet.')
    lines.push('')
    lines.push(`Route one: /${TUI_COMMAND_NAME} route <provider>`)
  } else {
    const names = created.map((entry) => text(record(entry).name))
    const width = Math.max(...names.map((name) => name.length))
    lines.push(`Provider rows through the relay (${created.length}):`)
    for (const entry of created) {
      const row = record(entry)
      const pinned = text(row.tier)
      const models = noun(finite(row.modelCount) ?? 0, 'model')
      lines.push(
        clip(
          `  ${text(row.name).padEnd(width + 2)}${models.padEnd(12)}${pinned === '' ? 'per-Session preset' : `pinned ${pinned}`}`,
        ),
      )
    }
    lines.push('')
    lines.push(`Detach: /${TUI_COMMAND_NAME} unroute <provider>`)
  }
  lines.push(...targetLines(custom))
  const tier = record(answer.tier)
  if (list(tier.presets).length > 0) {
    lines.push('')
    lines.push(`New Sessions inherit the preset «${text(tier.default) || 'none'}».`)
    lines.push(`Switch this Session: /${TUI_COMMAND_NAME} preset <id>`)
  }
  return lines.join('\n')
}

/**
 * The registered-target rows, when the answer carries any.
 *
 * @param {any[]} custom
 * @returns {string[]}
 */
function targetLines(custom) {
  if (custom.length === 0) return []
  /** @type {string[]} */
  const lines = ['', `Targets registered (${custom.length}):`]
  for (const entry of custom) {
    const row = record(entry)
    const owner = text(row.route)
    lines.push(clip(`  ${text(row.id)} → ${text(row.upstream)}${owner === '' ? '' : ` (row: ${owner})`}`))
  }
  return lines
}

/**
 * The confirmation after routing or restoring one provider row.
 *
 * @param {{ action: 'attach'|'detach', answer: unknown }} input
 * @returns {string}
 */
export function formatRouteResult(input) {
  const answer = record(input.answer)
  const route = text(answer.route) || 'the provider'
  const baseURL = text(answer.baseURL) || '-'
  const changed = answer.changed !== false
  if (input.action === 'detach') {
    return [
      changed ? `${route} is back on its own endpoint:` : `${route} was already on its own endpoint (nothing changed):`,
      `  ${baseURL}`,
    ].join('\n')
  }
  return [
    changed ? `${route} now routes through the relay:` : `${route} was already routed through the relay:`,
    `  ${baseURL}`,
    'The preset this Session carries applies to it from the next request.',
  ].join('\n')
}

/**
 * The user-identifier switch, as it stands and as it changed.
 *
 * @param {{ userTracking: unknown, action?: 'on'|'off'|'read' }} input
 * @returns {string}
 */
export function formatUserTracking(input) {
  const tracking = record(record(input).userTracking)
  const enabled = tracking.enabled === true
  const id = text(tracking.id)
  if (input.action === 'on') {
    if (!enabled || id === '') {
      return 'User tracking on, but no identifier was minted; the relay logs a warning and sends nothing.'
    }
    return [
      `User tracking on; every request now carries ${id}.`,
      'OpenRouter hashes it before forwarding it, so it never leaves raw.',
    ].join('\n')
  }
  if (input.action === 'off') {
    return [
      'User tracking off; no identifier is sent.',
      'The stored one is kept, so turning it back on sends the same value.',
    ].join('\n')
  }
  /** @type {string[]} */
  const lines = enabled && id !== ''
    ? [`User tracking on — every request carries ${id}.`]
    : ['User tracking off — no identifier is sent.']
  lines.push('')
  lines.push(enabled ? `Turn off: /${TUI_COMMAND_NAME} user off` : `Turn on:  /${TUI_COMMAND_NAME} user on`)
  return lines.join('\n')
}

/**
 * Per-endpoint price, speed and uptime for one model.
 *
 * This is the terminal face of the composer's endpoint menu: the same `/providers`
 * answer, one row per OpenRouter endpoint, in the model page's group order
 * (standard, flex, priority, then the endpoints it will not route to). The columns
 * are the facts a person chooses with — `$/M in`, `$/M out`, tokens per second,
 * milliseconds to the first token, and the last day's uptime — which is why the
 * page's `providerFacts` switches are not consulted here: they exist to stop five
 * facts crowding a 220 px menu row, and a terminal has the width.
 *
 * @param {{ answer: unknown, source?: 'named'|'last' }} input
 * @returns {string}
 */
export function formatProviders(input) {
  const answer = record(record(input).answer)
  const rows = list(answer.providers).map(record)
  const model = text(answer.model) || '(unknown model)'
  const groups = list(answer.groups).map(record)

  if (rows.length === 0) {
    const reason = text(answer.error)
    /** @type {string[]} */
    const lines = [`No endpoint listing for ${model}.`]
    if (reason !== '') lines.push(...wrapped('reason', reason))
    return lines.join('\n')
  }

  /* Group order first, so the table reads the way the model page does; anything a
     Host did not group falls in afterwards rather than disappearing. */
  const byTag = new Map(rows.map((row) => [text(row.tag), row]))
  /** @type {Record<string, unknown>[]} */
  const ordered = []
  for (const group of groups) {
    for (const tag of list(group.tags)) {
      const row = byTag.get(String(tag))
      if (row !== undefined) ordered.push(row)
    }
  }
  if (ordered.length !== rows.length) {
    const shown = new Set(ordered.map((row) => text(row.tag)))
    for (const row of rows) if (!shown.has(text(row.tag))) ordered.push(row)
  }

  const width = PROVIDER_TABLE
  const header = [
    '  ',
    'endpoint'.padEnd(width.tag),
    ' ',
    'lane'.padEnd(width.lane),
    ' ',
    'prec'.padEnd(width.precision),
    ' ',
    'in'.padStart(width.input),
    ' ',
    'out'.padStart(width.output),
    ' ',
    'tok/s'.padStart(width.throughput),
    ' ',
    'ms'.padStart(width.latency),
    ' ',
    'up'.padStart(width.uptime),
  ].join('')

  /** @type {string[]} */
  const lines = []
  const cached = answer.cached === true ? ' · cached' : ''
  const source = record(input).source
  const from = source === 'current'
    ? ' (this Session\'s model)'
    : source === 'last'
      ? ' (this Session\'s last model)'
      : source === 'recent'
        ? ' (the relay\'s last model)'
        : ''
  lines.push(clip(`${model}: ${noun(rows.length, 'endpoint')}${from}${cached}`))
  lines.push(header)
  const counts = new Map()
  for (const row of ordered) {
    const group = text(row.group)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    lines.push(
      [
        '  ',
        clip(text(row.tag), width.tag).padEnd(width.tag),
        ' ',
        laneOf(row.tier).padEnd(width.lane),
        ' ',
        (text(row.precision) || '-').padEnd(width.precision),
        ' ',
        price(row.inputPrice).padStart(width.input),
        ' ',
        price(row.outputPrice).padStart(width.output),
        ' ',
        speed(row.throughput).padStart(width.throughput),
        ' ',
        speed(row.latency).padStart(width.latency),
        ' ',
        uptimeOf(row.uptime1d).padStart(width.uptime),
        row.available === false ? ' !' : '',
      ].join(''),
    )
  }
  lines.push('')
  const summary = ['standard', 'flex', 'priority', 'unavailable']
    .map((group) => (counts.has(group) ? `${group} ${counts.get(group)}` : ''))
    .filter((part) => part !== '')
  lines.push(`  ${summary.join(' · ')}`)
  if (counts.has('unavailable')) lines.push('  ! not routable right now (status or uptime)')
  lines.push('  in/out are dollars per million tokens; speeds are the 30-minute window')
  lines.push(`  lane is the service tier a row belongs to; up is the last day's uptime, %`)
  return lines.join('\n')
}

/**
 * The column widths of {@link formatProviders}, and the reason they are constants:
 * a header and its rows must be built from one set of numbers or they drift.
 */
const PROVIDER_TABLE = Object.freeze({
  tag: 22,
  lane: 5,
  precision: 7,
  input: 6,
  output: 6,
  throughput: 9,
  latency: 9,
  uptime: 5,
})

/**
 * A day's uptime in at most four cells.
 *
 * `100.0` and `100` say the same thing, and the extra cell is the difference
 * between a full row fitting the transcript margin and wrapping.
 *
 * @param {unknown} value
 * @returns {string}
 */
function uptimeOf(value) {
  const percent = finite(value)
  if (percent === null) return '-'
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
}

/**
 * The service tier a row belongs to, in four cells.
 *
 * The tag usually names it (`/flex`, `/priority`), but not always — `baseten/fast`
 * is a priority endpoint whose slug says "fast" — so the ordering alone is not
 * enough to read a row's lane.
 *
 * @param {unknown} tier
 * @returns {string}
 */
function laneOf(tier) {
  const name = text(tier)
  if (name === 'standard') return 'std'
  if (name === 'flex') return 'flex'
  if (name === 'priority') return 'prio'
  return '-'
}

/**
 * A price per million tokens, at a precision that survives both ends: a free
 * endpoint, a tenth of a cent, and ten dollars all have to fit one column.
 *
 * @param {unknown} value
 * @returns {string}
 */
function price(value) {
  const number = finite(value)
  if (number === null) return '-'
  if (number === 0) return 'free'
  if (number >= 10) return number.toFixed(1)
  if (number >= 1) return number.toFixed(2)
  if (number >= 0.1) return number.toFixed(3)
  return number.toFixed(4)
}

/**
 * A p50/p90 pair in one cell, or whichever half the listing reported.
 *
 * @param {unknown} value
 * @returns {string}
 */
function speed(value) {
  const pair = record(value)
  const p50 = finite(pair.p50)
  const p90 = finite(pair.p90)
  if (p50 === null && p90 === null) return '-'
  if (p50 === null || p90 === null) return compact(p50 ?? p90)
  return `${compact(p50)}/${compact(p90)}`
}

/**
 * A number in at most four cells.
 *
 * Throughput is tens to hundreds, but a tail latency can be five digits
 * (`87647` ms is a real row), and one wide number would push every later column
 * out of alignment on that line alone.
 *
 * @param {number} value
 * @returns {string}
 */
function compact(value) {
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

/**
 * The answer to the one verb that is a pointer rather than a request.
 *
 * The plugin's other half of its purpose — reading a live model list — is
 * already built into the terminal: `/provider` probes a user route's stored
 * `baseURL` with the stored key. Saying so is more useful than a second,
 * worse listing here.
 *
 * @returns {string}
 */
export function formatModelsHint() {
  return [
    'Model *discovery* is the terminal\'s own job: /provider → edit a provider → its',
    'model list is probed live against the stored baseURL with the stored key, so a',
    'model added to OpenRouter after this install was built shows up there.',
    '',
    `For one model's endpoints — price, tokens per second, uptime — use`,
    `/${TUI_COMMAND_NAME} providers [<model>].`,
  ].join('\n')
}

/**
 * `/openrouter-plus help`.
 *
 * @returns {string}
 */
export function formatHelp() {
  const name = `/${TUI_COMMAND_NAME}`
  const rows = [
    ['', 'relay, preset, precision, spend'],
    ['preset', 'list the presets'],
    ['preset <id>', 'this Session runs on <id>'],
    ['preset default <id>', 'what a new Session inherits'],
    ['preset clear', 'back to the profile default'],
    ['precision', 'list the floors'],
    ['precision <id>', 'admit only <id>, this Session'],
    ['precision default <id>', 'what a new Session inherits'],
    ['precision clear', 'back to the profile default'],
    ['routes', 'rows through the relay, and targets'],
    ['route <provider>', 'point a row at the relay'],
    ['unroute <provider>', 'restore its own endpoint'],
    ['spend', 'what OpenRouter charged'],
    ['user [on|off]', 'the optional user identifier'],
    ['repair', 'refill missing reasoning efforts'],
    ['providers [<model>]', 'price, tok/s and uptime per endpoint'],
    ['models', 'why discovery lives in /provider'],
  ]
  const prefixes = rows.map(([verb]) => `  ${name}${verb === '' ? '' : ` ${verb}`}`)
  const width = Math.max(...prefixes.map((prefix) => prefix.length))
  /** @type {string[]} */
  const lines = ['OpenRouter Plus, from the terminal.', '']
  rows.forEach(([, meaning], index) => lines.push(`${prefixes[index].padEnd(width + 2)}${meaning}`))
  lines.push('')
  lines.push(`Alias: /${TUI_COMMAND_ALIAS}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Split the text after the command name.
 *
 * The TUI hands the handler the raw remainder exactly as typed, including the
 * separating space, so nothing here may assume a normalised shape.
 *
 * @param {unknown} rawInput
 * @returns {{ verb: string, args: string[] }}
 */
export function parseInvocation(rawInput) {
  const parts = text(rawInput).trim().split(/\s+/).filter((part) => part !== '')
  if (parts.length === 0) return { verb: '', args: [] }
  return { verb: parts[0].toLowerCase(), args: parts.slice(1) }
}

/**
 * One successful or failed result, in the shape `@deepseek-ai/dsh-commands`
 * expects.
 *
 * @param {string} value
 * @returns {{ kind: 'success', text: string }}
 */
function success(value) {
  return { kind: 'success', text: value }
}

/**
 * @param {string} value
 * @returns {{ kind: 'error', text: string }}
 */
function failure(value) {
  return { kind: 'error', text: value }
}

/**
 * The one refusal shared by every Session-scoped write.
 *
 * @param {string} verb
 * @returns {{ kind: 'error', text: string }}
 */
function noSession(verb) {
  return failure(
    [
      `/${TUI_COMMAND_NAME} ${verb} changes this Session's choice, and this`,
      'command is not running in one. Set the profile default instead:',
      `  /${TUI_COMMAND_NAME} ${verb} default <id>`,
    ].join('\n'),
  )
}

/** @param {unknown} error @returns {boolean} */
function isTransportFault(error) {
  return error instanceof ControlUnavailable || error instanceof ControlRejected
}

/**
 * Run one `/openrouter-plus …` line.
 *
 * Never throws: a refused call, a stopped relay and a typo all come back as
 * `{ kind: 'error', text }` so the reason reaches the transcript.
 *
 * @param {{
 *   rawInput?: unknown,
 *   sessionId?: string,
 *   model?: string,
 *   client: {
 *     get: (path: string, query?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>,
 *     post: (path: string, body?: unknown, options?: { signal?: AbortSignal }) => Promise<any>,
 *   },
 *   signal?: AbortSignal,
 *   invalidateOrigin?: () => void,
 *   log?: (level: string, message: string, detail?: unknown) => void,
 * }} input
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runTuiCommand(input) {
  const options = record(input)
  const client = /** @type {{ get: Function, post: Function }} */ (options.client)
  const { verb, args } = parseInvocation(options.rawInput)
  const sessionId = text(options.sessionId)
  const model = text(options.model)
  const signal = options.signal
  const log = typeof options.log === 'function' ? options.log : () => {}

  if (typeof client?.get !== 'function' || typeof client?.post !== 'function') {
    return failure('OpenRouter Plus is not wired to a control client in this Host.')
  }
  try {
    switch (verb) {
      case '':
      case 'status': {
        const [status, tier, precision] = await Promise.all([
          client.get('/status', undefined, { signal }),
          sessionId === '' ? Promise.resolve({}) : client.get('/tier', { session: sessionId }, { signal }),
          sessionId === '' ? Promise.resolve({}) : client.get('/precision', { session: sessionId }, { signal }),
        ])
        return success(formatStatus({ status, tier, precision, sessionId }))
      }
      case 'help':
      case '?':
      case '--help':
        return success(formatHelp())
      case 'preset':
        return await presetVerb({ args, sessionId, client, signal })
      case 'precision':
        return await precisionVerb({ args, sessionId, client, signal })
      case 'routes':
        return success(formatRoutes(await client.get('/targets', undefined, { signal })))
      case 'route':
        return await routeVerb({ args, client, signal, action: 'attach' })
      case 'unroute':
        return await routeVerb({ args, client, signal, action: 'detach' })
      case 'spend':
        return success(formatSpend({ status: await client.get('/status', undefined, { signal }) }))
      case 'user':
        return await userVerb({ args, client, signal })
      case 'repair':
        return await repairVerb({ client, signal })
      case 'providers':
        return await providersVerb({ args, sessionId, model, client, signal })
      case 'models':
        return success(formatModelsHint())
      default:
        return failure(`Unknown subcommand ${JSON.stringify(verb)}. Run /${TUI_COMMAND_NAME} help.`)
    }
  } catch (error) {
    /* Only an unreachable relay is evidence that the cached origin may be stale —
       a restarted process, a different instance on the port. A refusal (a typo'd
       preset, a provider row that does not exist) says nothing about the address,
       and re-probing for it would cost a sweep per keystroke. */
    if (error instanceof ControlUnavailable && typeof options.invalidateOrigin === 'function') {
      options.invalidateOrigin()
    }
    if (isTransportFault(error)) {
      log('warn', 'openrouter-plus command failed', { verb, reason: error instanceof Error ? error.message : String(error) })
    }
    return failure(error instanceof Error ? error.message : String(error))
  }
}

/**
 * `preset`, `preset <id>`, `preset default <id>`, `preset clear`.
 *
 * `default` is the one ambiguous word: the relay accepts a preset *named*
 * `default` (a legacy spelling of `standard`), while this command needs it as a
 * subcommand. Reading it as the subcommand only when a preset follows is the
 * rule that keeps both honest — `preset default` sets the Session to `standard`,
 * `preset default flex` sets the profile default to `flex`.
 *
 * @param {{ args: string[], sessionId: string, client: any, signal?: AbortSignal }} input
 */
async function presetVerb(input) {
  const { args, sessionId, client, signal } = input
  if (args.length === 0 || args[0] === 'list') {
    return success(formatPresetCatalog({ tier: await client.get('/tier', { session: sessionId }, { signal }) }))
  }
  if (args[0] === 'default' && args.length >= 2) {
    const answer = await client.post('/tier/default', { preset: args[1] }, { signal })
    return success(formatPresetResult({ tier: { default: answer?.default }, scope: 'default' }))
  }
  // Everything below writes a *Session's* choice — including `clear`, which writes
  // "no choice" into that Session's row — so it needs a Session. The catalogue and
  // the profile write above do not: a read with no Session answers the profile
  // default, which is a useful thing to see from a palette with no conversation open.
  if (sessionId === '') return noSession('preset')
  if (args[0] === 'clear') {
    const cleared = await client.post('/tier', { session: sessionId, preset: null }, { signal })
    return success(formatPresetResult({ tier: cleared, scope: 'clear' }))
  }
  const tier = await client.post('/tier', { session: sessionId, preset: args[0] }, { signal })
  return success(formatPresetResult({ tier, scope: 'session' }))
}

/**
 * `precision`, `precision <id>`, `precision default <id>`, `precision clear`.
 *
 * @param {{ args: string[], sessionId: string, client: any, signal?: AbortSignal }} input
 */
async function precisionVerb(input) {
  const { args, sessionId, client, signal } = input
  if (args.length === 0 || args[0] === 'list') {
    return success(formatPrecisionCatalog({ precision: await client.get('/precision', { session: sessionId }, { signal }) }))
  }
  if (args[0] === 'default' && args.length >= 2) {
    const answer = await client.post('/precision/default', { precision: args[1] }, { signal })
    return success(formatPrecisionResult({ precision: { default: answer?.default }, scope: 'default' }))
  }
  // Same rule as `preset`: a Session-scoped write needs a Session, a catalogue or
  // the profile write does not.
  if (sessionId === '') return noSession('precision')
  if (args[0] === 'clear') {
    const cleared = await client.post('/precision', { session: sessionId, precision: null }, { signal })
    return success(formatPrecisionResult({ precision: cleared, scope: 'clear' }))
  }
  const precision = await client.post('/precision', { session: sessionId, precision: args[0] }, { signal })
  return success(formatPrecisionResult({ precision, scope: 'session' }))
}

/**
 * `route <provider>` / `unroute <provider>`.
 *
 * @param {{ args: string[], client: any, signal?: AbortSignal, action: 'attach'|'detach' }} input
 */
async function routeVerb(input) {
  const { args, client, signal, action } = input
  const route = args[0]?.trim()
  if (route === undefined || route === '') {
    return failure(
      [
        `Which provider row? /${TUI_COMMAND_NAME} ${action === 'attach' ? 'route' : 'unroute'} <provider>`,
        `/${TUI_COMMAND_NAME} routes lists them.`,
      ].join('\n'),
    )
  }
  const answer = await client.post(action === 'attach' ? '/routes/attach' : '/routes/detach', { route }, { signal })
  return success(formatRouteResult({ action, answer }))
}

/**
 * `providers [<model>]` — the endpoint table.
 *
 * With no argument the model is the one this Session last put through the relay,
 * read from the metrics ring the status call already carries: asking somebody to
 * paste a model id they just used would be a worse answer than remembering it.
 *
 * @param {{ args: string[], sessionId: string, model?: string, client: any, signal?: AbortSignal }} input
 */
async function providersVerb(input) {
  const { args, sessionId, client, signal } = input
  let model = args[0] === undefined ? '' : args[0].trim()
  let source = 'named'
  if (model === '') {
    /* The model the Session is *on*, which is the one a person means when they
       name none. It survives `/model` before the next request, where the metrics
       ring below would still be reporting the previous model. */
    const current = text(record(input).model).trim()
    if (current !== '') {
      model = current
      source = 'current'
    }
  }
  if (model === '') {
    // A host that cannot answer "which model is this Session on" still has the
    // relay's own record of what it carried, so the verb degrades rather than
    // refusing.
    model = lastModelForSession(await client.get('/status', undefined, { signal }), sessionId)
    source = sessionId === '' ? 'recent' : 'last'
    if (model === '') {
      return failure(
        [
          `Which model? /${TUI_COMMAND_NAME} providers <author/slug>`,
          'The table is per model; /model switches the model this Session runs on.',
        ].join('\n'),
      )
    }
  }
  if (!model.includes('/')) {
    return failure(
      [`${JSON.stringify(model)} is not an OpenRouter model id.`, 'They look like author/slug, e.g. deepseek/deepseek-v3.2.'].join(
        '\n',
      ),
    )
  }
  return success(formatProviders({ answer: await client.get('/providers', { model }, { signal }), source }))
}

/**
 * The model this Session routed most recently, or `''`.
 *
 * The metrics ring is newest-first and each row names the model and the Session,
 * so the first match is the answer. A Session that has made no relayed request yet
 * has nothing to remember, and the command says so instead of inventing a model.
 *
 * @param {unknown} status the `/status` answer
 * @param {string} sessionId
 * @returns {string}
 */
function lastModelForSession(status, sessionId) {
  const recent = list(record(record(status).metrics).recent)
  for (const entry of recent) {
    const row = record(entry)
    if (sessionId !== '' && text(row.sessionId) !== sessionId) continue
    const model = text(row.model) || text(row.servedModel)
    if (model.includes('/')) return model
  }
  return ''
}

/**
 * `user`, `user on`, `user off`.
 *
 * @param {{ args: string[], client: any, signal?: AbortSignal }} input
 */
async function userVerb(input) {
  const { args, client, signal } = input
  const choice = args[0]?.toLowerCase()
  if (choice === undefined) {
    // The route answers `{ ok, userTracking }`; the formatter wants the inner object,
    // so the envelope is unwrapped here rather than guessed at there.
    const answer = await client.get('/user-tracking', undefined, { signal })
    return success(formatUserTracking({ userTracking: record(answer).userTracking }))
  }
  if (choice !== 'on' && choice !== 'off') {
    return failure(`Unknown switch ${JSON.stringify(args[0])}; use /${TUI_COMMAND_NAME} user on or off.`)
  }
  const answer = await client.post('/user-tracking', { enabled: choice === 'on' }, { signal })
  return success(formatUserTracking({ userTracking: answer?.userTracking, action: choice }))
}

/**
 * `repair` — refill the reasoning maps a relay route is missing.
 *
 * @param {{ client: any, signal?: AbortSignal }} input
 */
async function repairVerb(input) {
  const answer = record(await input.client.post('/routes/repair', {}, { signal: input.signal }))
  const patched = list(answer.patched)
  if (patched.length === 0) {
    return success('Nothing to repair: every route through the relay already declares its reasoning efforts.')
  }
  const names = patched
    .map((entry) => (typeof entry === 'string' ? entry : text(record(entry).name)))
    .filter((name) => name !== '')
  return success(`Added reasoning efforts to ${noun(patched.length, 'route')}: ${names.join(', ') || '(unnamed)'}`)
}
