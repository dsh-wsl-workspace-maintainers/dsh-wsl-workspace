// The plant / run / revert engine shared by `scripts/mutation-sweep.mjs` and `tests/replay/run.mjs`.
//
// Both devices answer the same question — "if this defect were live again, would a gate notice?" —
// by editing the working tree, running the gates in cost order, and reverting. Two copies of that
// machinery would mean two definitions of "caught", and the one that is not being looked at is the
// one that lies. So the safety rules live here once:
//
//   · the tree must be clean before anything is planted (revert is `git checkout --`),
//   · every gate must be green on the clean tree before a single defect is planted — a gate that is
//     red for an environment reason answers "caught" for every mutation,
//   · a plant whose find-string does not match exactly once is INVALID, not a measurement,
//   · `lib/` is rebuilt lazily and only for gates that read it, and is always reverted with the file.
//
// @module scripts/mutation-engine
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * npm's own entry script, run on the interpreter already in hand.
 *
 * `spawnSync('npm', args, { shell: true })` is the shape `tests/tech-debt-exposure.test.ts` forbids —
 * argv through a shell is re-tokenised, and a path with a space arrives as something else. That gate
 * caught the sweep on its first CI run; the fix is the one its repair note prescribes: resolve
 * `npm-cli.js` and hand it to `process.execPath`, no interpreter in between.
 * @returns the absolute path of `npm-cli.js`.
 */
export function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'npm', 'bin', 'npm-cli.js'),
  ].filter(candidate => typeof candidate === 'string' && candidate.endsWith('.js'))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* next candidate */ }
  }
  throw new Error('mutation engine: cannot find npm-cli.js — run this through `npm run` or beside a node with npm')
}

/** The per-commit gates, cheapest first; the first red one ends the row. */
export const GATES = [
  { id: 'unit', script: 'test:unit' },
  { id: 'world', script: 'test:world' },
  { id: 'artifacts', script: 'test:artifacts' },
  { id: 'install', script: 'test:install' },
  { id: 'client', script: 'test:client' },
  { id: 'docs', script: 'test:docs' },
]

/**
 * Gates outside the fast set, asked for by name when a defect's lock lives in them.
 *
 * `win32` runs only on a Windows runner by design (see `docs/CHECK-CATALOG.md`), so a replay reading
 * taken from it is a reading of *this* platform; the driver names the gate so the difference is visible
 * in the row rather than hidden in the verdict.
 */
export const EXTRA_GATES = [
  { id: 'node', script: 'test:node' },
  { id: 'win32', script: 'test:win32' },
  { id: 'libsync', script: 'verify:lib-sync' },
]

/** Gates that answer from the built bundle: a `src/` edit is invisible to them until `lib/` is rebuilt. */
const LIB_READING = new Set(['client', 'artifacts', 'node'])

/** @returns the gate descriptor for an id. */
export function gateById(id) {
  const gate = [...GATES, ...EXTRA_GATES].find(candidate => candidate.id === id)
  if (gate === undefined) throw new Error(`mutation engine: unknown gate id "${id}"`)
  return gate
}

/** @returns the gate ids runnable on this platform, extras included (off-Windows skips `win32`). */
export function runnableIds(ids) {
  return ids.filter(id => !(id === 'win32' && process.platform !== 'win32'))
}

/** A clean tree is a precondition: the engine reverts with `git checkout -- <file>`. */
export function assertCleanTree(label) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (dirty !== '') {
    console.error(`${label}: the working tree is not clean; refusing to plant defects\n${dirty}`)
    process.exit(2)
  }
}

/**
 * Run a gate on the unmutated tree.
 * @param id - gate id.
 * @returns `{ ok, status, output }` with the gate's own stdout+stderr.
 */
export function runGate(id) {
  const gate = gateById(id)
  const run = spawnSync(process.execPath, [npmCli(), 'run', gate.script], { cwd: repoRoot, encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  return { ok: run.status === 0, status: run.status, output }
}

/**
 * Every gate a run intends to use must be green before the first plant; returns the red ones.
 * @param ids - gate ids in run order.
 * @returns the ids that are red on the clean tree.
 */
export function baselineRed(ids) {
  return runnableIds(ids).filter(id => !runGate(id).ok)
}

/**
 * Apply one plant.
 * @param plant - `{ file, find?, replace?, patch? }`; `find` must match exactly once.
 * @returns how many times it applied (0 = nothing matched, 2+ = ambiguous).
 */
export function plant({ file, find, replace, patch }) {
  const path = join(repoRoot, file)
  const before = readFileSync(path, 'utf8')
  if (patch !== undefined) {
    const after = patch(before)
    if (after === before) return 0
    writeFileSync(path, after, 'utf8')
    return 1
  }
  const count = before.split(find).length - 1
  if (count !== 1) return count
  writeFileSync(path, before.split(find).join(replace), 'utf8')
  return 1
}

/** Restore the planted file, and any `lib/` the build wrote from it. */
export function revert(file) {
  execFileSync('git', ['checkout', '--', file, 'lib'], { cwd: repoRoot })
  // A build from a mutated source emits differently-hashed chunks; `checkout` does not remove files
  // git never tracked, and those leftovers fail the next run's clean-tree check.
  execFileSync('git', ['clean', '-fdq', 'lib'], { cwd: repoRoot })
}

/**
 * Rebuild `lib/` from the mutated `src/`, the way the product does before its bundle-reading gates run.
 *
 * `npm run build` assumes `node_modules/.bin/tsdown`, which a checkout whose tree is not reified does
 * not have (this maintainer machine). The manual chain is the same three steps by absolute path, so the
 * sweep builds on both kinds of checkout instead of reading a missing binary as a failed mutation.
 * @returns `{ ok, detail }`.
 */
export function buildLib() {
  const steps = [
    [process.execPath, ['scripts/clean-lib.mjs']],
    [process.execPath, ['node_modules/tsdown/dist/run.mjs']],
    [process.execPath, ['scripts/verify-lib.mjs']],
  ]
  for (const [file, args] of steps) {
    const run = spawnSync(file, args, { cwd: repoRoot, encoding: 'utf8' })
    if (run.status !== 0) {
      return { ok: false, detail: `${file} ${args.join(' ')} exited ${run.status}: ${(run.stderr ?? '').slice(-300)}` }
    }
  }
  return { ok: true, detail: '' }
}

/**
 * Run the gates in order and stop at the first red.
 *
 * The build happens **lazily, only when a bundle-reading gate is reached and the plant asked for it**:
 * building up front would make the verdict depend on the build pipeline for defects an earlier gate
 * already catches — measured the hard way, twice.
 * @param ids - gate ids, in run order.
 * @param needsBuild - whether the plant lives in a module the bundle is built from.
 * @returns `{ gate: null }` when everything stayed green, else `{ gate, output }` for the first red —
 *   with `gate: 'build'` when the mutated tree cannot be bundled at all.
 */
export function firstRed(ids, needsBuild) {
  let built = null
  for (const id of runnableIds(ids)) {
    if (needsBuild && LIB_READING.has(id) && built === null) {
      built = buildLib()
      if (!built.ok) return { gate: 'build', output: built.detail }
    }
    const result = runGate(id)
    if (!result.ok) return { gate: id, output: result.output }
  }
  return { gate: null, output: '' }
}
