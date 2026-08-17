/**
 * Where a plugin can come from.
 *
 * `dsh plugin add` on a machine forwards to a package manager, so it inherits
 * everything npm accepts: a registry name, a tarball URL, a git remote, a local
 * directory. A browser has none of that machinery, but it does have `fetch` and
 * a filesystem — so the same set of sources is reachable, just resolved here
 * instead of shelled out.
 *
 * Each source resolves to the same thing: a package name and the bytes of a
 * tarball, or a set of files already in the virtual filesystem.
 */

import { extractTarball } from './tar.ts'
import { fetchTarball, parseSpec, resolveVersion } from '../pkg/registry.ts'
import { volume } from '../vfs/volume.ts'
import { toText } from '../node/binary.ts'
import { DEFAULT_REGISTRY } from '../pkg/registry.ts'

/** A resolved package, ready to unpack. */
export interface PackageSource {
  /** The package's own name, from its manifest. */
  name: string
  /** Its version, when one is known. */
  version: string
  /** The files to write, relative to the package root. */
  files: { name: string, data: Uint8Array, mode: number }[]
  /** The parsed `package.json`. */
  manifest: Record<string, unknown>
  /** How this was obtained, for the roster and for diagnostics. */
  origin: string
}

/** Read a manifest out of an extracted file list. */
function manifestOf(files: { name: string, data: Uint8Array }[], origin: string): Record<string, unknown> {
  const entry = files.find(file => file.name === 'package.json')
  if (entry === undefined) throw new Error(`install: ${origin} contains no package.json`)
  try {
    return JSON.parse(toText(entry.data)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`install: ${origin} has an unreadable package.json`, { cause: error })
  }
}

/** Build a source from tarball bytes. */
function fromTarball(bytes: Uint8Array, origin: string): PackageSource {
  const files = extractTarball(bytes)
  const manifest = manifestOf(files, origin)
  const name = typeof manifest.name === 'string' ? manifest.name : undefined
  if (name === undefined) throw new Error(`install: ${origin} has a package.json with no name`)
  return { name, version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', files, manifest, origin }
}

/** Collect a directory in the virtual filesystem as a file list. */
function fromDirectory(root: string): PackageSource {
  const files: { name: string, data: Uint8Array, mode: number }[] = []
  const walk = (absolute: string, relative: string): void => {
    for (const entry of volume.readdir(absolute)) {
      // A dependency tree and a VCS directory are not part of the package, and
      // copying them turns a small plugin into a very large one.
      if (entry === 'node_modules' || entry === '.git') continue
      const child = `${absolute}/${entry}`
      const name = relative === '' ? entry : `${relative}/${entry}`
      const node = volume.statNode(child, true)
      if (node.kind === 'dir') walk(child, name)
      else if (node.kind === 'file') files.push({ name, data: volume.readFile(child).slice(), mode: node.mode })
    }
  }
  if (!volume.exists(root)) throw new Error(`install: ${root} does not exist`)
  if (volume.statNode(root, true).kind !== 'dir') throw new Error(`install: ${root} is not a directory`)
  walk(root, '')
  const manifest = manifestOf(files, root)
  const name = typeof manifest.name === 'string' ? manifest.name : undefined
  if (name === undefined) throw new Error(`install: ${root} has a package.json with no name`)
  return { name, version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', files, manifest, origin: root }
}

/** Turn a `github:` / `owner/repo` reference into a codeload tarball URL. */
function githubTarball(reference: string): string {
  const body = reference.replace(/^github:/, '')
  const [repository, ref = 'HEAD'] = body.split('#')
  return `https://codeload.github.com/${repository}/tar.gz/${ref}`
}

/**
 * Resolve any supported plugin specifier to its files.
 *
 * Accepted, in the order they are recognized:
 * - a virtual-filesystem path or `file:` URL — a directory or a `.tgz`
 * - an `http(s)` URL ending in a tarball extension
 * - `github:owner/repo[#ref]`, or a bare `owner/repo[#ref]`
 * - `name`, `name@range`, `@scope/name@range` — the npm registry
 * @param spec - what the user typed.
 * @param registry - the registry base URL for the last case.
 * @returns the resolved package.
 */
export async function resolveSource(spec: string, registry = DEFAULT_REGISTRY): Promise<PackageSource> {
  const trimmed = spec.trim()

  if (trimmed.startsWith('file:') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('~/')) {
    const path = trimmed.startsWith('file:') ? new URL(trimmed).pathname : trimmed.replace(/^~/, '/home/dsh')
    if (path.endsWith('.tgz') || path.endsWith('.tar.gz')) {
      return fromTarball(volume.readFile(path).slice(), path)
    }
    return fromDirectory(path.replace(/\/+$/, ''))
  }

  if (/^https?:\/\//.test(trimmed)) {
    return fromTarball(await fetchTarball(trimmed), trimmed)
  }

  // `owner/repo` is a GitHub reference; `@scope/name` is a package. The `@`
  // prefix is what tells them apart.
  if (trimmed.startsWith('github:') || (/^[\w.-]+\/[\w.-]+(#.+)?$/.test(trimmed) && !trimmed.startsWith('@'))) {
    const url = githubTarball(trimmed)
    return fromTarball(await fetchTarball(url), trimmed)
  }

  const { name, range } = parseSpec(trimmed)
  const resolved = await resolveVersion(name, range, registry)
  const source = fromTarball(await fetchTarball(resolved.tarball), `${name}@${resolved.version}`)
  return { ...source, version: resolved.version }
}
