/**
 * wsl.exe output decoding, offline.
 *
 * `src/shared/wsl.ts:102` picks UTF-16LE by probing the captured buffer for a NUL byte.
 * Before this file the branch had no offline assertion at all — `grep -rn utf16 tests/`
 * found exactly one hit, `tests/exec-shape.mjs:42`, which needs a live distribution and a
 * win32 host. Every W1 check that decodes registry or wsl.exe output depends on this sniff,
 * so it is tested with synthetic buffers and a faked child_process: nothing here spawns
 * wsl.exe, which is what makes it runnable on the ubuntu runner.
 *
 *   node --test --experimental-strip-types tests/wsl-output-decode.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeWslOutput, textOf, wslExecutableCandidates } from '../src/shared/wsl.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('a UTF-16LE capture is decoded by its NUL bytes, not read as UTF-8', () => {
  const buffer = Buffer.from('Ubuntu\nDebian\n', 'utf16le')
  assert.ok(buffer.includes(0), 'the fixture really is UTF-16LE')
  assert.equal(decodeWslOutput(buffer), 'Ubuntu\nDebian\n')
})

test('a UTF-8 capture without NUL bytes is returned verbatim', () => {
  const buffer = Buffer.from('Ubuntu\nUbuntu-24.04\n', 'utf8')
  assert.equal(buffer.includes(0), false)
  assert.equal(decodeWslOutput(buffer), 'Ubuntu\nUbuntu-24.04\n')
})

test('an empty capture decodes to an empty string and never throws', () => {
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '')
})

test('an odd-length buffer does not throw', () => {
  // Truncation is Node's documented behaviour; the gate cares that decoding never becomes
  // an exception on the discovery path, where a throw would read as "WSL is not installed".
  assert.doesNotThrow(() => decodeWslOutput(Buffer.from([0x55, 0, 0x00])))
})

test('a string that is not a buffer is reported, not silently treated as empty output', () => {
  // The 0.7.x crash class: a host wrapper that hands back something other than the captured
  // stream used to reach `.includes` on undefined.
  assert.equal(decodeWslOutput('already decoded'), 'already decoded')
  assert.throws(() => decodeWslOutput(null as unknown as Buffer), /expected captured output/)
  assert.throws(() => decodeWslOutput({} as unknown as Buffer), /expected captured output/)
})

test('textOf reads a captured stream as UTF-8 text', () => {
  assert.equal(textOf(Buffer.from('ok', 'utf8')), 'ok')
  assert.equal(textOf('ok'), 'ok')
})

test('the PATH-name spelling gains an absolute fallback, an explicit path does not', () => {
  // Issue #36: a host whose PATH omits System32 could run everything except listDistros.
  const original = process.env.SystemRoot
  try {
    process.env.SystemRoot = 'C:\\Windows'
    assert.deepEqual(wslExecutableCandidates('wsl.exe'), ['wsl.exe', 'C:\\Windows\\System32\\wsl.exe'])
    assert.deepEqual(wslExecutableCandidates('D:\\tools\\wsl.exe'), ['D:\\tools\\wsl.exe'])
    delete process.env.SystemRoot
    process.env.windir = 'D:\\Win'
    assert.deepEqual(wslExecutableCandidates('wsl.exe'), ['wsl.exe', 'D:\\Win\\System32\\wsl.exe'])
  } finally {
    if (original === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = original
  }
})

/** Run a probe in a child process under the faked child_process. */
function probeUnderFake(script: unknown): Record<string, unknown> {
  const work = mkdtempSync(join(tmpdir(), 'dsh-wsl-decode-'))
  try {
    const scriptPath = join(work, 'script.json')
    const probePath = join(work, 'probe.mjs')
    writeFileSync(scriptPath, JSON.stringify(script), 'utf8')
    writeFileSync(probePath, `
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listDistros } from ${JSON.stringify(pathToFileURL(join(repo, 'src', 'shared', 'wsl.ts')).href)}
// The fixture's premise, reported rather than assumed: the fake replaces \`execFile\` with a plain
// function, which is exactly the shape DSH Desktop's windowsHide wrapper has (issue #35). If a future
// refactor of the fake restores \`util.promisify.custom\`, the assertion below notices instead of the
// suite quietly stopping covering that shape.
const report = { promisifyMetadata: typeof execFile[promisify.custom], distros: null, error: null }
try {
  report.distros = await listDistros()
} catch (error) {
  report.error = String(error && error.message ? error.message : error)
}
console.log('PROBE:' + JSON.stringify(report))
`, 'utf8')
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--import', pathToFileURL(join(repo, 'tests', 'support', 'fake-child-process.mjs')).href,
      probePath,
    ], { encoding: 'utf8', env: { ...process.env, DSH_FAKE_CHILD_PROCESS: scriptPath }, timeout: 60_000 })
    const line = (result.stdout ?? '').split('\n').find(l => l.startsWith('PROBE:'))
    if (line === undefined) {
      throw new Error(`probe produced no report (exit ${result.status}): ${(result.stderr ?? '').slice(-700)}`)
    }
    return JSON.parse(line.slice('PROBE:'.length)) as Record<string, unknown>
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

