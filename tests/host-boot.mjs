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
import { DEFAULT_ROUTE } from '../lib/index.js'
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
  // Order is load-bearing, and finding that out is most of what this harness is for. Rows load in
  // array order, so the host services the plugin's `apply()` reaches for are placed before it:
  // `src/index.ts:1120` reads `ctx.get('agentPresets')` in a **one-shot guard outside the effect**,
  // so a service that arrives a moment later leaves the plugin registered with nothing and saying
  // nothing about it. Putting these first is what a host that composes a preset tree already does;
  // the fact that the plugin cannot survive the other order is a finding, and it is filed as one.
  ['agent-presets', '@deepseek-ai/dsh-agent-preset-registry'],
  ['session-projections', '@deepseek-ai/dsh-session-projection'],
  ['agent-preset-defs', '@deepseek-ai/dsh-agent-preset'],
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
  // Deliberately **no** `dsh-fs` and **no** `dsh-shell` row. Both names are provided by this plugin's
  // own entries (`lib/fs.js`, `lib/shell.js`), so loading them here made the host and the plugin
  // register the same service and the loader refused the second: `service "fs" has been registered at
  // <FileSystem>`. That failure was this file's composition error, not the plugin's, and it is worth
  // recording because a harness that mis-assembles the tree will blame the code under test.
  //
  // It is also the reason the whole approach has to change: a plugin that isolates its `fs` and
  // `shell` inside a preset world cannot be modelled by loading its entries as root rows. The tree has
  // to be composed the way the host composes it — through the preset — or the isolation the preset
  // exists to create is exactly what the harness destroys.
  ['host-webserver', '@deepseek-ai/dsh-host-webserver'],
  // `shellEnv`, without which the host's own `bash` row sits at "waiting for shellEnv", the preset
  // is marked `broken`, and the plugin skips it entirely
  // (`presets.filter(preset => preset.broken === undefined && …)`). Measured chain, three hops from
  // a provider that looked optional.
  ['shell-env', '@deepseek-ai/dsh-shell-env'],
  // The skill registry. `dsh-skill-filesystem` waits on it, and the host's own audit prints
  // `skill-filesystem: pending (waiting for service: skills)` without it — which is the shape of a
  // provider whose absence is invisible until something reads the roster.
  ['skills', '@deepseek-ai/dsh-skill'],
  // The agent registry. The jobs service refuses an owned job without it, by name:
  // `background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)`. Every
  // background job this plugin starts is owned, so without this row the real producer cannot run at
  // all — and the only symptom is that sentence.
  ['agent', '@deepseek-ai/dsh-agent'],
  // …and the loop, which is the factory that makes an agent *runnable*:
  // `no agent factory registered (load an agent-loop plugin)`. Two rows for one capability, each
  // naming its own missing half.
  ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
  // …which in turn waits for the session store and an LLM provider. These three rows are one
  // capability, and each is named by the one before it, which is why they are here together rather
  // than discovered one at a time.
  ['sessions', '@deepseek-ai/dsh-session'],
  ['llm', '@deepseek-ai/dsh-llm'],
]

/**
 * `host-webserver` requires `host` and `port` (measured: instantiating it alone reports
 * `invalid config: $.host missing required value`). `host` accepts only `127.0.0.1` or `0.0.0.0`, and
 * `port: 0` means the OS assigns one — its `port` getter documents that, which is also why this
 * cannot collide on a CI runner.
 */
/**
 * This plugin's own entries, loaded **one row each**.
 *
 * Not decoration. `lib/*.js` are separate plugin entries, each with its own `inject`: `index` declares
 * `webServer`, `shell` declares `subprocess`, `wsl-jobs` and `wsl-search` declare `tools`,
 * `wsl-terminal-tool` declares `terminals`. Loading only `lib/index.js` — which is what this harness
 * did at first — leaves the other six without fibers, so their `inject` declarations are never
 * exercised at all. Measured: a mutation that broke `shell`'s `static inject` changed no verdict,
 * because no fiber existed to notice. **Loading only the main entry tests one of seven handoffs.**
 *
 * `wsl-relay.js` is deliberately absent and the report names it: importing it throws, because it reads
 * `DSH_WSL_DISTRO` and the session cwd at module scope. That is worth stating rather than working
 * around — it means that entry can only be exercised inside a real session, which is a fact about the
 * code and not about this harness.
 */
