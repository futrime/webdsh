/**
 * `node:http` as an in-page virtual server.
 *
 * `dsh-host-webserver` is kept as the real route registry — exact/prefix
 * matching, upgrade routes, the single fallback owner, index taps, and its
 * error handling all run unmodified — and only the socket underneath it is
 * virtual. {@link dispatchVirtualRequest} converts a WHATWG `Request` into the
 * `IncomingMessage`/`ServerResponse` pair a handler expects and collects the
 * reply, so the page's patched `fetch` reaches `/api` through the same bridge a
 * real browser would.
 */

import { StreamEmitter, ReadableStreamShim } from './streams.ts'
import { Buffer, toBytes, toText } from './binary.ts'

/** Node's `IncomingMessage`, as much of it as the route handlers read. */
export class IncomingMessageShim extends ReadableStreamShim {
  method: string
  url: string
  headers: Record<string, string>
  httpVersion = '1.1'
  socket: SocketShim
  aborted = false

  constructor(method: string, url: string, headers: Record<string, string>, body: Uint8Array, socket: SocketShim) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = socket
    queueMicrotask(() => {
      if (body.length > 0) this.push(body)
      this.end()
    })
  }

  /** Node exposes the raw header list; handlers here read the object form. */
  get rawHeaders(): string[] {
    return Object.entries(this.headers).flat()
  }

  setTimeout(): this { return this }
  destroy(): this { return this }
}

/** A virtual socket. Upgrade handlers write raw bytes into it. */
export class SocketShim extends StreamEmitter {
  readonly remoteAddress = '127.0.0.1'
  readonly remotePort = 54321
  readonly localAddress = '127.0.0.1'
  readonly localPort = 3080
  destroyed = false
  private readonly chunks: Uint8Array[] = []

  write(chunk: Uint8Array | string): boolean {
    if (this.destroyed) return false
    this.chunks.push(toBytes(chunk))
    this.emit('written', toBytes(chunk))
    return true
  }

  /** Everything written so far (upgrade handshakes inspect this). */
  written(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const out = new Uint8Array(total)
    let cursor = 0
    for (const chunk of this.chunks) {
      out.set(chunk, cursor)
      cursor += chunk.length
    }
    return out
  }

  end(chunk?: Uint8Array | string): this {
    if (chunk !== undefined) this.write(chunk)
    this.destroyed = true
    this.emit('close')
    return this
  }

  destroy(): this {
    this.destroyed = true
    this.emit('close')
    return this
  }

  setNoDelay(): this { return this }
  setKeepAlive(): this { return this }
  setTimeout(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  pause(): this { return this }
  resume(): this { return this }
}

/** Node's `ServerResponse`, collecting the reply for the caller. */
export class ServerResponseShim extends StreamEmitter {
  statusCode = 200
  statusMessage = 'OK'
  headersSent = false
  finished = false
  private readonly headers = new Map<string, string>()
  private readonly done: (response: { status: number, headers: Record<string, string>, body: ReadableStream<Uint8Array> }) => void
  readonly socket: SocketShim

  /** Whether the reply has been handed to the caller yet. */
  private started = false
  /** Feeds {@link body}; set synchronously by the stream's `start`. */
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  /** The response body, produced as the handler writes it. */
  private readonly body: ReadableStream<Uint8Array>

  constructor(socket: SocketShim, done: (response: { status: number, headers: Record<string, string>, body: ReadableStream<Uint8Array> }) => void) {
    super()
    this.socket = socket
    this.done = done
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller },
    })
  }

  /**
   * Hand the reply to the caller, once, as soon as anything is written.
   *
   * Waiting for `end()` before answering is what an ordinary handler makes look
   * correct and what a streaming one exposes as broken: an event stream never
   * ends, so the caller waits forever and eventually reports the route missing.
   * Answering at the first write means the status and headers are whatever the
   * handler had set by then — which is exactly what a real server sends, since
   * that is the moment it commits them to the wire.
   */
  private begin(): void {
    if (this.started) return
    this.started = true
    this.headersSent = true
    this.done({ status: this.statusCode, headers: Object.fromEntries(this.headers), body: this.body })
  }

  setHeader(name: string, value: string | string[] | number): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    return this
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())
  }

  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headers)
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase())
  }

  writeHead(status: number, reasonOrHeaders?: string | Record<string, string | number>, maybeHeaders?: Record<string, string | number>): this {
    this.statusCode = status
    const headers = typeof reasonOrHeaders === 'string' ? maybeHeaders : reasonOrHeaders
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    this.headersSent = true
    return this
  }

  write(chunk: Uint8Array | string, encoding?: string | (() => void), callback?: () => void): boolean {
    this.begin()
    if (!this.finished) this.controller?.enqueue(toBytes(chunk, typeof encoding === 'string' ? encoding : 'utf8'))
    const finish = typeof encoding === 'function' ? encoding : callback
    if (finish !== undefined) queueMicrotask(finish)
    return true
  }

  end(chunk?: Uint8Array | string | (() => void), callback?: () => void): this {
    if (this.finished) return this
    this.begin()
    if (chunk !== undefined && typeof chunk !== 'function') this.controller?.enqueue(toBytes(chunk))
    this.finished = true
    this.controller?.close()
    queueMicrotask(() => {
      this.emit('finish')
      this.emit('close')
      if (typeof chunk === 'function') chunk()
      callback?.()
    })
    return this
  }

  /** Commit the status and headers before any body, as an event stream does. */
  flushHeaders(): void {
    this.begin()
  }

  setTimeout(): this { return this }
  destroy(): this { return this }
  get writableEnded(): boolean { return this.finished }
}

