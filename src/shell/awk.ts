/**
 * `awk` — the subset that shell scripts actually contain.
 *
 * Nearly every non-trivial shell pipeline has an awk in it, usually doing one
 * of a handful of things: pick a field, filter by a pattern, sum a column,
 * reformat a line. Leaving it out does not degrade those pipelines, it stops
 * them, so this implements the language rather than special-casing `{print $1}`:
 * pattern/action rules, `BEGIN`/`END`, fields and the built-in variables that
 * describe them, arithmetic and string expressions, comparison and regex
 * matching, `if`/`while`/`for` (including `for (k in array)`), user variables,
 * associative arrays, and the common built-in functions.
 *
 * What it does not have is `getline`, `printf` beyond the usual conversions,
 * coprocesses, or output redirection from inside an action — the parts that
 * assume a process and a filesystem-shaped world around the interpreter.
 */

import type { CommandContext } from './runtime.ts'
import { abs, parseArgs } from './coreutils.ts'
import { toText } from '../node/binary.ts'

/** A token from the awk program text. */
interface Token {
  kind: 'num' | 'str' | 'regex' | 'name' | 'punct' | 'keyword'
  value: string
}

const KEYWORDS = new Set([
  'BEGIN', 'END', 'if', 'else', 'while', 'for', 'in', 'do', 'break', 'continue',
  'next', 'exit', 'print', 'printf', 'delete', 'function', 'return', 'getline',
])

/** Multi-character operators, longest first so `>=` never lexes as `>` then `=`. */
const OPERATORS = [
  '**=', '...', '>>=', '<<=',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '!~', '**', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '^', '!', '=', '?', ':', '$', '~', '|',
]

/**
 * Tokenize an awk program.
 * @param source - the program text.
 * @returns the token stream.
 */
function lex(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  /** A `/` starts a regex only where a value may begin, not after one. */
  const regexAllowed = (): boolean => {
    const previous = tokens[tokens.length - 1]
    if (previous === undefined) return true
    if (previous.kind === 'num' || previous.kind === 'str' || previous.kind === 'name') return false
    if (previous.kind === 'punct' && [')', ']', '$'].includes(previous.value)) return false
    return true
  }

  while (i < source.length) {
    const char = source[i]
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (char === '\n') { tokens.push({ kind: 'punct', value: ';' }); i++; continue }
    if (/\s/.test(char)) { i++; continue }
    if (char === '"') {
      let value = ''
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const escape = source[++i]
          value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : escape === '\\' ? '\\' : escape === '"' ? '"' : `\\${escape}`
          i++
          continue
        }
        value += source[i++]
      }
      i++
      tokens.push({ kind: 'str', value })
      continue
    }
    if (char === '/' && regexAllowed()) {
      let value = ''
      i++
      while (i < source.length && source[i] !== '/') {
        if (source[i] === '\\') { value += source[i++]; }
        value += source[i++]
      }
      i++
      tokens.push({ kind: 'regex', value })
      continue
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = ''
      while (i < source.length && /[0-9.eE]/.test(source[i])) value += source[i++]
      tokens.push({ kind: 'num', value })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = ''
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) value += source[i++]
      tokens.push({ kind: KEYWORDS.has(value) ? 'keyword' : 'name', value })
      continue
    }
    const operator = OPERATORS.find(candidate => source.startsWith(candidate, i))
    if (operator !== undefined) {
      tokens.push({ kind: 'punct', value: operator })
      i += operator.length
      continue
    }
    i++
  }
  return tokens
}

/** An awk value: a number, a string, or an array. */
type Value = number | string | Map<string, Value>

/** Coerce a value the way awk does in numeric context. */
function num(value: Value | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const match = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(value.trim())
    return match === null ? 0 : Number(match[0])
  }
  return 0
}

/** Coerce a value the way awk does in string context. */
function str(value: Value | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    // awk prints integral values without a decimal point, via OFMT/CONVFMT.
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
  }
  return ''
}

/** awk's truthiness: a non-empty string, or a non-zero number. */
function truthy(value: Value | undefined): boolean {
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== '' && value !== '0'
  return false
}

