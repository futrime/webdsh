/**
 * Assemble the static inputs the browser host needs, from the published
 * `@deepseek-ai/*` packages in `node_modules`.
 *
 * Nothing here is hand-maintained: the plugin roster, the client-bundle
 * manifest, the host module map, and the seeded configuration files are all
 * derived from the installed packages, so bumping the dsh dependency range and
 * re-running `npm run assemble` is the whole upgrade procedure.
 *
 * Outputs:
 * - `public/plugins/<pkg>/client.js`  — each client half, served as a static asset
 * - `public/shell/**`                 — the published web frontend, with root-absolute URLs rewritten
 * - `src/generated/client-manifest.ts`— the `window.__DSH_BOOT__` rows
 * - `src/generated/host-modules.ts`   — specifier → dynamic import, for the host module system
 * - `src/generated/seed-files.ts`     — VFS seed (bundle patches, agent presets)
 * - `src/generated/model-catalog.ts`  — the provider routes the overlay registers
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FREE_ROUTES, loadRoster, type FreeModel } from './free-routes.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const modules = join(root, 'node_modules')
const scope = join(modules, '@deepseek-ai')
const publicDir = join(root, 'public')
const generated = join(root, 'src', 'generated')

/** Absolute VFS path the seeded deployment files land under. */
const DEPLOY_ROOT = '/opt/dsh'

