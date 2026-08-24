/**
 * What an encoded raster's container says about itself, without decoding it.
 *
 * `dsh-attachment-local` asks sharp four questions a decoder cannot answer,
 * because the answers are container facts rather than pixel facts: how many
 * bits per sample the file stores, whether it carries an alpha channel at all,
 * whether it holds more than one frame, and whether it carries retained
 * metadata — EXIF, ICC, XMP, IPTC or a comment. That last one decides whether
 * an image may be handed to a model byte-for-byte, so under-reporting it would
 * forward a photograph's GPS coordinates; the browser's decoder discards all of
 * it and would report nothing.
 *
 * So the four containers dsh admits are read here directly. Dimensions are not
 * among the questions: `createImageBitmap` answers those, and it is the same
 * decoder that will produce the pixels.
 */

/** Which retained-metadata blocks a container carries. */
export interface ContainerMetadata {
  exif?: Uint8Array
  icc?: true
  xmp?: true
  iptc?: true
  comments?: true
}

/** Everything read out of the container header. */
export interface ContainerFacts extends ContainerMetadata {
  /** Container as sharp names it, or undefined when the bytes are not a raster this build admits. */
  format?: 'png' | 'jpeg' | 'webp' | 'gif'
  /**
   * Dimensions as the container stores them, before any EXIF orientation.
   *
   * Not a convenience: the browser's decoder applies the orientation tag and
   * offers no way to ask it not to, so the stored dimensions are only
   * knowable from the header. `sharp().metadata()` reports them unrotated and
   * leaves the transpose to its caller, and that caller subtracts the wrong
   * thing if these come back already rotated.
   */
  width?: number
  height?: number
  /** Sample depth, in sharp's vocabulary. */
  depth: 'uchar' | 'ushort'
  /** Whether the container stores an alpha channel (not whether any pixel uses it). */
  alphaChannel: boolean
  /** Frame count, when the container states or implies more than one. */
  pages?: number
}

/** Read a big-endian 16-bit integer. */
function be16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1]
}

/** Read a little-endian 24-bit integer. */
function le24(data: Uint8Array, offset: number): number {
  return (data[offset + 2] << 16) | (data[offset + 1] << 8) | data[offset]
}

/** Read a big-endian 32-bit integer. */
function be32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
}

/** Read a little-endian 32-bit integer. */
function le32(data: Uint8Array, offset: number): number {
  return ((data[offset + 3] << 24) | (data[offset + 2] << 16) | (data[offset + 1] << 8) | data[offset]) >>> 0
}

/** Read `length` bytes as Latin-1, for the ASCII tags containers use as keys. */
function tag(data: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let index = 0; index < length && offset + index < data.length; index += 1) {
    out += String.fromCharCode(data[offset + index])
  }
  return out
}

/** Whether `data` starts with the given byte sequence at `offset`. */
function startsWith(data: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (offset + signature.length > data.length) return false
  return signature.every((byte, index) => data[offset + index] === byte)
}

/** PNG: walk the chunk list. */
function readPng(data: Uint8Array): ContainerFacts {
  const facts: ContainerFacts = { format: 'png', depth: 'uchar', alphaChannel: false }
  let offset = 8
  while (offset + 8 <= data.length) {
    const length = be32(data, offset)
    const name = tag(data, offset + 4, 4)
    const body = offset + 8
    if (name === 'IHDR' && body + 10 <= data.length) {
      facts.width = be32(data, body)
      facts.height = be32(data, body + 4)
      const bitDepth = data[body + 8]
      const colourType = data[body + 9]
      facts.depth = bitDepth === 16 ? 'ushort' : 'uchar'
      facts.alphaChannel = colourType === 4 || colourType === 6
    } else if (name === 'tRNS') {
      facts.alphaChannel = true
    } else if (name === 'eXIf') {
      facts.exif = data.subarray(body, body + length)
    } else if (name === 'iCCP') {
      facts.icc = true
    } else if (name === 'acTL' && body + 4 <= data.length) {
      facts.pages = Math.max(2, be32(data, body))
    } else if (name === 'iTXt' || name === 'tEXt' || name === 'zTXt') {
      // The XMP packet is an iTXt keyed `XML:com.adobe.xmp`; every other
      // textual chunk is a comment as far as sharp's metadata is concerned.
      if (tag(data, body, 17) === 'XML:com.adobe.xmp') facts.xmp = true
      else facts.comments = true
    }
    if (name === 'IEND') break
    // 4 length + 4 name + body + 4 CRC. A length that overruns the buffer is a
    // truncated file: stop rather than walk off into arbitrary offsets.
    const next = offset + 12 + length
    if (next <= offset || next > data.length) break
    offset = next
  }
  return facts
}

/** JPEG: walk the marker segments up to the start of scan. */
function readJpeg(data: Uint8Array): ContainerFacts {
  const facts: ContainerFacts = { format: 'jpeg', depth: 'uchar', alphaChannel: false }
  let offset = 2
  while (offset + 4 <= data.length && data[offset] === 0xff) {
    const marker = data[offset + 1]
    // SOS begins entropy-coded data, and EOI ends the image; neither carries a
    // length this walk can step over.
    if (marker === 0xda || marker === 0xd9) break
    const length = (data[offset + 2] << 8) | data[offset + 3]
    const body = offset + 4
    if (marker === 0xe1) {
      if (tag(data, body, 6) === 'Exif\0\0') facts.exif = data.subarray(body + 6, offset + 2 + length)
      else if (tag(data, body, 28) === 'http://ns.adobe.com/xap/1.0/') facts.xmp = true
    } else if (marker === 0xe2 && tag(data, body, 12) === 'ICC_PROFILE\0') {
      facts.icc = true
    } else if (marker === 0xed) {
      // Photoshop's APP13 resource block; IPTC lives inside it, and sharp
      // reports both the IPTC payload and the Photoshop TIFF tag from it.
      facts.iptc = true
    } else if (marker === 0xfe) {
      facts.comments = true
    } else if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (data[body] > 8) facts.depth = 'ushort'
      // The frame header states height before width.
      facts.height = be16(data, body + 1)
      facts.width = be16(data, body + 3)
    }
    const next = offset + 2 + length
    if (next <= offset || next > data.length) break
    offset = next
  }
  return facts
}

