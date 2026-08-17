/**
 * The runtime the terminal and the agent both execute in.
 *
 * WebContainers is Node running in the browser — not an emulation of one. The
 * `node` here is v22, `npm install` reaches the registry through StackBlitz's
 * proxy and finishes in seconds, and the filesystem is a real API rather than
 * something reconstructed from shell commands.
 *
 * The trade against virtualizing x86 is deliberate: this is newer and far
 * faster, and it is only JavaScript. There is no Python, no compiler, and no
 * arbitrary binary — what the container has is what Node and its `jsh` shell
 * provide. For a harness whose work is code, that is the better half of the
 * trade.
 *
 * Two requirements shape the code below:
 *
 * - `SharedArrayBuffer`, so the page must be cross-origin isolated. A static
 *   host cannot send those headers, so `public/sw.js` adds them and the first
 *   load reloads once through the worker.
 * - Exactly one container per page: `boot()` may be called once, so everything
 *   that needs it shares a single promise.
 */

import type { WebContainer, WebContainerProcess } from '@webcontainer/api'
import { persistWorkspace, restoreWorkspace, type RuntimePersistence } from './persist.ts'

/**
 * Where a session starts.
 *
 * This is the container's own working directory, chosen by `workdirName` below.
 * It matters that the two agree: the container resolves every path against that
 * directory, so a workspace named anywhere else is created *inside* it and
 * `export` cannot address it by the same absolute path `fs` accepted.
 */
export const WORKSPACE = '/home/workspace'

/**
 * Translate an absolute path into what the container will accept.
 *
 * The container resolves every path against its working directory, including
 * ones that look absolute — `/home/workspace/a.txt` becomes
 * `<workdir>/home/workspace/a.txt`, one level too deep. So the workspace prefix
 * is stripped and the container is addressed relative to its own root, which is
 * the workspace.
 * @param absolute - a path as the harness names it.
 * @returns the path as the container names it.
 */
export function toContainerPath(absolute: string): string {
  if (absolute === WORKSPACE) return '.'
  if (absolute.startsWith(`${WORKSPACE}/`)) return absolute.slice(WORKSPACE.length + 1) || '.'
  return absolute.replace(/^\/+/, '')
}

/** Whether this page can host the runtime at all. */
export function runtimeSupported(): { ok: boolean, reason?: string } {
  if (typeof SharedArrayBuffer === 'undefined') {
    return { ok: false, reason: 'SharedArrayBuffer is unavailable — the page is not cross-origin isolated' }
  }
  if (!globalThis.crossOriginIsolated) return { ok: false, reason: 'the page is not cross-origin isolated' }
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'WebAssembly is unavailable' }
  return { ok: true }
}

let container: Promise<WebContainer> | undefined
let durability: RuntimePersistence | undefined

/** The workspace's durability handle, once the runtime has started. */
export function runtimePersistence(): RuntimePersistence | undefined {
  return durability
}

/**
 * Boot the runtime, once.
 *
 * The workspace directory is created here rather than by the first caller that
 * needs it, because the harness is configured with that path before anything
 * runs and a missing cwd turns every command into a confusing failure.
 * @param onProgress - called with human-readable boot steps.
 * @returns the running container.
 */
export async function bootRuntime(onProgress?: (step: string) => void): Promise<WebContainer> {
  container ??= (async (): Promise<WebContainer> => {
    const support = runtimeSupported()
    if (!support.ok) throw new Error(`the runtime cannot start: ${support.reason ?? 'unsupported'}`)

    onProgress?.('Loading the runtime')
    const { WebContainer: Runtime } = await import('@webcontainer/api')

    onProgress?.('Starting Node')
    const booted = await Runtime.boot({ workdirName: 'workspace' })

    onProgress?.('Preparing the workspace')
    // The runtime's filesystem is in memory, so without this a reload loses the
    // user's work — which is not a limitation to accept in a harness.
    const restored = await restoreWorkspace(booted)
    if (restored) onProgress?.('Restored your workspace')
    durability = persistWorkspace(booted)
    return booted
  })()
  return container
}

/** Whether the runtime has already been started in this page. */
export function runtimeStarted(): boolean {
  return container !== undefined
}

/** The result of one command. */
export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** How to run one command. */
export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Text fed to the command's standard input. */
  stdin?: string
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

/** Whether the runtime is usable right now. */
export function runtimeAvailable(): boolean {
  return runtimeSupported().ok
}

/**
 * Run a shell command in the runtime.
 *
 * `jsh` merges the two output streams, so what a caller gets back is what a
 * terminal would have shown; `stderr` is reported separately only when the
 * command is run in a way that keeps them apart, which nothing here does.
 * Reporting the merged text as stdout is truer than inventing a split.
 * @param script - shell source to run.
 * @param options - working directory, environment, cancellation, streaming.
 * @returns what the command produced.
 */
export async function execute(script: string, options: RunOptions = {}): Promise<RunResult> {
  const runtime = await bootRuntime()
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[name] = value
  }

  const process = await runtime.spawn('jsh', ['-c', script], {
    cwd: toContainerPath(options.cwd ?? WORKSPACE),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  })

  let output = ''
  void process.output.pipeTo(new WritableStream<string>({
    write(chunk) {
      output += chunk
      options.onStdout?.(chunk)
    },
  })).catch(() => undefined)

  if (options.stdin !== undefined && options.stdin !== '') {
    const writer = process.input.getWriter()
    await writer.write(options.stdin)
    await writer.close().catch(() => undefined)
  }

  const abort = options.signal
  if (abort !== undefined) {
    abort.addEventListener('abort', () => { process.kill() }, { once: true })
  }

  const status = await process.exit
  // A command is the coarsest thing that can change the workspace, and the
  // cheapest place to notice: the snapshot itself is debounced.
  durability?.touch()
  return { status, stdout: output, stderr: '' }
}

/**
 * Start an interactive shell attached to a terminal.
 * @param size - the terminal's grid.
 * @returns the process, for wiring to the emulator.
 */
export async function startShell(size: { cols: number, rows: number }): Promise<WebContainerProcess> {
  const runtime = await bootRuntime()
  return runtime.spawn('jsh', [], {
    cwd: toContainerPath(WORKSPACE),
    terminal: { cols: size.cols, rows: size.rows },
  })
}

/** The runtime's filesystem, for the agent's file tools. */
export async function runtimeFs(): Promise<WebContainer['fs']> {
  return (await bootRuntime()).fs
}
