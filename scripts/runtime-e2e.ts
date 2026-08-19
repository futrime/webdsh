/**
 * Real-workload test for the runtime.
 *
 * The runtime is only worth having if it does the things a developer machine is
 * for, so this does them: runs modern Node, installs a package from the registry
 * and imports it, runs a package script, uses the shell, and — the part that
 * matters most — checks that the agent and the terminal are the same machine
 * rather than two that look alike.
 *
 * The shell here is the container's own `jsh`, because `@dsh-web/jsh` is
 * composed — so the workloads are written the way that plugin's tool
 * description tells a model to write them, and a workload that needed a `for`
 * loop would be testing the description as much as the runtime.
 *
 * It drives the terminal rather than calling the runtime directly, because the
 * terminal is what a user has.
 *
 * Usage: `npx tsx scripts/runtime-e2e.ts [--url <url>] [--headed]`
 */

import { chromium, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Assert a condition, failing with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Wait until the app's own boot screen is gone. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getElementById('dshw-boot') === null, undefined, { timeout: 180_000 })
}

/**
 * Open the terminal through the plugin's own sidebar action.
 *
 * The surface shows its notice over everything until it is acknowledged, and a
 * click that lands on that mask never reaches the button — so the notice is
 * dismissed first and the action is invoked on the element itself.
 * @param page - the page to drive.
 */
async function openTerminal(page: Page): Promise<void> {
  const acknowledge = page.getByRole('button', { name: /Continue/ })
  await acknowledge.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
  if (await acknowledge.count() > 0) {
    await acknowledge.first().click().catch(() => undefined)
    await acknowledge.first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  }
  const action = page.getByRole('button', { name: /Terminal/ })
  await action.first().waitFor({ state: 'visible', timeout: 30_000 })
  await action.first().evaluate((node: HTMLElement) => { node.click() })
}

/** Everything the terminal currently shows. */
async function screen(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? '')
}

/**
 * Run one command in the VM and wait for its sentinel.
 *
 * A shell prompt is not a reliable "finished" signal — it appears in the middle
 * of output as often as at the end. Echoing a unique marker afterwards is, and
 * it also carries the exit status back.
 *
 * The marker carries the status as `$?`, so the echo of the typed line cannot be
 * mistaken for the result: the command line shows `$?` literally, and only the
 * output has a digit in that position.
 * @param page - the page driving the terminal.
 * @param script - the shell source to run.
 * @param timeoutMs - how long the command may take.
 * @returns everything the terminal printed for this command.
 */
