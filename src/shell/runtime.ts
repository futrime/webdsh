/**
 * Shell runtime types: the process environment a command runs in, the streams
 * it reads and writes, and the registry external commands live in.
 */

import type { Volume } from '../vfs/volume.ts'

/** A byte sink. Commands write text; the shell owns encoding. */
export interface Sink {
  write(text: string): void
}

/** Collects everything written, with a hard cap so a runaway loop cannot exhaust memory. */
export class BufferSink implements Sink {
  private readonly chunks: string[] = []
  private length = 0
  private truncated = false

  constructor(private readonly limit = 8 * 1024 * 1024) {}

  write(text: string): void {
    if (this.truncated) return
    this.length += text.length
    if (this.length > this.limit) {
      this.chunks.push(text.slice(0, Math.max(0, text.length - (this.length - this.limit))))
      this.chunks.push(`\n[output truncated at ${String(this.limit)} bytes]\n`)
      this.truncated = true
      return
    }
    this.chunks.push(text)
  }

  /** Everything written so far. */
  text(): string {
    return this.chunks.join('')
  }

  /** Whether the cap cut the output short. */
  wasTruncated(): boolean {
    return this.truncated
  }
}

/** Forwards writes to a callback (the streaming path the bash tool uses). */
export class CallbackSink implements Sink {
  constructor(private readonly emit: (text: string) => void) {}
  write(text: string): void {
    this.emit(text)
  }
}

/** Discards writes (`> /dev/null`). */
export const nullSink: Sink = { write: () => {} }

/** Signals a `return` from a shell function. */
export class ReturnSignal {
  constructor(readonly status: number) {}
}

/** Signals `exit` from the script. */
export class ExitSignal {
  constructor(readonly status: number) {}
}

/** Signals `break`/`continue` inside a loop. */
export class LoopSignal {
  constructor(readonly kind: 'break' | 'continue', public levels: number) {}
}

/**
 * A consumable view of a command's standard input.
 *
 * `read` takes one line and leaves the rest, which is what lets
 * `… | while read line; do …; done` reach the end of its input instead of
 * repeating the first line until a loop guard stops it.
 */
export interface InputCursor {
  /** The whole input. */
  text: string
  /** How much of it has been consumed. */
  offset: number
}

/** One command invocation's context. */
export interface CommandContext {
  /** `argv[0]` is the command name. */
  argv: string[]
  /** The shell state, so builtins can mutate `cwd`, variables, and functions. */
  shell: ShellState
  /** What is left to read. */
  stdin: string
  stdout: Sink
  stderr: Sink
  /** The shared read position, when the caller keeps one. */
  input?: InputCursor
  /** Cancels a long-running command (the bash tool's timeout). */
  signal?: AbortSignal
}

/** An external command implementation. */
export type CommandImpl = (context: CommandContext) => number | Promise<number>

/** Mutable interpreter state, shared by a script and its functions. */
export interface ShellState {
  volume: Volume
  /** Current working directory (absolute). */
  cwd: string
  /** Exported plus shell-local variables; exported ones reach child commands. */
  vars: Map<string, string>
  /** Indexed arrays, which are a separate namespace from plain variables. */
  arrays: Map<string, string[]>
  /** Names marked for export. */
  exported: Set<string>
  /** Positional parameters `$1…`. */
  positional: string[]
  /** `$0`. */
  scriptName: string
  /** Last command's exit status (`$?`). */
  status: number
  /** Shell functions by name. */
  functions: Map<string, unknown>
  /** External command registry. */
  commands: Map<string, CommandImpl>
  /**
   * Last resort for a name the registry does not hold.
   *
   * In the page there is nothing else to try and the shell reports
   * `command not found`. Running inside the container there is: a real `$PATH`
   * with `node`, `npm`, `python3` and `pip` on it, which this shell must not
   * shadow with an emulation. Left unset, dispatch is unchanged.
   */
  external?: CommandImpl
  /** `set -e` / `set -x` / `set -u`. */
  options: { errexit: boolean, xtrace: boolean, nounset: boolean, pipefail: boolean }
  /** Cancellation for the whole script. */
  signal?: AbortSignal
  /** Depth guard against runaway recursion in shell functions. */
  depth: number
  /**
   * Active file-effect confinement, set by the `dsh-confine` guard the sandbox
   * backend prefixes onto a command's argv. Absent means unconfined.
   */
  sandbox?: { mode: 'read-only' | 'workspace-write', roots: string[] }
}

/**
 * Refuse a write the active confinement does not permit.
 *
 * `read-only` permits only the throwaway sinks a command legitimately needs;
 * `workspace-write` adds the workspace root and the temp area. This is the
 * browser's counterpart to Landlock/Seatbelt: the enforcement point is the
 * virtual filesystem rather than the kernel, but the policy vocabulary and the
 * refusal are the same.
 * @param state - the running shell.
 * @param path - the absolute path about to be written.
 * @throws when the policy forbids the write.
 */
export function assertWritable(state: ShellState, path: string): void {
  const policy = state.sandbox
  if (policy === undefined) return
  const allowed = policy.roots.some(root => path === root || path.startsWith(`${root}/`))
  if (allowed) return
  const error = new Error(
    `${path}: write denied by the ${policy.mode} sandbox policy`
    + (policy.mode === 'read-only' ? '' : ` (writable: ${policy.roots.join(', ')})`),
  ) as Error & { code: string }
  error.code = 'EACCES'
  throw error
}

/** Read a variable, falling back to the empty string. */
export function readVar(state: ShellState, name: string): string {
  return state.vars.get(name) ?? ''
}

/** Set a variable, preserving its exported flag. */
export function setVar(state: ShellState, name: string, value: string): void {
  state.vars.set(name, value)
}

/** The environment a child command sees (exported variables only). */
export function exportedEnv(state: ShellState): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of state.exported) {
    const value = state.vars.get(name)
    if (value !== undefined) env[name] = value
  }
  return env
}
