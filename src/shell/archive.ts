/**
 * Archiving, encoding, and the two terminal queries scripts actually make.
 *
 * These are the applets that were missing for no better reason than that
 * nothing had written them yet. Every one is pure computation over bytes — a
 * page can do all of it — so leaving them out was a gap in what this build
 * supports rather than a limit of where it runs. What stays absent is what
 * genuinely cannot work here: `gcc` needs a native toolchain, `ssh` and `ping`
 * need sockets the browser does not hand out.
 *
 * One shape of this shell governs the archivers: a pipe carries text, not
 * bytes. Reading and writing files goes through the volume and is exact, but
 * compressed data written to standard output would be re-encoded as UTF-8 and
 * quietly cease to be a valid archive. So compressing to a pipe is refused
 * rather than corrupted — the same reason GNU `tar` refuses to write an archive
 * to a terminal — while decompressing to one, which yields text, is fine.
 */

import { gzipSync, gunzipSync } from 'fflate'
import type { CommandContext, CommandImpl } from './runtime.ts'
import { abs, absWritable, parseArgs } from './coreutils.ts'
import { toBytes, toText } from '../node/binary.ts'
import { dirname } from '../node/path.ts'

/** Emit a POSIX-style diagnostic and return the failure status. */
function fail(context: CommandContext, message: string, status = 1): number {
  context.stderr.write(`${context.argv[0]}: ${message}\n`)
  return status
}

/** One entry in a tar archive. */
interface TarEntry {
  name: string
  data: Uint8Array
  mode: number
  kind: 'file' | 'dir'
}

/** Write a fixed-width NUL-padded field. */
function field(target: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = toBytes(value)
  target.set(bytes.subarray(0, width - 1), offset)
}

/** Octal, as tar records numbers. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0')
}

/** Build a ustar archive. */
function writeTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const header = new Uint8Array(512)
    const name = entry.kind === 'dir' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name
    field(header, 0, 100, name)
    field(header, 100, 8, octal(entry.mode & 0o7777, 8))
    field(header, 108, 8, octal(0, 8))
    field(header, 116, 8, octal(0, 8))
    field(header, 124, 12, octal(entry.kind === 'dir' ? 0 : entry.data.length, 12))
    field(header, 136, 12, octal(Math.floor(Date.now() / 1000), 12))
    header[156] = entry.kind === 'dir' ? 0x35 : 0x30
    field(header, 257, 6, 'ustar')
    header[263] = 0x30
    header[264] = 0x30
    // The checksum is computed with its own field read as spaces.
    header.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    field(header, 148, 8, `${octal(sum, 7)}\0`)
    blocks.push(header)
    if (entry.kind === 'file') {
      const padded = new Uint8Array(Math.ceil(entry.data.length / 512) * 512)
      padded.set(entry.data)
      blocks.push(padded)
    }
  }
  // Two zero blocks end the archive.
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((size, block) => size + block.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const block of blocks) {
    out.set(block, at)
    at += block.length
  }
  return out
}

/** Read a NUL-terminated field. */
function readField(source: Uint8Array, offset: number, width: number): string {
  const slice = source.subarray(offset, offset + width)
  const end = slice.indexOf(0)
  return toText(end === -1 ? slice : slice.subarray(0, end)).trim()
}

/** Parse a ustar archive. */
function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512)
    const name = readField(header, 0, 100)
    if (name === '') break
    const prefix = readField(header, 345, 155)
    const size = Number.parseInt(readField(header, 124, 12) || '0', 8)
    const mode = Number.parseInt(readField(header, 100, 8) || '644', 8)
    const type = header[156]
    at += 512
    const data = bytes.subarray(at, at + size)
    at += Math.ceil(size / 512) * 512
    // `5` is a directory; `0` and NUL are ordinary files. Anything else — a
    // hard link, a device — has no meaning in this filesystem.
    // A directory records its own trailing slash; carrying it into the entry
    // name would double it everywhere the name is printed or joined.
    const full = (prefix === '' ? name : `${prefix}/${name}`).replace(/\/+$/, '')
    if (type === 0x35) entries.push({ name: full, data: new Uint8Array(0), mode, kind: 'dir' })
    else if (type === 0x30 || type === 0) entries.push({ name: full, data: data.slice(), mode, kind: 'file' })
  }
  return entries
}

/** Collect a path into archive entries, walking directories. */
function collect(context: CommandContext, path: string, base: string): TarEntry[] {
  const volume = context.shell.volume
  const node = volume.statNode(path, false)
  const relative = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path.replace(/^\/+/, '')
  if (node.kind === 'dir') {
    const entries: TarEntry[] = [{ name: relative, data: new Uint8Array(0), mode: node.mode, kind: 'dir' }]
    for (const child of volume.readdir(path)) entries.push(...collect(context, `${path}/${child}`, base))
    return entries
  }
  return [{ name: relative, data: volume.readFile(path).slice(), mode: node.mode, kind: 'file' }]
}

