import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROVIDER_GROUPS,
  findProvider,
  groupProviders,
  parseProviders,
  pinnedFacets,
  readProviders,
  sortProviders,
} from '../lib/providers.js'

/**
 * A trimmed but structurally exact copy of a real
 * `GET /models/deepseek/deepseek-v4.1-flash-1017/endpoints` answer: token prices as
 * strings, `status` as a *number*, `service_tier` omitted on the standard pool, one
 * discounted endpoint, one provider appearing twice, and one region suffix.
 */
const LISTING = {
  data: {
    id: 'deepseek/deepseek-v4.1-flash-1017',
    endpoints: [
      {
        name: 'Relace | deepseek/deepseek-v4.1-flash-20261017',
        provider_name: 'Relace',
        tag: 'relace/fp4',
        quantization: 'fp4',
        service_tier: null,
        pricing: { prompt: '0.000000035', completion: '0.0000005', input_cache_read: '0.000000005', discount: 0 },
        context_length: 1048576,
        max_completion_tokens: 943718,
        uptime_last_1d: 100,
        uptime_last_30m: 100,
        uptime_last_5m: 100,
        status: 0,
        supported_parameters: ['tools', 'reasoning'],
      },
      {
        name: 'Wafer | deepseek/deepseek-v4.1-flash-20261017',
        provider_name: 'Wafer',
        tag: 'wafer/us',
        quantization: 'mxfp4',
        service_tier: null,
        pricing: { prompt: '0.000000038', completion: '0.0000005', input_cache_read: '0.000000005', discount: 0 },
        context_length: 1048576,
        uptime_last_1d: 100,
        status: 0,
      },
      {
        name: 'DeepInfra | …',
        provider_name: 'DeepInfra',
        tag: 'deepinfra/fp8/flex',
        quantization: 'fp8',
        service_tier: 'flex',
        pricing: { prompt: '0.0000000784', completion: '0.0000002352', input_cache_read: '0.0000000048', discount: 0.51 },
        context_length: 1048576,
        uptime_last_1d: 99.93,
        status: 0,
      },
      {
        name: 'DeepInfra | …',
        provider_name: 'DeepInfra',
        tag: 'deepinfra/fp8/priority',
        quantization: 'fp8',
        service_tier: 'priority',
        pricing: { prompt: '0.000000147', completion: '0.000000441', input_cache_read: '0.000000009', discount: 0.51 },
        context_length: 1048576,
        uptime_last_1d: 100,
        status: 0,
      },
      {
        name: 'Decart | …',
        provider_name: 'Decart',
        tag: 'decart',
        quantization: 'fp16',
        // A negative status. It is carried through and deliberately NOT read as availability:
        // on DeepSeek V4.1 Flash the endpoint serving a third of the traffic reports -5.
        status: -5,
        uptime_last_1d: 99.5,
        pricing: { prompt: '0.000000123', completion: '0.000000492' },
      },
      {
        name: 'Idle | …',
        provider_name: 'Idle',
        tag: 'idle/fp8',
        quantization: 'fp8',
        status: 0,
        // Provably dead: both uptime windows are zero.
        uptime_last_1d: 0,
        uptime_last_5m: 0,
        pricing: { prompt: '0.000000001', completion: '0.000000001' },
      },
    ],
  },
}

test('parseProviders() turns a real listing into rows a menu can render', () => {
  const providers = parseProviders(LISTING)
  assert.equal(providers.length, 6)

  const relace = providers[0]
  // Prices arrive per token as strings and leave as dollars per million, which is the
  // only unit a label can print. The rounding is what keeps `0.000000035` from rendering
  // as `0.034999999999999996`.
  assert.equal(relace.inputPrice, 0.035)
  assert.equal(relace.outputPrice, 0.5)
  assert.equal(relace.cacheReadPrice, 0.005)
  assert.equal(relace.discount, 0)
  assert.equal(relace.name, 'Relace', 'the company is the label, not "<company> | <model>"')
  assert.equal(relace.tier, 'standard', 'an absent service_tier means the standard pool')
  assert.equal(relace.precision, 'fp4')
  assert.equal(relace.available, true)
  assert.equal(relace.contextLength, 1048576)
  assert.equal(relace.maxCompletionTokens, 943718)
  assert.equal(relace.uptime1d, 100)
  assert.deepEqual(relace.supportedParameters, ['tools', 'reasoning'])
})

