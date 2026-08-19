/**
 * The capabilities the shipped plugins draw on.
 *
 * A client plugin runs inside the surface's own bundle graph and cannot import
 * this app's modules — the two are separate builds, loaded by different
 * loaders. What it can do is read a capability the page published, which is
 * the same shape of seam the surface itself uses for `window.__DSH_BOOT__`.
 *
 * Only capabilities go through here, never UI: the terminal plugin owns how a
 * terminal looks and where it lives, and this owns only the fact that there is
 * a runtime to attach one to. The runtime in particular has to be shared
 * rather than booted per consumer, because two containers in a tab would be
 * two different machines and the whole point is that there is one.
 */

import { bootRuntime, runtimeSupported, setShellMode, shellMode, startShell, type ShellMode } from '../runtime/webcontainer.ts'
import { ripgrep } from '../runtime/ripgrep.ts'
import type { PluginManager } from '../plugins/manager.ts'
import { volume } from '../vfs/volume.ts'
import { dirname } from '../node/path.ts'
import {
  ALTERNATIVE_PROXY_TEMPLATE,
  DEFAULT_PROXY_TEMPLATE,
  proxiedOrigins,
  proxyConfig,
  setProxyConfig,
  testProxy,
  type ProxyConfig,
} from '../net/cors-proxy.ts'

/** Where an uploaded plugin tarball is staged before the installer reads it. */
const UPLOAD_DIR = '/tmp/dsh-plugin-uploads'

/**
 * Publish the runtime, for whoever draws a terminal on it.
 *
 * The emulator travels with the capability rather than with the plugin: it is
 * a large dependency, the app already bundles it, and a plugin shipping its
 * own copy would double it for no gain.
 */
export function publishRuntimeBridge(): void {
  ;(globalThis as Record<string, unknown>).__DSH_WEB_RUNTIME__ = {
    boot: async (onProgress?: (step: string) => void) => bootRuntime(onProgress),
    startShell,
    unavailable: () => {
      const support = runtimeSupported()
      return support.ok ? undefined : support.reason ?? 'the runtime is unavailable'
    },
    // The search backend, published so a test can exercise the same code the
    // `grep` and `glob` tools reach through the subprocess seam.
    search: (args: string[], cwd?: string) => ripgrep(args, cwd),
    // Which shell a command's script is handed to. A plugin may swap it — see
    // `packages/dsh-web-jsh` — and the runtime is a page capability, so the
    // choice has to be reachable from outside this bundle.
    shellMode: (): ShellMode => shellMode(),
    setShellMode: (next: ShellMode): void => { setShellMode(next) },
    terminal: async () => {
      const [{ Terminal }, { FitAddon }, styles] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css?raw'),
      ])
      return { Terminal, FitAddon, styles: styles.default }
    },
  }
}

/**
 * Publish the page's CORS policy, for whoever offers to edit it.
 *
 * The policy is the app's rather than a plugin's for the same reason the
 * runtime is: `src/net` applies it to every cross-origin request the page
 * makes, long before any plugin has mounted, and a second copy of the setting
 * would be a second answer to the same question. What a plugin owns is the
 * page it is edited on.
 */
export function publishNetworkBridge(): void {
  ;(globalThis as Record<string, unknown>).__DSH_WEB_NETWORK__ = {
    config: (): ProxyConfig => proxyConfig(),
    setConfig: (next: Partial<ProxyConfig>): ProxyConfig => setProxyConfig(next),
    test: (template?: string) => testProxy(template),
    defaults: { template: DEFAULT_PROXY_TEMPLATE, alternative: ALTERNATIVE_PROXY_TEMPLATE },
    // Which origins this session actually needed the proxy for. It is the
    // honest answer to "is it being used", and it is the only place the page
    // reports that a request left through a third party.
    proxied: (): string[] => proxiedOrigins(),
  }
}

/**
 * Publish the installer, for whoever offers to add a plugin.
 * @param manager - the app's plugin manager.
 */
export function publishInstallerBridge(manager: PluginManager): void {
  ;(globalThis as Record<string, unknown>).__DSH_WEB_PLUGINS__ = {
    install: (spec: string) => manager.install(spec),
    list: () => manager.list(),
    enable: (name: string) => manager.enable(name),
    disable: (name: string) => manager.disable(name),
    remove: (name: string) => manager.remove(name),
    stage: (name: string, bytes: ArrayBuffer) => {
      // Staged into the filesystem so the installer sees exactly the shape it
      // would for any other local path, rather than a second upload code path.
      const path = `${UPLOAD_DIR}/${name}`
      volume.mkdirp(dirname(path))
      volume.writeFile(path, new Uint8Array(bytes))
      return path
    },
  }
}
