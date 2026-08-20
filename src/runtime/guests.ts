/**
 * The machines v86 can be, and what each one is like to work in.
 *
 * This is data, not behaviour, and it is deliberately its own module: the
 * picker in `packages/dsh-web-runtime` needs it to draw a list, the tool row
 * needs it to decide which tools the model is offered, and the boot needs it
 * before anything heavy has been fetched. All three read this table, and none
 * of them pulls in the emulator to do it.
 *
 * Every timing and every readiness marker below was measured against a cold
 * boot in a real browser rather than reasoned about. `npm run test:v86` boots
 * all five bundled guests and fails if one stops reaching its own marker; the
 * eleven that need a disk from elsewhere were each driven by hand once and are
 * regression-tested only where the suite can get an image — Windows 3.1 and
 * Windows 98. The rest can rot without anything noticing, which is worth
 * knowing before trusting a line in this table.
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
 * So a guest gets its disk one of three ways, and the picker offers all three:
 *
 * 1. **The default image host** — `copy/images` on GitHub, which is public,
 *    answers `access-control-allow-origin: *`, serves ranges, and has no
 *    referrer policy. Five guests below are complete from it and need no
 *    setup at all. They are the ones marked {@link GuestSpec.bundled}.
 * 2. **A host you name** — one setting, for a deployment that mirrors the
 *    wider image set, or for a browser that is on `copy.sh` already.
 * 3. **A file from your computer** — v86 reads a disk image `File` in slices,
 *    so a 300 MB Windows 98 disk opened this way costs no download at all and
 *    works offline. For the proprietary guests this is the lawful path anyway,
 *    and it is the one `scripts/v86-e2e.ts` exercises for Windows 3.1.
 */

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
export type ImageSlot = 'fda' | 'hda' | 'cdrom' | 'bzimage' | 'initial_state'

/** One file a guest needs. */
export interface GuestImage {
  /** The v86 option it becomes. */
  slot: ImageSlot
  /** File name, relative to the image host. */
  file: string
  /** Exact byte length, which a streamed disk cannot be read without. */
  size?: number
  /** Read in 256 KiB pieces as the guest touches them, rather than fetched whole. */
  streamed?: boolean
}

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
  /** The slot a locally-opened file fills. */
  localSlot: ImageSlot
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
  /** What a serial guest prints when its console is ready, as a regular expression. */
  banner?: string
  /** A login the serial console asks for before it gives a shell. */
  login?: { ask: string, send: string }
  /**
   * How long a cold start takes, for the picker and the model to quote.
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
  boots: string
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
 * picker draws them in this order and does not sort.
 */
