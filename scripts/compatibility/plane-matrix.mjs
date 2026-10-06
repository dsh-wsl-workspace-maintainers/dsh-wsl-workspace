#!/usr/bin/env node
// The 2×2 plane/user matrix, run as a script in the repo rather than in a scratch directory.
//
//   node scripts/compatibility/plane-matrix.mjs
//   node scripts/compatibility/plane-matrix.mjs --ci-as-root-only --drivers fs-real
//
// 2 planes × 2 users × 6 drivers = 24 cells. Each cell gets its OWN fixture root, because
// `ci.yml:186-188` already established that these drivers create rather than clean their tree:
// two passes over one `/tmp/dsh-wsl-compat` is a race, not a rerun, so a shared root turns a real
// defect into a flake and a flake into a dismissal.
//
// This is a NEW script, not a moved one. The `D:/Temp/issue51-matrix/` exploration that produced
// the conclusions below was 68 files of one-shot probes with no orchestrator; `wire-ci.mjs` in it
// was a four-anchor text patcher whose effect is already in ci.yml. What is worth keeping is the
// *answers* — which drivers, which dimensions, which traps — and those are in the comments below.
//
// Two dimensions, and each answers a different question:
//   - **plane** (`src` | `lib`): which bytes are under test. `lib/` is committed and ships, so a
//     src-only gate says nothing about what a user installs (issue #44 §1). `plane.mjs` has no
//     default, so a cell that does not name its plane cannot run at all.
//   - **user** (`root` | `ruler`): a WSL identity is not a constant. `/root` and `/home/ruler` have
//     different `$HOME`, a different `~/.dsh`, and a different answer to "may this session sudo".
//     A gate that only ever runs as root is measuring one column of a 2×2 and calling it a grid.
//
// The report answers three questions in a fixed order, because a matrix that prints a wall of lines
// leaves the reader to guess which of them matter:
//   1. did every requested cell run?
//   2. were they green?
//   3. what did not run, and why?
//
// `--ci-as-root-only` runs the root column alone — the GitHub runner has exactly one user — and the
// report's last line says so **unconditionally**, so a green matrix states its own coverage instead
// of implying a completeness it does not have. The exit code is NOT red for the missing column: a
// runner cannot create a second user as a gate step, and reddening that would mean the column is
// never measured at all. The declaration is the enforcement.
//
// This script cannot pass on a host without a working `wsl.exe`: it is the only channel into WSL
// (`src/` references it 74 times), and where that channel is blocked the cells are reported
// `not run` with the error, which is the honest outcome and not a green.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('usage: node scripts/compatibility/plane-matrix.mjs [--ci-as-root-only] '
    + '[--drivers fs-real,...] [--users root,ruler] [--distro NAME] [--log-dir DIR]')
  process.exit(0)
}
const flag = name => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}

const ciAsRootOnly = args.includes('--ci-as-root-only')
const distro = flag('--distro') ?? process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu-24.04'
const logDir = resolve(flag('--log-dir') ?? resolve(repoRoot, 'logs', 'plane-matrix'))
mkdirSync(logDir, { recursive: true })

/**
 * The six drivers. `skills-real` is in this list **because** of its lib-plane behaviour, not
 * despite it: those two cells must be visible in the report as `not run`, so the matrix needs to
 * know about them to say they were declined rather than quietly absent.
 *
 * The floors are read off the drivers, never estimated. `checks` counts the `N/M checks passed`
 * line; `passLines` counts leading `PASS ` lines. Each is annotated with where it was read.
 */
