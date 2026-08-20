/**
 * Patch one browser-format assumption in the published dsh packages.
 *
 * Their lossless-JSON guards accept intrinsic Object/Array prototypes from any
 * realm by checking the constructor's native source. ECMAScript deliberately
 * does not prescribe whitespace in that source: Chromium prints one line,
 * while WebKit prints the body on an indented second line. Normalizing only
 * whitespace keeps every other part of the guard (name, prototype identity and
 * the `[native code]` marker) intact, including its rejection of forged user
 * constructors.
 *
 * Keep this build-time transform until the published packages make the same
 * comparison portably. It is deliberately exact so an upstream rewrite cannot
 * be changed silently by a broad textual replacement.
 */

const CHECKS = [
  {
    before: 'Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`',
    after: 'Function.prototype.toString.call(constructor).replace(/\\s+/g, " ").trim() === `function ${name}() { [native code] }`',
  },
  {
    before: 'intrinsicReflectApply(intrinsicFunctionToString, constructor, []) === `function ${name}() { [native code] }`',
    after: 'intrinsicReflectApply(intrinsicFunctionToString, constructor, []).replace(/\\s+/g, " ").trim() === `function ${name}() { [native code] }`',
  },
] as const

/** Normalize every known copy of the native-constructor check in one module. */
export function patchWebKitNativeSourceChecks(source: string): string {
  let patched = source
  for (const check of CHECKS) patched = patched.replaceAll(check.before, check.after)
  return patched
}

/** Whether source still contains a known non-portable check. */
export function hasUnpatchedNativeSourceCheck(source: string): boolean {
  return CHECKS.some(check => source.includes(check.before))
}
