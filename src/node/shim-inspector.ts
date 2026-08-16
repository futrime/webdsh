/** `node:inspector` — no debug protocol exists in a page. */
export const open = (): void => {}
export const close = (): void => {}
export const url = (): undefined => undefined
export const Session = class {}
export default { open, close, url, Session }
