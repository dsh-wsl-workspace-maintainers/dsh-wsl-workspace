/**
 * Issue #47 — the variant generator borrowed two modules from the Host at call
 * time, and a DSH Desktop profile has neither of them the way the docblock assumed:
 * the Host's code lives inside `app.asar` while Node walks the *filesystem* upward
 * for a bare specifier, and a sibling plugin's hoisted `js-yaml` can be a major whose
 * 4.x schema API is gone. One borrowed module failing threw out of the whole
 * materialize loop, so zero variants were registered AND the stale-directory sweep
 * that lives after the loop never ran; the only trace was a swallowed console line.
 *
 * This file rebuilds that shape with real packages and real resolution — no stubs.
 * Each arm is a profile-shaped tree under the temp dir: the plugin's committed
 * `package.json` + `lib/` copied in (COPIED, never linked — the ESM loader realpaths
 * a module URL, so a link would walk the arm's resolution out of the arm and silently
 * dissolve every hostile property), the Host packages junctioned per name, and a
 * hoisted `js-yaml` of the wrong major taken from `ci/deps-conflict`.
 *
 * CONTRACT OF THIS FILE — read before triaging a red. A red line is the reproduction,
 * and the repair direction is written next to it. Do not weaken an assertion to make a
 * frame green, and do not "fix" it inside the test either.
 * Arms 1/2/3/4 are the shapes the report measured on a real deployment; arm 5 is a
 * repair-side arm — its red means "nothing names the copy we are standing on", not
 * "a fifth defect".
 *
 * Run from the plugin directory, after `node ci/install-pinned.mjs`:
 *   node tests/host-profile-isolation.mjs
 */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = 'HOST PROFILE ISOLATION'
const isWin = process.platform === 'win32'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const depsModules = join(repoRoot, 'ci', 'deps', 'node_modules')
const conflictModules = join(repoRoot, 'ci', 'deps-conflict', 'node_modules')

// ── fixture documents: the entry-list dialect the Host publishes ────────────
// Row-for-row in the shape tests/host-declare.mjs uses, because what the arms
// compare is the transform's output.
const STANDARD_SRC = `# standard
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: >-
      Your working directory is {{cwd}}.

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform === 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: data-export
  name: '@me/dsh-data-export'
  disabled: !!js process.platform === 'win32'
`
const MINIMAL_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true

- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
`
const DATA_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a data-mode agent.

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

const SOURCES = {
  standard: { name: 'Standard mode', order: 1, text: STANDARD_SRC },
  minimal: { name: '极简模式', order: 3, text: MINIMAL_SRC },
  data: { name: 'Data mode', order: 8, text: DATA_SRC },
}

// The `@deepseek-ai/*` names the plugin's own built files import statically, so an arm
// that could not resolve them could not load the plugin at all — which would make every
// red in this file mean "fixture", never "generation".
const HOST_PACKAGES = [
  'schemastery',
  'dsh-shell',
  'dsh-timeout',
  'dsh-fs',
  'dsh-fs-local',
  'dsh-sandbox',
  'dsh-tools',
  'dsh-tool-fs-search',
]
const INCLUDE_NAME = 'cordis-plugin-include'

const versionOf = (dir) => {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return null
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

const YAML4_DIR = join(depsModules, 'js-yaml')
const YAML5_DIR = join(conflictModules, 'js-yaml')
const YAML4 = versionOf(YAML4_DIR)
const YAML5 = versionOf(YAML5_DIR)
if (YAML4 === null || YAML5 === null) {
  console.error(`${NAME} NOT VERIFIED — this file needs a 4.x copy under ci/deps AND the hostile copy under`
    + ` ci/deps-conflict (measured: ci/deps js-yaml=${YAML4 ?? 'MISSING'}, ci/deps-conflict js-yaml=${YAML5 ?? 'MISSING'})`)
  console.error('  repair direction: run `node ci/install-pinned.mjs`. It refuses rather than skipping, because an')
  console.error('  arm without the hostile major cannot answer the question that arm was built to ask.')
  process.exit(1)
}

/**
 * Only the range spellings this repo's own manifest uses. Against `^4.1.0`, 4.3.2 is a
 * yes and 5.4.2 is a no; any other spelling is a shape this harness has not read, so it
 * says UNKNOWN instead of guessing.
 */
