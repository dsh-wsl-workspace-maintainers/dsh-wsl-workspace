// Offline tests for the terminal mechanics: what the wrapper looks like on the wire, and what a pty's
// bytes have to be folded into before the model reads them. Which commands get a terminal is no longer
// decided from a list of names — that reading is tested in `wsl-bash-starve.test.ts`, against the
// `/proc` lines taken off this distribution. The live half (does `sudo` answer, is the window size
// real) is a cell in `scripts/compatibility/bash-session-real.mjs`, because a pty is not a thing one
// can fake honestly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { normaliseTtyOutput, wrapForTty } from '../src/host/wsl-bash-tty.ts'

test('the wrapper travels as one line and carries the stty inside the pty', () => {
  const wrapped = wrapForTty("echo it's $(date) >&2")
  assert.ok(!wrapped.includes('\n'), 'a frame is one line, or the shell runs it as two commands')
  assert.ok(wrapped.startsWith('script -qec '), wrapped)
  const inner = /printf %s '([^']+)' \| base64 -d/.exec(wrapped)?.[1]
  assert.ok(inner !== undefined, `no payload in ${wrapped}`)
  assert.equal(Buffer.from(inner, 'base64').toString('utf8'),
    "stty rows 24 cols 80 2>/dev/null; echo it's $(date) >&2",
    'stty set outside the pty was measured to leave `stty size` answering 0 0')
})

test('the wrapper carries the quoting a real command contains, unchanged', () => {
  // Quotes, a backslash and a `$` must arrive as written: the inner command is decoded from base64
  // rather than re-spelled through another layer of shell quoting.
  const command = `printf '%s\\n' "a'b" '$HOME'; grep -e 'x[^\\]]' /etc/hosts`
  const inner = /printf %s '([^']+)' \| base64 -d/.exec(wrapForTty(command))?.[1] ?? ''
  assert.equal(Buffer.from(inner, 'base64').toString('utf8'), `stty rows 24 cols 80 2>/dev/null; ${command}`)
})

test('a pty’s bytes are folded back into plain text', () => {
  assert.equal(normaliseTtyOutput('a\r\nb\r\nc\n'), 'a\nb\nc\n')
  assert.equal(normaliseTtyOutput('[sudo] password: \r\r\nsudo: no password\r\n'),
    '[sudo] password: \nsudo: no password\n', 'script writes the CR of a prompt line twice')
  assert.equal(normaliseTtyOutput('\x1b[?1049h\x1b[1;1Hcleared\x1b[K\n'), 'cleared\n', 'CSI in, CSI out')
  assert.equal(normaliseTtyOutput('\x1b]0;title\x07prompt\n'), 'prompt\n', 'OSC including the window title')
  assert.equal(normaliseTtyOutput('oops: no such file\n'), 'oops: no such file\n',
    'positive control: ordinary stderr is untouched')
  // Both shapes below are the bytes `man ls` actually produced on this distribution's pty, captured
  // verbatim: bold is a glyph doubled around a backspace (`N\bNA\bAM\bME\bE` for `NAME`) and the
  // underline marker is `_\b` before the glyph (`[_\bO_\bP_\bT_\bI_\bO_\bN]` for `[OPTION]`). The rule
  // is what a terminal does — the character before a backspace is overwritten — so both fold, and a
  // dangling backspace with nothing after it eats its own left neighbour, which is also what a
  // terminal would show. That edge is pinned here rather than left to a reader guessing.
  assert.equal(normaliseTtyOutput('N\bNA\bAM\bME\bE\n'), 'NAME\n', 'overstrike bold, as measured')
  assert.equal(normaliseTtyOutput('l\bls\bs\n'), 'ls\n', 'the doubled glyph man really writes')
  assert.equal(normaliseTtyOutput('[_\bO_\bP]'), '[OP]', 'overstrike underline, as measured')
  assert.equal(normaliseTtyOutput('a\b'), '', 'a dangling backspace takes its left neighbour, as a terminal would')
})
