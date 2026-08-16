/** `node:stream` — the alias target Vite rewrites imports to. */
import { streamModule as api } from './streams.ts'

export const Readable = api.Readable
export const Writable = api.Writable
export const Duplex = api.Duplex
export const Transform = api.Transform
export const PassThrough = api.PassThrough
export const pipeline = api.pipeline
export const finished = api.finished
export const promises = api.promises

export default api
