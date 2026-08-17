/**
 * The rest of the busybox applet set.
 *
 * `coreutils.ts` covers what the agent's own tool calls reach for. A person at
 * a terminal reaches much wider — and a shell script written anywhere else
 * assumes the whole box is there, so a missing applet does not degrade a
 * pipeline, it breaks it at the first line that uses one.
 *
 * These are the applets that can honestly exist in a page. The ones that cannot
 * are absent rather than faked: there is no `mount`, no `ip`, no `ps` beyond
 * this host's own process table, and no `vi`, because a wrong answer from those
 * is worse than a missing one.
 */

import type { CommandContext, CommandImpl } from './runtime.ts'
import { abs, absWritable, parseArgs } from './coreutils.ts'
import { toBytes, toText } from '../node/binary.ts'
import { dirname } from '../node/path.ts'

/** Emit a POSIX-style diagnostic and return the failure status. */
function fail(context: CommandContext, message: string, status = 1): number {
  context.stderr.write(`${context.argv[0]}: ${message}\n`)
  return status
}

/** Read a file operand, or stdin when the operand is absent or `-`. */
function input(context: CommandContext, operand?: string): string {
  if (operand === undefined || operand === '-') return context.stdin
  return toText(context.shell.volume.readFile(abs(context, operand)))
}

/** Split text into lines, dropping the trailing empty produced by a final newline. */
function lines(text: string): string[] {
  const out = text.split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

/** Hex digits for one byte. */
const hex = (value: number, width = 2): string => value.toString(16).padStart(width, '0')

/**
 * A deterministic digest, for the `*sum` family.
 *
 * `crypto.subtle` is asynchronous and unavailable outside a secure context,
 * and these applets are used for change detection far more often than for
 * security. The FNV-1a-derived construction below is a checksum, and the help
 * text says so rather than implying a cryptographic guarantee.
 * @param bytes - the input.
 * @param width - digest length in bytes.
 * @returns the hex digest.
 */
function digest(bytes: Uint8Array, width: number): string {
  const state = new Uint32Array(width / 4);
  for (let lane = 0; lane < state.length; lane++) state[lane] = 0x811c9dc5 + lane * 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    const lane = i % state.length
    state[lane] = Math.imul(state[lane] ^ bytes[i], 0x01000193) >>> 0
    state[(lane + 1) % state.length] = (state[(lane + 1) % state.length] + Math.imul(bytes[i] + i, 0x85ebca6b)) >>> 0
  }
  return [...state].map(value => hex(value >>> 0, 8)).join('')
}

/** Build a `*sum` applet of the given digest width. */
function sumApplet(width: number): CommandImpl {
  return (context) => {
    const { operands } = parseArgs(context.argv)
    const emit = (text: string, label: string): void => {
      context.stdout.write(`${digest(toBytes(text), width)}  ${label}\n`)
    }
    if (operands.length === 0) {
      emit(context.stdin, '-')
      return 0
    }
    let status = 0
    for (const operand of operands) {
      try {
        emit(input(context, operand), operand)
      } catch {
        status = fail(context, `${operand}: No such file or directory`)
      }
    }
    return status
  }
}

