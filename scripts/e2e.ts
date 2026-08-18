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
      // The shell a tool call reaches is the container's own `jsh`, because
      // `@dsh-web/jsh` is composed. These cases are the contract that plugin
      // makes with the model: the first group is what jsh does, the second is
      // what it does *wrongly and silently*, and the third is the way out.
      // If any of them changes, the tool description is a lie and the model
      // will act on it.
      const cases: [string, RegExp][] = [
        // What jsh has.
        ['echo hello', /hello/],
        ['mkdir -p t && cd t && echo one > a.txt && cat a.txt', /one/],
        ['cd t && echo x > b.txt && echo y >> b.txt && cat b.txt', /x[\s\S]*y/],
        ['cd t && ls', /a\.txt/],
        ['true && echo chained', /chained/],
        ['false || echo fallback', /fallback/],
        ['echo one; echo two', /one[\s\S]*two/],
        ['X=42; echo "val=$X"', /val=42/],
        ['X=abc; echo "${X}def"', /abcdef/],
        ['cd t && cat a.txt | head -n 1', /one/],
        ['ls /', /home/],
        ['false; echo "status=$?"', /status=1/],
        ['echo one > lines.txt && sort lines.txt', /one/],
        ['ls *.txt', /lines\.txt/],
        ['(echo inside)', /inside/],
        ['echo before # trailing', /before/],
        // The escape hatches the description points at, which have to work
        // because everything the model cannot do in jsh is sent to them.
        ['node -e "console.log(6*7)"', /42/],
        ['node -e "let s=0; for (const n of [1,2,3]) s+=n; console.log(s)"', /\b6\b/],
        ['python3 -c "print(6*7)"', /42/],
        ['python3 -c "import json; print(json.dumps({\'a\': 1}))"', /\{"a": 1\}/],
        ['npm --version', /\d+\.\d+\.\d+/],
        ['jq --version', /jq-\d/],
      ]
      for (const [script, matcher] of cases) {
        const result = await shell(page, script)
        // Colour stripped before matching: `node` and `npm` write SGR codes
        // around their output, and a pattern anchored on a word boundary sees
        // the escape's `m` as the neighbouring character.
        const combined = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '')
        expect(matcher.test(combined), `\`${script}\` → status ${String(result.status)}\n    ${combined.replace(/\n/g, '\n    ')}`)
      }

      // The silent failures. These are why the plugin exists, so the suite
      // asserts them rather than hoping: jsh reports success and an empty
      // expansion, and the tool description tells the model never to write
      // them. A day when one of these starts working is a day the description
      // needs rewriting.
      const silent: [string, string][] = [
        ['echo "sub=$(echo inner)"', 'sub='],
        ['echo "n=$((6*7))"', 'n='],
        ['echo "d=${UNSET:-fallback}"', 'd='],
      ]
      for (const [script, expected] of silent) {
        const result = await shell(page, script)
        const text = `${result.stdout}${result.stderr}`.replace(/\r/g, '').trim()
        expect(
          result.status === 0 && text === expected,
          `jsh no longer fails silently on \`${script}\`: status ${String(result.status)}, ${JSON.stringify(text)}`
            + ' — update the @dsh-web/jsh tool description',
        )
      }

      // The loud failures, likewise.
      const loud = ['for i in a b; do echo $i; done', 'if true; then echo x; fi', 'cat < lines.txt', 'grep x lines.txt']
      for (const script of loud) {
        const result = await shell(page, script)
        expect(result.status !== 0, `jsh now accepts \`${script}\` — update the @dsh-web/jsh tool description`)
      }
    },
  },
  {
    name: 'jsh-plugin',
    async run(page) {
      await waitForShell(page)
      // The plugin owns the model's shell tool outright: `bash` is gone, `jsh`
      // is what the model sees, and its description is what it plans against.
      // A build that ran jsh while still advertising bash would pass every
      // other test in this file.
      const composition = await page.evaluate(() => {
        const tools = globalThis.dsh.ctx.get('tools') as {
          schemas(): { name: string }[]
          get(name: string): { description?: string } | undefined
        } | undefined
        const runtime = (globalThis as { __DSH_WEB_RUNTIME__?: { shellMode(): string } }).__DSH_WEB_RUNTIME__
        return {
          names: (tools?.schemas() ?? []).map(tool => tool.name).sort(),
          description: tools?.get('jsh')?.description ?? '',
          mode: runtime?.shellMode(),
        }
      })
      expect(composition.names.includes('jsh'), `the jsh tool is not registered: ${composition.names.join(', ')}`)
      expect(!composition.names.includes('bash'), 'the bash tool is still registered beside jsh')
      expect(composition.mode === 'jsh', `commands do not run in jsh: mode is ${String(composition.mode)}`)
      for (const claim of ['$(...)', 'for', 'heredocs', 'node -e', 'python3 -c']) {
        expect(composition.description.includes(claim), `the tool description does not mention ${claim}`)
      }
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
        // Written through the page's own filesystem rather than the runtime's:
        // plugins are installed into the host, which is where the loader reads
        // them from, and the two filesystems are deliberately separate.
        globalThis.dsh.writeFile('/tmp/myplug/package.json', '{"name":"my-local-plugin","version":"9.9.9"}')
        globalThis.dsh.writeFile('/tmp/myplug/index.js', 'export default {}')
        try {
          const entry = await globalThis.dsh.plugins.install('/tmp/myplug')
          return `${entry.name}@${entry.version}`
        } catch (error) { return `failed: ${String(error)}` }
      })
      expect(/^my-local-plugin@9\.9\.9$/.test(local), `installing from a local directory failed: ${local}`)

      const listed = await page.evaluate(() => globalThis.dsh.plugins.list().map(entry => entry.name))
      expect(listed.includes('my-local-plugin'), `the inventory does not show what was installed: ${listed.join(', ')}`)
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
      // The terminal is a plugin, so what belongs here is that its row composed
      // and put its action on the surface — what it *does* is runtime-e2e's
      // subject, since that needs the runtime and takes minutes.
      const button = page.getByRole('button', { name: /Terminal/ })
      await button.first().waitFor({ state: 'visible', timeout: 30_000 })
      const rows = await page.evaluate(() => {
        const found: string[] = []
        for (const entry of globalThis.dsh.ctx.loader?.entries() ?? []) {
          const id = String((entry as { options?: { id?: string } }).options?.id ?? '')
          if (/web-terminal|web-plugin-install/.test(id)) found.push(id)
        }
        return found
      })
      expect(rows.length === 2, `the shipped plugin rows are not composed: ${rows.join(', ')}`)
    },
  },
  {
    name: 'spawn-argv',
    async run(page) {
      await waitForShell(page)
      // The seam every tool call crosses: a plugin (or the agent's own bash
      // tool) spawns a shell, and this build turns that argv into a script for
      // the runtime. Getting the argv grammar wrong breaks every command at
      // once, and does it below the model — which is why this is checked
      // directly rather than by asking an agent to run something.
      const cases: [string, string[], RegExp][] = [
        // `bash -lc -- <script>` is what the harness spawns. Treating the token
        // after `-c` as the script made the script literally `--`, so every
        // command answered `sh: --: command not found`.
        ['bash', ['-lc', '--', 'echo dashdash-ok'], /dashdash-ok/],
        ['bash', ['-c', '--', 'echo c-ok'], /c-ok/],
        ['bash', ['-lc', 'echo plain-ok'], /plain-ok/],
        ['bash', ['--noprofile', '--norc', '-c', 'echo longopts-ok'], /longopts-ok/],
        ['/bin/bash', ['-lc', '--', 'ls / | head -n 20'], /home/],
        // POSIX puts `$0` after the script and the parameters after that. jsh
        // has no positional parameters at all — `$0` is `/bin/jsh` and `$1` is
        // the script it was handed — so what this checks is that the extra argv
        // is carried without breaking the call, not that it arrives as `$1`.
        // Nothing model-facing passes positional parameters; the bash tool
        // never did.
        ['bash', ['-c', 'echo ran-anyway', 'myname', 'first'], /ran-anyway/],
      ]
      for (const [command, argv, matcher] of cases) {
        const output = await page.evaluate(async ([cmd, args]: [string, string[]]) => {
          const loader = (globalThis.dsh.ctx as unknown as {
            loader: { internal: { import(specifier: string): Promise<unknown> } }
          }).loader
          const cp = await loader.internal.import('node:child_process') as {
            spawn(command: string, args: string[], options: Record<string, unknown>): {
              stdout?: { on(event: string, listener: (chunk: unknown) => void): void }
              stderr?: { on(event: string, listener: (chunk: unknown) => void): void }
              on(event: string, listener: (code: number | null) => void): void
            }
          }
          return new Promise<string>((resolve) => {
            const child = cp.spawn(cmd, args, {})
            let text = ''
            child.stdout?.on('data', (chunk) => { text += String(chunk) })
            child.stderr?.on('data', (chunk) => { text += String(chunk) })
            child.on('close', (code) => { resolve(`[${String(code)}] ${text}`) })
          })
        }, [command, argv] as [string, string[]])
        expect(
          matcher.test(output),
          `spawn(${command}, ${JSON.stringify(argv)}) produced ${JSON.stringify(output.slice(0, 200))}`,
        )
        expect(output.startsWith('[0]'), `spawn(${command}, ${JSON.stringify(argv)}) failed: ${output.slice(0, 200)}`)
      }
    },
  },
  {
    name: 'plugin-routes',
    async run(page) {
      await waitForShell(page)
      // A plugin can serve its own HTTP routes, and on a static host the only
      // thing that can answer them is the page, reached through the service
      // worker. `/plugins/events` is a real one — `dsh-client-hmr` registers it
      // — and it is an event stream, which is the case that used to fail: the
      // reply was assembled by reading the body to completion, so a stream that
      // never ends was never answered, and the worker reported 404 after its
      // timeout. Every plugin-served file went the same way.
      const served = await page.evaluate(async () => {
        const response = await fetch('plugins/events', { headers: { accept: 'text/event-stream' } })
        return { status: response.status, type: response.headers.get('content-type') ?? '' }
      })
      expect(
        served.status !== 404,
        `a plugin-registered route is not reachable through the service worker: ${JSON.stringify(served)}`,
      )
      expect(
        /event-stream/.test(served.type),
        `the route answered, but not as the stream it registered: ${JSON.stringify(served)}`,
      )
    },
  },
  {
    name: 'persistence',
    async run(page) {
      await waitForShell(page)
      await shell(page, 'mkdir -p persist && echo durable > persist/mark.txt')
      await page.evaluate(async () => { await globalThis.dsh.flush() })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForShell(page)
      const result = await shell(page, 'cat persist/mark.txt')
      expect(/durable/.test(result.stdout), `the workspace did not survive a reload: ${result.stdout}${result.stderr}`)
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
    name: 'code-mode',
    async run(page, log) {
      if (apiKey === '') {
        console.log('  skipped: set DEEPSEEK_API_KEY to exercise Code Mode')
        return
      }
      await waitForShell(page)
      // Code Mode runs the model's code in a worker thread, which this build has
      // no threads for: the entry runs in the page, reached through the shimmed
      // `worker_threads`. What that shim gets wrong is invisible from outside —
      // an entry that reads a stale `parentPort` decides it is the main thread
      // and refuses to start — so the check is that a real code turn produces a
      // real answer.
      // Deliberately not a sum a model can do in its head: an answer it could
      // reach without running anything would let a completely dead code runtime
      // pass, which is how the shell tool stayed broken behind a green test.
      let expected = 0
      for (let i = 1; i <= 10_000; i++) expected = (expected + i * i) % 99_991
      const reply = await page.evaluate(
        async (key: string) => globalThis.dsh.promptOnce(
          key,
          'Use your code execution tool to run exactly this and report the number it prints:\n'
          + 'let a = 0; for (let i = 1; i <= 10000; i++) a = (a + i * i) % 99991; console.log(a)',
        ),
        apiKey,
      )
      expect(
        new RegExp(`\\b${String(expected)}\\b`).test(reply),
        `Code Mode did not return the computed answer (${String(expected)}):\n${reply.slice(0, 1200)}`,
      )
      expect(
        !/outside a worker thread|worker entry|not iterable/i.test(reply),
        `the code runtime worker failed to start:\n${reply.slice(0, 1200)}`,
      )
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
        'mkdir -p src',
        'echo "export const SENTINEL_TOKEN = 1" > src/found.ts',
        'echo unrelated > src/other.txt',
      ].join(' && '))
      const reply = await page.evaluate(
        async (key: string) => globalThis.dsh.promptOnce(
          key,
          'Use your Grep tool (not bash) to find SENTINEL_TOKEN in this workspace, '
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
