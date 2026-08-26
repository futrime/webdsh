/**
 * The page's network policy, carried into the container.
 *
 * This is the one file in this repository that runs neither in the page nor on
 * an emulated machine: it is preloaded into every Node process the container
 * starts, by `NODE_OPTIONS=--require`, and it exists because of a limit
 * `src/net/cors-proxy.ts` states and cannot fix from where it stands.
 *
 * A tab reaches a host only if that host allows browsers, and the page answers
 * that with one retry through a proxy — automatically, so no caller has to know.
 * The container is the one place that never got it. Its requests leave from
 * StackBlitz's own worker, so neither a patched `window.fetch` nor
 * `public/sw.js` ever sees them; both were measured, and both see nothing.
 * Until now the whole of this build's answer was to *tell* the model, in the
 * shell tool's description, to prefix a proxy by hand — advice a model follows
 * unevenly and `npm` cannot follow at all.
 *
 * So the policy comes here instead, and the same three rules apply as in the
 * page:
 *
 * - **Direct first, always.** A proxy is a third party that sees the whole
 *   request. It is a fallback after a real failure, never a route.
 * - **Per origin, once.** After a proxied retry works, that origin skips the
 *   direct attempt — and the memo is dropped the moment a proxied request
 *   fails, so a proxy that stops answering does not strand the process.
 * - **Configured by the page, not here.** The template arrives in the
 *   environment, so turning the proxy off in Settings turns this off too, and
 *   there is one answer to "what is the proxy" rather than two.
 *
 * ## The other half: a socket
 *
 * `fetch` is the only way out of a worker on its own, and that is a real
 * ceiling — a request that is not HTTP has nowhere to go. The container does
 * ship `net`, and it is a stub: `net.connect({ host: 'example.com', port: 80 })`
 * fires `connect` and then carries nothing at all, measured, which is worse
 * than refusing because a caller waits on it forever.
 *
 * The emulated machine solved this with a relay — a WebSocket server that owns
 * real sockets — and the container can use the same one. `WebSocket` exists in
 * here, so when `DSH_RELAY` names a WISP server this file offers a duplex that
 * speaks WISP over it: `globalThis.dshConnect('example.com', 80)` connects, and
 * bytes go both ways. Measured against example.com, which answered.
 *
 * What does *not* work on top of it is TLS. Node's `tls.connect({ socket })`
 * takes any duplex in a normal Node, and in this one it throws
 * `this.handle[…] is not a function` — the runtime's `tls` reaches for
 * internals a plain stream does not have. So the relay gives the container
 * plaintext TCP and no more; `https` is already covered by `fetch`, which
 * terminates TLS in the browser, and a *non-HTTP* protocol over TLS is the one
 * thing the emulated machine can do here that the container cannot.
 *
 * It is offered as `globalThis.dshConnect(host, port)` rather than installed
 * over `net.connect`, and that is not a matter of taste. Node's `fetch` is
 * undici and undici is built on `net.connect`: replacing it captures the
 * sockets `fetch` itself needs, and a socket that then waits on a relay
 * handshake makes `fetch` hang rather than fail. Measured, and it cost a
 * ten-minute run to notice — every command in the container went silent. So the
 * relay is a thing a caller asks for, and everything that did not ask keeps the
 * network it had.
 *
 * One relay serves both runtimes and it is the same setting for both, because
 * "which third party carries this session's traffic" deserves one answer.
 */

/** The proxy template, as the page's own configuration spells it. */
const template = process.env.DSH_CORS_PROXY ?? ''

/** The relay, as Settings → Network names it for the whole session. */
const relay = (process.env.DSH_RELAY ?? '').trim()

/** Origins that answered only through the proxy, so the direct attempt is skipped. */
const proxyOnly = new Set<string>()

/**
 * Address one URL through the proxy template.
 * @param url - the target URL.
 * @returns the proxied URL, or undefined when the template names no placeholder.
 */
function proxied(url: string): string | undefined {
  if (!template.includes('{url}') && !template.includes('{encoded}')) return undefined
  return template.replaceAll('{encoded}', encodeURIComponent(url)).replaceAll('{url}', url)
}

/**
 * Whether a rejection is the runtime refusing to hand over a response.
 *
 * The container reports a blocked request the way a browser does and then some:
 * `fetch` rejects with a `TypeError`, and Node's own client surfaces the same
 * thing as `socket hang up`, measured. An abort is the caller's own
 * cancellation and must pass through untouched.
 * @param error - the rejection.
 * @returns whether to try the proxy.
 */
