/**
 * Real-workload test for the browser machine.
 *
 * The point of a browser in a harness is not that a page renders. It is that a
 * model can *use* one — find the field, fill it in, submit it, read what came
 * back — and that the page it is using cannot reach anything outside its own
 * tab. Both halves are checked here, and the second one is the more important:
 * a browser machine that works and leaks is worse than no browser machine.
 *
 * Everything is driven through the same bridge `src/host/browser-tools.ts`
 * calls, for the reason `scripts/v86-e2e.ts` gives about the emulated machine:
 * a suite that exercised a parallel implementation would prove nothing about
 * what the model actually reaches.
 *
 * ## Why the site is local
 *
 * The web is not a fixture. A suite pointed at a real site fails when that
 * site is redesigned, when it is down, and when whoever runs the suite is
 * behind a network that does not like it — and none of those failures is about
 * this build. So the pages here are served by this script, and they are chosen
 * to exercise the parts that are hard rather than the parts that are common:
 * a stylesheet and an image that have to be inlined to survive the trip, a
 * script that reads `location` (which cannot be shimmed and so is rewritten),
 * storage and cookies that have to persist across a navigation, and a page
 * that tries to climb out of its frame and reports what stopped it.
 *
 * The fixture sends `access-control-allow-origin: *`, which is what lets the
 * page fetch it without a CORS proxy. That is deliberately the easy case: what
 * is under test is the machine, not this deployment's proxy setting.
 *
 * Usage: `npx tsx scripts/browser-e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { createServer, type Server } from 'node:http'
import { chromium, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
const headed = args.includes('--headed')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the scenario with a message that says what was expected. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** A one-pixel PNG, for the image that has to survive being inlined. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** The pages the fixture serves, by path. */
const PAGES: Record<string, { type: string, body: string | Buffer }> = {
  '/': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Fixture home</title>
<link rel="stylesheet" href="/style.css">
<script src="/app.js"></script>
</head><body>
<h1 id="heading">Fixture home</h1>
<p class="lede">A page that exists to be driven.</p>
<img src="/pixel.png" alt="a pixel" width="16" height="16">
<a href="/about">About this fixture</a>
<form action="/echo" method="get">
  <label for="q">Search</label>
  <input id="q" name="q" type="text" placeholder="Type here">
  <button type="submit">Search</button>
</form>
<button id="add" type="button">Add a paragraph</button>
<div id="added"></div>
</body></html>`,
  },
  '/about': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>About</title></head><body>
<h1>About this fixture</h1><p>The about page reached by a link.</p>
<a href="/">Home</a></body></html>`,
  },
  '/style.css': {
    type: 'text/css',
    // A background image, so the stylesheet's own `url()` has to be rewritten
    // too — a stylesheet inlined without that loses every image on the page.
    body: `body{font:16px system-ui;color:#123456}
.lede{color:#654321;background:url("/pixel.png") repeat-x}
#heading{font-size:28px}`,
  },
  '/app.js': {
    type: 'text/javascript',
    body: `document.addEventListener('DOMContentLoaded', function () {
  var button = document.getElementById('add')
  if (button) button.addEventListener('click', function () {
    document.getElementById('added').textContent = 'added by script'
  })
})`,
  },
  '/pixel.png': { type: 'image/png', body: PIXEL },
  '/state': {
    type: 'text/html; charset=utf-8',
    // Storage and cookies, written on first visit and read on every later one.
    // The value is what proves persistence: a jar that forgot would show the
    // page's own default instead.
    body: `<!doctype html><html><head><title>State</title></head><body>
<h1>State</h1>
<pre id="out">reading…</pre>
<script>
  var held = localStorage.getItem('fixture-key')
  if (held === null) { held = 'first-visit'; localStorage.setItem('fixture-key', held) }
  if (!/fixture-cookie/.test(document.cookie)) document.cookie = 'fixture-cookie=baked; path=/'
  document.getElementById('out').textContent =
    'stored=' + held + ' cookie=' + document.cookie
</script>
</body></html>`,
  },
  '/where': {
    type: 'text/html; charset=utf-8',
    // `location` is the one global that cannot be replaced from inside the
    // frame, so it is rewritten in the script text instead. This page reads it
    // every way a real site does.
    body: `<!doctype html><html><head><title>Where</title></head><body>
<pre id="out"></pre>
<script>
  document.getElementById('out').textContent = [
    'href=' + location.href,
    'pathname=' + location.pathname,
    'search=' + window.location.search,
    'host=' + document.location.host,
    'framed=' + (top !== self)
  ].join('\\n')
</script>
</body></html>`,
  },
  '/escape': {
    type: 'text/html; charset=utf-8',
    // The isolation, asked for from inside, and asked for in the spellings the
    // rewrite does not touch.
    //
    // That distinction is the whole point of this page. A bare `parent`, `top`
    // or `location` is rewritten to read a virtual one, so a page that used
    // those would be reporting on the rewrite rather than on the sandbox — and
    // would report success while proving nothing. `window.parent` and
    // `window.top` are left exactly as the site wrote them, which is what a
    // page trying to climb out would use, and every one of them has to be
    // refused by the browser itself.
    body: `<!doctype html><html><head><title>Escape</title></head><body>
<pre id="out"></pre>
<script>
  var lines = []
  function attempt(name, fn) {
    try { lines.push(name + '=' + String(fn())) }
    catch (error) { lines.push(name + '=blocked:' + error.name) }
  }
  attempt('origin', function () { return window.origin })
  attempt('parentDocument', function () { return window.parent.document.title })
  attempt('topLocation', function () { return window.top.location.href })
  attempt('parentStorage', function () { return window.parent.localStorage.length })
  attempt('parentBridge', function () { return String(window.parent.__DSH_WEB_MACHINE__) })
  attempt('indexedDB', function () { return typeof window.indexedDB })
  document.getElementById('out').textContent = lines.join('\\n')
</script>
</body></html>`,
  },
}

