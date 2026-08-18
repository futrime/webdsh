/**
 * Build the machine the page runs on.
 *
 * Two steps, neither of which the browser could do: `docker build` produces the
 * Debian userland described by `container/Dockerfile`, and `c2w` converts that
 * image into a WASM module that carries a Linux kernel and an x86-64 emulator
 * with it. The result is compressed and cut into parts under `public/container/`,
 * which vite copies into `dist/` and the page fetches at boot.
 *
 * The conversion compiles Bochs, wasi-vfs, and wizer from source the first
 * time, which takes tens of minutes; every run after that is BuildKit's layer
 * cache and takes seconds. Both the converter and its build assets are pinned
 * and cached under `.cache/`, so a rebuild does not depend on a release page
 * still being there.
 *
 * The output is deliberately not committed: it is hundreds of megabytes, it is
 * reproducible from this repository, and `.github/workflows/container.yml`
 * builds it once per change and publishes it for the deploy to download.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The converter release this build is pinned to.
 *
 * container2wasm's generated image and its JS-side contract — the run-time
 * flags, how a mapped directory reaches the guest, what the WASI imports are —
 * are version-specific, so the version is pinned here rather than tracking a
 * moving `latest`.
 */
const C2W_VERSION = 'v0.8.4'

/** Where the converter's own build inputs come from. */
const C2W_REPO = 'https://github.com/container2wasm/container2wasm'

/** The tag applied to the userland image before conversion. */
const IMAGE = 'dsh-web-container:latest'

/** How much RAM the emulated machine has. */
const VM_MEMORY_MB = 512

/** Where the page fetches the machine from. */
const PUBLISHED = resolve(root, 'public/container')

/** The manifest the page reads before fetching anything else. */
const MANIFEST = resolve(PUBLISHED, 'machine.json')

/** Everything downloaded, checked out, or built, none of it in git. */
const CACHE = resolve(root, '.cache/c2w')

/** The converted machine, before it is compressed and split for publishing. */
const CONVERTED = resolve(CACHE, 'dsh.wasm')

/**
 * How large a published part may be.
 *
 * Hosts put a ceiling on a single file — GitHub's is 100 MB — and the machine
 * is several times that even compressed. Splitting it is also what lets the
 * page fetch the pieces at once instead of one at a time.
 */
const PART_BYTES = 48 * 1024 * 1024

/**
 * Run a command, letting its output through to this process.
 * @param {string} command - the program.
 * @param {string[]} args - its arguments.
 * @param {Record<string, unknown>} [options] - spawn options.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

/**
 * Run a command and capture what it printed.
 * @param {string} command - the program.
 * @param {string[]} args - its arguments.
 * @returns {string} trimmed standard output.
 */
function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

/** The host architecture, as container2wasm names its release assets. */
function releaseArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64'
}

/**
 * Fetch and unpack the pinned converter, once.
 * @returns {string} path to the `c2w` binary.
 */
function ensureConverter() {
  const binary = resolve(CACHE, `c2w-${C2W_VERSION}`, 'c2w')
  if (existsSync(binary)) return binary
  const target = resolve(CACHE, `c2w-${C2W_VERSION}`)
  mkdirSync(target, { recursive: true })
  const asset = `container2wasm-${C2W_VERSION}-linux-${releaseArch()}.tar.gz`
  const url = `${C2W_REPO}/releases/download/${C2W_VERSION}/${asset}`
  console.log(`[container] downloading ${asset}`)
  run('curl', ['-fsSL', '-o', resolve(target, asset), url])
  run('tar', ['xzf', resolve(target, asset), '-C', target])
  rmSync(resolve(target, asset), { force: true })
  return binary
}

/**
 * Check out the converter's build assets, once.
 *
 * `c2w` embeds a Dockerfile that clones this repository at the matching tag.
 * Doing the clone here instead means the conversion has one fewer network
 * dependency inside BuildKit — and the embedded default still points at the
 * repository's old location, where the tag no longer resolves.
 * @returns {string} path to the checkout.
 */
function ensureAssets() {
  const target = resolve(CACHE, `assets-${C2W_VERSION}`)
  if (existsSync(resolve(target, 'Dockerfile'))) return target
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  console.log(`[container] checking out container2wasm ${C2W_VERSION}`)
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', C2W_VERSION, C2W_REPO, target])
  return target
}

/**
 * What the current output was built from.
 *
 * The sources, not the built image's digest. Two machines that run this build
 * from the same tree will not produce byte-identical Docker layers — apt moves
 * underneath it — and keying on that would mean a CI cache that never hits and
 * a conversion on every run. `--force` is how to rebuild anyway.
 * @returns a line identifying the inputs.
 */
