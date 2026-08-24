/**
 * The vision path, end to end.
 *
 * dsh 0.1.1 lets a model see. That path runs entirely through the browser
 * here: `dsh-attachment-local` calls sharp to orient, cap, re-encode and
 * verify every image, and this build answers those calls with the browser's
 * own decoder and canvas (`src/node/sharp.ts`). Nothing about that is visible
 * from the outside — an image that silently loses its transparency, keeps a
 * photograph's GPS tags, or arrives at the model rotated ninety degrees all
 * look like a working feature — so this drives the real pipeline in the real
 * browser and checks the facts it is supposed to guarantee.
 *
 * The last case sends an image to a model that can read it and asks what it
 * says. That one needs a key.
 *
 * Usage: `DEEPSEEK_API_KEY=… npx tsx scripts/vision-e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { chromium, type Page } from 'playwright'
import { FIXTURES_SOURCE } from './vision-fixtures.ts'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
const headed = args.includes('--headed')
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

/** The route and model this deployment tests vision against. */
const VISION_PROVIDER = 'deepseek-official'
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Fail the run with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Wait until the host has published its control surface. */
async function waitForHost(page: Page): Promise<void> {
  await page.waitForFunction(() => (globalThis as { dsh?: unknown }).dsh !== undefined, undefined, { timeout: 90_000 })
  await page.evaluate(FIXTURES_SOURCE)
}

/** The fixture builders `scripts/vision-fixtures.ts` installs in the page. */
interface Fixtures {
  png(width: number, height: number, bitDepth: number, colourType: number, extra?: Uint8Array[]): Promise<Uint8Array>
  pngChunk(name: string, body: Uint8Array): Uint8Array
  withExif(jpeg: Uint8Array, orientation: number): Uint8Array
  draw(width: number, height: number, alpha: boolean): OffscreenCanvas
  noise(width: number, height: number): OffscreenCanvas
  encode(canvas: OffscreenCanvas, type: string, quality?: number): Promise<Uint8Array>
  animatedGif(): Uint8Array
  ascii(text: string): Uint8Array
  concat(parts: Uint8Array[]): Uint8Array
}

/** One durable image, as the store hands it back. */
interface ImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** As much of `ctx.attachments` as this suite calls. */
interface Attachments {
  imageLimits: { maxImagesPerMessage: number, mediaTypes: string[] }
  saveImage(input: { data: Uint8Array, mediaType: string, displayName?: string }): Promise<ImageRef>
  saveImages(inputs: { data: Uint8Array, mediaType: string }[]): Promise<ImageRef[]>
  readImage(ref: ImageRef): Promise<{ data: Uint8Array }>
  readImageRequest(ref: ImageRef, policy: { maxPixels: number, maxBytes: number }): Promise<{
    data: Uint8Array
    width: number
    height: number
    variantId: string
  }>
}

/** One RPC's answer, in the shape the gateway returns it. */
interface Answer<T> { result: { ok: boolean, value?: T, error?: unknown } }

