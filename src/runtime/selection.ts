/**
 * Which machine this session runs on.
 *
 * There are two, and they are not variations of one thing. The default is
 * WebContainers — Node in the tab, a POSIX filesystem, `npm install`, CPython.
 * The other is v86, an x86 PC emulated instruction by instruction, booting a
 * real operating system off a real disk image.
 *
 * The choice has to be readable *synchronously and before the host composes*,
 * because it decides which tools the model is offered — and a tool registry
 * that changes after the first request is a session where the model was told
 * about a shell it does not have. So it lives in `localStorage`, it is read
 * once at module evaluation, and changing it takes effect at the next load.
 * The panel that changes it says so rather than pretending otherwise; this is
 * the same contract the plugin installer already has, for the same reason.
 *
 * Nothing here loads the emulator. Reading the selection costs a
 * `localStorage` hit and a lookup in {@link GUESTS}; the 2 MB of WebAssembly
 * and the operating system behind it are fetched by `src/runtime/v86.ts`, and
 * only once something actually asks for the machine.
 */

import { guest, type GuestSpec } from './guests.ts'

/** What the session runs on. */
export type RuntimeSelection =
  /** WebContainers: Node in the tab. The default, and what every other suite tests. */
  | { kind: 'node' }
  /** v86: an emulated PC booting `image`. */
  | { kind: 'v86', image: string }

/** Where the choice is kept. */
const STORAGE_KEY = 'dsh-web:runtime'

/**
 * The URL parameter that sets it.
 *
 * `?runtime=node` or `?runtime=v86:freedos`. It writes the stored selection
 * rather than overriding it for one load, which is the behaviour a link is
 * expected to have — following one and then reloading should not silently put
 * you back on a different machine. It is also how `scripts/v86-e2e.ts` picks a
 * guest without driving the panel for every case.
 */
const URL_PARAMETER = 'runtime'

/**
 * Parse a stored or URL-supplied value.
 * @param raw - the text form, `node` or `v86:<image>`.
 * @returns the selection, or undefined when it names nothing this build has.
 */
function parse(raw: string | null): RuntimeSelection | undefined {
  if (raw === null || raw === '') return undefined
  if (raw === 'node') return { kind: 'node' }
  if (!raw.startsWith('v86:')) return undefined
  const image = raw.slice('v86:'.length)
  // A guest that is no longer in the catalog must not strand the page on a
  // machine it cannot build: an unknown id reads as no selection at all, which
  // is the default runtime.
  return guest(image) === undefined ? undefined : { kind: 'v86', image }
}

/** The text form, as it is stored. */
function format(selection: RuntimeSelection): string {
  return selection.kind === 'node' ? 'node' : `v86:${selection.image}`
}

/**
 * Resolve the selection once, at module evaluation.
 *
 * Once, deliberately: every consumer must agree about which machine this
 * session is, for the whole of it. A `localStorage` write made by the panel
 * changes what the *next* load composes, not what this one already did.
 */
const resolved: RuntimeSelection = (() => {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage can be denied outright (third-party context, or a browser set to
    // block it). That is not a reason to fail: it means no selection, which is
    // the default machine.
  }
  const fromUrl = typeof location === 'undefined'
    ? null
    : new URLSearchParams(location.search).get(URL_PARAMETER)
  const chosen = parse(fromUrl) ?? parse(stored) ?? { kind: 'node' as const }
  if (fromUrl !== null && parse(fromUrl) !== undefined) {
    try {
      localStorage.setItem(STORAGE_KEY, format(chosen))
    } catch {
      // Same as above: the link still works for this load.
    }
  }
  return chosen
})()

/** What this session runs on. */
export function runtimeSelection(): RuntimeSelection {
  return resolved
}

/** Whether this session is an emulated PC rather than a Node container. */
export function isEmulated(): boolean {
  return resolved.kind === 'v86'
}

/**
 * The machine this session boots, when it is an emulated one.
 * @returns the guest spec, or undefined on the default runtime.
 */
export function selectedGuest(): GuestSpec | undefined {
  return resolved.kind === 'v86' ? guest(resolved.image) : undefined
}

/**
 * Choose what the *next* load runs on.
 *
 * Deliberately does not reload: the caller is a panel that has just told the
 * user what will happen, and taking the page out from under them before they
 * have read it is not an improvement.
 * @param next - the machine to store.
 */
export function setRuntimeSelection(next: RuntimeSelection): void {
  localStorage.setItem(STORAGE_KEY, format(next))
}
