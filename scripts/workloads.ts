/**
 * The jobs the agent is asked to do, and how each machine is asked to do them.
 *
 * A harness is complete when an agent can finish real work on it, and "real
 * work" is not one thing: it runs from a single file up to a project with
 * dependencies and tests that has to be got working. So this is a ladder — one
 * file, then two steps where the second reads what the first produced, then a
 * program, then a whole project — and each rung is stated once per machine
 * that can express it.
 *
 * Stated per machine rather than translated at run time, because the machines
 * are genuinely different: the container has Node, npm and a POSIX shell;
 * busybox Linux has ash, awk and vi and no package manager; FreeDOS has
 * `COPY CON`, batch files and 8.3 file names. The same rung on each of them is
 * the same *task* and a different job, and pretending otherwise would either
 * ask DOS for `node --test` or ask the container for something a batch file
 * could do.
 *
 * A rung a machine cannot express is absent rather than expected to fail. What
 * FreeDOS cannot do is not a defect in this deployment, and a suite that
 * recorded it as one would be measuring MS-DOS.
 *
 * One constraint on the acceptance checks themselves: each runs in its own
 * machine's shell, and those shells are not equally furnished. The container's
 * is WebContainer's `jsh` — no `wc`, `grep`, `sed`, `awk` or `printf`, no
 * input redirection, no `for` loop; `src/host/jsh-tool.ts` reads the real list
 * out of the container and tells the model. So the checks here are written in
 * what each machine actually has, which is narrower than what the agent is
 * free to use on it.
 */

/** How the acceptance check reaches the machine. */
export type Machine = 'node' | 'v86:linux' | 'v86:freedos'

/** One check run on the machine after the agent says it is done. */
export interface Check {
  /** The command to run there, in that machine's own shell. */
  command: string
  /** What its output has to contain. */
  expect: RegExp
  /** What to say when it does not. */
  because: string
}

/** One rung, on one machine. */
export interface Workload {
  /** Rung id, shared across machines. */
  id: string
  /** Which machine this statement is for. */
  machine: Machine
  /**
   * What this rung is, in the report.
   *
   * Deliberately a description of the work and not a duration. The ladder was
   * scoped in minutes — a rung that is one file up to one that is a project
   * with its dependencies — and then a capable model did the middle of it in
   * fifteen seconds. How long a job takes is a fact about the model; what the
   * job *is* is the thing this suite fixes.
   */
  scale: string
  /** How long the turn may run before it is called stuck. */
  timeoutMs: number
  /** The prompt, exactly as the agent receives it. */
  prompt: string
  /** What has to be true on the machine afterwards. */
  checks: Check[]
}

/** The marker every rung writes, so a check cannot pass on a leftover file. */
export const MARKER = 'KANGAROO'

