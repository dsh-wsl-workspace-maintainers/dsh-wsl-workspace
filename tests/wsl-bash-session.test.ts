/**
 * The session lifecycle, offline: spawn → frame → settle, and the four ways a call can end badly.
 *
 * `src/host/wsl-bash-session.ts` is the plugin's most defection-dense core (the 2026-10-24 audit:
 * 1 026 lines with 7 offline cases, all of them spill arithmetic), and until this file its
 * lifecycle was reachable only on a real distribution — an ubuntu contributor or CI job could
 * change it blind. These tests drive the class through its own protocol — real `encodeFrame` lines
 * in, real NUL records out — over a fake `subprocess.spawn` handle, so what is under test is the
 * session's state machine, not its collaborators:
 *
 *   · one command round-trips, and the shell's echo of the frame never reaches the answer;
 *   · a command that wedges runs exactly once — the deadline rebuilds the session and does not
 *     re-execute a live command (`git commit`, `rm`) a second time;
 *   · a shell that dies mid-call is rebuilt and the command DOES re-run there — a dead child
 *     cannot still hold the shell, and the difference between these two is the whole contract;
 *   · a caller abort reports itself as the caller's action, not a timeout, and does not re-run;
 *   · two concurrent calls serialise on the one-frame-in-flight protocol;
 *   · a disposed session refuses further work.
 *
 * Deliberately not here: the watchdog's `/proc` reads (`tests/wsl-bash-starve.test.ts` pins the
 * reading against transcribed real rows), spill arithmetic (`tests/wsl-bash-spill.test.ts`), and
 * how a real 9P pipe fragments (`scripts/compatibility/bash-session-real.mjs`).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'

import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { BOOTSTRAP_COMMAND, RECORD_TAG, STATE_TAG } from '../src/host/wsl-bash-protocol.ts'
import { WslBashSession, type WslBashSpawnHost, type WslBashSessionSpec } from '../src/host/wsl-bash-session.ts'

/** One scripted outcome for a command. `silent` never answers; `exit` ends the shell instead. */
interface Answer {
  stdout?: string
  stderr?: string
  status?: number
  /** Never write the completion record: the frame wedges until its deadline. */
  silent?: boolean
  /** Write stdout, then end the shell with this code and no completion record. */
  exit?: number
  /** Hold the answer until this resolves, so a test can prove another call is queued behind it. */
  gate?: Promise<void>
}

/** The command text a frame line carries (its payload is base64 inside the `eval`). */
function commandOf(frame: string): string {
  return Buffer.from(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(frame)?.[1] ?? '', 'base64').toString('utf8')
}

/** The nonce a frame line will answer with (printed beside `$__dsh_status`). */
function nonceOf(frame: string): string {
  return /'([^']+)' "\$__dsh_status"/.exec(frame)?.[1] ?? ''
}

/**
 * A `wsl.exe` stand-in that speaks the protocol: on a frame it echoes the line to stderr (the
 * shell's line editor does), answers with the scripted bytes, writes the stderr-end marker, the
 * completion record, and — a few ms later, as the real shell does — the state record.
 */
class FakeShell {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly frames: string[] = []
  terminated = false
  private settle!: (outcome: { exitCode: number | null }) => void
  readonly done: Promise<{ exitCode: number | null }>
  readonly stdin = {
    write: (frame: string): void => {
      this.frames.push(frame)
      const command = commandOf(frame)
      const nonce = nonceOf(frame)
      const answer = this.script(command)
      const state = Buffer.from('#dsh-section pwd\nPWD=/tmp/ws\n#dsh-section pid\nPID=4242\n#dsh-section functions-count\n0\n', 'utf8')
      void (async () => {
        await answer.gate
        await new Promise(resolve => setTimeout(resolve, 1))
        if (answer.silent === true) return
        if (answer.exit !== undefined) {
          this.stdout.emit('data', Buffer.from(answer.stdout ?? '', 'utf8'))
          this.settle({ exitCode: answer.exit })
          return
        }
        this.stderr.emit('data', Buffer.from(`\r${frame.slice(-70).trimEnd()}\n`, 'utf8'))
        if (answer.stderr !== undefined) this.stderr.emit('data', Buffer.from(answer.stderr, 'utf8'))
        this.stderr.emit('data', Buffer.from([0]))
        if (answer.stdout !== undefined) this.stdout.emit('data', Buffer.from(answer.stdout, 'utf8'))
        this.stdout.emit('data', Buffer.from(`\0${RECORD_TAG}\0${nonce}\0${answer.status ?? 0}\0`, 'latin1'))
        setTimeout(() => this.stdout.emit('data', Buffer.from(`\0${STATE_TAG}\0${nonce}\0${state.toString('base64')}\0`, 'latin1')), 3)
      })()
    },
  }

