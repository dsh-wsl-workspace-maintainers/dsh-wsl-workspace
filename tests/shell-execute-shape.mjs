/**
 * The `ctx.shell` seam shape the 0.2.x host calls, driven offline.
 *
 * issue #51 is a WSL workspace on DSH Desktop 0.2.0-rc.2 where every `bash` call
 * failed. One of its causes is here: the host's `@deepseek-ai/dsh-tool-bash` does
 * `await (await ctx.shell.execute(ctx.shell.resolve(request))).result()`, while
 * `WslShellExecutor` implemented only the 0.1.x `resolve`/`run`/`start`. `tsc`
 * said so all along — `src/shell.ts(157,14): error TS2515 … does not implement
 * inherited abstract member execute` — but `scripts/typecheck-gate.mjs` compares
 * only the error COUNT against `ci/typecheck-baseline.json`, and the count was
 * inside budget, so the class shipped.
 *
 * This file is the check that cannot be buried that way: it asserts the seam on
 * the shipped bytes, and it asserts the members the consumer actually reads —
 * including the two contract fields the same baseline hid next to `execute`
 * (`ShellExecSpec.onExpiry`, `ShellProcess.observed`).
 *
 * Plane: `lib/` (the committed build output), never `src/` — the reporter's
 * workaround was hand-edited into exactly these files, so what users run is what
 * gets measured here. The subprocess service is faked, so nothing is spawned and
 * no distribution has to be running.
 *
 *   node tests/shell-execute-shape.mjs
 *
 * @module dsh-wsl-workspace/tests/shell-execute-shape
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WslShellExecutor } from '../lib/shell.js'

const NAME = 'SHELL EXECUTE SHAPE'

/** Executor config in the shape `tests/shell.test.ts:6-15` uses; nothing here reaches a process. */
const CONFIG = {
  distro: 'Ubuntu',
  wslPath: 'wsl.exe',
  loginShell: true,
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: 64_000,
  graceMs: 1_000,
}

/** A Linux workdir keeps `plan()` out of the UNC branch, so no Windows path facts are needed. */
const WORKDIR = '/home/tester'

/** The members `ShellExecution` declares, in one list so faces can be compared to it. */
const EXECUTION_MEMBERS = ['done', 'exitCode', 'kill', 'observed', 'readOutput', 'result', 'signal', 'status']

/** A collect-mode reader with the documented byte-offset semantics. */
function reader(text) {
  return {
    readFrom: (fromByte) => ({
      text: text.slice(fromByte),
      nextOffset: text.length,
      lossy: false,
    }),
  }
}

/**
 * One fake subprocess provider per scenario.
 *
 * `done` resolves with exit facts and rejects only for a provider failure, exactly
 * as `@deepseek-ai/dsh-subprocess` documents it (types.d.ts:167-168), and an abort
 * of the spec's signal settles the process as signal-killed the way
 * `subprocess-local` does. That last part is what makes the deadline fixtures real
 * rather than decorative: the fake stops when the deadline fires, and
 * `killedBySignal` records that it was the signal and not the test that stopped it.
 * @param options - captured output and how the process ends.
 * @returns the service to provide, plus the handles the probes drive.
 */
function fakeSubprocess(options = {}) {
  const spawns = []
  const handle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: reader(options.stdoutText ?? ''),
      stderr: reader(options.stderrText ?? ''),
    },
    done: undefined,
    settled: false,
    killedBySignal: false,
    terminate: () => finish({ outcome: { exitCode: null, signal: 'SIGTERM' } }),
    waitForExit: async () => true,
  }
  let finish = () => {}
  handle.done = new Promise((resolve, reject) => {
    finish = ({ outcome, error }) => {
      if (handle.settled) return
      handle.settled = true
      if (error === undefined) resolve(outcome)
      else reject(error)
    }
  })
  // A provider rejection must not become an unhandled rejection merely because a
  // background consumer never asks for `result()`.
  handle.done.catch(() => {})
  const service = {
    spawn: (spec) => {
      if (options.throwOnSpawn === true) throw new Error('fake spawn threw')
      spawns.push(spec)
      spec.signal?.addEventListener('abort', () => {
        handle.killedBySignal = true
        finish({ outcome: { exitCode: null, signal: 'SIGTERM' } })
      }, { once: true })
      if (options.settleOnSpawn === true) {
        queueMicrotask(() => finish({ outcome: { exitCode: 0, signal: null } }))
      }
      return handle
    },
  }
  return {
    service,
    spawns,
    handle,
    settle: (outcome) => finish({ outcome }),
    reject: (error) => finish({ error }),
  }
}

