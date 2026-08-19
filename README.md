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
- [The models it ships with](#the-models-it-ships-with)
- [Reaching a host that refuses browsers](#reaching-a-host-that-refuses-browsers)
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
| `src/net` | The page's `fetch` and `WebSocket` routed into an in-page virtual server, so `/api` runs through dsh's own bridge, trust fence, and Typert gateway — plus the CORS policy every cross-origin request goes out through. |
| `src/host` | The boot, plus browser rows for the handful of capabilities a page cannot have. |
| `src/plugins` | Plugin installation from the npm registry, a tarball URL, a GitHub repository, or a path in this filesystem, with an ES-module loader that binds installed packages to this app's single cordis instance. |
| `packages/` | The plugins this repository ships: the terminal, the plugin installer, the Network settings page, the repository link at the sidebar foot, and the shell the model is told about. |

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

Open the page, acknowledge the notice, choose a workspace, start talking.
**There is no key step** — the default model is OpenCode Zen's free tier, which
serves a request with no account at all. `dsh web` asks for a DeepSeek key here
because a machine is being configured; a page is being opened, and it should
answer before it asks for anything.

Any key you do enter, along with your files, sessions, and settings, lives in
your browser's storage for that origin and is never uploaded. Model requests go
from your browser to the provider — directly where the provider answers a
browser, and otherwise through the proxy in
[Settings → Network](#reaching-a-host-that-refuses-browsers).

- **Files and sessions** persist across reloads: reopening the page restores the
  workspace, its session list, and each session's transcript from the same
  append-only JSONL logs `dsh web` writes. `window.dsh.exportFs()` downloads the
  workspace as a zip; `window.dsh.reset()` clears everything.
- **Terminal** (`Ctrl+\`` or the sidebar action) is Node in this tab, and it is
  the same environment — and the same shell — the agent's tools run in.
- **Plugins** install from Settings → Plugins, or with `/plugin add <package>`
  in the composer. Both are the same plugin, and both take an npm name, a
  tarball URL, `owner/repo#ref`, or a path.
- **Models** are in Settings → Models, which offers the whole installed
  provider catalog; typing a key for one is the whole of configuring it. The
  default model needs no key at all.
- **Network** is in Settings → Network, and matters more here than it would on a
  machine — see [below](#reaching-a-host-that-refuses-browsers).

## The models it ships with

`dsh` composes two model adapters. `llm-deepseek` serves DeepSeek. The other,
`llm-pi-ai`, is a multi-provider adapter carrying a catalog of its own — and
upstream mounts it **dormant**, serving nothing until a deployment names the
routes it has keys for. That posture is kept: preregistering a provider whose
key nobody has would fill the picker with a thousand models that cannot be
called. Every one of them is still one card away, in Settings → Models, which
offers the whole installed catalog and registers a route the moment a key is
typed for it.

What this build adds is the one route that needs no configuring, because it
needs no account:

```
$ npm run assemble
[assemble] 1 default provider routes, 5 models
```

### The one that needs no key

A provider you must configure leaves a first-time visitor exactly where
`dsh web` leaves them: at a form. OpenCode Zen prices seven of its models at
zero and serves them to an **unauthenticated** request, so this build declares
a route for them and makes it the default. Five, in the end: two of the seven
answer `401 Model … is not supported` to every request, so a price is not a
promise and the roster subtracts them — that list is measured, and
`scripts/assemble.ts` carries the one-line command to re-check it.

```
provider: opencode-free
model:    deepseek-v4-flash-free
```

Open the page and the model answers. The first-run key step does not render at
all, because the Models page ends onboarding for a provider whose profile names
no credential reference — which this one does not, because it needs none.

Getting there meant finding what actually stops it, and two different things
do. pi-ai will not dispatch without a key: a *catalog* route with no
`apiKeyEnv` fails `Provider is not configured` before a request is built, and a
*declared* route gets one step further and fails `No API key for provider`.
That second gate is the one with a way through — pi-ai accepts a request
carrying no key when the profile supplies an `authorization` header, and the
OpenAI client merges `defaultHeaders` *after* its own `Authorization`, so the
profile's value is what reaches the wire. The value has to be `Bearer` with
nothing after it: Zen answers 200 to an empty bearer and 401 `Invalid API key`
to any non-empty one, so a placeholder key is not a substitute for having none.

The route is declared beside `opencode` rather than replacing it, because they
are different postures: `opencode` keeps its credential reference and serves all
58 models to whoever has an account; `opencode-free` serves the seven that need
none. Sharing one route would mean the header override silently ignoring a key
the user had typed. Which models are free is read from the catalog's own
prices, so a model that stops being free stops being offered here.

Two costs, both measured, neither hidden:

- **It only works through the proxy.** `opencode.ai/zen` answers a CORS
  preflight with a 404 HTML page and sends no `access-control-allow-origin`, so
  a browser cannot reach it directly. Turning the proxy off in Settings →
  Network turns the default model off with it.
- **The free tier is rate-limited upstream, per model.** A model whose pool is
  spent answers `429 FreeUsageLimitError — Error from provider (Console)` and
  keeps doing so for a good while — `deepseek-v4-flash-free` stayed that way for
  half an hour under testing — while its siblings on the same route answer
  normally. So a 429 on the default is a reason to pick another free model in
  the composer, not a sign the route is broken. It is a real free tier, not a
  private one, and every other provider is one key away.

`deepseek-official` / `deepseek-v4-flash` remains available and is one selection
away in the composer's picker.

## Reaching a host that refuses browsers

A tab's network reach is the browser's, and CORS is the whole rule: a host
answers only if it says so in its own response headers. That is not a
limitation this build works around so much as the single fact that shapes it,
and it is worth publishing what was actually measured from the page rather than
what is assumed.

Answers a browser: the npm registry, `api.github.com`,
`raw.githubusercontent.com`, `cdn.jsdelivr.net`, and — for models — DeepSeek,
Google, OpenRouter, Groq, Mistral, Together, Fireworks, HuggingFace, Moonshot,
xAI, z.ai, Xiaomi, GitHub Copilot. Anthropic joins them only because pi-ai sends
`anthropic-dangerous-direct-browser-access`, which is Anthropic's own opt-in;
without that header it refuses, and a plain `fetch` to it from here still does.

Refuses a browser: **OpenAI**, NVIDIA, Cerebras, Vercel's AI gateway, MiniMax,
Alibaba's token-plan endpoints, ant-ling, `codeload.github.com` — where GitHub
keeps every repository tarball — and **`opencode.ai/zen`**, which serves this
build's own default model and answers a preflight with a 404 HTML page.

So the page has one fallback, and **Settings → Network** is where it is chosen:
a CORS proxy, applied automatically by `src/net/cors-proxy.ts` and never before
a direct attempt has actually failed. A host that answers a browser never goes
through it; an origin that needed it once is remembered and skips the wasted
round trip after that. The page reports which origins it used the proxy for, on
that same page, because a user routing traffic through a third party should be
able to see it happening.

The default is `https://proxy.cors.sh/{url}`, chosen by measurement:
with a production `Origin` and a POST carrying an `authorization` header, it
answered in 0.4s and `https://cors.eu.org/{url}` in 3.3s, both forwarding
headers and body intact and neither requiring a key. `corsproxy.io` and
`cors-anywhere` answered 403; `allorigins`, `codetabs`, `thingproxy`, `yacdn`,
`cors.lol` and `test.cors.workers.dev` were unreachable or refused the method.
The field takes any URL with a `{url}` or `{encoded}` placeholder, and the
checkbox above it turns the whole thing off.

Two things are worth knowing before leaving the default on:

- **A proxy sees the whole request** — URL, headers, body, and the API key on a
  model request routed through it. No cookies are sent and only a host that
  refuses browsers is ever proxied, but that is the trade.
- **Both public proxies buffer.** Measured against a 3-second dripping
  response, a direct fetch arrived in twelve chunks and each proxy delivered
  one, at the end. A proxied model reply is therefore correct and complete but
  arrives whole rather than a word at a time.

Both are fixed the same way: run your own. A Cloudflare Worker that forwards the
request and returns `response.body` unread is enough, and it streams.

One place this does not reach, one that no longer needs it, and one note beside
them:

- **The runtime.** A WebContainer's requests leave from StackBlitz's own worker,
  which neither a patched `window.fetch` nor `public/sw.js` ever sees — both
  were measured, and both see zero. So for commands the agent runs, the proxy
  cannot be applied by code; `src/host/jsh-tool.ts` reads the same setting and
  tells the model what it may use instead, which means turning the proxy off
  removes the advice rather than leaving the model retrying through a host the
  user declined. StackBlitz's own CORS proxy is no help either: it is a
  stackblitz.com project feature (a `.stackblitzrc` plus a paid plan) with no
  effect on a self-hosted embed. `BootOptions.coep` cannot help by construction
  — `credentialless` relaxes what the page may embed, while a cross-origin
  response still has to pass CORS to be *readable*.
- **GitHub plugin sources no longer need a proxy at all.** `codeload` refuses
  browsers, but `api.github.com` and `raw.githubusercontent.com` do not, so
  `owner/repo#ref` is read the way git would read it: one tree listing, then the
  blobs. The tarball through the proxy stays as the fallback for a rate-limited
  API or a repository too large to list.
- **The `curl` in the container is a stub** — prefer `node -e "fetch(...)"`.

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
- The filesystem is in memory, so it is snapshotted to IndexedDB on a debounce
  and on `pagehide`, and restored at boot. The whole working directory is kept,
  not one directory inside it: the picker opens on Home and offers a New folder
  button, so the workspace is wherever the user made it, and everything under
  that directory — bar the harness's own `.dsh` — is theirs. It is also the
  subtree the agent's file tools are routed into, which is what makes the
  commands it runs and the files it reads the same machine.

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

`src/host/jsh-tool.ts` is the second, and it is what this build ships: **run the
shell the machine actually has, and describe it exactly.** The tool's
description is the measured capability matrix — which constructs fail silently,
which fail loudly, which commands exist, and what to use instead:

```
This is the only shell tool in this session; there is no `bash` tool …

NEVER use these. jsh accepts them, expands them to the empty string, and exits 0:
  `$(...)` and backticks   command substitution
  `$((...))`               arithmetic
NEVER use these. jsh reports a syntax error and the command does nothing:
  `for`, `while`, `if`, `case`, and shell functions
Available commands, and no others: alias cat cd chmod … node npm npx python3 …
Do anything else in a language: `node -e '...'`, `python3 -c '...'`, `jq`.
```

It swaps both halves together — the interpreter commands are handed to, and the
description the model plans against — because swapping either one alone is how
the confident wrong answer happens. Everything else is unchanged: `ctx.shell`
still resolves the timeout, confines the command under the sandbox policy,
spills long output to a file, and backgrounds it when asked.

**Where the swap happens is the whole trick, and it is worth writing down.**
`tool-bash` appears in two different compositions. One is the host plane, which
`src/host/browser.patch.yml` disables like any other row. The other is inside
each agent preset's `agent.cordis.yml` — a separate composition that no host
patch layer can see. Disabling only the first produces a build where the loader
reports `tool-bash disabled=true` and every model request still carries a `bash`
tool. So `scripts/assemble.ts` rewrites the preset row as it seeds it, and
throws if no preset mounted one.

Presets do not agree on how they mount a shell, either. Three carry a
`tool-bash` row; `minimal` builds a persistent one out of a PTY registry, a bash
backend, and `dsh-tool-bash-persistent` in a realm of its own, and the
row-shaped rewrite never touched it — so that preset kept handing the model a
`bash` whose description promises apt and pip. Both shapes are rewritten now,
and the seeding step refuses to ship a preset that still names any bash-backed
shell, because the next shape will not be one either rewrite knows.

That is also why `scripts/e2e.ts` asserts against a captured model request
rather than the tool registry. Three suites went green over a build that was
still sending `bash` to the model, because all three asked the registry —
`ctx.tools.schemas()` with no scope reports the unscoped subset, and the shell
tool is agent-scoped. The request is the only thing that cannot be wrong about
what the model was offered.

## The plugins this repository ships

None of them is part of this app. They are ordinary dsh plugins in `packages/`,
each with its own `cordis.patch.yml` — discovered, built, and composed the same
way an installed plugin is. Removing one is removing a directory.

- `dsh-web-terminal` — a terminal, injected into the surface's `shell.overlay`
  and `sidebar.footer.action` slots rather than drawn over it.
- `dsh-web-plugins` — installing a plugin from the browser, in the Settings
  page the surface already owns and offers no way to add to.
- `dsh-web-star` — a link to this repository at the sidebar foot, in the same
  `sidebar.footer.action` slot, with the star count GitHub reports. The page is
  the only place most visitors ever see this project, so it is the only place
  the ask can be made; it is one row, and it is never modal.
- `dsh-web-network` — the Network settings page, a `settings.section` between
  Models and Plugins, where the CORS proxy is chosen. The setting itself is the
  app's: `src/net/cors-proxy.ts` applies it to every cross-origin request, long
  before any plugin has mounted. What the plugin owns is the page it is edited
  on — which is why removing the directory removes the page and leaves the
  policy, rather than leaving the app unable to reach anything.

Both foot actions wear the sidebar's own Settings row — the same height, radius,
gap, and hover, and the same 36px circle when the column folds to the icon rail
— and each takes a line of its own above it, so the foot reads as one stack of
rows rather than as a surface with plugins stuck to the bottom of it.

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
  shipped as plugins (4)    ── web-terminal, web-plugin-install, web-star,
                                web-network
  reconfigured (3)          ── agent-presets, llm-pi-ai, agent-default-model
115 of 129 rows compose exactly as `dsh web` composes them.
```

Each of the five browser swaps names a host capability a page does not have:
parsing a command line, binding a port and serving `dist/`, scanning plugin
packages on disk, reading Typert artifacts from disk, and an OS process sandbox.
The sixth, `tool-bash`, is not a capability gap but a truthfulness one, and
[the section above](#the-shell-the-model-is-told-about) is the argument for it.
It is also disabled a second time, in the agent presets, for the reason given
there.

Nothing in this repository is a copy of dsh. The packages come from npm at
install time, `scripts/assemble.ts` derives the roster, the client bundles, and
the host module map from them at build time, and the only modification is a
`cordis.patch.yml` layer — the mechanism dsh documents for exactly this.

## Plugin compatibility

Community plugins compose into the running tree exactly as they do on a real
machine: the tarball unpacks into the virtual filesystem, its `cordis.patch.yml`
becomes another patch layer on the root include, its host half loads through the
module system, and its browser half is published to the client graph as a blob
URL.

Every source `dsh plugin add` takes works here, including the one CORS used to
close off: `owner/repo`, `github:owner/repo#ref`, and a bare tarball URL install
alongside an npm name and a path. A GitHub reference is read through the trees
API and `raw.githubusercontent.com`, which answer a browser — not through
`codeload`, which does not.

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
- **Network reach is the browser's, and CORS is the whole rule.** The page has
  one answer to that — a configurable proxy it applies itself, after a direct
  attempt has failed — and it does not reach the runtime, where the agent's
  commands run. What was measured, what is proxied, and what it costs are in
  [the section above](#reaching-a-host-that-refuses-browsers).
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

npx tsx scripts/e2e.ts                                  # boot, plugins, the jsh contract, the model catalog,
                                                        # the CORS policy, persistence
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
a day `src/host/jsh-tool.ts` needs its description rewritten, and the suite says
so in the failure message. It also captures a real model request (with a
placeholder key, which the provider rejects only after the body is built) and
asserts the model was offered `jsh` and no `bash`.

The CORS policy is asserted from both sides, because only one of them is the
feature: that a host which answers a browser is *not* proxied, that a host which
refuses one is reached anyway, and that turning the proxy off restores the
failure. The GitHub install is asserted not to have used the proxy at all — the
fallback would otherwise let the trees-API route rot while every test stayed
green and every plugin install quietly went through a stranger.

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
