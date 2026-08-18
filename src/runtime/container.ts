/**
 * The machine the terminal and the agent both run on.
 *
 * It is a Debian container — the one `container/Dockerfile` describes —
 * executing on an emulated x86-64 inside WebAssembly, converted by
 * [container2wasm](https://github.com/container2wasm/container2wasm). The shell
 * is bash, `git` is git, `python3` is CPython, and `node` is the Node LTS
 * release, because they are those programs and not reimplementations of them.
 *
 * The trade against running Node directly in the tab is deliberate and it is
 * not free: an emulated CPU is slower than a native one, and the image is a
 * download measured in hundreds of megabytes. What it buys is that the harness
 * stops being a special case. There is no list of commands that happen to be
 * implemented, no shell that is nearly POSIX, and no language that is missing —
 * a tool call runs what it would run on a laptop.
 *
 * Three things shape the code below:
 *
 * - The emulator's `_start` never returns, so it owns a worker of its own and
 *   the console between them is `SharedArrayBuffer` (see `ring.ts`). That needs
 *   cross-origin isolation, which `public/sw.js` arranges.
 * - One console carries everything, so `container/dsh-mux` multiplexes it into
 *   channels (see `mux.ts`): the terminal gets a real pty, each command gets
 *   its own streams and exit status, and neither sees the other's bytes.
 * - Exactly one machine per page. `bootRuntime` may be called from anywhere and
 *   everything shares the one promise.
 */

import { Mux, type Channel } from './mux.ts'
import { Ring } from './ring.ts'
import { FileService } from './files.ts'
import { persistWorkspace, restoreWorkspace, type RuntimePersistence } from './persist.ts'

/** Where a session starts: the home the page reports through `os.homedir()`. */
export const WORKDIR = '/home/dsh'

/** The user's files, and nothing else. */
export const WORKSPACE = `${WORKDIR}/workspace`

/** Where the machine image's manifest is published, relative to the page. */
const IMAGE_MANIFEST = 'container/machine.json'

/** How much console traffic may be in flight in each direction. */
const CONSOLE_BYTES = 1 << 20

/**
 * How long the machine gets to say hello.
 *
 * The budget covers fetching a few hundred megabytes and starting an emulated
 * Linux, so it is minutes rather than seconds. It is not a performance target:
 * it is the point at which waiting longer stops being useful, because whatever
 * is wrong is not going to fix itself.
 */
const BOOT_TIMEOUT_MS = 300_000

/** Whether this page can host the machine at all. */
export function runtimeSupported(): { ok: boolean, reason?: string } {
  if (typeof SharedArrayBuffer === 'undefined') {
    return { ok: false, reason: 'SharedArrayBuffer is unavailable — the page is not cross-origin isolated' }
  }
  if (!globalThis.crossOriginIsolated) return { ok: false, reason: 'the page is not cross-origin isolated' }
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'WebAssembly is unavailable' }
  if (typeof Worker === 'undefined') return { ok: false, reason: 'workers are unavailable' }
  return { ok: true }
}

/** A booted machine, and the ways in. */
export interface Machine {
  mux: Mux
  /**
   * The file service, started on first use.
   *
   * Not part of the boot: the agent's file tools need it and a terminal never
   * does, so making everyone wait for a second process to start inside an
   * emulator would be paying for it whether or not it is used.
   */
  files(): Promise<FileService>
  /** Resolves when the emulator halts, which in normal use it never does. */
  halted: Promise<number>
}

let machine: Promise<Machine> | undefined
let durability: RuntimePersistence | undefined

/**
 * Why the machine is not usable, once an attempt to start it has failed.
 *
 * Recorded rather than only thrown: everything that routes a command asks
 * before routing it, and a page that has already learned the answer should not
 * make the user wait for it again.
 */
let bootFailure: string | undefined

/** Why the machine is unusable, if it is. */
export function runtimeFailure(): string | undefined {
  return bootFailure
}

/** Whether the machine is usable right now. */
export function runtimeAvailable(): boolean {
  return bootFailure === undefined && runtimeSupported().ok
}

/** The workspace's durability handle, once the machine has started. */
export function runtimePersistence(): RuntimePersistence | undefined {
  return durability
}

