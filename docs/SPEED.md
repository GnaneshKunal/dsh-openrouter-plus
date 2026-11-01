# Throughput and latency in the provider list

Research note, then the record of what shipped in 0.6.0. It answers one question: can the
composer's provider list — which already states quantization, price and uptime per endpoint —
also state how fast that endpoint is right now?

Short answer: **yes, and the data is already in the response the plugin reads — but only when
the request is authenticated.** The keyless read returns both fields as `null`, which is why
0.5.0 left speed off the row. The measurements below were taken on 2026-11-02; §8 is what the
plugin now does with them.

---

## 1. What the upstream actually reports

`GET <upstream>/models/<author>/<slug>/endpoints` carries two fields the plugin does not read:

| field | type | meaning |
|---|---|---|
| `latency_last_30m` | `{ p50, p75, p90, p99 }` | time to **first token**, in **milliseconds**, rolling 30-minute window |
| `throughput_last_30m` | `{ p50, p75, p90, p99 }` | **output tokens per second**, rolling 30-minute window |
| `perf_last_30m_by_workload` | `{ text_generation: { latency, throughput, request_count }, … }` | the same numbers per workload, plus the **sample size** |

Schema (`components/schemas/PercentileStats` in `https://openrouter.ai/openapi.json`) requires
all four percentiles; both fields are `object | null`.

**Two semantics that a label must not get wrong:**

- **Latency percentiles are conventional** — p90 is *worse* than p50 (higher = slower).
- **Throughput percentiles are inverted** — "pN is the speed that N% of requests reached or
  exceeded", so p90 is *lower* than p50. A row that prints a median throughput and a p90
  latency is mixing two directions; saying which percentile you print is not optional.
- For a single number, **p50** is the honest choice for both. `request_count` is the only
  signal of how much traffic that percentile rests on.

Units disagree across the API surface: the listing reports latency in **milliseconds**, while
the routing preference `preferred_max_latency` (§7) is expressed in **seconds**.

## 2. The fields are null unless the request is authenticated

Measured live on 2026-11-02 against `deepseek/deepseek-v4.1-flash-1017` (42 endpoints), and
spot-checked on `openai/gpt-5`, `google/gemini-2.5-pro`, `anthropic/claude-sonnet-4.5`:

| request | `latency_last_30m` | `throughput_last_30m` | `request_count` |
|---|---|---|---|
| no `Authorization` (what the plugin sends today) | `null` on **42/42** | `null` on **42/42** | absent |
| `Authorization: Bearer <any OpenRouter key>` | **42/42 populated** | **42/42 populated** | 42/42, e.g. `45295` |

The OpenAPI descriptions say it outright: *"Only visible when authenticated with an API key or
cookie; returns null for unauthenticated requests."*

Real rows from that authenticated read:

```
OpenInference  fp4   latency p50 929.5 ms  p90 3768.5 ms   throughput p50 101 tok/s  p90 35 tok/s
Relace         fp4   latency p50 498.0 ms  p90 1438.0 ms   throughput p50 134 tok/s  p90 58 tok/s
Wafer          us    latency p50 274.5 ms  p90  701.8 ms   throughput p50 169 tok/s  p90 94 tok/s
```

**Nothing else differs.** A field-by-field diff of the anonymous against the authenticated body
over all 42 endpoints found exactly three differing fields — the two percentile objects and
`perf_last_30m_by_workload`. Same tags, same order, same prices, same uptimes, same envelope.
So these numbers are public endpoint facts gated by a login, **not** account-personalised data:
a listing read with any key can be cached and shared with every Session without leaking
anything about whose key fetched it.