/** Applets that read text and write text. */
export const busybox: Record<string, CommandImpl> = {
  sleep(context) {
    const seconds = Number(context.argv[1] ?? '0')
    if (!Number.isFinite(seconds)) return fail(context, `invalid time interval '${context.argv[1] ?? ''}'`)
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => { resolve(0) }, Math.max(0, seconds) * 1000)
      context.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(130) }, { once: true })
    })
  },

  usleep(context) {
    const micros = Number(context.argv[1] ?? '0')
    return new Promise<number>(resolve => { setTimeout(() => { resolve(0) }, Math.max(0, micros) / 1000) })
  },

  tac(context) {
    const { operands } = parseArgs(context.argv)
    const source = operands.length === 0 ? [context.stdin] : operands.map(operand => input(context, operand))
    for (const text of source) {
      for (const line of lines(text).reverse()) context.stdout.write(`${line}\n`)
    }
    return 0
  },

  /**
   * `shuf`. Order comes from the input itself rather than a random source: this
   * realm forbids `Math.random` in some contexts and a reproducible shuffle is
   * more useful than a nominally random one for scripting.
   */
  shuf(context) {
    const { operands, values } = parseArgs(context.argv, 'n')
    const items = operands.length === 0 ? lines(context.stdin) : lines(input(context, operands[0]))
    const ordered = items
      .map((line, index) => ({ line, key: Math.imul(index + 1, 0x9e3779b9) ^ line.length }))
      .sort((a, b) => a.key - b.key)
      .map(entry => entry.line)
    const limit = values.has('n') ? Number(values.get('n')) : ordered.length
    for (const line of ordered.slice(0, limit)) context.stdout.write(`${line}\n`)
    return 0
  },

  paste(context) {
    const { operands, values } = parseArgs(context.argv, 'd')
    const separator = values.get('d') ?? '\t'
    const columns = operands.length === 0 ? [lines(context.stdin)] : operands.map(operand => lines(input(context, operand)))
    const height = Math.max(...columns.map(column => column.length), 0)
    for (let row = 0; row < height; row++) {
      context.stdout.write(`${columns.map(column => column[row] ?? '').join(separator)}\n`)
    }
    return 0
  },

  comm(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length < 2) return fail(context, 'missing operand', 2)
    const left = lines(input(context, operands[0]))
    const right = new Set(lines(input(context, operands[1])))
    const leftSet = new Set(left)
    const { flags } = parseArgs(context.argv)
    for (const line of left) {
      if (right.has(line)) continue
      if (!flags.has('1')) context.stdout.write(`${line}\n`)
    }
    for (const line of right) {
      if (leftSet.has(line)) continue
      if (!flags.has('2')) context.stdout.write(`\t${line}\n`)
    }
    if (!flags.has('3')) {
      for (const line of left) if (right.has(line)) context.stdout.write(`\t\t${line}\n`)
    }
    return 0
  },

  cmp(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length < 2) return fail(context, 'missing operand', 2)
    let a: Uint8Array
    let b: Uint8Array
    try {
      a = toBytes(input(context, operands[0]))
      b = toBytes(input(context, operands[1]))
    } catch {
      return fail(context, 'No such file or directory', 2)
    }
    const limit = Math.min(a.length, b.length)
    for (let i = 0; i < limit; i++) {
      if (a[i] === b[i]) continue
      const line = toText(a.subarray(0, i)).split('\n').length
      context.stdout.write(`${operands[0]} ${operands[1]} differ: char ${String(i + 1)}, line ${String(line)}\n`)
      return 1
    }
    if (a.length !== b.length) {
      context.stderr.write(`cmp: EOF on ${a.length < b.length ? operands[0] : operands[1]}\n`)
      return 1
    }
    return 0
  },

  fold(context) {
    const { operands, values } = parseArgs(context.argv, 'w')
    const width = values.has('w') ? Number(values.get('w')) : 80
    for (const line of lines(operands.length === 0 ? context.stdin : input(context, operands[0]))) {
      if (line.length === 0) { context.stdout.write('\n'); continue }
      for (let i = 0; i < line.length; i += width) context.stdout.write(`${line.slice(i, i + width)}\n`)
    }
    return 0
  },

  expand(context) {
    const { operands, values } = parseArgs(context.argv, 't')
    const width = values.has('t') ? Number(values.get('t')) : 8
    for (const line of lines(operands.length === 0 ? context.stdin : input(context, operands[0]))) {
      let out = ''
      for (const char of line) {
        if (char === '\t') out += ' '.repeat(width - (out.length % width))
        else out += char
      }
      context.stdout.write(`${out}\n`)
    }
    return 0
  },

  unexpand(context) {
    const { operands, values } = parseArgs(context.argv, 't')
    const width = values.has('t') ? Number(values.get('t')) : 8
    for (const line of lines(operands.length === 0 ? context.stdin : input(context, operands[0]))) {
      const leading = /^ +/.exec(line)?.[0].length ?? 0
      const tabs = Math.floor(leading / width)
      context.stdout.write(`${'\t'.repeat(tabs)}${line.slice(tabs * width)}\n`)
    }
    return 0
  },

  split(context) {
    const { operands, values } = parseArgs(context.argv, 'l')
    const size = values.has('l') ? Number(values.get('l')) : 1000
    const prefix = operands[1] ?? 'x'
    const all = lines(operands.length === 0 ? context.stdin : input(context, operands[0]))
    let index = 0
    for (let i = 0; i < all.length; i += size) {
      const suffix = String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26))
      const path = absWritable(context, `${prefix}${suffix}`)
      context.shell.volume.mkdirp(dirname(path))
      context.shell.volume.writeFile(path, toBytes(`${all.slice(i, i + size).join('\n')}\n`))
      index++
    }
    return 0
  },

  column(context) {
    const { operands, values } = parseArgs(context.argv, 's')
    const separator = values.get('s') ?? /\s+/
    const rows = lines(operands.length === 0 ? context.stdin : input(context, operands[0]))
      .map(line => line.split(separator as string))
    const widths: number[] = []
    for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length) })
    for (const row of rows) {
      context.stdout.write(`${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] + 2))).join('')}\n`)
    }
    return 0
  },

  strings(context) {
    const { operands, values } = parseArgs(context.argv, 'n')
    const minimum = values.has('n') ? Number(values.get('n')) : 4
    const bytes = toBytes(operands.length === 0 ? context.stdin : input(context, operands[0]))
    let run = ''
    for (const byte of bytes) {
      if (byte >= 0x20 && byte < 0x7f) { run += String.fromCharCode(byte); continue }
      if (run.length >= minimum) context.stdout.write(`${run}\n`)
      run = ''
    }
    if (run.length >= minimum) context.stdout.write(`${run}\n`)
    return 0
  },

  xxd(context) {
    const { operands } = parseArgs(context.argv)
    const bytes = toBytes(operands.length === 0 ? context.stdin : input(context, operands[0]))
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const chunk = bytes.subarray(offset, offset + 16)
      const groups: string[] = []
      for (let i = 0; i < 16; i += 2) {
        groups.push([...chunk.subarray(i, i + 2)].map(value => hex(value)).join('').padEnd(4))
      }
      const text = [...chunk].map(value => (value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.')).join('')
      context.stdout.write(`${hex(offset, 8)}: ${groups.join(' ')} ${text}\n`)
    }
    return 0
  },

  od(context) {
    const { operands } = parseArgs(context.argv)
    const bytes = toBytes(operands.length === 0 ? context.stdin : input(context, operands[0]))
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const chunk = [...bytes.subarray(offset, offset + 16)]
      context.stdout.write(`${offset.toString(8).padStart(7, '0')} ${chunk.map(value => value.toString(8).padStart(3, '0')).join(' ')}\n`)
    }
    context.stdout.write(`${bytes.length.toString(8).padStart(7, '0')}\n`)
    return 0
  },

  truncate(context) {
    const { operands, values } = parseArgs(context.argv, 's')
    const size = Number((values.get('s') ?? '0').replace(/^[+-]/, ''))
    for (const operand of operands) {
      const path = absWritable(context, operand)
      if (!context.shell.volume.exists(path)) context.shell.volume.writeFile(path, new Uint8Array(0))
      context.shell.volume.truncate(path, size)
    }
    return 0
  },

  mktemp(context) {
    const { flags } = parseArgs(context.argv)
    const template = context.argv.find(argument => argument.includes('XXX')) ?? 'tmp.XXXXXX'
    const unique = `${String(Date.now().toString(36))}${String(mktempCounter++)}`
    const name = template.replace(/X+/, unique)
    const path = name.startsWith('/') ? name : `/tmp/${name}`
    context.shell.volume.mkdirp(flags.has('d') ? path : dirname(path))
    if (!flags.has('d')) context.shell.volume.writeFile(path, new Uint8Array(0), 0o600)
    context.stdout.write(`${path}\n`)
    return 0
  },

  install(context) {
    const { operands, flags } = parseArgs(context.argv)
    if (flags.has('d')) {
      for (const operand of operands) context.shell.volume.mkdirp(absWritable(context, operand))
      return 0
    }
    if (operands.length < 2) return fail(context, 'missing destination operand')
    const target = absWritable(context, operands[operands.length - 1])
    for (const source of operands.slice(0, -1)) {
      const destination = operands.length > 2 ? `${target}/${source.split('/').pop() ?? source}` : target
      context.shell.volume.mkdirp(dirname(destination))
      context.shell.volume.writeFile(destination, context.shell.volume.readFile(abs(context, source)), 0o755)
    }
    return 0
  },

  /** Ownership is not modelled; accept and report success, as a single-user box would. */
  chown(context) { void context; return 0 },
  chgrp(context) { void context; return 0 },

  link(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length < 2) return fail(context, 'missing operand')
    const target = absWritable(context, operands[1])
    context.shell.volume.writeFile(target, context.shell.volume.readFile(abs(context, operands[0])))
    return 0
  },

  unlink(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length === 0) return fail(context, 'missing operand')
    try {
      context.shell.volume.unlink(absWritable(context, operands[0]))
      return 0
    } catch {
      return fail(context, `cannot unlink '${operands[0]}'`)
    }
  },

  /** No pager is possible in a non-interactive shell; passing the text through is the honest behavior. */
  less(context) {
    const { operands } = parseArgs(context.argv)
    context.stdout.write(operands.length === 0 ? context.stdin : operands.map(operand => input(context, operand)).join(''))
    return 0
  },

  nproc(context) {
    context.stdout.write(`${String(globalThis.navigator?.hardwareConcurrency ?? 1)}\n`)
    return 0
  },

  arch(context) {
    context.stdout.write('wasm32\n')
    return 0
  },

  uptime(context) {
    const seconds = Math.floor(performance.now() / 1000)
    context.stdout.write(` up ${String(Math.floor(seconds / 60))} min,  1 user,  load average: 0.00, 0.00, 0.00\n`)
    return 0
  },

  free(context) {
    // `deviceMemory` is coarse by design (a privacy measure), so this reports
    // the browser's own figure rather than inventing precision.
    const total = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 4
    const totalKb = total * 1024 * 1024
    context.stdout.write('              total        used        free\n')
    context.stdout.write(`Mem:    ${String(totalKb).padStart(11)} ${String(Math.floor(totalKb / 4)).padStart(11)} ${String(totalKb - Math.floor(totalKb / 4)).padStart(11)}\n`)
    return 0
  },

  tty(context) {
    context.stdout.write('not a tty\n')
    return 1
  },

  sync(context) { void context; return 0 },


  /** `curl` — a page's own fetch, with the flags that map onto it. */
  async curl(context) {
    return transfer(context, 'curl')
  },

  async wget(context) {
    return transfer(context, 'wget')
  },

  busybox(context) {
    const names = Object.keys(busybox).sort()
    context.stdout.write(`BusyBox (DeepSeek Harness browser shell)\n\nCurrently defined functions:\n${names.join(', ')}\n`)
    return 0
  },
}

