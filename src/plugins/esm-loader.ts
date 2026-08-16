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

/**
 * Find every module specifier in `source`.
 *
 * Only `import`/`export … from '…'`, bare `import '…'`, and `import('…')` with
 * a literal argument are rewritten; a computed dynamic import is left alone
 * and will fail at runtime, which is the honest outcome.
 * @param source - the module text.
 * @returns each specifier's literal bounds and value.
 */
export function findSpecifiers(source: string): SpecifierSite[] {
  const sites: SpecifierSite[] = []
  let i = 0
  const length = source.length
  /** Whether the previous significant token allows a regex literal to start here. */
  let regexAllowed = true

  const isIdentChar = (char: string): boolean => /[\w$]/.test(char)

  /** Read a quoted string starting at `i`; returns its inner bounds. */
  const readString = (quote: string): { start: number, end: number, value: string } | undefined => {
    const start = i + 1
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

  while (i < length) {
    const char = source[i]

    // Comments.
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
    // Regex literal.
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
        continue
      }
    }
    // Strings and templates: skipped wholesale unless an import keyword put us here.
    if (char === '"' || char === "'" || char === '`') {
      const literal = readString(char)
      i = literal === undefined ? i + 1 : literal.end + 1
      regexAllowed = false
      continue
    }

    // `import` / `export` statements and `import(` expressions.
    if ((char === 'i' || char === 'e') && (source.startsWith('import', i) || source.startsWith('export', i))) {
      const keyword = source.startsWith('import', i) ? 'import' : 'export'
      const before = i === 0 ? '' : source[i - 1]
      const after = source[i + keyword.length] ?? ''
      if (!isIdentChar(before) && before !== '.' && !isIdentChar(after)) {
        // Scan forward for this statement's specifier literal.
        let cursor = i + keyword.length
        let depth = 0
        while (cursor < length) {
          const inner = source[cursor]
          if (inner === '/' && source[cursor + 1] === '/') {
            const end = source.indexOf('\n', cursor)
            cursor = end === -1 ? length : end
            continue
          }
          if (inner === '/' && source[cursor + 1] === '*') {
            const end = source.indexOf('*/', cursor + 2)
            cursor = end === -1 ? length : end + 2
            continue
          }
          if (inner === '{') depth++
          if (inner === '}') depth--
          if (inner === '"' || inner === "'") {
            const save = i
            i = cursor
            const literal = readString(inner)
            i = save
            if (literal !== undefined) {
              sites.push({ start: literal.start, end: literal.end, value: literal.value })
              cursor = literal.end + 1
            } else {
              cursor++
            }
            break
          }
          // A statement terminator before any literal: a local declaration
          // (`export const x = 1`) or a bare `import.meta`.
          if (depth === 0 && (inner === ';' || inner === '\n')) {
            const rest = source.slice(cursor).trimStart()
            if (!rest.startsWith('from') && !rest.startsWith('"') && !rest.startsWith("'")) break
          }
          cursor++
        }
        i = Math.max(cursor, i + keyword.length)
        regexAllowed = true
        continue
      }
    }

    if (!/\s/.test(char)) regexAllowed = /[([{,;:=!&|?+\-*%<>~^]/.test(char)
    i++
  }
  return sites
}

/** Rewrite every specifier through `map`. */
function rewrite(source: string, map: (specifier: string) => string | undefined): string {
  const sites = findSpecifiers(source)
  if (sites.length === 0) return source
  let out = ''
  let cursor = 0
  for (const site of sites) {
    const replacement = map(site.value)
    if (replacement === undefined) continue
    out += source.slice(cursor, site.start) + replacement
    cursor = site.end
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
    /** Dependencies discovered in this module, resolved before the blob is built. */
    const resolutions = new Map<string, string>()

    for (const site of findSpecifiers(source)) {
      if (resolutions.has(site.value)) continue
      const specifier = site.value
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolveFile(specifier.startsWith('/') ? specifier : resolvePath(directory, specifier))
        if (target === undefined) {
          throw new Error(`plugin-loader: ${path} imports "${specifier}", which does not exist in the virtual filesystem`)
        }
        await importVfsModule(target)
        resolutions.set(specifier, blobUrls.get(target)!)
        continue
      }
      // A bare specifier: prefer the app's own copy, then an installed package.
      if (resolveBuiltin(specifier) !== undefined) {
        resolutions.set(specifier, await bridgeFor(specifier))
        continue
      }
      const installed = resolveInstalled(specifier)
      if (installed !== undefined) {
        await importVfsModule(installed)
        resolutions.set(specifier, blobUrls.get(installed)!)
        continue
      }
      // Falls back to the host module system (every dsh package this app bundles).
      resolutions.set(specifier, await bridgeFor(specifier))
    }

    const rewritten = rewrite(source, specifier => JSON.stringify(resolutions.get(specifier) ?? specifier).slice(1, -1))
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
