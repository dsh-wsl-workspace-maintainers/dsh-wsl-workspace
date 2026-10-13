/**
 * Whose `confine()` does `run_code` reach? (issue #78)
 *
 * #78's symptom is one line: in a `wsl-*` variant session the host's `run_code` (PTC) tool fails at
 * worker start with `GetNamedSecurityInfoW failed (Win32 1): \\wsl.localhost\…` under
 * `workspace-write`. This repository owns a no-op sandbox provider (`src/host/wsl-sandbox.ts:27-44`)
 * whose header already explains why the Windows runner cannot describe a Linux path — and already
 * admits that "this plugin's bash tool has never gone through" that seam. No gate here ever calls
 * `confine()`: the only `confine` hits under `tests/` live inside a string-level assertion in
 * `tests/variants.test.ts`. So the fix hangs on a fact nobody had measured: **which provider does
 * `sandbox` resolve to inside the PTC provider's own scope?** Plain scope resolution, not a registry —
 * which means it can be read off a real host boot.
 *
 * What this probe does, in ONE real host profile boot (`runProfile`, the only harness that boots a
 * real host profile — see `tests/support/w51-probe.mjs`):
 *
 *   · mounts the host's own sandbox armature with the row names the shipped roster uses
 *     (`@deepseek-ai/dsh-base/cordis.patch.yml:226-230` provides `sandbox` and `sandbox-policy`,
 *     `:390-391` mounts `ptc-runtime` at the SAME top level), and reads which module answers
 *     `this.ctx.sandbox` at the scope the `ptc-runtime` entry occupies — the exact expression at
 *     `@deepseek-ai/dsh-ptc-runtime-node/lib/index.js:950-953`;
 *   · mounts THIS plugin through the Loader (an overlay row naming `<repoRoot>/lib/index.js`) and
 *     re-reads it, then calls `confine()` for real on our own provider;
 *   · mounts the `wsl-ptc` world our own generator emitted — text produced by
 *     `transformPresetForWsl(...)` from the release's shipped `ptc` preset composition, written to a
 *     scratch file and loaded from there, never hand-written — and compares realm symbols;
 *   · walks the Windows ACL arm with a UNC policy root and reports the exact error text;
 *   · flips the single token that makes our world isolate `sandbox` and re-reads, so the realm row is
 *     an instrument rather than a description.
 *
 * Deliberately NOT done here, because it would be a guess printed as a reading: no distribution is
 * started, nothing is spawned (`confine` only wraps argv, and the wrapped argv is never executed), no
 * Windows process is created. Rows that cannot be observed without a running instance say
 * `not observed — needs …` and the verdict carries that.
 *
 * One harness seam is declared rather than hidden: this plugin's `apply()` injects `webServer`
 * (`src/index.ts:1011`), so a 2-line stub is provided to let it construct. Its variant-generation
 * branch — the only branch in this plugin that can reach `wsl.exe` — runs only when a preset roster
 * service is present (`src/index.ts:1050`), and row 1 asserts that it was not.
 *
 *   node tests/support/w78-confine-probe.mjs
 *
 * @module tests/support/w78-confine-probe
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const at = (p) => pathToFileURL(p).href

/**
 * Resolve a host package by path, never by bare specifier.
 *
 * A bare import of a host package resolves against the *importing* module's real path, which on this
 * repository is a junction into `ci/deps` — it passes on a maintainer machine and fails on a CI runner
 * whose tree was installed differently. That is how #78's own predecessor got bitten (see the note at
 * the top of `tests/support/w51-probe.mjs`), so every host read below goes through this function.
 * @param name - the package name, or `package/subpath`.
 * @param file - the file inside it; the host packages all publish `lib/index.js`.
 * @returns the absolute path, or null when neither root carries it.
 */
const host = (name, file = 'lib/index.js') => {
  for (const root of [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]) {
    const candidate = join(root, ...name.split('/'), file)
    if (existsSync(candidate)) return candidate
  }
  return null
}
const hostModule = (m) => m.default ?? m

