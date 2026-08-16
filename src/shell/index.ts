/**
 * The shell entry point: assemble a {@link ShellState}, register every command,
 * and run a script.
 *
 * This is what `node:child_process` and dsh's `ctx.shell` backend both call, so
 * `bash -lc '…'` from the model, a `spawn()` from a plugin, and an interactive
 * terminal all execute the same interpreter over the same VFS.
 */

import { Interpreter } from './interpreter.ts'
import { coreutils, parseArgs } from './coreutils.ts'
import { tools } from './tools.ts'
import { gitCommand } from './git.ts'
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
  registry.set('git', gitCommand)
  // `rg` is what agents reach for; map it onto the recursive grep behavior with
  // ripgrep's defaults (recursive, line numbers, skip .git).
  registry.set('rg', (context) => {
    const { operands, flags } = parseArgs(context.argv)
    const argv = ['grep', '-r', '-n', '--exclude-dir=.git', '--exclude-dir=node_modules']
    if (flags.has('i')) argv.push('-i')
    if (flags.has('l')) argv.push('-l')
    if (flags.has('c')) argv.push('-c')
    if (flags.has('w')) argv.push('-w')
    if (flags.has('F')) argv.push('-F')
    argv.push(...operands)
    return coreutils.grep({ ...context, argv })
  })
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
 * Run a shell script to completion.
 * @param script - the shell source.
 * @param options - execution environment and streaming hooks.
 * @returns the exit status and captured output.
 */
export async function runShell(script: string, options: RunOptions = {}): Promise<RunResult> {
  const state = createShellState(options)
  const stdoutBuffer = new BufferSink()
  const stderrBuffer = new BufferSink()
  const stdout: Sink = options.onStdout === undefined
    ? stdoutBuffer
    : { write: (text) => { stdoutBuffer.write(text); options.onStdout!(text) } }
  const stderr: Sink = options.onStderr === undefined
    ? stderrBuffer
    : { write: (text) => { stderrBuffer.write(text); options.onStderr!(text) } }

  const interpreter = new Interpreter(state)
  // `xargs` needs to re-enter the interpreter, so it is registered per run.
  state.commands.set('xargs', async (context) => {
    const { flags, operands, values } = parseArgs(context.argv, 'In')
    const items = context.stdin.split(flags.has('0') ? '\0' : /\s+/).filter(item => item.length > 0)
    if (items.length === 0) return 0
    const base = operands.length > 0 ? operands : ['echo']
    const placeholder = values.get('I')
    const batchSize = values.has('n') ? Number(values.get('n')) : (placeholder === undefined ? items.length : 1)
    let status = 0
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      const argv = placeholder === undefined
        ? [...base, ...batch]
        : base.map(token => token.replaceAll(placeholder, batch[0]))
      const quoted = argv.map(token => `'${token.replaceAll("'", `'\\''`)}'`).join(' ')
      const result = await interpreter.run(quoted, { stdin: '', stdout: context.stdout, stderr: context.stderr })
      if (result !== 0) status = result
    }
    return status
  })

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
