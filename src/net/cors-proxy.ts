/**
 * The page's CORS policy: one configurable proxy, applied automatically.
 *
 * Network reach in a tab is the browser's, and CORS is the whole rule — a host
 * answers only if it says so in its own response headers. That is not a bug in
 * a request and it is not something a caller can retry its way out of, so the
 * decision belongs in one place rather than in each caller: plugin installs
 * from GitHub, model requests to a provider that never expected a browser, and
 * whatever a plugin fetches all fail the same way and all want the same
 * recovery.
 *
 * The recovery is a proxy, and every part of that is deliberate:
 *
 * - **Direct first, always.** A proxy is a third party that sees the whole
 *   request, so it is a fallback after a real failure and never a default
 *   route. A host that answers this browser — the npm registry, DeepSeek,
 *   Google, OpenRouter, and Anthropic as pi-ai addresses it, with the
 *   `anthropic-dangerous-direct-browser-access` header that opts its CORS in —
 *   never touches it.
 * - **Per origin, once.** The first failure for an origin costs a round trip.
 *   After a proxied retry succeeds, that origin is remembered and goes straight
 *   through. The memo is dropped again the moment a proxied request fails, so a
 *   proxy that stops answering does not leave the page routing to it forever.
 * - **Configurable, and replaceable.** The default is a public instance this
 *   build measured; a user who does not want to route through it points the
 *   Network settings page at their own, or turns the whole thing off.
 *
 * What this cannot reach is the runtime. A WebContainer's requests leave from
 * StackBlitz's own worker, which neither this patch nor `public/sw.js` ever
 * sees, so a command the agent runs is not proxied here — `src/host/jsh-tool.ts`
 * reads the same configuration and tells the model what it may use instead.
 */

/** How a proxy is addressed, and whether one is used at all. */
export interface ProxyConfig {
  /** Whether a failed cross-origin request may be retried through the proxy. */
  enabled: boolean
  /**
   * The proxy URL, with `{url}` for the target as-is and `{encoded}` for it
   * percent-encoded. A prefix proxy is `https://host/{url}`; one that takes a
   * query parameter is `https://host/?url={encoded}`.
   */
  template: string
}

/**
 * The default proxy.
 *
 * Chosen by measurement rather than reputation. From this page, with a
 * production `Origin`, these were tried with a POST carrying an
 * `authorization` header and a JSON body: `proxy.cors.sh` answered in 0.4s and
 * `cors.eu.org` in 3.3s, both forwarding headers and body intact and both
 * replying `access-control-allow-origin: *` with no key required.
 * `corsproxy.io` and `cors-anywhere` answered 403, and `allorigins`,
 * `codetabs`, `thingproxy`, `yacdn`, `cors.lol` and `test.cors.workers.dev`
 * were unreachable or refused the method. The first one is the default; the
 * second is the documented alternative, and the field takes either.
 */
export const DEFAULT_PROXY_TEMPLATE = 'https://proxy.cors.sh/{url}'

/** The alternative offered beside the default, measured the same way. */
export const ALTERNATIVE_PROXY_TEMPLATE = 'https://cors.eu.org/{url}'

/**
 * How long the settings page's probe waits.
 *
 * Only the probe is bounded. A real request is not, because a model streaming
 * a long answer is indistinguishable from a stall at this layer, and cutting
 * one off at a fixed deadline would break the thing the proxy exists to make
 * work. `dsh-timeout` already bounds a model call by its own idle watchdog.
 */
const PROBE_TIMEOUT_MS = 15_000

/** Where the choice is kept. Not the virtual filesystem: this is read before it is restored. */
const STORAGE_KEY = 'dsh-web:network'

/** The shipped default, used until a user changes it. */
const DEFAULTS: ProxyConfig = { enabled: true, template: DEFAULT_PROXY_TEMPLATE }

/** The current configuration, read once and kept. */
let current: ProxyConfig | undefined

/** Origins that answered only through the proxy, so the direct attempt is skipped. */
const proxyOnly = new Set<string>()

/**
 * Origins the policy must leave alone.
 *
 * `testProxy` puts the proxy it is testing in here for the duration, because
 * the policy would otherwise rescue it: a request to a *candidate* proxy is an
 * ordinary cross-origin request, so a broken candidate would fail, be retried
 * through the working configured one, and be reported as working.
 */
const excluded = new Set<string>()

/**
 * The configuration in force.
 * @returns the stored configuration, or the shipped default.
 */
