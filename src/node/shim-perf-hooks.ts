/** `node:perf_hooks` — the alias target Vite rewrites imports to. */
import { perfHooksModule as api } from './misc.ts'

export const performance = api.performance
export const PerformanceObserver = api.PerformanceObserver
export const monitorEventLoopDelay = api.monitorEventLoopDelay

export default api
