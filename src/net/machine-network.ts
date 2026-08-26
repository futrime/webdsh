/**
 * The emulated machine's route out of the page.
 *
 * A WebContainer reaches the network because Node's `fetch` inside it is the
 * browser's `fetch`: HTTP over somebody else's TCP, subject to CORS and to
 * nothing else. An emulated PC has no such shortcut. What it has is an ethernet
 * card, and what comes out of that card is ethernet frames — ARP, DHCP, DNS,
 * ICMP, and TCP segments carrying whatever the guest thinks it is talking to.
 * Nothing in a browser can put a frame on a wire.
 *
 * So the wire is written in JavaScript. v86 ships the stack for it — its
 * `fetch` backend answers the guest's ARP, hands out a DHCP lease, answers DNS
 * with one address, replies to pings, and terminates the guest's TCP itself —
 * and where a real router would forward the segments, it reassembles the HTTP
 * request inside them and re-sends it with `fetch`. The guest's `wget` believes
 * it opened a socket to `93.184.216.34:80`; what actually happened is a
 * `fetch()` from this tab.
 *
 * That leaves the same question the rest of this build answers in
 * `src/net/cors-proxy.ts`: a host answers a browser only if it says so in its
 * own headers. This module is where the machine's requests join that policy —
 * and joining it is the whole reason an emulated PC can now reach more of the
 * internet than the container can. The container's requests leave from
 * StackBlitz's worker, where the page's patched `fetch` never sees them, so a
 * host that refuses browsers refuses the container and there is nothing the
 * page can do about it. The machine's requests leave from *this* tab, through
 * the page's own `fetch`, so the direct-then-proxy policy applies to every one
 * of them without the guest knowing: `wget http://example.com` works from an
 * emulated Buildroot, and example.com sends no CORS headers at all — measured.
 *
 * Three things this adds to what v86 does on its own, each because the stock
 * backend leaves reach on the table:
 *
 * - **Every port, not only 80.** v86's backend accepts a guest TCP connection
 *   when it is aimed at port 80 and resets everything else, so
 *   `http://host:8080/` — a URL a person types every day — could not be
 *   fetched. A second listener here takes the other ports, sniffs the first
 *   bytes for a request line, and runs the same bridge. What is *not* HTTP is
 *   still refused, and refused promptly: a TLS client that gets a connection
 *   and then silence hangs, and a hang is worse than a refusal.
 * - **Both schemes, in order.** On an HTTPS page v86 rewrites the guest's
 *   `http://` to `https://`, because a browser will not let a secure page fetch
 *   a plaintext one — which is right, and it strands the hosts that answer only
 *   on port 80. Each request here falls back to the other scheme before it
 *   gives up, and the proxy fallback in `cors-proxy.ts` is what makes the
 *   plaintext attempt possible at all from an HTTPS page.
 * - **An error the guest can read.** A failure arrives in the guest as the body
 *   of a 502, which is the one place the model is already looking. Saying
 *   "example.com refused a request from this browser; Settings → Network is
 *   where the proxy that retries those is configured" is worth more there than
 *   a stack trace.
 *
 * And one thing it takes away, which matters more than any of them. The bridge
 * fetches whatever the guest wrote in its `Host` header, and *this tab* makes
 * the request — so the guest inherits the tab's position on the network unless
 * something says otherwise. Measured on the deployed site before this rule
 * existed: a guest asking for the page's own address got the app's HTML back,
 * and `/api` reached the harness running beside it, because a same-origin
 * request needs no CORS at all. {@link MachineNetworkConfig.allowPrivate} is
 * that rule — the page's own origin, loopback, link-local and the RFC1918
 * ranges are refused with an answer that says why, and a deployment that wants
 * them says so deliberately.
 *
 * ## The relay, and why it is not the default
 *
 * HTTP is the ceiling of what a tab can carry on its own. TLS cannot be: the
 * guest would have to complete a handshake with the far end, and the page has
 * no socket to carry one. So `https://` *from inside the guest* — `pacman`,
 * `apk`, `git clone`, `ssh` — needs a relay: a WebSocket server that owns real
 * sockets and forwards bytes. v86 speaks two such protocols, WISP and
 * websockproxy, and a public server for each is offered in Settings → Network.
 * With one configured the guest gets unrestricted TCP: `telnet example.com 443`
 * connects, and DNS becomes real DNS over DoH rather than one made-up address.
 *
 * It is off by default, and the reason is the reason a proxy is a fallback
 * rather than a route in `cors-proxy.ts`: a relay carries *everything* the
 * guest sends, in the clear as far as the relay is concerned, to a third party
 * nobody in this session has audited. The in-page bridge involves no such
 * party — and where it does fall back to the CORS proxy, that is one request at
 * a time, to a proxy the user chose. So the default is the honest one and the
 * relay is a switch beside a plain statement of what it costs.
 */

