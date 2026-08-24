/**
 * The completeness test: give the agent real work, on every machine, and check
 * the machine afterwards.
 *
 * Every other suite checks a mechanism — a shell that answers, a tool that
 * registers, a screen that draws. This checks the product: that an agent
 * sitting in this page can finish a job, from a one-file errand up to a
 * project with tests it has to get passing, on each of the machines a session
 * can run on.
 *
 * What makes it worth its runtime is that it fails for reasons no mechanism
 * test can see. A shell that answers `command not found` for one verb, a heredoc
 * that loses its last line, a serial console that drops output under load, a
 * DOS prompt that silently truncates at 127 characters — each of those leaves
 * every narrower test green and every real job broken. So nothing here reads
 * the model's reply: the agent says it is done, and then the *machine* is asked.
 *
 * Two deliberate choices:
 *
 * **A named model, not the deployment default.** The default is a keyless route
 * metered at two requests a minute, which is right for a visitor and useless
 * for a fifteen-minute job — a run against it measures the rate limiter. This
 * asks for the route the key belongs to, which is also what a user with a key
 * gets.
 *
 * **The rungs are per machine.** See `scripts/workloads.ts`: the same task on
 * busybox and on the container is a different job, and a rung a machine cannot
 * express is absent rather than failed.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=… npx tsx scripts/workload-e2e.ts
 *     [--url <url>] [--machine node|v86:linux|v86:freedos] [--rung <id>] [--headed]
 */

import { chromium, type Browser, type Page } from 'playwright'
import { MARKER, WORKLOADS, type Machine, type Workload } from './workloads.ts'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
const onlyMachine = valueOf('--machine')
const onlyRung = valueOf('--rung')

/** The route a key of this shape belongs to, and its strongest general model. */
const PROVIDER = 'deepseek-official'
const MODEL = process.env.DSH_WORKLOAD_MODEL ?? 'deepseek-v4-flash'

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** One rung's outcome, for the report at the end. */
interface Outcome {
  id: string
  machine: Machine
  scale: string
  passed: boolean
  seconds: number
  detail: string
}

/** Wait for the app shell to replace the boot screen. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })
  await page.waitForTimeout(2000)
}

/** Wait until the emulated machine has reached its own readiness marker. */
async function machineReady(page: Page, timeoutMs: number): Promise<boolean> {
  return page.evaluate(async (budget: number) => {
    const machine = (globalThis as unknown as {
      __DSH_WEB_MACHINE__: { ready(timeoutMs?: number): Promise<boolean> }
    }).__DSH_WEB_MACHINE__
    return machine.ready(budget)
  }, timeoutMs)
}

/**
 * Run one command on the machine the session is on, and return what it said.
 *
 * The container's shell and an emulated machine's console are different things
 * reached different ways, and the check has to reach whichever one the agent
 * was working in — asking the page's shell about a file the agent wrote inside
 * FreeDOS would report it missing every time.
 * @param page - the loaded app.
 * @param machine - the machine this session is on.
 * @param command - the command, in that machine's own shell.
 * @returns its merged output.
 */
async function ask(page: Page, machine: Machine, command: string): Promise<string> {
  if (machine === 'node') {
    return page.evaluate(async (script: string) => {
      const result = await globalThis.dsh.shell(script)
      return `${result.stdout}${result.stderr}`
    }, command)
  }
  return page.evaluate(async (script: string) => {
    const handle = (globalThis as unknown as {
      __DSH_WEB_MACHINE__: {
        console: { run(command: string, options?: { timeoutMs?: number }): Promise<{ output: string }> }
      }
    }).__DSH_WEB_MACHINE__
    const result = await handle.console.run(script, { timeoutMs: 120_000 })
    return result.output
  }, command)
}

/**
 * Drive one complete agent turn on the session's machine.
 *
 * Through the same RPC the composer uses, because that is the path a person's
 * prompt takes: anything that works here works for them, and anything that
 * only works through a private entry point is not a feature they have.
 * @param page - the loaded app.
 * @param prompt - the job.
 * @param timeoutMs - how long the turn may run.
 * @returns the assistant's text, and whether the turn ended on its own.
 */
async function work(page: Page, prompt: string, timeoutMs: number): Promise<{ reply: string, finished: boolean }> {
  return page.evaluate(async ([key, provider, model, text, budget]: [string, string, string, string, number]) => {
    const ctx = (globalThis as any).dsh.ctx
    await ctx.get('credentials').set('DEEPSEEK_API_KEY', key)
    const proxy = ctx.get('apiProxy')

    const created = await proxy.sessions.create({ rpcId: crypto.randomUUID(), payload: {} })
    if (!created.result.ok) throw new Error(`session.create: ${JSON.stringify(created.result.error)}`)
    const sessionId = created.result.value.sessionId

    const selected = await proxy.sessions.selectModel({
      rpcId: crypto.randomUUID(),
      payload: { sessionId, provider, model },
    })
    if (!selected.result.ok) throw new Error(`session.selectModel: ${JSON.stringify(selected.result.error)}`)

    const abort = new AbortController()
    const frames = proxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, abort.signal)
    let reply = ''
    let finished = false
    const collected = (async () => {
      for await (const frame of frames) {
        const event = frame.payload.event
        if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
          reply += event.data.chunk.text ?? ''
        }
        if (event?.type === 'turn/end') {
          finished = true
          break
        }
      }
    })()

    const prompted = await proxy.sessions.prompt({
      rpcId: crypto.randomUUID(),
      payload: { sessionId, content: [{ type: 'text', text }] },
    })
    if (!prompted.result.ok) {
      abort.abort()
      throw new Error(`session.prompt: ${JSON.stringify(prompted.result.error)}`)
    }

    await Promise.race([collected, new Promise(resolve => setTimeout(resolve, budget))])
    abort.abort()
    return { reply, finished }
  }, [apiKey, PROVIDER, MODEL, prompt, timeoutMs] as [string, string, string, string, number])
}

