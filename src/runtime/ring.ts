/**
 * A byte queue two threads share.
 *
 * The emulator runs inside `WebAssembly.instantiate(...).exports._start()`,
 * which does not return until the machine halts. So the worker that hosts it
 * never reaches its own event loop again, and `postMessage` in that direction
 * would be a message nobody is listening for. Everything between the page and
 * the machine therefore goes through memory both threads can see, with
 * `Atomics` for the waking.
 *
 * Two of these make a console: one carrying keystrokes and frames down, one
 * carrying the machine's output back up. The reader may block — that is the
 * point, because a guest reading its console expects to wait — and the writer
 * never does.
 *
 * Positions are counted in `[0, 2 · capacity)` rather than monotonically. The
 * arithmetic is the same modulo the doubled range, and it cannot overflow the
 * `Int32Array` the atomics need, which a session moving hundreds of megabytes
 * of build output otherwise would.
 */

/** `Atomics.wait` is only allowed off the main thread. */
const CAN_BLOCK = typeof globalThis.WorkerGlobalScope !== 'undefined'

/** Where the two positions live, in `Int32Array` slots. */
const WRITTEN = 0
const READ = 1
const HEADER_BYTES = 8

/** One direction of the console. */
export class Ring {
  private readonly header: Int32Array
  private readonly data: Uint8Array
  private readonly capacity: number

  /**
   * Allocate the shared memory for a ring.
   * @param capacity - how many bytes may be in flight.
   * @returns the buffer to hand to both threads.
   */
  static allocate(capacity: number): SharedArrayBuffer {
    return new SharedArrayBuffer(HEADER_BYTES + capacity)
  }

  constructor(private readonly buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 2)
    this.data = new Uint8Array(buffer, HEADER_BYTES)
    this.capacity = this.data.byteLength
  }

  /** The shared memory, for handing to the other thread. */
  get shared(): SharedArrayBuffer {
    return this.buffer
  }

  /** How many bytes are waiting to be read. */
  get pending(): number {
    const written = Atomics.load(this.header, WRITTEN)
    const read = Atomics.load(this.header, READ)
    return (written - read + 2 * this.capacity) % (2 * this.capacity)
  }

  /**
   * Enqueue what fits.
   * @param bytes - what to send.
   * @returns how many bytes were taken; the caller keeps the rest.
   */
  write(bytes: Uint8Array): number {
    const written = Atomics.load(this.header, WRITTEN)
    const room = this.capacity - this.pending
    const count = Math.min(room, bytes.byteLength)
    if (count === 0) return 0
    const start = written % this.capacity
    const first = Math.min(count, this.capacity - start)
    this.data.set(bytes.subarray(0, first), start)
    if (first < count) this.data.set(bytes.subarray(first, count), 0)
    Atomics.store(this.header, WRITTEN, (written + count) % (2 * this.capacity))
    Atomics.notify(this.header, WRITTEN)
    return count
  }

  /**
   * Take what is there, without waiting.
   * @param limit - the most to take.
   * @returns the bytes, possibly none.
   */
  read(limit = this.capacity): Uint8Array {
    const read = Atomics.load(this.header, READ)
    const count = Math.min(this.pending, limit)
    if (count === 0) return new Uint8Array(0)
    const start = read % this.capacity
    const first = Math.min(count, this.capacity - start)
    const out = new Uint8Array(count)
    out.set(this.data.subarray(start, start + first), 0)
    if (first < count) out.set(this.data.subarray(0, count - first), first)
    Atomics.store(this.header, READ, (read + count) % (2 * this.capacity))
    Atomics.notify(this.header, READ)
    return out
  }

  /**
   * Block until there is something to read.
   *
   * The comparison `Atomics.wait` makes is what keeps this free of the race a
   * check-then-sleep has: a write that lands between the two happens to the
   * value being compared, so the wait returns immediately instead of missing
   * the wake-up.
   * @param timeoutMs - how long to wait; `Infinity` for as long as it takes.
   * @returns whether anything is now readable.
   */
  waitForData(timeoutMs = Infinity): boolean {
    if (this.pending > 0) return true
    if (!CAN_BLOCK) return false
    const written = Atomics.load(this.header, WRITTEN)
    Atomics.wait(this.header, WRITTEN, written, timeoutMs)
    return this.pending > 0
  }

  /**
   * Block until the reader has made room.
   * @param timeoutMs - how long to wait.
   * @returns whether there is room now.
   */
  waitForRoom(timeoutMs = Infinity): boolean {
    if (this.pending < this.capacity) return true
    if (!CAN_BLOCK) return false
    const read = Atomics.load(this.header, READ)
    Atomics.wait(this.header, READ, read, timeoutMs)
    return this.pending < this.capacity
  }

  /**
   * Settle when there is something to read, without blocking.
   *
   * The page cannot call `Atomics.wait` — a browser refuses to park its main
   * thread — so this uses `Atomics.waitAsync` where it exists and falls back to
   * a short timer where it does not. Either way the caller gets a promise
   * rather than a spin.
   * @param timeoutMs - how long to wait before settling anyway.
   */
  async whenData(timeoutMs = 25): Promise<void> {
    if (this.pending > 0) return
    const written = Atomics.load(this.header, WRITTEN)
    const asyncWait = (Atomics as unknown as {
      waitAsync?: (array: Int32Array, index: number, value: number, timeout: number) =>
      { async: boolean, value: Promise<string> | string }
    }).waitAsync
    if (asyncWait === undefined) {
      await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 8)))
      return
    }
    const result = asyncWait.call(Atomics, this.header, WRITTEN, written, timeoutMs)
    if (result.async) await result.value
  }

  /**
   * Enqueue everything, waiting for room as needed.
   *
   * Only safe off the main thread; the page's side uses {@link write} and
   * keeps whatever did not fit.
   * @param bytes - what to send.
   */
  writeAll(bytes: Uint8Array): void {
    let rest = bytes
    while (rest.byteLength > 0) {
      const taken = this.write(rest)
      rest = rest.subarray(taken)
      if (rest.byteLength > 0) this.waitForRoom(50)
    }
  }
}
