# dsh-openrouter-plus — architecture & module contract

A DeepSeek Harness plugin that adds **OpenRouter service-tier routing** without patching any
shipped package: it runs a loopback relay that applies a routing *preset* to OpenAI-compatible
request bodies, exposes a live status API, and adds an **OpenRouter Plus settings page** that can
create a real provider route in the profile pointing at the relay.

Background: `deepseek-harness` discussion #9787 asks for a `serviceTier` field on
`@deepseek-ai/dsh-llm-pi-ai` provider profiles. That field lives in a package a third-party
plugin cannot patch. The relay achieves the same wire effect entirely through configuration, so it
survives `bun install -g` upgrades.

A preset is more than one field. `service_tier`, `provider.sort` and the `:floor` / `:nitro` model
suffixes are three levers with three contracts, and only certain combinations are defined — which is
why the plugin exposes outcomes (`Fastest · standard price`, `Flex`, `Floor`) and keeps the wire
recipe in one table (`PRESET_WIRE`) rather than offering the raw fields.

```
composer/model picker
      │  baseURL = http://127.0.0.1:8791/t/<id>/v1
      ▼
dsh-llm-pi-ai ──► dsh-openrouter-plus relay ──► https://openrouter.ai/api/v1
      │                 │ applies that session's preset to the body
      │                 │   service_tier / provider.sort / model variant
      │                 └ (loopback only — nothing in a browser ever dials it)
      │
      └── the page talks in-band, on the GUI's own origin:
          browser ──► dsh web server :3080 /__openrouter-plus/status
                              │ ctx.webServer.register + ctx.connection fence
                              └─ same handlers, same process
```

## Runtime facts this design relies on

- The only dependency-free way to influence the request body is `baseURL`, a real schema field
  of a pi-ai provider profile, editable through the Models settings.
- Provider **routes** are just keys under `providers:` in the `llm-pi-ai` row config; a route key
  need not name an installed provider. A route is `{ api, apiKeyEnv, baseURL, models[], headers?,
  displayName? }` and inherits nothing when its key is unknown — so a created route must carry the
  full `models` list.
- Settings navigation is a list slot (`settings.section`): one registration = one page, with a
  localized `label` thunk and an `order` seat. We take a page of our own at `order: 12` (right after
  Models), so the relay surface is not appended to a page owned by another feature.
