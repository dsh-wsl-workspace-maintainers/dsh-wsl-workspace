# Is it the pseudo-terminal? A triage sheet for `bash` calls

Every `bash` call in a WSL workspace goes through one of three layers, and each fails in its own
words. This sheet exists so a failure can be pinned to a layer **from the transcript alone**, in one
re-run, without reopening the session wondering where to look.

| the layer | how to recognise it in a body | who owns it |
| --- | --- | --- |
| pipe (default) | no terminal notes at all; `[stderr]` sections present; `tty` prints `not a tty` | `src/host/wsl-bash-session.ts` |
| pseudo-terminal (asked for, or given after a wait was seen) | one of the `[the first attempt was stopped…]`, `[this command was waiting for keyboard input…]`, `[this command was waiting for input on the pseudo-terminal…]`, `[sudo asked for a password…]` lines below | `src/host/wsl-bash-tty.ts` for the pty, `src/host/wsl-bash-starve.ts` for the reading |
| the host's own PTY tier (`DSH_WSL_PTY_SHELL=1`) | `Your command timed out after 300 seconds`, a sentinel line `__DSH_PERSISTENT_BASH_END_…`, `dsh>^C` | the host's `dsh-terminal-bash`, mounted for comparison only |

## Symptom → layer → the one call that settles it

| what you see | whose it is | confirm with | fix |
| --- | --- | --- | --- |
| `[this call ran on a pseudo-terminal (script -qec, one stream): re-run the same command with "tty": false …]` | ours, and it is telling you it does not know either — this is the unforeseen-failure line, and it only appears on a call that ran on a terminal | re-send the identical command with `"tty": false` | if the plain call behaves, the terminal is the layer; if it fails the same way, it is the program and this note is your evidence to look there |
| `[the first attempt was stopped after 1219ms … run once more on a pseudo-terminal … now been done twice — the body below is the second attempt]` | ours, and it is the honest case: the call went silent, the reading said "asleep in the terminal's foreground job", so the wait was ended and the command re-run where it can at least print what it wanted | none — the note quotes the `/proc` field it read | if the doubled execution matters (a command that writes before it prompts), re-send with `"tty": false` and give it a form that answers without a keyboard |
| `[this command was waiting for keyboard input nobody is able to type into this shell: … and a terminal among its descriptors …]` | ours, on a call that **vetoes** the second attempt (`"tty": false`) — the wait was ended so the shell stays usable, and nothing was re-run | `sudo -n true`, or the batch form of the program (`vim -es -c 's/../../g' -c wq file`, `tmux new -d 'cmd'`) | the doors are named in the note: ask for a terminal, or have a person run it in the right sidebar's terminal tab |
| `[this command was waiting for input on the pseudo-terminal this call gave it: after … polling a terminal nothing can type into …]` | ours, on a call that asked for the terminal itself (`"tty": true`) — a full-screen program drew its screen and then waited for keys | none — the program did get a real terminal; it simply has no one on the other end | drive it from a person's terminal tab, or use the batch form; the deadline does not have to be spent to find this out |
| `[sudo asked for a password and this shell has nobody to type it …]` | the distribution's sudoers, not this plugin | `sudo -n true` — it answers in milliseconds either way | **a person can type it**: open the right sidebar's terminal tab (host PTY, not this shell) and run the command once there. To make the agent able to run it alone, give the session user `NOPASSWD` in sudoers or start the session as root (`DSH_WSL_USER`) — note that a per-command `NOPASSWD` grant is real, so a blanket probe is not run and no claim is made about commands other than the one that failed |
| `[the check for a command waiting on a keyboard could not run in this distribution — its /proc walk did not answer …]` | the reading is missing here (no `pgrep`/`ps`, a hardened `/proc` mount), so nothing was stopped early and the call spent its own deadline | `command -v pgrep ps` and `cat /proc/self/wchan` | install `procps` or accept the old behaviour; the tool does not guess in the probe's place |
| `[this exact command has failed N times in this shell …]` | ours, and the command **ran anyway** — this is a sentence, not a refusal | change one thing (a flag, an absolute path, a different tool) and the count is not in the way | if the third attempt is legitimately expected to differ, do it: any success clears every streak |
| `[stderr]` missing although the command wrote to fd 2, or the output interleaves | expected under a terminal: a pty has one stream | re-run with `"tty": false` to get the separation back | nothing to fix; if the separation matters, that call must not be escalated |
| text like `N\bNA\bAM\bME\bE` | escalated output whose overstrike was *not* folded — a regression, since the fold is gated | re-run with `"tty": false`: clean text confirms the layer | report it; `normaliseTtyOutput` in `src/host/wsl-bash-tty.ts` owns the fold and a cell in `bash-session-real` asserts it |
| `not a tty`, or `stty: 'standard input': Inappropriate ioctl for device` | **not** the terminal: that is the ordinary pipe, working as designed. The shell still has a *controlling* terminal — `ps -o tty= -p $$` answers `pts/N` — which is why a read of `/dev/tty` waits here rather than failing | pass `"tty": true` and the same call reports `/dev/pts/N` and `24 80` | only programs that check for a terminal need this |
| `[exit code: N]` | the program's own status | compare with the same command in any shell | nothing is broken; `1` from `false` and `127` from a missing name are the contract |
| `[timed out after Nms]` on `man`, `less`, `gh` | should not happen without being asked: nothing is escalated by name, and a pager on the pipe prints the whole document in milliseconds | check the call: it only happens if it passed `"tty": true` itself | drop `tty: true` |
| escape bytes like `[24;1H` and a body of `~` rows, **without** any terminal note | a full-screen program drew on the pipe and finished without ever blocking on input — the reading acts on a *wait*, not on a screen. A live display normally refuses instead (`top: failed tty get`, exit 1, 687 ms measured) | re-send with `"tty": true`: the same screen arrives folded and with the size set | if it drew and *waited*, the note would be there; if it drew and exited, the fix is the batch form, and a missing note is not a bug |
| a keyboard wait that cost the **whole** deadline | either the probe could not run (the row above), or the program is asleep somewhere the reading does not name — `wchan` symbols differ across kernels, and the rule deliberately does not act on what it cannot see | `ps -o stat=,wchan= -p <pid>` from another terminal, while it is waiting | report it with that reading: a new sleep location is a legitimate finding, not a reason to broaden "quiet means stuck" |
| `[the shell was restarted; not restored: functions (N bytes over the 65536 byte cap)]` | by design — the journal reports what it refused to replay | call `declare -f \| wc -c` to see the size | define what you need again after a restart, or keep functions small; the cap exists because one rc file here holds 61 kB of them |
| `[output truncated; full output: <path>]` | the retention layer's own note, not a failure | `read` that path | nothing; the whole stream is on disk |
| a body containing `__DSH_WSL_BASH`, `eval "$(printf %s`, `{ export -p;` or `#dsh-section` | **a real defect in our frame filter** — these bytes are never meant to be readable | grep the same transcript for them; `bash-session-real` counts bodies carrying any of them | stop and report with the transcript line; this leaked once before and is gated since |
| `Your command timed out after 300 seconds …` + `__DSH_PERSISTENT_BASH_END_…` | the host's PTY tier, i.e. `DSH_WSL_PERSISTENT`/`DSH_WSL_PTY_SHELL=1` was mounted | look at the boot log for which world mounted | that is issue #51's original symptom; the pipe tier is the default precisely because of it |

