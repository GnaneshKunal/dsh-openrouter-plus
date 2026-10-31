# Changelog

Notable changes to `dsh-openrouter-plus`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/), and the project stays below 1.0 while the routing presets and
the config keys can still change.

## [0.4.0] — 2026-10-31

**A precision floor, and the truth about Exacto.** The cheapest endpoint is usually the most
compressed one — on `deepseek/deepseek-v3.2`, the cheapest of its nine endpoints is the single `fp4`
one — and the presets that buy it (`Cheapest`, `Floor`, `Fastest`) also switch off OpenRouter's Auto
Exacto, because any explicit `provider.sort` disables it. This release adds a second, orthogonal lever
per Session: a floor on which precisions may serve it at all, chosen in the composer chip beside the
tier.

### Added

- **Four floors, one wire field.** `any` (default) sends nothing. `no-four-bit`, `eight-bit-up` and
  `full-width` materialise OpenRouter's twelve-value `quantizations` enum into an allowlist and write
  it into `provider`. `unknown` is admitted by default on the middle two — it is roughly 40% of the
  endpoints on the models this plugin routes for, and all of GPT-4o's — and excluded by `full-width`,
  which would otherwise not be a floor.
- **The chip is a two-level menu now.** One trigger, and the composer model picker's own shape: a
  root pane of two rows — **Tier** (the presets, unchanged) and **Precision** (the floors) — each
  showing its current value and drilling into its own list. Escape or Shift+Tab backs out one level at
  a time; a pick returns to the rows with the menu still open, so both can be set in one visit. The
  badge composes (`Cheapest · ≥8-bit`) and omits the second half entirely while the floor is `any`, so
  the chip is unchanged for anyone who never sets one.
- **Admission control, because an empty pool is a hard failure.** Excluding every eligible provider
  fails the request upstream, and `full-width` leaves *zero* endpoints on DeepSeek V3.2. So the relay
  attaches `quantizations` only after `GET /models/{author}/{slug}/endpoints` shows at least one
  survivor for that model. The listing is cached for ten minutes and never blocks: a cold cache sends
  the request unfiltered and warms in the background, one bypass per model per window. Bypasses are
  counted and reported, so a floor that is not taking effect is visible instead of silent.
- **`precisionFloor` and per-Session overrides.** The profile key accepts a bare floor id or
  `{ floor, includeUnknown }`; a Session inherits it until it picks its own, and that choice lives in
  memory beside the preset the same way. Control API: `GET/POST /__openrouter-plus/precision` and
  `POST /__openrouter-plus/precision/default`, mirroring `/tier`.
- **`docs/PRECISION.md`** documents the floors, the wire levels, why the filter is not always sent,
  what the floor costs, and what it deliberately is not (a budget, a quality guarantee, or anything
  meaningful for a closed-weight model).

### Changed

- The README's preset section now states the Auto Exacto split: `No pin`, `Standard`, `Flex`,
  `Priority` and `Ultra` keep it; `Fastest` (both), `Cheapest` and `Floor` bypass it. That was true
  before this release and undocumented.
- `/status` gains `precision.default` and `precision.floorBypassed`; the relay sends an
  `x-oorp-precision` header beside the existing `x-oorp-tier`.

### Notes

- **`any` is byte-identical to 0.3.0.** No key is written to the body and no endpoint listing is
  fetched until a floor is chosen.
- **A floor can cost more.** Dropping `fp4` on DeepSeek V3.2 drops its cheapest endpoint, and
  `full-width` empties many `fp8`-only models. The option list names the wire levels it admits so the
  trade is legible before it is made.
- **The first request to a model after a cold cache is unfiltered**, on purpose: a quality preference
  must never stall a turn or fail one.

### Testing

