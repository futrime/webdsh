/**
 * What v86 offers, what this build offers, and the difference.
 *
 * copy.sh/v86 lists a hundred-odd machines and this build lists sixteen, and
 * for a long time the only way to know why was to read two tables by hand. The
 * answer turns out not to be emulation at all — every one of those machines is
 * the same emulator with a different disk, and the difference is that copy.sh
 * hosts the disks. But "the answer is hosting" is a claim, and a claim about a
 * moving upstream needs something that re-checks it.
 *
 * So this reads v86's own catalog — the profile table in its `src/browser/main.js`
 * and the metadata table in its demo page — and prints the difference against
 * `src/runtime/guests.ts`: which machines exist upstream and not here, which
 * files each of them needs, and which of them are open-source and therefore
 * something a mirror may legally serve.
 *
 * The profile table is JavaScript, not data: it is object literals built from a
 * `host` variable. It is therefore evaluated rather than parsed — in a
 * `node:vm` sandbox with nothing in it but the two names those literals read,
 * so the only thing the fetched code can do is construct the array it exists to
 * construct.
 *
 * Usage:
 *   npx tsx scripts/v86-catalog.ts            # the difference, as a report
 *   npx tsx scripts/v86-catalog.ts --json     # the upstream catalog, machine-readable
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where v86 keeps the two halves of its catalog. */
const PROFILE_SOURCE = 'https://raw.githubusercontent.com/copy/v86/master/src/browser/main.js'
const METADATA_SOURCE = 'https://copy.sh/v86/'

/** The placeholder the extractor substitutes for v86's image host. */
const HOST = 'HOST/'

/** One image a guest boots from. */
interface UpstreamImage {
  slot: string
  file: string
  size?: number
  streamed: boolean
  /** The piece size a streamed image was cut into, when the catalog states one. */
  chunkBytes?: number
  /** An absolute URL, for the profiles that name one instead of a file on the host. */
  source?: string
}

/** What the demo page's table says about one machine. */
interface Metadata {
  name: string
  licence: string
  family: string
  medium: string
  notes: string
  /** Whether it draws a desktop or only writes text. */
  ui: 'graphical' | 'text' | 'unknown'
}

/** One machine, as v86 describes it. */
interface UpstreamGuest {
  id: string
  name: string
  images: UpstreamImage[]
  /** From the demo page's table; absent for a profile that is not listed there. */
  licence?: string
  family?: string
  medium?: string
  notes?: string
  ui?: 'graphical' | 'text' | 'unknown'
  /** Everything else v86 constructs the machine with. */
  options?: Record<string, unknown>
}

/** The v86 option keys that name an image file. */
const IMAGE_SLOTS = ['fda', 'fdb', 'hda', 'hdb', 'cdrom', 'bzimage', 'initrd', 'multiboot', 'state']

/** Fetch text, failing with a message that says which source refused. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`v86-catalog: ${url} answered ${String(response.status)}`)
  return response.text()
}

/**
 * Evaluate v86's profile table.
 *
 * The table is the body of `const oses = [...]` inside one function, built from
 * a `host` string and one `ON_LOCALHOST` flag. Slicing it out by those two
 * markers and evaluating it in an empty sandbox is what turns it into data;
 * parsing it instead would mean writing a JavaScript parser for object literals
 * that upstream is free to reshape at any time.
 * @param source - v86's `src/browser/main.js`.
 * @returns the profiles, with the image host reduced to a placeholder.
 */
function readProfiles(source: string): Record<string, unknown>[] {
  const opening = source.indexOf('const oses = [')
  if (opening === -1) throw new Error('v86-catalog: upstream no longer declares `const oses = [`')
  const closing = source.indexOf('\n    ];', opening)
  if (closing === -1) throw new Error('v86-catalog: could not find the end of the `oses` table')
  const body = source.slice(opening, closing + '\n    ];'.length)
  const sandbox = createContext({ host: HOST, ON_LOCALHOST: false })
  runInContext(`${body}\nglobalThis.__oses__ = oses`, sandbox, { timeout: 5000 })
  const table = (sandbox as { __oses__?: unknown }).__oses__
  if (!Array.isArray(table)) throw new Error('v86-catalog: the evaluated table is not an array')
  return table as Record<string, unknown>[]
}

/** The v86 constructor options that are not image slots. */
const CARRIED_OPTIONS = [
  'memory_size', 'vga_memory_size', 'acpi', 'cmdline', 'net_device_type', 'mac_address_translation',
  'mouse_disabled_default', 'bzimage_initrd_from_filesystem', 'cpuid_level', 'boot_order',
  'preserve_mac_from_state_image',
]

/** Read everything the machine is constructed with that is not a file. */
function optionsOf(profile: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const key of CARRIED_OPTIONS) {
    if (profile[key] !== undefined) options[key] = profile[key]
  }
  return options
}

/** Read the images one profile declares. */
function imagesOf(profile: Record<string, unknown>): UpstreamImage[] {
  const images: UpstreamImage[] = []
  for (const slot of IMAGE_SLOTS) {
    const value = profile[slot]
    if (typeof value !== 'object' || value === null) continue
    const image = value as { url?: string, size?: number, use_parts?: boolean, fixed_chunk_size?: number }
    if (typeof image.url !== 'string') continue
    // A handful of profiles name an absolute URL instead of a file on the
    // image host — KolibriOS points at its own build server. Stripping a
    // placeholder that is not there would leave the whole URL sitting where a
    // file name belongs, and every host would then be prefixed onto it.
    const absolute = !image.url.startsWith(HOST)
    images.push({
      slot,
      file: absolute ? image.url.slice(image.url.lastIndexOf('/') + 1) : image.url.replace(HOST, ''),
      ...(absolute ? { source: image.url.startsWith('//') ? `https:${image.url}` : image.url } : {}),
      ...(typeof image.size === 'number' ? { size: image.size } : {}),
      streamed: image.use_parts === true,
      ...(typeof image.fixed_chunk_size === 'number' ? { chunkBytes: image.fixed_chunk_size } : {}),
    })
  }
  const filesystem = profile.filesystem as { baseurl?: string, basefs?: { url?: string } } | undefined
  if (typeof filesystem?.baseurl === 'string') {
    images.push({ slot: 'filesystem', file: filesystem.baseurl.replace(HOST, ''), streamed: false })
  }
  if (typeof filesystem?.basefs?.url === 'string') {
    images.push({ slot: 'basefs', file: filesystem.basefs.url.replace(HOST, ''), streamed: false })
  }
  return images
}

