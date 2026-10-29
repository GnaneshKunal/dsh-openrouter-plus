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

## Model discovery: why the picker, and not the button

The second ask has the same shape as the first. `dsh-llm-pi-ai`'s `discoverModels` answers a
catalog-backed route from `@earendil-works/pi-ai`'s bundled snapshot:

```js
if (request.provider !== void 0) {
  const installed = catalogModels(request.provider);
  if (installed.size > 0) return [...installed.values()]   // ← returns, baseURL unread
}
```

It checks the provider *name* before `baseURL`, so pointing `openrouter` at the relay does not make
discovery live — which is exactly why the custom-provider workaround works: `openrouter-custom` is
unknown to the catalog, so it falls through to the network.

Rejected alternatives:

- **A. Patch `discoverModels`.** Owned by `@deepseek-ai/dsh-llm-pi-ai`; out of reach, and the whole
  premise of this plugin is that nothing shipped is patched.
- **B. Replace the discovery registry entry.** `ctx.llm.discoveries` is a plain `Map`, but
  `registerModelDiscovery` refuses the `llm-pi-ai` namespace (`DUPLICATE_DISCOVERY`) and llm-pi-ai
  re-registers through its fiber on config change. Overriding a private field would work until the
  day it silently stopped.
- **C. Declare the route's `models` (chosen).** A route that declares `models` serves exactly that
  list, ahead of the installed catalog (`resolveRouteModels`: `configured.length > 0 ? configured :
  defaults`). Writing it is a first-class `ctx.configEditor` edit, so it needs no internal seam.

### Why a picker rather than a bulk sync

A bulk "adopt everything" would dump ~392 ids into the provider, including variants nobody asked
for, and would tempt the merge to rewrite entries it should not touch. The user curating the list is
the point: the endpoint supplies the catalogue, the user supplies the judgement.

So the write takes an explicit selection:

- an id already declared is reported as `already`, never duplicated;
- an id the endpoint does not list is `unknown`, never invented;
- existing entries keep their order and their bytes — additions append;
- only the models just added get a capability fill.

### Two details only a live run surfaced

1. **The route needs an `api`.** `llm-pi-ai` resolves it as
   `request.api ?? catalog base.api ?? shared catalog api` — an entry's own `api` is ignored.
   `openrouter`'s catalog spans `openai-completions` and `anthropic-messages`, so the shared value is
   undefined and adding any unknown model is rejected outright. The planner therefore sets the
   route's `api` when it has none, which is also correct for a relay mount.
2. **The write must leave the HMR transaction.** `configEditor.edit` serialises through the Loader,
   and a listener created during activation inherits that async context — the same reason every other
   route mutation here is wrapped in `outsideHmrTransaction`.

## Where the page lives: two seats, one body

The relay's page is the operator's console: relay state, the mount table to copy from, the measured
multiplier, the traffic counters. It is not a form, and that is what makes its address a real
question.

**Settings navigation (`settings.section`, `order: 12`) — kept.** The shell supplies no copy of its
own for a section page, so the page carries its own title and intro line and sits one click from
whatever the operator was doing. This is where a page that answers "is my routing working right now"
belongs.

**Plugins → Installed (`plugins.bundle.config`) — added in 0.2.4.** The profile already
listed this package as a bundle, so the card was always there — title, version, the row the patch
declares, source, Uninstall — and answered nothing when opened. A plugin that installs from that page
and cannot be configured from it is a hole, not a design: someone who came for the uninstall button
should find the settings beside it.

Both seats render the same body; only the chrome differs, because the two frames are not the same
height. `pageChrome(seat)` drops the page's `h2` and its intro line in the Plugins seat — that page
already prints the package title, its version and its `package.json` description a few pixels above.
Everything below stays identical, which is the point: two addresses for one console, no second copy
of the logic to drift.

What was considered and rejected: **moving the page out of Settings.** The bundle page renders a
contribution between the package description and its rows, which suits a compact config form (that is
what `dsh-client-auto-continue` puts there — six tabs of settings, no live data). A dashboard of live
traffic in that slot is three clicks deep, under a page whose most prominent control is *Uninstall*.
Kept as a second address instead of a replacement. `dsh-cost-meter` reached the same conclusion and
registers one component in both seats.

Also rejected: **`plugins.row.config`** (keyed `dsh-openrouter-plus#openrouter-plus`). It renders the
page behind a *Configure* control on the row, headed by the plugin's own display title — a tidier
frame for a full page, at the cost of hiding the status behind one more click. If the status ever
comes off this page, that is the seat to move it to.

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
