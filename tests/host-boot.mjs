/**
 * Boot a real `@deepseek-ai/dsh` and check that it is a real one.
 *
 * Every host-shaped test in this repository runs against something hand-built.
 * `tests/host-declare.mjs` says in its first line that its roster face is "shaped like DSH
 * v0.1.7-rc.1"; `tests/host-materialize.mjs`'s peers are name strings with nothing imported behind
 * them. A fake has no loader, no lifecycle, and no real consumer on the other side — so a whole
 * class of defect is invisible to all of it, and nothing in `tests/` or `scripts/` imports
 * `@deepseek-ai/dsh` at all.
 *
 * **This gate's job in Phase 0 is only to prove the substrate is real.** The properties come later.
 * A green run here means "the boot happened and the host is the pinned one" — nothing more, and the
 * report says so in those words. The seven positive controls exist because a harness that quietly
 * substituted a fake would also print green; P7 is the one that would notice.
 *
 *   node tests/host-boot.mjs
 *
 * Exit codes follow the house rule: only one outcome may exit 0. `NOT VERIFIED` — the boot did not
 * happen, so nothing was compared — is a failure, because "did not compare" is not "did not drift".
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bareContextReads, declaredInject, hostMentions, offeredJobChannels } from './parity/derive.mjs'
import { HOST_BOOT_REDS, compareHostBoot, premises } from './host-boot-debt.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHILD = join(repoRoot, 'tests', 'support', 'boot-child.mjs')
const TIMEOUT_MS = 120_000

/**
 * The host surface this gate asks for.
 *
 * Written out rather than taken from a shipped profile template, because the templates drag in
 * twenty-eight packages (`sdk-minimal` → agent, session-persistence, llm, mcp, …) whose own imports
 * fail on a clean tree, and none of that surface is what the properties will look at. Each row here
 * is a service something in this repository actually consumes.
 */
