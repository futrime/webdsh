/**
 * The acceptance test: give the agent a real programming job and check the work.
 *
 * Every other suite checks a mechanism. This checks the product — one prompt,
 * and the agent has to write a Node project, run its tests, and get them
 * passing, using the same shell, filesystem, and toolchain a person would.
 *
 * What makes it worth its runtime is that it fails for reasons the mechanism
 * tests cannot see. A shell that answers `command not found` for every command,
 * a `find` that walks a whole dependency tree instead of two levels, an `ls -l`
 * that reports every file as empty — each of those let the narrower tests pass
 * while making the harness useless. So the checks below read the result the way
 * a person would: are the files there, do they have contents, do the tests run,
 * and does the test runner say they passed.
 *
 * Usage: `DEEPSEEK_API_KEY=… npx tsx scripts/task-e2e.ts [--url <url>] [--headed]`
 */

import { chromium, type Browser, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the run with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** The job. Deliberately ordinary: files, modules, a test runner, an error path. */
const TASK = `Build a small Node.js project called mini-harness in the current directory.

Requirements:
1. package.json with "type": "module" and a "test" script that runs: node --test
2. src/harness.js exporting a class Harness with:
   - registerTool(name, handler)
   - async run(steps) where each step is {tool, input}; it calls each tool in order,
     collects results, and throws a clear Error naming the tool if one is not registered.
3. test/harness.test.js using node:test and node:assert covering: registering and running
   two tools, results in order, and the error for an unknown tool.
4. Run the tests with npm test and make them pass.

Use your bash tool to create files and run the tests. Report the final test output verbatim.`

/** Run one command in the workspace and return its merged output. */
async function shell(page: Page, script: string): Promise<{ status: number, text: string }> {
  return page.evaluate(async (source: string) => {
    const result = await globalThis.dsh.shell(source)
    return { status: result.status, text: `${result.stdout}${result.stderr}` }
  }, script)
}

/** Wait for the app shell to replace the boot screen. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })
  await page.waitForTimeout(2500)
}

/** Run the job and inspect what it produced. */
async function main(): Promise<void> {
  if (apiKey === '') {
    console.error('DEEPSEEK_API_KEY is required: this test gives a real model a real job.')
    process.exit(2)
  }
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: !headed })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const failures: string[] = []
    page.on('pageerror', (error) => { failures.push(`pageerror: ${error.message}`) })

    console.log('▶ boot')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForShell(page)

    console.log('▶ the agent works the job (several minutes)')
    const started = Date.now()
    const reply = await page.evaluate(
      async ([key, task]: [string, string]) => globalThis.dsh.promptOnce(key, task),
      [apiKey, TASK] as [string, string],
    )
    console.log(`  finished in ${String(Math.round((Date.now() - started) / 1000))}s`)

    console.log('▶ the files exist and are not empty')
    // Read from the filesystem rather than from the reply: a model that cannot
    // run anything can still describe a project it never wrote.
    for (const path of ['package.json', 'src/harness.js', 'test/harness.test.js']) {
      const listed = await shell(page, `wc -c < ${path}`)
      const bytes = Number(listed.text.trim())
      expect(listed.status === 0, `${path} was never created:\n${reply.slice(-1200)}`)
      expect(bytes > 0, `${path} exists but is empty (${listed.text.trim()} bytes)`)
    }

    console.log('▶ it is a real module')
    const manifest = await shell(page, 'cat package.json')
    expect(/"type"\s*:\s*"module"/.test(manifest.text), `package.json is not an ES module:\n${manifest.text}`)

    console.log('▶ the tests pass when run again')
    // Run them independently of whatever the agent reported. This is the check
    // that the toolchain works, not just that the model said so.
    const tests = await shell(page, 'npm test 2>&1 | tail -n 30')
    expect(
      /# fail 0\b/.test(tests.text) && /# pass [1-9]/.test(tests.text),
      `the project's own tests do not pass:\n${tests.text.slice(-1500)}`,
    )
    const passed = /# pass (\d+)/.exec(tests.text)?.[1] ?? '?'

    expect(failures.length === 0, `the page threw during the run:\n  ${failures.join('\n  ')}`)
    console.log(`\n✓ the agent built a working project and ${passed} of its tests pass`)
  } finally {
    await browser?.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