/** Whether the bytes carry a gzip header. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * `tar` — create, list, and extract.
 *
 * Compression is detected on read rather than demanded on the command line,
 * which is what GNU tar does and what a script that omits `-z` expects.
 */
const tar: CommandImpl = (context) => {
  const { flags, operands, values } = parseArgs(context.argv, 'fC')
  const file = values.get('f')
  const directory = values.get('C')
  const volume = context.shell.volume

  if (flags.has('c')) {
    if (file === undefined) return fail(context, 'refusing to write an archive to a terminal (use -f)', 2)
    const base = directory === undefined ? context.shell.cwd : abs(context, directory)
    const entries = operands.flatMap(operand => collect(context, abs(context, operand), base))
    const archive = writeTar(entries)
    const bytes = flags.has('z') ? gzipSync(archive) : archive
    volume.writeFile(absWritable(context, file), bytes)
    if (flags.has('v')) for (const entry of entries) context.stdout.write(`${entry.name}\n`)
    return 0
  }

  if (!flags.has('x') && !flags.has('t')) return fail(context, 'one of -c, -t or -x is required', 2)

  let bytes: Uint8Array
  try {
    bytes = file === undefined ? toBytes(context.stdin, 'latin1') : volume.readFile(abs(context, file))
  } catch {
    return fail(context, `${file ?? '-'}: cannot open`, 2)
  }
  if (isGzip(bytes)) bytes = gunzipSync(bytes)
  const entries = readTar(bytes)

  if (flags.has('t')) {
    for (const entry of entries) context.stdout.write(`${entry.name}${entry.kind === 'dir' ? '/' : ''}\n`)
    return 0
  }

  const root = directory === undefined ? context.shell.cwd : abs(context, directory)
  for (const entry of entries) {
    // A member naming its way out of the destination is the one thing an
    // archive must not be allowed to do.
    if (entry.name.split('/').includes('..')) {
      context.stderr.write(`tar: ${entry.name}: refusing to extract outside the destination\n`)
      continue
    }
    const target = `${root}/${entry.name}`.replace(/\/+$/, '')
    if (entry.kind === 'dir') {
      volume.mkdirp(target, entry.mode)
      continue
    }
    volume.mkdirp(dirname(target))
    volume.writeFile(target, entry.data, entry.mode)
    if (flags.has('v')) context.stdout.write(`${entry.name}\n`)
  }
  return 0
}

/** `gzip` / `gunzip` / `zcat`, sharing one implementation. */
function compressor(mode: 'gzip' | 'gunzip' | 'zcat'): CommandImpl {
  return (context) => {
    const { flags, operands } = parseArgs(context.argv, '')
    const decompress = mode !== 'gzip' || flags.has('d')
    const toStdout = mode === 'zcat' || flags.has('c')
    const volume = context.shell.volume

    if (!decompress && (toStdout || operands.length === 0)) {
      return fail(context, 'refusing to write compressed data to a text stream', 2)
    }

    if (operands.length === 0) {
      context.stdout.write(toText(gunzipSync(toBytes(context.stdin, 'latin1'))))
      return 0
    }

    for (const operand of operands) {
      const path = abs(context, operand)
      let input: Uint8Array
      try {
        input = volume.readFile(path)
      } catch {
        return fail(context, `${operand}: No such file or directory`, 2)
      }
      const output = decompress ? gunzipSync(input) : gzipSync(input)
      if (toStdout) {
        context.stdout.write(toText(output))
        continue
      }
      const renamed = decompress ? path.replace(/\.gz$/, '') : `${path}.gz`
      volume.writeFile(absWritable(context, renamed), output)
      if (!flags.has('k')) volume.unlink(path)
    }
    return 0
  }
}

/** `base64` — encode, or decode with `-d`. */
const base64: CommandImpl = (context) => {
  const { flags, operands, values } = parseArgs(context.argv, 'w')
  const text = operands.length === 0 || operands[0] === '-'
    ? context.stdin
    : toText(context.shell.volume.readFile(abs(context, operands[0])))

  if (flags.has('d')) {
    try {
      context.stdout.write(atob(text.replace(/\s+/g, '')))
    } catch {
      return fail(context, 'invalid input', 1)
    }
    return 0
  }

  const encoded = btoa(text)
  // GNU wraps at 76 columns unless told otherwise; `-w 0` means one long line.
  const width = values.has('w') ? Number(values.get('w')) : 76
  if (width <= 0) {
    context.stdout.write(`${encoded}\n`)
    return 0
  }
  for (let at = 0; at < encoded.length; at += width) context.stdout.write(`${encoded.slice(at, at + width)}\n`)
  return 0
}

