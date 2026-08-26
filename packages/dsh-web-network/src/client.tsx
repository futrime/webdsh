/**
 * The network plugin's browser half: the Network settings page.
 *
 * There is one setting on it, and it decides whether this page can reach most
 * of the internet at all. A tab's network reach is the browser's, and CORS is
 * the whole rule: a host answers only if it says so in its own headers. The
 * npm registry does. DeepSeek, Anthropic, Google, OpenRouter, Groq, Mistral,
 * Together, Moonshot, xAI and z.ai do. OpenAI, NVIDIA, Cerebras, Vercel's AI
 * gateway and `codeload.github.com` do not — every one of those was measured
 * from this page, and every one of them fails with `Failed to fetch` no matter
 * how the request is written.
 *
 * So the page has a fallback, and this is where a user decides what it is. The
 * app applies it automatically and only after a direct attempt has actually
 * failed; what this page adds is the choice of proxy, the ability to refuse one
 * entirely, and — the part a settings page owes a user routing their traffic
 * through a third party — a plain statement of what that costs.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** The CORS policy the app publishes. */
interface NetworkBridge {
  config(): { enabled: boolean, template: string }
  setConfig(next: { enabled?: boolean, template?: string }): { enabled: boolean, template: string }
  test(template?: string): Promise<{ ok: boolean, detail: string }>
  defaults: { template: string, alternative: string }
  proxied(): string[]
  /** The emulated machine's own route out, which the app publishes beside it. */
  machine?: MachineBridge
}

/** What the page offers the emulated machine, and what the machine did with it. */
interface MachineBridge {
  config(): { enabled: boolean, relay: string, allowSelf: boolean }
  setConfig(next: { enabled?: boolean, relay?: string, allowSelf?: boolean }): {
    enabled: boolean, relay: string, allowSelf: boolean
  }
  test(relay: string): Promise<{ ok: boolean, detail: string }>
  relays: { url: string, label: string, detail: string }[]
  traffic(): { requests: { url: string, status?: number, error?: string }[], refusedPorts: number[] }
}

/** Where the app publishes it. */
const BRIDGE = '__DSH_WEB_NETWORK__'

/** Read the policy the app published. */
function network(): NetworkBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE] as NetworkBridge | undefined
}

const STYLE = `
.dsh-web-network{display:flex;flex-direction:column;gap:1.1rem;padding:.5rem 0 1.5rem}
.dsh-web-network h3{margin:0;font-size:15px;font-weight:500}
.dsh-web-network p{margin:0;font-size:13px;line-height:1.65;opacity:.72}
.dsh-web-network code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
 background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.12));border-radius:.25rem;padding:.05rem .3rem}
.dsh-web-network-field{display:flex;flex-direction:column;gap:.4rem}
.dsh-web-network-field label{font-size:13px;font-weight:500}
.dsh-web-network-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.dsh-web-network-row input[type=text]{flex:1;min-width:18rem;padding:.45rem .6rem;border-radius:.5rem;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;
 font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-web-network button{font:inherit;font-size:13px;padding:.4rem .8rem;border-radius:.5rem;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit}
.dsh-web-network button:disabled{opacity:.5;cursor:default}
.dsh-web-network-toggle{display:flex;gap:.6rem;align-items:flex-start;cursor:pointer}
.dsh-web-network-toggle input{margin-top:.25rem}
.dsh-web-network-toggle span{font-size:13px;line-height:1.6}
.dsh-web-network-warn{font-size:13px;line-height:1.65;padding:.6rem .75rem;border-radius:.5rem;
 border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));
 background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.08))}
.dsh-web-network-status{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;
 padding:.5rem .6rem;border-radius:.5rem;background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.12))}
.dsh-web-network-status[data-error]{color:var(--dsw-alias-state-error-primary,#d33)}
.dsh-web-network-list{margin:0;padding-left:1.1rem;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8}
`


/**
 * The half of this page that is about the emulated machine.
 *
 * It is on the Network page rather than the Machine page deliberately: what a
 * guest can reach is decided by the same thing that decides what the tab can
 * reach — CORS, and the proxy above — and a user who has just read why
 * `Failed to fetch` happens should read here why the guest's `wget` says the
 * same thing.
 *
 * @returns the section, or nothing on a build with no emulator.
 */
