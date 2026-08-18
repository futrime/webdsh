/**
 * The star plugin's host half.
 *
 * It does nothing, and it has to exist: a `dsh.client` declaration is only read
 * from a package that is *in* the composition, so the browser half — which is
 * the whole plugin — needs a host row to hang from. The terminal's host half
 * carries a system prompt section; this one carries nothing, because a link in
 * the user's sidebar is no business of the model's.
 */

/** Stable Cordis plugin name. */
export const name = 'web-star'

/** Mount the host half. There is no host-side behaviour to mount. */
export function apply(): void {}

export default { name, apply }
