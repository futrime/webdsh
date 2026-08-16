/**
 * The synchronous filesystem core every `fs` face is built on: `Stats`,
 * `Dirent`, the file-descriptor table, and the operations that translate
 * between Node's argument shapes and {@link Volume}.
 *
 * `fs.ts` (sync + callback) and `fs-promises.ts` are thin adapters over this.
 */

import { volume, type Inode } from '../vfs/volume.ts'
import { fsError } from '../vfs/errors.ts'
import { basename, dirname, resolve } from '../vfs/path.ts'
import { asBuffer, toBytes, toText, type BinaryLike } from './binary.ts'

/** POSIX file-type bits, as Node exposes them through `Stats.mode`. */
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** Node-compatible `fs.Stats`. */
export class Stats {
  readonly dev = 1
  readonly ino: number
  readonly mode: number
  readonly nlink = 1
  readonly uid = 1000
  readonly gid = 1000
  readonly rdev = 0
  readonly size: number
  readonly blksize = 4096
  readonly blocks: number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
  readonly atime: Date
  readonly mtime: Date
  readonly ctime: Date
  readonly birthtime: Date
  private readonly kind: Inode['kind']

  constructor(node: Inode) {
    this.kind = node.kind
    this.ino = node.ino
    const typeBits = node.kind === 'dir' ? S_IFDIR : node.kind === 'link' ? S_IFLNK : S_IFREG
    this.mode = typeBits | (node.mode & 0o7777)
    this.size = node.kind === 'file' ? (node.content?.length ?? 0) : node.kind === 'link' ? (node.target?.length ?? 0) : 4096
    this.blocks = Math.ceil(this.size / 512)
    this.atimeMs = node.atime
    this.mtimeMs = node.mtime
    this.ctimeMs = node.ctime
    this.birthtimeMs = node.birthtime
    this.atime = new Date(node.atime)
    this.mtime = new Date(node.mtime)
    this.ctime = new Date(node.ctime)
    this.birthtime = new Date(node.birthtime)
  }

  isFile(): boolean { return this.kind === 'file' }
  isDirectory(): boolean { return this.kind === 'dir' }
  isSymbolicLink(): boolean { return this.kind === 'link' }
  isBlockDevice(): boolean { return false }
  isCharacterDevice(): boolean { return false }
  isFIFO(): boolean { return false }
  isSocket(): boolean { return false }
}

/**
 * Node's `BigIntStats`, returned for `stat(path, { bigint: true })`.
 *
 * dsh's filesystem provider derives an opaque version token from
 * `dev:ino:size:mtimeNs:ctimeNs` and masks `mode & 511n`, so these fields must
 * genuinely be BigInt — a Number-valued stat makes every read and write fail
 * with "Cannot mix BigInt and other types".
 */
export class BigIntStats {
  readonly dev = 1n
  readonly ino: bigint
  readonly mode: bigint
  readonly nlink = 1n
  readonly uid = 1000n
  readonly gid = 1000n
  readonly rdev = 0n
  readonly size: bigint
  readonly blksize = 4096n
  readonly blocks: bigint
  readonly atimeMs: bigint
  readonly mtimeMs: bigint
  readonly ctimeMs: bigint
  readonly birthtimeMs: bigint
  readonly atimeNs: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly birthtimeNs: bigint
  readonly atime: Date
  readonly mtime: Date
  readonly ctime: Date
  readonly birthtime: Date
  private readonly kind: Inode['kind']

  constructor(node: Inode) {
    const plain = new Stats(node)
    this.kind = node.kind
    this.ino = BigInt(plain.ino)
    this.mode = BigInt(plain.mode)
    this.size = BigInt(plain.size)
    this.blocks = BigInt(plain.blocks)
    this.atimeMs = BigInt(Math.trunc(plain.atimeMs))
    this.mtimeMs = BigInt(Math.trunc(plain.mtimeMs))
    this.ctimeMs = BigInt(Math.trunc(plain.ctimeMs))
    this.birthtimeMs = BigInt(Math.trunc(plain.birthtimeMs))
    this.atimeNs = this.atimeMs * 1000000n
    this.mtimeNs = this.mtimeMs * 1000000n
    this.ctimeNs = this.ctimeMs * 1000000n
    this.birthtimeNs = this.birthtimeMs * 1000000n
    this.atime = plain.atime
    this.mtime = plain.mtime
    this.ctime = plain.ctime
    this.birthtime = plain.birthtime
  }

