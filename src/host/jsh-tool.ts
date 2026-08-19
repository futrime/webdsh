/**
 * The shell the model is told about.
 *
 * This deployment runs in a browser, and the machine it carries is
 * WebContainers — Node in the tab. What that machine has for a shell is `jsh`,
 * which is a JavaScript program with a shell-shaped surface rather than a
 * shell: `for`, `if`, `while`, `case`, functions, heredocs and `<` are syntax
 * errors, and — the part that matters — `$(…)`, `` `…` `` and `$((…))` are
 * accepted, expanded to the empty string, and reported as success.
 *
 * That last sentence is why this plugin exists. A model asked to count files
 * writes `n=$(ls | wc -l); echo $n`, reads `[exit code: 0]` and an empty line,
 * and concludes the directory is empty. Nothing errors. Nothing retries.
 *
 * There are two honest ways out: implement a shell that behaves as the model
 * expects (which this repository does, in `src/shell/`), or run the shell the
 * machine actually has and describe it exactly. This is the second. It swaps
 * both halves together — the interpreter commands are handed to, and the tool
 * description the model plans against — because swapping either one alone is
 * how the confident wrong answer happens.
 *
 * It *replaces* the shipped bash tool, and the replacement happens where that
 * tool is actually mounted: the agent presets. `tool-bash` appears twice in
 * this composition — once in the host plane, which `browser.patch.yml`
 * disables, and once in each preset's `agent.cordis.yml`, which is a separate
 * composition a host patch layer never sees. Disabling only the first is what
 * a whole afternoon looked like: the loader reported `tool-bash disabled=true`
 * while every request still carried a `bash` tool. `scripts/assemble.ts`
 * rewrites the preset row to name this module instead, so the model is offered
 * exactly one shell and it is `jsh`.
 *
 * Everything else about a command is unchanged: `ctx.shell` still resolves the
 * timeout, still confines the command under the sandbox policy, still spills
 * long output to a file, and still runs it in the background when asked. Only
 * the interpreter and the description differ.
 */

import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'
import { proxiedUrl, proxyConfig } from '../net/cors-proxy.ts'

/** Services this row waits for before it applies. */
export const inject = ['tools', 'shell', 'shellEnv', 'systemPrompt']

/** The row's id in the composition. */
export const name = 'web-jsh'

/**
 * The commands `jsh` has.
 *
 * Read out of the container rather than remembered: `ls /bin /usr/bin
 * /usr/local/bin`. `bash`, `sh`, and `zsh` are in there too and are all `jsh`
 * under another name, which is exactly the trap this list exists to close.
 * `python3`, `pip` and `pip3` are the harness's, installed ahead of the
 * container's own on `$PATH` — see `src/runtime/python.ts`.
 */
const COMMANDS = [
  'alias', 'cat', 'cd', 'chmod', 'clear', 'cp', 'curl', 'echo', 'env', 'false', 'getconf',
  'head', 'hostname', 'jq', 'kill', 'ln', 'ls', 'mkdir', 'mv', 'node', 'npm', 'npx', 'pip',
  'pip3', 'pnpm', 'ps', 'pwd', 'python3', 'rm', 'rmdir', 'sort', 'tail', 'touch', 'true',
  'uptime', 'which', 'xxd', 'yarn',
].join(' ')

/**
 * What the model is told to do about CORS, read from the page's own policy.
 *
 * Everywhere else this build fetches, the proxy is applied by code and the
 * caller never learns it happened: `src/net/cors-proxy.ts` retries a refused
 * cross-origin request through whatever Settings → Network names. The
 * container is the one place that cannot work, and the reason is worth
 * keeping: its requests come out of StackBlitz's own worker, which neither a
 * patched `window.fetch` nor `public/sw.js` ever sees — both were measured,
 * and both see nothing.
 *
 * So here, and only here, the fallback is something the model is told rather
 * than something the app does — and it is told the configured proxy, not a
 * constant. Turning the proxy off in Settings removes the advice instead of
 * leaving the model retrying through a host the user declined.
 * @returns the paragraph, as description lines.
 */
