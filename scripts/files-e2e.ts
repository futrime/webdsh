/**
 * End-to-end check for the Files panel, the chat's file links, and the plugin
 * roster.
 *
 * The three are one suite because they are one claim: that a browser tab can be
 * the whole of a workspace. A file the agent writes has to be visible, a file
 * the user has has to get in, a file either of them produced has to get out,
 * and a path named in the conversation has to open — all against the same
 * filesystem the agent's own tools use, not a second one that resembles it.
 *
 * The panel is driven through the surface wherever a person would drive it: the
 * sidebar action, the rows, the upload input. Only the control surface the
 * plugin publishes for automation (`__DSH_FILES__`) is used to *observe*.
 *
 * Usage: `npx tsx scripts/files-e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { chromium, type Page } from 'playwright'
import { unzipSync } from 'fflate'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
const headed = args.includes('--headed')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Assert a condition, failing the check with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Wait until the app's own boot screen is gone and the shell rendered. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })
}

/** Run one command through the harness's own path, as the agent does. */
async function shell(page: Page, script: string): Promise<string> {
  const result = await page.evaluate(async (source: string) => globalThis.dsh.shell(source), script)
  return `${result.stdout}${result.stderr}`
}

/** Whether the surface's first-run notice has already been dismissed. */
let acknowledged = false

/**
 * Dismiss the surface's first-run notice, which covers everything until it is.
 *
 * Once per load, not once per check: the notice never comes back, and waiting
 * for it again was thirty seconds of every check's wall clock.
 * @param page - the loaded app.
 */
async function acknowledge(page: Page): Promise<void> {
  if (acknowledged) return
  const button = page.getByRole('button', { name: /Continue/ })
  await button.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
  if (await button.count() > 0) {
    await button.first().click().catch(() => undefined)
    await button.first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  }
  acknowledged = true
}

/**
 * One of the plugins page's tabs.
 *
 * They are tabs, not buttons: the section renders a `role="tablist"`, so a
 * button-role lookup finds nothing at all.
 * @param page - the loaded app.
 * @param name - the tab's label.
 * @returns the locator for that tab.
 */
function tab(page: Page, name: string): ReturnType<Page['getByRole']> {
  return page.getByRole('tab', { name, exact: true })
}

/** The rows the panel is currently showing, without their action glyphs. */
async function rows(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.dsh-web-files-list li'))
    .map(row => (row.textContent ?? '').replace(/[↓✕]/g, '').trim()))
}

/**
 * Put the panel back in the workspace root, and wait until it is there.
 *
 * Checks that write through the panel and then read through the agent depend on
 * the two agreeing about *where* — and a check that navigates has to hand the
 * panel back where it found it. Waiting rather than clicking and hoping is the
 * whole point: on a slower machine the click had not landed before the next
 * check uploaded into a directory the agent was not looking at, and the symptom
 * was a file that appeared in the listing and did not exist.
 * @param page - the loaded app.
 */
async function goRoot(page: Page): Promise<void> {
  const crumb = page.getByRole('button', { name: 'workspace', exact: true })
  if (await crumb.count() > 0) await crumb.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForFunction(
    () => (document.querySelector('.dsh-web-files-crumbs')?.textContent ?? '').trim().endsWith('workspace'),
    undefined,
    { timeout: 30_000 },
  )
}

/** Re-read the current directory through the panel's own button. */
async function refresh(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refresh', exact: true }).first()
    .evaluate((node: HTMLElement) => { node.click() })
}

/** Open the panel through the sidebar action, the way a person does. */
async function openPanel(page: Page): Promise<void> {
  await acknowledge(page)
  if (await page.evaluate(() => (globalThis as { __DSH_FILES__?: { isOpen(): boolean } }).__DSH_FILES__?.isOpen() === true)) {
    return
  }
  const action = page.getByRole('button', { name: 'Files', exact: true })
  await action.first().waitFor({ state: 'visible', timeout: 30_000 })
  await action.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForSelector('.dsh-web-files', { timeout: 30_000 })
  // The first listing is a round trip into the container.
  await page.waitForFunction(
    () => document.querySelectorAll('.dsh-web-files-list li').length > 0,
    undefined,
    { timeout: 60_000 },
  ).catch(() => undefined)
}

