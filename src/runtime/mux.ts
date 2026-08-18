/**
 * The page's half of the machine's front door.
 *
 * `container/dsh-mux` runs as the container's first process and turns the one
 * byte stream the emulator gives us into channels. This is the other end of
 * that protocol: it frames what goes down, reassembles what comes back, and
 * hands each channel's bytes to whoever opened it.
 *
 * It knows nothing about WASM, workers, or `SharedArrayBuffer` — it is given a
 * `write` and fed the bytes that arrive. That is what lets the same code be
 * driven against `docker run -i` in a test and against the emulator in the
 * page, and a protocol only one of those exercises is a protocol nobody has
 * checked.
 *
 * Payloads are escaped in both directions. The console between the two ends is
 * a tty in cooked mode that neither end can reconfigure, so a raw `\n` comes
 * back with a carriage return in front of it and a raw `^C` never arrives at
 * all; `container/dsh-mux` explains which bytes and why. The header line is not
 * escaped — it is ASCII by construction, and the `\n` that ends it is the one
 * byte a reader needs to find without knowing anything else.
 */

/** A frame's verb, in either direction. */
type Verb = 'open' | 'data' | 'err' | 'eof' | 'exit' | 'signal' | 'resize' | 'close' | 'ready' | 'fatal'

/**
 * The verbs the machine sends.
 *
 * Checked rather than assumed. Before the multiplexer starts, the console
 * carries whatever the kernel and the emulator have to say, and a line of that
 * which happened to read as `<word> <int> <int>` would otherwise be taken as a
 * header — and a header with a large length swallows every frame after it.
 */
const INBOUND: ReadonlySet<string> = new Set(['data', 'err', 'exit', 'ready', 'fatal'])

/** How a channel's process is started. */
export interface OpenRequest {
  kind: 'pty' | 'exec'
  /** Shell source, for an `exec` channel. */
  script?: string
  /** `$0` and the positional parameters, as `sh -c` takes them. */
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
  /** The program a `pty` channel runs; a login bash by default. */
  shell?: string
  /** Its whole argv, when the default `[shell, '-l']` is not what a caller wants. */
  argv?: string[]
}

/** What a caller does with a channel's output. */
export interface ChannelHandlers {
  onData?: (bytes: Uint8Array) => void
  onError?: (bytes: Uint8Array) => void
  onExit?: (status: number) => void
}

const encoder = new TextEncoder()

/**
 * The byte that introduces an escape, and the bytes that need one.
 *
 * `container/dsh-mux` lists why each one is here. The surprise is `0x01`: it is
 * the emulator's own monitor escape, so it is taken before the virtual machine
 * ever sees it, and a payload containing one simply arrives a byte short.
 */
const ESCAPE = 0x5c
const SPECIAL = new Set([ESCAPE, 0x01, 0x03, 0x04, 0x0a, 0x0d, 0x11, 0x13, 0x16, 0x1a, 0x1c])

/**
 * Make a payload safe to put on the console.
 * @param bytes - what to send.
 * @returns the same bytes, with the console's favourites written as pairs.
 */
function escape(bytes: Uint8Array): Uint8Array {
  let extra = 0
  for (const byte of bytes) if (SPECIAL.has(byte)) extra++
  if (extra === 0) return bytes
  const out = new Uint8Array(bytes.byteLength + extra)
  let at = 0
  for (const byte of bytes) {
    if (SPECIAL.has(byte)) {
      out[at++] = ESCAPE
      // The high bit keeps the second byte clear of the escape byte, so every
      // `ESCAPE` in the stream is unambiguously the start of a pair.
      out[at++] = byte | 0x80
    } else {
      out[at++] = byte
    }
  }
  return out
}

/**
 * Undo {@link escape}.
 * @param bytes - what arrived.
 * @returns the payload as it was written.
 */
function unescape(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(ESCAPE)) return bytes
  const out = new Uint8Array(bytes.byteLength)
  let at = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] === ESCAPE && index + 1 < bytes.byteLength) out[at++] = bytes[++index] & 0x7f
    else out[at++] = bytes[index]
  }
  return out.subarray(0, at)
}

/** One conversation with the machine. */
export class Channel {
  private settled = false

  constructor(
    readonly number: number,
    private readonly machine: Mux,
    private readonly handlers: ChannelHandlers,
  ) {}

  /** Feed the channel's process standard input. */
  write(data: Uint8Array | string): void {
    this.machine.send('data', this.number, typeof data === 'string' ? encoder.encode(data) : data)
  }

  /** Close the channel's standard input; a command that reads to EOF needs this. */
  end(): void {
    this.machine.send('eof', this.number)
  }

  /** Deliver a signal to the channel's whole process group. */
  kill(signal = 'SIGTERM'): void {
    this.machine.send('signal', this.number, encoder.encode(signal))
  }

