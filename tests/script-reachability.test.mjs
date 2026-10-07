/**
 * The reachability property: **does every command this repository offers actually run?**
 *
 * `package.json` is the one file in the repository that is read by the CI system rather than by the
 * product, and it is therefore the one file whose rot nobody notices until a job goes red. Three
 * shapes of rot are all invisible locally and all fatal on a machine that is not this one:
 *
 *   · a script names a file that is not in the tree — the job runs, the tests pass, and then `&&`
 *     chains into a `MODULE_NOT_FOUND` that fails the whole step with a green test run above it;
 *   · a script chains into a file that exists but no test is registered for it — the file is
 *     maintained, linted, and never executed, which is worse than absent because it looks alive;
 *   · a test file exists that nothing runs — dead weight that rots silently, and a coverage claim
 *     made about it would be a lie.
 *
 * The first shape is not hypothetical. This gate was written because this branch shipped a `&&`
 * chain into `scripts/check-unit-closure.mjs`, a file that exists on no branch of this repository,
 * and the Ubuntu job failed with a green unit bucket printed directly above the error. The tests
 * were correct; the manifest pointed at something that was never committed.
 *
 * Note what is *not* claimed here: nothing here runs a script, so this cannot tell you the script
 * does what its name says. It answers one question — **does the thing this command points at exist
 * and is it wired in** — and it answers it from the manifest and the tree rather than from a list
 * somebody maintains.
 *
 * Static: no boot, no host, no WSL, no spawn. Node ≥ 24 (`node --test`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the manifest as the CI system reads it: as data, from disk, every time. */
function manifest() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
}

/**
 * The repository-relative paths a script points at, in the order the script names them.
 *
 * Split on the three separators npm scripts actually use (`&&`, `||`, `;`) and read the first
 * whitespace-delimited token of each part. That token is skipped when it is a chain keyword
 * (`npm`, `run`, `cd`, flags) rather than a path, and is otherwise the file the chain will load.
 *
 * A path is *not* checked for existence here — that is the caller's assertion, not this function's
 * opinion. Keeping the split separate from the verdict is what lets the positive control below
 * point the extractor at a path that genuinely does not exist and observe a row come back.
 */
function scriptTargets(command) {
  const parts = String(command).split(/&&|\|\||;/).map(part => part.trim()).filter(Boolean)
  const targets = []
  for (const part of parts) {
    const [head, ...rest] = part.split(/\s+/)
    // Only `node`-invoked scripts address this repository's own files. Anything else is `npm run`,
    // a shell builtin, or a tool this gate has no business reasoning about.
    if (head !== 'node' && head !== 'npx') continue
    const target = rest.find(token => !token.startsWith('-'))
    if (target !== undefined) targets.push(target)
  }
  return targets
}

/** Every script the manifest offers, as `{ name, command, targets }`. */
function scripts() {
  const { scripts: declared = {} } = manifest()
  return Object.entries(declared).map(([name, command]) => ({
    name,
    command,
    targets: scriptTargets(command),
  }))
}

/**
 * Repository-relative paths a **runner script** names, wherever it names them.
 *
 * `package.json` is not the only place a path is registered. `scripts/run-seams.mjs` holds its
 * suites as `[label, argv]` arrays, so a file can be run on every CI job while appearing in no
 * `test:*` command string at all. Scanning only the manifest would call `tests/tech-debt-exposure.test.ts`
 * an orphan — which is what the first draft of this gate did, and it was wrong: that suite is run,
 * it is just run from inside another script.
 *
 * The scan is **seeded, not sweeping**: it starts from the scripts the `test:*` buckets invoke and
 * follows nothing else. Sweeping all of `scripts/` would have been easier and wrong — it would count
 * a suite named by a script no bucket calls as registered, which is precisely the orphan this half
 * of the gate exists to report. One hop from a real bucket is what makes the set mean "run by CI".
 *
 * Every quoted token that looks like a path into this repository is taken. Deliberately not a full
 * AST walk: the claim is "is the file there", and a comment that mentions a path is harmless — it
 * can make the gate miss an orphan, never invent a missing file.
 */