/** The channels of a `rgb(…)` string. */
function channels(colour: string): number[] {
  return (colour.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
}

/** WCAG relative luminance. */
function luminance(colour: string): number {
  const [red, green, blue] = channels(colour).map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

/**
 * The contrast ratio between two rendered colours.
 *
 * Computed here rather than in the page: a helper defined inside
 * `page.evaluate` is transpiled with esbuild's `__name` wrapper, which the page
 * has never heard of.
 * @param front - the text colour.
 * @param back - what it is drawn on.
 * @returns the WCAG ratio, 1 for identical and 21 for black on white.
 */
function contrast(front: string, back: string): number {
  const [high, low] = [luminance(front), luminance(back)].sort((left, right) => right - left)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

/** What the panel is currently painted in. */
async function palette(page: Page): Promise<{ background: string, text: string, row: string, hint: string }> {
  return page.evaluate(() => {
    const panel = document.querySelector('.dsh-web-files')
    if (panel === null) return { background: '', text: '', row: '', hint: '' }
    const style = getComputedStyle(panel)
    const row = document.querySelector('.dsh-web-files-label')
    const hint = document.querySelector('.dsh-web-files-hint')
    return {
      background: style.backgroundColor,
      text: style.color,
      row: row === null ? style.color : getComputedStyle(row).color,
      hint: hint === null ? style.color : getComputedStyle(hint).color,
    }
  })
}

/**
 * Everything a download handed the browser.
 * @param download - the event Playwright captured.
 * @returns the bytes.
 */
async function downloaded(download: { createReadStream(): Promise<NodeJS.ReadableStream> }): Promise<Buffer> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** One check. */
interface Check {
  name: string
  run(page: Page): Promise<void>
}

const checks: Check[] = [
  {
    // The one placement fact the task named: the same row shape as the
    // terminal's, above it. Read off the rendered boxes rather than the DOM,
    // because what "above" means here is what the user sees.
    name: 'the Files action sits above the Terminal action',
    async run(page) {
      await acknowledge(page)
      const placed = await page.evaluate(() => Array.from(document.querySelectorAll('button[aria-label]'))
        .filter(node => ['Files', 'Terminal'].includes(node.getAttribute('aria-label') ?? ''))
        .map((node) => {
          const box = node.getBoundingClientRect()
          return { label: node.getAttribute('aria-label'), top: Math.round(box.top), height: Math.round(box.height) }
        }))
      const files = placed.find(row => row.label === 'Files')
      const terminal = placed.find(row => row.label === 'Terminal')
      expect(files !== undefined, `no Files action in the sidebar: ${JSON.stringify(placed)}`)
      expect(terminal !== undefined, `no Terminal action in the sidebar: ${JSON.stringify(placed)}`)
      expect(files!.top < terminal!.top, `Files is not above Terminal: ${JSON.stringify(placed)}`)
      // The same shape, not merely the same place: a row that had drifted to a
      // different height would read as a different kind of control.
      expect(files!.height === terminal!.height, `the two actions are different heights: ${JSON.stringify(placed)}`)
    },
  },
  {
    // The panel shipped once with `--dsw-alias-bg-l1`, a token this surface
    // does not define. The background fell back to a dark literal while the
    // text colour resolved from a real token and followed the light theme:
    // dark on dark, nothing readable, and every other check still green. What
    // catches that is measuring what a reader would see.
    name: 'the panel is legible in both themes',
    async run(page) {
      await openPanel(page)
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((wanted: string) => {
          if (wanted === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
          else document.body.removeAttribute('data-ds-dark-theme')
        }, theme)
        await page.waitForTimeout(400)
        const seen = await palette(page)
        expect(seen.background !== '', `the panel is not on screen in the ${theme} theme`)
        // 4.5 is the ratio WCAG asks of body text; the surface's own tokens
        // clear it by a wide margin, so anything near it means a fallback won.
        for (const [what, colour] of Object.entries({ text: seen.text, row: seen.row, hint: seen.hint })) {
          const ratio = contrast(colour, seen.background)
          expect(ratio >= 4.5,
            `${what} is unreadable in the ${theme} theme: ${colour} on ${seen.background} is ${ratio.toFixed(2)}:1`)
        }
      }
      await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    },
  },
  {
    name: 'the panel shows the workspace the agent writes to',
    async run(page) {
      await shell(page, 'mkdir -p sub && echo hello-from-the-agent > note.txt && echo deeper > sub/deep.txt')
      await openPanel(page)
      // The listing is a snapshot, and the panel may already have been open
      // when the agent wrote these — so re-read it the way a person would.
      await refresh(page)
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('note.txt')),
        undefined,
        { timeout: 30_000 },
      )
      const listed = await rows(page)
      expect(listed.some(row => row.includes('sub')), `the directory is missing: ${JSON.stringify(listed)}`)
      // Directories first is the order a file browser is read in.
      expect(listed.findIndex(row => row.includes('sub')) < listed.findIndex(row => row.includes('note.txt')),
        `directories are not first: ${JSON.stringify(listed)}`)
      const hint = await page.evaluate(() => document.querySelector('.dsh-web-files-hint')?.textContent ?? '')
      expect(/agent and the terminal share/.test(hint), `the panel does not name the shared workspace: ${hint}`)
    },
  },
  {
    name: 'a file opens, and a directory is entered',
    async run(page) {
      await openPanel(page)
      await page.getByRole('button', { name: /note\.txt/ }).first().click()
      await page.waitForSelector('.dsh-web-files-text', { timeout: 30_000 })
      const shown = await page.evaluate(() => document.querySelector('.dsh-web-files-text')?.textContent ?? '')
      expect(/hello-from-the-agent/.test(shown), `the viewer did not show the file: ${JSON.stringify(shown)}`)

      await page.getByRole('button', { name: /sub$/ }).first().click()
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('deep.txt')),
        undefined,
        { timeout: 30_000 },
      )
      const crumbs = await page.evaluate(() => document.querySelector('.dsh-web-files-crumbs')?.textContent ?? '')
      expect(/sub/.test(crumbs), `the breadcrumb did not follow the directory: ${crumbs}`)
      await goRoot(page)
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('note.txt')),
        undefined,
        { timeout: 30_000 },
      )
    },
  },
  {
    name: 'a file downloads out of the tab',
    async run(page) {
      await openPanel(page)
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.evaluate(() => {
          const row = Array.from(document.querySelectorAll('.dsh-web-files-list li'))
            .find(node => (node.textContent ?? '').includes('note.txt'))
          const button = Array.from(row?.querySelectorAll('button') ?? []).find(node => node.textContent === '↓')
          button?.click()
        }),
      ])
      expect(download.suggestedFilename() === 'note.txt', `unexpected download name: ${download.suggestedFilename()}`)
      const text = (await downloaded(download)).toString('utf8')
      expect(/hello-from-the-agent/.test(text), `the downloaded bytes are not the file's: ${JSON.stringify(text)}`)
    },
  },
  {
    // A browser can be handed one thing at a time, and a directory is not a
    // thing it can be handed at all — so both of these are a zip, and the only
    // way to check a zip is to open it.
    name: 'a directory downloads as a zip of what is in it',
    async run(page) {
      await openPanel(page)
      await shell(page, 'mkdir -p sub/deeper && echo one > sub/a.txt && echo two > sub/deeper/b.txt')
      await refresh(page)
      const [archive] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.evaluate(() => {
          const row = Array.from(document.querySelectorAll('.dsh-web-files-list li'))
            .find(node => (node.textContent ?? '').includes('sub'))
          const button = Array.from(row?.querySelectorAll('button') ?? []).find(node => node.textContent === '↓')
          button?.click()
        }),
      ])
      expect(archive.suggestedFilename() === 'sub.zip', `unexpected archive name: ${archive.suggestedFilename()}`)
      const unpacked = unzipSync(new Uint8Array(await downloaded(archive)))
      const names = Object.keys(unpacked).sort()
      expect(names.includes('sub/a.txt'), `the archive is missing the file: ${names.join(', ')}`)
      expect(names.includes('sub/deeper/b.txt'), `the archive did not walk into the subdirectory: ${names.join(', ')}`)
      expect(Buffer.from(unpacked['sub/a.txt'] ?? new Uint8Array()).toString('utf8').trim() === 'one',
        'the archived bytes are not the file\'s')
    },
  },
  {
    name: 'a selection downloads as one archive',
    async run(page) {
      await openPanel(page)
      await shell(page, 'echo picked > pick-me.txt && echo ignored > leave-me.txt')
      await refresh(page)
      // Ticked the way a person ticks them, so the row's own checkbox is what
      // is under test rather than a state setter.
      for (const name of ['pick-me.txt', 'sub']) {
        await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).first().check()
      }
      const [archive] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByRole('button', { name: /Download 2 selected/ }).first().click(),
      ])
      expect(archive.suggestedFilename() === 'workspace.zip', `unexpected archive name: ${archive.suggestedFilename()}`)
      const names = Object.keys(unzipSync(new Uint8Array(await downloaded(archive)))).sort()
      expect(names.includes('pick-me.txt'), `the archive is missing the picked file: ${names.join(', ')}`)
      expect(names.includes('sub/a.txt'), `the archive is missing the picked directory: ${names.join(', ')}`)
      expect(!names.includes('leave-me.txt'), `the archive carries what was not picked: ${names.join(', ')}`)
    },
  },
  {
    name: 'select-all takes the whole listing, and clears on navigation',
    async run(page) {
      await openPanel(page)
      await refresh(page)
      const all = page.getByRole('checkbox', { name: 'Select everything here', exact: true })
      await all.first().check()
      const label = await page.evaluate(() =>
        document.querySelector('.dsh-web-files-all span')?.textContent ?? '')
      const counted = /^(\d+) of (\d+)$/.exec(label)
      expect(counted !== null, `the selection count is not shown: ${label}`)
      expect(counted![1] === counted![2] && Number(counted![1]) > 0,
        `select-all did not take everything: ${label}`)
      // Into a directory and the selection is gone: it belonged to the listing
      // it was made in, and downloading paths the user can no longer see is the
      // failure this guards.
      await page.getByRole('button', { name: /sub$/ }).first().click()
      await page.waitForFunction(
        () => (document.querySelector('.dsh-web-files-all span')?.textContent ?? '') === 'Select',
        undefined,
        { timeout: 30_000 },
      )
      await goRoot(page)
    },
  },
  {
    // The half of the loop the agent cannot do for the user: there is no
    // `~/Downloads` in a tab to read from.
    name: 'a file uploads into the workspace the agent reads',
    async run(page) {
      await openPanel(page)
      await goRoot(page)
      await page.setInputFiles('.dsh-web-files input[type=file]', {
        name: 'uploaded.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('came from the user\n'),
      })
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('uploaded.txt')),
        undefined,
        { timeout: 60_000 },
      )
      const seen = await shell(page, 'cat uploaded.txt')
      expect(/came from the user/.test(seen), `the agent cannot read the uploaded file: ${JSON.stringify(seen)}`)
    },
  },
  {
    name: 'a folder is created and a file is deleted',
    async run(page) {
      await openPanel(page)
      await goRoot(page)
      page.once('dialog', (dialog) => { void dialog.accept('made-here') })
      await page.getByRole('button', { name: 'New folder' }).click()
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('made-here')),
        undefined,
        { timeout: 30_000 },
      )
      const listed = await shell(page, 'ls')
      expect(/made-here/.test(listed), `the agent does not see the new folder: ${listed}`)

      page.once('dialog', (dialog) => { void dialog.accept() })
      await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.dsh-web-files-list li'))
          .find(node => (node.textContent ?? '').includes('uploaded.txt'))
        const button = Array.from(row?.querySelectorAll('button') ?? []).find(node => node.textContent === '✕')
        button?.click()
      })
      await page.waitForFunction(
        () => !Array.from(document.querySelectorAll('.dsh-web-files-list li')).some(row => (row.textContent ?? '').includes('uploaded.txt')),
        undefined,
        { timeout: 30_000 },
      )
      const gone = await shell(page, 'ls')
      expect(!/uploaded\.txt/.test(gone), `the file survived deletion: ${gone}`)
    },
  },
  {
    // The gesture this deployment used to swallow: every "open this path" in
    // the surface — a file mention in the chat, a produced-file chip, a tool
    // row's link — ends at the host's `openPath`, which ended at a command that
    // did not exist. It now ends here.
    name: 'the host opening a path opens it in the panel',
    async run(page) {
      await acknowledge(page)
      await shell(page, 'echo opened-by-the-host > pointed-at.txt')
      await page.evaluate(() => { (globalThis as { __DSH_FILES__?: { close(): void } }).__DSH_FILES__?.close() })

      const answered = await page.evaluate(async () => {
        const proxy = globalThis.dsh.ctx.get('apiProxy') as {
          host: {
            openPath(request: { rpcId: string, payload: { path: string } }, signal: AbortSignal): Promise<{
              result: { ok: boolean, error?: { message?: string } }
            }>
            describe(request: { rpcId: string, payload: Record<string, never> }): Promise<{
              result: { value?: { canOpenPath?: boolean } }
            }>
          }
        } | undefined
        if (proxy === undefined) return { ok: false, why: 'no apiProxy service' }
        const described = await proxy.host.describe({ rpcId: crypto.randomUUID(), payload: {} })
        const opened = await proxy.host.openPath(
          { rpcId: crypto.randomUUID(), payload: { path: '/home/dsh/workspace/pointed-at.txt' } },
          new AbortController().signal,
        )
        return {
          ok: opened.result.ok,
          why: opened.result.error?.message ?? '',
          canOpenPath: described.result.value?.canOpenPath === true,
        }
      })
      expect(answered.ok, `the host refused to open a path: ${answered.why}`)
      // The surface asks this before it offers the affordance at all.
      expect(answered.canOpenPath === true, 'the host reports it cannot open a path')

      await page.waitForSelector('.dsh-web-files-text', { timeout: 30_000 })
      const shown = await page.evaluate(() => ({
        open: document.querySelector('.dsh-web-files') !== null,
        title: document.querySelector('.dsh-web-files-viewer .dsh-web-files-title')?.textContent ?? '',
        text: document.querySelector('.dsh-web-files-text')?.textContent ?? '',
      }))
      expect(shown.open, 'the panel did not open')
      expect(shown.title === 'pointed-at.txt', `the panel opened on the wrong file: ${shown.title}`)
      expect(/opened-by-the-host/.test(shown.text), `the panel did not show the file: ${shown.text}`)
    },
  },
  {
    // The roster the plugin center gained. With nothing installed it must say
    // so rather than render an empty box, because "no plugins" and "the list
    // failed to load" look identical otherwise.
    name: 'the plugin center lists what is installed, and can turn it off',
    async run(page) {
      await acknowledge(page)
      await page.evaluate(() => { (globalThis as { __DSH_FILES__?: { close(): void } }).__DSH_FILES__?.close() })
      // Invoked on the element rather than clicked at a point: the surface
      // draws overlays across the sidebar, and a click that lands on one never
      // reaches the row underneath.
      await page.getByRole('button', { name: /Settings/ }).first().evaluate((node: HTMLElement) => { node.click() })
      const plugins = page.getByRole('button', { name: /^Plugins$/ })
      await plugins.first().waitFor({ state: 'visible', timeout: 30_000 })
      await plugins.first().evaluate((node: HTMLElement) => { node.click() })
      const installed = tab(page, 'Installed')
      await installed.first().waitFor({ state: 'visible', timeout: 30_000 })
      await installed.first().evaluate((node: HTMLElement) => { node.click() })
      await page.waitForSelector('.dsh-web-roster', { timeout: 30_000 })

      const empty = await page.evaluate(() => document.querySelector('.dsh-web-roster')?.textContent ?? '')
      expect(/Nothing installed here yet/.test(empty), `the empty roster says nothing: ${empty}`)

      // A real package, installed the way the surface installs one, so the row
      // and its switch are exercised against a genuine roster entry.
      const entry = await page.evaluate(async () => {
        try {
          const installedEntry = await globalThis.dsh.plugins.install(
            'https://registry.npmjs.org/dsh-working-activity/-/dsh-working-activity-0.2.4.tgz',
          )
          return `${installedEntry.name}@${installedEntry.version}`
        } catch (error) { return `failed: ${String(error)}` }
      })
      expect(/^dsh-working-activity@0\.2\.4$/.test(entry), `installing a plugin failed: ${entry}`)

      // The tab reads the roster when it mounts and the surface keeps a visited
      // tab mounted, so the panel's own Refresh is what a person would reach
      // for here — and what this asserts works.
      await page.getByRole('button', { name: 'Refresh', exact: true }).first()
        .evaluate((node: HTMLElement) => { node.click() })
      await page.waitForFunction(
        () => (document.querySelector('.dsh-web-roster')?.textContent ?? '').includes('dsh-working-activity'),
        undefined,
        { timeout: 30_000 },
      )
      const before = await page.evaluate(() => document.querySelector('.dsh-web-roster')?.textContent ?? '')
      expect(/Enabled/.test(before), `a freshly installed plugin is not enabled: ${before}`)

      await page.getByRole('button', { name: 'Disable', exact: true }).first()
        .evaluate((node: HTMLElement) => { node.click() })
      await page.waitForFunction(
        () => (document.querySelector('.dsh-web-roster')?.textContent ?? '').includes('Disabled'),
        undefined,
        { timeout: 60_000 },
      )
      const after = await page.evaluate(() => document.querySelector('.dsh-web-roster')?.textContent ?? '')
      expect(/Reload to apply/.test(after), `the roster does not say a reload is needed: ${after}`)
      // The switch changed the roster, which is the durable half of the answer.
      const roster = await page.evaluate(() => globalThis.dsh.plugins.list()
        .map(plugin => `${plugin.name}:${String(plugin.enabled)}`).join(','))
      expect(/dsh-working-activity:false/.test(roster), `the roster was not written: ${roster}`)
    },
  },
  {
    // A toggle used to recompose the tree from a shorter layer stack than the
    // boot used, which took the terminal, the star row, the network page and
    // the user's own layer with it. The check is cheap and the failure it
    // guards against is silent.
    name: 'turning a plugin off leaves the rest of the composition standing',
    async run(page) {
      const standing = await page.evaluate(() => ({
        terminal: document.querySelector('button[aria-label="Terminal"]') !== null,
        files: document.querySelector('button[aria-label="Files"]') !== null,
        runtime: typeof (globalThis as { __DSH_WEB_RUNTIME__?: unknown }).__DSH_WEB_RUNTIME__,
      }))
      expect(standing.terminal, 'the terminal action is gone after a plugin was disabled')
      expect(standing.files, 'the files action is gone after a plugin was disabled')
      const ran = await shell(page, 'echo still-here')
      expect(/still-here/.test(ran), `commands stopped working after a plugin was disabled: ${ran}`)
    },
  },
]

/** Run the selected checks. */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error: Error) => { errors.push(error.message) })

  let failures = 0
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForShell(page)
    const warnings = await page.evaluate(() => (globalThis as { __DSH_WARNINGS__?: string[] }).__DSH_WARNINGS__ ?? [])
    if (warnings.length > 0) process.stdout.write(`  host warnings:\n    ${warnings.join('\n    ')}\n`)

    for (const check of checks) {
      if (only !== undefined && check.name !== only) continue
      process.stdout.write(`▶ ${check.name}\n`)
      const started = Date.now()
      try {
        await check.run(page)
        process.stdout.write(`  ✓ ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
      } catch (error) {
        failures++
        process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
        await page.screenshot({ path: `/tmp/dsh-files-${check.name.replace(/\W+/g, '-')}.png` }).catch(() => undefined)
      }
    }
  } finally {
    await browser.close()
  }

  if (errors.length > 0) process.stdout.write(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}\n`)
  process.stdout.write(failures === 0 ? '\n✓ the files surface works\n' : `\n✗ ${String(failures)} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
