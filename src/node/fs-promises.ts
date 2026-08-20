/**
 * `node:fs/promises` — the promise face over {@link core}, including the
 * `FileHandle` object dsh's atomic-write and spill paths open.
 */

import { BigIntStats, constants, core, Dirent, Stats, toPath } from './fs-core.ts'
import { asBuffer, readOptions, toBytes, toText, type BinaryLike } from './binary.ts'
import {
  routedToRuntime, runtimeMkdir, runtimeReaddirTyped, runtimeReadFile, runtimeRename, runtimeRm, runtimeStat,
  runtimeWriteFile, type RuntimeStat,
} from '../runtime/fs-bridge.ts'
import { volume } from '../vfs/volume.ts'
import { fsError } from '../vfs/errors.ts'

export { BigIntStats, constants, Dirent, Stats }

/**
 * `fs.promises.FileHandle`. Backed by a descriptor from the sync core, so a
 * handle's reads and writes see exactly what a sibling `readFileSync` sees.
 */
export class FileHandle {
  constructor(readonly fd: number) {}

  async read(
    buffer?: Uint8Array | { buffer?: Uint8Array, offset?: number, length?: number, position?: number | null },
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number, buffer: Uint8Array }> {
    if (buffer !== undefined && !(buffer instanceof Uint8Array)) {
      const target = buffer.buffer ?? new Uint8Array(16384)
      const bytesRead = core.read(this.fd, target, buffer.offset ?? 0, buffer.length ?? target.length, buffer.position ?? null)
      return { bytesRead, buffer: target }
    }
    const target = buffer ?? new Uint8Array(16384)
    const bytesRead = core.read(this.fd, target, offset ?? 0, length ?? target.length, position ?? null)
    return { bytesRead, buffer: target }
  }

  /**
   * `filehandle.write`, in both of Node's shapes: `(buffer, offset, length,
   * position)` and `(string, position, encoding)`. The buffer form's `offset`
   * and `length` select a window into the caller's buffer — Node's own
   * `writeFile` loop passes a moving offset, so ignoring them would rewrite the
   * same prefix on every iteration.
   */
  async write(data: BinaryLike, ...rest: unknown[]): Promise<{ bytesWritten: number, buffer: BinaryLike }> {
    if (typeof data === 'string') {
      const position = typeof rest[0] === 'number' ? rest[0] : null
      const encoding = typeof rest[1] === 'string' ? rest[1] : 'utf8'
      return { bytesWritten: core.write(this.fd, toBytes(data, encoding), position), buffer: data }
    }
    const bytes = toBytes(data, 'utf8')
    const offset = typeof rest[0] === 'number' ? rest[0] : 0
    const length = typeof rest[1] === 'number' ? rest[1] : bytes.length - offset
    const position = typeof rest[2] === 'number' ? rest[2] : null
    const window = bytes.subarray(offset, offset + length)
    return { bytesWritten: core.write(this.fd, window, position), buffer: data }
  }

  /**
   * `fsPromises.writeFile(filehandle, …)`, which — unlike the path-taking
   * overload — neither truncates nor seeks: it writes at the descriptor's
   * current position, and an `'a'` handle therefore appends.
   */
  async writeFile(data: BinaryLike, options?: unknown): Promise<void> {
    const opts = readOptions(options)
    core.write(this.fd, toBytes(data, opts.encoding ?? 'utf8'), null)
  }

  async readFile(options?: unknown): Promise<Buffer | string> {
    const opts = readOptions(options)
    return core.readFile(core.describe(this.fd).path, opts.encoding)
  }

  async stat(options?: { bigint?: boolean }): Promise<Stats | BigIntStats> {
    return core.fstat(this.fd, options?.bigint === true)
  }

  async truncate(length?: number): Promise<void> {
    core.ftruncate(this.fd, length)
  }

  async chmod(mode: number): Promise<void> {
    core.chmod(core.describe(this.fd).path, mode)
  }

  /** No write-behind exists in the VFS; a sync is already durable. */
  async sync(): Promise<void> {}
  async datasync(): Promise<void> {}

  async close(): Promise<void> {
    core.close(this.fd)
  }

