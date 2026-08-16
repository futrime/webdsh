/** `node:readline` — the alias target Vite rewrites imports to. */
import { readlineModule as api } from './misc.ts'

export const createInterface = api.createInterface
export const promises = api.promises
export const clearLine = api.clearLine
export const cursorTo = api.cursorTo
export const moveCursor = api.moveCursor

export default api
