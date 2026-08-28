---
name: browser
description: Drive this session's browser machine with programs rather than one action at a time — persistent task spaces, Playwright-shaped locators and assertions, frames, popups, dialogs, downloads, uploads, extraction and recovery. Use for any browsing job with a loop, a wait, or more than about three steps in it.
---

# Driving the browser machine

This session's machine is a browser: real tabs, real pages, rendered by the
engine this page runs in. There is nothing to install and no daemon to start —
the machine is already here, and a task space exists the moment you name one.

Two ways to drive it, and the second is the one this skill is about:

- **One action at a time** — `browser_navigate`, `browser_snapshot`,
  `browser_click`, `browser_type`, `browser_screenshot`. Right for a page you
  open, read, and are done with.
- **A program** — `browser_task`. Right for everything else: a loop over a
  table, a form with a wait in the middle, a flow that spans several pages. One
  call does what twenty of the others would.

## Task spaces

Every `browser_task` call names a task space. The first call creates it; later
calls with the same name reuse its pages, its variables, its cookies and its
login state. Use one short stable name for a whole job and its follow-ups —
name it after the job, not the website, and keep every page of that job in it
even when the flow crosses sites.

```
browser_task {task: "check the changelog", code: "
  await page.goto('https://example.com/changelog', {waitUntil: 'domcontentloaded'});
  return {title: await page.title(), heading: await page.getByRole('heading').first().innerText()};
"}
```

The code is an **async function body**. Use top-level `await` and `return`; do
not wrap it in a function. It runs in a sandbox of its own — not in the page and
not in the harness — so `document` and `window` belong to the site and are
reached through `page.evaluate()`. Anything you put on `globalThis` survives to
the next call in the same task:

```js
globalThis.rows = await page.getByRole('row').allInnerTexts();
return {count: rows.length};
```

The first page a task opens becomes the visible tab, and later ones open
behind it. That matters when you mix the two styles of driving:
`browser_screenshot` and `browser_snapshot` act on the *active* tab, so once a
task has opened a second page, name the tab or take the picture inside the task
with `page.screenshot()` — which always photographs the page the task is on.

Finish a task when the job is done:

```
browser_tasks {action: "finish", task: "check the changelog"}
```

Finishing closes the pages the task opened, and never closes a tab you were
given with `claimTab`. Default to closing: search results, sources and
intermediate pages have served their purpose. Keep pages only when they are a
deliverable for the user or the starting point of the next step.

## What is in scope

| Name | What it is |
| --- | --- |
| `page` | the current page — follows `usePage()` |
| `context` | the task's pages, its events, and `context.request` for fetching |
| `browser` | the machine |
| `pages()`, `usePage(p)` | the task's pages, and which one `page` means |
| `expect` | retrying assertions |
| `assert` | `node:assert/strict` |
| `tabbit` | observation and safer interaction: see `references/helpers.md` |
| `artifactPath(name)` | a path in this task's own folder |
| `viewport` | the size every tab is |

## Choose the workflow

- **Semantic** — the default. Locators, assertions, and the accessibility tree.
  Right for ordinary pages: forms, lists, tables, links.
- **Visual** — for canvas, maps, whiteboards and rich editors whose DOM does not
  describe what is on screen. Screenshot, then `page.mouse` and `page.keyboard`
  at coordinates, then verify visually or through an export. Before typing
  anything substantial, make a small write probe and check it landed where you
  meant; stop if it reached a title bar, a search box or a hidden input.
- **Page evaluation** — one `page.evaluate()` for a DOM-only computation that
  would otherwise be many round trips. Do not split one computation across
  several calls, and do not return a whole DOM.

Combine them freely. After any meaningful action, observe fresh state before
choosing the next one.

## Locators

A locator is a description, not a handle: it is resolved again on every use, so
a page that re-rendered does not invalidate it. Prefer, in order:

