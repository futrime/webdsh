/**
 * Lifecycle tests for the in-page node:http transport.
 *
 * These run without a browser because Node exposes the same WHATWG
 * Request/Response/ReadableStream primitives the shim adapts. The important
 * contract is that every path settles: normal replies stream, failures reject,
 * cancellation reaches the Node handler, and no close event is duplicated.
 */

import {
  createServer,
  dispatchVirtualRequest,
  type IncomingMessageShim,
  type ServerResponseShim,
} from '../src/node/http.ts'

type Handler = (request: IncomingMessageShim, response: ServerResponseShim) => void

/** Fail with a focused assertion message. */
function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Turn an unknown rejection into readable text. */
function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Reject when a promise does not settle within the test deadline. */
async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`timeout after ${String(milliseconds)}ms`)) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Assert that an operation rejects and return its error text. */
async function rejected(promise: Promise<unknown>, milliseconds = 1_000): Promise<string> {
  try {
    await within(promise, milliseconds)
  } catch (error) {
    const text = errorText(error)
    expect(!text.includes('timeout after'), `the operation remained pending: ${text}`)
    return text
  }
  throw new Error('assertion failed: the operation unexpectedly fulfilled')
}

/** Listen for one test and always release the module-global virtual server. */
async function withServer(handler: Handler, test: () => Promise<void>): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(3080, '127.0.0.1', resolve) })
  try {
    await test()
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

/** Build a request whose signal can be controlled by a test. */
function request(signal?: AbortSignal): Request {
  return new Request('https://dsh.test/api/probe', signal === undefined ? undefined : { signal })
}

async function main(): Promise<void> {
  console.log('▶ normal responses expose headers and stream every chunk')
  const normalEvents: string[] = []
  let writeAfterEndCode: unknown
  await withServer((_request, response) => {
    response.on('finish', () => { normalEvents.push('finish') })
    response.on('close', () => { normalEvents.push('close') })
    response.writeHead(201, { 'content-type': 'text/plain', 'x-virtual-probe': 'yes' })
    response.write('first-')
    response.end('second')
    response.end('ignored')
    response.destroy(new Error('ignored after end'))
    try {
      response.write('late')
    } catch (error) {
      writeAfterEndCode = (error as { code?: unknown }).code
    }
  }, async () => {
    const response = await within(dispatchVirtualRequest(request()))
    expect(response !== undefined, 'the listening server was not discovered')
    expect(response.status === 201, `the status changed to ${String(response.status)}`)
    expect(response.headers.get('x-virtual-probe') === 'yes', 'the response header was lost')
    expect(await within(response.text()) === 'first-second', 'the streamed body changed')
    await Promise.resolve()
    expect(JSON.stringify(normalEvents) === '["finish","close"]', `normal lifecycle events changed: ${JSON.stringify(normalEvents)}`)
    expect(writeAfterEndCode === 'ERR_STREAM_WRITE_AFTER_END', `late write used ${String(writeAfterEndCode)}`)
  })

  console.log('▶ committed headers cannot diverge from the delivered Response')
  const headerMutationCodes: unknown[] = []
  await withServer((_request, response) => {
    response.writeHead(201, { 'x-first': 'yes' })
    for (const mutate of [
      () => { response.writeHead(202, { 'x-second': 'no' }) },
      () => { response.setHeader('x-third', 'no') },
      () => { response.removeHeader('x-first') },
    ]) {
      try {
        mutate()
        headerMutationCodes.push(undefined)
      } catch (error) {
        headerMutationCodes.push((error as { code?: unknown }).code)
      }
    }
    response.end('committed')
  }, async () => {
    const response = await within(dispatchVirtualRequest(request()))
    expect(response !== undefined, 'the committed response is missing')
    expect(response.status === 201, `the committed status changed to ${String(response.status)}`)
    expect(response.headers.get('x-first') === 'yes', 'the committed header was removed')
    expect(response.headers.get('x-second') === null && response.headers.get('x-third') === null, 'a late header reached the wire')
    expect(headerMutationCodes.every(code => code === 'ERR_HTTP_HEADERS_SENT'), `header mutations used ${JSON.stringify(headerMutationCodes)}`)
    expect(await response.text() === 'committed', 'the committed response body changed')
  })

  console.log('▶ destroy before headers rejects dispatch instead of hanging')
  await withServer((_request, response) => {
    response.destroy(new Error('before headers'))
  }, async () => {
    const error = await rejected(dispatchVirtualRequest(request()))
    expect(error.includes('before headers'), `the original failure was lost: ${error}`)
  })

  console.log('▶ destroy after headers errors the delivered response body')
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    queueMicrotask(() => { response.destroy(new Error('after headers')) })
  }, async () => {
    const response = await within(dispatchVirtualRequest(request()))
    expect(response !== undefined, 'the response headers were not delivered')
    const error = await rejected(response.text())
    expect(error.includes('after headers'), `the body failure was lost: ${error}`)
  })

  console.log('▶ cancelling a response body closes once and rejects a producer that writes late')
  let consumerCloseCount = 0
  let resolveConsumerLateWrite: ((code: unknown) => void) | undefined
  const consumerLateWrite = new Promise<unknown>((resolve) => { resolveConsumerLateWrite = resolve })
  await withServer((_request, response) => {
    response.on('close', () => { consumerCloseCount += 1 })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('chunk')
    setTimeout(() => {
      try {
        response.write('late chunk')
        resolveConsumerLateWrite?.(undefined)
      } catch (error) {
        resolveConsumerLateWrite?.((error as { code?: unknown }).code)
      }
    }, 0)
  }, async () => {
    const response = await within(dispatchVirtualRequest(request()))
    expect(response?.body !== null && response?.body !== undefined, 'the streaming body is missing')
    const reader = response.body.getReader()
    const first = await within(reader.read())
    expect(new TextDecoder().decode(first.value) === 'chunk', 'the first stream chunk changed')
    await within(reader.cancel('consumer finished'))
    await Promise.resolve()
    expect(consumerCloseCount === 1, `close fired ${String(consumerCloseCount)} times`)
    expect(await within(consumerLateWrite) === 'ERR_STREAM_DESTROYED', 'a producer late write did not fail immediately')
  })

  console.log('▶ abort before headers rejects and closes the Node response')
  let abortBeforeCloseCount = 0
  let markAbortHandlerReady: (() => void) | undefined
  const abortHandlerReady = new Promise<void>((resolve) => { markAbortHandlerReady = resolve })
  await withServer((_request, response) => {
    response.on('close', () => { abortBeforeCloseCount += 1 })
    // Coordinate with the test so the abort happens after dispatch has made a
    // response, but before the handler commits headers. Request.arrayBuffer()
    // resolves at different microtask boundaries across Node releases.
    markAbortHandlerReady?.()
  }, async () => {
    const controller = new AbortController()
    const pending = dispatchVirtualRequest(request(controller.signal))
    await within(abortHandlerReady)
    controller.abort(new Error('request aborted before headers'))
    const error = await rejected(pending)
    expect(error.includes('request aborted before headers'), `the abort reason was lost: ${error}`)
    expect(abortBeforeCloseCount === 1, `close fired ${String(abortBeforeCloseCount)} times`)
  })

  console.log('▶ abort after headers errors the body, closes once and rejects a late write')
  let abortAfterCloseCount = 0
  let resolveAbortLateWrite: ((code: unknown) => void) | undefined
  const abortLateWrite = new Promise<unknown>((resolve) => { resolveAbortLateWrite = resolve })
  await withServer((_request, response) => {
    response.on('close', () => { abortAfterCloseCount += 1 })
    response.writeHead(200, { 'content-type': 'text/plain' })
    setTimeout(() => {
      try {
        response.write('late chunk')
        resolveAbortLateWrite?.(undefined)
      } catch (error) {
        resolveAbortLateWrite?.((error as { code?: unknown }).code)
      }
    }, 0)
  }, async () => {
    const controller = new AbortController()
    const response = await within(dispatchVirtualRequest(request(controller.signal)))
    expect(response !== undefined, 'the response headers were not delivered')
    const body = response.text()
    controller.abort(new Error('request aborted after headers'))
    const error = await rejected(body)
    expect(error.includes('request aborted after headers'), `the body abort was lost: ${error}`)
    expect(abortAfterCloseCount === 1, `close fired ${String(abortAfterCloseCount)} times`)
    expect(await within(abortLateWrite) === 'ERR_STREAM_DESTROYED', 'an aborted producer late write did not fail immediately')
  })

  console.log('▶ bodyless statuses remain bodyless')
  for (const status of [204, 304]) {
    await withServer((_request, response) => {
      response.writeHead(status)
      response.end('ignored body')
    }, async () => {
      const response = await within(dispatchVirtualRequest(request()))
      expect(response !== undefined, `status ${String(status)} did not produce a response`)
      expect(response.status === status, `status ${String(status)} changed to ${String(response.status)}`)
      expect(response.body === null, `status ${String(status)} unexpectedly has a body`)
    })
  }

  console.log('\n✓ virtual HTTP replies, failures and cancellation all settle')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
