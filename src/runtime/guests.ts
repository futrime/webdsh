/**
 * The machines v86 can be, and what each one is like to work in.
 *
 * This is data, not behaviour, and it is deliberately its own module: the
 * setting in `packages/dsh-web-machine` needs it to draw a list, the tool row
 * needs it to decide which tools the model is offered, and the boot needs it
 * before anything heavy has been fetched. All three read this table, and none
 * of them pulls in the emulator to do it.
 *
 * Every timing and every readiness marker in {@link MEASURED} was measured
 * against a cold boot in a real browser rather than reasoned about. `npm run
 * test:v86` boots the bundled ones and fails if one stops reaching its own
 * marker; the rest were each driven by hand once and are regression-tested
 * only where the suite can get an image — Windows 3.1 and Windows 98. The
 * machines carried in from `v86-catalog.json` are upstream's own configuration
 * and were never measured at all, which is worth knowing before trusting a
 * timing on one.
 *
 * ## Where the disks come from, and why that is a question
 *
 * Nothing here ships an operating system. v86's own demo serves its images
 * from `i.copy.sh`, and that host refuses any request whose `Referer` is not
 * `copy.sh` — measured, not assumed: the same byte range answers `206` from
 * curl and `403` from a browser on another origin. That is hotlink protection,
 * it is deliberate, and it is copy.sh's bandwidth to protect. This build does
 * not work around it.
 *
 * So a guest gets its disk one of four ways, in this order:
 *
 * 1. **A file from your computer** — v86 reads a disk image `File` in slices,
 *    so a 300 MB Windows 98 disk opened this way costs no download at all and
 *    works offline. For the proprietary guests this is the lawful path anyway,
 *    and it is the one `scripts/v86-e2e.ts` exercises for Windows 3.1.
 * 2. **A host you name** — one setting, for a deployment that mirrors the
 *    wider image set, or for a browser that is on `copy.sh` already.
 * 3. **This deployment itself**, when `public/v86/images/` has the file. No
 *    third party, no CORS question, and it still boots with the network off.
 * 4. **The default image host** — `copy/images` on GitHub, which is public,
 *    answers `access-control-allow-origin: *`, serves ranges, and has no
 *    referrer policy — supplemented by `v86-mirror.json`, which is where the
 *    other eighty-two files come from. Together those are what
 *    {@link GuestSpec.bundled} means: a machine that needs no setup.
 *
 * A hundred and twenty-seven of the hundred and twenty-eight machines are
 * reachable that way. That number used to be eighty-seven, and what changed is
 * that the pieces are no longer an obstacle: `scripts/v86-fetch-images.ts`
 * reassembles a disk that upstream publishes only as `<offset>-<end>.img`
 * fragments — decompressing the ones whose fragments are individually zstd'd,
 * and filling in the ones a sparse image simply omits — so the mirror can hold
 * one file and the emulator can read it by range, which is the same laziness
 * one request shape apart. Which operating systems a deployment redistributes
 * is its own decision with its own obligations; this one's owner made it
 * deliberately, and `NOTICE.json` records where every file came from.
 *
 * The one that is left is Arch, and it is neither a licence question nor a
 * bandwidth one. Its root is not a disk: it is a 9p directory the guest reads
 * one file at a time over HTTP, and `fs.json` says what mirroring it would cost
 * — 88,217 files in 9,789 directories, 6.13 GB. That is ninety thousand objects
 * to store and ninety thousand requests to make of somebody else's server,
 * which is not a shape either host is for. So Arch asks for a host, and says so
 * before it starts rather than failing mid-boot.
 */

import CATALOG from './v86-catalog.json'
import MIRROR from './v86-mirror.json'

/**
 * Where a disk is fetched from when nothing else supplies it.
 *
 * `copy/images` is the v86 project's own repository of small test images, and
 * jsDelivr is a CDN whose entire purpose is serving public repository content
 * — so this is neither a private host's bandwidth nor a scrape. Pinned to a
 * branch rather than a commit because the repository's own Readme says it is
 * not updated, and a moving reference that never moves is the honest spelling.
 */
export const DEFAULT_IMAGE_HOST = 'https://cdn.jsdelivr.net/gh/copy/images@master/'

/**
 * The host v86's demo uses, recorded so the setting has something to paste.
 *
 * It answers from `copy.sh` and refuses everywhere else. It is listed in the
 * panel as what to set this to *if you are running this from copy.sh*, and for
 * no other reason.
 */
export const UPSTREAM_IMAGE_HOST = 'https://i.copy.sh/'

/**
 * The deployment's own image directory.
 *
 * v86 does the same thing and for the same reason: run its demo from a
 * checkout and it reads `images/` beside the page instead of its CDN. A
 * deployment that drops disk images into `public/v86/images/` therefore serves
 * every machine it has bytes for from its own origin — no third party, no CORS
 * question, no COEP question, and it keeps working with the network off.
 *
 * Relative, so it resolves against wherever the app is served from: a domain
 * root, a project path, or a local directory.
 */
export const DEPLOYMENT_IMAGE_HOST = 'v86/images/'

/** Where the setting is kept. */
const HOST_KEY = 'dsh-web:v86-image-host'

/** The image host this deployment is currently pointed at. */
export function imageHost(): string {
  try {
    const stored = localStorage.getItem(HOST_KEY)
    if (stored !== null && stored !== '') return stored.endsWith('/') ? stored : `${stored}/`
  } catch {
    // Storage denied; the default is still correct.
  }
  return DEFAULT_IMAGE_HOST
}

/** Whether the user has named a host, as opposed to taking whatever the build offers. */
export function imageHostIsChosen(): boolean {
  try {
    const stored = localStorage.getItem(HOST_KEY)
    return stored !== null && stored !== ''
  } catch {
    return false
  }
}

/**
 * Whether this deployment is serving a file itself.
 *
 * One range request for the first hundred bytes, which a static host answers
 * from cache and a host without the file answers 404. Asked once per boot,
 * before anything large is fetched, so a deployment that carries its own images
 * uses them and one that does not is no slower for having been asked.
 * @param file - the file name, as the catalog spells it.
 * @returns whether the deployment answered for it.
 */
