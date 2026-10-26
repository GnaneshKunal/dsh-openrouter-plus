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

```
  model picker
      │  baseURL = http://127.0.0.1:8791/flex/v1
      ▼
  dsh-llm-pi-ai ──►  dsh-openrouter-plus relay  ──►  https://openrouter.ai/api/v1
                          │ injects {"service_tier":"flex"}
                          └── /__openrouter-plus/status ──► OpenRouter Plus settings page
```

## What you get

- **Tier mounts** — `/flex/v1`, `/priority/v1`, `/fast/v1`, `/ultrafast/v1`, `/scale/v1`,
  `/auto/v1`, `/default/v1`, plus a `/v1` passthrough that sends no tier at all. Each mount is a
  `baseURL` you can paste into any OpenAI-compatible provider route.
- **Its own settings page** (Settings → OpenRouter Plus) showing relay state, every mount with a
  copy button, live request/token counters per tier, the weighted cost multiplier, and recent
  requests.
- **One-click provider routes** — the page creates a real `llm-pi-ai` route (a clone of an existing
  one, with `baseURL` pointed at a tier mount) so it appears in the model picker like any other
  provider, and removes it again. Routes the plugin did not create are never touched.
- **A switch on every provider row** — in Settings → Models, each `llm-pi-ai` provider gets a
  **Route through OpenRouter Plus** checkbox and a service-tier picker. Tick it and that provider's
  traffic flows through the relay to the endpoint you already gave it; untick it and the endpoint
  comes back. Your provider entry, protocol, key and models are left exactly as they were.
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

### Through the settings page (recommended)

1. Pick a source route (for example `openrouter-custom`) and a tier (`flex`).
2. Press **Create route**. The page writes a new provider route named `<source>-<tier>` whose
   `baseURL` is `http://127.0.0.1:8791/<tier>/v1` and whose models are cloned from the source.
3. Choose one of that route's models in the model picker. Every request it makes now carries
   `service_tier: "<tier>"`.
4. **Remove** the route from the same page when you are done. Its deletion is safe and leaves your
   original route untouched.

### From a provider row (the switch)

In **Settings → Models**, every `llm-pi-ai` provider row carries a compact strip added by this
plugin: a **Route through OpenRouter Plus** checkbox and, once ticked, a **tier** picker
(`No tier (pass-through)`, `auto`, `default`, `flex`, `scale`, `priority`, `fast`, `ultrafast`).

Ticking it does three things, all through the control API:

1. records the endpoint that row currently points at (that is your real base URL) as a *target* in
   this plugin's own config;
2. gives that target a mount — `http://127.0.0.1:8791/t/<targetId>/<tier>/v1`, or
   `…/t/<targetId>/v1` when no tier is pinned;
3. repoints **only** that provider row's `baseURL` at the mount. `api`, `apiKeyEnv`, headers and
   models are not touched, and no plugin bookkeeping is written into the provider entry (it is
   schema-validated, so it stays clean).

**The first attach reloads the plugin.** Recording a new target is a write to this plugin's own
config, so the Loader re-applies the Host row and the listener rebinds — which can cut the HTTP
response to that very request. It is not a failure: the strip re-probes `/health`, re-reads
`/targets` and shows the truth, and every write here is idempotent, so a retry lands cleanly. Later
attaches (a tier change, a detach, a re-attach of a known endpoint) reuse the target row and do not
reload anything.

What happens to a request: the relay strips the mount prefix, appends the rest of the path to your
recorded endpoint, and — only when a tier is pinned — writes `service_tier` into the JSON body. With
**No tier (pass-through)** it forwards the request body untouched, which is what you want for a
self-hosted gateway that has no notion of OpenRouter tiers.

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

`/t/<targetId>/<tier>/v1` pins `<tier>`; `/t/<targetId>/v1` pins nothing. The target's endpoint is
declared once, in the plugin's config (see `targets` below), so one listener can front any number of
OpenAI- or Anthropic-style endpoints.

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

## Control API

Served on the same loopback listener, outside the proxy path space:

| Endpoint | Purpose |
| --- | --- |
| `GET /__openrouter-plus/health` | liveness |
| `GET /__openrouter-plus/status` | address, upstream, mounts, metrics |
| `GET /__openrouter-plus/targets` | source routes, routes this plugin created, and the `targets` table |
| `POST /__openrouter-plus/routes/create` | `{ source, tier, name?, displayName? }` |
| `POST /__openrouter-plus/routes/remove` | `{ name }` |
| `POST /__openrouter-plus/routes/repair` | adds missing `reasoningEfforts` to the routes this plugin owns |
| `POST /__openrouter-plus/routes/attach` | `{ route, upstream, tier? }` — record the endpoint and point that provider at the relay |
| `POST /__openrouter-plus/routes/detach` | `{ route, id }` — put that provider back on its own endpoint |
| `POST /__openrouter-plus/targets/register` | `{ upstream, tier?, id? }` — record an endpoint without touching a provider |
| `POST /__openrouter-plus/targets/remove` | `{ id }` — refuse while a provider still routes through it |

`attach`/`detach` are what the Models-page switch calls; both are idempotent and report
`changed: false` when the row is already in the requested state. A rejected request answers `400`
with `{ error: { message } }` — for example a body that is not an http(s) URL, or one that points
back at the relay.

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
| `routes` | tier mounts | mount path → tier; `null` tier is a pure passthrough |
| `upstreamTimeoutMs` | `0` | `0` disables the upstream timeout (long SSE completions) |
| `reasoningEfforts` | `false`-able map | levels written onto created routes' models; `false` disables, omit for evidence-only |
| `autoRepairReasoning` | boolean, default `true` | re-apply that fill whenever the profile changes, so editing a route's models cannot silently strip the effort selector |
| `targets` | `{}` | extra endpoints served from `/t/<id>/…` mounts: `{ "<id>": { upstream, tier } }`, `tier: null` for pass-through. Written by the switch; edit by hand only if you want one without a provider row |

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
| Requests work but no tier is applied | The route's mount has a `null` tier (`/v1`), or the request is not `POST` with a JSON body. |
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
node --test test/
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module contract, and
`docs/DESIGN.md` for the design rationale against the upstream discussion.

MIT.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
