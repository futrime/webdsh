/**
 * The `node:*` module registry and global installation.
 *
 * Vite rewrites every `node:x` / bare `x` builtin import to this package's
 * shims through `resolve.alias`, so this file is what `process.getBuiltinModule`
 * and `createRequire()` answer from, and what `installNodeGlobals` seeds the
 * page realm with.
 */

import * as fsShim from './fs.ts'
import * as fsPromisesShim from './fs-promises.ts'
import * as pathShim from './path.ts'
import * as osShim from './os.ts'
import * as cryptoShim from './crypto.ts'
import * as childProcessShim from './child_process.ts'
import * as httpShim from './http.ts'
import { Buffer } from './binary.ts'
import { process as processShim, setBuiltinLookup } from './process.ts'
import { streamModule } from './streams.ts'
import { workerThreadsModule } from './worker_threads.ts'
import {
  asyncHooksModule, assertModule, constantsModule, dnsModule, moduleModule,
  perfHooksModule, querystringModule, readlineModule, stringDecoderModule,
  timersModule, timersPromisesModule, ttyModule, urlModule, utilModule, vmModule,
  zlibModule,
} from './misc.ts'
import { sqliteModule } from './sqlite.ts'
import { netModule } from './net.ts'
import { eventsModule } from './events-impl.ts'
import { Blob as BlobRef, File as FileRef } from './blob-refs.ts'
import { installTimerHandles } from './timer-handles.ts'
import { initZstd } from './zstd.ts'

/** `node:buffer` module face. */
const bufferModule = {
  Buffer,
  Blob: BlobRef,
  File: FileRef,
  atob: globalThis.atob.bind(globalThis),
  btoa: globalThis.btoa.bind(globalThis),
  constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 },
  isUtf8: (): boolean => true,
  isAscii: (): boolean => true,
  default: undefined as unknown,
}
bufferModule.default = bufferModule

/** `node:https` reuses the http implementation (there is no TLS to configure). */
const httpsModule = { ...httpShim, default: httpShim.default }

/** Specifier → module namespace. Keys are bare names; `node:` is stripped first. */
export const builtins: Record<string, unknown> = {
  fs: fsShim,
  'fs/promises': fsPromisesShim,
  path: pathShim,
  'path/posix': pathShim,
  'path/win32': pathShim,
  os: osShim,
  crypto: cryptoShim,
  child_process: childProcessShim,
  worker_threads: workerThreadsModule,
  http: httpShim,
  https: httpsModule,
  net: netModule,
  tls: netModule,
  stream: streamModule,
  'stream/promises': streamModule.promises,
  'stream/web': { ReadableStream, WritableStream, TransformStream },
  'stream/consumers': {
    text: async (stream: AsyncIterable<unknown>): Promise<string> => {
      let out = ''
      for await (const chunk of stream) out += String(chunk)
      return out
    },
  },
  events: eventsModule,
  buffer: bufferModule,
  url: urlModule,
  util: utilModule,
  'util/types': utilModule.types,
  assert: assertModule,
  'assert/strict': assertModule,
  querystring: querystringModule,
  string_decoder: stringDecoderModule,
  perf_hooks: perfHooksModule,
  async_hooks: asyncHooksModule,
  timers: timersModule,
  'timers/promises': timersPromisesModule,
  constants: constantsModule,
  module: moduleModule,
  vm: vmModule,
  dns: dnsModule,
  'dns/promises': dnsModule.promises,
  zlib: zlibModule,
  readline: readlineModule,
  'readline/promises': readlineModule.promises,
  tty: ttyModule,
  sqlite: sqliteModule,
  process: processShim,
  punycode: { toASCII: (value: string) => value, toUnicode: (value: string) => value },
  worker: workerThreadsModule,
  v8: { serialize: structuredClone, deserialize: structuredClone, getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0 }) },
  inspector: { open: () => {}, close: () => {}, url: () => undefined },
  cluster: { isPrimary: true, isWorker: false, fork: () => { throw new Error('cluster is unavailable in the browser host') } },
  diagnostics_channel: { channel: () => ({ hasSubscribers: false, publish: () => {}, subscribe: () => {}, unsubscribe: () => {} }) },
}

/**
 * Look a builtin up by specifier.
 * @param specifier - `node:fs`, `fs`, `node:fs/promises`, …
 * @returns the module namespace, or undefined when it is not a builtin.
 */
export function resolveBuiltin(specifier: string): unknown {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  return builtins[bare]
}

/**
 * Seed the page realm with the globals Node code assumes: `process`, `Buffer`,
 * `global`, and `setImmediate`. Called once, before any dsh module evaluates.
 */
export function installNodeGlobals(): void {
  // The zstd codec is a wasm module with an asynchronous load, and the session
  // log's synchronous decompress cannot wait for it — so it starts here, long
  // before a session exists.
  void initZstd()
  // Before anything schedules a timer: dsh calls `.unref()` on what
  // `setTimeout` returns, which is an object in Node and a number here.
  installTimerHandles()
  const realm = globalThis as Record<string, unknown>

  realm.process ??= processShim
  realm.Buffer ??= Buffer
  realm.global ??= globalThis
  realm.setImmediate ??= timersModule.setImmediate
  realm.clearImmediate ??= timersModule.clearImmediate
  setBuiltinLookup(resolveBuiltin)
  moduleModule.builtinModules = Object.keys(builtins)
}