import { proxiedUrl, proxyConfig } from './cors-proxy.ts'

/** How the machine is wired to the world. */
export interface MachineNetworkConfig {
  /** Whether the guest's card is connected to anything at all. */
  enabled: boolean
  /**
   * The relay, or the empty string for the in-page bridge.
   *
   * A `wisp://` or `wisps://` URL selects v86's WISP client, which carries TCP
   * streams; a `ws://` or `wss://` URL selects its websockproxy client, which
   * carries raw ethernet. Empty means no server is involved and the page
   * answers the guest itself.
   */
  relay: string
  /**
   * Whether the guest may aim at this machine rather than at the internet.
   *
   * Off, and this is the one setting here that exists for safety rather than
   * for reach. The bridge fetches whatever the guest put in its `Host` header,
   * and the fetch is made *by this tab* — so without a rule, a guest could ask
   * for `http://192.168.1.1/`, for the browser's own loopback, for a cloud
   * instance's metadata service, or for this page's own origin, where
   * `src/net/virtual-network.ts` routes `/api` to the harness running beside
   * it. Measured on the deployed site before this rule existed: a guest
   * fetching the page's own address got the app's HTML back, and `/api`
   * reached the in-page server.
   *
   * None of that is the network. The machine was given a route to the
   * *internet*, and a model driving a guest has no business inside the tab that
   * is hosting it or on the network of the person running it, so those targets
   * are refused with an answer that says why. A deployment that genuinely wants
   * it — v86 documents `<port>.external` for reaching a development server on
   * localhost — turns this on and knows what it turned on.
   */
  allowPrivate: boolean
}

/**
 * The relays offered beside the empty default.
 *
 * Both are public servers run by other people, both were reached from this
 * page, and neither is trusted with anything: they are listed so that a user
 * who wants unrestricted TCP has somewhere to start, and every one of them is
 * described as what it is.
 */
export const RELAY_PRESETS: { url: string, label: string, detail: string }[] = [
  {
    url: 'wisps://wisp.mercurywork.shop/',
    label: 'WISP (Mercury Workshop)',
    detail: 'Carries the guest\'s TCP streams, so TLS works end to end and DNS is answered over DoH. '
      + 'Measured from this page: `telnet example.com 443` connects.',
  },
  {
    url: 'wss://relay.widgetry.org/',
    label: 'websockproxy (widgetry.org)',
    detail: 'Carries raw ethernet frames to a real network, which is the fullest emulation there is — '
      + 'the guest gets a lease and a route from the server rather than from this page. It is v86\'s '
      + 'own default relay, and it is shared and rate-limited.',
  },
]

/** Where the choice is kept. Not the virtual filesystem: a machine can boot before that is restored. */
const STORAGE_KEY = 'dsh-web:machine-network'

/** The shipped default: connected, and answered by this page rather than by a server. */
const DEFAULTS: MachineNetworkConfig = { enabled: true, relay: '', allowPrivate: false }

/** The configuration in force, read once and kept. */
let current: MachineNetworkConfig | undefined

/**
 * The machine's network configuration.
 * @returns the stored configuration, or the shipped default.
 */
export function machineNetworkConfig(): MachineNetworkConfig {
  if (current !== undefined) return current
  current = DEFAULTS
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<MachineNetworkConfig>
      current = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        relay: typeof parsed.relay === 'string' ? parsed.relay.trim() : DEFAULTS.relay,
        allowPrivate: typeof parsed.allowPrivate === 'boolean' ? parsed.allowPrivate : DEFAULTS.allowPrivate,
      }
    }
  } catch {
    // Unreadable storage is not worth failing a boot over; the default works.
  }
  return current
}

/**
 * Replace the machine's network configuration.
 *
 * It takes effect on the next boot and says so in the settings page, because
 * the card is constructed with the machine: v86 is told which backend to use
 * when the emulator is created, and a running guest has a driver bound to
 * whatever was there at the time.
 * @param next - the fields to change.
 * @returns the configuration now in force.
 */