const HOST_ROWS = [
  ['tools', '@deepseek-ai/dsh-tools'],
  ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
  ['terminals', '@deepseek-ai/dsh-terminal'],
  ['terminal-bash', '@deepseek-ai/dsh-terminal-bash'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-bash-persistent', '@deepseek-ai/dsh-tool-bash-persistent'],
  ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
  ['subprocess-local', '@deepseek-ai/dsh-subprocess-local'],
  ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy'],
  ['jobs', '@deepseek-ai/dsh-jobs-local'],
  ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
  ['fs', '@deepseek-ai/dsh-fs'],
  ['shell', '@deepseek-ai/dsh-shell'],
  ['host-webserver', '@deepseek-ai/dsh-host-webserver'],
]

/**
 * `host-webserver` requires `host` and `port` (measured: instantiating it alone reports
 * `invalid config: $.host missing required value`). `host` accepts only `127.0.0.1` or `0.0.0.0`, and
 * `port: 0` means the OS assigns one — its `port` getter documents that, which is also why this
 * cannot collide on a CI runner.
 */
const ROW_CONFIG = {
  'host-webserver': { host: '127.0.0.1', port: 0 },
}

/**
 * Where the throwaway `$DSH_HOME` goes.
 *
 * Inside `ci/deps/` on purpose: bare specifiers in the profile's rows resolve against the module
 * scope chain, so a home under the OS temp directory cannot see `ci/deps/node_modules` and every row
 * fails to mount. That is a real constraint of how ESM resolves, not a style preference.
 */
function makeHome() {
  return mkdtempSync(join(repoRoot, 'ci', 'deps', '.host-boot-home-'))
}

/**
 * The profile manifest: `{name, private, dependencies, dsh:{profile:{bundles}}}` — the shape
 * `dsh-app-boot`'s `initProfile` writes (`lib/index.js:576-587`).
 *
 * Existence is judged by this file (`lib/index.js:974` checks `package.json`, not the directory and
 * not `cordis.yml`), and `initializeProfileFromDefault` refuses a directory that already exists —
 * so writing our own is the only clean way in. It also means `prepareProfile`'s unconditional
 * overwrite of `cordis.yml` with an empty entry list (`profile-boot-*.js:189`) costs nothing: the
 * tree is meant to be composed by patches.
 */
function writeManifest(home, profile, bundles) {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }, null, 2)}\n`, 'utf8')
  return dir
}

/**
 * The overlay patch: a YAML array of `cordis-plugin-include` `PatchOptions`.
 *
 * Two shapes worth recording because both produced a wrong-looking failure first:
 *   · a scalar starting with `@` is a YAML reserved indicator and must be quoted, or the parser
 *     reports `bad indentation` pointing at the *following* line rather than at the unquoted value;
 *   · `config` is a nested object, so `config.host: x` is a literal key named `config.host` and is
 *     silently ignored — which looks exactly like "the config did not help".
 *
 * The plugin's entry must be a **file**, not the directory: `anchorInsertedPluginNames`
 * (`dsh-app-boot/lib/index.js:3538`) turns absolute paths into file URLs, and handing it the
 * directory yields `ERR_UNSUPPORTED_DIR_IMPORT`.
 */
function writeOverlay(home, rows, pluginEntry) {
  const yaml = ['- insert:']
  for (const [id, name] of rows) {
    yaml.push(`    - id: ${id}`, `      name: "${name}"`)
    if (ROW_CONFIG[id] !== undefined) {
      yaml.push('      config:')
      for (const [key, value] of Object.entries(ROW_CONFIG[id])) {
        yaml.push(`        ${key}: ${JSON.stringify(value)}`)
      }
    }
  }
  yaml.push(`    - id: ${pluginEntry.id}`, `      name: "${pluginEntry.name}"`, '')
  const file = join(home, 'overlay.yml')
  writeFileSync(file, yaml.join('\n'), 'utf8')
  return file
}

/**
 * Every service this plugin's sources reach for, and how they reach for it.
 *
 * Derived from `src/**.ts` rather than read out of the boot, because a list taken from the boot can
 * only ever name what the boot happened to provide. Two shapes, and the distinction is the whole
 * subject of the property:
 *
 *   · **declared** — `export const inject = ['subprocess']` or `static inject = ['…']`. The host
 *     reads this and is expected to give the plugin the service.
 *   · **bare** — `this.ctx.subprocess.spawn(…)` with no `ctx.get` guard. This is the shape that
 *     produced `cannot get property "subprocess" without inject`: nothing catches it, so if the
 *     service is missing the plugin throws at the moment it is used rather than declining to load.
 *
 * A bare read whose service no module in the tree declares is unreachable by construction, and that
 * is reported as its own failure rather than as an absence nobody can explain.
 *
 * The parser is TypeScript's, because the hand-rolled scanner cannot survive `src/shell.ts:279` —
 * see the derivation's own comment for the measurement.
 */
function deriveRequirements() {
  const declared = []
  const requirements = []
  const bareModules = new Map()

  for (const file of pluginSources()) {
    // `read()` takes a repository-relative path and joins it onto the repo root; handing it an
    // absolute path makes it look for `<repo>/D:/…`, which fails loudly rather than quietly.
    const relative = file.slice(repoRoot.length + 1).replaceAll('\\', '/')
const inject = declaredInject(relative)
    if (inject !== null) {
      declared.push(...inject)
      for (const service of inject) {
        requirements.push({ service, module: relative, how: `declared in inject (${relative})` })
      }
    }
    for (const read of bareContextReads(relative)) {
        const list = bareModules.get(read.name) ?? []
        list.push(relative)
        bareModules.set(read.name, list)
      }
  }

  // Every bare read is also a requirement: the question the property asks is whether it resolves,
  // not whether someone remembered to declare it.
  for (const [service, modules] of bareModules) {
    requirements.push({
      service,
      module: [...new Set(modules)].sort().join(', '),
      how: `read bare (no ctx.get guard) in ${[...new Set(modules)].length} module(s)`,
    })
  }

  return { requirements, declaredInject: [...new Set(declared)].sort() }
}

