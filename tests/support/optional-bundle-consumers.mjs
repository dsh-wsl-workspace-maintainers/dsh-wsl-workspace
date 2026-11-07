// The 0.2.2-rc.1 opt-in-bundle consumers, called for real.
//
//   node --experimental-strip-types tests/support/optional-bundle-consumers.mjs
//
// #138 pinned the host at 0.2.2-rc.1 and the consumer-coverage gate derived five pairs we had never
// carried, all from three packages the umbrella newly pulls: dsh-experimental-client-ui-forge (fs,
// sandbox), dsh-experimental-forge-session (shell) and dsh-experimental-liveshare (fs, shell). The
// ledger's rule is "look before writing down"; this file is the look.
//
// What the product does, read from the release's own bundle declarations (2026-11-07): all three are
// OPTIONAL_BUNDLES in dsh-official-bundles — selected by no shipped template, offered switched off.
// forge-bundle's cordis.patch.yml mounts forge / forge-github / forge-session / worktree / tool-worktree
// at the PROFILE level, plus an `optional-forge-panel` group whose `isolate:` cuts ONLY `worktrees` —
// so forge-panel (client-ui-forge) resolves fs and sandbox from the root realm even inside that group.
// liveshare's patch mounts liveshare-share-host at the profile level. None of these rows lands inside
// the `wsl-world` isolate this plugin generates, so the live question is the rc.2 one: which provider
// does each consumer already hold, and what does its consuming path do when it runs.
//
// Two readings are deliberately weaker than a full feature run, and say so:
//   · forge-session's shell consumer is a tools/result listener; with the distribution unavailable
//     (HCS ERROR_NO_SYSTEM_RESOURCES on this machine, 2026-11-07) a real WSL bash result cannot be
//     produced, so the trigger is the host's own event shape emitted synthetically. The listener, the
//     shell.resolve and the shell.execute are the real package code; only the event source is synthetic.
//   · liveshare's fs consumer (applySourceAccess) runs only after a share publishes to a live Relay
//     (lib/index.js:1195); with no Relay it is unreachable, so that pair stays mounted-but-uncalled.
//
// The mechanical traps are rc2-consumers': one boot per arm, a real Session, the realm positive
// control, and mountedRow refusing a copy from another release.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot, hostFile, mountedRow, mountedPath, canonicalUrl, inactiveDetail } from './host-closure.mjs'
import { finish } from './report.mjs'

const row = mountedRow
const unwrap = namespace => namespace.default ?? namespace
const libPath = file => join(repoRoot, 'lib', file).replaceAll('\\', '/')

const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-w138-bundles-'))
const rows = []
const add = (id, ok, detail) => rows.push({ id, ok, detail })
let armsRun = 0
let armsFiltered = 0

const within = (promise, ms, label) => Promise.race([
  Promise.resolve(promise),
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
])

function report () {
  const partial = armsFiltered > 0
    ? `PARTIAL — W138_ONLY=${process.env.W138_ONLY} ran ${armsRun} of ${armsRun + armsFiltered} arms, not the gate's verdict`
    : ''
  finish(rows, {
    label: 'W138-OPTIONAL-BUNDLES',
    summary: ' — the 0.2.2-rc.1 opt-in-bundle consumers, called, and the realm each holds',
    metrics: { armsRun, armsFiltered },
    partial,
  })
}

if (process.platform !== 'win32') {
  console.error('SKIP: optional-bundle-consumers — the realm question is about the Windows fs/sandbox providers beside a WSL isolate; the ubuntu runner cannot answer it')
  console.log('W138-OPTIONAL-BUNDLES PASSED (1 skipped — a skip is not a pass)')
  process.exit(0)
}

const profileBoot = hostFile('@deepseek-ai/dsh', { subpath: ['lib', 'profile-boot.js'] })
const presetFile = hostFile('@deepseek-ai/dsh-web-app', { subpath: ['presets', 'standard.patch.yml'] })
if (profileBoot === null || presetFile === null) {
  add('closure', false, 'the @deepseek-ai/dsh profile-boot entry or the shipped standard preset is absent — run `node ci/install-pinned.mjs`')
  report()
  process.exit(0)
}

