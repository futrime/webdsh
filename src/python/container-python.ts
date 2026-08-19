/**
 * Python, as a program the container runs.
 *
 * The container ships `python3`, and it is RustPython: a Python-shaped
 * interpreter with no `pathlib`, no `subprocess`, and no pip. An agent asked to
 * "write a script" reaches for the standard library within three lines and
 * finds it missing, so the honest choices were to keep describing that in every
 * tool description or to put a real Python there. This is the second.
 *
 * What runs here is CPython itself, compiled to WebAssembly by
 * [Pyodide](https://pyodide.org) — the same interpreter, the same standard
 * library, and ~350 packages built for it, plus every pure-Python wheel on PyPI
 * through `micropip`. It runs *inside* the container rather than in the page,
 * which is the whole point: the terminal and the agent already share one
 * machine, and a Python that lived in the page would be a second one with its
 * own filesystem. Mounted through Emscripten's `NODEFS`, `open('data.txt')` in
 * Python is the same file `cat data.txt` prints.
 *
 * Three things about the container shaped the code below, each measured rather
 * than assumed:
 *
 * - `npm install pyodide` does not deliver a usable interpreter: the container
 *   writes `pyodide.asm.wasm` as 12.2 MB where the published file is 9.6 MB,
 *   with `EF BF BD` — U+FFFD — wherever a byte was not valid UTF-8, and it
 *   fails to compile. Whatever does that is specific rather than general: the
 *   `python_stdlib.zip` beside it, and a 14 MB `esbuild.wasm` from another
 *   package, both arrive byte-exact through the same `npm install`. Fetching
 *   the file with `fetch` and writing the `Buffer` is byte-exact every time, so
 *   that is how the runtime arrives — and it is why the interpreter is not
 *   simply a dependency.
 * - `jsh` resolves a command against the `$PATH` it was *spawned* with and never
 *   re-reads it, so `export PATH=…; python3` still finds the old one. The page
 *   puts the harness's directory in front at spawn time, which is what lets
 *   this shadow `/usr/local/bin/python3` — RustPython, which a page cannot
 *   delete or overwrite.
 * - A child process here has no readable file descriptor 0: `readSync(0, …)`
 *   fails with `EBADF`. Piped input arrives on the stream instead, so it is
 *   drained before the interpreter starts and served from memory after.
 */

import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * The Pyodide release this build runs.
 *
 * Pinned rather than floating: the interpreter, the standard library, and the
 * package repository are one release, and a lock file from a different one
 * names wheels the runtime cannot import. The number is Pyodide's, and it
 * tracks CPython's — `314.x` is CPython 3.14.
 */
const PYODIDE_VERSION = '314.0.5'

/** Where the runtime's own files are fetched from. */
const CORE_BASE = `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`

/** Where wheels are fetched from: Pyodide's own package repository. */
const PACKAGE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

/**
 * The files the interpreter is made of.
 *
 * All of them, because a partial download is a runtime that half-starts. The
 * marker written after the last one is what makes the check atomic.
 */
const CORE_FILES = [
  'pyodide.js',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
  'package.json',
]

/** How large the download is, for the one line a user reads while it happens. */
const CORE_MEGABYTES = 14

/** The slice of Pyodide's API this program uses. */
interface Pyodide {
  version: string
  runPython(code: string): unknown
  runPythonAsync(code: string): Promise<unknown>
  loadPackage(names: string | string[], options?: {
    messageCallback?: (text: string) => void
    errorCallback?: (text: string) => void
  }): Promise<unknown>
  mountNodeFS(emscriptenPath: string, hostPath: string): void
  setStdin(options: { read?: (buffer: Uint8Array) => number, isatty?: boolean }): void
  setStdout(options: { write?: (buffer: Uint8Array) => number, isatty?: boolean }): void
  setStderr(options: { write?: (buffer: Uint8Array) => number, isatty?: boolean }): void
  globals: { get(name: string): unknown, set(name: string, value: unknown): void }
}

/** Emscripten's filesystem, as the `fsInit` hook hands it over. */
interface EmscriptenFs {
  mount(type: unknown, options: { root: string }, mountpoint: string): void
  filesystems: { NODEFS: unknown }
}

/** What `pyodide.js` exports. */
interface PyodideModule {
  loadPyodide(options: Record<string, unknown>): Promise<Pyodide>
}

/** Where the interpreter, its wheels, and the packages installed into it live. */
function pythonHome(): string {
  const override = process.env.DSH_PYTHON_HOME
  if (override !== undefined && override !== '') return override
  return join(process.env.HOME ?? '/home/dsh', '.dsh', 'python')
}

