/**
 * Keeping the workspace across reloads.
 *
 * The runtime's filesystem lives in memory: close the tab and the work is
 * gone. That is fine for a playground and not fine for a harness, where the
 * whole point is that the agent and the user are building something together.
 *
 * The container can hand over a snapshot of a directory and take one back, so
 * persistence is those two calls plus somewhere to put the bytes. IndexedDB is
 * that somewhere, for the same reason the rest of this app uses it: it is the
 * only browser store that holds megabytes without asking.
 *
 * Snapshots are taken on a debounce and on `pagehide`, because a snapshot per
 * write would copy the whole workspace on every keystroke of an agent's edit,
 * and because `pagehide` is the last moment a page reliably gets.
 */

import type { WebContainer } from '@webcontainer/api'
import { HARNESS_DIR, toContainerPath, WORKSPACE } from './webcontainer.ts'

/** The database and record the snapshot lives in. */
const DB_NAME = 'dsh-runtime-workspace'
const STORE = 'snapshots'

/**
 * The record holding everything the user has: the whole working directory.
 *
 * A workspace is whichever directory the user picked, and the picker opens on
 * Home — so snapshotting only `workspace` meant a workspace made anywhere else
 * was never stored, and came back empty after a reload.
 */
const KEY = 'home'

/**
 * The record written while only `workspace` was kept.
 *
 * Still read, once: a returning visitor's work is in it, and mounting it where
 * it came from is the only way to give it back. The next snapshot is written
 * in the current shape, so this runs at most once per browser.
 */
const LEGACY_KEY = 'workspace'

/**
 * What never belongs in a snapshot.
 *
 * `node_modules` because it is reinstallable and enormous; the harness's own
 * directory because in the container it holds staged command scripts and the
 * shell program, which the boot writes fresh and which are not the user's work.
 *
 * Read through a function because this module and `webcontainer.ts` import each
 * other: at module-init time the constant over there has not been assigned yet,
 * and reading it eagerly throws before the page has drawn anything.
 * @returns the exclusion list for `export`.
 */
function excludes(): string[] {
  return ['node_modules', HARNESS_DIR]
}

/** How long to wait after a change before snapshotting. */
const DEBOUNCE_MS = 4_000

/** Open the snapshot database. */
async function open(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => { resolve(request.result) }
    // A blocked or unavailable store costs persistence and nothing else, so the
    // caller carries on with an in-memory workspace rather than failing to boot.
    request.onerror = () => { resolve(undefined) }
  })
}

/**
 * Read a stored snapshot, if there is one.
 * @param key - which record to read.
 * @returns the bytes, or nothing when the record or the store is absent.
 */
async function load(key: string): Promise<Uint8Array | undefined> {
  const db = await open()
  if (db === undefined) return undefined
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => {
      const value: unknown = request.result
      resolve(value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined)
    }
    request.onerror = () => { resolve(undefined) }
  })
}

/** Write the snapshot. */
async function save(bytes: Uint8Array): Promise<void> {
  const db = await open()
  if (db === undefined) return
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(bytes, KEY)
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { resolve() }
  })
}

/** Control over the workspace's durability. */
export interface RuntimePersistence {
  /** Snapshot now and wait for it to be stored. */
  flush(): Promise<void>
  /** Note that something changed, scheduling a snapshot. */
  touch(): void
  /** Forget the stored workspace. */
  clear(): Promise<void>
}

/**
 * Restore a previously stored workspace into a freshly booted container.
 * @param runtime - the booted container.
 * @returns whether anything was restored.
 */
export async function restoreWorkspace(runtime: WebContainer): Promise<boolean> {
  // Current shape first: the whole working directory, mounted where it was
  // taken from. The older record held only `workspace`, and mounting that at
  // the root would move a returning visitor's files, so each shape is mounted
  // at its own point.
  const current = await load(KEY)
  const candidates: { bytes: Uint8Array | undefined, mountPoint: string }[] = [
    { bytes: current, mountPoint: '.' },
    ...(current === undefined ? [{ bytes: await load(LEGACY_KEY), mountPoint: toContainerPath(WORKSPACE) }] : []),
  ]
  for (const { bytes, mountPoint } of candidates) {
    if (bytes === undefined || bytes.byteLength === 0) continue
    try {
      await runtime.mount(bytes, { mountPoint })
      return true
    } catch (error) {
      // A snapshot from an incompatible version is worth discarding rather than
      // failing the boot over; the workspace simply starts empty.
      console.warn('[runtime] the stored workspace could not be restored:', error)
    }
  }
  return false
}

/**
 * Start snapshotting the workspace.
 * @param runtime - the booted container.
 * @returns the durability handle.
 */
export function persistWorkspace(runtime: WebContainer): RuntimePersistence {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined

  const snapshot = async (): Promise<void> => {
    try {
      const bytes = await runtime.export('.', { format: 'binary', excludes: excludes() })
      await save(bytes as Uint8Array)
    } catch (error) {
      console.warn('[runtime] the workspace could not be snapshotted:', error)
    }
  }

  const flush = async (): Promise<void> => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    inFlight = (inFlight ?? Promise.resolve()).then(snapshot)
    await inFlight
  }

  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, DEBOUNCE_MS)
  }

  // `pagehide` is the last event a page is reliably given; `visibilitychange`
  // covers the tab being backgrounded, which on mobile often precedes eviction.
  globalThis.addEventListener('pagehide', () => { void flush() })
  globalThis.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })

  return {
    flush,
    touch,
    async clear() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      const db = await open()
      if (db === undefined) return
      await new Promise<void>((resolve) => {
        const transaction = db.transaction(STORE, 'readwrite')
        // Both records: a reset that left the older one behind would restore it
        // on the next boot, which is the opposite of what was asked for.
        for (const key of [KEY, LEGACY_KEY]) transaction.objectStore(STORE).delete(key)
        transaction.oncomplete = () => { resolve() }
        transaction.onerror = () => { resolve() }
      })
    },
  }
}
