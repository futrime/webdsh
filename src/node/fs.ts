/**
 * `node:fs` — the sync + callback face over {@link core}.
 *
 * Every operation is genuinely synchronous (the volume lives in memory), so the
 * callback forms simply defer the already-computed result to a microtask, which
 * preserves Node's "callbacks never run in the same tick" contract.
 */

import { BigIntStats, constants, core, Dirent, Stats, toPath } from './fs-core.ts'
import { asBuffer, readOptions, toBytes, toText, type BinaryLike } from './binary.ts'
import { volume } from '../vfs/volume.ts'
import { resolve as resolvePath } from '../vfs/path.ts'
import { fsError } from '../vfs/errors.ts'
import * as promises from './fs-promises.ts'

export { BigIntStats, constants, Dirent, Stats, promises }

/** Node's callback shape: `(err, value?)`. */
type Callback<T = void> = (error: NodeJS.ErrnoException | null, value?: T) => void

/**
 * Split Node's trailing `(options?, callback)` argument pair.
 * @param args - the raw trailing arguments.
 * @returns the options object and the callback (a no-op when absent).
 */
function splitTail(args: unknown[]): { options: ReturnType<typeof readOptions>, callback: Callback<never> } {
  const callback = typeof args[args.length - 1] === 'function' ? args.pop() as Callback<never> : (() => {}) as Callback<never>
  return { options: readOptions(args[0]), callback }
}

/** Run `body` and deliver its outcome to `callback` on a later microtask. */
function defer<T>(body: () => T, callback: Callback<T>): void {
  let value: T
  let error: unknown
  try {
    value = body()
  } catch (thrown) {
    error = thrown
  }
  queueMicrotask(() => {
    if (error !== undefined) callback(error as NodeJS.ErrnoException)
    else callback(null, value)
  })
}

// ---- sync API --------------------------------------------------------------

export const statSync = (path: unknown, options?: { throwIfNoEntry?: boolean, bigint?: boolean }): Stats | BigIntStats | undefined => {
  try {
    return core.stat(toPath(path), options?.bigint === true)
  } catch (error) {
    if (options?.throwIfNoEntry === false) return undefined
    throw error
  }
}
export const lstatSync = (path: unknown, options?: { throwIfNoEntry?: boolean, bigint?: boolean }): Stats | BigIntStats | undefined => {
  try {
    return core.lstat(toPath(path), options?.bigint === true)
  } catch (error) {
    if (options?.throwIfNoEntry === false) return undefined
    throw error
  }
}
export const existsSync = (path: unknown): boolean => {
  try {
    return core.exists(toPath(path))
  } catch {
    return false
  }
}
export const accessSync = (path: unknown, mode?: number): void => { core.access(toPath(path), mode) }
export const readFileSync = (path: unknown, options?: unknown): Buffer | string => {
  const opts = readOptions(options)
  if (typeof path === 'number') return core.readFile(core.describe(path).path, opts.encoding)
  return core.readFile(toPath(path), opts.encoding)
}
export const writeFileSync = (path: unknown, data: BinaryLike, options?: unknown): void => {
  const opts = readOptions(options)
  if (typeof path === 'number') {
    core.write(path, toBytes(data, opts.encoding ?? 'utf8'), null)
    return
  }
  core.writeFile(toPath(path), data, opts)
}
export const appendFileSync = (path: unknown, data: BinaryLike, options?: unknown): void => {
  core.appendFile(toPath(path), data, readOptions(options))
}
export const mkdirSync = (path: unknown, options?: unknown): string | undefined => {
  const opts = typeof options === 'number' ? { mode: options } : readOptions(options)
  return core.mkdir(toPath(path), opts)
}
export const readdirSync = (path: unknown, options?: unknown): string[] | Dirent[] => core.readdir(toPath(path), readOptions(options))
export const rmSync = (path: unknown, options?: unknown): void => { core.rm(toPath(path), readOptions(options)) }
export const rmdirSync = (path: unknown, options?: unknown): void => { core.rmdir(toPath(path), readOptions(options)) }
export const unlinkSync = (path: unknown): void => { core.unlink(toPath(path)) }
export const renameSync = (from: unknown, to: unknown): void => { core.rename(toPath(from), toPath(to)) }
export const copyFileSync = (from: unknown, to: unknown, mode?: number): void => { core.copyFile(toPath(from), toPath(to), mode) }
export const cpSync = (from: unknown, to: unknown, options?: unknown): void => { core.cp(toPath(from), toPath(to), readOptions(options)) }
export const symlinkSync = (target: unknown, path: unknown): void => { core.symlink(toPath(target), toPath(path)) }
export const linkSync = (from: unknown, to: unknown): void => { core.link(toPath(from), toPath(to)) }
export const readlinkSync = (path: unknown): string => core.readlink(toPath(path))
export const chmodSync = (path: unknown, mode: number): void => { core.chmod(toPath(path), mode) }
export const utimesSync = (path: unknown, atime: number | Date, mtime: number | Date): void => { core.utimes(toPath(path), atime, mtime) }
export const truncateSync = (path: unknown, length?: number): void => { core.truncate(toPath(path), length) }
export const mkdtempSync = (prefix: unknown): string => core.mkdtemp(toPath(prefix))
export const openSync = (path: unknown, flags?: string | number, mode?: number): number => core.open(toPath(path), flags, mode)
export const closeSync = (fd: number): void => { core.close(fd) }
export const fstatSync = (fd: number, options?: { bigint?: boolean }): Stats | BigIntStats => core.fstat(fd, options?.bigint === true)
export const ftruncateSync = (fd: number, length?: number): void => { core.ftruncate(fd, length) }
export const fsyncSync = (): void => {}
export const fdatasyncSync = (): void => {}
export const chownSync = (): void => {}
export const lchownSync = (): void => {}
export const fchmodSync = (fd: number, mode: number): void => { core.chmod(core.describe(fd).path, mode) }

