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
  type CommandContext, type ShellState, type Sink,
} from './runtime.ts'
import { basename, dirname, isAbsolute, resolve as resolvePath } from '../vfs/path.ts'
import { globToRegExp } from '../node/path.ts'
import { toText, toBytes } from '../node/binary.ts'

/** Field separator; the shell reads `$IFS` but the default is what dsh scripts use. */
const DEFAULT_IFS = ' \t\n'

/** Where a command's three streams point after redirections are applied. */
interface Streams {
  stdin: string
  stdout: Sink
  stderr: Sink
}

/** Executes a parsed script against a {@link ShellState}. */
export class Interpreter {
  constructor(private readonly state: ShellState) {}

  /**
   * Run a script source.
   * @param source - shell text.
   * @param streams - the top-level stdin/stdout/stderr.
   * @returns the final exit status.
   */
  async run(source: string, streams: Streams): Promise<number> {
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
      status = await this.exec(node.commands[i], {
        stdin: input,
        stdout: buffer ?? streams.stdout,
        stderr: streams.stderr,
      })
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
      // A subshell must not leak variable or cwd changes.
      const saved = { cwd: this.state.cwd, vars: new Map(this.state.vars), exported: new Set(this.state.exported) }
      try {
        return await this.exec(node.body, applied.streams)
      } finally {
        this.state.cwd = saved.cwd
        this.state.vars = saved.vars
        this.state.exported = saved.exported
      }
    } finally {
      applied.commit()
    }
  }

  // ---- simple commands -----------------------------------------------------

  private async execSimple(node: SimpleCommand, streams: Streams): Promise<number> {
    const words: string[] = []
    for (const word of node.words) words.push(...await this.expandWord(word))

    if (words.length === 0) {
      // Assignment-only command: the assignments persist.
      for (const assignment of node.assignments) {
        this.state.vars.set(assignment.name, (await this.expandWord(assignment.value, { noGlob: true, noSplit: true })).join(''))
      }
      return 0
    }

    const applied = await this.applyRedirects(node.redirects, streams)
    // Assignments in a command prefix are scoped to that command.
    const savedVars = new Map<string, string | undefined>()
    for (const assignment of node.assignments) {
      savedVars.set(assignment.name, this.state.vars.get(assignment.name))
      this.state.vars.set(assignment.name, (await this.expandWord(assignment.value, { noGlob: true, noSplit: true })).join(''))
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

    const builtin = builtins[name]
    if (builtin !== undefined) return builtin(this, { argv: words, shell: this.state, ...streams, signal: this.state.signal })

    const command = this.state.commands.get(name)
    if (command !== undefined) {
      try {
        return await command({ argv: words, shell: this.state, ...streams, signal: this.state.signal })
      } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof LoopSignal) throw error
        streams.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }

    const script = this.resolveExecutable(name)
    if (script !== undefined) return this.runScriptFile(script, args, streams)

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
    try {
      return await this.exec(body, streams)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.status
      throw signal
    } finally {
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
      if (node?.kind === 'file' && (node.mode & 0o111) !== 0) return candidate
    }
    return undefined
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
      streams: { stdin, stdout, stderr },
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
    const segments: { text: string, quoted: boolean }[] = []
    for (const part of word) segments.push(...await this.expandPart(part))

    // Field splitting on unquoted whitespace.
    const fields: string[] = []
    let current = ''
    let started = false
    for (const segment of segments) {
      if (segment.quoted || options.noSplit === true) {
        current += segment.text
        started = true
        continue
      }
      let buffer = ''
      for (const char of segment.text) {
        if (DEFAULT_IFS.includes(char)) {
          if (buffer.length > 0 || started) {
            fields.push(current + buffer)
            current = ''
            buffer = ''
            started = false
          }
          continue
        }
        buffer += char
        started = true
      }
      current += buffer
    }
    if (started || current.length > 0) fields.push(current)
    if (fields.length === 0 && segments.some(segment => segment.quoted)) fields.push('')

    if (options.noGlob === true) return fields

    // Pathname expansion.
    const expanded: string[] = []
    for (const field of fields) {
      const matches = this.glob(field)
      if (matches.length === 0) expanded.push(field)
      else expanded.push(...matches)
    }
    return expanded
  }

  /** Expand one word part into quoted/unquoted segments. */
  private async expandPart(part: WordPart): Promise<{ text: string, quoted: boolean }[]> {
    switch (part.kind) {
      case 'literal': return [{ text: part.value, quoted: false }]
      case 'quoted': return [{ text: part.value, quoted: true }]
      case 'dquoted': {
        const inner: { text: string, quoted: boolean }[] = []
        for (const nested of part.parts) inner.push(...await this.expandPart(nested))
        return [{ text: inner.map(each => each.text).join(''), quoted: true }]
      }
      case 'arith': return [{ text: String(await this.evaluateArithmetic(part.expression)), quoted: false }]
      case 'command': {
        const sink = new BufferSink()
        await this.exec(part.script, { stdin: '', stdout: sink, stderr: { write: text => { /* command substitution keeps stderr on the parent */ this.currentStderr?.write(text) } } })
        return [{ text: sink.text().replace(/\n+$/, ''), quoted: false }]
      }
      case 'param': return [{ text: await this.expandParameter(part), quoted: false }]
    }
  }

  /** Stderr of the innermost running command, so substitutions do not swallow diagnostics. */
  private currentStderr: Sink | undefined

  /** Resolve `$name` with its optional modifier. */
  private async expandParameter(part: Extract<WordPart, { kind: 'param' }>): Promise<string> {
    const { name, op, argument } = part
    let value: string | undefined
    if (name === '?') value = String(this.state.status)
    else if (name === '#') value = String(this.state.positional.length)
    else if (name === '@' || name === '*') value = this.state.positional.join(' ')
    else if (name === '$') value = '1'
    else if (name === '!') value = '0'
    else if (name === '0') value = this.state.scriptName
    else if (/^[0-9]+$/.test(name)) value = this.state.positional[Number(name) - 1]
    else value = this.state.vars.get(name)

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
  private async evaluateArithmetic(expression: string): Promise<number> {
    // Substitute variable names with their numeric values, then evaluate the
    // resulting pure-arithmetic expression.
    const substituted = expression.replace(/\$?([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
      const raw = this.state.vars.get(name) ?? '0'
      const numeric = Number.parseInt(raw, 10)
      return String(Number.isNaN(numeric) ? 0 : numeric)
    })
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

  printf(_interpreter, { argv, stdout }) {
    const [, format = '', ...args] = argv
    let index = 0
    const rendered = format
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
      .replace(/%[-+ 0#]*\d*(?:\.\d+)?[sdifxXoeEgGc%]/g, (token) => {
        if (token === '%%') return '%'
        const value = args[index++] ?? ''
        const conversion = token[token.length - 1]
        if (conversion === 's') return value
        if (conversion === 'c') return value.slice(0, 1)
        const numeric = Number(value) || 0
        if (conversion === 'd' || conversion === 'i') return String(Math.trunc(numeric))
        if (conversion === 'x') return Math.trunc(numeric).toString(16)
        if (conversion === 'X') return Math.trunc(numeric).toString(16).toUpperCase()
        if (conversion === 'o') return Math.trunc(numeric).toString(8)
        const precision = /\.(\d+)/.exec(token)
        return numeric.toFixed(precision === null ? 6 : Number(precision[1]))
      })
    stdout.write(rendered)
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

  local(_interpreter, { argv, shell }) {
    // Without a call-frame variable stack, `local` behaves as a plain assignment.
    for (const argument of argv.slice(1)) {
      const equals = argument.indexOf('=')
      if (equals !== -1) shell.vars.set(argument.slice(0, equals), argument.slice(equals + 1))
    }
    return 0
  },

  set(_interpreter, { argv, shell }) {
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
    try {
      const text = toText(shell.volume.readFile(path))
      return await interpreter.run(text, { stdin, stdout, stderr })
    } catch {
      stderr.write(`source: ${argv[1]}: No such file or directory\n`)
      return 1
    }
  },

  read(_interpreter, { argv, shell, stdin }) {
    const names = argv.slice(1).filter(argument => !argument.startsWith('-'))
    const [line = ''] = stdin.split('\n')
    if (names.length === 0) {
      shell.vars.set('REPLY', line)
      return line.length === 0 ? 1 : 0
    }
    const fields = line.trim().split(/\s+/)
    names.forEach((name, index) => {
      shell.vars.set(name, index === names.length - 1 ? fields.slice(index).join(' ') : (fields[index] ?? ''))
    })
    return line.length === 0 ? 1 : 0
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
  trap: () => 0,
  wait: () => 0,
  umask: () => 0,
  hash: () => 0,
  times: () => 0,
  jobs: () => 0,
  history: () => 0,
}

/** `[`/`test` shares one implementation registered as a normal command. */
export { builtins }

/** Helper used by the coreutils registry for consistent basename output. */
export { basename }
