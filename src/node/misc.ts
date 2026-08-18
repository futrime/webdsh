/**
 * The small `node:*` modules, grouped in one file because each is a handful of
 * members: `url`, `util`, `assert`, `tty`, `querystring`, `string_decoder`,
 * `perf_hooks`, `async_hooks`, `timers`, `timers/promises`, `constants`,
 * `module`, `vm`, `dns`, `zlib`, and `readline`.
 *
 * Each export block below is wired to its specifier by `registry.ts`.
 */

import { Buffer, toBytes, toText } from './binary.ts'
import { resolve as resolvePath, isAbsolute } from '../vfs/path.ts'
import { deflateSync, gunzipSync, gzipSync, inflateSync } from 'fflate'
import { AsyncLocalStorage, AsyncResource } from './async-context.ts'
import { zstdCompress, zstdCompressSync, zstdDecompress, zstdDecompressSync } from './zstd.ts'

// ---- node:url --------------------------------------------------------------

/**
 * `url.fileURLToPath`.
 *
 * Node throws for a non-`file:` URL. In the browser the common caller is
 * `fileURLToPath(new URL('…', import.meta.url))` running at module scope, where
 * `import.meta.url` is an http URL — and throwing there kills the whole plugin
 * before it can decide it does not need the path. Returning the URL's pathname
 * keeps that module loading, and any code that actually reads the resulting
 * path gets a plain `ENOENT` from the virtual filesystem instead.
 */
export function fileURLToPath(input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : input
  return decodeURIComponent(url.pathname)
}

/** `url.pathToFileURL`. */
export function pathToFileURL(input: string): URL {
  const absolute = isAbsolute(input) ? input : resolvePath(input)
  return new URL(`file://${absolute.split('/').map(encodeURIComponent).join('/')}`)
}

/** `url.format` for a WHATWG URL (the legacy object form is not used by dsh). */
export function formatUrl(input: URL | { href?: string }): string {
  return input instanceof URL ? input.href : (input.href ?? '')
}

/** Legacy `url.parse`, mapped onto WHATWG parsing. */
export function parseUrl(input: string): Record<string, string | null> {
  try {
    const url = new URL(input)
    return {
      href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname,
      port: url.port, pathname: url.pathname, search: url.search, hash: url.hash,
      path: `${url.pathname}${url.search}`,
    }
  } catch {
    return { href: input, protocol: null, host: null, hostname: null, port: null, pathname: input, search: null, hash: null, path: input }
  }
}

export const urlModule = {
  URL, URLSearchParams, fileURLToPath, pathToFileURL,
  format: formatUrl, parse: parseUrl, resolve: (from: string, to: string): string => new URL(to, from).href,
  domainToASCII: (domain: string): string => domain,
  domainToUnicode: (domain: string): string => domain,
  default: undefined as unknown,
}
urlModule.default = urlModule

// ---- node:util -------------------------------------------------------------

/** Structural deep equality matching `util.isDeepStrictEqual`. */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => isDeepStrictEqual(value, (b as unknown[])[index]))
  }
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime()
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !isDeepStrictEqual(value, b.get(key))) return false
    }
    return true
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false
    for (const value of a) if (!b.has(value)) return false
    return true
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  const keysA = Reflect.ownKeys(a)
  const keysB = Reflect.ownKeys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every(key => isDeepStrictEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key]))
}

