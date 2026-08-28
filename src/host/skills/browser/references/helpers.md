# The `tabbit` helpers

Additive helpers in the task realm, on the frozen `tabbit` global. They add
bounded observation and safer interaction; they replace no part of the
locator API.

## `tabbit.observe(options)`

One capped look at the page: the accessibility tree, every nested frame with
the state of the element that holds it, and what has focus.

```js
return await tabbit.observe({frames: 'visible', focus: true, depth: 16, maxChars: 6000,
  frameMaxChars: 2000, maxFrames: 8});
```

`frames` is `'none'`, `'visible'` or `'all'`; `depth` is 1–30, `maxChars`
256–20000, `frameMaxChars` 256–6000, `maxFrames` 1–32. Frame entries carry
`hostBox`, `viewportIntersection`, `visible`, `actionable` and `occludedBy`.

This is observation only. A frame whose *host* is not actionable is not
something to act in, however healthy its own tree looks. The same view is
available outside a task as `browser_inspect`.

## `tabbit.focusInfo()`

What has keyboard focus, followed through open shadow roots and into frames:
role, name, type, whether it is editable, its rectangle, and the selection.
Call it before typing or pasting anything that matters.

## `tabbit.hitTest(target)`

`tabbit.hitTest(locator)` reports the element the browser would actually
deliver a click at that locator's centre to, and whether it is the one you
meant. `tabbit.hitTest({x, y})` asks the same about a viewport point. Call it
before coordinate work, and treat a mismatch as a reason to look again rather
than to click harder.

## `tabbit.actionability(locator)` and `tabbit.safeClick(locator)`

`actionability()` reports attached, visible, stable, enabled, whether the
element receives events, and what is on top of it if something is.
`safeClick()` runs that check and refuses to click when the answer is no —
which turns "the click resolved and nothing happened" into an error naming the
cookie banner that swallowed it.

## `tabbit.pasteText(text, options)`

A synthetic paste at the caret. Use it for anything long, multi-line or
tabular, and for editors that are not a plain input — a hundred keystrokes into
a re-rendering editor is a hundred chances for focus to move.

```js
const field = page.getByRole('textbox', {name: 'Data'});
await field.click();
const paste = await tabbit.pasteText('Ada\t36\tEngineering', {format: 'tsv', requireEditableFocus: true});
await expect(field).not.toHaveValue('');
return {paste, value: await field.inputValue()};
```

Options are `format: 'text' | 'tsv'` and `requireEditableFocus`. The user's own
clipboard is never read or written. The event is synthetic — it reports
`trusted: false` — so a site may refuse it: always check what the application
shows afterwards. The same is available outside a task as `browser_paste`.

## `tabbit.triggerAndWait(event, trigger, options)`

Arms the waiter, then runs the trigger. Events: `popup`, `page`, `download`,
`dialog`, `navigation`, `url` (with `options.url`).

```js
const popup = await tabbit.triggerAndWait('popup',
  () => page.getByRole('link', {name: 'Open'}).click(), {timeoutMs: 10000});
return {popupUrl: popup.url()};
```

## `tabbit.triggerAndObserve(trigger, options)`

For a click whose outcome is not known — which on a real page is most clicks.
Everything is armed first; the strongest observed outcome comes back.

```js
const result = await tabbit.triggerAndObserve(() => tabbit.safeClick(target),
  {timeoutMs: 3000, activatePage: true});
return {kind: result.kind, url: page.url()};
```

`kind` is `page`, `navigation`, `dialog`, `download`, `dom` or `none`. Options
are `timeoutMs`, `settleMs` and `activatePage` — with `activatePage: true`, a
page that opened becomes the task's active `page`.