/** Provide the faked `subprocess`, then mount the real provider onto it. */
async function harness(options) {
  const fake = fakeSubprocess(options)
  const ctx = new Context()
  await ctx.plugin({
    name: 'fake-subprocess',
    inject: [],
    apply: (inner) => inner.provide('subprocess', fake.service),
  })
  await ctx.plugin(WslShellExecutor, CONFIG)
  return { ctx, fake }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ── 1. the seam the 0.2.x host calls, called the way it calls it ────────────
{
  const { ctx } = await harness({ stdoutText: 'host\n', settleOnSpawn: true })
  assert.equal(typeof ctx.shell.execute, 'function',
    '(1) the mounted provider answers the 0.2.x `execute` seam')
  const viaHostCall = await (await ctx.shell.execute(ctx.shell.resolve({ command: 'echo host', workdir: WORKDIR }))).result()
  assert.equal(viaHostCall.exitCode, 0, '(1) the host one-expression call resolves a result')
  assert.equal(viaHostCall.stdout.text, 'host\n', '(1) and carries the captured stdout')

  const spec = ctx.shell.resolve({ command: 'echo hi', workdir: WORKDIR })
  assert.equal(spec.onExpiry, 'kill',
    '(1) `resolve` defaults the deadline policy that 0.2.x requires on the spec')
}

// ── 2. the handle's member list, and what result() projects ─────────────────
{
  const { ctx, fake } = await harness({ stdoutText: 'hi\n' })
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'echo hi', workdir: WORKDIR }))
  assert.deepEqual(Object.keys(execution).sort(), EXECUTION_MEMBERS,
    '(2) the handle carries exactly the documented ShellExecution members')
  assert.equal(execution.status, 'running', '(2) a live handle reports running')
  assert.equal(execution.result(), execution.result(), '(2) result() is memoized per handle')

  fake.settle({ exitCode: 0, signal: null })
  const result = await execution.result()
  assert.equal(result.exitCode, 0, '(2) result() projects the exit code')
  assert.equal(result.signal, null, '(2) result() projects the signal')
  assert.equal(result.timedOut, false, '(2) a clean exit is not a timeout')
  assert.equal(result.aborted, false, '(2) a clean exit is not an abort')
  assert.equal(result.timeoutMs, 120_000, '(2) the effective timeout is echoed')
  assert.equal(result.stdout.text, 'hi\n', '(2) stdout is the whole collected stream')
  assert.equal(result.stdout.truncated, false, '(2) nothing was dropped')
  assert.equal(result.stderr.text, '', '(2) stderr is present even when empty')
  await execution.done
  assert.equal(execution.status, 'completed', '(2) a clean exit settles as completed')
  assert.equal(execution.exitCode, 0, '(2) the handle stamps the exit code')
}

// ── 3. `observed` does not steal from the consuming cursor ─────────────────
{
  const { ctx, fake } = await harness({ stdoutText: 'first\nsecond\n' })
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'x', workdir: WORKDIR }))
  assert.ok(execution.observed?.stdout !== undefined && execution.observed.stderr !== undefined,
    '(3) the handle exposes both observed streams, which 0.2.x requires')
  const watched = execution.observed.stdout.readFrom(6)
  assert.equal(watched.text, 'second\n', '(3) observed reads at the caller own byte offset')
  const consumed = execution.readOutput()
  assert.equal(consumed.delta, 'first\nsecond\n',
    '(3) observed left the consuming cursor where it was, so the whole stream is still delivered')
  assert.equal(execution.readOutput().delta, '', '(3) and the consuming cursor then advances')
  fake.settle({ exitCode: 0, signal: null })
  await execution.done
}

// ── 4. first-cause classification, both directions ──────────────────────────
{
  const { ctx, fake } = await harness({})
  const timed = await ctx.shell.execute(ctx.shell.resolve({ command: 'sleep 2', workdir: WORKDIR, timeoutMs: 60 }))
  assert.equal(fake.spawns.length, 1, '(4) the resolved spec reached the provider once')
  assert.ok(fake.spawns[0].signal !== undefined,
    '(4) an armed deadline hands the provider a signal to stop on')
  const timedResult = await timed.result()
  assert.equal(fake.handle.killedBySignal, true, '(4) the deadline really fired the process down')
  assert.equal(timedResult.timedOut, true, '(4) the executor own timeout counts as timedOut')
  assert.equal(timedResult.aborted, false, '(4) and not as an abort')
  assert.equal(timed.status, 'killed', '(4) a timeout kill settles the handle as killed')

  const { ctx: ctx2, fake: fake2 } = await harness({})
  const controller = new AbortController()
  const cancelled = await ctx2.shell.execute(ctx2.shell.resolve({
    command: 'sleep 2', workdir: WORKDIR, timeoutMs: 60_000, signal: controller.signal,
  }))
  assert.notEqual(fake2.spawns[0].signal, controller.signal,
    '(4) the caller signal is fused, not forwarded raw')
  controller.abort()
  const cancelResult = await cancelled.result()
  assert.equal(cancelResult.aborted, true, '(4) the caller signal is the first cause')
  assert.equal(cancelResult.timedOut, false, '(4) and it is not reported as a timeout')
}

