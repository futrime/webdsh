/**
 * Locators, actionability and observation, inside the document itself.
 *
 * `src/browser/frame.ts` gave a tab five verbs — snapshot, click, type, key,
 * evaluate — and a `ref` that only means anything until the next snapshot.
 * That is enough to drive a page and not enough to *program* one, which is
 * what a task space is for: a loop over a table, a wait for the row that
 * appears, an assertion that retries. All three need the same thing, and it is
 * the thing a ref cannot give — a description of an element that survives the
 * page re-rendering under it.
 *
 * So this module implements the shape that solved the problem elsewhere: a
 * locator is a *recipe*, not a pointer. `getByRole('button', {name: 'Save'})`
 * is a chain of steps, it is re-resolved from the live DOM every time it is
 * used, and an element replaced between two calls is simply found again. The
 * chain arrives over the message channel as plain JSON, which is what lets the
 * task realm hold something that looks like a Playwright `Locator` while the
 * DOM it names lives in another origin entirely.
 *
 * ## What is here and why
 *
 * - **Roles and names**, computed the way the accessibility tree computes
 *   them, because that is what `getByRole` means and a role guessed from the
 *   tag name gets `<div role="button">` wrong in both directions.
 * - **Actionability**, which is the part that separates a click that worked
 *   from a click that resolved. Playwright's list, and each check is here
 *   because it fails on real pages: attached, visible, stable, enabled, and —
 *   the one everybody forgets — *receiving events*, which is how a cookie
 *   banner over the button is caught before the click lands on the banner.
 * - **Observation** — an ARIA snapshot with stable refs, focus that follows
 *   into shadow roots, and a hit test — so a model can ask what is actually
 *   there rather than inferring it from a screenshot.
 *
 * Everything is synchronous where the DOM is synchronous and polls where the
 * page needs time. Nothing here talks to the host: `frame.ts` owns the
 * channel, this owns the document.
 */

import { bounded, fromBase64 } from './protocol.ts'

// Re-exported because `frame.ts` reaches everything in this module as
// `locate.*`, and its `fetch` and `XMLHttpRequest` shims decode bodies with it.
export { fromBase64 }

/** How long an action waits for its target to become actionable. */
const DEFAULT_ACTION_TIMEOUT_MS = 15_000

/** How often the actionability loop re-checks. */
const POLL_MS = 40

/** A regular expression as it crosses the channel. */
export interface WireRegex {
  source: string
  flags: string
}

/** Text to match, either literally or as a pattern. */
export interface TextMatch {
  text?: string
  regex?: WireRegex
  exact?: boolean
}

/** One step of a locator chain. */
export type LocatorStep =
  | { kind: 'css', selector: string }
  | { kind: 'xpath', selector: string }
  | { kind: 'ariaRef', ref: string }
  | ({ kind: 'role', role: string, level?: number, checked?: boolean, pressed?: boolean
    , selected?: boolean, expanded?: boolean, disabled?: boolean, includeHidden?: boolean } & { name?: TextMatch })
  | { kind: 'text', match: TextMatch }
  | { kind: 'label', match: TextMatch }
  | { kind: 'placeholder', match: TextMatch }
  | { kind: 'altText', match: TextMatch }
  | { kind: 'title', match: TextMatch }
  | { kind: 'testId', match: TextMatch }
  | { kind: 'nth', index: number }
  | { kind: 'filter', hasText?: TextMatch, hasNotText?: TextMatch, has?: LocatorStep[], hasNot?: LocatorStep[], visible?: boolean }
  | { kind: 'and', chain: LocatorStep[] }
  | { kind: 'or', chain: LocatorStep[] }

/** The attribute `getByTestId` reads, which Playwright lets a project change. */
let testIdAttribute = 'data-testid'

/**
 * Point `getByTestId` at another attribute.
 * @param attribute - the attribute name.
 */
export function setTestIdAttribute(attribute: string): void {
  testIdAttribute = attribute
}

/**
 * Rebuild a regular expression that came over the channel.
 * @param wire - its source and flags.
 * @returns the expression.
 */
function toRegex(wire: WireRegex): RegExp {
  return new RegExp(wire.source, wire.flags)
}

/**
 * Collapse whitespace the way accessible-name computation does.
 * @param text - raw text.
 * @returns the normalised text.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a string satisfies a text match.
 *
 * The default is Playwright's: substring, case-insensitive, whitespace
 * normalised. `exact` means the whole string, case-sensitive — still
 * whitespace-normalised, because the DOM's whitespace is not the page's.
 * @param value - the string from the page.
 * @param match - what was asked for.
 * @returns whether it matches.
 */
function matches(value: string, match: TextMatch | undefined): boolean {
  if (match === undefined) return true
  const subject = normalise(value)
  if (match.regex !== undefined) return toRegex(match.regex).test(subject)
  if (match.text === undefined) return true
  const wanted = normalise(match.text)
  return match.exact === true
    ? subject === wanted
    : subject.toLocaleLowerCase().includes(wanted.toLocaleLowerCase())
}

// ---------------------------------------------------------------------------
// roles and names
// ---------------------------------------------------------------------------

/**
 * Implicit ARIA roles by tag, for the tags where the mapping is unconditional.
 *
 * Prototype-less, because the key comes off the page: `<constructor>` would
 * otherwise find `Object.prototype.constructor`, `??` would not fall through,
 * and `ariaRole` would return a function typed as a string — which then fails
 * `postMessage`'s structured clone on the way back and reads as a page that
 * stopped answering.
 */
const IMPLICIT_ROLES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  article: 'article', aside: 'complementary', blockquote: 'blockquote', button: 'button',
  code: 'code', datalist: 'listbox', dd: 'definition', del: 'deletion', details: 'group',
  dfn: 'term', dialog: 'dialog', dt: 'term', em: 'emphasis', fieldset: 'group',
  figure: 'figure', form: 'form', hgroup: 'group', hr: 'separator', html: 'document',
  iframe: 'iframe', ins: 'insertion', legend: 'legend', li: 'listitem', main: 'main', mark: 'mark',
  math: 'math', menu: 'list', meter: 'meter', nav: 'navigation', ol: 'list',
  optgroup: 'group', option: 'option', output: 'status', p: 'paragraph',
  progress: 'progressbar', search: 'search', strong: 'strong', sub: 'subscript',
  summary: 'button', sup: 'superscript', table: 'table', tbody: 'rowgroup',
  textarea: 'textbox', tfoot: 'rowgroup', thead: 'rowgroup', time: 'time',
  tr: 'row', ul: 'list',
})

/** Input types whose role is not `textbox`. Prototype-less; see {@link IMPLICIT_ROLES}. */
const INPUT_ROLES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  button: 'button', checkbox: 'checkbox', image: 'button', number: 'spinbutton',
  radio: 'radio', range: 'slider', reset: 'button', submit: 'button',
  email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
  search: 'searchbox',
})

/**
 * The ARIA role an element actually has.
 *
 * An explicit `role` wins, then the implicit mapping — and the conditional
 * cases are conditional for a reason a page will hit: `<a>` without `href` is
 * not a link, `<img>` with an empty `alt` is presentational and must not be
 * findable by role, `<section>` is a region only when it has a name, and
 * `<td>` is a cell only inside a real table.
 * @param element - the element.
 * @returns its role, or the empty string when it has none worth naming.
 */
export function ariaRole(element: Element): string {
  const explicit = element.getAttribute('role')
  if (explicit !== null && explicit.trim() !== '') return explicit.trim().split(/\s+/)[0] ?? ''
  const tag = element.tagName.toLowerCase()
  if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : 'generic'
  if (tag === 'img') {
    const alt = element.getAttribute('alt')
    return alt === '' ? 'presentation' : 'img'
  }
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    if (type === 'hidden') return ''
    return INPUT_ROLES[type] ?? 'textbox'
  }
  if (tag === 'select') {
    const select = element as HTMLSelectElement
    return select.multiple || select.size > 1 ? 'listbox' : 'combobox'
  }
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'header') return element.closest('article,aside,main,nav,section') === null ? 'banner' : 'generic'
  if (tag === 'footer') return element.closest('article,aside,main,nav,section') === null ? 'contentinfo' : 'generic'
  // A `<section>` is a region only when the *author* named it. Asking
  // `accessibleName` instead fell through to the section's own `innerText`, so
  // every section with any text in it answered `region` — and every call paid
  // a forced layout and the text of the whole subtree to find that out.
  if (tag === 'section') return hasAuthoredName(element) ? 'region' : 'generic'
  if (tag === 'td') return element.closest('table') === null ? 'generic' : 'cell'
  if (tag === 'th') {
    if (element.closest('table') === null) return 'generic'
    const scope = element.getAttribute('scope')
    return scope === 'row' ? 'rowheader' : 'columnheader'
  }
  if (tag === 'div' || tag === 'span') return 'generic'
  return IMPLICIT_ROLES[tag] ?? 'generic'
}

/**
 * Whether an element carries a name the author wrote, rather than one derived
 * from its contents.
 * @param element - the element.
 * @returns whether `aria-label`, `aria-labelledby` or `title` names it.
 */
function hasAuthoredName(element: Element): boolean {
  for (const attribute of ['aria-label', 'aria-labelledby', 'title']) {
    if ((element.getAttribute(attribute) ?? '').trim() !== '') return true
  }
  return false
}

/**
 * The heading level, for `getByRole('heading', {level})`.
 * @param element - the element.
 * @returns the level, or undefined when it has none.
 */
function headingLevel(element: Element): number | undefined {
  const explicit = element.getAttribute('aria-level')
  if (explicit !== null && explicit.trim() !== '') return Number(explicit)
  const tag = element.tagName.toLowerCase()
  return /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined
}

/**
 * The text an element contributes to a name, following into shadow roots.
 * @param element - the element.
 * @returns the text.
 */
function textOf(element: Element): string {
  const root = (element as HTMLElement).shadowRoot
  if (root !== null && root !== undefined) return normalise(root.textContent ?? '')
  const rendered = (element as HTMLElement).innerText
  return normalise(rendered === undefined || rendered === '' ? element.textContent ?? '' : rendered)
}

