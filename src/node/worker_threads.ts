/**
 * `node:worker_threads` over the browser's `Worker`.
 *
 * dsh uses worker threads for two things: the Code Mode runtime
 * (`dsh-code-runtime-worker-thread`) and durable workflows
 * (`dsh-workflow-worker-thread`). Both spawn a worker from a `file://` URL
 * pointing at a package's built entry, which no browser `Worker` can load.
 *
 * So this shim keeps the *API* and swaps the *transport*: a "worker" is a
 * same-realm sandbox driven through a real `MessageChannel`, so
 * `postMessage`/`on('message')` semantics — including structured clone and
 * message ordering — match Node, while the worker body runs through the host
 * module registry instead of a separate thread. The observable difference is
 * that a runaway worker script blocks the page; the browser composition caps
 * that with the existing tool timeout policy.
 */

import { pathToFileURL } from './misc.ts'
import { Buffer } from './binary.ts'

/** Resolver installed by the host module system, used to run a worker entry. */
let workerEntryLoader: ((url: string) => Promise<unknown>) | undefined

/**
 * Teach the shim how to load a worker entry module.
 * @param loader - resolves a `file://` worker URL to its module namespace.
 */
export function setWorkerEntryLoader(loader: (url: string) => Promise<unknown>): void {
  workerEntryLoader = loader
}

/** Minimal event emitter shared by `Worker` and `MessagePort` faces. */
class Emitter {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event)
    if (set === undefined || set.size === 0) return false
    for (const listener of [...set]) {
      try {
        listener(...args)
      } catch (error) {
        console.error(`[worker_threads] ${event} listener threw:`, error)
      }
    }
    return true
  }
}

/** `worker_threads.MessagePort` over the DOM `MessagePort`. */
export class NodeMessagePort extends Emitter {
  constructor(private readonly port: MessagePort) {
    super()
    port.onmessage = (event: MessageEvent) => { this.emit('message', event.data) }
    port.onmessageerror = (event: MessageEvent) => { this.emit('messageerror', event.data) }
  }

  postMessage(value: unknown, transfer?: Transferable[]): void {
    this.port.postMessage(value, transfer ?? [])
  }

  start(): void { this.port.start() }
  close(): void {
    this.port.close()
    this.emit('close')
  }

  ref(): this { return this }
  unref(): this { return this }
}

/** `worker_threads.MessageChannel`. */
export class MessageChannelShim {
  readonly port1: NodeMessagePort
  readonly port2: NodeMessagePort
  constructor() {
    const channel = new MessageChannel()
    this.port1 = new NodeMessagePort(channel.port1)
    this.port2 = new NodeMessagePort(channel.port2)
    channel.port1.start()
    channel.port2.start()
  }
}

/** Per-worker globals the entry module reads through `worker_threads`. */
interface WorkerScope {
  parentPort: NodeMessagePort
  workerData: unknown
  threadId: number
}

/**
 * Route what the worker body writes into its parent's pipes.
 *
 * `console` is the realm's, so this swaps it for the duration and puts it back
 * afterwards — a worker that outlived the swap would otherwise silence the
 * page's own logging.
 * @param stdout - the pipe ordinary output goes to.
 * @param stderr - the pipe errors go to.
 * @returns a function restoring the realm.
 */
function captureOutput(stdout: WorkerOutput, stderr: WorkerOutput): () => void {
  const realConsole = globalThis.console
  const render = (args: unknown[]): string =>
    `${args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}\n`
  const patched = Object.create(realConsole) as Console
  patched.log = (...args: unknown[]) => { stdout.push(render(args)) }
  patched.info = patched.log
  patched.debug = patched.log
  patched.warn = (...args: unknown[]) => { stderr.push(render(args)) }
  patched.error = patched.warn
  globalThis.console = patched
  return () => { globalThis.console = realConsole }
}

/** The scope stack, so a worker entry importing this module sees its own scope. */
const scopes: WorkerScope[] = []
let nextThreadId = 1

/**
 * A worker's captured output stream.
 *
 * Node gives a `Worker` piped `stdout`/`stderr`, and a caller reads them the way
 * it reads any stream: `on('data')` while it runs, `end`/`close` when it is
 * over. The Code Mode runtime does exactly that — and does it before anything
 * else, so a Worker without these does not degrade, it throws on the first call.
 */
class WorkerOutput extends Emitter {
  readableEnded = false
  destroyed = false

  /** Deliver a chunk the worker wrote. */
  push(text: string): void {
    if (this.readableEnded) return
    this.emit('data', Buffer.from(text))
  }

  /** No more output is coming. */
  end(): void {
    if (this.readableEnded) return
    this.readableEnded = true
    this.emit('end')
    this.emit('close')
  }

  setEncoding(): this { return this }
  resume(): this { return this }
  pause(): this { return this }
  destroy(): this { this.destroyed = true; this.end(); return this }
}

