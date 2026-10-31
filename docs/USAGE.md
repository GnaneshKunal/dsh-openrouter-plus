# Spend: cost, not a token estimate

The relay reports what OpenRouter **billed** for a request, next to the token counts it always
reported. The two are not interchangeable, and this page explains where each one comes from, how long
it survives, and what a missing number means.

The short version: `usage.cost` is a receipt. A token count is a measurement. Only one of them can be
added up into money.

## Where the number comes from

Every OpenRouter response that reports usage carries an amount, and the relay copies it from the
response it already forwards:

| Field | What it is |
| --- | --- |
| `usage.cost` | the credits (USD) OpenRouter charged for that request |
| `usage.cost_details.upstream_inference_cost` | what your own provider billed, when BYOK |
| `usage.cost_details.upstream_inference_prompt_cost` / `…_completions_cost` | the same split into prompt and completion |
| `usage.cost_details.server_tool_cost` | charges for server-side tools the endpoint ran |
| `usage.is_byok` | whether the request used your provider key |
| top-level `service_tier` | the tier that actually served it |
| top-level `model` | the model that actually answered (a fallback may change it) |
| top-level `id` (`gen-…`) | the generation id OpenRouter's dashboard and Generation API know it by |

The relay reads these out of a bounded **head** (the first 8 KiB, where the generation id and the
first envelope arrive) and **tail** (the last 64 KiB, where a stream's final usage block lands). The
bytes on the wire are passed through unchanged — sniffing is a copy, never a rewrite — so a stream's
delivery timing and content are exactly what the provider sent. A stream the caller aborted still
keeps its generation id, which is what makes the charge findable afterwards.

## Why the relay does not multiply tokens by prices

A price table would be wrong exactly where this plugin is useful.

`usage.cost` already reflects **which endpoint served the request**: a flex endpoint bills half price,
priority and ultrafast bill a premium, a `:floor` model variant is a different slug, and an upstream
fallback can answer with a different model than the one asked for. The relay does not know which
endpoint will win until the response comes back, and by then the billed amount is right there. A
token × price estimate computed from the *request* would describe a hypothetical endpoint, not the one
that ran.

The prices themselves are also not ours to hold: OpenRouter publishes model prices, changes them, and
prices per provider and per variant. Baking a table into a plugin means shipping a number that is
stale on the next price change, and presenting it as spend. So the relay shows the receipt, or
nothing.

That is also why the multiplier view survives only as a **weight**: `effectiveMultiplier` compares
tiers with each other (`flex: 0.5`, `priority: 2`, …). It is not dollars and is never added to
`costUsd`.

## Local days, and a 14-day window

Cost is bucketed by **local calendar day** (`YYYY-MM-DD`, the user's own day, not UTC): every surface
that reads it says "today", so the boundary is the day the person is living in. The window is the
**14 most recent local days that carried a request** (`USAGE_DAY_LIMIT`); a day that falls out of it
takes its money with it, and a quiet day costs no slot.

- `metrics.costUsd` — everything in the retained window.
- `metrics.todayUsd` — the local day in progress only.
- `metrics.days[]` — one row per retained day, newest first: `{ date, requests, promptTokens,
  completionTokens, costUsd }`.
- `metrics.byModel` — today's model rollup; `metrics.byModelAll` — the whole retained window. Both
  are sorted by spend descending, then by tokens descending, so a model with traffic is not hidden
  under a cheaper one with a single call.
- One day keeps rollups for at most **40** models (`USAGE_MODEL_LIMIT`). The cheapest tail is
  dropped from the *rollup*; the day's totals still count every request.

### It survives a Host restart

The day buckets are written to
`$DSH_HOME/storages/dsh-openrouter-plus/usage.json` as `{ "version": 1, "days": [...] }`:

- read **synchronously** at plugin start, so the first request after a reload cannot race the
  hydrate (and be overwritten by it);
- written on a **5 s debounce** after traffic, and again on dispose;
- replaced **atomically** — a temp file in the same directory, then a rename — so a crash mid-write
  cannot leave a half-file for the next start to reject;
- mode `0600`, capped at 256 KiB. A malformed, oversized or unreadable file is ignored: a bad
  snapshot costs the history, never the boot.

The file holds the whole telemetry snapshot, not just money (`version: 2`, and a `version: 1` file
from an earlier build still loads): the day buckets, the per-tier split, the per-session rollup, the
recent-requests ring and the counters. The dialog therefore opens with its log, its session table and
its per-preset split intact after a restart, instead of an empty shell with only the total cost.

Deleting it starts the history over from the restart. `version` bumps are forward-only: an unknown
version is ignored rather than guessed at.

## What a reload keeps

| Keeps | Starts again |
| --- | --- |
| `costUsd`, `todayUsd`, `days[]` | `uptimeMs` (and `startedAt`) |
| `byModel`, `byModelAll`, per-model cache-token rollups | nothing else |
| `byTier` counters and `byTier[*].costUsd` | |
| `bySession` (ids, spend, tokens, last activity) | |
| the `recent` ring, counters and `effectiveMultiplier` | |

Session **titles** are not stored in the file: they belong to the Host's session log, are resolved on
each status poll through the Host's `sessionQuery` service and cached for a minute, so a renamed
conversation follows without rewriting the usage snapshot.

## `null` means "not reported". `0` means free.

They are different answers and the UI treats them differently:

- **`null`** — the provider reported no amount: a failed call, a stream aborted before its usage
  chunk, or an endpoint that does not send usage. The recent row keeps `costUsd: null` and the
  dialog says *not reported*; the sum contributes nothing.
- **`0`** — the response said the call cost zero, which a free endpoint genuinely does. `0` is kept
  as `0`, and a free model with traffic gets a row on the card.

Inventing a zero for an unreported amount would be a claim, so the code never does. A request that
reported nothing still increments the day's `requests` count (and `errors` for a 4xx/5xx), but creates
**no model row** — an empty line would push a real model down the card.

The same rule applies at ingest: a non-finite, negative or absurd amount adds no money to any total
(the raw value is still what the row records), and a non-finite or negative token count becomes the
documented zero.

## BYOK: two bills, never one total

When `is_byok` is true the request ran on **your** provider key:

- `usage.cost` is what **OpenRouter charged you** (its fee for the request; for many BYOK providers
  this is `0`).
- `upstreamCostUsd` (`cost_details.upstream_inference_cost`) is what **your provider bills you** for
  the same call.

They are separate charges from separate companies, so `metrics.costUsd` sums only `usage.cost`.
Showing the upstream amount as spend would double-bill the request or, worse, replace OpenRouter's
receipt with an estimate. If the dialog shows both, they are two bills — not a total.

## Where you see it

- **Sidebar card** — at the sidebar's foot: one line, `OpenRouter` and today's spend, and a press
  opens the dialog below (the card does not unfold in place). On by default; hidden with the **Show
  spend card in the sidebar** switch on the settings page (or `usageWidget: false` in the profile),
  which never hides the numbers themselves. The card draws nothing on a Host that predates the cost
  fields, and nothing while the sidebar is in its collapsed rail.
- **Details dialog** — today and all time (the retained window) sit above four tabs: **Models**
  (a table: model, input, cache read, cache write, output, requests, cost, with a totals row),
  **Requests** (the last 50 with time, model, serving provider, preset, session id + title, status,
  duration, stream, cost and tokens), **Presets** (cost by routing outcome) and **Sessions** (name,
  id, requests, tokens and spend per relayed session). Each request row expands (one at a time) into the raw
  OpenRouter fields — served model and tier, BYOK, generation id, and the cost breakdown: the
  charged total, the BYOK upstream leg, its prompt/completion split and server-tool charges.
- **OpenRouter Plus settings page** — the *Spend impact* section gains **Today** and **All time**
  rows and a cost-per-preset table beside the counters it already had; its compact recent-requests
  table is unchanged, because the per-request cost detail belongs in the dialog.
- **`GET /__openrouter-plus/status`** — the full snapshot, including the day buckets, for `curl` and
  scripts:

```bash
curl -s http://127.0.0.1:3080/__openrouter-plus/status | jq '.metrics | { costUsd, todayUsd, byModel }'
curl -s http://127.0.0.1:8791/__openrouter-plus/status | jq .metrics.days
```

## What this is not

- **Not a budget or a limiter.** Nothing is enforced; there is no cap, no alert, no refusal. The
  numbers are telemetry.
- **Not a replacement for the OpenRouter dashboard.** A missing or delayed usage block, a request
  that never reached the relay, or traffic on another key is invisible here. For invoices and
  reconciliation, OpenRouter is the source of truth.
- **Not exact beyond its precision.** Amounts are stored at full precision and rounded to 1e-9 in
  the snapshot the API serves. The generation id is the join key when you do need to reconcile one
  request by hand.
