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
 */

/** The database, and the store inside it. */
const DATABASE = 'dsh-web-v86'
const STORE = 'disks'

/** One stored disk, as the panel lists it. */
export interface StoredDisk {
  /** The guest it belongs to. */
  guest: string
  /** The file's own name, as the user's computer had it. */
  name: string
  /** Its byte length. */
  size: number
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
 * Keep a disk image for a guest, replacing whatever was there.
 * @param guest - the guest id it boots.
 * @param file - the image, as the file input handed it over.
 */
export async function storeDisk(guest: string, file: File): Promise<void> {
  await transact('readwrite', store => store.put(file, guest))
}

/**
 * The disk image kept for a guest.
 * @param guest - the guest id.
 * @returns the file, or undefined when none was stored.
 */
export async function storedDisk(guest: string): Promise<File | undefined> {
  // A browser that denies storage, or a private window that has none, is not a
  // failure here: it means no stored disk, which the caller already handles.
  const found = await transact<File | undefined>('readonly', store => store.get(guest) as IDBRequest<File | undefined>)
    .catch(() => undefined)
  return found instanceof File ? found : undefined
}

/**
 * Forget a guest's disk image.
 * @param guest - the guest id.
 */
export async function forgetDisk(guest: string): Promise<void> {
  await transact('readwrite', store => store.delete(guest))
}

/**
 * Every disk image this browser is keeping.
 * @returns one row per guest, so the panel can show what it costs and offer to drop it.
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
        if (file instanceof File) rows.push({ guest: String(position.key), name: file.name, size: file.size })
        position.continue()
      }
      cursor.onerror = () => { resolve(rows) }
    })
  } finally {
    database.close()
  }
}