  private readonly script: (command: string) => Answer

  constructor(script: (command: string) => Answer) {
    this.script = script
    this.done = new Promise(resolve => { this.settle = resolve })
  }

  terminate(): void {
    this.terminated = true
    this.settle({ exitCode: null })
  }
}

/** A spawn seam that hands out scripted shells and remembers every one it made. */
function fakeHost(script: (command: string) => Answer): { host: WslBashSpawnHost, shells: FakeShell[] } {
  const shells: FakeShell[] = []
  return {
    shells,
    host: {
      subprocess: {
        spawn: (): SubprocessHandle => {
          const shell = new FakeShell(script)
          shells.push(shell)
          return shell as unknown as SubprocessHandle
        },
      },
    },
  }
}

/** A spec with the watchdog switched off (`reaperArgv: []`), so these tests are about the lifecycle. */
function spec(): WslBashSessionSpec {
  return {
    argv: ['wsl.exe', '-d', 'Ubuntu'],
    cwd: 'C:\\tmp',
    env: {},
    graceMs: 50,
    bootTimeoutMs: 2_000,
    maxOutputBytes: 1024 * 1024,
    sessionToken: 'offline-test',
    reaperArgv: [],
    witnessArgv: [],
  }
}

const BOOT: Answer = {}
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('one command round-trips, and the frame echo never reaches the answer', async () => {
  const { host, shells } = fakeHost(command =>
    command === BOOTSTRAP_COMMAND ? BOOT : { stdout: 'hi\n', stderr: 'warn\n', status: 0 })
  const session = new WslBashSession(host, spec())
  await session.start()
  const run = await session.run('echo hi', 2_000)
  assert.deepEqual(
    { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timedOut: run.timedOut, aborted: run.aborted, shellExited: run.shellExited, restarted: run.restarted },
    { stdout: 'hi\n', stderr: 'warn\n', exitCode: 0, timedOut: false, aborted: false, shellExited: false, restarted: false },
    'the answer is the command\'s own bytes — the echoed frame line is protocol, not stderr')
  assert.equal(shells.length, 1, 'a healthy session never spawns a second shell')
  assert.deepEqual(shells[0]!.frames.map(commandOf), [BOOTSTRAP_COMMAND, 'echo hi'])
  await session.dispose()
})

test('a wedged command runs exactly once: the deadline rebuilds without re-executing a live command', async () => {
  const { host, shells } = fakeHost(command =>
    command === BOOTSTRAP_COMMAND ? BOOT : command === 'git commit' ? { silent: true } : { status: 0 })
  const session = new WslBashSession(host, spec())
  await session.start()
  const run = await session.run('git commit', 150)
  assert.equal(run.timedOut, true, 'the deadline the caller asked for is what ended the call')
  assert.equal(run.restarted, true, 'the session rebuilt so the next call does not queue behind the wedge')
  assert.equal(run.exitCode, -1, 'a killed deadline reports -1, not a shell status it never read')
  assert.equal(shells[0]!.frames.filter(frame => commandOf(frame) === 'git commit').length, 1,
    'the command went out exactly once — a merely-slow command must not be executed twice')
  assert.equal(shells.length, 2, 'the rebuild spawned a replacement shell')
  assert.ok(shells[1]!.frames.some(frame => commandOf(frame).includes('cd "/tmp/ws"')),
    'the rebuilt shell is brought back to the recorded working directory before anything else')
  await session.dispose()
})

