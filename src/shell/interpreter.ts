/**
 * The shell interpreter: expansion, redirection, pipelines, control flow, and
 * command dispatch.
 *
 * Pipelines run stage by stage with a fully buffered pipe rather than truly
 * concurrently. For an agent's `bash` tool — which reads the whole output
 * anyway — the observable difference is confined to unbounded producers
 * (`yes | head`), which the {@link BufferSink} cap turns into a truncated
 * result instead of a hang.
 */

import type { Case, For, FunctionDef, Group, If, List, Node, Pipeline, Redirect, Sequence, SimpleCommand, While, Word, WordPart } from './ast.ts'
import { parseScript, ShellSyntaxError } from './parser.ts'
import {
  BufferSink, ExitSignal, LoopSignal, ReturnSignal, assertWritable, nullSink,
  type CommandContext, type InputCursor, type ShellState, type Sink,
} from './runtime.ts'
import { basename, dirname, isAbsolute, resolve as resolvePath } from '../vfs/path.ts'
import { globToRegExp } from '../node/path.ts'
import { toText, toBytes } from '../node/binary.ts'

/** Field separator; the shell reads `$IFS` but the default is what dsh scripts use. */
const DEFAULT_IFS = ' \t\n'

/** Distinguishes one process substitution's file from another's. */
let procsubCounter = 0

/** The characters that make a field a glob pattern, when written unquoted. */
const GLOB_CHARACTERS = /[*?[]/

/**
 * Expand `{a,b,c}` and `{1..5}` into the words they stand for.
 *
 * Brace expansion happens before anything else a shell does to a word, and it
 * is textual: it does not consult the filesystem, so `mkdir -p src/{a,b}`
 * creates two directories whether or not they exist. Only braces written
 * literally and unquoted are expanded, which is why the caller tracks that.
 * @param text - one field.
 * @returns the fields it expands to, in order.
 */
function expandBraces(text: string): string[] {
  const open = text.indexOf('{')
  if (open === -1) return [text]

  // Find the brace this one closes, ignoring nested pairs.
  let depth = 0
  let close = -1
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++
    else if (text[index] === '}') {
      depth--
      if (depth === 0) { close = index; break }
    }
  }
  if (close === -1) return [text]

  const prefix = text.slice(0, open)
  const body = text.slice(open + 1, close)
  const suffix = text.slice(close + 1)

  // `{1..5}` and `{a..e}` are sequences rather than lists.
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(body)
  let options: string[]
  if (range !== null) {
    const numeric = /^-?\d+$/.test(range[1])
    const from = numeric ? Number(range[1]) : range[1].codePointAt(0)!
    const to = numeric ? Number(range[2]) : range[2].codePointAt(0)!
    const step = from <= to ? 1 : -1
    options = []
    for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
      options.push(numeric ? String(value) : String.fromCodePoint(value))
    }
  } else {
    // Split on commas at the top level only.
    options = []
    let current = ''
    let nesting = 0
    for (const character of body) {
      if (character === '{') nesting++
      if (character === '}') nesting--
      if (character === ',' && nesting === 0) { options.push(current); current = ''; continue }
      current += character
    }
    options.push(current)
    // A brace with nothing to choose between is literal, as bash treats it.
    if (options.length < 2) return expandBraces(`${prefix}{${body}}${suffix}`.replace('{', '\u0000')).map(part => part.replace('\u0000', '{'))
  }

  return options.flatMap(option => expandBraces(`${prefix}${option}${suffix}`))
}

/** Where a command's three streams point after redirections are applied. */
interface Streams {
  stdin: string
  stdout: Sink
  stderr: Sink
  /**
   * How much of {@link Streams.stdin} has been consumed.
   *
   * `read` takes a line and leaves the rest for the next caller, which is what
   * makes `while read line` terminate — and, before this existed, what made it
   * re-read the first line until the loop guard stopped it. The cursor lives on
   * the streams rather than in the string so that every command in a loop body
   * shares one position.
   */
  input?: InputCursor
}

/** Executes a parsed script against a {@link ShellState}. */
export class Interpreter {
  constructor(private readonly state: ShellState) {}

  /**
   * What each running function has declared `local`, and what it shadowed.
   *
   * Restored when the function returns, which is what makes a local variable
   * local — without it, a helper that uses `local i` as a loop counter
   * overwrites its caller's `i`.
   */
  private readonly localFrames: Map<string, string | undefined>[] = []

  /** Commands to run when the script finishes, most recently installed last. */
  private exitTraps: string[] = []

  /** Depth of nested `run` calls; traps fire only when the outermost returns. */
  private running = 0

  /**
   * Install an `EXIT` trap.
   * @param command - the shell text to run when the script ends.
   */
  onExit(command: string): void {
    if (command === '' || command === '-') this.exitTraps = []
    else this.exitTraps.push(command)
  }

  /**
   * Record a name as local to the running function.
   * @param name - the variable being shadowed.
   */
  declareLocal(name: string): void {
    const frame = this.localFrames[this.localFrames.length - 1]
    if (frame === undefined || frame.has(name)) return
    frame.set(name, this.state.vars.get(name))
  }

  /**
   * Run a script source.
   * @param source - shell text.
   * @param streams - the top-level stdin/stdout/stderr.
   * @returns the final exit status.
   */
  async run(source: string, streams: Streams): Promise<number> {
    // Every entry point gets a cursor, so `read` consumes from the same place
    // no matter which of them started the script.
    if (streams.input === undefined) streams = { ...streams, input: { text: streams.stdin, offset: 0 } }
    this.running++
    let tree: Node
    try {
      tree = parseScript(source)
    } catch (error) {
      const message = error instanceof ShellSyntaxError ? error.message : String(error)
      streams.stderr.write(`sh: ${message}\n`)
      return 2
    }
    try {
      return await this.exec(tree, streams)
    } catch (signal) {
      if (signal instanceof ExitSignal) return signal.status
      if (signal instanceof ReturnSignal) return signal.status
      if (signal instanceof LoopSignal) return 0
      throw signal
    } finally {
      this.running--
      // Run at the end of the outermost script only, and cleared first so a
      // trap that exits cannot re-enter itself.
      if (this.running === 0) {
        const traps = this.exitTraps
        this.exitTraps = []
        for (const command of traps) await this.run(command, streams)
      }
    }
  }

  // ---- node dispatch -------------------------------------------------------