/** `util.inspect`, good enough for log lines and error messages. */
export function inspect(value: unknown, options?: { depth?: number | null }): string {
  const maxDepth = options?.depth === null ? Infinity : options?.depth ?? 2
  const seen = new WeakSet<object>()
  const render = (input: unknown, depth: number): string => {
    if (typeof input === 'string') return depth === 0 ? input : JSON.stringify(input)
    if (typeof input === 'bigint') return `${input.toString()}n`
    if (typeof input === 'function') return `[Function: ${input.name || 'anonymous'}]`
    if (typeof input !== 'object' || input === null) return String(input)
    if (seen.has(input)) return '[Circular]'
    if (input instanceof Error) return input.stack ?? `${input.name}: ${input.message}`
    if (depth > maxDepth) return Array.isArray(input) ? '[Array]' : '[Object]'
    seen.add(input)
    if (Array.isArray(input)) return `[ ${input.map(item => render(item, depth + 1)).join(', ')} ]`
    if (input instanceof Map) return `Map(${String(input.size)}) { ${[...input].map(([k, v]) => `${render(k, depth + 1)} => ${render(v, depth + 1)}`).join(', ')} }`
    if (input instanceof Set) return `Set(${String(input.size)}) { ${[...input].map(item => render(item, depth + 1)).join(', ')} }`
    const body = Object.entries(input).map(([key, item]) => `${key}: ${render(item, depth + 1)}`).join(', ')
    return body.length === 0 ? '{}' : `{ ${body} }`
  }
  return render(value, 0)
}

/** `util.format`, supporting `%s %d %i %f %j %o %O %%`. */
export function format(first?: unknown, ...rest: unknown[]): string {
  if (typeof first !== 'string') return [first, ...rest].map(value => inspect(value)).join(' ')
  let index = 0
  const formatted = first.replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%'
    if (index >= rest.length) return token
    const value = rest[index++]
    switch (token) {
      case '%s': return typeof value === 'string' ? value : inspect(value)
      case '%d': case '%f': return String(Number(value))
      case '%i': return String(Math.trunc(Number(value)))
      case '%j': try { return JSON.stringify(value) ?? 'undefined' } catch { return '[Circular]' }
      default: return inspect(value)
    }
  })
  const tail = rest.slice(index).map(value => (typeof value === 'string' ? value : inspect(value)))
  return [formatted, ...tail].join(' ')
}

/** `util.promisify` for the `(…, callback)` convention. */
export function promisify<T>(fn: (...args: unknown[]) => void): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) => new Promise<T>((resolve, reject) => {
    fn(...args, (error: unknown, value: T) => {
      if (error !== null && error !== undefined) reject(error as Error)
      else resolve(value)
    })
  })
}

/** `util.callbackify`. */
export function callbackify(fn: (...args: unknown[]) => Promise<unknown>): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const callback = args.pop() as (error: unknown, value?: unknown) => void
    fn(...args).then(value => { callback(null, value) }, (error: unknown) => { callback(error) })
  }
}

/** `util.parseArgs` — the subset dsh's cmdline uses (options + positionals). */
export function parseArgs(config: {
  args?: string[]
  options?: Record<string, { type: 'string' | 'boolean', short?: string, multiple?: boolean, default?: unknown }>
  allowPositionals?: boolean
  strict?: boolean
}): { values: Record<string, unknown>, positionals: string[] } {
  const args = config.args ?? []
  const options = config.options ?? {}
  const shorts = new Map<string, string>()
  for (const [name, spec] of Object.entries(options)) {
    if (spec.short !== undefined) shorts.set(spec.short, name)
  }
  const values: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(options)) {
    if (spec.default !== undefined) values[name] = spec.default
  }
  const positionals: string[] = []
  const assign = (name: string, value: unknown): void => {
    if (options[name]?.multiple === true) {
      const list = (values[name] as unknown[] | undefined) ?? []
      list.push(value)
      values[name] = list
    } else {
      values[name] = value
    }
  }
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
      const spec = options[name]
      if (spec === undefined) {
        if (config.strict === false) continue
        throw new TypeError(`Unknown option '--${name}'`)
      }
      if (spec.type === 'boolean') assign(name, true)
      else assign(name, equals === -1 ? args[++i] : token.slice(equals + 1))
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      const name = shorts.get(token.slice(1))
      if (name === undefined) {
        if (config.strict === false) continue
        throw new TypeError(`Unknown option '${token}'`)
      }
      if (options[name].type === 'boolean') assign(name, true)
      else assign(name, args[++i])
      continue
    }
    positionals.push(token)
  }
  return { values, positionals }
}

