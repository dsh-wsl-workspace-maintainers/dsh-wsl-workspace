# Is it the pseudo-terminal? A triage sheet for `bash` calls

Every `bash` call in a WSL workspace goes through one of three layers, and each fails in its own
words. This sheet exists so a failure can be pinned to a layer **from the transcript alone**, in one
re-run, without reopening the session wondering where to look.

| the layer | how to recognise it in a body | who owns it |
| --- | --- | --- |
| pipe (default) | no terminal notes at all; `[stderr]` sections present; `tty` prints `not a tty` | `src/host/wsl-bash-session.ts` |
| pseudo-terminal (escalated) | one of the `[this call ran on a pseudo-terminal…]`, `[this program waits for a keyboard…]`, `[sudo asked for a password…]` lines below | `src/host/wsl-bash-tty.ts` |
| the host's own PTY tier (`DSH_WSL_PTY_SHELL=1`) | `Your command timed out after 300 seconds`, a sentinel line `__DSH_PERSISTENT_BASH_END_…`, `dsh>^C` | the host's `dsh-terminal-bash`, mounted for comparison only |

## Symptom → layer → the one call that settles it

| what you see | whose it is | confirm with | fix |
| --- | --- | --- | --- |
| `[this call ran on a pseudo-terminal (script -qec, one stream): re-run the same command with "tty": false …]` | ours, and it is telling you it does not know either — this is the unforeseen-failure line | re-send the identical command with `"tty": false` | if the plain call behaves, the terminal is the layer; if it fails the same way, it is the program and this note is your evidence to look there |
| `[this program waits for a keyboard nobody is typing into: give it a non-interactive form …]` | ours, keyboard class (`vim`, `nano`, `tmux`, `screen`, `telnet`, `ftp`) — the deadline is 8 s when the call named none of its own and whatever the call asked for when it did, but the hint rides either way | none needed — a wait that cannot be satisfied is not a bug in the shell | use the batch form (`vim -es -c 's/../../g' -c wq file`, `tmux new -d 'cmd'`), or the file tools |
| `[sudo asked for a password and this shell has nobody to type it …]` | the distribution's sudoers, not this plugin | `sudo -n true` — it answers in milliseconds either way | run the session as a `NOPASSWD` user or as root (`DSH_WSL_USER`); the agent cannot type a password in any layer |
| `[stderr]` missing although the command wrote to fd 2, or the output interleaves | expected under a terminal: a pty has one stream | re-run with `"tty": false` to get the separation back | nothing to fix; if the separation matters, that call must not be escalated |
| text like `N\bNA\bAM\bME\bE` | escalated output whose overstrike was *not* folded — a regression, since the fold is gated | re-run with `"tty": false`: clean text confirms the layer | report it; `normaliseTtyOutput` in `src/host/wsl-bash-tty.ts` owns the fold and a cell in `bash-session-real` asserts it |
| `not a tty`, or `stty: 'standard input': Inappropriate ioctl for device` | **not** the terminal: that is the ordinary pipe, working as designed | pass `"tty": true` and the same call reports `/dev/pts/N` and `24 80` | only programs that check for a terminal need this |
| `[exit code: N]` | the program's own status | compare with the same command in any shell | nothing is broken; `1` from `false` and `127` from a missing name are the contract |
| `[timed out after 8000ms]` on `man`, `less`, `gh` | should not happen: that class is no longer escalated automatically | check the call: it only happens if it passed `"tty": true` itself | drop `tty: true`; on the pipe `man`/`less` print the whole document in milliseconds |
| escape bytes like `[24;1H` and a body of `~` rows, **without** any terminal note | a full-screen program ran on the pipe — so the class rule did not recognise it. A live display normally refuses instead (`top: failed tty get`, exit 1, 687 ms measured), so this shape means a program that draws anyway | re-send with `"tty": true`: the same screen arrives folded and with the size set | if its first word is in the keyboard list (`vim`, `nano`, `tmux`) it is now escalated by every top-level segment, so `cd /tmp && vim f` counts; anything outside the list needs the list extended or `tty: true` on the call |
| a keyboard program costing the configured default (two minutes) instead of 8 s | the deadline was named by the call (`timeoutMs`) or `tty` was set explicitly — the bound only applies to a call that shows no intent of its own | read the call's own arguments in the transcript | name a short `timeoutMs`, or use the batch form |
| `[the shell was restarted; not restored: functions (N bytes over the 65536 byte cap)]` | by design — the journal reports what it refused to replay | call `declare -f \| wc -c` to see the size | define what you need again after a restart, or keep functions small; the cap exists because one rc file here holds 61 kB of them |
| `[output truncated; full output: <path>]` | the retention layer's own note, not a failure | `read` that path | nothing; the whole stream is on disk |
| a body containing `__DSH_WSL_BASH`, `eval "$(printf %s`, `{ export -p;` or `#dsh-section` | **a real defect in our frame filter** — these bytes are never meant to be readable | grep the same transcript for them; `bash-session-real` counts bodies carrying any of them | stop and report with the transcript line; this leaked once before and is gated since |
| `Your command timed out after 300 seconds …` + `__DSH_PERSISTENT_BASH_END_…` | the host's PTY tier, i.e. `DSH_WSL_PERSISTENT`/`DSH_WSL_PTY_SHELL=1` was mounted | look at the boot log for which world mounted | that is issue #51's original symptom; the pipe tier is the default precisely because of it |

## Where the same facts live in machine-readable form

- [`bash-parity.md`](bash-parity.md) — every difference from the host's own `bash`, each row read by
  two gates. The notes above are `field-notes`, `behaviour-terminal-classes`,
  `behaviour-escalated-streams`, `behaviour-overstrike` and `behaviour-no-tty`.
- `scripts/compatibility/bash-session-real.mjs` — the live cells that assert each line appears when it
  should and does not when it should not (49 cells, run on two planes on every `checks` frame).
- The host log: an escalated call emits `wsl-bash: pseudo-terminal for class=… deadline=…ms` at debug
  level. Where that lands depends on the launch tier — `dsh web` and `headless` write it to the process
  stdout a driver holds in a file, and the installed desktop keeps its child's stdout in memory only,
  so on a desktop window this line is readable from a crash file or through whatever log-reading plugin
  is mounted, not from a steady-state log (the host publishes none). The transcript-side lines above are
  the ones that are always available.
