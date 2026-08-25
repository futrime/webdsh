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
- 💾 **Or a whole PC.** Settings → Machine swaps the container for [v86](https://github.com/copy/v86) and offers **128 machines** — the whole of v86's catalog, from a 512-byte bootsector game to Windows 2000, **87 of them booting with nothing to set up** — emulated x86, on its own screen, with the tool set that machine actually has.
- 🌐 **The PC is online.** The page is its router: it answers the guest's DHCP, DNS and pings and carries its HTTP as browser `fetch`, through the same CORS policy the rest of the app uses — so `wget http://example.com` works on an emulated Buildroot, which is a host the container itself cannot reach.
- 👁️ **It can see.** Attach an image and the model reads it: oriented, capped and re-encoded to the route's budget by the browser's own decoder, with the source's EXIF and colour profile stripped on the way.
- 🧩 **Real plugins.** Install from npm, a tarball, GitHub, or a path — from the browser.
- 📦 **Real dsh.** The published `@deepseek-ai/*` packages, unmodified: 120 of 135 rows compose exactly as `dsh web` composes them.
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
emulated x86 PC (`src/runtime`) — an in-page virtual server for `/api`, the
CORS policy every outbound request goes through and the network the emulated
machine is given (`src/net`), and the plugins this build ships (`packages/`).

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

Open the page, choose a workspace, start talking. 42 models across six routes
are registered up front, so it answers before it asks you for anything.

Three things live in the sidebar:

- **Files** — the workspace, as the agent and the terminal see it. Drop files
  in; take a file, a directory or a tick-box selection back out. Click a path
  the assistant mentions to open it here.
- **Machine** — `` Ctrl+` ``. What this session runs on: a terminal for the Node
  container, the live screen for an emulated PC. Click the screen and the
  machine gets your keyboard and mouse; Escape gives them back.
- **Settings** — which machine, which models, which CORS proxy, which plugins.

Both panels dock beside the conversation on a wide window and along the bottom
on a narrow one, and take width from it rather than covering it.

**Machines.** Settings → Machine offers **128** — the whole of [v86's
catalog](https://copy.sh/v86/) — and **87 boot with nothing to set up**. The
choice applies on the next load, because it decides which tools the assistant
gets: `jsh`, Node and Python in the container; `sh` or `dos` plus
`vm_screenshot`, `vm_key`, `vm_type`, `vm_mouse` and friends on a guest, whose
disk shares nothing with your workspace. A guest is offered the tools that
currently work on it and not the ones that would come back empty — no
`vm_screen` on a desktop with no text, no `vm_mouse` at a prompt that never
turned a mouse on. The other 41 want a disk image —
open one from your computer and it stays in your browser, or point the setting
at a host that serves them. `npm run v86:catalog` prints the difference against
upstream; `npm run v86:boot -- --bundled --as-shipped` re-boots all 87. The
disks come from v86's own `copy/images` and the hosts
`src/runtime/v86-mirror.json` names, mostly
[AndyZijianZhang/webdsh-images](https://huggingface.co/datasets/AndyZijianZhang/webdsh-images),
whose `NOTICE.json` records where every image came from and under what licence.

**The machine's network.** An emulated PC gets an ethernet card and this page on
the other end of it: it answers the guest's ARP, DHCP, DNS and pings itself, and
turns the HTTP requests inside the guest's TCP into `fetch` calls — which go
through the CORS policy above, direct first and proxied only when a host refuses
a browser. So an emulated Buildroot can `wget http://example.com`, a host that
sends no CORS headers at all and that the container cannot reach either, and a
guest running a web browser can open an `http://` address. Ports other than 80
work too, which stock v86 resets. What a tab cannot carry is TLS: `https://`
*from inside the guest* would have to terminate here, so those connections are
refused rather than left hanging, and plain `http://` is sent as HTTPS on the
wire wherever the host wants it. Settings → Network can name a WISP or
websockproxy relay for a session that needs real TCP — package managers, `ssh` —
and says plainly what routing every byte through a third party costs. Whether a
particular guest has a driver for the card is a fact about its disk: it is
measured per machine, and the machines that were measured say so in their own
description.

**Plugins.** `/plugin add <package>` in the composer, or Settings → Plugins.
Takes an npm name, a tarball URL, `owner/repo#ref`, or a path. The composition
is fixed at boot, so a change applies on the next reload.

**Persistence.** Workspace, sessions and transcripts survive a reload.
`window.dsh.exportFs()` downloads a zip; `window.dsh.reset()` clears it all.

Worth knowing: the container's shell is `jsh`, not bash, and ships no `git`;
`python3` is CPython 3.14 compiled to WebAssembly, fetched on first use, so it
has pip but no compiler, no subprocesses and no sockets — and write `python3`,
because `jsh` aliases `python` and loses the quoting on the way.

## Maintainers

[@futrime](https://github.com/futrime)

## Contributing

Issues and PRs welcome at [futrime/webdsh](https://github.com/futrime/webdsh/issues).
Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/);
`npx tsc --noEmit` and `npm test` should pass first; `npm run test:vision`,
`npm run test:v86` and `npm run test:workload` cover the image pipeline, the
emulated machines and the agent finishing real jobs on each of them.

## License

[Apache-2.0](LICENSE) © [Zijian Zhang](https://github.com/futrime). The
`@deepseek-ai/*` packages it composes are published by DeepSeek AI under their
own terms, and the disk images it fetches remain under their own authors'.