- 181 tests pass (23 added here). `test/quantization.test.mjs` (9) pins the floor vocabulary, the
  `includeUnknown` defaults, the label strings, the endpoint parser against the real nine-endpoint
  DeepSeek V3.2 fixture and the two-endpoint all-`unknown` GPT-4o case, the byte cap and the admission
  rule. `test/proxy.test.mjs` (+4) pins the merge (`only`/`order`/`allow_fallbacks` survive), the strip
  on `null`, case-insensitive idempotence, the `x-oorp-precision` matrix (`any`/floor/`bypass`/legacy/
  pinned mount), that the resolver receives the model, and that a profile with no floor still sends a
  byte-identical body. `test/host.test.mjs` (+4) covers config normalization and the bounded Session
  table, the whole control API (guard header, refusals, clear-vs-`any`, config write round-trip), and
  end-to-end admission: cold bypass → warm send → all-below-floor stays unfiltered and counted → a
  `404` listing is cached so two requests cost one fetch → `any` reads nothing. `test/client.test.mjs`
  (+5) pins badge composition and the `any` omission, facet swap, the POST payload, tolerance of a
  failed read, `en`/`zh` dictionary parity, and the structural shape of the popover (one chipStyle
  call, tablist/tab/aria-controls, tabpanel, listbox/option, both routes, and that a pick never closes
  it).

## [0.3.0] — 2026-10-31

**Spend, in dollars, not a token estimate.** The relay now records what OpenRouter actually charged
for each request — `usage.cost`, which already reflects the endpoint that served it — keeps up to 14
local days across a Host restart, and surfaces them in a sidebar card, a details dialog, the settings
page and the status API.

### Added

