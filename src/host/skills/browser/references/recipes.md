# Recipes

Each block is an async function body: use it directly in `browser_task`'s
`code`, without an async wrapper.

## Contents

- Navigate and inspect
- Fill and submit a form
- Handle a popup, or a possible popup
- Handle JavaScript dialogs
- Work with iframes
- Download and upload files
- Canvas, maps and rich editors
- Repeat actions safely
- Capture evidence
- API mistakes worth not making

## Navigate and inspect

Wait for content that establishes readiness, never for a duration.

```js
await page.goto('https://example.com', {waitUntil: 'domcontentloaded'});
const heading = page.getByRole('heading').first();
await heading.waitFor({state: 'visible', timeout: 15000});
return {url: page.url(), title: await page.title(), heading: (await heading.innerText()).trim()};
```

For a broad look at an unfamiliar page, take a bounded tree rather than a
screenshot:

```js
return (await page.ariaSnapshot({depth: 20, boxes: true})).slice(0, 6000);
```

Every node in it carries `ref=e12`, which goes straight back in as
`page.locator('aria-ref=e12')`. A fresh snapshot replaces the whole ref set, so
take a new one after a navigation or a substantial render.

When a search, filter or detail URL can be derived from what you already know,
open it directly instead of typing the same thing into the site's own search
box. URL-encode everything the user supplied. If the parameter format is a
guess, use the visible navigation instead — do not loop trying URL variants.

## Fill and submit a form

Prefer labels and roles, and verify the application's state rather than the
click.

```js
await page.getByLabel('Email').fill('user@example.com');
await page.getByLabel('Password').fill('correct horse battery staple');

await Promise.all([
  page.waitForURL(/dashboard/, {timeout: 15000}),
  page.getByRole('button', {name: /sign in/i}).click(),
]);

await expect(page.getByRole('heading', {name: /dashboard/i})).toBeVisible();
return {url: page.url(), signedIn: true};
```

If submitting does not necessarily navigate, drop `waitForURL` and wait for the
success message or the changed element instead.

## Handle a popup, or a possible popup

Install the waiter first, always:

```js
const original = page;
const [popup] = await Promise.all([
  context.waitForEvent('page', {timeout: 15000}),
  page.getByRole('link', {name: /details/i}).click(),
]);
await popup.waitForLoadState('domcontentloaded');
usePage(popup);

const evidence = {title: await page.title(), url: page.url()};
await page.close();
usePage(original);
return evidence;
```

Closing the page a task is working on moves the task to another of its pages
by itself, so `usePage(original)` above is belt and braces rather than a
requirement.

When a popup is only one possible outcome, bound the waiter and inspect both:

```js
const before = page.url();
const popupPromise = context.waitForEvent('page', {timeout: 8000}).catch(() => null);
await page.getByRole('link', {name: /open report/i}).click();
const popup = await popupPromise;

if (popup) {
  await popup.waitForLoadState('domcontentloaded');
  const evidence = {kind: 'popup', title: await popup.title(), url: popup.url()};
  await popup.close();
  return evidence;
}
return {kind: page.url() === before ? 'in-page' : 'same-tab', url: page.url()};
```

`tabbit.triggerAndObserve()` does the same thing in one call when you do not
want to write the branches yourself.

## Handle JavaScript dialogs

The answer is decided *before* the dialog exists — a page's `confirm()` is
synchronous and cannot be paused here. Arm it, then act:

```js
let asked = null;
page.on('dialog', async (dialog) => { asked = dialog.message(); await dialog.accept(); });
await page.getByRole('button', {name: /delete/i}).click();
await expect(page.getByText(/deleted/i)).toBeVisible();
return {accepted: true, asked};
```

Registering the handler is what arms the policy, and the handler's own
`accept()`/`dismiss()` is read to decide which. When the choice depends on the
message, arm it explicitly instead:

```js
await page.setDialogPolicy({action: 'accept', promptText: 'yes'});
```

Dialogs are recorded whether or not anyone is listening: `browser_inspect` and
`browser_console` both show them, with the answer the page was given.

## Work with iframes

Each frame is a separate document in its own origin. Use `frameLocator()`
rather than trying to query into one:

```js
const payment = page.frameLocator('iframe[title="Payment"]');
await payment.getByLabel('Card number').fill('4242 4242 4242 4242');
await payment.getByRole('button', {name: /pay/i}).click();
await expect(payment.getByText(/payment complete/i)).toBeVisible();
return {paid: true};
```

