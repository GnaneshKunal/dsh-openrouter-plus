#!/usr/bin/env node
/**
 * Smoke-test the terminal outlet against a live relay.
 *
 * The unit tests prove the command's *wording*; this proves the wiring a
 * transcript actually depends on: which relay answers, that the control API
 * accepts the terminal's `x-oorp-client` header on a write, and that every verb
 * comes back with a sentence instead of a stack.
 *
 * It talks to the relay the same way the command does — resolve, then call — so
 * running it on a machine with several profiles up also tells you *which*
 * instance your provider rows dial.
 *
 * Usage:
 *   node scripts/tui-smoke.mjs                 # read-only verbs
 *   node scripts/tui-smoke.mjs --write         # also set and clear a synthetic Session's preset
 *   OORP_ORIGIN=http://127.0.0.1:8792 node scripts/tui-smoke.mjs
 *
 * Exit code 0 means every verb answered; 1 means at least one failed.
 */

import { createControlClient } from '../lib/control-client.js'
import { createOriginResolver, loopbackOriginsOf, originOf, probeRelay } from '../lib/control-origin.js'
import { runTuiCommand } from '../lib/tui-command.js'

const args = new Set(process.argv.slice(2))
const write = args.has('--write')

/* The relay defaults the plugin ships with. A profile that fell forward is found
   by the same scan the command uses. */
const DEFAULT_PORT = 8791
const PORT_SCAN_LIMIT = 10

/**
 * Whichever relay answers: the explicit override, then the documented port and
 * its fallbacks.
 *
 * @param {string[]} extra origins to try first, most specific first
 * @returns {Promise<string | null>}
 */
async function discover(extra) {
  const seen = new Set()
  const candidates = [...extra]
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const origin = originOf('127.0.0.1', DEFAULT_PORT + offset)
    if (origin !== null) candidates.push(origin)
  }
  for (const origin of candidates) {
    if (seen.has(origin)) continue
    seen.add(origin)
    if (await probeRelay(origin)) return origin
  }
  return null
}

const override = typeof process.env.OORP_ORIGIN === 'string' && process.env.OORP_ORIGIN.trim() !== ''
  ? process.env.OORP_ORIGIN.trim()
  : null

const resolver = createOriginResolver({
  candidates: () => loopbackOriginsOf([override].filter(Boolean)),
  portFallback: true,
  port: DEFAULT_PORT,
  host: '127.0.0.1',
  probe: (origin, options) => probeRelay(origin, options),
  cacheMs: 0,
})

const client = createControlClient({ origin: () => resolver.resolve() })

const origin = await discover(override === null ? [] : [override])
if (origin === null) {
  console.error('no OpenRouter Plus relay answered on 127.0.0.1:%d..%d', DEFAULT_PORT, DEFAULT_PORT + PORT_SCAN_LIMIT - 1)
  console.error('is the profile that runs the plugin up? set OORP_ORIGIN to override the address.')
  process.exit(1)
}
console.log(`relay: ${origin}\n`)

/** One synthetic Session for the write check: memory-only, and it is cleared again. */
const sessionId = `tui-smoke-${Date.now()}`

/** @type {Array<[string, string]>} */
const checks = [
  ['status', ''],
  ['preset catalogue', 'preset'],
  ['precision catalogue', 'precision'],
  ['routes', 'routes'],
  ['spend', 'spend'],
  ['user tracking', 'user'],
  ['help', 'help'],
  ['models hint', 'models'],
]
if (write) {
  checks.push(['set session preset', 'preset priority'], ['clear session preset', 'preset clear'])
}

let failed = 0
for (const [label, rawInput] of checks) {
  const result = await runTuiCommand({
    rawInput,
    sessionId,
    client,
    invalidateOrigin: () => resolver.invalidate(),
    log: () => {},
  })
  const ok = result.kind === 'success'
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  /openrouter-plus ${label}`)
  if (!ok) console.log(indent(result.text))
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} verbs failed`)
  process.exit(1)
}
console.log(`\nall ${checks.length} verbs answered`)
if (!write) console.log('add --write to exercise the POST path (sets and clears a synthetic Session preset)')

/**
 * @param {string} value
 * @returns {string}
 */
function indent(value) {
  return String(value)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')
}
