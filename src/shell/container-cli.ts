/**
 * The shell, as a program that runs inside the container.
 *
 * The container ships `jsh`, which is not a shell in the sense the harness
 * needs: it has no `for`, `if`, `while`, `case`, functions, heredocs, or `<`
 * redirection, and — worst of all — command substitution expands to the empty
 * string and *succeeds*, so `count=$(ls | wc -l)` reports success and a wrong
 * answer rather than failing. An agent cannot work against a shell that lies.
 *
 * dsh on a machine gets a real bash. This build already has a real shell — the
 * interpreter in this directory, written for the page — so rather than
 * approximate bash a third time, the same interpreter is bundled as a Node
 * program and run inside the container, where `node:fs` gives it the
 * container's own files and `child_process` gives it the container's own
 * executables. What the agent gets is this shell's language and builtins over
 * the runtime's filesystem, with `node`, `npm`, and `python3` still being the
 * real ones.
 *
 * Invoked as `node sh.cjs <file> [args…]` or `node sh.cjs -c <script> [args…]`.
 * The harness uses the file form: the runtime's `spawn` unescapes backslashes
 * in argv — `printf "a\nb"` arrives as `printf "anb"` — so a script that
 * travels as an argument is silently corrupted, while a file's bytes are its
 * own.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Interpreter } from './interpreter.ts'
import { coreutils } from './coreutils.ts'
import { busybox } from './busybox.ts'
import { awk } from './awk.ts'
import { ripgrep } from './ripgrep.ts'
import { gitCommand } from './git.ts'
import { registerReentrant } from './reentrant.ts'
import { volume } from '../vfs/volume.ts'
import {
  ExitSignal, LoopSignal, ReturnSignal,
  type CommandImpl, type ShellState, type Sink,
} from './runtime.ts'

/**
 * Commands the container provides better than this shell can.
 *
 * `node` and `npm` are the real ones — the page's emulations exist because a
 * page has no processes, and registering them here would replace a working
 * toolchain with an imitation of it. The rest are simply present in `$PATH`.
 */
const PREFER_EXTERNAL = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3', 'python', 'jq', 'curl', 'code'])

/** Build the command table for a shell running inside the container. */
function buildRegistry(): Map<string, CommandImpl> {
  const registry = new Map<string, CommandImpl>()
  for (const [name, impl] of Object.entries(coreutils)) registry.set(name, impl)
  for (const [name, impl] of Object.entries(busybox)) if (!registry.has(name)) registry.set(name, impl)
  for (const name of ['awk', 'gawk', 'mawk', 'nawk']) registry.set(name, awk)
  for (const name of ['rg', '/usr/bin/rg']) registry.set(name, ripgrep)
  // The container has no git at all, so the JavaScript one is not a substitute
  // for anything — it is the only git there is.
  registry.set('git', gitCommand)
  for (const name of PREFER_EXTERNAL) registry.delete(name)
  return registry
}

/**
 * Run a real executable from the container's `$PATH`.
 *
 * Reached only when nothing this shell implements answers to the name. stdin is
 * handed over as a string because that is what the interpreter models a pipe
 * as; the child's streams are captured rather than inherited so its output
 * flows through the same pipeline and redirections as any builtin's.
 */
function spawnExternal(state: ShellState): CommandImpl {
  return (context) => {
    const [name, ...args] = context.argv
    const env: Record<string, string> = {}
    for (const key of state.exported) {
      const value = state.vars.get(key)
      if (value !== undefined) env[key] = value
    }
    const result = spawnSync(name, args, {
      cwd: state.cwd,
      env,
      input: context.stdin,
      encoding: 'utf8',
      // Large enough that a build log or a directory listing is not silently
      // cut in half; the shell's own sinks apply the real cap.
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        context.stderr.write(`sh: ${name}: command not found\n`)
        return 127
      }
      context.stderr.write(`sh: ${name}: ${result.error.message}\n`)
      return 126
    }
    if (result.stdout !== null && result.stdout !== '') context.stdout.write(result.stdout)
    if (result.stderr !== null && result.stderr !== '') context.stderr.write(result.stderr)
    // A child killed by a signal reports status the way a shell does.
    if (result.status === null) return result.signal === null ? 1 : 128
    return result.status
  }
}

/** Assemble the interpreter state for one invocation. */
function createState(cwd: string, args: string[]): ShellState {
  const vars = new Map<string, string>()
  const exported = new Set<string>()
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    vars.set(name, value)
    exported.add(name)
  }
  vars.set('PWD', cwd)
  exported.add('PWD')
  const state: ShellState = {
    volume,
    cwd,
    vars,
    exported,
    positional: args,
    scriptName: 'sh',
    status: 0,
    functions: new Map(),
    commands: buildRegistry(),
    options: { errexit: false, xtrace: false, nounset: false, pipefail: false },
    depth: 0,
  }
  state.external = spawnExternal(state)
  return state
}

/** Write straight through to the real stream, so output streams as it is produced. */
function passthrough(stream: NodeJS.WriteStream): Sink {
  return { write: (text: string) => { stream.write(text) } }
}

/** Read everything on stdin, or nothing when it is not a pipe. */
function readStdin(): string {
  try {
    // A terminal has no end, so reading one would hang; a pipe or file does.
    if (process.stdin.isTTY === true) return ''
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Read the script to run, from a file or from `-c`. */
function readScript(argv: string[]): { script: string, args: string[] } | undefined {
  const dashC = argv.indexOf('-c')
  if (dashC !== -1) {
    const script = argv[dashC + 1]
    if (script === undefined) return undefined
    return { script, args: argv.slice(dashC + 2) }
  }
  const [file, ...args] = argv
  if (file === undefined) return undefined
  return { script: readFileSync(file, 'utf8'), args }
}

/** Run the script named on the command line. */
async function main(): Promise<number> {
  const requested = readScript(process.argv.slice(2))
  if (requested === undefined) {
    process.stderr.write('sh: usage: sh <file> [args…] | sh -c <script> [args…]\n')
    return 2
  }
  const { script, args } = requested
  const state = createState(process.cwd(), args)
  const interpreter = new Interpreter(state)
  registerReentrant(interpreter, state)

  // `bash`/`sh` inside a script must re-enter this interpreter rather than
  // resolve to the container's `jsh`, or a nested command silently changes
  // shells halfway through a script.
  const nested: CommandImpl = async (context) => {
    const args = context.argv.slice(1)
    const index = args.findIndex(argument => /^-[a-z]*c[a-z]*$/.test(argument))
    if (index === -1) return 0
    const saved = state.positional
    state.positional = args.slice(index + 2)
    try {
      return await interpreter.run(args[index + 1] ?? '', {
        stdin: context.stdin, stdout: context.stdout, stderr: context.stderr,
      })
    } finally {
      state.positional = saved
    }
  }
  for (const name of ['sh', 'bash', 'zsh', 'dash', 'jsh', '/bin/sh', '/bin/bash', '/bin/jsh']) {
    state.commands.set(name, nested)
  }

  const stdout = passthrough(process.stdout)
  const stderr = passthrough(process.stderr)
  try {
    return await interpreter.run(script, { stdin: readStdin(), stdout, stderr })
  } catch (error) {
    if (error instanceof ExitSignal) return error.status
    if (error instanceof ReturnSignal || error instanceof LoopSignal) return 0
    stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

main().then(
  (status) => { process.exitCode = status },
  (error: unknown) => {
    process.stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
