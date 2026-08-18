/**
 * Recursive-descent parser for the shell dialect the agent actually emits:
 * pipelines, `&&`/`||`/`;`, redirections, quoting, parameter and command
 * substitution, arithmetic, `if`/`for`/`while`/`case`, functions, and grouping.
 *
 * It parses directly from the source text (no separate token stream) because
 * shell lexing is context-sensitive — the same `(` is a subshell, a function
 * body marker, or part of `$(…)` depending on where it appears.
 */

import type { Case, For, FunctionDef, Group, If, List, Node, Pipeline, Redirect, Sequence, SimpleCommand, While, Word, WordPart } from './ast.ts'

/** Reserved words that terminate a command list. */
const TERMINATORS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}', ';;'])

/** Reserved words that open a compound command. */
const KEYWORDS = new Set(['if', 'for', 'while', 'until', 'case', 'function', '{', '('])

/** Thrown on malformed input; the message reaches the model as shell stderr. */
export class ShellSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(`syntax error: ${message}`)
    this.name = 'ShellSyntaxError'
  }
}

/** The parser state machine. */
class Parser {
  private index = 0
  /** Heredoc bodies collected while scanning a line, consumed after its newline. */
  private pendingHeredocs: { redirect: Redirect, tag: string, quoted: boolean }[] = []

  constructor(private readonly source: string) {}

  /** Parse the whole script. */
  parse(): Node {
    const statements = this.parseList(new Set())
    this.skipBlank()
    if (this.index < this.source.length) {
      throw new ShellSyntaxError(`unexpected token near '${this.source.slice(this.index, this.index + 12)}'`, this.index)
    }
    return statements
  }

