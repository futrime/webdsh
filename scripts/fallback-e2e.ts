/**
 * The degraded path: a browser that cannot run the container.
 *
 * WebContainers needs more than the capability checks can see. Chrome on
 * Android has cross-origin isolation and `SharedArrayBuffer` and still will not
 * start one, and any network that cannot reach StackBlitz's CDN produces the
 * same result. When that happens the harness has to keep working on the page's
 * own filesystem rather than fail every command and every file read — which is
 * what it used to do, because availability was decided by a capability check
 * that a failed boot never updated.
 *
 * The runtime's origins are blocked here to produce that state deliberately.
 * Everything below then has to behave: the shell runs, files persist, and the
 * agent's own tools read and write them.
 *
 * Usage: `DEEPSEEK_API_KEY=… npx tsx scripts/fallback-e2e.ts [--url <url>]`
 */

import { chromium, type Browser, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

/** Where the container is served from; blocking these is what makes boot fail. */
const RUNTIME_ORIGINS = [
  '**://*.staticblitz.com/**',
  '**://stackblitz.com/**',
  '**://*.webcontainer-api.io/**',
]

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the run with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Run a command and return its merged output. */
async function shell(page: Page, script: string): Promise<string> {
  return page.evaluate(async (source: string) => {
    const result = await globalThis.dsh.shell(source)
    return `${result.stdout}${result.stderr}`
  }, script)
}

/** Run the whole check. */
async function main(): Promise<void> {
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: !headed })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    for (const pattern of RUNTIME_ORIGINS) {
      await page.route(pattern, route => route.fulfill({ status: 503, body: 'unavailable' }))
    }

    console.log('▶ boot without a runtime')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
    }, undefined, { timeout: 180_000 })
    await page.waitForTimeout(5000)

    console.log('▶ the host still composes')
    // The failure has to stay confined to the runtime. Losing the credential
    // store means the user cannot even enter an API key, with nothing on screen
    // to say why.
    const composed = await page.evaluate(() => ({
      credentials: globalThis.dsh.ctx.get('credentials') !== undefined,
      isolated: globalThis.crossOriginIsolated,
    }))
    expect(composed.credentials, 'the credential store did not mount without a runtime')

    console.log('▶ the first file read falls back in the same call')
    // This deliberately lands while WebContainer.boot() is still pending. The
    // old synchronous capability check routed it into that doomed attempt,
    // threw at the deadline, and only made the *second* read use the page VFS.
    // Waiting for the settled backend must make this first operation succeed.
    const started = Date.now()
    const seeded = await page.evaluate(async () => {
      const fs = globalThis.dsh.ctx.get('fs') as {
        resolve(path: string): Promise<object>
        readText(target: object): Promise<string>
      }
      return fs.readText(await fs.resolve('/home/dsh/workspace/README.md'))
    })
    const waited = Math.round((Date.now() - started) / 1000)
    console.log(`  waited ${String(waited)}s for the runtime to give up`)
    expect(seeded.startsWith('# Workspace'), 'the first read did not fall back to the seeded VFS')
    expect(waited < 45, `the first file read waited ${String(waited)}s, which reads as a freeze`)

    console.log('▶ the shell falls back to the page')
    // Deliberately not a trivial command: the fallback is a different shell, and
    // it has to be the same shell.
    const output = await shell(page, 'pwd && echo written > fallback.txt && cat fallback.txt && ls')
    expect(/\/workspace/.test(output), `no workspace to work in:\n${output}`)
    expect(/written/.test(output), `a file written in the fallback cannot be read back:\n${output}`)

    console.log('▶ the language is still the language')
    const language = await shell(page, 'n=$(printf "a\\nb\\n" | wc -l); if [ "$n" -gt 1 ]; then echo "counted $n"; fi')
    expect(/counted 2/.test(language), `the fallback shell is not the same shell:\n${language}`)

    console.log('▶ files survive a reload')
    await page.evaluate(async () => { await globalThis.dsh.flush() })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.getElementById('dshw-boot') === null, undefined, { timeout: 180_000 })
    await page.waitForTimeout(4000)
    const restored = await shell(page, 'cat fallback.txt')
    expect(/written/.test(restored), `the workspace did not survive a reload:\n${restored}`)

    if (apiKey === '') {
      console.log('\n✓ the harness works without a runtime (set DEEPSEEK_API_KEY to also check the agent)')
      return
    }

    console.log('▶ the agent reads and writes through its own tools')
    // The file tools route to the runtime when there is one; the point here is
    // that they route somewhere real when there is not.
    const marker = `fallback-${Math.floor(performance.now()).toString(36)}`
    await shell(page, `echo ${marker} > probe.txt`)
    const reply = await page.evaluate(
      async (key: string) => globalThis.dsh.promptOnce(
        key,
        'Read probe.txt in the workspace and report its exact contents, then write note.txt containing the word saved.',
      ),
      apiKey,
    )
    expect(reply.includes(marker), `the agent could not read a file without a runtime:\n${reply.slice(-1200)}`)
    const wrote = await shell(page, 'cat note.txt')
    expect(/saved/.test(wrote), `the agent could not write a file without a runtime: ${wrote}`)

    console.log('\n✓ the harness works without a runtime, and so does the agent')
  } finally {
    await browser?.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
