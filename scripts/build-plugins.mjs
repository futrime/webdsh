/**
 * Build the plugins this repository ships.
 *
 * The terminal and the plugin installer are ordinary dsh plugins, not parts of
 * the app, so they are built the way a plugin is: a node half and a browser
 * half, each an ES module, with the browser half wrapped in the same
 * self-registering factory every shipped client bundle uses.
 *
 * That wrapper is the contract the shell's module loader consumes:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * `react`, `react/jsx-runtime`, and the client packages are resolved by that
 * `require`, so they are external here — a bundle carrying its own React would
 * render into a second reconciler and see none of the surface's state.
 *
 * Usage: `node scripts/build-plugins.mjs`
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packages = join(root, 'packages')

/** Everything the shell's loader supplies, and must therefore not be bundled. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  'schemastery',
  // The harness packages a node half may import. They are external for the
  // same reason React is: the host already has them, and a second copy would
  // be a second set of classes — an `instanceof` that fails and a tool
  // registry the registered tool is not in.
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-shell',
]

/**
 * Wrap a built browser half in the loader's factory form.
 * @param {string} id - the package name the roster addresses it by.
 * @param {string} code - the bundled module body.
 * @returns {string} the self-registering bundle.
 */
function wrap(id, code) {
  return `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\n`
    + '\t\tvar module = { exports: {} };\n'
    + '\t\tvar exports = module.exports;\n'
    + '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n'
    + `${code}\n`
    + '\t\treturn module.exports;\n'
    + '\t}\n});\n'
}

/**
 * Build one package's two halves.
 * @param {string} name - the directory under `packages/`.
 */
async function buildPackage(name) {
  const directory = join(packages, name)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const lib = join(directory, 'lib')
  mkdirSync(lib, { recursive: true })

  // The node half is a plain ES module; the host's module system imports it.
  await build({
    entryPoints: [join(directory, 'src/index.ts')],
    outfile: join(lib, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: EXTERNAL,
    logLevel: 'warning',
  })

  const client = join(directory, 'src/client.tsx')
  if (!existsSync(client)) return

  // The browser half is bundled to CommonJS so its `require` calls survive into
  // the wrapper, which is where the loader supplies them.
  const bundled = await build({
    entryPoints: [client],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: EXTERNAL,
    logLevel: 'warning',
  })
  const body = bundled.outputFiles[0].text
    .split('\n')
    .map(line => (line === '' ? line : `\t\t${line}`))
    .join('\n')
  writeFileSync(join(lib, 'client.js'), wrap(manifest.name, body))
  console.log(`[plugins] built ${manifest.name}`)
}

for (const name of readdirSync(packages)) {
  if (!existsSync(join(packages, name, 'package.json'))) continue
  await buildPackage(name)
}
