/**
 * The tools a session gets when the machine is an emulated PC.
 *
 * This is the other half of `src/host/jsh-tool.ts`. That one exists because
 * the container's shell is not the shell a model expects and the honest answer
 * was to describe it exactly; this one exists for the same reason, one step
 * further out. The machine here is a 486 running DOS, or Windows 3.1, or a
 * Linux from 2014, and *none* of them has the thing a harness normally assumes:
 * a filesystem shared with the page, a package manager, or — on the graphical
 * ones — any text at all.
 *
 * So the tool set is chosen by what the guest can actually do, and it is
 * chosen at composition time from one field in the catalog:
 *
 * - A **serial** guest has a POSIX shell on the wire. It gets `sh`, and `sh`
 *   behaves the way a shell tool is supposed to: whole output, an exit status,
 *   pipes, loops, heredocs.
 * - A **DOS** guest has a command interpreter that `CTTY COM1` puts on the same
 *   wire. It gets `dos`, which is the same shape with DOS's vocabulary and
 *   DOS's limits, both stated.
 * - A **graphical** guest has pixels. It gets no command tool at all, because
 *   there is no command to run — it gets the keyboard, the mouse, and the
 *   screen, which is what driving Windows 3.1 consists of.
 *
 * Every guest gets the screen tools, because every guest has a screen.
 *
 * What none of them gets is `jsh`: there is no container in this session, no
 * Node, no npm and no CPython, and a tool offering them would be describing a
 * machine that is not running. `src/host/machine-tools.ts` is the row that
 * makes that choice, and it makes it once, before the first request.
 */

import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { KEY_NAMES, bootMachine, machineGuest, type CommandResult, type Machine } from '../runtime/v86.ts'
import type { GuestSpec } from '../runtime/guests.ts'
import { volume } from '../vfs/volume.ts'
import { WORKSPACE_ROOT } from './seed.ts'
import { dirname } from '../vfs/path.ts'

/** Services this row waits for before it applies. */
export const inject = ['tools', 'systemPrompt']

/** The row's id in the composition. */
export const name = 'web-vm'

/**
 * Get the machine, starting it if this is the first call.
 *
 * Not at composition time: booting is a download and, for some guests, a minute
 * of emulation, and a session that never touches the machine should not pay for
 * it. `bootMachine` keeps the one promise, so ten tool calls in one turn boot
 * one machine — and a machine that was torn down and restarted is picked up
 * here rather than cached past its own lifetime.
 * @returns the running machine.
 */
async function machine(): Promise<Machine> {
  return bootMachine()
}

/** Human-readable size. */
function readableSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/** The schema a command tool's result is validated against. */
const COMMAND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: { type: 'string', required: true },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean', required: true },
  },
} as const

/**
 * Render one finished command the way the shipped shell tools render one.
 *
 * The `[exit code: N]` marker is what the surface's terminal card reads to
 * draw its status pill, and what a model has learned to check.
 *
 * DOS does not have one, and calling its number an exit code would be the most
 * expensive kind of wrong. What DOS has is `ERRORLEVEL`, and `ERRORLEVEL` is
 * set by *external programs only*: `nasm nosuchfile.asm` sets it to 1, and the
 * `dir`, `type`, `copy` and `cd` that follow leave that 1 exactly where it is
 * while failing or succeeding on their own terms. Measured on FreeDOS, where
 * `type nosuchfile.txt` prints "File not found." and reports zero, and a
 * `type` after a program that exited 36 reports 36.
 *
 * So a DOS result is labelled `[errorlevel: N]` and the tool description says
 * what that means. A marker the model can trust for one class of command is
 * worth more than one it trusts for all of them and should not.
 * @param result - the finished command.
 * @param kind - the guest's console, which decides what the number is called.
 * @returns the model-facing text.
 */