function pluginSources() {
  const out = []
  // `src/client/**` is excluded, and the reason is printed rather than assumed. Those modules run in
  // the **client** runtime: `src/client/index.ts` declares `inject = ['slots', 'locale', 'sessions',
  // 'workspaces']`, and every one of those is provided by `dsh-client-runtime`, which this host boot
  // does not load. Asking a host-only boot whether they resolve produces six failures that say
  // nothing about the host — and a property that reports a question it never asked is worse than no
  // property, because it trains the reader to ignore red. Excluding them is the house rule applied
  // properly: "not compared" must be *declared*, never silently skipped.
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (full.replaceAll('\\', '/').endsWith('src/client')) continue
        walk(full)
      } else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(join(repoRoot, 'src'))
  return out.sort()
}

function runChild(env, plan) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CHILD, JSON.stringify(plan)], {
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    // `runProfile` owns SIGINT/SIGTERM inside the child, so the timeout has to be this process's job.
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.on('error', error => { clearTimeout(timer); resolvePromise({ stdout, stderr, spawnError: String(error?.code ?? error) }) })
    child.on('close', code => { clearTimeout(timer); resolvePromise({ stdout, stderr, exit: code }) })
  })
}

// ── compose the profile, boot, report ────────────────────────────────────────

const PROFILE = 'host-boot'
const home = makeHome()
const pluginEntry = {
  id: 'dsh-wsl-workspace',
  name: pathToFileURL(join(repoRoot, 'lib', 'index.js')).href,
}

