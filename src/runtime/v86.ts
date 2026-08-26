/**
 * The emulated PC, as a page capability.
 *
 * v86 is a JIT that translates x86 to WebAssembly as it runs. What it boots is
 * a real operating system off a real disk image, so unlike the container
 * runtime beside it, nothing here is a reimplementation of anything. If DOS
 * does it on a 486, it does it here.
 *
 * What that costs is the whole reason this is a *choice* rather than the
 * default: no shared filesystem with the page, no npm, no Python, and — on the
 * graphical guests — no text anywhere to read. Driving Windows 3.1 means
 * typing at it and looking at the screen, because that is what driving Windows
 * 3.1 is.
 *
 * Four things shape the code below.
 *
 * - **Nothing loads until something asks.** The emulator is 2 MB of
 *   WebAssembly and the smallest guest is another 720 KB, so the import is
 *   dynamic and the boot is lazy. A session on the default runtime fetches
 *   none of it.
 * - **The screen is mirrored from public events.** `screen-put-char` and
 *   `screen-set-size` are v86's documented event surface, so the text buffer
 *   here is built from those rather than by reaching into the screen adapter.
 *   It works whether or not anything is drawing.
 * - **The console is a stream, not a screen.** A serial guest speaks on the
 *   serial port already; a DOS guest is *moved* onto it with `CTTY COM1`,
 *   which is a DOS command, not a trick, and is what turns "whatever of the
 *   output had not scrolled off 80×25" into the whole of it.
 * - **The machine outlives the panel.** The agent drives it with nothing open,
 *   so this module owns the screen element and the panel borrows it.
 *   Off-screen rather than `display: none`, because a hidden element has no
 *   layout and v86 measures the box it draws into.
 */

import {
  BIOS_BASE, DEPLOYMENT_IMAGE_HOST, deploymentServes, guest, imageHost, imageHostIsChosen, imageOptions,
  unavailableImages, type GuestSpec, type ImageSlot,
} from './guests.ts'
import { legacyDisk, storedDisk } from './disks.ts'
import { runtimeSelection } from './selection.ts'
import {
  attachMachineNetwork, machineNetworkConfig, netDevice, resolveRelay, type NetworkedEmulator,
} from '../net/machine-network.ts'

/** As much of v86's surface as this module uses. */
interface Emulator {
  destroy(): Promise<void>
  is_running(): boolean
  add_listener(event: string, listener: (argument: never) => void): void
  keyboard_send_scancodes(codes: number[]): void
  screen_make_screenshot(): HTMLImageElement | null
  mouse_set_enabled(enabled: boolean): void
  serial0_send(data: string): void
}

/**
 * CP437, which is what the text buffer holds.
 *
 * The VGA reports a byte per cell and DOS wrote that byte meaning code page
 * 437 — so a box-drawing character arrives as `0xC9`, and reading it as Latin-1
 * would turn every DOS menu into noise. This is v86's own table, kept here so
 * the mirror does not depend on a screen adapter existing.
 */
const CP437 = ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

/**
 * Scan codes for the printable US layout, and which of them need Shift.
 *
 * Text is typed as scan codes rather than through `keyboard_send_text`, which
 * routes through v86's DOM keyboard adapter and is gated on the guest having
 * enabled the controller. A guest that has not — anything sitting in the BIOS,
 * or mid-boot — swallows the text silently, and a tool that silently types
 * nothing is worse than one that cannot type at all. Scan codes go straight to
 * the emulated controller, which is what a keyboard actually sends.
 */
const UNSHIFTED = '`1234567890-=  qwertyuiop[]  asdfghjkl;\'  \\zxcvbnm,./'
const SHIFTED = '~!@#$%^&*()_+  QWERTYUIOP{}  ASDFGHJKL:"  |ZXCVBNM<>?'
/** Set-1 make codes, in the order the two rows above spell out. */
const ROW_CODES = [
  0x29, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x00, 0x00,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x00, 0x00,
  0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x00, 0x00,
  0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35,
]

/** Named keys, as `vm_key` spells them. `extended` marks an `E0`-prefixed code. */
const NAMED_KEYS: Record<string, { code: number, extended?: boolean }> = {
  enter: { code: 0x1C }, escape: { code: 0x01 }, esc: { code: 0x01 },
  tab: { code: 0x0F }, backspace: { code: 0x0E }, space: { code: 0x39 },
  up: { code: 0x48, extended: true }, down: { code: 0x50, extended: true },
  left: { code: 0x4B, extended: true }, right: { code: 0x4D, extended: true },
  home: { code: 0x47, extended: true }, end: { code: 0x4F, extended: true },
  pageup: { code: 0x49, extended: true }, pagedown: { code: 0x51, extended: true },
  insert: { code: 0x52, extended: true }, delete: { code: 0x53, extended: true },
  f1: { code: 0x3B }, f2: { code: 0x3C }, f3: { code: 0x3D }, f4: { code: 0x3E },
  f5: { code: 0x3F }, f6: { code: 0x40 }, f7: { code: 0x41 }, f8: { code: 0x42 },
  f9: { code: 0x43 }, f10: { code: 0x44 }, f11: { code: 0x57 }, f12: { code: 0x58 },
  capslock: { code: 0x3A }, numlock: { code: 0x45 }, scrolllock: { code: 0x46 },
  windows: { code: 0x5B, extended: true }, menu: { code: 0x5D, extended: true },
}

/** Modifier prefixes `vm_key` accepts. */
const MODIFIERS: Record<string, number> = { ctrl: 0x1D, control: 0x1D, alt: 0x38, shift: 0x2A }

/**
 * `KeyboardEvent.code` → set-1 scan code, for a panel that is showing the screen.
 *
 * The emulator is constructed with `disable_keyboard`, so v86 never installs
 * its own listener — which is the whole point. Its adapter binds to `window`
 * and forwards anything not aimed at an `<input>` or a `<textarea>`, and it
 * only exists once the WebAssembly has instantiated, so the switch meant to
 * hold it off cannot be thrown before it is already listening. There is no
 * moment at which that is safe in a page whose other half is a chat client.
 *
 * So the translation lives here and the panel drives it from events on its own
 * element. What reaches the guest is what someone typed *at the screen*, and
 * nothing else ever can.
 */
const CODE_SCANCODES: Record<string, { code: number, extended?: boolean }> = {
  Escape: { code: 0x01 },
  Digit1: { code: 0x02 }, Digit2: { code: 0x03 }, Digit3: { code: 0x04 }, Digit4: { code: 0x05 },
  Digit5: { code: 0x06 }, Digit6: { code: 0x07 }, Digit7: { code: 0x08 }, Digit8: { code: 0x09 },
  Digit9: { code: 0x0A }, Digit0: { code: 0x0B }, Minus: { code: 0x0C }, Equal: { code: 0x0D },
  Backspace: { code: 0x0E }, Tab: { code: 0x0F },
  KeyQ: { code: 0x10 }, KeyW: { code: 0x11 }, KeyE: { code: 0x12 }, KeyR: { code: 0x13 },
  KeyT: { code: 0x14 }, KeyY: { code: 0x15 }, KeyU: { code: 0x16 }, KeyI: { code: 0x17 },
  KeyO: { code: 0x18 }, KeyP: { code: 0x19 }, BracketLeft: { code: 0x1A }, BracketRight: { code: 0x1B },
  Enter: { code: 0x1C }, ControlLeft: { code: 0x1D },
  KeyA: { code: 0x1E }, KeyS: { code: 0x1F }, KeyD: { code: 0x20 }, KeyF: { code: 0x21 },
  KeyG: { code: 0x22 }, KeyH: { code: 0x23 }, KeyJ: { code: 0x24 }, KeyK: { code: 0x25 },
  KeyL: { code: 0x26 }, Semicolon: { code: 0x27 }, Quote: { code: 0x28 }, Backquote: { code: 0x29 },
  ShiftLeft: { code: 0x2A }, Backslash: { code: 0x2B },
  KeyZ: { code: 0x2C }, KeyX: { code: 0x2D }, KeyC: { code: 0x2E }, KeyV: { code: 0x2F },
  KeyB: { code: 0x30 }, KeyN: { code: 0x31 }, KeyM: { code: 0x32 }, Comma: { code: 0x33 },
  Period: { code: 0x34 }, Slash: { code: 0x35 }, ShiftRight: { code: 0x36 },
  NumpadMultiply: { code: 0x37 }, AltLeft: { code: 0x38 }, Space: { code: 0x39 }, CapsLock: { code: 0x3A },
  F1: { code: 0x3B }, F2: { code: 0x3C }, F3: { code: 0x3D }, F4: { code: 0x3E }, F5: { code: 0x3F },
  F6: { code: 0x40 }, F7: { code: 0x41 }, F8: { code: 0x42 }, F9: { code: 0x43 }, F10: { code: 0x44 },
  NumLock: { code: 0x45 }, ScrollLock: { code: 0x46 },
  Numpad7: { code: 0x47 }, Numpad8: { code: 0x48 }, Numpad9: { code: 0x49 }, NumpadSubtract: { code: 0x4A },
  Numpad4: { code: 0x4B }, Numpad5: { code: 0x4C }, Numpad6: { code: 0x4D }, NumpadAdd: { code: 0x4E },
  Numpad1: { code: 0x4F }, Numpad2: { code: 0x50 }, Numpad3: { code: 0x51 }, Numpad0: { code: 0x52 },
  NumpadDecimal: { code: 0x53 }, IntlBackslash: { code: 0x56 }, F11: { code: 0x57 }, F12: { code: 0x58 },
  NumpadEnter: { code: 0x1C, extended: true }, ControlRight: { code: 0x1D, extended: true },
  NumpadDivide: { code: 0x35, extended: true }, AltRight: { code: 0x38, extended: true },
  Home: { code: 0x47, extended: true }, ArrowUp: { code: 0x48, extended: true },
  PageUp: { code: 0x49, extended: true }, ArrowLeft: { code: 0x4B, extended: true },
  ArrowRight: { code: 0x4D, extended: true }, End: { code: 0x4F, extended: true },
  ArrowDown: { code: 0x50, extended: true }, PageDown: { code: 0x51, extended: true },
  Insert: { code: 0x52, extended: true }, Delete: { code: 0x53, extended: true },
  MetaLeft: { code: 0x5B, extended: true }, MetaRight: { code: 0x5C, extended: true },
  ContextMenu: { code: 0x5D, extended: true },
}