function satisfies(range, version) {
  const want = /^\^(\d+)\.(\d+)\.\d+$/.exec(range)
  if (want === null || version === null) return 'UNKNOWN'
  const [major, minor] = version.split('.').map(Number)
  if (major !== Number(want[1])) return false
  return major > 0 || minor >= Number(want[2])
}

const COPIES = { '4': YAML4_DIR, '5': YAML5_DIR }

/**
 * Delete an arm tree WITHOUT ever following a link into its target. Every link this
 * file created is unlinked by name first — tracked rather than probed, because a
 * Windows junction is reported as a directory by `lstat` on some Node versions, and a
 * recursive walk that follows one would delete the real package it points at.
 */
function removeTreeBare(dir) {
  if (!existsSync(dir)) return
  // Only this tree's links, and only after untracking them: dropping another arm's
  // link from the list would leave it live for that arm's own removal pass.
  for (let i = createdLinks.length - 1; i >= 0; i--) {
    const dst = createdLinks[i]
    if (dst !== dir && !dst.startsWith(join(dir, ''))) continue
    createdLinks.splice(i, 1)
    try {
      lstatSync(dst)
      unlinkSync(dst)
    } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
}

const createdLinks = []

function link(src, dst) {
  mkdirSync(dirname(dst), { recursive: true })
  symlinkSync(src, dst, isWin ? 'junction' : 'dir')
  createdLinks.push(dst)
}

const scratch = []

/**
 * Build one profile-shaped tree.
 * @param spec.n        arm number (names the temp dir).
 * @param spec.include  whether the Host's include package is on the tree at all.
 * @param spec.hoisted  which js-yaml major sits at the profile root.
 * @param spec.nested   `5` forces the installer-shaped copy handed to the plugin itself
 *                     to be the hostile major; otherwise the nested copies are materialised
 *                     from the copied manifest, so no arm is rigged by this file.
 */
function buildArm(spec) {
  const arm = mkdtempSync(join(tmpdir(), `dsh-wsl-arm${spec.n}-`))
  scratch.push(arm)
  const nm = join(arm, 'node_modules')
  const pkgDir = join(nm, 'dsh-wsl-workspace')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(arm, 'package.json'), JSON.stringify({ name: `profile-arm-${spec.n}`, private: true, version: '0.0.0' }, null, 2) + '\n')
  cpSync(join(repoRoot, 'package.json'), join(pkgDir, 'package.json'))
  cpSync(join(repoRoot, 'lib'), join(pkgDir, 'lib'), { recursive: true })

  for (const name of HOST_PACKAGES) link(join(depsModules, '@deepseek-ai', name), join(nm, '@deepseek-ai', name))
  if (spec.include) link(join(depsModules, '@deepseek-ai', INCLUDE_NAME), join(nm, '@deepseek-ai', INCLUDE_NAME))
  link(COPIES[spec.hoisted], join(nm, 'js-yaml'))

  // Play installer for the plugin's OWN declared dependencies, reading the copied
  // manifest rather than this file's intentions.
  const copied = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  for (const [name, range] of Object.entries(copied.dependencies ?? {})) {
    const forced = spec.nested === '5' && name === 'js-yaml' ? YAML5_DIR : null
    const pick = forced ?? Object.values(COPIES).find(dir => satisfies(range, versionOf(dir)) === true)
    if (pick === undefined) {
      console.error(`${NAME} NOT VERIFIED — the manifest declares ${name}@${range} and no local copy satisfies it`
        + ` (4.x=${YAML4}, hostile=${YAML5})`)
      process.exit(1)
    }
    link(pick, join(pkgDir, 'node_modules', name))
  }

  const home = mkdtempSync(join(tmpdir(), `dsh-wsl-home${spec.n}-`))
  scratch.push(home)
  // A leftover of the retired directory mechanism. Its removal lives AFTER the
  // generation loop, so whether it survived is the readout of whether that loop
  // completed — the same signal the report read off a real deployment.
  mkdirSync(join(home, '.agent-presets', 'wsl-ghost'), { recursive: true })
  writeFileSync(join(home, '.agent-presets', 'wsl-ghost', 'agent.cordis.yml'), '# stale\n', 'utf8')

  return { arm, nm, pkgDir, home, entry: join(pkgDir, 'lib', 'index.js') }
}

