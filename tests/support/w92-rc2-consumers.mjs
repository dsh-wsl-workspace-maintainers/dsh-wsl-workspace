// The rc.2 consumers, called for real.
//
//   node --experimental-strip-types tests/support/w92-rc2-consumers.mjs
//
// #92 pinned the host at 0.2.1-rc.2 and the consumer-coverage gate derived five pairs we had never
// carried. The rows said "our worlds do not mount this package" — the distinction this ledger exists to
// refuse to blur: mentioning is not mounting, and mounting is not calling. This probe mounts each
// package in the shape the product mounts it and calls it, so each row moves onto a reading.
//
// What the product does, re-measured against this closure (`ci/deps/node_modules`, 2026-10-19): the four
// shipped presets under `dsh-web-app/presets/` mention none of the four packages, while
// `dsh-working-directory` is declared by 22 packages in the closure (including `dsh-base`, which is what
// pulls it into every real profile), `dsh-workspace-changes` by `dsh-web-app`, and
// `dsh-experimental-worktree` / `dsh-tool-terminal` each by one opt-in bundle. So the two that ship are
// mounted at the PROFILE level — the root realm — while the world we generate cuts an isolate for `fs`,
// `shell` and `sandbox`. The live question was never "can a WSL session mount them"; it is **which `fs`
// they already hold, and what that makes them blind to**. The experimental pair is measured at both mount
// levels, because "beside the isolate" is what ships and "inside it" is what the ledger's `sandbox` row asks.
//
// The mechanical traps this file exists partly to record are on `mountedRow` (a stale copy is dropped in
// silence) and in the arm bodies (one boot per arm; a real `Session`; the realm positive control).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot, hostFile, mountedRow, mountedPath, canonicalUrl, inactiveDetail } from './host-closure.mjs'
import { finish } from './report.mjs'

// Resolution, version assertion and the loader-row builder live in host-closure.mjs; this file keeps only
// what is specific to it. `mountedRow` refuses a copy from a release other than the one under test, which is
// the failure mode that made four rows disappear in silence during the 0.2.1-rc.2 bump.
const row = mountedRow
const unwrap = namespace => namespace.default ?? namespace
const libPath = file => join(repoRoot, 'lib', file).replaceAll('\\', '/')

const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-w92-consumers-'))
const DISTRO = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
// A directory that exists on this machine's distribution: `workingDirectory.ensure` resolves and stats
// it through the host's local fs, and a fixture that is not there would read as a product failure.
const LINUX_HOME = `\\home\\${process.env.WSL_COMPAT_USER ?? 'ruler'}`
const UNC_CWD = `\\\\wsl.localhost\\${DISTRO}${LINUX_HOME}`
const LINUX_CWD = LINUX_HOME.replaceAll('\\', '/')
// Written through the isolate fs, read back by the host fs, removed by the arm that wrote it. Module-level
// because two rows in arm 2 need the same path and only one of them is skipped when the emitter is absent.
const PROBE_FILE = '/tmp/w92-changes-probe.txt'

const rows = []
const add = (id, ok, detail) => rows.push({ id, ok, detail })
let armsRun = 0
let armsFiltered = 0
let emitterSkipped = 0

/**
 * A bounded await. The timer is deliberately NOT unref'd: an unref'd watchdog lets a drained event loop
 * exit 0 with the awaited promise still pending, which turns "never measured" into a silent pass.
 */
const within = (promise, ms, label) => Promise.race([
  Promise.resolve(promise),
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
])

function report () {
  // A filtered run is a diagnosis, not a verdict: `PASSED (3 rows)` while four arms sat out would let a
  // partial run read like the gate.
  const partial = armsFiltered > 0
    ? `PARTIAL — W92_ONLY=${process.env.W92_ONLY} ran ${armsRun} of ${armsRun + armsFiltered} arms, not the gate's verdict`
    : ''
  finish(rows, {
    label: 'W92-RC2-CONSUMERS',
    summary: ' — the rc.2 consumers, called, and the realm each holds',
    metrics: { armsRun, armsFiltered },
    partial,
  })
}