function renderCommand(result: CommandResult, kind: GuestSpec['console']): string {
  const body = result.output.length === 0 ? '(no output)' : result.output
  const markers: string[] = []
  if (result.timedOut) {
    // No status marker beside it: the command has not finished, so there is
    // nothing to report, and "not reported by this guest" would blame the
    // guest for the timeout.
    markers.push('[timed out; the command may still be running on the machine, and Ctrl+C was sent]')
  } else if (result.exitCode === null) markers.push('[exit status: not reported by this guest]')
  else if (kind === 'dos') markers.push(`[errorlevel: ${String(result.exitCode)}]`)
  else markers.push(`[exit code: ${String(result.exitCode)}]`)
  return `${body.replace(/\n+$/, '')}\n${markers.join('\n')}`
}

/**
 * What the model is told the `sh` tool is.
 *
 * Written against a guest that was measured, not remembered: the shell, the
 * command set, and what is missing all come from the catalog entry, which is
 * checked by `npm run test:v86`.
 * @param spec - the guest.
 * @returns the tool description.
 */
function shellDescription(spec: GuestSpec): string {
  return [
    `Run a command in ${spec.name} and return everything it printed.`,
    '',
    'This is a real POSIX shell on a real machine, reached over the serial console. Pipes, `for`,',
    '`if`, `$(...)`, heredocs, redirection and `$?` all work, and the exit status is reported.',
    '',
    `What is installed: ${spec.contains}`,
    '',
    'This machine is NOT the machine your file tools read and write. `read`, `write`, `edit`, `grep`',
    'and `glob` operate on this browser\'s own workspace, which the guest cannot see and which cannot',
    'see the guest. To get a file onto the machine use `vm_write_file`; to get one off, `cat` it here',
    'and write the output with your file tools.',
    '',
    'Treat the network as absent. This is a 32-bit machine old enough that nothing modern will',
    'negotiate TLS with it, so whatever is already installed is what you have.',
    '',
    'Output is complete — it is read from a character stream, not scraped off the screen — so a',
    'command that prints a thousand lines returns a thousand lines. Check the [exit code: N] marker',
    'on every result.',
  ].join('\n')
}

/** What the model is told the `dos` tool is. */
function dosDescription(spec: GuestSpec): string {
  return [
    `Run a command at the ${spec.name} prompt and return everything it printed.`,
    '',
    'This is DOS, not a POSIX shell. Read this before writing a command:',
    '  There is no `$(...)`, no command substitution of any kind, and no single-quoting. `>` and `>>`',
    '  redirect, `|` pipes through a temporary file, and `%VAR%` expands. Both `for %A in (…) do …`',
    '  and `if` work at the prompt — `if exist FILE …`, `if errorlevel 1 …`, `if "%V%"=="x" …` — with',
    '  a single `%`, where a .BAT file would need `%%`. Paths use `\\`, names are 8.3 and',
    '  case-insensitive.',
    '  Among the commands: `dir`, `type`, `copy`, `move`, `ren`, `del`, `md`, `rd`, `cd`, `path`,',
    '  `cls`, `echo`, `set`, `more`, `find`, `sort`, `fc`, `xcopy`, `attrib`. The POSIX ones are not',
    '  here: no `ls`, `cat`, `rm`, `grep`, `sed` or `awk`. `dir` is how you find out what else is.',
    '',
    `What is installed: ${spec.contains}`,
    '',
    ...(spec.serialConsole === true
      ? [
          'How this reads the output: `CTTY COM1` moves the DOS console onto the serial port, so what',
          'comes back is a character stream and a command\'s whole output arrives however long it is.',
          'While the console is there the screen is frozen and the keyboard ignored — `vm_screen`,',
          '`vm_type` and `vm_key` put it back before they act, so mixing them costs a second.',
        ]
      : [
          'How this reads the output: the command is typed at the prompt and read back off the screen,',
          'including rows recorded as they scrolled past. That has a limit worth knowing: output that',
          'arrives faster than the screen is sampled can lose lines, so for anything longer than a',
          'screenful redirect it to a file and read it back in pieces — `dir > out.txt` then',
          '`type out.txt`, or pipe through `more`. Short output is exact. DOS also wraps at the',
          'eightieth column, so one long line comes back split across two.',
        ]),
    '',
    'A full-screen program — `vim`, `edit`, a game — will not work through this tool: it repaints a',
    'screen rather than printing lines, and there is no prompt for it to come back to. Run those with',
    '`vm_type` and watch them with `vm_screenshot`.',
    'A command that waits for input has the console, and the next thing sent is treated as its input,',
    'not as a command; a timed-out call sends Ctrl+C to get the prompt back, but do not rely on it.',
    '',
    'This machine is NOT the machine your file tools read and write. Read, Write, Edit, grep and',
    'glob operate on this browser\'s own workspace, which the guest cannot see, and there is no tool',
    'that copies a file across. To create one here, build it a line at a time:',
    '  `echo @echo off > BUILD.BAT` then `echo nasm hello.asm >> BUILD.BAT`',
    'Note the limit that comes with it: `>`, `<`, `|` and `&` in the text are read as redirection by',
    'DOS, and there is no escape for them — a line containing one cannot be written this way.',
    '',
    'About the [errorlevel: N] marker on a result: DOS sets ERRORLEVEL only when an external program',
    'exits, and an internal command — `dir`, `type`, `copy`, `cd`, `echo` — leaves whatever the last',
    'program left there. So `type nosuchfile.txt` prints "File not found." and still reports the',
    'previous number. Trust the marker immediately after running a program; everywhere else, read the',
    'output, which is what actually says whether the command worked.',
  ].join('\n')
}

