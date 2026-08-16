/** `node:util/types`. */
import { utilModule } from './misc.ts'

const types = utilModule.types
export const {
  isPromise, isDate, isRegExp, isMap, isSet, isTypedArray, isArrayBuffer, isUint8Array,
  isNativeError, isProxy,
} = types
export default types
