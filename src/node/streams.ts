/**
 * Node-shaped streams for the shims. `readable-stream` would work but pulls a
 * large dependency for the three behaviors dsh's subprocess and LSP paths
 * actually use: `on('data'|'end'|'close')`, `pipe()`, and async iteration.
 */

import { Buffer, toBytes } from './binary.ts'

/** Minimal typed event emitter shared by both stream faces. */
export class StreamEmitter {
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

  addListener(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
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

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event)
    if (set === undefined || set.size === 0) return false
    for (const listener of [...set]) {
      try {
        listener(...args)
      } catch (error) {
        console.error(`[stream] ${event} listener threw:`, error)
      }
    }
    return true
  }
}

/** A push-mode readable stream. */
export class ReadableStreamShim extends StreamEmitter {
  readonly readable = true
  private encoding: string | undefined
  private ended = false
  /** Chunks buffered before the first `data` listener attached. */
  private readonly backlog: Uint8Array[] = []
  private flowing = false
  private readonly waiters: (() => void)[] = []

  /** Push a chunk to consumers (or buffer it until one attaches). */
  push(chunk: Uint8Array | string): void {
    if (this.ended) return
    const bytes = toBytes(chunk)
    if (bytes.length === 0) return
    this.backlog.push(bytes)
    this.drain()
  }

  /** Signal end-of-stream. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.drain()
  }

  /** Deliver buffered chunks once a consumer is listening. */
  private drain(): void {
    if (this.listenerCount('data') > 0) this.flowing = true
    if (this.flowing) {
      while (this.backlog.length > 0) {
        const bytes = this.backlog.shift()!
        this.emit('data', this.encoding === undefined ? Buffer.from(bytes) : Buffer.from(bytes).toString(this.encoding as BufferEncoding))
      }
      if (this.ended) {
        this.emit('end')
        this.emit('close')
      }
    }
    while (this.waiters.length > 0) this.waiters.shift()!()
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener)
    if (event === 'data') queueMicrotask(() => { this.drain() })
    if (event === 'end' && this.ended && this.backlog.length === 0) queueMicrotask(() => { this.emit('end') })
    return this
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding
    return this
  }

  resume(): this {
    this.flowing = true
    this.drain()
    return this
  }

  pause(): this {
    this.flowing = false
    return this
  }

  destroy(): this {
    this.end()
    return this
  }

  /** `stream.pipe(writable)`. */
  pipe<T extends { write(chunk: unknown): unknown, end?: () => void }>(destination: T): T {
    this.on('data', (chunk: unknown) => { destination.write(chunk) })
    this.on('end', () => { destination.end?.() })
    return destination
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    for (;;) {
      while (this.backlog.length > 0) {
        const bytes = this.backlog.shift()!
        yield this.encoding === undefined ? Buffer.from(bytes) : Buffer.from(bytes).toString(this.encoding as BufferEncoding)
      }
      if (this.ended) return
      await new Promise<void>(resolve => { this.waiters.push(resolve) })
    }
  }
}

/** A writable stream that forwards writes to a callback. */
export class WritableStreamShim extends StreamEmitter {
  readonly writable = true
  private ended = false

  constructor(private readonly sink: (chunk: Uint8Array) => void, private readonly onEnd?: () => void) {
    super()
  }

  write(chunk: Uint8Array | string, encoding?: string | (() => void), callback?: () => void): boolean {
    if (!this.ended) this.sink(toBytes(chunk, typeof encoding === 'string' ? encoding : 'utf8'))
    const done = typeof encoding === 'function' ? encoding : callback
    if (done !== undefined) queueMicrotask(done)
    return true
  }

  end(chunk?: Uint8Array | string, callback?: () => void): this {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk)
    if (!this.ended) {
      this.ended = true
      this.onEnd?.()
      queueMicrotask(() => {
        this.emit('finish')
        this.emit('close')
        callback?.()
      })
    }
    return this
  }

  destroy(): this {
    return this.end()
  }

  cork(): void {}
  uncork(): void {}
  setDefaultEncoding(): this { return this }
}

/** The `node:stream` module face. */
export const streamModule = {
  Readable: ReadableStreamShim,
  Writable: WritableStreamShim,
  Duplex: ReadableStreamShim,
  Transform: ReadableStreamShim,
  PassThrough: class PassThrough extends ReadableStreamShim {
    write(chunk: Uint8Array | string): boolean {
      this.push(chunk)
      return true
    }
  },
  pipeline: (...args: unknown[]): void => {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') queueMicrotask(() => { (callback as (error: null) => void)(null) })
  },
  finished: (stream: StreamEmitter, callback: (error: null) => void): void => {
    stream.once('end', () => { callback(null) })
    stream.once('finish', () => { callback(null) })
  },
  promises: {
    pipeline: async (): Promise<void> => {},
    finished: async (): Promise<void> => {},
  },
  default: undefined as unknown,
}
streamModule.default = streamModule
