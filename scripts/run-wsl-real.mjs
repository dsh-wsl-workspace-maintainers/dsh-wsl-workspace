// Run the real-WSL compatibility drivers in sequence on one plane, accumulating every failure
// instead of stopping at the first one.
//
//   node --experimental-strip-types scripts/run-wsl-real.mjs --plane src
//   node --experimental-strip-types scripts/run-wsl-real.mjs --plane lib   (or DSH_WSL_TEST_PLANE=lib)
//
// The plane is named on the command line or in the environment, never defaulted — see plane.mjs
// for why that is the whole point (issue #44 §1). This runner refuses too, so a driver cannot be
// launched here on an assumed plane.
//
// Why this exists rather than a shell `for` loop in the workflow. `scripts/compatibility/plane.mjs`
// has no default plane (issue #44 §1), which means a driver on the lib plane can now legitimately
// *throw before its first assertion* — `skills-real` does exactly that, because `LOCATIONS` carries
// `skills: { src: …, lib: null }` and a module with no `lib/` entry throws rather than falling back.
// Under a plain sequential runner that throw is a stack trace on stderr and the process dies, so
// **every driver after it goes unreported**. A matrix that silently covered only the first three
// drivers reads exactly like a matrix that covered all of them and found nothing wrong.
//
// So this runner treats a driver as a *cell*, not as a step: each one's exit status and output is
// captured, the loop always continues, and the verdict is the accumulated FAIL count at the end.
// A driver that cannot run on this plane is reported as `not run` with the reason — never as a
// pass, and never as a silent absence.
//
// Exit codes: 0 every requested driver ran and was green (or was legitimately `not run`),
// 1 at least one driver failed or short-counted, 2 usage error.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The drivers, in the order ci.yml#wsl-gate runs them.
 *
 * `floor` is the minimum count of PASS lines (or, for the counted drivers, of checks) that must
 * appear for the cell to be read as green. These are not invented here — each is read off the
 * driver, and a short run must not report green:
 *   - `passLines`: fs-real prints 2 (fs-real.mjs:105-106), search-real 2 (search-real.mjs:296-297),
 *     skills-real 3 (skills-real.mjs:104-106). These drivers assert per statement and print a
 *     summary, so the summary line count is the only completion evidence they leave.
 *   - `checks`: bash-session-real declares `EXPECTED_CHECKS = 71` (bash-session-real.mjs:807) and
 *     tool-bash-real declares 10 (tool-bash-real.mjs:195); both print `N/M checks passed`.
 *   - bash-parity-real has no EXPECTED_CHECKS constant — it compares 14 probes and skips the 2
 *     `sessionOnly` ones (bash-parity-real.mjs:67-68), landing 12 results, and its own guard is
 *     only `results.length === 0` (bash-parity-real.mjs:204). 12 is the floor this matrix holds it
 *     to, so a driver that starts skipping more probes cannot read as a clean run.
 */
const DRIVERS = [
  { name: 'fs-real', script: 'fs-real.mjs', floor: { kind: 'passLines', value: 2 } },
  { name: 'skills-real', script: 'skills-real.mjs', floor: { kind: 'passLines', value: 3 }, libPlane: 'no-lib-entry' },
  { name: 'search-real', script: 'search-real.mjs', floor: { kind: 'passLines', value: 2 } },
  { name: 'relay-real', script: 'relay-real.mjs', floor: { kind: 'passLines', value: 2 } },
  { name: 'tool-bash-real', script: 'tool-bash-real.mjs', floor: { kind: 'checks', value: 10 } },
  { name: 'bash-session-real', script: 'bash-session-real.mjs', floor: { kind: 'checks', value: 71 } },
  { name: 'bash-parity-real', script: 'bash-parity-real.mjs', floor: { kind: 'checks', value: 12 } },
]

const args = process.argv.slice(2)
const only = readFlag('--drivers')
if (args.includes('--help')) {
  console.log('usage: node --experimental-strip-types scripts/run-wsl-real.mjs --plane src|lib'
    + ' [--drivers fs-real,skills-real] [--log-dir DIR]')
  console.log('  the plane may also come from DSH_WSL_TEST_PLANE in the environment; --plane wins.')
  console.log('  There is no default: plane.mjs throws on an unset plane and so does this runner.')
  process.exit(0)
}

function readFlag(name) {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}

// The plane is resolved here rather than imported so this runner stays a *harness* around the
// drivers and cannot itself become a second, laxer reader of DSH_WSL_TEST_PLANE (plane.mjs is the
// one reader, and it throws). `--plane` is an explicit naming, not a fallback: it is written on the
// command line where a reader can see it, which is what `npm run test:wsl` needs to work the same
// way in PowerShell, cmd and Git Bash without each of them needing a POSIX env prefix.
const plane = readFlag('--plane') ?? process.env.DSH_WSL_TEST_PLANE
if (plane !== 'src' && plane !== 'lib') {
  console.error(`run-wsl-real: the plane must be named "src" or "lib", got ${JSON.stringify(plane)}`
    + ' — pass --plane src|lib or set DSH_WSL_TEST_PLANE; plane.mjs has no default and neither'
    + ' does this runner')
  process.exit(2)
}

