/** `node:tty` — the alias target Vite rewrites imports to. */
import { ttyModule as api } from './misc.ts'

export const isatty = api.isatty
export const ReadStream = api.ReadStream
export const WriteStream = api.WriteStream

export default api
