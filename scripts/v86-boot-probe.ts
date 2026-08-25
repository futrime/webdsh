/**
 * Boot machines carried in from v86's catalog, and say what happened.
 *
 * `src/runtime/v86-catalog.json` brings in a hundred-odd machines this build
 * has never started. Each entry is upstream's own configuration — slots, sizes,
 * piece sizes, constructor options — but "copied correctly" and "boots" are
 * different claims, and only one of them can be checked by reading.
 *
 * So this boots them. It stands up a caching mirror in Node (where a plain
 * download is a plain download), points the page at it, loads one machine per
 * run, and reports whether it reached a settled screen and what was on it. What
 * it is checking is this build's catalog entry — a wrong piece size asks for
 * files that do not exist, a wrong slot boots nothing, a missing option hangs —
 * not whether the operating system works, which is upstream's business.
 *
 * The mirror is a fixture, not a route this deployment offers: it fetches from
 * Node without a browser's Referer, caches what it fetched under the temporary
 * directory, and serves it with the headers a disk image needs. A deployment
 * that wants these machines points the setting at a mirror of its own.
 *
 * There is a second thing worth checking and it is not the same thing: whether
 * a machine boots *as this build ships it* — off whatever the runtime resolves
 * on its own, which for most of them is this project's mirror. That is the
 * claim the machine list makes to a visitor who changes no settings, so
 * `--as-shipped` sets no image host at all and `--bundled` runs it over every
 * machine that claims to need no setup.
 *
 * Usage:
 *   npx tsx scripts/v86-boot-probe.ts <guest-id> [<guest-id>...] [--url <url>] [--headed]
 *   npx tsx scripts/v86-boot-probe.ts --sample 8              # a spread across media
 *   npx tsx scripts/v86-boot-probe.ts --bundled --as-shipped  # the zero-setup claim
 *   npx tsx scripts/v86-boot-probe.ts --bundled --as-shipped --jobs 6
 */

import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Page } from 'playwright'
import { GUESTS } from '../src/runtime/guests.ts'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')
/** Boot off whatever the build resolves, rather than off the fixture mirror. */
const asShipped = args.includes('--as-shipped')
/** How many machines to boot at once. Each one is a browser context and a VM. */
const jobs = Math.max(1, Number(valueOf('--jobs') ?? '4'))
const cache = join(tmpdir(), 'dshw-v86-images')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Where the fixture fetches from when it has not cached a file yet. */
const UPSTREAM = process.env.V86_IMAGE_HOST ?? 'https://i.copy.sh/'

/**
 * A caching mirror, for the length of one run.
 *
 * Range requests are served off the cached file rather than forwarded, because
 * a streamed disk asks for a few hundred pieces and forwarding each one would
 * make this a load test of somebody else's CDN.
 * @returns the origin to point the page at, and a way to stop it.
 */