  /** Execute one node. */
  private async exec(node: Node, streams: Streams): Promise<number> {
    this.state.signal?.throwIfAborted()
    // Command substitution keeps the ambient stderr rather than swallowing it.
    this.currentStderr = streams.stderr
    switch (node.type) {
      case 'sequence': return this.execSequence(node, streams)
      case 'list': return this.execList(node, streams)
      case 'pipeline': return this.execPipeline(node, streams)
      case 'simple': return this.execSimple(node, streams)
      case 'if': return this.execIf(node, streams)
      case 'for': return this.execFor(node, streams)
      case 'while': return this.execWhile(node, streams)
      case 'case': return this.execCase(node, streams)
      case 'function': return this.execFunctionDef(node)
      case 'group': return this.execGroup(node, streams)
    }
  }

  private async execSequence(node: Sequence, streams: Streams): Promise<number> {
    let status = 0
    for (const statement of node.statements) {
      status = await this.exec(statement, streams)
      this.state.status = status
      if (this.state.options.errexit && status !== 0) throw new ExitSignal(status)
    }
    return status
  }

  private async execList(node: List, streams: Streams): Promise<number> {
    if (node.operator === '&') {
      // No job control in the browser: run it inline, which is what a
      // synchronous transcript needs anyway.
      return this.exec(node.left, streams)
    }
    const left = await this.exec(node.left, streams)
    this.state.status = left
    if (node.right === undefined) return left
    if (node.operator === '&&' && left !== 0) return left
    if (node.operator === '||' && left === 0) return left
    const right = await this.exec(node.right, streams)
    this.state.status = right
    return right
  }

  private async execPipeline(node: Pipeline, streams: Streams): Promise<number> {
    let input = streams.stdin
    let status = 0
    const statuses: number[] = []
    for (let i = 0; i < node.commands.length; i++) {
      const last = i === node.commands.length - 1
      const buffer = last ? undefined : new BufferSink()
      // Every stage of a pipeline runs in its own subshell, so a `cd` or an
      // assignment inside one is not visible after it — `V=1; echo x | { V=2; }`
      // leaves `V` at 1, as it does in any other shell.
      const stage = node.commands[i]
      status = await this.isolated(async () => this.exec(stage, {
        stdin: input,
        stdout: buffer ?? streams.stdout,
        stderr: streams.stderr,
        input: { text: input, offset: 0 },
      }))
      statuses.push(status)
      if (buffer !== undefined) input = buffer.text()
    }
    if (this.state.options.pipefail) {
      const failure = statuses.find(each => each !== 0)
      if (failure !== undefined) status = failure
    }
    return node.negated ? (status === 0 ? 1 : 0) : status
  }

  private async execIf(node: If, streams: Streams): Promise<number> {
    const condition = await this.exec(node.condition, { ...streams, stdout: streams.stdout })
    if (condition === 0) return this.exec(node.then, streams)
    if (node.else !== undefined) return this.exec(node.else, streams)
    return 0
  }

  private async execFor(node: For, streams: Streams): Promise<number> {
    const applied = await this.applyRedirects(node.redirects ?? [], streams)
    try {
      return await this.runFor(node, applied.streams)
    } finally {
      applied.commit()
    }
  }

  /** The loop itself, once its redirections are in place. */
  private async runFor(node: For, streams: Streams): Promise<number> {
    const items = node.usesPositional
      ? this.state.positional
      : (await Promise.all(node.words.map(word => this.expandWord(word)))).flat()
    let status = 0
    for (const item of items) {
      this.state.vars.set(node.name, item)
      try {
        status = await this.exec(node.body, streams)
      } catch (signal) {
        if (signal instanceof LoopSignal) {
          if (signal.levels > 1) {
            signal.levels--
            throw signal
          }
          if (signal.kind === 'break') break
          continue
        }
        throw signal
      }
    }
    return status
  }

  private async execWhile(node: While, streams: Streams): Promise<number> {
    const applied = await this.applyRedirects(node.redirects ?? [], streams)
    try {
      return await this.runWhile(node, applied.streams)
    } finally {
      applied.commit()
    }
  }

  /** The loop itself, once its redirections are in place. */
  private async runWhile(node: While, streams: Streams): Promise<number> {
    let status = 0
    // A bounded loop count keeps a mistaken `while true` from wedging the tab;
    // the tool's own timeout is the other guard.
    for (let iteration = 0; iteration < 1_000_000; iteration++) {
      this.state.signal?.throwIfAborted()
      const condition = await this.exec(node.condition, streams)
      const proceed = node.until ? condition !== 0 : condition === 0
      if (!proceed) break
      try {
        status = await this.exec(node.body, streams)
      } catch (signal) {
        if (signal instanceof LoopSignal) {
          if (signal.levels > 1) {
            signal.levels--
            throw signal
          }
          if (signal.kind === 'break') break
          continue
        }
        throw signal
      }
      // Yield to the event loop so a long loop cannot starve the UI.
      if (iteration % 64 === 63) await new Promise(done => { setTimeout(done, 0) })
    }
    return status
  }

  private async execCase(node: Case, streams: Streams): Promise<number> {
    const subject = (await this.expandWord(node.word)).join(' ')
    for (const branch of node.branches) {
      for (const pattern of branch.patterns) {
        const text = (await this.expandWord(pattern, { noGlob: true })).join(' ')
        if (text === '*' || globToRegExp(text).test(subject)) {
          return this.exec(branch.body, streams)
        }
      }
    }
    return 0
  }

  private execFunctionDef(node: FunctionDef): number {
    this.state.functions.set(node.name, node.body)
    return 0
  }

  private async execGroup(node: Group, streams: Streams): Promise<number> {
    const applied = await this.applyRedirects(node.redirects, streams)
    try {
      if (!node.subshell) return await this.exec(node.body, applied.streams)
      return await this.isolated(() => this.exec(node.body, applied.streams))
    } finally {
      applied.commit()
    }
  }

  /**
   * Run something as a subshell: its state changes and its `exit` stay inside.
   *
   * A subshell is a separate process in a real shell, so `cd`, assignments, and
   * `exit` cannot reach the parent. `exit` is the one that bites: `(exit 5)`
   * ending the whole script rather than just the subshell means a guard clause
   * inside parentheses takes the script down with it.
   * @param body - what to run.
   * @returns the status the subshell ended with.
   */
  private async isolated(body: () => Promise<number>): Promise<number> {
    const saved = {
      cwd: this.state.cwd,
      vars: new Map(this.state.vars),
      exported: new Set(this.state.exported),
      functions: new Map(this.state.functions),
    }
    try {
      return await body()
    } catch (signal) {
      if (signal instanceof ExitSignal) return signal.status
      throw signal
    } finally {
      // Restored in place rather than by assigning fresh collections. A caller
      // may already hold the map — `V=$(… | …)` resolves `state.vars.set`
      // before awaiting the substitution — and swapping the object out from
      // under it sends the assignment to a map nothing reads again.
      this.state.cwd = saved.cwd
      this.state.vars.clear()
      for (const [name, value] of saved.vars) this.state.vars.set(name, value)
      this.state.exported.clear()
      for (const name of saved.exported) this.state.exported.add(name)
      this.state.functions.clear()
      for (const [name, body_] of saved.functions) this.state.functions.set(name, body_)
    }
  }

