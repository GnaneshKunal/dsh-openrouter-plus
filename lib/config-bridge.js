/**
 * dsh-openrouter-plus — provider-route bridge.
 *
 * Creates and removes `@deepseek-ai/dsh-llm-pi-ai` provider routes that point at
 * the loopback relay (`http://127.0.0.1:8791/<tier>/v1`). A new route is a clone
 * of an existing route with `baseURL` swapped for the relay, so the user can pick
 * it in the Models page / model selector — the "link it in the models page" step.
 *
 * The Host API is treated as an optional dependency: when `ctx.configEditor` is
 * absent every read returns an empty snapshot and `available()` is `false`; only
 * mutating calls throw (with a message written for the UI to display).
 *
 * Plain ESM, Node >= 20 built-ins only.
 */

import { isDeepStrictEqual } from 'node:util'

import { collectReasoningEvidence, fillReasoning, modelsMissingReasoning, normalizeReasoningEfforts } from './reasoning.js'

/** The one profile row this module edits. */
const TARGET_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'

/** Appended to a cloned route's display name. */
const DISPLAY_SUFFIX = ' — OpenRouter Plus'

/**
 * Source fields the clone must not inherit verbatim:
 * - `displayName` / `baseURL` are replaced (they are what makes the clone new);
 * - `serviceTier` is not a field of the pi-ai schema (it is exactly what the
 *   relay exists to avoid), so carrying it over would make the row invalid;
 * - `modelOverrides` is only meaningful on a catalog route, and pi-ai refuses
 *   overrides beside an explicit `models` list or on a route the catalog does
 *   not ship, which is what every clone is.
 */
const CLONE_SKIP = new Set(['baseURL', 'displayName', 'serviceTier', 'modelOverrides'])

/** Route keys become YAML dict keys and credential-relevant provider ids. */
const ROUTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** Tier names become a URL path segment, so they stay path-safe. */
const TIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Marks an error whose message is written for the user, not for a log. */
const USER_ERROR = Symbol('dsh-openrouter-plus.userError')

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** @returns {boolean} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep copy a JSON-shaped config value. @template T @param {T} value @returns {T} */
function deepCopy(value) {
  if (value === undefined) return value
  try {
    return structuredClone(value)
  } catch {
    // Structured clone refuses host objects; provider configs are JSON-shaped,
    // so the JSON round trip is the correct fallback rather than an error.
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }
}

/** User-facing error. @param {string} message @returns {Error} */
function fail(message) {
  const error = new Error(message)
  error[USER_ERROR] = true
  return error
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'unknown error'
}

/** Route display name, falling back to the route key. */
function displayOf(route, key) {
  const value = isPlainObject(route) ? route.displayName : undefined
  return typeof value === 'string' && value.trim() ? value.trim() : key
}

/** Providers dict of a config layer, never the layer itself. */
function providersOf(config) {
  return isPlainObject(config) && isPlainObject(config.providers) ? config.providers : {}
}

/** Providers visible after the inherited layer is merged under the explicit one. */
function mergeProviders(current, inherited) {
  return Object.fromEntries([
    ...Object.entries(providersOf(inherited)),
    ...Object.entries(providersOf(current)),
  ])
}

/**
 * Effective raw config for the target row: the inherited layer under the
 * explicit one, with `providers` merged key-by-key so a route that only exists
 * in an inherited layer is not lost by a write. `providers` is always emitted as
 * a plain own-keyed object (never `__proto__`-assignable).
 */
function mergedConfig(current, inherited) {
  const explicit = isPlainObject(current) ? current : {}
  const base = isPlainObject(inherited) ? inherited : {}
  const merged = { ...base, ...explicit }
  const inheritedProviders = providersOf(base)
  const explicitProviders = providersOf(explicit)
  if (Object.keys(inheritedProviders).length || Object.keys(explicitProviders).length) {
    merged.providers = mergeProviders(explicit, base)
  }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged
}

