/**
 * `sharp` over the browser's own image decoder and encoder.
 *
 * `dsh-attachment-local` is the whole reason this exists: every image a user
 * attaches or a tool returns goes through it, and it uses sharp for real work
 * — auto-orienting from EXIF, capping the long edge, re-encoding at descending
 * quality until the bytes fit a route's budget, and re-reading the result to
 * prove it came out as a single-frame 8-bit sRGB image carrying no metadata.
 * Without that pipeline the page has no vision: the model never sees a pixel.
 *
 * The browser has both halves natively. `createImageBitmap` is a real raster
 * decoder, and a canvas re-encodes to PNG, JPEG and WebP. What it does not
 * have is sharp's honesty about the container — the decoder discards EXIF, ICC
 * and frame counts rather than reporting them — so `metadata()` reads the
 * container directly (`./image-container.ts`), and what the canvas encoder
 * adds on the way out is removed again (`./image-strip.ts`).
 *
 * Two deliberate departures from sharp, both because the browser leaves no
 * choice and both self-consistent across this module:
 *
 * - `hasAlpha` reports whether any pixel is actually transparent, not whether
 *   the container has a channel for it. A canvas writes RGBA PNG whatever it
 *   was given, so channel presence would say "gained transparency" about every
 *   opaque image this module re-encodes, and the caller checks that.
 * - `resize` is a canvas draw. It honours `fit: 'inside'` and
 *   `withoutEnlargement`, and `kernel: 'nearest'` turns off smoothing; the
 *   remaining knobs are resampling quality, which is the browser's to pick.
 */

import { Buffer } from 'buffer'
import { readContainer, type ContainerFacts } from './image-container.ts'
import { stripEncoderMetadata } from './image-strip.ts'

/** Metadata `sharp().metadata()` returns, restricted to the fields dsh reads. */
export interface SharpMetadata {
  format?: string
  width: number
  height: number
  channels: number
  space: string
  depth: string
  hasAlpha: boolean
  size: number
  orientation?: number
  pages?: number
  exif?: Uint8Array
  icc?: true
  xmp?: true
  iptc?: true
  hasProfile?: boolean
  tifftagPhotoshop?: true
  comments?: true
}

/** `info` beside the bytes when `toBuffer` is asked to resolve with an object. */
export interface SharpOutputInfo {
  format: string
  width: number
  height: number
  channels: number
  size: number
  premultiplied: boolean
}

/** The subset of `sharp.ResizeOptions` this build honours. */
export interface ResizeOptions {
  width?: number
  height?: number
  fit?: 'inside' | 'outside' | 'cover' | 'contain' | 'fill'
  withoutEnlargement?: boolean
  kernel?: string
  fastShrinkOnLoad?: boolean
}

/** The output formats a canvas can produce. */
type OutputFormat = 'image/png' | 'image/jpeg' | 'image/webp'

/** Media types keyed by the container signature, for `metadata().format`. */
const CANVAS_QUALITY_DEFAULT = 0.8

/** A canvas of the requested size, wherever this code is running. */
function surface(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas as unknown as OffscreenCanvas
}

/**
 * Encode a canvas, whichever kind of canvas it turned out to be.
 *
 * `convertToBlob` belongs to `OffscreenCanvas`, which Safari did not have until
 * 16.4 — and this build boots on older ones, which is what `scripts/ios-e2e.ts`
 * exists to keep true. The element canvas the fallback above returns answers
 * the same question through `toBlob`, with a callback instead of a promise.
 * @param canvas - the drawn surface.
 * @param type - the media type to produce.
 * @param quality - encoder quality, 0 to 1.
 * @returns the encoded image.
 */
async function encodeCanvas(canvas: OffscreenCanvas, type: string, quality: number): Promise<Blob> {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  const element = canvas as unknown as HTMLCanvasElement
  return new Promise<Blob>((resolve, reject) => {
    element.toBlob(
      blob => (blob === null ? reject(new Error(`sharp: this browser could not encode ${type}`)) : resolve(blob)),
      type,
      quality,
    )
  })
}

/** The 2D context of a canvas, or a readable failure. */
function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const found = canvas.getContext('2d')
  if (found === null) throw new Error('sharp: no 2D context is available to decode this image')
  return found as OffscreenCanvasRenderingContext2D
}

/** Blob type for a container, so `createImageBitmap` picks the right decoder. */
function blobType(facts: ContainerFacts): string {
  return facts.format === undefined ? 'application/octet-stream' : `image/${facts.format}`
}

/**
 * Decode the source.
 *
 * The result is always in display orientation. `createImageBitmap` takes an
 * `imageOrientation: 'none'`, but Chromium applies the EXIF tag regardless —
 * measurably, on a JPEG tagged `6` — so this does not pretend the option
 * works. Callers that want the stored orientation ask {@link unoriented} to
 * put it back.
 * @param data - complete encoded image bytes.
 * @param facts - what the container said, for the decoder hint.
 * @returns the decoded raster.
 */