/** Every key name the tool description can offer. */
export const KEY_NAMES = Object.keys(NAMED_KEYS).filter(name => name !== 'esc')

/** The break code for a make code. */
function release(code: number): number {
  return code | 0x80
}

/**
 * Remove terminal control sequences from console text.
 *
 * A serial console is a terminal, and a modern shell talks to it like one: Arch
 * puts a colour on every prompt and brackets every paste, so a command's result
 * arrives wrapped in `\x1b[01;32m` and `\x1b[?2004l` — measured. Passing that to
 * a model is noise it has to read past, and passing it to the prompt detector
 * is worse: `# ` followed by an escape sequence no longer *ends* with `#`, so
 * whether the console is recognised as ready depends on which byte arrived
 * last.
 *
 * The terminal panel is not given stripped text — a terminal wants its colours
 * — so this is applied where the text becomes a string somebody reads.
 * @param text - raw console output.
 * @returns the same text with CSI, OSC and charset sequences removed.
 */
function withoutControlSequences(text: string): string {
  return text
    // CSI: ESC [ … final byte, which covers colours, cursor moves and the
    // bracketed-paste toggles a modern shell emits around every prompt.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] … BEL or ST, which is how a shell sets the window title.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Two-byte sequences: charset selection, keypad mode, and the rest.
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\u001b[=>78MDEHc]/g, '')
}

/** How many rows of scrolled-off text the transcript keeps. */
const TRANSCRIPT_LIMIT = 4000

/**
 * How much of the screen must still line up for a shift to count as a scroll.
 *
 * A shift of `rows - 1` leaves a single row to compare, and one blank row
 * matching another blank row is true on almost any screen. Requiring a third
 * of the screen to line up is what separates "the display scrolled" from "two
 * unrelated screens happen to agree about one line".
 */
const MIN_SCROLL_OVERLAP = 8

/** How much console output is kept before the oldest is dropped. */
const SERIAL_LIMIT = 1 << 20

/**
 * The VGA text buffer, mirrored, plus the lines that scrolled off it.
 *
 * The screen is 80×25 and a program that prints more than that has already
 * lost the top of its output by the time anything looks. Nothing can recover
 * text that was never stored, so this stores it: whenever the screen shifts up,
 * the rows that left the top are appended to a transcript.
 *
 * A shift is detected by comparing the screen against its previous state,
 * because that is the only signal there is — the VGA emits a `put-char` per
 * changed cell and says nothing about *why* the cells changed.
 */
class TextScreen {
  cols = 80
  rows = 25
  /** One code point per cell. */
  private cells = new Uint8Array(80 * 25)
  /** Rows that have scrolled off the top, oldest first. */
  private history: string[] = []
  /** The last snapshot the scroll detector compared against. */
  private previous: string[] = []
  /** Set by a `put-char`, cleared by the scroll detector. */
  private dirty = false

  /** Resize, discarding the buffer the way the hardware does. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.cells = new Uint8Array(this.cols * this.rows)
    this.previous = []
    this.dirty = true
  }

  /** Record one cell. */
  put(row: number, col: number, character: number): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return
    this.cells[row * this.cols + col] = character
    this.dirty = true
  }

  /** The screen as it is now, one string per row. */
  lines(): string[] {
    const out: string[] = []
    for (let row = 0; row < this.rows; row++) {
      let text = ''
      for (let col = 0; col < this.cols; col++) text += CP437[this.cells[row * this.cols + col]] ?? ' '
      out.push(text)
    }
    return out
  }

  /**
   * Fold anything that scrolled off the top into the transcript.
   *
   * Called on a timer rather than per character: one line of DOS output is
   * eighty `put-char` events, and comparing the screen once per frame is both
   * cheaper and the only granularity at which "the screen shifted" is a
   * meaningful question.
   */
  settle(): void {
    if (!this.dirty) return
    this.dirty = false
    const current = this.lines()
    // A redraw that changed nothing is not a scroll, and on a screen whose rows
    // are all identical — a freshly cleared one — every shift matches, so
    // without this a `cls` would push a blank row into the transcript on every
    // pass. Nothing moved unless something differs.
    const moved = this.previous.length !== current.length
      || current.some((line, row) => line !== this.previous[row])
    if (moved && this.previous.length === current.length) {
      for (let shift = 1; shift <= this.rows - MIN_SCROLL_OVERLAP; shift++) {
        let matches = true
        let witness = false
        for (let row = 0; row + shift < this.rows && matches; row++) {
          matches = this.previous[row + shift] === current[row]
          // At least one of the matched rows has to have something on it.
          // Blank matching blank is not evidence a screen moved, and on a
          // mostly-empty screen it is enough to "prove" a shift of the whole
          // height — which pushed twenty-four rows that never scrolled into
          // the transcript, again on every repaint.
          if (matches && current[row].trim() !== '') witness = true
        }
        if (!matches || !witness) continue
        for (let row = 0; row < shift; row++) this.history.push(this.previous[row])
        if (this.history.length > TRANSCRIPT_LIMIT) {
          this.history.splice(0, this.history.length - TRANSCRIPT_LIMIT)
        }
        break
      }
    }
    this.previous = current
  }

  /** Everything the guest has written, scrolled-off rows first. */
  transcript(): string[] {
    this.settle()
    return [...this.history, ...this.lines()].map(line => line.replace(/\s+$/, ''))
  }
}

/** What one command did. */
export interface CommandResult {
  /** Everything it printed, with the echoed command line and the marker removed. */
  output: string
  /** Its exit status, when the guest's shell reports one. */
  exitCode: number | null
  /** Whether the wait ran out before the command finished. */
  timedOut: boolean
}

/** One machine, running. */
export interface Machine {
  /** What it is. */
  spec: GuestSpec
  /** The element v86 draws into; the panel borrows it. */
  screen: HTMLElement
  /**
   * Wait until the guest has reached its own readiness marker.
   *
   * Answered once and remembered: a guest that has booted stays booted, and a
   * caller that asks again should not re-derive it. A guest that ran out of
   * time is *not* remembered as unready — it may simply be slower than its
   * budget — but later calls give it a token wait rather than the whole
   * budget again, so a machine that never signals does not cost every caller
   * after the first one another five minutes.
   */
  ready(timeoutMs?: number): Promise<boolean>
  /** The VGA text screen as it is now. */
  screenText(): { lines: string[], cols: number, rows: number, graphical: boolean }
  /** Everything written to the text screen, including what scrolled off it. */
  transcript(): string[]
  /**
   * Type text, as a US keyboard would send it.
   * @param text - what to type.
   * @returns the characters a US keyboard has no key for, which went unsent.
   */
  type(text: string): Promise<string[]>
  /** Press one key, optionally with modifiers: `Enter`, `Ctrl+C`, `Alt+Enter`. */
  press(key: string): void
  /** Move the pointer by a delta, in mouse units. */
  moveMouse(dx: number, dy: number): void
  /** Press and release a mouse button. */
  click(which: 'left' | 'middle' | 'right'): Promise<void>
  /**
   * Hold a mouse button down, or let it up.
   *
   * Separate from {@link Machine.click} because a drag is a press, a move and
   * a release, and a tool that could only click could not express one.
   * @param which - the button.
   * @param down - whether it goes down or comes up.
   */
  button(which: 'left' | 'middle' | 'right', down: boolean): void
  /**
   * Turn the wheel.
   * @param dx - horizontal notches; positive is right.
   * @param dy - vertical notches; positive is down, the direction a reader
   * scrolls to move further into a document.
   */
  scroll(dx: number, dy: number): void
  /** A PNG of what the screen shows. */
  screenshot(): Promise<{ bytes: Uint8Array, width: number, height: number, graphical: boolean }>
  /** Whether the screen is in a graphical mode rather than a text one. */
  graphical(): boolean
  /**
   * What the guest is doing with the pointer, and whether it is getting one.
   *
   * `enabled` is the guest having turned its mouse on — a DOS prompt has not,
   * a desktop has. `absolute` is the guest reading the VMware backdoor
   * pointer, which carries a position rather than a movement: with it the
   * guest's cursor is wherever the real one is, and without it the guest is
   * integrating relative motion and the two cursors drift apart the moment
   * their sensitivities differ. `held` is whether pointer input is currently
   * reaching it at all — see {@link Machine.usePointer}.
   */
  pointer(): { enabled: boolean, absolute: boolean, held: boolean }
  /**
   * Hand the mouse to the guest, or take it back.
   *
   * Off until something asks, because the emulator's adapter listens on
   * `window` and forwards anything over the screen: a guest with a mouse
   * otherwise has a cursor that follows yours around whenever the panel is
   * open, drifting further from it the longer you move. The panel asks when
   * you take pointer lock and gives it back when you leave.
   * @param on - whether the guest should receive pointer input.
   */
  usePointer(on: boolean): void
  /**
   * Deliver one real key event to the guest.
   *
   * The panel's own listener calls this, and nothing else can: v86 is
   * constructed with `disable_keyboard`, so there is no window-wide listener
   * for the composer's keystrokes to fall into. See {@link CODE_SCANCODES}.
   * @param code - the event's `code`, which is a physical key and not a layout.
   * @param down - whether the key went down or came up.
   * @returns whether this build knows that key.
   */
  sendKeyEvent(code: string, down: boolean): boolean
  /** The command channel, on the guests that have one. */
  console: MachineConsole
}

