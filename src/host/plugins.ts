/**
 * The browser-side replacements the overlay patch mounts: the app-owned
 * command line, the web-surface runtime, and the process-confinement backend.
 *
 * Each one exists because the shipped row names a host capability a page does
 * not have. They are registered with the host module system under `browser:*`
 * specifiers, so the composition addresses them exactly like any npm plugin.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'
import { SandboxProvider, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import * as TypertLoaderBrowser from './typert-loader-browser.ts'

// ---- browser:web-startup ----------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Invocation-time Web values; upstream parses these from `dsh web` flags. */
    webStartup: WebStartupValues
    /** Bind-dependent Web values the trust fence and URL display read. */
    webRuntime: WebRuntimeValues
  }
}

/** The `webStartup` service shape the shipped rows read through `!!js` expressions. */
export interface WebStartupValues {
  host?: string
  port?: number
  trustedHosts: string[]
}

/** The `webRuntime` service shape. */
export interface WebRuntimeValues {
  lanAddresses: string[]
  trustedHosts: string[]
}

/**
 * Publishes `webStartup` from the page URL instead of a command line.
 *
 * The values feed rows that were written for a served deployment (the virtual
 * webserver's bind, the connection plugin's trust list); in a page the
 * authority is whatever origin served the app, and the trust fence is
 * vestigial because no request leaves the tab.
 */
export const webStartupPlugin = {
  name: 'browser-web-startup',
  apply(ctx: Context): void {
    const values: WebStartupValues = {
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: typeof location === 'undefined' ? [] : [location.host],
    }
    ctx.provide('webStartup', values)
  },
}

// ---- browser:web-runtime ----------------------------------------------------

/** Config of the browser web runtime. */
export interface WebRuntimeConfig {
  /** Register the model-visible surface orientation and the `DSH_WEB_*` shell variables. */
  surfaceContext: boolean
}

/** Orientation text for a session running inside the static browser build. */
function browserSurfacePrompt(): string {
  return 'You are interacting with the user through the DeepSeek Harness Web UI, running entirely inside their browser tab. '
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this UI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'There is no server process and no host machine: the filesystem you read and write is a virtual filesystem stored in the browser, '
    + 'shell commands run in an in-browser POSIX shell, and network access is limited to origins that permit cross-origin reads. '
    + 'Native toolchains (a system package manager, python, compilers) are not installed and cannot be installed. '
    + 'Do not offer to start a server or open a port; neither is reachable from here. '
    + 'Changes to files persist in the browser across reloads and can be exported by the user.'
}

/** The Web surface glue that still applies when the frontend is already loaded. */
export const webRuntimePlugin = {
  name: 'browser-web-runtime',
  inject: ['webStartup'],
  Config: z.object({ surfaceContext: z.boolean().default(true) }) as z<WebRuntimeConfig>,
  apply(ctx: Context, config: WebRuntimeConfig): void {
    const values: WebRuntimeValues = {
      lanAddresses: [],
      trustedHosts: ctx.webStartup.trustedHosts,
    }
    ctx.provide('webRuntime', values)
    if (!config.surfaceContext) return

    const url = typeof location === 'undefined' ? 'about:blank' : location.href
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: -98,
        text: () => browserSurfacePrompt(),
      })
    })
    ctx.inject(['shellEnv'], (envCtx) => {
      envCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          DSH_WEB_URL: { description: 'URL of the DeepSeek Harness Web UI serving this session.' },
          DSH_WEB_MODE: { description: 'How the Web UI is hosted; `browser` means there is no server process.' },
        },
        resolve: () => ({ DSH_WEB_URL: url, DSH_WEB_MODE: 'browser' }),
      })
    })
  },
}

// ---- browser:sandbox --------------------------------------------------------

/**
 * The process-confinement backend for the browser.
 *
 * A page has no Landlock, Seatbelt, or restricted token — and it does not need
 * one, because the boundary is already there: every command runs inside the
 * runtime, which is a sandbox with no host filesystem, no host process table,
 * and no network beyond what the page itself can reach. A command cannot escape
 * it by any argv this backend could write.
 *
 * So argv passes through unchanged, and the enforcement reported is what is
 * actually true rather than what would be convenient. That distinction is the
 * whole point of this seam: a backend claiming `full` while enforcing nothing
 * tells the permission layer — and the user reading a tool card — that a
 * dangerous command was contained when it was not.
 */
export class BrowserSandbox extends SandboxProvider {
  /**
   * Report the confinement the runtime provides.
   * @param argv - the exact argv about to be spawned.
   * @param policy - the file-effect policy for this execution.
   * @returns the argv and the enforcement it achieves.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    void policy
    return {
      argv: [...argv],
      // The runtime confines the process; this backend adds nothing on top of
      // it. The seam's vocabulary is `full` or `partial`, and this is `partial`:
      // a command cannot reach anything outside the runtime, and within it
      // `read-only` is not enforced — a command that writes will succeed. `full`
      // would tell the permission layer a dangerous command had been contained
      // when it had only been contained to the whole workspace.
      enforcement: 'partial',
      // Nothing here refuses a write, so there is no denial to recognise.
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

/**
 * The sandbox plugin module. A class's `name` is non-writable, so the Cordis
 * plugin name is set with `defineProperty` rather than assignment.
 */
Object.defineProperty(BrowserSandbox, 'name', { value: 'browser-sandbox', configurable: true })
export const browserSandboxPlugin = BrowserSandbox

/** Specifier → module namespace for everything the overlay mounts. */
export const BROWSER_PLUGINS: Record<string, unknown> = {
  'browser:web-startup': webStartupPlugin,
  'browser:web-runtime': webRuntimePlugin,
  'browser:sandbox': { default: browserSandboxPlugin, name: 'browser-sandbox' },
  'browser:typert-loader': TypertLoaderBrowser,
}

/** Re-exported so `boot.ts` can register the client-module table under the same scheme. */
export { Service }