/**
 * Containment compared on realpaths: a Windows temp dir arrives as an 8.3 short path
 * from `mkdtemp` while a resolved module path arrives long, and comparing the two
 * spellings directly would report "outside the arm" for a file that is inside it.
 */
function inside(child, parent) {
  try {
    return realpathSync(child).startsWith(realpathSync(parent))
  } catch {
    return false
  }
}

let failures = 0
const check = (condition, label) => {
  if (condition) console.log(`ok: ${label}`)
  else {
    console.log(`not ok: ${label}`)
    failures += 1
  }
}

/**
 * Boot one arm's own copy of the plugin against a roster face and let the
 * fire-and-forget generation settle.
 * @param face.failFor a source id whose composition the roster cannot read (arm 4).
 */
async function runArm(arm, face = {}) {
  const registered = []
  const captured = []
  const disposers = []
  const mod = await import(pathToFileURL(arm.entry).href)

  process.env.DSH_HOME = arm.home
  const sources = face.sources ?? SOURCES
  const healthy = Object.entries(sources).filter(([, s]) => s.broken !== true)

  const fakeCtx = {
    get: (key) => {
      if (key === 'webServer') return { register: () => () => {} }
      if (key === 'agentPresets') {
        return {
          list: async () => [
            ...healthy.map(([id, s]) => ({ id, name: s.name, order: s.order })),
            ...(face.brokenId ? [{ id: face.brokenId, broken: 'row names a plugin that cannot be resolved' }] : []),
            { id: 'wsl-already', name: 'WSL already', order: 9 },
          ],
          readDocument: async (id) => {
            if (face.failFor === id) throw new Error(`the roster cannot read "${id}"`)
            return { agentPreset: id, content: sources[id].text, name: sources[id].name }
          },
          register: async (definition) => {
            registered.push(definition)
            return async () => {}
          },
        }
      }
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  const sink = { error: console.error, warn: console.warn }
  console.error = (...args) => captured.push(args.map(String).join(' '))
  console.warn = (...args) => captured.push(args.map(String).join(' '))
  const started = Date.now()
  let timedOut = true
  try {
    mod.apply(fakeCtx, { route: '/wsl-workspace/api' })
    // Completion is "nothing arrived for 800 ms", not "the count reached the healthy
    // number": an aborted frame registers nothing and would otherwise burn the whole
    // deadline, and a stray warning line must not end a healthy frame early either.
    const deadline = Date.now() + 30_000
    let seen = -1
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      const total = registered.length + captured.length
      if (total > 0 && total === seen && Date.now() - quietSince > 800) {
        timedOut = false
        break
      }
      if (total !== seen) {
        seen = total
        quietSince = Date.now()
      }
      await new Promise(r => setTimeout(r, 50))
    }
  } finally {
    Object.assign(console, sink)
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch { /* a disposer's own failure is not what this file measures */ }
    }
  }

  return {
    registered,
    captured,
    staleGone: !existsSync(join(arm.home, '.agent-presets', 'wsl-ghost')),
    timedOut,
    elapsed: Date.now() - started,
  }
}

/**
 * Walk up from the built file the way Node does and report the FIRST
 * `node_modules/<specifier>` the walk meets. Both loaders dereference a Windows
 * junction — measured: an in-arm `import.meta.resolve('js-yaml')` answers with the
 * `ci/deps` target URL — so the resolved path alone cannot tell whether the walk
 * escaped the arm. Doing the walk here, on the traversed spellings, can, and it is
 * the same ancestor sequence Node uses.
 */
