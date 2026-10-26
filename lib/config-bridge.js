/**
 * dsh-openrouter-plus — provider-route bridge.
 *
 * Creates and removes `@deepseek-ai/dsh-llm-pi-ai` provider routes that point at
 * the loopback relay (`http://127.0.0.1:8791/<tier>/v1`). A new route is a clone
 * of an existing route with `baseURL` swapped for the relay, so the user can pick
 * it in the Models page / model selector — the "link it in the models page" step.
 *
 * It also *repoints* a provider the user created through the normal custom-provider
 * flow onto a relay mount (so the traffic picks up a service tier there) and
 * *restores* it to its recorded upstream afterwards. Both only ever rewrite
 * `baseURL`: the provider entry itself stays exactly as `dsh-llm-pi-ai` expects,
 * because that schema validates it — which is where the plugin's bookkeeping
 * (target, original upstream, tier) must not go.
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

/** An API version segment (`v1`, `v2`), never a service tier. */
const API_VERSION_PATTERN = /^v\d+$/

/** Path segment that introduces a per-target relay mount. */
const TARGET_MOUNT_SEGMENT = 't'

/** Control surface prefix, tolerated in front of a mount. */
const CONTROL_SEGMENT = '__openrouter-plus'

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

/**
 * Decompose the relay-shaped part of a base URL.
 *
 * The relay answers two families of routes, and only one of them starts with a
 * tier:
 *  - legacy adapter legs, `<origin>/<tier>/v1` — the first segment is the tier;
 *  - per-target mounts, `<origin>/t/<targetId>/<tier>/v1`, and the tierless
 *    `<origin>/t/<targetId>/v1` that pins nothing — there the tier sits after the
 *    target id, and `t` itself is never a tier.
 * (An `__openrouter-plus` prefix in front of a mount is tolerated, so both
 * documented spellings parse the same way.)
 *
 * @param {string} baseURL
 * @param {string} base  relay origin, e.g. `http://127.0.0.1:8791`
 * @returns {{ tier: string | null, targetId: string | null } | null}
 *   null when the base URL is not a route on this relay at all
 */
function relayRouteOf(baseURL, base) {
  const origin = normalizeBaseURL(base)
  const value = normalizeBaseURL(baseURL)
  if (!value || !origin || !underOrigin(value, origin) || value === origin) return null
  let rest = value.slice(origin.length + 1).split('/').filter(Boolean)
  if (rest[0] === CONTROL_SEGMENT) rest = rest.slice(1)
  if (rest.length === 0) return null
  // A bare `/t` is a mount with no target id: it still pins no tier, so the
  // `t` of `/t/...` must never fall through to the legacy first-segment parse.
  if (rest[0] === TARGET_MOUNT_SEGMENT) {
    if (rest.length < 2) return { tier: null, targetId: null }
    // Same reading as the relay's own mount parser: `<origin>/t/<id>/v1` pins no
    // tier (the third segment is the API version), and only `/t/<id>/<tier>/v1`
    // names one. A mount the relay would 404 reads as no tier, not an invented one.
    const maybeTier = rest[2]
    const version = rest[3]
    const tier = maybeTier
      && !API_VERSION_PATTERN.test(maybeTier)
      && TIER_PATTERN.test(maybeTier)
      && version !== undefined
      && API_VERSION_PATTERN.test(version)
      ? maybeTier
      : null
    return { tier, targetId: rest[1] || null }
  }
  const tier = !TIER_PATTERN.test(rest[0]) || API_VERSION_PATTERN.test(rest[0]) ? null : rest[0]
  return { tier, targetId: null }
}

/** Tier named by a relay-shaped base URL, else null — never the `t` of a mount. */
function tierOf(baseURL, base) {
  return relayRouteOf(baseURL, base)?.tier ?? null
}

/** Target id named by a `/t/<id>/…` mount, else null. */
function targetOf(baseURL, base) {
  return relayRouteOf(baseURL, base)?.targetId ?? null
}

/**
 * True when both URLs are mounts of the same relay target, i.e. the move only
 * changes which tier is pinned (`/t/<id>/v1`, `/t/<id>/flex/v1`, …). A legacy
 * catalog leg (`<origin>/flex/v1`) names no target, so it never matches.
 */