  isFile(): boolean { return this.kind === 'file' }
  isDirectory(): boolean { return this.kind === 'dir' }
  isSymbolicLink(): boolean { return this.kind === 'link' }
  isBlockDevice(): boolean { return false }
  isCharacterDevice(): boolean { return false }
  isFIFO(): boolean { return false }
  isSocket(): boolean { return false }
}

/** Node-compatible `fs.Dirent`. */
export class Dirent {
  constructor(
    readonly name: string,
    /** Absolute path of the containing directory (Node 20+ exposes this). */
    readonly parentPath: string,
    private readonly kind: Inode['kind'],
  ) {}

  /** Legacy alias Node kept for `parentPath`. */
  get path(): string { return this.parentPath }
  isFile(): boolean { return this.kind === 'file' }
  isDirectory(): boolean { return this.kind === 'dir' }
  isSymbolicLink(): boolean { return this.kind === 'link' }
  isBlockDevice(): boolean { return false }
  isCharacterDevice(): boolean { return false }
  isFIFO(): boolean { return false }
  isSocket(): boolean { return false }
}

/** `fs.constants`, restricted to the members the shims honor. */
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  UV_FS_O_FILEMAP: 0,
} as const

/** One open file description. */
interface Fd {
  path: string
  flags: string
  position: number
  /** Buffered writes for `w`/`a` descriptors, flushed on every write for durability. */
  appending: boolean
}

const fds = new Map<number, Fd>()
let nextFd = 3

/** Normalize a `PathLike` (string, Buffer, or file URL) into a POSIX path string. */
export function toPath(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return decodeURIComponent(value.pathname)
  if (value instanceof Uint8Array) return toText(value)
  if (typeof value === 'object' && value !== null && 'href' in value) {
    return decodeURIComponent(new URL(String((value as { href: string }).href)).pathname)
  }
  throw fsError('EINVAL', 'open', String(value))
}

/** Parse an `open` flags argument into its behavioral bits. */
function parseFlags(flags: string | number): { read: boolean, write: boolean, create: boolean, truncate: boolean, append: boolean, exclusive: boolean } {
  const text = typeof flags === 'number' ? numericFlagsToString(flags) : flags
  return {
    read: text.includes('r') || text.includes('+'),
    write: text.includes('w') || text.includes('a') || text.includes('+'),
    create: !text.startsWith('r'),
    truncate: text.startsWith('w'),
    append: text.startsWith('a'),
    exclusive: text.includes('x'),
  }
}

/** Map numeric `O_*` flags back onto the string form the shim reasons about. */
function numericFlagsToString(flags: number): string {
  const write = (flags & constants.O_WRONLY) !== 0 || (flags & constants.O_RDWR) !== 0
  const append = (flags & constants.O_APPEND) !== 0
  const truncate = (flags & constants.O_TRUNC) !== 0
  const create = (flags & constants.O_CREAT) !== 0
  const exclusive = (flags & constants.O_EXCL) !== 0
  let base = 'r'
  if (append) base = 'a'
  else if (write && (truncate || create)) base = 'w'
  else if (write) base = 'r+'
  return `${base}${exclusive ? 'x' : ''}`
}

/**
 * Optional operation tracing.
 *
 * Filesystem behaviour is where a browser port diverges most subtly from Node,
 * and the divergences show up as "this file was there a moment ago". Setting
 * `localStorage['dsh:trace-fs']` to a substring logs every operation touching a
 * matching path, which is how those get diagnosed without a debugger.
 */
const tracePattern = ((): string | undefined => {
  try {
    return localStorage.getItem('dsh:trace-fs') ?? undefined
  } catch {
    return undefined
  }
})()

/** Log one operation when tracing is on and the path matches. */
function trace(operation: string, path: string, detail?: unknown): void {
  if (tracePattern === undefined || !path.includes(tracePattern)) return
  console.info(`[fs] ${operation} ${path}`, detail ?? '')
}

/** ---- operations --------------------------------------------------------- */

