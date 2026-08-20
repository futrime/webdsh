/**
 * The agent's file operations, pointed at the runtime.
 *
 * Running the agent's shell in the container is only half of making it and the
 * terminal one machine. `dsh-fs-local` — which backs the Read, Write, and Edit
 * tools — goes through `node:fs/promises`, so unless those calls land in the
 * container too, the agent would run commands in one filesystem and read files
 * from another.
 *
 * Only paths under the workspace are routed. The harness's own state — the
 * session log, settings, credentials, the deployment's bundles — stays in the
 * page's virtual filesystem: it is read synchronously all over dsh, and it is
 * not the user's data.
 *
 * Unlike a shell-command bridge, this is a real filesystem API, so a read is a
 * read rather than a process.
 */

import { HARNESS_DIR, runtimeFs, runtimePersistence, runtimeReady, toContainerPath, WORKDIR } from './webcontainer.ts'

/**
 * Paths at or below this belong to the runtime; everything else to the host.
 *
 * The runtime's working directory, not the workspace inside it, because the
 * workspace is whichever directory the user picked and the picker opens on the
 * whole of Home. Routing only one fixed directory made every other choice a
 * silently split machine: the agent's commands ran in the container while its
 * Read and Write went to the page's filesystem, so `glob` found nothing the
 * shell had just written, and a workspace the container had never heard of
 * failed every command with `no such file or directory`.
 */
const ROUTED_ROOT = WORKDIR

/**
 * The one subtree under it that stays with the page.
 *
 * `$DSH_HOME` — settings, credentials, session logs, presets — is read
 * synchronously all over dsh and is not the user's data. The container keeps
 * its own directory of the same name for staged command scripts, and the two
 * are meant to be different things in different filesystems.
 */
const HOST_ONLY = `${WORKDIR}/${HARNESS_DIR}`

/**
 * Whether a path is at or below a directory.
 * @param path - an absolute path.
 * @param root - the directory to test against.
 * @returns true when `path` is `root` or inside it.
 */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/**
 * Whether a path belongs to the runtime.
 * @param path - an absolute path.
 *
 * A capability check is not an availability result. WebContainers can pass the
 * SharedArrayBuffer/cross-origin-isolation checks and still fail (or time out)
 * during boot. Waiting here makes the first filesystem call use the same
 * backend as every later one: a failed boot falls back during this call instead
 * of failing once and only making the *next* call use the page volume.
 * @returns true when the successfully booted runtime owns it.
 */
export async function routedToRuntime(path: string): Promise<boolean> {
  if (!within(path, ROUTED_ROOT) || within(path, HOST_ONLY)) return false
  return runtimeReady()
}

/** What a stat needs to report, in the shape the shim's `Stats` is built from. */
export interface RuntimeStat {
  kind: 'file' | 'dir' | 'link'
  size: number
  mode: number
  mtimeMs: number
}

/** Give an error the shape Node's fs errors have, so callers branch on `code`. */
function fsError(code: string, syscall: string, path: string): Error {
  const message = code === 'ENOENT'
    ? `ENOENT: no such file or directory, ${syscall} '${path}'`
    : `${code}: ${syscall} '${path}'`
  return Object.assign(new Error(message), { code, syscall, path })
}

/**
 * Stat a path in the runtime.
 *
 * WebContainers exposes no `stat`, so this is assembled from what it does
 * expose: a directory is what `readdir` accepts, and a file is what `readFile`
 * returns. That is enough for the fields dsh reads — kind and size — and the
 * times are the one thing it cannot know, so they are reported as now rather
 * than as a fabricated past.
 * @param path - absolute path.
 * @returns the stat, or undefined when nothing is there.
 */
export async function runtimeStat(path: string): Promise<RuntimeStat | undefined> {
  const fs = await runtimeFs()
  try {
    await fs.readdir(toContainerPath(path))
    return { kind: 'dir', size: 0, mode: 0o755, mtimeMs: Date.now() }
  } catch {
    // Not a directory, or not there at all; the read below tells them apart.
  }
  try {
    const contents = await fs.readFile(toContainerPath(path))
    return { kind: 'file', size: contents.byteLength, mode: 0o644, mtimeMs: Date.now() }
  } catch {
    return undefined
  }
}

/**
 * Read a file from the runtime.
 * @param path - absolute path.
 * @returns the bytes.
 */
export async function runtimeReadFile(path: string): Promise<Uint8Array> {
  const fs = await runtimeFs()
  try {
    return await fs.readFile(toContainerPath(path))
  } catch {
    throw fsError('ENOENT', 'open', path)
  }
}

/**
 * Write a file in the runtime, creating its parent directories.
 *
 * dsh usually mkdirs first, but not always, and a write that fails because a
 * directory is missing is a worse answer than one that simply works.
 * @param path - absolute path.
 * @param contents - what to write.
 */
export async function runtimeWriteFile(path: string, contents: Uint8Array | string): Promise<void> {
  const fs = await runtimeFs()
  const target = toContainerPath(path)
  const parent = target.slice(0, target.lastIndexOf('/'))
  if (parent !== '') await fs.mkdir(parent, { recursive: true }).catch(() => undefined)
  await fs.writeFile(target, contents as never)
  runtimePersistence()?.touch()
}

/**
 * List a directory in the runtime.
 * @param path - absolute path.
 * @returns the entry names.
 */
export async function runtimeReaddir(path: string): Promise<string[]> {
  const fs = await runtimeFs()
  try {
    return await fs.readdir(toContainerPath(path))
  } catch {
    throw fsError('ENOENT', 'scandir', path)
  }
}

/**
 * List a directory with each entry's kind.
 * @param path - absolute path.
 * @returns names paired with what they are.
 */
export async function runtimeReaddirTyped(path: string): Promise<{ name: string, kind: 'file' | 'dir' | 'link' }[]> {
  const fs = await runtimeFs()
  try {
    const entries = await fs.readdir(toContainerPath(path), { withFileTypes: true })
    return entries.map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }))
  } catch {
    throw fsError('ENOENT', 'scandir', path)
  }
}

/**
 * Create a directory in the runtime.
 * @param path - absolute path.
 * @param recursive - whether to create parents.
 */
export async function runtimeMkdir(path: string, recursive: boolean): Promise<void> {
  const fs = await runtimeFs()
  // The two forms are separate overloads — `recursive` is typed as the literal
  // `true` or `false`, not as a boolean — so the branch is the call site's.
  if (recursive) await fs.mkdir(toContainerPath(path), { recursive: true })
  else await fs.mkdir(toContainerPath(path))
  runtimePersistence()?.touch()
}

/**
 * Remove a path in the runtime.
 * @param path - absolute path.
 * @param options - recursive and force, as `fs.rm` takes them.
 */
export async function runtimeRm(path: string, options: { recursive?: boolean, force?: boolean }): Promise<void> {
  const fs = await runtimeFs()
  try {
    await fs.rm(toContainerPath(path), { recursive: options.recursive === true, force: options.force === true })
    runtimePersistence()?.touch()
  } catch (error) {
    if (options.force === true) return
    throw error
  }
}

/**
 * Rename a path in the runtime.
 * @param from - source path.
 * @param to - destination path.
 */
export async function runtimeRename(from: string, to: string): Promise<void> {
  const fs = await runtimeFs()
  await fs.rename(toContainerPath(from), toContainerPath(to))
  runtimePersistence()?.touch()
}