1. `page.getByRole('button', {name: 'Save'})` — what the control *is*.
2. `page.getByLabel('Email')`, `getByPlaceholder`, `getByText`, `getByTestId`.
3. `page.locator('css')` — when the markup is known and stable.
4. `page.locator('aria-ref=e12')` — a handle from the most recent
   `browser_inspect` or `page.ariaSnapshot()`. Fresh snapshot, fresh refs.

Narrow with `.filter({hasText})`, `.nth(i)`, `.first()`, and chaining
(`table.getByRole('row').filter({hasText: 'Ada'}).getByRole('cell')`). An action
on a locator that matches several elements fails immediately and says which
ones — that is not a wait, it is a question about which one you meant.

Actions wait on their own for the target to be attached, visible, stable,
enabled and actually able to receive the click. **Never sleep.** Wait for a
locator, a URL, an event or a load state instead.

## The five rules

1. **Return small, JSON-safe values.** Never return a `page`, a `locator`, or a
   DOM node. Return what you read from them.
2. **`page.evaluate(fn, argument)` captures nothing.** The function is
   serialised into the site's own realm; everything it needs goes through
   `argument`.
3. **Install a waiter before the action that triggers it.**
   `const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])`.
   An event that already fired is gone.
4. **A resolved `click()` is not proof.** Verify with the URL, a visible
   element, a count, application data, or an artifact.
5. **Bound every loop** — by iterations, by results, and by a stop signal — and
   stop when an iteration adds nothing.

## Verifying

```js
await page.getByRole('button', {name: /sign in/i}).click();
await expect(page.getByRole('heading', {name: /dashboard/i})).toBeVisible();
return {url: page.url(), signedIn: true};
```

`expect` retries for five seconds by default; `assert` does not retry and is for
facts that are already true.

## Receipts, and what to do when a call is interrupted

Give an important mutation a stable `requestId`:

```
browser_task {task: "orders", requestId: "submit-order-03", code: "…"}
```

Calling again with the same id and the same code returns the first result
instead of doing it twice. If a call comes back **STILL RUNNING**, the body is
still going in its task space — do not run it again:

```
browser_tasks {action: "receipt", task: "orders", request: "submit-order-03"}
```

If a run failed *after* acting, its result says `mutation: possible`. Check
before repeating anything: `browser_tasks {action: "checkpoint", task}` for the
live state, then a `readOnly: true` run that inspects the application itself.
Repeat the action only once you can see it did not happen.
`references/recovery.md` has the whole procedure.

## What differs from a desktop browser, and why

Read these before planning around them. Each is a property of a page that is
running inside another page, not a decision that could have gone the other way.

- **You cannot log in to anything.** Cookies work *inside* a page and persist
  between visits, but no cookie travels on a network request and no `set-cookie`
  comes back — the browser forbids a page to set one and CORS does not expose
  the other. Anything behind a login is out of reach. Say so rather than
  spending turns on it.
- **Modal dialogs are answered before they are raised.** A page's `confirm()` is
  synchronous and nothing here can pause one, so the answer comes from a policy
  armed in advance: dismissed by default. `page.on('dialog', d => d.accept())`
  arms accept, and `page.setDialogPolicy({action: 'accept'})` is the explicit
  form. Every dialog is recorded either way.
- **Each frame is its own document with its own runtime.** `frameLocator()`
  works, and so does `browser_inspect`, which is the only view that shows what
  is inside a frame.
- **No WebSockets, no IndexedDB, no Cache API.** Sites fall back to
  `localStorage`, which does work.
- **Screenshots are the browser's own rendering** and are accurate for text and
  layout. They cannot draw a nested frame, a plugin or video.

## References

- `references/recipes.md` — popups, dialogs, frames, downloads, uploads,
  navigation, evidence, and the API mistakes worth not making.
- `references/extraction.md` — lists, tables, pagination, infinite scroll,
  deduplication, and keeping output small.
- `references/helpers.md` — the `tabbit` global: `observe`, `focusInfo`,
  `hitTest`, `actionability`, `safeClick`, `pasteText`, `triggerAndWait`,
  `triggerAndObserve`.
- `references/recovery.md` — receipts, interrupted mutations, generations, and
  large results.
