/**
 * POSIX errno objects shaped exactly like Node's `ErrnoException`, so code that
 * branches on `error.code === 'ENOENT'` keeps working unchanged in the browser.
 */

/** Error numbers dsh code paths actually observe. */
const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, 'no such file or directory'],
  EEXIST: [-17, 'file already exists'],
  ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'],
  ENOTEMPTY: [-39, 'directory not empty'],
  EACCES: [-13, 'permission denied'],
  EPERM: [-1, 'operation not permitted'],
  EINVAL: [-22, 'invalid argument'],
  EBADF: [-9, 'bad file descriptor'],
  ELOOP: [-40, 'too many symbolic links encountered'],
  ENOSPC: [-28, 'no space left on device'],
  EXDEV: [-18, 'cross-device link not permitted'],
  ESPIPE: [-29, 'invalid seek'],
  ENOSYS: [-38, 'function not implemented'],
}

/** Node-compatible filesystem error. */
export interface FsError extends Error {
  code: string
  errno: number
  syscall?: string
  path?: string
  dest?: string
}

/**
 * Build a Node-shaped errno error.
 * @param code - POSIX code such as `ENOENT`.
 * @param syscall - the failing syscall name, used in the message.
 * @param path - the primary path operand.
 * @param dest - the secondary path operand (rename/link).
 * @returns the error, ready to throw.
 */
export function fsError(code: string, syscall?: string, path?: string, dest?: string): FsError {
  const [errno, text] = ERRNO[code] ?? [-1, 'unknown error']
  let message = `${code}: ${text}`
  if (syscall !== undefined) message += `, ${syscall}`
  if (path !== undefined) message += ` '${path}'`
  if (dest !== undefined) message += ` -> '${dest}'`
  const error = new Error(message) as FsError
  error.code = code
  error.errno = errno
  if (syscall !== undefined) error.syscall = syscall
  if (path !== undefined) error.path = path
  if (dest !== undefined) error.dest = dest
  return error
}

/** True when the value is a filesystem error carrying `code`. */
export function isFsError(value: unknown, code?: string): value is FsError {
  if (!(value instanceof Error)) return false
  const candidate = value as FsError
  if (typeof candidate.code !== 'string') return false
  return code === undefined || candidate.code === code
}
