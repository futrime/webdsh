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
import { hostModuleSystem, isSharedModule } from '../host/module-system.ts'
import { scanModule, type ModuleKind } from './module-scan.ts'

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

/** How long one module body may take to evaluate before it is called hung. */
const EVALUATION_TIMEOUT_MS = 15_000

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
 * Render a re-export facade over a namespace held in a global registry.
 *
 * Each name is bound to a generated local and re-exported under an alias, never
 * as `export const <name>`: an export name may be a reserved word (zod exports
 * `catch`), and `export const catch = …` is a syntax error while
 * `export { _0 as catch }` is not. Names that are not valid identifiers at all
 * use the string form.
 * @param accessor - JavaScript expression yielding the namespace object.
 * @param names - export names to forward.
 * @returns the module source.
 */
function renderFacade(accessor: string, names: readonly string[]): string {
  const lines = [`const ns = ${accessor};`]
  names.forEach((name, index) => {
    const local = `_dsh${String(index)}`
    const exported = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
    lines.push(`const ${local} = ns[${JSON.stringify(name)}];`, `export { ${local} as ${exported} };`)
  })
  lines.push('export default ns.default ?? ns;')
  return lines.join('\n')
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

  const names = Object.keys(namespace).filter(key => key !== 'default')
  const body = renderFacade(`globalThis.__DSH_HOST_BRIDGE__.get(${JSON.stringify(specifier)})`, names)
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
function readManifest(packageName: string, root = PLUGIN_MODULES_ROOT): Record<string, unknown> | undefined {
  const path = `${root}/${packageName}/package.json`
  if (!volume.exists(path)) return undefined
  try {
    return JSON.parse(toText(volume.readFile(path))) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * The `node_modules` directories to search for a bare specifier, nearest first.
 *
 * Node walks up from the importing file; so does this, which is what makes a
 * package installed into a user's own workspace resolvable from a script in it.
 * The plugin root is always last, so the harness's own packages stay reachable
 * from anywhere.
 * @param fromDir - the importing module's directory, if there is one.
 * @returns the search roots in resolution order.
 */
function moduleRoots(fromDir?: string): string[] {
  const roots: string[] = []
  if (fromDir !== undefined) {
    const segments = resolvePath(fromDir).split('/').filter(Boolean)
    for (let i = segments.length; i >= 0; i--) {
      const base = `/${segments.slice(0, i).join('/')}`.replace(/\/+$/, '') || ''
      roots.push(`${base}/node_modules`)
    }
  }
  roots.push(PLUGIN_MODULES_ROOT)
  return [...new Set(roots)]
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
export function resolveInstalled(specifier: string, fromDir?: string): string | undefined {
  const parts = specifier.split('/')
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(packageName.length).replace(/^\//, '')
  for (const root of moduleRoots(fromDir)) {
    const manifest = readManifest(packageName, root)
    if (manifest === undefined) continue
    const entry = entryFor(manifest, subpath)
    // A package present but exposing no such subpath is still the package that
    // owns the name; falling through to an outer root would resolve the wrong
    // copy, so the miss is reported here.
    if (entry === undefined) return undefined
    return resolveFile(resolvePath(`${root}/${packageName}`, entry))
  }
  return undefined
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

/** Live CommonJS module records, keyed by module path. */
const cjsRecords = new Map<string, { exports: unknown }>()

/** Modules whose load is in progress, for cycle detection. */
const loading = new Set<string>()

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
    ? Object.keys(exported as Record<string, unknown>).filter(key => key !== 'default')
    : []
  const body = renderFacade(`globalThis.__DSH_CJS__.get(${JSON.stringify(path)})`, names)
  return URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))
}

/**
 * Evaluate a CommonJS module.
 * @param path - its virtual-filesystem path.
 * @param source - its text.
 * @param required - specifier → already-materialized exports.
 * @param unresolved - specifier → why it could not be resolved; `require` throws
 *   `MODULE_NOT_FOUND` for these, which is what an optional-dependency probe expects.
 * @returns the module's exports.
 */
function evaluateCjs(
  path: string,
  source: string,
  required: Map<string, unknown>,
  unresolved: Map<string, string>,
  record: { exports: unknown },
): unknown {
  const module = record
  const require = (specifier: string): unknown => {
    if (required.has(specifier)) return required.get(specifier)
    const reason = unresolved.get(specifier)
    const error = new Error(
      reason === undefined
        ? `plugin-loader: ${path} required "${specifier}" at runtime, which the loader did not resolve statically`
        : `Cannot find module '${specifier}' — ${reason}`,
    ) as Error & { code: string }
    // The Node code an optional-dependency probe checks for.
    error.code = 'MODULE_NOT_FOUND'
    throw error
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

  loading.add(path)
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
        // A CommonJS cycle resolves to the partially-filled exports object, the
        // way Node's own loader does: the module that closes the cycle sees
        // whatever its dependency had assigned so far. Awaiting instead would
        // deadlock, which is what a cyclic package like `ssh2` produces.
        const cyclic = loading.has(target) ? cjsRecords.get(target) : undefined
        if (cyclic !== undefined) return { blob: blobUrls.get(target) ?? '', exports: cyclic.exports }
        if (loading.has(target)) {
          throw new Error(
            `plugin-loader: circular ES module import between ${path} and ${target};`
            + ' a cycle across ES modules cannot be linked one module at a time in a page',
          )
        }
        const namespace = await importVfsModule(target)
        return { blob: blobUrls.get(target)!, exports: cjsRecords.get(target)?.exports ?? namespace }
      }
      // A bare specifier: prefer the app's own copy, then an installed package.
      const builtin = resolveBuiltin(specifier)
      if (builtin !== undefined) return { blob: await bridgeFor(specifier), exports: builtin }
      if (isSharedModule(specifier)) {
        return { blob: await bridgeFor(specifier), exports: await hostModuleSystem.import(specifier) }
      }
      const installed = resolveInstalled(specifier, directory)
      if (installed !== undefined) {
        const cyclic = loading.has(installed) ? cjsRecords.get(installed) : undefined
        if (cyclic !== undefined) return { blob: blobUrls.get(installed) ?? '', exports: cyclic.exports }
        const namespace = await importVfsModule(installed)
        return { blob: blobUrls.get(installed)!, exports: cjsRecords.get(installed)?.exports ?? namespace }
      }
      // Falls back to the host module system (every dsh package this app bundles).
      const blob = await bridgeFor(specifier)
      return { blob, exports: await hostModuleSystem.import(specifier) }
    }

    if (kind === 'cjs') {
      // The record exists before dependencies are resolved so a cycle back into
      // this module finds a live (empty, then filling) exports object.
      const record: { exports: unknown } = { exports: {} }
      cjsRecords.set(path, record)
      const required = new Map<string, unknown>()
      const unresolved = new Map<string, string>()
      for (const site of [...scan.requires, ...scan.specifiers]) {
        if (required.has(site.value) || unresolved.has(site.value)) continue
        try {
          required.set(site.value, (await resolveDependency(site.value)).exports)
        } catch (error) {
          // An unresolvable `require` is not fatal in CommonJS: libraries probe
          // for optional native addons inside try/catch (`ssh2` does exactly
          // this with `cpu-features`). Deferring the failure to the call keeps
          // that fallback working, and still fails loudly for a real dependency.
          unresolved.set(site.value, error instanceof Error ? error.message : String(error))
        }
      }
      const exported = evaluateCjs(path, source, required, unresolved, record)
      record.exports = exported
      blobUrls.set(path, cjsFacade(path, exported))
      // An ESM importer sees Node's cjs interop shape; a CJS importer gets the
      // raw exports through the module record.
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
    // A module body that never settles — a top-level `await` on something a
    // page can never provide — would otherwise hang the whole boot behind one
    // plugin. Bounding it turns that into a named failure for that row.
    const namespace = await Promise.race([
      import(/* @vite-ignore */ url) as Promise<unknown>,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => { reject(new Error(`plugin-loader: ${path} did not finish evaluating within ${String(EVALUATION_TIMEOUT_MS / 1000)}s`)) },
          EVALUATION_TIMEOUT_MS,
        )
      }),
    ])
    namespaces.set(path, namespace)
    return namespace
  })().finally(() => {
    pending.delete(path)
    loading.delete(path)
  })

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