function corsAdvice(): string[] {
  const { enabled, template } = proxyConfig()
  const common = [
    'The network is the browser\'s, so a host only answers if it sends CORS headers. The npm',
    'registry does, so `npm install` works, and so do most JSON APIs. Many public sites do not,',
    'and a direct request to one fails with `fetch failed` — that is the host\'s policy, not a bug',
    'in the command.',
  ]
  if (!enabled) {
    return [
      ...common,
      'This session has no proxy configured, so there is no retry to make: when a request fails that',
      'way, stop and say the host refuses browser requests.',
    ]
  }
  // The model needs a URL it can paste, so a template is resolved against a
  // placeholder it will replace rather than handed over with braces in it.
  const example = proxiedUrl('<url>', template) ?? `${template}<url>`
  return [
    ...common,
    `When that happens and the URL is public, retry it once as ${example}; if that also fails, stop`,
    'and say so. Never send a request carrying a credential — an API key, a token, a cookie —',
    'through the proxy: it is a third party and it sees the whole request.',
  ]
}

/** What a model reaches for first and will not find. */
const MISSING = 'grep, sed, awk, find, wc, printf, cut, tr, diff, patch, tar, gzip, git, date, seq, tee, basename, dirname, xargs, test'

/**
 * What the model is told the tool is.
 *
 * Written as instructions rather than as prose, and ordered by how expensive
 * the mistake is: the constructs that fail silently first, the ones that fail
 * loudly second, and what to do instead last. Every claim in it was measured
 * against the container this build ships.
 * @param background - whether background execution is offered.
 * @returns the tool description.
 */
function jshDescription(background: boolean): string {
  return [
    'Execute a command in this machine\'s shell and return its output.',
    '',
    'This is the only shell tool in this session; there is no `bash` tool. The shell is `jsh`, a',
    'JavaScript shell, and it is not POSIX. `/bin/bash`, `/bin/sh` and `/bin/zsh` are all the same',
    '`jsh` program, so naming one of them changes nothing. Read this before writing a command.',
    '',
    'NEVER use these. jsh accepts them, expands them to the empty string, and exits 0 — a wrong',
    'answer that looks like a right one:',
    '  `$(...)` and backticks   command substitution',
    '  `$((...))`               arithmetic',
    '  `${VAR:-default}` and every parameter expansion except plain `${VAR}`',
    '',
    'NEVER use these. jsh reports a syntax error and the command does nothing:',
    '  `for`, `while`, `if`, `case`, and shell functions',
    '  `<` input redirection, and `<<` heredocs',
    '  `[ ... ]` and `test`',
    '',
    `Available commands, and no others: ${COMMANDS}.`,
    `Not installed: ${MISSING}.`,
    '',
    'Working syntax: `;` `&&` `||` `|` `>` `>>` `&` `( )`, `#` comments, `VAR=value`, `export`,',
    '`${VAR}`, globs, single and double quotes, `$?`, and multi-line scripts.',
    '',
    'Do anything else in a language. A loop, a condition, arithmetic, text processing, or a search',
    'belongs in one of these, not in a pipeline:',
    '  `node -e \'...\'`      Node v22 with its whole standard library. `npm install` works: the',
    '                      registry is reachable. This is the one to reach for.',
    '  `python3 -c \'...\'`   CPython 3.14 (Pyodide, WebAssembly) and the standard library, minus',
    '                      what needs an operating system: no `multiprocessing`, `venv` or',
    '                      `ensurepip`. `pip install <name>` works for pure-Python wheels on PyPI',
    '                      and for the ~350 packages Pyodide builds (numpy, pandas, scipy, sympy).',
    '                      Write `python3`, never `python`: jsh aliases `python` to `python3` and',
    '                      loses the quoting doing it, so `python -c "print(1)"` is a syntax error.',
    '                      No threads and no sockets: `Thread.start` and `urllib.request.urlopen`',
    '                      (so `requests` too) raise, and `subprocess` and `os.popen` cannot start',
    '                      anything. `os.system("...")` is the exception and does work — it runs',
    '                      the command in this same jsh, without capturing its output. To fetch a',
    '                      URL from Python, `asyncio.run` a `pyodide.http.pyfetch` coroutine; it',
    '                      goes through the browser, so the CORS paragraph below applies to it.',
    '                      Starting it costs ~3s per command, and the first call in a session also',
    '                      downloads the 14 MB interpreter — so put a whole task in one call, and',
    '                      give the first one room.',
    '  `jq`                for JSON on the command line.',
    'For reading, writing, editing, and searching files, prefer the dedicated tools over any shell',
    'command — they are faster here and they do not go through jsh at all.',
    '',
    ...corsAdvice(),
    'Use `node -e "fetch(...)"` rather than `curl`: the `curl` here is a stub that takes a URL and',
    'little else.',
    '',
    'Each call runs in a fresh shell: no state (cwd, variables) persists between calls — pass',
    '`workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`; check the',
    'marker on every result. Long output is truncated to its tail, and the full output is saved to',
    'a file whose path is reported when available.',
    background
      ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
      : 'Background execution is not available; long-running commands must finish within the timeout.',
  ].join('\n')
}

