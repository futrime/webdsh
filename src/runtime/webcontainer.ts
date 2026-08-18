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
import { CONTAINER_SHELL } from '../generated/container-shell.ts'

/**
 * Where a session starts.
 *
 * This is the container's own working directory, chosen by `workdirName` below.
 * It matters that the two agree: the container resolves every path against that
 * directory, so a workspace named anywhere else is created *inside* it and
 * `export` cannot address it by the same absolute path `fs` accepted.
 */
export const WORKDIR = '/home/dsh'

/**
 * Where a session starts: the user's files, and nothing else.
 *
 * A directory *inside* the container's working directory rather than being it,
 * because the harness needs somewhere to keep the shell and the script files it
 * runs. Those cannot live in the workspace: a page can only write beneath the
 * working directory, so anything the harness writes there would show up in the
 * user's `ls -la`, in `git status` as untracked, and in the snapshot their work
 * is restored from.
 */
export const WORKSPACE = `${WORKDIR}/workspace`

/** Where the harness keeps its own files, relative to the working directory. */
const PRIVATE_DIR = '.dsh'

/** Where the shell program lives, as the container itself addresses it. */
const SHELL_PATH = `${WORKDIR}/${PRIVATE_DIR}/sh.cjs`

/** Distinguishes one command's script file from another's while both run. */
let runCounter = 0

/** Which interpreter a command's script is handed to. */
export type ShellMode = 'harness' | 'jsh'

/**
 * The shell commands run in.
 *
 * `harness` is the interpreter in `src/shell/`, written because `jsh` is not
 * one; `jsh` is the container's own shell, warts and all. This deployment runs
 * `jsh` and tells the model exactly what `jsh` is — see `src/host/jsh-tool.ts`
 * for the argument. Running one shell while describing the other is the failure
 * mode the pair exists to prevent, so the default here and the tool description
 * there have to move together.
 *
 * It stays settable because the other answer is still in the tree and still
 * correct: `setShellMode('harness')` puts the bundled POSIX shell back for
 * anyone who would rather have it.
 */
let mode: ShellMode = 'jsh'

/** Which interpreter commands are currently handed to. */
export function shellMode(): ShellMode {
  return mode
}

/**
 * Choose the interpreter commands are handed to.
 * @param next - the shell to run from now on.
 */
export function setShellMode(next: ShellMode): void {
  mode = next
}

/**
 * Install the shell the agent's commands run in.
 *
 * The container ships `jsh`, which is not a shell in the sense a harness needs:
 * no `for`, `if`, `while`, `case`, functions, heredocs or `<` redirection, and
 * command substitution that expands to the empty string while reporting
 * success — so `n=$(ls | wc -l)` yields a confident wrong answer rather than an
 * error. `dsh` on a machine gets a real bash; this writes in the interpreter
 * from `src/shell/`, which is a real shell, and runs it on the container's own
 * files through `node:fs`.
 * @param runtime - the booted container.
 */
async function installShell(runtime: WebContainer): Promise<void> {
  await runtime.fs.mkdir(PRIVATE_DIR, { recursive: true })
  await runtime.fs.mkdir(toContainerPath(WORKSPACE), { recursive: true })
  await runtime.fs.writeFile(`${PRIVATE_DIR}/sh.cjs`, CONTAINER_SHELL)
}

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
  if (absolute === WORKDIR) return '.'
  if (absolute.startsWith(`${WORKDIR}/`)) return absolute.slice(WORKDIR.length + 1) || '.'
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

/**
 * How long the container gets to start before it is treated as unavailable.
 *
 * A working boot takes a few seconds; this is the budget for one that never
 * answers. It is also, on a browser that cannot run the container at all, how
 * long the first command waits before falling back — so it is kept short enough
 * to read as slow rather than as frozen, and long enough that a real boot over
 * a slow connection is not cut off. Most of it elapses during onboarding,
 * because the boot starts with the page.
 */
const BOOT_TIMEOUT_MS = 30_000

/**
 * Fail a boot that never finishes.
 *
 * A rejected boot falls back to the in-page shell; a boot that simply never
 * settles does not, because every caller is still waiting on it. On a network
 * that drops the runtime's assets rather than refusing them, that is the
 * difference between a degraded harness and a frozen one.
 * @param attempt - the boot in progress.
 */
