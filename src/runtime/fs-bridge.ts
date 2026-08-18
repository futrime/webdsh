/**
 * The agent's file operations, pointed at the machine.
 *
 * Running the agent's commands in the container is only half of making it and
 * the terminal one machine. `dsh-fs-local` — which backs the Read, Write, and
 * Edit tools — goes through `node:fs/promises`, so unless those calls land in
 * the container too, the agent would run commands in one filesystem and read
 * files from another.
 *
 * Only paths under the workspace are routed. The harness's own state — the
 * session log, settings, credentials, the deployment's bundles — stays in the
 * page's virtual filesystem: it is read synchronously all over dsh, and it is
 * not the user's data.
 *
 * The operations go to `container/dsh-fsd`, a service on a channel of its own,
 * so a read is a read rather than a process. What comes back is a real `stat`
 * with real times and a real mode, because there is a real filesystem behind it.
 */

import { runtimeAvailable, runtimeFiles, runtimePersistence, WORKSPACE } from './container.ts'
import type { FileStat } from './files.ts'

/** Paths at or below this belong to the machine; everything else to the page. */
const ROUTED_ROOTS = [WORKSPACE]

/**
 * Whether a path belongs to the machine.
 * @param path - an absolute path.
 * @returns true when the machine owns it.
 */
export function routedToRuntime(path: string): boolean {
  if (!runtimeAvailable()) return false
  return ROUTED_ROOTS.some(root => path === root || path.startsWith(`${root}/`))
}

/** What a stat needs to report, in the shape the shim's `Stats` is built from. */
export type RuntimeStat = FileStat

/**
 * Stat a path in the machine.
 * @param path - absolute path.
 * @param follow - whether to resolve a symbolic link, as `stat` does and `lstat` does not.
 * @returns the stat, or undefined when nothing is there.
 */
export async function runtimeStat(path: string, follow = true): Promise<RuntimeStat | undefined> {
  return (await runtimeFiles()).stat(path, follow)
}

/**
 * Read a file from the machine.
 * @param path - absolute path.
 * @returns the bytes.
 */
export async function runtimeReadFile(path: string): Promise<Uint8Array> {
  return (await runtimeFiles()).readFile(path)
}

/**
 * Write a file in the machine, creating its parent directories.
 *
 * dsh usually mkdirs first, but not always, and a write that fails because a
 * directory is missing is a worse answer than one that simply works.
 * @param path - absolute path.
 * @param contents - what to write.
 */
export async function runtimeWriteFile(path: string, contents: Uint8Array | string): Promise<void> {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
  await (await runtimeFiles()).writeFile(path, bytes)
  runtimePersistence()?.touch()
}

/**
 * List a directory with each entry's kind.
 * @param path - absolute path.
 * @returns names paired with what they are.
 */
export async function runtimeReaddirTyped(path: string): Promise<{ name: string, kind: 'file' | 'dir' | 'link' }[]> {
  return (await runtimeFiles()).readdir(path)
}

/**
 * Create a directory in the machine.
 * @param path - absolute path.
 * @param recursive - whether to create parents.
 */
export async function runtimeMkdir(path: string, recursive: boolean): Promise<void> {
  await (await runtimeFiles()).mkdir(path, recursive)
  runtimePersistence()?.touch()
}

/**
 * Remove a path in the machine.
 * @param path - absolute path.
 * @param options - recursive and force, as `fs.rm` takes them.
 */
export async function runtimeRm(path: string, options: { recursive?: boolean, force?: boolean }): Promise<void> {
  await (await runtimeFiles()).rm(path, options)
  runtimePersistence()?.touch()
}

/**
 * Rename a path in the machine.
 * @param from - source path.
 * @param to - destination path.
 */
export async function runtimeRename(from: string, to: string): Promise<void> {
  await (await runtimeFiles()).rename(from, to)
  runtimePersistence()?.touch()
}