export function setMachineNetworkConfig(next: Partial<MachineNetworkConfig>): MachineNetworkConfig {
  const merged: MachineNetworkConfig = {
    enabled: next.enabled ?? machineNetworkConfig().enabled,
    relay: (next.relay ?? machineNetworkConfig().relay).trim(),
    allowPrivate: next.allowPrivate ?? machineNetworkConfig().allowPrivate,
  }
  current = merged
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // The choice still applies to this page; it just will not outlive it.
  }
  return merged
}

/** Whether a string addresses a relay this build can hand to v86. */
export function isRelayUrl(value: string): boolean {
  return /^(?:wisps?|wss?):\/\//i.test(value.trim())
}

/**
 * The `net_device` this guest is constructed with.
 *
 * The card type is the guest's own business and is never guessed here: v86's
 * catalog records which machines want VirtIO — a driver an operating system
 * either has or does not — and everything else gets the NE2000 that every
 * 1990s driver disk knows. Upstream spells that choice `net_device_type` at the
 * top of a profile, which is a key v86's constructor does not read, so it is
 * translated rather than passed through.
 *
 * The backend is this build's business, and it is the same for every machine.
 * @param options - the guest's own constructor options.
 * @returns the `net_device` to construct with, with no relay when the network is off.
 */
export function netDevice(options: Record<string, unknown>): Record<string, unknown> {
  const declared = typeof options.net_device === 'object' && options.net_device !== null
    ? options.net_device as Record<string, unknown>
    : {}
  const type = typeof declared.type === 'string'
    ? declared.type
    : typeof options.net_device_type === 'string' ? options.net_device_type : 'ne2k'
  const config = machineNetworkConfig()
  // Disabled leaves the card in the machine and unplugs the cable: the guest
  // still enumerates its hardware exactly as it did before this feature
  // existed, which is what keeps a saved machine's driver state valid.
  if (!config.enabled) return { ...declared, type }
  const relay = config.relay === '' ? 'fetch' : config.relay
  return {
    ...declared,
    type,
    relay_url: relay,
    // With the in-page bridge, DNS is answered here with one address and the
    // Host header decides where a request really goes, so there is nothing to
    // resolve and nobody to ask. A relay carries real sockets, so it needs real
    // answers, and v86's own default for that backend — DoH to Cloudflare — is
    // what a relay's own users get.
    ...relay === 'fetch' ? { dns_method: 'static' } : {},
  }
}

/** What the machine asked for, as the settings page reports it. */
export interface MachineRequest {
  /** The URL, as it went out. */
  url: string
  /** The status it came back with, when it came back. */
  status?: number
  /** Why it did not, when it did not. */
  error?: string
}

/** How many requests are remembered. Enough to explain a failure, not a log. */
const HISTORY = 40

/** The machine's recent requests, newest last. */
const history: MachineRequest[] = []

/** Ports the guest opened that this page could not carry, newest last. */
const refused = new Set<number>()

/**
 * What the machine has reached, and what it could not.
 *
 * The settings page reads this for the same reason it reads
 * `proxiedOrigins()`: a network that silently does nothing is the worst thing
 * for a person to debug, and the honest answer to "is the machine online" is
 * the list of what it asked for.
 * @returns the recent requests and the ports that needed a relay.
 */
export function machineTraffic(): { requests: MachineRequest[], refusedPorts: number[] } {
  return { requests: [...history], refusedPorts: [...refused].sort((a, b) => a - b) }
}

/** Remember one request. */
function record(entry: MachineRequest): void {
  history.push(entry)
  if (history.length > HISTORY) history.shift()
}

/**
 * The other scheme to try when a URL fails.
 *
 * Both directions are needed and for opposite reasons. A page served over
 * HTTPS cannot fetch `http://` at all — the browser blocks it before a request
 * exists — so v86 rewrites the guest's plaintext URL to HTTPS, and a host that
 * has no TLS at all is then unreachable; retrying the plaintext URL gets it
 * back, because the CORS proxy fetches it from somewhere that is not a secure
 * context. In the other direction a guest that asked for port 8080 in the clear
 * may be talking to something that only answers TLS.
 * @param url - the URL that failed.
 * @returns the same URL under the other scheme, or undefined when there is none.
 */
function otherScheme(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') {
      parsed.protocol = 'http:'
      return parsed.href
    }
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      return parsed.href
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * How long a request may take to produce headers.
 *
 * Only the headers. A body is not bounded here and must not be: a guest
 * downloading a hundred megabytes through an emulated NE2000 is a request that
 * takes minutes by design, and a deadline on the whole response would cut it
 * off. What this bounds is the case v86 has no answer for — a host that accepts
 * nothing and says nothing, where the browser's own connect timeout is minutes
 * away and the guest's `wget` sits there for all of them. After this, the guest
 * gets a 502 that says so.
 */
