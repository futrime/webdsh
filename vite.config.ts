import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { hasUnpatchedNativeSourceCheck, patchWebKitNativeSourceChecks } from './scripts/webkit-native-source.ts'

/** Resolve a path inside this package. */
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/**
 * Every `node:*` builtin dsh or a community plugin can import, mapped to the
 * browser shims in `src/node/`. Bare aliases are listed too because published
 * CJS-transpiled plugin code often imports `path` rather than `node:path`.
 */
const NODE_SHIMS: Record<string, string> = {
  fs: here('./src/node/fs.ts'),
  'fs/promises': here('./src/node/fs-promises.ts'),
  path: here('./src/node/path.ts'),
  'path/posix': here('./src/node/path.ts'),
  'path/win32': here('./src/node/path.ts'),
  os: here('./src/node/os.ts'),
  crypto: here('./src/node/crypto.ts'),
  child_process: here('./src/node/child_process.ts'),
  worker_threads: here('./src/node/shim-worker-threads.ts'),
  http: here('./src/node/http.ts'),
  https: here('./src/node/http.ts'),
  net: here('./src/node/net.ts'),
  tls: here('./src/node/net.ts'),
  stream: here('./src/node/shim-stream.ts'),
  'stream/promises': here('./src/node/shim-stream-promises.ts'),
  'stream/web': here('./src/node/shim-stream-web.ts'),
  events: here('./src/node/shim-events.ts'),
  buffer: here('./src/node/shim-buffer.ts'),
  url: here('./src/node/shim-url.ts'),
  util: here('./src/node/shim-util.ts'),
  'util/types': here('./src/node/shim-util-types.ts'),
  assert: here('./src/node/shim-assert.ts'),
  'assert/strict': here('./src/node/shim-assert.ts'),
  querystring: here('./src/node/shim-querystring.ts'),
  string_decoder: here('./src/node/shim-string-decoder.ts'),
  perf_hooks: here('./src/node/shim-perf-hooks.ts'),
  async_hooks: here('./src/node/shim-async-hooks.ts'),
  timers: here('./src/node/shim-timers.ts'),
  'timers/promises': here('./src/node/shim-timers-promises.ts'),
  constants: here('./src/node/shim-constants.ts'),
  module: here('./src/node/shim-module.ts'),
  vm: here('./src/node/shim-vm.ts'),
  dns: here('./src/node/shim-dns.ts'),
  'dns/promises': here('./src/node/shim-dns-promises.ts'),
  zlib: here('./src/node/shim-zlib.ts'),
  readline: here('./src/node/shim-readline.ts'),
  'readline/promises': here('./src/node/shim-readline-promises.ts'),
  tty: here('./src/node/shim-tty.ts'),
  sqlite: here('./src/node/sqlite.ts'),
  process: here('./src/node/shim-process.ts'),
  punycode: here('./src/node/shim-punycode.ts'),
  v8: here('./src/node/shim-v8.ts'),
  inspector: here('./src/node/shim-inspector.ts'),
  cluster: here('./src/node/shim-cluster.ts'),
  diagnostics_channel: here('./src/node/shim-diagnostics-channel.ts'),
}

/**
 * Builtins whose bare spelling must keep resolving to the real npm package.
 * `buffer` is the one that matters: the shim itself is built on that package,
 * so aliasing the bare name would make it import itself.
 */
const KEEP_BARE = new Set(['buffer'])

/** Alias entries for the `node:` spelling, plus the bare one where it is safe. */
const builtinAliases = Object.entries(NODE_SHIMS).flatMap(([name, replacement]) => {
  const escaped = name.replace('/', '\\/')
  const entries = [{ find: new RegExp(`^node:${escaped}$`), replacement }]
  if (!KEEP_BARE.has(name)) entries.push({ find: new RegExp(`^${escaped}$`), replacement })
  return entries
})