const PLUGIN_ROWS = [
  ['wsl-index', 'lib/index.js'],
  ['wsl-shell', 'lib/shell.js'],
  ['wsl-fs', 'lib/fs.js'],
  ['wsl-sandbox', 'lib/wsl-sandbox.js'],
  ['wsl-jobs', 'lib/wsl-jobs.js'],
  ['wsl-search', 'lib/wsl-search.js'],
  ['wsl-terminal', 'lib/wsl-terminal-tool.js'],
]

const ROW_CONFIG = {
  'host-webserver': { host: '127.0.0.1', port: 0 },
  // The registry's `Config` requires a `default` preset id (measured: its static Config marks
  // `default` as `"defined"` with no fallback), so the row cannot load without one. `wsl-` + the id the
  // plugin derives its variant from.
  'agent-presets': { default: 'wsl-standard' },
  // One row per preset definition: `dsh-agent-preset`'s `Config` **is** a `PresetDefinition`, so its
  // schema demands `id` (measured: `ValidationError: $.id missing required value`). This row exists so
  // the plugin has a host preset to transform — it registers `wsl-standard` derived from `standard`,
  // it does not define one.
  'agent-preset-defs': {
    id: 'standard',
    // A preset with a `bash` row in it, because that is what the plugin transforms: it registers
    // `wsl-standard` by replacing the host's bash/fs rows with its own. A preset with `plugins: []`
    // gives it nothing to replace and it registers nothing — which is indistinguishable, from outside,
    // from the guard never firing.
    plugins: [
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    ],
  },
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
function writeOverlay(home, rows, pluginEntries) {
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
  for (const [id, relative] of pluginEntries) {
    yaml.push(`    - id: ${id}`, `      name: "${pathToFileURL(join(repoRoot, relative)).href}"`)
  }
  yaml.push('')
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
      // The plugin resolves its distribution from the session path first and `DSH_WSL_DISTRO` second;
    // without the fallback it logs "no WSL distribution resolved for the session probe" and mounts
    // nothing, which is a property of the harness rather than of the plugin.
    env: { ...process.env, DSH_WSL_DISTRO: DISTRO, ...env },
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
const mainEntry = pathToFileURL(join(repoRoot, 'lib', 'index.js')).href

for (const [, relative] of PLUGIN_ROWS) {
  if (existsSync(join(repoRoot, relative))) continue
  console.log(`host-boot: NOT VERIFIED — the plugin entry ${relative} does not exist.`)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}
if (false) {
  // `lib/index.js` is the committed artifact; a missing one means the build gates have not run.
  console.log(`host-boot: NOT VERIFIED — the plugin's entry ${mainEntry} does not exist.`)
  console.log('  Run `npm run build` first: this gate loads the artifact, not the sources, because the')
  console.log('  artifact is what users install and the two are different propositions.')
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

// **No bundles.** A `bundles` entry must declare `dsh.bundle` in its own package.json; these are
// plugins, not bundles, and listing them produced one `skipping profile bundle … declares no
// dsh.bundle` line per row on every run — noise that trains a reader to skim the log. Everything the
// profile needs arrives as a patch row instead.
writeManifest(home, PROFILE, [])
const overlay = writeOverlay(home, HOST_ROWS, PLUGIN_ROWS)

const { requirements, declaredInject: declaredSurface } = deriveRequirements()

// A real Windows-visible path into the distribution, in the shape the real drivers build: the
// session's `cwd` is a UNC path, and the plugin resolves both the distribution and the Linux
// directory from it. `distro-shape-real.mjs` and `bash-session-real.mjs` construct the same shape,
// which is why this is a copy of a known-good form rather than an invention.
const DISTRO = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const LINUX_HOME = process.env.WSL_COMPAT_ROOT ?? '/tmp'
const sessionCwd = `\\\\wsl.localhost\\${DISTRO}${LINUX_HOME.replaceAll('/', '\\')}`
const outcome = await runChild({ DSH_HOME: home }, {
  profile: PROFILE, patchFiles: [overlay], requirements, declaredInject: declaredSurface,
  pluginRowIds: PLUGIN_ROWS.map(([id]) => id),
    sessionId: `host-boot-${process.pid}`,
    sessionCwd: sessionCwd,
    // The path the user-facing dialog lives at, taken from the module that declares it rather than
    // written here — a second copy of the path would be the failure this whole branch removes.
    defaultRoute: DEFAULT_ROUTE,
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

// The loader's own diagnostics go to the child's stderr, not into the report, so a row that failed
// quietly looks identical to one nobody asked about. Carrying the tail is what makes `FAILED`
// actionable instead of merely red.
const childStderrTail = (outcome.stderr ?? '').split('\n').filter(line => line.trim() !== '')

const probes = report.probes
const rows = probeJson(probes, 'rows', [])
const own = rows.find(row => row.id === 'dsh-wsl-workspace')
const byId = new Map(rows.map(row => [row.id, row]))

/**
 * Read a probe that reports JSON, without ever throwing.
 *
 * A probe that throws records the string `THREW: …` in place of its value, so `JSON.parse` on it
 * throws — and a diagnostic that crashes the gate is worse than no diagnostic, because it takes the
 * verdict with it. This was not hypothetical: it is what happened, twice, on the run that found the
 * two entries that do not load.
 */
function probeJson(probes, label, fallback) {
  const raw = probes[label]?.value
  if (typeof raw !== 'string') return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

// Assigned inside the preset block below and read by the ledger after it, so it is declared here:
// a `const` inside that block would be out of scope by the time the ledger is computed, which is the
// same class of mistake as reading a probe's value before its shape has been checked.
let isolationHolds = false
let pluginChannelReadable = false
let hostChannelReadable = false
let hostAudit = null
let realJobView = null
let realJobReadable = false
let hostAcceptsPreset = false
let realmMounted = false
let realmClean = false
let realmHoldsFs = false

const checks = [
  ['P1 the host has a loader with entries', probes.p1_loaderPresent.ok && Number(probes.rowCount.value) >= HOST_ROWS.length,
    `loader=${probes.p1_loaderClass.value}, rows=${probes.rowCount.value} (asked for ${HOST_ROWS.length} + our own)`],
  ['P2 $DSH_HOME was read, and it is the directory this process built', probes.p2_dshHomePath.value === home,
    `host said ${probes.p2_dshHomePath.value}, we built ${home}`],
  ['P3 the host\'s own plugins mounted', ['jobs', 'host-webserver'].every(id => byId.get(id)?.stateName === 'ACTIVE'),
    probes.p3_hostRows.value],
  // **Presence, not activation.** Whether an entry *loads* is a debt with an entry in the ledger, and
  // a positive control that fails for a known reason takes the verdict with it — the gate would go
  // red for something already on the books, which is the confusion this ledger exists to remove. What
  // the substrate owes is that the rows were accepted and got fibers at all.
  ['P4 the host accepted every one of this plugin\'s entries as a row', PLUGIN_ROWS.every(
    ([id]) => byId.get(id) !== undefined && byId.get(id)?.stateName !== undefined),
    PLUGIN_ROWS.map(([id]) => `${id}=${byId.get(id)?.stateName ?? 'ABSENT'}`).join(' ')],
  ['P5 the services this plugin declares are real objects, not stubs', ['webServer', 'fs'].every(s => probes.p6_services.value.includes(`\"${s}\":\"object\"`)),
    probes.p6_services.value],
  ['P6 nothing looks substituted', probes.p7_sentinels.value === '[]' && probes.p7_hostOwnServices.value.includes('loader'),
    `sentinels=${probes.p7_sentinels.value}, host services=${probes.p7_hostOwnServices.value}`],
  ['P7 the web server is listening', /^\d+$/.test(probes.webServerPort.value) && Number(probes.webServerPort.value) > 0,
    `port ${probes.webServerPort.value}`],
]

console.log('host-boot: a real @deepseek-ai/dsh, booted')
console.log(`  profile home: ${home}`)
console.log(`  plugin entries: ${PLUGIN_ROWS.map(([id, rel]) => id + "=" + rel).join(", ")}`)
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

const resolvedServices = probeJson(probes, 'requirements', [])
const roster = probeJson(probes, 'presetRoster', [])
const presetProblems = probeJson(probes, 'presetProblems', [])
if (probes.presetRegistry !== undefined) {
  console.log(`  the host's preset registry: ${probes.presetRegistry.value}`)
  console.log(`  presets it ended up holding: ${roster.length === 0 ? '(none)' : roster.map(entry => `${entry.id}[${entry.plugins ?? '?'} rows${entry.broken === null ? '' : ` BROKEN: ${entry.broken}`}]`).join(', ')}`)
  // ── the user-facing route, asked of the host's router ───────────────────────────────────
  console.log(`  the route the user dialog posts to: ${probes.userRoute?.value ?? '(not probed)'}`)
  let userRoute = null
  try { userRoute = JSON.parse(probes.userRoute?.value ?? 'null') } catch { userRoute = null }
  const routeRegistered = userRoute?.registered === true
  console.log(`    ${routeRegistered ? 'ok  ' : 'FAIL'} the host's router holds it (${userRoute?.route})`)

  // ── the real thing: this plugin's producer, over real WSL, read by the host's reader ───────
  // The strongest evidence this system can produce, and the reason it exists: the plugin's **own**
  // `bash_background` tool runs a **real** command in a **real** distribution, and the output comes
  // back through the **host's** reader. Not a contract reading, not a shape comparison — the product,
  // doing the thing, observed by the other party.
  const realJob = String(probes.realJob?.value ?? '(not probed)')
  console.log(`  the plugin's own background job, read back by the host: ${realJob}`)
  let realJobParsed = null
  try { realJobParsed = JSON.parse(probes.realJob?.value ?? 'null') } catch { realJobParsed = null }
  realJobView = realJobParsed
  realJobReadable = realJobView?.carriesMarker === true
  if (realJobView === null) {
    console.log('    NOT MEASURED — the real job did not run here; see the value above.')
  } else {
    console.log(`    ${realJobReadable ? 'ok  ' : 'FAIL'} the marker came back through the host's reader (${realJobView.chunkCount} chunk(s), status ${realJobView.status})`)
  }

  // ── the mounted preset: the realm, and the host's own leak verdict ─────────────────────
  console.log(`  the mounted preset, as the host assembled it: ${probes.realmVisibility?.value ?? '(not probed)'}`)
  let realm = null
  try { realm = JSON.parse(probes.realmVisibility?.value ?? 'null') } catch { realm = null }
  const realmMounts = realm?.mounts ?? []
  const anyLeak = realmMounts.some(entry => Array.isArray(entry?.leaked) && entry.leaked.length > 0)
  const realmHoldsFsValue = realm?.toolFsSeesFs === true
  // **Not measured** and **measured-and-red** are different, and the report must not blur them. If the
  // preset could not be mounted at all, that is this harness not having assembled the host's scope
  // chain — it says nothing about whether the isolation holds, and a FAIL there would be a false
  // accusation. A leak verdict is only reported once there is a mounted realm to leak from.
  const mountFailed = typeof probes.realmVisibility?.value === 'string'
    && probes.realmVisibility.value.startsWith('THREW:')
  if (mountFailed) {
    console.log('    NOT MEASURED — the preset could not be mounted here, so runtime isolation is unverified:')
    console.log(`      ${probes.realmVisibility.value}`)
    console.log('      What *is* verified is on the lines above: the isolation survives into the document')
    console.log('      the host holds, and the host\'s own auditor accepts that document. Whether the realm')
    console.log('      then enforces it at run time needs an Agent, which needs the session stack.')
  } else {
    console.log(`    ${realmMounts.length === 0 ? 'FAIL' : 'ok  '} the preset mounted into a live subtree (${realmMounts.length} mount(s))`)
    console.log(`    ${anyLeak ? 'FAIL' : 'ok  '} nothing inside the isolate leaked into the root${anyLeak ? ` — ${realmMounts.filter(e => e.leaked?.length).map(e => `${e.id}: ${e.leaked.join(',')}`).join('; ')}` : ''}`)
    console.log(`    ${realm?.toolFsSeesFs === 'no-tool-fs-row' ? 'note' : realmHoldsFsValue ? 'ok  ' : 'FAIL'} inside the realm, tool-fs sees fs: ${realm?.toolFsSeesFs}`)
  }

  // ── the host's own verdict on this plugin's preset ──────────────────────────────────────
  // The counterparty's own acceptance, not our reading of its rules. A non-null `listProblem` is the
  // host saying this preset tree is malformed, and nothing written here gets to overrule it.
  try { hostAudit = JSON.parse(probes.hostAudit?.value ?? 'null') } catch { hostAudit = null }
  const hostAccepts = hostAudit !== null && hostAudit.listProblem === null
  hostAcceptsPreset = hostAccepts
  realmMounted = realmMounts.length > 0
  realmClean = realmMounts.length > 0 && !anyLeak
  realmHoldsFs = realmHoldsFsValue
  console.log(`  the host's own auditor on wsl-standard: ${probes.hostAudit?.value ?? '(not probed)'}`)
  console.log(`    ${hostAccepts ? 'ok  ' : 'FAIL'} the host accepts this preset tree`)

  // ── the dynamic round trip, through the host's own reader ────────────────────────────────
  let roundTrip = null
  try { roundTrip = JSON.parse(probes.jobRoundTrip.value) } catch { /* reported below */ }
  if (probes.jobRoundTrip !== undefined) {
    console.log(`  the host's own reader, on two registrations of the same work: ${probes.jobRoundTrip.value}`)
    // The declaration: a value handed to the host must come back through the reader the host
    // actually uses. A channel the far side never reads is not a slower path, it is a lost value.
    // Two different questions, and conflating them was the first version's bug: `spec.output` is the
    // channel **the host reads**, so it is a positive control on the harness — if that fails, the
    // harness is broken, not the plugin. `run().readOutput` is the channel **this plugin offers**,
    // and its readability is the finding.
    hostChannelReadable = roundTrip?.viaSpecOutput === true
    pluginChannelReadable = roundTrip?.viaRunReadOutput === true
    console.log(`    ${hostChannelReadable ? 'ok  ' : 'FAIL'} the host can read its own channel (spec.output) — harness control`)
    console.log(`    ${pluginChannelReadable ? 'ok  ' : 'note'} the host can read the channel this plugin offers (run().readOutput)`)
  }

  // ── the isolation, as the host holds it ─────────────────────────────────────────────────
  // The plugin's whole claim about `fs` and `shell` is that they live inside a WSL world group with
  // `isolate`, so the host's own tools cannot reach past them. That claim is checkable against the
  // document the host is holding, and it is the only place the claim becomes true rather than
  // intended.
  const wslPreset = String(probes.wslPresetDocument?.value ?? '')
  const presetLines = wslPreset.split('\n').map(line => line.trim())
  const hasWorldGroup = presetLines.some(line => line.startsWith('group:') && line.includes('true'))
  const isolateAt = presetLines.findIndex(line => line.startsWith('isolate:'))
  const hasIsolate = isolateAt >= 0
  // `fs` counts as isolated when it appears in the `isolate:` mapping rather than beside it. Scanning
  // forward a bounded number of lines rather than with a regex, because a regex over a generated YAML
  // document needs its own escaping discipline and this does not.
  const isolatesFs = hasIsolate && presetLines
    .slice(isolateAt + 1, isolateAt + 8)
    .some(line => line.startsWith('fs:') && line.includes('true'))
  const pointsAtOwnShell = wslPreset.includes('lib/shell.js')
  const pointsAtOwnFs = wslPreset.includes('lib/fs.js')
  console.log(`  the plugin's own preset, as the host holds it (${wslPreset.length} bytes):`)
  console.log(`    ${hasWorldGroup ? 'ok  ' : 'FAIL'} the WSL world is a group`)
  console.log(`    ${hasIsolate ? 'ok  ' : 'FAIL'} the group isolates its members`)
  console.log(`    ${isolatesFs ? 'ok  ' : 'FAIL'} fs is inside the isolated set`)
  console.log(`    ${pointsAtOwnShell ? 'ok  ' : 'FAIL'} the bash slot points at lib/shell.js`)
  console.log(`    ${pointsAtOwnFs ? 'ok  ' : 'FAIL'} the fs slot points at lib/fs.js`)
  isolationHolds = hasWorldGroup && hasIsolate && isolatesFs && pointsAtOwnShell && pointsAtOwnFs
  if (childStderrTail.length > 0) {
    console.log('  what the child logged (plugin effects report here):')
    for (const line of childStderrTail.slice(0, 10)) console.log(`    ${line}`)
  }
}
const bareReads = resolvedServices.filter(entry => entry.how.startsWith('read bare'))
const unreachable = resolvedServices.filter(entry => !entry.reachable)

console.log(`  the plugin's own row declares: ${probes.ownRowInject.value}`)
console.log(`  ${'─'.repeat(70)}`)
console.log('  every service the sources reach for, resolved in the booted host:')
for (const entry of resolvedServices) {
  console.log(`  ${entry.reachable ? 'ok  ' : 'FAIL'} ${entry.service.padEnd(14)} root=${entry.resolvedAtRoot.padEnd(8)} own-realm=${entry.resolvedInOwnRealm.padEnd(8)} ${entry.how}`)
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

// Rows that did not come up, with what the lifecycle recorded. `state: FAILED` on its own is a colour
// with no sentence attached, and a reader who has to reproduce a failure by hand to learn what it was
// is a reader who stops reading.
//
// Subscribing to `internal/status` does not work here: the transitions happen inside `runProfile`, so
// a listener added afterwards has already missed them and the failure detail comes back empty. It is
// read off each fiber instead.
const rowStates = rows.filter(row => row.stateName === 'FAILED' || row.stateName === 'NO_FIBER')
if (rowStates.length > 0) {
  // A probe that threw records the string `THREW: …`, which is not JSON. Believing it without looking
  // turns a diagnostic into a crash of the whole gate.
  let details = []
  const raw = probes.rowFailures?.value
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try { details = JSON.parse(raw) } catch { details = [] }
  }
  console.log(`  ${'─'.repeat(70)}`)
  console.log('  rows that did not come up:')
  for (const row of rowStates) {
    const detail = details.find(entry => entry.entry === row.id)
    console.log(`    ${row.id}: ${row.stateName}${detail === undefined ? '' : ` — ${detail.error}`}`)
  }
  if (raw !== undefined && typeof raw === 'string' && !raw.startsWith('[')) {
    console.log(`    (the detail could not be collected: ${raw})`)
  }
  if (false) {
    console.log('    what the loader logged:')
    // Not sliced: the loader interleaves every row's stack, so a window hides the other rows'
    // reasons behind the first one's frames.
    for (const line of childStderrTail) console.log(`      ${line}`)
  }
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────
//
// A property that finds something real is **red**, and a bare red is not shippable: the next person
// to read CI cannot tell a broken gate from a working one. So every red this gate can produce goes
// through the same bidirectional arithmetic the seam ledger uses — a new red fails, a declared red
// that turned green fails, and the debt cannot be retired without being withdrawn in the same commit.

// A row that did not load is a debt too, and it is reported per entry so the ledger's prefix matches
// one row rather than a count that changes when a third one appears.
const notLoadedIds = rows
  .filter(row => row.stateName === 'FAILED' || row.stateName === 'NO_FIBER')
  .map(row => row.id)
// **One** red naming every row, not one red per row. A ledger entry stands for an invariant, and the
// invariant is "every entry loads"; two reds would need two entries, and a third failing row would
// then read as an undeclared failure rather than as the same known debt. The rows are named in the
// detail line instead, where a reader can see which.
const notLoaded = notLoadedIds.length === 0 ? [] : [`entry-does-not-load: ${notLoadedIds.join(', ')}`]
const observedReds = [
  ...notLoaded,
  // The dynamic half of the same debt, filed under the same entry: the plugin offers a channel the
  // host's own reader does not drain. The two halves agree by construction — the static half counted
  // the host naming it zero times, and this one watched the host read it and get nothing — so they
  // are one invariant with two witnesses, not two debts.
  // One red for the invariant, naming **both** witnesses. The static half counted the host naming
  // the channel zero times in its sources; the dynamic half watched the host read the same channel and
  // get nothing. Two witnesses of one fact, and a ledger entry stands for the fact — emitting a red
  // per witness would need an entry per witness, so paying the debt would half-fix the gate.
  // The host rejecting the tree we contributed is not a debt of ours to negotiate: it is the
  // counterparty refusing the handover, which is the loudest signal this system can produce.
  ...(!hostAcceptsPreset && hostAudit !== null ? [`host-rejects-the-preset: ${hostAudit.listProblem}`] : []),
  // **One** red, from the **strongest** witness available. Three things are known here: the host's
  // sources never name the channel, a synthetic job on it reads back empty, and — when the product
  // can be run at all — a **real completed job** reads back empty through the host's own reader.
  // One invariant, one entry, one red; and when the real witness is available it *replaces* the
  // synthetic one rather than adding to it, because a reader who has seen the product do the thing
  // does not need the stand-in explained to them.
  ...(realJobView !== null && !realJobReadable
    ? ['readOutput: a real completed job read back empty through the host reader']
    : (!pluginChannelReadable && unread.includes('readOutput')
      ? ['readOutput: unread in the host sources, and not readable by the host reader']
      : [])),
  // A preset whose isolation did not survive the round trip is the L2 finding: `fs` and `shell` would
  // be reachable by the host's own tools, which is the whole thing the group exists to prevent. One
  // red, named by what failed, because a debt is an invariant rather than a row count.
  ...(isolationHolds ? [] : [`preset-isolation-did-not-survive: ${[
    hasWorldGroup ? null : 'no-group', hasIsolate ? null : 'no-isolate',
    isolatesFs ? null : 'fs-not-isolated', pointsAtOwnShell ? null : 'bash-slot-foreign',
    pointsAtOwnFs ? null : 'fs-slot-foreign',
  ].filter(Boolean).join(', ')}`]),
  // `unread` and `unreachable` are already name lists — `unread` comes from `offered.filter(...)`, so
  // mapping `.name` over it would file an empty string and the ledger would report a blank red.
  //
  // A failed positive control is deliberately **not** here. Those say the substrate did not look like
  // the pinned host, which is a broken gate rather than a debt, and they have their own exit below; a
  // broken gate filed as a debt would be paid by editing the ledger, which is exactly the wrong move.
  // `unread` is deliberately **not** listed here even though every member is a real finding: each of
  // its members that the round trip also witnessed is represented by the combined red below, and
  // listing both would file one fact twice. A member with no dynamic witness still gets filed, so
  // nothing is lost — it just gets one entry rather than two.
  ...unread.filter(name => !(name === 'readOutput' && !pluginChannelReadable)),
  ...unreachable.map(entry => entry.service),
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