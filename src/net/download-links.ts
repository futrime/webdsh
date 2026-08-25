/**
 * Make a download link work when the file only exists inside the page.
 *
 * A plugin here can register HTTP routes on `ctx.webServer`, and one of them is
 * the session export: `dsh-session-log-export` checks `/api/session.export`
 * with `fetch`, then hands the same URL to an `<a download>` and lets the
 * browser go and get it. On a machine with a Node host behind it that is a
 * request to a real server and it works. Here it is a request to a route that
 * exists nowhere but in this tab, and the browser is the one party that cannot
 * see it — measured, not assumed:
 *
 * - `fetch('/api/session.export?…')` answers `200 application/zip`, because the
 *   page's own `fetch` is patched to route it (see `virtual-network.ts`).
 * - The same URL under `<a download>` never reaches the page's `fetch`, and
 *   never reaches the service worker either — Chromium takes a download-
 *   attributed navigation out of the worker's hands entirely, so the one place
 *   a static deployment can answer for a virtual route is skipped.
 *
 * So the browser asks the static host, the static host has no such file, and
 * the download fails with "file wasn't available on site" — which is what a
 * person clicking *Session log* saw.
 *
 * The fix is to stop asking the browser to fetch it. A same-origin `download`
 * link is fetched here instead, through the same patched `fetch` that answers
 * for it, and saved from memory. That is uniformly correct rather than a
 * special case: a link to an ordinary static file fetches exactly as well.
 *
 * Two places have to be watched, because a download link is not always in the
 * page. A click that bubbles is caught on `document`; a detached anchor that
 * some code built and called `.click()` on — which is precisely what the
 * session export does — propagates to nothing, so `HTMLAnchorElement.click`
 * is wrapped as well. Patching a DOM method is a real cost and it is the
 * smaller one here: the alternative is a feature that silently does nothing.
 */

/** How long an object URL is kept alive after the click that used it. */
const REVOKE_AFTER_MS = 60_000

/** Hand bytes to the browser as a file, from memory. */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  anchor.dataset[OURS] = ''
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoked late rather than immediately: a browser that has not started
  // reading the blob when the URL goes away downloads nothing at all, and how
  // long "not yet" lasts is not something a page gets told.
  setTimeout(() => { URL.revokeObjectURL(url) }, REVOKE_AFTER_MS)
}

/**
 * The name to save under.
 *
 * The link's own `download` first, because that is the author saying so. Then
 * whatever the response calls it, then the last segment of the path — the same
 * order a browser uses, and for the same reason.
 * @param anchor - the link that was clicked.
 * @param response - what came back.
 * @returns a file name.
 */
function nameFor(anchor: HTMLAnchorElement, response: Response): string {
  const asked = anchor.getAttribute('download')
  if (asked !== null && asked !== '') return asked
  const disposition = response.headers.get('content-disposition') ?? ''
  const quoted = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  if (quoted !== null) return decodeURIComponent(quoted[1])
  const tail = new URL(anchor.href, document.baseURI).pathname.split('/').filter(Boolean).pop()
  return tail === undefined || tail === '' ? 'download' : tail
}

/** Marks the anchors this module makes itself, so it does not answer its own clicks. */
const OURS = 'dshDownload'

/**
 * Take over one download link, if it is one this page has to fetch itself.
 * @param anchor - the link being clicked.
 * @returns whether this module is handling it; false leaves the browser to it.
 */
function handle(anchor: HTMLAnchorElement): boolean {
  if (anchor.dataset[OURS] !== undefined) return false
  if (!anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  if (href === null || href === '') return false

  let url: URL
  try {
    url = new URL(href, document.baseURI)
  } catch {
    return false
  }
  // A `blob:` or `data:` link is already bytes the page is holding, and a
  // cross-origin one is somebody else's file with somebody else's headers:
  // both download fine as they are, and fetching them would only add a way to
  // fail. `protocol` as well as `origin`, because a blob URL made from this
  // page reports this page's origin.
  if (url.origin !== location.origin || url.protocol !== location.protocol) return false

  const asked = anchor.getAttribute('download') ?? ''
  void (async () => {
    try {
      const response = await fetch(url.href)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      save(await response.blob(), nameFor(anchor, response))
    } catch (error) {
      // Reported and not swallowed: the surface that owns the link has already
      // told the reader a download started, and a click that quietly does
      // nothing is the failure this file exists to remove.
      console.error(
        `[download] ${url.pathname} could not be fetched:`,
        error instanceof Error ? error.message : String(error),
      )
      // The browser's own attempt is still better than nothing, and on a path
      // the static host really does serve it is the right answer.
      const fallback = document.createElement('a')
      fallback.href = url.href
      fallback.download = asked
      fallback.dataset[OURS] = ''
      document.body.append(fallback)
      fallback.click()
      fallback.remove()
    }
  })()
  return true
}

/**
 * Fetch same-origin download links rather than letting the browser navigate.
 *
 * Installed twice over, for the two shapes a download link comes in. Both are
 * no-ops for anything without a `download` attribute: a plain link is a
 * navigation and none of this business.
 */
export function installDownloadLinks(): void {
  // Links that are in the page. Capture phase, so this runs before whatever
  // the surface attached to the link itself.
  document.addEventListener('click', (event: MouseEvent) => {
    // Modified clicks are the reader asking for something other than a plain
    // download — a new tab, a save-as — and the browser handles those better
    // than this can.
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a[download]')
    if (!(anchor instanceof HTMLAnchorElement)) return
    if (handle(anchor)) event.preventDefault()
  }, { capture: true })

  // Links that are not. `element.click()` on a detached anchor dispatches to
  // that element and to nothing else, so the listener above never hears it —
  // and a detached anchor is exactly how `dsh-session-log-export` saves a file.
  const original = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    if (handle(this)) return
    original.call(this)
  }
}
