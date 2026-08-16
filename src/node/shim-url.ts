/** `node:url` — the alias target Vite rewrites imports to. */
import { urlModule as api } from './misc.ts'

export const URL = api.URL
export const URLSearchParams = api.URLSearchParams
export const fileURLToPath = api.fileURLToPath
export const pathToFileURL = api.pathToFileURL
export const format = api.format
export const parse = api.parse
export const resolve = api.resolve
export const domainToASCII = api.domainToASCII
export const domainToUnicode = api.domainToUnicode

export default api
