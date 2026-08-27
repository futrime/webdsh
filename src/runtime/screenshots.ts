/**
 * Whether a screenshot is also a file.
 *
 * `vm_screenshot` hands the picture straight to the model, the way `read_image`
 * hands back a file it read: one call, the image beside the text, nothing to
 * open. Until this setting existed it *also* wrote every one of those pictures
 * into the workspace as `screenshots/<machine>-<n>.png`, and that is what a
 * session with an emulated machine actually looks like — a model watching a
 * boot takes a screenshot every few seconds, and twenty of them are in the
 * Files panel before the desktop has finished drawing. The user asked for a
 * machine, not for a photo album.
 *
 * So the file is the option and the picture is the default. Three things still
 * write one, because in each of them the file is the answer rather than a
 * by-product:
 *
 * - The model named a `path`. It asked for a file; it gets a file.
 * - This setting is on, which is the album, kept for anyone who wants a record
 *   of what the machine showed.
 * - The picture could not reach the model at all — a route that declares no
 *   image input, or an attachment store that refused it. Writing nothing there
 *   would leave the tool with nothing to return.
 *
 * Kept in `localStorage` rather than in the workspace, like every other page
 * setting here: it is read by a tool call that can arrive before the virtual
 * filesystem has finished restoring, and it belongs to this browser rather
 * than to the files.
 */

/** Where the choice is kept. */
const STORAGE_KEY = 'dsh-web:screenshots'

/**
 * The shipped default: the model sees the screen, the workspace stays clean.
 */
const DEFAULT_KEEP = false

/** The choice in force, read once and kept. */
let current: boolean | undefined

/**
 * Whether a screenshot is written into the workspace as well as shown.
 * @returns the stored choice, or the shipped default.
 */
export function keepScreenshots(): boolean {
  if (current !== undefined) return current
  current = DEFAULT_KEEP
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) current = stored === 'true'
  } catch {
    // Storage can be denied outright (a third-party context, or a browser set
    // to block it). The default works; it just will not be remembered.
  }
  return current
}

/**
 * Change it. Takes effect on the next screenshot — there is nothing to restart.
 * @param next - whether to keep every screenshot as a file.
 * @returns the choice now in force.
 */
export function setKeepScreenshots(next: boolean): boolean {
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // The choice still applies to this page; it just will not outlive it.
  }
  return current
}
