// Offline tests for the terminal escalation: which commands get a pseudo-terminal, what the wrapper
// looks like on the wire, and what a pty's bytes have to be folded into before the model reads them.
// The live half of this (does `sudo` answer, is the size real) is a cell in
// `scripts/compatibility/bash-session-real.mjs`, because a pty is not a thing one can fake honestly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { TTY_COMMANDS, firstWord, needsTty, normaliseTtyOutput, shouldEscalate, wrapForTty } from '../src/host/wsl-bash-tty.ts'

test('the interactive class is recognised, and ordinary commands are left alone', () => {
  assert.equal(needsTty('sudo true'), true)
  assert.equal(needsTty('LANG=C sudo reboot'), true, 'a leading assignment must not hide the command')
  assert.equal(needsTty('env -i vim file'), true)
  assert.equal(needsTty('ssh host true'), true)
  assert.equal(needsTty('git status'), false, 'git reaches a terminal only in special subcommands')
  assert.equal(needsTty('echo hi | sudo -v'), false, 'documented limit: the decision reads the first word')
  assert.equal(needsTty(''), false)
  assert.equal(firstWord('   '), '')
})

test('the whitelist is the narrow one, not a grab bag', () => {
  for (const word of ['sudo', 'ssh', 'vim', 'less', 'mysql', 'gpg']) {
    assert.ok(TTY_COMMANDS.has(word), `${word} belongs`)
  }
  for (const word of ['git', 'docker', 'curl', 'npm', 'make', 'cat']) {
    assert.ok(!TTY_COMMANDS.has(word), `${word} must not be wrapped`)
  }
})

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

test('a shell wrapper is read one layer deep, and an unreadable one is not guessed at', () => {
  // Measured: `bash -c 'sudo true'` sat until its deadline and returned `(no output)` plus a session
  // rebuild, while bare `sudo true` answered in 46 ms — the issue's own symptom one layer in.
  assert.equal(needsTty("bash -c 'sudo true'"), true)
  assert.equal(needsTty('sh -c "passwd"'), true)
  assert.equal(needsTty('bash -l -c "sudo -n true"'), true, 'other flags before -c are skipped')
  assert.equal(needsTty("bash -c 'echo hi; sudo -v'"), false,
    'only the inner command’s first word decides — a wrapper that mentions sudo later is not a terminal case')
  assert.equal(needsTty('bash -c "echo hi"'), false)
  assert.equal(needsTty("bash -c 'sudo true"), false, 'an unterminated quote is left alone, not escalated on a guess')
  assert.equal(needsTty("grep -r 'sudo' /var/log"), false, 'a search is not a wrapper')
})

test('tty false is a veto, true a force, absent the rule', () => {
  assert.equal(shouldEscalate('sudo true', undefined), true)
  assert.equal(shouldEscalate('sudo true', true), true)
  assert.equal(shouldEscalate('sudo true', false), false,
    'measured: with only `true` honoured, `man ls` with `tty: false` came back with the pty anyway')
  assert.equal(shouldEscalate('ls -l', false), false)
  assert.equal(shouldEscalate('ls -l', undefined), false)
  assert.equal(shouldEscalate('ls -l', true), true)
})