/** `util.parseEnv` (Node 22+): parse a `.env` document. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = line.slice(0, equals).trim().replace(/^export\s+/, '')
    let value = line.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** `util.deprecate` — the browser host just returns the function unchanged. */
export function deprecate<T>(fn: T): T {
  return fn
}

/** `util.stripVTControlCharacters` — drop ANSI escape sequences. */
export function stripVTControlCharacters(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

/** `util.styleText` (Node 22): the browser console has no ANSI styling to apply. */
export function styleText(_format: unknown, text: string): string {
  return text
}

/** `util.toUSVString`. */
export function toUSVString(input: string): string {
  const wellFormed = (input as { toWellFormed?: () => string }).toWellFormed
  return typeof wellFormed === 'function' ? wellFormed.call(input) : input
}

export const utilModule = {
  inspect, format, promisify, callbackify, isDeepStrictEqual, parseArgs, parseEnv, deprecate,
  stripVTControlCharacters, styleText, toUSVString,
  formatWithOptions: (_options: unknown, ...args: unknown[]): string => format(...args),
  TextEncoder, TextDecoder,
  types: {
    isPromise: (value: unknown): boolean => value instanceof Promise,
    isDate: (value: unknown): boolean => value instanceof Date,
    isRegExp: (value: unknown): boolean => value instanceof RegExp,
    isMap: (value: unknown): boolean => value instanceof Map,
    isSet: (value: unknown): boolean => value instanceof Set,
    isTypedArray: (value: unknown): boolean => ArrayBuffer.isView(value) && !(value instanceof DataView),
    isArrayBuffer: (value: unknown): boolean => value instanceof ArrayBuffer,
    isUint8Array: (value: unknown): boolean => value instanceof Uint8Array,
    isNativeError: (value: unknown): boolean => value instanceof Error,
    isProxy: (): boolean => false,
  },
  inherits(child: { prototype: object, super_?: unknown }, parent: { prototype: object }): void {
    Object.setPrototypeOf(child.prototype, parent.prototype)
    child.super_ = parent
  },
  default: undefined as unknown,
}
utilModule.default = utilModule

// ---- node:assert -----------------------------------------------------------

/** `AssertionError`, shaped like Node's. */
export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  constructor(options: { message?: string, actual?: unknown, expected?: unknown, operator?: string }) {
    super(options.message ?? `${inspect(options.actual)} ${options.operator ?? '=='} ${inspect(options.expected)}`)
    this.name = 'AssertionError'
  }
}

/** `assert(value)` plus the named forms hanging off it. */
function assertOk(value: unknown, message?: string): asserts value {
  if (value === false || value === null || value === undefined || value === 0 || value === '') {
    throw new AssertionError({ message: message ?? 'The expression evaluated to a falsy value' })
  }
}

export const assertModule = Object.assign(assertOk, {
  ok: assertOk,
  equal(actual: unknown, expected: unknown, message?: string): void {
    // eslint-disable-next-line eqeqeq
    if (actual != expected) throw new AssertionError({ message, actual, expected, operator: '==' })
  },
  strictEqual(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'strictEqual' })
  },
  notStrictEqual(actual: unknown, expected: unknown, message?: string): void {
    if (Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'notStrictEqual' })
  },
  deepStrictEqual(actual: unknown, expected: unknown, message?: string): void {
    if (!isDeepStrictEqual(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'deepStrictEqual' })
  },
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void {
    if (isDeepStrictEqual(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'notDeepStrictEqual' })
  },
  fail(message?: string): never {
    throw new AssertionError({ message: message ?? 'Failed' })
  },
  throws(body: () => unknown, message?: string): void {
    try {
      body()
    } catch {
      return
    }
    throw new AssertionError({ message: message ?? 'Missing expected exception' })
  },
  doesNotThrow(body: () => unknown): void {
    body()
  },
  match(value: string, pattern: RegExp, message?: string): void {
    if (!pattern.test(value)) throw new AssertionError({ message, actual: value, expected: pattern, operator: 'match' })
  },
  AssertionError,
  strict: undefined as unknown,
  default: undefined as unknown,
})
assertModule.strict = assertModule
assertModule.default = assertModule