/**
 * Whether the machine is usable, waiting for a boot already in flight.
 * @returns whether commands can run.
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

/** Fail a promise that never settles, so a caller is never left waiting forever. */
async function withDeadline<T>(attempt: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(message)) }, BOOT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Move bytes between the page and the machine, forever.
 *
 * The emulator's thread cannot be messaged and the page's thread cannot be
 * blocked, so this is the one place the two meet: it waits on the output ring
 * without spinning, hands whatever arrives to the multiplexer, and pushes as
 * much of the outgoing queue as the input ring has room for.
 * @param stdin - the ring the machine reads.
 * @param stdout - the ring the machine writes.
 * @param mux - where the machine's bytes go.
 * @param outbox - what is waiting to be sent.
 * @param stopped - whether to give up.
 */
async function pump(
  stdin: Ring,
  stdout: Ring,
  mux: Mux,
  outbox: { queue: Uint8Array[] },
  stopped: () => boolean,
  trace?: (direction: string, bytes: Uint8Array) => void,
): Promise<void> {
  while (!stopped()) {
    const chunk = stdout.read()
    if (chunk.byteLength > 0) {
      trace?.('machine→page', chunk)
      mux.feed(chunk)
    }

    while (outbox.queue.length > 0) {
      const head = outbox.queue[0]
      const taken = stdin.write(head)
      if (taken < head.byteLength) {
        outbox.queue[0] = head.subarray(taken)
        break
      }
      outbox.queue.shift()
    }

    // Only sleep when there was nothing to do; a busy machine keeps the loop
    // turning at whatever rate it produces output.
    if (chunk.byteLength === 0) await stdout.whenData(outbox.queue.length > 0 ? 4 : 25)
  }
}

/**
 * Boot the machine, once.
 * @param onProgress - called with human-readable boot steps.
 * @returns the running machine.
 */
