/** `node:worker_threads` — the alias target Vite rewrites imports to. */
import { workerThreadsModule as api } from './worker_threads.ts'

export const Worker = api.Worker
export const MessageChannel = api.MessageChannel
export const MessagePort = api.MessagePort
export const BroadcastChannel = api.BroadcastChannel
export const SHARE_ENV = api.SHARE_ENV
export const isMainThread = api.isMainThread
export const parentPort = api.parentPort
export const workerData = api.workerData
export const threadId = api.threadId
export const markAsUntransferable = api.markAsUntransferable
export const moveMessagePortToContext = api.moveMessagePortToContext
export const receiveMessageOnPort = api.receiveMessageOnPort
export const setEnvironmentData = api.setEnvironmentData
export const getEnvironmentData = api.getEnvironmentData

export default api
