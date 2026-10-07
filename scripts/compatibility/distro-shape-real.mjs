// The two things this plugin promises a user whose distribution is not the one the gates run on:
//
//   · `help.known.body`: a distribution without GNU grep "says so plainly instead of returning
//     misaligned results";
//   · `help.usage.body`: glob's modification-time order "needs GNU find -printf (busybox falls back
//     to path order)".
//
// Both are claims about an *environment shape*, and until this driver nothing had ever run them
// against one. `tests/search-run-fakes.mjs` covers how the product classifies an exit 3 — with a
// **scripted** exit 3. That is the gap the outside report found in the session shell: a fake that
// returns the answer the code is looking for proves the code reads the answer, not that the answer
// is what a real distribution produces.
//
// Why this runs through WSL rather than a container. The obvious way to obtain a busybox userland
// is `docker run alpine`, and it was the first plan. It is not needed and it is worse here: this
// plugin's only execution path IS `wsl.exe -d <distro> -e bash -c <script>`, so a container would
// exercise the script bytes outside the plumbing that ships them, for a suite whose whole subject is
// WSL. The shape is obtainable where the product runs: **busybox is already installed in the WSL
// distribution** (`/usr/bin/busybox`), and on Alpine `/usr/bin/grep` *is* a busybox symlink — so
// pointing the name at busybox reproduces the same filesystem fact rather than faking a behaviour.
// What it buys: no Docker daemon, no second transport, no new CI job type, and a real `wsl.exe` in
// the middle.
//
// The script bytes are the product's own, scraped from the plane's `wsl-search` module — never
// retyped here, because a hand-copied script would drift and the drift would read as a pass. The
// argv shape is the product's too (`buildWslArgv`), with one deliberate difference: the launcher is
// `env PATH=… bash -c <script>`, so the script runs unchanged while the shape it sees is the one
// under test. Shape first, then the product: every premise is asserted before anything is claimed
// about the product, because "the shape was not there" and "the product answered wrongly" are
// different findings and must not be confused.
//
//   DSH_WSL_TEST_PLANE=src node --experimental-strip-types scripts/compatibility/distro-shape-real.mjs
//   WSL_COMPAT_DISTRO=Ubuntu WSL_COMPAT_USER=root … (both optional, both default as the others do)

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { decodeWslOutput } from '../../src/shared/wsl.ts'
import { load, plane, resolvePath } from './plane.mjs'

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const user = process.env.WSL_COMPAT_USER ?? 'root'
/**
 * Where the busybox-shaped `grep`/`find` live inside the distribution, and where the fixture tree is.
 *
 * **Both carry the plane**, for the reason `ci.yml` states about every other driver in this job: these
 * paths are created rather than cleaned, so two passes over one `/tmp/dsh-wsl-compat` is a race and
 * not a rerun. The gate runs this driver once per plane in the same job, and a fixed root would have
 * had the src pass's teardown pull the tree out from under the lib pass. The process id is in there
 * too so two concurrent invocations on one machine cannot collide either.
 */
const TAG = `${plane()}-${process.pid}`
const SHAPE_DIR = `/tmp/dsh-distro-shape-${TAG}`
const FIXTURE = `/tmp/dsh-distro-shape-tree-${TAG}`

const results = []
let currentSection = 'startup'
let abortedAfter = null
function section(name) {
  currentSection = name
  console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 64 - name.length))}`)
}
function check(name, pass, detail) {
  results.push({ name, pass: pass === true, section: currentSection, detail: detail === undefined ? undefined : String(detail) })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── reading the product's own bytes ──────────────────────────────────────────

/**
 * A module-scope `const NAME = [ … ].join('\n')` as the string it evaluates to.
 *
 * An element parser, not a regex over the body, and the difference was measured the hard way. The
 * first revision here matched `/'((?:\\.|[^'\\])*)'/g` — single-quoted literals — against
 * `GLOB_SCRIPT`, whose array **mixes quoting styles** because a line needs `\"$target\"` inside it.
 * That regex happily returned the *single-quoted fragments* of the double-quoted lines and dropped
 * the rest, so the driver ran a script with `find`'s arguments missing and reported `rc=127` — a
 * scrape that silently produced the wrong bytes, which is the exact failure this comment block is
 * supposed to prevent. Every element is now read as a literal, both quote styles are honoured, and
 * anything that is not a literal, a comma, whitespace or a comment throws.
 *
 * The marker requirement at the end is the second line of defence: a parse that somehow returns
 * plausible-looking but wrong text fails on a token the script certainly contains.
 */
