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

/** The virtual path CheerpX reads the disk from. No such file is deployed. */
const DISK_PATH = 'vm/dsh.ext2'

/** Where the chunks that actually make up that disk are deployed. */
const DISK_CHUNKS = 'vm/disk'

/** The chunk manifest, fetched once. */
let diskManifest

/**
 * Decompressed chunks, most recently used last.
 *
 * A chunk is fetched and inflated whole, but a caller reads a few kilobytes at
 * a time, so without this every block read would re-inflate four megabytes.
 * The bound is what keeps a long session from holding the whole disk in memory.
 */
const diskCache = new Map()

/** How many inflated chunks to keep in memory. */
const DISK_CACHE_CHUNKS = 48

/** Where compressed chunks are kept between sessions. */
const DISK_CACHE_NAME = 'dsh-vm-disk-v1'

/**
 * Fetch one chunk and inflate it.
 * @param {string} url - the chunk's URL.
 * @param {boolean} gzipped - whether it is compressed.
 * @returns {Promise<Uint8Array|undefined>} the chunk's bytes.
 */
async function diskChunk(url, gzipped) {
  const cached = diskCache.get(url)
  if (cached !== undefined) {
    // Re-inserting moves it to the end, which is what makes eviction LRU.
    diskCache.delete(url)
    diskCache.set(url, cached)
    return cached
  }
  // Persisted across reloads, because a chunk is immutable and refetching one
  // over the network for every block read is the difference between a machine
  // that feels local and one that does not.
  let response
  try {
    const store = await caches.open(DISK_CACHE_NAME)
    response = await store.match(url)
    if (response === undefined) {
      const fetched = await fetch(url)
      if (!fetched.ok) return undefined
      await store.put(url, fetched.clone())
      response = fetched
    }
  } catch {
    response = await fetch(url)
  }
  if (!response.ok) return undefined
  const stream = gzipped && typeof DecompressionStream === 'function'
    ? response.body.pipeThrough(new DecompressionStream('gzip'))
    : response.body
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  diskCache.set(url, bytes)
  while (diskCache.size > DISK_CACHE_CHUNKS) diskCache.delete(diskCache.keys().next().value)
  return bytes
}

/**
 * Serve the VM's disk from the chunks it was split into.
 *
 * The disk is larger than any single file a static host will accept, so it
 * ships as chunks and is reassembled here — the one place a static deployment
 * runs code between a request and the network. CheerpX reads the disk by range
 * request and validates it with `ETag`, so both are answered exactly as a file
 * server would.
 * @param {Request} request - the request for the disk.
 * @returns {Promise<Response>} the requested byte range.
 */
async function serveDisk(request) {
  const base = new URL('./', self.location.href)
  if (diskManifest === undefined) {
    const response = await fetch(new URL(`${DISK_CHUNKS}/manifest.json`, base).href)
    if (!response.ok) return new Response('disk manifest missing', { status: 404 })
    diskManifest = await response.json()
  }
  const { size, chunkSize, chunks } = diskManifest
  const validators = {
    'accept-ranges': 'bytes',
    etag: `"dsh-vm-${String(size)}-${String(chunks.length)}"`,
    'last-modified': new Date(0).toUTCString(),
    'content-type': 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'cross-origin',
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
  if (range === null) {
    return new Response(null, { status: 200, headers: { ...validators, 'content-length': String(size) } })
  }
  const start = range[1] === '' ? size - Number(range[2]) : Number(range[1])
  const end = range[2] === '' || range[1] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...validators, 'content-range': `bytes */${String(size)}` } })
  }

  const out = new Uint8Array(end - start + 1)
  for (let offset = start; offset <= end;) {
    const index = Math.floor(offset / chunkSize)
    const within = offset - index * chunkSize
    const take = Math.min(chunkSize - within, end - offset + 1)
    const name = chunks[index]
    // A hole is a chunk that was entirely zero; the buffer is already zero, so
    // there is nothing to fetch or copy.
    if (name != null) {
      const bytes = await diskChunk(new URL(`${DISK_CHUNKS}/${name}`, base).href, diskManifest.encoding === 'gzip')
      if (bytes === undefined) return new Response('disk chunk missing', { status: 502 })
      out.set(bytes.subarray(within, within + take), offset - start)
    }
    offset += take
  }

  return new Response(out, {
    status: 206,
    headers: { ...validators, 'content-length': String(out.length), 'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}` },
  })
}

/**
 * Re-serve a response with the headers cross-origin isolation requires.
 *
 * CheerpX needs `SharedArrayBuffer`, which a browser only grants a
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
  // page; marking them here is what keeps CheerpX's own CDN loadable.
  if (url.origin !== self.location.origin) {
    if (request.mode === 'navigate') return
    event.respondWith(
      fetch(request, request.mode === 'no-cors' ? { mode: 'no-cors' } : undefined)
        .then(isolate)
        .catch(() => fetch(request)),
    )
    return
  }
  // The app's own files are served by the static host; only what it does not
  // have is worth asking the page about.
  const appBase = new URL('./', self.location.href).pathname
  // The VM's disk is assembled here rather than served as a file.
  if (url.pathname === appBase + DISK_PATH) {
    event.respondWith(serveDisk(request))
    return
  }
  const base = appBase
  for (const prefix of ['assets/', 'shell/', 'plugins/', 'vm/']) {
    if (!url.pathname.startsWith(base + prefix)) continue
    // Served by the static host, but still needs the isolation headers.
    event.respondWith(fetch(request).then(isolate))
    return
  }

  event.respondWith((async () => {
    // Prefer the network: a real file always wins over a virtual route.
    try {
      const response = await fetch(request)
      if (response.status !== 404) return isolate(response)
    } catch {
      // Offline or blocked — the page may still be able to answer.
    }
    return isolate(await askPage(request) ?? new Response('not found', { status: 404 }))
  })())
})
