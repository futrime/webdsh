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
 *
 * And it says it only where it is true. This deployment can run a session on
 * an emulated PC instead of the container, and on most of those machines there
 * is no terminal to open at all — the panel refuses, because their console is
 * their own screen. Announcing one anyway would put two host sections in the
 * same prompt contradicting each other, which is the failure the machine's own
 * tool row exists to prevent. The runtime is read through the same
 * `globalThis` seam the browser half uses, because a plugin cannot import the
 * app.
 */

import type { Context } from '@deepseek-ai/cordis'

/** What the app publishes about the machine this session runs. */
interface MachineBridge {
  status(): { emulated: boolean, guest?: string }
  guests(): { id: string, name: string, console: string }[]
}

/**
 * What to tell the model about the terminal, given the machine it is on.
 * @returns the section text, or undefined when there is no terminal to announce.
 */
function announcement(): string | undefined {
  const machine = (globalThis as Record<string, unknown>).__DSH_WEB_MACHINE__ as MachineBridge | undefined
  const status = machine?.status()
  if (status === undefined || !status.emulated) {
    return 'The user has an interactive terminal open on this same workspace, running the '
      + 'same runtime and the same shell your own shell tool runs in. Files you create '
      + 'are visible to them immediately, and files they create are visible to you.'
  }
  const guest = machine?.guests().find(entry => entry.id === status.guest)
  // Only a guest with a shell on its serial port has a terminal at all; for
  // the rest the app's own `unavailable()` refuses to open one, and the user
  // watches the machine's screen in the Runtime panel instead.
  if (guest?.console !== 'serial') return undefined
  return `The user can open a terminal on ${guest.name}'s serial console — the same console your `
    + 'shell tool types at, so they see your commands and you see theirs. It is not the browser '
    + 'workspace your file tools read and write; those are two different filesystems.'
}

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
  const text = announcement()
  if (text === undefined) return

  prompt.section({
    name: 'web-terminal',
    // After the persona and the runtime context, before anything task-shaped.
    order: 60,
    text,
  })
}

export default { apply, inject }
