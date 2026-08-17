/**
 * The install plugin's browser half.
 *
 * `dsh web` lists installed plugins in Settings and offers no way to add one,
 * because on a machine that is `dsh plugin add` in a shell. This adds the
 * affordance where the surface already keeps plugins — its own plugins tab —
 * rather than in a panel of its own, so a user finds it where they would look.
 *
 * Every source the installer accepts is offered: a registry name, a tarball
 * URL, a GitHub repository, a path in the virtual filesystem, or a file from
 * the user's own machine.
 */

import { useCallback, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The installer the app publishes. */
interface InstallerBridge {
  install(spec: string): Promise<{ name: string, version: string, patch?: string }>
  list(): { name: string, version: string, enabled: boolean, hasClient: boolean }[]
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
  remove(name: string): Promise<void>
  /** Stage an uploaded file where the installer can read it. */
  stage(name: string, bytes: ArrayBuffer): string
}

/** Where the app publishes it. */
const BRIDGE = '__DSH_WEB_PLUGINS__'

/** Read the installer the app published. */
function installer(): InstallerBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE] as InstallerBridge | undefined
}

const STYLE = `
.dsh-web-install{display:flex;flex-direction:column;gap:.6rem;padding:.75rem 0}
.dsh-web-install-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.dsh-web-install-row input[type=text]{flex:1;min-width:14rem;padding:.4rem .55rem;border-radius:.4rem;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;font:inherit}
.dsh-web-install button{font:inherit;padding:.35rem .75rem;border-radius:.4rem;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit}
.dsh-web-install button:disabled{opacity:.5;cursor:default}
.dsh-web-install-note{opacity:.6;font-size:12px;line-height:1.6}
.dsh-web-install-status{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;
 padding:.5rem .6rem;border-radius:.4rem;background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.12))}
.dsh-web-install-status[data-error]{color:var(--dsw-alias-state-error-primary,#d33)}
`

/** The install form, rendered inside the surface's plugins tab. */
function InstallPanel(): JSX.Element {
  const [spec, setSpec] = useState('')
  const [status, setStatus] = useState<{ text: string, error?: boolean } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement | null>(null)

  const run = useCallback(async (source: string) => {
    const api = installer()
    if (api === undefined) {
      setStatus({ text: 'The installer is not available in this build.', error: true })
      return
    }
    if (source.trim() === '') return
    setBusy(true)
    setStatus({ text: `Installing ${source}…` })
    try {
      const entry = await api.install(source.trim())
      setSpec('')
      setStatus({
        text: `Installed ${entry.name}@${entry.version}.`
          + `${entry.patch === undefined ? ' It declares no composition layer.' : ''}`
          + ' Reload to apply — composition is fixed at boot.',
      })
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }, [])

  const onPick = useCallback(async () => {
    const picked = file.current?.files?.[0]
    if (picked === undefined) return
    const api = installer()
    if (api === undefined) return
    setStatus({ text: `Reading ${picked.name}…` })
    const staged = api.stage(picked.name, await picked.arrayBuffer())
    if (file.current !== null) file.current.value = ''
    await run(staged)
  }, [run])

  return (
    <div className="dsh-web-install">
      <div className="dsh-web-install-row">
        <input
          type="text"
          value={spec}
          placeholder="package, tarball URL, owner/repo, or /path"
          aria-label="Plugin source"
          onChange={event => { setSpec(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void run(spec) }}
        />
        <button type="button" disabled={busy} onClick={() => { void run(spec) }}>Install</button>
        <button type="button" disabled={busy} onClick={() => { file.current?.click() }}>From file…</button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
          onChange={() => { void onPick() }}
        />
      </div>
      <p className="dsh-web-install-note">
        Accepts an npm name, a tarball URL, <code>owner/repo#ref</code>, or a path in this
        filesystem — the same sources <code>dsh plugin add</code> takes on a machine.
      </p>
      {status !== undefined && (
        <div className="dsh-web-install-status" {...(status.error === true ? { 'data-error': '' } : {})}>
          {status.text}
        </div>
      )}
    </div>
  )
}

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-install-style') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-install-style'
    style.textContent = STYLE
    document.head.append(style)
  }

  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  // The surface's own plugins page, where a user already goes to see what is
  // installed. Both holes are offered because a deployment may declare either.
  for (const name of ['settings.plugins.tab', 'settings.plugin.item']) {
    slots.inject(name, () => slots.register({ name, id: 'web-plugin-install' }, InstallPanel))
  }
}

export default { apply, inject }
