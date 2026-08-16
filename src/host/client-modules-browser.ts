/**
 * Browser replacement for the node half of `@deepseek-ai/dsh-client-modules`.
 *
 * Upstream's node half resolves each `dsh.client` package on disk, hashes its
 * built bundle, serves it over HTTP, and taps `index.html` to inject
 * `window.__DSH_BOOT__`. None of that has a browser analogue, but the *wire* it
 * produces does — and the wire is the whole contract the shell shares with the
 * host, so this plugin reproduces it exactly:
 *
 * - Shipped client halves are static assets emitted by `scripts/assemble.ts`,
 *   so their rows carry a plain relative URL and a build-time content hash.
 * - A plugin installed at runtime has no static asset, so its bundle is read
 *   out of the virtual filesystem and published as a `blob:` URL — which the
 *   shell's default `<script src>` loader accepts unchanged.
 *
 * The service face matches upstream's `ctx.clientModules` so consumers
 * (the plugin-inventory UI, the HMR node half) keep working.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CLIENT_ROWS } from '../generated/client-manifest.ts'
import { sha1 } from '../node/hash.ts'
import { Buffer, toBytes } from '../node/binary.ts'
import { volume } from '../vfs/volume.ts'

/** One shipped client half, as `scripts/assemble.ts` recorded it. */
export interface ClientManifestRow {
  id: string
  url: string
  rev: string
  inject: string[]
  immediately: boolean
}

/** The wire row the shell's boot manifest carries. */
export interface WebBootEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

/** The composed entry graph published as `window.__DSH_BOOT__`. */
export interface WebBootGraph {
  rev: string
  entries: WebBootEntry[]
}

// The `clientModules` context key is declared by `@deepseek-ai/dsh-client-modules`
// (whose types this build still consumes), so this plugin provides that key
// rather than redeclaring it with a different class.

/** Short content hash, matching upstream's revision scheme. */
function shortHash(input: Uint8Array | string): string {
  return Buffer.from(sha1(toBytes(input))).toString('hex').slice(0, 12)
}

/**
 * A runtime-installed plugin's client half, discovered in the virtual
 * filesystem. `installPluginPackage` writes both the manifest and the bundle,
 * so the lookup is a plain read.
 */
function readInstalledClientHalf(packageName: string): { bundle: Uint8Array, inject: string[], immediately: boolean } | undefined {
  const manifestPath = `/opt/dsh/plugins/node_modules/${packageName}/package.json`
  if (!volume.exists(manifestPath)) return undefined
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(Buffer.from(volume.readFile(manifestPath)).toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const dsh = manifest.dsh
  if (typeof dsh !== 'object' || dsh === null) return undefined
  const declaration = (dsh as Record<string, unknown>).client as { platform?: string, inject?: string[], immediately?: boolean } | undefined
  if (declaration?.platform !== 'web') return undefined
  const exportsField = manifest.exports as Record<string, unknown> | undefined
  const clientExport = exportsField?.['./client']
  const relativePath = typeof clientExport === 'string'
    ? clientExport
    : typeof clientExport === 'object' && clientExport !== null
      ? (clientExport as Record<string, unknown>).default as string | undefined
      : undefined
  if (relativePath === undefined) return undefined
  const bundlePath = `/opt/dsh/plugins/node_modules/${packageName}/${relativePath.replace(/^\.\//, '')}`
  if (!volume.exists(bundlePath)) {
    // The package promised a browser half and shipped a tarball without it —
    // an upstream packaging slip (its client build did not run before publish).
    // Upstream fails the whole boot here; skipping keeps the plugin's host half
    // working, so say what happened rather than silently dropping the surface.
    console.warn(
      `[plugins] ${packageName} declares a web client half at ${relativePath}, but its published package does not contain that file.`
      + ' Its host half is loaded; its browser surface is unavailable until the package ships the built bundle.',
    )
    return undefined
  }
  return {
    bundle: volume.readFile(bundlePath),
    inject: declaration.inject ?? [],
    immediately: declaration.immediately === true,
  }
}

/** The `ctx.clientModules` service. */
export class BrowserClientModules extends Service {
  static inject = ['loader']

  private readonly rows = new Map<string, WebBootEntry>()
  private readonly blobUrls = new Map<string, string>()
  private readonly graphListeners = new Set<() => void>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private composed: WebBootGraph
  private readonly shipped = new Map<string, ClientManifestRow>()

  /**
   * Build the table from the loader's current entries.
   * @param ctx - plugin context carrying the loader.
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    for (const row of CLIENT_ROWS) this.shipped.set(row.id, row)
    this.scan()
    this.composed = this.compose()
    // Entry lifecycle changes (a plugin enabled or disabled at runtime) recompose
    // the graph, exactly as upstream's incremental scan does.
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.entry === undefined) return
      queueMicrotask(() => {
        if (this.scan()) {
          this.composed = this.compose()
          this.notifyGraphChanged()
        }
      })
    })
  }

  /**
   * Reconcile the table against the live loader entries.
   * @returns whether the table changed.
   */
  private scan(): boolean {
    const live = new Set<string>()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.fiber === undefined || entry.disabled === true) continue
      live.add(entry.options.name)
    }
    let changed = false
    for (const name of live) {
      if (this.rows.has(name)) continue
      const row = this.rowFor(name)
      if (row === undefined) continue
      this.rows.set(name, row)
      changed = true
    }
    for (const name of [...this.rows.keys()]) {
      if (live.has(name)) continue
      this.rows.delete(name)
      const url = this.blobUrls.get(name)
      if (url !== undefined) {
        URL.revokeObjectURL(url)
        this.blobUrls.delete(name)
      }
      changed = true
    }
    return changed
  }

  /** Build the wire row for one package name, or undefined when it has no web client half. */
  private rowFor(name: string): WebBootEntry | undefined {
    const shipped = this.shipped.get(name)
    if (shipped !== undefined) {
      return {
        id: shipped.id,
        url: shipped.url,
        rev: shipped.rev,
        ...(shipped.inject.length > 0 ? { inject: shipped.inject } : {}),
        ...(shipped.immediately ? { immediately: true } : {}),
      }
    }
    const installed = readInstalledClientHalf(name)
    if (installed === undefined) return undefined
    const rev = shortHash(installed.bundle)
    const blob = URL.createObjectURL(new Blob([installed.bundle as BlobPart], { type: 'text/javascript' }))
    this.blobUrls.set(name, blob)
    return {
      id: name,
      url: blob,
      rev,
      ...(installed.inject.length > 0 ? { inject: installed.inject } : {}),
      ...(installed.immediately ? { immediately: true } : {}),
    }
  }

  private compose(): WebBootGraph {
    const entries = [...this.rows.values()]
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  /** The graph the shell reads as `window.__DSH_BOOT__`. */
  graph(): WebBootGraph {
    return this.composed
  }

  /** Upstream parity: the on-disk bundle path. There is none here. */
  clientPath(): undefined {
    return undefined
  }

  /** Upstream parity: re-hash one bundle. Static assets never change in place. */
  rebuilt(): undefined {
    return undefined
  }

  /** Subscribe to bundle rebuilds (never fires in a static deployment). */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  /** Subscribe to graph recomposition. */
  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  private notifyGraphChanged(): void {
    for (const listener of this.graphListeners) {
      try {
        listener()
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }
}

/** Stable Cordis plugin name. */
export const name = 'client-modules-browser'

export default BrowserClientModules
