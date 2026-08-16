/**
 * `node:sqlite` (`DatabaseSync`) over sql.js.
 *
 * The shipped web composition mounts `dsh-session-query-sqlite` with
 * `openAt: never`, so nothing opens a database unless a deployment turns
 * full-text session search on. Because `DatabaseSync` is synchronous and sql.js
 * initializes asynchronously, the engine is warmed in the background at boot;
 * {@link prepareSqlite} is what a composition enabling search should await
 * first, and constructing a database before the engine is ready fails with a
 * message that says exactly that.
 */

import type { SqlJsDatabase, SqlJsStatement, SqlJsStatic } from 'sql.js'

let engine: SqlJsStatic | undefined
let warming: Promise<SqlJsStatic> | undefined

/**
 * Load the sql.js engine.
 * @returns the initialized engine (idempotent; concurrent callers share one load).
 */
export async function prepareSqlite(): Promise<SqlJsStatic> {
  warming ??= (async () => {
    const factory = (await import('sql.js')).default
    engine = await factory({
      locateFile: (file: string) => new URL(`sql-wasm/${file}`, document.baseURI).href,
    })
    return engine
  })()
  return warming
}

/** Whether a synchronous `DatabaseSync` construction can succeed right now. */
export function sqliteReady(): boolean {
  return engine !== undefined
}

/** One prepared statement, matching `node:sqlite`'s `StatementSync`. */
class StatementSync {
  constructor(private readonly statement: SqlJsStatement, private readonly database: SqlJsDatabase) {}

  /** Run the statement and return every row as an object. */
  all(...params: unknown[]): Record<string, unknown>[] {
    this.statement.reset()
    this.statement.bind(params)
    const rows: Record<string, unknown>[] = []
    while (this.statement.step()) rows.push(this.statement.getAsObject())
    return rows
  }

  /** Run the statement and return the first row, or undefined. */
  get(...params: unknown[]): Record<string, unknown> | undefined {
    this.statement.reset()
    this.statement.bind(params)
    return this.statement.step() ? this.statement.getAsObject() : undefined
  }

  /** Execute a write and report the change count. */
  run(...params: unknown[]): { changes: number, lastInsertRowid: number } {
    this.statement.reset()
    this.statement.bind(params)
    while (this.statement.step()) { /* drain any result rows */ }
    return { changes: this.database.getRowsModified(), lastInsertRowid: 0 }
  }

  /** Iterate rows lazily. */
  *iterate(...params: unknown[]): Generator<Record<string, unknown>> {
    this.statement.reset()
    this.statement.bind(params)
    while (this.statement.step()) yield this.statement.getAsObject()
  }

  setReadBigInts(): void {}
  setAllowBareNamedParameters(): void {}
  finalize(): void {
    this.statement.free()
  }
}

/** `node:sqlite`'s `DatabaseSync`. */
export class DatabaseSync {
  private readonly database: SqlJsDatabase
  private closed = false

  constructor(readonly location: string) {
    if (engine === undefined) {
      throw new Error(
        'node:sqlite is not ready in the browser host. The shipped web composition mounts '
        + 'session search with `openAt: never`; a composition that opens a database must await '
        + 'prepareSqlite() during boot.',
      )
    }
    this.database = new engine.Database()
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this.database.prepare(sql), this.database)
  }

  exec(sql: string): void {
    this.database.run(sql)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  /** Serialize the database (an in-memory database has no file to persist to). */
  serialize(): Uint8Array {
    return this.database.export()
  }

  enableLoadExtension(): void {}
  loadExtension(): void {}
  function(): void {}
  [Symbol.dispose](): void {
    this.close()
  }
}

export const constants = { SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2 }

export const sqliteModule = { DatabaseSync, StatementSync, constants, default: undefined as unknown }
sqliteModule.default = sqliteModule

export default sqliteModule
