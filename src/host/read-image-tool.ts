/**
 * `read_image` for a preset that composes no filesystem tool suite.
 *
 * `dsh-tool-fs` registers `read`, `write`, `edit` *and* `read_image` together,
 * and the `minimal` preset composes none of them: it advertises one shell and
 * one editor, and that is the whole of it. On a machine that is a coherent
 * choice — `str_replace_editor` reads text, and the model that wants a picture
 * is out of luck in a way nobody notices.
 *
 * In this deployment it is not coherent, because this deployment is a page a
 * person drops images into. Switching to 极简模式 quietly took the model's
 * eyes away: it would look for the tool, not find it, and say the image was
 * unavailable — measured, with `read_image` present in every other preset and
 * absent in that one.
 *
 * So the one tool is mounted on its own, without the four that normally come
 * with it. The preset keeps its shape — a shell, an editor, and now the
 * ability to look at a picture, which is not a file-manipulation tool and does
 * not pretend to be one.
 *
 * It is the same shape as `read_image` upstream and deliberately so: the same
 * name, the same `file_path` argument, the same image block beside the same
 * envelope, so a model that has met one has met the other.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { volume } from '../vfs/volume.ts'

/** Services this row waits for before it applies. */
export const inject = ['tools']

/** The row's id in the composition. */
export const name = 'web-read-image'

/** What an extension claims the bytes are. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The durable store an image has to go through to reach a request. */
interface Attachments {
  saveImage(input: { data: Uint8Array, mediaType: string, name?: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/** What one read produces. */
interface Read {
  path: string
  image: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/**
 * Whether the model this call is running on can be shown a picture.
 *
 * Refused up front rather than after the read, because "your model cannot see
 * images" is a different problem from "that file is not there" and a model
 * told the second one will go looking for a file that exists.
 * @param ctx - the row's context.
 * @param exec - the tool-execution context, which knows the calling agent.
 * @returns whether an image block would reach the model.
 */
async function routeSeesImages(ctx: Context, exec: { agent?: unknown, signal: AbortSignal }): Promise<boolean> {
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

/**
 * Mount the row.
 * @param ctx - the preset's context.
 */
export function apply(ctx: Context): void {
  // Only where nothing else has claimed the name. A preset that composes
  // `dsh-tool-fs` already has this tool, and two registrations under one name
  // is a composition error rather than a redundancy.
  const already = (ctx.get('tools') as { has?: (name: string) => boolean } | undefined)?.has?.('read_image')
  if (already === true) return

  ctx.tools.register(defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file from the workspace and return the image itself, so you can '
      + 'look at it. Use this rather than a shell tool: the shell runs on a different machine and cannot '
      + 'reach these files, and a text editor cannot read a picture. Requires the current model to accept '
      + 'image input.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the image file in the workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const read = value as unknown as Read
        const parts: ContentBlock[] = [{
          type: 'text',
          text: `<path>${read.path}</path>\n<type>image</type>\n<content>\n`
            + `${read.image.mediaType} image, ${String(read.image.width)}x${String(read.image.height)} px, `
            + `${String(read.image.bytes)} bytes\n</content>`,
        }]
        parts.push({ type: 'image', attachment: read.image as unknown as ImageBlock['attachment'] })
        return parts
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: { file_path: string }, exec): Promise<Read> {
      const path = args.file_path.trim()
      if (path === '') throw new Error('file_path must be a non-empty string')
      const dot = path.lastIndexOf('.')
      const mediaType = dot === -1 ? undefined : MEDIA_TYPES[path.slice(dot).toLowerCase()]
      if (mediaType === undefined) {
        throw new Error(`cannot read "${path}": read_image only accepts PNG/JPEG/WebP/GIF paths`)
      }
      const attachments = ctx.get('attachments') as Attachments | undefined
      if (attachments === undefined) throw new Error(`cannot read "${path}" as an image: no attachment service is mounted`)
      if (!await routeSeesImages(ctx, exec)) {
        // Which is a fact about how the model is *registered*, not necessarily
        // about the model: a route that publishes no modalities in its own
        // model listing leaves its entries at the text-only default, and this
        // page has no other way to learn better. Saying so is what turns "your
        // model cannot see" into something the user can act on.
        throw new Error(`cannot read "${path}" as an image: the current model is registered as accepting text `
          + 'only; switch to an image-capable model, or — if this one does accept images — declare '
          + '`input: [text, image]` on its entry in Settings → Models, which this page fills in from the '
          + 'route\'s own model listing when the route states it')
      }
      let data: Uint8Array
      try {
        data = volume.readFile(path)
      } catch {
        throw new Error(`cannot read "${path}": no such file in the workspace`)
      }
      const slash = path.lastIndexOf('/')
      const saved = await attachments.saveImage({
        data,
        mediaType,
        name: slash === -1 ? path : path.slice(slash + 1),
      })
      return { path, image: saved }
    },
    presentCall: (args: { file_path: string }) =>
      ({ card: 'generic' as const, title: `Read ${args.file_path}`, kind: 'read' as const }),
  }))
}
