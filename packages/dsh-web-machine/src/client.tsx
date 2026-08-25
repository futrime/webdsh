/**
 * The machine's browser half: one panel, and the setting that chooses what it shows.
 *
 * A session runs on one machine, and there are two kinds. The Node container
 * answers on a character stream, so looking at it means a terminal. An
 * emulated PC has a display, so looking at it means that display — the real
 * one, borrowed from the page rather than a second copy, so what the agent
 * types appears here and what is typed here the agent sees.
 *
 * They are one panel because they are one question. Which of them a visitor
 * gets is not a preference to toggle while working; it follows from the
 * machine, and the machine is chosen once, in Settings, beside every other
 * choice about how this deployment behaves. Two sidebar rows for one machine
 * only ever asked the visitor to know which half of it they wanted.
 *
 * Two things are worth knowing before reading it:
 *
 * **The choice applies on the next load.** It has to. Which machine a session
 * runs on decides which tools the model is offered, and a tool registry that
 * changes mid-session is a session where the model was told about a shell that
 * is no longer there. The setting says so where the choice is made rather than
 * pretending otherwise.
 *
 * **The screen is one size and the guests are not.** A DOS text mode is
 * 720×400, Windows 3.1 is 640×480, KolibriOS comes up at 800×600 — and a panel
 * that showed each at its own size would be a different panel per machine,
 * most of them a stamp in the corner of the window. So the screen is scaled to
 * the panel it is in, keeping its aspect ratio and its pixels, and the panel is
 * the same size whatever is running in it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The escape character, spelled rather than written into the source. */
const ESC = '\u001b'

/** What the session runs on. */
type Selection = { kind: 'node' } | { kind: 'v86', image: string }

/** One machine the setting can offer. */
interface Guest {
  id: string
  name: string
  console: string
  summary: string
  bundled: boolean
  transfer: number
  boots?: string
  /**
   * Every file it boots from, with the v86 slot each one fills and whether
   * this deployment already knows where to get it.
   */
  files: { slot: string, file: string, held: boolean }[]
  /** A 9p tree it needs, when its root is one; no local file can be one. */
  filesystem?: string
}

/** One image kept in this browser. */
interface StoredDisk { guest: string, slot: string, name: string, size: number }

/** What the machine is doing right now. */
interface Status {
  emulated: boolean
  guest?: string
  started: boolean
  running: boolean
  failure?: string
  unsupported?: string
}

/** The capability the app publishes about the machine. */
interface MachineBridge {
  selection(): Selection
  select(next: Selection): void
  guests(): Guest[]
  imageHost(): string
  setImageHost(url: string): void
  hosts: { default: string, upstream: string }
  disks(): Promise<StoredDisk[]>
  storeDisk(guest: string, slot: string, file: File): Promise<void>
  forgetDisk(guest: string, slot: string): Promise<void>
  status(): Status
  boot(onProgress?: (step: string) => void): Promise<void>
  adoptScreen(host: HTMLElement): Promise<() => void>
  key(code: string, down: boolean): boolean
  pointer(): { enabled: boolean, absolute: boolean }
  restart(): Promise<void>
}

