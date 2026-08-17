/**
 * The shell entry point: assemble a {@link ShellState}, register every command,
 * and run a script.
 *
 * This is what `node:child_process` and dsh's `ctx.shell` backend both call, so
 * `bash -lc '…'` from the model, a `spawn()` from a plugin, and an interactive
 * terminal all execute the same interpreter over the same VFS.
 */

import { Interpreter } from './interpreter.ts'
import { coreutils } from './coreutils.ts'
import { registerReentrant } from './reentrant.ts'
import { tools } from './tools.ts'
import { gitCommand } from './git.ts'
import { ripgrep } from './ripgrep.ts'
import { nodeCommand } from './node-runtime.ts'
import { npmCommand } from './npm.ts'
import { busybox } from './busybox.ts'
import { archive } from './archive.ts'
import { awk } from './awk.ts'
import { BufferSink, CallbackSink, type CommandImpl, type ShellState, type Sink } from './runtime.ts'
import { volume } from '../vfs/volume.ts'
import { env as processEnv, process as processShim } from '../node/process.ts'

/** Options for one shell run. */
export interface RunOptions {
  /** Working directory; defaults to the process cwd. */
  cwd?: string
  /** Extra or overriding environment variables. */
  env?: Record<string, string | undefined>
  /** Text fed to the script's stdin. */
  stdin?: string
  /** Called with each stdout chunk as it is produced. */
  onStdout?: (chunk: string) => void
  /** Called with each stderr chunk as it is produced. */
  onStderr?: (chunk: string) => void
  /** Cancels the run (the bash tool's timeout, or an abort from the UI). */
  signal?: AbortSignal
  /** Positional parameters `$1…`. */
  args?: string[]
}

/** Result of one shell run. */
export interface RunResult {
  status: number
  stdout: string
  stderr: string
  /** True when either stream hit the output cap. */
  truncated: boolean
}

/** Commands every shell instance starts with. */
function buildRegistry(): Map<string, CommandImpl> {
  const registry = new Map<string, CommandImpl>()
  for (const [name, impl] of Object.entries(coreutils)) registry.set(name, impl)
  for (const [name, impl] of Object.entries(tools)) registry.set(name, impl)
  // The wider applet set. Registered after coreutils so a name defined in both
  // keeps the implementation the agent's tool calls already depend on.
  for (const [name, impl] of Object.entries(busybox)) if (!registry.has(name)) registry.set(name, impl)
  for (const [name, impl] of Object.entries(archive)) if (!registry.has(name)) registry.set(name, impl)
  for (const name of ['awk', 'gawk', 'mawk', 'nawk']) registry.set(name, awk)
  registry.set('git', gitCommand)
  // `rg` is not a convenience alias here: it is the backend the `grep` and
  // `glob` tools spawn, so it has to speak ripgrep's own argument vector and
  // JSON output rather than approximate it with the coreutils grep.
  // The absolute spelling is what the search tool spawns, since that is the
  // path `@vscode/ripgrep` reports; the bare name is what a person types.
  for (const name of ['rg', '/usr/bin/rg']) registry.set(name, ripgrep)
  // A real JavaScript runtime and package manager, not stubs: this host already
  // implements the Node platform and can reach the registry, so the parts of
  // both that do not need a native toolchain genuinely work.
  for (const name of ['node', '/usr/bin/node', '/usr/local/bin/node']) registry.set(name, nodeCommand)
  for (const name of ['npm', 'pnpm', 'yarn']) registry.set(name, npmCommand)
  registry.set('npx', async context => npmCommand({ ...context, argv: ['npm', 'exec', ...context.argv.slice(1)] }))
  return registry
}

/** Build a fresh shell state. */
export function createShellState(options: RunOptions = {}): ShellState {
  const vars = new Map<string, string>()
  const exported = new Set<string>()
  for (const [name, value] of Object.entries({ ...processEnv, ...options.env })) {
    if (value === undefined) continue
    vars.set(name, value)
    exported.add(name)
  }
  const cwd = options.cwd ?? processShim.cwd()
  vars.set('PWD', cwd)
  exported.add('PWD')
  return {
    volume,
    cwd,
    vars,
    arrays: new Map(),
    exported,
    positional: options.args ?? [],
    scriptName: 'sh',
    status: 0,
    functions: new Map(),
    commands: buildRegistry(),
    options: { errexit: false, xtrace: false, nounset: false, pipefail: false },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    depth: 0,
  }
}

/**
 * A shell that keeps its state between commands.
 *
 * `runShell` is one-shot by construction — every tool call is its own process —
 * but a terminal is not: `cd src` then `ls` has to list the new directory, and
 * `export KEY=…` has to still be set on the next line. Both faces run the same
 * interpreter over the same VFS, so what the user types in a terminal and what
 * the agent runs in a tool call are the same environment.
 */
export interface ShellSession {
  /** Run one command line, keeping cwd, variables, and functions. */
  run(script: string, options?: RunOptions): Promise<RunResult>
  /** The session's current working directory. */
  cwd(): string
  /** The live interpreter state, for a caller that needs to inspect it. */
  readonly state: ShellState
}

/**
 * Build a shell session.
 * @param options - the initial environment.
 * @returns the session.
 */
