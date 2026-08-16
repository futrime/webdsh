/**
 * Serve `dist/` under a path prefix, the way a GitHub Pages *project* site does
 * (`https://user.github.io/<repo>/`).
 *
 * The build uses relative asset URLs precisely so this works, and that is worth
 * testing rather than assuming: a single root-absolute URL anywhere in the
 * chain — the shell entry, a stylesheet, a font, a plugin bundle — would 404
 * only in this configuration.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const port = Number(process.argv[2] ?? 4175)
const prefix = process.argv[3] ?? '/deepseek-web-harness'

/** Content types for the file kinds this build emits. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  if (!pathname.startsWith(prefix)) {
    // Everything outside the prefix is a miss, exactly as it would be on a
    // project site — this is what catches a root-absolute asset URL.
    res.writeHead(404)
    res.end(`not found (this server only serves ${prefix}/)`)
    return
  }
  const relative = pathname.slice(prefix.length) || '/'
  let file = join(root, normalize(relative).replace(/^(\.\.[/\\])+/, ''))
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
  console.log(`serving dist/ at http://127.0.0.1:${String(port)}${prefix}/`)
})
