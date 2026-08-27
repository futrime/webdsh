/**
 * The program that runs inside a browsed page, on the other side of the
 * isolation boundary.
 *
 * This file is never imported by the app. `scripts/build-browser-frame.mjs`
 * bundles it into a single string, and `src/browser/engine.ts` writes that
 * string into the top of every document it hands a tab — so what follows
 * executes with an opaque origin, inside a sandboxed frame, in the same realm
 * as a stranger's JavaScript and with no way back to the harness except one
 * `postMessage` channel.
 *
 * Two jobs, and they are separate.
 *
 * **Be the browser the page thinks it is in.** An opaque origin is a hostile
 * place to be a website: `localStorage`, `sessionStorage`, `document.cookie`,
 * `indexedDB` and `caches` all throw `SecurityError` rather than working, and
 * `fetch` reaches nothing at all. Every one of those is replaced here with
 * something that does work — backed by a jar the page owns, or by a request
 * the page makes on the frame's behalf. A site should be unable to tell the
 * difference until it tries to log in.
 *
 * **Be the machine the agent drives.** The three modes the tools offer — the
 * DOM, the pixels, and the console — are three views of this one document, and
 * all three are implemented below: {@link snapshot} walks the page the way a
 * screen reader would, {@link rasterise} draws it into a canvas and reads the
 * pixels back, and `evaluate` is the console. They are in one file because
 * they are one thing: a page, seen three ways.
 *
 * ## What may be trusted here
 *
 * Nothing in this file defends the harness. It cannot: it shares a realm with
 * the page, so a page determined to break these shims will break them. The
 * defence is one level up and belongs to the browser — the frame has an opaque
 * origin, so `parent.document` is a `SecurityError`, the harness's storage is
 * unreachable, and the worst a page can do is lie to the agent about itself.
 * Every message this file sends is treated by `src/browser/engine.ts` as
 * hostile input, and that is the right place for that check.
 */

/** What the page injects ahead of this bundle. */
interface FrameInit {
  /** Identifies this tab to the page; every message carries it. */
  nonce: string
  /** The document's real URL, which `location` must report. */
  url: string
  /** The cookies that apply to it, as a `document.cookie` string. */
  cookie: string
  /** This origin's `localStorage`, as the profile holds it. */
  local: Record<string, string>
  /** This tab's `sessionStorage`, which dies with the tab. */
  session: Record<string, string>
  /** What `navigator.userAgent` should say. */
  userAgent: string
}

declare global {
  interface Window {
    __WB_INIT__?: FrameInit
    __wbRuntime?: unknown
  }
}

const init: FrameInit = window.__WB_INIT__ ?? {
  nonce: '', url: 'about:blank', cookie: '', local: {}, session: {}, userAgent: navigator.userAgent,
}

/** Messages waiting for the page to be listening. */
const outbox: unknown[] = []

/** Post one message to the page, queueing it if the channel is not up yet. */
function send(message: Record<string, unknown>): void {
  const envelope = { ...message, nonce: init.nonce, wb: true }
  try {
    parent.postMessage(envelope, '*')
  } catch {
    outbox.push(envelope)
  }
}

/** Requests waiting on the page, by id. */
const pending = new Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()

let nextId = 0

/**
 * Ask the page for something and wait for the answer.
 * @param kind - what is being asked.
 * @param payload - the request.
 * @returns whatever the page sent back.
 */
