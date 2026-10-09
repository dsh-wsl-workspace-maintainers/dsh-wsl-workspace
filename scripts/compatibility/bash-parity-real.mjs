// The same probe script, run through two real `bash` tools, with the answers compared field by
// field: the host's one-shot tool dispatching to this plugin's executor, and this plugin's session
// tool. Every difference the run finds must be a row in `docs/bash-parity.md`, and every row that
// claims alignment must still be aligned.
//
//   node --experimental-strip-types scripts/compatibility/bash-parity-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/bash-parity-real.mjs
//
// Why a differential and not more assertions. The session tier is a replacement for a tool the model
// already knows how to use, so "it works" is the wrong bar: the right bar is "the same call gets the
// same kind of answer". That is only checkable by asking both, and the answer set is small enough to
// compare mechanically. Where the two disagree, the disagreement is either declared in the ledger or
// this driver is red — a difference nobody wrote down is the thing that surprises a user.
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { load, plane } from './plane.mjs'

const repoRoot = resolvePath(import.meta.dirname, '..', '..')
const at = p => pathToFileURL(p).href
const DEPS = `${repoRoot}/ci/deps/node_modules/@deepseek-ai`
const hostModule = (m) => m.default ?? m

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const username = process.env.WSL_COMPAT_USER ?? 'root'
const linuxHome = username === 'root' ? '/root' : `/home/${username}`
const sessionCwd = `\\\\wsl.localhost\\${distro}${linuxHome.replaceAll('/', '\\')}`

