/**
 * The virtual network: the page's own `fetch` and `WebSocket` are patched so
 * the unmodified web client reaches the host running beside it in the same tab.
 *
 * `fetch('/api/…')` is routed through the virtual HTTP server, which means the
 * real `/api` route runs — the trust fence, the Typert gateway interceptor, and
 * the request bridge all execute exactly as they do behind a real socket.
 *
 * The two event downlinks bypass HTTP instead of emulating a WebSocket
 * handshake over a fake socket: they read `apiProxy.events.mux()` and
 * `.host()` directly and deliver each frame with the same `ServerRequest`
 * envelope the server would have framed. This is the documented in-process
 * carrier, and it is the shape dsh's own tests use.
 */

import type { Context } from '@deepseek-ai/cordis'
import { dispatchVirtualRequest } from '../node/http.ts'
import { installRequestHostPreservation } from './request-host.ts'
import { openVirtualWebSocket } from './virtual-websocket.ts'
import { fetchCrossOrigin } from './cors-proxy.ts'

/** Paths the interceptors claim. */
const API_PREFIX = '/api'
const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

/** Frame stream shape the api proxy publishes. */
type FrameStream = AsyncIterable<{ rpcId: string, payload: { type: string } }>

/** The api proxy surface the downlinks consume. */
interface EventsApiLike {
  events: {
    mux(request: { rpcId: string, payload: Record<string, never> }, signal?: AbortSignal): FrameStream
    host(request: { rpcId: string, payload: Record<string, never> }, signal?: AbortSignal): FrameStream
  }
}

/** The host context, set once the tree has settled. */
let hostContext: Context | undefined

/**
 * Point the interceptors at the booted host.
 * @param ctx - the settled host context (its `apiProxy` service serves the downlinks).
 */
export function attachHost(ctx: Context): void {
  hostContext = ctx
}

/** Whether a URL targets the in-page host. */
function isHostUrl(url: URL): boolean {
  return url.origin === location.origin && (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`))
}

/** Install the `fetch` interceptor. Idempotent. */
export function installFetchInterceptor(): void {
  const original = globalThis.fetch.bind(globalThis)
  const patched: typeof fetch = async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input as RequestInfo, init)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return original(input as RequestInfo, init)
    }
    // Everything that is not this page's own host goes out to the network, and
    // a cross-origin one goes through the CORS policy on the way — direct
    // first, and through the configured proxy only when the browser refused
    // the direct answer. Same-origin requests are nobody's business but the
    // server's.
    if (!isHostUrl(url)) {
      if (url.origin === location.origin) return original(input as RequestInfo, init)
      return fetchCrossOrigin(original, input, init, request, url)
    }
    const response = await dispatchVirtualRequest(request)
    if (response !== undefined) return response
    // No virtual server is listening yet — the client's own reconnect loop
    // handles this, and a 503 is what a not-yet-bound server would answer.
    return new Response('host not ready', { status: 503 })
  }
  Object.defineProperty(patched, 'name', { value: 'fetch' })
  globalThis.fetch = patched
}

/** Ready-state constants, as the `WebSocket` interface defines them. */
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/**
 * A `WebSocket` bound to one of the host's event streams. Only the members the
 * client's downlink reader uses are implemented, because that reader is the
 * one and only consumer of these two paths.
 */
class HostEventSocket extends EventTarget {
  readyState: number = CONNECTING
  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private readonly abort = new AbortController()

  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED

  constructor(url: string, private readonly channel: 'mux' | 'host') {
    super()
    this.url = url
    void this.pump()
  }

  /** Read the host stream and deliver each frame as a text message. */
  private async pump(): Promise<void> {
    const proxy = hostContext?.get('apiProxy') as EventsApiLike | undefined
    if (proxy === undefined) {
      this.fail('host not ready')
      return
    }
    this.readyState = OPEN
    this.dispatch('open', new Event('open'))
    try {
      const stream = this.channel === 'mux'
        ? proxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, this.abort.signal)
        : proxy.events.host({ rpcId: crypto.randomUUID(), payload: {} }, this.abort.signal)
      for await (const frame of stream) {
        if (this.readyState !== OPEN) break
        // The same envelope the SSE/WebSocket carrier frames on the wire.
        const envelope = { type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload }
        this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(envelope) }))
      }
      this.finish(1000, 'stream ended')
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.finish(1000, 'closed')
        return
      }
      console.error(`[virtual-network] ${this.channel} downlink failed:`, error)
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private dispatch(type: string, event: Event): void {
    const handler = type === 'open' ? this.onopen : type === 'message' ? this.onmessage : type === 'error' ? this.onerror : this.onclose
    handler?.call(this, event as never)
    this.dispatchEvent(event)
  }

  private fail(reason: string): void {
    this.readyState = CLOSED
    this.dispatch('error', new Event('error'))
    this.dispatch('close', new CloseEvent('close', { code: 1006, reason, wasClean: false }))
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.dispatch('close', new CloseEvent('close', { code, reason, wasClean: true }))
  }

  /** The downlinks are read-only; the client never sends application data. */
  send(): void {}

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    this.readyState = CLOSING
    this.abort.abort()
    this.finish(code, reason)
  }
}

/** Install the `WebSocket` interceptor. Idempotent. */
export function installWebSocketInterceptor(): void {
  const Original = globalThis.WebSocket
  const patched = function WebSocketProxy(this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
    const href = typeof url === 'string' ? url : url.href
    let parsed: URL | undefined
    try {
      parsed = new URL(href)
    } catch {
      parsed = undefined
    }
    if (parsed?.pathname === MUX_PATH) return new HostEventSocket(href, 'mux') as unknown as WebSocket
    if (parsed?.pathname === HOST_PATH) return new HostEventSocket(href, 'host') as unknown as WebSocket
    // Any other same-origin socket is offered to the host's upgrade routes,
    // which is how a plugin's own live channel connects.
    if (parsed !== undefined && parsed.host === location.host) {
      const virtual = openVirtualWebSocket(href)
      if (virtual !== undefined) return virtual as unknown as WebSocket
    }
    return new Original(url, protocols)
  } as unknown as typeof WebSocket

  // Preserve the constructor's static surface so feature detection keeps working.
  Object.setPrototypeOf(patched, Original)
  patched.prototype = Original.prototype
  Object.defineProperties(patched, {
    CONNECTING: { value: CONNECTING }, OPEN: { value: OPEN },
    CLOSING: { value: CLOSING }, CLOSED: { value: CLOSED },
  })
  globalThis.WebSocket = patched
}

/** Install every interceptor before the shell boots. */
export function installVirtualNetwork(): void {
  installRequestHostPreservation()
  installFetchInterceptor()
  installWebSocketInterceptor()
}