async function decode(data: Uint8Array, facts: ContainerFacts): Promise<ImageBitmap> {
  if (facts.format === undefined) throw new Error('Input buffer contains unsupported image format')
  const blob = new Blob([data as BlobPart], { type: blobType(facts) })
  try {
    return await createImageBitmap(blob)
  } catch (cause) {
    throw new Error('Input buffer has corrupt header', { cause })
  }
}

/**
 * The affine transform one EXIF orientation names, as canvas matrix terms.
 * @param orientation - the tag value, 1 through 8.
 * @param width - source width.
 * @param height - source height.
 * @returns the six `setTransform` terms.
 */
function orientationMatrix(orientation: number, width: number, height: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0]
    case 3: return [-1, 0, 0, -1, width, height]
    case 4: return [1, 0, 0, -1, 0, height]
    case 5: return [0, 1, 1, 0, 0, 0]
    case 6: return [0, 1, -1, 0, height, 0]
    case 7: return [0, -1, -1, 0, height, width]
    case 8: return [0, -1, 1, 0, 0, width]
    default: return [1, 0, 0, 1, 0, 0]
  }
}

/** Undo an orientation: the tag that maps display back to stored. */
function inverseOrientation(orientation: number): number {
  if (orientation === 6) return 8
  if (orientation === 8) return 6
  return orientation
}

/**
 * Return the raster as the file stores it, undoing what the decoder applied.
 * @param bitmap - the decoded raster, in display orientation.
 * @param orientation - the tag the container carried.
 * @returns a canvas holding the stored orientation, or the bitmap when there
 * is nothing to undo.
 */
function unoriented(bitmap: ImageBitmap, orientation: number): CanvasImageSource {
  if (orientation <= 1) return bitmap
  const inverse = inverseOrientation(orientation)
  const swap = inverse >= 5
  const width = swap ? bitmap.height : bitmap.width
  const height = swap ? bitmap.width : bitmap.height
  const canvas = surface(width, height)
  const context = context2d(canvas)
  context.setTransform(...orientationMatrix(inverse, bitmap.width, bitmap.height))
  context.drawImage(bitmap, 0, 0)
  return canvas as unknown as CanvasImageSource
}

/**
 * The EXIF orientation tag, when the container carries one.
 *
 * Reading it is what makes `rotate()` mean anything: a phone photograph is
 * stored in sensor order with a tag saying which way is up, and an image sent
 * to a model sideways is a wrong answer nobody can see the cause of.
 *
 * This walks the block rather than calling an EXIF library, for a reason
 * specific to this build: every such library asks whether it is running on
 * Node, and this one answers yes — `vite.config.ts` defines
 * `process.versions.node` so the vendored dsh loader takes the right branch.
 * The libraries then `import('fs')` at module scope from a specifier no
 * bundler can rewrite and no browser can resolve, and the rejection is
 * unhandled. What is needed here is one SHORT at a known tag in IFD0, so it is
 * read here instead of importing a parser that cannot load.
 * @param exif - the raw EXIF block the container carried, TIFF header first.
 * @returns the tag value 1–8, or undefined when there is none to read.
 */
function readOrientation(exif: Uint8Array | undefined): number | undefined {
  if (exif === undefined) return undefined
  // Some containers keep the JPEG APP1 introducer on the block they store.
  const block = exif.length >= 6 && exif[0] === 0x45 && exif[1] === 0x78 && exif[2] === 0x69 && exif[3] === 0x66
    ? exif.subarray(6)
    : exif
  if (block.length < 12) return undefined
  const little = block[0] === 0x49 && block[1] === 0x49
  if (!little && !(block[0] === 0x4d && block[1] === 0x4d)) return undefined
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  if (view.getUint16(2, little) !== 42) return undefined
  const directory = view.getUint32(4, little)
  if (directory + 2 > block.length) return undefined
  const entries = view.getUint16(directory, little)
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12
    if (entry + 12 > block.length) return undefined
    if (view.getUint16(entry, little) !== 0x0112) continue
    // Orientation is a single SHORT, so it sits in the value field itself.
    if (view.getUint16(entry + 2, little) !== 3) return undefined
    const value = view.getUint16(entry + 8, little)
    return value >= 1 && value <= 8 ? value : undefined
  }
  return undefined
}

/** Whether any pixel in a drawn canvas is not fully opaque. */
function anyTransparentPixel(pixels: Uint8ClampedArray): boolean {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== 255) return true
  }
  return false
}

