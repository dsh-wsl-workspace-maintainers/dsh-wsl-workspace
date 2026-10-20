// G5 — a real host, one real session, six real tool calls (issue #101).
//
//   npm run test:session
//   npm run test:session -- --verbose
//
// The map this belongs to says 8 of 20 experience-class defects were only ever reproduced on a real
// machine, and that the apparatus for it *already existed* — the behaviour matrix boots an isolated
// profile with a scripted provider for ¥0 — but nothing ran it in a gate and no declaration depended on
// its reading. This probe is that reading, narrowed to the six cells the map names:
//
//   bash · read · grep · glob · read_image · bash_background→job_output
//
// It boots **the product's own generated world**: the variant text comes from
// `transformPresetForWsl()` over a shipped preset, the `wsl-world` group is inserted into a real
// profile's overlay as-is (the group's own YAML is already an entry list), and the host starts every
// `file:` row in it. A row that fails to start is #89; a tool that starts and answers wrongly is
// #50/#51/#56/#54.
//
// What it needs: Windows + a WSL distribution (`WSL_COMPAT_DISTRO`, default `Ubuntu`), the pinned
// closure (`node ci/install-pinned.mjs`), and a built `lib/`. It is **not** in the per-commit CI: the
// boot takes seconds and the six calls take a distribution, so it is the release gate — which is what
// the `compatible` declaration is supposed to rest on (R4 in #101).
//
// One row per cell, and one row for the world itself. A cell this machine cannot answer (no
// distribution, no `python3` for a helper) is reported `false` with the reason rather than skipped:
// "not measured" must never read as "passed".
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { repoRoot, hostModule, hostRoots, inactiveDetail } from './host-closure.mjs'
import { finish } from './report.mjs'

const DISTRO = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-g5-session-'))
const rows = []
const add = (id, ok, detail) => { rows.push({ id, ok, detail }); if (process.argv.includes('--verbose')) console.log(`${ok ? 'ok  ' : 'RED '} ${id}: ${detail}`) }
const outOf = error => String(error?.message ?? error ?? 'unknown')

/** A bounded await whose timer is deliberately not unref'd (an unref'd watchdog can exit 0 mid-await). */
const within = (promise, ms, label) => Promise.race([
  Promise.resolve(promise),
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
])

const lib = file => join(repoRoot, 'lib', file).replaceAll('\\', '/')

/** Read one fact from the distribution, through `wsl.exe`. */
function inDistro(command) {
  const run = spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'bash', '-lc', command], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`wsl -d ${DISTRO} exited ${run.status}: ${(run.stderr ?? '').trim()}`)
  return (run.stdout ?? '').trim()
}

const verdict = (ok, detail) => ({ ok, detail })

/**
 * The ceiling for one tool cell, in milliseconds.
 *
 * Issue #25 was "every request on a UNC workspace takes about thirty seconds and then ends": a
 * per-call ceiling is the only reading that turns that into a red row instead of a slow pass, and the
 * numbers are what a healthy session measures here (bash 986 ms, read/grep/glob 2.6–3.1 s) with room
 * for a cold distribution and a runner that is not this machine.
 */
const CEILING_MS = { 'tool-bash': 25_000, 'tool-read': 15_000, 'tool-grep': 15_000, 'tool-glob': 15_000, 'tool-read-image': 15_000, 'tool-job-output': 15_000 }

/**
 * Cells this harness cannot measure, with the reason that makes the gap a reading rather than a shrug.
 *
 * `tool-job-output` is one: the job tools ask the agent registry whether the owner is live before they
 * answer ("session \"agent-g5\" has no live agent"), and a probe carries a synthetic session, so the
 * ownership gate can never pass here. The row still has to *say what it saw* — the declared reason is a
 * regex over the message — so "the tool refused for the ownership reason" and "the tool said nothing"
 * stay distinguishable. When the cell starts answering with bytes the declaration reddens: the day a
 * live agent exists in a probe, this entry must go.
 */
