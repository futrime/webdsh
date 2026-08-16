/** `node:punycode` — deprecated upstream; identity transforms suffice here. */
export const toASCII = (value: string): string => value
export const toUnicode = (value: string): string => value
export const encode = (value: string): string => value
export const decode = (value: string): string => value
export default { toASCII, toUnicode, encode, decode }
