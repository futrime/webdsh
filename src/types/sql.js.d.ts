/**
 * `sql.js` ships no types. Only the surface `src/node/sqlite.ts` uses is
 * declared here — the factory and the handful of database and statement methods
 * `node:sqlite`'s `DatabaseSync` is built on.
 */
declare module 'sql.js' {
  /** One prepared statement. */
  export interface SqlJsStatement {
    bind(params?: unknown[] | Record<string, unknown>): boolean
    step(): boolean
    getAsObject(): Record<string, unknown>
    get(): unknown[]
    free(): void
    reset(): void
  }

  /** One open database. */
  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void
    exec(sql: string, params?: unknown[]): { columns: string[], values: unknown[][] }[]
    prepare(sql: string): SqlJsStatement
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }

  /** The initialized engine. */
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase
  }

  /** Initialize the WASM engine. */
  const initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>
  export default initSqlJs
}