/** Strip trailing slashes so prefix tests are stable. */
function normalizeBaseURL(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

/** True when `baseURL` is the relay origin or sits underneath it (segment-safe). */
function underOrigin(baseURL, base) {
  const value = normalizeBaseURL(baseURL)
  if (!value || !base) return false
  return value === base || value.startsWith(`${base}/`)
}

/** Tier named by a relay-shaped baseURL (`<origin>/<tier>/v1`), else null. */
function tierOf(baseURL, base) {
  const value = normalizeBaseURL(baseURL)
  if (!value || !base || !underOrigin(value, base)) return null
  if (value === base) return null
  const rest = value.slice(base.length + 1).split('/')
  return rest[0] || null
}

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {(level: string, message: string, detail?: unknown) => void} [options.log]
 * @param {() => { host: string, port: number }} options.origin  live relay address
 * @param {string[]} options.tiers                               accepted tier names
 */
export function createConfigBridge(options) {
  const opts = isPlainObject(options) ? options : {}
  const ctx = opts.ctx
  const tiers = normalizeTiers(opts.tiers)
  /**
   * Reasoning filling for cloned routes: `false` disables it, `null` keeps it
   * evidence-only, a map is the blanket fallback for models with no evidence.
   */
  const reasoning = normalizeReasoningEfforts(opts.reasoningEfforts)

  /** @param {string} level @param {string} message @param {unknown} [detail] */
  function log(level, message, detail) {
    try {
      if (typeof opts.log === 'function') opts.log(level, message, detail)
    } catch {
      // Logging is diagnostic only; it must never break a bridge operation.
    }
  }

  /**
   * Resolve `ctx.configEditor` without requiring it: a direct property read on a
   * Cordis context throws when the service was not injected, so both access
   * paths are guarded and every failure means "not available".
   * @returns {any | null}
   */
  function editor() {
    if (typeof ctx !== 'object' && typeof ctx !== 'function') return null
    if (ctx === null) return null
    try {
      if (typeof ctx.get === 'function') {
        const provided = ctx.get('configEditor')
        if (provided) return provided
      }
    } catch {
      // fall through to the direct property
    }
    try {
      const direct = ctx.configEditor
      if (direct) return direct
    } catch {
      // not injected in this context
    }
    return null
  }

  /** @returns {any} */
  function requireEditor() {
    const found = editor()
    if (!found) {
      throw fail('OpenRouter Plus cannot change provider routes: the Harness configuration editor is not available in this session.')
    }
    if (typeof found.edit !== 'function' || typeof found.configuration !== 'function') {
      throw fail('OpenRouter Plus cannot change provider routes: the Harness configuration editor does not support reading and writing plugin settings.')
    }
    return found
  }

  /** Live relay origin without a trailing slash, or null when it has no address yet. */
  function relayBase() {
    let address
    try {
      address = typeof opts.origin === 'function' ? opts.origin() : undefined
    } catch {
      return null
    }
    if (!isPlainObject(address)) return null
    const host = typeof address.host === 'string' ? address.host.trim().toLowerCase() : ''
    const port = Number(address.port)
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `http://${literal}:${port}`
  }

  /** Locate the `@deepseek-ai/dsh-llm-pi-ai` profile row in a snapshot. */
  function targetRow(rows) {
    return rows.find((row) => entryName(row?.entry) === TARGET_PACKAGE)
  }

  /** Explicit layer of a row, as `configEditor.edit` will hand it to `change`. */
  function explicitOf(row) {
    const entryConfig = row?.entry?.options?.config
    if (isPlainObject(entryConfig)) return entryConfig
    if (isPlainObject(row?.override)) return row.override
    return {}
  }

  /**
   * Read the target row and both config layers.
   * @throws user-readable error when the editor cannot be read or the row is absent
   */
  function readTarget() {
    const found = requireEditor()
    let rows
    try {
      rows = found.configuration()
    } catch (error) {
      throw fail(`OpenRouter Plus cannot read the profile configuration: ${messageOf(error)}`)
    }
    const row = targetRow(Array.isArray(rows) ? rows : [])
    if (!row) {
      throw fail(`OpenRouter Plus cannot find the ${TARGET_PACKAGE} configuration in this profile, so no provider route can be linked.`)
    }
    const current = explicitOf(row)
    const inherited = isPlainObject(row.inherited) ? row.inherited : {}
    // `entry.options.config` is what the Loader hands the plugin, and a profile
    // patch's `config` replaces the inherited layer wholesale — so the explicit
    // layer alone is the config that is actually running. Reads report that layer;
    // writes merge `inherited` underneath it so a write cannot drop entries that
    // only exist in the inherited layer (see `mergedConfig`).
    return { editor: found, entry: row.entry, current, inherited, providers: providersOf(current) }
  }

  /** Non-throwing read used by `targets()` / `listRoutes()`. */
  function readTargetQuietly() {
    try {
      return readTarget()
    } catch (error) {
      log('warn', 'provider-route snapshot unavailable', messageOf(error))
      return null
    }
  }

  /**
   * Apply a change through the Loader, skipping the write when the computed next
   * config is deep-equal to the effective current one (a no-op edit would still
   * rewrite the profile patch and bounce the plugin).
   *
   * The planner runs twice by design: once against the snapshot for the no-op
   * check, and once inside `change` so validation (duplicate names, ownership)
   * is decided against the layers the Loader will actually persist.
   *
   * @param {(current: Record<string, unknown>, inherited: Record<string, unknown>) => { next: Record<string, unknown>, result: any }} plan
   * @returns {Promise<any>} the planned result
   */
  async function commit(plan) {
    const target = readTarget()
    const before = mergedConfig(target.current, target.inherited)
    const preview = plan(deepCopy(target.current), deepCopy(target.inherited))
    if (isDeepStrictEqual(preview.next, before)) {
      log('debug', 'provider-route change is a no-op; skipping write')
      return preview.result
    }
    let result = preview.result
    try {
      await target.editor.edit(target.entry, (current, inherited) => {
        const planned = plan(isPlainObject(current) ? current : {}, isPlainObject(inherited) ? inherited : {})
        result = planned.result
        return planned.next
      })
    } catch (error) {
      if (error && error[USER_ERROR]) throw error
      throw fail(`OpenRouter Plus could not save the provider-route change: ${messageOf(error)}`)
    }
    log('debug', 'provider-route change saved', result)
    return result
  }

  // -------------------------------------------------------------------------
  // public surface
  // -------------------------------------------------------------------------

  /** @returns {boolean} */
  function available() {
    return editor() !== null
  }

  /**
   * Read-only snapshot for the Models card.
   * Never throws: an unavailable editor or a missing target row yields empty
   * lists (and a `warn` log entry), so the status endpoint stays answerable.
   */
  async function targets() {
    const relayOrigin = relayBase()
    const target = readTargetQuietly()
    if (!target) return { sources: [], created: [] }
    return {
      sources: describeSources(target.providers, relayOrigin),
      created: describeCreated(target.providers, relayOrigin),
    }
  }

  /** @returns {Promise<Array<{ name: string, source: string | null, tier: string | null, baseURL: string, modelCount: number }>>} */
  async function listRoutes() {
    return (await targets()).created
  }

  /**
   * Clone `source` into a new route that points at the relay.
   * @param {{ source: string, tier: string, name?: string, displayName?: string }} input
   * @returns {Promise<{ name: string, baseURL: string, source: string, tier: string }>}
   */
  async function createRoute(input) {
    const request = isPlainObject(input) ? input : {}
    const relayOrigin = relayBase()
    return commit((current, inherited) => planCreate(request, current, inherited, relayOrigin))
  }

  /**
   * Add the missing reasoning capability to the models of every route this
   * plugin owns.
   * @returns {Promise<{ patched: Array<{ name: string, models: Array<{ id: string, from: string }> }>, unresolved: Array<{ name: string, model: string }>, owned: string[], changed: boolean }>}
   */
  async function repairRoutes() {
    const relayOrigin = relayBase()
    return commit((current, inherited) => planRepair(current, inherited, relayOrigin))
  }

  /**
   * Remove a route this plugin created (a route whose `baseURL` points at the relay).
   * @param {{ name: string }} input
   * @returns {Promise<{ name: string }>}
   */
  async function removeRoute(input) {
    const request = isPlainObject(input) ? input : {}
    const relayOrigin = relayBase()
    return commit((current, inherited) => planRemove(request, current, inherited, relayOrigin))
  }

  // -------------------------------------------------------------------------
  // planners (pure: layers in, next config out)
  // -------------------------------------------------------------------------

  function planCreate(request, current, inherited, relayOrigin) {
    if (!relayOrigin) {
      throw fail('OpenRouter Plus cannot create a provider route yet: the loopback relay has no address. Wait for the relay to start and try again.')
    }
    const providers = mergeProviders(current, inherited)
    const sourceKey = typeof request.source === 'string' ? request.source.trim() : ''
    if (!sourceKey) {
      throw fail('Choose the existing provider route to copy before linking a new one.')
    }
    const sourceRoute = Object.hasOwn(providers, sourceKey) ? providers[sourceKey] : undefined
    if (sourceRoute === undefined) {
      const known = Object.keys(providers)
      throw fail(known.length
        ? `Provider route "${sourceKey}" does not exist in the ${TARGET_PACKAGE} configuration. Existing routes: ${known.join(', ')}.`
        : `There is no provider route to copy: the ${TARGET_PACKAGE} configuration has no routes yet. Add one in Models settings first.`)
    }

    const tier = resolveTier(request.tier)

    const requestedName = typeof request.name === 'string' ? request.name.trim() : ''
    const name = requestedName || `${sourceKey}-${tier}`
    assertRouteName(name, providers)

    const displayName = typeof request.displayName === 'string' && request.displayName.trim()
      ? request.displayName.trim()
      : `${displayOf(sourceRoute, sourceKey)} (${tier})${DISPLAY_SUFFIX}`
    const baseURL = `${relayOrigin}/${tier}/v1`
    const cloned = cloneRoute(sourceRoute, baseURL, displayName)
    // A provider key the installed catalog does not know gets no reasoning
    // capability by inheritance, so the clone carries one explicitly.
    // Even with filling disabled, name the models that will show no effort
    // selector: that is the operator's only signal that something is missing.
    const filled = reasoning === false
      ? { route: cloned, filled: [], unresolved: modelsMissingReasoning(cloned) }
      : fillReasoning(cloned, { evidence: collectReasoningEvidence(providers), fallback: reasoning })

    const next = {
      ...mergedConfig(current, inherited),
      providers: Object.fromEntries([...Object.entries(providers), [name, filled.route]]),
    }
    return {
      next,
      result: {
        name,
        baseURL,
        source: sourceKey,
        tier,
        reasoning: { filled: filled.filled, unresolved: filled.unresolved },
      },
    }
  }

  function planRemove(request, current, inherited, relayOrigin) {
    const requested = typeof request.name === 'string' ? request.name.trim() : ''
    if (!requested) throw fail('A provider route name is required to remove one.')
    if (!relayOrigin) {
      throw fail('OpenRouter Plus cannot remove a provider route right now: the loopback relay has no address, so it cannot tell which routes it owns.')
    }

    const providers = mergeProviders(current, inherited)
    let key = Object.hasOwn(providers, requested) ? requested : undefined
    if (key === undefined) {
      key = Object.keys(providers).find((candidate) => candidate.trim() === requested)
    }
    if (key === undefined) {
      throw fail(`No provider route named "${requested}" is configured, so there is nothing to remove.`)
    }

    const route = isPlainObject(providers[key]) ? providers[key] : {}
    const baseURL = typeof route.baseURL === 'string' ? route.baseURL.trim() : ''
    if (!underOrigin(baseURL, relayOrigin)) {
      const shown = baseURL ? `"${baseURL}"` : 'no baseURL'
      throw fail(`Provider route "${key}" is not managed by OpenRouter Plus (its baseURL is ${shown}, not the local relay at ${relayOrigin}), so it will not be removed. Edit or remove it in the Models settings page instead.`)
    }

    const remaining = Object.fromEntries(Object.entries(providers).filter(([other]) => other !== key))
    const next = { ...mergedConfig(current, inherited), providers: remaining }
    return { next, result: { name: key } }
  }

  /**
   * Add a reasoning capability to every model of every route this plugin owns
   * that is missing one. Routes pointing anywhere else are never touched: a
   * hand-written route is the operator's own business.
   *
   * Models that already declare a usable map are left byte-identical, and when
   * nothing can be resolved the plan leaves them alone rather than guessing.
   */
  function planRepair(current, inherited, relayOrigin) {
    if (!relayOrigin) {
      throw fail('OpenRouter Plus cannot repair provider routes right now: the loopback relay has no address, so it cannot tell which routes it owns.')
    }
    const providers = mergeProviders(current, inherited)
    const evidence = collectReasoningEvidence(providers)
    const patched = []
    const unresolved = []
    const owned = []
    /** @type {Record<string, any>} */
    const nextProviders = {}
    for (const [name, value] of Object.entries(providers)) {
      const route = isPlainObject(value) ? value : {}
      const baseURL = typeof route.baseURL === 'string' ? route.baseURL.trim() : ''
      if (!underOrigin(baseURL, relayOrigin)) {
        nextProviders[name] = value
        continue
      }
      owned.push(name)
      const missing = modelsMissingReasoning(route)
      if (missing.length === 0) {
        nextProviders[name] = value
        continue
      }
      const filled = reasoning === false
        ? { route: deepCopy(route), filled: [], unresolved: missing }
        : fillReasoning(route, { evidence, fallback: reasoning })
      if (filled.filled.length > 0) patched.push({ name, models: filled.filled })
      for (const id of filled.unresolved) unresolved.push({ name, model: id })
      nextProviders[name] = filled.filled.length > 0 ? filled.route : value
    }
    // Always return a full config: `commit` skips the write when it deep-equals
    // the snapshot, which is exactly the "nothing to repair" path.
    const next = { ...mergedConfig(current, inherited), providers: nextProviders }
    return { next, result: { patched, unresolved, owned, changed: patched.length > 0 } }
  }

  /** Accept a configured tier, case-insensitively, and return its canonical spelling. */
  function resolveTier(value) {
    const requested = typeof value === 'string' ? value.trim() : ''
    if (!tiers.length) {
      throw fail('OpenRouter Plus has no service tiers enabled, so no route can be linked. Enable at least one tier in the plugin settings.')
    }
    const tier = tiers.find((candidate) => candidate.toLowerCase() === requested.toLowerCase())
    if (tier === undefined) {
      throw fail(requested
        ? `Service tier "${requested}" is not enabled. Choose one of: ${tiers.join(', ')}.`
        : `Choose a service tier before linking a route: ${tiers.join(', ')}.`)
    }
    return tier
  }

  /** Reject unusable and colliding route keys with a message the UI can show. */
  function assertRouteName(name, providers) {
    if (!name) throw fail('A provider route name is required.')
    if (!ROUTE_NAME_PATTERN.test(name)) {
      throw fail(`Provider route name "${name}" is not usable: use letters, digits, dots, dashes, underscores or colons, starting with a letter or a digit.`)
    }
    const exact = Object.hasOwn(providers, name)
    if (exact) {
      throw fail(`A provider route named "${name}" already exists. Choose another name, or remove the existing route first.`)
    }
    const trimmedClash = Object.keys(providers).find((candidate) => candidate.trim() === name)
    if (trimmedClash !== undefined) {
      throw fail(`Provider route name "${name}" collides with the existing route "${trimmedClash}" once surrounding whitespace is ignored. Choose another name.`)
    }
  }

  /** @returns {{ sources: any[], created: any[] }} */
  function describeSources(providers, base) {
    return Object.entries(providers).map(([key, value]) => {
      const route = isPlainObject(value) ? value : {}
      const baseURL = typeof route.baseURL === 'string' && route.baseURL.trim() ? route.baseURL : null
      const source = {
        key,
        displayName: displayOf(route, key),
        api: typeof route.api === 'string' && route.api ? route.api : null,
        apiKeyEnv: typeof route.apiKeyEnv === 'string' && route.apiKeyEnv ? route.apiKeyEnv : null,
        baseURL,
        modelCount: Array.isArray(route.models) ? route.models.length : 0,
      }
      const attachedTier = tierOf(baseURL, base)
      if (attachedTier) source.attachedTier = attachedTier
      return source
    })
  }

  function describeCreated(providers, base) {
    const created = []
    for (const [name, value] of Object.entries(providers)) {
      const route = isPlainObject(value) ? value : {}
      const baseURL = typeof route.baseURL === 'string' ? route.baseURL : ''
      const tier = tierOf(baseURL, base)
      if (!tier) continue // not pointing at this relay: not ours
      created.push({
        name,
        source: inferSource(name, route, tier, providers),
        tier,
        baseURL,
        modelCount: Array.isArray(route.models) ? route.models.length : 0,
        // The composer shows no effort selector for these; the card offers the fix.
        missingReasoning: modelsMissingReasoning(route).length,
      })
    }
    return created
  }

  return { available, targets, createRoute, removeRoute, repairRoutes, listRoutes, reasoning }
}

// ---------------------------------------------------------------------------
// module-level helpers
// ---------------------------------------------------------------------------

/** Plugin package name of a Loader entry, tolerant of both entry shapes. */
function entryName(entry) {
  if (!entry) return ''
  const direct = entry.name
  if (typeof direct === 'string' && direct) return direct
  const fromOptions = entry.options && entry.options.name
  return typeof fromOptions === 'string' ? fromOptions : ''
}

/** @returns {string[]} */
function normalizeTiers(input) {
  const seen = new Set()
  const tiers = []
  for (const value of Array.isArray(input) ? input : []) {
    if (typeof value !== 'string') continue
    const tier = value.trim()
    if (!tier || !TIER_PATTERN.test(tier) || seen.has(tier)) continue
    seen.add(tier)
    tiers.push(tier)
  }
  return tiers
}

/**
 * Clone a source route for the relay: fields verbatim and deep-copied, with
 * `displayName` replaced, `baseURL` pointed at `<relay>/<tier>/v1`, and the
 * non-transferable fields dropped.
 */
function cloneRoute(sourceRoute, baseURL, displayName) {
  const from = isPlainObject(sourceRoute) ? sourceRoute : {}
  const route = { displayName }
  let replacedBaseURL = false
  for (const [key, value] of Object.entries(from)) {
    if (key === 'baseURL') {
      route.baseURL = baseURL
      replacedBaseURL = true
      continue
    }
    if (key === 'displayName' || value === undefined) continue
    if (CLONE_SKIP.has(key)) continue
    route[key] = deepCopy(value)
  }
  if (!replacedBaseURL) route.baseURL = baseURL
  return route
}

/**
 * Recover which route a created route was cloned from.
 *
 * A clone keeps no metadata field (the pi-ai provider schema is closed), so the
 * source is inferred from what the clone can carry: the default `${source}-${tier}`
 * suffix, or the `"<source display> (<tier>) — OpenRouter Plus"` display name.
 * Both are recoverable for routes this module created; a custom `name` paired
 * with a custom `displayName` is genuinely unattributable and yields `null`, as
 * is a clone whose source route has since been renamed away.
 *
 * @returns {string | null}
 */
function inferSource(name, route, tier, providers) {
  const suffix = `-${tier}`
  if (name.endsWith(suffix) && name.length > suffix.length) {
    const candidate = name.slice(0, -suffix.length)
    // Only name a route that still exists: a stale key would mislead the card.
    if (Object.hasOwn(providers, candidate)) return candidate
  }
  const shaped = ` (${tier})${DISPLAY_SUFFIX}`
  const display = typeof route.displayName === 'string' ? route.displayName : ''
  if (display.endsWith(shaped)) {
    const sourceDisplay = display.slice(0, -shaped.length).trim()
    if (sourceDisplay) {
      if (Object.hasOwn(providers, sourceDisplay)) return sourceDisplay
      const byDisplay = Object.entries(providers).find(([, value]) => {
        return isPlainObject(value) && typeof value.displayName === 'string' && value.displayName.trim() === sourceDisplay
      })
      return byDisplay ? byDisplay[0] : null
    }
  }
  return null
}
