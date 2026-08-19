/**
 * Putting Python on the machine.
 *
 * `src/python/container-python.ts` is the program; this is what installs it,
 * and what keeps an installation across reloads. Two decisions are worth
 * writing down, because both were measured against the container rather than
 * assumed:
 *
 * `jsh` honours `$PATH`, but only the one it was *spawned* with: a shell that
 * exports `PATH` mid-script keeps resolving commands against the environment it
 * started in, so `export PATH=…; python` is still the old `python`. That is why
 * these four names live in a directory of the harness's own and why
 * `webcontainer.ts` puts that directory at the front of `PATH` on every spawn —
 * it is the only placement that reaches both the agent's commands and the
 * terminal's, and the only one that wins against `/usr/local/bin/python3`,
 * which is RustPython and cannot be moved or overwritten by a page.
 *
 * They also need the executable bit, which the container's filesystem API
 * cannot set, so it is set by running `chmod` — the container has one.
 *
 * The interpreter itself is 14 MB of WebAssembly and is fetched by the program
 * on first use, not shipped in the page. What is stored here is the *result*:
 * the runtime directory, wheels and installed packages included, snapshotted to
 * IndexedDB the way the workspace is. A returning visitor pays nothing, and a
 * visitor who never runs Python stores nothing.
 */

import type { WebContainer } from '@webcontainer/api'
import { CONTAINER_PYTHON } from '../generated/container-python.ts'
import { HARNESS_DIR, WORKDIR } from './webcontainer.ts'

/**
 * Where the program lives, as the container addresses it.
 *
 * Read through a function rather than held in a constant, for the reason
 * `persist.ts` gives: this module and `webcontainer.ts` import each other, and
 * at module-init time the constant over there has not been assigned yet.
 * @returns the path of the program the wrappers call.
 */
function program(): string {
  return `${HARNESS_DIR}/python.cjs`
}

/**
 * Where the interpreter and everything installed into it live.
 * @returns the runtime directory, as the container addresses it.
 */
export function pythonHome(): string {
  return `${HARNESS_DIR}/python`
}

/**
 * The directory the programs are installed into, as the container addresses it.
 *
 * Under the harness's own directory rather than in the workspace: it is not the
 * user's work, it must not show up in `ls` or `git status`, and the snapshot
 * already excludes everything here.
 * @returns the directory holding `python`, `python3`, `pip` and `pip3`.
 */
export function pythonBin(): string {
  return `${HARNESS_DIR}/bin`
}

/** The names a command line can call this by, and which front end each is. */
const COMMANDS: { name: string, role: 'python' | 'pip' }[] = [
  { name: 'python', role: 'python' },
  { name: 'python3', role: 'python' },
  { name: 'pip', role: 'pip' },
  { name: 'pip3', role: 'pip' },
]

/**
 * The wrapper one name is.
 *
 * Four words of Node rather than four copies of the program: the role is passed
 * in rather than read from `argv[0]`, so a shell that resolves the name through
 * a copy or a link cannot change which front end runs.
 * @param role - which front end this name is.
 * @returns the script's text.
 */
function wrapper(role: 'python' | 'pip'): string {
  const path = `${WORKDIR}/${program()}`
  return `#!/usr/bin/env node\nrequire(${JSON.stringify(path)}).run(${JSON.stringify(role)})\n`
}

/**
 * Install `python`, `python3`, `pip` and `pip3` into the container.
 *
 * Idempotent, and cheap enough to run at every boot: the program is a few
 * hundred kilobytes of JavaScript and the wrappers are one line each. The
 * interpreter is not touched — the first command that needs it fetches it.
 * @param runtime - the booted container.
 */
export async function installPython(runtime: WebContainer): Promise<void> {
  await runtime.fs.mkdir(HARNESS_DIR, { recursive: true })
  await runtime.fs.mkdir(pythonBin(), { recursive: true })
  await runtime.fs.writeFile(program(), CONTAINER_PYTHON)
  for (const { name, role } of COMMANDS) {
    await runtime.fs.writeFile(`${pythonBin()}/${name}`, wrapper(role))
  }
  // The filesystem API has no `chmod`, and `jsh` refuses to spawn a file
  // without the executable bit — `EACCES`, from a file that is plainly there.
  // The container has a real `chmod`, so it is used.
  const paths = COMMANDS.map(({ name }) => `${pythonBin()}/${name}`)
  const marking = await runtime.spawn('chmod', ['+x', ...paths])
  const status = await marking.exit
  if (status !== 0) console.warn(`[runtime] python could not be made executable (chmod exited ${String(status)})`)
}