/**
 * Serve the fixture site for the length of the run.
 * @returns its base URL and a function that stops it.
 */
async function fixture(): Promise<{ base: string, stop: () => Promise<void> }> {
  let served = 0
  const server: Server = createServer((request, response) => {
    const [path, query] = (request.url ?? '/').split('?')
    served++
    // `/echo` reflects its query rather than serving a fixed page, so a
    // submitted form has somewhere to land that proves the value travelled.
    // Handled here rather than in a second listener: two listeners both wrote
    // to the same response and Node refused the second set of headers.
    if (path === '/echo') {
      const value = new URLSearchParams(query ?? '').get('q') ?? ''
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
      response.end('<!doctype html><html><head><title>Echo</title></head><body>'
        + `<h1>Echo</h1><p id="value">you searched for ${value}</p></body></html>`)
      return
    }
    const page = PAGES[path ?? '/']
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
      response.end('no such fixture page')
      return
    }
    response.writeHead(200, {
      'content-type': page.type,
      // What lets the page read it at all. Most of the web does not send this,
      // which is why the machine has a CORS proxy behind it — but the proxy is
      // not what this suite is testing.
      'access-control-allow-origin': '*',
    })
    response.end(page.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      process.stdout.write(`  fixture served ${String(served)} requests\n`)
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** One tab, as the bridge reports it. */
interface Tab {
  id: string
  url: string
  title: string
  active: boolean
  canGoBack: boolean
  error?: string
}

/** The browser machine's half of the machine bridge, as it exists in the page. */
interface BrowserBridge {
  tabs(): Tab[]
  newTab(url?: string): Promise<string>
  close(id: string): void
  select(id: string): void
  navigate(url: string, id?: string): Promise<Tab>
  go(delta: number, id?: string): Promise<unknown>
  run(kind: string, payload?: Record<string, unknown>, id?: string): Promise<unknown>
  logs(id?: string): { console: { level: string, text: string }[], requests: { url: string, status: number }[] }
  profile(): { cookies: { name: string, value: string }[], origins: string[] }
  clear(): Promise<void>
  open(): Promise<void>
}

/**
 * The bridge, as the page spells it.
 *
 * Installed by the init script below rather than imported, because every use of
 * it is inside a `page.evaluate` callback — code that is serialised and run in
 * the browser, where this script's imports do not exist. Declared here so the
 * compiler checks those callbacks against the real shape.
 */
declare function bridge(): BrowserBridge

/**
 * Reach the browser machine from inside the page.
 *
 * One function per bridge call rather than a general "run this closure there"
 * helper, which was the first shape and does not work: a closure written here
 * captures this script's variables, and the page it is sent to has none of
 * them. Passing the arguments explicitly is both correct and easier to read at
 * the call site.
 */
const drive = {
  /** Go to a URL in a tab. */
  navigate: async (page: Page, target: string, id?: string): Promise<Tab> => page.evaluate(
    async ([url_, tab]) => bridge().navigate(url_ as string, tab as string | undefined),
    [target, id] as const,
  ) as Promise<Tab>,

  /** Run one driver command inside a tab's frame. */
  run: async <T>(page: Page, kind: string, payload: Record<string, unknown> = {}, id?: string): Promise<T> =>
    page.evaluate(
      async ([kind_, payload_, tab]) => bridge().run(kind_ as string, payload_ as Record<string, unknown>, tab as string | undefined),
      [kind, payload, id] as const,
    ) as Promise<T>,

  /** Every open tab. */
  tabs: async (page: Page): Promise<Tab[]> => page.evaluate(() => bridge().tabs()) as Promise<Tab[]>,

  /** Open a tab, and report its id. */
  newTab: async (page: Page, target?: string): Promise<string> => page.evaluate(
    async (url_) => bridge().newTab(url_ as string | undefined),
    target,
  ) as Promise<string>,

  /** Close one. */
  close: async (page: Page, id: string): Promise<void> => page.evaluate((held) => { bridge().close(held) }, id),

  /** Back or forward. */
  go: async (page: Page, delta: number, id?: string): Promise<void> => {
    await page.evaluate(async ([step, tab]) => {
      await bridge().go(step as number, tab as string | undefined)
    }, [delta, id] as const)
  },

  /** The cookie jar and the origins that have stored something. */
  profile: async (page: Page): Promise<{ cookies: { name: string, value: string }[], origins: string[] }> =>
    page.evaluate(() => bridge().profile()) as Promise<{ cookies: { name: string, value: string }[], origins: string[] }>,

  /** Empty it. */
  clear: async (page: Page): Promise<void> => { await page.evaluate(async () => { await bridge().clear() }) },

  /** What a tab has logged. */
  logs: async (page: Page): Promise<{ console: { level: string, text: string }[], requests: { url: string, status: number }[] }> =>
    page.evaluate(() => bridge().logs()) as Promise<{
      console: { level: string, text: string }[]
      requests: { url: string, status: number }[]
    }>,
}

/** Wait for the app's own shell to finish booting. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 120_000 })
}

/**
 * Drive one turn with a dummy key and read the tools off the request it sent.
 *
 * The provider rejects the key, but the request is built and sent first, and
 * that request is the only thing that cannot be wrong about what the model was
 * offered. The same trick `scripts/v86-e2e.ts` uses, for the same reason: a
 * registry answers about the unscoped subset, and the machine's tools are
 * agent-scoped.
 * @param page - the loaded app.
 * @returns the offered tool names, sorted.
 */
async function offeredTools(page: Page): Promise<string[]> {
  await page.evaluate(() => { (globalThis as { __SENT__?: string[] }).__SENT__ = [] })
  await page.evaluate(async () => {
    await Promise.race([
      globalThis.dsh.promptOnce('sk-not-a-real-key', 'What is on this page?').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 25_000)),
    ])
  }).catch(() => undefined)
  await page.waitForTimeout(3000)
  const bodies = await page.evaluate(() => (globalThis as { __SENT__?: string[] }).__SENT__ ?? [])
  for (const body of bodies) {
    try {
      const parsed = JSON.parse(body) as { tools?: { function?: { name?: string } }[] }
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        return parsed.tools.map((tool) => tool.function?.name ?? '?').sort()
      }
    } catch {
      // Not a model request; the next body may be.
    }
  }
  return []
}

