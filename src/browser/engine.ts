/**
 * The browser machine itself: its tabs, and the isolation each one lives in.
 *
 * A tab here is what a tab is in a real browser — a browsing context with its
 * own document, its own history, its own console and its own scroll position,
 * sharing a profile with every other tab. What is different is where the
 * boundary is drawn. In a real browser the tab is isolated from the rest of
 * the browser by process boundaries the operating system enforces. Here it is
 * isolated by an opaque origin, which the *browser* enforces, and that turns
 * out to be a stronger guarantee than the obvious alternatives:
 *
 * - A cross-origin `<iframe>` pointed at the real site cannot work at all.
 *   This page is cross-origin isolated — `src/net/service-worker.ts` sets
 *   `Cross-Origin-Embedder-Policy: require-corp` so the emulated PC can have
 *   `SharedArrayBuffer` — so a third-party document is refused before
 *   `X-Frame-Options` even gets a say.
 * - A same-origin proxy under the service worker, which is how every web proxy
 *   on the internet works, would put a stranger's JavaScript in this page's
 *   own origin. It would be able to read the harness's IndexedDB, its
 *   `localStorage`, and the API keys in them. The README promises that keys
 *   stay yours; that design would quietly break the promise.
 * - A sandboxed frame *with* `allow-same-origin` is the same thing wearing a
 *   sandbox attribute.
 *
 * So the frame is sandboxed *without* `allow-same-origin`, which gives it an
 * opaque origin, and the cost of that choice is the whole shape of this
 * module. Measured, before any of it was written: a document in an opaque
 * origin is not controlled by a service worker, cannot fetch anything
 * cross-origin, and gets `SecurityError` from `localStorage`,
 * `sessionStorage`, `document.cookie` and `indexedDB`. It has no network and
 * no storage.
 *
 * Which is exactly what makes it safe, and exactly what this module has to
 * make up for. Every byte a tab sees was fetched here (`src/browser/net.ts`),
 * rewritten here (`src/browser/rewrite.ts`), and handed over as a document
 * with a runtime bolted to the front of it (`src/browser/frame.ts`). Every
 * cookie and every key it stores comes back here to be written down
 * (`src/browser/profile.ts`). The frame is a renderer; this is the rest of the
 * browser.
 *
 * ## Why the tabs are always laid out
 *
 * The frames live in a host element that is positioned off the left edge of
 * the window rather than hidden with `display: none`. A hidden frame has no
 * layout: every element in it reports a zero-sized rectangle, `elementFromPoint`
 * finds nothing, and a screenshot of it is blank. Since the agent drives tabs
 * whether or not a human has the panel open — usually not — every tab has to
 * be laid out all the time, and off-screen is the only way to have that
 * without showing it.
 */

import { BrowserProfile } from './profile.ts'
import { BrowserNetworkError, ResourceCache, base64, load } from './net.ts'
import {
  RUNTIME_GLOBAL, decodeDocument, injectRuntime, moduleUrl, rewriteDocument, type RewriteContext,
} from './rewrite.ts'
import { BROWSER_FRAME } from '../generated/browser-frame.ts'

/** The viewport every tab gets, in CSS pixels. */
export const VIEWPORT = { width: 1280, height: 800 }

/** The most tabs one machine will hold open. */
const MAX_TABS = 12

/** How long a document may take to fetch, rewrite and report itself ready. */
const NAVIGATION_TIMEOUT_MS = 60_000

/** How long a command addressed to a nested frame waits for that frame to arrive. */
const FRAME_READY_TIMEOUT_MS = 10_000

/** How long one driver command may run inside the frame. */
const COMMAND_TIMEOUT_MS = 30_000

/**
 * What this machine tells sites it is.
 *
 * The real one, unchanged. A machine that lied about its engine would be
 * handed markup its shims cannot run — a site that believes it is talking to
 * an old browser ships a different bundle — and the agent would be debugging a
 * page nobody else sees.
 */
const USER_AGENT = typeof navigator === 'undefined' ? 'webdsh' : navigator.userAgent

/** One entry in a tab's history. */
interface HistoryEntry {
  url: string
  title: string
}

/** A console line or page error, as the tab recorded it. */
export interface ConsoleEntry {
  level: string
  text: string
  at: number
}

/** One request a page made, for the network log. */
export interface RequestEntry {
  url: string
  method: string
  status: number
  at: number
  error?: string
}

/**
 * One thing a page did that somebody may be waiting for.
 *
 * The vocabulary is a browser's rather than this machine's, because what waits
 * on these is code written against a browser: a popup is a `page`, a modal is
 * a `dialog`, and a link with a `download` attribute is a `download` even
 * though nothing here writes to a downloads folder.
 */
export interface MachineEvent {
  kind: 'page' | 'close' | 'navigated' | 'load' | 'console' | 'dialog' | 'download' | 'filechooser' | 'request'
  /** Which tab it happened in. */
  tab: string
  at: number
  url?: string
  title?: string
  /** The tab that opened this one, for a popup. */
  opener?: string
  /** A console line, or a dialog's message. */
  text?: string
  level?: string
  /** What a dialog was answered with, since nobody was there to answer it. */
  answer?: string
  /** A dialog's kind: alert, confirm, prompt or print. */
  dialog?: string
  /** A download's suggested name, and the file chooser's handle. */
  suggestedFilename?: string
  chooser?: string
  multiple?: boolean
  accept?: string
  /** A request's outcome, for the network log. */
  status?: number
  method?: string
  error?: string
  /** Which nested frame it came from, when it was not the top document. */
  frame?: string
}

/** One modal a page raised, and the answer the policy had ready for it. */
export interface DialogEntry {
  kind: string
  message: string
  /** What the page was told, since nobody was there to answer it. */
  answer: string
  at: number
}

