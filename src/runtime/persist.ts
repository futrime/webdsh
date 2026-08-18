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
import { toContainerPath, WORKSPACE } from './webcontainer.ts'

/** The database and record the snapshot lives in. */
const DB_NAME = 'dsh-runtime-workspace'
const STORE = 'snapshots'
const KEY = 'workspace'

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

/** Read the stored snapshot, if there is one. */
async function load(): Promise<Uint8Array | undefined> {
  const db = await open()
  if (db === undefined) return undefined
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
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
  const snapshot = await load()
  if (snapshot === undefined || snapshot.byteLength === 0) return false
  try {
    await runtime.mount(snapshot, { mountPoint: toContainerPath(WORKSPACE) })
    return true
  } catch (error) {
    // A snapshot from an incompatible version is worth discarding rather than
    // failing the boot over; the workspace simply starts empty.
    console.warn('[runtime] the stored workspace could not be restored:', error)
    return false
  }
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
      const bytes = await runtime.export(toContainerPath(WORKSPACE), { format: 'binary', excludes: ['node_modules'] })
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
        transaction.objectStore(STORE).delete(KEY)
        transaction.oncomplete = () => { resolve() }
        transaction.onerror = () => { resolve() }
      })
    },
  }
}