/** WebP: walk the RIFF chunks. */
function readWebp(data: Uint8Array): ContainerFacts {
  const facts: ContainerFacts = { format: 'webp', depth: 'uchar', alphaChannel: false }
  let offset = 12
  while (offset + 8 <= data.length) {
    const name = tag(data, offset, 4)
    const length = le32(data, offset + 4)
    const body = offset + 8
    if (name === 'VP8X' && body + 10 <= data.length) {
      facts.width = le24(data, body + 4) + 1
      facts.height = le24(data, body + 7) + 1
      // Flags, most significant bit first: two reserved, ICC, alpha, EXIF,
      // XMP, animation, reserved.
      const flags = data[body]
      if ((flags & 0x20) !== 0) facts.icc = true
      if ((flags & 0x10) !== 0) facts.alphaChannel = true
      if ((flags & 0x02) !== 0) facts.pages = 2
    } else if (name === 'ALPH') {
      facts.alphaChannel = true
    } else if (name === 'VP8L' && body + 5 <= data.length) {
      // After the 0x2f signature the header packs a 14-bit width, a 14-bit
      // height, then the alpha-used bit, little-endian and least significant
      // bit first.
      const packed = (data[body + 4] << 24) | (data[body + 3] << 16) | (data[body + 2] << 8) | data[body + 1]
      facts.width ??= (packed & 0x3fff) + 1
      facts.height ??= ((packed >>> 14) & 0x3fff) + 1
      if ((packed & 0x10000000) !== 0) facts.alphaChannel = true
    } else if (name === 'VP8 ' && body + 10 <= data.length
      && data[body + 3] === 0x9d && data[body + 4] === 0x01 && data[body + 5] === 0x2a) {
      // A lossy keyframe: three bytes of frame tag, the sync code, then two
      // little-endian words whose low fourteen bits are the dimensions.
      facts.width ??= (data[body + 6] | (data[body + 7] << 8)) & 0x3fff
      facts.height ??= (data[body + 8] | (data[body + 9] << 8)) & 0x3fff
    } else if (name === 'ANIM' || name === 'ANMF') {
      facts.pages = 2
    } else if (name === 'EXIF') {
      facts.exif = data.subarray(body, body + length)
    } else if (name === 'ICCP') {
      facts.icc = true
    } else if (name === 'XMP ') {
      facts.xmp = true
    }
    // RIFF chunks are padded to an even length.
    const next = body + length + (length % 2)
    if (next <= offset || next > data.length) break
    offset = next
  }
  return facts
}

/** GIF: walk the block stream far enough to count frames and see transparency. */
function readGif(data: Uint8Array): ContainerFacts {
  const facts: ContainerFacts = {
    format: 'gif',
    depth: 'uchar',
    alphaChannel: false,
    width: data[6] | (data[7] << 8),
    height: data[8] | (data[9] << 8),
  }
  let offset = 13
  // A global colour table, when present, precedes the first block.
  if ((data[10] & 0x80) !== 0) offset += 3 * (2 ** ((data[10] & 0x07) + 1))
  let frames = 0
  /** Step over a chain of length-prefixed sub-blocks. */
  const skipSubBlocks = (start: number): number => {
    let at = start
    while (at < data.length && data[at] !== 0) at += data[at] + 1
    return at + 1
  }
  while (offset < data.length) {
    const block = data[offset]
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = data[offset + 1]
      if (label === 0xf9 && offset + 3 < data.length && (data[offset + 3] & 0x01) !== 0) facts.alphaChannel = true
      if (label === 0xfe) facts.comments = true
      if (label === 0xff && tag(data, offset + 3, 11) === 'XMP DataXMP') facts.xmp = true
      // Every extension is a label followed by one sub-block chain, so the
      // fixed-size block a graphic-control or application extension carries is
      // just that chain's first sub-block and needs no special step.
      offset = skipSubBlocks(offset + 2)
      continue
    }
    if (block === 0x2c) {
      frames += 1
      if (offset + 9 >= data.length) break
      let at = offset + 10
      if ((data[offset + 9] & 0x80) !== 0) at += 3 * (2 ** ((data[offset + 9] & 0x07) + 1))
      // One LZW minimum-code-size byte, then the image's sub-block chain.
      offset = skipSubBlocks(at + 1)
      continue
    }
    break
  }
  if (frames > 1) facts.pages = frames
  return facts
}

/**
 * Read what the container states about itself.
 * @param data - complete encoded image bytes.
 * @returns the container facts; `format` is undefined when the bytes are not a
 * raster in a container this build admits.
 */
export function readContainer(data: Uint8Array): ContainerFacts {
  if (startsWith(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return readPng(data)
  if (startsWith(data, 0, [0xff, 0xd8, 0xff])) return readJpeg(data)
  if (startsWith(data, 0, [0x52, 0x49, 0x46, 0x46]) && tag(data, 8, 4) === 'WEBP') return readWebp(data)
  if (tag(data, 0, 6) === 'GIF87a' || tag(data, 0, 6) === 'GIF89a') return readGif(data)
  return { depth: 'uchar', alphaChannel: false }
}