/** Short content hash used as a bundle revision, matching upstream's scheme. */
function shortHash(input: Buffer | string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Read a JSON file. */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Resolve `exports["./client"]` to a relative path, accepting both shapes upstream allows. */
function clientExportOf(pkg: Record<string, unknown>): string | undefined {
  const exportsField = pkg.exports
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

/** One client-half package discovered in `node_modules`. */
interface ClientPackage {
  id: string
  inject: string[]
  external: string[]
  immediately: boolean
  source: string
}

/**
 * Scan for packages declaring a web client half.
 *
 * Two roots, for the same reason a machine has two: the installed
 * `@deepseek-ai` scope is the surface's own roster, and `packages/` is where
 * this repository keeps the plugins it ships. A plugin it wrote is not a
 * different kind of thing from one it installed, so it is discovered the same
 * way and emitted into the same roster.
 * @returns every client half found, in a stable order.
 */
function scanClientPackages(): ClientPackage[] {
  const found: ClientPackage[] = []
  const roots = [scope, join(root, 'packages')].filter(directory => existsSync(directory))
  for (const container of roots) {
  for (const name of readdirSync(container)) {
    const manifest = join(container, name, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = readJson(manifest)
    const dsh = pkg.dsh
    if (typeof dsh !== 'object' || dsh === null) continue
    const declaration = (dsh as Record<string, unknown>).client
    if (typeof declaration !== 'object' || declaration === null) continue
    const spec = declaration as { platform?: string, inject?: string[], external?: string[], immediately?: boolean }
    if (spec.platform !== 'web') continue
    const relativeClient = clientExportOf(pkg)
    if (relativeClient === undefined) {
      console.warn(`[assemble] ${String(pkg.name)} declares dsh.client but exports no "./client"; skipping`)
      continue
    }
    const source = join(container, name, relativeClient)
    if (!existsSync(source)) {
      console.warn(`[assemble] ${String(pkg.name)} client bundle missing at ${source}; skipping`)
      continue
    }
    found.push({
      id: String(pkg.name),
      inject: spec.inject ?? [],
      external: spec.external ?? [],
      immediately: spec.immediately === true,
      source,
    })
  }
  }
  return orderByModuleGraph(found.sort((a, b) => a.id.localeCompare(b.id)))
}

/**
 * Order rows so a package another one requires at runtime is registered first.
 *
 * The shell's loader walks `external` when a row arrives and expects to find
 * every named package already registered or reachable, so the graph a static
 * build publishes has to be topologically sorted the same way upstream's node
 * half sorts it. A name that is not a row here is a static-table word (React,
 * the primitives package) and adds no edge.
 * @param entries - the scanned rows, in name order.
 * @returns the same rows, dependencies first, name order breaking every tie.
 */
function orderByModuleGraph(entries: ClientPackage[]): ClientPackage[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const ordered: ClientPackage[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (entry: ClientPackage): void => {
    if (placed.has(entry.id)) return
    const cycle = open.indexOf(entry.id)
    if (cycle !== -1) {
      throw new Error(`assemble: client module graph cycle ${[...open.slice(cycle), entry.id].join(' -> ')}`)
    }
    open.push(entry.id)
    for (const name of entry.external) {
      const bare = name.endsWith('/client') ? name.slice(0, -'/client'.length) : name
      const dependency = byId.get(name) ?? byId.get(bare)
      if (dependency === entry) {
        throw new Error(`assemble: ${entry.id} names itself in dsh.client.external`)
      }
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

/**
 * The settings shell picks each nav glyph from a fixed list of section ids and
 * gives everything else the gear.
 *
 * That is a reasonable default and a poor outcome here, because this
 * deployment contributes two whole sections — Machine and Network — and a nav
 * column with three identical gears in it tells a reader that the three rows
 * are the same kind of thing. They are not: one is preferences, one is which
 * computer the agent runs on, one is how the page reaches the internet.
 *
 * Upstream offers no seam for it, so this adds the smallest one that could
 * work: before its own list, `navIcon` asks a table on `globalThis` whether
 * the section brought its own glyph. Nothing is drawn here — the glyph lives
 * in the plugin that owns the section, next to the label it owns, which is
 * where it would live if upstream had shipped the seam itself.
 */
const NAV_ICON_MARKER = 'function navIcon(id) {'

/**
 * Open the nav-glyph seam in the settings shell's bundle.
 *
 * A rewrite of somebody else's build output is only safe if it fails loudly
 * when their build changes, so this insists on exactly one marker rather than
 * quietly matching none.
 * @param id - the package the bundle belongs to.
 * @param source - its published bundle.
 * @returns the bundle, patched if it is the one that draws the nav.
 */
function patchClientBundle(id: string, source: string): string {
  if (id !== '@deepseek-ai/dsh-client-ui-settings-general') return source
  const found = source.split(NAV_ICON_MARKER).length - 1
  if (found !== 1) {
    throw new Error(
      `assemble: expected one \`${NAV_ICON_MARKER}\` in ${id} and found ${String(found)}`
      + ' — the settings nav has been reshaped upstream, so the glyph seam needs re-cutting',
    )
  }
  // On one line, so the source map beside the bundle keeps pointing at the
  // right lines of upstream's source for everything after it.
  const seam = 'const contributed = globalThis.__DSH_SETTINGS_NAV_ICON__?.[id];'
    + ' if (typeof contributed === "function") return contributed(SettingsRoot_module_css_default.navIcon);'
  return source.replace(NAV_ICON_MARKER, `${NAV_ICON_MARKER} ${seam}`)
}

/** Copy every client bundle into `public/plugins/` and return its manifest row. */
function emitClientBundles(packages: ClientPackage[]): { id: string, url: string, rev: string, inject: string[], external: string[], immediately: boolean }[] {
  const target = join(publicDir, 'plugins')
  rmSync(target, { recursive: true, force: true })
  return packages.map((entry) => {
    const bytes = Buffer.from(patchClientBundle(entry.id, readFileSync(entry.source, 'utf8')), 'utf8')
    const rev = shortHash(bytes)
    const destination = join(target, entry.id, 'client.js')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
    // A source map beside the bundle keeps stack traces readable in devtools.
    if (existsSync(`${entry.source}.map`)) {
      writeFileSync(`${destination}.map`, readFileSync(`${entry.source}.map`))
    }
    return {
      id: entry.id,
      url: `plugins/${entry.id}/client.js?rev=${rev}`,
      rev,
      inject: entry.inject,
      external: entry.external,
      immediately: entry.immediately,
    }
  })
}

/**
 * Copy the published web frontend into `public/shell/`, rewriting the
 * root-absolute URLs its build emitted so the app works under a GitHub Pages
 * project path. Only `index.html` and the CSS font references carry them —
 * rollup emits relative specifiers between JS chunks.
 */
function emitShell(): { entry: string, styles: string[] } {
  const source = join(scope, 'dsh-web-frontend', 'dist')
  const target = join(publicDir, 'shell')
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })

  // Rewrite `url(/assets/fonts/…)` to a path relative to the stylesheet.
  const assets = join(target, 'assets')
  for (const name of readdirSync(assets)) {
    if (!name.endsWith('.css')) continue
    const path = join(assets, name)
    const css = readFileSync(path, 'utf8').replaceAll('url(/assets/', 'url(./')
    writeFileSync(path, css)
  }

  const html = readFileSync(join(target, 'index.html'), 'utf8')
  const entry = /<script[^>]+src="\/([^"]+)"/.exec(html)?.[1]
  if (entry === undefined) throw new Error('assemble: could not find the shell entry script in the published index.html')
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+)"/g)].map(match => match[1])
  // The published index.html is not used directly — this package generates its
  // own so the boot script can run before the shell — but keeping it copied
  // makes the dist self-describing.
  return { entry: `shell/${entry}`, styles: styles.map(href => `shell/${href}`) }
}

/**
 * Packages exporting a Typert host manifest (`exports["./typert"]`).
 *
 * Upstream's loader finds these by resolving each package on disk and importing
 * the artifact by file URL, which a browser cannot do — so the map is resolved
 * at build time instead and the browser loader consumes it directly.
 */
function scanTypertPackages(): string[] {
  const found: string[] = []
  for (const name of readdirSync(scope)) {
    const manifest = join(scope, name, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = readJson(manifest)
    const exportsField = pkg.exports
    if (typeof exportsField !== 'object' || exportsField === null) continue
    if ((exportsField as Record<string, unknown>)['./typert'] === undefined) continue
    found.push(String(pkg.name))
  }
  return found.sort()
}

/** Recursively collect files under `dir` as `[vfsPath, contents]`. */
function collectTree(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...collectTree(path, `${prefix}/${name}`))
      continue
    }
    out.push([`${prefix}/${name}`, readFileSync(path, 'utf8')])
  }
  return out
}

