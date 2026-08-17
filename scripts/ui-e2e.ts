/**
 * The user-path end-to-end test: drive the real UI exactly as a person would.
 *
 * Everything else in this repo can pass while the product is still unusable, so
 * this walks the whole first-run flow through the rendered interface —
 * acknowledge the notice, enter an API key, pick a workspace, send a prompt,
 * read the streamed reply, and make the agent use a tool. It is the check that
 * "no different from `dsh web`" actually holds.
 *
 * Usage: `DEEPSEEK_API_KEY=… npx tsx scripts/ui-e2e.ts [--url <url>] [--headed] [--keep]`
 */

import { chromium, type Browser, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
const shots = '/tmp/dshw-ui'

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the run with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Wait for the app shell to replace the boot screen. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 90_000 })
  await page.waitForTimeout(2500)
}

/**
 * Both onboarding modals mount after the first render — the notice waits on a
 * settings read, and the provider prompt on the model catalog — so each step
 * waits for its own dialog instead of sampling once and skipping.
 */
async function waitFor(page: Page, locator: ReturnType<Page['getByRole']>, timeout = 20_000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

/** Step 1: dismiss the internal-testing notice. */
async function acknowledgeNotice(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /Continue|继续/ })
  if (!await waitFor(page, button)) throw new Error('the internal-testing notice never appeared')
  await button.first().click()
  await button.first().waitFor({ state: 'detached', timeout: 20_000 })
}

/** Step 2: complete provider onboarding with a real key. */
async function configureProvider(page: Page): Promise<void> {
  const field = page.getByRole('textbox', { name: /API key|API 密钥/ })
  if (!await waitFor(page, field)) throw new Error('the provider onboarding prompt never appeared')
  await field.fill(apiKey)
  const save = page.getByRole('button', { name: /Save and continue|保存并继续/ })
  await save.click()
  await save.waitFor({ state: 'detached', timeout: 30_000 })
  await page.waitForTimeout(1500)
}

/** Step 3: open the directory picker and select the starter workspace. */
async function selectWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Choose workspace|选择工作区/ }).click()
  await page.waitForTimeout(2000)
  const dialog = page.getByText(/Select Workspace Directory|选择工作区目录/)
  expect(await dialog.count() > 0, 'the workspace picker did not open')
  // The picker opens at Home; the starter workspace is a directory inside it.
  const entry = page.getByText('workspace', { exact: true })
  if (await entry.count() > 0) {
    await entry.first().dblclick()
    await page.waitForTimeout(1200)
  }
  await page.getByRole('button', { name: /^(Open|打开)$/ }).click()
  await page.waitForTimeout(3000)
}

/** Send a prompt through the composer and wait for the assistant to finish. */
async function sendPrompt(page: Page, text: string, timeoutMs = 180_000): Promise<string> {
  const composer = page.locator('textarea').last()
  await composer.click()
  await composer.fill(text)
  await composer.press('Enter')

  const started = Date.now()
  let previous = ''
  let stableFor = 0
  for (;;) {
    await page.waitForTimeout(2000)
    const body = await page.locator('body').innerText()
    if (body === previous) {
      stableFor += 2000
      // The transcript stops changing once the turn ends.
      if (stableFor >= 8000 && body.includes(text.slice(0, 24))) return body
    } else {
      stableFor = 0
      previous = body
    }
    if (Date.now() - started > timeoutMs) return body
  }
}