`browser_inspect` is the view that shows what is inside each frame, along with
whether the frame's own host element is visible and clickable — a form in a
frame that is scrolled out of view or behind a modal cannot be typed into no
matter how healthy the frame looks.

## Download and upload files

A link with a `download` attribute raises a download rather than navigating.
Install the waiter before the click, and save into the task's own folder:

```js
const [download] = await Promise.all([
  page.waitForEvent('download', {timeout: 15000}),
  page.getByRole('button', {name: /export/i}).click(),
]);
const output = artifactPath('export.csv');
await download.saveAs(output);
return {artifact: output, suggestedFilename: download.suggestedFilename()};
```

For a file behind a plain link — a PDF, say — fetch it through the context's
request client and check what came back before keeping it:

```js
const link = page.getByRole('link', {name: /view pdf/i});
const url = new URL(await link.getAttribute('href'), page.url()).href;
const response = await context.request.get(url);
assert.ok(response.ok(), `PDF request failed: ${response.status()}`);
const body = await response.body();
assert.equal(new TextDecoder().decode(body.subarray(0, 5)), '%PDF-');
const output = artifactPath('paper.pdf');
await saveFile(output, body);
return {artifact: output, bytes: body.length};
```

`saveFile(path, contents)` takes bytes, a string or an object — an object is
written as JSON — and is how anything a task produced becomes a file the user
can open.

Uploads go the other way, from your workspace into the page:

```js
await page.getByLabel('Upload document').setInputFiles('/home/dsh/workspace/report.pdf');
await expect(page.getByText(/upload complete/i)).toBeVisible();
return {uploaded: true};
```

For a button that opens a picker rather than a visible file input:

```js
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.getByRole('button', {name: /choose file/i}).click(),
]);
await chooser.setFiles('/home/dsh/workspace/report.pdf');
return {uploaded: true};
```

## Canvas, maps and rich editors

Their DOM describes a toolbar and a hidden input, not what is on screen. Look
at the accessibility tree first — it often has the real controls — and only
then use coordinates:

```js
const before = await page.ariaSnapshot({depth: 20, boxes: true});
await tabbit.hitTest({x: 640, y: 400});
await page.mouse.click(640, 400);
await page.keyboard.type('hello');
return {before: before.slice(0, 2000), after: (await page.ariaSnapshot({depth: 20})).slice(0, 2000)};
```

Before typing anything long, use `tabbit.focusInfo()` to check where the
keystrokes would land, and prefer `tabbit.pasteText()` over typing for anything
multi-line or tabular.

## Repeat actions safely

Re-resolve locators each iteration; frameworks replace nodes.

```js
const clicked = [];
for (let index = 0; index < 5; index += 1) {
  const items = page.getByRole('list', {name: /news/i}).getByRole('link');
  assert.ok(await items.count() > index, `missing news item ${index + 1}`);
  const item = items.nth(index);
  const title = (await item.innerText()).trim();
  await item.click();
  await page.waitForLoadState('domcontentloaded');
  clicked.push({title, landed: page.url()});
  await page.goBack();
}
return {count: clicked.length, clicked};
```

If the list can reorder, locate by the captured title rather than by index.

## Capture evidence

```js
const shot = await page.screenshot({path: artifactPath('final-state.png'), fullPage: true});
return {shot, title: await page.title(), url: page.url()};
```

Pictures a task takes are written to files and the last of them come back with
the result, so a screenshot is evidence you can point at rather than something
only the code saw. Take them when the visual state is the question — not as the
ordinary way to find a control.

## API mistakes worth not making

| Wrong | Right |
| --- | --- |
| `browser.pages()` | `context.pages()` or `pages()` |
| `document.querySelector(...)` in the body | `page.evaluate(() => document.querySelector(...))` |
| `expect(locator).toHaveValue(...)` | `await expect(locator).toHaveValue(...)` |
| `page.waitForTimeout(3000)` after an action | wait for a locator, URL, event or load state |
| click, then `waitForEvent('page')` | install the waiter first, with `Promise.all` |
| returning a `Locator` or a `Page` | return what you read from it |
| `page.goto(href)` when asked to click | `locator.click()`, then verify |
| a new task per step | one task space for the whole job |
