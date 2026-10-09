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

/**
 * A cancellation for one call, sized from that call's own deadline the way the host sizes each one.
 *
 * The WSL1 arm of CI is what taught the difference: there the keyboard-wait cells cannot be stopped
 * early, so each burns the full `timeoutMs` it asked for (23.7 s, 23.6 s, 20.6 s, 23.7 s, 63.7 s in
 * frame 37491885553) instead of answering at ~2 s the way WSL2 does. With one 180 s signal shared by
 * the whole file that budget ran out mid-run, every later call threw `tool call aborted`, and 28
 * check sites went unrun — an apparatus deadline posing as a product result.
 * @param agent - the owner fake the call runs as.
 * @param options - the call's own parameters, whose `timeoutMs` sets the budget.
 * @returns the execution context to hand `tool.execute`.
 */
function budget(agent, options = {}) {
  const asked = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120_000
  return { signal: AbortSignal.timeout(asked + 60_000), agent }
}

const renderedBodies = []

/** One tool call, timed, with the text the model would read. */
async function call(command, options = {}, agent = owner) {
  const started = Date.now()
  const args = { command, description: 'compatibility driver: session bash', ...options }
  const value = await tool.execute(args, budget(agent, args))
  const parts = tool?.output?.render?.(args, value) ?? []
  const rendered = parts.map(part => String(part?.text ?? '')).join('')
  renderedBodies.push(rendered)
  return { ms: Date.now() - started, value, text: String(value?.stdout?.text ?? ''), rendered }
}

/** The watchdog's own sentence out of a rendered body, so the log carries what the probe read.
 *
 * It was added after two WSL1 frames in which the cells that needed the reading printed a `tail` of
 * the body instead — and the tail was the restart note, so the frame said nothing about the rows and
 * the question stayed open for another 40 minutes of CI.
 */
function clause(rendered) {
  const match = /\[the check for a command waiting on a keyboard (looked and read[^\]]*|could not run[^\]]*)\]/.exec(rendered)
  return match === null ? '' : match[1].replace(/^looked and read \(([^)]*)\): /, 'fields $1: ')
}

/**
 * Whether this kernel hands the tool something a rule could act on, read off the rows themselves.
 *
 * Deliberately not the product's own decision: the cells below need to tell two shapes apart that look
 * identical from outside — "the kernel does not expose where the process is asleep, so nothing could be
 * stopped early" (what CI frame 37494104075 measured on WSL1: `w=not-reported`, no `sc=`, `0tty`), and
 * "the kernel exposed it and the tool still burnt the deadline". Only the second is a product fail, so
 * the reading decides which assertion a cell makes, and the rows go into the cell's detail either way.
 * @param rendered - the body the model would read.
 * @returns true when some non-shell row names a terminal descriptor, the terminal's read, or the `read`
 *   syscall; false when the body carries no reading at all or every row is blank in those fields.
 */
