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

/** Root the build's own files live under. */
export const DEPLOY_ROOT = '/opt/dsh'

/** Directories a POSIX-shaped world is expected to have. */
const SKELETON = [
  '/bin', '/usr/bin', '/usr/local/bin', '/etc', '/tmp', '/var', '/var/log',
  '/home/dsh', '/workspace', '/opt', DEPLOY_ROOT,
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
  const home = env.HOME ?? '/home/dsh'
  volume.mkdirp(`${home}/.dsh`)
  if (!volume.exists('/workspace/README.md')) {
    volume.writeFile('/workspace/README.md', toBytes(WORKSPACE_README))
  }
}

/** The starter file a first-time visitor finds in the default workspace. */
const WORKSPACE_README = `# Workspace

This is a virtual filesystem that lives in your browser. Files you and the agent
create here persist across reloads (they are stored in IndexedDB for this
origin) and are private to this browser — nothing is uploaded anywhere.

Things that work here:

- reading, writing, searching, and editing files
- an in-browser POSIX shell: pipes, redirects, globs, control flow, and the
  usual coreutils (ls, cat, grep, sed, find, sort, head, tail, wc, ...)
- \`git\` — init, add, commit, log, diff, branch, checkout, and clone over HTTP
- \`curl\` / \`wget\` against any origin that allows cross-origin reads

Things that do not:

- native toolchains (compilers, python, a system package manager)
- listening on a port, or reaching a host that refuses cross-origin reads
`

/** Populate the virtual filesystem. Safe to call once per boot. */
export function seedFilesystem(): void {
  writeSkeleton()
  writeDeploymentFiles()
}
