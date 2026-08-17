import { chromium } from 'playwright'
const key = process.env.DEEPSEEK_API_KEY
const url = process.argv[2] ?? 'http://127.0.0.1:4173/'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const problems = []
p.on('pageerror', e => problems.push('[pageerror] ' + String(e).slice(0, 200)))
p.on('console', m => { if (m.type() === 'error') problems.push('[console] ' + m.text().slice(0, 200)) })
await p.goto(url, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => document.getElementById('dshw-boot') === null, undefined, { timeout: 180000 })
await p.waitForTimeout(2500)

const TASK = `Build a small Node.js project called mini-harness in the current directory.

Requirements:
1. package.json with "type": "module" and a "test" script that runs: node --test
2. src/harness.js exporting a class Harness with:
   - registerTool(name, handler)
   - async run(steps) where each step is {tool, input}; it calls each tool in order,
     collects results, and throws a clear Error naming the tool if one is not registered.
3. test/harness.test.js using node:test and node:assert covering: registering and running
   two tools, results in order, and the error for an unknown tool.
4. Run the tests with npm test and make them pass.

Use your bash tool to create files and run the tests. Report the final test output verbatim.`

console.log('--- running the task (this takes a few minutes) ---')
const started = Date.now()
const reply = await p.evaluate(async ([k, task]) => {
  try { return await globalThis.dsh.promptOnce(k, task) } catch (e) { return 'THREW: ' + String(e && e.message || e) }
}, [key, TASK])
console.log(`--- agent finished in ${Math.round((Date.now() - started) / 1000)}s ---`)
console.log(reply.slice(-2500))

console.log('\n--- what actually landed on disk ---')
console.log(await p.evaluate(async () => {
  const out = []
  for (const cmd of [
    'ls -la',
    'cat package.json',
    'find . -name "*.js" -not -path "./node_modules/*"',
    'npm test 2>&1 | tail -n 25',
  ]) {
    const r = await globalThis.dsh.shell(cmd)
    out.push(`$ ${cmd}\n[${r.status}] ${((r.stdout||'')+(r.stderr||'')).trim().slice(0, 900)}`)
  }
  return out.join('\n\n')
}))
if (problems.length) console.log('\n--- page problems ---\n' + [...new Set(problems)].slice(0, 10).join('\n'))
await b.close()