async function withDeadline(attempt: Promise<WebContainer>): Promise<WebContainer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the runtime did not start within ${String(BOOT_TIMEOUT_MS / 1000)} seconds`))
        }, BOOT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Why the runtime is not usable, once an attempt to start it has failed.
 *
 * The checks in {@link runtimeSupported} are about the browser's capabilities,
 * and a browser can have every one of them and still not run the container —
 * Chrome on Android has `SharedArrayBuffer` and cross-origin isolation, and
 * WebContainers refuses to boot there. Until that was recorded, everything kept
 * routing to a runtime that would never exist: the shell, the agent's file
 * tools, and search all failed, one confusing error at a time.
 */
let bootFailure: string | undefined

/** Why the runtime is unusable, if it is. */
export function runtimeFailure(): string | undefined {
  return bootFailure
}

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
  container ??= withDeadline((async (): Promise<WebContainer> => {
    const support = runtimeSupported()
    if (!support.ok) throw new Error(`the runtime cannot start: ${support.reason ?? 'unsupported'}`)

    onProgress?.('Loading the runtime')
    const { WebContainer: Runtime } = await import('@webcontainer/api')

    onProgress?.('Starting Node')
    const booted = await Runtime.boot({ workdirName: 'dsh' })

    onProgress?.('Installing the shell')
    await installShell(booted)

    onProgress?.('Preparing the workspace')
    // The runtime's filesystem is in memory, so without this a reload loses the
    // user's work — which is not a limitation to accept in a harness.
    const restored = await restoreWorkspace(booted)
    if (restored) onProgress?.('Restored your workspace')
    durability = persistWorkspace(booted)
    return booted
  })()).catch((error: unknown) => {
    // Recorded rather than only thrown: the callers that ask `runtimeAvailable`
    // before routing a command need to know, and the next boot attempt would
    // otherwise fail the same way for every one of them.
    bootFailure = error instanceof Error ? error.message : String(error)
    console.warn('[runtime] the container could not start; falling back to the in-page shell:', error)
    throw error
  })
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
  /** `$0` for the script. */
  name?: string
  /** Positional parameters, `$1` onwards. */
  args?: string[]
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

/**
 * Whether the runtime is usable, waiting for a boot already in flight.
 *
 * The synchronous {@link runtimeAvailable} cannot know the answer before the
 * first attempt finishes. A caller that can fall back — the shell has an
 * in-page implementation — should ask this instead, so the very first command
 * is answered correctly rather than failing to find a container.
 * @returns whether commands can run in the container.
 */
export async function runtimeReady(): Promise<boolean> {
  if (bootFailure !== undefined) return false
  if (!runtimeSupported().ok) return false
  try {
    await bootRuntime()
    return true
  } catch {
    return false
  }
}

/** Whether the runtime is usable right now. */
export function runtimeAvailable(): boolean {
  return bootFailure === undefined && runtimeSupported().ok
}

/**
 * Run a shell command in the runtime.
 *
 * The runtime merges the two output streams, so what a caller gets back is what
 * a terminal would have shown; `stderr` is reported separately only when the
 * command is run in a way that keeps them apart, which nothing here does.
 * Reporting the merged text as stdout is truer than inventing a split.
 * @param script - shell source to run.
 * @param options - working directory, environment, cancellation, streaming.
 * @returns what the command produced.
 */
export async function execute(script: string, options: RunOptions = {}): Promise<RunResult> {
  const runtime = await bootRuntime()
  // The container's own `HOME` is `/home`, one level above the working
  // directory, so `~` and `cd` with no argument would land somewhere the user
  // has nothing. The page reports the same home, and the two must agree.
  const env: Record<string, string> = { HOME: WORKDIR }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[name] = value
  }

  // Not `-c <script>`: the runtime unescapes backslashes in argv, so a script
  // passed as an argument arrives subtly different from the one the agent wrote
  // — `sed 's/a/\n/'` loses its escape and the command quietly does the wrong
  // thing. A file's bytes survive intact.
  const scriptFile = `${PRIVATE_DIR}/run-${String(runCounter++)}.sh`
  await runtime.fs.writeFile(scriptFile, script)
  // `$0` and the positional parameters follow the script, as they do for
  // `sh -c`. They travel as argv rather than in the file, so a backslash in one
  // is subject to the runtime's unescaping — the script itself is not.
  const positional = options.name === undefined && (options.args?.length ?? 0) === 0
    ? []
    : [options.name ?? 'sh', ...(options.args ?? [])]
  // `jsh` reads a script file too, and reading one is the only safe way to
  // hand it a script: its argument parser coerces a bare `true` or `false` into
  // a boolean, so `jsh -c false` drops into an interactive session and never
  // returns. It takes no positional parameters, which is one of the things the
  // plugin's tool description says out loud.
  const argv = mode === 'jsh'
    ? ['jsh', [`${WORKDIR}/${scriptFile}`]] as const
    : ['node', [SHELL_PATH, `${WORKDIR}/${scriptFile}`, ...positional]] as const
  const process = await runtime.spawn(argv[0], [...argv[1]], {
    cwd: toContainerPath(options.cwd ?? WORKSPACE),
    env,
  })

  let output = ''
  void process.output.pipeTo(new WritableStream<string>({
    write(chunk) {
      output += chunk
      options.onStdout?.(chunk)
    },
  })).catch(() => undefined)

  // Closed either way: the shell reads standard input to the end before it
  // runs, so an input that is never closed is a command that never starts.
  const writer = process.input.getWriter()
  if (options.stdin !== undefined && options.stdin !== '') await writer.write(options.stdin)
  await writer.close().catch(() => undefined)

  const abort = options.signal
  if (abort !== undefined) {
    abort.addEventListener('abort', () => { process.kill() }, { once: true })
  }

  const status = await process.exit
  await runtime.fs.rm(scriptFile).catch(() => undefined)
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
  // Whichever shell the agent's tool calls run in, so what a person types and
  // what the model runs behave identically. That is the whole reason the mode
  // is one setting rather than two: a terminal that quietly had a better shell
  // than the agent would make every reproduction attempt a coin toss.
  const argv: [string, string[]] = mode === 'jsh' ? ['jsh', []] : ['node', [SHELL_PATH, '-i']]
  return runtime.spawn(argv[0], argv[1], {
    cwd: toContainerPath(WORKSPACE),
    env: { HOME: WORKDIR },
    terminal: { cols: size.cols, rows: size.rows },
  })
}

/** The runtime's filesystem, for the agent's file tools. */
export async function runtimeFs(): Promise<WebContainer['fs']> {
  return (await bootRuntime()).fs
}