/**
 * Mount the row.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const spec = machineGuest()
  if (spec === undefined) return

  ctx.systemPrompt.section({
    name: 'machine:v86',
    // The same slot the shell tool's advice takes, so a session gets one
    // description of its machine rather than two that disagree.
    order: 105,
    text: machinePrompt(spec),
  })

  if (spec.console !== 'gui') registerCommandTool(ctx, spec)
  // Only where there is a shell to deliver a file through. DOS's `COPY CON`
  // does not read a redirected console and wedges it trying — see
  // `MachineConsole.putFile` — so a DOS session is told how to build a file
  // with `echo` instead of being handed a tool that can hang the machine.
  if (spec.console === 'serial') registerWriteFile(ctx, spec)
  registerScreenshot(ctx, spec)
  registerScreenText(ctx, spec)
  registerType(ctx, spec)
  registerKey(ctx, spec)
  registerMouse(ctx, spec)
  registerWait(ctx, spec)
}

/** What the model is told about the machine it is on. */
function machinePrompt(spec: GuestSpec): string {
  const driving = spec.console === 'gui'
    ? 'It is a graphical system with no command line reachable from here, so you drive it the way a '
      + 'person does: `vm_screenshot` to see it, `vm_key` and `vm_type` for the keyboard, `vm_mouse` '
      + 'for the pointer, `vm_wait` to let it catch up. Menus in systems of this era are all reachable '
      + 'from the keyboard, which is far more reliable than the pointer — prefer it.'
    : spec.console === 'serial'
      ? 'It has a real POSIX shell on its serial console, which is the `sh` tool. Output is complete '
        + 'and exit statuses are real.'
      : 'It has a DOS prompt, which is the `dos` tool. DOS is not a POSIX shell: no `$(...)`, no '
        + 'single quotes, `\\` for paths, and 8.3 file names.'
  return [
    `This session does not run in a container. It runs an emulated 32-bit PC — ${spec.name} — booted `
    + 'inside this browser tab from a real disk image. There is no Node, no npm, no Python, and no '
    + '`bash` or `jsh` tool, because none of them exists on this machine.',
    driving,
    'Two filesystems, and they are not connected. Your `read`, `write`, `edit`, `grep` and `glob` tools operate '
    + 'on this browser\'s own workspace — that is where your notes, reports and any files the user '
    + 'gave you live, and it is what the Files panel shows. The emulated machine has its own disk, '
    + 'which those tools cannot reach and which cannot reach them. Say which one you mean.',
    'The machine starts when the page loads and stays running for the whole session, so it is '
    + `usually already up by the time you reach for it; a cold start takes ${spec.boots}, and a first `
    + 'call made during one waits for the rest of it. It is the same machine the user sees in the '
    + 'Runtime panel, so what you type, they watch.',
  ].join('\n\n')
}

