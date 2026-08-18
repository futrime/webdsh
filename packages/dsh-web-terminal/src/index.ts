/**
 * The terminal plugin's host half.
 *
 * There is very little for it to do. The runtime this terminal talks to is a
 * browser capability — it runs in the page, not in the host — so the browser
 * half owns the session directly and this row exists to carry it: a
 * `dsh.client` declaration is only read from a package that is *in* the
 * composition, so the client roster needs a host row to hang from.
 *
 * What it does own is the announcement. An agent that does not know the user
 * has a shell in the same workspace will offer to do things the user can
 * simply do, so the surface says so once, in the system prompt, exactly as
 * other capability plugins do.
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
    name: 'web-terminal',
    // After the persona and the runtime context, before anything task-shaped.
    order: 60,
    text:
      'The user has an interactive terminal open on this same workspace, on the '
      + 'same machine your Bash tool runs on. Files you create are visible to them '
      + 'immediately, and files they create are visible to you.',
  })
}

export default { apply, inject }