  /** `await using` support, matching Node 22's FileHandle. */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      core.close(this.fd)
    } catch {
      // Already closed: disposal must not throw.
    }
  }

  /** Async-iterate the file's lines-agnostic byte content, mirroring `readableWebStream`. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    const bytes = volume.readFile(core.describe(this.fd).path)
    if (bytes.length > 0) yield asBuffer(bytes)
  }

  createReadStream(): never {
    throw fsError('ENOSYS', 'createReadStream', core.describe(this.fd).path)
  }
}

/** An open directory handle, as returned by `fs.promises.opendir`. */
export class Dir {
  private index = 0
  constructor(readonly path: string, private readonly entries: Dirent[]) {}

  async read(): Promise<Dirent | null> {
    return this.index < this.entries.length ? this.entries[this.index++] : null
  }

  async close(): Promise<void> {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Dirent> {
    for (const entry of this.entries) yield entry
  }
}

/**
 * Build a `Stats` from what the machine reported.
 *
 * The shim's `Stats` is constructed from an inode, so the machine's answer is
 * shaped into one rather than a second stat type being introduced.
 */
function statsFromRuntime(entry: RuntimeStat, bigint: boolean): Stats | BigIntStats {
  const node = {
    kind: entry.kind,
    mode: entry.mode,
    mtime: entry.mtimeMs,
    ctime: entry.mtimeMs,
    atime: entry.mtimeMs,
    birthtime: entry.mtimeMs,
    ino: 1,
    content: entry.kind === 'file' ? new Uint8Array(entry.size) : undefined,
  }
  return bigint ? new BigIntStats(node as never) : new Stats(node as never)
}

/** `ENOENT` for a path the machine does not have. */
function missing(path: string, syscall: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT', path })
}

export const stat = async (path: unknown, options?: { bigint?: boolean }): Promise<Stats | BigIntStats> => {
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    const entry = await runtimeStat(target)
    if (entry === undefined) throw missing(target, 'stat')
    return statsFromRuntime(entry, options?.bigint === true)
  }
  return core.stat(target, options?.bigint === true)
}
export const lstat = async (path: unknown, options?: { bigint?: boolean }): Promise<Stats | BigIntStats> => {
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    const entry = await runtimeStat(target)
    if (entry === undefined) throw missing(target, 'lstat')
    return statsFromRuntime(entry, options?.bigint === true)
  }
  return core.lstat(target, options?.bigint === true)
}
export const access = async (path: unknown, mode?: number): Promise<void> => {
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    if (await runtimeStat(target) === undefined) throw missing(target, 'access')
    return
  }
  core.access(target, mode)
}
export const readFile = async (path: unknown, options?: unknown): Promise<Buffer | string> => {
  if (path instanceof FileHandle) return path.readFile(options)
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    const bytes = await runtimeReadFile(target)
    const encoding = readOptions(options).encoding
    return encoding === undefined || encoding === null ? asBuffer(bytes) : toText(bytes, encoding)
  }
  return core.readFile(target, readOptions(options).encoding)
}
export const writeFile = async (path: unknown, data: BinaryLike, options?: unknown): Promise<void> => {
  if (path instanceof FileHandle) return path.writeFile(data, options)
  const target = toPath(path)
  const opts = readOptions(options)
  if (await routedToRuntime(target)) {
    await runtimeWriteFile(target, toBytes(data, opts.encoding ?? 'utf8'))
    return
  }
  core.writeFile(target, data, opts)
}
export const appendFile = async (path: unknown, data: BinaryLike, options?: unknown): Promise<void> => {
  if (path instanceof FileHandle) return path.writeFile(data, options)
  core.appendFile(toPath(path), data, readOptions(options))
}
export const mkdir = async (path: unknown, options?: unknown): Promise<string | undefined> => {
  const opts = typeof options === 'number' ? { mode: options } : readOptions(options)
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    await runtimeMkdir(target, opts.recursive === true)
    return opts.recursive === true ? target : undefined
  }
  return core.mkdir(target, opts)
}
export const readdir = async (path: unknown, options?: unknown): Promise<string[] | Dirent[]> => {
  const target = toPath(path)
  const opts = readOptions(options)
  if (await routedToRuntime(target)) {
    const entries = await runtimeReaddirTyped(target)
    if (opts.withFileTypes !== true) return entries.map(entry => entry.name)
    return entries.map(entry => new Dirent(entry.name, target, entry.kind))
  }
  return core.readdir(target, opts)
}
export const rm = async (path: unknown, options?: unknown): Promise<void> => {
  const target = toPath(path)
  const opts = readOptions(options)
  if (await routedToRuntime(target)) return runtimeRm(target, opts)
  core.rm(target, opts)
}
export const rmdir = async (path: unknown, options?: unknown): Promise<void> => { core.rmdir(toPath(path), readOptions(options)) }
export const unlink = async (path: unknown): Promise<void> => {
  const target = toPath(path)
  if (await routedToRuntime(target)) return runtimeRm(target, { force: false })
  core.unlink(target)
}
export const rename = async (from: unknown, to: unknown): Promise<void> => {
  const source = toPath(from)
  const destination = toPath(to)
  if (await routedToRuntime(source) || await routedToRuntime(destination)) return runtimeRename(source, destination)
  core.rename(source, destination)
}
export const copyFile = async (from: unknown, to: unknown, mode?: number): Promise<void> => { core.copyFile(toPath(from), toPath(to), mode) }
export const cp = async (from: unknown, to: unknown, options?: unknown): Promise<void> => { core.cp(toPath(from), toPath(to), readOptions(options)) }
export const symlink = async (target: unknown, path: unknown): Promise<void> => { core.symlink(toPath(target), toPath(path)) }
export const link = async (from: unknown, to: unknown): Promise<void> => {
  const source = toPath(from)
  const destination = toPath(to)
  // The runtime has no hard links; a copy is the closest honest equivalent, and
  // dsh uses `link` only to publish a finished file under a second name.
  if (await routedToRuntime(source) || await routedToRuntime(destination)) {
    await runtimeWriteFile(destination, await runtimeReadFile(source))
    return
  }
  core.link(source, destination)
}
export const readlink = async (path: unknown): Promise<string> => core.readlink(toPath(path))
export const realpath = async (path: unknown): Promise<string> => {
  const target = toPath(path)
  // Nothing in the runtime's filesystem is a symlink, so a path resolves to
  // itself once it exists.
  if (await routedToRuntime(target)) {
    if (await runtimeStat(target) === undefined) throw missing(target, 'realpath')
    return target
  }
  return core.realpath(target)
}
export const chmod = async (path: unknown, mode: number): Promise<void> => {
  const target = toPath(path)
  // Modes are not modelled by the runtime; accepting the call is what a
  // single-user filesystem would do.
  if (await routedToRuntime(target)) return
  core.chmod(target, mode)
}
export const chown = async (): Promise<void> => {}
export const lchown = async (): Promise<void> => {}
export const utimes = async (path: unknown, atime: number | Date, mtime: number | Date): Promise<void> => { core.utimes(toPath(path), atime, mtime) }
export const truncate = async (path: unknown, length?: number): Promise<void> => { core.truncate(toPath(path), length) }
export const mkdtemp = async (prefix: unknown): Promise<string> => core.mkdtemp(toPath(prefix))
/**
 * A `FileHandle` over a file the runtime owns.
 *
 * `dsh-fs-local` reads through `open(path, 'r')` and writes through
 * `open(temp, 'wx')` followed by `writeFile` and a rename — so a handle that
 * resolved against the page's filesystem would put the agent's edits somewhere
 * the runtime, the terminal, and the next tool call cannot see. The whole file
 * is held in memory for the handle's lifetime, which is what the callers here
 * do anyway.
 */
