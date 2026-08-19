/**
 * The provider routes a visitor can call without an account.
 *
 * A page is opened, not installed. Whoever lands on it has no key, no billing
 * relationship with anyone, and no reason to acquire either before finding out
 * whether the thing works — so the models this build registers by default are
 * the ones that answer an unauthenticated request. OpenCode Zen was the first;
 * this module is the rest of them, and the rule for being in it is the same:
 * the endpoint served a real completion to a request carrying no credential.
 *
 * Two things are worth separating, because the table this was built from
 * conflates them and the difference decides what ships:
 *
 * - **Priced at zero** is a catalog claim. OpenCode Zen's roster comes from
 *   pi-ai's published pricing, and `scripts/assemble.ts` already subtracts the
 *   entries that answer `not supported` — a price is not a promise.
 * - **Served without a key** is a measurement. Every route here was reached
 *   with curl from a machine holding no account with any of them, and every
 *   model was asked to complete something. What could not be made to answer is
 *   named in `excluded`, with the reason, rather than quietly dropped.
 *
 * A `429` is not a disqualification. Three of these gateways meter anonymous
 * callers — OVHcloud allows roughly two requests per minute per model, and
 * says so in `x-ratelimit-limit-minute` — and a spent pool that refills is a
 * free tier working as designed, not a paid tier in disguise. What does
 * disqualify a route is a demand: `401` wanting a key, or a `402` about a
 * balance. Pollinations' legacy endpoint fails exactly that way and is the one
 * service from the source table this build does not register; see
 * {@link REJECTED}.
 *
 * Nothing here is fetched at build time. `npm run build` runs in CI and must
 * not depend on five third parties being up, so the model lists live in
 * `free-routes.json` as a snapshot, and `scripts/refresh-free-routes.ts`
 * re-pulls and re-probes them on demand. The `select` functions below are what
 * that script applies: each is the service's own free-tier flag, read from its
 * own catalog, so refreshing is a mechanical operation rather than a judgement
 * call.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A model as a `llm-pi-ai` route declares it. */
export interface FreeModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** Request modalities, when the service's catalog states them. */
  input?: readonly ('text' | 'image')[]
}

/** One keyless route: where it is, what it serves, and how to re-derive that. */
export interface FreeRoute {
  /** Route key under `llm-pi-ai`'s `providers` map. */
  id: string
  /** What Settings → Models calls it. */
  displayName: string
  /** OpenAI-compatible base; pi-ai appends `/chat/completions`. */
  baseURL: string
  /**
   * The service's model catalog, or nothing when it publishes none. A route
   * with no listing states its models in {@link declared} and the refresh
   * script only probes those.
   */
  listing?: string
  /** The models of a route that publishes no catalog to read them from. */
  declared?: readonly FreeModel[]
  /** Why this service is reachable without a key, in one sentence. */
  note: string
  /** Whether the browser can call it directly, or the CORS proxy has to. */
  cors: 'direct' | 'proxied'
  /** The service's own free-tier flag, applied to its catalog rows. */
  select: (catalog: unknown) => FreeModel[]
  /** Models the flag admits that this build takes back out, and why. */
  excluded: Readonly<Record<string, string>>
}