export function proxyConfig(): ProxyConfig {
  if (current !== undefined) return current
  current = DEFAULTS
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<ProxyConfig>
      current = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        template: typeof parsed.template === 'string' && parsed.template.trim() !== ''
          ? parsed.template.trim()
          : DEFAULTS.template,
      }
    }
  } catch {
    // Unreadable storage (a quota error, a disabled origin, a hand-edited
    // value) is not worth failing a page load over; the default still works.
  }
  return current
}

/**
 * Replace the configuration and forget what was learned under the old one.
 * @param next - the configuration to store.
 * @returns the configuration now in force.
 */
export function setProxyConfig(next: Partial<ProxyConfig>): ProxyConfig {
  const merged: ProxyConfig = {
    enabled: next.enabled ?? proxyConfig().enabled,
    template: (next.template ?? proxyConfig().template).trim() || DEFAULTS.template,
  }
  current = merged
  // A different proxy is a different answer to "can this origin be reached",
  // so nothing learned under the previous one carries over.
  proxyOnly.clear()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // The choice still applies to this page; it just will not outlive it.
  }
  return merged
}

/**
 * Address one URL through a proxy template.
 * @param url - the target URL.
 * @param template - the proxy template.
 * @returns the proxied URL, or undefined when the template names no placeholder.
 */
export function proxiedUrl(url: string, template = proxyConfig().template): string | undefined {
  if (!template.includes('{url}') && !template.includes('{encoded}')) return undefined
  return template.replaceAll('{encoded}', encodeURIComponent(url)).replaceAll('{url}', url)
}

/** Whether a URL is the proxy itself, which must never be proxied again. */
function isProxyTarget(url: URL, template: string): boolean {
  try {
    return new URL(template.replace(/\{(url|encoded)\}/g, '')).origin === url.origin
  } catch {
    return false
  }
}

/**
 * Whether a rejection is the browser refusing to hand over a response.
 *
 * `fetch` rejects with a `TypeError` for a CORS refusal, a DNS failure, and a
 * dropped connection alike — the specification is deliberate about not telling
 * a page which. An `AbortError` is the caller's own cancellation and must pass
 * through untouched; everything else is worth one retry.
 * @param error - the rejection.
 * @returns whether to try the proxy.
 */
function isNetworkRefusal(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  return error instanceof TypeError
}

/**
 * Send the same request to the proxy instead of to its origin.
 *
 * The caller's own `init` is reused whenever there is one, and that is the
 * whole point rather than an optimization. A page can carry more than one
 * `fetch` wrapper — the e2e driver installs a recorder underneath this one to
 * capture what the model was actually offered — and a wrapper reads
 * `init.body`. Rebuilding the call as a `Request` turns that body into a
 * stream nothing below can read, so the request still goes out and every
 * observer beneath silently sees nothing. That is not hypothetical: it is what
 * broke `preset-shell-tools`, and it broke it only for the requests after the
 * first, because those are the ones that skip the direct attempt.
 *
 * Only a caller that passed a `Request` gets one back, because there is
 * nothing else to pass on.
 * @param original - the next `fetch` in the chain.
 * @param target - the proxied URL.
 * @param input - the caller's first argument.
 * @param init - the caller's second argument.
 * @param spare - the cloned request, for the `Request` case.
 * @returns the response.
 */
async function fetchThroughProxy(
  original: typeof fetch,
  target: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  spare: Request,
): Promise<Response> {
  // A third party gets no cookies either way. Whatever authorizes the request
  // travels in a header the caller set deliberately; ambient credentials do not.
  if (!(input instanceof Request)) {
    return original(target, { ...init, credentials: 'omit', redirect: 'follow' })
  }
  const body = spare.method === 'GET' || spare.method === 'HEAD' ? undefined : await spare.arrayBuffer()
  return original(new Request(target, {
    method: spare.method,
    headers: spare.headers,
    ...body === undefined || body.byteLength === 0 ? {} : { body },
    credentials: 'omit',
    redirect: 'follow',
    signal: spare.signal,
  }))
}

/**
 * Perform one cross-origin fetch, falling back to the proxy when the browser
 * refuses the direct answer.
 *
 * The direct attempt is made with the caller's own arguments rather than with
 * the normalized `Request`, and that is not a micro-optimization. A page can
 * carry more than one `fetch` wrapper — the e2e driver installs a recorder
 * underneath this one to capture what the model was offered — and a wrapper
 * reads `init.body`. Handing the layer below a `Request` it did not build
 * makes that body a stream it cannot read, so the request still goes out and
 * the observer silently sees nothing. Only the proxied retry, which is a
 * different request by construction, is built here.
 * @param original - the next `fetch` in the chain.
 * @param input - the caller's first argument, untouched.
 * @param init - the caller's second argument, untouched.
 * @param request - the same request, normalized, used only to build the retry.
 * @param url - its parsed URL.
 * @returns the response.
 */
