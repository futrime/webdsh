/**
 * The runtime picker's browser half.
 *
 * Two jobs, and they are the same job seen from either end: say which machine
 * this session is running on, and let someone change it. When that machine is
 * an emulated PC the panel is also its screen — the real one, borrowed from the
 * page rather than a second copy, so what the agent types appears here and what
 * is typed here the agent sees.
 *
 * An ordinary client plugin: a footer action in the sidebar and a panel in the
 * shell overlay, both through the surface's own slots, wearing the shapes the
 * sidebar's own rows have. Nothing about the surface is modified to make room.
 *
 * The one thing worth knowing before reading it: **the choice applies on the
 * next load.** It has to. Which machine a session runs on decides which tools
 * the model is offered, and a tool registry that changes mid-session is a
 * session where the model was told about a shell that is no longer there. The
 * panel says so where the choice is made rather than pretending otherwise —
 * the same contract, and the same wording, the plugin installer already uses.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** What the session runs on. */
type Selection = { kind: 'node' } | { kind: 'v86', image: string }

/** One machine the picker can offer. */
interface Guest {
  id: string
  name: string
  console: string
  summary: string
  bundled: boolean
  transfer: number
  boots: string
  files: string[]
}

/** One disk image kept in this browser. */
interface StoredDisk { guest: string, name: string, size: number }

/** What the machine is doing right now. */
interface Status {
  emulated: boolean
  guest?: string
  started: boolean
  running: boolean
  failure?: string
  unsupported?: string
}

/** The capability the app publishes for whoever draws this. */
interface MachineBridge {
  selection(): Selection
  select(next: Selection): void
  guests(): Guest[]
  imageHost(): string
  setImageHost(url: string): void
  hosts: { default: string, upstream: string }
  disks(): Promise<StoredDisk[]>
  storeDisk(guest: string, file: File): Promise<void>
  forgetDisk(guest: string): Promise<void>
  status(): Status
  boot(onProgress?: (step: string) => void): Promise<void>
  adoptScreen(host: HTMLElement): Promise<() => void>
  key(code: string, down: boolean): boolean
  restart(): Promise<void>
}

/** Where the app publishes it. */
const BRIDGE = '__DSH_WEB_MACHINE__'

/** Read the bridge the app published. */
function bridge(): MachineBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE] as MachineBridge | undefined
}

/** Bytes as a size a person reads. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/** What a guest's console means, in one word the picker can show as a tag. */
function consoleLabel(kind: string): string {
  if (kind === 'serial') return 'shell'
  if (kind === 'dos') return 'DOS prompt'
  return 'graphical'
}

/**
 * The machine's own screen, borrowed from the page.
 *
 * Borrowed, not created: the emulator draws into one element for the life of
 * the page, because the agent drives the machine whether or not this panel is
 * open. Mounting takes it out of its parking spot and unmounting puts it back,
 * and forgetting the second half would take the machine's display out of the
 * document — and every screenshot the agent takes afterwards with it.
 */
function Screen({ live }: { live: boolean }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const [step, setStep] = useState<string>('Starting the machine…')
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const machine = bridge()
    if (machine === undefined || host.current === null) return
    let release: (() => void) | undefined
    let gone = false
    void (async () => {
      try {
        await machine.boot(next => { if (!gone) setStep(next) })
        if (gone || host.current === null) return
        const disposer = await machine.adoptScreen(host.current)
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
      } catch (error) {
        if (!gone) setFailed(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      gone = true
      release?.()
    }
  }, [])

  // The emulator installs no keyboard listener of its own, so this is the
  // whole of the guest's keyboard: events on this element, while it has focus,
  // and nothing else. `code` rather than `key` because a scan code is a
  // physical key — what the guest wants to know is which key moved, not what
  // the host's layout thinks it means.
  const onKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const machine = bridge()
    if (machine === undefined) return
    if (machine.key(event.nativeEvent.code, event.type === 'keydown')) event.preventDefault()
  }, [])
  const capture = useCallback((on: boolean) => { setFocused(on) }, [])

  if (failed !== undefined) {
    return <p className="dsh-web-runtime-notice">{failed}</p>
  }
  return (
    <div className="dsh-web-runtime-stage">
      <div
        className="dsh-web-runtime-screen"
        {...(focused ? { 'data-focused': '' } : {})}
        ref={host}
        tabIndex={0}
        role="application"
        aria-label="The machine's screen"
        onFocus={() => { capture(true) }}
        onBlur={() => { capture(false) }}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onClick={() => { host.current?.focus() }}
      />
      {step !== '' && <p className="dsh-web-runtime-step">{step}</p>}
      <p className="dsh-web-runtime-hint">
        {live
          ? focused
            ? 'The keyboard is going to the machine. Click outside to give it back.'
            : 'Click the screen to type at the machine.'
          : 'This session is not running an emulated machine.'}
      </p>
    </div>
  )
}

