# Design: why a relay, and not a patch

## The ask

[deepseek-harness#9787](https://github.com/deepseek-ai/deepseek-harness/discussions/9787) asks for a
`serviceTier` field on `@deepseek-ai/dsh-llm-pi-ai` provider profiles so a request can be pinned to
OpenRouter's `flex` (half price, slower pool) or `priority` / `fast` / `ultrafast` (a multiplier in
exchange for latency). Today the profile schema exposes `api`, `apiKeyEnv`, `baseURL`, `headers` and
`models` — no way to reach a request-body field.

The wire contract is not one field. A top-level `"service_tier": "flex"` is the obvious half; the
other halves are `provider.sort` (`"price"` / `"throughput"`), which reorders whatever pool the tier
admitted, and the `:floor` suffix on `model`, which admits flex endpoints *and* sorts by price — a
combination no parameter expresses. The entire difficulty is *where to put them*, given that the
plugin cannot patch a shipped package.

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

### C. This plugin: relay + preset at request time (chosen)

A loopback relay owns the preset semantics and applies it per request. The provider row is the one the
operator already had; only its `baseURL` moves, onto a mount that pins nothing.

```
route.baseURL = http://127.0.0.1:8791/t/<targetId>/v1
   → relay strips the mount prefix, appends /chat/completions to the recorded `upstream`
   → reads the Session from x-session-id / prompt_cache_key, resolves that Session's preset
   → applies the preset's recipe: service_tier, provider.sort, or a model suffix
     (the pass-through preset sends none of them, and strips a tier the client added)
   → forwards Authorization untouched
```

A tier mount (`/flex/v1`) still exists for anyone who wants a permanently pinned `baseURL`; the
per-Session control is the composer chip.

What this buys over B:

- **The preset is data, not a guess.** One `PRESET_WIRE` table names what each outcome sends; the
  Host expands a Session's choice through it and the client only ever sees ids and labels, so the
  wire contract cannot drift from the picker.
- **Two conversations, two presets.** The choice is Session state, so a `Flex` conversation and a
  `Priority` one share the same provider row and the same model list.
- **Telemetry.** Every request is attributed to the preset it ran under, with token counts, so "what
  did Flex actually save me" has an answer.
- **Reversibility.** A moved route is marked by its `baseURL` (it points at the relay), the endpoint
  it came from is recorded in the plugin's own table, and **Detach** puts it back. A route the plugin
  did not move is never edited or deleted.
- **Survives upgrades.** Nothing outside the profile's own config is touched; `bun install -g` cannot
  break it.

The cost is an extra local hop (sub-millisecond on loopback) and one more process-bound listener to
keep healthy. Both are visible, which is the point.

## Rejected micro-alternatives

- **Model-name suffixes as the main mechanism** (`:flex` variants): the ticket notes they do not line
  up across providers, and rewriting `model` is a bigger lie than a request field. The relay does not
  offer `:flex`. It does offer `:floor` — and appends that one suffix itself — because the API has no
  parameter that admits flex endpoints *and* sorts by price, so the slug is the only form of that
  outcome. `:nitro` is deliberately not offered: for the models where it changes the outcome,
  `provider.sort: "throughput"` is the same race, and offering both would let a person pick one that
  silently does nothing.
- **Custom `headers`** (`x-service-tier`): not part of the OpenAI wire contract; only some gateways
  read it, and OpenRouter expects the body field.
- **MCP or a tool the model calls:** puts tier selection in the model's hands instead of the config's.
- **Mounting on the DSH web server:** the GUI's auth fence answers unauthenticated requests with
  `401`; an LLM route carrying an OpenRouter key is exactly that. A separate loopback listener keeps
  the two realms apart.

## Invariants worth protecting

1. **Never invent a routing decision the caller did not choose.** The pass-through preset sends no
   tier and no comparator. A tier the client put in its own body *is* removed, because "this Session
   pinned nothing" must not silently inherit whatever a UI happened to send.
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