const HEADERS_MS = 30_000

/**
 * Hostnames and addresses that are not "the internet".
 *
 * Matched on the hostname as the guest wrote it, before any DNS happens,
 * because there is no DNS to consult: `fetch` resolves the name inside the
 * browser and never tells the page what it resolved to. That is a real limit
 * and it is worth stating rather than papering over — a name that resolves to a
 * private address gets through this, and only the far end's own CORS policy
 * stops it. What this does stop is the direct, obvious and measured cases: the
 * loopback, the link-local metadata address, the RFC1918 ranges a home network
 * lives on, and the names v86 maps to a developer's own machine.
 */
const PRIVATE_HOST = new RegExp([
  '^localhost$',
  '^127\\.',
  '^0\\.0\\.0\\.0$',
  '^10\\.',
  '^192\\.168\\.',
  '^172\\.(?:1[6-9]|2\\d|3[01])\\.',
  '^169\\.254\\.',
  '^\\[?::1\\]?$',
  '^\\[?f[cde][0-9a-f]{2}:',
  '\\.local$',
  '\\.internal$',
  '^\\d+\\.external$',
].join('|'), 'i')

/**
 * Whether the page will fetch this on the guest's behalf.
 *
 * Three refusals, and the third is the one that is easy to miss. A scheme that
 * is not HTTP cannot be a `fetch`. A private or loopback host is the machine
 * the page is running on, or the network it is running on, neither of which is
 * what "give the guest the internet" meant. And this page's own origin is the
 * harness itself: a same-origin request needs no CORS at all, so without this
 * the guest would have an unauthenticated line into `/api` and into every route
 * a plugin serves — measured on the deployed site, where a guest asking for the
 * page's own address got the app's HTML back.
 * @param url - the target the guest asked for.
 * @returns why it is refused, or undefined when it may go.
 */
function refuseTarget(url: string): string | undefined {
  if (machineNetworkConfig().allowPrivate) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${url} is not a URL this page can fetch.`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${parsed.protocol} is not something a browser tab can carry; only http and https are.`
  }
  if (typeof location !== 'undefined' && parsed.host === location.host) {
    return `${parsed.host} is the page hosting this machine, not the internet. `
      + 'A request there would reach the harness\'s own API with no authentication in front of it, so the '
      + 'machine is not given that route. Settings → Network can allow it if a deployment actually wants it.'
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    return `${parsed.hostname} is on the network of the computer running this browser, not on the internet. `
      + 'The machine is given a route out, not a route in. Settings → Network can allow it.'
  }
  return undefined
}

/** A rejection, in one line, for a terminal. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * What to tell the guest when nothing worked.
 *
 * This text is delivered as the body of a 502 to whatever the guest ran, so it
 * is read by a person at a terminal and by a model reading the tool result.
 * Both need the same two facts: the failure is a policy, not a bug in the
 * command, and there is a setting that changes the policy.
 * @param url - what was asked for.
 * @param error - the last failure.
 * @returns the message.
 */
function advice(url: string, error: unknown): string {
  const { enabled, template } = proxyConfig()
  const reason = describe(error)
  const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
  const tail = timedOut
    // A timeout is not a CORS refusal and must not be dressed as one: the page
    // never got far enough to be refused, and no proxy retry was made, so
    // advice about proxies would send the reader somewhere there is nothing to
    // find.
    ? 'Nothing answered, which is what an address that is not listening looks like from here — '
      + 'not a policy this page can change.'
    : enabled
      // Resolved rather than printed with its braces in: this text is read at a
      // terminal, and `{url}` in the middle of a URL is the kind of detail a
      // reader spends a minute on. `src/host/jsh-tool.ts` resolves it the same
      // way and for the same reason.
      ? `A refused request is retried once through ${proxiedUrl(url, template) ?? template}; that failed too. `
        + 'A host that refuses both is unreachable from a browser — try another, or point Settings → Network '
        + 'at a proxy of your own.'
      : 'This session has no CORS proxy configured, so a refused request is not retried. '
        + 'Settings → Network is where one is turned on.'
  return `${url} could not be fetched from this browser (${reason}). `
    + `The machine's network is this tab's network, so a host answers only if it sends CORS headers. ${tail}`
}