/** Every `name:` a composition file mounts, so the host module map can cover it. */
function specifiersIn(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*(?:-\s+)?name:\s*'?"?([^'"\n]+)'?"?\s*$/gm)]
    .map(match => match[1].trim())
    // `cordis:` rows are loader builtins; `browser:` rows are this package's own
    // plugins, registered with the host module system rather than resolved.
    .filter(name => name.length > 0 && !name.startsWith('cordis:') && !name.startsWith('browser:'))
}

/** Build the seed file table and the composition specifier set. */
function emitSeed(): { files: [string, string][], specifiers: Set<string> } {
  const files: [string, string][] = []
  const specifiers = new Set<string>()

  // Bundle patches: the layers the boot include applies over an empty root.
  for (const bundle of ['dsh-base', 'dsh-web-app']) {
    const patch = join(scope, bundle, 'cordis.patch.yml')
    if (!existsSync(patch)) throw new Error(`assemble: missing bundle patch ${patch}`)
    const text = readFileSync(patch, 'utf8')
    files.push([`${DEPLOY_ROOT}/bundles/${bundle}/cordis.patch.yml`, text])
    for (const name of specifiersIn(text)) specifiers.add(name)
  }

  // Agent presets shipped by the CLI package.
  const presets = join(scope, 'dsh', 'config', 'agent-presets')
  if (existsSync(presets)) {
    let replaced = 0
    for (const [path, original] of collectTree(presets, `${DEPLOY_ROOT}/config/agent-presets`)) {
      const contents = path.endsWith('.cordis.yml')
        ? replaceBashTool(original)
        : path.endsWith('preset.yml') ? describeWithoutBash(original) : original
      if (path.endsWith('.cordis.yml')) {
        if (contents !== original) replaced++
        // The guard, not the rewrite: whatever shapes the rewrite knows about,
        // what ships must mount no bash at all. A preset that keeps one puts a
        // shell tool in front of the model that this machine cannot honour, and
        // the only reliable moment to notice is before it is seeded.
        for (const forbidden of BASH_BACKED) {
          if (!contents.includes(`name: '${forbidden}'`)) continue
          throw new Error(`assemble: ${path} still mounts ${forbidden}; the model would be offered a bash tool this deployment has no bash for`)
        }
        // Only composition files carry plugin rows; `preset.yml` carries display metadata.
        for (const name of specifiersIn(contents)) specifiers.add(name)
      }
      files.push([path, contents])
    }
    if (replaced === 0) throw new Error('assemble: no agent preset mounted a bash tool; the shell replacement did not apply')
    console.log(`[assemble] ${String(replaced)} agent preset(s) now mount this machine's tool row`)
  } else {
    console.warn('[assemble] @deepseek-ai/dsh is not installed; no agent presets will ship')
  }

  return { files, specifiers }
}

/**
 * The preset row that mounts the model's shell tool, and what to mount instead.
 *
 * `tool-bash` appears in two different compositions. The host plane's copy is
 * disabled by `src/host/browser.patch.yml`; this is the other one, in each
 * agent preset's `agent.cordis.yml` — a composition no host patch layer sees.
 * Disabling only the first leaves the loader reporting `tool-bash
 * disabled=true` while every model request still carries a `bash` tool, which
 * is exactly what happened.
 *
 * So the row is rewritten here, at the point the preset is seeded. See
 * `src/host/jsh-tool.ts` for why the shell tool has to be replaced rather than
 * left alone.
 */
