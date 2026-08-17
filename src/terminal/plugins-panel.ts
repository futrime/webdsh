/**
 * The plugin inventory, with somewhere to install from.
 *
 * The shipped Settings page lists what is installed but has no way to add
 * anything: on a machine that is `dsh plugin add` in a shell, and there is no
 * shell outside this page. So the inventory lives next to the terminal, and it
 * accepts every source the installer does — a registry name, a tarball URL, a
 * GitHub repository, a path in this filesystem, or a file dropped in from the
 * user's own machine.
 *
 * Composition is fixed at boot, so enabling, disabling, or adding a plugin ends
 * with a reload; the panel says so rather than leaving the list looking applied
 * when it is not.
 */

import type { PluginManager } from '../plugins/manager.ts'
import { volume } from '../vfs/volume.ts'
import { dirname } from '../node/path.ts'

/** Where an uploaded tarball is staged before the installer reads it. */
const UPLOAD_DIR = '/tmp/dsh-plugin-uploads'

const STYLE = `
.dshp-panel{position:fixed;right:1rem;bottom:4.5rem;width:min(30rem,calc(100vw - 2rem));max-height:min(70vh,40rem);
 z-index:2147482090;display:none;flex-direction:column;border-radius:.75rem;overflow:hidden;
 background:#181b22;color:#dfe3ea;border:1px solid rgba(127,127,127,.3);box-shadow:0 8px 32px rgba(0,0,0,.4);
 font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dshp-panel[data-open]{display:flex}
.dshp-head{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;border-bottom:1px solid rgba(127,127,127,.2)}
.dshp-head strong{flex:1;font-size:13px}
.dshp-add{display:flex;gap:.4rem;padding:.6rem .8rem;border-bottom:1px solid rgba(127,127,127,.2);flex-wrap:wrap}
.dshp-add input[type=text]{flex:1;min-width:12rem;background:rgba(0,0,0,.3);border:1px solid rgba(127,127,127,.35);
 color:inherit;border-radius:.4rem;padding:.35rem .5rem;font:inherit}
.dshp-note{padding:0 .8rem .5rem;opacity:.55;font-size:11.5px;line-height:1.5}
.dshp-list{flex:1;overflow:auto;padding:.3rem 0}
.dshp-row{display:flex;align-items:center;gap:.5rem;padding:.4rem .8rem}
.dshp-row:hover{background:rgba(127,127,127,.1)}
.dshp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshp-ver{opacity:.5;font-size:11.5px}
.dshp-tag{font-size:10.5px;border:1px solid rgba(127,127,127,.4);border-radius:999px;padding:0 .4rem;opacity:.75}
.dshp-panel button{font:inherit;font-size:12px;background:transparent;border:1px solid rgba(127,127,127,.4);
 color:inherit;border-radius:.35rem;padding:.15rem .5rem;cursor:pointer}
.dshp-panel button:hover:not(:disabled){background:rgba(127,127,127,.2)}
.dshp-panel button:disabled{opacity:.45;cursor:default}
.dshp-status{padding:.5rem .8rem;border-top:1px solid rgba(127,127,127,.2);font-size:11.5px;white-space:pre-wrap;
 max-height:8rem;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshp-status[data-error]{color:#ff8f8f}
.dshp-empty{padding:1rem .8rem;opacity:.55}
`

/** The panel's control surface. */
export interface PluginsPanel {
  open(): void
  close(): void
  toggle(): void
}