export const GUESTS: GuestSpec[] = [
  {
    id: 'linux',
    name: 'Linux',
    console: 'serial',
    summary: 'Buildroot Linux on a 5.7 MB CD — the shortest way here to a real POSIX shell.',
    contains: 'busybox — ash, grep, sed, awk, find, tar, vi, wc, sort — and nothing else. No package manager, '
      + 'no compiler, and no route out of the page, so nothing network-shaped reaches anything.',
    bundled: true,
    transfer: 5_666_816,
    images: [{ slot: 'cdrom', file: 'linux.iso', size: 5_666_816 }],
    localSlot: 'cdrom',
    // An empty 9p device, as v86's own profile for this image configures one.
    // The guest cannot use it — this kernel is 2.6.34 and `/proc/filesystems`
    // has no `9p` entry, measured — so the page's `create_file` writes into a
    // tree nothing mounts. The device is kept because upstream keeps it and
    // removing it changes the hardware a working image booted on; no tool
    // offers it, which is the part that would have been a lie.
    options: { memory_size: 128 * MB, filesystem: {} },
    timeoutMs: 90_000,
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
    localSlot: 'fda',
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
    localSlot: 'fda',
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
    localSlot: 'fda',
    options: { memory_size: 32 * MB },
    timeoutMs: 90_000,
    boots: 'about 4 seconds',
  },
  {
    id: 'kolibrios',
    name: 'KolibriOS',
    console: 'gui',
    summary: 'A graphical operating system written entirely in assembly, on one floppy.',
    contains: 'A desktop, a text editor, an assembler, a browser, and a pile of games and demos.',
    bundled: true,
    transfer: 1_474_560,
    images: [{ slot: 'fda', file: 'kolibri.img', size: 1_474_560 }],
    localSlot: 'fda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
    options: { memory_size: 128 * MB },
    timeoutMs: 180_000,
    boots: 'about 4 seconds',
  },
  {
    id: 'windows31',
    name: 'Windows 3.1',
    console: 'gui',
    summary: 'The one most people mean by "Windows 3". Boots MS-DOS, then runs WIN.',
    contains: 'QBasic, Minesweeper, Solitaire, Write, Paintbrush — and the DOS prompt underneath it.',
    bundled: false,
    transfer: 34_463_744,
    images: [{ slot: 'hda', file: 'win31.img', size: 34_463_744 }],
    localSlot: 'hda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
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
    localSlot: 'hda',
    options: { memory_size: 512 * MB, mac_address_translation: true },
    timeoutMs: 300_000,
    boots: 'about 4 seconds from its saved machine',
  },
  {
    id: 'buildroot',
    name: 'Buildroot Linux 5.6',
    console: 'serial',
    summary: 'A newer Buildroot than the bundled one — kernel 5.6.15 against the bundled 2.6.34, measured.',
    contains: 'busybox, lua, curl, ping and telnet, plus a 9p mount at /mnt. The network device is emulated '
      + 'but has no route out of the page, so `curl` and `ping` reach nothing, and the login banner\'s offer to '
      + 'put files in /mnt is the emulator\'s own — no tool here writes there, so use vm_write_file.',
    bundled: false,
    transfer: 5_166_352,
    images: [{ slot: 'bzimage', file: 'buildroot-bzimage.bin', size: 5_166_352 }],
    localSlot: 'bzimage',
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
    contains: 'Arch Linux 32 on kernel 5.19 with bash, python3, gcc, pacman, Xorg and Firefox — every file '
      + 'fetched from the image host on first use, so anything you have not touched yet is a round trip away. '
      + '`pacman` cannot reach a mirror: there is no route out of the page.',
    bundled: false,
    transfer: 15_493_096,
    images: [{ slot: 'initial_state', file: 'arch_state-v3.bin.zst' }],
    localSlot: 'initial_state',
    filesystem: 'arch/',
    options: {
      memory_size: 512 * MB,
      vga_memory_size: 8 * MB,
      net_device: { type: 'virtio' },
    },
    timeoutMs: 240_000,
    banner: '(?:login:|[#$%] )',
    boots: 'about 2 seconds from its saved machine',
  },
]

/**
 * Find a machine by id.
 * @param id - the guest id.
 * @returns the spec, or undefined when nothing is registered under that id.
 */
export function guest(id: string): GuestSpec | undefined {
  return GUESTS.find(entry => entry.id === id)
}

/**
 * Build the v86 image options for one guest.
 *
 * A locally-opened disk replaces the slot it fills *and* suppresses any saved
 * machine the host would otherwise supply: a state image records the machine
 * that produced it, right down to the disk's contents, and restoring one over
 * somebody else's disk is not a faster boot, it is a corrupt one.
 * @param spec - the guest.
 * @param local - a disk image the user opened, when there is one.
 * @returns the image slots, ready to spread into the constructor.
 */
export function imageOptions(spec: GuestSpec, local?: File): Record<string, unknown> {
  const host = imageHost()
  const options: Record<string, unknown> = {}
  if (spec.filesystem !== undefined) options.filesystem = { baseurl: `${host}${spec.filesystem}` }
  if (local !== undefined) {
    options[spec.localSlot] = { buffer: local }
    for (const image of spec.images) {
      if (image.slot === spec.localSlot || image.slot === 'initial_state') continue
      options[image.slot] = remoteImage(host, image)
    }
    return options
  }
  for (const image of spec.images) options[image.slot] = remoteImage(host, image)
  return options
}

/** One remote file, in the shape v86 accepts. */
function remoteImage(host: string, image: GuestImage): Record<string, unknown> {
  const url = `${host}${image.file}`
  if (image.slot === 'initial_state') return { url }
  if (image.streamed === true) {
    return { url, size: image.size, async: true, fixed_chunk_size: 256 * 1024, use_parts: true }
  }
  return { url, size: image.size, async: false }
}
