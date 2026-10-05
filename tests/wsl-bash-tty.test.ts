// Offline tests for the terminal escalation: which commands get a pseudo-terminal, what the wrapper
// looks like on the wire, and what a pty's bytes have to be folded into before the model reads them.
// The live half of this (does `sudo` answer, is the size real) is a cell in
// `scripts/compatibility/bash-session-real.mjs`, because a pty is not a thing one can fake honestly.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CREDENTIAL_COMMANDS,
  KEYBOARD_COMMANDS,
  KEYBOARD_TIMEOUT_MS,
  TTY_COMMANDS,
  TTY_OPTIONAL_COMMANDS,
  decideTty,
  firstWord,
  needsTty,
  normaliseTtyOutput,
  shouldEscalate,
  ttyClass,
  wrapForTty,
} from '../src/host/wsl-bash-tty.ts'

test('the credential and keyboard classes are escalated, and ordinary commands are left alone', () => {
  assert.equal(needsTty('sudo true'), true)
  assert.equal(needsTty('LANG=C sudo reboot'), true, 'a leading assignment must not hide the command')
  assert.equal(needsTty('env -i vim file'), true)
  assert.equal(needsTty('ssh host true'), true)
  assert.equal(needsTty('git status'), false, 'git reaches a terminal only in special subcommands')
  assert.equal(needsTty('echo hi | sudo -v'), true, 'every top-level segment is read: a compound command runs its terminal-waiting part too')
  assert.equal(needsTty('cd /tmp && vim f'), true, 'measured cost of reading only the first word: 121 703 ms in a real session')
  assert.equal(needsTty('printf \'x\\n\'; vim f'), true)
  assert.equal(needsTty('echo "sudo reboot"'), false, 'a quoted word is not a command position')
  assert.equal(needsTty(''), false)
  assert.equal(firstWord('   '), '')
})

test('the class of a compound command is the strongest one any segment carries', () => {
  assert.equal(ttyClass('sudo -n true; vim f'), 'keyboard', 'the keyboard part is what the deadline pays for')
  assert.equal(ttyClass('sudo -n true; man ls'), 'credential')
  assert.equal(ttyClass('man ls | head -3'), 'optional')
  assert.equal(ttyClass('git status'), 'none')
})

test('the pager class is not escalated, because on the pipe it answers better', () => {
  // Measured on this distribution: `man ls` under `script` opened a pager and waited for a keyboard,
  // while the same call on the pipe printed the whole page, and `top -bn1 | head` needed the pty only
  // because it was watching for `q`. `tty: true` still opens the pager for whoever wants it.
  for (const command of ['man ls', 'less /etc/hostname', 'top', 'htop -b', 'info ls', 'gh --version',
    'mongod --version']) {
    assert.equal(needsTty(command), false, `${command} must stay on the pipe`)
    assert.equal(ttyClass(command), 'optional')
    assert.equal(shouldEscalate(command, true), true, `${command} is reachable by asking`)
    assert.equal(shouldEscalate(command, false), false)
  }
  // A hyphen is part of a command name. Three whitelist entries carried one, and the scan that stops
  // at `ssh` / `redis` made them dead letters: escalated by the list, unreachable by the code.
  assert.equal(ttyClass('redis-cli ping'), 'credential')
  assert.equal(ttyClass('ssh-keygen -t ed25519'), 'credential')
  assert.equal(needsTty('ssh-copy-id user@host'), true)
  assert.equal(ttyClass('-x'), 'none', 'a leading flag is not a command name')
})

test('the three classes are disjoint and together are the whole old whitelist', () => {
  const all = [...CREDENTIAL_COMMANDS, ...KEYBOARD_COMMANDS, ...TTY_OPTIONAL_COMMANDS]
  assert.equal(new Set(all).size, all.length, 'a word in two classes makes the bound ambiguous')
  assert.equal(all.length, 43, `${all.length} words: ${JSON.stringify(all.filter((word, index) => all.indexOf(word) !== index))}`)
  assert.equal(TTY_COMMANDS.size, CREDENTIAL_COMMANDS.size + KEYBOARD_COMMANDS.size)
  for (const word of all) {
    assert.equal(needsTty(word), !TTY_OPTIONAL_COMMANDS.has(word), `${word} classification disagrees with the sets`)
  }
})

test('the keyboard bound applies only to a call that named neither deadline nor terminal', () => {
  assert.deepEqual(decideTty('vim notes.md', undefined, undefined, 120_000),
    { escalated: true, keyboard: true, deadlineMs: KEYBOARD_TIMEOUT_MS },
    'the default deadline is two minutes on a program that cannot be satisfied')
  assert.equal(decideTty('vim notes.md', undefined, 30_000, 30_000).deadlineMs, 30_000,
    'an explicit timeoutMs is the caller taking the wait; capping it would be overriding what we were told')
  assert.equal(decideTty('vim notes.md', true, undefined, 120_000).keyboard, false,
    'an explicit tty:true is the same kind of intent')
  assert.equal(decideTty('sudo true', undefined, undefined, 120_000).deadlineMs, 120_000,
    'the credential class keeps its deadline: it answers in milliseconds once it has a terminal')
  assert.equal(decideTty('man ls', undefined, undefined, 120_000).escalated, false)
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
  assert.equal(needsTty("bash -c 'echo hi; sudo -v'"), true,
    'the wrapper’s inner segments are read too — the rule is per segment, not per first word')
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
