/**
 * The spill file must hold the **whole** stream, and this gate is why that is a property rather than
 * a hope.
 *
 * A spill file exists so a model that asked for `seq 1 200000` can go read the head of it. That
 * promise is only kept if every byte of that command's output reaches the file — and the one place
 * bytes went missing was measured, not reasoned about: on a real WSL1 host the file held 194341 of
 * 200000 lines, while WSL2 held all 200000. The two hosts differ only in how finely the 9P pipe
 * fragments the stream, so what differs is the **timing**: chunks that arrive while the reader is
 * waiting for stderr used to land below `recordStart` when the spill was taken and above it by the
 * time the answer was sliced, reaching neither.
 *
 * So the fix is two claims, and each is checked separately:
 *
 *   · the spill is taken **after** the stderr wait, not before it;
 *   · it is taken to `this.out.length`, not to the record's offset — the record is still in the
 *     window, and `spillWindow` strips it on the way in, so writing to `recordStart` throws away the
 *     bytes *after* the record instead of the record.
 *
 * The whole stream is asserted, not a prefix: a spill that kept all but the last chunk would pass a
 * "more than before" check and still be wrong.
 *
 * Offline: the session is driven through a fake stdout stream, so this needs neither a distribution
 * nor a host. What it cannot say is whether the real 9P pipe fragments the way WSL1's does — that is
 * the measurement `scripts/compatibility/bash-parity-real.mjs` makes, and the two answer the same
 * question at different resolutions.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readFileSync as read } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RECORD_TAG } from '../src/host/wsl-bash-protocol.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A stdout stand-in that hands out chunks and lets the test decide when each one lands.
 *
 * The session subscribes to `data`, so this is the seam the real pipe arrives through. Chunk
 * boundaries are the thing under test: the defect needed a chunk to land during an await, and a
 * fixed-size chunk list cannot express that.
 */
function fakeStdout() {
  const listeners: ((buffer: Buffer) => void)[] = []
  let pending: Buffer[] = []
  return {
    on: (_event: string, listener: (buffer: Buffer) => void) => listeners.push(listener),
    /** Queue bytes for a later `flush`, so they arrive between two awaits. */
    later: (buffer: Buffer) => { pending.push(buffer) },
    /** Deliver the queued bytes now. */
    flush() {
      for (const buffer of pending) for (const listener of listeners) listener(buffer)
      pending = []
    },
    deliver(buffer: Buffer) {
      for (const listener of listeners) listener(buffer)
    },
  }
}