/**
 * The name a screen reader would announce.
 *
 * The accessible-name computation, shortened to the branches real pages take:
 * `aria-labelledby`, `aria-label`, the control's own `<label>`, `placeholder`,
 * `alt`, `title`, and finally the element's text. The order matters more than
 * the completeness — a button labelled both ways must resolve to the label the
 * user hears, or `getByRole('button', {name})` finds the wrong one.
 * @param element - the element.
 * @returns its accessible name, whitespace-normalised.
 */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null && labelledBy.trim() !== '') {
    const parts = labelledBy.split(/\s+/)
      .map((id) => {
        const target = element.ownerDocument.getElementById(id)
        return target === null ? '' : textOf(target)
      })
      .filter((text) => text !== '')
    if (parts.length > 0) return parts.join(' ')
  }
  const label = element.getAttribute('aria-label')
  if (label !== null && label.trim() !== '') return normalise(label)

  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'meter' || tag === 'progress') {
    const labels = (element as HTMLInputElement).labels
    if (labels !== null && labels !== undefined && labels.length > 0) {
      const text = [...labels].map((entry) => textOf(entry)).join(' ').trim()
      if (text !== '') return text
    }
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim() !== '') return normalise(placeholder)
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      // A submit button with no other name announces its value, and where
      // there is no value the browser's own default label.
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = (element as HTMLInputElement).value
        if (value !== '') return normalise(value)
        if (type === 'submit') return 'Submit'
        if (type === 'reset') return 'Reset'
      }
    }
  }
  const alt = element.getAttribute('alt')
  if (alt !== null && alt.trim() !== '') return normalise(alt)
  if (tag === 'img' || tag === 'input' || tag === 'iframe') {
    const title = element.getAttribute('title')
    if (title !== null && title.trim() !== '') return normalise(title)
  }
  // A control's contents are not its name. `<select>` holds its options and
  // `<input>` holds nothing at all, so falling back to text here would name a
  // dropdown after everything in it — and `getByRole('combobox', {name})`
  // would then match on a word the user cannot see as a label.
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && tag !== 'meter' && tag !== 'progress') {
    const own = textOf(element)
    if (own !== '') return own
  }
  const title = element.getAttribute('title')
  return title === null ? '' : normalise(title)
}

// ---------------------------------------------------------------------------
// visibility and state
// ---------------------------------------------------------------------------

/**
 * Whether an element renders, by Playwright's definition.
 *
 * A non-empty bounding box and no `visibility: hidden` — deliberately not
 * `offsetParent`, which is null for everything inside a `position: fixed`
 * header, and deliberately not opacity, which Playwright counts as visible
 * because a page fading something in is still showing it.
 * @param element - the element.
 * @returns whether it is visible.
 */
export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (style === undefined) return false
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
  if (element.hasAttribute('hidden')) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Whether an element renders *or could be holding something that does*.
 *
 * Not {@link isVisible}, and the difference is the whole point. Playwright's
 * rule — a box with both dimensions above zero — is the right one for a
 * locator, which resolves one element and acts on it. It is the wrong one for
 * a tree walk, which prunes the subtree of anything it calls hidden: the
 * portal root a dialog is rendered into is a `<div>` of full width and zero
 * height, because everything inside it is `position: fixed`, and so is an
 * uncleared float parent. Requiring both dimensions deleted the dialog from
 * every snapshot the model could have got a ref out of.
 *
 * So a walk asks this instead: genuinely hidden — `display: none`,
 * `visibility`, the `hidden` attribute, a collapsed box in both directions —
 * prunes; a box that is flat in one direction does not.
 * @param element - the element.
 * @returns whether the walk should look inside it.
 */
export function isRendered(element: Element): boolean {
  if (!element.isConnected) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (style === undefined) return false
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
  if (element.hasAttribute('hidden')) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

/**
 * Whether an element is hidden from the accessibility tree.
 * @param element - the element.
 * @returns whether a screen reader would skip it.
 */
export function isAriaHidden(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true
    if (node.hasAttribute('inert')) return true
  }
  return false
}

/**
 * Whether a control is disabled, following the ancestors that disable it.
 * @param element - the element.
 * @returns whether it is disabled.
 */
export function isDisabled(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true
  const form = element as HTMLInputElement
  if (typeof form.disabled === 'boolean' && form.disabled) return true
  const fieldset = element.closest('fieldset[disabled]')
  if (fieldset !== null && element.closest('fieldset[disabled] > legend:first-of-type') === null) return true
  return false
}

/**
 * Whether an element can be typed into.
 * @param element - the element.
 * @returns whether it is editable.
 */
export function isEditable(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable) return true
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly
  }
  if (element instanceof HTMLSelectElement) return !element.disabled
  return false
}

/**
 * Whether a checkbox, radio or `aria-checked` control is checked.
 * @param element - the element.
 * @returns the state.
 */
export function isChecked(element: Element): boolean {
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    return element.checked
  }
  const aria = element.getAttribute('aria-checked')
  if (aria !== null) return aria === 'true'
  const pressed = element.getAttribute('aria-pressed')
  if (pressed !== null) return pressed === 'true'
  if (element instanceof HTMLOptionElement) return element.selected
  throw new Error(`${element.tagName.toLowerCase()} is not a checkbox, a radio or an aria-checked control`)
}

// ---------------------------------------------------------------------------
// resolving a chain
// ---------------------------------------------------------------------------

/**
 * Elements the last look at this document named, keyed by the ref it handed out.
 *
 * One registry, not one per kind of look. `browser_snapshot` and
 * `browser_inspect` both hand the model `e12`, and while each kept a map of its
 * own the same spelling named two different elements in the same document — so
 * a ref read off one and given to the other silently acted on whatever the
 * other had numbered twelfth.
 */
const ariaRefs = new Map<string, Element>()

/** How many refs one document may have outstanding. See {@link noteAriaRef}. */
const MAX_ARIA_REFS = 20_000

/**
 * Start a fresh set of refs, which is what taking a look means.
 *
 * Refs are minted per look and replaced by the next one: one that outlived a
 * re-render would name an element the page had already thrown away.
 *
 * The counter is deliberately *not* reset with the map. Two looks number the
 * same document differently — `snapshot()` walks `children` through its own
 * filter, `ariaSnapshot()` folds transparent roles and descends shadow roots —
 * so restarting at one meant `e12` from the earlier look was a live element in
 * the later look's map, and a command given it acted on the wrong node and
 * reported success. Counting on means a ref from a previous look is simply
 * absent, which is the error every caller already handles.
 */
export function resetAriaRefs(): void {
  ariaRefs.clear()
}

/**
 * Name one element, so a later command can be told to act on it.
 * @param element - the element being reported.
 * @returns the ref, in the `e12` spelling every look uses.
 */
export function noteAriaRef(element: Element): string {
  const ref = `e${String(++refCounter)}`
  ariaRefs.set(ref, element)
  // Bounded, because not every look clears it: a scoped `locator.ariaSnapshot()`
  // must *not* reset the registry — the caller is still holding the handles
  // from the look before it — so a body that snapshots one row per iteration
  // added entries for ever, each one a strong reference to a node the page had
  // since re-rendered away. The oldest go first; they are the ones nobody can
  // still be holding. The cap is far above any single snapshot's own refs.
  if (ariaRefs.size > MAX_ARIA_REFS) {
    for (const held of ariaRefs.keys()) {
      ariaRefs.delete(held)
      if (ariaRefs.size <= MAX_ARIA_REFS) break
    }
  }
  return ref
}

/**
 * The element a ref names, if this document still has it.
 * @param ref - the handle a look handed out.
 * @returns the element, or undefined when the ref is unknown.
 */
export function ariaRefElement(ref: string): Element | undefined {
  return ariaRefs.get(ref)
}

/**
 * Every element in a root, including through open shadow roots.
 *
 * Shadow DOM is not a curiosity here: a page built with web components keeps
 * every control inside one, and a locator engine that stops at the boundary
 * reports such a page as empty.
 *
 * A generator because every caller walks the result once and throws it away.
 * Materialising it first cost an array the size of the document on every
 * locator resolution — including the `css` step, which only wants the handful
 * of elements that turn out to have a shadow root.
 * @param root - where to start.
 * @yields every descendant element, in document order.
 */
function* descendants(root: ParentNode): Generator<Element> {
  for (const element of root.querySelectorAll('*')) {
    yield element
    const shadow = (element as HTMLElement).shadowRoot
    if (shadow !== null && shadow !== undefined) yield* descendants(shadow)
  }
}

/**
 * Whether one node contains another, crossing open shadow boundaries.
 * @param ancestor - the outer node.
 * @param node - the inner one.
 * @returns whether the first contains the second.
 */
function containsDeep(ancestor: Node, node: Node): boolean {
  let current: Node | null = node
  while (current !== null) {
    if (current === ancestor) return true
    const parent: Node | null = current.parentNode
    if (parent === null) {
      const host = (current as ShadowRoot).host as Element | undefined
      current = host ?? null
      continue
    }
    current = parent
  }
  return false
}

/** The steps that are one attribute lookup, and the attribute each reads. */
const STEP_ATTRIBUTES = { placeholder: 'placeholder', altText: 'alt', title: 'title' } as const

/**
 * Matches for one step, searched inside a set of roots.
 * @param step - the step.
 * @param roots - the scopes to search.
 * @returns the elements it selects, document order, deduplicated.
 */
