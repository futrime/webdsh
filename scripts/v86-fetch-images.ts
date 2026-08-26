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
import { zstdDecompressSync } from 'node:zlib'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
  /** The host it comes from, kept for an image that is fetched in pieces. */
  base: string
  bytes?: number
  /** The piece size, when the host serves this image only in pieces. */
  chunk?: number
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
 * How many pieces of a chunked image are in flight at once.
 *
 * Four, and the number is manners rather than tuning. The hosts that have these
 * images are somebody's own server — a machine read in a thousand pieces is a
 * thousand requests, and asking for them all at once is the difference between
 * a mirror and a hammer. Four keeps a link busy without ever looking like one.
 */
const PIECES_AT_ONCE = 4

/** The digest of a file already on disk, without holding it in memory. */
async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * Fetch one whole file, streamed to disk.
 *
 * Streamed rather than buffered: these run to two gigabytes, and
 * `await response.arrayBuffer()` on one of those is a heap the process does not
 * have.
 * @param url - where it comes from.
 * @param destination - where it goes.
 * @returns how many bytes were written.
 */
async function fetchWhole(url: string, destination: string): Promise<number> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  const body = response.body
  if (body === null) throw new Error(`${url} answered with no body`)
  const staging = `${destination}.part`
  const out = createWriteStream(staging)
  let written = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    written += chunk.length
    if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
  }
  await new Promise<void>((resolve, reject) => { out.end(() => { resolve() }); out.on('error', reject) })
  return written
}

/**
 * Fetch one image that its host only serves in pieces, and put it back together.
 *
 * This is the shape v86 reads a large disk in: a name like `haiku-v5/.img` is
 * not a file, it is a directory of `<offset>-<offset+chunk>.img` pieces, and
 * the emulator asks for the ones it needs as the guest touches them. A mirror
 * does not want that — a thousand small objects per machine is a slow upload
 * and a slower fetch — and it does not need it either, because a host that
 * answers range requests lets the emulator read a single file exactly the same
 * way. So the pieces are fetched once, here, and written end to end.
 *
 * Resumable, because these are large and somebody's connection will drop: a
 * `.part` file of a whole number of pieces is picked up where it stopped.
 * @param base - the host serving the pieces.
 * @param file - the catalog's name for the image, `<dir>/<ext>` style.
 * @param bytes - the size the catalog states, which is also how many pieces there are.
 * @param chunk - the piece size the catalog states.
 * @param destination - where the reassembled file goes.
 * @returns how many bytes were written.
 */
