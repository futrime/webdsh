/**
 * The machine plugin's host half.
 *
 * There is very little for it to do. Which machine this session runs on was
 * decided before the host composed — it has to be, because it decides which
 * tools the model is offered — and the machine itself is a page capability, so
 * the browser half owns both the screen and the terminal directly. This row
 * exists to carry the client declaration, because `dsh.client` is only read
 * from a package that is *in* the composition.
 *
 * What it does own is the orientation. A model that does not know the user is
 * watching the same machine will narrate what it is doing instead of doing it,
 * and on an emulated PC — where every action is a keystroke — that is the
 * difference between a session and a commentary. It says only what is true of
 * the machine this session actually got: a container has a shell the user
 * shares, most emulated guests have a screen and no terminal at all, and
 * announcing the wrong one puts two contradicting sections in the same prompt.
 * The machine is read through the same `globalThis` seam the browser half
 * uses, because a plugin cannot import the app.
 */

import type { Context } from '@deepseek-ai/cordis'

/** What the app publishes about the machine this session runs. */
interface MachineBridge {
  status(): { emulated: boolean, guest?: string }
  guests(): { id: string, name: string, console: string }[]
}

/**
 * What to tell the model about what the user can see and do.
 * @returns the section text.
 */
function announcement(): string {
  const machine = (globalThis as Record<string, unknown>).__DSH_WEB_MACHINE__ as MachineBridge | undefined
  const status = machine?.status()
  const chooser = 'The machine is chosen in Settings → Machine, and a change there takes effect on the '
    + 'next page load rather than immediately.'

  if (status === undefined || !status.emulated) {
    return 'The user can open a Machine panel from the sidebar. On this session it is an interactive '
      + 'terminal on the same workspace, running the same runtime and the same shell your own shell '
      + 'tool runs in: files you create are visible to them immediately, and files they create are '
      + `visible to you. ${chooser}`
  }

  const guest = machine?.guests().find(entry => entry.id === status.guest)
  const name = guest?.name ?? 'an emulated PC'
  // What the panel shows is the machine's *screen*, on every guest. For one
  // whose shell lives on its serial port that is not the console the shell
  // tool types at, and the difference is worth a sentence: the model would
  // otherwise assume its commands are being watched and narrate less than it
  // should.
  const console_ = guest?.console === 'serial'
    ? `It is ${name}'s screen — live, with a working keyboard. Your shell tool types at this machine's `
      + 'serial console instead, which is a different console: the user does not see your commands there, '
      + 'so say what you are doing rather than assuming they can watch.'
    : `It is ${name}'s screen — live, with a working keyboard — so they can watch what you do and take `
      + 'over at any point.'
  return `The user can open a Machine panel from the sidebar. ${console_} ${chooser} `
    + 'The machine\'s disk is not the browser workspace your file tools read and write; those are two '
    + 'different filesystems.'
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

  prompt.section({
    name: 'web-machine',
    // After the persona and the runtime context, before anything task-shaped.
    order: 60,
    text: announcement(),
  })
}

export default { apply, inject }