function stepMatches(step: LocatorStep, roots: (ParentNode | Element)[]): Element[] {
  const found: Element[] = []
  // A set beside the array, purely for the membership test: `found.includes`
  // would make a step that matches most of the page quadratic in its size.
  const seen = new Set<Element>()
  const add = (element: Element): void => {
    if (seen.has(element)) return
    seen.add(element)
    found.push(element)
  }

  for (const root of roots) {
    switch (step.kind) {
      case 'css': {
        for (const element of (root as ParentNode).querySelectorAll(step.selector)) add(element)
        // Shadow roots are their own trees; a selector has to be run in each.
        for (const holder of descendants(root as ParentNode)) {
          const shadow = (holder as HTMLElement).shadowRoot
          if (shadow === null || shadow === undefined) continue
          for (const element of shadow.querySelectorAll(step.selector)) add(element)
        }
        break
      }
      case 'xpath': {
        const document_ = (root as Element).ownerDocument ?? (root as Document)
        // `//tr` is absolute from the document root even when it is evaluated
        // with an element as the context node, so a chained XPath escaped the
        // locator it was chained onto and matched the whole page. Inside a
        // scope it means what it reads as: `.//tr`.
        const selector = root instanceof Element && step.selector.startsWith('/')
          ? `.${step.selector}`
          : step.selector
        const result = document_.evaluate(
          selector,
          root as Node,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        )
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index)
          if (node instanceof Element) add(node)
        }
        break
      }
      case 'ariaRef': {
        const element = ariaRefs.get(step.ref)
        if (element === undefined) {
          throw new Error(`no element ${step.ref}: aria refs come from the most recent snapshot of this page `
            + 'and are replaced by the next one. Take a fresh snapshot.')
        }
        // Gone is a *result*, not a failure. `waitFor({state: 'detached'})`,
        // `count()` and `expect(...).not.toBeVisible()` are the ways of asking
        // whether an element has been taken away, and throwing here failed
        // every one of them at the moment they should have succeeded. An
        // action on a ref that has gone still fails — as no match, which
        // `strictlyOne` explains.
        if (!element.isConnected) break
        if (containsDeep(root as Node, element) || root === element.ownerDocument) add(element)
        break
      }
      case 'role': {
        for (const element of descendants(root as ParentNode)) {
          if (ariaRole(element) !== step.role) continue
          if (step.includeHidden !== true && (isAriaHidden(element) || !isVisible(element))) continue
          if (step.name !== undefined && !matches(accessibleName(element), step.name)) continue
          if (step.level !== undefined && headingLevel(element) !== step.level) continue
          if (step.disabled !== undefined && isDisabled(element) !== step.disabled) continue
          if (step.checked !== undefined) {
            try {
              if (isChecked(element) !== step.checked) continue
            } catch { continue }
          }
          if (step.pressed !== undefined && (element.getAttribute('aria-pressed') === 'true') !== step.pressed) continue
          if (step.selected !== undefined && (element.getAttribute('aria-selected') === 'true') !== step.selected) continue
          if (step.expanded !== undefined && (element.getAttribute('aria-expanded') === 'true') !== step.expanded) continue
          add(element)
        }
        break
      }
      case 'text': {
        // The smallest element whose own text matches, which is what
        // `getByText` means: a match on `<body>` is never what was wanted.
        //
        // Every element is asked for its text twice — once as itself and once
        // as its parent's child — and `textOf` reads `innerText`, which forces
        // layout. The walk is synchronous, so the page cannot change under it
        // and one answer per element is the same answer.
        const text = new Map<Element, string>()
        const textFor = (element: Element): string => {
          let held = text.get(element)
          if (held === undefined) {
            held = textOf(element)
            text.set(element, held)
          }
          return held
        }
        for (const element of descendants(root as ParentNode)) {
          if (!matches(textFor(element), step.match)) continue
          let inner = false
          for (const child of element.children) {
            if (!matches(textFor(child), step.match)) continue
            inner = true
            break
          }
          if (inner) continue
          add(element)
        }
        break
      }
      case 'label': {
        for (const element of descendants(root as ParentNode)) {
          const labels = (element as HTMLInputElement).labels
          const named = labels !== null && labels !== undefined && labels.length > 0
            ? [...labels].map((entry) => textOf(entry)).join(' ')
            : element.getAttribute('aria-label') ?? ''
          if (named === '' && element.getAttribute('aria-labelledby') !== null) {
            if (matches(accessibleName(element), step.match)) add(element)
            continue
          }
          if (named !== '' && matches(named, step.match)) add(element)
        }
        break
      }
      case 'placeholder':
      case 'altText':
      case 'title': {
        const attribute = STEP_ATTRIBUTES[step.kind]
        for (const element of descendants(root as ParentNode)) {
          const value = element.getAttribute(attribute)
          if (value !== null && matches(value, step.match)) add(element)
        }
        break
      }
      case 'testId': {
        for (const element of descendants(root as ParentNode)) {
          const id = element.getAttribute(testIdAttribute)
          if (id !== null && matches(id, { ...step.match, exact: step.match.regex === undefined })) add(element)
        }
        break
      }
      default:
        throw new Error(`${(step as { kind: string }).kind} is not a step that selects elements`)
    }
  }
  return found
}

/**
 * Resolve a whole chain against this document.
 *
 * Each step narrows the one before it, which is what makes
 * `table.getByRole('row').filter({hasText: 'Ada'}).getByRole('cell')` mean
 * what it reads as. `nth`, `filter`, `and` and `or` operate on the current set
 * rather than searching inside it, so they are applied here rather than in
 * {@link stepMatches}.
 * @param chain - the steps.
 * @param root - the document or element to start from.
 * @returns every element the chain names, in document order.
 */