test('a chunk that lands during the stderr wait still reaches the spill file', async () => {
  const stdout = fakeStdout()
  // The class under test, imported for its own sake: the spill bookkeeping is private, so the
  // property is observed through the file it writes rather than through its internals.
  const { WslBashSession } = await import('../src/host/wsl-bash-session.ts')

  const directory = mkdtempSync(join(tmpdir(), 'spill-gate-'))
  const session = Object.create(WslBashSession.prototype)
  // Reach the fields the spill path reads. Assigning them directly rather than driving a shell keeps
  // this offline — what is under test is the arithmetic, and the arithmetic is what lost the bytes.
  Object.assign(session, {
    spec: { maxOutputBytes: 1024, maxSpillBytes: 8 * 1024 * 1024, sessionToken: 'gate' },
    out: Buffer.alloc(0), err: Buffer.alloc(0),
    outSeen: 0, errSeen: 0, outWritten: 0, errWritten: 0,
    outTruncated: false, errTruncated: false,
    outSpill: undefined, errSpill: undefined,
  })

  const lines = (n: number): string => `${n}\n`
  // The spill file exists only once the stream overflows (`spill()` opens it on demand), so the
  // overflow is run through the window call rather than left to chance — otherwise the call
  // silently no-ops (`to <= from`) and the gate would pass without a file.
  session.openSpill('stdout')
  // Enough lines to pass the window twice, so the head is already flushed before the record's
  // window arrives. `cut` must be positive or nothing is written at all, which is the first way a
  // test like this can pass for the wrong reason.
  const TOTAL = 2000
  const body = Buffer.from(Array.from({ length: TOTAL }, (_, i) => lines(i + 1)).join(''), 'utf8')
  assert.ok(body.length > session.spec.maxOutputBytes * 2,
    `the fixture must exceed the ${session.spec.maxOutputBytes * 2}-byte window, or no spill happens`)
  stdout.deliver(body)
  session.out = body
  session.outSeen = body.length
  const cut = session.out.length - session.spec.maxOutputBytes * 2
  assert.ok(cut > 0, 'the overflow boundary must be inside the stream')
  session.spillWindow('stdout', session.out, cut)
  session.out = session.out.subarray(cut)

  const beforeSettle = session.out.length
  assert.ok(beforeSettle > 0, 'the window still holds the tail the record will follow')

  // The chunk that arrives while the reader is waiting for stderr.
  const late = Buffer.from(lines(9999), 'utf8')
  stdout.flush()
  session.out = Buffer.concat([session.out, late])
  session.outSeen += late.length

  const writtenBefore = session.outWritten
  assert.ok(writtenBefore > 0, 'the overflow must have flushed a head before the late chunk arrives')
  session.spillWindow('stdout', session.out, session.out.length)// what the fix writes to

  const spillPath = session.outSpill.path
  const text = readFileSync(spillPath, 'utf8')
  const spilledLines = text.trim().split('\n')

  assert.ok(session.outWritten > writtenBefore,
    'the late chunk must move the file cursor, or it is not in the file at all')
  // The whole stream, head to tail. The head was already flushed when the window overflowed, so this
  // checks both halves: the early lines prove the overflow path wrote them, `9999` proves the chunk
  // that landed during the wait also did. A prefix check would pass on a file that kept everything but
  // the tail, which is the shape this defect had.
  for (const line of ["1", "2", "9999"]) {
    assert.ok(spilledLines.includes(line),
      `line ${line} is missing from the spill file — ${spilledLines.length} line(s) held, 401 expected`)
  }
  assert.equal(spilledLines.length, 2001, 'every line the command printed, once each')
  assert.ok(!text.includes(RECORD_TAG),
    'protocol records must not reach the file the model is told to read')
  assert.ok(directory.length > 0)
})

test('the record offset is a byte offset, so slicing to it drops whole lines', () => {
  // Why `this.out.length` replaced `done.recordStart` as the spill's bound. `recordStart` is a **byte**
  // offset into the window (that is what `readRecord` returns and what the answer is sliced with), so
  // it is a *position*, not a *boundary for the file*. Everything after it — the tail of the last
  // chunk, which is exactly what arrived during the stderr wait on WSL1 — belongs in the file too.
  //
  // Kept as a named assertion because the value of the fix is entirely in this difference: reverting
  // one number puts the missing bytes back, and nothing else notices.
  const window = Buffer.from('1\n2\n3\n4\n', 'utf8')
  const recordStart = 4// a byte offset: `4\n` starts here
  assert.equal(window.subarray(0, recordStart).toString('utf8'), '1\n2\n',
    'a byte offset lands mid-line, which is why it cannot serve as the file boundary')
  assert.ok(window.subarray(recordStart).length > 0,
    'bytes exist after the record, and the old argument dropped them')
  // The bound the fix uses: the whole window. `spillWindow` strips the records on the way in, so
  // nothing internal leaks.
  assert.equal(window.subarray(0, window.length).toString('utf8'), '1\n2\n3\n4\n',
    'the window length is the whole command output, records excluded by stripRecords')
})
test('the stdout spill is taken after the stderr wait, and to the whole window', () => {
  // The two properties above are arithmetic; this one is about **where the call sits**, and no
  // offline test of `spillWindow` can see it. The mutation check proved that: reverting the order
  // left both arithmetic tests green. So the order is asserted on the source, which is blunt but
  // is the thing that actually regressed.
  //
  // What went wrong on WSL1: `spillWindow('stdout', …)` ran *before* `await settleStderr()`, so
  // chunks that landed during that await were below the bound when the spill was taken and above it
  // by the time the answer was sliced — reaching neither the model nor the file. 36 kB, about half a
  // pipe chunk, on a host whose 9P fragments more finely than WSL2's.
  const source = read(join(repoRoot, 'src', 'host', 'wsl-bash-session.ts'), 'utf8')
  const completion = source.indexOf('if (done !== undefined) {')
  assert.ok(completion > 0, 'the completion branch was not found, so this check is vacuous')

  const branch = source.slice(completion, source.indexOf('const stderr = this.takeStderr', completion))
  const settleAt = branch.indexOf('await this.settleStderr()')
  const spillAt = branch.indexOf("this.spillWindow('stdout'")
  assert.ok(settleAt > 0 && spillAt > 0,
    `the completion branch must contain both the wait and the spill (settle@${settleAt}, spill@${spillAt})`)
  assert.ok(spillAt > settleAt,
    'the stdout spill must be taken AFTER the stderr wait — before it, the bytes that arrive during '
    + 'the wait reach neither the answer nor the file')

  // And to the window, not to the record's offset: `recordStart` is a byte position inside the
  // window, and `stripRecords` removes the record on the way into the file, so the window length is
  // both sufficient and safe.
  assert.match(branch, /this\.spillWindow\('stdout', this\.out, this\.out\.length\)/,
    'the stdout spill must be bounded by the window length; a record offset drops the bytes after it')
  assert.doesNotMatch(branch, /this\.spillWindow\('stdout', this\.out, done\.recordStart\)/,
    'the record offset is a byte position, not the file boundary — this is the shape of the WSL1 defect')
})

