/**
 * `node:fs/promises` — the promise face over {@link core}, including the
 * `FileHandle` object dsh's atomic-write and spill paths open.
 */

import { BigIntStats, constants, core, Dirent, Stats, toPath } from './fs-core.ts'
import { asBuffer, readOptions, toBytes, toText, type BinaryLike } from './binary.ts'
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

  async write(data: BinaryLike, ...rest: unknown[]): Promise<{ bytesWritten: number, buffer: BinaryLike }> {
    const encoding = rest.find(argument => typeof argument === 'string') as string | undefined
    const position = typeof rest[0] === 'number' ? rest[0] : null
    const bytes = toBytes(data, encoding ?? 'utf8')
    const bytesWritten = core.write(this.fd, bytes, typeof data === 'string' ? position : (rest[2] as number | null ?? null))
    return { bytesWritten, buffer: data }
  }

  async writeFile(data: BinaryLike, options?: unknown): Promise<void> {
    const opts = readOptions(options)
    core.write(this.fd, toBytes(data, opts.encoding ?? 'utf8'), 0)
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

export const stat = async (path: unknown, options?: { bigint?: boolean }): Promise<Stats | BigIntStats> =>
  core.stat(toPath(path), options?.bigint === true)
export const lstat = async (path: unknown, options?: { bigint?: boolean }): Promise<Stats | BigIntStats> =>
  core.lstat(toPath(path), options?.bigint === true)
export const access = async (path: unknown, mode?: number): Promise<void> => { core.access(toPath(path), mode) }
export const readFile = async (path: unknown, options?: unknown): Promise<Buffer | string> => {
  if (path instanceof FileHandle) return path.readFile(options)
  return core.readFile(toPath(path), readOptions(options).encoding)
}
export const writeFile = async (path: unknown, data: BinaryLike, options?: unknown): Promise<void> => {
  if (path instanceof FileHandle) return path.writeFile(data, options)
  core.writeFile(toPath(path), data, readOptions(options))
}
export const appendFile = async (path: unknown, data: BinaryLike, options?: unknown): Promise<void> => {
  core.appendFile(toPath(path), data, readOptions(options))
}
export const mkdir = async (path: unknown, options?: unknown): Promise<string | undefined> => {
  const opts = typeof options === 'number' ? { mode: options } : readOptions(options)
  return core.mkdir(toPath(path), opts)
}
export const readdir = async (path: unknown, options?: unknown): Promise<string[] | Dirent[]> => core.readdir(toPath(path), readOptions(options))
export const rm = async (path: unknown, options?: unknown): Promise<void> => { core.rm(toPath(path), readOptions(options)) }
export const rmdir = async (path: unknown, options?: unknown): Promise<void> => { core.rmdir(toPath(path), readOptions(options)) }
export const unlink = async (path: unknown): Promise<void> => { core.unlink(toPath(path)) }
export const rename = async (from: unknown, to: unknown): Promise<void> => { core.rename(toPath(from), toPath(to)) }
export const copyFile = async (from: unknown, to: unknown, mode?: number): Promise<void> => { core.copyFile(toPath(from), toPath(to), mode) }
export const cp = async (from: unknown, to: unknown, options?: unknown): Promise<void> => { core.cp(toPath(from), toPath(to), readOptions(options)) }
export const symlink = async (target: unknown, path: unknown): Promise<void> => { core.symlink(toPath(target), toPath(path)) }
export const link = async (from: unknown, to: unknown): Promise<void> => { core.link(toPath(from), toPath(to)) }
export const readlink = async (path: unknown): Promise<string> => core.readlink(toPath(path))
export const realpath = async (path: unknown): Promise<string> => core.realpath(toPath(path))
export const chmod = async (path: unknown, mode: number): Promise<void> => { core.chmod(toPath(path), mode) }
export const chown = async (): Promise<void> => {}
export const lchown = async (): Promise<void> => {}
export const utimes = async (path: unknown, atime: number | Date, mtime: number | Date): Promise<void> => { core.utimes(toPath(path), atime, mtime) }
export const truncate = async (path: unknown, length?: number): Promise<void> => { core.truncate(toPath(path), length) }
export const mkdtemp = async (prefix: unknown): Promise<string> => core.mkdtemp(toPath(prefix))
export const open = async (path: unknown, flags?: string | number, mode?: number): Promise<FileHandle> => new FileHandle(core.open(toPath(path), flags, mode))
export const opendir = async (path: unknown): Promise<Dir> => {
  const absolute = toPath(path)
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
        options?.signal?.addEventListener('abort', resolveWake, { once: true })
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
