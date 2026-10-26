# Changelog

Notable changes to `dsh-openrouter-plus`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/), and the project stays below 1.0 while the routing presets and
the config keys can still change.

## [0.1.0] — unreleased

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
