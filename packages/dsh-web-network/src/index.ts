/**
 * The network plugin's host half.
 *
 * It does nothing, and it has to exist: a `dsh.client` declaration is only read
 * from a package that is *in* the composition, so the browser half — which is
 * the whole plugin — needs a host row to hang from.
 *
 * There is deliberately no host-side behaviour. The proxy is applied by the
 * app's own `fetch`, which is in force before this row mounts and stays in
 * force if the row is removed; a host half that also applied it would be a
 * second answer to the same question, and the two would disagree the moment
 * one of them was disabled.
 */

/** Stable Cordis plugin name. */
export const name = 'web-network'

/** Mount the host half. There is no host-side behaviour to mount. */
export function apply(): void {}

export default { name, apply }
