/**
 * iOS/WebKit compatibility, from first boot through a durable workspace.
 *
 * WebKit formats native Object/Array constructors over several lines. That is
 * the engine behavior which used to make dsh's strict JSON snapshot reject
 * every ordinary session header. The two APIs removed before navigation also
 * reproduce Safari before 17.4 and prove the classic compatibility bootstrap
 * runs before the imported module graph.
 *
 * Usage: `npx tsx scripts/ios-e2e.ts [--url <url>] [--browser webkit|chromium] [--headed]`
 */

import { chromium, webkit, type Browser } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const browserName = valueOf('--browser') ?? 'webkit'
const headed = args.includes('--headed')
const IOS_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1'

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the run with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Run the whole check. */
async function main(): Promise<void> {
  if (browserName !== 'webkit' && browserName !== 'chromium') {
    throw new Error(`unsupported --browser ${browserName}; expected webkit or chromium`)
  }

  let browser: Browser | undefined
  try {
    const browserType = browserName === 'webkit' ? webkit : chromium
    browser = await browserType.launch({ headless: !headed })
    const context = await browser.newContext({
      userAgent: IOS_USER_AGENT,
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    })
    // These assignments happen before index.html. Its classic compatibility
    // bootstrap must put both APIs back before any imported dsh package runs.
    await context.addInitScript(() => {
      Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined })
    })

    const page = await context.newPage()
    const compatibilityErrors: string[] = []
    const incompatibility = /losslessly JSON|unsupported JSON schema|withResolvers|AbortSignal\.any|Symbol\.(?:async)?Dispose|Importing a module script failed/i
    page.on('console', (message) => {
      if (incompatibility.test(message.text())) compatibilityErrors.push(message.text())
    })
    page.on('pageerror', (error) => {
      if (incompatibility.test(error.message)) compatibilityErrors.push(error.message)
    })

    console.log(`▶ boot an iPhone in ${browserName} with pre-17.4 APIs missing`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return root !== null && root.childElementCount > 0 && globalThis.dsh !== undefined
    }, undefined, { timeout: 90_000 })

    console.log('▶ the compatibility bootstrap precedes every dsh module')
    const compatibility = await page.evaluate(async () => {
      const deferred = (Promise as PromiseConstructor & {
        withResolvers<T>(): {
          promise: Promise<T>
          resolve(value: T | PromiseLike<T>): void
          reject(reason?: unknown): void
        }
      }).withResolvers<string>()
      queueMicrotask(() => { deferred.resolve('settled') })
      const deferredValue = await deferred.promise
      const first = new AbortController()
      const second = new AbortController()
      const combined = AbortSignal.any([first.signal, second.signal])
      second.abort('ios-compat')
      const disposal = Symbol as SymbolConstructor & { dispose?: symbol, asyncDispose?: symbol }
      return {
        deferredValue,
        combinedAborted: combined.aborted,
        combinedReason: combined.reason,
        dispose: typeof disposal.dispose,
        asyncDispose: typeof disposal.asyncDispose,
        objectSource: Function.prototype.toString.call(Object),
        warnings: ((globalThis as { __DSH_WARNINGS__?: string[] }).__DSH_WARNINGS__ ?? []),
      }
    })
    expect(compatibility.deferredValue === 'settled', 'Promise.withResolvers was not restored')
    expect(compatibility.combinedAborted && compatibility.combinedReason === 'ios-compat', 'AbortSignal.any was not restored')
    expect(compatibility.dispose === 'symbol' && compatibility.asyncDispose === 'symbol', 'disposal symbols are unavailable')
    expect(!compatibility.warnings.some(warning => incompatibility.test(warning)), 'a compatibility API disabled a host row')
    if (browserName === 'webkit') {
      expect(compatibility.objectSource.includes('\n'), 'the WebKit native-source regression was not exercised')
    }

    console.log('▶ the real picker lists the VFS and creates a session')
    const notice = page.getByRole('button', { name: 'Continue' })
    // The notice waits on an asynchronous settings read and can mount after the
    // shell itself. Sampling once races it on faster Chromium builds.
    await notice.first().waitFor({ state: 'visible', timeout: 20_000 })
    await notice.first().click()
    await notice.first().waitFor({ state: 'detached', timeout: 20_000 })
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    expect((await dialog.textContent())?.includes('workspace') === true, 'the directory picker did not list the workspace')
    await dialog.getByRole('button', { name: 'workspace' }).click()
    await dialog.getByRole('button', { name: 'Open' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
    expect(!(await page.locator('body').innerText()).includes('Choose a workspace to start'), 'opening the workspace did not create a session')

    console.log('▶ the emitted code worker accepts a foreign-realm JSON value')
    // The worker is a separately emitted CommonJS asset. Vite's ordinary
    // module transform does not touch `?url` assets, so this catches a missed
    // copy of the same native-source guard as well as the main session path.
    const codeResult = await page.evaluate(async () => {
      const runtime = globalThis.dsh.ctx.get('codeRuntime') as {
        run(request: { program: string, bindings: unknown[] }): Promise<{
          value?: unknown
          error?: { kind: string, message: string }
        }>
      }
      return runtime.run({
        bindings: [],
        program: `
          const frame = document.createElement('iframe')
          document.body.append(frame)
          const value = frame.contentWindow.JSON.parse('{"engine":"webkit","nested":[1,true]}')
          frame.remove()
          return value
        `,
      })
    })
    expect(codeResult.error === undefined, `the code worker rejected plain JSON: ${JSON.stringify(codeResult.error)}`)
    expect(JSON.stringify(codeResult.value) === '{"engine":"webkit","nested":[1,true]}', 'the code worker changed its JSON result')

    console.log('▶ the shell and agent file service share the selected backend')
    const result = await page.evaluate(async () => {
      const fs = globalThis.dsh.ctx.get('fs') as {
        resolve(path: string): Promise<object>
        readText(target: object): Promise<string>
      }
      const shell = await globalThis.dsh.shell('echo webkit-workspace > ios-probe.txt && cat ios-probe.txt')
      const service = await fs.readText(await fs.resolve('/home/dsh/workspace/ios-probe.txt'))
      return { shell: shell.stdout.trim(), service: service.trim() }
    })
    expect(result.shell === 'webkit-workspace', `the shell failed: ${result.shell}`)
    expect(result.service === 'webkit-workspace', 'the fs service did not see the shell write')

    console.log('▶ the selected backend survives a reload')
    await page.evaluate(async () => { await globalThis.dsh.flush() })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => globalThis.dsh !== undefined, undefined, { timeout: 90_000 })
    const restored = await page.evaluate(async () => {
      const fs = globalThis.dsh.ctx.get('fs') as {
        resolve(path: string): Promise<object>
        readText(target: object): Promise<string>
      }
      const service = await fs.readText(await fs.resolve('/home/dsh/workspace/ios-probe.txt'))
      const shell = await globalThis.dsh.shell('cat ios-probe.txt')
      return { service: service.trim(), shell: shell.stdout.trim() }
    })
    expect(Object.values(restored).every(value => value === 'webkit-workspace'), `the workspace did not survive reload: ${JSON.stringify(restored)}`)
    expect(compatibilityErrors.length === 0, `compatibility errors reached the console: ${compatibilityErrors.join(' | ')}`)

    console.log(`\n✓ ${browserName} creates a session and keeps its workspace, including the pre-17.4 bootstrap path`)
  } finally {
    await browser?.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
