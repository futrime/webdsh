# Getting data out

For lists, tables, pagination, infinite scroll, or anything likely to return
more than a small answer.

## The realm boundary

The task body runs in its own realm. It owns the locators, the task's globals
and the returned value. The website runs in the page realm: it owns `document`,
`window` and the site's own JavaScript.

Use locators for ordinary semantic content. Use `page.evaluate(fn, argument)`
when a DOM-only computation is materially more compact — and pass everything it
needs through `argument`, because the function is serialised and captures
nothing:

```js
const minimum = 100;
return await page.evaluate(({minimum}) => {
  const prices = [...document.querySelectorAll('[data-price]')]
    .map((element) => Number(element.getAttribute('data-price')))
    .filter(Number.isFinite);
  return {count: prices.length, aboveMinimum: prices.filter((price) => price >= minimum).length};
}, {minimum});
```

Never return a DOM node from the page realm, or a `Page`/`Locator` from the
task realm. Return JSON-safe values.

## Do it in one call

Query, normalise, filter and map in one coherent body, and keep the returned
shape explicit and small.

```js
const maxResults = 25;
return await page.evaluate(({maxResults}) => {
  const records = [...document.querySelectorAll('article')]
    .map((article) => ({
      title: article.querySelector('h2')?.textContent?.trim() ?? '',
      url: article.querySelector('a[href]')?.href ?? '',
      summary: article.querySelector('p')?.textContent?.trim() ?? '',
    }))
    .filter((record) => record.title && record.url)
    .slice(0, maxResults);
  return {count: records.length, records};
}, {maxResults});
```

Do not fetch `innerHTML`, the whole body text, or a full accessibility tree when
the answer is a few fields or an aggregate.

## Bound it, and deduplicate

Decide `maxResults` before collecting. Deduplicate on the most stable key
available — a canonical URL, an application id, a normalised compound key — and
keep the first complete record.

```js
const maxResults = 50;
const rows = await page.getByRole('row').allInnerTexts();
const unique = [...new Map(rows.map((text) => text.trim()).filter(Boolean)
  .map((text) => [text.toLocaleLowerCase(), text])).values()].slice(0, maxResults);
return {count: unique.length, rows: unique};
```

Aggregate in the task when the answer is a count, a grouping or a comparison. A
large raw result costs the budget the reasoning needs.

## Paginate and scroll safely

Bound every loop by iteration count, by result count, and by a concrete stop
signal. Re-resolve locators after each render and stop when an iteration adds
nothing.

```js
const maxPages = 10;
const maxResults = 100;
const records = new Map();

for (let index = 0; index < maxPages; index += 1) {
  const cards = page.locator('article[data-id]');
  const count = await cards.count();
  const before = records.size;
  for (let card = 0; card < count && records.size < maxResults; card += 1) {
    const item = cards.nth(card);
    const id = await item.getAttribute('data-id');
    if (!id || records.has(id)) continue;
    records.set(id, {id, text: (await item.innerText()).trim()});
  }
  if (records.size >= maxResults || records.size === before) break;

  const next = page.getByRole('button', {name: /next/i});
  if (!await next.isVisible().catch(() => false) || await next.isDisabled()) break;
  await next.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

return {count: records.size, records: [...records.values()]};
```

For infinite scroll, compare stable ids or counts before and after each bounded
scroll. Scrolling does not imply that anything loaded.

## Verify, then return something small

Check the extraction against what was asked: the URL, the page heading, the
result count, the first and last records, or a total the application itself
gives. Report truncation explicitly.

```js
return {
  source: {url: page.url(), title: await page.title()},
  count: records.length,
  truncated: records.length === maxResults,
  records,
};
```

A result too large to return whole is kept as a resource and reported as one —
read it in slices with `browser_tasks {action: "resource"}`, and do not print
the whole thing when a summary answers the question. `saveFile(path, records)`
writes it to the workspace instead, which is usually what the user wanted
anyway.
