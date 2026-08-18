/// <reference lib="webworker" />

/**
 * The thread the machine runs on.
 *
 * `_start()` on a container2wasm module does not return: it is the emulator's
 * main loop, running a Linux kernel on an emulated x86-64. Anything that shared
 * a thread with it would never get another turn, which is why this is a worker
 * of its own and why the console is two `SharedArrayBuffer` rings rather than
 * messages.
 *
 * What this file supplies is the WASI the module is compiled against: standard
 * input and output wired to the rings, and a `poll_oneoff` that actually waits.
 * The shim's own `poll_oneoff` busy-loops on a clock and refuses descriptor
 * subscriptions, which is exactly what a guest blocking on its console does —
 * so it is replaced here, against the ABI's own layout.
 *
 * The subscription and event layouts below follow WASI preview 1, and were
 * checked against container2wasm's `examples/wasi-browser` (Apache-2.0), whose
 * approach this is.
 */

import { Fd, WASI, wasi as defs } from '@bjorn3/browser_wasi_shim'
import { Ring } from './ring.ts'

/** What the page sends to start the machine. */
interface StartMessage {
  /** The manifest describing how the image was published. */
  manifest: string
  stdin: SharedArrayBuffer
  stdout: SharedArrayBuffer
  /** Run-time flags for the WASM image; empty means the image's own command. */
  args: string[]
  env: string[]
}

/** How `scripts/build-container.mjs` published the machine. */
interface Manifest {
  encoding: 'gzip'
  bytes: number
  compressed: number
  parts: string[]
}

/** What this worker sends back. */
type Report =
  | { type: 'started' }
  | { type: 'exit', code: number }
  | { type: 'failed', message: string }

/** Post a status back to the page. */
function report(message: Report): void {
  ;(globalThis as unknown as DedicatedWorkerGlobalScope).postMessage(message)
}

/** Standard input: the page's keystrokes and frames, as the guest reads them. */
class ConsoleIn extends Fd {
  constructor(private readonly ring: Ring) {
    super()
  }

  override fd_fdstat_get(): { ret: number, fdstat: defs.Fdstat | null } {
    return { ret: 0, fdstat: new defs.Fdstat(defs.FILETYPE_CHARACTER_DEVICE, 0) }
  }

  override fd_read(size: number): { ret: number, data: Uint8Array } {
    // Blocking, because that is what a console read is. The guest polls before
    // reading whenever it does not want to block, and `poll_oneoff` below is
    // where that waiting happens.
    this.ring.waitForData()
    return { ret: 0, data: this.ring.read(size) }
  }
}

/** Standard output and error: everything the machine says. */
class ConsoleOut extends Fd {
  constructor(private readonly ring: Ring) {
    super()
  }

  override fd_fdstat_get(): { ret: number, fdstat: defs.Fdstat | null } {
    return { ret: 0, fdstat: new defs.Fdstat(defs.FILETYPE_CHARACTER_DEVICE, 0) }
  }

  override fd_write(data: Uint8Array): { ret: number, nwritten: number } {
    // Every byte, waiting for the page to drain if it has fallen behind.
    // Dropping output would corrupt the frames the multiplexer is sending.
    this.ring.writeAll(data)
    return { ret: 0, nwritten: data.byteLength }
  }
}

/** Bytes per subscription and per event in the `poll_oneoff` arrays. */
const SUBSCRIPTION_BYTES = 48
const EVENT_BYTES = 32

/** Subscription variants, as the ABI numbers them. */
const EVENTTYPE_CLOCK = 0
const EVENTTYPE_FD_READ = 1

/**
 * Wait for the console, or for a timeout.
 *
 * The guest's poll is how it asks "is there input yet, and if not wake me in
 * n nanoseconds" — the shape of every idle loop in there. Answering it by
 * spinning would burn a core in the user's browser for as long as the tab is
 * open; answering it with `Atomics.wait` costs nothing until a byte arrives.
 * @param wasi - the instance whose memory holds the arrays.
 * @param ring - standard input.
 * @returns the WASI import, replacing the shim's.
 */
