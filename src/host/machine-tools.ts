/**
 * The row that decides which machine's tools the model is offered.
 *
 * There are two machines this deployment can be — a Node container, or an
 * emulated PC — and they have nothing in common. The container has `jsh`,
 * Node, npm and CPython, and a filesystem the agent's file tools read directly.
 * The emulated PC has a DOS prompt, or a serial shell, or nothing but a screen
 * and a keyboard. Offering a model the wrong set is not a degraded session, it
 * is a session where every command fails for a reason the model cannot see.
 *
 * So one row mounts one of them, and it is this one.
 *
 * ## Why one row rather than two
 *
 * The obvious shape is two rows that each disable themselves. It is worse, and
 * for a reason this repository has already paid for once: a row that mounts and
 * then declines to register anything reports itself as active in
 * `--dump-config` and in the plugin inventory, so the composition claims to
 * offer a shell tool that no request ever carries. `src/host/jsh-tool.ts`
 * documents the afternoon that cost.
 *
 * One row, named for what it is, that resolves the choice before it registers
 * anything, is the honest shape: the inventory shows `tool-machine`, and what
 * `tool-machine` mounted is what the model was given.
 *
 * ## Where it is mounted
 *
 * In each agent preset, in place of the shipped `tool-bash` row —
 * `scripts/assemble.ts` rewrites it there. That is where the shell tool
 * actually lives; the host plane's copy is disabled by
 * `src/host/browser.patch.yml`, and disabling only that one is what leaves the
 * loader reporting `tool-bash disabled=true` while every request still carries
 * a `bash` tool.
 */

import type { Context } from '@deepseek-ai/cordis'
import { isEmulated } from '../runtime/selection.ts'
import * as jshTool from './jsh-tool.ts'
import * as vmTools from './vm-tools.ts'

/**
 * Services this row waits for.
 *
 * The union of what the two halves need, because which half applies is not
 * known until it applies. `shell` and `shellEnv` are only read by the container
 * half; they exist in both compositions, so waiting for them costs the
 * emulated session nothing.
 */
export const inject = ['tools', 'shell', 'shellEnv', 'systemPrompt']

/** The row's id in the composition. */
export const name = 'web-machine-tools'

/**
 * Mount the tools this session's machine actually has.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  if (isEmulated()) vmTools.apply(ctx)
  else jshTool.apply(ctx)
}

export default { apply, inject, name }