function nearestModule(startDir, specifier) {
  let dir = startDir
  const trail = []
  for (;;) {
    const candidate = join(dir, 'node_modules', ...specifier.split('/'))
    trail.push(candidate)
    if (existsSync(join(candidate, 'package.json'))) return { found: candidate, trail }
    const parent = dirname(dir)
    if (parent === dir) return { found: null, trail }
    dir = parent
  }
}

const PROBE_SOURCE = [
  'const attempt = (specifier) => {',
  '  try {',
  '    return { url: import.meta.resolve(specifier) }',
  '  } catch (error) {',
  '    return { code: error.code }',
  '  }',
  '}',
  'export const probed = {',
  '  yaml: attempt(\'js-yaml\'),',
  '  include: attempt(\'@deepseek-ai/cordis-plugin-include\'),',
  '}',
].join('\n')

/**
 * Ask the ESM loader itself, from a file standing inside the arm's copy: what the
 * product's `import()` sees, including the failure code it gets (`ERR_MODULE_NOT_FOUND`,
 * where a CommonJS probe would answer `MODULE_NOT_FOUND` and measure the wrong thing).
 */
async function esmProbe(arm) {
  const file = join(dirname(arm.entry), 'peer-probe.mjs')
  writeFileSync(file, PROBE_SOURCE, 'utf8')
  const module = await import(pathToFileURL(file).href)
  return module.probed
}

// The pinned Host schema, for the equivalence control. Resolved out of ci/deps by
// absolute path: it is the reference the arms are compared against, never a subject.
const includeManifest = JSON.parse(readFileSync(join(depsModules, '@deepseek-ai', INCLUDE_NAME, 'package.json'), 'utf8'))
const includeEntry = join(depsModules, '@deepseek-ai', INCLUDE_NAME, includeManifest.main ?? 'lib/index.js')
if (!existsSync(includeEntry)) {
  console.error(`${NAME} NOT VERIFIED — the pinned Host schema is not where its own manifest says it is (${includeEntry})`)
  process.exit(1)
}
const hostIncludeModule = await import(pathToFileURL(includeEntry).href)
const hostEntryListSchema = hostIncludeModule.entryListSchema ?? hostIncludeModule.default?.entryListSchema
const yaml4Entry = existsSync(join(YAML4_DIR, 'dist', 'js-yaml.mjs'))
  ? join(YAML4_DIR, 'dist', 'js-yaml.mjs')
  : join(YAML4_DIR, 'index.js')
const yaml4 = await import(pathToFileURL(yaml4Entry).href)

// ── the arms ───────────────────────────────────────────────────────────────
const ARMS = [
  { n: 0, include: true, hoisted: '4', title: 'control: the tree today\'s CI links' },
  { n: 1, include: false, hoisted: '4', title: 'defect #1 alone: the Host include package is not on the profile tree' },
  { n: 2, include: true, hoisted: '5', title: 'defect #2 alone: the profile hoists a js-yaml major whose 4.x schema API is gone' },
  { n: 3, include: false, hoisted: '5', title: 'sentinel: the Host include package is absent AND the profile hoists the wrong major' },
  { n: 4, include: true, hoisted: '4', title: 'fault tolerance: one unreadable source must not take the others down' },
  { n: 5, include: true, hoisted: '4', nested: '5', title: 'diagnostic: the plugin\'s own copy is the wrong major — the failure must name it' },
]

const EXPECTED_IDS = 'wsl-data,wsl-minimal,wsl-standard'
// Arm 4 poisons the FIRST source on purpose: with the last one poisoned an aborted
// loop still leaves the earlier registrations behind, and "all or nothing" would
// measure green on the very shape it is supposed to reproduce.
const ARM4_IDS = 'wsl-data,wsl-minimal'

