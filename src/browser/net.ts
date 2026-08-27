/**
 * The Browser machine's network stack, which lives on the page's side of the
 * isolation boundary.
 *
 * A browsed page runs in a frame with an opaque origin, and an opaque origin
 * can fetch almost nothing: measured in the browser this build targets, a
 * plain `fetch('https://example.com/')` from inside one is refused before it
 * leaves, because `Origin: null` matches no `access-control-allow-origin` a
 * server is willing to send. That is not a limitation to work around — it *is*
 * the isolation. The frame has no network at all, and every byte it ever sees
 * was fetched here, by the page, and handed across a message port.
 *
 * So this module is the browser's network process, and the frame is its
 * renderer. The split is the same one a real browser makes and for a related
 * reason: the part that talks to the internet and the part that runs a
 * stranger's JavaScript should not be the same part.
 *
 * ## What it can reach, and what it cannot
 *
 * Everything here goes through the page's own `fetch`, which
 * `src/net/virtual-network.ts` has already patched with this deployment's CORS
 * policy — so a host that refuses browser requests is retried once through the
 * configured proxy, automatically, exactly as it is everywhere else in this
 * app. That is the whole reason browsing arbitrary sites works at all: most of
 * the web does not send `access-control-allow-origin`, and without a proxy a
 * page can read almost none of it.
 *
 * It also fixes what a session can and cannot do, and the tools say so rather
 * than letting it be discovered:
 *
 * - **No request carries a cookie.** `Cookie` is a forbidden header name, so
 *   no page's `fetch` may set one. Cookies work inside the browser machine —
 *   `document.cookie` reads and writes a real jar — and do not survive the
 *   network leg. See `src/browser/profile.ts`.
 * - **No response's `set-cookie` is visible**, for the matching reason: CORS
 *   does not expose it cross-origin.
 * - **A response's headers are the CORS-safelisted ones**, which is enough for
 *   `content-type` and rarely more.
 * - **Anything requiring a login therefore will not work**, and that follows
 *   from the two above rather than from anything this build chose.
 *
 * A deployment that wants the other kind of network already has the setting
 * for it — Settings → Network's relay is raw TCP — but a relay is reached from
 * the page, and putting a real HTTP client behind it is a larger piece of work
 * than this module is. What is here is the honest version of what a static
 * page can do today.
 */

import { proxyConfig } from '../net/cors-proxy.ts'

/** A fetched resource, as the rewriter and the frame see it. */
export interface Fetched {
  /** Where it actually came from, after redirects. */
  url: string
  status: number
  /** The `content-type`, lowercased, without parameters. */
  type: string
  /** The full `content-type` header, parameters and all, for the charset. */
  contentType: string
  bytes: Uint8Array
}

/** Why a fetch did not produce a page. */
export class BrowserNetworkError extends Error {
  readonly url: string

  /**
   * @param url - what was being fetched.
   * @param detail - what went wrong, in a sentence a model can act on.
   */
  constructor(url: string, detail: string) {
    super(detail)
    this.name = 'BrowserNetworkError'
    this.url = url
  }
}

/**
 * The largest resource that is inlined into a document.
 *
 * Subresources reach the frame as `data:` URLs (see {@link asDataUrl}), and a
 * `data:` URL is a string held three times over — here, in the rewritten HTML,
 * and in the frame's own copy. Ten megabytes of video would be thirty
 * megabytes of string for something the model cannot see anyway, so anything
 * past this is dropped and the element is told it failed to load, which is a
 * state every site already handles.
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024

/** How long one resource may take before the page gives up on it. */
const RESOURCE_TIMEOUT_MS = 20_000

/** How long the main document may take. */
const DOCUMENT_TIMEOUT_MS = 45_000

/**
 * Turn a fetch failure into a sentence that says what to do about it.
 *
 * "Failed to fetch" is what the browser says for a refused CORS preflight, a
 * DNS failure, a blocked mixed-content request and an offline machine alike,
 * and a model given that string retries the same URL until it runs out of
 * turns. This says which of those it probably was, and what the setting is
 * called.
 * @param url - the URL that failed.
 * @param error - what `fetch` threw.
 * @returns the message.
 */