const BASH_ROW = /^(\s*)- id: tool-bash\n\s*name: '@deepseek-ai\/dsh-tool-bash'\n(?:\s*disabled:[^\n]*\n)?/m

/**
 * The other shape, and the reason this file grew a second pattern.
 *
 * `minimal` mounts no `tool-bash` row at all. It builds a persistent shell out
 * of three rows in a realm of its own — a PTY registry, a bash backend, and
 * `dsh-tool-bash-persistent`, which is the tool the model sees — and calls it
 * `bash`, complete with a description promising apt and pip. The row-shaped
 * rewrite above never touched it, so that preset kept handing the model a bash
 * this machine does not have.
 *
 * The whole group goes, because every row in it exists to back that one tool
 * and none of them can work here. What replaces it is the same jsh row the
 * other presets get: the preset stays what it advertises, a shell and an
 * editor, and the shell is the one the machine actually runs.
 */
const PERSISTENT_SHELL_GROUP = /(?:^#[^\n]*\n)*^- id: persistent-shell\n(?:.*\n)*?(?=^[#-])/m

/** The same claim, made in prose at the top of that preset's composition. */
const PERSISTENT_SHELL_PROSE = /persistent `bash` and `str_replace_editor`/

/** Shell tools this deployment has no interpreter for, in preset row form. */
const BASH_BACKED = [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-terminal-bash',
]

/**
 * Swap a preset's bash tool for this deployment's jsh tool.
 * @param contents - the preset composition.
 * @returns the same composition with the shell rows replaced.
 */
function replaceBashTool(contents: string): string {
  return contents
    .replace(BASH_ROW, (_match, indent: string) =>
      `${indent}# Replaced by scripts/assemble.ts: the tools of whichever machine this\n`
      + `${indent}# session runs — jsh in the container, the emulated PC's own console,\n`
      + `${indent}# keyboard and screen under v86. See src/host/machine-tools.ts.\n`
      + `${indent}- id: tool-machine\n${indent}  name: 'browser:machine'\n`)
    .replace(PERSISTENT_SHELL_GROUP,
      '# Replaced by scripts/assemble.ts: this machine\'s shell is jsh, and there is\n'
      + '# no bash here to hold a session open between calls. The preset keeps its\n'
      + '# shape — one shell, one editor — with the shell this machine has. Under an\n'
      + '# emulated runtime the same row mounts that machine\'s tools instead.\n'
      + '- id: tool-machine\n  name: \'browser:machine\'\n\n')
    .replace(PERSISTENT_SHELL_PROSE, '`jsh` and `str_replace_editor`')
}

/**
 * Keep a preset's own description honest about the shell it just lost.
 *
 * `minimal` describes itself, in the picker the user reads, as the preset that
 * offers a persistent bash. After the swap it offers jsh, which holds nothing
 * open between calls, and a description naming bash would be the same lie in a
 * different place.
 * @param contents - the preset's display metadata.
 * @returns the metadata with any bash promise rewritten.
 */
function describeWithoutBash(contents: string): string {
  return contents.replace(/^(description:.*?)持久 bash(.*)$/m, '$1 jsh$2').replace(/^(description: +)/m, 'description: ')
}

/** Write a generated module with a do-not-edit banner. */
function writeGenerated(name: string, body: string): void {
  mkdirSync(generated, { recursive: true })
  writeFileSync(join(generated, name), `/* eslint-disable */\n// Generated by scripts/assemble.ts — do not edit.\n\n${body}`)
}

// ---- run --------------------------------------------------------------------

mkdirSync(publicDir, { recursive: true })

const clientPackages = scanClientPackages()
const clientRows = emitClientBundles(clientPackages)
const shell = emitShell()
const { files, specifiers } = emitSeed()

// The browser overlay's own rows are compiled into the app, but their plugin
// specifiers still have to resolve through the host module map.
for (const name of specifiersIn(readFileSync(join(root, 'src', 'host', 'browser.patch.yml'), 'utf8'))) {
  specifiers.add(name)
}

/**
 * Every subpath a package exports, expanded.
 *
 * Plugins import dsh subpaths directly (`@deepseek-ai/dsh-host-apiproxy/api/rpc`),
 * and a wildcard export like `"./api/*"` cannot be resolved at runtime by a
 * bundler — so each concrete file behind it becomes its own map entry here.
 * @param packageName - the package.
 * @param exportsField - its `exports` map.
 * @returns the specifiers to expose.
 */
function subpathSpecifiers(packageName: string, exportsField: unknown): string[] {
  if (typeof exportsField !== 'object' || exportsField === null) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (!key.startsWith('./') || key === './package.json') continue
    const target = firstStringTarget(value)
    if (target === undefined) continue
    // Only JavaScript modules belong in the host module map. Packages also
    // export raw assets (`"./cordis.patch.yml"`, `"./dist/*"`) and TypeScript
    // sources, none of which the loader can import.
    if (!/\.(?:js|mjs|cjs)$/.test(target)) continue
    if (!key.includes('*')) {
      out.push(`${packageName}/${key.slice(2)}`)
      continue
    }
    if (!target.includes('*')) continue
    const [prefix, suffix] = target.split('*')
    // `dirname('./a/b/')` drops `b`, so a prefix that already ends at a
    // directory boundary is used as-is.
    const relativeDirectory = prefix.endsWith('/') ? prefix : dirname(prefix)
    const directory = join(scope, packageName.split('/')[1], relativeDirectory)
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(suffix)) continue
      if (statSync(join(directory, file)).isDirectory()) continue
      const stem = file.slice(0, -suffix.length)
      if (stem.length === 0 || stem.endsWith('.d')) continue
      out.push(`${packageName}/${key.slice(2).replace('*', stem)}`)
    }
  }
  return out
}