/** A promise that is not allowed to hang the gate (the `tests/support/w51-probe.mjs` pattern). */
const within = (promise, ms, label) => {
  let timer
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

const report = (rows, verdict) => {
  console.log(JSON.stringify({ verdict, rows }, null, 2))
  // The verdict in prose the seam runner can actually read. `run-seams` builds its line out of
  // `PASSED` / `FAILED (N failing)` / TAP counts; a probe whose answer nobody can parse looks exactly
  // like a probe that passed, so the string is emitted in that vocabulary and not only as JSON.
  const failing = rows.filter(row => row.ok === false).length
  console.log(failing === 0
    ? `W78-CONFINE-PROBE PASSED (${rows.length} rows — #78's ownership reading)`
    : `W78-CONFINE-PROBE FAILED (${failing} failing)`)
  process.exit(failing === 0 ? 0 : 1)
}

if (process.platform !== 'win32') {
  // Every row below reads a win32-only seam (the ACL runner chain, the UNC form). Anywhere else the
  // honest answer is that the instrument does not run, not that it passed — and it is said in the one
  // vocabulary this repository's seam ledger reads. Exiting non-zero with no line to register used to
  // look like a pass to `run-seams` (frame 38350052793 was green over exactly that); a `SKIP:` is
  // counted and reported, which is the difference between "not measured here" and "not measured".
  console.error(`SKIP: w78-confine-probe — platform cannot answer it here (${process.platform} has no `
    + 'Windows ACL runner, no `SetNamedSecurityInfoW` chain, and no `\\\\wsl.localhost\\…` spelling to feed it)')
  console.log('W78-CONFINE-PROBE PASSED (1 skipped — a skip is not a pass): the #78 ownership reading is a win32 measurement')
  process.exit(0)
}

// Scratch lives outside the worktree, always: the generated composition, the profile home the boot
// writes into, and the overlay are artifacts of a measurement, not files anybody should find in `lib/`.
// It is `node:os`'s temp dir rather than a Windows literal because the ubuntu runner has no `D:` — a
// literal there is not an error, it is a directory named `D:` created inside the checkout.
const scratchRoot = process.env.W78_SCRATCH_DIR ?? join(tmpdir(), 'dsh-w78-confine-probe')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'w78-confine-probe-'))

// A ref'd watchdog: every await below is bounded by an unref'd timer, which is exactly what lets the
// loop drain while a promise is still pending — and a drained loop exits 0 silently. That is a probe
// reporting success about nothing, so this one timer keeps the process alive and forces a loud code.
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ verdict: 'NOT-MEASURED — watchdog fired before the probe reached its report' }))
  process.exit(3)
}, 240_000)

/** The distribution spelled into the UNC policy root. Never queried: `wsl.exe -l` is a spawn. */
const DISTRO = process.env.DSH_WSL_DISTRO ?? 'Ubuntu'
const UNC_ROOT = `\\\\wsl.localhost\\${DISTRO}\\home\\coder\\repo`
const HARMLESS_ARGV = ['cmd.exe', '/c', 'whoami']

const missing = name => `${name}: not present in either node_modules root`