function pathsNamedByScripts(seedFiles, dir = join(repoRoot, 'scripts'), found = new Set()) {
  const queue = [...seedFiles]
  while (queue.length > 0) {
    const seed = queue.shift()
    const full = join(repoRoot, seed)
    if (found.has(seed) || !existsSync(full)) continue
    found.add(seed)
    if (!seed.startsWith('scripts/')) continue
    const source = readFileSync(full, 'utf8')
    for (const [, token] of source.matchAll(/['"`]((?:tests|scripts|src|lib|ci)\/[A-Za-z0-9._/-]+)['"`]/g)) {
      if (!found.has(token)) queue.push(token)
    }
  }
  // Only the paths, not the seeds that happened to be scripts: the caller compares against test files.
  return new Set([...found].filter(path => path.startsWith('tests/')))
}

/**
 * Repository paths this repository **generates**, read out of `.gitignore`.
 *
 * A generated file is not a dangling reference: `tests/smoke-built.ts` is named by `test:wsl` and
 * is absent from a fresh clone by design, because `scripts/make-smoke-built.mjs` writes it first.
 * Calling that a missing file is the tool's blind spot again, in a second shape — the first draft
 * of this gate reported it, and it was green on the maintainer's Windows tree only because the file
 * had been generated there at some point. The ubuntu job saw a clean checkout and went red.
 *
 * So the exemption is **derived from the ignore list**, which is the file that already states what
 * is generated. A written list of generated paths would be a second copy of the tree, and would be
 * wrong the same way the hand-written tool lists were: it lists what somebody remembered generating.
 */
function generatedPaths() {
  const source = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
  const patterns = source.split('\n')
    .map(line => line.trim())
    // Comments carry the *reason* a path is ignored, which is exactly why they must not be read as
    // patterns — `.gitignore` line 13 is the entry, the two lines above it are its explanation.
    .filter(line => line !== '' && !line.startsWith('#'))
  const exact = new Set(patterns.filter(pattern => !pattern.includes('*') && !pattern.endsWith('/')))
  return {
    /** Whether `path` is one of the ignored entries this repository declares as generated. */
    isGenerated: path => exact.has(path),
    /** How many entries were read, so a caller can tell "no exemptions" from "no list". */
    size: exact.size,
  }
}

/** Test files under `tests/`, the shape the `test:unit` bucket is written in. */
function testFiles(dir = join(repoRoot, 'tests'), found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, found)
    else if (/\.(test|spec)\.(mjs|js|ts|mts)$/.test(entry.name)) found.push(full)
  }
  return found
}

test('the extractor reads the targets out of a script, and skips what is not a path', () => {
  // The extractor is what both properties below are defined in terms of, and an extractor that
  // returns nothing makes them vacuously green — so it is pinned first, on both shapes.
  assert.deepEqual(
    scriptTargets('node --experimental-strip-types --test tests/variants.test.ts tests/paths.test.ts'),
    // `--experimental-strip-types` and `--test` are flags; the first non-flag token is the target.
    ['tests/variants.test.ts'],
  )
  // A chain: every part contributes, and `npm run` contributes nothing because it is not `node`.
  assert.deepEqual(
    scriptTargets('npm run build && node scripts/verify-lib.mjs'),
    ['scripts/verify-lib.mjs'],
  )
  // Two node invocations, two targets, in the order the chain runs them.
  assert.deepEqual(
    scriptTargets('node a.mjs && node b.mjs'),
    ['a.mjs', 'b.mjs'],
  )
})