/** First string target in a (possibly conditional) exports value. */
function firstStringTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  for (const condition of ['default', 'import', 'module', 'browser', 'require', 'node']) {
    const resolved = firstStringTarget((value as Record<string, unknown>)[condition])
    if (resolved !== undefined) return resolved
  }
  return undefined
}

// Every installed dsh package, whether or not a composition file names it.
//
// Compositions are not the only source of loader rows: a host plugin can create
// one at runtime (`directory-picker-auto` mounts both the backend and the client
// surface for whichever interaction it resolves), and a user's own patch layer
// can name anything installed. A specifier missing from this map is a hard boot
// failure, while an unused entry costs only a lazy chunk nothing ever fetches.
for (const name of readdirSync(scope)) {
  const manifest = join(scope, name, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = readJson(manifest)
  const hasEntry = typeof pkg.main === 'string' || typeof pkg.module === 'string'
    || (typeof pkg.exports === 'object' && pkg.exports !== null && '.' in (pkg.exports as Record<string, unknown>))
  if (hasEntry) specifiers.add(String(pkg.name))
  for (const subpath of subpathSpecifiers(String(pkg.name), pkg.exports)) specifiers.add(subpath)
}

// Only specifiers that actually resolve become map entries; a composition may
// legitimately name a row this deployment disables and never installs.
const resolvable: string[] = []
for (const specifier of [...specifiers].sort()) {
  const [scopeName, packageName] = specifier.startsWith('@') ? specifier.split('/') : [undefined, specifier.split('/')[0]]
  const packageRoot = scopeName === undefined ? join(modules, packageName) : join(modules, scopeName, packageName)
  // `./src/*` exports point at TypeScript sources, which the browser build has
  // no business importing; skip them rather than emit a chunk that cannot load.
  if (specifier.includes('/src/')) continue
  if (existsSync(join(packageRoot, 'package.json'))) resolvable.push(specifier)
  else console.warn(`[assemble] composition names ${specifier}, which is not installed; it will fail to load if enabled`)
}

/** The catalog route whose free tier this build declares a keyless twin of. */
const ZEN_PROVIDER = 'opencode'

/** The route id that twin is registered under. */
const FREE_ROUTE = 'opencode-free'

/**
 * Free models the catalog lists that the endpoint does not actually serve.
 *
 * pi-ai's catalog is generated from published pricing, and a price is not a
 * promise: these two are listed at zero and answer
 * `401 {"type":"ModelError","message":"Model … is not supported"}` to every
 * request. Offering them would put two entries in the picker that can only
 * ever fail, so they are subtracted — measured, not assumed, and re-checkable
 * in one line:
 *
 *     curl -s -X POST https://opencode.ai/zen/v1/chat/completions \
 *       -H 'content-type: application/json' -H 'Authorization: Bearer' \
 *       -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
 *
 * A 429 is not grounds for this list: three of the served models answered that
 * while their upstream pool was spent, and they work again afterwards. Only a
 * flat "not supported" belongs here.
 */
const ZEN_UNSERVED = new Set(['ling-3.0-flash-free', 'north-mini-code-free'])

/** As much of a pi-ai catalog model as the roster reads. */
interface CatalogModel {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number, output?: number }
}