if (process.platform !== 'win32') {
  console.error('SKIP: w92-rc2-consumers — the realm question is about `\\\\wsl.localhost\\…` spellings and the Windows fs provider; the ubuntu runner cannot answer it')
  console.log('W92-RC2-CONSUMERS PASSED (1 skipped — a skip is not a pass)')
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
// `Session` is a NAMED export here and the package's default export is `SessionStore`, so this import reads
// the namespace directly: the local `unwrap` helper would hand back the store class and `Session.create`
// would be undefined.
const { Session, SESSION_FORMAT_VERSION } = await import(canonicalUrl(hostFile('@deepseek-ai/dsh-session')))
const { Context } = unwrap(await import(canonicalUrl(hostFile('@deepseek-ai/cordis'))))
const ISOLATE = Context.isolate ?? Symbol.for('cordis.isolate')

// The world text, generated by this repository from the release's own shipped preset — never typed here.
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

const PROFILE_ROWS = [
  ...row('system-prompt', '@deepseek-ai/dsh-system-prompt'),
  ...row('tools', '@deepseek-ai/dsh-tools'),
  ...row('subprocess-local', '@deepseek-ai/dsh-subprocess-local'),
  ...row('fs-local', '@deepseek-ai/dsh-fs-local'),
  ...row('session-projection', '@deepseek-ai/dsh-session-projection'),
  `    - id: sandbox-policy`,
  `      name: '${mountedPath('@deepseek-ai/dsh-sandbox-policy')}'`,
  '      config:',
  '        mode: danger-full-access',
  `        workspaceRoot: "${UNC_CWD.replaceAll('\\', '\\\\')}"`,
  ...row('sandbox', '@deepseek-ai/dsh-sandbox-local'),
  // Our plugin registers an HTTP route, so the boot needs a real web server; port 0 is the OS's choice,
  // so a probe never claims a port a person is using (w54's device).
  '    - id: webserver',
  `      name: '${mountedPath('@deepseek-ai/dsh-host-webserver')}'`,
  '      config:',
  '        host: 127.0.0.1',
  '        port: 0',
  '    - id: dsh-wsl-workspace',
  `      name: '${libPath('index.js')}'`,
]

/**
 * The generated `wsl-world` group as patch rows, with any arm-specific rows appended **inside the isolate**.
 * The append point is the whole reason this is a function: a consumer mounted at the profile level is handed
 * the host's own providers, and the only way to ask "what would our provider answer to this package" is to
 * mount it where our providers live. Dedenting one level from the group's last child puts the row back in
 * `wsl-world`'s own `config:` list, which is what YAML block sequences do with it.
 */
function worldRows (insideWorld = []) {
  const lines = worldText.split('\n').filter(line => line.trim() !== '').map(line => `    ${line}`)
  for (const [id, name] of insideWorld) lines.push(`        - id: ${id}`, `          name: '${name}'`)
  return lines
}

const BASE_ROWS = [...PROFILE_ROWS, ...worldRows()]

/**
 * One arm: boot the world plus the rows this arm adds, hand the settled context to `measure`, and always
 * try to shut it down — a leaked host would contaminate the next arm's reading.
 * @param insideWorld - `[id, package]` pairs mounted inside the generated isolate rather than beside it.
 */
async function arm (label, extraRows, measure, insideWorld = []) {
  // `W92_ONLY=<label>` runs one arm. Five boots cost about ten minutes and an arm that needs a diagnosis
  // should not have to pay for the four that already answered.
  if (process.env.W92_ONLY !== undefined && process.env.W92_ONLY !== label) {
    armsFiltered += 1
    return
  }
  armsRun += 1
  const home = mkdtempSync(join(SCRATCH, `home-${label}-`))
  const profile = `w92${label.replace(/[^a-z0-9]/gi, '')}`
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  writeFileSync(join(home, 'profiles', profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  const overlay = join(home, 'overlay.yml')
  writeFileSync(overlay, ['- insert:', ...PROFILE_ROWS, ...worldRows(insideWorld), ...extraRows, ''].join('\n'), 'utf8')
  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  let handle
  try {
    handle = await within(runProfile({ environment, profile, patchFiles: [overlay], args: [] }), 150_000, `${label} profile boot`)
    const loader = handle.ctx.get('loader')
    if (loader === undefined) throw new Error('no loader service on the booted context')
    await within(loader.await(), 90_000, `${label} loader settle`)
    await measure(handle.ctx, loader)
  } catch (error) {
    add(`arm:${label}`, false, `did not settle: ${String(error?.message ?? error).slice(0, 220)}`)
  } finally {
    try { if (handle?.shutdown !== undefined) await within(handle.shutdown(), 20_000, `${label} shutdown`) } catch { /* reported by the arm that hit it */ }
  }
}

const entryOf = (loader, id) => [...loader.entries()].find(entry => entry.options.id === id)
/**
 * Which provider a mounted entry actually resolves for one service — read the way cordis itself does it
 * (w78's device). `realm: 'root'` means the entry sees the profile-level value; a `Symbol(<service>#<group>)`
 * means it sees the isolate's own.
 */
function realmOf (loader, id, service = 'fs') {
  const entry = entryOf(loader, id)
  if (entry === undefined) return '(not mounted)'
  const ectx = entry.ctx
  const key = ectx?.[ISOLATE]?.[service]
  const impl = key === undefined ? undefined : ectx?.reflect?.store?.[key]
  return { realm: key === undefined ? 'root' : String(key), provider: impl?.value?.constructor?.name ?? '(no provider yet)' }
}
const fsRealmOf = (loader, id) => realmOf(loader, id, 'fs')

/**
 * A session in the shape the host makes one. The first version of this fixture was a `{ id, header, append }`
 * literal and it was wrong in a way that matters: `workingDirectory.ensure`, `write.execute` and
 * `worktrees.create` all read the real session API, so they died on `session.snapshotEvents is not a
 * function` — and one of those deaths (`changes-intent`) would have been read as "the change tracker never
 * learns about WSL edits", a product verdict produced by my own fixture. `Session.create` is the host's own
 * detached constructor: it validates and freezes the same header a store-owned session carries, and nothing
 * else. No store, no disk, no llm.
 */
function makeSession (id, cwd) {
  return Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, cwd })
}

const agent = {
  id: 'agent-w92',
  // The service validates liveness through the agent's own fiber, so a bare `{ session }` literal dies on
  // `agent.ctx.fiber.assertActive` — measured, and it is a fixture gap, not a product one.
  ctx: {
    fiber: { assertActive: () => {} },
    on: () => () => {},
    effect: fn => { try { fn?.() } catch { /* no lifecycle here */ } return () => {} },
  },
}
agent.session = makeSession('session-w92', UNC_CWD)

// ── arm 1: the working-directory service, at the realm the product puts it in ──
await arm('wd', row('working-directory', '@deepseek-ai/dsh-working-directory'), async (ctx, loader) => {
  // The instrument's own positive control. Every realm row in this file is a claim about which `fs` an entry
  // resolves, so the reader has to prove it can tell two different answers apart: `webserver` is mounted at
  // the profile level and can only hold the host's provider, `fs-wsl` is inside the isolate and can only hold
  // ours. If those two read the same, the realm rows below say nothing about the product and this row says so.
  const control = { webserver: fsRealmOf(loader, 'webserver'), 'fs-wsl': fsRealmOf(loader, 'fs-wsl') }
  const distinguishes = typeof control.webserver === 'object' && typeof control['fs-wsl'] === 'object'
    && control.webserver.provider !== control['fs-wsl'].provider
  add('realm:instrument-control', distinguishes, `${JSON.stringify(control)}${distinguishes ? '' : ' — the reader cannot separate the root realm from the isolate, so no realm row in this file is a reading'}`)
  add('realm:working-directory', typeof fsRealmOf(loader, 'working-directory') === 'object', JSON.stringify(fsRealmOf(loader, 'working-directory')))
  const wd = ctx.get('workingDirectory', false)
  if (wd === undefined) { add('wd-root', false, 'no workingDirectory service even with the row mounted'); return }
  try {
    const ensured = await within(wd.ensure(agent, AbortSignal.timeout(20_000)), 30_000, 'workingDirectory.ensure')
    add('wd-root', typeof ensured === 'string' && ensured.length > 0,
      `ensure() for a WSL session returned ${JSON.stringify(ensured)} · UNC survived = ${String(ensured).includes('wsl.localhost')} · Linux path = ${String(ensured).includes(LINUX_CWD)}`)
  } catch (error) {
    add('wd-root', false, `ensure() threw: ${String(error?.message ?? error).slice(0, 180)}`)
  }
})

// ── arm 2: does a write through OUR fs still reach the host's change tracker? ──
// `dsh-tool-fs` (line 607: `ctx.waterfall("fs/write-intent", target, exec, …)`) is the emitter;
// `dsh-workspace-changes` is the listener that turns it into the change panel, and its `capture()` resolves
// the target through **its own realm's** `fs.processPath`, which is `String(target.targetKey)` — it takes the
// target OBJECT the emitter passed, not a path string. (The first version of this arm handed processPath a
// string and read back `"undefined"`, then handed the listener an object and read `target=null`: two
// instrument defects that looked like a product finding. Both fields are read the way the recorder reads
// them now.) The pair is the contract, so this arm reads the links separately instead of one yes/no: does the
// intent cross the isolate boundary at all, what `targetKey` arrives, what the root-realm fs turns it into,
// and whether that answer is a file the host can actually see. The last link is not measurable from here and
// says so: the recorder only attaches once a real turn has announced `session/event turn/start` AND the
// dispatcher has run `tools/pre-execute` for the call (that is what fills the `mutations` WeakMap `capture()`
// reads), so a direct `write.execute` cannot produce a summary. Reading `summary()` anyway is the honest way
// to show that gap instead of pretending the panel was queried.
await arm('changes', [
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
  ...row('workspace-changes', '@deepseek-ai/dsh-workspace-changes'),
], async (ctx, loader) => {
  const worldFs = fsRealmOf(loader, 'fs-wsl')
  const recorderFs = fsRealmOf(loader, 'workspace-changes')
  add('realm:workspace-changes', typeof recorderFs === 'object', JSON.stringify(recorderFs))
  // Both sides of the boundary in one reading, so the claim below cannot be mistaken for an assumption:
  // `fs-wsl` is this plugin's provider inside the isolate, `workspace-changes` is the recorder outside it.
  add('realm:fs-wsl', typeof worldFs === 'object', `inside wsl-world ${JSON.stringify(worldFs)} · as the recorder sees it ${JSON.stringify(recorderFs)}`)
  const arrived = []
  for (const event of ['fs/write-intent', 'fs/edit-intent']) {
    ctx.on?.(event, (...args) => {
      const target = args[0]
      arrived.push({
        event,
        argTypes: args.map(value => value === null ? 'null' : value === undefined ? 'undefined'
          : typeof value === 'object' ? value.constructor?.name ?? 'object' : typeof value).join(','),
        targetKey: String(target?.targetKey),
        fields: target === null || typeof target !== 'object' ? '(not an object)' : Object.keys(target).join(','),
      })
    })
  }
  const tools = ctx.get('tools', false)
  const write = tools?.get?.('write')
  let emitterRan = false
  if (write === undefined) {
    // The emitter of `fs/write-intent` is `dsh-tool-fs`, whose PEER `@deepseek-ai/dsh-attachment` npm does
    // not install under `ci/deps/.npmrc legacy-peer-deps` — measured both ways on 2026-10-19: with that
    // package in the closure this arm reads `changes-write`/`changes-intent`/`changes-resolve`; without it
    // the row for `@deepseek-ai/dsh-tool-fs` activates as nothing and there is no tool to ask. The peer is
    // pinned as of 2026-10-20 (after the type mismatch it unmasked at `src/host/wsl-image-tool.ts` was
    // fixed), so this branch is what a tree WITHOUT the peer reports: a named skip, never a red — the row's
    // cell then says what was read on a tree that carried it.
    if (hostFile('@deepseek-ai/dsh-attachment') === null) {
      console.error('SKIP: w92 arm changes (fs x dsh-workspace-changes) — `dsh-tool-fs`, the emitter of fs/write-intent,'
        + ' needs its peer @deepseek-ai/dsh-attachment, which npm does not install under ci/deps/.npmrc legacy-peer-deps;'
        + ' the crossing was measured on a tree that carried it (2026-10-19) and is not measurable in this closure')
      emitterSkipped += 1
    } else {
      add('changes-write', false, 'no `write` tool in the booted world although its package is in the closure'
        + ` · entries not activated: ${await inactiveDetail(ctx, loader) || '(all entries report state 2)'}`)
    }
  } else {
    const target = PROBE_FILE
    try {
      const value = await within(write.execute({ file_path: target, content: 'W92_CHANGES_PROBE\n' },
        { signal: AbortSignal.timeout(30_000), agent }), 45_000, 'write.execute')
      emitterRan = true
      add('changes-write', !/error/i.test(JSON.stringify(value).slice(0, 200)),
        `wrote ${target} through the world's fs: ${JSON.stringify(value).slice(0, 120)}`)
    } catch (error) {
      add('changes-write', false, `write threw: ${String(error?.message ?? error).slice(0, 180)}`)
    }
    add('changes-intent', arrived.length > 0, arrived.length === 0
      ? `NO fs/write-intent or fs/edit-intent reached the root realm for a write through the isolate's fs — the change tracker cannot see WSL edits`
      : `crossed to the root realm: ${JSON.stringify(arrived)}`)
    const intent = arrived.find(entry => entry.event === 'fs/write-intent')
    const rootFs = ctx.get('fs', false)
    if (intent === undefined) {
      add('changes-resolve', false, 'no write-intent target to resolve — the previous row already says the intent did not cross')
    } else {
      // Rebuild the target the way the emitter holds it: `targetKey` is the one field capture() reads, so a
      // `{ targetKey }` object is the same input the recorder gets, not a stand-in for the whole class.
      const mapped = (() => {
        try { return String(rootFs?.processPath?.({ targetKey: intent.targetKey }) ?? '(processPath returned nothing)') }
        catch (error) { return `threw: ${String(error?.message ?? error).slice(0, 120)}` }
      })()
      const hostSeesIt = existsSync(mapped) && !mapped.startsWith('threw')
      add('changes-resolve', true,
        `root-realm fs.processPath({targetKey:${JSON.stringify(intent.targetKey)}}) = ${JSON.stringify(mapped)} · the host filesystem has that file = ${hostSeesIt}`
        + ` — this is the recorder's own resolve step: whatever it answers is the path the change panel stats, so a mapping that lands outside the distribution is what makes the panel blind even when the intent arrives`)
    }
  }
  const changes = ctx.get('workspaceChanges', false)
  if (changes === undefined) add('changes-service', false, 'workspaceChanges service absent with the row mounted')
  else {
    const summary = changes.summary(agent.session.id, 0)
    add('changes-service', true, `summary(${agent.session.id}, 0) = ${JSON.stringify(summary ?? undefined)} · undefined is the reading, not a failure: a recorder only attaches on a live turn/start plus tools/pre-execute, neither of which this arm has`)
  }
  const bash = tools?.get?.('bash', agent) ?? tools?.get?.('bash')
  if (bash !== undefined) {
    try {
      const value = await within(bash.execute({ command: `test -f ${PROBE_FILE} && echo WAS_IN_DISTRO; rm -f ${PROBE_FILE}; pwd`, description: 'w92: the host bash tool now asks workingDirectory for a cwd' },
        { signal: AbortSignal.timeout(30_000), agent }), 45_000, 'bash.execute')
      const body = JSON.stringify(value ?? null)
      add('bash-cwd', body.includes(LINUX_CWD) || body.includes(UNC_CWD),
        `cwd field=${JSON.stringify(value?.cwd)} · answer carries the Linux path = ${body.includes(LINUX_CWD)} · the write really landed in the distribution = ${emitterRan ? `${body.includes('WAS_IN_DISTRO')} (probe file then removed)` : 'not attempted (the emitter arm is skipped on this closure)'} · ${body.slice(0, 90)}`)
    } catch (error) {
      add('bash-cwd', false, `threw: ${String(error?.message ?? error).slice(0, 200)}`)
    }
  }
})

// ── arm 3: the host's terminal tools, called through the terminals service in this world ──
await arm('terminals', [
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
  ...row('terminal', '@deepseek-ai/dsh-terminal'),
  ...row('tool-terminal', '@deepseek-ai/dsh-tool-terminal'),
], async (ctx, loader) => {
  const entry = entryOf(loader, 'tool-terminal')
  add('terminal-mounted', entry !== undefined, entry === undefined ? 'row did not activate' : entry.fiber?.state ?? 'present')
  const list = ctx.get('tools', false)?.get?.('terminal_list')
  if (list === undefined) {
    const names = (ctx.get('tools', false)?.schemas?.() ?? []).map(schema => schema?.name).filter(Boolean)
    add('terminal-list', false, `terminal_list not registered; names at this scope: ${names.slice(0, 14).join(',') || '(none read)'}`)
    return
  }
  try {
    const value = await within(list.execute({ description: 'w92: list terminals' }, { signal: AbortSignal.timeout(15_000), agent }), 25_000, 'terminal_list')
    add('terminal-list', true, `called through the terminals service in this world: ${JSON.stringify(value).slice(0, 160)}`)
  } catch (error) {
    add('terminal-list', false, `threw: ${String(error?.message ?? error).slice(0, 200)}`)
  }
})

/** A scratch git repo with one empty commit, for the arms that ask a host package to make a worktree. */
function scratchRepo (tag) {
  const repo = mkdtempSync(join(SCRATCH, `gitrepo-${tag}-`))
  const git = (...args) => spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'w92', GIT_AUTHOR_EMAIL: 'w92@local',
      GIT_COMMITTER_NAME: 'w92', GIT_COMMITTER_EMAIL: 'w92@local',
    },
  })
  const init = git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'seed')
  if (init.status !== 0) throw new Error(`git init failed on this machine: ${String(init.stderr).slice(0, 120)}`)
  return repo
}

