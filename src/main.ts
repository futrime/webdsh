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
import { disableAllPlugins, installedPluginNames, installPluginManager } from './plugins/manager.ts'
import { installWindowApi } from './api.ts'
import { installTerminal } from './terminal/xterm-panel.ts'
import { installPluginsPanel } from './terminal/plugins-panel.ts'
import { SHELL_ENTRY, SHELL_STYLES } from './generated/shell-assets.ts'
import { renderBootFailure, renderBootProgress, type BootRecovery } from './boot-screen.ts'
import { attachPersistence } from './vfs/persist.ts'
import { volume } from './vfs/volume.ts'

/** Load the shell's stylesheets, which its entry chunk expects to already be present. */
function injectStyles(): void {
  for (const href of SHELL_STYLES) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL(href, document.baseURI).href
    document.head.append(link)
  }
}

/**
 * What the failure screen can offer.
 *
 * An installed plugin can break the composition in ways no shim prevents — a
 * row id that collides with one this profile already defines, for instance —
 * and the user needs a way back that does not also delete their files.
 * @returns the recoveries, most conservative first.
 */
async function bootRecoveries(): Promise<BootRecovery[]> {
  const recoveries: BootRecovery[] = []
  try {
    const installed = installedPluginNames()
    if (installed.length > 0) {
      recoveries.push({
        label: 'Disable installed plugins',
        description: `Turns off ${installed.join(', ')} and starts without them. Your files and sessions are kept.`,
        run: async () => {
          disableAllPlugins()
          await (await attachPersistence(volume)).flush()
        },
      })
    }
  } catch {
    // The roster is unreadable; the reset below is still offered.
  }
  recoveries.push({
    label: 'Reset browser storage',
    description: 'Erases the virtual filesystem, settings, and sessions for this site. This cannot be undone.',
    run: async () => {
      await (await attachPersistence(volume)).clear()
      localStorage.clear()
    },
  })
  return recoveries
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

    const plugins = installPluginManager(ctx)

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

    // A user here has no machine to open a shell on: the filesystem the agent
    // works in exists only in this page. The terminal is that missing window,
    // and it runs the agent's own shell rather than an imitation of it.
    const terminal = installTerminal({ kind: 'http', url: new URL('vm/dsh.ext2', document.baseURI).href })
    // The shipped Settings page lists plugins but cannot add one, because on a
    // machine that is a shell command and there is no shell outside this page.
    const pluginsPanel = installPluginsPanel(plugins)
    terminal.pluginsButton.addEventListener('click', () => { pluginsPanel.toggle() })
    // Published so an automated browser can drive the machine the way a user
    // does, rather than reaching past the terminal into the engine.
    ;(globalThis as { dsh?: Record<string, unknown> }).dsh = {
      ...((globalThis as { dsh?: Record<string, unknown> }).dsh ?? {}),
      terminal,
    }
  } catch (error) {
    console.error('[dsh-web] boot failed:', error)
    renderBootFailure(error, await bootRecoveries())
  }
}

void main()
