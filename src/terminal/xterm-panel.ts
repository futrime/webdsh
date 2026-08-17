/**
 * The terminal: xterm.js in front, a Linux VM behind.
 *
 * This replaces the line-oriented pane that came before it. That pane could
 * show command output and nothing else — a full-screen program writes cursor
 * movement and repaints rather than lines, so anything interactive rendered as
 * a scroll of escape sequences. xterm.js is a real terminal emulator, so what
 * the VM writes is what a terminal would have drawn.
 *
 * The session is a real `bash` running in the VM, which is the whole point:
 * there is nothing to keep in sync between what the user types here and what
 * the agent runs, because they are the same shell on the same machine.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermStyles from '@xterm/xterm/css/xterm.css?raw'
import { bootVm, VM_ENV, VM_WORKSPACE, vmSupported, type VmDisk } from '../vm/cheerpx.ts'

const STYLE = `
.dshx-toggle{position:fixed;right:1rem;bottom:1rem;z-index:2147482000;display:flex;align-items:center;gap:.4rem;
 font:13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:.55rem .9rem;border-radius:999px;cursor:pointer;
 border:1px solid rgba(127,127,127,.35);background:rgba(255,255,255,.92);color:#1a1a1a;backdrop-filter:blur(8px);
 box-shadow:0 2px 12px rgba(0,0,0,.12)}
.dshx-toggle-plugins{right:9.5rem}
.dshx-toggle:hover{background:#fff}
@media (prefers-color-scheme:dark){.dshx-toggle{background:rgba(32,32,32,.92);color:#ededed}
 .dshx-toggle:hover{background:#2a2a2a}}
.dshx-panel{position:fixed;left:0;right:0;bottom:0;height:min(52vh,32rem);z-index:2147482100;display:none;
 flex-direction:column;background:#0d1017;border-top:1px solid rgba(127,127,127,.3);
 box-shadow:0 -8px 32px rgba(0,0,0,.35)}
.dshx-panel[data-open]{display:flex}
.dshx-bar{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;color:#dfe3ea;flex:none;
 border-bottom:1px solid rgba(127,127,127,.2);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.dshx-title{font-weight:600}
.dshx-hint{opacity:.55;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-bar button{font:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);color:inherit;
 border-radius:.35rem;padding:.15rem .5rem;cursor:pointer}
.dshx-bar button:hover{background:rgba(127,127,127,.18)}
.dshx-grip{position:absolute;top:-3px;left:0;right:0;height:6px;cursor:ns-resize}
.dshx-screen{flex:1;min-height:0;padding:.35rem .5rem}
.dshx-boot{padding:1rem;color:#9aa3b2;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.dshx-boot b{color:#dfe3ea;font-weight:600}
.dshx-boot a{color:#6fb3f2}
`

/** The terminal's public surface. */
export interface XtermPanel {
  open(): void
  close(): void
  toggle(): void
  /** The toolbar button that opens the plugin inventory. */
  readonly pluginsButton: HTMLButtonElement
  /** Everything the screen currently shows, for tests. */
  text(): string
  /** Type a line into the running shell, for tests and automation. */
  send(text: string): void
}

