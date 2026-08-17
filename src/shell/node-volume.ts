/**
 * The {@link Volume} surface, over a real filesystem.
 *
 * The shell in `src/shell/` is written against the page's virtual filesystem,
 * which is synchronous. Inside the container there is a real one — also
 * synchronous, through `node:fs`'s `…Sync` family — so the same interpreter,
 * the same coreutils, and the same awk can run against the container's files
 * with nothing but the storage swapped underneath.
 *
 * This module is never imported by name: the container shell's bundler aliases
 * `../vfs/volume.ts` to it, so every `volume.readFile` in the shell resolves
 * here instead. That is why the exported shapes mirror the page volume's rather
 * than being designed fresh.
 *
 * Only what the shell actually calls is implemented. The page volume also
 * carries change notification and durability, which belong to the browser's
 * storage story and mean nothing here.
 */

import * as fs from 'node:fs'

/** Mirrors the page volume's node kinds. */
export type NodeKind = 'file' | 'dir' | 'link'

/** Default permission bits, matching the page volume. */
export const DEFAULT_FILE_MODE = 0o644
export const DEFAULT_DIR_MODE = 0o755

/**
 * The page volume's inode, as much of it as a real `Stats` can answer.
 *
 * `content` and `children` are deliberately absent: they exist in the page
 * volume because it *is* the storage, and a caller reaching for them here would
 * be reading a whole file or directory as a side effect of a stat.
 */
export interface Inode {
  kind: NodeKind
  mode: number
  /** File length. The bytes themselves are on disk, not in this object. */
  size: number
  mtime: number
  ctime: number
  atime: number
  birthtime: number
  ino: number
  target?: string
}

/** Re-raise a Node filesystem error under the page volume's spelling. */
function fail(error: unknown): never {
  throw error
}

/** Build an {@link Inode} from a `Stats`, plus the link target when it is one. */
function inodeOf(path: string, stats: fs.Stats, kind: NodeKind): Inode {
  const inode: Inode = {
    kind,
    // The page volume carries permission bits only; the kind is its own field.
    mode: stats.mode & 0o7777,
    size: stats.size,
    mtime: stats.mtimeMs,
    ctime: stats.ctimeMs,
    atime: stats.atimeMs,
    birthtime: stats.birthtimeMs,
    ino: stats.ino,
  }
  if (kind === 'link') {
    try {
      inode.target = fs.readlinkSync(path)
    } catch {
      // A dangling link still stats; its target simply cannot be read.
    }
  }
  return inode
}

/** Classify a `Stats` the way the page volume does. */
function kindOf(stats: fs.Stats): NodeKind {
  if (stats.isDirectory()) return 'dir'
  if (stats.isSymbolicLink()) return 'link'
  return 'file'
}

/** The page volume's API, backed by `node:fs`. */
export class Volume {
  /** Stat a path, or `undefined` when nothing is there. */
  lookup(path: string, followFinal = true): Inode | undefined {
    try {
      const stats = followFinal ? fs.statSync(path) : fs.lstatSync(path)
      return inodeOf(path, stats, kindOf(stats))
    } catch {
      return undefined
    }
  }

  /** Whether a path resolves to anything. */
  exists(path: string): boolean {
    return fs.existsSync(path)
  }

  /** Stat a path, raising the way the caller expects when it is absent. */
  statNode(path: string, followFinal = true): Inode {
    try {
      const stats = followFinal ? fs.statSync(path) : fs.lstatSync(path)
      return inodeOf(path, stats, kindOf(stats))
    } catch (error) {
      return fail(error)
    }
  }

  /** Read a whole file. */
  readFile(path: string): Uint8Array {
    return new Uint8Array(fs.readFileSync(path))
  }

  /** Replace a file's contents, creating it if needed. */
  writeFile(path: string, data: Uint8Array, mode = DEFAULT_FILE_MODE): void {
    fs.writeFileSync(path, data, { mode })
  }