function currentStamp() {
  const inputs = createHash('sha256')
  for (const file of ['container/Dockerfile', 'container/dsh-mux', 'container/dsh-fsd', 'scripts/build-container.mjs']) {
    inputs.update(readFileSync(resolve(root, file)))
  }
  return `${C2W_VERSION} ${String(VM_MEMORY_MB)} ${inputs.digest('hex')}`
}

/** Build the userland image. */
function buildImage() {
  console.log('[container] building the Debian userland')
  run('docker', ['build', '-f', 'container/Dockerfile', '-t', IMAGE, '.'])
  console.log(`[container] image ${capture('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE])}`)
}

/** Convert the image and move the result into place. */
function convert() {
  const converter = ensureConverter()
  const assets = ensureAssets()
  const staging = `${CONVERTED}.building`
  mkdirSync(dirname(CONVERTED), { recursive: true })
  rmSync(staging, { force: true })
  console.log('[container] converting to WASM (first run compiles the emulator; expect tens of minutes)')
  run(converter, [
    '--assets', assets,
    '--target-arch', 'amd64',
    // The emulated machine's RAM. The converter's default is 128 MB, which is
    // a Linux and not a workstation: Node, pip, and a compiler all want more
    // than that, and the cost of asking for it is browser memory rather than
    // download size — wizer only snapshots the pages the boot actually touched.
    '--build-arg', `VM_MEMORY_SIZE_MB=${String(VM_MEMORY_MB)}`,
    IMAGE, staging,
  ])
  // Moved only once it is whole, so an interrupted conversion never leaves a
  // truncated machine that a later run would publish.
  renameSync(staging, CONVERTED)
}

/**
 * Compress the machine and cut it into publishable parts.
 *
 * gzip rather than the host's own compression, because a static host decides
 * for itself what it will compress and this build cannot afford to find out
 * that WASM is not on the list. The page decompresses with `DecompressionStream`
 * as the bytes arrive, so this costs one pass and no extra memory.
 * @param stamp - what the parts were built from.
 */
async function publish(stamp) {
  // Emptied rather than removed: a dev server watching the directory holds it
  // open, and taking the directory out from under it fails for no good reason.
  mkdirSync(PUBLISHED, { recursive: true })
  for (const stale of readdirSync(PUBLISHED)) {
    // Best effort: a file a dev server still has open cannot be removed on
    // every filesystem, and the manifest names what is current regardless.
    try {
      rmSync(resolve(PUBLISHED, stale), { force: true })
    } catch {
      console.warn(`[container] could not remove ${stale}; it is stale but harmless`)
    }
  }

  // Streamed rather than held: the machine is hundreds of megabytes, and a
  // build that needs a gigabyte of memory to package it is a build that fails
  // on somebody's runner.
  const parts = []
  let compressed = 0
  let open = null
  const sink = new Writable({
    write(chunk, _encoding, done) {
      let rest = chunk
      while (rest.byteLength > 0) {
        if (open === null || open.written === PART_BYTES) {
          const name = `dsh.wasm.gz.${String(parts.length).padStart(3, '0')}`
          parts.push(name)
          open = { handle: openSync(resolve(PUBLISHED, name), 'w'), written: 0 }
        }
        const take = Math.min(PART_BYTES - open.written, rest.byteLength)
        writeSync(open.handle, rest, 0, take)
        open.written += take
        compressed += take
        rest = rest.subarray(take)
        if (open.written === PART_BYTES) { closeSync(open.handle); open = null }
      }
      done()
    },
    final(done) {
      if (open !== null) { closeSync(open.handle); open = null }
      done()
    },
  })
  await pipeline(createReadStream(CONVERTED), createGzip({ level: 6 }), sink)

  writeFileSync(MANIFEST, `${JSON.stringify({
    stamp,
    encoding: 'gzip',
    bytes: statSync(CONVERTED).size,
    compressed,
    parts,
  }, null, 2)}\n`)
  return { parts, compressed }
}

const force = process.argv.includes('--force')
const stamp = currentStamp()
if (!force && existsSync(MANIFEST) && JSON.parse(readFileSync(MANIFEST, 'utf8')).stamp === stamp) {
  console.log(`[container] up to date: ${MANIFEST}`)
  process.exit(0)
}
buildImage()
// Past the stamp check, something the machine is made of has changed, so the
// conversion runs. BuildKit's cache makes an unchanged emulator free; what is
// never free is publishing an image that does not match the sources.
convert()
const published = await publish(stamp)
const megabytes = (bytes) => `${String(Math.round(bytes / 1024 / 1024))} MB`
console.log(
  `[container] ${megabytes(statSync(CONVERTED).size)} of machine, `
  + `published as ${String(published.parts.length)} parts totalling ${megabytes(published.compressed)}`,
)
