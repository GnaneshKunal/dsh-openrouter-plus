# Changelog

Notable changes to `dsh-openrouter-plus`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/), and the project stays below 1.0 while the routing presets and
the config keys can still change.

## [Unreleased]

### Changed

- README: a screenshot of the live-model picker, which the 0.2.0 notes shipped without.

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