  /** Append to a file, creating it if needed. */
  appendFile(path: string, data: Uint8Array, mode = DEFAULT_FILE_MODE): void {
    fs.appendFileSync(path, data, { mode })
  }

  /** Overwrite a byte range, extending the file if it ends short. */
  writeAt(path: string, position: number, data: Uint8Array): void {
    const handle = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w+')
    try {
      fs.writeSync(handle, data, 0, data.length, position)
    } finally {
      fs.closeSync(handle)
    }
  }

  /** Cut a file to a length. */
  truncate(path: string, size: number): void {
    fs.truncateSync(path, size)
  }

  /** Remove a file or symlink. */
  unlink(path: string): void {
    fs.unlinkSync(path)
  }

  /** Create one directory. */
  mkdir(path: string, mode = DEFAULT_DIR_MODE): void {
    fs.mkdirSync(path, { mode })
  }

  /**
   * Create a directory and any missing parents.
   * @returns the topmost directory created, or `undefined` if it all existed.
   */
  mkdirp(path: string, mode = DEFAULT_DIR_MODE): string | undefined {
    return fs.mkdirSync(path, { recursive: true, mode })
  }

  /** List a directory's entry names. */
  readdir(path: string): string[] {
    return fs.readdirSync(path)
  }

  /** List a directory's entries with their inodes, without following links. */
  readdirNodes(path: string): [string, Inode][] {
    const entries: [string, Inode][] = []
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const child = path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`
      const stats = fs.lstatSync(child)
      entries.push([entry.name, inodeOf(child, stats, kindOf(stats))])
    }
    return entries
  }

  /** Remove an empty directory. */
  rmdir(path: string): void {
    fs.rmdirSync(path)
  }

  /** Remove a path, optionally a whole tree. */
  rm(path: string, options: { recursive?: boolean, force?: boolean } = {}): void {
    fs.rmSync(path, { recursive: options.recursive ?? false, force: options.force ?? false })
  }

  /** Create a symlink at `path` pointing at `target`. */
  symlink(target: string, path: string): void {
    fs.symlinkSync(target, path)
  }

  /** Read a symlink's target. */
  readlink(path: string): string {
    return fs.readlinkSync(path)
  }

  /** Resolve every symlink in a path. */
  realpath(path: string): string {
    return fs.realpathSync(path)
  }

  /** Move a path. */
  rename(from: string, to: string): void {
    fs.renameSync(from, to)
  }

  /** Change permission bits. */
  chmod(path: string, mode: number): void {
    fs.chmodSync(path, mode)
  }

  /** Set access and modification times. */
  utimes(path: string, atime: number | Date, mtime: number | Date): void {
    const seconds = (value: number | Date): number =>
      value instanceof Date ? value.getTime() / 1000 : value / 1000
    fs.utimesSync(path, seconds(atime), seconds(mtime))
  }

  /**
   * Walk a tree depth-first, yielding every path beneath `root`.
   *
   * Symlinks are reported but not descended into, which is what the page volume
   * does and what keeps a link cycle from hanging the shell.
   */
  * walkTree(root = '/'): Generator<[string, Inode]> {
    // The root is part of the walk, as it is in the page volume: `find .`
    // reports the directory it was given before anything inside it.
    const start = this.lookup(root, false)
    if (start === undefined) return
    yield [root, start]
    const stack: string[] = start.kind === 'dir' ? [root] : []
    while (stack.length > 0) {
      const current = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = current.endsWith('/') ? `${current}${entry.name}` : `${current}/${entry.name}`
        let stats: fs.Stats
        try {
          stats = fs.lstatSync(child)
        } catch {
          continue
        }
        const kind = kindOf(stats)
        yield [child, inodeOf(child, stats, kind)]
        if (kind === 'dir') stack.push(child)
      }
    }
  }
}

/** The single volume the shell reads and writes. */
export const volume = new Volume()
