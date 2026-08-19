/**
 * `git` over isomorphic-git, running against the VFS through the `node:fs`
 * shim. This is a real git implementation — `init`, `add`, `commit`, `status`,
 * `log`, `diff`, `branch`, `checkout`, and `clone`/`fetch`/`push` over HTTP —
 * so a workspace in the browser has genuine version control rather than a stub.
 *
 * Remote operations need the origin to permit cross-origin reads. GitHub's
 * smart-HTTP endpoints do not, so `clone` reports that clearly and points at
 * the CORS proxy setting instead of failing with a bare network error.
 */

import type { CommandContext, CommandImpl } from './runtime.ts'
import { abs, parseArgs } from './coreutils.ts'
import { toText } from '../node/binary.ts'
import * as fs from '../node/fs.ts'
import { proxyConfig } from '../net/cors-proxy.ts'

/** Lazily imported so the git engine is not in the initial page payload. */
let engine: typeof import('isomorphic-git') | undefined
let httpClient: { request: unknown } | undefined

/** Load isomorphic-git on first use. */
async function loadEngine(): Promise<typeof import('isomorphic-git')> {
  if (engine === undefined) {
    engine = (await import('isomorphic-git')).default as unknown as typeof import('isomorphic-git')
  }
  return engine
}

/** Load the HTTP transport used by clone/fetch/push. */
async function loadHttp(): Promise<{ request: unknown }> {
  httpClient ??= (await import('isomorphic-git/http/web')) as unknown as { request: unknown }
  return httpClient
}

/** Optional proxy prefix for git remotes, read from the shell environment. */
function corsProxy(context: CommandContext): string | undefined {
  const value = context.shell.vars.get('GIT_CORS_PROXY')
  return value === undefined || value.length === 0 ? undefined : value
}

/** Locate the repository root by walking up for a `.git` directory. */
function findRoot(context: CommandContext): string | undefined {
  let current = context.shell.cwd
  for (;;) {
    if (context.shell.volume.exists(`${current}/.git`)) return current
    if (current === '/') return undefined
    current = current.slice(0, current.lastIndexOf('/')) || '/'
  }
}

/** Author identity from git config or the shell defaults. */
function author(context: CommandContext): { name: string, email: string } {
  return {
    name: context.shell.vars.get('GIT_AUTHOR_NAME') ?? 'DeepSeek Harness',
    email: context.shell.vars.get('GIT_AUTHOR_EMAIL') ?? 'harness@localhost',
  }
}

/**
 * Long options that take a separate word, as `--depth 1` rather than
 * `--depth=1`.
 *
 * The generic parser cannot know which ones those are, so it reads the value as
 * a positional — and `git clone --depth 1 URL dir` then tries to clone the
 * repository named "1".
 */
const VALUED_LONG_OPTIONS = new Set(['depth', 'branch', 'message', 'author', 'date', 'origin'])

/** Rewrite `--name value` into `--name=value` so the parser keeps them together. */
function joinLongValues(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    const name = /^--([a-z-]+)$/.exec(token)?.[1]
    if (name !== undefined && VALUED_LONG_OPTIONS.has(name) && argv[index + 1] !== undefined) {
      out.push(`${token}=${argv[++index]}`)
      continue
    }
    out.push(token)
  }
  return out
}

