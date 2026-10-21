/**
 * G1 — the world-consistency table (issue #101).
 *
 * Every provider in this plugin has to answer the same question from the same input: *given this
 * session cwd, which distribution and which Linux directory is this?* Each one answers it in its own
 * file, and nothing compared them. Issue #86 is what that costs: `fs`, `shell`, `search`, `relay`,
 * `terminal` and the per-session env contributor all grew a Windows-drive branch, the search twin did
 * not, so `grep`/`glob` refused every drive-path workspace with "only available in a WSL workspace
 * session" — while `bash` and `read` worked in the same session. Issue #49 is the same shape one
 * layer out (the client half never translated at all).
 *
 * So this file is not a list of cases. It is **one table**, fed to every decision seam the sources
 * export, with two assertions that make the #86 class unrepeatable:
 *
 *   1. **Agreement** — the providers that claim a shape must derive the same `{distro, linuxCwd}`,
 *      and a provider that does not serve a shape must refuse it out loud rather than guess at it.
 *   2. **Completeness** — the set of modules that import a world primitive is *derived from `src/`*
 *      and compared with the registry below. A new provider that decides the world cannot be added
 *      without a row, and a row cannot claim coverage no cell exercises.
 *
 * Two cells are known to disagree with the table. They are registered with the reason and the owning
 * ticket instead of being softened into the expectation: `REGISTERED_GAPS` must redden when the cell
 * starts agreeing, so a paid debt cannot be left declared (the arithmetic `tests/deliberate-reds.mjs`
 * established for the seam suite).
 *
 * The fixture models a **session**, which is why the drive cells set `DSH_WSL_DISTRO`: the host's own
 * env contributor derives it from the same store (`src/index.ts` `shellEnv.register`), and a session
 * always has it. Setting it here is what makes the comparison mean "do the providers agree about one
 * session" rather than "do they agree about a host process that has not started one".
 *
 * Needs the pinned host tree (`wsl-search.ts` and `wsl-bash-tool.ts` import schemastery), so it runs
 * in `npm run test:node`, not `test:unit`.
 *
 *   node --experimental-strip-types --test tests/world-consistency.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The workspace store is read through `DSH_HOME` at call time, so a temp home with one drive-path
// registration is enough to make the drive cells deterministic on any machine (CI has no `wsl.exe`,
// and `defaultDistroSync()` there is `undefined` — a cell leaning on the registry default would be
// green on a maintainer machine and red on the runner, which is not a measurement).
const home = mkdtempSync(join(tmpdir(), 'dsh-world-'))
process.env.DSH_HOME = home
// The shape list lives in one file (`tests/replay/shapes.mjs`) because two consumers have to agree on
// it: this table, and the shortest-chain smoke driver that walks the same rows against a real share.
const { DRIVE_CWD, DRIVE_DISTRO, PROVIDERS, WORKSPACE_SHAPES, workspaceStoreEntries } = await import('./replay/shapes.mjs')
writeFileSync(join(home, 'wsl-workspaces.json'), JSON.stringify(workspaceStoreEntries()))

const { resolveTarget } = await import('../src/host/wsl-search.ts')
const { buildSessionSpec, PROBE_CONFIG } = await import('../src/host/wsl-bash-tool.ts')
const { backendCwd } = await import('../src/host/wsl-terminal-tool.ts')
const { WslSkillsProvider } = await import('../src/host/wsl-skills.ts')
const { fileAddressFor, isWslWorkspace, distroOfWorkspace, rewriteReferenceAddress } = await import('../src/client/references.ts')
const { joinUnc } = await import('../src/shared/paths.ts')

/**
 * One cell's answer, in the only three forms a provider may produce.
 * @param value - the adapter's raw answer.
 * @returns `{kind:'world'}` with the derived pair, `{kind:'refused'}`, or `{kind:'quiet'}` for a
 *   provider that declines without an error (a catalog that answers "nothing here").
 */
