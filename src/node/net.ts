/**
 * `node:net`. A page cannot open TCP sockets, so the client half fails loudly
 * with `ENOSYS` instead of hanging; the server half exists because
 * `dsh-host-webserver` type-imports `Socket` for its upgrade route signature.
 */

import { SocketShim } from './http.ts'

/** `net.Socket` — construction is allowed (upgrade handlers receive one), connecting is not. */
export class Socket extends SocketShim {
  connect(): never {
    throw Object.assign(new Error('net.Socket.connect is unavailable in the browser host'), { code: 'ENOSYS' })
  }
}

/** `net.createConnection` / `net.connect`. */
export function createConnection(): never {
  throw Object.assign(new Error('net.createConnection is unavailable in the browser host'), { code: 'ENOSYS' })
}

/** `net.createServer` — there is no listener to accept on. */
export function createServer(): never {
  throw Object.assign(new Error('net.createServer is unavailable in the browser host'), { code: 'ENOSYS' })
}

/** `net.isIP` and friends are pure string tests, so they answer normally. */
export function isIPv4(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
}

export function isIPv6(value: string): boolean {
  return value.includes(':')
}

export function isIP(value: string): 0 | 4 | 6 {
  if (isIPv4(value)) return 4
  if (isIPv6(value)) return 6
  return 0
}

export const netModule = {
  Socket, Server: class {}, createConnection, connect: createConnection, createServer,
  isIP, isIPv4, isIPv6,
  default: undefined as unknown,
}
netModule.default = netModule

export default netModule