## Failures that belong to none of the three layers

A WSL workspace inherits whatever the distribution and the machine are. These read like "the plugin's
shell is broken" and are not; each has a one-line confirmation that answers as the session user.

| symptom | what it actually is | confirm with | who can fix it |
| --- | --- | --- | --- |
| `systemctl` fails with `System has not been booted with systemd…` | the distribution has no init of that shape — measured here: `ps -p 1 -o comm=` answers `init(Ubuntu)` | `ps -p 1 -o comm=` | the user, via `[boot] systemd=true` in `/etc/wsl.conf` and a `wsl --shutdown`; not the plugin |
| `git push`, `curl https://github.com`, `gh` fail in **1 ms** with `Connection refused`, while the same command on Windows works | a GitHub accelerator pinned the domains to `127.0.0.1` in the distro's `/etc/hosts` and its proxy is not running | `getent hosts github.com` (answers `127.0.0.1`) and `grep -c '127\.0\.0\.1' /etc/hosts` | the user's proxy tool; the plugin cannot see or fix it |
| `sudo`-class commands always come back "a password is required" | the session user has no `NOPASSWD` grant — a fact about sudoers, not about the terminal | `sudo -n true </dev/null` (exit 1 here, exit 0 on a `NOPASSWD` distribution) | see the sudo row above |
| `man`, `info` answer with `command not found` | the distribution ships without them (common in slim images) | `command -v man` | the user installs it; nothing in this tier is involved |
| a `tty: true` call returns `script: command not found` | the distribution has no `util-linux` `script` — the pseudo-terminal tier cannot exist there | `command -v script` | the user installs `util-linux`; the pipe tier is unaffected and stays the default |

**Not measured, named so.** A distribution without `script`, `Defaults requiretty` in sudoers, nested
wrappers (`bash -c "bash -c 'sudo x'"`), and how `script` propagates exit codes across util-linux
versions are all untested here — the first two would change what the rows above promise.

## Where the same facts live in machine-readable form

- [`bash-parity.md`](bash-parity.md) — every difference from the host's own `bash`, each row read by
  two gates. The notes above are `field-notes`, `behaviour-keyboard-wait`, `behaviour-two-executions`,
  `behaviour-escalated-streams`, `behaviour-overstrike` and `behaviour-no-tty`.
- `scripts/compatibility/bash-session-real.mjs` — the live cells that assert each line appears when it
  should and does not when it should not (55 cells, run on two planes on every `checks` frame). Each
  reactive cell first reads whether *this* distribution gives the session a controlling terminal, and
  says which branch it took: the premise is local, and asserting it as universal is how this file has
  been caught out twice.
- The host log: a stopped wait emits `wsl-bash: stopped a command waiting for input (kind at Nms) and
  re-running it on a pseudo-terminal` at debug level. Where that lands depends on the launch tier —
  `dsh web` and `headless` write it to the process stdout a driver holds in a file, and the installed
  desktop keeps its child's stdout in memory only, so on a desktop window this line is readable from a
  crash file or through whatever log-reading plugin is mounted, not from a steady-state log (the host
  publishes none). The transcript-side lines above are the ones that are always available.