function outcome(value) {
  if (value === undefined || value === null) return { kind: 'refused' }
  return { kind: 'world', distro: value.distro, linuxCwd: value.linuxCwd }
}

/**
 * The `-d` / `--cd` a persistent-shell session would start with.
 *
 * The question this table asks is the *directory* one, so a session with no `--cd` makes no claim
 * about the world and reads as a refusal here — otherwise a host process that happens to have a
 * distribution on this machine would answer a shape the session never had (`defaultDistroSync()` is
 * `undefined` on the Linux runner and a real name on a maintainer machine, which is not a reading).
 */
function bashOf(cwd) {
  const spec = buildSessionSpec({ ...PROBE_CONFIG, distro: '' }, cwd)
  if (spec === undefined) return { kind: 'refused' }
  const at = (flag) => {
    const index = spec.argv.indexOf(flag)
    return index === -1 ? undefined : spec.argv[index + 1]
  }
  const linuxCwd = at('--cd')
  if (linuxCwd === undefined) return { kind: 'refused' }
  return { kind: 'world', distro: at('-d'), linuxCwd }
}

/** Search's own seam. */
function searchOf(cwd, configured) {
  return outcome(resolveTarget(cwd, configured))
}

/**
 * The keyboard door's seam. It takes a *requested* path, so a Linux path is the cell that asks the
 * question: a provider that knows the distribution must translate it, and one that does not must say
 * so. `undefined` is the answer for "no requested path" and says nothing about the world.
 */
function terminalOf(cwd, requested = '/tmp/g1/probe') {
  try {
    const answer = backendCwd(requested, cwd)
    if (answer === undefined || answer === cwd) return { kind: 'refused' }
    return { kind: 'world', path: answer }
  } catch {
    return { kind: 'refused' }
  }
}

/**
 * The skill provider's seam, measured in *whether it looked at all*.
 *
 * A catalog that finds no skills and a catalog that never looked are the same empty array to a user,
 * and that is exactly the failure being policed here — so the reading is "how many substrate calls did
 * this lookup make", not "what did it return". A fake substrate (empty directories) keeps the answer
 * platform-free: no UNC string is ever asserted, so this reads the same on the Windows and Ubuntu
 * runners.
 * @param cwd - the session workspace path.
 * @param tree - optional fake tree, keyed by a normalised path (see {@link normalisePath}).
 * @returns `{kind:'world'}` with the read count, or `{kind:'quiet'}` when it never touched the substrate.
 */
async function skillsOf(cwd) {
  const reads = { count: 0, paths: [] }
  const record = path => { reads.count += 1; reads.paths.push(path) }
  const io = {
    readdir: async path => { record(path); return [] },
    readFile: async path => { record(path); return '' },
    stat: async path => { record(path); return { isDirectory: true } },
  }
  const control = { signal: new AbortController().signal, invalidate: () => {} }
  const provider = new WslSkillsProvider(control, io)
  const candidates = await provider.list(cwd === undefined ? {} : { cwd })
  if (reads.count === 0) return { kind: 'quiet' }
  return { kind: 'world', reads: reads.count, paths: reads.paths, candidates }
}

/** Paths compared as the substrate sees them: either spelling, either slash, case-folded. */
const normalisePath = path => path.replaceAll('\\', '/').toLowerCase()

/**
 * The table. `world` is what every provider that serves the shape must derive; `expect` names, per
 * provider, whether this shape is its business.
 *
 * `sessionEnv` is the `DSH_WSL_DISTRO` a real session carries for that workspace shape (`src/index.ts`
 * contributes it for both UNC and drive cwds), and `configured` is the world's own `distro` setting.
 */
// The table itself is in `tests/replay/shapes.mjs`; `world` is what every provider that serves the
// shape must derive, and `expect` names, per provider, whether this shape is its business.
const SHAPES = WORKSPACE_SHAPES

