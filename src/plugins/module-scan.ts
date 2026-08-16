/**
 * The module scanner: find a module's import specifiers, `require()` edges, and
 * `import.meta` references without parsing it.
 *
 * It is deliberately dependency-free — no filesystem, no DOM — so it can be
 * exercised directly against real published packages, which is how its two
 * original defects were found (a specifier claimed from an exported function
 * body, and a word boundary tested against the wrong character).
 */

/** One import or export specifier found in a module. */
export interface SpecifierSite {
  start: number
  end: number
  value: string
}

/** One `import.meta.url` / `.filename` / `.dirname` reference. */
export interface MetaSite {
  /** Bounds of the whole `import.meta.<member>` expression. */
  start: number
  end: number
  member: 'url' | 'filename' | 'dirname'
}

/** What a module's source says it is. */
export type ModuleKind = 'esm' | 'cjs'

/**
 * Find every specifier in `source`.
 *
 * A specifier is recognized only in the positions the grammar allows one:
 * directly after the `from` keyword, directly after a bare `import`, inside
 * `import(`, and inside `require(`. Anything else — including a string that
 * happens to sit inside an exported function body — is left alone. An earlier
 * version scanned forward from `import`/`export` for the next string literal,
 * which turned `export function f() { throw new Error('…') }` into a bogus
 * import of that message.
 * @param source - the module text.
 * @returns the specifier, `require`, and `import.meta` sites, plus whether the
 *   source used ESM syntax at all.
 */
/**
 * Walk a module once, collecting both the import specifiers and the
 * `import.meta` references that need rewriting.
 * @param source - the module text.
 * @returns the specifier and `import.meta` sites, in source order.
 */
export function scanModule(source: string): { specifiers: SpecifierSite[], meta: MetaSite[], requires: SpecifierSite[], hasEsmSyntax: boolean } {
  const sites: SpecifierSite[] = []
  const meta: MetaSite[] = []
  const requires: SpecifierSite[] = []
  let hasEsmSyntax = false
  const length = source.length
  let i = 0
  /** Whether a `/` here would start a regex literal rather than division. */
  let regexAllowed = true
  /** The previous significant (non-space, non-comment) character. */
  let previous = ''

  const isIdent = (char: string): boolean => /[\w$]/.test(char)

  /** Index of the next significant character at or after `from`, or -1. */
  const skipTrivia = (from: number): number => {
    let cursor = from
    while (cursor < length) {
      const char = source[cursor]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        cursor++
        continue
      }
      if (char === '/' && source[cursor + 1] === '/') {
        const end = source.indexOf('\n', cursor)
        cursor = end === -1 ? length : end
        continue
      }
      if (char === '/' && source[cursor + 1] === '*') {
        const end = source.indexOf('*/', cursor + 2)
        cursor = end === -1 ? length : end + 2
        continue
      }
      return cursor
    }
    return -1
  }

  /** Read a quoted string starting at `at`; returns its inner bounds. */
  const readString = (at: number): { start: number, end: number, value: string } | undefined => {
    const quote = source[at]
    const start = at + 1
    let cursor = start
    while (cursor < length) {
      const char = source[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === quote) return { start, end: cursor, value: source.slice(start, cursor) }
      if (quote !== '`' && char === '\n') return undefined
      cursor++
    }
    return undefined
  }

  /** Record the specifier literal at `at`, if there is one. */
  const claim = (at: number, into: SpecifierSite[] = sites): number | undefined => {
    if (at === -1) return undefined
    const quote = source[at]
    if (quote !== '"' && quote !== "'") return undefined
    const literal = readString(at)
    if (literal === undefined) return undefined
    into.push(literal)
    return literal.end + 1
  }

  while (i < length) {
    const char = source[i]

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? length : end
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? length : end + 2
      continue
    }
    if (char === '/' && regexAllowed) {
      let cursor = i + 1
      let inClass = false
      let closed = false
      while (cursor < length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) {
          closed = true
          break
        } else if (inner === '\n') break
        cursor++
      }
      if (closed) {
        i = cursor + 1
        regexAllowed = false
        previous = '/'
        continue
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      const literal = readString(i)
      i = literal === undefined ? i + 1 : literal.end + 1
      regexAllowed = false
      previous = char
      continue
    }

    // A word starts where the *immediately* preceding character is not an
    // identifier character. `previous` tracks the last SIGNIFICANT character
    // instead (for the `.from` test), and whitespace never updates it — so the
    // boundary test has to read the source directly.
    if (isIdent(char) && (i === 0 || !isIdent(source[i - 1]))) {
      // Read the whole word so `fromage` never looks like `from`.
      let end = i
      while (end < length && isIdent(source[end])) end++
      const word = source.slice(i, end)

      if (word === 'require' && previous !== '.') {
        // `require('x')` — a CommonJS dependency edge.
        const next = skipTrivia(end)
        if (next !== -1 && source[next] === '(') {
          const literalAt = skipTrivia(next + 1)
          const consumed = claim(literalAt, requires)
          if (consumed !== undefined) {
            i = consumed
            regexAllowed = false
            previous = "'"
            continue
          }
        }
      } else if (word === 'export' && previous !== '.') {
        hasEsmSyntax = true
      } else if (word === 'from' && previous !== '.') {
        const consumed = claim(skipTrivia(end))
        if (consumed !== undefined) {
          hasEsmSyntax = true
          i = consumed
          regexAllowed = true
          previous = "'"
          continue
        }
      } else if (word === 'import' && previous !== '.') {
        const next = skipTrivia(end)
        // `import.meta.url` and friends: a blob module's own URL is opaque, so
        // relative resolution against it throws. The loader rewrites these to
        // the module's virtual-filesystem location instead.
        if (next !== -1 && source[next] === '.') {
          const metaStart = skipTrivia(next + 1)
          if (metaStart !== -1 && source.startsWith('meta', metaStart) && !isIdent(source[metaStart + 4] ?? '')) {
            const dot = skipTrivia(metaStart + 4)
            if (dot !== -1 && source[dot] === '.') {
              const memberStart = skipTrivia(dot + 1)
              let memberEnd = memberStart
              while (memberEnd < length && isIdent(source[memberEnd])) memberEnd++
              const member = source.slice(memberStart, memberEnd)
              if (member === 'url' || member === 'filename' || member === 'dirname') {
                meta.push({ start: i, end: memberEnd, member })
                i = memberEnd
                regexAllowed = false
                previous = 'l'
                continue
              }
            }
          }
        }
        if (next !== -1 && source[next] === '(') {
          const consumed = claim(skipTrivia(next + 1))
          if (consumed !== undefined) {
            i = consumed
            regexAllowed = false
            previous = "'"
            continue
          }
        } else {
          const consumed = claim(next)
          if (consumed !== undefined) {
            i = consumed
            regexAllowed = true
            previous = "'"
            continue
          }
        }
      }

      i = end
      regexAllowed = false
      previous = source[end - 1]
      continue
    }

    if (!/\s/.test(char)) {
      regexAllowed = /[([{,;:=!&|?+\-*%<>~^]/.test(char)
      previous = char
    }
    i++
  }
  return { specifiers: sites, meta, requires, hasEsmSyntax }
}

