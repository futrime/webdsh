/**
 * The browser machine's profile: its cookies and its per-site storage.
 *
 * A real browser keeps one of these per user, and everything that makes
 * browsing feel continuous lives in it — you are still logged in tomorrow,
 * the site still remembers which theme you picked, the tab you opened
 * inherits the cookies the last one set. The Browser machine has one too, and
 * it is a *separate* one: nothing here is the page's own storage, and nothing
 * a browsed site writes can be read by the harness or by another profile.
 *
 * That separation is not politeness, it is the whole reason this module
 * exists. A browsed page runs in a frame with an opaque origin (see
 * `src/browser/engine.ts`), and an opaque origin is one where `localStorage`,
 * `sessionStorage`, `document.cookie` and `indexedDB` all throw `SecurityError`
 * rather than working — measured, in the browser this build targets, not
 * assumed. So the site cannot reach the browser's real storage even by
 * accident. What it gets instead is this: jars the page owns, keyed by the
 * site's own origin, handed to the frame over a message port and written back
 * here.
 *
 * The consequence is worth stating plainly, because it cuts both ways. A site
 * cannot see the harness's keys, sessions or files, and it cannot see what any
 * other site stored. It also cannot see what that site stored in *your real
 * browser* — the profile starts empty, so you are not logged into anything
 * here that you are logged into in the browser around it.
 *
 * ## Cookies, and the leg they do not travel
 *
 * The cookie jar below models domains, paths, expiry, `secure` and `samesite`
 * the way RFC 6265 describes, because a site's own scripts read and write
 * `document.cookie` and expect those rules to hold. What it does *not* do is
 * put a `Cookie` header on a request, and that is not an omission: `Cookie` is
 * a forbidden header name, so a page's `fetch` cannot set one, and a
 * cross-origin response's `set-cookie` is not among the headers CORS exposes,
 * so one cannot be read back either. Both directions are closed by the
 * browser, to every page, and this build does not pretend otherwise.
 *
 * So cookies here are the ones JavaScript sets and reads, and they persist and
 * partition exactly as a browser's would. Cookies as an *authentication*
 * mechanism — the server setting one and seeing it again — do not survive the
 * network leg, and `src/host/browser-tools.ts` says so where the model can
 * read it rather than leaving it to be discovered one failed login at a time.
 */

/** One stored cookie, as the jar holds it. */
export interface Cookie {
  name: string
  value: string
  /** The host it belongs to, without a leading dot. */
  domain: string
  /** Whether it applies to subdomains, which is what a leading dot meant. */
  subdomains: boolean
  path: string
  /** Epoch milliseconds, or undefined for a session cookie. */
  expires?: number
  secure: boolean
  sameSite: 'strict' | 'lax' | 'none'
  /**
   * Whether script may see it.
   *
   * Always false for a cookie set through `document.cookie`, and settable only
   * by {@link CookieJar.storeFromResponse}. Kept because a site that reads its
   * own cookie back and finds one it marked `httponly` would be reading
   * something a real browser hides.
   */
  httpOnly: boolean
}

/** What a profile holds between loads. */
interface ProfileSnapshot {
  cookies: Cookie[]
  /** Per-origin `localStorage`, as plain objects. */
  local: Record<string, Record<string, string>>
}

/** The IndexedDB database the profile is kept in. */
const DB_NAME = 'dsh-web-browser'

/** Its one object store. */
const STORE = 'profiles'

/** How long a write waits for another before it goes to disk. */
const FLUSH_DELAY_MS = 400

/**
 * Promote an IndexedDB request to a promise.
 * @param req - the request.
 * @returns its result.
 */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('indexedDB request failed')) }
  })
}

/**
 * Open the profile database, or report that there is none.
 *
 * Storage can be denied outright — a private window, a hardened profile, a
 * third-party context. That is not a boot failure: the machine still runs, and
 * what is lost is only that the profile is forgotten when the tab closes,
 * which is what a private window does anyway.
 * @returns the database, or undefined when storage is unavailable.
 */
async function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  try {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE)
    }
    return await request(open)
  } catch {
    return undefined
  }
}

/**
 * Whether a host is within a cookie's domain.
 *
 * The RFC's domain-match: equal, or a suffix preceded by a dot, and never a
 * suffix that would let `evil.com` set a cookie for `com`.
 * @param host - the host being asked about.
 * @param cookie - the cookie.
 * @returns whether it applies.
 */
function domainMatches(host: string, cookie: Cookie): boolean {
  if (host === cookie.domain) return true
  if (!cookie.subdomains) return false
  return host.endsWith(`.${cookie.domain}`)
}