/** One row in the machine list. */
function MachineRow({
  title, detail, tags, chosen, onChoose, children,
}: {
  title: string
  detail: string
  tags: string[]
  chosen: boolean
  onChoose: () => void
  children?: JSX.Element | false
}): JSX.Element {
  return (
    <div className="dsh-web-runtime-row" {...(chosen ? { 'data-chosen': '' } : {})}>
      <button type="button" className="dsh-web-runtime-pick" onClick={onChoose} aria-pressed={chosen}>
        <span className="dsh-web-runtime-name">{title}</span>
        <span className="dsh-web-runtime-tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</span>
        <span className="dsh-web-runtime-detail">{detail}</span>
      </button>
      {children}
    </div>
  )
}

/** The panel, drawn into the surface's shell overlay. */
function RuntimePanel({ open, onClose }: { open: boolean, onClose: () => void }): JSX.Element {
  const machine = bridge()
  const [chosen, setChosen] = useState<Selection>(() => machine?.selection() ?? { kind: 'node' })
  const [disks, setDisks] = useState<StoredDisk[]>([])
  const [host, setHost] = useState<string>(() => machine?.imageHost() ?? '')
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const active = machine?.selection() ?? { kind: 'node' as const }
  const status = machine?.status()
  const guests = machine?.guests() ?? []

  const refreshDisks = useCallback(() => {
    void machine?.disks().then(setDisks).catch(() => undefined)
  }, [machine])
  useEffect(() => { if (open) refreshDisks() }, [open, refreshDisks])

  const choose = useCallback((next: Selection) => {
    setChosen(next)
    setSaved(false)
  }, [])

  const apply = useCallback(() => {
    machine?.select(chosen)
    if (host.trim() !== '') machine?.setImageHost(host.trim())
    setSaved(true)
  }, [machine, chosen, host])

  const openDisk = useCallback(async (guest: string, file: File | undefined) => {
    if (file === undefined || machine === undefined) return
    setProblem(undefined)
    try {
      await machine.storeDisk(guest, file)
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

  return (
    <div className="dsh-web-runtime" {...(open ? { 'data-open': '' } : { hidden: true })}>
      <div className="dsh-web-runtime-bar">
        <span className="dsh-web-runtime-title">Runtime</span>
        <span className="dsh-web-runtime-now">
          {active.kind === 'node'
            ? 'running the Node container'
            : `running ${guests.find(guest => guest.id === active.image)?.name ?? active.image}`}
        </span>
        {status?.running === true && (
          <button type="button" onClick={() => { void machine?.restart().then(() => { location.reload() }) }}>
            Restart machine
          </button>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="dsh-web-runtime-body">
        {!same && (
          <div className="dsh-web-runtime-apply">
            <button type="button" onClick={apply}>Use this machine</button>
            {saved && (
              <span>
                Saved. It applies on the next load —{' '}
                <button type="button" className="dsh-web-runtime-link" onClick={() => { location.reload() }}>
                  reload now
                </button>
                .
              </span>
            )}
          </div>
        )}

        {/* Only while the panel is showing. The screen is the app's element,
            not this component's, and a closed panel is `display: none` — an
            element with no box, which is the one state the emulator's screen
            adapter cannot measure. Unmounting hands it back to its parking
            spot, where it keeps being drawn into and keeps photographing. */}
        {open && active.kind === 'v86' && <Screen live />}

        <section>
          <h3>Machine</h3>
          <p className="dsh-web-runtime-lede">
            One session runs on one machine, and which one decides what tools the assistant is given.
            A change applies the next time this page loads.
          </p>

          <MachineRow
            title="Node container"
            detail="WebContainers: Node 22, npm, a real CPython with pip, and a POSIX filesystem shared with the assistant's file tools. The default."
            tags={['shell', 'nothing to download']}
            chosen={chosen.kind === 'node'}
            onChoose={() => { choose({ kind: 'node' }) }}
          />

          {guests.map((guest) => {
            const stored = disks.find(disk => disk.guest === guest.id)
            const ready = guest.bundled || stored !== undefined
            return (
              <MachineRow
                key={guest.id}
                title={guest.name}
                detail={`${guest.summary} Boots in ${guest.boots}.`}
                tags={[
                  consoleLabel(guest.console),
                  stored === undefined ? size(guest.transfer) : `${size(stored.size)} on this device`,
                  ...(ready ? [] : ['not on the default host']),
                ]}
                chosen={chosen.kind === 'v86' && chosen.image === guest.id}
                onChoose={() => { choose({ kind: 'v86', image: guest.id }) }}
              >
                {(!guest.bundled || stored !== undefined) && (
                  <div className="dsh-web-runtime-disk">
                    {stored === undefined
                      ? (
                          <>
                            <span>
                              The default image host does not serve {guest.files.join(', ')}. Point the image host
                              below at one that does, or open the disk image from this computer:
                            </span>
                            <input
                              type="file"
                              aria-label={`Disk image for ${guest.name}`}
                              onChange={(event) => {
                                void openDisk(guest.id, event.currentTarget.files?.[0])
                              }}
                            />
                          </>
                        )
                      : (
                          <>
                            <span>Using {stored.name} from this computer ({size(stored.size)}), kept in this browser.</span>
                            <button
                              type="button"
                              onClick={() => { void machine?.forgetDisk(guest.id).then(refreshDisks) }}
                            >
                              Forget it
                            </button>
                          </>
                        )}
                  </div>
                )}
              </MachineRow>
            )
          })}
        </section>

        <section>
          <h3>Image host</h3>
          <p className="dsh-web-runtime-lede">
            Where disk images are fetched from. The default is the v86 project's public image
            repository, which serves the five machines above that need no setup. v86's own demo
            serves the rest from <code>{machine?.hosts.upstream}</code>, which refuses requests from
            anywhere but <code>copy.sh</code> — so pointing at it only works if that is where you
            are. A mirror of your own works too.
          </p>
          <div className="dsh-web-runtime-host">
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
        </section>

        {problem !== undefined && <p className="dsh-web-runtime-problem">{problem}</p>}

        {same && (
          <div className="dsh-web-runtime-apply" data-end>
            <button type="button" disabled={!hostChanged} onClick={apply}>Save image host</button>
            {saved && (
              <span>
                Saved. It applies on the next load —{' '}
                <button type="button" className="dsh-web-runtime-link" onClick={() => { location.reload() }}>
                  reload now
                </button>
                .
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** A tower with a screen, in the outline language the sidebar's icons use. */
function RuntimeIcon(): JSX.Element {
  return (
    <svg
      className="dsh-web-runtime-action-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <rect x="1.6" y="3" width="12.8" height="8.4" rx="1.6" />
      <path d="M5.6 13.6h4.8" />
      <path d="M8 11.4v2.2" />
      <path d="M4.6 6.2h3.2" />
    </svg>
  )
}

/** The sidebar footer action that opens it. */
function RuntimeAction({ open, onToggle, wide }: { open: boolean, onToggle: () => void, wide: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="dsh-web-runtime-action"
      {...(wide ? {} : { 'data-rail': '' })}
      {...(open ? { 'data-open': '' } : {})}
      aria-expanded={open}
      aria-label="Runtime"
      onClick={onToggle}
      title="Choose the machine this session runs on"
    >
      <RuntimeIcon />
      {wide && <span className="dsh-web-runtime-action-label">Runtime</span>}
    </button>
  )
}

const STYLE = `
.dsh-web-runtime[hidden]{display:none}
.dsh-web-runtime{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,Canvas);
 color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-web-runtime-bar{display:flex;align-items:center;gap:.75rem;padding:.55rem .9rem;flex:none;
 border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-web-runtime-title{font-weight:600}
.dsh-web-runtime-now{opacity:.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-runtime-bar button{font:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));
 color:inherit;border-radius:.35rem;padding:.2rem .55rem;cursor:pointer}
.dsh-web-runtime-body{flex:1;min-height:0;overflow:auto;padding:1rem 1.1rem 2rem;
 font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:64rem;width:100%;margin:0 auto;box-sizing:border-box}
.dsh-web-runtime-body h3{margin:1.4rem 0 .4rem;font-size:13px;letter-spacing:.02em;text-transform:uppercase;opacity:.6}
.dsh-web-runtime-lede{margin:0 0 .7rem;opacity:.72;max-width:52rem}
.dsh-web-runtime-lede code{font-size:12px;opacity:.9}
.dsh-web-runtime-stage{display:flex;flex-direction:column;align-items:center;gap:.4rem;padding:.6rem 0 1rem}
.dsh-web-runtime-screen{background:#000;border:2px solid transparent;border-radius:.3rem;line-height:0;max-width:100%;overflow:auto}
.dsh-web-runtime-screen[data-focused]{border-color:var(--dsw-alias-border-focus,#2f81f7)}
.dsh-web-runtime-screen:focus{outline:none}
.dsh-web-runtime-step,.dsh-web-runtime-hint{margin:0;font-size:12px;opacity:.6}
.dsh-web-runtime-notice{padding:1rem;opacity:.7;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-web-runtime-row{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:.5rem;margin-bottom:.4rem;overflow:hidden}
.dsh-web-runtime-row[data-chosen]{border-color:var(--dsw-alias-border-focus,#2f81f7)}
.dsh-web-runtime-pick{display:grid;grid-template-columns:minmax(9rem,auto) 1fr;gap:.15rem .75rem;width:100%;text-align:left;
 background:0 0;border:0;color:inherit;font:inherit;padding:.6rem .75rem;cursor:pointer}
.dsh-web-runtime-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsh-web-runtime-name{font-weight:600}
.dsh-web-runtime-tags{display:flex;gap:.35rem;flex-wrap:wrap;justify-self:start}
.dsh-web-runtime-tags span{font-size:11px;padding:.05rem .4rem;border-radius:.6rem;opacity:.75;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.dsh-web-runtime-detail{grid-column:1/-1;opacity:.7}
.dsh-web-runtime-disk{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.5rem .75rem;font-size:12px;opacity:.85;
 border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}
.dsh-web-runtime-disk span{flex:1;min-width:16rem}
.dsh-web-runtime-problem{margin:.8rem 0 0;color:var(--dsw-alias-label-danger,#f5a3a3)}
.dsh-web-runtime-host{display:flex;gap:.5rem;align-items:center}
.dsh-web-runtime-host input{flex:1;font:inherit;padding:.3rem .5rem;border-radius:.35rem;background:transparent;color:inherit;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}
.dsh-web-runtime-apply{display:flex;align-items:center;gap:.7rem;margin:0 0 1.4rem}
.dsh-web-runtime-apply[data-end]{margin:1.4rem 0 0}
.dsh-web-runtime-apply button,.dsh-web-runtime-disk button,.dsh-web-runtime-host button{font:inherit;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;
 border-radius:.35rem;padding:.3rem .7rem}
.dsh-web-runtime-apply button:disabled{opacity:.4;cursor:default}
.dsh-web-runtime-link{border:0!important;padding:0!important;text-decoration:underline}
.dsh-web-runtime-action{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 calc(100% + 8px);
 width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:none;border-radius:12px;
 background:0 0;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;
 cursor:pointer;overflow:hidden}
.dsh-web-runtime-action:hover,.dsh-web-runtime-action[data-open]{
 background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-runtime-action-icon{flex:none}
.dsh-web-runtime-action-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-web-runtime-action[data-rail]{flex:0 0 36px;justify-content:center;gap:0;width:36px;height:36px;
 margin:4px 0;padding:0;border-radius:50%}
:has(> .dsh-web-runtime-action),:has(> * > .dsh-web-runtime-action){flex-wrap:wrap}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-runtime-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-runtime-chrome'
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
    { name: 'shell.overlay', id: 'web-runtime' },
    function Overlay(): JSX.Element {
      const isOpen = useOpen()
      const close = useCallback(() => { setOpen(false) }, [])
      return (
        <div data-dsh-web-runtime-slot="">
          <RuntimePanel open={isOpen} onClose={close} />
        </div>
      )
    },
  ))

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-runtime' },
    function Action({ wide }: { wide: boolean }): JSX.Element {
      const isOpen = useOpen()
      const toggle = useCallback(() => { setOpen(!open) }, [])
      return <RuntimeAction open={isOpen} onToggle={toggle} wide={wide} />
    },
  ))
}

export default { apply, inject }
