/**
 * Put disk images where this deployment can serve them itself.
 *
 * The catalog offers a hundred and twenty-eight machines and the default image
 * host has five files, so most of them are correctly configured and one disk
 * away. This closes that gap the way v86 closes it locally: files under
 * `public/v86/images/` are served from the app's own origin, and
 * `src/runtime/guests.ts` prefers them over any remote host — no third party,
 * no CORS question, and the machine still boots with the network off.
 *
 * What it will not do is decide for you where the bytes come from. A source is
 * named on the command line or read from a manifest, and the two facts that
 * decide whether a source is *yours to use* — its licence, and whether its
 * owner is willing to serve it — are not facts this script can check. In
 * particular it will not point at `i.copy.sh` by default: that host refuses
 * browser requests deliberately, and taking its bandwidth in bulk instead is
 * not a way around the refusal.
 *
 * Every file lands with a recorded origin and digest in `NOTICE.json` beside
 * it, because redistributing somebody else's operating system is a thing you
 * have to be able to account for.
 *
 * Usage:
 *   npx tsx scripts/v86-fetch-images.ts --from <base-url> <guest-id>...
 *   npx tsx scripts/v86-fetch-images.ts --manifest <file.json>
 *   npx tsx scripts/v86-fetch-images.ts --list            # what each machine needs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUESTS } from '../src/runtime/guests.ts'

const args = process.argv.slice(2)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
/**
 * Where the files land.
 *
 * `public/v86/images/` by default, which is what this deployment serves itself.
 * `--into` points it somewhere else — at a checkout of a mirror repository, for
 * instance, which is the same job done once for everybody instead of once per
 * deployment.
 */
const target = valueOf('--into') ?? join(root, 'public', 'v86', 'images')

/** One file to fetch, and where from. */
interface Wanted {
  guest: string
  file: string
  url: string
  bytes?: number
}

/** Bytes as a size a person reads. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024).toString()} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/** What each machine needs, so a maintainer can go and find it. */
function list(): void {
  for (const guest of GUESTS) {
    // A file the mirror already holds is not a file anyone has to go and find.
    if (guest.images.every(image => image.source !== undefined || image.mirror !== undefined)) continue
    const files = guest.images
      .filter(image => image.source === undefined && image.mirror === undefined)
      .map(image => `${image.file}${image.size === undefined ? '' : ` (${size(image.size)})`}${image.streamed ? ' [read in pieces]' : ''}`)
    if (files.length === 0) continue
    process.stdout.write(`${guest.id.padEnd(20)} ${guest.name}\n    ${files.join('\n    ')}\n`)
  }
}

/**
 * Fetch one file, whole, and record where it came from.
 *
 * Whole rather than in pieces: a streamed image is only read in pieces by the
 * *emulator*, from a host that supports ranges — and this deployment's own
 * static files support ranges, so what has to be here is the image itself.
 * @param wanted - the file and its source.
 * @returns what was written, for the notice.
 */
async function fetchOne(wanted: Wanted): Promise<{ bytes: number, sha256: string }> {
  const destination = join(target, wanted.file)
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination)) {
    const held = readFileSync(destination)
    process.stdout.write(`  = ${wanted.file} (${size(held.length)}, already here)\n`)
    return { bytes: held.length, sha256: createHash('sha256').update(held).digest('hex') }
  }
  const response = await fetch(wanted.url)
  if (!response.ok) throw new Error(`${wanted.url} answered ${String(response.status)}`)
  const body = new Uint8Array(await response.arrayBuffer())
  if (wanted.bytes !== undefined && body.length !== wanted.bytes) {
    // A size the catalog states and the file does not match is the one error
    // that produces a machine which boots and then behaves strangely, so it is
    // a refusal rather than a warning.
    throw new Error(
      `${wanted.file}: the catalog says ${String(wanted.bytes)} bytes and this source served ${String(body.length)}`,
    )
  }
  const staging = `${destination}.part`
  writeFileSync(staging, body)
  renameSync(staging, destination)
  process.stdout.write(`  + ${wanted.file} (${size(body.length)})\n`)
  return { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }
}

/** Everything one machine needs that is not already sourced or present. */
function wantedFor(id: string, base: string): Wanted[] {
  const guest = GUESTS.find(entry => entry.id === id)
  if (guest === undefined) throw new Error(`no machine called ${id}`)
  return guest.images
    .filter(image => image.source === undefined)
    .map(image => ({
      guest: id,
      file: image.file,
      url: `${base.endsWith('/') ? base : `${base}/`}${image.file}`,
      ...(image.size === undefined ? {} : { bytes: image.size }),
    }))
}

if (args.includes('--list') || args.length === 0) {
  list()
  process.exit(0)
}

const manifestPath = valueOf('--manifest')
const from = valueOf('--from')
const ids = args.filter((argument, index) =>
  !argument.startsWith('--') && !['--from', '--manifest', '--into'].includes(args[index - 1] ?? ''))

const wanted: Wanted[] = manifestPath !== undefined
  ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Wanted[]
  : from === undefined
    ? []
    : ids.flatMap(id => wantedFor(id, from))

if (wanted.length === 0) {
  process.stderr.write('nothing to fetch: name machines with --from <base-url>, or pass --manifest <file>\n')
  process.exit(2)
}

mkdirSync(target, { recursive: true })
const noticePath = join(target, 'NOTICE.json')
const notice = existsSync(noticePath)
  ? JSON.parse(readFileSync(noticePath, 'utf8')) as Record<string, unknown>
  : {}

let failed = 0
for (const one of wanted) {
  process.stdout.write(`▶ ${one.guest}\n`)
  try {
    const written = await fetchOne(one)
    notice[one.file] = { guest: one.guest, source: one.url, ...written, fetched: new Date().toISOString() }
  } catch (error) {
    failed += 1
    process.stdout.write(`  ✗ ${one.file}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
writeFileSync(noticePath, `${JSON.stringify(notice, null, 1)}\n`)

const held = Object.keys(notice).length
const bytes = Object.values(notice).reduce<number>((total, row) => total + ((row as { bytes?: number }).bytes ?? 0), 0)
process.stdout.write(
  `\n${String(held)} file(s) under ${target}, ${size(bytes)} in all`
  + `${failed === 0 ? '' : `; ${String(failed)} failed`}\n`,
)
process.stdout.write(`origins and digests recorded in ${noticePath.replace(root, '.')}\n`)
if (failed > 0) process.exit(1)
