# webdsh _(deepseek-web-harness)_

Pure-static, browser-only build of DeepSeek Harness (dsh web) — no server, deployable to GitHub Pages

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is an
agent harness where everything is a plugin. `dsh web` runs a Node host and
serves a browser client to it. This repository builds the same thing as **static
files**: the harness host runs inside the page, the published web client connects
to it over an in-page transport, and the agent's commands run in
[WebContainers](https://webcontainers.io) — Node itself, in the tab.

The npm package is named `deepseek-web-harness` and is private; the repository
and this directory are named `webdsh`.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [The runtime](#the-runtime)
- [The shell the model is told about](#the-shell-the-model-is-told-about)
- [The plugins this repository ships](#the-plugins-this-repository-ships)
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
| `src/vfs` | A synchronous POSIX volume with an IndexedDB write-behind mirror. Synchronous is the point: `readFileSync` is how dsh reads settings, credentials, presets, and skills. |
| `src/node` | `node:*` implemented over it — fs, path, os, crypto, child_process, worker_threads, http, stream, zlib, sqlite, async_hooks — plus `node-pty` and `sharp` replacements, so the real subprocess and attachment providers load unchanged. |
| `src/shell` | A POSIX shell over that filesystem, used when the runtime cannot start — a browser without cross-origin isolation still boots, and still runs tool calls. |
| `src/runtime` | WebContainers: Node in the tab. The terminal attaches to it and the agent executes in it, so they are one machine. |
| `src/net` | The page's `fetch` and `WebSocket` routed into an in-page virtual server, so `/api` runs through dsh's own bridge, trust fence, and Typert gateway. |
| `src/host` | The boot, plus browser rows for the handful of capabilities a page cannot have. |
| `src/plugins` | Plugin installation from the npm registry, a tarball URL, a GitHub repository, or a path in this filesystem, with an ES-module loader that binds installed packages to this app's single cordis instance. |
| `packages/` | The plugins this repository ships: the terminal, the plugin installer, and the shell the model is told about. |

Five composition rows are swapped, each because the shipped one names a host
capability a page does not have; `src/host/browser.patch.yml` is the complete
list, and it is a normal `cordis.patch.yml` layer. A sixth row, the bash tool,
is replaced for a different reason — see
[the shell section](#the-shell-the-model-is-told-about). `scripts/alignment.ts`
prints the whole difference against what `dsh web` composes.

## Install

```sh
npm ci
npm run build     # → dist/
node scripts/serve.mjs 4173
```

Node 22 or newer. There is nothing else to install: the runtime is fetched by
the browser at boot.

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
- **Terminal** (`Ctrl+\`` or the sidebar action) is Node in this tab, and it is
  the same environment — and the same shell — the agent's tools run in.
- **Plugins** install from Settings → Plugins, or with `/plugin add <package>`
  in the composer. Both are the same plugin, and both take an npm name, a
  tarball URL, `owner/repo#ref`, or a path.

## The runtime

`dsh web` runs on a machine. In a browser there is no machine, so the page
carries one: **WebContainers**, which is Node itself running in the tab — not an
emulation of it.

```
$ node -p "[process.version, process.arch, process.platform].join(' ')"
v22.22.3 x64 linux
$ npm install is-odd && node -e "import('is-odd').then(m => console.log(m.default(3)))"
added 2 packages in 2s
true
```

**The agent runs there too.** That is the part worth checking rather than
claiming: the shell tool spawns into the same container the terminal is attached
to, and Read/Write/Edit route through the same filesystem, so a file either one
creates is immediately visible to the other. `scripts/runtime-e2e.ts` asserts
exactly that, in both directions.

Two things follow from `SharedArrayBuffer`, which the runtime needs:

- The page must be cross-origin isolated, and isolation is requested through
  headers a static host cannot be told to send. `public/sw.js` adds them, and
  the first load reloads once through the worker to pick them up.
- The filesystem is in memory, so the workspace is snapshotted to IndexedDB on a
  debounce and on `pagehide`, and restored at boot.

## The shell the model is told about

What WebContainers has for a shell is `jsh`, and `jsh` is not one. `for`, `if`,
`while`, `case`, functions, heredocs and `<` are syntax errors — and `$(…)`,
backticks and `$((…))` are **accepted, expanded to the empty string, and
reported as success**. A model asked to count files writes
`n=$(ls | wc -l); echo $n`, reads `[exit code: 0]` and an empty line, and
concludes the directory is empty. Nothing errors. Nothing retries.

There are two honest answers to that, and this repository has both.

`src/shell/` is the first: a POSIX shell — parser, expansion, control flow,
coreutils, awk, git — written against the page's own filesystem and checked
against real bash by `scripts/shell-diff.mjs`, 305 constructs at last count. It
is what runs when the runtime cannot start at all.

`packages/dsh-web-jsh/` is the second, and it is what the shipped composition
mounts: **run the shell the machine actually has, and describe it exactly.** The
plugin disables `tool-bash` and registers its replacement — one shell tool, not
two — whose description is the measured capability matrix: which constructs fail
silently, which fail loudly, which commands exist, and what to use instead.

```
This tool does NOT run bash. The shell is `jsh` …

NEVER use these. jsh accepts them, expands them to the empty string, and exits 0:
  `$(...)` and backticks   command substitution
  `$((...))`               arithmetic
NEVER use these. jsh reports a syntax error and the command does nothing:
  `for`, `while`, `if`, `case`, and shell functions
Available commands, and no others: alias cat cd chmod … node npm npx python3 …
Do anything else in a language: `node -e '...'`, `python3 -c '...'`, `jq`.
```

The replacement keeps the name `bash`, which is worth being explicit about. A
model reaches for a tool called `bash` whether or not the roster offers one — it
is the strongest prior any of them has about a shell. Registering the
replacement as `jsh` and removing `bash` was tried first, and what happened is
what that sentence predicts: the model went on emitting `bash` calls, and they
now matched nothing at all. So the plugin takes the slot the model will use and
spends the description's first line saying the name is wrong.

It swaps both halves together — the interpreter commands are handed to, and the
description the model plans against — because swapping either one alone is how
the confident wrong answer happens. Everything else about a command is
unchanged: `ctx.shell` still resolves the timeout, still confines the command
under the sandbox policy, still spills long output to a file, and still runs it
in the background when asked.

Removing the directory puts the harness shell back.

## The plugins this repository ships

None of them is part of this app. They are ordinary dsh plugins in `packages/`,
each with its own `cordis.patch.yml` — discovered, built, and composed the same
way an installed plugin is. Removing one is removing a directory.

- `dsh-web-terminal` — a terminal, injected into the surface's `shell.overlay`
  and `sidebar.footer.action` slots rather than drawn over it.
- `dsh-web-plugins` — installing a plugin from the browser, in the Settings
  page the surface already owns and offers no way to add to.
- `dsh-web-jsh` — the shell above.

What the app owns is the capability, published as a bridge in
`src/host/bridges.ts`: a plugin runs outside this app's bundle graph and cannot
import its modules, and the runtime must be shared rather than booted per
consumer.

## How close is this to `dsh web`?

`npx tsx scripts/alignment.ts` answers that by diffing the composition this
build runs against the one the published bundles declare:

```
dsh web composes 129 rows.
  disabled by this build (6) ── web-startup, web-runtime, modules,
                                typert-loader, sandbox, tool-bash
  replaced (5)              ── a browser row for each of the first five
  shipped as plugins (3)    ── web-terminal, web-plugin-install, web-jsh
  reconfigured (1)          ── agent-presets
117 of 129 rows compose exactly as `dsh web` composes them.
```

Each of the five browser swaps names a host capability a page does not have:
parsing a command line, binding a port and serving `dist/`, scanning plugin
packages on disk, reading Typert artifacts from disk, and an OS process sandbox.
The sixth, `tool-bash`, is not a capability gap but a truthfulness one, and
[the section above](#the-shell-the-model-is-told-about) is the argument for it.

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

- **The runtime is Node, not a distribution.** No compiler and no arbitrary
  binary. `python3` is there and is RustPython 3.11 — most of the standard
  library works, `pathlib` and `subprocess` do not, and there is no pip.
- **The shell is `jsh`.** See [the section above](#the-shell-the-model-is-told-about)
  for exactly what that costs. The largest single loss is `git`: WebContainers
  ships none, so the agent cannot commit. The `grep` and `glob` tools are
  unaffected — they are answered at the spawn seam by `src/runtime/ripgrep.ts`,
  not by a shell command.
- **Code Mode does not work.** The `run_code` transport needs worker stdout and
  real TypeScript type stripping, and neither is implemented, so every tool call
  in that preset fails.
- **A second tab is a second host.** Two tabs on this origin each boot their own
  host over one IndexedDB, with no coordination between them.
- **Storage has no quota handling.** Nothing requests persistence or reacts to
  eviction.
- **Network reach is the browser's.** A request only succeeds if the origin
  permits cross-origin reads. The DeepSeek API does; many hosts do not. The
  container's own `npm install` goes through StackBlitz's proxy and works.
- **No listening port.** Nothing can bind, so a plugin whose contract is a
  local server or an stdio child process cannot work here.
- **`AsyncLocalStorage` is approximate.** A page cannot intercept `await`, so
  causal attribution can be wrong when two turns run concurrently. It is exact
  for a single active turn. See `src/node/async-context.ts`.
- **Terminals are line-oriented.** The PTY replacement runs a command per line;
  raw-mode and full-screen programs are out of reach.
- **Session search is off.** `node:sqlite` is stubbed over sql.js and the
  shipped composition already sets `openAt: never`.

## Development

```sh
npm run assemble    # regenerate the roster/manifest/module map from node_modules
npm run build
node scripts/serve.mjs 4173

npx tsx scripts/e2e.ts                                  # boot, plugins, the jsh contract, persistence
DEEPSEEK_API_KEY=… npx tsx scripts/e2e.ts               # …plus a real model turn
DEEPSEEK_API_KEY=… npx tsx scripts/ui-e2e.ts            # the whole user path, through the UI
npx tsx scripts/runtime-e2e.ts                          # Node, npm, and agent↔terminal sharing
npx tsx scripts/fallback-e2e.ts                         # the degraded path, with no runtime
npm run test:shell                                      # src/shell against real bash
npx tsx scripts/alignment.ts                            # how far the composition is from `dsh web`
npx tsx scripts/plugin-e2e.ts                           # community plugin compatibility
```

`scripts/e2e.ts` asserts jsh's silent failures on purpose — that `$(…)` still
expands to nothing and still exits 0. A day when one of those starts working is
a day `packages/dsh-web-jsh` needs its description rewritten, and the suite says
so in the failure message.

Upgrading the harness is a dependency bump: change the `@deepseek-ai/*` versions
in `package.json`, run `npm run assemble`, and rebuild. Nothing here is
hand-maintained against upstream's package list.

## Deploying

`.github/workflows/pages.yml` builds, boots the result in a real browser, and
publishes `dist/` to GitHub Pages. Enable Pages with the "GitHub Actions" source
and push to `main`.

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
build composes are published by DeepSeek AI under their own terms (MIT); nothing
here modifies or redistributes their source.
