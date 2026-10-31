/**
 * The precision vocabulary, the endpoint listing and the admission rule.
 *
 * Everything asserted here is the pure half of the feature: `lib/quantization.js` owns
 * which wire levels a floor admits, `lib/endpoints.js` owns reading what a model's
 * endpoints report and deciding whether anything survives. Both run without a network —
 * the one fetch is exercised through an injected `fetch`, which is also the only way a
 * test could prove the byte cap and the model-id guard without depending on the state
 * of a public API.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  FLOORS,
  PRECISION_IDS,
  QUANTIZATION_LEVELS,
  normalizePrecision,
  precisionLabel,
} from '../lib/quantization.js'
import {
  ENDPOINTS_MAX_BYTES,
  fetchEndpoints,
  levelsFrom,
  parseEndpoints,
  survives,
} from '../lib/endpoints.js'

/* The real shape of the models this plugin routes for. `deepseek/deepseek-v3.2` has nine
   endpoints: four fp8, one fp4 and four whose precision nobody declared — and ZERO fp16
   or bf16. That last fact is why `full-width` cannot be sent blind. */
const DEEPSEEK_V32 = {
  data: {
    endpoints: [
      { provider_name: 'DeepInfra', tag: 'deepinfra/fp4', quantization: 'fp4', status: 'active' },
      { provider_name: 'DeepSeek', tag: 'deepseek/fp8', quantization: 'fp8', status: 'active' },
      { provider_name: 'Novita', tag: 'novita/fp8', quantization: 'fp8', status: 'active' },
      { provider_name: 'Together', tag: 'together/fp8', quantization: 'fp8', status: 'active' },
      { provider_name: 'Fireworks', tag: 'fireworks/fp8', quantization: 'fp8', status: 'active' },
      { provider_name: 'AtlasCloud', tag: 'atlas/unknown', quantization: 'unknown', status: 'active' },
      { provider_name: 'Parasail', tag: 'parasail/unknown', quantization: 'unknown', status: 'active' },
      { provider_name: 'Cloudflare', tag: 'cloudflare/unknown', quantization: 'unknown', status: 'active' },
      { provider_name: 'DeepInfra', tag: 'deepinfra/unknown', quantization: 'unknown', status: 'active' },
    ],
  },
}

/** A closed-weight model: one provider, no declared precision. */
const GPT_4O = {
  data: { endpoints: [{ provider_name: 'OpenAI', tag: 'openai/gpt-4o', quantization: 'unknown' }] },
}

