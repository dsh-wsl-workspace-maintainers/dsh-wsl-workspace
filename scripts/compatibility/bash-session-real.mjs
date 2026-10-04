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
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
// The one-shot executor is mounted as well, because `run_in_background` hands the command to the
// jobs producer in `wsl-jobs.ts`, which runs it through `ctx.shell`. The registry itself is a double:
// `@deepseek-ai/dsh-jobs` is not vendored here, and what this driver can honestly assert is that the
// call reaches the producer with the right kind and answers in the host's shape — not that the host's
// registry stores it, which is the host's own tested behaviour.
const shellModule = await load('shell')
const WslShellExecutor = shellModule.default ?? shellModule.WslShellExecutor
await ctx.plugin(WslShellExecutor, {
  cwd: sessionCwd, distro, username, timeoutMs: 20_000, maxTimeoutMs: 60_000,
  maxOutputBytes: 64 * 1024, maxSpillBytes: 1024 * 1024, graceMs: 500,
})
let jobRequest
ctx.provide?.('jobs', {
  start: (request) => {
    jobRequest = request
    return 'job-dsh-session-real'
  },
})
const sessionFiber = ctx.plugin(sessionTool.default ?? sessionTool, { ...sessionTool.PROBE_CONFIG, distro, username })
await sessionFiber
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

const renderedBodies = []