/** Turn a tool-call abort into the error the loop recognises. */
function aborted(): never {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  throw error
}

/** The shell or DOS command tool. */
function registerCommandTool(ctx: Context, spec: GuestSpec): void {
  const serial = spec.console === 'serial'
  ctx.tools.register(defineTool({
    name: serial ? 'sh' : 'dos',
    description: serial ? shellDescription(spec) : dosDescription(spec),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: serial
          ? 'The command to run, in the guest\'s shell. Multi-line scripts are accepted.'
          : 'The command to run at the DOS prompt. One command per line; several lines run in order.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
      },
      timeoutMs: {
        type: 'number',
        description: 'How long to wait for the command to finish. Defaults to 120000. A command that outruns it is left running and reported as timed out.',
      },
    },
    output: {
      schema: COMMAND_OUTPUT,
      render: (_args, value) => [{
        type: 'text' as const,
        text: renderCommand(value as unknown as CommandResult, spec.console),
      }],
    },

    async execute(args: { command: string, description: string, timeoutMs?: number }, exec): Promise<CommandResult> {
      const command = String(args.command ?? '')
      if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      if (String(args.description ?? '').trim().length === 0) throw new Error('invalid description: expected a non-empty string')
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // No separate readiness wait: `console.run` attaches first, and
      // attaching *is* waiting for a prompt — with the guest's own budget.
      // Waiting for a marker and then waiting for a prompt was the same wait
      // twice, and on a guest that never signals it was the second one paid
      // by every command.
      const result = await running.console.run(command, {
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        signal: exec.signal,
      })
      if (exec.signal.aborted) aborted()
      return result
    },

    presentCall: (args: { command: string, description: string }) => ({
      card: 'terminal' as const,
      title: String(args.command),
      description: String(args.description),
    }),
    presentResult: (_args: unknown, result: { content: { type: string, text?: string }[] }) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text ?? ''
      // The status pill only for a guest whose number is an exit code. Painting
      // one red because DOS still had a 36 in `ERRORLEVEL` from a program two
      // commands ago is the same lie as the marker, drawn larger.
      const status = /\[exit code: (\d+)\]/.exec(raw)
      return {
        card: 'terminal' as const,
        output: raw.replace(/\n\[(?:exit code|errorlevel|exit status|timed out)[^\]]*\]/g, ''),
        ...(status === null ? {} : { exitCode: Number(status[1]) }),
      }
    },
  }))
}

/**
 * Put a text file onto the machine, through its shell.
 *
 * There is no shared filesystem to write it into and the console is the only
 * channel there is, so the file arrives as an octal-escaped `printf` — one
 * physical line at a time, every character surviving, nothing installed.
 *
 * Registered only for a guest with a shell. DOS has no equivalent that works:
 * `COPY CON` does not read a console that `CTTY COM1` has moved, and wedges it
 * trying, which is measured and recorded on `MachineConsole.putFile`.
 */
