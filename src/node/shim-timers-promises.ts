/** `node:timers/promises` — the alias target Vite rewrites imports to. */
import { timersPromisesModule as api } from './misc.ts'

export const setTimeout = api.setTimeout
export const setImmediate = api.setImmediate
export const setInterval = api.setInterval
export const scheduler = api.scheduler

export default api