- A plugin page has a second home. The profile lists this package in `dsh.profile.bundles`, so
  Plugins → Installed (the sidebar's plugin manager) already renders a card for it — title, version, the rows
  the patch declares, source, enable switch, Uninstall — with no body of its own. `plugins.bundle.config`
  is a `keyed`, root-scoped seat on that page (`view: 'page'` only; keyed by the **package** name, not
  the row id), rendered between the package description and its rows. Answering it puts the page
  there; the page's chrome (title, icon, crumb) is drawn by the Plugins page, not by us.
- `ctx.configEditor` (Host) exposes `entries()`, `configuration()` and
  `edit(entry, (current, inherited) => nextRawConfig)`; edits go through the normal Loader path, so
  a new route appears in the Models page / model picker once reconciliation completes.

## File map

| File | Owner | Contract |
| --- | --- | --- |
| `index.js` | lead | Host plugin entry: config normalization, lifecycle, control endpoints. |
| `lib/proxy.js` | relay-core | `createRelay(options) -> { start, stop, address, routes }`; also exports the response sniffer (`findUsage`, `findGenerationId`, `createUsageSniffer`) |
| `lib/metrics.js` | relay-core | `createMetrics(options) -> { record, snapshot, exportState, hydrate, dayKey }`; real-USD cost in local-day buckets, tokens as process counters |
| `lib/usage-store.js` | relay-core | `usageStorePath(env)`, `decodeUsageStore(raw)`, `readUsageStoreSync(path)`, `writeUsageStore(path, state)`; the persisted day table, atomic and advisory |
| `lib/reasoning.js` | config-bridge | `fillReasoning(route, { evidence, fallback }) -> { route, filled, unresolved }`; pure, no I/O |
| `lib/auto-repair.js` | index.js | `createAutoRepair({ repair, onPatched, onError, delayMs })`; debounce + serialise one repair pass, injectable timers, pure |
| `lib/models-sync.js` | models-page | `readLiveModels(payload)` → route entries; `annotateLive(models, existing)` → marks `inRoute`; `selectModels({ live, existing, selected })` → the new list. Pure, no I/O |
| `lib/quantization.js` | relay-core | `normalizePrecision(raw) -> { floor, includeUnknown, allow }`, `precisionLabel(value)`, `PRECISION_IDS`, `QUANTIZATION_LEVELS`; the twelve-value enum materialised into the allowlist `provider.quantizations` accepts. Pure, no I/O |
| `lib/endpoints.js` | relay-core | `parseEndpoints(payload, maxBytes)`, `levelsFrom(endpoints)`, `survives(allow, levels)`, `fetchEndpoints(upstream, model, { fetch })`; per-endpoint precision for admission control. Injected fetch, no network in tests |
| `lib/config-bridge.js` | config-bridge | `createConfigBridge(options) -> { available, targets, removeRoute, repairRoutes, repointRoute, restoreRoute, listRoutes, reasoning }` |
| `client.js` | models-page | `window.__ModuleLoader__.load(...)`; registers the `settings.section` page "OpenRouter Plus", the same page as the `plugins.bundle.config` body of the bundle (`dsh-openrouter-plus`), the `settings.models.provider-card` row extension, the composer preset chip and the `sidebar.footer.action` spend card + dialog. |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` | lead | bundle manifest, inserted row, display metadata. |

Plain ESM JavaScript, **no build step, no third-party runtime dependencies** (Node ≥ 20 built-ins
only: `node:http`, `node:stream`, `node:url`, `node:util`, `node:crypto`). Every file must pass
`node --check`.

## Control endpoints (served on the GUI origin, plus a loopback copy)

All JSON. Path prefix is a constant `CONTROL_PREFIX = '/__openrouter-plus'`.

One handler table, two mounts: `ctx.webServer` at `kind: 'prefix'` (the page's path, behind
`ctx.connection.requestRejection`) and the relay listener (loopback, unauthenticated, for `curl` and
for a composition with no web server). The table is keyed by full path, so mounting it twice is a
dispatch call, not a second implementation.

| Method + path | Body | Response |
| --- | --- | --- |
| `GET /__openrouter-plus/health` | — | `{ ok: true, version, uptimeMs }` |
| `GET /__openrouter-plus/status` | — | `{ ok, version, address, bound, port, upstream, routes, tiers, controlPrefix, usageWidget: { enabled }, precision: { default, floorBypassed: { count, byModel } }, metrics }` — `metrics` is the module's `snapshot()` (cost in USD, day buckets, model/tier rollups, recent rows) |
| `GET /__openrouter-plus/targets` | — | `{ available: boolean, reason?, sources: Source[], created: Created[], custom: Target[], tier: { default, presets }, reasoning: { fill, levels } }` | |
| `POST /__openrouter-plus/routes/remove` | `{ name }` | `{ ok: true, name }` |
| `POST /__openrouter-plus/routes/repair` | — | `{ ok: true, patched: Patch[], unresolved: Unresolved[], owned: string[], changed: boolean }` |
| `GET /__openrouter-plus/models?route=&upstream=` | — | the live catalogue for one route, each model marked `inRoute` |
| `POST /__openrouter-plus/models/add` | `{ route, upstream?, models: string[] }` | `{ added, already, unknown, total, filled, changed }` |
| `POST /__openrouter-plus/routes/attach` | `{ route, upstream, id? }` | `{ ok: true, route, baseURL, changed, target: { id, upstream, tier } }` |
| `POST /__openrouter-plus/routes/detach` | `{ route, id }` | `{ ok: true, route, baseURL, changed, target: { id, upstream, tier } }` |
| `POST /__openrouter-plus/targets/register` | `{ upstream, id? }` | `{ ok: true, created, target: { id, upstream, tier }, mount, baseURL }` |
| `POST /__openrouter-plus/targets/remove` | `{ id }` | `{ ok: true, id }`, or `409 { error, route }` while a provider still uses it |
| `GET /__openrouter-plus/tier?session=<id>` | — | `{ ok, session, preset, wire: { serviceTier, sort, variant }, chosen, default, presets }` — what that Session applies *now* |
| `POST /__openrouter-plus/tier` | `{ session, preset }` (or a tier-era `tier`) | the same body; `preset: null`/absent clears. **Memory only** |
| `POST /__openrouter-plus/tier/default` | `{ preset }` (or `tier`) | `{ ok, default, presets }`; one config write, because it is a preference. An absent preset means `none` |
| `GET /__openrouter-plus/precision?session=<id>` | — | `{ ok, session, precision: { floor, includeUnknown, allow }, inherited, source: 'session' | 'default', chosen, default, floors }` — what that Session applies *now*; `allow` is `null` for `any` |
| `POST /__openrouter-plus/precision` | `{ session, precision: { floor, includeUnknown } }` | the same body; a Session choice, **memory only**, cleared by an absent/null `precision` |
| `POST /__openrouter-plus/precision/default` | `{ precision }` | `{ ok, default, floors }`; one config write on the `precisionFloor` key |
| `POST /__openrouter-plus/widget` | `{ enabled: boolean }` | `{ ok: true, usageWidget: { enabled } }`; one config write — the sidebar card's preference (`usageWidget` on the plugin row). A non-boolean `enabled` is a `400` |

`POST` requests must carry the header `x-oorp-client: web`; the relay answers `403` without it
(a cheap cross-site-request guard: a foreign origin cannot add that header without a preflight the
relay refuses). Every response carries CORS headers limited to loopback GUI origins.

### The target table and the per-provider switch

`targets` is the plugin's own durable state, and it is the only state the switch needs:

```yaml
targets:
  acme-gw-9f3a: { upstream: https://api.acme.dev/v1, tier: flex }
```

- **Shape.** `Object<id, { upstream, tier }>`. `id` must match `^[a-z0-9][a-z0-9_-]{0,31}$` (it is a
  path segment); `upstream` must be absolute `http(s)`; `tier` is one of the tier names or `null`
  (pass-through). Anything else is dropped by `normalizeTargets()` rather than guessed at.
- **Id allocation.** `idForTarget(upstream)` = a slug of the host plus a 4-char base36 digest of the
  URL, so the same endpoint always maps to the same id. Registering twice is a no-op: the write is
  skipped when the table already holds that `{ upstream, tier }`.
- **Where it lives.** In this plugin's own profile row (`options.id = 'openrouter-plus'`), written
  through the same `configEditor` the bridge uses. Never inside a `llm-pi-ai` provider entry: that
  object is schema-validated by `dsh-llm-pi-ai`, so plugin bookkeeping there would be rejected.
- **Read the live table, not the boot snapshot.** A control request can follow a write this same
  process made, and `config.targets` is frozen at boot (`ownTargets()` re-reads the editor row and
  falls back to the loaded copy when there is no editor).
- **`baseURL` in a snapshot is the stored value, verbatim** (a mount for an attached row, padding and
  all). `targetId` is reported alongside it for exactly that reason: the *upstream* of an attached
  row is not in the provider entry any more, it is in `targets`, so a snapshot consumer resolves the
  endpoint from the table rather than from the row.
- **A target write reloads this plugin.** The table lives in the plugin's own config row, so
  `configEditor.edit` makes the Loader re-apply it: the listener rebinds and any HTTP response still
  in flight on it can be cut. That is why the table is written *first* and the provider row second —
  a cut leaves an unused target (harmless, removable) rather than a provider pointed at a mount with
  no endpoint behind it — why every control write is idempotent, and why the client treats a cut as
  "unknown" and reconciles from `/targets` instead of reporting a failure.
- **The switch (attach/detach)** is the composition: `ensureTarget()` records the endpoint and
  returns `baseUrlFor(id, tier)`; `bridge.repointRoute()` moves exactly one provider row onto that
  mount; `bridge.restoreRoute()` moves it back to `target.upstream`. Both planners skip the write and
  report `changed: false` when the row is already where it was asked to point, so a double-click
  cannot churn the profile.
- **Ownership.** A route whose `baseURL` is under the relay origin is not repointed by `attach` (it
  is already ours — that is `repairRoutes` territory); only `restoreRoute` may move a
  relay-backed route away, and only to the upstream recorded for it. A target whose upstream is the
  relay itself is rejected at resolve time *and* proxying time, so a mis-typed endpoint cannot make
  the relay call itself.
- **Attach is tolerant about what it is told.** A caller that only knows the row may echo the mount
  back as `upstream`: anything under the relay origin is not an endpoint, so the recorded upstream
  wins. A *real* different endpoint on an already-attached row is refused (`detach` first) rather
  than silently applied, and a row whose target has disappeared from the table is refused with an
  explicit message instead of being re-homed to a guess.
- **Removal refuses while in use.** `POST /targets/remove` answers `409` with the owning provider key
  when a row still points at that mount: deleting the mount first would turn that provider's next
  request into a `404` from our own listener.

### Config writes must step out of the HMR transaction

`configEditor.edit()` serialises its write through `hmr.runExclusive()`, which **rejects** when
called while another transaction is already executing (`HMR transactions cannot be nested`). A
listener created during plugin activation inherits that activation's `AsyncLocalStorage` context —
silently, because the leak travels through the accept path — so every request the relay serves looks
like a nested transaction: route creation failed with exactly that message while the read endpoints
kept working.

`outsideHmrTransaction(ctx, operation)` in `index.js` clears the store for the duration of the
mutation via `hmr.executing.exit()`. Only the synchronous entry matters: `runExclusive` reads the
store when it is called, then owns its own context for the actual work. The helper degrades safely
when HMR is absent, `ctx.get('hmr')` throws, or the service has an unexpected shape. It is exported
so `test/host.test.mjs` can prove the escape against a real `AsyncLocalStorage`.

## `lib/proxy.js`

Target mounts (alongside the legacy tier mounts):

- `/t/<targetId>/<tier>/v1/…` — forwards to that target's own upstream with `<tier>` injected;
  `/t/<targetId>/v1/…` forwards with **no** `service_tier` key written at all.
- `/t/` is a reserved namespace, matched before configured `routes`, so a route key cannot shadow a
  target. `parseTargetMount` consumes the mount's `/v1`; the remainder is sliced from the original
  pathname (percent-encoding and repeated slashes survive) and appended to the target's upstream
  after trailing-slash stripping, with the base query merged into the request query.
- `createRelay({ …, resolveTarget })`, `resolveTarget(targetId) -> { upstream, tier } | null` (a
  promise is awaited). The relay reads only those two fields and never touches config. The mount
  shape decides *whether* a pinned tier is written; the resolver's `tier` supplies the value.
- `resolveSessionRecipe(session, model) -> { preset, serviceTier, sort, variant, precision, quantizations } | string | null` (a
  promise is awaited) is the per-Session seam, and it is asked **after** the mount shape and pins
  nothing itself: a recipe whose levers are all `null` and whose `quantizations` is `null` is the
  pass-through preset, and it is an answer, not a missing one. The `model` argument exists for the
  precision floor: whether a filter may be sent at all depends on that model's endpoint pool, so the
  resolver cannot answer without it.
- Rejections happen before any upstream call: unknown target → `404` in the legacy unknown-mount
  shape; unusable upstream (missing, non-`http(s)`, carrying credentials) → `400`; a target pointing
  back at this listener → `400` "refusing to proxy it to itself".
- Responses carry `x-oorp-target: <id>` on target mounts only; `x-oorp-upstream` reports the origin
  (never the configured path) and `x-oorp-tier` keeps its existing meaning (`passthrough` when
  nothing is pinned). `x-oorp-precision` is always present and reports the floor: its id when
  `provider.quantizations` was written, `bypass` when a floor was configured but could not be
  admitted for that model, `any` otherwise.


```js
/**
 * @param {object} options
 * @param {string} options.host          e.g. '127.0.0.1'
 * @param {number} options.port          preferred port; falls forward when busy if portFallback
 * @param {boolean} [options.portFallback=true]
 * @param {string} options.upstream      e.g. 'https://openrouter.ai/api/v1' (no trailing slash)
 * @param {Record<string,string|null>} options.routes
 *        map of mount path -> tier, e.g. { '/flex/v1': 'flex', '/v1': null }
 * @param {(session: string, model: string|null) => object|string|null} [options.resolveSessionRecipe]
 *        per-Session preset and precision floor, applied after the mount shape on any mount.
 *        `model` is the body's model id: a floor may only be admitted per model pool.
 * @param {(session: string) => string|null} [options.resolveSessionTier]
 *        tier-era spelling of the same seam: a bare tier string
 * @param {Record<string, (req,res)=>Promise<void>|void>} [options.control]
 *        absolute pathname -> handler, checked before proxying
 * @param {(entry: object) => void} [options.onRecord]   per-request metric sink
 * @param {(level, message, detail) => void} [options.log]
 * @param {number} [options.upstreamTimeoutMs=0]  0 = no timeout (long SSE streams)
 * @param {string} [options.version]
 */
export function createRelay(options)
```

### The precision floor, and why the relay does not decide it

`applyRecipe` owns `provider.quantizations` the way it owns `service_tier`: the key is merged into the
caller's `provider` object, which is never replaced, so `only`, `order`, `allow_fallbacks` and
`ignore` survive a floor exactly as they survive a preset switch. A `null` list strips the key and
never creates `provider` on its own.

Whether a filter is safe to send is **not** the relay's decision. Excluding every provider is a hard
upstream failure (`404`), and a floor like `full-width` leaves some models with no eligible endpoint
at all — DeepSeek V3.2 is one, with no `fp16`/`bf16` endpoint to its name. So `index.js` answers that
question in `resolveSessionRecipe(session, model)` after reading the public listing
`GET /models/{author}/{slug}/endpoints`. That listing is cached for ten minutes (cap 200 models,
single-flight, and a failed or `404` read is cached as empty for the same window), and it is **never
awaited on the request path**: on a cold cache the request goes out unfiltered, the cache warms in the
background, and `precision.floorBypassed` in `/status` records it per model. A floor is a quality
preference, not a correctness requirement, so a miss costs one unfiltered request instead of a failed
turn. The `any` floor reads nothing and writes nothing, which is what keeps an unconfigured profile
byte-identical to one that predates the feature.

Returned object:

```js
{
  start(): Promise<{ host: string, port: number, origin: string }>,
  stop(): Promise<void>,
  address(): { host: string, port: number, origin: string } | undefined,
  resolveRoute(pathname: string): { prefix: string, tier: string | null, upstreamPath: string } | null,
}
```

Behaviour that the caller relies on:

1. **Mount matching** — longest `routes` key that is a prefix of the pathname and ends on a segment
   boundary (`/flex/v1/chat/completions` matches `/flex/v1`, not `/fle`). The mount is stripped;
   the remainder is appended to `upstream`. `/v1/...` with a `null` tier is a pure passthrough.
2. **Recipe application** — for `POST` with a JSON body, parse it and apply the resolved recipe
   (`applyRecipe`): `service_tier` is set or deleted, `provider.sort` is *merged* into whatever
   `provider` object the caller sent (never replacing `only` / `order` / `allow_fallbacks`), and the
   relay-owned `:floor` / `:nitro` suffix is appended to or stripped from `model`. Applying the
   pass-through preset is a real action: it deletes a tier the client pinned. Invalid JSON or a
   non-JSON content type is forwarded untouched (never throw at the client).
3. **Streaming** — the upstream response is piped straight through, unbuffered, so SSE deltas keep
   their timing. `accept-encoding: identity` is sent upstream (no gunzip/re-chunk), `host` and
   `content-length` are rebuilt, everything else (notably `authorization`) is forwarded verbatim.
4. **Timeouts** — no request timeout on the server and no upstream timeout unless configured, so a
   long completion is not cut. Client aborts propagate upstream.
5. **Metrics** — `onRecord` receives one entry per proxied request:
   `{ at, tier, preset, sessionId, model, servedModel, servedTier, streaming, status, ms, bytes,
   promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, costUsd,
   upstreamCostUsd, upstreamPromptCostUsd, upstreamCompletionCostUsd, serverToolCostUsd, byok,
   genId }`. `tier` is the wire field that was sent (if any), `preset` the outcome the Session
   picked — a sort preset sends no tier, so these two are not the same thing; `model` is what the
   request asked for while `servedModel`/`servedTier` are what answered (a fallback can change them).
   Usage is read from a `usage` object in a non-streaming JSON body or in the tail of an SSE stream;
   a bounded head copy keeps the `gen-…` id of a stream that was aborted before its usage chunk.
   **Cost fields are `null` when the provider did not report them** — zero is reserved for a free
   endpoint that really said zero — and the sniffer never alters the bytes it inspects.
6. **Errors** — an unreachable upstream yields a `502` JSON body `{ error: { message } }`; no stack
   traces leak to the caller.

## `lib/metrics.js`

Two facts live here and the code keeps them apart: **cost** is the money OpenRouter charged, read off
each response's `usage.cost` (so it already reflects the endpoint that served — flex, priority,
ultrafast, a `:floor` endpoint, an upstream fallback); **tokens** are counters since this process
started, plus a `multiplier` view used only to compare tiers. A multiplier is a weight, never money,
and it is not allowed to stand in for `costUsd`.

```js
/**
 * @param {object} [options]
 * @param {number} [options.recentLimit=50]
 * @param {Record<string, number>} [options.tierMultipliers]   default: see below
 * @param {number} [options.dayLimit=USAGE_DAY_LIMIT]
 */
export function createMetrics(options)

// record(entry)   entry: { at?, tier?, preset?, model?, servedModel?, servedTier?, sessionId?,
//   status?, ms?, bytes?, streaming?, promptTokens?, completionTokens?, cacheReadTokens?,
//   cacheWriteTokens?, reasoningTokens?, costUsd?, upstreamCostUsd?,
//   upstreamPromptCostUsd?, upstreamCompletionCostUsd?, serverToolCostUsd?,
//   byok?, genId? }
// snapshot() -> {
//   startedAt, uptimeMs, requests, errors, streamingRequests,
//   promptTokens, completionTokens, tokens, bytes,
//   costUsd,                     // money across the retained window
//   todayUsd,                    // the local calendar day in progress
//   byTier: Record<string, { requests, promptTokens, completionTokens, tokens, multiplier,
//                            effectiveTokens, costUsd }>,
//   byModel: Row[],              // today's models, sorted by costUsd then tokens (both desc)
//   byModelAll: Row[],           // the retained window's models, same ordering
//   bySession: Array<{ session, requests, promptTokens, completionTokens, costUsd, lastAt }>,
//                                // per relayed session, cost desc, process-local, capped
//   days: Array<{ date, requests, promptTokens, completionTokens, costUsd }>,  // newest first
//   effectiveMultiplier, tierMultipliers,
//   recent: entry[]              // newest first, capped at recentLimit; carries every field
//                                // above, plus promptCostUsd/completionCostUsd (the split)
// }
// exportState() -> { version: 2, counters, tiers, sessions, recent, days }  // a reload keeps all of it
// hydrate(state)                                 // replaces the day table; bad rows are skipped
// dayKey(atMs) -> 'YYYY-MM-DD'                   // the local day, exported for callers/tests
```

Rules the surfaces depend on:

- **Local calendar days, not UTC and not "since start".** `dayKey()` is the local
  `YYYY-MM-DD`, because "today" on the card and `todayUsd` are phrased in the user's own day.
  `USAGE_DAY_LIMIT` (14) bounds the window: a new bucket older than the window is dropped as it is
  created, oldest days go first, and each day keeps rollups for at most `USAGE_MODEL_LIMIT` (40)
  models — the cheapest tail is dropped from the *rollup*, while the day's totals still count every
  request.
- **Null is a fact; zero is a claim.** `costUsd: null` (a failed call, an aborted stream, no usage
  block) stays `null` in `recent` and adds no money; a reported `0` stays `0` and is preserved as a
  free call. The same guard runs at ingest: non-finite, negative or absurd amounts become 0 rather
  than poisoning every later total, and unusable token counts become 0.
- **A call that reported nothing is still traffic.** It increments `requests`/`errors` and the day's
  request count, but creates no model row: an empty line would push a real model down the card.
- **`servedModel`/`servedTier` describe what answered; `model`/`tier` describe what was asked.**
  `preset` is the outcome a person picked, which a sort preset sends without a tier at all.
- **Money persists, traffic does not.** `exportState()` carries the day buckets only — cost, tokens
  and model rollups per day. The `recent` ring, the global counters and `byTier` (including its
  `costUsd`) stay process-local: replaying them after a reload would attribute requests that no
  longer exist.
- `snapshot()` must stay cheap and non-throwing for a stats endpoint polled every few seconds, and
  `recent` must never grow past `recentLimit`.

Default multipliers (OpenAI/OpenRouter tier pricing): `flex: 0.5`, `scale: 1.0`, `auto: 1.0`,
`default: 1.0`, `priority: 2.0`, `fast: 2.0`, `ultrafast: 4.0`, and `null/unset: 1.0`.
`effectiveTokens = (promptTokens + completionTokens) * multiplier`, and `effectiveMultiplier` is the
weighted average across tiers with traffic. See `docs/USAGE.md` for the user-facing cost semantics.

## `lib/usage-store.js`

The persisted half of the cost telemetry: the one number the plugin cannot recompute once the
response is gone.

```js
export const USAGE_STORE_VERSION = 1
export const USAGE_STORE_MAX_BYTES = 256 * 1024

export function usageStorePath(env = process.env)   // $DSH_HOME/storages/dsh-openrouter-plus/usage.json
export function decodeUsageStore(raw)               // envelope only: { version: 1, days: object[] } | null
export function readUsageStoreSync(path)            // decoded snapshot or null; never throws
export async function writeUsageStore(path, state)  // boolean; false = refused or failed, never throws
```

- **Synchronous read at start.** The relay must not begin forwarding before the day table is loaded,
  or the first requests of a reload could be overwritten by the hydrate landing a tick later.
- **Atomic, owner-only, bounded.** A write lands through a temp file beside the target plus a rename,
  mode `0600`; an unencodable snapshot or one over 256 KiB is refused with `false`. The caller keeps
  serving: a failed write is not a failed request, and the numbers stay in memory for the next flush.
- **Advisory on read.** A missing, corrupt, oversized or unknown-version file answers `null` — "no
  history yet". `decodeUsageStore` validates only the envelope (`version` exactly 1, `days` an
  array); `metrics.hydrate` validates every row, so one bad day is dropped instead of the whole
  snapshot.
- **Who drives it.** `index.js` reads it at plugin start (`metrics.hydrate`), writes on a 5 s
  debounce after traffic and flushes on dispose. With zero day buckets the flush is skipped, so a
  Host that never carried a request creates no file in the user's home directory.

## `lib/config-bridge.js`

```js
/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {(level, message, detail) => void} [options.log]
 * @param {() => { host: string, port: number }} options.origin   live relay address
 * @param {string[]} options.tiers                                 accepted tier names
 */
export function createConfigBridge(options)

// available(): boolean                       // ctx.configEditor present?
// targets(): Promise<{                       // read-only snapshot for the UI
//   sources: Array<{ key, displayName, api, apiKeyEnv, baseURL, modelCount, attachedTier?, targetId? }>,
//   created: Array<{ name, source, tier, baseURL, modelCount, targetId? }>,
// }>
// removeRoute({ name }): Promise<{ name }>
// repairRoutes(): Promise<{ patched, unresolved, owned, changed }>
// repointRoute({ route, baseURL }): Promise<{ name, from, to, changed }>   // planRepoint
// restoreRoute({ route, baseURL }): Promise<{ name, from, to, changed }>   // planRestore
// listRoutes(): Promise<Array<{ name, source, tier, baseURL, modelCount }>>
// reasoning(): { fill: 'never'|'evidence'|'default', levels: string[] }
```

Rules:

- The target row is the entry whose `name` is `@deepseek-ai/dsh-llm-pi-ai`. Use
  `configEditor.configuration()` for read, and `configEditor.edit(entry, change)` for write.
- `change(current, inherited)` must return the **effective** providers map (`inherited` merged under
  `current`) so a route that only exists in an inherited layer survives the write.
- **No route is ever created.** The tier is applied to a request, not encoded in a provider row, so
  the bridge only ever *moves* an existing row (`repointRoute`/`restoreRoute`), adds reasoning
  capability to rows that point at the relay, and removes rows the operator asks it to remove. An
  older release cloned a route per tier; `inferSource` survives so a route left over from it is
  still attributed to its source.
- **Ownership test:** a route belongs to this plugin iff its `baseURL` starts with the relay origin.
  `removeRoute` refuses (throws a clear error) for any other route. Never mutate a route the plugin
  did not create.
- **`planRepoint` / `planRestore` are the two halves of the per-provider switch.** `repointRoute`
  moves a provider the operator already had (`baseURL` = their own endpoint) onto a relay mount,
  leaving `api`, `apiKeyEnv`, headers and `models` byte-identical; it refuses a route that is
  already relay-backed (`planRepair` territory — rewriting it would fight the owner) and refuses a
  target that is the relay itself. `restoreRoute` is the inverse and the only
  path allowed to move a relay-backed route away. Both report `changed: false` and skip the write
  when the row already points where it was asked to, so a repeated click cannot churn the profile.
  Neither writes plugin bookkeeping into the provider entry: the endpoint they need lives in the
  plugin's own `targets` table, and the tier never belongs to a row at all.
- Reject a remove whose name the plugin does not own; reject an unknown `route`.
- **Reasoning capability is not inherited by a new provider key.** `dsh-llm-pi-ai` resolves a model's
  `reasoning` from the model's own `reasoningEfforts`, then from the *installed catalog* entry for
  that provider key. A route this plugin invents has no catalog entry, so an unfilled model
  materializes as `reasoning: false` and the composer renders "This model provides no reasoning
  effort levels." `planRepair` therefore runs `lib/reasoning.js` over every owned route; both keep a declared map byte-identical, prefer a sibling
  variant's declaration over the configured fallback, and report the rest as `unresolved` instead of
  guessing. Filling is opt-out (`reasoningEfforts: false`), and an opted-out model is never filled:
  `lib/reasoning.js` tests `false` before it tests for a usable map, so the deliberate "no levels"
  answer survives every `planRepair` pass.
- **The capability is re-applied after edits, not just at creation.** One shipped editor destroys it:
  `adopt()` in `@deepseek-ai/dsh-client-ui-settings-models` rebuilds a model picked from the catalog
  as `{ id, name, contextWindow, maxTokens, input }`, so re-selecting models on a relay route strips
  `reasoningEfforts` — and with it the composer's effort selector — while looking like an ordinary
  edit. `lib/auto-repair.js` schedules an idempotent `planRepair` pass on every config settle:
  `settings/document-updated` (a config revision landed), `app-boot/config-reload` (profile patches
  were reconciled — the path a Models write takes) and `llm/adapters-updated` (route topology moved),
  debounced so a burst writes once, serialised so two passes never overlap, with one queued pass for
  a change that lands mid-pass. Nothing is written when nothing is missing, which is also why the
  repair's own write cannot start a loop: the second pass finds no gaps and stops. Disabled with
  `autoRepairReasoning: false`; the manual `POST /routes/repair` stays for "do it now".

## `client.js`

The browser artifact is a single `window.__ModuleLoader__.load({ id: 'dsh-openrouter-plus',
factory(require) { ... } })` call (see the decoration template). Inside:

- `const React = require('react')` — never install a second React.
- `inject: ['slots', 'locale']`; register a locale namespace (`dsh-openrouter-plus`) with `en` and
  `zh` dictionaries through `ctx.locale.register(ns, { en, zh })` and bind it.
- `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'openrouter-plus', order: 12, label: () => t('nav') }, pageFor('settings')))` — one seat in Settings navigation rendered as a full page (720 px column, `h2` title, intro line), not a card appended to another feature's page.
- `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-openrouter-plus' }, pageFor('plugins')))` — the same body on the bundle's own Plugins page (Plugins → Installed → OpenRouter Plus). This is the sidebar's plugin manager, not Settings → Built-in plugins, which is a read-only inventory. Three details, each of which fails quietly when wrong:
  - **The key is the bundle's package name.** `openrouter-plus` (the row id in `cordis.patch.yml`) and the locale namespace are both wrong; a key nothing matches renders nothing, and the card keeps showing a version and an Uninstall button as if the plugin had no settings at all.
  - **`view` is always `'page'`.** Bundle configuration has no summary form, so the seat cannot be told apart from the owner props. It travels as our own `seat` prop through a per-seat component (`pageFor`), and `pageChrome()` drops the `h2` and the intro line in the Plugins seat — that page already draws the package title, its version and its `package.json` description above the body.
  - **The host-owned `form` prop goes unused.** It is a `ConfigPageForm` over the DSH settings service (`state`/`mutate` against a settings entry); everything here reads and writes the control API instead. Wiring it up would create a second source of truth for the same settings.
