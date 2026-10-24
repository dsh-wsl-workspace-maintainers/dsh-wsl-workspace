/**
 * G4 — the install shapes the plugin is actually loaded from (issue #101).
 *
 * Issue #47 was one shape: a Desktop profile where the host lives inside `app.asar`, two optional peers
 * were never installed (`cordis-plugin-include`) and a `js-yaml: "*"` peer had been bound to 5.x by an
 * unrelated dependency. The plugin loaded, generated zero variants, and said nothing. Nothing in this
 * repository could see that shape: every check ran in the dev tree, where all of it resolved.
 *
 * The two causes are gone from the manifest — the YAML schema is inlined (no dynamic host import) and
 * `js-yaml` is a real dependency on 4.x — but "gone" is not "cannot come back", so this file pins the
 * two properties that keep them gone, plus the one reading only a real load can give:
 *
 *   1. every bare specifier `src/` imports is *declared* in the manifest — a resolution assumption that
 *      is not written down is the #47 shape;
 *   2. `js-yaml` is a `dependencies` entry on 4.x and no `src/` module dynamically imports a host
 *      package at call time — the two specific holes, named;
 *   3. loaded from a **profile-shaped** tree (plugin under `node_modules/`, host closure beside it) the
 *      published entry imports and exports `apply`; with the closure removed, the failure names the
 *      package instead of arriving as a silent zero-variant boot.
 *
 * The third is the one that cannot be faked by reading files: it is Node's own resolution walking a
 * layout, in a child process.
 *
 * Needs the pinned closure (`node ci/install-pinned.mjs`), so it runs in `npm run test:node`.
 *
 *   node --experimental-strip-types --test tests/install-shapes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const HOST_CLOSURE = join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai')

/** Every `src/**.ts(x)` file. */
function sources(directory = join(repoRoot, 'src'), found = []) {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name)
    if (statSync(full).isDirectory()) { sources(full, found); continue }
    if (/\.(ts|tsx)$/.test(name)) found.push(full)
  }
  return found
}

/**
 * The runtime specifiers one file imports (static, side-effect and dynamic).
 *
 * `import type` is deliberately excluded: it vanishes at build time, so it is a *typecheck*-plane
 * dependency (the typecheck gate's business), not something an install has to carry.
 * @param source - the file's text.
 * @returns module specifiers, with no duplicates.
 */
function specifiersOf(source) {
  const specs = new Set()
  const patterns = [
    new RegExp("(?:^|\\n)[ ]*(?:import|export)[ ]+(?!type[ ])[^'\"\\n]*?from[ ]*['\"]([^'\"\\s]+)['\"]", 'g'),
    new RegExp("(?:^|\\n)[ ]*import[ ]+['\"]([^'\"\\s]+)['\"]", 'g'),
    new RegExp("(?:^|\\n)[ ]*import\\([ ]*['\"]([^'\"\\s]+)['\"]", 'g'),
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1])
  }
  return [...specs]
}

const packageOf = specifier => (specifier.startsWith('@')
  ? specifier.split('/').slice(0, 2).join('/')
  : specifier.split('/')[0])

test('every specifier src/ imports is declared in the manifest', () => {
  // A bare specifier that resolves on this machine but is not in the manifest is an install-shape
  // assumption: it works until someone installs the tarball, where only the declared tree exists.
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const undeclared = new Set()
  for (const file of sources()) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      // The client bundle's platform modules are declared in `dsh.client.inject`, not in dependencies:
      // the host's loader provides them (tsdown keeps them external, `external:` in tsdown.config.ts).
      if (file.includes(join('src', 'client')) && specifier.startsWith('@deepseek-ai/')) continue
      if (file.includes(join('src', 'client')) && /^react(-dom)?(\/|$)/.test(specifier)) continue
      const name = packageOf(specifier)
      if (!declared.has(name)) undeclared.add(`${name} (from ${file.slice(repoRoot.length + 1)})`)
    }
  }
  assert.deepEqual([...undeclared].sort(), [],
    'a specifier resolves here but is not in the manifest — the tarball install would not have it')
})

