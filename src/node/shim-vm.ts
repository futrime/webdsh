/** `node:vm` — the alias target Vite rewrites imports to. */
import { vmModule as api } from './misc.ts'

export const runInNewContext = api.runInNewContext
export const runInThisContext = api.runInThisContext
export const runInContext = api.runInContext
export const createContext = api.createContext
export const Script = api.Script

export default api
