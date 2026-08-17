/**
 * Route requests the page's own host should answer.
 *
 * A dsh plugin can register HTTP routes on `ctx.webServer` and serve its own
 * assets from them — `dsh-pet` serves a sprite sheet from `/pet/...`, and the
 * browser loads that through an `<img src>`, which no `fetch` patch can see.
 * This worker is the only place a page can intercept those.
 *
 * It claims nothing on its own. Every same-origin request goes to the network
 * first, so a deployed file always wins; only a 404 is offered to the
 * controlling page, and only a reply the page marks as handled is used. Nothing
 * is cached, and no path is exempt — a plugin may register a route under any
 * prefix, including ones that look static.
 */

/* eslint-env serviceworker */

self.addEventListener('install', () => {
  // Take over as soon as this version is ready; the page is already open and
  // waiting to route through it.
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // An earlier version of this build assembled a Linux disk image here and
    // kept its chunks in a cache. That runtime is gone; the cache is not, and
    // it is measured in hundreds of megabytes of a quota the workspace needs.
    await caches.delete('dsh-vm-disk-v1').catch(() => {})
    await self.clients.claim()
  })())
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

/**
 * Re-serve a response with the headers cross-origin isolation requires.
 *
 * The runtime needs `SharedArrayBuffer`, which a browser only grants a
 * cross-origin-isolated page — and that isolation is requested through response
 * headers a static host like GitHub Pages cannot be told to send. A service
 * worker is the one place a static deployment can add them, so it does.
 * @param {Response} response - the response to re-serve.
 * @returns {Response} the same body with isolation headers.
 */
function isolate(response) {
  if (response.status === 0 || response.type === 'opaque') return response
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  // Cross-origin subresources must opt in to being embedded by an isolated
  // page; marking them here is what keeps a third-party CDN loadable.
  if (url.origin !== self.location.origin) {
    if (request.mode === 'navigate') return
    event.respondWith(
      fetch(request, request.mode === 'no-cors' ? { mode: 'no-cors' } : undefined)
        .then(isolate)
        .catch(() => fetch(request)),
    )
    return
  }

  event.respondWith((async () => {
    // Network first, so a real deployed file always wins over a virtual route
    // and the common case costs nothing extra. Only a 404 — the host saying it
    // has no such file — is worth asking the page about.
    //
    // No path is exempt from that fallback. Exempting `assets/`, `shell/` and
    // `plugins/` as "obviously static" was wrong in exactly the case this
    // build exists to support: `dsh-client-modules` serves plugin bundles from
    // `/plugins`, and `dsh-client-hmr` serves `/plugins/events`, so a route a
    // plugin registered under a prefix that happens to look static could never
    // be reached, and answered 404 without the page ever being asked.
    try {
      const response = await fetch(request)
      if (response.status !== 404) return isolate(response)
    } catch {
      // Offline or blocked — the page may still be able to answer.
    }
    return isolate(await askPage(request) ?? new Response('not found', { status: 404 }))
  })())
})
