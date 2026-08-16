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
  return [...new Set([...Object.keys(HOST_MODULES), ...runtimeModules.keys(), ...runtimeLoaders.keys()])].sort()
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
