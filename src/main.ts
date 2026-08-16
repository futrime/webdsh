/**
 * Page entry.
 *
 * Ordering is the whole job: the Node platform emulation and the virtual
 * network must exist before any dsh module evaluates, the host tree must be
 * settled before the shell reads `window.__DSH_BOOT__`, and the shell bundle
 * must be the last thing imported so its boot kernel finds a live host.
 */

// Must be first: several dsh modules read `process` while their bodies evaluate.
import './node/install-globals.ts'
import { attachHost, installVirtualNetwork } from './net/virtual-network.ts'
import { installRequestRouter } from './net/service-worker.ts'
import { bootHost } from './host/boot.ts'
import { installPluginManager } from './plugins/manager.ts'
import { installWindowApi } from './api.ts'
import { SHELL_ENTRY, SHELL_STYLES } from './generated/shell-assets.ts'
import { renderBootFailure, renderBootProgress } from './boot-screen.ts'

/** Load the shell's stylesheets, which its entry chunk expects to already be present. */
function injectStyles(): void {
  for (const href of SHELL_STYLES) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL(href, document.baseURI).href
    document.head.append(link)
  }
}

/** Boot the host, publish the client graph, then hand the page to the shell. */
async function main(): Promise<void> {
  const progress = renderBootProgress()
  try {
    installVirtualNetwork()

    progress.step('Starting the harness host')
    const { ctx, persistence, warnings } = await bootHost()
    attachHost(ctx)
    // Kept on the page so an automated browser (and a user filing a report) can
    // read exactly which rows did not activate.
    ;(globalThis as { __DSH_WARNINGS__?: string[] }).__DSH_WARNINGS__ = warnings
    for (const warning of warnings) console.warn(`[dsh-web] ${warning}`)
    installWindowApi(ctx, persistence)

    progress.step('Composing the client plugin graph')
    const clientModules = ctx.get('clientModules')
    if (clientModules === undefined) {
      throw new Error('host booted without a client module table; the `modules` row failed to activate')
    }
    ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = clientModules.graph()

    installPluginManager(ctx)

    // Plugin-registered HTTP routes (a plugin serving its own assets) are only
    // reachable through a Service Worker, because an `<img src>` never passes
    // through a patched `fetch`. Its absence costs those assets and nothing else.
    progress.step('Routing plugin assets')
    await installRequestRouter()

    progress.step('Loading the web client')
    injectStyles()
    // The published shell bundle: its own entry finds #root and runs the
    // client-side boot against the manifest published above.
    await import(/* @vite-ignore */ new URL(SHELL_ENTRY, document.baseURI).href)
    progress.done()
  } catch (error) {
    console.error('[dsh-web] boot failed:', error)
    renderBootFailure(error)
  }
}

void main()