/** `worker_threads.Worker`, backed by a same-realm sandbox. */
export class Worker extends Emitter {
  readonly threadId = nextThreadId++
  /** The worker's piped output, as Node's `Worker` exposes it. */
  readonly stdout = new WorkerOutput()
  readonly stderr = new WorkerOutput()
  /**
   * `worker.performance`. There is no separate event loop to measure, so the
   * utilisation reported is the wall time the worker has been alive — which is
   * what the one caller uses it for: a compute budget it stops the worker on.
   */
  readonly performance = {
    eventLoopUtilization: (): { idle: number, active: number, utilization: number } => {
      const active = globalThis.performance.now() - this.startedAt
      return { idle: 0, active, utilization: 1 }
    },
  }

  private readonly startedAt = globalThis.performance.now()
  private readonly channel = new MessageChannel()
  private readonly hostPort: NodeMessagePort
  private terminated = false

  constructor(entry: string | URL, options: { workerData?: unknown, argv?: string[], env?: Record<string, string> } = {}) {
    super()
    this.hostPort = new NodeMessagePort(this.channel.port1)
    this.channel.port1.start()
    this.channel.port2.start()
    this.hostPort.on('message', (value: unknown) => { this.emit('message', value) })

    const url = typeof entry === 'string'
      ? (entry.startsWith('file:') || entry.startsWith('http') ? entry : pathToFileURL(entry).href)
      : entry.href

    void this.run(url, options.workerData)
  }

  /** Load and execute the worker entry with its own `parentPort`/`workerData`. */
  private async run(url: string, workerData: unknown): Promise<void> {
    if (workerEntryLoader === undefined) {
      queueMicrotask(() => { this.emit('error', new Error('worker_threads: no worker entry loader installed')) })
      return
    }
    const scope: WorkerScope = {
      parentPort: new NodeMessagePort(this.channel.port2),
      workerData,
      threadId: this.threadId,
    }
    pushScope(scope)
    // The worker runs in this realm, so anything it writes to stdout would land
    // in the page's console rather than in the pipes its parent is reading. The
    // redirection lasts only as long as the entry body.
    const restore = captureOutput(this.stdout, this.stderr)
    try {
      await workerEntryLoader(url)
    } catch (error) {
      this.emit('error', error)
      this.emit('exit', 1)
      return
    } finally {
      restore()
      popScope()
    }
    if (this.terminated) this.emit('exit', 0)
  }

  postMessage(value: unknown, transfer?: Transferable[]): void {
    this.hostPort.postMessage(value, transfer)
  }

  async terminate(): Promise<number> {
    if (this.terminated) return 0
    this.terminated = true
    this.channel.port1.close()
    this.channel.port2.close()
    // A caller waiting for the pipes to drain waits forever unless they end.
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', 0)
    return 0
  }

  ref(): this { return this }
  unref(): this { return this }
}

/** The scope a worker entry is currently executing under, if any. */
export function currentScope(): WorkerScope | undefined {
  return scopes[scopes.length - 1]
}

/*
 * A worker entry reads `parentPort` to decide whether it is a worker at all, and
 * it reaches this module by whichever face its own module format asks for: the
 * CommonJS entries below get {@link workerThreadsModule}, whose getters are
 * live, while anything the bundler rewrote to an import gets these bindings.
 *
 * `export let` is what makes the two agree. An ES module's exported bindings are
 * live views, not copies, so re-assigning them here is visible to every importer
 * — which `export const parentPort = null` was not, and a worker entry that read
 * that face concluded it was running on the main thread and refused to start.
 */

/** `worker_threads.isMainThread`: false only while a worker entry is executing. */
export let isMainThread = true
/** `worker_threads.parentPort`: the executing worker's channel to its parent. */
export let parentPort: NodeMessagePort | null = null
/** `worker_threads.workerData`: what the parent passed to this worker. */
export let workerData: unknown = undefined
/** `worker_threads.threadId`: 0 on the main thread, the worker's id inside one. */
export let threadId = 0

/** Point the live bindings at the innermost executing worker, or at the page. */
function publishScope(): void {
  const scope = currentScope()
  isMainThread = scope === undefined
  parentPort = scope?.parentPort ?? null
  workerData = scope?.workerData
  threadId = scope?.threadId ?? 0
}

/** Enter a worker's scope for the duration of its entry body. */
function pushScope(scope: WorkerScope): void {
  scopes.push(scope)
  publishScope()
}

/** Leave the innermost worker scope. */
function popScope(): void {
  scopes.pop()
  publishScope()
}

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV')

/**
 * The module namespace. `parentPort`, `workerData`, `threadId`, and
 * `isMainThread` are getters so an executing worker entry reads its own scope.
 */
export const workerThreadsModule = {
  Worker,
  MessageChannel: MessageChannelShim,
  MessagePort: NodeMessagePort,
  BroadcastChannel: typeof BroadcastChannel === 'undefined' ? class {} : BroadcastChannel,
  SHARE_ENV,
  get isMainThread(): boolean { return isMainThread },
  get parentPort(): NodeMessagePort | null { return parentPort },
  get workerData(): unknown { return workerData },
  get threadId(): number { return threadId },
  markAsUntransferable: (): void => {},
  moveMessagePortToContext: (port: NodeMessagePort): NodeMessagePort => port,
  receiveMessageOnPort: (): undefined => undefined,
  setEnvironmentData: (): void => {},
  getEnvironmentData: (): undefined => undefined,
  default: undefined as unknown,
}
workerThreadsModule.default = workerThreadsModule