/** The `git` command. */
export const gitCommand: CommandImpl = async (context) => {
  const { operands, flags, values, long } = parseArgs(joinLongValues(context.argv), 'mCb')
  const subcommand = operands[0]
  // `git --version` is how nearly everything checks whether git is here at all,
  // so answering it is what makes the rest of this command discoverable. The
  // version named is the engine's, because that is what determines behaviour.
  if (long.has('version') || subcommand === 'version') {
    context.stdout.write('git version 2.45.0 (isomorphic-git)\n')
    return 0
  }
  if (subcommand === undefined || flags.has('h') || subcommand === 'help') {
    context.stdout.write('usage: git <command> [<args>]\n\nAvailable: init add commit status log diff branch checkout clone fetch push pull remote rev-parse show config ls-files\n')
    return subcommand === undefined ? 1 : 0
  }

  const git = await loadEngine()
  const dir = findRoot(context) ?? context.shell.cwd
  const common = { fs, dir }

  try {
    switch (subcommand) {
      case 'init': {
        const target = operands[1] === undefined ? context.shell.cwd : abs(context, operands[1])
        context.shell.volume.mkdirp(target)
        await git.init({ fs, dir: target, defaultBranch: 'main' })
        context.stdout.write(`Initialized empty Git repository in ${target}/.git/\n`)
        return 0
      }

      case 'add': {
        if (findRoot(context) === undefined) return notARepository(context)
        const targets = operands.slice(1)
        for (const target of targets) {
          if (target === '.' || target === '-A' || target === '--all') {
            const status = await git.statusMatrix({ ...common })
            for (const [filepath, , worktreeStatus] of status) {
              if (worktreeStatus === 0) await git.remove({ ...common, filepath })
              else await git.add({ ...common, filepath })
            }
            continue
          }
          const absolute = abs(context, target)
          const relative = absolute.startsWith(`${dir}/`) ? absolute.slice(dir.length + 1) : target
          const node = context.shell.volume.lookup(absolute, false)
          if (node?.kind === 'dir') {
            for (const [path, child] of context.shell.volume.walkTree(absolute)) {
              if (child.kind !== 'file' || path.includes('/.git/')) continue
              await git.add({ ...common, filepath: path.slice(dir.length + 1) })
            }
            continue
          }
          await git.add({ ...common, filepath: relative })
        }
        return 0
      }

      case 'commit': {
        if (findRoot(context) === undefined) return notARepository(context)
        const message = values.get('m') ?? operands[1]
        if (message === undefined) {
          context.stderr.write('git: a commit message is required (-m)\n')
          return 1
        }
        if (flags.has('a')) {
          const status = await git.statusMatrix({ ...common })
          for (const [filepath, head, worktree] of status) {
            if (head === 0) continue
            if (worktree === 0) await git.remove({ ...common, filepath })
            else await git.add({ ...common, filepath })
          }
        }
        const sha = await git.commit({ ...common, message, author: author(context) })
        const branch = await git.currentBranch({ ...common }) ?? 'main'
        context.stdout.write(`[${branch} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`)
        return 0
      }

      case 'status': {
        if (findRoot(context) === undefined) return notARepository(context)
        const branch = await git.currentBranch({ ...common }) ?? 'main'
        const staged: string[] = []
        const modified: string[] = []
        const deleted: string[] = []
        const untracked: string[] = []
        // isomorphic-git's status matrix, per its documented vocabulary:
        //   head    0 absent, 1 present
        //   workdir 0 absent, 1 same as head, 2 different from head
        //   stage   0 absent, 1 same as head, 2 same as workdir, 3 different
        for (const row of await git.statusMatrix({ ...common })) {
          const [filepath] = row
          const head = row[1] as number
          const workdir = row[2] as number
          const stage = row[3] as number
          if (head === 0 && workdir === 0 && stage === 0) continue
          if (head === 0 && stage === 0) untracked.push(filepath)
          else if (head === 0) staged.push(filepath)
          else if (workdir === 0) deleted.push(filepath)
          else if (stage === 3) {
            // Staged, then edited again in the working tree.
            staged.push(filepath)
            modified.push(filepath)
          } else if (stage === 2) staged.push(filepath)
          else if (workdir === 2) modified.push(filepath)
        }
        const short = flags.has('s') || context.argv.includes('--short')
        if (short) {
          for (const file of staged) context.stdout.write(`A  ${file}\n`)
          for (const file of modified) context.stdout.write(` M ${file}\n`)
          for (const file of deleted) context.stdout.write(` D ${file}\n`)
          for (const file of untracked) context.stdout.write(`?? ${file}\n`)
          return 0
        }
        context.stdout.write(`On branch ${branch}\n`)
        if (staged.length > 0) {
          context.stdout.write(`\nChanges to be committed:\n${staged.map(file => `\tnew file:   ${file}`).join('\n')}\n`)
        }
        if (modified.length + deleted.length > 0) {
          const lines = [
            ...modified.map(file => `\tmodified:   ${file}`),
            ...deleted.map(file => `\tdeleted:    ${file}`),
          ]
          context.stdout.write(`\nChanges not staged for commit:\n${lines.join('\n')}\n`)
        }
        if (untracked.length > 0) {
          context.stdout.write(`\nUntracked files:\n${untracked.map(file => `\t${file}`).join('\n')}\n`)
        }
        if (staged.length + modified.length + deleted.length + untracked.length === 0) {
          context.stdout.write('nothing to commit, working tree clean\n')
        }
        return 0
      }

      case 'log': {
        if (findRoot(context) === undefined) return notARepository(context)
        const depth = values.has('n') ? Number(values.get('n')) : 20
        const oneline = context.argv.includes('--oneline')
        let commits: Awaited<ReturnType<typeof git.log>>
        try {
          commits = await git.log({ ...common, depth })
        } catch {
          context.stderr.write('fatal: your current branch does not have any commits yet\n')
          return 128
        }
        for (const entry of commits) {
          if (oneline) {
            context.stdout.write(`${entry.oid.slice(0, 7)} ${entry.commit.message.split('\n')[0]}\n`)
            continue
          }
          context.stdout.write(`commit ${entry.oid}\nAuthor: ${entry.commit.author.name} <${entry.commit.author.email}>\nDate:   ${new Date(entry.commit.author.timestamp * 1000).toString()}\n\n    ${entry.commit.message.trim().split('\n').join('\n    ')}\n\n`)
        }
        return 0
      }

      case 'branch': {
        if (findRoot(context) === undefined) return notARepository(context)
        const name = operands[1]
        if (name === undefined) {
          const branches = await git.listBranches({ ...common })
          const current = await git.currentBranch({ ...common })
          for (const branch of branches) context.stdout.write(`${branch === current ? '* ' : '  '}${branch}\n`)
          return 0
        }
        await git.branch({ ...common, ref: name })
        return 0
      }

      case 'checkout': {
        if (findRoot(context) === undefined) return notARepository(context)
        const target = operands[1]
        if (target === undefined) {
          context.stderr.write('git checkout: a branch name is required\n')
          return 1
        }
        if (flags.has('b')) await git.branch({ ...common, ref: target, checkout: true })
        else await git.checkout({ ...common, ref: target })
        context.stdout.write(`Switched to branch '${target}'\n`)
        return 0
      }

      case 'rev-parse': {
        if (findRoot(context) === undefined) return notARepository(context)
        if (operands.includes('--show-toplevel')) {
          context.stdout.write(`${dir}\n`)
          return 0
        }
        if (operands.includes('--abbrev-ref') || operands.includes('HEAD')) {
          const branch = await git.currentBranch({ ...common })
          if (operands.includes('--abbrev-ref')) {
            context.stdout.write(`${branch ?? 'HEAD'}\n`)
            return 0
          }
          const oid = await git.resolveRef({ ...common, ref: 'HEAD' })
          context.stdout.write(`${oid}\n`)
          return 0
        }
        return 1
      }

      case 'diff': {
        if (findRoot(context) === undefined) return notARepository(context)
        const matrix = await git.statusMatrix({ ...common })
        let any = false
        for (const [filepath, head, worktree] of matrix) {
          if (head === worktree) continue
          any = true
          context.stdout.write(`diff --git a/${filepath} b/${filepath}\n`)
          if (head === 0) {
            context.stdout.write(`new file mode 100644\n--- /dev/null\n+++ b/${filepath}\n`)
            continue
          }
          if (worktree === 0) {
            context.stdout.write(`deleted file mode 100644\n--- a/${filepath}\n+++ /dev/null\n`)
            continue
          }
          context.stdout.write(`--- a/${filepath}\n+++ b/${filepath}\n`)
          const current = toText(context.shell.volume.readFile(`${dir}/${filepath}`))
          const blob = await git.readBlob({ ...common, oid: await git.resolveRef({ ...common, ref: 'HEAD' }), filepath }).catch(() => undefined)
          const previous = blob === undefined ? '' : toText(blob.blob)
          for (const line of unifiedHunk(previous, current)) context.stdout.write(`${line}\n`)
        }
        return any ? 0 : 0
      }

      case 'show': {
        if (findRoot(context) === undefined) return notARepository(context)
        const oid = operands[1] ?? await git.resolveRef({ ...common, ref: 'HEAD' })
        const entry = await git.readCommit({ ...common, oid })
        context.stdout.write(`commit ${entry.oid}\nAuthor: ${entry.commit.author.name} <${entry.commit.author.email}>\n\n    ${entry.commit.message.trim()}\n`)
        return 0
      }

      case 'ls-files': {
        if (findRoot(context) === undefined) return notARepository(context)
        for (const file of await git.listFiles({ ...common })) context.stdout.write(`${file}\n`)
        return 0
      }

      case 'config': {
        const [, path, value] = operands
        if (path === undefined) return 1
        if (value === undefined) {
          const current = await git.getConfig({ ...common, path })
          if (current === undefined) return 1
          context.stdout.write(`${String(current)}\n`)
          return 0
        }
        await git.setConfig({ ...common, path, value })
        return 0
      }

      case 'remote': {
        if (operands[1] === 'add') {
          await git.addRemote({ ...common, remote: operands[2], url: operands[3] })
          return 0
        }
        for (const remote of await git.listRemotes({ ...common })) {
          context.stdout.write(`${remote.remote}\t${remote.url} (fetch)\n${remote.remote}\t${remote.url} (push)\n`)
        }
        return 0
      }

      case 'clone': {
        const url = operands[1]
        if (url === undefined) {
          context.stderr.write('git clone: repository URL required\n')
          return 129
        }
        const name = operands[2] ?? (url.split('/').pop() ?? 'repo').replace(/\.git$/, '')
        const target = abs(context, name)
        const http = await loadHttp()
        context.stdout.write(`Cloning into '${name}'...\n`)
        await git.clone({
          fs, http: http as never, dir: target, url,
          singleBranch: true,
          depth: long.has('depth') ? Number(long.get('depth')) : 1,
          ...(corsProxy(context) === undefined ? {} : { corsProxy: corsProxy(context)! }),
        })
        return 0
      }

      case 'fetch':
      case 'pull':
      case 'push': {
        const http = await loadHttp()
        const options = {
          ...common, http: http as never,
          ...(corsProxy(context) === undefined ? {} : { corsProxy: corsProxy(context)! }),
        }
        if (subcommand === 'fetch') await git.fetch(options as never)
        else if (subcommand === 'pull') await git.pull({ ...options, author: author(context) } as never)
        else await git.push(options as never)
        return 0
      }

      default:
        context.stderr.write(`git: '${subcommand}' is not supported by the browser host\n`)
        return 1
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    context.stderr.write(`fatal: ${message}\n`)
    // A remote refusing a browser looks like a plain HTTP status, not like a
    // network error: GitHub answers a cross-origin git request with 401 rather
    // than with a CORS rejection, so matching only on the word "CORS" left the
    // one explanation that helps unsaid.
    if (/fetch|network|CORS|Failed to fetch|HTTP Error/i.test(message) && corsProxy(context) === undefined) {
      const { enabled, template } = proxyConfig()
      context.stderr.write('hint: git-over-HTTP needs a remote that allows cross-origin reads, and no git host does.\n')
      if (enabled) {
        // The page proxy already covers this: `isomorphic-git/http/web` issues
        // ordinary `fetch` calls, so a refused handshake is retried through
        // whatever Settings → Network names, without git being told about it.
        // Reaching here with it on means the proxy itself could not serve the
        // request, which is a different problem from having none.
        context.stderr.write(`hint: this page already retries refused requests through ${template}, so the\n`)
        context.stderr.write('hint: proxy itself could not serve this one. Try another in Settings → Network.\n')
      } else {
        context.stderr.write('hint: turn the proxy on in Settings → Network, or set GIT_CORS_PROXY to one that\n')
        context.stderr.write('hint: speaks git\'s own convention — `export GIT_CORS_PROXY=<url>`.\n')
      }
      context.stderr.write('hint: either one sees the repository URL, and any credentials, in full.\n')
    }
    return 128
  }
}

/** Standard "not a repository" diagnostic. */
function notARepository(context: CommandContext): number {
  context.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n')
  return 128
}

/** Render a minimal unified hunk between two texts. */
function unifiedHunk(previous: string, current: string): string[] {
  const before = previous.split('\n')
  const after = current.split('\n')
  const out: string[] = [`@@ -1,${String(before.length)} +1,${String(after.length)} @@`]
  const max = Math.max(before.length, after.length)
  for (let i = 0; i < max; i++) {
    if (before[i] === after[i]) {
      if (before[i] !== undefined) out.push(` ${before[i]}`)
      continue
    }
    if (before[i] !== undefined) out.push(`-${before[i]}`)
    if (after[i] !== undefined) out.push(`+${after[i]}`)
  }
  return out
}