function registerWriteFile(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_write_file',
    description: [
      `Write a text file onto ${spec.name}.`,
      '',
      'The emulated machine has no filesystem in common with your other file tools, so this is how a',
      'file gets there. It goes through the console a chunk at a time, which is slow — a few kilobytes',
      'per second — so it is for source files and scripts, not for data.',
      'Delivered as an escaped `printf`, so every character survives: quotes, backslashes, newlines,',
      'and anything else that would break a hand-written heredoc. The size is read back afterwards and',
      'a short file is reported rather than passed off as written.',
      'Text only: there is no way to send bytes the console would read as control characters.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path on the guest, for example /root/build.sh.' },
      content: { type: 'string', required: true, description: 'The file\'s text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          verified: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const written = value as unknown as { path: string, bytes: number, verified: boolean }
        return [{
          type: 'text' as const,
          text: written.verified
            ? `wrote ${String(written.bytes)} bytes to ${written.path} on the machine`
            : `wrote ${String(written.bytes)} bytes to ${written.path}, but the guest reports a different size — check it with \`sh\``,
        }]
      },
    },
    async execute(args: { path: string, content: string }, exec): Promise<{ path: string, bytes: number, verified: boolean }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      const content = String(args.content ?? '')
      const path = String(args.path ?? '').trim()
      if (path === '') throw new Error('invalid path: expected a non-empty string')
      const written = await running.console.putFile(path, content)
      // Compared as "at least", not "exactly". DOS writes CR LF for every
      // newline and `COPY CON` adds an end-of-file byte on some versions, so an
      // exact match would report a correct transfer as a failed one — while a
      // short file, which is the failure that matters, still fails this.
      return {
        path,
        bytes: written.expected,
        verified: written.reported !== null && written.reported >= written.expected,
      }
    },
    presentCall: (args: { path: string, content: string }) => ({
      card: 'generic' as const,
      title: String(args.path),
      kind: 'edit' as const,
      content: [{ type: 'text' as const, text: `writing ${String(String(args.content ?? '').length)} bytes to the machine` }],
    }),
  }))
}

/** The screenshot tool. */
function registerScreenshot(ctx: Context, spec: GuestSpec): void {
  let counter = 0
  ctx.tools.register(defineTool({
    name: 'vm_screenshot',
    description: [
      `Photograph ${spec.name}'s screen and save it into the workspace as a PNG.`,
      '',
      'It is written to a file rather than returned inline, because the model this session runs on may',
      'not accept images at all. If yours does, `read_image` on the path this returns puts the screen',
      'in front of you; if it does not, the user can still open the file from the Files panel and tell',
      'you what is on it.',
      '',
      'When the screen is in a text mode, `vm_screen` gives you the same content as text, which you',
      'can actually read — reach for that first and use this when the screen is graphical.',
    ].join('\n'),
    parameters: {
      path: {
        type: 'string',
        description: 'Where to save it, relative to the workspace. Defaults to screenshots/<machine>-<n>.png.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const shot = value as unknown as { path: string, width: number, height: number, mode: string }
        return [{
          type: 'text' as const,
          text: `saved ${shot.path} — ${String(shot.width)}×${String(shot.height)}, ${shot.mode} mode`
            + (shot.mode === 'text' ? '. The screen is in a text mode: read it with vm_screen.' : ''),
        }]
      },
    },
    async execute(args: { path?: string }, exec): Promise<{ path: string, width: number, height: number, bytes: number, mode: string }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // Deliberately not waiting for the guest's readiness marker. A cold
      // Windows 95 spends a minute in a text mode before it draws anything,
      // and a screen tool that waited for the desktop would be unusable for
      // the one thing it is most needed for — watching a machine boot, and
      // answering the prompt it stopped at.
      await running.console.releaseScreen()
      const shot = await running.screenshot()
      const relative = args.path ?? `screenshots/${spec.id}-${String(++counter)}.png`
      const path = relative.startsWith('/') ? relative : `${WORKSPACE_ROOT}/${relative}`
      volume.mkdirp(dirname(path))
      volume.writeFile(path, shot.bytes)
      return {
        path,
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes.length,
        mode: shot.graphical ? 'graphical' : 'text',
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: `${spec.name} screen`, kind: 'read' as const }),
  }))
}

