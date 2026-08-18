/**
 * `node` — a real JavaScript runtime in the terminal.
 *
 * There is no Node binary here, but there is very nearly a Node *platform*:
 * `src/node/` implements the builtins over the virtual filesystem, and the
 * plugin loader already evaluates CommonJS and ES modules out of that
 * filesystem with Node's own resolution rules. `node script.js` is those two
 * facts joined up — the script runs in this realm, against the same `fs`,
 * `process`, and `child_process` the agent's tools use, so what it does is
 * visible to everything else in the page.
 *
 * What it is not is a separate process. A script that never returns blocks the
 * page rather than a thread, so the shell's own cancellation is what bounds it.
 */

import type { CommandContext } from './runtime.ts'
import { importVfsModule } from '../plugins/esm-loader.ts'
import { volume } from '../vfs/volume.ts'
import { toText, toBytes } from '../node/binary.ts'
import { process as processShim } from '../node/process.ts'
import { resolve as resolvePath, dirname } from '../node/path.ts'

/** Where `node -p` parks the expression's value for the command to read back. */
const RESULT_KEY = '__dshNodePrintResult'

/**
 * Distinguishes one `-e`/`-p` program from the next.
 *
 * The module loader caches by path, which is right for a real module and wrong
 * for a scratch program: two `node -e` calls would otherwise be the same path,
 * and the second would return the first's cached namespace without running.
 */
let evalCounter = 0

/** Node's reported version. Nothing here is 24.x, but the shape callers parse is. */
export const NODE_VERSION = 'v22.0.0'

/** Resolve a script argument against the shell's cwd. */
function scriptPath(context: CommandContext, spelled: string): string {
  return spelled.startsWith('/') ? spelled : resolvePath(context.shell.cwd, spelled)
}

/**
 * Run a body with `console` and `process.argv` pointed at this command.
 *
 * The realm is shared, so the redirection has to be undone afterwards or the
 * next `console.log` anywhere in the page would land in a terminal that is no
 * longer listening.
 * @param context - the command context supplying the streams.
 * @param argv - what `process.argv` should read as.
 * @param body - the work to run.
 * @returns the body's result.
 */
async function withConsole<T>(context: CommandContext, argv: string[], body: () => Promise<T>): Promise<T> {
  // A script resolves its relative paths against `process.cwd()`, not against
  // the shell's idea of a directory, so the two have to agree for the duration
  // or `fs.writeFileSync('out.txt')` lands somewhere the next `cat` cannot see.
  const realCwd = processShim.cwd()
  try {
    processShim.chdir(context.shell.cwd)
  } catch {
    // The shell's cwd was removed underneath it; the script gets the old one.
  }
  const realConsole = globalThis.console
  const format = (args: unknown[]): string =>
    `${args.map(value => (typeof value === 'string' ? value : inspect(value))).join(' ')}\n`
  const patched = Object.create(realConsole) as Console
  patched.log = (...args: unknown[]) => { context.stdout.write(format(args)) }
  patched.info = patched.log
  patched.debug = patched.log
  patched.warn = (...args: unknown[]) => { context.stderr.write(format(args)) }
  patched.error = patched.warn
  globalThis.console = patched

  const realArgv = processShim.argv
  processShim.argv = argv
  try {
    return await body()
  } finally {
    globalThis.console = realConsole
    processShim.argv = realArgv
    try {
      processShim.chdir(realCwd)
    } catch {
      // The directory disappeared while the script ran; nothing to restore to.
    }
  }
}

/** A readable rendering of a value, close enough to `util.inspect` for a terminal. */
function inspect(value: unknown, depth = 0): string {
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${String(value)}n`
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value !== 'object') return String(value)
  if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]'
  if (Array.isArray(value)) return `[ ${value.map(item => inspect(item, depth + 1)).join(', ')} ]`
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{ ${entries.map(([key, item]) => `${key}: ${inspect(item, depth + 1)}`).join(', ')} }`
}

/**
 * `node`.
 * @param context - the command context.
 * @returns the process exit status.
 */
export async function nodeCommand(context: CommandContext): Promise<number> {
  const args = context.argv.slice(1)

  if (args.length === 0 && context.stdin === '') {
    context.stderr.write('node: this build has no REPL; pass a script, `-e <code>`, or pipe a program on stdin\n')
    return 1
  }
  if (args[0] === '-v' || args[0] === '--version') {
    context.stdout.write(`${NODE_VERSION}\n`)
    return 0
  }

  let source: string | undefined
  let printResult = false
  let file: string | undefined
  const rest: string[] = []

  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '-e' || argument === '--eval') { source = args[++i] ?? ''; continue }
    if (argument === '-p' || argument === '--print') { source = args[++i] ?? ''; printResult = true; continue }
    if (argument === '-') { source = context.stdin; continue }
    // Flags this runtime has no equivalent for are accepted and ignored rather
    // than failing a command line that would otherwise work.
    if (argument.startsWith('-') && file === undefined && source === undefined) continue
    if (file === undefined && source === undefined) file = argument
    else rest.push(argument)
  }
  if (source === undefined && file === undefined && context.stdin !== '') source = context.stdin

  try {
    if (source !== undefined) {
      // `-e`/`-p` run in the module scope a one-off script gets: a real file
      // under the cwd, so relative `require` resolves the way the user expects.
      const scratch = resolvePath(context.shell.cwd, `.dsh-node-eval-${String(evalCounter++)}.cjs`)
      // The printed value travels through a global rather than `module.exports`:
      // reassigning that binding wholesale does not reach the evaluator's own
      // record, so the result would come back empty.
      const body = printResult ? `globalThis[${JSON.stringify(RESULT_KEY)}] = (${source})` : source
      volume.mkdirp(dirname(scratch))
      volume.writeFile(scratch, toBytes(body))
      try {
        await withConsole(context, ['node', '[eval]', ...rest], () => importVfsModule(scratch))
        if (printResult) {
          const realm = globalThis as Record<string, unknown>
          context.stdout.write(`${inspect(realm[RESULT_KEY])}\n`)
          delete realm[RESULT_KEY]
        }
      } finally {
        volume.rm(scratch, { force: true })
      }
      return 0
    }

    const path = scriptPath(context, file!)
    const target = volume.exists(path)
      ? path
      : [`${path}.js`, `${path}.cjs`, `${path}.mjs`, `${path}/index.js`].find(candidate => volume.exists(candidate))
    if (target === undefined) {
      context.stderr.write(`node: cannot find module '${file!}'\n`)
      return 1
    }
    if (volume.statNode(target, true).kind === 'dir') {
      context.stderr.write(`node: '${file!}' is a directory\n`)
      return 1
    }
    await withConsole(context, ['node', target, ...rest], () => importVfsModule(target))
    return 0
  } catch (error) {
    // A script's own throw is the ordinary case, and its stack is the useful
    // part; a loader failure reads the same way from the terminal.
    context.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}

/** Read a JSON file from the VFS, or undefined when absent or malformed. */
export function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!volume.exists(path)) return undefined
  try {
    return JSON.parse(toText(volume.readFile(path))) as Record<string, unknown>
  } catch {
    return undefined
  }
}