test('parseProviders() reads tiers, discounts, regions and availability', () => {
  const providers = parseProviders(LISTING)
  const byTag = new Map(providers.map((provider) => [provider.tag, provider]))

  assert.equal(byTag.get('deepinfra/fp8/flex').tier, 'flex')
  assert.equal(byTag.get('deepinfra/fp8/flex').discount, 0.51)
  assert.equal(byTag.get('deepinfra/fp8/priority').tier, 'priority')
  assert.equal(byTag.get('wafer/us').region, 'US', 'a trailing 2-3 letter segment is a region')
  assert.equal(byTag.get('relace/fp4').region, null, 'a quantization is not a region')
  assert.equal(byTag.get('deepinfra/fp8/priority').region, null, 'a tier is not a region')

  // `status` is carried raw and never interpreted: a negative code is a health signal, not
  // a routing verdict, and deepseek/deepseek-v4.1-flash-1017 proves it — the endpoint that
  // serves a third of that model's tokens reports -5 with 92% one-day uptime.
  const decart = byTag.get('decart')
  assert.equal(decart.status, -5, 'the raw code is kept for anyone who wants it')
  assert.equal(decart.available, true, 'a negative status is not a dead endpoint')
  assert.equal(decart.group, 'standard')

  // Uptime is what decides. Every reported window at zero is the only positive evidence of
  // an endpoint that is not answering, and it is the only thing that quiets a row.
  const idle = byTag.get('idle/fp8')
  assert.equal(idle.available, false)
  assert.equal(idle.group, 'unavailable')
  assert.equal(idle.inputPrice, 0.001, 'the cheapest row in the list is still the dead one')
})

test('parseProviders() survives rows it cannot use and a missing name', () => {
  const providers = parseProviders({
    data: {
      endpoints: [
        null,
        7,
        { provider_name: 'No Tag' },
        { tag: 'nameless/fp8', quantization: 'FP8' },
        { tag: 'odd/fp9', quantization: 'FP9', service_tier: 'turbo', pricing: { prompt: 'free' } },
      ],
    },
  })
  assert.deepEqual(providers.map((provider) => provider.tag), ['nameless/fp8', 'odd/fp9'])
  assert.equal(providers[0].name, 'nameless', 'a row with no company falls back to the slug')
  assert.equal(providers[1].precision, 'fp9', 'an unknown precision is kept as its own token')
  assert.equal(providers[1].tier, 'standard', 'an unknown tier is the standard pool')
  assert.equal(providers[1].inputPrice, null, 'an unparseable price is absent, never NaN')
  assert.equal(providers[1].available, true, 'a missing status is assumed routable')
})

test('parseProviders() rejects a body it cannot read, with the messages the relay reports', () => {
  assert.throws(() => parseProviders({}), /endpoint listing/)
  assert.throws(() => parseProviders({ data: { endpoints: 'no' } }), /endpoint listing/)
  assert.throws(() => parseProviders('<html>'), /did not answer with JSON/)
  assert.throws(() => parseProviders('{"error":"not found"}'), /endpoint listing/)
  // The cap is checked before parsing, like the admission reader's.
  assert.throws(() => parseProviders('{"data":{"endpoints":[]}}', 8), /larger than 8 bytes/)
  assert.equal(parseProviders(JSON.stringify(LISTING)).length, 6, 'a JSON string parses too')
})