/** Parsed program: the rules, plus any user functions. */
interface Program {
  rules: { pattern?: Node, patternEnd?: Node, kind: 'begin' | 'end' | 'main', body: Node }[]
  functions: Map<string, { params: string[], body: Node }>
}

/** An expression or statement node. */
interface Node {
  type: string
  [key: string]: unknown
}

/**
 * Parse an awk program.
 * @param tokens - the token stream.
 * @returns the parsed program.
 */
function parse(tokens: Token[]): Program {
  let position = 0
  const peek = (offset = 0): Token | undefined => tokens[position + offset]
  const at = (value: string): boolean => peek()?.value === value
  const eat = (value: string): boolean => { if (at(value)) { position++; return true } return false }
  const expect = (value: string): void => {
    if (!eat(value)) throw new Error(`awk: syntax error, expected '${value}' near '${peek()?.value ?? 'end of program'}'`)
  }
  const skipTerminators = (): void => { while (at(';')) position++ }

  const program: Program = { rules: [], functions: new Map() }

  /** primary → literal | $expr | name | (expr) | ++x | function call */
  function primary(): Node {
    const token = peek()
    if (token === undefined) throw new Error('awk: unexpected end of program')
    if (token.kind === 'num') { position++; return { type: 'num', value: Number(token.value) } }
    if (token.kind === 'str') { position++; return { type: 'str', value: token.value } }
    if (token.kind === 'regex') { position++; return { type: 'match', target: { type: 'field', index: { type: 'num', value: 0 } }, regex: token.value, negate: false } }
    if (eat('(')) {
      const inner = expression()
      // `(a, b) in array` — a parenthesized subscript list.
      if (at(',')) {
        const parts = [inner]
        while (eat(',')) parts.push(expression())
        expect(')')
        return { type: 'list', parts }
      }
      expect(')')
      return { type: 'group', inner }
    }
    if (eat('$')) return { type: 'field', index: primary() }
    if (eat('!')) return { type: 'not', operand: unary() }
    if (eat('-')) return { type: 'neg', operand: unary() }
    if (eat('+')) return unary()
    if (eat('++')) return { type: 'preinc', target: unary(), by: 1 }
    if (eat('--')) return { type: 'preinc', target: unary(), by: -1 }
    if (token.kind === 'name') {
      position++
      if (at('(')) {
        position++
        const args: Node[] = []
        if (!at(')')) { args.push(expression()); while (eat(',')) args.push(expression()) }
        expect(')')
        return { type: 'call', name: token.value, args }
      }
      if (at('[')) {
        position++
        const subscripts = [expression()]
        while (eat(',')) subscripts.push(expression())
        expect(']')
        return { type: 'index', name: token.value, subscripts }
      }
      return { type: 'var', name: token.value }
    }
    throw new Error(`awk: syntax error near '${token.value}'`)
  }

  function unary(): Node {
    let node = primary()
    for (;;) {
      if (at('++') || at('--')) {
        const by = peek()!.value === '++' ? 1 : -1
        position++
        node = { type: 'postinc', target: node, by }
        continue
      }
      break
    }
    return node
  }

  function power(): Node {
    const left = unary()
    if (eat('^') || eat('**')) return { type: 'bin', op: '^', left, right: power() }
    return left
  }

  function term(): Node {
    let left = power()
    while (at('*') || at('/') || at('%')) {
      const op = peek()!.value
      position++
      left = { type: 'bin', op, left, right: power() }
    }
    return left
  }

  function additive(): Node {
    let left = term()
    while (at('+') || at('-')) {
      const op = peek()!.value
      position++
      left = { type: 'bin', op, left, right: term() }
    }
    return left
  }

  /** Concatenation is juxtaposition, which is why it has no operator to look for. */
  function concat(): Node {
    let left = additive()
    for (;;) {
      const token = peek()
      if (token === undefined) break
      const starts = token.kind === 'num' || token.kind === 'str' || token.kind === 'name' || token.kind === 'regex'
        || (token.kind === 'punct' && (token.value === '$' || token.value === '(' || token.value === '!'))
      if (!starts) break
      if (token.kind === 'name' && KEYWORDS.has(token.value)) break
      left = { type: 'concat', left, right: additive() }
    }
    return left
  }

  function relational(): Node {
    const left = concat()
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (at(op)) { position++; return { type: 'cmp', op, left, right: concat() } }
    }
    return left
  }

  function matching(): Node {
    let left = relational()
    while (at('~') || at('!~')) {
      const negate = peek()!.value === '!~'
      position++
      const right = relational()
      const regex = right.type === 'match' ? String(right.regex) : undefined
      left = { type: 'match', target: left, regex, expr: regex === undefined ? right : undefined, negate }
    }
    return left
  }

  function membership(): Node {
    const left = matching()
    if (at('in') && peek(1)?.kind === 'name') {
      position++
      const name = peek()!.value
      position++
      return { type: 'in', subscripts: left.type === 'list' ? (left.parts as Node[]) : [left], name }
    }
    return left
  }

  function logicalAnd(): Node {
    let left = membership()
    while (eat('&&')) left = { type: 'and', left, right: membership() }
    return left
  }

  function logicalOr(): Node {
    let left = logicalAnd()
    while (eat('||')) left = { type: 'or', left, right: logicalAnd() }
    return left
  }

  function ternary(): Node {
    const condition = logicalOr()
    if (eat('?')) {
      const whenTrue = ternary()
      expect(':')
      return { type: 'ternary', condition, whenTrue, whenFalse: ternary() }
    }
    return condition
  }

  function expression(): Node {
    const left = ternary()
    for (const op of ['=', '+=', '-=', '*=', '/=', '%=', '^=']) {
      if (at(op)) {
        position++
        return { type: 'assign', op, target: left, value: expression() }
      }
    }
    return left
  }

  function statement(): Node {
    skipTerminators()
    if (at('{')) return block()
    if (eat('if')) {
      expect('(')
      const condition = expression()
      expect(')')
      const then = statement()
      skipTerminators()
      if (eat('else')) return { type: 'if', condition, then, otherwise: statement() }
      return { type: 'if', condition, then }
    }
    if (eat('while')) {
      expect('(')
      const condition = expression()
      expect(')')
      return { type: 'while', condition, body: statement() }
    }
    if (eat('do')) {
      const body = statement()
      skipTerminators()
      expect('while')
      expect('(')
      const condition = expression()
      expect(')')
      return { type: 'dowhile', condition, body }
    }
    if (eat('for')) {
      expect('(')
      // `for (k in array)` versus the three-clause form.
      if (peek()?.kind === 'name' && peek(1)?.value === 'in') {
        const name = peek()!.value
        position += 2
        const array = peek()!.value
        position++
        expect(')')
        return { type: 'forin', name, array, body: statement() }
      }
      const init = at(';') ? undefined : expression()
      expect(';')
      const condition = at(';') ? undefined : expression()
      expect(';')
      const step = at(')') ? undefined : expression()
      expect(')')
      return { type: 'for', init, condition, step, body: statement() }
    }
    if (eat('print')) {
      const args: Node[] = []
      if (!at(';') && !at('}') && peek() !== undefined && !at('>')) {
        args.push(expression())
        while (eat(',')) args.push(expression())
      }
      return { type: 'print', args }
    }
    if (eat('printf')) {
      const args: Node[] = [expression()]
      while (eat(',')) args.push(expression())
      return { type: 'printf', args }
    }
    if (eat('delete')) {
      const name = peek()!.value
      position++
      const subscripts: Node[] = []
      if (eat('[')) {
        subscripts.push(expression())
        while (eat(',')) subscripts.push(expression())
        expect(']')
      }
      return { type: 'delete', name, subscripts }
    }
    if (eat('next')) return { type: 'next' }
    if (eat('break')) return { type: 'break' }
    if (eat('continue')) return { type: 'continue' }
    if (eat('exit')) return { type: 'exit', code: at(';') || at('}') ? undefined : expression() }
    if (eat('return')) return { type: 'return', value: at(';') || at('}') ? undefined : expression() }
    const value = expression()
    return { type: 'expr', value }
  }

  function block(): Node {
    expect('{')
    const body: Node[] = []
    for (;;) {
      skipTerminators()
      if (at('}') || peek() === undefined) break
      body.push(statement())
      skipTerminators()
    }
    expect('}')
    return { type: 'block', body }
  }

  while (position < tokens.length) {
    skipTerminators()
    if (peek() === undefined) break
    if (eat('function')) {
      const name = peek()!.value
      position++
      expect('(')
      const params: string[] = []
      if (!at(')')) {
        params.push(peek()!.value)
        position++
        while (eat(',')) { params.push(peek()!.value); position++ }
      }
      expect(')')
      program.functions.set(name, { params, body: block() })
      continue
    }
    if (eat('BEGIN')) { program.rules.push({ kind: 'begin', body: block() }); continue }
    if (eat('END')) { program.rules.push({ kind: 'end', body: block() }); continue }
    if (at('{')) { program.rules.push({ kind: 'main', body: block() }); continue }
    const pattern = expression()
    if (at('{')) program.rules.push({ kind: 'main', pattern, body: block() })
    else program.rules.push({ kind: 'main', pattern, body: { type: 'print', args: [] } })
  }
  return program
}

