/**
 * G3 — what we hand the host, checked against the host's rules (issue #101).
 *
 * Three defects reached users through this surface and none of them needed a session to
 * reproduce: #22 (the persona note silently not appended), #87 (a `{{cwd}}` the host does not
 * register, which fails the *whole turn*), #89 (five `file:` rows that never started because their
 * bare imports did not resolve inside a profile). All three are properties of the text we generate,
 * and every existing check for them is a fixture we wrote ourselves.
 *
 * So the inputs here are the **shipped presets** (`@deepseek-ai/dsh-web-app/presets/*.patch.yml`,
 * read from the pinned closure), not a transcription of them: each file's `config.plugins:` list is
 * dedented into the composition the transform consumes, and the assertions are the invariants a
 * host would enforce at load time:
 *
 *   1. the WSL note is appended **exactly once** and is not empty — with a control that proves it
 *      was appended at all, because a scan that passes on an unamended persona is the shape that
 *      hid #22;
 *   2. the `{{…}}` multiset is **identical to the source's** — we may not introduce a variable the
 *      host does not register (#87). The source's own `{{cwd}}`/`{{model}}` ride along untouched:
 *      that is the host's business, not ours to "fix" here;
 *   3. every path the variant mounts **exists in this package** — a row pointing at a file the
 *      tarball does not carry is a variant that mounts nothing;
 *   4. every bare specifier those files import **is present in the host closure** — the #89 signal,
 *      measured without executing anything (one of those files spawns `wsl.exe` at load);
 *   5. no row id appears twice — the loader rejects the whole variant on a duplicate;
 *   6. the services the generated world isolates are the ones the consumer ledger enumerates, so a
 *      new isolate cannot be added without a row there.
 *
 * Needs the pinned closure (`node ci/install-pinned.mjs`), so it runs in `npm run test:node`.
 *
 *   node --experimental-strip-types --test tests/artifact-semantics.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_DIR = join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
const HOST_CLOSURE = join(repoRoot, 'ci', 'deps', 'node_modules')
const DEV_CLOSURE = join(repoRoot, 'node_modules')

const { transformPresetForWsl } = await import('../src/host/variants.ts')

/** The paths the product passes: absolute, forward-slash, inside this package's `lib/`. */
const libPath = file => join(repoRoot, 'lib', file).replaceAll('\\', '/')

/**
 * The composition a shipped preset declares: its `config.plugins:` block, dedented to column 0 so
 * it is the entry list the transform consumes.
 * @param file - absolute path of a `*.patch.yml`.
 * @returns the dedented composition text.
 */
function compositionOf(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const indentOf = line => line.match(new RegExp('^[ ]*'))[0].length
  const start = lines.findIndex(line => new RegExp('^[ ]+plugins:[ ]*$').test(line))
  assert.notEqual(start, -1, `${file}: no config.plugins block — the preset dialect changed`)
  const base = indentOf(lines[start])
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= base - 2) break
    body.push(line.slice(Math.min(base + 2, line.length)))
  }
  assert.ok(body.length > 10, `${file}: the plugins block came out empty — nothing to transform`)
  return body.join('\n')
}

/** One generated variant per shipped preset, at the paths the product actually passes. */
function variants() {
  const presets = readdirSync(PRESET_DIR).filter(name => name.endsWith('.patch.yml')).sort()
  assert.ok(presets.length >= 4, `expected the four shipped presets, found ${presets.join(', ')}`)
  return presets.map(name => {
    const file = join(PRESET_DIR, name)
    const source = compositionOf(file)
    const generated = transformPresetForWsl(
      source,
      libPath('shell.js'),
      libPath('fs.js'),
      {
        relayPath: libPath('wsl-relay.js'),
        // The product passes the host's own interpreter for the relay; using this process's execPath
        // keeps the "every mounted path exists" assertion honest instead of exempting one path.
        nodePath: process.execPath.replaceAll('\\', '/'),
        sandboxPath: libPath('wsl-sandbox.js'),
        bashPath: libPath('wsl-bash-tool.js'),
        terminalTool: libPath('wsl-terminal-tool.js'),
        mode: 'session',
      },
      libPath('wsl-search.js'),
      libPath('wsl-jobs.js'),
      libPath('wsl-image-tool.js'),
    )
    return { name, file, source, generated }
  })
}

