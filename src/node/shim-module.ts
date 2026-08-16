/** `node:module` — the alias target Vite rewrites imports to. */
import { moduleModule as api } from './misc.ts'

export const createRequire = api.createRequire
export const builtinModules = api.builtinModules
export const isBuiltin = api.isBuiltin
export const register = api.register
export const syncBuiltinESMExports = api.syncBuiltinESMExports
export const findSourceMap = api.findSourceMap
export const Module = api.Module
export const stripTypeScriptTypes = api.stripTypeScriptTypes
export const SourceMap = api.SourceMap
export const constants = api.constants
export const enableCompileCache = api.enableCompileCache
export const getCompileCacheDir = api.getCompileCacheDir
export const flushCompileCache = api.flushCompileCache
export const runMain = api.runMain
export const wrap = api.wrap

export default api
