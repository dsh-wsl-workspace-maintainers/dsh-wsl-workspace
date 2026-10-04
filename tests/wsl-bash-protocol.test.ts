/**
 * The record protocol, offline.
 *
 * issue #51 point 3 hung 300 s per call because the host decides completion by matching bytes in a
 * terminal that is allowed to repaint. This protocol's whole claim is that completion is a record
 * carrying a per-command nonce, so the tests below are mostly about what must NOT settle: a forged
 * tag, a wrong nonce, a half-arrived record. Each of those is a red the moment the corresponding
 * check is removed, which is the point — a matcher that accepts anything is how we got here.
 *
 * @module dsh-wsl-workspace/tests/wsl-bash-protocol
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { BOOTSTRAP_COMMAND, RECORD_TAG, SESSION_ARGV, STATE_TAG, dropProtocolEcho, encodeFrame, newNonce, readFrame, restoreChunks, restoreScript, stripRecords } from '../src/host/wsl-bash-protocol.ts'

const NUL = String.fromCharCode(0)

/** One record, as the shell writes it: NUL tag NUL nonce NUL value NUL. */
const one = (tag: string, nonce: string, value: string | number): Buffer =>
  Buffer.from([NUL, tag, NUL, nonce, NUL, String(value), NUL].join(''), 'latin1')

/** The two records a frame writes, completion first. */
const frameRecords = (nonce: string, status: string | number, state = 'enYxZGVzdGF0ZQ=='): Buffer =>
  Buffer.concat([one(RECORD_TAG, nonce, status), one(STATE_TAG, nonce, state)])

test('a frame is one line and its payload decodes back to the command', () => {
  const command = `echo 中文\nprintf '%s\\n' "a'b$c"!\nls -la /tmp`
  const frame = encodeFrame(command)
  assert.ok(!frame.line.slice(0, -1).includes('\n'), 'the frame itself must not contain a newline')
  assert.ok(frame.line.endsWith('\n'), 'one write, one line')
  const payload = /printf %s '([^']*)'/.exec(frame.line)?.[1]
  assert.ok(payload !== undefined, `payload not found in ${frame.line}`)
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), command,
    'the shell reassembles exactly what the model asked for')
})

test('the frame cannot be rewritten by history expansion', () => {
  const frame = encodeFrame('echo hello! world!')
  assert.ok(!frame.line.includes('!'),
    `a literal ! anywhere in the frame is what breaks the host's wrapper (its #7858/#6768): ${frame.line}`)
})

test('a complete frame settles with the exit code and the shell state', () => {
  const frame = encodeFrame('false')
  const prefix = Buffer.from('nope\n')
  const records = frameRecords(frame.nonce, 1)
  const settled = readFrame(Buffer.concat([prefix, records]), frame.nonce)
  assert.equal(settled?.status, 1, 'status comes from the record, not from scraping output')
  assert.equal(settled?.nextOffset, prefix.length + records.length,
    'the reader knows exactly where the next command’s window begins')
})

test('a completion record without its state record does not settle', () => {
  const frame = encodeFrame('true')
  assert.equal(readFrame(one(RECORD_TAG, frame.nonce, 0), frame.nonce), undefined,
    'a restart without the state would silently lose the user cwd, so the frame is not done')
})

test('a record for a different nonce never settles — a forged sentinel cannot end the call', () => {
  const mine = encodeFrame('true')
  const attacker = frameRecords(newNonce(), 0)
  assert.equal(readFrame(Buffer.concat([attacker, attacker]), mine.nonce), undefined,
    'the host bug was a sentinel matched by text; ours is matched by an unguessable nonce')
})

test('a frame that has not fully arrived does not settle', () => {
  const frame = encodeFrame('true')
  const whole = frameRecords(frame.nonce, 0)
  for (const cut of [1, whole.length - 2, whole.length - 1]) {
    assert.equal(readFrame(whole.subarray(0, cut), frame.nonce), undefined,
      `truncated at ${cut} of ${whole.length} must still be "running"`)
  }
  assert.notEqual(readFrame(whole, frame.nonce), undefined, 'the complete frame does settle')
})