export async function bootRuntime(onProgress?: (step: string) => void): Promise<Machine> {
  machine ??= withDeadline((async (): Promise<Machine> => {
    const support = runtimeSupported()
    if (!support.ok) throw new Error(`the machine cannot start: ${support.reason ?? 'unsupported'}`)

    onProgress?.('Fetching the machine image')
    const stdin = new Ring(Ring.allocate(CONSOLE_BYTES))
    const stdout = new Ring(Ring.allocate(CONSOLE_BYTES))
    const worker = new Worker(new URL('./container-worker.ts', import.meta.url), { type: 'module' })

    const outbox = { queue: [] as Uint8Array[] }
    // A seam for looking at what actually crossed the console. This is a byte
    // protocol over a tty that neither end fully controls, and "what arrived"
    // is the only useful question when a frame goes wrong; nothing is published
    // unless someone sets this, and it costs an undefined check per chunk.
    const trace = (globalThis as { __DSH_TRACE_CONSOLE__?: (direction: string, bytes: Uint8Array) => void })
      .__DSH_TRACE_CONSOLE__
    const mux = new Mux((bytes) => {
      trace?.('page→machine', bytes)
      outbox.queue.push(bytes)
    })
    let halt: (code: number) => void = () => {}
    const halted = new Promise<number>((resolve) => { halt = resolve })
    let finished = false

    worker.addEventListener('message', (event: MessageEvent<{ type: string, code?: number, message?: string }>) => {
      const report = event.data
      if (report.type === 'started') {
        onProgress?.('Starting Linux')
        return
      }
      finished = true
      // Terminated either way. The emulator holds the whole disk image in its
      // linear memory, and a worker that has stopped emulating is several
      // hundred megabytes of a browser's memory doing nothing.
      worker.terminate()
      if (report.type === 'exit') {
        mux.fail(new Error('the machine halted'))
        halt(report.code ?? 0)
      } else {
        mux.fail(new Error(report.message ?? 'the machine failed to start'))
        halt(1)
      }
    })

    worker.postMessage({
      manifest: new URL(IMAGE_MANIFEST, document.baseURI).href,
      stdin: stdin.shared,
      stdout: stdout.shared,
      // No run-time flags: the image's own command is `dsh-mux`, which is what
      // should run. Anything else here would replace it.
      args: [],
      env: [],
    })

    void pump(stdin, stdout, mux, outbox, () => finished, trace)

    onProgress?.('Waiting for the container')
    await mux.ready

    onProgress?.('Preparing the workspace')
    const restored = await restoreWorkspace(mux)
    if (restored) onProgress?.('Restored your workspace')
    let files: Promise<FileService> | undefined
    const booted: Machine = { mux, files: () => (files ??= FileService.open(mux)), halted }
    durability = persistWorkspace(booted)
    return booted
  })(), `the machine did not start within ${String(BOOT_TIMEOUT_MS / 1000)} seconds`)
    .catch((error: unknown) => {
      bootFailure = error instanceof Error ? error.message : String(error)
      console.warn('[runtime] the machine could not start:', error)
      throw error
    })
  return machine
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
 * Run a shell command on the machine.
 *
 * The script travels as a payload rather than as an argument, and the machine
 * writes it to a file before bash reads it — so a backslash, a newline, or a
 * quote in the agent's script is the byte the agent wrote. stdout and stderr
 * stay apart, because the channel keeps them apart.
 * @param script - shell source to run.
 * @param options - working directory, environment, cancellation, streaming.
 * @returns what the command produced.
 */
export async function execute(script: string, options: RunOptions = {}): Promise<RunResult> {
  const { mux } = await bootRuntime()
  const decoder = new TextDecoder()
  let stdout = ''
  let stderr = ''

  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(options.env ?? {})) {
    // The page's own environment names things the machine has its own answer
    // for; only what a caller set deliberately is worth forwarding.
    if (value !== undefined && name !== 'PATH' && name !== 'HOME' && name !== 'PWD') env[name] = value
  }

  return new Promise<RunResult>((resolve) => {
    let channel: Channel | undefined
    const onAbort = (): void => { channel?.kill('SIGKILL') }
    channel = mux.open({
      kind: 'exec',
      script,
      // POSIX: the token after the script is `$0`, and the parameters follow.
      args: [options.name ?? 'bash', ...(options.args ?? [])],
      cwd: options.cwd ?? WORKSPACE,
      env,
    }, {
      onData: (bytes) => {
        const text = decoder.decode(bytes, { stream: true })
        stdout += text
        options.onStdout?.(text)
      },
      onError: (bytes) => {
        const text = decoder.decode(bytes, { stream: true })
        stderr += text
        options.onStderr?.(text)
      },
      onExit: (status) => {
        options.signal?.removeEventListener('abort', onAbort)
        // A command is the coarsest thing that can change the workspace, and
        // the cheapest place to notice; the snapshot itself is debounced.
        durability?.touch()
        resolve({ status, stdout, stderr })
      },
    })
    if (options.stdin !== undefined && options.stdin !== '') channel.write(options.stdin)
    // Closed either way: a command that reads standard input to the end never
    // finishes if nothing ever ends it.
    channel.end()
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** An interactive session on the machine's terminal. */
export interface ShellSession {
  /** Everything the terminal prints. */
  output: ReadableStream<Uint8Array>
  /** Send keystrokes. */
  write(data: string): void
  /** Tell the terminal its new grid. */
  resize(size: { cols: number, rows: number }): void
  /** Deliver a signal to the whole session. */
  kill(signal?: string): void
  /** Settles with the shell's exit status. */
  exit: Promise<number>
}

/** What to start a terminal on. */
export interface ShellOptions {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string | undefined>
  /** The program to run; a login bash by default. */
  shell?: string
  /** Its whole argv, for a caller that wants something other than a login shell. */
  argv?: string[]
}

/**
 * Start an interactive shell attached to a terminal.
 *
 * A real pseudoterminal, which is why line editing, job control, ^C, and
 * full-screen programs work: the container's own tty driver is doing them.
 * @param size - the terminal's grid, and optionally what to run in it.
 * @returns the session, for wiring to the emulator.
 */
export async function startShell(size: ShellOptions): Promise<ShellSession> {
  const { mux } = await bootRuntime()
  let push: ((bytes: Uint8Array) => void) | undefined
  let close: (() => void) | undefined
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (bytes) => { controller.enqueue(bytes) }
      close = () => { controller.close() }
    },
  })
  let settle: (status: number) => void = () => {}
  const exit = new Promise<number>((resolve) => { settle = resolve })

  const channel = mux.open({
    kind: 'pty',
    cwd: size.cwd ?? WORKSPACE,
    cols: size.cols,
    rows: size.rows,
    ...(size.env === undefined ? {} : { env: size.env }),
    ...(size.shell === undefined ? {} : { shell: size.shell }),
    ...(size.argv === undefined ? {} : { argv: size.argv }),
  }, {
    onData: (bytes) => { push?.(bytes) },
    onExit: (status) => {
      durability?.touch()
      close?.()
      settle(status)
    },
  })

  return {
    output,
    write: (data) => { channel.write(data) },
    resize: ({ cols, rows }) => { channel.resize(cols, rows) },
    kill: (signal) => { channel.kill(signal) },
    exit,
  }
}

/** The machine's filesystem, for the agent's file tools. */
export async function runtimeFiles(): Promise<FileService> {
  return (await bootRuntime()).files()
}