function witnessIn(rendered) {
  const text = clause(rendered)
  if (text === '' || text.startsWith('could not run')) return false
  // Rows are `name:state w=<wchan>[ sc=<n>] <Ntty|fd-unreadable> <fg|bg|no-tpgid>`, `; `-separated.
  // A row counts when all three of the facts the product's confirmed reading uses are there: it is the
  // terminal's foreground job, `/proc/<pid>/wchan` names the terminal's read, and a terminal is among
  // its descriptors. Deliberately the *same* three and not a wider set — if this predicate let in
  // evidence the rule does not act on, the cell would demand a stop the tool has no basis for and the
  // red would be a fault of the gate, not of the product.
  return text.split('; ').some(row => /\bfg$/.test(row)
    && /\bw=wait_woken\b/.test(row) && /\b[1-9]\d*tty\b/.test(row))
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
  // The marker is created by its own call, not by the frame under test: an empty `count` cannot tell
  // "the timed-out frame's write never happened" from "this read was not attributable", and frame
  // 37883332309 came back `count=""` with nothing in the log to say which. With the file there first,
  // a dropped frame reads 0 and a real double-run reads 2.
  const prep = await call(`: > ${marker}; echo PREP_$(( 3 * 7 ))`)
  check('the count marker exists before the timed-out frame', prep.text.includes('PREP_21'),
    `${prep.ms}ms exitCode=${String(prep.value?.exitCode)}`)
  const slow = await call(`echo run >> ${marker}; sleep 6`, { timeoutMs: 2_000 })
  check('a slow command reports its own deadline, not a hang', slow.value?.timedOut === true
    && slow.rendered.includes('[timed out after 2000ms]'), `${slow.ms}ms ${JSON.stringify(slow.rendered.slice(0, 40))}`)
  const counted = await call(`wc -l < ${marker}`)
  // The gate is the replay: two lines means the recovery path re-executed a frame whose deadline had
  // merely passed, which is the defect this cell was written for. One line means it ran once, and zero
  // means bash never read the line before the deadline stopped it — on a loaded runner that is a shape
  // the environment sets, not a product claim, so it is printed rather than asserted. A read that is
  // not a number stays red: it means the answer could not be attributed to this call at all.
  const count = Number(counted.text.trim())
  check('a timed-out command never ran twice', Number.isFinite(count) && count <= 1,
    `count=${JSON.stringify(counted.text.trim())} read at ${counted.ms}ms`
    + ` timedOut=${String(counted.value?.timedOut)} exit=${String(counted.value?.exitCode)}`
    + ' (2 would be a replayed frame, 0 that bash never read it)')

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
  // A controlling terminal is any name except `??`. Requiring the `pts/N` spelling was this file
  // committing the very mistake its comment warns about: on the WSL1 frame `ps -o tty=` answers `tty1`,
  // the `/dev/tty` read really does block (measured there: 23 699 ms of silence), and every reactive
  // cell below took its "this distribution has no terminal, so the read errors at once" branch —
  // green while the product burned the deadline. The name goes into the details now, so which branch a
  // frame took is readable from the log instead of inferred from the runner.
  const hasCtty = cttyName !== '' && cttyName !== '??'
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
  // Whether this kernel hands the tool something to act on, measured from this call rather than from a
  // name. Two ways it is true: the body shows the tool *did* act on a reading (the strongest evidence
  // there was one), or the rows themselves name a foreground read on a terminal. `hasCtty` alone was not
  // enough: on the WSL1 frame the terminal is there and the read really does block, but the rows carry no
  // sleep location and no foreground job, so no rule built on `/proc` could have stopped it. What *is*
  // available there — and what the second branch asserts — is the body saying so.
  const canAct = hasCtty && (/first attempt was stopped|waiting for keyboard input/.test(starved.rendered)
    || witnessIn(starved.rendered))
  check('a command waiting for the keyboard is stopped and answered, not left to its deadline',
    !hasCtty
      ? (starved.value?.timedOut === false && starved.ms < 8_000)
      : canAct
        ? (starved.value?.timedOut === false && starved.text.includes('GOT=')
          && /first attempt was stopped/.test(starved.rendered))
        : (starved.value?.timedOut === true && clause(starved.rendered) !== ''),
  JSON.stringify({
    tty: cttyName, branch: !hasCtty ? 'no-ctty' : canAct ? 'reading-acts' : 'reading-declares',
    ms: starved.ms, exit: starved.value?.exitCode, clause: clause(starved.rendered).slice(0, 150),
  }))
  // The stopped-and-re-run sentence is the whole point: the second execution can repeat work the first
  // attempt did before it reached its prompt, and a body that hides that is the defect this file has
  // already caught once (`echo run >> f` landing twice, 2026-10-04).
  const announcedTwice = /run once more on a pseudo-terminal/.test(starved.rendered)
    && /done twice/.test(starved.rendered)
  check('the re-run is announced as a second execution',
    hasCtty && canAct ? announcedTwice : !/run once more on a pseudo-terminal/.test(starved.rendered),
  JSON.stringify({ hasCtty, canAct, announcedTwice, head: starved.rendered.slice(0, 90) }))
  // The ask the remaining keyboard cells use. `starved` above cannot share it: it is the call that
  // *decides* `canAct`, so its 20 s is paid once per run and buys the branch every later cell takes.
  // Where the kernel gives the tool nothing to act on, each of those cells asserts that the call ended
  // at the deadline it was handed and named the reading it relied on — a property of the deadline's
  // *existence*, not of its length, so 8 s proves it as well as 20. Measured on the WSL1 frame of
  // #169: five cells burned 103.5 s of the driver's 215 s there, while the same nine readings totalled
  // 11.9 s on WSL2 where the tool acts. This is the shape `longAskMs` below already uses, and the
  // remaining 36 s of it belongs to `starved`, which cannot know its own branch in advance.
  const waitAskMs = canAct ? 20_000 : 8_000
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
  const vetoed = await call(`sh -c 'read x < /dev/tty; echo GOT=$?'`, { tty: false, timeoutMs: waitAskMs })
  check('tty:false vetoes the re-run and keeps the command on the pipe',
    !hasCtty ? !/run once more on a pseudo-terminal/.test(vetoed.rendered)
      : canAct ? (!/run once more on a pseudo-terminal/.test(vetoed.rendered)
        && !vetoed.text.includes('GOT=') && /waiting for keyboard input/.test(vetoed.rendered))
        : (!/run once more on a pseudo-terminal/.test(vetoed.rendered)
          && vetoed.value?.timedOut === true && clause(vetoed.rendered) !== ''),
  JSON.stringify({ hasCtty, canAct, ms: vetoed.ms, exit: vetoed.value?.exitCode,
    clause: clause(vetoed.rendered).slice(0, 150) }))
  // The shape a real model chose where this plugin's own cells used `sh -c …`: a *builtin* that reads
  // the terminal blocks the session shell itself, so there is no child process to find. Measured while
  // it happened (2026-10-06): the shell's own row is `Ss+ wchan=wait_woken fd0=/dev/tty` with CPU flat,
  // and before the walk included that row the call merely timed out at 30 s and rebuilt the shell.
  const builtinRead = await call(`read -r line < /dev/tty; echo LINE=[$line]`, { timeoutMs: waitAskMs })
  check('a builtin that reads the terminal is ended and re-run, not left to the deadline',
    !hasCtty ? !/ended by restarting the shell/.test(builtinRead.rendered)
      : canAct ? (builtinRead.value?.timedOut === false && builtinRead.text.includes('LINE=[]')
        && /ended by restarting the shell/.test(builtinRead.rendered))
        : (builtinRead.value?.timedOut === true && clause(builtinRead.rendered) !== ''),
  JSON.stringify({ hasCtty, canAct, ms: builtinRead.ms, timedOut: builtinRead.value?.timedOut,
    text: builtinRead.text.trim().slice(0, 20),
    clause: clause(builtinRead.rendered).slice(0, 150) }))

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
  const nested = await call(`bash -c 'read x < /dev/tty; echo GOT=$?'`, { timeoutMs: waitAskMs })
  check('a waiting command inside a wrapper is caught without reading a single word',
    !hasCtty ? !/first attempt was stopped/.test(nested.rendered)
      : canAct ? (nested.value?.timedOut === false && nested.text.includes('GOT=')
        && /first attempt was stopped/.test(nested.rendered))
        : (nested.value?.timedOut === true && clause(nested.rendered) !== ''),
  `${nested.ms}ms exit=${nested.value?.exitCode} canAct=${canAct} :: ${JSON.stringify(clause(nested.rendered).slice(0, 150))}`)
  // A deadline the call named does not buy a keyboard wait back — the property the old 8-second cap was
  // built to hold, now earned by evidence instead of by a name list. 60 seconds asked, ~2 answered.
  // Where the kernel gives the tool nothing to act on, the same property has the other shape: the call
  // waits the deadline it was given instead of inventing a stop, so the ask shrinks to 8 seconds and
  // what is asserted is that it was not cut short by a guess.
  const longAskMs = canAct ? 60_000 : 8_000
  const longAsked = await call(`sh -c 'read x < /dev/tty; echo GOT=$?'`, { timeoutMs: longAskMs })
  check('a longer deadline does not buy a keyboard wait back',
    !hasCtty ? (longAsked.value?.timedOut === false && !/first attempt was stopped/.test(longAsked.rendered))
      : canAct ? (longAsked.ms < 20_000 && longAsked.value?.timedOut === false
        && /first attempt was stopped/.test(longAsked.rendered))
        : (longAsked.ms >= longAskMs && longAsked.value?.timedOut === true
          && clause(longAsked.rendered) !== '' && !/first attempt was stopped/.test(longAsked.rendered)),
  JSON.stringify({ canAct, ms: longAsked.ms, asked: longAsked.value?.timeoutMs,
    exit: longAsked.value?.exitCode, clause: clause(longAsked.rendered).slice(0, 150) }))
  // The pager class answers better on the pipe (`man` prints the whole page; on a terminal it opens a
  // pager that waits for keys), so nothing about it is escalated any more — asserted through the
  // program's own eyes rather than a timing guess, and `tty: true` remains the door for the caller who
  // wants the pager itself.
  const stays = await call('man ls > /dev/null 2>&1; echo RC=$?; tty', { timeoutMs: 8_000 })
  // The claim is the *shape*: the pipe was kept, the call answered, and nothing stopped a first
  // attempt looking for a keyboard. `ms < 3000` used to stand in for "it did not wait" — a proxy the
  // environment can beat with nothing wrong: frame 37883332309 measured 3911 ms on the WSL1 runner
  // (cold `man` DB) with the right bytes in the right order. The deadline it asked for bounds the wait
  // now, and the number stays in the reading.
  check('a pager or report keeps the ordinary pipe unless the call asks',
    stays.text.includes('not a tty') && stays.text.includes('RC=0')
    && stays.value?.timedOut === false && stays.value?.aborted !== true
    && !/first attempt was stopped/.test(stays.rendered),
  JSON.stringify({ ms: stays.ms, tail: stays.text.replace(/\s+/g, ' ').slice(-32) }))
  // The loop brake is a sentence, not a refusal: the same failing command twice over says so, and one
  // success clears the count so the ordinary `npm test` after an install is never told to stop. The
  // signature runs in a subshell — a bare `exit 41` would end the session shell itself (measured: it
  // did; the answer now says so, and the cells at the end of this file assert that rather than the old
  // silent abort), so the repeated-failure property has to be driven without taking the shell down.
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
  // Both renderings of the restart have to count as one, because the tool picks between them by
  // whether the rebuild had anything to report: `and its directory …` when nothing was left out,
  // `; not restored: …` when it was. Matching only the first made this cell impossible to pass on a
  // distribution where the rebuild does report — measured 2026-10-06 on the external gauntlet's
  // machine, where the claim and the fact were both true and the cell still read them as disagreeing.
  const actuallyRestarted = /was restarted (and its directory|; not restored:)/.test(ptyTimeout.rendered)
  check('a timed-out call says a restart only when the session had one',
    ptyTimeout.value?.timedOut === true && claimedRecovery === actuallyRestarted,
    JSON.stringify({ claimedRecovery, actuallyRestarted, timedOut: ptyTimeout.value?.timedOut }))
  // And a deadline reached *with* looks taken has to print what they read. On WSL2 the line names the
  // sleep location and the syscall number; on the WSL1 runner (frame 37494104075) `wchan` and `syscall`
  // both come back empty for every process, which the line prints as `w=not-reported`. A body that says
  // only "timed out" there reads as though the wait had been examined and found ordinary — which is
  // precisely the claim this layer must not make about a kernel it cannot read.
  const looked = await call('sleep 3', { timeoutMs: 1_500 })
  // The clause is printed at the front of the detail on purpose: the tail-150 form that first carried
  // it was cut off in the WSL1 frame's log, which left "did the reading run there" unanswered for a
  // round even though the cell had passed.
  check('a timed-out call carries the reading it took',
    looked.value?.timedOut === true && clause(looked.rendered) !== '',
  JSON.stringify(clause(looked.rendered).slice(0, 150) || looked.rendered.slice(-150)))
  // The `tty: false` veto is asserted offline instead (`tests/wsl-bash-tty.test.ts`): it is a decision,
  // and the only live discriminator would be a program that hangs on a real terminal, which would make
  // the cell's cost the very defect it is measuring.

  // The protection the old 8-second cap existed to give, now carried by the reading instead of by a
  // name list. A real session measured the cost of the older rule: `printf '%s\n' X; vim note.txt` was
  // not escalated at all, sat out the configured two minutes, and handed the model the screen's raw
  // escapes — 121 703 ms for nothing (`D:\Temp` evidence sheet, turn 22). Bytes arriving first must not
  // blind the watchdog, so this cell writes a line and *then* waits for a keyboard.
  const compound = await call(`printf 'x\\n'; sh -c 'read y < /dev/tty; echo GOT=$?'`, { timeoutMs: waitAskMs })
  check('a wait after some output is still caught',
    !hasCtty ? (compound.text.includes('x') && compound.text.includes('GOT='))
      : canAct ? (compound.text.includes('x') && compound.text.includes('GOT=') && compound.ms < 20_000
        && /first attempt was stopped/.test(compound.rendered))
        : (compound.text.includes('x') && compound.value?.timedOut === true
          && clause(compound.rendered) !== '' && !/first attempt was stopped/.test(compound.rendered)),
  JSON.stringify({ canAct, ms: compound.ms, exit: compound.value?.exitCode,
    text: compound.text.replace(/\s+/g, ' ').trim().slice(0, 24),
    clause: clause(compound.rendered).slice(0, 150) }))
  // The premise of the whole layer, checked rather than assumed: the reading has to cite the `/proc`
  // fields it read. A probe that silently stopped answering (no `pgrep`, a hardened `/proc` mount) would
  // look exactly like a command that is not waiting, so a reading with no provenance in it is the red
  // flag. Where the tool acted, the citation is the field that justified it; where it could not, the
  // body still has to say which fields it read and got nothing from.
  check('the reading names the /proc field it came from',
    /\/proc\/<pid>\/(wchan|syscall)/.test(vetoed.rendered)
    && (canAct ? /wait_woken/.test(vetoed.rendered) : clause(vetoed.rendered) !== ''),
  JSON.stringify({ canAct, clause: clause(vetoed.rendered).slice(0, 150) || vetoed.rendered.slice(0, 80) }))
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

  // ── the stdin channel ─────────────────────────────────────────────────────
  // The protocol owns the shell's stdin, so a command's stdin was `/dev/null` by construction — which
  // is right for most calls and wrong for the class that reads a program's input from a pipe. The
  // caller's text now travels inside the frame and is decoded into a file the command reads from; the
  // cell that matters is not "the bytes arrived" but "the protocol still settles afterwards", because
  // a command fed from the session's own pipe would eat the record that ends the call.
  //
  // The first call puts the session back home: the cell above deleted the directory an earlier
  // relative-`workdir` call had left it in (the `cd` in that wrapper is the session's own), and a
  // *new* bash started in a deleted directory reports `shell-init: error retrieving current directory`
  // — true, but the escalated cell below is about the stdin channel and must not read as if that line
  // were its result. Measured here: without this `cd` the line appears in the cell's text.
  await call(`cd "${linuxHome}"`)
  const fed = await call('cat; echo RC=$?', { stdin: 'STDIN_LINE_1\nSTDIN_LINE_2\n' })
  check('a command reads the caller’s stdin, and the record still settles after it',
    fed.text.includes('STDIN_LINE_1') && fed.text.includes('STDIN_LINE_2') && fed.value?.exitCode === 0,
    `${fed.ms}ms ${JSON.stringify(fed.text.trim().slice(0, 60))}`)
  const afterFed = await call('echo AFTER_STDIN_$(( 4 * 4 ))')
  check('the session’s stdin was not consumed by the command', afterFed.text.includes('AFTER_STDIN_16'),
    JSON.stringify(afterFed.text.trim().slice(0, 40)))

  // The escalated path gets the same input: `script` forwards its stdin to the pty it creates, so a
  // program that reads its terminal is fed there too. Measured here rather than assumed, because the
  // wrapper changes who owns stdin (`script`, not the eval).
  const fedTty = await call('read x; echo GOT=$x', { tty: true, stdin: 'typed-by-stdin\n' })
  check('stdin reaches a command on the escalated pseudo-terminal too',
    /GOT=typed-by-stdin/.test(fedTty.text) && fedTty.value?.exitCode === 0,
    `${fedTty.ms}ms ${JSON.stringify(fedTty.text.trim().slice(0, 200))}`)

  // Over the ceiling the call refuses by name and runs nothing — the alternative is a program failing
  // on half its input, which reads as the program's fault.
  let refusal = ''
  try {
    await call('cat', { stdin: 'x'.repeat(32 * 1024 + 1) })
    refusal = '(no error thrown)'
  } catch (error) {
    refusal = String(error?.message ?? error)
  }
  check('an input over the frame ceiling is refused, not truncated',
    /32768-byte ceiling/.test(refusal) && /nothing was truncated/.test(refusal),
    JSON.stringify(refusal.slice(0, 120)))

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

  // The cap is a budget per function, not a veto over the snapshot. Measured 2026-10-06 on a
  // distribution whose own startup functions alone are 86,954 bytes: the whole-set form reported
  // `functions (86954 bytes over the 65536 byte cap)` and restored *nothing*, the function the model
  // had just defined included. Those functions do not need replaying at all — a rebuilt shell
  // re-sources the same startup files — and one oversized user function must not take its neighbours
  // down with it, so this cell makes exactly that shape: a body over the cap beside a small one.
  const mixed = await call('big=$(printf "x%.0s" $(seq 1 70000)); eval "dshhugefn() { : $big; }"; '
    + 'dshsmallfn() { echo SMALL_OK_6; }; declare -f dshhugefn | wc -c')
  const hugeBytes = Number((mixed.text.match(/^\s*(\d+)/) ?? [])[1] ?? '0')
  const bigRestart = await call('sleep 4', { timeoutMs: 1_500 })
  const named = /not restored: functions dshhugefn\(\d+\)([^.\n]*)\(over the \d+ byte cap/.test(bigRestart.rendered)
  const keptBack = await call('dshsmallfn')
  check('a function over the cap is named, and the others still come back',
    hugeBytes > 65_536 && named && keptBack.text.includes('SMALL_OK_6'),
    `huge=${hugeBytes}B note=${JSON.stringify(bigRestart.rendered.slice(-160))} kept=${JSON.stringify(keptBack.text.trim().slice(0, 40))}`)
  await call('unset -f dshhugefn dshsmallfn 2>/dev/null; true')

  // The same reporting on the path that needs it most. A builtin that reads the terminal blocks the
  // shell itself, so the rebuild happens *inside* the starve handling, and the run the tool reports is
  // the pseudo-terminal retry — which does not know about the rebuild unless the first attempt's facts
  // are carried onto it. Measured before the fix: the restart happened, functions were left behind,
  // and the call answered as if nothing had been lost.
  await call('big=$(printf "x%.0s" $(seq 1 70000)); eval "dshhugefn2() { : $big; }"')
  const starveReport = await call('read -r line < /dev/tty; echo LINE=[$line]', { timeoutMs: waitAskMs })
  // The half that does not move between kernels is the report of what the rebuild left behind — that is
  // the seam the cell was written for. What moves is the *reason* sentence: where the kernel exposes the
  // wait the call was stopped and the body says so, where it does not the body carries the reading it
  // took instead. A rebuild that hides a loss is red on either arm; a reason that is not the one that
  // actually fired is red too.
  check('a rebuild triggered by a terminal wait reports what it could not restore',
    /not restored: functions dshhugefn2\(\d+\)/.test(starveReport.rendered)
    && (canAct
      ? /waiting for a keyboard|ran twice|pseudo-terminal/i.test(starveReport.rendered)
      : clause(starveReport.rendered) !== '' && starveReport.value?.timedOut === true),
    JSON.stringify({ canAct, clause: clause(starveReport.rendered).slice(0, 90),
      tail: starveReport.rendered.slice(-120) }))
  await call('unset -f dshhugefn2 2>/dev/null; true')

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
    'exec sleep 41'], { stdio: 'ignore' }) // portability-allow: a control process nobody reads and nobody checks; the driver holds its lifetime open on purpose
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
  await call('cd /tmp && export DSHISO=from_A_$(( 6 * 7 ))')
  const foreign = await call('pwd; echo ISO=[$DSHISO]', {}, ownerB)
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
  await call('setsid sleep 37 & disown; echo B_DETACHED=$!', {}, ownerB)
  const beforeForeignReap = probeCount('sleep[ ]37')
  const aRebuild = await call('sleep 4', { timeoutMs: 1_500 })
  const afterForeignReap = probeCount('sleep[ ]37')
  check('a rebuild reaps only the session that owns the token',
    beforeForeignReap >= 1 && afterForeignReap >= 1 && /detached process|the shell was restarted/.test(aRebuild.rendered),
  JSON.stringify({ beforeForeignReap, afterForeignReap, note: aRebuild.rendered.slice(-58) }))
  const bAlive = await call('echo B_STILL_$(( 3 * 9 ))', {}, ownerB)
  check('the other agent’s shell answered through its own rebuild', bAlive.text.includes('B_STILL_27'),
    JSON.stringify(bAlive.text.trim().slice(0, 40)))

  // `run_in_background` must not be an argument that is quietly ignored — the repository has already
  // been bitten once by a `bash` that accepted it and ran in the foreground. The reply shape is the
  // host's (`started background job <id>`), and the hand-off carries the job kind and `onExpiry: none`
  // so the job outlives one command's timeout.
  const bgArgs = { command: 'echo BG_$(( 6 * 7 ))', description: 'compatibility driver: background arm', run_in_background: true }
  const bg = await tool.execute(bgArgs, budget(owner, bgArgs))
  const bgText = (tool?.output?.render?.(bgArgs, bg) ?? []).map(part => String(part?.text ?? '')).join('')
  check('run_in_background hands off to the jobs producer', bg?.kind === 'background'
    && bg?.jobId === 'job-dsh-session-real' && bgText === 'started background job job-dsh-session-real'
    && jobRequest?.kind === 'bash' && typeof jobRequest?.run === 'function'
    && typeof jobRequest?.label === 'string' && jobRequest.label.includes('BG_$'),
  JSON.stringify({ kind: bg?.kind, jobId: bg?.jobId, requested: jobRequest?.kind, label: jobRequest?.label }))
  const afterBg = await call('echo AFTER_BG_$(( 2 * 2 ))')
  check('the backgrounded command did not run inside the session shell', !afterBg.text.includes('BG_42')
    && afterBg.text.includes('AFTER_BG_4'), JSON.stringify(afterBg.text.trim()))

  // The same hand-off with an input. The one-shot executor is the same code the host's own `bash`
  // tool uses in its background arm, and it takes `stdin` on the resolved spec, so a backgrounded
  // command is fed the way a foreground one is. Measured by *running* the job the producer recorded:
  // the registry double above never calls `run()`, and a claim about what a job receives has to come
  // from the job.
  const bgStdinArgs = { command: 'cat; echo RC=$?', description: 'compatibility driver: background stdin', run_in_background: true, stdin: 'FED_TO_BACKGROUND\n' }
  await tool.execute(bgStdinArgs, budget(owner, bgStdinArgs))
  const bgJob = jobRequest.run()
  const bgOutcome = await bgJob.done
  // This producer's `readOutput` is the registry's contract — a rendered string, not the shell
  // handle's `{delta}` — and the first version of this cell read it as the latter and asserted on ''.
  const bgBody = String(bgJob.readOutput() ?? '')
  check('a backgrounded command is fed the caller’s stdin too',
    bgBody.includes('FED_TO_BACKGROUND') && bgBody.includes('RC=0') && bgOutcome?.status === 'completed',
    JSON.stringify({ status: bgOutcome?.status, detail: bgOutcome?.detail, body: bgBody.trim().slice(0, 60) }))

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

  // ── lines that end the shell, answered rather than reported as a cancel ───────────────────
  //
  // Three real shapes do this, and a person's own terminal ends on all three too — the standard this
  // repository holds is parity with native, so none of them is a defect *for ending the shell*. The
  // defect was the answer: the call came back `Error: tool call aborted`, which is the sentence a cancel
  // says, the streams the command had already produced were dropped, and the rebuild was narrated on the
  // NEXT call, where it reads as that call's own event. Measured on the installed build through a real
  // session (2026-10-09): before the fix `echo out; echo err >&2; exit 3` → 1 894 ms, aborted, no bytes;
  // after it → 1 498 ms with `out`, `err` and `[exit code: 3]`; `set -e; false` → 1 163 ms and
  // `exec bash --norc` → 1 162 ms, both with the disclosure sentence.
  const endsByExit = await call('echo out; echo err >&2; exit 3')
  check('a line that exits the shell answers with both of its streams',
    endsByExit.text.includes('out') && String(endsByExit.value?.stderr?.text ?? '').includes('err')
      && /ended the session shell/.test(endsByExit.rendered) && endsByExit.value?.exitCode === 3
      && endsByExit.value?.aborted === false,
  // `text` is the tool's stdout field only — stderr is its own field on the same object, so a cell that
  // looks for both in `text` fails on a build that answered correctly (measured: first run of this cell
  // read FAIL with `exit=3, aborted=false`, because `err` was never in `text`).
  JSON.stringify({ ms: endsByExit.ms, exit: endsByExit.value?.exitCode,
    aborted: endsByExit.value?.aborted, out: endsByExit.text.trim().slice(0, 20),
    err: String(endsByExit.value?.stderr?.text ?? '').trim().slice(0, 20),
    disclosure: /ended the session shell/.test(endsByExit.rendered) }))
  const endsByErrexit = await call('set -e; false; echo NEVER')
  check('`set -e` ending the shell is answered the same way, not as a cancel',
    /ended the session shell/.test(endsByErrexit.rendered) && !/NEVER/.test(endsByErrexit.text)
      && endsByErrexit.value?.aborted === false,
  JSON.stringify({ ms: endsByErrexit.ms, exit: endsByErrexit.value?.exitCode,
    text: endsByErrexit.text.trim().slice(0, 40) }))
  const endsByExec = await call('exec bash --norc')
  check('`exec` replacing the shell is answered the same way',
    /ended the session shell/.test(endsByExec.rendered) && endsByExec.value?.aborted === false,
  JSON.stringify({ ms: endsByExec.ms, text: endsByExec.text.trim().slice(0, 40) }))
  const afterEnds = await call('echo AFTER_END_$(( 6 * 7 ))')
  check('the call after a shell-ending line answers, from the rebuilt shell',
    afterEnds.text.includes('AFTER_END_42'),
  JSON.stringify({ ms: afterEnds.ms, text: afterEnds.text.trim().slice(0, 40),
    restarted: /restarted/.test(afterEnds.rendered) }))
  // The shape the `du` case on a real desktop showed: a long command that had already produced output
  // when its own deadline arrived. Asserted as a shape, not a duration — the answer must carry what the
  // command printed, name the deadline it reached, and point at the background door. Timing beyond
  // `>= asked` is the runner's business, which is why nothing here bounds the work itself.
  const slowPartial = await call('echo BEFORE_SLOW; sleep 6; echo AFTER_SLOW', { timeoutMs: 1_500 })
  check('a deadline reached mid-command keeps the bytes it already produced',
    slowPartial.text.includes('BEFORE_SLOW') && !slowPartial.text.includes('AFTER_SLOW')
      && /timed out after/.test(slowPartial.rendered)
      && /run_in_background|bash_background/.test(slowPartial.rendered)
      && slowPartial.ms >= 1_500,
  JSON.stringify({ ms: slowPartial.ms, text: slowPartial.text.trim().slice(0, 40),
    clause: clause(slowPartial.rendered).slice(0, 90) }))

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

