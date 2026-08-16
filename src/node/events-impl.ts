/**
 * `node:events` — a compact `EventEmitter` with the members dsh, cordis, and
 * the surveyed community plugins actually use.
 */

/** Node's EventEmitter. */
export class EventEmitter {
  private readonly registry = new Map<string | symbol, ((...args: unknown[]) => void)[]>()
  static defaultMaxListeners = 10

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const list = this.registry.get(event) ?? []
    list.push(listener)
    this.registry.set(event, list)
    return this
  }

  addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
  }

  prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const list = this.registry.get(event) ?? []
    list.unshift(listener)
    this.registry.set(event, list)
    return this
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.prependListener(event, wrapper)
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const list = this.registry.get(event)
    if (list === undefined) return this
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
    return this
  }

  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.registry.clear()
    else this.registry.delete(event)
    return this
  }

  /**
   * Emit an event.
   * @throws the payload when an unhandled `error` event is emitted, as Node does.
   */
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.registry.get(event)
    if (list === undefined || list.length === 0) {
      if (event === 'error') throw args[0] instanceof Error ? args[0] : new Error(String(args[0]))
      return false
    }
    for (const listener of [...list]) listener(...args)
    return true
  }

  listenerCount(event: string | symbol): number {
    return this.registry.get(event)?.length ?? 0
  }

  listeners(event: string | symbol): ((...args: unknown[]) => void)[] {
    return [...(this.registry.get(event) ?? [])]
  }

  rawListeners(event: string | symbol): ((...args: unknown[]) => void)[] {
    return this.listeners(event)
  }

  eventNames(): (string | symbol)[] {
    return [...this.registry.keys()]
  }

  setMaxListeners(): this { return this }
  getMaxListeners(): number { return EventEmitter.defaultMaxListeners }
}

/** `events.once(emitter, name)`. */
export function once(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => { resolve(args) })
  })
}

/** `events.setMaxListeners` is a no-op here (no listener-leak warning exists). */
export function setMaxListeners(): void {}

/** The module namespace: Node exports the class as both default and `.EventEmitter`. */
export const eventsModule = Object.assign(EventEmitter, {
  EventEmitter,
  default: EventEmitter,
  once,
  setMaxListeners,
  captureRejections: false,
  errorMonitor: Symbol('events.errorMonitor'),
})