- **The billed amount is read off the response.** The sniffer now captures `usage.cost`, the
  `usage.cost_details` breakdown (`upstream_inference_cost`, its prompt/completion split and
  `server_tool_cost`), `usage.is_byok`, the served `service_tier`, the served `model` and the
  `gen-…` generation id. It reads a bounded head (8 KiB, where the first envelope and the id arrive)
  and tail (64 KiB, where a stream's final usage block lands) of bytes it forwards untouched, so a
  stream's timing is unaffected and an aborted stream still keeps the id its charge can be found by.
  Every field is `null` when the provider did not report it — `0` is kept for a free endpoint that
  really said zero.
- **A sidebar spend card and a details dialog.** `sidebar.footer.action` gains a one-line card
  (`OpenRouter` · today's spend) that opens the dialog on press; the dialog keeps today vs all time
  above **Models** (a full table), **Requests**, **Presets** and **Sessions** tabs. It polls
  `/status` itself (hidden tabs do not poll), and draws nothing — not `$0.00` — on a Host that
  predates the cost fields, while the relay owns no socket, or when the card is switched off.
  Requests lists the last 50 with time, model, the response's top-level `provider` (its own column),
  preset, session id + title, status, duration, stream, cost and tokens (each expandable into the raw
  fields); Sessions sums `metrics.bySession` (name + id), which the relay builds from the session id
  on each request, with titles resolved through the Host's session service.
- **The whole snapshot survives a reload.** `usage.json` is now `version: 2` and stores the counters,
  the per-tier split, the per-session rollup and the recent-requests ring alongside the day buckets
  (a `version: 1` file still loads). Session names are folded from the Host's session log through
  `sessionQuery.readTitleSnapshot(id)` at status time — never written into the snapshot — and cached
  for a minute, so the Sessions tab and the Requests session column show the same name the sidebar
  does.
- **14 days of spend survive a reload.** Local-day buckets are persisted at
  `$DSH_HOME/storages/dsh-openrouter-plus/usage.json` (`{ version: 1, days: [...] }`): read
  synchronously at plugin start so a reload cannot overwrite the first requests, written on a 5 s
  debounce and on dispose, replaced atomically (temp file + rename, mode `0600`, 256 KiB cap), and
  ignored when missing, malformed or oversized. `metrics` gains `costUsd`, `todayUsd`, `byModel`
  (today only), `byModelAll` (the retained window), `days[]` and `byTier[*].costUsd`; recent rows
  carry the session, served model/tier, cache read/write and reasoning tokens, BYOK and generation
  id.
- **`usageWidget` and `POST /__openrouter-plus/widget`.** The card is on unless switched off; the
  setting accepts `{ enabled: false }` or a bare `false` in the profile, and `/status` reports the
  normalized object. The switch is a config write (the relay re-applies the row), so the page holds
  the click optimistically and the next read-back decides — a cut connection is not a refusal.
- **BYOK is kept as two bills.** `costUsd` is OpenRouter's charge for the request;
  `upstreamCostUsd` is what the caller's own provider key was billed. They are shown side by side and
  never summed.
- **`docs/USAGE.md`** documents the field contract, the local-day window, null-vs-zero and what a
  reload keeps.

### Changed

- The multipliers remain a **weight**, never money: `byTier` grew `costUsd` beside the multiplier
  view, and every surface that shows money labels it as USD instead of implying the multiplier is a
  price.
- The settings page's *Spend impact* section gained the money rows and a cost-per-preset table; the
  per-request cost, stream and token columns live in the new details dialog, where there is room for
  them beside the expandable raw fields.
- `/status` keeps its existing fields and adds `usageWidget` plus the money fields. An older client
  ignores them; this one omits the cost rows when the Host does not report them.

### Notes

- **A reload keeps money, not traffic.** Token counters, the recent ring and `byTier` (including its
  `costUsd`) start again at zero; `costUsd`, `todayUsd`, `byModel`, `byModelAll` and `days[]` come
  back from the file.
- **`null` is not `0`.** An unreported amount — a failed call, a stream aborted before its usage
  chunk — stays null and renders *not reported*; a free endpoint's real zero is kept. A reported-
  nothing call still counts as a request but creates no model row.
- **No price table, no budget.** The relay stores no per-model prices and enforces no limit;
  OpenRouter remains the source of truth for invoices and the generation id is the join key.
- Upgrading needs a Host restart: the sniffer, the store and the endpoints are Host-side. The
  sidebar card appears after the following page reload, and only on a Host that reports the fields.

### Testing

- 157 tests pass (25 added here). `test/metrics.test.mjs` (12) covers cost accumulation, local-day
  buckets, `todayUsd`, today-vs-window model rollups and their ordering, per-tier cost, day pruning,
  the model rollup cap, the export/hydrate roundtrip and its deliberate omissions, malformed hydrate
  rows, the recent ring and null-vs-zero. `test/usage-store.test.mjs` (7) covers envelope validation,
  tolerant reads, atomic replace at mode `0600`, oversize/unencodable refusal and the roundtrip.
  `test/host.test.mjs` (+3) pins `normalizeUsageWidget` and the `POST /widget` contract: guard header,
  boolean-only body, one config edit on the plugin row, and the next boot reading the flag back.
  `test/client.test.mjs` (+3) pins the card's render gates, the rollup ordering it draws, and the
  cost-detail tolerance that keeps a `null` from becoming `$0`.

## [0.2.4] — 2026-10-29

### Added

- **The page now also lives on its own Plugins card.** The profile has always listed this package as
  a bundle, so Plugins → Installed showed a card for it — title, version, the row
  the patch declares, source, **Uninstall** — and that card answered nothing when opened. It now
  registers `plugins.bundle.config`, keyed by the package name, and renders the same page there: relay
  state, the mount table, the counters, the routes. Someone who installs a plugin from that page can
  finally configure it from that page too, without hunting for the nav row it added.

  The two frames are not the same height, so the body draws its chrome per seat: the Settings shell
  supplies no copy of its own and the page keeps its `h2` title and intro line there, while the
  Plugins page already prints the package title, its version and its `package.json` description a few
  pixels above the body — so the same two elements are dropped in that seat. Nothing below changes;
  it is one body in two places, not a second copy.

  Settings → OpenRouter Plus is unchanged and stays: the seat is a *second address* for the console,
  not a replacement. A dashboard of live traffic in the bundle page's slot — between the description
  and the rows — would have been three clicks deep, under the Uninstall button.

  Both registrations are pinned by `test/client.test.mjs`: that the bundle seat is keyed by
  `dsh-openrouter-plus` (the package, not the row id `openrouter-plus`, which renders nothing and
  fails silently) and that the two seats get distinct components, since the seat travels as a prop.
  The chrome rule is pinned through a `pageChrome` test rather than by reading the source.

### Fixed

- **A failing boot test hung the suite instead of failing it.** `test/host.test.mjs` compared
  `/health` against a hardcoded version string, so the 0.2.4 bump turned it red — and because the
  test called `dispose()` on its last line, the throw skipped it, the relay stayed bound, and
  `node --test` never exited. The assertion now reads `package.json`, so a bump cannot break it, and
  the test registers a shutdown net that runs whether the body passes or throws.

## [0.2.3] — 2026-10-28

### Fixed

- **`/status` reports the version the package actually is.** `index.js` carries a `VERSION` constant
  apart from `package.json`, and the release job never compared the two, so `0.2.2` went out with the
  constant still on `0.2.1`: the settings page labelled a 0.2.2 install `v0.2.1`. They agree now, and
  the release workflow gained the check CI already ran, so a tag cannot publish a skewed pair again.

## [0.2.2] — 2026-10-28

### Fixed

- **Sync live models… only appears on a routed provider row.** The button used to render on every
  `llm-pi-ai` card that had a usable endpoint, including rows that never ticked **Route through
  OpenRouter Plus** — so an unrelated provider (a second OpenRouter row, a gateway, a local server)
  grew a control from a plugin it had not opted into. The switch stays on every row; the live-model
  picker now waits for that row to carry a relay target, and switching the row off also drops an open
  picker instead of carrying its preview across.

## [0.2.1] — 2026-10-27

**The settings page, the Models-row switch and the composer chip now work anywhere the GUI loads** —
a phone over Tailscale, a laptop on the LAN, a second browser — with no port to expose and no
Tailscale change. Until now they worked only on the machine running DSH.

### What was wrong

Every control call the browser half made was an absolute `http://127.0.0.1:8791/...`, with a probe
across 8791–8794 in case the relay had fallen forward to a free port. That address is resolved by the
machine *rendering the page*, not by the machine running the relay. Off-desktop it therefore pointed
at the phone's own loopback: nothing listening, immediate `ECONNREFUSED`, and the page rendered
*relay offline*.

The banner was also a lie in the other direction. Inference kept working the whole time — pi-ai dials
the relay from the Host process, so the request path never involved the browser — which meant
"the relay is dead" and "your browser is on another machine" produced identical screens. Only the
telemetry and every mutation button were dark.

The mistake was architectural, not a missing flag: one loopback socket was serving two audiences with
opposite reachability requirements. The relay *must* stay on loopback (it forwards the caller's
`Authorization` verbatim and holds no key of its own, so a routable bind would be an open proxy on the
tailnet). The control API has to be reachable from wherever the page is. Nothing about the second
requirement wants a socket at all.

### Fixed

- **The control API is mounted on the DSH web server** — `ctx.webServer`, `kind: 'prefix'`, path
  `/__openrouter-plus` — and every browser call is now origin-relative. Same origin as the page means
  no second port, no CORS, no port-fallback probing, and no difference between a desktop tab and a
  phone on the tailnet. Checked against the real `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-host-webserver` over real sockets, not a stub.
- **It sits behind the GUI's own fence.** The mount calls `ctx.connection.requestRejection(req)`, so
  a control request passes exactly the Host/Origin trust check and `dsh-auth-*` session cookie the
  GUI's own API uses. A request with a loopback `Host` and no `Origin` — `curl`, a script — is
  allowed through unauthenticated: the privilege it already had on the relay listener, and what keeps
  the documented `curl` row working. A browser cannot omit `Origin` on a cross-origin request, so the
  exemption is unreachable from a foreign page.
- **`/status` reports the relay's own truth.** New `bound` and `port` fields beside `address`:
  "the relay failed to bind" now arrives with its bind error instead of looking like a dead plugin,
  and the "page cannot reach it" case no longer exists.
- **A live patch reload can no longer leak the relay listener.** `relay.stop()` now awaits an
  in-flight `start()`, so disposing while the bind is still resolving closes the socket rather than
  leaving a stray listener behind. Found by the new mount tests, not reported.
- **The status pill rendered its own key name.** `status.online` / `status.offline` /
  `status.checking` were never in the dictionaries, so the pill read `status.offline` next to the dot.
  Added in both languages: *online*, *not answering*, *checking…*.

### Changed

- The browser half carries no loopback literal, no relay port and no origin guessing. A source-level
  test pins that, because it is exactly the invariant the old bundle broke.
- The offline card says *"OpenRouter Plus is not answering"* with the Host's own reason. The
  *"Expected origin … fallback ports 8791–8794"* hint described the old topology and is gone.
- The relay listener keeps the same control endpoints on loopback: the `curl`/script path, and the
  fallback for a profile composition with no web server. The browser never uses it.
- README, architecture notes and the bundle patch comment now describe the split — relay = data
  plane, web origin = control plane — instead of promising that nothing is mounted on the web server.
- README gains a screenshot of the live-model picker, which the 0.2.0 notes shipped without.

### Notes

- Needs a Host that mounts `ctx.webServer` and `ctx.connection` (any `dsh web` profile). Where the
  composition has no web server the mount never happens, and the relay copy answers as before.
- **The routing path is untouched.** Provider rows still carry `baseURL = http://127.0.0.1:8791/…`
  because pi-ai dials it from the Host; no config key moved, and pinned mount URLs are unchanged.
- Upgrading needs a `dsh web` **restart**, not just a page reload — the Host half is applied when the
  process starts. Reloading before that restart shows *OpenRouter Plus is not answering — HTTP 404*,
  which is the half-updated state, not a regression.

### Testing

- 127 tests pass (117 existing, plus 8 mount/fence tests in `test/control-web.test.mjs` and 2 client
  invariants). `npm run check` is clean.
- The mount tests cover: registration shape, same-origin read with a session cookie, the
  cookie-less `curl` path, a foreign `Origin`, a cross-site `sec-fetch-site`, a trusted
  non-loopback authority without a cookie, an unknown path (404, no proxy attempt), the write guard,
  and re-registration after unload (the duplicate-path throw).
- An end-to-end smoke against real cordis and the real web server answers: `200` for the page and
  for `curl`, `403` for a foreign origin and for a cross-site request, `404` for an unknown path, and
  the relay's loopback copy still `200`.

## [0.2.0] — 2026-10-27

Adds a second, independent capability: **live model lists**. A provider route's models can now be
edited from the endpoint the route points at, which is the only way to reach models that
`@earendil-works/pi-ai` does not ship yet.

### Added

- **Sync live models…** on every `llm-pi-ai` provider row. It reads the row's own `/models`
  endpoint and opens a checklist of what that endpoint publishes *right now*, with a filter box.
  Each row is one model and one checkbox, and the list is two-way:
  - tick a model the route does not have → it is **added**;
  - untick a model the route already has → it is marked **will be removed** (struck through) and
    dropped on Apply.
  Apply stays disabled until something actually differs, and shows `N to add · M to remove`.
- **Existing entries are never rewritten.** An entry the route already declares keeps its name,
  context window, `maxTokens`, input modalities and effort map byte for byte; additions append, so a
  curated order is not reshuffled. An id the endpoint stops listing is left alone rather than pruned.
- A newly added model gets the reasoning capability from the same evidence `repair` uses, so it
  arrives with an effort selector instead of materialising as "no reasoning levels". Only the models
  just added are filled — repairing older ones stays `repair`'s job.
- **`GET /__openrouter-plus/models?route=<id>[&upstream=<url>]`** — the live catalogue for one route,
  each model marked `inRoute`, resolved through the target registry when the row is relay-routed.
- **`POST /__openrouter-plus/models/add`** — applies an edit: `models` to add, `remove` to drop. An
  id already in the route is reported as `already`, an id the endpoint does not list as `unknown`;
  neither is written. A removal requires `confirmRemove: true`, because an untick is destructive and
  a client should have to say so.

### Why this exists

*Fetch available models* is answered from the catalog baked into `@earendil-works/pi-ai`, and for a
catalog-backed route (`openrouter`) it answers **before** it reads that route's `baseURL`
(`dsh-llm-pi-ai`'s `discoverModels` returns `catalogModels(provider)` first). Pointing the row at a
relay therefore changes nothing: the provider *name* is what short-circuits, not the URL. The
snapshot only refreshes when pi-ai is published, so on the build this was written against it was
missing **65 of OpenRouter's 463 live models**.

A plugin cannot change that function — `registerModelDiscovery` is keyed by the `llm-pi-ai` settings
namespace and refuses a duplicate. It can write the other half: a route that declares `models`
serves exactly that list, ahead of the installed catalog. So this edits the list the user curates
rather than trying to answer for the button.

### Notes

- The write declares the route's `api` (`openai-completions`) when the route has none and a model was
  added. `dsh-llm-pi-ai` resolves a model's protocol from the *route*, never from the entry, and
  `openrouter`'s catalog spans two protocols so no shared value can be inherited; without this the
  whole write is rejected with *"needs an api"*.
- The listing read is bounded (8 MB) and the picker renders a window of 150 rows with a filter,
  because a route can point at an endpoint reporting hundreds of models.
- `:batch` endpoints are excluded by default: 71 of OpenRouter's 463 ids are the asynchronous batch
  API, not chat endpoints. Other variants (`:free`, `:nitro`) are kept.

## [0.1.1] — 2026-10-27

### Changed

- The UI says **preset** everywhere. The recent-requests column header read `Tier`, the provider
  row hint and the empty state said "service tier", and the Chinese strings said 服务等级; the
  rename to presets had missed all five.
- README gains screenshots of the provider switch, both halves of the settings page, and the
  composer chip — the four states worth seeing before installing.

## [0.1.0] — 2026-10-26

First release: a loopback relay that applies an OpenRouter **routing preset** to a request at
send time, chosen per Session from the composer.

### Added

- **Nine routing presets**, each a named wire effect rather than a price promise: *No pin*,
  Standard (`service_tier: "default"`), Fastest · any price (`provider.sort: "throughput"`),
  Fastest · standard price, Cheapest (`provider.sort: "price"`), Flex
  (`service_tier: "flex"`), Priority (`service_tier: "priority"`), Ultra
  (`service_tier: "ultrafast"`), Floor (the `:floor` model variant).
- **A preset chip in the composer**, next to the model selector: the choice applies to one
  Session, is never written to a provider row, and the first entry returns the Session to the
  profile default.
- **OpenRouter Plus settings page**: relay state and origin, one pinned base URL per preset with
  a copy button, live request/token counters per tier, the measured effective multiplier, recent
  requests, and a provider-route switch that repoints one existing row at the relay.
- **Pinned base URLs** (`/v1`, `/default/v1`, `/flex/v1`, `/priority/v1`, `/ultrafast/v1`) for the
  case a per-Session choice cannot cover: a route pinned this way keeps its preset for every
  Session on it and across restarts.
- **`defaultPreset`** — the preset an unchosen Session inherits, edited on the settings page.
- **A relay control API** on loopback only: `status`, `targets`, `tier`, `traffic`, plus the
  route attach/detach/repair endpoints the settings page drives.
- **Reasoning-effort fill** for relay-routed models, so a route that points at the relay keeps the
  thinking-level selector.

### Notes on the wire

- No preset is ever sent as `provider.sort` together with `service_tier: "flex"`, and `default`
  is only written when the preset asks for it, never as a default for an unset choice.
- `ultrafast` is OpenAI-only and needs `max_tokens`; the relay warns when a Session sets it
  without one and never injects the field.
- A `provider` block on the request is merged, not replaced, so `provider.only`, `provider.order`
  and `provider.ignore` survive every preset.
