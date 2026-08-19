/**
 * Re-pull and re-probe the keyless model roster.
 *
 * `scripts/free-routes.ts` says where the free routes are and how each service
 * marks its own free tier; this asks the services. For every route it reads the
 * published catalog, applies that route's `select`, subtracts the documented
 * `excluded` ids, and then — the part that makes the snapshot worth trusting —
 * sends each surviving model a real completion with no credential and keeps
 * only what answers.
 *
 * It is a maintenance command, not a build step. `npm run build` reads the
 * committed `free-routes.json`, because a deploy that five third parties can
 * break is not a deploy. Run this when a roster looks stale, read the diff, and
 * commit it:
 *
 *     npm run refresh:models
 *     git diff scripts/free-routes.json
 *
 * The verdicts are the same ones the routes are documented against:
 *
 * - `200` with a reply — free, and kept.
 * - `429`/`503` whose body names a rate limit or a busy pool — free and spent,
 *   which is a free tier working as designed. Kept, and reported so the count
 *   is honest about what was actually exercised.
 * - `401`/`403` demanding a key, `402` about a balance, or a rejection of the
 *   model id — dropped, with the response quoted.
 *
 * Name one or more route ids to refresh only those and leave the rest of the
 * snapshot alone; pass `--dry-run` to print the result without writing.
 *
 *     npm run refresh:models -- ovh-free --dry-run
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FREE_ROUTES, loadRoster, type FreeModel, type FreeRoute } from './free-routes.ts'

const here = dirname(fileURLToPath(import.meta.url))
const snapshot = join(here, 'free-routes.json')
const dryRun = process.argv.includes('--dry-run')

/** How many models of one route are probed at a time. */
const CONCURRENCY = 4

/** How long a spent anonymous pool is given to refill before the second try. */
const RETRY_DELAY_MS = 40_000

/** How many times a rate-limited model is retried before it is taken at its word. */
const RETRIES = 2

/** What one probe concluded. */
type Verdict = 'free' | 'free-throttled' | 'refused'

/** A probe's outcome, with the evidence for it. */
interface Probe {
  verdict: Verdict
  status: number
  detail: string
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Whether a body is a spent free tier rather than a demand for money.
 *
 * The distinction is the whole point of the exercise, so it is drawn on the
 * service's own words: a pool that refills says rate limit, busy, or retry,
 * while a paywall says balance, credit, or sign in. Anything that mentions
 * paying is refused no matter what status carries it.
 * @param body - the response text.
 * @returns whether this reads as an exhausted free tier.
 */
function throttled(body: string): boolean {
  const text = body.toLowerCase()
  if (/payment|balance|credit|budget|subscription|billing|sign in|top up/.test(text)) return false
  return /rate.?limit|too many requests|quota|busy|temporarily unavailable|retry/.test(text)
}

/**
 * Ask one model to complete something, with no credential.
 *
 * The request is deliberately the one the app makes: an empty `Bearer`, which
 * is what the profile's `authorization` header puts on the wire and what gets
 * pi-ai to dispatch at all. Probing without it would measure a request this
 * build never sends.
 * @param route - the route the model belongs to.
 * @param id - the model id.
 * @returns the verdict and the evidence for it.
 */
async function probe(route: FreeRoute, id: string): Promise<Probe> {
  let last: Probe = { verdict: 'refused', status: 0, detail: 'no response' }
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) await wait(RETRY_DELAY_MS)
    let response: Response
    try {
      response = await fetch(`${route.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer' },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'Reply with one short sentence.' }],
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (error) {
      last = { verdict: 'refused', status: 0, detail: `request failed: ${String(error)}` }
      continue
    }
    const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 200)
    if (response.ok) return { verdict: 'free', status: response.status, detail: body }
    last = {
      verdict: throttled(body) ? 'free-throttled' : 'refused',
      status: response.status,
      detail: body,
    }
    if (last.verdict !== 'free-throttled') return last
  }
  return last
}

/** Run `task` over `items`, at most {@link CONCURRENCY} at a time. */
async function pooled<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (let index = next; index < items.length; index = next) {
      next = index + 1
      results[index] = await task(items[index])
    }
  }))
  return results
}

/** Read one route's catalog, or the models a route with no catalog declares. */
async function catalogOf(route: FreeRoute): Promise<FreeModel[]> {
  if (route.listing === undefined) return [...route.declared ?? []]
  const response = await fetch(route.listing, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${route.listing} answered ${String(response.status)}`)
  return route.select(await response.json())
}

const roster = loadRoster()
const routes: Record<string, FreeModel[]> = { ...roster.routes }

// Naming routes refreshes only those, and leaves every other route's models at
// what the snapshot already measured. Re-probing all of them to correct one is
// how a service's anonymous quota gets spent on a question nobody asked.
const only = new Set(process.argv.slice(2).filter(argument => !argument.startsWith('--')))
const selected = only.size === 0 ? FREE_ROUTES : FREE_ROUTES.filter(route => only.has(route.id))
for (const id of only) {
  if (!FREE_ROUTES.some(route => route.id === id)) throw new Error(`refresh: no route named ${id}`)
}

let served = 0
let throttledCount = 0

for (const route of selected) {
  const listed = await catalogOf(route)
  const candidates = listed.filter(entry => !(entry.id in route.excluded))
  const skipped = listed.length - candidates.length
  process.stdout.write(`\n${route.id}: ${String(listed.length)} listed`
    + `${skipped > 0 ? `, ${String(skipped)} excluded by name` : ''}, probing ${String(candidates.length)}\n`)

  const probes = await pooled(candidates, async entry => ({ entry, result: await probe(route, entry.id) }))
  const kept: FreeModel[] = []
  for (const { entry, result } of probes) {
    const mark = result.verdict === 'free' ? '  ok  ' : result.verdict === 'free-throttled' ? ' 429  ' : ' drop '
    process.stdout.write(`  ${mark} ${entry.id}`)
    if (result.verdict === 'free') {
      served += 1
      kept.push(entry)
      process.stdout.write('\n')
      continue
    }
    process.stdout.write(`  ${String(result.status)} ${result.detail}\n`)
    if (result.verdict !== 'free-throttled') continue
    throttledCount += 1
    kept.push(entry)
  }
  routes[route.id] = kept
}

const total = Object.values(routes).reduce((sum, models) => sum + models.length, 0)
process.stdout.write(`\n${String(selected.length)} of ${String(FREE_ROUTES.length)} routes probed;`
  + ` ${String(total)} models in the roster`
  + ` (${String(served)} answered, ${String(throttledCount)} rate-limited but free)\n`)

if (total === 0) throw new Error('refresh: no route served anything; refusing to write an empty roster')

const next: string = `${JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), routes }, null, 2)}\n`
if (dryRun) {
  process.stdout.write('\n--dry-run: not written\n')
} else {
  writeFileSync(snapshot, next)
  process.stdout.write(`\nwrote ${snapshot}\n`)
}
