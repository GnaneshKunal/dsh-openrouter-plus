# dsh-openrouter-plus — architecture & module contract

A DeepSeek Harness plugin that adds **OpenRouter service-tier routing** without patching any
shipped package: it runs a loopback relay that pins `service_tier` in OpenAI-compatible request
bodies, exposes a live status API, and adds a **Models-page card** that can create a real
provider route in the profile pointing at the relay.

Background: `deepseek-harness` discussion #9787 asks for a `serviceTier` field on
`@deepseek-ai/dsh-llm-pi-ai` provider profiles. That field lives in a package a third-party
plugin cannot patch. The relay achieves the same wire effect (a `service_tier` key in the
request body) entirely through configuration, so it survives `bun install -g` upgrades.

```
composer/model picker
      │  baseURL = http://127.0.0.1:8791/flex/v1
      ▼
dsh-llm-pi-ai ──► dsh-openrouter-plus relay ──► https://openrouter.ai/api/v1
                        │ injects {"service_tier":"flex"} into the JSON body
                        └ /__openrouter-plus/status ──► Models-page card (client.js)
```

## Runtime facts this design relies on

- The only dependency-free way to influence the request body is `baseURL`, a real schema field
  of a pi-ai provider profile, editable through the Models settings.
- Provider **routes** are just keys under `providers:` in the `llm-pi-ai` row config; a route key
  need not name an installed provider. A route is `{ api, apiKeyEnv, baseURL, models[], headers?,
  displayName? }` and inherits nothing when its key is unknown — so a created route must carry the
  full `models` list.
- The Models page exposes two extension slots: `settings.models.footer` (list, renders after the
  provider rows) and `settings.models.provider-card` (keyed per provider). We use the footer.
- `ctx.configEditor` (Host) exposes `entries()`, `configuration()` and
  `edit(entry, (current, inherited) => nextRawConfig)`; edits go through the normal Loader path, so
  a new route appears in the Models page / model picker once reconciliation completes.

## File map

| File | Owner | Contract |
| --- | --- | --- |
| `index.js` | lead | Host plugin entry: config normalization, lifecycle, control endpoints. |
| `lib/proxy.js` | relay-core | `createRelay(options) -> { start, stop, address, routes }` |
| `lib/metrics.js` | relay-core | `createMetrics(options) -> { record, snapshot }` |
| `lib/config-bridge.js` | config-bridge | `createConfigBridge(options) -> { available, targets, createRoute, removeRoute, listRoutes }` |
| `client.js` | models-card | `window.__ModuleLoader__.load(...)`; registers the `settings.models.footer` card. |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` | lead | bundle manifest, inserted row, display metadata. |

Plain ESM JavaScript, **no build step, no third-party runtime dependencies** (Node ≥ 20 built-ins
only: `node:http`, `node:stream`, `node:url`, `node:util`, `node:crypto`). Every file must pass
`node --check`.

## Control endpoints (served by the relay listener, loopback only)

All JSON. Path prefix is a constant `CONTROL_PREFIX = '/__openrouter-plus'`.

| Method + path | Body | Response |
| --- | --- | --- |
| `GET /__openrouter-plus/health` | — | `{ ok: true, version, uptimeMs }` |
| `GET /__openrouter-plus/status` | — | `{ ok, version, address, upstream, routes, controlPrefix, metrics }` |
| `GET /__openrouter-plus/targets` | — | `{ available: boolean, reason?, sources: Source[], created: Created[] }` |
| `POST /__openrouter-plus/routes/create` | `{ source, tier, name?, displayName? }` | `{ ok: true, name, baseURL, source, tier }` |
| `POST /__openrouter-plus/routes/remove` | `{ name }` | `{ ok: true, name }` |

`POST` requests must carry the header `x-oorp-client: web`; the relay answers `403` without it
(a cheap cross-site-request guard: a foreign origin cannot add that header without a preflight the
relay refuses). Every response carries CORS headers limited to loopback GUI origins.

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

```js
/**
 * @param {object} options
 * @param {string} options.host          e.g. '127.0.0.1'
 * @param {number} options.port          preferred port; falls forward when busy if portFallback
 * @param {boolean} [options.portFallback=true]
 * @param {string} options.upstream      e.g. 'https://openrouter.ai/api/v1' (no trailing slash)
 * @param {Record<string,string|null>} options.routes
 *        map of mount path -> tier, e.g. { '/flex/v1': 'flex', '/v1': null }
 * @param {Record<string, (req,res)=>Promise<void>|void>} [options.control]
 *        absolute pathname -> handler, checked before proxying
 * @param {(entry: object) => void} [options.onRecord]   per-request metric sink
 * @param {(level, message, detail) => void} [options.log]
 * @param {number} [options.upstreamTimeoutMs=0]  0 = no timeout (long SSE streams)
 * @param {string} [options.version]
 */