/** `fs.realpathSync`, carrying the `.native` alias Node exposes. */
export const realpathSync = Object.assign(
  (path: unknown): string => core.realpath(toPath(path)),
  { native: (path: unknown): string => core.realpath(toPath(path)) },
)

export const readSync = (fd: number, buffer: Uint8Array, offset?: number | { offset?: number, length?: number, position?: number | null }, length?: number, position?: number | null): number => {
  if (typeof offset === 'object' && offset !== null) {
    return core.read(fd, buffer, offset.offset ?? 0, offset.length ?? buffer.length, offset.position ?? null)
  }
  return core.read(fd, buffer, offset ?? 0, length ?? buffer.length, position ?? null)
}

export const writeSync = (fd: number, data: BinaryLike, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null): number => {
  if (typeof data === 'string') {
    const bytes = toBytes(data, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : 'utf8')
    return core.write(fd, bytes, offsetOrPosition ?? null)
  }
  const bytes = toBytes(data)
  const offset = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0
  const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bytes.length - offset
  return core.write(fd, bytes.subarray(offset, offset + length), position ?? null)
}

// ---- callback API ----------------------------------------------------------

export const stat = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => core.stat(toPath(path), (options as { bigint?: boolean }).bigint === true), callback as Callback<Stats | BigIntStats>)
}
export const lstat = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => core.lstat(toPath(path), (options as { bigint?: boolean }).bigint === true), callback as Callback<Stats | BigIntStats>)
}
export const access = (path: unknown, ...rest: unknown[]): void => {
  const mode = typeof rest[0] === 'number' ? rest[0] : undefined
  const callback = rest[rest.length - 1] as Callback
  defer(() => { core.access(toPath(path), mode) }, callback)
}
export const readFile = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => core.readFile(toPath(path), options.encoding), callback as Callback<Buffer | string>)
}
export const writeFile = (path: unknown, data: BinaryLike, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => { core.writeFile(toPath(path), data, options) }, callback as Callback)
}
export const appendFile = (path: unknown, data: BinaryLike, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => { core.appendFile(toPath(path), data, options) }, callback as Callback)
}
export const mkdir = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => core.mkdir(toPath(path), options), callback as Callback<string | undefined>)
}
export const readdir = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => core.readdir(toPath(path), options), callback as Callback<string[] | Dirent[]>)
}
export const rm = (path: unknown, ...rest: unknown[]): void => {
  const { options, callback } = splitTail(rest)
  defer(() => { core.rm(toPath(path), options) }, callback as Callback)
}
export const unlink = (path: unknown, ...rest: unknown[]): void => { const { callback } = splitTail(rest); defer(() => { core.unlink(toPath(path)) }, callback as Callback) }
export const rename = (from: unknown, to: unknown, ...rest: unknown[]): void => { const { callback } = splitTail(rest); defer(() => { core.rename(toPath(from), toPath(to)) }, callback as Callback) }
export const open = (path: unknown, ...rest: unknown[]): void => {
  const flags = typeof rest[0] === 'string' || typeof rest[0] === 'number' ? rest[0] : 'r'
  const callback = rest[rest.length - 1] as Callback<number>
  defer(() => core.open(toPath(path), flags), callback)
}
export const close = (fd: number, callback?: Callback): void => { defer(() => { core.close(fd) }, callback ?? (() => {})) }
export const realpath = Object.assign(
  (path: unknown, ...rest: unknown[]): void => { const { callback } = splitTail(rest); defer(() => core.realpath(toPath(path)), callback as Callback<string>) },
  { native: (path: unknown, ...rest: unknown[]): void => { const { callback } = splitTail(rest); defer(() => core.realpath(toPath(path)), callback as Callback<string>) } },
)

