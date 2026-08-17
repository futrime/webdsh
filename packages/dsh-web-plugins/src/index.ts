/**
 * The install plugin's host half.
 *
 * The installer itself is a browser capability — it fetches a tarball with the
 * page's own `fetch` and unpacks it into the virtual filesystem — so this row
 * exists to carry the client declaration, which is only read from a package
 * that is part of the composition.
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Mount the host half.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  void ctx
}

export default { apply }
