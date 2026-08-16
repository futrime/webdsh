/**
 * POSIX path algebra used by both the VFS and the `node:path` shim. Pure string
 * math with no filesystem access, mirroring Node's `path.posix` semantics
 * (including the quirks dsh relies on: `normalize('')` === `'.'`, a preserved
 * trailing slash on `normalize`, and `resolve()` anchored at `process.cwd()`).
 */

/** Current working directory provider, swapped in by the process shim at boot. */
let cwdProvider: () => string = () => '/'

/**
 * Point path resolution at the live process cwd.
 * @param provider - returns the current absolute working directory.
 */
export function setCwdProvider(provider: () => string): void {
  cwdProvider = provider
}

/** The working directory `resolve()` anchors relative segments against. */
export function cwd(): string {
  return cwdProvider()
}

/**
 * Collapse `.` and `..` segments.
 * @param parts - raw path segments.
 * @param allowAboveRoot - keep leading `..` (relative paths) instead of dropping them.
 * @returns the normalized segment string, without leading or trailing slash.
 */
function normalizeParts(parts: string[], allowAboveRoot: boolean): string {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part !== '..') {
      out.push(part)
      continue
    }
    if (out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
    } else if (allowAboveRoot) {
      out.push('..')
    }
  }
  return out.join('/')
}

/** Node `path.posix.normalize`. */
export function normalize(input: string): string {
  if (input.length === 0) return '.'
  const absolute = input.charCodeAt(0) === 47
  const trailing = input.length > 1 && input.charCodeAt(input.length - 1) === 47
  let body = normalizeParts(input.split('/'), !absolute)
  if (body.length === 0 && !absolute) body = '.'
  if (body.length > 0 && trailing) body += '/'
  return absolute ? `/${body}` : body
}

/** Node `path.posix.isAbsolute`. */
export function isAbsolute(input: string): boolean {
  return input.length > 0 && input.charCodeAt(0) === 47
}

/** Node `path.posix.join`. */
export function join(...segments: string[]): string {
  const parts = segments.filter(segment => segment.length > 0)
  if (parts.length === 0) return '.'
  return normalize(parts.join('/'))
}

/** Node `path.posix.resolve`, anchored at the live cwd. */
export function resolve(...segments: string[]): string {
  let resolved = ''
  let absolute = false
  for (let i = segments.length - 1; i >= 0 && !absolute; i--) {
    const segment = segments[i]
    if (segment.length === 0) continue
    resolved = resolved.length === 0 ? segment : `${segment}/${resolved}`
    absolute = isAbsolute(segment)
  }
  if (!absolute) {
    const base = cwd()
    resolved = resolved.length === 0 ? base : `${base}/${resolved}`
  }
  const body = normalizeParts(resolved.split('/'), false)
  return `/${body}`
}

/** Node `path.posix.dirname`. */
export function dirname(input: string): string {
  if (input.length === 0) return '.'
  const absolute = input.charCodeAt(0) === 47
  let end = -1
  let sawNonSlash = false
  for (let i = input.length - 1; i >= 1; i--) {
    if (input.charCodeAt(i) === 47) {
      if (sawNonSlash) {
        end = i
        break
      }
    } else {
      sawNonSlash = true
    }
  }
  if (end === -1) return absolute ? '/' : '.'
  if (absolute && end === 1) return '//'
  return input.slice(0, end)
}

/** Node `path.posix.basename`. */
export function basename(input: string, ext?: string): string {
  let start = 0
  let end = -1
  let sawNonSlash = false
  for (let i = input.length - 1; i >= 0; i--) {
    if (input.charCodeAt(i) === 47) {
      if (sawNonSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      sawNonSlash = true
      end = i + 1
    }
  }
  if (end === -1) return ''
  const name = input.slice(start, end)
  if (ext !== undefined && ext !== name && name.endsWith(ext)) return name.slice(0, name.length - ext.length)
  return name
}

/** Node `path.posix.extname`. */
export function extname(input: string): string {
  const name = basename(input)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot)
}

/** Node `path.posix.relative`. */
export function relative(from: string, to: string): string {
  const a = resolve(from)
  const b = resolve(to)
  if (a === b) return ''
  const fromParts = a.split('/').filter(Boolean)
  const toParts = b.split('/').filter(Boolean)
  let i = 0
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++
  const up = new Array(fromParts.length - i).fill('..') as string[]
  return [...up, ...toParts.slice(i)].join('/')
}

/** Node `path.posix.parse`. */
export function parse(input: string): { root: string, dir: string, base: string, ext: string, name: string } {
  const root = isAbsolute(input) ? '/' : ''
  const base = basename(input)
  const ext = extname(input)
  return { root, dir: dirname(input), base, ext, name: base.slice(0, base.length - ext.length) }
}

/** Node `path.posix.format`. */
export function format(parsed: { root?: string, dir?: string, base?: string, ext?: string, name?: string }): string {
  const dir = parsed.dir ?? parsed.root ?? ''
  const base = parsed.base ?? `${parsed.name ?? ''}${parsed.ext ?? ''}`
  if (dir.length === 0) return base
  return dir === parsed.root ? `${dir}${base}` : `${dir}/${base}`
}

/** Split an absolute, normalized path into its segments (no empties). */
export function segments(input: string): string[] {
  return input.split('/').filter(Boolean)
}
