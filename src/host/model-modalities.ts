/**
 * What a route the user configured will actually take: text, or text and a
 * picture.
 *
 * Settings → Models can add a model to any OpenAI-compatible route — type a
 * base URL, press *Fetch models*, tick the ones you want — and what it writes
 * for each one is an id, a name and two capacities. Nothing about modalities,
 * because the discovery seam it reads has no field for them: `readListing` in
 * `dsh-llm-pi-ai` keeps `id`, `name`, `context_window` and `max_output_tokens`
 * and drops the rest, and `LlmDiscoveredModel` has nowhere to put a modality
 * even if it kept it. A model entry that declares no `input` then resolves to
 * the route default, which is `[text]`.
 *
 * Text-only is not a preference here, it is a refusal. `llm-pi-ai` checks the
 * declared modalities *before* the request leaves the page and throws
 * `UNSUPPORTED_CONTENT` for an image on a model that does not name one; the
 * page's own tools ask the same question first and hand back a path instead of
 * a picture. So a vision model added this way arrives with its eyes shut, and
 * nothing in the surface explains why.
 *
 * That is how GLM-5.3-Flash got here. Measured against `api.kilo.ai`'s listing
 * on 2026-08-27, the row for `z-ai/glm-5.3-flash` says
 * `"input_modalities": ["text", "image", "video"]` — the fact was on the wire,
 * read by nobody, and every screenshot the model was shown came back as a file
 * path.
 *
 * So this row reads it. For every route the *user* configured that has an
 * entry stating no modalities, it asks that route's own `/models` once and
 * writes back what the endpoint says about those entries.
 *
 * What it will not do, in order of how much it matters:
 *
 * - **Guess.** A listing that describes no modalities leaves every entry
 *   exactly as it was. An id that looks like a vision model is not evidence;
 *   `-vl`, `5v` and `vision` in a name have all been wrong somewhere.
 * - **Overwrite.** An entry that already declares `input` — whether a person
 *   typed it or this row filled it in — is never touched. The endpoint is
 *   consulted about what nobody has answered, not about what someone has.
 * - **Ask twice.** One request per listing URL per page load, and none at all
 *   for a route whose entries all declare something. A route whose models are
 *   all text-only is asked once per load and written to never, which is the
 *   deliberate half of that: recording `[text]` would say nothing the default
 *   does not already say, and would go stale the day the provider ships vision
 *   on that model.
 * - **Reach past the user's own routes.** The routes this build registers
 *   itself are described in `scripts/free-routes.json`, from what each
 *   service's catalog states and — where a service states nothing — from
 *   asking the model directly. They are answered where they are declared, and
 *   a page that has configured nothing makes no request because of this row.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Services this row waits for. */
export const inject = ['llm', 'settings']

/** The row's id in the composition. */
export const name = 'web-model-modalities'

/** The section `llm-pi-ai` owns, and the one this row edits. */
const NS = settingsNamespace('llm-pi-ai')

/** How long an endpoint has to answer before its models keep the default. */
const LISTING_TIMEOUT_MS = 15_000

/** The most a listing may weigh, which is the bound pi-ai's own reader holds. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/** One model entry as the Models page writes it, plus whatever else is there. */
interface ModelEntry {
  id?: unknown
  input?: unknown
  [field: string]: unknown
}

/** One configured route, as much of it as this row reads. */
interface Profile {
  baseURL?: unknown
  apiKeyEnv?: unknown
  models?: unknown
  [field: string]: unknown
}

