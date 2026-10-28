# Changelog

Notable changes to `dsh-openrouter-plus`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/), and the project stays below 1.0 while the routing presets and
the config keys can still change.

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