function scriptConst(file, name, markers) {
  const source = readFileSync(file, 'utf8')
  const open = source.indexOf(`const ${name} = [`)
  if (open < 0) {
    throw new Error(`distro-shape-real: no \`const ${name} = [\` in ${file}. The script moved; `
      + 're-point this driver rather than testing bytes of your own.')
  }
  const start = source.indexOf('[', open)
  let depth = 0
  let end = -1
  for (let i = start; i < source.length; i++) {
    if (source[i] === '[') depth++
    else if (source[i] === ']') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error(`distro-shape-real: unbalanced brackets after ${name} in ${file}`)

  const body = source.slice(start + 1, end)
  const elements = []
  let i = 0
  while (i < body.length) {
    const char = body[i]
    if (char === ',' || /\s/.test(char)) { i++; continue }
    if (char === '/' && body[i + 1] === '/') {
      const newline = body.indexOf('\n', i)
      i = newline < 0 ? body.length : newline
      continue
    }
    if (char === "'" || char === '"') {
      const quote = char
      let text = ''
      let j = i + 1
      let closed = false
      while (j < body.length) {
        if (body[j] === '\\') { text += unescape(body[j + 1]); j += 2; continue }
        if (body[j] === quote) { closed = true; break }
        text += body[j++]
      }
      if (!closed) throw new Error(`distro-shape-real: unterminated literal in ${name} (${file})`)
      elements.push(text)
      i = j + 1
      continue
    }
    throw new Error(`distro-shape-real: unexpected ${JSON.stringify(char)} in the ${name} array. `
      + 'This parser reads string literals only; anything else means the array changed shape and '
      + 'the bytes below would be wrong.')
  }

  const script = elements.join('\n')
  const missing = markers.filter(marker => !script.includes(marker))
  if (missing.length > 0 || elements.length < 8) {
    throw new Error(`distro-shape-real: the ${name} parse produced ${elements.length} element(s) and `
      + `is missing ${JSON.stringify(missing)}; that is not the script, so this parse is wrong.`)
  }
  return script
}

/** Undo one escape from a TypeScript string literal, and refuse anything unfamiliar. */
function unescape(char) {
  if (char === '\\') return '\\'
  if (char === "'") return "'"
  if (char === '"') return '"'
  if (char === 'n') return '\n'
  if (char === 't') return '\t'
  if (char === '$') return '$'
  if (char === '`') return '`'
  throw new Error(`distro-shape-real: unknown escape \\${char} in a script literal; teach this `
    + 'unescaper the sequence rather than shipping a script that differs by one character.')
}

// ── running things inside the distribution ───────────────────────────────────

/**
 * Run one argv through `wsl.exe`.
 *
 * **stdout stays bytes.** The product does the same — `acceptRun` compares `run.stdout.length` and
 * returns the `Buffer` — and it has to, because this is a NUL-delimited record stream (`grep -Z`,
 * `find -print0`). An earlier revision of this driver ran stdout through `decodeWslOutput`, whose
 * NUL sniff saw a record stream and decoded it as UTF-16LE; the GNU control then "failed" on
 * mojibake that said nothing about the product. Only the launch-failure case is UTF-16, and it is
 * detected below rather than assumed.
 *
 * Asynchronous `spawn`, not `spawnSync`, and that is a measured choice rather than a style one: on
 * the machine this was written on, `spawnSync('wsl.exe', …)` returns `EBUSY` while `spawn` runs the
 * same argv and answers. Synchronous children are what the harness refuses; this driver has nothing
 * that needs to be synchronous, so it does not ask for the thing that gets refused. (The same
 * difference is why `bash-session-real`'s async session calls work here while its `spawnSync` probes
 * are the six cells that fail — the probes are the only synchronous spawns it makes.)
 */
async function wsl(argv, timeoutMs = 60_000) {
  return await new Promise(resolve => {
    const child = spawn('wsl.exe', argv, { timeout: timeoutMs })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => resolve({ rc: null, out: '', err: '', note: `${error.code ?? error.message}` }))
    child.on('close', code => {
      const outBuf = Buffer.concat(stdout)
      const errBuf = Buffer.concat(stderr)
      const out = outBuf.toString('utf8')
      const err = errBuf.toString('utf8')
      // `wsl.exe` answers a *launch* failure by writing the reason to stdout in UTF-16LE with stderr
      // empty. That shape is distinguishable from the command's own bytes: stderr empty, a
      // non-zero code, and NULs throughout. Decoded only for the message, never for an assertion.
      const looksUtf16 = err.trim() === '' && code !== 0 && outBuf.length > 0
        && outBuf.filter(byte => byte === 0).length > outBuf.length / 4
      resolve({
        rc: code,
        out,
        err,
        note: looksUtf16 ? decodeWslOutput(outBuf).trim().slice(0, 200) : '',
      })
    })
  })
}