// ---- node:tty --------------------------------------------------------------

export const ttyModule = {
  isatty: (): boolean => false,
  ReadStream: class {},
  WriteStream: class {},
  default: undefined as unknown,
}
ttyModule.default = ttyModule

// ---- node:querystring ------------------------------------------------------

export const querystringModule = {
  parse: (input: string): Record<string, string> => Object.fromEntries(new URLSearchParams(input)),
  stringify: (input: Record<string, string>): string => new URLSearchParams(input).toString(),
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
  default: undefined as unknown,
}
querystringModule.default = querystringModule

// ---- node:string_decoder ---------------------------------------------------

/** `StringDecoder`, backed by a streaming `TextDecoder`. */
export class StringDecoder {
  private readonly decoder: TextDecoder
  constructor(encoding = 'utf8') {
    this.decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding)
  }

  write(chunk: Uint8Array | string): string {
    return this.decoder.decode(toBytes(chunk), { stream: true })
  }

  end(chunk?: Uint8Array | string): string {
    const tail = chunk === undefined ? '' : this.decoder.decode(toBytes(chunk), { stream: true })
    return tail + this.decoder.decode()
  }
}

export const stringDecoderModule = { StringDecoder, default: undefined as unknown }
stringDecoderModule.default = stringDecoderModule

// ---- node:perf_hooks -------------------------------------------------------

export const perfHooksModule = {
  performance,
  PerformanceObserver: typeof PerformanceObserver === 'undefined' ? class {} : PerformanceObserver,
  monitorEventLoopDelay: () => ({ enable: () => undefined, disable: () => undefined, mean: 0, max: 0, min: 0, percentile: () => 0, reset: () => undefined }),
  default: undefined as unknown,
}
perfHooksModule.default = perfHooksModule

// ---- node:async_hooks ------------------------------------------------------

export const asyncHooksModule = {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId: (): number => 0,
  triggerAsyncId: (): number => 0,
  createHook: () => ({ enable: () => undefined, disable: () => undefined }),
  default: undefined as unknown,
}
asyncHooksModule.default = asyncHooksModule

// ---- node:timers + node:timers/promises ------------------------------------

// Every entry delegates to the *current* global rather than binding one at
// module scope: the realm's timer functions are replaced during boot to return
// Node-shaped handles, and `node:timers` has to hand back the same thing the
// global does or `.unref()` works in one spelling and not the other.
export const timersModule = {
  setTimeout: ((...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args)) as typeof globalThis.setTimeout,
  clearTimeout: ((handle?: unknown) => { globalThis.clearTimeout(handle as number) }) as typeof globalThis.clearTimeout,
  setInterval: ((...args: Parameters<typeof globalThis.setInterval>) => globalThis.setInterval(...args)) as typeof globalThis.setInterval,
  clearInterval: ((handle?: unknown) => { globalThis.clearInterval(handle as number) }) as typeof globalThis.clearInterval,
  setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]): ReturnType<typeof setTimeout> => setTimeout(() => { callback(...args) }, 0),
  clearImmediate: (handle: ReturnType<typeof setTimeout>): void => { clearTimeout(handle) },
  default: undefined as unknown,
}
timersModule.default = timersModule

export const timersPromisesModule = {
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => new Promise((resolve, reject) => {
    if (options?.signal?.aborted === true) {
      reject(options.signal.reason ?? new Error('The operation was aborted'))
      return
    }
    const timer = globalThis.setTimeout(() => { resolve(value) }, ms)
    options?.signal?.addEventListener('abort', () => {
      globalThis.clearTimeout(timer)
      reject(options.signal?.reason ?? new Error('The operation was aborted'))
    }, { once: true })
  }),
  setImmediate: (value?: unknown): Promise<unknown> => new Promise(resolve => { globalThis.setTimeout(() => { resolve(value) }, 0) }),
  async *setInterval(ms = 0, value?: unknown, options?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    for (;;) {
      if (options?.signal?.aborted === true) return
      await new Promise(resolve => globalThis.setTimeout(resolve, ms))
      yield value
    }
  },
  scheduler: { wait: (ms: number): Promise<void> => new Promise(resolve => { globalThis.setTimeout(resolve, ms) }) },
  default: undefined as unknown,
}
timersPromisesModule.default = timersPromisesModule

