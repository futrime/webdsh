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
import { bootRuntime, runtimeSupported } from './runtime/webcontainer.ts'
import { bootMachine } from './runtime/v86.ts'
import { isEmulated } from './runtime/selection.ts'
import {
  publishFilesBridge, publishInstallerBridge, publishMachineBridge, publishNetworkBridge, publishRuntimeBridge,
} from './host/bridges.ts'
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
    // Before the host, not after it: a plugin reads this while it applies, and
    // the host applying plugins is what `bootHost` does. The runtime bridge
    // closes over nothing the host provides, so there is nothing to wait for —
    // the tool row reads it while it mounts, and a bridge published later
    // would mean it silently read nothing.
    publishRuntimeBridge()
    // The same reason, and one more: the CORS policy is already in force —
    // `installVirtualNetwork` applies it to every cross-origin request — so
    // what this publishes is the ability to see and change it, and the host's
    // own first requests are already covered whether or not it is ever read.
    publishNetworkBridge()
    // And the filesystem the file browser draws: it routes to whichever of the
    // two filesystems is the real one right now, which is a question only this
    // app can answer.
    publishFilesBridge()
    // And which machine this session is, which the Runtime panel both reports
    // and changes. Published before the host for the same reason the runtime
    // is: the tool row reads the selection while it applies.
    publishMachineBridge()

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
    // The terminal and the install form are plugins, not parts of this app, so
    // what the app owes them is the capability and nothing else. The installer
    // one waits for the manager it hands out; the runtime one was published
    // before the host, because a plugin needed it during boot.
    publishInstallerBridge(plugins)

    // Plugin-registered HTTP routes (a plugin serving its own assets) are only
    // reachable through a Service Worker, because an `<img src>` never passes
    // through a patched `fetch`. Its absence costs those assets and nothing else.
    progress.step('Routing plugin assets')
    const router = await installRequestRouter()
    // The current document was fetched without the isolation headers the
    // worker adds. Once reload starts, continuing to import the client races
    // that navigation and WebKit reports a misleading module-import failure.
    if (router.reloading) return

    // Started here rather than on first use, and not waited for. Whether the
    // machine can run at all is something the shell and the agent's file
    // tools consult before every command, and finding out during the first one
    // means that command fails for a reason the user cannot act on. Capability
    // checks still cannot prove that the remote runtime frame, workers and
    // filesystem will finish starting on this particular device and network.
    //
    // Which machine is whichever one this deployment is set to. An emulated
    // runtime is started here for the same reason and one more: choosing it is
    // already the decision to download an operating system, so starting it now
    // means it is at a prompt when the user first asks it for something rather
    // than a minute after.
    if (isEmulated()) void bootMachine().catch(() => undefined)
    else if (runtimeSupported().ok) void bootRuntime().catch(() => undefined)

    progress.step('Loading the web client')
    injectStyles()
    // The published shell bundle: its own entry finds #root and runs the
    // client-side boot against the manifest published above.
    await import(/* @vite-ignore */ new URL(SHELL_ENTRY, document.baseURI).href)
    progress.done()
  } catch (error) {
    console.error('[dsh-web] boot failed:', error)
    renderBootFailure(error, await bootRecoveries())
  }
}

void main()
