/** `node:querystring` — the alias target Vite rewrites imports to. */
import { querystringModule as api } from './misc.ts'

export const parse = api.parse
export const stringify = api.stringify
export const escape = api.escape
export const unescape = api.unescape

export default api
