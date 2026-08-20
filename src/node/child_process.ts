/**
 * `node:child_process` over the in-browser shell.
 *
 * dsh's `dsh-subprocess-local` is kept as the real subprocess provider — with
 * its stdio dispositions, collect-with-spill buffering, grace escalation, and
 * tree-liveness observation intact — and only the OS primitive underneath it is
 * swapped. `spawn('bash', ['-c', script])` therefore runs the script through
 * {@link runShell}, and every layer above (`bash-sandbox`, `tool-bash`,
 * `ctx.shell`) behaves as it does on a real machine.
 *
 * The pid registry is load-bearing: `spawn.ts` probes `process.kill(-pid, 0)`
 * to decide whether a process tree is still alive, so a shim that always
 * reported success would leave its observer spinning forever.
 */

import { runShell } from '../shell/index.ts'
import { execute as executeInRuntime, runtimeReady } from '../runtime/webcontainer.ts'
import { isRipgrep, ripgrep } from '../runtime/ripgrep.ts'
import { ReadableStreamShim, StreamEmitter, WritableStreamShim } from './streams.ts'
import { Buffer, toText } from './binary.ts'
import { process as processShim, setProcessTable } from './process.ts'
import { volume } from '../vfs/volume.ts'
import { announceOpenPath, OPEN_PATH_COMMAND } from './open-path.ts'
import { resolve as resolvePath } from './path.ts'

/**
 * Render a thrown value for a command's stderr.
 *
 * `String(value)` on a plain object yields `[object Object]`, which tells the
 * model — and whoever is reading the transcript — nothing at all. Anything that
 * is not an Error is more useful serialised.
 * @param error - whatever was thrown.
 * @returns a line worth printing.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

/** Live pid → child, so `process.kill(pid, 0)` can answer truthfully. */
const livePids = new Map<number, ChildProcessShim>()
let nextPid = 1000

/** Whether a pid (or, when negative, its process group) is still running. */
export function isPidAlive(pid: number): boolean {
  return livePids.has(Math.abs(pid))
}

setProcessTable(
  pid => livePids.has(Math.abs(pid)),
  (pid, signal) => { livePids.get(Math.abs(pid))?.kill(signal as NodeJS.Signals) },
)

