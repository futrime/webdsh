/** Syntax tree for the in-browser POSIX shell. */

/** One redirection attached to a simple command. */
export interface Redirect {
  /** File descriptor being redirected (1 for `>`, 0 for `<`, 2 for `2>`). */
  fd: number
  /** `>` truncate, `>>` append, `<` read, `&>` both, `dup` for `2>&1`, `<<<` here-string, `<<` heredoc. */
  op: '>' | '>>' | '<' | '&>' | 'dup' | '<<<' | '<<'
  /** Target: a word for file targets, a numeric string for `dup`, literal text for here-forms. */
  target: Word
}

/** A word is a sequence of parts, concatenated after expansion. */
export type Word = WordPart[]

/** One expandable fragment of a word. */
export type WordPart =
  | { kind: 'literal', value: string }
  /** Single-quoted: no expansion, no globbing, no field splitting. */
  | { kind: 'quoted', value: string }
  /** Double-quoted: expansion happens, but no globbing or field splitting. */
  | { kind: 'dquoted', parts: WordPart[] }
  | {
      kind: 'param'
      name: string
      op?: ':-' | ':=' | ':+' | ':?' | '-' | '+' | '#' | '##' | '%' | '%%' | '/' | '//'
        /** `${VAR:offset:length}`. */
        | 'substring'
        /** `${VAR^^}`, `${VAR^}`, `${VAR,,}`, `${VAR,}` — case conversion. */
        | '^^' | '^' | ',,' | ','
      argument?: Word
    }
  | { kind: 'command', script: Node }
  /** `<(…)` — the command's output, presented as a readable file. */
  | { kind: 'procsub', script: Node }
  | { kind: 'arith', expression: string }

/** A simple command: assignments, words, and redirections. */
export interface SimpleCommand {
  type: 'simple'
  assignments: { name: string, value: Word, append?: boolean, array?: Word[] }[]
  /**
   * Set for `[[ … ]]`, whose words are neither split nor glob-expanded — the
   * pattern in `[[ $f == *.ts ]]` belongs to the test, not to the filesystem.
   */
  conditional?: boolean
  words: Word[]
  redirects: Redirect[]
}

/** `a | b | c` */
export interface Pipeline {
  type: 'pipeline'
  commands: Node[]
  /** `!` prefix inverts the final status. */
  negated: boolean
}

/** `a && b`, `a || b`, `a ; b` */
export interface List {
  type: 'list'
  left: Node
  operator: '&&' | '||' | ';' | '&'
  right?: Node
}

/** `if … then … elif … else … fi` */
export interface If {
  type: 'if'
  condition: Node
  then: Node
  else?: Node
}

/** `for name in words; do … done` */
export interface For {
  type: 'for'
  name: string
  words: Word[]
  /** Absent `in` list means `"$@"`. */
  usesPositional: boolean
  body: Node
  /** Redirections written after `done`, which apply to the whole loop. */
  redirects?: Redirect[]
}

/** `while|until cond; do … done` */
export interface While {
  type: 'while'
  condition: Node
  body: Node
  until: boolean
  /** Redirections written after `done`, which apply to the whole loop. */
  redirects?: Redirect[]
}

/** `case word in pattern) body ;; esac` */
export interface Case {
  type: 'case'
  word: Word
  branches: { patterns: Word[], body: Node }[]
}

/** `name() { … }` */
export interface FunctionDef {
  type: 'function'
  name: string
  body: Node
}

/** `{ …; }` and `( … )` — the subshell flag decides whether state escapes. */
export interface Group {
  type: 'group'
  body: Node
  subshell: boolean
  redirects: Redirect[]
}

/** A sequence of statements. */
export interface Sequence {
  type: 'sequence'
  statements: Node[]
}

/** Any executable node. */
export type Node = SimpleCommand | Pipeline | List | If | For | While | Case | FunctionDef | Group | Sequence

/** Convenience constructor for a literal-only word. */
export function literalWord(value: string): Word {
  return [{ kind: 'literal', value }]
}