export function locateAll(chain: LocatorStep[], root: ParentNode = document): Element[] {
  let current: Element[] | undefined
  for (const step of chain) {
    if (step.kind === 'nth') {
      const list = current ?? []
      const index = step.index < 0 ? list.length + step.index : step.index
      const picked = list[index]
      current = picked === undefined ? [] : [picked]
      continue
    }
    if (step.kind === 'filter') {
      const list = current ?? []
      current = list.filter((element) => {
        if (step.hasText !== undefined && !matches(textOf(element), step.hasText)) return false
        if (step.hasNotText !== undefined && matches(textOf(element), step.hasNotText)) return false
        if (step.visible !== undefined && isVisible(element) !== step.visible) return false
        if (step.has !== undefined && locateAll(step.has, element).length === 0) return false
        if (step.hasNot !== undefined && locateAll(step.hasNot, element).length > 0) return false
        return true
      })
      continue
    }
    if (step.kind === 'and') {
      const list = current ?? []
      const other = new Set(locateAll(step.chain, root))
      current = list.filter((element) => other.has(element))
      continue
    }
    if (step.kind === 'or') {
      const list = current ?? []
      const held = new Set(list)
      // Document order, not this-side-then-that: `.first()` on an `or()` means
      // the first of them on the page, and appending the second chain's
      // matches made `getByRole('button').or(getByRole('link')).first()` answer
      // a button below a link that came first.
      current = [...list, ...locateAll(step.chain, root).filter((element) => !held.has(element))]
        .sort((left, right) => {
          const relation = left.compareDocumentPosition(right)
          if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1
          if ((relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1
          return 0
        })
      continue
    }
    current = stepMatches(step, current ?? [root])
  }
  return current ?? []
}

/**
 * Describe a chain the way it was written, for an error message.
 * @param chain - the steps.
 * @returns a short human-readable form.
 */
function describeChain(chain: LocatorStep[]): string {
  return chain.map((step) => {
    switch (step.kind) {
      case 'css': return `locator(${JSON.stringify(step.selector)})`
      case 'xpath': return `locator(${JSON.stringify(step.selector)})`
      case 'ariaRef': return `aria-ref=${step.ref}`
      case 'role': return `getByRole(${JSON.stringify(step.role)}${step.name === undefined
        ? '' : `, {name: ${JSON.stringify(step.name.regex === undefined ? step.name.text : `/${step.name.regex.source}/`)}}`})`
      case 'text': return `getByText(${JSON.stringify(step.match.text ?? `/${step.match.regex?.source ?? ''}/`)})`
      case 'label': return `getByLabel(${JSON.stringify(step.match.text ?? `/${step.match.regex?.source ?? ''}/`)})`
      case 'placeholder': return `getByPlaceholder(${JSON.stringify(step.match.text ?? '')})`
      case 'altText': return `getByAltText(${JSON.stringify(step.match.text ?? '')})`
      case 'title': return `getByTitle(${JSON.stringify(step.match.text ?? '')})`
      case 'testId': return `getByTestId(${JSON.stringify(step.match.text ?? '')})`
      case 'nth': return step.index === 0 ? 'first()' : step.index === -1 ? 'last()' : `nth(${String(step.index)})`
      case 'filter': return 'filter(…)'
      case 'and': return 'and(…)'
      case 'or': return 'or(…)'
      default: return '?'
    }
  }).join('.')
}

/** A short description of one element, for disambiguation messages. */
function describeElement(element: Element): string {
  const role = ariaRole(element)
  const name = accessibleName(element)
  return `<${element.tagName.toLowerCase()}> ${role}${name === '' ? '' : ` ${JSON.stringify(name.slice(0, 60))}`}`
}

/**
 * The one element a chain names, or an error saying why there is not one.
 *
 * Strictness is Playwright's and it is worth keeping: a chain that matches
 * three buttons is a chain whose author does not know which one they meant,
 * and silently taking the first is how an agent fills in the wrong field and
 * reports success.
 * @param chain - the steps.
 * @returns the element.
 */
export function locateOne(chain: LocatorStep[]): Element {
  return strictlyOne(locateAll(chain), chain)
}

/**
 * The same strictness, for a caller that has already resolved the chain.
 *
 * Split out because `performQuery` needs the matches *and* the strict answer,
 * and calling `locateOne` after `locateAll` walked the document twice for
 * every `textContent()` — on a chain with a text step, twice the forced
 * layout, forty times a second while an `expect` retries.
 * @param found - what the chain matched.
 * @param chain - the steps, for the message.
 * @returns the one element.
 */
function strictlyOne(found: Element[], chain: LocatorStep[]): Element {
  if (found.length === 1) {
    const only = found[0]
    if (only !== undefined) return only
  }
  if (found.length === 0) {
    // A ref is the one selector that goes stale rather than simply not
    // matching yet, and it is the likeliest reason for an empty result — the
    // handles are re-minted by every look at the page.
    const stale = chain.some((step) => step.kind === 'ariaRef')
    throw new Error(`no element matches ${describeChain(chain)}`
      + (stale
        ? ' — aria refs come from the most recent look at this page, are replaced by the next one, and name'
          + ' nothing once the page has re-rendered. Take a fresh snapshot.'
        : ''))
  }
  throw new Error(
    `${describeChain(chain)} matches ${String(found.length)} elements, and an action needs exactly one. `
    + `Narrow it with .filter(), .nth(), .first(), or a more specific name. They are: `
    + found.slice(0, 5).map(describeElement).join('; ')
    + (found.length > 5 ? `; and ${String(found.length - 5)} more` : ''),
  )
}

// ---------------------------------------------------------------------------
// actionability
// ---------------------------------------------------------------------------

/** What an actionability check found. */
export interface Actionability {
  found: boolean
  attached: boolean
  visible: boolean
  stable: boolean
  enabled: boolean
  receivesEvents: boolean
  inViewport: boolean
  rect?: { x: number, y: number, width: number, height: number }
  occludedBy?: string
  role?: string
  name?: string
  reason?: string
}

/**
 * Whether one element is the other, or holds it — through shadow roots.
 *
 * `Node.contains` stops at a shadow boundary, so a custom element whose whole
 * appearance lives in its own shadow root was reported as occluded by its own
 * content: the point test landed on the inner button, and the host did not
 * "contain" it.
 * @param target - the element being asked about.
 * @param hit - what the point test found.
 * @returns whether a click at that point reaches the target.
 */
function reaches(target: Element, hit: Element): boolean {
  let node: Node | null = hit
  while (node !== null) {
    if (node === target) return true
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)
  }
  return false
}

/**
 * The element the browser would deliver a click at a point to.
 * @param document_ - the document to ask.
 * @param x - viewport x.
 * @param y - viewport y.
 * @returns the topmost element, following into open shadow roots.
 */
function topmostAt(document_: Document, x: number, y: number): Element | null {
  let element = document_.elementFromPoint(x, y)
  for (;;) {
    const shadow = (element as HTMLElement | null)?.shadowRoot
    if (shadow === null || shadow === undefined) return element
    const inner = shadow.elementFromPoint(x, y)
    if (inner === null || inner === element) return element
    element = inner
  }
}

/**
 * Check everything that has to be true before an element can be clicked.
 * @param element - the target.
 * @param options - whether the element must also receive events, and whether
 *   the answer needs the element described.
 * @returns what was found.
 */
export function checkActionability(
  element: Element | undefined,
  options: { requireEvents?: boolean, previous?: DOMRect, describe?: boolean } = {},
): Actionability {
  if (element === undefined) {
    return { found: false, attached: false, visible: false, stable: false, enabled: false, receivesEvents: false, inViewport: false, reason: 'no element matches' }
  }
  const attached = element.isConnected
  const visible = attached && isVisible(element)
  const rect = element.getBoundingClientRect()
  const enabled = !isDisabled(element)
  const stable = options.previous === undefined
    ? true
    : Math.abs(options.previous.x - rect.x) < 1 && Math.abs(options.previous.y - rect.y) < 1
      && Math.abs(options.previous.width - rect.width) < 1 && Math.abs(options.previous.height - rect.height) < 1
  const view = element.ownerDocument.defaultView
  const inViewport = view !== null && rect.bottom > 0 && rect.right > 0
    && rect.top < view.innerHeight && rect.left < view.innerWidth

  let receivesEvents = false
  let occludedBy: string | undefined
  if (visible && inViewport) {
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    const hit = topmostAt(element.ownerDocument, x, y)
    if (hit !== null) {
      receivesEvents = reaches(element, hit) || hit.contains(element)
      if (!receivesEvents) occludedBy = describeElement(hit)
    }
  }
  return {
    found: true,
    attached,
    visible,
    stable,
    enabled,
    receivesEvents: options.requireEvents === false ? true : receivesEvents,
    inViewport,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    ...(occludedBy === undefined ? {} : { occludedBy }),
    // `accessibleName` reads `innerText`, which forces layout. A poll that
    // asks forty times a second does not need the element described until it
    // gives up, so the caller that polls asks for it then instead.
    ...(options.describe === false ? {} : { role: ariaRole(element), name: accessibleName(element).slice(0, 80) }),
  }
}

/**
 * Wait until a chain resolves to something an action can be performed on.
 *
 * The loop is the whole of Playwright's auto-waiting, and its value is
 * negative space: with it, nothing in a task body ever has to sleep. Scrolling
 * happens here rather than in each action because an element below the fold
 * fails the "receives events" check for a reason that is not the page's fault.
 * @param chain - the locator.
 * @param options - timeout, and whether occlusion matters.
 * @returns the element, once it is ready.
 */
async function waitForActionable(
  chain: LocatorStep[],
  options: {
    timeoutMs?: number, requireEvents?: boolean, requireVisible?: boolean, force?: boolean, scroll?: boolean
  } = {},
): Promise<Element> {
  // `bounded`, because a deadline of `Date.now() + NaN` is `NaN` and
  // `Date.now() > NaN` is false for ever: one unreadable `timeout` turned this
  // into a poll of the document that no timer could end.
  const waitMs = bounded(options.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 0, 600_000)
  const deadline = Date.now() + waitMs
  let previous: DOMRect | undefined
  let last: Actionability | undefined
  for (;;) {
    let element: Element | undefined
    let error: string | undefined
    try {
      element = locateOne(chain)
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
      // Ambiguity is not something waiting fixes. A locator that names three
      // buttons will still name three of them in fifteen seconds, and the
      // author needs to hear that now rather than after a timeout that reads
      // like the page never loaded.
      if (error.includes('an action needs exactly one')) throw thrown
    }
    if (element !== undefined) {
      if (options.force === true) return element
      if (options.scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center' })
      const state = checkActionability(element, {
        ...(options.requireEvents === undefined ? {} : { requireEvents: options.requireEvents }),
        ...(previous === undefined ? {} : { previous }),
        describe: false,
      })
      last = state
      // `stable` is only an answer once there is something to compare against:
      // with `previous` unset it is `true` by default, so acting on the first
      // poll meant never comparing two rectangles at all and clicking a modal
      // half way through sliding in. One more tick is what the guarantee costs.
      const settled = previous !== undefined && state.stable
      previous = element.getBoundingClientRect()
      if (state.attached && (state.visible || options.requireVisible === false)
        && state.enabled && settled && state.receivesEvents) {
        return element
      }
    } else last = { found: false, attached: false, visible: false, stable: false, enabled: false, receivesEvents: false, inViewport: false, ...(error === undefined ? {} : { reason: error }) }

    if (Date.now() > deadline) {
      const detail = last?.reason ?? [
        last?.attached === false ? 'it is not attached to the document' : '',
        last?.visible === false && options.requireVisible !== false ? 'it is not visible' : '',
        last?.enabled === false ? 'it is disabled' : '',
        last?.stable === false ? 'it is still moving' : '',
        last?.receivesEvents === false
          ? `it does not receive pointer events${last.occludedBy === undefined ? '' : ` — ${last.occludedBy} is on top of it`}`
          : '',
      ].filter((part) => part !== '').join(', ')
      throw new Error(`timed out after ${String(waitMs)}ms waiting for `
        + `${describeChain(chain)}: ${detail === '' ? 'it never became actionable' : detail}`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

// ---------------------------------------------------------------------------
// acting
// ---------------------------------------------------------------------------

/** Where a pointer sequence is aimed. */
interface Point { x: number, y: number }

/** The centre of an element, in viewport coordinates. */
function centreOf(element: Element): Point {
  const rect = element.getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** Modifier names as a `KeyboardEvent` spells them. */
function modifierFlags(modifiers: string[] = []): { ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean } {
  const held = new Set(modifiers.map((name) => name.toLowerCase()))
  return {
    ctrlKey: held.has('control') || held.has('ctrl'),
    shiftKey: held.has('shift'),
    altKey: held.has('alt'),
    metaKey: held.has('meta') || held.has('cmd') || held.has('command'),
  }
}

/**
 * Dispatch the pointer sequence a real click produces.
 *
 * The whole sequence, because a page is entitled to listen for any part of it:
 * a menu that opens on `mousedown` never opens for a bare `click()`, and a
 * component library that tracks `pointerdown` sees nothing at all. The events
 * are aimed at a point rather than at the element so that a hit test on the
 * way in is what decides which element receives them, exactly as the browser
 * would decide it.
 * @param element - the target.
 * @param options - button, click count, modifiers, and an optional position.
 */
function dispatchClick(
  element: Element,
  options: { button?: number, clickCount?: number, modifiers?: string[], position?: Point } = {},
): void {
  const point = options.position === undefined
    ? centreOf(element)
    : (() => {
        const rect = element.getBoundingClientRect()
        const at = options.position
        return { x: rect.x + at.x, y: rect.y + at.y }
      })()
  const button = options.button ?? 0
  const flags = modifierFlags(options.modifiers)
  const shared = {
    bubbles: true, cancelable: true, composed: true, view: element.ownerDocument.defaultView,
    clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y, button, buttons: 1, ...flags,
  }
  const pointer = { ...shared, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 }
  element.dispatchEvent(new PointerEvent('pointerover', pointer))
  element.dispatchEvent(new PointerEvent('pointerenter', { ...pointer, bubbles: false }))
  element.dispatchEvent(new MouseEvent('mouseover', shared))
  element.dispatchEvent(new MouseEvent('mousemove', shared))
  const count = options.clickCount ?? 1
  for (let index = 1; index <= count; index += 1) {
    element.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, detail: index }))
    element.dispatchEvent(new MouseEvent('mousedown', { ...shared, detail: index }))
    if (element instanceof HTMLElement) element.focus({ preventScroll: true })
    element.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0, pressure: 0, detail: index }))
    element.dispatchEvent(new MouseEvent('mouseup', { ...shared, buttons: 0, detail: index }))
    if (button === 2) element.dispatchEvent(new MouseEvent('contextmenu', { ...shared, buttons: 0, detail: index }))
    else element.dispatchEvent(new MouseEvent('click', { ...shared, buttons: 0, detail: index }))
  }
  if (count === 2) element.dispatchEvent(new MouseEvent('dblclick', { ...shared, buttons: 0, detail: 2 }))
}

/**
 * Set a form control's value the way a framework will notice.
 *
 * Through the prototype's own setter, because React and everything that copied
 * it install a `value` property on the element itself: assigning to that one
 * updates the DOM and leaves the framework's state behind, which is the
 * classic "the box shows my text and the form submits empty".
 * @param element - the control.
 * @param value - the new value.
 */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) element.value = value
  else setter.call(element, value)
}

/**
 * Type one character or key at an element, as a keyboard would.
 * @param element - the focused element.
 * @param key - the key name.
 * @param modifiers - modifiers held down.
 * @returns whether the default was prevented.
 */
function dispatchKey(element: Element, key: string, modifiers: string[] = []): boolean {
  const flags = modifierFlags(modifiers)
  const init: KeyboardEventInit = {
    key, code: keyCodeFor(key), bubbles: true, cancelable: true, composed: true, ...flags,
  }
  const down = new KeyboardEvent('keydown', init)
  const delivered = element.dispatchEvent(down)
  // The default action, which no synthetic keydown performs on its own. While
  // only printable characters had one, `press('Backspace')` fired a keydown, a
  // keyup and nothing else, and reported `{ok: true}` — so a body that cleared
  // a field one press at a time was told twenty times that it had worked.
  if (delivered && !flags.ctrlKey && !flags.metaKey) {
    if (key.length === 1) insertText(element, key)
    else editByKey(element, key)
  }
  element.dispatchEvent(new KeyboardEvent('keyup', init))
  return !delivered
}

/**
 * The editing a named key does to a field, for the keys that do any.
 *
 * Only the ones whose effect is unambiguous and local: the two deletions and
 * the four caret moves. Everything else — `Tab`, `Escape`, `PageUp` — belongs
 * to the page, which has had the keydown and can act on it.
 * @param element - what has focus.
 * @param key - the key name.
 */