/** The text-screen tool. */
function registerScreenText(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_screen',
    description: [
      `Read ${spec.name}'s screen as text.`,
      '',
      'This is the VGA text buffer, so it works whenever the screen is in a text mode and returns',
      'nothing useful when it is graphical — a Windows desktop has no text on it to read, and',
      '`vm_screenshot` is the tool for that.',
      '',
      'The screen is 80×25 and anything that scrolled past the top is gone from it; `transcript: true`',
      'returns what this page recorded on the way past, which is up to four thousand lines.',
      spec.console === 'gui'
        ? 'This guest is graphical, but it passes through a text mode while it boots, and a full-screen '
          + 'DOS box inside it puts the screen back into one — so this is worth trying before a screenshot.'
        : 'Running a command with the command tool moves the console off this screen; this tool puts it '
          + 'back first, so what it returns is live.',
    ].join('\n'),
    parameters: {
      transcript: {
        type: 'boolean',
        description: 'Include the lines that have already scrolled off the top of the screen.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          cols: { type: 'integer', required: true },
          rows: { type: 'integer', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const view = value as unknown as { mode: string, cols: number, rows: number, lines: string[] }
        const body = view.lines.join('\n').trim()
        if (view.mode !== 'graphical') {
          return [{
            type: 'text' as const,
            text: `${String(view.cols)}×${String(view.rows)} text mode\n\n${view.lines.join('\n')}`,
          }]
        }
        // Graphical now does not mean there was never anything to read: a
        // machine passes through a text mode on its way up, and asking for the
        // transcript is how you read what it said on the way. Throwing that
        // away because of what the screen is showing *at this instant* was the
        // one case where this tool answered a question nobody asked.
        if (body === '') {
          return [{
            type: 'text' as const,
            text: 'The screen is in a graphical mode and nothing was written to a text screen before it. Use vm_screenshot.',
          }]
        }
        return [{
          type: 'text' as const,
          text: 'The screen is in a graphical mode now — use vm_screenshot to see it. This is what was on the '
            + `text screen before it changed:\n\n${body}`,
        }]
      },
    },
    async execute(args: { transcript?: boolean }, exec): Promise<{ mode: string, cols: number, rows: number, lines: string[] }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // Deliberately not waiting for the guest's readiness marker. A cold
      // Windows 95 spends a minute in a text mode before it draws anything,
      // and a screen tool that waited for the desktop would be unusable for
      // the one thing it is most needed for — watching a machine boot, and
      // answering the prompt it stopped at.
      await running.console.releaseScreen()
      const view = running.screenText()
      return {
        mode: view.graphical ? 'graphical' : 'text',
        cols: view.cols,
        rows: view.rows,
        lines: args.transcript === true ? running.transcript() : view.lines,
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: `${spec.name} screen text`, kind: 'read' as const }),
  }))
}

/** The keyboard-text tool. */
function registerType(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_type',
    description: [
      `Type text on ${spec.name}'s keyboard.`,
      '',
      'The keystrokes go to whatever has focus, exactly as if someone were at the machine. A US',
      'layout is assumed. Typing is paced so the guest does not drop characters, which costs about',
      'a hundredth of a second per character.',
      '',
      'For a key that is not a character — Enter, Escape, a function key, a chord — use `vm_key`.',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
      enter: { type: 'boolean', description: 'Press Enter afterwards.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          typed: { type: 'integer', required: true },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as { typed: number, skipped: string[] }
        return [{
          type: 'text' as const,
          text: `typed ${String(result.typed)} characters`
            + (result.skipped.length === 0
              ? ''
              : `; a US keyboard has no key for ${[...new Set(result.skipped)].join(' ')}, so ${String(result.skipped.length)} were not sent`),
        }]
      },
    },
    async execute(args: { text: string, enter?: boolean }, exec): Promise<{ typed: number, skipped: string[] }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      const text = String(args.text ?? '')
      const skipped = await running.type(args.enter === true ? `${text}\n` : text)
      return { typed: text.length - skipped.length, skipped }
    },
    presentCall: (args: { text: string }) => ({
      card: 'generic' as const, title: `type: ${String(args.text).slice(0, 60)}`, kind: 'execute' as const,
    }),
  }))
}

