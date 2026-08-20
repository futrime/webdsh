/**
 * The runtime picker's host half.
 *
 * There is almost nothing for it to do. Which machine this session runs on was
 * decided before the host composed — it has to be, because it decides which
 * tools the model is offered — and the machine itself is a page capability, so
 * the browser half owns the screen directly. This row exists to carry the
 * client declaration, because `dsh.client` is only read from a package that is
 * *in* the composition.
 *
 * What it does own is one sentence of orientation. A model that does not know
 * the user is watching the same screen it is typing at will narrate what it is
 * doing instead of doing it — and on an emulated machine, where every action is
 * a keystroke, that is the difference between a session and a commentary.
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
    name: 'web-runtime-picker',
    // Beside the terminal's section: both are about what the user can see.
    order: 61,
    text:
      'The user can open a Runtime panel from the sidebar. It shows which machine this session runs '
      + 'on and lets them change it, and when the machine is an emulated PC the panel is its screen — '
      + 'live, with a working keyboard. So they can watch what you do and take over at any point. '
      + 'Changing the machine takes effect on the next page load, not immediately.',
  })
}

export default { apply, inject }