/**
 * Cells that disagree with the table today, with the reason and the owner.
 *
 * Registering is not permission: the assertion below reddens when a registered cell *starts*
 * agreeing, so the entry cannot outlive the defect.
 */
const REGISTERED_GAPS = new Map([
  // Empty, and that is the reading: the two cells that were registered here (`skills/drive-workspace`
  // and `terminal/drive-workspace`) were closed by the product change that followed (#101). A gap can
  // only be recorded against a cell the table expects to work, and the arithmetic below reddens in both
  // directions — so a new entry has to be earned by a real divergence, not by preference.
])





/** Run one cell against one provider, with that shape's env in place. */
async function run(shape, provider) {
  const saved = { ...process.env }
  try {
    for (const [key, value] of Object.entries(shape.sessionEnv)) process.env[key] = value
    process.env.DSH_HOME = home
    if (provider === 'search') return searchOf(shape.cwd, shape.configured)
    if (provider === 'bash') return bashOf(shape.cwd)
    if (provider === 'terminal') return terminalOf(shape.cwd)
    return await skillsOf(shape.cwd)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

/** A registered-gap key, or undefined. */
const gapKey = (shapeId, provider) => `${provider}/${shapeId}`

/**
 * Judge one cell. Extracted from the loop so the registry arithmetic can be exercised by
 * construction (see the control test below) instead of only through a live provider.
 * @param shape - the table row.
 * @param provider - which seam answered.
 * @param reading - what it answered.
 * @returns the disagreements this cell contributes; empty is a pass.
 */
function judge(shape, provider, reading, gaps = REGISTERED_GAPS) {
  const expected = shape.expect[provider]
  const key = gapKey(shape.id, provider)
  const registered = gaps.has(key)

  if (registered && expected === 'world') {
    // A registered gap is a cell that SHOULD serve the shape and does not. If it starts serving, the
    // debt is paid and the entry is now a lie — red, naming the entry to delete.
    return reading.kind === 'world'
      ? [`${key}: the registered gap now answers correctly — delete the entry from REGISTERED_GAPS`]
      : []
  }
  if (registered) {
    return [`${key}: registered, but the table expects '${expected}' — a gap can only be recorded against a cell that should work`]
  }
  if (expected !== reading.kind) return [`${shape.id}/${provider}: expected ${expected}, got ${reading.kind}`]
  if (expected !== 'world') return []
  if (provider === 'terminal') {
    // The door answers a *startable* path, not a pair: for a UNC session it must be the same
    // distribution and the same Linux path the other two just agreed on.
    const wanted = joinUnc(shape.world.distro, '/tmp/g1/probe')
    return reading.path === wanted ? [] : [`${shape.id}/terminal: path ${JSON.stringify(reading.path)} ≠ ${JSON.stringify(wanted)}`]
  }
  if (provider === 'skills') return []
  const out = []
  if (reading.distro !== shape.world.distro) {
    out.push(`${shape.id}/${provider}: distro ${JSON.stringify(reading.distro)} ≠ ${JSON.stringify(shape.world.distro)}`)
  }
  if (reading.linuxCwd !== shape.world.linuxCwd) {
    out.push(`${shape.id}/${provider}: linuxCwd ${JSON.stringify(reading.linuxCwd)} ≠ ${JSON.stringify(shape.world.linuxCwd)}`)
  }
  return out
}

test('every provider derives the same world for the same cwd, or refuses out loud', async () => {
  const disagreements = []
  for (const shape of SHAPES) {
    for (const provider of PROVIDERS) {
      disagreements.push(...judge(shape, provider, await run(shape, provider)))
    }
  }
  assert.deepEqual(disagreements, [], `world decisions disagree:\n  ${disagreements.join('\n  ')}`)
})

test('the registry arithmetic bites in both directions', async () => {
  // Mutation control for the gate's own logic, in the shape `client-classnames` established: the table
  // is empty today (the two cells it used to carry were closed by the product change behind #101), so
  // this exercises the arithmetic against a registry it builds itself — otherwise the control would
  // disappear exactly when the debt is paid, which is the moment it must still be able to bite.
  const shape = SHAPES.find(entry => entry.id === 'drive-workspace')
  assert.ok(shape !== undefined, 'the drive-workspace cell must exist')
  const probeGaps = new Map([['skills/drive-workspace', 'control: a registered cell']])

  const closed = judge(shape, 'skills', { kind: 'world', reads: 3 }, probeGaps)
  assert.equal(closed.length, 1, 'a paid debt must redden, not pass')
  assert.match(closed[0], /delete the entry from REGISTERED_GAPS/)

  const stillOpen = judge(shape, 'skills', { kind: 'quiet' }, probeGaps)
  assert.deepEqual(stillOpen, [], 'an open, declared gap is the one state that may pass')

  const relative = SHAPES.find(entry => entry.id === 'relative')
  assert.ok(relative !== undefined)
  assert.deepEqual(judge(relative, 'terminal', { kind: 'refused' }), [],
    'a cell the table expects to refuse passes when it refuses')
  const misRegistered = judge({ ...shape, expect: { ...shape.expect, skills: 'quiet' } }, 'skills', { kind: 'quiet' }, probeGaps)
  assert.equal(misRegistered.length, 1, 'a gap recorded against a cell the table does not expect to work must redden')
  assert.match(misRegistered[0], /a gap can only be recorded/)

  const drift = judge(shape, 'search', { kind: 'world', distro: DRIVE_DISTRO, linuxCwd: '/mnt/f/WRONG' })
  assert.equal(drift.length, 1, 'a provider answering a different Linux directory must redden')
  assert.match(drift[0], /linuxCwd/)
})

test('the drive registration the session env reads is the one the store holds', async () => {
  // The one cross-provider fact the table cannot see from inside a provider: `DSH_WSL_DISTRO` is
  // derived from the same store the drive cells depend on. If the key spelling drifts (a different
  // canonical form, a different case), every drive cell above would still agree with itself while
  // the session carried no distro at all — and `resolveDistro` would silently fall back to the
  // registry default.
  const stored = JSON.parse(readFileSync(join(home, 'wsl-workspaces.json'), 'utf8'))
  // The keys are the table's drive rows in the store's canonical spelling (a lowercase drive path),
  // derived rather than written out a second time: a hand-copied list is what goes stale the day a
  // shape is added, and the property worth keeping is "the session env reads the entry the store holds".
  const driveRows = WORKSPACE_SHAPES.filter(shape => typeof shape.cwd === 'string' && /^[A-Za-z]:[\\]/.test(shape.cwd))
  assert.deepEqual(Object.keys(stored).sort(), driveRows.map(shape => shape.cwd.toLowerCase()).sort())
  for (const row of driveRows) {
    assert.equal(stored[row.cwd.toLowerCase()].distro, row.sessionEnv.DSH_WSL_DISTRO)
  }
})

test('the client half agrees with the tool half about the same session', async () => {
  // #49 lived exactly here: the tool plane translated and the client plane did not, so a reference
  // the model wrote opened a file the preview could not find. The client's world decision is
  // `distroOfWorkspace()` feeding `rewriteReferenceAddress()`; both are asserted against the same
  // store the drive cells above read.
  const driveDistros = new Map([['f:\\techenergy\\code\\scanner', DRIVE_DISTRO]])
  assert.equal(isWslWorkspace(DRIVE_CWD, new Set(['f:\\techenergy\\code\\scanner'])), true)
  assert.equal(distroOfWorkspace(DRIVE_CWD, driveDistros), DRIVE_DISTRO)
  assert.equal(distroOfWorkspace('\\\\wsl.localhost\\Ubuntu-24.04\\home\\u', driveDistros), 'Ubuntu-24.04')

  const session = { cwd: DRIVE_CWD, distro: DRIVE_DISTRO }
  const sessionOf = id => (id === 's1' ? session : undefined)
  const address = path => fileAddressFor('s1', DRIVE_CWD, path)

  // A `/mnt/<drive>` reference is the drive spelling, made workspace-relative so the Files panel and
  // the chat link are the same address.
  assert.equal(
    rewriteReferenceAddress(address('/mnt/f/TechEnergy/Code/Scanner/pkg/a.json'), sessionOf),
    'dsh-resource://file/session/s1/pkg/a.json',
  )
  // A path off the mounts can only be served by the distribution's own share — which is what the
  // store's distro is for. An unknown distro leaves the address alone rather than guessing a share.
  assert.equal(
    rewriteReferenceAddress(address('/etc/hosts'), sessionOf),
    `dsh-resource://file/session/s1///wsl.localhost/${DRIVE_DISTRO}/etc/hosts`,
  )
  assert.equal(
    rewriteReferenceAddress(address('/etc/hosts'), () => ({ cwd: DRIVE_CWD, distro: undefined })),
    address('/etc/hosts'),
  )
})

/**
 * Modules that decide the world, and why each is or is not driven from this table.
 *
 * `probed` ones are exercised above; the rest carry the reason they cannot be, so the derivation is
 * a decision rather than a filter. The set is checked against `src/` below: a new importer of a world
 * primitive lands as an unregistered file and reddens with its own name.
 */
const WORLD_REGISTRY = [
  { file: 'src/host/wsl-search.ts', probed: 'search' },
  { file: 'src/host/wsl-bash-tool.ts', probed: 'bash' },
  { file: 'src/host/wsl-terminal-tool.ts', probed: 'terminal' },
  { file: 'src/host/wsl-skills.ts', probed: 'skills' },
  { file: 'src/client/references.ts', probed: 'client' },
  {
    file: 'src/fs.ts',
    why: 'WslFileSystem extends the host LocalFileSystem, so it cannot be constructed in this bucket; '
      + 'its drive branch is measured by tests/smoke.ts on a real distribution and by the real-WSL fs gate',
  },
  {
    file: 'src/shell.ts',
    why: 'the one-shot executor builds a host subprocess spec; tests/smoke.ts drives it under a real '
      + 'distribution (drive workdir and Linux workdir cells), which is the reading this table cannot take offline',
  },
  {
    file: 'src/host/wsl-relay.ts',
    why: 'module-level code spawns wsl.exe at load, so importing it here would start a distribution; the '
      + 'Linux cwd it derives is the same `windowsToMntPath(cwd) ?? parseWslUnc(cwd)` chain the probed providers use, and #86\'s patch made the search twin match it',
  },
  {
    file: 'src/host/pty-readiness.ts',
    why: 'uses parseWslUnc only to word a diagnostic about an unverified UNC startup shape; it decides no world',
  },
  {
    file: 'src/index.ts',
    why: 'the host mount: the variant pass, the data route and the per-session `DSH_WSL_DISTRO` contributor '
      + '(the branch #1238-1249 reads the same store the drive cells do). Exercised by tests/host-declare.mjs / host-materialize.mjs and, end to end, by the G5 session probe this issue defers',
  },
  {
    file: 'src/client/index.ts',
    why: 'the dialog wiring: `createWorkspace` chooses the UNC registration or the drive one. Both outputs '
      + 'are asserted in tests/client-lifecycle.test.mjs (registration shape) and its DOM twin now asserts what the dialog renders around them',
  },
]

/**
 * Every source file that imports one of the world primitives, excluding the shared definitions.
 * @param root - the tree to walk; a parameter so the control test can point it at a synthetic one.
 * @returns repo-relative paths, sorted.
 */
function worldImporters(root = join(repoRoot, 'src')) {
  const found = []
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(name)) continue
      const source = readFileSync(full, 'utf8')
      if (!/from\s+'[^']*shared\/paths(\.ts)?'/.test(source)) continue
      if (!/parseWslUnc|windowsToMntPath|mntToWindowsPath|isWslUnc|uncToLinux|joinUnc/.test(source)) continue
      found.push(full.slice(root.length + 1).replace(/\\/g, '/'))
    }
  }
  walk(root)
  // The shared modules are the primitives themselves and their direct helpers; they decide no world.
  return found.filter(file => !file.startsWith('shared/')).sort()
}

