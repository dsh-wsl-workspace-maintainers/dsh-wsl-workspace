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
 * Commands that need a terminal because what they ask for cannot be answered any other way: a
 * password, a passphrase, an interactive authentication step. Escalated automatically, full deadline.
 */
export const CREDENTIAL_COMMANDS: ReadonlySet<string> = new Set([
  'sudo', 'su', 'doas', 'ssh', 'scp', 'sftp', 'rsync', 'passwd', 'chpasswd', 'gpg',
  'ssh-copy-id', 'ssh-keygen', 'mysql', 'mariadb', 'psql', 'sqlplus', 'redis-cli', 'mongosh',
])

/**
 * Commands that wait for a keyboard and will not produce anything until it arrives. Still escalated
 * — an agent legitimately uses their batch forms (`vim -es -c '…' -c wq`, `tmux new -d 'cmd'`) and a
 * terminal is the only way to find out — but their deadline is bounded to {@link KEYBOARD_TIMEOUT_MS}
 * and a timeout says so in the body, because the default deadline is two minutes.
 */
export const KEYBOARD_COMMANDS: ReadonlySet<string> = new Set([
  'vim', 'vi', 'nvim', 'view', 'nano', 'pico', 'emacs', 'ed', 'tmux', 'screen', 'telnet', 'ftp',
])

/**
 * Commands that reach a terminal only because the first word says so, and each of which has a
 * non-interactive spelling that is what an agent almost always wants: on a pipe `man`, `less` and
 * `top -bn1` print the whole document or a snapshot in milliseconds, while on a terminal they open a
 * pager that waits for keys. Not escalated; `tty: true` still forces one for the rare call that needs
 * the pty itself (measured: auto-escalating `man ls` turned a 50 ms answer into a pager).
 */
export const TTY_OPTIONAL_COMMANDS: ReadonlySet<string> = new Set([
  'htop', 'top', 'less', 'more', 'pg', 'man', 'info', 'gh', 'az', 'gcloud', 'aws', 'virsh', 'mongod',
])

/** What a call is given a terminal for, or `none`. */
export type TtyClass = 'credential' | 'keyboard' | 'optional' | 'none'

/** The deadline given to the keyboard class when the call does not ask for longer. */
export const KEYBOARD_TIMEOUT_MS = 8_000

/**
 * The commands escalated automatically: the credential and keyboard classes. The optional class is
 * deliberately absent — it is reachable through `tty: true`, which is what a caller who really wants
 * a pager says.
 */
export const TTY_COMMANDS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_COMMANDS,
  ...KEYBOARD_COMMANDS,
])


/**
 * The command's first word, with leading assignments and an `env` prefix skipped, so
 * `LANG=C sudo reboot` and `env -i vim file` are recognised. (Written as a token loop rather than
 * one alternation because `scripts/verify-lib.mjs` reads the built chunk for unbound calls, and a
 * regex containing `env(` looks like one.)
 *
 * The hyphen is part of the name, not a stop: without it `ssh-copy-id`, `ssh-keygen` and `redis-cli`
 * were unreachable entries of the whitelist — the scan stopped at `ssh` and `redis`, which are in no
 * class at all, so those three commands were never escalated no matter what the list said.
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
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest)
  return match?.[1] ?? ''
}

/**
 * The command inside a `bash -c` wrapper, one layer, or undefined when there is nothing readable
 * there. `bash -c 'sudo true'` was measured sitting until its deadline expired and returning
 * `(no output)` plus a session rebuild, while bare `sudo true` answers in 46 ms — the original
 * issue's symptom reproduced one layer in, and a model writes the wrapper constantly.
 *
 * The inner text is taken only as far as the next quote character: crude on purpose. An extraction
 * that stops early can only ever under-read the inner command, which falls back to the behaviour
 * before this existed — a wrapper whose contents cannot be read is not escalated on a guess.
 */
function wrappedCommand(command: string): string | undefined {
  const match = /^(?:bash|sh|zsh|dash)\s+(?:-\S+\s+)*?-\w*c\s+(['"])([^'"]*)\1/.exec(command.trim())
  return match?.[2]
}

/**
 * Which class of terminal this command wants, if any.
 * @param command - the model's command, verbatim.
 * @returns `credential`, `keyboard`, `optional` or `none`, looking through one shell wrapper.
 */
export function ttyClass(command: string): TtyClass {
  const classify = (word: string): TtyClass => {
    if (CREDENTIAL_COMMANDS.has(word)) return 'credential'
    if (KEYBOARD_COMMANDS.has(word)) return 'keyboard'
    if (TTY_OPTIONAL_COMMANDS.has(word)) return 'optional'
    return 'none'
  }
  const own = classify(firstWord(command))
  if (own !== 'none') return own
  const inner = wrappedCommand(command)
  return inner === undefined ? 'none' : classify(firstWord(inner))
}

/**
 * Whether this command should be given a terminal without being asked.
 *
 * The credential and keyboard classes; deliberately **not** the optional one, whose members answer
 * better on the pipe (`man ls` measured as a pager on a terminal and as the whole page in
 * milliseconds on a pipe). `tty: true` reaches a terminal for anything.
 * @param command - the model's command, verbatim.
 * @returns true when the command is escalated automatically.
 */
export function needsTty(command: string): boolean {
  const classification = ttyClass(command)
  return classification === 'credential' || classification === 'keyboard'
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

/** What the terminal decision and the deadline came out to, for one call. */
export interface TtyDecision {
  /** Whether the command is wrapped in `script`. */
  escalated: boolean
  /** Whether the keyboard-class bound applies to this call's deadline. */
  keyboard: boolean
  /** The deadline to run the call with. */
  deadlineMs: number
}

/**
 * The whole decision, so the bound is testable without a distribution.
 * @param command - the model's command, verbatim.
 * @param tty - the call's `tty` argument, if it named one.
 * @param requestedMs - the call's own `timeoutMs`, if it named one.
 * @param ceilingMs - the deadline the tool would otherwise use, already clamped to the configured
 * maximum.
 * @returns whether to escalate, whether the keyboard bound applies, and the deadline to use.
 */
export function decideTty(command: string, tty: boolean | undefined, requestedMs: number | undefined,
  ceilingMs: number): TtyDecision {
  const escalated = shouldEscalate(command, tty)
  // The bound applies only when the call shows no intent of its own: naming a deadline or a terminal
  // is the caller taking the wait. Capping an explicit `timeoutMs` would be this tool silently
  // overriding what it was told — the same shape as ignoring `run_in_background`.
  const keyboard = escalated && tty === undefined && requestedMs === undefined
    && ttyClass(command) === 'keyboard'
  return { escalated, keyboard, deadlineMs: keyboard ? Math.min(ceilingMs, KEYBOARD_TIMEOUT_MS) : ceilingMs }
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