/** Read a value from an unknown catalog row without trusting its shape. */
function field(row: unknown, ...path: string[]): unknown {
  let value: unknown = row
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** A positive integer, or nothing — the schema rejects zero and null alike. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** A non-empty string, or nothing. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The `data` array of an OpenAI-shaped listing, or the listing itself. */
function rows(catalog: unknown): unknown[] {
  const data = field(catalog, 'data')
  if (Array.isArray(data)) return data
  return Array.isArray(catalog) ? catalog : []
}

/** Keep only the modalities the profile schema accepts, in a stable order. */
function modalities(declared: unknown): readonly ('text' | 'image')[] | undefined {
  if (!Array.isArray(declared)) return undefined
  const kept = (['text', 'image'] as const).filter(name => declared.includes(name))
  return kept.length > 0 ? kept : undefined
}

/** Drop the undefined fields, so the emitted YAML states only what is known. */
function model(id: string, parts: Omit<FreeModel, 'id'>): FreeModel {
  return {
    id,
    ...parts.name === undefined ? {} : { name: parts.name },
    ...parts.contextWindow === undefined ? {} : { contextWindow: parts.contextWindow },
    ...parts.maxTokens === undefined ? {} : { maxTokens: parts.maxTokens },
    ...parts.input === undefined ? {} : { input: parts.input },
  }
}

export const FREE_ROUTES: readonly FreeRoute[] = [
  {
    id: 'ovh-free',
    displayName: 'OVHcloud AI Endpoints (free)',
    baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    listing: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
    // The one route here that refuses a placeholder: a non-empty bearer is a
    // credential OVHcloud then fails to verify, and it answers 403 rather than
    // falling back to the anonymous tier. The empty `Bearer` the profile sends
    // is what keeps the request unauthenticated.
    note: 'answers unauthenticated callers at about two requests per minute per model; a non-empty bearer is rejected with 403',
    cors: 'direct',
    // The listing mixes chat with speech, transcription, embeddings and image
    // generation, and marks the difference in its own numbers: everything that
    // is not a chat model reports `max_completion_tokens: 0`. That is the
    // filter — a protocol fact from the service, not a hand-kept list of ids.
    select: catalog => rows(catalog).flatMap((row) => {
      const id = text(field(row, 'id'))
      const maxTokens = positive(field(row, 'max_completion_tokens'))
      const contextWindow = positive(field(row, 'context_length'))
      if (id === undefined || maxTokens === undefined || contextWindow === undefined) return []
      return [model(id, { contextWindow, maxTokens })]
    }),
    excluded: {
      'Qwen3Guard-Gen-0.6B': 'a safety classifier, not an assistant: asked for a haiku it answers "Safety: Safe\\nCategories: None"',
      'Qwen3Guard-Gen-8B': 'a safety classifier, not an assistant: asked for a haiku it answers "Safety: Safe\\nCategories: None"',
    },
  },
  {
    id: 'kilo-free',
    displayName: 'Kilo Gateway (free)',
    baseURL: 'https://api.kilo.ai/api/gateway/v1',
    listing: 'https://api.kilo.ai/api/gateway/v1/models',
    note: 'serves its free tier anonymously and answers 401 PAID_MODEL_AUTH_REQUIRED for the rest',
    cors: 'proxied',
    select: catalog => rows(catalog).flatMap((row) => {
      if (field(row, 'isFree') !== true) return []
      const id = text(field(row, 'id'))
      if (id === undefined) return []
      return [model(id, {
        name: text(field(row, 'name')),
        contextWindow: positive(field(row, 'context_length')),
        maxTokens: positive(field(row, 'top_provider', 'max_completion_tokens')),
        input: modalities(field(row, 'architecture', 'input_modalities')),
      })]
    }),
    excluded: {
      'nvidia/nemotron-3.5-content-safety:free': 'a content-safety classifier, not an assistant: it answers a writing request with null content',
    },
  },
  {
    id: 'blockrun-free',
    displayName: 'BlockRun (free)',
    baseURL: 'https://blockrun.ai/api/v1',
    listing: 'https://blockrun.ai/api/v1/models',
    note: 'marks its free models in the catalog and answers 402 x402 payment required for the priced ones',
    cors: 'proxied',
    select: catalog => rows(catalog).flatMap((row) => {
      if (field(row, 'billing_mode') !== 'free') return []
      const id = text(field(row, 'id'))
      if (id === undefined) return []
      const categories = field(row, 'categories')
      const vision = Array.isArray(categories) && categories.includes('vision')
      return [model(id, {
        name: text(field(row, 'name')),
        contextWindow: positive(field(row, 'context_window')),
        maxTokens: positive(field(row, 'max_output')),
        input: vision ? ['text', 'image'] : undefined,
      })]
    }),
    excluded: {},
  },
  {
    id: 'llm7-free',
    displayName: 'LLM7.io (free)',
    baseURL: 'https://api.llm7.io/v1',
    listing: 'https://api.llm7.io/v1/models',
    // `usage_based_only` is the flag that matters, not `tier`: `gemma4:31b` is
    // listed at the same `turbo` tier as the models that answer and still
    // replies `401 Missing API key`, because it bills per use.
    note: 'serves every model it does not mark usage_based_only to anonymous callers, under a short rate limit',
    cors: 'direct',
    select: catalog => rows(catalog).flatMap((row) => {
      if (field(row, 'model_type') !== 'chat') return []
      if (field(row, 'usage_based_only') !== false) return []
      const id = text(field(row, 'id'))
      if (id === undefined) return []
      return [model(id, {
        contextWindow: positive(field(row, 'context_window', 'tokens')),
        input: modalities(field(row, 'modalities', 'input')),
      })]
    }),
    excluded: {},
  },
  {
    id: 'ch-at',
    displayName: 'ch.at',
    baseURL: 'https://ch.at/v1',
    // The only service here with no catalog to read: it publishes no `/models`
    // and ignores the `model` field outright, answering from whatever it is
    // pointed at. So the route declares the single entry the endpoint behaves
    // as, and `id` is a label rather than a selector.
    declared: [{ id: 'default', name: 'ch.at', contextWindow: 32768, maxTokens: 4096 }],
    // Worth knowing before picking it: it accepts a `tools` array and then
    // ignores it, answering in prose even with `tool_choice: "required"`. It
    // is a chat endpoint, not an agent one, and it is listed because it is
    // genuinely free rather than because it can drive a tool loop.
    note: 'answers any unauthenticated request, ignores the model field, and silently ignores tool definitions',
    cors: 'direct',
    select: () => [],
    excluded: {},
  },
]

/**
 * Services from the same source table that this build does not register, and
 * what was measured instead of what was claimed.
 *
 * Kept as data rather than deleted, because "we looked and it does not work"
 * is the finding — without it the next person re-runs the same experiment.
 */
export const REJECTED: Readonly<Record<string, string>> = {
  'text.pollinations.ai/openai': 'no longer free anonymously. A cache hit returns 200 with a stale `created`;'
    + ' any prompt it has not seen answers `402 {"code":"PAYMENT_REQUIRED","message":"API key budget too low.'
    + ' This request costs ~0.0004 pollen, but this key has 0.0000."}`. Its own GET form fails the same way.',
  'gen.pollinations.ai/v1': 'requires a real bearer key by the service\'s own account; never anonymous.',
}

const here = dirname(fileURLToPath(import.meta.url))

/** The measured model lists, keyed by route id. */
export interface FreeRoster {
  /** When `scripts/refresh-free-routes.ts` last re-pulled and re-probed. */
  measuredAt: string
  /** Route id → the models that answered. */
  routes: Record<string, FreeModel[]>
}

/** Read the snapshot beside this file. */
export function loadRoster(): FreeRoster {
  return JSON.parse(readFileSync(join(here, 'free-routes.json'), 'utf8')) as FreeRoster
}
