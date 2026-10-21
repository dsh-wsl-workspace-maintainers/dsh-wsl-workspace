// The two readings a release has to carry, recorded and then checked by a gate.
//
//   node scripts/release-readings.mjs --record    # maintainer: run the ruler and the contract gate, write ci/release-readings.json
//   node scripts/release-readings.mjs --check     # CI / pre-publish: the recorded readings must exist and still hold
//
// Why this is a gate and not a paragraph. Issue #101 measured the suite against 20 real defects and got
// **0 of 20**; this branch built the ruler that reads that number, and a ruler nobody runs at release is
// a one-off audit souvenir rather than a capability. Two readings are therefore mandatory per release:
//
//   · **replay hit rate** — `X of 20` defects caught, with the class-wide count beside it, and every
//     miss named with its reason. A release may not go out with an unexplained miss.
//   · **what the contract gate sees** — the host names this plugin asks for, the worlds generated, and
//     the collisions found. This is the reading that says whether the drift defence caught anything,
//     as opposed to being switched on.
//
// What the check refuses, each in the shape that actually happens:
//   · no row for the version being published — the readings were never taken;
//   · a row whose `tableSha` differs from the ruler's current bytes — the measurement is stale, and a
//     stale number is the one thing a standing metric must not be;
//   · a contract reading that differs from what this tree produces right now — the recorded number was
//     not earned by the artifact being shipped;
//   · a replay miss that is not listed, or listed without a reason.
//
// @module scripts/release-readings
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readingsPath = join(repoRoot, 'ci', 'release-readings.json')
const replayJson = join(repoRoot, 'tests', 'replay', 'last-run.json')
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const want = flag => process.argv.includes(flag)

/**
 * A hash of the ruler's own bytes, so a reading can be proved to belong to *this* definition of the
 * measurement. Editing a unit, a plant or the strict-label rule changes the number's meaning, and the
 * recorded row has to be re-taken rather than carried forward.
 */
function tableSha() {
  const hash = createHash('sha256')
  for (const file of ['tests/replay/defects.mjs', 'tests/replay/run.mjs', 'scripts/mutation-engine.mjs']) {
    hash.update(readFileSync(join(repoRoot, file), 'utf8'))
  }
  return hash.digest('hex').slice(0, 12)
}

/** @returns the gate's own summary line, parsed. */
function contractReading() {
  const run = spawnSync(process.execPath, ['scripts/check-host-contract.mjs', '--check'], {
    cwd: repoRoot, encoding: 'utf8',
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const match = /(\d+) service names, (\d+) worlds, (\d+) collision\(s\)/.exec(output)
  if (match === null) {
    throw new Error(`release-readings: the contract gate produced no reading (exit ${run.status}):\n${output.slice(-400)}`)
  }
  const drift = output.split('\n').filter(line => /^\s+[-+] (service|collision|lib)/.test(line)).length
  return {
    services: Number(match[1]),
    worlds: Number(match[2]),
    collisions: Number(match[3]),
    driftLines: drift,
    green: run.status === 0,
  }
}

/** Run the ruler and read back the JSON it writes. */
function replayReading() {
  const run = spawnSync(process.execPath, ['tests/replay/run.mjs', '--json'], { cwd: repoRoot, encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status !== 0) {
    throw new Error(`release-readings: the replay did not complete (exit ${run.status}):\n${output.split('\n').slice(-8).join('\n')}`)
  }
  const reading = JSON.parse(readFileSync(replayJson, 'utf8'))
  const misses = reading.rows
    .filter(row => row.canonical && row.verdict !== 'caught')
    .map(row => ({ issue: row.issue, id: row.id, plants: row.plants.map(plant => `${plant.verdict}: ${plant.detail}`) }))
  const extras = reading.rows.filter(row => !row.canonical).map(row => `#${row.issue} ${row.verdict}`)
  return {
    caught: reading.caught,
    total: reading.total,
    strict: reading.strict,
    head: reading.head,
    seconds: Math.round((new Date(reading.capturedAt).getTime() - new Date(reading.capturedAt).getTime()) / 1000) || null,
    misses,
    extras,
  }
}

/** @returns the recorded rows, keyed by version. */
function recorded() {
  if (!existsSync(readingsPath)) return {}
  return JSON.parse(readFileSync(readingsPath, 'utf8')).versions ?? {}
}

if (want('--record')) {
  console.log('release-readings: running the replay (this takes minutes by design)…')
  const replay = replayReading()
  const contract = contractReading()
  const rows = recorded()
  rows[version] = {
    takenAt: new Date().toISOString().replace(/T(\d{2}):(\d{2}).*/, ' $1$2').slice(0, 16),
    head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    tableSha: tableSha(),
    replay: { caught: replay.caught, total: replay.total, strict: replay.strict, misses: replay.misses, extras: replay.extras },
    contract: { services: contract.services, worlds: contract.worlds, collisions: contract.collisions },
  }
  writeFileSync(readingsPath, `${JSON.stringify({
    note: 'the two readings a release carries, written by `npm run release:readings`; `npm run test:readings` (and the publish job) refuse a version without them. Do not hand-edit.',
    versions: rows,
  }, null, 2)}\n`, 'utf8')
  console.log(`release-readings: recorded ${version} — replay ${replay.caught}/${replay.total} (class-wide ${replay.strict}), contract ${contract.services} names / ${contract.worlds} worlds / ${contract.collisions} collision(s)`)
  process.exit(0)
}

if (!want('--check')) {
  console.error('release-readings: expected --record or --check')
  process.exit(2)
}

const row = recorded()[version]
const problems = []
if (row === undefined) {
  problems.push(`no recorded readings for ${version} — run \`npm run release:readings\` and commit ci/release-readings.json`)
} else {
  if (row.tableSha !== tableSha()) {
    problems.push(`${version}'s replay row was taken against a different ruler (recorded ${row.tableSha}, this tree ${tableSha()}) — the number no longer describes these units; re-record`)
  }
  const contract = contractReading()
  if (!contract.green) problems.push('the contract gate is red on this tree — the release cannot carry its own reading')
  if (contract.collisions !== row.contract.collisions || contract.services !== row.contract.services || contract.worlds !== row.contract.worlds) {
    problems.push(`the contract reading moved since it was recorded: now ${contract.services} names / ${contract.worlds} worlds / ${contract.collisions} collision(s), recorded ${row.contract.services} / ${row.contract.worlds} / ${row.contract.collisions}`)
  }
  if (row.replay.caught !== row.replay.total && row.replay.misses.length === 0) {
    problems.push(`replay ${row.replay.caught}/${row.replay.total} with no listed miss — every uncaught defect must be named with its reason`)
  }
  for (const miss of row.replay.misses) {
    if (miss.plants.length === 0) problems.push(`#${miss.issue} is uncaught with no reason recorded`)
  }
  console.log(`release-readings: ${version} @ ${row.head} — replay ${row.replay.caught}/${row.replay.total} (class-wide ${row.replay.strict}, ${row.replay.misses.length} named miss(es), extras ${row.replay.extras.join(' ')}), contract ${row.contract.services} names / ${row.contract.worlds} worlds / ${row.contract.collisions} collision(s)`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`release-readings: ${problem}`)
  process.exit(1)
}
console.log('release-readings: both readings are present, current, and clean')
