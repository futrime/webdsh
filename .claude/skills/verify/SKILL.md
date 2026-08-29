---
name: verify
description: Build, launch and drive this app to observe a change at runtime. Use when verifying a diff that touches the browser machine, the shell/container machine, the emulated PC, or the surface — anything whose surface is the page rather than a test.
---

# Verifying webdsh at runtime

Pure-static browser app. The surface is **pixels in a page**, not a test run.
`npm run test:*` is CI's job — driving the app is this skill's.

## Build and serve

```sh
npm run build                      # assemble + vite → dist/
node scripts/serve.mjs 4173        # NOT `npm run preview` — see MEMORY.md
```

`scripts/serve.mjs` reads `dist/` per request, so a rebuild is picked up
without restarting it.

## Launch

Playwright is a devDependency. A driver script outside the repo must import it
by absolute path, and it is CJS:

```js
import pw from '/home/ubuntu/webdsh/node_modules/playwright/index.js'
const { chromium } = pw
```

Boot the app on the machine you want with a query flag, then wait for the
shell — the boot screen is a separate element that must be gone:

```js
await page.goto(`${APP}?runtime=browser`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => {
  const r = document.getElementById('root')
  return r !== null && r.childElementCount > 0 && document.getElementById('dshw-boot') === null
}, undefined, { timeout: 120_000 })
```

`?runtime=browser` selects the browser machine; omit it for the container.

## Drive the UI

A first-run notice masks every click until dismissed:

```js
const ack = page.getByRole('button', { name: /Continue/ })
if (await ack.count() > 0) await ack.first().click()
```

The sidebar's **Machine panel** button needs a raw DOM click (Playwright's
click is intercepted by the sidebar overlay):

```js
const action = page.getByRole('button', { name: 'Machine panel', exact: true })
await action.first().evaluate((n) => n.click())
await page.waitForSelector('.dsh-web-machine[data-open]')
```

The browser machine has a real address bar — drive it as a person would:

```js
const bar = page.locator('.dsh-web-machine input[placeholder="Enter a URL"]')
await bar.first().fill('http://127.0.0.1:4310/')
await bar.first().press('Enter')
```

## Drive the machine

`globalThis.__DSH_WEB_MACHINE__.browser` is the same bridge the panel and (via
`src/host/browser-tools.ts`) the model use. `browser` is an **object**, not a
function:

```js
b.tabs() / b.newTab(url) / b.navigate(url, tab)
b.run(kind, payload, tabId)                    // one driver command
b.tasks.run(name, code, { claimTab: tabId })   // a task-space program
b.tasks.observe(name, { frames: 'all' })       // what browser_inspect returns
b.tasks.resource(name, id, offset, max) / b.tasks.finish(name, keep)
```

`claimTab` attaches a task space to the tab the user is watching, which is how
you drive and *see* the same page.

## Gotchas

- **Browse a local fixture, not the web.** A page you serve yourself is the
  only way the run is repeatable. Send `access-control-allow-origin: *` or
  every request detours through the CORS proxy.
- **The model needs a key.** `DEEPSEEK_API_KEY` unset ⇒ no real turn. The
  browser tools are **agent-scoped**: they are not in `dsh.ctx.tools`, so tool
  *output-schema* validation cannot be exercised without a key. `dsh.promptOnce`
  is the wrong entry point — it takes the default agent, whose tool set is not
  the machine's.
- **Long runs get killed.** The harness stops backgrounded process groups.
  Detach: `setsid nohup bash -c '... > log 2>&1; echo done > flag' & disown`,
  then poll the flag file.
- Reading `scripts/browser-e2e.ts` as a *spec* for boot/selector details is
  fine; running it is not verification.

## Fixture ports get wedged

A killed fixture can leave its port bound with no process `pgrep` will find, and
the next `node fixture.mjs` dies with `EADDRINUSE` into a log you are not
reading — so the app browses stale content and probes fail for the wrong
reason. Symptom: a step reports `HTTP 403` or content you know you changed.
Check `curl` returns what you just edited before blaming the app, and move to a
fresh port rather than fighting the old one.

## Probes must discriminate

A probe that cannot fail proves nothing. `getByRole('table')` against a page
with one table cannot tell "scoped to the parent" from "whole document" — add
a second table and assert both counts. The same goes for `readOnly`: assert the
call was *refused* **and** that the page did not change.

## Tool output schemas are the blind spot

The browser tools are agent-scoped, so `dsh.ctx.tools` cannot reach them and
neither can a walk of the fiber tree — and `browser-e2e` drives the *bridge*,
not the tool layer. So a field added to a returned type while its
`additionalProperties: false` output schema is not updated makes **every** call
of that tool throw `ToolOutputError`, with every suite still green. This has
happened.

Check it directly: take the live value from the bridge and diff its keys
against the schema's declared properties.

```js
// in the page
const tab = globalThis.__DSH_WEB_MACHINE__.browser.tabs()[0]
Object.keys(tab)            // -> the shape the tool will return
```

then compare with the `properties` of the matching `*_OUTPUT` const in
`src/host/browser-tools.ts`. Any live key that is not declared is a broken tool.
