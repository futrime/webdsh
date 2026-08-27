/**
 * Derive the Windows 3.1 disk this build boots from the one copy.sh publishes.
 *
 * The disk that circulates for v86 ends its `AUTOEXEC.BAT` with `win -s`, which
 * starts Windows in standard mode. Standard mode is the reason a DOS session
 * opened from inside Windows — File → Run → `command.com` — comes up blank and
 * deaf on this emulator: there a DOS box is not a virtual machine but a
 * protected mode → real mode → protected mode round trip, and the way back in
 * goes through 16-bit call gates v86 does not implement. The guest spins in
 * them forever, never services the keyboard interrupt, and never paints.
 *
 * Dropping the `-s` starts 386 enhanced mode instead, where a DOS box is a
 * virtual-8086 machine — the same mechanism Windows 95 and 98 use here, which
 * works. It also needs the Bochs BIOS rather than SeaBIOS, which is
 * `GuestSpec.firmware` in `src/runtime/guests.ts`; under SeaBIOS this Windows
 * refuses enhanced mode and exits straight back to DOS.
 *
 * The edit is two bytes, in place, and the image keeps its length so every
 * sector after it stays where it was.
 *
 * Usage: `node scripts/v86-win31-enhanced.mjs <stock win31.img> <output.img>`
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The line as it ships, padded so the replacement is the same length. */
const STANDARD = 'win -s        \r\n'

/** The same line with the mode switch removed. */
const ENHANCED = 'win           \r\n'

/** The disk this was derived from and the disk it derives, so a rerun is checkable. */
const SHA256 = {
  from: '0c2d083442da004acb2518832c7f78326a8593069e2b436896b710e8306d6a66',
  to: '68376eccc437031c70e108dc9dce13f71b27c72879caccd11f9b0bd488b75b68',
}

/**
 * Turn the standard-mode disk into the enhanced-mode one, in place.
 * @param disk - the stock `win31.img`, as bytes. Modified and returned.
 * @returns the same buffer, now starting 386 enhanced mode.
 */
export function enhance(disk) {
  const at = disk.indexOf(STANDARD)
  if (at < 0) throw new Error(`[win31] this disk does not run \`${STANDARD.trim()}\` from AUTOEXEC.BAT`)
  if (disk.indexOf(STANDARD, at + 1) >= 0) throw new Error(`[win31] this disk has more than one \`${STANDARD.trim()}\``)
  disk.write(ENHANCED, at, 'latin1')
  return disk
}

// Run as a command only when it *is* the command; imported, only `enhance` is.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [, , input, output] = process.argv
  if (input === undefined || output === undefined) {
    process.stderr.write('usage: node scripts/v86-win31-enhanced.mjs <stock win31.img> <output.img>\n')
    process.exit(2)
  }

  const disk = readFileSync(input)
  const before = createHash('sha256').update(disk).digest('hex')
  if (before !== SHA256.from) {
    process.stdout.write(`[win31] warning: ${input} is not the disk this was measured against (sha256 ${before})\n`)
  }

  enhance(disk)
  const after = createHash('sha256').update(disk).digest('hex')
  writeFileSync(`${output}.part`, disk)
  renameSync(`${output}.part`, output)
  process.stdout.write(`[win31] ${output}: 386 enhanced mode, sha256 ${after}\n`)
  if (after !== SHA256.to) process.stdout.write('[win31] warning: that is not the disk this build was tested with\n')
}