async function startMirror(): Promise<{ origin: string, close(): Promise<void>, served: () => number }> {
  mkdirSync(cache, { recursive: true })
  let served = 0
  const server: Server = createServer((request, response) => {
    void (async () => {
      const asked = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)
      const safe = asked.split('/').filter(part => part !== '' && part !== '.' && part !== '..').join('/')
      const path = join(cache, safe.replace(/[^\w./-]/g, '_'))
      const headers: Record<string, string> = {
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      }
      if (!existsSync(path)) {
        const answer = await fetch(`${UPSTREAM}${safe}`, { referrer: '' }).catch(() => undefined)
        if (answer === undefined || !answer.ok) {
          response.writeHead(404, headers)
          response.end()
          return
        }
        mkdirSync(dirname(path), { recursive: true })
        const staging = `${path}.part`
        writeFileSync(staging, new Uint8Array(await answer.arrayBuffer()))
        renameSync(staging, path)
      }
      served += 1
      const total = statSync(path).size
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
      if (range === null) {
        response.writeHead(200, { ...headers, 'content-length': String(total) })
        createReadStream(path).pipe(response)
        return
      }
      const start = Number(range[1])
      const end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1)
      response.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(start)}-${String(end)}/${String(total)}`,
        'content-length': String(end - start + 1),
      })
      createReadStream(path, { start, end }).pipe(response)
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${String(port)}/`,
    served: () => served,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/** What one machine did. */
interface Outcome {
  id: string
  ok: boolean
  seconds: number
  detail: string
}

/** Boot one machine and look at it. */
async function boot(page: Page, id: string, origin: string | undefined, budgetMs: number): Promise<Outcome> {
  const started = Date.now()
  const seconds = (): number => Math.round((Date.now() - started) / 1000)
  // No host set means the runtime picks: a file this deployment serves, then
  // the mirror, then the default host. That is the path a visitor is on.
  if (origin !== undefined) {
    await page.addInitScript((host: string) => {
      localStorage.setItem('dsh-web:v86-image-host', host)
    }, origin)
  }
  await page.goto(`${url}?runtime=v86:${id}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })

  const result = await page.evaluate(async (budget: number) => {
    const machine = (globalThis as unknown as {
      __DSH_WEB_MACHINE__: {
        boot(): Promise<void>
        ready(timeoutMs?: number): Promise<boolean>
        screen: { shot(): Promise<{ width: number, height: number, bytes: number, graphical: boolean }> }
        status(): { failure?: string }
      }
    }).__DSH_WEB_MACHINE__
    try {
      await machine.boot()
    } catch (error) {
      return { started: false, why: error instanceof Error ? error.message : String(error) }
    }
    const up = await machine.ready(budget)
    const shot = await machine.screen.shot().catch(() => undefined)
    return { started: true, up, shot, failure: machine.status().failure }
  }, budgetMs)

  if (result.started !== true) return { id, ok: false, seconds: seconds(), detail: `did not start: ${String(result.why)}` }
  const shot = result.shot
  if (shot === undefined) return { id, ok: false, seconds: seconds(), detail: 'started, but has no screen' }
  // A screen that compresses to almost nothing is a blank screen, whatever the
  // readiness marker said.
  const blank = shot.bytes < 2000
  const ok = result.up === true && !blank
  return {
    id,
    ok,
    seconds: seconds(),
    detail: `${String(shot.width)}x${String(shot.height)} ${shot.graphical ? 'graphical' : 'text'}, `
      + `${String(shot.bytes)} bytes${result.up === true ? '' : ', never reached its readiness marker'}`
      + `${blank ? ', and the screen is blank' : ''}`,
  }
}

/** A spread across media, when no ids are named. */
function sample(count: number): string[] {
  const wanted = ['Bootsector', 'Floppy', 'CD', 'HD', 'bzImage', 'Multiboot']
  const picked: string[] = []
  for (const medium of wanted) {
    const candidates = GUESTS.filter(guest => !guest.bundled && guest.images.length === 1)
    for (const guest of candidates) {
      if (picked.length >= count) break
      if (picked.includes(guest.id)) continue
      // The catalog does not carry the medium, so infer it from the slot.
      const slot = guest.images[0].slot
      const kind = slot === 'cdrom' ? 'CD' : slot === 'fda' ? 'Floppy' : slot === 'hda' ? 'HD' : slot
      if (kind === medium) {
        picked.push(guest.id)
        break
      }
    }
  }
  return picked
}

const flags = ['--url', '--sample', '--jobs']
const explicit = args.filter((argument, index) => !argument.startsWith('--') && !flags.includes(args[index - 1] ?? ''))
const requested = explicit.length > 0
  ? explicit
  : args.includes('--bundled')
    ? GUESTS.filter(guest => guest.bundled).map(guest => guest.id)
    : sample(Number(valueOf('--sample') ?? '6'))

// The fixture mirror is only stood up when something is going to use it: it
// fetches from `i.copy.sh`, and a run that boots off this build's own sources
// has no business touching that host at all.
const mirror = asShipped ? undefined : await startMirror()
const browser = await chromium.launch({ headless: !headed })
const outcomes: Outcome[] = []

/** Boot one machine in a context of its own, and never throw. */
async function probe(id: string): Promise<Outcome> {
  const spec = GUESTS.find(guest => guest.id === id)
  if (spec === undefined) return { id, ok: false, seconds: 0, detail: 'no such machine in this build' }
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    return await boot(page, id, mirror?.origin, spec.timeoutMs)
  } catch (error) {
    return { id, ok: false, seconds: 0, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    await context.close()
  }
}

try {
  // A pool rather than a loop: each machine is an independent browser context
  // and most of the wall-clock is a guest booting, so seventy of them one after
  // another is an hour of watching one CPU wait.
  const queue = [...requested]
  let done = 0
  const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const outcome = await probe(id)
      outcomes.push(outcome)
      done += 1
      process.stdout.write(
        `  ${outcome.ok ? '✔' : '✘'} [${String(done)}/${String(requested.length)}] `
        + `${outcome.id} (${String(outcome.seconds)}s) — ${outcome.detail}\n`,
      )
    }
  })
  await Promise.all(workers)
} finally {
  await browser.close()
  if (mirror !== undefined) {
    process.stdout.write(`\nthe mirror served ${String(mirror.served())} files\n`)
    await mirror.close()
  }
}

const good = outcomes.filter(outcome => outcome.ok)
process.stdout.write(`\n${String(good.length)} of ${String(outcomes.length)} booted\n`)
for (const outcome of outcomes.filter(one => !one.ok)) {
  process.stdout.write(`  ✘ ${outcome.id}: ${outcome.detail}\n`)
}
if (good.length !== outcomes.length) process.exit(1)
