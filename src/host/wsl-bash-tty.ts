/**
 * Running a command on a real terminal, inside a shell that nobody is typing into.
 *
 * The session gives a command pipes for stdin. That is right for everything a model normally runs,
 * and wrong for the programs that read the terminal instead — and the failure there is not an error
 * message. Measured on this machine (2026-10-05, `D:\Temp\issue51-s0\v1b-report.txt`): the session
 * shell *does* have a controlling terminal (`ps -o tty=` answers `pts/1`) and job control (`$-` is
 * `himBs`), so a command that reads `/dev/tty` is put in the foreground of a terminal whose input
 * side nothing can feed. `sudo true` sleeps there as `S+` with `wchan=wait_woken` until the call's
 * deadline expires, and the session then has to be rebuilt to be usable again.
 *
 * `script -qec '<cmd>' /dev/null` gives the command a pseudo-terminal of its own while the outer pipe
 * stays ours: the records that end the call are written by the frame, outside `script`, so escalation
 * cannot corrupt the protocol. It also changes the outcome, because `script`'s stdin is the frame's
 * `/dev/null` — a program that reaches for the keyboard is handed **end of file** and answers with its
 * own complaint. Measured: the same `sudo true` returns in 45–54 ms with sudo's three lines
 * (`[sudo] password for ruler:`, `sudo: no password was provided`, `sudo: a password is required`) and
 * exit 1, instead of costing the deadline.
 *
 * Nothing here decides *which* commands need a terminal: that judgement used to be three lists of
 * command names and it was wrong twice in one day (`ssh-copy-id` never matched because the scan stopped
 * at a hyphen; `printf x; vim note.txt` burnt 121 703 ms because only the first word was read). The
 * decision is made by watching the process — see `wsl-bash-starve` — and `tty: true` remains the door
 * for a caller who knows it wants a terminal before running anything.
 *
 * What a terminal costs is bytes: `script` echoes CR/LF pairs (`\r\r\n`) that the plain path never
 * produces, and a program that cannot see a capable terminal writes emphasis as overstrike, so an
 * escalated call's output is normalised before the model reads it. A pseudo-terminal also has no second
 * channel: stdout and stderr arrive as one stream, which the parity ledger records as a difference from
 * the plain path rather than something to paper over.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-tty
 */

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
