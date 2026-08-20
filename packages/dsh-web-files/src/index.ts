/**
 * The file browser's host half.
 *
 * As with the terminal, there is very little for it to do: the filesystem this
 * browser draws is a page capability, so the browser half owns it directly and
 * this row exists to carry the `dsh.client` declaration into the composition.
 *
 * What it does own is the announcement. Getting a file *into* a browser tab is
 * the one thing the agent cannot do for the user and cannot guess at — there is
 * no `~/Downloads` here to read from — so the surface says the panel exists,
 * once, in the system prompt, the way other capability plugins do.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Services this row waits for before it applies. */
export const inject = ['systemPrompt']

/**
 * Mount the host half.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const prompt = ctx.get('systemPrompt') as {
    section(options: { name: string, order: number, text: string }): void
  } | undefined
  if (prompt === undefined) return

  prompt.section({
    name: 'web-files',
    // Beside the terminal's section: both describe what the user has open on
    // the same workspace you do.
    order: 61,
    text:
      'The user has a Files panel open on this same workspace: they can browse it, upload '
      + 'files into it from their machine, and take files out of it — one at a time, or a whole '
      + 'directory as a zip. When you need a file they have not given you, ask them to drop it '
      + 'into that panel rather than offering to fetch it; when you produce one for them, say '
      + 'where it is and that they can download it there. Producing a directory of files is a '
      + 'reasonable deliverable here, because they can take the directory in one gesture.',
  })
}

export default { apply, inject }