async function run(page: Page, script: string, timeoutMs = 420_000): Promise<string> {
  const marker = `__done_${Math.floor(performance.now())}_${String(counter++)}`
  await page.evaluate(
    ([source, sentinel]) => {
      const terminal = (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__
      terminal?.send(`${source}; echo ${sentinel}:$?\n`)
    },
    [script, marker] as const,
  )
  await page.waitForFunction(
    (sentinel: string) => {
      const text = (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''
      return new RegExp(`${sentinel}:\\d`).test(text)
    },
    marker,
    { timeout: timeoutMs },
  )
  // The emulator's buffer is a fixed grid whose earlier lines scroll away, so
  // anchoring on the echoed command is unreliable: a long line wraps, and a
  // noisy command can push its own echo out of view entirely. The marker is the
  // one anchor that is always present, so the window is measured back from it.
  const after = await screen(page)
  const lines = after.split('\n')
  const end = lines.findLastIndex(line => new RegExp(`${marker}:\\d`).test(line))
  if (end === -1) return lines.slice(-40).join('\n')
  return lines.slice(Math.max(0, end - 40), end + 1).join('\n')
}

let counter = 0

/** One workload: what to run, and what its output must contain. */
interface Workload {
  name: string
  script: string
  expect: RegExp
  timeoutMs?: number
}

const WORKLOADS: Workload[] = [
  { name: 'identity', script: 'node -p "[process.version, process.arch, process.platform].join(\' \')"', expect: /v\d+\.\d+.* x64 linux/ },
  { name: 'the shell is jsh', script: 'bash --version', expect: /jsh \d/ },
  { name: 'shell', script: 'pwd; echo shell-ok', expect: /shell-ok/ },
  { name: 'files', script: 'mkdir -p sub && echo written > sub/f.txt && cat sub/f.txt', expect: /written/ },
  {
    name: 'node runs a program',
    script: 'node -e "console.log(\'sum\', [1,2,3].reduce((a,b)=>a+b,0))"',
    expect: /sum 6/,
  },
  {
    name: 'npm install from the registry',
    script: 'npm init -y > /dev/null; npm install is-odd 2>&1 | tail -n 3',
    expect: /added \d+ package/,
    timeoutMs: 300_000,
  },
  {
    name: 'the installed package is importable',
    script: 'node -e "import(\'is-odd\').then(m => console.log(\'is-odd(3) =\', m.default(3)))"',
    expect: /is-odd\(3\) = true/,
  },
  {
    name: 'npm run',
    script: `node -e "const p=require('./package.json'); p.scripts={say:'echo script-ran'}; require('fs').writeFileSync('package.json', JSON.stringify(p))" && npm run say 2>&1 | tail -n 3`,
    expect: /script-ran/,
    timeoutMs: 180_000,
  },
  {
    name: 'esm and async',
    script: `node --input-type=module -e "const {setTimeout:sleep}=await import('node:timers/promises'); await sleep(10); console.log('esm-ok')"`,
    expect: /esm-ok/,
  },
  {
    // CPython, not the RustPython the container ships: `pathlib` is one of the
    // things that told the two apart, and `sys.version` is the other.
    name: 'python is CPython',
    script: 'python3 -c "import sys, json, pathlib; print(json.dumps({\'py\': sys.version_info[:2], \'here\': str(pathlib.Path(\'.\').resolve())}))"',
    expect: /\{"py": \[3, 1[4-9]\], "here": "\/home\/dsh\/workspace"\}/,
    timeoutMs: 180_000,
  },
  {
    // The other half of a working Python: a package from PyPI, installed and
    // then imported by a *different* process, which is what proves it landed on
    // the machine rather than in one interpreter's memory.
    name: 'pip installs from PyPI',
    script: 'pip install six 2>&1 | tail -n 2 && python3 -c "import six; print(\'six\', six.__version__)"',
    expect: /six 1\./,
    timeoutMs: 300_000,
  },
  {
    name: 'workspace write',
    script: 'echo persisted-by-runtime > marker.txt && cat marker.txt',
    expect: /persisted-by-runtime/,
  },
  // What jsh does, checked through the terminal a person actually types into —
  // the same shell the agent's tool calls reach, which is the point.
  {
    name: 'command substitution expands to nothing',
    script: 'echo "sub=[$(echo inner)]"',
    expect: /sub=\[\]/,
  },
  {
    name: 'a session keeps its state',
    // Restores the directory it moved out of: the session really does keep its
    // state, so a workload that wanders leaves every later one somewhere else.
    script: 'mkdir -p sess && cd sess && export MARK=kept && echo "$MARK in sess"; cd ..',
    expect: /kept in sess/,
  },
]


/** Run everything. */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(String(error)) })

  let failures = 0
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForShell(page)
    await page.waitForTimeout(1500)

    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
    expect(isolated, 'the page is not cross-origin isolated, so the runtime cannot start')
    process.stdout.write('▶ cross-origin isolated\n  ✓\n')

    process.stdout.write('▶ boot\n')
    const started = Date.now()
    await openTerminal(page)
    await page.waitForFunction(
      () => /[❯$]\s*$/m.test((globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''),
      undefined,
      { timeout: 300_000 },
    )
    process.stdout.write(`  ✓ shell ready in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

    for (const workload of WORKLOADS) {
      process.stdout.write(`▶ ${workload.name}\n`)
      try {
        const output = await run(page, workload.script, workload.timeoutMs)
        expect(workload.expect.test(output), `${workload.name}: unexpected output\n${output.slice(-900)}`)
        process.stdout.write('  ✓\n')
      } catch (error) {
        failures++
        process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }

    // Closing a terminal and opening it again used to give back an empty panel:
    // the element was unmounted, which disposed the emulator, while the guard
    // that stops it being built twice stayed set. A terminal that loses your
    // session when you glance away is not one you can work in, and nothing
    // above notices — every workload runs in the first session.
    process.stdout.write('▶ the session survives being closed\n')
    try {
      await run(page, 'echo before-the-close > closed.txt')
      const action = page.getByRole('button', { name: 'Terminal', exact: true })
      await action.first().evaluate((node: HTMLElement) => { node.click() })
      await page.waitForTimeout(1000)
      await action.first().evaluate((node: HTMLElement) => { node.click() })
      await page.waitForTimeout(2000)
      // Read the *rendered rows*, not the emulator's buffer. A disposed
      // emulator still answers `text()` from the object the closure holds, so
      // the buffer was green while the panel on screen was empty — which is
      // how the first version of this check passed against the bug it was
      // written for.
      const painted = await page.evaluate(() =>
        document.querySelector('.dsh-web-terminal .xterm-rows')?.textContent ?? '(nothing rendered)')
      expect(/before-the-close/.test(painted), `the reopened terminal drew nothing: ${painted.slice(0, 200)}`)
      const visible = await page.evaluate(() => {
        const panel = document.querySelector('.dsh-web-terminal')
        return panel === null ? 'absent' : getComputedStyle(panel).display
      })
      expect(visible !== 'none' && visible !== 'absent', `the panel is not showing: ${visible}`)
      const after = await run(page, 'cat closed.txt')
      expect(/before-the-close/.test(after), `the session did not survive being closed:\n${after.slice(-400)}`)
      process.stdout.write('  ✓\n')
    } catch (error) {
      failures++
      process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    }

    // The point of running the agent in the runtime: what the terminal writes,
    // the agent reads, and the reverse. Two machines that merely look alike
    // would pass every test above and fail both of these.
    process.stdout.write('▶ the agent sees the terminal\'s files\n')
    try {
      await run(page, 'echo from-the-terminal > shared.txt')
      const seen = await page.evaluate(async () =>
        (await globalThis.dsh.shell('cat shared.txt')).stdout)
      expect(/from-the-terminal/.test(seen), `the agent cannot see the terminal's file: ${seen}`)
      process.stdout.write('  ✓\n')
    } catch (error) {
      failures++
      process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    }

    process.stdout.write('▶ the terminal sees the agent\'s files\n')
    try {
      await page.evaluate(async () =>
        globalThis.dsh.shell('echo from-the-agent > from-agent.txt'))
      const output = await run(page, 'cat from-agent.txt')
      expect(/from-the-agent/.test(output), `the terminal cannot see the agent's file:\n${output.slice(-400)}`)
      process.stdout.write('  ✓\n')
    } catch (error) {
      failures++
      process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    }

    await page.screenshot({ path: '/tmp/dsh-runtime-workload.png' })
  } finally {
    await browser.close()
  }

  if (errors.length > 0) process.stdout.write(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}\n`)
  process.stdout.write(failures === 0 ? '\n✓ the runtime works\n' : `\n✗ ${String(failures)} workload(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
