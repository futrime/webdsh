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
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const spec = declaration as { platform?: string, inject?: string[], immediately?: boolean }
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
      immediately: spec.immediately === true,
      source,
    })
  }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** Copy every client bundle into `public/plugins/` and return its manifest row. */
function emitClientBundles(packages: ClientPackage[]): { id: string, url: string, rev: string, inject: string[], immediately: boolean }[] {
  const target = join(publicDir, 'plugins')
  rmSync(target, { recursive: true, force: true })
  return packages.map((entry) => {
    const bytes = readFileSync(entry.source)
    const rev = shortHash(bytes)
    const destination = join(target, entry.id, 'client.js')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
    // A source map beside the bundle keeps stack traces readable in devtools.
    if (existsSync(`${entry.source}.map`)) {
      writeFileSync(`${destination}.map`, readFileSync(`${entry.source}.map`))
    }
    return { id: entry.id, url: `plugins/${entry.id}/client.js?rev=${rev}`, rev, inject: entry.inject, immediately: entry.immediately }
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
      const contents = path.endsWith('.cordis.yml') ? replaceBashTool(path, original) : original
      if (contents !== original) replaced++
      files.push([path, contents])
      // Only composition files carry plugin rows; `preset.yml` carries display metadata.
      if (path.endsWith('.cordis.yml')) for (const name of specifiersIn(contents)) specifiers.add(name)
    }
    // Loud, because a preset that quietly kept `tool-bash` puts a shell tool in
    // front of the model that this machine cannot honour.
    if (replaced === 0) throw new Error('assemble: no agent preset mounted tool-bash; the shell replacement did not apply')
    console.log(`[assemble] ${String(replaced)} agent preset(s) now mount the jsh shell tool`)
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
 * Swap a preset's bash tool for this deployment's jsh tool.
 * @param path - the seeded path, for the error message.
 * @param contents - the preset composition.
 * @returns the same composition with the shell row replaced.
 */
function replaceBashTool(path: string, contents: string): string {
  if (!BASH_ROW.test(contents)) return contents
  return contents.replace(BASH_ROW, (_match, indent: string) =>
    `${indent}# Replaced by scripts/assemble.ts: this machine's shell is jsh, not bash.\n`
    + `${indent}- id: tool-jsh\n${indent}  name: 'browser:jsh'\n`)
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
console.log(`[assemble] ${String(resolvable.length)} host module specifiers`)
console.log(`[assemble] ${String(files.length)} seeded files`)
console.log(`[assemble] ${String(typertPackages.length)} Typert host manifests`)
console.log(`[assemble] shell entry ${shell.entry}, ${String(shell.styles.length)} stylesheets`)
console.log(`[assemble] public/ is ${relative(root, publicDir)}`)
