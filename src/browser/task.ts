/**
 * Task spaces: a place for a program that drives the browser to live.
 *
 * The `browser_*` tools are one action per model turn. That is the right shape
 * for "open this and read it" and the wrong one for everything with a loop in
 * it — twenty rows of a table is twenty turns, each one paying for a snapshot
 * to find a reference the last click invalidated. A task space is the other
 * shape: a named, persistent JavaScript environment that holds pages, globals
 * and login state between calls, so the model writes the loop once.
 *
 * Four things live here, and each one exists because a program that drives a
 * browser needs it and a single tool call does not:
 *
 * - **The realm.** A sandboxed frame with an opaque origin, holding
 *   `src/browser/realm.ts` and nothing of this page. The model's code runs
 *   there rather than here, because here is where the keys are and the model
 *   spends its day reading pages written by strangers. Everything it wants
 *   done arrives as one of the operations {@link dispatch} implements.
 * - **Receipts.** Every run is identified, and a run that outlives the tool
 *   call that started it is not lost: the receipt says `running`, the code
 *   keeps going in the realm, and the next call reads the result. A request id
 *   reused with the same body returns the first receipt rather than running
 *   the body twice, which is what makes "did my form submission go through?"
 *   answerable rather than a coin flip.
 * - **Ownership.** A task's pages are its own. Another task cannot drive them,
 *   `finish` closes them, and a tab the user opened is only touched if it was
 *   explicitly claimed.
 * - **Generations.** Everything above lives in this page's memory. A reload is
 *   therefore not a restart but a different machine, and a handle from before
 *   it names something that no longer exists — which is worth saying plainly
 *   rather than reporting as a task that mysteriously lost its pages.
 */

import { VIEWPORT, browserMachine, type MachineEvent, type TabInfo } from './engine.ts'
import { BROWSER_REALM } from '../generated/browser-realm.ts'
import { volume } from '../vfs/volume.ts'
import { dirname } from '../vfs/path.ts'
import { routedToRuntime, runtimeReadFile, runtimeWriteFile } from '../runtime/fs-bridge.ts'
import { WORKSPACE_ROOT } from '../host/seed.ts'

/** Where a task's artifacts go, under the workspace the agent can read. */
const ARTIFACT_ROOT = `${WORKSPACE_ROOT}/browser-tasks`

/** How much of a result is returned inline before it becomes a resource. */
const INLINE_LIMIT = 30_000

/** How much of a resource one read returns. */
const SLICE_BYTES = 8192

/** How long a run waits for the realm before the tool call gives up on it. */
export const DEFAULT_WAIT_MS = 55_000

/** How long any one page operation may take. */
const OPERATION_TIMEOUT_MS = 60_000

/** Randomness enough to authenticate a realm's messages. */
function token(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What one evaluation left behind. */
export interface Receipt {
  requestId: string
  task: string
  generation: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: number
  finishedAt?: number
  /**
   * Whether the page may have been changed.
   *
   * `none` is the safe one and it is only claimed when the body performed no
   * action at all. `possible` is the important one: it means an action was
   * started and the outcome is not known, which is the state where retrying is
   * how one order becomes two.
   */
  mutation: 'none' | 'possible' | 'done'
  value?: unknown
  error?: string
  stack?: string
  log?: string[]
  ms?: number
  /** Where the result went when it was too large to return inline. */
  resource?: { id: string, bytes: number, preview: string }
  /** Pictures the run took, which the tool hands to the model. */
  screenshots?: { path?: string, width: number, height: number, bytes: number }[]
  /** What had focus before and after, when the run asked for that. */
  focus?: { before?: unknown, after?: unknown }
  /** The pages the task had when the run ended. */
  pages?: { tab: string, url: string }[]
  /** A digest of the body, so a reused request id with new code is caught. */
  fingerprint: string
}

/** What `checkpoint` reports about a task's live state. */
export interface Checkpoint {
  task: string
  generation: string
  url: string
  title: string
  pageCount: number
  claimedPages: number
  targetEpoch: number
  documentGeneration: number
  mainFrameAttached: boolean
  lastReceipt?: { requestId: string, state: string, mutation: string }
  dialogs: number
}

/** A digest short enough to compare and long enough not to collide by accident. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Make a name safe to put in a path. */
function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'task' : cleaned.slice(0, 48)
}

