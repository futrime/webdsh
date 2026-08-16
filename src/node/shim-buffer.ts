/** `node:buffer`. */
import { Buffer } from './binary.ts'

export { Buffer }
export const constants = { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 }
export const atob = globalThis.atob.bind(globalThis)
export const btoa = globalThis.btoa.bind(globalThis)
export const isUtf8 = (): boolean => true
export const isAscii = (): boolean => true
export { Blob, File } from './blob-refs.ts'
export default { Buffer, constants, atob, btoa, isUtf8, isAscii }
