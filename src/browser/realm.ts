/**
 * The realm a task space's code runs in, and the browser API it is given.
 *
 * A task space is the thing this machine was missing. `browser_click` and its
 * siblings are one action per tool call, which is fine for "open this page and
 * read it" and hopeless for anything with a loop in it: twenty rows of a table
 * is twenty round trips through a model, each one costing a snapshot to find a
 * ref that the last click invalidated. What that work wants is a *program* —
 * and a program wants somewhere to run and something to run against.
 *
 * ## Where it runs, and why it is not the page this harness is in
 *
 * The obvious place to evaluate model-written JavaScript is the host: it is
 * where the tools already execute, and everything the code needs is a function
 * call away. It is also where this build keeps the user's API keys, their
 * sessions and their files, and the model driving it spends its day reading
 * pages written by strangers. A page that talks a model into running one line
 * of JavaScript would have the keys.
 *
 * So the realm is a sandboxed frame with an opaque origin — the same boundary
 * `src/browser/engine.ts` puts around a browsed page, for the same reason and
 * with the same measurements behind it: no `localStorage`, no `indexedDB`, no
 * `document` of the parent, no way to name the harness at all. Everything it
 * can do, it does by asking the host, and the host does only what the ops in
 * this protocol describe. The cost is that every call is asynchronous — which
 * costs nothing at all, because the API being implemented is asynchronous
 * already.
 *
 * ## What it implements
 *
 * Playwright's client API, near enough that recipes written for it run
 * unchanged: `page`, `context`, locators that re-resolve, auto-waiting
 * actions, retrying `expect`, frames, dialogs, downloads, uploads, and
 * `context.request`. Not because this build has Playwright in it — it cannot;
 * that is a driver process talking a wire protocol to a real browser — but
 * because that API is the one every model has already seen, and a model that
 * recognises `getByRole('button', {name: 'Save'}).click()` spends its turn on
 * the task instead of on the notation.
 *
 * Where this machine genuinely cannot do something, the method is present and
 * throws with the reason, which is the honest shape: a missing method reads as
 * a typo, and a method that silently does nothing reads as a page that ignored
 * the click.
 */

/**
 * The wire vocabulary, from the module at the other end of it.
 *
 * A type-only import, which esbuild erases: this file is bundled on its own
 * into an opaque origin and imports nothing at run time. What it buys is that
 * a step this side invents and the other side does not read is a compile
 * error rather than a locator that silently matches nothing.
 */
import type { MachineEvent } from './engine.ts'
import type { TextMatch } from './frame-locate.ts'
import { MUTATING_COMMANDS, base64, bounded, fromBase64 } from './protocol.ts'

/** What the host sends when it wants code run. */
interface RunMessage {
  type: 'run'
  id: string
  code: string
  readOnly: boolean
  artifacts: string
  task: string
  tab?: string
  diagnostics?: string
}

declare global {
  interface Window {
    __REALM_NONCE__?: string
  }
}

/** The nonce every message in both directions carries. */
const nonce = window.__REALM_NONCE__ ?? ''

/**
 * Post one message to the host.
 *
 * To `parent`, which is the page that made this frame. Not `top`: this app can
 * itself be embedded, and there `top` is somebody else's document.
 */
function post(message: Record<string, unknown>): void {
  parent.postMessage({ realm: true, nonce, ...message }, '*')
}

/**
 * The least time one call on the host is given before the body is told it will
 * not be answered. Above the host's own 60s per-operation limit, so its message
 * — which says what the page was doing — arrives first where there is one; a
 * call that carries a longer deadline of its own raises this. See
 * {@link rpcDeadline}.
 */
const RPC_TIMEOUT_MS = 90_000

/** What a `waitFor()` with no timeout of its own gets; `frame.ts` agrees. */
const WAIT_TIMEOUT_MS = 10_000

/** The longest any wait here runs for, and what `{timeout: 0}` is taken to mean. */
const MAX_TIMEOUT_MS = 600_000

/** What an action waits for actionability by default; `frame-locate.ts` agrees. */
const ACTION_TIMEOUT_MS = 15_000

/** Calls waiting on the host, by id. */
const pending = new Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()

let nextCall = 0

/** Set while a run is being abandoned, so nothing new is started. */
let abandoned: string | undefined

/**
 * Ask the host to do something and wait for the answer.
 * @param op - which operation.
 * @param params - its arguments.
 * @returns whatever the host produced.
 */