// Every `check(` site in this file, read out of this file. The count in the summary used to be a
// number typed by whoever added a cell, so a run that reached 46 of them on the WSL1 frame reported
// "expected 73" and named nothing — the reader had to diff two logs to learn that a whole stretch of
// cells never ran. Now the audit is derived: a site with no matching verdict is listed by name.
const sites = [...readFileSync(new URL(import.meta.url), 'utf8')
  .matchAll(/^[ \t]*(?:await[ \t]+)?check\([ \t]*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/gm)]
  .map(match => (match[1] ?? match[2] ?? match[3] ?? '').trim())
  .filter(name => name !== '')
/** Compare a site with a verdict: a `${dynamic}` label matches on the literal part it starts with. */
const norm = text => text.replace(/\$\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 28)
// Two sites exist only to report a failure from inside a `catch`, so a green run never reaches them
// and the audit must not count what it cannot see. Anything else that goes unreported is a red below.
const CATCH_ONLY = ['every call returned', 'the keyboard door ran'].map(norm)
const ranKeys = [...new Set(results.map(entry => norm(entry.name)))]
const missing = [...new Set(sites.map(norm))]
  .filter(key => key !== '' && !CATCH_ONLY.includes(key)
    && !ranKeys.some(name => name === key || name.startsWith(key)))
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} checks passed, ${sites.length} check sites in this file `
  + `(plane=${plane()}, distro=${distro}, user=${username}, cwd=${sessionCwd})`)
if (missing.length > 0) {
  console.error(`bash-session-real: RED — ${missing.length} check site(s) below never ran; a short run must not report green:`)
  for (const name of missing.slice(0, 40)) console.error(`  not run: ${name}`)
  process.exitCode = 1
} else if (passed !== results.length) {
  console.error('bash-session-real: RED — at least one check failed')
  process.exitCode = 1
}
// The shells this driver started keep their stdin pipes open; exiting explicitly is the teardown,
// not a shortcut.
process.exit(process.exitCode ?? 0)
