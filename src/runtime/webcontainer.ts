/**
 * The runtime the terminal and the agent both execute in.
 *
 * WebContainers is Node running in the browser — not an emulation of one. The
 * `node` here is v22, `npm install` reaches the registry through StackBlitz's
 * proxy and finishes in seconds, and the filesystem is a real API rather than
 * something reconstructed from shell commands.
 *
 * The trade against virtualizing x86 is deliberate: this is newer and far
 * faster, and what it runs is what a browser can run. There is no compiler and
 * no arbitrary binary — but there is Node, and there is CPython, compiled to
 * WebAssembly and installed by `python.ts` into this same filesystem. For a
 * harness whose work is code, that is the better half of the trade.
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
import { installPython, persistPython, pythonBin, restorePython, type PythonPersistence } from './python.ts'
import { CONTAINER_SHELL } from '../generated/container-shell.ts'
import { isEmulated, selectedGuest } from './selection.ts'

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

/**
 * Where the harness keeps its own files, relative to the working directory.
 *
 * Exported because the filesystem bridge has to know it too: everything else
 * under the working directory is the user's and belongs to the container, and
 * this one directory is not.
 */
export const HARNESS_DIR = '.dsh'

/** The same, under the name the rest of this file uses. */
const PRIVATE_DIR = HARNESS_DIR

/**
 * The environment a command runs in, with the harness's programs reachable.
 *
 * `jsh` resolves a command against the `PATH` it was *spawned* with and never
 * re-reads it, so this is the only moment `python3` can be put in front of the
 * container's own RustPython — a script that exports `PATH` itself is already
 * too late. The harness's directory goes first for exactly that reason, and it
 * is prepended to what the container would have used rather than replacing it:
 * an environment handed to `spawn` is the whole of it, so a `PATH` written out
 * here by hand would silently drop whatever the runtime adds to its own.
 * @param runtime - the booted container, which reports its default `PATH`.
 * @param requested - environment the caller wants the command to have.
 * @returns the environment to spawn with.
 */
function environment(
  runtime: WebContainer,
  requested: Record<string, string | undefined> = {},
): Record<string, string> {
  // The container's own `HOME` is `/home`, one level above the working
  // directory, so `~` and `cd` with no argument would land somewhere the user
  // has nothing. The page reports the same home, and the two must agree.
  const env: Record<string, string> = { HOME: WORKDIR, PATH: runtime.path }
  for (const [name, value] of Object.entries(requested)) {
    if (value !== undefined) env[name] = value
  }
  env.PATH = `${WORKDIR}/${pythonBin()}:${env.PATH}`
  return env
}

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
 * Install the two programs the page puts on the machine.
 *
 * The container ships `jsh`, which is not a shell in the sense a harness needs:
 * no `for`, `if`, `while`, `case`, functions, heredocs or `<` redirection, and
 * command substitution that expands to the empty string while reporting
 * success — so `n=$(ls | wc -l)` yields a confident wrong answer rather than an
 * error. `dsh` on a machine gets a real bash; this writes in the interpreter
 * from `src/shell/`, which is a real shell, and runs it on the container's own
 * files through `node:fs`.
 *
 * The `python3` it ships is RustPython, which is not a Python in that sense
 * either — no `pathlib`, no `subprocess`, no pip — so `python.ts` writes in a
 * real one the same way, and for the same reason: a program the page installs
 * cannot fail to arrive, and can be put back when a mount takes it.
 * @param runtime - the booted container.
 */
async function installPrograms(runtime: WebContainer): Promise<void> {
  await ensureStaging(runtime)
  await runtime.fs.writeFile(`${PRIVATE_DIR}/sh.cjs`, CONTAINER_SHELL)
  await installPython(runtime)
}

/**
 * Put back the two directories every command depends on.
 *
 * They are created at boot and nothing here owns them afterwards: the container
 * is a real machine and the agent has a shell on it, so `rm -rf ~/…` in the
 * home directory, or a snapshot mounted over the tree, takes the staging
 * directory with it. Without it `runtime.fs.writeFile` cannot place a script,
 * and because the directory was only ever created once, every command for the
 * rest of the page's life fails the same way — `ENOENT … open
 * '/home/dsh/.dsh/run-7.sh'`, with no way back short of a reload.
 *
 * So it is asserted rather than assumed, at each of the two moments it can be
 * gone: after the workspace is mounted, and after a write has just failed.
 * @param runtime - the booted container.
 */
async function ensureStaging(runtime: WebContainer): Promise<void> {
  await runtime.fs.mkdir(PRIVATE_DIR, { recursive: true })
  await runtime.fs.mkdir(toContainerPath(WORKSPACE), { recursive: true })
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

/**
 * Whether this page can host the runtime at all.
 *
 * The first question is not a capability at all: this deployment can be
 * configured to run an emulated PC instead, and when it is, the container must
 * not start. Two machines in one tab is two filesystems, two shells and a
 * session that cannot say which one it just wrote to — and the whole reason
 * the runtime is selectable is that a session runs on exactly one machine.
 *
 * Reported as "unsupported" rather than silently skipped so that every caller
 * that already handles an unavailable container — the file bridge, the Files
 * panel, the terminal — handles this too, and says which machine is running.
 * @returns whether the container may start, and why not when it may not.
 */
export function runtimeSupported(): { ok: boolean, reason?: string } {
  if (isEmulated()) {
    const guest = selectedGuest()
    return {
      ok: false,
      reason: `this session runs ${guest?.name ?? 'an emulated PC'} instead of the Node container`,
    }
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return { ok: false, reason: 'SharedArrayBuffer is unavailable — the page is not cross-origin isolated' }
  }
  if (!globalThis.crossOriginIsolated) return { ok: false, reason: 'the page is not cross-origin isolated' }
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'WebAssembly is unavailable' }
  if (typeof Atomics === 'undefined'
    || typeof (Atomics as typeof Atomics & { waitAsync?: unknown }).waitAsync !== 'function') {
    return { ok: false, reason: 'Atomics.waitAsync is unavailable in this browser' }
  }
  return { ok: true }
}