const { runProfile } = await import(canonicalUrl(profileBoot))
const { createLaunchEnvironmentSnapshot } = await import(canonicalUrl(hostFile('@deepseek-ai/dsh-launch-environment')))
const { Session, SESSION_FORMAT_VERSION } = await import(canonicalUrl(hostFile('@deepseek-ai/dsh-session')))
const { Context } = unwrap(await import(canonicalUrl(hostFile('@deepseek-ai/cordis'))))
const ISOLATE = Context.isolate ?? Symbol.for('cordis.isolate')

const { transformPresetForWsl } = await import(canonicalUrl(join(repoRoot, 'src', 'host', 'variants.ts')))
const preset = readFileSync(presetFile, 'utf8').split('\n')
const pluginsAt = preset.findIndex(line => /^ +plugins:\s*$/.test(line))
if (pluginsAt < 0) throw new Error('the shipped standard preset carries no plugins: block')
const indent = /^(\s*)/.exec(preset[pluginsAt + 1])[1].length
let end = preset.length
for (let i = pluginsAt + 1; i < preset.length; i += 1) if (/^[A-Za-z]/.test(preset[i])) { end = i; break }
const source = preset.slice(pluginsAt + 1, end).map(line => line.replace(new RegExp(`^ {${indent}}`), '')).join('\n')
const persistent = {
  relayPath: libPath('wsl-relay.js'), nodePath: process.execPath.replaceAll('\\', '/'),
  sandboxPath: libPath('wsl-sandbox.js'), bashPath: libPath('wsl-bash-tool.js'),
  terminalTool: libPath('wsl-terminal-tool.js'), mode: 'session',
}
const generated = transformPresetForWsl(source, libPath('shell.js'), libPath('fs.js'), persistent,
  libPath('wsl-search.js'), libPath('wsl-jobs.js'))
const generatedLines = generated.split('\n')
const worldAt = generatedLines.findIndex(line => line === '- id: wsl-world')
if (worldAt < 0) throw new Error('the generator emitted no wsl-world group')
const worldText = generatedLines.slice(worldAt).join('\n')
const worldRows = () => worldText.split('\n').filter(line => line.trim() !== '').map(line => `    ${line}`)

/** A scratch git repo with one empty commit and a second branch, on the Windows filesystem. */
function scratchRepo (tag) {
  const repo = mkdtempSync(join(SCRATCH, `gitrepo-${tag}-`))
  const git = (...args) => spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'w138', GIT_AUTHOR_EMAIL: 'w138@local',
      GIT_COMMITTER_NAME: 'w138', GIT_COMMITTER_EMAIL: 'w138@local',
    },
  })
  const init = git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'seed')
  git('branch', 'w138-probe-branch')
  if (init.status !== 0) throw new Error(`git init failed on this machine: ${String(init.stderr).slice(0, 120)}`)
  return repo.replaceAll('\\', '/')
}
const FORGE_REPO = scratchRepo('forge')

/** The profile-level rows every arm shares, with the sandbox policy the arm needs. */
function profileRows (mode, workspaceRoot) {
  return [
    ...row('system-prompt', '@deepseek-ai/dsh-system-prompt'),
    ...row('tools', '@deepseek-ai/dsh-tools'),
    ...row('subprocess-local', '@deepseek-ai/dsh-subprocess-local'),
    ...row('fs-local', '@deepseek-ai/dsh-fs-local'),
    ...row('session-projection', '@deepseek-ai/dsh-session-projection'),
    `    - id: sandbox-policy`,
    `      name: '${mountedPath('@deepseek-ai/dsh-sandbox-policy')}'`,
    '      config:',
    `        mode: ${mode}`,
    `        workspaceRoot: "${workspaceRoot.replaceAll('\\', '\\\\')}"`,
    ...row('sandbox', '@deepseek-ai/dsh-sandbox-local'),
    '    - id: webserver',
    `      name: '${mountedPath('@deepseek-ai/dsh-host-webserver')}'`,
    '      config:',
    '        host: 127.0.0.1',
    '        port: 0',
    '    - id: dsh-wsl-workspace',
    `      name: '${libPath('index.js')}'`,
  ]
}