const noteMarker = 'inside a WSL (Windows Subsystem for Linux) distribution'
const variablesOf = text => (text.match(new RegExp('\\{\\{[A-Za-z0-9_]+\\}\\}', 'g')) ?? []).sort()

test('the WSL note is appended exactly once — except where the preset asks for no context at all', () => {
  // `complete: true` is the persona plugin's "this text is the whole prompt": the transform deliberately
  // appends nothing there (`appendablePersona`), which is why the `minimal` variant carries no WSL note.
  // That is a product decision, so the expectation is derived from the source rather than assumed equal:
  // a preset that asks for no runtime context gets no note, and every other preset gets exactly one.
  for (const { name, source, generated } of variants()) {
    assert.ok(!source.includes(noteMarker),
      `${name}: the shipped preset already carries the note — this check would then pass vacuously`)
    const noContext = source.includes('complete: true')
    const count = generated.split(noteMarker).length - 1
    assert.equal(count, noContext ? 0 : 1,
      `${name}: the note appears ${count} times; the preset ${noContext ? 'asks for no runtime context (complete: true), so 0' : 'expects exactly 1'}`)
  }
  // The control that makes that sentence mean something: at least one preset must receive the note, or
  // "0 where complete: true" would also pass on a transform that appends nothing anywhere.
  const appended = variants().filter(entry => entry.generated.includes(noteMarker))
  assert.ok(appended.length >= 3, `only ${appended.length} variants carry the note — the append stopped working`)
})

test('a variant introduces no prompt variable the source did not carry', () => {
  // #87 in one assertion: the source's own `{{cwd}}` is the host's business, but the variant may not
  // ADD one — the failure mode was our appended sentence carrying a variable 0.2.x does not register,
  // which kills every turn before the first model request.
  for (const { name, source, generated } of variants()) {
    assert.deepEqual(variablesOf(generated), variablesOf(source),
      `${name}: the variant's placeholder multiset differs from the source's`)
    const note = generated.slice(generated.indexOf(noteMarker) - 200, generated.indexOf(noteMarker) + 400)
    assert.ok(!note.includes('{{'), `${name}: the note we append carries a placeholder: ${note.slice(0, 200)}`)
  }
})

/** Every absolute path the variant mounts, as the transform wrote it (quoted, forward slashes). */
const mountedPaths = generated => [...new Set(
  [...generated.matchAll(new RegExp("'([A-Za-z]:/[^']+)'", 'g'))].map(match => match[1]),
)]

test('every file a variant mounts exists in this package', () => {
  // A row naming a file the tarball does not carry mounts nothing, and the host reports the whole
  // variant as broken. The `files` whitelist ships `lib/`, so an entry that was never built is the
  // only way to fail this — which is exactly what a build-config change can do in silence.
  for (const { name, generated } of variants()) {
    const paths = mountedPaths(generated)
    assert.ok(paths.length >= 5, `${name}: only ${paths.length} mounted paths found — the scan is not seeing the world`)
    for (const path of paths) {
      assert.ok(existsSync(path), `${name}: the variant mounts ${path}, which is not in the tree`)
      // The interpreter is the host's own binary (outside this package by design); everything else a
      // variant mounts must be a file `files: ["lib", …]` carries, or it does not travel in the tarball.
      if (path.endsWith('.js')) {
        assert.ok(path.startsWith(join(repoRoot, 'lib').replaceAll('\\', '/')),
          `${name}: ${path} is outside this package's lib/ — it would not travel in the tarball`)
      }
    }
  }
})

test('every bare import in every mounted file is present in the host closure', () => {
  // #89: five `file:` rows "never started" because a bare import resolved nowhere in the profile.
  // The files cannot all be imported to find out (the relay spawns `wsl.exe` at load), so the check
  // is on presence in the closure — the package-level signal that actually failed.
  const seen = new Set()
  for (const { name, generated } of variants()) {
    for (const path of mountedPaths(generated)) {
      if (!path.startsWith(join(repoRoot, 'lib').replaceAll('\\', '/'))) continue
      if (!path.endsWith('.js') || seen.has(path)) continue
      seen.add(path)
      const source = readFileSync(path, 'utf8')
      const specifiers = [...source.matchAll(new RegExp("from[ ]*['\"]([^'\"]+)['\"]", 'g'))]
        .map(match => match[1])
        .filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('node:'))
      for (const specifier of specifiers) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        const present = [HOST_CLOSURE, DEV_CLOSURE].some(root => existsSync(join(root, packageName)))
          || existsSync(join(repoRoot, 'ci', 'deps-conflict', 'node_modules', packageName))
        assert.ok(present,
          `${name}: ${path.split(/[\\/]/).pop()} imports "${specifier}", and no tree carries ${packageName} — `
          + 'this is the shape that leaves a file: row "never started"')
      }
    }
  }
  assert.ok(seen.size >= 5, `only ${seen.size} mounted files were scanned — the scan is not seeing the world`)
})

