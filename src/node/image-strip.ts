/**
 * Remove the metadata the browser's encoder adds on its way out.
 *
 * `sharp` writes no metadata unless asked, and `dsh-attachment-local` depends
 * on that: it re-encodes an image precisely to drop whatever the source
 * carried, then verifies the result carries none. Chromium's canvas encoder
 * does not offer the choice — every JPEG it produces has an `ICC_PROFILE`
 * APP2 segment and every WebP an `ICCP` chunk, both tagging the sRGB the
 * pixels were already in.
 *
 * Left alone, that profile makes the normalized output fail its own
 * verification, and normalization is what strips a photograph's EXIF. So the
 * profile is removed here rather than tolerated: it says nothing the pixels do
 * not, and dropping it is what makes the guarantee upstream states hold.
 */

/** Read a little-endian 32-bit integer. */
function le32(data: Uint8Array, offset: number): number {
  return ((data[offset + 3] << 24) | (data[offset + 2] << 16) | (data[offset + 1] << 8) | data[offset]) >>> 0
}

/** Write a little-endian 32-bit integer. */
function writeLe32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff
  data[offset + 1] = (value >>> 8) & 0xff
  data[offset + 2] = (value >>> 16) & 0xff
  data[offset + 3] = (value >>> 24) & 0xff
}

/** Read `length` bytes as Latin-1. */
function tag(data: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let index = 0; index < length && offset + index < data.length; index += 1) {
    out += String.fromCharCode(data[offset + index])
  }
  return out
}

/** Join byte ranges into one buffer. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Drop every APP2 `ICC_PROFILE` segment from a JPEG. */
function stripJpeg(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [data.subarray(0, 2)]
  let offset = 2
  let removed = false
  while (offset + 4 <= data.length && data[offset] === 0xff) {
    const marker = data[offset + 1]
    if (marker === 0xda || marker === 0xd9) break
    const length = (data[offset + 2] << 8) | data[offset + 3]
    const next = offset + 2 + length
    if (next <= offset || next > data.length) break
    if (marker === 0xe2 && tag(data, offset + 4, 12) === 'ICC_PROFILE\0') removed = true
    else parts.push(data.subarray(offset, next))
    offset = next
  }
  if (!removed) return data
  parts.push(data.subarray(offset))
  return concat(parts)
}

/** Drop the `ICCP` chunk from a WebP and clear the flag that announces it. */
function stripWebp(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let offset = 12
  let removed = false
  while (offset + 8 <= data.length) {
    const name = tag(data, offset, 4)
    const length = le32(data, offset + 4)
    // RIFF chunks are padded to an even length.
    const next = offset + 8 + length + (length % 2)
    if (next <= offset || next > data.length) {
      chunks.push(data.subarray(offset))
      offset = data.length
      break
    }
    if (name === 'ICCP') {
      removed = true
    } else {
      const chunk = data.subarray(offset, next)
      if (name === 'VP8X' && chunk.length > 8) {
        // The extended header's flag byte announces which optional chunks
        // follow; leaving the ICC bit set over a removed chunk is a malformed
        // file, so it is cleared with the chunk it describes.
        const copy = chunk.slice()
        copy[8] &= ~0x20
        chunks.push(copy)
        offset = next
        continue
      }
      chunks.push(chunk)
    }
    offset = next
  }
  if (!removed) return data
  const body = concat(chunks)
  const out = new Uint8Array(12 + body.length)
  out.set(data.subarray(0, 12))
  out.set(body, 12)
  // The RIFF size field counts everything after it, so it shrinks with the file.
  writeLe32(out, 4, out.length - 8)
  return out
}

/**
 * Return the same image without encoder-added metadata.
 * @param data - freshly encoded image bytes.
 * @param mediaType - the type the encoder produced.
 * @returns the stripped bytes, or the input when it carried none.
 */
export function stripEncoderMetadata(data: Uint8Array, mediaType: string): Uint8Array {
  if (mediaType === 'image/jpeg') return stripJpeg(data)
  if (mediaType === 'image/webp') return stripWebp(data)
  // Chromium's PNG encoder writes IHDR, IDAT and IEND, and nothing else.
  return data
}