function sameRelayTarget(from, to, base) {
  const current = relayRouteOf(from, base)
  const target = relayRouteOf(to, base)
  return current !== null
    && target !== null
    && current.targetId !== null
    && current.targetId === target.targetId
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

  /**
   * Point a provider route the user created at another base URL — normally a relay
   * mount, so the traffic picks up the service tier that mount pins. Only
   * `baseURL` changes, and no plugin field is written into the entry.
   * @param {{ route: string, baseURL: string }} input
   * @returns {Promise<{ name: string, from: string | null, to: string, changed: boolean }>}
   */
  async function repointRoute(input) {
    const request = isPlainObject(input) ? input : {}
    const relayOrigin = relayBase()
    return commit((current, inherited) => planRepoint(current, inherited, request, relayOrigin))
  }

  /**
   * Move a relay-backed route back to the upstream recorded for it: the inverse of
   * `repointRoute`, and the only path allowed to take a route off the relay.
   * @param {{ route: string, baseURL: string }} input
   * @returns {Promise<{ name: string, from: string | null, to: string, changed: boolean }>}
   */
  async function restoreRoute(input) {
    const request = isPlainObject(input) ? input : {}
    const relayOrigin = relayBase()
    return commit((current, inherited) => planRestore(current, inherited, request, relayOrigin))
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
      const targetId = targetOf(baseURL, base)
      if (targetId) source.targetId = targetId
      return source
    })
  }

  function describeCreated(providers, base) {
    const created = []
    for (const [name, value] of Object.entries(providers)) {
      const route = isPlainObject(value) ? value : {}
      const baseURL = typeof route.baseURL === 'string' ? route.baseURL : ''
      const relayRoute = relayRouteOf(baseURL, base)
      // Ownership is the prefix test, never the tier: a target mount may pin no
      // tier at all (`/t/<id>/v1`) and is still ours to repair.
      if (!relayRoute) continue
      const { tier, targetId } = relayRoute
      const entry = {
        name,
        // A target mount is a pointing-at-the-relay artefact, not a clone: there is
        // no `${source}-${tier}` route for it to have been derived from.
        source: targetId ? null : inferSource(name, route, tier, providers),
        tier,
        baseURL,
        modelCount: Array.isArray(route.models) ? route.models.length : 0,
        // The composer shows no effort selector for these; the card offers the fix.
        missingReasoning: modelsMissingReasoning(route).length,
      }
      if (targetId) entry.targetId = targetId
      created.push(entry)
    }
    return created
  }

  return { available, targets, createRoute, removeRoute, repairRoutes, repointRoute, restoreRoute, listRoutes, reasoning }
}

// ---------------------------------------------------------------------------
// repoint / restore planners (pure: layers in, next config out)
// ---------------------------------------------------------------------------

/**
 * Validate an absolute http(s) base URL and return it trimmed, or `null` when it
 * is unusable. A relay route (`<origin>/<mount>/<tier>/v1`) and a provider's own
 * upstream are both plain absolute URLs, so one check covers both.
 */
function absoluteBaseURL(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return trimmed
  } catch {
    return null
  }
}

/**
 * Resolve the route key the caller named. An exact key wins; a key that differs
 * only by surrounding whitespace is still accepted, because YAML dict keys are
 * easy to mistype in a settings form. Anything else is refused with the keys that
 * do exist, so the message tells the user what to pick instead.
 *
 * @param {Record<string, unknown>} providers
 * @param {unknown} requested
 * @param {'repoint' | 'restore'} action
 * @returns {string}
 */
function routeKeyOf(providers, requested, action) {
  const want = typeof requested === 'string' ? requested.trim() : ''
  if (!want) throw fail(`A provider route name is required to ${action} one.`)
  if (Object.hasOwn(providers, want)) return want
  const loose = Object.keys(providers).find((candidate) => candidate.trim() === want)
  if (loose !== undefined) return loose
  const known = Object.keys(providers)
  throw fail(known.length
    ? `Provider route "${want}" is not configured in ${TARGET_PACKAGE}, so there is nothing to ${action}. Existing routes: ${known.join(', ')}.`
    : `There is no provider route to ${action}: the ${TARGET_PACKAGE} configuration has no routes yet. Add one in Models settings first.`)
}

/**
 * The valid, trimmed base URL a caller asked for, refused with a message that says
 * what the URL was meant to do.
 *
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @param {'repoint' | 'restore'} action
 * @returns {string}
 */
function requestedBaseURL(input, key, action) {
  const raw = typeof input.baseURL === 'string' ? input.baseURL.trim() : ''
  if (!raw) {
    throw fail(action === 'restore'
      ? `Enter the base URL that provider route "${key}" should be restored to.`
      : `Enter the base URL that provider route "${key}" should point at.`)
  }
  const parsed = absoluteBaseURL(raw)
  if (parsed === null) {
    throw fail(`The base URL "${raw}" is not usable: enter an absolute http:// or https:// URL.`)
  }
  return parsed
}

/**
 * The relay serves tier mounts, never its bare origin, so pointing a provider at
 * the origin alone would hand the relay a path it cannot answer: refuse it.
 */
function assertNotRelayOrigin(baseURL, key, relayOrigin) {
  if (normalizeBaseURL(baseURL) !== normalizeBaseURL(relayOrigin)) return
  throw fail(`Refusing to point provider route "${key}" at the OpenRouter Plus relay itself (${relayOrigin}): the relay serves mounts such as ${relayOrigin}/<tier>/v1, not its bare origin.`)
}