/** Output dimensions for a resize request, in sharp's `fit` vocabulary. */
function fitted(width: number, height: number, options: ResizeOptions): { width: number, height: number } {
  const targetWidth = options.width ?? width
  const targetHeight = options.height ?? height
  const fit = options.fit ?? 'cover'
  if (fit === 'fill') return { width: targetWidth, height: targetHeight }
  const ratio = fit === 'outside' || fit === 'cover'
    ? Math.max(targetWidth / width, targetHeight / height)
    : Math.min(targetWidth / width, targetHeight / height)
  const scale = options.withoutEnlargement === true ? Math.min(1, ratio) : ratio
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** One step of a sharp pipeline, replayed on each terminal call. */
interface Operations {
  autoOrient: boolean
  resize?: ResizeOptions
  raw: boolean
  output?: OutputFormat
  quality?: number
}

/** The object `sharp(input)` returns. */
class SharpImage {
  private readonly data: Uint8Array
  private readonly facts: ContainerFacts
  private ops: Operations
  /**
   * The decode, kept.
   *
   * `dsh-attachment-local` reads an image's metadata and then immediately
   * forces a full decode to prove it is sound, and this build answers both
   * from the same decoder. Doing it twice would double the cost of admitting
   * every image a user attaches, for an answer that cannot have changed.
   */
  private decoded: Promise<ImageBitmap> | undefined

  constructor(data: Uint8Array, ops?: Operations) {
    this.data = data
    this.facts = readContainer(data)
    this.ops = ops ?? { autoOrient: false, raw: false }
  }

  /** Decode once per source, however many times the pipeline asks. */
  private async bitmap(): Promise<ImageBitmap> {
    this.decoded ??= decode(this.data, this.facts)
    return this.decoded
  }

  /** `sharp().clone()` — the same source with the operations recorded so far. */
  clone(): SharpImage {
    const copy = new SharpImage(this.data, {
      ...this.ops,
      resize: this.ops.resize === undefined ? undefined : { ...this.ops.resize },
    })
    // The decode belongs to the bytes, not to the operations, and every clone
    // has the same bytes. Normalization tries a size at three qualities from
    // three clones; without this that is three decodes of the same image.
    copy.decoded = this.decoded
    return copy
  }

  /** The EXIF orientation this source carries, `1` when it carries none. */
  private orientation(): number {
    return readOrientation(this.facts.exif) ?? 1
  }

  /**
   * Dimensions as the file stores them.
   *
   * The decoder cannot be asked for these — it orients — so the container is
   * the source, and a decode is the fallback for a file whose header did not
   * state them. `sharp` reports stored dimensions and leaves the transpose to
   * whoever read the orientation beside them.
   * @returns the unrotated width and height.
   */
  private async storedSize(): Promise<{ width: number, height: number }> {
    if (this.facts.width !== undefined && this.facts.height !== undefined
      && this.facts.width > 0 && this.facts.height > 0) {
      return { width: this.facts.width, height: this.facts.height }
    }
    const bitmap = await this.bitmap()
    const swap = this.orientation() >= 5
    return { width: swap ? bitmap.height : bitmap.width, height: swap ? bitmap.width : bitmap.height }
  }

  /** `sharp().metadata()` — container facts plus the stored dimensions. */
  async metadata(): Promise<SharpMetadata> {
    if (this.facts.format === undefined) throw new Error('Input buffer contains unsupported image format')
    const size = await this.storedSize()
    const orientation = readOrientation(this.facts.exif)
    return {
      format: this.facts.format,
      width: size.width,
      height: size.height,
      channels: this.facts.alphaChannel ? 4 : 3,
      space: 'srgb',
      depth: this.facts.depth,
      hasAlpha: this.facts.alphaChannel && await this.hasTransparentPixel(),
      size: this.data.length,
      ...(orientation === undefined ? {} : { orientation }),
      ...(this.facts.pages === undefined ? {} : { pages: this.facts.pages }),
      ...(this.facts.exif === undefined ? {} : { exif: this.facts.exif }),
      ...(this.facts.icc === undefined ? {} : { icc: this.facts.icc, hasProfile: true }),
      ...(this.facts.xmp === undefined ? {} : { xmp: this.facts.xmp }),
      ...(this.facts.iptc === undefined ? {} : { iptc: this.facts.iptc, tifftagPhotoshop: this.facts.iptc }),
      ...(this.facts.comments === undefined ? {} : { comments: this.facts.comments }),
    }
  }

  /** Whether the decoded raster actually uses its alpha channel. */
  private async hasTransparentPixel(): Promise<boolean> {
    const bitmap = await this.bitmap()
    const canvas = surface(bitmap.width, bitmap.height)
    const context = context2d(canvas)
    context.drawImage(bitmap, 0, 0)
    return anyTransparentPixel(context.getImageData(0, 0, bitmap.width, bitmap.height).data)
  }

  /** `sharp().rotate()` — with no angle, apply the EXIF orientation. */
  rotate(angle?: number): this {
    if (angle !== undefined && angle % 360 !== 0) {
      throw new Error('sharp: only EXIF auto-orientation is available in the browser host')
    }
    this.ops.autoOrient = true
    return this
  }

  /** `sharp().toColourspace()` — a canvas is sRGB, which is the only target dsh asks for. */
  toColourspace(space: string): this {
    if (space !== 'srgb' && space !== 'rgb') {
      throw new Error(`sharp: the browser host renders in sRGB; "${space}" is unavailable`)
    }
    return this
  }

  /** `sharp().resize()`. */
  resize(options: ResizeOptions): this {
    this.ops.resize = options
    return this
  }

  /** `sharp().raw()` — the pipeline produces decoded RGBA pixels. */
  raw(): this {
    this.ops.raw = true
    return this
  }

  /** `sharp().png()`. */
  png(): this {
    this.ops.output = 'image/png'
    this.ops.quality = undefined
    return this
  }

  /** `sharp().jpeg()`. */
  jpeg(options?: { quality?: number }): this {
    this.ops.output = 'image/jpeg'
    this.ops.quality = options?.quality
    return this
  }

  /** `sharp().webp()`. */
  webp(options?: { quality?: number }): this {
    this.ops.output = 'image/webp'
    this.ops.quality = options?.quality
    return this
  }

  /** Decode, orient and resize, leaving the result on a canvas. */
  private async render(): Promise<OffscreenCanvas> {
    const bitmap = await this.bitmap()
    // The decoder oriented it. `rotate()` asked for exactly that; without it,
    // sharp would have handed back the stored pixels, so they are restored.
    const source = this.ops.autoOrient ? bitmap : unoriented(bitmap, this.orientation())
    const sourceWidth = source === bitmap ? bitmap.width : (source as OffscreenCanvas).width
    const sourceHeight = source === bitmap ? bitmap.height : (source as OffscreenCanvas).height
    const size = this.ops.resize === undefined
      ? { width: sourceWidth, height: sourceHeight }
      : fitted(sourceWidth, sourceHeight, this.ops.resize)
    const canvas = surface(size.width, size.height)
    const context = context2d(canvas)
    // `nearest` is asked for when the caller is sampling colours rather than
    // producing an image, and interpolation would invent ones that are not there.
    if (this.ops.resize?.kernel === 'nearest') context.imageSmoothingEnabled = false
    context.drawImage(source, 0, 0, size.width, size.height)
    return canvas
  }

  /** `sharp().toBuffer()`, with and without `resolveWithObject`. */
  async toBuffer(options?: { resolveWithObject?: boolean }): Promise<Buffer | { data: Buffer, info: SharpOutputInfo }> {
    const withObject = options?.resolveWithObject === true
    if (!this.ops.raw && this.ops.output === undefined) {
      // sharp re-encodes to the input format; with no operation recorded the
      // bytes are the answer, and dsh only reaches this after `raw()`.
      const passthrough = Buffer.from(this.data)
      if (!withObject) return passthrough
      const size = await this.storedSize()
      return {
        data: passthrough,
        info: {
          format: this.facts.format ?? 'unknown',
          width: size.width,
          height: size.height,
          channels: this.facts.alphaChannel ? 4 : 3,
          size: passthrough.length,
          premultiplied: false,
        },
      }
    }

    const canvas = await this.render()
    if (this.ops.raw) {
      const pixels = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data
      const data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      if (!withObject) return data
      return {
        data,
        info: { format: 'raw', width: canvas.width, height: canvas.height, channels: 4, size: data.length, premultiplied: false },
      }
    }

    const type = this.ops.output ?? 'image/png'
    const quality = this.ops.quality === undefined ? CANVAS_QUALITY_DEFAULT : this.ops.quality / 100
    const blob = await encodeCanvas(canvas, type, quality)
    if (blob.type !== type) {
      throw new Error(`sharp: this browser cannot encode ${type} (it produced ${blob.type})`)
    }
    const encoded = stripEncoderMetadata(new Uint8Array(await blob.arrayBuffer()), type)
    const data = Buffer.from(encoded)
    if (!withObject) return data
    return {
      data,
      info: {
        format: type.slice('image/'.length),
        width: canvas.width,
        height: canvas.height,
        channels: type === 'image/jpeg' ? 3 : 4,
        size: data.length,
        premultiplied: false,
      },
    }
  }

  /** `sharp().toFile()` — there is no file to write to. */
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
  kernel: {
    nearest: 'nearest',
    cubic: 'cubic',
    mitchell: 'mitchell',
    lanczos2: 'lanczos2',
    lanczos3: 'lanczos3',
  },
  fit: {
    contain: 'contain',
    cover: 'cover',
    fill: 'fill',
    inside: 'inside',
    outside: 'outside',
  },
  format: {},
  versions: { sharp: 'browser-canvas' },
})