class RuntimeFileHandle {
  private contents: Uint8Array<ArrayBufferLike>
  private position = 0

  constructor(private readonly path: string, contents: Uint8Array<ArrayBufferLike>, private readonly exclusive: boolean) {
    this.contents = contents
  }

  async read(
    buffer?: Uint8Array | { buffer?: Uint8Array, offset?: number, length?: number, position?: number | null },
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number, buffer: Uint8Array }> {
    const options = buffer instanceof Uint8Array || buffer === undefined
      ? { target: buffer ?? new Uint8Array(16384), offset: offset ?? 0, length, position }
      : {
        target: buffer.buffer ?? new Uint8Array(16384),
        offset: buffer.offset ?? 0,
        length: buffer.length,
        position: buffer.position ?? null,
      }
    const target = options.target
    const from = options.position ?? this.position
    const slice = this.contents.subarray(from, from + (options.length ?? target.length))
    target.set(slice, options.offset)
    if (options.position === null || options.position === undefined) this.position = from + slice.length
    return { bytesRead: slice.length, buffer: target }
  }

  async write(data: BinaryLike): Promise<{ bytesWritten: number, buffer: BinaryLike }> {
    const bytes = toBytes(data, 'utf8')
    const next = new Uint8Array(Math.max(this.contents.length, this.position + bytes.length))
    next.set(this.contents, 0)
    next.set(bytes, this.position)
    this.contents = next
    this.position += bytes.length
    await runtimeWriteFile(this.path, this.contents)
    return { bytesWritten: bytes.length, buffer: data }
  }

