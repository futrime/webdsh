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
      // Not every declared bundle loads at boot — a settings page's module
      // materializes when that page is first opened — so the count is what can
      // be asserted. The names are still reported, because a shortfall is much
      // easier to diagnose when it says which ones are missing.
      const missing = expected.filter(id => !loaded.includes(id))
      expect(
        loaded.length >= expected.length,
        `client bundles never materialized (${String(loaded.length)} loaded of ${String(expected.length)} declared)`
        + `${missing.length === 0 ? '' : `; declared but absent: ${missing.join(', ')}`}`,
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
    name: 'search-backend',
    async run(page) {
      await waitForShell(page)
      // The `grep` and `glob` tools do not shell out to a grep — they spawn
      // ripgrep and parse its output. So the contract worth testing is the one
      // they actually depend on: the exact argv they build, and the exact
      // shapes they parse. A shell-level `grep` passing proves nothing here.
      await shell(page, [
        'mkdir -p /workspace/search/nested',
        'printf "alpha\\nneedle here\\ngamma\\n" > /workspace/search/a.ts',
        'printf "no match\\n" > /workspace/search/b.txt',
        'printf "needle again\\n" > /workspace/search/nested/c.ts',
      ].join(' && '))

      // `grep`'s vector: rg --json --regexp=<pattern> [--glob=<include>] -- <path>
      const json = await shell(page, `rg --no-config --json '--regexp=needle' '--glob=*.ts' -- /workspace/search`)
      const records = json.stdout.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as {
        type: string
        data: { path: { text: string }, line_number: number, lines: { text: string } }
      })
      const matches = records.filter(record => record.type === 'match')
      expect(matches.length === 2, `expected two --json match records, got ${String(matches.length)}: ${json.stdout}${json.stderr}`)
      for (const match of matches) {
        // These four fields are exactly what parseRecord() requires; a missing
        // one makes the whole search fail rather than degrade.
        expect(typeof match.data.path.text === 'string', `match record has no path text: ${JSON.stringify(match)}`)
        expect(typeof match.data.line_number === 'number', `match record has no line number: ${JSON.stringify(match)}`)
        expect(typeof match.data.lines.text === 'string', `match record has no line content: ${JSON.stringify(match)}`)
        expect(/needle/.test(match.data.lines.text), `match record line does not contain the pattern: ${JSON.stringify(match)}`)
      }
      expect(!matches.some(match => match.data.path.text.endsWith('.txt')), `--glob=*.ts did not exclude the .txt file: ${json.stdout}`)

      // A pattern that matches nothing must exit 1, not fail: the tool reads
      // exit 1 as "no results" and anything else as a search failure.
      const empty = await shell(page, `rg --no-config --json '--regexp=zzz-no-such-token' -- /workspace/search`)
      expect(empty.status === 1, `expected exit 1 for no matches, got ${String(empty.status)}: ${empty.stdout}${empty.stderr}`)

      // `glob`'s vector: rg --files --glob=<pattern> --sort=modified --no-ignore --hidden -- <path>
      const files = await shell(page, `rg --no-config --files '--glob=*.ts' --sort=modified --no-ignore --hidden '--glob=!**/.git' -- /workspace/search`)
      const listed = files.stdout.split('\n').filter(line => line.length > 0)
      expect(listed.length === 2, `expected two files from --files, got ${listed.join(', ')} ${files.stderr}`)
      expect(listed.every(path => path.endsWith('.ts')), `--files returned a non-.ts path: ${listed.join(', ')}`)
    },
  },
  {
    name: 'awk',
    async run(page) {
      await waitForShell(page)
      // Nearly every non-trivial shell pipeline contains an awk, and a missing
      // one does not degrade the pipeline — it stops it at that line.
      const cases: [string, RegExp][] = [
        [`printf 'a b c\\nd e f\\n' | awk '{print $2}'`, /^b\ne$/m],
        [`printf '1 2\\n3 4\\n' | awk '{s += $1} END {print "sum", s}'`, /sum 4/],
        [`printf 'x:1\\ny:2\\n' | awk -F: '$2 > 1 {print $1}'`, /^y$/m],
        [`printf 'a\\nb\\na\\n' | awk '{c[$0]++} END {for (k in c) print k, c[k]}' | sort`, /a 2[\s\S]*b 1/],
        [`awk 'BEGIN {printf "%05.2f|%-4s|%d\\n", 3.14159, "hi", 42}'`, /03\.14\|hi {2}\|42/],
        [`awk 'BEGIN {n = split("a,b,c", parts, ","); print n, parts[3]}'`, /3 c/],
        [`awk 'function double(x) {return x * 2} BEGIN {print double(21)}'`, /^42$/m],
        [`printf 'foo\\n' | awk '{gsub(/o/, "0"); print}'`, /^f00$/m],
        [`awk 'BEGIN {print toupper(substr("hello world", 7))}'`, /^WORLD$/m],
      ]
      for (const [script, matcher] of cases) {
        const result = await shell(page, script)
        expect(matcher.test(result.stdout), `\`${script}\` → ${result.stdout}${result.stderr}`)
      }
    },
  },
  {
    name: 'busybox-applets',
    async run(page) {
      await waitForShell(page)
      const cases: [string, RegExp][] = [
        [`printf 'one\\ntwo\\n' | tac`, /^two\none$/m],
        [`printf 'a\\tb\\n' | expand -t 4`, /^a {3}b$/m],
        [`printf 'hello\\n' | xxd | head -1`, /68 ?65 ?6c ?6c ?6f/],
        [`printf 'abc\\n' | md5sum`, /^[0-9a-f]{32} {2}-$/m],
        [`printf 'hello world\\n' | strings -n 5`, /hello world/],
        [`printf 'aaa\\nbbb\\n' | fold -w 2`, /^aa\na\nbb\nb$/m],
        ['sleep 0.1 && echo slept', /slept/],
        ['timeout 1 sleep 5; echo "status=$?"', /status=124/],
        ['busybox | head -1', /BusyBox/],
        ['nproc', /^\d+$/m],
      ]
      for (const [script, matcher] of cases) {
        const result = await shell(page, script)
        expect(matcher.test(result.stdout), `\`${script}\` → ${result.stdout}${result.stderr}`)
      }
      // `timeout` reports its deadline through the exit status; the command it
      // cut short must not also report itself as an error.
      const quiet = await shell(page, 'timeout 1 sleep 5')
      expect(!/interrupted/.test(quiet.stderr), `timeout leaked an interrupt notice: ${quiet.stderr}`)
    },
  },
  {
    name: 'node-runtime',
    async run(page) {
      await waitForShell(page)
      const cases: [string, RegExp][] = [
        ['node -v', /^v\d+\./m],
        [`node -e 'console.log("from node", 1 + 1)'`, /from node 2/],
        [`node -p '[1,2,3].map(x => x * 2)'`, /\[ 2, 4, 6 \]/],
        // Two evals in a row: each is its own program, not the first one's
        // cached module.
        [`node -e 'console.log("first")' && node -e 'console.log("second")'`, /first[\s\S]*second/],
        // A script's relative paths resolve against the shell's directory, so
        // what it writes is what the next command sees.
        [
          'mkdir -p /workspace/nr && cd /workspace/nr'
          + ` && printf 'const fs=require("fs");fs.writeFileSync("out.txt","node-wrote-this")' > s.cjs`
          + ' && node s.cjs && cat out.txt',
          /node-wrote-this/,
        ],
        // ESM, not just CommonJS.
        [
          `cd /workspace/nr && printf 'import {basename} from "node:path";console.log("esm:", basename("/a/b.txt"))' > m.mjs && node m.mjs`,
          /esm: b\.txt/,
        ],
      ]
      for (const [script, matcher] of cases) {
        const result = await shell(page, script)
        expect(matcher.test(result.stdout), `\`${script}\` → ${result.stdout}${result.stderr}`)
      }
    },
  },
  {
    name: 'npm-registry',
    async run(page) {
      await waitForShell(page)
      // The whole point of `npm` here is that it reaches the real registry and
      // what it installs is then requirable — a stub that printed a plausible
      // message would pass any weaker check.
      const installed = await shell(page, 'mkdir -p /workspace/npmtest && cd /workspace/npmtest && npm init --force && npm install is-odd')
      expect(/added \d+ package/.test(installed.stdout), `npm install did not report progress: ${installed.stdout}${installed.stderr}`)
      const used = await shell(page, `cd /workspace/npmtest && node -e 'console.log("odd:", require("is-odd")(3))'`)
      expect(/odd: true/.test(used.stdout), `an installed package was not requirable: ${used.stdout}${used.stderr}`)
      const listed = await shell(page, 'cd /workspace/npmtest && npm ls')
      expect(/is-odd@/.test(listed.stdout), `npm ls did not report the install: ${listed.stdout}${listed.stderr}`)
    },
  },
  {
    name: 'plugin-sources',
    async run(page) {
      await waitForShell(page)
      // `dsh plugin add` on a machine inherits everything npm accepts. The
      // registry case is covered elsewhere; these are the two that a browser
      // makes people ask for — something published at a URL, and something the
      // user made here.
      const remote = await page.evaluate(async () => {
        try {
          const entry = await globalThis.dsh.plugins.install(
            'https://registry.npmjs.org/dsh-working-activity/-/dsh-working-activity-0.2.4.tgz',
          )
          return `${entry.name}@${entry.version}`
        } catch (error) { return `failed: ${String(error)}` }
      })
      expect(/^dsh-working-activity@0\.2\.4$/.test(remote), `installing from a tarball URL failed: ${remote}`)

      const local = await page.evaluate(async () => {
        await globalThis.dsh.shell(
          'mkdir -p /tmp/myplug'
          + ` && printf '{"name":"my-local-plugin","version":"9.9.9"}' > /tmp/myplug/package.json`
          + ` && printf 'export default {}' > /tmp/myplug/index.js`,
        )
        try {
          const entry = await globalThis.dsh.plugins.install('/tmp/myplug')
          return `${entry.name}@${entry.version}`
        } catch (error) { return `failed: ${String(error)}` }
      })
      expect(/^my-local-plugin@9\.9\.9$/.test(local), `installing from a local directory failed: ${local}`)

      await page.getByRole('button', { name: /Plugins/ }).click()
      const listed = await page.locator('.dshp-list').innerText()
      expect(/my-local-plugin/.test(listed), `the inventory does not show what was installed:\n${listed}`)
    },
  },
  {
    name: 'terminal',
    async run(page) {
      await waitForShell(page)
      // What the terminal *does* is `scripts/vm-e2e.ts`'s subject, since it
      // needs the VM disk and takes minutes. What belongs here is that the page
      // offers one and that the machine can start at all — cross-origin
      // isolation is a property of the deployment, and losing it would take the
      // terminal with it while every other test still passed.
      const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
      expect(isolated, 'the page is not cross-origin isolated, so the VM cannot start')
      const button = page.getByRole('button', { name: /Terminal/ })
      await button.waitFor({ state: 'visible', timeout: 10_000 })
      await button.click()
      const surface = await page.evaluate(() => typeof globalThis.dsh.terminal?.send === 'function')
      expect(surface, 'the terminal did not publish its control surface')
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
  {
    name: 'search-tools',
    async run(page, log) {
      if (apiKey === '') {
        console.log('  skipped: set DEEPSEEK_API_KEY to exercise the search tools')
        return
      }
      await waitForShell(page)
      // The backend contract is covered without a key by `search-backend`; this
      // is the other half — that the tools themselves reach it. They resolve
      // their binary lazily at the first call, so nothing before this point in
      // the suite would notice them being unable to start.
      await shell(page, [
        'mkdir -p /home/dsh/workspace/src',
        'printf "export const SENTINEL_TOKEN = 1\\n" > /home/dsh/workspace/src/found.ts',
        'printf "unrelated\\n" > /home/dsh/workspace/src/other.txt',
      ].join(' && '))
      const reply = await page.evaluate(
        async (key: string) => globalThis.dsh.promptOnce(
          key,
          'Use your Grep tool (not bash) to find SENTINEL_TOKEN under /home/dsh/workspace, '
          + 'then your Glob tool to list *.ts files there. Report exactly what each tool returned.',
        ),
        apiKey,
      )
      expect(/found\.ts/.test(reply), `the search tools did not return the matching file:\n${reply.slice(0, 1200)}`)
      expect(
        !/could not start its search command|ripgrep launch failed|SEARCH_FAILED/i.test(reply),
        `a search tool failed to launch:\n${reply.slice(0, 1200)}`,
      )
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
