import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WslShellExecutor } from '../src/shell.ts'

const config = {
  distro: 'Ubuntu',
  wslPath: 'wsl.exe',
  loginShell: true,
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: 64_000,
  graceMs: 1_000,
}

function commandFor(workdir: string, loginShell: boolean): string {
  const executor = new WslShellExecutor(new Context(), { ...config, loginShell })
  const spec = executor.resolve({ command: 'pwd', workdir })
  const plan = (executor as unknown as { plan(value: typeof spec): { argv: readonly string[] } }).plan(spec)
  return plan.argv.at(-1) ?? ''
}

test('login shell preserves a workdir containing a single quote', () => {
  assert.equal(commandFor("/tmp/a'b", true), "cd '/tmp/a'\\''b' && pwd")
})

test('non-login shell leaves the command unchanged', () => {
  assert.equal(commandFor("/tmp/a'b", false), 'pwd')
})

/**
 * A fake subprocess handle whose collected readers hand back a scripted reply.
 *
 * Shaped like the seams `start()` actually uses, and nothing else: the point is to get a real
 * `WslShellExecutor` to build a real `ShellProcess`, so what is asserted is the product's own output
 * object rather than a stand-in for it.
 */
function fakeSubprocess(reply: { stdout: string; stderr: string }) {
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    spawn: () => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => true,
      collected: { stdout: reader(reply.stdout), stderr: reader(reply.stderr) },
    }),
  }
}

function startedProcess(reply: { stdout: string; stderr: string }) {
  const ctx = new Context()
  // The executor declares `static inject = ['subprocess']` and reaches `this.ctx.subprocess.spawn`.
  ;(ctx as unknown as { subprocess: unknown }).subprocess = fakeSubprocess(reply)
  const executor = new WslShellExecutor(ctx, config)
  return executor.start(executor.resolve({ command: 'echo hi' }))
}

test('a background process carries the observed readers the host contract requires', () => {
  // `ShellProcess.observed` is declared **non-optional** by `@deepseek-ai/dsh-shell`, and the host
  // spells out its purpose: independent observers read at their own offsets without stealing bytes
  // from `readOutput`. `dsh-jobs-local@0.2.x` drains a job's ring through exactly these readers and
  // never calls `readOutput`, so an executor that omits them ships an empty `job_output` — issue #56,
  // measured on a real 0.2.0-rc.2 host.
  //
  // The assertion is on the **shape**, so it fails if the field is missing, null, or not a pair of
  // functions; and it is written against the host's type rather than a hand-copied field name, so a
  // rename upstream breaks this loudly instead of quietly.
  const proc = startedProcess({ stdout: '', stderr: '' })
  assert.notEqual(proc.observed, undefined, 'the executor returned a process with no observed readers')
  assert.equal(typeof proc.observed?.stdout?.readFrom, 'function', 'observed.stdout must be an offset reader')
  assert.equal(typeof proc.observed?.stderr?.readFrom, 'function', 'observed.stderr must be an offset reader')
})

test('the observed readers return the real captured bytes, per stream', () => {
  const proc = startedProcess({ stdout: 'OUT-1\n', stderr: 'ERR-1\n' })
  assert.equal(proc.observed?.stdout?.readFrom(0)?.text, 'OUT-1\n')
  assert.equal(proc.observed?.stderr?.readFrom(0)?.text, 'ERR-1\n')
})

test('observed readers do not steal bytes from readOutput, and neither steals from the other', () => {
  // The property that makes `observed` usable **alongside** `readOutput` rather than instead of it:
  // three cursors over two streams. A shared offset would hand the second reader an empty string and
  // the host would record a job that ran and produced nothing — the exact shape of #56.
  const proc = startedProcess({ stdout: 'S\n', stderr: 'E\n' })

  assert.equal(proc.observed?.stdout?.readFrom(0)?.text, 'S\n', 'stdout observer reads its own stream')
  // `readOutput` drains both and prefixes stderr; it must still see everything.
  const viaReadOutput = proc.readOutput()
  assert.match(viaReadOutput.delta, /S/, 'readOutput still sees stdout after an observer read it')
  assert.match(viaReadOutput.delta, /E/, 'readOutput still sees stderr after an observer read it')
  // And the stderr observer is unaffected by the consuming read above.
  assert.equal(proc.observed?.stderr?.readFrom(0)?.text, 'E\n', 'stderr observer keeps its own cursor')
})
