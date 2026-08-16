/**
 * Route requests the page's own host should answer.
 *
 * A dsh plugin can register HTTP routes on `ctx.webServer` and serve its own
 * assets from them — `dsh-pet` serves a sprite sheet from `/pet/...`, and the
 * browser loads that through an `<img src>`, which no `fetch` patch can see.
 * This worker is the only place a page can intercept those.
 *
 * It claims nothing on its own: every same-origin request is offered to the
 * controlling page, and only a reply the page marks as handled is used. Anything
 * else — the app's own assets, the plugin bundles, cross-origin requests — goes
 * to the network untouched, and there is no caching.
 */

/* eslint-env serviceworker */

self.addEventListener('install', () => {
  // Take over as soon as this version is ready; the page is already open and
  // waiting to route through it.
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** How long the page may take to answer before the request goes to the network. */
const PAGE_TIMEOUT_MS = 15000

/**
 * Ask the controlling page to handle one request.
 * @param {Request} request - the intercepted request.
 * @returns {Promise<Response | undefined>} the page's response, or undefined when it declined.
 */
async function askPage(request) {
  const client = await self.clients.get(request.clientId ?? '')
    ?? (await self.clients.matchAll({ type: 'window' }))[0]
  if (client === undefined) return undefined

  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.arrayBuffer()
  const headers = {}
  request.headers.forEach((value, name) => { headers[name] = value })

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      resolve(undefined)
    }, PAGE_TIMEOUT_MS)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      channel.port1.close()
      const reply = event.data
      if (reply === undefined || reply.handled !== true) {
        resolve(undefined)
        return
      }
      resolve(new Response(reply.body ?? null, { status: reply.status, headers: reply.headers }))
    }
    client.postMessage(
      { type: 'dsh-host-request', url: request.url, method: request.method, headers, body },
      body === undefined ? [channel.port2] : [channel.port2, body],
    )
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // The app's own files are served by the static host; only what it does not
  // have is worth asking the page about.
  if (url.pathname.startsWith(new URL('./', self.location.href).pathname + 'assets/')) return
  if (url.pathname.startsWith(new URL('./', self.location.href).pathname + 'shell/')) return
  if (url.pathname.startsWith(new URL('./', self.location.href).pathname + 'plugins/')) return

  event.respondWith((async () => {
    // Prefer the network: a real file always wins over a virtual route.
    try {
      const response = await fetch(request)
      if (response.status !== 404) return response
    } catch {
      // Offline or blocked — the page may still be able to answer.
    }
    return await askPage(request) ?? new Response('not found', { status: 404 })
  })())
})