export const core = {
  /** `fs.statSync` / `fs.promises.stat`; `bigint` selects the BigInt shape. */
  stat(path: string, bigint = false): Stats | BigIntStats {
    const node = volume.statNode(path, true)
    return bigint ? new BigIntStats(node) : new Stats(node)
  },

  /** `fs.lstatSync`: does not follow a trailing symlink. */
  lstat(path: string, bigint = false): Stats | BigIntStats {
    const node = volume.statNode(path, false)
    return bigint ? new BigIntStats(node) : new Stats(node)
  },

  /** `fs.existsSync`. */
  exists(path: string): boolean {
    return volume.exists(path)
  },

  /** `fs.accessSync`; the VFS has no ACLs, so only existence is checked. */
  access(path: string, mode: number = constants.F_OK): void {
    const node = volume.lookup(path)
    if (node === undefined) throw fsError('ENOENT', 'access', resolve(path))
    if ((mode & constants.X_OK) !== 0 && node.kind === 'file' && (node.mode & 0o111) === 0) {
      throw fsError('EACCES', 'access', resolve(path))
    }
  },

  /** `fs.readFileSync`; returns a string when an encoding is given. */
  readFile(path: string, encoding?: string): Buffer | string {
    try {
      const bytes = volume.readFile(path)
      trace('read', path, `${String(bytes.length)} bytes`)
      return encoding === undefined || encoding === null ? asBuffer(bytes) : toText(bytes, encoding)
    } catch (error) {
      trace('read-failed', path, (error as { code?: string }).code)
      throw error
    }
  },

  /** `fs.writeFileSync`. */
  writeFile(path: string, data: BinaryLike, options: { encoding?: string, mode?: number, flag?: string } = {}): void {
    trace('write', path)
    const bytes = toBytes(data, options.encoding ?? 'utf8')
    if (options.flag?.startsWith('a') === true) {
      volume.appendFile(path, bytes, options.mode)
      return
    }
    if (options.flag?.includes('x') === true && volume.exists(path)) {
      throw fsError('EEXIST', 'open', resolve(path))
    }
    volume.writeFile(path, bytes, options.mode)
  },

  /** `fs.appendFileSync`. */
  appendFile(path: string, data: BinaryLike, options: { encoding?: string, mode?: number } = {}): void {
    volume.appendFile(path, toBytes(data, options.encoding ?? 'utf8'), options.mode)
  },

  /** `fs.mkdirSync`; returns the first created path when recursive. */
  mkdir(path: string, options: { recursive?: boolean, mode?: number } = {}): string | undefined {
    if (options.recursive === true) return volume.mkdirp(path, options.mode)
    volume.mkdir(path, options.mode)
    return undefined
  },

  /** `fs.readdirSync`, with or without `withFileTypes`. */
  readdir(path: string, options: { withFileTypes?: boolean } = {}): string[] | Dirent[] {
    if (options.withFileTypes !== true) return volume.readdir(path)
    const absolute = resolve(path)
    return volume.readdirNodes(path).map(([name, node]) => new Dirent(name, absolute, node.kind))
  },

  /** `fs.rmSync`. */
  rm(path: string, options: { recursive?: boolean, force?: boolean } = {}): void {
    trace('rm', path, options)
    volume.rm(path, options)
  },

  /** `fs.rmdirSync`; `recursive` is accepted for legacy callers. */
  rmdir(path: string, options: { recursive?: boolean } = {}): void {
    if (options.recursive === true) volume.rm(path, { recursive: true, force: true })
    else volume.rmdir(path)
  },

  /** `fs.unlinkSync`. */
  unlink(path: string): void {
    trace('unlink', path)
    volume.unlink(path)
  },

  /** `fs.renameSync`. */
  rename(from: string, to: string): void {
    trace('rename', `${from} -> ${to}`)
    volume.rename(from, to)
  },

  /** `fs.copyFileSync`. */
  copyFile(from: string, to: string, mode = 0): void {
    if ((mode & constants.COPYFILE_EXCL) !== 0 && volume.exists(to)) {
      throw fsError('EEXIST', 'copyfile', resolve(from), resolve(to))
    }
    const node = volume.statNode(from)
    volume.writeFile(to, volume.readFile(from).slice(), node.mode)
  },

  /** `fs.cpSync` — recursive copy of a file or directory tree. */
  cp(from: string, to: string, options: { recursive?: boolean, force?: boolean } = {}): void {
    const node = volume.statNode(from, false)
    if (node.kind === 'dir') {
      if (options.recursive !== true) throw fsError('EISDIR', 'cp', resolve(from), resolve(to))
      volume.mkdirp(to, node.mode)
      for (const name of volume.readdir(from)) {
        core.cp(`${resolve(from)}/${name}`, `${resolve(to)}/${name}`, options)
      }
      return
    }
    if (node.kind === 'link') {
      const target = volume.readlink(from)
      if (volume.exists(to)) volume.unlink(to)
      volume.symlink(target, to)
      return
    }
    if (options.force === false && volume.exists(to)) return
    volume.mkdirp(dirname(resolve(to)))
    volume.writeFile(to, volume.readFile(from).slice(), node.mode)
  },

  /** `fs.symlinkSync`. */
  symlink(target: string, path: string): void {
    volume.symlink(target, path)
  },

  /**
   * `fs.linkSync`. The VFS has no hard links, so this copies content; the
   * observable difference (shared inode) is not something dsh depends on — it
   * uses `link` only to publish an already-final file under a second name.
   *
   * The refusal to clobber, though, is depended on: that is what makes `link`
   * the publish step of a no-clobber protocol, and two tabs on this origin are
   * two writers over one IndexedDB mirror. So an existing destination fails with
   * `EEXIST`, as a real `link` does.
   */
  link(from: string, to: string): void {
    if (volume.exists(to)) throw fsError('EEXIST', 'link', resolve(from), resolve(to))
    core.copyFile(from, to)
  },

  /** `fs.readlinkSync`. */
  readlink(path: string): string {
    return volume.readlink(path)
  },

  /** `fs.realpathSync`. */
  realpath(path: string): string {
    return volume.realpath(path)
  },

  /** `fs.chmodSync`. */
  chmod(path: string, mode: number): void {
    volume.chmod(path, mode)
  },

  /** `fs.utimesSync`. */
  utimes(path: string, atime: number | Date, mtime: number | Date): void {
    volume.utimes(path, atime, mtime)
  },

  /** `fs.truncateSync`. */
  truncate(path: string, length = 0): void {
    volume.truncate(path, length)
  },

  /** `fs.mkdtempSync`: appends six random characters to `prefix`. */
  mkdtemp(prefix: string): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
    for (let attempt = 0; attempt < 32; attempt++) {
      let suffix = ''
      const random = crypto.getRandomValues(new Uint8Array(6))
      for (const byte of random) suffix += alphabet[byte % alphabet.length]
      const candidate = `${prefix}${suffix}`
      if (volume.exists(candidate)) continue
      volume.mkdirp(candidate)
      return resolve(candidate)
    }
    throw fsError('EEXIST', 'mkdtemp', prefix)
  },

  /** `fs.openSync`. */
  open(path: string, flags: string | number = 'r', mode = 0o666): number {
    const parsed = parseFlags(flags)
    const exists = volume.exists(path)
    if (!exists) {
      if (!parsed.create) throw fsError('ENOENT', 'open', resolve(path))
      volume.writeFile(path, new Uint8Array(0), mode)
    } else if (parsed.exclusive) {
      throw fsError('EEXIST', 'open', resolve(path))
    } else if (parsed.truncate) {
      volume.writeFile(path, new Uint8Array(0), mode)
    }
    const fd = nextFd++
    fds.set(fd, {
      path: resolve(path),
      flags: typeof flags === 'number' ? numericFlagsToString(flags) : flags,
      position: parsed.append ? volume.readFile(path).length : 0,
      appending: parsed.append,
    })
    return fd
  },

  /** `fs.closeSync`. */
  close(fd: number): void {
    if (!fds.delete(fd)) throw fsError('EBADF', 'close')
  },

  /** Look up an open descriptor, throwing `EBADF` when unknown. */
  describe(fd: number): Fd {
    const handle = fds.get(fd)
    if (handle === undefined) throw fsError('EBADF', 'read')
    return handle
  },

  /** `fs.readSync`; advances the descriptor position when `position` is null. */
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const handle = core.describe(fd)
    const content = volume.readFile(handle.path)
    const start = position ?? handle.position
    const slice = content.subarray(start, start + length)
    buffer.set(slice, offset)
    if (position === null) handle.position += slice.length
    return slice.length
  },

  /**
   * `fs.writeSync`; advances the descriptor position when `position` is null.
   *
   * An `O_APPEND` descriptor ignores `position` entirely and writes at the
   * current end of file, as POSIX specifies. That is load-bearing rather than
   * pedantic: the session log opens `'a'` and appends batches through
   * `FileHandle.writeFile`, and a descriptor that honored a stale position would
   * overwrite the log's header line instead of extending the file.
   */
  write(fd: number, data: Uint8Array, position: number | null): number {
    const handle = core.describe(fd)
    const end = (): number => (volume.exists(handle.path) ? volume.readFile(handle.path).length : 0)
    const start = handle.appending ? end() : position ?? handle.position
    volume.writeAt(handle.path, start, data)
    if (handle.appending || position === null) handle.position = start + data.length
    return data.length
  },

  /** `fs.fstatSync`. */
  fstat(fd: number, bigint = false): Stats | BigIntStats {
    return core.stat(core.describe(fd).path, bigint)
  },

  /** `fs.ftruncateSync`. */
  ftruncate(fd: number, length = 0): void {
    volume.truncate(core.describe(fd).path, length)
  },
}