for (const spec of ARMS) {
  const arm = buildArm(spec)
  const armFailuresAt = failures
  console.log(`\n=== arm ${spec.n} — ${spec.title} ===`)
  let outcome
  try {
    outcome = await runArm(arm, spec.n === 4 ? { failFor: 'standard' } : {})
  } catch (error) {
    check(false, `arm ${spec.n}: the harness itself ran (measured: ${error.message})`)
    continue
  }

  // ── premise lines: a red here means the fixture broke, not the product
  const realEntry = realpathSync(arm.entry)
  check(inside(realEntry, arm.arm), `P1 arm ${spec.n}: the plugin copy is a real file inside the arm (measured: ${realEntry})`)
  const probed = await esmProbe(arm)
  check(!inside(arm.arm, repoRoot),
    `P2 arm ${spec.n}: the tree is not under the repository, so no walk-up can borrow the CI-linked tree (arm: ${arm.arm})`)
  const yamlWalk = nearestModule(dirname(arm.entry), 'js-yaml')
  check(yamlWalk.found !== null && yamlWalk.found.startsWith(join(arm.nm, '')),
    `P2b arm ${spec.n}: the first js-yaml the ancestor walk meets is inside the arm (measured: ${yamlWalk.found ?? `nothing before the root, trail ${yamlWalk.trail.length}`})`)
  check(typeof probed.yaml.url === 'string' && yamlWalk.found !== null
    && realpathSync(fileURLToPath(probed.yaml.url)).startsWith(realpathSync(yamlWalk.found)),
    `P2c arm ${spec.n}: the ESM loader and this walk agree on which js-yaml the copy stands on (loader answered: ${probed.yaml.url ?? probed.yaml.code})`)
  check(nearestModule(dirname(arm.entry), '@deepseek-ai/schemastery').found !== null,
    `P3 arm ${spec.n}: schemastery resolves from the copy, so a red here is generation and not plugin load`)
  const usedVersion = yamlWalk.found === null ? null : versionOf(yamlWalk.found)
  check(usedVersion === YAML4 || usedVersion === YAML5,
    `P4 arm ${spec.n}: that js-yaml is a real installed release, not a stub (measured: ${usedVersion} at ${yamlWalk.found})`)

  if (!spec.include) {
    check(probed.include.code === 'ERR_MODULE_NOT_FOUND',
      `P5 arm ${spec.n}: the ESM loader really cannot reach the Host include package from the copy (measured: ${probed.include.code ?? probed.include.url})`)
  }
  const declared = Object.keys(JSON.parse(readFileSync(join(arm.pkgDir, 'package.json'), 'utf8')).dependencies ?? {})
  const hasNested = existsSync(join(arm.pkgDir, 'node_modules', 'js-yaml', 'package.json'))
  check(declared.includes('js-yaml') === hasNested,
    `P6 arm ${spec.n}: a nested copy exists exactly when the copied manifest declares one (declared=${declared.includes('js-yaml')}, nested=${hasNested})`)
  check(!outcome.timedOut, `P7 arm ${spec.n}: the frame settled inside the deadline (${outcome.elapsed} ms) — a timeout here is the harness, not the product`)

  // ── outcome lines
  const ids = outcome.registered.map(d => d.id).sort().join(',')
  if (spec.n === 4) {
    check(ids === ARM4_IDS, `A6 one unreadable source does not remove the other variants (registered: ${ids || 'none'})`)
    check(outcome.staleGone, 'A7 …and it does not skip the stale-directory sweep that lives after the loop')
    check(outcome.captured.length === 1, `A6b the failing source is reported once, not once per later source (captured: ${outcome.captured.length} line(s))`)
  } else if (spec.n === 5) {
    const joined = outcome.captured.join(' | ')
    check(outcome.registered.length === 0, `arm 5: a hostile own copy registers nothing (registered: ${outcome.registered.length})`)
    check(joined.includes('js-yaml') && joined.includes(YAML5) && joined.includes('node_modules'),
      `A8 the failure names the copy it stands on — package, version and path (measured: ${joined.slice(0, 240) || 'nothing captured'})`)
    check(outcome.staleGone, 'A7 …and an impossible generation still sweeps the stale directories')
  } else {
    check(ids === EXPECTED_IDS, `A${spec.n} variants are generated for every healthy source (${spec.title}) — registered: ${ids || 'none'}`)
    if (spec.n === 3) {
      check(yamlWalk.found !== null && yamlWalk.found.startsWith(join(arm.pkgDir, '')),
        `A3b the only js-yaml this arm could stand on is the plugin's own copy (measured: ${yamlWalk.found ?? 'none'})`)
    }
  }

  if (spec.n === 0) {
    // ── A4: the inlined dialect has to be the Host's dialect, not a self-consistent
    // paraphrase of it. Compare the rows the pinned Host schema produces for the same
    // source document against the rows the product published, for every id both carry.
    const hostRows = yaml4.load(STANDARD_SRC, { schema: hostEntryListSchema })
    const standard = outcome.registered.find(d => d.id === 'wsl-standard')
    const productRows = standard?.plugins ?? []
    const pairs = hostRows.filter(host => productRows.some(p => p.id === host.id))
    check(pairs.length > 0, `A4 some source row survives the transform, so the dialect comparison is not vacuous (pairs: ${pairs.length})`)
    const mismatched = pairs.filter(host => {
      const product = productRows.find(p => p.id === host.id)
      return JSON.stringify(product.disabled ?? null) !== JSON.stringify(host.disabled ?? null)
    })
    check(mismatched.length === 0,
      `A4 the pinned Host schema and the product emit the same nodes for the same rows (differing: ${mismatched.map(r => r.id).join(',') || 'none'})`)

    // ── A5: the failure must not be allowed to move one step later. Every provider row
    // a declaration names by file: URL is imported the way the registry would import it.
    const fileRows = []
    const walk = (rows) => {
      for (const row of rows ?? []) {
        if (typeof row.name === 'string' && row.name.startsWith('file://')) fileRows.push(row)
        if (Array.isArray(row.config)) walk(row.config)
      }
    }
    for (const definition of outcome.registered) walk(definition.plugins)
    const unimportable = []
    for (const row of fileRows) {
      try {
        await import(row.name)
      } catch (error) {
        unimportable.push(`${row.id}: ${error.code ?? error.message}`)
      }
    }
    check(fileRows.length > 0 && unimportable.length === 0,
      `A5 every file: provider row the declarations name imports from inside the arm (${fileRows.length} row(s)${unimportable.length ? `; failed: ${unimportable.join(' | ')}` : ''})`)
    check(outcome.staleGone, 'A0 the control arm sweeps the stale directory')
    check(outcome.captured.length === 0, `A0c the control arm says nothing on a healthy frame (lines: ${outcome.captured.length})`)
  }

  // A red has to carry its own reason: what the product wrote is the measurement, and
  // without it a red line only says "a count was short".
  if (failures > armFailuresAt) {
    console.log(outcome.captured.length > 0
      ? `# arm ${spec.n}: the product said —\n#${outcome.captured.join('\n#')}`
      : `# arm ${spec.n}: the product said nothing at all`)
  }
}

// ── the sink is not decoration ─────────────────────────────────────────────
// Every "nothing was captured" above only means something if the sink demonstrably
// records a line when the product writes one. This arm makes the product write one.
{
  const probe = buildArm({ n: 9, include: true, hoisted: '4' })
  const outcome = await runArm(probe, { failFor: 'standard' })
  check(outcome.captured.length > 0,
    `positive control: the capture sink records a line the product wrote (${outcome.captured.length} captured)`)
}

for (const dir of scratch) removeTreeBare(dir)
check(scratch.every(dir => !existsSync(dir)), 'every scratch tree this file made is gone again')

console.log(failures === 0 ? `${NAME} PASSED` : `${NAME} FAILED (${failures} failing)`)
process.exit(failures === 0 ? 0 : 1)
