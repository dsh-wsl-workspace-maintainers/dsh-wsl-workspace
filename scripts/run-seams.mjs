/**
 * Run the seam suites without letting the first red hide the second, and hold the set of reds to
 * the declared ledger.
 *
 * Two separate jobs, in this order:
 *   1. print everything. Each suite is spawned, its verdict line, every `not ok:` / `✖` name and
 *      every `SKIP:` line is printed verbatim, and the count of red suites is reported. Nothing here
 *      suppresses a failure: the deliberate reds of #46 are evidence and they stay printed.
 *   2. gate on the SET, not on the pass/fail of the suites. `tests/deliberate-reds.mjs` declares
 *      which assertions are red on which machine shape (win32 = the maintainer machine, posix = the
 *      ubuntu runner). The runner exits 0 only when the observed set equals the declared set for this
 *      shape. So a new regression turns the frame red, and so does a red that quietly went green —
 *      which is the failure mode a permanently-red branch would have hidden.
 *
 *      Rule 2 has a precondition it did not enforce until 2026-10-13: the observed set is made of
 *      **named** reds. A suite that dies before emitting one (`rc` non-zero, no `not ok:`/`✖` line — a
 *      missing package, a changed verdict protocol) contributed nothing, so `declared 0 / observed 0`
 *      matched and the frame went green over two dead probes (frame 38350052793). Such a death is now
 *      itself an observed red, named `harness-exit: <suite>`, which has to be fixed or declared like
 *      any other red. A check nobody can see fail is not a check.
 *
 * Why not just let the suites decide the verdict: because #46 ships five assertions that must fail
 * until issue #44 §6 is repaired, and this project's accepted surface is "cloud checks green". A red
 * frame that is expected is a frame that cannot warn. Moving the gate to the ledger keeps the reds
 * AND keeps the warning.
 *
 *   node scripts/run-seams.mjs              # verdict + ledger check
 *   node scripts/run-seams.mjs --legacy     # old behaviour: exit with the count of red suites
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectObserved, compareLedger } from '../tests/deliberate-reds.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** [label, argv] — argv is what the repo's own gates advertise for that suite. */
const SUITES = [
  ['route-envelope (§6 exists:false fold)', ['tests/route-envelope.mjs']],
  ['search-run-fakes (§6 transport seams)', ['tests/search-run-fakes.mjs']],
  ['tech-debt-exposure (cmd.exe fallback, registry decode, NUL sniff)',
    ['--test', '--experimental-strip-types', 'tests/tech-debt-exposure.test.ts']],
  // The two consumer-side probes. They are here rather than only in `package.json` because a check
  // nobody runs is not a check: #54 and #78 sat for days with their cause already known and no gate
  // that could re-observe it. Both arms are required — a probe that only ever shows the red is exactly
  // the "instrument reporting its own absence" failure these files exist to prevent.
  ['w54-isolate-probe (read_image: answers in a root-realm world, throws in the generated isolate world, mutation removes the token)',
    ['--experimental-strip-types', 'tests/support/w54-isolate-probe.mjs']],
  ['w78-confine-probe (run_code resolves the host ACL runner at the root realm; our no-op answers only inside wsl-world)',
    ['--experimental-strip-types', 'tests/support/w78-confine-probe.mjs']],
]

const legacy = process.argv.includes('--legacy')
// `DSH_SEAM_SHAPE=posix` answers the ledger as if this run were on the ubuntu runner. It exists for
// one thing: a LIVE mutation control. On a win32 host the entry declared `skip` for posix is really
// red, so reading the same observation against the posix ledger must come back MOVED and fail the
// gate. That proves the gate reacts to a premise that changed, and not only to synthetic fixtures.
const shape = process.env.DSH_SEAM_SHAPE ?? (process.platform === 'win32' ? 'win32' : 'posix')
const observedRed = []
const observedSkip = []
const seenRed = new Set()
const seenSkip = new Set()
const suiteOfRed = new Map()

