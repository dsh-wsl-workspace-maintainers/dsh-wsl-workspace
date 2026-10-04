// The WSL session bash, end to end: real host tool dispatch, real distribution, no terminal.
//
//   node --experimental-strip-types scripts/compatibility/bash-session-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/bash-session-real.mjs
//
// Why this exists next to `tool-bash-real.mjs`. That driver proves the host's *one-shot* tool
// dispatches to our executor — the point 4 half of issue #51. This one proves the point 3 half:
// the persistent shell answers in milliseconds, keeps `cd` and exported variables across calls,
// reports exit codes, and does it without a PTY in the loop. The symptom it replaces was measured
// in a real Desktop session as three calls hanging 303.8 s each before the host wiped the shell.
//
// The tool is loaded through `ctx.plugin`, the channel the host uses. An earlier revision called
// `apply()` by hand on a raw Context and reported 13/13 on two planes and two platforms while every
// real call failed in Desktop with `cannot get property "subprocess" without inject`: a raw context
// resolves properties that a plugin-scoped one refuses unless the module declares them in `inject`.
// That is the whole lesson — a driver that does not enter through the point the product uses is
// measuring the driver.
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolve as resolvePath } from 'node:path'
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

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: pass === true })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const toolsPlugin = await import(at(`${DEPS}/dsh-tools/lib/index.js`))
const shellEnvPlugin = await import(at(`${DEPS}/dsh-shell-env/lib/index.js`))
const systemPromptPlugin = await import(at(`${DEPS}/dsh-system-prompt/lib/index.js`))
const sessionTool = await load('wsl-bash-tool')

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
for (const module of [shellEnvPlugin, toolsPlugin, systemPromptPlugin]) {
  await ctx.plugin(hostModule(module))
}
await ctx.plugin(sessionTool.default ?? sessionTool, { ...sessionTool.PROBE_CONFIG, distro, username })
await new Promise(resolve => setTimeout(resolve, 50))

const tool = ctx.tools.get('bash')
check('bash tool registered by the plugin', tool !== undefined, `ctx.tools.get('bash') -> ${typeof tool}`)
if (tool === undefined) {
  console.log('bash-session-real: RED — nothing to call; the driver would prove nothing')
  process.exit(1)
}

const owner = {
  id: 'agent-bash-session',
  session: { id: 'session-bash-session', cwd: sessionCwd, header: { cwd: sessionCwd, id: 'session-bash-session' } },
  ctx: { on: () => () => {}, effect: (fn) => { try { fn?.() } catch { /* the driver has no lifecycle to keep */ } return () => {} } },
}
const exec = { signal: AbortSignal.timeout(180_000), agent: owner }

/** One tool call, timed, with the text the model would read. */
async function call(command) {
  const started = Date.now()
  const value = await tool.execute({ command, description: 'compatibility driver: session bash' }, exec)
  return { ms: Date.now() - started, value, text: String(value?.stdout?.text ?? '') }
}

try {
  const first = await call('echo SESSION_$(( 13 * 7 ))')
  check('computed answer came back', first.text.includes('SESSION_91'), `${first.ms}ms ${first.text.trim().slice(0, 40)}`)
  check('it settled well inside the old hang', first.ms < 8_000, `${first.ms}ms`)
  check('the tool reports the host result shape', first.value?.kind === 'foreground'
    && typeof first.value?.stdout?.text === 'string' && typeof first.value?.exitCode === 'number',
  JSON.stringify(Object.keys(first.value ?? {})))

  const cd = await call('cd /tmp && pwd')
  check('cd takes effect', cd.text.trim() === '/tmp', JSON.stringify(cd.text))
  const after = await call('pwd')
  check('the working directory survives into the next call', after.text.trim() === '/tmp', JSON.stringify(after.text))

  await call('export DSH_SESSION_VAR=kept_$(( 6 * 7 ))')
  const read = await call('echo READ=$DSH_SESSION_VAR')
  check('an exported variable survives into the next call', read.text.includes('READ=kept_42'), JSON.stringify(read.text))

  const failing = await call('false')
  check('a nonzero exit is reported, not thrown', failing.value?.exitCode === 1 && failing.value?.timedOut === false,
    `exitCode=${failing.value?.exitCode}`)

  const cjk = await call('printf "中文_OK_$(( 2 * 3 ))\\n"')
  check('multi-byte output is intact', cjk.text.includes('中文_OK_6'), JSON.stringify(cjk.text))

  const history = await call('echo bang!_$(( 1 * 2 ))')
  check('a bare ! does not wedge the shell', history.text.includes('bang!_2'), `exitCode=${history.value?.exitCode}`)

  // `sudo -n` only stands in for "a command that wants a terminal". Whether it succeeds depends on
  // the distribution's sudoers — the GitHub WSL1 runner's root is NOPASSWD (exit 0), this machine's
  // user is not (exit 1) — so the property asserted is boundedness, not the code.
  const sudo = await call('sudo -n true')
  check('sudo returns bounded, whatever its policy', sudo.ms < 8_000 && sudo.value?.timedOut === false,
    `${sudo.ms}ms exitCode=${sudo.value?.exitCode}`)

  const alive = await call('echo STILL_$(( 21 * 2 ))')
  check('the session is usable afterwards', alive.text.includes('STILL_42'), `${alive.ms}ms`)
} catch (error) {
  check('every call returned', false, String(error?.message ?? error).slice(0, 200))
}

