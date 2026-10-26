# Design: why a relay, and not a patch

## The ask

[deepseek-harness#9787](https://github.com/deepseek-ai/deepseek-harness/discussions/9787) asks for a
`serviceTier` field on `@deepseek-ai/dsh-llm-pi-ai` provider profiles so a request can be pinned to
OpenRouter's `flex` (half price, slower pool) or `priority` / `fast` / `ultrafast` (a multiplier in
exchange for latency). Today the profile schema exposes `api`, `apiKeyEnv`, `baseURL`, `headers` and
`models` — no way to reach a request-body field.

The wire contract is trivial: a top-level `"service_tier": "flex"` key in the OpenAI-compatible body.
The entire difficulty is *where to put it*, given that the plugin cannot patch a shipped package.

## Options

### A. Patch `@deepseek-ai/dsh-llm-pi-ai`

Add `serviceTier` to the provider schema and pass it to the upstream body. This is the "right" fix and
belongs upstream — but as a local patch it lives in `~/.bun/install/global/node_modules`, is
overwritten by the next `bun install -g @deepseek-ai/...`, and gives no error when it silently
disappears. Rejected as the primary mechanism.

### B. Two rows sharing one credential

Duplicate the provider row: one plain, one whose `baseURL` carries the tier. That works today with no
code, which is why the relay idea is viable at all — but by hand it is a YAML edit that drifts, and it
misleads: a `baseURL` that merely *looks* different gives no feedback about which tier is actually in
effect, or whether the relay behind it is alive.

### C. This plugin: relay + managed route (chosen)

A loopback relay owns the tier semantics; the plugin creates the route that points at it; the Models
page shows what is happening.

```
route.baseURL = http://127.0.0.1:8791/flex/v1
   → relay strips /flex/v1, appends /chat/completions to `upstream`
   → writes service_tier: "flex"
   → forwards Authorization untouched
```

What this buys over B:

- **The tier is data, not a guess.** It lives in the mount table, is validated, and is visible in the
  status API and the card.
- **Telemetry.** Every request is attributed to a tier with token counts, so "what did flex actually
  save me" has an answer.
- **Reversibility.** Routes are created by the plugin, marked by their `baseURL`, and removable from
  the same card. A route the plugin did not create is never edited or deleted.
- **Survives upgrades.** Nothing outside the profile's own config is touched; `bun install -g` cannot
  break it.

The cost is an extra local hop (sub-millisecond on loopback) and one more process-bound listener to
keep healthy. Both are visible, which is the point.

## Rejected micro-alternatives

- **Model-name suffixes** (`:flex` variants): the ticket notes they do not line up across providers,
  and they would require rewriting the `model` field — a bigger lie than a tier header.
- **Custom `headers`** (`x-service-tier`): not part of the OpenAI wire contract; only some gateways
  read it, and OpenRouter expects the body field.
- **MCP or a tool the model calls:** puts tier selection in the model's hands instead of the config's.
- **Mounting on the DSH web server:** the GUI's auth fence answers unauthenticated requests with
  `401`; an LLM route carrying an OpenRouter key is exactly that. A separate loopback listener keeps
  the two realms apart.

## Invariants worth protecting

1. **Never write a tier the caller did not choose.** A `null` mount is a pure passthrough: the key is
   not added, and an existing key is not removed.
2. **Never touch response bytes.** The relay pipes the upstream body through untouched, including SSE
   chunk boundaries; usage sniffing reads a bounded tail copy and changes nothing.
3. **Never hold a key and never widen the bind.** Loopback only, `Authorization` forwarded verbatim.
4. **Never break someone's default model silently.** If a created route is present at boot, the plugin
   logs a warning that disabling it will break that route.

## Known limits

- Injection is limited to `POST` requests with a JSON body — which covers chat completions and
  responses, and nothing else.
- The relay forwards to a single `upstream`; tier mounts cannot fan out to different providers (run a
  second instance with a different row if you need that).
- Multipliers are *billing multipliers*, not dollars: the plugin has no price table and refuses to
  invent one. Point it at the OpenRouter dashboard for actual spend.
- A pinned tier is a *request*; the provider decides what it serves. `flex` can still be served at
  list price when the flex pool is unavailable — check `usage` on the response.
