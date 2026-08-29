/**
 * Turning a page off the web into a page the isolated frame can run.
 *
 * The frame the browsed document lives in has an opaque origin and therefore
 * no network of its own (`src/browser/net.ts` says why). So a document cannot
 * simply be handed over: every URL in it points somewhere the frame cannot
 * reach. What is handed over is a *self-contained* document — stylesheets
 * inlined, scripts inlined, images and fonts turned into `data:` URLs, and
 * everything that remains a link left absolute so the frame can intercept it
 * and ask the page to navigate.
 *
 * ## Parsed by the browser, not by a parser
 *
 * The rewriting happens here, on the page's side, using `DOMParser`. That is
 * deliberate and it is the single biggest correctness decision in this file: a
 * hand-written HTML rewriter gets tag soup wrong, and tag soup is most of the
 * web. `DOMParser` is the same parser the browser uses for a real navigation,
 * so a document that a browser would recover from is recovered the same way
 * here. The document it produces has no browsing context, which is what makes
 * this safe to do on the page's side: no script in it runs, no resource in it
 * loads, and nothing observes the rewrite. It is inert until the frame adopts
 * it.
 *
 * ## The one thing a shim cannot fix
 *
 * Almost everything a page reaches for can be replaced from inside the frame —
 * `fetch`, `XMLHttpRequest`, `localStorage`, `document.cookie` and
 * `indexedDB` are all ordinary properties, and `src/browser/frame.ts` replaces
 * them. `window.location` is not: it is non-configurable, and
 * `Object.defineProperty(window, 'location', …)` throws `TypeError`. Measured,
 * in the target browser, not assumed.
 *
 * That single fact is why this file parses JavaScript. A page that reads
 * `location.href` in a frame like this one reads `about:srcdoc`, and a site
 * that routes on `location.pathname` — which is most of them — gets the wrong
 * answer and behaves as if it were on a page that does not exist. So script
 * text is parsed with acorn and the handful of expressions that name
 * `location`, `top` and `parent` are rewritten to read a virtual one. Nothing
 * else about the script is touched: this is not a sandbox, and it is not
 * trying to be. The sandbox is the frame's opaque origin, which the browser
 * enforces and no rewrite can weaken.
 */

import { parse as parseJs } from 'acorn'
import MagicString from 'magic-string'
import { asDataUrl, load, type ResourceCache } from './net.ts'

/** The global the frame exposes for everything a rewrite redirects. */
export const RUNTIME_GLOBAL = '__wbRuntime'

/** How deep nested frames are followed before one is left empty. */
const MAX_FRAME_DEPTH = 1

/** How many module specifiers deep an `import` graph is followed. */
const MAX_MODULE_DEPTH = 6

/**
 * Attributes that name a subresource the frame must be handed the bytes of.
 *
 * Split by element because the same attribute name means different things:
 * `<link href>` is a subresource only for some `rel` values, and `<a href>` is
 * never one.
 */
const RESOURCE_ATTRIBUTES: Record<string, string[]> = {
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  embed: ['src'],
  track: ['src'],
  input: ['src'],
  object: ['data'],
}

/**
 * Decode a fetched document's bytes.
 *
 * The charset comes from the `content-type` where the server sent one, and
 * from a `<meta charset>` where it did not — which means a first pass in
 * Latin-1 to find the meta tag, then a second in the charset it names. Skipping
 * that second pass is how a page in Shift_JIS or GBK arrives as mojibake, and
 * a model reading mojibake reports the site as broken.
 * @param bytes - the document's bytes.
 * @param contentType - the `content-type` header, for its charset parameter.
 * @returns the text.
 */