/**
 * Whether a request path is within a cookie's path.
 * @param path - the request's path.
 * @param cookiePath - the cookie's path.
 * @returns whether it applies.
 */
function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true
  if (!path.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/'
}

/**
 * The default path for a cookie set without one, as the RFC computes it.
 * @param path - the setting document's path.
 * @returns the directory it sits in.
 */
function defaultPath(path: string): string {
  if (!path.startsWith('/')) return '/'
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** A jar of cookies, partitioned by nothing because the whole profile is the partition. */
export class CookieJar {
  #cookies: Cookie[] = []
  readonly #changed: () => void

  /**
   * @param changed - called whenever the jar's contents change, to schedule a write.
   */
  constructor(changed: () => void) {
    this.#changed = changed
  }

  /** Everything in the jar, for the tool that lists it and for persistence. */
  all(): Cookie[] {
    this.#expire()
    return this.#cookies.map((cookie) => ({ ...cookie }))
  }

  /**
   * Replace the whole jar, as a restore does.
   * @param cookies - the cookies to hold.
   */
  load(cookies: Cookie[]): void {
    this.#cookies = cookies.map((cookie) => ({ ...cookie }))
    this.#expire()
  }

  /** Drop everything that has expired, which is checked on every read. */
  #expire(): void {
    const now = Date.now()
    const before = this.#cookies.length
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now)
    if (this.#cookies.length !== before) this.#changed()
  }

  /**
   * The `document.cookie` string a page at this URL would read.
   *
   * `httpOnly` cookies are withheld, longest path first, which is the order
   * the RFC asks for and the order sites depend on when two cookies share a
   * name.
   * @param url - the page's URL.
   * @returns the `name=value; name=value` string.
   */
  header(url: URL): string {
    this.#expire()
    const secure = url.protocol === 'https:'
    return this.#cookies
      .filter((cookie) => !cookie.httpOnly
        && domainMatches(url.hostname, cookie)
        && pathMatches(url.pathname, cookie.path)
        && (!cookie.secure || secure))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  /**
   * Apply one `Set-Cookie`-shaped string, as `document.cookie = ...` does.
   *
   * A cookie that names a domain the setting page has no business setting is
   * dropped rather than stored: that is the rule a browser enforces, and a jar
   * that skipped it would let one browsed site write another's cookies.
   * @param url - the URL of the document doing the setting.
   * @param header - the cookie string.
   * @param httpOnly - whether to mark it unreadable by script.
   * @returns whether it was accepted.
   */
  set(url: URL, header: string, httpOnly = false): boolean {
    const parts = header.split(';')
    const first = parts[0] ?? ''
    const eq = first.indexOf('=')
    if (eq < 0) return false
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (name === '') return false

    const cookie: Cookie = {
      name,
      value,
      domain: url.hostname,
      subdomains: false,
      path: defaultPath(url.pathname),
      secure: false,
      sameSite: 'lax',
      httpOnly,
    }
    let removeNow = false

    for (const attribute of parts.slice(1)) {
      const split = attribute.indexOf('=')
      const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase()
      const raw = split < 0 ? '' : attribute.slice(split + 1).trim()
      if (key === 'domain' && raw !== '') {
        const domain = raw.replace(/^\./, '').toLowerCase()
        // A page may widen a cookie to its own registrable parent and no
        // further. Checking "is a suffix of my host" is what a browser does
        // short of a public-suffix list, which a page cannot carry.
        if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return false
        cookie.domain = domain
        cookie.subdomains = true
      } else if (key === 'path' && raw.startsWith('/')) cookie.path = raw
      else if (key === 'secure') cookie.secure = true
      else if (key === 'httponly') cookie.httpOnly = true
      else if (key === 'samesite') {
        const mode = raw.toLowerCase()
        if (mode === 'strict' || mode === 'lax' || mode === 'none') cookie.sameSite = mode
      } else if (key === 'max-age' && raw !== '') {
        const seconds = Number(raw)
        if (Number.isFinite(seconds)) {
          if (seconds <= 0) removeNow = true
          else cookie.expires = Date.now() + seconds * 1000
        }
      } else if (key === 'expires' && raw !== '' && cookie.expires === undefined) {
        const when = Date.parse(raw)
        if (Number.isFinite(when)) {
          if (when <= Date.now()) removeNow = true
          else cookie.expires = when
        }
      }
    }

    // Identity is (name, domain, path), so a re-set replaces rather than
    // accumulates — otherwise a site that writes its session cookie on every
    // page load grows the jar without bound.
    this.#cookies = this.#cookies.filter((held) => !(held.name === cookie.name
      && held.domain === cookie.domain
      && held.path === cookie.path))
    if (!removeNow) this.#cookies.push(cookie)
    this.#changed()
    return true
  }

  /**
   * Take cookies from a response's `set-cookie`, where one is visible.
   *
   * Same-origin responses expose it and cross-origin ones do not, so in
   * practice this fires for the page's own origin and nothing else. It is here
   * because the case exists, not because it is the common one.
   * @param url - the request's URL.
   * @param headers - the response's headers.
   */
  storeFromResponse(url: URL, headers: Headers): void {
    // `getSetCookie` is the only way to read more than one; a browser without
    // it reports the folded value, which is wrong for dates but better than
    // dropping every cookie after the first.
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie') ?? ''])
    for (const value of values) this.set(url, value, true)
  }

  /**
   * Forget cookies, all of them or one site's.
   * @param host - the host to clear, or undefined for the whole jar.
   * @returns how many were removed.
   */
  clear(host?: string): number {
    const before = this.#cookies.length
    this.#cookies = host === undefined
      ? []
      : this.#cookies.filter((cookie) => !domainMatches(host, cookie))
    this.#changed()
    return before - this.#cookies.length
  }
}

