/**
 * The non-coreutils commands: hashing, encoding, archives, HTTP, JSON, and a
 * JavaScript interpreter exposed as `node`.
 *
 * `curl`/`wget` go through the page's own `fetch`, so they reach any host that
 * allows cross-origin reads — that is a real capability in the browser, not a
 * stub, and it is what makes "download this file and inspect it" work.
 */

import type { CommandImpl } from './runtime.ts'
import { announceOpenPath } from '../node/open-path.ts'
import { abs, parseArgs } from './coreutils.ts'
import { Buffer, toBytes, toText } from '../node/binary.ts'
import { digest } from '../node/hash.ts'
import { gunzipSync, gzipSync, unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { dirname } from '../vfs/path.ts'

/** Read a file operand or stdin. */
function input(context: Parameters<CommandImpl>[0], operand?: string): Uint8Array {
  if (operand === undefined || operand === '-') return toBytes(context.stdin)
  return context.shell.volume.readFile(abs(context, operand))
}

/** One hash command, parameterized by algorithm. */
function hashCommand(algorithm: string): CommandImpl {
  return (context) => {
    const { operands } = parseArgs(context.argv)
    if (operands.length === 0) {
      context.stdout.write(`${Buffer.from(digest(algorithm, toBytes(context.stdin))).toString('hex')}  -\n`)
      return 0
    }
    let status = 0
    for (const operand of operands) {
      try {
        const bytes = context.shell.volume.readFile(abs(context, operand))
        context.stdout.write(`${Buffer.from(digest(algorithm, bytes)).toString('hex')}  ${operand}\n`)
      } catch {
        context.stderr.write(`${context.argv[0]}: ${operand}: No such file or directory\n`)
        status = 1
      }
    }
    return status
  }
}

/** Commands beyond coreutils. */
export const tools: Record<string, CommandImpl> = {
  sha256sum: hashCommand('sha256'),
  sha1sum: hashCommand('sha1'),
  md5sum: hashCommand('md5'),

  base64(context) {
    const { flags, operands } = parseArgs(context.argv)
    const bytes = input(context, operands[0])
    if (flags.has('d') || flags.has('D')) {
      context.stdout.write(Buffer.from(toText(bytes).replace(/\s/g, ''), 'base64').toString('utf8'))
      return 0
    }
    const encoded = Buffer.from(bytes).toString('base64')
    // GNU base64 wraps at 76 columns.
    context.stdout.write(`${(encoded.match(/.{1,76}/g) ?? []).join('\n')}\n`)
    return 0
  },

  gzip(context) {
    const { flags, operands } = parseArgs(context.argv)
    if (flags.has('d')) return tools.gunzip(context)
    if (operands.length === 0) {
      context.stdout.write(Buffer.from(gzipSync(toBytes(context.stdin))).toString('binary'))
      return 0
    }
    for (const operand of operands) {
      const path = abs(context, operand)
      const bytes = context.shell.volume.readFile(path)
      context.shell.volume.writeFile(`${path}.gz`, gzipSync(bytes))
      if (!flags.has('k')) context.shell.volume.unlink(path)
    }
    return 0
  },

  gunzip(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length === 0) {
      context.stdout.write(toText(gunzipSync(toBytes(context.stdin))))
      return 0
    }
    for (const operand of operands) {
      const path = abs(context, operand)
      const bytes = context.shell.volume.readFile(path)
      context.shell.volume.writeFile(path.replace(/\.gz$/, ''), gunzipSync(bytes))
      context.shell.volume.unlink(path)
    }
    return 0
  },

  /**
   * `zip`-format archives via fflate. Real `tar` framing is not implemented;
   * `tar -czf`/`-xzf` map onto the same zip container so round-trips inside the
   * harness work, and the command says so when handed a foreign archive.
   */
  zip(context) {
    const { operands } = parseArgs(context.argv)
    const [archive, ...sources] = operands
    const entries: Record<string, Uint8Array> = {}
    for (const source of sources) {
      const root = abs(context, source)
      const node = context.shell.volume.lookup(root, false)
      if (node === undefined) continue
      if (node.kind === 'file') {
        entries[source] = context.shell.volume.readFile(root)
        continue
      }
      for (const [path, child] of context.shell.volume.walkTree(root)) {
        if (child.kind !== 'file') continue
        entries[path.slice(1)] = context.shell.volume.readFile(path)
      }
    }
    context.shell.volume.writeFile(abs(context, archive), zipSync(entries))
    return 0
  },

  unzip(context) {
    const { operands, values } = parseArgs(context.argv, 'd')
    const archive = abs(context, operands[0] ?? '')
    const destination = abs(context, values.get('d') ?? '.')
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(context.shell.volume.readFile(archive))
    } catch (error) {
      context.stderr.write(`unzip: cannot read ${operands[0] ?? ''}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/')) continue
      const target = `${destination}/${name}`
      context.shell.volume.mkdirp(dirname(target))
      context.shell.volume.writeFile(target, bytes)
      context.stdout.write(`  inflating: ${name}\n`)
    }
    return 0
  },

  async curl(context) {
    const { flags, operands, values, long } = parseArgs(context.argv, 'XdHo')
    const url = operands[0]
    if (url === undefined) {
      context.stderr.write('curl: no URL specified\n')
      return 2
    }
    const headers = new Headers()
    for (let i = 1; i < context.argv.length; i++) {
      if (context.argv[i] !== '-H') continue
      const header = context.argv[++i] ?? ''
      const colon = header.indexOf(':')
      if (colon !== -1) headers.set(header.slice(0, colon).trim(), header.slice(colon + 1).trim())
    }
    const method = values.get('X') ?? (values.has('d') || long.has('data') ? 'POST' : 'GET')
    const body = values.get('d') ?? long.get('data')
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded')
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: flags.has('L') || long.has('location') ? 'follow' : 'follow',
        signal: context.signal ?? null,
      })
      const text = await response.text()
      if (flags.has('i') || flags.has('I')) {
        context.stdout.write(`HTTP/1.1 ${String(response.status)} ${response.statusText}\n`)
        response.headers.forEach((value, name) => { context.stdout.write(`${name}: ${value}\n`) })
        context.stdout.write('\n')
      }
      const outputFile = values.get('o') ?? long.get('output')
      if (outputFile !== undefined) {
        const path = abs(context, outputFile)
        context.shell.volume.mkdirp(dirname(path))
        context.shell.volume.writeFile(path, toBytes(text))
      } else if (!flags.has('I')) {
        context.stdout.write(text)
      }
      if (flags.has('f') && !response.ok) {
        context.stderr.write(`curl: (22) The requested URL returned error: ${String(response.status)}\n`)
        return 22
      }
      return 0
    } catch (error) {
      // A CORS rejection is indistinguishable from a network failure by design.
      context.stderr.write(`curl: (7) Failed to connect: ${error instanceof Error ? error.message : String(error)}\n`)
      context.stderr.write('curl: the browser host can only reach origins that permit cross-origin reads\n')
      return 7
    }
  },

  async wget(context) {
    const { operands, values } = parseArgs(context.argv, 'O')
    const url = operands[0]
    if (url === undefined) {
      context.stderr.write('wget: missing URL\n')
      return 1
    }
    try {
      const response = await fetch(url, { signal: context.signal ?? null })
      const bytes = new Uint8Array(await response.arrayBuffer())
      const name = values.get('O') ?? (new URL(url).pathname.split('/').pop() || 'index.html')
      if (name === '-') {
        context.stdout.write(toText(bytes))
        return 0
      }
      const path = abs(context, name)
      context.shell.volume.mkdirp(dirname(path))
      context.shell.volume.writeFile(path, bytes)
      context.stderr.write(`'${name}' saved [${String(bytes.length)}]\n`)
      return response.ok ? 0 : 8
    } catch (error) {
      context.stderr.write(`wget: unable to resolve host address or blocked by CORS: ${error instanceof Error ? error.message : String(error)}\n`)
      return 4
    }
  },

  /**
   * A small `jq` covering the filters agents actually type: `.`, `.a.b`,
   * `.a[0]`, `.[]`, `.a | .b`, and `-r`.
   */
  jq(context) {
    const { flags, operands } = parseArgs(context.argv)
    const filter = operands[0] ?? '.'
    const source = operands.length > 1 ? toText(input(context, operands[1])) : context.stdin
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      context.stderr.write(`jq: error: ${error instanceof Error ? error.message : String(error)}\n`)
      return 2
    }
    const applyStep = (values: unknown[], step: string): unknown[] => {
      const out: unknown[] = []
      for (const value of values) {
        if (step === '' || step === '.') {
          out.push(value)
          continue
        }
        if (step === '[]') {
          if (Array.isArray(value)) out.push(...value)
          else if (typeof value === 'object' && value !== null) out.push(...Object.values(value))
          continue
        }
        const indexed = /^\[(-?\d+)\]$/.exec(step)
        if (indexed !== null && Array.isArray(value)) {
          const index = Number(indexed[1])
          out.push(value[index < 0 ? value.length + index : index])
          continue
        }
        if (typeof value === 'object' && value !== null) out.push((value as Record<string, unknown>)[step])
      }
      return out
    }
    let values: unknown[] = [parsed]
    for (const stage of filter.split('|')) {
      const trimmed = stage.trim()
      if (trimmed === '.' || trimmed.length === 0) continue
      // Split `.a[0].b` into `a`, `[0]`, `b`.
      const steps = trimmed.replace(/^\./, '').split(/\.|(?=\[)/).filter(step => step.length > 0)
      for (const step of steps) values = applyStep(values, step)
    }
    for (const value of values) {
      if (flags.has('r') && typeof value === 'string') context.stdout.write(`${value}\n`)
      else context.stdout.write(`${JSON.stringify(value, null, 2) ?? 'null'}\n`)
    }
    return 0
  },

  /**
   * `node` as a JavaScript evaluator over the page realm. `-e` evaluates a
   * snippet; a file operand runs the file. `console.log` is redirected to the
   * command's stdout, and `require` reaches the host module registry.
   */
  async node(context) {
    const { operands, values } = parseArgs(context.argv, 'e')
    const source = values.get('e') ?? (operands[0] === undefined ? context.stdin : toText(input(context, operands[0])))
    if (source.trim().length === 0) return 0
    const log = (...args: unknown[]): void => {
      context.stdout.write(`${args.map(value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value))).join(' ')}\n`)
    }
    const error = (...args: unknown[]): void => {
      context.stderr.write(`${args.map(value => (typeof value === 'string' ? value : String(value))).join(' ')}\n`)
    }
    try {
      const body = new Function('console', 'process', 'require', `"use strict";return (async () => {${source}\n})()`) as (
        consoleLike: unknown, processLike: unknown, requireLike: unknown,
      ) => Promise<unknown>
      await body(
        { log, info: log, warn: error, error, debug: log },
        { argv: ['node', ...operands], env: Object.fromEntries(context.shell.vars), exit: () => undefined, cwd: () => context.shell.cwd },
        (specifier: string) => { throw new Error(`require('${specifier}') is unavailable in the browser host`) },
      )
      return 0
    } catch (thrown) {
      context.stderr.write(`${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}\n`)
      return 1
    }
  },

  python3(context) {
    // The real one is CPython compiled to WebAssembly, and it runs inside the
    // container — see `src/python/container-python.ts`. This shell is what
    // answers when the container could not start at all, and it has nowhere to
    // put a 14 MB interpreter, so it says which of the two is missing rather
    // than implying Python was never on offer.
    context.stderr.write(
      'python3: the runtime did not start, and Python runs inside it. Reload the page, '
      + 'or use `node` for scripting here.\n',
    )
    return 127
  },
}

tools.python = tools.python3
// `pip` says `pip:`, not `python3:` — a message that names a command the caller
// did not type reads as a bug in the harness rather than an answer.
for (const name of ['pip', 'pip3']) {
  tools[name] = (context) => {
    context.stderr.write(
      `${name}: the runtime did not start, and Python runs inside it. Reload the page.\n`,
    )
    return 127
  }
}
tools.shasum = tools.sha1sum

/** `tar` is accepted with the common flag spellings and delegates to the zip container. */
tools.tar = (context) => {
  const { flags, values } = parseArgs(context.argv, 'f')
  const archive = values.get('f')
  if (archive === undefined) {
    context.stderr.write('tar: no archive file specified (-f)\n')
    return 2
  }
  const operands = parseArgs(context.argv, 'f').operands
  if (flags.has('c')) {
    return tools.zip({ ...context, argv: ['zip', archive, ...operands] })
  }
  if (flags.has('x')) {
    return tools.unzip({ ...context, argv: ['unzip', archive] })
  }
  if (flags.has('t')) {
    try {
      const files = unzipSync(context.shell.volume.readFile(abs(context, archive)))
      for (const name of Object.keys(files)) context.stdout.write(`${name}\n`)
      return 0
    } catch {
      context.stderr.write('tar: this build reads only archives it created (zip container)\n')
      return 2
    }
  }
  context.stderr.write('tar: specify one of -c, -x, or -t\n')
  return 2
}

/**
 * `xdg-open` — what "open this path" means in a tab.
 *
 * This is not a courtesy alias. The harness's own `host.openPath` RPC, which is
 * what a file mention in the chat calls when it is clicked, ends at
 * `xdg-open <path>` on Linux — and this host reports Linux because the shipped
 * compositions read `process.platform` to choose their POSIX rows. Every such
 * click therefore arrived here, found no command, and was swallowed by the
 * caller's `.catch(() => {})`: a rendered, underlined, entirely dead
 * affordance.
 *
 * A page has no desktop to hand a path to, but it does have somewhere a file
 * can be opened — the Files panel. So the event goes to the page and the
 * plugin that draws that panel answers it. If nothing is listening, the command
 * still succeeds: the path was opened as far as this deployment can open one,
 * and reporting failure would put the confusing half of the old behaviour back.
 */
tools['xdg-open'] = (context) => {
  const target = context.argv[1]
  if (target === undefined || target === '') {
    context.stderr.write('xdg-open: expects a path\n')
    return 2
  }
  if (!announceOpenPath(abs(context, target))) {
    context.stderr.write('xdg-open: there is no page to open a path in\n')
    return 1
  }
  return 0
}

/** Re-exported so the shell entry can register text helpers used by `strToU8`. */
export { strFromU8, strToU8 }