/** What a tab looks like from outside. */
export interface TabInfo {
  id: string
  url: string
  title: string
  active: boolean
  loading: boolean
  /** What the last navigation answered, which an HTML error page hides. */
  status: number
  /** What went wrong with the last navigation, if anything. */
  error?: string
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * Randomness good enough to name a tab, a task or a realm, and to authenticate
 * their messages.
 * @param size - how many bytes of it.
 * @returns the token, as hex.
 */
export function token(size = 16): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether a window is somewhere *inside* another, without being it.
 *
 * `parent` is readable across an opaque origin — identity is all that survives
 * the boundary, and identity is exactly what this asks about. It is what
 * separates "a nested frame announcing itself" from "the page around it
 * announcing itself as one of its children": a browsed document holds its
 * frames' `srcdoc` in its own DOM, nonce and all, so a nonce alone proves
 * nothing about who is speaking.
 * @param source - the window that sent a message.
 * @param root - the tab's own document.
 * @returns whether `source` is a strict descendant of `root`.
 */
function insideFrameTree(source: Window, root: Window): boolean {
  let current: Window = source
  // MAX_FRAME_DEPTH is 1, so one hop is the whole of it; the bound is only so
  // a cycle in somebody else's frame tree cannot spin here.
  for (let hops = 0; hops < 8; hops += 1) {
    const parent: Window = current.parent
    if (parent === current) return false
    if (parent === root) return true
    current = parent
  }
  return false
}

/** Escape text for a document this module builds itself. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] ?? character
  ))
}

/**
 * The runtime, in the tag it is injected in.
 *
 * Built once rather than per document: every nested frame carries its own copy
 * of the preamble, so a page with six iframes would otherwise concatenate this
 * 57 kB constant six more times on every render.
 */
const FRAME_SCRIPT = `<script>${BROWSER_FRAME}</script>`

/** One tab: a frame, a history, and everything that frame has said. */
class Tab {
  readonly id = token()
  readonly nonce = token()
  readonly frame: HTMLIFrameElement
  readonly container: HTMLDivElement

  url = 'about:blank'
  title = 'New tab'
  loading = false
  error: string | undefined

  /**
   * What the last navigation answered.
   *
   * Kept because it is the only place it survives: `#render` sets `error` for
   * an HTTP failure it has no document for, but an HTML error page renders
   * like any other page — so a tab showing a 404 was indistinguishable from
   * one showing what was asked for, and `page.goto()` reported `200`.
   */
  status = 200

  /**
   * `sessionStorage`, which belongs to the tab and dies with it.
   *
   * Per origin, not per tab. A tab holds documents from more than one site —
   * every nested frame is somebody else's — and `sessionStorage` is
   * origin-partitioned in a real browser for the reason the profile's cookies
   * and `localStorage` are here: one map for the whole tab handed a
   * third-party advert the page's session keys in its own `__WB_INIT__`, and
   * let it write over them.
   */
  readonly session = new Map<string, Map<string, string>>()

  /**
   * This tab's session store for one origin, made on first use.
   * @param origin - the writing document's origin.
   * @returns the store.
   */
  sessionFor(origin: string): Map<string, string> {
    const held = this.session.get(origin) ?? new Map<string, string>()
    this.session.set(origin, held)
    return held
  }
  readonly console: ConsoleEntry[] = []
  readonly requests: RequestEntry[] = []
  /**
   * The modals this tab raised, and what each was told.
   *
   * `answer` as well as `kind` and `message`, because the answer is the whole
   * question anyone asks of this log: the policy decides it before the modal
   * exists, so "was the confirm accepted" is not something a later look at the
   * page can always settle. The skill's recipes say `browser_console` shows
   * it, and while this held three fields it did not.
   */
  readonly dialogs: DialogEntry[] = []

  history: HistoryEntry[] = []
  index = -1

  /** Resolves when the frame's runtime has announced itself. */
  ready: Promise<void> = Promise.resolve()
  #announce: (() => void) | undefined

  /** Driver commands waiting on the frame. */
  readonly waiting = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  /**
   * The runtimes of the frames inside this tab's document, by token.
   *
   * A window rather than an element, because an element is all the tab's own
   * document has and this page cannot read that document. The window arrives
   * as `event.source` on the frame's first message, which is the one handle to
   * it that crossing an opaque origin leaves intact.
   */
  readonly frames = new Map<string, { window: Window, url: string, at: number, loaded: boolean }>()

  /**
   * The URL this machine actually fetched for each frame token.
   *
   * Not the one the frame reports: a document's cookies and its `localStorage`
   * are filed by origin, and a frame that could name its own origin could name
   * anybody's — a third-party advert writing `bank.example`'s session cookie
   * into the shared profile, to be handed to the real `bank.example` the next
   * time one is opened. The engine did the fetch, so the engine knows.
   */
  readonly frameUrls = new Map<string, string>()

  /**
   * Which document each nonce belongs to, keyed by the nonce.
   *
   * A nested frame is content from another site, and its own scripts can read
   * the `__WB_INIT__` this machine injects into it — so a nonce shared with it
   * is a nonce the site has. While every document in a tab carried the same
   * one, a frame (or the page itself) could announce itself under *any* frame
   * token and take over the routing for a sibling it was never allowed to
   * touch. Each document gets its own instead, and the nonce is what says
   * which document a message came from.
   */
  readonly frameNonces = new Map<string, string>()

  /**
   * The nonce a nested frame's document is given, minted once per token.
   * @param frame - the frame's token.
   * @returns the nonce that identifies that document to this tab.
   */
  nonceFor(frame: string): string {
    for (const [nonce, held] of this.frameNonces) if (held === frame) return nonce
    const minted = token()
    this.frameNonces.set(minted, frame)
    return minted
  }

  /**
   * Forget every frame this tab had, because it is about to have a new document.
   *
   * The nonces go with them. A nonce outliving the document it was minted for
   * is a credential for a frame that no longer exists — and a bound on the map
   * rather than a clear was worse than either: past the cap it evicted the
   * oldest entry whether or not that frame was still live, silently dropping
   * every message from it and answering every command to it with the wrong
   * nonce. Tokens only ever count up, so nothing here is ever re-minted.
   */
  forgetFrames(): void {
    this.frames.clear()
    this.frameNonces.clear()
    this.frameUrls.clear()
  }

  /** Whoever opened this tab, when something did. */
  opener: string | undefined

  constructor() {
    this.container = document.createElement('div')
    this.container.style.cssText = `width:${String(VIEWPORT.width)}px;height:${String(VIEWPORT.height)}px;`
      + 'border:0;overflow:hidden;background:#fff;'
    this.frame = document.createElement('iframe')
    // The isolation, in one attribute. `allow-same-origin` is deliberately
    // absent and must stay absent: adding it would give a browsed page this
    // page's own origin, and with it the harness's storage and keys.
    this.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock')
    this.frame.setAttribute('referrerpolicy', 'no-referrer')
    this.frame.style.cssText = `width:${String(VIEWPORT.width)}px;height:${String(VIEWPORT.height)}px;border:0;display:block;`
    this.container.append(this.frame)
  }

  /** Whether the document now in this tab has already said it was there. */
  #announced = false