test('the stderr spill is taken after the same wait, and reports its own truncation', () => {
  // The stderr arm kept the WSL1 defect for longer, because its spill sat *before* the wait while
  // stdout's had been moved after it. Measured 2026-10-11 on a real distribution: a
  // `seq 1 200000 >&2` file held 1 011 753 of 1 288 895 bytes and ended mid-number, while the answer
  // — which `takeStderr` reads after the wait — had the tail. So the same order is asserted here,
  // and for the same reason: what arrives during the wait has to reach the file too.
  const source = read(join(repoRoot, 'src', 'host', 'wsl-bash-session.ts'), 'utf8')
  const completion = source.indexOf('if (done !== undefined) {')
  const takeAt = source.indexOf('const stderr = this.takeStderr', completion)
  const branch = source.slice(completion, takeAt)
  const settleAt = branch.indexOf('await this.settleStderr()')
  const stderrSpillAt = branch.indexOf("this.spillWindow('stderr'")
  assert.ok(settleAt > 0 && stderrSpillAt > 0,
    `the completion branch must contain both the wait and the stderr spill (settle@${settleAt}, spill@${stderrSpillAt})`)
  assert.ok(stderrSpillAt > settleAt,
    'the stderr spill must be taken AFTER the stderr wait — before it, the bytes still in flight reach '
    + 'the answer (through takeStderr) and never the file')
  // And before `takeStderr`, which consumes the window it reads.
  assert.ok(takeAt > completion && completion + stderrSpillAt < takeAt,
    'the spill has to run before the window is consumed, or the file gets whatever is left')
  assert.match(branch, /this\.spillWindow\('stderr', this\.err, this\.err\.length\)/,
    'the stderr spill must be bounded by the window length')

  // And the settled run has to report the overflow it performed. `stderrTruncated: false` was a
  // constant on this path — the flag was cleared before the run was built — so a 1.29 MB stderr came
  // back `truncated: false` with a spill file beside it, and the tool had nothing to render a note
  // from.
  const settledRun = source.slice(takeAt, source.indexOf('const caused = armed.signal.aborted', takeAt))
  assert.ok(settledRun.includes('run: {'), 'the settled run was not found, so this check is vacuous')
  assert.doesNotMatch(settledRun, /stderrTruncated: false/,
    'the settled run must not hardcode stderrTruncated: false — that is the constant that hid the truncation')
  assert.match(settledRun, /truncated, stderrTruncated,/,
    'the run must carry the captured stderrTruncated alongside the stdout one')
  const captureAt = source.indexOf('const truncated = this.outTruncated', takeAt)
  const resetAt = source.indexOf('this.errTruncated = false', captureAt)
  assert.ok(captureAt > takeAt && resetAt > captureAt,
    `the capture and the reset must both sit in the settle path (capture@${captureAt}, reset@${resetAt})`)
  assert.match(source.slice(captureAt, resetAt), /const stderrTruncated = this\.errTruncated/,
    'stderrTruncated must be captured before the reset, the way `truncated` is')
})