/** The database and record a stored Python installation lives in. */
const DB_NAME = 'dsh-runtime-python'
const STORE = 'snapshots'
const KEY = 'runtime'

/** How long to wait after a change before snapshotting. */
const DEBOUNCE_MS = 4_000

/** Open the snapshot database. */
async function open(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => { resolve(request.result) }
    // A blocked or unavailable store costs one download and nothing else.
    request.onerror = () => { resolve(undefined) }
  })
}

/** Read the stored installation, if there is one. */
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

/**
 * Write the snapshot.
 * @param bytes - the exported tree.
 * @returns whether it was actually stored — a quota failure is not a snapshot.
 */
async function save(bytes: Uint8Array): Promise<boolean> {
  const db = await open()
  if (db === undefined) return false
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(bytes, KEY)
    transaction.oncomplete = () => { resolve(true) }
    transaction.onerror = () => { resolve(false) }
  })
}

/**
 * Put a previously fetched interpreter back into a freshly booted container.
 *
 * Only for a visitor who has one: with no record this does nothing, costs one
 * IndexedDB read, and leaves the first `python` to fetch the runtime itself.
 * @param runtime - the booted container.
 * @returns whether an installation was restored.
 */
export async function restorePython(runtime: WebContainer): Promise<boolean> {
  const bytes = await load()
  if (bytes === undefined || bytes.byteLength === 0) return false
  try {
    await runtime.fs.mkdir(pythonHome(), { recursive: true })
    await runtime.mount(bytes, { mountPoint: pythonHome() })
    return true
  } catch (error) {
    // A snapshot from an incompatible version costs a download, not a boot.
    console.warn('[runtime] the stored Python could not be restored:', error)
    return false
  }
}

/** Control over a Python installation's durability. */
export interface PythonPersistence {
  /** Snapshot now, if anything changed, and wait for it to be stored. */
  flush(): Promise<void>
  /** Note that something may have changed, scheduling a snapshot. */
  touch(): void
  /** Forget the stored installation. */
  clear(): Promise<void>
}

/**
 * Start snapshotting the Python installation.
 *
 * The tree is tens of megabytes and changes twice in a typical session — once
 * when it is fetched, once per `pip install` — so a snapshot per command would
 * copy it for nothing. What is compared instead is a listing: the interpreter's
 * marker, the wheels, and the installed packages. Two reads of a directory are
 * cheap; an export of 30 MB is not.
 * @param runtime - the booted container.
 * @returns the durability handle.
 */
export function persistPython(runtime: WebContainer): PythonPersistence {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let stored: string | undefined
  let snapshotted = false
  let cleared = false

  /** What the installation looks like right now, cheaply. */
  const generation = async (): Promise<string | undefined> => {
    const listing = await Promise.all(['', '/wheels', '/site-packages'].map(async part =>
      runtime.fs.readdir(`${pythonHome()}${part}`).catch(() => [] as string[])))
    const [root] = listing
    // No interpreter, nothing to store: a directory the program has only begun
    // to write is not worth a snapshot, and the marker is written last.
    if (root === undefined || !root.some(name => name.startsWith('.installed-'))) return undefined
    return listing.map(names => [...names].sort().join(',')).join('|')
  }

  const snapshot = async (): Promise<void> => {
    // `dsh.reset()` deletes the record and then reloads, and a reload fires
    // `pagehide` — which would snapshot the container that is still standing
    // and write back exactly what was just erased.
    if (cleared) return
    try {
      const now = await generation()
      snapshotted = true
      if (now === undefined || now === stored) return
      const bytes = await runtime.export(pythonHome(), { format: 'binary' })
      // Only on a write that actually landed: a store that refused for quota
      // would otherwise be remembered as done and never tried again.
      if (await save(bytes as Uint8Array)) stored = now
    } catch (error) {
      console.warn('[runtime] Python could not be snapshotted:', error)
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

  // Whatever a restore just mounted is already in the record, so the first
  // snapshot of a session does not write back the bytes it read.
  void generation().then((current) => {
    if (!snapshotted && stored === undefined) stored = current
  })

  globalThis.addEventListener('pagehide', () => { void flush() })
  globalThis.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })

  return {
    flush,
    touch,
    async clear() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      stored = undefined
      snapshotted = false
      cleared = true
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
