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

import { VIEWPORT, browserMachine, token, type MachineEvent, type TabInfo } from './engine.ts'
import { base64, fromBase64 } from './net.ts'
import { MUTATING_COMMANDS, bounded } from './protocol.ts'
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

/**
 * How many bytes of spilled results one task space keeps.
 *
 * Insertion order is age order in a `Map`, so past this the oldest go first.
 */
const RESOURCE_BUDGET_BYTES = 32 * 1024 * 1024

/** How long a run waits for the realm before the tool call gives up on it. */
export const DEFAULT_WAIT_MS = 55_000

/** How long any one page operation may take. */
const OPERATION_TIMEOUT_MS = 60_000

/**
 * The most task spaces one session holds at once.
 *
 * Each one is a live frame with a JavaScript realm in it, kept until it is
 * finished, so an agent that started a new space per step would accumulate
 * them for as long as the tab is open. The limit is a refusal rather than an
 * eviction: finishing somebody else's task to make room would close pages a
 * flow was in the middle of. It is also the nudge towards the right shape —
 * one task space is one job, and eight jobs at once is not what is happening.
 */
const MAX_TASKS = 8

/**
 * Where the names of this run's task spaces are noted.
 *
 * A session survives a reload here — the log is persisted and a conversation
 * picks up where it left off — and a task space does not: it is a frame with a
 * realm in it, and both are gone. So a model that resumes and names its task
 * again gets an empty one, with none of the pages or globals it is about to
 * assume are there. Writing the names down is what lets that be *said* rather
 * than discovered halfway through the next body.
 */
const TASK_LEDGER_KEY = 'webdsh.browser.tasks'

/**
 * The nearest offset at or before this one that begins a UTF-8 character.
 * @param bytes - the encoded text.
 * @param at - where a slice wants to cut.
 * @returns the same offset, or the start of the character it lands inside.
 */
function codePointStart(bytes: Uint8Array, at: number): number {
  if (at >= bytes.length) return bytes.length
  let index = Math.max(0, at)
  // A continuation byte is `10xxxxxx`, and no slice may begin on one.
  while (index > 0 && ((bytes[index] ?? 0) & 0xc0) === 0x80) index -= 1
  return index
}

/**
 * The operations a read-only run may not perform.
 *
 * Named here rather than only in the realm because this is the side that
 * cannot be talked round: the realm's guard is per method, so `page.command`
 * reaches the same frame commands by spelling them, and an operation added to
 * `dispatch` without a matching `guard()` call is permitted by default.
 *
 * `evaluate` and `evaluateAll` are in the list, and the tool's own description
 * says so: the body supplies the code, and nothing here can tell a read from a
 * write once it does. A read-only inspection reads with `innerText()`,
 * `getAttribute()`, `count()` and the ARIA tree instead.
 */
const MUTATING_OPERATIONS = new Set([
  'act',
  'nav.goto', 'nav.reload', 'nav.back', 'nav.forward',
  'tabs.new', 'tabs.close',
  'download.save', 'fs.write', 'profile.clear',
  // Running the body's own JavaScript in the page. Nothing here can tell a
  // read from a write — `document.forms[0].submit()` is a function call like
  // any other — so a read-only run cannot be allowed to do it and still mean
  // what it says. Reading is what the locator queries are for.
  'evaluate', 'evaluateAll',
])

/** Names of a string, with anything else in the array dropped. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

/**
 * Read the note left by whichever run of the machine wrote it last.
 * @returns the generation it belonged to, the names it held, and the names the
 * generation before it held.
 */
function ledger(): { generation: string, names: string[], previous: string[] } {
  try {
    const held = localStorage.getItem(TASK_LEDGER_KEY)
    if (held === null) return { generation: '', names: [], previous: [] }
    const parsed = JSON.parse(held) as { generation?: unknown, names?: unknown, previous?: unknown }
    return {
      generation: typeof parsed.generation === 'string' ? parsed.generation : '',
      names: stringsOf(parsed.names),
      previous: stringsOf(parsed.previous),
    }
  } catch {
    // No storage, or something else wrote there. The note is a courtesy.
    return { generation: '', names: [], previous: [] }
  }
}

/**
 * Note a task name against this run, and say whether an older run had it.
 *
 * The previous generation's names are carried in their own list rather than
 * replaced by the first task of this one: every name from before the reload
 * lost its pages, its globals and its login state, not only whichever one the
 * model happened to reach for first.
 * @param name - the task space being created.
 * @returns true when a task of this name existed before the page was reloaded.
 */