  /** Tell a pty channel its new grid. */
  resize(cols: number, rows: number): void {
    this.machine.send('resize', this.number, encoder.encode(`${String(cols)} ${String(rows)}`))
  }

  /** @internal */
  accept(verb: Verb, payload: Uint8Array): boolean {
    if (verb === 'data') this.handlers.onData?.(payload)
    else if (verb === 'err') this.handlers.onError?.(payload)
    else if (verb === 'exit') {
      if (this.settled) return true
      this.settled = true
      this.handlers.onExit?.(Number(new TextDecoder().decode(payload)) || 0)
      return true
    }
    return false
  }

  /** @internal — report an exit the machine itself cannot, because it is gone. */
  abandon(status: number): void {
    if (this.settled) return
    this.settled = true
    this.handlers.onExit?.(status)
  }
}

/**
 * Channels over one stream.
 *
 * Channel numbers are never reused within a session. The multiplexer keys its
 * own state by them, and a number that came back around would let a frame from
 * a finished command arrive on a fresh one.
 */
export class Mux {
  private readonly channels = new Map<number, Channel>()
  private next = 1
  private buffer: Uint8Array = new Uint8Array(0)
  /** The header of the frame being reassembled, once its line has arrived. */
  private pending: { verb: Verb, channel: number, length: number } | undefined
  private resolveReady: (() => void) | undefined
  private rejectReady: ((error: Error) => void) | undefined

  /** Settles when the multiplexer has announced itself. */
  readonly ready: Promise<void>

  constructor(private readonly transport: (bytes: Uint8Array) => void) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
  }

  /** Start a channel. */
  open(request: OpenRequest, handlers: ChannelHandlers): Channel {
    const number = this.next++
    const channel = new Channel(number, this, handlers)
    this.channels.set(number, channel)
    this.send('open', number, encoder.encode(JSON.stringify(request)))
    return channel
  }

  /** @internal */
  send(verb: Verb, channel: number, payload: Uint8Array = new Uint8Array(0)): void {
    const body = escape(payload)
    const header = encoder.encode(`${verb} ${String(channel)} ${String(body.byteLength)}\n`)
    if (body.byteLength === 0) {
      this.transport(header)
      return
    }
    const frame = new Uint8Array(header.byteLength + body.byteLength)
    frame.set(header, 0)
    frame.set(body, header.byteLength)
    this.transport(frame)
  }

  /**
   * Take bytes off the machine's output.
   * @param bytes - whatever arrived, at whatever boundary it arrived on.
   */
  feed(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    const merged = new Uint8Array(this.buffer.byteLength + bytes.byteLength)
    merged.set(this.buffer, 0)
    merged.set(bytes, this.buffer.byteLength)
    this.buffer = merged

    for (;;) {
      if (this.pending === undefined) {
        const end = this.buffer.indexOf(0x0a)
        if (end < 0) return
        // The carriage return is the console's, not the sender's.
        const line = new TextDecoder().decode(this.buffer.subarray(0, end)).replace(/\r$/, '')
        this.buffer = this.buffer.subarray(end + 1)
        const [verb, channel, length] = line.split(' ')
        // Anything that is not a frame header is the machine talking out of
        // band — a kernel message on the console before the multiplexer is up,
        // most often — and is not worth failing the stream over.
        if (verb === undefined || channel === undefined || length === undefined) continue
        if (!INBOUND.has(verb)) continue
        const size = Number(length)
        if (!Number.isInteger(size) || size < 0) continue
        if (!Number.isInteger(Number(channel))) continue
        this.pending = { verb: verb as Verb, channel: Number(channel), length: size }
      }
      if (this.buffer.byteLength < this.pending.length) return
      const payload = unescape(this.buffer.slice(0, this.pending.length))
      this.buffer = this.buffer.subarray(this.pending.length)
      const frame = this.pending
      this.pending = undefined
      this.dispatch(frame.verb, frame.channel, payload)
    }
  }

  /** Route one complete frame. */
  private dispatch(verb: Verb, number: number, payload: Uint8Array): void {
    if (verb === 'ready') {
      this.resolveReady?.()
      return
    }
    if (verb === 'fatal') {
      this.fail(new Error(`the machine's multiplexer failed: ${new TextDecoder().decode(payload)}`))
      return
    }
    const channel = this.channels.get(number)
    if (channel === undefined) return
    if (channel.accept(verb, payload)) this.channels.delete(number)
  }

  /**
   * Give up on the machine.
   *
   * Every open channel is told, because each one has a caller waiting on an
   * exit that is never going to arrive — a tool call that hangs forever is
   * worse than one that fails.
   * @param error - why.
   */
  fail(error: Error): void {
    this.rejectReady?.(error)
    for (const channel of this.channels.values()) channel.abandon(1)
    this.channels.clear()
  }
}
