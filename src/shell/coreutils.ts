/**
 * Coreutils implemented over the VFS. These are the commands an agent reaches
 * for constantly — `ls`, `cat`, `grep`, `sed`, `find`, `wc`, `head`, `sort` —
 * so they are implemented against the real option surface rather than a token
 * subset, and they report POSIX-shaped diagnostics and exit statuses.
 */

import { assertWritable, type CommandContext, type CommandImpl } from './runtime.ts'
import { basename, dirname, isAbsolute, resolve as resolvePath } from '../vfs/path.ts'
import { globToRegExp } from '../node/path.ts'
import { toBytes, toText } from '../node/binary.ts'
import type { Inode } from '../vfs/volume.ts'

/** Parse `-abc --long=value` style arguments into flags plus positionals. */
export interface ParsedArgs {
  /** Short flag letters present, e.g. `l` for `-l`. */
  flags: Set<string>
  /** Long options, `--name` → `''` or `--name=value` → `value`. */
  long: Map<string, string>
  /** Everything that is not an option. */
  operands: string[]
  /** Value of a short option that takes an argument (`-n 5` → `n` → `5`). */
  values: Map<string, string>
}

/**
 * Parse argv into flags and operands.
 * @param argv - the full argv including `argv[0]`.
 * @param withValue - short options that consume the next argument.
 * @returns the parsed arguments.
 */
export function parseArgs(argv: string[], withValue = ''): ParsedArgs {
  const flags = new Set<string>()
  const long = new Map<string, string>()
  const values = new Map<string, string>()
  const operands: string[] = []
  let optionsDone = false
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (optionsDone || token === '-' || !token.startsWith('-')) {
      operands.push(token)
      continue
    }
    if (token === '--') {
      optionsDone = true
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals === -1) long.set(token.slice(2), '')
      else long.set(token.slice(2, equals), token.slice(equals + 1))
      continue
    }
    for (let j = 1; j < token.length; j++) {
      const letter = token[j]
      if (withValue.includes(letter)) {
        const inline = token.slice(j + 1)
        values.set(letter, inline.length > 0 ? inline : argv[++i] ?? '')
        flags.add(letter)
        break
      }
      flags.add(letter)
    }
  }
  return { flags, long, operands, values }
}

/**
 * Resolve an operand that the command is about to WRITE, and refuse it when the
 * active sandbox policy forbids the location.
 * @param context - the running command.
 * @param path - the operand.
 * @returns the absolute path.
 * @throws when confinement denies the write.
 */
export function absWritable(context: CommandContext, path: string): string {
  const resolved = abs(context, path)
  assertWritable(context.shell, resolved)
  return resolved
}

/** Resolve an operand against the shell's cwd, expanding `~`. */
export function abs(context: CommandContext, path: string): string {
  if (path.startsWith('~')) {
    const home = context.shell.vars.get('HOME') ?? '/home/dsh'
    return path === '~' ? home : resolvePath(home, path.slice(2))
  }
  return isAbsolute(path) ? path : resolvePath(context.shell.cwd, path)
}

/** Read a file operand, or stdin when the operand list is empty or `-`. */
function readInput(context: CommandContext, operand?: string): string {
  if (operand === undefined || operand === '-') return context.stdin
  return toText(context.shell.volume.readFile(abs(context, operand)))
}

/** Emit a POSIX-style diagnostic and return the failure status. */
function fail(context: CommandContext, message: string, status = 1): number {
  context.stderr.write(`${context.argv[0]}: ${message}\n`)
  return status
}

/** Format a mode word the way `ls -l` does. */
function modeString(node: Inode): string {
  const type = node.kind === 'dir' ? 'd' : node.kind === 'link' ? 'l' : '-'
  const bits = node.mode & 0o777
  let out = type
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triple = (bits >> shift) & 0o7
    out += (triple & 4) !== 0 ? 'r' : '-'
    out += (triple & 2) !== 0 ? 'w' : '-'
    out += (triple & 1) !== 0 ? 'x' : '-'
  }
  return out
}