/**
 * Write a file wherever this session's workspace actually is.
 *
 * The same rule the screenshot tool follows, and for the reason that commit
 * gave: on a browser session the container can still be the live filesystem,
 * and a file written to the page's volume instead is one the tool names in its
 * result and nobody can open.
 * @param path - an absolute path.
 * @param bytes - what to write.
 */
async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  if (await routedToRuntime(path)) await runtimeWriteFile(path, bytes)
  else {
    volume.mkdirp(dirname(path))
    volume.writeFile(path, bytes)
  }
}

/**
 * Read a file from wherever the workspace is.
 * @param path - an absolute path.
 * @returns the bytes.
 */
async function readFile(path: string): Promise<Uint8Array> {
  if (await routedToRuntime(path)) return runtimeReadFile(path)
  return volume.readFile(path)
}

/** Base64 for bytes that have to cross a message channel. */
function base64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/** One named, persistent place for a task's code, pages and receipts. */
export class TaskSpace {
  readonly name: string
  readonly id = `task-${token().slice(0, 8)}`
  readonly generation: string
  readonly createdAt = Date.now()
  lastUsed = Date.now()

  /** Tabs this task opened, which it also closes. */
  readonly owned = new Set<string>()

  /** Tabs the user handed it, which it never closes. */
  readonly claimed = new Set<string>()

  /** Everything this task has run, by request id. */
  readonly receipts = new Map<string, Receipt>()

  /** Results too large to return inline, by handle. */
  readonly resources = new Map<string, { bytes: Uint8Array, contentType: string }>()

  /** Where this task's files go. */
  readonly artifacts: string

  #frame: HTMLIFrameElement | undefined
  readonly #nonce = token()
  #ready: Promise<void> | undefined
  #announce: (() => void) | undefined
  #stopListening: (() => void) | undefined
  /** The run in flight, if any. */
  #current: { receipt: Receipt, settle: (receipt: Receipt) => void } | undefined
  /** Screenshots the run in flight has taken. */
  #shots: { path?: string, width: number, height: number, bytes: number }[] = []
  #finished = false

  constructor(name: string) {
    this.name = name
    this.generation = browserMachine().generation
    this.artifacts = `${ARTIFACT_ROOT}/${slug(name)}`
  }

  /** Every page this task may drive. */
  pages(): TabInfo[] {
    const machine = browserMachine()
    return machine.tabs().filter((tab) => this.owned.has(tab.id) || this.claimed.has(tab.id))
  }

  /** The page a call acts on when it does not name one. */
  activeTab(): string | undefined {
    const live = this.pages()
    return live[live.length - 1]?.id
  }