/** A spawned "process". */
export class ChildProcessShim extends StreamEmitter {
  readonly pid: number
  readonly stdout: ReadableStreamShim | null
  readonly stderr: ReadableStreamShim | null
  readonly stdin: WritableStreamShim | null
  readonly stdio: (ReadableStreamShim | WritableStreamShim | null)[]
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  private readonly abort = new AbortController()
  private stdinBuffer = ''
  private stdinClosed = false
  private started = false

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: { cwd?: string, env?: Record<string, string | undefined>, stdio?: unknown, input?: string },
  ) {
    super()
    this.pid = nextPid++
    livePids.set(this.pid, this)
    const stdioSpec = Array.isArray(options.stdio) ? options.stdio : [options.stdio ?? 'pipe', options.stdio ?? 'pipe', options.stdio ?? 'pipe']
    this.stdout = stdioSpec[1] === 'ignore' ? null : new ReadableStreamShim()
    this.stderr = stdioSpec[2] === 'ignore' ? null : new ReadableStreamShim()
    this.stdin = stdioSpec[0] === 'ignore'
      ? null
      : new WritableStreamShim(
        (chunk) => { this.stdinBuffer += toText(chunk) },
        () => {
          this.stdinClosed = true
          if (!this.started) this.begin()
        },
      )
    this.stdio = [this.stdin, this.stdout, this.stderr]
    if (options.input !== undefined) {
      this.stdinBuffer = options.input
      this.stdinClosed = true
    }
    // Give the caller one turn to attach listeners and write stdin before the
    // script runs, matching the "spawn returns before the child runs" ordering.
    queueMicrotask(() => {
      if (!this.started) this.begin()
    })
  }

  /** Execute the command through the shell. */
  private begin(): void {
    if (this.started) return
    this.started = true
    void this.execute()
  }

  private async execute(): Promise<void> {
    // The search tools spawn ripgrep by path and parse its output. The runtime
    // is Node rather than a distribution, so there is no such binary; the
    // implementation over the runtime's own filesystem stands in for it, and
    // has to be reached before the argv is turned into a shell command line.
    if (isRipgrep(this.command) && await runtimeReady()) {
      try {
        const result = await ripgrep(this.args, this.options.cwd)
        if (result.stdout !== '') this.stdout?.push(result.stdout)
        if (result.stderr !== '') this.stderr?.push(result.stderr)
        this.settle(result.status, null)
      } catch (error) {
        this.stderr?.push(`${describe(error)}\n`)
        this.settle(2, null)
      }
      return
    }
    // Opening a path is the harness asking its *host* to show the user
    // something, and this host is a page. Reached before the command line is
    // built for the same reason ripgrep is: the runtime has an `xdg-open` of
    // its own, and a stub inside the container cannot show anybody anything.
    if (this.command === OPEN_PATH_COMMAND) {
      const target = this.args.find(argument => !argument.startsWith('-'))
      if (target === undefined) {
        this.stderr?.push(`${OPEN_PATH_COMMAND}: expects a path\n`)
        this.settle(2, null)
        return
      }
      this.settle(announceOpenPath(resolvePath(this.options.cwd ?? processShim.cwd(), target)) ? 0 : 1, null)
      return
    }
    const script = buildScript(this.command, this.args)
    if (script === undefined) {
      livePids.delete(this.pid)
      queueMicrotask(() => {
        const error = new Error(`spawn ${this.command} ENOENT`) as Error & { code: string, errno: number, syscall: string, path: string }
        error.code = 'ENOENT'
        error.errno = -2
        error.syscall = `spawn ${this.command}`
        error.path = this.command
        this.emit('error', error)
      })
      return
    }
    const cwd = this.options.cwd ?? processShim.cwd()
    try {
      // The runtime is where the terminal runs, so it is where a tool call has
      // to run too — otherwise the agent and the user are on different
      // machines, and a file one of them creates does not exist for the other.
      // The in-page shell remains the fallback for a browser that cannot host
      // the runtime at all.
      if (await runtimeReady()) {
        const result = await executeInRuntime(script.source, {
          cwd,
          env: (this.options.env ?? processShim.env) as Record<string, string | undefined>,
          stdin: this.stdinClosed ? this.stdinBuffer : '',
          ...(script.name === undefined ? {} : { name: script.name }),
          args: script.args,
          signal: this.abort.signal,
          onStdout: chunk => { this.stdout?.push(chunk) },
          onStderr: chunk => { this.stderr?.push(chunk) },
        })
        this.settle(result.status, null)
        return
      }
      const result = await runShell(script.source, {
        cwd,
        env: this.options.env ?? processShim.env,
        stdin: this.stdinClosed ? this.stdinBuffer : '',
        args: script.args,
        signal: this.abort.signal,
        onStdout: chunk => { this.stdout?.push(chunk) },
        onStderr: chunk => { this.stderr?.push(chunk) },
      })
      this.settle(result.status, null)
    } catch (error) {
      this.stderr?.push(`${describe(error)}\n`)
      this.settle(1, null)
    }
  }

  /** Publish exit facts and end the output streams. */
  private settle(code: number, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    livePids.delete(this.pid)
    this.stdout?.end()
    this.stderr?.end()
    queueMicrotask(() => {
      this.emit('exit', code, signal)
      this.emit('close', code, signal)
    })
  }

  /**
   * Terminate the "process".
   * @param signal - accepted for parity; SIGKILL and SIGTERM both abort the run.
   * @returns whether a signal was delivered.
   */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    this.abort.abort(new Error(`killed by ${String(signal)}`))
    this.settle(signal === 'SIGKILL' || signal === 9 ? 137 : 143, typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }

  ref(): this { return this }
  unref(): this { return this }
  disconnect(): void {}
  get connected(): boolean { return false }
  send(): boolean { return false }
}

/** Turn a spawn argv into a shell script, its `$0`, and its positional parameters. */
function buildScript(command: string, args: string[]): { source: string, name?: string, args: string[] } | undefined {
  const name = command.split('/').pop() ?? command
  // The shell family: `-c script` runs the script text directly.
  if (name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash') {
    // Options are scanned rather than searched for, because the script is not
    // simply "whatever follows -c". A caller may end the options explicitly —
    // `bash -lc -- '<script>'` is what the harness spawns, and taking the next
    // token made the script literally `--`, so every tool call died with
    // `sh: --: command not found`. Long options like `--noprofile` are skipped
    // the same way a shell skips them.
    let sawCommandFlag = false
    let index = 0
    for (; index < args.length; index++) {
      const argument = args[index]
      if (argument === '--') { index++; break }
      if (!argument.startsWith('-')) break
      // `-c`, and the bundled forms a caller may write it in: `-lc`, `-lic`,
      // `-ec`. A long option never carries it.
      if (!argument.startsWith('--') && argument.includes('c')) sawCommandFlag = true
    }
    const rest = args.slice(index)
    // POSIX: `sh -c <script> [name [arg…]]` — the token after the script is
    // `$0`, and the positional parameters start after it.
    if (sawCommandFlag) {
      return {
        source: rest[0] ?? '',
        ...(rest[1] === undefined ? {} : { name: rest[1] }),
        args: rest.slice(2),
      }
    }
    if (rest.length > 0) {
      // Running a script file: its own name is `$0`.
      return { source: `. ${quote(rest[0])}`, name: rest[0], args: rest.slice(1) }
    }
    return { source: '', args: [] }
  }
  if (name === 'env') {
    // `env VAR=x cmd …` — the shell understands the assignment prefix natively.
    return { source: args.map(quote).join(' '), args: [] }
  }
  // Anything else: run it as a command line through the shell so the command
  // registry (and $PATH lookup for VFS scripts) resolves it.
  return { source: [command, ...args].map(quote).join(' '), args: [] }
}

