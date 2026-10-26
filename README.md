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
                          └── /__openrouter-plus/status ──► Models-page card
```

## What you get

- **Tier mounts** — `/flex/v1`, `/priority/v1`, `/fast/v1`, `/ultrafast/v1`, `/scale/v1`,
  `/auto/v1`, `/default/v1`, plus a `/v1` passthrough that sends no tier at all. Each mount is a
  `baseURL` you can paste into any OpenAI-compatible provider route.
- **A Models-page card** (Settings → Models → below the provider rows) showing relay state, every
  mount with a copy button, live request/token counters per tier, the weighted cost multiplier, and
  recent requests.
- **One-click provider routes** — the card creates a real `llm-pi-ai` route (a clone of an existing
  one, with `baseURL` pointed at a tier mount) so it appears in the model picker like any other
  provider, and removes it again. Routes the plugin did not create are never touched.
- **Zero risk to your existing setup** — the relay holds no API key, forwards your `Authorization`
  header verbatim, binds loopback only, and the plugin's rows are additive.

## Install

```bash
git clone https://github.com/GnaneshKunal/dsh-openrouter-plus
dsh plugin add ./dsh-openrouter-plus     # or, from a session:
#   plugin_manager { action: install_bundle, target: "./dsh-openrouter-plus" }
```

Then open **Settings → Models**. The card appears at the bottom of the provider list. If the relay
is up, it shows the origin (`http://127.0.0.1:8791`) and its mounts.

## Use it

### Through the Models card (recommended)

1. Pick a source route (for example `openrouter-custom`) and a tier (`flex`).
2. Press **Create route**. The card writes a new provider route named `<source>-<tier>` whose
   `baseURL` is `http://127.0.0.1:8791/<tier>/v1` and whose models are cloned from the source.
3. Choose one of that route's models in the model picker. Every request it makes now carries
   `service_tier: "<tier>"`.
4. **Remove** the route from the same card when you are done. Its deletion is safe and leaves your
   original route untouched.

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
Routes it already created — or ones you hand-edited — are fixed by **Add reasoning to N models** in
the card, which is also available as `POST /__openrouter-plus/routes/repair`. It only ever touches
routes whose `baseURL` points at the relay, never overwrites a declared map, and writes nothing when
there is nothing to do.

## Control API

Served on the same loopback listener, outside the proxy path space:

| Endpoint | Purpose |
| --- | --- |
| `GET /__openrouter-plus/health` | liveness |
| `GET /__openrouter-plus/status` | address, upstream, mounts, metrics |
| `GET /__openrouter-plus/targets` | source routes + routes this plugin created |
| `POST /__openrouter-plus/routes/create` | `{ source, tier, name?, displayName? }` |
| `POST /__openrouter-plus/routes/remove` | `{ name }` |
| `POST /__openrouter-plus/routes/repair` | adds missing `reasoningEfforts` to the routes this plugin owns |

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
| `portFallback` | `true` | fall forward to the next free port (the card probes 8791–8794) |
| `upstream` | `https://openrouter.ai/api/v1` | where requests are forwarded, no trailing slash |
| `routes` | tier mounts | mount path → tier; `null` tier is a pure passthrough |
| `upstreamTimeoutMs` | `0` | `0` disables the upstream timeout (long SSE completions) |
| `reasoningEfforts` | `false`-able map | levels written onto created routes' models; `false` disables, omit for evidence-only |

## Security model

- **Loopback only.** The relay forwards the caller's `Authorization` verbatim and stores no key.
  Do not bind a routable interface.
- **Read-only telemetry.** The status API exposes counts and token sums, never prompts or keys.
- **Reversible by construction.** The plugin only ever adds a provider route whose `baseURL` points
  at its own origin, and only removes routes that pass that same test.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Card says *relay offline* | The port range is busy, or the row is `enabled: false`. Check the Host log for `[openrouter-plus]`; set a fixed `port`. |
| A model errors after disabling the plugin | That model belongs to a route pointing at the relay. Re-enable the plugin or remove the route in Settings → Models. |
| Requests work but no tier is applied | The route's mount has a `null` tier (`/v1`), or the request is not `POST` with a JSON body. |
| `flex` still bills full price | The provider decides the served tier; a pinned tier only *requests* it. Confirm with `usage` / the OpenRouter dashboard. |
| No effort selector for a relay route's model | The model has no `reasoningEfforts`. Press **Add reasoning to N models** in the card, or add the field in Models settings — see "Reasoning effort on a relay route". |

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
