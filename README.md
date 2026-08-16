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
| `src/plugins` | Plugin installation from the npm registry, with an ES-module loader that binds installed packages to this app's single cordis instance. |

Six composition rows are swapped, each because the shipped one names a host
capability a page does not have — the app-owned command line, dist serving, the
plugin table, Typert artifact loading, and the OS process sandbox. Every other
row boots exactly as `dsh web` composes it. `src/host/browser.patch.yml` is the
complete list, and it is a normal `cordis.patch.yml` layer.

## Using it

Open the page. It walks the same first-run flow as `dsh web`: acknowledge the
notice, enter a DeepSeek API key, choose a workspace, start talking.

Your API key, files, sessions, and settings live in your browser's storage for
that origin and are never uploaded. Model requests go from your browser
straight to the provider.

- **Files** persist across reloads. `window.dsh.exportFs()` downloads the
  workspace as a zip; `window.dsh.reset()` clears everything.
- **Shell** commands run in the in-browser shell. `git init/add/commit/log/diff/
  branch/checkout` work locally; `git clone` needs an origin that permits
  cross-origin reads (set `GIT_CORS_PROXY` for the rest).
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

- **No native toolchain.** There is no compiler, package manager, or Python in
  the page. `npm`, `python3`, and friends say so rather than hanging.
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

MIT, matching upstream. The `@deepseek-ai/*` packages this build composes are
published by DeepSeek AI under their own terms.
