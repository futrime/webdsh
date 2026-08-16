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

/**
 * Answer one request from the virtual server.
 * @param message - the worker's request description.
 * @returns the reply to post back.
 */
async function answer(message: HostRequestMessage): Promise<{ handled: boolean, status?: number, headers?: Record<string, string>, body?: ArrayBuffer }> {
  try {
    const request = new Request(message.url, {
      method: message.method,
      headers: message.headers,
      ...(message.body === undefined ? {} : { body: message.body }),
    })
    const response = await dispatchVirtualRequest(request)
    // A 404 from the virtual server means no route claimed the path; letting the
    // worker fall through keeps its own 404 the single answer.
    if (response === undefined || response.status === 404) return { handled: false }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => { headers[name] = value })
    return { handled: true, status: response.status, headers, body: await response.arrayBuffer() }
  } catch (error) {
    console.warn('[service-worker] host request failed:', error)
    return { handled: false }
  }
}

/**
 * Register the worker and start answering its requests.
 * @returns whether a worker is registered and controlling this page.
 */
export async function installRequestRouter(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) return false

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as HostRequestMessage | undefined
    if (message?.type !== 'dsh-host-request') return
    const port = event.ports[0]
    if (port === undefined) return
    void answer(message).then(reply => { port.postMessage(reply) })
  })

  try {
    // Scoped to the app's own directory, so a project-path deployment does not
    // claim the rest of the origin.
    const scope = new URL('./', document.baseURI).href
    await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope })
    if (navigator.serviceWorker.controller !== null) return true
    // A first visit is uncontrolled until the worker activates and claims it.
    await Promise.race([
      new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => { resolve() }, { once: true })
      }),
      new Promise<void>((resolve) => { setTimeout(resolve, 3000) }),
    ])
    return navigator.serviceWorker.controller !== null
  } catch (error) {
    // A denied or unavailable registration is not a boot failure.
    console.warn('[service-worker] not registered; plugin-served assets will not load:', error)
    return false
  }
}