- **The relay and the page update independently.** A Host restart re-applies `index.js`; the page
  keeps the client bundle it already evaluated until the document is reloaded, because the loader
  fetches each bundle once per document. So the client reads both payload shapes: `/tier` answers
  `preset` now and `tier` in the tier-era answer, `/targets` answers `tier.presets` or the older
  `tier.tiers` — a missing key degrades a picker to the built-in preset list instead of throwing the
  page out of its boundary. `__test` on the module object exports those readers for
  `test/client.test.mjs`; the loader ignores it.
- The page polls `/__openrouter-plus/status` **on its own origin** every 3 s (and once on mount;
  clear the timer on unmount), renders connection state, one pinned base URL per preset
  (`pinnedMounts()`, which
  folds `/auto/v1`, `/fast/v1` and `/scale/v1` onto the mount that means the same thing) with copy
  buttons, live counters, the money rows (today and the retained window, plus cost per preset, all
  hidden on a Host that reports no cost rather than shown as `$0`), and a
  "routes on this relay" block that reads `/targets`, sets the profile **Service tier for new
  sessions** (`POST /tier/default`) together with a short table of what each preset sends, and posts
  `/routes/remove` — all with the `x-oorp-client: web` header. The per-Session control is the
  composer chip, not this page. The split is deliberate: the picker is a preset switch, the page
  explains what each pin does. The same section carries the **Show spend card in the sidebar**
  switch, driven by `POST /widget`: it is a config write, so the relay re-applies the row and
  `/status` can fail or answer the old flag for a second — the click is held optimistically and the
  next read-back decides, and a cut connection is not treated as a refusal.