// ── arm 4: the worktree provider, called for real against a scratch git repo ──
// It injects `fs`, `sandbox` and `sandboxPolicy` alongside `workingDirectory`, so a call through it reads two
// of this release's new pairs at once: which fs resolves the checkout path (covered here), and which sandbox
// it would confine through — which at this mount level is the HOST's provider, not ours. That is the reading,
// and it is why `sandbox` x `dsh-experimental-worktree` stays uncovered below rather than being claimed by an
// arm that never reached our provider.
await arm('worktree', [
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
  ...row('worktree', '@deepseek-ai/dsh-experimental-worktree'),
], async (ctx, loader) => {
  add('realm:worktree', typeof fsRealmOf(loader, 'worktree') === 'object', JSON.stringify(fsRealmOf(loader, 'worktree')))
  add('realm:worktree-sandbox', true, `mounted beside the isolate, ${JSON.stringify(realmOf(loader, 'worktree', 'sandbox'))}`)
  const worktrees = ctx.get('worktrees', false)
  if (worktrees === undefined) { add('worktree-call', false, 'no worktrees service with the row mounted at the root realm'); return }
  let repo
  try { repo = scratchRepo('root') } catch (error) { add('worktree-call', false, String(error?.message ?? error)); return }
  const winCwd = repo.replaceAll('\\', '/')
  const wtAgent = { ...agent, id: 'agent-w92-git', session: makeSession('session-w92-git', winCwd) }
  try {
    const created = await within(worktrees.create(wtAgent, { name: 'w92-probe' }, AbortSignal.timeout(40_000)), 60_000, 'worktrees.create')
    add('worktree-call', true, `create() returned ${JSON.stringify(created).slice(0, 220)} · the checkout exists on disk = ${existsSync(String(created?.path ?? ''))}`)
  } catch (error) {
    add('worktree-call', false, `create() threw: ${String(error?.message ?? error).slice(0, 260)}`)
  }
})