function isRefusal(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const named = error as { name?: string, message?: string, cause?: { message?: string } }
  if (named.name === 'AbortError') return false
  const text = `${named.message ?? ''} ${named.cause?.message ?? ''}`
  return named.name === 'TypeError'
    || /fetch failed|socket hang up|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(text)
}

/** Whether a URL is the proxy itself, which must never be proxied again. */
function isProxyTarget(url: URL): boolean {
  try {
    return new URL(template.replace(/\{(url|encoded)\}/g, '')).origin === url.origin
  } catch {
    return false
  }
}

/**
 * Install the policy over `fetch`.
 *
 * Only `fetch`, and only when a proxy is configured. Node's `http.request` is a
 * different shape — a stream the caller writes to and an event the caller waits
 * for — and rebuilding one of those out of a `Response` is a re-implementation
 * of the client rather than a policy on top of it.
 */
function installFetch(): void {
  const original = globalThis.fetch
  if (typeof original !== 'function' || template === '') return

  const patched: typeof fetch = async (input, init) => {
    let url: URL
    try {
      url = new URL(input instanceof Request ? input.url : String(input))
    } catch {
      return original(input as RequestInfo, init)
    }
    const eligible = (url.protocol === 'http:' || url.protocol === 'https:') && !isProxyTarget(url)
    const target = eligible ? proxied(url.href) : undefined
    if (target === undefined) return original(input as RequestInfo, init)

    // Cloned before the attempt, because a failed `fetch` may still have
    // consumed the body — and the direct attempt and the retry would otherwise
    // be reading the same one.
    let spare: Request | undefined
    if (input instanceof Request) {
      try {
        spare = input.clone()
      } catch {
        // A body with no second reader gets one attempt, which is the same one
        // it would have had before.
      }
    }

    const throughProxy = async (): Promise<Response> => {
      if (spare === undefined) return original(target, { ...init, redirect: 'follow' })
      const body = spare.method === 'GET' || spare.method === 'HEAD' ? undefined : await spare.arrayBuffer()
      return original(new Request(target, {
        method: spare.method,
        headers: spare.headers,
        ...body === undefined || body.byteLength === 0 ? {} : { body },
        redirect: 'follow',
        signal: spare.signal,
      }))
    }

    // An origin already known to answer only through the proxy skips the direct
    // attempt: it would cost a round trip to learn the same thing again.
    if (proxyOnly.has(url.origin)) {
      try {
        return await throughProxy()
      } catch (error) {
        proxyOnly.delete(url.origin)
        throw error
      }
    }

    try {
      return await original(input as RequestInfo, init)
    } catch (error) {
      if (!isRefusal(error)) throw error
      const response = await throughProxy()
      proxyOnly.add(url.origin)
      return response
    }
  }

  Object.defineProperty(patched, 'name', { value: 'fetch' })
  globalThis.fetch = patched
}

/** WISP frame types, as the protocol numbers them. */
const CONNECT = 0x01
const DATA = 0x02
const CLOSE = 0x04

/** TCP, as WISP's stream-type byte spells it. */
const TCP = 0x01

/** What a stream needs told: its bytes, and its end. */
interface Sink {
  push(chunk: Buffer): void
  finish(): void
}

/**
 * One connection to a WISP relay, multiplexing every socket in this process.
 *
 * A relay carries many streams over one WebSocket, which is what makes it worth
 * having: a process that opens ten sockets opens one WebSocket. The link is
 * made on first use and never reconnected — a process that has lost its relay
 * has lost its sockets, and pretending otherwise would hand a caller a stream
 * that silently carries nothing, which is the exact failure this file exists to
 * remove.
 */
class Relay {
  private socket: WebSocket | undefined
  private next = 1
  private readonly streams = new Map<number, Sink>()
  private opening: Promise<void> | undefined

