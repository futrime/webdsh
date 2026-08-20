/**
 * `window.dsh` — the page-level control surface.
 *
 * Everything the UI does goes through the normal client transport; this object
 * exists for the things a GUI has no place for: driving the app from the
 * console or an automated browser, exporting and importing the virtual
 * filesystem, and forcing a durability flush. The plugin manager attaches
 * itself here too.
 */

import type { Context } from '@deepseek-ai/cordis'
import { runShell, type RunResult } from './shell/index.ts'
import { execute as executeInRuntime, runtimeReady, runtimePersistence, runtimePythonPersistence } from './runtime/webcontainer.ts'
import { volume } from './vfs/volume.ts'
import { toBytes, toText } from './node/binary.ts'
import type { PersistenceHandle } from './vfs/persist.ts'
import { zipSync, unzipSync } from 'fflate'
import { dirname } from './vfs/path.ts'
import { WORKSPACE_ROOT } from './host/seed.ts'

/** The object published at `window.dsh`. */
export interface DshWindowApi {
  /** The settled host context (advanced use; the UI never needs it). */
  ctx: Context
  /** Run a shell script against the virtual filesystem. */
  shell(script: string, options?: { cwd?: string }): Promise<RunResult>
  /** Force every pending virtual-filesystem write to reach durable storage. */
  flush(): Promise<void>
  /** Read a file out of the virtual filesystem. */
  readFile(path: string): string
  /** Write a file into the virtual filesystem. */
  writeFile(path: string, contents: string): void
  /** Download the whole virtual filesystem as a zip. */
  exportFs(prefix?: string): Promise<Blob>
  /** Restore a previously exported zip. */
  importFs(data: ArrayBuffer, prefix?: string): number
  /** Erase all browser-stored state and reload. */
  reset(): Promise<void>
  /**
   * Send one prompt through a fresh session and return the assistant's reply
   * text. `agentPreset` composes that session from a named preset rather than
   * the deployment's default — which is how a check can ask what a preset
   * other than the default one puts in front of the model.
   */
  promptOnce(apiKey: string, text: string, agentPreset?: string): Promise<string>
}

/** Files that belong to the build rather than the user; excluded from exports. */
const EXPORT_EXCLUDE = ['/opt/dsh/bundles', '/opt/dsh/config', '/opt/dsh/cordis.yml', '/bin', '/usr']

/**
 * Publish the control surface.
 * @param ctx - the settled host context.
 * @param persistence - the virtual filesystem's durability handle.
 * @returns the published object.
 */
