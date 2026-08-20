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
import {
  bootMachine, currentMachine, machineFailure, machineGuest, machineSupported, machineStarted,
  parkScreen, stopMachine, unparkScreen,
} from '../runtime/v86.ts'
import {
  DEFAULT_IMAGE_HOST, GUESTS, UPSTREAM_IMAGE_HOST, imageHost, setImageHost, type GuestSpec,
} from '../runtime/guests.ts'
import { forgetDisk, storeDisk, storedDisks } from '../runtime/disks.ts'
import { isEmulated, runtimeSelection, setRuntimeSelection, type RuntimeSelection } from '../runtime/selection.ts'
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
    boot: async (onProgress?: (step: string) => void) => (
      isEmulated() ? bootMachine(onProgress) : bootRuntime(onProgress)
    ),
    startShell: async (size: { cols: number, rows: number }) => (
      isEmulated() ? machineShell() : startShell(size)
    ),
    // The whole message rather than a fragment. There are now two reasons a
    // terminal cannot open and they need different advice — one is a browser
    // that cannot be cross-origin isolated, the other is a machine whose
    // console is its screen — and a panel that appends a fixed paragraph about
    // `SharedArrayBuffer` to either of them is telling half of its users to go
    // fix something that is not broken.
    unavailable: () => terminalUnavailable(),
    // The search backend, published so a test can exercise the same code the
    // `grep` and `glob` tools reach through the subprocess seam.
    search: (args: string[], cwd?: string) => ripgrep(args, cwd),
    // Which shell a command's script is handed to inside the container. The
    // runtime is a page capability, so the choice has to be reachable from
    // outside this bundle; it says nothing about an emulated machine, which
    // has whatever shell its own operating system has.
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
 * Why a terminal cannot open here, when it cannot.
 * @returns the message the panel shows, or undefined when a terminal will open.
 */
function terminalUnavailable(): string | undefined {
  if (isEmulated()) {
    const guest = machineGuest()
    if (guest === undefined) return 'This session names a machine this build does not have.'
    if (guest.console === 'serial') return undefined
    return `This session runs ${guest.name}, whose console is its own screen rather than a serial port. `
      + 'Open the Runtime panel to see it and type at it.'
  }
  const support = runtimeSupported()
  if (support.ok) return undefined
  const reason = support.reason ?? 'the runtime is unavailable'
  // The reload advice belongs only to the one cause a reload fixes. Cross-origin
  // isolation arrives with the service worker and so is missing on a first load
  // and present on the next; a browser that has no `Atomics.waitAsync` will
  // still have none after any number of reloads, and telling someone on iOS to
  // try again is sending them round a loop.
  const isolation = reason.includes('SharedArrayBuffer') || reason.includes('cross-origin isolated')
  if (!isolation) return reason
  return `${reason}. The runtime needs SharedArrayBuffer, which a browser grants only a cross-origin `
    + 'isolated page; reloading usually fixes it, because the worker that adds the required headers only '
    + 'controls the page after its first load.'
}

/**
 * A terminal on the emulated machine's serial console.
 *
 * The same shape a container process has, so the terminal plugin does not need
 * to know which machine it is drawing. There is no process to exit and no grid
 * to resize — a serial console is a character stream and the guest decides how
 * wide it thinks it is — so those two are honest no-ops rather than pretend
 * implementations.
 *
 * It is the same console the `sh` tool uses, deliberately: one machine, one
 * session, and what the user types the agent can see in its next command's
 * output. That is the property the container terminal already has.
 * @returns the stream pair the terminal wires itself to.
 */
async function machineShell(): Promise<{
  output: ReadableStream<string>
  input: WritableStream<string>
  exit: Promise<number>
  resize(size: { cols: number, rows: number }): void
}> {
  const machine = await bootMachine()
  let release: (() => void) | undefined
  return {
    output: new ReadableStream<string>({
      start(controller) {
        // The backlog first: a terminal opened after the boot should show the
        // boot, not an empty screen with a prompt somewhere above it.
        const backlog = machine.console.read()
        if (backlog.text !== '') controller.enqueue(backlog.text)
        release = machine.console.subscribe(chunk => { controller.enqueue(chunk) })
      },
      cancel() { release?.() },
    }),
    input: new WritableStream<string>({
      write(chunk) { machine.console.write(chunk) },
    }),
    exit: new Promise<number>(() => undefined),
    resize: () => undefined,
  }
}

/**
 * Publish the emulated machine, for the panel that chooses and shows one.
 *
 * The same seam the runtime has, for the same reason: the panel is a client
 * plugin in a separate bundle and cannot import any of this. What it gets is
 * the choice, the catalog, the disks the user has opened, and a way to borrow
 * the screen — never any UI.
 */
