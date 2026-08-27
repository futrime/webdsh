/**
 * Re-ask whether OpenHarmony could boot on this build's emulated PC.
 *
 * `docs/openharmony-on-v86.md` says it cannot, and gives three reasons. A
 * negative result written into a document is a negative result that goes stale
 * silently: OpenHarmony gains board support regularly, and the day it gains a
 * 32-bit x86 one, the honest thing for this repository to do is notice.
 *
 * So the reasons are checked rather than asserted. Each one is read from the
 * place that decides it — upstream's own repository contents, and the vendored
 * emulator's own Readme — and the script fails when any of them stops being
 * true. A failure here is not a bug; it is the answer changing, and an
 * invitation to reopen the question.
 *
 * `npm run openharmony:check`. It needs the network, and says so rather than
 * passing when it could not look.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One thing that has to stay true for the conclusion to stand. */
interface Reason {
  name: string
  /** What was expected, in the form the report prints. */
  expectation: string
  check(): Promise<{ holds: boolean, detail: string }>
}

/**
 * List a directory of a GitHub repository.
 * @param repo - `owner/name`.
 * @param path - the directory, empty for the root.
 * @returns the entry names.
 */
async function contents(repo: string, path: string): Promise<string[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'webdsh-openharmony-probe' },
  })
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for ${repo}/${path}`)
  const entries = await response.json() as { name: string, type: string }[]
  return entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name)
}

/** Anything that names a 32-bit x86, which is the only kind v86 has. */
const THIRTY_TWO_BIT_X86 = /^(?:x86|i[3-6]86|ia32)(?:$|[_-])/i

const reasons: Reason[] = [
  {
    name: 'boards',
    expectation: 'openharmony/device_qemu has no 32-bit x86 board',
    async check() {
      const boards = await contents('openharmony/device_qemu', '')
      const x86 = boards.filter((board) => /x86|i[3-6]86/i.test(board))
      const thirtyTwo = x86.filter((board) => THIRTY_TWO_BIT_X86.test(board) && !/64/.test(board))
      return {
        holds: thirtyTwo.length === 0,
        detail: `boards: ${boards.join(', ')}`
          + (thirtyTwo.length === 0
            ? `\n    the only x86 board is ${x86.join(', ')}, which is 64-bit`
            : `\n    A 32-BIT X86 BOARD NOW EXISTS: ${thirtyTwo.join(', ')}`),
      }
    },
  },
  {
    name: 'liteos-a',
    expectation: 'kernel_liteos_a has no x86 architecture port',
    async check() {
      const arches = await contents('openharmony/kernel_liteos_a', 'arch')
      const x86 = arches.filter((arch) => /x86|i[3-6]86/i.test(arch))
      return {
        holds: x86.length === 0,
        detail: `architectures: ${arches.join(', ')}`
          + (x86.length === 0 ? '' : `\n    AN X86 PORT NOW EXISTS: ${x86.join(', ')}`),
      }
    },
  },
  {
    name: 'liteos-m',
    expectation: 'kernel_liteos_m has no x86 architecture port',
    async check() {
      const arches = await contents('openharmony/kernel_liteos_m', 'arch')
      const x86 = arches.filter((arch) => /x86|i[3-6]86/i.test(arch))
      return {
        holds: x86.length === 0,
        detail: `architectures: ${arches.join(', ')}`
          + (x86.length === 0 ? '' : `\n    AN X86 PORT NOW EXISTS: ${x86.join(', ')}`),
      }
    },
  },
  {
    name: 'v86',
    expectation: 'the vendored v86 still cannot run a 64-bit kernel',
    // Read from the copy this build actually ships rather than from upstream's
    // master, because what matters is the emulator in `node_modules`, which is
    // the one a visitor's browser runs.
    check() {
      const readme = readFileSync(resolve(root, 'node_modules/v86/Readme.md'), 'utf8')
      const says = /64-bit kernels are not supported/i.test(readme)
      const missing = /- +64-bit extensions/i.test(readme)
      return Promise.resolve({
        holds: says && missing,
        detail: says && missing
          ? 'Readme.md lists "64-bit extensions" as missing and says "64-bit kernels are not supported"'
          : 'V86 NO LONGER SAYS THIS — it may have gained long mode',
      })
    },
  },
]

process.stdout.write('Can OpenHarmony boot on this build\'s emulated PC?\n\n')

let held = 0
let broken = 0
for (const reason of reasons) {
  try {
    const result = await reason.check()
    if (result.holds) {
      held++
      process.stdout.write(`  ✔ ${reason.name}: ${reason.expectation}\n    ${result.detail}\n`)
    } else {
      broken++
      process.stdout.write(`  ✘ ${reason.name}: ${reason.expectation}\n    ${result.detail}\n`)
    }
  } catch (error) {
    broken++
    process.stdout.write(`  ? ${reason.name}: could not check — ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

process.stdout.write('\n')
if (broken === 0) {
  process.stdout.write(
    `All ${String(held)} reasons still hold: OpenHarmony has no 32-bit x86 target, and v86 runs nothing else.\n`
    + 'See docs/openharmony-on-v86.md for what would have to change.\n',
  )
  process.exit(0)
}
process.stdout.write(
  `${String(broken)} of ${String(reasons.length)} reasons no longer hold, or could not be read.\n`
  + 'If upstream has added a 32-bit x86 target, docs/openharmony-on-v86.md is out of date and the\n'
  + 'question is worth reopening. If the network was the problem, this proves nothing either way.\n',
)
process.exit(1)