/** A virtual HTTP server. */
export class ServerShim extends StreamEmitter {
  private listening = false
  private boundPort = 0
  private boundHost = '127.0.0.1'

  constructor(requestListener?: (req: IncomingMessageShim, res: ServerResponseShim) => void) {
    super()
    if (requestListener !== undefined) this.on('request', requestListener as (...args: unknown[]) => void)
  }

  /** Bind. The port is recorded, not opened; nothing outside the page can reach it. */
  listen(...args: unknown[]): this {
    const port = args.find(argument => typeof argument === 'number') as number | undefined
    const host = args.find(argument => typeof argument === 'string') as string | undefined
    const callback = args.find(argument => typeof argument === 'function') as (() => void) | undefined
    this.boundPort = port === undefined || port === 0 ? 3080 : port
    if (host !== undefined) this.boundHost = host
    this.listening = true
    servers.add(this)
    queueMicrotask(() => {
      this.emit('listening')
      callback?.()
    })
    return this
  }

  address(): { address: string, family: string, port: number } | null {
    return this.listening ? { address: this.boundHost, family: 'IPv4', port: this.boundPort } : null
  }

  close(callback?: (error?: Error) => void): this {
    this.listening = false
    servers.delete(this)
    queueMicrotask(() => {
      this.emit('close')
      callback?.()
    })
    return this
  }

  closeAllConnections(): void {}
  closeIdleConnections(): void {}
  setTimeout(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  get maxHeadersCount(): number { return 0 }
}

/** Every listening virtual server, in creation order. */
const servers = new Set<ServerShim>()

/** `http.createServer`. */
export function createServer(
  optionsOrListener?: unknown,
  maybeListener?: (req: IncomingMessageShim, res: ServerResponseShim) => void,
): ServerShim {
  const listener = typeof optionsOrListener === 'function'
    ? optionsOrListener as (req: IncomingMessageShim, res: ServerResponseShim) => void
    : maybeListener
  return new ServerShim(listener)
}

/** Response of a virtual dispatch. */
export interface VirtualResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * Route a WHATWG `Request` through the virtual servers.
 * @param request - the request the page's patched `fetch` intercepted.
 * @returns the response, or undefined when no virtual server is listening.
 */
export async function dispatchVirtualRequest(request: Request): Promise<Response | undefined> {
  const server = [...servers][0]
  if (server === undefined) return undefined
  const url = new URL(request.url)
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    // Browser-attached cross-origin markers are dropped deliberately.
    //
    // The `/api` trust fence exists to stop a *remote* page from reaching a
    // local dsh server through DNS rebinding: it compares `Host` against
    // loopback and requires any attached `Origin` to match that authority.
    // This request never reaches a socket — it is dispatched inside the same
    // tab that issued it — so the page's own `Origin`/`Sec-Fetch-*` headers
    // describe a boundary that does not exist here, and forwarding them would
    // make the fence refuse the page's own privileged calls (Settings,
    // credentials, agent presets) on any non-loopback deployment.
    if (key === 'origin' || key.startsWith('sec-fetch-') || key === 'referer') return
    headers[key] = value
  })
  // The one authority this virtual server has: itself.
  headers.host = `127.0.0.1:${String(server.address()?.port ?? 3080)}`
  const body = new Uint8Array(await request.arrayBuffer())
  const socket = new SocketShim()

  return new Promise<Response>((resolve) => {
    const res = new ServerResponseShim(socket, (result) => {
      // 204 and 304 must carry no body at all; anything else streams, including
      // an empty one, which reads as zero bytes.
      const bodyless = result.status === 204 || result.status === 304
      resolve(new Response(bodyless ? null : result.body, {
        status: result.status,
        headers: result.headers,
      }))
    })
    const req = new IncomingMessageShim(request.method, `${url.pathname}${url.search}`, headers, body, socket)
    if (!server.emit('request', req, res)) {
      res.writeHead(404)
      res.end()
    }
  })
}

/** Whether any virtual server is currently listening. */
export function hasVirtualServer(): boolean {
  return servers.size > 0
}

/**
 * Offer an upgrade to the virtual server's routes.
 *
 * `dsh-host-webserver` owns the route table and destroys the socket when
 * nothing matches, so the caller reads `socket.destroyed` to learn whether a
 * route claimed the connection.
 * @param request - the synthetic upgrade request.
 * @param socket - the synthetic socket carrying the connection's two ends.
 * @returns whether a server was listening at all.
 */
export function upgradeVirtualRequest(request: IncomingMessageShim, socket: SocketShim): boolean {
  const server = [...servers][0]
  if (server === undefined) return false
  return server.emit('upgrade', request, socket, new Uint8Array(0))
}

/** `http.request`/`http.get` are unreachable: browsers cannot open raw sockets. */
export function request(): never {
  throw Object.assign(new Error('http.request is unavailable in the browser host; use fetch'), { code: 'ENOSYS' })
}

export const get = request
export const IncomingMessage = IncomingMessageShim
export const ServerResponse = ServerResponseShim
export const Server = ServerShim
export const STATUS_CODES: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 415: 'Unsupported Media Type',
  426: 'Upgrade Required', 500: 'Internal Server Error',
}
export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
export const Agent = class {}
export const globalAgent = new Agent()

export default {
  createServer, request, get, IncomingMessage, ServerResponse, Server,
  STATUS_CODES, METHODS, Agent, globalAgent,
}

/** Re-exported so `node:https` can share the same implementation. */
export { toText }
export const BufferRef = Buffer
