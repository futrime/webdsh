/** `node:cluster` — a page is always the primary and cannot fork. */
export const isPrimary = true
export const isMaster = true
export const isWorker = false
export const workers: Record<string, never> = {}
export const fork = (): never => {
  throw Object.assign(new Error('cluster.fork is unavailable in the browser host'), { code: 'ENOSYS' })
}
export default { isPrimary, isMaster, isWorker, workers, fork }
