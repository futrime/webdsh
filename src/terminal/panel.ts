/**
 * A terminal the user can drive, over the same shell the agent runs in.
 *
 * `dsh web` has a machine behind it, so a user who wants a shell already has
 * one — a second window, outside the app. Here there is no outside: the
 * filesystem the agent edits lives in this page and nothing else can reach it.
 * Without a terminal, the user can only inspect their own workspace by asking
 * the model to.
 *
 * The point is that it is not a *simulation of* the agent's environment but
 * literally it: the same {@link ShellSession} type over the same singleton
 * volume, so a file the user creates here is the file the agent's next tool
 * call reads, and `cd`/`export` persist across lines the way a shell's do.
 */

import { createShellSession, type ShellSession } from '../shell/index.ts'

/** Where a fresh terminal starts. */
const DEFAULT_CWD = '/home/dsh/workspace'

/** How many lines of scrollback to keep before dropping the oldest. */
const MAX_LINES = 5000

const STYLE = `
.dsht-toggle{position:fixed;right:1rem;bottom:1rem;z-index:2147482000;display:flex;align-items:center;gap:.4rem;
 font:13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:.55rem .9rem;border-radius:999px;cursor:pointer;
 border:1px solid rgba(127,127,127,.35);background:rgba(255,255,255,.92);color:#1a1a1a;backdrop-filter:blur(8px);
 box-shadow:0 2px 12px rgba(0,0,0,.12)}
.dsht-toggle:hover{background:#fff}
@media (prefers-color-scheme:dark){.dsht-toggle{background:rgba(32,32,32,.92);color:#ededed}
 .dsht-toggle:hover{background:#2a2a2a}}
.dsht-panel{position:fixed;left:0;right:0;bottom:0;height:min(48vh,30rem);z-index:2147482100;display:none;
 flex-direction:column;background:#12141a;color:#dfe3ea;border-top:1px solid rgba(127,127,127,.3);
 box-shadow:0 -8px 32px rgba(0,0,0,.35)}
.dsht-panel[data-open]{display:flex}
.dsht-bar{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;border-bottom:1px solid rgba(127,127,127,.2);
 font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;flex:none}
.dsht-title{font-weight:600;opacity:.85}
.dsht-hint{opacity:.5;flex:1}
.dsht-bar button{font:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);color:inherit;
 border-radius:.35rem;padding:.15rem .5rem;cursor:pointer}
.dsht-bar button:hover{background:rgba(127,127,127,.18)}
.dsht-grip{position:absolute;top:-3px;left:0;right:0;height:6px;cursor:ns-resize}
.dsht-screen{flex:1;overflow:auto;padding:.6rem .75rem;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;
 font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsht-screen .dsht-err{color:#ff8f8f}
.dsht-screen .dsht-prompt{color:#7fd1a0}
.dsht-form{display:flex;align-items:baseline;gap:.5rem;padding:.5rem .75rem;border-top:1px solid rgba(127,127,127,.2);flex:none}
.dsht-ps1{color:#7fd1a0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
.dsht-input{flex:1;background:transparent;border:0;outline:none;color:inherit;
 font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
`

/** The terminal's public surface. */
export interface TerminalPanel {
  /** Show the panel and focus the input. */
  open(): void
  /** Hide the panel. */
  close(): void
  /** Toggle visibility. */
  toggle(): void
  /** Run a command as if typed, for automation. */
  submit(line: string): Promise<void>
  /** Everything currently on screen. */
  text(): string
}

