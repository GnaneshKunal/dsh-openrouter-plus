/**
 * Live model discovery for a provider route that points at OpenRouter.
 *
 * Why this exists. `@deepseek-ai/dsh-llm-pi-ai` answers *Fetch available models*
 * from the catalog baked into `@earendil-works/pi-ai`. For a route whose key is a
 * catalog provider (`openrouter`) it returns that catalog **before** it ever reads
 * the route's `baseURL`, so even a row pointed at this relay reports the bundled
 * snapshot. The snapshot is regenerated only when pi-ai is published, so every
 * model OpenRouter has added since then is invisible — and a row pointed at the
 * relay cannot tell the difference.
 *
 * A plugin cannot change that function (the discovery registry is keyed by the
 * `llm-pi-ai` settings namespace and refuses duplicates). It does not have to: a
 * route that declares `models` serves exactly that list, the configured list wins
 * over the installed catalog, and `ctx.configEditor` can write it. So this module
 * reads OpenRouter's live listing and reconciles it against the list the route
 * already carries.
 *
 * Pure by construction: no I/O, no config, no Host handles. The caller performs
 * the request and the write, which is what keeps every rule here testable.
 */

/**
 * Largest `/models` reply this plugin will read. OpenRouter's full listing is
 * roughly 780 KB today; the cap exists so a hostile or broken upstream cannot make
 * the Host buffer without bound.
 */
export const MODEL_LISTING_MAX_BYTES = 8 * 1024 * 1024

/**
 * Variant suffix this module drops by default.
 *
 * `:batch` is OpenRouter's asynchronous batch API, not a chat endpoint: a request to
 * one does not stream a completion the way a Session expects. It is 71 of the 463
 * live ids, so keeping it would also bury the models an operator actually wants.
 * Every other variant (`:free`, `:nitro`, `:floor`) is a normal chat endpoint and is
 * kept.
 */
const UNLISTABLE_VARIANT = ':batch'

/** Input modalities DSH models can declare. `video` has no DSH equivalent and is dropped. */
const MODALITY_MAP = new Map([
  ['image', 'image'],
  ['audio', 'audio'],
])

/**
 * Whether a parsed body is an OpenAI-compatible model listing.
 *
 * Accepts both shapes the ecosystem uses — `{ data: [...] }` (OpenAI, OpenRouter)
 * and `{ models: [...] }` — and rejects anything else so a proxy error page is
 * never mistaken for an empty catalog.
 *
 * @param {any} payload
 * @returns {boolean}
 */
export function isModelListing(payload) {
  if (typeof payload !== 'object' || payload === null) return false
  return Array.isArray(payload.data) || Array.isArray(payload.models)
}

/**
 * Positive integer or `undefined`.
 *
 * Config fields are validated by `llm-pi-ai` (a non-integer `contextWindow` fails
 * the whole write), so a missing or nonsensical upstream value must be omitted
 * rather than passed through.
 *
 * @param {any} value
 * @returns {number | undefined}
 */
function positiveInt(value) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Model ids an operator can actually pick, from one `/models` entry.
 *
 * @param {any} entry
 * @param {{ includeBatch?: boolean }} options
 * @returns {string} the trimmed id, or an empty string when the entry is unusable
 */
function usableId(entry, options) {
  if (typeof entry !== 'object' || entry === null) return ''
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '' || !id.includes('/')) return ''
  if (options.includeBatch !== true && id.includes(UNLISTABLE_VARIANT)) return ''
  return id
}

/**
 * Declared input modalities for one model, or `undefined` when it is text-only.
 *
 * `undefined` is the right answer for text-only models: the route leaves the field
 * off, which is how every hand-written entry in this profile is spelled.
 *
 * @param {any} entry
 * @returns {string[] | undefined}
 */
function inputModalities(entry) {
  const declared = entry?.architecture?.input_modalities
  if (!Array.isArray(declared)) return undefined
  const found = []
  for (const raw of declared) {
    const mapped = MODALITY_MAP.get(typeof raw === 'string' ? raw.trim().toLowerCase() : '')
    if (mapped !== undefined && !found.includes(mapped)) found.push(mapped)
  }
  return found.length === 0 ? undefined : found
}

/**
 * Build the route entry for a model the route does not already declare.
 *
 * Only fields the upstream actually reports are emitted, so nothing is invented: a
 * model whose listing omits its context window simply carries none, and the route
 * falls back to `llm-pi-ai`'s own default exactly as a hand-written entry without
 * the field would. `reasoningEfforts` is deliberately absent — `fillReasoning`
 * owns that decision, and it has better evidence than a `supported_parameters`
 * guess.
 *
 * @param {string} id
 * @param {Record<string, any>} source - the raw listing entry.
 * @returns {Record<string, any>}
 */
