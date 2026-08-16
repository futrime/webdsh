/**
 * Side-effect module that seeds the Node globals.
 *
 * It must evaluate before any dsh module body runs, because several read
 * `process` at module scope. ES modules evaluate in import order, so this is
 * imported first — and only for its side effect — by `src/main.ts`.
 */

import { installNodeGlobals } from './registry.ts'

installNodeGlobals()
