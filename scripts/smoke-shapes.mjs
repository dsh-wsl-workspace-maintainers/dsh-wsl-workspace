// The shortest chain, per workspace shape: register → open → list → close.
//
//   node scripts/smoke-shapes.mjs                  # the decision chain, offline, all shapes
//   DSH_SMOKE_REAL=1 node scripts/smoke-shapes.mjs # add the listing over a real distribution
//
// What this is for. `tests/world-consistency.test.mjs` asks every provider the same question and
// compares their answers; that is the agreement reading. This driver asks a different one — can a
// session of this shape be **started, used, and put down** — which is the chain #86 and #78 reached
// the end of. One pass per shape, ~30 s: the per-commit matrix is not re-run per shape, because
// running the whole suite eleven times over is the same over-investment the replay ruler exists to stop.
//
// What each arm proves, said plainly:
//   · offline — the derivation and the refusal. Nothing is spawned, so no line here may claim a
//     session was opened; the row prints `nothing spawned` for that reason.
//   · real (`DSH_SMOKE_REAL=1`) — one `ls` per shape through the product's own spelling of `wsl.exe`.
//     It answers in three ways, and they are not interchangeable: the directory listed, it refused
//     **in words** (what a fixture path on a machine that never had it must do), or it failed
//     **silently**, which is always red — a listing that dies without a sentence is how #36 arrived.
//   The real arm carries a positive control (the default distribution's `/` must list) because an arm
//   that only ever reports refusals is indistinguishable from an arm that does nothing. A live PTY
//   session is still `npm run test:session`'s claim, not this one's.
//
// @module scripts/smoke-shapes

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { PROVIDERS, WORKSPACE_SHAPES, workspaceStoreEntries } = await import('../tests/replay/shapes.mjs')
const { resolveTarget } = await import('../src/host/wsl-search.ts')
const { buildSessionSpec, PROBE_CONFIG } = await import('../src/host/wsl-bash-tool.ts')
const { listDistros, wslExecutableCandidates } = await import('../src/shared/wsl.ts')

// The same fixture the agreement table uses: a temp home carrying the drive registrations, so the
// reading does not depend on which distribution this machine happens to call default.
const home = mkdtempSync(join(tmpdir(), 'dsh-shapes-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'wsl-workspaces.json'), JSON.stringify(workspaceStoreEntries()), 'utf8')

const real = process.env.DSH_SMOKE_REAL === '1'
const started = Date.now()
const failures = []
const notes = []

/** @returns the derived world, or a refusal — never a guess. */
function open(shape) {
  const spec = buildSessionSpec({ ...PROBE_CONFIG, distro: shape.configured ?? '' }, shape.cwd)
  const target = resolveTarget(shape.cwd, shape.configured)
  if (target === undefined || spec === undefined) return { kind: 'refused' }
  const at = flag => {
    const index = spec.argv.indexOf(flag)
    return index === -1 ? undefined : spec.argv[index + 1]
  }
  return { kind: 'world', distro: at('-d') ?? target.distro, linuxCwd: target.linuxCwd }
}

/**
 * One `ls`, answered as listed / a sentence / a silent failure.
 * @param distro - the distribution the world derived.
 * @param linuxCwd - the directory it would list.
 * @returns the three-way reading.
 */
function listing(distro, linuxCwd) {
  let sawSentence = ''
  for (const candidate of wslExecutableCandidates('wsl.exe')) {
    try {
      execFileSync(candidate, ['-d', distro, '--', 'ls', '-1', linuxCwd], { encoding: 'utf8', timeout: 8_000 })
      return { kind: 'listed' }
    } catch (error) {
      const text = `${error?.stdout ?? ''} ${error?.stderr ?? ''} ${error?.message ?? ''}`.trim()
      if (text !== '') {
        return { kind: 'sentence', why: text.split('\n')[0].slice(0, 90) }
      }
      sawSentence = text
    }
  }
  return { kind: 'silent', why: sawSentence }
}

// The instrument's own sentinel: without a reading that must succeed, every refusal below is
// indistinguishable from a driver that never ran the command.
let control = { kind: 'skipped' }
if (real) {
  const distros = await listDistros()
  control = distros.length === 0
    ? { kind: 'unverifiable', why: 'no distribution is reachable from this machine' }
    : listing(distros[0], '/')
  if (control.kind !== 'listed') {
    failures.push(`the control listing (${distros[0]}:/) did not succeed — it answered ${control.kind}${control.why === undefined ? '' : `: ${control.why}`}`)
  }
  notes.push(`control ${distros[0] ?? '-'}/: ${control.kind}`)
}

for (const shape of WORKSPACE_SHAPES) {
  for (const [key, value] of Object.entries(shape.sessionEnv)) process.env[key] = value
  const world = open(shape)
  const answer = world.kind !== 'world'
    ? { kind: 'refused' }
    : !real
      ? (shape.real === undefined ? { kind: 'offline' } : { kind: 'skip', why: shape.real })
      : listing(world.distro, world.linuxCwd)
  const line = `${shape.id.padEnd(22)} ${world.kind === 'world'
    ? `${world.distro} ${world.linuxCwd}`.slice(0, 56).padEnd(57)
    : 'refused'.padEnd(57)} list=${answer.kind.padEnd(8)} ${real && answer.kind !== 'refused' ? 'ls exited, no handle left' : 'nothing spawned'}`

  // Two assertions, both about the class rather than the row: a shape the table says serves a world
  // may not be refused by the chain, and a listing may never fail without saying why.
  if (shape.expect[PROVIDERS[0]] === 'world' && world.kind !== 'world') {
    failures.push(`${shape.id}: the table says this shape serves a world, the chain refused it`)
    console.log(`FAIL ${line}`)
    continue
  }
  if (answer.kind === 'silent') {
    failures.push(`${shape.id}: the listing failed without a sentence`)
    console.log(`FAIL ${line}`)
    continue
  }
  if (answer.kind === 'skip') notes.push(`${shape.id}: real-machine-only (${answer.why})`)
  console.log(`${answer.kind === 'skip' ? 'SKIP' : 'ok  '} ${line}`)
}

rmSync(home, { recursive: true, force: true })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log('')
console.log(`smoke-shapes: ${WORKSPACE_SHAPES.length} shapes, ${seconds}s, ${real ? 'decision chain + real listing' : 'decision chain (offline)'}`)
for (const note of notes) console.log(`  ${note}`)
if (!real) console.log('  real listing NOT RUN: the shapes marked real-machine-only were not exercised. `DSH_SMOKE_REAL=1` runs them.')
if (failures.length > 0) {
  for (const failure of failures) console.error(`smoke-shapes: ${failure}`)
  process.exit(1)
}