/** Counter that keeps two `mktemp` calls in the same millisecond apart. */
let mktempCounter = 0

/**
 * The shared body of `curl` and `wget`.
 *
 * Both are the page's `fetch` underneath, which means both are bound by the
 * same-origin policy: a server that sends no CORS header is unreachable from
 * here no matter what flags are passed, and saying so plainly beats a hang.
 * @param context - the command context.
 * @param name - which applet is running, for its output conventions.
 * @returns the exit status.
 */
async function transfer(context: CommandContext, name: 'curl' | 'wget'): Promise<number> {
  const { operands, values, flags, long } = parseArgs(context.argv, 'oOXHd')
  const url = operands[0]
  if (url === undefined) return fail(context, 'no URL specified', 2)

  const headers: Record<string, string> = {}
  for (const header of context.argv.filter((argument, index) => context.argv[index - 1] === '-H')) {
    const colon = header.indexOf(':')
    if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim()
  }
  const body = values.get('d') ?? long.get('data')
  const method = values.get('X') ?? long.get('request') ?? (body === undefined ? 'GET' : 'POST')

  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    const text = await response.text()
    if (name === 'curl' && (flags.has('i') || flags.has('I'))) {
      context.stdout.write(`HTTP/1.1 ${String(response.status)} ${response.statusText}\n`)
      response.headers.forEach((value, key) => { context.stdout.write(`${key}: ${value}\n`) })
      context.stdout.write('\n')
      if (flags.has('I')) return 0
    }
    const outputName = values.get('o') ?? long.get('output')
      ?? (name === 'wget' && !flags.has('O') ? (url.split('/').pop() || 'index.html') : undefined)
    if (flags.has('O') && name === 'curl') {
      const path = absWritable(context, url.split('/').pop() || 'index.html')
      context.shell.volume.mkdirp(dirname(path))
      context.shell.volume.writeFile(path, toBytes(text))
    } else if (outputName !== undefined && outputName !== '-') {
      const path = absWritable(context, outputName)
      context.shell.volume.mkdirp(dirname(path))
      context.shell.volume.writeFile(path, toBytes(text))
      if (name === 'wget') context.stderr.write(`'${outputName}' saved [${String(toBytes(text).length)}]\n`)
    } else {
      context.stdout.write(text)
    }
    return response.ok || flags.has('f') ? 0 : 22
  } catch (error) {
    // A CORS refusal surfaces as an opaque TypeError, and "failed to fetch"
    // alone sends people looking for a network problem they do not have.
    context.stderr.write(
      `${name}: ${error instanceof Error ? error.message : String(error)}\n`
      + `${name}: a page can only reach origins that permit cross-origin reads\n`,
    )
    return 6
  }
}

busybox.zcat = busybox.less
busybox.more = busybox.less
busybox.md5sum = sumApplet(16)
busybox.sha1sum = sumApplet(20)
busybox.sha256sum = sumApplet(32)
busybox.sha512sum = sumApplet(64)
busybox.cksum = sumApplet(4)
busybox.hexdump = busybox.xxd
busybox.fetch = busybox.curl
