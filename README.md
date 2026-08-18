# webdsh _(deepseek-web-harness)_

Pure-static, browser-only build of DeepSeek Harness (dsh web) — no server, deployable to GitHub Pages

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is an
agent harness where everything is a plugin. `dsh web` runs a Node host and
serves a browser client to it. This repository builds the same thing as **static
files**: the harness host runs inside the page, the published web client connects
to it over an in-page transport, and the agent's commands run in a Debian
container executing on an emulated CPU in the same tab.

The npm package is named `deepseek-web-harness` and is private; the repository
and this directory are named `webdsh`.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [The machine](#the-machine)
- [The terminal and plugin install are plugins](#the-terminal-and-plugin-install-are-plugins)
- [How close is this to `dsh web`?](#how-close-is-this-to-dsh-web)
- [Plugin compatibility](#plugin-compatibility)
- [What is different, and why](#what-is-different-and-why)
- [Development](#development)
- [Deploying](#deploying)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

What runs here is the published `@deepseek-ai/*` packages, unmodified. The agent
loop, session log, tool registry, prompt assembly, model adapters, permission
policy, agent presets, and the entire web client are the real ones from npm —
this repository adds no fork of them and patches none of their source.

What it adds is the platform underneath:

| Layer | What it is |
|---|---|
| `container/` | A Debian userland with git, Python, and Node, converted to WASM by [container2wasm](https://github.com/container2wasm/container2wasm). The agent's commands and the user's terminal both run in it. |
| `src/runtime` | The page's half of that machine: the emulator's worker, the console it speaks over, the channel multiplexer, the file service, and the workspace snapshots. |
| `src/vfs` | A synchronous POSIX volume with an IndexedDB write-behind mirror, for the harness's own state. Synchronous is the point: `readFileSync` is how dsh reads settings, credentials, presets, and skills. |
| `src/node` | `node:*` implemented over it — fs, path, os, crypto, child_process, worker_threads, http, stream, zlib, sqlite, async_hooks — plus `node-pty` and `sharp` replacements, so the real subprocess and attachment providers load unchanged. |
| `src/net` | The page's `fetch` and `WebSocket` routed into an in-page virtual server, so `/api` runs through dsh's own bridge, trust fence, and Typert gateway. |
| `src/host` | The boot, plus browser rows for the handful of capabilities a page cannot have. |
| `src/plugins` | Plugin installation from the npm registry, a tarball URL, a GitHub repository, or a path in this filesystem, with an ES-module loader that binds installed packages to this app's single cordis instance. |
| `packages/` | The plugins this repository ships: the terminal and the plugin installer, each an ordinary dsh plugin. |

Five composition rows are swapped, each because the shipped one names a host
capability a page does not have. `src/host/browser.patch.yml` is the complete
list, it is a normal `cordis.patch.yml` layer, and `scripts/alignment.ts` prints
the difference against what `dsh web` composes.

## Install

Building the site needs Node 22+. Building the machine it runs on also needs
Docker with BuildKit, and about 15 GB of disk for the converter's own build.

```sh
npm ci
npm run build:container   # → public/container/ (slow the first time; see below)
npm run build             # → dist/
node scripts/serve.mjs 4173
```

`npm run build:container` builds `container/Dockerfile`, converts the result with
`c2w`, and publishes it compressed and split into parts. The first run compiles
Bochs, wasi-vfs, and wizer from source and takes tens of minutes; afterwards
BuildKit's layer cache makes it a few minutes. The output is not committed —
it is 400 MB — so a checkout without it builds a site that boots and reports
that no machine image is published.

## Usage

Open the page. It walks the same first-run flow as `dsh web`: acknowledge the
notice, enter a DeepSeek API key, choose a workspace, start talking.

Your API key, files, sessions, and settings live in your browser's storage for
that origin and are never uploaded. Model requests go from your browser straight
to the provider.

- **Files and sessions** persist across reloads: reopening the page restores the
  workspace, its session list, and each session's transcript from the same
  append-only JSONL logs `dsh web` writes. `window.dsh.exportFs()` downloads the
  workspace as a zip; `window.dsh.reset()` clears everything.
- **Terminal** (`Ctrl+\`` or the sidebar action) is a real pseudoterminal on the
  same machine the agent's tools run on — a file either of you creates, the
  other sees.
- **Plugins** install from Settings → Plugins, or with `/plugin add <package>`
  in the composer. Both are the same plugin, and both take an npm name, a
  tarball URL, `owner/repo#ref`, or a path.

## The machine

`dsh web` runs on a machine. In a browser there is no machine, so the page
carries one: `debian:stable-slim` with git, Python 3, and Node LTS installed the
way the devcontainer features install them, converted to a WASM module that
carries a Linux kernel and an x86-64 emulator with it.

```
$ uname -sm && cat /etc/os-release | head -1
Linux x86_64
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
$ bash --version | head -1 && git --version && python3 --version && node --version
GNU bash, version 5.2.37(1)-release (x86_64-pc-linux-gnu)
git version 2.47.3
Python 3.13.5
v24.19.0
```

Nothing in that list is a reimplementation. `for`, `case`, heredocs, `$(…)`,
process substitution, job control, signals, `awk`, `sed`, `tar`, and `git
rebase` are the programs Debian ships, running on a kernel, because the trade
this build makes is to emulate the CPU rather than to approximate the userland.

**The agent runs there too.** That is the part worth checking rather than
claiming: the Bash tool opens a channel on the same container the terminal is
attached to, and Read/Write/Edit go through a file service inside it, so a file
either one creates is immediately visible to the other. `scripts/runtime-e2e.ts`
asserts exactly that, in both directions.

Three things follow from how it is put together:

- The emulator's `_start` never returns, so it owns a worker and the console
  between page and machine is a pair of `SharedArrayBuffer` rings. That needs
  cross-origin isolation, which is requested through headers a static host
  cannot be told to send — so `public/sw.js` adds them, and the first load
  reloads once through the worker to pick them up.
- One console carries everything, so `container/dsh-mux` multiplexes it into
  channels: the terminal gets a pty, each command gets its own stdout, stderr,
  and exit status, and neither sees the other's bytes.
- The machine's filesystem is a disk image in memory, so the workspace is
  archived to IndexedDB on a debounce and on `pagehide`, and restored at boot.

## The terminal and plugin install are plugins

Neither is part of this app. They are ordinary dsh plugins in `packages/`, each
with a node half, a browser half, and its own `cordis.patch.yml` inserting one
row — discovered, built, and composed the same way an installed plugin is.
Removing either is removing a directory.

They inject into the surface's own slots rather than drawing over it: the
terminal into `shell.overlay` and `sidebar.footer.action`, and the installer
into `settings.plugins.tab` — the page a user already opens to see what is
installed, which `dsh web` fills and offers no way to add to, because on a
machine adding one is `dsh plugin add` in a shell.

What the app owns is the capability, published as a bridge in
`src/host/bridges.ts`: a client plugin runs inside the surface's bundle graph
and cannot import this app's modules, and the machine must be shared rather than
booted per consumer.

## How close is this to `dsh web`?

`npx tsx scripts/alignment.ts` answers that by diffing the composition this
build runs against the one the published bundles declare:

```
dsh web composes 129 rows.
  disabled by this build (5) ── web-startup, web-runtime, modules,
                                typert-loader, sandbox
  replaced (5)              ── a browser row for each of the five
  shipped as plugins (2)    ── web-terminal, web-plugin-install
  reconfigured (1)          ── agent-presets
118 of 129 rows compose exactly as `dsh web` composes them.
```

Each of the five swaps names a host capability a page does not have: parsing a
command line, binding a port and serving `dist/`, scanning plugin packages on
disk, reading Typert artifacts from disk, and an OS process sandbox. Everything
else — the agent loop, the tools, the session log, the prompt assembly, the
permission policy, the presets, the whole client — is the published row,
unmodified.

Nothing in this repository is a copy of dsh. The packages come from npm at
install time, `scripts/assemble.ts` derives the roster, the client bundles, and
the host module map from them at build time, and the only modification is a
`cordis.patch.yml` layer — the mechanism dsh documents for exactly this.

## Plugin compatibility

Community plugins install from npm and compose into the running tree exactly as
they do on a real machine: the tarball unpacks into the virtual filesystem, its
`cordis.patch.yml` becomes another patch layer on the root include, its host
half loads through the module system, and its browser half is published to the
client graph as a blob URL.

`npx tsx scripts/plugin-e2e.ts` installs a roster of real published plugins
into a real browser and reports what composed. See
[docs/plugin-compatibility.md](docs/plugin-compatibility.md) for the current
results.

## What is different, and why

These are the honest limits. Everything else behaves as `dsh web` does.

- **The machine is emulated, so it is slow.** Bochs interprets x86-64; there is
  no JIT. A shell command takes about a second, `node -e` about seven, and
  `python3 -m venv` several minutes. Reading and writing files through the agent's
  tools is fast — those go to a file service rather than spawning a process.
- **The machine is a 153 MB download**, fetched once and then cached by the
  browser. It is published gzipped and split into four parts, so no single file
  runs into a host's size limit and the browser can fetch them at once.
- **The container has no network.** `npm install`, `pip install`, and
  `git clone` cannot reach a registry. Everything in the image is already there.
- **`git` commits as a placeholder identity** (`dsh <dsh@localhost>`), because
  there is no account to take one from and `git commit` refuses without one.
  `git config --global user.name …` overrides it as it would anywhere else.
- **A browser that cannot be cross-origin isolated has no shell at all.** The
  machine needs `SharedArrayBuffer`; where that is unavailable, tool calls and
  the terminal both report that rather than falling back to something weaker.
- **Code Mode does not work.** The `run_code` transport needs worker stdout and
  real TypeScript type stripping, and neither is implemented, so every tool call
  in that preset fails.
- **A second tab is a second host.** Two tabs on this origin each boot their own
  host and their own machine over one IndexedDB, with no coordination.
- **Storage has no quota handling.** Nothing requests persistence or reacts to
  eviction.
- **The page's own network reach is the browser's.** A request only succeeds if
  the origin permits cross-origin reads. The DeepSeek API does; many hosts do not.
- **No listening port.** Nothing can bind a port a browser tab could reach, so a
  plugin whose contract is a local server cannot work here.
- **`AsyncLocalStorage` is approximate.** A page cannot intercept `await`, so
  causal attribution can be wrong when two turns run concurrently. It is exact
  for a single active turn. See `src/node/async-context.ts`.
- **Session search is off.** `node:sqlite` is stubbed over sql.js and the
  shipped composition already sets `openAt: never`.

## Development

```sh
npm run assemble    # regenerate the roster/manifest/module map from node_modules
npm run build:container
npm run build
node scripts/serve.mjs 4173

npx tsx scripts/e2e.ts                                  # boot, plugins, shell, git, persistence
DEEPSEEK_API_KEY=… npx tsx scripts/e2e.ts               # …plus a real model turn
DEEPSEEK_API_KEY=… npx tsx scripts/ui-e2e.ts            # the whole user path, through the UI
npx tsx scripts/runtime-e2e.ts                          # the machine's real workloads
npx tsx scripts/alignment.ts                            # how far the composition is from `dsh web`
npx tsx scripts/plugin-e2e.ts                           # community plugin compatibility
```

Upgrading the harness is a dependency bump: change the `@deepseek-ai/*` versions
in `package.json`, run `npm run assemble`, and rebuild. Nothing here is
hand-maintained against upstream's package list.

Changing the machine is editing `container/Dockerfile`, `container/dsh-mux`, or
`container/dsh-fsd` and running `npm run build:container`; the build stamps what
it was made from and reconverts when any of them changes.

## Deploying

`.github/workflows/pages.yml` builds the site, boots the result in a real
browser, and publishes `dist/` to GitHub Pages. Enable Pages with the "GitHub
Actions" source and push to `main`.

The machine is restored from an Actions cache keyed by a hash of `container/`
and `scripts/build-container.mjs`, and built only when that misses — so the
usual deploy pays for a 153 MB download and not for compiling an emulator.

The build uses relative asset URLs, so it works at a project path
(`user.github.io/repo/`), at a domain root, or from a local directory.

## Maintainers

[@futrime](https://github.com/futrime)

## Contributing

Issues and pull requests are welcome at
[futrime/webdsh](https://github.com/futrime/webdsh/issues). Commit messages
follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/),
and `npx tsc --noEmit` plus `npx tsx scripts/e2e.ts` should pass before a pull
request is opened.

## License

Apache License 2.0 — see [LICENSE](LICENSE). The `@deepseek-ai/*` packages this
build composes are published by DeepSeek AI under their own terms (MIT), and
[container2wasm](https://github.com/container2wasm/container2wasm) is Apache
2.0; nothing here modifies or redistributes their source.
