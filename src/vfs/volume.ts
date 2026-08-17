/**
 * The virtual POSIX volume: an in-memory inode graph with synchronous
 * semantics, so the `node:fs` shim can answer `readFileSync` the way dsh's
 * settings, credentials, agent-preset, and skill loaders expect.
 *
 * Durability is a listener concern — every mutation emits a {@link VfsChange}
 * that `persist.ts` mirrors into IndexedDB. Keeping the authority in memory is
 * what makes the sync API possible at all; IndexedDB has no synchronous read.
 */

import { fsError } from './errors.ts'
import { basename, dirname, isAbsolute, resolve, segments } from './path.ts'

/** Inode kinds the volume stores. */
export type NodeKind = 'file' | 'dir' | 'link'

/** One inode. Directories hold a name→inode map; files hold bytes; links hold a target path. */
export interface Inode {
  kind: NodeKind
  /** POSIX mode bits (permissions only; the kind is carried by {@link Inode.kind}). */
  mode: number
  /** Milliseconds since epoch. */
  mtime: number
  ctime: number
  atime: number
  birthtime: number
  /** Stable identity, used as `Stats.ino` and by the watcher. */
  ino: number
  /**
   * File payload.
   *
   * Present when this volume *is* the storage. A volume backed by a real
   * filesystem reports {@link Inode.size} instead — reading a file's bytes to
   * answer `ls -l` would be absurd.
   */
  content?: Uint8Array
  /** File length, when the payload is not held in memory. */
  size?: number
  /** Directory children. */
  children?: Map<string, Inode>
  /** Symlink target (may be relative). */
  target?: string
}

/** A single durable mutation, emitted after the in-memory volume changed. */
export interface VfsChange {
  /** `write` covers create and content/metadata updates; `unlink` covers files and directories. */
  op: 'write' | 'unlink'
  path: string
  kind?: NodeKind
  mode?: number
  mtime?: number
  content?: Uint8Array
  target?: string
}

/** Watch callback compatible with `fs.watch`'s listener. */
export type WatchListener = (event: 'rename' | 'change', filename: string) => void

const EMPTY = new Uint8Array(0)

/** Default permission bits for new files and directories. */
export const DEFAULT_FILE_MODE = 0o644
export const DEFAULT_DIR_MODE = 0o755

/** Maximum symlink hops before reporting `ELOOP`. */
const MAX_SYMLINK_DEPTH = 40

/**
 * The volume. One instance backs the whole page; `installNodeShims` wires it
 * into `node:fs`, and the shell's coreutils talk to it directly.
 */
export class Volume {
  private nextIno = 1
  private readonly listeners = new Set<(change: VfsChange) => void>()
  private readonly watchers = new Map<string, Set<WatchListener>>()
  /** Suppresses change emission while the persistence layer replays stored state. */
  private replaying = false
  readonly root: Inode

  constructor() {
    this.root = this.makeInode('dir', DEFAULT_DIR_MODE)
    this.root.children = new Map()
  }

  /** Allocate a bare inode with timestamps set to now. */
  private makeInode(kind: NodeKind, mode: number): Inode {
    const now = Date.now()
    return { kind, mode, mtime: now, ctime: now, atime: now, birthtime: now, ino: this.nextIno++ }
  }

