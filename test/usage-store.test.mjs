/**
 * Unit tests for the persisted cost rollup.
 *
 * Every test writes into a fresh temp directory. The store's job is to survive a crash
 * and an unreadable file, so the failure cases are the interesting half: a bad snapshot
 * must cost a user their history, never their Host boot.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import {
  USAGE_STORE_MAX_BYTES,
  USAGE_STORE_VERSION,
  decodeUsageStore,
  readUsageStoreSync,
  usageStorePath,
  writeUsageStore,
} from '../lib/usage-store.js'

/** @type {string[]} */
const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fresh, empty directory that the suite removes afterwards. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'oorp-usage-'))
  tempDirs.push(dir)
  return dir
}

/** The path the plugin would use for a `$DSH_HOME` at `dir`. */
function storePathFor(dir) {
  return join(dir, 'storages', 'dsh-openrouter-plus', 'usage.json')
}

test('decodeUsageStore accepts the current envelope and the day-only one', () => {
  const days = [{ date: '2026-10-29', requests: 1 }]
  assert.equal(USAGE_STORE_VERSION, 2)
  assert.deepEqual(decodeUsageStore({ version: USAGE_STORE_VERSION, days }), { version: 2, days })
  /* Version 1 is the day-bucket-only file; a reload after the upgrade must still read it. */
  assert.deepEqual(decodeUsageStore({ version: 1, days }), { version: 2, days })

  assert.equal(decodeUsageStore(null), null)
  assert.equal(decodeUsageStore([]), null, 'an array is not an envelope')
  assert.equal(decodeUsageStore('{"version":2,"days":[]}'), null, 'a string is not decoded state')
  assert.equal(decodeUsageStore({ days }), null, 'a missing version is not guessed at')
  for (const version of [0, 3, '2']) {
    assert.equal(decodeUsageStore({ version, days }), null, `version ${String(version)} is not this file`)
  }
  assert.equal(decodeUsageStore({ version: USAGE_STORE_VERSION }), null)
  assert.equal(decodeUsageStore({ version: USAGE_STORE_VERSION, days: {} }), null)
})

test('readUsageStoreSync treats a missing, corrupt or oversized file as no history', () => {
  const path = storePathFor(tempDir())
  assert.equal(readUsageStoreSync(path), null, 'a missing file means a first run')

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'not json at all')
  assert.equal(readUsageStoreSync(path), null, 'malformed JSON')

  writeFileSync(path, JSON.stringify({ version: 3, days: [] }))
  assert.equal(readUsageStoreSync(path), null, 'a version this build does not know')

  writeFileSync(path, 'x'.repeat(USAGE_STORE_MAX_BYTES + 1))
  assert.equal(readUsageStoreSync(path), null, 'the size check refuses before parsing 256 KiB of nonsense')

  assert.equal(readUsageStoreSync(dirname(path)), null, 'a directory is not a snapshot')

  writeFileSync(path, JSON.stringify({ version: 2, days: [{ date: '2026-10-29' }] }))
  assert.deepEqual(readUsageStoreSync(path), { version: 2, days: [{ date: '2026-10-29' }] })
})

test('writeUsageStore creates the directory and replaces the file atomically at mode 0600', async () => {
  const path = storePathFor(tempDir())
  const first = {
    version: 2,
    days: [
      {
        date: '2026-10-28',
        requests: 1,
        promptTokens: 2,
        completionTokens: 3,
        costUsd: 0.125,
        models: [],
      },
    ],
  }
  assert.equal(await writeUsageStore(path, first), true)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the snapshot is readable by its owner only')
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(first), 'the payload is the snapshot, verbatim')

  const second = { version: 1, days: [] }
  assert.equal(await writeUsageStore(path, second), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), second, 'the new snapshot replaced the old one')
  // The temp file is renamed away, not left beside the real one: a reader can only ever
  // see a complete snapshot.
  assert.deepEqual(readdirSync(dirname(path)), ['usage.json'])
})

test('writeUsageStore refuses an oversized or unserialisable snapshot without touching the file', async () => {
  const path = storePathFor(tempDir())
  assert.equal(await writeUsageStore(path, { version: 1, days: [] }), true)
  const before = readFileSync(path, 'utf8')

  const oversized = {
    version: 1,
    days: [
      {
        date: '2026-10-29',
        requests: 1,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        models: [{ model: 'm'.repeat(USAGE_STORE_MAX_BYTES) }],
      },
    ],
  }
  assert.equal(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > USAGE_STORE_MAX_BYTES, true, 'the fixture is over the cap')
  assert.equal(await writeUsageStore(path, oversized), false)
  assert.equal(readFileSync(path, 'utf8'), before, 'a refused write leaves the previous snapshot in place')
  assert.deepEqual(readdirSync(dirname(path)), ['usage.json'], 'and leaves no temp file behind')

  const cyclic = { version: 1, days: [] }
  cyclic.self = cyclic
  assert.equal(await writeUsageStore(path, cyclic), false, 'an unencodable snapshot is a skipped write, not a throw')
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('a failed write answers false: callers keep serving', async () => {
  const dir = tempDir()
  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, 'not a directory')
  // The parent of the snapshot cannot be created, which is what a read-only or
  // already-damaged home looks like from here.
  assert.equal(await writeUsageStore(join(blocker, 'usage.json'), { version: 1, days: [] }), false)
})

test('a written snapshot round-trips through read and decode', async () => {
  const path = storePathFor(tempDir())
  const state = {
    version: 2,
    days: [
      {
        date: '2026-10-29',
        requests: 2,
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.00042,
        models: [
          {
            model: 'deepseek/deepseek-v4.1-flash',
            requests: 2,
            promptTokens: 10,
            completionTokens: 5,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
            costUsd: 0.00042,
          },
        ],
      },
    ],
  }

  assert.equal(await writeUsageStore(path, state), true)
  assert.deepEqual(readUsageStoreSync(path), state)
  assert.deepEqual(decodeUsageStore(JSON.parse(readFileSync(path, 'utf8'))), state)
})

test('usageStorePath follows DSH_HOME and falls back to the Host default', () => {
  assert.equal(usageStorePath({ DSH_HOME: '/tmp/example-home' }), join('/tmp/example-home', 'storages', 'dsh-openrouter-plus', 'usage.json'))
  // The fallback is the Host's own default home, which is where the profile lives.
  assert.equal(usageStorePath({}).endsWith(join('storages', 'dsh-openrouter-plus', 'usage.json')), true)
  assert.equal(usageStorePath({ DSH_HOME: '   ' }).endsWith(join('storages', 'dsh-openrouter-plus', 'usage.json')), true)
})
