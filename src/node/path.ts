/**
 * `node:path`. The browser host is POSIX-only, so `path`, `path.posix` and
 * `path.win32` all resolve to the same POSIX implementation — dsh's Windows
 * branches are already excluded by `process.platform === 'linux'`.
 */

import * as posixPath from '../vfs/path.ts'

export const sep = '/'
export const delimiter = ':'

export const {
  normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, parse, format,
} = posixPath

/** `path.toNamespacedPath` is a Windows-only transform; POSIX returns the input. */
export const toNamespacedPath = (input: string): string => input

/** `path.matchesGlob` (Node 22+), delegating to the shared matcher. */
export const matchesGlob = (target: string, pattern: string): boolean => globToRegExp(pattern).test(target)

/**
 * Compile a glob into an anchored RegExp.
 *
 * Supports `**`, `*`, `?`, and `{a,b}` alternation — the subset dsh's search
 * tool and the shell's pathname expansion both need.
 * @param pattern - the glob source.
 * @returns the compiled matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` crosses directory boundaries and may match zero segments.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') { source += '[^/]'; continue }
    if (char === '{') {
      const close = pattern.indexOf('}', i)
      if (close !== -1) {
        const options = pattern.slice(i + 1, close).split(',')
        source += `(?:${options.map(option => option.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = close
        continue
      }
    }
    if (char === '[') {
      const close = pattern.indexOf(']', i)
      if (close !== -1) {
        source += pattern.slice(i, close + 1)
        i = close
        continue
      }
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const api = {
  sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname,
  relative, parse, format, toNamespacedPath, matchesGlob,
}

export const posix = { ...api, posix: undefined as unknown, win32: undefined as unknown }
export const win32 = posix
posix.posix = posix
posix.win32 = posix

export default { ...api, posix, win32 }
