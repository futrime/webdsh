/**
 * `rg` — enough of ripgrep to be the search tool's backend.
 *
 * `dsh-tool-fs-search` does not shell out to a grep; it spawns the ripgrep
 * binary that `@vscode/ripgrep` ships and parses its output. A page cannot run
 * that binary, so without a replacement both of the agent's search tools fail
 * on every call — and they fail at the first tool call rather than at boot,
 * which is why a composition that mounts cleanly can still be unusable.
 *
 * The tool builds exactly two argument vectors, so those two are what this
 * implements faithfully:
 *
 * - `--files --glob=<pattern> --sort=modified --no-ignore --hidden …` for
 *   `glob`, answering with one path per line.
 * - `--json --regexp=<pattern> [--glob=<include>] [-- <path>]` for `grep`,
 *   answering with ripgrep's JSON Lines records.
 *
 * Everything else it accepts is there because an agent also types `rg` by hand
 * at the shell, where ripgrep's ordinary human-facing flags are what it reaches
 * for. Exit status follows ripgrep: 0 when something matched, 1 when nothing
 * did, 2 for a usage or pattern error.
 */

import type { CommandContext } from './runtime.ts'
import { globToRegExp } from '../node/path.ts'
import { toText } from '../node/binary.ts'

/** Directories never worth walking, matching ripgrep's practical defaults. */
const ALWAYS_SKIP = new Set(['.git'])

/** One `--glob` filter: a matcher plus whether it excludes. */
interface GlobFilter {
  matcher: RegExp
  negated: boolean
  /** A pattern without a slash matches the basename at any depth, as ripgrep does. */
  basenameOnly: boolean
}

/** Parsed `rg` invocation. */
interface Invocation {
  patterns: string[]
  paths: string[]
  globs: GlobFilter[]
  listFiles: boolean
  json: boolean
  sortModified: boolean
  ignoreCase: boolean
  fixedStrings: boolean
  wholeWord: boolean
  filesWithMatches: boolean
  count: boolean
  noHeading: boolean
  maxCount: number
  error?: string
}

/** Compile one `--glob` value into a filter. */
function toFilter(pattern: string): GlobFilter {
  const negated = pattern.startsWith('!')
  const body = negated ? pattern.slice(1) : pattern
  return { matcher: globToRegExp(body), negated, basenameOnly: !body.includes('/') }
}

/**
 * Parse ripgrep's argument vector.
 *
 * ripgrep accepts both `--flag=value` and `--flag value`; the search tool emits
 * the first form and a person types either.
 * @param argv - the full argv, including `argv[0]`.
 * @returns the parsed invocation.
 */
function parse(argv: string[]): Invocation {
  const out: Invocation = {
    patterns: [], paths: [], globs: [],
    listFiles: false, json: false, sortModified: false,
    ignoreCase: false, fixedStrings: false, wholeWord: false,
    filesWithMatches: false, count: false, noHeading: false,
    maxCount: Infinity,
  }
  let sawSeparator = false
  const rest = argv.slice(1)

  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]
    if (sawSeparator) { out.paths.push(argument); continue }
    if (argument === '--') { sawSeparator = true; continue }

    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
      const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1)
      const take = (): string => inlineValue ?? rest[++i] ?? ''
      switch (name) {
        case 'files': out.listFiles = true; break
        case 'json': out.json = true; break
        case 'glob': out.globs.push(toFilter(take())); break
        case 'regexp': out.patterns.push(take()); break
        case 'sort': out.sortModified = take() === 'modified'; break
        case 'sortr': out.sortModified = take() === 'modified'; break
        case 'max-count': out.maxCount = Number(take()); break
        case 'ignore-case': out.ignoreCase = true; break
        case 'fixed-strings': out.fixedStrings = true; break
        case 'word-regexp': out.wholeWord = true; break
        case 'files-with-matches': out.filesWithMatches = true; break
        case 'count': out.count = true; break
        case 'no-heading': out.noHeading = true; break
        // Accepted and irrelevant here: there is no config file, no ignore
        // file support, and every file in the VFS is already visible.
        case 'no-config': case 'no-ignore': case 'hidden': case 'follow':
        case 'no-messages': case 'line-number': case 'with-filename':
        case 'color': case 'colors': case 'no-ignore-vcs': case 'smart-case':
          if (name === 'color' || name === 'colors') take()
          break
        default:
          // An unknown long flag is likelier to change meaning than to be
          // ignorable, so say so rather than silently searching differently.
          out.error = `unrecognized flag --${name}`
          return out
      }
      continue
    }

    if (argument.startsWith('-') && argument.length > 1) {
      for (const letter of argument.slice(1)) {
        switch (letter) {
          case 'i': out.ignoreCase = true; break
          case 'F': out.fixedStrings = true; break
          case 'w': out.wholeWord = true; break
          case 'l': out.filesWithMatches = true; break
          case 'c': out.count = true; break
          case 'n': break
          case 'e': out.patterns.push(rest[++i] ?? ''); break
          case 'g': out.globs.push(toFilter(rest[++i] ?? '')); break
          default: out.error = `unrecognized flag -${letter}`; return out
        }
      }
      continue
    }

    // The first bare operand is the pattern unless one arrived via --regexp.
    if (out.patterns.length === 0 && !out.listFiles) out.patterns.push(argument)
    else out.paths.push(argument)
  }
  return out
}