/** Make dsh's cross-realm plain-JSON guard portable to WebKit. */
function webkitNativeSourceChecks(): Plugin {
  let building = false
  const verify = (source: string, id: string): void => {
    if (hasUnpatchedNativeSourceCheck(source)) {
      throw new Error(`an unpatched WebKit native-constructor check remains in ${id}`)
    }
  }
  const patchAndVerify = (source: string, id: string): string => {
    const code = patchWebKitNativeSourceChecks(source)
    verify(code, id)
    return code
  }

  return {
    name: 'webkit-native-constructor-source',
    enforce: 'pre',
    configResolved(config) {
      building = config.command === 'build'
    },
    load(id) {
      // `?url` files are normally copied without `transform`, so emit the
      // patched worker ourselves. Doing this before Rollup names the asset also
      // keeps its content hash honest for caches and rolling deployments.
      const [path, query = ''] = id.split('?', 2)
      if (!building
        || !query.split('&').includes('url')
        || !path.endsWith('/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/worker.cjs')) {
        return null
      }
      const source = patchAndVerify(readFileSync(path, 'utf8'), path)
      const reference = this.emitFile({ type: 'asset', name: 'worker.cjs', source })
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`
    },
    transform(source, id) {
      if (!id.includes('/node_modules/@deepseek-ai/')) return null
      const code = patchAndVerify(source, id)
      return code === source ? null : { code, map: null }
    },
    // Vite copies the code-runtime's sibling CommonJS worker as an asset rather
    // than passing it through `transform`. Cover emitted JS assets as well as
    // ordinary chunks, then make an overlooked published copy a build failure.
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          verify(output.code, output.fileName)
          continue
        }
        if (!/\.(?:c|m)?js$/.test(output.fileName)) continue
        const source = typeof output.source === 'string'
          ? output.source
          : new TextDecoder().decode(output.source)
        verify(source, output.fileName)
      }
    },
  }
}

/**
 * The environment test v86 uses to decide how it reads a file.
 *
 * It asks whether it is running under Node, and this build answers yes: the
 * vendored dsh loader probes `process.versions.node`, so the define below
 * substitutes a version string into *every* module in the bundle, v86's
 * included. v86 then reads its BIOS and its disk images through `node:fs`,
 * which here is the page's virtual filesystem — so the first boot fails with
 * `ENOENT … /home/dsh/workspace/http:/…/v86.wasm`, naming a path nothing ever
 * meant to create.
 *
 * The condition is replaced with the half of it that is actually a question in
 * a browser. Matched as a literal and asserted to appear exactly once, so a
 * v86 upgrade that rewrites it fails the build loudly instead of quietly
 * putting the emulator back on the filesystem path.
 */
const V86_ENVIRONMENT_TEST
  = '"undefined"===typeof XMLHttpRequest||"undefined"!==typeof process&&process.versions&&process.versions.node'

/**
 * Tell v86 it is in a browser, because it is.
 * @returns the plugin.
 */
function v86InBrowser(): Plugin {
  return {
    name: 'dsh-web:v86-in-browser',
    // Before the define plugin rewrites `process.versions.node` into a literal
    // and there is no longer a condition to recognise.
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.includes('/v86/build/libv86')) return undefined
      const occurrences = code.split(V86_ENVIRONMENT_TEST).length - 1
      if (occurrences !== 1) {
        throw new Error(
          `v86's environment test was found ${String(occurrences)} times, expected exactly once. `
          + 'The emulator will read its disk images through node:fs — see vite.config.ts.',
        )
      }
      return { code: code.replace(V86_ENVIRONMENT_TEST, '"undefined"===typeof XMLHttpRequest'), map: null }
    },
  }
}

export default defineConfig({
  plugins: [v86InBrowser(), webkitNativeSourceChecks()],
  // Relative asset URLs so the same build works at a GitHub Pages project path,
  // a user/organization site root, or a plain file:// checkout.
  base: './',
  resolve: {
    alias: [
      ...builtinAliases,
      // The only native dependency in dsh's runtime closure. Replacing it lets
      // `dsh-subprocess-local` — the real subprocess provider — load unchanged.
      { find: /^node-pty$/, replacement: here('./src/node/node-pty.ts') },
      // Optional native addon the vendored loader probes for; it is only used
      // to reach Node's internal ESM loader, which the browser host replaces.
      { find: /^node-addon-require-builtin$/, replacement: here('./src/node/shim-empty.ts') },
      // Image decoding for attachments. The browser's own decoder replaces the
      // native library, so image attachments keep working.
      { find: /^sharp$/, replacement: here('./src/node/sharp.ts') },
      // The ripgrep binary the search tool spawns. Without this the real
      // package throws while resolving a platform binary that cannot exist
      // here, and the `grep` and `glob` tools fail on every call.
      { find: /^@vscode\/ripgrep$/, replacement: here('./src/node/vscode-ripgrep.ts') },
    ],
    // Published dsh packages expose their runtime entry through `default`.
    conditions: ['import', 'module', 'browser', 'default'],
  },
  define: {
    // The vendored loader probes the Node major to find the internal ESM
    // loader; "0.0.0" takes neither branch, leaving the slot the browser host
    // fills with its own module system.
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
    'process.env.NODE_ENV': '"production"',
  },
  optimizeDeps: {
    // The shims must win over esbuild's prebundling of the same specifiers.
    // These four packages also carry the WebKit source-format check above and
    // must reach the transform rather than disappear inside a prebundle.
    // These four packages carry the WebKit source-format check above and must
    // reach the transform rather than disappear inside a prebundle; `v86` is
    // excluded for the mirror-image reason — prebundling would hand
    // `vite:define` a copy the `pre` transform never saw, and dev and build
    // would then disagree about which filesystem the emulator reads.
    exclude: [
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-cordis-host-runner',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-code-runtime-worker-thread',
      'v86',
    ],
    esbuildOptions: { target: 'es2022' },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        /**
         * The dsh host packages deliberately stay in the entry chunk.
         *
         * Several of them read `Buffer` and `process` while their module bodies
         * evaluate, and only same-chunk emission guarantees they run after
         * `src/node/install-globals.ts` — which `src/main.ts` imports first.
         * Splitting them out reintroduces a cross-chunk evaluation order that
         * rollup makes no promises about. Only the two lazily-imported engines
         * are split, and both are behind a dynamic import already.
         */
        manualChunks(id: string): string | undefined {
          if (id.includes('/isomorphic-git/')) return 'git'
          if (id.includes('/sql.js/')) return 'sqlite'
          return undefined
        },
      },
    },
  },
  server: { port: 5180 },
})
