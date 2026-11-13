# Changelog

Notable changes to `dsh-openrouter-plus`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/), and the project stays below 1.0 while the routing presets and
the config keys can still change.

## [Unreleased]

## [0.8.0] — 2026-11-13

**The precision floor can be set once for the profile, instead of once per new conversation.**
The floor was a Session choice in the composer chip, and the profile key behind it
(`precisionFloor`) could only be edited by hand, so every new Session started on `any` and the
same choice had to be made again. Settings → OpenRouter Plus now sets it beside the preset for new
sessions, while the chip keeps choosing for one Session.

### Changed

- The existing new-session preset setting is labelled **Service tier preset for new sessions** so
  its purpose is easier to find. Composer choices remain session-specific.

### Added

- **Precision floor for new sessions** — a picker in Settings → OpenRouter Plus with the four
  floors the composer offers (`Any`, `No four-bit`, `Eight-bit up`, `Full width`), a hint naming
  the wire levels the selected floor admits, and **Admit endpoints with unknown precision** for the
  `includeUnknown` half of the policy. It writes the plugin's own row on `precisionFloor` through
  `POST /__openrouter-plus/precision/default` — the route the feature already had; this is its
  control — so the choice survives a restart and every Session that has not chosen its own floor
  inherits it. Like the preset default, the save is a config write, so the plugin reloads and the
  per-Session floors held in memory are dropped; the docs say so.
- **`GET /__openrouter-plus/targets` carries both profile defaults.** It gains
  `precision: { default, floors }` beside `tier: { default, presets }`, because the page reads
  them in the answer it already loads. A Host from before the field answers none, and the page does
  not draw the control: a preference whose write would 404 is worse than an empty space.
- **A floor change carries that floor's unknown-precision answer** — `no-four-bit` and
  `eight-bit-up` admit undeclared endpoints, `full-width` and `any` do not — and the checkbox
  overrides it explicitly. `Any` disables the checkbox: it sends no `quantizations` list, so
  there is nothing to append to.
- **The composer's Precision pane can hand a Session back to the profile default.** It now opens
  with `Profile default (…)` beside the four floors, the first row Tier has always had; picking it
  clears the Session's floor (`precision: null`) so the profile default applies again. Without it
  the new preference would be a one-way door: once a profile default stopped being `any`, picking
  `Any` in the composer would become an explicit Session choice, and there was no way back to
  inheriting short of a Host restart.

### Notes