/** The guest's command channel. */
export interface MachineConsole {
  /** Whether this guest has one at all. */
  available: boolean
  /** Run one command and return everything it printed. */
  run(command: string, options?: { timeoutMs?: number, signal?: AbortSignal }): Promise<CommandResult>
  /** Everything the console has said, from `offset` onwards. */
  read(offset?: number): { text: string, next: number }
  /** Send raw text to it — for a program that is waiting for input. */
  write(text: string): void
  /** Watch the stream; returns a disposer. */
  subscribe(listener: (chunk: string) => void): () => void
  /**
   * Write a text file onto the guest, through this console.
   *
   * There is no filesystem in common with the page and the console is the only
   * channel there is, so the file is delivered as an octal-escaped `printf`:
   * one physical line at a time, every character surviving, nothing installed.
   *
   * A shell is required and DOS is refused. `COPY CON` was the obvious DOS
   * equivalent and it does not work: measured on FreeDOS, `COPY CON FILE` after
   * `CTTY COM1` prints `con => FILE` and then reads nothing from the serial
   * port — and because it never sees its end-of-file, it swallows every command
   * sent afterwards, wedging the console until the machine is restarted. A file
   * channel that can do that is worse than none, so DOS gets `echo … >` in its
   * tool description instead, which is a command like any other.
   * @param path - where to write it, in the guest's own path syntax.
   * @param content - the file's text.
   * @returns the size the guest reports afterwards, or null when it reported none.
   * @throws when this guest has no shell to deliver it through.
   */
  putFile(path: string, content: string): Promise<{ expected: number, reported: number | null }>
  /**
   * Put the console back on the screen, so the screen tools tell the truth.
   *
   * Only a DOS guest has anything to do here: its console *is* the screen
   * until `CTTY COM1` moves it, and while it is moved the screen is frozen and
   * the keyboard goes nowhere. Every screen-facing tool calls this first.
   */
  releaseScreen(): Promise<void>
}

/** Whether this page can host an emulated PC at all. */
export function machineSupported(): { ok: boolean, reason?: string } {
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'WebAssembly is unavailable' }
  if (typeof document === 'undefined') return { ok: false, reason: 'there is no document to draw a screen into' }
  return { ok: true }
}

/** Why the machine could not start, once an attempt has failed. */
let bootFailure: string | undefined

/** Why the machine is unusable, if it is. */
export function machineFailure(): string | undefined {
  return bootFailure
}

let running: Promise<Machine> | undefined
let settled: Machine | undefined

/**
 * Everyone waiting to hear how the boot is going.
 *
 * The boot happens once and is shared, so the callback belongs to the boot
 * rather than to whoever asked for it first. Without this the panel's progress
 * text is dead code on every load that matters: `src/main.ts` starts the boot
 * as the page opens, so by the time someone opens the panel the promise
 * already exists and their callback is dropped — leaving "Starting the
 * machine…" on screen for the whole of a Windows 95 download.
 */
const watchers = new Set<(step: string) => void>()

/** The last thing the boot said, for a watcher that arrived after it said it. */
let lastStep: string | undefined

/** Tell everyone watching. */
function report(step: string): void {
  lastStep = step
  for (const watcher of watchers) watcher(step)
}

/**
 * How many times the machine has been torn down.
 *
 * A boot that is still fetching a disk cannot be cancelled — v86 owns the
 * requests — so `stopMachine` marks the generation instead, and the boot it
 * abandoned checks before installing itself as the current machine. Without it
 * a restart during a slow boot ends with the old machine quietly becoming the
 * live one again, several seconds after it was thrown away.
 */
let generation = 0

/** The live emulator, so a teardown can free its worker and its memory. */
let live: Emulator | undefined

/**
 * The scroll detector's timer, module-level so a teardown can reach it.
 *
 * A stray interval walking a discarded screen buffer forty times a second is
 * exactly the kind of leak a long-lived tab notices.
 */
let settleTimer: ReturnType<typeof setInterval> | undefined

/** Whether a machine has been started in this page. */
export function machineStarted(): boolean {
  return running !== undefined
}

/**
 * The running machine, or undefined when none has finished starting.
 *
 * Synchronous, for the callers that must not start a boot just to answer "is
 * there a machine" — the Files panel asking which filesystem is live, for one.
 */
export function currentMachine(): Machine | undefined {
  return settled
}

/**
 * Which guest this page is configured to boot.
 * @returns the spec, or undefined when this session is not an emulated one.
 */
export function machineGuest(): GuestSpec | undefined {
  const selection = runtimeSelection()
  return selection.kind === 'v86' ? guest(selection.image) : undefined
}

/**
 * Build the element v86 draws into.
 *
 * The structure is v86's: a `div` for text mode and a `canvas` for graphical
 * mode, inside a container it is handed. It lives off-screen rather than
 * hidden, because `display: none` gives an element no box and the screen
 * adapter measures the box to decide its scale.
 * @returns the container, already in the document.
 */
function createScreen(): HTMLElement {
  const container = document.createElement('div')
  container.id = 'dsh-v86-screen'
  const text = document.createElement('div')
  text.style.cssText = 'white-space:pre;font:14px/14px monospace;color:#dfe3ea'
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;max-width:100%'
  container.append(text, canvas)
  parkScreen(container)
  document.body.append(container)
  return container
}

/**
 * Put the screen back where it lives when nothing is showing it.
 *
 * Off-screen and inert, but laid out: the emulator keeps drawing into it, so a
 * screenshot taken with the panel closed is the screen as it is now rather
 * than as it was when the panel last had it.
 * @param element - the screen container.
 */
export function parkScreen(element: HTMLElement): void {
  place(element, {
    position: 'fixed', left: '-10000px', top: '0', width: '720px',
    pointerEvents: 'none', zIndex: '-1', display: 'block', margin: '0', maxWidth: '',
  })
  if (element.parentElement !== document.body) document.body.append(element)
}

/**
 * Take the screen out of its parking spot so a panel can show it.
 *
 * `width: fit-content` and not `max-width: 100%`, because this element's box
 * is what the pointer is measured against: v86 turns a real mouse position
 * into a guest one by taking it as a fraction of this rectangle, so a
 * container wider than the picture inside it puts the guest's cursor to the
 * left of the real one by however much slack there is.
 * @param element - the screen container.
 */
export function unparkScreen(element: HTMLElement): void {
  place(element, {
    position: '', left: '', top: '', width: 'fit-content',
    pointerEvents: '', zIndex: '', display: 'block', margin: '0 auto', maxWidth: '100%',
  })
}

/**
 * Write the layout properties of the screen container, and only those.
 *
 * Not `cssText`, which replaces the whole declaration: v86's mouse adapter
 * writes `cursor: none` on this same element when the guest starts drawing its
 * own pointer, and a panel that opened afterwards used to erase it — giving
 * two cursors on a guest that had gone to the trouble of telling us it only
 * needs one.
 * @param element - the screen container.
 * @param styles - the properties to set; an empty string clears one.
 */