export function createShellSession(options: RunOptions = {}): ShellSession {
  const state = createShellState(options)
  const interpreter = prepare(state)
  return {
    state,
    cwd: () => state.cwd,
    async run(script: string, runOptions: RunOptions = {}): Promise<RunResult> {
      return execute(interpreter, state, script, runOptions)
    },
  }
}

/**
 * Run a shell script to completion in a fresh session.
 * @param script - the shell source.
 * @param options - execution environment and streaming hooks.
 * @returns the exit status and captured output.
 */
export async function runShell(script: string, options: RunOptions = {}): Promise<RunResult> {
  const state = createShellState(options)
  return execute(prepare(state), state, script, options)
}

/**
 * Run one script against an already-prepared interpreter.
 * @param interpreter - the session's interpreter.
 * @param state - the session's mutable state.
 * @param script - the shell source.
 * @param options - per-run streaming hooks, stdin, and cancellation.
 * @returns the exit status and captured output.
 */
async function execute(interpreter: Interpreter, state: ShellState, script: string, options: RunOptions): Promise<RunResult> {
  const stdoutBuffer = new BufferSink()
  const stderrBuffer = new BufferSink()
  const stdout: Sink = options.onStdout === undefined
    ? stdoutBuffer
    : { write: (text) => { stdoutBuffer.write(text); options.onStdout!(text) } }
  const stderr: Sink = options.onStderr === undefined
    ? stderrBuffer
    : { write: (text) => { stderrBuffer.write(text); options.onStderr!(text) } }
  if (options.args !== undefined) state.positional = options.args
  if (options.signal !== undefined) state.signal = options.signal
  return runWith(interpreter, state, script, options, stdout, stderr, stdoutBuffer, stderrBuffer)
}

/**
 * Build the interpreter for a state and register the commands that need to
 * re-enter it.
 * @param state - the shell state the interpreter drives.
 * @returns the prepared interpreter.
 */
function prepare(state: ShellState): Interpreter {
  const interpreter = new Interpreter(state)
  registerReentrant(interpreter, state)

  // `bash`/`sh` as first-class commands.
  //
  // A confined tool call arrives as `dsh-confine … -- bash -lc <script>`, so the
  // shell has to be able to run a shell. Without this, `bash` resolves through
  // $PATH to the `/bin/bash` marker file — which exists only so executable
  // lookup succeeds — and the script silently produces nothing.
  const runNestedShell: CommandImpl = async (context) => {
    const args = context.argv.slice(1)
    const dashC = args.findIndex(argument => /^-[a-z]*c[a-z]*$/.test(argument))
    if (dashC !== -1) {
      const script = args[dashC + 1] ?? ''
      const saved = state.positional
      state.positional = args.slice(dashC + 2)
      try {
        return await interpreter.run(script, { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr })
      } finally {
        state.positional = saved
      }
    }
    const file = args.find(argument => !argument.startsWith('-'))
    if (file === undefined) return 0
    const quoted = `. '${file.replaceAll("'", `'\\''`)}'`
    return interpreter.run(quoted, { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr })
  }
  for (const name of ['sh', 'bash', 'zsh', 'dash', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash']) {
    state.commands.set(name, runNestedShell)
  }

  // The guard the sandbox backend prefixes onto a confined command's argv.
  // It installs the policy for the duration of the wrapped command only, so a
  // later command in the same script is judged on its own policy.
  state.commands.set('dsh-confine', async (context) => {
    const [, mode, workspaceRoot, ...rest] = context.argv
    const argv = rest[0] === '--' ? rest.slice(1) : rest
    if (mode !== 'read-only' && mode !== 'workspace-write') {
      context.stderr.write(`dsh-confine: unknown mode '${mode}'\n`)
      return 2
    }
    const roots = mode === 'read-only'
      ? ['/dev/null']
      : [workspaceRoot, '/tmp', state.vars.get('TMPDIR') ?? '/tmp'].filter(Boolean)
    const previous = state.sandbox
    state.sandbox = { mode, roots: [...new Set(roots)] }
    try {
      const quoted = argv.map(token => `'${token.replaceAll("'", `'\\''`)}'`).join(' ')
      return await interpreter.run(quoted, { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr })
    } finally {
      state.sandbox = previous
    }
  })

  return interpreter
}

/**
 * Drive one script and collect its result.
 * @returns the exit status and captured output.
 */
async function runWith(
  interpreter: Interpreter, state: ShellState, script: string, options: RunOptions,
  stdout: Sink, stderr: Sink, stdoutBuffer: BufferSink, stderrBuffer: BufferSink,
): Promise<RunResult> {
  void state
  let status: number
  try {
    status = await interpreter.run(script, { stdin: options.stdin ?? '', stdout, stderr })
  } catch (error) {
    if (options.signal?.aborted === true) {
      stderr.write('\nsh: interrupted\n')
      status = 130
    } else {
      stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
      status = 1
    }
  }

  // The interpreter mutates the shared state's cwd; mirror it onto the process
  // so a `cd` in one tool call is visible to the next (matching a real shell
  // session only when the caller opts in via `cwd`).
  return {
    status,
    stdout: stdoutBuffer.text(),
    stderr: stderrBuffer.text(),
    truncated: stdoutBuffer.wasTruncated() || stderrBuffer.wasTruncated(),
  }
}

export { BufferSink, CallbackSink }
export type { ShellState }