/** Write a line the user sees, where it cannot be mistaken for the program's output. */
function note(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * Fetch the interpreter, once per container.
 *
 * The container's filesystem is memory, so this happens the first time anything
 * Python runs in a session and not again — and the page puts a previously
 * fetched copy back at boot, so for a returning visitor it happens once ever.
 *
 * Progress goes to standard error rather than standard output: `python -c
 * 'print(1)' | wc -l` has to answer 1 whether or not this was the download.
 * @param home - the directory the runtime lives in.
 */
async function ensureRuntime(home: string): Promise<void> {
  const marker = join(home, `.installed-${PYODIDE_VERSION}`)
  if (existsSync(marker)) return

  mkdirSync(home, { recursive: true })
  discardOtherVersions(home)
  const base = process.env.DSH_PYODIDE_BASE ?? CORE_BASE
  note(`Installing Python ${PYODIDE_VERSION} (CPython via Pyodide, ~${String(CORE_MEGABYTES)} MB); this happens once.`)
  const started = Date.now()
  await Promise.all(CORE_FILES.map(async (name) => {
    let response: Response
    try {
      response = await fetch(`${base}${name}`)
    } catch (error) {
      throw new Error(`could not reach ${base}${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`could not download ${name}: HTTP ${String(response.status)}`)
    // Written under a temporary name and renamed, so a second `python` started
    // while this one is downloading never reads a half-written interpreter.
    const target = join(home, name)
    const staged = `${target}.part-${String(process.pid)}`
    writeFileSync(staged, Buffer.from(await response.arrayBuffer()))
    renameSync(staged, target)
  }))
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  note(`Python installed in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
}

/**
 * Throw away an installation left by a different release.
 *
 * A wheel is built against one interpreter's ABI: `numpy-…-cp314-…wasm32.whl`
 * imports into CPython 3.14 and segfaults or fails to load in anything else. So
 * a version bump does not merge with what is already there — it replaces it,
 * and says so, because the alternative is a session where an installed package
 * is present and unimportable.
 * @param home - the directory the runtime lives in.
 */
function discardOtherVersions(home: string): void {
  const stale = readdirSync(home).filter(name => name.startsWith('.installed-') && name !== `.installed-${PYODIDE_VERSION}`)
  if (stale.length === 0) return
  note(`Replacing Python ${stale.map(name => name.slice('.installed-'.length)).join(', ')}; installed packages are cleared.`)
  for (const name of [...stale, 'site-packages', 'wheels']) rmSync(join(home, name), { recursive: true, force: true })
}

/**
 * Everything on standard input, or nothing when there is nobody to read from.
 *
 * A terminal never ends, so reading one here would hang forever; a pipe or a
 * redirection does end, and the whole of it is taken before the interpreter
 * starts because Pyodide asks for input synchronously and this process cannot
 * answer synchronously — file descriptor 0 is not readable in this container.
 * @returns the bytes standard input carried.
 */
async function drainStdin(): Promise<Buffer> {
  if (process.stdin.isTTY === true) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  return new Promise((settle) => {
    process.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    process.stdin.on('end', () => { settle(Buffer.concat(chunks)) })
    process.stdin.on('error', () => { settle(Buffer.concat(chunks)) })
  })
}

/**
 * Start the interpreter.
 *
 * The two mounts are what make this Python rather than a sandbox that happens
 * to run Python: the container's home directory appears at the same absolute
 * path inside the interpreter, so `os.getcwd()` is the shell's directory and a
 * file written by one is read by the other — and `site-packages` is a real
 * directory in the container, so a package installed by one command is
 * importable by the next.
 * @param options - what to wire the interpreter's streams to.
 * @returns the running interpreter.
 */
async function boot(options: { stdin: Buffer, interactive: boolean }): Promise<Pyodide> {
  const home = pythonHome()
  await ensureRuntime(home)

  const sitePackages = join(home, 'site-packages')
  const wheels = join(home, 'wheels')
  mkdirSync(sitePackages, { recursive: true })
  mkdirSync(wheels, { recursive: true })

  const entry = join(home, 'pyodide.js')
  const { loadPyodide } = createRequire(entry)(entry) as PyodideModule

  const containerHome = process.env.HOME ?? '/home/dsh'
  const py = await loadPyodide({
    indexURL: `${home}/`,
    // Wheels come from Pyodide's own repository and are kept in the container,
    // so installing the same package twice costs one download and a restored
    // session costs none.
    packageBaseUrl: process.env.DSH_PYODIDE_PACKAGES ?? PACKAGE_BASE,
    packageCacheDir: wheels,
    env: {
      HOME: containerHome,
      PWD: process.cwd(),
      TERM: process.env.TERM ?? 'xterm-256color',
      ...(process.env.PYTHONPATH === undefined ? {} : { PYTHONPATH: process.env.PYTHONPATH }),
    },
    // Startup and package-loading messages, which are progress rather than the
    // program's output. Standard error is where progress belongs, and it is the
    // one stream a caller can redirect away without losing an answer.
    stdout: (text: string) => { note(text) },
    stderr: (text: string) => { note(text) },
    fsInit: async (fs: EmscriptenFs, info: { sitePackages: string }) => {
      // While the directory is still empty, which is the only moment Emscripten
      // allows a mount over it.
      fs.mount(fs.filesystems.NODEFS, { root: sitePackages }, info.sitePackages)
      await Promise.resolve()
    },
  })

  py.mountNodeFS(containerHome, containerHome)
  const cwd = process.cwd()
  if (cwd !== containerHome && !cwd.startsWith(`${containerHome}/`)) {
    // Only reached by a command run from outside the home directory, where
    // Emscripten may already own the path — `/tmp` is its own. Reported rather
    // than thrown: the interpreter still runs, and the `chdir` below is what
    // decides whether it can work where it was asked to.
    try {
      py.mountNodeFS(cwd, cwd)
    } catch (error) {
      note(`python: ${cwd} could not be mounted (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  let consumed = 0
  py.setStdin({
    isatty: options.interactive,
    read: (buffer: Uint8Array) => {
      const remaining = options.stdin.length - consumed
      if (remaining <= 0) return 0
      const count = Math.min(remaining, buffer.length)
      options.stdin.copy(buffer, 0, consumed, consumed + count)
      consumed += count
      return count
    },
  })
  py.setStdout(streamTo(process.stdout))
  py.setStderr(streamTo(process.stderr))

  // Loudly, because the alternative is a program that runs in `/` and reads the
  // wrong files while reporting success.
  try {
    py.runPython(`import os; os.chdir(${JSON.stringify(cwd)})`)
  } catch {
    throw new Error(`could not enter ${cwd} inside the interpreter`)
  }
  py.runPython(RUNNER)
  return py
}

/**
 * Hand one of Python's output streams to one of this process's.
 * @param stream - where the bytes should land.
 * @returns the writer Pyodide wants.
 */
function streamTo(stream: NodeJS.WriteStream): { write: (buffer: Uint8Array) => number, isatty: boolean } {
  return {
    isatty: stream.isTTY === true,
    write: (buffer: Uint8Array) => {
      stream.write(Buffer.from(buffer))
      return buffer.length
    },
  }
}

/**
 * The part of a Python invocation that has to be Python.
 *
 * `sys.argv`, `sys.path[0]`, `SystemExit`, and a traceback that names the
 * user's frames and not this program's — every one of those is defined by
 * CPython's own startup, and reimplementing them in JavaScript would mean
 * approximating the thing this file exists to stop approximating.
 */
const RUNNER = `
import builtins, os, runpy, sys, traceback

def __dsh_run__(kind, target, argv):
    """Run one program the way \`python\` would, and report its exit status."""
    sys.argv = list(argv)
    try:
        if kind == 'file':
            sys.path.insert(0, os.path.dirname(os.path.abspath(target)))
            if os.path.isdir(target) or target.endswith(('.zip', '.whl')):
                # A directory or an archive is runpy's job: it is the thing that
                # knows to look for __main__ inside one.
                runpy.run_path(target, run_name='__main__')
            else:
                # Compiled and executed here rather than through runpy, because
                # runpy's own frames end up in the user's traceback and there is
                # no way to tell them from the user's own.
                with open(target, 'rb') as handle:
                    source = handle.read()
                exec(compile(source, target, 'exec'), {
                    '__name__': '__main__', '__file__': target, '__doc__': None,
                    '__package__': None, '__loader__': None, '__spec__': None,
                    '__builtins__': builtins,
                })
        elif kind == 'module':
            sys.path.insert(0, os.getcwd())
            runpy.run_module(target, run_name='__main__', alter_sys=True)
        else:
            sys.path.insert(0, os.getcwd())
            source = compile(target, '<string>' if kind == 'code' else '<stdin>', 'exec')
            exec(source, {
                '__name__': '__main__', '__doc__': None, '__package__': None,
                '__loader__': None, '__spec__': None, '__builtins__': builtins,
            })
    except SystemExit as stop:
        code = stop.code
        if code is None:
            return 0
        if isinstance(code, int):
            # int() because bool is an int: CPython exits 1 on
            # sys.exit(True), and a Python bool crossing into JavaScript
            # arrives as true, which is not a status at all.
            return int(code)
        print(code, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('KeyboardInterrupt', file=sys.stderr)
        return 130
    except BaseException as failure:
        # Dropping one frame takes this function out of the traceback, so what
        # the user reads starts at their own code, as CPython's does.
        tb = failure.__traceback__
        traceback.print_exception(failure.with_traceback(tb.tb_next if tb is not None else tb))
        return 1
    finally:
        # A program is allowed to close its own output — \`python -m json.tool\`
        # does — and a flush that then raises would turn a command that worked
        # into one that reported a traceback and exited 1.
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except ValueError:
                pass
    return 0
`

/** What one `python` command line asks for. */
interface Invocation {
  kind: 'code' | 'module' | 'file' | 'stdin' | 'repl' | 'version' | 'help'
  target: string
  /** `sys.argv`, as the interpreter should see it. */
  argv: string[]
}

/** Interpreter options that swallow the argument after them. */
const VALUED = new Set(['-W', '-X', '--check-hash-based-pycs'])

/**
 * Interpreter options that can be accepted and ignored.
 *
 * `-i` and `-x` are deliberately absent: both change what actually runs — one
 * drops into a prompt after the program, the other skips the first line of the
 * source — so accepting them silently would run something other than what was
 * asked for. They are reported as unknown instead.
 */
const IGNORED = /^[bBdEIOqsSuvP]*$/

/**
 * Read a `python` command line.
 *
 * The flags that change how the interpreter *starts* — `-B`, `-E`, `-I`, `-O`,
 * `-q`, `-s`, `-S`, `-u`, `-v` — are accepted and ignored, because here they
 * are already true or already impossible: output is unbuffered, there is no
 * bytecode cache to write, and there is no user site directory. Accepting them
 * costs nothing; refusing them would fail scripts that pass `-u` out of habit.
 * @param args - everything after the program name.
 * @returns what to run, or the error to report instead.
 */
function parse(args: string[]): Invocation | { error: string } {
  let index = 0
  while (index < args.length) {
    const argument = args[index] ?? ''
    if (argument === '-' || argument === '--' || !argument.startsWith('-')) break
    if (argument === '--help' || argument === '-h' || argument === '-?') {
      return { kind: 'help', target: '', argv: [] }
    }
    if (argument === '--version' || /^-V+$/.test(argument)) {
      return { kind: 'version', target: '', argv: [] }
    }
    if (VALUED.has(argument)) {
      if (args[index + 1] === undefined) return { error: `Argument expected for the ${argument} option` }
      index += 2
      continue
    }
    // The same two options with their value attached — `-Xdev`, `-Wignore` —
    // which is how they are usually written.
    if (/^-[WX]./.test(argument)) {
      index += 1
      continue
    }
    // A bundle like `-uB` is as many flags as it has letters, and `-c`/`-m` may
    // be the last of them — `python -uc 'print(1)'` is one option group, not an
    // unknown option. Whichever of the two appears ends the interpreter's
    // arguments: everything after the code or the module name belongs to the
    // program.
    const letters = argument.slice(1)
    const marker = [...letters].findIndex(letter => letter === 'c' || letter === 'm')
    if (marker !== -1) {
      const before = letters.slice(0, marker)
      if (!IGNORED.test(before)) return { error: `Unknown option: -${before}` }
      const kind = letters[marker] === 'c' ? 'code' : 'module'
      const inline = letters.slice(marker + 1)
      const target = inline === '' ? args[index + 1] : inline
      if (target === undefined) return { error: `Argument expected for the -${letters[marker] ?? ''} option` }
      const rest = args.slice(inline === '' ? index + 2 : index + 1)
      return { kind, target, argv: [kind === 'code' ? '-c' : target, ...rest] }
    }
    if (!IGNORED.test(letters) || letters === '') return { error: `Unknown option: ${argument}` }
    index += 1
  }

  const rest = args.slice(index)
  const first = rest[0]
  if (first === undefined) {
    return { kind: process.stdin.isTTY === true ? 'repl' : 'stdin', target: '', argv: [''] }
  }
  if (first === '-') return { kind: 'stdin', target: '', argv: ['-', ...rest.slice(1)] }
  if (first === '--') {
    const after = rest.slice(1)
    const file = after[0]
    if (file === undefined) {
      return { kind: process.stdin.isTTY === true ? 'repl' : 'stdin', target: '', argv: [''] }
    }
    return { kind: 'file', target: file, argv: after }
  }
  return { kind: 'file', target: first, argv: rest }
}

/** What `python --help` says here, which is what is true here. */
const HELP = [
  'usage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...',
  '',
  'This is CPython compiled to WebAssembly (Pyodide), running inside the',
  'container on the container\'s own files.',
  '',
  '-c cmd : program passed in as a string (terminates option list)',
  '-m mod : run library module as a script (terminates option list)',
  '-h     : print this help message and exit',
  '-V     : print the Python version number and exit',
  'file   : program read from script file',
  '-      : program read from stdin',
  'arg ...: arguments passed to the program in sys.argv[1:]',
  '',
  'Accepted and ignored, because they are already true here: -B -E -I -O -q -s -S -u -v.',
  'Install packages with `pip install <name>`. There is no compiler, so a package',
  'is installable when PyPI has a pure-Python wheel for it or Pyodide has built it.',
  '`input()` reads whatever was piped in; from an interactive terminal it sees',
  'end-of-file, because this container gives a child process no readable stdin',
  'descriptor to block on.',
  'No threads and no sockets: `Thread.start` and `urllib.request.urlopen` (so',
  '`requests` too) raise, and `subprocess` and `os.popen` cannot start anything.',
  '`os.system("...")` does work — Emscripten runs it in the container\'s own shell,',
  'without capturing its output. To fetch a URL, `asyncio.run` a `pyodide.http.pyfetch`',
  'coroutine: it goes through the browser, and so through the browser\'s CORS rule.',
].join('\n')

/** Run one `python` command line. */
async function python(args: string[]): Promise<number> {
  const invocation = parse(args)
  if ('error' in invocation) {
    process.stderr.write(`${invocation.error}\nusage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...\n`)
    return 2
  }
  if (invocation.kind === 'help') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  // `python -m pip` is how half the world installs a package, and here it has
  // to mean what `pip` means rather than fail on a module this interpreter
  // genuinely does not carry.
  if (invocation.kind === 'module' && (invocation.target === 'pip' || invocation.target === 'ensurepip')) {
    return pip(invocation.argv.slice(1))
  }

  if (invocation.kind === 'file') {
    const path = isAbsolute(invocation.target) ? invocation.target : resolve(process.cwd(), invocation.target)
    if (!existsSync(path)) {
      process.stderr.write(`python: can't open file '${path}': [Errno 2] No such file or directory\n`)
      return 2
    }
    invocation.target = path
  }

  if (invocation.kind === 'version') {
    // Asked of the interpreter rather than answered from the pin: a version
    // string that came from a constant would keep being printed by a build
    // whose interpreter had moved.
    const py = await boot({ stdin: Buffer.alloc(0), interactive: false })
    process.stdout.write(`Python ${String(py.runPython('import sys; sys.version.split()[0]'))}\n`)
    return 0
  }

  const interactive = invocation.kind === 'repl'
  // A program read from standard input has consumed it; what the program then
  // reads from standard input is nothing, which is what CPython does too.
  const piped = interactive ? Buffer.alloc(0) : await drainStdin()
  const py = await boot({ stdin: invocation.kind === 'stdin' ? Buffer.alloc(0) : piped, interactive })
  if (invocation.kind === 'repl') return repl(py)

  py.globals.set('__dsh_argv__', invocation.argv)
  const status = await py.runPythonAsync(
    `__dsh_run__(${JSON.stringify(invocation.kind)}, `
    + `${JSON.stringify(invocation.kind === 'stdin' ? piped.toString('utf8') : invocation.target)}, `
    + 'list(__dsh_argv__))',
  )
  return typeof status === 'number' ? status : 0
}

/**
 * The interactive interpreter.
 *
 * CPython's own `code.InteractiveConsole` decides what a prompt is, when a
 * block is finished, and how an error prints. This only carries lines to it,
 * because the terminal is the one place a person compares this against a Python
 * they already know.
 * @param py - the booted interpreter.
 * @returns the status the session ended with.
 */
async function repl(py: Pyodide): Promise<number> {
  py.runPython(`
import code
__dsh_console__ = code.InteractiveConsole(locals={'__name__': '__main__', '__doc__': None})

def __dsh_push__(line):
    """Feed one line to the console; report whether it wants another."""
    return __dsh_console__.push(line)
`)
  const version = py.runPython('import sys; sys.version')
  process.stdout.write(`Python ${String(version)} on wasm (Pyodide ${PYODIDE_VERSION}), inside the container\n`)
  process.stdout.write('Type "help", "copyright", "credits" or "license" for more information.\n')

  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 1000 })
  let more = false
  lines.setPrompt('>>> ')
  lines.prompt()
  // Ctrl+C abandons the statement being typed, as it does in CPython, rather
  // than ending the session — that is what Ctrl+D is for.
  lines.on('SIGINT', () => {
    py.runPython('__dsh_console__.resetbuffer()')
    more = false
    process.stdout.write('\nKeyboardInterrupt\n')
    lines.setPrompt('>>> ')
    lines.prompt()
  })

  for await (const line of lines) {
    try {
      py.globals.set('__dsh_line__', line)
      more = py.runPython('__dsh_push__(__dsh_line__)') === true
    } catch (error) {
      const status = systemExitStatus(error)
      if (status !== undefined) {
        lines.close()
        return status
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      more = false
    }
    lines.setPrompt(more ? '... ' : '>>> ')
    lines.prompt()
  }
  process.stdout.write('\n')
  return 0
}

/**
 * The status a `SystemExit` carries, when that is what was thrown.
 *
 * Pyodide reports a Python exception as a JavaScript error whose `type` is the
 * exception's class name and whose message is the formatted traceback, so both
 * halves of the answer are read back out of it.
 * @param error - what was thrown.
 * @returns the exit status, or nothing when this was not an exit.
 */
function systemExitStatus(error: unknown): number | undefined {
  if ((error as { type?: unknown }).type !== 'SystemExit') return undefined
  const message = error instanceof Error ? error.message : String(error)
  const carried = /SystemExit:\s*(.*)$/m.exec(message)?.[1]?.trim() ?? ''
  if (carried === '' || carried === 'None') return 0
  if (/^-?\d+$/.test(carried)) return Number(carried)
  // `exit("say why")` prints the reason and exits 1, as CPython does.
  process.stderr.write(`${carried}\n`)
  return 1
}

/** How a package manager that is not pip explains itself. */
const PIP_HELP = [
  'usage: pip <command> [options]',
  '',
  'This is micropip behind pip\'s command line, because there is no compiler here:',
  'a package installs when PyPI has a pure-Python wheel for it, or when Pyodide has',
  'built it for WebAssembly (numpy, pandas, scipy, scikit-learn, matplotlib and',
  '~350 others). A package that needs to compile C at install time cannot.',
  '',
  'Commands:',
  '  install <name> ...   install packages; -r <file>, --upgrade, --no-deps, --pre,',
  '                       -i <index-url>',
  '  uninstall <name> ... remove packages',
  '  list                 what is installed',
  '  freeze               the same, as requirements',
  '  show <name> ...      metadata for an installed package',
  '',
  'Not available: download, wheel, cache, config, index, check, hash, debug.',
  'Refused rather than quietly ignored, because they would change where or what',
  'gets installed: --target, --platform, --python-version, --no-binary, --only-binary,',
  '--editable, --constraint, --find-links, --extra-index-url, --user, --prefix, --root.',
].join('\n')

/** Run one `pip` command line. */
async function pip(args: string[]): Promise<number> {
  const command = args.find(argument => !argument.startsWith('-'))
  const flags = new Set(args.filter(argument => argument.startsWith('-')))
  if (flags.has('--version') || flags.has('-V')) {
    process.stdout.write(`pip (micropip, for CPython via Pyodide ${PYODIDE_VERSION})\n`)
    return 0
  }
  if (command === undefined || flags.has('-h') || flags.has('--help') || command === 'help') {
    process.stdout.write(`${PIP_HELP}\n`)
    return command === undefined ? 1 : 0
  }
  if (['download', 'wheel', 'cache', 'config', 'index', 'hash', 'debug', 'check'].includes(command)) {
    process.stderr.write(`pip: '${command}' is not available here — this is micropip behind pip's command line.\n`)
    return 1
  }
  if (!['install', 'uninstall', 'list', 'freeze', 'show'].includes(command)) {
    process.stderr.write(`ERROR: unknown command "${command}"\n`)
    return 1
  }

  const rest = args.slice(args.indexOf(command) + 1)
  let plan: Plan | undefined
  if (command === 'install') {
    const parsed = planInstall(rest)
    if ('error' in parsed) {
      process.stderr.write(`ERROR: ${parsed.error}\n`)
      return parsed.status
    }
    plan = parsed
  }

  const py = await boot({ stdin: Buffer.alloc(0), interactive: false })
  // Reporting what is installed needs no network and no package manager, so the
  // three read-only commands answer without loading one.
  if (command !== 'install' && command !== 'uninstall') {
    if (command === 'show') return show(py, rest.filter(argument => !argument.startsWith('-')))
    return report(py, command === 'freeze' || rest.includes('--format=freeze') ? 'freeze' : 'list')
  }

  await py.loadPackage('micropip', {
    messageCallback: () => undefined,
    errorCallback: (text: string) => { note(text) },
  })
  await py.runPythonAsync('import micropip')
  return plan === undefined ? uninstall(py, rest) : install(py, plan)
}

/** Every installed distribution, as `(name, version)` pairs, from Python. */
const DISTRIBUTIONS = '__import__("importlib.metadata", fromlist=["distributions"]).distributions()'

/**
 * pip options this cannot honour, and must not appear to.
 *
 * Ignoring one of these silently is the failure this whole build is written
 * against: `--target ./vendor` would report success and install somewhere else,
 * `--no-binary` would promise a source build that cannot happen here. Saying so
 * costs one line and saves the caller from believing the wrong thing.
 */
const REFUSED = new Set([
  '--target', '-t', '--platform', '--python-version', '--implementation', '--abi',
  '--no-binary', '--only-binary', '--editable', '-e', '--constraint', '-c',
  '--find-links', '-f', '--extra-index-url', '--user', '--prefix', '--root',
])

/** What one `pip install` line asks for. */
interface Plan {
  requirements: string[]
  indexes: string[]
  deps: boolean
  pre: boolean
  reinstall: boolean
}

/**
 * Read a `pip install` line.
 *
 * Separate from doing the install, and called before the interpreter starts:
 * an unusable command line should cost a message, not the three seconds it
 * takes to boot a Python that is about to be told it has nothing to do.
 * @param args - everything after `install`.
 * @returns what to install, or the error to report instead.
 */
function planInstall(args: string[]): Plan | { error: string, status: number } {
  const plan: Plan = { requirements: [], indexes: [], deps: true, pre: false, reinstall: false }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? ''
    if (argument === '-r' || argument === '--requirement') {
      const file = args[++index]
      if (file === undefined) return { error: '-r expects a file', status: 2 }
      if (!existsSync(file)) return { error: `Could not open requirements file: ${file}`, status: 1 }
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // pip's rule, not "everything after a hash": a URL fragment like
        // `…#egg=name` is part of the requirement, not a comment.
        const cleaned = line.replace(/(^|\s)#.*$/, '$1').trim()
        if (cleaned !== '' && !cleaned.startsWith('-')) plan.requirements.push(cleaned)
      }
      continue
    }
    if (argument === '-i' || argument === '--index-url' || argument.startsWith('--index-url=')) {
      const attached = argument.startsWith('--index-url=') ? argument.slice('--index-url='.length) : undefined
      const url = attached ?? args[++index]
      if (url === undefined || url === '') return { error: `${argument} expects a URL`, status: 2 }
      plan.indexes.push(url)
      continue
    }
    if (argument === '--no-deps') { plan.deps = false; continue }
    if (argument === '--pre') { plan.pre = true; continue }
    if (argument === '-U' || argument === '--upgrade' || argument === '--force-reinstall') {
      plan.reinstall = true
      continue
    }
    const named = argument.split('=')[0] ?? argument
    if (REFUSED.has(named)) return { error: `${named} is not available here — see \`pip help\`.`, status: 2 }
    // Everything else is a flag about how pip reports itself rather than about
    // what it installs — `-q`, `--no-cache-dir`, `--disable-pip-version-check` —
    // and ignoring one of those changes nothing about the result.
    if (argument.startsWith('-')) continue
    plan.requirements.push(argument)
  }
  if (plan.requirements.length === 0) return { error: 'You must give at least one requirement to install', status: 1 }
  return plan
}

/** Install packages, and say what actually arrived. */
async function install(py: Pyodide, plan: Plan): Promise<number> {
  const before = new Set(versions(py))
  try {
    py.globals.set('__dsh_reqs__', plan.requirements)
    py.globals.set('__dsh_indexes__', plan.indexes)
    await py.runPythonAsync(
      `await micropip.install(list(__dsh_reqs__), deps=${plan.deps ? 'True' : 'False'}, `
      + `pre=${plan.pre ? 'True' : 'False'}, reinstall=${plan.reinstall ? 'True' : 'False'}`
      + `${plan.indexes.length === 0 ? '' : ', index_urls=list(__dsh_indexes__)'})`,
    )
  } catch (error) {
    // micropip's own last line names the package and the reason, and it is the
    // one worth reading; everything above it is this file's stack.
    const message = (error instanceof Error ? error.message : String(error)).trim()
    const tail = message.split('\n').filter(line => line.trim() !== '').at(-1) ?? message
    process.stderr.write(`ERROR: ${tail.replace(/^[\w.]*Error:\s*/, '')}\n`)
    return 1
  }
  const arrived = versions(py).filter(entry => !before.has(entry))
  process.stdout.write(arrived.length === 0
    ? `Requirement already satisfied: ${plan.requirements.join(', ')}\n`
    : `Successfully installed ${arrived.map(entry => entry.replace('==', '-')).join(' ')}\n`)
  return 0
}

/** Remove packages. */
async function uninstall(py: Pyodide, args: string[]): Promise<number> {
  const names = args.filter(argument => !argument.startsWith('-'))
  if (names.length === 0) {
    process.stderr.write('ERROR: You must give at least one requirement to uninstall\n')
    return 1
  }
  py.globals.set('__dsh_names__', names)
  try {
    await py.runPythonAsync('micropip.uninstall(list(__dsh_names__))')
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).trim()
    process.stderr.write(`ERROR: ${message.split('\n').at(-1) ?? message}\n`)
    return 1
  }
  process.stdout.write(`Successfully uninstalled ${names.join(' ')}\n`)
  return 0
}

/** The installed distributions, as `name==version`. */
function versions(py: Pyodide): string[] {
  const listed = py.runPython(
    `"\\n".join(sorted(f'{d.metadata["Name"]}=={d.version}' for d in ${DISTRIBUTIONS}))`,
  )
  return String(listed).split('\n').filter(line => line !== '')
}

/** Print what is installed, in pip's two shapes. */
function report(py: Pyodide, shape: 'list' | 'freeze'): number {
  const installed = versions(py)
  if (shape === 'freeze') {
    if (installed.length > 0) process.stdout.write(`${installed.join('\n')}\n`)
    return 0
  }
  const rows = installed.map(entry => entry.split('=='))
  const width = Math.max(7, ...rows.map(row => (row[0] ?? '').length))
  process.stdout.write(`${'Package'.padEnd(width)} Version\n${'-'.repeat(width)} -------\n`)
  for (const [name, version] of rows) process.stdout.write(`${(name ?? '').padEnd(width)} ${version ?? ''}\n`)
  return 0
}

/** Print a package's metadata, as `pip show` does. */
function show(py: Pyodide, names: string[]): number {
  if (names.length === 0) {
    process.stderr.write('ERROR: Please provide a package name or names.\n')
    return 1
  }
  py.runPython(`
def __dsh_show__(name):
    """Format one installed distribution the way \`pip show\` does."""
    from importlib import metadata
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return ''
    meta = dist.metadata
    return '\\n'.join([
        f'Name: {meta["Name"]}',
        f'Version: {dist.version}',
        f'Summary: {meta["Summary"] or ""}',
        f'Home-page: {meta["Home-page"] or ""}',
        f'Author: {meta["Author"] or ""}',
        f'License: {meta["License"] or ""}',
        f'Location: {dist.locate_file("")}',
        f'Requires: {", ".join(r.split(" ")[0] for r in (dist.requires or []))}',
    ])
`)
  let missing = 0
  for (const name of names) {
    py.globals.set('__dsh_name__', name)
    const text = String(py.runPython('__dsh_show__(__dsh_name__)'))
    if (text === '') {
      process.stderr.write(`WARNING: Package(s) not found: ${name}\n`)
      missing += 1
      continue
    }
    process.stdout.write(`${text}\n`)
  }
  return missing === names.length ? 1 : 0
}

/**
 * Run one command, as the program the container calls.
 *
 * The wrappers the page writes into the harness's `bin` directory are four
 * names over this one file, and each says which of the two front ends it is
 * rather than inferring it from `argv[0]` — a shell that resolved the name
 * through a link or a copy would otherwise decide it.
 * @param role - which front end this invocation is.
 */
export function run(role: 'python' | 'pip'): void {
  const args = process.argv.slice(2)
  const started = role === 'python' ? python(args) : pip(args)
  started.then(
    (status) => {
      // `process.exitCode` rather than `process.exit`, so everything already
      // written to a pipe reaches the other end before this process is gone.
      process.exitCode = status
    },
    (error: unknown) => {
      process.stderr.write(`${role}: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
