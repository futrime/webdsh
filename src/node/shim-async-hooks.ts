/** `node:async_hooks` — the alias target Vite rewrites imports to. */
import { asyncHooksModule as api } from './misc.ts'

export const AsyncLocalStorage = api.AsyncLocalStorage
export const AsyncResource = api.AsyncResource
export const executionAsyncId = api.executionAsyncId
export const triggerAsyncId = api.triggerAsyncId
export const createHook = api.createHook

export default api