  /**
   * Start the realm, once.
   *
   * Deliberately not at construction: a task space that is listed but never
   * run should not cost a frame, and the first run pays one page-load's worth
   * of latency for it.
   * @returns when the realm is listening.
   */
  async open(): Promise<void> {
    if (this.#ready !== undefined) {
      await this.#ready
      return
    }
    const machine = browserMachine()
    await machine.open()
    this.#ready = new Promise<void>((resolve) => { this.#announce = resolve })

    const frame = document.createElement('iframe')
    // The same isolation a browsed page gets, and for a stronger reason: this
    // is code a model wrote, and an opaque origin is what stops it reaching
    // this page's storage, its keys, or the harness at all.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.style.cssText = 'position:fixed;left:-30000px;top:0;width:10px;height:10px;border:0;visibility:hidden;'
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8">'
      + `<script>window.__REALM_NONCE__=${JSON.stringify(this.#nonce)}</script>`
      + `<script>${BROWSER_REALM}</script></head><body></body></html>`
    document.body.append(frame)
    this.#frame = frame

    window.addEventListener('message', this.#receive)
    this.#stopListening = machine.onEvent((event) => { this.#forward(event) })

    await Promise.race([this.#ready, new Promise<void>((resolve) => setTimeout(resolve, 15_000))])
  }

  /** Hand the realm every event that belongs to one of this task's pages. */
  #forward(event: MachineEvent): void {
    // A page opened by one of this task's pages joins the task: that is what a
    // popup is, and a task that could not touch the tab its own click opened
    // would be unable to finish the flow it started.
    if (event.kind === 'page' && event.opener !== undefined && this.owned.has(event.opener)) {
      this.owned.add(event.tab)
    }
    if (!this.owned.has(event.tab) && !this.claimed.has(event.tab)) return
    this.#post({ type: 'event', event })
  }

  /** Post one message into the realm. */
  #post(message: Record<string, unknown>): void {
    this.#frame?.contentWindow?.postMessage({ realm: true, nonce: this.#nonce, ...message }, '*')
  }

  /** Handle one message from the realm. */
  readonly #receive = (event: MessageEvent): void => {
    const message = event.data as Record<string, unknown> | undefined
    if (message === undefined || message.realm !== true || message.nonce !== this.#nonce) return
    if (event.source !== this.#frame?.contentWindow) return

    switch (message.type) {
      case 'ready': {
        this.#announce?.()
        this.#announce = undefined
        this.#post({
          type: 'adopt',
          pages: this.pages().map((tab) => ({ tab: tab.id, url: tab.url, title: tab.title })),
          active: this.activeTab(),
          viewport: VIEWPORT,
        })
        return
      }
      case 'rpc': {
        void (async () => {
          try {
            const value = await this.dispatch(String(message.op), (message.params as Record<string, unknown>) ?? {})
            this.#post({ type: 'reply', id: message.id, value })
          } catch (error) {
            this.#post({
              type: 'reply',
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
        return
      }
      case 'done': {
        void this.#settle(message)
        return
      }
      default:
    }
  }

  /** Record the end of a run and hand the receipt to whoever is waiting. */
  async #settle(message: Record<string, unknown>): Promise<void> {
    const current = this.#current
    if (current === undefined) return
    const receipt = current.receipt
    receipt.finishedAt = Date.now()
    receipt.ms = Number(message.ms ?? 0)
    receipt.log = (message.log as string[] | undefined) ?? []
    receipt.mutation = message.mutated === true ? 'done' : 'none'
    receipt.pages = (message.pages as { tab: string, url: string }[] | undefined) ?? []
    if (message.focus !== undefined) receipt.focus = message.focus as { before?: unknown, after?: unknown }
    if (this.#shots.length > 0) receipt.screenshots = [...this.#shots]

    if (message.error === undefined) {
      receipt.state = 'succeeded'
      await this.#record(receipt, message.value)
    } else {
      receipt.state = 'failed'
      receipt.error = String(message.error)
      if (typeof message.stack === 'string' && message.stack !== '') receipt.stack = message.stack
      // A body that failed after acting has left the page in a state nobody
      // has looked at. Saying so is the difference between "correct the code
      // and run it again" and "check what happened first".
      if (message.mutated === true) receipt.mutation = 'possible'
    }
    this.#current = undefined
    current.settle(receipt)
  }

  /**
   * Put a result in the receipt, spilling it to a resource when it is large.
   * @param receipt - the receipt to fill in.
   * @param value - what the body returned.
   */
  async #record(receipt: Receipt, value: unknown): Promise<void> {
    const text = JSON.stringify(value ?? null)
    if (text.length <= INLINE_LIMIT) {
      receipt.value = value
      return
    }
    const id = `res-${token().slice(0, 6)}`
    const bytes = new TextEncoder().encode(text)
    this.resources.set(id, { bytes, contentType: 'application/json' })
    receipt.resource = { id, bytes: bytes.length, preview: text.slice(0, 2000) }
  }

  /**
   * Run one body in this task's realm.
   * @param code - the async function body.
   * @param options - the request id, whether it may act, and how long the
   * caller is prepared to wait for it.
   * @returns the receipt, which may still be `running`.
   */
  async run(code: string, options: {
    requestId?: string
    readOnly?: boolean
    foreground?: boolean
    diagnostics?: string
    waitMs?: number
    timeoutMs?: number
  } = {}): Promise<Receipt> {
    if (this.#finished) throw new Error(`task "${this.name}" has been finished; start it again with a new call`)
    const machine = browserMachine()
    if (this.generation !== machine.generation) {
      throw new Error(`GENERATION_MISMATCH: task "${this.name}" belongs to a previous run of this machine `
        + '(the page was reloaded). Its pages and its globals are gone. Start a task with a new name, '
        + 'inspect the current state read-only, and only then repeat anything that changes something.')
    }
    const requestId = options.requestId ?? `auto-${token().slice(0, 6)}`
    const mark = fingerprint(code)
    const existing = this.receipts.get(requestId)
    if (existing !== undefined) {
      // The same id with the same body is a repeat of the question, not of the
      // action: hand back what happened the first time.
      if (existing.fingerprint === mark) {
        if (existing.state === 'running' || existing.state === 'queued') {
          return this.#await(existing, options.waitMs ?? DEFAULT_WAIT_MS)
        }
        return existing
      }
      throw new Error(`request id "${requestId}" was already used in this task for different code. `
        + 'Request ids identify an operation so it is not performed twice; give this one its own id.')
    }
    if (this.#current !== undefined) {
      throw new Error(`task "${this.name}" is still running ${this.#current.receipt.requestId}. `
        + 'Read its receipt rather than starting another body: one task space runs one thing at a time.')
    }

    await this.open()
    this.lastUsed = Date.now()
    this.#shots = []
    // Bringing a page forward is a thing the *user* asks for. A task that did
    // it on its own would take the machine panel away from whatever the person
    // watching it was looking at, several times a minute.
    if (options.foreground === true) {
      const front = this.activeTab()
      if (front !== undefined) machine.selectTab(front)
    }
    const receipt: Receipt = {
      requestId,
      task: this.name,
      generation: this.generation,
      state: 'running',
      startedAt: Date.now(),
      mutation: 'none',
      fingerprint: mark,
    }
    this.receipts.set(requestId, receipt)

    const settled = new Promise<Receipt>((resolve) => {
      this.#current = { receipt, settle: resolve }
    })
    this.#post({
      type: 'run',
      id: requestId,
      code,
      readOnly: options.readOnly === true,
      artifacts: this.artifacts,
      task: this.name,
      tab: this.activeTab(),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      timeoutMs: options.timeoutMs ?? OPERATION_TIMEOUT_MS,
    })
    return this.#race(settled, receipt, options.waitMs ?? DEFAULT_WAIT_MS)
  }

  /** Wait for a receipt to settle, or report that it has not. */
  async #race(settled: Promise<Receipt>, receipt: Receipt, waitMs: number): Promise<Receipt> {
    return Promise.race([
      settled,
      new Promise<Receipt>((resolve) => setTimeout(() => {
        // Not a failure: the body is still running in the realm and will
        // finish. The caller gets the receipt to poll rather than a timeout
        // that says nothing about what the page is doing.
        resolve(receipt)
      }, waitMs)),
    ])
  }