test('the vocabulary and the floors are the documented wire contract', () => {
  assert.deepEqual([...QUANTIZATION_LEVELS], [
    'int4',
    'int8',
    'fp4',
    'mxfp4',
    'nvfp4',
    'fp6',
    'fp8',
    'mxfp8',
    'fp16',
    'bf16',
    'fp32',
    'unknown',
  ])
  // Least to most restrictive: the order a picker offers them in.
  assert.deepEqual([...PRECISION_IDS], ['any', 'no-four-bit', 'eight-bit-up', 'full-width'])
  assert.equal(FLOORS.any, null, '`any` names no list at all')
  assert.deepEqual([...FLOORS['no-four-bit']], ['int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'])
  assert.deepEqual([...FLOORS['eight-bit-up']], ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'])
  assert.deepEqual([...FLOORS['full-width']], ['fp16', 'bf16', 'fp32'])
})

test('normalizePrecision() materialises the include list and the unknown default', () => {
  // `any` is the untouched profile: no list, and it must stay null rather than [].
  assert.deepEqual(normalizePrecision(undefined), { floor: 'any', includeUnknown: false, allow: null })
  assert.deepEqual(normalizePrecision('any'), { floor: 'any', includeUnknown: false, allow: null })
  assert.deepEqual(normalizePrecision({}), { floor: 'any', includeUnknown: false, allow: null })

  // A bare string is the whole floor, and the two middle floors admit `unknown` by
  // default because it is roughly 40% of the real pool.
  assert.deepEqual(normalizePrecision('no-four-bit'), {
    floor: 'no-four-bit',
    includeUnknown: true,
    allow: ['int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  })
  assert.deepEqual(normalizePrecision('eight-bit-up'), {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  })
  // `full-width` refuses `unknown` by default: a floor that says "full precision" and
  // admits undeclared endpoints is not a floor.
  assert.deepEqual(normalizePrecision('full-width'), {
    floor: 'full-width',
    includeUnknown: false,
    allow: ['fp16', 'bf16', 'fp32'],
  })

  // The flag is an explicit override in both directions, and a case-insensitive id.
  assert.deepEqual(normalizePrecision({ floor: 'Eight-Bit-Up', includeUnknown: false }), {
    floor: 'eight-bit-up',
    includeUnknown: false,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'],
  })
  assert.deepEqual(normalizePrecision({ floor: 'full-width', includeUnknown: true }).allow, [
    'fp16',
    'bf16',
    'fp32',
    'unknown',
  ])

  // Config is read at boot, so a misspelled floor degrades instead of throwing; a
  // non-boolean flag is ignored rather than half-applied.
  assert.equal(normalizePrecision('turbo').floor, 'any')
  assert.equal(normalizePrecision(null).floor, 'any')
  assert.equal(normalizePrecision(['fp8']).floor, 'any')
  assert.deepEqual(normalizePrecision({ floor: 'eight-bit-up', includeUnknown: 'yes' }), {
    floor: 'eight-bit-up',
    includeUnknown: true,
    allow: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
  })

  // The returned list is a copy: a caller mutating it must not corrupt the table the
  // next request reads.
  const precision = normalizePrecision({ floor: 'full-width', includeUnknown: true })
  precision.allow.push('int4')
  assert.deepEqual([...FLOORS['full-width']], ['fp16', 'bf16', 'fp32'])
  assert.equal(normalizePrecision('full-width').allow.includes('int4'), false)
})

test('precisionLabel() names a floor from any spelling of it', () => {
  assert.equal(precisionLabel('any'), 'Any')
  assert.equal(precisionLabel('no-four-bit'), 'No four-bit')
  assert.equal(precisionLabel('eight-bit-up'), 'Eight-bit up')
  assert.equal(precisionLabel('full-width'), 'Full width')
  assert.equal(precisionLabel({ floor: 'full-width' }), 'Full width', 'a normalised precision works too')
  assert.equal(precisionLabel('turbo'), 'Any', 'an unknown id reads as the floor it falls back to')
})

test('parseEndpoints() reads the listing into normalised records', () => {
  const endpoints = parseEndpoints(DEEPSEEK_V32)
  assert.equal(endpoints.length, 9)
  assert.deepEqual(endpoints[0], {
    provider_name: 'DeepInfra',
    tag: 'deepinfra/fp4',
    quantization: 'fp4',
    status: 'active',
  })

  // The same body as raw text is accepted: the fetch below has bytes, not an object.
  assert.deepEqual(parseEndpoints(JSON.stringify(GPT_4O)), [
    { provider_name: 'OpenAI', tag: 'openai/gpt-4o', quantization: 'unknown', status: null },
  ])

  // A precision this build does not know is recorded as `unknown` instead of dropping
  // the endpoint: dropping it would under-count the pool and quietly disable the floor.
  const exotic = parseEndpoints({
    data: { endpoints: [{ provider_name: 'X', quantization: 'FP2', tag: 'x/fp2' }] },
  })
  assert.equal(exotic[0].quantization, 'unknown')

  // Rows that are not objects are skipped; a missing precision is `unknown`.
  assert.deepEqual(
    parseEndpoints({ data: { endpoints: [null, 7, { provider_name: 'Y' }] } }).map((row) => row.quantization),
    ['unknown'],
  )

  // Anything that is not an endpoint listing is a hard error, so a proxy error page is
  // never mistaken for "this model has no endpoints".
  assert.throws(() => parseEndpoints({ data: { endpoints: 'no' } }), /endpoint listing/)
  assert.throws(() => parseEndpoints({}), /endpoint listing/)
  assert.throws(() => parseEndpoints('{"error":"not found"}'), /endpoint listing/)
  assert.throws(() => parseEndpoints('<html>'), /did not answer with JSON/)
})

test('parseEndpoints() enforces the byte cap before it parses', () => {
  const oversized = JSON.stringify(DEEPSEEK_V32)
  assert.throws(() => parseEndpoints(oversized, 64), /larger than 64 bytes/)
  assert.ok(ENDPOINTS_MAX_BYTES > Buffer.byteLength(oversized), 'the real listing is far under the cap')
  // A parsed object has already been buffered, so there is nothing left for the cap to
  // protect and the call is unaffected.
  assert.equal(parseEndpoints(DEEPSEEK_V32, 1).length, 9)
})

test('levelsFrom() dedupes a model`s endpoints into the levels they report', () => {
  assert.deepEqual([...levelsFrom(parseEndpoints(DEEPSEEK_V32))].sort(), ['fp4', 'fp8', 'unknown'])
  assert.deepEqual([...levelsFrom(parseEndpoints(GPT_4O))], ['unknown'])
  assert.equal(levelsFrom([]).size, 0)
  assert.equal(levelsFrom(undefined).size, 0, 'nothing is an empty level set, never an error')
  // Raw (unparsed) rows are coerced too, so a fixture need not go through the parser.
  assert.deepEqual([...levelsFrom([{ quantization: 'FP16' }, { quantization: 'nope' }, {}])].sort(), ['fp16', 'unknown'])
})

test('survives() is the admission rule, and `any` admits everything', () => {
  const deepseek = levelsFrom(parseEndpoints(DEEPSEEK_V32))
  const gpt = levelsFrom(parseEndpoints(GPT_4O))

  // `any` names no filter, so it is an admission, not an absence.
  assert.equal(survives(null, deepseek), true)
  assert.equal(survives(null, new Set()), true)
  assert.equal(survives(undefined, deepseek), true)

  // The real distribution, as the floor table predicts it.
  assert.equal(survives(normalizePrecision('no-four-bit').allow, deepseek), true, 'fp8 survives')
  assert.equal(survives(normalizePrecision('eight-bit-up').allow, deepseek), true)
  assert.equal(
    survives(normalizePrecision('full-width').allow, deepseek),
    false,
    'every V3.2 endpoint is fp8 or below, so a full-width filter would exclude them all',
  )
  // ...which is exactly why an unadmitted floor is never sent: that request would 404.
  assert.equal(survives(normalizePrecision('no-four-bit').allow, gpt), true, 'unknown is admitted by default')
  assert.equal(survives(normalizePrecision('full-width').allow, gpt), false)

  // Including `unknown` explicitly is enough to admit an undeclared endpoint.
  assert.equal(
    survives(normalizePrecision({ floor: 'full-width', includeUnknown: true }).allow, gpt),
    true,
  )
  // A floor can never be satisfied by an empty listing, and one match is enough.
  assert.equal(survives(['fp8'], new Set()), false)
  assert.equal(survives(['fp8', 'fp16'], new Set(['fp16'])), true)
  // A plain array of levels is accepted, which keeps callers from boxing one.
  assert.equal(survives(['fp8'], ['fp4', 'fp8']), true)
})

/** A `fetch` stand-in that records its call and answers with one canned body. */
function stubFetch(body, options = {}) {
  const calls = []
  const respond = async (url, request) => {
    calls.push({ url, request })
    if (options.throw) throw new Error(options.throw)
    return {
      ok: options.status === undefined || options.status === 200,
      status: options.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }
  return { calls, fetch: respond }
}

test('fetchEndpoints() reads exactly one model`s listing, bounded and injectable', async () => {
  const stub = stubFetch(DEEPSEEK_V32)
  const listing = await fetchEndpoints('https://openrouter.ai/api/v1/', 'deepseek/deepseek-v3.2', {
    fetch: stub.fetch,
  })

  assert.equal(listing.url, 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints')
  assert.equal(listing.endpoints.length, 9)
  assert.deepEqual([...listing.levels].sort(), ['fp4', 'fp8', 'unknown'])
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].request.method, 'GET')
  assert.equal(stub.calls[0].request.headers.accept, 'application/json')
  assert.ok(stub.calls[0].request.signal, 'the read is bounded by a timeout signal')

  // A variant suffix is a legal path character, so a `:free` id is read as-is.
  const variant = stubFetch(GPT_4O)
  await fetchEndpoints('https://openrouter.ai/api/v1', 'openai/gpt-4o:free', { fetch: variant.fetch })
  assert.equal(variant.calls[0].url, 'https://openrouter.ai/api/v1/models/openai/gpt-4o:free/endpoints')
})

test('fetchEndpoints() rejects everything it cannot read, without inventing levels', async () => {
  const upstream = 'https://openrouter.ai/api/v1'
  const bad = (options) => fetchEndpoints(upstream, 'deepseek/deepseek-v3.2', { fetch: stubFetch({}, options).fetch })

  await assert.rejects(bad({ status: 404 }), /answered 404/)
  await assert.rejects(bad({ throw: 'getaddrinfo ENOTFOUND' }), /could not reach .*ENOTFOUND/)
  await assert.rejects(bad({}), /endpoint listing/, 'a body with no listing is a failure, not an empty pool')

  // A model id that cannot be one is refused *before* a request is made, so a caller
  // that is not an OpenRouter namespace cannot turn into arbitrary URL paths.
  for (const model of ['', 'acme-large', '../etc/passwd', 'author/', '/slug', 'author/slug?x=1', 'author/sl ug']) {
    const stub = stubFetch(DEEPSEEK_V32)
    await assert.rejects(
      fetchEndpoints(upstream, model, { fetch: stub.fetch }),
      /not a routable model id/,
      `${JSON.stringify(model)} must not become a URL`,
    )
    assert.equal(stub.calls.length, 0, 'nothing was fetched')
  }

  // An upstream that is not http(s) is a programming error, not a network failure.
  await assert.rejects(
    fetchEndpoints('file:///etc', 'a/b', { fetch: stubFetch(DEEPSEEK_V32).fetch }),
    /not an absolute http\(s\) URL/,
  )

  // The body cap is applied to the response text as well, not only in the parser.
  await assert.rejects(
    fetchEndpoints(upstream, 'deepseek/deepseek-v3.2', {
      fetch: stubFetch(DEEPSEEK_V32).fetch,
      maxBytes: 32,
    }),
    /more than 32 bytes/,
  )
})
