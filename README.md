# dsh-openrouter-plus

**Service-tier routing for OpenRouter — as a DeepSeek Harness plugin, with no patched packages.**

OpenRouter prices and schedules by *service tier*: `flex` halves token cost in exchange for a
slower pool, while `priority` / `fast` / `ultrafast` pay a multiplier for lower latency. In
`@deepseek-ai/dsh-llm-pi-ai` that tier is unreachable — provider profiles expose `baseURL` and
`headers`, but no request-body fields
([discussion #9787](https://github.com/deepseek-ai/deepseek-harness/discussions/9787)).

This plugin reaches the same wire result from the outside. It runs a **loopback relay**; a provider
route points at it, and the relay writes the `service_tier` key into the request body on the way
upstream. Because it only uses schema fields the profile already has, it survives
`bun install -g` upgrades and never touches `~/.bun/install/global`.

The tier is chosen **per session, at request time**. One provider row keeps serving every tier, so
switching never mints a provider, a route or a model list.

```
  composer chip: this session runs on «priority»
      │
      ▼
  dsh-llm-pi-ai ──►  dsh-openrouter-plus relay  ──►  https://openrouter.ai/api/v1
      baseURL =           │ reads the session from x-session-id / prompt_cache_key,
  127.0.0.1:8791/t/<id>/v1  │ injects {"service_tier":"priority"}
                            └── /__openrouter-plus/* ──► OpenRouter Plus settings page
```

## What you get

- **One provider row, any tier.** A routed provider keeps its key, protocol and models and gains one
  thing: a composable **service tier** that the relay writes into each request. No per-tier provider
  copies, no sibling route per tier, no model list duplicated seven times.
- **Tier mounts** — `/flex/v1`, `/priority/v1`, `/fast/v1`, `/ultrafast/v1`, `/scale/v1`,
  `/auto/v1`, `/default/v1`, plus a `/v1` passthrough that sends no tier at all. Each mount is a
  `baseURL` you can paste into any OpenAI-compatible provider route when you want a *permanently*
  pinned tier instead of a per-session one.
- **Its own settings page** (Settings → OpenRouter Plus) showing relay state, every mount with a
  copy button, live request/token counters per tier, the weighted cost multiplier, and recent
  requests.
- **A tier chip in the composer** — next to the model selector, a compact chip shows the tier this
  Session will actually send and switches it in one click. The switch is **per session**: it changes
  what the next request from *this* conversation carries, so two conversations can sit on `flex` and
  `priority` at the same time. It shows up on a brand-new Session too — before the first message the
  chip reads the plugin's default tier, so a tier can be picked *before* you start typing. The
  reasoning effort you chose stays put: switching a tier touches no provider row and no model list.
- **A switch on every provider row** — in Settings → Models, each `llm-pi-ai` provider gets a
  **Route through OpenRouter Plus** checkbox. Tick it and that provider's traffic flows through the
  relay to the endpoint you already gave it; untick it and the endpoint comes back. Your provider
  entry, protocol, key and models are left exactly as they were.
- **A default tier for the profile** — the settings page sets what an unchosen Session inherits, and
  the composer chip's `Default (…)` entry hands a Session back to it.
- **Zero risk to your existing setup** — the relay holds no API key, forwards your `Authorization`
  header verbatim, binds only to loopback, and the only profile changes it makes are reversible by
  construction.

## Install

```bash
git clone https://github.com/GnaneshKunal/dsh-openrouter-plus
dsh plugin add ./dsh-openrouter-plus     # or, from a session:
#   plugin_manager { action: install_bundle, target: "./dsh-openrouter-plus" }
```

The plugin adds one entry to Settings navigation: **OpenRouter Plus**, directly after *Models*. If
the relay is up, the page shows the origin (`http://127.0.0.1:8791`) and its mounts.

## Use it

### Two clicks: tick the provider, pick the tier

1. **Settings → Models** → tick **Route through OpenRouter Plus** on the provider you already use
   (for example `openrouter-custom`). That provider's traffic now flows through the relay; its
   `api`, `apiKeyEnv`, headers and models are untouched.
2. Open the composer of any Session and pick a tier in the chip next to the model selector. Every
   request that Session sends now carries `service_tier: "<tier>"`.

Nothing else to create, and nothing to clean up: the provider row is the only row that ever existed,
and the tier is a per-Session choice rather than a provider.

The settings page manages the profile-level **Default service tier** and lists the routes that
currently point at this relay (with **Remove** for the ones you no longer want).

### From a provider row (the switch)

In **Settings → Models**, every `llm-pi-ai` provider row carries a compact strip added by this
plugin: a **Route through OpenRouter Plus** checkbox.

Ticking it does three things, all through the control API:

1. records the endpoint that row currently points at (that is your real base URL) as a *target* in
   this plugin's own config;
2. gives that target a mount — `http://127.0.0.1:8791/t/<targetId>/v1` — which *mounts* the
   endpoint without pinning a tier: the tiers come from the Sessions that call it;
3. repoints **only** that provider row's `baseURL` at the mount. `api`, `apiKeyEnv`, headers and
   models are not touched, and no plugin bookkeeping is written into the provider entry (it is
   schema-validated, so it stays clean).

**The first attach reloads the plugin.** Recording a new target is a write to this plugin's own
config, so the Loader re-applies the Host row and the listener rebinds — which can cut the HTTP
response to that very request. It is not a failure: the strip re-probes `/health`, re-reads
`/targets` and shows the truth, and every write here is idempotent, so a retry lands cleanly. Later
attaches (a detach, a re-attach of a known endpoint) reuse the target row and do not reload anything.
**A tier switch never writes anything**, so it never reloads anything either.

What happens to a request: the relay strips the mount prefix, appends the rest of the path to your
recorded endpoint, asks which tier the Session carrying that request chose, and writes
`service_tier` into the JSON body when it has one. With no tier chosen the body goes out untouched —
and a `service_tier` the client put there itself is removed, so this Session's silence stays silence
rather than inheriting whatever a UI happened to send.

Untick it (**Detach**) and the row's `baseURL` goes back to the endpoint recorded for that target;
the mount stays until you remove the target. Everything is idempotent: the same endpoint always maps
to the same target id, so ticking the box twice cannot fork the table or repoint anything twice.

> **Why the switch is on the row and not inside the add-provider form.** The obvious place for this
> checkbox is the "Custom model API" form itself. A plugin cannot put it there: the
> `settings.models.provider-card` extension slot hands an extension `{provider, configured,
> keyConfigured}` and no setter, the draft Base URL lives in a private `useState` inside the editor,
> and that card dispatches no extension at all before the provider is saved. The saved row is the
> earliest surface a plugin can reach — same page, one save later. The same class of limitation is
> why a re-picked model loses hand-declared fields (tracked upstream as
> [discussion #11097](https://github.com/deepseek-ai/deepseek-harness/discussions/11097)).

### By hand

Point any OpenAI-compatible provider route's `baseURL` at a mount:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-flex-route:
        api: openai-responses
        apiKeyEnv: OPENROUTER_API_KEY
        baseURL: http://127.0.0.1:8791/flex/v1
        models:
          - id: deepseek/deepseek-v4.1-flash
            # Optional but recommended — see "Reasoning effort" below.
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
              max: max
```

Or route a provider to its own endpoint through a target mount — no provider config needed beyond
the base URL:

```yaml
- id: llm-pi-ai
  config:
    providers:
      acme-gateway:
        api: openai-completions
        apiKeyEnv: ACME_API_KEY
        baseURL: http://127.0.0.1:8791/t/acme-gw-9f3a/flex/v1
        models:
          - id: acme-large
```

`/t/<targetId>/v1` is the shape the switch writes: it mounts the endpoint and pins nothing, so each
Session's chip decides. `/t/<targetId>/<tier>/v1` is the older pinned shape and still works — useful
when a row must sit on one tier regardless of who calls it. The target's endpoint is declared once,
in the plugin's config (see `targets` below), so one listener can front any number of OpenAI- or
Anthropic-style endpoints.

### Reasoning effort on a relay route

A relay route is a provider key the installed catalog has never seen, so
`@deepseek-ai/dsh-llm-pi-ai` cannot inherit a model's reasoning capability for it. Without an
explicit `reasoningEfforts` the model materializes as `reasoning: false` and the composer shows
**"This model provides no reasoning effort levels."** — no effort selector, no error, nothing in the
log. The relay itself is not involved; it never touches reasoning fields.

The plugin fills that gap when it creates a route, from the best evidence available:

1. a capability the model already declares (in the source route), kept byte-identical;
2. a declaration for another variant of the same id — `google/gemini-4-argon:flex` teaches the
   plugin about `google/gemini-4-argon`;
3. the configured `reasoningEfforts` map, as a fallback for everything else.

Set `reasoningEfforts: false` to switch filling off, or omit it to fill only from evidence 1–2.
A model that declares `reasoningEfforts: false` is itself opted out: the fill leaves it alone.

**The fill also re-applies itself.** Re-picking a model in Settings → Models rebuilds that row from
the catalog — `id`, `name`, context window, max tokens — and drops `reasoningEfforts` along with
every other hand-declared field. That is the shape of this bug: the effort selector works, you touch
the model list afterwards, and it is gone. The cause is upstream rather than here (`adopt()` in
`@deepseek-ai/dsh-client-ui-settings-models` copies a fixed field list), so the plugin watches the
profile instead: a debounced pass runs on every config settle and restores the capability a moment
after the edit lands. Set `autoRepairReasoning: false` to keep the plugin out of your config
entirely, and use **Add reasoning to N models** in the settings page (or
`POST /__openrouter-plus/routes/repair`) when you want the fill on demand.

Either way it only ever touches routes whose `baseURL` points at the relay, never overwrites a
declared map, never resurrects an explicit `false`, and writes nothing when there is nothing to do.

### From the composer (the tier chip)

Once a provider row is routed, a compact chip appears in the composer next to the model selector
showing the tier the next request will carry. Picking another tier there does **not** rewrite any
config and does **not** mint a provider: the Host records the choice for this Session in memory, and
the relay applies it to the request body on the way out.

- `flex` — half price, slower pool.
- `priority` / `fast` / `ultrafast` — a multiplier for a faster pool.
- `scale` / `auto` / `default` — OpenRouter's own scheduling modes.
- **No tier (pass-through)** — the body leaves without a `service_tier` key at all.
- **Default (no tier)** / **Default (flex)**, … — stop choosing for this Session and inherit the profile default again.

That is why it is per session: two conversations can be on `flex` and `priority` at the same time,
neither of them rewrites the other's provider row, and the reasoning effort you selected survives
the switch because the selection itself never changes.

The choice lives in the Host's memory — it is runtime state, like the effort level — so it survives
the whole Session but not a Host restart (a default-tier write reloads the plugin, which drops those
choices too). Want a tier that outlives every restart? Either set the profile **Default service tier**
or point a provider at a pinned mount by hand (`/flex/v1`).

The chip only appears when the Session's current provider is routed through a mount
(`/t/<targetId>/…`). Elsewhere the Models-page switch is the control: it is the one that moves the
provider itself.

## Control API

Served on the same loopback listener, outside the proxy path space:

| Endpoint | Purpose |
| --- | --- |
| `GET /__openrouter-plus/health` | liveness |
| `GET /__openrouter-plus/status` | address, upstream, mounts, metrics |
| `GET /__openrouter-plus/targets` | source routes, routes on this relay, the `targets` table, and the tier table (`{ default, tiers }`) |
| `GET /__openrouter-plus/tier?session=<id>` | what that Session would send now: `tier`, `chosen`, `default`, `tiers` |
| `POST /__openrouter-plus/tier` | `{ session, tier }` — choose this Session's tier; `tier: null` hands it back to the default. **Memory only, never a config write** |
| `POST /__openrouter-plus/tier/default` | `{ tier }` — the tier an unchosen Session inherits; `tier: null` clears it |
| `POST /__openrouter-plus/routes/remove` | `{ name }` |
| `POST /__openrouter-plus/routes/repair` | adds missing `reasoningEfforts` to the routes this plugin owns |
| `POST /__openrouter-plus/routes/attach` | `{ route, upstream }` — record the endpoint and point that provider at the relay |
| `POST /__openrouter-plus/routes/detach` | `{ route, id }` — put that provider back on its own endpoint |
| `POST /__openrouter-plus/targets/register` | `{ upstream, tier?, id? }` — record an endpoint without touching a provider |
| `POST /__openrouter-plus/targets/remove` | `{ id }` — refuse while a provider still routes through it |

`attach`/`detach` are what the Models-page switch calls; both are idempotent and report
`changed: false` when the row is already in the requested state. A rejected request answers `400`
with `{ error: { message } }` — for example a body that is not an http(s) URL, or one that points
back at the relay. `POST /tier` answers `400` for an unknown tier name (`turbo`) or a missing
`session`, and accepts `tier: null`/`""` to clear.

Everything in `/tier` is deliberately write-free: a config write would re-apply this plugin row and
restart the listener, which is not something a mid-conversation click should risk. Only
`/tier/default` writes, because it is a preference rather than one Session's state.

`POST` requires `x-oorp-client: web`. CORS is reflected only for loopback GUI origins.

```bash
curl -s http://127.0.0.1:8791/__openrouter-plus/status | jq .metrics.byTier
```

## Configuration

`cordis.patch.yml` ships the defaults; override them in your profile's patch layer:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin installed but binds nothing |
| `host` | `127.0.0.1` | bind address — loopback only, deliberately |
| `port` | `8791` | preferred port |
| `portFallback` | `true` | fall forward to the next free port (the page probes 8791–8794) |
| `upstream` | `https://openrouter.ai/api/v1` | where requests are forwarded, no trailing slash |
| `routes` | tier mounts | mount path → tier, for pinned URLs (`/flex/v1`); `null` tier is a pure passthrough. The per-session design needs only `/v1` |
| `upstreamTimeoutMs` | `0` | `0` disables the upstream timeout (long SSE completions) |
| `reasoningEfforts` | `false`-able map | levels written onto relay routes' models; `false` disables, omit for evidence-only |
| `autoRepairReasoning` | boolean, default `true` | re-apply that fill whenever the profile changes, so editing a route's models cannot silently strip the effort selector |
| `defaultTier` | `null` | the tier an unchosen Session inherits; `null` sends no `service_tier` at all. Written by **Default service tier** on the settings page |
| `targets` | `{}` | extra endpoints served from `/t/<id>/…` mounts: `{ "<id>": { upstream } }`. Written by the switch; edit by hand only if you want one without a provider row |

## Security model

- **Loopback only.** The relay forwards the caller's `Authorization` verbatim and stores no key.
  Do not bind a routable interface.
- **Read-only telemetry.** The status API exposes counts and token sums, never prompts or keys.
- **Reversible by construction.** The plugin only ever adds a provider route whose `baseURL` points
  at its own origin, and only removes routes that pass that same test. The switch is the same idea
  one level down: the endpoint it took over is recorded in the plugin's config, and **Detach** —
  or deleting the target — puts it back, so a provider is never left pointing at a dead mount.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Card says *relay offline* | The port range is busy, or the row is `enabled: false`. Check the Host log for `[openrouter-plus]`; set a fixed `port`. |
| A model errors after disabling the plugin | That model belongs to a route pointing at the relay. Re-enable the plugin or remove the route on the OpenRouter Plus page. |
| Requests work but no tier is applied | This Session has no tier chosen (`No tier` / no default), the mount is the bare `/v1` passthrough, or the request is not `POST` with a JSON body. |
| The chip shows a tier, but another Session still bills full price | The tier is per Session by design. Set it in that Session's composer, or set a profile **Default service tier**. |
| The chip disappeared after a Host restart | Choices are runtime state and the memory table is dropped on restart (and on a default-tier write, which reloads the plugin). Re-pick it, or set the default tier. |
| `flex` still bills full price | The provider decides the served tier; a pinned tier only *requests* it. Confirm with `usage` / the OpenRouter dashboard. |
| No effort selector for a relay route's model | The model has no `reasoningEfforts` — usually because the model list was edited in Settings → Models afterwards. It is restored automatically; if `autoRepairReasoning` is off, press **Add reasoning to N models** on the OpenRouter Plus page. See "Reasoning effort on a relay route". |

## Uninstall

Remove the route(s) in Settings → Models, then:

```bash
dsh plugin remove dsh-openrouter-plus
```

## Development

```bash
node --check index.js && node --check client.js
node --test            # 92 tests, no network, no profile writes
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module contract, and
`docs/DESIGN.md` for the design rationale against the upstream discussion.

MIT.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