/** Read the demo page's per-machine metadata table. */
function readMetadata(html: string): Map<string, Metadata> {
  const found = new Map<string, Metadata>()
  const rows = html.matchAll(/<a class="tr" href="\?profile=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)
  for (const row of rows) {
    const raw = [...row[2].matchAll(/<span>([\s\S]*?)<\/span>/g)].map(cell => cell[1])
    const cells = raw.map(cell => cell.replace(/<[^>]+>/g, '').trim())
    if (cells.length < 10) continue
    // The UI column is an icon, not a word: `gui_icon` for a machine that draws
    // a desktop, `tui_icon` for one that only writes text. It is the one piece
    // of upstream metadata that bears on which tools a model should be given,
    // so it is read from the class rather than from the stripped text, which is
    // empty.
    const graphical = /gui_icon/.test(raw[2] ?? '')
    found.set(row[1], {
      name: cells[0],
      licence: cells[6],
      family: cells[3],
      medium: cells[8],
      notes: cells[9],
      ui: graphical ? 'graphical' : /tui_icon/.test(raw[2] ?? '') ? 'text' : 'unknown',
    })
  }
  return found
}

/**
 * Fold the `-boot` variants away.
 *
 * Several machines appear twice: once resuming from a saved state and once
 * booting the same disk cold. They are one machine to a person choosing one.
 * @param id - the profile id.
 * @returns the id a person would recognise.
 */
function canonical(id: string): string {
  const bare = id.slice(id.lastIndexOf('/') + 1)
  return bare.endsWith('-boot') ? bare.slice(0, -'-boot'.length) : bare
}

/** The machine ids this build offers, read from its own catalog. */
function ours(): string[] {
  const source = readFileSync(join(root, 'src/runtime/guests.ts'), 'utf8')
  return [...source.matchAll(/^\s{4}id: '([^']+)',$/gm)].map(match => match[1])
}

/** Bytes as a size a person reads. */
function size(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024).toString()} MB`
  return `${Math.round(bytes / 1024).toString()} KB`
}

/** Read both halves of v86's catalog and join them. */
async function upstream(): Promise<UpstreamGuest[]> {
  const [source, html] = await Promise.all([fetchText(PROFILE_SOURCE), fetchText(METADATA_SOURCE)])
  const metadata = readMetadata(html)
  const guests: UpstreamGuest[] = []
  const seen = new Set<string>()
  for (const profile of readProfiles(source)) {
    const id = typeof profile.id === 'string' ? profile.id : ''
    // The debug build appends one profile per CPU test case; they are not
    // machines and the demo page does not list them.
    if (id === '' || id.startsWith('test-')) continue
    const key = canonical(id)
    if (seen.has(key)) continue
    const images = imagesOf(profile)
    if (images.length === 0) continue
    seen.add(key)
    const meta = metadata.get(id) ?? metadata.get(key)
    guests.push({
      id: key,
      name: typeof profile.name === 'string' ? profile.name : meta?.name ?? key,
      images,
      ...(meta === undefined ? {} : { licence: meta.licence, family: meta.family, medium: meta.medium, notes: meta.notes, ui: meta.ui }),
      options: optionsOf(profile),
    })
  }
  return guests
}

const catalog = await upstream()

if (asJson) {
  process.stdout.write(`${JSON.stringify(catalog, null, 1)}\n`)
} else {
  const here = new Set(ours())
  const missing = catalog.filter(guest => !here.has(guest.id))
  const open = missing.filter(guest => guest.licence === 'Open-source')
  const closed = missing.filter(guest => guest.licence === 'Proprietary')
  const unlisted = missing.filter(guest => guest.licence === undefined)

  process.stdout.write(`v86 offers ${String(catalog.length)} machines; this build offers ${String(here.size)}.\n\n`)

  const show = (title: string, rows: UpstreamGuest[]): void => {
    process.stdout.write(`── ${title} (${String(rows.length)}) ──\n`)
    for (const guest of rows) {
      const files = guest.images
        .map(image => `${image.file}${image.streamed ? ' (in parts)' : ''} ${size(image.size)}`)
        .join(', ')
      process.stdout.write(`  ${guest.id.padEnd(18)} ${(guest.medium ?? '?').padEnd(11)} ${files}\n`)
    }
    process.stdout.write('\n')
  }

  show('missing, and open-source — a mirror may serve these', open)
  show('missing, and proprietary — bring your own disk', closed)
  if (unlisted.length > 0) show('missing, and not in the demo page\'s table', unlisted)

  const extra = [...here].filter(id => !catalog.some(guest => guest.id === id))
  if (extra.length > 0) process.stdout.write(`── offered here and not by v86 (${String(extra.length)}) ──\n  ${extra.join(', ')}\n\n`)

  process.stdout.write(
    `${String(missing.length)} machines are missing here. ${String(open.length)} of them are open-source, `
    + 'which is the set a mirror can close; the rest need a disk their owner has not licensed anyone to serve.\n',
  )
}