function MachineNetwork(): JSX.Element | null {
  const bridge = network()?.machine
  const [enabled, setEnabled] = useState(() => bridge?.config().enabled ?? false)
  const [relay, setRelay] = useState(() => bridge?.config().relay ?? '')
  const [allowSelf, setAllowSelf] = useState(() => bridge?.config().allowSelf ?? false)
  const [status, setStatus] = useState<{ text: string, error?: boolean } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [traffic, setTraffic] = useState(() => bridge?.traffic() ?? { requests: [], refusedPorts: [] })

  // What the machine asked for changes while a guest is running, and nothing
  // announces it, so this is read the same way the proxied-origins list is.
  useEffect(() => {
    const timer = setInterval(() => {
      const api = network()?.machine
      if (api !== undefined) setTraffic(api.traffic())
    }, 2000)
    return () => { clearInterval(timer) }
  }, [])

  const save = useCallback((next: { enabled?: boolean, relay?: string, allowSelf?: boolean }) => {
    const api = network()?.machine
    if (api === undefined) return
    const applied = api.setConfig(next)
    setEnabled(applied.enabled)
    setAllowSelf(applied.allowSelf)
    if (next.relay !== undefined) setRelay(applied.relay)
    setStatus({
      text: !applied.enabled
        ? 'Saved. The machine keeps its network card and the cable goes nowhere. Restart it to apply.'
        : applied.relay === ''
          ? 'Saved. The page answers the machine itself, over HTTP. Restart the machine to apply.'
          : `Saved. The machine will use ${applied.relay}. Restart it to apply.`,
    })
  }, [])

  const probe = useCallback(async () => {
    const api = network()?.machine
    if (api === undefined) return
    setBusy(true)
    setStatus({ text: 'Testing…' })
    try {
      const result = await api.test(relay.trim())
      setStatus({ text: result.detail, error: !result.ok })
    } finally {
      setBusy(false)
    }
  }, [relay])

  if (bridge === undefined) return null

  return (
    <>
      <h3>Emulated machine</h3>

      <label className="dsh-web-network-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => { save({ enabled: event.target.checked }) }}
        />
        <span>Give it a network. Outbound only.</span>
      </label>

      <label className="dsh-web-network-toggle">
        <input
          type="checkbox"
          checked={allowSelf}
          onChange={event => { save({ allowSelf: event.target.checked }) }}
        />
        <span>Let it reach this page&apos;s own address</span>
      </label>

      <div className="dsh-web-network-field">
        <label htmlFor="dsh-web-network-relay">Relay</label>
        <div className="dsh-web-network-row">
          <input
            id="dsh-web-network-relay"
            type="text"
            value={relay}
            spellCheck={false}
            placeholder="empty — HTTP through this page"
            onChange={event => { setRelay(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') save({ relay: relay.trim() }) }}
          />
          <button type="button" disabled={busy} onClick={() => { save({ relay: relay.trim() }) }}>Save</button>
          <button type="button" disabled={busy} onClick={() => { void probe() }}>Test</button>
          <button type="button" disabled={busy} onClick={() => { save({ relay: '' }) }}>Clear</button>
        </div>
        <p>A WISP or websockproxy server, which carries every byte. Empty: HTTP through this page, no TLS.</p>
        <ul className="dsh-web-network-list">
          {bridge.relays.map(preset => (
            <li key={preset.url}>
              <button type="button" onClick={() => { setRelay(preset.url); save({ relay: preset.url }) }}>
                {preset.label}
              </button>{' '}
              <code>{preset.url}</code>
            </li>
          ))}
        </ul>
      </div>

      {traffic.requests.length > 0 && (
        <div className="dsh-web-network-field">
          <h3>The machine asked for</h3>
          <ul className="dsh-web-network-list">
            {traffic.requests.slice(-8).reverse().map((entry, index) => (
              <li key={`${entry.url}-${String(index)}`}>
                {entry.status === undefined ? '✗' : entry.status} {entry.url}
                {entry.error === undefined ? '' : ` — ${entry.error}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {traffic.refusedPorts.length > 0 && (
        <div className="dsh-web-network-warn">
          Port {traffic.refusedPorts.join(', ')} could not be carried without a relay.
        </div>
      )}

      {status !== undefined && (
        <div className="dsh-web-network-status" {...(status.error === true ? { 'data-error': '' } : {})}>
          {status.text}
        </div>
      )}
    </>
  )
}

/** The Network page. */
function NetworkSection(): JSX.Element {
  const bridge = network()
  const [enabled, setEnabled] = useState(() => bridge?.config().enabled ?? false)
  const [template, setTemplate] = useState(() => bridge?.config().template ?? '')
  const [status, setStatus] = useState<{ text: string, error?: boolean } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [used, setUsed] = useState<string[]>(() => bridge?.proxied() ?? [])

  // Which origins needed the proxy is learned as requests fail, so the answer
  // changes while the page is open. Polling is the honest shape for a value
  // the app never announces.
  useEffect(() => {
    const timer = setInterval(() => { setUsed(network()?.proxied() ?? []) }, 2000)
    return () => { clearInterval(timer) }
  }, [])

  const apply = useCallback((next: { enabled?: boolean, template?: string }) => {
    const api = network()
    if (api === undefined) {
      setStatus({ text: 'The network policy is not available in this build.', error: true })
      return
    }
    const applied = api.setConfig(next)
    setEnabled(applied.enabled)
    // Only when this change was about the URL. Toggling the checkbox must not
    // throw away a URL the user is halfway through typing — that edit is not
    // saved yet, which is exactly why it must still be on screen.
    if (next.template !== undefined) setTemplate(applied.template)
    setStatus({ text: applied.enabled ? `Saved. Blocked requests retry through ${applied.template}.` : 'Saved. Blocked requests now fail instead of being retried.' })
  }, [])

  const test = useCallback(async () => {
    const api = network()
    if (api === undefined) return
    setBusy(true)
    setStatus({ text: 'Testing…' })
    try {
      const result = await api.test(template.trim())
      setStatus({ text: result.detail, error: !result.ok })
    } finally {
      setBusy(false)
    }
  }, [template])

  if (bridge === undefined) {
    return (
      <div className="dsh-web-network">
        <p>This build publishes no network policy, so there is nothing to configure here.</p>
      </div>
    )
  }

  return (
    <div className="dsh-web-network">
      <h3>CORS proxy</h3>

      <label className="dsh-web-network-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => { apply({ enabled: event.target.checked }) }}
        />
        <span>Retry requests a host refuses. Direct is always tried first.</span>
      </label>

      {!enabled && (
        <div className="dsh-web-network-warn">The default free model needs this on.</div>
      )}

      <div className="dsh-web-network-field">
        <label htmlFor="dsh-web-network-template">Proxy URL</label>
        <div className="dsh-web-network-row">
          <input
            id="dsh-web-network-template"
            type="text"
            value={template}
            spellCheck={false}
            placeholder={bridge.defaults.template}
            onChange={event => { setTemplate(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') apply({ template: template.trim() }) }}
          />
          <button type="button" disabled={busy} onClick={() => { apply({ template: template.trim() }) }}>Save</button>
          <button type="button" disabled={busy} onClick={() => { void test() }}>Test</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { apply({ template: bridge.defaults.template }) }}
          >
            Reset
          </button>
        </div>
        <p><code>{'{url}'}</code> marks the target. The proxy sees the whole request.</p>
      </div>

      {used.length > 0 && (
        <div className="dsh-web-network-field">
          <h3>Proxied this session</h3>
          <ul className="dsh-web-network-list">
            {used.map(origin => <li key={origin}>{origin}</li>)}
          </ul>
        </div>
      )}

      {status !== undefined && (
        <div className="dsh-web-network-status" {...(status.error === true ? { 'data-error': '' } : {})}>
          {status.text}
        </div>
      )}

      <MachineNetwork />
    </div>
  )
}

/**
 * A globe, in the outline language the settings nav's glyphs use.
 *
 * This section is about what the page can reach, and the two things a reader
 * needs to tell apart at a glance are "settings about this app" and "settings
 * about the world outside it".
 * @param props - the class the shell lays its nav icons out with.
 * @returns the glyph.
 */
function NetworkIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className} width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.1" />
      <path d="M2.1 6.2h11.8" />
      <path d="M2.1 9.8h11.8" />
      <path d="M8 1.9c1.7 1.7 2.6 3.8 2.6 6.1S9.7 12.4 8 14.1C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.9Z" />
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

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-web-network-style') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-web-network-style'
    style.textContent = STYLE
    document.head.append(style)
  }
  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string, order?: number, label?: () => string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  // Between Models (10) and Plugins (15): a user who cannot reach a provider
  // goes to Models first, and this is the next thing they need. The glyph goes
  // in beside the label so this row does not read as a second General.
  navGlyph('network', className => <NetworkIcon className={className} />)
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'network',
    order: 12,
    label: () => 'Network',
  }, NetworkSection))
}

export default { apply, inject }
