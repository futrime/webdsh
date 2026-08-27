/**
 * What a machine's screen has to survive on its way to the model.
 *
 * Two machines take pictures — the emulated PC in `src/host/vm-tools.ts` and
 * the browser in `src/host/browser-tools.ts` — and both hit the same two
 * facts, so both read them from here rather than each keeping a copy.
 *
 * The first is that not every route accepts an image. Most of the free routes
 * this build registers do not, and a tool that attached one anyway would send
 * a request the provider rejects — so the picture is offered only where it can
 * be looked at, and where it cannot the file on disk is the whole answer.
 *
 * The second is that a picture larger than the request's pixel budget is
 * resized on the way into the request by a layer neither tool can see the
 * output of. That matters more than it sounds: a tool that reports "1280×800"
 * while the model is looking at 894×559 has told it that a pixel it can see is
 * a pixel the machine has, and every coordinate read off that picture is a
 * fifth short. So the resize happens here, where the numbers can be reported
 * honestly.
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The most pixels a picture may carry to the model.
 *
 * Not a preference: it is the request-image budget dsh's own adapters apply —
 * `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` in `dsh-llm-deepseek`.
 */
export const REQUEST_PIXEL_BUDGET = 640_000

/** The attachment store, when one is mounted. */
export interface Attachments {
  saveImage(input: { data: Uint8Array, mediaType: string, name?: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/**
 * Whether the model this call is running on can be shown a picture.
 *
 * Asked rather than assumed, because it decides between two different results:
 * one that hands the screen over and one that can only say where it was saved.
 * A route that does not declare image input is not a failure, so this returns
 * false rather than throwing.
 * @param ctx - the row's context.
 * @param exec - the tool-execution context, which knows the calling agent.
 * @returns whether an image block would reach the model.
 */
export async function routeSeesImages(
  ctx: Context,
  exec: { agent?: unknown, signal: AbortSignal },
): Promise<boolean> {
  try {
    const agent = exec.agent as {
      session?: { requestHeader?: () => { config?: { provider?: string, model?: string } } | undefined }
      options?: { provider?: string, model?: string }
    } | undefined
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    const llm = ctx.get('llm') as {
      resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: string[] }>
    } | undefined
    if (provider === undefined || model === undefined || llm === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** A picture after it has been brought within the budget. */
export interface Fitted {
  bytes: Uint8Array
  width: number
  height: number
  /** Picture pixels per source pixel, absent when it was not resized. */
  scale?: number
}

/**
 * Bring a picture within the request's pixel budget.
 *
 * `fit: 'inside'` keeps the aspect ratio, so one number describes the whole
 * mapping and the tool can print the arithmetic rather than a warning.
 * @param bytes - the PNG.
 * @param width - its width.
 * @param height - its height.
 * @returns the picture, resized only if it had to be.
 */
export async function fitToBudget(bytes: Uint8Array, width: number, height: number): Promise<Fitted> {
  if (width * height <= REQUEST_PIXEL_BUDGET) return { bytes, width, height }
  const ratio = Math.sqrt(REQUEST_PIXEL_BUDGET / (width * height))
  const { default: sharp } = await import('../node/sharp.ts')
  const shrunk = await sharp(bytes)
    .resize({
      width: Math.max(1, Math.floor(width * ratio)),
      height: Math.max(1, Math.floor(height * ratio)),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true }) as { data: Buffer, info: { width: number, height: number } }
  return {
    bytes: new Uint8Array(shrunk.data),
    width: shrunk.info.width,
    height: shrunk.info.height,
    scale: Number((shrunk.info.width / width).toFixed(4)),
  }
}
