// The ruler: replay the repository's real experience defects against the gates and count what reddens.
//
//   node tests/replay/run.mjs
//   node tests/replay/run.mjs --only persona-placeholder,drive-cwd-refused
//   node tests/replay/run.mjs --json
//
// Why a hit rate and not a coverage number. Issue #101 measured this suite against the 20 defects that
// actually reached users and found **0 of 20** — the budget went to properties the suite could already
// state, not to the shapes that broke. Coverage and test counts cannot see that mismatch; replaying the
// defects is the only reading that says whether the next one of these would be caught.
//
// What a row means. Each unit plants the smallest edit that puts its defect's class back into the tree,
// runs the gates in cost order, and reverts. A unit is `caught` only when **every** plant reddens a
// gate: one plant surviving is the half of the defect with no apparatus. `source` reads the failing
// check's own name — `issue-named` when the check says which report it was written for, `generic` when
// it reddened without naming one. Only the second kind would have stopped the original report, so
// `replay: X of 20` is reported with the strict number beside it, and the strict number is the one to
// watch. A device may well have been *born* from an issue and still be class-wide; the label is about
// what it asserts, not about why it was written.
//
// Nothing here asserts a target. The table in `defects.mjs` carries no expectation, so a rise in the
// count can only come from a gate that actually reddens.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  assertCleanTree, baselineRed, firstRed, plant, repoRoot, revert, runnableIds,
} from '../../scripts/mutation-engine.mjs'
import { CANONICAL, UNITS, gatesFor } from './defects.mjs'

/** @returns the CLI options this run was given. */
function options(argv) {
  const onlyIndex = argv.indexOf('--only')
  return {
    only: onlyIndex === -1 ? undefined : new Set(argv[onlyIndex + 1].split(',')),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    list: argv.includes('--list'),
    dry: argv.includes('--dry'),
  }
}

/**
 * Whether each plant still addresses exactly one spot in the tree, without writing anything.
 *
 * A plant whose find-string no longer matches reads as "caught" — nothing was planted, so nothing could
 * redden — which is the false green this device exists to avoid. Run `--dry` after any refactor.
 */
function checkPlants(units) {
  let bad = 0
  for (const unit of units) {
    for (const spec of unit.plants) {
      const source = readFileSync(join(repoRoot, spec.file), 'utf8')
      const hits = spec.patch !== undefined
        ? (spec.patch(source) === source ? 0 : 1)
        : source.split(spec.find).length - 1
      const label = hits === 1 ? 'ok  ' : hits === 0 ? 'STALE' : 'AMBIG'
      if (hits !== 1) bad += 1
      console.log(`${label} ${unit.id.padEnd(28)} ${spec.file} (${hits})`)
    }
  }
  console.log(`replay: ${bad === 0 ? 'every plant addresses exactly one spot' : `${bad} plant(s) do not — the table and the tree have drifted`}`)
  process.exit(bad === 0 ? 0 : 2)
}

/**
 * Decide whether the check that reddened was written for the class or for the case.
 *
 * The label reads the failing **check's own name**: a check whose name carries `#<issue>` was written
 * because that report arrived, and it says nothing about the next one. A check that reddened without
 * naming the issue is the kind that generalises — which is what #101 was really measuring. The file's
 * comments are deliberately not the signal: a class-wide device is often *born* from an issue, and the
 * whole point is whether it would still fire on a different instance.
 * @param issue - the defect number the plant replays.
 * @param names - the failing check names read out of the red gate's output.
 * @returns `'issue-named'` or `'generic'`.
 */
function catchSource(issue, names) {
  return names.some(name => name.includes(`#${issue}`)) ? 'issue-named' : 'generic'
}

/**
 * The checks that reddened, as the runner said them.
 * @param output - the red gate's own stdout+stderr.
 * @returns the failing check names (up to two), or the closing lines when nothing matched.
 */
function summarise(output) {
  const names = []
  for (const match of output.matchAll(/^\s*(?:✖|not ok \d+ -)\s+(.+?)(?:\s*\(\d+[^)]*\))?\s*$/gm)) {
    const name = match[1].trim()
    // The runner repeats a header before its summary; it is not the name of a check.
    if (name === '' || name === 'failing tests:') continue
    if (!names.includes(name)) names.push(name)
    if (names.length === 2) break
  }
  if (names.length === 0) {
    for (const match of output.matchAll(/(?:AssertionError|Error): ([^\n]{10,160})/g)) {
      names.push(match[1].trim())
      break
    }
  }
  if (names.length > 0) return names
  return [output.trim().split('\n').filter(line => line.trim() !== '').slice(-2).join(' | ').slice(0, 200)]
}

const opts = options(process.argv.slice(2))
const units = opts.only === undefined ? UNITS : UNITS.filter(unit => opts.only.has(unit.id))

if (opts.list) {
  for (const unit of units) console.log(`${unit.id}\t#${unit.issue}\t${unit.escape}\t${unit.plants.length} plant(s)`)
  process.exit(0)
}

if (opts.dry) checkPlants(units)

if (units.length === 0) {
  console.error(`replay: --only named nothing in the table (${UNITS.map(unit => unit.id).join(', ')})`)
  process.exit(2)
}

// Precondition 1: the sweep reverts with `git checkout --`, so a dirty tree is not a measurement.
assertCleanTree('replay')

