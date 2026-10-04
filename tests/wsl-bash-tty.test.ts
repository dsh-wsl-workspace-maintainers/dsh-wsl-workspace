// Offline tests for the terminal escalation: which commands get a pseudo-terminal, what the wrapper
// looks like on the wire, and what a pty's bytes have to be folded into before the model reads them.
// The live half of this (does `sudo` answer, is the size real) is a cell in
// `scripts/compatibility/bash-session-real.mjs`, because a pty is not a thing one can fake honestly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { TTY_COMMANDS, firstWord, needsTty, normaliseTtyOutput, wrapForTty } from '../src/host/wsl-bash-tty.ts'

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
})