function editByKey(element: Element, key: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return
  const length = element.value.length
  const start = element.selectionStart ?? length
  const end = element.selectionEnd ?? length
  const caret = (at: number): void => {
    try {
      element.setSelectionRange(at, at)
    } catch {
      // An input type with no selection — `number` and `email` among them.
    }
  }
  const cut = (from: number, to: number, inputType: string): void => {
    if (from >= to) return
    setValue(element, element.value.slice(0, from) + element.value.slice(to))
    caret(from)
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType }))
  }
  switch (key) {
    case 'Backspace':
      cut(start === end ? Math.max(0, start - 1) : start, end, 'deleteContentBackward')
      return
    case 'Delete':
      cut(start, start === end ? Math.min(length, end + 1) : end, 'deleteContentForward')
      return
    case 'ArrowLeft': caret(Math.max(0, start - 1)); return
    case 'ArrowRight': caret(Math.min(length, end + 1)); return
    case 'Home': caret(0); return
    case 'End': caret(length); return
    default:
  }
}

/** Keys whose `code` is not derivable from the key name. Prototype-less; see {@link IMPLICIT_ROLES}. */
const KEY_CODES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space', Space: 'Space',
  Control: 'ControlLeft', Shift: 'ShiftLeft', Alt: 'AltLeft', Meta: 'MetaLeft',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
})

/**
 * The `code` a key press should carry.
 *
 * Exported because `src/browser/frame.ts` presses keys too, for the one-shot
 * `browser_key` tool. While it kept its own shorter table the two halves of
 * this machine disagreed about the same keystroke — a digit arrived as
 * `Key1` from one and `Digit1` from the other, and `Shift` was in neither.
 * @param key - the key name, as `KeyboardEvent.key` spells it.
 * @returns what `KeyboardEvent.code` should be.
 */