async function arm (label, extraRows, measure, { mode = 'danger-full-access', workspaceRoot = FORGE_REPO } = {}) {
  if (process.env.W138_ONLY !== undefined && process.env.W138_ONLY !== label) {
    armsFiltered += 1
    return
  }
  armsRun += 1
  const home = mkdtempSync(join(SCRATCH, `home-${label}-`))
  const profile = `w138${label.replace(/[^a-z0-9]/gi, '')}`
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  writeFileSync(join(home, 'profiles', profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  const overlay = join(home, 'overlay.yml')
  writeFileSync(overlay, ['- insert:', ...profileRows(mode, workspaceRoot), ...worldRows(), ...extraRows, ''].join('\n'), 'utf8')
  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  let handle
  try {
    handle = await within(runProfile({ environment, profile, patchFiles: [overlay], args: [] }), 150_000, `${label} profile boot`)
    const loader = handle.ctx.get('loader')
    if (loader === undefined) throw new Error('no loader service on the booted context')
    await within(loader.await(), 90_000, `${label} loader settle`)
    await measure(handle.ctx, loader, home)
  } catch (error) {
    add(`arm:${label}`, false, `did not settle: ${String(error?.message ?? error).slice(0, 220)}`)
  } finally {
    try { if (handle?.shutdown !== undefined) await within(handle.shutdown(), 20_000, `${label} shutdown`) } catch { /* reported by the arm that hit it */ }
  }
}

const entryOf = (loader, id) => [...loader.entries()].find(entry => entry.options.id === id)
function realmOf (loader, id, service = 'fs') {
  const entry = entryOf(loader, id)
  if (entry === undefined) return '(not mounted)'
  const ectx = entry.ctx
  const key = ectx?.[ISOLATE]?.[service]
  const impl = key === undefined ? undefined : ectx?.reflect?.store?.[key]
  return { realm: key === undefined ? 'root' : String(key), provider: impl?.value?.constructor?.name ?? '(no provider yet)' }
}
// The profile level reads as the root service symbol (Symbol(fs)), not 'root' — measured 2026-11-07.
// The signal that a consumer holds the HOST's provider rather than ours is the absence of the
// '#wsl-world' realm suffix our isolate stamps, plus the host provider's constructor name.
const holdsHost = realm => typeof realm === 'object' && !String(realm.realm).includes('#wsl-world')

function makeSession (id, cwd) {
  return Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, cwd })
}
const agent = {
  id: 'agent-w138',
  ctx: {
    fiber: { assertActive: () => {} },
    on: () => () => {},
    effect: fn => { try { fn?.() } catch { /* no lifecycle here */ } return () => {} },
  },
}
agent.session = makeSession('session-w138-forge', FORGE_REPO)

// The forge bundle's own patch rows, verbatim in shape, names resolved to the release under test.
const FORGE_ROWS = [
  ...row('worktree', '@deepseek-ai/dsh-experimental-worktree'),
  ...row('tool-worktree', '@deepseek-ai/dsh-experimental-tool-worktree'),
  ...row('forge', '@deepseek-ai/dsh-experimental-forge'),
  ...row('forge-github', '@deepseek-ai/dsh-experimental-forge-github'),
  ...row('forge-session', '@deepseek-ai/dsh-experimental-forge-session'),
  '    - id: optional-forge-panel',
  '      name: cordis:group',
  '      group: true',
  '      isolate:',
  '        worktrees: true',
  '      config:',
  '        - id: forge-worktree',
  `          name: '${mountedPath('@deepseek-ai/dsh-experimental-worktree')}'`,
  '        - id: forge-panel',
  `          name: '${mountedPath('@deepseek-ai/dsh-experimental-client-ui-forge')}'`,
]
// The services the forge chain injects that the minimal rc.2 base does not carry.
const FORGE_SUPPORT_ROWS = [
  ...row('session', '@deepseek-ai/dsh-session'),
  ...row('typert', '@deepseek-ai/dsh-typert-registry'),
  ...row('agent', '@deepseek-ai/dsh-agent'),
  ...row('shell-env', '@deepseek-ai/dsh-shell-env'),
  ...row('bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'),
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
]