/** Control-flow signals, thrown so they unwind nested statements. */
class NextRecord extends Error {}
class ExitProgram extends Error { constructor(readonly code: number) { super('exit') } }
class BreakLoop extends Error {}
class ContinueLoop extends Error {}
class ReturnValue extends Error { constructor(readonly value: Value) { super('return') } }

/**
 * Run an awk program over an input stream.
 * @param program - the parsed program.
 * @param context - the command context, for output.
 * @param text - the whole input.
 * @param globals - initial variable assignments (`-v` and the environment).
 * @returns the exit status.
 */
function interpret(program: Program, context: CommandContext, text: string, globals: Map<string, Value>): number {
  const vars = globals
  vars.set('FS', vars.get('FS') ?? ' ')
  vars.set('OFS', vars.get('OFS') ?? ' ')
  vars.set('ORS', vars.get('ORS') ?? '\n')
  vars.set('RS', vars.get('RS') ?? '\n')
  vars.set('NR', 0)
  vars.set('FNR', 0)
  vars.set('NF', 0)
  let fields: string[] = []
  let record = ''
  let exitCode = 0
  /** Local scopes pushed by user function calls. */
  const scopes: Map<string, Value>[] = []

  const lookup = (name: string): Value | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]
      if (scope.has(name)) return scope.get(name)
    }
    return vars.get(name)
  }
  const assign = (name: string, value: Value): void => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) { scopes[i].set(name, value); return }
    }
    vars.set(name, value)
  }
  const arrayFor = (name: string): Map<string, Value> => {
    const existing = lookup(name)
    if (existing instanceof Map) return existing
    const created = new Map<string, Value>()
    assign(name, created)
    return created
  }

  const splitRecord = (): void => {
    const fs = str(vars.get('FS'))
    if (fs === ' ') fields = record.trim() === '' ? [] : record.trim().split(/[ \t\n]+/)
    else if (fs.length === 1 && !'\\^$.[]|()*+?{}'.includes(fs)) fields = record.split(fs)
    else fields = record.split(new RegExp(fs))
    vars.set('NF', fields.length)
  }

  const rebuildRecord = (): void => { record = fields.join(str(vars.get('OFS'))) }

  const field = (index: number): string => (index === 0 ? record : fields[index - 1] ?? '')
  const setField = (index: number, value: string): void => {
    if (index === 0) { record = value; splitRecord(); return }
    while (fields.length < index) fields.push('')
    fields[index - 1] = value
    vars.set('NF', fields.length)
    rebuildRecord()
  }

  /** Compile an awk ERE, translating the few constructs JS spells differently. */
  const regexCache = new Map<string, RegExp>()
  const toRegExp = (source: string): RegExp => {
    const cached = regexCache.get(source)
    if (cached !== undefined) return cached
    const compiled = new RegExp(source.replace(/\[:alpha:\]/g, 'a-zA-Z').replace(/\[:digit:\]/g, '0-9')
      .replace(/\[:alnum:\]/g, 'a-zA-Z0-9').replace(/\[:space:\]/g, '\\s'))
    regexCache.set(source, compiled)
    return compiled
  }

  /** awk's `printf`/`sprintf` conversions. */
  const format = (spec: string, args: Value[]): string => {
    let index = 0
    return spec.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([diouxXeEfgGcs%])/g, (_all, flagChars: string, width: string, precision: string, kind: string) => {
      if (kind === '%') return '%'
      const value = args[index++]
      let out: string
      switch (kind) {
        case 'd': case 'i': out = String(Math.trunc(num(value))); break
        case 'o': out = Math.trunc(num(value)).toString(8); break
        case 'x': out = Math.trunc(num(value)).toString(16); break
        case 'X': out = Math.trunc(num(value)).toString(16).toUpperCase(); break
        case 'u': out = String(Math.abs(Math.trunc(num(value)))); break
        case 'e': case 'E': {
          out = num(value).toExponential(precision === undefined ? 6 : Number(precision))
          if (kind === 'E') out = out.toUpperCase()
          break
        }
        case 'f': out = num(value).toFixed(precision === undefined ? 6 : Number(precision)); break
        case 'g': case 'G': out = String(Number(num(value).toPrecision(precision === undefined ? 6 : Number(precision)))); break
        case 'c': out = typeof value === 'number' ? String.fromCharCode(value) : str(value).charAt(0); break
        default: out = precision === undefined ? str(value) : str(value).slice(0, Number(precision))
      }
      if (width !== undefined) {
        const target = Number(width)
        if (flagChars.includes('-')) out = out.padEnd(target)
        else if (flagChars.includes('0') && 'dioxXeEfgG'.includes(kind)) {
          const negative = out.startsWith('-')
          out = (negative ? '-' : '') + (negative ? out.slice(1) : out).padStart(negative ? target - 1 : target, '0')
        } else out = out.padStart(target)
      }
      return out
    })
  }

  function evaluate(node: Node): Value {
    switch (node.type) {
      case 'num': return node.value as number
      case 'str': return node.value as string
      case 'group': return evaluate(node.inner as Node)
      case 'field': return field(Math.trunc(num(evaluate(node.index as Node))))
      case 'var': {
        const value = lookup(node.name as string)
        return value ?? ''
      }
      case 'index': {
        const array = arrayFor(node.name as string)
        const key = (node.subscripts as Node[]).map(part => str(evaluate(part))).join('')
        return array.get(key) ?? ''
      }
      case 'in': {
        const array = arrayFor(node.name as string)
        const key = (node.subscripts as Node[]).map(part => str(evaluate(part))).join('')
        return array.has(key) ? 1 : 0
      }
      case 'concat': return str(evaluate(node.left as Node)) + str(evaluate(node.right as Node))
      case 'neg': return -num(evaluate(node.operand as Node))
      case 'not': return truthy(evaluate(node.operand as Node)) ? 0 : 1
      case 'and': return truthy(evaluate(node.left as Node)) && truthy(evaluate(node.right as Node)) ? 1 : 0
      case 'or': return truthy(evaluate(node.left as Node)) || truthy(evaluate(node.right as Node)) ? 1 : 0
      case 'ternary': return truthy(evaluate(node.condition as Node)) ? evaluate(node.whenTrue as Node) : evaluate(node.whenFalse as Node)
      case 'bin': {
        const left = num(evaluate(node.left as Node))
        const right = num(evaluate(node.right as Node))
        switch (node.op) {
          case '+': return left + right
          case '-': return left - right
          case '*': return left * right
          case '/': return left / right
          case '%': return left % right
          default: return left ** right
        }
      }
      case 'cmp': {
        const left = evaluate(node.left as Node)
        const right = evaluate(node.right as Node)
        // Two values compare numerically only when both look numeric, which is
        // the rule that makes `$1 == "10"` behave as people expect.
        const numeric = (typeof left === 'number' || /^\s*[-+]?[\d.]+\s*$/.test(str(left)))
          && (typeof right === 'number' || /^\s*[-+]?[\d.]+\s*$/.test(str(right)))
        const a: number | string = numeric ? num(left) : str(left)
        const b: number | string = numeric ? num(right) : str(right)
        switch (node.op) {
          case '<': return a < b ? 1 : 0
          case '>': return a > b ? 1 : 0
          case '<=': return a <= b ? 1 : 0
          case '>=': return a >= b ? 1 : 0
          case '==': return a === b ? 1 : 0
          default: return a !== b ? 1 : 0
        }
      }
      case 'match': {
        const subject = str(evaluate(node.target as Node))
        const source = node.regex !== undefined ? String(node.regex) : str(evaluate(node.expr as Node))
        const hit = toRegExp(source).test(subject)
        return (node.negate === true ? !hit : hit) ? 1 : 0
      }
      case 'assign': {
        const target = node.target as Node
        const incoming = evaluate(node.value as Node)
        const current = node.op === '=' ? 0 : num(evaluate(target))
        const next: Value = node.op === '='
          ? incoming
          : node.op === '+=' ? current + num(incoming)
            : node.op === '-=' ? current - num(incoming)
              : node.op === '*=' ? current * num(incoming)
                : node.op === '/=' ? current / num(incoming)
                  : node.op === '%=' ? current % num(incoming)
                    : current ** num(incoming)
        store(target, next)
        return next
      }
      case 'preinc': {
        const target = node.target as Node
        const next = num(evaluate(target)) + (node.by as number)
        store(target, next)
        return next
      }
      case 'postinc': {
        const target = node.target as Node
        const before = num(evaluate(target))
        store(target, before + (node.by as number))
        return before
      }
      case 'call': return call(node.name as string, node.args as Node[])
      case 'list': return str(evaluate((node.parts as Node[])[0]))
      default: return ''
    }
  }

  function store(target: Node, value: Value): void {
    if (target.type === 'var') {
      assign(target.name as string, value)
      if (target.name === 'NF') {
        fields = fields.slice(0, Math.trunc(num(value)))
        rebuildRecord()
      }
      return
    }
    if (target.type === 'field') {
      setField(Math.trunc(num(evaluate(target.index as Node))), str(value))
      return
    }
    if (target.type === 'index') {
      const array = arrayFor(target.name as string)
      array.set((target.subscripts as Node[]).map(part => str(evaluate(part))).join(''), value)
      return
    }
    if (target.type === 'group') store(target.inner as Node, value)
  }

  function call(name: string, args: Node[]): Value {
    const user = program.functions.get(name)
    if (user !== undefined) {
      const scope = new Map<string, Value>()
      user.params.forEach((param, index) => {
        // Arrays pass by reference and scalars by value, as awk specifies.
        const argument = args[index]
        if (argument === undefined) { scope.set(param, ''); return }
        if (argument.type === 'var') {
          const existing = lookup(argument.name as string)
          scope.set(param, existing instanceof Map ? existing : evaluate(argument))
          return
        }
        scope.set(param, evaluate(argument))
      })
      scopes.push(scope)
      try {
        run(user.body)
        return ''
      } catch (error) {
        if (error instanceof ReturnValue) return error.value
        throw error
      } finally {
        scopes.pop()
      }
    }

    const value = (index: number): Value => (args[index] === undefined ? '' : evaluate(args[index]))
    switch (name) {
      case 'length': {
        if (args.length === 0) return record.length
        const subject = args[0].type === 'var' ? lookup(args[0].name as string) : value(0)
        return subject instanceof Map ? subject.size : str(subject).length
      }
      case 'substr': {
        const subject = str(value(0))
        const start = Math.trunc(num(value(1)))
        const from = Math.max(1, start) - 1
        if (args.length < 3) return subject.slice(from)
        const count = Math.trunc(num(value(2))) + Math.min(0, start - 1)
        return subject.slice(from, from + Math.max(0, count))
      }
      case 'index': return str(value(0)).indexOf(str(value(1))) + 1
      case 'split': {
        const subject = str(value(0))
        const array = arrayFor((args[1] as Node).name as string)
        array.clear()
        const separator = args.length > 2 ? str(value(2)) : str(vars.get('FS'))
        const parts = separator === ' '
          ? (subject.trim() === '' ? [] : subject.trim().split(/[ \t\n]+/))
          : subject.split(separator.length === 1 && !'\\^$.[]|()*+?{}'.includes(separator) ? separator : new RegExp(separator))
        parts.forEach((part, index) => { array.set(String(index + 1), part) })
        return parts.length
      }
      case 'sub': case 'gsub': {
        const pattern = args[0].type === 'match' ? String(args[0].regex) : str(value(0))
        const replacement = str(value(1))
        const target = args[2] ?? { type: 'field', index: { type: 'num', value: 0 } }
        const subject = str(evaluate(target))
        const regex = new RegExp(pattern, name === 'gsub' ? 'g' : '')
        let count = 0
        const result = subject.replace(regex, (matched) => {
          count++
          return replacement.replace(/\\?&/g, escaped => (escaped === '&' ? matched : '&'))
        })
        store(target, result)
        return count
      }
      case 'match': {
        const subject = str(value(0))
        const pattern = args[1]?.type === 'match' ? String(args[1].regex) : str(value(1))
        const found = toRegExp(pattern).exec(subject)
        vars.set('RSTART', found === null ? 0 : found.index + 1)
        vars.set('RLENGTH', found === null ? -1 : found[0].length)
        return found === null ? 0 : found.index + 1
      }
      case 'sprintf': return format(str(value(0)), args.slice(1).map(argument => evaluate(argument)))
      case 'toupper': return str(value(0)).toUpperCase()
      case 'tolower': return str(value(0)).toLowerCase()
      case 'int': return Math.trunc(num(value(0)))
      case 'sqrt': return Math.sqrt(num(value(0)))
      case 'exp': return Math.exp(num(value(0)))
      case 'log': return Math.log(num(value(0)))
      case 'sin': return Math.sin(num(value(0)))
      case 'cos': return Math.cos(num(value(0)))
      case 'atan2': return Math.atan2(num(value(0)), num(value(1)))
      case 'systime': return Math.floor(Date.now() / 1000)
      // A deterministic sequence: this realm's `Math.random` is unavailable in
      // some contexts, and scripts that use rand() mostly want variety, not
      // unpredictability.
      case 'srand': { randomState = Math.trunc(num(value(0))) || 1; return 0 }
      case 'rand': {
        randomState = (Math.imul(randomState, 1103515245) + 12345) & 0x7fffffff
        return randomState / 0x7fffffff
      }
      default: throw new Error(`awk: calling undefined function ${name}`)
    }
  }

  let randomState = 1

  function run(node: Node): void {
    switch (node.type) {
      case 'block': for (const statement of node.body as Node[]) run(statement); return
      case 'expr': evaluate(node.value as Node); return
      case 'print': {
        const args = node.args as Node[]
        const text = args.length === 0
          ? record
          : args.map(argument => str(evaluate(argument))).join(str(vars.get('OFS')))
        context.stdout.write(text + str(vars.get('ORS')))
        return
      }
      case 'printf': {
        const args = node.args as Node[]
        context.stdout.write(format(str(evaluate(args[0])), args.slice(1).map(argument => evaluate(argument))))
        return
      }
      case 'if':
        if (truthy(evaluate(node.condition as Node))) run(node.then as Node)
        else if (node.otherwise !== undefined) run(node.otherwise as Node)
        return
      case 'while':
        while (truthy(evaluate(node.condition as Node))) {
          try { run(node.body as Node) } catch (error) {
            if (error instanceof BreakLoop) break
            if (!(error instanceof ContinueLoop)) throw error
          }
        }
        return
      case 'dowhile':
        do {
          try { run(node.body as Node) } catch (error) {
            if (error instanceof BreakLoop) break
            if (!(error instanceof ContinueLoop)) throw error
          }
        } while (truthy(evaluate(node.condition as Node)))
        return
      case 'for': {
        if (node.init !== undefined) evaluate(node.init as Node)
        while (node.condition === undefined || truthy(evaluate(node.condition as Node))) {
          try { run(node.body as Node) } catch (error) {
            if (error instanceof BreakLoop) break
            if (!(error instanceof ContinueLoop)) throw error
          }
          if (node.step !== undefined) evaluate(node.step as Node)
        }
        return
      }
      case 'forin': {
        const array = arrayFor(node.array as string)
        for (const key of [...array.keys()]) {
          assign(node.name as string, key)
          try { run(node.body as Node) } catch (error) {
            if (error instanceof BreakLoop) break
            if (!(error instanceof ContinueLoop)) throw error
          }
        }
        return
      }
      case 'delete': {
        const array = arrayFor(node.name as string)
        const subscripts = node.subscripts as Node[]
        if (subscripts.length === 0) array.clear()
        else array.delete(subscripts.map(part => str(evaluate(part))).join(''))
        return
      }
      case 'next': throw new NextRecord()
      case 'break': throw new BreakLoop()
      case 'continue': throw new ContinueLoop()
      case 'exit': throw new ExitProgram(node.code === undefined ? 0 : Math.trunc(num(evaluate(node.code as Node))))
      case 'return': throw new ReturnValue(node.value === undefined ? '' : evaluate(node.value as Node))
      default: evaluate(node)
    }
  }

  const runRules = (kind: 'begin' | 'end'): void => {
    for (const rule of program.rules) {
      if (rule.kind !== kind) continue
      run(rule.body)
    }
  }

  try {
    runRules('begin')
    const hasMain = program.rules.some(rule => rule.kind === 'main')
    const hasEnd = program.rules.some(rule => rule.kind === 'end')
    if (hasMain || hasEnd) {
      const separator = str(vars.get('RS'))
      const records = (separator === '\n' ? text.split('\n') : text.split(separator))
      if (records[records.length - 1] === '') records.pop()
      for (const line of records) {
        record = line
        splitRecord()
        vars.set('NR', num(vars.get('NR')) + 1)
        vars.set('FNR', num(vars.get('FNR')) + 1)
        try {
          for (const rule of program.rules) {
            if (rule.kind !== 'main') continue
            if (rule.pattern !== undefined && !truthy(evaluate(rule.pattern))) continue
            run(rule.body)
          }
        } catch (error) {
          if (!(error instanceof NextRecord)) throw error
        }
      }
    }
    runRules('end')
  } catch (error) {
    if (error instanceof ExitProgram) {
      exitCode = error.code
      try {
        runRules('end')
      } catch {
        // An `exit` inside END is final; there is nothing left to run.
      }
    } else throw error
  }
  return exitCode
}