// ---- node:constants --------------------------------------------------------

export const constantsModule = {
  E2BIG: 7, EACCES: 13, EEXIST: 17, EINVAL: 22, EISDIR: 21, ENOENT: 2, ENOTDIR: 20, ENOTEMPTY: 39, EPERM: 1,
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,
  SIGINT: 2, SIGTERM: 15, SIGKILL: 9,
  default: undefined as unknown,
}
constantsModule.default = constantsModule

// ---- node:module -----------------------------------------------------------

/**
 * Version reported to providers through `User-Agent`. It tracks the dsh
 * package set this build was assembled from, which is the identity that
 * matters to a provider looking at the request.
 */
const HARNESS_VERSION = '0.1.0-rc.6'


/**
 * `node:module`. `createRequire` returns a require bound to the host module
 * registry, which is what lets plugins that call
 * `createRequire(import.meta.url)('some-pkg')` keep working.
 */
export const moduleModule = {
  createRequire: (base?: string | URL): ((specifier: string) => unknown) & { resolve: (specifier: string) => string } => {
    const require = (specifier: string): unknown => {
      // `createRequire(import.meta.url)('../package.json')` is how several dsh
      // packages read their own version for attribution headers. After bundling
      // there is no package directory to read, so answer with the build's
      // identity rather than failing a plugin's module body.
      if (specifier.endsWith('package.json')) return { name: '@deepseek-ai/dsh-web-harness', version: HARNESS_VERSION }
      const resolvedModule = hostRequire?.(specifier)
      if (resolvedModule === undefined) {
        throw new Error(`Cannot find module '${specifier}' (browser host: only registered modules are requirable)`)
      }
      return resolvedModule
    }
    require.resolve = (specifier: string): string => {
      throw Object.assign(
        new Error(`Cannot resolve '${specifier}' from ${String(base ?? 'the browser host')}: there is no module directory to resolve against`),
        { code: 'MODULE_NOT_FOUND' },
      )
    }
    return require
  },
  builtinModules: [] as string[],
  isBuiltin: (specifier: string): boolean => specifier.startsWith('node:'),
  register: (): void => {},
  syncBuiltinESMExports: (): void => {},
  findSourceMap: (): undefined => undefined,
  Module: class {},
  /**
   * Node 22.6+ type stripping. The browser host never evaluates TypeScript
   * sources (every module it loads is already built), so the identity
   * transform is the correct answer rather than a throw.
   */
  stripTypeScriptTypes: (source: string): string => source,
  SourceMap: class {},
  constants: { compileCacheStatus: {} },
  enableCompileCache: (): { status: number } => ({ status: 0 }),
  getCompileCacheDir: (): undefined => undefined,
  flushCompileCache: (): void => {},
  runMain: (): void => {},
  wrap: (script: string): string => `(function (exports, require, module, __filename, __dirname) { ${script}\n});`,
  default: undefined as unknown,
}
moduleModule.default = moduleModule

/** Registry hook installed by the host module system. */
let hostRequire: ((specifier: string) => unknown) | undefined

/** Point `createRequire` at the host module registry. */
export function setHostRequire(lookup: (specifier: string) => unknown): void {
  hostRequire = lookup
}

// ---- node:vm ---------------------------------------------------------------

/**
 * `node:vm` over `Function`. There is no isolate boundary in the browser, so
 * `runInNewContext` evaluates against the page realm with the supplied names
 * bound as parameters.
 */
/**
 * Compile code so the context's members are in scope as bare identifiers.
 *
 * A real `vm` context is a fresh global object; the closest a page can get is
 * binding each member as a parameter. The expression form is tried first
 * because `vm` yields the completion value and the callers here evaluate an
 * expression — an IIFE — and read what it returns; a statement body only
 * parses the other way, so a parse failure selects it.
 * @param code - the source to compile.
 * @param names - the context members to bind.
 * @returns the compiled body.
 */