function ask(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const id = `r${String(nextId++)}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ type: 'ask', id, kind, payload })
  })
}

// ---------------------------------------------------------------------------
// location
// ---------------------------------------------------------------------------

/**
 * The URL this document reports, which is not the one it was loaded from.
 *
 * A sandboxed `srcdoc` frame's real `location.href` is `about:srcdoc`, and
 * `window.location` cannot be redefined — it is the one property on `window`
 * that `Object.defineProperty` refuses, which is why `src/browser/rewrite.ts`
 * parses JavaScript at all. Every rewritten reference to `location` lands
 * here instead.
 */
let current = new URL(init.url)

/** Parts of a `URL` a `Location` also has, forwarded rather than reimplemented. */
const LOCATION_PARTS = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'] as const

/** A `Location` that navigates through the page. */
const virtualLocation = (() => {
  const target: Record<string, unknown> = {
    assign: (url: string) => { navigate(String(url), 'push') },
    replace: (url: string) => { navigate(String(url), 'replace') },
    reload: () => { void ask('reload') },
    toString: () => current.href,
    valueOf: () => current.href,
    // A page comparing `location.ancestorOrigins.length` should see a top-level
    // document, because as far as it can tell it is one.
    ancestorOrigins: { length: 0, item: () => null, contains: () => false },
  }
  for (const part of LOCATION_PARTS) {
    Object.defineProperty(target, part, {
      enumerable: true,
      configurable: true,
      get: () => current[part],
      set: (value: string) => {
        // Assigning any part of a location is a navigation, and the browser
        // resolves it against the current URL first — `location.pathname = '/x'`
        // keeps the host.
        const next = new URL(current.href)
        if (part === 'href') { navigate(String(value), 'push'); return }
        try {
          ;(next as unknown as Record<string, unknown>)[part] = value
        } catch {
          return
        }
        navigate(next.href, 'push')
      },
    })
  }
  return target
})()

/**
 * Go somewhere, by asking the page to fetch it.
 * @param url - where to, relative to the current document.
 * @param mode - whether this adds a history entry.
 */
function navigate(url: string, mode: 'push' | 'replace'): void {
  let resolved: string
  try {
    resolved = new URL(url, current.href).href
  } catch {
    return
  }
  if (resolved.startsWith('javascript:')) return
  send({ type: 'navigate', url: resolved, mode })
}

/** The runtime object every rewritten expression reads. */
const runtime: Record<string, unknown> = {
  // `top` and `parent` are this window. A page that checks whether it is
  // framed concludes that it is not, which stops the frame-busting redirect
  // every large site ships — and that redirect would otherwise be the first
  // thing that happens on the page.
  top: window,
  parent: window,
  self: window,
  /**
   * Dynamic `import()`, which cannot resolve a specifier from a `srcdoc`
   * document because there is no base URL for it to resolve against.
   * @param specifier - the module to load.
   * @returns the module namespace.
   */
  import: async (specifier: string): Promise<unknown> => {
    const url = await ask('module', { specifier: String(specifier), base: current.href })
    return import(/* @vite-ignore */ String(url))
  },
}
Object.defineProperty(runtime, 'location', {
  enumerable: true,
  get: () => virtualLocation,
  set: (value: unknown) => { navigate(String(value), 'push') },
})
window.__wbRuntime = runtime

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/**
 * A `Storage` over a plain map, with the index access sites rely on.
 *
 * `localStorage.foo = 'x'` and `localStorage.foo` are part of the interface,
 * not a convenience — enough sites use them that a shim implementing only the
 * methods reads as an empty store. A `Proxy` is what makes both spellings hit
 * the same map.
 * @param entries - the initial contents.
 * @param changed - called after every write, to push it to the page.
 * @returns the storage object.
 */
function makeStorage(entries: Record<string, string>, changed: (key: string | null, value: string | null) => void): Storage {
  const map = new Map<string, string>(Object.entries(entries))
  const api: Record<string, unknown> = {
    getItem: (key: unknown) => map.get(String(key)) ?? null,
    setItem: (key: unknown, value: unknown) => {
      map.set(String(key), String(value))
      changed(String(key), String(value))
    },
    removeItem: (key: unknown) => {
      map.delete(String(key))
      changed(String(key), null)
    },
    clear: () => {
      map.clear()
      changed(null, null)
    },
    key: (index: unknown) => [...map.keys()][Number(index)] ?? null,
  }
  Object.defineProperty(api, 'length', { get: () => map.size })
  return new Proxy(api, {
    get: (base, property) => {
      if (typeof property !== 'string' || property in base) return Reflect.get(base, property)
      return map.get(property)
    },
    set: (base, property, value) => {
      if (typeof property !== 'string' || property in base) return Reflect.set(base, property, value)
      map.set(property, String(value))
      changed(property, String(value))
      return true
    },
    has: (base, property) => (typeof property === 'string' && map.has(property)) || property in base,
    deleteProperty: (base, property) => {
      if (typeof property === 'string') {
        map.delete(property)
        changed(property, null)
      }
      return Reflect.deleteProperty(base, property)
    },
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: (_base, property) => (typeof property === 'string' && map.has(property)
      ? { value: map.get(property), enumerable: true, configurable: true, writable: true }
      : undefined),
  }) as unknown as Storage
}

/**
 * Replace a global that throws with one that works.
 * @param name - the property on `window`.
 * @param value - what to put there.
 */
function define(name: string, value: unknown): void {
  try {
    Object.defineProperty(window, name, { configurable: true, writable: true, value })
  } catch {
    // A browser that will not let this be replaced leaves the throwing
    // original, which is the behaviour without this file at all.
  }
}

define('localStorage', makeStorage(init.local, (key, value) => {
  send({ type: 'storage', area: 'local', key, value })
}))
define('sessionStorage', makeStorage(init.session, (key, value) => {
  send({ type: 'storage', area: 'session', key, value })
}))

/**
 * `indexedDB` and `caches`, which are removed rather than faked.
 *
 * Both throw `SecurityError` in an opaque origin, and neither can be shimmed
 * in less than a database. Removing them is the honest option and the one
 * sites handle: a feature test that fails sends the site down its
 * `localStorage` path, which does work here. A stub that accepted `open()` and
 * then never fired an event would hang the page instead, waiting for a
 * transaction that was never going to complete.
 */
for (const name of ['indexedDB', 'caches', 'webkitIndexedDB', 'mozIndexedDB']) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as unknown as Record<string, unknown>)[name]
  } catch {
    define(name, undefined)
  }
}

/** The cookie jar, as the page handed it over and as script changes it. */
let cookieText = init.cookie

try {
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get: () => cookieText,
    set: (value: string) => {
      const text = String(value)
      // The jar on the page's side decides what is actually stored — domains,
      // paths and expiry are its rules to enforce — and reports the string
      // this document should now read. Until it answers, the optimistic
      // update is what a synchronous `document.cookie` read has to return.
      const name = text.split(';')[0]?.split('=')[0]?.trim() ?? ''
      const pair = text.split(';')[0]?.trim() ?? ''
      const kept = cookieText.split('; ').filter((entry) => entry !== '' && entry.split('=')[0] !== name)
      if (!/(?:^|;)\s*(?:max-age\s*=\s*-|expires\s*=)/i.test(text) || !/max-age\s*=\s*(?:0|-)/i.test(text)) {
        kept.push(pair)
      }
      cookieText = kept.join('; ')
      send({ type: 'cookie', value: text })
    },
  })
} catch {
  // Same reasoning as `define`: a browser that refuses leaves the throwing one.
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

/** One request the page made on the frame's behalf, as it comes back. */
interface FetchReply {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  url: string
  error?: string
}

/** Decode base64 into bytes, which is how a body crosses the channel. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  // Backed by a plain `ArrayBuffer` rather than whatever `Uint8Array(number)`
  // infers, because a `Response` and a `Blob` both refuse a view that might be
  // over shared memory — and this page is cross-origin isolated, so the
  // compiler is right to think it might be.
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const nativeFetch = window.fetch.bind(window)

/**
 * `fetch`, routed through the page.
 *
 * A `data:` or `blob:` URL is served by the frame itself, because those are
 * the two schemes an opaque origin can read and because every subresource this
 * machine inlines is one of them — sending them to the page would be a round
 * trip to fetch bytes the frame already holds.
 */
define('fetch', async (input: RequestInfo | URL, config?: RequestInit): Promise<Response> => {
  const request = new Request(typeof input === 'string' ? new URL(input, current.href).href : input, config)
  if (/^(?:data|blob):/i.test(request.url)) return nativeFetch(request)
  const body = config?.body === undefined || config.body === null ? undefined : String(config.body)
  const reply = await ask('fetch', {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    ...(body === undefined ? {} : { body }),
  }) as FetchReply
  if (reply.error !== undefined) throw new TypeError(reply.error)
  const bytes = fromBase64(reply.body)
  const response = new Response(reply.status === 204 || reply.status === 304 ? null : bytes, {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
  })
  Object.defineProperty(response, 'url', { value: reply.url })
  return response
})

/**
 * `XMLHttpRequest`, over the same channel.
 *
 * Enough of the interface for the libraries that still use it: the four
 * lifecycle states, the events, the response accessors, and the header
 * methods. Synchronous requests are not supported and say so — there is no way
 * to block on a `postMessage` round trip, and a silent asynchronous answer to
 * a synchronous call is worse than an error.
 */
class ProxiedXhr extends EventTarget {
  static readonly UNSENT = 0
  static readonly OPENED = 1
  static readonly HEADERS_RECEIVED = 2
  static readonly LOADING = 3
  static readonly DONE = 4

  readonly UNSENT = 0
  readonly OPENED = 1
  readonly HEADERS_RECEIVED = 2
  readonly LOADING = 3
  readonly DONE = 4

  readyState = 0
  status = 0
  statusText = ''
  responseText = ''
  responseType: XMLHttpRequestResponseType = ''
  responseURL = ''
  timeout = 0
  withCredentials = false
  onreadystatechange: ((this: ProxiedXhr, event: Event) => unknown) | null = null
  onload: ((this: ProxiedXhr, event: Event) => unknown) | null = null
  onerror: ((this: ProxiedXhr, event: Event) => unknown) | null = null
  onloadend: ((this: ProxiedXhr, event: Event) => unknown) | null = null
  onprogress: ((this: ProxiedXhr, event: Event) => unknown) | null = null

  #method = 'GET'
  #url = ''
  #headers: Record<string, string> = {}
  #responseHeaders: Record<string, string> = {}
  #bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
  #aborted = false

  /** Whatever `responseType` asks for, built from the bytes that arrived. */
  get response(): unknown {
    if (this.responseType === 'json') {
      try {
        return JSON.parse(this.responseText)
      } catch {
        return null
      }
    }
    if (this.responseType === 'arraybuffer') return this.#bytes.buffer
    if (this.responseType === 'blob') return new Blob([this.#bytes])
    if (this.responseType === 'document') {
      return new DOMParser().parseFromString(this.responseText, 'text/html')
    }
    return this.responseText
  }

  /**
   * Begin a request.
   * @param method - the HTTP method.
   * @param url - where to, relative to the document.
   * @param async_ - must be true; a synchronous request cannot be served here.
   */
  open(method: string, url: string, async_ = true): void {
    if (!async_) throw new DOMException('synchronous XMLHttpRequest is not available in this browser machine', 'InvalidAccessError')
    this.#method = method.toUpperCase()
    this.#url = new URL(url, current.href).href
    this.readyState = 1
    this.#fire('readystatechange')
  }

  /**
   * Set a request header.
   * @param name - the header.
   * @param value - its value.
   */
  setRequestHeader(name: string, value: string): void {
    this.#headers[name] = value
  }

  /** Every response header, folded as the interface specifies. */
  getAllResponseHeaders(): string {
    return Object.entries(this.#responseHeaders).map(([name, value]) => `${name}: ${value}`).join('\r\n')
  }

  /**
   * One response header.
   * @param name - the header.
   * @returns its value, or null.
   */
  getResponseHeader(name: string): string | null {
    return this.#responseHeaders[name.toLowerCase()] ?? null
  }

  /** Give up on the request. */
  abort(): void {
    this.#aborted = true
    this.readyState = 0
  }

  /**
   * Send it.
   * @param body - the request body.
   */
  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    void (async () => {
      try {
        const reply = await ask('fetch', {
          url: this.#url,
          method: this.#method,
          headers: this.#headers,
          ...(body === undefined || body === null ? {} : { body: String(body) }),
        }) as FetchReply
        if (this.#aborted) return
        if (reply.error !== undefined) throw new Error(reply.error)
        this.status = reply.status
        this.statusText = reply.statusText
        this.responseURL = reply.url
        this.#responseHeaders = reply.headers
        this.#bytes = fromBase64(reply.body)
        this.responseText = new TextDecoder().decode(this.#bytes)
        this.readyState = 4
        this.#fire('readystatechange')
        this.#fire('load')
        this.#fire('loadend')
      } catch {
        if (this.#aborted) return
        this.readyState = 4
        this.#fire('readystatechange')
        this.#fire('error')
        this.#fire('loadend')
      }
    })()
  }

  /**
   * Dispatch one event to both the listener list and the `on…` property.
   * @param type - the event name.
   */
  #fire(type: string): void {
    const event = new Event(type)
    this.dispatchEvent(event)
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`]
    if (typeof handler === 'function') (handler as (event: Event) => void).call(this, event)
  }
}
define('XMLHttpRequest', ProxiedXhr)