/** Run the whole flow. */
async function main(): Promise<void> {
  if (apiKey === '') {
    console.error('DEEPSEEK_API_KEY is required: this test drives a real model turn through the UI.')
    process.exit(2)
  }
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: !headed })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })

    console.log('▶ boot')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForShell(page)
    await page.screenshot({ path: `${shots}-1-boot.png` })

    console.log('▶ onboarding')
    await acknowledgeNotice(page)
    await configureProvider(page)
    await page.screenshot({ path: `${shots}-2-onboarded.png` })

    console.log('▶ workspace')
    await selectWorkspace(page)
    await page.screenshot({ path: `${shots}-3-workspace.png` })
    const afterWorkspace = await page.locator('body').innerText()
    expect(!/Choose a workspace to start/.test(afterWorkspace), 'the composer is still waiting for a workspace')

    console.log('▶ conversation')
    const reply = await sendPrompt(page, 'Reply with exactly the word: pong. Do not use any tools.')
    await page.screenshot({ path: `${shots}-4-reply.png` })
    expect(/pong/i.test(reply), `no assistant reply rendered:\n${reply.slice(-1500)}`)

    console.log('▶ tool use')
    // The marker is written outside the conversation and never appears in the
    // prompt, so the assertion can only pass if the tool really ran and its
    // stdout really reached the model.
    const marker = `dsh-web-${Math.floor(Date.now() % 1e9).toString(36)}${Math.floor(performance.now()).toString(36)}`
    await page.evaluate(async (value: string) => {
      // Written where the agent will look: the runtime's workspace, which is
      // the same filesystem its bash tool and the terminal share. The page's
      // own virtual filesystem holds the harness's state, not the user's files.
      await globalThis.dsh.shell(`echo ${value} > marker.txt`)
    }, marker)
    const toolReply = await sendPrompt(
      page,
      'Use the bash tool to run exactly: cat marker.txt — then tell me the exact contents.',
    )
    await page.screenshot({ path: `${shots}-5-tool.png` })
    expect(toolReply.includes(marker), `the tool call did not return the file contents (${marker}):\n${toolReply.slice(-2500)}`)
    // The contents alone do not prove the shell ran: a model that cannot use
    // Bash will read the file with another tool and answer correctly, which is
    // exactly what hid a completely broken Bash tool behind a green test. The
    // transcript names the tool it used.
    expect(/\bBash\b/.test(toolReply), `the reply never shows a Bash tool call:\n${toolReply.slice(-1500)}`)
    // A Bash card appears whether the call succeeded or died, so its presence
    // proves nothing on its own: a shell that answers every command with
    // `command not found` still renders one, and the model still reaches the
    // answer another way. The transcript must show no such failure.
    expect(
      !/command not found|exit code: 127/i.test(toolReply),
      `the shell rejected the command it was given:\n${toolReply.slice(-1500)}`,
    )

    console.log('▶ file edit')
    const editReply = await sendPrompt(
      page,
      'Create a file named hello.txt in the workspace containing exactly: from-the-browser. Then read it back.',
    )
    await page.screenshot({ path: `${shots}-6-edit.png` })
    const onDisk = await page.evaluate(async () => {
      const result = await globalThis.dsh.shell('cat hello.txt')
      return result.stdout + result.stderr
    })
    expect(/from-the-browser/.test(onDisk), `the agent's file edit did not land: ${onDisk}\n${editReply.slice(-1500)}`)

    console.log('▶ durability')
    // Sessions are the product; a reload has to keep them, their titles, and
    // their transcripts. This is the check that the JSONL log and the virtual
    // filesystem's write-behind mirror actually agree.
    const titleBefore = await page.locator('body').innerText()
    await page.evaluate(async () => { await globalThis.dsh.flush() })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForShell(page)
    await page.waitForTimeout(3000)
    await page.screenshot({ path: `${shots}-7-reloaded.png` })
    const afterReload = await page.locator('body').innerText()
    expect(/workspace/.test(afterReload), `the workspace is gone after a reload:\n${afterReload.slice(0, 800)}`)
    // The sidebar lists the session by its generated title.
    const sessionTitle = /^(.+)\s+now$/m.exec(titleBefore)?.[1]?.trim()
    if (sessionTitle !== undefined && sessionTitle.length > 0) {
      expect(afterReload.includes(sessionTitle), `session "${sessionTitle}" is not listed after a reload`)
    }
    // The session log is the harness's own state, so it lives in the page's
    // filesystem rather than the runtime's, and it is zstd-compressed exactly as
    // `dsh web` writes it. Asking the backend what it can see is the check that
    // matters: a shell `ls` would report its own "no matches" message, which
    // contains the filename and would satisfy a careless assertion.
    const restored = await page.evaluate(async () => {
      const persistence = globalThis.dsh.ctx.get('sessionPersistence') as Record<string, unknown> | undefined
      if (persistence === undefined) return '(the session persistence service is not mounted)'
      const listArtifacts = (persistence.listArtifacts
        ?? (Object.getPrototypeOf(persistence) as Record<string, unknown>).listArtifacts) as
        (() => Promise<{ path: string }[]>) | undefined
      if (listArtifacts === undefined) return '(the backend exposes no artifact listing)'
      const artifacts = await listArtifacts.call(persistence)
      return artifacts.map(artifact => artifact.path).join('\n')
    })
    expect(/session\.jsonl\.zstd$/m.test(restored), `no session log survived the reload:\n${restored}`)

    const fatal = errors.filter(line => !/Failed to load resource|favicon|net::ERR_/.test(line))
    expect(fatal.length === 0, `console errors during the run:\n  ${fatal.join('\n  ')}`)

    console.log(`\n✓ full user path works — screenshots at ${shots}-*.png`)
  } finally {
    await browser?.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