- **Why the API is not on the relay.** The relay listens on loopback because it is an upstream
  proxy that forwards the caller's key, and only the Host dials it. The page is a different client:
  it runs wherever the user opened the GUI, so it addresses `/__openrouter-plus/*` relatively and
  the Host mounts those routes on `ctx.webServer` (`kind: 'prefix'`), behind
  `ctx.connection.requestRejection`. Same origin in, no CORS, no port to guess, and a phone on the
  tailnet reaches it the same way the desktop does. A composition without a web server never mounts
  the route, and the relay's copy remains for `curl`.
- Styling: inherit the host theme (`var(--dsw-alias-*)` tokens, `var(--dsw-font-*)`). No global CSS
  file, no `document.body` mutation, no reading other plugins' DOM.
- Every user-visible string goes through the locale namespace.
- **The row extension.** `ctx.slots.inject('settings.models.provider-card', …)` registers a second
  seat, keyed by the *settings namespace* (`{ name: 'settings.models.provider-card', key: 'llm-pi-ai' }`),
  which renders on every saved `llm-pi-ai` provider row (and on the catalog add panel while a dormant
  row exists). It receives `{ provider, configured, keyConfigured }` and nothing else — no setter, no
  draft object — so it cannot touch the form being typed; it reads `GET /targets`
  (`sources`/`created`/`custom`) to learn what the row currently points at and calls
  `POST /routes/attach` / `routes/detach` to move it. It must render **nothing** when the relay is
  unreachable, and it must never call `settings.mutate`: the card holds its own `expectedRevision`,
  so a plugin write while the card is open would make the card's next save fail with
  `settings/conflict`. Re-render hands it a fresh `provider` object each snapshot, so the strip syncs
  from props rather than caching identity. Only the **Route through OpenRouter Plus** switch is offered
  unconditionally: the live-model picker (`GET /models`, `POST /models/add`) renders only while that
  row carries a relay target, so a card that never opted in gains no control from this plugin.
