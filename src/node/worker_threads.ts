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

/** The scope stack, so a worker entry importing this module sees its own scope. */
const scopes: WorkerScope[] = []
let nextThreadId = 1

/** `worker_threads.Worker`, backed by a same-realm sandbox. */
export class Worker extends Emitter {
  readonly threadId = nextThreadId++
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
    scopes.push(scope)
    try {
      await workerEntryLoader(url)
    } catch (error) {
      this.emit('error', error)
      this.emit('exit', 1)
      return
    } finally {
      scopes.pop()
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
    this.emit('exit', 0)
    return 0
  }

  ref(): this { return this }
  unref(): this { return this }
}

/** `worker_threads.isMainThread`: true unless a worker entry is executing. */
export const isMainThread = scopes.length === 0

/** Live accessor form, because `isMainThread` is read at module scope by callers. */
export function currentScope(): WorkerScope | undefined {
  return scopes[scopes.length - 1]
}

export const parentPort: NodeMessagePort | null = null
export const workerData: unknown = undefined
export const threadId = 0
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
  get isMainThread(): boolean { return currentScope() === undefined },
  get parentPort(): NodeMessagePort | null { return currentScope()?.parentPort ?? null },
  get workerData(): unknown { return currentScope()?.workerData },
  get threadId(): number { return currentScope()?.threadId ?? 0 },
  markAsUntransferable: (): void => {},
  moveMessagePortToContext: (port: NodeMessagePort): NodeMessagePort => port,
  receiveMessageOnPort: (): undefined => undefined,
  setEnvironmentData: (): void => {},
  getEnvironmentData: (): undefined => undefined,
  default: undefined as unknown,
}
workerThreadsModule.default = workerThreadsModule