/**
 * `sendBeacon`, which is fire-and-forget and therefore easy to honour.
 * @param url - where to.
 * @param data - what to send.
 * @returns true, as the real one does when it accepts the request.
 */
try {
  Object.defineProperty(Navigator.prototype, 'sendBeacon', {
    configurable: true,
    value: (url: string, data?: BodyInit): boolean => {
      void ask('fetch', {
        url: new URL(String(url), current.href).href,
        method: 'POST',
        headers: {},
        ...(data === undefined ? {} : { body: String(data) }),
      }).catch(() => undefined)
      return true
    },
  })
} catch {
  // Not replaceable here; a beacon that does nothing is what it was already.
}

/**
 * `WebSocket`, which this machine does not have.
 *
 * A socket needs a relay — the page can only speak HTTP — so the constructor
 * succeeds and the socket closes, which is the shape every site already
 * handles because it is what a blocked or failed connection looks like.
 * Throwing from the constructor instead would take down the script that opened
 * it, and a page that cannot open a chat socket should still render.
 */
class DeadSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = 0
  onopen: ((event: Event) => unknown) | null = null
  onclose: ((event: CloseEvent) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
  onmessage: ((event: MessageEvent) => unknown) | null = null

  /**
   * @param url - the socket URL, kept so the page reports it accurately.
   */
  constructor(url: string) {
    super()
    this.url = String(url)
    send({ type: 'console', level: 'warn', text: `WebSocket to ${this.url} is not available on this machine` })
    setTimeout(() => {
      this.readyState = 3
      const error = new Event('error')
      this.dispatchEvent(error)
      this.onerror?.(error)
      const closed = new CloseEvent('close', { code: 1006, reason: 'no relay', wasClean: false })
      this.dispatchEvent(closed)
      this.onclose?.(closed)
    }, 0)
  }

  /** Accepted and discarded; the socket is already closing. */
  send(): void { /* nothing to send it down */ }

  /** Already closed. */
  close(): void { this.readyState = 3 }
}
define('WebSocket', DeadSocket)

