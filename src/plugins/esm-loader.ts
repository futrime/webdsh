/**
 * An ES-module loader for packages installed into the virtual filesystem.
 *
 * A plugin's host half is ordinary ESM that imports `@deepseek-ai/*` packages
 * and its own dependencies. The browser cannot resolve those bare specifiers,
 * and import maps cannot be added after the first module loads, so this loader
 * does the resolution itself: it rewrites each module's specifiers to `blob:`
 * URLs for its dependencies, then imports the rewritten blob. Modules already
 * compiled into this app (every `@deepseek-ai/*` package, every `node:*` shim)
 * are exposed through a generated re-export shim so a plugin shares the app's
 * single instance of cordis rather than getting a second copy.
 *
 * Rewriting is done with a scanner that tracks strings, template literals,
 * comments, and regex literals, so a specifier-looking substring inside a
 * string is never touched.
 */

import { volume } from '../vfs/volume.ts'
import { toText } from '../node/binary.ts'
import { dirname, resolve as resolvePath } from '../vfs/path.ts'
import { resolveBuiltin } from '../node/registry.ts'
import { hostModuleSystem } from '../host/module-system.ts'

/** Root the plugin installer writes packages under. */
export const PLUGIN_MODULES_ROOT = '/opt/dsh/plugins/node_modules'

/** Blob URL per resolved module path, so a shared dependency is evaluated once. */
const blobUrls = new Map<string, string>()

/** Namespace per resolved module path. */
const namespaces = new Map<string, unknown>()

/** In-flight loads, so a cycle resolves to the same pending promise. */
const pending = new Map<string, Promise<unknown>>()

/** Blob URL per bundled specifier (`@deepseek-ai/cordis`, `node:fs`, …). */
const bridgeUrls = new Map<string, string>()

/** One import or export specifier found in a module. */
interface SpecifierSite {
  start: number
  end: number
  value: string
}

/** One `import.meta.url` / `.filename` / `.dirname` reference. */
interface MetaSite {
  /** Bounds of the whole `import.meta.<member>` expression. */
  start: number
  end: number
  member: 'url' | 'filename' | 'dirname'
}

/** What a module's source says it is. */
type ModuleKind = 'esm' | 'cjs'

/**
 * Find every module specifier in `source`.
 *
 * A specifier is recognized only in the three positions the grammar allows it:
 * directly after the `from` keyword, directly after a bare `import`, and
 * directly inside `import(`. Anything else — including a string that happens to
 * sit inside an exported function body — is left alone. An earlier version
 * scanned forward from `import`/`export` for the next string literal, which
 * turned `export function f() { throw new Error('…') }` into a bogus import.
 * @param source - the module text.
 * @returns each specifier's literal bounds and value.
 */
export function findSpecifiers(source: string): SpecifierSite[] {
  return scanModule(source).specifiers
}

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

/**
 * Decide whether a module is ESM or CommonJS, the way Node does: the file
 * extension wins, otherwise the nearest `package.json` `type` field, otherwise
 * CommonJS — with the module's own syntax as the final tie-breaker for a
 * package that declares nothing.
 * @param path - the module's virtual-filesystem path.
 * @param hasEsmSyntax - whether the source used `import`/`export` syntax.
 * @returns the module kind.
 */
function moduleKind(path: string, hasEsmSyntax: boolean): ModuleKind {
  if (path.endsWith('.mjs')) return 'esm'
  if (path.endsWith('.cjs')) return 'cjs'
  let directory = dirname(path)
  for (let depth = 0; depth < 12; depth++) {
    const manifest = `${directory}/package.json`
    if (volume.exists(manifest)) {
      try {
        const parsed = JSON.parse(toText(volume.readFile(manifest))) as { type?: string }
        if (parsed.type === 'module') return 'esm'
        if (parsed.type === 'commonjs') return 'cjs'
      } catch {
        // A malformed manifest decides nothing; fall through to the syntax test.
      }
      break
    }
    if (directory === '/' || directory === PLUGIN_MODULES_ROOT) break
    directory = dirname(directory)
  }
  return hasEsmSyntax ? 'esm' : 'cjs'
}

/**
 * Apply the rewrites a module needs to run from a blob URL.
 * @param source - the module text.
 * @param resolutions - specifier → blob URL for its dependencies.
 * @param filePath - the module's absolute path in the virtual filesystem.
 * @returns the rewritten source.
 */