// The control: the same command through the tier this replaces. It asserts only that the control
// RAN, and prints which outcome happened. An earlier revision required it to hang, which promoted
// one machine's pseudo-console behaviour to a universal rule and was disproved by the WSL1 runner
// answering in 0.59 s; the hang is a measurement in docs/compatibility-evidence.md, not a gate.
let controlRan = false
try {
  const terminalService = await import(at(`${DEPS}/dsh-terminal/lib/index.js`))
  const terminalBash = await import(at(`${DEPS}/dsh-terminal-bash/lib/index.js`))
  const persistent = await import(at(`${DEPS}/dsh-tool-bash-persistent/lib/index.js`))
  const ptyCtx = new Context()
  await ptyCtx.plugin(LocalSubprocessRuntime)
  for (const module of [shellEnvPlugin, toolsPlugin, systemPromptPlugin, terminalService]) {
    await ptyCtx.plugin(hostModule(module))
  }
  // The control starts in `/tmp`, not in the driver's own session directory. The PTY backend builds
  // the child environment itself (`dsh-terminal-bash` `childEnvironment`, a fixed set: TERM, PS1,
  // PROMPT_COMMAND …), so `DSH_WSL_USER` never reaches the relay and the shell comes up as the
  // distribution's default user — which cannot enter `/root` when the driver is pointed at root, and
  // the tier then dies during startup instead of comparing. `/tmp` is enterable by every user, and
  // the command under comparison does not depend on the directory.
  const ptyCwd = `\\\\wsl.localhost\\${distro}\\tmp`
  const ptyOwner = {
    ...owner,
    id: 'agent-pty-control',
    session: { id: 'session-pty-control', cwd: ptyCwd, header: { cwd: ptyCwd, id: 'session-pty-control' } },
  }
  ptyCtx.provide?.('agents', { get: (id) => (id === ptyOwner.id ? ptyOwner : undefined) })
  ptyCtx.provide?.('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ptyCwd }) })
  const { resolveRelayNode } = await import(pathToFileURL(`${repoRoot}/src/shared/relay-node.ts`).href)
  const relay = await resolveRelayNode()
  await terminalBash.apply(ptyCtx, new terminalBash.Config({
    backendType: 'wsl', shellDialect: 'bash', shellPath: relay?.path ?? process.execPath,
    shellArgs: [`${repoRoot}/lib/wsl-relay.js`],
  }))
  await persistent.apply(ptyCtx, new persistent.Config({ backendType: 'wsl', timeoutMs: 8_000 }))
  const ptyTool = ptyCtx.tools.get('bash')
  controlRan = ptyTool !== undefined
  const started = Date.now()
  const ptyResult = String(await ptyTool.execute({ command: 'echo PTY_CONTROL_$(( 6 * 7 ))', description: 'control' },
    { signal: AbortSignal.timeout(30_000), agent: ptyOwner }))
  const hung = /timed out/i.test(ptyResult) || !/PTY_CONTROL_42/.test(ptyResult)
  check('control: the PTY tier was exercised for comparison', controlRan === true,
    hung ? `it did NOT answer cleanly in ${Date.now() - started}ms — the issue #51 shape :: ${ptyResult.slice(0, 60)}`
      : `it ANSWERED in ${Date.now() - started}ms (no hang on this platform) :: ${ptyResult.slice(0, 60)}`)
} catch (error) {
  check('control: the PTY tier was exercised for comparison', false,
    `the control harness failed before comparing: ${String(error?.message ?? error).slice(0, 120)}`)
}

const EXPECTED_CHECKS = 13
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} checks passed (plane=${plane()}, distro=${distro}, user=${username}, cwd=${sessionCwd})`)
if (results.length !== EXPECTED_CHECKS) {
  console.error(`bash-session-real: RED — ran ${results.length} checks, expected ${EXPECTED_CHECKS}; a short run must not report green`)
  process.exitCode = 1
} else if (passed !== results.length) {
  console.error('bash-session-real: RED — at least one check failed')
  process.exitCode = 1
}
// The shells this driver started keep their stdin pipes open; exiting explicitly is the teardown,
// not a shortcut.
process.exit(process.exitCode ?? 0)