test('every script that names a file names a file that exists', () => {
  // The defect that motivated this gate, checked against the manifest rather than a remembered
  // list of scripts: a `&&` chain into a file no branch carries fails here before it reaches CI.
  const generated = generatedPaths()
  // Positive control: the ignore list was read, so "generated files are excused" is a decision
  // rather than an accident of an empty set. `tests/smoke-built.ts` is the file this is for.
  assert.ok(generated.size > 0, 'no generated paths were read from .gitignore')
  assert.ok(generated.isGenerated('tests/smoke-built.ts'),
    'the generated-file exemption does not cover the file it exists for')

  const dangling = []
  for (const script of scripts()) {
    for (const target of script.targets) {
      // `node -e` and `node` with no file have nothing to resolve; and a bare specifier is a
      // dependency, which belongs to `node_modules` and to the peer-dependency declaration.
      if (target === '-e' || target === '--version' || target === '-') continue
      if (!target.startsWith('.') && !target.startsWith('/') && !target.includes('/')) continue
      if (generated.isGenerated(target)) continue
      if (!existsSync(join(repoRoot, target))) dangling.push({ script: script.name, target })
    }
  }
  assert.deepEqual(dangling, [],
    `script(s) point at file(s) this repository does not contain:\n`
    + dangling.map(entry => `  ${entry.script} → ${entry.target}`).join('\n')
    + '\n  The step fails at the chain, after the tests have already printed green.')
})

test('the unit bucket registers test files, and every test file is registered somewhere', () => {
  // Both directions, because each fails on its own and neither is implied by the other:
  // a bucket naming a file that is gone fails above; a file that nothing runs is the quieter one,
  // because it can be edited forever and never tell anyone anything.
  const buckets = scripts().filter(script => script.name.startsWith('test:'))
  // `--test` takes several files, so the command string is scanned for paths rather than reusing
  // `scriptTargets`, which reports only the first non-flag token — here that is the runner's own flag.
  // The scripts the buckets invoke are scanned too: a suite registered as a `[label, argv]` array
  // inside `scripts/run-seams.mjs` is run by CI while appearing in no `test:*` string, and calling it
  // an orphan would be the tool's blind spot reported as a finding about the repository.
  const mentioned = new Set([
    ...buckets.flatMap(script => script.command.split(/\s+/))
      .filter(token => token.startsWith('tests/') || token.startsWith('scripts/')),
    // Seeded with the `scripts/` files the buckets invoke, which is `test:seams → run-seams.mjs`
    // today. Derived from the manifest rather than listed, so adding a runner needs no edit here.
    ...pathsNamedByScripts(
      buckets.flatMap(script => script.targets).filter(target => target.startsWith('scripts/')),
    ),
  ])
  // Positive control: the set is not empty, so "every named file exists" is about content and not
  // about a filter that matched nothing.
  assert.ok(mentioned.size > 0,
    'no test bucket names a file, so the two comparisons below would pass without checking anything')
  // Positive control for the deeper view specifically: the array-registered suite must be visible
  // here, or the recursive scan is silently returning nothing and every orphan check passes.
  assert.ok(mentioned.has('tests/tech-debt-exposure.test.ts'),
    'the recursive scan found no suite registered inside a runner script, so it is not reading them')

  const generated = generatedPaths()
  // A generated file is absent from a clean checkout **by design**, so it is excused here for the
  // same reason it is excused above — and by the same derived list, not a second one. This is the
  // case the ubuntu job found: `tests/smoke-built.ts` exists on the maintainer's tree only because
  // `make-smoke-built.mjs` has been run there, and is missing from a fresh clone.
  const absent = [...mentioned].filter(file => !existsSync(join(repoRoot, file)) && !generated.isGenerated(file))
  assert.deepEqual(absent, [],
    `the buckets name file(s) that are not in the tree and are not generated:\n`
    + absent.map(file => `  ${file}`).join('\n'))

  // Every `*.test.*` file is named by some bucket. No exemption list: the earlier draft carried one,
  // and it named files this branch does not even have — a list of exceptions is just a second copy
  // of the tree, wrong in the same way the hand-written tool lists were. If a test legitimately
  // cannot run in the bucket, the honest fix is to not ship the file yet, not to list it as exempt.
  const orphans = testFiles()
    .map(file => file.slice(repoRoot.length + 1).replace(/\\/g, '/'))
    .filter(file => !mentioned.has(file))
  assert.deepEqual(orphans, [],
    `test file(s) that no script runs:\n${orphans.map(file => `  ${file}`).join('\n')}`
    + '\n  Register it, or delete it: an unrun test is a coverage claim nobody can check.')
})