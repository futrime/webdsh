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
  // Single-page fallback, matching a static host configured for SPA routing.
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`serving dist/ on http://127.0.0.1:${String(port)}/`)
})
