/** `node:dns/promises`. */
import { dnsModule } from './misc.ts'

export const lookup = dnsModule.promises.lookup
export const resolve4 = dnsModule.promises.resolve4
export const resolve6 = dnsModule.promises.resolve6
export default dnsModule.promises
