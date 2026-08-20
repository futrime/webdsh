/**
 * Put the emulator's WebAssembly where the page can fetch it.
 *
 * `v86` ships two `.wasm` builds and no way to import one through a bundler
 * without pulling 2 MB into the asset graph under a hashed name. A hashed name
 * is the problem, not the size: v86 derives the fallback build's URL by
 * replacing `v86.wasm` in the path it was given, so a hashed primary leaves the
 * fallback pointing at a file that does not exist — on a browser that needs it,
 * that is a machine that cannot start and an error naming the wrong cause.
 *
 * So both builds are copied verbatim into `public/v86/`, beside the BIOS, and
 * the runtime hands v86 a plain relative URL. Nothing here is fetched at page
 * load; the first request for any of it is the first boot of an emulated
 * machine.
 *
 * Usage: `node scripts/build-v86.mjs`
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'v86', 'build')
const target = join(root, 'public', 'v86')

/** The BIOS that ships with this repository; its absence means a broken checkout. */
const VENDORED = ['seabios.bin', 'vgabios.bin']

/** The emulator builds copied out of the package. */
const COPIED = ['v86.wasm', 'v86-fallback.wasm']

mkdirSync(target, { recursive: true })

for (const name of VENDORED) {
  if (existsSync(join(target, name))) continue
  throw new Error(`[v86] ${name} is missing from public/v86; it is vendored, not derived — restore it from git`)
}

for (const name of COPIED) {
  const from = join(source, name)
  if (!existsSync(from)) throw new Error(`[v86] ${from} is missing; is the v86 dependency installed?`)
  copyFileSync(from, join(target, name))
}

console.log(`[v86] copied ${COPIED.join(', ')} into public/v86`)
