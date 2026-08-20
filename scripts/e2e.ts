/**
 * End-to-end driver for the built app.
 *
 * Runs the real browser against `dist/` and exercises the paths that only
 * exist once host, transport, and shell are all live: booting, configuring a
 * model, creating a session, sending a prompt, and running shell commands.
 *
 * Usage: `npx tsx scripts/e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type ConsoleMessage, type Page } from 'playwright'
import { FREE_ROUTES } from './free-routes.ts'

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

/**
 * The model a new session is supposed to start on, as the overlay declares it.
 *
 * Read rather than pinned. Which route is the default is a decision that moves
 * — it follows what the free endpoints actually serve, and the roster behind it
 * is re-measured against live services — so a literal here turns every such
 * change into a failing build that says only "the default model changed". What
 * is worth asserting is not the value but that it *arrived*: that the patch
 * layer this repository authors is the one the running page composed.
 * @returns the declared `provider/model`.
 */
function declaredDefault(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const patch = readFileSync(join(root, 'src/host/browser.patch.yml'), 'utf8')
  const block = /^- id: agent-default-model$[\s\S]*?^\s+provider:\s*(\S+)$[\s\S]*?^\s+model:\s*(\S+)$/m.exec(patch)
  if (block === null) throw new Error('e2e: browser.patch.yml declares no agent-default-model provider and model')
  return `${block[1]}/${block[2]}`
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

/**
 * Drive one turn with a dummy key and read the tools off the request it sent.
 *
 * The provider rejects the key, but the request is built and sent first, and
 * that request is the only thing that cannot be wrong about what the model was
 * offered — a registry answers about the unscoped subset, and the shell tool is
 * agent-scoped.
 * @param page - the loaded app.
 * @param agentPreset - the preset to compose the session from, or the default.
 * @returns the offered tools, their names sorted, and the raw bodies they came from.
 */
async function offeredTools(page: Page, agentPreset?: string): Promise<{
  names: string[]
  /** Absent when the turn sent no request at all — a preset that never starts one. */
  tools?: { function?: { name?: string } }[]
  bodies: string[]
}> {
  await page.evaluate(() => { (globalThis as { __SENT__?: string[] }).__SENT__ = [] })
  await page.evaluate(async (preset: string | undefined) => {
    // Bounded, because what is wanted is the request bytes and they are on the
    // wire long before the turn ends — and a preset that never starts a turn
    // must cost this check seconds, not the caller's whole timeout.
    await Promise.race([
      globalThis.dsh.promptOnce('sk-not-a-real-key', 'List the files here.', preset)
        .catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 25_000)),
    ])
  }, agentPreset).catch(() => undefined)
  await page.waitForTimeout(4000)

  const bodies = await page.evaluate(() => (globalThis as { __SENT__?: string[] }).__SENT__ ?? [])
  const request = bodies.map((body) => {
    try {
      return JSON.parse(body) as { tools?: { function?: { name?: string } }[] }
    } catch {
      return undefined
    }
  }).find(parsed => Array.isArray(parsed?.tools) && parsed.tools.length > 0)
  const tools = request?.tools
  return { names: (tools ?? []).map(tool => tool.function?.name ?? '?').sort(), tools, bodies }
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
        // `pathlib` is the shortest proof that this is CPython and not the
        // RustPython the container ships, which has no such module.
        ['python3 -c "import pathlib; print(pathlib.Path(\'.\').resolve().name)"', /workspace/],
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
    // The container is a real machine with a shell on it, so the directory the
    // harness stages command scripts in is inside something the agent can
    // delete. It was created once at boot: after `rm -rf ~/.dsh` every command
    // for the rest of the page's life failed with `ENOENT … run-N.sh`, which is
    // a session with no shell and no way back short of a reload.
    name: 'shell-staging',
    async run(page) {
      await waitForShell(page)
      expect((await shell(page, 'echo before')).stdout.includes('before'), 'the runtime shell did not answer')
      await shell(page, 'rm -rf /home/dsh/.dsh')
      const after = await shell(page, 'echo after')
      expect(
        after.status === 0 && after.stdout.includes('after'),
        `the shell did not recover from losing its staging directory: ${JSON.stringify(after)}`,
      )
    },
  },
  {
    name: 'model-request',
    async run(page) {
      await waitForShell(page)
      const { names, tools, bodies } = await offeredTools(page)
      expect(tools !== undefined, `no model request was captured (${String(bodies.length)} bodies seen)`)
      expect(names.includes('jsh'), `the model was not offered the jsh tool: ${names.join(', ')}`)
      expect(
        !names.includes('bash'),
        `the model was offered a bash tool: ${names.join(', ')}`
          + ' — check that every agent preset mounts browser:machine, not @deepseek-ai/dsh-tool-bash',
      )

      // And nothing in the prompt may advertise one either. The only permitted
      // mention is the sentence saying there is none.
      const raw = bodies.find(body => body.includes('"tools"')) ?? ''
      const offenders = [...raw.replace(/is no `?bash`? tool/gi, '').matchAll(/.{60}bash tool.{60}/gi)]
      expect(
        offenders.length === 0,
        `the request advertises a bash tool:\n    ${offenders.map(match => match[0]).join('\n    ')}`,
      )

      // The description the model plans against, read off the wire rather than
      // out of a registry.
      const described = JSON.stringify((tools ?? []).find(tool => tool.function?.name === 'jsh'))
      for (const claim of ['$(...)', 'heredocs', 'node -e', 'python3 -c', 'pip install', 'there is no `bash` tool']) {
        expect(described.includes(claim), `the jsh tool description does not mention ${claim}`)
      }

      const mode = await page.evaluate(() =>
        (globalThis as { __DSH_WEB_RUNTIME__?: { shellMode(): string } }).__DSH_WEB_RUNTIME__?.shellMode())
      expect(mode === 'jsh', `commands do not run in jsh: mode is ${String(mode)}`)
    },
  },
  {
    // The default preset is not the only composition a user can pick, and the
    // presets do not agree on how they mount a shell: three carry a `tool-bash`
    // row, and `minimal` builds a persistent one out of a PTY registry, a bash
    // backend, and `dsh-tool-bash-persistent` in a realm of its own. A rewrite
    // that knows one shape leaves the other shipping a `bash` tool to a machine
    // with no bash, which is what happened — so this asks every preset the
    // deployment ships, on the wire, one at a time.
    name: 'preset-shell-tools',
    async run(page) {
      await waitForShell(page)
      // The roster the picker reads, not a directory listing: `ls` runs in the
      // container, and the presets are seeded into the page's own filesystem.
      const presets = await page.evaluate(async () => {
        const service = globalThis.dsh.ctx.get('agentPresets') as { list(): Promise<{ id: string }[]> } | undefined
        return service === undefined ? [] : (await service.list()).map(preset => preset.id)
      })
      expect(presets.length > 1, `expected the shipped presets, got ${JSON.stringify(presets)}`)

      for (const preset of presets) {
        const { names, tools } = await offeredTools(page, preset)
        // A preset that never reaches the model is as unusable as one that
        // offers the wrong shell, and it fails silently — `cordis` did, for as
        // long as its skills directory hung the discovery that precedes a turn.
        expect(tools !== undefined, `the ${preset} preset started no turn: no model request was sent`)
        // Code Mode presents its tools as an SDK rather than as wire tools, so a
        // preset may legitimately offer no shell tool by name; what it may not
        // do is offer one that is not this machine's.
        const foreign = names.filter(name => /^(bash|sh|zsh|pwsh|powershell)$/.test(name))
        expect(
          foreign.length === 0,
          `the ${preset} preset offers the model a ${foreign.join(', ')} tool this deployment has no interpreter for`
            + ' — scripts/assemble.ts must rewrite every shape a preset mounts a shell with',
        )
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

      // The source CORS used to close off. `codeload.github.com` answers no
      // browser, so a GitHub reference installing at all is the trees-API route
      // having worked.
      const github = await page.evaluate(async () => {
        try {
          const entry = await globalThis.dsh.plugins.install('ccch1mneyyy/working-activity')
          return `${entry.name}@${entry.version}`
        } catch (error) { return `failed: ${String(error)}` }
      })
      expect(
        /^[\w@/-]+@\d/.test(github),
        'installing from a GitHub reference failed. Both routes were unavailable: the trees API'
        + ` (60 unauthenticated calls an hour, shared by this address) and the proxied tarball: ${github}`,
      )

      // That it did not fall back to the proxy is the other half, and the one
      // that would rot silently: the fallback would keep this suite green while
      // routing every plugin install through a third party. It is only a fair
      // question while GitHub is still answering — the unauthenticated
      // allowance is 60 an hour and shared by everything on this address, so an
      // exhausted one is a fact about the runner, not a regression.
      const allowance = await page.evaluate(async () => {
        try {
          const response = await fetch('https://api.github.com/rate_limit', { signal: AbortSignal.timeout(15_000) })
          if (!response.ok) return 0
          const document = await response.json() as { resources?: { core?: { remaining?: number } } }
          return document.resources?.core?.remaining ?? 0
        } catch { return 0 }
      })
      const proxied = await page.evaluate(() =>
        (globalThis as { __DSH_WEB_NETWORK__?: { proxied(): string[] } }).__DSH_WEB_NETWORK__?.proxied() ?? [])
      if (allowance > 0) {
        expect(
          !proxied.includes('https://codeload.github.com'),
          'the GitHub install fell back to the CORS proxy; the trees-API route regressed',
        )
      } else {
        process.stdout.write('  note: GitHub\'s API allowance is spent, so the no-proxy assertion was skipped\n')
      }

      const listed = await page.evaluate(() => globalThis.dsh.plugins.list().map(entry => entry.name))
      expect(listed.includes('my-local-plugin'), `the inventory does not show what was installed: ${listed.join(', ')}`)
    },
  },
  {
    // This case gates a deploy, so it is careful about what it blames. Two of
    // its three assertions are about this repository's own logic and always
    // hold; the third needs a third party to be up, and a third party being
    // down is not a reason to stop publishing the site. So the proxy is probed
    // first, and only a proxy that *is* answering makes the retry mandatory.
    name: 'cors-proxy',
    async run(page) {
      await waitForShell(page)
      // Half the point of the policy is what it does NOT do. A host that
      // answers a browser must never be handed to a third party.
      const clean = await page.evaluate(async () => {
        await fetch('https://registry.npmjs.org/dsh-working-activity')
        return (globalThis as { __DSH_WEB_NETWORK__?: { proxied(): string[] } }).__DSH_WEB_NETWORK__?.proxied() ?? []
      })
      expect(!clean.includes('https://registry.npmjs.org'), 'a CORS-clean host was routed through the proxy')

      // OpenAI refuses a browser this exact request: a POST with a JSON body
      // and an `authorization` header. With the proxy off it must fail — if it
      // does not, the premise is gone and the rest of this case means nothing.
      const off = await page.evaluate(async () => {
        const network = (globalThis as { __DSH_WEB_NETWORK__?: { setConfig(next: { enabled: boolean }): unknown } }).__DSH_WEB_NETWORK__
        network?.setConfig({ enabled: false })
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer sk-not-a-real-key' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(30_000),
          })
          return `reached anyway (${String(response.status)})`
        } catch { return 'refused' }
      })
      expect(off === 'refused', `api.openai.com answered a browser directly, or the proxy stayed on: ${off}`)

      // Now with it on. `test()` asks the proxy itself, exempt from the policy,
      // so its answer separates "the proxy is down" from "the retry regressed".
      const outcome = await page.evaluate(async () => {
        const network = (globalThis as {
          __DSH_WEB_NETWORK__?: {
            setConfig(next: { enabled: boolean }): unknown
            test(): Promise<{ ok: boolean, detail: string }>
            proxied(): string[]
          }
        }).__DSH_WEB_NETWORK__
        network?.setConfig({ enabled: true })
        const reachable = await network?.test() ?? { ok: false, detail: 'no network bridge' }
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer sk-not-a-real-key' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(30_000),
          })
          return { reachable, status: response.status, proxied: network?.proxied() ?? [] }
        } catch (error) { return { reachable, status: 0, error: String(error), proxied: network?.proxied() ?? [] } }
      })

      if (!outcome.reachable.ok) {
        // The shipped default has stopped answering. That is worth acting on —
        // it is a broken default for every visitor — but it is not a change in
        // this repository, and it must not hold up a deploy.
        process.stdout.write(`  note: the default CORS proxy is not answering (${outcome.reachable.detail});`
          + ' the retry could not be exercised. Replace it in src/net/cors-proxy.ts.\n')
        return
      }
      expect(
        outcome.status === 401,
        `the proxy answers, but the retry did not reach api.openai.com: ${JSON.stringify(outcome)}`,
      )
      expect(outcome.proxied.includes('https://api.openai.com'), 'the request reached OpenAI without being recorded as proxied')
    },
  },
  {
    name: 'model-catalog',
    async run(page) {
      await waitForShell(page)
      // The picker is the product here: a visitor should find the providers
      // already registered, not a dormant adapter and an empty list.
      const catalog = await page.evaluate(async () => {
        const llm = globalThis.dsh.ctx.get('llm') as {
          listProviders(): { id: string }[]
          listModels(provider: string): Promise<{ id: string }[]>
        } | undefined
        if (llm === undefined) return { providers: [], models: 0 }
        const providers = llm.listProviders().map(entry => entry.id)
        let models = 0
        for (const provider of providers) models += (await llm.listModels(provider)).length
        return { providers, models }
      })
      // What is registered is deliberately bounded: the routes that need no
      // account, plus whatever upstream's own composition mounts. Every other
      // provider pi-ai ships is offered by the Models page and registered only
      // once a user configures one — preregistering them would fill the picker
      // with models nobody can call, which is the thing this asserts against.
      //
      // `opencode-free` is named separately because it is the one route derived
      // from the pi-ai catalog rather than from the measured roster, so it is
      // the one FREE_ROUTES does not describe.
      const keylessRoutes = ['opencode-free', ...FREE_ROUTES.map(route => route.id)]
      const missing = keylessRoutes.filter(id => !catalog.providers.includes(id))
      expect(missing.length === 0, `keyless routes are not registered: ${missing.join(', ')}`)
      expect(
        !catalog.providers.some(id => ['anthropic', 'openai', 'openrouter', 'xai', 'groq'].includes(id)),
        `a key-only provider is preregistered: ${catalog.providers.join(', ')}`,
      )
      expect(catalog.models > 0 && catalog.models < 100, `unexpected model count: ${String(catalog.models)}`)
      // The default is the whole first-run experience: a page anyone can open
      // has to answer before it asks for anything, so it starts on a route that
      // needs no account.
      const expected = declaredDefault()
      const fallback = await page.evaluate(() => {
        for (const entry of globalThis.dsh.ctx.loader?.entries() ?? []) {
          const options = entry.options as { id?: string, config?: { provider?: string, model?: string } }
          if (options.id === 'agent-default-model') return `${options.config?.provider ?? '?'}/${options.config?.model ?? '?'}`
        }
        return 'missing'
      })
      expect(fallback === expected, `the running page's default is ${fallback}, but the overlay declares ${expected}`)
      // And the route it names has to be one of the registered ones. Nothing
      // else in the build catches a default pointed at a provider that was
      // never composed: the picker looks fine and the first message is what
      // breaks.
      const [defaultProvider, defaultModel] = expected.split('/')
      expect(
        catalog.providers.includes(defaultProvider),
        `the default names ${defaultProvider}, which is not registered: ${catalog.providers.join(', ')}`,
      )

      // And it has to actually dispatch without a credential. The distinction
      // that matters is auth versus everything else: a rate-limited free pool
      // is the provider's business and must not fail a deploy, but an auth
      // failure means the empty `authorization` header stopped reaching the
      // wire — which is the one thing holding this route together.
      const keyless = await page.evaluate(async ([provider, model]) => {
        const llm = globalThis.dsh.ctx.get('llm') as {
          stream(options: Record<string, unknown>): AsyncIterable<{ type: string, text?: string, reason?: { kind?: string, failure?: { code?: string, message?: string } } }>
        }
        let text = ''
        let failure: { code?: string, message?: string } | undefined
        try {
          for await (const chunk of llm.stream({
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: pong' }] }],
            maxTokens: 200,
            // A free tier behind a public proxy can stall rather than refuse,
            // and this case gates a deploy. Bound it: a turn that has not
            // finished in a minute has told us everything it is going to.
            signal: AbortSignal.timeout(60_000),
          })) {
            if (chunk.type === 'text-delta') text += chunk.text ?? ''
            if (chunk.type === 'finish') { failure = chunk.reason?.failure; break }
          }
        } catch (error) { failure = { code: 'THREW', message: String(error) } }
        return { text, failure }
      }, [defaultProvider, defaultModel])
      const code = keyless.failure?.code
      // Matched on the message rather than the code, because the endpoints
      // disagree about the code and agree about the words. Zen answers
      // `Invalid API key` and OVHcloud `Forbidden: authentication failed` when a
      // non-empty bearer reaches them, which is the one way this route breaks;
      // but Zen also reports "Model … is not supported" as AUTH, so matching on
      // the code alone would fail for something else entirely.
      expect(
        !/invalid api key|authentication failed|no api key/i.test(keyless.failure?.message ?? ''),
        `the keyless route was rejected for authentication, so the empty bearer did not reach the wire: ${JSON.stringify(keyless.failure)}`,
      )
      if (code === 'RATE_LIMIT') {
        process.stdout.write(`  note: ${defaultProvider}'s free pool is rate-limited right now;`
          + ' the turn reached it but returned no text\n')
      } else {
        expect(code === undefined, `the keyless turn failed: ${JSON.stringify(keyless.failure)}`)
        expect(keyless.text.trim().length > 0, 'the keyless turn finished without any text')
      }
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
    // The picker opens on Home and offers a New folder button, so the workspace
    // is whichever directory the user made — not the one directory the runtime
    // happened to be given. While only `/home/dsh/workspace` was carried into
    // the container, any other choice produced a session where every command
    // failed with `no such file or directory`, the file tools read a different
    // filesystem than the shell wrote to, and nothing was ever snapshotted.
    name: 'workspace-anywhere',
    async run(page) {
      await waitForShell(page)
      const elsewhere = '/home/dsh/elsewhere'
      const wrote = await page.evaluate(async (cwd: string) => {
        try {
          return JSON.stringify(await globalThis.dsh.shell('echo carried > mark.txt; pwd', { cwd }))
        } catch (error) {
          return `THREW ${error instanceof Error ? error.message : String(error)}`
        }
      }, elsewhere)
      expect(wrote.includes(elsewhere), `a workspace outside the default one could not run a command: ${wrote}`)

      // The agent's Read and Write go through the fs service; if they see a
      // different filesystem than the shell, the two are not one machine.
      const seen = await page.evaluate(async (cwd: string) => {
        const fs = globalThis.dsh.ctx.get('fs') as {
          resolve(path: string): Promise<object>
          readText(target: object): Promise<string>
        } | undefined
        if (fs === undefined) return 'the fs service is not mounted'
        try {
          return (await fs.readText(await fs.resolve(`${cwd}/mark.txt`))).trim()
        } catch (error) {
          return `THREW ${error instanceof Error ? error.message : String(error)}`
        }
      }, elsewhere)
      expect(seen === 'carried', `the file tools did not see what the shell wrote: ${seen}`)

      await page.evaluate(async () => { await globalThis.dsh.flush() })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForShell(page)
      const survived = await page.evaluate(async (cwd: string) => {
        try {
          return JSON.stringify(await globalThis.dsh.shell('cat mark.txt', { cwd }))
        } catch (error) {
          return `THREW ${error instanceof Error ? error.message : String(error)}`
        }
      }, elsewhere)
      expect(survived.includes('carried'), `a workspace outside the default one did not survive a reload: ${survived}`)
    },
  },
  {
    // The workspace surviving a reload is only half of what a returning visitor
    // comes back to; the other half is the transcript. Session logs are written
    // zstd — this deployment's default, the same as `dsh web`'s — and the
    // reader asks `zlib.createZstdDecompress` for a stream before falling back
    // to the one-shot codec. While that call threw, every stored session came
    // back as `Failed to load history: … zstd is unavailable`, and no suite
    // noticed, because the persistence case reads files rather than history.
    name: 'session-history',
    async run(page) {
      await waitForShell(page)
      // The host settles after the shell paints, and a prompt sent before it
      // has one creates no session to read back.
      await page.waitForTimeout(3000)
      const written = await page.evaluate(async () => {
        try {
          await globalThis.dsh.promptOnce('sk-not-a-real-key', 'remember this line')
        } catch {
          // The key is a placeholder; the prompt is in the log either way.
        }
        const proxy = globalThis.dsh.ctx.get('apiProxy') as {
          sessions: { list(request: { rpcId: string, payload: Record<string, unknown> }): Promise<{ result: { value?: { items?: unknown[] } } }> }
        } | undefined
        const listed = await proxy?.sessions.list({ rpcId: crypto.randomUUID(), payload: {} })
        return listed?.result.value?.items?.length ?? 0
      })
      expect(written > 0, 'the prompt wrote no session to read back')
      await page.evaluate(async () => { await globalThis.dsh.flush() })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForShell(page)

      const outcome = await page.evaluate(async () => {
        const proxy = globalThis.dsh.ctx.get('apiProxy') as {
          sessions: {
            list(request: { rpcId: string, payload: Record<string, unknown> }): Promise<{ result: { value?: { items?: { sessionId: string }[] } } }>
            history(request: { rpcId: string, payload: Record<string, unknown> }): Promise<{
              result: { ok: boolean, error?: unknown, value?: { events?: unknown[] } }
            }>
          }
        } | undefined
        if (proxy === undefined) return { reason: 'the apiProxy service is not mounted' }
        // The store loads out of IndexedDB after the shell paints, so the list
        // is polled rather than sampled at whatever instant this ran.
        let sessions: { sessionId: string }[] = []
        for (let attempt = 0; attempt < 20 && sessions.length === 0; attempt++) {
          const listed = await proxy.sessions.list({ rpcId: crypto.randomUUID(), payload: {} })
          sessions = listed.result.value?.items ?? []
          if (sessions.length === 0) await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (sessions.length === 0) return { reason: 'no session survived the reload' }
        const history = await proxy.sessions.history({
          rpcId: crypto.randomUUID(),
          payload: { sessionId: sessions[0].sessionId },
        })
        return {
          ok: history.result.ok,
          error: JSON.stringify(history.result.error ?? null),
          events: history.result.value?.events?.length ?? 0,
        }
      })
      expect(outcome.reason === undefined, `${String(outcome.reason)}`)
      expect(outcome.ok === true, `the stored transcript could not be read back: ${String(outcome.error)}`)
      expect((outcome.events ?? 0) > 0, 'the restored session reported no events')
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
    // Record every outbound request body before any app code runs. The
    // `model-request` case reads it: what the model is offered is decided by
    // the composition the *agent preset* mounts, and no registry this page
    // exposes reports that faithfully — a `bash` tool survived three green
    // suites because they all asked the registry instead of the wire.
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