// ── arm 1: the forge bundle, at the profile level its own patch mounts it in ──
await arm('forge', [...FORGE_SUPPORT_ROWS, ...FORGE_ROWS], async (ctx, loader) => {
  const control = { webserver: realmOf(loader, 'webserver'), 'fs-wsl': realmOf(loader, 'fs-wsl') }
  const distinguishes = typeof control.webserver === 'object' && typeof control['fs-wsl'] === 'object'
    && control.webserver.provider !== control['fs-wsl'].provider
  add('realm:instrument-control', distinguishes, `${JSON.stringify(control)}${distinguishes ? '' : ' — the reader cannot separate root from isolate; no realm row below is a reading'}`)
  const panelFs = realmOf(loader, 'forge-panel', 'fs')
  const panelSandbox = realmOf(loader, 'forge-panel', 'sandbox')
  const sessionShell = realmOf(loader, 'forge-session', 'shell')
  add('realm:forge-panel-fs', holdsHost(panelFs) && panelFs.provider === 'LocalFileSystem',
    `forge-panel inside optional-forge-panel (isolate cuts only worktrees): ${JSON.stringify(panelFs)} · root fs is ${ctx.get('fs', false)?.constructor?.name}`)
  add('realm:forge-panel-sandbox', holdsHost(panelSandbox) && panelSandbox.provider === 'LocalSandboxProvider', JSON.stringify(panelSandbox))
  add('realm:forge-session-shell', holdsHost(sessionShell),
    `${JSON.stringify(sessionShell)} · root shell is ${ctx.get('shell', false)?.constructor?.name}`)

  // One real branches() call hits both pairs: inspectCheckout canonicalises through ctx.fs, and runGit
  // confides through ctx.sandbox because this arm's policy is workspace-write (not danger-full-access,
  // which skips confine at lib/index.js:372). The root sandbox.confine is instrumented to prove it ran.
  const sandbox = ctx.get('sandbox', false)
  const confineCalls = []
  if (sandbox?.confine) {
    const originalConfine = sandbox.confine.bind(sandbox)
    sandbox.confine = (...args) => { confineCalls.push(args[0]); return originalConfine(...args) }
  }
  const panel = ctx.get('forgePanel', false)
  if (panel === undefined) {
    add('forge-panel-branches', false, `no forgePanel service — entries not activated: ${await inactiveDetail(ctx, loader) || '(all report state 2)'}`)
  } else {
    try {
      const branches = await within(panel.branches(agent.session, AbortSignal.timeout(40_000)), 60_000, 'forgePanel.branches')
      add('forge-panel-branches', true,
        `branches() returned ${JSON.stringify(branches).slice(0, 200)} · root sandbox.confine ran ${confineCalls.length} time(s)`
        + `${confineCalls.length > 0 ? ` (first argv: ${JSON.stringify(confineCalls[0]).slice(0, 120)})` : ' — workspace-write did not reach confine; the sandbox pair is not answered by this call'}`)
    } catch (error) {
      add('forge-panel-branches', false, `branches() threw: ${String(error?.message ?? error).slice(0, 240)} · confine ran ${confineCalls.length} time(s)`)
    }
  }

  // forge-session's shell consumer: a tools/result listener that runs a gh PR-reference lookup through
  // the shell service it holds. The trigger is the host's own event shape (dsh-tools pipeline.js:584),
  // emitted synthetically because the distribution cannot boot on this machine right now. The listener
  // and the shell.execute are the real package code; the root shell.execute is instrumented to read the
  // lookup spec it receives.
  const shell = ctx.get('shell', false)
  const shellCalls = []
  if (shell?.execute) {
    const originalExecute = shell.execute.bind(shell)
    shell.execute = async (spec) => {
      const handle = await originalExecute(spec)
      shellCalls.push({ command: spec?.command, workdir: spec?.workdir, handle })
      return handle
    }
  }
  const exec = {
    name: 'bash', callId: 'w138-probe', agent, parent: undefined,
    signal: AbortSignal.timeout(30_000), arguments: { command: 'gh pr view 1 --repo cli/cli' },
  }
  const result = {
    isError: false,
    value: { kind: 'foreground', cwd: FORGE_REPO, exitCode: 0, signal: null, timedOut: false, aborted: false },
    content: [],
  }
  ctx.emit('tools/result', exec, result)
  const deadline = Date.now() + 20_000
  while (shellCalls.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
  if (shellCalls.length === 0) {
    add('forge-session-lookup', false, 'the tools/result listener never reached shell.execute — either the event shape is wrong or the listener did not register (forge-session inactive?)')
  } else {
    const call = shellCalls[0]
    let outcome = '(result not awaited)'
    try {
      const value = await within(call.handle.result(), 30_000, 'gh lookup result')
      outcome = `exitCode=${value?.exitCode} stdout=${JSON.stringify(value?.stdout?.text ?? value?.stdout ?? '').slice(0, 120)}`
    } catch (error) { outcome = `threw: ${String(error?.message ?? error).slice(0, 140)}` }
    add('forge-session-lookup', true,
      `listener ran the lookup through the ROOT shell: command=${JSON.stringify(call.command)} workdir=${JSON.stringify(call.workdir)} · ${outcome}`
      + ' · trigger was a synthetic tools/result (the distribution could not boot); the listener/resolve/execute are the real package code')
  }
}, { mode: 'workspace-write', workspaceRoot: FORGE_REPO })

// ── arm 2: liveshare, at the profile level its own patch mounts it in ──
await arm('liveshare', [
  ...row('typert', '@deepseek-ai/dsh-typert-registry'),
  ...row('credentials', '@deepseek-ai/dsh-credentials-local'),
  ...row('connection', '@deepseek-ai/dsh-client-connection'),
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
  '    - id: liveshare-share-host',
  `      name: '${mountedPath('@deepseek-ai/dsh-experimental-liveshare')}'`,
  '      config:',
  `        ownerStateFile: "${join(SCRATCH, 'liveshare-owner-state.json').replaceAll('\\', '/')}"`,
], async (ctx, loader) => {
  const shareFs = realmOf(loader, 'liveshare-share-host', 'fs')
  add('realm:liveshare-fs', holdsHost(shareFs) && shareFs.provider === 'LocalFileSystem',
    `${JSON.stringify(shareFs)} · root fs is ${ctx.get('fs', false)?.constructor?.name}`)
  const shares = ctx.get('liveshareShares', false)
  if (shares === undefined) {
    add('liveshare-list', false, `no liveshareShares service — entries not activated: ${await inactiveDetail(ctx, loader) || '(all report state 2)'}`)
  } else {
    try {
      const listed = await within(shares.list(), 20_000, 'liveshareShares.list')
      add('liveshare-list', true, `list() returned ${JSON.stringify(listed).slice(0, 160)} — a real service call, but not the fs consumer`)
    } catch (error) {
      add('liveshare-list', false, `list() threw: ${String(error?.message ?? error).slice(0, 180)}`)
    }
  }
  add('liveshare-fs-site', true,
    'the fs consumer is applySourceAccess (lib/index.js:4096 get("fs"), :4110 fs.resolve), reached only after a share publishes to a live Relay (:1195) or on a mode change of a published share (:1306/:1344). '
    + 'With no Relay it is unreachable, so fs x dsh-experimental-liveshare stays mounted-but-uncalled. '
    + 'shell x dsh-experimental-liveshare is a derivation false positive: the only match is a JSDoc comment (`ctx.shell`\'s job, :3266); the package\'s real inject is ["connection"] (:7324) and it never consumes shell.')
})

report()