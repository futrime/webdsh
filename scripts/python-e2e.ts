/**
 * End-to-end check for Python in the runtime.
 *
 * The claim under test is not "Python runs" but the one the tool description
 * makes: that `python3` and `pip` are on this machine, that the machine is the
 * *same* machine the terminal and the agent already share, and that a package
 * installed once stays installed — across commands, and across a reload.
 *
 * So it drives three surfaces rather than one. `dsh.shell` is the agent's path,
 * the terminal is the user's, and a reload is what a returning visitor does.
 * A Python that passed the first and failed the second would be exactly the
 * split machine this build exists to avoid.
 *
 * Usage: `npx tsx scripts/python-e2e.ts [--url <url>] [--case <name>] [--headed]`
 */

import { chromium, type Page } from 'playwright'

const args = process.argv.slice(2)
const url = valueOf('--url') ?? 'http://127.0.0.1:4173/'
const only = valueOf('--case')
const headed = args.includes('--headed')

/** Read a `--flag value` pair from argv. */
function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Assert a condition, failing the check with a readable message. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** Wait until the app's own boot screen is gone and the shell rendered. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return root !== null && root.childElementCount > 0 && document.getElementById('dshw-boot') === null
  }, undefined, { timeout: 180_000 })
}

/** What one command produced, as the agent would see it. */
interface Outcome {
  status: number
  out: string
}

/**
 * Run one command through the harness's own path.
 *
 * Both streams are returned joined, because that is how the runtime reports a
 * command and how the agent reads one — and because the interpreter writes its
 * progress to standard error while the program writes its answer to standard
 * output, so a check that looked at only one of them would miss half of what
 * this suite is about.
 * @param page - the loaded app.
 * @param script - the shell source to run.
 * @returns the exit status and everything the command wrote.
 */
async function shell(page: Page, script: string): Promise<Outcome> {
  const result = await page.evaluate(async (source: string) => globalThis.dsh.shell(source), script)
  // Colour stripped before anything matches on it: `python3 -m json.tool` and
  // `pip` both write SGR codes into their output, and a pattern anchored on a
  // quote or a word boundary sees the escape's letters as neighbouring text.
  return { status: result.status, out: `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '') }
}

/** Run a command and require it to have succeeded. */
async function ok(page: Page, script: string): Promise<string> {
  const result = await shell(page, script)
  expect(result.status === 0, `\`${script}\` exited ${String(result.status)}:\n    ${result.out.replace(/\n/g, '\n    ')}`)
  return result.out
}

/** One check. */
interface Check {
  name: string
  run(page: Page): Promise<void>
}

/** Whether this page already has a terminal open. */
let terminalOpen = false

/**
 * Open the terminal through the plugin's own sidebar action.
 *
 * The surface shows its notice over everything until it is acknowledged, and a
 * click that lands on that mask never reaches the button — so the notice is
 * dismissed first and the action is invoked on the element itself.
 *
 * Called at most once per load, because the action is a *toggle*: a second
 * check that opened it again would close it, and every `send` after that would
 * go nowhere while the buffer still showed a prompt.
 * @param page - the page to drive.
 */