/**
 * A route for the models that answer with no account at all.
 *
 * OpenCode Zen prices seven of its models at zero and serves them to an
 * unauthenticated request — which is the difference between a page anyone can
 * open and a page that asks for a key before it does anything. Getting there
 * took finding out what actually stops it, because two different things do:
 *
 * - pi-ai will not dispatch without a key. A catalog route with no
 *   `apiKeyEnv` fails `Provider is not configured` before any request is
 *   built; a *declared* route gets further and fails `No API key for
 *   provider`. Both measured.
 * - That second gate is the one with a way through: pi-ai accepts a request
 *   with no key when the profile supplies an `authorization` header, and the
 *   OpenAI client merges `defaultHeaders` *after* its own `Authorization`, so
 *   the profile's value is what reaches the wire.
 *
 * And the value has to be `Bearer` with nothing after it. Zen answers 200 to
 * an empty bearer and 401 `Invalid API key` to any non-empty one, so a
 * placeholder key is not a substitute for having none.
 *
 * The route is declared rather than configured onto `opencode` because the two
 * are different postures: the catalog route keeps its credential reference and
 * serves all 58 models to whoever has an account, and this one serves only the
 * seven that need none. Sharing one route would mean the header override
 * silently ignoring a key the user had typed.
 * @param served - every model the catalog ships for that provider.
 * @returns the profile rows and how many models they cover, or nothing if the
 *   catalog no longer prices any of them at zero.
 */
function freeRoute(served: CatalogModel[]): { rows: string, count: number } | undefined {
  // Free, and speaking the one protocol a declared route can name for all of
  // its models. A zero-priced model on another protocol would need its own
  // route, and there are none today.
  const free = served.filter(model => model.cost?.input === 0 && model.cost?.output === 0
    && model.api === 'openai-completions'
    && !ZEN_UNSERVED.has(model.id))
  if (free.length === 0) return undefined
  const baseUrl = free[0].baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  if (!free.every(model => model.baseUrl === baseUrl)) return undefined

  const rows = routeRows({ id: FREE_ROUTE, displayName: 'OpenCode Zen (free)', baseURL: baseUrl }, free)
  return { rows, count: free.length }
}

/**
 * One declared route, as rows of the `llm-pi-ai` providers map.
 *
 * Every keyless route this build registers has the same shape, and the two
 * fields that make it keyless are the reason this is one function rather than
 * one per service: `api` and `baseURL` are what a route pi-ai ships no catalog
 * for needs in order to resolve at all, and the empty `authorization` header is
 * what keeps the request unauthenticated — it is also what gets pi-ai to
 * dispatch one, since a route with no credential reference otherwise fails
 * `No API key for provider` before a request is built.
 *
 * Model ids are quoted because several services put a `:` in them
 * (`stepfun/step-3.7-flash:free`), and a quoted scalar is one less thing that
 * depends on how a YAML parser reads a plain one.
 * @param route - the route's identity and endpoint.
 * @param models - the models it serves.
 * @returns the indented YAML rows.
 */
function routeRows(
  route: { id: string, displayName: string, baseURL: string },
  models: readonly FreeModel[],
): string {
  const entries = models.map((model) => {
    const lines = [`          - id: ${JSON.stringify(model.id)}`]
    if (model.name !== undefined) lines.push(`            name: ${JSON.stringify(model.name)}`)
    if (model.contextWindow !== undefined) lines.push(`            contextWindow: ${String(model.contextWindow)}`)
    if (model.maxTokens !== undefined) lines.push(`            maxTokens: ${String(model.maxTokens)}`)
    // Narrowed rather than passed through: `input` reaches this from two
    // sources — a measured roster and pi-ai's own catalog entries — and the
    // profile schema accepts only these two names. A third one arriving from
    // upstream would be rejected at settings-validation time, which is a long
    // way from here.
    const input = (['text', 'image'] as const).filter(name => model.input?.includes(name) === true)
    if (input.length > 0) lines.push(`            input: [${input.join(', ')}]`)
    return lines.join('\n')
  })
  return [
    `      ${route.id}:`,
    `        displayName: ${JSON.stringify(route.displayName)}`,
    '        api: openai-completions',
    `        baseURL: ${route.baseURL}`,
    // Empty on purpose: it is what makes the request unauthenticated, and it
    // is also what gets pi-ai to dispatch one at all.
    '        headers:',
    '          authorization: Bearer',
    '        models:',
    ...entries,
  ].join('\n')
}