That also means the note in `CHANGELOG.md` ("The public endpoints API returns … as `null`
for every model tested") records a true observation and a wrong reason. Speed was never missing
from the API; it was missing from the *unauthenticated* read. The consequence is the same
(`0.5.0` shows price/precision/uptime) but the sentence should say "unauthenticated", or a
future reader will not look for the header.

## 3. Where a key could come from

The relay holds no key of its own by design (`cordis.patch.yml`: *"the relay forwards the
caller's Authorization header and holds no key of its own"*). Three routes, in order of how
much they disturb that promise:

**A. Reuse the caller's `Authorization`, in flight (recommended).** The relay already does
exactly this: `lookupContext` (`lib/proxy.js`) reads `req.headers.authorization`,
spends it on one `GET <upstream>/generation?id=…`, and states the rule — *"used for exactly one
follow-up call; it is never written anywhere"*. The same shape works here: when a chat request
for model *M* passes through, fire-and-forget an authenticated read of *M*'s listing and cache
the **stats**, never the key. No new config, no stored secret, no cold-start coupling beyond:
a model you have never routed has no speed numbers yet (the fact is simply dropped, which is
already this row's rule for absent data).

**B. Name an environment variable in config.** The Host would read `process.env[name]` at fetch
time. This is a different promise from A — the relay would be *reaching for* a secret rather
than forwarding one it was handed — so it should be opt-in. It is also unreliable in this
install as configured: the Host process does carry `OPENROUTER_API_KEY`, but **not**
`OPENROUTER_CUSTOM_API_KEY`, which is the variable the profile's actual `openrouter-custom` row
names. An env-based read therefore needs a candidate chain and still degrades for that row.

**C. Stay keyless.** Then throughput and latency are permanently absent, and any toggle added
for them renders nothing.

Option A is the only one that needs no decision about secrets, and it is the same pattern
already shipped for `generationLookup`.

## 4. Is the row too crowded? Yes — hence checkboxes

Today one provider row is a single hint line, `providerRowHint` (`client.js`):

```
fp4 · $0.035/0.5 per M · 99.6528%
```

Five facts would make it `fp4 · $0.035/0.5 per M · 99.6528% · 101 tok/s · 930 ms`. Measured
constraints from the current implementation:

- menu rows wrap (`CHIP_OPTION_HINT_STYLE`), menu width ≈ 220 px, menu `maxHeight` ≈ 320 px;
- **all 42 rows mount at once** — there is no windowing, so a fourth and fifth fact lengthen
  every row in an already scrolling list.

So a display preference is the right call, and the page already has the parts:

- the boolean preference pattern is the sidebar-spend checkbox — `<input type="checkbox">`,
  optimistic state, 10 s bounded settle, read-back (`client.js`, `3567-3635`);
- the **multi**-checkbox pattern is the model SyncPicker — one checkbox per row, staged
  selection, one Apply (`client.js`, `4815-4830`). The batch matters: every write to
  the plugin's config row makes the Loader re-apply the plugin and **rebind the relay**
  (`docs/ARCHITECTURE.md:139-146`), so five checkboxes must not mean five POSTs;
- strings live in the inline `en`/`zh` dictionaries (`client.js` / `475-714`), and
  `test/client.test.mjs:556-572` fails if the two key sets differ. `locale/*.json` is plugin
  display metadata only;
- the natural slot is a new section between the "Provider routes" section and "Recent
  requests" (`client.js`).

**Persistence.** Preferences are fields on the plugin's own Loader row, written by
`ctx.configEditor.edit` (`writeUsageWidget` is the closest precedent). A display preference
written that way costs one relay rebind per apply — acceptable, and identical to what the
existing sidebar checkbox already does. The alternative, a small `prefs.json` beside
`~/.dsh/storages/dsh-openrouter-plus/usage.json`, would avoid the rebind but would introduce a
second home for settings, which `docs/ARCHITECTURE.md:506` argues against.

**Reaching the composer.** `providerRowHint` is composed in the browser from the `/providers`
row, so the preference only needs to be *readable* by the chip. Two options: put it on
`/status` (the existing preference channel — `usageWidget`, `precision.default`) and have the
chip do one extra mount GET, or on `/targets`, which the chip already subscribes to through
`targetsFeed`. Do **not** bake it into `/providers`: the client caches that response
(`providerListCache`) until it expires — the ten-minute window this change gives it.

## 5. "At that point" — what the numbers are a snapshot of

Same snapshot as price and uptime, and worth stating in the UI because speed reads as live:

- the Host fetches the listing and stamps `fetchedAt` when the **upstream read completes**;
- it is reused for `PROVIDERS_TTL_MS` = **10 minutes** (`lib/providers.js`), and a cache hit
  re-reports the original `at` with `cached: true`;
- the values themselves are OpenRouter's **rolling 30-minute** window, updated continuously.

So a displayed speed is somewhere between "now" and "about 40 minutes old", and today nothing
in the UI says so: `fetchedAt` and `cached` are already on the wire (`index.js`) and
the client stores them and **never renders them**. If speed is shown, that is the moment to use
them.

There is a second, worse layer: the client's own `providerListCache` has **no TTL and no
eviction** (`client.js`). A tab left open overnight keeps showing
yesterday's speed numbers. That is tolerable for a price; it is not tolerable for "how fast is
this provider right now".

## 6. Cost

Measured on the 42-endpoint model:

| | bytes |
|---|---|
| listing, anonymous (what the plugin reads today) | 47,412 |
| listing, authenticated (all three stat fields) | 59,874 |
| the two percentile objects alone | ≈ 6,935 (≈ 165/endpoint) |
| `/providers` response the page receives today | 25,127 (≈ 579/row) |

Sending only `p50` (and optionally `p90`) plus `request_count` costs tens of bytes per row —
rounding error against `PROVIDERS_MAX_BYTES` (2 MiB) and against a response already 39.7 %
`supportedParameters`. **Payload is not the argument against this feature; row density is.**

One authenticated read per model per cache window is also negligible, and it is the same GET that
already seeds the admission cache, so authentication costs no extra request. It does change one
thing: an authenticated entry outlives the row TTL (§8), because the numbers it carries describe a
30-minute window of their own.

## 7. Adjacent, and cheaper than it looks later

`provider.preferred_min_throughput` and `provider.preferred_max_latency` are real OpenRouter
routing preferences (`ProviderPreferences`), accepting either a scalar (applied to p50) or
per-percentile cutoffs, and they behave like the precision floor this plugin already ships:
endpoints that miss the threshold are **deprioritised, not excluded**. A "fast floor" is
therefore a natural sibling of the precision floor once the listing is read authenticated —
the same data layer, a different write into `provider`.

Note the unit trap: the listing says milliseconds, the routing preference wants seconds.

## 7a. An alternative source, and why it is not the answer

The relay already records, per request, `ms` (whole-call wall clock) and `completionTokens`
(`lib/proxy.js`), and the Requests tab already shows duration (`recent.column.ms`).
Output tokens ÷ elapsed seconds is an observed throughput for **your own** traffic — no key
needed. But it measures a different thing (end-to-end, including queueing), it only covers
endpoints you have actually used, and **TTFT is not measured at all** (nothing timestamps the
first content chunk). Useful as a fallback later; not a substitute for the upstream percentiles.

## 8. What shipped (0.6.0)

The plan above, with the decisions from §9 applied:

1. **Parsing.** `lib/providers.js` reads both `*_last_30m` objects into `latency` and
   `throughput`, each a `{ p50, p90 }` pair or `null`. p75 and p99 are dropped: a menu row can
   carry two numbers, and the median plus the tail are the two worth carrying. `687` bytes of
   JSON per 42-endpoint listing — a rounding error against `PROVIDERS_MAX_BYTES`.
2. **The key.** `createRelay` gained `onModelSeen(model, authorization, destination)`, called for
   every forwarded request that named a model and never awaited. The Host spends it on one listing
   read (`readProviders(..., { authorization })`), caches the rows and drops the key — the same rule
   `generationLookup` already followed. `destination` exists so the read can be **refused** when the
   request went to another upstream: a key that belongs to one provider is never presented to
   another. The `request_count` is not carried; nothing is suppressed.
3. **Cache.** An entry records whether the read was authenticated. An authenticated entry outlives
   the 10-minute row TTL for `PROVIDERS_STATS_TTL_MS` (30 minutes, the window its numbers describe),
   and an anonymous read may not overwrite it while it is fresh — otherwise every menu refresh would
   trade speed for a freshness the numbers already have. An authenticated read through a fresh
   anonymous entry upgrades it, which is what makes the menu show numbers the moment a request for
   that model has gone through.
4. **Rendering.** `providerRowHint(t, row, facts)` composes the line from the enabled facts and
   states a fact only when the Host reported one — so the default costs nothing on a keyless
   listing, and the pre-existing rule holds (“a missing fact is dropped, never printed as a dash”).
   Speed prints in whole units: `134 tok/s · 498 ms`, or with the tail `p50 134 · p90 58 tok/s`.
5. **The preference.** `providerFacts` on the plugin's own row — five booleans, all on — plus
   `percentiles: 'p50' | 'p50p90'`, read and written through `GET`/`POST
   /__openrouter-plus/provider-facts`. The settings page stages the edit and applies it in one
   write, because a config write re-applies the plugin and rebinds the relay. The composer chip
   reads the same object in its own request, so a Settings change reaches an open composer without
   the page's lifetime `/providers` cache freezing the answer.

## 9. Decisions taken

- **Percentiles: both, as a setting.** The page offers the median alone or the median beside p90.
  Default `p50`.
- **Default: every fact on.** A fact the listing does not report is dropped anyway, so "on" costs
  nothing until a model has been used, and "off" would make a working setting look broken.
- **Persistence: the config row.** Consistent with `usageWidget`, at the cost of one relay rebind
  per apply — hence the single batch write rather than a write per checkbox.
- **No suppression.** A low `request_count` is not carried and no number is hidden because of it.

## 10. Still open

- **Aging the numbers in the UI.** `fetchedAt` and `cached` are on the wire and still unrendered;
  with speed on the row, “as of four minutes ago” is the missing half of the sentence.
- ~~The client cache TTL.~~ Fixed in the same change: `providerListCache` now expires after ten
  minutes (the Host's own window) and holds at most eight models, because a page-lifetime entry
  would keep showing the keyless list — no speed — for the rest of the session.
- **A fast floor.** §7 is now one write away: the same authenticated listing could feed
  `provider.preferred_min_throughput` / `preferred_max_latency`, which deprioritise rather than
  exclude, exactly like the precision floor.