/** A `bash -lc` one-liner inside the distribution, for the fixture and the substrate probes. */
async function bash(script, timeoutMs = 60_000) {
  return await wsl(['-d', distro, ...(user === undefined ? [] : ['-u', user]), '-e', 'bash', '-lc', script], timeoutMs)
}

/** The `PATH` the shapes are expressed in: the shape directory first, then a plain system path. */
const SHAPE_PATH = `${SHAPE_DIR}:/usr/bin:/bin`

/**
 * A one-liner under the *shape's* `PATH`, launched the way the product launches its scripts.
 *
 * Not `bash -lc`: a login shell re-reads `/etc/profile` and, under WSL, inherits the **Windows**
 * `PATH` through interop — entries like `C:\Program Files\…` carry spaces, so an `export
 * PATH=$SHAPE:$PATH` inside a login shell splits them and the premise fails for a reason that has
 * nothing to do with the shape. `env PATH=<fixed> bash -c` is both what the product does and what a
 * real busybox distribution looks like: no Windows entries, no profile rewriting the answer.
 */
async function bashInShape(script, timeoutMs = 60_000) {
  return await wsl(['-d', distro, ...(user === undefined ? [] : ['-u', user]), '-e',
    'env', `PATH=${SHAPE_PATH}`, 'bash', '-c', script], timeoutMs)
}

/**
 * Run one of the product's scripts the way the product runs it, with `PATH` replaced by the shape.
 *
 * `buildWslArgv` gives `… -e bash -c <script> dsh <values>`, and the script reads its arguments as
 * `$1…$n` from the values. Inserting `env PATH=…` between `-e` and `bash` changes the launcher and
 * nothing else: the bytes under test are identical, and the only thing that differs is the shape
 * they see — which is the point of the whole driver.
 *
 * The module is a parameter rather than a module-scope binding because the only place it can be
 * loaded is inside the guarded block below, and a closure over a `const` declared in another block
 * is a `ReferenceError`, not a convenience.
 */
async function runScript(search, script, values, shapePath) {
  const argv = search.buildWslArgv(
    { distro, username: user === undefined ? undefined : user, linuxCwd: FIXTURE },
    script,
    values,
  )
  const e = argv.indexOf('-e')
  const full = shapePath === undefined
    ? argv
    : [...argv.slice(0, e + 1), 'env', `PATH=${shapePath}`, ...argv.slice(e + 1)]
  return await wsl(full)
}

// ── premises ─────────────────────────────────────────────────────────────────