  /** Wait on a receipt that was already running when it was asked for again. */
  async #await(receipt: Receipt, waitMs: number): Promise<Receipt> {
    const current = this.#current
    if (current === undefined || current.receipt !== receipt) return receipt
    return this.#race(new Promise<Receipt>((resolve) => {
      const previous = current.settle
      current.settle = (settledReceipt) => {
        previous(settledReceipt)
        resolve(settledReceipt)
      }
    }), receipt, waitMs)
  }

  /** What this task's live state is, for deciding whether to repeat something. */
  async checkpoint(): Promise<Checkpoint> {
    const machine = browserMachine()
    const pages = this.pages()
    const active = pages[pages.length - 1]
    const last = [...this.receipts.values()].pop()
    let documentGeneration = 0
    let attached = false
    let dialogs = 0
    if (active !== undefined) {
      try {
        const counted = await machine.run('evaluate', {
          source: 'document.querySelectorAll("*").length',
        }, active.id) as { value: unknown }
        documentGeneration = Number(counted.value ?? 0)
        attached = true
        const raised = await machine.run('dialogs', { limit: 50 }, active.id) as { dialogs?: unknown[] }
        dialogs = (raised.dialogs ?? []).length
      } catch {
        // A page that will not answer is a page whose main frame is not there.
      }
    }
    return {
      task: this.name,
      generation: this.generation,
      url: active?.url ?? '',
      title: active?.title ?? '',
      pageCount: pages.length,
      claimedPages: this.claimed.size,
      targetEpoch: this.receipts.size,
      documentGeneration,
      mainFrameAttached: attached,
      ...(last === undefined
        ? {}
        : { lastReceipt: { requestId: last.requestId, state: last.state, mutation: last.mutation } }),
      dialogs,
    }
  }

  /**
   * Read part of a large result.
   * @param id - the resource handle.
   * @param offset - where to continue from.
   * @param maxBytes - how much to read, from 1024 up to 65536.
   * @returns the slice, and where the next one starts.
   */
  resource(id: string, offset = 0, maxBytes = SLICE_BYTES): { text: string, nextOffset: number, eof: boolean, bytes: number } {
    const held = this.resources.get(id)
    if (held === undefined) {
      throw new Error(`no resource ${id} in task "${this.name}"; resources belong to the task that produced them`)
    }
    const start = Math.max(0, Math.min(offset, held.bytes.length))
    const end = Math.min(start + Math.max(1024, Math.min(maxBytes, 65_536)), held.bytes.length)
    return {
      text: new TextDecoder().decode(held.bytes.subarray(start, end)),
      nextOffset: end,
      eof: end >= held.bytes.length,
      bytes: held.bytes.length,
    }
  }

  /**
   * Close the task space down.
   * @param keep - whether to leave its pages open.
   * @returns what was closed.
   */
  finish(keep: boolean): { task: string, taskId: string, finished: true, keep: boolean, closed: number } {
    let closed = 0
    if (!keep) {
      const machine = browserMachine()
      for (const tab of [...this.owned]) {
        // A claimed page is the user's, and finishing a task is not a reason to
        // close a tab somebody else opened.
        if (this.claimed.has(tab)) continue
        try {
          machine.closeTab(tab)
          closed += 1
        } catch {
          // Already gone, which is the outcome that was wanted.
        }
      }
    }
    this.#post({ type: 'abandon', reason: `task "${this.name}" was finished` })
    this.#stopListening?.()
    window.removeEventListener('message', this.#receive)
    this.#frame?.remove()
    this.#frame = undefined
    this.#finished = true
    return { task: this.name, taskId: this.id, finished: true, keep, closed }
  }

  /** Whether this space has been finished. */
  get finished(): boolean { return this.#finished }

  /** Note a picture the run took, so the tool can hand it to the model. */
  noteScreenshot(shot: { path?: string, width: number, height: number, bytes: number }): void {
    this.#shots.push(shot)
    if (this.#shots.length > 8) this.#shots.splice(0, this.#shots.length - 8)
  }

  /**
   * The page an operation acts on, creating one only where that is meant.
   * @param params - the operation's arguments.
   * @param create - whether a task with no page should get one.
   * @returns the tab id.
   */
  async #target(params: Record<string, unknown>, create = false): Promise<string> {
    const named = typeof params.tab === 'string' && params.tab !== '' ? params.tab : undefined
    if (named !== undefined) {
      if (!this.owned.has(named) && !this.claimed.has(named)) {
        throw new Error(`page ${named} does not belong to task "${this.name}". A task drives the pages it `
          + 'opened and the ones it was given; claim a tab explicitly to work on it.')
      }
      return named
    }
    const active = this.activeTab()
    if (active !== undefined) return active
    if (!create) {
      throw new Error(`task "${this.name}" has no page open. Start with \`await page.goto(url)\`, which opens one.`)
    }
    const machine = browserMachine()
    // The first page a task opens is the one it is *about*, so it becomes the
    // visible tab — otherwise the one-shot tools, which act on the active tab,
    // would be looking at a different page than the task is. Every page after
    // it opens behind: a task that opens six should not take the panel six
    // times from whoever is watching.
    const created = await machine.newTab(undefined, { background: this.pages().length > 0 })
    this.owned.add(created)
    return created
  }

  /**
   * Walk into nested frames, resolving each `<iframe>` to the runtime in it.
   * @param tab - the page.
   * @param path - one chain per frame level.
   * @returns the token of the innermost frame, or undefined for the document.
   */
  async #intoFrame(tab: string, path: unknown, token?: unknown): Promise<string | undefined> {
    // A ref that names its frame is already the answer; there is no chain to
    // walk, because the ref came from a look that had already walked one.
    if (typeof token === 'string' && token !== '') return token
    const levels = Array.isArray(path) ? path as Record<string, unknown>[][] : []
    let frame: string | undefined
    for (const chain of levels) {
      const resolved = await browserMachine().run('frame.resolve', { chain }, tab,
        frame === undefined ? {} : { frame }) as { token: string }
      frame = resolved.token
    }
    return frame
  }

  /**
   * Perform one operation the realm asked for.
   *
   * This is the whole of what a task space can do to the world, which is the
   * point of putting the realm behind it: the code a model writes reaches
   * exactly these, and each one is a thing this machine already knew how to do
   * for the single-action tools.
   * @param op - which operation.
   * @param params - its arguments.
   * @returns whatever it produced, JSON-safe.
   */
  async dispatch(op: string, params: Record<string, unknown>): Promise<unknown> {
    const machine = browserMachine()

    switch (op) {
      // -- locators, which are the bulk of everything ------------------------
      case 'act':
      case 'query':
      case 'wait':
      case 'evaluate':
      case 'evaluateAll':
      case 'box':
      case 'actionability': {
        const tab = await this.#target(params)
        const frame = await this.#intoFrame(tab, params.framePath, params.frameToken)
        const kind = op === 'act' ? 'locator.act'
          : op === 'query' ? 'locator.query'
            : op === 'wait' ? 'locator.wait'
              : op === 'evaluate' ? 'locator.evaluate'
                : op === 'evaluateAll' ? 'locator.evaluateAll'
                  : op === 'box' ? 'locator.box' : 'locator.actionability'
        const payload: Record<string, unknown> = { chain: params.chain }
        for (const key of ['action', 'args', 'query', 'state', 'source', 'argument', 'timeoutMs', 'force']) {
          if (params[key] !== undefined) payload[key] = params[key]
        }
        const value = await machine.run(kind, payload, tab, {
          ...(frame === undefined ? {} : { frame }),
          timeoutMs: OPERATION_TIMEOUT_MS,
        })
        // The query commands wrap their answer so that `null` and `undefined`
        // survive the trip; unwrap it here so the realm sees the value itself.
        return op === 'query' || op === 'evaluate' || op === 'evaluateAll'
          ? (value as { value: unknown }).value
          : value
      }

      case 'page.command': {
        const tab = await this.#target(params)
        const frame = await this.#intoFrame(tab, params.framePath, params.frameToken)
        return machine.run(String(params.kind), (params.payload as Record<string, unknown> | undefined) ?? {}, tab, {
          ...(frame === undefined ? {} : { frame }),
          timeoutMs: OPERATION_TIMEOUT_MS,
        })
      }

      case 'aria.snapshot': {
        const tab = await this.#target(params)
        const frame = await this.#intoFrame(tab, params.framePath, params.frameToken)
        return machine.run('aria.snapshot', {
          ...(params.depth === undefined ? {} : { depth: params.depth }),
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
          ...(params.boxes === undefined ? {} : { boxes: params.boxes }),
        }, tab, frame === undefined ? {} : { frame })
      }

      case 'observe': {
        const tab = await this.#target(params)
        return this.observe(tab, params)
      }

      // -- pages -------------------------------------------------------------
      case 'page.info': {
        const tab = await this.#target(params)
        const info = machine.tabs().find((entry) => entry.id === tab)
        if (info === undefined) return { url: '', title: '', closed: true }
        return { url: info.url, title: info.title, closed: false, loading: info.loading, error: info.error }
      }

      case 'nav.goto': {
        const tab = await this.#target(params, true)
        const info = await machine.navigate(String(params.url), tab)
        return { tab, url: info.url, title: info.title, status: info.error === undefined ? 200 : 0, error: info.error }
      }

      case 'nav.reload': {
        const tab = await this.#target(params)
        const current = machine.tabs().find((entry) => entry.id === tab)
        const info = await machine.navigate(current?.url ?? 'about:blank', tab, 'replace')
        return { url: info.url, title: info.title }
      }

      case 'nav.back':
      case 'nav.forward': {
        const tab = await this.#target(params)
        const info = await machine.go(op === 'nav.back' ? -1 : 1, tab)
        return { url: info.url, title: info.title }
      }

      case 'tabs.new': {
        const created = await machine.newTab(params.url === undefined ? undefined : String(params.url), {
          background: this.pages().length > 0,
        })
        this.owned.add(created)
        const info = machine.tabs().find((entry) => entry.id === created)
        return { tab: created, url: info?.url ?? 'about:blank', title: info?.title ?? '' }
      }

      case 'tabs.close': {
        const tab = await this.#target(params)
        machine.closeTab(tab)
        this.owned.delete(tab)
        this.claimed.delete(tab)
        return { closed: true }
      }

      case 'tabs.select': {
        const tab = await this.#target(params)
        machine.selectTab(tab)
        return { selected: true }
      }

      case 'page.screenshot': {
        const tab = await this.#target(params)
        return this.screenshot(tab, params)
      }

      // -- the world outside the page ---------------------------------------
      case 'request.fetch': {
        const response = await machine.fetch(String(params.url), {
          method: String(params.method ?? 'GET'),
          headers: (params.headers as Record<string, string> | undefined) ?? {},
          ...(params.body === undefined ? {} : { body: String(params.body) }),
        })
        return {
          status: response.status,
          url: response.url,
          headers: { 'content-type': response.contentType },
          body: base64(response.bytes),
        }
      }

      case 'download.save': {
        const response = await machine.fetch(String(params.url))
        if (response.status >= 400) {
          throw new Error(`downloading ${String(params.url)} answered HTTP ${String(response.status)}`)
        }
        const wanted = String(params.path ?? '')
        const path = wanted === ''
          ? `${this.artifacts}/${String(params.suggestedFilename ?? 'download')}`
          : wanted.startsWith('/') ? wanted : `${WORKSPACE_ROOT}/${wanted}`
        await writeFile(path, response.bytes)
        return { path, bytes: response.bytes.length, url: response.url }
      }

      case 'fs.write': {
        const wanted = String(params.path ?? '')
        if (wanted === '') throw new Error('saveFile() needs a path')
        const path = wanted.startsWith('/') ? wanted : `${WORKSPACE_ROOT}/${wanted}`
        const binary = atob(String(params.base64 ?? ''))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        await writeFile(path, bytes)
        return { path, bytes: bytes.length }
      }

      case 'fs.readMany': {
        const paths = (params.paths as string[] | undefined) ?? []
        const files: { name: string, mimeType: string, base64: string }[] = []
        for (const entry of paths) {
          const path = entry.startsWith('/') ? entry : `${WORKSPACE_ROOT}/${entry}`
          const bytes = await readFile(path)
          files.push({
            name: path.slice(path.lastIndexOf('/') + 1),
            mimeType: mimeOf(path),
            base64: base64(bytes),
          })
        }
        return files
      }

      case 'profile.cookies':
        return machine.cookies()

      case 'profile.clear':
        await machine.clearProfile()
        return { cleared: true }

      default:
        throw new Error(`unknown operation ${op}`)
    }
  }

  /**
   * Photograph a page and keep the file.
   *
   * Always a file, unlike `browser_screenshot`, which returns the picture and
   * writes nothing unless asked: a task's screenshot is taken by code that
   * cannot look at it, so the only way it reaches anybody is as something the
   * tool result can point at.
   * @param tab - which page.
   * @param params - a path, the whole document, or a region.
   * @returns where it went and how big it is.
   */
  async screenshot(tab: string, params: Record<string, unknown>): Promise<{
    path: string, width: number, height: number, bytes: number
  }> {
    const machine = browserMachine()
    const taken = await machine.run('screenshot', {
      fullPage: params.fullPage === true,
      ...(params.clip === undefined ? {} : { clip: params.clip }),
    }, tab, { timeoutMs: OPERATION_TIMEOUT_MS }) as { dataUrl: string, width: number, height: number }
    const encoded = taken.dataUrl.slice(taken.dataUrl.indexOf(',') + 1)
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

    const wanted = params.path === undefined ? '' : String(params.path)
    const path = wanted === ''
      ? `${this.artifacts}/shot-${String(this.#shots.length + 1)}.png`
      : wanted.startsWith('/') ? wanted : `${WORKSPACE_ROOT}/${wanted}`
    await writeFile(path, bytes)
    const shot = { path, width: taken.width, height: taken.height, bytes: bytes.length }
    this.noteScreenshot(shot)
    return shot
  }

  /**
   * One bounded look at a page, its frames included.
   *
   * The frames are the part that needs this to be here rather than in the
   * document: each one is its own origin with its own runtime, so a look at a
   * framed page is one command per frame and somebody has to fan them out.
   * @param tab - which page.
   * @param options - what to include and how much.
   * @returns the observation.
   */
  async observe(tab: string, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    return observePage(tab, options)
  }
}

