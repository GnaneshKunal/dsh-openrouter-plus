# Precision: what the floor promises, and what it does not

## The problem this solves

On an open-weight model, OpenRouter often serves the same model from several providers at
different precisions. The cheapest endpoint is frequently the most compressed one — that is not a
guess. On `deepseek/deepseek-v3.2` at the time of writing, the nine endpoints are four `fp8`, one
`fp4` (DeepInfra) and four `unknown`, and **the `fp4` endpoint is the cheapest**. The `Cheapest`
preset sorts by price, so it buys the `fp4` endpoint.

That is a real trade, made silently. Lower precision changes how a model handles long context,
careful reasoning, code correctness and strict instruction-following — which is most of what a
tool-calling agent asks of it.

There is a second, less obvious cost. OpenRouter's [Auto Exacto][exacto] runs by default on every
request that carries tools, and reorders providers by measured tool-calling success rate, throughput
and benchmark scores. **Any explicit `provider.sort` disables it** — and so does the `:floor` model
variant. In this plugin that means:

| Presets that keep Auto Exacto | Presets that bypass it |
| - | - |
| `none` (default), `standard`, `flex`, `priority`, `ultra` | `fastest`, `fastest-standard`, `cheapest`, `floor` |

So the two cheapest rungs of this plugin's ladder both land on compressed endpoints *and* switch off
the platform's own quality-aware ordering. A precision floor is the counterweight.

## The floor

A per-Session choice, sitting next to the tier in the composer chip. It is not a preset: a preset is
an outcome (a tier, a comparator, a slug), while the floor is a constraint on which endpoints are
*eligible* for that outcome. They compose — `Cheapest · ≥8-bit` is a meaningful request.

| Floor | Sends `provider.quantizations` | `unknown` | Reads as |
| - | - | - | - |
| `any` *(default)* | nothing at all | — | today's behaviour, untouched |
| `no-four-bit` | `int8, fp6, fp8, mxfp8, fp16, bf16, fp32` | admitted | nothing 4-bit |
| `eight-bit-up` | `int8, fp8, mxfp8, fp16, bf16, fp32` | admitted | nothing below eight bit |
| `full-width` | `fp16, bf16, fp32` | **not** admitted | full precision only |

`includeUnknown` is a separate switch, **on by default** for the middle two floors. It exists because
`unknown` is roughly 40% of the endpoints on the models this plugin routes for: all four of
DeepSeek V3.2's remaining providers, both of GPT-4o's. Excluding it by default would silently halve
the pool for people who never asked for that.

`full-width` defaults it **off**: a floor that says "full width" and then admits endpoints whose
precision nobody declared is not a floor.

## Why the filter is not always sent

Excluding every eligible provider is a hard failure upstream, not a silent fallback: the request
fails. That is not a hypothetical here — `full-width` leaves **zero** endpoints on DeepSeek V3.2,
because every endpoint it has is `fp8` or below. Sending that filter blind would break the turn.

So the relay only attaches `quantizations` once it has seen that at least one endpoint of *that
model* survives the floor. It learns that from `GET /models/{author}/{slug}/endpoints`, which is
public and needs no key.

Practically:

- The floor is applied per model, from a cached endpoint listing (10-minute TTL, bounded).
- If the listing is not cached yet, the request goes out **unfiltered** and the cache warms in the
  background. The relay never makes a request wait on that fetch — a preset that trades latency for
  price (`flex`, `ultra`) exists precisely because that wait matters.
- Each bypass is counted per model and visible on the settings page, so a floor that is not being
  honoured shows up instead of quietly doing nothing. A listing that fails or 404s is cached as empty
  for the same window, so a model this floor cannot serve stays bypassed and visible rather than being
  re-fetched on every turn.
- With the floor on `any`, nothing is fetched and nothing is added to the body. An existing profile
  is byte-identical to one that predates this feature.

The cost is one unfiltered request per model per TTL window. That is a deliberate trade: one
unfiltered call is cheaper than failing a turn, and far better than stalling every turn to check.

## What it costs

A floor can raise your bill. Removing the `fp4` endpoint from DeepSeek V3.2 removes the cheapest
one; `full-width` removes almost everything on models that only publish `fp8`. The settings page and
the chip's option list both name the wire levels a floor admits, so the trade is legible before it
is chosen.

## What it is not

- **Not a budget.** It does not cap spend; `max_price` is not implemented here.
- **Not a quality guarantee.** Endpoint precision is what a provider declares, not a measurement of
  output quality. A well-executed `fp8` can beat a poorly served `fp16`.
- **Not meaningful for closed-weight models.** A proprietary model is served by one or two
  endpoints, usually both `unknown`; the floor will admit them or bypass, and either way it changes
  nothing about that model.
- **Not a replacement for Auto Exacto.** Exacto reorders by behaviour; the floor excludes by
  declared precision. They answer different questions, and the `tier` facet shows which presets
  turn Exacto off.

## API

```
GET  /__openrouter-plus/precision?session=<id>
     -> { precision: { floor, includeUnknown, allow }, inherited, source: 'session' | 'default' }

POST /__openrouter-plus/precision          { session, precision: { floor, includeUnknown } }
POST /__openrouter-plus/precision/default  { precision: { floor, includeUnknown } }
```

`allow` is the materialised wire list — `null` for `any`, which is what makes "sends nothing" a
value rather than an absence. `inherited` distinguishes a Session that chose this floor from one
that is simply reading the profile default; the chip renders the same badge either way.

[exacto]: https://openrouter.ai/docs/guides/routing/auto-exacto