// ---------------------------------------------------------------------------
// history, dialogs, and the rest of the window
// ---------------------------------------------------------------------------

/**
 * A `History` the page keeps.
 *
 * `pushState` with a real URL throws `SecurityError` in an opaque origin —
 * measured — so the whole interface is virtual: the state is held here, the
 * URL is the virtual location's, and the page is told so its address bar and
 * its back button agree with what the site thinks happened.
 */
const virtualHistory = {
  get length(): number { return historyLength },
  scrollRestoration: 'auto' as ScrollRestoration,
  state: null as unknown,
  /**
   * Add a history entry without navigating.
   * @param state - the state object.
   * @param _title - ignored, as it is by every browser.
   * @param url - the new URL.
   */
  pushState(state: unknown, _title: string, url?: string | null): void {
    virtualHistory.state = state
    if (url !== undefined && url !== null) current = new URL(String(url), current.href)
    historyLength += 1
    send({ type: 'history', action: 'push', url: current.href })
  },
  /**
   * Replace the current entry.
   * @param state - the state object.
   * @param _title - ignored.
   * @param url - the new URL.
   */
  replaceState(state: unknown, _title: string, url?: string | null): void {
    virtualHistory.state = state
    if (url !== undefined && url !== null) current = new URL(String(url), current.href)
    send({ type: 'history', action: 'replace', url: current.href })
  },
  /** Go back one entry. */
  back(): void { send({ type: 'history', action: 'go', delta: -1 }) },
  /** Go forward one entry. */
  forward(): void { send({ type: 'history', action: 'go', delta: 1 }) },
  /**
   * Go by a number of entries.
   * @param delta - how far, negative for back.
   */
  go(delta = 0): void { send({ type: 'history', action: 'go', delta }) },
}
let historyLength = 1
define('history', virtualHistory)

/**
 * The modal dialogs, which have no user to answer them.
 *
 * A real `alert` blocks the frame until someone clicks, and there is nobody to
 * click. Each one is recorded and answered with the default a dismissed dialog
 * gives, so a page that guards on `confirm()` takes its "no" branch rather
 * than stopping for ever.
 */
define('alert', (message?: unknown) => {
  send({ type: 'dialog', kind: 'alert', message: String(message ?? '') })
})
define('confirm', (message?: unknown) => {
  send({ type: 'dialog', kind: 'confirm', message: String(message ?? '') })
  return false
})
define('prompt', (message?: unknown, fallback?: unknown) => {
  send({ type: 'dialog', kind: 'prompt', message: String(message ?? '') })
  return fallback === undefined ? null : String(fallback)
})
define('print', () => {
  send({ type: 'dialog', kind: 'print', message: '' })
})

/**
 * `window.open`, which opens a tab in this machine rather than in the browser
 * around it.
 * @param url - where to.
 * @returns null, because a handle to a tab in another frame is not something
 * this machine can give out.
 */
define('open', (url?: string): null => {
  if (url !== undefined && url !== '') {
    send({ type: 'open', url: new URL(String(url), current.href).href })
  }
  return null
})

try {
  Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => init.userAgent })
} catch { /* left as the browser's own */ }

for (const [name, getter] of [['URL', () => current.href], ['documentURI', () => current.href]] as const) {
  try {
    Object.defineProperty(Document.prototype, name, { configurable: true, get: getter })
  } catch { /* left alone */ }
}

// ---------------------------------------------------------------------------
// intercepting what would leave the frame
// ---------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (anchor === null || anchor === undefined) return
  const href = anchor.getAttribute('href') ?? ''
  if (href.startsWith('#') || href.startsWith('javascript:')) return
  event.preventDefault()
  navigate(href, 'push')
}, true)

document.addEventListener('submit', (event) => {
  if (event.defaultPrevented) return
  const form = event.target as HTMLFormElement | null
  if (form === null) return
  event.preventDefault()
  const method = (form.getAttribute('method') ?? 'GET').toUpperCase()
  const action = form.getAttribute('action') ?? current.href
  const data = new FormData(form)
  const fields: [string, string][] = []
  data.forEach((value, key) => { fields.push([key, typeof value === 'string' ? value : value.name]) })
  send({ type: 'submit', url: new URL(action, current.href).href, method, fields })
}, true)

