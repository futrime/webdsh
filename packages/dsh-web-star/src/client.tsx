/**
 * The star plugin's browser half.
 *
 * An ordinary client plugin: one registrant in the surface's own
 * `sidebar.footer.action` slot, the same hole the terminal and `ui-cordis` use,
 * so it lands beside Settings and folds with the column instead of being drawn
 * over it.
 *
 * The star count is a courtesy, not a feature. GitHub serves the repository
 * endpoint with CORS and rate-limits it by address, so the number is fetched
 * once, cached for the day, and simply absent when the request fails — the
 * link works either way, and nothing here waits on the network to render.
 */

import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The repository this build comes from. */
const REPO = 'futrime/webdsh'

/** Where the button sends the visitor. */
const REPO_URL = `https://github.com/${REPO}`

/** Where the count comes from. */
const API_URL = `https://api.github.com/repos/${REPO}`

/** Where a fetched count is kept between reloads, and for how long. */
const CACHE_KEY = 'dsh-web-star:count'
const CACHE_TTL = 24 * 60 * 60 * 1000

/**
 * Read a count cached by an earlier visit.
 * @returns the count, or nothing when it is absent, stale, or unreadable.
 */
function cachedCount(): number | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw === null) return undefined
    const entry = JSON.parse(raw) as { count?: unknown, at?: unknown }
    if (typeof entry.count !== 'number' || typeof entry.at !== 'number') return undefined
    return Date.now() - entry.at < CACHE_TTL ? entry.count : undefined
  } catch {
    return undefined
  }
}

/**
 * The repository's star count, fetched at most once a day per browser.
 * @returns the count once it is known.
 */
function useStarCount(): number | undefined {
  const [count, setCount] = useState<number | undefined>(cachedCount)
  useEffect(() => {
    if (count !== undefined) return
    let live = true
    void (async () => {
      try {
        const response = await fetch(API_URL, { headers: { accept: 'application/vnd.github+json' } })
        if (!response.ok) return
        const body = await response.json() as { stargazers_count?: unknown }
        if (typeof body.stargazers_count !== 'number') return
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ count: body.stargazers_count, at: Date.now() }))
        } catch { /* a full or blocked store is not a reason to hide the count */ }
        if (live) setCount(body.stargazers_count)
      } catch { /* offline, rate-limited, or blocked: the link still works */ }
    })()
    return () => { live = false }
  }, [count])
  return count
}

/** GitHub's own star, at the size the sidebar's other foot icons draw. */
function StarIcon(): JSX.Element {
  return (
    <svg className="dsh-web-star-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 .5a.6.6 0 0 1 .54.34l1.86 3.78 4.17.6a.6.6 0 0 1 .33 1.03l-3.02 2.94.71 4.15a.6.6 0 0 1-.87.64L8 11.98l-3.72 1.96a.6.6 0 0 1-.87-.64l.71-4.15L1.1 6.25a.6.6 0 0 1 .33-1.03l4.17-.6L7.46.84A.6.6 0 0 1 8 .5Z"
      />
    </svg>
  )
}

/**
 * The foot action itself.
 * @param props - the owner share of the slot; `wide` is false on the 56px rail.
 * @returns the link when the column is wide, and nothing when it is folded.
 */
function StarAction({ wide }: { wide: boolean }): JSX.Element | null {
  const count = useStarCount()
  // The folded column leaves 36px of content on one shared line, and the
  // terminal is already on it. An ask that pushes a tool the user came to use
  // out of the column is not an ask worth making, so this one yields and comes
  // back when the column does.
  if (!wide) return null
  // `compact` is Intl's own abbreviation, so 1200 reads as 1.2K in every locale
  // the surface offers without this file knowing any of them.
  const reading = count === undefined
    ? undefined
    : new Intl.NumberFormat(undefined, { notation: 'compact' }).format(count)
  return (
    <a
      className="dsh-web-star"
      href={REPO_URL}
      target="_blank"
      rel="noreferrer noopener"
      title={`${REPO} is open source and free to run. A star helps other people find it.`}
      aria-label={`Star ${REPO} on GitHub`}
    >
      <StarIcon />
      <span className="dsh-web-star-label">Star on GitHub</span>
      {reading !== undefined && <span className="dsh-web-star-count">{reading}</span>}
    </a>
  )
}

/**
 * The surface's own foot-row shape, in its own tokens: the 49px height and 12px
 * radius the other foot rows use, sized to its own content rather than to the
 * row — the foot is a shared flex line, and a registrant that takes the whole
 * width wraps the terminal beside it. The fallbacks are for a theme that has
 * not defined these, not for a different look.
 */
const STYLE = `
.dsh-web-star{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:flex-start;
 flex:0 1 auto;width:auto;max-width:100%;height:49px;border-radius:12px;gap:6px;padding:0 10px;
 font:inherit;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);text-decoration:none}
.dsh-web-star:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.12))}
.dsh-web-star-icon{flex:none}
.dsh-web-star-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-star-count{flex:none;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;
 color:var(--dsw-alias-label-tertiary,inherit)}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-star-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-star-chrome'
    style.textContent = STYLE
    document.head.append(style)
  }

  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string, order?: number, label?: string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  // Last among the foot actions: the terminal and the plugin panel are things
  // the visitor came to use, and this is a thing being asked of them.
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-star', order: 100, label: 'Star on GitHub' },
    StarAction,
  ))
}

export default { apply, inject }