async function openTerminal(page: Page): Promise<void> {
  if (terminalOpen) return
  const acknowledge = page.getByRole('button', { name: /Continue/ })
  await acknowledge.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
  if (await acknowledge.count() > 0) {
    await acknowledge.first().click().catch(() => undefined)
    await acknowledge.first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  }
  const action = page.getByRole('button', { name: /Terminal/ })
  await action.first().waitFor({ state: 'visible', timeout: 30_000 })
  await action.first().evaluate((node: HTMLElement) => { node.click() })
  await page.waitForFunction(
    () => /[❯$]\s*$/m.test((globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''),
    undefined,
    { timeout: 300_000 },
  )
  terminalOpen = true
}

/**
 * Wait for something to appear on the terminal, and say what was there instead.
 *
 * A bare `waitForFunction` that times out reports only that it timed out, which
 * for a screen is the least useful half of the answer.
 * @param page - the page driving the terminal.
 * @param pattern - what to wait for.
 * @param what - how to describe it in a failure.
 * @param timeoutMs - how long to wait.
 */
async function waitForScreen(page: Page, pattern: RegExp, what: string, timeoutMs = 60_000): Promise<void> {
  try {
    // Source *and* flags: a pattern rebuilt from `source` alone loses `m`, and
    // then `^` and `$` anchor to the whole screen rather than to a line — which
    // is a wait that silently never matches.
    await page.waitForFunction(
      ([source, flags]: [string, string]) => new RegExp(source, flags).test(
        (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''),
      [pattern.source, pattern.flags] as [string, string],
      { timeout: timeoutMs },
    )
  } catch {
    const screen = await page.evaluate(() =>
      (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? '(no terminal)')
    throw new Error(`${what} never appeared; the terminal showed:\n${screen.split('\n').slice(-30).join('\n')}`)
  }
}

/**
 * Type a line into whatever is reading the terminal, until it answers.
 *
 * The prompt appearing and the program being ready to read are not the same
 * moment: bytes sent in the gap between them are dropped, and the reader waits
 * forever for a line that was already typed. A person retypes; this does too,
 * which is also the closest thing to what a person would see.
 * @param page - the page driving the terminal.
 * @param line - what to type, without its newline.
 * @param answer - what the reader should print in reply.
 * @param what - how to describe the exchange in a failure.
 */
async function typeInto(page: Page, line: string, answer: RegExp, what: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate((text: string) => {
      (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__?.send(`${text}\n`)
    }, line)
    const answered = await page.waitForFunction(
      ([source, flags]: [string, string]) => new RegExp(source, flags).test(
        (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''),
      [answer.source, answer.flags] as [string, string],
      { timeout: 15_000 },
    ).then(() => true, () => false)
    if (answered) return
  }
  const screen = await page.evaluate(() =>
    (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? '(no terminal)')
  throw new Error(`${what} never answered; the terminal showed:\n${screen.split('\n').filter(l => l.trim() !== '').slice(-20).join('\n')}`)
}

let counter = 0

/**
 * Type one command into the terminal and wait for it to finish.
 *
 * A prompt is not a reliable "finished" signal — it appears in the middle of
 * output as often as at the end — so a unique marker is echoed after the
 * command, and it carries the exit status back with it.
 * @param page - the page driving the terminal.
 * @param script - what to type.
 * @param timeoutMs - how long the command may take.
 * @returns the terminal text around the marker.
 */
async function terminal(page: Page, script: string, timeoutMs = 180_000): Promise<string> {
  const marker = `__done_${String(counter++)}`
  await page.evaluate(
    ([source, sentinel]) => {
      const view = (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__
      view?.send(`${source}; echo ${sentinel}:$?\n`)
    },
    [script, marker] as const,
  )
  await page.waitForFunction(
    (sentinel: string) => {
      const text = (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''
      return new RegExp(`${sentinel}:\\d`).test(text)
    },
    marker,
    { timeout: timeoutMs },
  )
  const screen = await page.evaluate(() =>
    (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? '')
  const lines = screen.split('\n')
  const end = lines.findLastIndex(line => new RegExp(`${marker}:\\d`).test(line))
  return end === -1 ? lines.slice(-40).join('\n') : lines.slice(Math.max(0, end - 40), end + 1).join('\n')
}

const checks: Check[] = [
  {
    // The whole feature rests on one fact about `jsh`: it resolves a command
    // against the `PATH` it was spawned with. If the harness's directory is not
    // in front, `python3` is the container's RustPython and every check below
    // would pass against the wrong interpreter.
    name: 'python3 is the harness\'s, not the container\'s',
    async run(page) {
      const which = await ok(page, 'which python3')
      expect(/\.dsh\/bin\/python3/.test(which), `python3 resolves elsewhere: ${which.trim()}`)
      const version = await ok(page, 'python3 -V')
      expect(/Python 3\.1[4-9]/.test(version), `unexpected version: ${version.trim()}`)
      expect(!/RustPython/.test(version), `this is still RustPython: ${version.trim()}`)
      const pip = await ok(page, 'which pip')
      expect(/\.dsh\/bin\/pip/.test(pip), `pip resolves elsewhere: ${pip.trim()}`)
    },
  },
  {
    // Every one of these is something RustPython could not do, which is why
    // they are the ones asserted.
    name: 'the standard library is the real one',
    async run(page) {
      const out = await ok(page, 'python3 -c "import pathlib, sqlite3, decimal, dataclasses, typing, csv, zipfile; '
        + 'print(pathlib.Path(\'.\').resolve(), sqlite3.sqlite_version)"')
      expect(/\/home\/dsh\/workspace/.test(out), `pathlib did not resolve the working directory:\n${out}`)
      const math = await ok(page, 'python3 -c "import statistics, fractions; '
        + 'print(statistics.median([3,1,2]), fractions.Fraction(1,3) + fractions.Fraction(1,6))"')
      expect(/2 1\/2/.test(math), `the standard library computed the wrong answer:\n${math}`)
    },
  },
  {
    name: 'the shell\'s files are Python\'s files',
    async run(page) {
      await ok(page, 'echo hello-from-the-shell > shared.txt')
      const read = await ok(page, 'python3 -c "print(open(\'shared.txt\').read().strip().upper())"')
      expect(/HELLO-FROM-THE-SHELL/.test(read), `Python could not read the shell's file:\n${read}`)
      await ok(page, 'python3 -c "open(\'from-python.txt\', \'w\').write(\'hello-from-python\')"')
      const back = await ok(page, 'cat from-python.txt')
      expect(/hello-from-python/.test(back), `the shell could not read Python's file:\n${back}`)
    },
  },
  {
    name: 'scripts, modules, stdin and arguments',
    async run(page) {
      await ok(page, 'node -e \'const nl=String.fromCharCode(10); require("fs").writeFileSync("script.py", '
        + '["import sys", "print(\\"argv\\", sys.argv[1:])", "sys.exit(3)"].join(nl))\'')
      const script = await shell(page, 'python3 script.py alpha beta')
      expect(/argv \['alpha', 'beta'\]/.test(script.out), `sys.argv is wrong:\n${script.out}`)
      expect(script.status === 3, `sys.exit(3) reported ${String(script.status)}`)

      const module = await ok(page, 'echo \'{"b":2,"a":1}\' > j.json && python3 -m json.tool --sort-keys j.json')
      expect(/"a": 1[\s\S]*"b": 2/.test(module), `\`python3 -m json.tool\` did not sort:\n${module}`)

      const piped = await ok(page, 'echo "print(6*7)" | python3 -')
      expect(/\b42\b/.test(piped), `a program on standard input did not run:\n${piped}`)

      const stdin = await ok(page, 'echo tea | python3 -c "import sys; print(sys.stdin.read().strip().upper())"')
      expect(/TEA/.test(stdin), `Python could not read piped input:\n${stdin}`)

      // `-uc` is one option group, not an unknown option: CPython accepts it and
      // scripts written by habit pass `-u`.
      const bundled = await ok(page, 'python3 -uc "print(\'bundled flags\')"')
      expect(/bundled flags/.test(bundled), `a combined option group did not run:\n${bundled}`)
      // `-X` and `-W` carry their value attached as often as separated.
      const valued = await ok(page, 'python3 -Xdev -Wignore -c "print(\'valued flags\')"')
      expect(/valued flags/.test(valued), `an attached option value was not accepted:\n${valued}`)
      const unknown = await shell(page, 'python3 -Z -c "print(1)"')
      expect(unknown.status === 2 && /Unknown option/.test(unknown.out), `an unknown option was accepted:\n${unknown.out}`)
    },
  },
  {
    name: 'exit codes and tracebacks are CPython\'s',
    async run(page) {
      const clean = await shell(page, 'python3 -c "print(1)"')
      expect(clean.status === 0, `a working command exited ${String(clean.status)}`)
      const raised = await shell(page, 'python3 -c "1/0"')
      expect(raised.status === 1, `an uncaught exception exited ${String(raised.status)}`)
      expect(/Traceback \(most recent call last\)[\s\S]*ZeroDivisionError: division by zero/.test(raised.out),
        `the traceback is not CPython's:\n${raised.out}`)
      // The wrapper that runs the program must not appear in the user's
      // traceback; if it does, every error the agent reads names a file it
      // cannot open.
      expect(!/__dsh_run__|_pyodide|runpy/.test(raised.out), `the traceback exposes the harness:\n${raised.out}`)
      const missing = await shell(page, 'python3 no-such-file.py')
      expect(missing.status === 2, `a missing script exited ${String(missing.status)}`)
      expect(/can't open file/.test(missing.out), `unexpected message for a missing script:\n${missing.out}`)
      const exit = await shell(page, 'python3 -c "raise SystemExit(7)"')
      expect(exit.status === 7, `SystemExit(7) reported ${String(exit.status)}`)
      // `bool` is an `int` in Python, and CPython exits 1 here.
      const truthy = await shell(page, 'python3 -c "import sys; sys.exit(True)"')
      expect(truthy.status === 1, `sys.exit(True) reported ${String(truthy.status)}`)
      // A script's traceback goes through a different path than `-c`, and it is
      // the path that used to carry runpy's frames into the user's output.
      await ok(page, 'node -e \'const nl=String.fromCharCode(10); require("fs").writeFileSync("boom.py", '
        + '["def inner():", "    raise ValueError(\\"from a script\\")", "inner()"].join(nl))\'')
      const script = await shell(page, 'python3 boom.py')
      expect(script.status === 1, `a raising script exited ${String(script.status)}`)
      expect(/File "\/home\/dsh\/workspace\/boom\.py", line 2, in inner[\s\S]*ValueError: from a script/.test(script.out),
        `the script traceback does not name the user's file:\n${script.out}`)
      expect(!/runpy|__dsh_run__|_pyodide/.test(script.out), `the script traceback exposes the harness:\n${script.out}`)
    },
  },
  {
    name: 'text is bytes: unicode survives the trip',
    async run(page) {
      const out = await ok(page, 'python3 -c "print(\'héllo — 世界\')"')
      expect(/héllo — 世界/.test(out), `unicode did not survive:\n${out}`)
    },
  },
  {
    name: 'pip installs a wheel from PyPI, and it stays installed',
    async run(page) {
      const install = await shell(page, 'pip install six')
      expect(install.status === 0, `pip install failed:\n${install.out}`)
      expect(/Successfully installed six-|already satisfied/.test(install.out), `pip said nothing useful:\n${install.out}`)
      // A *separate* invocation: the interpreter is a fresh process each time,
      // so this is what proves the packages live in the container rather than
      // in one process's memory.
      const imported = await ok(page, 'python3 -c "import six; print(\'six\', six.__version__)"')
      expect(/six 1\./.test(imported), `the installed package did not import:\n${imported}`)
      const listed = await ok(page, 'pip list')
      expect(/six/.test(listed), `pip list does not show it:\n${listed}`)
      const frozen = await ok(page, 'pip freeze')
      expect(/^six==\d/m.test(frozen), `pip freeze is not requirements-shaped:\n${frozen}`)
      const shown = await ok(page, 'pip show six')
      expect(/Name: six[\s\S]*Version: 1\./.test(shown), `pip show is not pip-shaped:\n${shown}`)
      // Progress belongs on standard error: a caller that redirects standard
      // output must get the answer and nothing else.
      const redirected = await ok(page, 'pip install six > pip-stdout.txt && cat pip-stdout.txt')
      expect(!/Loading |attempting to load|caching the wheel/.test(redirected),
        `interpreter progress reached standard output:\n${redirected}`)
    },
  },
  {
    name: 'pip installs a package Pyodide built for WebAssembly',
    async run(page) {
      const install = await shell(page, 'pip install numpy')
      expect(install.status === 0, `installing numpy failed:\n${install.out}`)
      const used = await ok(page, 'python3 -c "import numpy; print(\'numpy\', numpy.__version__, numpy.arange(5).sum())"')
      expect(/numpy \d+\.\d+.*\b10\b/.test(used), `numpy did not compute:\n${used}`)
    },
  },
  {
    name: 'pip fails clearly, and `python3 -m pip` is the same pip',
    async run(page) {
      const missing = await shell(page, 'pip install dsh-web-no-such-package-12345')
      expect(missing.status !== 0, 'installing a package that does not exist reported success')
      expect(/ERROR:/.test(missing.out), `the failure is not pip-shaped:\n${missing.out}`)
      expect(!/Traceback/.test(missing.out), `the failure is a stack trace rather than a message:\n${missing.out}`)
      const viaModule = await ok(page, 'python3 -m pip --version')
      expect(/micropip/.test(viaModule), `\`python3 -m pip\` is not the same pip:\n${viaModule}`)
      // A flag that would change where or what gets installed must be refused
      // rather than ignored, and refused before anything is downloaded.
      const refused = await shell(page, 'pip install --target ./vendor six')
      expect(refused.status === 2 && /not available here/.test(refused.out),
        `--target was not refused:\n${refused.out}`)
      // A requirements file is how a project's dependencies actually arrive.
      await ok(page, 'echo "six  # the compatibility one" > requirements.txt')
      const fromFile = await shell(page, 'pip install -r requirements.txt')
      expect(fromFile.status === 0 && /installed six-|already satisfied/.test(fromFile.out),
        `installing from a requirements file failed:\n${fromFile.out}`)
      const removed = await shell(page, 'pip uninstall six')
      expect(removed.status === 0, `pip uninstall failed:\n${removed.out}`)
      const gone = await shell(page, 'python3 -c "import six"')
      expect(gone.status === 1 && /ModuleNotFoundError/.test(gone.out), `the package survived uninstall:\n${gone.out}`)
    },
  },
  {
    // The boundary the tool description draws, asserted from both sides: what
    // cannot work has to fail with the message the model was promised, and the
    // one way out has to actually work.
    name: 'what Python can and cannot reach',
    async run(page) {
      const spawned = await shell(page, 'python3 -c "import subprocess; subprocess.run([\'echo\', \'x\'])"')
      expect(spawned.status === 1, `subprocess exited ${String(spawned.status)}`)
      expect(/does not support processes/.test(spawned.out), `unexpected subprocess failure:\n${spawned.out}`)
      const opened = await shell(page, 'python3 -c "import os; os.popen(\'echo x\')"')
      expect(opened.status === 1 && /does not support processes/.test(opened.out),
        `unexpected os.popen failure:\n${opened.out}`)
      const threaded = await shell(page, 'python3 -c "import threading; threading.Thread(target=print).start()"')
      expect(threaded.status === 1 && /can't start new thread/.test(threaded.out),
        `unexpected threading failure:\n${threaded.out}`)
      // `os.system` is the exception: Emscripten runs it through the container's
      // own shell, so it works — and a description that said otherwise would
      // send the model looking for a way around something that is not in its way.
      const system = await shell(page, 'python3 -c "import os; print(\'rc\', os.system(\'echo through-the-shell\'))"')
      expect(system.status === 0 && /through-the-shell[\s\S]*rc 0/.test(system.out),
        `os.system did not reach the shell:\n${system.out}`)
      const failed = await ok(page, 'python3 -c "import os; print(\'rc\', os.system(\'no-such-command-here\'))"')
      expect(/rc 32512/.test(failed), `os.system did not report the shell's status:\n${failed}`)
      // `urllib.parse` has no socket in it and must keep working; it is the half
      // of `urllib` the description does not say raises.
      const parsed = await ok(page, 'python3 -c "from urllib.parse import urlparse; print(urlparse(\'https://a/b\').path)"')
      expect(/\/b/.test(parsed), `urllib.parse does not work:\n${parsed}`)
      await ok(page, 'node -e \'const nl=String.fromCharCode(10); require("fs").writeFileSync("net.py", '
        + '["import asyncio", "from pyodide.http import pyfetch", "async def go():", '
        + '"    r = await pyfetch(\\"https://pypi.org/pypi/six/json\\")", "    return r.status", '
        + '"print(\\"status\\", asyncio.run(go()))"].join(nl))\'')
      const fetched = await shell(page, 'python3 net.py')
      expect(fetched.status === 0 && /status 200/.test(fetched.out), `pyfetch did not reach the network:\n${fetched.out}`)
    },
  },
  {
    name: 'the terminal and the agent are the same Python',
    async run(page) {
      await openTerminal(page)
      const version = await terminal(page, 'python3 -V')
      expect(/Python 3\.1[4-9]/.test(version), `the terminal has a different Python:\n${version}`)
      // numpy was installed through the agent's path; if the terminal cannot
      // import it, they are two machines that merely look alike. The assertion
      // is on a *computed* value, because the emulator echoes the command line
      // — a marker that appears in what was typed would pass without running.
      const shared = await terminal(page, 'python3 -c "import numpy; print(\'numpy-here\', numpy.arange(4).sum())"')
      expect(/numpy-here 6\b/.test(shared), `the terminal cannot see the agent's packages:\n${shared}`)
      await terminal(page, 'python3 -c "open(\'from-terminal.txt\',\'w\').write(\'typed\')"')
      const seen = await ok(page, 'cat from-terminal.txt')
      expect(/typed/.test(seen), `the agent cannot see what the terminal's Python wrote:\n${seen}`)
    },
  },
  {
    name: 'the interactive interpreter answers',
    async run(page) {
      await openTerminal(page)
      await page.evaluate(() => {
        (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__?.send('python3\n')
      })
      await waitForScreen(page, />>>\s*$/m, 'the interpreter prompt', 120_000)
      // A product no other line in the scrollback contains, matched loosely
      // because the emulator's buffer is a fixed grid and pads every line with
      // the spaces to its right.
      await typeInto(page, '123 * 456', /\b56088\b/, 'the interpreter')
      // A block: the console, not this suite, is what decides that `def` is
      // unfinished and that a blank line ends it. The lines in the middle are
      // sent without retrying, because by now the channel has carried a line
      // and because retyping half a block would be a syntax error rather than
      // a second chance.
      await typeInto(page, 'def twice(n):', /^\.\.\.\s*$/m, 'the continuation prompt')
      await page.evaluate(() => {
        const view = (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__
        view?.send('    return n * 2\n')
        view?.send('\n')
      })
      await waitForScreen(page, /^>>>\s*$/m, 'the prompt after the block')
      await typeInto(page, 'twice(21)', /\b42\b/, 'a function defined across lines')
      // Left at a prompt, the next check would type into Python rather than the
      // shell, so the session is ended the way a person ends one — and proved
      // ended by running a shell command, because a prompt on screen may be one
      // that scrolled past rather than the one waiting for input.
      // Retried as a pair: if the `exit()` is the keystroke that gets dropped,
      // the `echo` lands in Python instead and raises, and the next attempt
      // sends both again. Matching a whole line is what tells the echo of the
      // command apart from its output.
      let left = false
      for (let attempt = 0; attempt < 4 && !left; attempt++) {
        await page.evaluate(() => {
          const view = (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__
          view?.send('exit()\n')
        })
        await page.waitForTimeout(1500)
        await page.evaluate(() => {
          const view = (globalThis as { __DSH_TERMINAL__?: { send(text: string): void } }).__DSH_TERMINAL__
          view?.send('echo out-of-the-repl\n')
        })
        left = await page.waitForFunction(
          () => /^out-of-the-repl$/m.test(
            (globalThis as { __DSH_TERMINAL__?: { text(): string } }).__DSH_TERMINAL__?.text() ?? ''),
          undefined,
          { timeout: 15_000 },
        ).then(() => true, () => false)
      }
      expect(left, 'the shell did not come back after exit()')
    },
  },
  {
    // The promise the README makes to a returning visitor: the interpreter is
    // fetched once, and what was installed into it is still there.
    name: 'a reload keeps the interpreter and the packages',
    async run(page) {
      await ok(page, 'pip install six')
      await page.evaluate(async () => { await globalThis.dsh.flush() })
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })
      terminalOpen = false
      await waitForShell(page)
      const after = await shell(page, 'python3 -c "import six, numpy; print(\'both survived\', six.__version__)"')
      expect(after.status === 0, `Python did not survive the reload:\n${after.out}`)
      expect(/both survived/.test(after.out), `the installed packages did not survive:\n${after.out}`)
      expect(!/Installing Python/.test(after.out), `the interpreter was downloaded again:\n${after.out}`)
    },
  },
]

/** Run the selected checks. */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error: Error) => { errors.push(error.message) })

  let failures = 0
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForShell(page)
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
    expect(isolated, 'the page is not cross-origin isolated, so the runtime cannot start')

    for (const check of checks) {
      if (only !== undefined && check.name !== only) continue
      process.stdout.write(`▶ ${check.name}\n`)
      const started = Date.now()
      try {
        await check.run(page)
        process.stdout.write(`  ✓ ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
      } catch (error) {
        failures++
        process.stdout.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
        await page.screenshot({ path: `/tmp/dsh-python-${check.name.replace(/\W+/g, '-')}.png` }).catch(() => undefined)
      }
    }
  } finally {
    await browser.close()
  }

  if (errors.length > 0) process.stdout.write(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}\n`)
  process.stdout.write(failures === 0 ? '\n✓ Python works\n' : `\n✗ ${String(failures)} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