const requested = only === undefined
  ? DRIVERS
  : DRIVERS.filter(d => only.split(',').map(s => s.trim()).includes(d.name))
if (requested.length === 0) {
  console.error(`run-wsl-real: --drivers ${JSON.stringify(only)} named none of: ${DRIVERS.map(d => d.name).join(', ')}`)
  process.exit(2)
}

const logDir = resolve(readFlag('--log-dir') ?? resolve(repoRoot, 'logs'))
mkdirSync(logDir, { recursive: true })

/** One cell's verdict. `notRun` is a first-class outcome, never folded into `pass`. */
const cells = []

for (const driver of requested) {
  // The declared gap: tsdown.config.ts emits no entry for the skills provider, so plane.mjs throws
  // for it under lib. Reported by name so a reader can see the cell was considered and declined,
  // which is a different statement from a cell that was never requested.
  if (driver.libPlane === 'no-lib-entry' && plane === 'lib') {
    const reason = 'plane.mjs has no lib/ entry for "skills" (tsdown declares none; the class is '
      + 'file-local to lib/index.js:1122) and throws rather than falling back to src/'
    cells.push({ driver: driver.name, verdict: 'not run', reason })
    console.log(`not run  ${driver.name} (plane=lib): ${reason}`)
    continue
  }

  const argv = ['--experimental-strip-types', resolve(repoRoot, 'scripts', 'compatibility', driver.script)]
  const started = Date.now()
  const run = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    env: { ...process.env, DSH_WSL_TEST_PLANE: plane },
    encoding: 'utf8',
    timeout: 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const logPath = resolve(logDir, `${driver.name}.log`)
  writeFileSync(logPath, output, 'utf8')

  // A spawn that never ran (EBUSY/EPERM on this host, or a timeout) is `not run` too, with the
  // reason attached. Reporting it as a failure would be a lie about the product; reporting it as a
  // pass would be worse.
  if (run.error !== undefined) {
    const reason = `the driver process could not be started: ${run.error.code ?? run.error.message}`
    cells.push({ driver: driver.name, verdict: 'not run', reason, ms: Date.now() - started })
    console.log(`not run  ${driver.name}: ${reason} (${run.error.code ?? ''})`.trimEnd())
    continue
  }

  const counted = /(\d+)\/(\d+) checks passed/.exec(output)
  const passLines = output.split('\n').filter(l => l.startsWith('PASS ')).length
  const reached = driver.floor.kind === 'checks'
    ? (counted === null ? 0 : Number(counted[2]))
    : passLines

  if (run.status !== 0) {
    cells.push({ driver: driver.name, verdict: 'fail', rc: run.status, floor: `${reached}/${driver.floor.value} ${driver.floor.kind}`, ms: Date.now() - started })
    console.log(`FAIL     ${driver.name} rc=${run.status} (${reached}/${driver.floor.value} ${driver.floor.kind}) — ${logPath}`)
    tail(output)
    continue
  }
  if (reached < driver.floor.value) {
    // A green exit with a short count is the shape that reads as a pass and is not one.
    cells.push({ driver: driver.name, verdict: 'fail', rc: 0, floor: `${reached}/${driver.floor.value} ${driver.floor.kind} — short run must not report green`, ms: Date.now() - started })
    console.log(`FAIL     ${driver.name} ${reached}/${driver.floor.value} ${driver.floor.kind} — a short run must not report green`)
    tail(output)
    continue
  }

  cells.push({ driver: driver.name, verdict: 'pass', floor: `${reached}/${driver.floor.value} ${driver.floor.kind}`, ms: Date.now() - started })
  console.log(`ok       ${driver.name} ${reached}/${driver.floor.value} ${driver.floor.kind} (${Date.now() - started} ms) — ${logPath}`)
}

function tail(text) {
  for (const line of text.split('\n').filter(l => l.trim() !== '').slice(-6)) console.log(`    | ${line}`)
}

const ran = cells.filter(c => c.verdict === 'pass' || c.verdict === 'fail')
const failed = cells.filter(c => c.verdict === 'fail')
const notRun = cells.filter(c => c.verdict === 'not run')
console.log(`\nrun-wsl-real (plane=${plane}): ${ran.length}/${requested.length} ran, `
  + `${failed.length} failed, ${notRun.length} not run`)
for (const cell of notRun) console.log(`  not run: ${cell.driver} — ${cell.reason}`)
process.exit(failed.length === 0 ? 0 : 1)