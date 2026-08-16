/** `node:process`. */
import { process, env } from './process.ts'

export { env }
export const argv = process.argv
export const platform = process.platform
export const cwd = process.cwd
export const nextTick = process.nextTick
export const versions = process.versions
export default process