export async function fetchCrossOrigin(
  original: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  request: Request,
  url: URL,
): Promise<Response> {
  const config = proxyConfig()
  const eligible = config.enabled
    && (url.protocol === 'http:' || url.protocol === 'https:')
    && !isProxyTarget(url, config.template)
    && !excluded.has(url.origin)
  const target = eligible ? proxiedUrl(url.href, config.template) : undefined
  if (target === undefined) return original(input as RequestInfo, init)

  // Cloned before the attempt, because a failed `fetch` may still have consumed
  // the body — and when the caller passed a `Request`, the direct attempt and
  // the retry would otherwise be reading the same one.
  let spare: Request | undefined
  try {
    spare = request.clone()
  } catch {
    // A body that cannot be teed (a stream with no second reader) gets one
    // attempt, which is the same one it would have had before.
  }

  // An origin already known to answer only through the proxy skips the direct
  // attempt: it would cost a round trip to learn the same thing again. If the
  // proxy has since stopped answering, the memo is what is wrong — drop it, so
  // the next request measures the world again instead of inheriting a
  // conclusion drawn under a proxy that no longer works.
  if (proxyOnly.has(url.origin) && spare !== undefined) {
    try {
      return await fetchThroughProxy(original, target, input, init, spare)
    } catch (error) {
      proxyOnly.delete(url.origin)
      throw error
    }
  }

  try {
    return await original(input as RequestInfo, init)
  } catch (error) {
    if (!isNetworkRefusal(error) || spare === undefined) throw error
    const response = await fetchThroughProxy(original, target, input, init, spare)
    proxyOnly.add(url.origin)
    return response
  }
}

/**
 * Ask whether the configured proxy actually works, for the settings page.
 *
 * The request goes to the proxy, never to the target, and the proxy under test
 * is exempt from the policy — so what comes back is the candidate's own answer
 * and not the configured proxy rescuing it. It reports the status rather than
 * judging it: a proxy answering 403 is reachable and refusing, which is a
 * different problem from one that cannot be reached at all.
 * @param template - the template to test, defaulting to the configured one.
 * @returns what happened, in one sentence.
 */
export async function testProxy(template = proxyConfig().template): Promise<{ ok: boolean, detail: string }> {
  const probe = 'https://api.openai.com/v1/models'
  const target = proxiedUrl(probe, template)
  if (target === undefined) {
    return { ok: false, detail: 'The proxy URL needs a {url} or {encoded} placeholder for the target.' }
  }
  // The candidate is exempted from the policy for the duration, or a broken one
  // would be rescued by the working configured proxy and reported as working.
  let origin: string | undefined
  try {
    origin = new URL(target).origin
    excluded.add(origin)
  } catch {
    return { ok: false, detail: 'That is not a URL this page can address.' }
  }
  try {
    // Bounded, because a probe that hangs is worse than one that fails: this is
    // a button on a settings page, and a public proxy that black-holes the
    // request would otherwise leave it spinning with nothing to report.
    const response = await fetch(target, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    // 401 is the probe reaching OpenAI without a key, which is exactly right.
    if (response.status === 401) return { ok: true, detail: 'Reached api.openai.com through the proxy (401, no key sent).' }
    if (response.status < 400) return { ok: true, detail: `The proxy answered ${String(response.status)}; the request reached it.` }
    // Anything else in the 4xx range is the proxy refusing *us* rather than
    // the target answering — 429 above all, which is what a public instance
    // says once it has had enough. Reporting that as working would send a user
    // away from the one setting that would fix it.
    return {
      ok: false,
      detail: response.status === 429
        ? 'The proxy is rate-limiting this page (429). Try another, or run your own.'
        : `The proxy refused the request (${String(response.status)}).`,
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      detail: timedOut
        ? `The proxy did not answer within ${String(PROBE_TIMEOUT_MS / 1000)}s.`
        : `The proxy could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    excluded.delete(origin)
  }
}

/** Origins this session learned it can only reach through the proxy. */
export function proxiedOrigins(): string[] {
  return [...proxyOnly].sort()
}
