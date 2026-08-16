/** `node:diagnostics_channel` — an inert channel registry. */
const inert = { hasSubscribers: false, publish: (): void => {}, subscribe: (): void => {}, unsubscribe: (): void => {} }
export const channel = (): typeof inert => inert
export const hasSubscribers = (): boolean => false
export const subscribe = (): void => {}
export const unsubscribe = (): void => {}
export const tracingChannel = (): Record<string, unknown> => ({ start: inert, end: inert, asyncStart: inert, asyncEnd: inert, error: inert })
export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel }
