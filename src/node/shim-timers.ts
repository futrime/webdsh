/** `node:timers` — the alias target Vite rewrites imports to. */
import { timersModule as api } from './misc.ts'

export const setTimeout = api.setTimeout
export const clearTimeout = api.clearTimeout
export const setInterval = api.setInterval
export const clearInterval = api.clearInterval
export const setImmediate = api.setImmediate
export const clearImmediate = api.clearImmediate

export default api
