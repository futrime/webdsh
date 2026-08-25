/**
 * Real-workload test for the emulated runtime.
 *
 * The point of an emulated PC in a harness is not that it boots. It is that a
 * model can *get work done on it*, and every guest gets work done differently:
 * a Linux has a shell, DOS has a command interpreter behind a serial console
 * that has to be moved there first, and Windows 3.1 has neither and must be
 * typed at. So this drives each of those three the way the tools drive them,
 * with workloads that would fail if any part of the chain were faked.
 *
 * It also checks the part that is easiest to get wrong and hardest to notice:
 * **which tools the model is offered.** A session on an emulated machine that
 * still carries `jsh` is a session where the model will spend its first turn
 * running `node -e` on a 486. That is read off the wire — the request the
 * adapter actually sent — for the same reason `scripts/e2e.ts` does it: a
 * registry answers about the unscoped subset, and the shell tool is
 * agent-scoped.
 *
 * Windows 3.1 is driven from a disk image this repository does not ship and
 * does not serve. The image host v86's own demo uses refuses requests that
 * carry a `Referer` from anywhere but `copy.sh`, so the browser cannot fetch it
 * — which is exactly why the panel takes a disk image from your computer, and
 * exactly the path this suite exercises: the image is fetched once, here, and
 * handed to the page through the file input a person would use.
 *
 * Usage: `npx tsx scripts/v86-e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
/**
 * Boot every guest, not only the ones a fast suite can afford.
 *
 * Twelve of the machines here need a disk this deployment is not allowed to
 * serve, and the default suite covers two of them. That is enough to prove the
 * mechanism and not enough to prove the catalog, so `--all` walks the rest
 * through the same mirror fixture: every guest, from its own images, to its
 * own readiness marker. It is slow and it downloads a great deal, which is why
 * it is a flag.
 */
const all = process.argv.includes('--all')
const headed = args.includes('--headed')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Assert a condition, failing the scenario with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** One scenario. */
interface Scenario {
  name: string
  /** Excluded from a default run; `--all` or `--case` includes it. */
  slow?: boolean
  run(page: Page): Promise<void>
}

/**
 * Thrown by a scenario that could not run at all.
 *
 * Distinct from a failure and distinct from a pass, because it is neither: a
 * scenario that quietly returned early was reported with a tick and counted in
 * "all scenarios passed", which is the one outcome a suite must never produce
 * for work it did not do.
 */
class Skipped extends Error {}

/** Wait until the app's own boot screen is gone and the shell rendered. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 120_000 })
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

/**
 * Open Settings and go to the Machine page.
 *
 * Where the choice lives, and the reason it is reached this way in the test:
 * a picker in a panel of its own could be opened by clicking one thing, and
 * one that has moved into Settings can only be reached the way a person
 * reaches it. If that path breaks, the setting is unreachable — which no
 * assertion about the page's contents would catch.
 */
async function openMachineSettings(page: Page): Promise<void> {
  await dismissNotice(page)
  const settings = page.getByRole('button', { name: /^Settings$/ })
  await settings.first().waitFor({ state: 'visible', timeout: 30_000 })
  await settings.first().evaluate((node: HTMLElement) => { node.click() })
  const nav = page.getByRole('button', { name: /^Machine$/ })
  await nav.first().waitFor({ state: 'visible', timeout: 20_000 })
  await nav.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForSelector('.dsh-web-machine-settings', { timeout: 20_000 })
}

/** Open the Machine panel through the plugin's own sidebar action. */
async function openMachinePanel(page: Page): Promise<void> {
  await dismissNotice(page)
  const action = page.getByRole('button', { name: 'Machine panel', exact: true })
  await action.first().waitFor({ state: 'visible', timeout: 30_000 })
  await action.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForSelector('.dsh-web-machine[data-open]', { timeout: 20_000 })
}

/** The machine bridge, as this suite calls it. */
interface MachineHandle {
  ready(timeoutMs?: number): Promise<boolean>
  console: {
    run(command: string, options?: { timeoutMs?: number }): Promise<{ output: string, exitCode: number | null, timedOut: boolean }>
    releaseScreen(): Promise<void>
    putFile(path: string, content: string): Promise<{ expected: number, reported: number | null }>
  }
  screen: {
    text(): Promise<{ lines: string[], cols: number, rows: number, graphical: boolean }>
    transcript(): Promise<string[]>
    shot(): Promise<{ width: number, height: number, bytes: number, graphical: boolean }>
  }
  input: {
    type(text: string): Promise<void>
    press(key: string): Promise<void>
    mouse(dx: number, dy: number): Promise<void>
    click(which?: 'left' | 'middle' | 'right'): Promise<void>
  }
  status(): { emulated: boolean, guest?: string, running: boolean, failure?: string }
}

/** Run one command on the machine through the page's own console channel. */
async function run(page: Page, command: string, timeoutMs = 120_000): Promise<{ output: string, exitCode: number | null, timedOut: boolean }> {
  return page.evaluate(async ([source, budget]) => {
    const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
    return machine.console.run(source as string, { timeoutMs: budget as number })
  }, [command, timeoutMs] as const)
}

/** Write a text file onto the machine through its console. */
async function putFile(page: Page, path: string, content: string): Promise<{ expected: number, reported: number | null }> {
  return page.evaluate(async ([target, body]) => {
    const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
    return machine.console.putFile(target as string, body as string)
  }, [path, content] as const)
}

/** What the guest is doing with its pointer, and whether it is being given one. */
async function pointerState(page: Page): Promise<{ enabled: boolean, absolute: boolean, held: boolean }> {
  return page.evaluate(() => (globalThis as unknown as {
    __DSH_WEB_MACHINE__: { pointer(): { enabled: boolean, absolute: boolean, held: boolean } }
  }).__DSH_WEB_MACHINE__.pointer())
}

/** How many bytes the screen's PNG comes to, which is a cheap "did it change". */
async function shotBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
    return (await machine.screen.shot()).bytes
  })
}

/**
 * Tell the panel what the guest is doing with its pointer.
 *
 * A stub, and deliberately: the two pointer kinds are the guest's choice, and
 * no machine this deployment can reach without a disk of your own runs a
 * driver that picks the absolute one. What is under test is the panel, so the
 * panel is given the fact and watched.
 * @param page - the page.
 * @param state - the pointer state to report.
 */
async function setPointer(page: Page, state: { enabled: boolean, absolute: boolean }): Promise<void> {
  await page.evaluate((next: { enabled: boolean, absolute: boolean }) => {
    const bridge = (globalThis as unknown as { __DSH_WEB_MACHINE__: { pointer: () => unknown } }).__DSH_WEB_MACHINE__
    bridge.pointer = () => next
  }, state)
  // The panel reads it twice a second.
  await page.waitForTimeout(1200)
}

/** Wait for the machine to reach its readiness marker. */
async function ready(page: Page, timeoutMs: number): Promise<boolean> {
  return page.evaluate(async (budget: number) => {
    const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
    return machine.ready(budget)
  }, timeoutMs)
}

/**
 * Drive one turn with a dummy key and read the tools off the request it sent.
 *
 * The provider rejects the key, but the request is built and sent first, and
 * that request is the only thing that cannot be wrong about what the model was
 * offered.
 * @param page - the loaded app.
 * @returns the offered tool names, sorted.
 */