/** The capability the app publishes for whoever draws a terminal. */
interface RuntimeBridge {
  startShell(size: { cols: number, rows: number }): Promise<{
    output: ReadableStream<string>
    input: WritableStream<string>
    exit: Promise<number>
    resize(size: { cols: number, rows: number }): void
  }>
  boot(onProgress?: (step: string) => void): Promise<unknown>
  unavailable(): string | undefined
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

/** Read the machine bridge the app published. */
function machineBridge(): MachineBridge | undefined {
  return (globalThis as Record<string, unknown>).__DSH_WEB_MACHINE__ as MachineBridge | undefined
}

/** Read the runtime bridge the app published. */
function runtimeBridge(): RuntimeBridge | undefined {
  return (globalThis as Record<string, unknown>).__DSH_WEB_RUNTIME__ as RuntimeBridge | undefined
}

/** Bytes as a size a person reads. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/** What a guest's console means, in one word the setting can show as a tag. */
function consoleLabel(kind: string): string {
  if (kind === 'serial') return 'shell'
  if (kind === 'dos') return 'DOS prompt'
  return 'graphical'
}

/** The machine the session is on, named the way the panel's bar names it. */
function runningName(active: Selection, guests: Guest[]): string {
  if (active.kind === 'node') return 'Node container'
  return guests.find(guest => guest.id === active.image)?.name ?? active.image
}

/* ── the emulated machine's screen ─────────────────────────────────────── */

/**
 * The machine's own screen, borrowed from the page and scaled to the panel.
 *
 * Borrowed, not created: the emulator draws into one element for the life of
 * the page, because the agent drives the machine whether or not this panel is
 * open. Mounting takes it out of its parking spot and unmounting puts it back,
 * and forgetting the second half would take the machine's display out of the
 * document — and every screenshot the agent takes afterwards with it.
 *
 * Scaled with a transform rather than by resizing anything. The guest owns its
 * resolution and the emulator owns the canvas; what this component owns is how
 * much of the panel that canvas covers, which is a question about the window
 * and not about the machine. A transform also leaves `screen_make_screenshot`
 * alone — the agent photographs the guest's real pixels, not the ones a viewer
 * happens to be looking at.
 */
function Screen({ guestName }: { guestName: string }): JSX.Element {
  const stage = useRef<HTMLDivElement | null>(null)
  const scaler = useRef<HTMLDivElement | null>(null)
  const [step, setStep] = useState<string>('Starting the machine…')
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [focused, setFocused] = useState(false)
  const [full, setFull] = useState(false)
  const [scale, setScale] = useState(1)
  const [pointer, setPointer] = useState({ enabled: false, absolute: false })
  const [locked, setLocked] = useState(false)

  /**
   * Match the screen to the box it is in.
   *
   * The natural size has to be read with the transform off, because a scaled
   * element still reports its scaled rectangle — measuring through the last
   * scale would compound it on every resize and walk the screen down to
   * nothing.
   */
  const fit = useCallback(() => {
    const box = stage.current
    const inner = scaler.current
    const screen = inner?.firstElementChild
    if (box === null || inner === null || !(screen instanceof HTMLElement)) return
    inner.style.transform = 'none'
    const natural = screen.getBoundingClientRect()
    if (natural.width < 1 || natural.height < 1) return
    const next = Math.min(box.clientWidth / natural.width, box.clientHeight / natural.height)
    const clamped = Number.isFinite(next) && next > 0 ? next : 1
    inner.style.transform = `scale(${String(clamped)})`
    setScale(clamped)
  }, [])

  useEffect(() => {
    const machine = machineBridge()
    if (machine === undefined || scaler.current === null) return
    let release: (() => void) | undefined
    let gone = false
    void (async () => {
      try {
        await machine.boot(next => { if (!gone) setStep(next) })
        if (gone || scaler.current === null) return
        const disposer = await machine.adoptScreen(scaler.current)
        // Checked again after the await, not before it: a panel closed while
        // `adoptScreen` was in flight would otherwise leave the machine's
        // screen inside a detached element, and every screenshot after it
        // photographing something no longer in the document.
        if (gone) {
          disposer()
          return
        }
        release = disposer
        setStep('')
        fit()
      } catch (error) {
        if (!gone) setFailed(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      gone = true
      release?.()
    }
  }, [fit])

  // Whether the guest is drawing a cursor, and of which kind, is the guest's
  // decision and it makes it while running — a DOS prompt has no pointer, and
  // the desktop it starts a minute later does. There is no event for it on the
  // bridge, so it is asked for: twice a second, which is far below what a
  // person notices and far above what a property read costs.
  useEffect(() => {
    const read = (): void => {
      const machine = machineBridge()
      if (machine === undefined) return
      const next = machine.pointer()
      setPointer(previous =>
        previous.enabled === next.enabled && previous.absolute === next.absolute ? previous : next)
    }
    read()
    const timer = setInterval(read, 500)
    return () => { clearInterval(timer) }
  }, [])

  useEffect(() => {
    const onChange = (): void => { setLocked(document.pointerLockElement === scaler.current) }
    document.addEventListener('pointerlockchange', onChange)
    return () => { document.removeEventListener('pointerlockchange', onChange) }
  }, [])

  // Two things change the fit and neither is a render: the window, and the
  // guest changing video mode. A DOS box that starts a graphical program swaps
  // 720×400 for 640×480 under a panel that is not re-rendering, so the screen
  // and the elements it draws into are watched, not only the box around them.
  //
  // Watched by size, deliberately, and never by attribute. `fit` writes a
  // transform, a transform is a style attribute, and an observer that woke on
  // style changes woke on its own writes — a loop that pinned the tab. A
  // resize observation cannot do that: a transform does not change the box
  // being observed.
  useEffect(() => {
    const box = stage.current
    const inner = scaler.current
    if (box === null || inner === null) return
    const sizes = new ResizeObserver(() => { fit() })
    sizes.observe(box)
    const observeScreen = (): void => {
      const screen = inner.firstElementChild
      if (!(screen instanceof HTMLElement)) return
      sizes.observe(screen)
      // v86 draws text mode into one element and graphical mode into another,
      // and swaps which is displayed; each has its own size to follow.
      for (const child of Array.from(screen.children)) if (child instanceof HTMLElement) sizes.observe(child)
    }
    observeScreen()
    const arrivals = new MutationObserver(() => {
      observeScreen()
      fit()
    })
    arrivals.observe(inner, { childList: true, subtree: true })
    return () => {
      sizes.disconnect()
      arrivals.disconnect()
    }
  }, [fit])

  useEffect(() => {
    const onChange = (): void => {
      setFull(document.fullscreenElement === stage.current)
      // The box changes size after the event, not with it.
      requestAnimationFrame(fit)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => { document.removeEventListener('fullscreenchange', onChange) }
  }, [fit])

  const toggleFull = useCallback(() => {
    const box = stage.current
    if (box === null) return
    if (document.fullscreenElement === box) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    void box.requestFullscreen().then(
      () => { scaler.current?.focus() },
      () => undefined,
    )
  }, [])

  // The emulator installs no keyboard listener of its own, so this is the whole
  // of the guest's keyboard: events on this element, while it has focus, and
  // nothing else. `code` rather than `key` because a scan code is a physical
  // key — what the guest wants to know is which key moved, not what the host's
  // layout thinks it means.
  const onKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const machine = machineBridge()
    if (machine === undefined) return
    if (machine.key(event.nativeEvent.code, event.type === 'keydown')) event.preventDefault()
  }, [])

  if (failed !== undefined) return <p className="dsh-web-machine-notice">{failed}</p>

  // One cursor, not two. There are two ways to get there and which one is
  // available is the guest's choice, not this panel's:
  //
  // - A guest whose driver reads the VMware backdoor port is told *where* the
  //   pointer is, so its cursor is already exactly under the real one. v86
  //   hides the host cursor itself when that happens; `data-owned` is this
  //   panel agreeing rather than fighting it, because the element v86 writes
  //   that style on is the one inside this scaler.
  // - Every other guest gets a PS/2 mouse, which reports movement. Where its
  //   cursor ends up is then its own driver's arithmetic — two pixels per unit
  //   on Windows 3.1, measured — and no amount of care here makes the two
  //   cursors coincide. Pointer lock is the honest answer: the browser takes
  //   the real cursor away entirely and hands over raw movement, so the
  //   guest's cursor is the only one on the screen and it is under your hand
  //   by definition. Escape gives it back, and the browser guarantees that.
  const owned = pointer.enabled && pointer.absolute
  const lockable = pointer.enabled && !pointer.absolute
  const grab = useCallback(() => {
    scaler.current?.focus()
    if (!lockable || document.pointerLockElement !== null) return
    // Not awaited and not reported: a browser that refuses the lock (no user
    // gesture, or the user pressed Escape moments ago) leaves the panel
    // working exactly as it did before pointer lock existed.
    void Promise.resolve(scaler.current?.requestPointerLock() as unknown).catch(() => undefined)
  }, [lockable])

  return (
    <div className="dsh-web-machine-stage" ref={stage}>
      <div
        className="dsh-web-machine-screen"
        {...(focused ? { 'data-focused': '' } : {})}
        {...(owned || locked ? { 'data-owned': '' } : {})}
        ref={scaler}
        tabIndex={0}
        role="application"
        aria-label={`${guestName}: the machine's screen`}
        onFocus={() => { setFocused(true) }}
        onBlur={() => { setFocused(false) }}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onClick={grab}
      />
      <div className="dsh-web-machine-overlay">
        {step === ''
          ? <span className="dsh-web-machine-zoom">{`${String(Math.round(scale * 100))}%`}</span>
          : <span className="dsh-web-machine-step">{step}</span>}
        <span className="dsh-web-machine-hint">
          {locked
            ? 'The mouse and keyboard are going to the machine. Press Escape to get them back.'
            : lockable
              ? 'Click the screen to give the machine the mouse and keyboard.'
              : focused
                ? 'The keyboard is going to the machine. Click outside to give it back.'
                : 'Click the screen to type at the machine.'}
        </span>
        <button type="button" onClick={toggleFull}>{full ? 'Leave full screen' : 'Full screen'}</button>
      </div>
    </div>
  )
}

/* ── the container's terminal ──────────────────────────────────────────── */

/**
 * The colours the surface actually resolved to, for a widget that paints its own.
 *
 * Computed rather than declared: the panel's background is a theme token with
 * a system-colour fallback, so the only way to know what it came out as is to
 * ask the element. A cursor colour is not something the surface publishes, so
 * that one stays a choice — a green that reads on either end of the range.
 * @param element - the panel itself, which is the element carrying the colours.
 * @returns an xterm theme.
 */
function surfaceColours(element: Element | null): { background: string, foreground: string, cursor: string } {
  const fallback = { background: '#0d1017', foreground: '#dfe3ea', cursor: '#7fd1a0' }
  if (element === null) return fallback
  const style = getComputedStyle(element)
  const background = style.backgroundColor
  const foreground = style.color
  // A transparent background is the element not having one of its own, which
  // tells us nothing about what is behind it.
  if (background === '' || background === 'transparent' || background.startsWith('rgba(0, 0, 0, 0')) return fallback
  return { background, foreground: foreground === '' ? fallback.foreground : foreground, cursor: fallback.cursor }
}

/** The Node container's console, which is a terminal. */
function TerminalScreen({ open }: { open: boolean }): JSX.Element {
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
    const runtime = runtimeBridge()
    if (runtime === undefined) {
      setMessage('The runtime bridge is not available in this build.')
      return
    }
    // The whole message, not a fragment: there is more than one reason a
    // terminal cannot open here — a browser that cannot be cross-origin
    // isolated, or a machine whose console is its own screen — and only the app
    // knows which one applies. A panel that appended its own paragraph about
    // `SharedArrayBuffer` told half its readers to fix the wrong thing.
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
      if (document.getElementById('dsh-web-machine-xterm-style') === null) {
        const style = document.createElement('style')
        style.id = 'dsh-web-machine-xterm-style'
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
        // Read off the panel this terminal is inside rather than written down
        // here. xterm paints its own background, so a hard-coded dark pair was
        // a black rectangle in a light panel; asking the element what colour it
        // ended up means the terminal follows the theme for free, including
        // themes this build has never seen.
        theme: surfaceColours(host.current?.closest('.dsh-web-machine') ?? null),
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

      terminal.write(`${ESC}[38;5;108mStarting the runtime…${ESC}[0m\r\n`)
      let writer: WritableStreamDefaultWriter<string> | undefined
      try {
        await runtime.boot(step => { terminal!.write(`${ESC}[38;5;244m${step}…${ESC}[0m\r\n`) })
        const shell = await runtime.startShell({ cols: terminal.cols, rows: terminal.rows })
        void shell.output.pipeTo(new WritableStream<string>({
          write(chunk) { terminal!.write(chunk) },
        })).catch(() => undefined)
        writer = shell.input.getWriter()
        terminal.onData(data => { void writer?.write(data) })
        terminal.onResize(grid => { shell.resize(grid) })
        const resize = (): void => { fit.fit() }
        window.addEventListener('resize', resize)
        await shell.exit
        window.removeEventListener('resize', resize)
        terminal.write(`\r\n${ESC}[38;5;244m[the shell exited — reload to start a new one]${ESC}[0m\r\n`)
      } catch (error) {
        terminal.write(`\r\n${ESC}[31m${error instanceof Error ? error.message : String(error)}${ESC}[0m\r\n`)
        started.current = false
      }
    })()
  }, [open])

