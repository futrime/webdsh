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
import * as PluginCommand from './plugin-command.ts'

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

/** The shell guard this backend wraps every confined command in. */
const DSH_CONFINE = 'dsh-confine'

/**
 * The process-confinement backend for the browser.
 *
 * A page has no Landlock, Seatbelt, or restricted token, but it does have a
 * boundary the OS backends do not: every file effect a command can produce
 * lands in the virtual filesystem. Rather than pass argv through unconfined —
 * which the seam forbids — this backend prefixes it with the shell's own
 * `dsh-confine` guard, which enforces the mode's writable roots for the
 * duration of that command.
 */
export class BrowserSandbox extends SandboxProvider {
  /**
   * Wrap argv under the shell's confinement guard.
   * @param argv - the exact argv about to be spawned.
   * @param policy - the file-effect policy for this execution.
   * @returns the guarded argv and the enforcement it achieves.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [DSH_CONFINE, policy.mode, policy.workspaceRoot, '--', ...argv],
      // Full for file effects, which is the vocabulary this seam governs: no
      // command can write outside the permitted roots of the virtual
      // filesystem. Network reachability is the browser's own origin policy and
      // is outside this seam either way.
      enforcement: 'full',
      // The exact stderr this backend emits when it refuses a write. A consumer
      // that infers denials from stderr matches these and nothing else.
      denialSignatures: ['denied by the read-only sandbox policy', 'denied by the workspace-write sandbox policy'],
      // The guard itself can fail before the wrapped command runs: an
      // unrecognized mode. That is runner failure, not denial.
      runnerFailureRules: [{
        fatalSignatures: [`${DSH_CONFINE}: unknown mode`],
        allowedExitCodes: [2],
        informationalLines: [],
      }],
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
  'browser:plugin-command': PluginCommand,
}

/** Re-exported so `boot.ts` can register the client-module table under the same scheme. */
export { Service }