test('a non-numeric status is treated as no record at all', () => {
  const frame = encodeFrame('true')
  assert.equal(readFrame(frameRecords(frame.nonce, 'x7'), frame.nonce), undefined)
})

test('two frames on one stream are read in order', () => {
  const first = encodeFrame('echo one')
  const second = encodeFrame('echo two')
  const stream = Buffer.concat([
    Buffer.from('one\n'), frameRecords(first.nonce, 0),
    Buffer.from('two\n'), frameRecords(second.nonce, 3),
  ])
  const a = readFrame(stream, first.nonce)
  assert.ok(a !== undefined && a.status === 0)
  const b = readFrame(stream, second.nonce, a.nextOffset)
  assert.ok(b !== undefined && b.status === 3, 'the second command keeps its own exit code')
})

test('stripRecords removes only our records', () => {
  const frame = encodeFrame('true')
  const stream = Buffer.concat([Buffer.from('keep\u0000this\n'), frameRecords(frame.nonce, 0), Buffer.from('tail')])
  const stripped = stripRecords(stream).toString('latin1')
  assert.ok(stripped.includes('keep\u0000this'), 'a command that prints NUL keeps its bytes')
  assert.ok(stripped.includes('tail'))
  assert.ok(!stripped.includes(RECORD_TAG) && !stripped.includes(STATE_TAG), 'the protocol never reaches the model')
})

test('the shell echo of a frame is dropped from stderr, and the command’s own stderr is not', () => {
  const frame = encodeFrame('echo oops >&2')
  const noisy = `bash-5.1$ ${frame.line.trim()}\noops\n`
  const kept = dropProtocolEcho(noisy, frame.payload)
  assert.ok(!kept.includes(frame.payload), 'the model must never see its own framing')
  assert.ok(kept.includes('oops'), 'real stderr survives the filter')
  assert.equal(dropProtocolEcho('nothing here\n', frame.payload), 'nothing here\n', 'a no-op when nothing matches')
})

test('an echo delivered to a later call than the frame that wrote it is still recognised', () => {
  const earlier = encodeFrame('echo first')
  const current = encodeFrame('echo second')
  const late = `${earlier.line.trim()}\nreal warning\n`
  assert.ok(!dropProtocolEcho(late, current.payload).includes(earlier.payload),
    'the pipe split the earlier echo, so the window carrying it holds a payload this call never had')
  assert.ok(dropProtocolEcho(late, current.payload).includes('real warning'),
    'the filter keys on both record tags, which every frame line carries')
})

test('every tail the line editor could deliver is recognised as protocol', () => {
  // Recorded from this machine: bash writes the echo of a frame to stderr as `\r` plus the **last 79
  // bytes** of the line, terminated by a newline — the head, with the payload and both record tags,
  // never arrives. So the invariant is not "the tail happens to contain something", it is that the
  // frame ends with its own signature. Every cut point is tried, not one recorded string.
  const frame = encodeFrame('echo PROBE_$((2*3)); pwd; whoami')
  for (let start = 0; start < frame.line.length; start += 1) {
    const tail = frame.line.slice(start)
    if (tail.length > 80 || tail.trimEnd().length < 20) continue
    assert.equal(dropProtocolEcho(tail, 'ZWNobyBub21lY29tbWFuZA=='), '',
      `a ${tail.length}-byte tail starting at ${start} must be recognisable: ${JSON.stringify(tail.slice(0, 40))}`)
  }
  assert.ok(frame.line.trimEnd().endsWith(`# ${RECORD_TAG}`),
    'the frame ends with its own tag, which is what makes the above true')
})

test('the state record is sections, and the replay orders them and drops what is absent', () => {
  const state = [
    '#dsh-section exports', 'declare -x FOO="bar"',
    '#dsh-section pwd', 'PWD=/tmp',
    '#dsh-section aliases', "alias ll='ls -l'",
    '#dsh-section options', 'set -o emacs',
    '#dsh-section shopt', 'shopt -s autocd',
    '#dsh-section functions-count', '3',
  ].join('\n')
  const plan = restoreScript(state)
  assert.ok(plan.script.indexOf('set -o emacs') < plan.script.indexOf('declare -x FOO'),
    'options are replayed before anything that parses under them')
  assert.ok(plan.script.includes("alias ll='ls -l'"), 'aliases come back')
  assert.ok(plan.script.trimEnd().endsWith('cd "/tmp" 2>/dev/null || true'), 'the cd goes last, after the state it depends on')
  assert.deepEqual(plan.skipped, [], 'nothing was left out, so nothing is reported as left out')
})

