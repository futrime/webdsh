/** `node:util` — the alias target Vite rewrites imports to. */
import { utilModule as api } from './misc.ts'

export const inspect = api.inspect
export const format = api.format
export const promisify = api.promisify
export const callbackify = api.callbackify
export const isDeepStrictEqual = api.isDeepStrictEqual
export const parseArgs = api.parseArgs
export const parseEnv = api.parseEnv
export const deprecate = api.deprecate
export const stripVTControlCharacters = api.stripVTControlCharacters
export const styleText = api.styleText
export const toUSVString = api.toUSVString
export const formatWithOptions = api.formatWithOptions
export const TextEncoder = api.TextEncoder
export const TextDecoder = api.TextDecoder
export const types = api.types
export const inherits = api.inherits

export default api
