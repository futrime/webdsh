/**
 * Minimal static server for `dist/`, used by the e2e driver and for local
 * inspection.
 *
 * `vite preview` keeps an open handle on the output directory, which makes a
 * rebuild-while-serving loop fail; this serves the same files without it, and
 * matches how a static host (GitHub Pages) answers.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const port = Number(process.argv[2] ?? 4173)

/** Content types for the file kinds this build emits. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  let file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  // Single-page fallback, but only for a navigation. GitHub Pages answers an
  // unknown path with 404, and the app depends on that: a plugin registers HTTP
  // routes on the in-page server, and the service worker only offers a request
  // to the page once the network has declined it. Falling back to index.html
  // for every path would shadow every one of those routes — which is exactly
  // how `/plugins/events` came to be answered with HTML.
  const wantsDocument = (req.headers.accept ?? '').includes('text/html')
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (!wantsDocument) {
      res.writeHead(404, { 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-opener-policy': 'same-origin' })
      res.end('not found')
      return
    }
    file = join(root, 'index.html')
  }
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  // The VM's disk is read by range request — it is streamed block by block
  // rather than downloaded, so a 2 GB image costs only what is actually read.
  const stats = statSync(file)
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range !== null) {
    const start = range[1] === '' ? stats.size - Number(range[2]) : Number(range[1])
    const end = range[2] === '' || range[1] === '' ? stats.size - 1 : Math.min(Number(range[2]), stats.size - 1)
    res.writeHead(206, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-range': `bytes ${String(start)}-${String(end)}/${String(stats.size)}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, content-length, accept-ranges, etag, last-modified',
      'last-modified': stats.mtime.toUTCString(),
      etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  const immutable = pathname.startsWith('/vm/disk/') && pathname.endsWith('.gz')
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    // The VM needs SharedArrayBuffer, which needs a cross-origin-isolated
    // page. GitHub Pages cannot send these, so the service worker adds them
    // there; sending them here keeps local runs identical to a deployment.
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'cross-origin',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges, etag, last-modified',
    'last-modified': stats.mtime.toUTCString(),
    etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
  })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`serving dist/ on http://127.0.0.1:${String(port)}/`)
})