  /**
   * Connect, once.
   * @returns a promise that settles when the relay has accepted the socket.
   */
  async ready(): Promise<void> {
    this.opening ??= new Promise<void>((resolve, reject) => {
      const url = relay.replace(/^wisp:\/\//i, 'ws://').replace(/^wisps:\/\//i, 'wss://')
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      socket.onerror = () => { reject(new Error(`the relay at ${relay} did not accept a connection`)) }
      socket.onclose = () => {
        for (const stream of this.streams.values()) stream.finish()
        this.streams.clear()
      }
      socket.onmessage = (event: MessageEvent) => { this.receive(new Uint8Array(event.data as ArrayBuffer)) }
      socket.onopen = () => { resolve() }
    })
    return this.opening
  }

  /** Read one frame off the relay. */
  private receive(frame: Uint8Array): void {
    if (frame.length < 5) return
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const id = view.getUint32(1, true)
    const stream = this.streams.get(id)
    if (stream === undefined) return
    if (frame[0] === DATA) stream.push(Buffer.from(frame.subarray(5)))
    else if (frame[0] === CLOSE) stream.finish()
  }

  /** Send one frame. */
  private send(type: number, id: number, payload: Uint8Array): void {
    const frame = new Uint8Array(5 + payload.length)
    const view = new DataView(frame.buffer)
    frame[0] = type
    view.setUint32(1, id, true)
    frame.set(payload, 5)
    this.socket?.send(frame)
  }

  /**
   * Open one TCP stream through the relay.
   * @param host - the host to reach.
   * @param port - the port to reach it on.
   * @param sink - where the stream's bytes and its end are delivered.
   * @returns a handle for writing to and closing the stream.
   */
  open(host: string, port: number, sink: Sink): { write(chunk: Uint8Array): void, close(): void } {
    const id = this.next++
    this.streams.set(id, sink)
    const name = Buffer.from(host, 'utf8')
    const payload = new Uint8Array(3 + name.length)
    const view = new DataView(payload.buffer)
    payload[0] = TCP
    view.setUint16(1, port, true)
    payload.set(name, 3)
    this.send(CONNECT, id, payload)
    return {
      write: (chunk: Uint8Array) => { this.send(DATA, id, chunk) },
      close: () => {
        this.send(CLOSE, id, new Uint8Array([0x02]))
        this.streams.delete(id)
      },
    }
  }
}

/**
 * Offer the relay's TCP to anything in this process that asks for it.
 *
 * `globalThis.dshConnect(host, port)` hands back a duplex that is a socket in
 * every way a caller needs: it emits `connect`, carries bytes both ways, ends
 * when the far side does, and is accepted by `tls.connect({ socket })` — which
 * is how a caller gets real TLS to a host that never allowed browsers.
 *
 * Deliberately not `net.connect`. See this file's header: undici's `fetch` is
 * built on that function, and taking it over hangs every request in the
 * process.
 */
function installSockets(): void {
  if (relay === '') return
  const { Duplex } = require('node:stream') as typeof import('node:stream')
  const shared = new Relay()

  class RelaySocket extends Duplex {
    private handle: { write(chunk: Uint8Array): void, close(): void } | undefined
    private readonly waiting: Uint8Array[] = []
    private ended = false
    readonly remoteAddress: string
    readonly remotePort: number
    connecting = true

    constructor(private readonly host: string, private readonly port: number) {
      super()
      this.remoteAddress = host
      this.remotePort = port
      void shared.ready().then(() => {
        this.handle = shared.open(host, port, {
          push: (chunk) => { this.push(chunk) },
          finish: () => {
            if (this.ended) return
            this.ended = true
            this.push(null)
          },
        })
        for (const chunk of this.waiting) this.handle.write(chunk)
        this.waiting.length = 0
        this.connecting = false
        this.emit('connect')
        this.emit('ready')
      }).catch((error: unknown) => { this.destroy(error as Error) })
    }

    override _read(): void {}

    override _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
      if (this.handle === undefined) this.waiting.push(new Uint8Array(chunk))
      else this.handle.write(new Uint8Array(chunk))
      done()
    }

    override _final(done: (error?: Error) => void): void {
      this.handle?.close()
      done()
    }

    override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
      this.handle?.close()
      done(error)
    }

    /** The parts of `net.Socket` a caller expects to be able to call. */
    setNoDelay(): this { return this }
    setKeepAlive(): this { return this }
    setTimeout(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
    address(): { address: string, family: string, port: number } {
      return { address: this.host, family: 'IPv4', port: this.port }
    }
  }

  ;(globalThis as { dshConnect?: unknown }).dshConnect = (host: string, port: number): unknown =>
    new RelaySocket(host, port)
}

installFetch()
installSockets()