/**
 * Fetch one URL on the guest's behalf, through the page's own policy.
 *
 * The page's `fetch` is already patched with the CORS policy, so the direct
 * attempt and the proxied retry both happen inside the call — what this adds is
 * the second scheme and the guest-readable failure.
 * @param url - the URL v86 reassembled from the guest's request.
 * @param init - the method, headers and body it carried.
 * @returns the response, for v86 to write back down the connection.
 */
async function guestFetch(url: string, init: RequestInit): Promise<Response> {
  // Before anything leaves. A refusal is recorded like any other outcome, so
  // the settings page shows what the machine tried rather than only what it
  // managed — a model probing an address it will never be given should be
  // visible to the person whose browser it is probing from.
  const refusal = refuseTarget(url)
  if (refusal !== undefined) {
    record({ url, error: refusal })
    const refused = new Error(refusal)
    refused.stack = refused.message
    throw refused
  }
  const attempts = [url]
  const alternate = otherScheme(url)
  if (alternate !== undefined) attempts.push(alternate)
  let last: unknown
  for (const attempt of attempts) {
    // Aborted only while the headers are outstanding: the timer is cleared the
    // moment a response exists, so a slow body streams for as long as it takes.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`no answer within ${String(HEADERS_MS / 1000)}s`, 'TimeoutError'))
    }, HEADERS_MS)
    try {
      // Credentials are omitted for the same reason the CORS proxy omits them:
      // whatever authorizes a guest's request travels in a header the guest
      // set, and this tab's cookies are nobody's business but this tab's.
      const response = await fetch(attempt, {
        ...init, credentials: 'omit', redirect: 'follow', signal: controller.signal,
      })
      clearTimeout(timer)
      record({ url: attempt, status: response.status })
      return response
    } catch (error) {
      clearTimeout(timer)
      last = error
      record({ url: attempt, error: describe(error) })
      // A host that never answered is a host that is not there, and asking the
      // same silence under the other scheme costs the guest another half minute
      // to learn the same thing.
      if (error instanceof DOMException && error.name === 'TimeoutError') break
    }
  }
  const failure = new Error(advice(url, last))
  // v86 writes `e.stack` into the 502 it hands the guest when there is one, and
  // a JavaScript stack trace in a guest's terminal buries the sentence that
  // says what to do. The message is the whole of what belongs there.
  failure.stack = failure.message
  throw failure
}

/**
 * One TCP connection the guest opened, as v86 hands it over.
 *
 * v86's own port-80 handler is given the same object; this is the part of its
 * surface a second listener needs.
 */
interface GuestConnection {
  /** The port the guest aimed at. */
  sport: number
  /** The port it came from. */
  dport: number
  /** Take the connection, completing the handshake. */
  accept(): void
  /** Watch for payload bytes. */
  on(event: 'data', handler: (data: Uint8Array | ArrayBuffer) => void): void
  /** Send bytes back. */
  write(data: Uint8Array): void
  /** Close it. */
  close(): void
}

/** The emulator surface this module touches. */
export interface NetworkedEmulator {
  add_listener(event: string, listener: (argument: never) => void): void
  network_adapter?: { fetch?(url: string, init: RequestInit): Promise<Response> }
}

/**
 * Ports whose first bytes are never an HTTP request.
 *
 * Refused rather than sniffed, because sniffing costs the guest a completed
 * handshake and then a close, and for a TLS client that is a connection that
 * came up and died instead of one that was refused — a difference `curl`
 * reports as "connection reset" rather than "connection refused", and the
 * second is the one that tells the truth about what is here.
 */
const NEVER_HTTP = new Set([20, 21, 22, 23, 25, 110, 143, 443, 465, 587, 636, 989, 990, 993, 995, 6697])

/** How long a connection may stay silent — with nothing arriving — before it is dropped. */
const IDLE_MS = 30_000

/** The most a request head may be before it is refused, so a stuck guest cannot grow the heap. */
const MAX_HEAD = 64 * 1024

/**
 * The most of a request body this bridge will hold.
 *
 * `fetch` needs the whole body before it can send it, so an upload is buffered
 * in the page — which makes an unbounded `Content-Length` an unbounded
 * allocation asked for by whatever is running on the guest. Thirty-two
 * megabytes is far beyond anything these machines upload and far below what a
 * tab should be asked to hold.
 */
const MAX_BODY = 32 * 1024 * 1024

/** A request line, as HTTP defines it and as a sniff can recognise it. */
const REQUEST_LINE = /^[A-Z]{3,10} \S+ HTTP\/1\.[01]$/

/** Headers a browser owns and a guest must not dictate. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding',
])

/** Response headers that describe a wire this reply did not travel on. */
const STRIPPED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'keep-alive', 'connection'])

