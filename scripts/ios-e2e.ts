/**
 * iOS/WebKit compatibility, from first boot through a durable workspace.
 *
 * WebKit formats native Object/Array constructors over several lines. That is
 * the engine behavior which used to make dsh's strict JSON snapshot reject
 * every ordinary session header. The stream, cancellation and deferred APIs
 * removed before navigation also reproduce older Safari and prove the classic
 * compatibility bootstrap runs before the imported module graph.
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
    // bootstrap must put every API back before any imported dsh package runs.
    await context.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(Object, 'hasOwn', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(Response, 'json', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(ReadableStream.prototype, 'values', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: undefined })
    })

    const page = await context.newPage()
    const compatibilityErrors: string[] = []
    const incompatibility = /losslessly JSON|unsupported JSON schema|randomUUID|Object\.hasOwn|Response\.json|withResolvers|AbortSignal\.(?:any|timeout)|throwIfAborted|ReadableStream.*(?:values|iterator)|not (?:async )?iterable|Symbol\.(?:asyncIterator|(?:async)?Dispose)|Importing a module script failed/i
    page.on('console', (message) => {
      if (incompatibility.test(message.text())) compatibilityErrors.push(message.text())
    })
    page.on('pageerror', (error) => {
      if (incompatibility.test(error.message)) compatibilityErrors.push(error.message)
    })

    console.log(`▶ boot an iPhone in ${browserName} with legacy browser APIs missing`)
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
      const timed = AbortSignal.timeout(0)
      await new Promise<void>((resolve, reject) => {
        if (timed.aborted) return resolve()
        timed.addEventListener('abort', () => { resolve() }, { once: true })
        window.setTimeout(() => { reject(new Error('AbortSignal.timeout did not abort')) }, 1_000)
      })
      const throwProbe = new AbortController()
      throwProbe.abort('throw-if-aborted')
      let threwOnAbort = false
      try {
        throwProbe.signal.throwIfAborted()
      } catch {
        threwOnAbort = true
      }
      const disposal = Symbol as SymbolConstructor & { dispose?: symbol, asyncDispose?: symbol }
      const uuid = crypto.randomUUID()
      const jsonResponse = Response.json({ restored: true }, { status: 201, headers: { 'x-ios-probe': 'yes' } })
      type IterableStream<T> = ReadableStream<T> & {
        values(options?: { preventCancel?: boolean }): AsyncIterableIterator<T>
        [Symbol.asyncIterator](): AsyncIterableIterator<T>
      }
      const naturallyEnded = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('first')
          controller.enqueue('second')
          controller.close()
        },
      }) as IterableStream<string>
      const naturalIterator = naturallyEnded[Symbol.asyncIterator]()
      const naturalFirst = await naturalIterator.next()
      const naturalSecond = await naturalIterator.next()
      const naturalEnd = await naturalIterator.next()

      let cancelled = 0
      const cancelledByReturn = new ReadableStream<string>({
        start(controller) { controller.enqueue('cancel-me') },
        cancel() { cancelled += 1 },
      }) as IterableStream<string>
      const cancellingIterator = cancelledByReturn[Symbol.asyncIterator]()
      await cancellingIterator.next()
      const cancelledReturn = await cancellingIterator.return?.()

      let preventedCancellation = 0
      const keptByReturn = new ReadableStream<string>({
        start(controller) { controller.enqueue('keep-me') },
        cancel() { preventedCancellation += 1 },
      }) as IterableStream<string>
      const keepingIterator = keptByReturn.values({ preventCancel: true })
      await keepingIterator.next()
      const keptReturn = await keepingIterator.return?.()
      const readablePrototype = ReadableStream.prototype as unknown as {
        values?: unknown
        [Symbol.asyncIterator]?: unknown
      }
      return {
        uuid,
        hasOwn: Object.hasOwn({ own: true }, 'own') && !Object.hasOwn(Object.create({ inherited: true }), 'inherited'),
        jsonResponse: {
          status: jsonResponse.status,
          contentType: jsonResponse.headers.get('content-type'),
          probe: jsonResponse.headers.get('x-ios-probe'),
          value: await jsonResponse.json(),
        },
        deferredValue,
        combinedAborted: combined.aborted,
        combinedReason: combined.reason,
        timeoutAborted: timed.aborted,
        threwOnAbort,
        dispose: typeof disposal.dispose,
        asyncDispose: typeof disposal.asyncDispose,
        stream: {
          values: typeof readablePrototype.values,
          iterator: typeof readablePrototype[Symbol.asyncIterator],
          naturalChunks: [naturalFirst.value, naturalSecond.value],
          naturalDone: naturalEnd.done === true,
          naturalReleased: !naturallyEnded.locked,
          cancelled,
          cancelledDone: cancelledReturn?.done === true,
          cancelledReleased: !cancelledByReturn.locked,
          preventedCancellation,
          keptDone: keptReturn?.done === true,
          keptReleased: !keptByReturn.locked,
        },
        objectSource: Function.prototype.toString.call(Object),
        warnings: ((globalThis as { __DSH_WARNINGS__?: string[] }).__DSH_WARNINGS__ ?? []),
      }
    })
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(compatibility.uuid), 'crypto.randomUUID was not restored')
    expect(compatibility.hasOwn, 'Object.hasOwn was not restored')
    expect(compatibility.jsonResponse.status === 201, 'Response.json did not preserve the response status')
    expect(compatibility.jsonResponse.contentType === 'application/json', 'Response.json did not set the JSON content type')
    expect(compatibility.jsonResponse.probe === 'yes', 'Response.json did not preserve custom headers')
    expect(compatibility.jsonResponse.value.restored === true, 'Response.json did not serialize its payload')
    expect(compatibility.deferredValue === 'settled', 'Promise.withResolvers was not restored')
    expect(compatibility.combinedAborted && compatibility.combinedReason === 'ios-compat', 'AbortSignal.any was not restored')
    expect(compatibility.timeoutAborted, 'AbortSignal.timeout was not restored')
    expect(compatibility.threwOnAbort, 'AbortSignal.prototype.throwIfAborted was not restored')
    expect(compatibility.dispose === 'symbol' && compatibility.asyncDispose === 'symbol', 'disposal symbols are unavailable')
    expect(compatibility.stream.values === 'function', 'ReadableStream.prototype.values was not restored')
    expect(compatibility.stream.iterator === 'function', 'ReadableStream async iteration was not restored')
    expect(JSON.stringify(compatibility.stream.naturalChunks) === '["first","second"]', 'ReadableStream async iteration changed chunk order')
    expect(compatibility.stream.naturalDone, 'ReadableStream async iteration did not end naturally')
    expect(compatibility.stream.naturalReleased, 'a naturally ended ReadableStream kept its reader lock')
    expect(compatibility.stream.cancelled === 1, 'iterator.return() did not cancel its ReadableStream by default')
    expect(compatibility.stream.cancelledDone, 'iterator.return() did not finish its iterator')
    expect(compatibility.stream.cancelledReleased, 'iterator.return() did not release its reader lock')
    expect(compatibility.stream.preventedCancellation === 0, 'values({ preventCancel: true }) cancelled its ReadableStream')
    expect(compatibility.stream.keptDone, 'the preventCancel iterator did not finish on return()')
    expect(compatibility.stream.keptReleased, 'the preventCancel iterator did not release its reader lock')
    expect(!compatibility.warnings.some(warning => incompatibility.test(warning)), 'a compatibility API disabled a host row')
    if (browserName === 'webkit') {
      expect(compatibility.objectSource.includes('\n'), 'the WebKit native-source regression was not exercised')
    }

    console.log('▶ Files and bounded host requests survive the missing stream iterator')
    const transport = await page.evaluate(async () => {
      type Outcome<T> =
        | { kind: 'fulfilled', value: T }
        | { kind: 'rejected', error: string }
        | { kind: 'timeout' }
      type RpcBody = {
        type?: string
        rpcId?: string
        result?: { ok?: boolean, value?: Record<string, unknown> }
      }

      const files = (globalThis as unknown as {
        __DSH_WEB_FILES__: {
          root(): string
          list(path: string): Promise<{ name: string }[]>
        }
      }).__DSH_WEB_FILES__
      let filesTimer = 0
      const filesOutcome = await Promise.race<Outcome<string[]>>([
        files.list(files.root()).then<Outcome<string[]>, Outcome<string[]>>(
          entries => ({ kind: 'fulfilled', value: entries.map(entry => entry.name) }),
          error => ({ kind: 'rejected', error: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise<Outcome<string[]>>((resolve) => {
          filesTimer = window.setTimeout(() => { resolve({ kind: 'timeout' }) }, 45_000)
        }),
      ])
      window.clearTimeout(filesTimer)

      const methods = ['workspace.list', 'agentPreset.list', 'llm.providers'] as const
      const requests = await Promise.all(methods.map(async (method) => {
        const rpcId = crypto.randomUUID()
        let requestTimer = 0
        const request = fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
        }).then(async (response) => {
          const body = await response.json() as RpcBody
          const value = body.result?.value
          const shape = method === 'workspace.list'
            ? Array.isArray(value?.items)
            : method === 'agentPreset.list'
              ? Array.isArray(value?.presets)
              : Array.isArray(value?.providers)
          return {
            status: response.status,
            responseType: body.type,
            responseRpcId: body.rpcId,
            ok: body.result?.ok === true,
            shape,
          }
        }).then<Outcome<{
          status: number
          responseType: string | undefined
          responseRpcId: string | undefined
          ok: boolean
          shape: boolean
        }>, Outcome<never>>(
          value => ({ kind: 'fulfilled', value }),
          error => ({ kind: 'rejected', error: error instanceof Error ? error.message : String(error) }),
        )
        const outcome = await Promise.race([request, new Promise<Outcome<never>>((resolve) => {
          requestTimer = window.setTimeout(() => { resolve({ kind: 'timeout' }) }, 5_000)
        })])
        window.clearTimeout(requestTimer)
        return { method, rpcId, outcome }
      }))
      return { files: filesOutcome, requests }
    })
    expect(transport.files.kind === 'fulfilled', `the Files bridge did not settle: ${JSON.stringify(transport.files)}`)
    for (const request of transport.requests) {
      expect(request.outcome.kind !== 'timeout', `${request.method} remained pending past its deadline`)
      expect(request.outcome.kind !== 'rejected', `${request.method} rejected: ${JSON.stringify(request.outcome)}`)
      if (request.outcome.kind !== 'fulfilled') continue
      expect(request.outcome.value.status === 200, `${request.method} returned HTTP ${String(request.outcome.value.status)}`)
      expect(request.outcome.value.responseType === 'server-response', `${request.method} returned the wrong envelope type`)
      expect(request.outcome.value.responseRpcId === request.rpcId, `${request.method} returned the wrong rpcId`)
      expect(request.outcome.value.ok, `${request.method} returned an unsuccessful RPC result`)
      expect(request.outcome.value.shape, `${request.method} returned the wrong value shape`)
    }

    console.log('▶ workspace, provider and preset UI loads through the same host requests')
    const notice = page.getByRole('button', { name: 'Continue' })
    // The notice waits on an asynchronous settings read and can mount after the
    // shell itself. Sampling once races it on faster Chromium builds.
    await notice.first().waitFor({ state: 'visible', timeout: 20_000 })
    await notice.first().click()
    await notice.first().waitFor({ state: 'detached', timeout: 20_000 })
    const preset = page.getByRole('button', { name: 'Standard mode' })
    await preset.waitFor({ state: 'visible', timeout: 15_000 })
    await preset.click()
    await page.getByText('PTC mode', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByText('Minimal mode', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.keyboard.press('Escape')

    console.log('▶ the real picker lists the runtime filesystem and creates a session')
    const filesBacking = await page.evaluate(async () => {
      const files = (globalThis as unknown as {
        __DSH_WEB_FILES__: { backing(): Promise<'runtime' | 'page'> }
      }).__DSH_WEB_FILES__
      await globalThis.dsh.shell('mkdir -p /home/dsh/ios-picker-probe')
      return files.backing()
    })
    expect(filesBacking === 'runtime', 'the runtime-only picker regression was not exercised')
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    await dialog.getByRole('button', { name: 'workspace', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await dialog.getByRole('button', { name: 'ios-picker-probe', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await dialog.getByRole('button', { name: 'workspace' }).click()
    await dialog.getByRole('button', { name: 'Open' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
    expect(!(await page.locator('body').innerText()).includes('Choose a workspace to start'), 'opening the workspace did not create a session')

    console.log('▶ the settings client receives the model-provider roster')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByText('Settings', { exact: true }).click()
    await page.getByText('Models', { exact: true }).click()
    await page.getByText('OpenCode Zen (free)', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByText('DeepSeek', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })

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

    console.log(`\n✓ ${browserName} loads presets/providers, creates a session and keeps its workspace through the compatibility bootstrap`)
  } finally {
    await browser?.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
