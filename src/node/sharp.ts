/**
 * `sharp` over the browser's own image decoder.
 *
 * `dsh-attachment-local` uses sharp for exactly two things: reading an image's
 * format and dimensions, and forcing a full decode to prove the bytes are
 * valid before admitting them. `createImageBitmap` does both — it is the
 * browser's real raster decoder — so image attachments work here rather than
 * being disabled.
 *
 * The container format comes from the magic bytes, because `ImageBitmap`
 * exposes dimensions but not the source format.
 */

/** Metadata `sharp().metadata()` returns, restricted to the fields dsh reads. */
export interface SharpMetadata {
  format?: string
  width: number
  height: number
  channels: number
  space: string
  hasAlpha: boolean
  size: number
}

/** Identify a raster container from its leading bytes. */
function detectFormat(data: Uint8Array): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp'
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp'
  if (data.length >= 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'avif'
  if (data.length >= 4 && data[0] === 0x3c && (data[1] === 0x73 || data[1] === 0x3f)) return 'svg'
  return undefined
}

/** The pipeline object `sharp(data)` returns. */
class SharpImage {
  private bitmap: ImageBitmap | undefined
  private wantsRaw = false

  constructor(private readonly data: Uint8Array) {}

  /** Decode once, reusing the bitmap for later calls. */
  private async decode(): Promise<ImageBitmap> {
    if (this.bitmap !== undefined) return this.bitmap
    const format = detectFormat(this.data)
    if (format === undefined) throw new Error('Input buffer contains unsupported image format')
    const blob = new Blob([this.data as BlobPart], { type: `image/${format}` })
    try {
      this.bitmap = await createImageBitmap(blob)
    } catch (cause) {
      throw new Error('Input buffer has corrupt header', { cause })
    }
    return this.bitmap
  }

  /** `sharp().metadata()`. */
  async metadata(): Promise<SharpMetadata> {
    const format = detectFormat(this.data)
    if (format === undefined) throw new Error('Input buffer contains unsupported image format')
    const bitmap = await this.decode()
    return {
      format,
      width: bitmap.width,
      height: bitmap.height,
      channels: 4,
      space: 'srgb',
      hasAlpha: format === 'png' || format === 'webp' || format === 'gif',
      size: this.data.length,
    }
  }

  /** `sharp().raw()` — marks the pipeline as producing raw pixels. */
  raw(): this {
    this.wantsRaw = true
    return this
  }

  /**
   * `sharp().toBuffer()`. With `raw()`, returns decoded RGBA pixels — which is
   * what makes this a real decode check rather than a header sniff.
   */
  async toBuffer(): Promise<Uint8Array> {
    const bitmap = await this.decode()
    if (!this.wantsRaw) return this.data
    const canvas = typeof OffscreenCanvas === 'undefined'
      ? Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
      : new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = (canvas as OffscreenCanvas).getContext('2d')
    if (context === null) throw new Error('sharp: no 2D context is available to decode this image')
    context.drawImage(bitmap, 0, 0)
    return new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer)
  }

  /** Pipeline verbs dsh does not use, kept so a plugin's chain fails at the operation, not the property. */
  resize(): this { return this }
  rotate(): this { return this }
  png(): this { return this }
  jpeg(): this { return this }
  webp(): this { return this }
  toFile(): never {
    throw new Error('sharp.toFile is unavailable in the browser host')
  }
}

/**
 * `sharp(input, options)`.
 * @param input - encoded image bytes.
 * @returns the pipeline object.
 */
function sharp(input: Uint8Array | ArrayBuffer): SharpImage {
  return new SharpImage(input instanceof Uint8Array ? input : new Uint8Array(input))
}

export default Object.assign(sharp, {
  cache: (): void => {},
  concurrency: (): number => 1,
  simd: (): boolean => false,
  format: {},
  versions: { sharp: 'browser-canvas' },
})