test('no row id appears twice, and every id the source carried as a top-level row survives or is a world row', () => {
  // The loader refuses the whole variant on a duplicate id ("duplicate loader entry id"), which in the
  // product reads as a variant that is simply not there. The second half is the weaker, still useful
  // property: dropping a source row silently is what a rewrite of `WORLD_ROWS` can do.
  for (const { name, source, generated } of variants()) {
    const ids = [...generated.matchAll(new RegExp('^[ ]*- id: ([A-Za-z0-9._-]+)', 'gm'))].map(match => match[1])
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    assert.deepEqual([...new Set(duplicates)], [], `${name}: duplicate row ids in the variant: ${[...new Set(duplicates)].join(', ')}`)

    const sourceIds = [...source.matchAll(new RegExp('^[ ]*- id: ([A-Za-z0-9._-]+)', 'gm'))].map(match => match[1])
    const generatedIds = new Set(ids)
    const missing = sourceIds.filter(id => !generatedIds.has(id))
    // Two families, measured on the four shipped presets: the host's own `bash`/`pwsh`/search rows
    // (replaced by this world's providers) and the source's persistent-shell group with its children
    // (replaced by the relay-backed group). A row vanishing for any other reason is a row we lost.
    const retired = new Set([
      'tool-bash', 'tool-pwsh', 'tool-fs-search',
      'persistent-shell', 'terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh',
    ])
    const unexplained = missing.filter(id => !retired.has(id))
    assert.deepEqual(unexplained, [], `${name}: rows vanished without a reason: ${unexplained.join(', ')}`)
  }
})

test('the world isolates the services the consumer ledger enumerates', () => {
  // The ledger (`docs/CONSUMER-COVERAGE.md`) is derived from the `isolate:` keys of THIS group, so a new
  // isolate here is a service whose consumers nobody has looked at — the axis #54 and #78 arrived on.
  // Only the `wsl-world` group is read: copied source groups have isolates of their own (e.g.
  // `compaction`), and those are the host's business.
  const ledger = readFileSync(join(repoRoot, 'docs', 'CONSUMER-COVERAGE.md'), 'utf8')
  const seen = new Set()
  for (const { name, generated } of variants()) {
    const lines = generated.split('\n')
    const worldAt = lines.findIndex(line => new RegExp('^[ ]*- id: wsl-world[ ]*$').test(line))
    assert.notEqual(worldAt, -1, `${name}: no wsl-world group in the variant`)
    const services = []
    const isolateAt = lines.findIndex((line, index) => index > worldAt && /^\s*isolate:\s*$/.test(line))
    assert.notEqual(isolateAt, -1, `${name}: the wsl-world group declares no isolate block`)
    const isolateIndent = lines[isolateAt].match(new RegExp('^[ ]*'))[0].length
    for (let index = isolateAt + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() !== '' && line.match(new RegExp('^[ ]*'))[0].length <= isolateIndent) break
      const hit = line.match(new RegExp('^[ ]+([a-z][a-z-]*): true[ ]*$'))
      if (hit !== null) services.push(hit[1])
    }
    assert.ok(services.length >= 3, `${name}: the world group isolates ${services.join(', ') || 'nothing'}`)
    for (const service of services) {
      seen.add(service)
      assert.ok(new RegExp(`\\| \`${service}\` \\|`).test(ledger),
        `${name}: the world isolates "${service}", which the consumer ledger does not enumerate`)
    }
  }
  assert.ok(seen.size >= 3, `the world's isolate set came out as ${[...seen].join(', ')} — the scan is not seeing it`)
})
