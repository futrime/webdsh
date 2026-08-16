/**
 * `node:crypto` — the members dsh and the surveyed community plugins use:
 * `randomUUID`, `randomBytes`, `createHash`, plus an HMAC and the WebCrypto
 * re-export.
 */

import { Buffer, toBytes, type BinaryLike } from './binary.ts'
import { digest, sha256 } from './hash.ts'

/** Node's `Hash`: accumulate with `update`, finish with `digest`. */
export class Hash {
  private readonly chunks: Uint8Array[] = []
  constructor(private readonly algorithm: string) {}

  /**
   * Append data.
   * @param data - bytes or a string.
   * @param encoding - decoding for a string input.
   * @returns this, for chaining.
   */
  update(data: BinaryLike, encoding?: string): this {
    this.chunks.push(toBytes(data, encoding ?? 'utf8'))
    return this
  }

  /**
   * Finish the digest.
   * @param encoding - `hex`, `base64`, … ; omit for a Buffer.
   * @returns the digest.
   */
  digest(encoding?: string): Buffer | string {
    let total = 0
    for (const chunk of this.chunks) total += chunk.length
    const joined = new Uint8Array(total)
    let cursor = 0
    for (const chunk of this.chunks) {
      joined.set(chunk, cursor)
      cursor += chunk.length
    }
    const out = Buffer.from(digest(this.algorithm, joined))
    return encoding === undefined ? out : out.toString(encoding as BufferEncoding)
  }

  /** Node lets a Hash be copied mid-stream; the shim clones the buffered chunks. */
  copy(): Hash {
    const clone = new Hash(this.algorithm)
    for (const chunk of this.chunks) clone.update(chunk)
    return clone
  }
}

/** HMAC over the shim's digests (RFC 2104). */
export class Hmac {
  private readonly chunks: Uint8Array[] = []
  private readonly key: Uint8Array

  constructor(private readonly algorithm: string, key: BinaryLike) {
    const raw = toBytes(key)
    const blockSize = 64
    this.key = raw.length > blockSize ? digest(algorithm, raw) : raw
  }

  update(data: BinaryLike, encoding?: string): this {
    this.chunks.push(toBytes(data, encoding ?? 'utf8'))
    return this
  }

  digest(encoding?: string): Buffer | string {
    const blockSize = 64
    const padded = new Uint8Array(blockSize)
    padded.set(this.key.subarray(0, blockSize))
    const inner = new Uint8Array(blockSize)
    const outer = new Uint8Array(blockSize)
    for (let i = 0; i < blockSize; i++) {
      inner[i] = padded[i] ^ 0x36
      outer[i] = padded[i] ^ 0x5c
    }
    let bodyLength = 0
    for (const chunk of this.chunks) bodyLength += chunk.length
    const innerInput = new Uint8Array(blockSize + bodyLength)
    innerInput.set(inner, 0)
    let cursor = blockSize
    for (const chunk of this.chunks) {
      innerInput.set(chunk, cursor)
      cursor += chunk.length
    }
    const innerDigest = digest(this.algorithm, innerInput)
    const outerInput = new Uint8Array(blockSize + innerDigest.length)
    outerInput.set(outer, 0)
    outerInput.set(innerDigest, blockSize)
    const out = Buffer.from(digest(this.algorithm, outerInput))
    return encoding === undefined ? out : out.toString(encoding as BufferEncoding)
  }
}

/** `crypto.createHash`. */
export function createHash(algorithm: string): Hash {
  return new Hash(algorithm)
}

/** `crypto.createHmac`. */
export function createHmac(algorithm: string, key: BinaryLike): Hmac {
  return new Hmac(algorithm, key)
}

/** `crypto.randomUUID`, delegating to the platform when available. */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `crypto.randomBytes`; the callback form is supported for parity. */
export function randomBytes(size: number, callback?: (error: Error | null, buffer: Buffer) => void): Buffer {
  const bytes = new Uint8Array(size)
  // getRandomValues caps at 65536 bytes per call.
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)))
  }
  const buffer = Buffer.from(bytes)
  if (callback !== undefined) queueMicrotask(() => { callback(null, buffer) })
  return buffer
}

/** `crypto.randomInt`, uniform over `[min, max)`. */
export function randomInt(minOrMax: number, maybeMax?: number): number {
  const min = maybeMax === undefined ? 0 : minOrMax
  const max = maybeMax ?? minOrMax
  const range = max - min
  if (range <= 0) throw new RangeError('max must be greater than min')
  const bytes = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / range) * range
  let value: number
  do {
    crypto.getRandomValues(bytes)
    value = bytes[0]
  } while (value >= limit)
  return min + (value % range)
}

/** `crypto.randomFillSync`. */
export function randomFillSync<T extends Uint8Array>(buffer: T): T {
  crypto.getRandomValues(buffer)
  return buffer
}

/** `crypto.timingSafeEqual`. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** `crypto.createHash('sha256')` shortcut used by the content-addressed stores. */
export function hashSha256Hex(data: BinaryLike): string {
  return Buffer.from(sha256(toBytes(data))).toString('hex')
}

/** `crypto.webcrypto` — the platform object. */
export const webcrypto = typeof crypto === 'undefined' ? undefined : crypto
export const getRandomValues = <T extends ArrayBufferView>(array: T): T => crypto.getRandomValues(array as unknown as Uint8Array) as unknown as T
export const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle
export const constants = { defaultCoreCipherList: '' }

export default {
  Hash, Hmac, createHash, createHmac, randomUUID, randomBytes, randomInt, randomFillSync,
  timingSafeEqual, webcrypto, getRandomValues, subtle, constants,
}
