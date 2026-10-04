/**
 * The readiness probe's decision table, offline.
 *
 * issue #51's headline is a WSL workspace where every `bash` call failed on a host
 * that had passed this plugin's capability probe. The cheap probe asks whether a
 * terminal inspector can be built; this stage asks whether a real WSL shell under
 * that host reaches the state the backend's completion check looks for. Nothing
 * here spawns anything: each case hands the probe a fake terminal face whose shell
 * is described by two properties — the prompt it prints and whether it answers a
 * command at all — and a short budget, so a never-ready case costs 400 ms rather
 * than the production 15 s.
 *
 * The two prompt shapes are the measured ones: `DEFAULT_PROMPT` is what the shipped
 * relay produced before the WSLENV bridge (the distribution's own prompt, no marker
 * — issue #51 point 2), `READY_PROMPT` is what it produces after it. The fake echoes
 * the nonce the probe actually chose, so a pass cannot be bought with a canned string.
 *
 *   node --test --experimental-strip-types tests/pty-readiness.test.mjs
 *
 * @module dsh-wsl-workspace/tests/pty-readiness
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  probePersistentShellReadiness,
  stripTerminalEscapes,
  READINESS_PROBE_BUDGET_MS,
} from '../src/host/pty-readiness.ts'

const PATHS = { relayPath: 'D:/fake/lib/wsl-relay.js', nodePath: 'D:/fake/node.exe' }
const BUDGET_MS = 400
/** A registered workspace path: the cwd shape a WSL session actually gets. */
const PROBE_CWD = String.raw`\\wsl.localhost\Ubuntu\home`

/** The host's marker plus its controlled prompt: what the backend compares against. */
const READY_PROMPT = '\u001b]133;D;0\u0007\u001b[?2004hdsh> '
/** What the distribution prints when the contract never crossed (issue #51 point 2). */
const DEFAULT_PROMPT = 'ruler@ENMUSUBI\u001b[m:\u001b[m/home$ '

/**
 * A fake `subprocess` face replaying one canned shell.
 * @param options - `prompt` is what the shell prints at every prompt, `answers`
 *   whether it runs the command it is handed; plus the degradation and failure knobs.
 * @returns the face plus a record of what the probe did.
 */
function fakeTerminal(options = {}) {
  const prompt = options.prompt ?? DEFAULT_PROMPT
  const calls = { spawned: [], wrote: [], terminated: 0 }
  let emit = () => {}
  const handle = {
    output: {
      setEncoding() {},
      on(_event, listener) { emit = listener },
    },
    write: async (data) => {
      calls.wrote.push(data)
      // A PTY echoes what it is handed whether or not the shell runs it. The fake
      // reproduces both halves separately, because that distinction is the whole
      // point of the probe's arithmetic command.
      const echoed = /echo (dshwslprobe)\$\(\( (\d+) \* 2 \)\)/.exec(data)
      if (options.silent !== true) setTimeout(() => emit(`${data.trim()}\r\n`), 0)
      if (echoed === null || options.executes === false || options.silent === true) return
      const answer = `${echoed[1]}${Number(echoed[2]) * 2}`
      setTimeout(() => emit(`${answer}\r\n${prompt}`), 5)
    },
    terminate: async () => { calls.terminated += 1 },
    done: options.exit === undefined
      ? new Promise(() => {})
      : Promise.reject(new Error(options.exit)),
  }
  if (options.noOutputStream === true) delete handle.output
  if (options.noWrite === true) delete handle.write
  const face = {
    spawnTerminal: async (spec) => {
      calls.spawned.push(spec)
      // A macrotask, not a microtask: the probe attaches its data listener only after
      // the awaited spawn resolves, so bytes delivered a tick earlier fall on the floor
      // and every case reads as "no wire" (the first draft of this fixture did exactly
      // that, and it looked like a probe that could not pass).
      setTimeout(() => emit(`Welcome to Ubuntu\r\n${prompt}`), 0)
      return handle
    },
  }
  if (options.rejects !== undefined) {
    face.spawnTerminal = async (spec) => { calls.spawned.push(spec); throw new Error(options.rejects) }
  }
  return { face, calls, handle }
}

test('a shell that prints the controlled prompt and runs the command is ready', async () => {
  const { face, calls } = fakeTerminal({ prompt: READY_PROMPT })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, 2_000)
  assert.equal(result.ready, true, result.detail)
  assert.match(result.detail, /command round-tripped with the readiness contract in \d+ms/)
  assert.equal(calls.spawned.length, 1, 'exactly one PTY allocated')
  assert.deepEqual(calls.spawned[0].argv, [PATHS.nodePath, PATHS.relayPath],
    'the relay is started the way the backend starts it')
  assert.equal(calls.spawned[0].terminalType, 'dumb', 'the same terminal type the backend asks for')
  assert.equal(calls.terminated, 1, 'the probe process is taken down')
  assert.match(calls.wrote[0] ?? '', /^echo dshwslprobe\$\(\( \d{7,8} \* 2 \)\)\r$/,
    `the probe must send a command whose answer is not its own text, saw ${JSON.stringify(calls.wrote[0])}`)
  assert.equal(calls.spawned[0].env.PS1, 'dsh> ', 'the injected contract is the shared declaration, not a local copy')
})

test('the distribution default prompt is NOT readiness (issue #51 point 2)', async () => {
  const { face, calls } = fakeTerminal({ prompt: DEFAULT_PROMPT })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, BUDGET_MS)
  assert.equal(result.ready, false, 'the command ran, and it still is not ready — the host could never recognise this shell')
  assert.match(result.detail, /no OSC 133;D marker/, 'it names the missing marker')
  assert.match(result.detail, /prompt/, 'and the missing prompt')
  assert.equal(calls.terminated, 1, 'and the probe shell is still taken down')
})

