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
 * The same absolute path inside the container and on this page, which is what
 * lets a tool call and a terminal command name one file. It sits directly under
 * the home the picker opens at, so a first-time visitor sees it without
 * navigating anywhere.
 */
export const WORKSPACE_ROOT = '/home/dsh/workspace'

/** Directories a POSIX-shaped world is expected to have. */
const SKELETON = [
  '/bin', '/usr/bin', '/usr/local/bin', '/etc', '/tmp', '/var', '/var/log',
  '/home', '/home/dsh', WORKSPACE_ROOT, '/opt', DEPLOY_ROOT,
]


/**
 * A marker file for each program the machine ships.
 *
 * Commands run in the container, not here, so these are not the programs — but
 * `dsh-bash-sandbox` resolves an executable through the subprocess seam before
 * it spawns anything, and that seam is synchronous while the machine is not. An
 * absent `/bin/bash` would refuse the Bash tool rather than run it.
 *
 * The list is what `container/Dockerfile` installs. Adding a program there and
 * not here costs nothing until something looks it up first.
 */
const SHELL_STUBS = ['sh', 'bash', 'env', 'node', 'npm', 'npx', 'git', 'python3', 'pip', 'rg']

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
      toBytes(`#!/bin/sh\n# ${name} runs in the container, not here; this file exists so executable lookup succeeds.\n`),
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

This directory lives inside a Debian container running in this browser tab, on
an emulated x86-64 CPU. Files you and the agent create here persist across
reloads (they are stored in IndexedDB for this origin) and are private to this
browser — nothing is uploaded anywhere.

The agent and the terminal share this directory and that container: a file
either of them creates, the other sees immediately.

What is installed:

- bash, coreutils, and the rest of a Debian userland
- git
- Python 3, with pip
- Node LTS, with npm and npx
- ripgrep, which the search tools use

What is different from a laptop:

- an emulated CPU is slow. A shell command takes about a second; starting Node
  or npm takes several
- there is no network by default, so \`npm install\`, \`pip install\` and
  \`git clone\` cannot reach a registry
- nothing can listen on a port that a browser tab could reach
`

/** Populate the virtual filesystem. Safe to call once per boot. */
export function seedFilesystem(): void {
  writeSkeleton()
  writeDeploymentFiles()
}
