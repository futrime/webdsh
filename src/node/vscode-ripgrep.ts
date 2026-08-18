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
 * subprocess seam runs that argv in the container. The container has ripgrep —
 * `container/Dockerfile` installs it for exactly this reason — so naming where
 * Debian puts it is all that is needed for the tools to work as they do on a
 * real machine.
 */

/** Where ripgrep lives in the machine. */
export const rgPath = '/usr/bin/rg'

export default { rgPath }