test('listDistros() parses a UTF-16LE listing without spawning wsl.exe', () => {
  const report = probeUnderFake({
    calls: [{
      match: { file: 'wsl.exe', argsContains: ['-l', '-q'] },
      code: 0,
      stdout: { utf16le: 'Ubuntu\r\ndocker-desktop\r\n\r\nUbuntu-24.04\r\n' },
    }],
  })
  assert.equal(report.error, null, `listDistros must not throw: ${String(report.error)}`)
  // Blank lines dropped, order preserved, and no filtering here: dropping docker-desktop is
  // the caller's job (tests/smoke.ts does it), so this must not pin that policy.
  assert.deepEqual(report.distros, ['Ubuntu', 'docker-desktop', 'Ubuntu-24.04'])
})

test('issue #35: discovery survives a host wrapper that drops util.promisify metadata', () => {
  // The defect: Desktop replaces `child_process.execFile` with a plain wrapper for `windowsHide: true`,
  // the wrapper inherits no `util.promisify.custom`, `promisify(execFile)` then resolves to *stdout
  // itself*, and `listDistros()` died on `result.stdout === undefined` (Cannot read properties of
  // undefined (reading 'includes')). The product stopped depending on that metadata — it uses the
  // callback form, which every such wrapper preserves — and this case is what keeps it that way: the
  // fake is the wrapper shape, the premise is asserted, and the listing must still parse.
  const report = probeUnderFake({
    calls: [{
      match: { file: 'wsl.exe', argsContains: ['-l', '-q'] },
      code: 0,
      stdout: { utf16le: 'Ubuntu\r\n' },
    }],
  })
  assert.equal(report.promisifyMetadata, 'undefined',
    'the fixture no longer reproduces the Desktop wrapper — its replacement has promisify metadata again')
  assert.equal(report.error, null, `listDistros must not depend on promisify metadata: ${String(report.error)}`)
  assert.deepEqual(report.distros, ['Ubuntu'])
})

test('a UTF-8 listing decodes through the same call site', () => {
  const report = probeUnderFake({
    calls: [{
      match: { file: 'wsl.exe', argsContains: ['-l', '-q'] },
      code: 0,
      stdout: { text: 'Ubuntu-22.04\n' },
    }],
  })
  assert.equal(report.error, null)
  assert.deepEqual(report.distros, ['Ubuntu-22.04'])
})

test('a failing wsl.exe is reported with the executables it tried, not as an empty list', () => {
  // The #35/#36 visible failure shape was an empty picker. An empty list and a reported
  // failure are different answers and must not be conflated.
  const report = probeUnderFake({
    calls: [{ match: { file: 'wsl.exe' }, code: 1, stderr: { text: 'The Windows Subsystem for Linux has not been enabled.' } }],
  })
  assert.equal(report.distros, null)
  assert.match(String(report.error), /cannot list WSL distributions/)
})

// What decoding UTF-16LE as UTF-8 actually does. This is a claim guard, not a product test:
// the v0.7.5 review and issue #44 both said Node "drops the NUL bytes", which measurement
// refutes — nothing is dropped, so the symptom is NOT garbled-then-shortened text. The harm
// is the two consequences asserted below, and a future reader of those documents should find
// this file before re-writing the wrong sentence.
test('reading UTF-16LE as UTF-8 keeps every byte and costs the reader something else', () => {
  const message = 'grep: Unmatched [, [^, [:, [., or [='
  const bytes = Buffer.from(message, 'utf16le')
  const lossy = bytes.toString('utf8')

  // The retracted claim, as a counter-example: the decode is lossless and reversible.
  assert.ok(Buffer.from(lossy, 'utf8').equals(bytes),
    'the lossy text re-encodes to the ORIGINAL bytes: no NUL is dropped, so "Node swallows the '
      + 'NULs" is false and must not be written again')
  assert.equal(lossy.length, bytes.length)
  assert.equal(lossy.length, message.length * 2)

  // The harm #1: a budget counted in characters spends half of it on NULs.
  const budget = 300
  const long = Buffer.from('x'.repeat(639), 'utf16le').toString('utf8').slice(0, budget)
  const significant = long.split(String.fromCharCode(0)).join('')
  assert.ok(long.length === budget && significant.length === budget / 2,
    'the lossy text carries NULs: 300 characters of it are 150 readable ones')
  assert.equal(significant.length, budget / 2,
    'a 300-character detail budget keeps 150 readable characters, which is what the user sees')

  // The harm #2, and the quieter one: substring judgement on the lossy text can never fire.
  assert.equal(lossy.includes('Unmatched'), false)
  assert.equal(/Unmatched|unrecognized/.test(lossy), false,
    'INVALID_PATTERN-shaped tests against NUL-interleaved text are permanently false')
  assert.equal(Buffer.from(lossy, 'utf8').toString('utf16le'), message,
    'and the fix is reversible too: the bytes are recoverable, which is why a decoder at the '
      + 'call site is enough — no transport change is needed')
})