export async function deploymentServes(file: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const url = new URL(`${DEPLOYMENT_IMAGE_HOST}${file}`, document.baseURI).href
  try {
    const answer = await fetch(url, { headers: { range: 'bytes=0-99' } })
    // A static host that has the file answers 200 or 206; one that does not
    // answers 404 — or, on a single-page host, 200 with the index page, which
    // is why the type is checked rather than only the status.
    if (!answer.ok) return false
    const type = answer.headers.get('content-type') ?? ''
    return !type.startsWith('text/html')
  } catch {
    return false
  }
}

/**
 * Point this deployment at a different image host.
 * @param url - the base URL, or an empty string to go back to the default.
 */
export function setImageHost(url: string): void {
  const trimmed = url.trim()
  if (trimmed === '') localStorage.removeItem(HOST_KEY)
  else localStorage.setItem(HOST_KEY, trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
}

/**
 * Where the BIOS comes from.
 *
 * Vendored into `public/v86/` rather than taken from an image host, which does
 * not serve it. 167 KB, identical for every guest, and requested only when a
 * machine boots — so carrying it costs the deployment nothing at page load.
 */
export const BIOS_BASE = 'v86/'

/**
 * How a guest is driven, which is what decides the tools the model is offered.
 *
 * The distinction is not "old versus new". It is whether there is a *character
 * stream* to read a command's output from.
 *
 * - `serial` — the guest talks on the serial port and there is a POSIX shell
 *   behind it. Output is complete and arbitrarily long, and `$?` is real.
 * - `dos` — the guest boots to a DOS prompt on the VGA text screen. Where
 *   `CTTY COM1` works it is used, and the console becomes a stream as complete
 *   as a serial guest's; where it does not, the guest is typed at and read off
 *   its screen, which is exact for short output and can lose lines in a long
 *   burst. Which is which is {@link GuestSpec.serialConsole}, and it is
 *   measured per guest rather than probed, because probing it on a guest that
 *   refuses costs that guest its console until it reboots.
 * - `gui` — the guest draws pixels. There is no text to read, so the model
 *   works the way a person does: look at the screen, type, click.
 */
export type GuestConsole = 'serial' | 'dos' | 'gui'

/** Which v86 option one image file fills. */
export type ImageSlot =
  | 'fda' | 'fdb'
  | 'hda' | 'hdb'
  | 'cdrom'
  | 'bzimage' | 'initrd' | 'multiboot'
  | 'initial_state'

/** One file a guest needs. */
export interface GuestImage {
  /** The v86 option it becomes. */
  slot: ImageSlot
  /** File name, relative to the image host. */
  file: string
  /** Exact byte length, which a streamed disk cannot be read without. */
  size?: number
  /** Read in pieces as the guest touches them, rather than fetched whole. */
  streamed?: boolean
  /**
   * Where this file comes from, when it does not come from the image host.
   *
   * The image host is one place, and most of these machines are not there. A
   * hobby OS whose floppy sits in its own public repository, a project that
   * publishes its own ISO from a bucket that allows browsers — those are
   * reachable today, with nothing to mirror and nobody's permission to ask, and
   * a catalog that could only name files under one host could not say so.
   *
   * An absolute URL, and it must be one a *browser* can read: HTTPS, CORS
   * allowed on the final response after redirects, and HTTP Range supported,
   * because the emulator reads a disk in pieces. `scripts/v86-catalog.ts`
   * checks all three.
   */
  source?: string

  /**
   * Somewhere this file can be had, for when nothing better is set.
   *
   * Not the same thing as {@link GuestImage.source}. A `source` is upstream's
   * own statement of where the file lives, so no image-host setting may move
   * it; a `mirror` is only what to try when the deployment has not been told
   * anything — a host the user named, or a copy this deployment serves itself,
   * both come first. It exists because the default host has five files and the
   * catalog has a hundred and twenty-eight machines.
   *
   * Two kinds of URL end up here, and the difference matters for what this
   * project is responsible for. Most are `AndyZijianZhang/webdsh-images` on
   * Hugging Face, which *is* this project redistributing an image, and so holds
   * only images whose licences allow it. The rest are links to a public
   * repository that already holds the file — no copy made here, the same
   * posture as the default host, which is likewise somebody else's repository
   * and likewise has proprietary disks on it.
   */
  mirror?: string

  /**
   * The size of one piece of a streamed image, in bytes.
   *
   * Load-bearing, and not a tuning knob: the emulator derives each piece's URL
   * from this number — `disk/0-1048576.img`, `disk/1048576-2097152.img` — so a
   * value that disagrees with how the image was actually split asks for files
   * that do not exist, and the machine dies on a 404 with a correct host and a
   * correct disk. v86's own catalog uses three different sizes: a megabyte for
   * most, 256 KiB for the DOS-era disks, half a megabyte for the AROS ISOs.
   * Copied per image from there rather than assumed.
   */
  chunkBytes?: number
}

/** What a streamed image is cut into when its catalog entry does not say. */
const DEFAULT_CHUNK_BYTES = 256 * 1024

/** One bootable machine. */
export interface GuestSpec {
  /** Stable id; what the selection stores and the URL parameter names. */
  id: string
  /** What it is called, as the picker shows it. */
  name: string
  /** How the model talks to it. */
  console: GuestConsole
  /** One line under the name in the picker. */
  summary: string
  /** What is installed on it, for the model's orientation. */
  contains: string
  /**
   * Whether the default image host serves everything this guest needs.
   *
   * A guest that is not bundled is not unsupported — it boots exactly the same
   * way — but it needs a disk from somewhere, and the picker says so rather
   * than offering a button that can only fail.
   */
  bundled: boolean
  /** Bytes fetched before the machine is usable, over the network. */
  transfer: number
  /** The files it boots from. */
  images: GuestImage[]
  /**
   * A 9p filesystem tree on the image host, when the guest's root is one.
   *
   * Arch is not a disk image: its root is a directory of files the guest asks
   * for one at a time over 9p, and the saved machine it resumes from expects
   * that device to be there. Named here rather than written into
   * {@link GuestSpec.options} because the host it lives under is a setting, and
   * a baked-in URL would ignore it.
   */
  filesystem?: string
  /** Everything else v86 is constructed with. */
  options: Record<string, unknown>
  /** How long a cold boot may take before it is called stuck. */
  timeoutMs: number
  /** Text-screen lines that mean a DOS guest has reached its prompt. */
  prompts?: string[]
  /**
   * Whether `CTTY COM1` moves this DOS guest's console and it answers there.
   *
   * Per guest and measured, never probed. FreeDOS accepts the redirect and
   * talks on the serial port, which gives a clean character stream and output
   * of any length. Both MS-DOS guests accept it and then answer on neither the
   * screen nor the wire — the console is gone, the keyboard is ignored, and
   * the machine is unreachable until it reboots. There is no way to find that
   * out without doing it, so it is written down instead.
   *
   * Where this is false the guest is typed at and read off its screen, which
   * works but cannot promise output longer than the screen: rows are recorded
   * as they scroll past, and a burst faster than the sampler outruns it.
   */
  serialConsole?: boolean
  /**
   * What this machine's screen ends up being, once it has finished booting.
   *
   * Not the same question as {@link GuestSpec.console}, which is about how a
   * model drives it. This is about how to tell that it has arrived: a machine
   * that ends in a graphical mode passes through a settled text screen on the
   * way — a BIOS message, a boot menu — and calling that "up" reports Windows
   * 3.1 as ready while it is still in DOS. A machine that ends in text mode has
   * no such transition, and waiting for pixels that never come is the same
   * mistake in the other direction.
   *
   * v86's own catalog marks each machine graphical or text and that is where
   * this comes from; absent, it follows {@link GuestSpec.console}.
   */
  screen?: 'graphical' | 'text'

  /**
   * Whether the guest's own pointer must be left switched off at boot.
   *
   * v86's demo calls `mouse_set_enabled(false)` for the two machines whose
   * guest driver mishandles a pointer it never asked for. It is not a
   * constructor option, so it cannot ride in {@link GuestSpec.options} — it is
   * a call made once the machine is up.
   */
  mouseDisabled?: boolean

  /** What a serial guest prints when its console is ready, as a regular expression. */
  banner?: string
  /** A login the serial console asks for before it gives a shell. */
  login?: { ask: string, send: string }
  /**
   * How long a cold start takes, for the setting and the model to quote.
   *
   * Optional, and absent rather than estimated. Every value below was measured
   * against this build in a real browser; a machine carried in from v86's
   * catalog has not been, and a number invented for it would be indistinguishable
   * from one that was. The setting shows nothing where there is nothing to show.
   *
   * Measured, every one of them, in a headless browser against this build: the
   * time from the page load that selects the guest to the moment
   * {@link GuestSpec.banner}, {@link GuestSpec.prompts} or a settled graphical
   * mode is reached, with the image already in the browser's cache — so this
   * is what the machine spends, and {@link GuestSpec.transfer} is what the
   * network spends. For a guest that boots from cold into Windows the settled
   * graphical mode is a splash screen rather than a desktop, and the ones that
   * differ say both numbers rather than the flattering one.
   */
  boots?: string
  /**
   * What this machine's network turns out to be, once it has one.
   *
   * Every machine here is constructed with an ethernet card and the page
   * answers for it — see `src/net/machine-network.ts` — but a card is only
   * half of it: the other half is a driver in the guest, and whether one is
   * there is a fact about a disk image nobody can read off a catalog. So it is
   * measured, per machine, and absent where nobody has looked.
   */
  network?: GuestNetwork
}

/** What is known about one guest's networking. */
export interface GuestNetwork {
  /**
   * How the interface comes up.
   *
   * - `dhcp` — a client has to be run, and {@link GuestNetwork.up} is the
   *   command; the console runs it once, when it first attaches, so a model
   *   that reaches for `wget` finds a working machine rather than a card
   *   nobody switched on.
   * - `auto` — the guest brings its own up, which is what every Windows here
   *   does with a DHCP server on the wire.
   * - `link` — it puts frames on the wire and never asks for an address. A
   *   driver is bound; a static configuration inside the guest is what it
   *   wants.
   * - `none` — measured, and the answer was no: the card is in the machine and
   *   the guest has no driver that finds it, so `/sys/class/net` holds nothing
   *   but `lo` and no amount of configuration will change it.
   *
   * Absent means nobody has looked, which is most of the catalog — see
   * {@link CATALOG_NETWORK} for why silence is not recorded as `none`.
   */
  bring: 'dhcp' | 'auto' | 'link' | 'none'
  /** For `dhcp`, the command that asks for a lease. */
  up?: string
  /** What the network is like on this guest, in the model's terms. */
  note?: string
}

/** One megabyte, spelled out. */
const MB = 1024 * 1024

/**
 * The prompts a DOS session sits at.
 *
 * Matched against the start of a screen line rather than anywhere in it, so
 * `C:\>` recognises the prompt and not a path inside a line of output. Three
 * drive letters, because one tool drives every DOS guest here: a floppy boots
 * to `A:\>`, a disk to `C:\>`, and the MS-DOS 7 floppy builds a RAM disk that
 * a session can be left sitting on at `D:\>`.
 */
const DOS_PROMPTS = ['A:\\>', 'C:\\>', 'D:\\>']

/**
 * Every machine this deployment offers.
 *
 * The five that need no setup come first, then the rest oldest to newest. The
 * setting draws them in this order and does not sort.
 *
 * Everything else v86 offers is carried in below from its own catalog. What
 * makes the machines here different is not that they are better: it is that
 * each one has been driven, so its console kind, readiness marker and boot time
 * are measurements rather than inferences. A machine that graduates from the
 * catalog to this table is one somebody has actually worked on.
 */
const MEASURED: GuestSpec[] = [
  {
    id: 'linux',
    name: 'Linux',
    console: 'serial',
    summary: 'Buildroot Linux on a 5.7 MB CD — the shortest way here to a real POSIX shell.',
    contains: 'busybox — ash, grep, sed, awk, find, tar, vi, wc, sort — and nothing else. No package manager '
      + 'and no compiler. It is also the one machine here with no network: this kernel has no driver for the '
      + 'emulated card, measured — `/sys/class/net` holds nothing but `lo`, with either card v86 offers — so '
      + '`wget` and `ping` reach nothing. Buildroot Linux 5.6, further down this list, is the same shell with '
      + 'a network that works.',
    bundled: true,
    transfer: 5_666_816,
    images: [{ slot: 'cdrom', file: 'linux.iso', size: 5_666_816 }],
    // An empty 9p device, as v86's own profile for this image configures one.
    // The guest cannot use it — this kernel is 2.6.34 and `/proc/filesystems`
    // has no `9p` entry, measured — so the page's `create_file` writes into a
    // tree nothing mounts. The device is kept because upstream keeps it and
    // removing it changes the hardware a working image booted on; no tool
    // offers it, which is the part that would have been a lie.
    options: { memory_size: 128 * MB, filesystem: {} },
    timeoutMs: 90_000,
    // Measured, with both cards: the guest enumerates neither, so there is
    // nothing to bring up and nothing to promise.
    network: { bring: 'none' },
    banner: '(?:login:|/root% )',
    login: { ask: 'login: ', send: 'root\n' },
    boots: 'about 9 seconds',
  },
  {
    id: 'freedos',
    name: 'FreeDOS',
    console: 'dos',
    summary: 'A 720 KB floppy that reaches a prompt in about a second — the fastest machine here by far.',
    contains: 'FreeCOM 0.82, nasm, vim, debug.com, and a few games and demos.',
    bundled: true,
    transfer: 737_280,
    images: [{ slot: 'fda', file: 'freedos722.img', size: 737_280 }],
    options: { memory_size: 32 * MB },
    timeoutMs: 60_000,
    prompts: DOS_PROMPTS,
    serialConsole: true,
    boots: 'about 2 seconds',
  },
  {
    id: 'msdos',
    name: 'MS-DOS 7',
    console: 'dos',
    summary: 'A loaded DOS boot floppy: a boot menu, then a long parade of drivers.',
    contains: 'DOSKEY, a CD-ROM driver, a mouse driver, a RAM disk, and the DOS utilities.',
    bundled: true,
    transfer: 1_474_560,
    images: [{ slot: 'fda', file: 'msdos.img', size: 1_474_560 }],
    options: { memory_size: 32 * MB },
    timeoutMs: 120_000,
    prompts: DOS_PROMPTS,
    boots: 'about 40 seconds',
  },
  {
    id: 'windows1',
    name: 'Windows 1.01',
    console: 'gui',
    summary: 'The first release of Windows, from 1985, on one floppy.',
    contains: 'MS-DOS Executive, Paint, Write, Notepad, Calculator, Clock, Reversi, Terminal.',
    bundled: true,
    transfer: 1_474_560,
    images: [{ slot: 'fda', file: 'windows101.img', size: 1_474_560 }],
    options: { memory_size: 32 * MB },
    timeoutMs: 90_000,
    boots: 'about 4 seconds',
  },
  {
    id: 'kolibrios',
    name: 'KolibriOS',
    console: 'gui',
    // Measured: it sends a DHCP discover of its own accord within seconds of
    // reaching the desktop, which is more than almost anything else here does.
    network: { bring: 'auto' },
    summary: 'A graphical operating system written entirely in assembly, on one floppy.',
    contains: 'A desktop, a text editor, an assembler, a browser, and a pile of games and demos.',
    bundled: true,
    transfer: 1_474_560,
    images: [{ slot: 'fda', file: 'kolibri.img', size: 1_474_560 }],
    options: { memory_size: 128 * MB },
    timeoutMs: 90_000,
    boots: 'about 9 seconds',
  },
  {
    id: 'msdos622',
    name: 'MS-DOS 6.22',
    console: 'dos',
    summary: 'The last standalone MS-DOS, on a 64 MB disk read in pieces.',
    contains: 'QBasic, Turbo C, OCaml 1.0, Doom and SimCity.',
    bundled: false,
    transfer: 4 * MB,
    images: [{ slot: 'hda', file: 'msdos622/.img', size: 64 * MB, streamed: true }],
    options: { memory_size: 32 * MB },
    timeoutMs: 120_000,
    prompts: DOS_PROMPTS,
    boots: 'about 7 seconds',
  },
  {
    id: 'windows2',
    name: 'Windows 2.03',
    console: 'gui',
    summary: 'Overlapping windows, two years after 1.01.',
    contains: 'Paint, Write, Cardfile, Calendar, Reversi.',
    bundled: false,
    transfer: 4_177_920,
    images: [{ slot: 'hda', file: 'windows2.img', size: 4_177_920 }],
    options: { memory_size: 32 * MB },
    timeoutMs: 90_000,
    boots: 'about 4 seconds',
  },
  {
    id: 'windows30',
    name: 'Windows 3.0',
    console: 'gui',
    summary: 'Program Manager, on a 24 MB disk.',
    contains: 'CorelDRAW! 2.0, Actor 2.0, the Microsoft Entertainment Pack.',
    bundled: false,
    transfer: 25_165_824,
    images: [{ slot: 'hda', file: 'windows30.img', size: 25_165_824 }],
    options: { memory_size: 128 * MB },
    timeoutMs: 180_000,
    boots: 'about 4 seconds',
  },
  {
    id: 'windows31',
    name: 'Windows 3.1',
    console: 'gui',
    summary: 'The one most people mean by "Windows 3". Boots MS-DOS, then runs WIN.',
    contains: 'QBasic, Minesweeper, Solitaire, Write, Paintbrush — and the DOS prompt underneath it. '
      + 'One thing on this machine does not work and it is worth knowing before you try it: a DOS session '
      + 'started from *inside* Windows — File → Run → `command.com` — comes up as a blank screen that '
      + 'ignores the keyboard. Measured, and measured against v86\'s own defaults with the same disk, which '
      + 'fail identically: it is the emulator, not this build. Exiting Windows instead (Alt+F4, then Enter) '
      + 'gives a DOS prompt that renders and types normally, and Windows 98\'s DOS prompt works as well.',
    bundled: false,
    transfer: 34_463_744,
    images: [{ slot: 'hda', file: 'win31.img', size: 34_463_744 }],
    options: { memory_size: 64 * MB },
    timeoutMs: 180_000,
    boots: 'about 9 seconds',
  },
  {
    id: 'windows95',
    name: 'Windows 95',
    console: 'gui',
    summary: 'A 450 MB disk read in pieces, booted from cold.',
    contains: 'Age of Empires, FASM, POV-Ray, Hover!, and an MS-DOS prompt.',
    bundled: false,
    transfer: 12 * MB,
    images: [{ slot: 'hda', file: 'windows95-v3/.img', size: 471_859_200, streamed: true }],
    options: { memory_size: 64 * MB },
    timeoutMs: 300_000,
    boots: 'about 6 seconds to its splash screen, a minute or more to the desktop',
  },
  {
    id: 'windows98',
    name: 'Windows 98',
    console: 'gui',
    summary: 'Resumed from a saved machine when the host has one, so it reaches the desktop in seconds.',
    contains: 'Internet Explorer 5, FreeCell, Hearts, Notepad, and an MS-DOS prompt.',
    bundled: false,
    transfer: 13_434_587,
    images: [
      { slot: 'hda', file: 'windows98/.img', size: 300 * MB, streamed: true },
      { slot: 'initial_state', file: 'windows98_state-v2.bin.zst' },
    ],
    options: { memory_size: 128 * MB, mac_address_translation: true },
    timeoutMs: 300_000,
    boots: 'about 4 seconds from its saved machine, minutes from cold',
  },
  {
    id: 'windowsme',
    name: 'Windows ME',
    console: 'gui',
    summary: 'The last of the DOS-based line, also resumed from a saved machine.',
    contains: 'Visual Basic, Office 97.',
    bundled: false,
    transfer: 28_999_225,
    images: [
      { slot: 'hda', file: 'windowsme-v3/.img', size: 1024 * MB, streamed: true },
      { slot: 'initial_state', file: 'windows-me_state-v3.bin.zst' },
    ],
    options: { memory_size: 256 * MB },
    timeoutMs: 300_000,
    boots: 'about 4 seconds from its saved machine, minutes from cold',
  },
  {
    id: 'windowsnt4',
    name: 'Windows NT 4.0',
    console: 'gui',
    summary: 'The NT kernel with the Windows 95 shell. Boots from cold.',
    contains: 'Windows NT 4.0 with Service Pack 1, and a command prompt.',
    bundled: false,
    transfer: 16 * MB,
    images: [{ slot: 'hda', file: 'winnt4_noacpi/.img', size: 523_837_440, streamed: true }],
    // NT reads CPUID and will not boot on what it finds otherwise; this is the
    // level v86 documents for the NT line.
    options: { memory_size: 512 * MB, cpuid_level: 2 },
    timeoutMs: 300_000,
    boots: 'about 21 seconds',
  },
  {
    id: 'windows2000',
    name: 'Windows 2000',
    console: 'gui',
    summary: 'Resumed from a saved machine, off a 2 GB disk read in pieces.',
    contains: 'Internet Explorer 6, K-Meleon, Winamp, Delphi, NetHack, and a command prompt.',
    bundled: false,
    transfer: 29_621_987,
    images: [
      { slot: 'hda', file: 'windows2k-v2/.img', size: 2048 * MB, streamed: true },
      { slot: 'initial_state', file: 'windows2k_state-v4.bin.zst' },
    ],
    options: { memory_size: 512 * MB, mac_address_translation: true },
    timeoutMs: 300_000,
    boots: 'about 4 seconds from its saved machine',
  },
  {
    id: 'buildroot',
    name: 'Buildroot Linux 5.6',
    console: 'serial',
    summary: 'A newer Buildroot than the bundled one — kernel 5.6.15 against the bundled 2.6.34, measured.',
    contains: 'busybox, lua, curl, ping and telnet, plus a 9p mount at /mnt. This one has a working network: '
      + 'its console takes a DHCP lease when it attaches, and `wget http://…` reaches the internet through the '
      + 'page. The login banner\'s offer to put files in /mnt is the emulator\'s own — no tool here writes there, '
      + 'so use vm_write_file.',
    bundled: false,
    transfer: 5_166_352,
    images: [{ slot: 'bzimage', file: 'buildroot-bzimage.bin', size: 5_166_352 }],
    options: {
      memory_size: 128 * MB,
      // Exactly what v86's own profile boots it with, and deliberately without
      // `console=ttyS0`. Its init puts a shell on the serial port either way —
      // measured, all three of `console=ttyS0`, `console=ttyS0 console=tty0`
      // and no console argument reach `~% ` on the wire — so the argument buys
      // nothing and costs the screen: with it, the kernel's messages leave the
      // VGA console and the panel shows a boot loader and then nothing.
      cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on',
      filesystem: {},
    },
    timeoutMs: 120_000,
    // Measured: the NE2000 driver is in this kernel, VirtIO is not, and
    // busybox's own DHCP client is what asks for the lease. `-n` gives up
    // rather than retrying forever if nothing answers, and `-q` exits once the
    // lease is configured, so a machine with the network switched off costs
    // the first command a second rather than hanging it.
    network: { bring: 'dhcp', up: 'udhcpc -i eth0 -n -q >/dev/null 2>&1' },
    // `~% ` — measured. Neither `#` nor `$`, which is the whole reason this is
    // a per-guest field: a banner pattern that assumed the two usual prompt
    // characters left this guest sitting at a working shell that nothing ever
    // recognised as ready, for the full seven minutes of the wait.
    banner: '(?:login:|[#$%] )',
    boots: 'about 8 seconds',
  },
  {
    id: 'archlinux',
    name: 'Arch Linux',
    console: 'serial',
    summary: 'A complete 32-bit Arch install over a 9p filesystem, resumed from a saved machine.',
    contains: 'Arch Linux 32 on kernel 5.19 with bash, python3, gcc, curl, pacman, Xorg and Firefox — every '
      + 'file fetched from the image host on first use, so anything you have not touched yet is a round trip '
      + 'away. It has a working network: the console loads the VirtIO driver and takes a DHCP lease when it '
      + 'attaches, and `curl http://…` reaches the internet through the page. `pacman` needs a mirror served '
      + 'over plain HTTP, because TLS cannot terminate in a browser tab.',
    bundled: false,
    transfer: 15_493_096,
    images: [{ slot: 'initial_state', file: 'arch_state-v3.bin.zst' }],
    filesystem: 'arch/',
    options: {
      memory_size: 512 * MB,
      vga_memory_size: 8 * MB,
      net_device: { type: 'virtio' },
    },
    timeoutMs: 240_000,
    // Measured, and the first half of it is v86's own advice: this guest is
    // restored from a saved machine, and the state was saved with the network
    // driver unloaded — which is what v86's networking notes recommend, because
    // a restored MAC address is a new one and a driver that cached the old one
    // sends packets nothing answers. So the driver is loaded after the restore,
    // and only then is there an `eth0` for `dhcpcd` to ask about.
    network: { bring: 'dhcp', up: 'modprobe virtio_net >/dev/null 2>&1; dhcpcd -q -t 15 eth0 >/dev/null 2>&1' },
    banner: '(?:login:|[#$%] )',
    boots: 'about 2 seconds from its saved machine',
  },
]

/**
 * Every machine v86 itself offers, carried in from its own catalog.
 *
 * The table above is sixteen machines this build has *driven*: each one's
 * console kind, readiness marker and boot time was measured against a real
 * browser. v86 offers a hundred and twenty-five, and for a long time the honest
 * answer to "why so few" was that nobody had looked. Looking turns out to
 * settle it: every one of those machines is this same emulator with a different
 * disk, and what copy.sh has that this build does not is a CDN with the disks
 * on it — `scripts/v86-catalog.ts` re-checks that claim against upstream and
 * prints the difference.
 *
 * So the catalog comes in whole, from `v86-catalog.json`, which that script
 * writes: v86's own ids, names, image slots, sizes, piece sizes and constructor
 * options, plus the licence and one-line description from its demo page. Three
 * fields are *not* carried, because they cannot be:
 *
 * - **`boots`** is omitted. Every value in the table above was timed; a number
 *   invented for a machine nobody has started would read exactly like one that
 *   was measured.
 * - **`console`** is decided conservatively. Upstream marks each machine
 *   graphical or text, and a graphical one is `gui`. A *text* one is only `dos`
 *   when upstream calls it DOS — everything else is `gui` too, because `serial`
 *   is a promise that a shell answers on the serial port, and offering a model
 *   a shell that is not there is worse than offering it a screen.
 * - **`bundled`** is false for all of them. The default image host serves five
 *   files; these are not among them, and the setting says so rather than
 *   offering a machine that can only fail.
 *
 * A machine here is therefore listed, correctly configured, and one disk away —
 * which is the difference between "we support sixteen" and "we support what
 * v86 supports, and here is what each one needs".
 */

/** One row of `v86-catalog.json`. */
interface CatalogEntry {
  id: string
  name: string
  images: { slot: string, file: string, size?: number, streamed: boolean, chunkBytes?: number, source?: string }[]
  licence?: string
  family?: string
  medium?: string
  notes?: string
  ui?: string
  options?: Record<string, unknown>
}

/**
 * How long to let a machine we have never timed take to come up.
 *
 * By medium, because that is what the wait is actually about: a floppy is one
 * and a half megabytes read once, a hard disk is a filesystem being walked. The
 * numbers are deliberately generous — this bounds "stuck", and a machine called
 * stuck while it was still booting is a bug report nobody can reproduce.
 * @param medium - how upstream says the machine boots.
 * @returns the budget in milliseconds.
 */
function budgetFor(medium: string | undefined): number {
  if (medium === 'Bootsector') return 60_000
  if (medium === 'Floppy') return 120_000
  if (medium === 'bzImage' || medium === 'Multiboot') return 150_000
  if (medium === 'CD') return 240_000
  return 300_000
}

/**
 * Whether a slot name is one this build can fill.
 *
 * Checked *after* the catalog's `state` has been renamed to the emulator option
 * it actually is, `initial_state` — checking before that silently dropped every
 * machine that resumes from a saved one, which is nine of them and includes
 * most of the interesting ones.
 */
function knownSlot(slot: string): slot is ImageSlot {
  return ['fda', 'fdb', 'hda', 'hdb', 'cdrom', 'bzimage', 'initrd', 'multiboot', 'initial_state'].includes(slot)
}

/**
 * What a machine's network turned out to be, where anybody has looked.
 *
 * Produced by `npx tsx scripts/v86-network-probe.ts --all`, which boots each
 * machine and watches v86's own bus for frames leaving the guest's card. Only
 * positive findings are recorded here: a machine that asked for an address, or
 * put something on the wire, did so and that is a fact. A machine that stayed
 * quiet is *not* recorded as having no driver, because from outside "no driver"
 * and "a driver nobody configured" and "restored from a state that did its
 * networking before the snapshot" are the same silence — and most of this
 * catalog has no shell to ask. Of a hundred and thirteen machines swept, eleven
 * came back positive. That is the honest yield, and it is worth knowing before
 * expecting a network on a machine nobody has driven.
 *
 * {@link MEASURED} carries its own values inline; this is for the machines that
 * come in from the catalog.
 */
const CATALOG_NETWORK: Record<string, GuestNetwork> = {
  // Asked for an address on their own, before anything was typed at them.
  'kolibrios-fallback': { bring: 'auto' },
  serenity: { bring: 'auto' },
  basiclinux: { bring: 'auto' },
  xwoaf: { bring: 'auto' },
  helenos: { bring: 'auto' },
  dsl: { bring: 'auto' },
  // Network bootloaders: reaching the network is the entire program.
  ipxe: { bring: 'auto' },
  'netboot.xyz': { bring: 'auto' },
  // Frames on the wire, no DHCP: a driver is bound and nothing asked for an
  // address, so a static configuration inside the guest is what it wants.
  sanos: { bring: 'link' },
  syllable: { bring: 'link' },
}

/**
 * Turn one catalog row into a machine this build can offer.
 * @param entry - the upstream row.
 * @returns the spec, or undefined for a row this build cannot express.
 */
function fromCatalog(entry: CatalogEntry): GuestSpec | undefined {
  const images: GuestImage[] = []
  let filesystem: string | undefined
  for (const image of entry.images) {
    // v86 calls the saved machine `state`; the emulator option is `initial_state`.
    const slot = image.slot === 'state' ? 'initial_state' : image.slot
    if (image.slot === 'filesystem') {
      filesystem = image.file
      continue
    }
    // A 9p root whose tree is seeded from a separate index is the one shape
    // this build has no way to carry, and there is exactly one of them.
    if (image.slot === 'basefs') return undefined
    if (!knownSlot(slot)) return undefined
    images.push({
      slot,
      file: image.file,
      ...(image.source === undefined ? {} : { source: image.source }),
      ...(image.size === undefined ? {} : { size: image.size }),
      ...(image.streamed ? { streamed: true } : {}),
      ...(image.chunkBytes === undefined ? {} : { chunkBytes: image.chunkBytes }),
    })
  }
  if (images.length === 0) return undefined

  // Two keys in v86's table are the demo page's own vocabulary rather than
  // emulator options, and the emulator ignores what it does not recognise —
  // silently, which is how a machine ends up with the wrong network card and
  // nobody finds out. `net_device_type` is spelled `net_device: { type }`;
  // `mouse_disabled_default` is not a constructor option at all but a call
  // made after the machine starts, so it is carried as a field of its own.
  const options: Record<string, unknown> = { ...entry.options }
  const network = options.net_device_type
  delete options.net_device_type
  if (typeof network === 'string') options.net_device = { type: network }
  const mouseOff = options.mouse_disabled_default === true
  delete options.mouse_disabled_default

  const description = entry.notes !== undefined && entry.notes !== '' ? entry.notes : `${entry.name}, from v86's catalog.`
  return {
    id: entry.id,
    name: entry.name,
    ...(CATALOG_NETWORK[entry.id] === undefined ? {} : { network: CATALOG_NETWORK[entry.id] }),
    console: entry.ui === 'text' && entry.family === 'DOS' ? 'dos' : 'gui',
    summary: `${description}.`.replace(/\.\.$/, '.'),
    // Upstream's own one-line description is the only orientation there is for
    // a machine nobody here has opened. Said as what it is, rather than dressed
    // up as first-hand knowledge.
    contains: `${description}. This machine is carried from v86's own catalog and has not been driven here, `
      + 'so treat that description as all that is known about what is on it.',
    bundled: false,
    transfer: images.reduce((total, image) => total + (image.size ?? 0), 0),
    images,
    ...(filesystem === undefined ? {} : { filesystem }),
    options,
    // Always stated, never left to the default. The default reads `gui` as
    // "ends graphical", which is right for a machine this build has driven and
    // wrong for one carried in: sixteen catalog rows are not in v86's own
    // metadata table at all, and treating those as graphical made every one of
    // them wait out its whole budget with a full text screen in front of it.
    // Unknown means the permissive rule, which a graphical machine also passes.
    screen: entry.ui === 'graphical' ? 'graphical' : 'text',
    ...(mouseOff ? { mouseDisabled: true } : {}),
    timeoutMs: budgetFor(entry.medium),
    // Deliberately no `prompts`. The three DOS machines above were watched
    // reaching theirs; MS-DOS 4 writes `A>` where MS-DOS 7 writes `A:\>`, and
    // a guessed list turns "I do not know this machine's prompt" into "this
    // machine never started". Without one, readiness falls back to the screen
    // having settled with something on it, which is true of both.
  }
}

/**
 * Offer a machine a copy of any file `v86-mirror.json` knows where to get.
 *
 * `AndyZijianZhang/webdsh-images` on Hugging Face is most of that map: the
 * machines whose licences let anyone serve them. The Hub answers range requests
 * with `accept-ranges: bytes` and `access-control-allow-origin: *` — the two
 * things an emulator reading a disk in pieces needs — and, unlike a GitHub
 * Pages site, it is not capped at a gigabyte, which is what the first version
 * of this mirror ran into. Every URL is pinned to a commit rather than a
 * branch: the length guard below would notice a file changing underneath us,
 * but it would notice by quietly dropping the machine, and a mirror this
 * project controls should not need to be caught out.
 *
 * The rest are links into a public repository that already holds the file,
 * which costs no bandwidth here and copies nothing.
 *
 * *Offer*, not impose. It is recorded as {@link GuestImage.mirror} rather than
 * {@link GuestImage.source}, so it stands in for the default host and nothing
 * else: a deployment serving the file itself still wins, and so does a host
 * the user has named. The alternative — writing it as a `source` — quietly
 * made the image-host setting do nothing for seventy-one files, which is the
 * one setting on that page.
 *
 * A machine every one of whose files is reachable this way needs no setup at
 * all, which is what `bundled` means.
 * @param spec - the machine.
 * @returns the machine, with mirrored files offered the mirror.
 */
function withMirror(spec: GuestSpec): GuestSpec {
  const served = MIRROR as Record<string, { url: string, bytes: number } | undefined>
  const images = spec.images.map((image) => {
    const held = served[image.file]
    if (held === undefined || image.source !== undefined) return image
    // A file name is not a disk. `linux.iso` names two of them — the 5.6 MB
    // build this project's own Linux guest was measured on, and the 6.5 MB one
    // v86's catalog boots as `linux26` — and the mirror can only hold one file
    // under one name. Handing the wrong one to a guest that declares the
    // other's length is not a boot that fails, it is a boot that reads past the
    // end of a disk; so a length that disagrees means this machine does not use
    // the mirror, and falls back to the host that has its disk.
    if (image.size !== undefined && !image.file.endsWith('.zst') && image.size !== held.bytes) return image
    return { ...image, mirror: held.url }
  })
  return {
    ...spec,
    images,
    // A 9p root is a directory rather than a file, so a machine that needs one
    // is not complete however many of its disks are reachable.
    bundled: spec.bundled
      || (spec.filesystem === undefined && images.every(image => image.source !== undefined || image.mirror !== undefined)),
  }
}

/**
 * Every machine this build offers: the ones it has driven, then the rest of
 * v86's catalog.
 *
 * Measured first, and by id: a machine named in both tables keeps the entry
 * that was tested, because that is the one carrying a readiness marker and a
 * boot time.
 */
export const GUESTS: GuestSpec[] = [
  ...MEASURED,
  ...(CATALOG as CatalogEntry[])
    .filter(entry => !MEASURED.some(measured => measured.id === entry.id))
    .map(fromCatalog)
    .filter((spec): spec is GuestSpec => spec !== undefined),
].map(withMirror)

/**
 * Find a machine by id.
 * @param id - the guest id.
 * @returns the spec, or undefined when nothing is registered under that id.
 */
export function guest(id: string): GuestSpec | undefined {
  return GUESTS.find(entry => entry.id === id)
}

/**
 * Files this deployment has no way to fetch for a guest.
 *
 * Knowable rather than guessed, and only in the direction that is knowable: a
 * {@link GuestSpec.bundled} guest is one the default image host serves, so on
 * the default host anything a non-bundled guest needs and nobody has supplied
 * has no source at all. Pointed at another host the answer is a network round
 * trip away, and this says nothing rather than guessing.
 *
 * It exists so a boot can refuse before it starts. Without it, choosing a
 * machine whose disk is not here produced a page that sat on "Fetching
 * Windows 3.1" and then a 404 from deep inside the emulator — a failure that
 * names a URL and not the thing the person has to do about it.
 * @param spec - the guest.
 * @param local - the files the user has opened, by slot.
 * @param host - the host that will actually be used; the configured one by default.
 * @returns the missing file names, empty when every file has a source.
 */
export function unavailableImages(
  spec: GuestSpec,
  local: Partial<Record<ImageSlot, File>>,
  host = imageHost(),
): string[] {
  if (spec.bundled || host !== DEFAULT_IMAGE_HOST) return []
  const missing = spec.images
    // A file that names its own source is not the host's to serve, so the host
    // having nothing to say about it decides nothing — and neither does a file
    // the mirror stands in for, which is reachable precisely because this is
    // the default host.
    .filter(image => image.source === undefined && image.mirror === undefined && local[image.slot] === undefined)
    .map(image => image.file)
  // A 9p root is a directory of files the guest asks for one at a time. No
  // local file can be one, so a guest that needs a tree the host does not
  // serve cannot boot however many disks are opened for it.
  if (spec.filesystem !== undefined) missing.push(spec.filesystem)
  return missing
}

/**
 * Build the v86 image options for one guest.
 *
 * A locally-opened file fills its own slot. What it also does — when it is a
 * disk and no saved machine was opened beside it — is suppress the saved
 * machine the host would otherwise supply: a state image records the machine
 * that produced it, right down to the disk's contents, and restoring one over
 * somebody else's disk is not a faster boot, it is a corrupt one. Open the
 * matching state as well and it is used, because then the pair belongs
 * together.
 * @param spec - the guest.
 * @param local - the files the user opened, by slot.
 * @param host - where remote files come from; the configured host by default.
 * @returns the image slots, ready to spread into the constructor.
 */
export function imageOptions(
  spec: GuestSpec,
  local: Partial<Record<ImageSlot, File>> = {},
  host = imageHost(),
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (spec.filesystem !== undefined) options.filesystem = { baseurl: `${host}${spec.filesystem}` }
  const suppliedDisk = spec.images.some(image => image.slot !== 'initial_state' && local[image.slot] !== undefined)
  for (const image of spec.images) {
    const opened = local[image.slot]
    if (opened !== undefined) {
      options[image.slot] = { buffer: opened }
      continue
    }
    if (image.slot === 'initial_state' && suppliedDisk) continue
    options[image.slot] = remoteImage(host, image)
  }
  return options
}

/** One remote file, in the shape v86 accepts. */
function remoteImage(host: string, image: GuestImage): Record<string, unknown> {
  // A file that names its own source is not the host's to serve, and pointing
  // the host somewhere else must not move it. The mirror is the opposite kind
  // of answer — it stands in for the default host, and anything the deployment
  // has actually been pointed at wins over it.
  const mirrored = image.source === undefined && host === DEFAULT_IMAGE_HOST && image.mirror !== undefined
  const url = image.source
    ?? (host === DEFAULT_IMAGE_HOST ? image.mirror ?? `${host}${image.file}` : `${host}${image.file}`)
  if (image.slot === 'initial_state') return { url }
  if (image.streamed === true) {
    // Two ways to read a disk without downloading it, and which one applies is
    // a fact about the host rather than about the machine.
    //
    // copy.sh publishes a large image as a directory of `<offset>-<end>.img`
    // pieces, and `use_parts` is v86 asking for them one at a time. The mirror
    // holds the same disk as *one file* — the pieces are put back together when
    // it is built, because a thousand small objects is a slow upload and a
    // slower boot — and reads it by range instead, which the Hugging Face Hub
    // answers with `accept-ranges: bytes` and CORS headers a browser accepts.
    // Same emulator, same laziness, one request shape apart.
    return {
      url,
      size: image.size,
      async: true,
      fixed_chunk_size: image.chunkBytes ?? DEFAULT_CHUNK_BYTES,
      ...(mirrored ? {} : { use_parts: true }),
    }
  }
  return { url, size: image.size, async: false }
}
