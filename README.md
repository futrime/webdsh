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
- 💾 **Or a whole PC.** Switch the runtime to [v86](https://github.com/copy/v86) and the session runs FreeDOS, Windows 1.01, Windows 3.1, Windows 98 or Linux — emulated x86, booted from a disk image, with the tool set that machine actually has.
- 🧩 **Real plugins.** Install from npm, a tarball, GitHub, or a path — from the browser.
- 📦 **Real dsh.** The published `@deepseek-ai/*` packages, unmodified: 114 of 129 rows compose exactly as `dsh web` composes them.
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
(`src/node`), the two runtimes a session can run on — WebContainers and an
emulated x86 PC (`src/runtime`) — an in-page virtual server for `/api` plus the
CORS policy every outbound request goes through (`src/net`), and the plugins
this build ships (`packages/`).

Six composition rows are swapped, each because the shipped one names something a
page cannot have — or, in the shell's case, cannot honestly describe. Four more
are reconfigured rather than replaced, including the one that decides whether
this deployment can open a path at all. `npx tsx scripts/alignment.ts` prints
the whole difference.

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

- **Files** — the sidebar action above the terminal. Browse the workspace,
  open a file, drop files in, and take things out: one file as itself, a
  directory or a tick-box selection as a zip. It is the same filesystem the
  agent and the terminal use, not a copy. A file path the assistant names in
  the chat opens here when you click it.
- **Terminal** — `` Ctrl+` `` or the sidebar action. It is Node in this tab, and
  the same machine the agent's tools run in. Closing it hides it; the session,
  its scrollback and its working directory are still there when you reopen.
- **Python** — `python3` and `pip` are there for both of them. The first call
  fetches a 14 MB interpreter; after that it is stored, and packages installed
  with `pip` survive a reload. Write `python3`: `jsh` aliases `python` to it and
  loses the quoting on the way, so `python -c "…"` is a syntax error.
- **Runtime** — the sidebar action below the terminal. A session runs on one
  machine and this is where you pick it. The default is the Node container
  above; the alternative is an emulated 32-bit PC, and the panel is that PC's
  screen — live, with a working keyboard, showing what the assistant is doing.
  Five machines need no setup at all: **Linux** (busybox on a serial console,
  the shortest way here to a real POSIX shell), **FreeDOS**, **MS-DOS 7**,
  **Windows 1.01** and **KolibriOS**. Eleven more boot exactly the same way but
  are not this deployment's to serve a disk for — **Windows 2.03**, **3.0**,
  **3.1**, **95**, **98**, **ME**, **NT 4.0** and **2000**, **MS-DOS 6.22**,
  **Buildroot Linux**, and **Arch Linux**, which is a 2022 kernel with bash,
  python3 and gcc and resumes from a saved machine in about two seconds. For
  those, open a disk image from your computer or point the panel at a host that
  has one. Nothing is downloaded until you choose a machine, and a change
  applies on the next load.
- **Plugins** — Settings → Plugins, or `/plugin add <package>` in the composer.
  Takes an npm name, a tarball URL, `owner/repo#ref`, or a path. The *Installed*
  tab turns one off or removes it; the composition is fixed at boot, so a change
  applies on the next reload and the panel says so.
- **Models** — 42 models across six routes are registered up front and need no
  account, so the page answers before it asks for anything. Settings → Models
  offers the rest of the provider catalog; typing a key is the whole of
  configuring one.
- **Network** — Settings → Network picks the CORS proxy, used only after a
  direct request has actually failed, and reported to you when it is.
- **Persistence** — workspace, sessions and transcripts survive a reload.
  `window.dsh.exportFs()` downloads a zip; `window.dsh.reset()` clears it all.

On an emulated machine the assistant is given different tools, because it is a
different machine: `sh` on the Linux guest, `dos` on the DOS ones — both reading
a real character stream, so a command's whole output comes back rather than the
last 25 lines of it — and `vm_screenshot`, `vm_screen`, `vm_key`, `vm_type`,
`vm_mouse` and `vm_wait` everywhere, which is the whole of the tool set on a
guest that only draws pixels. There is no `jsh`, no Node and no Python in that
session, and the guest's disk shares nothing with the workspace your file tools
read. The panel and the tools say so.

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
