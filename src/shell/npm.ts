/**
 * `npm` and `npx` for the in-page terminal.
 *
 * A page can reach the registry over HTTPS and this host can already unpack a
 * tarball into the virtual filesystem, so the parts of npm that are about
 * *fetching and running* work here. What cannot is anything that needs a
 * toolchain: a package with a native addon or a compile step installs its files
 * and then fails at require time, the same way it would on a machine without a
 * compiler — loudly, and only if you use it.
 *
 * Lifecycle scripts are deliberately not run. They exist to invoke arbitrary
 * local tooling, almost none of which exists here, and running them would
 * mostly produce confusing failures partway through an otherwise fine install.
 */

import type { CommandContext } from './runtime.ts'
import { installPackage, parseSpec, resolveVersion } from '../pkg/registry.ts'
import { readJsonFile } from './node-runtime.ts'
import { volume } from '../vfs/volume.ts'
import { toBytes } from '../node/binary.ts'
import { resolve as resolvePath } from '../node/path.ts'

/** Find the nearest directory at or above `from` that has a `package.json`. */
function packageRoot(from: string): string {
  const segments = from.split('/').filter(Boolean)
  for (let i = segments.length; i > 0; i--) {
    const base = `/${segments.slice(0, i).join('/')}`
    if (volume.exists(`${base}/package.json`)) return base
  }
  return from
}

/** Write a manifest back, formatted the way npm leaves it. */
function writeManifest(path: string, manifest: Record<string, unknown>): void {
  volume.writeFile(path, toBytes(`${JSON.stringify(manifest, null, 2)}\n`))
}

/** The bin entries a package declares, as a name → relative path map. */
function binsOf(manifest: Record<string, unknown>, name: string): Record<string, string> {
  const bin = manifest.bin
  if (typeof bin === 'string') return { [name.split('/').pop() ?? name]: bin }
  if (typeof bin === 'object' && bin !== null) return bin as Record<string, string>
  return {}
}

/**
 * Link a package's declared bins into `<root>/.bin`, as npm does.
 *
 * This is what makes `npx <tool>` and a `package.json` script naming a
 * dependency's CLI resolvable, so it is not cosmetic.
 * @param root - the `node_modules` directory.
 * @param name - the installed package name.
 */
function linkBins(root: string, name: string): void {
  const manifest = readJsonFile(`${root}/${name}/package.json`)
  if (manifest === undefined) return
  const bins = binsOf(manifest, name)
  if (Object.keys(bins).length === 0) return
  volume.mkdirp(`${root}/.bin`)
  for (const [binName, relative] of Object.entries(bins)) {
    const target = resolvePath(`${root}/${name}`, relative)
    if (!volume.exists(target)) continue
    // A shim rather than a symlink: `$PATH` lookup runs the file, and this way
    // it carries the interpreter the same way a shebang would.
    volume.writeFile(`${root}/.bin/${binName}`, toBytes(`#!/bin/sh\nexec node '${target}' "$@"\n`), 0o755)
  }
}