/** Ensure the stylesheet is present exactly once. */
function ensureStyle(): void {
  if (document.getElementById('dsht-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsht-style'
  style.textContent = STYLE
  document.head.append(style)
}

/**
 * Build and attach the terminal.
 * @returns the panel's control surface.
 */
export function installTerminal(): TerminalPanel {
  ensureStyle()

  const toggle = document.createElement('button')
  toggle.className = 'dsht-toggle'
  toggle.type = 'button'
  toggle.textContent = '⌘ Terminal'
  toggle.title = 'Open a shell in this workspace (Ctrl+`)'

  const panel = document.createElement('div')
  panel.className = 'dsht-panel'
  panel.innerHTML = `
    <div class="dsht-grip"></div>
    <div class="dsht-bar">
      <span class="dsht-title">Terminal</span>
      <span class="dsht-hint">the same shell the agent runs in — Ctrl+C interrupts, Ctrl+\` closes</span>
      <button type="button" data-act="clear">Clear</button>
      <button type="button" data-act="close">Close</button>
    </div>
    <pre class="dsht-screen" tabindex="0"></pre>
    <form class="dsht-form">
      <span class="dsht-ps1"></span>
      <input class="dsht-input" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Terminal input">
    </form>`

  document.body.append(toggle, panel)

  const screen = panel.querySelector('.dsht-screen') as HTMLPreElement
  const form = panel.querySelector('.dsht-form') as HTMLFormElement
  const input = panel.querySelector('.dsht-input') as HTMLInputElement
  const ps1 = panel.querySelector('.dsht-ps1') as HTMLElement

  let session: ShellSession = createShellSession({ cwd: DEFAULT_CWD })
  const history: string[] = []
  let historyIndex = 0
  let running: AbortController | undefined

  /** Append text, tagging it so stderr reads differently. */
  const write = (text: string, kind?: 'err' | 'prompt'): void => {
    if (text === '') return
    if (kind === undefined) {
      screen.append(document.createTextNode(text))
    } else {
      const span = document.createElement('span')
      span.className = kind === 'err' ? 'dsht-err' : 'dsht-prompt'
      span.textContent = text
      screen.append(span)
    }
    // Keeping the whole session would grow without bound; the oldest output is
    // what a scrollback drops.
    while (screen.childNodes.length > MAX_LINES) screen.firstChild?.remove()
    screen.scrollTop = screen.scrollHeight
  }

  const refreshPrompt = (): void => {
    const cwd = session.cwd().replace(/^\/home\/dsh/, '~')
    ps1.textContent = `${cwd} $`
  }

  const run = async (line: string): Promise<void> => {
    write(`${ps1.textContent ?? '$'} `, 'prompt')
    write(`${line}\n`)
    if (line.trim() === 'clear') {
      screen.textContent = ''
      return
    }
    const controller = new AbortController()
    running = controller
    input.disabled = true
    try {
      const result = await session.run(line, {
        signal: controller.signal,
        onStdout: chunk => { write(chunk) },
        onStderr: chunk => { write(chunk, 'err') },
      })
      // A shell prints nothing for success; a non-zero status is worth showing
      // because there is no `$?` prompt segment here.
      if (result.status !== 0) write(`[exit ${String(result.status)}]\n`, 'err')
    } catch (error) {
      write(`${error instanceof Error ? error.message : String(error)}\n`, 'err')
    } finally {
      running = undefined
      input.disabled = false
      refreshPrompt()
      if (panel.hasAttribute('data-open')) input.focus()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const line = input.value
    input.value = ''
    if (line.trim().length > 0) {
      history.push(line)
      historyIndex = history.length
    }
    void run(line)
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      if (historyIndex > 0) { historyIndex--; input.value = history[historyIndex] ?? '' }
      event.preventDefault()
    } else if (event.key === 'ArrowDown') {
      if (historyIndex < history.length) { historyIndex++; input.value = history[historyIndex] ?? '' }
      event.preventDefault()
    } else if (event.key === 'c' && event.ctrlKey) {
      running?.abort()
      event.preventDefault()
    }
  })

  const api: TerminalPanel = {
    open() {
      panel.setAttribute('data-open', '')
      refreshPrompt()
      input.focus()
    },
    close() { panel.removeAttribute('data-open') },
    toggle() { if (panel.hasAttribute('data-open')) api.close(); else api.open() },
    async submit(line: string) { await run(line) },
    text: () => screen.textContent ?? '',
  }

  toggle.addEventListener('click', () => { api.toggle() })
  panel.querySelector('[data-act="close"]')?.addEventListener('click', () => { api.close() })
  panel.querySelector('[data-act="clear"]')?.addEventListener('click', () => { screen.textContent = '' })

  // A resize grip, because the useful height depends on what is being read.
  const grip = panel.querySelector('.dsht-grip') as HTMLElement
  grip.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = panel.getBoundingClientRect().height
    const move = (moveEvent: PointerEvent): void => {
      const next = Math.min(Math.max(startHeight + (startY - moveEvent.clientY), 120), window.innerHeight - 80)
      panel.style.height = `${String(next)}px`
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === '`') {
      api.toggle()
      event.preventDefault()
    }
  })

  refreshPrompt()
  write('DeepSeek Harness terminal — this is the agent\'s own shell and filesystem.\n', 'prompt')
  write("Type `help` for what is available.\n\n")

  // A reset from the page API throws the volume away; the session's cwd may no
  // longer exist, so start a fresh one rather than stranding the prompt.
  ;(globalThis as { addEventListener?: typeof window.addEventListener }).addEventListener?.('dsh:volume-reset', () => {
    session = createShellSession({ cwd: DEFAULT_CWD })
    refreshPrompt()
  })

  return api
}
