/**
 * Where a plugin can come from.
 *
 * `dsh plugin add` on a machine forwards to a package manager, so it inherits
 * everything npm accepts: a registry name, a tarball URL, a git remote, a local
 * directory. A browser has none of that machinery, but it does have `fetch` and
 * a filesystem — so the same set of sources is reachable, just resolved here
 * instead of shelled out.
 *
 * One of them is not reachable the obvious way. The npm registry serves both
 * metadata and tarballs with permissive CORS, so a registry name is a plain
 * fetch; `codeload.github.com`, where every repository tarball lives, sends no
 * CORS headers at all, and neither does the API's `tarball` endpoint, which
 * redirects there. So a GitHub reference is read through the two endpoints that
 * do answer a browser — the trees API and `raw.githubusercontent.com` — and
 * falls back to the tarball, which `src/net/cors-proxy.ts` may be able to
 * proxy, only when that fails.
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
function githubTarball(repository: string, ref: string): string {
  return `https://codeload.github.com/${repository}/tar.gz/${ref}`
}

/** How many blobs a repository may carry before the tarball is the better route. */
const GITHUB_MAX_FILES = 2000

/** How many blob fetches run at once. */
const GITHUB_CONCURRENCY = 12

/**
 * How long one GitHub request may take.
 *
 * Every request this bounds asks for something small — a tree listing, a single
 * source file — so a slow one is a stalled one. It matters because the request
 * may be travelling through a public CORS proxy that can stop answering without
 * closing the connection, and an install that hangs forever is worse than one
 * that fails: the caller can retry a failure.
 */
const GITHUB_TIMEOUT_MS = 30_000

/** One entry of the git trees API response. */
interface TreeEntry {
  path: string
  mode: string
  type: string
}

/**
 * Encode a path or ref for a URL without encoding its separators.
 *
 * `encodeURIComponent` turns `feat/x` into `feat%2Fx`, which GitHub reads as a
 * branch literally named with a slash in it rather than as the branch the user
 * meant. Encoding segment by segment keeps the separator a separator.
 * @param value - a ref or a repository path.
 * @returns the encoded value.
 */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

/**
 * Read a GitHub repository through the two endpoints a browser can reach.
 *
 * `codeload.github.com`, where the tarball lives, sends no CORS headers, and
 * neither does the `tarball` endpoint on the API — it redirects there, and a
 * redirect into an origin that refuses the browser fails exactly as the direct
 * request would. Both were measured from this page.
 *
 * What does answer a browser, with `access-control-allow-origin: *`, is
 * `api.github.com` and `raw.githubusercontent.com`. So the repository is read
 * the way git would: one tree listing, then the blobs. It costs one API call
 * against the unauthenticated hourly allowance and no third party at all,
 * which is why it is tried before the proxy is.
 * @param repository - `owner/repo`.
 * @param ref - a branch, tag, or commit.
 * @returns the repository's files.
 */
async function fromGithubApi(repository: string, ref: string): Promise<{ name: string, data: Uint8Array, mode: number }[]> {
  const listing = await fetch(`https://api.github.com/repos/${repository}/git/trees/${encodePath(ref)}?recursive=1`,
    { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })
  if (!listing.ok) {
    throw new Error(`github: ${repository}@${ref} tree listing failed (${String(listing.status)})`)
  }
  const document = await listing.json() as { tree?: TreeEntry[], truncated?: boolean }
  if (document.truncated === true) {
    throw new Error(`github: ${repository} is too large to list; falling back to its tarball`)
  }
  const blobs = (document.tree ?? []).filter(entry => entry.type === 'blob'
    && !entry.path.startsWith('node_modules/')
    && !entry.path.includes('/node_modules/'))
  if (blobs.length === 0) throw new Error(`github: ${repository}@${ref} has no files`)
  if (blobs.length > GITHUB_MAX_FILES) {
    throw new Error(`github: ${repository} has ${String(blobs.length)} files; falling back to its tarball`)
  }

  const files: { name: string, data: Uint8Array, mode: number }[] = new Array(blobs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < blobs.length; index = next++) {
      const entry = blobs[index]
      const response = await fetch(`https://raw.githubusercontent.com/${repository}/${encodePath(ref)}/${encodePath(entry.path)}`,
        { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`github: ${entry.path} → ${String(response.status)}`)
      files[index] = {
        name: entry.path,
        data: new Uint8Array(await response.arrayBuffer()),
        // The git mode is the only permission bit that survives a checkout,
        // and it is the one a package's own bin scripts depend on.
        mode: entry.mode === '100755' ? 0o755 : 0o644,
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(GITHUB_CONCURRENCY, blobs.length) }, worker))
  return files
}

/**
 * Resolve a GitHub reference, preferring the route that needs no proxy.
 * @param reference - `github:owner/repo[#ref]` or `owner/repo[#ref]`.
 * @returns the resolved package.
 */
async function fromGithub(reference: string): Promise<PackageSource> {
  const body = reference.replace(/^github:/, '')
  const [repository, ref = 'HEAD'] = body.split('#')
  try {
    const files = await fromGithubApi(repository, ref)
    const manifest = manifestOf(files, reference)
    const name = typeof manifest.name === 'string' ? manifest.name : undefined
    if (name === undefined) throw new Error(`install: ${reference} has a package.json with no name`)
    return { name, version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', files, manifest, origin: reference }
  } catch (error) {
    // A rate-limited API, a repository too large to list one blob at a time, a
    // private repository — all of them still have a tarball, and the page's
    // CORS policy may be able to reach it. A repository with no package.json
    // is not one of those cases, but the tarball will say so just as clearly.
    console.warn(`[plugins] ${reference}: reading through the GitHub API failed, trying its tarball —`, error)
    return fromTarball(await fetchTarball(githubTarball(repository, ref)), reference)
  }
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
    const path = trimmed.startsWith('file:') ? new URL(trimmed).pathname : trimmed.replace(/^~/, '/home')
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
    return fromGithub(trimmed)
  }

  const { name, range } = parseSpec(trimmed)
  const resolved = await resolveVersion(name, range, registry)
  const source = fromTarball(await fetchTarball(resolved.tarball), `${name}@${resolved.version}`)
  return { ...source, version: resolved.version }
}
