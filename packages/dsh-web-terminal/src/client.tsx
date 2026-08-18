/**
 * The terminal plugin's browser half.
 *
 * This is an ordinary client plugin: it injects into the surface's own slots —
 * a footer action in the sidebar to open it, and the shell overlay to draw in —
 * exactly as `ui-cordis` and the community panels do. Nothing about the web
 * surface is modified to make room for it.
 *
 * The machine it attaches to is a page-level capability the app publishes, not
 * something this plugin boots: the agent's own tools run in the same one, and
 * two containers in a tab would be two different machines.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The capability the app publishes for whoever draws the terminal. */
interface RuntimeBridge {
  /** Start an interactive shell sized to the given grid. */
  startShell(size: { cols: number, rows: number }): Promise<{
    output: ReadableStream<Uint8Array>
    write(data: string): void
    resize(size: { cols: number, rows: number }): void
    kill(signal?: string): void
    exit: Promise<number>
  }>
  /** Boot the machine, reporting progress. */
  boot(onProgress?: (step: string) => void): Promise<unknown>
  /** Why the machine cannot start here, when it cannot. */
  unavailable(): string | undefined
  /** The terminal emulator and its fit addon, supplied by the app's bundle. */
  terminal(): Promise<{ Terminal: new (options: unknown) => XTerm, FitAddon: new () => FitAddon, styles: string }>
}

/** As much of xterm's surface as this file uses. */
interface XTerm {
  cols: number
  rows: number
  open(element: HTMLElement): void
  write(data: string): void
  onData(handler: (data: string) => void): void
  onResize(handler: (size: { cols: number, rows: number }) => void): void
  loadAddon(addon: unknown): void
  focus(): void
  dispose(): void
  buffer: { active: { length: number, getLine(index: number): { translateToString(trim?: boolean): string } | undefined } }
}

/** xterm's fit addon. */
interface FitAddon { fit(): void }

/** Where the app publishes the bridge. */
const BRIDGE = '__DSH_WEB_RUNTIME__'

/** Read the bridge the app published. */
function bridge(): RuntimeBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE] as RuntimeBridge | undefined
}

/** The panel, drawn into the surface's shell overlay. */
function TerminalPanel({ open, onClose }: { open: boolean, onClose: () => void }): JSX.Element | null {
  const host = useRef<HTMLDivElement | null>(null)
  const started = useRef(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open || started.current || host.current === null) return
    const runtime = bridge()
    if (runtime === undefined) {
      setMessage('The runtime bridge is not available in this build.')
      return
    }
    const reason = runtime.unavailable()
    if (reason !== undefined) {
      setMessage(
        `${reason}. The machine needs SharedArrayBuffer, which a browser grants only a `
        + 'cross-origin isolated page; reloading usually fixes it, because the worker that '
        + 'adds the required headers only controls the page after its first load.',
      )
      return
    }
    started.current = true

    let terminal: XTerm | undefined
    let disposed = false
    void (async () => {
      const { Terminal, FitAddon, styles } = await runtime.terminal()
      if (disposed) return
      if (document.getElementById('dsh-web-terminal-style') === null) {
        const style = document.createElement('style')
        style.id = 'dsh-web-terminal-style'
        style.textContent = styles
        document.head.append(style)
      }
      terminal = new Terminal({
        // No `convertEol`: this is a real pseudoterminal, so the container's own
        // line discipline has already turned every newline into CRLF, and
        // converting again would double it.
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: '#0d1017', foreground: '#dfe3ea', cursor: '#7fd1a0' },
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(host.current!)
      fit.fit()
      let session: { write(data: string): void } | undefined
      ;(globalThis as Record<string, unknown>).__DSH_TERMINAL__ = {
        text: () => {
          const buffer = terminal!.buffer.active
          const lines: string[] = []
          for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
          return lines.join('\n')
        },
        send: (text: string) => { session?.write(text) },
      }

      terminal.write('[38;5;108mStarting the machine…[0m\r\n')
      try {
        await runtime.boot(step => { terminal!.write(`[38;5;244m${step}…[0m\r\n`) })
        const shell = await runtime.startShell({ cols: terminal.cols, rows: terminal.rows })
        session = shell
        const decoder = new TextDecoder()
        void shell.output.pipeTo(new WritableStream<Uint8Array>({
          // Decoded as a stream: a UTF-8 character can arrive split across two
          // reads, and half of one is a replacement character on the screen.
          write(chunk) { terminal!.write(decoder.decode(chunk, { stream: true })) },
        })).catch(() => undefined)
        terminal.onData(data => { shell.write(data) })
        terminal.onResize(size => { shell.resize(size) })
        const resize = (): void => { fit.fit() }
        window.addEventListener('resize', resize)
        await shell.exit
        window.removeEventListener('resize', resize)
        terminal.write('\r\n[38;5;244m[the shell exited — reload to start a new one][0m\r\n')
      } catch (error) {
        terminal.write(`\r\n[31m${error instanceof Error ? error.message : String(error)}[0m\r\n`)
        started.current = false
      }
    })()

    return () => {
      disposed = true
      terminal?.dispose()
    }
  }, [open])

  if (!open) return null
  return (
    <div className="dsh-web-terminal" data-open="">
      <div className="dsh-web-terminal-bar">
        <span className="dsh-web-terminal-title">Terminal</span>
        <span className="dsh-web-terminal-hint">the same machine the agent runs in</span>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {message === undefined
        ? <div className="dsh-web-terminal-screen" ref={host} />
        : <p className="dsh-web-terminal-notice">{message}</p>}
    </div>
  )
}