/** Ensure both stylesheets are present exactly once. */
function ensureStyle(): void {
  if (document.getElementById('dshx-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshx-style'
  style.textContent = `${xtermStyles}\n${STYLE}`
  document.head.append(style)
}

/**
 * Build and attach the terminal.
 * @param disk - where the VM's root image lives.
 * @returns the panel's control surface.
 */
export function installTerminal(disk: VmDisk): XtermPanel {
  ensureStyle()

  const toggle = document.createElement('button')
  toggle.className = 'dshx-toggle'
  toggle.type = 'button'
  toggle.textContent = '⌘ Terminal'
  toggle.title = 'Open a Linux shell in this workspace (Ctrl+`)'

  const pluginsButton = document.createElement('button')
  pluginsButton.className = 'dshx-toggle dshx-toggle-plugins'
  pluginsButton.type = 'button'
  pluginsButton.textContent = '⧉ Plugins'
  pluginsButton.title = 'Install and manage plugins'

  const panel = document.createElement('div')
  panel.className = 'dshx-panel'
  panel.innerHTML = `
    <div class="dshx-grip"></div>
    <div class="dshx-bar">
      <span class="dshx-title">Terminal</span>
      <span class="dshx-hint">Debian on a virtual machine in this tab — the agent runs here too</span>
      <button type="button" data-act="close">Close</button>
    </div>
    <div class="dshx-screen"></div>`

  document.body.append(toggle, pluginsButton, panel)

  const screen = panel.querySelector('.dshx-screen') as HTMLElement
  const terminal = new Terminal({
    // The VM's console is not behind a line discipline, so a bare newline
    // arrives without the carriage return a tty would have added. Without this
    // every line starts where the previous one ended.
    convertEol: true,
    cursorBlink: true,
    fontSize: 12.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: {
      background: '#0d1017',
      foreground: '#dfe3ea',
      cursor: '#7fd1a0',
      selectionBackground: 'rgba(111,179,242,.35)',
    },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)

  let attached = false
  let started = false
  let sendKey: ((keyCode: number) => void) | undefined

  /** Show a message in the panel before the terminal itself exists. */
  const notice = (html: string): void => {
    const box = document.createElement('div')
    box.className = 'dshx-boot'
    box.innerHTML = html
    screen.textContent = ''
    screen.append(box)
  }

  /** Attach xterm to the DOM once the panel has a size to measure. */
  const attach = (): void => {
    if (attached) return
    attached = true
    screen.textContent = ''
    terminal.open(screen)
    fit.fit()
  }

  /** Boot the VM and hand the terminal a login shell. */
  const start = async (): Promise<void> => {
    if (started) return
    started = true

    const support = vmSupported()
    if (!support.ok) {
      notice(
        `<b>The virtual machine cannot start here.</b>\n\n${support.reason ?? ''}.\n\n`
        + 'The VM needs SharedArrayBuffer, which a browser only grants a cross-origin isolated page. '
        + 'Reloading usually fixes this, because the service worker that adds the required headers '
        + 'only controls the page after its first load.',
      )
      started = false
      return
    }

    attach()
    terminal.write('[38;5;108mStarting the machine…[0m\r\n')
    try {
      const vm = await bootVm(disk, (step) => { terminal.write(`[38;5;244m${step}…[0m\r\n`) })
      terminal.write('\r\n')

      // The VM writes bytes; xterm consumes them. Nothing decodes or rewrites
      // in between, so escape sequences reach the emulator intact.
      sendKey = vm.linux.setCustomConsole(
        (buffer: Uint8Array) => { terminal.write(buffer) },
        terminal.cols,
        terminal.rows,
      )
      terminal.onData((data: string) => {
        if (sendKey === undefined) return
        // `onData` yields UTF-8 text; the console takes one byte at a time.
        for (const byte of new TextEncoder().encode(data)) sendKey(byte)
      })

      await vm.linux.run('/bin/bash', ['--login'], {
        env: VM_ENV,
        cwd: VM_WORKSPACE,
        uid: 1000,
        gid: 1000,
      })
      terminal.write('\r\n[38;5;244m[the shell exited — reload to start a new one][0m\r\n')
    } catch (error) {
      terminal.write(`\r\n[31m${error instanceof Error ? error.message : String(error)}[0m\r\n`)
      started = false
    }
  }

  const api: XtermPanel = {
    open() {
      panel.setAttribute('data-open', '')
      if (attached) { fit.fit(); terminal.focus() }
      void start()
    },
    close() { panel.removeAttribute('data-open') },
    toggle() {
      if (panel.hasAttribute('data-open')) api.close()
      else api.open()
    },
    pluginsButton,
    text: () => {
      const buffer = terminal.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n')
    },
    send(text: string) {
      if (sendKey === undefined) return
      for (const byte of new TextEncoder().encode(text)) sendKey(byte)
    },
  }

  toggle.addEventListener('click', () => { api.toggle() })
  panel.querySelector('[data-act="close"]')?.addEventListener('click', () => { api.close() })

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === '`') {
      api.toggle()
      event.preventDefault()
    }
  })

  // A resize grip, plus keeping the emulator's grid matched to the pane.
  const grip = panel.querySelector('.dshx-grip') as HTMLElement
  grip.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = panel.getBoundingClientRect().height
    const move = (moveEvent: PointerEvent): void => {
      const next = Math.min(Math.max(startHeight + (startY - moveEvent.clientY), 140), window.innerHeight - 80)
      panel.style.height = `${String(next)}px`
      if (attached) fit.fit()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
  window.addEventListener('resize', () => { if (attached && panel.hasAttribute('data-open')) fit.fit() })

  return api
}
