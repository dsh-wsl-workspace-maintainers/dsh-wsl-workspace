/**
 * Running a command that wants a real terminal, inside a shell that has none.
 *
 * The session protocol gives a command a pipe for stdin and no controlling terminal, which is right
 * for everything a model normally runs. It is wrong for the small class that opens `/dev/tty` — a
 * password prompt, an editor — and the failure there is not an error message: `sudo true` with no
 * terminal was measured to sit there until the call's deadline expired, returning
 * `[timed out after 6000ms]` and nothing else, and costing a session rebuild.
 *
 * `script -qec '<cmd>' /dev/null` gives the command a fresh pseudo-terminal of its own while the
 * outer pipe stays ours: the records that end the call are written by the frame, outside `script`,
 * so escalation cannot corrupt the protocol. Measured on this machine (2026-10-04): the same
 * `sudo true` returns in 476 ms with sudo's own three lines — `[sudo] password for ruler:`,
 * `sudo: no password was provided`, `sudo: a password is required` — and exit 1.
 *
 * What the pty costs is bytes: `script` echoes CR/LF pairs (`\r\r\n`) that the plain path never
 * produces, so an escalated call's output is normalised before the model reads it.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-tty
 */

/**
 * First words whose ordinary use is interactive. Deliberately narrow: `git`, `docker` and `curl`
 * reach a terminal only in special subcommands, and wrapping them would add CR noise to the
 * commands a model runs a hundred times a day.
 */
export const TTY_COMMANDS: ReadonlySet<string> = new Set([
  'sudo', 'su', 'doas', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp',
  'passwd', 'chpasswd', 'gpg', 'ssh-copy-id', 'ssh-keygen',
  'vim', 'vi', 'nvim', 'view', 'nano', 'pico', 'emacs', 'ed',
  'htop', 'top', 'less', 'more', 'pg', 'man', 'info',
  'mysql', 'mariadb', 'psql', 'sqlplus', 'redis-cli', 'mongosh', 'mongod',
  'gh', 'az', 'gcloud', 'aws', 'virsh', 'tmux', 'screen',
])

/**
 * The command's first word, with leading assignments and an `env` prefix skipped, so
 * `LANG=C sudo reboot` and `env -i vim file` are recognised. (Written as a token loop rather than
 * one alternation because `scripts/verify-lib.mjs` reads the built chunk for unbound calls, and a
 * regex containing `env(` looks like one.)
 */
export function firstWord(command: string): string {
  let rest = command.trimStart()
  let afterEnv = false
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest)
    if (assignment !== null) {
      rest = rest.slice(assignment[0].length)
      continue
    }
    if (!afterEnv && /^env\s+/.test(rest)) {
      afterEnv = true
      rest = rest.replace(/^env\s+/, '')
      continue
    }
    const flag = afterEnv ? /^-\S+\s+/.exec(rest) : null
    if (flag === null) break
    rest = rest.slice(flag[0].length)
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
  return match?.[1] ?? ''
}

/**
 * Whether this command should be given a terminal of its own.
 *
 * Two shapes are read: the command's own first word, and the first word inside a shell wrapper —
 * `bash -c 'sudo true'` was measured sitting until its deadline expired and returning
 * `(no output) [timed out after 4000ms]` plus a session rebuild, while bare `sudo true` answers in
 * 46 ms. That is the original issue's symptom reproduced one layer in, and a model writes the
 * wrapper constantly.
 *
 * The wrapper is read one layer deep, and the inner text is taken only as far as the next quote
 * character: crude on purpose. An extraction that stops early can only ever under-read the inner
 * command's first word, which falls back to the behaviour before this existed — a wrapper whose
 * contents cannot be read is not escalated, rather than escalated on a guess.
 */
export function needsTty(command: string): boolean {
  if (TTY_COMMANDS.has(firstWord(command))) return true
  const wrapper = /^(?:bash|sh|zsh|dash)\s+(?:-\S+\s+)*?-c\s+(['"])([^'"]*)\1/.exec(command.trim())
  return wrapper !== null && TTY_COMMANDS.has(firstWord(wrapper[2] ?? ''))
}

/**
 * The whole escalation decision, in one place so the veto is testable without a distribution.
 * @param command - the model's command, verbatim.
 * @param tty - the call's `tty` argument: true forces a terminal, false refuses one the rule would
 * otherwise give, and absent leaves it to the rule.
 * @returns whether this call runs on a pseudo-terminal.
 */
export function shouldEscalate(command: string, tty: boolean | undefined): boolean {
  if (tty === false) return false
  return tty === true || needsTty(command)
}

/**
 * Wrap a command so it runs on a pseudo-terminal with a sane window size.
 *
 * The inner command travels base64-encoded for the same reason the frame's payload does: it may
 * contain quotes or newlines, and `script -c` takes one string argument. `stty` runs *inside* the
 * pty — measured: setting it outside leaves `stty size` answering `0 0` even though `tty` reports
 * `/dev/pts/N`.
 *
 * @param command - the model's command, verbatim.
 * @returns a command to run in the session shell that escalates to a pty.
 */
export function wrapForTty(command: string): string {
  const inner = Buffer.from(`stty rows 24 cols 80 2>/dev/null; ${command}`, 'utf8').toString('base64')
  return `script -qec "$(printf %s '${inner}' | base64 -d)" /dev/null`
}

/**
 * Fold a pty's line endings, overstrike and control sequences back into plain text.
 *
 * Only escalated output goes through this. `script` writes `\r\n` for newlines and, because the
 * inner shell also rewrites its own prompt line, sometimes `\r\r\n`; a bare `\r` left in the body
 * makes the host's front-end render the tail of a line over its head.
 *
 * Overstrike is folded the way a terminal resolves it. Measured on this distribution, `man` writes
 * every emphasised glyph as itself twice with a backspace between — `N\bNA\bAM\bME\bE` for `NAME` —
 * which the model reads as garbage where a person at a real terminal reads `NAME`. Only those two
 * shapes are folded (doubled glyph, and the `_\b` an underline marker leaves); a backspace that is
 * none of those is left alone rather than eating a character that has not been overwritten.
 *
 * @param text - stdout or stderr as the pty produced it.
 * @returns the same text with CR removed, overstrike resolved and CSI/OSC sequences dropped.
 */
export function normaliseTtyOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/.\x08/g, '')
    .replace(/\r/g, '')
}