function noteTask(name: string): boolean {
  const generation = browserMachine().generation
  const held = ledger()
  const fresh = held.generation !== generation
  const previous = fresh ? held.names : held.previous
  const names = fresh ? [name] : [...new Set([...held.names, name])]
  try {
    localStorage.setItem(TASK_LEDGER_KEY, JSON.stringify({
      generation, names: names.slice(-32), previous: previous.slice(-32),
    }))
  } catch {
    // Storage full or refused; the ledger is not load-bearing.
  }
  return previous.includes(name)
}

/**
 * Take a name back out of this run's note.
 *
 * A task that was finished on purpose is not one that was lost to a reload,
 * and the note is what tells those apart.
 * @param name - the task space being finished.
 */
function forgetTask(name: string): void {
  const held = ledger()
  if (held.generation === '' || !held.names.includes(name)) return
  try {
    localStorage.setItem(TASK_LEDGER_KEY, JSON.stringify({
      generation: held.generation,
      names: held.names.filter((entry) => entry !== name),
      previous: held.previous,
    }))
  } catch {
    // Storage full or refused; the ledger is not load-bearing.
  }
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
  /**
   * Those pictures as attachments, once they have been made into them.
   *
   * Kept because a receipt is read more than once — the tool tells the model
   * to poll one while a body is still going — and each reading otherwise read
   * every picture back off the workspace, resized it, and stored another copy
   * in the attachment store under a new id.
   */
  images?: unknown[]
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

/** Every artifact folder this run of the machine has handed out. */
const artifactFolders = new Set<string>()

/**
 * A folder no other task has been given.
 *
 * `slug()` is lossy — it lower-cases, folds punctuation together and cuts at
 * forty-eight characters — so "Orders" and "orders" are two task spaces
 * sharing one folder, each with a screenshot counter of its own starting at
 * one. The second task's first picture overwrote the first's, and the first
 * task's receipt then pointed the model at the other task's page, which is
 * exactly the confusion the per-space counter exists to prevent.
 *
 * Remembered rather than asked of the live spaces, because a finished task's
 * files outlive it: its receipts still name `shot-1.png`, and a task created
 * after it was finished took the folder back and wrote over them. Names only,
 * so nothing of the space itself is held.
 * @param base - the slug of the task's name.
 * @param id - the space's own id, for telling two of them apart.
 * @returns an absolute folder.
 */
function artifactsFor(base: string, id: string): string {
  const wanted = `${ARTIFACT_ROOT}/${base}`
  const folder = artifactFolders.has(wanted) ? `${wanted}-${id.slice(-4)}` : wanted
  artifactFolders.add(folder)
  return folder
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
export async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
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
export async function readFile(path: string): Promise<Uint8Array> {
  if (await routedToRuntime(path)) return runtimeReadFile(path)
  return volume.readFile(path)
}

/**
 * Where a path a task named actually goes: a relative one is the workspace's,
 * which is the only root a task's code knows about.
 * @param wanted - what the task asked for.
 * @returns an absolute path.
 */
function absolute(wanted: string): string {
  return wanted.startsWith('/') ? wanted : `${WORKSPACE_ROOT}/${wanted}`
}

/**
 * How long the transport waits on a frame for one operation.
 *
 * The engine's own timer is a backstop for a document that has stopped
 * answering, not a second timeout policy: a fixed sixty seconds cut
 * `locator.click({timeout: 90000})` short at sixty, blamed the page for it —
 * "it may be busy in a script" — and dropped the answer the frame went on to
 * give.
 * @param wanted - the deadline the operation itself was given, if any.
 * @returns the milliseconds to wait on the frame.
 */
function transportTimeout(wanted: unknown): number {
  const asked = bounded(wanted, 0, 0, 600_000)
  // Room for the frame to report its own timeout first, so its message — which
  // says what the element was doing — is the one the body sees.
  return asked === 0 ? OPERATION_TIMEOUT_MS : Math.max(OPERATION_TIMEOUT_MS, asked + 5_000)
}

/**
 * Put a frame's token on the front of every ref in a snapshot it produced.
 *
 * Refs are minted per document, so `e3` in a frame and `e3` in the page around
 * it are different elements wearing the same name. `aria-ref=f1e3` is what
 * routes back to the frame that handed it out, and a snapshot that came from a
 * frame without one is a set of handles that resolve — silently, against the
 * wrong document — in the page above.
 * @param text - the rendered tree.
 * @param frame - the frame's token, or nothing for the tab's own document.
 * @returns the tree with its refs named after the document that owns them.
 */
function namespaceRefs(text: string, frame: string | undefined): string {
  return frame === undefined || frame === '' ? text : text.replace(/\[ref=e(\d+)\]/g, `[ref=${frame}e$1]`)
}

/** One named, persistent place for a task's code, pages and receipts. */
export class TaskSpace {
  readonly name: string
  readonly id = `task-${token().slice(0, 8)}`
  readonly generation: string

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

  /**
   * Whether a task of this name existed before the page was last reloaded.
   *
   * The space is new either way; this only says that somebody is about to
   * assume otherwise.
   */
  readonly revived: boolean

  #frame: HTMLIFrameElement | undefined
  readonly #nonce = token(12)
  #ready: Promise<void> | undefined
  #announce: (() => void) | undefined
  /** Told when the realm is not going to start, so nobody waits on it for ever. */
  #giveUp: ((error: Error) => void) | undefined
  #stopListening: (() => void) | undefined
  /** The run in flight, if any. */
  #current: { receipt: Receipt, settle: (receipt: Receipt) => void } | undefined

  /** Set between accepting a body and having a receipt to point at for it. */
  #starting = false

  /**
   * The page the last body left itself on.
   *
   * Not the same question as "the last tab this task opened", which is what
   * {@link activeTab} could answer on its own. A body that opens a popup,
   * reads it and calls `usePage(original)` is on the first page again — and
   * `browser_inspect {task}`, `checkpoint` and `foreground` all went on
   * looking at the popup, so a look meant to say what the task was about to
   * act on described a different page, and handed out refs minted in it.
   */
  #focused: string | undefined

  /**
   * Whether the body in flight promised not to change anything.
   *
   * Kept here as well as in the realm because here is where it can be *held*:
   * the realm guards by naming each method that acts, so an operation added to
   * {@link dispatch} without a matching name in that list is unguarded by
   * default, and `page.command('click', …)` spells its way past the list
   * entirely. This is the one place every operation goes through.
   */
  #readOnly = false
  /** Screenshots the run in flight has taken. */
  #shots: { path?: string, width: number, height: number, bytes: number }[] = []

  /**
   * How many pictures this space has ever taken.
   *
   * Not `#shots.length`: that list is emptied at the start of every run and
   * capped at eight, so naming a file from it made run two overwrite run one's
   * picture — and the receipt of run one then pointed at run two's page.
   */
  #shotCounter = 0
  #finished = false

  constructor(name: string) {
    this.name = name
    this.generation = browserMachine().generation
    this.artifacts = artifactsFor(slug(name), this.id)
    this.revived = noteTask(name)
  }

  /** Every page this task may drive. */
  pages(): TabInfo[] {
    const machine = browserMachine()
    return machine.tabs().filter((tab) => this.owned.has(tab.id) || this.claimed.has(tab.id))
  }

  /** The page a call acts on when it does not name one. */
  activeTab(): string | undefined {
    const live = this.pages()
    // What the body itself is on, when it is still a page of this task; the
    // last one opened otherwise, which is where a task that has not run yet is.
    if (this.#focused !== undefined && live.some((tab) => tab.id === this.#focused)) return this.#focused
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
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#announce = resolve
      this.#giveUp = reject
    })
    // Handled here as well as awaited below, because the two are not the same
    // moment: the realm bundle is fetched before anything parks on this
    // promise, and a failure there rejects it while nothing is listening —
    // which the browser reports as an unhandled rejection on top of the error
    // this call is already throwing.
    void this.#ready.catch(() => undefined)

    // Fetched here rather than imported at the top, because it is 30 kB of
    // source text that only a task space ever needs: a session that never runs
    // one should not carry it in the chunk the page boots from. After
    // `#ready` is set, so a second caller waits on the first rather than
    // opening a second frame — and forgotten again if it does not arrive, or
    // the next call would wait for ever on a promise nobody can settle.
    let BROWSER_REALM: string
    try {
      ;({ BROWSER_REALM } = await import('../generated/browser-realm.ts'))
    } catch (error) {
      throw this.#abandonStart('the task realm could not be loaded, so there is nowhere to run a body: '
        + (error instanceof Error ? error.message : String(error)))
    }

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

    // A realm that never announces itself is a failure, not a slow start: the
    // body would be posted into a frame with nobody listening, the receipt
    // would say `running` for ever, and every later call on this name would be
    // refused with "still running" for a body that was never received. The
    // timeout therefore *rejects* — which also settles the second caller, who
    // is waiting on this same promise with no timeout of its own.
    const waiting = this.#ready
    const timer = setTimeout(() => {
      this.#abandonStart(`the task realm for "${this.name}" did not start within 15s, so there is nowhere to `
        + 'run a body. Try the call again; if it keeps happening this deployment is refusing the sandboxed '
        + 'frame the realm lives in.')
    }, 15_000)
    try {
      await waiting
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Give up on a realm that is not going to start, and let it be tried again.
   *
   * Everything the half-built space was holding goes — the frame, both
   * listeners, and the promise every caller of {@link open} is parked on.
   * @param reason - what to tell them.
   * @returns the error, so a caller can throw it.
   */
  #abandonStart(reason: string): Error {
    const error = new Error(reason)
    const giveUp = this.#giveUp
    this.#ready = undefined
    this.#announce = undefined
    this.#giveUp = undefined
    this.#stopListening?.()
    this.#stopListening = undefined
    window.removeEventListener('message', this.#receive)
    this.#frame?.remove()
    this.#frame = undefined
    giveUp?.(error)
    return error
  }

  /** Hand the realm every event that belongs to one of this task's pages. */
  #forward(event: MachineEvent): void {
    // A page opened by one of this task's pages joins the task: that is what a
    // popup is, and a task that could not touch the tab its own click opened
    // would be unable to finish the flow it started.
    if (event.kind === 'page' && event.opener !== undefined
      && (this.owned.has(event.opener) || this.claimed.has(event.opener))) {
      this.owned.add(event.tab)
    }
    if (!this.owned.has(event.tab) && !this.claimed.has(event.tab)) return
    this.#post({ type: 'event', event })
  }

  /**
   * Tell the realm which pages this task has.
   *
   * Sent when the realm is made and again whenever a page is claimed into the
   * task: a tab handed over after the realm was already up is one the realm
   * has never heard of, so `usePage(tab)` refuses it and `pages()` leaves it
   * out while the host insists it belongs to the task.
   */
  announcePages(): void {
    this.#post({
      type: 'adopt',
      pages: this.pages().map((tab) => ({ tab: tab.id, url: tab.url, title: tab.title })),
      active: this.activeTab(),
      viewport: VIEWPORT,
    })
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
        this.#giveUp = undefined
        this.announcePages()
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
    if (typeof message.active === 'string' && message.active !== '') this.#focused = message.active
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
    this.#evictResources()
    receipt.resource = { id, bytes: bytes.length, preview: text.slice(0, 2000) }
  }

  /**
   * Drop the oldest spilled results once the space is holding too many bytes.
   *
   * A task space is meant to be long-lived — one job, many calls — and every
   * call that returned more than {@link INLINE_LIMIT} left a whole extraction
   * here. Nothing evicted them but `finish`, which nothing forces, so a
   * pagination job that spilled forty times pinned all forty in the tab for as
   * long as it was open. The newest are the ones a caller is reading, and a
   * handle that has been dropped is already answered with a message saying so.
   */
  #evictResources(): void {
    let held = 0
    for (const resource of this.resources.values()) held += resource.bytes.length
    for (const [id, resource] of this.resources) {
      if (held <= RESOURCE_BUDGET_BYTES) break
      held -= resource.bytes.length
      this.resources.delete(id)
    }
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
    // Claimed before the awaits below, not after: the assignment of `#current`
    // used to sit past `open()`, so two calls in the same tick both saw it
    // undefined, both started a body, and the first one's receipt never
    // settled. See `browser_tasks {action: "finish"}` for the way out of a
    // body that will not return.
    if (this.#starting || this.#current !== undefined) {
      const held = this.#current?.receipt.requestId ?? 'a body that has not reported yet'
      throw new Error(`task "${this.name}" is still running ${held}. `
        + 'Read its receipt rather than starting another body: one task space runs one thing at a time. '
        + '`browser_tasks {action: "finish", task}` ends it if it will not return.')
    }
    this.#starting = true

    let settled: Promise<Receipt>
    let receipt: Receipt
    try {
      await this.open()
      this.#shots = []
      // Bringing a page forward is a thing the *user* asks for. A task that
      // did it on its own would take the machine panel away from whatever the
      // person watching it was looking at, several times a minute.
      if (options.foreground === true) {
        const front = this.activeTab()
        if (front !== undefined) machine.selectTab(front)
      }
      receipt = {
        requestId,
        task: this.name,
        generation: this.generation,
        state: 'running',
        startedAt: Date.now(),
        // While a body is in flight nobody knows what it has done, and this is
        // exactly the receipt a caller reads when the call came back STILL
        // RUNNING. `none` is documented as "the body performed no action at
        // all" and is what the retry advice keys off, so claiming it here
        // named the one state where repeating turns one order into two.
        // `#settle` replaces this the moment the body reports.
        mutation: options.readOnly === true ? 'none' : 'possible',
        fingerprint: mark,
      }
      this.receipts.set(requestId, receipt)
      settled = new Promise<Receipt>((resolve) => {
        this.#current = { receipt, settle: resolve }
      })
    } finally {
      // Whatever happened, the space is no longer half-way into starting: a
      // throw between the claim and the receipt would otherwise leave it
      // refusing every later body with "still running" and nothing to read.
      this.#starting = false
    }
    this.#readOnly = options.readOnly === true
    this.#post({
      type: 'run',
      id: requestId,
      code,
      readOnly: options.readOnly === true,
      artifacts: this.artifacts,
      task: this.name,
      tab: this.activeTab(),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    })
    return this.#race(settled, receipt, options.waitMs ?? DEFAULT_WAIT_MS)
  }

  /** Wait for a receipt to settle, or report that it has not. */
  async #race(settled: Promise<Receipt>, receipt: Receipt, waitMs: number): Promise<Receipt> {
    // Cleared, not abandoned. `Promise.race` drops the losing promise but not
    // its timer, and the callback holds the receipt — its value, its log and
    // its screenshots — for the whole `waitMs` after a body that finished in
    // 200ms had already reported.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        settled,
        new Promise<Receipt>((resolve) => {
          timer = setTimeout(() => {
            // Not a failure: the body is still running in the realm and will
            // finish. The caller gets the receipt to poll rather than a timeout
            // that says nothing about what the page is doing.
            resolve(receipt)
          }, waitMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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
    // The page the task is *on*, not the last one it opened. See {@link
    // #focused}: a body that opens a popup, reads it and calls
    // `usePage(original)` is back on the first page, and this is the tool the
    // model is told to read when it does not know whether an interrupted
    // action landed — describing the popup instead answered about the wrong
    // document entirely.
    const focused = this.activeTab()
    const active = pages.find((tab) => tab.id === focused)
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
      throw new Error(`no resource ${id} in task "${this.name}". Resources belong to the task that produced `
        + 'them, and the oldest are dropped once a space is holding too many bytes — run the body again, or '
        + 'write large results to a file with saveFile(path, value).')
    }
    const start = codePointStart(held.bytes, bounded(offset, 0, 0, held.bytes.length))
    const wanted = start + bounded(maxBytes, SLICE_BYTES, 1024, 65_536)
    // Back to a character boundary, so a slice never cuts a `é` in half. The
    // caller is told to continue from `nextOffset` until `eof`, and a decoder
    // given half a sequence emits U+FFFD at the tail and again at the head of
    // the next slice — two silent corruptions per read of any text that is not
    // ASCII.
    const end = codePointStart(held.bytes, Math.min(wanted, held.bytes.length))
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
    // The run that is still going, settled before its realm is taken away.
    // `finish` is what the tool tells the model to reach for when a body will
    // not return, and without this the receipt was left saying `running` for
    // ever while the space it belonged to was deleted — so the follow-up the
    // recovery guidance asks for answered "no task space named …" instead of
    // saying an action had been interrupted and might have landed.
    const current = this.#current
    if (current !== undefined) {
      current.receipt.state = 'interrupted'
      current.receipt.finishedAt = Date.now()
      // `mutation` is left exactly as the run set it — `possible` for one that
      // could act, `none` for a read-only one — because that is the field the
      // recovery guidance reads and this is not new information about it.
      this.#current = undefined
      current.settle(current.receipt)
    }
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
    // And out of the ledger, which is otherwise only ever written to. A name
    // left there is one the next run of this machine reports as a task that
    // "did not survive the reload" — a warning about lost pages and globals,
    // raised on exactly the flow that finished its task properly.
    forgetTask(this.name)
    // A finished space is unreachable — `findTaskSpace` answers undefined for
    // it and `taskSpace` builds a new one under the same name — so everything
    // it is still holding is held for nobody. The spilled results are the part
    // that matters: they are whole extractions, megabytes each, and without
    // this they would sit here for as long as the tab is open.
    this.resources.clear()
    if (spaces.get(this.name) === this) spaces.delete(this.name)
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
    // Claimed the moment the tab exists rather than when `newTab` resolves:
    // its `page`, `navigated` and `load` events are emitted in between, and
    // `#forward` drops every event for a tab this task does not yet own.
    const created = await machine.newTab(undefined, {
      background: this.pages().length > 0,
      created: (id) => this.owned.add(id),
    })
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
   * Refuse an operation a read-only run is not allowed to perform.
   * @param op - which operation.
   * @param params - its arguments, for the ones that only sometimes act.
   */
  #refuseIfReadOnly(op: string, params: Record<string, unknown>): void {
    if (!this.#readOnly) return
    const acts = MUTATING_OPERATIONS.has(op)
      || (op === 'page.command' && MUTATING_COMMANDS.has(String(params.kind)))
      || (op === 'request.fetch' && !['GET', 'HEAD'].includes(String(params.method ?? 'GET').toUpperCase()))
      // A screenshot into the task's own folder is a read — that is how a
      // read-only look reports what it saw. One that *names* a file is a write
      // to whatever it named, and `readOnly` promises the inspection cannot
      // make anything worse.
      || (op === 'page.screenshot' && params.path !== undefined && String(params.path) !== '')
    if (!acts) return
    const detail = op === 'evaluate' || op === 'evaluateAll' || String(params.kind ?? '').startsWith('evaluate')
      ? ' Evaluating runs your own code in the page, and nothing here can tell a read from a write; '
        + 'read with innerText(), getAttribute(), count() or browser_inspect instead.'
      : ''
    throw new Error(`${op} would change something, and this call is read-only.${detail} Run it again without `
      + 'readOnly to act, or keep the inspection read-only and act in a separate call.')
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
    this.#refuseIfReadOnly(op, params)

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
        // The seven cases above are exactly the seven commands, under the same
        // names. Spelling the mapping out invited a new case to be added to the
        // switch and silently answered as `actionability`.
        const kind = `locator.${op}`
        const payload: Record<string, unknown> = { chain: params.chain }
        for (const key of ['action', 'args', 'query', 'state', 'source', 'argument', 'timeoutMs', 'force']) {
          if (params[key] !== undefined) payload[key] = params[key]
        }
        // An action's own deadline is inside `args` — `locator.click({timeout})`
        // — while a wait puts it at the top level. Both have to reach the
        // transport, or a 90s click is cut off at sixty and blamed on the page.
        const asked = (payload.args as Record<string, unknown> | undefined)?.timeout ?? payload.timeoutMs
        const value = await machine.run(kind, payload, tab, {
          ...(frame === undefined ? {} : { frame }),
          timeoutMs: transportTimeout(asked),
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
        const sent = (params.payload as Record<string, unknown> | undefined) ?? {}
        return machine.run(String(params.kind), sent, tab, {
          ...(frame === undefined ? {} : { frame }),
          timeoutMs: transportTimeout(sent.timeoutMs),
        })
      }

      case 'aria.snapshot': {
        const tab = await this.#target(params)
        const frame = await this.#intoFrame(tab, params.framePath, params.frameToken)
        const answer = await machine.run('aria.snapshot', {
          // The chain is what makes this a snapshot *of a locator*. Without it
          // the frame answers with the whole document — and re-mints every ref
          // in it, so the handles a look had just handed out stop resolving.
          ...(params.chain === undefined ? {} : { chain: params.chain }),
          ...(params.depth === undefined ? {} : { depth: params.depth }),
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
          ...(params.boxes === undefined ? {} : { boxes: params.boxes }),
        }, tab, {
          ...(frame === undefined ? {} : { frame }),
          timeoutMs: OPERATION_TIMEOUT_MS,
        }) as Record<string, unknown>
        // Named after the document that answered, the same way a look at the
        // page names them. Without this a snapshot taken *inside* a frame handed
        // back bare `e3`s, which `page.locator('aria-ref=e3')` then resolved in
        // the page above — a different element, and no error to say so.
        return { ...answer, text: namespaceRefs(String(answer.text ?? ''), frame) }
      }

      case 'observe': {
        const tab = await this.#target(params)
        return observePage(tab, params)
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
        // The status the response carried, not one inferred from `tab.error` —
        // which only the non-HTML branch of `#render` sets, so an HTML 404 came
        // back as `200` and `response.ok()` was true on the error page a body
        // was about to scrape as if it were the page it asked for.
        return {
          tab,
          url: info.url,
          title: info.title,
          status: info.status ?? (info.error === undefined ? 200 : 0),
          error: info.error,
        }
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
          created: (id) => this.owned.add(id),
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
        // A clip that came from a locator inside a frame is in that frame's
        // coordinates, so the frame is the document that has to take it.
        const frame = await this.#intoFrame(tab, params.framePath, params.frameToken)
        return this.screenshot(tab, params, frame)
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
        // A suggested filename is whatever the site put in its `download`
        // attribute, so it names a leaf of this task's folder and nothing else.
        const suggested = String(params.suggestedFilename ?? 'download').replaceAll('\\', '/')
        const leaf = suggested.slice(suggested.lastIndexOf('/') + 1).replaceAll('..', '')
        const path = wanted === ''
          ? `${this.artifacts}/${leaf === '' ? 'download' : leaf}`
          : absolute(wanted)
        await writeFile(path, response.bytes)
        return { path, bytes: response.bytes.length, url: response.url }
      }

      case 'fs.write': {
        const wanted = String(params.path ?? '')
        if (wanted === '') throw new Error('saveFile() needs a path')
        const path = absolute(wanted)
        const bytes = fromBase64(String(params.base64 ?? ''))
        await writeFile(path, bytes)
        return { path, bytes: bytes.length }
      }

      case 'fs.readMany': {
        const paths = (params.paths as string[] | undefined) ?? []
        // Independent reads, and each one may be a round trip to the container
        // that holds the workspace. `map` keeps them in the order asked for.
        return Promise.all(paths.map(async (entry) => {
          const path = absolute(entry)
          return {
            name: path.slice(path.lastIndexOf('/') + 1),
            mimeType: mimeOf(path),
            base64: base64(await readFile(path)),
          }
        }))
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
   * @param frame - the nested frame to photograph, when the region belongs to
   * one; a clip is in the coordinates of the document that produced it.
   * @returns where it went and how big it is.
   */
  async screenshot(tab: string, params: Record<string, unknown>, frame?: string): Promise<{
    path: string, width: number, height: number, bytes: number
  }> {
    const machine = browserMachine()
    const taken = await machine.run('screenshot', {
      fullPage: params.fullPage === true,
      ...(params.clip === undefined ? {} : { clip: params.clip }),
    }, tab, {
      ...(frame === undefined ? {} : { frame }),
      timeoutMs: OPERATION_TIMEOUT_MS,
    }) as { dataUrl: string, width: number, height: number }
    const bytes = fromBase64(taken.dataUrl.slice(taken.dataUrl.indexOf(',') + 1))
    const wanted = params.path === undefined ? '' : String(params.path)
    const path = wanted === ''
      ? `${this.artifacts}/shot-${String(++this.#shotCounter)}.png`
      : absolute(wanted)
    await writeFile(path, bytes)
    const shot = { path, width: taken.width, height: taken.height, bytes: bytes.length }
    this.noteScreenshot(shot)
    return shot
  }

}

/** One nested frame, as an observation reports it. */
export interface ObservedFrame {
  token: string
  name: string
  src: string
  visible: boolean
  actionable: boolean
  occludedBy?: string
  viewportIntersection: number
  url?: string
  title?: string
  snapshot?: string
  truncated?: boolean
  error?: string
}

/**
 * What one look at a page reports.
 *
 * Declared here rather than at each reader: there is one producer, and a
 * reader that restates the shape is a reader that can be wrong about it.
 */
export interface PageObservation {
  url: string
  title: string
  snapshot: string
  truncated: boolean
  scroll: { x: number, y: number }
  size: { width: number, height: number }
  focus?: { tag: string, role: string, name: string, editable: boolean, inFrame?: string }
  frames?: ObservedFrame[]
  /** How many frames were not looked inside, when the cap was reached. */
  moreFrames?: number
  dialogs?: { kind: string, message: string, answer: string }[]
  /** What the frame with focus says about it, when focus is inside one. */
  frameFocus?: unknown
}

/**
 * The page an observation is about: a named task's, or the machine's own.
 *
 * Here rather than in the tool, because the machine bridge answers the same
 * question for the suites and its own copy had already lost the refusal — an
 * unknown task name fell through to whatever tab happened to be in front and
 * described the wrong page as if it were the task's.
 * @param task - the task space's name, or undefined for the machine itself.
 * @param tab - a tab named outright, which wins.
 * @returns the tab to look at.
 */
export function observationTab(task?: string, tab?: string): string {
  const named = task === undefined || task === '' ? undefined : task
  const space = named === undefined ? undefined : findTaskSpace(named)
  if (named !== undefined && space === undefined) {
    throw new Error(`no task space named "${named}"; browser_tasks lists them`)
  }
  // A named task answers about its own page or about nothing. Falling through
  // to the machine's active tab described whichever page happened to be in
  // front — possibly another task's — as if it were this one's, and handed
  // back refs minted in it.
  const chosen = tab ?? (space === undefined
    ? browserMachine().tabs().find((entry) => entry.active)?.id
    : space.activeTab())
  if (chosen === undefined) {
    throw new Error(space === undefined
      ? 'no tab is open — open one with browser_navigate'
      : `task "${space.name}" has no page yet; run a body that navigates, or drop the \`task\` argument `
        + 'to look at the machine\'s active tab')
  }
  return chosen
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
export async function observePage(tab: string, options: Record<string, unknown>): Promise<PageObservation> {
  const machine = browserMachine()
  const frames = String(options.frames ?? 'visible')
  const observation = await machine.run('observe', {
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    focus: options.focus !== false,
    frames,
    ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
  }, tab, { timeoutMs: OPERATION_TIMEOUT_MS }) as PageObservation

  if (frames !== 'none' && Array.isArray(observation.frames)) {
    const maxFrames = bounded(options.maxFrames, 8, 1, 32)
    const frameMaxChars = bounded(options.frameMaxChars, 2000, 256, 6000)
    // Each frame is its own document, and asking one says nothing about the
    // next: eight sequential round trips cost the sum of eight snapshots where
    // asking together costs the slowest. Every command already carries its own
    // id, and each frame keeps its own failure, so the answers still land in
    // the order the frames were in.
    // Said rather than silently dropped: a page with twelve frames and a cap of
    // eight reported eight, with `truncated` describing only the tree's budget
    // — so a model told to "ask for more only when the answer was truncated"
    // concluded the ninth frame did not exist.
    const total = observation.frames.length
    const detailed = await Promise.all(observation.frames.slice(0, maxFrames).map(async (frame) => {
      const entry: Record<string, unknown> = { ...frame }
      if (frame.token === '') return entry
      try {
        const inner = await machine.run('observe', {
          maxChars: frameMaxChars,
          depth: bounded(options.depth, 12, 1, 20),
          focus: false,
          frames: 'none',
        }, tab, { frame: frame.token, timeoutMs: OPERATION_TIMEOUT_MS }) as Record<string, unknown>
        entry.url = inner.url
        entry.title = inner.title
        entry.snapshot = namespaceRefs(String(inner.snapshot ?? ''), frame.token)
        entry.truncated = inner.truncated
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
      }
      return entry
    }))
    observation.frames = detailed as unknown as ObservedFrame[]
    if (total > maxFrames) observation.moreFrames = total - maxFrames
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
  // Prototype-less: the extension comes off a path a body chose, so
  // `report.constructor` would otherwise answer `Object` — a function, which
  // `??` does not fall through and structured clone refuses on the way back.
  const known: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', csv: 'text/csv',
    txt: 'text/plain', md: 'text/markdown', html: 'text/html', zip: 'application/zip',
    // What an upload form is actually offered. The type here is what the page
    // sees on `file.type`, so an extension missing from this table arrives as
    // `application/octet-stream` and every `accept=".xlsx"` refuses it.
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', doc: 'application/msword', rtf: 'application/rtf',
    xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
    js: 'text/javascript', ts: 'text/plain', css: 'text/css', tsv: 'text/tab-separated-values',
    ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
    gz: 'application/gzip', tar: 'application/x-tar',
  })
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
  const live = taskSpaces()
  if (live.length >= MAX_TASKS) {
    throw new Error(`this machine holds ${String(MAX_TASKS)} task spaces at once, and they are all in use: `
      + `${live.map((space) => `"${space.name}"`).join(', ')}. Finish one you are done with — `
      + '`browser_tasks {action: "finish", task}` — or carry on in one of them; a task space is meant to be '
      + 'one job, not one step.')
  }
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
  // And not one another task is already driving. `browser_tabs` lists every
  // tab in the machine, including other tasks' pages, so "claim this id" was
  // one plausible id away from two bodies acting on one document — and from
  // the owner's `finish` closing a page the claimer was still using, since
  // `finish` only spares the tabs *it* claimed.
  const owner = taskSpaces().find((other) => other !== space
    && (other.owned.has(tab) || other.claimed.has(tab)))
  if (owner !== undefined) {
    throw new Error(`tab ${tab} belongs to task "${owner.name}", which is still open. Two tasks driving one `
      + 'page is how one of them closes it under the other; carry on in that task, or finish it first — '
      + '`browser_tasks {action: "finish", task}` with `keep: true` leaves its pages open to be claimed.')
  }
  space.claimed.add(tab)
  // The realm learns its pages from `adopt`, which it is only sent once unless
  // somebody says otherwise. A no-op while the realm is not up yet; the `ready`
  // handler sends the same message then.
  space.announcePages()
}
