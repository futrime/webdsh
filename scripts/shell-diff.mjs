/**
 * Differential test: run the same script under real bash and under this shell.
 *
 * Fixing what a user happens to report finds one bug at a time and leaves the
 * rest in place. This runs a corpus of the constructs an agent actually writes
 * — compound commands above all — against `/bin/bash` and against the shell
 * this build installs in the container, in identical fixtures, and reports
 * every disagreement in output or exit status.
 *
 * The shell bundle is a plain Node program, so both sides run locally and a few
 * hundred cases take seconds. Cases must be deterministic: no timestamps, no
 * hostnames, no version strings.
 *
 * Usage: `node scripts/shell-diff.mjs [--only <substring>] [--verbose]`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const verbose = args.includes('--verbose')

/** The shell under test, as source text, extracted from the generated module. */
function shellProgram() {
  const generated = `${root}/src/generated/container-shell.ts`
  const text = execFileSync('node', ['-e', `
    const fs = require('node:fs')
    const s = fs.readFileSync(${JSON.stringify(generated)}, 'utf8')
    process.stdout.write(JSON.parse(s.slice(s.indexOf('= ') + 2).trim()))
  `], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text
}

/**
 * The fixture every case starts from.
 *
 * Small, but with the shapes commands reach for: nested directories, a file
 * with several lines, a dotfile, an empty file, and something that looks like a
 * dependency directory to exclude.
 */
function buildFixture(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'src/nested'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/dep'), { recursive: true })
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'alpha.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(dir, 'beta.txt'), 'apple 3\nbanana 1\ncherry 2\n')
  writeFileSync(join(dir, 'empty.txt'), '')
  writeFileSync(join(dir, '.hidden'), 'secret\n')
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\nexport const shared = 2\n')
  writeFileSync(join(dir, 'src/b.js'), 'const b = 2\nconst shared = 3\n')
  writeFileSync(join(dir, 'src/nested/c.ts'), 'export const c = 3\n')
  writeFileSync(join(dir, 'node_modules/dep/index.js'), 'module.exports = 1\n')
  writeFileSync(join(dir, '.git/config'), '[core]\n')
  writeFileSync(join(dir, 'data.csv'), 'name,qty\nfoo,10\nbar,20\n')
}

/** Run a script under a shell, returning its merged output and status. */
function run(command, argv, dir) {
  try {
    const stdout = execFileSync(command, argv, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: dir, LC_ALL: 'C' },
    })
    return { status: 0, text: stdout }
  } catch (error) {
    return {
      status: error.status ?? 1,
      text: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }
  }
}

/** Normalise output so incidental differences do not read as failures. */
function normalise(text) {
  return text
    // Diagnostics name the shell that produced them.
    .replace(/^(bash|sh|jsh|script\.sh):\s*(line \d+:\s*)?/gm, 'SHELL: ')
    .replace(/\r/g, '')
    .split('\n').map(line => line.replace(/\s+$/, '')).join('\n')
    .replace(/\n+$/, '')
}