function compileInContext(code: string, names: string[]): (...args: unknown[]) => unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(...names, `"use strict";return (${code})`) as (...args: unknown[]) => unknown
  } catch {
    // eslint-disable-next-line no-new-func
    return new Function(...names, `"use strict";${code}`) as (...args: unknown[]) => unknown
  }
}

export const vmModule = {
  runInNewContext(code: string, sandbox: Record<string, unknown> = {}): unknown {
    // Read the members now, not when the context was created: callers build an
    // empty context and populate it afterwards.
    const names = Object.keys(sandbox)
    return compileInContext(code, names)(...names.map(name => sandbox[name]))
  },
  runInThisContext(code: string): unknown {
    return compileInContext(code, [])()
  },
  runInContext(code: string, sandbox: Record<string, unknown> = {}): unknown {
    return vmModule.runInNewContext(code, sandbox)
  },
  /** The sandbox *is* the context here; `options` only names it for diagnostics. */
  createContext: (sandbox: Record<string, unknown> = {}): Record<string, unknown> => sandbox,
  Script: class {
    constructor(private readonly code: string) {}
    /**
     * Run against a context object.
     *
     * The `timeout` option cannot be honored — a page has no way to interrupt
     * synchronous code — and callers that pass it also enforce their own
     * asynchronous deadline, which does work here.
     */
    runInContext(sandbox: Record<string, unknown> = {}): unknown { return vmModule.runInNewContext(this.code, sandbox) }
    runInNewContext(sandbox: Record<string, unknown> = {}): unknown { return vmModule.runInNewContext(this.code, sandbox) }
    runInThisContext(): unknown { return vmModule.runInThisContext(this.code) }
  },
  /** `vm.isContext`: every object handed back by {@link createContext} qualifies. */
  isContext: (value: unknown): boolean => typeof value === 'object' && value !== null,
  default: undefined as unknown,
}
vmModule.default = vmModule

// ---- node:dns --------------------------------------------------------------

/** DNS is unreachable from a page; every lookup reports `ENOTFOUND`. */
const dnsUnavailable = (hostname: string): never => {
  const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & { code: string }
  error.code = 'ENOTFOUND'
  throw error
}

export const dnsModule = {
  promises: {
    lookup: async (hostname: string): Promise<never> => dnsUnavailable(hostname),
    resolve4: async (hostname: string): Promise<never> => dnsUnavailable(hostname),
    resolve6: async (hostname: string): Promise<never> => dnsUnavailable(hostname),
  },
  lookup: (hostname: string, ...rest: unknown[]): void => {
    const callback = rest[rest.length - 1] as (error: Error) => void
    const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & { code: string }
    error.code = 'ENOTFOUND'
    queueMicrotask(() => { callback(error) })
  },
  default: undefined as unknown,
}
dnsModule.default = dnsModule

// ---- node:zlib -------------------------------------------------------------

/**
 * `zlib.createZstdCompress` and `createZstdDecompress`, as far as a page can
 * honestly go.
 *
 * There is no streaming zstd here: the codec is a wasm build with a one-shot
 * face, and `node:stream`'s `Transform` in this host is a placeholder. What
 * reaches for these is the session log's reader, and it does not actually
 * stream through them — it asks for one, probes it for Node's *private* stream
 * internals (`_handle.writeSync`, `_writeState`, `_defaultFlushFlag`), and,
 * finding none, closes it and decodes each frame through `zstdDecompressSync`,
 * which this file does implement.
 *
 * Throwing here took that probe with it. Every session log is written zstd —
 * it is this deployment's default, the same as `dsh web`'s — so every stored
 * session came back as `Failed to load history: … zstd is unavailable`, from a
 * codec that was sitting right there. The object below fails the probe by
 * construction, which is the answer the reader is written to handle.
 *
 * It refuses to pretend to be a stream. A caller that pipes through one of
 * these gets an error rather than bytes that are quietly the wrong ones.
 * @param kind - which direction the caller asked for, for the refusal message.
 * @returns the probe-failing, closeable stand-in.
 */