test('a NUL the command wrote to stderr is data, and only the marker is protocol', async () => {
  // The marker is one NUL written after the command, and nothing else is written to fd 2 for that
  // frame — so it is the last byte of the chunk that carries it, and a NUL anywhere else belongs to
  // the command. The reader used to filter *every* NUL in the chunk: `printf 'a\0b\n' >&2` came back
  // `ab` while the same bytes on stdout kept theirs.
  const { splitStderrMarker } = await import('../src/host/wsl-bash-session.ts')

  // The command's own NUL, in a chunk with no marker in it: kept.
  const data = Buffer.from('a\0b\n', 'latin1')
  assert.deepEqual(splitStderrMarker(data), { kept: data, markerSeen: false },
    'a chunk that does not end on a NUL carries no marker, so every byte of it is the command’s')

  // The marker alone, and the marker sharing a chunk with the command's bytes: exactly one byte goes.
  assert.deepEqual(splitStderrMarker(Buffer.from([0])), { kept: Buffer.alloc(0), markerSeen: true })
  const shared = splitStderrMarker(Buffer.from('a\0b\n\0', 'latin1'))
  assert.equal(shared.markerSeen, true, 'a trailing NUL is the marker')
  assert.equal(shared.kept.toString('latin1'), 'a\0b\n',
    'and the command’s own NUL survives it — this is the byte the old filter ate')

  // An empty chunk is not a marker (a zero-length `data` event is legal).
  assert.deepEqual(splitStderrMarker(Buffer.alloc(0)), { kept: Buffer.alloc(0), markerSeen: false })

  // The one shape this rule cannot tell apart is asserted as the behaviour it is, not left in prose:
  // a command whose stderr ends on a chunk boundary with a NUL of its own reads as the marker, so that
  // byte goes and the settle wait is a byte short. The alternative — filtering every NUL — is the
  // defect this test exists for, and it costs every NUL the command wrote.
  assert.deepEqual(splitStderrMarker(Buffer.from('x\0', 'latin1')),
    { kept: Buffer.from('x', 'latin1'), markerSeen: true },
    'the documented trade-off: a trailing NUL is read as the marker even when the command wrote it')
})

test('the stderr spill file carries the command’s bytes, not our echoed frame', () => {
  // The shell's line editor writes the line it just read to stderr, and that echo is the first thing
  // on the frame's stderr — so it was the file's first line. `stripRecords` removes the records but
  // not the echo, and `dropProtocolEcho` (which does) only ever ran on the answer. Measured
  // 2026-10-11: the file began `… } | base64 -w0 )" # __DSH_WSL_BASH_REC`.
  //
  // The predicate is the answer's own, so the file and the body agree on what counts as protocol.
  const source = read(join(repoRoot, 'src', 'host', 'wsl-bash-session.ts'), 'utf8')
  assert.match(source, /dropLeadingFrameEcho\(bytes, this\.framePayload, this\.frameStdinPayload\)/,
    'the stderr spill must run its first window through the echo filter the answer uses')
  const helper = source.slice(source.indexOf('function dropLeadingFrameEcho'))
  assert.match(helper.slice(0, helper.indexOf('\n}')),
    /dropProtocolEcho\(first, payload \?\? '', stdinPayload\) === ''/,
    'and it must decide with dropProtocolEcho rather than a second, weaker predicate')
  assert.ok(source.includes('this.framePayload = frame.payload'),
    'the frame in flight has to be reachable from the spill path, or the filter gets nothing to match')
})

