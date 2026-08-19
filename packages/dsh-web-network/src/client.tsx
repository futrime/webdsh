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
      <div className="dsh-web-network-field">
        <h3>CORS proxy</h3>
        <p>
          This page runs entirely in your browser, so it reaches a host only if that host sends CORS
          headers. Most do — the npm registry, DeepSeek, Anthropic, Google, OpenRouter. Some do not:
          OpenAI, NVIDIA, Cerebras and <code>codeload.github.com</code> all refuse a browser outright,
          and a request to them fails with <code>Failed to fetch</code> however it is written.
        </p>
        <p>
          When that happens, the request can be retried once through a proxy. The direct attempt is
          always made first, so a host that answers a browser never goes through one.
        </p>
        <p>
          One thing this does not reach: commands the agent runs. Those leave from the runtime's own
          worker, which the page cannot intercept, so the shell tool is instead <em>told</em> what is
          configured here — and it is told at page load, so a change below reaches the model on the
          next reload.
        </p>
      </div>

      <label className="dsh-web-network-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => { apply({ enabled: event.target.checked }) }}
        />
        <span>Retry a blocked request through the proxy below</span>
      </label>

      {!enabled && (
        <div className="dsh-web-network-warn">
          The default model is off with it. <code>opencode.ai/zen</code> — which serves the free tier
          this page starts on — refuses browsers like the rest, so with no proxy it cannot be reached.
          Pick a provider that answers a browser in Settings → Models, or turn the retry back on.
        </div>
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
        <p>
          <code>{'{url}'}</code> is replaced with the target address and <code>{'{encoded}'}</code> with
          its percent-encoded form, so both a prefix proxy
          (<code>https://host/{'{url}'}</code>) and one taking a query parameter
          (<code>https://host/?url={'{encoded}'}</code>) work. The default is{' '}
          <code>{bridge.defaults.template}</code>; <code>{bridge.defaults.alternative}</code> was
          measured to work the same way.
        </p>
        <p>
          Both of those public proxies buffer: a proxied reply arrives whole when the model finishes
          rather than a word at a time. The answer is the same, the wait just looks like nothing is
          happening. A proxy that streams fixes it, which is the reason to run your own — a
          Cloudflare Worker forwarding the request and returning <code>response.body</code> unread is
          enough, and it is also the only way this traffic stops passing through a stranger.
        </p>
      </div>

      <div className="dsh-web-network-warn">
        A proxy sees the whole request — the URL, the headers, and the body. That includes the API key
        on a model request routed through it. Only a host that refuses browsers is ever proxied, and
        no cookies are sent, but if you would not hand this traffic to the operator of{' '}
        <code>{template.trim() === '' ? bridge.defaults.template : template.trim()}</code>, turn the
        retry off above or point it at a proxy you run.
      </div>

      {used.length > 0 && (
        <div className="dsh-web-network-field">
          <h3>Proxied this session</h3>
          <p>Hosts that refused this browser directly and were reached through the proxy instead.</p>
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
  // goes to Models first, and this is the next thing they need.
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'network',
    order: 12,
    label: () => 'Network',
  }, NetworkSection))
}

export default { apply, inject }
