import assert from 'node:assert/strict'
import test from 'node:test'

import { createAutoRepair } from '../lib/auto-repair.js'

/** A clock the test drives by hand, so a debounce is a function call rather than a sleep. */
function fakeClock() {
  let next = 0
  /** @type {Map<number, { callback: () => void, delayMs: number }>} */
  const timers = new Map()
  return {
    setTimer(callback, delayMs) {
      const handle = ++next
      timers.set(handle, { callback, delayMs })
      return handle
    },
    clearTimer(handle) {
      timers.delete(handle)
    },
    get size() {
      return timers.size
    },
    /** Fire every armed timer once, in arm order. */
    fire() {
      const armed = [...timers.entries()]
      timers.clear()
      for (const [, timer] of armed) timer.callback()
      return armed.length
    },
  }
}

/** Let a scheduled async pass settle: `run()` is `void`ed by the timer. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

/** @param {object} [options] */
function harness(options = {}) {
  const clock = fakeClock()
  const calls = []
  const patched = []
  const errors = []
  const repair =
    options.repair ??
    (async () => {
      calls.push(Date.now())
      return { patched: [], changed: false }
    })
  const scheduler = createAutoRepair({
    repair,
    onPatched: (result) => patched.push(result),
    onError: (error) => errors.push(error),
    delayMs: 500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, calls, patched, errors, scheduler }
}

test('a burst of triggers runs one repair pass', async () => {
  const { clock, calls, scheduler } = harness()
  scheduler.schedule()
  scheduler.schedule()
  scheduler.schedule()
  assert.equal(clock.size, 1, 'the pending timer is replaced, not multiplied')
  clock.fire()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(scheduler.pending, false)
})

test('the quiet period is the configured delay', async () => {
  const clock = fakeClock()
  const seen = []
  const scheduler = createAutoRepair({
    repair: async () => ({ patched: [] }),
    delayMs: 750,
    setTimer: (callback, delayMs) => {
      seen.push(delayMs)
      return clock.setTimer(callback, delayMs)
    },
    clearTimer: clock.clearTimer,
  })
  scheduler.schedule()
  assert.deepEqual(seen, [750])
})

test('nothing is repaired until the quiet period elapses', async () => {
  const { calls, scheduler } = harness()
  scheduler.schedule()
  await settle()
  assert.equal(calls.length, 0, 'a scheduled pass must not run eagerly')
  assert.equal(scheduler.pending, true)
})

test('a pass is not overlapped; a trigger during one queues exactly one follow-up', async () => {
  /** @type {Array<() => void>} */
  const release = []
  const starts = []
  const clock = fakeClock()
  const scheduler = createAutoRepair({
    repair: () => {
      starts.push(starts.length + 1)
      return new Promise((resolve) => {
        release.push(() => resolve({ patched: [] }))
      })
    },
    delayMs: 500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  void scheduler.flush()
  await settle()
  assert.equal(starts.length, 1)
  assert.equal(scheduler.running, true)

  // Two triggers arrive while the first write is in flight.
  scheduler.schedule()
  scheduler.schedule()
  assert.equal(clock.size, 1, 'both collapse into one queued pass')

  release[0]()
  await settle()
  assert.equal(scheduler.running, false)
  assert.equal(starts.length, 1, 'the queued pass waits for the quiet period')

  clock.fire()
  await settle()
  assert.equal(starts.length, 2)
  release[1]()
  await settle()
  assert.equal(scheduler.running, false)
})

test('onPatched fires only for a pass that wrote something', async () => {
  let pass = 0
  const { clock, patched, scheduler } = harness({
    repair: async () => {
      pass += 1
      return pass === 1 ? { patched: [], changed: false } : { patched: [{ name: 'openrouter-custom-flex', models: [] }], changed: true }
    },
  })
  scheduler.schedule()
  clock.fire()
  await settle()
  assert.equal(patched.length, 0)

  scheduler.schedule()
  clock.fire()
  await settle()
  assert.equal(patched.length, 1)
  assert.equal(patched[0].patched[0].name, 'openrouter-custom-flex')
})

test('a failing pass is reported and does not reject the scheduler', async () => {
  const failure = new Error('configEditor is unavailable')
  const { clock, errors, scheduler } = harness({
    repair: async () => {
      throw failure
    },
  })
  scheduler.schedule()
  clock.fire()
  await settle()
  assert.deepEqual(errors, [failure])
  assert.equal(scheduler.running, false)

  // The next trigger still works.
  scheduler.schedule()
  clock.fire()
  await settle()
  assert.equal(errors.length, 2)
})

test('flush drops a pending pass and runs once', async () => {
  const { clock, calls, scheduler } = harness()
  scheduler.schedule()
  assert.equal(clock.size, 1)
  await scheduler.flush()
  assert.equal(calls.length, 1)
  assert.equal(clock.size, 0)
  assert.equal(clock.fire(), 0, 'the cancelled timer never fires')
})

test('dispose cancels the pending pass and refuses new work', async () => {
  const { clock, calls, scheduler } = harness()
  scheduler.schedule()
  scheduler.dispose()
  assert.equal(clock.size, 0)
  scheduler.schedule()
  assert.equal(clock.size, 0, 'a disposed scheduler arms nothing')
  await settle()
  assert.equal(calls.length, 0)
})

test('dispose during an in-flight pass suppresses its result', async () => {
  /** @type {Array<() => void>} */
  const release = []
  const world = harness({
    repair: () =>
      new Promise((resolve) => {
        release.push(() => resolve({ patched: [{ name: 'route' }], changed: true }))
      }),
  })
  void world.scheduler.flush()
  await settle()
  world.scheduler.dispose()
  release[0]()
  await settle()
  assert.equal(world.patched.length, 0, 'unloading the plugin must not report into a dead scope')
})
