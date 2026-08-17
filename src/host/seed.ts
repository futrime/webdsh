/**
 * Seed the virtual filesystem with the deployment's own files and a usable
 * POSIX skeleton.
 *
 * Seeding is idempotent and never clobbers user content: deployment files under
 * `/opt/dsh` are rewritten on every boot (they belong to the build), while the
 * home and workspace directories are only created when missing, so a returning
 * visitor keeps their sessions, settings, and files.
 */

import { SEED_FILES } from '../generated/seed-files.ts'
import { volume } from '../vfs/volume.ts'
import { toBytes } from '../node/binary.ts'
import { env } from '../node/process.ts'
import browserPatchSource from './browser.patch.yml?raw'
import terminalPatchSource from '../../packages/dsh-web-terminal/cordis.patch.yml?raw'
import installPatchSource from '../../packages/dsh-web-plugins/cordis.patch.yml?raw'

/**
 * Bundle layers for the plugins this repository ships.
 *
 * They are layers rather than edits to the overlay for the same reason a
 * plugin carries its own `cordis.patch.yml` on a machine: the surface should
 * not have to know they exist, and removing one should be removing one file.
 */
const SHIPPED_PLUGIN_PATCHES: Record<string, string> = {
  'web-terminal': terminalPatchSource,
  'web-plugin-install': installPatchSource,
}

/** The bundle layers this build lays down, in application order. */
export const SHIPPED_BUNDLES = ['browser', ...Object.keys(SHIPPED_PLUGIN_PATCHES)]

/** Root the build's own files live under. */
export const DEPLOY_ROOT = '/opt/dsh'

/**
 * Where the user's files live.
 *
 * This is the runtime's own working directory, not a path invented for it: the
 * container roots every path at that directory, so a workspace anywhere else
 * ends up nested inside it and its snapshot cannot be addressed. It sits
 * directly under the home the picker opens at, so a first-time visitor sees it
 * without navigating anywhere.
 */
export const WORKSPACE_ROOT = '/home/workspace'

/** Directories a POSIX-shaped world is expected to have. */
const SKELETON = [
  '/bin', '/usr/bin', '/usr/local/bin', '/etc', '/tmp', '/var', '/var/log',
  '/home', WORKSPACE_ROOT, '/opt', DEPLOY_ROOT,
]


/**
 * A stub executable for each command the shell implements internally. `bash`
 * exists as a real file because `dsh-bash-sandbox` resolves the executable
 * through the subprocess seam before spawning it, and an absent `/bin/bash`
 * would refuse the tool rather than run it.
 */
const SHELL_STUBS = ['sh', 'bash', 'env', 'node', 'git']

/** Files that belong to the build and are refreshed on every boot. */
function writeDeploymentFiles(): void {
  for (const [path, contents] of SEED_FILES) {
    volume.mkdirp(path.slice(0, path.lastIndexOf('/')))
    volume.writeFile(path, toBytes(contents))
  }
  // This deployment's own overlay layer, alongside the upstream bundle patches.
  volume.mkdirp(`${DEPLOY_ROOT}/bundles/browser`)
  volume.writeFile(`${DEPLOY_ROOT}/bundles/browser/cordis.patch.yml`, toBytes(browserPatchSource))
  // The plugins this build ships are laid down as ordinary bundle layers, one
  // directory each, so the composition reads them exactly as it reads a plugin
  // someone installed.
  for (const [name, source] of Object.entries(SHIPPED_PLUGIN_PATCHES)) {
    volume.mkdirp(`${DEPLOY_ROOT}/bundles/${name}`)
    volume.writeFile(`${DEPLOY_ROOT}/bundles/${name}/cordis.patch.yml`, toBytes(source))
  }
  // The empty root the include composes the patch layers over.
  volume.writeFile(`${DEPLOY_ROOT}/cordis.yml`, toBytes('[]\n'))
}

/** Directories and stub binaries, created only when absent. */
function writeSkeleton(): void {
  for (const directory of SKELETON) volume.mkdirp(directory)
  for (const name of SHELL_STUBS) {
    const path = `/bin/${name}`
    if (volume.exists(path)) continue
    volume.writeFile(
      path,
      toBytes(`#!/bin/sh\n# ${name} is implemented by the in-browser shell; this file exists so executable lookup succeeds.\n`),
      0o755,
    )
    if (!volume.exists(`/usr/bin/${name}`)) volume.symlink(`/bin/${name}`, `/usr/bin/${name}`)
  }
  const home = env.HOME ?? '/home'
  volume.mkdirp(`${home}/.dsh`)
  if (!volume.exists(`${WORKSPACE_ROOT}/README.md`)) {
    volume.writeFile(`${WORKSPACE_ROOT}/README.md`, toBytes(WORKSPACE_README))
  }
}

/** The starter file a first-time visitor finds in the default workspace. */
const WORKSPACE_README = `# Workspace

This is a virtual filesystem that lives in your browser. Files you and the agent
create here persist across reloads (they are stored in IndexedDB for this
origin) and are private to this browser — nothing is uploaded anywhere.

The agent and the terminal share this directory: a file either of them creates,
the other sees immediately.

Things that work here:

- reading, writing, searching, and editing files
- Node and npm — install a package from the registry and import it
- a shell for running them, and the common file commands

Things that do not:

- native toolchains (a compiler, python, a system package manager)
- listening on a port, or reaching a host that refuses cross-origin reads
`

/** Populate the virtual filesystem. Safe to call once per boot. */
export function seedFilesystem(): void {
  writeSkeleton()
  writeDeploymentFiles()
}