function explain(url: URL, error: unknown): string {
  const proxy = proxyConfig()
  const name = error instanceof Error ? error.message : String(error)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${url.protocol} is not a scheme this browser can fetch; only http: and https: are.`
  }
  if (proxy.enabled) {
    return `${name}. The host refused the request and the CORS proxy did not rescue it — the site may be `
      + 'down, the name may not resolve, or the proxy may be rate-limiting. Settings → Network is where '
      + 'the proxy is configured.'
  }
  return `${name}. Most sites do not permit cross-origin reads, and this session has no CORS proxy `
    + 'configured to retry through — Settings → Network is where one is turned on. Without it, only '
    + 'hosts that send `access-control-allow-origin` can be browsed.'
}

/**
 * Fetch one URL as the browser machine.
 *
 * Redirects are followed by `fetch` itself, so `response.url` is where the
 * document actually came from — which matters more than it looks: it is what
 * `<base>` is set to, what relative URLs resolve against, and what the address
 * bar shows. A machine that displayed the URL it asked for rather than the one
 * it got would send the model chasing links that resolve against the wrong
 * directory.
 * @param target - the URL to fetch.
 * @param init - method, headers and body, as a navigation or a form submission supplies them.
 * @param timeoutMs - how long to wait.
 * @returns the resource.
 */
export async function load(
  target: string,
  init: { method?: string, headers?: Record<string, string>, body?: BodyInit } = {},
  timeoutMs = DOCUMENT_TIMEOUT_MS,
): Promise<Fetched> {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new BrowserNetworkError(target, `${target} is not an absolute URL.`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url.href, {
      method: init.method ?? 'GET',
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
      // Never the browser's real cookies. Sending them would put the user's
      // own logged-in identity behind whatever the agent browses, which is the
      // one thing an isolated machine must not do — and third-party cookie
      // rules would mostly drop them anyway.
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const buffer = await response.arrayBuffer()
    return {
      url: response.url === '' ? url.href : response.url,
      status: response.status,
      type: contentType.split(';')[0]?.trim().toLowerCase() ?? '',
      contentType,
      bytes: new Uint8Array(buffer),
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BrowserNetworkError(url.href, `timed out after ${String(Math.round(timeoutMs / 1000))}s.`)
    }
    throw new BrowserNetworkError(url.href, explain(url, error))
  } finally {
    clearTimeout(timer)
  }
}

/** Base64 for bytes, in chunks so a large resource does not blow the argument limit. */
function base64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/**
 * A resource as a `data:` URL, which is the only shape the frame can use.
 *
 * `blob:` would be the obvious choice and is the wrong one, for a reason that
 * was measured rather than guessed: a `blob:` URL created inside an opaque
 * origin taints a canvas it is drawn into, so a screenshot of a page holding
 * one throws `SecurityError` on export. `data:` URLs do not taint. Since the
 * visual mode of this machine is exactly "draw the document into a canvas and
 * read it back", every subresource has to be a `data:` URL or the screenshot
 * tool stops working the moment a page has an image on it.
 * @param resource - the fetched bytes.
 * @returns the URL.
 */
export function asDataUrl(resource: Fetched): string {
  const type = resource.contentType === '' ? 'application/octet-stream' : resource.contentType
  return `data:${type};base64,${base64(resource.bytes)}`
}

/**
 * A cache of subresources, so one image used on four pages is fetched once.
 *
 * Keyed by absolute URL and held for the life of the machine. It is not an
 * HTTP cache — nothing here reads `cache-control`, because cross-origin
 * responses do not expose it — it is the far cruder thing that keeps a
 * stylesheet from being refetched on every navigation within a site.
 */
export class ResourceCache {
  readonly #entries = new Map<string, Promise<string | undefined>>()
  #bytes = 0

  /**
   * The `data:` URL for one subresource, fetched if this is the first ask.
   * @param url - the absolute URL.
   * @returns the URL, or undefined when it could not be fetched or was too large.
   */
  async dataUrl(url: string): Promise<string | undefined> {
    const held = this.#entries.get(url)
    if (held !== undefined) return held
    const pending = this.#fetch(url)
    this.#entries.set(url, pending)
    return pending
  }

  /**
   * Fetch and encode one subresource.
   * @param url - the absolute URL.
   * @returns its `data:` URL, or undefined.
   */
  async #fetch(url: string): Promise<string | undefined> {
    try {
      const resource = await load(url, {}, RESOURCE_TIMEOUT_MS)
      if (resource.status >= 400) return undefined
      if (resource.bytes.length > MAX_INLINE_BYTES) return undefined
      this.#bytes += resource.bytes.length
      return asDataUrl(resource)
    } catch {
      // A subresource that will not load is an ordinary thing on the web and
      // not a reason to fail the page: the element keeps its unresolved URL,
      // the site's own error handling runs, and browsing continues.
      return undefined
    }
  }

  /** Roughly how much has been inlined, for the machine's own accounting. */
  size(): number {
    return this.#bytes
  }

  /** Forget everything, as a hard reload would. */
  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }
}