if (!existsSync(pluginEntry.name.replace('file:///', '').replaceAll('/', '\\'))) {
  // `lib/index.js` is the committed artifact; a missing one means the build gates have not run.
  console.log(`host-boot: NOT VERIFIED — the plugin's entry ${pluginEntry.name} does not exist.`)
  console.log('  Run `npm run build` first: this gate loads the artifact, not the sources, because the')
  console.log('  artifact is what users install and the two are different propositions.')
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

writeManifest(home, PROFILE, HOST_ROWS.map(([, name]) => name))
const overlay = writeOverlay(home, HOST_ROWS, pluginEntry)

const { requirements, declaredInject: declaredSurface } = deriveRequirements()
const outcome = await runChild({ DSH_HOME: home }, {
  profile: PROFILE, patchFiles: [overlay], requirements, declaredInject: declaredSurface,
})
rmSync(home, { recursive: true, force: true })

const marker = (outcome.stdout ?? '').split('\n').find(line => line.startsWith('##BOOT##'))
if (marker === undefined) {
  console.log('host-boot: NOT VERIFIED — the child produced no report.')
  console.log(`  exit: ${outcome.exit}   spawnError: ${outcome.spawnError ?? 'none'}`)
  console.log('  --- child stderr, last 40 lines ---')
  console.log((outcome.stderr ?? '').split('\n').slice(-40).map(l => `  ${l}`).join('\n'))
  process.exit(1)
}

const report = JSON.parse(marker.slice('##BOOT##'.length))

if (report.stage !== 'booted') {
  console.log(`host-boot: NOT VERIFIED — the host did not boot (stage: ${report.stage}).`)
  if (report.error) console.log(`  error: ${report.error}`)
  if (report.startup) console.log(`  startup: ${report.startup}`)
  console.log('  This is a fixture premise, not a verdict on the plugin.')
  process.exit(1)
}

const probes = report.probes
const rows = JSON.parse(probes.rows.value)
const own = rows.find(row => row.id === 'dsh-wsl-workspace')
const byId = new Map(rows.map(row => [row.id, row]))

const checks = [
  ['P1 the host has a loader with entries', probes.p1_loaderPresent.ok && Number(probes.rowCount.value) >= HOST_ROWS.length,
    `loader=${probes.p1_loaderClass.value}, rows=${probes.rowCount.value} (asked for ${HOST_ROWS.length} + our own)`],
  ['P2 $DSH_HOME was read, and it is the directory this process built', probes.p2_dshHomePath.value === home,
    `host said ${probes.p2_dshHomePath.value}, we built ${home}`],
  ['P3 the host\'s own plugins mounted', ['jobs', 'host-webserver'].every(id => byId.get(id)?.stateName === 'ACTIVE'),
    probes.p3_hostRows.value],
  ['P4 this plugin\'s own row mounted and activated', own?.stateName === 'ACTIVE',
    `dsh-wsl-workspace is ${own?.stateName ?? 'ABSENT'}`],
  ['P5 the services this plugin declares are real objects, not stubs', ['webServer', 'fs'].every(s => probes.p6_services.value.includes(`\"${s}\":\"object\"`)),
    probes.p6_services.value],
  ['P6 nothing looks substituted', probes.p7_sentinels.value === '[]' && probes.p7_hostOwnServices.value.includes('loader'),
    `sentinels=${probes.p7_sentinels.value}, host services=${probes.p7_hostOwnServices.value}`],
  ['P7 the web server is listening', /^\d+$/.test(probes.webServerPort.value) && Number(probes.webServerPort.value) > 0,
    `port ${probes.webServerPort.value}`],
]

console.log('host-boot: a real @deepseek-ai/dsh, booted')
console.log(`  profile home: ${home}`)
console.log(`  plugin entry: ${pluginEntry.name}`)
console.log(`  ${'─'.repeat(70)}`)
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n         ${detail}`)
}
console.log(`  ${'─'.repeat(70)}`)
console.log('  what the host did with each row:')
for (const row of rows) {
  const marker2 = row.stateName === 'ACTIVE' ? '  ' : row.stateName === 'NO_FIBER' ? '!!' : ' ~'
  console.log(`  ${marker2} ${row.stateName.padEnd(9)} ${String(row.id).padEnd(22)} ${row.declaredInject.join(',')}`)
}
console.log(`  ${'─'.repeat(70)}`)
console.log('  Rows marked ` ~` are waiting for a service this gate did not ask for, and `!!` never got')
console.log('  a fiber at all. Neither is a verdict on the plugin — this step only establishes that the')
console.log('  substrate is real. The properties that read these states come after.')

// ── the property ────────────────────────────────────────────────────────────────────────────
//
// One question, asked against the realm that will actually run the code: **can every service this
// plugin's sources reach for be resolved?** Not "did it declare them" — the loader echoes a
// declaration back verbatim, so that check would pass with the plugin doing nothing at all.

const resolvedServices = JSON.parse(probes.requirements.value)
const bareReads = resolvedServices.filter(entry => entry.how.startsWith('read bare'))
const unreachable = resolvedServices.filter(entry => !entry.reachable)

console.log(`  the plugin's own row declares: ${probes.ownRowInject.value}`)
console.log(`  ${'─'.repeat(70)}`)
console.log('  every service the sources reach for, resolved in the booted host:')
for (const entry of resolvedServices) {
  console.log(`  ${entry.reachable ? 'ok  ' : 'FAIL'} ${entry.service.padEnd(15)} ${entry.resolvedAtRoot.padEnd(9)} ${entry.how}`)
}
console.log(`  ${'─'.repeat(70)}`)
console.log(`  ${bareReads.length} of them are read bare, with no ctx.get guard:`)
for (const entry of bareReads) console.log(`    ${entry.service} — ${entry.module}`)
console.log('    A bare read throws at the moment of use if the service is missing, rather than')
console.log('    declining to load. That is the shape that produced the harshest runtime errors, and')
console.log('    it is invisible to a fake, which has no realms to be missing in.')
console.log('  Not compared: `src/client/**`. Those modules run in the client runtime and declare')
console.log('    `slots` / `locale` / `sessions` / `workspaces`, which this host boot does not load — so')
console.log('    asking it would be asking a question it was never given. Stated, not skipped.')

// ── the producer/consumer property ────────────────────────────────────────────────────────
//
// This one needs no boot at all, and that is worth noticing: the defect it looks for is a contract
// whose shape drifted between two packages, and both sides' sources are in front of us.
//
// The question is mechanical — *for each member this plugin hands the host, does the consuming
// package still name it?* — and the answer comes from counting occurrences in
// `dsh-jobs-local` / `dsh-jobs` / `dsh-tool-jobs`. Nothing here is a hand-written list, so if the
// host stops reading a channel the count falls to zero on its own, with no edit to this file.

const channels = offeredJobChannels()
const offered = [...new Set([...channels.spec, ...channels.runResult])]
const mentions = hostMentions(offered)
const unread = offered.filter(name => mentions.counts[name] === 0)

console.log(`  ${'─'.repeat(70)}`)
console.log('  every member this plugin hands the host, and whether the host still names it:')
for (const name of offered) {
  const count = mentions.counts[name]
  const where = name === 'run' ? 'on the spec' : channels.runResult.includes(name) ? 'from run()' : 'on the spec'
  console.log(`  ${count === 0 ? 'FAIL' : 'ok  '} ${name.padEnd(14)} ${String(count).padStart(4)} mention(s)   ${where}`)
}
console.log(`  searched: ${mentions.packages.join(', ')}`)
if (unread.length > 0) {
  console.log(`  ${'─'.repeat(70)}`)
  console.log(`  ${unread.length} member(s) the host does not name at all:`)
  for (const name of unread) {
    console.log(`    ${name} — offered ${channels.runResult.includes(name) ? 'from run()' : 'on the spec'}, zero readers`)
  }
  console.log('    A member with no reader is not a slower path; it is a channel the far side cannot')
  console.log('    see. Whatever reads it will report the job as having produced nothing.')
}
if (unreachable.length > 0) {
  console.error(`\n  ${unreachable.length} service(s) the sources reach for are NOT resolvable:`)
  for (const entry of unreachable) console.error(`    ${entry.service} — ${entry.how}`)
}

const failed = checks.filter(([, ok]) => !ok)

// ── the ledger ──────────────────────────────────────────────────────────────────────────────
//
// A property that finds something real is **red**, and a bare red is not shippable: the next person
// to read CI cannot tell a broken gate from a working one. So every red this gate can produce goes
// through the same bidirectional arithmetic the seam ledger uses — a new red fails, a declared red
// that turned green fails, and the debt cannot be retired without being withdrawn in the same commit.

const observedReds = [
  // `unread` and `unreachable` are already name lists — `unread` comes from `offered.filter(...)`, so
  // mapping `.name` over it would file an empty string and the ledger would report a blank red.
  ...unread,
  ...unreachable.map(entry => entry.service),
  ...failed.map(([, name]) => name),
]
const verdict = compareHostBoot(observedReds)
const undeclared = verdict.extraRed ?? []

console.log(`  ${'─'.repeat(70)}`)
console.log('  the rules these checks stand for:')
for (const line of premises()) console.log(`    ${line}`)
console.log(`  ${'─'.repeat(70)}`)
console.log(`  ledger: ${verdict.ok ? 'every red observed is on the books' : 'MISMATCH'}`
  + ` (${observedReds.length} observed, ${HOST_BOOT_REDS.length} declared)`)

// Green means two different things here and the report has to say which: every check passed, or every
// red that appeared is one the ledger already accounts for. The second is the whole reason the
// ledger exists — a known defect should not make CI unreadable, and it should become *unreadable*
// again the moment it is paid without being withdrawn.
if (failed.length > 0) {
  console.error(`\nhost-boot: RED — ${failed.length} positive control(s) failed. `
    + 'The substrate did not look like the pinned host, so nothing downstream can be trusted.')
  process.exit(1)
}
if (!verdict.ok) {
  console.error(`\nhost-boot: RED — the ledger does not match what the gate observed.`)
  for (const name of undeclared) console.error(`    undeclared red: ${name}`)
  for (const id of verdict.missing ?? []) console.error(`    declared red did not appear: ${id}`)
  for (const id of verdict.moved ?? []) console.error(`    declared red moved: ${id}`)
  console.error('  Either a new defect is present, or a known one was paid without being withdrawn.')
  process.exit(1)
}
console.log(`\nhost-boot: GREEN — 7/7 positive controls, ${resolvedServices.length} service(s) reachable, `
  + `${observedReds.length} red(s) exactly as declared.`)
if (observedReds.length > 0) {
  console.log('  The declared reds are on the books with a repair. This gate will go red again if one')
  console.log('  is paid without being withdrawn, which is the only way a debt retires here.')
}
process.exit(0)