// Everything below is wrapped so an escape still prints the summary. A driver that dies with a
// stack trace and no verdict is the shape that reads as "nothing to see" in a CI log; naming the
// section it stopped in is what makes a short run diagnosable.
try {

  section('the substrate answers')

  const probe = await bash('echo SHAPE_ALIVE')
  check('the named distribution answers', probe.rc === 0 && probe.out.includes('SHAPE_ALIVE'),
    `distro=${distro} user=${user} rc=${probe.rc} ${JSON.stringify((probe.note || probe.err).slice(0, 80))}`)

  if (probe.rc !== 0) {
    // Thrown, not exited. `process.exit()` here would skip the catch below — so `abortedAfter`
    // would stay null and the verdict block would never run at all, which is the one shape this
    // driver exists to avoid: a log that shows a red premise and then simply stops, with no tally
    // and no "the run was incomplete" line for a reader to notice. Throwing reaches the same
    // conclusion *and* gets summarised.
    throw new Error(`the named distribution did not answer (rc=${probe.rc}, `
      + `${JSON.stringify((probe.note || probe.err).slice(0, 120))}). This is a fixture premise, `
      + 'not a product failure — nothing below could be measured.')
  }

  const setup = await bash(`
  set -e
  rm -rf '${FIXTURE}' '${SHAPE_DIR}'
  mkdir -p '${FIXTURE}/sub' '${SHAPE_DIR}'
  # Two files, an hour apart, so a path order and a modification-time order differ.
  : > '${FIXTURE}/old.txt'; : > '${FIXTURE}/new.txt'
  touch -d '2020-01-01 00:00:00' '${FIXTURE}/old.txt'
  touch -d '2020-01-01 01:00:00' '${FIXTURE}/new.txt'
  printf 'NEEDLE_ALPHA\\n' > '${FIXTURE}/sub/hit.txt'
  ln -sf /usr/bin/busybox '${SHAPE_DIR}/grep'
  ln -sf /usr/bin/busybox '${SHAPE_DIR}/find'
  echo SHAPE_READY`)
  check('the fixture tree and the busybox shape were built', setup.rc === 0 && setup.out.includes('SHAPE_READY'),
    `rc=${setup.rc} ${JSON.stringify(setup.out.slice(-60))}`)

  section('the premise each shape states before the product is asked anything')

  const gnu = await bash(`
  printf 'grep=%s\\n' "$(grep --version 2>/dev/null | head -n 1)"
  printf 'find=%s\\n' "$(find --version 2>/dev/null | head -n 1)"`)
  check('the control really is GNU grep and GNU find',
    /grep=.*GNU/.test(gnu.out) && /find=.*GNU/.test(gnu.out), JSON.stringify(gnu.out.trim()))

  const busy = await bashInShape(`
printf 'which_grep=%s\\n' "$(command -v grep)"
printf 'resolves_to=%s\\n' "$(readlink -f "$(command -v grep)")"
printf 'busybox_says=%s\\n' "$(busybox 2>&1 | head -n 1)"
if grep --version 2>/dev/null | head -n 1 | grep -q GNU; then echo gnu_check=TRUE; else echo gnu_check=FALSE; fi`)
  check('the busybox shape shadows grep, and what hides there is really busybox',
    busy.out.includes(`which_grep=${SHAPE_DIR}/grep`)
    && /resolves_to=.*busybox/.test(busy.out)
    && /BusyBox/i.test(busy.out)
    && busy.out.includes('gnu_check=FALSE'),
    JSON.stringify(busy.out.trim()))

  // ── the claims ───────────────────────────────────────────────────────────────

  const search = await load('search')
  const searchFile = resolvePath('search')
  const grepScript = scriptConst(searchFile, 'GREP_SCRIPT', ['grep is not GNU grep'])
  const globScript = scriptConst(searchFile, 'GLOB_SCRIPT', ['prune=', 'P%s'])
  console.log(`\n  scripts read from ${searchFile} (plane=${plane()}): grep ${grepScript.length} bytes, `
    + `glob ${globScript.length} bytes`)

  section('a distribution without GNU grep says so')

  const grepGnu = await runScript(search, grepScript, ['NEEDLE_ALPHA', '', FIXTURE, '65536'], undefined)
  check('the product\'s grep script runs on the GNU control and finds the needle',
    grepGnu.rc === 0 && grepGnu.out.includes('hit.txt'),
    `rc=${grepGnu.rc} out=${JSON.stringify(grepGnu.out.slice(0, 60))} err=${JSON.stringify(grepGnu.err.slice(0, 60))}`)

  const grepBusy = await runScript(search, grepScript, ['NEEDLE_ALPHA', '', FIXTURE, '65536'], SHAPE_PATH)
  check('the same bytes exit 3 on the busybox shape instead of returning misaligned results',
    grepBusy.rc === 3, `rc=${grepBusy.rc} err=${JSON.stringify(grepBusy.err.slice(0, 120))}`)

  check('and the diagnostic names the grep it found, which is what the panel promises',
    /grep is not GNU grep: /i.test(grepBusy.err),
    JSON.stringify(grepBusy.err.trim().slice(0, 160)))

  section("glob's modification-time order needs GNU find -printf")

  const globGnu = await runScript(search, globScript, [FIXTURE, '65536'], undefined)
  check('the product\'s glob script takes the GNU branch on the control',
    globGnu.rc === 0 && globGnu.out.startsWith('G'), `rc=${globGnu.rc} head=${JSON.stringify(globGnu.out.slice(0, 20))}`)

  const globBusy = await runScript(search, globScript, [FIXTURE, '65536'], SHAPE_PATH)
  check('and falls back to path order on busybox, which is what the panel warns about',
    globBusy.rc === 0 && globBusy.out.startsWith('P'),
    `rc=${globBusy.rc} head=${JSON.stringify(globBusy.out.slice(0, 20))}`)

  // ── teardown ─────────────────────────────────────────────────────────────────

  try {
    await bash(`rm -rf '${FIXTURE}' '${SHAPE_DIR}'`)
  } catch {
    // A fixture left behind is untidy, not a finding; the premises are asserted fresh next run.
  }

} catch (error) {
  abortedAfter = currentSection
  console.error(`\ndistro-shape-real: an escape inside section "${currentSection}" ended the run early`)
  console.error(`  ${String(error?.message ?? error)}`)
}