const DRIVERS = [
  // bash-session-real.mjs:807 — `const EXPECTED_CHECKS = 71`
  { name: 'bash-session-real', floor: { kind: 'checks', value: 71, at: 'bash-session-real.mjs:807' } },
  // tool-bash-real.mjs:195 — `const EXPECTED_CHECKS = 10`
  { name: 'tool-bash-real', floor: { kind: 'checks', value: 10, at: 'tool-bash-real.mjs:195' } },
  // bash-parity-real.mjs:46-69 declares 14 probes, of which 2 are `sessionOnly`
  // (bash-parity-real.mjs:67-68) and are `continue`d before a result is recorded
  // (bash-parity-real.mjs:169-171), so 12 results is a complete run. Its own guard is only
  // `results.length === 0` (bash-parity-real.mjs:204), which a driver that started skipping more
  // probes would satisfy — hence the floor lives here.
  { name: 'bash-parity-real', floor: { kind: 'checks', value: 12, at: 'bash-parity-real.mjs:46-69 minus :67-68' } },
  // fs-real.mjs:105-106 prints two PASS lines and nothing else summarises it.
  { name: 'fs-real', floor: { kind: 'passLines', value: 2, at: 'fs-real.mjs:105-106' } },
  // search-real.mjs:296-297, same shape.
  { name: 'search-real', floor: { kind: 'passLines', value: 2, at: 'search-real.mjs:296-297' } },
  // skills-real.mjs:104-106 prints three. Declined on the lib plane — plane.mjs throws for it,
  // because `LOCATIONS` carries `skills: { src: …, lib: null }` and a module with no lib entry
  // throws rather than falling back to src/. A silent fallback is the exact false green #44 §1 is
  // about; adding the tsdown entry changes what users install, so it is a maintainer decision.
  { name: 'skills-real', floor: { kind: 'passLines', value: 3, at: 'skills-real.mjs:104-106' }, libPlane: 'no-lib-entry' },
]

const requestedNames = flag('--drivers')?.split(',').map(s => s.trim()).filter(Boolean)
const drivers = requestedNames === undefined
  ? DRIVERS
  : DRIVERS.filter(d => requestedNames.includes(d.name))
if (drivers.length === 0) {
  console.error(`plane-matrix: --drivers ${JSON.stringify(flag('--drivers'))} named none of: ${DRIVERS.map(d => d.name).join(', ')}`)
  process.exit(2)
}

const allUsers = (flag('--users') ?? 'root,ruler').split(',').map(s => s.trim()).filter(Boolean)
const users = ciAsRootOnly ? allUsers.slice(0, 1) : allUsers
const rulerColumnDropped = ciAsRootOnly && allUsers.length > 1
const planes = ['src', 'lib']

/**
 * One fixture root per cell, named so the log line and the directory agree. `WSL_COMPAT_ROOT` is
 * what `search-real` and `skills-real` read (search-real.mjs:20, skills-real.mjs:18); `fs-real`,
 * `relay-real`, `tool-bash-real` and the two session drivers take their root from the distro's own
 * `$HOME`, so for those the per-cell naming still matters for the *user* column — the two users
 * have different homes, which is the point of running both.
 */
const rootFor = (plane, user, driver) => `/tmp/dsh-matrix-${plane}-${user}-${driver}`

