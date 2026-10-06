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
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// A second owner is built the same way on purpose: the isolation cells below are only meaningful if
// both agents arrive through the same channel with the same shape. `effect` follows cordis's own
// contract — the function is *setup*, run when it is registered, and whatever it returns is the
// disposer the scope runs when that agent ends — so the disposers are captured here and fired by the
// cell that asks what happens when one agent stops.
const disposers = new Map()
function makeOwner(id) {
  const collected = []
  disposers.set(id, collected)
  return {
    id,
    session: { id: `${id}-session`, cwd: sessionCwd, header: { cwd: sessionCwd, id: `${id}-session` } },
    ctx: {
      on: () => () => {},
      effect: (setup) => {
        const disposer = setup?.()
        if (typeof disposer === 'function') collected.push(disposer)
        return () => {}
      },
    },
  }
}
const owner = makeOwner('agent-bash-session')
const exec = { signal: AbortSignal.timeout(180_000), agent: owner }

const renderedBodies = []

/** One tool call, timed, with the text the model would read. */
async function call(command, options = {}, execution = exec) {
  const started = Date.now()
  const args = { command, description: 'compatibility driver: session bash', ...options }
  const value = await tool.execute(args, execution)
  const parts = tool?.output?.render?.(args, value) ?? []
  const rendered = parts.map(part => String(part?.text ?? '')).join('')
  renderedBodies.push(rendered)
  return { ms: Date.now() - started, value, text: String(value?.stdout?.text ?? ''), rendered }
}

/** How many processes in the distribution have this exact command line.
 *
 * `[ ]` in each pattern so a probe can never match its own command line, and the count is labelled
 * because `pgrep -c` prints `0` *and* exits 1 — a `|| echo 0` would turn that into `0\n0`. A probe
 * that did not answer is `NaN`, never 0: a silent census must not read as "reaped".
 */
