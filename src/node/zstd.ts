/**
 * `node:zlib`'s zstd family, over a WebAssembly build.
 *
 * The session log is written with zstd by default, so a host without it has to
 * be configured not to use it — which is a divergence from what `dsh web`
 * writes, and one that shows up as a different file on disk rather than as a
 * missing feature. Implementing the codec removes the divergence instead of
 * documenting it.
 *
 * The wasm module needs an asynchronous init, and Node's `zstdDecompressSync`
 * does not. That is reconcilable because the initialisation is started at boot
 * and finishes long before a session log exists: the synchronous entry points
 * work once it has, and say so plainly if called before — which is a better
 * failure than a silently different file format.
 */

import { init, compress, decompress } from '@bokuweb/zstd-wasm'
import { asBuffer, toBytes, type BinaryLike } from './binary.ts'

/** Whether the codec is ready for the synchronous entry points. */
let ready = false

/** Started once, at boot. */
let starting: Promise<void> | undefined

/**
 * Load the codec.
 *
 * Called during boot so the synchronous faces are usable by the time anything
 * writes a session log; safe to call more than once.
 * @returns when the codec is usable.
 */
export async function initZstd(): Promise<void> {
  starting ??= init().then(() => { ready = true })
  return starting
}

/** Node's default compression level, so files match what `dsh web` writes. */
const DEFAULT_LEVEL = 3

/**
 * Coerce whatever zlib was handed into bytes.
 *
 * Node's zlib accepts a string as readily as a buffer, and the session log
 * passes one — the header line is built with `JSON.stringify` and concatenated.
 * Handing that string to a wasm function expecting bytes does not fail; it
 * produces a frame whose contents are wrong, which surfaces much later as a
 * corrupt log rather than as an error here.
 */
function bytesOf(input: BinaryLike): Uint8Array {
  return typeof input === 'string' ? toBytes(input, 'utf8') : toBytes(input)
}

/** The error a caller gets if it beats the boot. */
function notReady(): never {
  throw new Error('zlib: the zstd codec is still initialising')
}

/**
 * `zlib.zstdCompressSync`.
 * @param data - the bytes to compress.
 * @returns the compressed frame.
 */
export function zstdCompressSync(data: BinaryLike): Buffer {
  if (!ready) notReady()
  return asBuffer(compress(bytesOf(data), DEFAULT_LEVEL))
}

/**
 * `zlib.zstdDecompressSync`.
 * @param data - the frame to decompress.
 * @returns the original bytes.
 */
export function zstdDecompressSync(data: BinaryLike): Buffer {
  if (!ready) notReady()
  return asBuffer(decompress(bytesOf(data)))
}

/** The callback shape Node's asynchronous zlib entry points take. */
type Callback = (error: Error | null, result?: Buffer) => void

/**
 * Run one asynchronous codec call, accepting Node's `(data, options?, callback)`
 * arities and reporting failures the way zlib does.
 * @param args - the caller's arguments.
 * @param run - the codec operation.
 */
function asynchronously(args: unknown[], run: (data: Uint8Array) => Uint8Array): void {
  const callback = args[args.length - 1]
  if (typeof callback !== 'function') return
  const data = bytesOf(args[0] as BinaryLike)
  void initZstd().then(
    () => {
      try {
        ;(callback as Callback)(null, asBuffer(run(data)))
      } catch (error) {
        ;(callback as Callback)(error instanceof Error ? error : new Error(String(error)))
      }
    },
    (error: unknown) => { (callback as Callback)(error instanceof Error ? error : new Error(String(error))) },
  )
}

/**
 * `zlib.zstdCompress`.
 * @param args - `(data, options?, callback)`.
 */
export function zstdCompress(...args: unknown[]): void {
  asynchronously(args, data => compress(data, DEFAULT_LEVEL))
}

/**
 * `zlib.zstdDecompress`.
 * @param args - `(data, options?, callback)`.
 */
export function zstdDecompress(...args: unknown[]): void {
  asynchronously(args, data => decompress(data))
}
