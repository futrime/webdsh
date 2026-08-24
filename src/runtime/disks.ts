/**
 * Disk images the user opened from their own computer.
 *
 * Two of the machines this build offers are free software and come from a
 * public mirror; the rest are proprietary operating systems whose images are
 * not this deployment's to serve. For those the honest path is the one a
 * person would take anyway: open the disk you already have.
 *
 * It has to be kept, though, and that is what this module is for. Choosing a
 * runtime takes effect at the next load — the tool registry is decided while
 * the host composes, so it cannot change underneath a running session — and a
 * `File` handed to a file input does not survive a reload. So the file is
 * written here, once, and read back at boot.
 *
 * Stored as a `File` rather than as bytes on purpose. A browser keeps a blob
 * on disk and hands back a reference, so putting a 300 MB Windows 98 image in
 * here neither reads it into memory nor copies it a second time — and v86
 * reads it in slices from exactly the same reference, so the disk is never
 * loaded whole at any point.
 *
 * One file per *slot*, not per guest. Several of these machines boot from more
 * than one file — a disk and a saved machine — and a store that could only
 * hold one of them made the others unreachable from a computer that has them
 * both.
 */

/** The database, and the store inside it. */
const DATABASE = 'dsh-web-v86'
const STORE = 'disks'

/** One stored image, as the setting lists it. */
export interface StoredDisk {
  /** The guest it belongs to. */
  guest: string
  /** Which of that guest's files it is. */
  slot: string
  /** The file's own name, as the user's computer had it. */
  name: string
  /** Its byte length. */
  size: number
}

/**
 * The key one guest's file is kept under.
 *
 * Keyed by slot as well as by guest because a guest can need more than one
 * file: Windows 98 boots from a disk *and* a saved machine, and a store that
 * held one file per guest could only ever be given the disk — which is the
 * difference between resuming in two seconds and cold-booting for ten minutes,
 * and for Arch the difference between running and not running at all.
 *
 * The bare guest id stays readable as the disk slot's key, because that is
 * what earlier versions wrote and a browser that already has a 300 MB Windows
 * image should not be asked for it again.
 * @param guest - the guest id.
 * @param slot - the v86 option the file fills.
 * @returns the store key.
 */
function keyFor(guest: string, slot: string): string {
  return `${guest}:${slot}`
}

/** Open the database, creating the store on first use. */
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('the disk store could not be opened')) }
  })
}

/** Run one transaction against the store. */
async function transact<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = body(database.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('the disk store refused the request')) }
    })
  } finally {
    database.close()
  }
}

/**
 * Keep one of a guest's images, replacing whatever was in that slot.
 * @param guest - the guest id it boots.
 * @param slot - the v86 option it fills.
 * @param file - the image, as the file input handed it over.
 */
export async function storeDisk(guest: string, slot: string, file: File): Promise<void> {
  await transact('readwrite', store => store.put(file, keyFor(guest, slot)))
}

/**
 * Read one key, treating a storage refusal as "nothing stored".
 *
 * A browser that denies storage, or a private window that has none, is not a
 * failure here: it means no stored image, which every caller already handles.
 * @param key - the store key.
 * @returns the file, or undefined.
 */
async function read(key: string): Promise<File | undefined> {
  const found = await transact<File | undefined>('readonly', store => store.get(key) as IDBRequest<File | undefined>)
    .catch(() => undefined)
  return found instanceof File ? found : undefined
}

/**
 * One image kept for a guest.
 * @param guest - the guest id.
 * @param slot - the v86 option it fills.
 * @returns the file, or undefined when none was stored.
 */
export async function storedDisk(guest: string, slot: string): Promise<File | undefined> {
  return read(keyFor(guest, slot))
}

/**
 * The single disk an earlier version of this store kept for a guest.
 *
 * Under the bare guest id, because that is what it wrote, and it was always
 * the guest's boot image — so only the caller that knows which slot *is* the
 * boot image may claim it. Offering it for every slot would hand a Windows 98
 * disk to the saved-machine slot as well, and boot the pair against itself.
 * @param guest - the guest id.
 * @returns the file, or undefined when this browser has none.
 */
export async function legacyDisk(guest: string): Promise<File | undefined> {
  return read(guest)
}

/**
 * Forget one of a guest's images.
 * @param guest - the guest id.
 * @param slot - the v86 option it fills.
 */
export async function forgetDisk(guest: string, slot: string): Promise<void> {
  await transact('readwrite', store => store.delete(keyFor(guest, slot)))
}

/**
 * Forget the single disk an earlier version kept for a guest.
 *
 * Separate from {@link forgetDisk} for the same reason {@link legacyDisk} is
 * separate from {@link storedDisk}: only the boot slot owns that entry, and
 * dropping it when some other slot is forgotten would silently take the
 * guest's disk with the saved machine.
 * @param guest - the guest id.
 */
export async function forgetLegacyDisk(guest: string): Promise<void> {
  await transact('readwrite', store => store.delete(guest)).catch(() => undefined)
}

/**
 * Every image this browser is keeping.
 * @returns one row per stored file, so the setting can show what it costs and
 * offer to drop it.
 */
export async function storedDisks(): Promise<StoredDisk[]> {
  const database = await open().catch(() => undefined)
  if (database === undefined) return []
  try {
    return await new Promise<StoredDisk[]>((resolve) => {
      const store = database.transaction(STORE, 'readonly').objectStore(STORE)
      const rows: StoredDisk[] = []
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        const position = cursor.result
        if (position === null) {
          resolve(rows)
          return
        }
        const file = position.value as unknown
        if (file instanceof File) {
          const key = String(position.key)
          const split = key.indexOf(':')
          rows.push(split === -1
            // A key with no slot is one an earlier version wrote, and it was
            // always the guest's own boot image.
            ? { guest: key, slot: '', name: file.name, size: file.size }
            : { guest: key.slice(0, split), slot: key.slice(split + 1), name: file.name, size: file.size })
        }
        position.continue()
      }
      cursor.onerror = () => { resolve(rows) }
    })
  } finally {
    database.close()
  }
}
