/**
 * Buffer/encoding plumbing shared by every shim. The `buffer` npm package is a
 * faithful `Buffer` (a `Uint8Array` subclass), so code doing
 * `Buffer.isBuffer(x)`, `buf.toString('utf8')`, or `Buffer.concat` behaves as it
 * does on Node.
 */

import { Buffer } from 'buffer'

export { Buffer }

/** Everything Node accepts where "file contents" are expected. */
export type BinaryLike = string | Uint8Array | ArrayBuffer | ArrayBufferView

/** Encodings the shims decode; anything else falls back to utf8. */
export type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'base64' | 'base64url' | 'hex' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le'

const encoder = new TextEncoder()

/**
 * Coerce any Node-accepted payload into raw bytes.
 * @param data - the payload.
 * @param encoding - how to decode a string payload (default utf8).
 * @returns a `Uint8Array` view over the bytes.
 */
export function toBytes(data: BinaryLike, encoding: Encoding | string = 'utf8'): Uint8Array {
  if (typeof data === 'string') {
    return encoding === 'utf8' || encoding === 'utf-8'
      ? encoder.encode(data)
      : new Uint8Array(Buffer.from(data, encoding as BufferEncoding))
  }
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Decode bytes with a Node encoding name.
 * @param bytes - the source bytes.
 * @param encoding - the target encoding.
 * @returns the decoded string.
 */
export function toText(bytes: Uint8Array, encoding: Encoding | string = 'utf8'): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding as BufferEncoding)
}

/** Wrap bytes in a `Buffer` without copying. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Normalize Node's `(options | encoding)` argument pattern.
 * @param options - a string encoding, an options object, or nullish.
 * @returns the options object with `encoding` resolved.
 */
export function readOptions(
  options: unknown,
): { encoding?: string, flag?: string, mode?: number, recursive?: boolean, withFileTypes?: boolean, force?: boolean } {
  if (typeof options === 'string') return { encoding: options }
  if (typeof options === 'object' && options !== null) return options as Record<string, never>
  return {}
}