/** The corpus. Each entry is a script both shells must agree on. */
const CASES = [
  // ---- compound commands: the shapes an agent writes constantly ------------
  ['compound: pwd && ls && echo', 'echo start && ls alpha.txt && echo done'],
  ['compound: three &&', 'echo a && echo b && echo c'],
  ['compound: && with pipe', 'ls src && ls src | wc -l'],
  ['compound: pipe then &&', 'cat alpha.txt | wc -l && echo counted'],
  ['compound: || fallback', 'cat missing.txt || echo fallback'],
  ['compound: && ||', 'test -f alpha.txt && echo yes || echo no'],
  ['compound: && || false', 'test -f nope.txt && echo yes || echo no'],
  ['compound: semicolons', 'echo one; echo two; echo three'],
  ['compound: mixed ; &&', 'echo a; echo b && echo c'],
  ['compound: subst in chain', 'echo count=$(ls src | wc -l) && echo after'],
  ['compound: cd then relative', 'cd src && ls && cat a.ts'],
  ['compound: cd .. back', 'cd src && cd .. && ls alpha.txt'],
  ['compound: redirect then read', 'echo written > out.txt && cat out.txt'],
  ['compound: append then read', 'echo one > o.txt && echo two >> o.txt && cat o.txt'],
  ['compound: multiline script', 'echo first\necho second\necho third'],
  ['compound: multiline with if', 'if [ -f alpha.txt ]; then\n  echo present\nfi\necho after'],
  ['compound: grep into wc', 'grep -c . alpha.txt && grep two alpha.txt'],
  ['compound: find into wc', 'find src -type f | wc -l'],
  ['compound: chained pipes', 'cat beta.txt | sort | head -n 2 | wc -l'],
  ['compound: four stage pipe', 'cat beta.txt | cut -d" " -f1 | sort | tr a-z A-Z'],
  ['compound: exit status chain', 'false; echo $?; true; echo $?'],
  ['compound: status through pipe', 'false | true; echo $?'],
  ['compound: negation', '! false && echo negated'],
  ['compound: group braces', '{ echo one; echo two; } | wc -l'],
  ['compound: subshell parens', '(cd src && pwd) > /dev/null; pwd | grep -c fixture'],
  ['compound: var then use', 'X=5; echo $X; Y=$((X * 2)); echo $Y'],
  ['compound: var in pipeline', 'N=$(cat alpha.txt | wc -l); echo lines=$N'],
  ['compound: nested subst', 'echo outer=$(echo inner=$(echo deep))'],
  ['compound: subst with pipe', 'echo "top=$(cat beta.txt | head -n 1)"'],
  ['compound: for with body pipe', 'for f in src/*.ts; do echo $f; done | wc -l'],
  ['compound: while read', 'cat alpha.txt | while read line; do echo "got $line"; done'],
  ['compound: if with pipeline cond', 'if cat alpha.txt | grep -q two; then echo found; fi'],
  ['compound: case in chain', 'case abc in a*) echo matched;; *) echo other;; esac && echo after'],
  ['compound: function then call', 'greet() { echo "hi $1"; }; greet world && echo after'],
  ['compound: heredoc then use', "cat > h.txt <<'EOF'\nline one\nline two\nEOF\nwc -l < h.txt"],
  ['compound: heredoc in pipe', "cat <<'EOF' | wc -l\na\nb\nEOF"],
  ['compound: redirect stderr', 'ls nope 2>/dev/null || echo suppressed'],
  ['compound: merge stderr', 'ls nope 2>&1 | grep -c .'],
  ['compound: both redirects', 'ls alpha.txt nope > out2.txt 2>&1; grep -c . out2.txt'],
  ['compound: input redirect chain', 'wc -l < alpha.txt && wc -c < empty.txt'],

  // ---- expansions ---------------------------------------------------------
  ['expand: default', 'unset U; echo "${U:-fallback}"'],
  ['expand: assign default', 'unset U; echo "${U:=assigned}"; echo "$U"'],
  ['expand: alternate', 'V=set; echo "${V:+present}"'],
  ['expand: length', 'V=hello; echo "${#V}"'],
  ['expand: strip prefix', 'P=src/a.ts; echo "${P#src/}"'],
  ['expand: strip suffix', 'P=src/a.ts; echo "${P%.ts}"'],
  ['expand: longest suffix', 'P=a.b.c; echo "${P%%.*}"'],
  ['expand: longest prefix', 'P=a.b.c; echo "${P##*.}"'],
  ['expand: replace first', 'P=aXbXc; echo "${P/X/-}"'],
  ['expand: replace all', 'P=aXbXc; echo "${P//X/-}"'],
  ['expand: positional count', 'set -- one two three; echo $#; echo $2'],
  ['expand: all params', 'set -- a b c; echo "$@"'],
  ['expand: arithmetic', 'echo $((2 + 3 * 4))'],
  ['expand: arithmetic vars', 'A=7; B=3; echo $((A % B)); echo $((A / B))'],
  ['expand: arithmetic compare', 'echo $((5 > 3))'],
  ['expand: glob star', 'echo src/*.ts'],
  ['expand: glob question', 'echo ?eta.txt'],
  ['expand: glob no match', 'echo nomatch*glob'],
  ['expand: brace list', 'echo {a,b,c}.txt'],
  ['expand: tilde', 'cd ~ && pwd | grep -c .'],
  ['expand: quoted spaces', 'echo "a  b" | wc -c'],
  ['expand: single quotes literal', "echo 'a$B`c`'"],
  ['expand: escaped dollar', 'echo "\\$notavar"'],
  ['expand: backslash n literal', 'printf "a\\nb\\n" | wc -l'],

  // ---- control flow -------------------------------------------------------
  ['flow: for list', 'for i in 1 2 3; do echo "n$i"; done'],
  ['flow: for glob', 'for f in src/*.ts; do echo "f=$f"; done'],
  ['flow: for with break', 'for i in 1 2 3; do if [ $i = 2 ]; then break; fi; echo $i; done'],
  ['flow: for with continue', 'for i in 1 2 3; do if [ $i = 2 ]; then continue; fi; echo $i; done'],
  ['flow: while counter', 'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done'],
  ['flow: until', 'i=0; until [ $i -ge 2 ]; do echo $i; i=$((i+1)); done'],
  ['flow: if elif else', 'if [ 1 = 2 ]; then echo a; elif [ 1 = 1 ]; then echo b; else echo c; fi'],
  ['flow: case patterns', 'for v in cat dog bird; do case $v in c*) echo C;; d*) echo D;; *) echo other;; esac; done'],
  ['flow: nested loops', 'for a in 1 2; do for b in x y; do echo "$a$b"; done; done'],
  ['flow: function args', 'f() { echo "$1-$2"; }; f one two'],
  ['flow: function return', 'f() { return 3; }; f; echo $?'],
  ['flow: function in pipe', 'f() { echo one; echo two; }; f | wc -l'],

  // ---- test / [ ------------------------------------------------------------
  ['test: file exists', '[ -f alpha.txt ] && echo yes'],
  ['test: dir exists', '[ -d src ] && echo yes'],
  ['test: not exists', '[ ! -f nope ] && echo yes'],
  ['test: string empty', 'S=""; [ -z "$S" ] && echo empty'],
  ['test: string nonempty', 'S=x; [ -n "$S" ] && echo nonempty'],
  ['test: numeric', '[ 3 -gt 2 ] && echo greater'],
  ['test: string equal', '[ abc = abc ] && echo equal'],
  ['test: file size', '[ -s alpha.txt ] && echo sized; [ -s empty.txt ] || echo unsized'],
  ['test: readable', '[ -r alpha.txt ] && echo readable'],

  // ---- coreutils an agent leans on ----------------------------------------
  ['utils: wc variants', 'wc -l alpha.txt; wc -c < empty.txt; wc -w < beta.txt'],
  ['utils: head tail', 'head -n 2 alpha.txt; tail -n 1 alpha.txt'],
  ['utils: sort numeric', 'printf "10\\n2\\n33\\n" | sort -n'],
  ['utils: sort reverse', 'printf "a\\nc\\nb\\n" | sort -r'],
  ['utils: uniq count', 'printf "a\\na\\nb\\n" | uniq -c'],
  ['utils: cut fields', 'cut -d, -f2 data.csv'],
  ['utils: cut chars', 'echo abcdef | cut -c2-4'],
  ['utils: tr translate', 'echo hello | tr a-z A-Z'],
  ['utils: tr delete', 'echo "a1b2" | tr -d 0-9'],
  ['utils: sed substitute', 'sed "s/two/2/" alpha.txt'],
  ['utils: sed delete line', 'sed "2d" alpha.txt'],
  ['utils: sed alt delimiter', 'echo src/a.ts | sed "s#src/##"'],
  ['utils: sed in place style', 'sed -n "2p" alpha.txt'],
  ['utils: awk field', 'awk "{print \\$1}" beta.txt'],
  ['utils: awk sum', 'awk "{s+=\\$2} END {print s}" beta.txt'],
  ['utils: awk condition', 'awk "\\$2 > 1 {print \\$1}" beta.txt'],
  ['utils: awk field sep', 'awk -F, "{print \\$1}" data.csv'],
  ['utils: grep basic', 'grep two alpha.txt'],
  ['utils: grep count', 'grep -c . alpha.txt'],
  ['utils: grep invert', 'grep -v two alpha.txt'],
  ['utils: grep recursive', 'grep -r shared src | sort'],
  ['utils: grep list files', 'grep -rl shared src | sort'],
  ['utils: grep ignore case', 'echo HELLO | grep -i hello'],
  ['utils: grep word', 'echo "one two" | grep -w two'],
  ['utils: grep extended', 'printf "cat\\ndog\\n" | grep -E "cat|dog" | wc -l'],
  ['utils: basename dirname', 'basename src/a.ts; dirname src/a.ts; basename src/a.ts .ts'],
  ['utils: find name', 'find . -name "*.ts" | sort'],
  ['utils: find maxdepth', 'find . -maxdepth 1 -type f | sort'],
  ['utils: find exclude', 'find . -type f -not -path "./node_modules/*" -not -path "./.git/*" | sort'],
  ['utils: find exec', 'find src -name "a.ts" -exec cat {} \\;'],
  ['utils: xargs', 'find src -name "*.ts" | sort | xargs wc -l | tail -n 1'],
  ['utils: xargs zero', 'find src -name "*.ts" -print0 | xargs -0 echo | wc -w'],
  ['utils: tee', 'echo teed | tee t.txt > /dev/null; cat t.txt'],
  ['utils: seq', 'seq 1 4 | tr "\\n" " "'],
  ['utils: paste', 'printf "a\\nb\\n" > p1; printf "1\\n2\\n" > p2; paste p1 p2'],
  ['utils: comm-less diff', 'printf "a\\nb\\n" > d1; printf "a\\nc\\n" > d2; diff d1 d2 | grep -c .'],
  ['utils: mkdir -p and rm -rf', 'mkdir -p x/y/z && ls x/y && rm -rf x && ls x 2>&1 | grep -c .'],
  ['utils: cp and mv', 'cp alpha.txt copy.txt && mv copy.txt moved.txt && cat moved.txt | wc -l'],
  ['utils: touch and test', 'touch fresh.txt && [ -f fresh.txt ] && echo created'],
  ['utils: ls -1 sorted', 'ls -1 src | sort'],
  ['utils: readlink realpath', 'ln -s alpha.txt link.txt && readlink link.txt'],
  ['utils: du counts', 'du -s src > /dev/null && echo du-ok'],
  ['utils: sha256sum stable', 'printf abc | sha256sum'],
  ['utils: md5sum stable', 'printf abc | md5sum'],
  ['utils: base64 roundtrip', 'printf hello | base64 | base64 -d'],
  ['utils: sort -u', 'printf "b\\na\\nb\\n" | sort -u'],
  ['utils: nl numbering', 'nl alpha.txt | tr -s " "'],
  ['utils: rev', 'echo abc | rev'],
  ['utils: expr arithmetic', 'expr 3 + 4'],
  ['utils: printf padding', 'printf "%-5s|%5s|\\n" ab cd'],
  ['utils: printf numeric', 'printf "%d %05.2f\\n" 42 3.14159'],

  // ---- realistic multi-step jobs -----------------------------------------
  ['job: inventory', 'pwd > /dev/null && ls -la > /dev/null && find . -maxdepth 2 -type f | sed "s#^./##" | sort | head -20'],
  ['job: count by extension', 'find . -type f -name "*.ts" -not -path "./node_modules/*" | wc -l'],
  ['job: search and report', 'grep -rn shared src | sort | head -5'],
  ['job: build a file list', 'ls src/*.ts | while read f; do echo "found $f"; done'],
  ['job: sum a column', 'awk "{s+=\\$2} END {printf \\"%d\\\\n\\", s}" beta.txt'],
  ['job: filter and transform', 'cat beta.txt | grep -v banana | awk "{print \\$1}" | sort | tr "\\n" ","'],
  ['job: conditional cleanup', 'mkdir -p tmpdir && touch tmpdir/f && if [ -d tmpdir ]; then rm -rf tmpdir; echo cleaned; fi'],
  ['job: write then verify', 'printf "line1\\nline2\\n" > w.txt && [ -s w.txt ] && wc -l < w.txt'],
  ['job: guard missing file', 'if [ -f nope.txt ]; then cat nope.txt; else echo "no such file"; fi'],
  ['job: capture and branch', 'N=$(ls src | wc -l); if [ "$N" -gt 1 ]; then echo many; else echo few; fi'],
  ['job: loop over find', 'for f in $(find src -name "*.ts" | sort); do basename $f; done'],
  ['job: nested quoting', 'echo "outer $(echo "inner $(echo deep)")"'],
  ['job: env passthrough', 'export MYVAR=hello; echo "$MYVAR" && env | grep -c MYVAR'],
  ['job: multiline heredoc file', "cat > cfg.json <<'EOF'\n{\n  \"a\": 1\n}\nEOF\ncat cfg.json | wc -l"],
  ['job: pipeline into loop', 'ls src | sort | while read f; do echo "- $f"; done'],
  ['job: arithmetic accumulate', 'total=0; for n in 1 2 3; do total=$((total + n)); done; echo $total'],

  // ---- a second sweep: the shapes the first pass did not think to try -----
  ['more: cd into var dir', 'D=src; cd $D && pwd | grep -c src'],
  ['more: quoted arg with spaces', 'mkdir -p "two words" && ls -d "two words"'],
  ['more: filename with space', 'echo hi > "a b.txt" && cat "a b.txt" && rm "a b.txt"'],
  ['more: nested if in for', 'for i in 1 2 3; do if [ $i -gt 1 ]; then echo "big $i"; else echo "small $i"; fi; done'],
  ['more: until with break', 'i=0; until false; do i=$((i+1)); [ $i -ge 3 ] && break; done; echo $i'],
  ['more: case fallthrough default', 'case zzz in a*) echo a;; b*) echo b;; *) echo default;; esac'],
  ['more: case multiple patterns', 'case b in a|b|c) echo listed;; *) echo no;; esac'],
  ['more: function recursion', 'f() { if [ $1 -le 0 ]; then echo done; else f $(($1 - 1)); fi; }; f 3'],
  ['more: local-ish var in fn', 'x=outer; f() { x=inner; }; f; echo $x'],
  ['more: command sub multiline', 'V=$(printf "a\\nb\\n"); echo "$V" | wc -l'],
  ['more: command sub strips newline', 'V=$(echo hi); echo "[$V]"'],
  ['more: nested quotes in subst', 'echo "$(echo "a b")"'],
  ['more: subst in condition', 'if [ "$(echo yes)" = yes ]; then echo matched; fi'],
  ['more: arithmetic in condition', 'if [ $((2+2)) -eq 4 ]; then echo four; fi'],
  ['more: chained assignment use', 'A=1; B=$A; C=$B; echo $C'],
  ['more: append to var', 'V=a; V="${V}b"; echo $V'],
  ['more: unset var', 'V=x; unset V; echo "[${V:-empty}]"'],
  ['more: exit code preserved', 'sh -c "exit 7"; echo $?'],
  ['more: exit in subshell', '(exit 5); echo $?'],
  ['more: true false chain', 'true && false || echo recovered'],
  ['more: pipeline exit last', 'false | echo x; echo $?'],
  ['more: multiple redirects order', 'echo a > r1.txt; echo b > r2.txt; cat r1.txt r2.txt'],
  ['more: redirect into subdir', 'mkdir -p out && echo deep > out/f.txt && cat out/f.txt'],
  ['more: read into two vars', 'echo "one two three" | while read a b; do echo "a=$a b=$b"; done'],
  ['more: read preserves rest', 'printf "x y z\\n" | while read first rest; do echo "$rest"; done'],
  ['more: while read with counter', 'n=0; printf "a\\nb\\nc\\n" | while read l; do n=$((n+1)); echo "$n:$l"; done'],
  ['more: here-string', 'grep -c b <<< "abc"'],
  ['more: heredoc with expansion', 'V=world; cat <<EOF\nhello $V\nEOF'],
  ['more: heredoc quoted no expansion', "V=world; cat <<'EOF'\nhello $V\nEOF"],
  ['more: sed multiple expressions', 'printf "a\\nb\\n" | sed -e "s/a/1/" -e "s/b/2/"'],
  ['more: sed global flag', 'echo aaa | sed "s/a/b/g"'],
  ['more: sed anchors', 'printf "ab\\nba\\n" | sed "s/^a/X/"'],
  ['more: sed range delete', 'printf "1\\n2\\n3\\n4\\n" | sed "2,3d"'],
  ['more: sed print with -n', 'printf "1\\n2\\n3\\n" | sed -n "1,2p"'],
  ['more: sed backreference', 'echo abc | sed -E "s/(a)(b)/\\2\\1/"'],
  ['more: awk NF', 'printf "a b c\\n" | awk "{print NF}"'],
  ['more: awk NR', "printf 'x\\ny\\n' | awk '{print NR \": \" $0}'"],
  ['more: awk BEGIN', 'awk "BEGIN {print \"start\"}" < /dev/null'],
  ['more: awk multiple fields', "printf '1 2 3\\n' | awk '{print $3, $1}'"],
  ['more: awk pattern only', 'printf "keep\\ndrop\\n" | awk "/keep/"'],
  ['more: awk OFS', "printf 'a b\\n' | awk -v OFS=- '{print $1, $2}'"],
  ['more: sort by field', 'printf "b 2\\na 1\\n" | sort -k1'],
  ['more: sort numeric reverse', 'printf "1\\n10\\n2\\n" | sort -nr'],
  ['more: uniq duplicates only', 'printf "a\\na\\nb\\n" | uniq -d'],
  ['more: uniq unique only', 'printf "a\\na\\nb\\n" | uniq -u'],
  ['more: head -c', 'printf "abcdef" | head -c 3'],
  ['more: tail -n plus', 'printf "1\\n2\\n3\\n" | tail -n +2'],
  ['more: tr squeeze', 'echo "aaabbb" | tr -s ab'],
  ['more: tr complement delete', 'echo "a1b2" | tr -cd "0-9"'],
  ['more: grep -o', 'echo "foo bar foo" | grep -o foo | wc -l'],
  ['more: grep -A context', 'printf "a\\nb\\nc\\n" | grep -A1 a'],
  ['more: grep -B context', 'printf "a\\nb\\nc\\n" | grep -B1 b'],
  ['more: grep multiple files', 'grep -l shared src/a.ts src/b.js | sort'],
  ['more: grep exit status', 'echo x | grep -q nomatch; echo $?'],
  ['more: ls -d directory', 'ls -d src'],
  ['more: ls nonexistent status', 'ls nope > /dev/null 2>&1; echo $?'],
  ['more: cat multiple files', 'cat alpha.txt beta.txt | wc -l'],
  ['more: cat nonexistent', 'cat nope 2>/dev/null; echo $?'],
  ['more: cp -r directory', 'cp -r src copied && ls copied | sort'],
  ['more: mv directory', 'mkdir -p mvsrc && touch mvsrc/f && mv mvsrc mvdst && ls mvdst'],
  ['more: rm -f missing ok', 'rm -f definitely-not-here; echo $?'],
  ['more: rmdir non-empty fails', 'mkdir -p ne && touch ne/f && rmdir ne 2>/dev/null; echo $?'],
  ['more: chmod then test -x', 'echo x > s.sh && chmod +x s.sh && [ -x s.sh ] && echo executable'],
  ['more: dirname basename chain', 'p=a/b/c.txt; echo "$(dirname $p)/$(basename $p .txt)"'],
  ['more: realpath-ish pwd -P', 'cd src && pwd | grep -c src'],
  ['more: multiple assignments one line', 'A=1 B=2; echo $A$B'],
  ['more: env var for one command', 'FOO=bar sh -c "echo \$FOO"'],
  ['more: export then subshell', 'export E=v; sh -c "echo \$E"'],
  ['more: quoted empty arg', 'set -- "" b; echo $#'],
  ['more: dollar star vs at', 'set -- a b; echo "$*"'],
  ['more: shift', 'set -- a b c; shift; echo $1'],
  ['more: string inequality', '[ abc != abd ] && echo differ || echo same'],
  ['more: arithmetic increment', 'i=1; i=$((i+1)); i=$((i*3)); echo $i'],
  ['more: arithmetic parens', 'echo $(( (2+3) * 4 ))'],
  ['more: arithmetic negative', 'echo $(( 3 - 5 ))'],
  ['more: test -e', '[ -e alpha.txt ] && echo exists'],
  ['more: nested command subst in loop', 'for f in $(ls src | head -n 1); do echo "got $f"; done'],
  ['more: pipe to head early exit', 'seq 1 100 | head -n 3'],
  ['more: seq with step', 'seq 1 2 7 | tr "\\n" " "'],
  ['more: wc on multiple files', 'wc -l alpha.txt beta.txt'],
  ['more: find type d', 'find . -maxdepth 1 -type d | sort'],
  ['more: find newer-less name or', 'find src -name "*.ts" -o -name "*.js" 2>/dev/null | sort'],
  ['more: xargs -n1', 'printf "a\\nb\\n" | xargs -n1 echo pre'],
  ['more: xargs -I', 'printf "x\\n" | xargs -I{} echo "[{}]"'],
  ['more: tee append', 'echo one > t.txt; echo two | tee -a t.txt > /dev/null; cat t.txt'],
  ['more: diff identical', 'cp alpha.txt same.txt; diff alpha.txt same.txt; echo $?'],
  ['more: comm-ish sort join', 'sort beta.txt | head -n 1'],
  ['more: date-free timestamp', 'touch -t 202001010000 old.txt 2>/dev/null; [ -f old.txt ] && echo touched'],
  ['more: symlink follow', 'ln -sf alpha.txt sl.txt && cat sl.txt | wc -l'],
  ['more: readlink -f absent ok', 'readlink sl.txt'],
  ['more: subshell isolation', 'V=1; (V=2); echo $V'],
  ['more: group no isolation', 'V=1; { V=2; }; echo $V'],
  ['more: pipeline var scope', 'V=1; echo x | { V=2; }; echo $V'],
  ['more: backtick substitution', 'echo `echo backtick`'],
  ['more: escaped quotes', 'echo "she said \\"hi\\""'],
  ['more: single inside double', 'echo "it\'s"'],
  ['more: dollar brace default chain', 'unset A; echo "${A:-${B:-both}}"'],
  ['more: long pipeline', 'cat beta.txt | sort | uniq | wc -l | tr -d " "'],
  ['more: exit code of last in chain', 'true; false; true; echo $?'],
  ['more: semicolon after done', 'for i in 1; do echo $i; done; echo after'],
  ['more: comment ignored', 'echo before # this is a comment\necho after'],
  ['more: empty command line', 'echo a\n\necho b'],
  ['more: trailing whitespace', 'echo trimmed   '],
  ['more: tab indented block', 'if true; then\n\techo tabbed\nfi'],

  // ---- bash-specific syntax an agent writes without thinking --------------
  ['bash: double bracket', '[[ -f alpha.txt ]] && echo present'],
  ['bash: double bracket string', '[[ "abc" == "abc" ]] && echo equal'],
  ['bash: double bracket pattern', '[[ src/a.ts == *.ts ]] && echo matched'],
  ['bash: double bracket not', '[[ ! -f nope ]] && echo absent'],
  ['bash: double bracket and', '[[ -f alpha.txt && -d src ]] && echo both'],
  ['bash: double bracket or', '[[ -f nope || -d src ]] && echo either'],
  ['bash: double bracket numeric', '[[ 3 -gt 2 ]] && echo greater'],
  ['bash: double paren arithmetic', '(( 2 + 2 == 4 )) && echo four'],
  ['bash: double paren increment', 'i=0; (( i++ )); (( i++ )); echo $i'],
  ['bash: array assign and index', 'arr=(a b c); echo ${arr[1]}'],
  ['bash: array length', 'arr=(a b c); echo ${#arr[@]}'],
  ['bash: array all elements', 'arr=(x y); echo "${arr[@]}"'],
  ['bash: array append', 'arr=(a); arr+=(b); echo "${arr[@]}"'],
  ['bash: array iterate', 'arr=(1 2 3); for v in "${arr[@]}"; do echo "v$v"; done'],
  ['bash: string append operator', 'V=a; V+=b; echo $V'],
  ['bash: uppercase expansion', 'V=abc; echo "${V^^}"'],
  ['bash: lowercase expansion', 'V=ABC; echo "${V,,}"'],
  ['bash: substring', 'V=abcdef; echo "${V:1:3}"'],
  ['bash: substring to end', 'V=abcdef; echo "${V:3}"'],
  ['bash: local in function', 'f() { local x=inner; echo $x; }; x=outer; f; echo $x'],
  ['bash: function keyword', 'function greet { echo hi; }; greet'],
  ['bash: c-style for', 'for ((i=0; i<3; i++)); do echo $i; done'],
  ['bash: select-free while true break', 'i=0; while true; do i=$((i+1)); [ $i -ge 2 ] && break; done; echo $i'],
  ['bash: process substitution', 'diff <(echo a) <(echo a) && echo same'],
  ['bash: printf -v', 'printf -v out "%s-%s" a b; echo $out'],
  ['bash: mapfile-free read loop', 'while IFS= read -r l; do echo "[$l]"; done < alpha.txt'],
  ['bash: IFS split', 'IFS=, read -r a b <<< "x,y"; echo "$a|$b"'],
  ['bash: set -e stops', 'set -e; false; echo "not reached"'],
  ['bash: set -e with guard', 'set -e; false || true; echo reached'],
  ['bash: set -u unset error', 'set -u; echo "${UNSET_VAR}" 2>/dev/null; echo $?'],
  ['bash: pipefail status', 'set -o pipefail; false | true; echo $?'],
  ['bash: trap noop', 'trap "echo trapped" EXIT; echo body'],
  ['bash: background job', 'echo bg & wait; echo after'],
  ['bash: dollar dollar is numeric', '[ -n "$$" ] && echo haspid'],
  ['bash: source a file', 'echo "echo sourced" > lib.sh; . ./lib.sh'],
  ['bash: source with args', 'echo "echo \\$1" > lib2.sh; . ./lib2.sh arg1'],
  ['bash: getopts-free flag parse', 'set -- -v file; if [ "$1" = "-v" ]; then echo verbose; fi'],
  ['bash: nested arithmetic expansion', 'a=2; b=3; echo $(( a * (b + 1) ))'],
  ['bash: ternary-ish', 'x=5; [ $x -gt 3 ] && r=big || r=small; echo $r'],

  // ---- longer, realistic jobs ---------------------------------------------
  ['long: build report', 'echo "Files:"; find src -type f | sort | sed "s/^/  /"; echo "Total: $(find src -type f | wc -l)"'],
  ['long: word frequency', 'cat beta.txt | tr " " "\\n" | grep -v "^[0-9]*$" | sort | uniq -c | sort -rn | head -3 | awk "{print \\$2}"'],
  ['long: conditional pipeline chain', 'if find src -name "*.ts" | grep -q .; then echo "has ts"; find src -name "*.ts" | wc -l; else echo none; fi'],
  ['long: csv sum', 'tail -n +2 data.csv | cut -d, -f2 | awk "{s+=\\$1} END {print s}"'],
  ['long: rename loop', 'mkdir -p ren && touch ren/a.txt ren/b.txt && for f in ren/*.txt; do mv "$f" "${f%.txt}.md"; done && ls ren | sort'],
  ['long: guard then work', 'if [ ! -d build ]; then mkdir build; fi; echo made > build/out; cat build/out'],
  ['long: count lines per file', 'for f in src/*.ts src/*.js; do echo "$f: $(wc -l < $f)"; done'],
  ['long: accumulate into file', 'rm -f acc.txt; for i in 1 2 3; do echo "line $i" >> acc.txt; done; cat acc.txt'],
  ['long: search replace across files', 'for f in src/*.ts; do sed "s/const/let/" "$f"; done | grep -c let'],
  ['long: error handling chain', 'cat missing 2>/dev/null || echo "missing handled"; echo continuing'],
]