export function synthesizeModel(id, source) {
  const model = { id }
  const name = typeof source?.name === 'string' ? source.name.trim() : ''
  if (name !== '') model.name = name
  const contextWindow = positiveInt(source?.top_provider?.context_length) ?? positiveInt(source?.context_length)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = positiveInt(source?.top_provider?.max_completion_tokens)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const input = inputModalities(source)
  if (input !== undefined) model.input = input
  return model
}

/**
 * Read the live listing into route entries, in upstream order.
 *
 * @param {any} payload - the parsed `/models` body.
 * @param {{ includeBatch?: boolean }} [options]
 * @returns {{ models: Array<Record<string, any>>, skipped: number, duplicates: number }}
 * @throws {TypeError} when the body is not a model listing at all.
 */
export function readLiveModels(payload, options = {}) {
  if (!isModelListing(payload)) {
    throw new TypeError('this endpoint did not answer with a model listing (no "data" or "models" array)')
  }
  const entries = Array.isArray(payload.data) ? payload.data : payload.models
  const seen = new Set()
  const models = []
  let skipped = 0
  let duplicates = 0
  for (const entry of entries) {
    const id = usableId(entry, options)
    if (id === '') {
      if (typeof entry?.id === 'string' && entry.id.includes(UNLISTABLE_VARIANT)) skipped += 1
      continue
    }
    if (seen.has(id)) {
      duplicates += 1
      continue
    }
    seen.add(id)
    models.push(synthesizeModel(id, entry))
  }
  return { models, skipped, duplicates }
}

/**
 * Mark each live model with whether the route already carries it.
 *
 * This is what the picker renders: the full live catalogue, with the ids the route
 * already declares marked so the user sees them as already there rather than as
 * things to add again.
 *
 * @param {{ live?: any[], existing?: any[] }} options
 * @returns {Array<Record<string, any> & { inRoute: boolean }>}
 */
export function annotateLive(models, existing) {
  const declared = new Set()
  for (const entry of Array.isArray(existing) ? existing : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (id !== '') declared.add(id)
  }
  return (Array.isArray(models) ? models : []).map((model) => ({
    ...model,
    inRoute: declared.has(model.id),
  }))
}

/**
 * Build the new `models` list from an explicit selection and removal.
 *
 * The user edits the list; this never decides on their behalf:
 *
 *   - `selected` ids are added, in the order the endpoint lists them;
 *   - `remove` ids are dropped from the route — this is the untick, so it is the
 *     only thing in this module that can take a model away;
 *   - an id already declared is reported as `already` and never duplicated;
 *   - an id the endpoint does not list is `unknown` and is not invented;
 *   - everything else keeps its current position and its bytes, so a curated list
 *     is not reshuffled by an edit.
 *
 * @param {{ live?: any[], existing?: any[], selected?: string[], remove?: string[] }} options
 * @returns {{
 *   models: Array<Record<string, any>>,
 *   diff: { added: string[], removed: string[], already: string[], unknown: string[], total: number },
 *   changed: boolean,
 * }}
 */
export function selectModels(options) {
  const live = Array.isArray(options?.live) ? options.live : []
  const existing = Array.isArray(options?.existing) ? options.existing : []
  const wanted = new Set(
    (Array.isArray(options?.selected) ? options.selected : [])
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter((id) => id !== ''),
  )
  const doomed = new Set(
    (Array.isArray(options?.remove) ? options.remove : [])
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter((id) => id !== ''),
  )

  const declared = new Set()
  const models = []
  const removed = []
  for (const entry of existing) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || declared.has(id)) continue
    declared.add(id)
    if (doomed.has(id)) {
      removed.push(id)
      continue
    }
    models.push(entry)
  }

  const available = new Map()
  for (const model of live) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    if (id !== '' && !available.has(id)) available.set(id, model)
  }

  const added = []
  const already = []
  const unknown = []
  for (const id of wanted) {
    if (declared.has(id)) {
      // Already there: unticked-and-reticked cancels out rather than duplicating.
      if (!removed.includes(id)) already.push(id)
      continue
    }
    const model = available.get(id)
    if (model === undefined) {
      unknown.push(id)
      continue
    }
    declared.add(id)
    models.push(model)
    added.push(id)
  }

  return {
    models,
    diff: { added, removed, already, unknown, total: models.length },
    changed: added.length > 0 || removed.length > 0,
  }
}
