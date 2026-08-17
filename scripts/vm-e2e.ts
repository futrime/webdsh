/**
 * Real-workload test for the virtual machine.
 *
 * The VM is only worth having if it does the things a machine is for, so this
 * does them: compiles a C program, runs Python and Node, initialises a git
 * repository and commits to it, exercises the busybox applet set, and checks
 * that what it writes survives a page reload — the last one being the whole
 * point of the IndexedDB overlay.
 *
 * It drives the terminal rather than calling the engine directly, because the
 * terminal is what a user has.
 *
 * Usage: `npx tsx scripts/vm-e2e.ts [--url <url>] [--headed]`
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

/** Everything the terminal currently shows. */
async function screen(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as { dsh?: { terminal?: { text(): string } } }).dsh?.terminal?.text() ?? '')
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
      const terminal = (globalThis as { dsh?: { terminal?: { send(text: string): void } } }).dsh?.terminal
      terminal?.send(`${source}; echo ${sentinel}:$?\n`)
    },
    [script, marker] as const,
  )
  await page.waitForFunction(
    (sentinel: string) => {
      const text = (globalThis as { dsh?: { terminal?: { text(): string } } }).dsh?.terminal?.text() ?? ''
      return new RegExp(`${sentinel}:\\d`).test(text)
    },
    marker,
    { timeout: timeoutMs },
  )
  // Slicing by character offset would be unreliable: the emulator's buffer is a
  // fixed grid whose earlier lines scroll away. The command's own output is what
  // sits between the line it was typed on and the marker.
  const after = await screen(page)
  const lines = after.split('\n')
  const end = lines.findIndex(line => new RegExp(`${marker}:\\d`).test(line))
  const start = lines.findIndex(line => line.includes(marker))
  return lines
    .slice(start === -1 ? Math.max(0, lines.length - 40) : start, end === -1 ? undefined : end + 1)
    .join('\n')
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
  { name: 'identity', script: 'uname -m; whoami; pwd', expect: /i386[\s\S]*dsh[\s\S]*\/home\/dsh\/workspace/ },
  { name: 'debian cli', script: 'ls /usr/bin | wc -l', expect: /\d{3,}/ },
  {
    name: 'busybox',
    script: 'busybox | head -1; busybox ash -c "echo busybox-shell-ok"',
    expect: /BusyBox v1[\s\S]*busybox-shell-ok/,
  },
  { name: 'coreutils pipeline', script: 'printf "c\\na\\nb\\n" | sort | tr "\\n" "," ', expect: /a,b,c,/ },
  { name: 'awk + sed', script: `printf '1 2\\n3 4\\n' | awk '{s+=$2} END{print "sum="s}' | sed 's/=/: /'`, expect: /sum: 6/ },
  { name: 'python', script: 'python3 -c "import sys,json;print(\'py\', sys.version_info[0], json.dumps({\'k\':1}))"', expect: /py 3 \{"k": 1\}/ },
  { name: 'node', script: 'node -e "console.log(\'node\', process.version, [1,2,3].map(n=>n*2).join(\'-\'))"', expect: /node v\d+[\s\S]*2-4-6/ },
  {
    name: 'compile C',
    script: 'printf "#include <stdio.h>\\nint main(){printf(\\"c-compiled-and-ran\\\\n\\");return 0;}" > /tmp/t.c'
      + ' && gcc /tmp/t.c -o /tmp/t && /tmp/t',
    expect: /c-compiled-and-ran/,
    timeoutMs: 600_000,
  },
  {
    name: 'git',
    script: 'rm -rf /tmp/repo && mkdir -p /tmp/repo && cd /tmp/repo && git init -q'
      + ' && git config user.email a@b.c && git config user.name t'
      + ' && echo hi > a.txt && git add . && git commit -qm first && git log --oneline | head -1 && cd -',
    expect: /[0-9a-f]{7} first/,
    timeoutMs: 600_000,
  },
  {
    name: 'python venv + stdlib',
    script: 'python3 -c "import sqlite3,hashlib,ssl;print(\'stdlib-ok\', sqlite3.sqlite_version)"',
    expect: /stdlib-ok \d+\./,
  },
  {
    name: 'workspace write',
    script: 'echo persisted-by-vm > ~/workspace/vm-marker.txt && cat ~/workspace/vm-marker.txt',
    expect: /persisted-by-vm/,
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
    expect(isolated, 'the page is not cross-origin isolated, so the VM cannot start')
    process.stdout.write('▶ cross-origin isolated\n  ✓\n')

    process.stdout.write('▶ boot\n')
    const started = Date.now()
    await page.getByRole('button', { name: /Terminal/ }).click()
    await page.waitForFunction(
      () => /\$\s*$|\$\s/.test((globalThis as { dsh?: { terminal?: { text(): string } } }).dsh?.terminal?.text() ?? ''),
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

    // The overlay is what makes the machine a machine rather than a demo: a
    // file written before a reload has to still be there afterwards.
    process.stdout.write('▶ durability across a reload\n')
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForShell(page)
      await page.waitForTimeout(1500)
      await page.getByRole('button', { name: /Terminal/ }).click()
      await page.waitForFunction(
        () => /\$\s*$|\$\s/.test((globalThis as { dsh?: { terminal?: { text(): string } } }).dsh?.terminal?.text() ?? ''),
        undefined,
        { timeout: 300_000 },
      )
      const output = await run(page, 'cat ~/workspace/vm-marker.txt')
      expect(/persisted-by-vm/.test(output), `the VM's filesystem did not survive a reload:\n${output.slice(-600)}`)
      process.stdout.write('  ✓\n')
    } catch (error) {
      failures++
      process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
    }

    await page.screenshot({ path: '/tmp/dsh-vm-workload.png' })
  } finally {
    await browser.close()
  }

  if (errors.length > 0) process.stdout.write(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}\n`)
  process.stdout.write(failures === 0 ? '\n✓ the machine works\n' : `\n✗ ${String(failures)} workload(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