try {
  const profileBootPath = host('@deepseek-ai/dsh', 'lib/profile-boot.js')
  const launchEnvPath = host('@deepseek-ai/dsh-launch-environment')
  const cordisPath = host('@deepseek-ai/cordis')
  const sandboxLocalPath = host('@deepseek-ai/dsh-sandbox-local')
  const sandboxBasePath = host('@deepseek-ai/dsh-sandbox')
  const jsYamlPath = host('js-yaml', 'dist/js-yaml.mjs')
  const ptcPresetPatchPath = host('@deepseek-ai/dsh-web-app', 'presets/ptc.patch.yml')
  for (const [label, value] of [['@deepseek-ai/dsh profile-boot', profileBootPath],
    ['@deepseek-ai/dsh-launch-environment', launchEnvPath], ['@deepseek-ai/cordis', cordisPath],
    ['@deepseek-ai/dsh-sandbox-local', sandboxLocalPath], ['@deepseek-ai/dsh-sandbox', sandboxBasePath],
    ['js-yaml', jsYamlPath], ['@deepseek-ai/dsh-web-app preset patch', ptcPresetPatchPath]]) {
    if (value === null) throw new Error(`${missing(label)}`)
  }

  const { runProfile } = await import(at(profileBootPath))
  const { createLaunchEnvironmentSnapshot } = await import(at(launchEnvPath))
  const { Context } = hostModule(await import(at(cordisPath)))
  const LocalSandboxProvider = hostModule(await import(at(sandboxLocalPath)))
  const SandboxProvider = hostModule(await import(at(sandboxBasePath)))
  const jsYaml = hostModule(await import(at(jsYamlPath)))
  const ourSandboxPath = join(repoRoot, 'lib', 'wsl-sandbox.js').replace(/\\/g, '/')
  const WslSandboxProvider = hostModule(await import(at(ourSandboxPath)))
  const ISOLATE = Context.isolate ?? Symbol.for('cordis.isolate')

  const rows = []
  const add = (id, ok, detail, extra) => rows.push({ id, ok, detail, ...extra })

  // ── the generated `wsl-ptc` composition: OUR generator, the release's own preset as input ──
  // `src/index.ts:936` feeds `transformPresetForWsl` the composition the roster reads back for one
  // preset. The roster needs a full app boot, so the input here is the release's shipped preset
  // document (`<dsh-web-app>/presets/ptc.patch.yml`), whose `config.plugins:` block IS that
  // composition; it is dedented by a constant amount and otherwise kept line-for-line.
  const patchLines = readFileSync(ptcPresetPatchPath, 'utf8').split('\n')
  const pluginsAt = patchLines.findIndex(l => /^ +plugins:\s*$/.test(l))
  if (pluginsAt < 0) throw new Error(`${ptcPresetPatchPath}: no plugins: block`)
  const pluginsIndent = /^(\s*)/.exec(patchLines[pluginsAt + 1])[1].length
  let pluginsEnd = patchLines.length
  for (let i = pluginsAt + 1; i < patchLines.length; i++) if (/^[A-Za-z]/.test(patchLines[i])) { pluginsEnd = i; break }
  const sourceComposition = patchLines.slice(pluginsAt + 1, pluginsEnd)
    .map(l => l.replace(new RegExp(`^ {${pluginsIndent}}`), '')).join('\n').replace(/\n+$/, '\n')
  const { transformPresetForWsl } = await import(at(join(repoRoot, 'src', 'host', 'variants.ts')))
  const libPath = f => join(repoRoot, 'lib', f).replace(/\\/g, '/')
  // The session tier, which is what `src/index.ts:1084` picks unless DSH_WSL_PTY_SHELL=1: the
  // persistent shell is the only reason the world claims the `sandbox` capability at all
  // (`src/host/variants.ts:225`). Whether a real host gets a persistent shell at all is decided by a
  // probe that needs a running distribution, so both arms of that choice are reported, not assumed.
  const persistent = {
    relayPath: libPath('wsl-relay.js'), nodePath: process.execPath.replace(/\\/g, '/'),
    sandboxPath: ourSandboxPath, bashPath: libPath('wsl-bash-tool.js'),
    terminalTool: libPath('wsl-terminal-tool.js'), mode: 'session',
  }
  const generated = transformPresetForWsl(sourceComposition, libPath('shell.js'), libPath('fs.js'),
    persistent, libPath('wsl-search.js'), libPath('wsl-jobs.js'))
  const generatedFile = join(scratch, 'wsl-ptc.composition.yml')
  writeFileSync(generatedFile, generated, 'utf8')
  const generatedLines = readFileSync(generatedFile, 'utf8').split('\n')
  const worldAt = generatedLines.findIndex(l => l === '- id: wsl-world')
  if (worldAt < 0) throw new Error(`${generatedFile}: the generator emitted no wsl-world group`)
  const worldGroupText = generatedLines.slice(worldAt).join('\n').replace(/\n+$/, '')
  // The Loader's own row objects, parsed back out of the emitted text rather than re-typed here.
  const worldGroupOptions = jsYaml.load(worldGroupText)[0]

  // ── the boot: the roster's own row names for the sandbox armature, plus our plugin and world ──
  const home = mkdtempSync(join(scratch, 'home-'))
  const profile = 'w78confine'
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  writeFileSync(join(home, 'profiles', profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-w78confine', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  const overlay = join(home, 'overlay.yml')
  writeFileSync(overlay, [
    '- insert:',
    '    - id: subprocess-local',
    '      name: "@deepseek-ai/dsh-subprocess-local"',
    '    - id: fs-local',
    '      name: "@deepseek-ai/dsh-fs-local"',
    '    - id: session-projection',
    '      name: "@deepseek-ai/dsh-session-projection"',
    '    - id: sandbox-policy',
    '      name: "@deepseek-ai/dsh-sandbox-policy"',
    '      config:',
    '        mode: workspace-write',
    `        workspaceRoot: "${repoRoot.replaceAll('\\', '\\\\')}"`,
    '    - id: sandbox',
    '      name: "@deepseek-ai/dsh-sandbox-local"',
    '    - id: ptc-runtime',
    '      name: "@deepseek-ai/dsh-ptc-runtime-node"',
    '    - id: dsh-wsl-workspace',
    `      name: '${libPath('index.js')}'`,
    ...worldGroupText.split('\n').map(l => (l === '' ? '' : `    ${l}`)),
    '',
  ].join('\n'), 'utf8')

  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const { ctx, shutdown } = await within(runProfile({ environment, profile, patchFiles: [overlay], args: [] }),
    150_000, 'profile boot')
  const loader = ctx.get('loader')
  await within(loader.await(), 60_000, 'loader settle')

  const entries = () => [...loader.entries()]
  const entryOf = (id, parent) => entries().find(e => e.options.id === id
    && (parent === undefined || (e.parent?.ctx?.fiber?.entry?.options?.id ?? 'root') === parent))  /** Read the provider one scope resolves for `sandbox`, the way cordis itself does it. */
  const resolveSandbox = (ectx) => {
    const key = ectx?.[ISOLATE]?.sandbox
    const impl = key === undefined ? undefined : ectx.reflect.store[key]
    return { realm: key === undefined ? 'none' : String(key), provider: impl?.value, state: impl?.fiber?.state }
  }
  const identity = (provider) => provider === undefined ? {
    constructor: 'none',
    instanceofLocalSandboxProvider: false,
    instanceofWslSandboxProvider: false,
    instanceofSandboxProvider: false,
  } : {
    constructor: provider.constructor?.name,
    instanceofLocalSandboxProvider: provider instanceof LocalSandboxProvider,
    instanceofWslSandboxProvider: provider instanceof WslSandboxProvider,
    instanceofSandboxProvider: provider instanceof SandboxProvider,
  }

  // ── (0) the plain host boot ────────────────────────────────────────────────────────────────
  // The PTC provider cannot be constructed in THIS closure: `@deepseek-ai/dsh-ptc-runtime` is a declared
  // peer of `dsh-ptc-runtime-node` (`<…>/dsh-ptc-runtime-node/package.json → peerDependencies`) and is
  // in neither node_modules root, so the Loader reports the row as `failed to import`. The reading
  // therefore comes from the scope that row occupies — `entry.ctx` is the context the runtime would be
  // constructed in, and `this.ctx.sandbox` at index.js:950 dereferences exactly this store slot.
  let ptcClassError = null
  const ptcPath = host('@deepseek-ai/dsh-ptc-runtime-node')
  if (ptcPath === null) ptcClassError = missing('@deepseek-ai/dsh-ptc-runtime-node')
  else try { await import(at(ptcPath)) } catch (error) { ptcClassError = String(error?.message ?? error) }
  const ptcEntry = entryOf('ptc-runtime')
  const ptcScope = ptcEntry === undefined ? { realm: 'no entry', provider: undefined } : resolveSandbox(ptcEntry.ctx)
  const ptcIdentity = identity(ptcScope.provider)
  add('0-provider-in-plain-host-boot', ptcIdentity.constructor === 'LocalSandboxProvider'
    && ptcIdentity.instanceofLocalSandboxProvider === true && ptcScope.realm === 'Symbol(sandbox)',
    `run_code's own scope resolves sandbox to ${JSON.stringify(ptcIdentity)} at realm ${ptcScope.realm}`
      + `; the module behind it is ${sandboxLocalPath} (imported by path, matched with instanceof, not by name)`
      + `; the root scope answers the same: ${JSON.stringify(identity(resolveSandbox(ctx).provider))}`,
    {
      ptcScopeRealm: ptcScope.realm,
      ptcScopeConstructor: ptcIdentity.constructor,
      resolvedModulePath: sandboxLocalPath,
      ptcRuntimeClassLoaded: ptcClassError === null,
      ptcRuntimeClassBlocker: ptcClassError,
    })

  // ── (1) with this plugin mounted through the Loader ────────────────────────────────────────
  // `apply()` injects `webServer` (src/index.ts:1011), which the host half of the app provides; a stub
  // stands in so the plugin can construct. `agentPresets` is deliberately NOT mounted: the branch that
  // would generate variants — this plugin's only path to `wsl.exe` (src/index.ts:1050, 1071-1147) — is
  // behind that service, so its absence is asserted below rather than assumed.
  const rosterBefore = ctx.get('agentPresets') ?? ctx.get('agent-preset')
  let routeRegistrations = 0
  ctx.provide('webServer', {
    register: () => { routeRegistrations += 1; return () => {} },
  }, () => true)
  await within(loader.await(), 30_000, 'loader settle after webServer seam')
  const ourEntry = entryOf('dsh-wsl-workspace')
  const scopeAfterPlugin = resolveSandbox(ptcEntry.ctx)
  const identityAfterPlugin = identity(scopeAfterPlugin.provider)
  const rootStillOurs = (() => {
    // Did mounting the plugin install a provider for the root realm? Read who owns the store slot and
    // compare with the fiber of the overlay row that names the host package — fiber identity, not name.
    const key = ctx[ISOLATE]?.sandbox
    const impl = key === undefined ? undefined : ctx.reflect.store[key]
    const hostRow = entryOf('sandbox')
    return {
      fiberUid: impl?.fiber?.uid ?? null,
      ownedByHostSandboxRow: !!hostRow && impl?.fiber === hostRow.fiber,
    }
  })()
  add('1-provider-with-our-plugin-mounted',
    identityAfterPlugin.constructor === ptcIdentity.constructor && ourEntry !== undefined
      && rosterBefore === undefined && rootStillOurs.ownedByHostSandboxRow === true,
    `our plugin mounted as an overlay row naming ${libPath('index.js')}: activated=${!!ourEntry?.fiber},`
      + ` route registrations=${routeRegistrations}; run_code's scope still resolves`
      + ` ${JSON.stringify(identityAfterPlugin)} at realm ${scopeAfterPlugin.realm}; the root \`sandbox\``
      + ` slot is owned by the host sandbox row's fiber (uid=${String(rootStillOurs.fiberUid)},`
      + ` same fiber=${String(rootStillOurs.ownedByHostSandboxRow)}), so this plugin contributes no provider`
      + ` outside its own realm; the preset roster service was absent (${String(rosterBefore)}), so the`
      + ` variant-generation branch — this plugin's only path to wsl.exe — never ran`,
    {
      pluginActivated: !!ourEntry?.fiber,
      providerAfterMount: identityAfterPlugin,
      rootSlotOwner: rootStillOurs,
      presetRosterPresent: rosterBefore !== undefined,
    })

  // ── (1b) confine() called for real, on the provider our world mounted ──────────────────────
  // The row that replaces `tests/variants.test.ts`'s string assertion: not "the source says partial",
  // but "the object the realm hands a consumer returns this". No process is spawned: confine wraps argv.
  const worldEntry = entryOf('wsl-world')
  const inGroupConsumer = entryOf('fs-wsl', 'wsl-world')
  const realmProvider = inGroupConsumer === undefined ? undefined : inGroupConsumer.ctx.get('sandbox')
  let ourConfined = null
  let ourConfineError = null
  try {
    ourConfined = await within(Promise.resolve(realmProvider.confine(HARMLESS_ARGV,
      { mode: 'workspace-write', workspaceRoot: UNC_ROOT })), 20_000, 'our confine')
  } catch (error) { ourConfineError = String(error?.message ?? error) }
  add('1b-our-confine-called-for-real', ourConfined !== null && ourConfined.enforcement === 'partial'
    && Array.isArray(ourConfined.denialSignatures) && ourConfined.denialSignatures.length === 0
    && Array.isArray(ourConfined.runnerFailureRules) && ourConfined.runnerFailureRules.length === 0
    && JSON.stringify(ourConfined.argv) === JSON.stringify(HARMLESS_ARGV),
    ourConfined === null
      ? `confine threw: ${ourConfineError}`
      : `the provider mounted inside our world (${realmProvider?.constructor?.name}) returned argv`
        + ` ${JSON.stringify(ourConfined.argv)} for input ${JSON.stringify(HARMLESS_ARGV)},`
        + ` enforcement=${JSON.stringify(ourConfined.enforcement)},`
        + ` denialSignatures=${JSON.stringify(ourConfined.denialSignatures)},`
        + ` runnerFailureRules=${JSON.stringify(ourConfined.runnerFailureRules)} (argv never executed)`,
    { returned: ourConfined, threw: ourConfineError })

  // ── (2) the realm row our generator emits, and who stands on which side of it ──────────────
  // The emitted lines this row reports are contiguous slices of the generated file: the group's header
  // through its `isolate:` block, and the `sandbox-wsl` row with its name line.
  const headerEnd = generatedLines.findIndex((l, i) => i > worldAt && l === '  config:')
  const sandboxRowAt = generatedLines.findIndex((l, i) => i > worldAt && l === '    - id: sandbox-wsl')
  const emitted = [
    ...generatedLines.slice(worldAt, headerEnd + 1),
    '  …',
    ...generatedLines.slice(sandboxRowAt, sandboxRowAt + 2),
  ]
  const ptcRowInGenerated = /(^|\n)- id: ptc-runtime\b/.test(generated)
  const worldScope = resolveSandbox(worldEntry?.ctx)
  const worldIdentity = identity(worldScope.provider)
  add('2-realm-row-and-membership', worldScope.realm === 'Symbol(sandbox#wsl-world)'
    && worldIdentity.instanceofWslSandboxProvider === true && ptcRowInGenerated === false
    && ptcScope.realm === 'Symbol(sandbox)',
    `generated text read back from ${generatedFile}; emitted lines:`
      + `\n${emitted.join('\n')}\n`
      + `the group's consumers resolve ${JSON.stringify(worldIdentity)} at realm ${worldScope.realm}, while`
      + ` run_code's scope sits at realm ${ptcScope.realm}: the two symbols differ, so the no-op provider`
      + ` serves only its own group and the PTC scope keeps the host's ACL chain. The generated composition`
      + ` carries no ptc-runtime row (${String(ptcRowInGenerated)}); the roster mounts it at top level`
      + ` (@deepseek-ai/dsh-base/cordis.patch.yml:390-391), beside sandbox=dsh-sandbox-local (:226-227)`,
    {
      emittedWorldLines: emitted,
      worldRealm: worldScope.realm,
      ptcScopeRealm: ptcScope.realm,
      providerInsideWorld: worldIdentity,
      ptcRowEmittedByOurGenerator: ptcRowInGenerated,
    })

  // ── (3) the UNC arm, walked by the provider run_code actually holds ────────────────────────
  const arms = []
  for (const arm of [
    ['agentless (no sessionId)', { mode: 'workspace-write', workspaceRoot: UNC_ROOT }],
    ['session (sessionId set)', { mode: 'workspace-write', workspaceRoot: UNC_ROOT, sessionId: 'w78-confine-probe' }],
    ['read-only', { mode: 'read-only', workspaceRoot: UNC_ROOT, sessionId: 'w78-confine-probe-ro' }],
    ['session on a plain Windows root (control)', {
      mode: 'workspace-write', workspaceRoot: process.env.SystemRoot ?? 'C:\\Windows', sessionId: 'w78-confine-probe-plain',
    }],
  ]) {
    const [label, policy] = arm
    let outcome
    try {
      const confined = await within(ptcScope.provider.confine(HARMLESS_ARGV, policy), 20_000, `confine ${label}`)
      outcome = { threw: false, argv0: confined.argv[0], wrapped: confined.argv.slice(0, 6), enforcement: confined.enforcement }
    } catch (error) {
      outcome = {
        threw: true, name: String(error?.name), code: String(error?.code),
        message: String(error?.message ?? error).split('\n')[0].slice(0, 200),
      }
    }
    arms.push({ arm: label, policyMode: policy.mode, ...outcome })
  }
  const uncSessionArm = arms.find(a => a.arm === 'session (sessionId set)')
  const controlArm = arms.find(a => a.arm.endsWith('(control)'))
  const win32One = arms.some(a => a.threw && /GetNamedSecurityInfoW failed \(Win32 1\)/i.test(a.message ?? ''))
  // What this row declares: the provider on run_code's own scope must fail on a UNC policy root (or
  // hand back an argv that confines nothing) rather than silently claim full enforcement — and if the
  // exact Win32 text did not appear, the control arm has to prove the ACL chain is live on this
  // machine, or a broken substrate would read as a green row.
  add('3-unc-arm', win32One ? uncSessionArm?.threw === true
    : uncSessionArm?.threw === true && controlArm?.threw === true,
    `the provider on run_code's own scope, given a \\wsl.localhost policy root: `
      + `${JSON.stringify(arms, null, 1)}`
      + (win32One ? ' — the issue text reproduced here.'
        : ' — not observed: the exact `GetNamedSecurityInfoW failed (Win32 1)` needs the distribution'
          + ' running, because the UNC 9P path must exist for realpath to resolve before the ACL read is'
          + ' attempted. Here the session arm fails one step earlier, so this reading rules out that the'
          + ' provider is ours or that the ACL chain is absent, and rules IN the ACL chain being reached'
          + ' from run_code’s scope and dying on the UNC root; it does not rule in Win32 code 1 as the'
          + ' first failure on a live instance.'),
    {
      reproducedWin32One: win32One,
      sessionArmError: uncSessionArm?.message,
      controlArmThrew: controlArm?.threw,
      controlArmError: controlArm?.message,
    })

  // ── (4) mutation control: flip the one token, re-read row 2 ─────────────────────────────────
  // The single token is the `sandbox: true` line inside the generated group's `isolate:` block
  // (src/host/variants.ts:225). It is flipped in memory on the live entry — the generated file on disk
  // is not touched — and the same reads are taken again.
  const mutated = structuredClone(worldGroupOptions)
  mutated.isolate.sandbox = false
  let realmAfter = { realm: 'not reached', provider: undefined }
  let rootAfter = { realm: 'not reached', provider: undefined }
  let mutationError = null
  if (worldEntry === undefined) mutationError = 'the wsl-world group entry is not in the mounted tree'
  else try {
    await within(worldEntry.update(mutated, false, true), 60_000, 'group update')
    await within(loader.await(), 60_000, 'loader settle after mutation')
    const consumerAfter = entryOf('fs-wsl', 'wsl-world')
    realmAfter = resolveSandbox(consumerAfter?.ctx)
    rootAfter = resolveSandbox(ctx)
  } catch (error) { mutationError = String(error?.message ?? error).split('\n')[0] }
  const identityAfter = identity(realmAfter.provider)
  const rootIdentityAfter = identity(rootAfter.provider)
  add('4-mutation-control', mutationError === null
    && identityAfter.constructor !== worldIdentity.constructor
    && rootIdentityAfter.instanceofLocalSandboxProvider === true,
    mutationError !== null
      ? `not observed — the token was flipped but the update did not complete: ${mutationError}`
      : `flipping isolate.sandbox true→false moved the in-world consumer from`
        + ` ${JSON.stringify(worldIdentity)} at realm ${worldScope.realm} to`
        + ` ${JSON.stringify(identityAfter)} at realm ${realmAfter.realm}, while the host scope stayed`
        + ` ${JSON.stringify(rootIdentityAfter)} at ${rootAfter.realm}: the row responds to its input, so`
        + ` row 2 is a measurement and not a description.`
        + (win32One ? '' : ' The PTC scope is unchanged by the flip, which is the point: the realm never'
          + ' contained run_code to begin with.'),
    {
      before: { realm: worldScope.realm, provider: worldIdentity },
      after: { realm: realmAfter.realm, provider: identityAfter },
      hostScopeAfter: { realm: rootAfter.realm, provider: rootIdentityAfter },
      mutationError,
    })

  await within(typeof shutdown === 'function' ? shutdown() : Promise.resolve(), 30_000, 'shutdown')
  clearTimeout(watchdog)
  report(rows, win32One
    ? 'W78-ANSWERED — run_code 向宿主的 @deepseek-ai/dsh-sandbox-local（win32 = windows-acl runner）要 confine，'
      + '本插件的 no-op 只在 wsl-world 的 realm 内服务自己组的消费者；Win32 1 已在本机复现'
    : 'W78-ANSWERED-IDENTITY-ONLY — run_code 向宿主的 @deepseek-ai/dsh-sandbox-local（win32 = windows-acl runner）'
      + '要 confine，本插件的 no-op 只在 wsl-world 的 realm 内服务自己组的消费者；Win32 1 那一发本机未复现'
      + '（realpath 先于 ACL 读取失败，需要目标发行版真的在跑），见 3-unc-arm 的 not-observed 说明')
} catch (error) {
  clearTimeout(watchdog)
  console.log(JSON.stringify({
    verdict: 'NOT-MEASURED',
    message: String(error?.stack ?? error).split('\n').slice(0, 6).join('\n').slice(0, 1200),
  }, null, 2))
  process.exit(2)
}
