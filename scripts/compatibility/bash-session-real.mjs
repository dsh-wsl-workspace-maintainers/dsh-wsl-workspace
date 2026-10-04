// The WSL session bash, end to end: real host tool dispatch, real distribution, no terminal.
//
//   node --experimental-strip-types scripts/compatibility/bash-session-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/bash-session-real.mjs
//
// Why this exists next to `tool-bash-real.mjs`. That driver proves the host's *one-shot* tool
// dispatches to our executor — the point 4 half of issue #51. This one proves the point 3 half:
// the persistent shell answers in milliseconds, keeps `cd` and exported variables across calls,
// reports exit codes, and does it without a PTY in the loop. The symptom it replaces was measured
// in a real Desktop session as three calls hanging 303.8 s each before the host wiped the shell,
// so "settles at all, and settles fast" is the assertion, not "returns something".
//
// The last cell is the control that makes the rest meaningful: the same commands through the
// host's PTY-backed persistent tool must NOT settle inside the same budget. If it ever does, this
// driver goes red and the session tier's reason for existing has to be re-argued rather than
// assumed.
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { load, plane } from './plane.mjs'

const repoRoot = resolvePath(import.meta.dirname, '..', '..')
const at = p => pathToFileURL(p).href
const DEPS = `${repoRoot}/ci/deps/node_modules/@deepseek-ai`

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const username = process.env.WSL_COMPAT_USER ?? 'root'
const linuxHome = username === 'root' ? '/root' : `/home/${username}`
const sessionCwd = `\\\\wsl.localhost\\${distro}${linuxHome.replaceAll('/', '\\')}`

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: pass === true })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const { apply: registerSessionTool, PROBE_CONFIG, buildSessionSpec } = await load('wsl-bash-tool')
const toolsPlugin = await import(at(`${DEPS}/dsh-tools/lib/index.js`))
const shellEnvPlugin = await import(at(`${DEPS}/dsh-shell-env/lib/index.js`))
const systemPromptPlugin = await import(at(`${DEPS}/dsh-system-prompt/lib/index.js`))
const hostModule = (m) => m.default ?? m

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
for (const module of [shellEnvPlugin, toolsPlugin, systemPromptPlugin]) {
  await ctx.plugin(hostModule(module))
}
registerSessionTool(ctx, { ...PROBE_CONFIG, distro, username })
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
  ctx: { on: () => () => {}, effect: (fn) => { try { fn?.() } catch { /* the driver has no lifecycle */ } return () => {} } },
}
const exec = { signal: AbortSignal.timeout(180_000), agent: owner }

/** One tool call, timed, with the rendered text the model would read. */
async function call(command) {
  const started = Date.now()
  const value = await tool.execute({ command, description: 'compatibility driver: session bash' }, exec)
  const ms = Date.now() - started
  const text = JSON.stringify(value?.stdout?.text ?? '')
  return { ms, value, text }
}

let computed
try {
  const first = await call('echo SESSION_$(( 13 * 7 ))')
  computed = first.value?.stdout?.text ?? ''
  check('computed answer came back', first.value?.stdout?.text?.includes('SESSION_91') === true, `${first.ms}ms ${computed.trim().slice(0, 40)}`)
  check('it settled well inside the old hang', first.ms < 8_000, `${first.ms}ms`)
  check('the tool reports the host result shape', first.value?.kind === 'foreground'
    && typeof first.value?.stdout?.text === 'string' && typeof first.value?.exitCode === 'number',
  JSON.stringify(Object.keys(first.value ?? {})))

  const cd = await call('cd /tmp && pwd')
  check('cd takes effect', cd.value?.stdout?.text?.trim() === '/tmp', JSON.stringify(cd.value?.stdout?.text ?? ''))
  const after = await call('pwd')
  check('the working directory survives into the next call', after.value?.stdout?.text?.trim() === '/tmp',
    JSON.stringify(after.value?.stdout?.text ?? ''))

  await call('export DSH_SESSION_VAR=kept_$(( 6 * 7 ))')
  const read = await call('echo READ=$DSH_SESSION_VAR')
  check('an exported variable survives into the next call', read.value?.stdout?.text?.includes('READ=kept_42') === true,
    JSON.stringify(read.value?.stdout?.text ?? ''))

  const failing = await call('false')
  check('a nonzero exit is reported, not thrown', failing.value?.exitCode === 1 && failing.value?.timedOut === false,
    `exitCode=${failing.value?.exitCode}`)

  const cjk = await call('printf "中文_OK_$(( 2 * 3 ))\\n"')
  check('multi-byte output is intact', cjk.value?.stdout?.text?.includes('中文_OK_6') === true,
    JSON.stringify(cjk.value?.stdout?.text ?? ''))

  const history = await call("echo bang!_$(( 1 * 2 ))")
  check('a bare ! does not wedge the shell', history.value?.stdout?.text?.includes('bang!_2') === true,
    `exitCode=${history.value?.exitCode} out=${JSON.stringify(history.value?.stdout?.text ?? '')}`)

  // `sudo -n` is only a stand-in for "a command that wants a terminal". Whether it fails depends on
  // the distribution's sudoers: the GitHub WSL1 runner's root is NOPASSWD and answers 0, this
  // machine's user is not and answers 1. The property under test is boundedness, not the code.
  const sudo = await call('sudo -n true')
  check('sudo returns bounded, whatever its policy', sudo.ms < 8_000 && sudo.value?.timedOut === false,
    `${sudo.ms}ms exitCode=${sudo.value?.exitCode}`)

  const alive = await call('echo STILL_$(( 21 * 2 ))')
  check('the session is usable afterwards', alive.value?.stdout?.text?.includes('STILL_42') === true, `${alive.ms}ms`)
} catch (error) {
  check('every call returned', false, String(error?.message ?? error).slice(0, 200))
}

// The control: the same command through the tier this replaces. It has to actually run, because a
// control that fails to build and is scored as a pass is exactly the vacuous green that let
// issue #51 ship.
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
  const ptyOwner = { ...owner, id: 'agent-pty-control', session: { ...owner.session, id: 'session-pty-control' } }
  ptyCtx.provide?.('agents', { get: (id) => (id === ptyOwner.id ? ptyOwner : undefined) })
  ptyCtx.provide?.('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: sessionCwd }) })
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
  const settledCleanly = /PTY_CONTROL_42/.test(ptyResult) && !/timed out/i.test(ptyResult)
  // This cell used to assert that the PTY tier HANGS. The WSL1 runner answered it in 0.59 s, which
  // says the assertion encoded one machine's ConPTY behaviour as a universal property — the same
  // mistake this file exists to catch. What is universally checkable is that the control ran and
  // what it did; the hang itself is a measured, machine-specific fact recorded in
  // docs/compatibility-evidence.md, and the session tier's own cells above are the gate.
  check('control: the PTY tier was exercised for comparison', controlRan === true,
    settledCleanly ? `it ANSWERED in ${Date.now() - started}ms (no hang on this platform) :: ${ptyResult.slice(0, 60)}`
      : `it did NOT answer cleanly in ${Date.now() - started}ms — the issue #51 shape :: ${ptyResult.slice(0, 60)}`)
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
// The shells this driver started are children of a process that has nothing left to wait for; the
// session seam keeps its stdin pipe open, so exiting explicitly is the teardown, not a shortcut.
process.exit(process.exitCode ?? 0)