export function createRelay(options)
```

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
2. **Tier injection** — only for `POST` with a JSON body and a non-null tier: parse the body, set the
   top-level `service_tier` (replacing any existing value), re-serialize, fix `content-length`.
   Invalid JSON or a non-JSON content type is forwarded untouched (never throw at the client).
3. **Streaming** — the upstream response is piped straight through, unbuffered, so SSE deltas keep
   their timing. `accept-encoding: identity` is sent upstream (no gunzip/re-chunk), `host` and
   `content-length` are rebuilt, everything else (notably `authorization`) is forwarded verbatim.
4. **Timeouts** — no request timeout on the server and no upstream timeout unless configured, so a
   long completion is not cut. Client aborts propagate upstream.
5. **Metrics** — `onRecord` receives one entry per proxied request:
   `{ at, tier, model, streaming, status, ms, bytes, promptTokens, completionTokens }`.
   Token counts come from a `usage` object when one is visible in a non-streaming JSON response or
   in the tail of an SSE stream; otherwise they are `null` and `bytes` is the signal.
6. **Errors** — an unreachable upstream yields a `502` JSON body `{ error: { message } }`; no stack
   traces leak to the caller.

## `lib/metrics.js`

```js
/**
 * @param {object} [options]
 * @param {number} [options.recentLimit=50]
 * @param {Record<string, number>} [options.tierMultipliers]   default: see below
 */
export function createMetrics(options)

// record(entry)  entry: { at?, tier, model?, status, ms, bytes, streaming, promptTokens, completionTokens }
// snapshot() -> {
//   startedAt, requests, errors, streamingRequests,
//   promptTokens, completionTokens, bytes,
//   byTier: Record<string, { requests, promptTokens, completionTokens, multiplier, effectiveTokens }>,
//   effectiveMultiplier,          // weighted average billed multiplier across tiers with traffic
//   recent: entry[]               // newest first, capped at recentLimit
// }
```

Default multipliers (OpenAI/OpenRouter tier pricing): `flex: 0.5`, `scale: 1.0`, `auto: 1.0`,
`default: 1.0`, `priority: 2.0`, `fast: 2.0`, `ultrafast: 4.0`, and `null/unset: 1.0`.
`effectiveTokens = (promptTokens + completionTokens) * multiplier`.

`snapshot()` must be cheap and non-throwing for a stats endpoint polled every few seconds, and the
`recent` ring must never grow unbounded.

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
//   sources: Array<{ key, displayName, api, apiKeyEnv, baseURL, modelCount, attachedTier? }>,
//   created: Array<{ name, source, tier, baseURL, modelCount }>,
// }>
// createRoute({ source, tier, name?, displayName? }): Promise<{ name, baseURL, source, tier }>
// removeRoute({ name }): Promise<{ name }>
// listRoutes(): Promise<Array<{ name, source, tier, baseURL, modelCount }>>
```

Rules:

- The target row is the entry whose `name` is `@deepseek-ai/dsh-llm-pi-ai`. Use
  `configEditor.configuration()` for read, and `configEditor.edit(entry, change)` for write.
- `change(current, inherited)` must return the **effective** providers map (`inherited` merged under
  `current`) so a route that only exists in an inherited layer survives the write.
- A created route clones the source route's `api`, `apiKeyEnv`, `api`-related fields and `models`
  verbatim, and sets `baseURL` to `${origin}/${tier}/v1` and a `displayName` such as
  `OpenRouter (flex) — OpenRouter Plus`. Default `name` is `${source}-${tier}`.
- **Ownership test:** a route belongs to this plugin iff its `baseURL` starts with the relay origin.
  `removeRoute` refuses (throws a clear error) for any other route. Never mutate a route the plugin
  did not create.
- Reject a create whose name already exists; reject an unknown `source`; reject a `tier` outside the
  accepted set.

## `client.js`

The browser artifact is a single `window.__ModuleLoader__.load({ id: 'dsh-openrouter-plus',
factory(require) { ... } })` call (see the decoration template). Inside:

- `const React = require('react')` — never install a second React.
- `inject: ['slots', 'locale']`; register a locale namespace (`dsh-openrouter-plus`) with `en` and
  `zh` dictionaries through `ctx.locale.register(ns, { en, zh })` and bind it.
- `ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'dsh-openrouter-plus', order: 100 }, OpenRouterPlusCard))`.
- The card polls `${origin}/__openrouter-plus/status` every 3 s (and once on mount; clear the timer on
  unmount), renders connection state, the tier mount table with copy buttons, live counters, and a
  "provider routes" block that reads `/targets` and posts to `/routes/create` / `/routes/remove`
  with the `x-oorp-client: web` header.
- Styling: inherit the host theme (`var(--dsw-alias-*)` tokens, `var(--dsw-font-*)`). No global CSS
  file, no `document.body` mutation, no reading other plugins' DOM.
- Every user-visible string goes through the locale namespace.