/** Find the blank line that ends a request head. */
function headEnd(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 0x0D && buffer[i + 1] === 0x0A && buffer[i + 2] === 0x0D && buffer[i + 3] === 0x0A) return i
  }
  return -1
}

/**
 * Frame a status line and headers as HTTP/1.1 expects them.
 * @param status - the status code.
 * @param statusText - its reason phrase.
 * @param headers - the headers, joined the way `Headers` joins them.
 * @param extra - lines that must not go through `Headers`, already formatted.
 * @returns the encoded head.
 */
function responseHead(status: number, statusText: string, headers: Headers, extra: string[] = []): Uint8Array {
  const lines = [`HTTP/1.1 ${String(status)} ${statusText}`]
  headers.forEach((value, name) => { lines.push(`${name}: ${value}`) })
  lines.push(...extra)
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`)
}

/** Answer a connection with one short message and close it. */
function answerText(conn: GuestConnection, status: number, statusText: string, body: string): void {
  const bytes = new TextEncoder().encode(body)
  const headers = new Headers({
    'content-type': 'text/plain',
    'content-length': String(bytes.length),
    connection: 'close',
  })
  conn.write(responseHead(status, statusText, headers))
  conn.write(bytes)
  conn.close()
}

/**
 * Send a response back down the guest's connection, as it arrives.
 *
 * Streamed rather than buffered, because the guest is a machine with tens of
 * megabytes of RAM reading through a card that manages tens of kilobytes a
 * second: holding a download whole in the page first would delay every byte
 * until the last one arrived, and a large one would be held twice.
 * @param conn - the guest's connection.
 * @param response - what the network answered.
 */
async function relayResponse(conn: GuestConnection, response: Response, started: () => void): Promise<void> {
  const headers = new Headers()
  response.headers.forEach((value, name) => {
    if (!STRIPPED.has(name.toLowerCase())) headers.append(name, value)
  })
  // The guest is told the connection ends with the body, which is how it knows
  // the body ended: `content-length` cannot be forwarded, because the browser
  // has already decompressed whatever the header counted.
  headers.set('connection', 'close')
  // `Headers.forEach` joins repeated fields with a comma, which is right for
  // every header except the one that must never be joined: two `set-cookie`
  // lines folded into one are two cookies the guest cannot read. `getSetCookie`
  // is the accessor that keeps them apart, where the browser has it and where
  // the response exposes them at all — a cross-origin response usually does not.
  const cookies = response.headers.getSetCookie?.() ?? []
  const lines = [...cookies.map(value => `set-cookie: ${value}`)]
  conn.write(responseHead(response.status, response.statusText, headers, lines))
  started()
  const body = response.body
  if (body === null) {
    conn.close()
    return
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value !== undefined) conn.write(value)
      if (done) break
    }
  } finally {
    conn.close()
  }
}

/**
 * Serve one guest connection that v86's own backend would have reset.
 *
 * Everything here is what v86's port-80 handler does, minus the parts that only
 * make sense for port 80 and plus the part that makes another port work at all:
 * the port the guest aimed at is put back into the URL when its `Host` header
 * did not carry one.
 * @param conn - the connection.
 */
function serve(conn: GuestConnection): void {
  // Accumulated as chunks and joined once. Re-concatenating the whole buffer per
  // segment is quadratic, and the guests that upload anything do it through an
  // emulated card that delivers a great many small segments.
  let chunks: Uint8Array[] = []
  let size = 0
  let pending: { need: number, deliver: (body: Uint8Array) => void } | undefined
  let done = false
  // Once the head of a response has gone out, the connection is committed: a
  // failure after that cannot be turned into a 502, because the guest is
  // already reading a 200.
  let answered = false

  let timer: ReturnType<typeof setTimeout>
  const finish = (): void => {
    done = true
    clearTimeout(timer)
  }
  // Idle, not total. A deadline from the moment of accept would close a slow
  // upload mid-transfer with no answer at all — at the tens of kilobytes a
  // second an NE2000 manages, that is an ordinary POST, not an attack — so the
  // clock restarts every time the guest says something.
  const idle = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (done) return
      finish()
      conn.close()
    }, IDLE_MS)
  }
  idle()

  const collected = (): Uint8Array => {
    if (chunks.length === 1) return chunks[0]
    const joined = new Uint8Array(size)
    let at = 0
    for (const part of chunks) {
      joined.set(part, at)
      at += part.length
    }
    return joined
  }

  conn.on('data', (data) => {
    if (done) return
    idle()
    const view = data instanceof Uint8Array ? data : new Uint8Array(data)
    // Copied out of whatever v86 handed over: the emulator's memory is a
    // `SharedArrayBuffer` on a cross-origin-isolated page, and `TextDecoder`
    // refuses a view onto shared memory.
    const chunk = new Uint8Array(view)
    chunks.push(chunk)
    size += chunk.length

    if (pending !== undefined) {
      if (size < pending.need) return
      const body = collected()
      const deliver = pending.deliver
      pending = undefined
      chunks = []
      size = 0
      deliver(body)
      return
    }

    const buffer = collected()
    chunks = [buffer]
    size = buffer.length
    const separator = headEnd(buffer)
    if (separator === -1) {
      // A first chunk that cannot be the start of a request line is not a
      // client this page can answer — a TLS `ClientHello` starts `0x16 0x03`.
      // It is told so immediately rather than left waiting for a reply that is
      // never coming.
      if (buffer.length >= 16 && !/^[A-Z]{3,10} /.test(new TextDecoder().decode(buffer.subarray(0, 16)))) {
        refused.add(conn.sport)
        finish()
        conn.close()
        return
      }
      if (buffer.length > MAX_HEAD) {
        finish()
        answerText(conn, 431, 'Request Header Fields Too Large', 'The request head was too large for this bridge.\n')
      }
      return
    }
    const head = new TextDecoder().decode(buffer.subarray(0, separator))
    let body: Uint8Array = buffer.subarray(separator + 4)
    chunks = []
    size = 0

    const lines = head.split('\r\n')
    const first = lines[0] ?? ''
    if (!REQUEST_LINE.test(first)) {
      refused.add(conn.sport)
      finish()
      conn.close()
      return
    }
    const [method, path] = first.split(' ')

    const headers = new Headers()
    let host: string | undefined
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':')
      if (at <= 0) continue
      const name = line.slice(0, at).trim().toLowerCase()
      const value = line.slice(at + 1).trim()
      if (name === 'host') host = value
      if (HOP_BY_HOP.has(name) || !/^[\w-]+$/.test(name) || !/^[\x20-\x7E]*$/.test(value)) continue
      try {
        headers.append(name, value)
      } catch {
        // A header the platform will not carry is dropped rather than fatal;
        // the request is still the request the guest made.
      }
    }

    let target: URL
    try {
      // Parsed against a placeholder authority and then overridden, which is
      // what v86's own handler does — and it is not a stylistic choice. Building
      // `http://` + `''` + `/index.html` gives `http:///index.html`, which the
      // URL parser reads as the host `index.html` with an empty path: a request
      // with no Host header would have been sent to a hostname invented from its
      // own path, silently, instead of being refused.
      target = /^https?:/i.test(path) ? new URL(path) : new URL(`http://request.invalid${path}`)
      if (!/^https?:/i.test(path)) {
        if (host === undefined) {
          finish()
          answerText(conn, 400, 'Bad Request',
            'The request carried no Host header, so there is nothing to fetch: this machine\'s DNS answers '
            + 'every name with the same address, and the name in the Host header is the only thing that says '
            + 'where a request really goes.\n')
          return
        }
        target.host = host
      }
    } catch {
      finish()
      answerText(conn, 400, 'Bad Request', `This bridge could not read a URL out of "${first}".\n`)
      return
    }
    // The guest aimed at a port and its Host header need not repeat it. Ports 80
    // and 443 never reach here — the first belongs to v86's own handler and the
    // second is refused as a TLS port — so whatever this connection came in on
    // is the port the request belongs to.
    if (target.port === '') target.port = String(conn.sport)

    const dispatch = (payload: Uint8Array | undefined): void => {
      finish()
      const init: RequestInit = {
        method,
        headers,
        ...payload === undefined || payload.length === 0 ? {} : { body: payload as BodyInit },
      }
      void guestFetch(target.href, init)
        .then(async response => relayResponse(conn, response, () => { answered = true }))
        .catch((error: unknown) => {
          // Only while there is still a status line to write. A stream that
          // fails halfway through a download has already sent a 200, and
          // appending a 502 to a body the guest is reading would corrupt it.
          if (answered) {
            conn.close()
            return
          }
          answerText(conn, 502, 'Fetch Error', `${describe(error)}\n`)
        })
    }

    // A body belongs only to a method that carries one. Bytes after the head of
    // a GET are a pipelined second request or a stray CRLF, and handing them to
    // `fetch` as a body makes it throw — turning a request that would have
    // worked into a 502.
    const length = Number.parseInt(head.match(/\r\ncontent-length:\s*(\d+)/i)?.[1] ?? '0', 10)
    const carries = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && length > 0
    if (!carries) {
      dispatch(undefined)
      return
    }
    if (length > MAX_BODY) {
      finish()
      answerText(conn, 413, 'Payload Too Large',
        `This bridge buffers a request body in the page before sending it, and ${String(length)} bytes is `
        + `beyond the ${String(MAX_BODY / (1024 * 1024))} MB it will hold.\n`)
      return
    }
    if (body.length < length) {
      chunks = [body]
      size = body.length
      pending = { need: length, deliver: whole => { dispatch(whole.subarray(0, length)) } }
      return
    }
    dispatch(body.subarray(0, length))
  })

  conn.accept()
}

