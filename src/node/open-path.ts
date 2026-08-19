/**
 * What "open this path" means in a tab.
 *
 * The harness asks its host to open a path in one place — `host.openPath`, the
 * RPC behind a file mention in the chat and behind the deliverables row's "show
 * in folder" — and on Linux that request ends at `xdg-open <path>`. This host
 * reports Linux, because the shipped compositions read `process.platform` to
 * choose their POSIX rows, so every one of those clicks arrived at a command.
 *
 * A page has no desktop to hand a path to. What it has is the Files panel, so
 * that is what the request opens: the page announces the path and the plugin
 * drawing that panel answers. Nothing here knows about the panel — the event is
 * the whole contract, and a deployment composed without a file browser simply
 * has no listener.
 */

/** The event a page listener subscribes to. */
export const OPEN_PATH_EVENT = 'dsh-web:open-path'

/** The command the harness's host reaches for, on the platform this host reports. */
export const OPEN_PATH_COMMAND = 'xdg-open'

/**
 * Announce that something asked for this path to be opened.
 *
 * Succeeding with nobody listening is deliberate: the path was opened as far as
 * this deployment can open one, and a failure would restore exactly the
 * behaviour this exists to fix — a click that reports an error nobody sees.
 * @param path - an absolute path in whichever filesystem is the live one.
 * @returns whether the page could be told at all.
 */
export function announceOpenPath(path: string): boolean {
  if (typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent(OPEN_PATH_EVENT, { detail: { path } }))
  return true
}