/** The key-press tool. */
function registerKey(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_key',
    description: [
      `Press keys on ${spec.name}'s keyboard.`,
      '',
      'Each entry is one key or one chord: a single character, or one of these names —',
      `  ${KEY_NAMES.join(', ')}.`,
      'Prefix with `Ctrl+`, `Alt+` or `Shift+` for a chord — `Ctrl+C`, `Alt+F4`, `Alt+Enter`,',
      '`Ctrl+Alt+Delete`. Anything else is rejected rather than silently dropped.',
      '',
      'Menus and dialogs in systems of this era are entirely keyboard-driven, and the keyboard is far',
      'more reliable here than the pointer: `Alt+F` opens a File menu, arrow keys and Enter walk it,',
      'Escape backs out, Tab moves between controls, and Space toggles one.',
    ].join('\n'),
    parameters: {
      keys: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'The keys to press, in order.',
      },
      delayMs: { type: 'number', description: 'Pause between keys, in milliseconds. Defaults to 120.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { pressed: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `pressed ${(value as { pressed: string[] }).pressed.join(', ')}`,
      }],
    },
    async execute(args: { keys: string[], delayMs?: number }, exec): Promise<{ pressed: string[] }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // Deliberately not waiting for the guest's readiness marker. A cold
      // Windows 95 spends a minute in a text mode before it draws anything,
      // and a screen tool that waited for the desktop would be unusable for
      // the one thing it is most needed for — watching a machine boot, and
      // answering the prompt it stopped at.
      await running.console.releaseScreen()
      const keys = Array.isArray(args.keys) ? args.keys.map(key => String(key)) : []
      if (keys.length === 0) throw new Error('invalid keys: expected a non-empty array')
      const delay = args.delayMs ?? 120
      for (const key of keys) {
        running.press(key)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      return { pressed: keys }
    },
    presentCall: (args: { keys: string[] }) => ({
      card: 'generic' as const,
      title: `keys: ${(args.keys as string[] | undefined ?? []).join(' ')}`,
      kind: 'execute' as const,
    }),
  }))
}

/** The pointer tool. */
function registerMouse(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_mouse',
    description: [
      `Move ${spec.name}'s pointer and click.`,
      '',
      'The emulated mouse is a PS/2 mouse, and a PS/2 mouse reports movement, not position — there',
      'is no way to say "go to (x, y)", because a real one cannot say it either. So `dx` and `dy` are',
      'mouse units, and how far the pointer travels per unit is up to the guest\'s own driver:',
      'Windows 3.1 at 1024×768 moves about two pixels per unit, measured.',
      '',
      'To reach a known place: pass `home: true`, which drives the pointer hard into the top-left',
      'corner where it stops, and then move by roughly half the pixel offset you want. Then take a',
      'screenshot and correct. Do not expect to land first time.',
      '',
      'The keyboard is the better tool for anything a menu can do. Use this for what only a pointer',
      'can do: dragging, and clicking something with no keyboard path to it.',
      '',
      'A guest with no mouse driver loaded — most bare DOS — ignores all of this, and the screen will',
      'not move. That is the guest, not a failure of the call.',
    ].join('\n'),
    parameters: {
      dx: { type: 'number', description: 'Horizontal movement in mouse units; positive is right.' },
      dy: { type: 'number', description: 'Vertical movement in mouse units; positive is down.' },
      home: { type: 'boolean', description: 'Drive the pointer into the top-left corner first.' },
      click: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Click a button after moving.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          moved: { type: 'array', required: true, items: { type: 'number' } },
          clicked: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => {
        const action = value as unknown as { moved: number[], clicked: string | null }
        return [{
          type: 'text' as const,
          text: `moved (${String(action.moved[0])}, ${String(action.moved[1])})`
            + (action.clicked === null ? '' : ` and clicked ${action.clicked}`)
            + '. Take a screenshot to see where the pointer landed.',
        }]
      },
    },
    async execute(
      args: { dx?: number, dy?: number, home?: boolean, click?: 'left' | 'middle' | 'right' },
      exec,
    ): Promise<{ moved: number[], clicked: string | null }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // Deliberately not waiting for the guest's readiness marker. A cold
      // Windows 95 spends a minute in a text mode before it draws anything,
      // and a screen tool that waited for the desktop would be unusable for
      // the one thing it is most needed for — watching a machine boot, and
      // answering the prompt it stopped at.
      await running.console.releaseScreen()
      if (args.home === true) {
        // A PS/2 packet carries nine signed bits of movement per axis, so a
        // delta outside ±255 is truncated into the byte and arrives as some
        // other number — measured against v86's own `send_mouse_packet`, which
        // pushes the delta into a byte queue with the sign in a separate bit.
        // So the corner is reached with sixteen deltas that fit, which is
        // 3840 pixels of travel in each direction: further than any screen
        // this emulator produces, from anywhere on it.
        for (let step = 0; step < 16; step++) {
          running.moveMouse(-240, -240)
          await new Promise(resolve => setTimeout(resolve, 15))
        }
      }
      const dx = Math.trunc(args.dx ?? 0)
      const dy = Math.trunc(args.dy ?? 0)
      // Broken into small steps for the same reason: a guest with pointer
      // acceleration turns one big delta into an unpredictable jump.
      const steps = Math.max(Math.abs(dx), Math.abs(dy)) === 0 ? 0 : Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 8)
      // Accumulated rather than divided: eight steps of `round(100/13)` deliver
      // 104, and a tool that reported the 100 it was asked for would be telling
      // the model a number the guest never saw.
      let sentX = 0
      let sentY = 0
      for (let step = 0; step < steps; step++) {
        const wantX = Math.round(dx * (step + 1) / steps)
        const wantY = Math.round(dy * (step + 1) / steps)
        running.moveMouse(wantX - sentX, wantY - sentY)
        sentX = wantX
        sentY = wantY
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      if (args.click !== undefined) {
        await new Promise(resolve => setTimeout(resolve, 150))
        await running.click(args.click)
      }
      return { moved: [sentX, sentY], clicked: args.click ?? null }
    },
    presentCall: () => ({ card: 'generic' as const, title: `${spec.name} pointer`, kind: 'execute' as const }),
  }))
}