test('every module that decides the world is registered here', () => {
  // The walker reports paths relative to the tree it walked; the registry spells them from the repo
  // root, which is how a failure sentence tells the reader which file to open.
  const actual = worldImporters().map(file => `src/${file}`)
  const registered = WORLD_REGISTRY.map(entry => entry.file).sort()
  assert.deepEqual(actual, registered,
    'a module imports a world primitive without a row here: add it to WORLD_REGISTRY with either a '
    + '`probed` seam (and a cell that drives it) or the reason this bucket cannot — the derived list is '
    + 'what makes the #86 class unrepeatable')
  // And the other direction: a row claiming a probe must be driven by at least one provider in the
  // table, or the claim is decoration.
  const probed = WORLD_REGISTRY.filter(entry => entry.probed !== undefined).map(entry => entry.probed)
  for (const seam of probed) {
    assert.ok(seam === 'client' || PROVIDERS.includes(seam),
      `WORLD_REGISTRY claims a probe for '${seam}', but PROVIDERS drives only ${PROVIDERS.join(', ')}`)
  }
  assert.ok(probed.includes('client'), 'the client half must stay probed: #49 lived there')
})

test('the derivation reddens on a provider that was never registered', () => {
  // Control for the half that makes the #86 class unrepeatable: the list must come from `src/`, not
  // from this file's memory of `src/`. A synthetic tree holds one provider that decides the world and
  // one that merely mentions a path helper; only the first may be listed.
  const tree = mkdtempSync(join(tmpdir(), 'dsh-world-tree-'))
  try {
    writeFileSync(join(tree, 'new-provider.ts'), [
      "import { parseWslUnc } from '../shared/paths.ts'",
      'export const where = cwd => parseWslUnc(cwd)',
      '',
    ].join('\n'))
    writeFileSync(join(tree, 'not-a-provider.ts'), [
      "import { join } from 'node:path'",
      "export const where = cwd => join(cwd, 'x')",
      '',
    ].join('\n'))
    assert.deepEqual(worldImporters(tree), ['new-provider.ts'])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
  // And the live tree: every importer has a row, every row has a reason, and a probed row names a
  // seam the table drives.
  for (const entry of WORLD_REGISTRY) {
    assert.ok(entry.probed !== undefined || typeof entry.why === 'string',
      `${entry.file}: a registry row must name a probe seam or the reason it cannot have one`)
  }
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })

test('a drive workspace is read through the drive spelling, never the 9P share', async () => {
  // The cell above says the lookup happened; this says it happened *over a readable path*. 9P cannot
  // serve drvfs — `\\wsl.localhost\<distro>\mnt\f\…` answers `Access is denied`, which is why
  // `src/fs.ts` and `src/host/wsl-search.ts` translate `/mnt/<drive>` to its drive path. The skill
  // provider now does the same, and the assertion is on the spelling rather than on the catalog
  // (the 84-case `tests/wsl-skills.test.ts` owns discovery): every read of a `/mnt/<drive>` path must
  // name the drive, and none may name the share.
  const reading = await skillsOf(DRIVE_CWD)
  assert.equal(reading.kind, 'world', 'a drive workspace must be served at all')
  const reads = reading.paths
  assert.ok(reads.some(path => normalisePath(path).startsWith('f:/techenergy/code/scanner')),
    `not one read used the drive spelling: ${JSON.stringify(reads)}`)
  const shared = reads.filter(path => normalisePath(path).includes('wsl.localhost') && normalisePath(path).includes('/mnt/'))
  assert.deepEqual(shared, [],
    `a /mnt path was read through the share, which drvfs cannot serve: ${JSON.stringify(shared)}`)
})