/** Dismiss the surface's first-run notice, which masks every click under it. */
async function dismissNotice(page: Page): Promise<void> {
  const acknowledge = page.getByRole('button', { name: /Continue/ })
  await acknowledge.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
  if (await acknowledge.count() > 0) {
    await acknowledge.first().click().catch(() => undefined)
    await acknowledge.first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  }
}

/** Open the Machine panel through the plugin's own sidebar action. */
async function openMachinePanel(page: Page): Promise<void> {
  await dismissNotice(page)
  const action = page.getByRole('button', { name: 'Machine panel', exact: true })
  await action.first().waitFor({ state: 'visible', timeout: 30_000 })
  await action.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForSelector('.dsh-web-machine[data-open]', { timeout: 20_000 })
}

/** Load the app on the browser machine and wait for its shell. */
async function open(page: Page): Promise<void> {
  await page.goto(`${url}?runtime=browser`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitForShell(page)
}

/** One scenario. */
interface Scenario {
  name: string
  run(page: Page, site: string): Promise<void>
}

const scenarios: Scenario[] = [
  {
    // The tool set is the whole reason the machine is a separate machine. A
    // browser session that still carried `jsh` would be one where the model
    // spends its first turn running `ls` on a machine that has no filesystem.
    name: 'tools',
    async run(page) {
      await page.goto(`${url}?runtime=browser`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      const offered = await offeredTools(page)
      expect(offered.length > 0, 'no request carried a tool list')
      for (const wanted of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
        'browser_screenshot', 'browser_eval', 'browser_console', 'browser_tabs']) {
        expect(offered.includes(wanted), `the browser machine does not offer ${wanted}; it offers ${offered.join(', ')}`)
      }
      for (const absent of ['jsh', 'sh', 'dos', 'bash', 'vm_screenshot', 'vm_key']) {
        expect(!offered.includes(absent),
          `the browser machine offers ${absent}, which does not exist on it — it offers ${offered.join(', ')}`)
      }
      process.stdout.write(`  ${String(offered.length)} tools offered\n`)
    },
  },

  {
    // A page: fetched, rewritten, rendered, and then read three ways.
    name: 'read',
    async run(page, site) {
      await open(page)
      const tab = await drive.navigate(page, `${site}/`)
      expect(tab.error === undefined, `the fixture would not load: ${String(tab.error)}`)
      expect(tab.title === 'Fixture home', `the tab is titled ${JSON.stringify(tab.title)}`)

      const text = await drive.run<{ text: string }>(page, 'text')
      expect(text.text.includes('Fixture home'), `the page text is ${JSON.stringify(text.text.slice(0, 200))}`)
      expect(text.text.includes('A page that exists to be driven'), 'the page body did not survive the rewrite')

      const snap = await drive.run<{ tree: unknown }>(page, 'snapshot')
      expect(snap.tree !== null, 'the snapshot found nothing on the page')
      const flat = JSON.stringify(snap.tree)
      expect(flat.includes('"link"') && flat.includes('About this fixture'), `the snapshot lists no link: ${flat.slice(0, 300)}`)
      expect(flat.includes('"textbox"'), `the snapshot lists no text field: ${flat.slice(0, 300)}`)
      expect(flat.includes('"button"'), `the snapshot lists no button: ${flat.slice(0, 300)}`)

      // The stylesheet had to be fetched, rewritten and inlined for this to be
      // anything but the browser's default size.
      const sized = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'getComputedStyle(document.getElementById("heading")).fontSize',
      })
      expect(String(sized.value) === '28px', `the stylesheet did not apply: the heading is ${String(sized.value)}`)

      // And the image had to be inlined as a `data:` URL rather than left
      // pointing at a host the frame has no way to reach.
      const image = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'document.images[0].src.slice(0, 10) + "|" + document.images[0].complete',
      })
      expect(String(image.value).startsWith('data:image'), `the image was not inlined: ${String(image.value)}`)
      expect(String(image.value).endsWith('true'), `the inlined image did not load: ${String(image.value)}`)
    },
  },

  {
    // Clicking a link, typing into a form, submitting it, and landing on the
    // page that proves the value travelled.
    name: 'interact',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)

      // The script that arrived with the page has to have run for this to do
      // anything at all.
      await drive.run(page, 'click', { selector: '#add' })
      const added = await drive.run<{ text: string }>(page, 'text', { selector: '#added' })
      expect(added.text.includes('added by script'), `the page's own script did not run: ${JSON.stringify(added.text)}`)

      await drive.run(page, 'type', { selector: '#q', text: 'hello-fixture' })
      const typed = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'document.getElementById("q").value',
      })
      expect(String(typed.value) === 'hello-fixture', `the field holds ${String(typed.value)}`)

      await drive.run(page, 'click', { selector: 'button[type=submit]' })
      await page.waitForTimeout(3000)
      const echoed = await drive.run<{ text: string }>(page, 'text')
      expect(echoed.text.includes('hello-fixture'),
        `the form did not submit its value; the page reads ${JSON.stringify(echoed.text.slice(0, 200))}`)

      // A link, and then the back button, which is the tab's own history.
      await drive.navigate(page, `${site}/`)
      await drive.run(page, 'click', { selector: 'a[href$="/about"]' })
      await page.waitForTimeout(3000)
      const about = await drive.run<{ text: string }>(page, 'text')
      expect(about.text.includes('About this fixture'),
        `the link did not navigate: ${JSON.stringify(about.text.slice(0, 120))}`)

      await drive.go(page, -1)
      await page.waitForTimeout(2500)
      const back = await drive.run<{ text: string }>(page, 'text')
      expect(back.text.includes('A page that exists to be driven'),
        `going back landed on ${JSON.stringify(back.text.slice(0, 120))}`)
    },
  },

  {
    // `location` is the one thing a shim cannot replace, so it is rewritten in
    // the script text instead. If that rewrite is wrong, every site that routes
    // on its own URL is wrong with it — and the symptom is a page that renders
    // and then behaves as though it were somewhere else entirely.
    name: 'location',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/where?x=1`)
      const shown = await drive.run<{ text: string }>(page, 'text')
      expect(shown.text.includes(`href=${site}/where?x=1`),
        `the page reads its own URL as ${JSON.stringify(shown.text)}`)
      expect(shown.text.includes('pathname=/where'), `pathname is wrong: ${JSON.stringify(shown.text)}`)
      expect(shown.text.includes('search=?x=1'), `search is wrong: ${JSON.stringify(shown.text)}`)
      expect(shown.text.includes('framed=false'),
        `the page can tell it is framed, which is what starts a frame-buster: ${JSON.stringify(shown.text)}`)
    },
  },

  {
    // Storage and cookies, which have to be the machine's own and have to
    // survive navigating away and back.
    name: 'profile',
    async run(page, site) {
      await open(page)
      await drive.clear(page)

      await drive.navigate(page, `${site}/state`)
      const first = await drive.run<{ text: string }>(page, 'text', { selector: '#out' })
      expect(first.text.includes('stored=first-visit'), `the first visit reads ${JSON.stringify(first.text)}`)
      expect(first.text.includes('fixture-cookie=baked'),
        `the cookie was not readable back: ${JSON.stringify(first.text)}`)

      // Away, and back. A jar that only lived in the frame would be empty now,
      // because the frame is a new document each time.
      await drive.navigate(page, `${site}/about`)
      await drive.navigate(page, `${site}/state`)
      const second = await drive.run<{ text: string }>(page, 'text', { selector: '#out' })
      expect(second.text.includes('stored=first-visit'),
        `storage did not survive the navigation: ${JSON.stringify(second.text)}`)
      expect(second.text.includes('fixture-cookie=baked'),
        `the cookie did not survive the navigation: ${JSON.stringify(second.text)}`)

      const profile = await drive.profile(page)
      expect(profile.cookies.some((cookie) => cookie.name === 'fixture-cookie'),
        `the jar holds ${JSON.stringify(profile.cookies)}`)
      expect(profile.origins.some((origin) => origin.includes('127.0.0.1')),
        `no origin stored anything: ${JSON.stringify(profile.origins)}`)

      await drive.clear(page)
      const cleared = await drive.profile(page)
      expect(cleared.cookies.length === 0, 'clearing the profile left cookies behind')
    },
  },

  {
    // The one that matters most. Every line this page prints is a way out of
    // the frame, and every one of them has to be refused by the browser rather
    // than by anything this build wrote.
    name: 'isolation',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/escape`)
      const shown = await drive.run<{ text: string }>(page, 'text', { selector: '#out' })
      const line = (name: string): string =>
        shown.text.split('\n').find((entry) => entry.startsWith(`${name}=`)) ?? `${name}=<missing>`

      // An opaque origin is the sandbox. Everything below follows from it, and
      // if this one line is wrong none of the rest means anything.
      expect(line('origin') === 'origin=null',
        `the frame does not have an opaque origin — it reports ${JSON.stringify(line('origin'))}`)

      for (const blocked of ['parentDocument', 'topLocation', 'parentStorage', 'parentBridge']) {
        expect(line(blocked).includes('blocked:'),
          `a browsed page could reach ${blocked}: ${JSON.stringify(line(blocked))}`)
      }

      // And the harness's storage is not merely unreachable by accident: an
      // opaque origin has no `indexedDB` at all, so there is nothing there for
      // a page to open, guess a database name in, or fill up.
      expect(line('indexedDB') === 'indexedDB=undefined',
        `indexedDB is present in the frame: ${JSON.stringify(line('indexedDB'))}`)

      process.stdout.write(`  ${JSON.stringify(shown.text.split('\n').join(' | '))}\n`)
    },
  },

  {
    // Several tabs, each with its own page and its own history, which is what
    // makes them tabs rather than one frame being reused.
    name: 'tabs',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)
      const second = await drive.newTab(page, `${site}/about`)
      const tabs = await drive.tabs(page)
      expect(tabs.length === 2, `expected two tabs, got ${String(tabs.length)}`)
      expect(tabs.some((tab) => tab.title === 'Fixture home'), `the first tab lost its page: ${JSON.stringify(tabs)}`)
      expect(tabs.some((tab) => tab.title === 'About'), `the second tab did not load: ${JSON.stringify(tabs)}`)

      // A background tab is still a live page, which is the property that makes
      // having several worth anything.
      const first = tabs.find((tab) => tab.title === 'Fixture home')
      expect(first !== undefined, 'the first tab is gone')
      const inBackground = await drive.run<{ text: string }>(page, 'text', { selector: '#heading' }, first?.id)
      expect(inBackground.text.includes('Fixture home'),
        `a background tab stopped answering: ${JSON.stringify(inBackground.text)}`)

      await drive.close(page, second)
      const remaining = await drive.tabs(page)
      expect(remaining.length === 1, `closing a tab left ${String(remaining.length)}`)
    },
  },

  {
    // The visual mode. What is checked is that a real picture of the real page
    // comes back: a blank canvas of the right size would pass a size check, so
    // the bytes are counted too.
    name: 'screenshot',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)
      const shot = await drive.run<{ dataUrl: string, width: number, height: number }>(page, 'screenshot')
      expect(shot.dataUrl.startsWith('data:image/png;base64,'),
        `the screenshot is not a PNG: ${shot.dataUrl.slice(0, 40)}`)
      expect(shot.width > 400 && shot.height > 300, `the picture is ${String(shot.width)}×${String(shot.height)}`)
      const bytes = Math.floor((shot.dataUrl.length - 22) * 3 / 4)
      expect(bytes > 1500, `the picture is ${String(bytes)} bytes, which is a blank canvas`)
      process.stdout.write(`  screenshot ${String(shot.width)}×${String(shot.height)}, ${String(bytes)} bytes\n`)
    },
  },

  {
    // What a screenshot leaves behind, on this machine's own screen tool.
    //
    // The same rule `vm_screenshot` follows and the same reason for it: a model
    // checking its own work photographs the page constantly, and every one of
    // those used to land in `screenshots/`. The picture goes to the model; the
    // file is what somebody has to ask for. Driven through the tool rather than
    // through the engine — `drive.run` writes nothing and never did, so the
    // scenario above cannot see this at all.
    name: 'screenshot-files',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)

      /** Take one as an agent on `route` would, and say what came back. */
      const shoot = async (
        args: Record<string, unknown>,
        route: { provider: string, model: string },
      ): Promise<{ path?: string, image: boolean, bytes: number }> => page.evaluate(async ([call, model]) => {
        const { ctx } = globalThis.dsh
        const proxy = ctx.get('apiProxy') as {
          sessions: {
            create(request: { rpcId: string, payload: Record<string, never> }): Promise<{
              result: { ok: boolean, value?: { sessionId: string }, error?: unknown }
            }>
          }
        }
        const created = await proxy.sessions.create({ rpcId: crypto.randomUUID(), payload: {} })
        const sessionId = created.result.value?.sessionId
        if (sessionId === undefined) throw new Error(`session.create: ${JSON.stringify(created.result.error)}`)
        const agent = (ctx.get('agents') as { get(id: string): unknown }).get(sessionId)
        if (agent === undefined) throw new Error('the session produced no agent')
        const tools = ctx.get('tools') as {
          get(name: string, scope?: unknown): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
        }
        const tool = tools.get('browser_screenshot', agent)
        if (tool === undefined) throw new Error('browser_screenshot is not registered')
        // The route is named here rather than through `selectModel`: the routed
        // model reaches the session's request header when a turn starts, and
        // there is no turn in this scenario.
        const shot = await tool.execute(call, {
          signal: new AbortController().signal,
          agent: { options: model },
        }) as { path?: string, image?: unknown, bytes: number }
        return { path: shot.path, image: shot.image !== undefined, bytes: shot.bytes }
      }, [args, route] as const)

      /** What is in the workspace's screenshot folder right now. */
      const kept = async (): Promise<string[]> => page.evaluate(async (): Promise<string[]> => {
        const files = (globalThis as unknown as {
          __DSH_WEB_FILES__: { root(): string, list(path: string): Promise<{ name: string }[]> }
        }).__DSH_WEB_FILES__
        return files.list(`${files.root()}/screenshots`).then(
          entries => entries.map(entry => entry.name),
          () => [],
        )
      })

      // `kilo-free`'s StepFun entry declares `input: [text, image]` in this
      // build's own catalog and `ovh-free`'s Qwen coder declares nothing, so
      // both branches are exercised with no key and no request off the page.
      const seeing = { provider: 'kilo-free', model: 'stepfun/step-3.7-flash:free' }
      const blind = { provider: 'ovh-free', model: 'Qwen3-Coder-30B-A3B-Instruct' }

      const plain = await shoot({}, seeing)
      expect(plain.image, 'the picture did not reach a model that accepts images')
      expect(plain.bytes > 1500, `the screenshot is ${String(plain.bytes)} bytes, which is a blank canvas`)
      expect(plain.path === undefined, `a screenshot nobody asked to keep was written to ${String(plain.path)}`)
      expect((await kept()).length === 0, `the workspace has screenshots in it: ${(await kept()).join(', ')}`)

      const named = await shoot({ path: 'shots/page.png' }, seeing)
      expect(named.image, 'a saved screenshot was not also handed to the model')
      expect(named.path?.endsWith('/shots/page.png') === true, `the file went to ${String(named.path)}`)

      // A model that cannot be shown a picture gets the file instead, because
      // otherwise the call returns nothing at all.
      const unseen = await shoot({}, blind)
      expect(!unseen.image, 'a text-only route was handed an image')
      expect(unseen.path !== undefined, 'a model that cannot see the picture was given no file either')
      expect((await kept()).length === 1, `the fallback wrote ${String((await kept()).length)} files, not one`)
      process.stdout.write(`  kept: ${(await kept()).join(', ')}\n`)
    },
  },

  {
    // The console mode, and the record of what the page said and fetched.
    name: 'console',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)

      const counted = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'document.querySelectorAll("button").length',
      })
      expect(Number(counted.value) >= 2, `the page has ${String(counted.value)} buttons`)

      const awaited = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'await new Promise(r => setTimeout(() => r("resolved"), 50))',
      })
      expect(String(awaited.value) === 'resolved', `top-level await did not work: ${String(awaited.value)}`)

      await drive.run(page, 'evaluate', { source: 'console.warn("a warning from the page"), 1' })
      const logs = await drive.logs(page)
      expect(logs.console.some((entry) => entry.text.includes('a warning from the page')),
        `the console log holds ${JSON.stringify(logs.console.slice(-3))}`)
      expect(logs.requests.some((entry) => entry.status === 200),
        `no request was recorded: ${JSON.stringify(logs.requests.slice(-3))}`)
    },
  },
  {
    // The panel, and the handover it performs. A tab is one browsing context,
    // so showing it to a person means *moving* the frame into the panel rather
    // than drawing a second one — and a frame that has been moved into a
    // detached or mis-styled element stops being laid out, which breaks
    // clicking and screenshots for the agent without breaking anything a
    // person can see. So the machine is driven while the panel holds it, and
    // again after the panel gives it back.
    name: 'panel',
    async run(page, site) {
      await open(page)
      await drive.navigate(page, `${site}/`)
      await openMachinePanel(page)

      await page.waitForSelector('.dsh-web-browser-tabs', { timeout: 20_000 })
      const strip = await page.locator('.dsh-web-browser-tab').allInnerTexts()
      expect(strip.some((entry) => entry.includes('Fixture home')),
        `the tab strip shows ${JSON.stringify(strip)}`)
      const shown = await page.locator('.dsh-web-browser-url').inputValue()
      expect(shown === `${site}/`, `the address bar shows ${JSON.stringify(shown)}`)

      // The frame really is inside the panel now, not still parked off-screen.
      const adopted = await page.evaluate(() => {
        const stage = document.querySelector('.dsh-web-browser-scaler')
        return stage !== null && stage.querySelector('iframe') !== null
      })
      expect(adopted, 'the panel is open but holds no tab')

      // And it is still drivable, at its real size, while adopted. A frame
      // that lost its layout would report a zero-height document here.
      const sized = await drive.run<{ value: unknown }>(page, 'evaluate', {
        source: 'innerWidth + "x" + (document.body.getBoundingClientRect().height > 0)',
      })
      expect(String(sized.value) === '1280xtrue',
        `an adopted tab reports its viewport as ${String(sized.value)}`)
      const still = await drive.run<{ text: string }>(page, 'text', { selector: '#heading' })
      expect(still.text.includes('Fixture home'), `driving stopped working while the panel was open: ${still.text}`)

      // Closing gives the tab back, and it keeps working.
      await page.getByRole('button', { name: 'Close', exact: true }).first()
        .evaluate((node: HTMLElement) => { node.click() })
      await page.waitForTimeout(500)
      const after = await drive.run<{ text: string }>(page, 'text', { selector: '#heading' })
      expect(after.text.includes('Fixture home'),
        `driving stopped working after the panel closed: ${after.text}`)
    },
  },
]

