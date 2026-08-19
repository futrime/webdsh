# webdsh

[![webdsh — DeepSeek Harness in a browser tab, with no server and no install](https://capsule-render.vercel.app/api?type=rect&height=180&color=0:0d1117,55:15407e,100:2f81f7&text=webdsh&fontSize=68&fontColor=ffffff&fontAlignY=45&desc=DeepSeek+Harness+in+a+browser+tab+%C2%B7+no+server+%C2%B7+no+install&descSize=19&descAlignY=70)](https://dsh.zjzh.me/)

> DeepSeek Harness in a browser tab — the real agent, real Node, no server to run.

[![Live](https://img.shields.io/badge/live-dsh.zjzh.me-2ea44f)](https://dsh.zjzh.me/)
[![Deploy](https://github.com/futrime/webdsh/actions/workflows/pages.yml/badge.svg)](https://github.com/futrime/webdsh/actions/workflows/pages.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is an
agent harness where everything is a plugin. `dsh web` runs a Node host and serves
a browser client to it. **webdsh is that, as static files** — the host runs inside
the page, and the agent's commands run in [WebContainers](https://webcontainers.io):
Node itself, in the tab.

- ⚡ **Nothing to run.** No server, no install, no local Node — the harness boots in the page.
- 🖥️ **Real Node, real Python.** `npm install` and `pip install` both work, and the terminal and the agent share one container.
- 🧩 **Real plugins.** Install from npm, a tarball, GitHub, or a path — from the browser.
- 📦 **Real dsh.** The published `@deepseek-ai/*` packages, unmodified: 115 of 129 rows compose exactly as `dsh web` composes them.
- 🔒 **Yours.** Files, sessions and keys live in your browser's storage. Nothing is uploaded.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

Nothing here is a fork of dsh. The agent loop, tool registry, model adapters and
the entire web client come from npm at install time; the only modification is a
`cordis.patch.yml` layer — the mechanism dsh documents for exactly this.

What this repository adds is the platform underneath: a synchronous POSIX
filesystem mirrored to IndexedDB (`src/vfs`), `node:*` implemented over it
(`src/node`), the WebContainers runtime (`src/runtime`), an in-page virtual
server for `/api` plus the CORS policy every outbound request goes through
(`src/net`), and the plugins this build ships (`packages/`).

Six composition rows are swapped, each because the shipped one names something a
page cannot have — or, in the shell's case, cannot honestly describe.
`npx tsx scripts/alignment.ts` prints the whole difference.

## Install

Nothing to install — [open the page](https://dsh.zjzh.me/). To run it yourself:

```sh
npm ci
npm run build        # → dist/
node scripts/serve.mjs 4173
```

Node 22 or newer. `dist/` is plain static files with relative URLs, so it works
at a domain root, a project path, or a local directory.

## Usage

Open the page, choose a workspace, start talking.

- **Terminal** — `` Ctrl+` `` or the sidebar action. It is Node in this tab, and
  the same machine the agent's tools run in.
- **Python** — `python3` and `pip` are there for both of them. The first call
  fetches a 14 MB interpreter; after that it is stored, and packages installed
  with `pip` survive a reload. Write `python3`: `jsh` aliases `python` to it and
  loses the quoting on the way, so `python -c "…"` is a syntax error.
- **Plugins** — Settings → Plugins, or `/plugin add <package>` in the composer.
  Takes an npm name, a tarball URL, `owner/repo#ref`, or a path.
- **Models** — 42 models across six routes are registered up front and need no
  account, so the page answers before it asks for anything. Settings → Models
  offers the rest of the provider catalog; typing a key is the whole of
  configuring one.
- **Network** — Settings → Network picks the CORS proxy, used only after a
  direct request has actually failed, and reported to you when it is.
- **Persistence** — workspace, sessions and transcripts survive a reload.
  `window.dsh.exportFs()` downloads a zip; `window.dsh.reset()` clears it all.

Worth knowing: the container's shell is `jsh`, not bash, and it ships no `git`;
`python3` is CPython 3.14 compiled to WebAssembly, fetched on first use and kept
afterwards, so it has pip but no compiler, no subprocesses and no sockets; and a
host that refuses browsers is reachable only through the proxy, which does not
extend to the container.

## Maintainers

[@futrime](https://github.com/futrime)

## Contributing

Issues and PRs welcome at [futrime/webdsh](https://github.com/futrime/webdsh/issues).
Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/);
`npx tsc --noEmit` and `npx tsx scripts/e2e.ts` should pass first.

## License

[Apache-2.0](LICENSE) © [Zijian Zhang](https://github.com/futrime). The
`@deepseek-ai/*` packages it composes are published by DeepSeek AI under their
own terms.