// ── 5. `onExpiry: 'none'` arms nothing — the background contract ────────────
{
  const { ctx, fake } = await harness({})
  const spec = ctx.shell.resolve({ command: 'npm run dev', workdir: WORKDIR, timeoutMs: 40, onExpiry: 'none' })
  const background = ctx.shell.start(spec)
  assert.equal(fake.spawns[0].signal, undefined,
    "(5) 'none' hands the provider no deadline signal")
  await sleep(120)
  assert.equal(background.status, 'running',
    "(5) 'none' armed nothing: the job outlived timeoutMs, which is what job_* depends on")
  assert.deepEqual(Object.keys(background).sort(), EXECUTION_MEMBERS,
    '(5) start() returns the same handle shape as execute(), so the faces cannot drift')
  assert.equal(background.kill(), true, '(5) kill() stops it')
  assert.equal(background.kill(), false, '(5) kill() is idempotent once finished')
  fake.settle({ exitCode: 0, signal: null })
  await background.done
}

// ── 6. infrastructure failure: the read path tells it, result() rejects it ──
{
  const { ctx, fake } = await harness({})
  let unobserved = 0
  const onUnhandled = () => { unobserved += 1 }
  process.on('unhandledRejection', onUnhandled)
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'x', workdir: WORKDIR }))
  fake.reject(new Error('provider exploded'))
  await execution.done
  assert.equal(execution.status, 'killed', '(6) a provider failure settles the handle as killed')
  assert.match(execution.readOutput().delta,
    /\[stderr\]\nspawn failed: Error: provider exploded/,
    '(6) and leaves its story on the read path')
  assert.equal(execution.readOutput().delta, '', '(6) the note is delivered exactly once')
  assert.equal(execution.observed.stderr.readFrom(0).text, '',
    '(6) observed serves the captured stream, not the synthesized note')
  await assert.rejects(execution.result(), /provider exploded/,
    '(6) result() rejects for a spawn that never produced a process')
  await sleep(10)
  process.off('unhandledRejection', onUnhandled)
  assert.equal(unobserved, 0, '(6) a consumer that never asked for result() sees no rejection')
}

// ── 7. a synchronous spawn throw: execute() rejects, start() throws ─────────
{
  const { ctx } = await harness({ throwOnSpawn: true })
  const spec = ctx.shell.resolve({ command: 'x', workdir: WORKDIR })
  await assert.rejects(ctx.shell.execute(spec), /fake spawn threw/,
    '(7) execute() surfaces an infrastructure failure as a rejection')
  assert.throws(() => ctx.shell.start(ctx.shell.resolve({ command: 'x', workdir: WORKDIR, onExpiry: 'none' })),
    /fake spawn threw/, '(7) and start() as the synchronous throw it always was')
  await assert.rejects(ctx.shell.run(spec), /fake spawn threw/,
    '(7) run() still reports it, so 0.1.x hosts keep their behaviour')
}

// ── 8. the 0.1.x faces return what they always returned ─────────────────────
{
  const { ctx, fake } = await harness({ stdoutText: 'kept\n' })
  const before = ctx.shell.run(ctx.shell.resolve({ command: 'echo kept', workdir: WORKDIR }))
  fake.settle({ exitCode: 0, signal: null })
  const runResult = await before
  assert.equal(Object.keys(runResult).sort().join(','),
    'aborted,exitCode,signal,stderr,stdout,timedOut,timeoutMs',
    '(8) run() exposes no member the 0.1.x consumers did not already get')
  assert.equal(runResult.stdout.text, 'kept\n', '(8) and still delivers the captured stdout')
  assert.equal(runResult.timedOut, false, '(8) classifying like result() does')
}

// ── 9. the armed deadline is released at settlement ─────────────────────────
// A `using`-style disposer that never runs would keep a 120 s timer holding the
// event loop, so this counts handles instead of trusting the code path.
{
  const { ctx, fake } = await harness({})
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'x', workdir: WORKDIR }))
  fake.settle({ exitCode: 0, signal: null })
  await execution.done
  await sleep(20)
  const timers = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
  assert.ok(timers <= 1, `(9) no deadline timer survived settlement (live Timeout handles: ${timers})`)
}

console.log(`${NAME} PASSED`)