// ---- watching --------------------------------------------------------------

/** Minimal `fs.FSWatcher`: the close handle plus the `change` event surface. */
class FSWatcher {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private dispose: (() => void) | undefined

  constructor(path: string, listener?: (event: string, filename: string) => void) {
    if (listener !== undefined) this.on('change', listener as (...args: unknown[]) => void)
    this.dispose = volume.watch(path, (event, filename) => { this.fire('change', event, filename) })
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  close(): void {
    this.dispose?.()
    this.dispose = undefined
  }

  /** `fs.watch` handles are unref-able in Node; there is nothing to unref here. */
  unref(): this { return this }
  ref(): this { return this }
}

export const watch = (path: unknown, ...rest: unknown[]): FSWatcher => {
  const listener = rest.find(argument => typeof argument === 'function') as ((event: string, filename: string) => void) | undefined
  return new FSWatcher(toPath(path), listener)
}

/** `fs.watchFile` state: one poller per path, shared by all listeners. */
const pollers = new Map<string, { timer: ReturnType<typeof setInterval>, listeners: Set<(current: Stats, previous: Stats) => void>, last: Stats | undefined }>()

export const watchFile = (path: unknown, ...rest: unknown[]): void => {
  const absolute = resolvePath(toPath(path))
  const options = typeof rest[0] === 'object' && rest[0] !== null ? rest[0] as { interval?: number } : {}
  const listener = rest[rest.length - 1] as (current: Stats, previous: Stats) => void
  let poller = pollers.get(absolute)
  if (poller === undefined) {
    const state = { timer: 0 as unknown as ReturnType<typeof setInterval>, listeners: new Set<(current: Stats, previous: Stats) => void>(), last: undefined as Stats | undefined }
    const sample = (): Stats | undefined => statSync(absolute, { throwIfNoEntry: false }) as Stats | undefined
    state.timer = setInterval(() => {
      const current = sample()
      const previous = state.last
      state.last = current
      if (current === undefined || previous === undefined) return
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
      for (const each of state.listeners) each(current, previous)
    }, options.interval ?? 1000)
    state.last = sample()
    poller = state
    pollers.set(absolute, state)
  }
  poller.listeners.add(listener)
}

export const unwatchFile = (path: unknown, listener?: (current: Stats, previous: Stats) => void): void => {
  const absolute = resolvePath(toPath(path))
  const poller = pollers.get(absolute)
  if (poller === undefined) return
  if (listener === undefined) poller.listeners.clear()
  else poller.listeners.delete(listener)
  if (poller.listeners.size === 0) {
    clearInterval(poller.timer)
    pollers.delete(absolute)
  }
}

// ---- streams ---------------------------------------------------------------

/**
 * `fs.createReadStream` over the in-memory volume. Emits `data`/`end`/`error`
 * and is async-iterable, which is what dsh's attachment and export paths use.
 */
class ReadStream {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  readonly path: string
  private destroyed = false