let container: Promise<WebContainer> | undefined
let durability: RuntimePersistence | undefined
let pythonDurability: PythonPersistence | undefined
let ready = false

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
 * How long the stored Python may take to come back before it is given up on.
 *
 * Generous next to the read it covers and small next to {@link BOOT_TIMEOUT_MS},
 * which is the point: whatever this costs is taken out of the budget the whole
 * boot has.
 */
const RESTORE_BUDGET_MS = 10_000

/**
 * Give one step of the boot its own deadline.
 * @param step - the work to bound.
 * @param budgetMs - how long it may take.
 * @returns what the step returned, or false if it ran out of time or failed.
 */
async function withinBudget(step: Promise<boolean>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      step,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, budgetMs) }),
    ])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Why the runtime is not usable, once an attempt to start it has failed.
 *
 * The checks in {@link runtimeSupported} are about the browser's capabilities,
 * and a browser can have every one of them and still not run the container:
 * the remote runtime frame can be blocked, a worker can fail, or startup can
 * exhaust a mobile device's memory. Until that failure was recorded, everything
 * kept routing to a runtime that would never exist: the shell, the agent's file
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

/** Python's durability handle, once the runtime has started. */
export function runtimePythonPersistence(): PythonPersistence | undefined {
  return pythonDurability
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

    onProgress?.('Preparing the workspace')
    // The runtime's filesystem is in memory, so without this a reload loses the
    // user's work — which is not a limitation to accept in a harness.
    const restored = await restoreWorkspace(booted)
    if (restored) onProgress?.('Restored your workspace')
    // A mount writes a tree into the container, and a snapshot taken by an
    // older layout can carry the whole working directory rather than the
    // workspace inside it. Re-asserting costs two idempotent calls and covers
    // the case where the first command would otherwise have nowhere to stage.
    await ensureStaging(booted)
    // After the mount, never before it: a snapshot is written over the whole
    // working directory, so a shell installed first is a shell the restore
    // deletes. Python's own interpreter comes back the same way, from its own
    // record, so a returning visitor does not download it twice.
    // Bounded on its own, because it happens inside the boot deadline: a stored
    // interpreter is tens of megabytes, and a slow read of it must cost the
    // first `python3` a download rather than cost the page its container.
    if (await withinBudget(restorePython(booted), RESTORE_BUDGET_MS)) onProgress?.('Restored Python')
    onProgress?.('Installing the shell and Python')
    await installPrograms(booted)
    durability = persistWorkspace(booted)
    pythonDurability = persistPython(booted)
    ready = true
    return booted
  })()).catch((error: unknown) => {
    // Recorded rather than only thrown so every later consumer takes the same
    // fallback instead of repeating a boot that already proved unusable.
    ready = false
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
  if (ready) return true
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
  return ready
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
  const env = environment(runtime, options.env)

  // Not `-c <script>`: the runtime unescapes backslashes in argv, so a script
  // passed as an argument arrives subtly different from the one the agent wrote
  // — `sed 's/a/\n/'` loses its escape and the command quietly does the wrong
  // thing. A file's bytes survive intact.
  const scriptFile = `${PRIVATE_DIR}/run-${String(runCounter++)}.sh`
  try {
    await runtime.fs.writeFile(scriptFile, script)
  } catch {
    // The staging directory is gone — see `ensureStaging`. Putting it back and
    // writing again turns a session that fails every command until reload into
    // one command that took a moment longer, and restores the shell program
    // beside it, which a tree-wide clobber would have taken too.
    await installPrograms(runtime)
    await runtime.fs.writeFile(scriptFile, script)
  }
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
  // A workspace the user picked exists wherever they made it, and the container
  // only has what someone put there. Creating it on the way in is what keeps
  // "the agent and the terminal are one machine" true for a workspace that is
  // not the default one — the alternative is every command in that session
  // failing with `no such file or directory` and nothing saying which one.
  const workdir = toContainerPath(options.cwd ?? WORKSPACE)
  await ensureDirectory(runtime, workdir)
  const process = await runtime.spawn(argv[0], [...argv[1]], { cwd: workdir, env })

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
  // The same for anything a command installed into Python, which is compared
  // before it is copied — most commands change nothing there.
  pythonDurability?.touch()
  return { status, stdout: output, stderr: '' }
}

/**
 * Directories this page has already made sure of, so the common case costs one
 * `Set` lookup rather than a call into the container per command.
 */
const ensured = new Set<string>()

/**
 * Make sure a working directory exists in the container.
 *
 * Cheap and unconditional rather than a retry after a failure: a missing cwd
 * does not fail the spawn, it fails the process after it has started, which
 * arrives as a bare `no such file or directory` with nothing to catch it around
 * and no way to tell it from the command's own error.
 * @param runtime - the booted container.
 * @param workdir - the directory, as the container names it.
 */
async function ensureDirectory(runtime: WebContainer, workdir: string): Promise<void> {
  if (workdir === '.' || ensured.has(workdir)) return
  await runtime.fs.mkdir(workdir, { recursive: true }).catch(() => undefined)
  ensured.add(workdir)
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
    env: environment(runtime),
    terminal: { cols: size.cols, rows: size.rows },
  })
}

/** The runtime's filesystem, for the agent's file tools. */
export async function runtimeFs(): Promise<WebContainer['fs']> {
  return (await bootRuntime()).fs
}