function pollOneoff(wasi: WASI, ring: Ring) {
  return (subscriptions: number, events: number, count: number, produced: number): number => {
    if (count === 0) return defs.ERRNO_INVAL
    const memory = new DataView(wasi.inst.exports.memory.buffer)

    let waitingOnInput = false
    let inputUserdata = 0n
    let clockUserdata = 0n
    let hasClock = false
    let timeoutNs = Number.POSITIVE_INFINITY

    for (let index = 0; index < count; index++) {
      const base = subscriptions + index * SUBSCRIPTION_BYTES
      const userdata = memory.getBigUint64(base, true)
      const variant = memory.getUint8(base + 8)
      if (variant === EVENTTYPE_FD_READ) {
        const fd = memory.getUint32(base + 16, true)
        // Only the console can be polled. Nothing else is a stream here: the
        // packed image is a file, and there are no sockets without networking.
        if (fd !== 0) return defs.ERRNO_INVAL
        waitingOnInput = true
        inputUserdata = userdata
      } else if (variant === EVENTTYPE_CLOCK) {
        const timeout = Number(memory.getBigUint64(base + 24, true))
        if (timeout < timeoutNs) timeoutNs = timeout
        hasClock = true
        clockUserdata = userdata
      } else {
        return defs.ERRNO_INVAL
      }
    }

    const readable = waitingOnInput
      ? ring.waitForData(hasClock ? timeoutNs / 1e6 : Infinity)
      // A pure clock subscription is a sleep; the ring is a convenient thing to
      // sleep on, and nothing will ever notify it before the timeout.
      : (ring.waitForData(timeoutNs / 1e6), false)

    let written = 0
    const emit = (userdata: bigint, variant: number): void => {
      const at = events + written * EVENT_BYTES
      memory.setBigUint64(at, userdata, true)
      memory.setUint16(at + 8, 0, true)
      memory.setUint8(at + 10, variant)
      written++
    }
    if (readable) emit(inputUserdata, EVENTTYPE_FD_READ)
    if (hasClock) emit(clockUserdata, EVENTTYPE_CLOCK)
    memory.setUint32(produced, written, true)
    return 0
  }
}

/**
 * Fetch the machine image as one stream.
 *
 * It is published compressed and in parts — see `scripts/build-container.mjs`
 * for why — so this starts every part's request at once, reads them back in
 * order, and hands the result to `DecompressionStream`. Nothing is ever wholly
 * in memory: the bytes are compiled as they arrive.
 * @param base - the manifest's URL, which the parts are named relative to.
 * @param manifest - what was published.
 * @returns a response `instantiateStreaming` will accept.
 */
function imageStream(base: string, manifest: Manifest): Response {
  // Started together rather than in sequence. A browser will run several
  // connections at once, and the parts exist so it can.
  const requests = manifest.parts.map(async part => fetch(new URL(part, base).href, { credentials: 'same-origin' }))
  const ordered = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const [index, request] of requests.entries()) {
          const response = await request
          if (!response.ok || response.body === null) {
            throw new Error(`part ${manifest.parts[index]} could not be fetched (HTTP ${String(response.status)})`)
          }
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
  const body = ordered.pipeThrough(
    new DecompressionStream(manifest.encoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
  return new Response(body, { headers: { 'content-type': 'application/wasm' } })
}

/** Fetch, instantiate, and run the machine. This call does not return. */
async function start(message: StartMessage): Promise<void> {
  const stdin = new Ring(message.stdin)
  const stdout = new Ring(message.stdout)
  const wasi = new WASI(message.args, message.env, [
    new ConsoleIn(stdin),
    new ConsoleOut(stdout),
    new ConsoleOut(stdout),
  ])
  wasi.wasiImport.poll_oneoff = pollOneoff(wasi, stdin) as unknown as (...args: unknown[]) => unknown

  const described = await fetch(message.manifest, { credentials: 'same-origin' })
  if (!described.ok) {
    throw new Error(
      `no machine image is published at ${message.manifest} (HTTP ${String(described.status)}) — `
      + 'run `npm run build:container`',
    )
  }
  const manifest = await described.json() as Manifest
  const instantiated = await WebAssembly.instantiateStreaming(
    imageStream(message.manifest, manifest),
    { wasi_snapshot_preview1: wasi.wasiImport },
  )

  report({ type: 'started' })
  const code = wasi.start(instantiated.instance as unknown as {
    exports: { memory: WebAssembly.Memory, _start: () => unknown }
  })
  report({ type: 'exit', code })
}

globalThis.addEventListener('message', (event: MessageEvent<StartMessage>) => {
  start(event.data).catch((error: unknown) => {
    report({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  })
}, { once: true })