export function keyCodeFor(key: string): string {
  const known = KEY_CODES[key]
  if (known !== undefined) return known
  if (key.length !== 1) return key
  if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`
  return /[0-9]/.test(key) ? `Digit${key}` : key
}

/**
 * Insert text at the caret of whatever is focused.
 * @param element - the focused element.
 * @param text - what to insert.
 */
function insertText(element: Element, text: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? element.value.length
    setValue(element, element.value.slice(0, start) + text + element.value.slice(end))
    const caret = start + text.length
    try {
      element.setSelectionRange(caret, caret)
    } catch {
      // `setSelectionRange` throws on an input type that has no selection —
      // `number` and `email` among them — and the value is already set.
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
    return
  }
  if ((element as HTMLElement).isContentEditable) {
    const document_ = element.ownerDocument
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, data: text, inputType: 'insertText',
    })
    if (!element.dispatchEvent(beforeInput)) return
    // `execCommand` is deprecated and is still the only call that puts text at
    // the caret of a contenteditable while keeping the selection sane. A rich
    // editor that has cancelled `beforeinput` above has already handled it.
    const inserted = document_.execCommand('insertText', false, text)
    if (!inserted) {
      const selection = document_.getSelection()
      if (selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        range.insertNode(document_.createTextNode(text))
        range.collapse(false)
      } else (element as HTMLElement).append(text)
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
  }
}

/** A file as it crosses the channel. */
export interface WireFile {
  name: string
  mimeType: string
  base64: string
}

/**
 * Put files into a file input and tell the page they arrived.
 *
 * Shared because there are two ways in and they have to be the same one: a
 * task calling `setInputFiles()` on a locator, and the host answering a file
 * chooser the page itself opened.
 * @param input - the `<input type="file">`.
 * @param files - what to put in it.
 * @returns how many files it now holds.
 */
export function setFiles(input: HTMLInputElement, files: WireFile[]): number {
  const transfer = new DataTransfer()
  for (const file of files) {
    transfer.items.add(new File([fromBase64(file.base64) as unknown as BlobPart], file.name, { type: file.mimeType }))
  }
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return transfer.files.length
}

/** What an action reports back. */
export interface ActionResult {
  ok: true
  role?: string
  name?: string
  tag?: string
  value?: string
  /**
   * The values a `<select>` ended up with, as values rather than as one
   * string: an option whose own value contains `, ` is an ordinary option, and
   * the caller used to have to split the joined form back apart.
   */
  values?: string[]
  /** Set when a page's own handler cancelled the action's default. */
  prevented?: boolean
}

/**
 * Actions that read or set state without delivering a pointer, and so do not
 * need the element to be on top of the stack.
 */
const WITHOUT_POINTER = new Set(['focus', 'blur', 'selectOption', 'scrollIntoView', 'setInputFiles',
  // `clear` is `fill('')` and takes the same branch of `performAction`, so a
  // field under a transparent overlay could be written to and not emptied.
  'fill', 'clear'])

/**
 * Actions that do not need the element rendered at all.
 *
 * The upload control almost every real page has is
 * `<input type="file" style="display:none">` behind a styled label, so
 * requiring visibility here meant `setInputFiles()` — the way this machine
 * documents uploading a file — timed out on the ordinary case with "it is not
 * visible". Playwright does not check it either.
 */
const WITHOUT_VISIBILITY = new Set(['setInputFiles', 'focus', 'blur'])

/**
 * Perform one action on the element a chain names.
 * @param chain - the locator.
 * @param action - what to do.
 * @param args - the action's arguments.
 * @param options - timeout and force.
 * @returns what happened.
 */
export async function performAction(
  chain: LocatorStep[],
  action: string,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number, force?: boolean } = {},
): Promise<ActionResult> {
  const timeoutMs = typeof args.timeout === 'number' ? args.timeout : options.timeoutMs
  const force = args.force === true || options.force === true
  const wait = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    force,
    requireEvents: !WITHOUT_POINTER.has(action),
    requireVisible: !WITHOUT_VISIBILITY.has(action),
  }
  const element = await waitForActionable(chain, wait)
  const described = { role: ariaRole(element), name: accessibleName(element).slice(0, 80), tag: element.tagName.toLowerCase() }

  switch (action) {
    case 'click':
    case 'dblclick':
    case 'tap': {
      dispatchClick(element, {
        ...(typeof args.button === 'string' ? { button: args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0 } : {}),
        clickCount: action === 'dblclick' ? 2 : typeof args.clickCount === 'number' ? args.clickCount : 1,
        ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers as string[] } : {}),
        ...(args.position === undefined ? {} : { position: args.position as Point }),
      })
      return { ok: true, ...described }
    }
    case 'hover': {
      const point = centreOf(element)
      const shared = {
        bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y,
        view: element.ownerDocument.defaultView, ...modifierFlags(args.modifiers as string[] | undefined),
      }
      element.dispatchEvent(new PointerEvent('pointerover', { ...shared, pointerType: 'mouse', isPrimary: true }))
      element.dispatchEvent(new MouseEvent('mouseover', shared))
      element.dispatchEvent(new PointerEvent('pointermove', { ...shared, pointerType: 'mouse', isPrimary: true }))
      element.dispatchEvent(new MouseEvent('mousemove', shared))
      return { ok: true, ...described }
    }
    // `clear` is `fill('')`, and this is the branch that says so. Written out
    // twice they had already drifted: the copy skipped the read-only guard, so
    // `clear()` emptied a field `fill('')` refuses, and it fired `input`
    // without `change` on a contenteditable where `fill` fired `change`
    // without `input` — two event streams for one operation.
    case 'clear':
    case 'fill': {
      const value = action === 'clear' ? '' : String(args.value ?? '')
      if (element instanceof HTMLSelectElement) {
        throw new Error(`${action}() does not work on a <select>; use selectOption()`)
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.readOnly) throw new Error('that field is read-only')
        element.focus({ preventScroll: true })
        setValue(element, '')
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
        setValue(element, value)
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, ...described, value: element.value.slice(0, 200) }
      }
      if ((element as HTMLElement).isContentEditable) {
        const editable = element as HTMLElement
        editable.focus({ preventScroll: true })
        editable.textContent = ''
        insertText(editable, value)
        editable.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, ...described, value: (editable.innerText ?? '').slice(0, 200) }
      }
      throw new Error(`${described.tag} is not a field that accepts text; `
        + `${action}() needs an input, a textarea or a contenteditable`)
    }
    case 'type':
    case 'pressSequentially': {
      const text = String(args.text ?? '')
      const delay = typeof args.delay === 'number' ? args.delay : 0
      if (element instanceof HTMLElement) element.focus({ preventScroll: true })
      for (const character of [...text]) {
        dispatchKey(element, character)
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      }
      return {
        ok: true,
        ...described,
        ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? { value: element.value.slice(0, 200) }
          : {}),
      }
    }
    case 'press': {
      const combination = String(args.key ?? '')
      const parts = combination.split('+')
      const key = parts.pop() ?? ''
      if (element instanceof HTMLElement) element.focus({ preventScroll: true })
      const prevented = dispatchKey(element, key === 'Space' ? ' ' : key, parts)
      // Enter in a field submits the form it is in, which is what a person
      // pressing it expects and what no synthetic keydown does on its own.
      if (!prevented && (key === 'Enter') && element instanceof HTMLInputElement && element.form !== null) {
        element.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
      return { ok: true, ...described, ...(prevented ? { prevented } : {}) }
    }
    case 'check':
    case 'uncheck':
    case 'setChecked': {
      const wanted = action === 'check' ? true : action === 'uncheck' ? false : args.checked === true
      if (isChecked(element) !== wanted) dispatchClick(element)
      // Polled, not read on the next line. A native `<input type=checkbox>`
      // flips synchronously, but a `<div role="checkbox">` whose handler awaits
      // a save before setting `aria-checked` does not — and reading once meant
      // a click that had landed was reported as one the page cancelled, which
      // invites a retry that toggles it back.
      let after = isChecked(element)
      const deadline = Date.now() + (typeof args.timeout === 'number' ? args.timeout : DEFAULT_ACTION_TIMEOUT_MS)
      while (after !== wanted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        after = isChecked(element)
      }
      if (after !== wanted) {
        // The page took the click and did not change the state, which for a
        // checkbox means a handler cancelled it. Setting the property directly
        // would report a success the application does not agree with.
        throw new Error(`${describeChain(chain)} is still ${after ? 'checked' : 'unchecked'} after the click; `
          + 'the page cancelled it')
      }
      return { ok: true, ...described, value: String(after) }
    }
    case 'selectOption': {
      if (!(element instanceof HTMLSelectElement)) throw new Error('selectOption() needs a <select>')
      const wanted = (Array.isArray(args.values) ? args.values : [args.values]) as (string | { value?: string, label?: string, index?: number })[]
      // Every option is resolved before anything is selected. Clearing first
      // and then throwing on the third of four names left the `<select>` with
      // nothing chosen — a page changed by a call that reported failure.
      const picked: HTMLOptionElement[] = []
      for (const entry of wanted) {
        if (entry === undefined || entry === null) continue
        const option = typeof entry === 'string'
          ? [...element.options].find((candidate) => candidate.value === entry || candidate.label === entry || candidate.text.trim() === entry)
          : entry.index !== undefined
            ? element.options[entry.index]
            : [...element.options].find((candidate) => (entry.value !== undefined && candidate.value === entry.value)
              || (entry.label !== undefined && (candidate.label === entry.label || candidate.text.trim() === entry.label)))
        if (option === undefined) {
          throw new Error(`no option ${JSON.stringify(entry)}; the <select> offers `
            + [...element.options].map((candidate) => candidate.value).join(', '))
        }
        picked.push(option)
      }
      const chosen: string[] = []
      for (const option of element.options) option.selected = false
      for (const option of picked) {
        option.selected = true
        chosen.push(option.value)
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      // The values as an array, not joined: `<option value="Smith, John">` is
      // an ordinary option, and a caller splitting a joined string on `', '`
      // turned one selection into two.
      return { ok: true, ...described, values: chosen, value: chosen.join(', ') }
    }
    case 'focus': {
      if (element instanceof HTMLElement) element.focus({ preventScroll: true })
      return { ok: true, ...described }
    }
    case 'blur': {
      if (element instanceof HTMLElement) element.blur()
      return { ok: true, ...described }
    }
    case 'scrollIntoView': {
      element.scrollIntoView({ block: 'center', inline: 'center' })
      return { ok: true, ...described }
    }
    case 'selectText': {
      const selection = element.ownerDocument.getSelection()
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select()
      else if (selection !== null) {
        const range = element.ownerDocument.createRange()
        range.selectNodeContents(element)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      return { ok: true, ...described }
    }
    case 'setInputFiles': {
      const files = (args.files ?? []) as WireFile[]
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
        throw new Error('setInputFiles() needs an <input type="file">')
      }
      setFiles(element, files)
      return { ok: true, ...described, value: files.map((file) => file.name).join(', ') }
    }
    case 'dragTo': {
      const target = await waitForActionable((args.target ?? []) as LocatorStep[], wait)
      const from = centreOf(element)
      const to = centreOf(target)
      const transfer = new DataTransfer()
      const make = (type: string, at: Point, cancelable = true): DragEvent => new DragEvent(type, {
        bubbles: true, cancelable, composed: true, clientX: at.x, clientY: at.y, dataTransfer: transfer,
      })
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, clientX: from.x, clientY: from.y, isPrimary: true, pointerType: 'mouse' }))
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: from.x, clientY: from.y }))
      element.dispatchEvent(make('dragstart', from))
      target.dispatchEvent(make('dragenter', to))
      target.dispatchEvent(make('dragover', to))
      target.dispatchEvent(make('drop', to))
      element.dispatchEvent(make('dragend', to, false))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: to.x, clientY: to.y }))
      return { ok: true, ...described }
    }
    default:
      throw new Error(`unknown action ${action}`)
  }
}

// ---------------------------------------------------------------------------
// asking
// ---------------------------------------------------------------------------

/**
 * The state queries that answer for a missing element rather than throwing: a
 * page where the error banner is gone should report `isVisible() === false`,
 * which is what a check written against it expects.
 */
const ANSWERED_WHEN_MISSING = new Set(['isVisible', 'isHidden'])

/**
 * Read something from the element or elements a chain names.
 *
 * The queries that return one value resolve strictly; the ones that are about
 * the whole set do not. That split is Playwright's, and it is the difference
 * between `innerText()` (which element did you mean?) and `allTextContents()`
 * (all of them, obviously).
 * @param chain - the locator.
 * @param query - which question.
 * @param args - its arguments.
 * @returns the answer.
 */
export function performQuery(chain: LocatorStep[], query: string, args: Record<string, unknown> = {}): unknown {
  switch (query) {
    case 'count': return locateAll(chain).length
    case 'allTextContents': return locateAll(chain).map((element) => element.textContent ?? '')
    case 'allInnerTexts': return locateAll(chain).map((element) => (element as HTMLElement).innerText ?? '')
    case 'describeAll': return locateAll(chain).slice(0, 50).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: ariaRole(element),
      name: accessibleName(element).slice(0, 120),
      visible: isVisible(element),
    }))
    default: break
  }

  const found = locateAll(chain)
  if (found.length === 0 && ANSWERED_WHEN_MISSING.has(query)) return query === 'isHidden'
  const element = strictlyOne(found, chain)

  switch (query) {
    case 'textContent': return element.textContent
    case 'innerText': return (element as HTMLElement).innerText ?? element.textContent ?? ''
    case 'innerHTML': return element.innerHTML
    case 'outerHTML': return element.outerHTML
    case 'inputValue': {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement) return element.value
      if ((element as HTMLElement).isContentEditable) return (element as HTMLElement).innerText
      throw new Error(`${element.tagName.toLowerCase()} has no value; inputValue() needs an input, textarea or select`)
    }
    case 'getAttribute': return element.getAttribute(String(args.name ?? ''))
    case 'isVisible': return isVisible(element)
    case 'isHidden': return !isVisible(element)
    case 'isEnabled': return !isDisabled(element)
    case 'isDisabled': return isDisabled(element)
    case 'isEditable': return isEditable(element)
    case 'isChecked': return isChecked(element)
    // `activeDeep`, not `ownerDocument.activeElement`: the document only ever
    // names the outermost shadow host, so a field inside a web component that
    // had just been clicked reported `isFocused()` false and `toBeFocused()`
    // retried to its timeout — while `focusInfo` named the same element.
    case 'isFocused': return activeDeep() === element
    case 'boundingBox': {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    case 'describe': return {
      tag: element.tagName.toLowerCase(),
      role: ariaRole(element),
      // Capped like every other name that reaches the model: an `aria-label`
      // is whatever the page wrote in it, and one element's name should not be
      // able to be the whole of a tool result.
      name: accessibleName(element).slice(0, 120),
      visible: isVisible(element),
      enabled: !isDisabled(element),
    }
    case 'selectedOptions': {
      if (!(element instanceof HTMLSelectElement)) throw new Error('that element is not a <select>')
      return [...element.selectedOptions].map((option) => option.value)
    }
    default:
      throw new Error(`unknown query ${query}`)
  }
}

/** The states a locator can be waited for. */
export type LocatorState = 'attached' | 'detached' | 'visible' | 'hidden'

/**
 * Wait for a locator to reach a state.
 * @param chain - the locator.
 * @param state - what to wait for.
 * @param timeoutMs - how long to wait.
 * @returns how long the wait took.
 */
export async function waitForState(chain: LocatorStep[], state: LocatorState, timeoutMs: number): Promise<{ waitedMs: number }> {
  const started = Date.now()
  const deadline = started + bounded(timeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 0, 600_000)
  for (;;) {
    const found = locateAll(chain)
    const first = found[0]
    const satisfied = state === 'attached'
      ? found.length > 0
      : state === 'detached'
        ? found.length === 0
        : state === 'visible'
          ? first !== undefined && isVisible(first)
          : first === undefined || !isVisible(first)
    if (satisfied) return { waitedMs: Date.now() - started }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${describeChain(chain)} to be ${state}`
        + `; it currently matches ${String(found.length)} element(s)`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Poll a page-realm predicate until it returns something truthy.
 * @param source - the function's source text.
 * @param argument - what to pass it.
 * @param timeoutMs - how long to wait.
 * @param pollMs - how often to try.
 * @returns whatever the predicate returned.
 */
export async function waitForFunction(
  source: string,
  argument: unknown,
  timeoutMs: number,
  pollMs = 100,
): Promise<unknown> {
  const deadline = Date.now() + bounded(timeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 0, 600_000)
  // A function is called; anything else is an expression, and an expression is
  // re-evaluated on every poll — which is the whole point of one, and is what
  // the API this imitates does. Calling the *result* meant
  // `waitForFunction('window.__ready === true')` threw "predicate is not a
  // function" on the first pass instead of waiting for anything.
  const compiled: unknown = (0, eval)(`(${source})`)
  // Compiled once, called each poll. Re-*evaluating* the expression is the
  // point of a wait; re-*parsing* it is not, and `(0, eval)` on every pass of a
  // 30s wait is three hundred fresh scripts the engine cannot reuse.
  const predicate = typeof compiled === 'function'
    ? compiled as (value: unknown) => unknown
    : new Function(`return (${source})`) as () => unknown
  for (;;) {
    const value: unknown = await predicate(argument)
    // Truthiness, not a list of the falsy values somebody remembered: `NaN`
    // is what `Number(cell)` gives for a total that has not arrived, and it
    // passed every one of those comparisons — so the wait returned at once
    // and the body read a page that had not updated.
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for the predicate to pass`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// ---------------------------------------------------------------------------
// the ARIA snapshot
// ---------------------------------------------------------------------------

/**
 * How far into the DOM the tree walk goes, whatever the reported depth says.
 *
 * The `depth` option counts levels of the *answer*, and a folded-away wrapper
 * does not add one — so on a document that is a thousand nested `<div>`s the
 * option bounds nothing, and the recursion is bounded by the stack. This is
 * the other bound: past it the branch is pruned and the answer says it was.
 */
const MAX_TREE_HOPS = 200

/** Roles that carry no information on their own and are folded away. */
const TRANSPARENT_ROLES = new Set(['generic', 'presentation', 'none', 'paragraph', 'document'])

/** State attributes worth reporting beside a node. */
function stateOf(element: Element): string[] {
  const flags: string[] = []
  const level = headingLevel(element)
  if (level !== undefined && ariaRole(element) === 'heading') flags.push(`level=${String(level)}`)
  for (const [attribute, label] of [['aria-checked', 'checked'], ['aria-pressed', 'pressed'],
    ['aria-expanded', 'expanded'], ['aria-selected', 'selected'], ['aria-current', 'current']] as const) {
    const value = element.getAttribute(attribute)
    if (value === 'true') flags.push(label)
    else if (value !== null && value !== 'false') flags.push(`${label}=${value}`)
  }
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') && element.checked) {
    flags.push('checked')
  }
  if (isDisabled(element)) flags.push('disabled')
  if (activeDeep() === element) flags.push('active')
  return flags
}

/** What one ARIA snapshot returns. */
export interface AriaSnapshot {
  text: string
  refs: number
  truncated: boolean
}

/**
 * The page as an accessibility tree, with a handle on every node.
 *
 * The format is the one every browser-driving model has seen — one indented
 * line per node, `role "name" [state] [ref=e12]` — because a model that
 * recognises the shape spends its tokens on the page rather than on the
 * notation. The refs are the point: they go back through
 * `page.locator('aria-ref=e12')`, and they are re-minted on every snapshot
 * because a ref that survived a re-render would name an element the page has
 * already replaced.
 * @param options - depth, size cap, whether to include boxes, and whether to
 * keep nodes a screen reader would skip.
 * @returns the tree as text.
 */
export function ariaSnapshot(options: {
  depth?: number
  maxChars?: number
  boxes?: boolean
  root?: Element
  refs?: boolean
  interestingOnly?: boolean
} = {}): AriaSnapshot {
  const maxDepth = bounded(options.depth, 20, 1, 30)
  const maxChars = bounded(options.maxChars, 20_000, 256, 200_000)
  const wantRefs = options.refs !== false
  if (wantRefs && options.root === undefined) resetAriaRefs()
  const lines: string[] = []
  /** Whether anything was left out, for whichever reason. */
  let truncated = false
  /** Whether the *budget* ran out, which is the only reason to stop walking. */
  let stopped = false
  let used = 0

  // `isAriaHidden` climbs to the root of the tree, and this walk returns at the
  // first hidden element it meets — so below the snapshot's own root, an
  // element's own two attributes are the whole question. The climb is done
  // once, for the root, rather than once per element at O(depth) each.
  const hiddenHere = (element: Element): boolean =>
    element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')

  const walk = (element: Element, depth: number, hops: number): void => {
    if (stopped) return
    // Too deep prunes this branch and nothing else. Sharing the flag with the
    // budget below meant the first over-deep node abandoned every sibling
    // after it — so a page with one deep menu reported almost nothing.
    if (depth > maxDepth) { truncated = true; return }
    // `depth` counts what is *reported*, and a folded-away wrapper is not — so
    // a chain of plain `<div>`s advances `hops` and not `depth`, and without
    // this bound the walk of a deeply nested layout was limited by the JS
    // stack rather than by anything the caller asked for.
    if (hops > MAX_TREE_HOPS) { truncated = true; return }
    if (hiddenHere(element)) return
    if (!isRendered(element) && options.interestingOnly !== false) {
      // Invisible subtrees are skipped rather than reported: a menu that is not
      // open is not on the page, and a model told about it will try to click it.
      // `isRendered` rather than `isVisible`, because this prunes a subtree and
      // a flat container is not an empty one — see {@link isRendered}.
      return
    }
    const role = ariaRole(element)
    const labelled = element.getAttribute('aria-label') ?? element.getAttribute('aria-labelledby')
    // A container is not a thing on the page; its contents are. So a `generic`
    // with children is folded away entirely, and one with only text becomes
    // the text — which is what a reader of the tree is actually looking for.
    const plain = TRANSPARENT_ROLES.has(role) && (labelled === null || labelled === '')
    const children = [...element.children]
    const name = plain ? (children.length === 0 ? textOf(element) : '') : accessibleName(element)
    const transparent = plain && (children.length > 0 || name === '')
    if (!transparent) {
      const state = stateOf(element)
      if (element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio'
        && element.value !== '') state.push(`value=${JSON.stringify(element.value.slice(0, 60))}`)
      if (element instanceof HTMLTextAreaElement && element.value !== '') {
        state.push(`value=${JSON.stringify(element.value.slice(0, 60))}`)
      }
      if (element instanceof HTMLAnchorElement && element.getAttribute('href') !== null) {
        state.push(`href=${JSON.stringify((element.getAttribute('href') ?? '').slice(0, 100))}`)
      }
      if (options.boxes === true) {
        const rect = element.getBoundingClientRect()
        state.push(`box=${String(Math.round(rect.x))},${String(Math.round(rect.y))},`
          + `${String(Math.round(rect.width))},${String(Math.round(rect.height))}`)
      }
      let ref = ''
      if (wantRefs) {
        ref = noteAriaRef(element)
        state.push(`ref=${ref}`)
      }
      const label = plain ? 'text' : role
      const line = `${'  '.repeat(Math.max(0, depth))}- ${label}${name === '' ? '' : ` ${JSON.stringify(name.slice(0, 120))}`}`
        + (state.length === 0 ? '' : ` [${state.join('] [')}]`)
      used += line.length + 1
      if (used > maxChars) { truncated = true; stopped = true; return }
      lines.push(line)
    }
    const shadow = (element as HTMLElement).shadowRoot
    if (shadow !== null && shadow !== undefined) {
      for (const child of shadow.children) walk(child, transparent ? depth : depth + 1, hops + 1)
    }
    for (const child of children) walk(child, transparent ? depth : depth + 1, hops + 1)
  }

  const root = options.root ?? document.body
  if (root !== null && root !== undefined && !isAriaHidden(root)) walk(root, 0, 0)
  return { text: lines.join('\n'), refs: ariaRefs.size, truncated }
}

/** Counter behind the refs an ARIA snapshot hands out. */
let refCounter = 0

// ---------------------------------------------------------------------------
// observation
// ---------------------------------------------------------------------------

/** What is focused, followed through frames and open shadow roots. */
export interface FocusInfo {
  tag: string
  role: string
  name: string
  type?: string
  editable: boolean
  visible: boolean
  rect?: { x: number, y: number, width: number, height: number }
  valueLength?: number
  selectionStart?: number | null
  selectionEnd?: number | null
  selectedText?: string
  /** Set when focus is inside a nested frame, naming the frame to ask next. */
  inFrame?: string
  path: string
}

/**
 * A CSS-ish path to an element, for saying *which* one without a ref.
 * @param element - the element.
 * @returns the path.
 */
function pathTo(element: Element): string {
  const parts: string[] = []
  for (let node: Element | null = element; node !== null && parts.length < 8; node = node.parentElement) {
    const tag = node.tagName.toLowerCase()
    const id = node.id === '' ? '' : `#${node.id}`
    parts.unshift(`${tag}${id}`)
    if (id !== '') break
  }
  return parts.join(' > ')
}

/**
 * What has focus right now.
 *
 * Following into shadow roots is not a nicety: a page whose editor is a web
 * component reports `document.activeElement` as the component, and a model
 * about to type needs to know it is really the textbox three roots down. When
 * focus is in an iframe this says so and names it, because this document
 * cannot see inside one.
 * @returns the focused element, which is not always `document.activeElement`.
 */
export function activeDeep(): Element {
  let element: Element = document.activeElement ?? document.body
  for (;;) {
    const shadow = (element as HTMLElement).shadowRoot
    const inner = shadow?.activeElement
    if (inner === null || inner === undefined) break
    element = inner
  }
  return element
}

/**
 * What is focused, followed through open shadow roots.
 * @returns the focused element's identity and selection.
 */
export function focusInfo(): FocusInfo {
  const element = activeDeep()
  const info: FocusInfo = {
    tag: element.tagName.toLowerCase(),
    role: ariaRole(element),
    name: accessibleName(element).slice(0, 120),
    editable: isEditable(element),
    visible: isVisible(element),
    path: pathTo(element),
  }
  const rect = element.getBoundingClientRect()
  info.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    info.type = element instanceof HTMLInputElement ? element.type : 'textarea'
    info.valueLength = element.value.length
    try {
      info.selectionStart = element.selectionStart
      info.selectionEnd = element.selectionEnd
    } catch { /* an input type with no selection */ }
  }
  if (element instanceof HTMLIFrameElement) {
    info.inFrame = element.getAttribute('data-wb-frame') ?? 'unknown'
  }
  const selection = document.getSelection()
  if (selection !== null && selection.toString() !== '') info.selectedText = selection.toString().slice(0, 200)
  return info
}