test('a shell that echoes but never executes is not ready', async () => {
  // The case the arithmetic command exists for: the echoed input line contains the
  // probe's own text, so a probe matching that text would report ready here.
  const { face, calls } = fakeTerminal({ prompt: READY_PROMPT, executes: false })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, BUDGET_MS)
  assert.equal(result.ready, false, 'an echo is not an execution')
  assert.match(result.detail, /never produced its computed answer/)
  assert.equal(calls.terminated, 1)
})

test('a shell that swallows the command entirely is not ready', async () => {
  const { face } = fakeTerminal({ prompt: READY_PROMPT, silent: true })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, BUDGET_MS)
  assert.equal(result.ready, false, 'no echo and no answer is the plainest broken shell')
  assert.match(result.detail, /never produced its computed answer/)
})

test('a shell that exits during the probe is not ready, and its message survives', async () => {
  const { face } = fakeTerminal({ exit: 'Error: PTY shell exited during startup' })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, 2_000)
  assert.equal(result.ready, false, "issue #40/#51's literal failure text must not read as ready")
  assert.match(result.detail, /PTY shell exited during startup/, 'the host failure text is passed through, not swallowed')
})

test('a spawn that throws is not ready', async () => {
  const { face } = fakeTerminal({ rejects: 'subprocess-local: terminal inspection is unsupported on platform win32' })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, BUDGET_MS)
  assert.equal(result.ready, false)
  assert.match(result.detail, /spawnTerminal rejected the relay/)
})

test('an unreadable terminal handle is reported unverified, not failed', async () => {
  for (const variant of [{ noOutputStream: true }, { noWrite: true }]) {
    const { face, calls } = fakeTerminal({ ...variant, prompt: READY_PROMPT })
    const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, BUDGET_MS)
    assert.equal(result.ready, true, `${JSON.stringify(variant)}: an unknown handle is not evidence of a broken host`)
    assert.equal(result.unverifiable, true, `${JSON.stringify(variant)}: and the answer says it was not verified`)
    assert.match(result.detail, /NOT verified/)
    assert.equal(calls.terminated, 1, `${JSON.stringify(variant)}: the handle is still taken down`)
  }
})

test('no subprocess service at all leaves the previous answer intact', async () => {
  const result = await probePersistentShellReadiness(undefined, PATHS, PROBE_CWD, BUDGET_MS)
  assert.equal(result.ready, true)
  assert.equal(result.unverifiable, true)
  assert.match(result.detail, /no subprocess service/)
})

test('the prompt check survives ConPTY rendering the trailing space as a cursor move', () => {
  // Measured 2026-10-04: the wire can carry `dsh>` then `ESC [ 1 C` instead of a space.
  const wire = '\u001b]133;D;0\u0007\u001b[?2004hdsh>\u001b[1C'
  assert.ok(stripTerminalEscapes(wire).includes('dsh>'), 'the escape strip is what makes this check possible')
  assert.ok(!wire.includes('dsh> '), 'and the raw bytes really do not contain the trailing space')
})

test('the injected environment is minimal, not the host process environment', async () => {
  const { face, calls } = fakeTerminal({ prompt: READY_PROMPT })
  await probePersistentShellReadiness(face, PATHS, PROBE_CWD, 2_000)
  const env = calls.spawned[0].env
  assert.ok(!('HOME' in env) && !('USERPROFILE' in env), `a user profile must not ride along: ${Object.keys(env).join(', ')}`)
  assert.ok(!Object.keys(env).some(key => /KEY|PASSWORD|SECRET|TOKEN/i.test(key)), 'no credential-shaped name is forwarded')
  assert.match(env.PATH, /\\System32/i, 'and wsl.exe, resolved by name, is reachable')
})

test('the budget is a measured number, not a tuned one', () => {
  assert.equal(READINESS_PROBE_BUDGET_MS, 15_000,
    '15 s ≈ 3.75x the slowest legitimate boot measured on this machine (3998 ms cold, 2651 ms warm)')
})

test('the probe starts the relay in the SESSION cwd shape, and says so', async () => {
  const { face, calls } = fakeTerminal({ prompt: READY_PROMPT })
  const result = await probePersistentShellReadiness(face, PATHS, PROBE_CWD, 2_000)
  assert.equal(calls.spawned[0].cwd, PROBE_CWD,
    'the cwd the backend will use is the cwd the probe must use')
  assert.match(PROBE_CWD, /^\\\\wsl\.localhost\\/, 'the fixture cwd really is a UNC path')
  assert.equal(result.ready, true, result.detail)
  assert.ok(!result.detail.includes('unverified'), `a UNC cwd pass must not carry the caveat: ${result.detail}`)
})

test('a pass at a Windows cwd is reported as NOT covering the UNC startup shape', async () => {
  // issue #51 point 1 is about starting the relay with a UNC cwd. A probe that always
  // started in SystemRoot could report ready while every session still failed, so the
  // verdict has to name the cwd it actually checked.
  const { face, calls } = fakeTerminal({ prompt: READY_PROMPT })
  const result = await probePersistentShellReadiness(face, PATHS, 'C:\Windows', 2_000)
  assert.equal(calls.spawned[0].cwd, 'C:\Windows')
  assert.equal(result.ready, true, 'the shell really is ready at that cwd')
  assert.match(result.detail, /NOT a WSL UNC path, so the UNC startup shape is unverified/,
    `and the log must say which shape it did not prove: ${result.detail}`)
})
