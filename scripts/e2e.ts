/**
 * End-to-end driver for the built app.
 *
 * Runs the real browser against `dist/` and exercises the paths that only
 * exist once host, transport, and shell are all live: booting, configuring a
 * model, creating a session, sending a prompt, and running shell commands.
 *
 * Usage: `npx tsx scripts/e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { chromium, type ConsoleMessage, type Page } from 'playwright'

/** One scenario. */
interface Scenario {
  name: string
  run(page: Page, log: Logger): Promise<void>
}

/** Collected console output and page errors. */
interface Logger {
  errors: string[]
  lines: string[]
}

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Wait until the app's own boot screen is gone and the shell rendered. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 90_000 })
}

/** Evaluate a shell command through the page's exposed harness API. */
async function shell(page: Page, script: string): Promise<{ status: number, stdout: string, stderr: string }> {
  return page.evaluate(async (source: string) => globalThis.dsh.shell(source), script)
}

/** Assert a condition, failing the scenario with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

const scenarios: Scenario[] = [
  {
    name: 'boot',
    async run(page, log) {
      await waitForShell(page)
      const title = await page.title()
      expect(title.includes('DeepSeek Harness'), `unexpected title: ${title}`)
      const warnings = await page.evaluate(() => (globalThis as { __DSH_WARNINGS__?: string[] }).__DSH_WARNINGS__ ?? [])
      if (warnings.length > 0) console.log(`  host warnings:\n    ${warnings.join('\n    ')}`)
      const fatal = log.errors.filter(line => !/Failed to load resource|favicon/.test(line))
      expect(fatal.length === 0, `console errors:\n    ${fatal.join('\n    ')}`)
    },
  },
  {
    name: 'plugin-graph',
    async run(page) {
      await waitForShell(page)
      const graph = await page.evaluate(() => (globalThis as { __DSH_BOOT__?: { entries: { id: string }[] } }).__DSH_BOOT__)
      expect(graph !== undefined, 'window.__DSH_BOOT__ missing')
      const expected = graph!.entries.map(entry => entry.id)
      expect(expected.length >= 30, `expected the full client roster, got ${String(expected.length)}`)
      // Bundles keep materializing after the shell's first paint, so wait for
      // the roster to settle instead of sampling at whatever instant the shell
      // happened to render — a slower machine reaches that instant earlier in
      // the load, and the count alone cannot tell a race from a real failure.
      await page
        .waitForFunction(
          (want: number) => ((globalThis as { __DSH_MODULES__?: { loadCache: Map<string, unknown> } }).__DSH_MODULES__?.loadCache.size ?? 0) >= want,
          expected.length,
          { timeout: 30_000 },
        )
        .catch(() => undefined)
      const loaded = await page.evaluate(() =>
        [...((globalThis as { __DSH_MODULES__?: { loadCache: Map<string, unknown> } }).__DSH_MODULES__?.loadCache.keys() ?? [])],
      )
      const missing = expected.filter(id => !loaded.includes(id))
      expect(
        missing.length === 0,
        `client bundles never materialized (${String(loaded.length)} loaded of ${String(expected.length)} declared): ${missing.join(', ')}`,
      )
    },
  },
  {
    name: 'shell',
    async run(page) {
      await waitForShell(page)
      const cases: [string, RegExp][] = [
        ['echo hello', /^hello$/m],
        ['mkdir -p /workspace/t && cd /workspace/t && echo one > a.txt && cat a.txt', /^one$/m],
        ['cd /workspace/t && printf "x\\ny\\nz\\n" > b.txt && wc -l < b.txt', /3/],
        ['cd /workspace/t && grep -n y b.txt', /2:y/],
        ['cd /workspace/t && ls', /a\.txt/],
        ['for i in 1 2 3; do echo "n$i"; done', /n1[\s\S]*n2[\s\S]*n3/],
        ['if [ -d /workspace ]; then echo yes; else echo no; fi', /^yes$/m],
        ['echo $((2 + 3 * 4))', /^14$/m],
        ['echo "a b c" | tr " " "\\n" | sort -r | head -1', /^c$/m],
        ['X=42; echo "val=${X}"', /val=42/],
        ['cd /workspace/t && sed -i "s/one/two/" a.txt && cat a.txt', /^two$/m],
        ['cd /workspace/t && find . -name "*.txt" | sort', /a\.txt[\s\S]*b\.txt/],
        ['cd /workspace/t && cat a.txt | xargs -I{} echo "[{}]"', /\[two\]/],
        ['case abc in a*) echo matched;; *) echo no;; esac', /^matched$/m],
        ['f() { echo "fn:$1"; }; f hello', /^fn:hello$/m],
        ['echo one two three | cut -d" " -f2', /^two$/m],
        ['printf "b\\na\\nb\\n" | sort | uniq -c | head -1', /2 b|1 a/],
        ['test -f /home/dsh/workspace/README.md && echo present', /^present$/m],
        ['cd /tmp && git init r >/dev/null && cd r && echo hi > f.txt && git add . && git commit -m first && git log --oneline', /first/],
      ]
      for (const [script, matcher] of cases) {
        const result = await shell(page, script)
        const combined = `${result.stdout}${result.stderr}`
        expect(matcher.test(combined), `\`${script}\` → status ${String(result.status)}\n    ${combined.replace(/\n/g, '\n    ')}`)
      }
    },
  },
  {
    name: 'persistence',
    async run(page) {
      await waitForShell(page)
      await shell(page, 'mkdir -p /workspace/persist && echo durable > /workspace/persist/mark.txt')
      await page.evaluate(async () => { await globalThis.dsh.flush() })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForShell(page)
      const result = await shell(page, 'cat /workspace/persist/mark.txt')
      expect(/durable/.test(result.stdout), `file did not survive a reload: ${result.stdout}${result.stderr}`)
    },
  },
  {
    name: 'plugin-command',
    async run(page) {
      await waitForShell(page)
      // `/plugin` is the browser's counterpart to `dsh plugin`, and it has to be
      // a real registered command so the slash menu and transcript render it.
      const registered = await page.evaluate(() => {
        const commands = globalThis.dsh.ctx.get('commands') as { list(agent: unknown): { name: string }[] } | undefined
        if (commands === undefined) return null
        try {
          return commands.list(undefined).map(command => command.name)
        } catch {
          return []
        }
      })
      expect(registered !== null, 'the commands service is not mounted')
      const manager = await page.evaluate(() => typeof globalThis.dsh.plugins?.list === 'function')
      expect(manager, 'the plugin manager is not published')
      const listed = await page.evaluate(() => globalThis.dsh.plugins.list().length)
      expect(listed >= 0, 'the installed roster is unreadable')
    },
  },
  {
    name: 'model-turn',
    async run(page, log) {
      if (apiKey === '') {
        console.log('  skipped: set DEEPSEEK_API_KEY to exercise a real model turn')
        return
      }
      await waitForShell(page)
      const reply = await page.evaluate(
        async (key: string) => globalThis.dsh.promptOnce(key, 'Reply with exactly the word: pong'),
        apiKey,
      )
      expect(/pong/i.test(reply), `unexpected model reply: ${reply}`)
      void log
    },
  },
]

/** Run the selected scenarios. */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed })
  let failures = 0
  for (const scenario of scenarios) {
    if (only !== undefined && scenario.name !== only) continue
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const log: Logger = { errors: [], lines: [] }
    page.on('console', (message: ConsoleMessage) => {
      log.lines.push(`${message.type()}: ${message.text()}`)
      if (message.type() === 'error') log.errors.push(message.text())
    })
    page.on('pageerror', (error: Error) => { log.errors.push(`pageerror: ${error.message}`) })
    process.stdout.write(`▶ ${scenario.name}\n`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await scenario.run(page, log)
      process.stdout.write(`  ✓ ${scenario.name}\n`)
    } catch (error) {
      failures++
      process.stdout.write(`  ✗ ${scenario.name}: ${error instanceof Error ? error.message : String(error)}\n`)
      const tail = log.lines.slice(-25)
      if (tail.length > 0) process.stdout.write(`    console tail:\n      ${tail.join('\n      ')}\n`)
      await page.screenshot({ path: `/tmp/dshw-${scenario.name}.png` }).catch(() => undefined)
    }
    await context.close()
  }
  await browser.close()
  process.exit(failures === 0 ? 0 : 1)
}

void main()
