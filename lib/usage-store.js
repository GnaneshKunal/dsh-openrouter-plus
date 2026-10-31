/**
 * The cost half of the relay's telemetry, persisted.
 *
 * Cost is the one number this plugin cannot recompute: OpenRouter billed it once, and
 * `usage.cost` is not in anything the Host stores, so the day buckets are written beside
 * the profile and a reload hydrates them instead of starting at zero.
 *
 * The file is advisory. A malformed, oversized or unreadable snapshot is ignored rather
 * than fatal, and each write lands through a temp file plus a rename, so a crash mid-write
 * cannot leave a half-file that the next start would have to reject.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const USAGE_STORE_VERSION = 2
export const USAGE_STORE_MAX_BYTES = 256 * 1024

/**
 * Where the rollup lives. `DSH_HOME` is the Host's own idea of home, so a profile moved
 * to another path keeps its history with it; the literal default matches the Host.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function usageStorePath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-openrouter-plus', 'usage.json')
}

/**
 * Validate the envelope only. `metrics.hydrate` validates every row, so a bad day is
 * dropped there instead of taking the whole snapshot with it.
 *
 * @param {unknown} raw
 * @returns {{ version: 1, days: object[] } | null}
 */
export function decodeUsageStore(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = /** @type {Record<string, unknown>} */ (raw)
  /* Version 1 stored only the day buckets; its file is still readable, and the fields it
     never had are simply absent, which `metrics.hydrate` treats as empty. */
  if (value.version !== 1 && value.version !== USAGE_STORE_VERSION) return null
  if (!Array.isArray(value.days)) return null
  return {
    version: USAGE_STORE_VERSION,
    days: value.days,
    ...(Array.isArray(value.tiers) ? { tiers: value.tiers } : {}),
    ...(Array.isArray(value.sessions) ? { sessions: value.sessions } : {}),
    ...(Array.isArray(value.recent) ? { recent: value.recent } : {}),
    ...(value.counters !== null && typeof value.counters === 'object' && !Array.isArray(value.counters)
      ? { counters: value.counters }
      : {}),
  }
}

/**
 * Read the snapshot during plugin start. Synchronous on purpose: the relay must not
 * begin forwarding before the day table is loaded, or the first requests of a reload
 * could be overwritten by the hydrate that lands a tick later.
 *
 * @param {string} path
 * @returns {{ version: 1, days: object[] } | null}
 */
export function readUsageStoreSync(path) {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > USAGE_STORE_MAX_BYTES) return null
    return decodeUsageStore(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/**
 * Replace the snapshot atomically.
 *
 * @param {string} path
 * @param {{ version: 1, days: object[] }} state
 * @returns {Promise<boolean>} false when the write was refused or failed; callers keep going
 */

/**
 * The shutdown write. `writeUsageStore` is asynchronous, and a process that is exiting does not
 * await a floating promise — the last requests of a session could be lost exactly when a restart
 * is what the user is doing. This one blocks until the rename lands, and is only used on dispose.
 *
 * @param {string} path
 * @param {{ version: 2, days: object[] }} state
 * @returns {boolean} false when the write was refused or failed; callers keep going
 */
export function writeUsageStoreSync(path, state) {
  let payload
  try {
    payload = JSON.stringify(state)
  } catch {
    return false
  }
  if (Buffer.byteLength(payload, 'utf8') > USAGE_STORE_MAX_BYTES) return false
  const temp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
    return true
  } catch {
    return false
  }
}

export async function writeUsageStore(path, state) {
  let payload
  try {
    payload = JSON.stringify(state)
  } catch {
    return false
  }
  if (Buffer.byteLength(payload, 'utf8') > USAGE_STORE_MAX_BYTES) return false
  const temp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
    return true
  } catch {
    return false
  }
}