function rewriteModule(source: string, resolutions: Map<string, string>, filePath: string): string {
  const { specifiers, meta } = scanModule(source)
  const fileUrl = `file://${filePath}`
  const edits: { start: number, end: number, text: string }[] = [
    ...specifiers.map(site => ({
      start: site.start,
      end: site.end,
      // The literal's quotes stay in place; only its contents are replaced.
      text: JSON.stringify(resolutions.get(site.value) ?? site.value).slice(1, -1),
    })),
    ...meta.map(site => ({
      start: site.start,
      end: site.end,
      text: JSON.stringify(
        site.member === 'url' ? fileUrl
          : site.member === 'filename' ? filePath
            : dirname(filePath),
      ),
    })),
  ].sort((a, b) => a.start - b.start)

  if (edits.length === 0) return source
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += source.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + source.slice(cursor)
}

/**
 * Build (once) a blob module that re-exports an already-loaded namespace, so a
 * plugin importing `@deepseek-ai/cordis` binds to this app's single instance.
 */
async function bridgeFor(specifier: string): Promise<string> {
  const existing = bridgeUrls.get(specifier)
  if (existing !== undefined) return existing
  const namespace = (resolveBuiltin(specifier) ?? await hostModuleSystem.import(specifier)) as Record<string, unknown>
  const registry = (globalThis as { __DSH_HOST_BRIDGE__?: Map<string, unknown> }).__DSH_HOST_BRIDGE__
    ?? new Map<string, unknown>()
  ;(globalThis as { __DSH_HOST_BRIDGE__?: Map<string, unknown> }).__DSH_HOST_BRIDGE__ = registry
  registry.set(specifier, namespace)

  const names = Object.keys(namespace).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
  const body = [
    `const ns = globalThis.__DSH_HOST_BRIDGE__.get(${JSON.stringify(specifier)});`,
    ...names.map(key => `export const ${key} = ns[${JSON.stringify(key)}];`),
    `export default ns.default ?? ns;`,
  ].join('\n')
  const url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))
  bridgeUrls.set(specifier, url)
  return url
}

/** Extension and index resolution for a relative import. */
function resolveFile(base: string): string | undefined {
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`]
  for (const candidate of candidates) {
    const node = volume.lookup(candidate)
    if (node?.kind === 'file') return candidate
  }
  return undefined
}

/** Read a package manifest from the plugin module root. */
function readManifest(packageName: string): Record<string, unknown> | undefined {
  const path = `${PLUGIN_MODULES_ROOT}/${packageName}/package.json`
  if (!volume.exists(path)) return undefined
  try {
    return JSON.parse(toText(volume.readFile(path))) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Pick the runtime entry for a subpath from a package manifest. */
function entryFor(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const exportsField = manifest.exports
  const key = subpath === '' ? '.' : `./${subpath}`
  if (typeof exportsField === 'string' && key === '.') return exportsField
  if (typeof exportsField === 'object' && exportsField !== null) {
    const table = exportsField as Record<string, unknown>
    const candidate = table[key]
    const pick = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value
      if (typeof value !== 'object' || value === null) return undefined
      const conditions = value as Record<string, unknown>
      for (const condition of ['browser', 'import', 'module', 'default', 'require', 'node']) {
        const resolved = pick(conditions[condition])
        if (resolved !== undefined) return resolved
      }
      return undefined
    }
    const resolved = pick(candidate)
    if (resolved !== undefined) return resolved
  }
  if (key === '.') {
    const main = manifest.module ?? manifest.main
    if (typeof main === 'string') return main
  }
  return subpath === '' ? undefined : `./${subpath}`
}

/**
 * Resolve a bare specifier to an absolute VFS module path.
 * @param specifier - the bare specifier (`pkg` or `pkg/sub`).
 * @returns the module path, or undefined when the package is not installed.
 */
export function resolveInstalled(specifier: string): string | undefined {
  const parts = specifier.split('/')
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(packageName.length).replace(/^\//, '')
  const manifest = readManifest(packageName)
  if (manifest === undefined) return undefined
  const entry = entryFor(manifest, subpath)
  if (entry === undefined) return undefined
  return resolveFile(resolvePath(`${PLUGIN_MODULES_ROOT}/${packageName}`, entry))
}

/** Materialized CommonJS exports, keyed by module path. */
const cjsExports = new Map<string, unknown>()

/**
 * Build a blob ES module that re-exports a CommonJS module's exports.
 *
 * An ESM importer can only reach a blob URL, so a CJS dependency needs a facade
 * whose named exports mirror the CJS object — which is what Node's own
 * cjs-named-exports interop provides.
 * @param path - the CJS module's virtual-filesystem path.
 * @param exported - its `module.exports` value.
 * @returns the facade's blob URL.
 */
function cjsFacade(path: string, exported: unknown): string {
  const registry = (globalThis as { __DSH_CJS__?: Map<string, unknown> }).__DSH_CJS__ ?? new Map<string, unknown>()
  ;(globalThis as { __DSH_CJS__?: Map<string, unknown> }).__DSH_CJS__ = registry
  registry.set(path, exported)
  const names = typeof exported === 'object' && exported !== null
    ? Object.keys(exported as Record<string, unknown>).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
    : []
  const body = [
    `const ns = globalThis.__DSH_CJS__.get(${JSON.stringify(path)});`,
    ...names.map(key => `export const ${key} = ns[${JSON.stringify(key)}];`),
    'export default ns;',
  ].join('\n')
  return URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))
}

/**
 * Evaluate a CommonJS module.
 * @param path - its virtual-filesystem path.
 * @param source - its text.
 * @param required - specifier → already-materialized exports.
 * @returns the module's exports.
 */
function evaluateCjs(path: string, source: string, required: Map<string, unknown>): unknown {
  const module = { exports: {} as unknown }
  const require = (specifier: string): unknown => {
    if (required.has(specifier)) return required.get(specifier)
    throw new Error(`plugin-loader: ${path} required "${specifier}" at runtime, which the loader did not resolve statically`)
  }
  // eslint-disable-next-line no-new-func
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', `${source}\n//# sourceURL=${path}`) as (
    exports: unknown, require: (specifier: string) => unknown, module: { exports: unknown }, filename: string, directory: string,
  ) => void
  factory(module.exports, require, module, path, dirname(path))
  return module.exports
}