/** One nested frame, as this document can see it. */
export interface FrameDescriptor {
  token: string
  index: number
  name: string
  src: string
  hostBox: { x: number, y: number, width: number, height: number }
  viewportIntersection: number
  visible: boolean
  actionable: boolean
  occludedBy?: string
}

/**
 * Every nested frame in this document, with the state of its host element.
 *
 * The host element's state is the part that matters and the part a naive
 * implementation drops: a form inside a frame that is scrolled out of view, or
 * behind a modal, cannot be typed into no matter how healthy the frame's own
 * document looks. So each descriptor carries the same actionability verdict an
 * element would get, and a caller that acts anyway is doing so knowingly.
 * @returns the frames.
 */
export function frameDescriptors(): FrameDescriptor[] {
  const frames: FrameDescriptor[] = []
  const elements = [...document.querySelectorAll('iframe,frame')]
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (element === undefined) continue
    const rect = element.getBoundingClientRect()
    const state = checkActionability(element)
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
    const area = rect.width * rect.height
    frames.push({
      token: element.getAttribute('data-wb-frame') ?? '',
      index,
      name: element.getAttribute('name') ?? element.getAttribute('title') ?? '',
      src: element.getAttribute('data-wb-src') ?? element.getAttribute('src') ?? '',
      hostBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewportIntersection: area === 0 ? 0 : Math.round((visibleWidth * visibleHeight / area) * 100) / 100,
      visible: state.visible,
      actionable: state.visible && state.receivesEvents && state.enabled,
      ...(state.occludedBy === undefined ? {} : { occludedBy: state.occludedBy }),
    })
  }
  return frames
}

/** What a hit test found at a point. */
export interface HitTest {
  x: number
  y: number
  tag: string
  role: string
  name: string
  path: string
  matches?: boolean
  inFrame?: string
}

/**
 * Ask what a click at a point would actually reach.
 * @param at - a viewport point, or a locator to test the centre of.
 * @returns what is there.
 */
