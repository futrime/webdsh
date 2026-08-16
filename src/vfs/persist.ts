/**
 * Durability for {@link Volume}: an IndexedDB mirror of the inode graph.
 *
 * The volume stays the synchronous authority; this layer replays it at boot and
 * write-behind mirrors every mutation. Writes are coalesced per path in a
 * microtask-scheduled batch, so a session log appending thousands of lines costs
 * one IndexedDB transaction per flush window rather than one per append.
 *
 * localStorage is deliberately not used for file bytes — its ~5 MB string quota
 * cannot hold a workspace. It is still the right store for the tiny boot
 * preferences in `settings.ts`.
 */

import type { VfsChange, Volume } from './volume.ts'

/** Object store holding one record per inode. */
const STORE = 'inodes'
const DB_NAME = 'dsh-web-harness-vfs'
const DB_VERSION = 1

/** Wire shape of one persisted inode. */
interface Record_ {
  path: string
  kind: 'file' | 'dir' | 'link'
  mode: number
  mtime: number
  content?: ArrayBuffer
  target?: string
}

/** Promisify an IDBRequest. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

/**
 * Open (and migrate) the mirror database.
 * @returns the database handle, or undefined when IndexedDB is unavailable
 *          (private-mode Safari, disabled storage) — the app then runs
 *          in-memory only rather than failing to boot.
 */
async function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' })
      }
      open.onsuccess = () => { resolve(open.result) }
      open.onerror = () => { reject(open.error ?? new Error('IndexedDB open failed')) }
      open.onblocked = () => { reject(new Error('IndexedDB open blocked by another tab')) }
    })
  } catch (error) {
    console.warn('[vfs] persistence unavailable, running in memory only:', error)
    return undefined
  }
}

/** Handle returned by {@link attachPersistence}. */
export interface PersistenceHandle {
  /** Whether a durable store is actually backing the volume. */
  readonly durable: boolean
  /** Resolve once every queued write reached IndexedDB. */
  flush(): Promise<void>
  /** Drop every persisted record (the "reset storage" action). */
  clear(): Promise<void>
}

/**
 * Replay persisted state into `volume`, then mirror future mutations.
 * @param volume - the volume to make durable.
 * @returns the persistence handle.
 */
export async function attachPersistence(volume: Volume): Promise<PersistenceHandle> {
  const db = await openDb()
  if (db === undefined) {
    return { durable: false, flush: async () => {}, clear: async () => {} }
  }

  // ---- replay -------------------------------------------------------------
  const records = await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<Record_[]>)
  // Directories first, then shallow-to-deep, so parents always exist before
  // their children and a symlink's directory is present when it lands.
  records.sort((a, b) => {
    const depth = a.path.split('/').length - b.path.split('/').length
    if (depth !== 0) return depth
    if (a.kind === b.kind) return a.path.localeCompare(b.path)
    return a.kind === 'dir' ? -1 : 1
  })
  volume.replay(() => {
    for (const record of records) {
      try {
        volume.put(record.path, {
          kind: record.kind,
          mode: record.mode,
          mtime: record.mtime,
          ...(record.content !== undefined ? { content: new Uint8Array(record.content) } : {}),
          ...(record.target !== undefined ? { target: record.target } : {}),
        })
      } catch (error) {
        console.warn(`[vfs] could not replay ${record.path}:`, error)
      }
    }
  })

  // ---- mirror -------------------------------------------------------------
  /** Path → pending record, or null for a pending delete. Last write per path wins. */
  const pending = new Map<string, Record_ | null>()
  let scheduled = false
  let inFlight: Promise<void> = Promise.resolve()

  const flushNow = async (): Promise<void> => {
    if (pending.size === 0) return
    const batch = [...pending.entries()]
    pending.clear()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const [path, record] of batch) {
        if (record === null) store.delete(path)
        else store.put(record)
      }
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB write failed')) }
      tx.onabort = () => { reject(tx.error ?? new Error('IndexedDB write aborted')) }
    })
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    // A macrotask (not a microtask): appends inside one turn of the agent loop
    // coalesce into a single transaction.
    setTimeout(() => {
      scheduled = false
      inFlight = inFlight.then(flushNow).catch((error: unknown) => {
        console.error('[vfs] persistence write failed:', error)
      })
    }, 0)
  }

  volume.onChange((change: VfsChange) => {
    if (change.op === 'unlink') {
      // Deleting a directory removes its whole subtree from the mirror; the
      // volume emits only the top path for a recursive rm's directory step.
      pending.set(change.path, null)
      const prefix = `${change.path}/`
      for (const key of pending.keys()) {
        if (key.startsWith(prefix)) pending.set(key, null)
      }
      queueSubtreeDelete(db, change.path)
      schedule()
      return
    }
    const record: Record_ = {
      path: change.path,
      kind: change.kind ?? 'file',
      mode: change.mode ?? 0o644,
      mtime: change.mtime ?? Date.now(),
    }
    if (change.content !== undefined) {
      // Copy: the volume hands out its live buffer, and structured clone would
      // otherwise race a later in-place mutation.
      record.content = change.content.slice().buffer
    }
    if (change.target !== undefined) record.target = change.target
    pending.set(change.path, record)
    schedule()
  })

  // Best-effort durability when the tab goes away mid-flush.
  addEventListener('pagehide', () => { void flushNow() })

  return {
    durable: true,
    async flush() {
      await inFlight
      await flushNow()
      await inFlight
    },
    async clear() {
      pending.clear()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => { resolve() }
        tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB clear failed')) }
      })
    },
  }
}

/**
 * Delete every mirrored record under `path`. Runs out of band because the
 * volume already dropped the subtree from memory and cannot enumerate it.
 */
function queueSubtreeDelete(db: IDBDatabase, path: string): void {
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const range = IDBKeyRange.bound(`${path}/`, `${path}/￿`)
  const cursor = store.openCursor(range)
  cursor.onsuccess = () => {
    const handle = cursor.result
    if (handle === null) return
    handle.delete()
    handle.continue()
  }
}