  async writeFile(data: BinaryLike, options?: unknown): Promise<void> {
    const bytes = toBytes(data, readOptions(options).encoding ?? 'utf8')
    // An `'a'` handle appends and every other form writes at the position, as
    // Node's handle overload does — it neither truncates nor seeks.
    const next = new Uint8Array(Math.max(this.contents.length, this.position + bytes.length))
    next.set(this.contents, 0)
    next.set(bytes, this.position)
    this.contents = next
    this.position += bytes.length
    await runtimeWriteFile(this.path, this.contents)
  }

  async readFile(options?: unknown): Promise<Buffer | string> {
    const encoding = readOptions(options).encoding
    return encoding === undefined || encoding === null ? asBuffer(this.contents) : toText(this.contents, encoding)
  }

  async stat(): Promise<Stats> {
    const entry = await runtimeStat(this.path)
    return statsFromRuntime(entry ?? { kind: 'file', size: this.contents.length, mode: 0o644, mtimeMs: Date.now() }, false) as Stats
  }

  async truncate(length = 0): Promise<void> {
    this.contents = this.contents.subarray(0, length)
    await runtimeWriteFile(this.path, this.contents)
  }

  async chmod(): Promise<void> {}
  async sync(): Promise<void> {}
  async datasync(): Promise<void> {}
  async close(): Promise<void> {
    if (this.exclusive) await runtimeWriteFile(this.path, this.contents)
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close() }
}

export const open = async (path: unknown, flags?: string | number, mode?: number): Promise<FileHandle> => {
  const target = toPath(path)
  if (await routedToRuntime(target)) {
    const text = typeof flags === 'string' ? flags : 'r'
    const creating = text.startsWith('w') || text.startsWith('a') || text.includes('x')
    let contents: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    if (!text.startsWith('w')) {
      try {
        contents = await runtimeReadFile(target)
        if (text.includes('x')) throw Object.assign(new Error(`EEXIST: file already exists, open '${target}'`), { code: 'EEXIST', path: target })
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') throw error
        if (!creating) throw missing(target, 'open')
      }
    }
    if (creating) await runtimeWriteFile(target, contents)
    return new RuntimeFileHandle(target, contents, creating) as unknown as FileHandle
  }
  return new FileHandle(core.open(target, flags, mode))
}
export const opendir = async (path: unknown): Promise<Dir> => {
  const absolute = toPath(path)
  if (await routedToRuntime(absolute)) {
    const entries = await runtimeReaddirTyped(absolute)
    return new Dir(absolute, entries.map(entry => new Dirent(entry.name, absolute, entry.kind)))
  }
  return new Dir(absolute, core.readdir(absolute, { withFileTypes: true }) as Dirent[])
}

/** `fs.promises.watch` — an async iterator over volume change events. */
export async function* watch(path: unknown, options?: { signal?: AbortSignal }): AsyncGenerator<{ eventType: string, filename: string }> {
  const absolute = toPath(path)
  const queue: { eventType: string, filename: string }[] = []
  let wake: (() => void) | undefined
  const stop = volume.watch(absolute, (eventType, filename) => {
    queue.push({ eventType, filename })
    wake?.()
  })
  try {
    for (;;) {
      if (options?.signal?.aborted === true) return
      while (queue.length > 0) yield queue.shift()!
      await new Promise<void>((resolveWake) => {
        wake = resolveWake
        options?.signal?.addEventListener('abort', () => { resolveWake() }, { once: true })
      })
    }
  } finally {
    stop()
  }
}

/** `fs.promises.glob` is not implemented; dsh's search tool uses its own walker. */
export const glob = (): never => {
  throw fsError('ENOSYS', 'glob')
}

export const toText_ = toText

export default {
  constants, Dirent, Stats, FileHandle, Dir,
  stat, lstat, access, readFile, writeFile, appendFile, mkdir, readdir, rm, rmdir, unlink,
  rename, copyFile, cp, symlink, link, readlink, realpath, chmod, chown, lchown, utimes,
  truncate, mkdtemp, open, opendir, watch, glob,
}