// ── verdict ──────────────────────────────────────────────────────────────────

const EXPECTED_CHECKS = 9
const failed = results.filter(r => !r.pass)
const passed = results.length - failed.length
const incomplete = abortedAfter !== null || results.length !== EXPECTED_CHECKS

console.log(`\n${'═'.repeat(72)}`)
console.log(`${passed}/${results.length} checks passed (plane=${plane()}, distro=${distro}, user=${user})`
  // "4/4 passed, FAILED: none" over a run that stopped after four cells is the most misleading line
  // this driver could print, so the headline says which of the two it is.
  + (incomplete ? ' — INCOMPLETE, so "passed" counts only what ran' : ''))

if (failed.length > 0) {
  console.log(`\nFAILED (${failed.length}):`)
  for (const r of failed) console.log(`  ✗ [${r.section}] ${r.name}${r.detail === undefined ? '' : `\n      ${r.detail}`}`)
} else {
  console.log(`\nFAILED: none${incomplete ? ' among the checks that ran' : ''}`)
}

if (results.length !== EXPECTED_CHECKS) {
  console.error(`\ndistro-shape-real: RED — ran ${results.length} checks, expected ${EXPECTED_CHECKS}; `
    + 'a short run must not report green'
    + (abortedAfter === null ? '' : ` (an escape inside section "${abortedAfter}" ended the run early)`))
  process.exitCode = 1
} else if (failed.length > 0) {
  console.error(`\ndistro-shape-real: RED — ${failed.length} check failure(s)`)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