// ---------------------------------------------------------------------------
// what the agent sees: the console mode
// ---------------------------------------------------------------------------

/** Every console message and page error, newest last. */
const consoleLog: { level: string, text: string, at: number }[] = []

/** The most messages kept, so a page that logs in a loop cannot exhaust memory. */
const CONSOLE_LIMIT = 500

/**
 * Render one console argument the way a devtools console would.
 * @param value - the argument.
 * @returns its text.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Element) return `<${value.tagName.toLowerCase()}>`
  try {
    return JSON.stringify(value, (_key, held: unknown) => (typeof held === 'bigint' ? String(held) : held)) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Record one line, and tell the page so the panel can show it live.
 * @param level - the console level.
 * @param text - the message.
 */
function record(level: string, text: string): void {
  consoleLog.push({ level, text, at: Date.now() })
  if (consoleLog.length > CONSOLE_LIMIT) consoleLog.splice(0, consoleLog.length - CONSOLE_LIMIT)
  send({ type: 'console', level, text })
}

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]): void => {
    record(level, args.map(describe).join(' '))
    original(...args)
  }
}

window.addEventListener('error', (event) => {
  record('error', event.error instanceof Error
    ? `${event.error.name}: ${event.error.message}`
    : String(event.message))
})
window.addEventListener('unhandledrejection', (event) => {
  record('error', `Unhandled rejection: ${describe((event as PromiseRejectionEvent).reason)}`)
})

// ---------------------------------------------------------------------------
// what the agent sees: the DOM mode
// ---------------------------------------------------------------------------

/** Elements the last snapshot named, so a reference can be acted on later. */
const referenced = new Map<string, Element>()

let refCounter = 0

/** Roles worth naming even when the element is not interactive. */
const LANDMARKS = new Set(['main', 'nav', 'header', 'footer', 'aside', 'form', 'section', 'article', 'dialog'])

/** Tags that are interactive without needing a role. */
const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label'])

/**
 * Whether an element is visible enough to be worth telling the agent about.
 *
 * Not `offsetParent`: a `position: fixed` header has none and is very much on
 * screen. This asks the two questions that actually matter — does it occupy
 * space, and has something been done to hide it.
 * @param element - the element.
 * @returns whether it renders.
 */
function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (style.opacity === '0') return false
  if (element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false
  return true
}

/**
 * The name a screen reader would give an element.
 *
 * The order is the accessible-name computation's, shortened to the parts that
 * matter on real pages: an explicit label wins, then a real `<label>`, then a
 * placeholder or an alt, then the element's own text.
 * @param element - the element.
 * @returns its name, trimmed and capped.
 */
function accessibleName(element: Element): string {
  const aria = element.getAttribute('aria-label')
  if (aria !== null && aria.trim() !== '') return aria.trim().slice(0, 200)
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter((text) => text !== '')
    if (parts.length > 0) return parts.join(' ').slice(0, 200)
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement) {
    const labels = (element as HTMLInputElement).labels
    if (labels !== null && labels.length > 0) {
      const text = [...labels].map((label) => label.textContent?.trim() ?? '').join(' ').trim()
      if (text !== '') return text.slice(0, 200)
    }
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim().slice(0, 200)
  }
  const alt = element.getAttribute('alt')
  if (alt !== null && alt.trim() !== '') return alt.trim().slice(0, 200)
  const title = element.getAttribute('title')
  if (title !== null && title.trim() !== '') return title.trim().slice(0, 200)
  const text = (element as HTMLElement).innerText ?? element.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * The role to report, from the explicit one or from the tag.
 * @param element - the element.
 * @returns the role name.
 */
function roleOf(element: Element): string {
  const explicit = element.getAttribute('role')
  if (explicit !== null && explicit.trim() !== '') return explicit.trim()
  const tag = element.tagName.toLowerCase()
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic'
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    return 'textbox'
  }
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  if (tag === 'button') return 'button'
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'img') return 'image'
  return tag
}

/** One node in the snapshot the agent reads. */
interface SnapshotNode {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
  href?: string
  checked?: boolean
  disabled?: boolean
  rect: { x: number, y: number, width: number, height: number }
  children: SnapshotNode[]
}

/**
 * Walk the page the way a screen reader would, naming everything actionable.
 *
 * This is the DOM mode, and it is the one an agent should reach for first: it
 * is exact where a screenshot is approximate, it is small where the HTML is
 * enormous, and every node in it carries a `ref` that the click and type tools
 * accept. A page of forty kilobytes of markup is usually a snapshot of a few
 * dozen lines.
 *
 * Refs are handed out fresh on every snapshot and the map is cleared with
 * them. That is deliberate: a ref that survived a re-render would point at an
 * element the page has since replaced, and clicking it would do nothing while
 * looking as though it had worked.
 * @param options - whether to include every element or only the interactive ones.
 * @returns the tree.
 */
