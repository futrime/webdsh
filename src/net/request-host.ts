/**
 * Preserve the `Host` header on `Request` objects built for the in-page API.
 *
 * dsh's `/api` fence is a DNS-rebinding defense: it reads the `Host` header and
 * refuses anything that is neither loopback nor a declared authority, and the
 * privileged methods (settings, credentials, agent presets) additionally
 * require loopback with no trust list at all. The host bridge implements that
 * by copying the incoming Node headers into a WHATWG `Request` — and a browser
 * strips `Host` from a constructed `Request`, because on a real fetch the user
 * agent owns that header.
 *
 * Here there is no fetch: the request is dispatched inside the same tab that
 * built it and never reaches a socket, so the reason the browser withholds
 * `Host` does not apply. This shim keeps the header readable on requests
 * addressed to the in-page server (`dsh.internal` and loopback authorities) and
 * leaves every other `Request` — including anything the agent's `curl` builds —
 * exactly as the platform made it.
 */

/** Headers the browser drops from a constructed `Request` but the fence reads. */
const PRESERVED = new Set(['host'])

/** Authorities whose requests are dispatched in-page rather than over the network. */
const INTERNAL_HOSTS = new Set(['dsh.internal', '127.0.0.1', 'localhost', '[::1]'])

/**
 * A `Headers` that also answers for the preserved names.
 *
 * It extends `Headers` so `headers instanceof Headers` — which the fence uses
 * to pick its accessor — stays true.
 */
class PreservingHeaders extends Headers {
  private readonly extra: Map<string, string>

  constructor(base: Headers, extra: Map<string, string>) {
    super(base)
    this.extra = extra
  }

  override get(name: string): string | null {
    return this.extra.get(name.toLowerCase()) ?? super.get(name)
  }

  override has(name: string): boolean {
    return this.extra.has(name.toLowerCase()) || super.has(name)
  }

  override forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    super.forEach(callback, thisArg)
    for (const [key, value] of this.extra) callback.call(thisArg, value, key, this)
  }

  override *entries(): HeadersIterator<[string, string]> {
    yield* super.entries()
    yield* this.extra.entries()
  }

  override *keys(): HeadersIterator<string> {
    yield* super.keys()
    yield* this.extra.keys()
  }

  override *values(): HeadersIterator<string> {
    yield* super.values()
    yield* this.extra.values()
  }

  override [Symbol.iterator](): HeadersIterator<[string, string]> {
    return this.entries()
  }
}

/** Collect the preserved headers from a `RequestInit`'s headers value. */
function collectPreserved(init: RequestInit | undefined): Map<string, string> {
  const found = new Map<string, string>()
  const headers = init?.headers
  if (headers === undefined) return found
  const visit = (name: string, value: string): void => {
    const key = name.toLowerCase()
    if (PRESERVED.has(key)) found.set(key, value)
  }
  if (headers instanceof Headers) headers.forEach((value, name) => { visit(name, value) })
  else if (Array.isArray(headers)) for (const [name, value] of headers) visit(name, value)
  else for (const [name, value] of Object.entries(headers)) visit(name, String(value))
  return found
}

/** Whether a request URL is dispatched in-page. */
function isInternal(input: RequestInfo | URL): boolean {
  try {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return INTERNAL_HOSTS.has(new URL(href).hostname)
  } catch {
    return false
  }
}

/** Install the shim. Idempotent. */
export function installRequestHostPreservation(): void {
  const Original = globalThis.Request
  if ((Original as { __dshPatched?: boolean }).__dshPatched === true) return

  const Patched = function PatchedRequest(this: unknown, input: RequestInfo | URL, init?: RequestInit): Request {
    const request = new Original(input as RequestInfo, init)
    if (!isInternal(input)) return request
    const preserved = collectPreserved(init)
    if (preserved.size === 0) return request
    Object.defineProperty(request, 'headers', {
      value: new PreservingHeaders(request.headers, preserved),
      configurable: true,
    })
    return request
  } as unknown as typeof Request

  Patched.prototype = Original.prototype
  Object.setPrototypeOf(Patched, Original)
  Object.defineProperty(Patched, '__dshPatched', { value: true })
  globalThis.Request = Patched
}