export function publishMachineBridge(): void {
  ;(globalThis as Record<string, unknown>).__DSH_WEB_MACHINE__ = {
    /** What this session runs on. Fixed for the life of the page. */
    selection: (): RuntimeSelection => runtimeSelection(),
    /** What the *next* load will run on. */
    select: (next: RuntimeSelection): void => { setRuntimeSelection(next) },
    /** Every machine this build can boot, as plain data. */
    guests: (): GuestSummary[] => GUESTS.map(summarise),
    /** Where disk images are fetched from, and the two hosts worth naming. */
    imageHost,
    setImageHost,
    hosts: { default: DEFAULT_IMAGE_HOST, upstream: UPSTREAM_IMAGE_HOST },
    /** Disk images the user has opened from their own computer. */
    disks: storedDisks,
    storeDisk,
    forgetDisk,
    /** What the machine is doing right now. */
    status: (): MachineStatus => ({
      emulated: isEmulated(),
      guest: machineGuest()?.id,
      started: machineStarted(),
      running: currentMachine() !== undefined,
      failure: machineFailure(),
      unsupported: machineSupported().ok ? undefined : machineSupported().reason,
    }),
    /** Start it, reporting progress. Safe to call when it is already up. */
    boot: async (onProgress?: (step: string) => void): Promise<void> => { await bootMachine(onProgress) },
    /**
     * Lend the machine's screen to a panel.
     *
     * The element belongs to the app because the agent drives the machine with
     * nothing open; a panel borrows it and gives it back. The returned
     * disposer is what puts it back, and calling it is not optional — an
     * unmounted panel that kept the screen would take the machine's display
     * out of the document and every later screenshot with it.
     * @param host - where to put it.
     * @returns the disposer that returns it.
     */
    adoptScreen: async (host: HTMLElement): Promise<() => void> => {
      const machine = await bootMachine()
      host.append(machine.screen)
      unparkScreen(machine.screen)
      return () => { parkScreen(machine.screen) }
    },
    /**
     * Deliver one real key event, from a panel that is showing the screen.
     *
     * The emulator installs no keyboard listener of its own — see
     * `Machine.sendKeyEvent` — so this is the only path a person's keystroke
     * has into the guest, and it exists exactly as long as a panel is
     * listening for one.
     */
    key: (code: string, down: boolean): boolean => currentMachine()?.sendKeyEvent(code, down) ?? false,
    /** Throw the machine away so the next boot is a cold one. */
    restart: async (): Promise<void> => { await stopMachine() },

    /**
     * The machine itself: its console, its screen, its keyboard and its mouse.
     *
     * A panel has real uses for all four — sending Ctrl+Alt+Delete, saving a
     * screenshot, pasting a command — and `scripts/v86-e2e.ts` drives exactly
     * these, which is the point: the tools in `src/host/vm-tools.ts` are thin
     * wrappers over this, so a suite that exercises it is exercising what the
     * model reaches rather than a parallel implementation of it. The `search`
     * entry on the runtime bridge exists for the same reason.
     */
    console: {
      run: async (command: string, options?: { timeoutMs?: number }) => (await bootMachine()).console.run(command, options),
      read: async (offset?: number) => (await bootMachine()).console.read(offset),
      write: async (text: string) => { (await bootMachine()).console.write(text) },
      releaseScreen: async () => { await (await bootMachine()).console.releaseScreen() },
      putFile: async (path: string, content: string) => (await bootMachine()).console.putFile(path, content),
    },
    screen: {
      text: async () => (await bootMachine()).screenText(),
      transcript: async () => (await bootMachine()).transcript(),
      shot: async () => {
        const shot = await (await bootMachine()).screenshot()
        return { width: shot.width, height: shot.height, bytes: shot.bytes.length, graphical: shot.graphical }
      },
    },
    input: {
      type: async (text: string) => { await (await bootMachine()).type(text) },
      press: async (key: string) => { (await bootMachine()).press(key) },
      mouse: async (dx: number, dy: number) => { (await bootMachine()).moveMouse(dx, dy) },
      click: async (which: 'left' | 'middle' | 'right' = 'left') => { await (await bootMachine()).click(which) },
    },
    /** Wait until the guest has reached its own readiness marker. */
    ready: async (timeoutMs?: number) => (await bootMachine()).ready(timeoutMs),
  }
}

/** One machine, as the panel lists it. */
export interface GuestSummary {
  id: string
  name: string
  console: string
  summary: string
  bundled: boolean
  transfer: number
  boots: string
  /** The file names it needs from the image host, for the "bring your own" message. */
  files: string[]
}

/** What the machine is doing, as the panel reads it. */
export interface MachineStatus {
  emulated: boolean
  guest?: string
  started: boolean
  running: boolean
  failure?: string
  unsupported?: string
}

/** Reduce a catalog entry to what a panel needs. */
function summarise(spec: GuestSpec): GuestSummary {
  return {
    id: spec.id,
    name: spec.name,
    console: spec.console,
    summary: spec.summary,
    bundled: spec.bundled,
    transfer: spec.transfer,
    boots: spec.boots,
    files: spec.images.map(image => image.file),
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