/**
 * Wire a freshly constructed emulator to the page's network.
 *
 * Two attachments, and they happen at different times on purpose. The bus
 * exists as soon as the emulator does, so the extra-port listener is registered
 * immediately and cannot miss a connection. The network adapter is built inside
 * v86's own asynchronous start-up — after the WebAssembly is instantiated — so
 * the request bridge is installed when it appears, and a machine that starts
 * without one (a relay, or a network turned off) simply never gets one.
 * @param emulator - the machine, as v86 just constructed it.
 */
export function attachMachineNetwork(emulator: NetworkedEmulator): void {
  const config = machineNetworkConfig()
  if (!config.enabled) return

  // Only the in-page bridge has ports this page answers for. A relay owns real
  // sockets, and a listener here would steal connections it can carry properly.
  if (config.relay === '') {
    emulator.add_listener('tcp-connection', ((conn: GuestConnection) => {
      // Port 80 is v86's own, and it is left there: it is the well-trodden path
      // and it already does the mixed-content rewrite this page needs.
      if (conn.sport === 80) return
      if (NEVER_HTTP.has(conn.sport)) {
        refused.add(conn.sport)
        return
      }
      serve(conn)
    }) as (argument: never) => void)
  }

  // Only the in-page bridge has a request to wrap. A relay's adapter never
  // fetches anything — it owns a socket — so polling for a property it does not
  // have would be thirty seconds of timers proving nothing.
  if (config.relay !== '') return

  let tries = 0
  const install = (): void => {
    const adapter = emulator.network_adapter
    if (adapter !== undefined && typeof adapter.fetch === 'function') {
      adapter.fetch = async (url, init) => guestFetch(url, init)
      return
    }
    // Bounded, because a build with no adapter at all must not leave a timer
    // running for the life of the page. Thirty seconds is far longer than the
    // WebAssembly instantiation it is waiting behind.
    if (++tries > 600) return
    setTimeout(install, 50)
  }
  install()
}