test('a function snapshot over the cap is skipped with its size, never truncated', () => {
  const state = `#dsh-section functions-count\n85\n#dsh-section functions\n#dsh-functions-skipped 61083\n`
  const plan = restoreScript(state)
  assert.ok(plan.skipped.some(entry => /61083 bytes over the \d+ byte cap/.test(entry)), JSON.stringify(plan.skipped))
  assert.ok(!plan.script.includes('declare -f'), 'half a function body replayed is a syntax error')
})

test('a state record without a working directory says so instead of quietly going home', () => {
  const plan = restoreScript('#dsh-section exports\ndeclare -x A="1"\n')
  assert.ok(plan.skipped.some(entry => entry.includes('working directory')), JSON.stringify(plan.skipped))
})

test('the restore is chunked so a shell option is live before the parse that needs it', () => {
  const state = [
    '#dsh-section options', 'set -o emacs',
    '#dsh-section shopt', 'shopt -s extglob',
    '#dsh-section exports', 'declare -x A="1"',
    '#dsh-section aliases', "alias ll='ls -l'",
    '#dsh-section functions', 'dshf () ', '{ ', '    echo x', '}',
    '#dsh-section pwd', 'PWD=/tmp',
  ].join('\n')
  const { chunks } = restoreChunks(state)
  assert.ok((chunks[0] ?? '').includes('set +H'), 'the bootstrap goes first: the user state sits on top of rc, not under it')
  const extglob = chunks.findIndex(chunk => chunk.includes('shopt -s extglob'))
  const functions = chunks.findIndex(chunk => chunk.includes('dshf () '))
  assert.ok(extglob >= 0 && extglob < functions,
    'one eval would parse the whole body before running the shopt, which is how the rc completion functions failed')
  const last = chunks.at(-1) ?? ''
  assert.ok(last.startsWith('cd "/tmp"'), 'the directory change is last')
})

test('the frame asks for function bodies only when the count moved', () => {
  const quiet = encodeFrame('pwd', 3).line
  assert.ok(quiet.includes("[ \"$__dsh_n\" != '3' ]"), 'the shell compares, so an unchanged snapshot costs nothing')
  assert.ok(!encodeFrame('pwd').line.includes('declare -f'), 'no count known means no bodies requested')
  assert.ok(encodeFrame('pwd', -1).line.includes('declare -f'), '-1 is the count no shell can report: always send them')
  assert.ok(encodeFrame('pwd', -1).line.includes('"#dsh-functions-skipped $__dsh_s"'),
    'the marker reports a byte count; in single quotes it reached the model as the literal `$__dsh_s`')
})

test('the session argv keeps its long options ahead of the shell name', () => {
  assert.deepEqual([...SESSION_ARGV], ['--norc', '-i'])
  assert.ok(SESSION_ARGV[0]?.startsWith('--'),
    'wsl.exe -e claims any later `--x` argument for itself, so bash never starts')
})

test('stripRecords removes the whole record, not just its head', () => {
  const frame = encodeFrame('pwd')
  const stream = Buffer.concat([Buffer.from('/tmp\n'), frameRecords(frame.nonce, 0)])
  const stripped = stripRecords(stream).toString('latin1')
  assert.equal(stripped, '/tmp\n',
    'the live matrix caught this: skipping one NUL field left the exit code in the model’s output')
})

test('the bootstrap disables history expansion and swallows rc output', () => {
  assert.ok(BOOTSTRAP_COMMAND.includes('set +H'), 'the ! class of failures is closed at session start')
  assert.ok(BOOTSTRAP_COMMAND.includes('>/dev/null 2>&1'),
    'rc files on this machine print errors and contain a token-shaped line; neither may reach output')
})
