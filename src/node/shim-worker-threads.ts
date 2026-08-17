/**
 * `node:worker_threads` — the alias target Vite rewrites imports to.
 *
 * The four thread-identity names are re-exported rather than copied. Reading
 * them off the module object here — `export const parentPort = api.parentPort` —
 * runs the getter once, when this file is first evaluated, which is always
 * before any worker exists: every importer would then see `null` forever and a
 * worker entry checking `parentPort` would conclude it was on the main thread
 * and refuse to run. `export … from` forwards the live binding instead.
 */
import { workerThreadsModule as api } from './worker_threads.ts'

export {
  Worker,
  MessageChannelShim as MessageChannel,
  NodeMessagePort as MessagePort,
  SHARE_ENV,
  // Live bindings, re-assigned for the duration of a worker entry's body.
  isMainThread,
  parentPort,
  workerData,
  threadId,
} from './worker_threads.ts'

export const BroadcastChannel = api.BroadcastChannel
export const markAsUntransferable = api.markAsUntransferable
export const moveMessagePortToContext = api.moveMessagePortToContext
export const receiveMessageOnPort = api.receiveMessageOnPort
export const setEnvironmentData = api.setEnvironmentData
export const getEnvironmentData = api.getEnvironmentData

export default api
