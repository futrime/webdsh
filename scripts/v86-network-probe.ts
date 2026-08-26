/**
 * Ask every machine whether it actually has a network, and write down what it
 * answered.
 *
 * `src/runtime/guests.ts` records this per machine because it cannot be read
 * off a catalog: the card is the same for all of them, and whether anything
 * uses it is a fact about a disk image somebody else built. Three machines were
 * measured by hand — a Buildroot that takes a lease, an Arch that needs its
 * VirtIO driver loaded first, a Linux 2.6.34 that finds no card at all — and
 * every other machine was described as unmeasured, honestly and unhelpfully.
 *
 * This measures the rest. The difficulty is that most of them have no shell to
 * ask: a Windows desktop or a bootsector demo cannot be sent `ip link`. But
 * there is one question every machine answers the same way, and it is the one
 * that matters — **does anything come out of the card**. A guest whose driver
 * bound to the NE2000 puts frames on the wire within seconds of booting, and
 * one that has no driver puts nothing there, ever. That is read straight off
 * v86's own bus, so it works on a serial Linux and on a 512-byte demo alike.
 *
 * Four outcomes, and each is written as what it is:
 *
 * - **`auto`** — the guest asked for an address before anything was typed at
 *   it. Its network comes up on its own.
 * - **`dhcp`** — it asked once the console attached, which is where a machine's
 *   declared bring-up command runs. It works, but somebody has to run it.
 * - **`link`** — frames, or an interface beyond the loopback, and no DHCP. A
 *   driver is bound and the guest has not asked for an address.
 * - **`silent`** — nothing on the wire. That is *not* the same as "no driver",
 *   and the distinction is the one this script cannot make: an operating system
 *   with no driver and one whose driver nobody configured are identical from
 *   outside, and so is one restored from a saved state that did its networking
 *   before the snapshot. Only a shell can tell them apart.
 * - **`none`** — silence, and a shell that lists no interface beyond the
 *   loopback. This one *is* a missing driver, measured.
 *
 * Where there *is* a shell, it is used as well, because `ip link` distinguishes
 * "no interface" from "an interface nobody switched on" and the frames alone
 * cannot.
 *
 * Usage:
 *   npx tsx scripts/v86-network-probe.ts [<guest-id>...] [--all] [--url <url>]
 *   npx tsx scripts/v86-network-probe.ts --all --out /tmp/network.json
 */

import { writeFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { GUESTS } from '../src/runtime/guests.ts'

const args = process.argv.slice(2)

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const out = valueOf('--out')
const headed = args.includes('--headed')

/**
 * How long to watch a machine that has reached its readiness marker.
 *
 * Twenty-five seconds catches a small guest, whose driver binds while it boots.
 * It does *not* catch a large one, and that is a trap worth naming: readiness
 * here means the screen has settled, which for Haiku or ReactOS is a splash
 * long before the network stack starts. A first sweep at 25s reported eighteen
 * real operating systems as having no driver at all, every one of them at
 * exactly zero frames — which is what a systematically short window looks like,
 * not what eighteen coincidences look like. `--watch` is how the machines that
 * deserve longer get it.
 */
const WATCH_MS = Number(valueOf('--watch') ?? 25_000)

/** What one machine turned out to be. */
interface Answer {
  id: string
  name: string
  console: string
  /**
   * What it turned out to be.
   *
   * `auto` asked for an address on its own; `dhcp` asked once the console ran
   * the bring-up its catalog entry declares; `link` bound a driver and said
   * nothing; `none` is a shell reporting no interface at all; `silent` is the
   * honest non-answer — nothing was sent and there was no shell to ask why.
   */
  verdict: 'auto' | 'dhcp' | 'link' | 'none' | 'silent' | 'unknown'
  frames: number
  dhcp: number
  /** What a shell said, where there was one. */
  interfaces?: string
  /** Why this machine could not be asked at all. */
  skipped?: string
}

/** The bridges this script reads. */
interface MachineBridge {
  ready(timeoutMs?: number): Promise<boolean>
  status(): { running: boolean, failure?: string }
  console: { run(command: string, options?: { timeoutMs?: number }): Promise<{ output: string }> }
  input: { press(key: string): Promise<void> }
}

/** Boot one machine and watch its card. */
async function probe(page: Page, id: string): Promise<Answer> {
  const guest = GUESTS.find(entry => entry.id === id)
  const base: Answer = {
    id,
    name: guest?.name ?? id,
    console: guest?.console ?? '?',
    verdict: 'unknown',
    frames: 0,
    dhcp: 0,
  }
  if (guest === undefined) return { ...base, skipped: 'no such machine' }
  if (!guest.bundled) return { ...base, skipped: 'needs a disk this deployment cannot fetch' }

  await page.goto(`${url}?runtime=v86:${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })

  const started = await page.evaluate(async (budget: number) => {
    const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineBridge }).__DSH_WEB_MACHINE__
    try {
      return await machine.ready(budget)
    } catch {
      return false
    }
  }, Math.min(guest.timeoutMs, 240_000)).catch(() => false)

  if (!started) {
    const failure = await page.evaluate(() => (globalThis as unknown as {
      __DSH_WEB_MACHINE__: MachineBridge
    }).__DSH_WEB_MACHINE__.status().failure).catch(() => undefined)
    return { ...base, skipped: failure ?? 'did not reach its readiness marker' }
  }

  // A settled screen is not a booted machine. Half this catalog is an ISO that
  // stops at `boot:` and waits, and a probe that measured those was measuring a
  // bootloader — TinyCore and OpenWRT, which configure themselves the moment
  // they are up, both looked like machines with no driver at all. So a guest
  // with no serial console is offered the keypress that a person would give it.
  // Harmless where nothing is waiting.
  if (guest.console !== 'serial') {
    await page.evaluate(async () => {
      const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineBridge }).__DSH_WEB_MACHINE__
      await machine.input.press('Enter')
    }).catch(() => undefined)
    await page.waitForTimeout(2000)
  }

  const linkNow = async (): Promise<{ frames: number, dhcp: number }> => page.evaluate(() => (globalThis as unknown as {
    __DSH_WEB_NETWORK__: { machine: { link(): { frames: number, dhcp: number } } }
  }).__DSH_WEB_NETWORK__.machine.link())

  // Watched before anything is typed at it, because that is the difference
  // between a machine whose network comes up on its own and one that needs a
  // command. A guest that is going to ask for a lease asks within seconds of
  // its driver binding.
  const alone = Date.now() + WATCH_MS
  let quiet = await linkNow()
  for (;;) {
    quiet = await linkNow()
    if (quiet.dhcp > 0 || Date.now() > alone) break
    await page.waitForTimeout(1500)
  }

  // Then the shell, where there is one — which also attaches the console, and
  // attaching runs whatever bring-up the machine declares. So this both reads
  // the interface list and *causes* the second measurement below.
  let interfaces: string | undefined
  if (guest.console === 'serial') {
    interfaces = await page.evaluate(async () => {
      const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineBridge }).__DSH_WEB_MACHINE__
      const result = await machine.console.run(
        'ip -o link 2>/dev/null || ifconfig -a 2>/dev/null || ls /sys/class/net',
        { timeoutMs: 45_000 },
      )
      return result.output
    }).catch(() => undefined)
    await page.waitForTimeout(3000)
  }
  const after = await linkNow()

  // A driver that bound to the card but never spoke still counts as a link, and
  // an interface list naming something other than the loopback says so even
  // when nothing was sent at all.
  const beyondLoopback = interfaces !== undefined
    && /\b(eth|en|ne|ec|le|virtio|rtl)\w*\d/.test(interfaces.replace(/\blo\b/g, ''))
  const verdict: Answer['verdict'] = quiet.dhcp > 0
    ? 'auto'
    : after.dhcp > 0
      ? 'dhcp'
      : after.frames > 0 || beyondLoopback
        ? 'link'
        // A shell that answered and listed nothing but the loopback is the only
        // evidence here that amounts to "no driver". Everything else that stays
        // quiet is quiet for a reason this cannot see.
        : interfaces !== undefined ? 'none' : 'silent'

  const answer: Answer = {
    ...base,
    frames: after.frames,
    dhcp: after.dhcp,
    verdict,
    ...(interfaces === undefined ? {} : { interfaces: interfaces.replace(/\s+/g, ' ').slice(0, 200) }),
  }
  return answer
}

const wanted = args.includes('--all')
  ? GUESTS.filter(guest => guest.bundled).map(guest => guest.id)
  : args.filter((argument, index) => !argument.startsWith('--') && !['--url', '--out', '--watch'].includes(args[index - 1] ?? ''))

if (wanted.length === 0) {
  process.stderr.write('name machines to probe, or pass --all\n')
  process.exit(2)
}

const browser = await chromium.launch({ headless: !headed })
const answers: Answer[] = []
try {
  for (const [index, id] of wanted.entries()) {
    // One page per machine, closed after: an emulator left running is a core
    // still spinning, and the next boot would be measured against it.
    const page = await browser.newPage()
    const answer = await probe(page, id).catch((error: unknown): Answer => ({
      id,
      name: id,
      console: '?',
      verdict: 'unknown',
      frames: 0,
      dhcp: 0,
      skipped: error instanceof Error ? error.message : String(error),
    }))
    await page.close()
    answers.push(answer)
    const mark = answer.skipped !== undefined
      ? '·'
      : answer.verdict === 'none' || answer.verdict === 'silent' ? '✗' : '✔'
    process.stdout.write(
      `${mark} [${String(index + 1)}/${String(wanted.length)}] ${answer.id.padEnd(18)} `
      + `${answer.skipped ?? `${answer.verdict}  frames=${String(answer.frames)} dhcp=${String(answer.dhcp)}`}`
      + `${answer.interfaces === undefined ? '' : `\n      ${answer.interfaces}`}\n`,
    )
  }
} finally {
  await browser.close()
}

const counted = (verdict: string): number => answers.filter(answer => answer.skipped === undefined && answer.verdict === verdict).length
process.stdout.write(
  `\n${String(counted('auto'))} come up on their own, ${String(counted('dhcp'))} once their bring-up runs, `
  + `${String(counted('link'))} bind a driver and stay quiet, ${String(counted('none'))} report no interface, `
  + `${String(counted('silent'))} said nothing and had no shell to ask, `
  + `${String(answers.filter(answer => answer.skipped !== undefined).length)} could not be asked\n`,
)
if (out !== undefined) {
  writeFileSync(out, `${JSON.stringify(answers, null, 1)}\n`)
  process.stdout.write(`written to ${out}\n`)
}