- **The composer chip.** A third seat, `conversation.input.right` (a free `list` slot — "compact
  controls before the composer submit action", `replaceRisk: none`), registered as
  `{ name: 'conversation.input.right', id: 'openrouter-plus-tier', order: 0 }`. It exists because
  `ModelSelection` is `{ provider, model, reasoningEffort? }` and carries no routing field, so a
  per-session preset cannot ride the selection the way effort does. The chip therefore changes
  **nothing** about the selection: it `POST`s `/tier { session, preset }`, the Host expands that
  preset through `PRESET_WIRE` and keeps the choice in memory, and the relay applies it to the
  request's Session on the way upstream. Switching costs one POST, no config write, no provider, no
  model list — and the effort level you picked stays picked because the selection was never touched.
  Its menu carries labels only; the descriptions are on the settings page. It renders nothing unless
  the Session's current provider sits on a `/t/<targetId>/…` mount and never calls
  `settings.mutate`.
- **The sidebar spend card.** A fourth seat, `sidebar.footer.action` (a free `list` seat at the
  sidebar's foot, beside Settings), registered as
  `{ name: 'sidebar.footer.action', id: 'openrouter-plus-usage', order: 0 }` — keyed by our own id,
  no owner key. It owns its own chained-`setTimeout` poll of `/status` (never `setInterval`, so a
  slow relay cannot stack probes), skips the fetch while the document is hidden, aborts on unmount,
  and draws **nothing** until three Host facts line up: `usageWidget.enabled === true`,
  `bound === true`, and `metrics.costUsd` present. That gate is why an older Host shows no card
  instead of a confident `$0.00`; the collapsed rail (`wide === false`) draws nothing either, and a
  render crash is swallowed by a boundary that renders nothing *and* logs nothing — the sidebar foot
  is always on screen and is not the place to announce that a card failed.
- **The details dialog.** The card is a single button: `OpenRouter` plus today's spend, and one press
  opens the dialog — it does not unfold in the sidebar. The dialog keeps today / all time above four
  tabs: **Models** (a table of model, input, cache read/write, output, requests and cost, with a
  totals row), **Requests** (the last 50 with model, the response's top-level `provider` as its own
  column, preset, session id + title, status, duration, stream, cost and tokens; each row expands one
  at a time into the raw fields — served model and tier, BYOK, generation id, `usage.cost`, and the
  upstream prompt/completion and server-tool charges), **Presets** (cost by routing outcome) and
  **Sessions** (name + id, requests, tokens and spend per relayed session, from `metrics.bySession`
  with titles resolved through the Host's `sessions` service — ids, not titles, are what the relay
  itself stores). It closes on Escape, on the
  backdrop, and when the relay stops answering rather than freezing a snapshot of a service that is
  gone.
  It is **not** rendered inside the card: the card's slot can be hosted by a shell popover that
  unmounts on the very press that opens the dialog, so the dialog is mounted into a React root of
  its own on `document.body` (`createUsageDialogMount`, cleaned up with the plugin). The card only
  calls `open(usage, t)`; a host that publishes no `react-dom/client` falls back to the inline
  dialog, which is why that older path survives.
- **Payload tolerance is the rule, not an afterthought.** The Host half and the browser half update
  independently, so every cost field is read defensively: an absent `usageWidget` becomes
  `available: false` (the settings page then offers no checkbox) rather than "off"; a missing
  `metrics.costUsd` omits the cost rows instead of printing `$0`; a missing `todayUsd` is rendered
  *not reported*; `normalizeUsageRecent` accepts the cost details under either the wire's snake_case
  (`upstream_inference_cost`) or the camelCase a Host may forward, and a `null` amount stays null.
  BYOK's upstream charge is displayed beside `costUsd`, never added to it.
- Do not replace `conversation.input.model`: it is a `single` seat owned by
  `ui-model-selection` (`replaceRisk: shadows-shipped-ui`), and occupying it means reimplementing the
  two-level provider/model menu, effort levels, search and `/model` parity.
