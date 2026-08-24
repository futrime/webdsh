/**
 * Image fixtures, as source the browser evaluates.
 *
 * The vision tests need images a canvas cannot draw: a JPEG that carries an
 * EXIF orientation, a PNG that stores sixteen bits per sample, a GIF with more
 * than one frame. Those are container facts, so each fixture is assembled byte
 * by byte — and it is assembled *in the page*, because the thing under test is
 * what the page's own decoder and encoder make of it.
 *
 * Exported as a string for the same reason: `page.evaluate` serializes a
 * function and loses its module scope, so the helpers travel with the call
 * rather than being imported by it.
 */

/** Fixture builders, evaluated inside the page as `globalThis.fixtures`. */
export const FIXTURES_SOURCE = `
globalThis.fixtures = (() => {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    return table
  })()

  function crc32(bytes) {
    let c = 0xffffffff
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  function be32(value) {
    return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }

  function ascii(text) {
    return Uint8Array.from([...text].map(character => character.charCodeAt(0)))
  }

  function pngChunk(name, body) {
    const named = concat([ascii(name), body])
    return concat([be32(body.length), named, be32(crc32(named))])
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  /** A PNG at a chosen bit depth and colour type, filled with a deterministic ramp. */
  async function png(width, height, bitDepth, colourType, extraChunks = []) {
    const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType]
    const bytesPerSample = bitDepth === 16 ? 2 : 1
    const stride = width * samples * bytesPerSample
    const raw = new Uint8Array((stride + 1) * height)
    let at = 0
    for (let y = 0; y < height; y++) {
      raw[at++] = 0
      for (let x = 0; x < width; x++) {
        for (let sample = 0; sample < samples; sample++) {
          const value = sample === 3 ? 255 : (x * 7 + y * 13 + sample * 31) & 255
          if (bitDepth === 16) { raw[at++] = value; raw[at++] = value }
          else raw[at++] = value
        }
      }
    }
    const ihdr = concat([be32(width), be32(height), new Uint8Array([bitDepth, colourType, 0, 0, 0])])
    return concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      ...extraChunks,
      pngChunk('IDAT', await deflate(raw)),
      pngChunk('IEND', new Uint8Array(0)),
    ])
  }

  /** A little-endian TIFF block holding one IFD0 orientation tag. */
  function exifBlock(orientation) {
    const body = new Uint8Array(26)
    const view = new DataView(body.buffer)
    body.set(ascii('II'), 0)
    view.setUint16(2, 42, true)
    view.setUint32(4, 8, true)
    view.setUint16(8, 1, true)          // one entry
    view.setUint16(10, 0x0112, true)    // Orientation
    view.setUint16(12, 3, true)         // SHORT
    view.setUint32(14, 1, true)         // one value
    view.setUint16(18, orientation, true)
    view.setUint32(22, 0, true)         // no next IFD
    return body
  }

  /** Splice an APP1 Exif segment into a JPEG, right after the start-of-image marker. */
  function withExif(jpeg, orientation) {
    const payload = concat([ascii('Exif\\0\\0'), exifBlock(orientation)])
    const length = payload.length + 2
    return concat([
      jpeg.subarray(0, 2),
      new Uint8Array([0xff, 0xe1, (length >> 8) & 255, length & 255]),
      payload,
      jpeg.subarray(2),
    ])
  }

  /** Draw something with structure, so a resize is visible and colours are many. */
  function draw(width, height, alpha) {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, alpha ? 'rgba(220,40,40,0.35)' : '#dc2828')
    gradient.addColorStop(0.5, alpha ? 'rgba(40,220,120,0.75)' : '#28dc78')
    gradient.addColorStop(1, alpha ? 'rgba(40,80,220,0.95)' : '#2850dc')
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
    context.fillStyle = alpha ? 'rgba(255,255,255,0.5)' : '#ffffff'
    context.fillRect(width * 0.1, height * 0.1, width * 0.3, height * 0.3)
    return canvas
  }

  /** Photographic noise, so the low-colour heuristic says no. */
  function noise(width, height) {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    const image = context.createImageData(width, height)
    let seed = 987654321
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      image.data[i] = (seed >> 7) & 255
      image.data[i + 1] = (seed >> 11) & 255
      image.data[i + 2] = (seed >> 15) & 255
      image.data[i + 3] = 255
    }
    context.putImageData(image, 0, 0)
    return canvas
  }

  async function encode(canvas, type, quality) {
    const blob = await canvas.convertToBlob({ type, quality })
    return new Uint8Array(await blob.arrayBuffer())
  }

  /**
   * GIF's LZW stream, emitting every pixel as a literal.
   *
   * A clear code goes out whenever one more dictionary entry would widen the
   * codes, which keeps the whole stream at the starting width and makes the
   * output exactly what a decoder expects without implementing the matcher.
   */
  function lzw(indices, minCodeSize) {
    const clear = 1 << minCodeSize
    const end = clear + 1
    const width = minCodeSize + 1
    const bits = []
    const emit = (code) => { for (let bit = 0; bit < width; bit++) bits.push((code >> bit) & 1) }
    let next = end + 1
    let sinceClear = 0
    emit(clear)
    for (const index of indices) {
      if (next >= (1 << width) - 1) { emit(clear); next = end + 1; sinceClear = 0 }
      emit(index)
      // The first code after a clear adds no dictionary entry.
      if (sinceClear > 0) next++
      sinceClear++
    }
    emit(end)
    const bytes = new Uint8Array(Math.ceil(bits.length / 8))
    for (let bit = 0; bit < bits.length; bit++) bytes[bit >> 3] |= bits[bit] << (bit & 7)
    return bytes
  }

  /** Wrap bytes in GIF's chain of length-prefixed sub-blocks. */
  function subBlocks(bytes) {
    const parts = []
    for (let at = 0; at < bytes.length; at += 255) {
      const slice = bytes.subarray(at, at + 255)
      parts.push(new Uint8Array([slice.length]), slice)
    }
    parts.push(new Uint8Array([0]))
    return concat(parts)
  }

  /** A two-frame animated GIF at 4x4, with a two-entry global colour table. */
  function animatedGif() {
    const size = 4
    const frame = (colourIndex) => concat([
      new Uint8Array([0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00]),
      new Uint8Array([0x2c, 0, 0, 0, 0, size, 0, size, 0, 0]),
      new Uint8Array([2]),
      subBlocks(lzw(new Array(size * size).fill(colourIndex), 2)),
    ])
    return concat([
      ascii('GIF89a'),
      new Uint8Array([size, 0, size, 0, 0x80, 0, 0]),
      new Uint8Array([0xd0, 0x20, 0x20, 0x20, 0x60, 0xd0]),
      new Uint8Array([0x21, 0xff, 0x0b]),
      ascii('NETSCAPE2.0'),
      new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x00]),
      frame(0),
      frame(1),
      new Uint8Array([0x3b]),
    ])
  }

  return { png, pngChunk, withExif, exifBlock, draw, noise, encode, animatedGif, ascii, concat }
})()
`