async function rpc(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (abandoned !== undefined) throw new Error(abandoned)
  const id = `c${String(++nextCall)}`
  const limit = rpcDeadline(params)
  return new Promise<unknown>((resolve, reject) => {
    // Longer than the host's own limit for *this* call, so its message wins
    // whenever it has one. This is for the case where no answer is coming at
    // all — a host that went away mid-call otherwise leaves the body awaiting
    // a promise nobody can settle, which reads to everyone above as a task
    // that is still running and wedges the space until it is finished.
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the machine did not answer ${op} within ${String(Math.round(limit / 1000))}s. `
        + 'The page may be busy in a script, or this task space may have been finished while the body '
        + 'was running.'))
    }, limit)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    post({ type: 'rpc', id, op, params })
  })
}

/**
 * How long to wait on the host for one call.
 *
 * A flat ninety seconds was below what the host itself was prepared to wait:
 * `transportTimeout` there extends its own deadline to the operation's plus
 * five seconds, up to ten minutes — so `locator.click({timeout: 120000})` was
 * rejected here at ninety with a message about a busy page while the click was
 * still in flight, and the receipt was written from a run that believed
 * nothing had happened. The two shapes an operation's own deadline arrives in
 * are the two the host reads, in the same order.
 * @param params - the call's arguments.
 * @returns the milliseconds to wait.
 */
function rpcDeadline(params: Record<string, unknown>): number {
  const args = params.args as Record<string, unknown> | undefined
  const payload = params.payload as Record<string, unknown> | undefined
  const asked = Number(args?.timeout ?? params.timeoutMs ?? payload?.timeoutMs ?? 0)
  // Room above the host's own limit for the same call, so its message — which
  // says what the element was doing — is the one the body sees.
  return Number.isFinite(asked) && asked > 0 ? Math.max(RPC_TIMEOUT_MS, asked + 15_000) : RPC_TIMEOUT_MS
}

/**
 * A timeout an option asked for, as milliseconds this machine can wait out.
 *
 * Every deadline here is `Date.now() + timeout`, and `Date.now() > NaN` is
 * false for ever — so a body that wrote `{timeout: '15s'}` did not get an
 * error, it got a `for (;;)` that polls until the space is finished by hand.
 *
 * `0` is not zero. In the API this imitates it means "no timeout", and taking
 * it literally made `waitForURL(pattern, {timeout: 0})` — the idiom for "wait
 * as long as it takes" — poll once and blame the page. It becomes the longest
 * this machine will wait instead, which is the nearest thing it has.
 * @param wanted - what the body asked for.
 * @param fallback - the default for this wait.
 * @returns a number of milliseconds.
 */
function timeoutOf(wanted: unknown, fallback: number): number {
  if (wanted === 0) return MAX_TIMEOUT_MS
  return bounded(wanted, fallback, 0, MAX_TIMEOUT_MS)
}

/** Whether this run may change anything, and what to say when it may not. */
let readOnly = false

/** Set once anything that could change a page has been attempted. */
let mutated = false

/** Where files this run writes belong. */
let artifactRoot = '/tmp'

/**
 * A path inside this task's own folder.
 *
 * Sub-folders are allowed — a run that writes a file per page wants them — but
 * nothing that climbs out of the root this task owns.
 * @param name - what the body asked to call it.
 * @returns an absolute path under {@link artifactRoot}.
 */
function artifactPath(name: string): string {
  const cleaned = String(name).replaceAll('\\', '/').replace(/^\/+/, '').replaceAll('..', '')
  return `${artifactRoot}/${cleaned === '' ? 'file' : cleaned}`
}

/**
 * The same folder, for a name that came off a page rather than out of the body.
 *
 * A download's suggested name is whatever the site put in its `download`
 * attribute, and `../../../.claude/settings.json` is a valid one — so a name
 * this machine did not choose is reduced to a leaf before it names a file.
 * @param name - the page's suggestion.
 * @returns an absolute path directly inside {@link artifactRoot}.
 */
function artifactLeaf(name: string): string {
  const flat = String(name).replaceAll('\\', '/')
  return artifactPath(flat.slice(flat.lastIndexOf('/') + 1) || 'download')
}

/**
 * Refuse an action that a read-only run is not allowed to take.
 * @param what - the action's name, for the message.
 */
function guard(what: string): void {
  if (readOnly) {
    throw new Error(`${what} would change the page, and this call is read-only. Run it again without `
      + 'readOnly to act, or keep the inspection read-only and act in a separate call.')
  }
  mutated = true
}

// ---------------------------------------------------------------------------
// locators
// ---------------------------------------------------------------------------

/** One step of a locator chain, as `src/browser/frame-locate.ts` reads it. */
type Step = Record<string, unknown> & { kind: string }

/**
 * The nested frame a chain names, when one of its steps does.
 *
 * A ref minted inside a frame carries that frame's token, and it is not always
 * the first step: `page.locator('form').locator('aria-ref=f1e12')` puts it
 * second.
 * @param chain - the steps.
 * @returns the frame's token, or nothing for the tab's own document.
 */
function framedBy(chain: Step[]): string | undefined {
  const held = chain.find((step) => typeof step.frame === 'string' && step.frame !== '')?.frame
  return typeof held === 'string' && held !== '' ? held : undefined
}

/**
 * Turn what a caller passed into a text match.
 * @param value - a string or a regular expression.
 * @param exact - whether a string must match exactly.
 * @returns the match.
 */
function textMatch(value: unknown, exact?: boolean): TextMatch {
  if (value instanceof RegExp) return { regex: { source: value.source, flags: value.flags } }
  return { text: String(value ?? ''), ...(exact === undefined ? {} : { exact }) }
}

/** Options `getByRole` accepts. */
interface RoleOptions {
  name?: string | RegExp
  exact?: boolean
  level?: number
  checked?: boolean
  pressed?: boolean
  selected?: boolean
  expanded?: boolean
  disabled?: boolean
  includeHidden?: boolean
}

/**
 * The steps `getBy*` and `locator()` produce, shared by everything that has
 * them: a page, a locator and a frame locator all select the same way.
 * @param selector - a CSS selector, an XPath, or an `aria-ref=` handle.
 * @returns the step.
 */
function selectorStep(selector: string): Step {
  if (selector.startsWith('aria-ref=')) {
    // `e12` names a node in this document; `f1e12` names one inside the frame
    // `f1`, which is how a look at a framed page hands out refs that do not
    // collide with the page's own.
    const handle = selector.slice('aria-ref='.length)
    const framed = /^(f\d+)(e\d+)$/.exec(handle)
    return framed === null
      ? { kind: 'ariaRef', ref: handle }
      : { kind: 'ariaRef', ref: framed[2] ?? '', frame: framed[1] ?? '' }
  }
  if (selector.startsWith('xpath=')) return { kind: 'xpath', selector: selector.slice('xpath='.length) }
  if (selector.startsWith('//') || selector.startsWith('..')) return { kind: 'xpath', selector }
  if (selector.startsWith('text=')) return { kind: 'text', match: textMatch(selector.slice('text='.length)) }
  if (selector.startsWith('css=')) return { kind: 'css', selector: selector.slice('css='.length) }
  return { kind: 'css', selector }
}

/** Every way of naming elements, mixed into the three things that have them. */
interface Selectors {
  locator(selector: string, options?: { hasText?: string | RegExp, hasNotText?: string | RegExp, has?: Locator, hasNot?: Locator }): Locator
  getByRole(role: string, options?: RoleOptions): Locator
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByAltText(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByTitle(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByTestId(id: string | RegExp): Locator
  frameLocator(selector: string): FrameLocator
}

/**
 * Add the selector methods to something that can extend a chain.
 * @param make - builds the next locator from the steps to append.
 * @returns the methods.
 */
function selectors(make: (steps: Step[]) => Locator): Selectors {
  return {
    locator(selector, options) {
      let next = make([selectorStep(selector)])
      if (options !== undefined) next = next.filter(options)
      return next
    },
    getByRole(role, options = {}) {
      const step: Step = { kind: 'role', role }
      if (options.name !== undefined) step.name = textMatch(options.name, options.exact)
      for (const key of ['level', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'includeHidden'] as const) {
        if (options[key] !== undefined) step[key] = options[key]
      }
      return make([step])
    },
    getByText: (text, options) => make([{ kind: 'text', match: textMatch(text, options?.exact) }]),
    getByLabel: (text, options) => make([{ kind: 'label', match: textMatch(text, options?.exact) }]),
    getByPlaceholder: (text, options) => make([{ kind: 'placeholder', match: textMatch(text, options?.exact) }]),
    getByAltText: (text, options) => make([{ kind: 'altText', match: textMatch(text, options?.exact) }]),
    getByTitle: (text, options) => make([{ kind: 'title', match: textMatch(text, options?.exact) }]),
    getByTestId: (id) => make([{ kind: 'testId', match: textMatch(id, true) }]),
    frameLocator: (selector) => new FrameLocator(make([selectorStep(selector)])),
  }
}

/**
 * What {@link selectors} installs, told to the type system once.
 *
 * All three classes below take these methods from `Object.assign` in their
 * constructor, which the compiler cannot see. Declaration merging is how it is
 * told — one line per class, rather than nine restated field declarations that
 * have to be kept in step with {@link Selectors} by hand.
 */
interface Locator extends Selectors {}
interface FrameLocator extends Selectors {}
interface Page extends Selectors {}

/**
 * A description of elements, resolved fresh every time it is used.
 *
 * The whole value of the shape is that this object holds no element. It holds
 * the *question*, and the question is asked again on every call — so a page
 * that re-rendered between two lines of a task does not invalidate anything,
 * which is the failure mode that makes ref-based driving so tiring to write
 * against.
 */
class Locator implements Selectors {
  readonly page: Page
  /** The chains that walk into each nested frame on the way to this one. */
  readonly framePath: Step[][]
  readonly chain: Step[]

  constructor(page: Page, framePath: Step[][], chain: Step[]) {
    this.page = page
    this.framePath = framePath
    this.chain = chain
    Object.assign(this, selectors((steps) => new Locator(this.page, this.framePath, [...this.chain, ...steps])))
  }

  /**
   * Where this locator lives, as every rpc about it has to say it.
   *
   * Stated once because a call that leaves it out is answered by the top
   * document instead of the frame the locator is in — which does not fail, it
   * matches something else.
   * @returns the tab, the frames on the way in, and the chain itself.
   */
  address(): Record<string, unknown> {
    const framed = framedBy(this.chain)
    return {
      tab: this.page.tabId,
      framePath: this.framePath,
      ...(framed === undefined ? {} : { frameToken: framed }),
      chain: this.chain,
    }
  }

  /** The op every call on this locator sends. */
  async #call(op: string, params: Record<string, unknown>): Promise<unknown> {
    return rpc(op, { ...this.address(), ...params })
  }

  /** The nth match, counting from zero. */
  nth(index: number): Locator {
    return new Locator(this.page, this.framePath, [...this.chain, { kind: 'nth', index }])
  }

  /** The first match. */
  first(): Locator { return this.nth(0) }

  /** The last match. */
  last(): Locator { return this.nth(-1) }

  /**
   * A second locator's steps, checked to be answerable in the same document.
   *
   * Only the chain crosses to the frame; the frames on the way in do not. So a
   * locator from another frame, handed to `filter`, `and`, `or` or `dragTo`,
   * was quietly re-resolved against *this* document — matching nothing after a
   * fifteen-second wait, or matching something else entirely and reporting
   * success.
   * @param other - the locator being combined with this one.
   * @param what - the method's name, for the message.
   * @returns the other locator's steps.
   */
  #sameDocument(other: Locator, what: string): Step[] {
    // The token as well as the path. Only the chain crosses to the frame, so a
    // locator built on `aria-ref=f1e9` and handed to a locator in the page
    // above shares its (empty) `framePath` and was sent to the top document,
    // where `e9` is a different element and the action reported success.
    if (JSON.stringify(other.framePath) !== JSON.stringify(this.framePath)
      || framedBy(other.chain) !== framedBy(this.chain)) {
      throw new Error(`${what} was given a locator from a different frame. Both sides are resolved in one `
        + 'document, so build the other one from the same frameLocator().')
    }
    return other.chain
  }

  /** Only the matches that also satisfy this. */
  filter(options: { hasText?: string | RegExp, hasNotText?: string | RegExp, has?: Locator, hasNot?: Locator, visible?: boolean }): Locator {
    const step: Step = { kind: 'filter' }
    if (options.hasText !== undefined) step.hasText = textMatch(options.hasText)
    if (options.hasNotText !== undefined) step.hasNotText = textMatch(options.hasNotText)
    if (options.has !== undefined) step.has = this.#sameDocument(options.has, 'filter({has})')
    if (options.hasNot !== undefined) step.hasNot = this.#sameDocument(options.hasNot, 'filter({hasNot})')
    if (options.visible !== undefined) step.visible = options.visible
    return new Locator(this.page, this.framePath, [...this.chain, step])
  }

  /** Matches of both this and the other. */
  and(other: Locator): Locator {
    return new Locator(this.page, this.framePath,
      [...this.chain, { kind: 'and', chain: this.#sameDocument(other, 'and()') }])
  }

  /** Matches of either. */
  or(other: Locator): Locator {
    return new Locator(this.page, this.framePath,
      [...this.chain, { kind: 'or', chain: this.#sameDocument(other, 'or()') }])
  }

  // -- acting ---------------------------------------------------------------

  /**
   * Every acting method: the guard it announces itself with, the op it sends,
   * and whatever that action's own named argument is.
   * @param action - what to do, which is also what the guard is told.
   * @param options - the caller's options.
   * @param extra - the action's own argument, when it takes one.
   * @returns what the frame answered.
   */
  async #act(action: string, options: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<unknown> {
    guard(`${action}()`)
    const args: Record<string, unknown> = { ...options, ...extra }
    // Through `timeoutOf` like every other wait here. An action's deadline goes
    // to the frame inside `args` rather than beside it, which is how it came to
    // be the one that arrived raw: `{timeout: 0}` meant "give up at once" where
    // the API this imitates means "no timeout", and `{timeout: '30s'}` reached
    // a `Date.now() + timeout` that never came due.
    if (args.timeout !== undefined) args.timeout = timeoutOf(args.timeout, ACTION_TIMEOUT_MS)
    return this.#call('act', { action, args })
  }

  /** Click it, once it can be clicked. */
  async click(options: Record<string, unknown> = {}): Promise<void> { await this.#act('click', options) }

  /** Double-click it. */
  async dblclick(options: Record<string, unknown> = {}): Promise<void> { await this.#act('dblclick', options) }

  /** Tap it, which on a machine with no touchscreen is a click. */
  async tap(options: Record<string, unknown> = {}): Promise<void> { await this.#act('tap', options) }

  /** Replace the field's value. */
  async fill(value: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.#act('fill', options, { value })
  }

  /** Empty the field. */
  async clear(options: Record<string, unknown> = {}): Promise<void> { await this.#act('clear', options) }

  /** Type into it one key at a time, as `pressSequentially` does. */
  async type(text: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.#act('type', options, { text })
  }

  /** The current name for {@link type}. */
  async pressSequentially(text: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.type(text, options)
  }

  /** Press a key at it, such as `Enter` or `Control+a`. */
  async press(key: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.#act('press', options, { key })
  }

  /** Check it, if it is not checked already. */
  async check(options: Record<string, unknown> = {}): Promise<void> { await this.#act('check', options) }

  /** Uncheck it. */
  async uncheck(options: Record<string, unknown> = {}): Promise<void> { await this.#act('uncheck', options) }

  /** Set it to a state. */
  async setChecked(checked: boolean, options: Record<string, unknown> = {}): Promise<void> {
    await this.#act('setChecked', options, { checked })
  }

  /** Choose options in a `<select>`. */
  async selectOption(values: unknown, options: Record<string, unknown> = {}): Promise<string[]> {
    const result = await this.#act('selectOption', options, { values }) as { values?: unknown, value?: string }
    // The array the frame chose, when it sent one. The joined string is only a
    // fallback for an older frame runtime, and it cannot survive an option
    // whose own value contains `, `.
    if (Array.isArray(result.values)) return result.values.map((entry) => String(entry))
    return (result.value ?? '').split(', ').filter((entry) => entry !== '')
  }

  /** Move the pointer over it. */
  async hover(options: Record<string, unknown> = {}): Promise<void> { await this.#act('hover', options) }

  // These four went straight to `#call` and so skipped `guard()`. The host
  // refuses them in a read-only run either way, but nothing set `mutated` — so
  // a body that focused a field, fired the previous one's `blur` into a site's
  // autosave, and then failed reported `mutation: 'none'`, which the recovery
  // advice reads as "the body performed no action at all".

  /** Give it keyboard focus. */
  async focus(): Promise<void> { await this.#act('focus', {}) }

  /** Take focus away from it. */
  async blur(): Promise<void> { await this.#act('blur', {}) }

  /** Select its text. */
  async selectText(): Promise<void> { await this.#act('selectText', {}) }

  /** Scroll it into view. */
  async scrollIntoViewIfNeeded(): Promise<void> { await this.#act('scrollIntoView', {}) }

  /** Put files into a file input. */
  async setInputFiles(files: string | string[], options: Record<string, unknown> = {}): Promise<void> {
    guard('setInputFiles()')
    const paths = Array.isArray(files) ? files : [files]
    const loaded = await rpc('fs.readMany', { paths }) as unknown[]
    await this.#call('act', { action: 'setInputFiles', args: { ...options, files: loaded } })
  }

  /** Drag it onto another element. */
  async dragTo(target: Locator, options: Record<string, unknown> = {}): Promise<void> {
    await this.#act('dragTo', options, { target: this.#sameDocument(target, 'dragTo()') })
  }

  // -- asking ---------------------------------------------------------------

  /** How many elements match. */
  async count(): Promise<number> { return await this.#call('query', { query: 'count' }) as number }

  /** Its text, as the DOM holds it. */
  async textContent(): Promise<string | null> { return await this.#call('query', { query: 'textContent' }) as string | null }

  /** Its text, as it is rendered. */
  async innerText(): Promise<string> { return await this.#call('query', { query: 'innerText' }) as string }

  /** Its markup. */
  async innerHTML(): Promise<string> { return await this.#call('query', { query: 'innerHTML' }) as string }

  /** The value of a form control. */
  async inputValue(): Promise<string> { return await this.#call('query', { query: 'inputValue' }) as string }

  /** One attribute. */
  async getAttribute(name: string): Promise<string | null> {
    return await this.#call('query', { query: 'getAttribute', args: { name } }) as string | null
  }

  /** Whether it is on the page and rendered. */
  async isVisible(): Promise<boolean> { return await this.#call('query', { query: 'isVisible' }) as boolean }

  /** Whether it is not. */
  async isHidden(): Promise<boolean> { return await this.#call('query', { query: 'isHidden' }) as boolean }

  /** Whether it can be interacted with. */
  async isEnabled(): Promise<boolean> { return await this.#call('query', { query: 'isEnabled' }) as boolean }

  /** Whether it cannot. */
  async isDisabled(): Promise<boolean> { return await this.#call('query', { query: 'isDisabled' }) as boolean }

  /** Whether it accepts typing. */
  async isEditable(): Promise<boolean> { return await this.#call('query', { query: 'isEditable' }) as boolean }

  /** Whether a checkbox or radio is checked. */
  async isChecked(): Promise<boolean> { return await this.#call('query', { query: 'isChecked' }) as boolean }

  /** Whether it has keyboard focus. */
  async isFocused(): Promise<boolean> { return await this.#call('query', { query: 'isFocused' }) as boolean }

  /**
   * Where it is, in page coordinates.
   *
   * `null` for an element that is not rendered, which is what the API this
   * imitates answers and what every caller here branches on. The frame can
   * only answer with a rectangle, so the zero-area one is turned back into the
   * `null` it means — otherwise `screenshot()` clips a region of no size and
   * writes a one-pixel picture that reports itself as a success.
   */
  async boundingBox(): Promise<{ x: number, y: number, width: number, height: number } | null> {
    const box = await this.#call('box', {}) as { x: number, y: number, width: number, height: number } | null
    if (box === null || box === undefined) return null
    return box.width === 0 && box.height === 0 ? null : box
  }

  /** The text of every match. */
  async allTextContents(): Promise<string[]> { return await this.#call('query', { query: 'allTextContents' }) as string[] }

  /** The rendered text of every match. */
  async allInnerTexts(): Promise<string[]> { return await this.#call('query', { query: 'allInnerTexts' }) as string[] }

  /** One locator per match, so a loop can hold them. */
  async all(): Promise<Locator[]> {
    const total = await this.count()
    return Array.from({ length: total }, (_unused, index) => this.nth(index))
  }

  /** Its role, name and state, in one call. */
  async describe(): Promise<{ tag: string, role: string, name: string, visible: boolean, enabled: boolean }> {
    return await this.#call('query', { query: 'describe' }) as {
      tag: string, role: string, name: string, visible: boolean, enabled: boolean
    }
  }

  /** Wait for it to be attached, detached, visible or hidden. */
  async waitFor(options: { state?: 'attached' | 'detached' | 'visible' | 'hidden', timeout?: number } = {}): Promise<void> {
    // Through `timeoutOf` like every other wait here: the frame reads this with
    // `Number(...)`, and a `'30s'` that arrived raw made its deadline `NaN` and
    // its poll loop unterminatable.
    await this.#call('wait', {
      state: options.state ?? 'visible',
      ...(options.timeout === undefined ? {} : { timeoutMs: timeoutOf(options.timeout, WAIT_TIMEOUT_MS) }),
    })
  }

  /**
   * Run a function against the element, in the page's own realm.
   *
   * The host already unwrapped the frame's `{value}` envelope for this op —
   * see `dispatch` in `src/browser/task.ts` — so what arrives here is the
   * value itself. Unwrapping it a second time turned every result into
   * `undefined`, and a result of `null` into a `TypeError`.
   */
  async evaluate(fn: unknown, argument?: unknown): Promise<unknown> {
    guard('evaluate()')
    return this.#call('evaluate', { source: String(fn), argument })
  }

  /** Run a function against every match, in the page's own realm. */
  async evaluateAll(fn: unknown, argument?: unknown): Promise<unknown> {
    guard('evaluateAll()')
    return this.#call('evaluateAll', { source: String(fn), argument })
  }

  /** The accessibility tree under it. */
  async ariaSnapshot(options: { depth?: number, maxChars?: number, boxes?: boolean } = {}): Promise<string> {
    const snapshot = await rpc('aria.snapshot', { ...this.address(), ...options }) as { text: string }
    return snapshot.text
  }

  /** Photograph just this element. */
  async screenshot(options: { path?: string } = {}): Promise<{ path?: string, width: number, height: number, bytes: number }> {
    const box = await this.boundingBox()
    if (box === null) {
      const described = await this.describe().catch(() => undefined)
      throw new Error(`that locator has nothing to photograph: ${described === undefined
        ? 'it matches nothing'
        : `<${described.tag}> ${described.role} is not rendered`}`)
    }
    // Photographed by the document the element is in, not by the tab around
    // it: a clip resolved inside a frame is in that frame's coordinates, and
    // handing it to the page above would crop whatever happens to sit at those
    // numbers in the outer document.
    const address = this.address()
    return await rpc('page.screenshot', {
      tab: this.page.tabId,
      ...(address.framePath === undefined ? {} : { framePath: address.framePath }),
      ...(address.frameToken === undefined ? {} : { frameToken: address.frameToken }),
      ...options,
      clip: box,
    }) as { path?: string, width: number, height: number, bytes: number }
  }

  /** What would stop an action on it right now. */
  async actionability(): Promise<Record<string, unknown>> {
    return await this.#call('actionability', {}) as Record<string, unknown>
  }
}

/**
 * A frame, named by the element that holds it.
 *
 * Resolved on every call rather than held: a frame is a document the page can
 * replace, and this build's frames each live in their own opaque origin, so
 * the only durable handle to one is the description of the `<iframe>` in the
 * document above it.
 */
class FrameLocator implements Selectors {
  readonly #owner: Locator

  constructor(owner: Locator) {
    this.#owner = owner
    Object.assign(this, selectors((steps) => new Locator(
      owner.page,
      [...owner.framePath, owner.chain],
      steps,
    )))
  }

  /** The `<iframe>` element itself, in the document above. */
  owner(): Locator { return this.#owner }

  /** The nth matching frame. */
  nth(index: number): FrameLocator { return new FrameLocator(this.#owner.nth(index)) }

  /** The first matching frame. */
  first(): FrameLocator { return this.nth(0) }

  /** The last matching frame. */
  last(): FrameLocator { return this.nth(-1) }
}

// ---------------------------------------------------------------------------
// what a page hands back
// ---------------------------------------------------------------------------

/** A response, as `context.request` and `page.goto` report one. */
class APIResponse {
  readonly #status: number
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #body: string

  constructor(raw: { status: number, url: string, headers?: Record<string, string>, body?: string }) {
    this.#status = raw.status
    this.#url = raw.url
    this.#headers = raw.headers ?? {}
    this.#body = raw.body ?? ''
  }

  /** The HTTP status. */
  status(): number { return this.#status }

  /** Whether it was a success. */
  ok(): boolean { return this.#status >= 200 && this.#status < 300 }

  /** Where it came from. */
  url(): string { return this.#url }

  /** Its headers, lower-cased. */
  headers(): Record<string, string> { return this.#headers }

  /** The body as text. */
  async text(): Promise<string> { return new TextDecoder().decode(await this.body()) }

  /** The body, parsed. */
  async json(): Promise<unknown> { return JSON.parse(await this.text()) }

  /** The body as bytes. */
  async body(): Promise<Uint8Array> {
    // The shared codec, not a fourth copy of it: `new Uint8Array(number)` is
    // the shared-memory-capable view `Response` and `Blob` refuse on this
    // cross-origin-isolated page, so `new Blob([await response.body()])` failed
    // where the same bytes through `fromBase64` do not. See `./protocol.ts`.
    return fromBase64(this.#body)
  }

  /** How many bytes came back. */
  get size(): number { return Math.floor(this.#body.length * 0.75) }
}

/** A file the page offered, which this machine fetched rather than saved. */
class Download {
  readonly #url: string
  readonly #suggested: string
  readonly #page: Page
  #saved: string | undefined
  #failure: string | undefined

  constructor(page: Page, url: string, suggested: string) {
    this.#page = page
    this.#url = url
    this.#suggested = suggested
  }

  /** Where the file was offered from. */
  url(): string { return this.#url }

  /** The name the page suggested. */
  suggestedFilename(): string { return this.#suggested }

  /** The page it came from. */
  page(): Page { return this.#page }

  /**
   * Fetch the bytes and write them where they were asked for.
   * @param path - where to save it, in this session's filesystem.
   * @returns nothing; the file is there afterwards.
   */
  async saveAs(path: string): Promise<void> {
    guard('saveAs()')
    try {
      const saved = await rpc('download.save', { url: this.#url, path, suggestedFilename: this.#suggested }) as { path: string }
      this.#saved = saved.path
      this.#failure = undefined
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * Where the file is, saving it into the task's artifacts if it has not been.
   * @returns the path.
   */
  async path(): Promise<string> {
    if (this.#saved === undefined) await this.saveAs(artifactLeaf(this.#suggested))
    return this.#saved ?? ''
  }

  /**
   * What went wrong, which for a fetch that has not happened yet is nothing.
   *
   * A report, not an attempt: asking used to *perform* the download, so a body
   * that checked `failure()` before deciding whether it wanted the file wrote
   * the file by asking.
   * @returns the error from a save that was tried and failed, or null.
   */
  failure(): string | null { return this.#failure ?? null }

  /** Forget it, which here means not writing it anywhere. */
  async delete(): Promise<void> { this.#saved = undefined }
}

/** A file picker the page opened. */
class FileChooser {
  readonly #page: Page
  readonly #token: string
  readonly #multiple: boolean
  /** The frame the input is in, when it is not in the top document. */
  readonly #frame: string | undefined

  constructor(page: Page, token: string, multiple: boolean, frame?: string) {
    this.#page = page
    this.#token = token
    this.#multiple = multiple
    this.#frame = frame
  }

  /** Whether it accepts more than one file. */
  isMultiple(): boolean { return this.#multiple }

  /** The page that opened it. */
  page(): Page { return this.#page }

  /**
   * Answer it with files from this session's filesystem.
   * @param files - one path or several.
   */
  async setFiles(files: string | string[]): Promise<void> {
    guard('setFiles()')
    const paths = Array.isArray(files) ? files : [files]
    const loaded = await rpc('fs.readMany', { paths })
    await rpc('page.command', {
      tab: this.#page.tabId,
      // The input belongs to whichever document opened the picker, and a
      // frame's document is not this page's — the file has to be handed to the
      // runtime that owns the element.
      ...(this.#frame === undefined ? {} : { frameToken: this.#frame }),
      kind: 'files.set',
      payload: { chooser: this.#token, files: loaded },
    })
  }
}

/**
 * A modal the page raised.
 *
 * It has already been answered by the time this exists — a page's `confirm()`
 * is synchronous and the answer had to be produced inside the frame, from the
 * policy the handler armed. So `accept()` and `dismiss()` here record what was
 * *wanted*, and say so when that is not what the page was told, which is the
 * one thing a task can usefully do about it.
 */
class Dialog {
  readonly #kind: string
  readonly #message: string
  readonly #answer: string
  readonly #page: Page
  /** The frame that raised it, when it was not the top document. */
  readonly #frame: string | undefined

  constructor(page: Page, kind: string, message: string, answer: string, frame?: string) {
    this.#page = page
    this.#kind = kind
    this.#message = message
    this.#answer = answer
    this.#frame = frame
  }

  /** Which modal it was. */
  type(): string { return this.#kind }

  /** What it asked. */
  message(): string { return this.#message }

  /** A prompt's default. */
  defaultValue(): string { return '' }

  /** The page that raised it. */
  page(): Page { return this.#page }

  /** What the page was actually told. */
  answered(): string { return this.#answer }

  /**
   * Say the dialog should be accepted.
   * @param promptText - what a prompt should answer with.
   */
  async accept(promptText?: string): Promise<void> {
    // Arm the *next* one too, so a page that asks twice gets the same answer —
    // in the document that raised this one, which for a modal from inside an
    // iframe is not the page around it. Each document holds its own policy.
    await this.#page.setDialogPolicy(
      { action: 'accept', ...(promptText === undefined ? {} : { promptText }) },
      this.#frame,
    )
    if (this.#answer === 'false' || this.#answer === 'null') {
      throw new Error(`this ${this.#kind} was already answered "${this.#answer}" before the handler ran: a page's `
        + 'modal is synchronous and this machine cannot pause one. Install the handler before the action that '
        + 'raises the dialog, or call page.setDialogPolicy({action: "accept"}) first — the next one will accept.')
    }
  }

  /** Say the dialog should be dismissed. */
  async dismiss(): Promise<void> {
    await this.#page.setDialogPolicy({ action: 'dismiss' }, this.#frame)
    // An `alert` has one button. It is recorded as answered `true` because
    // that is what the page was told, but there was no other answer to give —
    // so dismissing one is not a disagreement with anything.
    if (this.#answer === 'true' && this.#kind !== 'alert') {
      throw new Error(`this ${this.#kind} was already accepted before the handler ran: a page's modal is `
        + 'synchronous and this machine cannot pause one. Call page.setDialogPolicy({action: "dismiss"}) '
        + 'before the action that raises it.')
    }
  }
}

/** A console line a page printed. */
class ConsoleMessage {
  readonly #level: string
  readonly #text: string

  constructor(level: string, text: string) {
    this.#level = level
    this.#text = text
  }

  /** The level: log, info, warn, error or debug. */
  type(): string { return this.#level }

  /** What was printed. */
  text(): string { return this.#text }

  /** Playwright's spelling, kept so a recipe reads the same. */
  toString(): string { return `${this.#level}: ${this.#text}` }
}

/** A request the page made, as the network log recorded it. */
class NetworkRecord {
  readonly #url: string
  readonly #method: string
  readonly #status: number
  readonly #error: string | undefined

  constructor(url: string, method: string, status: number, error?: string) {
    this.#url = url
    this.#method = method
    this.#status = status
    this.#error = error
  }

  /** Where it went. */
  url(): string { return this.#url }

  /** How it was asked for. */
  method(): string { return this.#method }

  /** What came back. */
  status(): number { return this.#status }

  /** Whether it succeeded. */
  ok(): boolean { return this.#status >= 200 && this.#status < 300 }

  /** What went wrong, when something did. */
  failure(): string | null { return this.#error ?? null }
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

/**
 * One thing that happened, as the host reported it.
 *
 * The host's own type, not a copy of it. The copy had already drifted — the
 * engine reports a file chooser's `accept` filter and this side had no field
 * for it — and a `kind` widened to `string` meant a tenth event kind would
 * compile clean here and land silently in {@link deliver}'s `default`.
 */
type HostEvent = MachineEvent

/** Somebody waiting for one. */
interface Waiter {
  tab?: string
  kind: string
  predicate?: (value: unknown) => boolean
  since: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Everyone currently waiting for an event. */
const waiters = new Set<Waiter>()

/** Handlers a task installed with `page.on`. */
const handlers = new Map<string, Set<{ fn: (value: unknown) => unknown, readonly once: boolean }>>()

/**
 * Register one handler under a key, once.
 *
 * The same handler twice is once. A task space outlives the body that ran in
 * it, and each run compiles a fresh closure, so re-running a body that does
 * `page.on('dialog', d => d.accept())` would otherwise leave one more listener
 * behind every time — every dialog then invoking all of them. Identity cannot
 * see that; the source can.
 * @param key - the tab-or-context key the event will be dispatched under.
 * @param fn - the handler.
 * @param once - whether it is removed after firing.
 */
function listen(key: string, fn: (value: unknown) => unknown, once: boolean): void {
  const set = handlers.get(key) ?? new Set()
  // The *newest* closure, not the first. Each run compiles its own, and they
  // capture different variables even where the source is identical — so
  // keeping the older one meant re-running a body registered nothing and every
  // event was appended to the previous run's dead arrays, which the receipt
  // then reported as an event that never happened.
  const already = [...set].find((entry) => entry.once === once && String(entry.fn) === String(fn))
  if (already === undefined) set.add({ fn, once })
  else already.fn = fn
  handlers.set(key, set)
}

/**
 * Take one back off.
 *
 * By source as well as by identity, because that is how {@link listen} decides
 * two handlers are the same one: matching only on identity meant a handler
 * that was folded into an existing entry could never be removed.
 * @param key - the key it was registered under.
 * @param fn - the handler.
 */
function unlisten(key: string, fn: (value: unknown) => unknown): void {
  const set = handlers.get(key)
  for (const entry of set ?? []) {
    if (entry.fn === fn || String(entry.fn) === String(fn)) set?.delete(entry)
  }
}

/**
 * Arm the dialog policy a handler plainly implies.
 *
 * The answer to a modal has to exist before the modal does; see the note on
 * {@link Dialog}. Reading the handler is the only way to know what it was
 * going to say, and it is a good enough guess to make the common recipe work:
 * a handler that accepts, accepts.
 *
 * Only a handler that plainly says which way arms anything. One this cannot
 * read — `d => respondTo(d)`, or one that branches — leaves whatever is armed
 * alone: guessing `accept` would mean merely *watching* dialogs confirms the
 * next `confirm()`, and writing `dismiss` would mean adding a logger after
 * `setDialogPolicy({action: 'accept'})` silently cancelled it.
 * @param page - the page to arm, when the task has one.
 * @param fn - the handler that was just installed.
 */
function armFromHandler(page: Page | undefined, fn: (value: unknown) => unknown): void {
  if (page === undefined) return
  const source = String(fn)
  const accepts = /\.accept\s*\(/.test(source)
  const dismisses = /\.dismiss\s*\(/.test(source)
  const promptText = /\.accept\s*\(\s*(['"`])([^'"`]*)\1\s*\)/.exec(source)?.[2]
  const wanted = accepts === dismisses ? undefined : accepts ? 'accept' as const : 'dismiss' as const
  if (wanted === undefined) return
  void page.setDialogPolicy({
    action: wanted,
    ...(promptText === undefined ? {} : { promptText }),
  }).catch(() => {
    // No page to arm yet, or it has gone. The default stands, and the handler
    // still runs when the dialog is reported.
  })
}

/** Every page this task has, by tab id. */
const pages = new Map<string, Page>()

/**
 * What `getByTestId` reads, when the task has chosen something other than the
 * default.
 *
 * Remembered here as well as set in the document, because it is module state
 * inside the frame runtime and a new document starts again from
 * `data-testid` — so a choice made once silently stopped applying at the next
 * navigation, and every later `getByTestId()` matched nothing.
 */
let testIdAttribute: string | undefined

/**
 * How this task wants modals answered, for as long as it is running.
 *
 * Remembered for the same reason {@link testIdAttribute} is: the policy is
 * module state inside the browsed document's own runtime, so a fresh document
 * starts again at `dismiss`. A body that armed `accept` and then navigated —
 * which is the order the skill teaches, because a handler installed after the
 * action is a race the action wins — had its `confirm()` answered "no" by a
 * page that had forgotten, and the handler still ran and reported the message,
 * so the receipt read as though it had been accepted.
 *
 * It is also what a policy armed before there is a page falls back to:
 * `page.on('dialog', …)` on the first line of a body is a page with no tab
 * yet, and the arming call had nowhere to go.
 */
let dialogPolicy: { action: 'accept' | 'dismiss', promptText?: string } | undefined

/**
 * The nested frame that has keyboard focus, when one has it.
 *
 * A frame is its own document, and focus is a property of a document: after a
 * click on a field inside an `<iframe>`, the page around it reports its
 * `activeElement` as the `<iframe>` element. Anything aimed at "whatever has
 * focus" has to be asked of the document that actually has it, or the event is
 * dispatched at the frame element and the field never hears about it.
 * @param tab - the page's tab.
 * @returns the frame's token, or nothing when focus is in the tab's own
 * document, in a frame with no runtime, or not answerable at all.
 */
async function focusedFrame(tab: string | undefined): Promise<string | undefined> {
  try {
    const outer = await rpc('page.command', { tab, kind: 'focus.info', payload: {} }) as { inFrame?: unknown }
    const inside = outer.inFrame
    return typeof inside === 'string' && inside !== '' && inside !== 'unknown' ? inside : undefined
  } catch {
    // No page, or a document that will not answer. The command below is the
    // one whose error is worth reporting, so this one keeps quiet and aims at
    // the tab's own document, which is where it went before.
    return undefined
  }
}

/** The keyboard, which is the page's rather than an element's. */
class Keyboard {
  readonly #page: Page

  constructor(page: Page) { this.#page = page }

  /**
   * Every keyboard method: the guard, and the command it sends.
   * @param action - what to do, which is also what the guard is told.
   * @param payload - the key or the text it acts on.
   */
  async #send(action: string, payload: Record<string, unknown>): Promise<void> {
    guard(`keyboard.${action}()`)
    // Into the document that has focus, which for a framed field is not the
    // page around it — the same hop `tabbit.pasteText` makes, and for the same
    // reason: without it a body that clicked a card number inside a payment
    // iframe and then typed sent every keystroke to the `<iframe>` element,
    // and the command still answered `{ok: true}`.
    await this.#page.command('keyboard', { action, ...payload }, await focusedFrame(this.#page.tabId))
  }

  /** Press a key, or a combination such as `Control+a`. */
  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    await this.#send('press', { key, ...options })
  }

  /** Hold a key down. */
  async down(key: string): Promise<void> { await this.#send('down', { key }) }

  /** Let it up. */
  async up(key: string): Promise<void> { await this.#send('up', { key }) }

  /** Type text one key at a time. */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    await this.#send('type', { text, ...options })
  }

  /** Put text in without pretending it was typed. */
  async insertText(text: string): Promise<void> { await this.#send('insertText', { text }) }
}

/** The mouse, for surfaces that have no elements to name. */
class Mouse {
  readonly #page: Page
  #x = 0
  #y = 0

  constructor(page: Page) { this.#page = page }

  /** Move it. */
  async move(x: number, y: number): Promise<unknown> {
    this.#x = x
    this.#y = y
    return this.#page.command('mouse', { action: 'move', x, y })
  }

  /**
   * Every guarded mouse method: the guard, and the command at where it is.
   * @param action - what to do, which is also what the guard is told.
   * @param options - the button, and whatever else the action takes.
   * @returns what the frame answered.
   */
  async #at(action: string, options: Record<string, unknown>): Promise<unknown> {
    guard(`mouse.${action}()`)
    return this.#page.command('mouse', { action, x: this.#x, y: this.#y, ...options })
  }

  /** Press the button. */
  async down(options: { button?: string } = {}): Promise<unknown> { return this.#at('down', options) }

  /** Let it up. */
  async up(options: { button?: string } = {}): Promise<unknown> { return this.#at('up', options) }

  /** Click at a point. */
  async click(x: number, y: number, options: Record<string, unknown> = {}): Promise<unknown> {
    this.#x = x
    this.#y = y
    return this.#at('click', options)
  }

  /** Double-click at a point. */
  async dblclick(x: number, y: number, options: Record<string, unknown> = {}): Promise<unknown> {
    this.#x = x
    this.#y = y
    return this.#at('dblclick', options)
  }

  /** Scroll. */
  async wheel(deltaX: number, deltaY: number): Promise<unknown> {
    return this.#page.command('mouse', { action: 'wheel', x: this.#x, y: this.#y, deltaX, deltaY })
  }
}

/** One tab, driven the way a Playwright page is. */
class Page implements Selectors {
  readonly keyboard: Keyboard
  readonly mouse: Mouse
  #tab: string
  #url = 'about:blank'
  #title = ''
  #closed = false

  constructor(tabId: string, url = 'about:blank') {
    this.#tab = tabId
    this.#url = url
    this.keyboard = new Keyboard(this)
    this.mouse = new Mouse(this)
    Object.assign(this, selectors((steps) => new Locator(this, [], steps)))
    pages.set(tabId, this)
  }

  /**
   * Which tab this page is.
   *
   * Empty until the first navigation, which is what *creates* the tab: a task
   * that has not browsed anywhere yet has no page open, and opening one before
   * it is wanted would leave an about:blank tab in the user's machine for
   * every task that turned out to only need `context.request`.
   */
  get tabId(): string { return this.#tab }

  /**
   * Take on the tab the host just made for this page.
   * @param tab - the tab's id.
   */
  adopt(tab: string): void {
    if (this.#tab === tab) return
    // The handlers go with it. They are keyed by tab id, and a body that
    // installs one before its first `goto` — which is the documented order,
    // because a waiter armed after the action is a race the action wins —
    // registered it under the empty id this page had before the tab existed.
    for (const [key, set] of [...handlers]) {
      if (!key.startsWith(`${this.#tab}:`)) continue
      handlers.delete(key)
      const moved = `${tab}:${key.slice(this.#tab.length + 1)}`
      const held = handlers.get(moved)
      if (held === undefined) handlers.set(moved, set)
      else for (const entry of set) held.add(entry)
    }
    // And the waiters, for the same reason and the same recipe: `Promise.all([
    // page.waitForEvent('popup'), page.goto(url)])` is the documented order,
    // and the waiter it installs is scoped to the id this page had before
    // `goto` gave it one — which nothing would ever match.
    for (const waiter of waiters) if (waiter.tab === this.#tab) waiter.tab = tab
    pages.delete(this.#tab)
    this.#tab = tab
    pages.set(tab, this)
  }

  /** Note what the host says this tab is now showing. */
  update(info: { url?: string, title?: string, closed?: boolean }): void {
    if (info.url !== undefined) this.#url = info.url
    if (info.title !== undefined) this.#title = info.title
    if (info.closed !== undefined) this.#closed = info.closed
  }

  /**
   * Send one command to this tab's document.
   * @param kind - the command.
   * @param payload - its arguments.
   * @returns whatever the document produced.
   */
  async command(kind: string, payload: Record<string, unknown> = {}, frame?: string): Promise<unknown> {
    // The escape hatch is still bound by the run's own rules. Every named
    // method that reaches a command like these calls `guard()` first, and a
    // read-only run that could get at the same commands by spelling them out
    // here would be a read-only run that types into the page.
    if (MUTATING_COMMANDS.has(kind)) guard(`page.command(${JSON.stringify(kind)})`)
    return rpc('page.command', {
      tab: this.tabId,
      ...(frame === undefined || frame === '' ? {} : { frameToken: frame }),
      kind,
      payload,
    })
  }

  /** Where it is. */
  url(): string { return this.#url }

  /** Whether it has been closed. */
  isClosed(): boolean { return this.#closed }

  /** Its title. */
  async title(): Promise<string> {
    const info = await rpc('page.info', { tab: this.tabId }) as { url: string, title: string }
    this.update(info)
    return info.title
  }

  /** Its whole markup. */
  async content(): Promise<string> {
    return (await this.command('html', {}) as { html: string }).html
  }

  /**
   * Its rendered text, or one element's.
   * @param selector - which element, or nothing for the whole document. The
   * argument is here because every sibling shortcut takes one and the API this
   * imitates requires one — dropping it returned the whole page to a caller
   * that had asked for a single field, with no error to say so.
   * @returns the text.
   */
  async innerText(selector?: string): Promise<string> {
    if (selector !== undefined && selector !== '') return this.locator(selector).innerText()
    return (await this.command('text', {}) as { text: string }).text
  }

  /**
   * Go somewhere.
   * @param url - where to.
   * @param options - `waitUntil` and a timeout, both accepted for familiarity.
   * @returns the response, as far as this machine sees one.
   */
  async goto(url: string, options: { waitUntil?: string, timeout?: number } = {}): Promise<APIResponse> {
    guard('goto()')
    const info = await rpc('nav.goto', { tab: this.tabId, url, ...options }) as {
      tab: string, url: string, title: string, status: number, error?: string
    }
    if (info.tab !== undefined && info.tab !== '') this.adopt(info.tab)
    this.update(info)
    if (info.error !== undefined) throw new Error(`could not open ${url}: ${info.error}`)
    return new APIResponse({ status: info.status, url: info.url })
  }

  /** Load it again. */
  async reload(options: { timeout?: number } = {}): Promise<void> {
    guard('reload()')
    const info = await rpc('nav.reload', { tab: this.tabId, ...options }) as { url: string, title: string }
    this.update(info)
  }

  /** Back. */
  async goBack(): Promise<void> {
    guard('goBack()')
    this.update(await rpc('nav.back', { tab: this.tabId }) as { url: string, title: string })
  }

  /** Forward. */
  async goForward(): Promise<void> {
    guard('goForward()')
    this.update(await rpc('nav.forward', { tab: this.tabId }) as { url: string, title: string })
  }

  /**
   * Close it.
   *
   * Closing the page a task is working on moves the task to another of its
   * pages, the way closing a tab in a browser leaves you looking at a
   * different one rather than at nothing. Without that, the recipe that opens
   * a popup, reads it and closes it would leave every later call addressing a
   * page that is gone.
   */
  async close(): Promise<void> {
    guard('close()')
    await rpc('tabs.close', { tab: this.tabId })
    this.#closed = true
    pages.delete(this.#tab)
    if (state.page === this || state.page?.tabId === this.#tab) state.page = livePage()
  }

  /** Show it to whoever is watching the machine. */
  async bringToFront(): Promise<void> { await rpc('tabs.select', { tab: this.tabId }) }

  /** The context it belongs to. */
  context(): typeof context { return context }

  /** The size every tab in this machine is. */
  viewportSize(): { width: number, height: number } { return viewport }

  /**
   * Run a function in the page's own JavaScript realm.
   * @param fn - the function, or an expression as a string.
   * @param argument - what to pass it, which is the only channel there is:
   * the function is serialised, so it captures nothing from this scope.
   * @returns what it returned, as JSON-safe data.
   */
  async evaluate(fn: unknown, argument?: unknown): Promise<unknown> {
    const source = String(fn)
    const isFunction = typeof fn === 'function'
    const result = await this.command(isFunction ? 'evaluateFn' : 'evaluate', isFunction
      ? { source, argument }
      : { source }) as { value: unknown }
    return result.value
  }

  /** Wait until a function in the page returns something truthy. */
  async waitForFunction(fn: unknown, argument?: unknown, options: { timeout?: number, polling?: number } = {}): Promise<unknown> {
    const result = await this.command('waitForFunction', {
      source: String(fn),
      argument,
      timeoutMs: timeoutOf(options.timeout, 15_000),
      ...(options.polling === undefined ? {} : { pollMs: options.polling }),
    }) as { value: unknown }
    return result.value
  }

  /** Wait for an element matching a selector. */
  async waitForSelector(selector: string, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden', timeout?: number } = {}): Promise<Locator> {
    const locator = this.locator(selector)
    await locator.waitFor(options)
    return locator
  }

  /**
   * Wait for the document to reach a load state.
   *
   * This machine installs a page only once it is parsed and its runtime has
   * announced itself, so `domcontentloaded` has already happened by the time
   * `goto` returns. `load` and `networkidle` are honoured by waiting for the
   * document's own `readyState`, which is the closest true statement.
   * @param state - which state.
   * @param options - a timeout.
   */
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', options: { timeout?: number } = {}): Promise<void> {
    // A tab this machine is still fetching for has no document to ask, so the
    // wait is on the machine first and on the document afterwards. That order
    // matters for a popup: the page event fires when the tab is made, and its
    // URL is `about:blank` until the navigation it was opened for lands.
    const deadline = Date.now() + timeoutOf(options.timeout, 15_000)
    // A page that is *legitimately* at `about:blank` — `context.newPage()`
    // with no URL, which is then driven by `evaluate` — is loaded, and waiting
    // the whole timeout out on it cost fifteen seconds and two hundred round
    // trips per call. So the blank page gets its own short budget: long enough
    // for the popup whose navigation has not landed yet, short enough not to
    // be the answer for a page that is never going anywhere.
    const blankUntil = Math.min(deadline, Date.now() + 2000)
    for (;;) {
      const info = await rpc('page.info', { tab: this.tabId }) as { url: string, title: string, loading?: boolean }
      this.update(info)
      if (info.loading !== true && (info.url !== 'about:blank' || Date.now() > blankUntil)) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    if (state === 'domcontentloaded') return
    await this.command('waitFor', { timeoutMs: Math.max(1000, deadline - Date.now()) })
  }

  /** Wait until the URL matches. */
  async waitForURL(pattern: string | RegExp | ((url: string) => boolean), options: { timeout?: number } = {}): Promise<void> {
    const timeout = timeoutOf(options.timeout, 15_000)
    const deadline = Date.now() + timeout
    const test = (url: string): boolean => {
      if (typeof pattern === 'function') return pattern(url)
      if (pattern instanceof RegExp) return patternMatches(pattern, url)
      return url === pattern || url.includes(pattern)
    }
    for (;;) {
      const info = await rpc('page.info', { tab: this.tabId }) as { url: string, title: string }
      this.update(info)
      if (test(info.url)) return
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${String(timeout)}ms waiting for the URL to match; `
          + `it is ${info.url}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Sleep.
   *
   * Present because recipes use it and absent from every recommendation for
   * the same reason Playwright deprecates it: a wait for a locator, a URL or
   * an event is both faster and correct, and a fixed sleep is a race that has
   * not happened yet.
   * @param ms - how long.
   */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Wait for one thing to happen in this page. */
  async waitForEvent(kind: string, options: { timeout?: number, predicate?: (value: unknown) => boolean } | ((value: unknown) => boolean) = {}): Promise<unknown> {
    const settings = typeof options === 'function' ? { predicate: options } : options
    return waitForEvent(kind, { ...settings, tab: this.tabId })
  }

  /** Wait for a request to come back. */
  async waitForResponse(matcher: string | RegExp | ((response: NetworkRecord) => boolean), options: { timeout?: number } = {}): Promise<NetworkRecord> {
    return await waitForEvent('request', {
      tab: this.tabId,
      ...options,
      predicate: (value) => {
        const record = value as NetworkRecord
        if (typeof matcher === 'function') return matcher(record)
        if (matcher instanceof RegExp) return patternMatches(matcher, record.url())
        return record.url().includes(matcher)
      },
    }) as NetworkRecord
  }

  /** The same, for the request going out; here they are one event. */
  async waitForRequest(matcher: string | RegExp | ((request: NetworkRecord) => boolean), options: { timeout?: number } = {}): Promise<NetworkRecord> {
    return this.waitForResponse(matcher as string, options)
  }

  /** Listen for something. */
  on(kind: string, fn: (value: unknown) => unknown): this { return this.#listen(kind, fn, false) }

  /** Listen for the next one only. */
  once(kind: string, fn: (value: unknown) => unknown): this { return this.#listen(kind, fn, true) }

  /** Stop listening. */
  off(kind: string, fn: (value: unknown) => unknown): this {
    unlisten(`${this.tabId}:${kind}`, fn)
    return this
  }

  #listen(kind: string, fn: (value: unknown) => unknown, once: boolean): this {
    listen(`${this.tabId}:${kind}`, fn, once)
    if (kind === 'dialog') armFromHandler(this, fn)
    return this
  }

  /**
   * Decide in advance how the page's modals are answered.
   *
   * Every document in the page, not only the one on top. A frame keeps its own
   * policy — it has its own `confirm()` — so arming the page around it left a
   * modal raised inside a payment iframe answered by the default, and the
   * handler that was going to accept it then threw "this confirm was already
   * answered". Naming a frame arms only that one, which is what
   * {@link Dialog.accept} does for the document that actually raised one.
   * @param policy - accept or dismiss, and what a prompt should say.
   * @param frame - one frame's document, or undefined for all of them.
   */
  async setDialogPolicy(policy: { action: 'accept' | 'dismiss', promptText?: string }, frame?: string): Promise<void> {
    // Ahead of the note below. `dialogPolicy` is module state that outlives the
    // run and is re-armed on every document that loads afterwards, so a
    // read-only call refused three lines further down had already decided how
    // the *next* run's `confirm()` would be answered.
    guard('setDialogPolicy()')
    // Noted before it is sent, so that a document arriving later is armed the
    // same way — including the first one, when this was called before `goto`.
    if (frame === undefined) dialogPolicy = policy
    if (frame !== undefined) {
      await rpc('page.command', {
        tab: this.tabId,
        frameToken: frame,
        kind: 'dialog.arm',
        payload: policy,
      })
      return
    }
    await this.command('dialog.arm', policy as unknown as Record<string, unknown>)
    // The frames after the page, and best-effort: a frame this machine did not
    // load has no runtime to arm, and one that has gone since the list was
    // taken is not a reason to fail the call that armed the page.
    const listed = await this.frames().catch(() => [])
    await Promise.all(listed.map(async (frame_) => {
      const token = frame_.token
      if (typeof token !== 'string' || token === '') return
      await this.setDialogPolicy(policy, token).catch(() => undefined)
    }))
  }

  /** Every nested frame in this page, with the state of its host element. */
  async frames(): Promise<Record<string, unknown>[]> {
    const listed = await this.command('frames.list', {}) as { frames: Record<string, unknown>[] }
    return listed.frames
  }

  /** The accessibility tree, with a handle on every node. */
  async ariaSnapshot(options: { depth?: number, maxChars?: number, boxes?: boolean, mode?: string } = {}): Promise<string> {
    const snapshot = await rpc('aria.snapshot', { tab: this.tabId, ...options }) as { text: string }
    return snapshot.text
  }

  /**
   * Photograph the page.
   * @param options - a path to keep it at, the whole document, or a region.
   * @returns where it went and how big it is.
   */
  async screenshot(options: { path?: string, fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } } = {}): Promise<{
    path?: string, width: number, height: number, bytes: number
  }> {
    return await rpc('page.screenshot', { tab: this.tabId, ...options }) as {
      path?: string, width: number, height: number, bytes: number
    }
  }

  // -- the shortcuts, which are the locator methods with a selector ----------

  /** Click the first element matching a selector. */
  async click(selector: string, options: Record<string, unknown> = {}): Promise<void> { await this.locator(selector).click(options) }

  /** Fill the field matching a selector. */
  async fill(selector: string, value: string): Promise<void> { await this.locator(selector).fill(value) }

  /** Type into it. */
  async type(selector: string, text: string): Promise<void> { await this.locator(selector).type(text) }

  /** Press a key at it. */
  async press(selector: string, key: string): Promise<void> { await this.locator(selector).press(key) }

  /** Check it. */
  async check(selector: string): Promise<void> { await this.locator(selector).check() }

  /** Uncheck it. */
  async uncheck(selector: string): Promise<void> { await this.locator(selector).uncheck() }

  /** Choose in it. */
  async selectOption(selector: string, values: unknown): Promise<string[]> { return this.locator(selector).selectOption(values) }

  /** Hover it. */
  async hover(selector: string): Promise<void> { await this.locator(selector).hover() }

  /** Read its text. */
  async textContent(selector: string): Promise<string | null> { return this.locator(selector).textContent() }

  /** Read one attribute. */
  async getAttribute(selector: string, name: string): Promise<string | null> { return this.locator(selector).getAttribute(name) }

  /** Whether it is showing. */
  async isVisible(selector: string): Promise<boolean> { return this.locator(selector).isVisible() }
}

/**
 * Wait for one event, from a point in time.
 *
 * The install time is what makes "arm the waiter, then click" work and "click,
 * then wait" fail honestly rather than hanging: an event that happened before
 * the waiter existed is not delivered to it, exactly as it would not be by a
 * real event emitter.
 * @param kind - which event.
 * @param options - the tab, a predicate, and how long to wait.
 * @returns the event's object.
 */
async function waitForEvent(
  kind: string,
  options: { tab?: string, timeout?: number, predicate?: (value: unknown) => boolean } = {},
): Promise<unknown> {
  const timeout = timeoutOf(options.timeout, 30_000)
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      ...(options.tab === undefined ? {} : { tab: options.tab }),
      kind,
      ...(options.predicate === undefined ? {} : { predicate: options.predicate }),
      since: Date.now(),
      resolve: (value) => { waiters.delete(waiter); clearTimeout(waiter.timer); resolve(value) },
      reject: (error) => { waiters.delete(waiter); clearTimeout(waiter.timer); reject(error) },
      timer: setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`timed out after ${String(timeout)}ms waiting for a "${kind}" event. `
          + 'Install the waiter *before* the action that causes it: an event that has already fired is gone.'))
      }, timeout),
    }
    waiters.add(waiter)
  })
}

/**
 * Hand one host event to whoever asked for it.
 *
 * One event can have two names — a new tab is a `page` on the context and a
 * `popup` on whoever opened it — because that is how the API this implements
 * spells them, and a recipe written against either should work.
 * @param event - what happened.
 */
function deliver(event: HostEvent): void {
  const page = pages.get(event.tab)
  const names: string[] = []
  let value: unknown = event

  switch (event.kind) {
    case 'page': {
      const opened = page ?? new Page(event.tab, event.url ?? 'about:blank')
      value = opened
      names.push('page')
      if (event.opener !== undefined) {
        const opener = pages.get(event.opener)
        if (opener !== undefined) dispatch(opener.tabId, 'popup', opened)
      }
      break
    }
    case 'close':
      page?.update({ closed: true })
      // The page, like every other branch. Left as the wire event, a body
      // writing `page.on('close', p => log(p.url()))` got `p.url is not a
      // function` — thrown inside `dispatch`, which swallows it.
      if (page !== undefined) value = page
      names.push('close')
      break
    case 'navigated':
      // A nested frame moving is not the page moving. Both arrive as
      // `navigated`; only the one with no `frame` on it is the tab's own
      // document, and letting a frame's URL become `page.url()` is how
      // `waitForURL` ends up waiting for an advert's address.
      if (event.frame === undefined) {
        page?.update({ url: event.url ?? '', ...(event.title === undefined ? {} : { title: event.title }) })
      }
      value = page
      names.push('framenavigated')
      break
    case 'load':
      // Likewise: `load` is the tab's document finishing, not an advert
      // frame's. A frame's arrival is still a `framenavigated`.
      if (event.frame === undefined) {
        page?.update(event.url === undefined ? {} : { url: event.url })
        names.push('load', 'domcontentloaded')
      } else names.push('framenavigated')
      // A fresh document has the default test-id attribute again, and the
      // default dialog policy again; see the notes on {@link testIdAttribute}
      // and {@link dialogPolicy}.
      for (const [kind, payload] of [
        ...(testIdAttribute === undefined ? [] : [['testId', { attribute: testIdAttribute }] as const]),
        ...(dialogPolicy === undefined ? [] : [['dialog.arm', dialogPolicy] as const]),
      ]) {
        void rpc('page.command', {
          tab: event.tab,
          ...(event.frame === undefined ? {} : { frameToken: event.frame }),
          kind,
          payload,
        }).catch(() => undefined)
      }
      value = page
      break
    case 'console':
      value = new ConsoleMessage(event.level ?? 'log', event.text ?? '')
      names.push('console')
      break
    case 'dialog':
      value = page === undefined
        ? undefined
        : new Dialog(page, event.dialog ?? 'alert', event.text ?? '', event.answer ?? '', event.frame)
      names.push('dialog')
      break
    case 'download':
      value = page === undefined
        ? undefined
        : new Download(page, event.url ?? '', event.suggestedFilename ?? 'download')
      names.push('download')
      break
    case 'filechooser':
      value = page === undefined
        ? undefined
        : new FileChooser(page, event.chooser ?? '', event.multiple === true, event.frame)
      names.push('filechooser')
      break
    case 'request':
      value = new NetworkRecord(event.url ?? '', event.method ?? 'GET', event.status ?? 0, event.error)
      names.push('request', 'response', 'requestfinished')
      break
    default:
      names.push(event.kind)
  }

  for (const name of names) {
    dispatch(event.tab, name, value)
    for (const waiter of [...waiters]) {
      // `popup` is the same event as `page` seen from the tab that opened it,
      // which is how the API this implements spells it — and while only
      // `dispatch` knew that, `page.waitForEvent('popup')` waited for
      // something that was never going to be named.
      if (waiter.kind !== name && !(waiter.kind === 'popup' && name === 'page' && event.opener !== undefined)) continue
      // A new page belongs to whoever opened it, not to the tab it *is*, so a
      // waiter armed on one page is scoped to popups from that page — without
      // that, `pageA.waitForEvent('popup')` was resolved by a popup page B
      // opened, and the body drove the wrong tab.
      const scope = name === 'page' ? event.opener ?? event.tab : event.tab
      if (waiter.tab !== undefined && waiter.tab !== scope) continue
      if (waiter.since > event.at + 50) continue
      try {
        if (waiter.predicate !== undefined && !waiter.predicate(value)) continue
      } catch {
        continue
      }
      waiter.resolve(value)
    }
  }

  // After the handlers have had it, not before: a task's `page.on('close')` is
  // registered under the tab's own key. Nothing addresses a closed tab again,
  // and every entry here is a closure compiled by the body that installed it,
  // so leaving them meant a space that opened and closed a hundred popups held
  // a hundred bodies' worth of captured scope for as long as the tab was open.
  if (event.kind === 'close') forgetPage(event.tab)
}

/**
 * Drop everything a closed tab was still holding.
 * @param tab - the tab that has gone.
 */
function forgetPage(tab: string): void {
  pages.delete(tab)
  for (const key of [...handlers.keys()]) if (key.startsWith(`${tab}:`)) handlers.delete(key)
}

/**
 * Run the handlers registered for one event on one tab.
 * @param tab - which tab.
 * @param name - the event's name.
 * @param value - what to hand them.
 */
function dispatch(tab: string, name: string, value: unknown): void {
  for (const key of [`${tab}:${name}`, `ctx:${name}`]) {
    const set = handlers.get(key)
    if (set === undefined) continue
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry)
      try {
        const returned = entry.fn(value)
        if (returned instanceof Promise) returned.catch(() => undefined)
      } catch {
        // A handler that throws is the task's problem, not the machine's; the
        // page that fired the event carries on either way.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// the context and the browser
// ---------------------------------------------------------------------------

/** The size every tab in this machine has. */
let viewport = { width: 1280, height: 800 }

/** Fetching, as `context.request` offers it. */
const request = {
  /** GET a URL. */
  get: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> => fetchThrough('GET', url, options),
  /** POST to one. */
  post: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> => fetchThrough('POST', url, options),
  /** PUT. */
  put: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> => fetchThrough('PUT', url, options),
  /** DELETE. */
  delete: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> => fetchThrough('DELETE', url, options),
  /** HEAD. */
  head: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> => fetchThrough('HEAD', url, options),
  /** Any method. */
  fetch: async (url: string, options: Record<string, unknown> = {}): Promise<APIResponse> =>
    fetchThrough(String(options.method ?? 'GET'), url, options),
}

/**
 * Make one request through the machine's own network policy.
 * @param method - the HTTP method.
 * @param url - where to.
 * @param options - headers and a body.
 * @returns the response.
 */
async function fetchThrough(method: string, url: string, options: Record<string, unknown>): Promise<APIResponse> {
  // Anything that is not a read is an action, and the host refuses it in a
  // read-only run for that reason — but only `guard()` sets `mutated`, so a
  // body that posted an order and then threw reported `mutation: 'none'`,
  // which the recovery advice reads as "nothing happened; safe to repeat".
  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'HEAD') guard(`context.request.${method.toLowerCase()}()`)

  // `params` go on the URL, the way the API this imitates puts them there.
  // Silently dropping them fetched page one and reported success.
  const params = options.params as Record<string, unknown> | undefined
  let target = url
  if (params !== undefined) {
    try {
      const built = new URL(url)
      for (const [name, value] of Object.entries(params)) built.searchParams.set(name, String(value))
      target = built.href
    } catch {
      // Not a URL this side can parse. The host resolves it, and dropping the
      // request over the query string would be worse than sending it without.
      const query = new URLSearchParams()
      for (const [name, value] of Object.entries(params)) query.set(name, String(value))
      target = `${url}${url.includes('?') ? '&' : '?'}${query.toString()}`
    }
  }

  // A form is url-encoded, an object `data` is JSON, and a string is whatever
  // the caller made it. Each one implies a content type that the server needs
  // and that nothing else here would send.
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined ?? {}) }
  const stated = Object.keys(headers).some((held) => held.toLowerCase() === 'content-type')
  let body: string | undefined
  let carries: string | undefined
  const form = options.form as Record<string, unknown> | undefined
  if (form !== undefined) {
    const encoded = new URLSearchParams()
    for (const [name, value] of Object.entries(form)) encoded.set(name, String(value))
    body = encoded.toString()
    carries = 'application/x-www-form-urlencoded'
  } else if (typeof options.data === 'object' && options.data !== null) {
    body = JSON.stringify(options.data)
    carries = 'application/json'
  } else if (options.data !== undefined) {
    body = String(options.data)
  } else if (options.body !== undefined) {
    body = String(options.body)
  }
  if (!stated && carries !== undefined) headers['content-type'] = carries

  const raw = await rpc('request.fetch', {
    method,
    url: target,
    headers,
    ...(body === undefined ? {} : { body }),
  }) as { status: number, url: string, headers: Record<string, string>, body: string }
  return new APIResponse(raw)
}

/** The task's browser context: its pages, its profile, its events. */
const context = {
  /** Every page this task has open. */
  pages: (): Page[] => [...pages.values()].filter((page) => !page.isClosed() && page.tabId !== ''),

  /**
   * Open another page in this task.
   * @param url - where to send it, optionally.
   * @returns the page.
   */
  newPage: async (url?: string): Promise<Page> => {
    guard('newPage()')
    const created = await rpc('tabs.new', { ...(url === undefined ? {} : { url }) }) as { tab: string, url: string, title: string }
    const page = pages.get(created.tab) ?? new Page(created.tab, created.url)
    page.update(created)
    if (state.page === undefined || state.page.tabId === '') state.page = page
    return page
  },

  /** Fetching, outside any page. */
  request,

  /** Every cookie in this machine's profile. */
  cookies: async (): Promise<Record<string, unknown>[]> => await rpc('profile.cookies') as Record<string, unknown>[],

  /**
   * Empty this machine's profile — its cookies and every site's storage.
   *
   * Wider than the name suggests, and deliberately so: the profile is one
   * thing here, and a caller reaching for this wants a site to forget them,
   * which on a machine where no cookie travels the network is mostly
   * `localStorage`.
   */
  clearCookies: async (): Promise<void> => {
    guard('clearCookies()')
    await rpc('profile.clear')
  },

  /**
   * Listen for something on any page.
   *
   * The same registration `page.on` performs, under the context's own key —
   * including the duplicate guard and the dialog policy a handler implies.
   * Written out separately, this copy had neither, so `context.on('dialog',
   * d => d.accept())` accumulated one handler per run and never actually
   * accepted anything.
   */
  on: (kind: string, fn: (value: unknown) => unknown): void => {
    listen(`ctx:${kind}`, fn, false)
    if (kind === 'dialog') armFromHandler(state.page, fn)
  },

  /** Listen once. */
  once: (kind: string, fn: (value: unknown) => unknown): void => {
    listen(`ctx:${kind}`, fn, true)
    if (kind === 'dialog') armFromHandler(state.page, fn)
  },

  /** Stop listening. */
  off: (kind: string, fn: (value: unknown) => unknown): void => { unlisten(`ctx:${kind}`, fn) },

  /** Wait for one thing to happen anywhere in this task. */
  waitForEvent: async (kind: string, options?: { timeout?: number, predicate?: (value: unknown) => boolean } | ((value: unknown) => boolean)): Promise<unknown> =>
    waitForEvent(kind, typeof options === 'function' ? { predicate: options } : options ?? {}),

  /**
   * What `getByTestId` should read.
   *
   * Named against a page, because `page.command` is addressed to a document
   * and one with no `tab` on it was answered with "this task has no page open"
   * — for a setting whose whole point is to be made before the first `goto`.
   * With no page yet the choice is remembered and applied to each document as
   * it arrives, which is what a caller writing this line first means by it.
   */
  setDefaultTestIdAttribute: async (attribute: string): Promise<void> => {
    testIdAttribute = attribute
    const page = state.page
    const tab = page?.tabId
    if (page === undefined || tab === undefined || tab === '') return
    await rpc('page.command', { tab, kind: 'testId', payload: { attribute } }).catch(() => undefined)
    // And the frames already in it, the way `setDialogPolicy` does: each is its
    // own document with its own copy of this setting, and one loaded before
    // this call is never told — so `frameLocator(…).getByTestId(…)` matched
    // nothing on a control that was plainly there. Frames that arrive later are
    // armed by the `load` handler.
    const listed = await page.frames().catch(() => [])
    await Promise.all(listed.map(async (frame) => {
      const token = frame.token
      if (typeof token !== 'string' || token === '') return
      await rpc('page.command', { tab, frameToken: token, kind: 'testId', payload: { attribute } })
        .catch(() => undefined)
    }))
  },

  /** Present so a recipe that calls it does not fail; a task space is closed by finishing it. */
  close: async (): Promise<void> => { void 0 },
}

/** The machine itself, as little of it as a task ever needs. */
const browser = {
  /** The one context a task has. */
  contexts: (): (typeof context)[] => [context],
  /** Its pages. */
  pages: (): Page[] => context.pages(),
  /** What this build is. */
  version: (): string => 'webdsh browser machine',
  /** Always true: the machine is this page, and this page is running. */
  isConnected: (): boolean => true,
  /** A new context is not a thing here; the task space is the context. */
  newContext: async (): Promise<typeof context> => context,
  /** The same. */
  newPage: async (): Promise<Page> => context.newPage(),
  /** Closing the browser is not a task's business. */
  close: async (): Promise<void> => { void 0 },
}

// ---------------------------------------------------------------------------
// expect, and assert
// ---------------------------------------------------------------------------

/** How long a retrying matcher keeps trying. */
const EXPECT_TIMEOUT_MS = 5000

/**
 * Retry an assertion until it holds or the time runs out.
 *
 * This is the whole reason `expect` exists beside `assert`: a page is
 * asynchronous, so an assertion made the instant after a click is an assertion
 * about the page before it. Retrying converts a race into a wait.
 * @param check - throws while the assertion does not hold.
 * @param timeout - how long to keep trying.
 */
async function retry(check: () => Promise<void>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeoutOf(timeout, EXPECT_TIMEOUT_MS)
  let last: unknown
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw last instanceof Error ? last : new Error(String(last))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Test a pattern the body supplied, without letting it remember where it got to.
 *
 * `RegExp.prototype.test` on a `/g` or `/y` pattern advances `lastIndex`, and
 * every one of these runs inside a retry loop — so `expect(…).not.toHaveText(
 * /row/g)` matched, matched, then found nothing on the third poll and passed
 * on a page that plainly contained the text. Rebuilt per call, the way
 * `frame-locate.ts` rebuilds the ones that cross the channel.
 * @param pattern - the caller's expression.
 * @param text - what to test it against.
 * @returns whether it matches.
 */
function patternMatches(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags).test(text)
}

/** Compare a value against a string or a pattern, the way Playwright does. */
function textEquals(actual: string, expected: unknown): boolean {
  if (expected instanceof RegExp) return patternMatches(expected, actual)
  return actual.trim() === String(expected).trim()
}

/**
 * Structural deep equality, matching `util.isDeepStrictEqual`.
 *
 * The same rules as `src/node/misc.ts`, restated because this file is bundled
 * on its own into an opaque origin and imports nothing at run time. The
 * branches below are the reason it is not a five-line `Object.keys` walk:
 * `Object.keys` is empty for a `Date`, a `Map` and a `Set`, so a shorter
 * version reports two different dates as equal and calls it a passing
 * assertion.
 * @param a - one value.
 * @param b - the other.
 * @returns whether they are the same structure with the same contents.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => deepEqual(value, (b as unknown[])[index]))
  }
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime()
  if (a instanceof RegExp) return b instanceof RegExp && a.source === b.source && a.flags === b.flags
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !deepEqual(value, b.get(key))) return false
    return true
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false
    // Structurally, not by identity, which is what `isDeepStrictEqual` does
    // and what this claims to match: `has` compares object members by
    // reference, so `new Set([{x: 1}])` was never equal to another set holding
    // the same thing and `toEqual` failed on values that were plainly the same.
    const rest = [...b]
    for (const value of a) {
      const index = rest.findIndex((other) => deepEqual(value, other))
      if (index === -1) return false
      rest.splice(index, 1)
    }
    return true
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * Compare an attribute or a value against a string or a pattern.
 *
 * A pattern is tested against the empty string when the attribute is absent,
 * and an exact comparison is not: `toHaveAttribute('x', '')` asks for an
 * attribute that is there and empty, which an element without one is not.
 * @param actual - what the page has, or null when it has nothing.
 * @param expected - a string or a pattern.
 * @returns whether it matches.
 */
function like(actual: string | null, expected: unknown): boolean {
  if (expected instanceof RegExp) return patternMatches(expected, actual ?? '')
  return actual === String(expected)
}

/** Say what a value is, briefly, for a failure message. */
function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * The matchers that ask a locator one yes-or-no question and retry it.
 *
 * A table because that is what they are: a name, the question, and how to say
 * it when the answer is the wrong one. Written out, the nine differ by two
 * strings each and a call.
 */
const STATE_MATCHERS: [string, (target: Locator) => Promise<boolean>, string][] = [
  ['toBeVisible', (target) => target.isVisible(), 'be visible'],
  ['toBeHidden', (target) => target.isHidden(), 'be hidden'],
  ['toBeAttached', async (target) => await target.count() > 0, 'be attached'],
  ['toBeEnabled', (target) => target.isEnabled(), 'be enabled'],
  ['toBeDisabled', (target) => target.isDisabled(), 'be disabled'],
  ['toBeEditable', (target) => target.isEditable(), 'be editable'],
  ['toBeChecked', (target) => target.isChecked(), 'be checked'],
  ['toBeEmpty', async (target) => ((await target.textContent()) ?? '').trim() === '', 'be empty'],
  ['toBeFocused', (target) => target.isFocused(), 'have keyboard focus'],
]

/**
 * The assertions a task makes about a page.
 *
 * Every locator matcher retries, every value matcher does not, and `.not`
 * inverts either — which is the contract a recipe written for Playwright's
 * `expect` relies on.
 * @param subject - a locator, a page, or a plain value.
 * @param negated - whether this is the `.not` half.
 * @param timeout - how long the retrying matchers keep trying.
 * @returns the matchers.
 */
function makeExpect(subject: unknown, negated = false, timeout = EXPECT_TIMEOUT_MS): Record<string, unknown> {
  const locator = subject instanceof Locator ? subject : undefined
  const page = subject instanceof Page ? subject : undefined
  const name = locator === undefined ? show(subject) : 'the locator'

  /** Fail unless the condition matches what was asked for. */
  const holds = (condition: boolean, message: string): void => {
    if (condition === negated) {
      throw new Error(`expected ${name} ${negated ? 'not ' : ''}to ${message}`)
    }
  }

  const matchers: Record<string, unknown> = {
    // -- retrying, on a locator ---------------------------------------------
    ...Object.fromEntries(STATE_MATCHERS.map(([key, probe, phrase]) => [
      key,
      async (options: { timeout?: number } = {}) => retry(async () => {
        holds(await probe(locator!), phrase)
      }, options.timeout ?? timeout),
    ])),
    toHaveText: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      if (Array.isArray(expected)) {
        const actual = await locator!.allInnerTexts()
        holds(actual.length === expected.length && actual.every((text, index) => textEquals(text, expected[index])),
          `have text ${show(expected)}; it has ${show(actual)}`)
        return
      }
      const actual = await locator!.innerText()
      holds(textEquals(actual, expected), `have text ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toContainText: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.innerText()
      const matched = expected instanceof RegExp
        ? patternMatches(expected, actual)
        : actual.includes(String(expected))
      holds(matched, `contain ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveValue: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.inputValue()
      holds(like(actual, expected), `have value ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveAttribute: async (attribute: string, expected?: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.getAttribute(attribute)
      if (expected === undefined) {
        holds(actual !== null, `have the attribute ${attribute}`)
        return
      }
      holds(like(actual, expected), `have ${attribute}=${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveClass: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = (await locator!.getAttribute('class')) ?? ''
      holds(like(actual, expected), `have class ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveCount: async (expected: number, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.count()
      holds(actual === expected, `have ${String(expected)} matches; there are ${String(actual)}`)
    }, options.timeout ?? timeout),
    toHaveId: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.getAttribute('id')
      holds(like(actual, expected), `have id ${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveJSProperty: async (property: string, expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.evaluate(`(node, key) => node[key]`, property)
      holds(deepEqual(actual, expected), `have ${property} of ${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),

    // -- retrying, on a page -------------------------------------------------
    toHaveURL: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const info = await rpc('page.info', { tab: page!.tabId }) as { url: string, title: string }
      page!.update(info)
      holds(expected instanceof RegExp
        ? patternMatches(expected, info.url)
        : info.url === String(expected) || info.url.includes(String(expected)),
        `have the URL ${show(expected)}; it is ${show(info.url)}`)
    }, options.timeout ?? timeout),
    toHaveTitle: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const title = await page!.title()
      holds(like(title, expected), `have the title ${show(expected)}; it is ${show(title)}`)
    }, options.timeout ?? timeout),

    // -- plain values --------------------------------------------------------
    toBe: (expected: unknown) => { holds(Object.is(subject, expected), `be ${show(expected)}`) },
    toEqual: (expected: unknown) => { holds(deepEqual(subject, expected), `equal ${show(expected)}`) },
    toStrictEqual: (expected: unknown) => { holds(deepEqual(subject, expected), `equal ${show(expected)}`) },
    toBeTruthy: () => { holds(Boolean(subject), 'be truthy') },
    toBeFalsy: () => { holds(!subject, 'be falsy') },
    toBeNull: () => { holds(subject === null, 'be null') },
    toBeUndefined: () => { holds(subject === undefined, 'be undefined') },
    toBeDefined: () => { holds(subject !== undefined, 'be defined') },
    toBeNaN: () => { holds(Number.isNaN(subject), 'be NaN') },
    toContain: (expected: unknown) => {
      const held = Array.isArray(subject)
        ? subject.includes(expected)
        : String(subject).includes(String(expected))
      holds(held, `contain ${show(expected)}`)
    },
    toMatch: (expected: unknown) => {
      holds(expected instanceof RegExp
        ? patternMatches(expected, String(subject))
        : String(subject).includes(String(expected)),
        `match ${show(expected)}`)
    },
    toHaveLength: (expected: number) => {
      holds((subject as { length?: number }).length === expected, `have length ${String(expected)}`)
    },
    toBeGreaterThan: (expected: number) => { holds(Number(subject) > expected, `be greater than ${String(expected)}`) },
    toBeGreaterThanOrEqual: (expected: number) => { holds(Number(subject) >= expected, `be at least ${String(expected)}`) },
    toBeLessThan: (expected: number) => { holds(Number(subject) < expected, `be less than ${String(expected)}`) },
    toBeLessThanOrEqual: (expected: number) => { holds(Number(subject) <= expected, `be at most ${String(expected)}`) },
    toBeCloseTo: (expected: number, digits = 2) => {
      holds(Math.abs(Number(subject) - expected) < Math.pow(10, -digits) / 2, `be close to ${String(expected)}`)
    },
    toThrow: (expected?: unknown) => {
      let threw = false
      let message = ''
      try {
        ;(subject as () => unknown)()
      } catch (error) {
        threw = true
        message = error instanceof Error ? error.message : String(error)
      }
      holds(threw && (expected === undefined || message.includes(String(expected))), 'throw')
    },
    /** Retry an arbitrary check until it passes. */
    toPass: async (options: { timeout?: number } = {}) => retry(async () => {
      await (subject as () => Promise<void>)()
    }, options.timeout ?? timeout),
  }
  matchers.not = negated ? matchers : makeExpect(subject, true, timeout)
  return matchers
}

/** Playwright's `expect`, with the matchers this machine can answer. */
const expect = Object.assign(
  (subject: unknown) => makeExpect(subject),
  {
    /** A copy with a different default timeout. */
    configure: (options: { timeout?: number }) => (subject: unknown) => makeExpect(subject, false, options.timeout ?? EXPECT_TIMEOUT_MS),
    /** Soft assertions are not separated from hard ones here; this is the same. */
    soft: (subject: unknown) => makeExpect(subject),
  },
)

/** `node:assert/strict`, as much of it as a task body uses. */
function assertion(value: unknown, message?: string): void {
  // Truthiness, not a list of the falsy values somebody remembered: `NaN` is
  // what `Number(cell)` gives for a price that did not parse, and enumerating
  // instead of negating let exactly that through as a passing assertion.
  if (!value) {
    throw new Error(message ?? `assertion failed: ${show(value)} is not truthy`)
  }
}

/**
 * `equal` and `strictEqual`, which `node:assert/strict` makes the same thing.
 * @param actual - what there is.
 * @param expected - what was wanted.
 * @param message - what to say instead of the default.
 */
const strictEqual = (actual: unknown, expected: unknown, message?: string): void => {
  if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
}

/**
 * `deepEqual` and `deepStrictEqual`, likewise.
 * @param actual - what there is.
 * @param expected - what was wanted.
 * @param message - what to say instead of the default.
 */
const deepStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
  if (!deepEqual(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
}

const assert = Object.assign(assertion, {
  /** Truthy. */
  ok: assertion,
  /** Strictly equal. */
  equal: strictEqual,
  /** The same. */
  strictEqual,
  /** Not equal. */
  notEqual: (actual: unknown, expected: unknown, message?: string): void => {
    if (Object.is(actual, expected)) throw new Error(message ?? `expected something other than ${show(expected)}`)
  },
  /** Deeply equal. */
  deepEqual: deepStrictEqual,
  /** The same. */
  deepStrictEqual,
  /** Matches a pattern. */
  match: (actual: string, pattern: RegExp, message?: string): void => {
    if (!patternMatches(pattern, actual)) {
      throw new Error(message ?? `${show(actual)} does not match ${String(pattern)}`)
    }
  },
  /** Always fails. */
  fail: (message?: string): never => { throw new Error(message ?? 'failed') },
  /** Throws. */
  throws: (fn: () => unknown, message?: string): void => {
    try {
      fn()
    } catch {
      return
    }
    throw new Error(message ?? 'expected the function to throw')
  },
  /** Rejects. */
  rejects: async (promise: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void> => {
    try {
      await (typeof promise === 'function' ? promise() : promise)
    } catch {
      return
    }
    throw new Error(message ?? 'expected the promise to reject')
  },
})

// ---------------------------------------------------------------------------
// the helpers a task gets beside the browser API
// ---------------------------------------------------------------------------

/** The page later calls act on, which `usePage` changes. */
const state: { page: Page | undefined } = { page: undefined }

/**
 * The most recently opened page that is still open.
 * @returns the page, or undefined when the task has none.
 */
function livePage(): Page | undefined {
  return [...pages.values()].filter((page) => !page.isClosed() && page.tabId !== '').pop()
}

/** The page a task is working on, as a stand-in that follows `usePage`. */
const pageProxy = new Proxy({} as Page, {
  get: (_target, property) => {
    const current = state.page ?? new Page('')
    state.page ??= current
    const value: unknown = Reflect.get(current, property, current)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value
  },
  set: (_target, property, value) => {
    const current = state.page
    return current === undefined ? false : Reflect.set(current, property, value, current)
  },
  has: (_target, property) => state.page !== undefined && property in state.page,
  // So that `page instanceof Page` is true, and `usePage(page)` — which every
  // "keep a handle on the original" recipe does — is not refused for holding
  // the stand-in rather than the thing it stands in for.
  getPrototypeOf: () => Page.prototype,
})

/**
 * The additive helpers, which do the things Playwright has no opinion about.
 *
 * Named `tabbit` because that is what they are called wherever else they
 * appear, and a recipe that reaches for `tabbit.observe()` should find it. They
 * add bounded observation and safer interaction; they replace nothing.
 */
const tabbit = Object.freeze({
  /**
   * One bounded look at the page: tree, frames and focus, all capped.
   * @param options - what to include and how much of it.
   * @returns the observation.
   */
  observe: async (options: {
    frames?: 'none' | 'visible' | 'all'
    focus?: boolean
    depth?: number
    maxChars?: number
    frameMaxChars?: number
    maxFrames?: number
    boxes?: boolean
  } = {}): Promise<unknown> => rpc('observe', { tab: state.page?.tabId, ...options }),

  /**
   * What has focus, followed through frames and shadow roots.
   *
   * Two questions, because a document can only answer for itself: the page
   * says which of its frames holds focus, and that frame is then asked what
   * inside it does. Asking only the first left "what would my keystroke
   * reach" answered with `<iframe>`, which is never what the caller meant.
   */
  focusInfo: async (): Promise<unknown> => {
    const tab = state.page?.tabId
    const outer = await rpc('page.command', { tab, kind: 'focus.info', payload: {} }) as { inFrame?: unknown }
    const inside = outer.inFrame
    if (typeof inside !== 'string' || inside === '' || inside === 'unknown') return outer
    try {
      const inner = await rpc('page.command', { tab, frameToken: inside, kind: 'focus.info', payload: {} })
      return { ...(inner as Record<string, unknown>), inFrame: inside }
    } catch {
      // The frame has gone, or it has no runtime in it. What the page above
      // said still stands.
      return outer
    }
  },

  /**
   * What would stop an action on a target right now, frame hosts included.
   * @param target - the locator to check.
   * @returns the verdict.
   */
  actionability: async (target: Locator): Promise<unknown> => target.actionability(),

  /**
   * Click, but only after checking that the click can land.
   * @param target - what to click.
   * @param options - passed on to the click.
   */
  safeClick: async (target: Locator, options: Record<string, unknown> = {}): Promise<void> => {
    const state_ = await target.actionability() as {
      found: boolean, visible: boolean, receivesEvents: boolean, enabled: boolean, occludedBy?: string
    }
    if (!state_.found) throw new Error('safeClick: nothing matches that locator')
    if (!state_.visible) throw new Error('safeClick: the target is not visible')
    if (!state_.enabled) throw new Error('safeClick: the target is disabled')
    if (!state_.receivesEvents) {
      throw new Error(`safeClick: the target would not receive the click${state_.occludedBy === undefined
        ? '' : ` — ${state_.occludedBy} is on top of it`}`)
    }
    await target.click(options)
  },

  /**
   * What is at a point, or under a locator's centre.
   * @param target - a locator or a viewport point.
   * @returns what the browser would deliver a click to.
   */
  hitTest: async (target: Locator | { x: number, y: number }): Promise<unknown> => (target instanceof Locator
    ? rpc('page.command', { ...target.address(), kind: 'hit.test', payload: { chain: target.chain } })
    : rpc('page.command', { tab: state.page?.tabId, kind: 'hit.test', payload: { x: target.x, y: target.y } })),

  /**
   * Paste into the focused field, which is how long or tabular text gets in.
   * @param text - what to paste.
   * @param options - the format, and whether to insist on an editable target.
   * @returns what happened, without echoing the payload.
   */
  pasteText: async (text: string, options: { format?: 'text' | 'tsv', requireEditableFocus?: boolean } = {}): Promise<unknown> => {
    guard('pasteText()')
    const tab = state.page?.tabId
    // Into the document that has focus, which for a framed editor is not the
    // page around it: a paste dispatched at the outer document lands on the
    // `<iframe>` element, so `requireEditableFocus` refused a field that had
    // just been clicked and without it the event went nowhere at all.
    const frame = await focusedFrame(tab)
    return rpc('page.command', {
      tab,
      ...(frame === undefined ? {} : { frameToken: frame }),
      kind: 'paste',
      payload: { text, ...options },
    })
  },

  /**
   * Arm a waiter, then do the thing that should trigger it.
   *
   * The order is the entire point: installing the waiter after the click is a
   * race the click usually wins, and then the wait times out on an event that
   * already happened.
   * @param event - `popup`, `page`, `download`, `dialog`, `navigation` or `url`.
   * @param trigger - what to do once the waiter is armed.
   * @param options - a timeout, and the URL for `url`.
   * @returns whatever the event carried.
   */
  triggerAndWait: async (
    event: string,
    trigger: () => Promise<unknown> | unknown,
    options: { timeoutMs?: number, url?: string | RegExp } = {},
  ): Promise<unknown> => {
    const timeout = timeoutOf(options.timeoutMs, 15_000)
    if (event === 'url' || event === 'navigation') {
      const before = state.page?.url() ?? ''
      await trigger()
      if (event === 'url' && options.url !== undefined) {
        await state.page?.waitForURL(options.url, { timeout })
        return state.page
      }
      const deadline = Date.now() + timeout
      for (;;) {
        const info = await rpc('page.info', { tab: state.page?.tabId }) as { url: string, title: string }
        state.page?.update(info)
        if (info.url !== before) return info
        if (Date.now() > deadline) throw new Error(`nothing navigated within ${String(timeout)}ms; the page is still ${before}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const waiting = waitForEvent(event === 'popup' ? 'page' : event, { timeout })
    // Marked as handled before the trigger can throw. `waiting` rejects on its
    // own timer, and a trigger that failed — an occluded button, say — left it
    // with nobody listening, so the realm reported an unhandled rejection
    // fifteen seconds after the error the body had already seen. The `await`
    // below still delivers it to a caller who gets that far.
    void waiting.catch(() => undefined)
    await trigger()
    return waiting
  },

  /**
   * Do something whose outcome is not known, and report what happened.
   *
   * For the click that might open a tab, might navigate, might open a menu and
   * might do nothing at all — which on a real page is most clicks. Everything
   * is armed first, the trigger runs, and the strongest observed outcome comes
   * back.
   * @param trigger - what to do.
   * @param options - timeouts, and whether to follow a new page.
   * @returns what was observed.
   */
  triggerAndObserve: async (
    trigger: () => Promise<unknown> | unknown,
    options: { timeoutMs?: number, settleMs?: number, activatePage?: boolean } = {},
  ): Promise<{ kind: string, url?: string, page?: Page, revision?: number }> => {
    const timeout = timeoutOf(options.timeoutMs, 5000)
    const settle = timeoutOf(options.settleMs, 400)
    const current = state.page
    const before = current?.url() ?? ''
    const revisionOf = async (): Promise<number> => {
      try {
        // A function, not its source: `evaluate` routes a string to the
        // expression evaluator, which returns the function object itself, and
        // `[Function anonymous]` compares equal to `[Function anonymous]`.
        return await current?.evaluate(() => document.querySelectorAll('*').length) as number
      } catch {
        return -1
      }
    }
    const beforeRevision = await revisionOf()
    const opened = waitForEvent('page', { timeout }).catch(() => undefined)
    const dialog = waitForEvent('dialog', { timeout }).catch(() => undefined)
    const download = waitForEvent('download', { timeout }).catch(() => undefined)

    await trigger()
    await new Promise((resolve) => setTimeout(resolve, settle))

    const page = await Promise.race([opened, new Promise((resolve) => setTimeout(() => { resolve(undefined) }, settle))])
    if (page instanceof Page) {
      if (options.activatePage === true) state.page = page
      return { kind: 'page', page, url: page.url() }
    }
    const info = await rpc('page.info', { tab: current?.tabId }) as { url: string, title: string }
    current?.update(info)
    if (info.url !== before) return { kind: 'navigation', url: info.url }
    const answered = await Promise.race([dialog, Promise.resolve(undefined)])
    if (answered !== undefined) return { kind: 'dialog' }
    const file = await Promise.race([download, Promise.resolve(undefined)])
    if (file !== undefined) return { kind: 'download' }
    const afterRevision = await revisionOf()
    if (afterRevision !== beforeRevision) return { kind: 'dom', revision: afterRevision }
    return { kind: 'none', url: info.url }
  },
})

// ---------------------------------------------------------------------------
// running one body
// ---------------------------------------------------------------------------

/** What a task keeps between calls: whatever it put on `globalThis`. */
const taskGlobals: Record<string, unknown> = {}

/** Anything the body printed, which comes back with the result. */
let log: string[] = []

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]): void => {
    log.push(args.map((value) => (typeof value === 'string' ? value : show(value))).join(' '))
    if (log.length > 200) log.splice(0, log.length - 200)
    original(...args)
  }
}

/**
 * Reduce a returned value to something that can cross the channel.
 *
 * A `Page` or a `Locator` is a handle into this realm and means nothing
 * outside it, so returning one is a mistake worth naming rather than a value
 * worth serialising.
 * @param value - what the body returned.
 * @param depth - how deep this call is.
 * @returns JSON-safe data.
 */
function portable(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[Function ${value.name === '' ? 'anonymous' : value.name}]`
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Page) return `[Page ${value.url()} — return a value, not a page handle]`
  if (value instanceof Locator) return '[Locator — return what you read from it, not the locator]'
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `[${String(value.length)} bytes]`
  if (depth > 6) return '[deep]'
  if (Array.isArray(value)) {
    const kept = value.slice(0, 1000).map((entry) => portable(entry, depth + 1))
    // A truncation nobody is told about is a wrong answer: a task that
    // returned four thousand rows and got a thousand back would report the
    // thousandth as the last one.
    if (value.length > kept.length) {
      kept.push(`[… ${String(value.length - kept.length)} more entries were dropped here. Return an aggregate, `
        + 'or write the whole list with saveFile(path, rows).]')
    }
    return kept
  }
  if (value instanceof Map) return portable(Object.fromEntries(value), depth + 1)
  if (value instanceof Set) return portable([...value], depth + 1)
  // Prototype-less, because the keys come off a value the page supplied:
  // `entries['__proto__'] = …` on a plain object runs the inherited setter and
  // re-parents the accumulator instead of adding a field, so a `__proto__` key
  // vanished from the answer with no truncation notice.
  const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let count = 0
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (count++ > 200) break
    try {
      entries[key] = portable((value as Record<string, unknown>)[key], depth + 1)
    } catch {
      entries[key] = '[unreadable]'
    }
  }
  return entries
}

/** The constructor for an async function body, which is what a task is. */
const AsyncFunction = Object.getPrototypeOf(async function noop() { /* shape only */ }).constructor as
  new (...args: string[]) => (...values: unknown[]) => Promise<unknown>

/**
 * Run one task body.
 *
 * The body is a function body, not a module and not an expression: top-level
 * `await` and `return` both work, which is what every recipe assumes. It is
 * wrapped in `with (globalThis)` so that a value assigned to `globalThis` in
 * one call is a bare name in the next — the persistence a task space promises,
 * with the same spelling it has in Node.
 * @param message - what to run and how.
 */
async function run(message: RunMessage): Promise<void> {
  readOnly = message.readOnly
  artifactRoot = message.artifacts
  mutated = false
  log = []
  abandoned = undefined

  if (message.tab !== undefined && message.tab !== '') {
    if (state.page === undefined || (state.page.tabId !== message.tab && state.page.tabId === '')) {
      state.page = pages.get(message.tab) ?? new Page(message.tab)
    }
  }
  // A page object before there is a tab: `page.goto()` is what opens the tab,
  // and a task that never navigates never costs one.
  state.page ??= new Page('')

  const scope = taskGlobals
  const names = ['globalThis', 'page', 'context', 'browser', 'pages', 'usePage', 'assert', 'expect',
    'artifactPath', 'tabbit', 'saveFile', 'viewport', 'task']
  const values: unknown[] = [
    scope,
    pageProxy,
    context,
    browser,
    () => context.pages(),
    (next: Page | string) => {
      // A page, a tab id, the `page` stand-in itself, or anything else
      // carrying a tab id. The tab id is the one that keeps: `page` is a
      // stand-in that follows `usePage`, so a recipe that saved
      // `const original = page` saved the stand-in and got back wherever the
      // task had moved to — `const original = page.tabId` names one page and
      // keeps naming it.
      const tab = typeof next === 'string' ? next : (next as { tabId?: unknown } | undefined)?.tabId
      const resolved = typeof tab === 'string'
        ? pages.get(tab) ?? (next instanceof Page ? next : undefined)
        : undefined
      if (resolved === undefined) {
        throw new Error('usePage() takes a page or a tab id — the page a popup event gave you, one from '
          + 'pages(), or a `page.tabId` saved earlier')
      }
      // A page that has since been closed selects the nearest live one rather
      // than failing: `usePage(original)` after closing a popup is the
      // ordinary way back, and by then `original` names a page whose tab the
      // machine has already reclaimed.
      state.page = resolved.isClosed() ? livePage() ?? resolved : resolved
    },
    assert,
    expect,
    (name: string) => artifactPath(name),
    tabbit,
    async (path: string, contents: unknown) => {
      guard('saveFile()')
      const bytes = contents instanceof Uint8Array
        ? contents
        : new TextEncoder().encode(typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2))
      return rpc('fs.write', { path, base64: base64(bytes) })
    },
    viewport,
    message.task,
  ]

  const started = Date.now()
  // `diagnostics: 'focus'` wraps the body in a before-and-after look at what
  // has keyboard focus, which is the question behind almost every "I typed and
  // nothing happened".
  const focus = message.diagnostics === 'focus'
  const focusBefore = focus ? await tabbit.focusInfo().catch(() => undefined) : undefined

  /**
   * Report the run, however it ended.
   *
   * One envelope rather than two. While success and failure each wrote their
   * own, they had already drifted — `pages` was added to one and not the
   * other, which reported `pages: []` for exactly the run whose state was in
   * question — and every field added afterwards had to be written twice.
   *
   * The pages a failed run left open are the pages somebody now has to look
   * at, so they are here rather than in the branch that succeeded.
   * @param outcome - the value, or the error and its stack.
   */
  const report = async (outcome: Record<string, unknown>): Promise<void> => {
    post({
      type: 'done',
      id: message.id,
      mutated,
      log,
      ms: Date.now() - started,
      pages: context.pages().map((page) => ({ tab: page.tabId, url: page.url() })),
      // Which of them the body left itself on, which is not the last one it
      // opened: `usePage(original)` after reading a popup moves it back, and
      // the host's own idea of the task's page had no way to hear about that.
      ...(state.page === undefined || state.page.tabId === '' ? {} : { active: state.page.tabId }),
      ...(focus
        ? { focus: { before: portable(focusBefore), after: portable(await tabbit.focusInfo().catch(() => undefined)) } }
        : {}),
      ...outcome,
    })
  }

  try {
    const body = new AsyncFunction(...names, `return (async () => { with (globalThis) {\n${message.code}\n} })()`)
    const value = await body(...values)
    await report({ value: portable(value) })
  } catch (error) {
    await report({
      error: error instanceof Error
        ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`
        : String(error),
      stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join('\n') : '',
    })
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as Record<string, unknown> | undefined
  if (message === undefined || message.realm !== true || message.nonce !== nonce) return

  switch (message.type) {
    case 'run':
      void run(message as unknown as RunMessage)
      return
    case 'reply': {
      const waiting = pending.get(String(message.id))
      if (waiting === undefined) return
      pending.delete(String(message.id))
      if (message.error === undefined) waiting.resolve(message.value)
      else waiting.reject(new Error(String(message.error)))
      return
    }
    case 'event':
      deliver(message.event as HostEvent)
      return
    case 'adopt': {
      // The task's pages, as the host knows them — sent when the realm is made
      // and whenever a page is claimed into the task.
      for (const entry of (message.pages ?? []) as { tab: string, url: string, title: string }[]) {
        const page = pages.get(entry.tab) ?? new Page(entry.tab, entry.url)
        page.update(entry)
      }
      if (typeof message.active === 'string') state.page = pages.get(message.active)
      if (message.viewport !== undefined) viewport = message.viewport as { width: number, height: number }
      return
    }
    case 'abandon':
      abandoned = String(message.reason ?? 'this task space was finished')
      for (const [, waiting] of pending) waiting.reject(new Error(abandoned))
      pending.clear()
      return
    default:
  }
})

post({ type: 'ready' })

export {}
