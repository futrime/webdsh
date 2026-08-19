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
 *
 * Two tabs, because installing and managing are different readings. The second
 * one is the roster with its switches — the manager has had `enable`, `disable`
 * and `remove` since it was written, and `/plugin disable x` has always worked,
 * but a switch is where a person looks for it. What the roster holds is only
 * what a user installed: the plugins this build ships travel as build-time
 * layers and have no entry here, which is also why nothing on this page can
 * turn the terminal off.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The installer the app publishes. */
interface InstallerBridge {
  install(spec: string): Promise<{ name: string, version: string, patch?: string }>
  list(): InstalledPlugin[]
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
  remove(name: string): Promise<void>
  /** Stage an uploaded file where the installer can read it. */
  stage(name: string, bytes: ArrayBuffer): string
}

/** One row of the installed roster. */
interface InstalledPlugin {
  name: string
  version: string
  enabled: boolean
  hasClient: boolean
  /**
   * The composition layer it declares, when it declares one.
   *
   * A package without one is a plain dependency: enabling it writes `true` and
   * mounts nothing, so the switch says that instead of pretending.
   */
  patch?: string
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
.dsh-web-roster{display:flex;flex-direction:column;gap:.5rem;padding:.75rem 0}
.dsh-web-roster-row{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.5rem .6rem;border-radius:.5rem;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.dsh-web-roster-name{font-weight:600}
.dsh-web-roster-version{opacity:.6;font-size:12px}
.dsh-web-roster-note{opacity:.6;font-size:12px;flex:1;min-width:8rem}
.dsh-web-roster-state{font-size:12px;padding:.1rem .45rem;border-radius:999px;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}
.dsh-web-roster-state[data-enabled]{color:var(--dsw-alias-state-success-primary,#2a7);border-color:currentColor}
.dsh-web-roster-actions{display:flex;gap:.4rem;margin-left:auto}
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

/**
 * The installed roster, with a switch per row.
 *
 * Everything a switch here does is durable and none of it is live: the manager
 * writes the roster and recomposes the host tree, but a browser surface is
 * decided at boot — the client bundles were snapshotted before the shell
 * loaded. So a row shows what the roster now says and the panel says plainly
 * that the running page is still the old composition, with the reload that
 * fixes that one button away. Claiming the change had already taken effect is
 * the one thing this must not do.
 */
function InstalledPanel(): JSX.Element {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [status, setStatus] = useState<{ text: string, error?: boolean } | undefined>(undefined)
  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    // Read once into state rather than on every render: `list()` parses the
    // roster afresh each call, so a new array identity per render would be a
    // render loop for anything subscribing to it.
    setInstalled(installer()?.list() ?? [])
  }, [])
  useEffect(refresh, [refresh])

  const act = useCallback(async (plugin: InstalledPlugin, verb: 'enable' | 'disable' | 'remove') => {
    const api = installer()
    if (api === undefined) {
      setStatus({ text: 'The installer is not available in this build.', error: true })
      return
    }
    if (verb === 'remove' && !globalThis.confirm(`Remove ${plugin.name}? Its files are deleted from this browser.`)) {
      return
    }
    setBusy(plugin.name)
    try {
      await api[verb](plugin.name)
      setChanged(true)
      setStatus({
        text: verb === 'remove'
          ? `Removed ${plugin.name}. Reload to apply — the composition is fixed at boot.`
          : `${plugin.name} is now ${verb}d. Reload to apply — the composition is fixed at boot.`,
      })
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(undefined)
      refresh()
    }
  }, [refresh])

  // Read again on demand. The section keeps a tab mounted once it has been
  // visited, so coming back to this one does not re-run the read — and the
  // roster is not this panel's alone: `/plugin add` in the composer writes to
  // the same file.
  const header = (
    <div className="dsh-web-install-row">
      <span className="dsh-web-install-note">
        {installed.length === 0 ? 'Nothing installed yet' : `${String(installed.length)} installed`}
      </span>
      <button type="button" onClick={refresh}>Refresh</button>
    </div>
  )

  if (installed.length === 0) {
    return (
      <div className="dsh-web-install dsh-web-roster">
        {header}
        <p className="dsh-web-install-note">
          Nothing installed here yet. This lists the plugins <em>you</em> add; the ones this build
          ships are composed at build time and appear under Plugin list.
        </p>
      </div>
    )
  }

  return (
    <div className="dsh-web-install dsh-web-roster">
      {header}
      {installed.map(plugin => (
        <div className="dsh-web-roster-row" key={plugin.name}>
          <span className="dsh-web-roster-name">{plugin.name}</span>
          <span className="dsh-web-roster-version">{plugin.version}</span>
          <span className="dsh-web-roster-state" {...(plugin.enabled ? { 'data-enabled': '' } : {})}>
            {plugin.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <span className="dsh-web-roster-note">
            {plugin.patch === undefined
              ? 'a plain dependency — it declares no composition layer, so there is nothing to turn on'
              : plugin.hasClient ? 'host rows and a browser surface' : 'host rows'}
          </span>
          <span className="dsh-web-roster-actions">
            <button
              type="button"
              disabled={busy !== undefined || plugin.patch === undefined}
              title={plugin.patch === undefined ? 'This package adds no rows to the composition.' : undefined}
              onClick={() => { void act(plugin, plugin.enabled ? 'disable' : 'enable') }}
            >
              {plugin.enabled ? 'Disable' : 'Enable'}
            </button>
            <button type="button" disabled={busy !== undefined} onClick={() => { void act(plugin, 'remove') }}>
              Remove
            </button>
          </span>
        </div>
      ))}
      {status !== undefined && (
        <div className="dsh-web-install-status" {...(status.error === true ? { 'data-error': '' } : {})}>
          {status.text}
        </div>
      )}
      {changed && (
        <div className="dsh-web-install-row">
          <button type="button" onClick={() => { location.reload() }}>Reload now</button>
          <span className="dsh-web-install-note">
            Until then this page is still running the composition it booted with.
          </span>
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
    register(
      options: { name: string, id: string, order?: number, label?: () => string },
      component: unknown,
    ): unknown
  } | undefined
  if (slots === undefined) return

  // Two tabs on the surface's own plugins page, where a user already goes to
  // see what is installed. Both carry a label and an order: the section renders
  // a tab button out of the label, so an entry without one is a blank button,
  // and the orders put these between the shipped "Plugin configuration" (0) and
  // "Plugin list" (10).
  const tabs = [
    { id: 'web-plugin-installed', order: 4, label: 'Installed', component: InstalledPanel },
    { id: 'web-plugin-install', order: 5, label: 'Add a plugin', component: InstallPanel },
  ]
  for (const tab of tabs) {
    slots.inject('settings.plugins.tab', () => slots.register(
      { name: 'settings.plugins.tab', id: tab.id, order: tab.order, label: () => tab.label },
      tab.component,
    ))
  }
}

export default { apply, inject }