const host = (name) => {
  for (const root of [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]) {
    const candidate = join(root, ...name.split('/'), 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * One probe. `row` names the ledger entry that licenses a difference; `aligned` rows must agree.
 * `timeoutMs` keeps every call bounded, and `sessionOnly` skips the comparison for probes the
 * one-shot world cannot answer without services an in-process harness does not mount (jobs).
 */
const probes = [
  { name: 'computed echo', args: { command: 'echo PARITY_$(( 13 * 7 ))' } },
  { name: 'nonzero exit', args: { command: 'false' } },
  { name: 'stderr separated', args: { command: 'echo out; echo err >&2' } },
  { name: 'absolute workdir', args: { command: 'pwd', workdir: '/tmp' } },
  { name: 'relative workdir', row: 'behaviour-workdir-missing-layer', args: { command: 'pwd', workdir: 'definitely-not-here-parity' } },
  { name: 'large output spills', row: 'behaviour-spill-shape', normalize: 'numbers', args: { command: 'seq 1 200000', timeoutMs: 60_000 } },
  { name: 'prompt is empty', args: { command: 'printf "PS1=[%s]\\n" "$PS1"' } },
  { name: 'no controlling terminal', args: { command: 'tty; stty size 2>&1' } },
  // The host's schema does not forbid extra properties, so this reaches its tool with `tty` ignored —
  // which is the point: one call, two worlds, and the escalated one has no second channel to put
  // `err` in. The row licenses the difference; if the two ever answer identically, the row is wrong.
  { name: 'an escalated call has one stream', row: 'behaviour-escalated-streams', args: { command: 'echo MERGE_$(( 3 * 3 )); echo err >&2', tty: true } },
  { name: 'interactive flags', row: 'behaviour-interactive-flags', args: { command: 'echo flags=$-' } },
  // Measured against the distribution's own `bash -ic` on 2026-10-05: an alias used on the line that
  // defines it is not yet an alias there either, so the *failure* is bash's rule and not a difference
  // between these two worlds. What differs is who reports it — the interactive shell sources the
  // distribution's command-not-found handler, the one-shot shell does not — and a model that reads a
  // suggestion sentence should be able to tell which world it is in.
  { name: 'alias used on the line that defines it', row: 'behaviour-command-not-found', args: { command: 'alias dshparity=echo; dshparity HI_5' } },
  { name: 'state persists', row: 'behaviour-state-persistence', args: { command: 'echo READ_BACK=${PARITY_VAR:-unset}' } },
  { name: 'background arm shape', sessionOnly: true, args: { command: 'echo BG', run_in_background: true } },
  { name: 'timeout is reported', sessionOnly: true, args: { command: 'sleep 5', timeoutMs: 1_500 } },
]

/** The comparable shape of one answer: which fields are present, which markers the model reads, and
 * the body itself. Comparing only the fields would pass a tool that answers the right *kind* of
 * question with the wrong words. */
function signature(value, rendered, normalize) {
  const markers = [...String(rendered).matchAll(/\[(exit code|timed out after|killed by signal|output truncated|stderr|the shell[^\]]*|still running[^\]]*)/g)]
    .map(match => match[1].replace(/[^a-z ]/g, '').trim())
  const spillPath = value?.stdout?.spillPath
  return {
    kind: String(value?.kind ?? 'threw'),
    exitCode: value?.exitCode === null || value?.exitCode === undefined ? 'null' : typeof value.exitCode,
    signal: value?.signal === null || value?.signal === undefined ? 'null' : typeof value.signal,
    timedOut: String(value?.timedOut ?? 'absent'),
    truncated: String(value?.stdout?.truncated ?? 'absent'),
    spill: spillPath === undefined ? 'absent' : 'present',
    // The promise of a spill file is that it holds the whole stream, so that is what gets compared —
    // how many bytes each path keeps in memory is a buffer-cap detail of the two implementations.
    spillLines: spillPath === undefined ? 'absent' : readFileSync(spillPath, 'utf8').trim().split('\n').length,
    markers: [...new Set(markers)].sort().join(','),
    body: (normalize === 'numbers'
      ? String(rendered).replace(/\d+/g, 'N')
      : String(rendered)).replace(/dsh-subprocess-[A-Za-z0-9._+-]+/g, 'spill-path')
      .replace(/\\/g, '/').replace(/\s+/g, ' ').trim().slice(0, 120),
  }
}

async function worldOneShot() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  for (const name of ['@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
    await ctx.plugin(hostModule(await import(at(host(name)))))
  }
  const shellModule = await load('shell')
  const WslShellExecutor = shellModule.default ?? shellModule.WslShellExecutor
  await ctx.plugin(WslShellExecutor, {
    cwd: sessionCwd, distro, username, timeoutMs: 30_000, maxTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1024, maxSpillBytes: 4 * 1024 * 1024, graceMs: 500,
  })
  const bash = await import(at(host('@deepseek-ai/dsh-tool-bash')))
  await bash.apply(ctx, new bash.Config({}))
  await new Promise(resolve => setTimeout(resolve, 50))
  const tool = ctx.tools.get('bash')
  return { tool, name: 'host one-shot', owner: ownerOf('parity-one-shot') }
}

async function worldSession() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  for (const module of [
    await import(at(host('@deepseek-ai/dsh-shell-env'))),
    await import(at(host('@deepseek-ai/dsh-tools'))),
    await import(at(host('@deepseek-ai/dsh-system-prompt'))),
  ]) await ctx.plugin(hostModule(module))
  const sessionTool = await load('wsl-bash-tool')
  // The same per-stream cap the one-shot world is mounted with above: comparing two tools with
  // different limits would measure the configuration, not the tools.
  await ctx.plugin(sessionTool.default ?? sessionTool,
    { ...sessionTool.PROBE_CONFIG, maxOutputBytes: 64 * 1024, distro, username })
  await new Promise(resolve => setTimeout(resolve, 50))
  return { tool: ctx.tools.get('bash'), name: 'session', owner: ownerOf('parity-session') }
}

function ownerOf(id) {
  const session = { id, cwd: sessionCwd, header: { cwd: sessionCwd, id } }
  return {
    id: `agent-${id}`,
    session,
    ctx: { on: () => () => {}, effect: (fn) => { try { fn?.() } catch { /* no lifecycle here */ } return () => {} } },
  }
}

const results = []
function check(name, pass, detail) {
  results.push(pass === true)
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// The two readings this file now depends on get a control that needs no distribution: `--self-test`
// runs them against files this process writes, so the widened quiet window and the mismatch re-read
// are both seen working rather than assumed.
if (process.argv.includes('--self-test')) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-parity-selftest-'))
  const failures = []
  try {
    const file = join(dir, 'spill.txt')
    writeFileSync(file, 'a\n'.repeat(100))
    const writer = (async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
      appendFileSync(file, 'b\n'.repeat(100))
    })()
    const seen = await settleSpill(file)
    await writer
    const truth = statSync(file).size
    // `statSync().size` is a number, and the first version of this control compared it to a BigInt:
    // the control failed while the code under it was right. Numbers on both sides, as the loop uses.
    if (seen.settled === true && Number(seen.size) === truth) {
      console.log(`self-test: a 400 ms stall did not look settled (read ${truth} bytes after ${seen.waitedMs} ms)`)
    } else {
      failures.push(`the settle read ${seen.size} of ${truth} bytes — a 400 ms stall slipped through`)
    }

    const shortFile = join(dir, 'short.txt')
    const longFile = join(dir, 'long.txt')
    writeFileSync(shortFile, 'x\n'.repeat(3))
    writeFileSync(longFile, 'x\n'.repeat(9))
    const sides = [
      { spill: { settled: true, size: 6, path: shortFile }, signature: { spillLines: 9 } },
      { spill: { settled: true, size: 18, path: longFile }, signature: { spillLines: 9 } },
    ]
    const happened = await reconcileSpillReads(sides[0], sides[1])
    if (happened && sides[0].signature.spillLines === 3 && sides[1].signature.spillLines === 9) {
      console.log('self-test: a size mismatch re-read both counts (3 and 9, not the stale 9 and 9)')
    } else {
      failures.push(`the mismatch re-read did not happen: ${JSON.stringify(sides.map(side => side.signature))}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const failure of failures) console.error(`bash-parity-real self-test: ${failure}`)
  console.log(`bash-parity-real self-test: ${failures.length === 0 ? 'OK' : 'RED'}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

const oneShot = await worldOneShot()
const session = await worldSession()
for (const world of [oneShot, session]) {
  if (world.tool === undefined) {
    console.log(`bash-parity-real: RED — the ${world.name} world mounted no bash tool; there is nothing to compare`)
    process.exit(1)
  }
}
// Seed the persistent world's variable; the probe that reads it is the point of seeding it.
await session.tool.execute({ command: 'export PARITY_VAR=kept_$(( 6 * 7 ))', description: 'seed' },
  { signal: AbortSignal.timeout(60_000), agent: session.owner })

const rows = readFileSync(join(repoRoot, 'docs', 'bash-parity.md'), 'utf8').split('\n')
  .flatMap((line) => {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|.*\|\s*([^|]+?)\s*\|\s*$/.exec(line)
    return match === null ? [] : [{ id: match[1], kind: match[2], verdict: match[3] }]
  })

const differences = []
for (const probe of probes) {
  const theirs = probe.sessionOnly === true ? { skipped: true } : await ask(oneShot, probe)
  const ours = await ask(session, probe)
  if (theirs.skipped === true) {
    console.log(`  skip ${probe.name} — the host's one-shot world cannot answer it without the jobs registry`)
    continue
  }
  await reconcileSpillReads(theirs, ours)
  const differs = JSON.stringify(theirs.signature) !== JSON.stringify(ours.signature)
  const row = probe.row === undefined ? undefined : rows.find(entry => entry.id === probe.row)
  const aligned = row !== undefined && /^aligned/.test(row.verdict)
  // The spill poll's verdict rides on the detail. It is what distinguishes "the two worlds really
  // disagree" from "the file was still being written when this cell read it", which is the difference
  // between a product defect and a measurement taken too early — and the two look identical in the
  // signature alone. Only the lines that print a detail carry it, so a green cell stays quiet.
  const detail = `${JSON.stringify(theirs.signature)} vs ${JSON.stringify(ours.signature)}`
    + ` — spill: host ${describeSpill(theirs.spill)}, session ${describeSpill(ours.spill)}`
  // A file that was still growing when it was read is a measurement taken too early, not a
  // difference — the two are identical in the signature. It gets its own verdict so the red says
  // "read it again" rather than "the two worlds disagree": frame 37888856516 printed the host's
  // half-written file (1,563 lines short) as a product difference.
  if ([theirs.spill, ours.spill].some(spill => spill?.settled === false)) {
    check(`${probe.name}: the spill had stopped growing before it was read`, false, detail)
    continue
  }
  if (differs && row === undefined) {
    check(`${probe.name}: every difference is declared`, false, `undocumented: ${detail} — add a row to docs/bash-parity.md and name it in this probe`)
  } else if (differs && aligned) {
    check(`${probe.name}: the ledger says these worlds agree`, false, detail)
  } else if (!differs && row !== undefined && !aligned) {
    check(`${probe.name}: the ledger still says they differ`, false,
      `row ${row.id} declares a difference and the two worlds now answer identically — update docs/bash-parity.md`)
  } else {
    check(`${probe.name}: ${differs ? 'differs, as ' : 'agrees, as '}${row?.id ?? 'declared'}`, true, differs ? detail : undefined)
  }
  if (differs) differences.push(row?.id ?? 'UNDECLARED')
}

async function ask(world, probe) {
  const args = { ...probe.args, description: `bash-parity-real: ${probe.name}` }
  try {
    const value = await world.tool.execute(args, { signal: AbortSignal.timeout(90_000), agent: world.owner })
    // A spill file is the subprocess's own handle to close, and the tool's answer does not wait for
    // its last write — the file goes on growing for a moment after `execute` resolves. Wait for the
    // size to hold still, keep the whole-stream promise as the assertion, and carry the poll's own
    // verdict out so a failure can say whether the file had finished when it was read.
    const spill = await settleSpill(value?.stdout?.spillPath)
    const rendered = (world.tool.output?.render?.(args, value) ?? []).map(part => String(part?.text ?? '')).join('')
    return { signature: signature(value, rendered, probe.normalize), spill }
  } catch (error) {
    return { signature: { kind: 'threw', error: String(error?.message ?? error).slice(0, 60) }, spill: undefined }
  }
}

/**
 * Read a spill file only once it has stopped growing.
 *
 * The tool's answer does not wait for the spill's last write — the file belongs to the subprocess and
 * goes on growing for a moment after `execute` resolves — so the cell waits for the size to hold still.
 *
 * **One equal pair is not stability.** The first version returned as soon as two samples 100 ms apart
 * matched, and a single delayed write satisfies that: on the WSL1 frame this cell has now read a file
 * that was still being written at least three times — `seq 1 200000` counted as 197,852, then 193,756,
 * and on frame 37888856516 as 198,437 — each time reporting it as a product difference. A run of equal
 * samples costs a second on a settled file, and 150 ms is now known to be too short. The detail
 * carries how long the file took to hold still, so a longer stall can be told from a disagreement
 * rather than guessed at.
 *
 * **And a file that never settles is named as such.** The caller gets `settled: false` rather than a
 * plausible number, so a failure message can say which side it is on instead of printing "the two
 * worlds disagree" about a file that nobody had finished writing.
 * @param path - the spill path the tool reported, when there was one.
 * @returns whether the size held still, the last size seen, and how many samples were taken.
 */
async function settleSpill(path) {
  if (typeof path !== 'string' || path === '') return { settled: true, size: 0, samples: 0, waitedMs: 0, path: '' }
  // 10 samples 100 ms apart: the size has to stand still for a second, not merely match once. A
  // settled file costs that second; a file that never settles is reported as such after 30 s.
  const STABLE_SAMPLES = 10
  const INTERVAL_MS = 100
  const MAX_MS = 30_000
  let previous = -1
  let equal = 0
  let size = 0
  let samples = 0
  const startedAt = Date.now()
  const until = startedAt + MAX_MS
  while (Date.now() < until) {
    try {
      size = statSync(path).size
    } catch {
      // No file to read is the tool's own answer — a spill that failed to open reports no path — so
      // there is nothing to wait for.
      return { settled: true, size: 0, samples, waitedMs: Date.now() - startedAt, path }
    }
    samples += 1
    if (size === previous) {
      equal += 1
      if (equal >= STABLE_SAMPLES) return { settled: true, size, samples, waitedMs: Date.now() - startedAt, path }
    } else {
      equal = 0
      previous = size
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
  }
  return { settled: false, size, samples, waitedMs: Date.now() - startedAt, path }
}

/**
 * Settle both spill files again when their sizes disagree, then re-derive both line counts.
 *
 * Both worlds ran the same command, so both files must end up holding the same bytes; a mismatch means
 * at least one of them was read before its writer stopped. The trigger is that invariant rather than a
 * longer pause — the quiet window decides when a file is worth reading, this decides whether the two
 * are comparable at all.
 * @returns whether the re-read happened.
 */
async function reconcileSpillReads(theirs, ours) {
  const usable = side => typeof side?.spill?.path === 'string' && side.spill.path !== ''
  if (!usable(theirs) || !usable(ours) || theirs.spill.size === ours.spill.size) return false
  for (const side of [theirs, ours]) {
    const again = await settleSpill(side.spill.path)
    if (again.settled) side.spill = again
  }
  const spillLinesOf = spill => readFileSync(spill.path, 'utf8').trim().split('\n').length
  if (typeof theirs.signature?.spillLines === 'number') theirs.signature.spillLines = spillLinesOf(theirs.spill)
  if (typeof ours.signature?.spillLines === 'number') ours.signature.spillLines = spillLinesOf(ours.spill)
  return true
}

/**
 * Say what the spill poll saw, for a failure message.
 * @param spill - what `settleSpill` returned, when it ran.
 * @returns a short phrase naming whether the file stopped growing.
 */
function describeSpill(spill) {
  if (spill === undefined) return 'not read'
  if (spill.samples === 0) return 'no file to read'
  return spill.settled
    ? `${spill.size} bytes, still for a second after ${spill.waitedMs} ms (${spill.samples} samples)`
    : `STILL GROWING at ${spill.size} bytes when the 30 s budget ran out (${spill.samples} samples)`
}

const passed = results.filter(Boolean).length
console.log(`${passed}/${results.length} checks passed (plane=${plane()}, distro=${distro}, user=${username})`)
if (passed !== results.length || results.length === 0) {
  console.error('bash-parity-real: RED — a difference was found that the ledger does not license, or an aligned row drifted')
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
