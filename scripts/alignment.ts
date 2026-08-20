/**
 * How far this build's composition is from the one `dsh web` runs.
 *
 * The claim worth checking is not "it boots" but "it is the same system". The
 * composition is where that is decidable: `dsh web` is a list of rows with
 * configuration, this build applies an overlay on top, and every difference
 * between the two is either a browser cannot do that or a divergence someone
 * chose and should be able to defend.
 *
 * So this reads both — the upstream bundle patches from the installed packages,
 * and this deployment's overlay — and prints the difference as three lists:
 * rows this build disables, rows it adds, and rows whose configuration it
 * changes. Anything unexplained is a finding.
 *
 * Usage: `npx tsx scripts/alignment.ts`
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { MODEL_CATALOG_PATCH } from '../src/generated/model-catalog.ts'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One row as a patch layer names it. */
interface Row {
  id: string
  name?: string
  disabled?: boolean
  config?: unknown
}

/**
 * Read the rows a patch file declares.
 *
 * The patch format is YAML with dsh's `!!js` expressions in it, which no plain
 * parser will accept — and this does not need to evaluate them, only to see
 * which rows exist and which are turned off. So it reads the structure it needs
 * with a line scanner rather than pulling in a parser that would then have to
 * be taught a custom tag.
 * @param source - the patch file's text.
 * @returns the rows it declares.
 */
function readRows(source: string): { inserted: Row[], patched: Row[] } {
  const inserted: Row[] = []
  const patched: Row[] = []
  let inInsert = false
  let current: Row | undefined
  let target: Row[] = patched

  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue

    // `- insert:` opens a list of new rows; a top-level `- id:` patches one.
    if (/^- insert:\s*$/.test(line)) {
      inInsert = true
      target = inserted
      current = undefined
      continue
    }
    const topLevel = /^- (id|name):\s*(.+)$/.exec(line)
    if (topLevel !== null) {
      inInsert = false
      target = patched
      current = { id: topLevel[1] === 'id' ? topLevel[2].trim() : '' }
      if (topLevel[1] === 'name') current.name = topLevel[2].trim().replace(/^['"]|['"]$/g, '')
      target.push(current)
      continue
    }
    const nested = /^\s+- id:\s*(.+)$/.exec(line)
    if (nested !== null && inInsert) {
      current = { id: nested[1].trim() }
      target.push(current)
      continue
    }
    if (current === undefined) continue
    const field = /^\s+(name|disabled):\s*(.+)$/.exec(line)
    if (field === null) continue
    if (field[1] === 'name') current.name = field[2].trim().replace(/^['"]|['"]$/g, '')
    else current.disabled = field[2].trim() === 'true'
  }
  return { inserted, patched }
}

/** Read a patch file, or report it missing. */
function load(path: string): string {
  if (!existsSync(path)) {
    console.error(`missing: ${path}`)
    process.exit(1)
  }
  return readFileSync(path, 'utf8')
}

const upstream = [
  join(root, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),
  join(root, 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'),
].map(load)

// The overlay layer as the boot actually lays it down: the authored rows plus
// the provider roster `scripts/assemble.ts` derives from the installed pi-ai
// catalog. Reading only the authored half would report `llm-pi-ai` as composing
// exactly the way `dsh web` composes it, which is the one thing this script
// exists to catch.
const overlay = `${readFileSync(join(root, 'src/host/browser.patch.yml'), 'utf8')}\n${MODEL_CATALOG_PATCH}`
// Derived from the directory, not listed: a plugin this repository ships is a
// directory under `packages/`, and a hand-kept list is how one comes to be
// shipped without ever appearing in this report.
const shipped = readdirSync(join(root, 'packages'))
  .map(name => join(root, 'packages', name, 'cordis.patch.yml'))
  .filter(existsSync)
  .map(path => readFileSync(path, 'utf8'))

/** Everything `dsh web` composes, by row id. */
const composed = new Map<string, Row>()
for (const source of upstream) {
  const { inserted, patched } = readRows(source)
  for (const row of inserted) composed.set(row.id, row)
  for (const row of patched) {
    const existing = composed.get(row.id)
    if (existing === undefined) composed.set(row.id, row)
    else Object.assign(existing, row)
  }
}

const { inserted: added, patched: changed } = readRows(overlay)
const shippedRows = shipped.flatMap(source => readRows(source).inserted)
// A shipped plugin may turn a row off as well as add one — the browser
// overlay disables `tool-bash` because `browser:machine` replaces the
// model's shell tool outright.
// Counting only the overlay's own patches would report that row as composing
// exactly as upstream does, which is the one thing this script exists to catch.
const shippedPatches = shipped.flatMap(source => readRows(source).patched)

const disabled = [...changed, ...shippedPatches].filter(row => row.disabled === true)
const reconfigured = changed.filter(row => row.disabled !== true)
const unknown = [...changed, ...shippedPatches].filter(row => !composed.has(row.id))

process.stdout.write(`dsh web composes ${String(composed.size)} rows.\n\n`)

process.stdout.write(`── disabled by this build (${String(disabled.length)}) ──\n`)
for (const row of disabled) {
  const upstreamRow = composed.get(row.id)
  process.stdout.write(`  ${row.id}${upstreamRow?.name === undefined ? '' : `  (${upstreamRow.name})`}\n`)
}

process.stdout.write(`\n── replaced or added by this build (${String(added.length)}) ──\n`)
for (const row of added) process.stdout.write(`  ${row.id}  → ${row.name ?? '?'}\n`)

process.stdout.write(`\n── shipped as plugins (${String(shippedRows.length)}) ──\n`)
for (const row of shippedRows) process.stdout.write(`  ${row.id}  → ${row.name ?? '?'}\n`)

process.stdout.write(`\n── reconfigured, not disabled (${String(reconfigured.length)}) ──\n`)
for (const row of reconfigured) process.stdout.write(`  ${row.id}\n`)

if (unknown.length > 0) {
  process.stdout.write(`\n── patches a row dsh web does not compose (${String(unknown.length)}) ──\n`)
  for (const row of unknown) process.stdout.write(`  ${row.id}\n`)
}

const touched = disabled.length + added.length + reconfigured.length
process.stdout.write(
  `\n${String(touched)} of ${String(composed.size)} rows differ; `
  + `${String(composed.size - touched)} compose exactly as \`dsh web\` composes them.\n`,
)