/** Ensure the stylesheet is present exactly once. */
function ensureStyle(): void {
  if (document.getElementById('dshp-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshp-style'
  style.textContent = STYLE
  document.head.append(style)
}

/**
 * Build and attach the plugin panel.
 * @param manager - the installed plugin manager.
 * @returns the panel's control surface.
 */
export function installPluginsPanel(manager: PluginManager): PluginsPanel {
  ensureStyle()

  const panel = document.createElement('div')
  panel.className = 'dshp-panel'
  panel.innerHTML = `
    <div class="dshp-head">
      <strong>Plugins</strong>
      <button type="button" data-act="reload">Reload page</button>
      <button type="button" data-act="close">Close</button>
    </div>
    <div class="dshp-add">
      <input type="text" placeholder="package, URL, owner/repo, or /path" aria-label="Plugin source">
      <button type="button" data-act="install">Install</button>
      <button type="button" data-act="upload">From file…</button>
      <input type="file" accept=".tgz,.tar.gz,application/gzip,application/x-gzip" hidden>
    </div>
    <p class="dshp-note">Accepts an npm name (<code>dshmarket</code>), a tarball URL,
      <code>owner/repo#ref</code>, or a path in this filesystem. Composition is fixed at boot,
      so changes take effect after a reload.</p>
    <div class="dshp-list"></div>
    <div class="dshp-status" hidden></div>`

  document.body.append(panel)

  const list = panel.querySelector('.dshp-list') as HTMLElement
  const status = panel.querySelector('.dshp-status') as HTMLElement
  const input = panel.querySelector('input[type=text]') as HTMLInputElement
  const file = panel.querySelector('input[type=file]') as HTMLInputElement

  const say = (message: string, isError = false): void => {
    status.hidden = false
    status.textContent = message
    if (isError) status.setAttribute('data-error', '')
    else status.removeAttribute('data-error')
  }

  /** Re-render the inventory from the roster. */
  const render = (): void => {
    const plugins = manager.list()
    list.textContent = ''
    if (plugins.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'dshp-empty'
      empty.textContent = 'Nothing installed yet.'
      list.append(empty)
      return
    }
    for (const plugin of plugins) {
      const row = document.createElement('div')
      row.className = 'dshp-row'

      const name = document.createElement('span')
      name.className = 'dshp-name'
      name.textContent = plugin.name
      const version = document.createElement('span')
      version.className = 'dshp-ver'
      version.textContent = plugin.version
      row.append(name, version)

      if (plugin.hasClient) {
        const tag = document.createElement('span')
        tag.className = 'dshp-tag'
        tag.textContent = 'UI'
        row.append(tag)
      }

      const toggle = document.createElement('button')
      toggle.textContent = plugin.enabled ? 'Disable' : 'Enable'
      toggle.addEventListener('click', () => {
        void act(
          async () => { await (plugin.enabled ? manager.disable(plugin.name) : manager.enable(plugin.name)) },
          `${plugin.enabled ? 'Disabled' : 'Enabled'} ${plugin.name}. Reload to apply.`,
        )
      })

      const remove = document.createElement('button')
      remove.textContent = 'Remove'
      remove.addEventListener('click', () => {
        void act(async () => { await manager.remove(plugin.name) }, `Removed ${plugin.name}. Reload to apply.`)
      })

      row.append(toggle, remove)
      list.append(row)
    }
  }

  /** Run an action, reporting progress and refreshing the list. */
  const act = async (body: () => Promise<void>, done: string): Promise<void> => {
    const buttons = [...panel.querySelectorAll('button')]
    for (const button of buttons) button.disabled = true
    try {
      await body()
      say(done)
      render()
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true)
    } finally {
      for (const button of buttons) button.disabled = false
    }
  }

  const installSpec = (spec: string): void => {
    if (spec.trim() === '') return
    say(`Installing ${spec}…`)
    void act(async () => {
      const entry = await manager.install(spec.trim())
      input.value = ''
      say(
        `Installed ${entry.name}@${entry.version}.`
        + `${entry.patch === undefined ? ' It declares no composition layer.' : ''}`
        + ' Reload to apply.',
      )
    }, '')
  }

  panel.querySelector('[data-act="install"]')?.addEventListener('click', () => { installSpec(input.value) })
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') installSpec(input.value) })
  panel.querySelector('[data-act="upload"]')?.addEventListener('click', () => { file.click() })
  panel.querySelector('[data-act="close"]')?.addEventListener('click', () => { panel.removeAttribute('data-open') })
  panel.querySelector('[data-act="reload"]')?.addEventListener('click', () => { location.reload() })

  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    if (picked === undefined) return
    say(`Reading ${picked.name}…`)
    void picked.arrayBuffer().then((buffer) => {
      // Staged into the filesystem first so the installer sees exactly the same
      // shape it would for any other local path.
      const path = `${UPLOAD_DIR}/${picked.name}`
      volume.mkdirp(dirname(path))
      volume.writeFile(path, new Uint8Array(buffer))
      file.value = ''
      installSpec(path)
    })
  })

  render()

  return {
    open() { panel.setAttribute('data-open', ''); render(); input.focus() },
    close() { panel.removeAttribute('data-open') },
    toggle() {
      if (panel.hasAttribute('data-open')) panel.removeAttribute('data-open')
      else { panel.setAttribute('data-open', ''); render(); input.focus() }
    },
  }
}