/** `npm install` and its aliases. */
async function install(context: CommandContext, specs: string[], flags: Set<string>): Promise<number> {
  const cwd = context.shell.cwd
  const base = packageRoot(cwd)
  const root = `${base}/node_modules`
  const manifestPath = `${base}/package.json`
  const manifest = readJsonFile(manifestPath) ?? {}

  const wanted = specs.length > 0
    ? specs
    : Object.entries({
      ...(manifest.dependencies as Record<string, string> | undefined ?? {}),
      ...(flags.has('production') ? {} : (manifest.devDependencies as Record<string, string> | undefined ?? {})),
    }).map(([name, range]) => `${name}@${range}`)

  if (wanted.length === 0) {
    context.stdout.write('up to date\n')
    return 0
  }

  volume.mkdirp(root)
  let total = 0
  for (const spec of wanted) {
    try {
      const installed = await installPackage(spec, root, {
        onProgress: message => { context.stdout.write(`+ ${message}\n`) },
      })
      for (const entry of installed) linkBins(root, entry.name)
      total += installed.length
      // An explicit `npm install <pkg>` records the dependency, as npm does.
      if (specs.length > 0 && installed.length > 0) {
        const { name } = parseSpec(spec)
        const field = flags.has('save-dev') ? 'devDependencies' : 'dependencies'
        const version = installed.find(entry => entry.name === name)?.version
        if (version !== undefined) {
          const section = (manifest[field] as Record<string, string> | undefined) ?? {}
          section[name] = `^${version}`
          manifest[field] = section
        }
      }
    } catch (error) {
      context.stderr.write(`npm error ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (specs.length > 0 && Object.keys(manifest).length > 0) writeManifest(manifestPath, manifest)
  context.stdout.write(`\nadded ${String(total)} package${total === 1 ? '' : 's'}\n`)
  return 0
}

/** `npm run <script>` — execute a manifest script through this same shell. */
async function runScript(context: CommandContext, name: string | undefined, rest: string[]): Promise<number> {
  const base = packageRoot(context.shell.cwd)
  const manifest = readJsonFile(`${base}/package.json`)
  const scripts = (manifest?.scripts ?? {}) as Record<string, string>
  if (name === undefined) {
    if (Object.keys(scripts).length === 0) {
      context.stdout.write('no scripts defined\n')
      return 0
    }
    context.stdout.write('available scripts:\n')
    for (const [key, value] of Object.entries(scripts)) context.stdout.write(`  ${key}\n    ${value}\n`)
    return 0
  }
  const body = scripts[name]
  if (body === undefined) {
    context.stderr.write(`npm error Missing script: "${name}"\n`)
    return 1
  }
  context.stdout.write(`> ${name}\n> ${body}\n\n`)
  const { runShell } = await import('./index.ts')
  const result = await runShell([body, ...rest.map(argument => `'${argument.replaceAll("'", `'\\''`)}'`)].join(' '), {
    cwd: base,
    // A script's own tooling lives in the package's `.bin`, which is what makes
    // `"build": "vite build"` resolve without a global install.
    env: { ...Object.fromEntries(context.shell.vars), PATH: `${base}/node_modules/.bin:${context.shell.vars.get('PATH') ?? '/usr/bin:/bin'}` },
    onStdout: chunk => { context.stdout.write(chunk) },
    onStderr: chunk => { context.stderr.write(chunk) },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  return result.status
}

/** `npm ls` — what is actually installed here. */
function list(context: CommandContext): number {
  const base = packageRoot(context.shell.cwd)
  const root = `${base}/node_modules`
  if (!volume.exists(root)) {
    context.stdout.write(`${base}\n(empty)\n`)
    return 0
  }
  context.stdout.write(`${base}\n`)
  const names: string[] = []
  for (const entry of volume.readdir(root)) {
    if (entry === '.bin') continue
    if (entry.startsWith('@')) {
      for (const scoped of volume.readdir(`${root}/${entry}`)) names.push(`${entry}/${scoped}`)
    } else names.push(entry)
  }
  for (const name of names.sort()) {
    const manifest = readJsonFile(`${root}/${name}/package.json`)
    context.stdout.write(`├── ${name}@${String(manifest?.version ?? '?')}\n`)
  }
  return 0
}

/**
 * `npm`.
 * @param context - the command context.
 * @returns the exit status.
 */
export async function npmCommand(context: CommandContext): Promise<number> {
  const args = context.argv.slice(1)
  const flags = new Set(args.filter(argument => argument.startsWith('--')).map(argument => argument.replace(/^--/, '')))
  const positional = args.filter(argument => !argument.startsWith('-'))
  const subcommand = positional[0]
  const rest = positional.slice(1)

  switch (subcommand) {
    case undefined:
    case 'help':
      context.stdout.write(
        'npm <command>\n\n'
        + '  install [pkg…]   fetch from the registry into ./node_modules\n'
        + '  run [script]     run a package.json script\n'
        + '  ls               list installed packages\n'
        + '  init             write a minimal package.json\n'
        + '  view <pkg>       show a package\'s published metadata\n'
        + '  exec <pkg>       fetch and run a package\'s bin (also `npx`)\n\n'
        + 'Lifecycle scripts are not run, and packages needing a compiler will\n'
        + 'install but fail when required.\n',
      )
      return 0
    case 'install': case 'i': case 'add': case 'ci':
      return install(context, rest, flags)
    case 'run': case 'run-script':
      return runScript(context, rest[0], rest.slice(1))
    case 'ls': case 'list':
      return list(context)
    case 'init': {
      const base = context.shell.cwd
      const path = `${base}/package.json`
      if (volume.exists(path) && !flags.has('force')) {
        context.stderr.write('npm error package.json already exists\n')
        return 1
      }
      writeManifest(path, { name: base.split('/').pop() ?? 'workspace', version: '1.0.0', type: 'module', scripts: {} })
      context.stdout.write(`Wrote to ${path}\n`)
      return 0
    }
    case 'view': case 'info': {
      const spec = rest[0]
      if (spec === undefined) {
        context.stderr.write('npm error view requires a package name\n')
        return 1
      }
      try {
        const { name, range } = parseSpec(spec)
        const resolved = await resolveVersion(name, range)
        const manifest = resolved.manifest
        context.stdout.write(`${resolved.name}@${resolved.version}\n${String(manifest.description ?? '')}\n\n`)
        context.stdout.write(`dependencies: ${Object.keys((manifest.dependencies ?? {}) as object).join(', ') || '(none)'}\n`)
        return 0
      } catch (error) {
        context.stderr.write(`npm error ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }
    case 'exec': case 'x':
      return exec(context, rest)
    default:
      context.stderr.write(`npm error Unknown command: "${subcommand}"\n`)
      return 1
  }
}

/** `npx`/`npm exec` — install if needed, then run the package's bin. */
async function exec(context: CommandContext, args: string[]): Promise<number> {
  const spec = args[0]
  if (spec === undefined) {
    context.stderr.write('npx: a package is required\n')
    return 1
  }
  const { name } = parseSpec(spec)
  const base = packageRoot(context.shell.cwd)
  const root = `${base}/node_modules`
  const binName = name.split('/').pop() ?? name

  if (!volume.exists(`${root}/${name}/package.json`)) {
    context.stdout.write(`npx: installing ${spec}…\n`)
    try {
      const installed = await installPackage(spec, root, { onProgress: message => { context.stdout.write(`+ ${message}\n`) } })
      for (const entry of installed) linkBins(root, entry.name)
    } catch (error) {
      context.stderr.write(`npx: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const manifest = readJsonFile(`${root}/${name}/package.json`)
  if (manifest === undefined) {
    context.stderr.write(`npx: ${name} is not installed\n`)
    return 1
  }
  const bins = binsOf(manifest, name)
  const relative = bins[binName] ?? Object.values(bins)[0]
  if (relative === undefined) {
    context.stderr.write(`npx: ${name} declares no bin\n`)
    return 1
  }
  const { runShell } = await import('./index.ts')
  const target = resolvePath(`${root}/${name}`, relative)
  const result = await runShell(
    ['node', target, ...args.slice(1)].map(token => `'${token.replaceAll("'", `'\\''`)}'`).join(' '),
    {
      cwd: context.shell.cwd,
      env: Object.fromEntries(context.shell.vars),
      onStdout: chunk => { context.stdout.write(chunk) },
      onStderr: chunk => { context.stderr.write(chunk) },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  )
  return result.status
}
