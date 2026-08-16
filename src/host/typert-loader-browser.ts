/**
 * Browser replacement for `@deepseek-ai/dsh-typert-loader`.
 *
 * Upstream resolves each mounted package on disk (`require.resolve(
 * '<pkg>/package.json')`), reads its `exports["./typert"]`, and imports the
 * artifact by file URL. None of those steps exists in a page, but the artifacts
 * themselves are ordinary modules — so `scripts/assemble.ts` records which
 * packages export one and this loader imports them through the bundler.
 *
 * The behavior it preserves is the part that matters: a manifest is registered
 * only while its package is a live, enabled loader entry, and withdrawn when
 * that entry goes away. That is what keeps the API gateway's strict codecs in
 * step with the composition.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { TYPERT_MANIFESTS } from '../generated/typert-manifests.ts'

/** Stable Cordis plugin name. */
export const name = 'typert-loader-browser'

/** Services this loader drives. */
export const inject = ['typert', 'loader']

/** Plugin config: packages to register regardless of whether they are mounted. */
export interface Config {
  /** Extra package names whose manifests are always registered. */
  packages: string[]
}

export const Config: z<Config> = z.object({
  packages: z.array(String).default([]),
})

/**
 * Mirror the live loader entries into the Typert registry.
 * @param ctx - plugin context carrying `typert` and `loader`.
 * @param config - explicit package artifacts in addition to loader entries.
 */
export function apply(ctx: Context, config: Config): void {
  const configured = new Set(config.packages)
  /** package name → withdraw function for its registered manifest. */
  const registered = new Map<string, () => void>()
  /** package name → in-flight registration. */
  const pending = new Map<string, Promise<void>>()
  let active = true

  ctx.effect(function* () {
    yield () => {
      active = false
      for (const withdraw of registered.values()) withdraw()
      registered.clear()
    }
  }, 'typert loader lifetime')

  /** Whether `entryName` is a live, enabled loader entry (or explicitly configured). */
  const qualifies = (entryName: string): boolean => {
    if (configured.has(entryName)) return true
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name === entryName && entry.fiber !== undefined && entry.disabled !== true) return true
    }
    return false
  }

  /** Register or withdraw one package's manifest. */
  const reconcile = (entryName: string): void => {
    if (!qualifies(entryName)) {
      const withdraw = registered.get(entryName)
      if (withdraw !== undefined) {
        registered.delete(entryName)
        withdraw()
      }
      return
    }
    if (registered.has(entryName) || pending.has(entryName)) return
    const load = TYPERT_MANIFESTS[entryName]
    if (load === undefined) return
    const task = load().then((module) => {
      if (!active || !qualifies(entryName) || registered.has(entryName)) return
      const manifest = (module as { TYPERT?: unknown }).TYPERT
      if (manifest === undefined) {
        throw new Error(`typert-loader: ${entryName} exports "./typert" but its module has no TYPERT manifest`)
      }
      registered.set(entryName, ctx.typert.register(manifest as never))
    }).catch((error: unknown) => {
      ctx.logger.error(`typert-loader: ${entryName} manifest failed to register:`, error)
    }).finally(() => { pending.delete(entryName) })
    pending.set(entryName, task)
  }

  // Follow entry lifecycle, then seed from the entries already mounted.
  ctx.on('internal/plugin', (fiber) => {
    const entryName = fiber.entry?.options.name
    if (entryName === undefined) return
    queueMicrotask(() => { reconcile(entryName) })
  })
  for (const entryName of new Set([...configured, ...Object.keys(TYPERT_MANIFESTS)])) reconcile(entryName)
}
