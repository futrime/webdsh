/**
 * The host module system: the `internal` contract the vendored Cordis Loader
 * consumes (`EntryTree.import` → `internal.import`).
 *
 * On Node that slot holds Node's own ESM loader. Here it resolves three
 * sources in order: the `node:*` shim registry, the build-time map of dsh
 * packages compiled into this app, and the runtime registry that
 * {@link registerRuntimeModule} fills when a plugin is installed from npm at
 * runtime. Anything else throws — a loud failure beats a silently missing
 * plugin, and the Loader surfaces it as an inactive entry.
 */

import { HOST_MODULES } from '../generated/host-modules.ts'
import { resolveBuiltin } from '../node/registry.ts'
import { setHostRequire } from '../node/misc.ts'
import { scanModule } from '../plugins/module-scan.ts'
// Imported for its URL alone: this makes the bundler emit a file it would
// otherwise skip, because the package computes its own path at runtime.
import codeRuntimeWorkerUrl from '../../node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/worker.cjs?url'

/**
 * Libraries a plugin must share with the harness rather than install a second
 * copy of.
 *
 * These carry identity: a schema built with one `schemastery` is not accepted by
 * another, and dsh rescoped the package precisely so its copy is canonical.
 * Installing a second `zod` would fork every `instanceof` check the API gateway
 * makes. Sharing them also keeps large, deeply cyclic packages out of the
 * runtime module loader entirely.
 *
 * The same table covers the native packages this build replaces, so a plugin
 * that imports `node-pty` reaches the browser terminal rather than a binary
 * loader that cannot succeed.
 */
const SHARED_MODULES: Record<string, () => Promise<unknown>> = {
  zod: () => import('zod'),
  schemastery: () => import('@deepseek-ai/schemastery'),
  cordis: () => import('@deepseek-ai/cordis'),
  cosmokit: () => import('@deepseek-ai/cosmokit'),
  // Native packages this build replaces. A plugin asking for a PTY or an image
  // decoder must get the browser implementation the harness itself uses —
  // installing the real package only fetches a native binary that cannot load.
  'node-pty': () => import('../node/node-pty.ts'),
  sharp: () => import('../node/sharp.ts'),
  // `ws`'s own browser entry throws on import; the platform WebSocket is what a
  // client-side consumer actually wants.
  ws: () => import('../node/ws.ts'),
}

/** Whether a bare specifier resolves to a library the app already provides. */
export function isSharedModule(specifier: string): boolean {
  return specifier in SHARED_MODULES
}

/** Modules registered at runtime (installed plugins), keyed by specifier. */
const runtimeModules = new Map<string, unknown>()

/** Loaders registered at runtime that materialize on first import. */
const runtimeLoaders = new Map<string, () => Promise<unknown>>()

/**
 * Publish an already-evaluated module under a specifier.
 * @param specifier - the package name or subpath the composition will mount.
 * @param namespace - the module's exports.
 */
export function registerRuntimeModule(specifier: string, namespace: unknown): void {
  runtimeModules.set(specifier, namespace)
}

/**
 * Publish a lazy loader for a specifier.
 * @param specifier - the package name or subpath.
 * @param load - evaluates the module on first import; the result is memoized.
 */
export function registerRuntimeLoader(specifier: string, load: () => Promise<unknown>): void {
  runtimeLoaders.set(specifier, load)
}

/** Every specifier the host can currently resolve (used by diagnostics and the plugin UI). */
export function knownSpecifiers(): string[] {
  return [...new Set([
    ...Object.keys(HOST_MODULES),
    ...Object.keys(SHARED_MODULES),
    ...runtimeModules.keys(),
    ...runtimeLoaders.keys(),
  ])].sort()
}

/** Synchronous resolution, for `createRequire()` handed to plugin code. */
function requireSync(specifier: string): unknown {
  const builtin = resolveBuiltin(specifier)
  if (builtin !== undefined) return builtin
  return runtimeModules.get(specifier)
}

setHostRequire(requireSync)

/**
 * The `ModuleLoader`-shaped object mounted on `ctx.loader.internal`.
 *
 * `version` is a discriminant the vendored loader reads to tell Node's v1/v2
 * loader shapes apart; `'browser'` matches neither, which is correct — none of
 * the Node-specific branches apply.
 */
export const hostModuleSystem = {
  version: 'browser' as const,
  loadCache: new Map<string, unknown>(),

  /**
   * Resolve a plugin specifier to its module namespace.
   * @param specifier - package name, package subpath, or `node:` builtin.
   * @returns the module's exports.
   * @throws when nothing can supply the specifier.
   */
  async import(specifier: string): Promise<unknown> {
    const cached = this.loadCache.get(specifier)
    if (cached !== undefined) return cached

    const builtin = resolveBuiltin(specifier)
    if (builtin !== undefined) return builtin

    const runtime = runtimeModules.get(specifier)
    if (runtime !== undefined) return runtime

    const lazy = runtimeLoaders.get(specifier)
    if (lazy !== undefined) {
      const namespace = await lazy()
      runtimeModules.set(specifier, namespace)
      this.loadCache.set(specifier, namespace)
      return namespace
    }

    const shared = SHARED_MODULES[specifier]
    if (shared !== undefined) {
      const namespace = await shared()
      this.loadCache.set(specifier, namespace)
      return namespace
    }

    const bundled = HOST_MODULES[specifier]
    if (bundled !== undefined) {
      const namespace = await bundled()
      this.loadCache.set(specifier, namespace)
      return namespace
    }

    throw new Error(
      `host-modules: cannot resolve "${specifier}". Plugins compiled into this build are listed in `
      + 'src/generated/host-modules.ts; anything else must be installed through the plugin manager first.',
    )
  },
}