test('runtime dependencies are real, bounded and never peers; no host package is imported at call time', () => {
  // 1. an open range or a peer entry binds the engine to whatever the dependency graph happens to
  //    carry (the shape that reached a user as #47, when `js-yaml: "*"` resolved to 5.x in a
  //    profile). Two properties, stated for every runtime dependency rather than for the one that
  //    broke: bounded to a line, and never a peer. And where the code's dialect targets a known
  //    line, that line is named — a drift to the next major is a schema break, not a range choice.
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(String(range), /^\^?\d+\./, `${name} must be pinned to a major, found ${JSON.stringify(String(range))}`)
    assert.equal(manifest.peerDependencies?.[name], undefined,
      `${name} must not be a peer: a peer lets the host choose a major this code cannot read`)
  }
  assert.match(String(manifest.dependencies?.['js-yaml'] ?? ''), /^\^?4\./,
    'js-yaml must stay on the 4.x line the generated dialect is built against — the next major changed the schema API')
  // 2. a host package imported *at call time* is invisible to the manifest and to every offline check.
  const dynamicHostImports = []
  for (const file of sources()) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(new RegExp("import\\([ ]*['\"](@deepseek-ai/[^'\"]+)['\"]", 'g'))) {
      dynamicHostImports.push(`${file.slice(repoRoot.length + 1)}: import(${match[1]})`)
    }
  }
  assert.deepEqual(dynamicHostImports, [],
    'a host package imported at call time cannot be guaranteed present in a profile (issue #47)')
})

/**
 * Run one import in a child process with a given working directory, and report what Node said.
 * @param cwd - the directory the child resolves from (its `node_modules` is the profile's).
 * @param specifier - what to import.
 * @returns `{ ok, stdout, stderr }`.
 */
function probeImport(cwd, specifier) {
  const script = `import(${JSON.stringify(specifier)}).then(m => { console.log('OK exports=' + Object.keys(m).sort().join(',')) }, e => { console.error('ERR ' + e.code + ' ' + e.message); process.exit(1) })`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' })
  return { ok: run.status === 0, stdout: run.stdout.trim(), stderr: run.stderr.trim() }
}

test('a profile-shaped tree loads the published entry; without the closure the failure names the package', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-install-shape-'))
  try {
    const profile = join(scratch, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    const installed = join(modules, 'dsh-wsl-workspace')
    mkdirSync(installed, { recursive: true })
    // A COPY, not a symlink: Node resolves through a junction to its real path, so a linked plugin would
    // find this repository's own `node_modules` and the "closure removed" arm below would pass while
    // measuring nothing. This is the same trap that made four probe rows lie on 2026-10-19 (#44 §4).
    copyFileSync(join(repoRoot, 'package.json'), join(installed, 'package.json'))
    cpSync(join(repoRoot, 'lib'), join(installed, 'lib'), { recursive: true })
    // The host closure beside it, as `dsh plugin add` would have installed the peers.
    symlinkSync(HOST_CLOSURE, join(modules, '@deepseek-ai'), 'junction')

    const loaded = probeImport(profile, 'dsh-wsl-workspace')
    assert.equal(loaded.ok, true, `the published entry did not load from a profile shape: ${loaded.stderr}`)
    assert.match(loaded.stdout, new RegExp('OK exports=.*apply'),
      `the published entry loaded but does not export apply: ${loaded.stdout}`)

    // Now the Desktop shape from #47: the host lives inside the app, so the profile carries no closure.
    rmSync(join(modules, '@deepseek-ai'), { recursive: true, force: true })
    const orphaned = probeImport(profile, 'dsh-wsl-workspace')
    assert.equal(orphaned.ok, false, 'the entry should not load without its host closure — nothing else proves the fixture is real')
    assert.match(orphaned.stderr, new RegExp('@deepseek-ai/'),
      `the failure must name the missing package, got: ${orphaned.stderr}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