/** The wait tool. */
function registerWait(ctx: Context, spec: GuestSpec): void {
  ctx.tools.register(defineTool({
    name: 'vm_wait',
    description: [
      `Let ${spec.name} get on with something.`,
      '',
      'An emulated 486 is slow at what a 486 was slow at: starting a program, opening a window,',
      'redrawing a screen. When you have typed something and the machine has not caught up, wait',
      'here rather than taking screenshot after screenshot.',
      '',
      '`until` waits for text to appear on the text screen, which is exact when there is text to',
      'match; otherwise `seconds` waits and returns.',
    ].join('\n'),
    parameters: {
      seconds: { type: 'number', description: 'How long to wait. Defaults to 3, capped at 120.' },
      until: { type: 'string', description: 'Wait until this text appears on the text screen, then return early.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitedMs: { type: 'integer', required: true },
          found: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const waited = value as unknown as { waitedMs: number, found: boolean }
        return [{
          type: 'text' as const,
          text: waited.found
            ? `the text appeared after ${String(Math.round(waited.waitedMs / 100) / 10)}s`
            : `waited ${String(Math.round(waited.waitedMs / 100) / 10)}s`,
        }]
      },
    },
    async execute(args: { seconds?: number, until?: string }, exec): Promise<{ waitedMs: number, found: boolean }> {
      if (exec.signal.aborted) aborted()
      const running = await machine()
      // Like every other screen-facing tool: on a DOS guest the console may be
      // on the serial port, and a wait watching a frozen screen for text that
      // will never appear on it is a wait that always runs its full budget.
      await running.console.releaseScreen()
      const started = Date.now()
      const budget = Math.min(120_000, Math.max(100, (args.seconds ?? 3) * 1000))
      const until = args.until
      if (until === undefined) {
        await new Promise(resolve => setTimeout(resolve, budget))
        return { waitedMs: Date.now() - started, found: false }
      }
      while (Date.now() - started < budget) {
        if (exec.signal.aborted) aborted()
        if (running.screenText().lines.some(line => line.includes(until))) {
          return { waitedMs: Date.now() - started, found: true }
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      return { waitedMs: Date.now() - started, found: false }
    },
    presentCall: (args: { seconds?: number, until?: string }) => ({
      card: 'generic' as const,
      title: args.until === undefined ? `wait ${String(args.seconds ?? 3)}s` : `wait for "${String(args.until)}"`,
      kind: 'execute' as const,
    }),
  }))
}

export default { apply, inject, name }
