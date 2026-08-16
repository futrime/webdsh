/**
 * `ws` for the browser.
 *
 * The real package ships a `browser` entry that throws on import, because a
 * page cannot open a raw socket — but a page *does* have WebSocket, and a
 * plugin using `ws` as a **client** wants exactly that. So the client half maps
 * onto the platform's own `WebSocket`, and only the server half — which needs
 * to accept connections — reports that it cannot exist here.
 */

import { UPGRADE_PAIR } from '../net/virtual-websocket.ts'

/** The platform WebSocket, which is what `ws`'s client API wraps on Node. */
const PlatformWebSocket = globalThis.WebSocket

export { PlatformWebSocket as WebSocket }

/** `ws`'s ready-state constants, which callers read off the class. */
export const CONNECTING = 0
export const OPEN = 1
export const CLOSING = 2
export const CLOSED = 3

/**
 * `ws.WebSocketServer`, restricted to the one mode a page can honor.
 *
 * `{ noServer: true }` binds nothing — it exists to receive upgrades another
 * server hands it — so a plugin using the standard `registerUpgrade` +
 * `handleUpgrade` pattern works here unchanged. Asking it to listen on a port
 * is the only thing that cannot work, and that fails loudly.
 */
export class WebSocketServer {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  readonly clients = new Set<unknown>()

  constructor(options?: { noServer?: boolean, port?: number, server?: unknown }) {
    if (options?.noServer !== true) {
      throw Object.assign(
        new Error(
          'ws.WebSocketServer needs `{ noServer: true }` in the browser host: a page cannot bind a port. '
          + 'Register an upgrade route and call handleUpgrade, which works here.',
        ),
        { code: 'ENOSYS' },
      )
    }
  }

  /**
   * Adopt an upgrade the host handed over.
   * @param request - the upgrade request.
   * @param socket - the synthetic socket carrying the connection pair.
   * @param head - unused; there is no buffered prefix in an in-page upgrade.
   * @param callback - receives the server end of the connection.
   */
  handleUpgrade(
    request: unknown,
    socket: unknown,
    head: unknown,
    callback: (socket: unknown, request: unknown) => void,
  ): void {
    void head
    const pair = (socket as Record<string, unknown>)[UPGRADE_PAIR] as { server: unknown } | undefined
    if (pair === undefined) {
      throw new Error('ws: this upgrade did not come from the in-page transport')
    }
    this.clients.add(pair.server)
    this.emit('connection', pair.server, request)
    callback(pair.server, request)
  }

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

  /** Emit to this server's listeners. */
  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(...args)
      } catch (error) {
        console.error(`[ws] ${event} listener threw:`, error)
      }
    }
  }

  close(callback?: () => void): void {
    for (const client of this.clients) (client as { close?: () => void }).close?.()
    this.clients.clear()
    callback?.()
  }
}

export const Server = WebSocketServer
export const Receiver = class {}
export const Sender = class {}

/** `createWebSocketStream` needs a duplex over a socket; there is none here. */
export function createWebSocketStream(): never {
  throw Object.assign(new Error('ws.createWebSocketStream is unavailable in the browser host'), { code: 'ENOSYS' })
}

export default PlatformWebSocket