  /**
   * Perform one assignment, honouring `NAME+=value`.
   * @param assignment - the parsed assignment.
   */
  private async assign(assignment: { name: string, value: Word, append?: boolean, array?: Word[] }): Promise<void> {
    if (assignment.array !== undefined) {
      const elements: string[] = []
      for (const element of assignment.array) elements.push(...await this.expandWord(element))
      const previous = assignment.append === true ? this.state.arrays.get(assignment.name) ?? [] : []
      this.state.arrays.set(assignment.name, [...previous, ...elements])
      // An array's first element is what the bare name expands to.
      this.state.vars.set(assignment.name, [...previous, ...elements][0] ?? '')
      return
    }
    const text = (await this.expandWord(assignment.value, { noGlob: true, noSplit: true })).join('')
    const previous = assignment.append === true ? this.state.vars.get(assignment.name) ?? '' : ''
    this.state.vars.set(assignment.name, previous + text)
  }

  // ---- simple commands -----------------------------------------------------

  private async execSimple(node: SimpleCommand, streams: Streams): Promise<number> {
    const words: string[] = []
    for (const word of node.words) {
      // `[[ … ]]` keeps its words as written: `[[ $f == *.ts ]]` compares
      // against the pattern, and would otherwise compare against whatever
      // filenames the pattern happened to match.
      words.push(...await this.expandWord(word, node.conditional === true ? { noGlob: true, noSplit: true } : {}))
    }

    if (words.length === 0) {
      // Assignment-only command: the assignments persist.
      for (const assignment of node.assignments) {
        await this.assign(assignment)
      }
      return 0
    }

    const applied = await this.applyRedirects(node.redirects, streams)
    // Assignments in a command prefix are scoped to that command.
    const savedVars = new Map<string, string | undefined>()
    for (const assignment of node.assignments) {
      savedVars.set(assignment.name, this.state.vars.get(assignment.name))
      await this.assign(assignment)
      this.state.exported.add(assignment.name)
    }

    if (this.state.options.xtrace) applied.streams.stderr.write(`+ ${words.join(' ')}\n`)

    try {
      return await this.dispatch(words, applied.streams)
    } finally {
      for (const [name, value] of savedVars) {
        if (value === undefined) this.state.vars.delete(name)
        else this.state.vars.set(name, value)
      }
      applied.commit()
    }
  }

  /** Resolve and run a command name: function, builtin, registered command, or VFS script. */
  private async dispatch(words: string[], streams: Streams): Promise<number> {
    const [name, ...args] = words

    const fn = this.state.functions.get(name)
    if (fn !== undefined) return this.callFunction(name, fn as Node, args, streams)

    // A command reads what is left, not what arrived: an earlier `read` in the
    // same loop body may already have taken some of it.
    const context = (): CommandContext => ({
      argv: words,
      shell: this.state,
      ...streams,
      stdin: streams.input === undefined ? streams.stdin : streams.input.text.slice(streams.input.offset),
      signal: this.state.signal,
    })

    const builtin = builtins[name]
    if (builtin !== undefined) return builtin(this, context())

    const command = this.state.commands.get(name)
    if (command !== undefined) {
      try {
        return await command(context())
      } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof LoopSignal) throw error
        streams.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }

    const script = this.resolveExecutable(name)
    if (script !== undefined) return this.runScriptFile(script, args, streams)