function place(element: HTMLElement, styles: Record<string, string>): void {
  for (const [name, value] of Object.entries(styles)) {
    element.style.setProperty(
      name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`),
      value === '' ? null : value,
    )
  }
}

/** Bytes as a size a person reads. */
function readableSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`
}

/**
 * Boot the selected machine, once.
 *
 * Everything heavy happens here and nowhere earlier: the emulator module, its
 * WebAssembly, the BIOS, and the disk. A page whose visitor never chooses an
 * emulated runtime never executes a line of this function.
 * @param onProgress - called with human-readable steps.
 * @returns the running machine.
 */
export async function bootMachine(onProgress?: (step: string) => void): Promise<Machine> {
  if (onProgress !== undefined) {
    watchers.add(onProgress)
    if (lastStep !== undefined) onProgress(lastStep)
  }
  running ??= start().catch((error: unknown) => {
    bootFailure = error instanceof Error ? error.message : String(error)
    watchers.clear()
    console.warn('[v86] the machine could not start:', error)
    // Cleared so a second attempt is a real attempt: a failed image fetch is
    // usually a network blip, and refusing forever would make one bad request
    // permanent for the life of the page.
    running = undefined
    throw error
  })
  return running
}

/**
 * The files the user has opened for this guest, by slot.
 * @param spec - the guest.
 * @returns one entry per slot a stored file was found for.
 */
async function openedImages(spec: GuestSpec): Promise<Partial<Record<ImageSlot, File>>> {
  const found: Partial<Record<ImageSlot, File>> = {}
  await Promise.all(spec.images.map(async (image) => {
    const file = await storedDisk(spec.id, image.slot)
    if (file !== undefined) found[image.slot] = file
  }))
  // A browser that already had a disk from before this store kept images by
  // slot still has it, under the bare guest id, and it was the boot image.
  const boot = spec.images[0]?.slot
  if (boot !== undefined && found[boot] === undefined) {
    const legacy = await legacyDisk(spec.id)
    if (legacy !== undefined) found[boot] = legacy
  }
  return found
}

/** Whether every file this guest needs was opened from the user's computer. */
function openedEverything(spec: GuestSpec, local: Partial<Record<ImageSlot, File>>): boolean {
  return spec.images.every(image => local[image.slot] !== undefined)
}

/**
 * Where this machine's remote files come from.
 *
 * A host the user named wins outright — that is what naming one means. With no
 * choice made, this deployment is asked whether it carries the machine itself:
 * serving its own images is faster, involves nobody else, and is the only
 * arrangement that works with the network off. Nothing is asked when every file
 * was opened from the user's computer, because then no host is used at all.
 * @param spec - the guest.
 * @param local - the files the user opened, by slot.
 * @returns the base URL to resolve this guest's files against.
 */
async function hostFor(spec: GuestSpec, local: Partial<Record<ImageSlot, File>>): Promise<string> {
  if (imageHostIsChosen() || openedEverything(spec, local)) return imageHost()
  const first = spec.images[0]
  if (first === undefined) return imageHost()
  return await deploymentServes(first.file) ? DEPLOYMENT_IMAGE_HOST : imageHost()
}

/** Do the boot. */
async function start(): Promise<Machine> {
  const mine = generation
  const support = machineSupported()
  if (!support.ok) throw new Error(`the machine cannot start: ${support.reason ?? 'unsupported'}`)
  const spec = machineGuest()
  if (spec === undefined) throw new Error('this session is not configured to run an emulated machine')

  report('Loading the emulator')
  const { V86 } = await import('v86') as unknown as { V86: new (options: Record<string, unknown>) => Emulator }

  const local = await openedImages(spec)
  const host = await hostFor(spec, local)
  // Before anything is fetched or allocated. A guest whose disk this
  // deployment cannot get is not a slow boot, it is a boot that ends in a 404
  // several seconds in, from inside the emulator, naming a URL — and the
  // person reading it has to work out for themselves that the answer is to
  // open a file or point the image host somewhere else. So it is said here,
  // where it is still one sentence.
  const missing = unavailableImages(spec, local, host)
  if (missing.length > 0) {
    throw new Error(
      `${spec.name} needs ${missing.join(', ')}, which the default image host does not serve. `
      + 'Open the image from your computer in Settings → Machine, or point the image host there at one that has it.',
    )
  }

  // Before the emulator exists, because which backend it is constructed with is
  // decided here: a relay that is not answering is swapped for the page's own
  // bridge rather than handed to a guest as a network that silently does
  // nothing. Bounded, cached for the page, and skipped entirely when no relay
  // is configured.
  const route = await resolveRelay()
  if (route.fellBack) report('The configured relay did not answer; using the page\'s own network')

  const screen = createScreen()
  const text = new TextScreen()
  const base = document.baseURI

  const opened = Object.values(local).filter(file => file !== undefined)
  report(opened.length === 0
    ? `Fetching ${spec.name} (${readableSize(spec.transfer)})`
    : `Opening ${spec.name} from ${opened.map(file => file.name).join(' and ')}`)

  const emulator = new V86({
    ...spec.options,
    ...imageOptions(spec, local, host),
    // The wasm and the BIOS ship with this deployment; only the disk comes
    // from elsewhere. Resolved against the document rather than hard-coded, so
    // the build works under a GitHub Pages project path.
    wasm_path: new URL(`${BIOS_BASE}v86.wasm`, base).href,
    bios: { url: new URL(`${BIOS_BASE}seabios.bin`, base).href },
    vga_bios: { url: new URL(`${BIOS_BASE}vgabios.bin`, base).href },
    screen: { container: screen, use_graphical_text: true },
    // The card the guest's own driver expects, wired to whatever Settings →
    // Network says the page is offering. Computed rather than written into the
    // catalog because the backend is a setting and the card is not: upstream's
    // profiles say which machines want VirtIO, and this build says how any of
    // them gets out.
    net_device: netDevice(spec.options),
    // Nothing here plays sound to anyone, and an audio context the browser
    // will not resume without a gesture is a console warning per boot.
    disable_speaker: true,
    // And v86 never listens for keys itself. Its adapter binds to `window` and
    // forwards anything not aimed at an `<input>` or `<textarea>`, and it is
    // built inside the emulator's own async initialisation — so the switch
    // that turns it off cannot be thrown before it is already listening, and
    // calling the setter earlier is a silent no-op against a field that does
    // not exist yet. In a page whose other half is a chat client there is no
    // safe moment for that, so the panel translates key events itself and
    // `Machine.sendKeyEvent` is the only way in.
    disable_keyboard: true,
    autostart: true,
  })

  // Before anything else the machine does, because a guest that sends a DHCP
  // discover in its first second must find the page already listening.
  attachMachineNetwork(emulator as unknown as NetworkedEmulator)

  let graphical = false
  // The guest's own account of its pointer, straight off v86's bus. `mouse-enable`
  // is the guest turning the PS/2 mouse on; `vmware-absolute-mouse` is its driver
  // opening the backdoor port that carries a position instead of a movement.
  const pointer = { enabled: false, absolute: false }
  emulator.add_listener('mouse-enable', ((on: boolean) => { pointer.enabled = on }) as (argument: never) => void)
  emulator.add_listener('vmware-absolute-mouse', ((on: boolean) => { pointer.absolute = on }) as (argument: never) => void)
  emulator.add_listener('screen-set-size', ((size: [number, number, number]) => {
    graphical = size[2] > 0
    if (!graphical) text.resize(size[0], size[1])
  }) as (argument: never) => void)
  emulator.add_listener('screen-put-char', ((put: [number, number, number]) => {
    text.put(put[0], put[1], put[2])
  }) as (argument: never) => void)

  settleTimer = setInterval(() => { text.settle() }, 40)

  const serial = new SerialStream()
  emulator.add_listener('serial0-output-byte', ((byte: number) => { serial.receive(byte) }) as (argument: never) => void)

  const progress = new Map<string, { loaded: number, total: number }>()
  emulator.add_listener('download-progress', ((event: {
    file_name: string, loaded: number, total: number, lengthComputable: boolean
  }) => {
    if (!event.lengthComputable || event.total === 0) return
    progress.set(event.file_name, { loaded: event.loaded, total: event.total })
    let loaded = 0
    let total = 0
    for (const entry of progress.values()) {
      loaded += entry.loaded
      total += entry.total
    }
    report(`Fetching ${spec.name} — ${readableSize(loaded)} of ${readableSize(total)}`)
  }) as (argument: never) => void)

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${spec.name} did not start within ${String(spec.timeoutMs / 1000)} seconds`))
    }, spec.timeoutMs)
    emulator.add_listener('emulator-started', (() => {
      clearTimeout(timer)
      resolve()
    }) as (argument: never) => void)
    emulator.add_listener('download-error', ((event: { file_name: string }) => {
      clearTimeout(timer)
      reject(new Error(
        `${spec.name} could not be fetched: the image host did not serve ${event.file_name}.`
        + ' Open Settings \u2192 Machine and either point the image host at one that has it,'
        + ' or open the file from your computer.',
      ))
    }) as (argument: never) => void)
  }).catch((error: unknown) => {
    clearInterval(settleTimer)
    settleTimer = undefined
    void emulator.destroy().catch(() => undefined)
    screen.remove()
    throw error
  })

  report(`${spec.name} is starting`)

  /**
   * Whether the emulator is currently listening to the mouse at all.
   *
   * Two reasons it might not be. Two machines want their pointer left off
   * outright: v86's own catalog says so, and the reason is a guest driver that
   * mishandles a mouse it never asked for. And a guest with a relative mouse
   * ignores it until somebody asks for it — see {@link Machine.usePointer}.
   *
   * Tracked here rather than read back, because v86 exposes the setter and not
   * the field.
   */
  let mouseOn = spec.mouseDisabled !== true

  /**
   * Hand the mouse to the guest, or take it back.
   *
   * The emulator's adapter listens on `window` and forwards anything over the
   * screen, so a guest with a mouse used to have a cursor that followed yours
   * around the moment the panel was open — including while you were reading
   * the conversation next to it, and including the drift that makes a relative
   * mouse's cursor and yours disagree about where they are. Nothing here is
   * urgent enough to be driven by accident.
   *
   * A machine v86 says wants no mouse never gets one.
   * @param on - whether the guest should receive pointer input.
   */
  const usePointer = (on: boolean): void => {
    const wanted = on && spec.mouseDisabled !== true
    if (wanted === mouseOn) return
    mouseOn = wanted
    emulator.mouse_set_enabled(wanted)
  }
  usePointer(false)

  /**
   * Do something that speaks to the mouse, whoever currently has it.
   *
   * The model's `vm_mouse` and `vm_click` go through the same adapter a hand
   * on a real mouse does, so switching that adapter off to stop the pointer
   * wandering would switch the tools off with it. The adapter is therefore
   * turned on around the dispatch and put back, synchronously, so nothing else
   * can arrive in between.
   * @param act - what to dispatch.
   */
  const asMouse = (act: () => void): void => {
    const held = mouseOn
    if (!held) usePointer(true)
    try {
      act()
    } finally {
      if (!held) usePointer(false)
    }
  }

  live = emulator
  let settledReady = false
  let readyBudget = spec.timeoutMs
  const console_ = new Console(spec, emulator, serial, text, () => graphical)
  const machine: Machine = {
    spec,
    screen,
    ready: async (timeoutMs?: number) => {
      if (settledReady) return true
      settledReady = await awaitReady(
        spec, text, serial, () => graphical, () => { emulator.serial0_send('\r') },
        // The picture itself, as a data URL. What it is used for is two
        // questions that are really one: whether the display has anything on
        // it — a blank one is a few hundred bytes of header, one with a
        // picture on it is thousands — and whether what it has on it is still
        // changing. Sampled at intervals rather than per poll, by the caller.
        () => emulator.screen_make_screenshot()?.src ?? '',
        timeoutMs ?? readyBudget,
      )
      // After one full wait, later callers get a glance rather than the budget.
      readyBudget = 2000
      return settledReady
    },
    screenText: () => ({
      lines: text.lines().map(line => line.replace(/\s+$/, '')),
      cols: text.cols,
      rows: text.rows,
      graphical,
    }),
    transcript: () => text.transcript(),
    type: async (value: string) => {
      await console_.releaseScreen()
      return typeText(emulator, value)
    },
    press: (key: string) => { pressKey(emulator, key) },
    moveMouse: (dx: number, dy: number) => { asMouse(() => { moveMouse(screen, dx, dy) }) },
    button: (which, down) => { asMouse(() => { pressButton(screen, which, down) }) },
    scroll: (dx, dy) => { asMouse(() => { turnWheel(screen, dx, dy) }) },
    click: async (which) => {
      // Held across the gap between press and release, not toggled twice: a
      // button that goes down while the guest is listening and comes up while
      // it is not is a button the guest still thinks is held.
      const held = mouseOn
      if (!held) usePointer(true)
      try {
        pressButton(screen, which, true)
        await new Promise(resolve => setTimeout(resolve, 60))
        pressButton(screen, which, false)
      } finally {
        if (!held) usePointer(false)
      }
    },
    screenshot: async () => screenshot(emulator, graphical),
    graphical: () => graphical,
    pointer: () => ({ ...pointer, held: mouseOn }),
    usePointer,
    sendKeyEvent: (code: string, down: boolean) => {
      const key = CODE_SCANCODES[code]
      if (key === undefined) return false
      const codes: number[] = []
      if (key.extended === true) codes.push(0xE0)
      codes.push(down ? key.code : release(key.code))
      emulator.keyboard_send_scancodes(codes)
      return true
    },
    console: console_,
  }
  if (mine !== generation) {
    // Thrown away while this boot was still fetching. Finish tearing it down
    // rather than becoming the live machine several seconds after the restart.
    await emulator.destroy().catch(() => undefined)
    screen.remove()
    throw new Error('the machine was restarted while it was starting')
  }
  // Cleared only now: a boot that succeeded is not a machine that failed, and
  // a stale message here is what the panel would keep showing after a retry.
  bootFailure = undefined
  watchers.clear()
  lastStep = undefined
  settled = machine
  return machine
}

/**
 * The serial port, buffered.
 *
 * One growing string plus a coalescing notifier: a guest printing a kernel log
 * emits a byte at a time, and waking every subscriber per byte is what makes
 * an attached terminal stutter on a machine that is otherwise keeping up.
 */
class SerialStream {
  /**
   * Bytes become text through a streaming UTF-8 decoder.
   *
   * `String.fromCharCode(byte)` reads the wire as Latin-1, which is right for
   * a DOS console and wrong for every guest since: Arch prints UTF-8, and one
   * byte to one code point turns every non-ASCII character in a command's
   * output into two pieces of mojibake. Streaming, because a character can
   * straddle two arrivals — a decoder restarted per byte would mangle exactly
   * the characters it exists to get right.
   */
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private text = ''
  /**
   * How many characters have been dropped off the front.
   *
   * Offsets handed out by {@link length} are absolute — counted from the first
   * byte the guest ever sent, not from the start of the buffer. They have to
   * be: a command records an offset before it runs and reads from it when it
   * finishes, and a long-running command can overrun the buffer in between. An
   * offset into a window that has since slid is how a command's output comes
   * back missing its first half with nothing saying so.
   */
  private dropped = 0
  private listeners = new Set<(chunk: string) => void>()
  private pending = ''
  private flush: ReturnType<typeof setTimeout> | undefined

  /** Take one byte from the guest. */
  receive(byte: number): void {
    const character = this.decoder.decode(new Uint8Array([byte]), { stream: true })
    if (character === '') return
    this.text += character
    if (this.text.length > SERIAL_LIMIT) {
      this.dropped += this.text.length - SERIAL_LIMIT
      this.text = this.text.slice(-SERIAL_LIMIT)
    }
    this.pending += character
    this.flush ??= setTimeout(() => {
      const chunk = this.pending
      this.pending = ''
      this.flush = undefined
      for (const listener of this.listeners) listener(chunk)
    }, 8)
  }

  /** How much has been received, counted from the first byte ever sent. */
  get length(): number {
    return this.dropped + this.text.length
  }

  /** Everything from `offset` onwards, of what is still held. */
  since(offset: number): string {
    return this.text.slice(Math.max(0, offset - this.dropped))
  }

  /** Whether everything from `offset` is still held, or some of it has gone. */
  holds(offset: number): boolean {
    return offset >= this.dropped
  }

  /** Watch the stream; returns a disposer. */
  subscribe(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * How long to wait for a DHCP client to finish.
 *
 * Measured at about a second on Buildroot with the page answering the lease,
 * and a little more on Arch, which loads a driver first. The budget is well
 * above both because the alternative to waiting is a first command that runs
 * while the DHCP client is still printing into the same console.
 */
const NETWORK_UP_MS = 25_000

/**
 * How long a serial write waits between chunks.
 *
 * The emulated UART accepts bytes faster than DOS reads them out of its
 * console handler, and what that looks like from the outside is a command
 * arriving with characters missing. Chunked and paced, it does not happen.
 */
const SERIAL_CHUNK = 32
const SERIAL_CHUNK_DELAY_MS = 10

/**
 * The guest's command channel.
 *
 * Two guests, one interface. A serial guest already has a shell on the wire; a
 * DOS guest has one on the screen, and `CTTY COM1` — a DOS command since
 * version 2 — puts it on the wire too. That single command is the difference
 * between reading a command's whole output and reading whatever of it had not
 * scrolled off an 80×25 screen.
 *
 * DOS is driven by typing at it and reading its screen back, and not by
 * `CTTY COM1`. The redirect is a documented DOS command and it does work on
 * FreeDOS — but on both MS-DOS guests here it half-works and cannot be undone:
 * the console moves, DOS writes a bare CR LF to the serial port and then never
 * reads or writes it again, the screen is frozen and the keyboard ignored, and
 * the guest is unreachable until it is rebooted. Measured, after shipping it.
 *
 * Typing costs about eighty characters a second and DOS wraps at the eightieth
 * column. It does not cost completeness: the transcript this module keeps
 * captures rows as they scroll off the screen, so a command's whole output
 * comes back either way.
 */
class Console implements MachineConsole {
  /** Whether a serial guest has been logged in and settled. */
  private prepared = false
  /** Whether a DOS guest's console has been moved onto the serial port. */
  private onSerial = false
  /** Serialises commands: two at once on one console is two interleaved commands. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Distinguishes one command's marker from the next. */
  private counter = 0
  /** How much of a file is delivered per console line. */
  private static readonly TRANSFER_CHUNK = 512

  constructor(
    private readonly spec: GuestSpec,
    private readonly emulator: Emulator,
    private readonly serial: SerialStream,
    private readonly text: TextScreen,
    private readonly graphical: () => boolean,
  ) {}

  /** Whether this guest has a command channel at all. */
  get available(): boolean {
    return this.spec.console !== 'gui'
  }

  read(offset = 0): { text: string, next: number } {
    return { text: this.serial.since(offset), next: this.serial.length }
  }

  write(value: string): void {
    this.emulator.serial0_send(value)
  }

  subscribe(listener: (chunk: string) => void): () => void {
    return this.serial.subscribe(listener)
  }

  async putFile(path: string, content: string): Promise<{ expected: number, reported: number | null }> {
    if (this.spec.console !== 'serial') {
      throw new Error(`${this.spec.name} has no shell to deliver a file through; build it with \`echo … >\` instead`)
    }
    // Quoted, everywhere it is spliced into a command below. A path is a
    // string the model chose, and `/tmp/my notes.txt` splicing into `wc -c <
    // /tmp/my notes.txt` is the mild version of what goes wrong.
    const quoted = shellQuote(path)
    await this.putPosixFile(quoted, content)
    // Read the size back rather than claiming success: a console transfer is
    // the one place a dropped character is both possible and invisible, and a
    // file that is quietly a byte short is a bug that gets chased in the wrong
    // place.
    const check = await this.run(`wc -c < ${quoted}`, { timeoutMs: 30_000 })
    const reported = /(\d+)/.exec(check.output.replace(/\s+/g, ' '))
    return {
      expected: new TextEncoder().encode(content).length,
      reported: reported === null ? null : Number(reported[1]),
    }
  }

  /**
   * Deliver a file to a POSIX guest as escaped `printf` appends.
   * @param quoted - the destination, already shell-quoted.
   * @param content - the file's text.
   */
  private async putPosixFile(quoted: string, content: string): Promise<void> {
    const cleared = await this.run(`rm -f ${quoted} && : > ${quoted}`, { timeoutMs: 30_000 })
    if (cleared.exitCode !== 0) {
      // Not `!== null && !== 0`: a `null` status here is a command that timed
      // out, and carrying on to append four hundred chunks to a file that was
      // never created is how a transfer "succeeds" into nothing.
      throw new Error(`the guest did not create ${quoted}: ${cleared.output.trim() || 'the command did not finish'}`)
    }
    // Split by code point, not by UTF-16 unit: a chunk boundary through the
    // middle of an astral character encodes half a surrogate pair, and what
    // arrives on the guest is two replacement characters.
    const points = [...content]
    for (let index = 0; index < points.length; index += Console.TRANSFER_CHUNK) {
      const chunk = points.slice(index, index + Console.TRANSFER_CHUNK).join('')
      const result = await this.run(`printf '${octalEscape(chunk)}' >> ${quoted}`, { timeoutMs: 60_000 })
      if (result.exitCode !== 0) {
        throw new Error(`the guest refused the write at character ${String(index)}: `
          + (result.output.trim() || 'the command did not finish'))
      }
    }
  }

  /**
   * Run one command by typing it and reading the screen back.
   *
   * The same two markers and the same parsing as the serial path — the only
   * differences are that the bytes go in through the keyboard and come back
   * out of the mirrored text screen, including the rows that have scrolled off
   * it. That is what makes this a real channel rather than a consolation
   * prize: a `dir` of a full directory comes back whole.
   *
   * What it does cost is real and is stated in the tool description: a
   * keyboard types at about eighty characters a second, DOS wraps a line at
   * the eightieth column so a long line comes back split, and a full-screen
   * program still cannot be driven this way.
   * @param command - what to run.
   * @param options - timeout and cancellation.
   * @returns the command's output and, where DOS reports one, its ERRORLEVEL.
   */
  private async executeOnScreen(
    command: string,
    options: { timeoutMs?: number, signal?: AbortSignal },
  ): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 120_000
    const marker = `DSHV86${String(this.counter++).padStart(3, '0')}`
    const lines = [
      `echo ${marker}S`,
      ...command.split('\n').map(line => line.trimEnd()),
      // A blank line before the marker, because the marker is recognised at
      // the start of a line and the command before it may not have ended one.
      // `type` on a file with no final newline leaves the cursor mid-line, the
      // marker lands on the end of the output, and nothing ever matches it —
      // so the command runs to its timeout with its answer already on screen.
      'echo.',
      `echo ${marker}E%ERRORLEVEL%`,
    ]
    for (const line of lines) await typeText(this.emulator, `${line}\r`)

    const began = new RegExp(`^${marker}S\\s*$`, 'm')
    // Anything, including nothing. `%ERRORLEVEL%` is a CMD.EXE variable, not a
    // DOS one: FreeCOM implements it, and MS-DOS's COMMAND.COM looks it up in
    // the environment, does not find it, and expands it to the empty string —
    // so the end marker arrives as a bare `…E`. A pattern that demanded digits
    // or the literal `%ERRORLEVEL%` matched neither, and every MS-DOS command
    // ran to its timeout while its output sat there complete.
    const done = new RegExp(`^${marker}E(\\S*)`, 'm')
    // The whole transcript, not a slice of it. The obvious thing — record the
    // transcript's length before typing and read from there afterwards — is
    // wrong for the case that matters most: a command whose output fits on the
    // screen never scrolls, so no row leaves the top, the transcript's length
    // does not change, and the slice comes back empty. `ver` returned nothing
    // and `dir` returned only the part that had scrolled. The markers are
    // unique per command, so there is no need to guess where to start reading:
    // they say.
    const since = (): string => this.text.transcript().join('\n')
    const found = await waitFor(() => done.test(since()), timeoutMs, options.signal)
    const raw = since()
    const match = done.exec(raw)
    if (!found || match === null) {
      // Ctrl+C on the keyboard, for the same reason the serial path sends one:
      // a command still holding the console eats the next one as its input.
      this.emulator.keyboard_send_scancodes([MODIFIERS.ctrl, 0x2E, release(0x2E), release(MODIFIERS.ctrl)])
      await new Promise(resolve => setTimeout(resolve, 700))
      await typeText(this.emulator, '\r')
      return { output: cleanConsole(raw, began, marker, this.spec.prompts), exitCode: null, timedOut: true }
    }
    const status = match[1]
    return {
      output: cleanConsole(raw.slice(0, match.index), began, marker, this.spec.prompts),
      // A number is an ERRORLEVEL; an empty tail or an unexpanded
      // `%ERRORLEVEL%` is this DOS not having one to give.
      exitCode: /^\d+$/.test(status) ? Number(status) : null,
      timedOut: false,
    }
  }

  async releaseScreen(): Promise<void> {
    // Only a guest whose console was moved has anything to bring back. The
    // ones driven from the screen never left it.
    if (!this.onSerial) return
    this.onSerial = false
    await this.sendLine('ctty con')
    await waitFor(() => this.atDosPrompt(), 5000)
  }

  /** Whether a DOS prompt is on the text screen right now. */
  private atDosPrompt(): boolean {
    if (this.graphical()) return false
    const prompts = this.spec.prompts ?? []
    return this.text.lines().some(line => prompts.some(prompt => line.trimStart().startsWith(prompt)))
  }

  /** Whether the serial console is sitting at a prompt. */
  private atSerialPrompt(): boolean {
    const tail = withoutControlSequences(this.serial.since(Math.max(0, this.serial.length - 400)))
    return /(?:[#$%>]|:\\>) ?$/.test(tail.trimEnd() + ' ')
  }

  /** Send one line to the guest's console, paced so nothing is dropped. */
  private async sendLine(line: string): Promise<void> {
    const payload = `${line}\r`
    for (let index = 0; index < payload.length; index += SERIAL_CHUNK) {
      this.emulator.serial0_send(payload.slice(index, index + SERIAL_CHUNK))
      if (payload.length > SERIAL_CHUNK) await new Promise(resolve => setTimeout(resolve, SERIAL_CHUNK_DELAY_MS))
    }
  }

  /**
   * Make sure there is a shell listening on the serial port.
   *
   * For a serial guest that means answering the login prompt once. For a DOS
   * guest it means typing `CTTY COM1` on the *keyboard*, because until it has
   * been typed the serial port is not the console and nothing sent there is
   * read.
   */
  private async attach(): Promise<void> {
    if (this.spec.console === 'serial') {
      if (this.prepared) return
      // The guest's own banner first, and with the guest's own budget. A
      // command issued while the machine is still booting is the normal case
      // — the page starts it and the model reaches for it a moment later — and
      // waiting a fixed twenty seconds is how a guest that takes forty gets
      // told its console did not answer.
      const banner = this.spec.banner === undefined ? undefined : new RegExp(this.spec.banner)
      if (banner !== undefined) await waitFor(() => banner.test(this.serial.since(0)), this.spec.timeoutMs)
      const login = this.spec.login
      if (login !== undefined && this.serial.since(0).includes(login.ask)) {
        this.write(login.send)
        await waitFor(() => this.atSerialPrompt(), 20_000)
      }
      // A bare newline draws a prompt out of a shell that has been quiet since
      // boot, which is what tells us the far end is listening at all.
      this.write('\n')
      const ready = await waitFor(() => this.atSerialPrompt(), 20_000)
      if (!ready) throw new Error('the guest\'s serial console did not answer; it may still be booting')
      this.prepared = true
      await this.bringUpNetwork()
      return
    }

    // The same budget, for the same reason: MS-DOS 7 takes forty-three seconds
    // to reach its prompt, measured, and a fixed thirty here would have made
    // the first command of every fresh session on it fail.
    if (!await waitFor(() => this.atDosPrompt(), this.spec.timeoutMs)) {
      throw new Error('the guest is not at a DOS prompt; look at the screen with vm_screen before running a command')
    }
    this.prepared = true
    if (this.spec.serialConsole !== true || this.onSerial) return
    await typeText(this.emulator, 'ctty com1\r')
    if (!await waitFor(() => this.atSerialPrompt(), 8000)) {
      throw new Error('CTTY COM1 did not put this guest\'s console on the serial port; the machine may need restarting')
    }
    this.onSerial = true
  }

  /**
   * Ask for a DHCP lease, once, before the first command runs.
   *
   * A card with no address is a card that does nothing, and on the guests that
   * need this there is no `init` script that asks: v86's own demo expects a
   * person to type `udhcpc`. A model would have to know that, on this machine,
   * before its first `wget` — so the console does it while it is attaching,
   * where the second it costs is spent inside a wait the caller was already
   * doing.
   *
   * Sent down the wire directly rather than through {@link Console.run},
   * because this runs *inside* `attach()`, which `run` is waiting on: asking
   * the queue for a slot from in here is a deadlock. Failure is deliberately
   * quiet. A guest whose lease does not arrive is a guest whose `wget` will say
   * so in its own words, which is a better error than one this method could
   * invent, and a machine that boots slightly slower because the page's network
   * is off would be a worse trade than a command that fails once.
   */
  private async bringUpNetwork(): Promise<void> {
    const up = this.spec.network?.bring === 'dhcp' ? this.spec.network.up : undefined
    if (up === undefined || !machineNetworkConfig().enabled) return
    try {
      await this.sendLine(up)
      await waitFor(() => this.atSerialPrompt(), NETWORK_UP_MS)
    } catch {
      // The console is attached either way; this was an offer, not a step.
    }
  }

  async run(command: string, options: { timeoutMs?: number, signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (!this.available) throw new Error(`${this.spec.name} has no command console; drive it with vm_type, vm_key and vm_screenshot`)
    // Queued rather than concurrent: one console, one command at a time, or
    // two commands' output interleave into something neither of them said.
    const run = this.queue.then(async () => this.execute(command, options))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Run one command, with the console already attached. */
  private async execute(command: string, options: { timeoutMs?: number, signal?: AbortSignal }): Promise<CommandResult> {
    await this.attach()
    // A DOS guest whose console cannot be moved is typed at instead. Which of
    // the two it is comes from the catalog, because finding out by trying it
    // costs the machine — see `GuestSpec.serialConsole`.
    if (this.spec.console === 'dos' && this.spec.serialConsole !== true) {
      return this.executeOnScreen(command, options)
    }
    const timeoutMs = options.timeoutMs ?? 120_000
    const marker = `DSHV86${String(this.counter++).padStart(3, '0')}`
    const start = this.serial.length
    const lines = this.spec.console === 'serial'
      ? serialInvocation(command, marker)
      // `echo.` for the same reason as the screen path: the marker is matched
      // at the start of a line, and a command whose output has no final
      // newline would otherwise leave it in the middle of one.
      : [`echo ${marker}S`, ...command.split('\n').map(line => line.trimEnd()), 'echo.', `echo ${marker}E%ERRORLEVEL%`]
    for (const line of lines) await this.sendLine(line)

    // Two markers, and the output is what lies between them.
    //
    // The obvious alternative — drop the line the guest echoed back and keep
    // the rest — worked until a command needed escaping: the octal `printf`
    // that carries an awkward command is several hundred characters, and a
    // console echoes a line that long back across more than one line. Then the
    // "line that ends with what was sent" is not a line at all, and the whole
    // wrapper lands in the model's result. A marker the guest *prints* has no
    // such problem, because printing is not echoing.
    //
    // Both patterns are anchored at the start of a line, which is where only
    // the guest's own output puts them: on DOS the echo of `echo DSH…S` begins
    // with `echo`, and on a serial guest the marker is split across two quoted
    // strings so the echo does not contain it at all.
    const began = new RegExp(`^${marker}S\\s*$`, 'm')
    // A POSIX shell needs no line anchor and must not have one. `serialInvocation`
    // splits the marker across two quoted strings, so the echo of the command
    // contains `DSH""V86…E` and never the marker itself — which is what makes
    // the marker unambiguous wherever it appears. Anchoring it as well meant a
    // command whose output had no trailing newline printed the marker onto the
    // end of that output, matched nothing, and ran to its timeout with the
    // answer already on the wire: `cat` of a file without a final newline is
    // the ordinary case of that, not an exotic one.
    const done = this.spec.console === 'serial'
      ? new RegExp(`${marker}E(\\d+)`)
      : new RegExp(`^${marker}E(\\d+|%ERRORLEVEL%)`, 'm')
    const found = await waitFor(() => done.test(this.serial.since(start)), timeoutMs, options.signal)
    const raw = this.serial.since(start)
    // A megabyte is a lot of console output and a guest can still exceed it.
    // Saying so is the whole point: the tool description promises the model a
    // command's *whole* output, and the one case where that stops being true
    // has to arrive as a sentence rather than as a quietly shorter answer.
    const lost = !this.serial.holds(start)
    const match = done.exec(raw)
    const note = lost ? '[earlier output was dropped: this command printed more than the console keeps]\n' : ''
    if (!found || match === null) {
      // Interrupt whatever is still holding the console before giving up. A
      // command that outran its budget has the guest's attention, and the next
      // command sent to a console that is still reading input is not a command
      // — it is more input, and the session never recovers. Ctrl+C is what a
      // person at the keyboard would send, and it costs a second.
      this.write('\u0003')
      await new Promise(resolve => setTimeout(resolve, 700))
      this.write('\r')
      await new Promise(resolve => setTimeout(resolve, 300))
      return { output: note + cleanConsole(raw, began, marker, this.spec.prompts), exitCode: null, timedOut: true }
    }
    const status = match[1]
    return {
      output: note + cleanConsole(raw.slice(0, match.index), began, marker, this.spec.prompts),
      // `%ERRORLEVEL%` comes back unexpanded on the DOS versions whose command
      // interpreter does not substitute it at the prompt. That is reported as
      // "no exit status" rather than as zero, which would be a made-up success.
      exitCode: /^\d+$/.test(status) ? Number(status) : null,
      timedOut: false,
    }
  }
}

/**
 * Wrap a value so a POSIX shell reads it as exactly one argument.
 *
 * Single quotes, with any single quote in the value closed, escaped and
 * reopened — the only quoting a POSIX shell has that is total. Every path this
 * module splices into a command goes through it, because a path is a string
 * the model chose and `/tmp/my notes.txt` is the mild version of what that can
 * be.
 * @param value - the text to quote.
 * @returns the quoted form, single quotes and all.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

/**
 * Escape text so a POSIX `printf` reproduces it byte for byte.
 *
 * Everything outside printable ASCII, and the three characters `printf` and the
 * shell would otherwise read as syntax, become octal escapes. What comes out is
 * one physical line whatever went in, which is the property that matters: a
 * console is line-oriented, and a payload spread over several lines is several
 * echoes to tell apart from output.
 * @param text - what to deliver.
 * @returns the format string, without its quotes.
 */
function octalEscape(text: string): string {
  let escaped = ''
  for (const character of text) {
    const bytes = new TextEncoder().encode(character)
    escaped += bytes.length === 1 && bytes[0] >= 32 && bytes[0] < 127 && !'\\%\''.includes(character)
      ? character
      : [...bytes].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('')
  }
  return escaped
}

/**
 * The one line a serial guest is sent to run a command.
 *
 * One line, whatever the command looks like, because the guest echoes back
 * what it was sent and a command spread over several lines is several echoes
 * to tell apart from output. Anything with a newline or a quote in it is
 * delivered as an octal-escaped `printf` piped into a shell, which survives
 * every character a command can contain and needs nothing installed —
 * `printf` is a shell builtin.
 *
 * Both markers are split across two adjacent quoted strings, so the echo of
 * this very line cannot be mistaken for the markers the shell later prints —
 * and the first of them is what tells the reader where the echo ended, which
 * is the only reliable answer when the echo is a wrapped four-hundred-character
 * `printf`.
 * @param command - what the model asked to run.
 * @param marker - the completion marker.
 * @returns the lines to send.
 */
function serialInvocation(command: string, marker: string): string[] {
  // `#` and a trailing `&` join the list of characters that force the wrapper:
  // a comment swallows everything after it on the line — including the marker
  // the reader is waiting for — and a backgrounded command turns `cmd & ; echo`
  // into a syntax error. Both leave the command apparently hanging until it
  // times out, which is the worst way for a shell tool to be wrong.
  const simple = !/['\n\\#]/.test(command) && !/&\s*$/.test(command)
  const head = marker.slice(0, 3)
  const tail = marker.slice(3)
  const prefix = `echo "${head}""${tail}S"; `
  const suffix = `; echo "${head}""${tail}E$?"`
  const body = simple ? command : `printf '${octalEscape(command)}' | sh`
  return [`${prefix}${body}${suffix}`]
}

/**
 * Strip the guest's own echo and the trailing marker command from a capture.
 *
 * A console echoes what it was sent, so the first line of every capture is the
 * command coming back — matched against what was actually sent rather than
 * assumed, so a guest that does not echo keeps its first line of output. The
 * marker command's echo arrives at the other end, after the output, and is
 * recognised by the marker in it.
 *
 * Line endings are normalised on the way through: a serial console writes
 * CR LF, and leaving that in means every line of every result carries a
 * stray carriage return into the transcript.
 * @param raw - what arrived on the console.
 * @param sent - the first line that was sent, for recognising the echo.
 * @param marker - the completion marker, for recognising its echo.
 * @returns the command's output.
 */
function cleanConsole(raw: string, began: RegExp, marker: string, prompts?: string[]): string {
  let lines = withoutControlSequences(raw).replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  // Everything up to and including the line the guest printed to say it was
  // starting. When that line never arrived — a command that timed out before
  // its first marker — nothing is dropped, because there is nothing that can
  // be identified as the echo and guessing would eat real output.
  const startedAt = lines.findIndex(line => began.test(line))
  if (startedAt !== -1) lines.splice(0, startedAt + 1)
  // DOS has no way to run two things on one line, so each command in a request
  // is sent separately and each comes back behind a prompt: `A:\>type readme`.
  // Those are the guest repeating what it was told, not what it found, and a
  // line of DOS output never begins with a drive prompt.
  if (prompts !== undefined) {
    lines = lines.filter(line => !prompts.some(prompt => line.trimStart().startsWith(prompt)))
  }
  // The blank line a console leaves between a prompt and what follows it is
  // framing, not output. Trimmed from the front as well as the back, so the
  // first line of a result is the first line the command printed.
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last.trim() !== '' && !last.includes(marker)) break
    lines.pop()
  }
  return lines.join('\n')
}

/**
 * Poll until a condition holds.
 * @param condition - re-evaluated every 100 ms.
 * @param timeoutMs - how long to wait.
 * @param signal - cancels the wait.
 * @returns whether it held before the deadline.
 */
async function waitFor(condition: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return false
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return condition()
}

/** How often the readiness check looks at the picture. */
const SAMPLE_MS = 2000

/**
 * Wait until the guest has reached its own readiness marker.
 *
 * Each profile has a different answer to "has it finished booting", and none
 * of them is "the emulator is running" — that is true a few hundred
 * milliseconds in, while the BIOS is still counting memory.
 *
 * - A DOS guest is ready when a line on screen starts with a prompt.
 * - A serial guest is ready when its console has printed its banner — or, if
 *   it never prints one, when it answers a newline with a prompt. A guest that
 *   resumed from a saved machine said everything it had to say before the save
 *   and will sit there silently forever; poking it is the only way to find out
 *   whether anything is listening.
 * - A graphical guest is ready when it is drawing pixels and its display mode
 *   has stopped changing — or, failing that, when the picture itself has held
 *   still for twenty seconds, because a machine upstream calls graphical may
 *   stop at a text prompt and never enter the mode at all. That is *not* the
 *   same as "the desktop is up": a cold Windows 95 reaches a static 320×400
 *   splash in six seconds and its desktop a minute later, and both satisfy
 *   this. Everything downstream is told to look at the screen rather than
 *   trust the marker, and this is why.
 *
 * A timeout is reported rather than thrown: the machine is running either way,
 * and a caller that can look at the screen is better served by a screenshot of
 * whatever it is stuck on than by an exception.
 * @returns whether the marker was reached.
 */
async function awaitReady(
  spec: GuestSpec,
  text: TextScreen,
  serial: SerialStream,
  graphical: () => boolean,
  poke: () => void,
  picture: () => string,
  timeoutMs?: number,
): Promise<boolean> {
  const banner = spec.banner === undefined ? undefined : new RegExp(spec.banner)
  let stableSince = 0
  let lastShape = ''
  let lastPoke = 0
  let lastSample = 0
  /** Recent pictures, newest last, one every {@link SAMPLE_MS}. */
  const samples: string[] = []

  /** Whether the display has anything on it. */
  const painted = (): boolean => picture().length > 3000

  /**
   * Whether the picture itself has stopped changing, and has something on it.
   *
   * The mode-shape check above cannot tell a machine that is still booting in
   * text mode from one that has arrived at a text prompt: both are `80x25` and
   * neither changes shape. This can, because a boot writes to the screen and a
   * prompt does not.
   *
   * "Stopped changing" is two frames rather than one, because a text-mode
   * prompt has a cursor and the cursor blinks: a settled screen alternates
   * between exactly two pictures thirteen bytes apart, forever, and an
   * equality test against the previous frame therefore never holds. A boot
   * that is still writing produces a new picture nearly every time.
   *
   * Sampled at intervals rather than per poll — a screenshot is a canvas read
   * and a PNG encode, and this runs for minutes.
   * @param seconds - how long the picture must have held still.
   * @returns whether the display has been showing the same thing that long.
   */
  const settled = (seconds: number): boolean => {
    const now = Date.now()
    if (now - lastSample >= SAMPLE_MS) {
      lastSample = now
      samples.push(picture())
    }
    const wanted = Math.ceil((seconds * 1000) / SAMPLE_MS)
    if (samples.length < wanted) return false
    const window = samples.slice(-wanted)
    const last = window[window.length - 1]
    return last.length > 3000 && new Set(window).size <= 2
  }
  return waitFor(() => {
    // A DOS machine whose prompt has been watched is ready when it shows it.
    // One whose prompt nobody here has seen falls through to the general rule
    // below rather than being held against a guessed pattern: every DOS
    // version spells its prompt differently, and a machine sitting at a
    // perfectly good `A>` should not be reported as never having started.
    const prompts = spec.prompts
    if (spec.console === 'dos' && prompts !== undefined) {
      return text.lines().some(line => prompts.some(prompt => line.trimStart().startsWith(prompt)))
    }
    if (spec.console === 'serial') {
      if (banner !== undefined && banner.test(serial.since(0))) return true
      if (Date.now() - lastPoke > 4000) {
        lastPoke = Date.now()
        poke()
      }
      return false
    }
    const shape = `${String(graphical())}:${String(text.cols)}x${String(text.rows)}`
    if (shape !== lastShape) {
      lastShape = shape
      stableSince = Date.now()
    }
    if (stableSince === 0 || Date.now() - stableSince <= 2000) return false
    // A machine whose screen ends up graphical is not up until it is drawing
    // pixels. It passes through a perfectly settled text screen on the way —
    // a BIOS line, a boot menu — and two of them were reported ready while
    // still sitting in DOS.
    const ends = spec.screen ?? (spec.console === 'gui' ? 'graphical' : 'text')
    if (ends === 'graphical') {
      if (graphical()) return true
      // Upstream's table says what a machine *is*, not what its screen is
      // doing: five of the machines it marks graphical stop in text mode and
      // wait for a keypress — 9legacy asks where root is, and the rest sit at
      // a prompt of their own — and holding them to a mode they never enter
      // spent their whole budget with the answer on the screen. So the mode is
      // required only while there is any reason to believe the machine is
      // still working: three quarters of a minute of an unchanging picture is
      // a machine that has arrived somewhere, whatever mode it arrived in.
      //
      // Three quarters and not twenty seconds because a boot can be quiet for
      // a while and still be a boot: Skift spends about forty-five seconds on
      // a motionless text screen before its desktop appears, and at twenty it
      // was called ready while still loading.
      return settled(45)
    }
    // Two seconds without a mode change. A boot changes mode several times on
    // the way; a machine that has arrived somewhere does not.
    //
    // "Arrived" used to mean "is drawing pixels", and that was wrong for most
    // of the catalog: a great many of these machines never leave text mode —
    // a bootsector game, MikeOS, MS-DOS 4 — and waited out their whole budget
    // with a full screen in front of them, reported as never having started.
    // What settles it is that the screen has stopped changing *and* has
    // something on it, whichever kind of screen it is.
    if (graphical()) return true
    if (text.lines().some(line => line.trim() !== '')) return true
    // A machine that writes straight to video memory — a bootsector game, most
    // of the small ones — produces no `put-char` events at all, so the text
    // mirror is empty while the screen is full. Asking the screen itself is the
    // only way to tell that apart from a machine that never started, and it is
    // asked once, here, after the display has already stopped changing.
    return painted()
  }, timeoutMs ?? spec.timeoutMs)
}

/** Send one key down and up, with any modifiers held around it. */
function pressKey(emulator: Emulator, key: string): void {
  // Split on `+` except a trailing one, which is the key itself: `Ctrl++` is
  // control and the plus key, and dropping empty parts turned it into `Ctrl`
  // held down over nothing.
  const trailing = key.trimEnd().endsWith('+')
  const parts = key.trimEnd().slice(0, trailing ? -1 : undefined)
    .split('+').map(part => part.trim().toLowerCase()).filter(part => part.length > 0)
  if (trailing) parts.push('+')
  if (parts.length === 0) throw new Error('invalid key: expected something like `Enter`, `Ctrl+C`, or `Alt+Enter`')
  const name = parts[parts.length - 1]
  const held: number[] = []
  for (const modifier of parts.slice(0, -1)) {
    const code = MODIFIERS[modifier]
    if (code === undefined) throw new Error(`unknown modifier \`${modifier}\`: expected ctrl, alt, or shift`)
    held.push(code)
  }
  const codes: number[] = [...held]
  const named = NAMED_KEYS[name]
  if (named !== undefined) {
    if (named.extended === true) codes.push(0xE0)
    codes.push(named.code)
    if (named.extended === true) codes.push(0xE0)
    codes.push(release(named.code))
  } else {
    const single = characterCode(name)
    if (single === undefined) {
      throw new Error(`unknown key \`${name}\`: use a single character or one of ${KEY_NAMES.join(', ')}`)
    }
    if (single.shift) codes.push(MODIFIERS.shift)
    codes.push(single.code, release(single.code))
    if (single.shift) codes.push(release(MODIFIERS.shift))
  }
  for (const modifier of [...held].reverse()) codes.push(release(modifier))
  emulator.keyboard_send_scancodes(codes)
}

/** The scan code for one printable character, and whether it needs Shift. */
function characterCode(character: string): { code: number, shift: boolean } | undefined {
  if (character === ' ') return { code: 0x39, shift: false }
  if (character === '\t') return { code: 0x0F, shift: false }
  if (character === '\n' || character === '\r') return { code: 0x1C, shift: false }
  const plain = UNSHIFTED.indexOf(character)
  if (plain !== -1 && ROW_CODES[plain] !== 0) return { code: ROW_CODES[plain], shift: false }
  const shifted = SHIFTED.indexOf(character)
  if (shifted !== -1 && ROW_CODES[shifted] !== 0) return { code: ROW_CODES[shifted], shift: true }
  return undefined
}

/**
 * How long the keyboard controller is given between characters.
 *
 * The emulated 8042 has a one-byte output buffer and DOS reads it from an
 * interrupt handler. Typing a line in one burst overruns it and drops
 * characters — which looks, from the outside, like a command arriving with
 * letters missing. This is above the rate at which any shipped guest loses a
 * character and below the point where typing a command is noticeable.
 */
const TYPE_DELAY_MS = 12

/**
 * Type text, one character at a time, at a rate the guest keeps up with.
 * @param emulator - the running emulator.
 * @param value - the text to type.
 * @returns the characters a US keyboard has no key for, which were not typed.
 */
async function typeText(emulator: Emulator, value: string): Promise<string[]> {
  const skipped: string[] = []
  for (const character of value) {
    const single = characterCode(character)
    // A keyboard has the keys it has. `é`, `€` and every other character
    // outside the US layout cannot be typed on one, and reporting what went
    // unsent is the difference between a command the guest received wrong and
    // a caller who knows why.
    if (single === undefined) {
      skipped.push(character)
      continue
    }
    const codes: number[] = []
    if (single.shift) codes.push(MODIFIERS.shift)
    codes.push(single.code, release(single.code))
    if (single.shift) codes.push(release(MODIFIERS.shift))
    emulator.keyboard_send_scancodes(codes)
    await new Promise(resolve => setTimeout(resolve, TYPE_DELAY_MS))
  }
  return skipped
}

/**
 * Move the pointer by a delta.
 *
 * The emulated mouse is a PS/2 mouse, and a PS/2 mouse reports movement, not
 * position — there is no "move to (x, y)" to send, because a real one cannot
 * say that either. How far a delta moves the pointer is then up to the guest's
 * own driver: Windows 3.1 at 1024×768 moves about two pixels per unit,
 * measured. That is why the tool that wraps this reports units rather than
 * pixels and tells the model to look before it clicks.
 *
 * The events go to the canvas because that is what v86's mouse adapter listens
 * on, and dispatching them there is exactly what a hand on a real mouse
 * produces. `movementY` is not negated: the adapter flips it on the way to the
 * device, so a positive value moves the pointer down.
 * @param screen - the screen container.
 * @param dx - horizontal movement.
 * @param dy - vertical movement.
 */
function moveMouse(screen: HTMLElement, dx: number, dy: number): void {
  const target = screen.getElementsByTagName('canvas')[0] ?? screen
  target.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, cancelable: true, view: window, movementX: dx, movementY: dy,
  }))
}

