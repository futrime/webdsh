/**
 * WebSocket connections between the page and the host running inside it.
 *
 * A plugin that wants a live channel does what it would on a real server:
 * `new WebSocketServer({ noServer: true })` plus a `registerUpgrade` route that
 * calls `handleUpgrade`. Nothing about that pattern needs a listening socket —
 * it only needs an upgrade to be handed to it — so it works here once the two
 * ends are wired to each other.
 *
 * The page's patched `WebSocket` constructor offers the URL to the virtual
 * server's upgrade routes. If one claims it, the caller gets the client end of
 * an in-page pair and the plugin's callback gets the server end; if none does,
 * the socket falls through to the network unchanged.
 */

import { IncomingMessageShim, SocketShim, upgradeVirtualRequest } from '../node/http.ts'

/** Ready states, as the WebSocket interface defines them. */
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** Minimal listener registry shared by both ends. */
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

  protected fire(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(...args)
      } catch (error) {
        console.error(`[virtual-websocket] ${event} listener threw:`, error)
      }
    }
  }
}

/** The server end, shaped like a `ws` socket. */
export class VirtualServerSocket extends Emitter {
  readyState = OPEN
  binaryType: 'nodebuffer' | 'arraybuffer' = 'nodebuffer'
  /** Set by {@link VirtualSocketPair}; delivers to the client end. */
  deliver: ((data: unknown) => void) | undefined
  /** Set by {@link VirtualSocketPair}; closes the client end. */
  shutdown: ((code: number, reason: string) => void) | undefined

  /** Send a frame to the page. */
  send(data: unknown, callback?: (error?: Error) => void): void {
    if (this.readyState !== OPEN) {
      callback?.(new Error('WebSocket is not open'))
      return
    }
    this.deliver?.(data)
    callback?.()
  }

  /** Close the connection. */
  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    this.readyState = CLOSING
    this.shutdown?.(code, reason)
    this.readyState = CLOSED
    this.fire('close', code, reason)
  }

  terminate(): void {
    this.close(1006, 'terminated')
  }

  ping(): void {}
  pong(): void {}

  /** Receive a frame from the page (called by the pair). */
  accept(data: unknown): void {
    this.fire('message', data, false)
  }

  /** The page closed its end. */
  peerClosed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.fire('close', code, reason)
  }
}

/** The client end, shaped like the platform `WebSocket`. */
export class VirtualClientSocket extends EventTarget {
  readyState: number = CONNECTING
  readonly protocol = ''
  readonly extensions = ''
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED

  constructor(readonly url: string, private readonly peer: VirtualServerSocket) {
    super()
    // Open on a later task so a caller that attaches handlers right after
    // construction — every caller — still sees the event.
    queueMicrotask(() => {
      this.readyState = OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  private dispatch(type: string, event: Event): void {
    const handler = type === 'open' ? this.onopen : type === 'message' ? this.onmessage : type === 'error' ? this.onerror : this.onclose
    handler?.call(this, event as never)
    this.dispatchEvent(event)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError')
    this.peer.accept(data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    this.readyState = CLOSING
    this.peer.peerClosed(code, reason)
    this.readyState = CLOSED
    this.dispatch('close', new CloseEvent('close', { code, reason, wasClean: true }))
  }

  /** Receive a frame from the host (called by the pair). */
  accept(data: unknown): void {
    if (this.readyState !== OPEN) return
    this.dispatch('message', new MessageEvent('message', { data }))
  }

  /** The host closed its end. */
  peerClosed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.dispatch('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }))
  }
}

/** One connected pair. */
export interface VirtualSocketPair {
  client: VirtualClientSocket
  server: VirtualServerSocket
}

/** Property the upgrade handler reads off the synthetic socket to find its pair. */
export const UPGRADE_PAIR = '__dshUpgradePair'

/**
 * Offer a URL to the host's upgrade routes.
 * @param url - the requested WebSocket URL.
 * @returns the client end when a route accepted it, otherwise undefined.
 */
export function openVirtualWebSocket(url: string): VirtualClientSocket | undefined {
  const parsed = new URL(url)
  const server = new VirtualServerSocket()
  const client = new VirtualClientSocket(url, server)
  server.deliver = data => { client.accept(data) }
  server.shutdown = (code, reason) => { client.peerClosed(code, reason) }

  const socket = new SocketShim() as SocketShim & { [UPGRADE_PAIR]?: VirtualSocketPair }
  socket[UPGRADE_PAIR] = { client, server }
  const request = new IncomingMessageShim(
    'GET',
    `${parsed.pathname}${parsed.search}`,
    {
      host: '127.0.0.1:3080',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': btoa(String(Math.floor(performance.now()))).slice(0, 24),
    },
    new Uint8Array(0),
    socket,
  )

  const claimed = upgradeVirtualRequest(request, socket)
  if (!claimed || socket.destroyed) return undefined
  return client
}