/** The credential store, when one is mounted. */
interface Credentials {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

/** A settings descriptor, narrowed to the fields this row uses. */
interface Descriptor {
  ns: string
  revision: number
  user?: unknown
}

/** A plain object, or nothing — every reader below starts here. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-empty string, or nothing. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Whether an entry states what it accepts.
 *
 * Empty and absent mean the same thing, which is the reading pi-ai's own
 * resolver takes: `[]` would describe a model that accepts nothing and could
 * serve no request, so it is treated as no answer rather than as a strange one.
 * @param entry - one model entry from the user's section.
 * @returns whether the entry declares at least one modality.
 */
function declares(entry: ModelEntry): boolean {
  return Array.isArray(entry.input) && entry.input.length > 0
}

/**
 * The modalities one listing row states, in the spellings services use.
 *
 * Four shapes, all of them measured from this page rather than assumed:
 * `architecture.input_modalities` is what Kilo and every OpenRouter-shaped
 * gateway sends, `modalities.input` is LLM7's, `input` is pi-ai's own, and
 * BlockRun states no modality list at all but tags a model `vision` in its
 * `categories`. Anything else is treated as a listing that did not answer.
 *
 * Only `text` and `image` survive: they are the two modalities a profile may
 * declare, and a row naming `video` or `audio` is telling us about a capability
 * this seam has no way to carry.
 * @param row - one entry of the endpoint's model listing.
 * @returns the modalities to declare, or nothing when the row states none.
 */
function modalitiesOf(row: unknown): string[] | undefined {
  const entry = record(row)
  if (entry === undefined) return undefined
  const declared = [
    record(entry.architecture)?.input_modalities,
    entry.input_modalities,
    record(entry.modalities)?.input,
    entry.input,
  ].find(Array.isArray)
  if (Array.isArray(declared)) {
    const kept = (['text', 'image'] as const).filter(modality => declared.includes(modality))
    // A list that names neither is about something this seam cannot express —
    // an embedding model's `input: ["text"]` reads the same as a chat model's,
    // but a list of `["audio"]` alone says nothing about either modality here.
    return kept.length > 0 ? kept : undefined
  }
  // The flag forms. Both are positive-only: a service that tags its vision
  // models says so on those rows and stays silent on the others, which is not
  // the same as saying the others are blind.
  const categories = entry.categories
  const vision = (Array.isArray(categories) && categories.includes('vision'))
    || record(entry.capabilities)?.vision === true
  return vision ? ['text', 'image'] : undefined
}

/**
 * Read one route's model listing.
 *
 * The same URL pi-ai's own interrogation builds — the base is a prefix rather
 * than something to resolve against, so a gateway deployed under a path keeps
 * its segments — and the same posture: the route's credential when it names
 * one, nothing when it does not, because that is what a request to it would
 * carry.
 * @param profile - the configured route, for the protocol its endpoint speaks.
 * @param url - the listing URL, already built from the route's base.
 * @param apiKey - the credential the route resolves, when it has one.
 * @returns the listing's rows, or nothing when it could not be read.
 */
async function listing(profile: Profile, url: string, apiKey: string | undefined): Promise<unknown[] | undefined> {
  // Only the protocols whose listing is the shape this reader knows, which is
  // the same bound pi-ai's own interrogation holds: an Anthropic or a Bedrock
  // route answers something else entirely, and guessing at it would report a
  // parse failure as a model that accepts nothing.
  const api = text(profile.api) ?? 'openai-completions'
  if (api !== 'openai-completions' && api !== 'openai-responses') return undefined
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` } },
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await response.body?.cancel()
    throw new Error(`${url} answered with more than ${String(MAX_LISTING_BYTES)} bytes`)
  }
  const body = await response.text()
  if (body.length > MAX_LISTING_BYTES) throw new Error(`${url} answered with more than ${String(MAX_LISTING_BYTES)} bytes`)
  const parsed: unknown = JSON.parse(body)
  const data = record(parsed)?.data
  if (Array.isArray(data)) return data
  return Array.isArray(parsed) ? parsed : undefined
}

/** The key a route resolves, when it names one and the store has it. */
async function credential(ctx: Context, profile: Profile): Promise<string | undefined> {
  const ref = text(profile.apiKeyEnv)
  if (ref === undefined) return undefined
  try {
    const store = ctx.get('credentials') as Credentials | undefined
    const hit = await store?.resolve(ref)
    return text(hit?.value)
  } catch {
    // A route whose key cannot be read is asked unauthenticated, which is what
    // a listing endpoint that needs one will refuse in a moment anyway.
    return undefined
  }
}

/**
 * What one endpoint said its models accept, by model id — asked once.
 *
 * The answer is kept rather than the fact of having asked, because a pass can
 * end without writing: a write that races the Models page is refused on its
 * revision, and the re-run that the page's own save triggers has to be able to
 * finish the job without interrogating the user's gateway a second time.
 * @param ctx - the row's context, for the credential and the log.
 * @param profile - the configured route.
 * @param url - the listing URL, which is also the cache key.
 * @param cache - this page load's answers.
 * @returns the models the endpoint describes as taking an image, or nothing
 *   when it could not be read or described none.
 */
async function stated(
  ctx: Context,
  profile: Profile,
  url: string,
  cache: Map<string, Promise<Map<string, string[]> | undefined>>,
): Promise<Map<string, string[]> | undefined> {
  const held = cache.get(url)
  if (held !== undefined) return held
  const asked = (async () => {
    let rows: unknown[] | undefined
    try {
      rows = await listing(profile, url, await credential(ctx, profile))
    } catch (error) {
      ctx.logger.debug(`web-model-modalities: ${url} did not say what its models accept (${String(error)})`)
      return undefined
    }
    if (rows === undefined) return undefined
    // Only the rows that say a model takes a picture. A row stating `[text]`
    // is describing exactly what the entry already resolves to, so writing it
    // down would change nothing today and would be wrong the day the provider
    // ships vision on that model — this row would see a declared entry and
    // never ask again. What is recorded is what would otherwise be a mistake.
    const answers = new Map<string, string[]>()
    for (const row of rows) {
      const id = text(record(row)?.id)
      const modalities = modalitiesOf(row)
      if (id !== undefined && modalities?.includes('image') === true) answers.set(id, modalities)
    }
    return answers
  })()
  cache.set(url, asked)
  return asked
}

/**
 * Fill in what the endpoints state, for every route that left it unstated.
 * @param ctx - the row's context.
 * @param cache - this page load's listing answers, keyed by listing URL.
 */
async function reconcile(ctx: Context, cache: Map<string, Promise<Map<string, string[]> | undefined>>): Promise<void> {
  const descriptor = (ctx.settings.describe() as Descriptor[]).find(entry => entry.ns === NS)
  const providers = record(record(descriptor?.user)?.providers)
  if (descriptor === undefined || providers === undefined) return

  const operations: { op: 'set', path: readonly string[], value: unknown }[] = []
  for (const [route, raw] of Object.entries(providers)) {
    const profile = record(raw) as Profile | undefined
    const models = profile?.models
    if (profile === undefined || !Array.isArray(models)) continue
    const entries = models.map(entry => record(entry) as ModelEntry | undefined)
    // A `models` array holding something that is not a model entry is a section
    // this row does not understand well enough to rewrite. Left alone: the
    // schema will have its own opinion about it, and that is the right place.
    if (entries.some(entry => entry === undefined)) continue
    if (!entries.some(entry => entry !== undefined && !declares(entry))) continue
    const baseURL = text(profile.baseURL)
    // A route that names no endpoint is one pi-ai's own catalog describes, and
    // its models are described there. There is nothing here to ask.
    if (baseURL === undefined) continue
    const answers = await stated(ctx, profile, `${baseURL.replace(/\/+$/, '')}/models`, cache)
    if (answers === undefined) continue

    const next = entries.map((entry) => {
      const id = text(entry?.id)
      const modalities = id === undefined || entry === undefined || declares(entry) ? undefined : answers.get(id)
      return modalities === undefined ? entry : { ...entry, input: modalities }
    })
    const filled = next.filter((entry, index) => entry !== entries[index])
    if (filled.length === 0) continue
    operations.push({ op: 'set', path: ['providers', route, 'models'], value: next })
    ctx.logger.info(`web-model-modalities: ${route} — ${filled
      .map(entry => `${String(text(entry?.id) ?? '?')} accepts ${(entry?.input as string[]).join(', ')}`)
      .join('; ')}, as its own model listing states`)
  }

  if (operations.length === 0) return
  // The revision the descriptor was read at, so a write racing the Models page
  // is refused rather than applied over it. The refusal is not an error worth
  // reporting: the page's own write re-enters this row, and the second pass
  // sees whatever the user just saved.
  await ctx.settings.mutate(NS, operations, descriptor.revision)
}

/**
 * Mount the row.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const answers = new Map<string, Promise<Map<string, string[]> | undefined>>()
  let running: Promise<void> | undefined

  /** One pass at a time, and never one that can reject into a listener. */
  const settle = (): void => {
    running = (running ?? Promise.resolve()).then(async () => {
      try {
        await reconcile(ctx, answers)
      } catch (error) {
        ctx.logger.warn('web-model-modalities: could not record what the configured routes accept')
        ctx.logger.warn(error)
      }
    })
  }

  // Once for what is already configured — a model added before this row
  // existed is exactly the case the report came from — and again whenever the
  // section changes, which is what the Models page does when it saves.
  settle()
  ctx.on('settings/updated', (ns) => { if (ns === NS) settle() })
}

export default { apply, inject, name }
