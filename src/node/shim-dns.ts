/** `node:dns` — the alias target Vite rewrites imports to. */
import { dnsModule as api } from './misc.ts'

export const promises = api.promises
export const lookup = api.lookup

export default api