/**
 * One bounded look at a page, its frames included.
 *
 * A free function rather than a method: `browser_inspect` wants exactly this
 * and has no task to ask it of, and minting a task space to borrow a method
 * would put a task nobody started into the list of open ones.
 * @param tab - which page.
 * @param options - what to include and how much.
 * @returns the observation.
 */
export async function observePage(tab: string, options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const machine = browserMachine()
  const frames = String(options.frames ?? 'visible')
  const observation = await machine.run('observe', {
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    focus: options.focus !== false,
    frames,
    ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
  }, tab, { timeoutMs: OPERATION_TIMEOUT_MS }) as Record<string, unknown> & {
    frames?: { token: string, visible: boolean }[]
    focus?: { inFrame?: string }
  }

  if (frames !== 'none' && Array.isArray(observation.frames)) {
    const maxFrames = Math.max(1, Math.min(Number(options.maxFrames ?? 8), 32))
    const frameMaxChars = Math.max(256, Math.min(Number(options.frameMaxChars ?? 2000), 6000))
    const detailed: Record<string, unknown>[] = []
    for (const frame of observation.frames.slice(0, maxFrames)) {
      const entry: Record<string, unknown> = { ...frame }
      if (frame.token !== '') {
        try {
          const inner = await machine.run('observe', {
            maxChars: frameMaxChars,
            depth: Math.min(Number(options.depth ?? 12), 20),
            focus: false,
            frames: 'none',
          }, tab, { frame: frame.token, timeoutMs: OPERATION_TIMEOUT_MS }) as Record<string, unknown>
          entry.url = inner.url
          entry.title = inner.title
          // Refs are minted per document, so `e3` in a frame and `e3` in the
          // page around it are different elements wearing the same name. The
          // frame's token goes on the front of its own, and `aria-ref=f1e3`
          // routes back to the frame that handed it out.
          entry.snapshot = String(inner.snapshot ?? '').replace(/\[ref=e(\d+)\]/g, `[ref=${frame.token}e$1]`)
          entry.truncated = inner.truncated
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error)
        }
      }
      detailed.push(entry)
    }
    observation.frames = detailed as unknown as { token: string, visible: boolean }[]
  }

  // Focus inside a frame is reported by the frame that has it, so the
  // question "what would my keystroke reach" is answerable in one call.
  const inFrame = observation.focus?.inFrame
  if (inFrame !== undefined && inFrame !== '' && inFrame !== 'unknown') {
    try {
      observation.frameFocus = await machine.run('focus.info', {}, tab, { frame: inFrame })
    } catch {
      // The frame answered its host and not this; the host's view stands.
    }
  }
  return observation
}