test('a shell that dies mid-call is rebuilt and the command re-runs there', async () => {
  // The scripted death happens once: on the replacement shell the same command answers normally,
  // which is what makes this the mirror of the wedged case (a dead child cannot still hold the shell).
  let deaths = 0
  const { host, shells } = fakeHost(command =>
    command === BOOTSTRAP_COMMAND ? BOOT
      : command === 'echo out; exit 3' ? (deaths++ === 0 ? { stdout: 'out\n', exit: 3 } : { stdout: 'out\n', status: 0 })
        : { status: 0 })
  const session = new WslBashSession(host, spec())
  await session.start()
  const run = await session.run('echo out; exit 3', 2_000)
  assert.equal(run.restarted, true)
  assert.equal(run.exitCode, 0, 'the re-run on the replacement shell is what the caller reads')
  assert.equal(shells[0]!.terminated, true, 'the dead shell was taken down')
  assert.equal(shells[0]!.frames.filter(frame => commandOf(frame) === 'echo out; exit 3').length, 1)
  assert.equal(shells[1]!.frames.filter(frame => commandOf(frame) === 'echo out; exit 3').length, 1,
    'a dead child cannot still hold the shell, so replaying there is safe — the opposite of the wedged case')
  await session.dispose()
})

test('a caller abort is the caller\'s action, never a timeout, and the command is not re-run', async () => {
  const { host, shells } = fakeHost(command =>
    command === BOOTSTRAP_COMMAND ? BOOT : command === 'sleep 99' ? { silent: true } : { status: 0 })
  const session = new WslBashSession(host, spec())
  await session.start()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 60)
  const run = await session.run('sleep 99', 10_000, controller.signal)
  assert.equal(run.aborted, true, 'the caller cancelled, and the answer says so rather than inventing a timeout')
  assert.equal(run.timedOut, false)
  assert.equal(run.restarted, true, 'the session still rebuilt — a wedged pipe is wedged whoever ended the call')
  assert.equal(shells[0]!.frames.filter(frame => commandOf(frame) === 'sleep 99').length, 1)
  assert.equal(shells[1]!.frames.filter(frame => commandOf(frame) === 'sleep 99').length, 0,
    'a cancelled command is not executed a second time')
  await session.dispose()
})

test('two concurrent calls serialise on the one-frame-in-flight protocol', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { host, shells } = fakeHost(command =>
    command === BOOTSTRAP_COMMAND ? BOOT : command === 'first' ? { stdout: 'A\n', gate } : { stdout: 'B\n' })
  const session = new WslBashSession(host, spec())
  await session.start()
  const first = session.run('first', 5_000)
  const second = session.run('second', 5_000)
  await tick(30)
  const sentEarly = shells[0]!.frames.map(commandOf)
  assert.ok(sentEarly.includes('first') && !sentEarly.includes('second'),
    'the second frame must not be written while the first is in flight — two writers would make the records ambiguous')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual([a.stdout, b.stdout], ['A\n', 'B\n'], 'each call settles with its own answer')
  const order = shells[0]!.frames.map(commandOf)
  assert.ok(order.indexOf('first') < order.indexOf('second'), 'the calls answer in the order they were made')
  await session.dispose()
})

test('a disposed session refuses further work and takes its shell down', async () => {
  const { host, shells } = fakeHost(() => BOOT)
  const session = new WslBashSession(host, spec())
  await session.start()
  await session.dispose()
  assert.equal(shells[0]!.terminated, true, 'dispose terminates the child rather than leaking it')
  await assert.rejects(session.run('echo hi', 1_000), /the session is closed/,
    'a disposed session must fail loudly, not queue work onto a shell nobody owns')
})