async function fetchPieces(
  base: string,
  file: string,
  bytes: number,
  chunk: number,
  destination: string,
): Promise<number> {
  const cut = file.lastIndexOf('/')
  const prefix = `${base}${file.slice(0, cut + 1)}`
  const extension = file.slice(cut + 1)
  const staging = `${destination}.part`

  let written = existsSync(staging) ? statSync(staging).size : 0
  // Only a whole number of pieces can be trusted: a partial one was interrupted
  // mid-write and re-fetching it is cheaper than proving it is intact.
  written -= written % chunk
  if (written > 0) {
    process.stdout.write(`  … ${file} resuming at ${size(written)}\n`)
    const rest = createReadStream(staging, { start: 0, end: written - 1 })
    const trimmed = createWriteStream(`${staging}.trim`)
    await new Promise<void>((resolve, reject) => {
      rest.pipe(trimmed).on('finish', () => { resolve() }).on('error', reject)
    })
    renameSync(`${staging}.trim`, staging)
  }

  const out = createWriteStream(staging, { flags: 'a' })
  let announced = written
  for (let offset = written; offset < bytes; offset += chunk * PIECES_AT_ONCE) {
    const batch: Promise<Uint8Array>[] = []
    for (let n = 0; n < PIECES_AT_ONCE; n++) {
      const at = offset + n * chunk
      if (at >= bytes) break
      const url = `${prefix}${String(at)}-${String(at + chunk)}${extension}`
      batch.push((async () => {
        const response = await fetch(url)
        // A piece that is not there is a piece that is all zeros. Large images
        // are published sparsely — measured on ChoKanji 4, where the piece at
        // 5 MB is absent while the one at 100 MB is present — and the emulator
        // reads a missing piece as a hole rather than as an error, so a mirror
        // that refused one would be refusing a disk that works.
        if (response.status === 404) return new Uint8Array(chunk)
        if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
        const piece = new Uint8Array(await response.arrayBuffer())
        // A `.zst` image is compressed one piece at a time — measured on
        // SerenityOS, whose first two megabyte-pieces arrive as 58,996 and
        // 7,127 bytes. The emulator decompresses each as it reads it, which
        // only works while the pieces are pieces; a mirror serving one file has
        // to hold the disk itself, so it is decompressed here.
        return extension.endsWith('.zst') ? new Uint8Array(zstdDecompressSync(piece)) : piece
      })())
    }
    for (const piece of await Promise.all(batch)) {
      // The last piece is padded to a whole chunk by the host — measured: Unix
      // V7 is 152,764,416 bytes and its final 256 KiB piece arrives full, 64 KiB
      // past the end of the disk. The image is what the catalog says it is, so
      // the tail is trimmed rather than trusted.
      const room = bytes - written
      const keep = piece.length <= room ? piece : piece.subarray(0, room)
      written += keep.length
      if (!out.write(keep)) await new Promise(resolve => out.once('drain', resolve))
      if (written >= bytes) break
    }
    if (written - announced >= 64 * 1024 * 1024) {
      announced = written
      process.stdout.write(`    ${file}: ${size(written)} of ${size(bytes)}\n`)
    }
  }
  await new Promise<void>((resolve, reject) => { out.end(() => { resolve() }); out.on('error', reject) })
  return written
}

/**
 * Fetch one file and record where it came from.
 * @param wanted - the file and its source.
 * @returns what was written, for the notice.
 */
async function fetchOne(wanted: Wanted): Promise<{ bytes: number, sha256: string }> {
  const destination = join(target, wanted.file)
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination)) {
    const held = statSync(destination).size
    process.stdout.write(`  = ${wanted.file} (${size(held)}, already here)\n`)
    return { bytes: held, sha256: await digestOf(destination) }
  }
  const written = wanted.chunk === undefined || wanted.bytes === undefined
    ? await fetchWhole(wanted.url, destination)
    : await fetchPieces(wanted.base, wanted.file, wanted.bytes, wanted.chunk, destination)
  if (wanted.bytes !== undefined && written !== wanted.bytes) {
    // A size the catalog states and the file does not match is the one error
    // that produces a machine which boots and then behaves strangely, so it is
    // a refusal rather than a warning.
    unlinkSync(`${destination}.part`)
    throw new Error(
      `${wanted.file}: the catalog says ${String(wanted.bytes)} bytes and this source served ${String(written)}`,
    )
  }
  renameSync(`${destination}.part`, destination)
  process.stdout.write(`  + ${wanted.file} (${size(written)})\n`)
  return { bytes: written, sha256: await digestOf(destination) }
}

/** Everything one machine needs that is not already sourced or present. */
function wantedFor(id: string, base: string): Wanted[] {
  const guest = GUESTS.find(entry => entry.id === id)
  if (guest === undefined) throw new Error(`no machine called ${id}`)
  return guest.images
    .filter(image => image.source === undefined)
    .map((image) => {
      const host = base.endsWith('/') ? base : `${base}/`
      return {
        guest: id,
        file: image.file,
        url: `${host}${image.file}`,
        base: host,
        ...(image.size === undefined ? {} : { bytes: image.size }),
        // A streamed image is one the host publishes only as pieces; it is
        // reassembled here so the mirror can serve it as one file.
        ...(image.streamed === true ? { chunk: image.chunkBytes ?? 256 * 1024 } : {}),
      }
    })
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