/** One tool call, timed, with the text the model would read. */
async function call(command, options = {}) {
  const started = Date.now()
  const args = { command, description: 'compatibility driver: session bash', ...options }
  const value = await tool.execute(args, exec)
  const parts = tool?.output?.render?.(args, value) ?? []
  const rendered = parts.map(part => String(part?.text ?? '')).join('')
  renderedBodies.push(rendered)
  return { ms: Date.now() - started, value, text: String(value?.stdout?.text ?? ''), rendered }
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

  // The two cells that were missing when every real Desktop call came back with a fragment of our
  // own framing in `[stderr]`: every check above read `stdout.text`, and the leak was in the body the
  // model reads, which `output.render` composes from stdout *and* stderr. The positive control rides
  // with it, because a filter that dropped all stderr would pass the first of the two.
  const noisy = await call('echo oops >&2')
  check("the command's own stderr still reaches the model", noisy.rendered.includes('[stderr]')
    && noisy.rendered.includes('oops'), JSON.stringify(noisy.rendered.slice(0, 60)))

  // Recovery has to be bounded in both directions, and both were measured wrong here: the old path
  // re-executed a frame whose deadline had merely passed (so a command with effects ran twice), and a
  // cancelled `sleep 20` left the shell busy, making the *next* call wait ~18 s for it.
  const marker = `/tmp/dsh-session-real-${process.pid}.count`
  const slow = await call(`echo run >> ${marker}; sleep 6`, { timeoutMs: 2_000 })
  check('a slow command reports its own deadline, not a hang', slow.value?.timedOut === true
    && slow.rendered.includes('[timed out after 2000ms]'), `${slow.ms}ms ${JSON.stringify(slow.rendered.slice(0, 40))}`)
  const counted = await call(`wc -l < ${marker}`)
  check('a timed-out command ran exactly once', counted.text.trim() === '1',
    `count=${JSON.stringify(counted.text.trim())} (a retry would read 2)`)

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 1_500)
  let abortName = 'returned without throwing'
  try {
    await tool.execute({ command: 'sleep 20', description: 'compatibility driver: cancel' },
      { signal: controller.signal, agent: owner })
  } catch (error) {
    abortName = String(error?.name ?? error)
  }
  check('a cancelled call aborts in the host’s shape', abortName === 'AbortError', abortName)
  const afterCancel = await call('echo AFTER_CANCEL_$(( 2 * 3 ))')
  check('the next call is prompt after a cancel', afterCancel.text.includes('AFTER_CANCEL_6') && afterCancel.ms < 3_000,
    `${afterCancel.ms}ms`)
  await call(`rm -f ${marker}`)

  // The terminal class. `sudo true` with no terminal was measured sitting until its deadline expired
  // and returning nothing but `[timed out after 6000ms]`, then costing a session rebuild; through
  // `script -qec` it answers in under half a second with sudo's own words. That is the difference
  // between "bounded" and "usable".
  const password = await call('sudo true', { timeoutMs: 8_000 })
  // What sudo answers with belongs to the distribution's sudoers: root here and on the WSL1 runner is
  // NOPASSWD and says nothing (exit 0), an ordinary user is asked for a password. The universal
  // property is that the escalation ran and sudo's own verdict came back well inside the deadline
  // instead of consuming it — which is what the same call did before `tty` existed (6.8 s, nothing
  // but `[timed out after 6000ms]`).
  check('sudo is escalated and answers inside its budget', password.ms < 4_000
    && password.value?.timedOut === false
    && (password.value?.exitCode === 0 || /[Pp]assword/.test(password.rendered)),
  `${password.ms}ms exit=${password.value?.exitCode} :: ${JSON.stringify(password.rendered.slice(0, 60))}`)
  const pty = await call('stty size; tty', { timeoutMs: 8_000, tty: true })
  const [sizeLine = '', ttyLine = ''] = pty.text.trim().split('\n')
  check('the escalated pty has a real size and name', sizeLine.trim() === '24 80' && ttyLine.startsWith('/dev/pts/'),
    JSON.stringify(pty.text.trim()))

  // ---------------------------------------------------------------- this round's behaviour
  // A relative `workdir` is resolved against the session directory, the way the host's one-shot tool
  // does (`resolveWorkdir`): measured there, `docs` becomes `/home/ruler/docs` and bash's own `cd`
  // error is what comes back. Translating it to nothing would run the command somewhere the model did
  // not ask for, silently.
  await call(`mkdir -p "${linuxHome}/dsh-session-real-relative"`)
  const relative = await call('pwd', { workdir: 'dsh-session-real-relative' })
  check('a relative workdir resolves against the session directory', relative.text.trim() === `${linuxHome}/dsh-session-real-relative`,
    JSON.stringify(relative.text.trim()))
  const missing = await call('pwd', { workdir: 'dsh-session-real-does-not-exist' })
  check('an unresolvable workdir fails loudly, in bash’s own words', missing.value?.exitCode !== 0
    && /No such file or directory/.test(missing.rendered), JSON.stringify(missing.rendered.slice(0, 80)))
  await call(`rmdir "${linuxHome}/dsh-session-real-relative"`)

  // Large output: the head goes to a file and the model is pointed at it, in the host's exact
  // sentence (`[output truncated; full output: <path>]`, dsh-tool-bash:137). The file's own line
  // count is the assertion, because a spill file that is short is a spill that lost data.
  const big = await call('seq 1 200000', { timeoutMs: 30_000 })
  const spillPath = big.value?.stdout?.spillPath
  const spilled = spillPath === undefined ? '' : readFileSync(spillPath.replace(/\\/g, '/'), 'utf8')
  check('large output spills the whole stream and says where', big.value?.stdout?.truncated === true
    && typeof spillPath === 'string' && spillPath.length > 0
    && big.rendered.includes(`[output truncated; full output: ${spillPath}]`)
    && spilled.trim().split('\n').length === 200_000,
  `spill=${JSON.stringify(spillPath ?? null)} fileLines=${spilled.trim() === '' ? 0 : spilled.trim().split('\n').length}`)

  // The journal beyond `cd` and `export`: options, aliases and functions come back after a restart,
  // and a snapshot too large to replay is *reported* rather than quietly lost.
  await call("alias dshrealalias='echo ALIAS_OK_7'; set -o allexport; shopt -s nocasematch; dshrealfn() { echo FN_OK_9; }")
  const wedged = await call('sleep 4', { timeoutMs: 1_500 })
  check('the restart says what it restored', wedged.rendered.includes('[the shell was restarted'),
    JSON.stringify(wedged.rendered.slice(-90)))
  const restored = await call("alias dshrealalias >/dev/null 2>&1 && dshrealalias; dshrealfn; shopt -q nocasematch && echo SHOPT_OK_5; set -o | grep -q '^allexport[[:space:]]\\+on' && echo SET_OK_3")
  check('alias, function, shopt and set options survive a restart', restored.text.includes('ALIAS_OK_7')
    && restored.text.includes('FN_OK_9') && restored.text.includes('SHOPT_OK_5') && restored.text.includes('SET_OK_3'),
  JSON.stringify(restored.text.trim()))

  const many = await call('for i in $(seq 1 4000); do eval "dshbig$i() { echo $i; }"; done; declare -f | wc -c')
  const bigRestart = await call('sleep 4', { timeoutMs: 1_500 })
  const overCap = /not restored: functions \(\d+ bytes over the \d+ byte cap\)/.test(bigRestart.rendered)
  check('a function snapshot over the cap is reported, not silently dropped', many.value?.exitCode === 0 && overCap,
    `snapshot=${many.text.trim()} bytes; note=${overCap}`)
  await call('for i in $(seq 1 4000); do unset -f dshbig$i 2>/dev/null; done; true')

  // Detached children. Measured: killing `wsl.exe` takes ordinary children with it (0 survivors) but
  // `setsid`/`nohup` ones live (2/2), so the session marks its processes and reaps exactly those.
  // The control that makes this mean something is a sleep started *outside* the session: if the reaper
  // ever degrades into `pkill -f sleep`, that one dies and this cell goes red.
  const outside = spawnSync('wsl.exe', ['-d', distro, '-u', username, '-e', 'bash', '-c',
    'setsid sleep 40 & disown; echo $!'], { encoding: 'utf8', timeout: 30_000 })
  const outsidePid = String(outside.stdout).trim().split('\n').pop()
  await call('setsid sleep 35 & disown; echo DETACHED=$!')
  const reaped = await call('sleep 4', { timeoutMs: 1_500 })
  const stillOut = spawnSync('wsl.exe', ['-d', distro, '-u', username, '-e', 'bash', '-c',
    `kill -0 ${outsidePid} 2>/dev/null && echo ALIVE || echo DEAD; pgrep -c -x sleep || echo 0`],
  { encoding: 'utf8', timeout: 30_000 })
  const [outsideState, sleepCount] = String(stillOut.stdout).trim().split('\n')
  check('a detached child of the session is reaped on restart', /detached process/.test(reaped.rendered)
    && Number(sleepCount) <= 1, JSON.stringify({ note: reaped.rendered.slice(-70), outsideState, sleepCount }))
  spawnSync('wsl.exe', ['-d', distro, '-u', username, '-e', 'pkill', '-x', 'sleep'], { timeout: 20_000 })

  // Memory: one session shell is measured at ~3.4 MB of RSS; the bound below is that plus six times
  // the margin for the journal and readline buffers, not a number tuned to whatever the run produced.
  const memory = await call('printf "%s %s" "$(ps -o rss= -p $$ | tr -d " ")" "$(pgrep -c -x bash)"')
  const [rssKb] = memory.text.trim().split(/\s+/)
  check('the session shell stays inside its memory bound', Number(rssKb) > 0 && Number(rssKb) < 20_480,
    `rss=${rssKb} kB (bound 20480, measured floor 3372)`)

  // `run_in_background` must not be an argument that is quietly ignored — the repository has already
  // been bitten once by a `bash` that accepted it and ran in the foreground. The reply shape is the
  // host's (`started background job <id>`), and the hand-off carries the job kind and `onExpiry: none`
  // so the job outlives one command's timeout.
  const bgArgs = { command: 'echo BG_$(( 6 * 7 ))', description: 'compatibility driver: background arm', run_in_background: true }
  const bg = await tool.execute(bgArgs, exec)
  const bgText = (tool?.output?.render?.(bgArgs, bg) ?? []).map(part => String(part?.text ?? '')).join('')
  check('run_in_background hands off to the jobs producer', bg?.kind === 'background'
    && bg?.jobId === 'job-dsh-session-real' && bgText === 'started background job job-dsh-session-real'
    && jobRequest?.kind === 'bash' && typeof jobRequest?.run === 'function'
    && typeof jobRequest?.label === 'string' && jobRequest.label.includes('BG_$'),
  JSON.stringify({ kind: bg?.kind, jobId: bg?.jobId, requested: jobRequest?.kind, label: jobRequest?.label }))
  const afterBg = await call('echo AFTER_BG_$(( 2 * 2 ))')
  check('the backgrounded command did not run inside the session shell', !afterBg.text.includes('BG_42')
    && afterBg.text.includes('AFTER_BG_4'), JSON.stringify(afterBg.text.trim()))

  // The shells are children of this process, so counting them is a real lifecycle test: a session
  // that outlives its plugin fiber is a leak the user cannot see or cancel.
  const wslCount = () => (String(spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq wsl.exe', '/NH'],
    { encoding: 'utf8' }).stdout ?? '').match(/wsl\.exe/gi) ?? []).length
  const beforeDispose = wslCount()
  sessionFiber.dispose?.()
  await new Promise(resolve => setTimeout(resolve, 2_000))
  const afterDispose = wslCount()
  check('disposing the plugin takes the session shell down', afterDispose <= beforeDispose - 1,
    `${beforeDispose} → ${afterDispose} wsl.exe processes`)

  // The leak scan runs last so it covers every body above, escalated and spilled ones included. The
  // signatures are the frame's own invariant text, not one rendering of it: measured here, bash's line
  // editor writes only the TAIL of the echoed frame to stderr (79 bytes, starting mid-nonce, after a
  // `\r`), so a filter keyed on the payload or the record tags — both in the head — recognises
  // nothing. A cell that misses that is the vacuous green this file keeps naming.
  const signatures = ['__DSH_WSL_BASH', 'eval "$(printf %s', '| base64 -d)"', '{ export -p;', '__dsh_status',
    '#dsh-section', 'declare -F']
  const dirty = renderedBodies.filter(body => signatures.some(signature => body.includes(signature)))
  check('no protocol byte reaches the model, in any call', renderedBodies.length > 20 && dirty.length === 0,
    `${dirty.length} of ${renderedBodies.length} bodies carry a frame signature: ${JSON.stringify(dirty[0]?.slice(0, 70) ?? '')}`)
  check('an escalated body carries no stray carriage returns', !pty.rendered.includes('\r')
    && !password.rendered.includes('\r'),
  JSON.stringify((pty.rendered + password.rendered).replace(/\r/g, '<CR>').slice(0, 70)))
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

const EXPECTED_CHECKS = 33
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