    // Only reached when nothing this shell implements answers to the name, so a
    // host that has real executables gets the last word before the refusal.
    const external = this.state.external
    if (external !== undefined) {
      try {
        return await external(context())
      } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof LoopSignal) throw error
        streams.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }

    streams.stderr.write(`sh: ${name}: command not found\n`)
    return 127
  }

  /** Call a shell function with its own positional parameters. */
  private async callFunction(name: string, body: Node, args: string[], streams: Streams): Promise<number> {
    if (this.state.depth > 64) {
      streams.stderr.write(`sh: ${name}: maximum function nesting level exceeded\n`)
      return 1
    }
    const savedPositional = this.state.positional
    this.state.positional = args
    this.state.depth++
    this.localFrames.push(new Map())
    try {
      return await this.exec(body, streams)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.status
      throw signal
    } finally {
      const frame = this.localFrames.pop()
      for (const [name, previous] of frame ?? []) {
        if (previous === undefined) this.state.vars.delete(name)
        else this.state.vars.set(name, previous)
      }
      this.state.positional = savedPositional
      this.state.depth--
    }
  }

  /** Find an executable file for `name` on `$PATH` (or as a direct path). */
  private resolveExecutable(name: string): string | undefined {
    const candidates = name.includes('/')
      ? [this.absolute(name)]
      : (this.state.vars.get('PATH') ?? '').split(':').filter(Boolean).map(dir => `${dir}/${name}`)
    for (const candidate of candidates) {
      const node = this.state.volume.lookup(candidate)
      if (node?.kind === 'file' && (node.mode & 0o111) !== 0 && this.isShellScript(candidate)) return candidate
    }
    return undefined
  }

  /**
   * Whether an executable file is something this interpreter can run as source.
   *
   * Being executable and on `$PATH` is not enough. A native binary read as shell
   * source parses into garbage, and the first "word" of that garbage is what the
   * error then names — which is how `node -v` came back as
   * `sh: ????: command not found`. A `#!/usr/bin/env node` script is just as
   * wrong to interpret here, and far more likely: `npm` is one.
   *
   * So a file qualifies only if it is text and either carries no shebang — POSIX
   * says the current shell runs those — or names a shell in the one it has.
   * Everything else belongs to whatever can actually execute it.
   */
  private isShellScript(path: string): boolean {
    let head: Uint8Array
    try {
      head = this.state.volume.readFile(path).subarray(0, 256)
    } catch {
      return false
    }
    const text = toText(head)
    // The container marks an executable it provides itself with a placeholder
    // file — `/usr/local/bin/node` is four U+FFFD characters — so "no NUL byte"
    // is not enough to call something text. A replacement character means the
    // bytes were never text, and a control character means they are not source.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/.test(text)) return false
    if (!text.startsWith('#!')) return true
    const newline = text.indexOf('\n')
    const interpreter = newline === -1 ? text : text.slice(0, newline)
    return /(?:^|\/|\s)(?:ba|da|k|z)?sh(?:\s|$)/.test(interpreter)
  }

  /** Run a shebang script from the VFS in a nested interpreter. */
  private async runScriptFile(path: string, args: string[], streams: Streams): Promise<number> {
    const source = toText(this.state.volume.readFile(path))
    const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source
    const savedPositional = this.state.positional
    const savedName = this.state.scriptName
    this.state.positional = args
    this.state.scriptName = path
    try {
      return await this.run(body, streams)
    } finally {
      this.state.positional = savedPositional
      this.state.scriptName = savedName
    }
  }

  // ---- redirection ---------------------------------------------------------

  /**
   * Apply a command's redirections.
   * @returns the redirected streams plus a `commit` that flushes file targets.
   */
  private async applyRedirects(redirects: Redirect[], base: Streams): Promise<{ streams: Streams, commit: () => void }> {
    if (redirects.length === 0) return { streams: base, commit: () => {} }
    let { stdin, stdout, stderr } = base
    const commits: (() => void)[] = []

    for (const redirect of redirects) {
      const targetText = (await this.expandWord(redirect.target, { noSplit: true })).join('')
      if (redirect.op === '<<<') {
        stdin = `${targetText}\n`
        continue
      }
      if (redirect.op === '<<') {
        stdin = targetText
        continue
      }
      if (redirect.op === '<') {
        const path = this.absolute(targetText)
        try {
          stdin = toText(this.state.volume.readFile(path))
        } catch {
          stderr.write(`sh: ${targetText}: No such file or directory\n`)
          throw new ExitSignal(1)
        }
        continue
      }
      if (redirect.op === 'dup') {
        // `2>&1` and `1>&2`.
        if (redirect.fd === 2 && targetText === '1') stderr = stdout
        else if (redirect.fd === 1 && targetText === '2') stdout = stderr
        else if (targetText === '-') {
          if (redirect.fd === 1) stdout = nullSink
          else stderr = nullSink
        }
        continue
      }
      // File targets: `>`, `>>`, `&>`.
      if (targetText === '/dev/null') {
        if (redirect.op === '&>') {
          stdout = nullSink
          stderr = nullSink
        } else if (redirect.fd === 2) {
          stderr = nullSink
        } else {
          stdout = nullSink
        }
        continue
      }
      const path = this.absolute(targetText)
      try {
        assertWritable(this.state, path)
      } catch (error) {
        stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
        throw new ExitSignal(1)
      }
      const sink = new BufferSink()
      const append = redirect.op === '>>'
      commits.push(() => {
        const bytes = toBytes(sink.text())
        try {
          this.state.volume.mkdirp(dirname(path))
          if (append) this.state.volume.appendFile(path, bytes)
          else this.state.volume.writeFile(path, bytes)
        } catch (error) {
          base.stderr.write(`sh: ${targetText}: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      })
      if (redirect.op === '&>') {
        stdout = sink
        stderr = sink
      } else if (redirect.fd === 2) {
        stderr = sink
      } else {
        stdout = sink
      }
    }

    return {
      // A redirected standard input needs its own read position: keeping the
      // caller's would have `read` resuming in text the command never sees, and
      // `while read … done < file` re-reading the first line forever.
      streams: {
        stdin,
        stdout,
        stderr,
        ...(stdin === base.stdin ? { ...(base.input === undefined ? {} : { input: base.input }) } : { input: { text: stdin, offset: 0 } }),
      },
      commit: () => { for (const each of commits) each() },
    }
  }

  // ---- expansion -----------------------------------------------------------

  /**
   * Expand a word into fields.
   * @param word - the parsed word.
   * @param options - suppress globbing or field splitting (assignments, case patterns).
   * @returns the expanded fields.
   */
  async expandWord(word: Word, options: { noGlob?: boolean, noSplit?: boolean } = {}): Promise<string[]> {
    /** Fields under construction; `quoted` marks segments exempt from splitting. */
    const segments: { text: string, quoted: boolean, boundary?: boolean }[] = []
    for (const part of word) segments.push(...await this.expandPart(part))

    // Field splitting on unquoted whitespace.
    //
    // Each field also records whether any glob character in it was written
    // unquoted. Only those fields are candidates for pathname expansion:
    // `echo "*.txt"` prints `*.txt`, while `echo *.txt` lists files. Losing that
    // distinction meant every quoted pattern an agent passed to `grep`, `find`
    // or `sed` was silently replaced by whatever filenames happened to match —
    // `find . -path "./node_modules/*"` became a search for one real directory.
    const fields: { text: string, magic: boolean, braces: boolean }[] = []
    let current = ''
    let magic = false
    let braces = false
    let started = false
    const flush = (extra = ''): void => {
      fields.push({ text: current + extra, magic, braces })
      current = ''
      magic = false
      braces = false
    }
    for (const segment of segments) {
      // A boundary segment starts a new field even inside quotes.
      if (segment.boundary === true && started) {
        flush()
        started = false
      }
      if (segment.quoted || options.noSplit === true) {
        current += segment.text
        // A quoted segment contributes characters but never glob syntax; an
        // unquoted one under `noSplit` still can.
        if (!segment.quoted && GLOB_CHARACTERS.test(segment.text)) magic = true
        if (!segment.quoted && segment.text.includes('{')) braces = true
        started = true
        continue
      }
      let buffer = ''
      for (const char of segment.text) {
        if (DEFAULT_IFS.includes(char)) {
          if (buffer.length > 0 || started) {
            flush(buffer)
            buffer = ''
            started = false
          }
          continue
        }
        if (GLOB_CHARACTERS.test(char)) magic = true
        if (char === '{') braces = true
        buffer += char
        started = true
      }
      current += buffer
    }
    if (started || current.length > 0) flush()
    if (fields.length === 0 && segments.some(segment => segment.quoted)) fields.push({ text: '', magic: false, braces: false })

    if (options.noGlob === true) return fields.map(field => field.text)

    // Brace expansion, then pathname expansion over what it produced.
    const expanded: string[] = []
    for (const original of fields) {
      for (const text of original.braces ? expandBraces(original.text) : [original.text]) {
      const field = { ...original, text }
      if (!field.magic) {
        expanded.push(field.text)
        continue
      }
      const matches = this.glob(field.text)
      if (matches.length === 0) expanded.push(field.text)
      else expanded.push(...matches)
      }
    }
    return expanded
  }

  /** Expand one word part into quoted/unquoted segments. */
  private async expandPart(part: WordPart): Promise<{ text: string, quoted: boolean }[]> {
    switch (part.kind) {
      case 'literal': return [{ text: part.value, quoted: false }]
      case 'quoted': return [{ text: part.value, quoted: true }]
      case 'dquoted': {
        const inner: { text: string, quoted: boolean, boundary?: boolean }[] = []
        for (const nested of part.parts) inner.push(...await this.expandPart(nested))
        // Everything inside the quotes is one word — unless a `@` parameter put
        // a boundary in it, which is the one thing double quotes do not
        // suppress. Joining across it is what made `"$@"` a single argument.
        if (!inner.some(each => each.boundary === true)) {
          return [{ text: inner.map(each => each.text).join(''), quoted: true }]
        }
        const merged: { text: string, quoted: boolean, boundary?: boolean }[] = []
        for (const each of inner) {
          if (each.boundary === true || merged.length === 0) {
            merged.push({ text: each.text, quoted: true, ...(each.boundary === true ? { boundary: true } : {}) })
            continue
          }
          merged[merged.length - 1].text += each.text
        }
        return merged
      }
      case 'procsub': {
        // A page has no pipes to name, so the output is written where a file
        // can be opened instead. `/dev/fd/…` is what bash hands over; a real
        // path is what this host can actually open.
        const sink = new BufferSink()
        await this.exec(part.script, { stdin: '', stdout: sink, stderr: { write: text => { this.currentStderr?.write(text) } } })
        const path = `/tmp/dsh-procsub-${String(procsubCounter++)}`
        this.state.volume.mkdirp('/tmp')
        this.state.volume.writeFile(path, toBytes(sink.text()))
        return [{ text: path, quoted: true }]
      }
      case 'arith': return [{ text: String(await this.evaluateArithmetic(part.expression)), quoted: false }]
      case 'command': {
        const sink = new BufferSink()
        await this.exec(part.script, { stdin: '', stdout: sink, stderr: { write: text => { /* command substitution keeps stderr on the parent */ this.currentStderr?.write(text) } } })
        return [{ text: sink.text().replace(/\n+$/, ''), quoted: false }]
      }
      case 'param': {
        // `"$@"` and `"${arr[@]}"` expand to one field per element, which is
        // exactly why they are written that way — joining them into a single
        // word loses every boundary the caller cared about.
        const elements = this.parameterElements(part)
        if (elements !== undefined) {
          return elements.map((text, index) => ({ text, quoted: true, boundary: index > 0 }))
        }
        return [{ text: await this.expandParameter(part), quoted: false }]
      }
    }
  }

  /** Stderr of the innermost running command, so substitutions do not swallow diagnostics. */
  private currentStderr: Sink | undefined

  /** Resolve `$name` with its optional modifier. */
  /**
   * The separate words a `@`-style parameter stands for, if it is one.
   * @param part - the parameter being expanded.
   * @returns one string per element, or `undefined` for an ordinary parameter.
   */
  private parameterElements(part: Extract<WordPart, { kind: 'param' }>): string[] | undefined {
    if (part.op !== undefined) return undefined
    if (part.name === '@') return [...this.state.positional]
    const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\[@\]$/.exec(part.name)
    if (subscript === null) return undefined
    return [...(this.state.arrays.get(subscript[1]) ?? [])]
  }

  private async expandParameter(part: Extract<WordPart, { kind: 'param' }>): Promise<string> {
    const { name, op, argument } = part
    let value: string | undefined

    // `arr[0]`, `arr[@]`, `arr[*]`, and `${#arr[@]}` for the element count.
    const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]$/.exec(name)
    if (subscript !== null) {
      const elements = this.state.arrays.get(subscript[1]) ?? []
      if (subscript[2] === '@' || subscript[2] === '*') {
        if (op === '#' && argument === undefined) return String(elements.length)
        return elements.join(' ')
      }
      const index = Number(await this.evaluateArithmetic(subscript[2]))
      const element = elements[index < 0 ? elements.length + index : index] ?? ''
      return op === '#' && argument === undefined ? String(element.length) : element
    }

    if (name === '?') value = String(this.state.status)
    else if (name === '#') value = String(this.state.positional.length)
    else if (name === '@' || name === '*') value = this.state.positional.join(' ')
    else if (name === '$') value = '1'
    else if (name === '!') value = '0'
    else if (name === '0') value = this.state.scriptName
    else if (/^[0-9]+$/.test(name)) value = this.state.positional[Number(name) - 1]
    else {
      value = this.state.vars.get(name)
      // `set -u` turns a typo into a failure instead of an empty string, which
      // is the entire reason a script asks for it.
      if (value === undefined && this.state.options.nounset && op === undefined) {
        this.currentStderr?.write(`sh: ${name}: unbound variable\n`)
        throw new ExitSignal(1)
      }
    }

    const argumentText = argument === undefined ? '' : (await this.expandWord(argument, { noGlob: true, noSplit: true })).join('')

    switch (op) {
      case undefined: break
      case '#': {
        // `${#VAR}` (no argument) is length; `${VAR#pat}` strips the shortest prefix.
        if (argument === undefined) return String((value ?? '').length)
        const text = value ?? ''
        const matcher = globToRegExp(argumentText)
        for (let i = 0; i <= text.length; i++) {
          if (matcher.test(text.slice(0, i))) return text.slice(i)
        }
        return text
      }
      case 'substring': {
        // `${VAR:offset:length}`; a negative offset counts from the end.
        const text = value ?? ''
        const [offsetText = '0', lengthText] = argumentText.split(':')
        const offset = Number(offsetText.trim()) || 0
        const start = offset < 0 ? Math.max(0, text.length + offset) : offset
        if (lengthText === undefined) return text.slice(start)
        const length = Number(lengthText.trim()) || 0
        return length < 0 ? text.slice(start, text.length + length) : text.slice(start, start + length)
      }
      case '^^': return (value ?? '').toUpperCase()
      case ',,': return (value ?? '').toLowerCase()
      case '^': {
        const text = value ?? ''
        return text.charAt(0).toUpperCase() + text.slice(1)
      }
      case ',': {
        const text = value ?? ''
        return text.charAt(0).toLowerCase() + text.slice(1)
      }
      case ':-': return value === undefined || value === '' ? argumentText : value
      case '-': return value === undefined ? argumentText : value
      case ':=':
        if (value === undefined || value === '') {
          this.state.vars.set(name, argumentText)
          return argumentText
        }
        return value
      case ':+': return value === undefined || value === '' ? '' : argumentText
      case '+': return value === undefined ? '' : argumentText
      case ':?':
        if (value === undefined || value === '') throw new ExitSignal(1)
        return value
      case '##': {
        // Longest matching prefix: scan from the whole string down.
        const text = value ?? ''
        const matcher = globToRegExp(argumentText)
        for (let i = text.length; i >= 0; i--) {
          if (matcher.test(text.slice(0, i))) return text.slice(i)
        }
        return text
      }
      case '%%':
      case '%': {
        const text = value ?? ''
        const longest = op === '%%'
        const range = longest ? [...Array(text.length + 1).keys()] : [...Array(text.length + 1).keys()].reverse()
        for (const i of range) {
          if (globToRegExp(argumentText).test(text.slice(i))) return text.slice(0, i)
        }
        return text
      }
      case '/':
      case '//': {
        const text = value ?? ''
        const [search, replacement = ''] = argumentText.split('/')
        const matcher = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), op === '//' ? 'g' : '')
        return text.replace(matcher, replacement)
      }
    }

    if (value === undefined && this.state.options.nounset) throw new ExitSignal(1)
    return value ?? ''
  }

  /** Evaluate `$(( … ))` with the shell's integer semantics. */
  /**
   * Evaluate an arithmetic expression, assigning to any variables it names.
   * @param expression - the expression text.
   * @returns its value.
   */
  async evaluate(expression: string): Promise<number> {
    return this.evaluateArithmetic(expression)
  }

  private async evaluateArithmetic(expression: string): Promise<number> {
    /** Read a variable as a number, the way arithmetic treats an unset one. */
    const numeric = (name: string): number => {
      const parsed = Number.parseInt(this.state.vars.get(name) ?? '0', 10)
      return Number.isNaN(parsed) ? 0 : parsed
    }
    /** Write a number back, since arithmetic can assign. */
    const store = (name: string, value: number): number => {
      this.state.vars.set(name, String(value))
      return value
    }

    let text = expression
    // `i++`, `++i`, `i--`, `--i`: evaluated for their value and their effect,
    // which is the whole reason `(( i++ ))` appears in a loop.
    text = text.replace(/([A-Za-z_][A-Za-z0-9_]*)\+\+/g, (_match, name: string) => String(store(name, numeric(name) + 1) - 1))
    text = text.replace(/([A-Za-z_][A-Za-z0-9_]*)--/g, (_match, name: string) => String(store(name, numeric(name) - 1) + 1))
    text = text.replace(/\+\+([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => String(store(name, numeric(name) + 1)))
    text = text.replace(/--([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => String(store(name, numeric(name) - 1)))
    // `i += 2`, `i = 3`, and the other compound assignments.
    text = text.replace(/\$?([A-Za-z_][A-Za-z0-9_]*)\s*([-+*/%]?)=\s*([^=][^,;]*)$/, (match, name: string, operation: string, rest: string) => {
      // Not an assignment if this is really a comparison.
      if (/^[=<>!]/.test(rest.trim())) return match
      const right = Number(new Function(`"use strict";return (${rest.replace(/\$?([A-Za-z_][A-Za-z0-9_]*)/g, (_m, other: string) => String(numeric(other)))})`)()) || 0
      const left = numeric(name)
      const value = operation === '+' ? left + right
        : operation === '-' ? left - right
          : operation === '*' ? left * right
            : operation === '/' ? (right === 0 ? 0 : Math.trunc(left / right))
              : operation === '%' ? (right === 0 ? 0 : left % right)
                : right
      return String(store(name, value))
    })

    // Substitute the remaining variable names with their numeric values, then
    // evaluate the resulting pure-arithmetic expression.
    const substituted = text.replace(/\$?([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => String(numeric(name)))
    if (!/^[-+*\/%()\d\s<>=!&|^~?:]*$/.test(substituted)) return 0
    try {
      // eslint-disable-next-line no-new-func
      const value = new Function(`"use strict";return (${substituted || '0'})`)() as number
      return Math.trunc(Number(value)) || 0
    } catch {
      return 0
    }
  }

  /** Pathname expansion for one field. */
  private glob(pattern: string): string[] {
    if (!/[*?[]/.test(pattern)) return []
    const absolute = isAbsolute(pattern)
    const base = absolute ? '/' : this.state.cwd
    const parts = pattern.replace(/^\//, '').split('/')
    let current: string[] = [base]
    for (const segment of parts) {
      if (segment.length === 0) continue
      const next: string[] = []
      const hasMagic = /[*?[]/.test(segment)
      for (const directory of current) {
        if (!hasMagic) {
          const candidate = directory === '/' ? `/${segment}` : `${directory}/${segment}`
          if (this.state.volume.exists(candidate)) next.push(candidate)
          continue
        }
        let names: string[]
        try {
          names = this.state.volume.readdir(directory)
        } catch {
          continue
        }
        const matcher = globToRegExp(segment)
        for (const name of names.sort()) {
          // A leading dot is only matched by an explicit leading dot.
          if (name.startsWith('.') && !segment.startsWith('.')) continue
          if (!matcher.test(name)) continue
          next.push(directory === '/' ? `/${name}` : `${directory}/${name}`)
        }
      }
      current = next
      if (current.length === 0) return []
    }
    if (absolute) return current
    const prefix = this.state.cwd === '/' ? '/' : `${this.state.cwd}/`
    return current.map(each => (each.startsWith(prefix) ? each.slice(prefix.length) : each))
  }

  /** Resolve a path against the shell's cwd. */
  absolute(path: string): string {
    if (isAbsolute(path)) return path
    if (path === '~' || path.startsWith('~/')) {
      const home = this.state.vars.get('HOME') ?? '/home'
      return path === '~' ? home : `${home}/${path.slice(2)}`
    }
    return resolvePath(this.state.cwd, path)
  }
}

/** Builtin implementations, which need interpreter access (unlike registered commands). */
const builtins: Record<string, (interpreter: Interpreter, context: CommandContext) => number | Promise<number>> = {
  ':': () => 0,
  true: () => 0,
  false: () => 1,

  cd(interpreter, { argv, shell, stderr }) {
    const target = argv[1] ?? shell.vars.get('HOME') ?? '/'
    const path = target === '-' ? (shell.vars.get('OLDPWD') ?? shell.cwd) : interpreter.absolute(target)
    const node = shell.volume.lookup(path)
    if (node === undefined) {
      stderr.write(`cd: ${target}: No such file or directory\n`)
      return 1
    }
    if (node.kind !== 'dir') {
      stderr.write(`cd: ${target}: Not a directory\n`)
      return 1
    }
    shell.vars.set('OLDPWD', shell.cwd)
    shell.cwd = shell.volume.realpath(path)
    shell.vars.set('PWD', shell.cwd)
    return 0
  },

  pwd(_interpreter, { shell, stdout }) {
    stdout.write(`${shell.cwd}\n`)
    return 0
  },

  echo(_interpreter, { argv, stdout }) {
    let args = argv.slice(1)
    let newline = true
    let escapes = false
    while (args.length > 0 && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes('n')) newline = false
      if (args[0].includes('e')) escapes = true
      if (args[0].includes('E')) escapes = false
      args = args.slice(1)
    }
    let text = args.join(' ')
    if (escapes) {
      text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\').replace(/\\0/g, '\0')
    }
    stdout.write(newline ? `${text}\n` : text)
    return 0
  },

  printf(_interpreter, { argv, stdout, shell }) {
    // `printf -v NAME fmt …` assigns instead of printing.
    let target: string | undefined
    if (argv[1] === '-v' && argv[2] !== undefined) {
      target = argv[2]
      argv = [argv[0], ...argv.slice(3)]
    }
    const [, format = '', ...args] = argv
    let index = 0
    const rendered = format
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\')
      // Width, precision, and the `-` and `0` flags are the whole point of
      // `printf` over `echo`; ignoring them produced unaligned columns that
      // looked like the format string had been mistyped.
      .replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([sdifxXoeEgGc%])/g, (token, flagText: string, widthText: string, precisionText: string | undefined, conversion: string) => {
        if (conversion === '%') return '%'
        const value = args[index++] ?? ''
        const width = widthText === '' ? 0 : Number(widthText)
        const precision = precisionText === undefined ? undefined : Number(precisionText)
        const leftAlign = flagText.includes('-')
        const zeroPad = flagText.includes('0') && !leftAlign

        let text: string
        if (conversion === 's') {
          text = precision === undefined ? value : value.slice(0, precision)
        } else if (conversion === 'c') {
          text = value.slice(0, 1)
        } else {
          const numeric = Number(value) || 0
          if (conversion === 'd' || conversion === 'i') text = String(Math.trunc(numeric))
          else if (conversion === 'x') text = Math.trunc(numeric).toString(16)
          else if (conversion === 'X') text = Math.trunc(numeric).toString(16).toUpperCase()
          else if (conversion === 'o') text = Math.trunc(numeric).toString(8)
          else if (conversion === 'e' || conversion === 'E') {
            text = numeric.toExponential(precision ?? 6)
            if (conversion === 'E') text = text.toUpperCase()
          } else if (conversion === 'g' || conversion === 'G') {
            text = String(numeric)
          } else {
            text = numeric.toFixed(precision ?? 6)
          }
          if (flagText.includes('+') && numeric >= 0) text = `+${text}`
        }

        if (text.length >= width) return text
        const padding = width - text.length
        if (leftAlign) return text + ' '.repeat(padding)
        if (zeroPad && conversion !== 's' && conversion !== 'c') {
          // The sign stays in front of the zeros.
          const sign = /^[-+]/.test(text) ? text[0] : ''
          const digits = sign === '' ? text : text.slice(1)
          return sign + '0'.repeat(padding) + digits
        }
        return ' '.repeat(padding) + text
      })
    if (target === undefined) stdout.write(rendered)
    else shell.vars.set(target, rendered)
    return 0
  },

  export(_interpreter, { argv, shell }) {
    for (const argument of argv.slice(1)) {
      const equals = argument.indexOf('=')
      if (equals === -1) {
        shell.exported.add(argument)
        continue
      }
      const name = argument.slice(0, equals)
      shell.vars.set(name, argument.slice(equals + 1))
      shell.exported.add(name)
    }
    return 0
  },

  unset(_interpreter, { argv, shell }) {
    for (const name of argv.slice(1)) {
      shell.vars.delete(name)
      shell.exported.delete(name)
      shell.functions.delete(name)
    }
    return 0
  },

  local(interpreter, { argv, shell }) {
    for (const argument of argv.slice(1)) {
      const equals = argument.indexOf('=')
      const name = equals === -1 ? argument : argument.slice(0, equals)
      // Recorded before it is changed, so leaving the function puts back what
      // the caller had — which is the entire point of `local`.
      interpreter.declareLocal(name)
      if (equals !== -1) shell.vars.set(name, argument.slice(equals + 1))
      else shell.vars.delete(name)
    }
    return 0
  },

  set(_interpreter, { argv, shell }) {
    // `set -- a b c` replaces the positional parameters, which is how a script
    // rebinds `$1…` — and how `set --` clears them.
    const separator = argv.indexOf('--')
    if (separator !== -1) {
      shell.positional = argv.slice(separator + 1)
      argv = argv.slice(0, separator)
    }
    for (const argument of argv.slice(1)) {
      if (argument.startsWith('-o') || argument.startsWith('+o')) continue
      if (argument.startsWith('-')) {
        for (const flag of argument.slice(1)) {
          if (flag === 'e') shell.options.errexit = true
          if (flag === 'x') shell.options.xtrace = true
          if (flag === 'u') shell.options.nounset = true
        }
      } else if (argument.startsWith('+')) {
        for (const flag of argument.slice(1)) {
          if (flag === 'e') shell.options.errexit = false
          if (flag === 'x') shell.options.xtrace = false
          if (flag === 'u') shell.options.nounset = false
        }
      }
    }
    if (argv.includes('pipefail')) shell.options.pipefail = !argv.includes('+o')
    return 0
  },

  shift(_interpreter, { argv, shell }) {
    const count = Number(argv[1] ?? '1')
    shell.positional = shell.positional.slice(count)
    return 0
  },

  exit(_interpreter, { argv, shell }) {
    throw new ExitSignal(Number(argv[1] ?? String(shell.status)) || 0)
  },

  return(_interpreter, { argv, shell }) {
    throw new ReturnSignal(Number(argv[1] ?? String(shell.status)) || 0)
  },

  break(_interpreter, { argv }) {
    throw new LoopSignal('break', Number(argv[1] ?? '1') || 1)
  },

  continue(_interpreter, { argv }) {
    throw new LoopSignal('continue', Number(argv[1] ?? '1') || 1)
  },

  async eval(interpreter, { argv, stdin, stdout, stderr }) {
    return interpreter.run(argv.slice(1).join(' '), { stdin, stdout, stderr })
  },

  async source(interpreter, { argv, shell, stdin, stdout, stderr }) {
    const path = interpreter.absolute(argv[1] ?? '')
    let text: string
    try {
      text = toText(shell.volume.readFile(path))
    } catch {
      stderr.write(`${argv[0]}: ${argv[1]}: No such file or directory\n`)
      return 1
    }
    // Arguments after the file become the sourced script's positional
    // parameters, and the caller's are restored afterwards.
    const saved = shell.positional
    if (argv.length > 2) shell.positional = argv.slice(2)
    try {
      return await interpreter.run(text, { stdin, stdout, stderr })
    } finally {
      shell.positional = saved
    }
  },

  read(_interpreter, { argv, shell, stdin, input }) {
    const names = argv.slice(1).filter(argument => !argument.startsWith('-'))
    // Consume the line. Leaving it in place is what turned `while read line`
    // into a loop over the first line forever.
    const remaining = input === undefined ? stdin : input.text.slice(input.offset)
    if (remaining.length === 0) return 1
    const breakAt = remaining.indexOf('\n')
    const line = breakAt === -1 ? remaining : remaining.slice(0, breakAt)
    if (input !== undefined) input.offset += breakAt === -1 ? remaining.length : breakAt + 1

    if (names.length === 0) {
      shell.vars.set('REPLY', line)
      return 0
    }
    // `IFS=, read a b` splits on commas. The default is whitespace, and an
    // empty `IFS` means no splitting at all — which is why `IFS= read -r line`
    // is the idiom for reading a line verbatim.
    const separators = shell.vars.get('IFS')
    const fields = separators === ''
      ? [line]
      : separators === undefined || /^[ \t\n]+$/.test(separators)
        ? (line.trim() === '' ? [] : line.trim().split(/\s+/))
        : line.split(new RegExp(`[${separators.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]`))
    names.forEach((name, index) => {
      // The last name takes everything left on the line, as `read` defines it.
      shell.vars.set(name, index === names.length - 1 ? fields.slice(index).join(' ') : (fields[index] ?? ''))
    })
    return 0
  },

  type(_interpreter, { argv, shell, stdout }) {
    for (const name of argv.slice(1)) {
      if (shell.functions.has(name)) stdout.write(`${name} is a function\n`)
      else if (builtins[name] !== undefined) stdout.write(`${name} is a shell builtin\n`)
      else if (shell.commands.has(name)) stdout.write(`${name} is ${name}\n`)
      else return 1
    }
    return 0
  },

  alias: () => 0,
  unalias: () => 0,

  /**
   * `trap 'command' EXIT` — run something when the shell finishes.
   *
   * Only `EXIT` is honoured. A page has no signals to catch, and pretending to
   * install a handler for `INT` that can never fire would be worse than saying
   * nothing: the script would believe its cleanup was arranged.
   */
  trap(interpreter, { argv }) {
    const events = argv.slice(2).map(event => event.toUpperCase())
    if (events.includes('EXIT') || events.includes('0')) interpreter.onExit(argv[1] ?? '')
    return 0
  },
  wait: () => 0,
  umask: () => 0,
  hash: () => 0,
  times: () => 0,
  jobs: () => 0,
  history: () => 0,
}

/** `[`/`test` shares one implementation registered as a normal command. */
// `.` is `source`; scripts use both spellings interchangeably, and reaching
// $PATH for `.` tries to execute the current directory.
builtins['.'] = builtins.source

/**
 * Translate a `[[ … == pattern ]]` pattern.
 *
 * Unlike a glob, `*` matches separators too, because the subject is a string
 * rather than a path.
 * @param pattern - the pattern as written.
 */
function conditionPattern(pattern: string): RegExp {
  let source = ''
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * `[[ … ]]` — bash's conditional expression.
 *
 * It differs from `[` in the ways that make scripts prefer it: `==` and `!=`
 * match patterns rather than compare literally, `=~` matches a regular
 * expression, and `&&`/`||` group inside the brackets instead of ending the
 * command. Words arrive unsplit and unglobbed, which the parser arranges.
 */
builtins['[['] = (_interpreter, { argv, shell }) => {
  const tokens = argv.slice(1)

  /** One test, from a slice of the tokens. */
  const single = (parts: string[]): boolean => {
    if (parts.length === 0) return false
    if (parts.length === 1) return parts[0] !== ''
    if (parts[0] === '!') return !single(parts.slice(1))
    if (parts.length === 2) {
      const [flag, operand] = parts
      const node = shell.volume.lookup(resolvePath(shell.cwd, operand))
      switch (flag) {
        case '-e': return node !== undefined
        case '-f': return node?.kind === 'file'
        case '-d': return node?.kind === 'dir'
        case '-L': case '-h': return shell.volume.lookup(resolvePath(shell.cwd, operand), false)?.kind === 'link'
        case '-s': return (node?.content?.length ?? node?.size ?? 0) > 0
        case '-r': case '-w': return node !== undefined
        case '-x': return node !== undefined && (node.mode & 0o111) !== 0
        case '-z': return operand === ''
        case '-n': return operand !== ''
        default: return false
      }
    }
    const [left, operator, ...rest] = parts
    const right = rest.join(' ')
    switch (operator) {
      // `*` here spans anything, including `/`: this is pattern matching on a
      // string, not pathname expansion.
      case '=': case '==': return conditionPattern(right).test(left)
      case '!=': return !conditionPattern(right).test(left)
      case '=~': try { return new RegExp(right).test(left) } catch { return false }
      case '<': return left < right
      case '>': return left > right
      case '-eq': return Number(left) === Number(right)
      case '-ne': return Number(left) !== Number(right)
      case '-lt': return Number(left) < Number(right)
      case '-le': return Number(left) <= Number(right)
      case '-gt': return Number(left) > Number(right)
      case '-ge': return Number(left) >= Number(right)
      default: return single([left])
    }
  }

  // `&&` binds tighter than `||`, as everywhere else.
  const anyOf = tokens.reduce<string[][]>((groups, token) => {
    if (token === '||') groups.push([])
    else groups[groups.length - 1].push(token)
    return groups
  }, [[]])
  const holds = anyOf.some((group) => {
    const allOf = group.reduce<string[][]>((parts, token) => {
      if (token === '&&') parts.push([])
      else parts[parts.length - 1].push(token)
      return parts
    }, [[]])
    return allOf.every(part => single(part))
  })
  return holds ? 0 : 1
}

/**
 * `let` — evaluate an arithmetic expression for its status.
 *
 * This is what `(( … ))` becomes: the status is 0 when the expression is
 * non-zero, which reads backwards until you remember it is `((i))` standing in
 * for `[ $i -ne 0 ]`.
 */
builtins.let = async (interpreter, { argv }) => {
  let last = 0
  for (const expression of argv.slice(1)) last = await interpreter.evaluate(expression)
  return last === 0 ? 1 : 0
}

export { builtins }

/** Helper used by the coreutils registry for consistent basename output. */
export { basename }
