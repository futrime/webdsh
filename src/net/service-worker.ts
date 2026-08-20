/**
 * The page half of the request router.
 *
 * `public/sw.js` offers same-origin requests the static host could not serve;
 * this answers them from the in-page virtual server, which is where a plugin's
 * registered `ctx.webServer` routes live. That is what makes an asset a plugin
 * serves itself — a sprite sheet, an icon, a downloadable export — load through
 * an ordinary `<img src>` or link.
 *
 * Registration is best-effort by design: a Service Worker needs a secure
 * context, and `file://` or a hardened profile has none. Without one the app is
 * fully functional; only plugin-served assets are unavailable, and the plugin
 * that needs them says so in its own way.
 */

import { dispatchVirtualRequest } from '../node/http.ts'

/** What `public/sw.js` sends for each request it wants answered. */
interface HostRequestMessage {
  type: 'dsh-host-request'
  url: string
  method: string
  headers: Record<string, string>
  body?: ArrayBuffer
}

/** What this half posts back, and what to hand over rather than copy. */
interface HostReply {
  reply: { handled: boolean, status?: number, headers?: Record<string, string>, body?: ArrayBuffer | ReadableStream }
  transfer: Transferable[]
}

/**
 * Answer one request from the virtual server.
 *
 * The body is handed over as a stream wherever the browser allows it. Reading
 * it into an `ArrayBuffer` first looks simpler and is wrong for the two cases
 * that matter most: an event stream never ends, so buffering it waits forever
 * and the worker eventually gives up and reports 404 — which is what happened
 * to `/plugins/events` — and a large download is held whole in memory before a
 * single byte reaches the caller.
 * @param message - the worker's request description.
 * @returns the reply to post back, and anything to transfer with it.
 */
async function answer(message: HostRequestMessage): Promise<HostReply> {
  try {
    const request = new Request(message.url, {
      method: message.method,
      headers: message.headers,
      ...(message.body === undefined ? {} : { body: message.body }),
    })
    const response = await dispatchVirtualRequest(request)
    // A 404 from the virtual server means no route claimed the path; letting the
    // worker fall through keeps its own 404 the single answer.
    if (response === undefined || response.status === 404) return { reply: { handled: false }, transfer: [] }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => { headers[name] = value })
    const base = { handled: true, status: response.status, headers }
    const body = response.body
    if (body !== null && supportsStreamTransfer()) {
      return { reply: { ...base, body }, transfer: [body as unknown as Transferable] }
    }
    const buffered = await response.arrayBuffer()
    return { reply: { ...base, body: buffered }, transfer: [buffered] }
  } catch (error) {
    console.warn('[service-worker] host request failed:', error)
    return { reply: { handled: false }, transfer: [] }
  }
}

/** Whether this browser can hand a `ReadableStream` to another realm. */
let streamTransfer: boolean | undefined

/**
 * Probe for transferable streams once.
 *
 * Chromium has them; Safari does not. Where they are missing the body is
 * buffered instead, which is correct for a file and merely unusable for an
 * endless stream — the same trade every other page in that browser makes.
 */
function supportsStreamTransfer(): boolean {
  if (streamTransfer !== undefined) return streamTransfer
  try {
    const channel = new MessageChannel()
    const probe = new ReadableStream()
    channel.port1.postMessage(probe, [probe as unknown as Transferable])
    channel.port1.close()
    channel.port2.close()
    streamTransfer = true
  } catch {
    streamTransfer = false
  }
  return streamTransfer
}

/**
 * Reload once if the page is not yet cross-origin isolated.
 *
 * The virtual machine needs `SharedArrayBuffer`, which a browser grants only a
 * cross-origin isolated page — and isolation is requested through response
 * headers that a static host cannot be told to send. The worker adds them, but
 * it only sees requests once it controls the page, so the document that
 * registered it was fetched without them. One reload through the worker fixes
 * that; the flag makes sure it stays one.
 */
function reloadForIsolationOnce(): boolean {
  if (globalThis.crossOriginIsolated) return false
  try {
    if (sessionStorage.getItem('dsh:isolation-reload') === '1') return false
    sessionStorage.setItem('dsh:isolation-reload', '1')
  } catch {
    // Storage is unavailable, so a reload could loop; leaving the page
    // un-isolated costs the VM and nothing else.
    return false
  }
  location.reload()
  return true
}

/** Whether the request router is ready, or navigation has taken over startup. */
export interface RequestRouterStatus {
  controlled: boolean
  reloading: boolean
}

/**
 * Register the worker and start answering its requests.
 * @returns whether a worker controls the page and whether startup triggered the isolation reload.
 */
export async function installRequestRouter(): Promise<RequestRouterStatus> {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) {
    return { controlled: false, reloading: false }
  }

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as HostRequestMessage | undefined
    if (message?.type !== 'dsh-host-request') return
    const port = event.ports[0]
    if (port === undefined) return
    void answer(message).then(({ reply, transfer }) => { port.postMessage(reply, transfer) })
  })

  try {
    // Scoped to the app's own directory, so a project-path deployment does not
    // claim the rest of the origin.
    const scope = new URL('./', document.baseURI).href
    await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope })
    if (navigator.serviceWorker.controller !== null) {
      return { controlled: true, reloading: reloadForIsolationOnce() }
    }
    // A first visit is uncontrolled until the worker activates and claims it.
    await Promise.race([
      new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => { resolve() }, { once: true })
      }),
      new Promise<void>((resolve) => { setTimeout(resolve, 3000) }),
    ])
    const controlled = navigator.serviceWorker.controller !== null
    return { controlled, reloading: controlled && reloadForIsolationOnce() }
  } catch (error) {
    // A denied or unavailable registration is not a boot failure.
    console.warn('[service-worker] not registered; plugin-served assets will not load:', error)
    return { controlled: false, reloading: false }
  }
}