const program = shellProgram()
const shellPath = join(tmpdir(), `dsh-shell-${String(process.pid)}.cjs`)
writeFileSync(shellPath, program)

let failures = 0
let ran = 0
const selected = only === undefined ? CASES : CASES.filter(([name]) => name.includes(only))

for (const [name, script] of selected) {
  const bashDir = mkdtempSync(join(tmpdir(), 'diff-bash-'))
  const oursDir = mkdtempSync(join(tmpdir(), 'diff-ours-'))
  buildFixture(bashDir)
  buildFixture(oursDir)
  writeFileSync(join(bashDir, 'script.sh'), script)
  writeFileSync(join(oursDir, 'script.sh'), script)

  const expected = run('/bin/bash', ['script.sh'], bashDir)
  const actual = run('node', [shellPath, 'script.sh'], oursDir)
  ran++

  const wantText = normalise(expected.text)
  const gotText = normalise(actual.text)
  const same = wantText === gotText && expected.status === actual.status
  if (!same) {
    failures++
    console.log(`\n✗ ${name}`)
    console.log(`  script: ${script.replace(/\n/g, ' ⏎ ')}`)
    console.log(`  bash  [${String(expected.status)}]: ${JSON.stringify(wantText.slice(0, 220))}`)
    console.log(`  ours  [${String(actual.status)}]: ${JSON.stringify(gotText.slice(0, 220))}`)
  } else if (verbose) {
    console.log(`✓ ${name}`)
  }

  rmSync(bashDir, { recursive: true, force: true })
  rmSync(oursDir, { recursive: true, force: true })
}

rmSync(shellPath, { force: true })
console.log(`\n${String(ran - failures)}/${String(ran)} agree with bash; ${String(failures)} differ.`)
process.exitCode = failures === 0 ? 0 : 1