let failed = 0
for (const [label, argv] of SUITES) {
  const result = spawnSync(process.execPath, argv, { cwd: repo, encoding: 'utf8', timeout: 900_000 })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = out.split('\n')
  const verdict = lines.filter(l => /PASSED|FAILED \(\d+ failing\)|^# (pass|fail) \d+|^ℹ (tests|pass|fail) \d+/
    .test(l.trim())).map(l => l.trim().replace(/^ℹ /, '')).join(' / ')
  const collected = collectObserved(lines)
  for (const name of collected.red) {
    if (seenRed.has(name)) continue
    seenRed.add(name)
    observedRed.push(name)
    suiteOfRed.set(name, label)
  }
  for (const name of collected.skip) {
    if (seenSkip.has(name)) continue
    seenSkip.add(name)
    observedSkip.push(name)
  }
  console.log(`\n=== ${label}: rc ${result.status} — ${verdict || '(no verdict line)'} ===`)
  if (result.status !== 0 && collected.red.length === 0) {
    // A suite that exits non-zero **without naming a red** was invisible to the ledger: the observed set
    // stayed empty, `declared 0 / observed red 0` matched, and the frame went green over two dead
    // probes on the ubuntu runner (measured 2026-10-13, frame 38350052793). Count the death itself as
    // the red, named after its suite, so an unowned exit must be either fixed or declared like any
    // other red — and so a suite whose verdict protocol changed cannot quietly stop reporting.
    const name = `harness-exit: ${label} (rc ${result.status}, no red line emitted)`
    if (!seenRed.has(name)) {
      seenRed.add(name)
      observedRed.push(name)
      suiteOfRed.set(name, label)
    }
  }
  if (verdict === '') {
    // A suite that dies before its verdict line (a missing dependency, a bad import) would otherwise
    // contribute zero reds, and the ledger would report its declared reds as "missing" — the wrong
    // diagnosis for a broken harness. Show why it died.
    const tail = lines.filter(l => l.trim() !== '').slice(-6).join('\n    ')
    console.error(`  HARNESS: ${label} produced no verdict line; last lines of its output:\n    ${tail}`)
  }
  for (const line of lines.filter(l => l.startsWith('not ok:') || l.startsWith('✖ '))) console.error(`  ${line.trim()}`)
  for (const line of lines.filter(l => l.startsWith('SKIP:'))) console.warn(`  ${line.trim()}`)
  if (result.status !== 0) failed += 1
  if (result.error !== undefined) {
    console.error(`  harness error running ${label}: ${String(result.error.message)}`)
    failed += 1
  }
}

console.log(`\nrun-seams: ${failed} of ${SUITES.length} suite(s) red`)

if (legacy) {
  process.exit(failed === 0 ? 0 : 1)
}

const report = compareLedger(shape, { red: observedRed, skip: observedSkip })
console.log(`ledger (${shape}): declared ${report.declared}, observed red ${observedRed.length}, `
  + `observed skip ${observedSkip.length}`)
for (const entry of report.missing) console.error(`  LEDGER MISSING  ${entry}`)
for (const entry of report.moved) console.error(`  LEDGER MOVED    ${entry}`)
for (const entry of report.extraRed) {
  console.error(`  LEDGER UNDECLARED  ${entry} [${suiteOfRed.get(entry) ?? 'unknown suite'}] `
    + '— a red nobody owns: fix it or add it to tests/deliberate-reds.mjs with its debt and repair')
}
for (const entry of report.extraSkip) console.warn(`  ledger: undeclared skip ${entry}`)

if (report.ok) {
  console.log('ledger: the reds are exactly the declared ones — evidence intact, nothing new broken')
  process.exit(0)
}
console.error('ledger mismatch — this is the gate working, not a flake: a red appeared, disappeared, '
  + 'or moved shape without tests/deliberate-reds.mjs being edited in the same commit')
process.exit(1)
