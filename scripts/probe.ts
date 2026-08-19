/**
 * Ask the container a question, and print what it said.
 *
 * Boots the built app in a browser once, then feeds it commands from a file —
 * `### <name>` starts a block, and everything until the next marker is one
 * script. The suites assert; this one measures, which is a different job: every
 * claim this repository makes about the runtime — what `jsh` resolves, which
 * binaries survive `npm install`, what `os.system` reaches — was settled by
 * running it here first rather than by reasoning about it.
 *
 * A run costs one boot, so the file is a batch rather than a command.
 *
 * Usage: `npx tsx scripts/probe.ts <file> [--url <url>] [--timeout <ms>]`
 */

import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const args = process.argv.slice(2)
const file = args.find(argument => !argument.startsWith('--')) ?? ''
const url = valueOf('--url') ?? 'http://127.0.0.1:4180/'
const timeoutMs = Number(valueOf('--timeout') ?? 600_000)

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Split the probe file into named blocks. */
function blocks(source: string): { name: string, script: string }[] {
  const out: { name: string, script: string }[] = []
  let current: { name: string, script: string } | undefined
  for (const line of source.split('\n')) {
    const marker = /^###\s*(.*)$/.exec(line)
    if (marker !== null) {
      if (current !== undefined) out.push(current)
      current = { name: marker[1] ?? '', script: '' }
      continue
    }
    if (current !== undefined) current.script += `${line}\n`
  }
  if (current !== undefined) out.push(current)
  return out
}

/** Wait until the app's own boot screen is gone. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })
}

/** Run everything. */
async function main(): Promise<void> {
  const probes = blocks(readFileSync(file, 'utf8'))
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => { process.stdout.write(`  [pageerror] ${String(error)}\n`) })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForShell(page)
    const ok = await page.evaluate(async () => globalThis.crossOriginIsolated)
    process.stdout.write(`cross-origin isolated: ${String(ok)}\n`)

    for (const probe of probes) {
      const started = Date.now()
      process.stdout.write(`\n=== ${probe.name} ===\n`)
      const result = await page.evaluate(
        async ([script, budget]) => Promise.race([
          globalThis.dsh.shell(script),
          new Promise<{ status: number, stdout: string, stderr: string }>(resolve =>
            setTimeout(() => { resolve({ status: -1, stdout: '[probe timed out]', stderr: '' }) }, Number(budget))),
        ]),
        [probe.script, String(timeoutMs)] as const,
      )
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      process.stdout.write(`[status ${String(result.status)} in ${seconds}s]\n`)
      const text = `${result.stdout}${result.stderr}`
      process.stdout.write(text.length > 12_000 ? `${text.slice(0, 6000)}\n…[trimmed]…\n${text.slice(-6000)}\n` : `${text}\n`)
    }
  } finally {
    await browser.close()
  }
}

void main()