export function installWindowApi(ctx: Context, persistence: PersistenceHandle): DshWindowApi {
  const api: DshWindowApi = {
    ctx,

    async shell(script, options) {
      // The page's own machine, which on the default runtime is the container
      // the agent's tool calls also run in — running this against the in-page
      // shell while tool calls ran in the container would make it a liar.
      //
      // Under an emulated runtime the two are deliberately different things.
      // This still runs the page's shell over the page's filesystem, which is
      // where the workspace and the agent's file tools are; the emulated
      // machine has its own disk and its own console, and is reached through
      // `window.__DSH_WEB_MACHINE__.console`.
      if (await runtimeReady()) {
        const result = await executeInRuntime(script, { cwd: options?.cwd ?? WORKSPACE_ROOT })
        return { status: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false }
      }
      return runShell(script, { cwd: options?.cwd ?? WORKSPACE_ROOT })
    },

    async flush() {
      await Promise.all([persistence.flush(), runtimePersistence()?.flush(), runtimePythonPersistence()?.flush()])
    },

    readFile(path) {
      return toText(volume.readFile(path))
    },

    writeFile(path, contents) {
      volume.mkdirp(dirname(path))
      volume.writeFile(path, toBytes(contents))
    },

    async exportFs(prefix = WORKSPACE_ROOT) {
      const entries: Record<string, Uint8Array> = {}
      for (const [path, node] of volume.walkTree(prefix)) {
        if (node.kind !== 'file') continue
        if (EXPORT_EXCLUDE.some(excluded => path === excluded || path.startsWith(`${excluded}/`))) continue
        entries[path.replace(/^\//, '')] = volume.readFile(path)
      }
      await persistence.flush()
      return new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' })
    },

    importFs(data, prefix = '/') {
      const files = unzipSync(new Uint8Array(data))
      let count = 0
      for (const [name, bytes] of Object.entries(files)) {
        if (name.endsWith('/')) continue
        const path = `${prefix.replace(/\/$/, '')}/${name}`
        volume.mkdirp(dirname(path))
        volume.writeFile(path, bytes)
        count++
      }
      return count
    },

    async reset() {
      await Promise.all([persistence.clear(), runtimePersistence()?.clear(), runtimePythonPersistence()?.clear()])
      localStorage.clear()
      location.reload()
    },

    async promptOnce(apiKey, text, agentPreset) {
      return promptOnce(ctx, apiKey, text, agentPreset)
    },
  }

  const surface = (globalThis as { dsh?: Record<string, unknown> }).dsh ?? {}
  Object.assign(surface, api)
  ;(globalThis as { dsh?: Record<string, unknown> }).dsh = surface
  return api
}

/**
 * Drive one complete model turn through the host's own API proxy.
 *
 * This is the transport the browser client uses, so a green result here means
 * the whole chain works: credentials, the DeepSeek adapter, the agent loop, the
 * session log, and the event stream.
 * @param ctx - the settled host context.
 * @param apiKey - a DeepSeek API key, stored in the managed credential document.
 * @param text - the prompt to send.
 * @param agentPreset - the preset to compose the session from; the deployment's default when absent.
 * @returns the concatenated assistant text.
 */
async function promptOnce(ctx: Context, apiKey: string, text: string, agentPreset?: string): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('credentials service unavailable')
  await (credentials as { set(reference: string, value: string): Promise<void> }).set('DEEPSEEK_API_KEY', apiKey)

  const proxy = ctx.get('apiProxy') as {
    sessions: {
      create(request: { rpcId: string, payload: Record<string, unknown> }): Promise<{ result: { ok: boolean, value?: { sessionId: string }, error?: unknown } }>
      prompt(request: { rpcId: string, payload: Record<string, unknown> }): Promise<{ result: { ok: boolean, error?: unknown } }>
    }
    events: {
      mux(request: { rpcId: string, payload: Record<string, never> }, signal?: AbortSignal): AsyncIterable<{ payload: Record<string, unknown> }>
    }
  } | undefined
  if (proxy === undefined) throw new Error('apiProxy service unavailable')

  const created = await proxy.sessions.create({
    rpcId: crypto.randomUUID(),
    payload: agentPreset === undefined ? {} : { agentPreset },
  })
  if (!created.result.ok || created.result.value === undefined) {
    throw new Error(`session.create failed: ${JSON.stringify(created.result.error)}`)
  }
  const { sessionId } = created.result.value

  const abort = new AbortController()
  const frames = proxy.events.mux({ rpcId: crypto.randomUUID(), payload: {} }, abort.signal)
  let reply = ''
  const collected = (async () => {
    for await (const frame of frames) {
      // Frame shape: session/event → event.type → event.data. Text deltas are
      // `assistant/chunk` with a `text-delta` chunk; reasoning deltas are a
      // separate block type and are deliberately not collected here.
      const payload = frame.payload as {
        type?: string
        event?: { type?: string, data?: { chunk?: { type?: string, text?: string } } }
      }
      const event = payload.event
      if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
        reply += event.data.chunk.text ?? ''
      }
      if (event?.type === 'turn/end') break
    }
  })()

  const prompted = await proxy.sessions.prompt({
    rpcId: crypto.randomUUID(),
    payload: { sessionId, content: [{ type: 'text', text }] },
  })
  if (!prompted.result.ok) throw new Error(`session.prompt failed: ${JSON.stringify(prompted.result.error)}`)

  await Promise.race([collected, new Promise(resolve => setTimeout(resolve, 120_000))])
  abort.abort()
  return reply
}
