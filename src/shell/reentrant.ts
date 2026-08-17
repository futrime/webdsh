/**
 * Commands that run other commands.
 *
 * `xargs` and `timeout` are ordinary applets everywhere except in one respect:
 * they have to execute a command line, which means re-entering the interpreter
 * that is already running them. A table of applets built once at module scope
 * cannot hold them — it has no interpreter to call — so they are registered per
 * run, against the live one.
 *
 * Keeping them here rather than in each host's setup is what stops `timeout`
 * from reaching for the page's `runShell`: doing that pulled the entire
 * application into any bundle that contained the shell, including the one meant
 * to be a small program inside the container.
 */

import type { Interpreter } from './interpreter.ts'
import { coreutils } from './coreutils.ts'
import { BufferSink, type CommandImpl, type ShellState } from './runtime.ts'

/** Quote a token so re-entering the parser cannot reinterpret it. */
function quote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`
}

/**
 * Register the commands that need to call the interpreter back.
 * @param interpreter - the running interpreter.
 * @param state - its state, whose command table receives the registrations.
 */
export function registerReentrant(interpreter: Interpreter, state: ShellState): void {
  const xargs: CommandImpl = async (context) => {
    // `xargs` options stop at the first word that is not one, and everything
    // after that belongs to the command being run. Parsing the whole argv with
    // a generic option parser stole the command's own flags: `xargs wc -l`
    // reached `wc` as a bare `wc`, which counts lines, words, and bytes.
    let index = 1
    let nulSeparated = false
    let batchSize: number | undefined
    let placeholder: string | undefined
    for (; index < context.argv.length; index++) {
      const token = context.argv[index]
      if (token === '-0' || token === '--null') { nulSeparated = true; continue }
      if (token === '-r' || token === '--no-run-if-empty') continue
      if (token === '-n') { batchSize = Number(context.argv[++index]); continue }
      if (token === '-I') { placeholder = context.argv[++index]; continue }
      if (/^-n\d+$/.test(token)) { batchSize = Number(token.slice(2)); continue }
      if (/^-I./.test(token)) { placeholder = token.slice(2); continue }
      break
    }

    const items = context.stdin.split(nulSeparated ? '\0' : /\s+/).filter(item => item.length > 0)
    if (items.length === 0) return 0
    const base = context.argv.slice(index)
    const command = base.length > 0 ? base : ['echo']
    const size = batchSize ?? (placeholder === undefined ? items.length : 1)
    let status = 0
    for (let at = 0; at < items.length; at += size) {
      const batch = items.slice(at, at + size)
      const argv = placeholder === undefined
        ? [...command, ...batch]
        : command.map(token => token.replaceAll(placeholder, batch[0]))
      const result = await interpreter.run(argv.map(quote).join(' '), {
        stdin: '', stdout: context.stdout, stderr: context.stderr,
      })
      if (result !== 0) status = result
    }
    return status
  }

  const timeout: CommandImpl = async (context) => {
    const args = context.argv.slice(1).filter(argument => !argument.startsWith('-'))
    const seconds = Number(args[0])
    if (!Number.isFinite(seconds) || args.length < 2) {
      context.stderr.write('timeout: usage: timeout DURATION COMMAND [ARG]...\n')
      return 125
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, seconds * 1000)
    // A command cut short says so on stderr, which is right when a person
    // pressed Ctrl+C and wrong here: the deadline was the point, and `timeout`
    // reports it through status 124 rather than as an error.
    const held: string[] = []
    const previous = state.signal
    state.signal = controller.signal
    try {
      const status = await interpreter.run(args.slice(1).map(quote).join(' '), {
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: { write: (text: string) => { held.push(text) } },
      })
      const noise = /^\s*(?:\w[\w.-]*: )?interrupted\s*$/
      for (const chunk of held) {
        if (controller.signal.aborted && noise.test(chunk)) continue
        context.stderr.write(chunk)
      }
      return controller.signal.aborted ? 124 : status
    } finally {
      clearTimeout(timer)
      state.signal = previous
    }
  }

  /**
   * `find … -exec CMD {} \;` — the one predicate that runs something.
   *
   * `find` itself cannot: it is a table of applets with no way back into the
   * interpreter. So the action is split off here, the search delegated to the
   * ordinary `find` with `-print0` appended, and the command run once per match
   * (`\;`) or once with all of them (`+`), which is what the two terminators
   * mean.
   */
  const find: CommandImpl = async (context) => {
    const argv = context.argv
    const at = argv.indexOf('-exec')
    if (at === -1) return coreutils.find(context)

    const terminator = argv.findIndex((token, index) => index > at && (token === ';' || token === '+'))
    if (terminator === -1) {
      context.stderr.write("find: missing terminator to -exec (expected ';' or '+')\n")
      return 2
    }
    const template = argv.slice(at + 1, terminator)
    const batched = argv[terminator] === '+'

    const found = new BufferSink()
    const status = await coreutils.find({
      ...context,
      argv: [...argv.slice(0, at), '-print0'],
      stdout: found,
    })
    const matches = found.text().split('\0').filter(path => path !== '')
    if (matches.length === 0) return status

    const run = async (paths: string[]): Promise<number> => {
      // `{}` stands for the path; with `+` a trailing `{}` takes all of them.
      const argvOut = template.flatMap(token => (token === '{}' ? paths : [token]))
      return interpreter.run(argvOut.map(quote).join(' '), {
        stdin: '', stdout: context.stdout, stderr: context.stderr,
      })
    }

    let worst = status
    if (batched) {
      const result = await run(matches)
      if (result !== 0) worst = result
      return worst
    }
    for (const match of matches) {
      const result = await run([match])
      if (result !== 0) worst = result
    }
    return worst
  }

  state.commands.set('xargs', xargs)
  state.commands.set('timeout', timeout)
  state.commands.set('find', find)
}