/**
 * Fail the build if the session's starting model is not one of the registered
 * declared routes.
 *
 * The default lives in `browser.patch.yml` and the roster is measured against
 * live endpoints, so the two drift independently: a service withdrawing one
 * model is enough to leave every new session pointed at a route that serves it
 * nothing. That failure is silent at runtime — the picker looks fine and the
 * first message is what breaks — so it is worth catching here, where the two
 * halves are both in hand.
 *
 * Only the declared routes are checked. `opencode-free` comes from the pi-ai
 * catalog and is verified by `freeRoute` already.
 * @param registered - route id → the models it serves.
 */
function assertDefaultIsRegistered(registered: ReadonlyMap<string, readonly FreeModel[]>): void {
  const patch = readFileSync(join(root, 'src/host/browser.patch.yml'), 'utf8')
  const block = /^- id: agent-default-model$[\s\S]*?^\s+provider:\s*(\S+)$[\s\S]*?^\s+model:\s*(\S+)$/m.exec(patch)
  if (block === null) throw new Error('assemble: browser.patch.yml declares no agent-default-model provider and model')
  const [, provider, model] = block
  const models = registered.get(provider)
  if (models === undefined) return
  if (models.some(entry => entry.id === model)) return
  throw new Error(`assemble: the default model ${provider}/${model} is not in scripts/free-routes.json;`
    + ` ${provider} serves ${String(models.length)} models and none of them is "${model}".`
    + ' Re-run `npm run refresh:models`, then point browser.patch.yml at a model that survived')
}

/**
 * The provider routes this build registers.
 *
 * `dsh-llm-pi-ai` mounts dormant: it ships a multi-provider catalog and serves
 * none of it until a profile names a route. That is the right posture and it
 * stays — a deployment configures the providers it has keys for, and the
 * Models page's add-a-provider card offers the whole installed catalog to
 * anyone who wants one. Registering all of them here would put a thousand
 * models in the picker that nobody can call.
 *
 * The routes registered are the ones that need no configuring, because they
 * need no account. They come from two places, and the difference is worth
 * keeping:
 *
 * - OpenCode Zen is derived from the pi-ai catalog installed in
 *   `node_modules`, so it tracks the dependency and needs no snapshot.
 * - The rest — OVHcloud, Kilo, BlockRun, LLM7 — publish no catalog pi-ai
 *   ships, so they are declared from the measured roster in
 *   `scripts/free-routes.json`. That file is refreshed by
 *   `npm run refresh:models`, deliberately not by this script: a build that
 *   four third parties can break is not a build.
 *
 * Together they are what makes the page usable the moment it opens, which is
 * the only reason a deployment default belongs here at all.
 * @returns the patch text, and what it covers.
 */
