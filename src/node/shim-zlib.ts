/** `node:zlib` — the alias target Vite rewrites imports to. */
import { zlibModule as api } from './misc.ts'

export const gzipSync = api.gzipSync
export const gunzipSync = api.gunzipSync
export const deflateSync = api.deflateSync
export const inflateSync = api.inflateSync
export const gzip = api.gzip
export const gunzip = api.gunzip
export const constants = api.constants
export const zstdCompressSync = api.zstdCompressSync
export const zstdDecompressSync = api.zstdDecompressSync
export const zstdCompress = api.zstdCompress
export const zstdDecompress = api.zstdDecompress
export const createZstdCompress = api.createZstdCompress
export const createZstdDecompress = api.createZstdDecompress
export const createGzip = api.createGzip
export const createGunzip = api.createGunzip

export default api
