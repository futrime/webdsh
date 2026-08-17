/**
 * `@vscode/ripgrep` for the browser.
 *
 * The real package resolves a platform-specific native binary through
 * `createRequire(...).resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg')` and
 * throws when it cannot find one — which in a page is always, and would be
 * anyway because `process.arch` here is `wasm32`. That throw is what made the
 * agent's `grep` and `glob` tools fail on every call.
 *
 * The consumer only ever uses `rgPath` as `argv[0]` of a spawn, and this host's
 * subprocess seam resolves argv through the in-browser shell's command
 * registry. So naming the shell's own `rg` implementation is all that is needed
 * for the tools to work exactly as they do on a real machine.
 * @see src/shell/ripgrep.ts
 */

/** Where the shell's ripgrep lives, as far as a spawning caller is concerned. */
export const rgPath = '/usr/bin/rg'

export default { rgPath }
