/**
 * Node's `Timeout` handle over the browser's numeric timer ids.
 *
 * `setTimeout` returns a number in a page and an object in Node, and dsh is
 * written against the object: keeping a process alive or not is a real thing to
 * express there, so `setTimeout(…).unref()` appears wherever a timer must not
 * hold the event loop open. In a page there is no event loop to hold open, so
 * `ref`/`unref` are honest no-ops — but they have to *exist*, because the call
 * is made for its side effect and its absence is a TypeError that takes down
 * whatever was being timed.
 *
 * The handle stays interchangeable with the number it wraps: it coerces to the
 * id, and the patched `clearTimeout`/`clearInterval` accept either.
 */

/**
 * A browser timer id. The platform returns a number; the ambient Node types in
 * scope claim otherwise, so this states what actually comes back at runtime.
 */
type TimerId = number

/** `NodeJS.Timeout`, as much of it as anything here reads. */
export class Timeout {
  constructor(private readonly id: TimerId, private readonly kind: 'timeout' | 'interval') {}

  /** No-op: a page has no event loop for a timer to hold open. */
  ref(): this { return this }
  unref(): this { return this }
  hasRef(): boolean { return true }

  /** Node restarts the timer; there is no stored delay here to restart from. */
  refresh(): this { return this }

  /** What `clearTimeout(handle)` and any numeric use resolve to. */
  [Symbol.toPrimitive](): TimerId { return this.id }

  /** The underlying platform id. */
  valueOf(): TimerId { return this.id }

  /** Which clear function owns this handle. */
  get timerKind(): 'timeout' | 'interval' { return this.kind }
}

/** Unwrap either spelling of a timer handle. */
function idOf(handle: unknown): TimerId | undefined {
  if (handle instanceof Timeout) return handle.valueOf()
  if (typeof handle === 'number' || typeof handle === 'object') return handle as TimerId
  return undefined
}

let installed = false

/**
 * Make the realm's timer functions return Node-shaped handles.
 *
 * Installed onto the globals rather than only onto the `node:timers` module
 * because that is where the calls come from: dsh's packages use the global
 * `setTimeout`, as browser-targeted code does, and only differ in what they
 * expect back.
 */
export function installTimerHandles(): void {
  if (installed) return
  installed = true

  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const realClearTimeout = globalThis.clearTimeout
  const realClearInterval = globalThis.clearInterval

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
    new Timeout(realSetTimeout(handler, timeout, ...rest) as unknown as TimerId, 'timeout')) as unknown as typeof globalThis.setTimeout

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
    new Timeout(realSetInterval(handler, timeout, ...rest) as unknown as TimerId, 'interval')) as unknown as typeof globalThis.setInterval

  globalThis.clearTimeout = ((handle?: unknown) => { realClearTimeout(idOf(handle) as never) }) as typeof globalThis.clearTimeout
  globalThis.clearInterval = ((handle?: unknown) => { realClearInterval(idOf(handle) as never) }) as typeof globalThis.clearInterval
}
