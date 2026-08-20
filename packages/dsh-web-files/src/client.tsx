/**
 * The file browser's browser half.
 *
 * An ordinary client plugin, built the way the terminal is: a footer action in
 * the sidebar to open it and the shell overlay to draw in, wearing the shape
 * the sidebar's own rows have. It sits above the terminal because the slot is a
 * list and a list takes an `order` — no CSS fight, and it stays above whether
 * or not the terminal plugin is composed at all.
 *
 * The filesystem it draws is the page's capability, not this plugin's. That
 * matters more here than anywhere else in the surface: this machine has two
 * filesystems and only one of them is the user's at any moment, so a browser
 * that picked for itself would eventually show a directory the agent has never
 * seen. `__DSH_WEB_FILES__` routes exactly the way the agent's own file tools
 * route, which is the whole reason it exists.
 *
 * What it deliberately does not show is a size or a modified time. The
 * container's filesystem API has no `stat`, so those are two columns the page
 * could fill only when the container was *down* — a listing that grew detail as
 * the machine got worse.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** One row of a directory listing. */
interface FileEntry {
  name: string
  path: string
  directory: boolean
}

/** The filesystem the app publishes, routed to whichever one is real. */
interface FilesBridge {
  root(): string
  home(): string
  backing(): Promise<'runtime' | 'page'>
  list(path: string): Promise<FileEntry[]>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Pack these paths — directories walked — into a zip, named relative to `base`. */
  archive(paths: string[], base: string): Promise<Uint8Array>
}

/** Where the app publishes it. */
const BRIDGE = '__DSH_WEB_FILES__'

/** Read the filesystem the app published. */
function files(): FilesBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE] as FilesBridge | undefined
}

/** The event the page dispatches to open one path here. */
const OPEN_EVENT = 'dsh-web:open-path'

/** The parent of a path, never above the harness's home. */
function parentOf(path: string, home: string): string {
  if (path === home || !path.startsWith(`${home}/`)) return home
  const cut = path.lastIndexOf('/')
  return cut <= home.length ? home : path.slice(0, cut)
}

/** The path's segments, as jump targets. */
function crumbs(path: string, home: string): { name: string, path: string }[] {
  const rows = [{ name: '~', path: home }]
  if (!path.startsWith(`${home}/`)) return rows
  let walked = home
  for (const segment of path.slice(home.length + 1).split('/')) {
    walked = `${walked}/${segment}`
    rows.push({ name: segment, path: walked })
  }
  return rows
}

/** The last segment of a path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Whether these bytes are worth showing as text.
 *
 * A NUL in the first few kilobytes is what every `file`-like heuristic starts
 * with, and it is enough here: the alternative is rendering a PNG as mojibake
 * and calling it a preview.
 * @param bytes - the file's contents.
 * @returns true when the viewer should decode it.
 */
function looksTextual(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 4096)
  return !window.includes(0)
}