  constructor(path: string, private readonly options: { start?: number, end?: number, encoding?: string } = {}) {
    this.path = path
    queueMicrotask(() => { this.pump() })
  }

  private pump(): void {
    if (this.destroyed) return
    try {
      const bytes = volume.readFile(this.path)
      const start = this.options.start ?? 0
      const end = this.options.end === undefined ? bytes.length : this.options.end + 1
      const slice = bytes.subarray(start, end)
      const chunk = this.options.encoding === undefined ? asBuffer(slice) : toText(slice, this.options.encoding)
      if (slice.length > 0) this.fire('data', chunk)
      this.fire('end')
      this.fire('close')
    } catch (error) {
      this.fire('error', error)
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.listeners.get(event)?.delete(wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  destroy(): void {
    this.destroyed = true
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    const bytes = volume.readFile(this.path)
    const start = this.options.start ?? 0
    const end = this.options.end === undefined ? bytes.length : this.options.end + 1
    const slice = bytes.subarray(start, end)
    if (slice.length > 0) yield this.options.encoding === undefined ? asBuffer(slice) : toText(slice, this.options.encoding)
  }
}

/** `fs.createWriteStream`: buffers in memory and commits on `end()`. */
class WriteStream {
  private readonly chunks: Uint8Array[] = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  readonly path: string

  constructor(path: string, private readonly options: { flags?: string, mode?: number } = {}) {
    this.path = path
    if (options.flags?.startsWith('a') !== true) core.writeFile(path, new Uint8Array(0), { mode: options.mode })
  }

  write(chunk: BinaryLike, encoding?: string | (() => void), callback?: () => void): boolean {
    const bytes = toBytes(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    this.chunks.push(bytes)
    core.appendFile(this.path, bytes, { mode: this.options.mode })
    const done = typeof encoding === 'function' ? encoding : callback
    if (done !== undefined) queueMicrotask(done)
    return true
  }

  end(chunk?: BinaryLike, callback?: () => void): void {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk)
    queueMicrotask(() => {
      this.fire('finish')
      this.fire('close')
      callback?.()
    })
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this { return this.on(event, listener) }
  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  destroy(): void {}
}

export const createReadStream = (path: unknown, options?: unknown): ReadStream => new ReadStream(toPath(path), readOptions(options) as { start?: number })
export const createWriteStream = (path: unknown, options?: unknown): WriteStream => new WriteStream(toPath(path), readOptions(options))
export { ReadStream, WriteStream, FSWatcher }

/** Not implemented: dsh never opens a raw directory handle synchronously. */
export const opendirSync = (path: unknown): never => {
  throw fsError('ENOSYS', 'opendir', toPath(path))
}

export default {
  constants, Dirent, Stats, promises,
  statSync, lstatSync, existsSync, accessSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync, renameSync, copyFileSync, cpSync,
  symlinkSync, linkSync, readlinkSync, realpathSync, chmodSync, utimesSync, truncateSync,
  mkdtempSync, openSync, closeSync, fstatSync, ftruncateSync, fsyncSync, fdatasyncSync,
  chownSync, lchownSync, fchmodSync, readSync, writeSync,
  stat, lstat, access, readFile, writeFile, appendFile, mkdir, readdir, rm, unlink, rename,
  open, close, realpath, watch, watchFile, unwatchFile,
  createReadStream, createWriteStream, ReadStream, WriteStream, FSWatcher, opendirSync,
}