export const WORKLOADS: Workload[] = [
  /* ── rung 1: one file, one exact string ─────────────────────────────────
     The whole chain in its smallest form: the model chose a tool, the tool
     reached a shell, the shell reached a filesystem, and the bytes are there.
     Anything that fails here fails everything above it. */
  {
    id: 'file',
    machine: 'node',
    scale: 'one file',
    timeoutMs: 180_000,
    prompt: `Create a file called w1.txt in the current directory whose entire contents are the single word ${MARKER}, `
      + 'with no other text. Then read it back to confirm.',
    checks: [{ command: 'cat w1.txt', expect: new RegExp(MARKER), because: 'w1.txt does not contain the word' }],
  },
  {
    id: 'file',
    machine: 'v86:linux',
    scale: 'one file',
    timeoutMs: 240_000,
    prompt: `Create a file called w1.txt whose entire contents are the single word ${MARKER}, with no `
      + 'other text. Put it in the working directory your shell tool runs in — not somewhere else on the '
      + 'disk. Then read it back with cat to confirm.',
    checks: [{ command: 'cat w1.txt', expect: new RegExp(MARKER), because: 'w1.txt does not contain the word' }],
  },
  {
    id: 'file',
    machine: 'v86:freedos',
    scale: 'one file',
    timeoutMs: 240_000,
    prompt: `Create a file called W1.TXT on the current drive whose entire contents are the single word ${MARKER}, `
      + 'with no other text. Then read it back with TYPE to confirm.',
    checks: [{ command: 'type w1.txt', expect: new RegExp(MARKER), because: 'W1.TXT does not contain the word' }],
  },

  /* ── rung 2: generate, then compute over what was generated ─────────────
     Two commands where the second depends on the first having really run, and
     an answer the model cannot supply from the prompt: it has to read what it
     produced. A shell that swallowed the first command leaves the second with
     nothing to count. */
  {
    id: 'tally',
    machine: 'node',
    scale: 'two steps, one derived from the other',
    timeoutMs: 300_000,
    prompt: 'Write the numbers 1 to 100, one per line, into nums.txt. Then compute their sum and write only that '
      + 'number — no words, no punctuation — into sum.txt. Verify both files before you finish.',
    checks: [
      // `tail` and `cat`, not `wc`: the container's shell is WebContainer's
      // `jsh`, whose command set `src/host/jsh-tool.ts` reads out of the
      // container and states to the model. It has no `wc`.
      { command: 'tail -n 1 nums.txt', expect: /(^|\D)100(\D|$)/, because: 'nums.txt does not end at 100' },
      { command: 'head -n 1 nums.txt', expect: /\b1\b/, because: 'nums.txt does not start at 1' },
      { command: 'cat sum.txt', expect: /5050/, because: 'sum.txt does not hold 5050' },
    ],
  },
  {
    id: 'tally',
    machine: 'v86:linux',
    scale: 'two steps, one derived from the other',
    timeoutMs: 420_000,
    prompt: 'Write the numbers 1 to 100, one per line, into nums.txt. Then compute their sum and write only that '
      + 'number — no words, no punctuation — into sum.txt. This machine is busybox: use the shell, awk or sed, '
      + 'and verify both files before you finish.',
    checks: [
      { command: 'wc -l nums.txt', expect: /(^|\D)100(\D|$)/, because: 'nums.txt does not have 100 lines' },
      { command: 'cat sum.txt', expect: /5050/, because: 'sum.txt does not hold 5050' },
    ],
  },
  {
    id: 'tally',
    machine: 'v86:freedos',
    scale: 'two steps, one derived from the other',
    timeoutMs: 480_000,
    prompt: 'Write the numbers 1 to 100, one per line, into NUMS.TXT, and write only their sum — the number and '
      + 'nothing else — into SUM.TXT. This is FreeDOS: a batch file with a FOR loop is the usual way. Check both '
      + 'files with TYPE before you finish.',
    checks: [
      { command: 'type sum.txt', expect: /5050/, because: 'SUM.TXT does not hold 5050' },
      { command: 'type nums.txt', expect: /(^|\D)100(\D|$)/, because: 'NUMS.TXT does not reach 100' },
    ],
  },

  /* ── rung 3: write a program, run it, use its output ────────────────────
     The first rung that needs the machine's own language rather than its
     shell's built-ins, and the first whose answer is wrong in a visible way if
     the program was never actually run. */
  {
    id: 'program',
    machine: 'node',
    scale: 'a program, run on given input',
    timeoutMs: 600_000,
    prompt: 'Write a Node.js script called caesar.js that takes a string and a shift as command-line arguments and '
      + 'prints the string with each ASCII letter rotated forward by that shift, wrapping within its own case and '
      + 'leaving every other character alone. Run it with the arguments "Attack at dawn!" and 3, and save exactly '
      + 'its output — nothing else — into cipher.txt.',
    checks: [
      { command: 'cat cipher.txt', expect: /Dwwdfn dw gdzq!/, because: 'cipher.txt does not hold the rotated text' },
      { command: 'node caesar.js Zebra 1', expect: /Afcsb/, because: 'caesar.js does not wrap within its case' },
    ],
  },
  {
    id: 'program',
    machine: 'v86:linux',
    scale: 'a program, run on given input',
    timeoutMs: 720_000,
    prompt: 'Write a shell script called caesar.sh that takes a string and a shift as arguments and prints the '
      + 'string with each ASCII letter rotated forward by that shift, wrapping within its own case and leaving '
      + 'every other character alone. This machine is busybox — ash, awk, sed and tr are what you have, and there '
      + 'is no bash. Make it executable, run it with "Attack at dawn!" and 3, and save exactly its output into '
      + 'cipher.txt.',
    checks: [
      { command: 'cat cipher.txt', expect: /Dwwdfn dw gdzq!/, because: 'cipher.txt does not hold the rotated text' },
      { command: 'sh caesar.sh Zebra 1', expect: /Afcsb/, because: 'caesar.sh does not wrap within its case' },
    ],
  },

  /* ── rung 4: a project that has to be got working ───────────────────────
     Several files, a dependency between them, a test runner, and an error path
     — and the finishing condition is not "the files exist" but "the tests
     pass", which the agent has to reach by running them and fixing what it
     finds. This is the one that takes a quarter of an hour. */
  {
    id: 'project',
    machine: 'node',
    scale: 'a project, its dependencies and its tests',
    timeoutMs: 1_800_000,
    prompt: `Build a Node.js project called pipeline, and get all of it working.

Build it directly in the current working directory: package.json goes at the top level, not inside a
new folder named after the project.

1. package.json with "type": "module" and a "test" script that runs: node --test
2. Install the npm package picocolors as a real dependency, from the registry.
3. src/stats.js exporting summarise(numbers) which returns { count, sum, mean, median }.
   The median of an even-length list is the mean of the two middle values.
4. bin/cli.js which reads a file given as its argument — one number per line — and prints
   count, sum, mean and median, using picocolors to colour the labels.
5. test/stats.test.js using node:test and node:assert, covering an empty list, an odd-length
   list and an even-length list.
6. data.txt containing exactly these numbers, one per line: 3 1 4 1 5 9 2 6
7. check.py, a Python 3 script that reads data.txt and prints its median, as an independent
   check that the JavaScript is right. This machine has a real python3.
8. Run npm test, run bin/cli.js on data.txt, and run check.py. Make all three work and make the
   two medians agree. Report the final output of each.

Use your shell tool for everything.`,
    checks: [
      { command: 'cat package.json', expect: /"type"\s*:\s*"module"/, because: 'package.json is not an ES module' },
      { command: 'ls node_modules/picocolors', expect: /package\.json/, because: 'picocolors was never installed from the registry' },
      { command: 'cat src/stats.js', expect: /summarise/, because: 'src/stats.js does not export summarise' },
      { command: 'npm test 2>&1 | tail -n 30', expect: /# fail 0\b/, because: 'the project\'s own tests do not pass' },
      { command: 'npm test 2>&1 | tail -n 30', expect: /# pass [1-9]/, because: 'the project has no passing tests' },
      { command: 'node bin/cli.js data.txt', expect: /3\.5/, because: 'the CLI does not report the median of data.txt' },
      { command: 'python3 check.py', expect: /3\.5/, because: 'the Python cross-check does not agree, or never ran' },
    ],
  },
  {
    id: 'project',
    machine: 'v86:linux',
    scale: 'a project, its dependencies and its tests',
    timeoutMs: 1_500_000,
    prompt: `Build a small shell project called mini-harness. This machine is busybox: ash, awk, sed, grep and vi, no bash and no package manager.

Build it directly in the current working directory, not inside a new folder named after the project.

Requirements:
1. harness.sh, which reads a step list from a file — one step per line, "tool argument" —
   and for each line runs the matching function from tools.sh, printing its result on its own line.
   An unknown tool must print a clear error naming it and exit non-zero.
2. tools.sh, defining at least two tools: upper (prints its argument in capitals) and
   count (prints the number of characters in its argument).
3. test.sh, which runs at least three cases — two tools in order, the results in that order,
   and the unknown-tool error — printing "PASS" per case and finishing with "ALL PASS"
   only when every case passed.
4. Run test.sh and make it print ALL PASS.`,
    checks: [
      { command: 'sh test.sh', expect: /ALL PASS/, because: 'test.sh does not report every case passing' },
      { command: 'wc -c harness.sh', expect: /[1-9]\d{1,}/, because: 'harness.sh is missing or trivial' },
      { command: 'wc -c tools.sh', expect: /[1-9]\d{1,}/, because: 'tools.sh is missing or trivial' },
    ],
  },
]
