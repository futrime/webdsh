/**
 * The pre-shell loading and failure screens.
 *
 * The shell has its own loading page, but it cannot render until the host has
 * settled and its bundle has been fetched — so a boot that fails before that
 * point would otherwise leave a blank tab. This screen owns exactly that
 * window, and removes itself the moment the shell takes over `#root`.
 */

/** Handle returned by {@link renderBootProgress}. */
export interface BootProgress {
  /** Replace the status line. */
  step(label: string): void
  /** Remove the screen (the shell has taken over). */
  done(): void
}

const STYLE = `
.dshw-boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
 background:#fff;color:#1a1a1a;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;z-index:2147483000}
@media (prefers-color-scheme:dark){.dshw-boot{background:#131313;color:#ededed}}
.dshw-panel{max-width:44rem;padding:2rem}
.dshw-title{font-size:1rem;font-weight:600;margin:0 0 .75rem}
.dshw-status{opacity:.7;display:flex;align-items:center;gap:.5rem}
.dshw-dot{width:.5rem;height:.5rem;border-radius:50%;background:currentColor;animation:dshw-pulse 1.1s ease-in-out infinite}
@keyframes dshw-pulse{0%,100%{opacity:.25}50%{opacity:1}}
.dshw-error{white-space:pre-wrap;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
 background:rgba(127,127,127,.12);padding:1rem;border-radius:.5rem;margin-top:1rem;max-height:60vh;overflow:auto}
.dshw-hint{opacity:.7;margin-top:1rem}
`

/** Ensure the screen's stylesheet is present exactly once. */
function ensureStyle(): void {
  if (document.getElementById('dshw-boot-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshw-boot-style'
  style.textContent = STYLE
  document.head.append(style)
}

/** Get or create the boot screen container. */
function container(): HTMLElement {
  ensureStyle()
  let element = document.getElementById('dshw-boot')
  if (element === null) {
    element = document.createElement('div')
    element.id = 'dshw-boot'
    element.className = 'dshw-boot'
    document.body.append(element)
  }
  return element
}

/** Show the boot screen and return its update handle. */
export function renderBootProgress(): BootProgress {
  const element = container()
  element.innerHTML = `
    <div class="dshw-panel">
      <p class="dshw-title">DeepSeek Harness</p>
      <p class="dshw-status"><span class="dshw-dot"></span><span id="dshw-step">Preparing the browser runtime</span></p>
    </div>`
  return {
    step(label: string) {
      const target = document.getElementById('dshw-step')
      if (target !== null) target.textContent = label
    },
    done() {
      element.remove()
    },
  }
}

/** Replace the boot screen with a failure report. */
export function renderBootFailure(error: unknown): void {
  const element = container()
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  const causes = collectCauses(error)
  element.innerHTML = `
    <div class="dshw-panel">
      <p class="dshw-title">DeepSeek Harness could not start</p>
      <div class="dshw-error"></div>
      <p class="dshw-hint">
        The full error is in the browser console. If this persists, clearing this site's storage
        resets the virtual filesystem and settings to a fresh state.
      </p>
    </div>`
  const report = element.querySelector('.dshw-error')
  if (report !== null) report.textContent = [detail, ...causes].join('\n\ncaused by:\n')
}

/** Flatten an error's `cause` chain and `AggregateError` members into readable text. */
function collectCauses(error: unknown, depth = 0): string[] {
  if (depth > 6 || !(error instanceof Error)) return []
  const out: string[] = []
  if (error instanceof AggregateError) {
    for (const member of error.errors) {
      out.push(member instanceof Error ? (member.stack ?? member.message) : String(member))
      out.push(...collectCauses(member, depth + 1))
    }
  }
  const cause: unknown = (error as { cause?: unknown }).cause
  if (cause !== undefined) {
    out.push(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))
    out.push(...collectCauses(cause, depth + 1))
  }
  return out
}