function snapshot(options: { all?: boolean } = {}): SnapshotNode | null {
  referenced.clear()
  refCounter = 0
  const wanted = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase()
    if (INTERACTIVE.has(tag) || LANDMARKS.has(tag)) return true
    if (element.hasAttribute('role') || element.hasAttribute('aria-label')) return true
    if (/^h[1-6]$/.test(tag)) return true
    if (tag === 'img' && element.hasAttribute('alt')) return true
    if ((element as HTMLElement).isContentEditable) return true
    if (element.hasAttribute('onclick') || element.getAttribute('tabindex') !== null) return true
    return false
  }

  const build = (element: Element): SnapshotNode | null => {
    if (!visible(element)) return null
    const children: SnapshotNode[] = []
    for (const child of element.children) {
      const built = build(child)
      if (built !== null) children.push(built)
    }
    const keep = options.all === true || wanted(element)
    if (!keep) {
      // A wrapper that holds one interesting thing should not add a level; a
      // wrapper that holds several is the only place their grouping is
      // recorded, so it stays.
      if (children.length === 1) return children[0] ?? null
      if (children.length === 0) {
        const own = (element as HTMLElement).innerText?.trim() ?? ''
        if (own === '' || element.children.length > 0) return null
      } else return { ...blank(element), children }
    }
    const ref = `e${String(++refCounter)}`
    referenced.set(ref, element)
    const rect = element.getBoundingClientRect()
    const node: SnapshotNode = {
      ref,
      role: roleOf(element),
      name: accessibleName(element),
      tag: element.tagName.toLowerCase(),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      },
      children,
    }
    if (element instanceof HTMLAnchorElement && element.href !== '') node.href = element.href
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox' || element.type === 'radio') node.checked = element.checked
      else node.value = element.value.slice(0, 200)
      if (element.disabled) node.disabled = true
    }
    if (element instanceof HTMLTextAreaElement) node.value = element.value.slice(0, 200)
    if (element instanceof HTMLSelectElement) node.value = element.value
    return node
  }

  const blank = (element: Element): SnapshotNode => {
    const rect = element.getBoundingClientRect()
    return {
      ref: '',
      role: 'group',
      name: '',
      tag: element.tagName.toLowerCase(),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      },
      children: [],
    }
  }

  return build(document.body)
}

/**
 * Find the element a command names, by ref or by selector.
 * @param target - `{ ref }` or `{ selector }`.
 * @returns the element.
 */
function resolve(target: { ref?: string, selector?: string }): Element {
  if (target.ref !== undefined && target.ref !== '') {
    const element = referenced.get(target.ref)
    if (element === undefined) {
      throw new Error(`no element ${target.ref} — refs come from the most recent browser_snapshot and are `
        + 'replaced by the next one. Take a fresh snapshot.')
    }
    if (!element.isConnected) {
      throw new Error(`${target.ref} is no longer in the page — it was replaced after the snapshot. Take a fresh one.`)
    }
    return element
  }
  if (target.selector !== undefined && target.selector !== '') {
    const element = document.querySelector(target.selector)
    if (element === null) throw new Error(`no element matches ${target.selector}`)
    return element
  }
  throw new Error('expected a ref or a selector')
}

/**
 * Click an element the way a person would.
 *
 * The full pointer sequence, not just `element.click()`: sites listen for
 * `pointerdown` and `mousedown` at least as often as for `click`, and a menu
 * that opens on `mousedown` never opens for a bare `click()`.
 * @param element - what to click.
 * @param options - which button, and how many times.
 */
function clickElement(element: Element, options: { button?: number, count?: number } = {}): void {
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  const button = options.button ?? 0
  const shared = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons: 1,
  }
  if (element instanceof HTMLElement) element.focus()
  for (let index = 0; index < (options.count ?? 1); index += 1) {
    element.dispatchEvent(new PointerEvent('pointerdown', { ...shared, pointerType: 'mouse', isPrimary: true }))
    element.dispatchEvent(new MouseEvent('mousedown', shared))
    element.dispatchEvent(new PointerEvent('pointerup', { ...shared, buttons: 0, pointerType: 'mouse', isPrimary: true }))
    element.dispatchEvent(new MouseEvent('mouseup', { ...shared, buttons: 0 }))
    element.dispatchEvent(new MouseEvent('click', { ...shared, buttons: 0, detail: index + 1 }))
  }
}

/**
 * Put text into a field, firing what a real typist fires.
 *
 * The value is set through the native setter rather than by assignment,
 * because React and every framework that copies it install their own `value`
 * property on the element — assigning to that one updates the DOM and leaves
 * the framework's state untouched, which is the classic "the box shows my text
 * and the form submits empty" failure.
 * @param element - the field.
 * @param text - what to type.
 * @param options - whether to replace what is there.
 */
function typeInto(element: Element, text: string, options: { replace?: boolean } = {}): void {
  if (element instanceof HTMLElement) element.focus()
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    const next = options.replace === false ? element.value + text : text
    if (setter === undefined) element.value = next
    else setter.call(element, next)
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  if ((element as HTMLElement).isContentEditable) {
    if (options.replace === false) (element as HTMLElement).innerText += text
    else (element as HTMLElement).innerText = text
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }))
    return
  }
  throw new Error(`${element.tagName.toLowerCase()} is not a field that accepts typing`)
}

/** Keys whose `key` and `code` differ enough to be worth spelling out. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
}

/**
 * Press one key at whatever has focus.
 * @param key - the key name, as `KeyboardEvent.key` spells it.
 * @param modifiers - which modifiers are held.
 */
