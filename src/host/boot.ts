/**
 * Boot the dsh host inside the page.
 *
 * This mirrors `apps/cli`'s boot exactly where it can: a Cordis `Context`, the
 * vendored `Loader`, the `cordis:include` root over a `cordis.yml`, and the
 * bundle patch layers applied in the documented order (`dsh-base`, then
 * `dsh-web-app`, then this deployment's own overlay, then the user's
 * `cordis.patch.yml` from the harness home). Only two things differ: the module
 * system behind `loader.internal`, and the overlay that swaps host capabilities
 * for browser ones.
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOptionalPatches, loadOverlayPatches, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { hostModuleSystem, registerRuntimeModule } from './module-system.ts'
import { BROWSER_PLUGINS } from './plugins.ts'
import BrowserClientModules from './client-modules-browser.ts'
import { seedFilesystem, DEPLOY_ROOT } from './seed.ts'
import { installNodeGlobals } from '../node/registry.ts'
import { installedPatchFiles, registerInstalledModules } from '../plugins/manager.ts'
import { attachPersistence, type PersistenceHandle } from '../vfs/persist.ts'
import { volume } from '../vfs/volume.ts'
import { toText } from '../node/binary.ts'
import { pathToFileURL } from '../node/misc.ts'
import browserPatchSource from './browser.patch.yml?raw'

/** What the boot produced, for the page to wire the transport onto. */
export interface HostBoot {
  ctx: Context
  persistence: PersistenceHandle
  /** Diagnostics collected while the tree settled; empty on a clean boot. */
  warnings: string[]
}

/**
 * Fiber states, mirrored from cordis's `const enum` (which inlines away and so
 * cannot be imported at runtime). The web shell keeps the same mirror.
 */
const FIBER_STATE_LABELS: Record<number, string> = {
  0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed', 5: 'unloading',
}

/** VFS path of the root composition the include mounts over. */
const ROOT_CONFIG = `${DEPLOY_ROOT}/cordis.yml`

/**
 * Start the host.
 * @returns the settled context plus the persistence handle.
 * @throws when the plugin tree cannot settle; the caller renders the failure.
 */
export async function bootHost(): Promise<HostBoot> {
  installNodeGlobals()
  const persistence = await attachPersistence(volume)
  seedFilesystem()

  // Browser-only plugins are addressed by the composition through `browser:*`
  // specifiers; register them before any entry can import one.
  for (const [specifier, namespace] of Object.entries(BROWSER_PLUGINS)) {
    registerRuntimeModule(specifier, namespace)
  }
  registerRuntimeModule('browser:client-modules', { default: BrowserClientModules, name: 'client-modules-browser' })

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${DEPLOY_ROOT}/`).href
  ctx.provide('dshHomePath', dshHomePath)

  await ctx.plugin(Loader)
  const loader = ctx.loader
  // The internal contract must exist before any entry: `EntryTree.import`
  // falls back to a bare dynamic import when it is unset, which in a browser
  // resolves nothing.
  loader.internal = hostModuleSystem as never
  loader.builtins.group = Group
  loader.builtins.include = Include

  // Packages installed in a previous session join the first composition rather
  // than arriving through a post-boot reload.
  registerInstalledModules()

  const warnings: string[] = []
  const patches = [
    ...loadOverlayPatches('dsh-web', `${DEPLOY_ROOT}/bundles/dsh-base/cordis.patch.yml`),
    ...loadOverlayPatches('dsh-web', `${DEPLOY_ROOT}/bundles/dsh-web-app/cordis.patch.yml`),
    ...loadOverlayPatches('dsh-web', `${DEPLOY_ROOT}/bundles/browser/cordis.patch.yml`),
    // Installed plugin bundles, in the order they were added — the same place
    // `dsh.profile.bundles` puts them.
    ...installedPatchFiles().flatMap(({ label, path }) => {
      try {
        return loadOverlayPatches(label, path)
      } catch (error) {
        warnings.push(`${label}: patch layer failed to load (${error instanceof Error ? error.message : String(error)})`)
        return []
      }
    }),
    // The user's own layer, last, exactly as a profile's patch file is.
    ...(loadOptionalPatches('dsh-web', dshHomePath('cordis.patch.yml')) ?? []),
  ]

  await mountRootInclude(ctx, ROOT_CONFIG, patches)
  await ctx.get('loader')?.await()

  for (const entry of loader.entries()) {
    if (entry.disabled === true) continue
    const row = entry.options.id ?? entry.options.name
    if (entry.fiber === undefined) {
      warnings.push(`${row}: plugin module failed to load`)
      continue
    }
    const label = FIBER_STATE_LABELS[entry.fiber.state] ?? `state ${String(entry.fiber.state)}`
    if (label === 'active') continue
    const missing = Object.keys(entry.fiber.inject ?? {}).filter(service => ctx.get(service) === undefined)
    warnings.push(`${row}: ${label}${missing.length > 0 ? ` (waiting for ${missing.join(', ')})` : ''}`)
  }

  return { ctx, persistence, warnings }
}

/** The browser overlay patch text, exposed so the seed can write it into the VFS. */
export const BROWSER_PATCH = browserPatchSource

/** Read a VFS file as text (used by the boot diagnostics UI). */
export function readVfsText(path: string): string {
  return toText(volume.readFile(path))
}