  /** Arm the promise that the next document's runtime will resolve. */
  expectReady(): void {
    this.#announced = false
    this.ready = new Promise<void>((resolve) => { this.#announce = resolve })
  }

  /**
   * Note that the document has announced itself, and say whether it is the
   * first time for this document.
   * @returns true only for the first announcement after {@link expectReady}.
   */
  announce(): boolean {
    if (this.#announced) return false
    this.#announced = true
    return true
  }

  /** The frame's runtime has announced itself. */
  markReady(): void {
    this.#announce?.()
    this.#announce = undefined
  }

  /** Note one console line, keeping the log bounded. */
  log(entry: ConsoleEntry): void {
    this.console.push(entry)
    if (this.console.length > 500) this.console.splice(0, this.console.length - 500)
  }

  /** Note one request, keeping the log bounded. */
  note(entry: RequestEntry): void {
    this.requests.push(entry)
    if (this.requests.length > 300) this.requests.splice(0, this.requests.length - 300)
  }

  /** What this tab looks like from outside. */
  info(active: boolean): TabInfo {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      active,
      loading: this.loading,
      status: this.status,
      ...(this.error === undefined ? {} : { error: this.error }),
      canGoBack: this.index > 0,
      canGoForward: this.index >= 0 && this.index < this.history.length - 1,
    }
  }
}

/** The one browser machine this session has. */
export class BrowserMachine {
  readonly profile = new BrowserProfile()
  readonly cache = new ResourceCache()
  readonly #tabs = new Map<string, Tab>()
  #order: string[] = []
  #active: string | undefined
  #host: HTMLDivElement | undefined
  #listening = false
  #opened = false
  /** Where the panel has asked the frames to be shown, when it has. */
  #screen: HTMLElement | undefined
  /** Told whenever a tab changes, so the panel can redraw. */
  readonly #watchers = new Set<() => void>()

  /**
   * Told about everything a page does that somebody might be waiting for.
   *
   * Separate from the watchers, which are about redrawing: a panel wants to
   * know that *something* changed, and a task space waiting on a popup wants
   * to know exactly what happened and in what order. Merging the two would
   * make every redraw a wake-up for every waiter.
   */
  readonly #listeners = new Set<(event: MachineEvent) => void>()

  /**
   * This run of the machine.
   *
   * Task spaces are held in this page's memory, and so are their pages. A
   * reload is therefore not a restart, it is a different machine that happens
   * to share a profile — so a task handle from before it names something that
   * no longer exists. The generation is what lets that be said clearly rather
   * than reported as a task that mysteriously has no pages.
   */
  readonly generation = `g-${token().slice(0, 8)}`

  /** Names the next nested frame; only has to be unique within a tab. */
  #frameCounter = 0

  /**
   * Start the machine: read the profile, put the frame host on the page.
   *
   * Called on first use rather than at composition time. A session that never
   * browses should not pay for an IndexedDB open and a frame host, and the
   * cost of being wrong is one await on the first tool call.
   */
  async open(): Promise<void> {
    if (this.#opened) return
    this.#opened = true
    await this.profile.open()
    if (!this.#listening) {
      window.addEventListener('message', (event) => { this.#receive(event) })
      this.#listening = true
    }
    if (this.#host === undefined && typeof document !== 'undefined') {
      const host = document.createElement('div')
      host.dataset.webdshBrowser = 'frames'
      // Off-screen rather than hidden: see this module's note on layout.
      host.style.cssText = 'position:fixed;left:-20000px;top:0;width:'
        + `${String(VIEWPORT.width)}px;height:${String(VIEWPORT.height)}px;overflow:hidden;`
        + 'pointer-events:none;opacity:1;z-index:-1;'
      document.body.append(host)
      this.#host = host
    }
  }

  /**
   * Watch for any change worth redrawing.
   * @param watcher - called after every change.
   * @returns a function that stops watching.
   */
  watch(watcher: () => void): () => void {
    this.#watchers.add(watcher)
    return () => { this.#watchers.delete(watcher) }
  }

  /** Tell the watchers something changed. */
  #changed(): void {
    for (const watcher of this.#watchers) {
      try {
        watcher()
      } catch {
        // A panel that throws while redrawing must not stop the machine.
      }
    }
  }

  /**
   * Watch everything the pages do.
   * @param listener - called with each event.
   * @returns a function that stops listening.
   */
  onEvent(listener: (event: MachineEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Tell the listeners about one thing a page did.
   * @param event - what happened.
   */
  emit(event: MachineEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A listener that throws must not stop the page it is listening to.
      }
    }
  }

  /** Every tab, in the order they were opened. */
  tabs(): TabInfo[] {
    return this.#order
      .map((id) => this.#tabs.get(id))
      .filter((tab): tab is Tab => tab !== undefined)
      .map((tab) => tab.info(tab.id === this.#active))
  }

  /** The tab commands act on when none is named. */
  activeTab(): Tab | undefined {
    return this.#active === undefined ? undefined : this.#tabs.get(this.#active)
  }

  /**
   * Find a tab by id, or the active one.
   * @param id - the tab's id, or undefined for the active tab.
   * @returns the tab.
   */
  #tab(id?: string): Tab {
    if (id === undefined || id === '') {
      const active = this.activeTab()
      if (active === undefined) throw new Error('no tab is open — open one with browser_navigate or browser_tabs')
      return active
    }
    const tab = this.#tabs.get(id)
    if (tab === undefined) {
      throw new Error(`no tab ${id}; open tabs are ${this.#order.join(', ')}`)
    }
    return tab
  }

  /**
   * Open a tab.
   * @param url - where to send it, or undefined for a blank one.
   * @returns the new tab's id.
   */
  async newTab(
    url?: string,
    options: { background?: boolean, opener?: string, created?: (id: string) => void } = {},
  ): Promise<string> {
    await this.open()
    if (this.#tabs.size >= MAX_TABS) {
      throw new Error(`this machine holds ${String(MAX_TABS)} tabs at once; close one first`)
    }
    const tab = new Tab()
    tab.opener = options.opener
    this.#tabs.set(tab.id, tab)
    this.#order.push(tab.id)
    ;(this.#screen ?? this.#host)?.append(tab.container)
    // A tab a task opened in the background stays where it was put: the user
    // may be watching this machine in the panel, and a script that opens six
    // pages should not take the view six times.
    if (options.background !== true || this.#active === undefined) this.#active = tab.id
    this.#showActive()
    // Before the event, not after the await below: a task that only learns the
    // id when `newTab` resolves has already missed the `page`, `navigated` and
    // `load` events for the tab it asked for — which is every waiter armed the
    // documented way, `Promise.all([context.waitForEvent('page'), …])`.
    options.created?.(tab.id)
    this.emit({ kind: 'page', tab: tab.id, at: Date.now(), ...(options.opener === undefined ? {} : { opener: options.opener }) })
    if (url !== undefined && url !== '') await this.navigate(url, tab.id)
    else {
      await this.#install(tab, '<!doctype html><html><head><title>New tab</title></head><body></body></html>', 'about:blank')
      this.#changed()
    }
    return tab.id
  }

  /**
   * Close a tab.
   * @param id - which one.
   */
  closeTab(id: string): void {
    const tab = this.#tab(id)
    this.emit({ kind: 'close', tab: tab.id, at: Date.now(), url: tab.url })
    tab.container.remove()
    this.#tabs.delete(tab.id)
    this.#order = this.#order.filter((held) => held !== tab.id)
    if (this.#active === tab.id) this.#active = this.#order[this.#order.length - 1]
    this.#showActive()
    this.#changed()
  }

  /**
   * Bring a tab to the front.
   * @param id - which one.
   */
  selectTab(id: string): void {
    const tab = this.#tab(id)
    this.#active = tab.id
    this.#showActive()
    this.#changed()
  }

  /** Show only the active tab, which is what "tabs" means visually. */
  #showActive(): void {
    for (const [id, tab] of this.#tabs) {
      // Visibility rather than display: a tab that is not on top is still a
      // live browsing context, still laid out, and still drivable — which is
      // what a background tab is.
      tab.container.style.position = id === this.#active ? 'static' : 'absolute'
      tab.container.style.visibility = id === this.#active ? 'visible' : 'hidden'
      tab.container.style.pointerEvents = id === this.#active ? 'auto' : 'none'
    }
  }

  /**
   * Put the tabs where a human can see them.
   *
   * The frames move rather than being copied: a second frame showing the same
   * page would be a second browsing context with its own scroll position and
   * its own scripts, and the agent and the human would be looking at two
   * different pages.
   * @param screen - where to put them, or undefined to take them back.
   * @returns a function that takes them back.
   */
  adoptScreen(screen: HTMLElement): () => void {
    this.#screen = screen
    for (const id of this.#order) {
      const tab = this.#tabs.get(id)
      if (tab !== undefined) screen.append(tab.container)
    }
    this.#showActive()
    return () => {
      this.#screen = undefined
      for (const id of this.#order) {
        const tab = this.#tabs.get(id)
        if (tab !== undefined) this.#host?.append(tab.container)
      }
      this.#showActive()
    }
  }

  /**
   * Go to a URL in a tab, opening one if the machine has none.
   * @param url - where to.
   * @param id - which tab, or undefined for the active one.
   * @param mode - whether this adds a history entry.
   * @returns what the tab looks like afterwards.
   */
  async navigate(url: string, id?: string, mode: 'push' | 'replace' = 'push'): Promise<TabInfo> {
    await this.open()
    if (this.#tabs.size === 0) {
      const created = await this.newTab()
      return this.navigate(url, created, mode)
    }
    const tab = this.#tab(id)
    const target = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`

    tab.loading = true
    tab.error = undefined
    tab.status = 0
    this.#changed()
    try {
      const resource = await load(target)
      tab.status = resource.status
      this.#note(tab, { url: resource.url, method: 'GET', status: resource.status, at: Date.now() })
      await this.#render(tab, resource.url, resource.type, resource.contentType, resource.bytes, resource.status)
      if (mode === 'replace' && tab.index >= 0) {
        tab.history[tab.index] = { url: tab.url, title: tab.title }
      } else {
        tab.history = tab.history.slice(0, tab.index + 1)
        tab.history.push({ url: tab.url, title: tab.title })
        tab.index = tab.history.length - 1
      }
    } catch (error) {
      const detail = error instanceof BrowserNetworkError || error instanceof Error
        ? error.message
        : String(error)
      tab.error = detail
      this.#note(tab, { url: target, method: 'GET', status: 0, at: Date.now(), error: detail })
      // Nothing survives a document being replaced, and this path does not go
      // through `#render`, which is the only other caller that retires them. A
      // nonce outliving its document is a credential for a frame that is gone.
      tab.forgetFrames()
      await this.#install(
        tab,
        `<!doctype html><html><head><title>Cannot load</title></head><body style="font:14px system-ui;padding:2rem">`
        + `<h1>This page could not be loaded</h1><p>${escapeHtml(target)}</p>`
        + `<pre style="white-space:pre-wrap;color:#a00">${escapeHtml(detail)}</pre></body></html>`,
        target,
      )
    } finally {
      tab.loading = false
      this.emit({
        kind: 'navigated', tab: tab.id, at: Date.now(), url: tab.url, title: tab.title,
        ...(tab.error === undefined ? {} : { error: tab.error }),
      })
      this.#changed()
    }
    return tab.info(tab.id === this.#active)
  }

  /**
   * Turn whatever came back into a document and install it.
   *
   * Not every URL is a web page. A JSON API, a plain-text file and an image
   * are all things an agent follows a link to, and a machine that could only
   * display HTML would report them as broken. Each gets a document that shows
   * what it actually is.
   * @param tab - the tab to render into.
   * @param url - the final URL.
   * @param type - the content type, without parameters.
   * @param contentType - the full header.
   * @param bytes - the body.
   * @param status - the HTTP status.
   */
  async #render(
    tab: Tab,
    url: string,
    type: string,
    contentType: string,
    bytes: Uint8Array,
    status: number,
  ): Promise<void> {
    // Ahead of the rewrite, which is what mints this document's frame tokens
    // and files their URLs. Doing it in `#install` instead would have thrown
    // away the entries the rewrite had just made.
    tab.forgetFrames()
    if (type.includes('html') || type === '') {
      const context: RewriteContext = this.#rewriteContext(tab)
      const rewritten = await rewriteDocument(decodeDocument(bytes, contentType), url, context)
      tab.title = rewritten.title === '' ? url : rewritten.title
      await this.#install(tab, rewritten.html, url)
      return
    }
    if (type.startsWith('image/')) {
      const body = `<body style="margin:0;display:grid;place-items:center;background:#111">`
        + `<img src="data:${contentType};base64,${base64(bytes)}" style="max-width:100%;max-height:100vh"></body>`
      tab.title = url.split('/').pop() ?? url
      await this.#install(tab, `<!doctype html><html><head><title>${escapeHtml(tab.title)}</title></head>${body}</html>`, url)
      return
    }
    const text = decodeDocument(bytes, contentType)
    const pretty = type.includes('json')
      ? (() => {
          try {
            return JSON.stringify(JSON.parse(text), null, 2)
          } catch {
            return text
          }
        })()
      : text
    tab.title = url.split('/').pop() ?? url
    await this.#install(
      tab,
      `<!doctype html><html><head><title>${escapeHtml(tab.title)}</title></head>`
      + `<body style="margin:0"><pre style="white-space:pre-wrap;word-break:break-word;font:13px ui-monospace,monospace;`
      + `padding:1rem;margin:0">${escapeHtml(pretty.slice(0, 2_000_000))}</pre></body></html>`,
      url,
    )
    if (status >= 400) tab.error = `HTTP ${String(status)}`
  }

  /**
   * Put a finished document into a tab's frame and wait for its runtime.
   *
   * The runtime goes in ahead of everything the site brought with it, because
   * a shim installed after the page's first inline script is a shim the page
   * has already got round. `<base>` goes ahead of *that*, so that relative
   * URLs resolve while the runtime is still evaluating.
   * @param tab - the tab.
   * @param html - the rewritten document.
   * @param url - what the document should believe its URL is.
   */
  async #install(tab: Tab, html: string, url: string): Promise<void> {
    // Here, and not earlier. Ahead of `expectReady()` because the announcement
    // that answers it emits the tab's `load` event and that reads the URL from
    // here — assigned afterwards, every `load` carried the *previous*
    // document's address. But no earlier than this either: fetching and
    // rewriting a document takes as long as its subresources do, the document
    // being replaced is live for all of it, and while `tab.url` already named
    // where the tab was *going*, every `document.cookie` and
    // `localStorage.setItem` a timer in the old page made was filed by
    // `#receive` against the destination's origin.
    tab.url = url
    tab.frames.clear()
    tab.expectReady()
    tab.frame.srcdoc = injectRuntime(html, this.#preamble(tab, url))
    await Promise.race([
      tab.ready,
      new Promise<void>((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS)),
    ])
  }

  /**
   * The runtime a document is given, as the script tags to inject.
   * @param tab - the tab the document belongs to.
   * @param url - what the document should believe its URL is.
   * @param frame - the nested frame's token, when the document is one.
   * @returns the script text.
   */
  #preamble(tab: Tab, url: string, frame?: string): string {
    // Noted before the document exists, because this is the one moment the
    // machine and the document agree about where it came from. See
    // {@link Tab.frameUrls}.
    if (frame !== undefined) tab.frameUrls.set(frame, url)
    let origin = 'null'
    try {
      origin = new URL(url).origin
    } catch {
      // `about:blank` and friends have no origin worth partitioning by.
    }
    const init = {
      // Each document its own, so that presenting a nonce is a claim only
      // about the document it was handed to. See {@link Tab.frameNonces}.
      nonce: frame === undefined ? tab.nonce : tab.nonceFor(frame),
      url,
      cookie: url.startsWith('http') ? this.profile.cookies.header(new URL(url)) : '',
      local: Object.fromEntries(origin === 'null' ? [] : this.profile.localStore(origin)),
      session: Object.fromEntries(origin === 'null' ? [] : tab.sessionFor(origin)),
      userAgent: USER_AGENT,
      // A nested frame has the tab's own document between it and the machine,
      // so it is two hops up rather than one. `MAX_FRAME_DEPTH` is 1, which is
      // what makes that a constant rather than a depth to carry around.
      ...(frame === undefined ? {} : { frame, hops: 2 }),
    }
    return `<script>window.__WB_INIT__=${JSON.stringify(init).replace(/</g, '\\u003c')}</script>`
      + FRAME_SCRIPT
  }

  /**
   * The context a document is rewritten in, including what its frames get.
   *
   * Nested frames are given the same runtime the tab's own document has, with
   * their own token. Without it a framed page is a rectangle nothing can look
   * inside: each frame is its own opaque origin, so neither this page nor the
   * document holding it can reach the DOM in there.
   * @param tab - the tab being rendered into.
   * @returns the rewrite context.
   */
  #rewriteContext(tab: Tab): RewriteContext {
    return {
      cache: this.cache,
      depth: 0,
      modules: new Map(),
      frameToken: () => `f${String(++this.#frameCounter)}`,
      frameRuntime: (url: string, token: string) => this.#preamble(tab, url, token),
    }
  }

  /**
   * Run one driver command inside a tab's frame.
   * @param kind - which command.
   * @param payload - its arguments.
   * @param id - which tab, or undefined for the active one.
   * @returns whatever the frame produced.
   */
  async run(
    kind: string,
    payload: Record<string, unknown> = {},
    id?: string,
    options: { frame?: string, timeoutMs?: number } = {},
  ): Promise<unknown> {
    await this.open()
    const tab = this.#tab(id)
    const limit = options.timeoutMs ?? COMMAND_TIMEOUT_MS
    // Bounded, like the command it precedes. `#install` deliberately carries on
    // past a document that never announces itself, which leaves `tab.ready`
    // pending for ever — and a second navigation rebinds the promise, so a wait
    // armed against the first can never settle either. Awaited bare, both left
    // every later command on that tab parked with no deadline at all, before
    // the timer below had been armed to say so.
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        tab.ready,
        new Promise<void>((resolve) => { readyTimer = setTimeout(resolve, limit) }),
      ])
    } finally {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
    }
    const wanted = options.frame === undefined || options.frame === '' ? undefined : options.frame
    const frame = wanted === undefined ? undefined : await this.#frameWindow(tab, wanted)
    const window_ = frame?.window ?? tab.frame.contentWindow
    if (window_ === null || window_ === undefined) throw new Error('that tab has no live frame')
    const commandId = token()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        tab.waiting.delete(commandId)
        reject(new Error(`the page did not answer ${kind} within `
          + `${String(Math.round(limit / 1000))}s — it may be busy in a script`))
      }, limit)
      tab.waiting.set(commandId, { resolve, reject, timer })
      // The nonce of the document being addressed, which for a nested frame is
      // its own: that is what its runtime checks incoming messages against.
      const secret = options.frame === undefined || options.frame === '' ? tab.nonce : tab.nonceFor(options.frame)
      window_.postMessage({ wb: true, nonce: secret, type: 'command', id: commandId, kind, payload }, '*')
    })
  }

  /**
   * The window of a nested frame, waited for if it is on its way.
   *
   * A frame's token is written by the rewriter, so a locator can resolve one
   * the moment the tab's own document is parsed — which is well before the
   * `<iframe srcdoc>` in its `<body>` has evaluated the runtime that announces
   * it. Failing straight away meant `await page.goto(url)` followed by
   * `page.frameLocator(...)` in the same body raced, and lost with a message
   * saying the page had replaced a frame it had not finished creating.
   *
   * The two cases are told apart by the nonce ledger: a token this document
   * minted is one that is coming, and a token it did not is one from a
   * document that is gone.
   * @param tab - the tab.
   * @param token - the frame's token.
   * @returns the frame's window.
   */
  async #frameWindow(tab: Tab, token: string): Promise<{ window: Window, url: string, at: number, loaded: boolean }> {
    const held = tab.frames.get(token)
    if (held !== undefined) return held
    const minted = [...tab.frameNonces.values()].includes(token)
    if (minted) {
      const deadline = Date.now() + FRAME_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        const arrived = tab.frames.get(token)
        if (arrived !== undefined) return arrived
      }
      throw new Error(`frame ${token} has not loaded: this machine fetched it, but nothing inside it has `
        + 'announced itself within '
        + `${String(Math.round(FRAME_READY_TIMEOUT_MS / 1000))}s. Its document may be empty or still fetching.`)
    }
    throw new Error(`frame ${token} is not in this tab any more — the page replaced it. `
      + 'Resolve the frame again from the current document.')
  }

  /**
   * Fetch a URL the way a page's own `fetch` would, through the same policy.
   *
   * What backs `context.request` in a task space, and the only way bytes reach
   * a task without a document being made out of them: a PDF behind a link, a
   * CSV an export button produces, the JSON an API answers. It is the machine's
   * own request rather than the page's, so it carries no cookies — the same
   * limit everything else here has.
   * @param url - where to.
   * @param init - method, headers and body.
   * @returns the response.
   */
  async fetch(url: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<{
    status: number
    url: string
    contentType: string
    bytes: Uint8Array
  }> {
    await this.open()
    const resource = await load(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    return { status: resource.status, url: resource.url, contentType: resource.contentType, bytes: resource.bytes }
  }

  /**
   * Go to a URL, in whichever document asked to go there.
   *
   * A link or a form inside a frame moves that frame, not the tab around it: a
   * page whose content is framed would otherwise lose its chrome on the first
   * click. Both ways in ask the same question, so they ask it in one place.
   * @param tab - the tab it happened in.
   * @param from - the frame that asked, or undefined for the tab's own document.
   * @param url - where to go.
   * @param mode - whether the tab's history gains an entry or replaces one.
   */
  #follow(tab: Tab, from: string | undefined, url: string, mode: 'push' | 'replace' = 'push'): void {
    if (from !== undefined) void this.#renderFrame(tab, from, url)
    else void this.navigate(url, tab.id, mode)
  }

  /**
   * Reload one nested frame, in place, without touching the tab around it.
   *
   * A link inside a frame navigates the frame — that is what a frame is — and
   * this page cannot set the `srcdoc` of an element it is not allowed to see.
   * So the document that holds the frame is asked to do it, which is a command
   * to the tab's own runtime, and the token is what identifies which of its
   * frames is meant.
   * @param tab - the tab.
   * @param frameToken - which frame.
   * @param url - where the frame is going.
   * @param init - method and body, for a form that posts.
   */
  async #renderFrame(
    tab: Tab,
    frameToken: string,
    url: string,
    init: { method?: string, body?: string, headers?: Record<string, string> } = {},
  ): Promise<void> {
    try {
      const resource = await load(url, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      this.#note(tab, { url: resource.url, method: init.method ?? 'GET', status: resource.status, at: Date.now() })
      if (!resource.type.includes('html') && resource.type !== '') return
      const rewritten = await rewriteDocument(
        decodeDocument(resource.bytes, resource.contentType),
        resource.url,
        { ...this.#rewriteContext(tab), depth: 1 },
      )
      tab.frames.delete(frameToken)
      await this.run('frame.load', {
        token: frameToken,
        html: injectRuntime(rewritten.html, this.#preamble(tab, resource.url, frameToken)),
      }, tab.id)
      this.emit({ kind: 'navigated', tab: tab.id, at: Date.now(), url: resource.url, frame: frameToken })
    } catch (error) {
      this.emit({
        kind: 'navigated', tab: tab.id, at: Date.now(), url, frame: frameToken,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Note one request against a tab, and tell whoever is listening.
   * @param tab - the tab.
   * @param entry - the request.
   */
  #note(tab: Tab, entry: RequestEntry): void {
    tab.note(entry)
    this.emit({
      kind: 'request',
      tab: tab.id,
      at: entry.at,
      url: entry.url,
      method: entry.method,
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    })
  }

  /**
   * Go back or forward in a tab's history.
   * @param delta - how far, negative for back.
   * @param id - which tab.
   * @returns the tab afterwards.
   */
  async go(delta: number, id?: string): Promise<TabInfo> {
    const tab = this.#tab(id)
    const next = tab.index + delta
    if (next < 0 || next >= tab.history.length) {
      throw new Error(delta < 0 ? 'nothing to go back to in this tab' : 'nothing to go forward to in this tab')
    }
    const entry = tab.history[next]
    if (entry === undefined) throw new Error('that history entry is gone')
    tab.index = next
    // Replace rather than push: moving through history must not add to it.
    const info = await this.navigate(entry.url, tab.id, 'replace')
    tab.index = next
    return info
  }

  /** Every cookie in the profile, for the tool that lists them. */
  cookies(): ReturnType<BrowserProfile['cookies']['all']> {
    return this.profile.cookies.all()
  }

  /**
   * One tab's recorded console, network and dialog activity.
   * @param id - which tab.
   * @returns the logs.
   */
  logs(id?: string): { console: ConsoleEntry[], requests: RequestEntry[], dialogs: DialogEntry[] } {
    const tab = this.#tab(id)
    return { console: [...tab.console], requests: [...tab.requests], dialogs: [...tab.dialogs] }
  }

  /**
   * Handle one message from a frame.
   *
   * Everything here is hostile input: it comes from a document that ran a
   * stranger's JavaScript. The two checks that matter are that the message
   * came from a frame this machine owns — `event.source` is compared against
   * the frame's own window, which a page cannot forge — and that it carries
   * that tab's nonce. The origin is not checked because it cannot be: an
   * opaque origin reports itself as `null`, and every one of them reports the
   * same thing.
   * @param event - the message.
   */
  #receive(event: MessageEvent): void {
    const message = event.data as Record<string, unknown> | undefined
    if (message === undefined || message.wb !== true || typeof message.nonce !== 'string') return
    const nonce = message.nonce
    const tab = [...this.#tabs.values()].find((held) => held.nonce === nonce || held.frameNonces.has(nonce))
    if (tab === undefined) return

    // Which document in the tab sent this — read off the nonce, never off the
    // message. A nonce is handed to exactly one document, so it says which one
    // is speaking; `message.frame` is whatever the sender chose to write, and
    // trusting that let any document in the tab seize a sibling's token.
    const from = tab.nonce === nonce ? undefined : tab.frameNonces.get(nonce)
    if (from === undefined) {
      if (event.source !== tab.frame.contentWindow) return
    } else if (message.type === 'ready') {
      const root = tab.frame.contentWindow
      // A nonce says which document a message is *about*; only the window says
      // which document is speaking. The page holding a frame can read that
      // frame's nonce straight out of the `srcdoc` attribute in its own DOM,
      // so without this it could claim the frame's slot and then forge every
      // `cookie`, `storage`, `navigate` and `submit` message from it.
      if (event.source === null || root === null) return
      if (!insideFrameTree(event.source as Window, root)) return
      // A token belongs to the first window that claims it, until the document
      // holding it is replaced — which goes through `#renderFrame`, and that
      // drops the entry first. `insideFrameTree` only proves the sender is
      // *somewhere* in this tab; the page holding a frame can read that frame's
      // nonce straight out of the `srcdoc` attribute in its own DOM and
      // announce from a child of its own, so without this it could take over a
      // live sibling's slot and have its `cookie` and `storage` writes filed
      // against that frame's origin.
      const bound = tab.frames.get(from)
      if (bound !== undefined && bound.window !== event.source) return
      // A document announces itself more than once — on parse, on
      // `DOMContentLoaded`, on `load` — because the machine has to be able to
      // drive it as early as possible. The window is news the first time; the
      // `load` event is not, and it is not news at all while the document is
      // still `loading`. The same rule the tab's own document follows below:
      // announcing at the top of `<head>` made `framenavigated` fire on a
      // frame with no `<body>` yet, so a body that waited for one and then read
      // the frame read an empty document.
      const url = String(message.url ?? '')
      const settled = String(message.readyState ?? 'complete') !== 'loading'
      const announced = bound !== undefined && bound.url === url && bound.loaded
      tab.frames.set(from, { window: event.source as Window, url, at: Date.now(), loaded: announced || settled })
      if (settled && !announced) {
        this.emit({ kind: 'load', tab: tab.id, at: Date.now(), url, frame: from })
      }
      return
    } else if (tab.frames.get(from)?.window !== event.source) return

    switch (message.type) {
      case 'ready': {
        if (typeof message.title === 'string' && message.title !== '') tab.title = message.title
        // The runtime is injected at the top of `<head>`, so its first
        // announcement happens while the parser is still on the head — which
        // is what makes the tab drivable early, and which is why the tab is
        // marked ready on any announcement.
        tab.markReady()
        // `load` is not that. A document announces itself on parse, on
        // `DOMContentLoaded` and on `load`, and it says which; emitting on the
        // first one told a body waiting for `load` that a page with no `<body>`
        // yet had finished. Only the announcement that says the document is
        // done is the tab finishing, and only the first of those — a task
        // counting `load` events should not get two for one navigation.
        const state = String(message.readyState ?? 'complete')
        if (state !== 'loading' && tab.announce()) {
          this.emit({ kind: 'load', tab: tab.id, at: Date.now(), url: tab.url, title: tab.title })
        }
        this.#changed()
        return
      }
      case 'title': {
        // A framed document renaming itself is not the tab renaming itself.
        if (from !== undefined) return
        if (typeof message.title === 'string' && message.title !== '' && message.title !== tab.title) {
          tab.title = message.title
          this.#changed()
        }
        return
      }
      case 'console': {
        tab.log({ level: String(message.level ?? 'log'), text: String(message.text ?? ''), at: Date.now() })
        this.emit({
          kind: 'console', tab: tab.id, at: Date.now(),
          level: String(message.level ?? 'log'), text: String(message.text ?? ''),
        })
        return
      }
      case 'dialog': {
        tab.dialogs.push({
          kind: String(message.kind ?? ''),
          message: String(message.message ?? ''),
          answer: String(message.answer ?? ''),
          at: Date.now(),
        })
        tab.log({ level: 'info', text: `${String(message.kind)}: ${String(message.message)}`, at: Date.now() })
        this.emit({
          kind: 'dialog', tab: tab.id, at: Date.now(), dialog: String(message.kind ?? ''),
          text: String(message.message ?? ''), answer: String(message.answer ?? ''),
          ...(from === undefined ? {} : { frame: from }),
        })
        return
      }
      case 'download': {
        const offered = String(message.url ?? '')
        const name = String(message.suggestedFilename ?? '') || (() => {
          try {
            return new URL(offered).pathname.split('/').pop() ?? 'download'
          } catch {
            return 'download'
          }
        })()
        // Noted as well as announced. A `download` link clicked outside a task
        // space has nobody listening for the event, and without this the click
        // left no trace at all: the tab did not move, nothing was logged, and
        // the page read as one that ignored the button.
        tab.log({ level: 'info', text: `download offered: ${name} (${offered})`, at: Date.now() })
        this.emit({ kind: 'download', tab: tab.id, at: Date.now(), url: offered, suggestedFilename: name })
        return
      }
      case 'filechooser': {
        this.emit({
          kind: 'filechooser', tab: tab.id, at: Date.now(), chooser: String(message.selector ?? ''),
          multiple: message.multiple === true, accept: String(message.accept ?? ''),
          ...(from === undefined ? {} : { frame: from }),
        })
        return
      }
      case 'navigate': {
        this.#follow(tab, from, String(message.url), message.mode === 'replace' ? 'replace' : 'push')
        return
      }
      case 'open': {
        // Caught, like the `history` case below: `newTab` refuses once the
        // machine is holding its twelve tabs, and with nothing listening that
        // was an unhandled rejection and a `window.open` that left no trace at
        // all — the click did nothing and nothing said why.
        void this.newTab(String(message.url), { background: true, opener: tab.id }).catch((error: unknown) => {
          tab.log({
            level: 'warn',
            text: `a popup could not be opened: ${error instanceof Error ? error.message : String(error)}`,
            at: Date.now(),
          })
          this.#changed()
        })
        return
      }
      case 'submit': {
        const fields = (message.fields as [string, string][] | undefined) ?? []
        const method = String(message.method ?? 'GET').toUpperCase()
        const target = String(message.url)
        if (method === 'GET') {
          const url = new URL(target)
          // The form's fields *replace* the action's query, the way a browser
          // does it, and repeated names are kept. `set` in a loop did neither:
          // three checked boxes named `tag` collapsed to the last one, and a
          // `page=2` already on the action URL survived a search that meant to
          // start over.
          url.search = new URLSearchParams(fields).toString()
          this.#follow(tab, from, url.href)
          return
        }
        if (from !== undefined) {
          void this.#renderFrame(tab, from, target, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
          })
          return
        }
        void this.#post(tab, target, fields)
        return
      }
      case 'history': {
        // A frame's own history is the frame's. Letting a framed widget's
        // `pushState` become the tab's URL is how `page.url()` starts naming
        // an advert, and letting its `back()` through moves the whole tab off
        // the page the task was on.
        if (from !== undefined) return
        if (message.action === 'go') {
          void this.go(Number(message.delta ?? 0), tab.id).catch(() => undefined)
          return
        }
        // `pushState`/`replaceState`: the document did not change, only what it
        // calls itself. The tab's history has to agree or the back button lies.
        const url = String(message.url)
        tab.url = url
        if (message.action === 'push') {
          tab.history = tab.history.slice(0, tab.index + 1)
          tab.history.push({ url, title: tab.title })
          tab.index = tab.history.length - 1
        } else if (tab.index >= 0) tab.history[tab.index] = { url, title: tab.title }
        this.#changed()
        return
      }
      case 'cookie': {
        // The document that set it, which for a nested frame is another site
        // entirely: filing its cookie against the page around it both loses
        // the write (the frame is re-seeded from its own origin) and hands the
        // outer page a third party's cookie.
        const where = from === undefined ? tab.url : tab.frameUrls.get(from) ?? ''
        if (!where.startsWith('http')) return
        this.profile.cookies.set(new URL(where), String(message.value))
        const refreshed = this.profile.cookies.header(new URL(where))
        const target = from === undefined ? tab.frame.contentWindow : tab.frames.get(from)?.window
        target?.postMessage(
          { wb: true, nonce: from === undefined ? tab.nonce : tab.nonceFor(from), type: 'cookieUpdate', value: refreshed },
          '*',
        )
        return
      }
      case 'storage': {
        const key = message.key === null ? null : String(message.key)
        const value = message.value === null ? null : String(message.value)
        let origin: string
        try {
          // The writing document's origin. `#preamble` seeds each frame from
          // its own, so partitioning the write by the tab's URL meant a frame
          // never read back what it wrote and the page around it was left
          // holding somebody else's keys. Both areas, not only the persistent
          // one: a tab's `sessionStorage` is per origin in a real browser too.
          origin = new URL(from === undefined ? tab.url : tab.frameUrls.get(from) ?? '').origin
        } catch {
          return
        }
        const store = message.area === 'session' ? tab.sessionFor(origin) : this.profile.localStore(origin)
        if (key === null) store.clear()
        else if (value === null) store.delete(key)
        else store.set(key, value)
        // Only the profile is written to disk; the tab's own store dies with it.
        if (message.area !== 'session') this.profile.touch()
        return
      }
      case 'ask': {
        void this.#answer(tab, from, message)
        return
      }
      case 'result': {
        const waiting = tab.waiting.get(String(message.id))
        if (waiting === undefined) return
        tab.waiting.delete(String(message.id))
        clearTimeout(waiting.timer)
        if (message.error === undefined) waiting.resolve(message.value)
        else waiting.reject(new Error(String(message.error)))
        return
      }
      default:
    }
  }

  /**
   * Submit a form that used POST, which is a navigation with a body.
   * @param tab - the tab.
   * @param url - where to.
   * @param fields - the form's fields.
   */
  async #post(tab: Tab, url: string, fields: [string, string][]): Promise<void> {
    tab.loading = true
    this.#changed()
    try {
      const body = new URLSearchParams(fields).toString()
      const resource = await load(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      this.#note(tab, { url: resource.url, method: 'POST', status: resource.status, at: Date.now() })
      await this.#render(tab, resource.url, resource.type, resource.contentType, resource.bytes, resource.status)
      tab.history = tab.history.slice(0, tab.index + 1)
      tab.history.push({ url: tab.url, title: tab.title })
      tab.index = tab.history.length - 1
    } catch (error) {
      tab.error = error instanceof Error ? error.message : String(error)
    } finally {
      tab.loading = false
      this.#changed()
    }
  }

  /**
   * Answer one request a page made through its shims.
   *
   * To the document that asked, which is not always the tab's own: every
   * nested frame carries the same runtime and so makes the same requests, and
   * request ids are a per-document counter — so posting every answer to the
   * top document both stranded the frame's `fetch` for ever and let a frame's
   * reply settle an unrelated request of the same id in the page above it.
   * @param tab - the tab that asked.
   * @param from - the nested frame that asked, or undefined for the tab's own
   * document.
   * @param message - the request.
   */
  async #answer(tab: Tab, from: string | undefined, message: Record<string, unknown>): Promise<void> {
    const id = String(message.id)
    const payload = (message.payload as Record<string, unknown> | undefined) ?? {}
    const asker = from === undefined ? tab.frame.contentWindow : tab.frames.get(from)?.window
    const secret = from === undefined ? tab.nonce : tab.nonceFor(from)
    const reply = (value: unknown, error?: string): void => {
      asker?.postMessage(
        { wb: true, nonce: secret, type: 'reply', id, ...(error === undefined ? { value } : { error }) },
        '*',
      )
    }
    try {
      switch (message.kind) {
        case 'fetch': {
          const url = String(payload.url)
          // The page's own headers, minus the ones the browser forbids a page
          // to set. Passing them through would make `fetch` throw rather than
          // silently dropping them, which is worse: the site sees an error it
          // has no branch for.
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries((payload.headers as Record<string, string> | undefined) ?? {})) {
            if (/^(?:host|cookie|origin|referer|connection|content-length|user-agent)$/i.test(name)) continue
            headers[name] = String(value)
          }
          try {
            const resource = await load(url, {
              method: String(payload.method ?? 'GET'),
              headers,
              ...(payload.body === undefined ? {} : { body: String(payload.body) }),
            })
            this.#note(tab, {
              url: resource.url, method: String(payload.method ?? 'GET'), status: resource.status, at: Date.now(),
            })
            reply({
              status: resource.status,
              statusText: '',
              headers: { 'content-type': resource.contentType },
              body: base64(resource.bytes),
              url: resource.url,
            })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            this.#note(tab, { url, method: String(payload.method ?? 'GET'), status: 0, at: Date.now(), error: detail })
            reply({ status: 0, statusText: '', headers: {}, body: '', url, error: detail })
          }
          return
        }
        case 'module': {
          const context: RewriteContext = { cache: this.cache, depth: 0, modules: new Map() }
          const resolved = new URL(String(payload.specifier), String(payload.base)).href
          reply(await moduleUrl(resolved, context))
          return
        }
        case 'reload': {
          // A frame reloading itself reloads the frame; only the tab's own
          // document reloads the tab. The address comes from `frameUrls` — the
          // machine's own record of what it fetched — and not from what the
          // frame said it was showing, which is a string the framed site can
          // choose and would otherwise decide what this machine fetches next.
          const where = from === undefined ? undefined : tab.frameUrls.get(from)
          if (from === undefined) void this.navigate(tab.url, tab.id, 'replace')
          else if (where !== undefined && where !== '') void this.#renderFrame(tab, from, where)
          reply(true)
          return
        }
        default:
          reply(null, `unknown request ${String(message.kind)}`)
      }
    } catch (error) {
      reply(null, error instanceof Error ? error.message : String(error))
    }
  }

  /** Forget every cookie and every site's storage. */
  async clearProfile(): Promise<void> {
    this.profile.cookies.clear()
    this.profile.clearStorage()
    this.cache.clear()
    await this.profile.flush()
    this.#changed()
  }
}

/** The machine, made once and shared. */
let machine: BrowserMachine | undefined

/**
 * The browser machine this session runs on.
 * @returns the machine, created on first use.
 */
export function browserMachine(): BrowserMachine {
  machine ??= new BrowserMachine()
  return machine
}

/** What the tools import to name the runtime global in an error message. */
export { RUNTIME_GLOBAL }