function pressKey(key: string, modifiers: string[] = []): void {
  const target = document.activeElement ?? document.body
  const held = new Set(modifiers.map((name) => name.toLowerCase()))
  const options: KeyboardEventInit = {
    key,
    code: KEY_CODES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: held.has('control') || held.has('ctrl'),
    shiftKey: held.has('shift'),
    altKey: held.has('alt'),
    metaKey: held.has('meta') || held.has('cmd'),
  }
  const down = new KeyboardEvent('keydown', options)
  target.dispatchEvent(down)
  if (!down.defaultPrevented && key.length === 1
    && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    typeInto(target, key, { replace: false })
  }
  target.dispatchEvent(new KeyboardEvent('keyup', options))
  // Enter in a field submits the form it is in, which is what a person
  // pressing it expects and what no synthetic keydown does on its own.
  if (key === 'Enter' && !down.defaultPrevented
    && (target instanceof HTMLInputElement) && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
}

// ---------------------------------------------------------------------------
// what the agent sees: the visual mode
// ---------------------------------------------------------------------------

/**
 * Draw the page into a canvas and read the pixels back.
 *
 * The technique is the standard one — serialise the DOM into an SVG
 * `foreignObject` and let the browser's own layout engine draw it — and it
 * works here only because of a fact measured before any of this was written:
 * a canvas in an opaque origin is tainted by a `blob:` URL and *not* by a
 * `data:` URL. That is the entire reason `src/browser/net.ts` inlines
 * subresources as `data:` URLs rather than the more obvious `blob:`. With
 * `blob:`, `toDataURL` throws `SecurityError` on any page carrying an image.
 *
 * What it cannot draw: the contents of a `<canvas>` the page painted (copied
 * where the browser allows it), a nested frame, a plugin, and anything a
 * pseudo-element rule places. Scroll position is honoured by shifting the
 * document under the viewport, which is what makes a screenshot show what is
 * on screen rather than the top of the page.
 * @param options - the region to take, in CSS pixels.
 * @returns the PNG as a data URL, with the size it was drawn at.
 */
async function rasterise(
  options: { fullPage?: boolean } = {},
): Promise<{ dataUrl: string, width: number, height: number, scrollX: number, scrollY: number }> {
  const full = options.fullPage === true
  const width = Math.max(1, Math.min(full ? document.documentElement.scrollWidth : window.innerWidth, 4096))
  const height = Math.max(1, Math.min(full ? document.documentElement.scrollHeight : window.innerHeight, 8192))

  const clone = document.documentElement.cloneNode(true) as HTMLElement
  for (const script of [...clone.querySelectorAll('script,noscript')]) script.remove()

  // Form state lives in properties, not attributes, so a clone of a filled-in
  // form is an empty one unless the values are written across by hand.
  const originals = [...document.querySelectorAll('input,textarea,select,canvas')]
  const copies = [...clone.querySelectorAll('input,textarea,select,canvas')]
  for (let index = 0; index < originals.length; index += 1) {
    const from = originals[index]
    const to = copies[index]
    if (from === undefined || to === undefined) continue
    if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
      to.setAttribute('value', from.value)
      if (from.checked) to.setAttribute('checked', 'checked')
    } else if (from instanceof HTMLTextAreaElement) to.textContent = from.value
    else if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
      for (const option of [...to.querySelectorAll('option')]) {
        if (option.getAttribute('value') === from.value) option.setAttribute('selected', 'selected')
      }
    } else if (from instanceof HTMLCanvasElement) {
      // A canvas the page drew is pixels the serialiser cannot see. Copying it
      // across as an image works whenever the page's own canvas is untainted,
      // which is the common case here because every image is a `data:` URL.
      try {
        const image = document.createElement('img')
        image.setAttribute('src', from.toDataURL())
        image.setAttribute('width', String(from.width))
        image.setAttribute('height', String(from.height))
        to.replaceWith(image)
      } catch {
        // Tainted: leave the empty canvas rather than failing the screenshot.
      }
    }
  }

  if (!full) {
    // Shift the document under a viewport-sized window, so what is drawn is
    // what is on screen.
    clone.style.marginLeft = `${String(-window.scrollX)}px`
    clone.style.marginTop = `${String(-window.scrollY)}px`
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')

  const serialised = new XMLSerializer().serializeToString(clone)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">`
    + `<foreignObject x="0" y="0" width="100%" height="100%">${serialised}</foreignObject></svg>`
  const image = new Image()
  image.width = width
  image.height = height
  await new Promise<void>((resolve, reject) => {
    image.onload = () => { resolve() }
    image.onerror = () => { reject(new Error('the page could not be drawn — its markup did not survive serialisation')) }
    // `data:`, never `blob:`. See this function's note.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('no 2d canvas context in this frame')
  context.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width,
    height,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Make a value from the page safe to send over the channel.
 *
 * `postMessage` uses structured clone, which throws on a function, a DOM node
 * or anything holding one — and a thrown clone in the middle of a reply looks
 * to the agent exactly like a hung tool. So everything is reduced to
 * JSON-shaped data first, with depth and breadth capped.
 * @param value - whatever the page produced.
 * @param depth - how far down this call is.
 * @returns something structured-cloneable.
 */
function portable(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'undefined') return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[Function ${value.name === '' ? 'anonymous' : value.name}]`
  if (typeof value === 'symbol') return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id === '' ? '' : ` id="${value.id}"`}>`
  }
  if (value instanceof Node) return `[${value.nodeName}]`
  if (depth > 4) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => portable(entry, depth + 1))
  if (value instanceof Date) return value.toISOString()
  const entries: Record<string, unknown> = {}
  let count = 0
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (count++ > 100) break
    try {
      entries[key] = portable((value as Record<string, unknown>)[key], depth + 1)
    } catch {
      entries[key] = '[unreadable]'
    }
  }
  return entries
}

/** How long a `waitFor` may wait before it reports that nothing happened. */
const DEFAULT_WAIT_MS = 10_000

/**
 * Run one command from the page and produce its result.
 * @param kind - which command.
 * @param payload - its arguments.
 * @returns the result, which must be structured-cloneable.
 */