function probeCount(pattern) {
  const out = String(spawnSync('wsl.exe', ['-d', distro, '-u', username, '-e', 'bash', '-c',
    `echo COUNT=$(pgrep -c -f '${pattern}')`], { encoding: 'utf8', timeout: 30_000 }).stdout ?? '')
  const match = /COUNT=(\d+)/.exec(out)
  return match === null ? NaN : Number(match[1])
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

  // The terminal decision, made by watching the process instead of reading its name.
  //
  // First the premise, per distribution. Measured here (WSL2, Ubuntu, 2026-10-05): a piped
  // `bash --norc -i` still has a controlling terminal — `ps -o tty= -p $$` answers `pts/1` and `$-` is
  // `himBs` — so a command that reads `/dev/tty` blocks forever rather than failing. A distribution
  // without that terminal answers `??` and the same read errors at once, which is a different thing to
  // assert. Writing the local machine's premise as a universal rule is the mistake this file has caught
  // twice already, so every reactive cell below is conditioned on this reading and says which branch it
  // took.
  const cttyProbe = await call('ps -o tty= -p $$; echo FLAGS=$-', { timeoutMs: 8_000 })
  const cttyName = (cttyProbe.text.trim().split('\n')[0] ?? '').trim()
  const hasCtty = /^pts\/\d+$/.test(cttyName)
  check('the controlling-terminal premise is read, not assumed',
    cttyName === '??' || hasCtty,
  JSON.stringify({ tty: cttyName, hasCtty, flags: /\bFLAGS=(\S+)/.exec(cttyProbe.text)?.[1] }))
  //
  // `sh -c 'read x < /dev/tty'` is the case to test with: `sh` was in no list, the command reaches for
  // the keyboard anyway, and where there is a terminal to wait on it sits there until its deadline.
  // Measured before this existed (`D:\Temp\issue51-s0\v1b-report.txt`): 13 089 ms of silence, then a
  // session rebuild. What it must do now is get stopped, re-run on a pseudo-terminal where the read
  // meets end-of-file, and say it ran twice — all inside one call.
  const starved = await call(`sh -c 'read x < /dev/tty; echo GOT=$?'`, { timeoutMs: 20_000 })
  check('a command waiting for the keyboard is stopped and answered, not left to its deadline',
    hasCtty
      ? (starved.value?.timedOut === false && starved.text.includes('GOT=')
        && /first attempt was stopped/.test(starved.rendered))
      : (starved.value?.timedOut === false && starved.ms < 8_000),
  JSON.stringify({ hasCtty, ms: starved.ms, exit: starved.value?.exitCode, tail: starved.text.trim().slice(0, 20) }))
  // The stopped-and-re-run sentence is the whole point: the second execution can repeat work the first
  // attempt did before it reached its prompt, and a body that hides that is the defect this file has
  // already caught once (`echo run >> f` landing twice, 2026-10-04).
  check('the re-run is announced as a second execution',
    !hasCtty || (/run once more on a pseudo-terminal/.test(starved.rendered) && /done twice/.test(starved.rendered)),
  JSON.stringify({ hasCtty, head: starved.rendered.slice(0, 90) }))
  // A long silent wait that is NOT a keyboard wait must be left completely alone: `sleep 4` produces no
  // bytes, uses no CPU, sleeps in the terminal's foreground job — and is distinguishable only by where
  // it is asleep. This is the false-positive sentinel; if the rule ever broadens to "quiet means stuck",
  // this cell goes red.
  const sleeping = await call('sleep 4; echo SLEPT_RIGHT', { timeoutMs: 20_000 })
  check('a command that is merely quiet is not stopped',
    sleeping.value?.timedOut === false && sleeping.text.includes('SLEPT_RIGHT')
    && !/first attempt was stopped/.test(sleeping.rendered) && sleeping.ms > 3_500,
  JSON.stringify({ ms: sleeping.ms, exit: sleeping.value?.exitCode, tail: sleeping.rendered.slice(-40) }))
  // A privileged wait hides its `/proc` entries (sudo clears its dumpable flag), so it can only be
  // called unconfirmable and gets the longer window. Root here is NOPASSWD and answers at once, which is
  // the other half of the assertion: no note may be attached to a call that never waited.
  const password = await call('sudo true', { timeoutMs: 25_000 })
  check('a privileged wait comes back inside its budget and never on the deadline',
    password.value?.timedOut === false && password.ms < 20_000,
  JSON.stringify({ ms: password.ms, exit: password.value?.exitCode, tail: password.rendered.slice(-46) }))
  const asked = /sudo: (a password is required|no password was provided)/.test(password.rendered)
  const told = /sudo asked for a password/.test(password.rendered)
  check('a password sudo cannot be given is explained, not just reported', asked === told,
    JSON.stringify({ asked, told, tail: password.rendered.slice(-56) }))
  // The veto: `tty: false` must keep the ordinary pipe even for a command that then sits waiting. The
  // stop still happens (the shell would otherwise be unusable) but the re-run must not.
  const vetoed = await call(`sh -c 'read x < /dev/tty; echo GOT=$?'`, { tty: false, timeoutMs: 20_000 })
  check('tty:false vetoes the re-run and keeps the command on the pipe',
    !hasCtty || (!/run once more on a pseudo-terminal/.test(vetoed.rendered)
      && !vetoed.text.includes('GOT=') && /waiting for keyboard input/.test(vetoed.rendered)),
  JSON.stringify({ hasCtty, ms: vetoed.ms, exit: vetoed.value?.exitCode, text: vetoed.text.trim().slice(0, 20) }))
  // The shape a real model chose where this plugin's own cells used `sh -c …`: a *builtin* that reads
  // the terminal blocks the session shell itself, so there is no child process to find. Measured while
  // it happened (2026-10-06): the shell's own row is `Ss+ wchan=wait_woken fd0=/dev/tty` with CPU flat,
  // and before the walk included that row the call merely timed out at 30 s and rebuilt the shell.
  const builtinRead = await call(`read -r line < /dev/tty; echo LINE=[$line]`, { timeoutMs: 20_000 })
  check('a builtin that reads the terminal is ended and re-run, not left to the deadline',
    !hasCtty || (builtinRead.value?.timedOut === false && builtinRead.text.includes('LINE=[]')
      && /ended by restarting the shell/.test(builtinRead.rendered)),
  JSON.stringify({ hasCtty, ms: builtinRead.ms, exit: builtinRead.value?.exitCode,
    timedOut: builtinRead.value?.timedOut, text: builtinRead.text.trim().slice(0, 20),
    note: /ended by restarting the shell/.test(builtinRead.rendered) }))

  const pty = await call('stty size; tty', { timeoutMs: 8_000, tty: true })
  const [sizeLine = '', ttyLine = ''] = pty.text.trim().split('\n')
  check('the escalated pty has a real size and name', sizeLine.trim() === '24 80' && ttyLine.startsWith('/dev/pts/'),
    JSON.stringify(pty.text.trim()))
  // Attribution, which is the point of the whole note channel: when an escalated call fails for a
  // reason this file has not predicted, the body has to say it went through the pseudo-terminal and
  // name the one comparison that rules it in or out — otherwise a person reading a transcript has to
  // relive the session to find out. Both halves are asserted, because a tag printed on success is the
  // same noise in the other direction.
  const misbehaved = await call('exit 7', { tty: true, timeoutMs: 8_000 })
  check('an unforeseen failure of an escalated call names the layer and the check',
    misbehaved.value?.exitCode === 7 && /pseudo-terminal/.test(misbehaved.rendered)
    && /tty: false/.test(misbehaved.rendered) && !/pseudo-terminal/.test(pty.rendered),
  JSON.stringify({ exit: misbehaved.value?.exitCode, tail: misbehaved.rendered.slice(-70) }))

  // Two seams measured on 2026-10-05 by driving this tier directly. `man` on a terminal it cannot
  // colour writes overstrike — a whole page came back as `N\bNA\bAM\bME\bE` for `NAME` — and that
  // reached the model verbatim. The fold is asserted on the exact bytes rather than on `man`, because
  // whether `man` reaches its pager at all belongs to the distribution, and a cell that depends on it
  // would be a claim about the machine.
  const overstruck = await call("printf 'N\\bNA\\bAM\\bME\\bE\\n'", { timeoutMs: 8_000, tty: true })
  check('a pty’s overstrike is folded before the model reads it',
    overstruck.text === 'NAME\n',
    JSON.stringify({ raw: overstruck.text, exit: overstruck.value?.exitCode }))
  // The reading that killed the old rule's first day: `bash -c 'sudo true'` sat to its deadline because
  // the decision read the first word. Nothing reads a word any more — the walk finds the process — so a
  // waiting command inside a wrapper is caught by the same code as one on its own.
  const nested = await call(`bash -c 'read x < /dev/tty; echo GOT=$?'`, { timeoutMs: 20_000 })
  check('a waiting command inside a wrapper is caught without reading a single word',
    nested.value?.timedOut === false && nested.text.includes('GOT=')
    && /first attempt was stopped/.test(nested.rendered),
  `${nested.ms}ms exit=${nested.value?.exitCode} :: ${JSON.stringify(nested.text.trim().slice(0, 20))}`)
  // A deadline the call named does not buy a keyboard wait back — the property the old 8-second cap was
  // built to hold, now earned by evidence instead of by a name list. 60 seconds asked, ~2 answered.
  const longAsked = await call(`sh -c 'read x < /dev/tty; echo GOT=$?'`, { timeoutMs: 60_000 })
  check('a longer deadline does not buy a keyboard wait back',
    longAsked.ms < 20_000 && longAsked.value?.timedOut === false
    && /first attempt was stopped/.test(longAsked.rendered),
  JSON.stringify({ ms: longAsked.ms, asked: longAsked.value?.timeoutMs, exit: longAsked.value?.exitCode }))
  // The pager class answers better on the pipe (`man` prints the whole page; on a terminal it opens a
  // pager that waits for keys), so nothing about it is escalated any more — asserted through the
  // program's own eyes rather than a timing guess, and `tty: true` remains the door for the caller who
  // wants the pager itself.
  const stays = await call('man ls > /dev/null 2>&1; echo RC=$?; tty', { timeoutMs: 8_000 })
  check('a pager or report keeps the ordinary pipe unless the call asks',
    stays.text.includes('not a tty') && stays.text.includes('RC=0') && stays.ms < 3_000
    && !/first attempt was stopped/.test(stays.rendered),
  JSON.stringify({ ms: stays.ms, tail: stays.text.replace(/\s+/g, ' ').slice(-32) }))
  // The loop brake is a sentence, not a refusal: the same failing command twice over says so, and one
  // success clears the count so the ordinary `npm test` after an install is never told to stop. The
  // signature runs in a subshell — a bare `exit 41` would end the session shell itself (measured: it
  // did, and every later call aborted).
  const repeatOne = await call("sh -c 'exit 41'", {})
  const repeatTwo = await call("sh -c 'exit 41'", {})
  await call('true', {})
  const repeatThree = await call("sh -c 'exit 41'", {})
  check('a repeated failure says it is a repeat and a success clears the count',
    !/has failed/.test(repeatOne.rendered) && /has failed 2 times/.test(repeatTwo.rendered)
    && !/has failed/.test(repeatThree.rendered),
    JSON.stringify({ first: /has failed/.test(repeatOne.rendered),
      second: /has failed 2 times/.test(repeatTwo.rendered), afterSuccess: /has failed/.test(repeatThree.rendered) }))
  // And a timed-out terminal call must not narrate a recovery that did not happen: the two sentences
  // are produced from different facts, so asserting they agree catches the claim without trusting it.
  const ptyTimeout = await call('sleep 5', { tty: true, timeoutMs: 1_000 })
  const claimedRecovery = /shell was restarted to recover/.test(ptyTimeout.rendered)
  const actuallyRestarted = /was restarted and its directory/.test(ptyTimeout.rendered)
  check('a timed-out call says a restart only when the session had one',
    ptyTimeout.value?.timedOut === true && claimedRecovery === actuallyRestarted,
    JSON.stringify({ claimedRecovery, actuallyRestarted, timedOut: ptyTimeout.value?.timedOut }))
  // The `tty: false` veto is asserted offline instead (`tests/wsl-bash-tty.test.ts`): it is a decision,
  // and the only live discriminator would be a program that hangs on a real terminal, which would make
  // the cell's cost the very defect it is measuring.

  // The protection the old 8-second cap existed to give, now carried by the reading instead of by a
  // name list. A real session measured the cost of the older rule: `printf '%s\n' X; vim note.txt` was
  // not escalated at all, sat out the configured two minutes, and handed the model the screen's raw
  // escapes — 121 703 ms for nothing (`D:\Temp` evidence sheet, turn 22). Bytes arriving first must not
  // blind the watchdog, so this cell writes a line and *then* waits for a keyboard.
  const compound = await call(`printf 'x\\n'; sh -c 'read y < /dev/tty; echo GOT=$?'`, { timeoutMs: 20_000 })
  check('a wait after some output is still caught',
    compound.text.includes('x') && compound.text.includes('GOT=') && compound.ms < 20_000
    && /first attempt was stopped/.test(compound.rendered),
  JSON.stringify({ ms: compound.ms, exit: compound.value?.exitCode, text: compound.text.replace(/\s+/g, ' ').trim().slice(0, 24) }))
  // The premise of the whole layer, checked rather than assumed: the note has to cite the `/proc` field
  // it read. A probe that silently stopped answering (no `pgrep`, a hardened `/proc` mount) would look
  // exactly like a command that is not waiting, so a reading with no provenance in it is the red flag.
  check('the reading names the /proc field it came from',
    /\/proc\/<pid>\/wchan/.test(vetoed.rendered) && /wait_woken/.test(vetoed.rendered),
  JSON.stringify(vetoed.rendered.slice(0, 80)))
  // The other half of the same session pass: a live display on a pipe does not wait, it refuses. `top`
  // answered `top: failed tty get` in 687 ms with exit 1 — so it is *not* the deadline case, and the
  // tool's description must not promise the model that a bare `top` prints something.
  const refuses = await call('top', {})
  check('a live display without a terminal refuses at once rather than waiting',
    refuses.ms < 15_000 && /failed tty get/.test(refuses.rendered) && refuses.value?.exitCode === 1,
    JSON.stringify({ ms: refuses.ms, exit: refuses.value?.exitCode, tail: refuses.rendered.replace(/\s+/g, ' ').slice(-46) }))

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
  //
  // Counted **by the duration each probe carries**, and asserted **before and after** the rebuild,
  // never by a bare process-name census. Two readings forced this shape (frame 37221289492, then a
  // local rerun on 2026-10-05):
  //  - `pgrep -c -x sleep <= 1` was a claim about the *environment*. The CI fixture keeps a `sleep 900`
  //    warm in this distribution on purpose (the 9P share vanishes when it idles out), so the count
  //    read 2 on the `src` plane — keep-warm plus the outside control, with the session's own child
  //    already reaped — and passed on the `lib` plane of the same frame, because the earlier pass'
  //    cleanup `pkill -x sleep` had killed that keep-warm. A cell whose answer depends on which plane
  //    ran first is not measuring the product.
  //  - the control used to be `setsid sleep 40` launched by a `wsl.exe` that then exited **normally**,
  //    and on this machine's WSL2 that dies by itself (measured `DEAD` at t=0 with the instance up),
  //    while the WSL1 runner left it alive. It is now a `sleep` whose launcher the driver holds open,
  //    so its lifetime belongs to the driver and its survival is a real mis-kill guard: were the
  //    reaper ever to degrade into `pkill -f sleep`, this process dies and the cell goes red.
  const control = spawn('wsl.exe', ['-d', distro, '-u', username, '-e', 'bash', '-c',
    'exec sleep 41'], { stdio: 'ignore' })
  await call('setsid sleep 35 & disown; echo DETACHED=$!')
  const beforeReap = probeCount('sleep[ ]35')
  const reaped = await call('sleep 4', { timeoutMs: 1_500 })
  const afterReap = probeCount('sleep[ ]35')
  const controlAlive = probeCount('sleep[ ]41')
  check('a detached child of the session is reaped on restart', /detached process/.test(reaped.rendered)
    && beforeReap >= 1 && afterReap === 0 && controlAlive >= 1,
  JSON.stringify({ note: reaped.rendered.slice(-70), beforeReap, afterReap, controlAlive }))
  control.kill()
  spawnSync('wsl.exe', ['-d', distro, '-u', username, '-e', 'bash', '-c',
    "pkill -f 'sleep[ ]35'; true"], { timeout: 20_000 })

  // Memory: one session shell is measured at ~3.4 MB of RSS; the bound below is that plus six times
  // the margin for the journal and readline buffers, not a number tuned to whatever the run produced.
  const memory = await call('printf "%s %s" "$(ps -o rss= -p $$ | tr -d " ")" "$(pgrep -c -x bash)"')
  const [rssKb] = memory.text.trim().split(/\s+/)
  check('the session shell stays inside its memory bound', Number(rssKb) > 0 && Number(rssKb) < 20_480,
    `rss=${rssKb} kB (bound 20480, measured floor 3372)`)

  // Isolation boundaries. Everything above is one agent in one session; the product runs several
  // agents, and a shell that shares state between them is not a convenience but a leak — one agent's
  // `cd`, exports, aliases and processes becoming another's. The shells are keyed by the agent's id in
  // `wsl-bash-tool.ts`, so these cells drive a second agent through the same registered tool.
  const ownerB = makeOwner('agent-bash-session-b')
  const execB = { signal: AbortSignal.timeout(180_000), agent: ownerB }
  await call('cd /tmp && export DSHISO=from_A_$(( 6 * 7 ))')
  const foreign = await call('pwd; echo ISO=[$DSHISO]', {}, execB)
  check('a second agent does not inherit the first one’s directory or exports',
    !foreign.text.includes('from_A_42') && !foreign.text.startsWith('/tmp'),
  JSON.stringify(foreign.text.trim().slice(0, 60)))
  const ownBack = await call('pwd; echo ISO=$DSHISO')
  check('the first agent still has its own state afterwards', ownBack.text.includes('/tmp')
    && ownBack.text.includes('ISO=from_A_42'), JSON.stringify(ownBack.text.trim().slice(0, 60)))

  // Two calls at once on one shell: the frame protocol is one command in flight, so a concurrent pair
  // must serialise, not interleave. If the two answers ever share a body, the reader would be reading
  // another command's output — the shape that made the sentinel protocol in the first place.
  const [one, two] = await Promise.all([
    call('echo ONE_$(( 2 + 2 ))'),
    call('echo TWO_$(( 4 + 4 ))'),
  ])
  check('two calls in one flight settle serially, each with its own answer',
    one.text.includes('ONE_4') && !one.text.includes('TWO_') && two.text.includes('TWO_8')
    && !two.text.includes('ONE_'),
  JSON.stringify({ one: one.text.trim().slice(0, 24), two: two.text.trim().slice(0, 24) }))

  // The reaper matches this session's token in `/proc/*/environ`, so a rebuild must be able to stop
  // its own detached children without touching another agent's. Duration 37 belongs to agent B;
  // agent A's rebuild below is the only thing allowed to run.
  await call('setsid sleep 37 & disown; echo B_DETACHED=$!', {}, execB)
  const beforeForeignReap = probeCount('sleep[ ]37')
  const aRebuild = await call('sleep 4', { timeoutMs: 1_500 })
  const afterForeignReap = probeCount('sleep[ ]37')
  check('a rebuild reaps only the session that owns the token',
    beforeForeignReap >= 1 && afterForeignReap >= 1 && /detached process|the shell was restarted/.test(aRebuild.rendered),
  JSON.stringify({ beforeForeignReap, afterForeignReap, note: aRebuild.rendered.slice(-58) }))
  const bAlive = await call('echo B_STILL_$(( 3 * 9 ))', {}, execB)
  check('the other agent’s shell answered through its own rebuild', bAlive.text.includes('B_STILL_27'),
    JSON.stringify(bAlive.text.trim().slice(0, 40)))

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

  // One agent ending must take exactly its own shell with it. The tool registers a disposer on the
  // agent's scope (`exec.agent.ctx.effect`) when it creates a session, and the driver's owner fake
  // collects those disposers the way cordis does, so this fires agent B's own scope teardown: B's shell
  // goes, A's keeps answering. If the tool registered nothing, `collected` is empty and this is red —
  // an agent-scoped shell that outlives its agent is two `wsl.exe` and ~9 MB nobody can cancel.
  const beforeAgentEnd = wslCount()
  const bDisposers = disposers.get('agent-bash-session-b') ?? []
  for (const dispose of bDisposers) dispose()
  await new Promise(resolve => setTimeout(resolve, 2_000))
  const afterAgentEnd = wslCount()
  const aAfterBEnd = await call('echo A_AFTER_B_$(( 5 * 5 ))')
  check('one agent ending takes only its own shell down',
    bDisposers.length > 0 && afterAgentEnd <= beforeAgentEnd - 1 && aAfterBEnd.text.includes('A_AFTER_B_25'),
  JSON.stringify({ bDisposers: bDisposers.length, beforeAgentEnd, afterAgentEnd, a: aAfterBEnd.text.trim().slice(0, 24) }))

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

// ── the keyboard door: the agent typing into a real terminal ─────────────────
//
// Issue #51's contract is that everything a person can run is reachable by the agent. The pipe
// shell above answers most of it; this is the class a pipe cannot answer — a program waiting on the
// keyboard — driven through the tool the world mounts (`wsl_terminal`), on the host's own PTY
// registry and backend, pointed at this installation's relay, against the same distribution. No
// stand-in terminal anywhere in the chain.
//
// Two of the cells need their premises stated. The user cell works because the host builds a PTY
// child's environment itself and scrubs every `DSH_*` variable out of it, so the relay cannot be
// told by environment which user the workspace runs as — it reads the workspace store the dialog
// writes, keyed by its own cwd. `USERPROFILE` is what `os.homedir()` reads on Windows AND it
// survives that scrubbing, so the driver points it at a scratch home for the length of this
// section: that is how the store path is exercised without touching the real store. The residue
// cell counts `bash -i` in the distribution — the shape the relay's `exec bash -i` leaves behind —
// rather than trusting the tool's own "closed".
let doorRegistered = false
try {
  const terminalService = await import(at(`${DEPS}/dsh-terminal/lib/index.js`))
  const terminalBash = await import(at(`${DEPS}/dsh-terminal-bash/lib/index.js`))
  const doorModule = await load('wsl-terminal-tool')
  const doorCtx = new Context()
  await doorCtx.plugin(LocalSubprocessRuntime)
  for (const module of [shellEnvPlugin, toolsPlugin, systemPromptPlugin, terminalService]) {
    await doorCtx.plugin(hostModule(module))
  }
  const doorCwd = `\\\\wsl.localhost\\${distro}\\tmp`
  const doorOwner = {
    ...owner,
    id: 'agent-keyboard-door',
    session: { id: 'session-keyboard-door', cwd: doorCwd, header: { cwd: doorCwd, id: 'session-keyboard-door' } },
  }
  doorCtx.provide?.('agents', { get: (id) => (id === doorOwner.id ? doorOwner : undefined) })
  doorCtx.provide?.('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: doorCwd }) })
  const { resolveRelayNode } = await import(pathToFileURL(`${repoRoot}/src/shared/relay-node.ts`).href)
  const relay = await resolveRelayNode()
  await terminalBash.apply(doorCtx, new terminalBash.Config({
    backendType: 'wsl', shellDialect: 'bash', shellPath: relay?.path ?? process.execPath,
    shellArgs: [`${repoRoot}/lib/wsl-relay.js`], idleSilenceMs: 1_200,
  }))
  await doorCtx.plugin(doorModule.default ?? doorModule, { quietMs: 1_200 })
  const door = doorCtx.tools.get('wsl_terminal')
  doorRegistered = door !== undefined
  check('the door tool registers on the host terminal stack', doorRegistered === true,
    `ctx.tools.get('wsl_terminal') -> ${typeof door}`)

  /** One door action, timed, with the text the model would read. */
  const doorCall = async (action, args = {}) => {
    const started = Date.now()
    const value = await door.execute({ action, ...args }, { signal: AbortSignal.timeout(90_000), agent: doorOwner })
    const ms = Date.now() - started
    if (action === 'send') doorSends.push({ what: args.text === '' ? '(enter)' : String(args.text).slice(0, 24), ms })
    return { ms, text: String(value?.text ?? '') }
  }
  /** Every send this section made, so the latency claim below is over real samples, not one. */
  const doorSends = []
  /** Interactive `bash -i` processes in the distribution: the shape the relay leaves behind. */
  const doorShells = () => probeCount('bash[ ]-i')
  const defaultUser = String(spawnSync('wsl.exe', ['-d', distro, '-e', 'whoami'],
    { encoding: 'utf8', timeout: 30_000 }).stdout ?? '').trim()

  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-door-home-'))
  mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'wsl-workspaces.json'),
    `${JSON.stringify({ [doorCwd]: { username } }, null, 2)}\n`, 'utf8')
  const previousProfile = process.env.USERPROFILE
  process.env.USERPROFILE = fakeHome
  const shellsBeforeDoor = doorShells()
  try {
    const opened = await doorCall('open')
    const id = /terminal (pty-\d+) is open/.exec(opened.text)?.[1]
    const shellsAfterOpen = doorShells()
    check('the door opens a real shell inside the distribution',
      id !== undefined && shellsAfterOpen === shellsBeforeDoor + 1,
      `id=${id ?? 'none'} in ${opened.ms}ms, bash -i ${shellsBeforeDoor} → ${shellsAfterOpen} :: ${opened.text.replace(/\s+/g, ' ').slice(0, 80)}`)

    const echo = await doorCall('send', { session: id, text: 'echo DOOR_$(( 6 * 7 ))' })
    check('a command typed into the door answers',
      echo.text.includes('DOOR_42'),
      `${echo.ms}ms, settled ${/back at the prompt/.test(echo.text) ? 'at the recognised prompt' : 'on the quiet window (the host did not recognise the prompt tail on this send)'} :: ${echo.text.replace(/\s+/g, ' ').slice(0, 80)}`)

    // The crux, and the reason this door exists at all: a program asleep on the keyboard, then the
    // keystrokes arriving. A pipe cannot do this; the one-shot pseudo-terminal the `bash` tool
    // escalates to cannot either, because there is nobody on the other end to type into it.
    const waiting = await doorCall('send', { session: id, text: `sh -c 'read x < /dev/tty; echo GOT=$x'` })
    const keystroke = await doorCall('send', { session: id, text: 'hello-from-the-door' })
    check('a keystroke reaches a program blocked on the terminal',
      /GOT=hello-from-the-door/.test(`${waiting.text}\n${keystroke.text}`),
      `${waiting.ms}ms + ${keystroke.ms}ms :: ${`${waiting.text} | ${keystroke.text}`.replace(/\s+/g, ' ').slice(0, 110)}`)

    const typed = await doorCall('send', { session: id, text: 'echo TYPED_NOT_RUN', submit: false })
    const enter = await doorCall('send', { session: id, text: '', submit: true })
    check('submit:false types without running, and the next Enter runs it',
      !/TYPED_NOT_RUN[\s\S]*\n[\s\S]*TYPED_NOT_RUN/.test(typed.text) && /TYPED_NOT_RUN/.test(enter.text),
      `${typed.ms}ms then ${enter.ms}ms :: ${`${typed.text} | ${enter.text}`.replace(/\s+/g, ' ').slice(0, 110)}`)

    const who = await doorCall('send', { session: id, text: 'whoami' })
    check('the door runs as the user the workspace names, not the distribution default',
      new RegExp(`(^|[^\\w])${username}([^\\w]|$)`).test(who.text),
      `asked for ${username}, distribution default is ${defaultUser}${username === defaultUser ? ' (this run cannot discriminate the two)' : ' (this run discriminates)'} :: ${who.text.replace(/\s+/g, ' ').slice(0, 60)}`)

    const page = await doorCall('read', { session: id, offset: 0, count: 5 })
    check('read pages the retained screen and reports where the page sits',
      /lines 0\.\.\d+ of \d+ retained/.test(page.text) && /dsh>/.test(page.text),
      `${page.ms}ms :: ${page.text.replace(/\s+/g, ' ').slice(0, 90)}`)

    const interrupted = await doorCall('send', { session: id, text: 'sleep 30' })
    const signal = await doorCall('signal', { session: id, signal: 'SIGINT' })
    const afterSignal = await doorCall('send', { session: id, text: 'echo AFTER_SIGINT_$(( 2 * 2 ))' })
    check('SIGINT is delivered to the foreground process and the shell survives it',
      /SIGINT delivered/.test(signal.text) && afterSignal.text.includes('AFTER_SIGINT_4'),
      `${interrupted.ms}ms + ${signal.ms}ms + ${afterSignal.ms}ms :: ${`${signal.text} | ${afterSignal.text}`.replace(/\s+/g, ' ').slice(0, 100)}`)

    // Every send above settled on the backend's own quiet window at worst, never on its 30 s
    // deadline. The measured ceiling of that window is idleSilenceMs (1.2 s) plus handoffGraceMs
    // (0.5 s) ≈ 1.9 s, so the bound below is margin for a slow first line, not a number tuned to
    // this run — and the sample list is printed, so a reader can see the spread instead of trusting
    // one reading.
    const slowest = doorSends.reduce((worst, send) => send.ms > worst.ms ? send : worst, { what: 'none', ms: 0 })
    check('no door send waits for the backend deadline',
      doorSends.length >= 6 && slowest.ms < 5_000,
      `${doorSends.length} sends, slowest ${slowest.ms}ms (${slowest.what}); all: ${doorSends.map(send => send.ms).join(', ')}ms`)

    const closed = await doorCall('close', { session: id })
    await new Promise(resolve => setTimeout(resolve, 1_500))
    const listed = await doorCall('list')
    const shellsAfterClose = doorShells()
    check('close takes the terminal and its shell down',
      /closed/.test(closed.text) && /no terminal is open/.test(listed.text) && shellsAfterClose <= shellsBeforeDoor,
      `${closed.ms}ms, list=${JSON.stringify(listed.text.trim().slice(0, 40))}, bash -i ${shellsBeforeDoor} → ${shellsAfterClose}`)
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    rmSync(fakeHome, { recursive: true, force: true })
    for (const session of doorCtx.terminals?.list?.(doorOwner) ?? []) {
      await doorCtx.terminals.kill(doorOwner, session.sessionId, 'driver teardown').catch(() => {})
    }
  }
} catch (error) {
  check('the keyboard door ran', false, `the door harness failed before comparing: ${String(error?.message ?? error).slice(0, 160)}`)
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

const EXPECTED_CHECKS = 66
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
