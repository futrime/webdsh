/**
 * The `process` object. Installed on `globalThis` before any dsh module runs,
 * because composition expressions in `cordis.patch.yml` read `process.platform`,
 * `process.env`, and `process.cwd()` at load time.
 *
 * `platform` reports `linux` so the shipped compositions take their POSIX
 * branches (bash over pwsh) — the in-browser shell is a POSIX shell.
 */

import { setCwdProvider, resolve } from '../vfs/path.ts'
import { Buffer } from './binary.ts'

/** Environment variables. Seeded at boot from persisted settings. */
export const env: Record<string, string | undefined> = {
  // The home the workspace sits inside. It is `/home` rather than `/home/dsh`
  // because the runtime's working directory — the workspace — is `/home/
  // workspace`, and the directory picker opens at home: a home that did not
  // contain the workspace would offer everything except the one directory the
  // user wants.
  HOME: '/home/dsh',
  // The workspace the runtime opens on. It is the container's own working
  // directory, and the host has to agree: a session's cwd comes from here, and
  // a tool searching a path the runtime cannot resolve finds nothing at all
  // rather than failing loudly.
  PWD: '/home/dsh/workspace',
  TMPDIR: '/tmp',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  SHELL: '/bin/sh',
  USER: 'dsh',
  LOGNAME: 'dsh',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  NODE_ENV: 'production',
  /** Marks the runtime for plugins that want to adapt; dsh itself ignores it. */
  DSH_RUNTIME: 'browser',
}

let workingDirectory = '/home/dsh/workspace'

/** Simple event registry for `process.on('exit' | 'uncaughtException' | ...)`. */
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

/** Write-through stdio stream that forwards to the console. */
function makeStdStream(name: 'stdout' | 'stderr'): Record<string, unknown> {
  let pending = ''
  const flush = (): void => {
    if (pending.length === 0) return
    const text = pending.replace(/\n$/, '')
    pending = ''
    if (name === 'stderr') console.error(text)
    else console.log(text)
  }
  return {
    write(chunk: unknown, _encoding?: unknown, callback?: () => void): boolean {
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      const lastNewline = pending.lastIndexOf('\n')
      if (lastNewline !== -1) {
        const complete = pending.slice(0, lastNewline)
        pending = pending.slice(lastNewline + 1)
        for (const line of complete.split('\n')) {
          if (name === 'stderr') console.error(line)
          else console.log(line)
        }
      }
      if (typeof _encoding === 'function') (_encoding as () => void)()
      else callback?.()
      return true
    },
    end: flush,
    /** dsh checks `isTTY` to decide whether to colorize; the browser console is not a TTY. */
    isTTY: false,
    columns: 120,
    rows: 40,
    fd: name === 'stderr' ? 2 : 1,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeListener: () => undefined,
    setEncoding: () => undefined,
    cork: () => undefined,
    uncork: () => undefined,
    destroy: () => undefined,
  }
}

/** A never-readable stdin: the browser host is non-interactive at the process level. */
const stdin = {
  isTTY: false,
  fd: 0,
  readable: false,
  setEncoding: () => stdin,
  setRawMode: () => stdin,
  resume: () => stdin,
  pause: () => stdin,
  on: () => stdin,
  once: () => stdin,
  off: () => stdin,
  removeListener: () => stdin,
  read: () => null,
  pipe: <T>(destination: T): T => destination,
  destroy: () => undefined,
  async *[Symbol.asyncIterator](): AsyncGenerator<never> {},
}

/**
 * The listener surface `process` exposes. Naming it breaks the self-reference
 * that would otherwise make the object's type unresolvable.
 */