test('sortProviders() puts the cheapest routable endpoint first and the dead ones last', () => {
  const ordered = sortProviders(parseProviders(LISTING)).map((provider) => provider.tag)
  assert.deepEqual(ordered, [
    'relace/fp4',
    'wafer/us',
    'deepinfra/fp8/flex',
    'decart',
    'deepinfra/fp8/priority',
    'idle/fp8',
  ])
  // Unavailable last regardless of price: a rate you cannot route to is not a cheaper rate.
  const cheap = parseProviders({
    data: {
      endpoints: [
        { tag: 'dead', uptime_last_1d: 0, uptime_last_5m: 0, pricing: { prompt: '0.0000001', completion: '0' } },
        { tag: 'alive', uptime_last_1d: 100, pricing: { prompt: '0.000001', completion: '0' } },
      ],
    },
  })
  assert.deepEqual(sortProviders(cheap).map((provider) => provider.tag), ['alive', 'dead'])
  // A status code never reorders anything: only a proven-dead endpoint is demoted.
  const statusOnly = parseProviders({
    data: {
      endpoints: [
        { tag: 'negative', status: -5, pricing: { prompt: '0.0000001', completion: '0' } },
        { tag: 'zero', status: 0, pricing: { prompt: '0.000001', completion: '0' } },
      ],
    },
  })
  assert.deepEqual(sortProviders(statusOnly).map((provider) => provider.tag), ['negative', 'zero'])
  assert.deepEqual(sortProviders([]), [])
  assert.deepEqual(sortProviders(null), [])
})

test('groupProviders() orders the groups the way the menu shows them and omits empty ones', () => {
  const groups = groupProviders(parseProviders(LISTING))
  assert.deepEqual(groups.map((group) => group.id), ['standard', 'flex', 'priority', 'unavailable'])
  assert.deepEqual(groups[0].providers.map((provider) => provider.tag), ['relace/fp4', 'wafer/us', 'decart'])
  assert.deepEqual(groups[1].providers.map((provider) => provider.tag), ['deepinfra/fp8/flex'])
  assert.deepEqual(groups[2].providers.map((provider) => provider.tag), ['deepinfra/fp8/priority'])
  assert.deepEqual(groups[3].providers.map((provider) => provider.tag), ['idle/fp8'])

  // A model served only by standard endpoints gets no Flex or Priority heading at all.
  const onlyStandard = groupProviders(parseProviders({
    data: { endpoints: [{ tag: 'x', status: 0 }] },
  }))
  assert.deepEqual(onlyStandard.map((group) => group.id), ['standard'])
  assert.deepEqual(PROVIDER_GROUPS, ['standard', 'flex', 'priority', 'unavailable'])
})

test('findProvider() and pinnedFacets() answer the two questions the chip asks', () => {
  const providers = parseProviders(LISTING)
  assert.equal(findProvider(providers, 'relace/fp4').tag, 'relace/fp4')
  assert.equal(findProvider(providers, 'nope/none'), null)
  assert.equal(findProvider(providers, null), null)
  assert.equal(findProvider(providers, '  '), null)
  assert.equal(findProvider(null, 'relace/fp4'), null)

  // These are the values the disabled Tier and Precision cells display: the pin already
  // decided both, so the cell states it rather than offering a lever that contradicts it.
  assert.deepEqual(pinnedFacets(findProvider(providers, 'deepinfra/fp8/priority')), {
    tier: 'priority',
    precision: 'fp8',
  })
  assert.deepEqual(pinnedFacets(findProvider(providers, 'relace/fp4')), {
    tier: 'standard',
    precision: 'fp4',
  })
  assert.equal(pinnedFacets(null), null)
  assert.equal(pinnedFacets({}), null)
})

test('readProviders() reads the right URL and never reaches the network in a test', async () => {
  /** @type {string[]} */
  const asked = []
  const listing = await readProviders('https://openrouter.ai/api/v1/', 'deepseek/deepseek-v3.2', {
    fetch: async (url) => {
      asked.push(url)
      return { ok: true, status: 200, text: async () => JSON.stringify(LISTING) }
    },
  })
  assert.deepEqual(asked, ['https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints'])
  assert.equal(listing.providers.length, 6)
  assert.equal(listing.url, asked[0])

  await assert.rejects(
    readProviders('https://example.test/v1', 'a/b', {
      fetch: async () => ({ ok: false, status: 502, text: async () => '' }),
    }),
    /answered 502/,
  )
})
