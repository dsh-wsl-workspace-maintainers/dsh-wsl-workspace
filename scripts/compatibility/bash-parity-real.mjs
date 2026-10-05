// The same probe script, run through two real `bash` tools, with the answers compared field by
// field: the host's one-shot tool dispatching to this plugin's executor, and this plugin's session
// tool. Every difference the run finds must be a row in `docs/bash-parity.md`, and every row that
// claims alignment must still be aligned.
//
//   node --experimental-strip-types scripts/compatibility/bash-parity-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/bash-parity-real.mjs
//
// Why a differential and not more assertions. The session tier is a replacement for a tool the model
// already knows how to use, so "it works" is the wrong bar: the right bar is "the same call gets the
// same kind of answer". That is only checkable by asking both, and the answer set is small enough to
// compare mechanically. Where the two disagree, the disagreement is either declared in the ledger or
// this driver is red — a difference nobody wrote down is the thing that surprises a user.
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { load, plane } from './plane.mjs'

const repoRoot = resolvePath(import.meta.dirname, '..', '..')
const at = p => pathToFileURL(p).href
const DEPS = `${repoRoot}/ci/deps/node_modules/@deepseek-ai`
const hostModule = (m) => m.default ?? m

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const username = process.env.WSL_COMPAT_USER ?? 'root'
const linuxHome = username === 'root' ? '/root' : `/home/${username}`
const sessionCwd = `\\\\wsl.localhost\\${distro}${linuxHome.replaceAll('/', '\\')}`

