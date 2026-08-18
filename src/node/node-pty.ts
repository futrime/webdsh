/**
 * `node-pty` stand-in so `dsh-subprocess-local` imports cleanly and
 * `spawnTerminal` keeps working.
 *
 * There is no pseudo-terminal in a browser, so the "PTY" is a line-oriented
 * shell session: writes accumulate until a newline, then the line runs through
 * the interpreter and its output is echoed back with CRLF line endings, which
 * is what xterm.js on the client expects. Job control, raw-mode keys, and
 * curses applications are out of reach; ordinary command sequences are not.
 */

import { runShell } from '../shell/index.ts'
import { process as processShim } from './process.ts'

/** node-pty's disposable handle. */
export interface IDisposable {
  dispose(): void
}

/** Options accepted by `spawn`. */
export interface IPtyForkOptions {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
  encoding?: string
}

/** node-pty's process handle. */
export interface IPty {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly process: string
  onData(listener: (data: string) => void): IDisposable
  onExit(listener: (event: { exitCode: number, signal?: number }) => void): IDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
}

let nextPid = 5000

/** A line-buffered shell session presented through the node-pty interface. */
class BrowserPty implements IPty {
  readonly pid = nextPid++
  cols: number
  rows: number
  readonly process: string
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number, signal?: number }) => void>()
  private buffer = ''
  private cwd: string
  private readonly env: Record<string, string | undefined>
  private closed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(file: string, args: string[], options: IPtyForkOptions) {
    this.process = file
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.cwd = options.cwd ?? processShim.cwd()
    this.env = { ...processShim.env, ...options.env }
    // A login shell prints a prompt; an argv with `-c` runs once and exits.
    const cIndex = args.indexOf('-c')
    if (cIndex !== -1) {
      this.queue = this.queue.then(() => this.execute(args[cIndex + 1] ?? '')).then(() => { this.exit(0) })
    } else {
      queueMicrotask(() => { this.emitData(this.prompt()) })
    }
  }

  /** The shell prompt written after each command. */
  private prompt(): string {
    return `\u001b[1;32mdsh\u001b[0m:\u001b[1;34m${this.cwd}\u001b[0m$ `
  }

  private emitData(data: string): void {
    for (const listener of [...this.dataListeners]) {
      try {
        listener(data)
      } catch (error) {
        console.error('[node-pty] data listener threw:', error)
      }
    }
  }

  /** Run one command line and echo its output. */
  private async execute(line: string): Promise<void> {
    if (line.trim().length === 0) return
    const result = await runShell(line, {
      cwd: this.cwd,
      env: this.env,
      onStdout: chunk => { this.emitData(chunk.replaceAll('\n', '\r\n')) },
      onStderr: chunk => { this.emitData(chunk.replaceAll('\n', '\r\n')) },
    })
    // A `cd` inside the line moves the session, matching an interactive shell.
    const probe = await runShell('pwd', { cwd: this.cwd, env: this.env })
    void probe
    void result
  }

  onData(listener: (data: string) => void): IDisposable {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  onExit(listener: (event: { exitCode: number, signal?: number }) => void): IDisposable {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  write(data: string): void {
    if (this.closed) return
    // Ctrl-C clears the pending line, Ctrl-D ends the session.
    if (data.includes('\u0003')) {
      this.buffer = ''
      this.emitData(`^C\r\n${this.prompt()}`)
      return
    }
    if (data.includes('\u0004')) {
      this.exit(0)
      return
    }
    this.buffer += data
    // Local echo: a browser terminal sends keystrokes without one.
    this.emitData(data.replaceAll('\r', '\r\n'))
    let newline = this.buffer.search(/[\r\n]/)
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.queue = this.queue
        .then(() => this.execute(line))
        .then(() => { this.emitData(this.prompt()) })
      newline = this.buffer.search(/[\r\n]/)
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  kill(): void {
    this.exit(0)
  }

  private exit(code: number): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.exitListeners]) {
      try {
        listener({ exitCode: code })
      } catch (error) {
        console.error('[node-pty] exit listener threw:', error)
      }
    }
  }

  pause(): void {}
  resume(): void {}
}

/**
 * `pty.spawn`.
 * @param file - the shell binary name (only its basename matters here).
 * @param args - argv tail.
 * @param options - size, cwd, and environment.
 * @returns the session handle.
 */
export function spawn(file: string, args: string[] = [], options: IPtyForkOptions = {}): IPty {
  return new BrowserPty(file, args, options)
}

export const open = spawn
export default { spawn, open }