// Precondition 2: every gate this run will consult must be green on the clean tree. A gate red for an
// environment reason (no jsdom, no pinned closure) answers "caught" for every plant.
const idsInScope = [...new Set(units.flatMap(gatesFor))]
const red = baselineRed(idsInScope)
if (red.length > 0) {
  console.error(`replay: these gates are red on a clean tree — an environment, not a measurement: ${red.join(', ')}`)
  console.error('replay: on a Windows-less runner `win32` is skipped; otherwise reify the tree (npm ci, node ci/install-pinned.mjs).')
  process.exit(2)
}

const started = Date.now()
const rows = []
for (const unit of units) {
  const results = []
  for (const plantSpec of unit.plants) {
    const applied = plant(plantSpec)
    if (applied !== 1) {
      revert(plantSpec.file)
      results.push({ verdict: 'INVALID', detail: `the find-string matched ${applied} times, not once` })
      continue
    }
    try {
      const { gate, output } = firstRed(gatesFor(unit), plantSpec.build === true)
      if (gate === null) {
        results.push({ verdict: 'MISS', detail: `${plantSpec.note} — no gate reddened` })
        continue
      }
      const names = summarise(output)
      results.push({
        verdict: 'caught',
        detail: `${gate}: ${plantSpec.note}`,
        source: gate === 'build' ? 'build' : catchSource(unit.issue, names),
        caughtAs: names.join(' / ').slice(0, 200),
      })
    } catch (error) {
      results.push({ verdict: 'ERROR', detail: String(error?.message ?? error) })
    } finally {
      revert(plantSpec.file)
    }
  }
  const invalid = results.filter(row => row.verdict === 'INVALID' || row.verdict === 'ERROR')
  const missed = results.filter(row => row.verdict === 'MISS')
  const caught = results.filter(row => row.verdict === 'caught')
  const verdict = invalid.length > 0 ? 'INVALID' : missed.length > 0 ? 'MISS' : 'caught'
  const generic = caught.filter(row => row.source === 'generic').length
  rows.push({
    issue: unit.issue,
    id: unit.id,
    escape: unit.escape,
    canonical: unit.canonical,
    verdict,
    strict: verdict === 'caught' && generic === caught.length,
    plants: results,
  })
  const label = verdict === 'caught' ? (rows.at(-1).strict ? 'OK  ' : 'ok  ') : verdict === 'INVALID' ? 'BAD ' : 'MISS'
  console.log(`${label} ${unit.id.padEnd(28)} #${String(unit.issue).padEnd(4)} ${verdict.padEnd(7)} ${caught.map(row => `${row.detail}${row.source === undefined ? '' : ` [${row.source}]`}`).join(' ; ') || missed.map(row => row.detail).join(' ; ') || invalid.map(row => row.detail).join(' ; ')}`)
  for (const row of results) if (row.caughtAs !== undefined) console.log(`       ↳ ${row.caughtAs}`)
}

const canonical = rows.filter(row => row.canonical)
const extras = rows.filter(row => !row.canonical)
const caughtOf = list => list.filter(row => row.verdict === 'caught').length
const strictOf = list => list.filter(row => row.strict).length
const broken = rows.filter(row => row.verdict === 'INVALID').length
const skipped = runnableIds(idsInScope).length !== idsInScope.length

console.log('')
// A `--only` run must not read like the headline: the denominator says which units were actually run.
const denominator = opts.only === undefined ? CANONICAL.length : canonical.length
console.log(`replay: ${caughtOf(canonical)} of ${denominator}${denominator === CANONICAL.length ? '' : ' (selected)'} caught`
  + ` — class-wide devices (strict): ${strictOf(canonical)}`
  + ` | extras (${caughtOf(extras)}/${extras.length})`
  + ` | ${((Date.now() - started) / 1000).toFixed(0)}s`)
if (skipped) console.log('note: `win32` gate rows were skipped on this platform; those units were judged without it.')
const skippedByFlag = (process.env.DSH_REPLAY_SKIP_GATES ?? '').split(',').map(id => id.trim()).filter(Boolean)
if (skippedByFlag.length > 0) {
  console.log(`ADJUDICATION RUN, not the headline: gates removed by DSH_REPLAY_SKIP_GATES=${skippedByFlag.join(',')}.` +
    ' A unit that still reddened was caught by something else; a unit that went MISS names a gate that was load-bearing.')
}
if (broken > 0) console.error(`replay: ${broken} unit(s) could not be measured — a plant that does not apply is not a reading.`)

if (opts.json) {
  const path = resolve(repoRoot, 'tests', 'replay', 'last-run.json')
  writeFileSync(path, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    caught: caughtOf(canonical),
    total: CANONICAL.length,
    strict: strictOf(canonical),
    gates: idsInScope,
    skippedGates: (process.env.DSH_REPLAY_SKIP_GATES ?? '').split(',').filter(entry => entry !== ''),
    rows,
  }, null, 2)}\n`, 'utf8')
  console.log(`replay: wrote ${relative(repoRoot, path)}`)
}

if (opts.strict) console.log('strict: the number that would have stopped the original report is the class-wide one.')

// The benchmark reports; it does not gate. A plant that cannot be applied, however, means the table
// and the tree have drifted apart, and that is worth failing a run over.
process.exit(broken > 0 ? 2 : 0)