const host = (name) => {
  for (const root of [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]) {
    const candidate = join(root, ...name.split('/'), 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * One probe. `row` names the ledger entry that licenses a difference; `aligned` rows must agree.
 * `timeoutMs` keeps every call bounded, and `sessionOnly` skips the comparison for probes the
 * one-shot world cannot answer without services an in-process harness does not mount (jobs).
 */
const probes = [
  { name: 'computed echo', args: { command: 'echo PARITY_$(( 13 * 7 ))' } },
  { name: 'nonzero exit', args: { command: 'false' } },
  { name: 'stderr separated', args: { command: 'echo out; echo err >&2' } },
  { name: 'absolute workdir', args: { command: 'pwd', workdir: '/tmp' } },
  { name: 'relative workdir', row: 'behaviour-workdir-missing-layer', args: { command: 'pwd', workdir: 'definitely-not-here-parity' } },
  { name: 'large output spills', row: 'behaviour-spill-shape', normalize: 'numbers', args: { command: 'seq 1 200000', timeoutMs: 60_000 } },
  { name: 'prompt is empty', args: { command: 'printf "PS1=[%s]\\n" "$PS1"' } },
  { name: 'no controlling terminal', args: { command: 'tty; stty size 2>&1' } },
  { name: 'interactive flags', row: 'behaviour-interactive-flags', args: { command: 'echo flags=$-' } },
  // Measured against the distribution's own `bash -ic` on 2026-10-05: an alias used on the line that
  // defines it is not yet an alias there either, so the *failure* is bash's rule and not a difference
  // between these two worlds. What differs is who reports it — the interactive shell sources the
  // distribution's command-not-found handler, the one-shot shell does not — and a model that reads a
  // suggestion sentence should be able to tell which world it is in.
  { name: 'alias used on the line that defines it', row: 'behaviour-command-not-found', args: { command: 'alias dshparity=echo; dshparity HI_5' } },
  { name: 'state persists', row: 'behaviour-state-persistence', args: { command: 'echo READ_BACK=${PARITY_VAR:-unset}' } },
  { name: 'background arm shape', sessionOnly: true, args: { command: 'echo BG', run_in_background: true } },
  { name: 'timeout is reported', sessionOnly: true, args: { command: 'sleep 5', timeoutMs: 1_500 } },
]

/** The comparable shape of one answer: which fields are present, which markers the model reads, and
 * the body itself. Comparing only the fields would pass a tool that answers the right *kind* of
 * question with the wrong words. */
function signature(value, rendered, normalize) {
  const markers = [...String(rendered).matchAll(/\[(exit code|timed out after|killed by signal|output truncated|stderr|the shell[^\]]*|still running[^\]]*)/g)]
    .map(match => match[1].replace(/[^a-z ]/g, '').trim())
  const spillPath = value?.stdout?.spillPath
  return {
    kind: String(value?.kind ?? 'threw'),
    exitCode: value?.exitCode === null || value?.exitCode === undefined ? 'null' : typeof value.exitCode,
    signal: value?.signal === null || value?.signal === undefined ? 'null' : typeof value.signal,
    timedOut: String(value?.timedOut ?? 'absent'),
    truncated: String(value?.stdout?.truncated ?? 'absent'),
    spill: spillPath === undefined ? 'absent' : 'present',
    // The promise of a spill file is that it holds the whole stream, so that is what gets compared —
    // how many bytes each path keeps in memory is a buffer-cap detail of the two implementations.
    spillLines: spillPath === undefined ? 'absent' : readFileSync(spillPath, 'utf8').trim().split('\n').length,
    markers: [...new Set(markers)].sort().join(','),
    body: (normalize === 'numbers'
      ? String(rendered).replace(/\d+/g, 'N')
      : String(rendered)).replace(/dsh-subprocess-[A-Za-z0-9._+-]+/g, 'spill-path')
      .replace(/\\/g, '/').replace(/\s+/g, ' ').trim().slice(0, 120),
  }
}

async function worldOneShot() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  for (const name of ['@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
    await ctx.plugin(hostModule(await import(at(host(name)))))
  }
  const shellModule = await load('shell')
  const WslShellExecutor = shellModule.default ?? shellModule.WslShellExecutor
  await ctx.plugin(WslShellExecutor, {
    cwd: sessionCwd, distro, username, timeoutMs: 30_000, maxTimeoutMs: 60_000,
    maxOutputBytes: 64 * 1024, maxSpillBytes: 4 * 1024 * 1024, graceMs: 500,
  })
  const bash = await import(at(host('@deepseek-ai/dsh-tool-bash')))
  await bash.apply(ctx, new bash.Config({}))
  await new Promise(resolve => setTimeout(resolve, 50))
  const tool = ctx.tools.get('bash')
  return { tool, name: 'host one-shot', owner: ownerOf('parity-one-shot') }
}

async function worldSession() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  for (const module of [
    await import(at(host('@deepseek-ai/dsh-shell-env'))),
    await import(at(host('@deepseek-ai/dsh-tools'))),
    await import(at(host('@deepseek-ai/dsh-system-prompt'))),
  ]) await ctx.plugin(hostModule(module))
  const sessionTool = await load('wsl-bash-tool')
  // The same per-stream cap the one-shot world is mounted with above: comparing two tools with
  // different limits would measure the configuration, not the tools.
  await ctx.plugin(sessionTool.default ?? sessionTool,
    { ...sessionTool.PROBE_CONFIG, maxOutputBytes: 64 * 1024, distro, username })
  await new Promise(resolve => setTimeout(resolve, 50))
  return { tool: ctx.tools.get('bash'), name: 'session', owner: ownerOf('parity-session') }
}

function ownerOf(id) {
  const session = { id, cwd: sessionCwd, header: { cwd: sessionCwd, id } }
  return {
    id: `agent-${id}`,
    session,
    ctx: { on: () => () => {}, effect: (fn) => { try { fn?.() } catch { /* no lifecycle here */ } return () => {} } },
  }
}

const results = []
function check(name, pass, detail) {
  results.push(pass === true)
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const oneShot = await worldOneShot()
const session = await worldSession()
for (const world of [oneShot, session]) {
  if (world.tool === undefined) {
    console.log(`bash-parity-real: RED — the ${world.name} world mounted no bash tool; there is nothing to compare`)
    process.exit(1)
  }
}
// Seed the persistent world's variable; the probe that reads it is the point of seeding it.
await session.tool.execute({ command: 'export PARITY_VAR=kept_$(( 6 * 7 ))', description: 'seed' },
  { signal: AbortSignal.timeout(60_000), agent: session.owner })

const rows = readFileSync(join(repoRoot, 'docs', 'bash-parity.md'), 'utf8').split('\n')
  .flatMap((line) => {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|.*\|\s*([^|]+?)\s*\|\s*$/.exec(line)
    return match === null ? [] : [{ id: match[1], kind: match[2], verdict: match[3] }]
  })

const differences = []
for (const probe of probes) {
  const theirs = probe.sessionOnly === true ? { skipped: true } : await ask(oneShot, probe)
  const ours = await ask(session, probe)
  if (theirs.skipped === true) {
    console.log(`  skip ${probe.name} — the host's one-shot world cannot answer it without the jobs registry`)
    continue
  }
  const differs = JSON.stringify(theirs.signature) !== JSON.stringify(ours.signature)
  const row = probe.row === undefined ? undefined : rows.find(entry => entry.id === probe.row)
  const aligned = row !== undefined && /^aligned/.test(row.verdict)
  const detail = `${JSON.stringify(theirs.signature)} vs ${JSON.stringify(ours.signature)}`
  if (differs && row === undefined) {
    check(`${probe.name}: every difference is declared`, false, `undocumented: ${detail} — add a row to docs/bash-parity.md and name it in this probe`)
  } else if (differs && aligned) {
    check(`${probe.name}: the ledger says these worlds agree`, false, detail)
  } else if (!differs && row !== undefined && !aligned) {
    check(`${probe.name}: the ledger still says they differ`, false,
      `row ${row.id} declares a difference and the two worlds now answer identically — update docs/bash-parity.md`)
  } else {
    check(`${probe.name}: ${differs ? 'differs, as ' : 'agrees, as '}${row?.id ?? 'declared'}`, true, differs ? detail : undefined)
  }
  if (differs) differences.push(row?.id ?? 'UNDECLARED')
}

async function ask(world, probe) {
  const args = { ...probe.args, description: `bash-parity-real: ${probe.name}` }
  try {
    const value = await world.tool.execute(args, { signal: AbortSignal.timeout(90_000), agent: world.owner })
    const rendered = (world.tool.output?.render?.(args, value) ?? []).map(part => String(part?.text ?? '')).join('')
    return { signature: signature(value, rendered, probe.normalize) }
  } catch (error) {
    return { signature: { kind: 'threw', error: String(error?.message ?? error).slice(0, 60) } }
  }
}

const passed = results.filter(Boolean).length
console.log(`${passed}/${results.length} checks passed (plane=${plane()}, distro=${distro}, user=${username})`)
if (passed !== results.length || results.length === 0) {
  console.error('bash-parity-real: RED — a difference was found that the ledger does not license, or an aligned row drifted')
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
