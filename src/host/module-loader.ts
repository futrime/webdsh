/**
 * The client module-system bootstrap, as the page owes it to the shell.
 *
 * `@deepseek-ai/dsh-client-modules` splits the browser module system in two: a
 * tiny registration facade the *host* installs on `window`, and the real
 * implementation, which ships as an ordinary client bundle and is materialized
 * through that facade. Upstream's node half injects the facade into
 * `index.html` as an inline script followed by two blocking classic scripts,
 * so both have run by the time the shell's entry chunk evaluates and calls
 * `window.__ModuleLoader__.create(...)`.
 *
 * A static build has no HTML injection point — the page is authored, not
 * served — so the same three steps happen here instead, in the same order,
 * immediately before the shell entry is imported. The facade is byte-for-byte
 * the contract upstream publishes: a queue that collects `load()`
 * registrations, and a `create()` that pulls the modules bundle out of that
 * queue, runs its factory, and hands the rest to it.
 */

/** One bundle registering its lazy CJS factory. */
interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

/** The facade `window.__ModuleLoader__` carries before the module system exists. */
interface LoaderFacade {
  mode: 'queue' | 'live'
  pendingQueue: Registration[]
  load(registration: Registration): void
  create(options: Record<string, unknown>): unknown
}

/** The bundle rows the facade needs by URL. */
interface BootRow {
  id: string
  url: string
}

/** The graph published as `window.__DSH_BOOT__`. */
interface BootGraph {
  entries: BootRow[]
}

/** The bootstrap package whose ordinary client bundle IS the module system. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/**
 * Bundles the page executes before the shell, in this order.
 *
 * The modules bundle because `create()` reads it out of the queue by id, and
 * the runtime bundle because the shell's kernel expects the transport to have
 * registered before plugin boot — upstream preloads exactly these two.
 */
const PRELOAD_IDS = [CLIENT_MODULES_ID, '@deepseek-ai/dsh-client-runtime']

/** The bootstrap face a modules bundle must export. */
interface BootstrapExports {
  createClientModuleSystem: (target: LoaderFacade, bootstrap: { id: string, exports: unknown }, options: Record<string, unknown>) => unknown
  apply: unknown
}

/** Install the registration facade, replacing nothing if one is already there. */
function installFacade(): void {
  const target = globalThis as { __ModuleLoader__?: LoaderFacade }
  if (target.__ModuleLoader__ !== undefined) return
  const pendingQueue: Registration[] = []
  target.__ModuleLoader__ = {
    mode: 'queue',
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration)
    },
    create(options) {
      if (this.mode !== 'queue') {
        throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
      }
      const index = pendingQueue.findIndex(registration => registration.id === CLIENT_MODULES_ID)
      const registration = pendingQueue[index]
      if (registration === undefined) {
        throw new Error(`client-modules: the page did not preload ${CLIENT_MODULES_ID}/client.js`)
      }
      pendingQueue.splice(index, 1)
      const exports = registration.factory((specifier) => {
        throw new Error(`client-modules: ${CLIENT_MODULES_ID}/client.js requested external "${specifier}" before the module system existed`)
      })
      const face = exports as Partial<BootstrapExports> | null
      if (typeof face !== 'object' || face === null
        || typeof face.createClientModuleSystem !== 'function' || typeof face.apply !== 'function') {
        throw new Error(`client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face`)
      }
      const system = face.createClientModuleSystem(this, { id: registration.id, exports }, options)
      // The module table, left where it can be read from outside the shell.
      // Upstream's kernel used to publish this itself; it no longer does, and
      // the page is now the half that builds it — so what a test, a bug report
      // or a devtools session needs to see ("which bundles actually
      // materialized") stays visible rather than becoming a private field of
      // a bundle nobody can reach.
      ;(globalThis as { __DSH_MODULES__?: unknown }).__DSH_MODULES__ = system
      return system
    },
  }
}

/**
 * Execute one bundle as a classic script and wait for it.
 * @param url - the bundle URL, as the boot graph spells it.
 */
async function runBundle(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const element = document.createElement('script')
    element.async = false
    element.src = new URL(url, document.baseURI).href
    element.addEventListener('load', () => {
      element.remove()
      resolve()
    }, { once: true })
    element.addEventListener('error', () => {
      element.remove()
      reject(new Error(`client-modules: bootstrap bundle ${url} failed to load`))
    }, { once: true })
    document.head.append(element)
  })
}

/**
 * Install the facade and run the bundles the shell expects to already be
 * registered.
 * @param graph - the composed client graph, as `window.__DSH_BOOT__` carries it.
 */
export async function installModuleLoader(graph: BootGraph): Promise<void> {
  installFacade()
  for (const id of PRELOAD_IDS) {
    const row = graph.entries.find(entry => entry.id === id)
    // A row missing here is a composition fact, not a transport failure: the
    // package is not in this build. The modules bundle is not optional, and
    // `create()` says so in the one message that names the cause.
    if (row === undefined) continue
    await runBundle(row.url)
  }
}
