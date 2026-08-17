/**
 * npm registry access, shared by the plugin manager and the shell's `npm`.
 *
 * Both do the same thing — resolve a spec against the registry, fetch a
 * tarball, unpack it into a `node_modules` root — and differ only in which root
 * and what happens afterwards. Keeping one implementation means a package
 * installed from the terminal and a plugin installed from the UI are unpacked
 * by the same code, and resolve by the same rules.
 */

import { extractTarball } from '../plugins/tar.ts'
import { volume } from '../vfs/volume.ts'
import { toText } from '../node/binary.ts'
import { dirname } from '../node/path.ts'

/** The default registry, overridable per call for a mirror. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** What the registry says about one resolved version. */
export interface Resolved {
  name: string
  version: string
  tarball: string
  manifest: Record<string, unknown>
}

/** Compare two semver strings numerically, ignoring prerelease ordering subtleties. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] || 0) - (right[i] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Split `@scope/name@range` or `name@range`. */
export function parseSpec(spec: string): { name: string, range?: string } {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec }
  return { name: spec.slice(0, at), range: spec.slice(at + 1) }
}

/**
 * Resolve a package spec to a concrete version and tarball URL.
 * @param name - the package name.
 * @param range - a version, dist-tag, or loose range.
 * @param registry - the registry base URL.
 * @returns the resolved version.
 */
export async function resolveVersion(name: string, range: string | undefined, registry = DEFAULT_REGISTRY): Promise<Resolved> {
  const response = await fetch(`${registry}/${name.replace('/', '%2f')}`)
  if (!response.ok) throw new Error(`registry: ${name} not found (${String(response.status)})`)
  const document = await response.json() as {
    'dist-tags': Record<string, string>
    versions: Record<string, Record<string, unknown>>
  }
  const versions = Object.keys(document.versions)
  let version: string | undefined
  if (range === undefined || range === 'latest') {
    version = document['dist-tags'].latest
  } else if (document.versions[range] !== undefined) {
    version = range
  } else if (document['dist-tags'][range] !== undefined) {
    version = document['dist-tags'][range]
  } else {
    // Only the common `^`/`~`/exact forms are honored; anything else falls back
    // to the newest published version, which is what a user typing a loose
    // range in a browser almost always means.
    const target = range.replace(/^[\^~>=<\s]+/, '')
    const [major] = target.split('.')
    const compatible = versions.filter(candidate => candidate.split('.')[0] === major && !candidate.includes('-'))
    version = compatible.sort(compareVersions).pop() ?? document['dist-tags'].latest
  }
  if (version === undefined) throw new Error(`registry: ${name} has no published version matching ${range ?? 'latest'}`)
  const manifest = document.versions[version]
  const tarball = (manifest.dist as { tarball?: string } | undefined)?.tarball
  if (tarball === undefined) throw new Error(`registry: ${name}@${version} has no tarball`)
  return { name, version, tarball, manifest }
}

/**
 * Unpack a tarball into `<root>/<name>`, replacing whatever was there.
 * @param name - the package name, which becomes the directory.
 * @param tarball - the raw `.tgz` bytes.
 * @param root - the `node_modules` directory to install into.
 * @returns the package's own manifest.
 */
export function unpackInto(name: string, tarball: Uint8Array, root: string): Record<string, unknown> {
  const target = `${root}/${name}`
  volume.rm(target, { recursive: true, force: true })
  volume.mkdirp(target)
  let manifest: Record<string, unknown> | undefined
  for (const entry of extractTarball(tarball)) {
    const path = `${target}/${entry.name}`
    volume.mkdirp(dirname(path))
    volume.writeFile(path, entry.data, entry.mode)
    if (entry.name === 'package.json') {
      manifest = JSON.parse(toText(entry.data)) as Record<string, unknown>
    }
  }
  if (manifest === undefined) throw new Error(`install: ${name} tarball has no package.json`)
  return manifest
}

/**
 * Fetch a tarball.
 * @param url - the tarball URL.
 * @returns its bytes.
 */
export async function fetchTarball(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`install: tarball fetch failed (${String(response.status)})`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Install one package and, transitively, its runtime dependencies.
 *
 * Installation is flat, as npm's own hoisting produces in the common case: one
 * copy per name under `root`. A conflicting range on an already-installed name
 * keeps the first copy, because a second one at a different path would fork the
 * package's identity for every `instanceof` its consumers make.
 * @param spec - `name`, `name@range`, or a scoped equivalent.
 * @param root - the `node_modules` directory to install into.
 * @param options - registry, depth bound, and a progress sink.
 * @returns every package installed by this call.
 */
export async function installPackage(
  spec: string,
  root: string,
  options: { registry?: string, maxDepth?: number, skip?: (name: string) => boolean, onProgress?: (message: string) => void } = {},
): Promise<{ name: string, version: string }[]> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const maxDepth = options.maxDepth ?? 6
  const installed: { name: string, version: string }[] = []
  const seen = new Set<string>()

  const install = async (target: string, depth: number): Promise<void> => {
    const { name, range } = parseSpec(target)
    if (seen.has(name) || options.skip?.(name) === true) return
    seen.add(name)
    if (volume.exists(`${root}/${name}/package.json`) && depth > 0) return

    const resolved = await resolveVersion(name, range, registry)
    options.onProgress?.(`${name}@${resolved.version}`)
    const manifest = unpackInto(name, await fetchTarball(resolved.tarball), root)
    installed.push({ name, version: resolved.version })
    if (depth >= maxDepth) return

    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
    for (const [dependency, dependencyRange] of Object.entries(dependencies)) {
      try {
        await install(`${dependency}@${dependencyRange}`, depth + 1)
      } catch (error) {
        // A missing optional-ish dependency should not fail the whole install;
        // the consumer either handles the absence or reports it at call time.
        options.onProgress?.(`skipped ${dependency}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  await install(spec, 0)
  return installed
}