export function hitTest(at: { x?: number, y?: number, chain?: LocatorStep[] }): HitTest {
  let x = at.x ?? 0
  let y = at.y ?? 0
  let wanted: Element | undefined
  if (at.chain !== undefined) {
    wanted = locateOne(at.chain)
    const point = centreOf(wanted)
    x = point.x
    y = point.y
  }
  const element = topmostAt(document, x, y)
  if (element === null) throw new Error(`nothing is at (${String(Math.round(x))}, ${String(Math.round(y))}) in this viewport`)
  return {
    x: Math.round(x),
    y: Math.round(y),
    tag: element.tagName.toLowerCase(),
    role: ariaRole(element),
    name: accessibleName(element).slice(0, 120),
    path: pathTo(element),
    // `reaches`, not `Node.contains`: the latter stops at a shadow boundary, so
    // a web component whose button lives in its own shadow root reported
    // `matches: false` for a point `checkActionability` calls actionable — two
    // helpers contradicting each other about the same element.
    ...(wanted === undefined ? {} : { matches: reaches(wanted, element) || reaches(element, wanted) }),
    ...(element instanceof HTMLIFrameElement ? { inFrame: element.getAttribute('data-wb-frame') ?? 'unknown' } : {}),
  }
}

/** What a paste did, without ever echoing what was pasted. */
export interface PasteResult {
  trusted: false
  strategy: 'clipboard-event' | 'editable-fallback' | 'value-setter'
  characters: number
  bytes: number
  focusBefore: string
  focusAfter: string
  accepted: boolean
}

/** Escape one cell for the HTML flavour of a paste. */
function escapeCell(text: string): string {
  return text.replace(/[&<>"]/g, (character) => (
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&quot;'
  ))
}

/**
 * Put text into the focused control the way a paste does.
 *
 * Typing character by character is wrong for anything long: a rich editor
 * re-renders on every keystroke, a table cell moves focus on Tab, and a
 * hundred keystrokes is a hundred chances to land somewhere else. A paste is
 * one event, and the editors that matter listen for it.
 *
 * The OS clipboard is never touched — read or written — because this machine
 * is a guest in someone's browser and their clipboard is theirs. The event
 * carries `isTrusted: false`, which a site is entitled to reject, so the
 * result says what strategy was used and the caller is expected to verify what
 * the application actually shows.
 * @param text - what to paste.
 * @param options - the format, and whether an editable target is required.
 * @returns what happened.
 */
export function pasteText(text: string, options: { format?: 'text' | 'tsv', requireEditableFocus?: boolean } = {}): PasteResult {
  const before = focusInfo()
  // The same descent `focusInfo` makes, or a field inside a web component is
  // pasted into the component that hosts it — which handles nothing, and then
  // `requireEditableFocus` refuses a field that was just clicked.
  const target = activeDeep()
  if (target === document.body) {
    throw new Error('nothing is focused; click the field first, then paste')
  }
  if (options.requireEditableFocus === true && !isEditable(target)) {
    throw new Error(`focus is on <${target.tagName.toLowerCase()}>, which is not editable; click the field first`)
  }
  const transfer = new DataTransfer()
  transfer.setData('text/plain', text)
  if (options.format === 'tsv') {
    // Escaped, because this is markup and the text is not: a cell holding
    // `a<b` closed nothing and swallowed the rest of the row, and one holding
    // `</td></tr></table><img src=x onerror=…>` put whatever it liked into the
    // editor that reads the HTML flavour.
    transfer.setData('text/html', `<table><tr>${text.split('\n')
      .map((row) => `<td>${row.split('\t').map(escapeCell).join('</td><td>')}</td>`).join('</tr><tr>')}</tr></table>`)
  }
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer })
  const delivered = target.dispatchEvent(event)
  let strategy: PasteResult['strategy'] = 'clipboard-event'
  let accepted = !delivered

  if (delivered) {
    // Nobody handled it, so the default is ours to perform: the same insertion
    // a browser would do at the caret.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length
      const end = target.selectionEnd ?? target.value.length
      const next = target.value.slice(0, start) + text + target.value.slice(end)
      setValue(target, next)
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertFromPaste' }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
      strategy = 'value-setter'
      accepted = target.value.includes(text.slice(0, 32))
    } else if ((target as HTMLElement).isContentEditable) {
      insertText(target, text)
      strategy = 'editable-fallback'
      accepted = ((target as HTMLElement).innerText ?? '').includes(text.slice(0, 32))
    }
  }
  return {
    trusted: false,
    strategy,
    characters: [...text].length,
    bytes: new TextEncoder().encode(text).length,
    focusBefore: `${before.tag}${before.name === '' ? '' : ` ${JSON.stringify(before.name)}`}`,
    focusAfter: (() => {
      const after = focusInfo()
      return `${after.tag}${after.name === '' ? '' : ` ${JSON.stringify(after.name)}`}`
    })(),
    accepted,
  }
}

/**
 * Send a pointer event at a coordinate, for surfaces that have no elements.
 *
 * Canvas, maps, whiteboards: the DOM says `<canvas>` and nothing else, and the
 * only way in is where a person would put the pointer. The element under the
 * point is reported back so a caller can tell that the click landed on the
 * canvas and not on the toolbar that overlaps it.
 * @param action - which pointer event sequence.
 * @param args - the point, button and modifiers.
 * @returns what was under the point.
 */
export function mouseAction(action: string, args: Record<string, unknown>): HitTest & { action: string } {
  const x = Number(args.x ?? 0)
  const y = Number(args.y ?? 0)
  const element = topmostAt(document, x, y)
  if (element === null) throw new Error(`nothing is at (${String(x)}, ${String(y)}) in this viewport`)
  const flags = modifierFlags(args.modifiers as string[] | undefined)
  const button = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0
  const shared = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    button, view: window, ...flags,
  }
  const pointer = { ...shared, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  switch (action) {
    case 'move':
      element.dispatchEvent(new PointerEvent('pointermove', pointer))
      element.dispatchEvent(new MouseEvent('mousemove', shared))
      break
    case 'down':
      element.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }))
      element.dispatchEvent(new MouseEvent('mousedown', { ...shared, buttons: 1 }))
      if (element instanceof HTMLElement) element.focus({ preventScroll: true })
      break
    case 'up':
      element.dispatchEvent(new PointerEvent('pointerup', pointer))
      element.dispatchEvent(new MouseEvent('mouseup', shared))
      break
    case 'click':
    case 'dblclick':
      dispatchClick(element, {
        button,
        clickCount: action === 'dblclick' ? 2 : Number(args.clickCount ?? 1),
        ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers as string[] } : {}),
        position: (() => {
          const rect = element.getBoundingClientRect()
          return { x: x - rect.x, y: y - rect.y }
        })(),
      })
      break
    case 'wheel': {
      const wheel = new WheelEvent('wheel', {
        ...shared, deltaX: Number(args.deltaX ?? 0), deltaY: Number(args.deltaY ?? 0),
      })
      // The document scrolls only where the page did not do the scrolling
      // itself. A map or a canvas that calls `preventDefault()` on `wheel` was
      // being zoomed *and* scrolled out from under the coordinates the body had
      // just measured. `dispatchClick` and `dispatchKey` read the same answer.
      if (element.dispatchEvent(wheel)) window.scrollBy(wheel.deltaX, wheel.deltaY)
      break
    }
    default:
      throw new Error(`unknown mouse action ${action}`)
  }
  return {
    action,
    x: Math.round(x),
    y: Math.round(y),
    tag: element.tagName.toLowerCase(),
    role: ariaRole(element),
    name: accessibleName(element).slice(0, 120),
    path: pathTo(element),
    ...(element instanceof HTMLIFrameElement ? { inFrame: element.getAttribute('data-wb-frame') ?? 'unknown' } : {}),
  }
}

/**
 * Send keystrokes to whatever has focus.
 * @param action - press, down, up, type or insertText.
 * @param args - the key or text, and any delay.
 * @returns where the keys went.
 */
export async function keyboardAction(action: string, args: Record<string, unknown>): Promise<{ focus: string, action: string }> {
  // Through open shadow roots, the way `focusInfo` reports it: a keystroke
  // dispatched at the component hosting the field never reaches the field, and
  // the result named the field anyway.
  const target = activeDeep()
  switch (action) {
    case 'press': {
      const parts = String(args.key ?? '').split('+')
      const key = parts.pop() ?? ''
      dispatchKey(target, key === 'Space' ? ' ' : key, parts)
      break
    }
    case 'down':
    case 'up': {
      const key = String(args.key ?? '')
      target.dispatchEvent(new KeyboardEvent(action === 'down' ? 'keydown' : 'keyup', {
        // `keyCodeFor`, which is what `press` and `browser_key` both use: the
        // bare table answers `code: 'a'` where every other path answers
        // `'KeyA'`, so a page switching on `event.code` saw the press and not
        // the hold, and a down/press/up sequence silently did nothing.
        key, code: keyCodeFor(key), bubbles: true, cancelable: true, composed: true,
      }))
      break
    }
    case 'insertText':
      insertText(target, String(args.text ?? ''))
      break
    case 'type': {
      const text = String(args.text ?? '')
      const delay = Number(args.delay ?? 0)
      for (const character of [...text]) {
        dispatchKey(activeDeep(), character)
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      }
      break
    }
    default:
      throw new Error(`unknown keyboard action ${action}`)
  }
  const after = focusInfo()
  return { action, focus: `${after.tag}${after.name === '' ? '' : ` ${JSON.stringify(after.name)}`}` }
}

/** Everything one `observe` call reports about this document. */
export interface Observation {
  url: string
  title: string
  readyState: string
  viewport: { width: number, height: number }
  scroll: { x: number, y: number }
  size: { width: number, height: number }
  snapshot: string
  truncated: boolean
  focus?: FocusInfo
  frames?: FrameDescriptor[]
  dialogs?: { kind: string, message: string }[]
}

/**
 * One bounded look at the page.
 *
 * Bounded is the whole point. The natural thing for a model to do when it does
 * not know what is on a page is to ask for everything, and everything is a
 * megabyte of markup or a screenshot that costs twenty times what the answer
 * needed. This returns a capped ARIA tree, the frames and their host state,
 * and what has focus — which between them answer almost every question that
 * would otherwise be asked with a screenshot.
 * @param options - what to include and how much.
 * @returns the observation.
 */
export function observe(options: {
  depth?: number
  maxChars?: number
  focus?: boolean
  frames?: 'none' | 'visible' | 'all'
  boxes?: boolean
} = {}): Observation {
  const snapshot = ariaSnapshot({
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    maxChars: bounded(options.maxChars, 6000, 256, 20_000),
    ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
  })
  const observation: Observation = {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    snapshot: snapshot.text,
    truncated: snapshot.truncated,
  }
  if (options.focus !== false) observation.focus = focusInfo()
  if (options.frames !== 'none') {
    const all = frameDescriptors()
    observation.frames = options.frames === 'all' ? all : all.filter((frame) => frame.visible)
  }
  return observation
}
