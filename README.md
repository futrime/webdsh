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
- 🌍 **The container is online too.** The page's CORS policy is preloaded into every Node process it starts, so `fetch` inside the container retries a refused host through the proxy on its own — `http://example.com` answers there now, and it did not before.
- 🖥️ **Real Node, real Python.** `npm install` and `pip install` both work, and the terminal and the agent share one container.
- 💾 **Or a whole PC.** Settings → Machine swaps the container for [v86](https://github.com/copy/v86) and offers **128 machines** — the whole of v86's catalog, from a 512-byte bootsector game to Windows 2000, **127 of them booting with nothing to set up** — emulated x86, on its own screen, with the tool set that machine actually has.
- 🧭 **Or a browser.** The third machine is real tabs of the real web, and the assistant drives them three ways: the page structure (a labelled tree with a handle on everything clickable), the pixels, or JavaScript in the page itself. Multi-tab, with its own cookies and per-site storage that persist — and each tab is sandboxed into an opaque origin, so a page cannot reach this harness, its storage, or your keys. That is the browser's own rule, not a promise this build makes: every escape route comes back `SecurityError`, and `npm run test:browser` checks it.
- 🤖 **And it can be programmed.** One action per turn is the wrong shape for a table with twenty rows in it, so the browser machine also takes *programs*: `browser_task` runs `getByRole('button', {name: 'Save'}).click()`, retrying `expect`, frames, popups, dialogs, downloads and uploads in a named task space that keeps its pages, its variables and its login state between calls — with receipts, so a run that was interrupted halfway through a form can be asked what happened instead of repeated. The model's own code runs in an opaque origin of its own, holding nothing of this page: the same boundary that keeps a browsed site out keeps the script the model wrote out too.
- 🌐 **The PC is online.** A WISP relay by default, so the guest gets real TCP — `https://`, package managers, `ssh` — and without one the page itself is the router: it answers the guest's DHCP, DNS and pings and carries HTTP as browser `fetch`, through the same CORS policy the rest of the app uses. `wget http://example.com` works on an emulated Buildroot either way; the same URL from the container answers `fetch failed`.
- 👁️ **It can see.** Attach an image and the model reads it: oriented, capped and re-encoded to the route's budget by the browser's own decoder, with the source's EXIF and colour profile stripped on the way. A model you add yourself is asked what it accepts, so a vision model on your own gateway arrives with its eyes open rather than registered as text-only.
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
(`src/node`), the runtimes a session can run on — WebContainers and an
emulated x86 PC (`src/runtime`), and a browser built out of sandboxed frames
(`src/browser`) — an in-page virtual server for `/api`, the CORS policy every
outbound request goes through and the network the emulated machine is given
(`src/net`), and the plugins this build ships (`packages/`).

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
  container, the live screen for an emulated PC, the tab strip and address bar
  for the browser. Click the screen and the machine gets your keyboard and
  mouse; Escape gives them back. The browser's tabs are the same tabs the
  assistant is driving, not a second copy of them — what it clicks, you watch.
- **Settings** — which machine, which models, which CORS proxy, which plugins.

Both panels dock beside the conversation on a wide window and along the bottom
on a narrow one, and take width from it rather than covering it.

**Machines.** Settings → Machine offers three kinds: the Node container, a
**browser**, and **128** emulated PCs — the whole of [v86's
catalog](https://copy.sh/v86/), **127 of which boot with nothing to set up**.
The choice applies on the next load, because it decides which tools the
assistant gets: `jsh`, Node and Python in the container; `browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_screenshot`, `browser_eval` and
the rest on the browser; `sh` or `dos` plus `vm_screenshot`, `vm_key`,
`vm_type`, `vm_mouse` and friends on a guest, whose disk shares nothing with
your workspace. A guest is offered the tools that
currently work on it and not the ones that would come back empty — no
`vm_screen` on a desktop with no text, no `vm_mouse` at a prompt that never
turned a mouse on. The one that is left, Arch, wants a host for its 9p tree —
open one from your computer and it stays in your browser, or point the setting
at a host that serves them. `npm run v86:catalog` prints the difference against
upstream; `npm run v86:boot -- --bundled --as-shipped` re-boots all 127. The
disks come from v86's own `copy/images` and the hosts
`src/runtime/v86-mirror.json` names, mostly
[AndyZijianZhang/webdsh-images](https://huggingface.co/datasets/AndyZijianZhang/webdsh-images),
whose `NOTICE.json` records where every image came from and under what licence.

What the catalog cannot hold is an operating system v86 cannot execute.
OpenHarmony is the one people ask for: every target it has is ARM, RISC-V,
Xtensa, C-SKY or x86-**64**, and v86 is 32-bit only, so there is no image to
offer and no row for it. [`docs/openharmony-on-v86.md`](docs/openharmony-on-v86.md)
has the evidence, and `npm run openharmony:check` re-reads it from upstream so
the answer cannot go stale unnoticed.

**The browser machine.** Tabs, in a frame this page cannot be reached from.
Each one is sandboxed *without* `allow-same-origin`, which gives it an opaque
origin — so the browser itself refuses it this page's DOM, its `localStorage`,
its IndexedDB and the keys in them. That choice costs everything else: an
opaque-origin document is not controlled by a service worker, cannot fetch
anything cross-origin, and gets `SecurityError` from `localStorage`,
`sessionStorage`, `document.cookie` and `indexedDB` alike. All of it was
measured before any of it was written.

So the page is the browser's network and storage process, and the frame is only
its renderer. The page fetches through the same CORS policy everything else here
uses, rewrites the document to be self-contained, and hands cookies and per-site
storage across a message channel into shims. Three measurements shaped it: a
service worker never controls an opaque origin, so the usual same-origin-proxy
trick was out; `data:` URLs do not taint a canvas and `blob:` URLs do, so every
subresource is inlined as `data:` or `browser_screenshot` breaks on any page
with an image on it; and `window.location` is the one global `defineProperty`
refuses, which is why script text is parsed with acorn and the expressions
naming `location`, `top` and `parent` are rewritten to read a virtual one — a
site that routes on its own URL works, and the frame-buster every large site
ships quietly does nothing.

Two limits, stated plainly here and in the tool descriptions the model reads.
**No cookie travels on a request** — `Cookie` is a header a browser forbids a
page to set, and `set-cookie` is not exposed cross-origin — so cookies work
*inside* a page and persist between visits, and nothing behind a login is
reachable. **Most hosts need the CORS proxy**, because most of the web does not
permit cross-origin reads; without one, only hosts that send
`access-control-allow-origin` can be browsed. `npm run test:browser` drives all
of it against a local fixture site, including the isolation.

**Screenshots.** A model driving a machine it can see photographs it to look at
it, and both screen tools — `vm_screenshot` on an emulated PC, `browser_screenshot`
on a tab — hand the picture straight back the way `read_image` hands back a file:
one call, nothing to open. The picture is not also written into the workspace.
Watching a boot is a screenshot every few seconds and checking a page is another
one every edit, and the Files panel filling up with them is not what anyone asked
for. What still writes a file is the assistant naming a path for a view worth
keeping, a model that cannot be shown a picture at all (there the file is the
whole answer), and Settings → Machine → Screenshots, which keeps every one of
them for anybody who wants the record.

**Models you add.** Settings → Models takes any OpenAI-compatible route: a base
URL, a key, and *Fetch models*. What that listing says about modalities is read
along with the rest of it, so a model the endpoint describes as accepting images
is registered accepting images — GLM-5.3-Flash on a gateway is the case this was
measured against. Nothing is guessed: a listing that describes no modalities
leaves its models where the route's default puts them, which is text, and an
entry you have declared yourself is never rewritten. If your route says nothing
and its model does take pictures, `input: [text, image]` on that model's entry in
the settings document is the whole of what this fills in for you. The roster the
page ships is described the same way, from each service's own catalog — except
OVHcloud, which publishes no modalities at all, so its vision model was asked a
question about a picture instead and answered it. (That route then refuses the
tool definitions every agent turn carries, which is its own wall and the
provider's to move; what changed here is that the page no longer refuses to send
a picture it could have sent.)

**The machine's network.** An emulated PC gets an ethernet card and this page on
the other end of it: it answers the guest's ARP, DHCP, DNS and pings itself, and
turns the HTTP requests inside the guest's TCP into `fetch` calls — which go
through the CORS policy above, direct first and proxied only when a host refuses
a browser. So an emulated Buildroot can `wget http://example.com`; the same URL
from the container answers `fetch failed`, because its requests leave from
StackBlitz's worker where this page never sees them and no automatic retry is
possible. Ports other than 80 work too, which stock v86 resets.

What a tab cannot carry is TLS: `https://` *from inside the guest* would have to
terminate here, so those connections are refused rather than left hanging, and
served over HTTPS this page sends plain `http://` as HTTPS on the wire wherever
the host wants that. It is outbound HTTP and nothing else — no inbound route to
a server running in the guest, no UDP beyond the DHCP and DNS the page fakes,
and no cookies or CORS-hidden response headers, so anything that needs a login
will not work. `ping` and DNS are answered by the page, not by the host named.
The guest is refused this page's own origin, because the fetch is made by the
tab and a same-origin request needs no CORS at all — it would be a line into the
harness's own `/api`. Your computer's network is not blocked: `localhost`, the
LAN and v86's `<port>.external` names all work.

That is the floor. **A WISP relay is configured by default**, and with one the
guest has real TCP instead of HTTP-shaped TCP: `https://` works end to end,
package managers and `ssh` become possible, and DNS is real. The cost is that a
third party carries every byte the machine sends, including inside a TLS session
it is only forwarding — Settings → Network says so plainly, one click clears it,
and clearing it leaves the in-page bridge working. A relay that does not answer
when a machine starts is dropped for that bridge rather than left as a network
that silently does nothing. Whether a particular guest has a driver for the card is a fact about its
disk: it is measured per machine — three of them so far — and a machine nobody
has measured is described as exactly that rather than promised a network.

**The container's network.** A WebContainer's requests leave from StackBlitz's
own worker, where neither the page's patched `fetch` nor `public/sw.js` can see
them — so the CORS retry that the rest of the app applies could never reach it,
and the shell tool's advice was to prefix a proxy by hand. It is carried in
instead: `src/container/net-shim.ts` is written beside the shell at boot and
preloaded into every Node process through `NODE_OPTIONS`, so a refused request
is retried once through the configured proxy, automatically, wherever it came
from. Measured: `fetch('http://example.com')` answers `fetch failed` without it
and returns the page with it.

With a relay configured, `globalThis.dshConnect(host, port)` gives the container
a real TCP socket as well — the emulated machine's relay, serving both runtimes
from one setting. It is offered rather than installed over `net.connect`,
because Node's own `fetch` is built on that function and taking it over hangs
every request in the process. TLS on top of that socket does not work here:
this runtime's `tls` reaches for internals a plain stream does not have, so
`https` stays `fetch`'s job.

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
emulated machines and the agent finishing real jobs on each of them, and
`npm run test:machine-network` exercises the guest HTTP bridge's parser and its
refusals without booting anything.

## License

[Apache-2.0](LICENSE) © [Zijian Zhang](https://github.com/futrime). The
`@deepseek-ai/*` packages it composes are published by DeepSeek AI under their
own terms, and the disk images it fetches remain under their own authors'.