/** Content types for the files a task hands to a page. */
function mimeOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const known: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', csv: 'text/csv',
    txt: 'text/plain', md: 'text/markdown', html: 'text/html', zip: 'application/zip',
  }
  return known[extension] ?? 'application/octet-stream'
}

/** Every task space this run of the machine has. */
const spaces = new Map<string, TaskSpace>()

/**
 * The task space with this name, made if it is new.
 * @param name - the task's name.
 * @returns the space.
 */
export function taskSpace(name: string): TaskSpace {
  const held = spaces.get(name)
  if (held !== undefined && !held.finished && held.generation === browserMachine().generation) return held
  const created = new TaskSpace(name)
  spaces.set(name, created)
  return created
}

/**
 * The task space with this name, only if it exists.
 * @param name - the task's name.
 * @returns the space, or undefined.
 */
export function findTaskSpace(name: string): TaskSpace | undefined {
  const held = spaces.get(name)
  return held === undefined || held.finished ? undefined : held
}

/** Every live task space, oldest first. */
export function taskSpaces(): TaskSpace[] {
  return [...spaces.values()].filter((space) => !space.finished)
}

/**
 * Give a task a page somebody else opened.
 * @param space - the task.
 * @param tab - the tab to claim.
 */
export function claimTab(space: TaskSpace, tab: string): void {
  const known = browserMachine().tabs().some((entry) => entry.id === tab)
  if (!known) throw new Error(`no tab ${tab} is open; browser_tabs lists them`)
  space.claimed.add(tab)
}
