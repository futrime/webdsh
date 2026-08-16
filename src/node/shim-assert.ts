/** `node:assert` — the alias target Vite rewrites imports to. */
import { assertModule as api } from './misc.ts'

export const ok = api.ok
export const equal = api.equal
export const strictEqual = api.strictEqual
export const notStrictEqual = api.notStrictEqual
export const deepStrictEqual = api.deepStrictEqual
export const notDeepStrictEqual = api.notDeepStrictEqual
export const fail = api.fail
export const throws = api.throws
export const doesNotThrow = api.doesNotThrow
export const match = api.match
export const AssertionError = api.AssertionError
export const strict = api.strict

export default api