export function decodeDocument(bytes: Uint8Array, contentType: string): string {
  const declared = /charset=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]
  const tryDecode = (label: string): string | undefined => {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      return undefined
    }
  }
  if (declared !== undefined) {
    const decoded = tryDecode(declared)
    if (decoded !== undefined) return decoded
  }
  const sniffed = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096))
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniffed)?.[1]
    ?? /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(sniffed)?.[1]
  if (meta !== undefined && meta.toLowerCase() !== 'utf-8') {
    const decoded = tryDecode(meta)
    if (decoded !== undefined) return decoded
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Resolve a URL against the document, or report that it is not one to fetch.
 * @param value - the attribute's text.
 * @param base - the document's base URL.
 * @returns the absolute URL, or undefined for a fragment, a `data:` URL, or nonsense.
 */
function absolute(value: string, base: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  if (/^(?:data|blob|javascript|about|mailto|tel):/i.test(trimmed)) return undefined
  try {
    return new URL(trimmed, base).href
  } catch {
    return undefined
  }
}

/**
 * Rewrite the `url()` and `@import` references in a stylesheet.
 *
 * Regular expressions, and for once that is the right tool rather than the
 * lazy one: what has to change is a well-delimited token, the surrounding
 * grammar is irrelevant to it, and a full CSS parse would have to round-trip
 * every vendor hack on the web without breaking one. The cost is that a
 * `url(` inside a string literal would be rewritten too, which is a thing no
 * real stylesheet contains.
 * @param css - the stylesheet text.
 * @param base - what relative URLs resolve against.
 * @param cache - where subresources are fetched from.
 * @returns the rewritten stylesheet.
 */
export async function rewriteCss(css: string, base: string, cache: ResourceCache): Promise<string> {
  const jobs: Promise<void>[] = []
  const replacements = new Map<string, string>()

  const collect = (raw: string): void => {
    const url = absolute(raw, base)
    if (url === undefined || replacements.has(raw)) return
    replacements.set(raw, raw)
    jobs.push((async () => {
      const inlined = await cache.dataUrl(url)
      replacements.set(raw, inlined ?? url)
    })())
  }

  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
  const importPattern = /@import\s+(['"])([^'"]+)\1/gi
  for (const match of css.matchAll(urlPattern)) collect(match[2] ?? '')
  for (const match of css.matchAll(importPattern)) collect(match[2] ?? '')
  await Promise.all(jobs)

  return css
    .replace(urlPattern, (whole, quote: string, raw: string) => {
      const replaced = replacements.get(raw)
      return replaced === undefined ? whole : `url(${quote}${replaced}${quote})`
    })
    .replace(importPattern, (whole, quote: string, raw: string) => {
      const replaced = replacements.get(raw)
      return replaced === undefined ? whole : `@import ${quote}${replaced}${quote}`
    })
}

/** Every node in an ESTree tree, parents before children. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (typeof record.type === 'string') yield record
  for (const key of Object.keys(record)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
    const value = record[key]
    if (Array.isArray(value)) for (const child of value) yield* walk(child)
    else if (value !== null && typeof value === 'object') yield* walk(value)
  }
}

/** The objects whose `.location` is the window's, and so must be redirected. */
const WINDOW_NAMES = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'document'])

/** The bare identifiers a page reads that mean something this machine virtualises. */
const VIRTUAL_GLOBALS = new Set(['location', 'top', 'parent'])

/**
 * Rewrite the expressions that must not reach the real window.
 *
 * Three names and nothing else. `location`, because it cannot be shimmed and
 * everything else can. `top` and `parent`, because a page that reads them gets
 * a window it is cross-origin to, and the frame-busting check every large site
 * runs — `if (top !== self) top.location = self.location` — throws a
 * `SecurityError` that stops the rest of the script instead of doing nothing.
 *
 * Bare identifiers are only rewritten when the script declares no binding of
 * that name anywhere in it. That is a blunt rule and a deliberately safe one:
 * proving that a particular `location` is the global one needs real scope
 * analysis, and getting it wrong means rewriting a local variable and breaking
 * a script that worked. A file with its own `location` variable keeps every
 * one of them and loses only the virtualisation, which is the failure that
 * costs least.
 * @param source - the script's text.
 * @param kind - whether to parse it as a module.
 * @returns the rewritten script, or the original when it does not parse.
 */
export function rewriteJs(source: string, kind: 'script' | 'module' = 'script'): string {
  if (!/\b(?:location|top|parent)\b/.test(source)) return source
  let tree: unknown
  try {
    tree = parseJs(source, {
      ecmaVersion: 'latest',
      sourceType: kind === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowHashBang: true,
    })
  } catch {
    // Not parseable as this kind — a module served as a classic script, or a
    // dialect acorn does not know. Rewriting it blind would corrupt it; left
    // alone it at least runs, and reads a location that is not the site's.
    return source
  }

  const nodes = [...walk(tree)]
  const declared = new Set<string>()
  for (const node of nodes) {
    if (node.type !== 'VariableDeclarator' && node.type !== 'FunctionDeclaration'
      && node.type !== 'ClassDeclaration' && node.type !== 'FunctionExpression'
      && node.type !== 'ArrowFunctionExpression' && node.type !== 'ImportSpecifier'
      && node.type !== 'ImportDefaultSpecifier' && node.type !== 'CatchClause') continue
    for (const inner of walk(node.id ?? null)) {
      if (inner.type === 'Identifier') declared.add(String(inner.name))
    }
    for (const parameter of (node.params as unknown[] | undefined) ?? []) {
      for (const inner of walk(parameter)) {
        if (inner.type === 'Identifier') declared.add(String(inner.name))
      }
    }
    if (node.type === 'CatchClause') {
      for (const inner of walk(node.param ?? null)) {
        if (inner.type === 'Identifier') declared.add(String(inner.name))
      }
    }
  }

  const magic = new MagicString(source)
  /** Ranges already replaced, so a member expression is not rewritten twice. */
  const done: [number, number][] = []
  const overlaps = (start: number, end: number): boolean =>
    done.some(([from, to]) => start < to && end > from)

  // Longest first: `window.location` must be replaced as a whole before the
  // bare `location` pass would look at its property.
  for (const node of nodes) {
    if (node.type !== 'MemberExpression' || node.computed === true) continue
    const property = node.property as Record<string, unknown> | undefined
    if (property?.type !== 'Identifier' || property.name !== 'location') continue
    const object = node.object as Record<string, unknown> | undefined
    if (object?.type !== 'Identifier' || !WINDOW_NAMES.has(String(object.name))) continue
    const start = Number(node.start)
    const end = Number(node.end)
    magic.overwrite(start, end, `${RUNTIME_GLOBAL}.location`)
    done.push([start, end])
  }

  for (const node of nodes) {
    if (node.type !== 'Identifier') continue
    const name = String(node.name)
    if (!VIRTUAL_GLOBALS.has(name) || declared.has(name)) continue
    const start = Number(node.start)
    const end = Number(node.end)
    if (overlaps(start, end)) continue
    // `{ location: 1 }`, `x.location`, `class { location() {} }` — all of them
    // are the name in a position where it is not a reference. The text either
    // side is enough to tell, and is cheaper than threading parents through.
    const before = source.slice(Math.max(0, start - 40), start)
    if (/[.?]\s*$/.test(before)) continue
    const after = source.slice(end, end + 20)
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue
    magic.overwrite(start, end, `${RUNTIME_GLOBAL}.${name}`)
    done.push([start, end])
  }

  return magic.toString()
}

/** What one page's rewrite produced. */
export interface RewrittenDocument {
  /** The finished, self-contained HTML. */
  html: string
  /** Where it came from, after redirects. */
  url: string
  /** The document's title, as parsed, so a tab has a name before it runs. */
  title: string
}

/**
 * Put a runtime ahead of everything a document brought with it.
 *
 * Ahead is load-bearing: a shim installed after the page's first inline script
 * is a shim the page has already got round. `<base>` stays in front of it,
 * because relative URLs have to resolve while the runtime is still evaluating.
 * @param html - the rewritten document.
 * @param runtime - the script tags to insert.
 * @returns the document with the runtime in it.
 */
export function injectRuntime(html: string, runtime: string): string {
  const marker = /<base\b[^>]*>/i.exec(html)
  if (marker !== null) {
    return html.slice(0, marker.index + marker[0].length) + runtime + html.slice(marker.index + marker[0].length)
  }
  // `\b`, or the fallback matches `<header>` and installs the runtime in the
  // middle of the body — behind the page's own scripts, which is the one thing
  // this must never do. Same anchoring the `<base>` marker above already has.
  const withHead = html.replace(/<head\b[^>]*>/i, (head) => `${head}${runtime}`)
  if (withHead !== html) return withHead
  // A document with no head at all — the parser will make one, but there is
  // nowhere to inject ahead of it, so the runtime leads the document.
  return `<!doctype html><html><head>${runtime}</head>${html.replace(/^[\s\S]*?<html[^>]*>/i, '')}`
}

/** Everything a rewrite pass needs to reach the network and remember what it fetched. */
export interface RewriteContext {
  cache: ResourceCache
  /** How many frames deep this document is. */
  depth: number
  /** Modules already turned into `data:` URLs, keyed by absolute URL. */
  modules: Map<string, Promise<string>>
  /**
   * The runtime a nested frame's document is given, when the machine wants one
   * in there.
   *
   * A frame inside a browsed page is its own opaque origin — measured, and it
   * is why nothing can reach into one from the document that holds it. So a
   * frame that is to be driven has to carry its own copy of the runtime, with
   * its own token, and report to the machine directly. The engine supplies
   * this; the rewriter only knows where to put what it hands back.
   */
  frameRuntime?: (url: string, token: string) => string
  /** Names the next frame, so its element and its document agree on one token. */
  frameToken?: () => string
}

/**
 * Rewrite an ES module and everything it imports, into one `data:` URL.
 *
 * A module's specifiers are resolved against *its own* URL, so the graph has
 * to be walked rather than flattened — and each module becomes a `data:` URL
 * that the importing module names. The depth limit is not a correctness
 * measure but a cost one: a large application's module graph is thousands of
 * files, and a page that pulled all of them would spend a minute doing it.
 * @param url - the module's absolute URL.
 * @param context - the pass's shared state.
 * @param depth - how deep in the graph this module is.
 * @returns the `data:` URL that evaluates it.
 */
export async function moduleUrl(url: string, context: RewriteContext, depth = 0): Promise<string> {
  const held = context.modules.get(url)
  if (held !== undefined) return held
  const pending = (async (): Promise<string> => {
    try {
      const resource = await load(url)
      let text = decodeDocument(resource.bytes, resource.contentType)
      if (depth < MAX_MODULE_DEPTH) text = await rewriteModuleSpecifiers(text, resource.url, context, depth)
      const rewritten = rewriteJs(text, 'module')
      return `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(rewritten)))}`
    } catch {
      // A module that will not load becomes one that throws where it is
      // imported, which is what a browser does with a 404 module and what the
      // importing code is already written to survive.
      return `data:text/javascript,throw new Error(${JSON.stringify(`failed to load ${url}`)})`
    }
  })()
  context.modules.set(url, pending)
  return pending
}

/**
 * Point a module's static imports at rewritten copies.
 * @param source - the module's text.
 * @param base - its own URL.
 * @param context - the pass's shared state.
 * @param depth - how deep this module is.
 * @returns the module with its specifiers replaced.
 */
async function rewriteModuleSpecifiers(
  source: string,
  base: string,
  context: RewriteContext,
  depth: number,
): Promise<string> {
  let tree: unknown
  try {
    tree = parseJs(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  } catch {
    return source
  }
  const magic = new MagicString(source)
  const jobs: Promise<void>[] = []
  for (const node of walk(tree)) {
    const isStatic = node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration'
    const source_ = node.source as Record<string, unknown> | undefined
    if (!isStatic || source_?.type !== 'Literal' || typeof source_.value !== 'string') continue
    const resolved = absolute(source_.value, base)
    if (resolved === undefined) continue
    const start = Number(source_.start)
    const end = Number(source_.end)
    jobs.push((async () => {
      magic.overwrite(start, end, JSON.stringify(await moduleUrl(resolved, context, depth + 1)))
    })())
  }
  await Promise.all(jobs)
  return magic.toString()
}

/**
 * Rewrite one fetched document into a self-contained one.
 * @param html - the document's text.
 * @param url - where it came from, after redirects.
 * @param context - the pass's shared state.
 * @returns the finished document.
 */
export async function rewriteDocument(
  html: string,
  url: string,
  context: RewriteContext,
): Promise<RewrittenDocument> {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const head = parsed.head as HTMLHeadElement | null
  const root = parsed.documentElement

  // `<base>` is how relative URLs keep resolving against the site rather than
  // against `about:srcdoc`, and it is the reason a link on a rewritten page
  // still points where it did. Measured: `document.baseURI` inside a sandboxed
  // srcdoc frame does follow it, which is what makes the whole approach work.
  for (const existing of [...parsed.querySelectorAll('base')]) existing.remove()
  const base = parsed.createElement('base')
  base.setAttribute('href', url)
  head?.prepend(base)

  // A site's own CSP names origins that no longer appear in the document —
  // everything is inline or a `data:` URL now — so the only thing it can do
  // here is forbid what the rewrite produced.
  for (const meta of [...parsed.querySelectorAll('meta[http-equiv]')]) {
    const equiv = meta.getAttribute('http-equiv')?.toLowerCase()
    if (equiv === 'content-security-policy') meta.remove()
  }
  // Subresource integrity is a hash of the file as served; every file here has
  // been rewritten, so every hash is now wrong and would block its own script.
  for (const element of [...parsed.querySelectorAll('[integrity]')]) element.removeAttribute('integrity')
  // Same idea: a rewritten script is not the file the site signed, and
  // `crossorigin` on a `data:` URL is meaningless.
  for (const element of [...parsed.querySelectorAll('[crossorigin]')]) element.removeAttribute('crossorigin')

  const jobs: Promise<void>[] = []

  // Ordinary subresources: the element keeps its element-ness and gets bytes.
  for (const [tag, attributes] of Object.entries(RESOURCE_ATTRIBUTES)) {
    for (const element of [...parsed.getElementsByTagName(tag)]) {
      for (const attribute of attributes) {
        const raw = element.getAttribute(attribute)
        if (raw === null) continue
        const resolved = absolute(raw, url)
        if (resolved === undefined) continue
        jobs.push((async () => {
          const inlined = await context.cache.dataUrl(resolved)
          element.setAttribute(attribute, inlined ?? resolved)
        })())
      }
    }
  }

  // `srcset` is a list with descriptors, so each candidate is resolved on its own.
  for (const element of [...parsed.querySelectorAll('[srcset]')]) {
    const raw = element.getAttribute('srcset')
    if (raw === null) continue
    jobs.push((async () => {
      const candidates = await Promise.all(raw.split(',').map(async (candidate) => {
        const parts = candidate.trim().split(/\s+/)
        const first = parts[0] ?? ''
        const resolved = absolute(first, url)
        if (resolved === undefined) return candidate.trim()
        const inlined = await context.cache.dataUrl(resolved)
        return [inlined ?? resolved, ...parts.slice(1)].join(' ')
      }))
      element.setAttribute('srcset', candidates.join(', '))
    })())
  }

  // Stylesheets become `<style>`, because a `data:` URL stylesheet resolves its
  // own `url()` references against itself and would lose the site's images.
  for (const link of [...parsed.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    const href = link.getAttribute('href')
    if (href === null) continue
    const resolved = absolute(href, url)
    if (resolved === undefined) continue
    if (!rel.split(/\s+/).includes('stylesheet')) {
      // An icon or a preload: keep it fetchable, but nothing depends on it.
      if (rel.includes('icon')) {
        jobs.push((async () => {
          const inlined = await context.cache.dataUrl(resolved)
          if (inlined !== undefined) link.setAttribute('href', inlined)
        })())
      } else link.remove()
      continue
    }
    jobs.push((async () => {
      try {
        const resource = await load(resolved)
        const style = parsed.createElement('style')
        const media = link.getAttribute('media')
        if (media !== null) style.setAttribute('media', media)
        style.textContent = await rewriteCss(
          decodeDocument(resource.bytes, resource.contentType),
          resource.url,
          context.cache,
        )
        link.replaceWith(style)
      } catch {
        link.remove()
      }
    })())
  }

  for (const style of [...parsed.querySelectorAll('style')]) {
    const text = style.textContent ?? ''
    if (text === '') continue
    jobs.push((async () => {
      style.textContent = await rewriteCss(text, url, context.cache)
    })())
  }

  for (const element of [...parsed.querySelectorAll('[style]')]) {
    const text = element.getAttribute('style') ?? ''
    if (!text.includes('url(')) continue
    jobs.push((async () => {
      element.setAttribute('style', await rewriteCss(text, url, context.cache))
    })())
  }

  // Scripts: fetched, rewritten, inlined. Order is preserved because the
  // elements stay where they are and only their contents change.
  for (const script of [...parsed.querySelectorAll('script')]) {
    const type = (script.getAttribute('type') ?? '').toLowerCase()
    const isModule = type === 'module'
    // A `type` this build does not know is data, not code: JSON-LD, a
    // template, an import map. Leaving it exactly as it is, is correct.
    if (type !== '' && !isModule && !/javascript|ecmascript/.test(type)) continue
    const src = script.getAttribute('src')
    if (src === null) {
      const text = script.textContent ?? ''
      if (text.trim() === '') continue
      script.textContent = rewriteJs(text, isModule ? 'module' : 'script')
      continue
    }
    const resolved = absolute(src, url)
    if (resolved === undefined) continue
    jobs.push((async () => {
      if (isModule) {
        script.setAttribute('src', await moduleUrl(resolved, context, 0))
        return
      }
      try {
        const resource = await load(resolved)
        script.removeAttribute('src')
        script.textContent = rewriteJs(decodeDocument(resource.bytes, resource.contentType), 'script')
      } catch {
        script.remove()
      }
    })())
  }

  // Nested frames, to a depth. A site that puts its content in an iframe is
  // common enough that leaving them all blank would misreport those pages as
  // empty; following them for ever would fetch the whole web.
  for (const frame of [...parsed.querySelectorAll('iframe,frame')]) {
    const src = frame.getAttribute('src')
    frame.removeAttribute('src')
    // Whatever the page called these, it is not what they mean. `data-wb-frame`
    // is the machine's routing key — a document that arrives already wearing
    // one (on a `srcdoc` frame, or below the depth this follows, either of
    // which leaves the loop before the attribute is written) names a *live
    // sibling's* runtime, so `frameLocator()` on the decoy resolves to the real
    // frame and types into it. `data-wb-src` is only ever reported, but a page
    // that can choose it can lie to `browser_inspect` about where a frame came
    // from. Both are re-written below when this machine has fetched the frame.
    frame.removeAttribute('data-wb-frame')
    frame.removeAttribute('data-wb-src')
    const resolved = src === null ? undefined : absolute(src, url)
    if (resolved === undefined || context.depth >= MAX_FRAME_DEPTH) continue
    // The frame's real source, kept as data so a snapshot can say where the
    // frame came from — the `src` attribute has to go, or the browser fetches
    // it cross-origin and gets nothing.
    frame.setAttribute('data-wb-src', resolved)
    const token = context.frameToken?.() ?? ''
    jobs.push((async () => {
      try {
        const resource = await load(resolved)
        if (!resource.type.includes('html')) return
        const inner = await rewriteDocument(
          decodeDocument(resource.bytes, resource.contentType),
          resource.url,
          { ...context, depth: context.depth + 1 },
        )
        const runtime = token === '' ? '' : context.frameRuntime?.(resource.url, token) ?? ''
        frame.setAttribute('srcdoc', runtime === '' ? inner.html : injectRuntime(inner.html, runtime))
        // The token goes on only once there is a runtime wearing it. Written
        // ahead of the fetch, a frame whose source could not be loaded still
        // advertised one, so `frameLocator()` resolved to a token no document
        // would ever claim and the caller was told "the page replaced it —
        // resolve the frame again", which returned the same dead token for
        // ever. Now it gets the message that says what actually happened.
        if (runtime !== '') frame.setAttribute('data-wb-frame', token)
      } catch {
        // An unreachable frame stays an empty one.
      }
    })())
  }

  // Inline event handlers are script too, and the same `location` problem
  // applies to every one of them.
  for (const element of [...parsed.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (!attribute.name.startsWith('on') || attribute.value === '') continue
      element.setAttribute(attribute.name, rewriteJs(attribute.value, 'script'))
    }
  }

  // Links and forms keep real, absolute URLs. The frame intercepts them and
  // asks the page to navigate, so what matters is that the URL is the one the
  // site meant — not that the browser could follow it.
  for (const anchor of [...parsed.querySelectorAll('a[href],area[href]')]) {
    const href = anchor.getAttribute('href')
    if (href === null) continue
    const resolved = absolute(href, url)
    if (resolved !== undefined) anchor.setAttribute('href', resolved)
  }
  for (const form of [...parsed.querySelectorAll('form')]) {
    const action = form.getAttribute('action')
    const resolved = action === null ? url : absolute(action, url) ?? url
    form.setAttribute('action', resolved)
  }

  await Promise.all(jobs)

  return {
    html: `<!doctype html>\n${root.outerHTML}`,
    url,
    title: parsed.title,
  }
}