/** Single-quote a token for the shell. */
function quote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`
}

/** `child_process.spawn`. */
export function spawn(command: string, argsOrOptions?: string[] | Record<string, unknown>, maybeOptions?: Record<string, unknown>): ChildProcessShim {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {}
  return new ChildProcessShim(command, args, options as { cwd?: string })
}

/** Result shape of the synchronous spawn family. */
export interface SpawnSyncResult {
  pid: number
  status: number | null
  signal: string | null
  stdout: Buffer | string
  stderr: Buffer | string
  output: (Buffer | string | null)[]
  error?: Error
}

/**
 * `child_process.spawnSync`. Genuine synchronous execution is impossible in the
 * browser, so this reports a failure result rather than pretending — every
 * caller in dsh (`taskkill` on Windows, `execFileSync` in the process
 * inspector) treats a failed sync spawn as "unavailable", which is the honest
 * answer here.
 */
export function spawnSync(command: string, args: string[] = []): SpawnSyncResult {
  const error = new Error(`spawnSync ${command} is unavailable in the browser host`) as Error & { code: string }
  error.code = 'ENOSYS'
  void args
  return { pid: -1, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, null, null], error }
}

/** `child_process.execFileSync` — same constraint as {@link spawnSync}. */
export function execFileSync(command: string): never {
  const error = new Error(`execFileSync ${command} is unavailable in the browser host`) as Error & { code: string }
  error.code = 'ENOSYS'
  throw error
}

/** `child_process.execSync` — same constraint as {@link spawnSync}. */
export const execSync = execFileSync

/** `child_process.exec`. */
export function exec(
  command: string,
  optionsOrCallback?: Record<string, unknown> | ((error: Error | null, stdout: string, stderr: string) => void),
  maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void,
): ChildProcessShim {
  const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback ?? {}
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  const child = new ChildProcessShim('bash', ['-c', command], options as { cwd?: string })
  if (callback !== undefined) {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
    child.on('close', (code: unknown) => {
      const status = Number(code)
      callback(status === 0 ? null : Object.assign(new Error(`Command failed: ${command}`), { code: status }), stdout, stderr)
    })
  }
  return child
}

/** `child_process.execFile`. */
export function execFile(
  command: string,
  argsOrCallback?: string[] | ((error: Error | null, stdout: string, stderr: string) => void),
  optionsOrCallback?: Record<string, unknown> | ((error: Error | null, stdout: string, stderr: string) => void),
  maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void,
): ChildProcessShim {
  const args = Array.isArray(argsOrCallback) ? argsOrCallback : []
  const callback = [argsOrCallback, optionsOrCallback, maybeCallback].find(value => typeof value === 'function') as
    ((error: Error | null, stdout: string, stderr: string) => void) | undefined
  const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {}
  const child = new ChildProcessShim(command, args, options as { cwd?: string })
  if (callback !== undefined) {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
    child.on('close', (code: unknown) => {
      const status = Number(code)
      callback(status === 0 ? null : Object.assign(new Error(`Command failed: ${command}`), { code: status }), stdout, stderr)
    })
  }
  return child
}

/** `child_process.fork` has no browser analogue. */
export function fork(): never {
  throw Object.assign(new Error('child_process.fork is unavailable in the browser host'), { code: 'ENOSYS' })
}

/** Resolve an executable name the way the shell's PATH lookup does. */
export function whichExecutable(command: string): string | undefined {
  if (command.includes('/')) return volume.exists(command) ? command : undefined
  const known = new Set(['bash', 'sh', 'env', 'node', 'git'])
  if (known.has(command)) return `/usr/bin/${command}`
  for (const directory of (processShim.env.PATH ?? '').split(':')) {
    const candidate = `${directory}/${command}`
    const node = volume.lookup(candidate)
    if (node?.kind === 'file' && (node.mode & 0o111) !== 0) return candidate
  }
  return undefined
}

export const ChildProcess = ChildProcessShim

export default { spawn, spawnSync, exec, execFile, execSync, execFileSync, fork, ChildProcess }