- The precision floor is not a hard guarantee: requests go unfiltered while a model’s endpoint
  listing is unavailable or when no listed endpoint satisfies the floor. Bypasses are counted on
  the settings page. See [Precision](https://github.com/GnaneshKunal/dsh-openrouter-plus/blob/v0.8.0/docs/PRECISION.md) for the admission policy.

## [0.7.1] — 2026-11-03

### Fixed

- **The Settings page paints its last answer instead of drawing nothing.** The page is normally
  opened over a Session that is still streaming, and a tab under that load can lose its first
  `/status` read to the twelve-second timeout: `snapshot` stays `null`, every section is gated
  on it, and the operator is shown the heading, the one-line intro and a "not answering" card —
  no routes, no usage, no display controls. Writing a display preference made it likely, because
  that write re-reads the status. The last successful answer is now kept per tab in
  `sessionStorage` and painted on mount while the first poll is in flight; the poll replaces it
  as soon as one lands. Nothing is trusted on the way back in — the cached body is put through
  the same normaliser the wire answer is — and a store that is absent, full or forbidden simply
  leaves the page waiting for the poll, as before. The paint covers every mount after this tab
  has answered once; the very first open in a busy tab still has no answer to paint.
- **A failed re-read no longer withdraws the display controls.** A 404 is the route being gone,
  and that still withdraws the control — and the cached answer with it, so the next mount cannot
  seed one whose write would 404. A 5xx, or the rebind that cuts the answer to the write that
  caused it, leaves the section standing.
- Hardening, not the fix above: the status poll schedules its next tick in a `finally`, and reads
  the translate function through a ref so the effect depends on `refreshKey` alone. The page is
  handed one stable bound `t` today, so neither changes behaviour now; neither can become a way
  for the poll to stop.

## [0.7.0] — 2026-11-03

**The endpoint menu can be ordered and searched, and it re-reads itself whenever it opens.** The
first half is the setting the list always lacked: forty-five rows had exactly one order (cheapest
first) and no way to narrow them, so `providerFacts` now carries a sort and the pane carries a
search box. The second half is a repair. The composer read a model's listing once, at mount, and
held it in component state; the numbers only exist on an authenticated read, which the relay makes
on the first request that names the model. A page loaded before that request therefore painted the
keyless answer — price and uptime, no speed — and kept it for the life of the tab: the ten-minute
client cache below only decided what a *remount* painted, and opening the menu is not a remount, so
the effect that fills the list never ran again.

### Added

- **Sort endpoints by** — one choice in **Provider list display**: `default` (the Host's own
  cheapest-first order), `throughput`, `latency`, `uptime`, `input`, `output` or `cacheRead`.
  Each id names a fact and the fact owns its direction — throughput and uptime read best-high, the
  prices and latency best-low — so the menu never asks for a second "ascending" control. The order is
  applied *inside* each group the Host declared, so the Standard / Flex / Not used headings stay put,
  and a row that does not report the fact sorts last in both directions: on a keyless listing nothing
  reports speed, so a speed sort reads exactly as `default` instead of inventing an order out of
  nulls. This is a display order, not `provider.sort`: it never changes a request. The control is
  drawn only when the Host's `/provider-facts` answer carries `sort`, because a Host from before
  the field would drop the write and store what it already had.
- **A search box above the endpoint list.** Matches a display name or a tag, hides rows rather than
  groups (a group emptied by the filter takes its heading with it), and always keeps the "Auto
  (OpenRouter routing)" row so an accidental pin is always clearable. Escape empties the box before
  it leaves the pane; the query is view state and dies with the menu. Nothing is asked of the Host:
  it filters the listing the pane already holds.

### Fixed

- **The Provider pane re-reads its listing on open.** `readProviderList(origin, model, signal)` is
  now the one place the client asks for a model's endpoints: the mount effect paints from the client
  cache when it has one, and the pane's own open (`refreshProviderPane`) asks again — one read at a
  time, the rows already on screen kept until the answer lands, and a late answer for a model the
  composer has since left is dropped rather than written over the new model's rows.
- **A refused listing is "no answer", not "no endpoints".** A 404 from a Host that predates the
  route, a 502 from the route itself, and a cut or aborted body all read as `null`, so an outage
  leaves the rows that are still true on screen instead of blanking the pane.
- **An empty listing no longer blanks the pane either.** The Host caches a failed upstream read as
  an empty listing and answers it `200` with no `error`, so a broken upstream and a model with no
  endpoints are the same body on the wire. Over rows already on screen that answer now reads as no
  answer and is not cached over them; with nothing on screen it is still the only truth available.
  Reads are also numbered as they start, so a slower earlier read cannot paint over a newer one.

## [0.6.0] — 2026-11-02

**The endpoint menu can say how fast a provider answers, not only what it charges.** OpenRouter
reports per-endpoint latency and throughput in the same listing the picker already reads — but both
fields come back `null` unless the request carries an API key, which is why 0.5.0 left speed off the
row. The relay never stores a key and already spends the caller's one request at a time on a
follow-up read, so it now spends it on the listing for the model that request named, and keeps the
numbers rather than the key.

### Added

- **`latency` and `throughput` on every endpoint row** — `{ p50, p90 }` or `null`: time to first
  token in milliseconds, output tokens per second, both OpenRouter's rolling 30-minute percentiles.
  Parsed in `lib/providers.js` from `latency_last_30m` / `throughput_last_30m`, carried by
  `GET /__openrouter-plus/providers`, printed by the composer's endpoint menu. A listing read
  without a key reports neither, so a row that has never been routed omits the fact instead of
  printing a zero.
- **`onModelSeen(model, authorization, destination)` on the relay.** Called for each forwarded
  request that named a model, never awaited. The Host answers it with one authenticated listing read
  (`readProviders(..., { authorization })`), caches the rows and drops the key — the rule
  `generationLookup` already followed. `destination` is what lets it refuse a request that went to
  another upstream: a key belonging to one provider is never presented to another.
- **`providerFacts` (config) and `GET`/`POST /__openrouter-plus/provider-facts`**, plus a
  **Provider list display** section on the settings page: one checkbox per fact (precision, price,
  uptime, throughput, latency) and a choice between the median alone and the median beside p90. All
  facts default to on. The page stages the edit and posts once, because a config write re-applies
  the plugin and rebinds the relay; the composer chip reads the same object in its own small
  request, so a change reaches an already-open composer.

### Changed

- **An authenticated listing outlives the row TTL**, for `PROVIDERS_STATS_TTL_MS` (30 minutes — the
  window its numbers describe), and an anonymous read can no longer replace it while it is fresh.
  Without that, every menu refresh would trade the speed facts for a freshness they already have.
  An authenticated read through a fresh anonymous entry upgrades it, which is what makes the menu
  show numbers as soon as a request for that model has gone through.
- **`readProviders()` takes an optional `authorization`**, forwarded verbatim for that one GET and
  stored nowhere. An empty value sends no header at all: a blank one would turn "no key" into
  "no listing".

### Notes

- **Corrects the 0.5.0 note below.** `latency_last_30m` and `throughput_last_30m` were `null` on
  every model tested *because those reads carried no key*. Measured the other way on 2026-11-02,
  `openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints` returns populated
  percentiles for all 42 endpoints once an `Authorization` header is present, and differs in
  exactly those fields — so the numbers are public facts behind a login, not account data, and one
  read can be cached for every Session.
- **The two speed facts read in opposite directions.** A latency p90 is *worse* than its p50; a
  throughput p90 sits *below* its p50, because a throughput percentile is a rate that N% of requests
  reached or exceeded. The paired form is therefore labelled (`p50 134 · p90 58 tok/s`) rather than
  printed as a range.

## [0.5.4] — 2026-11-01

**The diagnostics are opt-in.** 0.5.3 added control-API timings to `/status` and a log line per
slow call, on by default. That is the wrong default for the hosts this plugin also runs on —
metered, memory-tight, where a diagnostic that costs nothing on a laptop is still cost with no
upside, and the failure it explains ("not answering" while the Host is merely busy) is one an
operator opts into debugging.

### Changed

- **`controlDiagnostics` (default `false`).** Off, the control layer attaches no `finish`
  listener, keeps no ring, emits no log line, and `/status` carries no `control` block — the
  whole diagnostic is one boolean test per request. Turned on, behaviour is exactly what 0.5.3
  shipped: a 20-entry in-memory ring (still no disk, still no timers) and one `[openrouter-plus]`
  line per slow or failed call.
- Nothing else about logging changed. The plugin has never written to a file; its lines go to the
  Host's own logger, which in a default install is the terminal the Host was started from.

## [0.5.3] — 2026-11-01

**"Not answering" was a false alarm, and it was undiagnosable.** The settings page timed out on
`/status` after 2.5 s and flipped to a red "OpenRouter Plus is not answering — the control API did
not answer within 2.5 s" banner. The relay was fine: idle it answered in 1–86 ms, and the same
endpoint blew the budget only while a turn was streaming. The browser log showed the truth —
`GET /__openrouter-plus/status [net::ERR_ABORTED]`, over and over, exactly during turns.

### Fixed

- **`/status` no longer waits unboundedly on session titles.** It resolved a title for every session
  in the last 50 requests, each a Host service round trip — the busiest calls in the process while a
  turn is running. Cached titles are used immediately and the rest now get one 600 ms window; a title
  that misses arrives on the next poll. Titles are decoration, the counters are the answer.
- **The page needs three consecutive failures before it says anything.** A single slow poll, a
  plugin reload or a route edit all used to blank the page into the error state while the last good
  numbers were still true.
- **The status poll's own timeout is 12 s, not 2.5 s.** It is a background refresh; nothing is
  waiting on it.

### Added

- **`control` on `/status`** — `{ slowMs, recent: [{ at, path, ms, status }] }`, the last 20 control
  calls that took ≥1 s or failed. This is what turns "not answering" into "these calls were slow,
  and here is how slow".
- **A log line for every slow or failed control call** (`[openrouter-plus] control API call was
  slow/failed` with the path, duration and method), so the Host log answers the question without
  opening DevTools.

## [0.5.2] — 2026-11-01

**The Provider column, for real this time.** 0.5.1 taught the reader the Responses-API envelope,
which fixed cost and tokens — but the provider stayed `—`, because the Responses API does not name
it anywhere: not in the body, and not in a header (`X-Provider-Name` is advertised in
`access-control-expose-headers` and then not sent on a streaming response). The only per-request
source is OpenRouter's own generation record.

### Added

- **`generationLookup`** (default `true`): when a response did not name its provider, or reported
  no bill, the relay reconciles it against `GET <upstream>/generation?id=<genId>` — the id it
  already captures from the body or `X-Generation-Id`. One authenticated GET per affected request,
  issued after the response has been fully sent, eight in flight at most, silent on failure. The
  caller's `Authorization` is used for that call and stored nowhere.
- **The lookup retries, because the record is eventually consistent.** `GET /generation` answers
  `404` for roughly the first five seconds after a completion and `200` from about seven — measured
  on this account. A single attempt would miss nearly every request, which is exactly how a lookup
  that works from `curl` a minute later still fills nothing in practice. Five attempts over ~8 s,
  cumulative, all after the caller has their response.
- **Only missing fields are filled.** A number the stream reported is what the caller saw, so it
  wins; the lookup supplies `provider_name`, and `total_cost` / `native_tokens_*` when the stream
  produced none. That also rescues a stream whose final event was too large for the tail buffer,
  which is why some long completions showed "not reported" while short ones were billed.

### Changed

- **The Session column leads with the name.** It used to print a truncated session id as the cell's
  text and demote the title to a caption, so every row read `session-a1c2e594-…` with the actual
  conversation name underneath. The name is the primary text now, the short id is the caption, and
  a Session the Host has no title for (a subagent, a sweep) still shows its id rather than nothing.

## [0.5.1] — 2026-11-01

**The Requests tab was blind on `api: openai-responses` routes.** Every row read "not reported" for
cost and tokens and `—` for provider, while OpenRouter had billed the request correctly. The bug was
one level of nesting: the relay's usage reader looked for `usage` on the event envelope, and the
Responses API puts it at `response.usage`.

### Fixed

- **The Responses API envelope is unwrapped before reading usage.** A route configured with
  `api: openai-responses` streams events shaped `{ type, response: { … usage … } }`; reading only
  `envelope.usage` found nothing, so every such request was recorded with a null bill and null
  token counts. Both shapes are now read through one function, since one route may use either.
- **The Responses API's field names are understood.** `input_tokens` / `output_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`, and the
  `upstream_inference_input_cost` / `upstream_inference_output_cost` halves of `cost_details` are
  read alongside their Chat Completions spellings.
- **`X-Provider-Name` and `X-Generation-Id` are read as fallbacks.** OpenRouter exposes both on the
  response headers (advertising them in `access-control-expose-headers`) and a Responses body repeats
  neither, so a proxy is the only consumer that can carry them into the record. This is what fills the
  Provider column and gives an aborted stream a generation id to reconcile later.

### Notes

- Records written before this release keep their nulls; the ring buffer is process-local, so a Host
  restart is also what clears them.
- The relay already forwarded both headers to the caller untouched — only the record was missing them.

## [0.5.0] — 2026-11-01

**A fourth lever, and it outranks the other three.** A tier picks a pool and a floor picks a
precision; neither picks the *company*. On a model served by 42 endpoints — DeepSeek V4.1 Flash 1017
is one — "which endpoint" is a real choice with a real price spread ($0.035 against $0.45 per million
input for the same weights), and the only lever that expressed it was editing the request body by
hand, which a provider profile cannot do.

This release adds a **Provider** facet to the composer chip, read from the model's own public
listing, and sends it as a *hard* pin.

### Added

- **A Provider facet in the chip.** The menu is now three cells — Tier, Precision, Provider — and the
  Provider one lists the model's live endpoints with what each costs and how often it answers. An
  endpoint the listing reports with no uptime is drawn quiet rather than hidden: pinning a
  struggling endpoint by hand is a legitimate thing to want.
- **A pin disables the pair it decides.** Choosing `deepinfra/fp8/priority` changes the Tier cell to
  `Priority` and the Precision cell to `fp8`, and disables both — the endpoint already *is* that
  lane at that precision, so offering the levers could only build a request the router rejects.
  They leave the keyboard walk and refuse a drill; clearing the pin (**Auto**) restores the Session's
  previous Tier and Precision untouched.
- **`lib/providers.js`**, the listing read for display: token prices normalised to dollars per
  million with the rounding that keeps `$0.035` from printing as `$0.034999…`, tier and region
  derived from the tag, `status` read as availability, grouping in the model page's own order
  (standard, flex, priority, unavailable), and `precisionLevels()`/`tagsOf()` so one read can answer
  admission too.
- **`GET /__openrouter-plus/providers?model=<id>`** and **`GET|POST /__openrouter-plus/provider`**,
  the control-API surface behind the facet. The pin routes are memory-only, like `/tier` and
  `/precision`; a slug the model does not list is refused with `404` while the operator can still
  see the list they picked from.
- **`x-oorp-pin`** on every relayed response: the slug that was routed to, `bypass` when a pin was
  configured but withheld because the listing no longer backs it, `none` when nobody pinned anything.

### Changed

- **A pin subsumes the other levers rather than joining them.** The relay writes `provider.only` and
  `allow_fallbacks: false`, and *removes* the fields that would contradict the choice:
  `service_tier`, `provider.quantizations`, `provider.ignore`, and a `:floor`/`:nitro` model variant.
  A floor of `fp8` beside a pinned `fp4` endpoint is not a narrower request, it is an empty one.
  `sort` and `order` are left as the caller wrote them — inert over a one-element allowlist.
- **The precision floor is reported as `any`, not `bypass`, while a pin is in force.** The pin did
  not withhold the floor, it superseded it; calling that a bypass would report a healthy pin as a
  broken floor.
- **One provider listing now seeds both caches.** The facet's read and the floor's admission read the
  same URL, so the wider read fills the four-field cache as well. Two effects: one public GET per
  model per TTL instead of two, and the first request after a pin is already pinned — without it,
  admission would still consider the listing unread and that turn would go out unpinned.
- **`parseProviders()` never reaches the request path.** Admission stays synchronous and reads the
  four-field cache; the fat, lazy listing is touched only by the control API.

### Notes

- The public endpoints API returns `latency_last_30m` and `throughput_last_30m` as `null` for every
  model tested *without a key* (corrected in 0.6.0, which reads them authenticated). The facet
  therefore shows price, precision and uptime, and leaves speed to the model page rather than
  printing a placeholder that reads as zero.
- **`status` is read but not interpreted.** It looked like a "routed / not routed" flag and is not
  one: `deepseek/deepseek-v4.1-flash-1017` reports `status: -5` on the endpoint that carries a third
  of its tokens. Availability is derived from the uptime windows instead — every reported window at
  zero is the only positive evidence of a dead endpoint — so a non-zero code can never quiet the
  model's busiest provider.
- A pin is Session state, not model state: it survives a model switch, and the relay withholds it
  for any model whose listing does not offer that slug. The facet says so once a listing arrives.

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