interface ProcessEmitter {
  on(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  once(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  off(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  prependListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  prependOnceListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  removeListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter
  removeAllListeners(event?: string): ProcessEmitter
  setMaxListeners(): ProcessEmitter
}

/**
 * The process object.
 *
 * `index.html` installs a minimal placeholder on `globalThis` before any module
 * runs, because bundled dependencies read `process.platform` while their bodies
 * evaluate — before this module could possibly have run. The full object is
 * merged onto that same placeholder so there is exactly one identity: a module
 * that captured the early object sees every later addition.
 */
const built = {
  env,
  argv: ['/usr/bin/node', '/usr/bin/dsh'],
  argv0: 'node',
  execPath: '/usr/bin/node',
  execArgv: [] as string[],
  /** The shipped compositions branch on this; the in-browser shell is POSIX. */
  platform: 'linux' as NodeJS.Platform,
  arch: 'wasm32' as NodeJS.Architecture,
  pid: 1,
  ppid: 0,
  title: 'dsh',
  version: 'v22.0.0',
  /**
   * Deliberately without a `node` entry.
   *
   * Libraries probe `process.versions?.node` to decide whether Node builtins
   * are dynamically importable — and in a page they are not, so claiming a Node
   * version makes them attempt `import('node:fs')` and fail. Omitting it is the
   * honest answer and routes those libraries to their browser branch.
   * (`process.versions.node` written literally is replaced at build time by
   * Vite's `define`, which is what the vendored loader's own probe reads.)
   */
  versions: {
    v8: '12.4.0',
    /** Marker other code can branch on without probing the DOM. */
    dshWebHarness: '0.1.0',
  } as Record<string, string>,
  exitCode: 0 as number | undefined,
  connected: false,
  stdout: makeStdStream('stdout'),
  stderr: makeStdStream('stderr'),
  stdin,

  /** Current working directory. */
  cwd(): string {
    return workingDirectory
  },

  /**
   * Change the working directory.
   * @param directory - absolute or relative target.
   */
  chdir(directory: string): void {
    workingDirectory = resolve(directory)
    env.PWD = workingDirectory
  },

  /** High-resolution time; `bigint` variant included because dsh's timers use it. */
  hrtime: Object.assign(
    (previous?: [number, number]): [number, number] => {
      const now = performance.now()
      const seconds = Math.floor(now / 1000)
      const nanoseconds = Math.floor((now % 1000) * 1e6)
      if (previous === undefined) return [seconds, nanoseconds]
      let deltaSeconds = seconds - previous[0]
      let deltaNanoseconds = nanoseconds - previous[1]
      if (deltaNanoseconds < 0) {
        deltaSeconds -= 1
        deltaNanoseconds += 1e9
      }
      return [deltaSeconds, deltaNanoseconds]
    },
    { bigint: (): bigint => BigInt(Math.round(performance.now() * 1e6)) },
  ),

  uptime: (): number => performance.now() / 1000,

  /** No real memory accounting exists in the browser; report plausible zeros. */
  memoryUsage: Object.assign(
    () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    { rss: (): number => 0 },
  ),

  cpuUsage: () => ({ user: 0, system: 0 }),

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => { callback(...args) })
  },

  on(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    let set = listeners.get(event)
    if (set === undefined) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener)
    return built
  },

  prependListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    // Ordering within a set is insertion order; rebuild it with this listener first.
    const existing = [...(listeners.get(event) ?? [])]
    listeners.set(event, new Set([listener, ...existing]))
    return built
  },

  prependOnceListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    const wrapper = (...args: unknown[]): void => {
      built.off(event, wrapper)
      listener(...args)
    }
    return built.prependListener(event, wrapper)
  },

  listenerCount(event: string): number {
    return listeners.get(event)?.size ?? 0
  },

  eventNames(): string[] {
    return [...listeners.keys()]
  },

  setMaxListeners(): ProcessEmitter {
    return built
  },

  getMaxListeners(): number {
    return 0
  },

  once(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    const wrapper = (...args: unknown[]): void => {
      built.off(event, wrapper)
      listener(...args)
    }
    return built.on(event, wrapper)
  },

  off(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    listeners.get(event)?.delete(listener)
    return built
  },

  removeListener(event: string, listener: (...args: unknown[]) => void): ProcessEmitter {
    return built.off(event, listener)
  },

  removeAllListeners(event?: string): ProcessEmitter {
    if (event === undefined) listeners.clear()
    else listeners.delete(event)
    return built
  },

  listeners(event: string): ((...args: unknown[]) => void)[] {
    return [...(listeners.get(event) ?? [])]
  },

  emit(event: string, ...args: unknown[]): boolean {
    const set = listeners.get(event)
    if (set === undefined || set.size === 0) return false
    for (const listener of [...set]) listener(...args)
    return true
  },

  /**
   * Run every `exit` listener. Nothing actually terminates — killing the page
   * on a plugin's `process.exit()` would be a hostile surprise.
   */
  exit(code = 0): void {
    built.exitCode = code
    built.emit('exit', code)
    console.warn(`[process] exit(${String(code)}) ignored in the browser host`)
  },

  abort(): void {
    built.exit(134)
  },

  /**
   * `process.kill`. Signal 0 is the liveness probe dsh's subprocess manager
   * polls to decide when a spawned tree is gone, so an absent pid must throw
   * `ESRCH` exactly as it does on POSIX — reporting success unconditionally
   * would leave that observer spinning forever.
   */
  kill(pid: number, signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const alive = liveProcessProbe?.(pid) ?? false
    if (!alive) {
      const error = new Error('kill ESRCH') as Error & { code: string, errno: number, syscall: string }
      error.code = 'ESRCH'
      error.errno = -3
      error.syscall = 'kill'
      throw error
    }
    if (signal === 0) return true
    terminateProcess?.(pid, signal)
    return true
  },

  /** dsh probes this before using `--experimental` behavior; nothing is enabled here. */
  features: { typescript: false } as Record<string, unknown>,

  /** `process.getBuiltinModule` (Node 22+): the shim registry answers it. */
  getBuiltinModule(specifier: string): unknown {
    return builtinLookup?.(specifier)
  },

  setUncaughtExceptionCaptureCallback(): void {},
  hasUncaughtExceptionCaptureCallback: (): boolean => false,
  setSourceMapsEnabled(): void {},
  allowedNodeEnvironmentFlags: new Set<string>(),
  umask: (): number => 0o022,
  getuid: (): number => 1000,
  getgid: (): number => 1000,
  geteuid: (): number => 1000,
  getegid: (): number => 1000,
  emitWarning(warning: string | Error): void {
    console.warn('[process] warning:', warning)
  },
}

/** Resolver installed by the shim registry so `getBuiltinModule` can answer. */
let builtinLookup: ((specifier: string) => unknown) | undefined

/** Liveness probe installed by the `child_process` shim (avoids a module cycle). */
let liveProcessProbe: ((pid: number) => boolean) | undefined

/** Terminator installed by the `child_process` shim. */
let terminateProcess: ((pid: number, signal: NodeJS.Signals | number) => void) | undefined

/**
 * Wire the process table into `process.kill`.
 * @param probe - reports whether a pid (or process group, when negative) is alive.
 * @param terminate - delivers a signal to that pid.
 */
export function setProcessTable(
  probe: (pid: number) => boolean,
  terminate: (pid: number, signal: NodeJS.Signals | number) => void,
): void {
  liveProcessProbe = probe
  terminateProcess = terminate
}

/** Wire the builtin registry into `process.getBuiltinModule`. */
export function setBuiltinLookup(lookup: (specifier: string) => unknown): void {
  builtinLookup = lookup
}

/** Adopt the page's bootstrap placeholder so `process` has one identity. */
const adopted = (globalThis as unknown as { process?: Record<string, unknown> }).process
export const process = (adopted === undefined ? built : Object.assign(adopted, built)) as typeof built

// Keep the bootstrap's environment values (they seed nothing today, but a
// deployment may inject configuration there before the bundle loads).
if (adopted !== undefined && typeof adopted.env === 'object' && adopted.env !== null) {
  Object.assign(env, adopted.env as Record<string, string>)
  ;(process as unknown as { env: typeof env }).env = env
}

setCwdProvider(() => workingDirectory)

export default process