/**
 * `awk`.
 * @param context - the command context.
 * @returns the exit status.
 */
export function awk(context: CommandContext): number {
  const { operands, values, flags } = parseArgs(context.argv, 'vfF')
  void flags
  const globals = new Map<string, Value>()

  // `-v` may appear more than once, which the shared parser collapses; read the
  // argv directly so every assignment survives.
  const argv = context.argv
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '-v') continue
    const assignment = argv[++i] ?? ''
    const equals = assignment.indexOf('=')
    if (equals > 0) globals.set(assignment.slice(0, equals), assignment.slice(equals + 1))
  }
  const fieldSeparator = values.get('F')
  if (fieldSeparator !== undefined) globals.set('FS', fieldSeparator === 't' ? '\t' : fieldSeparator)

  let source: string
  const rest = [...operands]
  const programFile = values.get('f')
  if (programFile !== undefined) {
    try {
      source = toText(context.shell.volume.readFile(abs(context, programFile)))
    } catch {
      context.stderr.write(`awk: can't open file ${programFile}\n`)
      return 2
    }
  } else {
    const first = rest.shift()
    if (first === undefined) {
      context.stderr.write('usage: awk [-F sep] [-v var=value] program [file ...]\n')
      return 2
    }
    source = first
  }

  let text: string
  const files = rest.filter(operand => !operand.includes('='))
  if (files.length === 0) text = context.stdin
  else {
    const parts: string[] = []
    for (const file of files) {
      try {
        parts.push(toText(context.shell.volume.readFile(abs(context, file))))
      } catch {
        context.stderr.write(`awk: can't open file ${file}\n`)
        return 2
      }
    }
    text = parts.join('')
  }

  try {
    return interpret(parse(lex(source)), context, text, globals)
  } catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