  /**
   * Subscribe to durable mutations.
   * @param listener - receives every change once the memory state is updated.
   * @returns the unsubscriber.
   */
  onChange(listener: (change: VfsChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Run `body` without emitting change events (used to replay persisted state). */
  replay<T>(body: () => T): T {
    this.replaying = true
    try {
      return body()
    } finally {
      this.replaying = false
    }
  }

  private emit(change: VfsChange): void {
    if (!this.replaying) {
      for (const listener of this.listeners) listener(change)
    }
    this.notifyWatchers(change.op === 'write' ? 'change' : 'rename', change.path)
  }

  // ---- lookup -------------------------------------------------------------

  /**
   * Walk to an inode.
   * @param path - absolute or cwd-relative path.
   * @param followFinal - resolve a trailing symlink (lstat passes false).
   * @returns the inode, or undefined when any component is missing.
   */
  lookup(path: string, followFinal = true): Inode | undefined {
    // Always normalize, even for an already-absolute path: callers legitimately
    // pass `/dir/.` and `/dir/sub/..` (isomorphic-git's tree walker builds
    // `${dir}/${entry}` with `.` as the root entry), and treating `.` as a
    // directory name would report ENOENT for a path that exists.
    return this.walk(segments(resolve(path)), followFinal, 0)
  }

  private walk(parts: string[], followFinal: boolean, depth: number): Inode | undefined {
    if (depth > MAX_SYMLINK_DEPTH) throw fsError('ELOOP', 'open', `/${parts.join('/')}`)
    let node: Inode = this.root
    for (let i = 0; i < parts.length; i++) {
      if (node.kind === 'link') {
        const resolved = this.resolveLink(node, parts.slice(0, i), depth)
        if (resolved === undefined) return undefined
        node = resolved
      }
      if (node.kind !== 'dir' || node.children === undefined) return undefined
      const next = node.children.get(parts[i])
      if (next === undefined) return undefined
      node = next
    }
    if (node.kind === 'link' && followFinal) return this.resolveLink(node, parts, depth)
    return node
  }

  /** Resolve one symlink hop relative to the directory holding it. */
  private resolveLink(link: Inode, atParts: string[], depth: number): Inode | undefined {
    const target = link.target ?? ''
    const base = isAbsolute(target)
      ? segments(target)
      : segments(resolve(`/${atParts.slice(0, -1).join('/')}`, target))
    return this.walk(base, true, depth + 1)
  }

  /** Resolve the parent directory of `path`, throwing Node-shaped errors. */
  private parentOf(path: string, syscall: string): { parent: Inode, name: string, absolute: string } {
    const absolute = resolve(path)
    const name = basename(absolute)
    if (name.length === 0) throw fsError('EPERM', syscall, absolute)
    const parent = this.lookup(dirname(absolute))
    if (parent === undefined) throw fsError('ENOENT', syscall, absolute)
    if (parent.kind !== 'dir') throw fsError('ENOTDIR', syscall, absolute)
    return { parent, name, absolute }
  }

  /** True when `path` exists (following symlinks). */
  exists(path: string): boolean {
    try {
      return this.lookup(path) !== undefined
    } catch {
      return false
    }
  }

  /** Inode for `path`, throwing `ENOENT` when absent. */
  statNode(path: string, followFinal = true): Inode {
    const node = this.lookup(path, followFinal)
    if (node === undefined) throw fsError('ENOENT', 'stat', resolve(path))
    return node
  }

  // ---- files --------------------------------------------------------------

  /** Read a file's bytes. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path)
    if (node === undefined) throw fsError('ENOENT', 'open', resolve(path))
    if (node.kind === 'dir') throw fsError('EISDIR', 'read', resolve(path))
    node.atime = Date.now()
    return node.content ?? EMPTY
  }

  /**
   * Create or replace a file.
   * @param path - target path; its parent must exist.
   * @param data - file bytes (stored by reference, so callers must not mutate).
   * @param mode - permission bits applied only when the file is created.
   */
  writeFile(path: string, data: Uint8Array, mode = DEFAULT_FILE_MODE): void {
    const { parent, name, absolute } = this.parentOf(path, 'open')
    const existing = parent.children?.get(name)
    if (existing !== undefined && existing.kind === 'dir') throw fsError('EISDIR', 'open', absolute)
    const now = Date.now()
    if (existing !== undefined && existing.kind === 'file') {
      existing.content = data
      existing.mtime = now
      existing.ctime = now
    } else {
      const node = this.makeInode('file', mode)
      node.content = data
      parent.children!.set(name, node)
    }
    parent.mtime = now
    this.emit({ op: 'write', path: absolute, kind: 'file', mode, mtime: now, content: data })
  }

  /** Append bytes to a file, creating it when absent. */
  appendFile(path: string, data: Uint8Array, mode = DEFAULT_FILE_MODE): void {
    let base: Uint8Array = EMPTY
    if (this.exists(path)) base = this.readFile(path)
    const merged = new Uint8Array(base.length + data.length)
    merged.set(base, 0)
    merged.set(data, base.length)
    this.writeFile(path, merged, mode)
  }

  /** Overwrite a byte range, growing the file with NUL padding when needed. */
  writeAt(path: string, position: number, data: Uint8Array): void {
    const base: Uint8Array = this.exists(path) ? this.readFile(path) : EMPTY
    const end = Math.max(base.length, position + data.length)
    const merged = new Uint8Array(end)
    merged.set(base, 0)
    merged.set(data, position)
    this.writeFile(path, merged)
  }

  /** Shrink or grow a file to `size` bytes. */
  truncate(path: string, size: number): void {
    const base: Uint8Array = this.exists(path) ? this.readFile(path) : EMPTY
    const next = new Uint8Array(size)
    next.set(base.subarray(0, Math.min(size, base.length)), 0)
    this.writeFile(path, next)
  }

  /** Remove a file or symlink. */
  unlink(path: string): void {
    const { parent, name, absolute } = this.parentOf(path, 'unlink')
    const node = parent.children?.get(name)
    if (node === undefined) throw fsError('ENOENT', 'unlink', absolute)
    if (node.kind === 'dir') throw fsError('EPERM', 'unlink', absolute)
    parent.children!.delete(name)
    parent.mtime = Date.now()
    this.emit({ op: 'unlink', path: absolute })
  }

  // ---- directories --------------------------------------------------------

  /** Create one directory; `EEXIST` when the name is taken. */
  mkdir(path: string, mode = DEFAULT_DIR_MODE): void {
    const { parent, name, absolute } = this.parentOf(path, 'mkdir')
    if (parent.children!.has(name)) throw fsError('EEXIST', 'mkdir', absolute)
    const node = this.makeInode('dir', mode)
    node.children = new Map()
    parent.children!.set(name, node)
    parent.mtime = Date.now()
    this.emit({ op: 'write', path: absolute, kind: 'dir', mode, mtime: node.mtime })
  }

  /**
   * Create a directory and every missing ancestor.
   * @returns the first directory created, matching Node's `mkdir recursive` return.
   */
  mkdirp(path: string, mode = DEFAULT_DIR_MODE): string | undefined {
    const absolute = resolve(path)
    const parts = segments(absolute)
    let first: string | undefined
    let current = ''
    for (const part of parts) {
      current = `${current}/${part}`
      const node = this.lookup(current)
      if (node === undefined) {
        this.mkdir(current, mode)
        first ??= current
      } else if (node.kind !== 'dir') {
        throw fsError('ENOTDIR', 'mkdir', current)
      }
    }
    return first
  }

  /** List a directory's entry names. */
  readdir(path: string): string[] {
    const node = this.lookup(path)
    if (node === undefined) throw fsError('ENOENT', 'scandir', resolve(path))
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', resolve(path))
    return [...node.children!.keys()]
  }

  /** List a directory's entries with their inodes (avoids a second lookup per name). */
  readdirNodes(path: string): [string, Inode][] {
    const node = this.lookup(path)
    if (node === undefined) throw fsError('ENOENT', 'scandir', resolve(path))
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', resolve(path))
    return [...node.children!.entries()]
  }

  /** Remove an empty directory. */
  rmdir(path: string): void {
    const { parent, name, absolute } = this.parentOf(path, 'rmdir')
    const node = parent.children?.get(name)
    if (node === undefined) throw fsError('ENOENT', 'rmdir', absolute)
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', absolute)
    if (node.children!.size > 0) throw fsError('ENOTEMPTY', 'rmdir', absolute)
    parent.children!.delete(name)
    parent.mtime = Date.now()
    this.emit({ op: 'unlink', path: absolute })
  }

  /** Remove a path and everything under it; missing paths are ignored when `force`. */
  rm(path: string, options: { recursive?: boolean, force?: boolean } = {}): void {
    const absolute = resolve(path)
    const node = this.lookup(absolute, false)
    if (node === undefined) {
      if (options.force === true) return
      throw fsError('ENOENT', 'unlink', absolute)
    }
    if (node.kind === 'dir') {
      if (options.recursive !== true) throw fsError('EISDIR', 'unlink', absolute)
      for (const name of [...node.children!.keys()]) {
        this.rm(`${absolute}/${name}`, { recursive: true, force: true })
      }
      this.rmdir(absolute)
      return
    }
    this.unlink(absolute)
  }

  // ---- links and metadata -------------------------------------------------

  /** Create a symlink at `path` pointing at `target`. */
  symlink(target: string, path: string): void {
    const { parent, name, absolute } = this.parentOf(path, 'symlink')
    if (parent.children!.has(name)) throw fsError('EEXIST', 'symlink', absolute)
    const node = this.makeInode('link', 0o777)
    node.target = target
    parent.children!.set(name, node)
    this.emit({ op: 'write', path: absolute, kind: 'link', mode: 0o777, mtime: node.mtime, target })
  }

  /** Read a symlink's target. */
  readlink(path: string): string {
    const node = this.lookup(path, false)
    if (node === undefined) throw fsError('ENOENT', 'readlink', resolve(path))
    if (node.kind !== 'link') throw fsError('EINVAL', 'readlink', resolve(path))
    return node.target ?? ''
  }

  /** Fully resolve a path, following every symlink. */
  realpath(path: string): string {
    const absolute = resolve(path)
    const parts = segments(absolute)
    let current = ''
    for (let i = 0; i < parts.length; i++) {
      current = `${current}/${parts[i]}`
      const node = this.lookup(current, false)
      if (node === undefined) throw fsError('ENOENT', 'realpath', absolute)
      if (node.kind === 'link') {
        const target = node.target ?? ''
        current = isAbsolute(target) ? target : resolve(dirname(current), target)
      }
    }
    return current.length === 0 ? '/' : current
  }

  /** Move a path, replacing an existing destination file. */
  rename(from: string, to: string): void {
    const fromAbs = resolve(from)
    const toAbs = resolve(to)
    if (fromAbs === toAbs) return
    const source = this.parentOf(fromAbs, 'rename')
    const node = source.parent.children?.get(source.name)
    if (node === undefined) throw fsError('ENOENT', 'rename', fromAbs, toAbs)
    if (toAbs.startsWith(`${fromAbs}/`)) throw fsError('EINVAL', 'rename', fromAbs, toAbs)
    const target = this.parentOf(toAbs, 'rename')
    const existing = target.parent.children?.get(target.name)
    if (existing !== undefined) {
      if (existing.kind === 'dir' && node.kind !== 'dir') throw fsError('EISDIR', 'rename', fromAbs, toAbs)
      if (existing.kind !== 'dir' && node.kind === 'dir') throw fsError('ENOTDIR', 'rename', fromAbs, toAbs)
      if (existing.kind === 'dir' && existing.children!.size > 0) throw fsError('ENOTEMPTY', 'rename', fromAbs, toAbs)
    }
    source.parent.children!.delete(source.name)
    target.parent.children!.set(target.name, node)
    node.ctime = Date.now()
    this.emit({ op: 'unlink', path: fromAbs })
    this.emitSubtree(node, toAbs)
  }

  /** Re-emit an entire subtree as writes (used after a rename moves it). */
  private emitSubtree(node: Inode, path: string): void {
    this.emit({
      op: 'write',
      path,
      kind: node.kind,
      mode: node.mode,
      mtime: node.mtime,
      ...(node.kind === 'file' ? { content: node.content ?? EMPTY } : {}),
      ...(node.kind === 'link' ? { target: node.target ?? '' } : {}),
    })
    if (node.kind !== 'dir') return
    for (const [name, child] of node.children!) this.emitSubtree(child, `${path}/${name}`)
  }

  /** Change permission bits. */
  chmod(path: string, mode: number): void {
    const node = this.statNode(path)
    node.mode = mode & 0o7777
    node.ctime = Date.now()
    this.emit({
      op: 'write',
      path: resolve(path),
      kind: node.kind,
      mode: node.mode,
      mtime: node.mtime,
      ...(node.kind === 'file' ? { content: node.content ?? EMPTY } : {}),
      ...(node.kind === 'link' ? { target: node.target ?? '' } : {}),
    })
  }

  /** Set access and modification times (seconds or Date, like Node). */
  utimes(path: string, atime: number | Date, mtime: number | Date): void {
    const node = this.statNode(path)
    const toMs = (value: number | Date): number => (value instanceof Date ? value.getTime() : value * 1000)
    node.atime = toMs(atime)
    node.mtime = toMs(mtime)
    this.emit({
      op: 'write',
      path: resolve(path),
      kind: node.kind,
      mode: node.mode,
      mtime: node.mtime,
      ...(node.kind === 'file' ? { content: node.content ?? EMPTY } : {}),
      ...(node.kind === 'link' ? { target: node.target ?? '' } : {}),
    })
  }

  // ---- watching -----------------------------------------------------------

  /**
   * Register an `fs.watch`-style listener.
   * @param path - directory or file to observe (non-recursive prefix match).
   * @param listener - receives `(eventType, filename)` with a path relative to `path`.
   * @returns the unsubscriber.
   */
  watch(path: string, listener: WatchListener): () => void {
    const absolute = resolve(path)
    let set = this.watchers.get(absolute)
    if (set === undefined) {
      set = new Set()
      this.watchers.set(absolute, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.watchers.delete(absolute)
    }
  }

  private notifyWatchers(event: 'rename' | 'change', path: string): void {
    if (this.watchers.size === 0) return
    for (const [watched, set] of this.watchers) {
      const isSelf = watched === path
      const isChild = path.startsWith(watched === '/' ? '/' : `${watched}/`)
      if (!isSelf && !isChild) continue
      const relativeName = isSelf ? basename(path) : path.slice(watched === '/' ? 1 : watched.length + 1)
      for (const listener of set) {
        try {
          listener(event, relativeName)
        } catch (error) {
          console.error('[vfs] watch listener threw:', error)
        }
      }
    }
  }

  // ---- bulk helpers -------------------------------------------------------

  /**
   * Insert an inode directly, creating missing ancestors. Used by the
   * persistence replay and the seed loader, both of which know the exact shape.
   */
  put(path: string, spec: { kind: NodeKind, mode?: number, mtime?: number, content?: Uint8Array, target?: string }): void {
    const absolute = resolve(path)
    if (spec.kind === 'dir') {
      this.mkdirp(absolute, spec.mode ?? DEFAULT_DIR_MODE)
    } else {
      this.mkdirp(dirname(absolute))
      if (spec.kind === 'link') {
        const existing = this.lookup(absolute, false)
        if (existing !== undefined) this.unlink(absolute)
        this.symlink(spec.target ?? '', absolute)
      } else {
        this.writeFile(absolute, spec.content ?? EMPTY, spec.mode ?? DEFAULT_FILE_MODE)
      }
    }
    if (spec.mtime !== undefined) {
      const node = this.lookup(absolute, false)
      if (node !== undefined) node.mtime = spec.mtime
    }
  }

  /** Depth-first walk yielding `[absolutePath, inode]` for everything under `path`. */
  *walkTree(path = '/'): Generator<[string, Inode]> {
    const start = this.lookup(path, false)
    if (start === undefined) return
    const stack: [string, Inode][] = [[resolve(path), start]]
    while (stack.length > 0) {
      const [current, node] = stack.pop()!
      yield [current, node]
      if (node.kind !== 'dir') continue
      for (const [name, child] of node.children!) {
        stack.push([current === '/' ? `/${name}` : `${current}/${name}`, child])
      }
    }
  }
}

/** The page-wide volume every shim and tool shares. */
export const volume = new Volume()