  return message === undefined
    ? <div className="dsh-web-machine-terminal" ref={host} />
    : <p className="dsh-web-machine-notice">{message}</p>
}

/* ── the panel ─────────────────────────────────────────────────────────── */

/** The panel, drawn into the surface's shell overlay. */
function MachinePanel({ open, onClose }: { open: boolean, onClose: () => void }): JSX.Element {
  const machine = machineBridge()
  const active = machine?.selection() ?? { kind: 'node' as const }
  const guests = machine?.guests() ?? []
  const status = machine?.status()
  const emulated = active.kind === 'v86'

  // Hidden rather than unmounted. Closing used to drop the element, which took
  // the terminal with it while the started guard stayed true — so the next open
  // drew nothing at all. Keeping it mounted fixes that and buys the behaviour a
  // console is supposed to have: the session, its scrollback and its working
  // directory are still there when it comes back.
  return (
    <div
      className="dsh-web-machine"
      {...(emulated ? { 'data-emulated': '' } : {})}
      {...(open ? { 'data-open': '' } : { hidden: true })}
    >
      <div className="dsh-web-machine-bar">
        <span className="dsh-web-machine-title">Machine</span>
        <span className="dsh-web-machine-now">{runningName(active, guests)}</span>
        {emulated && status?.running === true && (
          <button type="button" onClick={() => { void machine?.restart().then(() => { location.reload() }) }}>
            Restart
          </button>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {/* Only while the panel is showing. The screen is the app's element, not
          this component's, and a closed panel is `display: none` — an element
          with no box, which is the one state the emulator's screen adapter
          cannot measure. Unmounting hands it back to its parking spot, where it
          keeps being drawn into and keeps photographing. */}
      {emulated
        ? (open && <Screen guestName={runningName(active, guests)} />)
        : <TerminalScreen open={open} />}
    </div>
  )
}

/* ── the setting ───────────────────────────────────────────────────────── */

/** One row in the machine list. */
function MachineRow({
  title, detail, tags, chosen, onChoose, action, children,
}: {
  title: string
  detail: string
  tags: string[]
  chosen: boolean
  onChoose: () => void
  /** What to do about this machine, shown inside the row it belongs to. */
  action?: JSX.Element | false
  children?: JSX.Element | false
}): JSX.Element {
  return (
    <div className="dsh-web-machine-row" {...(chosen ? { 'data-chosen': '' } : {})}>
      <button type="button" className="dsh-web-machine-pick" onClick={onChoose} aria-pressed={chosen}>
        <span className="dsh-web-machine-name">{title}</span>
        <span className="dsh-web-machine-tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</span>
        <span className="dsh-web-machine-detail">{detail}</span>
      </button>
      {action}
      {children}
    </div>
  )
}

/** The Settings page that chooses the machine. */
function MachineSettings(): JSX.Element {
  const machine = machineBridge()
  const [chosen, setChosen] = useState<Selection>(() => machine?.selection() ?? { kind: 'node' })
  const [disks, setDisks] = useState<StoredDisk[]>([])
  const [host, setHost] = useState<string>(() => machine?.imageHost() ?? '')
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const active = machine?.selection() ?? { kind: 'node' as const }
  const guests = machine?.guests() ?? []

  const refreshDisks = useCallback(() => {
    void machine?.disks().then(setDisks).catch(() => undefined)
  }, [machine])
  useEffect(() => { refreshDisks() }, [refreshDisks])

  const choose = useCallback((next: Selection) => {
    setChosen(next)
    setSaved(false)
  }, [])

  const apply = useCallback(() => {
    machine?.select(chosen)
    if (host.trim() !== '') machine?.setImageHost(host.trim())
    setSaved(true)
  }, [machine, chosen, host])

  const openDisk = useCallback(async (guest: string, slot: string, file: File | undefined) => {
    if (file === undefined || machine === undefined) return
    setProblem(undefined)
    try {
      await machine.storeDisk(guest, slot, file)
    } catch (error) {
      // Storing a 300 MB file is the one thing here a browser refuses outright
      // — a private window has no quota to give — and a file input that
      // silently did nothing would look like a bug in the disk.
      setProblem(`${file.name} could not be kept: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    refreshDisks()
  }, [machine, refreshDisks])

  const same = active.kind === chosen.kind
    && (active.kind !== 'v86' || chosen.kind !== 'v86' || active.image === chosen.image)
  // The host is savable on its own: someone who has already chosen a machine
  // and is now pointing it at a mirror is not changing machines, and a button
  // that goes grey on them is a setting they cannot save. Compared with the
  // trailing slash the setter adds, so saving twice does not leave it enabled.
  const storedHost = machine?.imageHost() ?? ''
  const typedHost = host.trim() === '' ? '' : host.trim().endsWith('/') ? host.trim() : `${host.trim()}/`
  const hostChanged = typedHost !== '' && typedHost !== storedHost

  const savedNote = (
    <span>
      Saved. It applies on the next load —{' '}
      <button type="button" className="dsh-web-machine-link" onClick={() => { location.reload() }}>
        reload now
      </button>
      .
    </span>
  )

  /**
   * The one thing to do about the machine that is selected and not running.
   *
   * Rendered inside that machine's own row rather than at the top of the page.
   * A button that lives above a list of twelve dozen rows is a button whose
   * subject you have to remember scrolling past; one that appears in the row
   * you just clicked says what it applies to by being there.
   * @param chosenHere - whether this row is the selected one.
   * @returns the action, or false when this row has nothing to offer.
   */
  const rowAction = (chosenHere: boolean): JSX.Element | false => chosenHere && !same && (
    <div className="dsh-web-machine-apply">
      <button type="button" onClick={apply}>Use this machine</button>
      {saved && savedNote}
    </div>
  )

  return (
    <div className="dsh-web-machine-settings">
      <h3>Machine</h3>
      <p className="dsh-web-machine-lede">
        One session runs on one machine, and which one decides what tools the assistant is given and what
        the Machine panel shows — a terminal for the container, a screen for an emulated PC. A change
        applies the next time this page loads. This session is on{' '}
        <strong>{runningName(active, guests)}</strong>.
      </p>

      <MachineRow
        title="Node container"
        detail="WebContainers: Node 22, npm, a real CPython with pip, and a POSIX filesystem shared with the assistant's file tools. The default."
        tags={['terminal', 'nothing to download']}
        chosen={chosen.kind === 'node'}
        onChoose={() => { choose({ kind: 'node' }) }}
        action={rowAction(chosen.kind === 'node')}
      />

      {guests.map((guest) => {
        const opened = disks.filter(disk => disk.guest === guest.id)
        const openedFor = (slot: string): StoredDisk | undefined => opened.find(
          // A row an earlier version stored carries no slot, and was always the
          // guest's boot image — which is the first file it declares.
          disk => disk.slot === slot || (disk.slot === '' && guest.files[0]?.slot === slot),
        )
        // Ready when every file has a source. A tree is never one of them: no
        // file input can supply a directory the guest reads over the network.
        const supplied = guest.files.every(entry => openedFor(entry.slot) !== undefined)
        const ready = guest.bundled || (supplied && guest.filesystem === undefined)
        const bytes = opened.reduce((sum, disk) => sum + disk.size, 0)
        return (
          <MachineRow
            key={guest.id}
            title={guest.name}
            detail={guest.boots === undefined ? guest.summary : `${guest.summary} Boots in ${guest.boots}.`}
            tags={[
              consoleLabel(guest.console),
              opened.length === 0 ? size(guest.transfer) : `${size(bytes)} on this device`,
              ...(ready ? [] : ['needs a disk']),
            ]}
            chosen={chosen.kind === 'v86' && chosen.image === guest.id}
            onChoose={() => { choose({ kind: 'v86', image: guest.id }) }}
            action={rowAction(chosen.kind === 'v86' && chosen.image === guest.id)}
          >
            {/* The row you picked, the ones that cannot start without you, and
                the ones you have already given a disk to. Not every row: a file
                input under all hundred and twenty-eight would bury the list.
                Not only the ones that need a disk either — opening your own is
                a reasonable thing to want for a machine that boots perfectly
                well on its own, a copy with your files on it or a different
                build, and that was unreachable for the eighty-seven that do. */}
            {(!guest.bundled || opened.length > 0 || (chosen.kind === 'v86' && chosen.image === guest.id)) && (
              <div className="dsh-web-machine-disk">
                {guest.filesystem !== undefined && (
                  <span className="dsh-web-machine-tree">
                    {guest.name} reads its root filesystem from <code>{guest.filesystem}</code> on the image host,
                    one file at a time — a directory, not an image, so opening a file cannot supply it. This
                    machine needs an image host that serves that tree.
                  </span>
                )}
                {/* One input per file the guest boots from. A machine that
                    needs a disk *and* a saved machine can be given both, which
                    is the difference between resuming in two seconds and cold
                    booting for ten minutes — and for a guest whose only image
                    is a saved machine, the difference between running and not. */}
                {guest.files.map((entry) => {
                  const stored = openedFor(entry.slot)
                  return (
                    <div className="dsh-web-machine-file" key={entry.slot}>
                      {stored === undefined
                        ? (
                            <>
                              <span>
                                <code>{entry.file}</code> — {entry.held
                                  ? 'fetched for you when this machine starts. Open your own copy instead:'
                                  : 'not on the default image host. Point the image host below at one that has it, or open it from this computer:'}
                              </span>
                              <input
                                type="file"
                                aria-label={guest.files.length === 1
                                  ? `Disk image for ${guest.name}`
                                  : `${entry.file} for ${guest.name}`}
                                onChange={(event) => { void openDisk(guest.id, entry.slot, event.currentTarget.files?.[0]) }}
                              />
                            </>
                          )
                        : (
                            <>
                              <span>
                                <code>{entry.file}</code> — using {stored.name} from this computer
                                ({size(stored.size)}), kept in this browser.
                              </span>
                              <button
                                type="button"
                                onClick={() => { void machine?.forgetDisk(guest.id, entry.slot).then(refreshDisks) }}
                              >
                                Forget it
                              </button>
                            </>
                          )}
                    </div>
                  )
                })}
              </div>
            )}
          </MachineRow>
        )
      })}

      <h3>Image host</h3>
      <p className="dsh-web-machine-lede">
        Where disk images are fetched from. The default is the v86 project&apos;s public image repository,
        which serves the machines above that need no setup. v86&apos;s own demo serves the rest from{' '}
        <code>{machine?.hosts.upstream}</code>, which refuses requests from anywhere but <code>copy.sh</code>{' '}
        — so pointing at it only works if that is where you are. A mirror of your own works too.
      </p>
      <div className="dsh-web-machine-host">
        <input
          type="url"
          value={host}
          spellCheck={false}
          placeholder={machine?.hosts.default}
          aria-label="Image host"
          onChange={(event) => { setHost(event.currentTarget.value) }}
        />
        <button type="button" onClick={() => { setHost(machine?.hosts.default ?? '') }}>Default</button>
      </div>

      {problem !== undefined && <p className="dsh-web-machine-problem">{problem}</p>}

      {same && (
        <div className="dsh-web-machine-apply" data-end>
          <button type="button" disabled={!hostChanged} onClick={apply}>Save image host</button>
          {saved && savedNote}
        </div>
      )}
    </div>
  )
}

/* ── the sidebar row ───────────────────────────────────────────────────── */

/**
 * A tower with a prompt on it, in the outline language the sidebar's icons use.
 * @param props - `className` when the glyph is borrowed by a surface with its
 * own layout rules for it, such as the Settings nav.
 */
function MachineIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className ?? 'dsh-web-machine-action-icon'} width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <rect x="1.6" y="3" width="12.8" height="8.4" rx="1.6" />
      <path d="M5.6 13.6h4.8" />
      <path d="M8 11.4v2.2" />
      <path d="M4.9 6.2 6.4 7.3 4.9 8.4" />
      <path d="M8.1 8.8h3.1" />
    </svg>
  )
}

/**
 * Claim the Settings nav glyph for one section.
 *
 * The table is on `globalThis` rather than in a slot because the shell reads
 * it from inside its own bundle, which knows nothing about this plugin; see
 * `scripts/assemble.ts`. Writing a key nobody reads is harmless, so this stays
 * correct on a build where the seam is absent — the section keeps the gear.
 * @param id - the `settings.section` id this glyph belongs to.
 * @param draw - the glyph, given the class the shell lays its icons out with.
 */
function navGlyph(id: string, draw: (className: string) => JSX.Element): void {
  const table = globalThis as { __DSH_SETTINGS_NAV_ICON__?: Record<string, (className: string) => JSX.Element> }
  table.__DSH_SETTINGS_NAV_ICON__ ??= {}
  table.__DSH_SETTINGS_NAV_ICON__[id] = draw
}

/** The sidebar footer action that opens it. */
function MachineAction({ open, onToggle, wide }: { open: boolean, onToggle: () => void, wide: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="dsh-web-machine-action"
      {...(wide ? {} : { 'data-rail': '' })}
      {...(open ? { 'data-open': '' } : {})}
      aria-expanded={open}
      // Not just "Machine": the Settings page that chooses the machine is
      // called that too, and two different controls answering to one name is
      // ambiguous to a screen reader and to anything driving the page.
      aria-label="Machine panel"
      onClick={onToggle}
      title="Show the machine this session runs on (Ctrl+`)"
    >
      <MachineIcon />
      {wide && <span className="dsh-web-machine-action-label">Machine</span>}
    </button>
  )
}

const STYLE = `
/* Colours from the surface's own tokens, with the system pair underneath.
   The literals that were here — a near-black panel and a pale grey type —
   made this the one surface in the app that stayed dark when the theme went
   light. Canvas and CanvasText are the browser's own pair and they move
   together, so a token this deployment's theme happens not to define still
   lands on a background and a foreground that belong to each other. */
.dsh-web-machine[hidden]{display:none}
.dsh-web-machine{position:fixed;left:0;right:0;bottom:0;height:min(52vh,32rem);z-index:60;display:flex;
 flex-direction:column;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
 border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 -8px 32px rgba(0,0,0,.18)}
.dsh-web-machine[data-emulated]{height:min(72vh,44rem)}

/* Which edge it comes in from follows the shape of the window rather than a
   guess about the device. A landscape window has height to spare and width to
   lose, so a full-height column on the right leaves the conversation readable
   beside it; a portrait one — a phone, a split screen — has the opposite
   problem, and a drawer along the bottom is the only shape that fits. The
   breakpoint is an aspect ratio and a floor, because a narrow landscape window
   is still narrow. */
@media (min-aspect-ratio: 1/1) and (min-width: 60rem) {
  .dsh-web-machine{left:auto;top:0;bottom:0;height:auto;width:min(46vw,54rem);
   border-top:0;border-left:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));
   box-shadow:-8px 0 32px rgba(0,0,0,.18)}
  .dsh-web-machine[data-emulated]{height:auto;width:min(58vw,68rem)}
}

.dsh-web-machine-bar{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;flex:none;
 color:var(--dsw-alias-label-primary,CanvasText);
 border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
 font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-web-machine-title{font-weight:600}
.dsh-web-machine-now{opacity:.55;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-machine-bar button{font:inherit;background:transparent;color:inherit;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:.35rem;padding:.15rem .5rem}
.dsh-web-machine-bar button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-machine-terminal{flex:1;min-height:0;padding:.35rem .5rem}
.dsh-web-machine-notice{padding:1rem;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;
 color:var(--dsw-alias-label-secondary,inherit);opacity:.85}

/* The screen, and the box it is fitted into. Grid rather than flex so a screen
   larger than the box still centres on it — the transform brings it back
   inside, and a flex item that overflows is clipped from one side only. */
.dsh-web-machine-stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;background:#000}
.dsh-web-machine-screen{transform-origin:center center;line-height:0;outline:none;
 box-shadow:0 0 0 2px transparent;transition:box-shadow .12s}
.dsh-web-machine-screen[data-focused]{box-shadow:0 0 0 2px var(--dsw-alias-border-focus,#2f81f7)}
/* The guest is drawing the cursor, or the browser has taken it away: either
   way there is exactly one pointer on this screen and it is not the host's.
   The rule is on the scaler as well as v86's own container because the
   transform gives this element a box of its own, and a hair of it can stick
   out past the picture. */
.dsh-web-machine-screen[data-owned],.dsh-web-machine-screen[data-owned] *{cursor:none}
/* Nearest-neighbour: every guest here draws pixels that mean something at
   their own size, and a smoothing filter over a DOS text screen is a blurred
   DOS text screen. */
.dsh-web-machine-screen canvas,.dsh-web-machine-screen img{image-rendering:pixelated}
.dsh-web-machine-overlay{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:.6rem;
 padding:.3rem .6rem;background:linear-gradient(transparent,rgba(0,0,0,.72));color:#dfe3ea;
 font:11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:none}
.dsh-web-machine-overlay button{pointer-events:auto;font:inherit;background:rgba(0,0,0,.45);
 border:1px solid rgba(255,255,255,.35);color:inherit;border-radius:.35rem;padding:.15rem .5rem;cursor:pointer}
.dsh-web-machine-hint{flex:1;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-machine-step,.dsh-web-machine-zoom{opacity:.75;font-variant-numeric:tabular-nums}

/* The Settings page. */
.dsh-web-machine-settings{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
 color:var(--dsw-alias-label-primary,inherit)}
.dsh-web-machine-settings h3{margin:1.4rem 0 .4rem;font-size:13px;letter-spacing:.02em;text-transform:uppercase;opacity:.6}
.dsh-web-machine-settings h3:first-child{margin-top:0}
.dsh-web-machine-lede{margin:0 0 .7rem;opacity:.72;max-width:52rem}
.dsh-web-machine-lede code{font-size:12px;opacity:.9}
.dsh-web-machine-row{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:.5rem;
 margin-bottom:.4rem;overflow:hidden}
.dsh-web-machine-row[data-chosen]{border-color:var(--dsw-alias-border-focus,#2f81f7)}
.dsh-web-machine-pick{display:grid;grid-template-columns:minmax(9rem,auto) 1fr;gap:.15rem .75rem;width:100%;
 text-align:left;background:0 0;border:0;color:inherit;font:inherit;padding:.6rem .75rem;cursor:pointer}
.dsh-web-machine-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsh-web-machine-name{font-weight:600}
.dsh-web-machine-tags{display:flex;gap:.35rem;flex-wrap:wrap;justify-self:start}
.dsh-web-machine-tags span{font-size:11px;padding:.05rem .4rem;border-radius:.6rem;opacity:.75;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.dsh-web-machine-detail{grid-column:1/-1;opacity:.7}
.dsh-web-machine-disk{display:flex;flex-direction:column;gap:.45rem;padding:.5rem .75rem;font-size:12px;
 opacity:.85;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.dsh-web-machine-file{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.dsh-web-machine-file span{flex:1;min-width:16rem}
.dsh-web-machine-tree{display:block}
.dsh-web-machine-problem{margin:.8rem 0 0;color:var(--dsw-alias-label-danger,#f5a3a3)}
.dsh-web-machine-host{display:flex;gap:.5rem;align-items:center}
.dsh-web-machine-host input{flex:1;font:inherit;padding:.3rem .5rem;border-radius:.35rem;background:transparent;
 color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}
.dsh-web-machine-apply{display:flex;align-items:center;flex-wrap:wrap;gap:.7rem;padding:.5rem .75rem;
 border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.dsh-web-machine-apply[data-end]{margin:1.4rem 0 0;padding:0;border-top:0}
.dsh-web-machine-apply button,.dsh-web-machine-disk button,.dsh-web-machine-host button{font:inherit;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;
 border-radius:.35rem;padding:.3rem .7rem}
.dsh-web-machine-apply button:disabled{opacity:.4;cursor:default}
.dsh-web-machine-link{border:0!important;padding:0!important;text-decoration:underline;background:0 0;color:inherit;
 font:inherit;cursor:pointer}

/* The sidebar row, in the shape the sidebar's Settings row already has. */
.dsh-web-machine-action{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 calc(100% + 8px);
 width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:none;border-radius:12px;
 background:0 0;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;
 cursor:pointer;overflow:hidden}
.dsh-web-machine-action:hover,.dsh-web-machine-action[data-open]{
 background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-machine-action-icon{flex:none}
.dsh-web-machine-action-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-web-machine-action[data-rail]{flex:0 0 36px;justify-content:center;gap:0;width:36px;height:36px;
 margin:4px 0;padding:0;border-radius:50%}
/* The foot's action line is one nowrap row, so a second action would sit beside
   this one. Opening the line is what puts each action on a row of its own —
   the two shapes cover the slot renderer's wrapper being present or not, and
   nothing else in the tree has this element as a child or grandchild. */
:has(> .dsh-web-machine-action),:has(> * > .dsh-web-machine-action){flex-wrap:wrap}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-machine-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-machine-chrome'
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
    register(options: { name: string, id?: string, order?: number, label?: () => string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'web-machine' },
    function Overlay(): JSX.Element {
      const isOpen = useOpen()
      const close = useCallback(() => { setOpen(false) }, [])
      return (
        <div data-dsh-web-machine-slot="">
          <MachinePanel open={isOpen} onClose={close} />
        </div>
      )
    },
  ))

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-machine' },
    function Action({ wide }: { wide: boolean }): JSX.Element {
      const isOpen = useOpen()
      const toggle = useCallback(() => { setOpen(!open) }, [])
      return <MachineAction open={isOpen} onToggle={toggle} wide={wide} />
    },
  ))

  // Where the choice lives: Settings, with the rest of what this deployment can
  // be told to do. Between Models (order 10) and Plugins (15), because those
  // three are the same kind of decision in descending order of consequence —
  // which machine this runs on decides which tools exist at all.
  //
  // The glyph goes in beside the label, through the seam `scripts/assemble.ts`
  // cuts into the settings shell: a section that does not claim one gets the
  // settings gear, and a nav column where Machine, Network and General are all
  // the same gear says the three rows are the same kind of thing.
  navGlyph('machine', className => <MachineIcon className={className} />)
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'machine', order: 12, label: () => 'Machine' },
    MachineSettings,
  ))

  // The surface has no shortcut of its own for this, and a console without one
  // is a console people forget is there.
  const onKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey && event.key === '`') {
      setOpen(!open)
      event.preventDefault()
    }
  }
  window.addEventListener('keydown', onKey)

  // The same control surface the files panel publishes, for the same two
  // readers: an automated browser, and anything in the page that wants it.
  ;(globalThis as Record<string, unknown>).__DSH_MACHINE_PANEL__ = {
    open: () => { setOpen(true) },
    close: () => { setOpen(false) },
    isOpen: () => open,
  }

  ctx.on('dispose', () => { window.removeEventListener('keydown', onKey) })
}

export default { apply, inject }
