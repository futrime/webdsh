/**
 * `node-pty` over the machine's pseudoterminals.
 *
 * `dsh-subprocess-local` imports this to open a terminal, and what it gets is a
 * real one: `container/dsh-mux` calls `pty.fork()` inside the container, so the
 * line discipline, the window size, job control, and ^C are the container's own
 * — not something reconstructed in JavaScript. Raw-mode keys and full-screen
 * programs work for the same reason.
 *
 * The interface is node-pty's, which is synchronous, and starting a channel is
 * not. So writes made before the session is open are held and replayed in
 * order, which is what a caller that writes immediately after `spawn` expects.
 */

import { startShell, type ShellSession } from '../runtime/container.ts'
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

/** A pseudoterminal in the container, presented through the node-pty interface. */
class MachinePty implements IPty {
  readonly pid = nextPid++
  cols: number
  rows: number
  readonly process: string
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number, signal?: number }) => void>()
  private session: ShellSession | undefined
  /** Keystrokes written before the session existed, in the order they arrived. */
  private readonly pending: string[] = []
  private closed = false

  constructor(file: string, args: string[], options: IPtyForkOptions) {
    this.process = file
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    void this.start(file, args, options)
  }

  /** Open the channel and wire it to the listeners. */
  private async start(file: string, args: string[], options: IPtyForkOptions): Promise<void> {
    try {
      const session = await startShell({
        cols: this.cols,
        rows: this.rows,
        ...(options.cwd === undefined ? { cwd: processShim.cwd() } : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        shell: file,
        // node-pty's contract is that `args` is the argv tail, so `$0` is the
        // program itself — the same convention `execv` takes.
        argv: [file, ...args],
      })
      if (this.closed) {
        session.kill('SIGKILL')
        return
      }
      this.session = session
      for (const held of this.pending.splice(0)) session.write(held)

      const decoder = new TextDecoder()
      const reader = session.output.getReader()
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.emitData(decoder.decode(value, { stream: true }))
        }
      })()
      this.exit(await session.exit)
    } catch (error) {
      this.emitData(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`)
      this.exit(1)
    }
  }

  private emitData(data: string): void {
    if (data === '') return
    for (const listener of [...this.dataListeners]) {
      try {
        listener(data)
      } catch (error) {
        console.error('[node-pty] data listener threw:', error)
      }
    }
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
    if (this.session === undefined) this.pending.push(data)
    else this.session.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.session?.resize({ cols, rows })
  }

  kill(signal = 'SIGTERM'): void {
    this.session?.kill(signal)
    // Reported here rather than waiting for the exit frame: a caller that kills
    // a terminal it is tearing down should not be left waiting on a machine
    // that may already be gone.
    this.exit(signal === 'SIGKILL' ? 137 : 143)
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
 * @param file - the program to run.
 * @param args - its argv tail.
 * @param options - size, cwd, and environment.
 * @returns the session handle.
 */
export function spawn(file: string, args: string[] = [], options: IPtyForkOptions = {}): IPty {
  return new MachinePty(file, args, options)
}

export const open = spawn
export default { spawn, open }
