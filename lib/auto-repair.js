/**
 * Debounced repair scheduler.
 *
 * Why this exists: a relay route's `reasoningEfforts` lives on the profile's
 * route, and one shipped editor rewrites those rows from its catalog. Picking a
 * model in Settings → Models rebuilds the row as `{ id, name, contextWindow,
 * maxTokens, input }` — every hand-declared field, the capability included, is
 * dropped (see docs/ARCHITECTURE.md, "auto-repair"). The relay page can offer a
 * button, but the operator is in the Models page when it happens, so the fill has
 * to happen on its own.
 *
 * Contract: profiles reload in bursts (one edit can reconcile several writes), so
 * `schedule()` coalesces; a pass that is already running keeps its result and one
 * more pass runs afterwards, which is how a change landing mid-pass still gets
 * repaired. Every call is idempotent upstream (see `planRepair`), so the extra
 * pass writes nothing.
 *
 * Pure: no timers of its own — `setTimer`/`clearTimer` are injectable so tests
 * drive time instead of sleeping.
 */

/**
 * @typedef {object} AutoRepairOptions
 * @property {() => Promise<{ patched: Array<{ name: string }>, changed?: boolean }>} repair
 *   one repair pass; may throw, which is reported and swallowed
 * @property {(result: { patched: Array<{ name: string }> }) => void} [onPatched]
 *   called only when a pass actually wrote something
 * @property {(error: unknown) => void} [onError]
 * @property {number} [delayMs] quiet period after the last trigger
 * @property {(callback: () => void, delayMs: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * @param {AutoRepairOptions} options
 * @returns {{
 *   schedule: () => void,
 *   flush: () => Promise<void>,
 *   dispose: () => void,
 *   readonly pending: boolean,
 *   readonly running: boolean,
 * }}
 */
export function createAutoRepair(options) {
  const repair = options.repair
  const onPatched = options.onPatched ?? (() => {})
  const onError = options.onError ?? (() => {})
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0 ? options.delayMs : 500
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(/** @type {any} */ (handle)))

  /** @type {unknown} */
  let handle = null
  let running = false
  let disposed = false

  function cancel() {
    if (handle === null) return
    clearTimer(handle)
    handle = null
  }

  function schedule() {
    if (disposed) return
    cancel()
    handle = setTimer(() => {
      handle = null
      void run()
    }, delayMs)
  }

  async function run() {
    if (disposed) return
    if (running) {
      // A pass is in flight and its snapshot cannot contain what just arrived:
      // queue one more instead of overlapping two config writes.
      schedule()
      return
    }
    running = true
    try {
      const result = await repair()
      if (disposed) return
      if (result && Array.isArray(result.patched) && result.patched.length > 0) onPatched(result)
    } catch (error) {
      if (!disposed) onError(error)
    } finally {
      running = false
    }
  }

  return {
    schedule,
    /** Run now, dropping a scheduled pass: startup and tests. */
    async flush() {
      cancel()
      await run()
    },
    dispose() {
      disposed = true
      cancel()
    },
    get pending() {
      return handle !== null
    },
    get running() {
      return running
    },
  }
}
