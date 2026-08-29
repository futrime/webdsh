/**
 * The few things every side of the browser machine has to agree about.
 *
 * Three bundles are built out of `src/browser`: the page this app is, the
 * runtime injected into each browsed document (`frame.ts`), and the realm a
 * task's own code runs in (`realm.ts`). They cannot import each other — one is
 * 2000 lines of DOM machinery, another pulls in the network stack — so
 * anything all three need has lived as a copy in each of them, and the copies
 * drifted. This is a leaf: no imports, nothing that costs a bundle anything to
 * carry, and one home for the facts that must not disagree.
 */

/**
 * The frame commands that change a page rather than describe it.
 *
 * `page.command(kind)` is the escape hatch past every named method, so this is
 * the list that decides whether a `readOnly` run means what it says. It is
 * checked twice — in the realm, so a body is refused where it is written, and
 * again in `src/browser/task.ts`, which is the side that cannot be talked
 * round. Both read it from here: while there were two copies they had already
 * drifted apart, and a command in one and not the other is a read-only run
 * that types into the page.
 *
 * Everything that evaluates caller-supplied source belongs here. Nothing can
 * tell a read from a write once the body supplies the code —
 * `document.forms[0].submit()` is a function call like any other — so
 * `locator.evaluate`, `locator.evaluateAll` and `waitForFunction` are as
 * mutating as a click, and were the way past this list while they were absent.
 */
export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'mouse', 'keyboard', 'paste', 'files.set', 'locator.act',
  'click', 'clickAt', 'type', 'key', 'select', 'scroll', 'frame.load', 'dialog.arm',
  'evaluate', 'evaluateFn', 'locator.evaluate', 'locator.evaluateAll', 'waitForFunction',
])

/**
 * A number an option asked for, kept inside what this machine will do.
 *
 * `Math.max(low, Math.min(Number(x), high))` is `NaN` for anything `Number`
 * cannot read, and `NaN` then silently means *nothing* to `slice` and nothing
 * to `>` — which is how one mistyped option turned "look inside the frames"
 * into "report none", and a mistyped `depth` into a walk of the whole
 * document.
 *
 * A number or a string that reads as one is an answer; everything else is
 * nothing asked for. `Number` is not the test, because `Number(null)`,
 * `Number('')`, `Number(false)` and `Number([])` are all `0` — finite, so they
 * pass, and a `maxChars: null` that came back through JSON as an absent value
 * clamped to the machine's *minimum* rather than falling back to the default.
 * @param wanted - what was asked for, from a caller that may not be typed.
 * @param fallback - what to use when nothing was asked for.
 * @param low - the smallest this machine will do.
 * @param high - the largest.
 * @returns a number in range.
 */
export function bounded(wanted: unknown, fallback: number, low: number, high: number): number {
  const asked = typeof wanted === 'number' ? wanted
    : typeof wanted === 'string' && wanted.trim() !== '' ? Number(wanted) : fallback
  // Only `NaN` is "nothing asked for"; `Infinity` is a caller asking for as
  // much as this machine will do, and clamping says so. And the fallback is
  // clamped too: a default that comes from the document — `scrollWidth` for a
  // screenshot's width — is not one this machine promised to stay inside, so
  // returning it unclamped made one mistyped option escape the bound the
  // caller was told about.
  return Math.max(low, Math.min(Number.isNaN(asked) ? fallback : asked, high))
}

/**
 * Bytes for base64 that crossed a message channel.
 *
 * Next to its inverse, and in the one module every bundle can import: the two
 * halves of one codec drifting apart is how one copy ends up backed by a plain
 * `ArrayBuffer` and another not, and there were three of these.
 * @param text - the encoding.
 * @returns the bytes.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  // Backed by a plain `ArrayBuffer` rather than whatever `Uint8Array(number)`
  // infers, because a `Response` and a `Blob` both refuse a view that might be
  // over shared memory — and this page is cross-origin isolated, so the
  // compiler is right to think it might be.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Base64 for bytes, in chunks so a large resource does not blow the argument limit. */
export function base64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}