async function offeredTools(page: Page): Promise<string[]> {
  await page.evaluate(() => { (globalThis as { __SENT__?: string[] }).__SENT__ = [] })
  await page.evaluate(async () => {
    await Promise.race([
      globalThis.dsh.promptOnce('sk-not-a-real-key', 'List the files here.').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 25_000)),
    ])
  }).catch(() => undefined)
  await page.waitForTimeout(3000)
  const bodies = await page.evaluate(() => (globalThis as { __SENT__?: string[] }).__SENT__ ?? [])
  for (const body of bodies) {
    try {
      const parsed = JSON.parse(body) as { tools?: { function?: { name?: string } }[] }
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        return parsed.tools.map(tool => tool.function?.name ?? '?').sort()
      }
    } catch {
      // Not a model request; the next body may be.
    }
  }
  return []
}

/**
 * Prove a keystroke reached the guest by making the screen change on cue.
 *
 * A single before/after comparison proves nothing: a caret, a clock or a
 * highlight moves the pixels on its own and the check would pass with the
 * keyboard disconnected. Windows 1.01 is exactly that case, measured — its
 * screen drifts by a dozen bytes with nobody touching it, while Windows 3.1
 * and 98 sit perfectly still.
 *
 * So the screen's own restlessness is measured first, over several seconds,
 * and the keystroke has to move it further than that. What opening a menu does
 * to a PNG is two orders of magnitude more than a blinking caret does, so the
 * margin is not delicate.
 * @param page - the loaded app.
 * @param key - the key to press, in `vm_key`'s spelling.
 */
async function proveKeyboardReaches(page: Page, key: string): Promise<void> {
  const shot = async (): Promise<number> => page.evaluate(async () =>
    (await (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__.screen.shot()).bytes)
  const idle: number[] = []
  for (let sample = 0; sample < 4; sample++) {
    idle.push(await shot())
    await page.waitForTimeout(1500)
  }
  const low = Math.min(...idle)
  const high = Math.max(...idle)
  const drift = high - low
  // Ten times the drift it showed while idle, and never less than 400 bytes.
  const margin = Math.max(400, drift * 10)

  await page.evaluate(async (pressed: string) => {
    await (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__.input.press(pressed)
  }, key)
  // Polled rather than sampled once after a fixed wait. What is being timed is
  // an emulated Pentium drawing a menu, and how long that takes is a fact about
  // the machine underneath: four seconds is plenty on a workstation and not
  // always enough on a shared CI runner, where this failed with the screen
  // byte-identical — the same 20675 both times — on a guest that was measured
  // answering the same keystroke locally. Waiting *for the change* rather than
  // for the clock makes a slow host slow instead of red.
  let after = await shot()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && after >= low - margin && after <= high + margin) {
    await page.waitForTimeout(1000)
    after = await shot()
  }
  expect(after < low - margin || after > high + margin,
    `${key} moved the screen from ${String(low)}-${String(high)} bytes to ${String(after)}, `
    + `which is inside the ${String(margin)}-byte margin it drifts by on its own — the keyboard is not reaching the guest`)
}

/** Where a disk image this suite needs is cached between runs. */
const CACHE = join(tmpdir(), 'dshw-v86-images')

/**
 * Fetch a disk image this repository does not ship.
 *
 * From Node, once per machine, and cached: this is a person downloading a disk
 * image, which is the same thing the panel's file input expects them to have
 * done. It is not what the deployed page does, and it is not what it could do —
 * see this file's header.
 * @param name - the image file name on the host.
 * @param bytes - its exact size, so a truncated download is caught here.
 * @returns the path it was cached at, or undefined when it could not be fetched.
 */
async function cachedImage(name: string, bytes: number): Promise<string | undefined> {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, name)
  if (existsSync(path) && statSync(path).size === bytes) return path
  const host = process.env.V86_IMAGE_HOST ?? 'https://i.copy.sh/'
  process.stdout.write(`  fetching ${name} (${String(Math.round(bytes / (1024 * 1024)))} MB) once, into ${CACHE}\n`)
  const response = await fetch(`${host}${name}`, { referrer: '' }).catch(() => undefined)
  if (response === undefined || !response.ok) return undefined
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.length !== bytes) return undefined
  const staging = `${path}.part`
  writeFileSync(staging, body)
  renameSync(staging, path)
  return path
}

/**
 * A host that serves the wider image set, for the length of one test.
 *
 * Windows 98 is not one file. Its disk is published as 256 KiB pieces and its
 * saved machine as a separate compressed blob, so there is nothing to hand to
 * the panel's file input — the only way to boot it is from a host, which is
 * what the image-host setting is for. This is that host: it fetches from
 * upstream in Node, where a plain download is a plain download, caches what it
 * fetched, and serves it to the browser with the CORS headers a disk image
 * needs.
 *
 * It is a fixture standing in for a mirror, not a way around anything: the
 * bytes are fetched exactly once per machine and then come off this disk. A
 * deployment that wants these guests points the setting at a mirror of its own
 * and the page behaves identically.
 * @returns the origin to point the page at, and a way to stop it.
 */
