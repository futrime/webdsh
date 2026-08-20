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

import {
  bootRuntime, runtimeFs, runtimePersistence, runtimeReady, runtimeSupported,
  setShellMode, shellMode, startShell, toContainerPath, WORKDIR, WORKSPACE, type ShellMode,
} from '../runtime/webcontainer.ts'
import { ripgrep } from '../runtime/ripgrep.ts'
import type { PluginManager } from '../plugins/manager.ts'
import { volume } from '../vfs/volume.ts'
import { zipSync } from 'fflate'
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

/** One row of a directory listing. */
export interface FileEntry {
  /** Base name, as it is shown. */
  name: string
  /** Absolute path, because a browser must never join path segments itself. */
  path: string
  /** Whether this row can be entered. */
  directory: boolean
}

/**
 * Join a directory and a name into an absolute path.
 * @param directory - the parent, absolute.
 * @param name - one path segment.
 * @returns the child's absolute path.
 */
function child(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory.replace(/\/+$/, '')}/${name}`
}

/**
 * Publish the filesystem, for whoever draws a file browser on it.
 *
 * The machine has two filesystems and the honest answer about which one a file
 * is in changes with the runtime: when the container is up it holds the user's
 * workspace and the agent's commands run against it, and when it could not
 * start the page's own volume answers instead. Every call below picks the same
 * way the agent's file tools do, so a browser drawn on this shows the files the
 * agent is actually looking at rather than a second set that resembles them.
 *
 * There is no `stat` in the container's filesystem API, so a listing carries a
 * name and whether it can be entered, and nothing it cannot know — a size
 * column that was populated only when the container was down would be worse
 * than no size column.
 */
export function publishFilesBridge(): void {
  ;(globalThis as Record<string, unknown>).__DSH_WEB_FILES__ = {
    /** Where the user's files start. */
    root: () => WORKSPACE,
    /** The directory above it, which is as far up as a browser here may go. */
    home: () => WORKDIR,

    /** Which filesystem is answering, so a panel can say so. */
    backing: async (): Promise<'runtime' | 'page'> => (await runtimeReady() ? 'runtime' : 'page'),

    list: async (path: string): Promise<FileEntry[]> => (await listAnywhere(path)).sort(byKindThenName),

    read: async (path: string): Promise<Uint8Array> => readAnywhere(path),

    write: async (path: string, bytes: Uint8Array): Promise<void> => {
      if (await runtimeReady()) {
        await (await runtimeFs()).writeFile(toContainerPath(path), bytes)
        // The same signal a command sends: a file written here is the user's
        // work, and without this it is gone at the next reload.
        runtimePersistence()?.touch()
        return
      }
      volume.mkdirp(dirname(path))
      volume.writeFile(path, bytes)
    },

    mkdir: async (path: string): Promise<void> => {
      if (await runtimeReady()) {
        await (await runtimeFs()).mkdir(toContainerPath(path), { recursive: true })
        runtimePersistence()?.touch()
        return
      }
      volume.mkdirp(path)
    },

    remove: async (path: string): Promise<void> => {
      if (await runtimeReady()) {
        await (await runtimeFs()).rm(toContainerPath(path), { recursive: true, force: true })
        runtimePersistence()?.touch()
        return
      }
      volume.rm(path, { recursive: true, force: true })
    },

    /**
     * Pack paths into a zip, walking whatever directories are among them.
     *
     * Here rather than in the plugin for the reason everything else here is:
     * the app already carries `fflate` — `dsh.exportFs()` uses it — and a
     * client bundle importing its own copy would ship a second one into a page
     * that has one. It is also the only side that can walk *whichever* of the
     * two filesystems is live.
     *
     * Entry names are relative to the directory the selection was made in, so
     * unpacking the result reproduces what the panel was showing rather than a
     * chain of empty parents.
     * @param paths - files and directories, absolute.
     * @param base - the directory names are relative to.
     * @returns the zip's bytes.
     */
    archive: async (paths: string[], base: string): Promise<Uint8Array> => {
      const entries: Record<string, Uint8Array> = {}
      const prefix = base.endsWith('/') ? base : `${base}/`
      const relative = (path: string): string => (path.startsWith(prefix) ? path.slice(prefix.length) : baseNameOf(path))

      const take = async (path: string, directory: boolean): Promise<void> => {
        if (!directory) {
          entries[relative(path)] = await readAnywhere(path)
          return
        }
        const children = await listAnywhere(path)
        // An empty directory still belongs in the archive, and a zip records
        // one as a name ending in a slash.
        if (children.length === 0) {
          entries[`${relative(path)}/`] = new Uint8Array(0)
          return
        }
        for (const entry of children) await take(entry.path, entry.directory)
      }

      for (const path of paths) {
        const parent = await listAnywhere(dirname(path)).catch(() => [] as FileEntry[])
        const known = parent.find(entry => entry.path === path)
        await take(path, known?.directory ?? false)
      }
      // `level: 0` — the workspace is already in memory and so is the result,
      // so this trades a bigger download for not walking every byte twice.
      // Text compresses well enough that the default is worth its cost.
      return zipSync(entries)
    },

    rename: async (from: string, to: string): Promise<void> => {
      if (await runtimeReady()) {
        await (await runtimeFs()).rename(toContainerPath(from), toContainerPath(to))
        runtimePersistence()?.touch()
        return
      }
      volume.rename(from, to)
    },
  }
}

/** The last segment of a path. */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** List a directory in whichever filesystem is the live one. */
async function listAnywhere(path: string): Promise<FileEntry[]> {
  if (await runtimeReady()) {
    const fs = await runtimeFs()
    const entries = await fs.readdir(toContainerPath(path), { withFileTypes: true })
    return entries.map(entry => ({ name: entry.name, path: child(path, entry.name), directory: entry.isDirectory() }))
  }
  return volume.readdirNodes(path).map(([name, node]) => ({
    name, path: child(path, name), directory: node.kind === 'dir',
  }))
}

/** Read a file from whichever filesystem is the live one. */
async function readAnywhere(path: string): Promise<Uint8Array> {
  if (await runtimeReady()) return (await runtimeFs()).readFile(toContainerPath(path))
  return volume.readFile(path)
}

/** Directories first, then names, the way a file browser is read. */
function byKindThenName(left: FileEntry, right: FileEntry): number {
  if (left.directory !== right.directory) return left.directory ? -1 : 1
  return left.name.localeCompare(right.name)
}
