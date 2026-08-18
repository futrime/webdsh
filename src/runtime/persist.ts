/**
 * Keeping the workspace across reloads.
 *
 * The machine's filesystem is a disk image in WASM memory: close the tab and
 * the work is gone. That is fine for a playground and not fine for a harness,
 * where the point is that the agent and the user are building something
 * together.
 *
 * A container knows how to hand over a directory — `tar` — so persistence is
 * that, a channel to carry the bytes, and somewhere to put them. IndexedDB is
 * that somewhere, for the same reason the rest of this app uses it: it is the
 * only browser store that holds megabytes without asking. The archive is
 * compressed by the page rather than by the guest, because `CompressionStream`
 * is native code and `gzip` in there is an emulated CPU.
 *
 * Snapshots are taken on a debounce and on `pagehide`, because a snapshot per
 * write would archive the whole workspace on every keystroke of an agent's
 * edit, and because `pagehide` is the last moment a page reliably gets.
 */

import type { Mux } from './mux.ts'
import type { Machine } from './container.ts'

/** The database and record the snapshot lives in. */
const DB_NAME = 'dsh-runtime-workspace'
const STORE = 'snapshots'
const KEY = 'workspace'

/**
 * How long to wait after a change before snapshotting.
 *
 * Longer than it would be over a native filesystem: archiving the workspace
 * costs emulated CPU that the user's next command wants, so the debounce is
 * set to outlast a burst of edits rather than to follow each one.
 */
const DEBOUNCE_MS = 10_000

/** Where the workspace lives inside the machine, split for `tar`'s two arguments. */
const PARENT = '/home/dsh'
const NAME = 'workspace'

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

/** Run a stream through a transform the browser implements natively. */
async function through(bytes: Uint8Array, transform: 'gzip' | 'gunzip'): Promise<Uint8Array> {
  const stream = transform === 'gzip'
    ? new CompressionStream('gzip')
    : new DecompressionStream('gzip')
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair)
  return new Uint8Array(await new Response(source).arrayBuffer())
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
 * Run one command and collect its bytes, rather than its text.
 *
 * `execute` decodes as it goes, which is right for a command whose output a
 * model reads and wrong for an archive.
 * @param mux - the machine's channels.
 * @param script - what to run.
 * @param stdin - bytes to feed it.
 * @returns the exit status and the raw output.
 */
async function collect(mux: Mux, script: string, stdin?: Uint8Array): Promise<{ status: number, bytes: Uint8Array }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    let size = 0
    const channel = mux.open({ kind: 'exec', script, cwd: PARENT }, {
      onData: (bytes) => { chunks.push(bytes); size += bytes.byteLength },
      onExit: (status) => {
        const bytes = new Uint8Array(size)
        let at = 0
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
        resolve({ status, bytes })
      },
    })
    if (stdin !== undefined && stdin.byteLength > 0) channel.write(stdin)
    channel.end()
  })
}

/**
 * Restore a previously stored workspace into a freshly started machine.
 * @param mux - the machine's channels.
 * @returns whether anything was restored.
 */
export async function restoreWorkspace(mux: Mux): Promise<boolean> {
  const stored = await load()
  if (stored === undefined || stored.byteLength === 0) return false
  try {
    const archive = await through(stored, 'gunzip')
    const { status } = await collect(mux, `mkdir -p ${PARENT} && exec tar -C ${PARENT} -xf -`, archive)
    if (status !== 0) throw new Error(`tar exited ${String(status)}`)
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
 * @param machine - the running machine.
 * @returns the durability handle.
 */
export function persistWorkspace(machine: Machine): RuntimePersistence {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined

  const snapshot = async (): Promise<void> => {
    try {
      // `node_modules` is excluded for the same reason a backup would exclude
      // it: it is large, it is derived, and `npm install` puts it back.
      const { status, bytes } = await collect(
        machine.mux,
        `exec tar -C ${PARENT} --exclude=node_modules --exclude=.dsh-partial -cf - ${NAME}`,
      )
      if (status !== 0) throw new Error(`tar exited ${String(status)}`)
      await save(await through(bytes, 'gzip'))
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