/** As much of the gateway as this suite drives. */
interface Gateway {
  sessions: {
    create(request: { rpcId: string, payload: Record<string, never> }): Promise<Answer<{ sessionId: string }>>
    selectModel(request: { rpcId: string, payload: Record<string, string> }): Promise<Answer<unknown>>
    prompt(request: { rpcId: string, payload: Record<string, unknown> }): Promise<Answer<unknown>>
    history(request: { rpcId: string, payload: Record<string, string> }): Promise<Answer<unknown>>
  }
  events: {
    mux(request: { rpcId: string, payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<{
      payload: { event?: { type?: string, data?: { name?: string, chunk?: { type?: string, text?: string } } } }
    }>
  }
}

/** The page's own handle on the emulated machine. */
interface MachineHandle { ready(timeoutMs?: number): Promise<boolean> }

/** One scenario. */
interface Scenario {
  name: string
  run(page: Page): Promise<void>
}

const scenarios: Scenario[] = [
  {
    // What sharp is asked and what it must answer. Everything downstream —
    // whether an image may pass through untouched, whether it needs turning,
    // whether the normalized result is acceptable — is decided from these
    // fields, so a wrong one is a wrong decision rather than a wrong number.
    name: 'container-facts',
    async run(page) {
      await waitForHost(page)
      // The shim is bundled rather than importable from the page, so it is
      // exercised through the service that calls it — with inputs whose facts
      // only the container states.
      const report = await page.evaluate(async () => {
        const f = (globalThis as unknown as { fixtures: Fixtures }).fixtures
        const store = globalThis.dsh.ctx.get('attachments') as Attachments
        const out: Record<string, unknown> = {}

        // A 16-bit PNG: sharp reports depth `ushort`, which forbids
        // pass-through and forces a re-encode down to eight bits.
        const deep = await f.png(64, 48, 16, 2)
        const deepRef = await store.saveImage({ data: deep, mediaType: 'image/png', displayName: 'deep.png' })
        out.deep = { inBytes: deep.length, outBytes: deepRef.bytes, w: deepRef.width, h: deepRef.height, mediaType: deepRef.mediaType, passedThrough: deepRef.bytes === deep.length }

        // An 8-bit opaque PNG with no ancillary chunks is already normal.
        const plain = await f.png(64, 48, 8, 2)
        const plainRef = await store.saveImage({ data: plain, mediaType: 'image/png', displayName: 'plain.png' })
        out.plain = { inBytes: plain.length, outBytes: plainRef.bytes, passedThrough: plainRef.bytes === plain.length }

        // The same PNG carrying a text chunk: retained metadata, so it must be
        // re-encoded rather than forwarded with the comment still in it.
        const commented = await f.png(64, 48, 8, 2, [f.pngChunk('tEXt', f.concat([f.ascii('Comment'), new Uint8Array([0]), f.ascii('surveillance')]))])
        const commentedRef = await store.saveImage({ data: commented, mediaType: 'image/png', displayName: 'commented.png' })
        const commentedBack = await store.readImage(commentedRef)
        out.commented = {
          inBytes: commented.length,
          outBytes: commentedRef.bytes,
          passedThrough: commentedRef.bytes === commented.length,
          stillCarriesComment: new TextDecoder('latin1').decode(commentedBack.data).includes('surveillance'),
        }

        // A JPEG whose EXIF says "rotate": the stored image must come out
        // upright, which for a 90-degree tag means the sides swap.
        const wide = await f.encode(f.noise(200, 100), 'image/jpeg', 0.9)
        const turned = f.withExif(wide, 6)
        const turnedRef = await store.saveImage({ data: turned, mediaType: 'image/jpeg', displayName: 'turned.jpg' })
        const uprightRef = await store.saveImage({ data: wide, mediaType: 'image/jpeg', displayName: 'upright.jpg' })
        const turnedBack = await store.readImage(turnedRef)
        out.orientation = {
          declared: { w: turnedRef.width, h: turnedRef.height },
          upright: { w: uprightRef.width, h: uprightRef.height },
          stillCarriesExif: new TextDecoder('latin1').decode(turnedBack.data.subarray(0, 4096)).includes('Exif'),
        }

        // An animated GIF is admitted and flattened to a still frame.
        const gif = f.animatedGif()
        const gifRef = await store.saveImage({ data: gif, mediaType: 'image/gif', displayName: 'anim.gif' })
        out.animated = { mediaType: gifRef.mediaType, w: gifRef.width, h: gifRef.height }

        // Transparency survives a re-encode; an opaque image does not gain any.
        const alpha = await f.encode(f.draw(300, 200, true), 'image/png')
        const alphaRef = await store.saveImage({ data: alpha, mediaType: 'image/png', displayName: 'alpha.png' })
        const opaque = await f.encode(f.noise(300, 200), 'image/jpeg', 0.95)
        const opaqueRef = await store.saveImage({ data: opaque, mediaType: 'image/jpeg', displayName: 'opaque.jpg' })
        out.alpha = { alphaMediaType: alphaRef.mediaType, opaqueMediaType: opaqueRef.mediaType }

        // Bytes that are not an image at all are refused, not stored.
        try {
          await store.saveImage({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), mediaType: 'image/png' })
          out.garbage = 'accepted'
        } catch (error) {
          out.garbage = String((error as { code?: string }).code ?? (error as Error).message)
        }
        return out
      })

      const deep = report.deep as { passedThrough: boolean, outBytes: number, w: number, h: number }
      expect(!deep.passedThrough, 'a 16-bit PNG was forwarded unchanged instead of being reduced to eight bits')
      expect(deep.w === 64 && deep.h === 48, `the 16-bit PNG changed size: ${String(deep.w)}x${String(deep.h)}`)

      const plain = report.plain as { passedThrough: boolean }
      expect(plain.passedThrough, 'a clean 8-bit sRGB PNG was re-encoded when it could have been forwarded byte-for-byte')

      const commented = report.commented as { passedThrough: boolean, stillCarriesComment: boolean }
      expect(!commented.passedThrough, 'a PNG carrying a text chunk was forwarded with its metadata intact')
      expect(!commented.stillCarriesComment, 'the stored image still carries the comment the source had')

      const orientation = report.orientation as { declared: { w: number, h: number }, upright: { w: number, h: number }, stillCarriesExif: boolean }
      expect(
        orientation.upright.w === 200 && orientation.upright.h === 100,
        `the untagged JPEG should be 200x100, got ${String(orientation.upright.w)}x${String(orientation.upright.h)}`,
      )
      expect(
        orientation.declared.w === 100 && orientation.declared.h === 200,
        `an EXIF orientation of 6 must turn the image upright (expected 100x200, got ${String(orientation.declared.w)}x${String(orientation.declared.h)})`,
      )
      expect(!orientation.stillCarriesExif, 'the stored image still carries the EXIF block the source had')

      const animated = report.animated as { mediaType: string, w: number, h: number }
      expect(animated.w === 4 && animated.h === 4, `the animated GIF lost its size: ${String(animated.w)}x${String(animated.h)}`)
      expect(animated.mediaType !== 'image/gif', 'an animated GIF was stored as a GIF rather than flattened to one frame')

      expect(report.garbage !== 'accepted', 'bytes that are not an image were admitted')
    },
  },
  {
    // The request version: what actually reaches a model. A route states a
    // pixel and a byte budget, and the store must meet both — by shrinking,
    // re-encoding, and never by handing over something that does not fit.
    name: 'request-budgets',
    async run(page) {
      await waitForHost(page)
      const report = await page.evaluate(async () => {
        const f = (globalThis as unknown as { fixtures: Fixtures }).fixtures
        const store = globalThis.dsh.ctx.get('attachments') as Attachments
        const source = await f.encode(f.noise(1600, 1200), 'image/jpeg', 0.92)
        const ref = await store.saveImage({ data: source, mediaType: 'image/jpeg', displayName: 'photo.jpg' })
        const budgets = [
          { maxPixels: 1_150_000, maxBytes: 5_000_000 },
          { maxPixels: 200_000, maxBytes: 40_000 },
          { maxPixels: 4_000_000, maxBytes: 20_000 },
        ]
        const versions = []
        for (const policy of budgets) {
          const version = await store.readImageRequest(ref, policy)
          versions.push({ policy, w: version.width, h: version.height, bytes: version.data.length, variantId: String(version.variantId) })
        }
        // The same attachment under the same policy is the same version:
        // request images are cached and uploaded by that identity.
        const again = await store.readImageRequest(ref, budgets[1])
        return { stored: { w: ref.width, h: ref.height, bytes: ref.bytes }, versions, stable: String(again.variantId) === versions[1].variantId }
      })

      const versions = report.versions as { policy: { maxPixels: number, maxBytes: number }, w: number, h: number, bytes: number, variantId: string }[]
      for (const version of versions) {
        expect(
          version.w * version.h <= version.policy.maxPixels,
          `a request image of ${String(version.w)}x${String(version.h)} exceeds the route's ${String(version.policy.maxPixels)}-pixel budget`,
        )
        expect(
          version.bytes <= version.policy.maxBytes,
          `a request image of ${String(version.bytes)} bytes exceeds the route's ${String(version.policy.maxBytes)}-byte budget`,
        )
        expect(version.bytes > 0, 'a request image came back empty')
      }
      expect(
        new Set(versions.map(version => version.variantId)).size === versions.length,
        'two different budgets produced the same request-image identity',
      )
      expect(report.stable === true, 'the same attachment under the same budget produced a different identity on a second read')
    },
  },
  {
    // Several images in one message, which is the shape a real conversation
    // takes: a person pastes three screenshots and asks what changed. The
    // batch is validated before anything is committed, so one bad member has
    // to take the whole batch down rather than leaving a partial message —
    // and the ones that pass have to come back in the order they were sent,
    // because "the second one" is how the question will refer to them.
    name: 'image-batch',
    async run(page) {
      await waitForHost(page)
      const report = await page.evaluate(async () => {
        const f = (globalThis as unknown as { fixtures: Fixtures }).fixtures
        const store = globalThis.dsh.ctx.get('attachments') as Attachments
        // Three visibly different images, so identical bytes cannot make two
        // references collide and look like an ordering that held.
        const inputs = await Promise.all([200, 240, 280].map(async (edge: number) => ({
          data: await f.encode(f.noise(edge, edge), 'image/jpeg', 0.9),
          mediaType: 'image/jpeg',
        })))
        const refs = await store.saveImages(inputs)
        const out: Record<string, unknown> = {
          count: refs.length,
          sizes: refs.map((ref: { width: number }) => ref.width),
          distinct: new Set(refs.map((ref: { attachmentId: string }) => String(ref.attachmentId))).size,
        }

        // One member the deployment does not accept takes the batch with it.
        try {
          await store.saveImages([inputs[0], { data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }])
          out.mixedBatch = 'accepted'
        } catch (error) {
          out.mixedBatch = String((error as { code?: string }).code ?? (error as Error).message)
        }

        // And a batch larger than the deployment admits is refused as a batch.
        const limit = store.imageLimits.maxImagesPerMessage as number
        try {
          await store.saveImages(new Array(limit + 1).fill(inputs[0]))
          out.overLimit = 'accepted'
        } catch (error) {
          out.overLimit = String((error as { code?: string }).code ?? (error as Error).message)
        }
        return out
      })

      expect(report.count === 3, `three images went in and ${String(report.count)} came back`)
      expect(
        JSON.stringify(report.sizes) === JSON.stringify([200, 240, 280]),
        `the batch came back out of order: ${JSON.stringify(report.sizes)}`,
      )
      expect(report.distinct === 3, 'two different images were stored under one reference')
      expect(report.mixedBatch !== 'accepted', 'a batch with one unreadable image was committed anyway')
      expect(report.overLimit !== 'accepted', 'a batch larger than the configured limit was accepted')
    },
  },

  {
    // Vision where this deployment actually needs it: an emulated machine.
    //
    // A guest that only draws pixels has no text to read, so the tool set it
    // gets is `vm_screenshot` and `read_image` — photograph the screen into
    // the workspace, then look at it. That is two subsystems meeting: the
    // emulator's framebuffer and the attachment pipeline this build answers
    // with the browser's own decoder. Either one silently wrong leaves an
    // agent driving a machine it cannot see.
    name: 'machine-vision',
    async run(page) {
      if (apiKey === '') {
        console.log('  skipped: set DEEPSEEK_API_KEY to exercise a real vision turn')
        return
      }
      // Windows 1.01: a graphical guest that needs no disk from anywhere, and
      // whose screen is unmistakable — a tiled desktop with MS-DOS Executive
      // on it, nothing like a terminal.
      await page.goto(`${url}?runtime=v86:windows1`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForHost(page)
      const up = await page.evaluate(async () => {
        const machine = (globalThis as unknown as { __DSH_WEB_MACHINE__: MachineHandle }).__DSH_WEB_MACHINE__
        return machine.ready(180_000) as Promise<boolean>
      })
      expect(up, 'Windows 1.01 never came up, so there was nothing to photograph')

      const result = await page.evaluate(async ([key, provider, model]: string[]) => {
        const { ctx } = globalThis.dsh
        const credentials = ctx.get('credentials') as { set(reference: string, value: string): Promise<void> }
        await credentials.set('DEEPSEEK_API_KEY', key)
        const proxy = ctx.get('apiProxy') as Gateway
        const created = await proxy.sessions.create({ rpcId: crypto.randomUUID(), payload: {} })
        if (!created.result.ok || created.result.value === undefined) {
          return { error: `session.create: ${JSON.stringify(created.result.error)}` }
        }
        const { sessionId } = created.result.value
        const selected = await proxy.sessions.selectModel({ rpcId: crypto.randomUUID(), payload: { sessionId, provider, model } })
        if (!selected.result.ok) return { error: `session.selectModel: ${JSON.stringify(selected.result.error)}` }

        const abort = new AbortController()
        const frames = proxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, abort.signal)
        let reply = ''
        const tools: string[] = []
        const collected = (async () => {
          for await (const frame of frames) {
            const event = frame.payload.event
            if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') reply += event.data.chunk.text ?? ''
            if (event?.type === 'tool/call') tools.push(String(event.data?.name ?? ''))
            if (event?.type === 'turn/end') break
          }
        })()

        const prompted = await proxy.sessions.prompt({
          rpcId: crypto.randomUUID(),
          payload: {
            sessionId,
            content: [{
              type: 'text',
              text: 'Take a screenshot of the machine, then look at that image with read_image and tell me what '
                + 'you actually see on the screen. Name the window titles and describe the desktop. Do not guess '
                + 'from what you know about the operating system — describe the picture.',
            }],
          },
        })
        if (!prompted.result.ok) { abort.abort(); return { error: `session.prompt: ${JSON.stringify(prompted.result.error)}` } }
        await Promise.race([collected, new Promise(resolve => setTimeout(resolve, 240_000))])
        abort.abort()
        return { reply, tools }
      }, [apiKey, VISION_PROVIDER, VISION_MODEL])

      expect(result.error === undefined, `the turn never ran: ${String(result.error)}`)
      const tools = result.tools ?? []
      expect(tools.includes('vm_screenshot'), `the model never photographed the screen; it called ${tools.join(', ')}`)
      expect(tools.includes('read_image'), `the model never looked at the photograph; it called ${tools.join(', ')}`)
      // What is on a Windows 1.01 desktop and on nothing else the model might
      // have hallucinated: the MS-DOS Executive file list is the whole screen.
      expect(
        /ms-?dos executive/i.test(result.reply ?? ''),
        `the model did not describe what is on the screen:\n${(result.reply ?? '').slice(0, 900)}`,
      )
    },
  },

  {
    // The model side. An image goes in through the same RPC the composer uses,
    // and the answer has to be about the picture.
    name: 'model-vision',
    async run(page) {
      if (apiKey === '') {
        console.log('  skipped: set DEEPSEEK_API_KEY to exercise a real vision turn')
        return
      }
      await waitForHost(page)
      const result = await page.evaluate(async ([key, provider, model]: string[]) => {
        const { ctx } = globalThis.dsh
        const credentials = ctx.get('credentials') as { set(reference: string, value: string): Promise<void> }
        await credentials.set('DEEPSEEK_API_KEY', key)
        const proxy = ctx.get('apiProxy') as Gateway

        const created = await proxy.sessions.create({ rpcId: crypto.randomUUID(), payload: {} })
        if (!created.result.ok || created.result.value === undefined) {
          return { error: `session.create: ${JSON.stringify(created.result.error)}` }
        }
        const { sessionId } = created.result.value

        const selected = await proxy.sessions.selectModel({ rpcId: crypto.randomUUID(), payload: { sessionId, provider, model } })
        if (!selected.result.ok) return { error: `session.selectModel: ${JSON.stringify(selected.result.error)}` }

        // A picture whose content is unambiguous and cannot be guessed from
        // the prompt: one large word, in one colour, on a plain field.
        const canvas = new OffscreenCanvas(512, 256)
        const context = canvas.getContext('2d')!
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 512, 256)
        context.fillStyle = '#111111'
        context.font = 'bold 92px sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('KANGAROO', 256, 128)
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        const base64 = btoa(binary)

        const abort = new AbortController()
        const frames = proxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, abort.signal)
        let reply = ''
        const collected = (async () => {
          for await (const frame of frames) {
            const event = frame.payload.event
            if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') reply += event.data.chunk.text ?? ''
            if (event?.type === 'turn/end') break
          }
        })()

        const prompted = await proxy.sessions.prompt({
          rpcId: crypto.randomUUID(),
          payload: {
            sessionId,
            content: [
              { type: 'image', mediaType: 'image/png', data: base64, name: 'word.png' },
              { type: 'text', text: 'One word is written in this image. Reply with only that word, in capitals.' },
            ],
          },
        })
        if (!prompted.result.ok) { abort.abort(); return { error: `session.prompt: ${JSON.stringify(prompted.result.error)}` } }

        await Promise.race([collected, new Promise(resolve => setTimeout(resolve, 150_000))])
        abort.abort()

        // The reply alone does not prove an image was sent: the durable log is
        // where an image block either exists or does not.
        const history = await proxy.sessions.history({ rpcId: crypto.randomUUID(), payload: { sessionId } })
        const text = JSON.stringify(history.result.value ?? {})
        return { reply, storedImage: /"type":"image"/.test(text) }
      }, [apiKey, VISION_PROVIDER, VISION_MODEL])

      expect(result.error === undefined, `the vision turn never started: ${String(result.error)}`)
      expect(result.storedImage === true, 'the prompt was recorded without an image block; nothing was sent to look at')
      expect(
        /kangaroo/i.test(result.reply ?? ''),
        `the model did not read the word in the image:\n${(result.reply ?? '').slice(0, 800)}`,
      )
    },
  },
]

/** Run the selected scenarios against a fresh page each. */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed })
  let failures = 0
  try {
    for (const scenario of scenarios) {
      if (only !== undefined && scenario.name !== only) continue
      console.log(`▶ ${scenario.name}`)
      const context = await browser.newContext()
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await scenario.run(page)
        console.log(`  ✓ ${scenario.name}`)
      } catch (error) {
        failures += 1
        console.log(`  ✗ ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`)
        if (errors.length > 0) console.log(`    page errors: ${errors.slice(0, 3).join(' | ')}`)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  if (failures > 0) process.exit(1)
}

await main()
