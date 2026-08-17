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
| `src/shell` | A POSIX shell over that filesystem, used when the runtime cannot start — a browser without cross-origin isolation still boots, and still runs tool calls. |
| `src/runtime` | [WebContainers](https://webcontainers.io): Node in the tab. The terminal attaches to it and the agent executes in it, so they are one machine. |
| `src/net` | The page's `fetch` and `WebSocket` routed into an in-page virtual server, so `/api` runs through dsh's own bridge, trust fence, and Typert gateway. |
| `src/host` | The boot, plus browser rows for the handful of capabilities a page cannot have. |
| `src/plugins` | Plugin installation from the npm registry, a tarball URL, a GitHub repository, or a path in this filesystem, with an ES-module loader that binds installed packages to this app's single cordis instance. |
| `packages/` | The plugins this repository ships: the terminal and the plugin installer, each an ordinary dsh plugin. |

Five composition rows are swapped, each because the shipped one names a host
capability a page does not have. `src/host/browser.patch.yml` is the complete
list, it is a normal `cordis.patch.yml` layer, and `scripts/alignment.ts` prints
the difference against what `dsh web` composes.

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
claiming: the Bash tool spawns into the same container the terminal is attached
to, and Read/Write/Edit route through the same filesystem, so a file either one
creates is immediately visible to the other. `scripts/runtime-e2e.ts` asserts
exactly that, in both directions.

Two things follow from `SharedArrayBuffer`, which the runtime needs:

- The page must be cross-origin isolated, and isolation is requested through
  headers a static host cannot be told to send. `public/sw.js` adds them, and
  the first load reloads once through the worker to pick them up.
- The filesystem is in memory, so the workspace is snapshotted to IndexedDB on a
  debounce and on `pagehide`, and restored at boot.

What it is not is a Linux distribution. `jsh` is a JavaScript shell: it has
pipelines, redirects, `&&`/`||`, variables, and the common file commands, and it
does not have `for`, `printf`, `wc`, `awk`, or arithmetic expansion. There is no
Python and no compiler. The `grep` and `glob` tools spawn ripgrep, which is not
there either, so `src/runtime/ripgrep.ts` implements the two argument vectors
they build and is reached at the spawn seam.

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
and cannot import this app's modules, and the runtime must be shared rather than
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
- **Terminal** (`Ctrl+\`` or the sidebar action) is Node in this tab, and it is
  the same environment the agent's tools run in — a file either of you creates,
  the other sees.
- **Plugins** install from Settings → Plugins, or with `/plugin add <package>`
  in the composer. Both are the same plugin, and both take an npm name, a
  tarball URL, `owner/repo#ref`, or a path.

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

- **The runtime is Node, not a distribution.** No Python, no compiler, no
  arbitrary binary, and `jsh` is a JavaScript shell rather than a POSIX one — no
  `for`, `printf`, `wc`, `awk`, or arithmetic expansion. What is there is Node,
  npm, and the common file commands.
- **Code Mode does not work.** The `run_code` transport needs worker stdout and
  real TypeScript type stripping, and neither is implemented, so every tool call
  in that preset fails.
- **A second tab is a second host.** Two tabs on this origin each boot their own
  host over one IndexedDB, with no coordination between them.
- **Storage has no quota handling.** Nothing requests persistence or reacts to
  eviction.
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
npx tsx scripts/runtime-e2e.ts                          # Node, npm, and agent↔terminal sharing
npx tsx scripts/alignment.ts                            # how far the composition is from `dsh web`
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