/** `join` — pair lines of two sorted files on a common field. */
const join: CommandImpl = (context) => {
  const { operands, values } = parseArgs(context.argv, 'jt12')
  if (operands.length < 2) return fail(context, 'usage: join [-j FIELD] [-t SEP] FILE1 FILE2', 2)
  const separator = values.get('t')
  const split = (line: string): string[] => (separator === undefined ? line.split(/\s+/).filter(Boolean) : line.split(separator))
  const keyOf = (parts: string[], which: '1' | '2'): string =>
    parts[Number(values.get(which) ?? values.get('j') ?? '1') - 1] ?? ''

  const read = (operand: string): string[] => (operand === '-' ? context.stdin : toText(context.shell.volume.readFile(abs(context, operand))))
    .split('\n').filter(line => line !== '')

  const right = new Map<string, string[][]>()
  for (const line of read(operands[1])) {
    const parts = split(line)
    const key = keyOf(parts, '2')
    const bucket = right.get(key)
    if (bucket === undefined) right.set(key, [parts])
    else bucket.push(parts)
  }

  const glue = separator ?? ' '
  for (const line of read(operands[0])) {
    const parts = split(line)
    const key = keyOf(parts, '1')
    for (const other of right.get(key) ?? []) {
      const rest = (fields: string[], which: '1' | '2'): string[] => {
        const index = Number(values.get(which) ?? values.get('j') ?? '1') - 1
        return fields.filter((_, at) => at !== index)
      }
      context.stdout.write([key, ...rest(parts, '1'), ...rest(other, '2')].join(glue) + '\n')
    }
  }
  return 0
}

/** What a file's first bytes say it is. */
function classify(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'empty'
  if (isGzip(bytes)) return 'gzip compressed data'
  const starts = (...prefix: number[]): boolean => prefix.every((byte, at) => bytes[at] === byte)
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return 'ELF executable'
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'Zip archive data'
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'PNG image data'
  if (starts(0xff, 0xd8, 0xff)) return 'JPEG image data'
  if (starts(0x00, 0x61, 0x73, 0x6d)) return 'WebAssembly binary module'
  if (bytes.length > 262 && toText(bytes.subarray(257, 262)) === 'ustar') return 'POSIX tar archive'
  const head = toText(bytes.subarray(0, 512))
  if (/[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(head)) return 'data'
  if (head.startsWith('#!')) return `${/(?:^|\/|\s)(?:ba|da|k|z)?sh(?:\s|$)/.test(head.split('\n')[0]) ? 'POSIX shell script' : 'script'} text executable`
  if (/^\s*[[{]/.test(head)) return 'JSON text'
  return 'ASCII text'
}

/** `file` — name what something is, from its contents rather than its extension. */
const file: CommandImpl = (context) => {
  const { operands } = parseArgs(context.argv, '')
  if (operands.length === 0) return fail(context, 'usage: file FILE...', 2)
  for (const operand of operands) {
    const path = abs(context, operand)
    const node = context.shell.volume.lookup(path, false)
    if (node === undefined) {
      context.stdout.write(`${operand}: cannot open (No such file or directory)\n`)
      continue
    }
    if (node.kind === 'dir') {
      context.stdout.write(`${operand}: directory\n`)
      continue
    }
    if (node.kind === 'link') {
      context.stdout.write(`${operand}: symbolic link to ${node.target ?? '?'}\n`)
      continue
    }
    context.stdout.write(`${operand}: ${classify(context.shell.volume.readFile(path).subarray(0, 1024))}\n`)
  }
  return 0
}

/**
 * `tput` — the terminal capabilities a script actually queries.
 *
 * Scripts use this to decide whether to colour their output and how wide to
 * wrap it. Answering is better than failing: a script that cannot ask assumes
 * the worst, or exits.
 */
const tput: CommandImpl = (context) => {
  const [, capability, ...rest] = context.argv
  const columns = Number(context.shell.vars.get('COLUMNS') ?? '80')
  const rows = Number(context.shell.vars.get('LINES') ?? '24')
  switch (capability) {
    case 'cols': case 'columns': context.stdout.write(`${String(columns)}\n`); return 0
    case 'lines': context.stdout.write(`${String(rows)}\n`); return 0
    case 'colors': context.stdout.write('256\n'); return 0
    case 'sgr0': case 'reset': context.stdout.write('\u001b[0m'); return 0
    case 'bold': context.stdout.write('\u001b[1m'); return 0
    case 'dim': context.stdout.write('\u001b[2m'); return 0
    case 'smul': context.stdout.write('\u001b[4m'); return 0
    case 'rmul': context.stdout.write('\u001b[24m'); return 0
    case 'setaf': context.stdout.write(`\u001b[3${rest[0] ?? '9'}m`); return 0
    case 'setab': context.stdout.write(`\u001b[4${rest[0] ?? '9'}m`); return 0
    case 'clear': context.stdout.write('\u001b[2J\u001b[H'); return 0
    case 'el': context.stdout.write('\u001b[K'); return 0
    case 'civis': context.stdout.write('\u001b[?25l'); return 0
    case 'cnorm': context.stdout.write('\u001b[?25h'); return 0
    default: return fail(context, `unknown terminfo capability '${capability ?? ''}'`, 4)
  }
}

/** The applets this module adds. */
export const archive: Record<string, CommandImpl> = {
  tar,
  gzip: compressor('gzip'),
  gunzip: compressor('gunzip'),
  zcat: compressor('zcat'),
  base64,
  join,
  file,
  tput,
}