/**
 * Turn the wheel over the screen.
 *
 * v86's adapter reads `wheelDelta` and reduces it to one notch per event in
 * whichever direction it points, so the magnitude here decides the sign and
 * nothing else; a caller wanting three notches sends three events. `deltaY` is
 * set too, because that is the property a modern listener reads and the
 * adapter's fallback path uses `detail`.
 * @param screen - the screen container.
 * @param dx - horizontal notches; positive is right.
 * @param dy - vertical notches; positive is down.
 */
function turnWheel(screen: HTMLElement, dx: number, dy: number): void {
  const target = screen.getElementsByTagName('canvas')[0] ?? screen
  const event = new WheelEvent('wheel', {
    bubbles: true, cancelable: true, view: window, deltaX: dx, deltaY: dy, deltaMode: 0,
  })
  // `wheelDelta` is the legacy property v86 reads first and it is not settable
  // through the constructor. Its sign is the opposite of `deltaY`'s.
  Object.defineProperty(event, 'wheelDelta', { value: -dy * 120, configurable: true })
  Object.defineProperty(event, 'detail', { value: dy, configurable: true })
  target.dispatchEvent(event)
}

/** Press or release a mouse button on the screen element. */
function pressButton(screen: HTMLElement, which: 'left' | 'middle' | 'right', down: boolean): void {
  const target = screen.getElementsByTagName('canvas')[0] ?? screen
  const button = which === 'left' ? 0 : which === 'middle' ? 1 : 2
  target.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', {
    bubbles: true, cancelable: true, view: window, button, buttons: down ? 1 << button : 0,
  }))
}

