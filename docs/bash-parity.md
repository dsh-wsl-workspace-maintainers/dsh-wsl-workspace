# How this `bash` differs from the one DSH mounts by default

Every row here is a difference between the session `bash` this plugin mounts
(`src/host/wsl-bash-tool.ts`) and the host's own `bash` tool, **and each row is read by code**:

- `tests/wsl-bash-parity.test.ts` compares the two tools' declared surfaces (parameter keys, the
  output arms, the foreground field names) against the installed host package, and requires every
  difference it finds to be a row here whose kind is `api`. Delete a row and it goes red; add a
  parameter without a row and it goes red.
- `scripts/compatibility/bash-parity-real.mjs` runs one probe script against both tools on a real
  distribution and compares the answers field by field, requiring every behavioural difference to be
  a row here whose kind is `behaviour`.

A row that stops being true is a failure, not a cleanup: that is the point of keeping this in a table
the gates parse instead of in prose someone might read.

| id | kind | difference | whose behaviour | what the user sees | verdict |
| --- | --- | --- | --- | --- | --- |
| `param-tty` | `api` | we accept `tty`, the host's tool does not | ours | nothing, unless the model passes it: `true` forces a pseudo-terminal, `false` refuses one the rule would otherwise give | keep: the pseudo-terminal escalation has no other door, and a parameter that could only be turned on was measured leaving `man ls` with no way back to the plain pipe |
| `behaviour-escalated-streams` | `behaviour` | an escalated call arrives as one stream: a pseudo-terminal has no second channel, so `[stderr]` never appears in its body | mechanism — the same is true of the host's own PTY tier | `echo out; echo err >&2` reads `out err` escalated, `out [stderr] err` on the plain path | keep: this is what a terminal is. Asserting a separation there would mean faking one the program never wrote |
| `behaviour-overstrike` | `behaviour` | a program that cannot colour its terminal writes emphasis as overstrike (`man` on a pty), and the pty tier folds it back before the model reads it | ours | `N\bNA\bAM\bME\bE` becomes `NAME`; measured on this distribution's `man` | keep: unfolded, the body was unreadable — but the fold covers the two shapes actually measured, and a dangling backspace overwrites left as a terminal would |
| `param-run_in_background` | `api` | both accept `run_in_background`, ours returns the same `{kind:'background',jobId}` | aligned | `started background job <id>` in both | aligned 2026-10-05 |
| `field-notes` | `api` | our foreground result carries a `notes` array the host's does not | ours | extra bracketed lines in the body (`[the shell was restarted; …]`) | keep: a restart the model cannot see is a silent path |
| `param-sandbox_permissions` | `api` | the host accepts `sandbox_permissions` (declared only where its sandbox escalation modes exist); we do not | host | a WSL command runs inside the distribution, outside the DSH file policy | keep: there is no wider access to ask for |
| `param-justification` | `api` | the host accepts `justification`, paired with its `sandbox_permissions`; we do not | host | nothing | keep: it has no referent without the parameter above |
| `field-signal-unused` | `api` | both declare `signal`; neither ever fills it | both | `[killed by signal: N]` never appears in either world | keep as-is: filling it alone would *widen* the gap |
| `field-stopped` | `api` | the host's foreground arm carries a `stopped` string we do not declare | host | nothing today: the session tier has no stop-then-report path | keep: declared when a call can be stopped and still report, not before |
| `field-sandbox` | `api` | the host's foreground arm carries a `sandbox` block we do not declare | host | the WSL world runs commands inside the distribution, outside the DSH file policy | keep: the world declares `enforcement: 'partial'` for the same reason |
| `behaviour-signal-exit` | `behaviour` | a command killed by a signal reports bash's own `128+N` here, and the raw code in the host's one-shot path | both | `[exit code: 137]` here vs `[exit code: 9]` there | keep: measured on 2026-10-04 (`bash -c "kill -9 $$"`), and 128+N is what a person at a prompt would see |
| `behaviour-timeout` | `behaviour` | the host's tool promotes a command that exceeds its deadline into a background job (`promoteOnTimeout`, default true); ours stops it and restarts the shell | ours, by decision | `[timed out after Nms]` plus a line saying the shell was restarted and to use `run_in_background` | keep: promotion needs the shell to hold two frames at once, which is the one-frame contract this protocol rests on |
| `behaviour-background-process` | `behaviour` | a backgrounded call runs in its own process, not in the session shell | ours | the job does not see a `cd` or `export` made by an earlier `bash` call | keep: it is the same producer `bash_background` uses, and the tool description says so |
| `behaviour-prompt-empty` | `behaviour` | `PS1` is cleared by the bootstrap | ours | `echo "[$PS1]"` prints `[]` | keep: prompt bytes on the wire are what hung issue #51 |
| `behaviour-no-tty` | `behaviour` | a command has no controlling terminal unless escalated | mechanism | `tty` prints `not a tty`, `stty size` prints `0 0`; `sudo`/`ssh`/editors are escalated automatically, and one layer of a `bash -c` wrapper is read so `bash -c 'sudo true'` is not left on the pipe | keep: measured, and a human typing a password into an agent's shell is not a case either tool serves |
| `behaviour-terminal-classes` | `behaviour` | a terminal is given by class, not by a single rule: credential commands always (full deadline), editors and multiplexers always but bounded to 8 s when the call named no deadline, pagers and reports never automatically — only on `tty: true` | ours, by decision | `sudo`/`ssh` answer with a prompt in milliseconds; `vim` waiting for keys is stopped at 8 s and the body says what to use instead; `man ls` prints the whole page in ~180 ms where escalating it measured 743 ms into a pager that waits forever | keep: two minutes of default deadline on a wait that can never be satisfied is the most expensive thing this tool can do to an agent, and the pipe answers the pager class better |
| `behaviour-history` | `behaviour` | `history`/`fc` see the session's own list, not a user's terminal's | mechanism | `history` numbers restart per session | keep, unmeasured beyond `set +H`: no cell asserts it yet |
| `behaviour-long-frame-latency` | `behaviour` | a command's text travels as one line, and the pipe's cost grows with it | mechanism | a 64 kB command answers in ~3.8 s, a 256 kB one in ~59 s (measured 2026-10-05) | keep, recorded: no truncation was found at any size tested, and ordinary commands are under 1 kB |
| `behaviour-spill-shape` | `behaviour` | overflow spills to `tmpdir()/dsh-subprocess-*` and says `[output truncated; full output: <path>]` | aligned | the same sentence and the same file shape as the one-shot path | aligned 2026-10-05, verified by line count in the file |
| `behaviour-workdir-relative` | `behaviour` | a relative `workdir` resolves against the session directory | aligned | bash's own `cd: …: No such file or directory` when it does not exist | aligned 2026-10-05 with the host's `resolveWorkdir` |
| `behaviour-workdir-missing-layer` | `behaviour` | when the directory does not exist, the host's one-shot path fails in `wsl.exe` (`chdir(...) failed 2`) because it passes `--cd`; ours fails in bash, because the session is already running and the call wraps a `cd` | ours | both non-zero; the sentence names a different layer | keep: one shell for the whole session has no `--cd` to fail in |
| `behaviour-command-not-found` | `behaviour` | a name bash cannot find is reported by the distribution's command-not-found handler here, and by bash itself in the host's one-shot path. Failing to find it is **bash's own rule in both worlds** — an alias used on the line that defines it is not yet an alias, measured against `bash -ic` on this distribution — so only the sentence differs | ours, from sourcing the rc files | `dshparity: command not found, did you mean: …` here vs `bash: line 1: dshparity: command not found` there; exit 127 in both | keep: the rc files are what buy aliases and functions, and the same-line rule is not ours to change |
| `behaviour-interactive-flags` | `behaviour` | `$-` is `himBs` here and `hBc` in the host's one-shot path | ours, on purpose | `echo $-` differs; `shopt`/alias/function behaviour follows | keep: interactive mode is what makes rc aliases and shell functions work, which is the point of a persistent shell |
| `behaviour-state-persistence` | `behaviour` | `cd`, `export`, aliases, options and functions survive between calls here and do not survive between the host's one-shot calls | ours, on purpose | `export X=1` then `echo $X` answers `1` here and `unset` there | keep: this is the feature issue #51 was about keeping |
| `behaviour-description-required` | `behaviour` | `description` is required | aligned | both reject a call without it: `missing required property "description"` | aligned: the host's own tool requires it (`dsh-tool-bash/lib/index.js:496-499`) |

## What is *not* a difference

`cd`, exported variables, aliases, shell options and functions survive between calls here and do not
survive between the host's one-shot calls — that is the feature, and the host's PTY-backed persistent
tool was the only other way to get it. It is the tool issue #51 was filed against: it decides a
command has finished by matching a sentinel line in terminal text and requiring the exit code to be
followed immediately by a newline, and an interactive Linux shell repaints that line. The session
tier replaces it with a record on a byte channel; `DSH_WSL_PTY_SHELL=1` still mounts the old tier for
comparison, and `scripts/compatibility/bash-session-real.mjs` keeps it as a control cell so the
replaced behaviour cannot quietly come back.