/**
 * Ask whether a relay answers, for the settings page.
 *
 * A WebSocket that opens is the whole test: both protocols v86 speaks start
 * with one, and a server that refuses the handshake — because it is gone, or
 * rate-limiting, or not a relay — refuses it here in the same way. What happens
 * after the handshake is the guest's conversation, and nothing this page sends
 * would tell it anything a guest has not already told it.
 * @param url - the relay URL to try.
 * @returns what happened, in one sentence.
 */
export async function testRelay(url: string): Promise<{ ok: boolean, detail: string }> {
  const trimmed = url.trim()
  if (trimmed === '') return { ok: true, detail: 'No relay: the page answers the machine itself, over HTTP.' }
  if (!isRelayUrl(trimmed)) {
    return { ok: false, detail: 'A relay is a wisp://, wisps://, ws:// or wss:// URL.' }
  }
  const socketUrl = trimmed.replace(/^wisp:\/\//i, 'ws://').replace(/^wisps:\/\//i, 'wss://')
  return new Promise(resolve => {
    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl)
    } catch (error) {
      resolve({ ok: false, detail: `That URL could not be opened: ${describe(error)}` })
      return
    }
    const timer = setTimeout(() => {
      socket.close()
      resolve({ ok: false, detail: 'The relay did not answer within 10 seconds.' })
    }, 10_000)
    socket.onopen = () => {
      clearTimeout(timer)
      socket.close()
      resolve({ ok: true, detail: `${socketUrl} accepted a connection. Restart the machine to use it.` })
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve({
        ok: false,
        detail: 'The relay refused the connection. A public one may be down or rate-limiting; '
          + 'the browser is not told which.',
      })
    }
  })
}