/**
 * A PNG of the screen.
 *
 * v86 hands back an `<img>` carrying a data URL, which is what its own "save
 * screenshot" button uses. Turning that into bytes is a fetch of the data URL
 * — no network — and it is the only way to reach the encoded PNG without
 * re-encoding a canvas the screen adapter owns.
 * @param emulator - the running emulator.
 * @param graphical - whether the screen is in a graphical mode.
 * @returns the PNG and its intrinsic size.
 */
async function screenshot(
  emulator: Emulator,
  graphical: boolean,
): Promise<{ bytes: Uint8Array, width: number, height: number, graphical: boolean }> {
  const image = emulator.screen_make_screenshot()
  if (image === null || image.src === '') throw new Error('the machine has no screen to photograph')
  const response = await fetch(image.src)
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A data-URL image has not decoded yet, so `naturalWidth` is zero until it
  // does; waiting for `decode()` is what makes the reported size real.
  await image.decode().catch(() => undefined)
  return { bytes, width: image.naturalWidth, height: image.naturalHeight, graphical }
}

/**
 * Stop the machine and forget it.
 *
 * For the panel's restart, and for a test that boots several guests in one
 * page. A page that navigates away does not need this.
 */
export async function stopMachine(): Promise<void> {
  generation++
  const machine = settled
  settled = undefined
  running = undefined
  bootFailure = undefined
  watchers.clear()
  lastStep = undefined
  if (settleTimer !== undefined) {
    clearInterval(settleTimer)
    settleTimer = undefined
  }
  const emulator = live
  live = undefined
  if (emulator !== undefined) await emulator.destroy().catch(() => undefined)
  if (machine !== undefined) machine.screen.remove()
}