function zstdStreamStub(kind: 'compress' | 'decompress'): Record<string, unknown> {
  const refuse = (): never => {
    throw new Error(`zlib: streaming zstd ${kind} is unavailable in the browser host; use the one-shot API`)
  }
  const stub: Record<string, unknown> = {
    close: (): void => {},
    destroy: (): void => {},
    write: refuse,
    end: refuse,
    pipe: refuse,
    // An error listener is what a careful caller attaches first; refusing that
    // would fail the very code being careful.
    on: (): unknown => stub,
    once: (): unknown => stub,
    off: (): unknown => stub,
    removeListener: (): unknown => stub,
  }
  return stub
}

/** `node:zlib`, backed by fflate. Only the sync forms dsh's export path uses. */
export const zlibModule = {
  gzipSync: (data: Uint8Array | string): Buffer => Buffer.from(gzipSync(toBytes(data))),
  gunzipSync: (data: Uint8Array): Buffer => Buffer.from(gunzipSync(toBytes(data))),
  deflateSync: (data: Uint8Array | string): Buffer => Buffer.from(deflateSync(toBytes(data))),
  inflateSync: (data: Uint8Array): Buffer => Buffer.from(inflateSync(toBytes(data))),
  gzip: (data: Uint8Array | string, callback: (error: Error | null, result: Buffer) => void): void => {
    queueMicrotask(() => { callback(null, Buffer.from(gzipSync(toBytes(data)))) })
  },
  gunzip: (data: Uint8Array, callback: (error: Error | null, result: Buffer) => void): void => {
    queueMicrotask(() => { callback(null, Buffer.from(gunzipSync(toBytes(data)))) })
  },
  constants: {
    Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_NO_COMPRESSION: 0,
    ZSTD_c_compressionLevel: 100, ZSTD_CLEVEL_DEFAULT: 3,
  },
  zstdCompressSync,
  zstdDecompressSync,
  zstdCompress,
  zstdDecompress,
  createZstdCompress: () => zstdStreamStub('compress'),
  createZstdDecompress: () => zstdStreamStub('decompress'),
  createGzip: (): never => { throw new Error('zlib: streaming gzip is unavailable in the browser host') },
  createGunzip: (): never => { throw new Error('zlib: streaming gzip is unavailable in the browser host') },
  default: undefined as unknown,
}
zlibModule.default = zlibModule

// ---- node:readline ---------------------------------------------------------

/**
 * `readline.createInterface` over a stream-like input. Plugins that drive a
 * JSONL protocol on stdin get an interface that simply never emits a line,
 * which is the honest browser answer.
 */
export const readlineModule = {
  createInterface(options: { input?: { on?: (event: string, listener: (chunk: unknown) => void) => void } } = {}) {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]): void => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
    let buffer = ''
    options.input?.on?.('data', (chunk: unknown) => {
      buffer += typeof chunk === 'string' ? chunk : toText(toBytes(chunk as Uint8Array))
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        emit('line', buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    })
    const iface = {
      on(event: string, listener: (...args: unknown[]) => void) {
        let set = listeners.get(event)
        if (set === undefined) {
          set = new Set()
          listeners.set(event, set)
        }
        set.add(listener)
        return iface
      },
      once(event: string, listener: (...args: unknown[]) => void) { return iface.on(event, listener) },
      off(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener)
        return iface
      },
      close(): void { emit('close') },
      question(_query: string, callback?: (answer: string) => void): void { callback?.('') },
      write(): void {},
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {},
    }
    return iface
  },
  promises: { createInterface: (options: Record<string, unknown>) => readlineModule.createInterface(options) },
  clearLine: (): boolean => true,
  cursorTo: (): boolean => true,
  moveCursor: (): boolean => true,
  default: undefined as unknown,
}
readlineModule.default = readlineModule