/** One collected stream, with its truncation notice folded into the text. */
function streamText(output: { text: string, truncated: boolean, spillPath?: string }): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** The outcome of one finished run. */
interface RunOutcome {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: { text: string, truncated: boolean, spillPath?: string }
  stderr: { text: string, truncated: boolean, spillPath?: string }
  sandbox?: { mode: string, denied: boolean }
}

/**
 * Shape one finished run into the text the model reads.
 *
 * The same shape `tool-bash` produces, deliberately: stdout, then a marked
 * stderr section, then the exit markers. Everything downstream — the terminal
 * card in the surface, the transcript, the model's own habits — is built around
 * those markers, and a tool that reported its results differently would be a
 * second thing to learn for no gain.
 * @param result - the completed run.
 * @returns the model-facing text.
 */
function renderResult(result: RunOutcome): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.sandbox?.denied === true) markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  if (result.timedOut) markers.push(`[timed out after ${String(result.timeoutMs)}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  markers.push(`[exit code: ${String(result.exitCode ?? 0)}]`)
  return `${body.replace(/\n+$/, '')}\n${markers.join('\n')}`
}

/** One collected stream, as plain data. */
interface CanonicalStream {
  text: string
  truncated: boolean
  spillPath?: string
}

/** A finished foreground run, as the output schema declares it. */
interface CanonicalResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: CanonicalStream
  stderr: CanonicalStream
}

/** Detach the executor's result into plain data the output schema accepts. */
function canonical(result: RunOutcome): CanonicalResult {
  const stream = (value: CanonicalStream): CanonicalStream => ({
    text: value.text,
    truncated: value.truncated,
    ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath }),
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: result.timeoutMs,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
  }
}

/**
 * Resolve the working directory the same way the shipped bash tool does.
 * @param workdir - the caller's `workdir` argument.
 * @param root - the workspace root, when the sandbox policy names one.
 * @returns an absolute directory, or undefined to take the executor's default.
 */
function resolveWorkdir(workdir: string | undefined, root: string | undefined): string | undefined {
  if (workdir === undefined) return undefined
  if (workdir.startsWith('/')) return workdir
  if (root === undefined) return workdir
  return `${root.replace(/\/$/, '')}/${workdir}`
}

/**
 * Mount the row.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const shell = ctx.shell as unknown as {
    sandboxMode?: string
    resolve(request: Record<string, unknown>): Record<string, unknown>
    run(spec: Record<string, unknown>): Promise<RunOutcome>
    start(spec: Record<string, unknown>): {
      kill(): boolean
      done: Promise<void>
      exitCode: number | null
      signal: string | null
      status: string
      readOutput(): { delta: string, lossy: boolean, stdoutSpillPath?: string, stderrSpillPath?: string }
    }
  }
  const sandboxPolicy = ctx.get('sandboxPolicy') as { resolve(scope: Record<string, unknown>): { mode: string, workspaceRoot?: string } | undefined } | undefined
  const jobs = ctx.get('jobs') as {
    start(spec: Record<string, unknown>): string
  } | undefined
  const background = jobs !== undefined

  ctx.systemPrompt.section({
    name: 'tool:jsh',
    // The same slot the shipped bash section takes, because it is the same
    // advice and the model should not receive both.
    order: 105,
    text:
      'There is no `bash` tool in this session. The only shell is the `jsh` tool, and `jsh` is '
      + 'not a POSIX shell: `$(...)`, `$((...))`, `for`, `if`, `while`, `case`, functions, '
      + 'heredocs, `<`, and `[ ]` do not work, and the first two fail silently by expanding to '
      + 'nothing. Use `node -e` or `python3 -c` (CPython 3.14, with `pip`) for anything with '
      + 'logic in it, and check the [exit code: N] marker on every result.',
  })

  ctx.tools.register(defineTool({
    name: 'jsh',
    description: jshDescription(background),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The command to execute, in `jsh` — see the tool description for what jsh does and does not accept.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
      },
      ...(background
        ? {
            run_in_background: {
              type: 'boolean' as const,
              description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
            },
          }
        : {}),
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
            },
          },
        ],
      },
      render: (_args: unknown, value: Record<string, unknown>) => [{
        type: 'text' as const,
        text: value.kind === 'background'
          ? `started background job ${String(value.jobId)}`
          : renderResult(value as unknown as RunOutcome),
      }],
    },

    async execute(
      args: { command: string, description: string, timeoutMs?: number, workdir?: string, run_in_background?: boolean },
      exec: { signal: AbortSignal, agent?: unknown },
    ): Promise<{ kind: 'background', jobId: string } | ({ kind: 'foreground' } & CanonicalResult)> {
      const command = String(args.command ?? '')
      if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      if (String(args.description ?? '').trim().length === 0) throw new Error('invalid description: expected a non-empty string')

      const policy = sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: (exec.agent as { session: unknown }).session })
      const workdir = resolveWorkdir(args.workdir, policy?.workspaceRoot)
      const request: Record<string, unknown> = {
        command,
        ...(workdir === undefined ? {} : { workdir }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        dshEnv: (ctx as unknown as { shellEnv: { collect(exec: unknown): unknown } }).shellEnv.collect(exec),
        ...(policy === undefined ? {} : { sandboxPolicy: policy }),
      }

      if (args.run_in_background === true) {
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        return {
          kind: 'background' as const,
          jobId: jobs.start({
            kind: 'jsh',
            label: command,
            ...(exec.agent === undefined ? {} : { owner: exec.agent }),
            run: () => {
              const proc = shell.start(shell.resolve(request))
              return {
                cancel: () => void proc.kill(),
                done: proc.done.then(() => ({
                  status: proc.status === 'killed' ? 'killed' : 'completed',
                  detail: proc.status === 'killed'
                    ? (proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit')
                    : `exit code: ${String(proc.exitCode ?? 0)}`,
                })),
                readOutput: () => {
                  const read = proc.readOutput()
                  if (!read.lossy) return read.delta
                  const spills = [read.stdoutSpillPath, read.stderrSpillPath].filter(path => path !== undefined)
                  const where = spills.length > 0 ? `; full output: ${spills.join(', ')}` : ''
                  return `${read.delta}\n[output truncated${where}]`
                },
              }
            },
          }),
        }
      }

      const result = await shell.run(shell.resolve({ ...request, signal: exec.signal }))
      if ((result as unknown as { aborted: boolean }).aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonical(result) }
    },

    /**
     * Draw a finished run as a terminal, the way the shipped bash tool does.
     *
     * The exit markers `renderResult` appends are what the surface's terminal
     * card reads to show its status pill, so parsing them back out here is what
     * keeps this tool looking like the tool it replaced.
     */
    presentResult: (args: unknown, result: { content: { type: string, text?: string }[], isError?: boolean }) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text ?? ''
      const isBackground = typeof args === 'object' && args !== null
        && (args as { run_in_background?: unknown }).run_in_background === true
      if (isBackground || result.isError === true) {
        return {
          card: 'generic' as const,
          content: [{ type: 'text' as const, text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
        }
      }
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal' as const, output: body, ...exit }
    },

    presentCall: (args: Record<string, unknown>) => (args.run_in_background === true
      ? {
          card: 'generic' as const,
          title: String(args.command),
          kind: 'execute' as const,
          rawInput: String(args.command),
          content: [{ type: 'text' as const, text: String(args.description) }],
        }
      : {
          card: 'terminal' as const,
          title: String(args.command),
          description: String(args.description),
          ...(args.workdir === undefined ? {} : { cwd: String(args.workdir) }),
        }),
  }))
}

export default { apply, inject, name }
