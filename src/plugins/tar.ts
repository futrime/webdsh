/**
 * A minimal reader for npm's package tarballs (ustar inside gzip).
 *
 * npm publishes every package as a gzipped tar whose entries are all under a
 * single `package/` prefix, so a full-featured tar implementation is not
 * needed: regular files and directories, plus the PAX/GNU long-name records
 * npm's own packer emits for deeply nested paths.
 */

import { gunzipSync } from 'fflate'

/** One extracted file. */
export interface TarEntry {
  /** Path with the leading `package/` stripped. */
  name: string
  /** File contents. */
  data: Uint8Array
  /** POSIX permission bits. */
  mode: number
}

const BLOCK = 512
const decoder = new TextDecoder()

/** Read a NUL-terminated ASCII field. */
function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end)).trim()
}

/** Parse an octal numeric field. */
function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length)
  return text.length === 0 ? 0 : Number.parseInt(text, 8)
}

/**
 * Extract a `.tgz` into its file entries.
 * @param tgz - the gzipped tarball bytes.
 * @returns every regular file, with the `package/` prefix removed.
 */
export function extractTarball(tgz: Uint8Array): TarEntry[] {
  const tar = gunzipSync(tgz)
  const entries: TarEntry[] = []
  let offset = 0
  /** Pending long name from a GNU `L` or PAX `x` record. */
  let pendingName: string | undefined

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    // Two consecutive zero blocks terminate the archive.
    if (header.every(byte => byte === 0)) break

    const rawName = field(header, 0, 100)
    const mode = octal(header, 100, 8)
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156])
    const prefix = field(header, 345, 155)
    offset += BLOCK

    const dataEnd = offset + size
    const data = tar.subarray(offset, dataEnd)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      // GNU long name: the next header's name comes from this record's body.
      pendingName = decoder.decode(data).replace(/\0+$/, '')
      continue
    }
    if (type === 'x' || type === 'g') {
      // PAX extended header: only `path` matters for npm tarballs.
      const text = decoder.decode(data)
      const match = /\d+ path=([^\n]+)\n/.exec(text)
      if (match !== null) pendingName = match[1]
      continue
    }

    const full = pendingName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName)
    pendingName = undefined
    if (type !== '0' && type !== '' && type !== '7') continue

    // Strip the archive's single root directory, the way `npm` and
    // `tar --strip-components=1` do. It is usually `package/`, but a tarball
    // built from a git host uses `<owner>-<repo>-<sha>/` instead — `ssh2`
    // publishes exactly that — so the segment is removed by position, not name.
    const slash = full.indexOf('/')
    const name = slash === -1 ? full : full.slice(slash + 1)
    if (name.length === 0 || name.endsWith('/')) continue
    entries.push({ name, data: data.slice(), mode: mode === 0 ? 0o644 : mode & 0o777 })
  }

  return entries
}
