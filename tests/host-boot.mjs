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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const outcome = await runChild({ DSH_HOME: home }, { profile: PROFILE, patchFiles: [overlay] })
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

const failed = checks.filter(([, ok]) => !ok)
if (failed.length > 0) {
  console.error(`\nhost-boot: RED — ${failed.length} positive control(s) failed. The substrate did not`)
  console.error('  look like the pinned host, so nothing downstream can be trusted.')
  process.exit(1)
}
console.log('\nhost-boot: GREEN — 7/7 positive controls; the substrate is the pinned host.')
process.exit(0)