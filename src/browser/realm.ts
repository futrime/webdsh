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
  timeoutMs: number
}

declare global {
  interface Window {
    __REALM_NONCE__?: string
  }
}

/** The nonce every message in both directions carries. */
const nonce = window.__REALM_NONCE__ ?? ''

/** Post one message to the host. */
function post(message: Record<string, unknown>): void {
  ;(window.top ?? parent).postMessage({ realm: true, nonce, ...message }, '*')
}

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
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ type: 'rpc', id, op, params })
  })
}

/** Whether this run may change anything, and what to say when it may not. */
let readOnly = false

/** Set once anything that could change a page has been attempted. */
let mutated = false

/** Where files this run writes belong. */
let artifactRoot = '/tmp'

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

/** A regular expression as it crosses the channel. */
interface WireRegex { source: string, flags: string }

/** Text to match, either literally or as a pattern. */
interface TextMatch { text?: string, regex?: WireRegex, exact?: boolean }

/** One step of a locator chain, as `src/browser/frame-locate.ts` reads it. */
type Step = Record<string, unknown> & { kind: string }

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

  /** The op every call on this locator sends. */
  async #call(op: string, params: Record<string, unknown>): Promise<unknown> {
    const framed = this.chain[0]?.frame
    return rpc(op, {
      tab: this.page.tabId,
      framePath: this.framePath,
      ...(typeof framed === 'string' && framed !== '' ? { frameToken: framed } : {}),
      chain: this.chain,
      ...params,
    })
  }

  // -- narrowing ------------------------------------------------------------

  locator!: Selectors['locator']
  getByRole!: Selectors['getByRole']
  getByText!: Selectors['getByText']
  getByLabel!: Selectors['getByLabel']
  getByPlaceholder!: Selectors['getByPlaceholder']
  getByAltText!: Selectors['getByAltText']
  getByTitle!: Selectors['getByTitle']
  getByTestId!: Selectors['getByTestId']
  frameLocator!: Selectors['frameLocator']

  /** The nth match, counting from zero. */
  nth(index: number): Locator {
    return new Locator(this.page, this.framePath, [...this.chain, { kind: 'nth', index }])
  }

  /** The first match. */
  first(): Locator { return this.nth(0) }

  /** The last match. */
  last(): Locator { return this.nth(-1) }

  /** Only the matches that also satisfy this. */
  filter(options: { hasText?: string | RegExp, hasNotText?: string | RegExp, has?: Locator, hasNot?: Locator, visible?: boolean }): Locator {
    const step: Step = { kind: 'filter' }
    if (options.hasText !== undefined) step.hasText = textMatch(options.hasText)
    if (options.hasNotText !== undefined) step.hasNotText = textMatch(options.hasNotText)
    if (options.has !== undefined) step.has = options.has.chain
    if (options.hasNot !== undefined) step.hasNot = options.hasNot.chain
    if (options.visible !== undefined) step.visible = options.visible
    return new Locator(this.page, this.framePath, [...this.chain, step])
  }

  /** Matches of both this and the other. */
  and(other: Locator): Locator {
    return new Locator(this.page, this.framePath, [...this.chain, { kind: 'and', chain: other.chain }])
  }

  /** Matches of either. */
  or(other: Locator): Locator {
    return new Locator(this.page, this.framePath, [...this.chain, { kind: 'or', chain: other.chain }])
  }

  // -- acting ---------------------------------------------------------------

  /** Click it, once it can be clicked. */
  async click(options: Record<string, unknown> = {}): Promise<void> {
    guard('click()')
    await this.#call('act', { action: 'click', args: options })
  }

  /** Double-click it. */
  async dblclick(options: Record<string, unknown> = {}): Promise<void> {
    guard('dblclick()')
    await this.#call('act', { action: 'dblclick', args: options })
  }

  /** Tap it, which on a machine with no touchscreen is a click. */
  async tap(options: Record<string, unknown> = {}): Promise<void> {
    guard('tap()')
    await this.#call('act', { action: 'tap', args: options })
  }

  /** Replace the field's value. */
  async fill(value: string, options: Record<string, unknown> = {}): Promise<void> {
    guard('fill()')
    await this.#call('act', { action: 'fill', args: { ...options, value } })
  }

  /** Empty the field. */
  async clear(options: Record<string, unknown> = {}): Promise<void> {
    guard('clear()')
    await this.#call('act', { action: 'clear', args: options })
  }

  /** Type into it one key at a time, as `pressSequentially` does. */
  async type(text: string, options: Record<string, unknown> = {}): Promise<void> {
    guard('type()')
    await this.#call('act', { action: 'type', args: { ...options, text } })
  }

  /** The current name for {@link type}. */
  async pressSequentially(text: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.type(text, options)
  }

  /** Press a key at it, such as `Enter` or `Control+a`. */
  async press(key: string, options: Record<string, unknown> = {}): Promise<void> {
    guard('press()')
    await this.#call('act', { action: 'press', args: { ...options, key } })
  }

  /** Check it, if it is not checked already. */
  async check(options: Record<string, unknown> = {}): Promise<void> {
    guard('check()')
    await this.#call('act', { action: 'check', args: options })
  }

  /** Uncheck it. */
  async uncheck(options: Record<string, unknown> = {}): Promise<void> {
    guard('uncheck()')
    await this.#call('act', { action: 'uncheck', args: options })
  }

  /** Set it to a state. */
  async setChecked(checked: boolean, options: Record<string, unknown> = {}): Promise<void> {
    guard('setChecked()')
    await this.#call('act', { action: 'setChecked', args: { ...options, checked } })
  }

  /** Choose options in a `<select>`. */
  async selectOption(values: unknown, options: Record<string, unknown> = {}): Promise<string[]> {
    guard('selectOption()')
    const result = await this.#call('act', { action: 'selectOption', args: { ...options, values } }) as { value?: string }
    return (result.value ?? '').split(', ').filter((entry) => entry !== '')
  }

  /** Move the pointer over it. */
  async hover(options: Record<string, unknown> = {}): Promise<void> {
    guard('hover()')
    await this.#call('act', { action: 'hover', args: options })
  }

  /** Give it keyboard focus. */
  async focus(): Promise<void> { await this.#call('act', { action: 'focus', args: {} }) }

  /** Take focus away from it. */
  async blur(): Promise<void> { await this.#call('act', { action: 'blur', args: {} }) }

  /** Select its text. */
  async selectText(): Promise<void> { await this.#call('act', { action: 'selectText', args: {} }) }

  /** Scroll it into view. */
  async scrollIntoViewIfNeeded(): Promise<void> { await this.#call('act', { action: 'scrollIntoView', args: {} }) }

  /** Put files into a file input. */
  async setInputFiles(files: string | string[], options: Record<string, unknown> = {}): Promise<void> {
    guard('setInputFiles()')
    const paths = Array.isArray(files) ? files : [files]
    const loaded = await rpc('fs.readMany', { paths }) as unknown[]
    await this.#call('act', { action: 'setInputFiles', args: { ...options, files: loaded } })
  }

  /** Drag it onto another element. */
  async dragTo(target: Locator, options: Record<string, unknown> = {}): Promise<void> {
    guard('dragTo()')
    await this.#call('act', { action: 'dragTo', args: { ...options, target: target.chain } })
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

  /** Where it is, in page coordinates. */
  async boundingBox(): Promise<{ x: number, y: number, width: number, height: number } | null> {
    return await this.#call('box', {}) as { x: number, y: number, width: number, height: number } | null
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
    await this.#call('wait', { state: options.state ?? 'visible', ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }) })
  }

  /** Run a function against the element, in the page's own realm. */
  async evaluate(fn: unknown, argument?: unknown): Promise<unknown> {
    return (await this.#call('evaluate', { source: String(fn), argument }) as { value: unknown }).value
  }

  /** Run a function against every match, in the page's own realm. */
  async evaluateAll(fn: unknown, argument?: unknown): Promise<unknown> {
    return (await this.#call('evaluateAll', { source: String(fn), argument }) as { value: unknown }).value
  }

  /** The accessibility tree under it. */
  async ariaSnapshot(options: { depth?: number, maxChars?: number, boxes?: boolean } = {}): Promise<string> {
    const snapshot = await rpc('aria.snapshot', {
      tab: this.page.tabId, framePath: this.framePath, chain: this.chain, ...options,
    }) as { text: string }
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
    return this.page.screenshot({ ...options, clip: box })
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

  locator!: Selectors['locator']
  getByRole!: Selectors['getByRole']
  getByText!: Selectors['getByText']
  getByLabel!: Selectors['getByLabel']
  getByPlaceholder!: Selectors['getByPlaceholder']
  getByAltText!: Selectors['getByAltText']
  getByTitle!: Selectors['getByTitle']
  getByTestId!: Selectors['getByTestId']
  frameLocator!: Selectors['frameLocator']

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
    const binary = atob(this.#body)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
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
    const saved = await rpc('download.save', { url: this.#url, path, suggestedFilename: this.#suggested }) as { path: string }
    this.#saved = saved.path
  }

  /**
   * Where the file is, saving it into the task's artifacts if it has not been.
   * @returns the path.
   */
  async path(): Promise<string> {
    if (this.#saved === undefined) await this.saveAs(`${artifactRoot}/${this.#suggested}`)
    return this.#saved ?? ''
  }

  /** What went wrong, which for a fetch that has not happened yet is nothing. */
  async failure(): Promise<string | null> {
    try {
      await this.path()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

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

  constructor(page: Page, kind: string, message: string, answer: string) {
    this.#page = page
    this.#kind = kind
    this.#message = message
    this.#answer = answer
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
    // Arm the *next* one too, so a page that asks twice gets the same answer.
    await this.#page.setDialogPolicy({ action: 'accept', ...(promptText === undefined ? {} : { promptText }) })
    if (this.#answer === 'false' || this.#answer === 'null') {
      throw new Error(`this ${this.#kind} was already answered "${this.#answer}" before the handler ran: a page's `
        + 'modal is synchronous and this machine cannot pause one. Install the handler before the action that '
        + 'raises the dialog, or call page.setDialogPolicy({action: "accept"}) first — the next one will accept.')
    }
  }

  /** Say the dialog should be dismissed. */
  async dismiss(): Promise<void> {
    await this.#page.setDialogPolicy({ action: 'dismiss' })
    if (this.#answer === 'true') {
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

/** One thing that happened, as the host reported it. */
interface HostEvent {
  kind: string
  tab: string
  at: number
  url?: string
  title?: string
  opener?: string
  text?: string
  level?: string
  answer?: string
  dialog?: string
  suggestedFilename?: string
  chooser?: string
  multiple?: boolean
  status?: number
  method?: string
  error?: string
  frame?: string
}

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
const handlers = new Map<string, Set<{ fn: (value: unknown) => unknown, once: boolean }>>()

/** Every page this task has, by tab id. */
const pages = new Map<string, Page>()

/** The keyboard, which is the page's rather than an element's. */
class Keyboard {
  readonly #page: Page

  constructor(page: Page) { this.#page = page }

  /** Press a key, or a combination such as `Control+a`. */
  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    guard('keyboard.press()')
    await this.#page.command('keyboard', { action: 'press', key, ...options })
  }

  /** Hold a key down. */
  async down(key: string): Promise<void> {
    guard('keyboard.down()')
    await this.#page.command('keyboard', { action: 'down', key })
  }

  /** Let it up. */
  async up(key: string): Promise<void> {
    guard('keyboard.up()')
    await this.#page.command('keyboard', { action: 'up', key })
  }

  /** Type text one key at a time. */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    guard('keyboard.type()')
    await this.#page.command('keyboard', { action: 'type', text, ...options })
  }

  /** Put text in without pretending it was typed. */
  async insertText(text: string): Promise<void> {
    guard('keyboard.insertText()')
    await this.#page.command('keyboard', { action: 'insertText', text })
  }
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

  /** Press the button. */
  async down(options: { button?: string } = {}): Promise<unknown> {
    guard('mouse.down()')
    return this.#page.command('mouse', { action: 'down', x: this.#x, y: this.#y, ...options })
  }

  /** Let it up. */
  async up(options: { button?: string } = {}): Promise<unknown> {
    guard('mouse.up()')
    return this.#page.command('mouse', { action: 'up', x: this.#x, y: this.#y, ...options })
  }

  /** Click at a point. */
  async click(x: number, y: number, options: Record<string, unknown> = {}): Promise<unknown> {
    guard('mouse.click()')
    this.#x = x
    this.#y = y
    return this.#page.command('mouse', { action: 'click', x, y, ...options })
  }

  /** Double-click at a point. */
  async dblclick(x: number, y: number, options: Record<string, unknown> = {}): Promise<unknown> {
    guard('mouse.dblclick()')
    this.#x = x
    this.#y = y
    return this.#page.command('mouse', { action: 'dblclick', x, y, ...options })
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
    pages.delete(this.#tab)
    this.#tab = tab
    pages.set(tab, this)
  }

  locator!: Selectors['locator']
  getByRole!: Selectors['getByRole']
  getByText!: Selectors['getByText']
  getByLabel!: Selectors['getByLabel']
  getByPlaceholder!: Selectors['getByPlaceholder']
  getByAltText!: Selectors['getByAltText']
  getByTitle!: Selectors['getByTitle']
  getByTestId!: Selectors['getByTestId']
  frameLocator!: Selectors['frameLocator']

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
  async command(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return rpc('page.command', { tab: this.tabId, kind, payload })
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

  /** Its rendered text. */
  async innerText(): Promise<string> {
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
      timeoutMs: options.timeout ?? 15_000,
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
    const deadline = Date.now() + (options.timeout ?? 15_000)
    for (;;) {
      const info = await rpc('page.info', { tab: this.tabId }) as { url: string, title: string, loading?: boolean }
      this.update(info)
      if (info.loading !== true && info.url !== 'about:blank') break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    if (state === 'domcontentloaded') return
    await this.command('waitFor', { timeoutMs: Math.max(1000, deadline - Date.now()) })
  }

  /** Wait until the URL matches. */
  async waitForURL(pattern: string | RegExp | ((url: string) => boolean), options: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? 15_000)
    const test = (url: string): boolean => {
      if (typeof pattern === 'function') return pattern(url)
      if (pattern instanceof RegExp) return pattern.test(url)
      return url === pattern || url.includes(pattern)
    }
    for (;;) {
      const info = await rpc('page.info', { tab: this.tabId }) as { url: string, title: string }
      this.update(info)
      if (test(info.url)) return
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${String(options.timeout ?? 15_000)}ms waiting for the URL to match; `
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
        if (matcher instanceof RegExp) return matcher.test(record.url())
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
    const set = handlers.get(`${this.tabId}:${kind}`)
    for (const entry of set ?? []) if (entry.fn === fn) set?.delete(entry)
    return this
  }

  #listen(kind: string, fn: (value: unknown) => unknown, once: boolean): this {
    const key = `${this.tabId}:${kind}`
    const set = handlers.get(key) ?? new Set()
    set.add({ fn, once })
    handlers.set(key, set)
    if (kind === 'dialog') {
      // The answer to a modal has to exist before the modal does; see the note
      // on {@link Dialog}. Reading the handler is the only way to know what it
      // was going to say, and it is a good enough guess to make the common
      // recipe work: a handler that accepts, accepts.
      const source = String(fn)
      const accepts = /\.accept\s*\(/.test(source)
      const dismisses = /\.dismiss\s*\(/.test(source)
      const promptText = /\.accept\s*\(\s*(['"`])([^'"`]*)\1\s*\)/.exec(source)?.[2]
      void this.setDialogPolicy({
        action: accepts && !dismisses ? 'accept' : dismisses ? 'dismiss' : 'accept',
        ...(promptText === undefined ? {} : { promptText }),
      })
    }
    return this
  }

  /**
   * Decide in advance how the page's modals are answered.
   * @param policy - accept or dismiss, and what a prompt should say.
   */
  async setDialogPolicy(policy: { action: 'accept' | 'dismiss', promptText?: string }): Promise<void> {
    await this.command('dialog.arm', policy as unknown as Record<string, unknown>)
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
  const timeout = options.timeout ?? 30_000
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
      names.push('close')
      break
    case 'navigated':
      page?.update({ url: event.url ?? '', ...(event.title === undefined ? {} : { title: event.title }) })
      value = page
      names.push('framenavigated')
      break
    case 'load':
      page?.update(event.url === undefined ? {} : { url: event.url })
      value = page
      names.push('load', 'domcontentloaded')
      break
    case 'console':
      value = new ConsoleMessage(event.level ?? 'log', event.text ?? '')
      names.push('console')
      break
    case 'dialog':
      value = page === undefined
        ? undefined
        : new Dialog(page, event.dialog ?? 'alert', event.text ?? '', event.answer ?? '')
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
      if (waiter.kind !== name) continue
      if (waiter.tab !== undefined && waiter.tab !== event.tab && name !== 'page') continue
      if (waiter.since > event.at + 50) continue
      try {
        if (waiter.predicate !== undefined && !waiter.predicate(value)) continue
      } catch {
        continue
      }
      waiter.resolve(value)
    }
  }
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
  const body = options.data === undefined
    ? options.body
    : typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
  const raw = await rpc('request.fetch', {
    method,
    url,
    headers: options.headers ?? {},
    ...(body === undefined ? {} : { body: String(body) }),
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
  clearCookies: async (): Promise<void> => { await rpc('profile.clear') },

  /** Listen for something on any page. */
  on: (kind: string, fn: (value: unknown) => unknown): void => {
    const set = handlers.get(`ctx:${kind}`) ?? new Set()
    set.add({ fn, once: false })
    handlers.set(`ctx:${kind}`, set)
  },

  /** Listen once. */
  once: (kind: string, fn: (value: unknown) => unknown): void => {
    const set = handlers.get(`ctx:${kind}`) ?? new Set()
    set.add({ fn, once: true })
    handlers.set(`ctx:${kind}`, set)
  },

  /** Stop listening. */
  off: (kind: string, fn: (value: unknown) => unknown): void => {
    const set = handlers.get(`ctx:${kind}`)
    for (const entry of set ?? []) if (entry.fn === fn) set?.delete(entry)
  },

  /** Wait for one thing to happen anywhere in this task. */
  waitForEvent: async (kind: string, options?: { timeout?: number, predicate?: (value: unknown) => boolean } | ((value: unknown) => boolean)): Promise<unknown> =>
    waitForEvent(kind, typeof options === 'function' ? { predicate: options } : options ?? {}),

  /** What `getByTestId` should read. */
  setDefaultTestIdAttribute: async (attribute: string): Promise<void> => {
    await rpc('page.command', { kind: 'testId', payload: { attribute } })
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
  const deadline = Date.now() + timeout
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

/** Compare a value against a string or a pattern, the way Playwright does. */
function textEquals(actual: string, expected: unknown, options: { useInnerText?: boolean } = {}): boolean {
  void options
  if (expected instanceof RegExp) return expected.test(actual)
  return actual.trim() === String(expected).trim()
}

/** A deep equality good enough for JSON-shaped data. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => deepEqual(left[key], right[key]))
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
    toBeVisible: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isVisible(), 'be visible')
    }, options.timeout ?? timeout),
    toBeHidden: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isHidden(), 'be hidden')
    }, options.timeout ?? timeout),
    toBeAttached: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.count() > 0, 'be attached')
    }, options.timeout ?? timeout),
    toBeEnabled: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isEnabled(), 'be enabled')
    }, options.timeout ?? timeout),
    toBeDisabled: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isDisabled(), 'be disabled')
    }, options.timeout ?? timeout),
    toBeEditable: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isEditable(), 'be editable')
    }, options.timeout ?? timeout),
    toBeChecked: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isChecked(), 'be checked')
    }, options.timeout ?? timeout),
    toBeEmpty: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(((await locator!.textContent()) ?? '').trim() === '', 'be empty')
    }, options.timeout ?? timeout),
    toBeFocused: async (options: { timeout?: number } = {}) => retry(async () => {
      holds(await locator!.isFocused(), 'have keyboard focus')
    }, options.timeout ?? timeout),
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
      const matched = expected instanceof RegExp ? expected.test(actual) : actual.includes(String(expected))
      holds(matched, `contain ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveValue: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.inputValue()
      holds(expected instanceof RegExp ? expected.test(actual) : actual === String(expected),
        `have value ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveAttribute: async (attribute: string, expected?: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.getAttribute(attribute)
      if (expected === undefined) {
        holds(actual !== null, `have the attribute ${attribute}`)
        return
      }
      holds(expected instanceof RegExp ? expected.test(actual ?? '') : actual === String(expected),
        `have ${attribute}=${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveClass: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = (await locator!.getAttribute('class')) ?? ''
      holds(expected instanceof RegExp ? expected.test(actual) : actual === String(expected),
        `have class ${show(expected)}; it has ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveCount: async (expected: number, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.count()
      holds(actual === expected, `have ${String(expected)} matches; there are ${String(actual)}`)
    }, options.timeout ?? timeout),
    toHaveId: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.getAttribute('id')
      holds(expected instanceof RegExp ? expected.test(actual ?? '') : actual === String(expected),
        `have id ${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),
    toHaveJSProperty: async (property: string, expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const actual = await locator!.evaluate(`(node, key) => node[key]`, property)
      holds(deepEqual(actual, expected), `have ${property} of ${show(expected)}; it is ${show(actual)}`)
    }, options.timeout ?? timeout),

    // -- retrying, on a page -------------------------------------------------
    toHaveURL: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const info = await rpc('page.info', { tab: page!.tabId }) as { url: string, title: string }
      page!.update(info)
      holds(expected instanceof RegExp ? expected.test(info.url) : info.url === String(expected) || info.url.includes(String(expected)),
        `have the URL ${show(expected)}; it is ${show(info.url)}`)
    }, options.timeout ?? timeout),
    toHaveTitle: async (expected: unknown, options: { timeout?: number } = {}) => retry(async () => {
      const title = await page!.title()
      holds(expected instanceof RegExp ? expected.test(title) : title === String(expected),
        `have the title ${show(expected)}; it is ${show(title)}`)
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
      holds(expected instanceof RegExp ? expected.test(String(subject)) : String(subject).includes(String(expected)),
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
  if (value === false || value === null || value === undefined || value === 0 || value === '') {
    throw new Error(message ?? `assertion failed: ${show(value)} is not truthy`)
  }
}

const assert = Object.assign(assertion, {
  /** Truthy. */
  ok: assertion,
  /** Strictly equal. */
  equal: (actual: unknown, expected: unknown, message?: string): void => {
    if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
  },
  /** The same. */
  strictEqual: (actual: unknown, expected: unknown, message?: string): void => {
    if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
  },
  /** Not equal. */
  notEqual: (actual: unknown, expected: unknown, message?: string): void => {
    if (Object.is(actual, expected)) throw new Error(message ?? `expected something other than ${show(expected)}`)
  },
  /** Deeply equal. */
  deepEqual: (actual: unknown, expected: unknown, message?: string): void => {
    if (!deepEqual(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
  },
  /** The same. */
  deepStrictEqual: (actual: unknown, expected: unknown, message?: string): void => {
    if (!deepEqual(actual, expected)) throw new Error(message ?? `expected ${show(expected)}, got ${show(actual)}`)
  },
  /** Matches a pattern. */
  match: (actual: string, pattern: RegExp, message?: string): void => {
    if (!pattern.test(actual)) throw new Error(message ?? `${show(actual)} does not match ${String(pattern)}`)
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

  /** What has focus, followed through frames and shadow roots. */
  focusInfo: async (): Promise<unknown> => rpc('page.command', {
    tab: state.page?.tabId, kind: 'focus.info', payload: {},
  }),

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
  hitTest: async (target: Locator | { x: number, y: number }): Promise<unknown> => rpc('page.command', {
    tab: state.page?.tabId,
    kind: 'hit.test',
    payload: target instanceof Locator ? { chain: target.chain } : { x: target.x, y: target.y },
  }),

  /**
   * Paste into the focused field, which is how long or tabular text gets in.
   * @param text - what to paste.
   * @param options - the format, and whether to insist on an editable target.
   * @returns what happened, without echoing the payload.
   */
  pasteText: async (text: string, options: { format?: 'text' | 'tsv', requireEditableFocus?: boolean } = {}): Promise<unknown> => {
    guard('pasteText()')
    return rpc('page.command', { tab: state.page?.tabId, kind: 'paste', payload: { text, ...options } })
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
    const timeout = options.timeoutMs ?? 15_000
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
    const timeout = options.timeoutMs ?? 5000
    const settle = options.settleMs ?? 400
    const current = state.page
    const before = current?.url() ?? ''
    const revisionOf = async (): Promise<number> => {
      try {
        return await current?.evaluate('() => document.querySelectorAll("*").length') as number
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
  const entries: Record<string, unknown> = {}
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
    (next: Page) => {
      // A page, the `page` stand-in itself, or anything else carrying a tab
      // id: a recipe that saved `const original = page` is handing back the
      // proxy, and refusing it would be refusing the documented pattern.
      const tab = (next as { tabId?: unknown } | undefined)?.tabId
      const resolved = typeof tab === 'string' ? pages.get(tab) ?? (next instanceof Page ? next : undefined) : undefined
      if (resolved === undefined) {
        throw new Error('usePage() takes a page — the one a popup event gave you, or one from pages()')
      }
      // A page that has since been closed selects the nearest live one rather
      // than failing: `usePage(original)` after closing a popup is the
      // ordinary way back, and by then `original` names a page whose tab the
      // machine has already reclaimed.
      state.page = resolved.isClosed() ? livePage() ?? resolved : resolved
    },
    assert,
    expect,
    (name: string) => `${artifactRoot}/${String(name).replace(/^\/+/, '').replace(/\.\./g, '')}`,
    tabbit,
    async (path: string, contents: unknown) => {
      guard('saveFile()')
      const bytes = contents instanceof Uint8Array
        ? contents
        : new TextEncoder().encode(typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2))
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      return rpc('fs.write', { path, base64: btoa(binary) })
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
  try {
    const body = new AsyncFunction(...names, `return (async () => { with (globalThis) {\n${message.code}\n} })()`)
    const value = await body(...values)
    post({
      type: 'done',
      id: message.id,
      value: portable(value),
      mutated,
      log,
      ms: Date.now() - started,
      pages: context.pages().map((page) => ({ tab: page.tabId, url: page.url() })),
      ...(focus
        ? { focus: { before: portable(focusBefore), after: portable(await tabbit.focusInfo().catch(() => undefined)) } }
        : {}),
    })
  } catch (error) {
    post({
      type: 'done',
      id: message.id,
      error: error instanceof Error
        ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`
        : String(error),
      stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join('\n') : '',
      mutated,
      log,
      ms: Date.now() - started,
      ...(focus
        ? { focus: { before: portable(focusBefore), after: portable(await tabbit.focusInfo().catch(() => undefined)) } }
        : {}),
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
