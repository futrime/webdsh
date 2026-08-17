/**
 * Split the VM disk into pieces a static host will accept.
 *
 * GitHub Pages rejects files over 100 MB, and the disk is far larger than that.
 * Release assets have room but send no `Access-Control-Allow-Origin`, so a page
 * cannot read them. What is left is to store the disk as chunks the host is
 * happy with and reassemble it in the one place a static deployment can run
 * code on the way to the network: the service worker.
 *
 * The manifest this writes tells the worker how to map a byte range onto
 * chunks. Trailing all-zero chunks are dropped and recorded as holes, because a
 * freshly made filesystem is mostly empty and a hole costs a header instead of
 * a file.
 *
 * Usage: `node scripts/vm/chunk.mjs <image> <outdir> [chunkBytes]`
 */

import { createReadStream, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const [, , image, outDir, sizeArg] = process.argv
if (image === undefined || outDir === undefined) {
  console.error('usage: node scripts/vm/chunk.mjs <image> <outdir> [chunkBytes]')
  process.exit(2)
}
if (!existsSync(image)) {
  // The disk is built separately and is not in the repository, so a plain
  // `npm run build` on a machine that has not built it should say what is
  // missing rather than produce a site whose VM cannot start.
  console.error(`chunk: ${image} does not exist — run \`npm run vm:build\` first (it needs Docker).`)
  console.error('chunk: the app builds and runs without it; only the terminal needs the disk.')
  process.exit(0)
}

/**
 * Small enough that decompressing one to serve a block is cheap, and far under
 * the 100 MB per-file ceiling. A filesystem is mostly empty space, so the
 * chunks compress to a fraction of the image and a whole region of untouched
 * disk collapses into a hole.
 */
const CHUNK = Number(sizeArg ?? 4 * 1024 * 1024)

if (existsSync(outDir)) {
  for (const entry of readdirSync(outDir)) {
    if (/^disk-\d+\.bin(\.gz)?$|^manifest\.json$/.test(entry)) rmSync(join(outDir, entry))
  }
}
mkdirSync(outDir, { recursive: true })

/** Whether a buffer is entirely zero, which is what makes a chunk a hole. */
function isHole(buffer) {
  for (const byte of buffer) if (byte !== 0) return false
  return true
}

const chunks = []
let index = 0
let total = 0
let stored = 0
let carry = Buffer.alloc(0)

/** Write one chunk, or record it as a hole. */
function emit(buffer) {
  if (isHole(buffer)) {
    chunks.push(null)
  } else {
    const name = `disk-${String(index).padStart(5, '0')}.bin.gz`
    const packed = gzipSync(buffer, { level: 9 })
    writeFileSync(join(outDir, name), packed)
    stored += packed.length
    chunks.push(name)
  }
  index++
  total += buffer.length
}

await new Promise((resolve, reject) => {
  const stream = createReadStream(image, { highWaterMark: CHUNK })
  stream.on('data', (piece) => {
    carry = carry.length === 0 ? piece : Buffer.concat([carry, piece])
    while (carry.length >= CHUNK) {
      emit(carry.subarray(0, CHUNK))
      carry = carry.subarray(CHUNK)
    }
  })
  stream.on('end', () => {
    if (carry.length > 0) emit(carry)
    resolve()
  })
  stream.on('error', reject)
})

const manifest = { size: total, chunkSize: CHUNK, encoding: 'gzip', chunks }
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`)

const written = chunks.filter(chunk => chunk !== null).length
console.log(
  `wrote ${String(written)} chunks (${String(chunks.length - written)} holes) `
  + `covering ${(total / 1e9).toFixed(2)} GB in ${(stored / 1e6).toFixed(0)} MB into ${outDir}`,
)