/** The sidebar footer action that opens it. */
function TerminalAction({ open, onToggle }: { open: boolean, onToggle: () => void }): JSX.Element {
  return (
    <button type="button" className="dsh-web-terminal-action" onClick={onToggle} title="Open a shell in this workspace">
      {open ? '⌘ Terminal ·' : '⌘ Terminal'}
    </button>
  )
}

const STYLE = `
.dsh-web-terminal{position:fixed;left:0;right:0;bottom:0;height:min(52vh,32rem);z-index:60;display:flex;
 flex-direction:column;background:#0d1017;border-top:1px solid rgba(127,127,127,.3);box-shadow:0 -8px 32px rgba(0,0,0,.35)}
.dsh-web-terminal-bar{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;color:#dfe3ea;flex:none;
 border-bottom:1px solid rgba(127,127,127,.2);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-web-terminal-title{font-weight:600}
.dsh-web-terminal-hint{opacity:.55;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-terminal-bar button{font:inherit;background:transparent;border:1px solid rgba(127,127,127,.4);color:inherit;
 border-radius:.35rem;padding:.15rem .5rem;cursor:pointer}
.dsh-web-terminal-screen{flex:1;min-height:0;padding:.35rem .5rem}
.dsh-web-terminal-notice{padding:1rem;color:#9aa3b2;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-web-terminal-action{font:inherit;background:transparent;border:0;color:inherit;cursor:pointer;padding:.25rem .5rem}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-terminal-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-terminal-chrome'
    style.textContent = STYLE
    document.head.append(style)
  }

  // One piece of state shared by the two slots: the action toggles what the
  // overlay draws, and the surface owns where each of them lives.
  let open = false
  const listeners = new Set<() => void>()
  const setOpen = (next: boolean): void => {
    open = next
    for (const listener of listeners) listener()
  }
  const useOpen = (): boolean => {
    const [, force] = useState(0)
    useEffect(() => {
      const listener = (): void => { force(count => count + 1) }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, [])
    return open
  }

  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'web-terminal' },
    function Overlay(): JSX.Element {
      const isOpen = useOpen()
      const close = useCallback(() => { setOpen(false) }, [])
      return (
        <div data-dsh-web-terminal-slot="">
          <TerminalPanel open={isOpen} onClose={close} />
        </div>
      )
    },
  ))

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-terminal' },
    function Action(): JSX.Element {
      const isOpen = useOpen()
      const toggle = useCallback(() => { setOpen(!open) }, [])
      return <TerminalAction open={isOpen} onToggle={toggle} />
    },
  ))

  // The surface has no shortcut of its own for this, and a terminal without one
  // is a terminal people forget is there.
  const onKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey && event.key === '`') {
      setOpen(!open)
      event.preventDefault()
    }
  }
  window.addEventListener('keydown', onKey)
  ctx.on('dispose', () => { window.removeEventListener('keydown', onKey) })
}

export default { apply, inject }
