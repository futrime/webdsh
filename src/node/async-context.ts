/**
 * `AsyncLocalStorage` for the browser.
 *
 * dsh uses it for one load-bearing thing: `ctx.agents.runAsInitiator(agent, …)`
 * wraps a whole turn, and the tool pipeline later calls `requireInitiator()`,
 * which throws if the store is gone. So a shim that only holds the value for
 * the synchronous part of `run()` makes every tool call fail.
 *
 * A page cannot implement real async context tracking: `await` resumes through
 * the %Promise% intrinsic, which no userland patch can intercept. What it can
 * do is keep the value alive for the *lifetime* of the async body — set on
 * entry, restored when the returned promise settles — and restore the captured
 * value inside continuations that were scheduled explicitly (`queueMicrotask`,
 * `setTimeout`, `setInterval`, `Promise.prototype.then/catch/finally`).
 *
 * That is exact for one active chain and for nesting. It is inexact only when
 * two `run()` calls with different values are in flight at once and one reads
 * the store after the other has entered — there, the most recently entered
 * value wins. Concurrent turns in different sessions are the case that can hit
 * it; the consequence is causal attribution on a log line, not a wrong tool
 * result, because subjects and owners are explicit parameters everywhere they
 * matter.
 */

/** The value stack; the top is what `getStore()` reports. */
interface Frame<T> {
  value: T | undefined
}

/** Every live storage instance, so the continuation patches can snapshot them all. */
const instances = new Set<AsyncLocalStorage<unknown>>()

/** Whether the continuation patches have been installed. */
let patched = false

/** Node's `AsyncLocalStorage`, to the extent a page can provide it. */
export class AsyncLocalStorage<T> {
  private frame: Frame<T> = { value: undefined }

  constructor() {
    instances.add(this as unknown as AsyncLocalStorage<unknown>)
    installContinuationPatches()
  }

  /** Snapshot for the continuation patches. */
  private snapshot(): T | undefined {
    return this.frame.value
  }

  /** Restore a snapshot inside a continuation. */
  private restore(value: T | undefined): void {
    this.frame.value = value
  }

  /**
   * Run `body` with `store` as the current value.
   *
   * When `body` returns a promise the value stays current until it settles, so
   * everything the body awaits still sees it.
   * @param store - the value to bind.
   * @param body - the function to run.
   * @param args - arguments forwarded to `body`.
   * @returns whatever `body` returns.
   */
  run<R>(store: T, body: (...args: never[]) => R, ...args: never[]): R {
    const previous = this.frame.value
    this.frame.value = store
    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      this.frame.value = previous
    }
    let result: R
    try {
      result = body(...args)
    } catch (error) {
      restore()
      throw error
    }
    if (isThenable(result)) {
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          restore()
          return value
        },
        (error: unknown) => {
          restore()
          throw error
        },
      ) as unknown as R
    }
    restore()
    return result
  }

  /** The current value, or undefined outside any `run`. */
  getStore(): T | undefined {
    return this.frame.value
  }

  /** Bind `store` for the rest of the current chain, without a scope. */
  enterWith(store: T): void {
    this.frame.value = store
  }

  /** Run `body` with no bound value. */
  exit<R>(body: (...args: never[]) => R, ...args: never[]): R {
    return this.run(undefined as unknown as T, body, ...args)
  }

  /** Drop the bound value. */
  disable(): void {
    this.frame.value = undefined
  }

  /** `AsyncLocalStorage.snapshot()` (Node 20+): capture now, restore on call. */
  static snapshot(): <R>(body: () => R) => R {
    const captured = [...instances].map(instance => [instance, instance.snapshot()] as const)
    return <R>(body: () => R): R => {
      const previous = captured.map(([instance]) => [instance, instance.snapshot()] as const)
      for (const [instance, value] of captured) instance.restore(value)
      try {
        return body()
      } finally {
        for (const [instance, value] of previous) instance.restore(value)
      }
    }
  }

  /** `AsyncLocalStorage.bind()`. */
  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    const restore = AsyncLocalStorage.snapshot()
    return ((...args: never[]) => restore(() => fn(...args))) as F
  }
}

/** Duck-type a thenable without assuming a native promise. */
function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Wrap the schedulers so an explicitly scheduled continuation restores the
 * values that were current when it was scheduled.
 *
 * `await` continuations are not reachable this way, which is why `run()` also
 * holds its value until the body settles. Together they cover every chain dsh
 * actually builds.
 */
function installContinuationPatches(): void {
  if (patched) return
  patched = true

  const realQueueMicrotask = globalThis.queueMicrotask.bind(globalThis)
  globalThis.queueMicrotask = (callback: () => void): void => {
    const restore = AsyncLocalStorage.snapshot()
    realQueueMicrotask(() => { restore(callback) })
  }

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    if (typeof handler !== 'function') return realSetTimeout(handler, timeout)
    const restore = AsyncLocalStorage.snapshot()
    return realSetTimeout(((...args: unknown[]) => { restore(() => { handler(...args) }) }) as TimerHandler, timeout, ...rest)
  }) as typeof globalThis.setTimeout

  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    if (typeof handler !== 'function') return realSetInterval(handler, timeout)
    const restore = AsyncLocalStorage.snapshot()
    return realSetInterval(((...args: unknown[]) => { restore(() => { handler(...args) }) }) as TimerHandler, timeout, ...rest)
  }) as typeof globalThis.setInterval

  // `.then()` callbacks are explicit continuations; `await` is not, and is
  // covered by run() holding its value for the body's lifetime instead.
  const realThen = Promise.prototype.then
  // eslint-disable-next-line no-extend-native
  Promise.prototype.then = function patchedThen<T, R1, R2>(
    this: Promise<T>,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const restore = AsyncLocalStorage.snapshot()
    return realThen.call(
      this,
      typeof onFulfilled === 'function' ? (value: T) => restore(() => onFulfilled(value)) : onFulfilled,
      typeof onRejected === 'function' ? (reason: unknown) => restore(() => onRejected(reason)) : onRejected,
    ) as Promise<R1 | R2>
  }
}

/** `AsyncResource`, which dsh only uses to keep a callback's context. */
export class AsyncResource {
  runInAsyncScope<R>(body: (...args: never[]) => R, _thisArg?: unknown, ...args: never[]): R {
    return body(...args)
  }

  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return AsyncLocalStorage.bind(fn)
  }

  emitDestroy(): this {
    return this
  }
}