/**
 * The profile: one cookie jar, one `localStorage` per origin, and the disk.
 *
 * `sessionStorage` is deliberately not here. It is per-tab by definition and
 * dies with the tab, so the tab holds it (see `src/browser/engine.ts`) and
 * nothing writes it down — which is what the name has always meant.
 */
export class BrowserProfile {
  readonly cookies: CookieJar
  #local = new Map<string, Map<string, string>>()
  #db: IDBDatabase | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #pending = false

  constructor() {
    this.cookies = new CookieJar(() => { this.#schedule() })
  }

  /**
   * Read the profile back from storage.
   *
   * Called once, before the first tab opens. A failure here is not fatal: an
   * empty profile is a new one, which is a browser that has never been used.
   */
  async open(): Promise<void> {
    this.#db = await openDb()
    if (this.#db === undefined) return
    try {
      const transaction = this.#db.transaction(STORE, 'readonly')
      const stored = await request<ProfileSnapshot | undefined>(
        transaction.objectStore(STORE).get('default') as IDBRequest<ProfileSnapshot | undefined>,
      )
      if (stored === undefined) return
      this.cookies.load(stored.cookies ?? [])
      for (const [origin, entries] of Object.entries(stored.local ?? {})) {
        this.#local.set(origin, new Map(Object.entries(entries)))
      }
    } catch {
      // A corrupt or half-written snapshot reads as no profile rather than as
      // a boot failure; the next write replaces it.
    }
  }

  /**
   * One origin's `localStorage`, created empty the first time it is asked for.
   * @param origin - the site's origin.
   * @returns its store.
   */
  localStore(origin: string): Map<string, string> {
    const existing = this.#local.get(origin)
    if (existing !== undefined) return existing
    const created = new Map<string, string>()
    this.#local.set(origin, created)
    return created
  }

  /** Every origin that has stored something, for the tool that reports them. */
  storedOrigins(): string[] {
    return [...this.#local.entries()].filter(([, store]) => store.size > 0).map(([origin]) => origin)
  }

  /**
   * Forget one origin's storage, or every origin's.
   * @param origin - the origin to clear, or undefined for all of them.
   * @returns how many keys went.
   */
  clearStorage(origin?: string): number {
    let removed = 0
    for (const [key, store] of this.#local) {
      if (origin !== undefined && key !== origin) continue
      removed += store.size
      store.clear()
    }
    this.#schedule()
    return removed
  }

  /** Note that something changed and a write is owed. */
  #schedule(): void {
    this.#pending = true
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, FLUSH_DELAY_MS)
  }

  /**
   * Write the profile out now.
   *
   * Debounced by {@link BrowserProfile.localStore} callers rather than called
   * per key: a page that writes `localStorage` in a loop is common, and one
   * IndexedDB transaction per key would be slower than the page.
   */
  async flush(): Promise<void> {
    if (this.#db === undefined || !this.#pending) return
    this.#pending = false
    const snapshot: ProfileSnapshot = {
      cookies: this.cookies.all(),
      local: Object.fromEntries(
        [...this.#local.entries()]
          .filter(([, store]) => store.size > 0)
          .map(([origin, store]) => [origin, Object.fromEntries(store)]),
      ),
    }
    try {
      const transaction = this.#db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(snapshot, 'default')
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => { resolve() }
        transaction.onerror = () => { reject(transaction.error ?? new Error('write failed')) }
      })
    } catch {
      // Quota, or a database closed under us. The profile stays correct in
      // memory for this session, which is the part the page is using.
    }
  }

  /** Note a storage write, so it reaches disk. */
  touch(): void {
    this.#schedule()
  }
}