/**
 * Load a worker entry named by a filesystem URL.
 *
 * `worker_threads` callers name their entry the way Node needs — an absolute
 * path to a built file, `…/node_modules/@deepseek-ai/<pkg>/lib/worker.cjs` —
 * but nothing in a page can load a path. Every such entry is published as the
 * package's `./worker` subpath, and that specifier is already in the host
 * module map, so the path only has to be read back into the specifier it
 * denotes.
 * @param url - the `file://` URL (or bare path) of the worker entry.
 * @returns the worker module's namespace, having run its body.
 */
export async function loadWorkerEntry(url: string): Promise<unknown> {
  // A `file:` URL percent-encodes the `@` in a scoped package name, so the
  // pathname reads `%40deepseek-ai` and no package pattern below would match it.
  const path = url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname) : url

  // The bundler rewrote `new URL('./worker.cjs', import.meta.url)` to the asset
  // it emitted, so the entry names a real static file — just not one inside a
  // package any more. Fetching and evaluating it is what a worker would have
  // done, minus the thread.
  const asset = /\/assets\/[^/]+\.(?:cjs|mjs|js)$/.exec(path)
  if (asset !== null) return evaluateWorkerAsset(path.replace(/^\//, ''))

  const match = /node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*)\/(?:lib\/)?([^/]+?)\.(?:cjs|mjs|js)$/.exec(path)
  if (match === null) {
    throw new Error(`worker entry "${url}" does not name a package file this build can resolve`)
  }
  const [, packageName, basename] = match
  // `worker.cjs` is published as `./worker`; an entry that is the package's own
  // main has no subpath.
  const specifier = basename === 'index' ? packageName : `${packageName}/${basename}`
  return hostModuleSystem.import(specifier)
}

/**
 * Worker entries the bundler could not emit on its own, by the filename their
 * unresolvable URL lands on.
 *
 * The workflow runtime writes `new URL('./worker.cjs', import.meta.url)`, which
 * the bundler reads and emits. The code runtime picks its filename with a
 * conditional, so nothing is emitted — importing it here with `?url` makes the
 * bundler emit the file anyway and hands back where it put it.
 */
const UNEMITTED_WORKERS: Record<string, string> = {
  'worker.cjs': codeRuntimeWorkerUrl,
}

/** Worker sources already fetched, keyed by URL. Only the text is reused. */
const workerSources = new Map<string, Promise<string>>()

/**
 * Fetch a bundled CommonJS worker entry and run its body.
 *
 * `require` in CommonJS is synchronous while this host resolves modules
 * asynchronously, so every specifier the source names is resolved up front and
 * the evaluation then reads from that table. The entry runs to completion here,
 * which is what a worker's first tick does.
 * @param assetPath - the emitted asset's path, relative to the app's base.
 * @returns the module's exports.
 */
async function evaluateWorkerAsset(assetPath: string): Promise<unknown> {
  // The bundler emits a worker file only when it can see the URL; when it could
  // not, the path resolves beside whatever chunk the module landed in and there
  // is nothing there.
  const fallback = UNEMITTED_WORKERS[assetPath.split('/').pop() ?? '']
  const href = fallback ?? new URL(assetPath, document.baseURI).href

  let pending = workerSources.get(href)
  if (pending === undefined) {
    pending = (async () => {
      const response = await fetch(href)
      if (!response.ok) throw new Error(`worker entry ${assetPath} could not be fetched (${String(response.status)})`)
      return response.text()
    })()
    workerSources.set(href, pending)
  }
  const source = await pending

  // Evaluated afresh for every worker. A module system would hand back the same
  // namespace, and a worker entry is not a module in that sense: its body *is*
  // the worker's lifetime, so reusing it would mean the second run_code call
  // never starts a worker at all.
  {
    const resolved = new Map<string, unknown>()
    for (const site of scanModule(source).requires) {
      if (resolved.has(site.value)) continue
      resolved.set(site.value, await hostModuleSystem.import(site.value))
    }

    const module = { exports: {} as Record<string, unknown> }
    const require = (specifier: string): unknown => {
      const namespace = resolved.get(specifier)
      if (namespace === undefined) throw new Error(`worker entry required "${specifier}", which was not resolvable`)
      // A namespace whose only meaningful member is `default` is an ES module
      // being consumed by CommonJS; hand over what `require` would have seen.
      const record = namespace as Record<string, unknown>
      return record.default !== undefined && record.__esModule !== true ? record.default : namespace
    }
    const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', source) as (
      exports: unknown, require: (specifier: string) => unknown, module: unknown, filename: string, dirname: string,
    ) => void
    factory(module.exports, require, module, `/${assetPath}`, `/${assetPath.replace(/\/[^/]*$/, '')}`)
    return module.exports
  }
}
