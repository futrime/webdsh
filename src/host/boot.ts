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
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { hostModuleSystem, loadWorkerEntry, registerRuntimeModule } from './module-system.ts'
import { BROWSER_PLUGINS } from './plugins.ts'
import BrowserClientModules from './client-modules-browser.ts'
import { seedFilesystem, DEPLOY_ROOT } from './seed.ts'
import { installNodeGlobals } from '../node/registry.ts'
import { setWorkerEntryLoader } from '../node/worker_threads.ts'
import { composePatchLayers, registerInstalledModules } from '../plugins/manager.ts'
import { attachPersistence, type PersistenceHandle } from '../vfs/persist.ts'
import { volume } from '../vfs/volume.ts'
import { toText } from '../node/binary.ts'
import { pathToFileURL } from '../node/misc.ts'
import browserPatchSource from './browser.patch.yml?raw'
import * as machinePlugin from '../../packages/dsh-web-machine/src/index.ts'
import * as installPlugin from '../../packages/dsh-web-plugins/src/index.ts'
import * as starPlugin from '../../packages/dsh-web-star/src/index.ts'
import * as networkPlugin from '../../packages/dsh-web-network/src/index.ts'
import * as filesPlugin from '../../packages/dsh-web-files/src/index.ts'

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
  // Durable workflows and Code Mode both spawn a worker naming its entry by
  // filesystem path; only the host module system can turn that back into
  // something loadable, so it has to be handed over before either can run.
  setWorkerEntryLoader(loadWorkerEntry)
  const persistence = await attachPersistence(volume)
  seedFilesystem()

  // Browser-only plugins are addressed by the composition through `browser:*`
  // specifiers; register them before any entry can import one.
  for (const [specifier, namespace] of Object.entries(BROWSER_PLUGINS)) {
    registerRuntimeModule(specifier, namespace)
  }
  registerRuntimeModule('browser:client-modules', { default: BrowserClientModules, name: 'client-modules-browser' })
  // The shipped plugins' node halves, addressed by package name so their rows
  // resolve the way any other plugin's would.
  registerRuntimeModule('@dsh-web/machine', machinePlugin)
  registerRuntimeModule('@dsh-web/plugin-install', installPlugin)
  registerRuntimeModule('@dsh-web/star', starPlugin)
  registerRuntimeModule('@dsh-web/network', networkPlugin)
  registerRuntimeModule('@dsh-web/files', filesPlugin)

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
  // Composed where `reload` composes it too, so a plugin toggle recomposes the
  // same tree this boot built rather than a subset of it.
  const patches = composePatchLayers(message => warnings.push(message))

  // The watchdog covers entry CREATION as well as the settle: mounting the
  // root include awaits every child entry's init, so a row that never returns
  // from its module import hangs here, before `loader.await()` is ever reached.
  await withWatchdog(ctx, warnings, () => mountTolerantly(ctx, patches, warnings))

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

/**
 * How long the tree may take to settle before the boot gives up on it.
 *
 * `loader.await()` has no timeout by design — on a machine, a slow row is
 * still making progress. In a page a wedged row is indistinguishable from a
 * blank tab, so the boot bounds the wait and reports which rows were still
 * loading instead of hanging forever. A plugin that never settles then costs
 * its own surface, not the whole app.
 */
const SETTLE_TIMEOUT_MS = 30_000

/**
 * Mount the composition, disabling rows that cannot load.
 *
 * Upstream fails the whole boot when a row fails, which is right on a machine:
 * every row it composes is known to work there, so a failure is a
 * misconfiguration to fix. In a browser the composition can contain a plugin
 * that is *inherently* incompatible — one whose contract is a local server, a
 * native binary, or a spawned toolchain — and a blank page is a worse answer
 * than starting without it.
 *
 * So a failed mount is retried with the offending rows disabled, and each one
 * is reported. The retry is bounded and only ever removes rows the loader
 * itself named, so a composition that is broken for some other reason still
 * fails loudly.
 * @param ctx - the booting context.
 * @param patches - the composed patch layers.
 * @param warnings - sink for the per-row diagnostics.
 */
async function mountTolerantly(ctx: Context, patches: PatchOptions[], warnings: string[]): Promise<void> {
  const disabled = new Set<string>()
  for (let attempt = 0; attempt <= MAX_MOUNT_RETRIES; attempt++) {
    const layered = disabled.size === 0
      ? patches
      : [...patches, ...[...disabled].map(id => ({ id, disabled: true }))]
    try {
      await mountRootInclude(ctx, ROOT_CONFIG, layered)
      await ctx.get('loader')?.await()
      return
    } catch (error) {
      const failing = [...failingEntryIds(error)].filter(([id]) => id !== 'include' && !disabled.has(id))
      if (failing.length === 0 || attempt === MAX_MOUNT_RETRIES) throw error
      for (const [id, reason] of failing) {
        disabled.add(id)
        warnings.push(`${id}: disabled — ${reason}`)
      }
      // Drop the failed include so the retry mounts a clean tree.
      const loader = ctx.get('loader')
      const stale = loader === undefined ? undefined : [...loader.entries()].find(entry => entry.options.name === 'cordis:include')
      if (stale !== undefined && loader !== undefined) {
        await loader.remove(stale.options.id as string).catch(() => undefined)
      }
    }
  }
}

/**
 * Entry ids the loader named in a failed mount, each with the reason it gave.
 * @param error - the rejection from the mount.
 * @returns id → reason, deduplicated.
 */
function failingEntryIds(error: unknown): Map<string, string> {
  const found = new Map<string, string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !(value instanceof Error)) return
    for (const match of value.message.matchAll(/loader entry (\S+) \(([^)]*)\): ([^\n]*)/g)) {
      if (!found.has(match[1])) found.set(match[1], `${match[2]}: ${match[3]}`.slice(0, 300))
    }
    if (value instanceof AggregateError) for (const member of value.errors) visit(member, depth + 1)
    visit((value as { cause?: unknown }).cause, depth + 1)
  }
  visit(error, 0)
  return found
}

/** How many times a failed mount is retried with the offending rows disabled. */
const MAX_MOUNT_RETRIES = 4

/**
 * Run the composition under a deadline.
 * @param ctx - the booting context.
 * @param warnings - sink for the timeout diagnostic.
 * @param body - mount and settle the tree.
 */
async function withWatchdog(ctx: Context, warnings: string[], body: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { resolve('timeout') }, SETTLE_TIMEOUT_MS)
  })
  try {
    const outcome = await Promise.race([body().then(() => 'settled' as const), timeout])
    if (outcome !== 'timeout') return
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const loader = ctx.get('loader')
  const stuck = loader === undefined
    ? []
    : [...loader.entries()]
      .filter(entry => entry.disabled !== true && entry.fiber?.state !== 2)
      .map(entry => `${entry.options.id ?? entry.options.name} (${entry.options.name})`)
  warnings.push(
    `the plugin tree did not settle within ${String(SETTLE_TIMEOUT_MS / 1000)}s`
    + (stuck.length > 0 ? `; still loading: ${stuck.join(', ')}` : '; no entry reported a state'),
  )
}

/** The browser overlay patch text, exposed so the seed can write it into the VFS. */
export const BROWSER_PATCH = browserPatchSource

/** Read a VFS file as text (used by the boot diagnostics UI). */
export function readVfsText(path: string): string {
  return toText(volume.readFile(path))
}
