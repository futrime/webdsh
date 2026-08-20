/**
 * The terminal plugin's browser half.
 *
 * This is an ordinary client plugin: it injects into the surface's own slots —
 * a footer action in the sidebar to open it, and the shell overlay to draw in —
 * exactly as `ui-cordis` and the community panels do. Nothing about the web
 * surface is modified to make room for it: the action wears the shape the
 * sidebar's own Settings row has, in the sidebar's own tokens, so the foot
 * reads as one stack of rows rather than as a plugin bolted to the bottom.
 *
 * The runtime it attaches to is a page-level capability the app publishes, not
 * something this plugin boots: the agent's own tools run in the same one, and
 * two containers in a tab would be two different machines.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The capability the app publishes for whoever draws the terminal. */
interface RuntimeBridge {
  /** Start an interactive shell sized to the given grid. */
  startShell(size: { cols: number, rows: number }): Promise<{
    output: ReadableStream<string>
    input: WritableStream<string>
    exit: Promise<number>
    resize(size: { cols: number, rows: number }): void
  }>
  /** Boot the runtime, reporting progress. */
  boot(onProgress?: (step: string) => void): Promise<unknown>
  /** Why a terminal cannot open here, when it cannot; the whole message. */
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
  /** Repaint a row range; a canvas that was `display:none` has nothing on it. */
  refresh(start: number, end: number): void
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
function TerminalPanel({ open, onClose }: { open: boolean, onClose: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const started = useRef(false)
  const fitter = useRef<FitAddon | undefined>(undefined)
  const emulator = useRef<XTerm | undefined>(undefined)
  const gone = useRef(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // The emulator outlives every open and close, and is disposed once, when this
  // component itself goes away. Tying its lifetime to `open` is what broke it:
  // an effect's cleanup runs on every dependency change, not only on unmount,
  // so closing the panel disposed the terminal — taking its DOM with it — while
  // the guard below still said it had been started. Reopening then rendered an
  // empty box, with the session running and nothing drawing it.
  useEffect(() => () => {
    gone.current = true
    emulator.current?.dispose()
  }, [])

  // A hidden element has no size, so the grid measured zero while it was
  // closed. Re-fitting on the way back matches it to the window again, and the
  // refresh after it is what repaints rows that were never drawn while there
  // was nothing to draw them on.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      fitter.current?.fit()
      const terminal = emulator.current
      if (terminal !== undefined) terminal.refresh(0, Math.max(0, terminal.rows - 1))
    })
    return () => { cancelAnimationFrame(frame) }
  }, [open])

  useEffect(() => {
    if (!open || started.current || host.current === null) return
    const runtime = bridge()
    if (runtime === undefined) {
      setMessage('The runtime bridge is not available in this build.')
      return
    }
    // The whole message, not a fragment: there is more than one reason a
    // terminal cannot open here — a browser that cannot be cross-origin
    // isolated, or a machine whose console is its own screen — and only the
    // app knows which one applies. A panel that appended its own paragraph
    // about `SharedArrayBuffer` told half its readers to fix the wrong thing.
    const reason = runtime.unavailable()
    if (reason !== undefined) {
      setMessage(reason)
      return
    }
    started.current = true

    let terminal: XTerm | undefined
    void (async () => {
      const { Terminal, FitAddon, styles } = await runtime.terminal()
      if (gone.current) return
      if (document.getElementById('dsh-web-terminal-style') === null) {
        const style = document.createElement('style')
        style.id = 'dsh-web-terminal-style'
        style.textContent = styles
        document.head.append(style)
      }
      terminal = new Terminal({
        // The shell is not behind a line discipline, so a bare newline arrives
        // without the carriage return a tty would have added.
        convertEol: true,
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: '#0d1017', foreground: '#dfe3ea', cursor: '#7fd1a0' },
      })
      const fit = new FitAddon()
      fitter.current = fit
      emulator.current = terminal
      terminal.loadAddon(fit)
      terminal.open(host.current!)
      fit.fit()
      ;(globalThis as Record<string, unknown>).__DSH_TERMINAL__ = {
        text: () => {
          const buffer = terminal!.buffer.active
          const lines: string[] = []
          for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
          return lines.join('\n')
        },
        send: (text: string) => { void writer?.write(text) },
      }

      terminal.write('[38;5;108mStarting the runtime…[0m\r\n')
      let writer: WritableStreamDefaultWriter<string> | undefined
      try {
        await runtime.boot(step => { terminal!.write(`[38;5;244m${step}…[0m\r\n`) })
        const shell = await runtime.startShell({ cols: terminal.cols, rows: terminal.rows })
        void shell.output.pipeTo(new WritableStream<string>({
          write(chunk) { terminal!.write(chunk) },
        })).catch(() => undefined)
        writer = shell.input.getWriter()
        terminal.onData(data => { void writer?.write(data) })
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
  }, [open])

  // Hidden rather than unmounted. Closing used to drop the element, which took
  // the emulator with it through this effect's cleanup, while `started` stayed
  // true — so the next open drew nothing at all. Keeping it mounted fixes that
  // and buys the behaviour a terminal is supposed to have: the session, its
  // scrollback and its working directory are still there when it comes back.
  return (
    <div className="dsh-web-terminal" {...(open ? { 'data-open': '' } : { hidden: true })}>
      <div className="dsh-web-terminal-bar">
        <span className="dsh-web-terminal-title">Terminal</span>
        <span className="dsh-web-terminal-hint">the same runtime the agent runs in</span>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {message === undefined
        ? <div className="dsh-web-terminal-screen" ref={host} />
        : <p className="dsh-web-terminal-notice">{message}</p>}
    </div>
  )
}

/** A prompt in a window, drawn in the outline language the sidebar's icons use. */
function TerminalIcon(): JSX.Element {
  return (
    <svg
      className="dsh-web-terminal-action-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.6" />
      <path d="M4.8 6.3 6.9 8l-2.1 1.7" />
      <path d="M8.8 10.2h2.6" />
    </svg>
  )
}

/**
 * The sidebar footer action that opens it.
 * @param props - the owner share of the slot plus this plugin's own open state.
 * @returns the row, in the shape the sidebar's Settings row already has.
 */
function TerminalAction({ open, onToggle, wide }: { open: boolean, onToggle: () => void, wide: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="dsh-web-terminal-action"
      {...(wide ? {} : { 'data-rail': '' })}
      {...(open ? { 'data-open': '' } : {})}
      aria-expanded={open}
      aria-label="Terminal"
      onClick={onToggle}
      title="Open a shell in this workspace (Ctrl+`)"
    >
      <TerminalIcon />
      {wide && <span className="dsh-web-terminal-action-label">Terminal</span>}
    </button>
  )
}

const STYLE = `
.dsh-web-terminal[hidden]{display:none}
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
.dsh-web-terminal-action{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 calc(100% + 8px);
 width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:none;border-radius:12px;
 background:0 0;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;
 cursor:pointer;overflow:hidden}
.dsh-web-terminal-action:hover,.dsh-web-terminal-action[data-open]{
 background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-terminal-action-icon{flex:none}
.dsh-web-terminal-action-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-web-terminal-action[data-rail]{flex:0 0 36px;justify-content:center;gap:0;width:36px;height:36px;
 margin:4px 0;padding:0;border-radius:50%}
/* The foot's action line is one nowrap row, so a second action would sit
   beside this one. Opening the line is what puts each action on a row of its
   own, under the terminal and above Settings — the two shapes cover the slot
   renderer's wrapper being present or not, and nothing else in the tree has
   this element as a child or grandchild. */
:has(> .dsh-web-terminal-action),:has(> * > .dsh-web-terminal-action){flex-wrap:wrap}
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
    function Action({ wide }: { wide: boolean }): JSX.Element {
      const isOpen = useOpen()
      const toggle = useCallback(() => { setOpen(!open) }, [])
      return <TerminalAction open={isOpen} onToggle={toggle} wide={wide} />
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