// ── arm 5: the same package, mounted INSIDE the isolate our providers live in ──
// The shipped preset never puts this package in `wsl-world`, so nothing in the corpus can answer the question
// the ledger's `sandbox` row asks: when this package confines a `git worktree` command through **our**
// provider, does it get refused or passed? Mounting the row inside the group is the only shape that asks it,
// and the row says so — this is a variant, not the release's own assembly.
await arm('worktree-in-world', [
  // The package injects five services and the isolate only cuts `fs`, `sandbox` and `shell`: `workingDirectory`
  // and `subprocess` must still resolve from above, or the entry never starts and the arm measures its own
  // missing row instead of the pair.
  ...row('working-directory', '@deepseek-ai/dsh-working-directory'),
], async (ctx, loader) => {
  const sandboxRealm = realmOf(loader, 'worktree', 'sandbox')
  const holdsOurs = typeof sandboxRealm === 'object' && sandboxRealm.provider === 'WslSandboxProvider'
  add('realm:worktree-sandbox-in-world', holdsOurs, `mounted inside wsl-world, ${JSON.stringify(sandboxRealm)}`
    + (holdsOurs ? '' : ' — the row did not land in the isolate, so this arm did not reach our provider and the sandbox row stays unanswered'))
  // Reaching the service is not a given once the row sits inside the isolate: a scope's services are hidden
  // from the context above it, which is the entire mechanism this file exists to measure. So the lookup is
  // tried three ways and every way it was tried is printed — the row must be able to say whether it failed
  // because the package never started or because this probe could not find it.
  const wtEntry = entryOf(loader, 'worktree')
  const lookup = {
    byNameFromEntry: wtEntry?.ctx?.get?.('worktrees', false),
    byNameFromRoot: ctx.get('worktrees', false),
    keys: Object.getOwnPropertySymbols(wtEntry?.ctx?.reflect?.store ?? {}).map(String).join(','),
    fiberState: wtEntry?.fiber?.state ?? '(no fiber read)',
  }
  const worktrees = lookup.byNameFromEntry ?? lookup.byNameFromRoot
  if (worktrees === undefined) {
    add('worktree-confine', false, `no worktrees service reachable — entry fiber ${JSON.stringify(lookup.fiberState)}, `
      + `service slots in that scope: ${lookup.keys}`)
    return
  }
  let repo
  try { repo = scratchRepo('isolate') } catch (error) { add('worktree-confine', false, String(error?.message ?? error)); return }
  const winCwd = repo.replaceAll('\\', '/')
  // What the package actually hands to `spawn`. It gets its working directory from `ctx.fs.resolve` +
  // `ctx.fs.processPath` (`lib/index.js:270-274`), and inside this group that `fs` is ours: so the reading
  // below is the literal string the git call is launched with, and the two spawns are the control — the same
  // `git --version` in the Windows spelling and in whatever our provider answered. `spawn … ENOENT` for a
  // binary that exists is Node's message for an unusable `cwd`, so without this pair the failure would have
  // been readable as "our confinement refused it".
  const wtFs = wtEntry?.ctx?.get?.('fs', false)
  let shaped = '(fs service not reachable from the isolated entry)'
  let control = '(no control run)'
  try {
    const target = await within(wtFs.resolve(winCwd, { cwd: winCwd, signal: AbortSignal.timeout(15_000) }), 25_000, 'isolated fs.resolve')
    shaped = String(wtFs.processPath(target))
    const inWindowsSpelling = spawnSync('git', ['--version'], { cwd: winCwd, encoding: 'utf8' })
    const inOurSpelling = spawnSync('git', ['--version'], { cwd: shaped, encoding: 'utf8' })
    control = `git in the Windows spelling rc=${inWindowsSpelling.status}${inWindowsSpelling.error ? ` ${inWindowsSpelling.error.code}` : ''} · git in our spelling rc=${inOurSpelling.status}${inOurSpelling.error ? ` ${inOurSpelling.error.code}` : ''}`
  } catch (error) {
    control = `resolve threw: ${String(error?.message ?? error).slice(0, 140)}`
  }
  add('worktree-path-shape', true, `our isolated fs answers ${JSON.stringify(shaped)} for the repo directory · ${control}`
    + ' · this is the string a host package launches git with when it lives inside wsl-world')
  const wtAgent = { ...agent, id: 'agent-w92-git-wt', session: makeSession('session-w92-git-wt', winCwd) }
  // The expectation is stated, not fitted to whatever happened: mounted inside `wsl-world`, this package is
  // launched on a path our provider answers in Linux spelling, and a Windows `spawn` cannot use it — so the
  // call fails. If it ever starts succeeding, this row reddens as a moved premise, because that would mean
  // worktree-shaped packages CAN live in our world and the ledger's `sandbox` row would have to be re-judged
  // against a working confinement instead of a launch that never happened.
  let threw
  try {
    const created = await within(worktrees.create(wtAgent, { name: 'w92-confine-probe' }, AbortSignal.timeout(40_000)), 60_000, 'worktrees.create')
    add('worktree-confine', false, `create() SUCCEEDED inside the isolate: ${JSON.stringify(created).slice(0, 200)}`
      + ' — our no-op confinement passed the command and the launch worked, so the premise of this arm (a Linux-spelled cwd breaks a Windows spawn) no longer holds; re-judge the sandbox row before trusting any reading below')
  } catch (error) {
    threw = String(error?.message ?? error)
    const launchFailure = /ENOENT|spawn|EACCES| EINVAL/i.test(threw)
    add('worktree-confine', launchFailure, launchFailure
      ? `create() failed on the launch, as this shape predicts: ${threw.slice(0, 200)} · our confine() returned the argv unchanged (src/host/wsl-sandbox.ts:37), so the answer to "refuse or pass" is PASS — the command died one step later, on the path our fs handed back, not on confinement`
      : `create() failed for a reason that is not a launch: ${threw.slice(0, 220)} — this arm cannot answer the confinement question`)
  }
}, [['worktree', mountedPath('@deepseek-ai/dsh-experimental-worktree')]])

report()
