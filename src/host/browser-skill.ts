/**
 * The skill that teaches a session how to drive its browser well.
 *
 * `src/host/browser-tools.ts` describes each tool; this describes the *job* —
 * which of them to reach for, what a task space is for, how to wait for a
 * popup, what to do when a run was interrupted halfway through a form. That is
 * a different kind of knowledge and it belongs in a different place: a tool
 * description is read on every request whether or not the session is browsing,
 * and this is thousands of words that only matter once a model has decided to.
 *
 * It is registered rather than provided from a directory, because the shipped
 * skill providers read the filesystem at discovery time and this build's
 * markdown is part of the bundle. The reference files *are* written to the
 * filesystem, under the deployment's own root, so that `read` can open the one
 * the skill points at — a reference nobody can open is a reference that does
 * not exist.
 */

import type { Context } from '@deepseek-ai/cordis'
import { volume } from '../vfs/volume.ts'
import { toBytes } from '../node/binary.ts'
import { DEPLOY_ROOT } from './seed.ts'
import skillSource from './skills/browser/SKILL.md?raw'
import recipesSource from './skills/browser/references/recipes.md?raw'
import extractionSource from './skills/browser/references/extraction.md?raw'
import helpersSource from './skills/browser/references/helpers.md?raw'
import recoverySource from './skills/browser/references/recovery.md?raw'
import machineSource from './skills/browser/references/machine.md?raw'

/** Where the skill's own files live, so the model can read them. */
const SKILL_ROOT = `${DEPLOY_ROOT}/config/skills/browser`

/** The files that go with the skill, by name. */
const REFERENCES: Record<string, string> = {
  'references/recipes.md': recipesSource,
  'references/extraction.md': extractionSource,
  'references/helpers.md': helpersSource,
  'references/recovery.md': recoverySource,
  'references/machine.md': machineSource,
}

/**
 * Split a skill file into the fields its frontmatter states and the body.
 *
 * The registry takes the description as a field rather than as text, and the
 * file states it once, at the top. Restating it here as a constant gave the
 * same sentence two homes — and they had already drifted apart by the time
 * anybody looked.
 * @param source - the markdown file.
 * @returns the description the frontmatter gives, and the body below it.
 */
function parseSkill(source: string): { description: string, body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)
  if (match === null) return { description: '', body: source }
  const stated = /^description:[ \t]*(.*)$/m.exec(match[1] ?? '')?.[1]?.trim() ?? ''
  // Unquoted, because YAML's quotes are not part of the value and the registry
  // shows this string to the model: a `description: "Drive the browser"` was
  // being offered with the quote characters still in it.
  const description = /^(['"]).*\1$/s.test(stated) ? stated.slice(1, -1) : stated
  return { description, body: source.slice(match[0].length) }
}

/**
 * Write the skill's files down and register it.
 * @param ctx - the plugin's context.
 */
export function registerBrowserSkill(ctx: Context): void {
  volume.mkdirp(`${SKILL_ROOT}/references`)
  volume.writeFile(`${SKILL_ROOT}/SKILL.md`, toBytes(skillSource))
  for (const [name, source] of Object.entries(REFERENCES)) {
    volume.writeFile(`${SKILL_ROOT}/${name}`, toBytes(source))
  }
  const skill = parseSkill(skillSource)
  ctx.skills.register({
    name: 'browser',
    description: skill.description,
    content: skill.body,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_ROOT },
    path: `${SKILL_ROOT}/SKILL.md`,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
