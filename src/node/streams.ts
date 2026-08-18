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

/**
 * `stream.Readable`, as a subclass author expects it.
 *
 * The stdio shim above is a push-only pipe: whoever owns the process pushes
 * bytes in and a consumer reads them out. That is not what a library
 * subclassing `Readable` gets on Node — it implements `_read()`, pushes objects
 * rather than bytes, and signals the end with `push(null)`. Handing such a
 * library the pipe silently breaks it in the worst way: `push(null)` looked
 * like an empty chunk and was dropped, `_read()` was never called, and the
 * stream simply never produced or ended.
 *
 * That is not hypothetical. `readdirp` is exactly such a subclass, `chokidar`
 * walks a directory through it, and `skill-filesystem` awaits chokidar's
 * `ready` before a session may start — so the `cordis` preset, the one preset
 * whose skills directory exists, started a turn and then waited forever, with
 * no error anywhere.
 */
class NodeReadable extends StreamEmitter {
  readable = true
  readableEnded = false
  destroyed = false
  readonly #objectMode: boolean
  #encoding: string | undefined
  readonly #queue: unknown[] = []
  #ended = false
  #flowing = false
  #reading = false
  readonly #waiters: (() => void)[] = []

  constructor(options: { objectMode?: boolean, encoding?: string, read?: (this: NodeReadable, size: number) => void } = {}) {
    super()
    this.#objectMode = options.objectMode === true
    this.#encoding = options.encoding
    if (typeof options.read === 'function') this._read = options.read
  }

  /**
   * Produce more data. Subclasses override this; the base does nothing, which
   * is correct for a stream fed entirely by `push` from outside.
   * @param _size - the consumer's advisory byte count.
   */
  _read(_size: number): void {}

  /**
   * Offer a value to consumers, or end the stream with `null`.
   * @param chunk - the value, or `null`/`undefined` for end-of-stream.
   * @returns whether more data is wanted right now.
   */
  push(chunk: unknown): boolean {
    this.#reading = false
    if (chunk === null || chunk === undefined) {
      this.#ended = true
      this.#drain()
      return false
    }
    this.#queue.push(this.#objectMode ? chunk : toBytes(chunk as Uint8Array | string))
    this.#drain()
    return !this.#ended
  }

  /** Hand one queued value to a consumer, decoded when an encoding is set. */
  #take(): unknown {
    const value = this.#queue.shift()
    if (this.#objectMode || value === undefined) return value
    const bytes = value as Uint8Array
    return this.#encoding === undefined ? Buffer.from(bytes) : Buffer.from(bytes).toString(this.#encoding as BufferEncoding)
  }

  /** Emit what is queued, end when the producer said so, and wake any waiters. */
  #drain(): void {
    if (this.listenerCount('data') > 0) this.#flowing = true
    if (this.#flowing) {
      while (this.#queue.length > 0) this.emit('data', this.#take())
      if (this.#ended && !this.readableEnded) {
        this.readableEnded = true
        this.readable = false
        this.emit('end')
        this.emit('close')
      }
    }
    while (this.#waiters.length > 0) this.#waiters.shift()!()
    // A flowing consumer with nothing left is the moment Node asks for more.
    if (this.#flowing && !this.#ended && this.#queue.length === 0) this.#pull()
  }

  /** Ask the subclass for more, once at a time, as Node's contract requires. */
  #pull(): void {
    if (this.#reading || this.#ended || this.destroyed) return
    this.#reading = true
    try {
      this._read(this.#objectMode ? 16 : 65536)
    } catch (error) {
      this.#reading = false
      this.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener)
    if (event === 'data') queueMicrotask(() => { this.#drain() })
    if (event === 'end' && this.readableEnded) queueMicrotask(() => { this.emit('end') })
    return this
  }

  setEncoding(encoding: string): this {
    this.#encoding = encoding
    return this
  }

  resume(): this {
    this.#flowing = true
    this.#drain()
    return this
  }

  pause(): this {
    this.#flowing = false
    return this
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.#ended = true
    this.readable = false
    if (error !== undefined) this.emit('error', error)
    this.emit('close')
    while (this.#waiters.length > 0) this.#waiters.shift()!()
    return this
  }

  /** `stream.pipe(writable)`. */
  pipe<T extends { write(chunk: unknown): unknown, end?: () => void }>(destination: T): T {
    this.on('data', (chunk: unknown) => { destination.write(chunk) })
    this.on('end', () => { destination.end?.() })
    return destination
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#take()
      if (this.#ended || this.destroyed) return
      // Each pull is one `_read()`; the producer wakes this loop by pushing.
      this.#pull()
      if (this.#queue.length > 0 || this.#ended || this.destroyed) continue
      await new Promise<void>(resolve => { this.#waiters.push(resolve) })
    }
  }

  /**
   * `Readable.from`, for the callers that build a stream out of an iterable.
   * @param source - the values to emit.
   * @returns a stream over them.
   */
  static from(source: Iterable<unknown> | AsyncIterable<unknown>): NodeReadable {
    const stream = new NodeReadable({ objectMode: true })
    void (async () => {
      try {
        for await (const value of source as AsyncIterable<unknown>) stream.push(value)
        stream.push(null)
      } catch (error) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })()
    return stream
  }
}

/** The `node:stream` module face. */
export const streamModule = {
  Readable: NodeReadable,
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
