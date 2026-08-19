/**
 * `rg`, over the runtime's filesystem.
 *
 * The agent's `grep` and `glob` tools do not shell out to a grep: they spawn
 * the ripgrep binary `@vscode/ripgrep` resolves and parse its output. The
 * runtime is Node, not a Linux distribution, so there is no such binary — and
 * without one both tools fail on every call, which is the sort of thing that
 * looks fine at boot and makes the agent useless at the first search.
 *
 * So the two argument vectors those tools build are implemented here, against
 * the runtime's own filesystem:
 *
 * - `--files --glob=<pattern> --sort=modified …` for `glob`, answering with one
 *   path per line.
 * - `--json --regexp=<pattern> [--glob=<include>] [-- <path>]` for `grep`,
 *   answering with ripgrep's JSON Lines `match` records.
 *
 * Exit status follows ripgrep, where 1 means "no matches" rather than failure —
 * the difference between an empty result and a broken tool.
 */

import { HARNESS_DIR, runtimeFs, toContainerPath, WORKSPACE } from './webcontainer.ts'
import { globToRegExp } from '../node/path.ts'

/** Directories never worth walking. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', HARNESS_DIR])

/** One `--glob` filter. */
interface GlobFilter {
  matcher: RegExp
  negated: boolean
  /** A pattern without a slash matches the basename at any depth, as ripgrep does. */
  basenameOnly: boolean
}

/** Compile one `--glob` value. */
function toFilter(pattern: string): GlobFilter {
  const negated = pattern.startsWith('!')
  const body = negated ? pattern.slice(1) : pattern
  return { matcher: globToRegExp(body), negated, basenameOnly: !body.includes('/') }
}

/** Whether a path relative to the search root passes the filters. */
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

/** A parsed invocation, restricted to what the search tools emit. */
interface Invocation {
  patterns: string[]
  paths: string[]
  globs: GlobFilter[]
  listFiles: boolean
  json: boolean
  ignoreCase: boolean
  fixedStrings: boolean
}

/** Parse ripgrep's argument vector. */
function parse(argv: string[]): Invocation {
  const out: Invocation = {
    patterns: [], paths: [], globs: [], listFiles: false, json: false, ignoreCase: false, fixedStrings: false,
  }
  let separated = false
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]
    if (separated) { out.paths.push(argument); continue }
    if (argument === '--') { separated = true; continue }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
      const value = equals === -1 ? argv[i + 1] ?? '' : argument.slice(equals + 1)
      if (equals === -1 && ['glob', 'regexp', 'sort', 'sortr', 'max-count'].includes(name)) i++
      switch (name) {
        case 'files': out.listFiles = true; break
        case 'json': out.json = true; break
        case 'glob': out.globs.push(toFilter(value)); break
        case 'regexp': out.patterns.push(value); break
        case 'ignore-case': out.ignoreCase = true; break
        case 'fixed-strings': out.fixedStrings = true; break
        default: break
      }
      continue
    }
    if (argument.startsWith('-') && argument.length > 1) {
      for (const letter of argument.slice(1)) {
        if (letter === 'i') out.ignoreCase = true
        else if (letter === 'F') out.fixedStrings = true
        else if (letter === 'e') out.patterns.push(argv[++i] ?? '')
      }
      continue
    }
    if (out.patterns.length === 0 && !out.listFiles) out.patterns.push(argument)
    else out.paths.push(argument)
  }
  return out
}

/** A file the walk found. */
interface Found {
  /** Path as ripgrep would print it. */
  display: string
  /** Absolute path, for reading. */
  absolute: string
}

/**
 * Walk a search root, yielding files that pass the glob filters.
 * @param root - absolute directory to walk.
 * @param prefix - what to prepend to results, echoing how the caller named the root.
 * @param globs - the compiled filters.
 * @returns the matching files.
 */
async function walk(root: string, prefix: string, globs: GlobFilter[]): Promise<Found[]> {
  const fs = await runtimeFs()
  const found: Found[] = []
  const visit = async (absolute: string, relative: string): Promise<void> => {
    let entries: { name: string, isDirectory(): boolean }[]
    try {
      entries = await fs.readdir(toContainerPath(absolute), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue
      const child = `${absolute}/${entry.name}`
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(child, name)
        continue
      }
      if (!included(name, globs)) continue
      found.push({ display: prefix === '' ? name : `${prefix}/${name}`, absolute: child })
    }
  }
  await visit(root.replace(/\/+$/, '') || '/', '')
  return found
}

/** Build the match regex, honoring `-F` and `-i`. */
function compile(invocation: Invocation): RegExp {
  const source = invocation.patterns
    .map(pattern => (invocation.fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern))
    .join('|')
  return new RegExp(source, invocation.ignoreCase ? 'i' : '')
}

/** What one `rg` invocation produced. */
export interface RipgrepResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Run `rg` against the runtime's filesystem.
 * @param args - the argument vector, excluding the binary itself.
 * @param cwd - where relative paths resolve from.
 * @returns ripgrep's output and exit status.
 */
export async function ripgrep(args: string[], cwd = WORKSPACE): Promise<RipgrepResult> {
  const invocation = parse(args)
  const roots = invocation.paths.length > 0 ? invocation.paths : ['.']

  const files: Found[] = []
  for (const spelled of roots) {
    const cleaned = spelled.replace(/\/+$/, '')
    const absolute = cleaned.startsWith('/') ? cleaned : `${cwd}/${cleaned === '.' || cleaned === '' ? '' : cleaned}`
    const prefix = cleaned === '.' || cleaned === '' ? '' : cleaned
    files.push(...await walk(absolute.replace(/\/+$/, '') || '/', prefix, invocation.globs))
  }

  if (invocation.listFiles) {
    return { status: files.length > 0 ? 0 : 1, stdout: files.map(file => `${file.display}\n`).join(''), stderr: '' }
  }
  if (invocation.patterns.length === 0) return { status: 2, stdout: '', stderr: 'rg: no pattern given\n' }

  let matcher: RegExp
  try {
    matcher = compile(invocation)
  } catch (error) {
    return { status: 2, stdout: '', stderr: `rg: invalid pattern: ${error instanceof Error ? error.message : String(error)}\n` }
  }

  const fs = await runtimeFs()
  let out = ''
  let total = 0
  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(toContainerPath(file.absolute), 'utf-8')
    } catch {
      continue
    }
    // ripgrep skips binary files by default; the NUL probe is its heuristic.
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    for (let index = 0; index < lines.length; index++) {
      if (!matcher.test(lines[index])) continue
      total++
      out += invocation.json
        ? `${JSON.stringify({
          type: 'match',
          data: {
            path: { text: file.display },
            lines: { text: `${lines[index]}\n` },
            line_number: index + 1,
            absolute_offset: 0,
            submatches: [],
          },
        })}\n`
        : `${file.display}:${String(index + 1)}:${lines[index]}\n`
    }
  }
  return { status: total > 0 ? 0 : 1, stdout: out, stderr: '' }
}

/** Whether a spawned command is the search backend rather than a shell command. */
export function isRipgrep(command: string): boolean {
  const name = command.split('/').pop() ?? command
  return name === 'rg' || name === 'dsh-rg'
}