/**
 * Run one rung and check the machine afterwards.
 * @param page - a page already on the right machine.
 * @param workload - the rung.
 * @returns what happened.
 */
async function runRung(page: Page, workload: Workload): Promise<Outcome> {
  const started = Date.now()
  const seconds = (): number => Math.round((Date.now() - started) / 1000)
  let turn: { reply: string, finished: boolean }
  try {
    turn = await work(page, workload.prompt, workload.timeoutMs)
  } catch (error) {
    return {
      id: workload.id,
      machine: workload.machine,
      scale: workload.scale,
      passed: false,
      seconds: seconds(),
      detail: `the turn never ran: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Checked whatever the turn did. A turn that ran out of budget may still
  // have finished the job, and one that ended tidily may have finished
  // nothing; the machine is the only thing that knows.
  const failures: string[] = []
  for (const check of workload.checks) {
    const output = await ask(page, workload.machine, check.command).catch(
      (error: unknown) => `<the machine did not answer: ${error instanceof Error ? error.message : String(error)}>`,
    )
    if (!check.expect.test(output)) {
      failures.push(`${check.because} — \`${check.command}\` said: ${output.trim().slice(0, 220) || '(nothing)'}`)
    }
  }

  return {
    id: workload.id,
    machine: workload.machine,
    scale: workload.scale,
    passed: failures.length === 0,
    seconds: seconds(),
    detail: failures.length === 0
      ? `${turn.finished ? 'finished' : 'ran out of time but the work is there'}`
      : failures.join('\n      '),
  }
}

/** Load the page onto one machine and wait until it can be worked on. */
async function boardMachine(page: Page, machine: Machine): Promise<void> {
  const runtime = machine === 'node' ? 'node' : machine
  await page.goto(`${url}?runtime=${runtime}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForShell(page)
  if (machine === 'node') {
    // The container answers before it is asked anything real; this is the
    // cheapest proof that it is up rather than a fixed wait.
    await page.waitForFunction(
      async () => (await globalThis.dsh.shell('echo up')).stdout.includes('up'),
      undefined,
      { timeout: 180_000 },
    )
    return
  }
  const ready = await machineReady(page, 300_000)
  if (!ready) throw new Error(`${machine} never reached a prompt`)
}

/** Run the ladder. */
async function main(): Promise<void> {
  if (apiKey === '') {
    console.error('DEEPSEEK_API_KEY is required: this suite gives a real model real jobs.')
    process.exit(2)
  }

  const wanted = WORKLOADS
    .filter(workload => onlyMachine === undefined || workload.machine === onlyMachine)
    .filter(workload => onlyRung === undefined || workload.id === onlyRung)
  const machines = [...new Set(wanted.map(workload => workload.machine))]

  let browser: Browser | undefined
  const outcomes: Outcome[] = []
  try {
    browser = await chromium.launch({ headless: !headed })
    for (const machine of machines) {
      process.stdout.write(`\n══ ${machine} ══\n`)
      for (const workload of wanted.filter(entry => entry.machine === machine)) {
        // A fresh context per rung: the rungs share file names on purpose (a
        // check that passed on the previous rung's leftovers would prove
        // nothing), and a fresh browser context is the only way to be sure the
        // machine starts empty.
        const context = await browser.newContext()
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        process.stdout.write(`▶ ${workload.id} (${workload.scale})\n`)
        try {
          await boardMachine(page, machine)
          const outcome = await runRung(page, workload)
          outcomes.push(outcome)
          process.stdout.write(outcome.passed
            ? `  ✓ ${workload.id} in ${String(outcome.seconds)}s — ${outcome.detail}\n`
            : `  ✗ ${workload.id} after ${String(outcome.seconds)}s\n      ${outcome.detail}\n`)
        } catch (error) {
          outcomes.push({
            id: workload.id,
            machine,
            scale: workload.scale,
            passed: false,
            seconds: 0,
            detail: error instanceof Error ? error.message : String(error),
          })
          process.stdout.write(`  ✗ ${workload.id}: ${error instanceof Error ? error.message : String(error)}\n`)
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser?.close()
  }

  process.stdout.write('\n── what the agent finished, by machine ──\n')
  for (const machine of machines) {
    const mine = outcomes.filter(outcome => outcome.machine === machine)
    const done = mine.filter(outcome => outcome.passed)
    process.stdout.write(`  ${machine.padEnd(13)} ${String(done.length)}/${String(mine.length)}  `
      + `${mine.map(outcome => `${outcome.passed ? '✓' : '✗'}${outcome.id}`).join(' ')}\n`)
  }

  const failed = outcomes.filter(outcome => !outcome.passed)
  if (failed.length > 0) {
    process.stdout.write(`\n✗ ${String(failed.length)} of ${String(outcomes.length)} did not finish\n`)
    process.exit(1)
  }
  process.stdout.write(`\n✓ the agent finished all ${String(outcomes.length)} jobs, on every machine\n`)
  void MARKER
}

await main()