  // ---- character helpers ---------------------------------------------------

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? ''
  }

  private eof(): boolean {
    return this.index >= this.source.length
  }

  /** Skip spaces, tabs, line continuations, and comments (not newlines). */
  private skipSpace(): void {
    for (;;) {
      const char = this.peek()
      if (char === ' ' || char === '\t') {
        this.index++
        continue
      }
      if (char === '\\' && this.peek(1) === '\n') {
        this.index += 2
        continue
      }
      if (char === '#' && this.atWordStart()) {
        while (!this.eof() && this.peek() !== '\n') this.index++
        continue
      }
      return
    }
  }

  /** A `#` only starts a comment at the beginning of a word. */
  private atWordStart(): boolean {
    if (this.index === 0) return true
    const previous = this.source[this.index - 1]
    return previous === ' ' || previous === '\t' || previous === '\n' || previous === ';' || previous === '(' || previous === '&' || previous === '|'
  }

  /** Skip spaces, comments, newlines, and consume any heredoc bodies. */
  private skipBlank(): void {
    for (;;) {
      this.skipSpace()
      if (this.peek() === '\n') {
        this.index++
        this.consumeHeredocs()
        continue
      }
      return
    }
  }

  /** After a newline, read the bodies of heredocs opened on the previous line. */
  private consumeHeredocs(): void {
    if (this.pendingHeredocs.length === 0) return
    const pending = this.pendingHeredocs
    this.pendingHeredocs = []
    for (const { redirect, tag, quoted } of pending) {
      const lines: string[] = []
      for (;;) {
        if (this.eof()) break
        let end = this.source.indexOf('\n', this.index)
        if (end === -1) end = this.source.length
        const line = this.source.slice(this.index, end)
        this.index = Math.min(end + 1, this.source.length)
        if (line.trimEnd() === tag) break
        lines.push(line)
      }
      const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`
      // A quoted tag (<<'EOF') suppresses expansion, matching POSIX.
      redirect.target = quoted ? [{ kind: 'quoted', value: body }] : [{ kind: 'dquoted', parts: this.parseInterpolated(body) }]
    }
  }

  /** Parse a raw string as double-quote-style interpolated parts (used for heredocs). */
  private parseInterpolated(text: string): WordPart[] {
    const sub = new Parser(text)
    return sub.readDoubleQuotedBody(text.length)
  }

  // ---- lists ---------------------------------------------------------------

  /**
   * Parse statements until a terminator keyword.
   * @param stop - reserved words that end this list.
   * @returns the parsed sequence.
   */
  private parseList(stop: ReadonlySet<string>): Node {
    const statements: Node[] = []
    for (;;) {
      this.skipBlank()
      if (this.eof()) break
      const keyword = this.peekWord()
      if (stop.has(keyword) || (stop.size > 0 && TERMINATORS.has(keyword))) break
      if (this.peek() === ')' ) break
      const statement = this.parseAndOr()
      statements.push(statement)
      this.skipSpace()
      const separator = this.readSeparator()
      if (separator === '&') {
        statements[statements.length - 1] = { type: 'list', left: statement, operator: '&' } satisfies List
      }
      if (separator === undefined) break
    }
    if (statements.length === 1) return statements[0]
    return { type: 'sequence', statements } satisfies Sequence
  }

  /** Consume `;`, `&`, or a newline; returns undefined when none is present. */
  private readSeparator(): ';' | '&' | '\n' | undefined {
    this.skipSpace()
    if (this.peek() === ';' && this.peek(1) !== ';') {
      this.index++
      return ';'
    }
    if (this.peek() === '&' && this.peek(1) !== '&') {
      this.index++
      return '&'
    }
    if (this.peek() === '\n') {
      this.index++
      this.consumeHeredocs()
      return '\n'
    }
    return undefined
  }

  /** Parse `pipeline (&& | ||) pipeline …`, left-associative. */
  private parseAndOr(): Node {
    let left = this.parsePipeline()
    for (;;) {
      this.skipSpace()
      const operator = this.peek() === '&' && this.peek(1) === '&' ? '&&' : this.peek() === '|' && this.peek(1) === '|' ? '||' : undefined
      if (operator === undefined) return left
      this.index += 2
      this.skipBlank()
      const right = this.parsePipeline()
      left = { type: 'list', left, operator, right } satisfies List
    }
  }

  /** Parse `command | command | …`. */
  private parsePipeline(): Node {
    this.skipSpace()
    let negated = false
    if (this.peekWord() === '!') {
      this.readWordText()
      negated = true
      this.skipSpace()
    }
    const commands: Node[] = [this.parseCommand()]
    for (;;) {
      this.skipSpace()
      if (this.peek() !== '|' || this.peek(1) === '|') break
      this.index++
      this.skipBlank()
      commands.push(this.parseCommand())
    }
    if (commands.length === 1 && !negated) return commands[0]
    return { type: 'pipeline', commands, negated } satisfies Pipeline
  }

  // ---- commands ------------------------------------------------------------

  /** Parse one command: compound form, function definition, or simple command. */
  private parseCommand(): Node {
    this.skipSpace()
    const keyword = this.peekWord()
    if (keyword === 'if') return this.parseIf()
    if (keyword === 'for') return this.parseFor()
    if (keyword === 'while' || keyword === 'until') return this.parseWhile(keyword === 'until')
    if (keyword === 'case') return this.parseCase()
    if (keyword === 'function') return this.parseFunctionKeyword()
    // `((` is an arithmetic command, not a subshell opening another subshell.
    if (this.peek() === '(' && !this.source.startsWith('((', this.index)) return this.parseGroup(true)
    if (keyword === '{') return this.parseGroup(false)
    const functionDef = this.tryParseFunctionDefinition()
    if (functionDef !== undefined) return functionDef
    return this.parseSimple()
  }

  /** Look ahead for `name ( )` to recognize a POSIX function definition. */
  private tryParseFunctionDefinition(): FunctionDef | undefined {
    const start = this.index
    const name = this.peekWord()
    if (name.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
    this.readWordText()
    this.skipSpace()
    if (this.peek() !== '(' || this.peek(1) !== ')') {
      this.index = start
      return undefined
    }
    this.index += 2
    this.skipBlank()
    const body = this.parseCommand()
    return { type: 'function', name, body }
  }

  /** `function name { … }` (bash form). */
  private parseFunctionKeyword(): FunctionDef {
    this.readWordText()
    this.skipSpace()
    const name = this.readWordText()
    this.skipSpace()
    if (this.peek() === '(' && this.peek(1) === ')') this.index += 2
    this.skipBlank()
    const body = this.parseCommand()
    return { type: 'function', name, body }
  }

  /** `( … )` subshell or `{ …; }` brace group, with trailing redirections. */
  private parseGroup(subshell: boolean): Group {
    if (subshell) {
      this.index++ // (
      const body = this.parseList(new Set())
      this.skipBlank()
      if (this.peek() !== ')') throw new ShellSyntaxError("expected ')'", this.index)
      this.index++
      return { type: 'group', body, subshell: true, redirects: this.parseRedirects() }
    }
    this.readWordText() // {
    const body = this.parseList(new Set(['}']))
    this.skipBlank()
    if (this.peekWord() !== '}') throw new ShellSyntaxError("expected '}'", this.index)
    this.readWordText()
    return { type: 'group', body, subshell: false, redirects: this.parseRedirects() }
  }

  /** `if cond; then …; [elif …] [else …]; fi`. */
  private parseIf(): If {
    this.readWordText() // if
    const condition = this.parseList(new Set(['then']))
    this.expectKeyword('then')
    const then = this.parseList(new Set(['elif', 'else', 'fi']))
    this.skipBlank()
    const next = this.peekWord()
    let otherwise: Node | undefined
    if (next === 'elif') {
      // Rewrite `elif` as a nested `if` in the else branch.
      const nested = this.parseIfFromElif()
      otherwise = nested
      return { type: 'if', condition, then, else: otherwise }
    }
    if (next === 'else') {
      this.readWordText()
      otherwise = this.parseList(new Set(['fi']))
    }
    this.expectKeyword('fi')
    return { type: 'if', condition, then, ...(otherwise === undefined ? {} : { else: otherwise }) }
  }

  /** Continue an `if` chain from an `elif` token; the shared `fi` closes all of them. */
  private parseIfFromElif(): If {
    this.readWordText() // elif
    const condition = this.parseList(new Set(['then']))
    this.expectKeyword('then')
    const then = this.parseList(new Set(['elif', 'else', 'fi']))
    this.skipBlank()
    const next = this.peekWord()
    if (next === 'elif') return { type: 'if', condition, then, else: this.parseIfFromElif() }
    if (next === 'else') {
      this.readWordText()
      const otherwise = this.parseList(new Set(['fi']))
      this.expectKeyword('fi')
      return { type: 'if', condition, then, else: otherwise }
    }
    this.expectKeyword('fi')
    return { type: 'if', condition, then }
  }

  /** `for name [in words]; do …; done`. */
  private parseFor(): For | Sequence {
    this.readWordText() // for
    this.skipSpace()

    // `for ((init; test; step))` is a while loop wearing a different hat, so it
    // is rewritten as one rather than given its own evaluator.
    if (this.source.startsWith('((', this.index)) {
      const closed = this.findClosingParens(this.index)
      if (closed === -1) throw new ShellSyntaxError("expected '))' to close a for loop", this.index)
      const header = this.source.slice(this.index + 2, closed)
      this.index = closed + 2
      const [init = '', test = '', step = ''] = header.split(';')
      this.skipBlank()
      if (this.peek() === ';') this.index++
      this.skipBlank()
      this.expectKeyword('do')
      const inner = this.parseList(new Set(['done']))
      this.expectKeyword('done')
      const redirects = this.parseRedirects()
      const arithmetic = (expression: string): Node => ({
        type: 'simple',
        assignments: [],
        words: [[{ kind: 'literal', value: 'let' }], [{ kind: 'quoted', value: expression.trim() || '1' }]],
        redirects: [],
      })
      const body: Node = { type: 'sequence', statements: [inner, arithmetic(step)] }
      const loop: While = { type: 'while', condition: arithmetic(test), body, until: false, redirects }
      return { type: 'sequence', statements: [arithmetic(init), loop] }
    }

    const name = this.readWordText()
    this.skipSpace()
    let words: Word[] = []
    let usesPositional = true
    if (this.peekWord() === 'in') {
      this.readWordText()
      usesPositional = false
      for (;;) {
        this.skipSpace()
        if (this.peek() === ';' || this.peek() === '\n' || this.eof()) break
        if (this.peekWord() === 'do') break
        words.push(this.parseWord())
      }
    }
    this.skipBlank()
    if (this.peek() === ';') this.index++
    this.skipBlank()
    this.expectKeyword('do')
    const body = this.parseList(new Set(['done']))
    this.expectKeyword('done')
    return { type: 'for', name, words, usesPositional, body, redirects: this.parseRedirects() }
  }

  /** `while|until cond; do …; done`. */
  private parseWhile(until: boolean): While {
    this.readWordText()
    const condition = this.parseList(new Set(['do']))
    this.expectKeyword('do')
    const body = this.parseList(new Set(['done']))
    this.expectKeyword('done')
    return { type: 'while', condition, body, until, redirects: this.parseRedirects() }
  }

  /** `case word in pattern|pattern) body ;; esac`. */
  private parseCase(): Case {
    this.readWordText() // case
    this.skipSpace()
    const word = this.parseWord()
    this.skipBlank()
    this.expectKeyword('in')
    const branches: { patterns: Word[], body: Node }[] = []
    for (;;) {
      this.skipBlank()
      if (this.peekWord() === 'esac') break
      if (this.eof()) throw new ShellSyntaxError("expected 'esac'", this.index)
      if (this.peek() === '(') this.index++
      const patterns: Word[] = []
      for (;;) {
        this.skipSpace()
        patterns.push(this.parseWord())
        this.skipSpace()
        if (this.peek() === '|') {
          this.index++
          continue
        }
        break
      }
      if (this.peek() !== ')') throw new ShellSyntaxError("expected ')' in case pattern", this.index)
      this.index++
      const body = this.parseList(new Set(['esac']))
      this.skipBlank()
      if (this.peek() === ';' && this.peek(1) === ';') this.index += 2
      branches.push({ patterns, body })
    }
    this.expectKeyword('esac')
    return { type: 'case', word, branches }
  }

  /** Consume a required reserved word. */
  private expectKeyword(keyword: string): void {
    this.skipBlank()
    if (this.peekWord() !== keyword) {
      throw new ShellSyntaxError(`expected '${keyword}' near '${this.source.slice(this.index, this.index + 12)}'`, this.index)
    }
    this.readWordText()
  }

  /** Parse assignments, words, and redirections up to a separator. */
  /**
   * `<(…)` in word position: the command's output, named as a file.
   * @returns the part, or `undefined` when this is an ordinary redirect.
   */
  private tryParseProcessSubstitution(): WordPart | undefined {
    if (!this.source.startsWith('<(', this.index)) return undefined
    const closed = this.findClosingParens(this.index + 1)
    if (closed === -1) return undefined
    const script = this.source.slice(this.index + 2, closed)
    this.index = closed + 1
    return { kind: 'procsub', script: new Parser(script).parse() }
  }

  private parseSimple(): SimpleCommand {
    const command: SimpleCommand = { type: 'simple', assignments: [], words: [], redirects: [] }

    // `(( … ))` is an arithmetic command: the expression is one opaque word,
    // and the status says whether the result was non-zero.
    if (this.source.startsWith('((', this.index)) {
      const closed = this.findClosingParens(this.index)
      if (closed !== -1) {
        const expression = this.source.slice(this.index + 2, closed)
        this.index = closed + 2
        command.words.push([{ kind: 'literal', value: 'let' }])
        command.words.push([{ kind: 'quoted', value: expression }])
        this.skipSpace()
        return command
      }
    }

    // `[[ … ]]` is a conditional: its words are collected as written.
    if (this.source.startsWith('[[', this.index) && /\s|$/.test(this.source[this.index + 2] ?? '')) {
      this.index += 2
      command.conditional = true
      command.words.push([{ kind: 'literal', value: '[[' }])
      for (;;) {
        this.skipSpace()
        if (this.eof()) throw new ShellSyntaxError('unexpected end of input, expected `]]`', this.index)
        if (this.source.startsWith(']]', this.index)) {
          this.index += 2
          break
        }
        // The operators are words here, and `parseWord` would consume none of
        // them — which spun this loop until the process ran out of memory.
        const operator = ['&&', '||', '!', '(', ')'].find(token => this.source.startsWith(token, this.index))
        if (operator !== undefined) {
          this.index += operator.length
          command.words.push([{ kind: 'literal', value: operator }])
          continue
        }
        command.words.push(this.parseWord())
      }
      this.skipSpace()
      for (;;) {
        const redirect = this.tryParseRedirect()
        if (redirect === undefined) break
        command.redirects.push(redirect)
      }
      return command
    }

    for (;;) {
      this.skipSpace()
      if (this.eof()) break
      const char = this.peek()
      if (char === '\n' || char === ';' || char === ')') break
      if (char === '&' || char === '|') break
      const substitution = this.tryParseProcessSubstitution()
      if (substitution !== undefined) {
        command.words.push([substitution])
        continue
      }
      const redirect = this.tryParseRedirect()
      if (redirect !== undefined) {
        command.redirects.push(redirect)
        continue
      }
      if (command.words.length === 0) {
        const assignment = this.tryParseAssignment()
        if (assignment !== undefined) {
          command.assignments.push(assignment)
          continue
        }
        const keyword = this.peekWord()
        if (KEYWORDS.has(keyword) || TERMINATORS.has(keyword)) break
      }
      command.words.push(this.parseWord())
    }
    return command
  }

  /**
   * Index of the `))` closing an arithmetic command, or -1 when unbalanced.
   * @param from - the index of the opening `((`.
   */
  private findClosingParens(from: number): number {
    let depth = 0
    for (let index = from; index < this.source.length; index++) {
      if (this.source[index] === '(') depth++
      else if (this.source[index] === ')') {
        depth--
        if (depth === 0) return this.source.startsWith('))', index - 1) ? index - 1 : index
      }
    }
    return -1
  }

  /** `NAME=value` or `NAME+=value` before the first word. */
  private tryParseAssignment(): { name: string, value: Word, append?: boolean, array?: Word[] } | undefined {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(this.source.slice(this.index))
    if (match === null) return undefined
    this.index += match[0].length
    // `name=(a b c)` — an array literal.
    if (this.peek() === '(') {
      this.index++
      const elements: Word[] = []
      for (;;) {
        this.skipSpace()
        if (this.eof()) throw new ShellSyntaxError("expected ')' to close an array", this.index)
        if (this.peek() === ')') { this.index++; break }
        if (this.peek() === '\n') { this.index++; continue }
        elements.push(this.parseWord())
      }
      return { name: match[1], value: [], array: elements, ...(match[2] === '+' ? { append: true } : {}) }
    }
    if (match[2] === '+') {
      const value = this.parseWord()
      return { name: match[1], value, append: true }
    }
    const value = this.peek() === ' ' || this.peek() === '\n' || this.eof() ? [] : this.parseWord()
    return { name: match[1], value }
  }

  /** Parse every redirection that follows the current position. */
  private parseRedirects(): Redirect[] {
    const redirects: Redirect[] = []
    for (;;) {
      this.skipSpace()
      const redirect = this.tryParseRedirect()
      if (redirect === undefined) return redirects
      redirects.push(redirect)
    }
  }

  /** Recognize `[n]>`, `[n]>>`, `<`, `&>`, `n>&m`, `<<<`, `<<`. */
  private tryParseRedirect(): Redirect | undefined {
    const start = this.index
    const digits = /^(\d*)/.exec(this.source.slice(this.index))![1]
    const after = this.index + digits.length
    const char = this.source[after]
    const next = this.source[after + 1]

    if (char === '&' && next === '>') {
      this.index = after + 2
      this.skipSpace()
      return { fd: 1, op: '&>', target: this.parseWord() }
    }
    if (char === '>') {
      if (next === '&') {
        this.index = after + 2
        const target = /^(\d+|-)/.exec(this.source.slice(this.index))
        if (target === null) {
          this.index = start
          return undefined
        }
        this.index += target[0].length
        return { fd: digits === '' ? 1 : Number(digits), op: 'dup', target: [{ kind: 'literal', value: target[0] }] }
      }
      this.index = after + (next === '>' ? 2 : 1)
      this.skipSpace()
      return { fd: digits === '' ? 1 : Number(digits), op: next === '>' ? '>>' : '>', target: this.parseWord() }
    }
    if (char === '<') {
      if (next === '<' && this.source[after + 2] === '<') {
        this.index = after + 3
        this.skipSpace()
        return { fd: 0, op: '<<<', target: this.parseWord() }
      }
      if (next === '<') {
        this.index = after + 2
        this.skipSpace()
        const dash = this.peek() === '-'
        if (dash) this.index++
        const raw = this.readWordText()
        const quoted = raw.startsWith("'") || raw.startsWith('"')
        const tag = raw.replace(/['"]/g, '')
        const redirect: Redirect = { fd: 0, op: '<<', target: [] }
        this.pendingHeredocs.push({ redirect, tag, quoted })
        return redirect
      }
      if (next === '&') {
        this.index = after + 2
        const target = /^(\d+|-)/.exec(this.source.slice(this.index))!
        this.index += target[0].length
        return { fd: digits === '' ? 0 : Number(digits), op: 'dup', target: [{ kind: 'literal', value: target[0] }] }
      }
      this.index = after + 1
      this.skipSpace()
      return { fd: 0, op: '<', target: this.parseWord() }
    }
    this.index = start
    return undefined
  }

  // ---- words ---------------------------------------------------------------

  /** Peek the next bare word without consuming it (used for keyword lookahead). */
  private peekWord(): string {
    const start = this.index
    this.skipSpace()
    const text = this.readWordText()
    this.index = start
    return text
  }

  /** Read the next unquoted run of word characters. */
  private readWordText(): string {
    const start = this.index
    if (this.peek() === '{' || this.peek() === '}' || this.peek() === '!') {
      this.index++
      return this.source.slice(start, this.index)
    }
    if (this.peek() === ';' && this.peek(1) === ';') {
      this.index += 2
      return ';;'
    }
    while (!this.eof()) {
      const char = this.peek()
      if (' \t\n;|&<>()'.includes(char)) break
      this.index++
    }
    return this.source.slice(start, this.index)
  }

  /** Parse one word with all its quoting and substitution forms. */
  private parseWord(): Word {
    const parts: WordPart[] = []
    let literal = ''
    const flushLiteral = (): void => {
      if (literal.length > 0) {
        parts.push({ kind: 'literal', value: literal })
        literal = ''
      }
    }
    for (;;) {
      if (this.eof()) break
      const char = this.peek()
      if (' \t\n;|&<>'.includes(char)) break
      if (char === ')' && parts.length + literal.length >= 0) break
      if (char === '\\') {
        this.index++
        const escaped = this.peek()
        this.index++
        if (escaped !== '\n') literal += escaped
        continue
      }
      if (char === "'") {
        flushLiteral()
        this.index++
        const end = this.source.indexOf("'", this.index)
        if (end === -1) throw new ShellSyntaxError('unterminated single quote', this.index)
        parts.push({ kind: 'quoted', value: this.source.slice(this.index, end) })
        this.index = end + 1
        continue
      }
      if (char === '"') {
        flushLiteral()
        this.index++
        parts.push({ kind: 'dquoted', parts: this.readDoubleQuotedBody() })
        continue
      }
      if (char === '$') {
        const part = this.readDollar()
        if (part === undefined) {
          literal += '$'
          this.index++
          continue
        }
        flushLiteral()
        parts.push(part)
        continue
      }
      if (char === '`') {
        flushLiteral()
        this.index++
        const end = this.findUnescaped('`')
        const script = this.source.slice(this.index, end)
        this.index = end + 1
        parts.push({ kind: 'command', script: new Parser(script).parse() })
        continue
      }
      literal += char
      this.index++
    }
    flushLiteral()
    return parts
  }

  /** Read the body of a double-quoted string up to the closing quote. */
  private readDoubleQuotedBody(limit?: number): WordPart[] {
    const parts: WordPart[] = []
    let literal = ''
    const flushLiteral = (): void => {
      if (literal.length > 0) {
        parts.push({ kind: 'literal', value: literal })
        literal = ''
      }
    }
    const end = limit ?? Infinity
    while (this.index < Math.min(this.source.length, end)) {
      const char = this.peek()
      if (limit === undefined && char === '"') {
        this.index++
        flushLiteral()
        return parts
      }
      if (char === '\\') {
        const escaped = this.peek(1)
        if ('"\\$`\n'.includes(escaped)) {
          this.index += 2
          if (escaped !== '\n') literal += escaped
          continue
        }
        literal += char
        this.index++
        continue
      }
      if (char === '$') {
        const part = this.readDollar()
        if (part === undefined) {
          literal += '$'
          this.index++
          continue
        }
        flushLiteral()
        parts.push(part)
        continue
      }
      if (char === '`') {
        this.index++
        const close = this.findUnescaped('`')
        const script = this.source.slice(this.index, close)
        this.index = close + 1
        flushLiteral()
        parts.push({ kind: 'command', script: new Parser(script).parse() })
        continue
      }
      literal += char
      this.index++
    }
    flushLiteral()
    if (limit === undefined) throw new ShellSyntaxError('unterminated double quote', this.index)
    return parts
  }

  /** Parse a `$`-introduced expansion; undefined when `$` is a bare literal. */
  private readDollar(): WordPart | undefined {
    const next = this.peek(1)
    if (next === '(') {
      if (this.peek(2) === '(') {
        this.index += 3
        // Depth 1: the scan must stop at the FIRST unbalanced `)`, which is the
        // inner one of the `))` pair — anything else swallows it into the
        // expression text.
        const close = this.findMatching('(', ')', 1)
        const expression = this.source.slice(this.index, close)
        this.index = close + 2
        return { kind: 'arith', expression }
      }
      this.index += 2
      const close = this.findMatching('(', ')', 1)
      const script = this.source.slice(this.index, close)
      this.index = close + 1
      return { kind: 'command', script: new Parser(script).parse() }
    }
    if (next === '{') {
      this.index += 2
      const close = this.findMatching('{', '}', 1)
      const body = this.source.slice(this.index, close)
      this.index = close + 1
      return this.parseParameterExpression(body)
    }
    if (/[A-Za-z_]/.test(next)) {
      this.index++
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))!
      this.index += match[0].length
      return { kind: 'param', name: match[0] }
    }
    if (/[0-9@*#?$!-]/.test(next)) {
      this.index += 2
      return { kind: 'param', name: next }
    }
    return undefined
  }

  /** Parse the inside of `${…}`: name plus an optional operator and argument. */
  private parseParameterExpression(body: string): WordPart {
    if (body.startsWith('#') && body.length > 1) {
      // ${#VAR} — string length, modeled as an operator on the name.
      return { kind: 'param', name: body.slice(1), op: '#' }
    }
    // `arr[0]`, `arr[@]`, `arr[*]` name an array element rather than a variable.
    const match = /^([A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])(.*)$/s.exec(body)
    if (match === null) return { kind: 'literal', value: `\${${body}}` }
    const [, name, rest] = match
    if (rest.length === 0) return { kind: 'param', name }
    for (const op of ['##', '%%', ':-', ':=', ':+', ':?', '//', '^^', ',,', '#', '%', '-', '+', '/', '^', ','] as const) {
      if (rest.startsWith(op)) {
        return { kind: 'param', name, op, argument: new Parser(rest.slice(op.length)).parseWordToEnd() }
      }
    }
    // `${VAR:offset:length}`. Checked after the `:-`-style operators above, so
    // only a `:` followed by something arithmetic reaches here.
    if (rest.startsWith(':')) {
      return { kind: 'param', name, op: 'substring', argument: new Parser(rest.slice(1)).parseWordToEnd() }
    }
    return { kind: 'param', name }
  }

  /** Parse a complete word from a standalone source string. */
  private parseWordToEnd(): Word {
    const parts: WordPart[] = []
    let literal = ''
    while (!this.eof()) {
      const char = this.peek()
      if (char === '$') {
        const part = this.readDollar()
        if (part === undefined) {
          literal += '$'
          this.index++
          continue
        }
        if (literal.length > 0) {
          parts.push({ kind: 'literal', value: literal })
          literal = ''
        }
        parts.push(part)
        continue
      }
      if (char === '\\') {
        this.index++
        literal += this.peek()
        this.index++
        continue
      }
      literal += char
      this.index++
    }
    if (literal.length > 0) parts.push({ kind: 'literal', value: literal })
    return parts
  }

  /** Index of the next unescaped `char` at or after the cursor. */
  private findUnescaped(char: string): number {
    for (let i = this.index; i < this.source.length; i++) {
      if (this.source[i] === '\\') {
        i++
        continue
      }
      if (this.source[i] === char) return i
    }
    throw new ShellSyntaxError(`unterminated '${char}'`, this.index)
  }

  /** Index of the closing delimiter, honoring nesting and quotes. */
  private findMatching(open: string, close: string, depth: number): number {
    let level = depth
    for (let i = this.index; i < this.source.length; i++) {
      const char = this.source[i]
      if (char === '\\') {
        i++
        continue
      }
      if (char === "'") {
        const end = this.source.indexOf("'", i + 1)
        if (end === -1) break
        i = end
        continue
      }
      if (char === open) {
        level++
        continue
      }
      if (char === close) {
        level--
        if (level === 0) return i
      }
    }
    throw new ShellSyntaxError(`unterminated '${open}'`, this.index)
  }
}

/**
 * Parse a shell script.
 * @param source - the script text.
 * @returns the syntax tree.
 * @throws {ShellSyntaxError} on malformed input.
 */
export function parseScript(source: string): Node {
  return new Parser(source).parse()
}