/** The route's current base URL, trimmed, or `''` when it declares none. */
function baseURLOf(route) {
  const value = isPlainObject(route) ? route.baseURL : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Next config with `providers[key].baseURL` replaced and every other field of the
 * entry copied as-is. No plugin field is added: `dsh-llm-pi-ai` validates these
 * objects, so bookkeeping (target, original upstream, tier) belongs in this
 * plugin's own config, never inside the provider entry.
 */
function withBaseURL(current, inherited, providers, key, baseURL) {
  const nextProviders = deepCopy(providers)
  const existing = isPlainObject(nextProviders[key]) ? nextProviders[key] : {}
  nextProviders[key] = { ...existing, baseURL }
  return { ...mergedConfig(current, inherited), providers: nextProviders }
}

/**
 * Finish a repoint/restore plan. When the route already reads as the requested
 * base URL the effective config is returned untouched, so `commit` finds a no-op
 * and skips the write — the same contract `planRepair` follows.
 */
function baseURLPlan(current, inherited, providers, key, from, to) {
  const changed = normalizeBaseURL(from) !== normalizeBaseURL(to)
  return {
    next: changed
      ? withBaseURL(current, inherited, providers, key, to)
      : { ...mergedConfig(current, inherited), providers: deepCopy(providers) },
    result: { name: key, from: from || null, to, changed },
  }
}

/**
 * Point an existing provider route at a new base URL — normally a relay mount, so
 * that traffic picks up the service tier the mount pins — and leave everything
 * else about the route byte-identical.
 *
 * Refused here: a route the plugin itself created (its base URL is already under
 * the relay origin), because rewriting it would fight whoever owns it; that route
 * has to be repointed through `planCreate`/`planRepair` or removed first.
 *
 * Pure: `relayOrigin` is passed in rather than read from the relay, so the
 * ownership test is reproducible and the function touches no I/O.
 *
 * @param {Record<string, unknown>} current    explicit patch layer
 * @param {Record<string, unknown>} inherited  layer underneath it
 * @param {{ route?: string, baseURL?: string }} request
 * @param {string} relayOrigin                 e.g. `http://127.0.0.1:8791`
 * @returns {{ next: Record<string, unknown>, result: { name: string, from: string | null, to: string, changed: boolean } }}
 */
export function planRepoint(current, inherited, request, relayOrigin) {
  if (!relayOrigin) {
    throw fail('OpenRouter Plus cannot repoint a provider route right now: the loopback relay has no address, so it cannot tell which routes it owns. Wait for the relay to start and try again.')
  }
  const input = isPlainObject(request) ? request : {}
  const providers = mergeProviders(current, inherited)
  const key = routeKeyOf(providers, input.route, 'repoint')
  const route = isPlainObject(providers[key]) ? providers[key] : {}
  const from = baseURLOf(route)
  const to = requestedBaseURL(input, key, 'repoint')
  assertNotRelayOrigin(to, key, relayOrigin)
  // A relay-backed route is the plugin's to keep, with one exception: moving it
  // between mounts of the SAME target is a tier change, not a change of owner.
  // Leaving the relay entirely is `planRestore`'s job, never this one's.
  if (underOrigin(from, relayOrigin) && !sameRelayTarget(from, to, relayOrigin)) {
    throw fail(`Provider route "${key}" already points at the OpenRouter Plus relay ("${from}"), so the plugin owns it and it cannot be repointed. Change its tier or remove it in the OpenRouter Plus settings instead.`)
  }
  return baseURLPlan(current, inherited, providers, key, from, to)
}

/**
 * Move a relay-backed route back to the upstream recorded for it: the inverse of
 * `planRepoint`, and the only plan allowed to take a route off the relay.
 *
 * Refused here: a route that is not currently relay-backed, because there is
 * nothing to undo and silently rewriting a hand-made route would be worse than
 * saying so.
 *
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} inherited
 * @param {{ route?: string, baseURL?: string }} request
 * @param {string} relayOrigin
 * @returns {{ next: Record<string, unknown>, result: { name: string, from: string | null, to: string, changed: boolean } }}
 */
export function planRestore(current, inherited, request, relayOrigin) {
  if (!relayOrigin) {
    throw fail('OpenRouter Plus cannot restore a provider route right now: the loopback relay has no address, so it cannot tell which routes it owns. Wait for the relay to start and try again.')
  }
  const input = isPlainObject(request) ? request : {}
  const providers = mergeProviders(current, inherited)
  const key = routeKeyOf(providers, input.route, 'restore')
  const route = isPlainObject(providers[key]) ? providers[key] : {}
  const from = baseURLOf(route)
  if (!underOrigin(from, relayOrigin)) {
    const shown = from ? `"${from}"` : 'no base URL'
    throw fail(`Provider route "${key}" is not routed through OpenRouter Plus (its base URL is ${shown}), so there is nothing to restore. Route it through OpenRouter Plus first.`)
  }
  const to = requestedBaseURL(input, key, 'restore')
  assertNotRelayOrigin(to, key, relayOrigin)
  return baseURLPlan(current, inherited, providers, key, from, to)
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
  if (!tier) return null
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