const DECLARED_NOT_MEASURED = new Map([
  ['tool-job-output', {
    reason: new RegExp('no live agent|background job ownership requires the agent registry'),
    note: 'the ownership gate needs a live agent; a probe session cannot pass it',
  }],
])
/** Whether one reading is inside its ceiling; folded into the cell so a slow call cannot pass. */
const inside = (id, ms) => ms <= (CEILING_MS[id] ?? 30_000)

async function main() {
  // ── the world this product would mount ────────────────────────────────────────────────────────────
  const { transformPresetForWsl } = await import(pathToFileURL(join(repoRoot, 'src', 'host', 'variants.ts')).href)
  const presetFile = join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  const lines = readFileSync(presetFile, 'utf8').split('\n')
  const indentOf = line => line.match(new RegExp('^[ ]*'))[0].length
  const at = lines.findIndex(line => new RegExp('^[ ]+plugins:[ ]*$').test(line))
  const base = indentOf(lines[at])
  const body = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && indentOf(line) <= base - 2) break
    body.push(line.slice(Math.min(base + 2, line.length)))
  }
  const variant = transformPresetForWsl(
    body.join('\n'),
    lib('shell.js'),
    lib('fs.js'),
    {
      relayPath: lib('wsl-relay.js'),
      nodePath: process.execPath.replaceAll('\\', '/'),
      sandboxPath: lib('wsl-sandbox.js'),
      bashPath: lib('wsl-bash-tool.js'),
      terminalTool: lib('wsl-terminal-tool.js'),
      mode: 'session',
    },
    lib('wsl-search.js'),
    lib('wsl-jobs.js'),
    lib('wsl-image-tool.js'),
  )

  // ── the host that mounts it ───────────────────────────────────────────────────────────────────────
  const profileBootFile = hostRoots()
    .map(root => join(root, '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js'))
    .find(candidate => { try { readFileSync(candidate); return true } catch { return false } })
  if (profileBootFile === undefined) throw new Error('@deepseek-ai/dsh/lib/profile-boot.js is in neither linked tree — run `node ci/install-pinned.mjs`')
  const { runProfile } = await import(pathToFileURL(profileBootFile).href)
  const { createLaunchEnvironmentSnapshot } = (await hostModule('@deepseek-ai/dsh-launch-environment')).namespace
  const providers = {
    'system-prompt': await hostModule('@deepseek-ai/dsh-system-prompt'),
    tools: await hostModule('@deepseek-ai/dsh-tools'),
    'fs-local': await hostModule('@deepseek-ai/dsh-fs-local'),
    attachment: await hostModule('@deepseek-ai/dsh-attachment-local'),
    llm: await hostModule('@deepseek-ai/dsh-llm'),
    'tool-fs': await hostModule('@deepseek-ai/dsh-tool-fs'),
    webserver: await hostModule('@deepseek-ai/dsh-host-webserver'),
    'working-directory': await hostModule('@deepseek-ai/dsh-working-directory'),
    'session-projection': await hostModule('@deepseek-ai/dsh-session-projection'),
    // The four services the world's own rows inject but do not provide: `shell-wsl` starts a process
    // through `subprocess`, the keyboard door needs a `terminals` registry and a `sandboxPolicy`, and the
    // background producer needs a jobs registry (that absence is exactly what #56's user saw). The
    // product's profile supplies all four; a probe without them measures a world that cannot start.
    // `dsh-subprocess` is the abstract vocabulary; the spawner is `-local` (it is the one that
    // implements `spawn`/`spawnTerminal`). Mounting the abstract one leaves `subprocess.spawn`
    // undefined, which reads as "this host exposes no subprocess service".
    subprocess: await hostModule('@deepseek-ai/dsh-subprocess-local'),
    'sandbox-policy': await hostModule('@deepseek-ai/dsh-sandbox-policy'),
    // The registry the background producer feeds (issue #56). Pinned into the closure on 2026-10-20 so
    // this probe can assert the *bytes* rather than the named absence.
    'jobs-local': await hostModule('@deepseek-ai/dsh-jobs-local'),
    'tool-jobs': await hostModule('@deepseek-ai/dsh-tool-jobs'),
    // The ownership gate the job tools ask before they answer: "background job ownership requires the
    // agent registry (load @deepseek-ai/dsh-agent)" — the same missing-peer shape as `dsh-jobs` itself.
    agents: await hostModule('@deepseek-ai/dsh-agent'),
    'sandbox-local': await hostModule('@deepseek-ai/dsh-sandbox-local'),
    terminal: await hostModule('@deepseek-ai/dsh-terminal'),
  }
  const row = (id, file) => [`    - id: ${id}`, `      name: '${file.replaceAll('\\', '/')}'`]

  // The world's own group, verbatim: its text is already an entry list at the right indentation, so
  // re-indenting it into an overlay row is the whole conversion (the same rule the variant publisher uses).
  const worldAt = variant.split('\n').findIndex(line => line === '- id: wsl-world')
  if (worldAt < 0) throw new Error('the generated variant carries no `- id: wsl-world` group')
  const worldRows = variant.split('\n').slice(worldAt)
    .filter(line => line.trim() !== '')
    .map((line, index) => (index === 0 ? `    - ${line.replace(/^- /, '')}` : `    ${line}`))

  const overlayRows = [
    ...row('system-prompt', providers['system-prompt'].file),
    ...row('tools', providers.tools.file),
    ...row('attachment', providers.attachment.file),
    ...row('llm', providers.llm.file),
    ...row('fs-local', providers['fs-local'].file),
    ...row('tool-fs', providers['tool-fs'].file),
    ...row('session-projection', providers['session-projection'].file),
    ...row('working-directory', providers['working-directory'].file),
    ...row('subprocess', providers.subprocess.file),
    ...row('sandbox-local', providers['sandbox-local'].file),
    ...row('sandbox-policy', providers['sandbox-policy'].file),
    ...row('jobs-local', providers['jobs-local'].file),
    ...row('tool-jobs', providers['tool-jobs'].file),
    ...row('agents', providers.agents.file),
    ...row('terminal', providers.terminal.file),
    ...row('webserver', providers.webserver.file),
    '      config:',
    '        host: 127.0.0.1',
    '        port: 0',
    ...worldRows,
  ]

  const home = join(SCRATCH, 'home')
  const profileDir = join(home, 'profiles', 'g5')
  const scope = join(profileDir, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  // A profile is a directory with a manifest, and the three packages the world's fs rows resolve through
  // must be visible in its own scope — the same shape `dsh plugin add` produces (w54's `makeProfile`).
  const closure = join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai')
  for (const pkg of ['dsh-tool-fs', 'dsh-attachment-local', 'dsh-attachment']) {
    symlinkSync(join(closure, pkg), join(scope, pkg), 'junction')
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-g5', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(profileDir, 'overlay.yml'), ['- insert:', ...overlayRows, ''].join('\n'), 'utf8')
  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])

  // ── the session every tool call carries ───────────────────────────────────────────────────────────
  const linuxHome = inDistro('printf %s "$HOME"')
  const linuxUser = inDistro('id -un')
  const uncCwd = `\\\\wsl.localhost\\${DISTRO}${linuxHome.replaceAll('/', '\\')}`
  const { Session, SESSION_FORMAT_VERSION } = (await hostModule('@deepseek-ai/dsh-session')).namespace
  const session = Session.create('g5-session', undefined, {
    version: SESSION_FORMAT_VERSION, id: 'g5-session', createdAt: Date.now(), isSeeded: false, cwd: uncCwd,
  })
  const execution = () => ({
    signal: AbortSignal.timeout(60_000),
    agent: {
      id: 'agent-g5',
      options: { provider: 'g5-probe', model: 'g5-probe' },
      ctx: { fiber: { assertActive: () => {} } },
      session,
    },
  })

  const boot = await within(runProfile({ environment, profile: 'g5', patchFiles: [join(profileDir, 'overlay.yml')], args: [] }), 120_000, 'boot g5')
  try {
    const ctx = boot.ctx
    // Every row in the world is a `file:` row; a row that never started is what #89 reported.
    const inactive = await inactiveDetail(ctx, ctx.get('loader'))
    add('world-rows-activated', inactive === '', inactive === ''
      ? `every loader entry in the generated world reached state 2 (distro ${DISTRO}, session cwd ${uncCwd})`
      : `entries did not activate: ${inactive}`)

    const call = async (name, args, budget = 60_000) => {
      const tool = ctx.get('tools').get(name)
      if (tool === undefined) throw new Error(`${name} is not registered in this world`)
      const started = Date.now()
      const value = await within(tool.execute(args, execution()), budget, `${name}.execute`)
      return { value, ms: Date.now() - started }
    }

    // bash — #50/#51's cell: a PTY-less persistent shell inside the distribution.
    try {
      const { value, ms } = await call('bash', { command: 'printf G5_BASH_OK; pwd', description: 'g5: bash answers inside the distribution' })
      const text = JSON.stringify(value)
      const answered = text.includes('G5_BASH_OK') && text.includes(linuxHome)
      add('tool-bash', answered && inside('tool-bash', ms), `${ms}ms (ceiling ${CEILING_MS['tool-bash']}ms) ${text.slice(0, 200)}`)
    } catch (error) { add('tool-bash', false, outOf(error)) }

    // A file the next three cells can name, written through the world itself.
    try {
      await call('bash', { command: 'mkdir -p /tmp/g5probe && printf "g5 alpha\\ng5 beta\\n" > /tmp/g5probe/g5-probe.txt', description: 'g5: seed a file' })
    } catch (error) { add('seed-file', false, outOf(error)) }

    // read — the host's fs suite through the world's fs.
    try {
      const { value, ms } = await call('read', { file_path: '/tmp/g5probe/g5-probe.txt' })
      const text = JSON.stringify(value)
      add('tool-read', text.includes('g5 alpha') && inside('tool-read', ms), `${ms}ms (ceiling ${CEILING_MS['tool-read']}ms) ${text.slice(0, 180)}`)
    } catch (error) { add('tool-read', false, outOf(error)) }

    // grep / glob — #86's cell, from a UNC session cwd.
    try {
      const { value, ms } = await call('grep', { pattern: 'g5 (alpha|beta)', path: '/tmp/g5probe/g5-probe.txt' })
      const text = JSON.stringify(value)
      add('tool-grep', text.includes('alpha') && inside('tool-grep', ms), `${ms}ms (ceiling ${CEILING_MS['tool-grep']}ms) ${text.slice(0, 200)}`)
    } catch (error) { add('tool-grep', false, outOf(error)) }
    try {
      const { value, ms } = await call('glob', { pattern: 'g5-*.txt', path: '/tmp/g5probe' })
      const text = JSON.stringify(value)
      add('tool-glob', text.includes('g5-probe.txt') && inside('tool-glob', ms), `${ms}ms (ceiling ${CEILING_MS['tool-glob']}ms) ${text.slice(0, 200)}`)
    } catch (error) { add('tool-glob', false, outOf(error)) }

    // read_image — #54's cell: the world answers for the name, not the host suite's injected fs. The
    // tool's own gate asks the llm service whether the session's route accepts images, so the probe
    // registers a route the way a model provider would (w54's `declareRoute`), and stops there: this
    // probe never streams a completion.
    try {
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('no llm service mounted — the image route gate cannot be satisfied')
      llm.registerAdapter(['g5-probe'], {
        providerInfo: provider => ({ id: provider, name: provider }),
        providerRetryPolicy: () => undefined,
        async listModels() { return [] },
        async resolveModel(provider, model) {
          return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 128_000 } }
        },
        async prepareCall() { throw new Error('g5-session never streams a completion') },
        async * stream() {},
      })
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      await call('bash', { command: `mkdir -p /tmp/g5probe && printf %s ${png} | base64 -d > /tmp/g5probe/g5-probe.png`, description: 'g5: seed a png' })
      const { value, ms } = await call('read_image', { file_path: '/tmp/g5probe/g5-probe.png' })
      const text = JSON.stringify(value)
      add('tool-read-image', text.includes('image') && inside('tool-read-image', ms), `${ms}ms (ceiling ${CEILING_MS['tool-read-image']}ms) ${text.slice(0, 180)}`)
    } catch (error) { add('tool-read-image', false, outOf(error)) }

    // bash_background → job_output — #56's cell, and the reason `@deepseek-ai/dsh-jobs` was pinned into
    // the closure. With the registry mounted the cell asks for the **bytes**: the background producer
    // must feed the ring the registry reads, which is what 0.7.5 got wrong (it returned `readOutput`
    // from `run()`, and 0.2.x only pumps `spec.output`, so `job_output` answered "(no new output)"
    // forever). The named-absence arm stays for a deployment that genuinely mounts no registry, but it
    // is only allowed to pass when the service really is absent — otherwise "the rows did not load" and
    // "this host has no jobs" would be the same green.
    const jobsMounted = ctx.get('jobs') !== undefined
    try {
      const started = await call('bash', { command: 'printf g5-job-line; sleep 1', description: 'g5: background job', run_in_background: true })
      const jobText = JSON.stringify(started.value)
      const id = jobText.match(new RegExp('bash-[0-9]+'))?.[0]
      if (id === undefined) throw new Error(`no job id in ${jobText.slice(0, 200)}`)
      await new Promise(resolve => setTimeout(resolve, 2500))
      const { value, ms } = await call('job_output', { job_id: id })
      const text = JSON.stringify(value)
      if (/\(no new output\)/.test(text)) {
        add('tool-job-output', false, `${ms}ms job ${id}: the ring is empty — this is #56 verbatim: ${text.slice(0, 200)}`)
      } else if (text.includes('g5-job-line')) {
        add('tool-job-output', inside('tool-job-output', ms), `${ms}ms (ceiling ${CEILING_MS['tool-job-output']}ms) job ${id}: the ring carried the bytes — ${text.slice(0, 180)}`)
      } else if (new RegExp('background jobs unavailable|no jobs registry|mounts no jobs').test(text)) {
        add('tool-job-output', jobsMounted === false, `${ms}ms job ${id}: no jobs registry mounted (jobs service ${jobsMounted ? 'present' : 'absent'}), and the tool says so — ${text.slice(0, 180)}`)
      } else {
        add('tool-job-output', false, `${ms}ms job ${id}: neither the bytes nor a named refusal — ${text.slice(0, 240)}`)
      }
    } catch (error) {
      // The producer itself can refuse when the deployment mounts no jobs registry; that sentence is a
      // reading (the absence is named, which is what #56's user did not get), not a failed cell — provided
      // the service really is absent.
      const message = outOf(error)
      const named = new RegExp('background jobs unavailable|no jobs registry|mounts no jobs').test(message)
      add('tool-job-output', named && jobsMounted === false,
        named
          ? `producer refused (jobs service ${jobsMounted ? 'present — the rows loaded but the registry is unreachable' : 'absent, as expected'}): ${message.slice(0, 200)}`
          : message)
    }
  } finally {
    await within(boot.shutdown.shutdown(0), 30_000, 'shutdown g5').catch(() => {})
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  // A declared gap is not a pass, and it is not a failure either: it is printed with its reason and
  // counted separately. Anything else that is red stays red.
  const notMeasured = []
  for (const row of rows) {
    const declared = DECLARED_NOT_MEASURED.get(row.id)
    if (declared === undefined) continue
    if (row.ok === true && /ring carried the bytes/.test(String(row.detail))) {
      row.ok = false
      row.detail = `${row.detail} — but this cell is declared NOT MEASURED: delete its entry from DECLARED_NOT_MEASURED`
      continue
    }
    if (row.ok === false && declared.reason.test(String(row.detail))) {
      row.ok = true
      row.detail = `NOT MEASURED (declared): ${declared.note} — tool said: ${String(row.detail).slice(0, 180)}`
      notMeasured.push(row.id)
    }
  }

  finish(rows, {
    label: 'G5-SESSION',
    summary: ` — one real host, one ${DISTRO} session, six tool cells`,
    metrics: { distro: DISTRO, linuxUser, ceilingsMs: CEILING_MS, notMeasured: notMeasured.join(',') || 'none' },
  })
}

main().catch(error => {
  add('probe', false, `the probe itself died: ${outOf(error)}`)
  finish(rows, { label: 'G5-SESSION', summary: ' — the boot did not produce a reading' })
})