const site = await fixture()
const browserInstance = await chromium.launch({ headless: !headed })
let failures = 0
let ran = 0

for (const scenario of scenarios) {
  if (only !== undefined && scenario.name !== only) continue
  const context = await browserInstance.newContext()
  const page = await context.newPage()
  await page.addInitScript(`
    // Named once here so every evaluate above can spell the bridge in one
    // word; the page is where it lives, so this is where it has to be defined.
    window.bridge = function () { return window.__DSH_WEB_MACHINE__.browser }
    window.__SENT__ = []
    const original = window.fetch
    window.fetch = function (input, init) {
      try {
        const body = (init && init.body) || (input && input.body)
        if (typeof body === 'string' && body.length > 200) window.__SENT__.push(body)
      } catch (error) { /* recording must never break the request */ }
      return original.apply(this, arguments)
    }
  `)
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
  process.stdout.write(`▶ ${scenario.name}\n`)
  ran++
  const started = Date.now()
  try {
    await scenario.run(page, site.base)
    process.stdout.write(`✔ ${scenario.name} (${String(Math.round((Date.now() - started) / 1000))}s)\n`)
  } catch (error) {
    failures++
    process.stdout.write(`✘ ${scenario.name}: ${error instanceof Error ? error.message : String(error)}\n`)
    if (errors.length > 0) process.stdout.write(`    page errors:\n      ${errors.join('\n      ')}\n`)
    await page.screenshot({ path: `/tmp/dshw-browser-${scenario.name}.png` }).catch(() => undefined)
  }
  await context.close()
}

await browserInstance.close()
await site.stop()

if (failures > 0) {
  process.stdout.write(`\n${String(failures)} scenario(s) failed\n`)
  process.exit(1)
}
if (ran === 0) {
  process.stdout.write(`\nno scenario matched ${String(only)}; the suite has ${scenarios.map((s) => s.name).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write(`\nall ${String(ran)} scenarios passed\n`)