async function startImageHost(): Promise<{ origin: string, close(): Promise<void> }> {
  const upstream = process.env.V86_IMAGE_HOST ?? 'https://i.copy.sh/'
  mkdirSync(CACHE, { recursive: true })
  let served = 0
  let fetched = 0

  const headers = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'content-type': 'application/octet-stream',
  }
  const server: Server = createServer((request, response) => {
    void (async () => {
      const asked = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)
      // Flattened rather than sanitised in place: a decoded `%2e%2e` is a real
      // `..` by the time it gets here, and joining it onto the cache directory
      // would write outside it.
      const path = asked.split('/').filter(part => part !== '' && part !== '.' && part !== '..').join('/')
      const cached = join(CACHE, path.replace(/[^\w./-]/g, '_'))
      if (!existsSync(cached)) {
        const answer = await fetch(`${upstream}${path}`, { referrer: '' }).catch(() => undefined)
        if (answer === undefined || !answer.ok) {
          response.writeHead(answer?.status ?? 502, headers)
          response.end()
          return
        }
        const body = new Uint8Array(await answer.arrayBuffer())
        // Written beside the target and renamed, so a run interrupted mid-write
        // leaves no half a disk image behind for every later run to serve.
        mkdirSync(dirname(cached), { recursive: true })
        const staging = `${cached}.part`
        writeFileSync(staging, body)
        renameSync(staging, cached)
        fetched++
      }
      const body = readFileSync(cached)
      served++
      response.writeHead(200, { ...headers, 'content-length': String(body.length) })
      response.end(body)
    })().catch((error: unknown) => {
      // Never a rejection: an unhandled one takes the whole suite process down
      // and the browser is left waiting on a request that will never answer.
      process.stdout.write(`  image host: ${error instanceof Error ? error.message : String(error)}\n`)
      response.writeHead(500, headers)
      response.end()
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${String(port)}/`,
    close: async () => {
      process.stdout.write(`  image host served ${String(served)} files, ${String(fetched)} of them fetched upstream\n`)
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    },
  }
}

const scenarios: Scenario[] = [
  {
    // The setting a person uses: it lists the machines, it says which one is
    // running, and choosing one writes the choice the next load reads. It is
    // in Settings, which is where a choice that only takes effect on the next
    // load belongs — beside every other thing this deployment can be told.
    name: 'picker',
    async run(page) {
      await page.goto(`${url}?runtime=node`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      await openMachineSettings(page)

      const listed = await page.locator('.dsh-web-machine-name').allInnerTexts()
      for (const wanted of ['Node container', 'FreeDOS', 'Windows 1.01', 'Windows 3.1', 'Windows 98', 'Linux']) {
        expect(listed.includes(wanted), `the setting does not offer ${wanted}; it offers ${listed.join(', ')}`)
      }
      const lede = await page.locator('.dsh-web-machine-lede').first().innerText()
      expect(lede.includes('Node container'), `the setting reports "${lede}" while running the container`)

      // The ones that need nothing say so; the ones that need a disk say that.
      // Windows 98 rather than Windows 3.1: 3.1 is one 33 MB file and reachable
      // now, and 98's disk is three hundred megabytes of pieces that exist on
      // one host in the world, which is the shape of every machine still on the
      // wrong side of this line.
      const rows = await page.locator('.dsh-web-machine-row').allInnerTexts()
      const windows98 = rows.find(row => row.startsWith('Windows 98'))
      expect(windows98 !== undefined && windows98.includes('needs a disk'),
        'Windows 98 does not tell the user its image is not on the default host')
      const freedos = rows.find(row => row.startsWith('FreeDOS'))
      expect(freedos !== undefined && !freedos.includes('needs a disk'),
        'FreeDOS claims its image is missing, but the default host serves it')
      const windows31 = rows.find(row => row.startsWith('Windows 3.1'))
      expect(windows31 !== undefined && !windows31.includes('needs a disk'),
        'Windows 3.1 claims its image is missing, but `v86-mirror.json` says where it is')

      await page.getByRole('button', { name: /^FreeDOS/ }).first().click()
      await page.getByRole('button', { name: 'Use this machine' }).click()
      const stored = await page.evaluate(() => localStorage.getItem('dsh-web:runtime'))
      expect(stored === 'v86:freedos', `the choice was stored as ${String(stored)}`)
      const saved = await page.locator('.dsh-web-machine-apply').first().innerText()
      expect(saved.includes('next load'), 'the setting does not say the choice applies on the next load')
    },
  },

  {
    // DOS: the whole point is that `CTTY COM1` turns an 80×25 screen into a
    // character stream, so the workloads are ones that would lose their output
    // if it had been scraped off the screen instead.
    name: 'freedos',
    async run(page) {
      await page.goto(`${url}?runtime=v86:freedos`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 120_000), 'FreeDOS did not reach a prompt')

      const version = await run(page, 'ver')
      expect(/FreeCom/i.test(version.output), `\`ver\` did not name FreeCOM: ${JSON.stringify(version.output)}`)

      // More than one screen of output. `type readme` is 30-odd lines, and the
      // top of it is exactly what a screen scraper would have lost.
      const readme = await run(page, 'type readme')
      const lines = readme.output.split('\n')
      expect(lines.length > 25, `\`type readme\` returned ${String(lines.length)} lines; the screen holds 25`)
      // Both ends, and a line from the middle: a capture that kept only the
      // tail — which is all a screen scraper can keep — passes a line count.
      expect(lines[0].includes('FREEDOS'), `the file's first line is missing: ${JSON.stringify(lines.slice(0, 2))}`)
      expect(readme.output.includes('auto generated about once a week'),
        'a line from the middle of the file is missing from the output')

      // DOS's ERRORLEVEL comes from external programs and from nothing else:
      // a failing *internal* command says so in its output and leaves the
      // number alone. Both halves are asserted, because the tool's description
      // tells the model exactly this and a change to either would make it a lie.
      const missing = await run(page, 'type nosuchfile.txt')
      expect(/not found/i.test(missing.output), `a failing \`type\` said ${JSON.stringify(missing.output)}`)
      const program = await run(page, 'nasm nosuchfile.asm')
      expect(program.exitCode === 1,
        `an external program's failure came back as ${String(program.exitCode)}, not 1`)

      // Redirection, and reading it back: two commands, one channel, in order.
      await run(page, 'echo hello from dsh > dshtest.txt')
      const back = await run(page, 'type dshtest.txt')
      expect(back.output.includes('hello from dsh'), `the file did not come back: ${JSON.stringify(back.output)}`)

      // Building a file a line at a time, which is what the tool description
      // tells a DOS session to do because DOS has no file channel of its own —
      // and then running it, which is the only way to know the lines arrived in
      // order and intact.
      await run(page, 'echo @echo off > dshbat.bat')
      for (const line of ['first', 'second', 'third']) await run(page, `echo echo ${line} >> dshbat.bat`)
      const batch = await run(page, 'dshbat')
      for (const line of ['first', 'second', 'third']) {
        expect(batch.output.includes(line), `the batch file did not print "${line}": ${JSON.stringify(batch.output)}`)
      }

      // And the tool that would have been the obvious way to do it refuses,
      // rather than wedging the console the way `COPY CON` does.
      const refused = await page.evaluate(async () => {
        const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
        return machine.console.putFile('x.txt', 'hi').then(() => 'wrote it', (error: Error) => error.message)
      })
      expect(typeof refused === 'string' && refused.includes('no shell'),
        `writing a file through a DOS console did not refuse: ${String(refused)}`)

      // The console still works afterwards, which is the point of refusing.
      const after = await run(page, 'ver')
      expect(/FreeCom/i.test(after.output), `the console did not survive: ${JSON.stringify(after.output)}`)

      // The console goes back to the screen for anything screen-facing, which
      // is what keeps `vm_screen` and `vm_type` honest after a command has run.
      const screen = await page.evaluate(async () => {
        const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
        await machine.console.releaseScreen()
        return machine.screen.text()
      })
      expect(!screen.graphical, 'DOS reported a graphical screen')
      expect(screen.lines.some(line => line.trimStart().startsWith('A:\\>')),
        `the console did not come back to the screen: ${JSON.stringify(screen.lines.slice(-4))}`)

      // A screenshot of a text screen is a real PNG.
      const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.shot())
      expect(shot.bytes > 1000 && shot.width > 100, `the screenshot is ${String(shot.bytes)} bytes at ${String(shot.width)}px`)

      const tools = await offeredTools(page)
      expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
      expect(!tools.includes('jsh'), `a DOS session was offered jsh: ${tools.join(', ')}`)
      expect(!tools.includes('bash'), `a DOS session was offered bash: ${tools.join(', ')}`)
      expect(tools.includes('dos'), `a DOS session was not offered the dos tool: ${tools.join(', ')}`)
      for (const wanted of ['vm_screen', 'vm_screenshot', 'vm_key', 'vm_type', 'vm_wait']) {
        expect(tools.includes(wanted), `${wanted} is missing: ${tools.join(', ')}`)
      }
      // And not the ones this guest has no working channel for. `vm_write_file`
      // because DOS's `COPY CON` wedges on a redirected console; `vm_mouse`
      // because a DOS prompt has never turned a mouse on, so the tool would
      // move nothing and cost a call to find that out.
      expect(!tools.includes('vm_write_file'), `a DOS session was offered vm_write_file: ${tools.join(', ')}`)
      expect(!tools.includes('vm_mouse'), `a DOS prompt with no mouse was offered vm_mouse: ${tools.join(', ')}`)
      process.stdout.write(`  tools: ${tools.join(', ')}\n`)
    },
  },

  {
    // The other DOS, and the reason this scenario exists: `CTTY COM1` works on
    // FreeDOS and *wedges* this guest — the console moves and then answers on
    // neither the screen nor the wire. So this one is typed at and read off its
    // screen, and nothing but booting it would have caught the difference. It
    // was shipped broken once because this scenario did not exist.
    name: 'msdos',
    async run(page) {
      await page.goto(`${url}?runtime=v86:msdos`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 180_000), 'MS-DOS 7 did not reach a prompt')

      const version = await run(page, 'ver', 60_000)
      expect(/MS-DOS 7/i.test(version.output),
        `\`ver\` did not name MS-DOS 7: ${JSON.stringify(version.output)}`)
      expect(!version.timedOut, 'a one-line command on the screen-driven guest timed out')

      // Short output is exact on this path, which is the promise the tool
      // description makes for it — and the whole of what it promises.
      const echoed = await run(page, 'echo dsh-was-here', 60_000)
      expect(echoed.output.trim() === 'dsh-was-here',
        `the screen-driven console did not return the line exactly: ${JSON.stringify(echoed.output)}`)

      // MS-DOS expands `%ERRORLEVEL%` to nothing — it is a CMD.EXE variable —
      // so this guest reports no status at all, and saying so is the point.
      expect(echoed.exitCode === null,
        `MS-DOS reported an exit status of ${String(echoed.exitCode)}; it has none to report`)

      const tools = await offeredTools(page)
      expect(tools.includes('dos'), `MS-DOS was not offered the dos tool: ${tools.join(', ')}`)
      expect(!tools.includes('jsh') && !tools.includes('bash'), `MS-DOS was offered a container shell: ${tools.join(', ')}`)
    },
  },

  {
    // The last of the five that need no setup. It only has to boot and draw:
    // there is no console to talk to and nothing else claims otherwise.
    name: 'kolibrios',
    async run(page) {
      await page.goto(`${url}?runtime=v86:kolibrios`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 180_000), 'KolibriOS did not reach a graphical mode')

      const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.shot())
      expect(shot.graphical && shot.width >= 640,
        `KolibriOS drew ${String(shot.width)}×${String(shot.height)}, graphical=${String(shot.graphical)}`)

      const tools = await offeredTools(page)
      expect(!tools.includes('jsh') && !tools.includes('sh') && !tools.includes('dos'),
        `a guest with no console was offered a command tool: ${tools.join(', ')}`)
    },
  },

  {
    // Linux: a real POSIX shell, so the workloads are the ones the container
    // suite runs — a loop, a pipeline, an exit status, a file written and run.
    name: 'linux',
    async run(page) {
      await page.goto(`${url}?runtime=v86:linux`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 180_000), 'the Linux guest did not reach a login prompt')

      const uname = await run(page, 'uname -sm')
      expect(uname.output.includes('Linux'), `\`uname\` said ${JSON.stringify(uname.output)}`)
      expect(uname.exitCode === 0, `\`uname\` reported exit ${String(uname.exitCode)}`)

      // The constructs `jsh` cannot do, which is the whole reason a serial
      // guest gets a differently-worded tool.
      const loop = await run(page, 'for i in 1 2 3; do echo "line $i"; done')
      expect(loop.output.includes('line 1') && loop.output.includes('line 3'),
        `the loop produced ${JSON.stringify(loop.output)}`)
      // Both halves matter: `jsh` expands `$(...)` to nothing and reports
      // success, so a check that only looked for `count=` would pass on the
      // shell this one exists to be different from.
      const substitution = await run(page, 'n=$(ls /bin | wc -l); echo "count=$n"')
      const counted = /count=(\d+)/.exec(substitution.output)
      expect(counted !== null && Number(counted[1]) > 10,
        `command substitution produced ${JSON.stringify(substitution.output)}`)
      const failing = await run(page, 'ls /definitely-not-here')
      expect(failing.exitCode !== null && failing.exitCode !== 0, 'a failing command reported success')

      // Output with no trailing newline. The completion marker is printed
      // straight after it, on the same line, and a reader that insisted the
      // marker start a line matched nothing — so `cat` of a file without a
      // final newline sat there until its timeout with the answer already on
      // the wire, and then reported the marker as part of the output. It is
      // the ordinary shape of `cat` on a file a program wrote, not an exotic
      // one, so it is checked on all three counts: the value, the absence of
      // the marker, and that it did not time out.
      const unterminated = await run(page, 'printf 5050 > /tmp/sum.txt; cat /tmp/sum.txt')
      expect(unterminated.output === '5050',
        `output with no trailing newline came back as ${JSON.stringify(unterminated.output)}`)
      expect(!unterminated.timedOut, 'a command whose output has no trailing newline ran to its timeout')
      expect(unterminated.exitCode === 0, `it reported exit ${String(unterminated.exitCode)}`)

      // A serial console is a terminal and a modern shell decorates one: Arch
      // colours its prompt and brackets every paste, so without stripping,
      // every result a model reads is wrapped in escape sequences and the
      // prompt detector stops recognising a prompt that ends in one. This
      // guest emits none of its own, so the command emits them instead.
      const coloured = await run(page, 'printf \'\\033[31mred\\033[0m and \\033[1mbold\\033[0m\\n\'')
      expect(coloured.output === 'red and bold',
        `control sequences survived into the output: ${JSON.stringify(coloured.output)}`)

      // Output that would not fit on a screen, and a multi-line script — the
      // second is delivered as one physical line, so a guest that echoed it
      // back over several would break the parser rather than the assertion.
      const long = await run(page, 'i=0; while [ $i -lt 120 ]; do echo "row $i"; i=$((i+1)); done')
      expect(long.output.split('\n').length >= 120, `expected 120 rows, got ${String(long.output.split('\n').length)}`)
      const script = await run(page, 'cat <<\'EOF\' > /tmp/hi.sh\necho "from a heredoc"\nexit 3\nEOF\nsh /tmp/hi.sh')
      expect(script.output.includes('from a heredoc'), `the heredoc did not run: ${JSON.stringify(script.output)}`)
      expect(script.exitCode === 3, `the script's exit status came back as ${String(script.exitCode)}`)

      // A file written through the console, with every character that would
      // break a hand-written quoting scheme in it, then run by the guest.
      const awkward = ['#!/bin/sh', 'echo \'single\' "double" \\backslash', 'echo $((6*7))', 'echo "tab:\tdone"'].join('\n')
      const written = await putFile(page, '/tmp/awkward.sh', awkward)
      expect(written.reported === written.expected,
        `the guest reported ${String(written.reported)} bytes for a ${String(written.expected)}-byte file`)
      const ran = await run(page, 'sh /tmp/awkward.sh')
      expect(ran.output.includes('single') && ran.output.includes('double') && ran.output.includes('backslash'),
        `the quoting did not survive: ${JSON.stringify(ran.output)}`)
      expect(ran.output.includes('42'), `the arithmetic did not survive: ${JSON.stringify(ran.output)}`)

      // The catalog says this guest has no network because its kernel finds no
      // card, and a claim in a tool description is worth exactly as much as the
      // check under it.
      const interfaces = await run(page, 'ls /sys/class/net')
      expect(!interfaces.output.includes('eth0'),
        `the bundled Linux was said to have no network device and has one: ${JSON.stringify(interfaces.output)}`)

      const tools = await offeredTools(page)
      expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
      expect(!tools.includes('jsh') && !tools.includes('bash'), `a Linux guest was offered a container shell: ${tools.join(', ')}`)
      expect(tools.includes('sh'), `the sh tool is missing: ${tools.join(', ')}`)
      expect(tools.includes('vm_write_file'), `vm_write_file is missing on a guest with a shell: ${tools.join(', ')}`)
      process.stdout.write(`  tools: ${tools.join(', ')}\n`)
    },
  },

  {
    /**
     * The machine's route out of the page.
     *
     * Buildroot rather than the bundled Linux, and that is the test as much as
     * the assertions are: the 2.6.34 kernel on `linux.iso` has no driver for
     * either card v86 emulates, which is why the catalog says so and why this
     * suite asks a machine that does. Everything here is a claim
     * `src/net/machine-network.ts` makes — a lease without anyone asking for
     * one, a host that refuses browsers reached anyway, a port stock v86 resets,
     * and TLS refused rather than hung.
     */
    name: 'network',
    async run(page) {
      await page.goto(`${url}?runtime=v86:buildroot`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 240_000), 'the Buildroot guest did not reach a shell')

      // The console asks for a lease while it attaches, so the first command a
      // model runs already finds an address. Checked first because everything
      // below fails uselessly without it.
      const address = await run(page, 'ip addr show eth0')
      expect(/inet 192\.168\.86\.\d+/.test(address.output),
        `the guest has no address: ${JSON.stringify(address.output)}`)

      // example.com sends no CORS headers of any kind, so this only works
      // because the page's own policy retried it through the configured proxy —
      // which is the whole difference between the machine's reach and the
      // container's.
      const fetched = await run(page, 'wget -q -O - http://example.com', 120_000)
      expect(fetched.output.includes('Example Domain'),
        'the guest could not fetch http://example.com through the page — this needs the CORS proxy in '
        + `Settings → Network to be answering. It said ${JSON.stringify(fetched.output.slice(0, 300))}`)

      // A port v86's own backend resets: this one is answered by the bridge in
      // `machine-network.ts` rather than by upstream. portquiz.net answers HTTP
      // on every port, which is what it exists for.
      const other = await run(page, 'wget -q -O - http://portquiz.net:8080/', 120_000)
      expect(/port|Outgoing/i.test(other.output),
        `a request to a non-80 port came back as ${JSON.stringify(other.output.slice(0, 300))}`)

      // TLS cannot terminate in a tab, so the connection is refused rather than
      // accepted and left silent — a hang is the failure mode this avoids.
      const tls = await run(page, 'telnet example.com 443', 60_000)
      expect(/refused/i.test(tls.output),
        `port 443 did not refuse promptly: ${JSON.stringify(tls.output.slice(0, 200))}`)

      // And the page's own account of all of it, which the settings page shows.
      const traffic = await page.evaluate(() => (globalThis as unknown as {
        __DSH_WEB_NETWORK__: { machine: { traffic(): { requests: { url: string, status?: number }[], refusedPorts: number[] } } }
      }).__DSH_WEB_NETWORK__.machine.traffic())
      expect(traffic.requests.some(entry => entry.url.includes('example.com') && entry.status === 200),
        `the page did not record the guest's request: ${JSON.stringify(traffic.requests.slice(-4))}`)
      expect(traffic.refusedPorts.includes(443),
        `the page did not record the refused TLS port: ${JSON.stringify(traffic.refusedPorts)}`)
      process.stdout.write(`  the machine made ${String(traffic.requests.length)} requests through the page\n`)
    },
  },

  {
    // Graphical, from the default image host: no command tool at all, and the
    // screen is the only thing there is to read.
    name: 'windows1',
    async run(page) {
      await page.goto(`${url}?runtime=v86:windows1`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 180_000), 'Windows 1.01 did not reach a graphical mode')

      const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.shot())
      expect(shot.graphical, 'Windows 1.01 reported a text screen')
      expect(shot.width >= 320 && shot.bytes > 2000,
        `the screenshot is ${String(shot.bytes)} bytes at ${String(shot.width)}×${String(shot.height)}`)

      // A graphical guest is not graphical the whole way up: it passes through
      // a text mode, and what it said there is the only readable account of
      // its own boot. Nothing else in this suite exercises that — the guest
      // that keeps a text screen never leaves one — so this is where the
      // transcript surviving a mode change is checked.
      const before = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.transcript())
      expect(before.some(line => line.includes('Booting from Floppy')),
        `the text the guest wrote before it went graphical is gone: ${JSON.stringify(before.slice(-6))}`)
      const live = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.text())
      expect(live.graphical, 'the screen reports a text mode while showing Windows')

      const tools = await offeredTools(page)
      expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
      expect(!tools.includes('jsh') && !tools.includes('sh') && !tools.includes('dos'),
        `a graphical guest was offered a command tool: ${tools.join(', ')}`)
      expect(tools.includes('vm_screenshot') && tools.includes('vm_key'), `the screen tools are missing: ${tools.join(', ')}`)
      // The other half of the rule the DOS scenario checks: this guest turned
      // its mouse on, so the pointer tool is there. `vm_screen` is there too,
      // and correctly — Windows 1.01 boots through DOS and writes to the text
      // screen on the way, so the tool has something to return.
      expect(tools.includes('vm_mouse'), `a guest with a pointer was not offered vm_mouse: ${tools.join(', ')}`)
      process.stdout.write(`  tools: ${tools.join(', ')}\n`)
    },
  },

  {
    // Windows 3.1, from a disk image opened the way a person opens one. This
    // is the path every proprietary guest takes, and it is the only one that
    // exercises the file input, the disk store, and a boot that reads its disk
    // out of IndexedDB rather than off the network.
    name: 'windows31',
    async run(page) {
      const image = await cachedImage('win31.img', 34_463_744)
      if (image === undefined) {
        throw new Skipped('no Windows 3.1 image on this machine, and the image host would not serve one')
      }

      await page.goto(`${url}?runtime=node`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      await openMachineSettings(page)
      // Pick the machine, then give it a disk. That order because the disk
      // controls live in the row you picked — a file input under every one of
      // a hundred and twenty-eight rows would bury the list.
      await page.getByRole('button', { name: /^Windows 3\.1/ }).first().click()
      await page.setInputFiles('input[aria-label="Disk image for Windows 3.1"]', image)
      await page.waitForFunction(
        () => document.body.innerText.includes('from this computer'),
        undefined,
        { timeout: 60_000 },
      )
      await page.getByRole('button', { name: 'Use this machine' }).click()

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      const status = await page.evaluate(() => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.status())
      expect(status.emulated && status.guest === 'windows31', `the reload came up as ${JSON.stringify(status)}`)
      expect(await ready(page, 240_000), 'Windows 3.1 did not reach Program Manager')

      const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.screen.shot())
      expect(shot.graphical && shot.width >= 640, `the screen is ${String(shot.width)}×${String(shot.height)}`)

      // Ctrl+Esc opens the Task List in every Windows of this era: a window
      // that was not there a moment ago, on a desktop that was otherwise still.
      await proveKeyboardReaches(page, 'Ctrl+Escape')

      const tools = await offeredTools(page)
      expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
      expect(!tools.includes('jsh') && !tools.includes('sh') && !tools.includes('dos'),
        `Windows 3.1 was offered a command tool: ${tools.join(', ')}`)
      // The tool that would answer every call with a blank screen is not
      // offered. This guest resumes into a desktop and writes nothing to the
      // text buffer, so `vm_screen` has nothing to return and never will —
      // which is what a person watching it return empty screens reported.
      expect(!tools.includes('vm_screen'), `a guest with no text screen was offered vm_screen: ${tools.join(', ')}`)
      expect(tools.includes('vm_mouse'), `a guest with a pointer was not offered vm_mouse: ${tools.join(', ')}`)
      process.stdout.write(`  tools: ${tools.join(', ')}\n`)
    },
  },

  {
    // Windows 98, from a host that serves the wider image set. This is the
    // other half of the "bring your own disk" story — a machine whose disk is
    // published in pieces cannot be a file, so it has to be a host — and it is
    // the newest guest here, which makes it the slowest thing the emulator is
    // asked to do.
    name: 'windows98',
    async run(page) {
      const images = await startImageHost()
      try {
        // Asked for before the panel is touched, so a host having a bad day is
        // a reported skip rather than a browser waiting out five minutes on a
        // disk that is never coming. Windows 3.1 takes the same shape at the
        // top of its own scenario, for the same reason.
        const reachable = await fetch(`${images.origin}windows98_state-v2.bin.zst`)
          .then(async (answer) => {
            // Drained, not just checked: the fixture caches what it fetched, so
            // this doubles as the prefetch the boot would have done anyway.
            await answer.arrayBuffer().catch(() => undefined)
            return answer.ok
          }, () => false)
        if (!reachable) throw new Skipped('the image host would not serve Windows 98\'s saved machine')

        await page.goto(`${url}?runtime=node`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await waitForShell(page)
        await openMachineSettings(page)
        const field = page.getByLabel('Image host')
        await field.fill(images.origin)
        await page.getByRole('button', { name: /^Windows 98/ }).first().click()
        await page.getByRole('button', { name: 'Use this machine' }).click()
        const host = await page.evaluate(() => localStorage.getItem('dsh-web:v86-image-host'))
        expect(host === images.origin, `the image host was stored as ${String(host)}`)

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await waitForShell(page)
        expect(await ready(page, 300_000), 'Windows 98 did not reach its desktop')

        const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
          .__DSH_WEB_MACHINE__.screen.shot())
        expect(shot.graphical && shot.width >= 640, `the screen is ${String(shot.width)}×${String(shot.height)}`)
        expect(shot.bytes > 5000, `a Windows 98 desktop compressed to ${String(shot.bytes)} bytes, which is a blank screen`)

        // Ctrl+Esc opens the Start menu — proof the keyboard reaches a guest
        // that resumed from a saved machine rather than booting into one.
        await proveKeyboardReaches(page, 'Ctrl+Escape')

        const tools = await offeredTools(page)
        expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
        expect(!tools.includes('jsh') && !tools.includes('sh') && !tools.includes('dos'),
          `Windows 98 was offered a command tool: ${tools.join(', ')}`)
        process.stdout.write(`  tools: ${tools.join(', ')}\n`)
      } finally {
        await images.close()
      }
    },
  },

  {
    // One panel, one size, whatever is running in it.
    //
    // Every guest here draws at its own resolution — a DOS text mode is
    // 720×400, KolibriOS comes up at 800×600 — and a panel that showed each at
    // its native size was a different panel per machine: one filling the box,
    // the next a stamp in the corner of it. So the screen is fitted to the
    // panel, and this is the check that it is: same box for both guests,
    // aspect ratio intact, and neither of them left small.
    name: 'pointer-and-dock',
    async run(page) {
      await page.setViewportSize({ width: 1440, height: 900 })
      // Windows 3.1 and not KolibriOS, for one reason: Program Manager sits
      // perfectly still. Half of what is under test here is a *negative* — that
      // the guest's cursor does not move — and the only instrument for that is
      // whether the picture changed, which is useless on a desktop that redraws
      // itself. KolibriOS swings by thirty kilobytes a second with nothing
      // touching it; this one is byte-identical at rest, measured below rather
      // than assumed.
      await page.goto(`${url}?runtime=v86:windows31`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      expect(await ready(page, 240_000), 'Windows 3.1 did not come up')
      await openMachinePanel(page)
      // The desktop enables its mouse a moment after it is drawn.
      await page.waitForTimeout(4000)

      /** What the panel is showing about the pointer. */
      const cursor = async (): Promise<{ owned: boolean, cursor: string, hint: string }> => page.evaluate(() => {
        const screen = document.querySelector('.dsh-web-machine-screen')
        if (!(screen instanceof HTMLElement)) throw new Error('the machine panel is not showing a screen')
        return {
          owned: screen.hasAttribute('data-owned'),
          cursor: getComputedStyle(screen).cursor,
          hint: document.querySelector('.dsh-web-machine-hint')?.textContent ?? '',
        }
      })

      // A guest with a PS/2 mouse: the host's cursor is still the host's,
      // because the two would not agree about where it is.
      const relative = await cursor()
      expect(!relative.owned && relative.cursor !== 'none',
        `a relative-pointer guest hid the host cursor (${relative.cursor})`)
      expect(/Click the screen to hand it over/.test(relative.hint),
        `the panel does not offer the mouse to a guest that has one: "${relative.hint}"`)

      const box = await page.locator('.dsh-web-machine-screen').boundingBox()
      expect(box !== null, 'the screen has no box to click')
      const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }

      /** Drag the real mouse across the screen and say whether anything moved. */
      const sweep = async (): Promise<boolean> => {
        const before = await shotBytes(page)
        for (let step = 0; step < 6; step += 1) {
          await page.mouse.move(centre.x - 240 + step * 90, centre.y - 140 + step * 55, { steps: 8 })
          await page.waitForTimeout(120)
        }
        await page.waitForTimeout(900)
        return before !== await shotBytes(page)
      }

      // The instrument, before it is trusted: this desktop does not redraw
      // itself, so a changed picture below means the mouse changed it.
      const rest: number[] = []
      for (let sample = 0; sample < 4; sample += 1) {
        rest.push(await shotBytes(page))
        await page.waitForTimeout(800)
      }
      expect(new Set(rest).size === 1,
        `this guest's screen moves on its own (${rest.join(', ')}), so it cannot measure a still cursor`)

      // Nobody asked. Moving the real mouse over the panel — on the way to
      // something else, most likely — must not drag the guest's cursor around
      // with it.
      expect(!await sweep(), 'the guest\'s cursor followed the mouse without being given it')
      expect((await pointerState(page)).held === false, 'the guest is being given pointer input it was not offered')

      // Clicking hands it over. Pointer lock is what makes the two cursors one:
      // the browser takes the host's away and delivers raw movement.
      await page.mouse.click(centre.x, centre.y)
      await page.waitForTimeout(1200)
      expect(await page.evaluate(() => document.pointerLockElement !== null),
        'clicking the screen did not take the pointer')
      const held = await cursor()
      expect(held.owned && held.cursor === 'none',
        `the host cursor is still showing under pointer lock (${held.cursor})`)
      expect((await pointerState(page)).held, 'the pointer was taken but the guest was not given it')

      // And now it is receiving the movement, which is the point of taking it.
      expect(await sweep(), 'the guest did not react to the mouse while it had it')

      // Letting go stops it again — and the model's own mouse keeps working
      // either way, which is the thing this could most easily have broken.
      await page.evaluate(() => { document.exitPointerLock() })
      await page.waitForTimeout(800)
      expect((await pointerState(page)).held === false, 'the guest kept the mouse after the pointer was released')
      const parked = await shotBytes(page)
      await page.evaluate(async () => {
        const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
        for (let step = 0; step < 12; step += 1) await machine.input.mouse(40, 24)
      })
      await page.waitForTimeout(900)
      expect(parked !== await shotBytes(page), 'the model\'s mouse tool stopped working when the person let go')

      // The other way to one cursor, which is the guest's to choose and not
      // this panel's: a driver that reads the VMware backdoor port is told
      // where the pointer is rather than how far it moved, so its cursor is
      // already under the real one and the real one is redundant. None of the
      // machines reachable without a disk of your own has that driver, so the
      // fact is supplied rather than waited for — what is under test is the
      // panel's response to it.
      await page.evaluate(() => { document.exitPointerLock() })
      await page.waitForTimeout(600)
      await setPointer(page, { enabled: true, absolute: true })
      const absolute = await cursor()
      expect(absolute.owned && absolute.cursor === 'none',
        `a guest drawing its own aligned cursor left the host's showing (${absolute.cursor})`)

      // A guest with no mouse at all gets neither treatment.
      await setPointer(page, { enabled: false, absolute: false })
      const none = await cursor()
      expect(!none.owned && none.cursor !== 'none',
        `a guest with no pointer hid the host cursor (${none.cursor})`)

      /** Where the panel sits, and how big. */
      const dock = async (): Promise<{ x: number, y: number, width: number, height: number }> => page.evaluate(() => {
        const panel = document.querySelector('.dsh-web-machine')
        if (!(panel instanceof HTMLElement)) throw new Error('the machine panel is not in the document')
        const shape = panel.getBoundingClientRect()
        return { x: shape.x, y: shape.y, width: shape.width, height: shape.height }
      })

      // A window with width to spare: a full-height column on the right, so
      // the conversation stays readable beside it.
      const wide = await dock()
      expect(wide.x > 100 && wide.height >= 898,
        `on a 1440×900 window the panel is ${JSON.stringify(wide)}, which is not a right-hand column`)

      // A window with none: a drawer along the bottom, because a column in a
      // portrait window is a column of nothing.
      await page.setViewportSize({ width: 720, height: 1280 })
      await page.waitForTimeout(1200)
      const tall = await dock()
      expect(tall.x < 2 && tall.width >= 718 && tall.y > 100,
        `on a 720×1280 window the panel is ${JSON.stringify(tall)}, which is not a bottom drawer`)

      // The colours are the surface's, not a dark literal: this panel used to
      // be the one surface in the app that stayed black when the theme went
      // light. The way it is no longer is that nothing here names a colour.
      const painted = await page.evaluate(() => {
        const panel = document.querySelector('.dsh-web-machine')
        if (!(panel instanceof HTMLElement)) throw new Error('no panel to read')
        return { panel: getComputedStyle(panel).backgroundColor, page: getComputedStyle(document.body).backgroundColor }
      })
      expect(painted.panel === painted.page,
        `the panel is painted ${painted.panel} on a page painted ${painted.page}`)
    },
  },

  {
    name: 'screen-fit',
    async run(page) {
      /** Measure the panel, the stage, and the screen inside it. */
      const measure = async (): Promise<{
        stage: { width: number, height: number }
        visual: { width: number, height: number }
        natural: { width: number, height: number }
      }> => page.evaluate(() => {
        const stage = document.querySelector('.dsh-web-machine-stage')
        const scaler = document.querySelector('.dsh-web-machine-screen')
        const screen = scaler?.firstElementChild
        if (!(stage instanceof HTMLElement) || !(scaler instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
          throw new Error('the machine panel is not showing a screen')
        }
        // The visual size is the scaled rectangle; the natural size is what the
        // guest actually draws, read with the transform lifted for one frame.
        const visual = screen.getBoundingClientRect()
        const applied = scaler.style.transform
        scaler.style.transform = 'none'
        const natural = screen.getBoundingClientRect()
        scaler.style.transform = applied
        return {
          stage: { width: stage.clientWidth, height: stage.clientHeight },
          visual: { width: visual.width, height: visual.height },
          natural: { width: natural.width, height: natural.height },
        }
      })

      const seen: Record<string, { stage: { width: number, height: number }, visual: { width: number, height: number }, natural: { width: number, height: number } }> = {}
      // Two guests whose native screens are different shapes: a DOS text mode
      // and a graphical desktop. If the fit were native-size passthrough, these
      // two would disagree about everything below.
      for (const guest of ['freedos', 'kolibrios']) {
        process.stdout.write(`  ${guest}: loading\n`)
        await page.goto(`${url}?runtime=v86:${guest}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await waitForShell(page)
        process.stdout.write(`  ${guest}: shell up\n`)
        expect(await ready(page, 120_000), `${guest} did not come up`)
        process.stdout.write(`  ${guest}: machine ready\n`)
        await openMachinePanel(page)
        process.stdout.write(`  ${guest}: panel open\n`)
        // The fit runs on a resize observation, which is a frame away.
        await page.waitForTimeout(1200)
        const shape = await measure()
        seen[guest] = shape

        expect(shape.natural.width > 1 && shape.natural.height > 1,
          `${guest} reports a ${String(shape.natural.width)}×${String(shape.natural.height)} screen`)
        // Inside the box, on both axes. One pixel of slack for the rounding a
        // fractional scale leaves behind.
        expect(shape.visual.width <= shape.stage.width + 1 && shape.visual.height <= shape.stage.height + 1,
          `${guest}'s screen is ${String(Math.round(shape.visual.width))}×${String(Math.round(shape.visual.height))} `
          + `in a ${String(shape.stage.width)}×${String(shape.stage.height)} panel`)
        // And filling it on at least one axis, which is what "fitted" means as
        // opposed to "happens to be smaller".
        const fills = shape.visual.width >= shape.stage.width - 2 || shape.visual.height >= shape.stage.height - 2
        expect(fills, `${guest}'s screen fills neither axis of the panel `
          + `(${String(Math.round(shape.visual.width))}×${String(Math.round(shape.visual.height))} `
          + `in ${String(shape.stage.width)}×${String(shape.stage.height)})`)
        // Aspect ratio intact: a fit that stretched would fill both axes and
        // pass the check above while showing a distorted machine.
        const before = shape.natural.width / shape.natural.height
        const after = shape.visual.width / shape.visual.height
        expect(Math.abs(before - after) < 0.02,
          `${guest}'s screen was stretched from ${before.toFixed(3)} to ${after.toFixed(3)}`)
      }

      // The same panel for both, which is the whole claim.
      expect(seen.freedos.stage.width === seen.kolibrios.stage.width
        && seen.freedos.stage.height === seen.kolibrios.stage.height,
      `the panel is ${String(seen.freedos.stage.width)}×${String(seen.freedos.stage.height)} for FreeDOS `
      + `and ${String(seen.kolibrios.stage.width)}×${String(seen.kolibrios.stage.height)} for KolibriOS`)
      expect(
        seen.freedos.natural.width !== seen.kolibrios.natural.width
        || seen.freedos.natural.height !== seen.kolibrios.natural.height,
        'both guests draw the same native resolution, so this scenario proves nothing — pick two that differ',
      )

      // Full screen: the same fit against the whole display. Chromium grants
      // this from a real click, which is what the button below receives.
      await page.locator('.dsh-web-machine-overlay button').click()
      await page.waitForTimeout(1500)
      const full = await page.evaluate(() => document.fullscreenElement !== null)
      expect(full, 'the full-screen button did not put the stage full screen')
      const enlarged = await measure()
      expect(enlarged.stage.height > seen.kolibrios.stage.height,
        `full screen left the stage at ${String(enlarged.stage.height)}px`)
      expect(enlarged.visual.width <= enlarged.stage.width + 1 && enlarged.visual.height <= enlarged.stage.height + 1,
        'the screen did not re-fit to the full-screen stage')
      expect(enlarged.visual.width > seen.kolibrios.visual.width,
        'the screen did not grow when the stage did')
      // Out again through the app's own affordance rather than through Escape:
      // leaving full screen on Escape is the browser's chrome doing it, and a
      // headless shell has none — so that would test the harness, not this.
      await page.locator('.dsh-web-machine-overlay button').click()
      await page.waitForTimeout(1200)
      expect(await page.evaluate(() => document.fullscreenElement === null),
        'the button did not bring the stage back out of full screen')
      const restored = await measure()
      expect(restored.stage.height === seen.kolibrios.stage.height,
        `the panel came back at ${String(restored.stage.height)}px instead of ${String(seen.kolibrios.stage.height)}px`)
    },
  },

  // Every remaining guest, booted from the mirror fixture.
  //
  // The catalog claims seventeen machines and the fast suite proves seven of
  // them. The other ten are the ones this deployment cannot serve a disk for,
  // which is a licensing fact and not a support one — given the disk they boot
  // exactly like the rest — and the difference between "supported" and "listed"
  // is whether anything has ever checked. This checks. Each one gets its own
  // scenario so a failure names the machine, and the readiness marker is the
  // guest's own, from the catalog.
  ...(['msdos622', 'windows2', 'windows30', 'windows95', 'windowsme', 'windowsnt4', 'windows2000', 'buildroot', 'archlinux'] as const)
    .map((guest): Scenario => ({
      name: guest,
      slow: true,
      async run(page) {
        const images = await startImageHost()
        try {
          await page.goto(`${url}?runtime=node`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          await waitForShell(page)
          await openMachineSettings(page)
          await page.getByLabel('Image host').fill(images.origin)
          // The setting is what writes the image host; the URL is what pins
          // the machine for one load, which keeps each scenario independent of
          // whatever the last one chose.
          await page.getByRole('button', { name: 'Save image host' }).click()
          const host = await page.evaluate(() => localStorage.getItem('dsh-web:v86-image-host'))
          expect(host === images.origin, `the image host was stored as ${String(host)}`)

          await page.goto(`${url}?runtime=v86:${guest}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          await waitForShell(page)
          const status = await page.evaluate(() => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
            .__DSH_WEB_MACHINE__.status())
          expect(status.emulated && status.guest === guest, `the load came up as ${JSON.stringify(status)}`)
          expect(await ready(page, 420_000), `${guest} never reached its own readiness marker`)

          // Ready is a marker; a screen with something on it is the machine.
          const shot = await page.evaluate(async () => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
            .__DSH_WEB_MACHINE__.screen.shot())
          expect(shot.width > 0 && shot.height > 0, `${guest} has no screen: ${JSON.stringify(shot)}`)
          process.stdout.write(`  screen ${String(shot.width)}×${String(shot.height)}`
            + `${shot.graphical ? ' graphical' : ' text'}, ${String(shot.bytes)} bytes\n`)

          const tools = await offeredTools(page)
          expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
          process.stdout.write(`  tools: ${tools.join(', ')}\n`)
        } finally {
          await images.close()
        }
      },
    })),

  {
    // A machine whose disk this deployment cannot get must say so before it
    // starts, not after.
    //
    // What it used to do was accept the choice, reload, print "Fetching
    // Windows 3.1 (33 MB)", and then fail several seconds later with a 404
    // naming a CDN path — a message that is true, useless, and gives no hint
    // that the answer is a file input two clicks away. The catalog knows which
    // guests the default host serves, so the refusal is decidable up front.
    name: 'missing-disk',
    async run(page) {
      await page.goto(`${url}?runtime=v86:windows2000`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      const failure = await page.evaluate(async () => {
        const machine = (globalThis as unknown as {
          __DSH_WEB_MACHINE__: { boot(): Promise<void>, status(): { failure?: string } }
        }).__DSH_WEB_MACHINE__
        try {
          await machine.boot()
          return { threw: false, message: '' }
        } catch (error) {
          return { threw: true, message: error instanceof Error ? error.message : String(error) }
        }
      })
      expect(failure.threw, 'a guest with no disk anywhere started anyway')
      // It has to name the file, and it has to name the way out. A message
      // that only says "failed" sends the reader to the network tab.
      expect(/windows2k/.test(failure.message),
        `the refusal does not name the file it needs: ${failure.message}`)
      expect(/Settings/.test(failure.message) && /image host/.test(failure.message),
        `the refusal does not say what to do about it: ${failure.message}`)
      // And nothing was fetched to find that out.
      const requested: string[] = []
      page.on('request', request => requested.push(request.url()))
      await page.waitForTimeout(1500)
      expect(!requested.some(request => /copy\/images|i\.copy\.sh/.test(request)),
        `the refusal still went to the network: ${requested.join(', ')}`)
    },
  },

  {
    // The way back. A runtime that could be chosen and not un-chosen would be
    // a trap, and the container half has to be exactly what it was before.
    name: 'container',
    async run(page) {
      // Every request this page load makes, so the claim that an unselected
      // emulator costs nothing is a measurement rather than an assurance.
      const requested: string[] = []
      page.on('request', request => requested.push(request.url()))

      await page.goto(`${url}?runtime=node`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForShell(page)
      await page.waitForTimeout(4000)
      const emulator = requested.filter(request => /libv86|\/v86\/|i\.copy\.sh|copy\/images/.test(request))
      expect(emulator.length === 0,
        `a session on the container fetched the emulator anyway: ${emulator.join(', ')}`)
      const status = await page.evaluate(() => (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle })
        .__DSH_WEB_MACHINE__.status())
      expect(!status.emulated, 'the container session reports itself as emulated')

      const result = await page.evaluate(async () => globalThis.dsh.shell('node -e "console.log(2+3)"'))
      expect(result.stdout.includes('5'), `the container did not run Node: ${JSON.stringify(result)}`)

      const tools = await offeredTools(page)
      expect(tools.length > 0, 'the turn sent no request, so the offered tools could not be read')
      expect(tools.includes('jsh'), `the container session was not offered jsh: ${tools.join(', ')}`)
      expect(!tools.some(name => name.startsWith('vm_')), `the container session was offered machine tools: ${tools.join(', ')}`)
    },
  },
]

const browser = await chromium.launch({ headless: !headed })
let failures = 0
let ran = 0
const skipped: string[] = []
for (const scenario of scenarios) {
  if (only !== undefined && scenario.name !== only) continue
  if (scenario.slow === true && !all && only === undefined) continue
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(`
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
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  process.stdout.write(`▶ ${scenario.name}\n`)
  ran++
  const started = Date.now()
  try {
    await scenario.run(page)
    process.stdout.write(`✔ ${scenario.name} (${String(Math.round((Date.now() - started) / 1000))}s)\n`)
  } catch (error) {
    if (error instanceof Skipped) {
      skipped.push(`${scenario.name}: ${error.message}`)
      process.stdout.write(`⊘ ${scenario.name} — skipped: ${error.message}\n`)
    } else {
      failures++
      process.stdout.write(`✘ ${scenario.name}: ${error instanceof Error ? error.message : String(error)}\n`)
      if (errors.length > 0) process.stdout.write(`    page errors:\n      ${errors.join('\n      ')}\n`)
      await page.screenshot({ path: `/tmp/dshw-v86-${scenario.name}.png` }).catch(() => undefined)
    }
  }
  await context.close()
}
await browser.close()

if (failures > 0) {
  process.stdout.write(`\n${String(failures)} scenario(s) failed\n`)
  process.exit(1)
}
// A `--case` that names nothing is a typo, and reporting it as a clean run is
// how a check gets silently retired.
if (ran === 0) {
  process.stdout.write(`\nno scenario matched ${String(only)}; the suite has ${scenarios.map(s => s.name).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write(skipped.length === 0
  ? `\nall ${String(ran)} scenarios passed\n`
  : `\n${String(ran - skipped.length)} passed, ${String(skipped.length)} skipped:\n  ${skipped.join('\n  ')}\n`)