/** `ls -l` timestamp column. */
function timeString(mtime: number): string {
  const date = new Date(mtime)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = String(date.getDate()).padStart(2, ' ')
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${months[date.getMonth()]} ${day} ${time}`
}

/** Recursively walk a directory, yielding absolute paths depth-first. */
export function* walk(context: CommandContext, root: string, options: { includeSelf?: boolean, maxDepth?: number } = {}): Generator<{ path: string, node: Inode, depth: number }> {
  const { volume } = context.shell
  const start = volume.lookup(root, false)
  if (start === undefined) return
  if (options.includeSelf !== false) yield { path: root, node: start, depth: 0 }
  if (start.kind !== 'dir') return
  const stack: { path: string, depth: number }[] = [{ path: root, depth: 0 }]
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!
    if (options.maxDepth !== undefined && depth >= options.maxDepth) continue
    let entries: [string, Inode][]
    try {
      entries = volume.readdirNodes(path)
    } catch {
      continue
    }
    for (const [name, node] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      const child = path === '/' ? `/${name}` : `${path}/${name}`
      yield { path: child, node, depth: depth + 1 }
      if (node.kind === 'dir') stack.push({ path: child, depth: depth + 1 })
    }
  }
}

/** The registry every shell instance starts from. */
export const coreutils: Record<string, CommandImpl> = {

  ls(context) {
    const { flags, operands } = parseArgs(context.argv)
    const { volume } = context.shell
    const targets = operands.length > 0 ? operands : ['.']
    const long = flags.has('l')
    const all = flags.has('a') || flags.has('A')
    const recursive = flags.has('R')
    const one = flags.has('1') || long
    let status = 0
    const out: string[] = []

    const renderDirectory = (path: string, label?: string): void => {
      let entries: [string, Inode][]
      try {
        entries = volume.readdirNodes(path)
      } catch (error) {
        status = fail(context, `cannot access '${label ?? path}': ${(error as { code?: string }).code === 'ENOENT' ? 'No such file or directory' : 'Not a directory'}`)
        return
      }
      if (label !== undefined) out.push(`${label}:`)
      const visible = entries
        .filter(([name]) => all || !name.startsWith('.'))
        .sort(([a], [b]) => a.localeCompare(b))
      if (long) {
        out.push(`total ${String(visible.length)}`)
        for (const [name, node] of visible) {
          const size = node.kind === 'file' ? (node.content?.length ?? 0) : 4096
          out.push(`${modeString(node)} 1 dsh dsh ${String(size).padStart(8)} ${timeString(node.mtime)} ${name}${node.kind === 'dir' && flags.has('F') ? '/' : ''}`)
        }
      } else if (one) {
        for (const [name] of visible) out.push(name)
      } else {
        out.push(visible.map(([name]) => name).join('  '))
      }
      if (recursive) {
        for (const [name, node] of visible) {
          if (node.kind !== 'dir') continue
          out.push('')
          renderDirectory(path === '/' ? `/${name}` : `${path}/${name}`, label === undefined ? name : `${label}/${name}`)
        }
      }
    }

    for (const target of targets) {
      const path = abs(context, target)
      const node = volume.lookup(path, false)
      if (node === undefined) {
        status = fail(context, `cannot access '${target}': No such file or directory`)
        continue
      }
      if (node.kind !== 'dir') {
        out.push(long ? `${modeString(node)} 1 dsh dsh ${String(node.content?.length ?? 0).padStart(8)} ${timeString(node.mtime)} ${target}` : target)
        continue
      }
      renderDirectory(path, targets.length > 1 || recursive ? target : undefined)
    }
    const text = out.filter((line, index) => line.length > 0 || index !== out.length - 1).join('\n')
    if (text.length > 0) context.stdout.write(`${text}\n`)
    return status
  },

  cat(context) {
    const { flags, operands } = parseArgs(context.argv)
    let status = 0
    let lineNumber = 1
    const emit = (text: string): void => {
      if (!flags.has('n')) {
        context.stdout.write(text)
        return
      }
      const lines = text.split('\n')
      const trailing = lines[lines.length - 1] === ''
      if (trailing) lines.pop()
      for (const line of lines) context.stdout.write(`${String(lineNumber++).padStart(6)}\t${line}\n`)
    }
    if (operands.length === 0) {
      emit(context.stdin)
      return 0
    }
    for (const operand of operands) {
      if (operand === '-') {
        emit(context.stdin)
        continue
      }
      try {
        emit(toText(context.shell.volume.readFile(abs(context, operand))))
      } catch (error) {
        status = fail(context, `${operand}: ${(error as { code?: string }).code === 'EISDIR' ? 'Is a directory' : 'No such file or directory'}`)
      }
    }
    return status
  },

  mkdir(context) {
    const { flags, operands } = parseArgs(context.argv)
    let status = 0
    for (const operand of operands) {
      try {
        if (flags.has('p')) context.shell.volume.mkdirp(absWritable(context, operand))
        else context.shell.volume.mkdir(absWritable(context, operand))
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'EEXIST' && flags.has('p')) continue
        status = fail(context, `cannot create directory '${operand}': ${code === 'EEXIST' ? 'File exists' : 'No such file or directory'}`)
      }
    }
    return status
  },

  rmdir(context) {
    const { operands } = parseArgs(context.argv)
    let status = 0
    for (const operand of operands) {
      try {
        context.shell.volume.rmdir(absWritable(context, operand))
      } catch (error) {
        status = fail(context, `failed to remove '${operand}': ${(error as { code?: string }).code === 'ENOTEMPTY' ? 'Directory not empty' : 'No such file or directory'}`)
      }
    }
    return status
  },

  rm(context) {
    const { flags, operands } = parseArgs(context.argv)
    const recursive = flags.has('r') || flags.has('R')
    const force = flags.has('f')
    let status = 0
    for (const operand of operands) {
      try {
        context.shell.volume.rm(absWritable(context, operand), { recursive, force })
      } catch (error) {
        if (force) continue
        const code = (error as { code?: string }).code
        status = fail(context, `cannot remove '${operand}': ${code === 'EISDIR' ? 'Is a directory' : 'No such file or directory'}`)
      }
    }
    return status
  },

  cp(context) {
    const { flags, operands } = parseArgs(context.argv)
    const { volume } = context.shell
    if (operands.length < 2) return fail(context, 'missing destination file operand')
    const destination = operands[operands.length - 1]
    const sources = operands.slice(0, -1)
    const destinationPath = absWritable(context, destination)
    const destinationIsDir = volume.lookup(destinationPath)?.kind === 'dir'
    if (sources.length > 1 && !destinationIsDir) return fail(context, `target '${destination}' is not a directory`)
    let status = 0
    const copyOne = (from: string, to: string): void => {
      const node = volume.statNode(from, false)
      if (node.kind === 'dir') {
        if (!flags.has('r') && !flags.has('R') && !flags.has('a')) throw new Error('omitting directory')
        volume.mkdirp(to, node.mode)
        for (const name of volume.readdir(from)) copyOne(`${from}/${name}`, `${to}/${name}`)
        return
      }
      if (node.kind === 'link') {
        const target = volume.readlink(from)
        if (volume.exists(to)) volume.unlink(to)
        volume.symlink(target, to)
        return
      }
      volume.writeFile(to, volume.readFile(from).slice(), node.mode)
    }
    for (const source of sources) {
      const from = abs(context, source)
      const to = destinationIsDir ? `${destinationPath}/${basename(from)}` : destinationPath
      try {
        copyOne(from, to)
      } catch (error) {
        status = fail(context, `cannot copy '${source}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return status
  },

  mv(context) {
    const { operands } = parseArgs(context.argv)
    const { volume } = context.shell
    if (operands.length < 2) return fail(context, 'missing destination file operand')
    const destination = operands[operands.length - 1]
    const destinationPath = absWritable(context, destination)
    const destinationIsDir = volume.lookup(destinationPath)?.kind === 'dir'
    let status = 0
    for (const source of operands.slice(0, -1)) {
      const from = absWritable(context, source)
      const to = destinationIsDir ? `${destinationPath}/${basename(from)}` : destinationPath
      try {
        volume.rename(from, to)
      } catch (error) {
        status = fail(context, `cannot move '${source}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return status
  },

  touch(context) {
    const { operands } = parseArgs(context.argv)
    let status = 0
    for (const operand of operands) {
      const path = absWritable(context, operand)
      try {
        if (context.shell.volume.exists(path)) context.shell.volume.utimes(path, new Date(), new Date())
        else context.shell.volume.writeFile(path, new Uint8Array(0))
      } catch (error) {
        status = fail(context, `cannot touch '${operand}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return status
  },

  ln(context) {
    const { flags, operands } = parseArgs(context.argv)
    if (operands.length < 2) return fail(context, 'missing file operand')
    const [target, linkName] = operands
    try {
      const path = absWritable(context, linkName)
      if (flags.has('f') && context.shell.volume.exists(path)) context.shell.volume.unlink(path)
      if (flags.has('s')) context.shell.volume.symlink(target, path)
      else context.shell.volume.writeFile(path, context.shell.volume.readFile(abs(context, target)).slice())
      return 0
    } catch (error) {
      return fail(context, `cannot link: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  chmod(context) {
    const { operands } = parseArgs(context.argv)
    const [mode, ...paths] = operands
    const numeric = /^[0-7]{3,4}$/.test(mode) ? Number.parseInt(mode, 8) : undefined
    let status = 0
    for (const path of paths) {
      try {
        const absolute = absWritable(context, path)
        if (numeric !== undefined) {
          context.shell.volume.chmod(absolute, numeric)
        } else {
          // Symbolic form: only the `+x` / `-x` cases agents actually use.
          const node = context.shell.volume.statNode(absolute)
          const current = node.mode & 0o777
          if (mode.includes('+x')) context.shell.volume.chmod(absolute, current | 0o111)
          else if (mode.includes('-x')) context.shell.volume.chmod(absolute, current & ~0o111)
          else if (mode.includes('+w')) context.shell.volume.chmod(absolute, current | 0o222)
          else if (mode.includes('-w')) context.shell.volume.chmod(absolute, current & ~0o222)
        }
      } catch {
        status = fail(context, `cannot access '${path}': No such file or directory`)
      }
    }
    return status
  },

  stat(context) {
    const { operands } = parseArgs(context.argv)
    let status = 0
    for (const operand of operands) {
      try {
        const node = context.shell.volume.statNode(abs(context, operand), false)
        const size = node.kind === 'file' ? (node.content?.length ?? 0) : 4096
        context.stdout.write(`  File: ${operand}\n  Size: ${String(size)}\t${node.kind === 'dir' ? 'directory' : node.kind === 'link' ? 'symbolic link' : 'regular file'}\nAccess: (${(node.mode & 0o777).toString(8).padStart(4, '0')}/${modeString(node)})\nModify: ${new Date(node.mtime).toISOString()}\n`)
      } catch {
        status = fail(context, `cannot stat '${operand}': No such file or directory`)
      }
    }
    return status
  },

  head(context) {
    const { flags, operands, values } = parseArgs(context.argv, 'nc')
    const count = Number(values.get('n') ?? '10')
    const bytes = values.has('c') ? Number(values.get('c')) : undefined
    let status = 0
    const emit = (text: string, label?: string): void => {
      if (label !== undefined) context.stdout.write(`==> ${label} <==\n`)
      if (bytes !== undefined) {
        context.stdout.write(text.slice(0, bytes))
        return
      }
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      const selected = count >= 0 ? lines.slice(0, count) : lines.slice(0, Math.max(0, lines.length + count))
      if (selected.length > 0) context.stdout.write(`${selected.join('\n')}\n`)
    }
    if (operands.length === 0) {
      emit(context.stdin)
      return 0
    }
    for (const operand of operands) {
      try {
        emit(readInput(context, operand), operands.length > 1 && !flags.has('q') ? operand : undefined)
      } catch {
        status = fail(context, `cannot open '${operand}' for reading: No such file or directory`)
      }
    }
    return status
  },

  tail(context) {
    const { flags, operands, values } = parseArgs(context.argv, 'nc')
    const raw = values.get('n') ?? '10'
    const fromStart = raw.startsWith('+')
    const count = Math.abs(Number(raw.replace('+', '')))
    let status = 0
    const emit = (text: string, label?: string): void => {
      if (label !== undefined) context.stdout.write(`==> ${label} <==\n`)
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      const selected = fromStart ? lines.slice(count - 1) : lines.slice(Math.max(0, lines.length - count))
      if (selected.length > 0) context.stdout.write(`${selected.join('\n')}\n`)
    }
    if (flags.has('f')) context.stderr.write('tail: -f is not supported in the browser host\n')
    if (operands.length === 0) {
      emit(context.stdin)
      return 0
    }
    for (const operand of operands) {
      try {
        emit(readInput(context, operand), operands.length > 1 ? operand : undefined)
      } catch {
        status = fail(context, `cannot open '${operand}' for reading: No such file or directory`)
      }
    }
    return status
  },

  wc(context) {
    const { flags, operands } = parseArgs(context.argv)
    const showAll = !flags.has('l') && !flags.has('w') && !flags.has('c') && !flags.has('m')
    const totals = { lines: 0, words: 0, bytes: 0 }
    let status = 0
    const render = (text: string, label?: string): void => {
      const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
      const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
      const bytes = toBytes(text).length
      totals.lines += lines
      totals.words += words
      totals.bytes += bytes
      const columns: string[] = []
      if (showAll || flags.has('l')) columns.push(String(lines).padStart(7))
      if (showAll || flags.has('w')) columns.push(String(words).padStart(7))
      if (showAll || flags.has('c') || flags.has('m')) columns.push(String(flags.has('m') ? text.length : bytes).padStart(7))
      context.stdout.write(`${columns.join('')}${label === undefined ? '' : ` ${label}`}\n`)
    }
    if (operands.length === 0) {
      render(context.stdin)
      return 0
    }
    for (const operand of operands) {
      try {
        render(readInput(context, operand), operand)
      } catch {
        status = fail(context, `${operand}: No such file or directory`)
      }
    }
    if (operands.length > 1) {
      const columns: string[] = []
      if (showAll || flags.has('l')) columns.push(String(totals.lines).padStart(7))
      if (showAll || flags.has('w')) columns.push(String(totals.words).padStart(7))
      if (showAll || flags.has('c') || flags.has('m')) columns.push(String(totals.bytes).padStart(7))
      context.stdout.write(`${columns.join('')} total\n`)
    }
    return status
  },

  grep(context) {
    const { flags, operands, values, long } = parseArgs(context.argv, 'em')
    const pattern = values.get('e') ?? operands.shift() ?? ''
    const fixed = flags.has('F')
    const ignoreCase = flags.has('i')
    const invert = flags.has('v')
    const listFiles = flags.has('l')
    const countOnly = flags.has('c')
    const withNumbers = flags.has('n')
    const recursive = flags.has('r') || flags.has('R')
    const wholeWord = flags.has('w')
    const maxCount = values.has('m') ? Number(values.get('m')) : Infinity
    const source = fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
    let matcher: RegExp
    try {
      matcher = new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, ignoreCase ? 'i' : '')
    } catch (error) {
      return fail(context, `invalid pattern: ${error instanceof Error ? error.message : String(error)}`, 2)
    }
    const excludeDirs = new Set((long.get('exclude-dir') ?? '').split(',').filter(Boolean))
    let matched = false

    const searchText = (text: string, label?: string): number => {
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      let hits = 0
      for (let i = 0; i < lines.length && hits < maxCount; i++) {
        const isMatch = matcher.test(lines[i])
        if (isMatch === invert) continue
        hits++
        matched = true
        if (listFiles) return hits
        if (countOnly) continue
        const prefix = label === undefined ? '' : `${label}:`
        context.stdout.write(`${prefix}${withNumbers ? `${String(i + 1)}:` : ''}${lines[i]}\n`)
      }
      return hits
    }

    const targets: string[] = []
    if (recursive) {
      const roots = operands.length > 0 ? operands : ['.']
      for (const root of roots) {
        for (const entry of walk(context, abs(context, root))) {
          if (entry.node.kind !== 'file') continue
          if ([...excludeDirs].some(dir => entry.path.includes(`/${dir}/`))) continue
          targets.push(entry.path)
        }
      }
    } else {
      targets.push(...operands.map(operand => abs(context, operand)))
    }

    if (targets.length === 0) {
      searchText(context.stdin)
      return matched ? 0 : 1
    }

    const showLabel = targets.length > 1 || recursive || flags.has('H')
    for (const target of targets) {
      let text: string
      try {
        text = toText(context.shell.volume.readFile(target))
      } catch {
        continue
      }
      const relative = target.startsWith(`${context.shell.cwd}/`) ? target.slice(context.shell.cwd.length + 1) : target
      const hits = searchText(text, showLabel ? relative : undefined)
      if (listFiles && hits > 0) context.stdout.write(`${relative}\n`)
      else if (countOnly) context.stdout.write(`${showLabel ? `${relative}:` : ''}${String(hits)}\n`)
    }
    return matched ? 0 : 1
  },

  sed(context) {
    const { flags, operands, values } = parseArgs(context.argv, 'e')
    const scripts: string[] = []
    if (values.has('e')) scripts.push(values.get('e')!)
    if (scripts.length === 0 && operands.length > 0) scripts.push(operands.shift()!)
    const inPlace = flags.has('i')
    const quiet = flags.has('n')

    /** One compiled sed instruction. */
    type Instruction =
      | { kind: 'substitute', matcher: RegExp, replacement: string }
      | { kind: 'delete', matcher: RegExp | undefined, line?: number }
      | { kind: 'print', matcher: RegExp | undefined, line?: number }

    const instructions: Instruction[] = []
    for (const script of scripts.join(';').split(';')) {
      const trimmed = script.trim()
      if (trimmed.length === 0) continue
      const substitute = /^s(.)(.*)$/s.exec(trimmed)
      if (substitute !== null && trimmed.startsWith('s')) {
        const delimiter = substitute[1]
        const parts: string[] = []
        let buffer = ''
        for (let i = 0; i < substitute[2].length; i++) {
          const char = substitute[2][i]
          if (char === '\\' && substitute[2][i + 1] === delimiter) {
            buffer += delimiter
            i++
            continue
          }
          if (char === delimiter) {
            parts.push(buffer)
            buffer = ''
            continue
          }
          buffer += char
        }
        parts.push(buffer)
        const [search, replacement = '', modifiers = ''] = parts
        try {
          instructions.push({
            kind: 'substitute',
            matcher: new RegExp(search, modifiers.replace(/[^gimsu]/g, '')),
            replacement: replacement.replace(/\\(\d)/g, '$$$1').replace(/&/g, '$&'),
          })
        } catch (error) {
          return fail(context, `-e expression: ${error instanceof Error ? error.message : String(error)}`, 1)
        }
        continue
      }
      const deleteMatch = /^\/(.*)\/d$/.exec(trimmed)
      if (deleteMatch !== null) {
        instructions.push({ kind: 'delete', matcher: new RegExp(deleteMatch[1]) })
        continue
      }
      const deleteLine = /^(\d+)d$/.exec(trimmed)
      if (deleteLine !== null) {
        instructions.push({ kind: 'delete', matcher: undefined, line: Number(deleteLine[1]) })
        continue
      }
      const printMatch = /^\/(.*)\/p$/.exec(trimmed)
      if (printMatch !== null) {
        instructions.push({ kind: 'print', matcher: new RegExp(printMatch[1]) })
        continue
      }
      const printLine = /^(\d+)p$/.exec(trimmed)
      if (printLine !== null) {
        instructions.push({ kind: 'print', matcher: undefined, line: Number(printLine[1]) })
        continue
      }
      return fail(context, `unknown command: '${trimmed}'`, 1)
    }

    const transform = (text: string): string => {
      const lines = text.split('\n')
      const hadTrailing = lines[lines.length - 1] === ''
      if (hadTrailing) lines.pop()
      const out: string[] = []
      lines.forEach((line, index) => {
        let current = line
        let deleted = false
        let printed = false
        for (const instruction of instructions) {
          if (instruction.kind === 'substitute') {
            current = current.replace(instruction.matcher, instruction.replacement)
            continue
          }
          const applies = instruction.line !== undefined ? instruction.line === index + 1 : instruction.matcher!.test(current)
          if (!applies) continue
          if (instruction.kind === 'delete') deleted = true
          else printed = true
        }
        if (deleted) return
        if (quiet) {
          if (printed) out.push(current)
          return
        }
        out.push(current)
        if (printed) out.push(current)
      })
      return out.length === 0 ? '' : `${out.join('\n')}\n`
    }

    if (operands.length === 0) {
      context.stdout.write(transform(context.stdin))
      return 0
    }
    let status = 0
    for (const operand of operands) {
      const path = inPlace ? absWritable(context, operand) : abs(context, operand)
      try {
        const result = transform(toText(context.shell.volume.readFile(path)))
        if (inPlace) context.shell.volume.writeFile(path, toBytes(result))
        else context.stdout.write(result)
      } catch {
        status = fail(context, `can't read ${operand}: No such file or directory`)
      }
    }
    return status
  },

  find(context) {
    const { operands } = parseArgs(context.argv)
    const { volume } = context.shell
    // Split roots from the expression at the first predicate token.
    const roots: string[] = []
    let i = 0
    while (i < operands.length && !operands[i].startsWith('-') && operands[i] !== '!' && operands[i] !== '(') {
      roots.push(operands[i++])
    }
    if (roots.length === 0) roots.push('.')
    const expression = operands.slice(i)

    let namePattern: RegExp | undefined
    let iNamePattern: RegExp | undefined
    let pathPattern: RegExp | undefined
    let typeFilter: string | undefined
    let maxDepth = Infinity
    let minDepth = 0
    let printZero = false
    const notNames: RegExp[] = []
    for (let j = 0; j < expression.length; j++) {
      const token = expression[j]
      if (token === '-name') namePattern = globToRegExp(expression[++j])
      else if (token === '-iname') iNamePattern = new RegExp(globToRegExp(expression[++j]).source, 'i')
      else if (token === '-path' || token === '-wholename') pathPattern = globToRegExp(expression[++j])
      else if (token === '-type') typeFilter = expression[++j]
      else if (token === '-maxdepth') maxDepth = Number(expression[++j])
      else if (token === '-mindepth') minDepth = Number(expression[++j])
      else if (token === '-print0') printZero = true
      else if (token === '!' && expression[j + 1] === '-name') {
        j += 2
        notNames.push(globToRegExp(expression[j]))
      }
    }

    const separator = printZero ? '\0' : '\n'
    let status = 0
    for (const root of roots) {
      const rootPath = abs(context, root)
      if (!volume.exists(rootPath)) {
        status = fail(context, `'${root}': No such file or directory`)
        continue
      }
      for (const entry of walk(context, rootPath)) {
        if (entry.depth > maxDepth || entry.depth < minDepth) continue
        const name = basename(entry.path)
        if (namePattern !== undefined && !namePattern.test(name)) continue
        if (iNamePattern !== undefined && !iNamePattern.test(name)) continue
        if (pathPattern !== undefined && !pathPattern.test(entry.path)) continue
        if (notNames.some(pattern => pattern.test(name))) continue
        if (typeFilter === 'f' && entry.node.kind !== 'file') continue
        if (typeFilter === 'd' && entry.node.kind !== 'dir') continue
        if (typeFilter === 'l' && entry.node.kind !== 'link') continue
        const display = root === '.' && entry.path.startsWith(context.shell.cwd)
          ? `.${entry.path.slice(context.shell.cwd.length)}`
          : entry.path
        context.stdout.write(`${display}${separator}`)
      }
    }
    return status
  },

  sort(context) {
    const { flags, operands, values } = parseArgs(context.argv, 'k')
    const text = operands.length > 0
      ? operands.map(operand => readInput(context, operand)).join('')
      : context.stdin
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const column = values.has('k') ? Number(values.get('k')!.split(',')[0]) - 1 : undefined
    const key = (line: string): string => (column === undefined ? line : (line.split(/\s+/)[column] ?? ''))
    lines.sort((a, b) => {
      const left = key(a)
      const right = key(b)
      if (flags.has('n')) return (Number.parseFloat(left) || 0) - (Number.parseFloat(right) || 0)
      return left.localeCompare(right)
    })
    if (flags.has('r')) lines.reverse()
    const output = flags.has('u') ? lines.filter((line, index) => index === 0 || line !== lines[index - 1]) : lines
    if (output.length > 0) context.stdout.write(`${output.join('\n')}\n`)
    return 0
  },

  uniq(context) {
    const { flags, operands } = parseArgs(context.argv)
    const text = operands.length > 0 ? readInput(context, operands[0]) : context.stdin
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const groups: { value: string, count: number }[] = []
    for (const line of lines) {
      const last = groups[groups.length - 1]
      if (last !== undefined && last.value === line) last.count++
      else groups.push({ value: line, count: 1 })
    }
    const selected = flags.has('d') ? groups.filter(group => group.count > 1) : flags.has('u') ? groups.filter(group => group.count === 1) : groups
    const rendered = selected.map(group => (flags.has('c') ? `${String(group.count).padStart(7)} ${group.value}` : group.value))
    if (rendered.length > 0) context.stdout.write(`${rendered.join('\n')}\n`)
    return 0
  },

  cut(context) {
    const { operands, values } = parseArgs(context.argv, 'df')
    const delimiter = values.get('d') ?? '\t'
    const fieldSpec = values.get('f') ?? '1'
    const fields = new Set<number>()
    for (const range of fieldSpec.split(',')) {
      const [from, to] = range.split('-')
      if (to === undefined) fields.add(Number(from))
      else for (let i = Number(from); i <= Number(to || '99'); i++) fields.add(i)
    }
    const text = operands.length > 0 ? readInput(context, operands[0]) : context.stdin
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const out = lines.map((line) => {
      const parts = line.split(delimiter)
      return parts.filter((_part, index) => fields.has(index + 1)).join(delimiter)
    })
    if (out.length > 0) context.stdout.write(`${out.join('\n')}\n`)
    return 0
  },

  tr(context) {
    const { flags, operands } = parseArgs(context.argv)
    const [from = '', to = ''] = operands
    /**
     * Expand a SET operand: backslash escapes first (`tr` interprets them
     * itself, which is why `tr " " "\n"` works from a double-quoted shell
     * word), then character ranges, then the named classes agents use.
     */
    const expand = (spec: string): string => {
      const escaped = spec
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
        .replace(/\\0/g, '\0').replace(/\\\\/g, '\\')
        .replace(/\[:alpha:\]/g, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
        .replace(/\[:digit:\]/g, '0123456789')
        .replace(/\[:lower:\]/g, 'abcdefghijklmnopqrstuvwxyz')
        .replace(/\[:upper:\]/g, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        .replace(/\[:space:\]/g, ' \t\n\r\f\v')
      return escaped.replace(/(\w)-(\w)/g, (_match, start: string, end: string) => {
        let out = ''
        for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code++) out += String.fromCharCode(code)
        return out
      })
    }
    const source = expand(from)
    const target = expand(to)
    let text = context.stdin
    if (flags.has('d')) {
      text = [...text].filter(char => !source.includes(char)).join('')
    } else if (flags.has('s')) {
      text = text.replace(new RegExp(`([${source.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}])\\1+`, 'g'), '$1')
    } else {
      text = [...text].map((char) => {
        const index = source.indexOf(char)
        if (index === -1) return char
        return target[Math.min(index, target.length - 1)] ?? char
      }).join('')
    }
    context.stdout.write(text)
    return 0
  },

  rev(context) {
    const lines = context.stdin.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    context.stdout.write(lines.map(line => [...line].reverse().join('')).join('\n'))
    if (lines.length > 0) context.stdout.write('\n')
    return 0
  },

  tee(context) {
    const { flags, operands } = parseArgs(context.argv)
    context.stdout.write(context.stdin)
    for (const operand of operands) {
      const path = absWritable(context, operand)
      try {
        context.shell.volume.mkdirp(dirname(path))
        if (flags.has('a')) context.shell.volume.appendFile(path, toBytes(context.stdin))
        else context.shell.volume.writeFile(path, toBytes(context.stdin))
      } catch (error) {
        return fail(context, `${operand}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return 0
  },

  nl(context) {
    const lines = context.stdin.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    lines.forEach((line, index) => { context.stdout.write(`${String(index + 1).padStart(6)}\t${line}\n`) })
    return 0
  },

  basename(context) {
    const { operands } = parseArgs(context.argv)
    context.stdout.write(`${basename(operands[0] ?? '', operands[1])}\n`)
    return 0
  },

  dirname(context) {
    const { operands } = parseArgs(context.argv)
    context.stdout.write(`${dirname(operands[0] ?? '')}\n`)
    return 0
  },

  realpath(context) {
    const { operands } = parseArgs(context.argv)
    let status = 0
    for (const operand of operands) {
      try {
        context.stdout.write(`${context.shell.volume.realpath(abs(context, operand))}\n`)
      } catch {
        status = fail(context, `${operand}: No such file or directory`)
      }
    }
    return status
  },

  readlink(context) {
    const { flags, operands } = parseArgs(context.argv)
    try {
      const path = abs(context, operands[0] ?? '')
      context.stdout.write(`${flags.has('f') ? context.shell.volume.realpath(path) : context.shell.volume.readlink(path)}\n`)
      return 0
    } catch {
      return 1
    }
  },

  du(context) {
    const { flags, operands } = parseArgs(context.argv)
    const roots = operands.length > 0 ? operands : ['.']
    for (const root of roots) {
      let total = 0
      for (const entry of walk(context, abs(context, root))) {
        if (entry.node.kind === 'file') total += entry.node.content?.length ?? 0
      }
      const blocks = flags.has('h') ? formatSize(total) : String(Math.ceil(total / 1024))
      context.stdout.write(`${blocks}\t${root}\n`)
    }
    return 0
  },

  df(context) {
    context.stdout.write('Filesystem     1K-blocks      Used Available Use% Mounted on\ndsh-vfs          1048576         0   1048576   0% /\n')
    return 0
  },

  xargs(context) {
    // Handled by the interpreter would need re-entrancy; the registry form
    // collects arguments and re-dispatches through the shell's command table.
    return fail(context, 'xargs is provided by the shell wrapper', 1)
  },

  seq(context) {
    const { operands } = parseArgs(context.argv)
    const numbers = operands.map(Number)
    const [first = 1, second, third] = numbers
    const start = numbers.length === 1 ? 1 : first
    const step = numbers.length === 3 ? second : 1
    const end = numbers.length === 1 ? first : numbers.length === 3 ? third : second
    if (step === 0) return fail(context, 'increment must not be zero')
    const out: string[] = []
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) out.push(String(value))
    if (out.length > 0) context.stdout.write(`${out.join('\n')}\n`)
    return 0
  },

  yes(context) {
    const { operands } = parseArgs(context.argv)
    const text = operands.length > 0 ? operands.join(' ') : 'y'
    // Bounded: the browser host cannot afford a truly infinite producer.
    for (let i = 0; i < 10000; i++) context.stdout.write(`${text}\n`)
    return 0
  },

  env(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length > 0) return fail(context, 'running a command through env is handled by the shell', 1)
    for (const name of [...context.shell.exported].sort()) {
      context.stdout.write(`${name}=${context.shell.vars.get(name) ?? ''}\n`)
    }
    return 0
  },

  printenv(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length === 0) return coreutils.env(context) as number
    for (const name of operands) context.stdout.write(`${context.shell.vars.get(name) ?? ''}\n`)
    return 0
  },

  which(context) {
    const { operands } = parseArgs(context.argv)
    let status = 0
    for (const name of operands) {
      if (context.shell.commands.has(name)) context.stdout.write(`/usr/bin/${name}\n`)
      else status = 1
    }
    return status
  },

  async sleep(context) {
    const { operands } = parseArgs(context.argv)
    const seconds = Number.parseFloat(operands[0] ?? '0')
    if (Number.isNaN(seconds)) return fail(context, `invalid time interval '${operands[0] ?? ''}'`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(seconds * 1000, 120_000))
      context.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('interrupted'))
      }, { once: true })
    })
    return 0
  },

  date(context) {
    const { operands } = parseArgs(context.argv)
    const now = new Date()
    const format = operands.find(operand => operand.startsWith('+'))
    if (format === undefined) {
      context.stdout.write(`${now.toString()}\n`)
      return 0
    }
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
    const rendered = format.slice(1)
      .replace(/%Y/g, String(now.getFullYear()))
      .replace(/%m/g, pad(now.getMonth() + 1))
      .replace(/%d/g, pad(now.getDate()))
      .replace(/%H/g, pad(now.getHours()))
      .replace(/%M/g, pad(now.getMinutes()))
      .replace(/%S/g, pad(now.getSeconds()))
      .replace(/%s/g, String(Math.floor(now.getTime() / 1000)))
      .replace(/%F/g, `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
      .replace(/%T/g, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`)
    context.stdout.write(`${rendered}\n`)
    return 0
  },

  uname(context) {
    const { flags } = parseArgs(context.argv)
    if (flags.has('a')) context.stdout.write('Linux dsh-web 6.0.0-dsh-web #1 SMP wasm32 GNU/Linux\n')
    else if (flags.has('m')) context.stdout.write('wasm32\n')
    else if (flags.has('r')) context.stdout.write('6.0.0-dsh-web\n')
    else context.stdout.write('Linux\n')
    return 0
  },

  whoami(context) {
    context.stdout.write(`${context.shell.vars.get('USER') ?? 'dsh'}\n`)
    return 0
  },

  id(context) {
    context.stdout.write('uid=1000(dsh) gid=1000(dsh) groups=1000(dsh)\n')
    return 0
  },

  hostname(context) {
    context.stdout.write('dsh-web\n')
    return 0
  },

  ps(context) {
    context.stdout.write('  PID TTY          TIME CMD\n    1 ?        00:00:00 dsh\n')
    return 0
  },

  clear(context) {
    context.stdout.write('[2J[H')
    return 0
  },

  test: testCommand,
  '[': testCommand,

  expr(context) {
    const { operands } = parseArgs(context.argv)
    const expression = operands.join(' ')
    if (!/^[-+*/%()\d\s<>=!&|]*$/.test(expression)) {
      context.stdout.write('0\n')
      return 1
    }
    try {
      // eslint-disable-next-line no-new-func
      const value = new Function(`"use strict";return (${expression})`)() as number
      context.stdout.write(`${String(Math.trunc(Number(value)))}\n`)
      return value === 0 ? 1 : 0
    } catch {
      return 2
    }
  },

  diff(context) {
    const { operands } = parseArgs(context.argv)
    if (operands.length < 2) return fail(context, 'missing operand', 2)
    let left: string[]
    let right: string[]
    try {
      left = readInput(context, operands[0]).split('\n')
      right = readInput(context, operands[1]).split('\n')
    } catch {
      return fail(context, 'cannot read input', 2)
    }
    // Longest-common-subsequence diff, rendered in the classic `Nc M` form.
    const lcs: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    let differs = false
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        i++
        j++
        continue
      }
      differs = true
      if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        context.stdout.write(`${String(i + 1)}d${String(j)}\n< ${left[i]}\n`)
        i++
      } else {
        context.stdout.write(`${String(i)}a${String(j + 1)}\n> ${right[j]}\n`)
        j++
      }
    }
    for (; i < left.length; i++) {
      differs = true
      context.stdout.write(`${String(i + 1)}d${String(j)}\n< ${left[i]}\n`)
    }
    for (; j < right.length; j++) {
      differs = true
      context.stdout.write(`${String(i)}a${String(j + 1)}\n> ${right[j]}\n`)
    }
    return differs ? 1 : 0
  },
}

/** `test` / `[` — the file, string, and numeric predicates. */
function testCommand(context: CommandContext): number {
  const args = context.argv.slice(1)
  if (context.argv[0] === '[' && args[args.length - 1] === ']') args.pop()
  const { volume } = context.shell
  const truthy = (value: boolean): number => (value ? 0 : 1)

  const evaluate = (tokens: string[]): boolean => {
    if (tokens.length === 0) return false
    if (tokens[0] === '!') return !evaluate(tokens.slice(1))
    const or = tokens.indexOf('-o')
    if (or !== -1) return evaluate(tokens.slice(0, or)) || evaluate(tokens.slice(or + 1))
    const and = tokens.indexOf('-a')
    if (and !== -1) return evaluate(tokens.slice(0, and)) && evaluate(tokens.slice(and + 1))
    if (tokens.length === 1) return tokens[0].length > 0
    if (tokens.length === 2) {
      const [operator, operand] = tokens
      const path = abs(context, operand)
      switch (operator) {
        case '-e': return volume.exists(path)
        case '-f': return volume.lookup(path)?.kind === 'file'
        case '-d': return volume.lookup(path)?.kind === 'dir'
        case '-L': case '-h': return volume.lookup(path, false)?.kind === 'link'
        case '-s': return (volume.lookup(path)?.content?.length ?? 0) > 0
        case '-r': case '-w': return volume.exists(path)
        case '-x': return ((volume.lookup(path)?.mode ?? 0) & 0o111) !== 0
        case '-z': return operand.length === 0
        case '-n': return operand.length > 0
        default: return false
      }
    }
    const [left, operator, right] = tokens
    switch (operator) {
      case '=': case '==': return left === right
      case '!=': return left !== right
      case '<': return left < right
      case '>': return left > right
      case '-eq': return Number(left) === Number(right)
      case '-ne': return Number(left) !== Number(right)
      case '-lt': return Number(left) < Number(right)
      case '-le': return Number(left) <= Number(right)
      case '-gt': return Number(left) > Number(right)
      case '-ge': return Number(left) >= Number(right)
      case '-nt': return (volume.lookup(abs(context, left))?.mtime ?? 0) > (volume.lookup(abs(context, right))?.mtime ?? 0)
      case '-ot': return (volume.lookup(abs(context, left))?.mtime ?? 0) < (volume.lookup(abs(context, right))?.mtime ?? 0)
      default: return false
    }
  }

  try {
    return truthy(evaluate(args))
  } catch {
    return 2
  }
}

/** Human-readable byte size (`du -h`). */
export function formatSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${String(value)}${units[unit]}` : `${value.toFixed(1)}${units[unit]}`
}