/** Hand a file to the browser's own download machinery. */
function download(name: string, bytes: Uint8Array): void {
  // A fresh copy into a plain ArrayBuffer: the bytes may be a view onto a
  // larger buffer, and `Blob` would take the whole of it.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // After the click, not before it: revoking synchronously cancels the download
  // in some browsers.
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/** What the viewer is currently showing. */
interface Viewing {
  path: string
  bytes: Uint8Array
  text?: string
}

/** The panel, drawn into the surface's shell overlay. */
function FilesPanel({ open, target, onClose }: {
  open: boolean
  /** A path the page asked to be shown, if one was asked for. */
  target: string | undefined
  onClose: () => void
}): JSX.Element | null {
  const bridge = files()
  const home = bridge?.home() ?? '/'
  const [cwd, setCwd] = useState<string>(() => bridge?.root() ?? '/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [viewing, setViewing] = useState<Viewing | undefined>(undefined)
  const [notice, setNotice] = useState<{ text: string, error?: boolean } | undefined>(undefined)
  const [backing, setBacking] = useState<'runtime' | 'page' | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const upload = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async (directory: string) => {
    const api = files()
    if (api === undefined) {
      setNotice({ text: 'The filesystem bridge is not available in this build.', error: true })
      return
    }
    setBusy(true)
    try {
      setEntries(await api.list(directory))
      setCwd(directory)
      // A selection belongs to the listing it was made in; carrying it into
      // another directory would download paths the user can no longer see.
      setPicked(new Set())
      setNotice(undefined)
    } catch (error) {
      setEntries([])
      setNotice({ text: `${directory}: ${error instanceof Error ? error.message : String(error)}`, error: true })
    } finally {
      setBusy(false)
    }
  }, [])

  const show = useCallback(async (path: string) => {
    const api = files()
    if (api === undefined) return
    setBusy(true)
    try {
      const bytes = await api.read(path)
      setViewing({
        path,
        bytes,
        ...(looksTextual(bytes) ? { text: new TextDecoder().decode(bytes) } : {}),
      })
    } catch (error) {
      setNotice({ text: `${path}: ${error instanceof Error ? error.message : String(error)}`, error: true })
    } finally {
      setBusy(false)
    }
  }, [])

  // Opening is the moment to read: the container may have been written to by a
  // command since the last time this was on screen.
  useEffect(() => {
    if (!open) return
    void files()?.backing().then(setBacking, () => undefined)
    void refresh(cwd)
    // `cwd` is deliberately absent: this is the on-open read, and navigation
    // does its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh])

  // A path the page asked for — a file reference clicked in the chat. A
  // directory is navigated to; a file is opened beside its directory, because
  // "open this file" that showed only a listing would not have answered.
  useEffect(() => {
    if (!open || target === undefined) return
    const api = files()
    if (api === undefined) return
    void (async () => {
      const directory = parentOf(target, home)
      const listed = await api.list(directory).catch(() => undefined)
      if (listed === undefined) {
        await refresh(target)
        return
      }
      const row = listed.find(entry => entry.path === target)
      if (row?.directory === true || row === undefined) {
        await refresh(row === undefined ? directory : target)
        return
      }
      setEntries(listed)
      setCwd(directory)
      setNotice(undefined)
      await show(target)
    })()
  }, [open, target, home, refresh, show])

  /**
   * Hand one or many paths to the browser.
   *
   * One file goes as itself; anything else — several files, or a directory —
   * goes as a zip, because a browser can only be handed one thing at a time
   * and a directory is not a thing it can be handed at all.
   */
  const save = useCallback(async (paths: { path: string, directory: boolean }[]) => {
    const api = files()
    if (api === undefined || paths.length === 0) return
    setBusy(true)
    try {
      const only = paths.length === 1 ? paths[0] : undefined
      if (only !== undefined && !only.directory) {
        download(baseName(only.path), await api.read(only.path))
        return
      }
      const name = only === undefined ? `${baseName(cwd) || 'workspace'}.zip` : `${baseName(only.path)}.zip`
      download(name, await api.archive(paths.map(entry => entry.path), cwd))
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }, [cwd])

  const put = useCallback(async (list: FileList | null) => {
    const api = files()
    if (api === undefined || list === null || list.length === 0) return
    setBusy(true)
    try {
      for (const file of Array.from(list)) {
        await api.write(`${cwd}/${file.name}`, new Uint8Array(await file.arrayBuffer()))
      }
      setNotice({ text: `Uploaded ${String(list.length)} file${list.length === 1 ? '' : 's'} into ${cwd}.` })
      await refresh(cwd)
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }, [cwd, refresh])

  const remove = useCallback(async (entry: FileEntry) => {
    const api = files()
    if (api === undefined) return
    if (!globalThis.confirm(`Delete ${entry.name}${entry.directory ? ' and everything in it' : ''}?`)) return
    try {
      await api.remove(entry.path)
      if (viewing?.path === entry.path) setViewing(undefined)
      await refresh(cwd)
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [cwd, refresh, viewing])

  const makeDirectory = useCallback(async () => {
    const api = files()
    if (api === undefined) return
    const name = globalThis.prompt('New folder name')
    if (name === null || name.trim() === '') return
    try {
      await api.mkdir(`${cwd}/${name.trim()}`)
      await refresh(cwd)
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [cwd, refresh])

  if (!open) return null

  return (
    <div
      className="dsh-web-files"
      onDragOver={(event) => { event.preventDefault() }}
      onDrop={(event) => {
        event.preventDefault()
        void put(event.dataTransfer.files)
      }}
    >
      <div className="dsh-web-files-bar">
        <span className="dsh-web-files-title">Files</span>
        <span className="dsh-web-files-hint">
          {backing === 'page'
            ? 'the page’s own filesystem — the runtime did not start'
            : 'the same workspace the agent and the terminal share'}
        </span>
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="dsh-web-files-tools">
        <button type="button" disabled={cwd === home} onClick={() => { void refresh(parentOf(cwd, home)) }}>Up</button>
        <nav className="dsh-web-files-crumbs" aria-label="Path">
          {crumbs(cwd, home).map((crumb, index, all) => (
            <span key={crumb.path}>
              <button type="button" onClick={() => { void refresh(crumb.path) }}>{crumb.name}</button>
              {index < all.length - 1 && <span aria-hidden="true">/</span>}
            </span>
          ))}
        </nav>
        <span className="dsh-web-files-actions">
          {picked.size > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void save(entries.filter(entry => picked.has(entry.path)))
              }}
            >
              {`Download ${String(picked.size)} selected`}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { upload.current?.click() }}>Upload…</button>
          <button type="button" disabled={busy} onClick={() => { void makeDirectory() }}>New folder</button>
          <button type="button" disabled={busy} onClick={() => { void refresh(cwd) }}>Refresh</button>
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={(event) => { void put(event.target.files); event.target.value = '' }}
          />
        </span>
      </div>

      <div className="dsh-web-files-body">
        <ul className="dsh-web-files-list">
          {entries.length > 0 && (
            <li className="dsh-web-files-all">
              <label>
                <input
                  type="checkbox"
                  checked={picked.size === entries.length && entries.length > 0}
                  aria-label="Select everything here"
                  onChange={(event) => {
                    setPicked(event.target.checked ? new Set(entries.map(entry => entry.path)) : new Set())
                  }}
                />
                <span>{picked.size === 0 ? 'Select' : `${String(picked.size)} of ${String(entries.length)}`}</span>
              </label>
            </li>
          )}
          {entries.length === 0 && !busy && <li className="dsh-web-files-empty">This directory is empty.</li>}
          {entries.map(entry => (
            <li key={entry.path} {...(viewing?.path === entry.path ? { 'data-open': '' } : {})}>
              <input
                type="checkbox"
                checked={picked.has(entry.path)}
                aria-label={`Select ${entry.name}`}
                onChange={(event) => {
                  setPicked((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(entry.path)
                    else next.delete(entry.path)
                    return next
                  })
                }}
              />
              <button
                type="button"
                className="dsh-web-files-name"
                onClick={() => { void (entry.directory ? refresh(entry.path) : show(entry.path)) }}
              >
                <span aria-hidden="true">{entry.directory ? '📁' : '📄'}</span>
                <span className="dsh-web-files-label">{entry.name}</span>
              </button>
              <button
                type="button"
                title={entry.directory ? `Download ${entry.name} as a zip` : `Download ${entry.name}`}
                onClick={() => { void save([entry]) }}
              >
                ↓
              </button>
              <button type="button" title={`Delete ${entry.name}`} onClick={() => { void remove(entry) }}>✕</button>
            </li>
          ))}
        </ul>

        {viewing !== undefined && (
          <div className="dsh-web-files-viewer">
            <div className="dsh-web-files-viewer-bar">
              <span className="dsh-web-files-title">{baseName(viewing.path)}</span>
              <span className="dsh-web-files-hint">{`${String(viewing.bytes.length)} bytes`}</span>
              <button type="button" onClick={() => { download(baseName(viewing.path), viewing.bytes) }}>Download</button>
              <button type="button" onClick={() => { setViewing(undefined) }}>Close</button>
            </div>
            {viewing.text === undefined
              ? <p className="dsh-web-files-notice">This file is not text. Download it to open it elsewhere.</p>
              : <pre className="dsh-web-files-text">{viewing.text}</pre>}
          </div>
        )}
      </div>

      {notice !== undefined && (
        <p className="dsh-web-files-notice" {...(notice.error === true ? { 'data-error': '' } : {})}>{notice.text}</p>
      )}
    </div>
  )
}

/** A folder, drawn in the outline language the sidebar's icons use. */
function FilesIcon(): JSX.Element {
  return (
    <svg
      className="dsh-web-files-action-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M1.7 4.2a1.6 1.6 0 0 1 1.6-1.6h2.4l1.4 1.7h5.6a1.6 1.6 0 0 1 1.6 1.6v6a1.6 1.6 0 0 1-1.6 1.6H3.3a1.6 1.6 0 0 1-1.6-1.6z" />
    </svg>
  )
}

/**
 * The sidebar footer action that opens it.
 * @param props - the owner share of the slot plus this plugin's own open state.
 * @returns the row, in the shape the sidebar's Settings row already has.
 */
function FilesAction({ open, onToggle, wide }: { open: boolean, onToggle: () => void, wide: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="dsh-web-files-action"
      {...(wide ? {} : { 'data-rail': '' })}
      {...(open ? { 'data-open': '' } : {})}
      aria-expanded={open}
      aria-label="Files"
      onClick={onToggle}
      title="Browse, upload and download this workspace's files"
    >
      <FilesIcon />
      {wide && <span className="dsh-web-files-action-label">Files</span>}
    </button>
  )
}

const STYLE = `
/* Surface tokens, with fallbacks that agree with each other. A fallback is
   the value used when the token is missing, so pairing a hard-coded dark
   background with a token-resolved foreground is how a panel ends up as dark
   text on dark. That is what happened here: --dsw-alias-bg-l1 is not a token
   this surface defines, so the background fell back to a dark literal while
   the text colour resolved from a real token and followed the light theme.
   Canvas and CanvasText are the system pair, and they move together. */
.dsh-web-files{position:fixed;left:0;right:0;bottom:0;height:min(58vh,36rem);z-index:60;display:flex;
 flex-direction:column;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
 border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 -8px 32px rgba(0,0,0,.18);
 font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-web-files-bar,.dsh-web-files-viewer-bar{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;flex:none;
 border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-web-files-title{font-weight:600}
.dsh-web-files-hint{color:var(--dsw-alias-label-secondary,inherit);opacity:.8;flex:1;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.dsh-web-files button{font:inherit;background:transparent;color:inherit;border-radius:.35rem;padding:.15rem .5rem;
 cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}
.dsh-web-files button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-files button:disabled{opacity:.45;cursor:default}
.dsh-web-files-tools{display:flex;align-items:center;gap:.5rem;padding:.4rem .75rem;flex:none;flex-wrap:wrap;
 border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-web-files-crumbs{display:flex;align-items:center;gap:.2rem;flex:1;overflow:hidden;white-space:nowrap}
.dsh-web-files-crumbs button{border:none;padding:.1rem .25rem}
.dsh-web-files-crumbs button:hover{text-decoration:underline}
.dsh-web-files-actions{display:flex;gap:.4rem;margin-left:auto}
.dsh-web-files-body{flex:1;min-height:0;display:flex}
.dsh-web-files-list{flex:1;min-width:14rem;max-width:32rem;overflow:auto;margin:0;padding:.25rem;list-style:none;
 border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-web-files-list:last-child{max-width:none;border-right:none}
.dsh-web-files-list li{display:flex;align-items:center;gap:.25rem;border-radius:.4rem;padding:.05rem .25rem}
.dsh-web-files-list li:hover,.dsh-web-files-list li[data-open]{
 background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-web-files-list li button{border:none;padding:.2rem .35rem}
.dsh-web-files-list li input[type=checkbox]{flex:none;margin:0 .15rem;cursor:pointer}
.dsh-web-files-all{color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dsh-web-files-all label{display:flex;align-items:center;gap:.45rem;cursor:pointer;padding:.1rem .15rem}
.dsh-web-files-all input[type=checkbox]{cursor:pointer}
.dsh-web-files-name{flex:1;display:flex;align-items:center;gap:.45rem;overflow:hidden;text-align:left}
.dsh-web-files-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-web-files-empty{color:var(--dsw-alias-label-secondary,inherit);opacity:.8;padding:.5rem}
.dsh-web-files-viewer{flex:2;min-width:0;display:flex;flex-direction:column}
.dsh-web-files-text{flex:1;margin:0;padding:.6rem .75rem;overflow:auto;white-space:pre-wrap;word-break:break-word;
 background:var(--dsw-alias-markdown-code-block,transparent);
 font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-web-files-notice{padding:.6rem .75rem;margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dsh-web-files-notice[data-error]{color:var(--dsw-alias-state-error-primary,#d33)}
.dsh-web-files-action{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 calc(100% + 8px);
 width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:none;border-radius:12px;
 background:0 0;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;
 cursor:pointer;overflow:hidden}
.dsh-web-files-action:hover,.dsh-web-files-action[data-open]{
 background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-web-files-action-icon{flex:none}
.dsh-web-files-action-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-web-files-action[data-rail]{flex:0 0 36px;justify-content:center;gap:0;width:36px;height:36px;
 margin:4px 0;padding:0;border-radius:50%}
/* The same opening the terminal's action needs, for the same reason: the
   foot's action line is one nowrap row, so without it two actions sit side by
   side instead of stacking. Stated here too so this plugin stacks correctly
   when it is the only one composed. */
:has(> .dsh-web-files-action),:has(> * > .dsh-web-files-action){flex-wrap:wrap}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-files-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-files-chrome'
    style.textContent = STYLE
    document.head.append(style)
  }

  // One piece of state shared by the two slots, plus the path a caller asked
  // for: the action toggles what the overlay draws, and the surface owns where
  // each of them lives.
  let open = false
  let target: string | undefined
  const listeners = new Set<() => void>()
  const announce = (): void => { for (const listener of listeners) listener() }
  const setOpen = (next: boolean, path?: string): void => {
    open = next
    target = path
    announce()
  }
  const useShared = (): { open: boolean, target: string | undefined } => {
    const [, force] = useState(0)
    useEffect(() => {
      const listener = (): void => { force(count => count + 1) }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, [])
    return { open, target }
  }

  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string, order?: number }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'web-files' },
    function Overlay(): JSX.Element {
      const shared = useShared()
      const close = useCallback(() => { setOpen(false) }, [])
      return (
        <div data-dsh-web-files-slot="">
          <FilesPanel open={shared.open} target={shared.target} onClose={close} />
        </div>
      )
    },
  ))

  // `order` below the terminal's default of 0, which is what puts this row
  // above it — the slot is a list, and a list is ordered by the number rather
  // than by which plugin happened to compose first.
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-files', order: -1 },
    function Action({ wide }: { wide: boolean }): JSX.Element {
      const shared = useShared()
      const toggle = useCallback(() => { setOpen(!open) }, [])
      return <FilesAction open={shared.open} onToggle={toggle} wide={wide} />
    },
  ))

  // How everything else asks for a file: the page dispatches this when the host
  // is asked to open a path — see `src/shell/tools.ts` — and the panel is what
  // "open" means in a tab that has no desktop behind it.
  const onOpenPath = (event: Event): void => {
    const path = (event as CustomEvent<{ path?: string }>).detail?.path
    if (typeof path === 'string' && path !== '') setOpen(true, path)
  }
  window.addEventListener(OPEN_EVENT, onOpenPath)

  // The same control surface the terminal publishes, for the same two readers:
  // an automated browser, and anything in the page that wants to show a file.
  ;(globalThis as Record<string, unknown>).__DSH_FILES__ = {
    open: (path?: string) => { setOpen(true, path) },
    close: () => { setOpen(false) },
    isOpen: () => open,
  }

  ctx.on('dispose', () => { window.removeEventListener(OPEN_EVENT, onOpenPath) })
}

export default { apply, inject }