/**
 * Load one module from the virtual filesystem, resolving its dependency graph.
 * @param path - absolute VFS path of the module.
 * @returns the module namespace.
 */
export async function importVfsModule(path: string): Promise<unknown> {
  const cached = namespaces.get(path)
  if (cached !== undefined) return cached
  const inFlight = pending.get(path)
  if (inFlight !== undefined) return inFlight

  const task = (async () => {
    const source = toText(volume.readFile(path))
    const directory = dirname(path)
    const scan = scanModule(source)
    const kind = moduleKind(path, scan.hasEsmSyntax)

    /** Resolve one dependency specifier to its module path or bridge namespace. */
    const resolveDependency = async (specifier: string): Promise<{ blob: string, exports: unknown }> => {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolveFile(specifier.startsWith('/') ? specifier : resolvePath(directory, specifier))
        if (target === undefined) {
          throw new Error(`plugin-loader: ${path} imports "${specifier}", which does not exist in the virtual filesystem`)
        }
        const namespace = await importVfsModule(target)
        return { blob: blobUrls.get(target)!, exports: cjsExports.get(target) ?? namespace }
      }
      // A bare specifier: prefer the app's own copy, then an installed package.
      const builtin = resolveBuiltin(specifier)
      if (builtin !== undefined) return { blob: await bridgeFor(specifier), exports: builtin }
      const installed = resolveInstalled(specifier)
      if (installed !== undefined) {
        const namespace = await importVfsModule(installed)
        return { blob: blobUrls.get(installed)!, exports: cjsExports.get(installed) ?? namespace }
      }
      // Falls back to the host module system (every dsh package this app bundles).
      const blob = await bridgeFor(specifier)
      return { blob, exports: await hostModuleSystem.import(specifier) }
    }

    if (kind === 'cjs') {
      const required = new Map<string, unknown>()
      for (const site of [...scan.requires, ...scan.specifiers]) {
        if (required.has(site.value)) continue
        required.set(site.value, (await resolveDependency(site.value)).exports)
      }
      const exported = evaluateCjs(path, source, required)
      cjsExports.set(path, exported)
      blobUrls.set(path, cjsFacade(path, exported))
      // An ESM importer sees Node's cjs interop shape; a CJS importer gets the
      // raw exports through `cjsExports`.
      const namespace = typeof exported === 'object' && exported !== null
        ? { ...(exported as Record<string, unknown>), default: exported }
        : { default: exported }
      namespaces.set(path, namespace)
      return namespace
    }

    /** Dependencies discovered in this module, resolved before the blob is built. */
    const resolutions = new Map<string, string>()
    for (const site of scan.specifiers) {
      if (resolutions.has(site.value)) continue
      resolutions.set(site.value, (await resolveDependency(site.value)).blob)
    }

    const rewritten = rewriteModule(source, resolutions, path)
    const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
    blobUrls.set(path, url)
    const namespace = await import(/* @vite-ignore */ url) as unknown
    namespaces.set(path, namespace)
    return namespace
  })().finally(() => { pending.delete(path) })

  pending.set(path, task)
  return task
}

/**
 * Import an installed package by specifier.
 * @param specifier - `pkg` or `pkg/subpath`.
 * @returns the module namespace.
 * @throws when the package is not installed or has no resolvable entry.
 */
export async function importInstalledPackage(specifier: string): Promise<unknown> {
  const path = resolveInstalled(specifier)
  if (path === undefined) {
    throw new Error(`plugin-loader: "${specifier}" is not installed in the virtual filesystem`)
  }
  return importVfsModule(path)
}