/** Whether a path relative to the search root passes the `--glob` filters. */
function included(relative: string, globs: GlobFilter[]): boolean {
  const basename = relative.slice(relative.lastIndexOf('/') + 1)
  let allowed = !globs.some(glob => !glob.negated)
  for (const glob of globs) {
    const subject = glob.basenameOnly ? basename : relative
    if (!glob.matcher.test(subject)) continue
    if (glob.negated) return false
    allowed = true
  }
  return allowed
}

/** One file the walk found. */
interface Found {
  /** Path as ripgrep would print it. */
  display: string
  /** Absolute path for reading. */
  absolute: string
  /** Modification time, for `--sort=modified`. */
  mtime: number
}

/**
 * Walk a search root, yielding the files that pass the glob filters.
 * @param context - the command context, for the volume.
 * @param root - absolute directory (or file) to walk.
 * @param prefix - what to prepend to results, matching how ripgrep echoes the
 *   search root the caller named.
 * @param globs - the compiled filters.
 * @returns the matching files.
 */
function walk(context: CommandContext, root: string, prefix: string, globs: GlobFilter[]): Found[] {
  const volume = context.shell.volume
  const found: Found[] = []
  const visit = (absolute: string, relative: string): void => {
    let node
    try {
      node = volume.statNode(absolute, true)
    } catch {
      return
    }
    if (node.kind === 'dir') {
      let names: string[]
      try {
        names = volume.readdir(absolute)
      } catch {
        return
      }
      for (const name of names.sort()) {
        if (ALWAYS_SKIP.has(name)) continue
        visit(`${absolute}/${name}`, relative === '' ? name : `${relative}/${name}`)
      }
      return
    }
    if (node.kind !== 'file') return
    if (!included(relative, globs)) return
    found.push({
      display: prefix === '' ? relative : `${prefix}/${relative}`,
      absolute,
      mtime: node.mtime,
    })
  }

  let rootNode
  try {
    rootNode = volume.statNode(root, true)
  } catch {
    return found
  }
  if (rootNode.kind === 'file') {
    const name = root.slice(root.lastIndexOf('/') + 1)
    if (included(name, globs)) found.push({ display: prefix === '' ? name : prefix, absolute: root, mtime: rootNode.mtime })
    return found
  }
  visit(root, '')
  return found
}

/** Resolve a search root against the shell's cwd, keeping how it was spelled. */
function resolveRoot(context: CommandContext, spelled: string): { absolute: string, prefix: string } {
  if (spelled.startsWith('/')) return { absolute: spelled.replace(/\/+$/, '') || '/', prefix: spelled.replace(/\/+$/, '') }
  const cleaned = spelled.replace(/\/+$/, '')
  const absolute = cleaned === '.' || cleaned === ''
    ? context.shell.cwd
    : `${context.shell.cwd}/${cleaned}`.replace(/\/+/g, '/')
  return { absolute, prefix: cleaned === '.' || cleaned === '' ? '' : cleaned }
}

/** Build the match regex, honoring `-F`, `-i`, and `-w`. */
function compile(invocation: Invocation): RegExp {
  const source = invocation.patterns
    .map(pattern => (invocation.fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern))
    .map(pattern => (invocation.wholeWord ? `\\b(?:${pattern})\\b` : pattern))
    .join('|')
  return new RegExp(source, invocation.ignoreCase ? 'gi' : 'g')
}

/**
 * `rg`.
 * @param context - the command context.
 * @returns ripgrep's exit status.
 */
export function ripgrep(context: CommandContext): number {
  const invocation = parse(context.argv)
  if (invocation.error !== undefined) {
    context.stderr.write(`rg: ${invocation.error}\n`)
    return 2
  }

  const roots = invocation.paths.length > 0 ? invocation.paths : ['.']
  const files: Found[] = []
  for (const spelled of roots) {
    const { absolute, prefix } = resolveRoot(context, spelled)
    files.push(...walk(context, absolute, prefix, invocation.globs))
  }
  if (invocation.sortModified) files.sort((a, b) => a.mtime - b.mtime)

  if (invocation.listFiles) {
    for (const file of files) context.stdout.write(`${file.display}\n`)
    return files.length > 0 ? 0 : 1
  }

  if (invocation.patterns.length === 0) {
    context.stderr.write('rg: no pattern given\n')
    return 2
  }
  let matcher: RegExp
  try {
    matcher = compile(invocation)
  } catch (error) {
    context.stderr.write(`rg: invalid pattern: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  let total = 0
  for (const file of files) {
    let text: string
    try {
      text = toText(context.shell.volume.readFile(file.absolute))
    } catch {
      continue
    }
    // A binary file is not worth reporting line matches from, and ripgrep skips
    // it by default; the NUL probe is the same heuristic it uses.
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    let fileHits = 0
    for (let index = 0; index < lines.length && fileHits < invocation.maxCount; index++) {
      matcher.lastIndex = 0
      if (!matcher.test(lines[index])) continue
      fileHits++
      total++
      if (invocation.filesWithMatches || invocation.count) continue
      if (invocation.json) {
        context.stdout.write(`${JSON.stringify({
          type: 'match',
          data: {
            path: { text: file.display },
            lines: { text: `${lines[index]}\n` },
            line_number: index + 1,
            absolute_offset: 0,
            submatches: [],
          },
        })}\n`)
      } else {
        context.stdout.write(`${file.display}:${String(index + 1)}:${lines[index]}\n`)
      }
    }
    if (fileHits === 0) continue
    if (invocation.filesWithMatches) context.stdout.write(`${file.display}\n`)
    else if (invocation.count) context.stdout.write(`${file.display}:${String(fileHits)}\n`)
  }
  return total > 0 ? 0 : 1
}