const cells = []
for (const plane of planes) {
  for (const user of users) {
    for (const driver of drivers) {
      const cell = { plane, user, driver: driver.name, floor: driver.floor }
      const label = `${plane}/${user}/${driver.name}`

      if (driver.libPlane === 'no-lib-entry' && plane === 'lib') {
        cell.verdict = 'not run'
        cell.reason = 'plane.mjs declares no lib/ entry for "skills" (tsdown.config.ts emits none; '
          + 'the class is file-local to lib/index.js:1122) and throws instead of falling back to src/'
        cells.push(cell)
        console.log(`not run  ${label} — ${cell.reason}`)
        continue
      }

      // MSYS_NO_PATHCONV goes in the **env object**, not in a command-line prefix.
      //
      // ci.yml:182 sets it as `MSYS_NO_PATHCONV=1 WSL_COMPAT_ROOT=/tmp/dsh-wsl-parity node …`,
      // which works because that line is typed into GitHub's `bash` and the MSYS runtime rewrites
      // the arguments of the process that shell is about to start. Here there is no such shell:
      // `spawnSync` receives an argv array and the MSYS rewriter has no command line to inspect, so
      // the prefix form has nothing to attach to and would be silently ineffective. In the env
      // object it is inherited by the child process itself, which is where the flag has to be
      // readable — a stronger position, because it no longer depends on a shell being in the chain
      // at all. The trap it prevents is real either way: without it the Windows runner rewrites
      // `/tmp/dsh-matrix-…` into `C:\tmp\dsh-matrix-…` and the driver assembles
      // `\\wsl.localhost\Ubuntu-24.04C:\tmp\…` (ci.yml:203-207, frame 36736537229, errno -4094).
      const run = spawnSync(process.execPath,
        ['--experimental-strip-types', resolve(repoRoot, 'scripts', 'compatibility', `${driver.name}.mjs`)],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DSH_WSL_TEST_PLANE: plane,
            WSL_COMPAT_DISTRO: distro,
            WSL_COMPAT_USER: user,
            WSL_COMPAT_ROOT: rootFor(plane, user, driver.name),
            MSYS_NO_PATHCONV: '1',
          },
          encoding: 'utf8',
          timeout: 15 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
        })

      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      const logPath = resolve(logDir, `${plane}-${user}-${driver.name}.log`)
      writeFileSync(logPath, output, 'utf8')

      if (run.error !== undefined) {
        cell.verdict = 'not run'
        cell.reason = `the driver process could not be started (${run.error.code ?? run.error.message}); `
          + 'wsl.exe is the only channel into WSL, so without it this cell is unmeasured, not green'
        cells.push(cell)
        console.log(`not run  ${label} — ${cell.reason}`)
        continue
      }

      const counted = /(\d+)\/(\d+) checks passed/.exec(output)
      const reached = driver.floor.kind === 'checks'
        ? (counted === null ? 0 : Number(counted[2]))
        : output.split('\n').filter(l => l.startsWith('PASS ')).length
      cell.reached = reached
      cell.log = logPath

      if (run.status !== 0) {
        cell.verdict = 'fail'
        cell.detail = `rc=${run.status}, ${reached}/${driver.floor.value} ${driver.floor.kind}`
      } else if (reached < driver.floor.value) {
        cell.verdict = 'fail'
        cell.detail = `${reached}/${driver.floor.value} ${driver.floor.kind} — a short run must not report green`
      } else {
        cell.verdict = 'pass'
        cell.detail = `${reached}/${driver.floor.value} ${driver.floor.kind}`
      }
      cells.push(cell)
      console.log(`${cell.verdict === 'pass' ? 'ok      ' : 'FAIL    '} ${label} — ${cell.detail}`)
      if (cell.verdict === 'fail') {
        for (const line of output.split('\n').filter(l => l.trim() !== '').slice(-6)) console.log(`    | ${line}`)
      }
    }
  }
}

const ran = cells.filter(c => c.verdict !== 'not run')
const passed = cells.filter(c => c.verdict === 'pass')
const failed = cells.filter(c => c.verdict === 'fail')
const notRun = cells.filter(c => c.verdict === 'not run')

// The three questions, in this order, always.
console.log('\n== 1. did every requested cell run? ==')
console.log(`${ran.length}/${cells.length} cells ran`
  + (notRun.length === 0 ? ' — every requested cell was measured' : `; ${notRun.length} did not (see 3)`))

console.log('\n== 2. were they green? ==')
console.log(`${passed.length}/${ran.length} of the cells that ran were green`
  + (ran.length === 0 ? ' — nothing was measured, so nothing is claimed' : ''))
if (failed.length > 0) {
  for (const cell of failed) console.log(`  FAIL ${cell.plane}/${cell.user}/${cell.driver} — ${cell.detail}`)
}

console.log('\n== 3. what did not run, and why? ==')
if (notRun.length === 0) console.log('nothing — the full grid was measured') 
for (const cell of notRun) console.log(`  not run ${cell.plane}/${cell.user}/${cell.driver} — ${cell.reason}`)
console.log(`\nfloors held: ${DRIVERS.map(d => `${d.name} ${d.floor.value} ${d.floor.kind} (${d.floor.at})`).join('; ')}`)

// Anti-rot: the report is the artifact, and an unread artifact is how this rotted the first time.
writeFileSync(resolve(logDir, 'report.txt'),
  [`plane-matrix: distro=${distro} planes=${planes.join(',')} users=${users.join(',')} drivers=${drivers.map(d => d.name).join(',')}`,
    ...cells.map(c => `${c.verdict}\t${c.plane}\t${c.user}\t${c.driver}\t${c.detail ?? c.reason ?? ''}\t${c.log ?? ''}`),
    rulerColumnDropped ? 'ruler column not run (--ci-as-root-only): no second user on this host' : '',
  ].filter(Boolean).join('\n'), 'utf8')

// The declaration goes last, unconditionally, and never decides the exit code.
const exitCode = failed.length === 0 ? 0 : 1
if (rulerColumnDropped) {
  console.log('ruler 腿未跑，本机无第二用户，4 格中 2 格未测')
}
process.exit(exitCode)