async function emitModelCatalog(): Promise<{ patch: string, providers: number, models: number }> {
  const catalog = await import('@earendil-works/pi-ai/providers/all') as {
    getBuiltinModels(id: string): CatalogModel[]
  }
  const zen = freeRoute(catalog.getBuiltinModels(ZEN_PROVIDER))
  if (zen === undefined) {
    throw new Error(`assemble: the pi-ai catalog no longer prices any ${ZEN_PROVIDER} model at zero;`
      + ` ${FREE_ROUTE} would register nothing`)
  }

  const roster = loadRoster()
  const declared = FREE_ROUTES.map((route) => {
    const models = roster.routes[route.id] ?? []
    // An empty route is a snapshot that has gone stale against a service that
    // withdrew its free tier, not a route to register silently: it would put a
    // provider in Settings → Models serving nothing at all.
    if (models.length === 0) {
      throw new Error(`assemble: scripts/free-routes.json lists no models for ${route.id};`
        + ' run `npm run refresh:models` and commit the result, or remove the route')
    }
    return { route, models, rows: routeRows(route, models) }
  })

  const models = zen.count + declared.reduce((sum, entry) => sum + entry.models.length, 0)
  const providers = 1 + declared.length
  assertDefaultIsRegistered(new Map(declared.map(entry => [entry.route.id, entry.models])))
  const patch = [
    '',
    '# ── the model routes this build registers ───────────────────────────────────',
    '#',
    '# Generated by scripts/assemble.ts. Do not edit here.',
    `# ${String(providers)} routes, ${String(models)} models, none of which needs an account:`,
    '#',
    `# - \`${FREE_ROUTE}\` (${String(zen.count)}) is derived from the pi-ai catalog in`,
    '#   node_modules; bump the dependency and re-run `npm run assemble`.',
    ...declared.flatMap(entry => [
      `# - \`${entry.route.id}\` (${String(entry.models.length)}) ${entry.route.note}.`,
      `#   Reached ${entry.route.cors === 'direct'
        ? 'directly: it sends `access-control-allow-origin: *`.'
        : 'through the CORS proxy in Settings → Network: it publishes no CORS headers.'}`,
    ]),
    '#',
    `# Those last ${String(declared.length)} come from the measured roster in`,
    '# scripts/free-routes.json; re-pull and re-probe them with `npm run refresh:models`.',
    '#',
    '# None of these names a credential reference, because none needs one. The',
    '# empty `authorization` header is what keeps each request unauthenticated —',
    '# and, on OVHcloud, a non-empty one is refused with 403 rather than served.',
    '#',
    '# Every other provider pi-ai ships stays where upstream leaves it — offered by',
    '# the Models page\'s add-a-provider card, registered when a user configures one.',
    '# This build does not preregister them: a route whose key nobody has is a model',
    '# in the picker that cannot be called.',
    '#',
    '# This is composition, not settings: a `llm-pi-ai:` section in the user\'s',
    '# settings.yaml still overrides any of it, and the Models page still edits',
    '# that layer rather than this one.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    zen.rows,
    ...declared.map(entry => entry.rows),
    '',
  ].join('\n')
  return { patch, providers, models }
}

const modelCatalog = await emitModelCatalog()
writeGenerated('model-catalog.ts', `/**
 * The \`llm-pi-ai\` provider routes this build registers, as a patch fragment
 * appended to the browser overlay layer. Derived from the installed pi-ai
 * catalog — see \`emitModelCatalog\` in scripts/assemble.ts.
 */
export const MODEL_CATALOG_PATCH = ${JSON.stringify(modelCatalog.patch)}
`)

writeGenerated('client-manifest.ts', `import type { ClientManifestRow } from '../host/client-modules-browser.ts'

/** The client halves shipped as static assets beside the app. */
export const CLIENT_ROWS: readonly ClientManifestRow[] = ${JSON.stringify(clientRows, null, 2)}
`)

writeGenerated('shell-assets.ts', `/** Entry chunk of the published web frontend, loaded after the host is up. */
export const SHELL_ENTRY = ${JSON.stringify(shell.entry)}

/** Stylesheets the shell build emitted; injected before the entry runs. */
export const SHELL_STYLES: readonly string[] = ${JSON.stringify(shell.styles, null, 2)}
`)

writeGenerated('host-modules.ts', `/**
 * Specifier → loader for every plugin the shipped compositions mount. The host
 * module system resolves \`internal.import\` through this table; anything absent
 * falls through to the runtime plugin registry (packages installed into the VFS).
 */
export const HOST_MODULES: Record<string, () => Promise<unknown>> = {
${resolvable.map(specifier => `  ${JSON.stringify(specifier)}: () => import(${JSON.stringify(specifier)}),`).join('\n')}
}
`)

const typertPackages = scanTypertPackages()
writeGenerated('typert-manifests.ts', `/**
 * Packages contributing a Typert host manifest. The browser Typert loader
 * imports these instead of resolving artifacts by file URL.
 */
export const TYPERT_MANIFESTS: Record<string, () => Promise<unknown>> = {
${typertPackages.map(name => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`${name}/typert`)}),`).join('\n')}
}
`)

writeGenerated('seed-files.ts', `/** Deployment files seeded into the virtual filesystem at boot. */
export const SEED_FILES: readonly (readonly [string, string])[] = ${JSON.stringify(files, null, 2)}
`)

console.log(`[assemble] ${String(clientRows.length)} client bundles`)
console.log(`[assemble] ${String(modelCatalog.providers)} default provider routes, ${String(modelCatalog.models)} models`)
console.log(`[assemble] ${String(resolvable.length)} host module specifiers`)
console.log(`[assemble] ${String(files.length)} seeded files`)
console.log(`[assemble] ${String(typertPackages.length)} Typert host manifests`)
console.log(`[assemble] shell entry ${shell.entry}, ${String(shell.styles.length)} stylesheets`)
console.log(`[assemble] public/ is ${relative(root, publicDir)}`)