async function command(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
    case 'snapshot':
      return {
        url: current.href,
        title: document.title,
        tree: snapshot({ all: payload.all === true }),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      }
    case 'text': {
      const root = payload.selector === undefined || payload.selector === ''
        ? document.body
        : document.querySelector(String(payload.selector))
      if (root === null) throw new Error(`no element matches ${String(payload.selector)}`)
      return { text: (root as HTMLElement).innerText ?? root.textContent ?? '', url: current.href, title: document.title }
    }
    case 'html': {
      const root = payload.selector === undefined || payload.selector === ''
        ? document.documentElement
        : document.querySelector(String(payload.selector))
      if (root === null) throw new Error(`no element matches ${String(payload.selector)}`)
      return { html: root.outerHTML }
    }
    case 'click':
      clickElement(resolve(payload as { ref?: string, selector?: string }), {
        ...(typeof payload.button === 'number' ? { button: payload.button } : {}),
        ...(typeof payload.count === 'number' ? { count: payload.count } : {}),
      })
      return { ok: true }
    case 'clickAt': {
      const x = Number(payload.x)
      const y = Number(payload.y)
      const element = document.elementFromPoint(x, y)
      if (element === null) throw new Error(`nothing is at (${String(x)}, ${String(y)}) in the viewport`)
      clickElement(element)
      return { ok: true, tag: element.tagName.toLowerCase(), name: accessibleName(element) }
    }
    case 'type':
      typeInto(resolve(payload as { ref?: string, selector?: string }), String(payload.text ?? ''), {
        replace: payload.replace !== false,
      })
      if (payload.enter === true) pressKey('Enter')
      return { ok: true }
    case 'select': {
      const element = resolve(payload as { ref?: string, selector?: string })
      if (!(element instanceof HTMLSelectElement)) throw new Error('that element is not a <select>')
      const wanted = String(payload.value ?? '')
      const option = [...element.options].find((entry) => entry.value === wanted || entry.text === wanted)
      if (option === undefined) {
        throw new Error(`no option "${wanted}"; it has ${[...element.options].map((entry) => entry.value).join(', ')}`)
      }
      element.value = option.value
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: option.value }
    }
    case 'key':
      pressKey(String(payload.key ?? ''), (payload.modifiers as string[] | undefined) ?? [])
      return { ok: true }
    case 'scroll': {
      if (payload.ref !== undefined || payload.selector !== undefined) {
        resolve(payload as { ref?: string, selector?: string }).scrollIntoView({ block: 'center' })
      } else window.scrollTo({ left: Number(payload.x ?? window.scrollX), top: Number(payload.y ?? window.scrollY) })
      await new Promise((resolve_) => setTimeout(resolve_, 50))
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    }
    case 'evaluate': {
      const source = String(payload.source ?? '')
      // Indirect eval, so the expression sees the page's globals rather than
      // this bundle's locals — the console mode is supposed to be the page's
      // console, not a window onto the shim layer.
      const result: unknown = await (0, eval)(`(async () => { ${/\breturn\b/.test(source) ? source : `return (${source})`} })()`)
      return { value: portable(result) }
    }
    case 'screenshot':
      return rasterise({ fullPage: payload.fullPage === true })
    case 'console':
      return { entries: consoleLog.slice(-Number(payload.limit ?? 100)) }
    case 'cookies':
      return { cookie: cookieText }
    case 'storage': {
      const area = payload.area === 'session' ? window.sessionStorage : window.localStorage
      const entries: Record<string, string> = {}
      for (let index = 0; index < area.length; index += 1) {
        const key = area.key(index)
        if (key !== null) entries[key] = area.getItem(key) ?? ''
      }
      return { entries }
    }
    case 'waitFor': {
      const deadline = Date.now() + Number(payload.timeoutMs ?? DEFAULT_WAIT_MS)
      const selector = payload.selector === undefined ? undefined : String(payload.selector)
      const text = payload.text === undefined ? undefined : String(payload.text)
      for (;;) {
        if (selector !== undefined) {
          const found = document.querySelector(selector)
          if (found !== null && visible(found)) return { found: true, waitedMs: 0 }
        }
        if (text !== undefined && (document.body.innerText ?? '').includes(text)) return { found: true, waitedMs: 0 }
        if (selector === undefined && text === undefined) {
          // No condition: settle for the document being ready and quiet.
          if (document.readyState === 'complete') return { found: true, waitedMs: 0 }
        }
        if (Date.now() > deadline) {
          return {
            found: false,
            waitedMs: Number(payload.timeoutMs ?? DEFAULT_WAIT_MS),
            title: document.title,
            url: current.href,
          }
        }
        await new Promise((resolve_) => setTimeout(resolve_, 100))
      }
    }
    default:
      throw new Error(`unknown command ${kind}`)
  }
}

// ---------------------------------------------------------------------------
// the channel
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as Record<string, unknown> | undefined
  if (message === undefined || message.wb !== true || message.nonce !== init.nonce) return

  if (message.type === 'reply') {
    const waiting = pending.get(String(message.id))
    if (waiting === undefined) return
    pending.delete(String(message.id))
    if (message.error === undefined) waiting.resolve(message.value)
    else waiting.reject(new Error(String(message.error)))
    return
  }

  if (message.type === 'command') {
    const id = String(message.id)
    void (async () => {
      try {
        const value = await command(String(message.kind), (message.payload as Record<string, unknown> | undefined) ?? {})
        send({ type: 'result', id, value })
      } catch (error) {
        send({ type: 'result', id, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  if (message.type === 'cookieUpdate') {
    cookieText = String(message.value)
  }
})

// Anything queued before the channel existed, and then the announcement that
// this frame is live. The page waits for this before it runs a command: a
// command sent to a frame whose bundle has not evaluated is one that vanishes.
for (const queued of outbox.splice(0)) {
  try {
    parent.postMessage(queued, '*')
  } catch { /* the page has gone */ }
}

const announce = (): void => {
  send({
    type: 'ready',
    url: current.href,
    title: document.title,
    readyState: document.readyState,
  })
}
announce()
if (document.readyState !== 'complete') window.addEventListener('load', announce)
document.addEventListener('DOMContentLoaded', announce)

// A page that changes its title after loading should change the tab's.
new MutationObserver(() => { send({ type: 'title', title: document.title }) })
  .observe(document.head === null ? document.documentElement : document.head, { subtree: true, childList: true })

export {}
