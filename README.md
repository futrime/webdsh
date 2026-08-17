# DeepSeek Harness, in the browser

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is an
agent harness where everything is a plugin. `dsh web` runs a Node host and
serves a browser client to it.

This repository builds the same thing as **static files**. There is no server
process, no install, and no Node: the harness host runs inside the page, the
published web client connects to it over an in-page transport, and the whole
thing deploys to GitHub Pages.

```sh
npm ci
npm run build     # → dist/
node scripts/serve.mjs 4173
```

## What actually runs

The published `@deepseek-ai/*` packages, unmodified. The agent loop, session
log, tool registry, prompt assembly, model adapters, permission policy, agent
presets, and the entire web client are the real ones from npm — this repository
adds no fork of them and patches none of their source.

What it adds is the platform underneath:

| Layer | What it is |
|---|---|
| `src/vfs` | A synchronous POSIX volume with an IndexedDB write-behind mirror. Synchronous is the point: `readFileSync` is how dsh reads settings, credentials, presets, and skills. |
| `src/node` | `node:*` implemented over it — fs, path, os, crypto, child_process, worker_threads, http, stream, zlib, sqlite, async_hooks — plus `node-pty` and `sharp` replacements, so the real subprocess and attachment providers load unchanged. |
| `src/shell` | A POSIX shell: pipelines, redirects, globs, quoting, parameter expansion, arithmetic, functions, `if`/`for`/`while`/`case`, and coreutils. `git` is [isomorphic-git](https://isomorphic-git.org); `curl`/`wget` are the page's own `fetch`. |
| `src/net` | The page's `fetch` and `WebSocket` routed into an in-page virtual server, so `/api` runs through dsh's own bridge, trust fence, and Typert gateway. |
| `src/host` | The boot, plus browser rows for the handful of capabilities a page cannot have. |
| `src/plugins` | Plugin installation from the npm registry, a tarball URL, a GitHub repository, or a path in this filesystem, with an ES-module loader that binds installed packages to this app's single cordis instance. |
| `src/vm` | A real Linux virtual machine. [CheerpX](https://cheerpx.io) executes x86 in WebAssembly, and the disk is a Debian root filesystem built by `scripts/vm/`. |
| `src/terminal` | [xterm.js](https://xtermjs.org) in front of that machine, plus the plugin inventory. |

Six composition rows are swapped, each because the shipped one names a host
capability a page does not have — the app-owned command line, dist serving, the
plugin table, Typert artifact loading, and the OS process sandbox. Every other
row boots exactly as `dsh web` composes it. `src/host/browser.patch.yml` is the
complete list, and it is a normal `cordis.patch.yml` layer.

## The terminal is a real machine

`dsh web` runs on a computer, so a user who wants a shell opens one. Here there
is no outside, so the page carries a Linux machine: **CheerpX** virtualizes x86
in WebAssembly and boots a Debian 12 root filesystem — not an emulation of a
POSIX system written in TypeScript, but real binaries executing as themselves.

```
$ uname -a
Linux 4.15.0-54-cheerpx i386 GNU/Linux
$ node --version && python3 --version && git --version
v18.20.4
Python 3.11.2
git version 2.39.5
$ busybox | head -1
BusyBox v1.35.0 (Debian 1:1.35.0-4+deb12u1+b1) multi-call binary.
```

Two programming environments — **Python 3.11** and **Node 18** — on a full
Debian command line: bash, busybox, coreutils, findutils, grep/sed/awk, git and
git-lfs, curl, wget, openssh-client, tar/gzip/xz/zstd/zip, ripgrep, fd, jq,
sqlite3, vim, nano, less, tree, and `build-essential`, which is what makes
`npm install` of a native module and `pip install` of a C extension work rather
than fail at the last step.

Three things make this deployable as static files:

- **Cross-origin isolation.** The engine needs `SharedArrayBuffer`, which a
  browser grants only an isolated page, and isolation is requested through
  headers a static host cannot be told to send. `public/sw.js` adds them; the
  first load reloads once through the worker to pick them up.
- **A streamed disk.** The image is read by HTTP range request, so booting takes
  a second or two rather than waiting for a gigabyte.
- **A chunked disk.** GitHub Pages rejects files over 100 MB, so
  `scripts/vm/chunk.mjs` splits the image into gzipped 4 MB pieces and drops
  all-zero regions as holes — a 1.26 GB filesystem ships as 242 MB — and the
  service worker reassembles it on the way to the engine.

Writes land in an IndexedDB overlay, so what the machine does survives a reload.

Building the disk needs Docker and is separate from building the app:

```sh
npm run vm:build   # scripts/vm/Dockerfile → build/vm/dsh.ext2 (i386 Debian)
npm run build      # app + chunks the disk into dist/vm/disk/
npm run test:vm    # compiles C, runs Python/Node, commits to git, reloads
```

The app builds and runs without the disk; only the terminal needs it.

### Why not `devcontainers/universal`

Because it cannot run in a browser. CheerpX executes 32-bit x86 only and caps an
ext2 image at 2 GB; that image is amd64-only and roughly 12–15 GB expanded.
`container2wasm` does run real x86-64 containers, but packages one into a single
`.wasm`, which is worse on both counts. So the toolchain is rebuilt on i386 at a
size a static host will actually serve.

## Using it

Open the page. It walks the same first-run flow as `dsh web`: acknowledge the
notice, enter a DeepSeek API key, choose a workspace, start talking.

Your API key, files, sessions, and settings live in your browser's storage for
that origin and are never uploaded. Model requests go from your browser
straight to the provider.

- **Files and sessions** persist across reloads: reopening the page restores the
  workspace, its session list, and each session's transcript from the same
  append-only JSONL logs `dsh web` writes. `window.dsh.exportFs()` downloads the
  workspace as a zip; `window.dsh.reset()` clears everything.
- **Terminal** (`Ctrl+\``) is a Debian machine with Python, Node, git, and the
  usual command line. It is not the environment the agent's tools run in — see
  the limits below.
- **Shell** commands from the agent run in the in-browser shell. `git init/add/
  commit/log/diff/branch/checkout` work locally; `git clone` needs an origin
  that permits cross-origin reads (set `GIT_CORS_PROXY` for the rest).
- **Plugins** install with `/plugin add <package>` in the composer — the
  browser's counterpart to `dsh plugin add`. Reload to compose them.

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

- **The agent and the terminal are different environments.** The terminal is the
  Linux VM; the agent's tools still run against the in-page emulated filesystem
  described above. Files created in one are not visible in the other. Joining
  them is the next step and is not done.
- **The VM is 32-bit and offline.** CheerpX executes i386 only, and the machine
  has no network of its own — `apt-get` and `pip install` from inside it cannot
  reach a registry. What it has is what the image was built with.
- **Network reach is the browser's.** A request only succeeds if the origin
  permits cross-origin reads. The DeepSeek API does; many hosts do not.
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

npx tsx scripts/e2e.ts                                  # boot, plugins, shell, persistence
DEEPSEEK_API_KEY=… npx tsx scripts/e2e.ts               # …plus a real model turn
DEEPSEEK_API_KEY=… npx tsx scripts/ui-e2e.ts            # the whole user path, through the UI
npx tsx scripts/plugin-e2e.ts                           # community plugin compatibility
```

Upgrading the harness is a dependency bump: change the `@deepseek-ai/*` versions
in `package.json`, run `npm run assemble`, and rebuild. Nothing here is
hand-maintained against upstream's package list.

## Deploying

`.github/workflows/pages.yml` builds, boots the result in a real browser, and
publishes `dist/` to GitHub Pages. Enable Pages with the "GitHub Actions" source
and push to `main`.

The build uses relative asset URLs, so it works at a project path
(`user.github.io/repo/`), at a domain root, or from a local directory.

## License

Apache License 2.0 — see [LICENSE](LICENSE). The `@deepseek-ai/*` packages this
build composes are published by DeepSeek AI under their own terms (MIT); nothing
here modifies or redistributes their source.
