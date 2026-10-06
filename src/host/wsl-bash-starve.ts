/**
 * Telling "this command is waiting for a keyboard" from "this command is working", by looking.
 *
 * The session gives a command pipes for stdin and a terminal it can see but nobody can type into
 * (measured 2026-10-05: the shell's `ps -o tty=` is `pts/1` and `$-` is `himBs`, so a job-control
 * foreground job exists — its reads of `/dev/tty` simply never return). Until now the tool decided
 * which commands that would happen to by matching their *names* against three lists, which cost two
 * real defects in one day (`ssh-copy-id` never matched because the scan stopped at a hyphen;
 * `printf x; vim note.txt` burnt 121 703 ms because only the first word was read) and costs a review
 * every time a distribution changes. This module replaces that prediction with a reading taken from
 * outside the shell while the call is in flight.
 *
 * What was measured, and what the rule is built from (`D:\Temp\issue51-s0\v1c-table.txt` and
 * `v5-run.txt`, 2026-10-05, read off the production session):
 *
 * | the command is… | state | `/proc/<pid>/wchan` | a terminal in its fds | acted on |
 * |---|---|---|---|---|
 * | `sh -c 'read x < /dev/tty'` | `S+`, its pgid is the terminal's foreground one | `wait_woken` | yes — reported as `/dev/tty`, not `pts/N` | `terminal`, at 0.6 s |
 * | `sleep 3` on a pty this tool made | `S+` | `hrtimer_nanosleep` | yes | never: the fds match and the wait does not |
 * | `curl` waiting on a host | `S` | `poll_schedule_timeout` | no | never |
 * | `dd` / `tar` working | `Rl+`, or its CPU advances | — | no | never |
 * | `sudo` asking for a password | `S+` | unreadable | unreadable — it clears its dumpable flag | `opaque`, at 1.5 s, unless the root-plane witness answers first |
 * | `vim` on a pty this tool made | `S+` | `poll_schedule_timeout` | yes | `own-terminal`, at 2.5 s |
 *
 * Two rows are why this is three kinds rather than one test: `sleep` looks exactly like `sudo` in every
 * column a same-user reader can see, and a poll beside a terminal is only evidence when this tool is the
 * one that created that terminal. The fd count has to match `/dev/tty` as well as `pts/` — the first
 * version matched only `pts/`, and `read x < /dev/tty` looked like nothing at all.
 *
 * The probe costs 200–280 ms measured on this machine, which is why the caller looks first at 600 ms of
 * silence, then at most every 400 ms for the first few looks and every 2 s after that.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-starve
 */

/** One line of the probe's output, as read off the distribution. */
export interface StarveRow {
  /** Process id. */
  pid: number
  /** Process group id. */
  pgid: number
  /** The id of the terminal's foreground process group, or `-1` with no terminal. */
  tpgid: number
  /** `ps`-style state, e.g. `S+`, `Rl+`, `T`. */
  state: string
  /** Kernel jiffies of user+system time (`/proc/<pid>/schedstat`, nanoseconds, divided). */
  cpuNs: number
  /** `/proc/<pid>/wchan`; `0` on Linux means "not readable from here". */
  wchan: string
  /** How many of its fds point at a pts, or `-1` when its fd table is not readable at all. */
  ttyFds: number
  /** `comm`, the executable's short name — used only to skip this tool's own wrapper, never to guess. */
  comm: string
}

/** What one probe pass collected. */
export interface StarveSample {
  /** Milliseconds since the call started. */
  atMs: number
  /** Every process under the session shell, the shell itself excluded. */
  rows: StarveRow[]
}

/**
 * The three things a silent call can turn out to be waiting for.
 *
 * `terminal` is read directly off `/proc` and acts quickly; `own-terminal` and `opaque` are shapes that
 * cannot be told apart from a legitimate wait (a program polling its terminal while also waiting on a
 * socket; a process running with privileges this user may not read inside), so they earn the long
 * window before anything is stopped.
 */
export type StarveKind = 'terminal' | 'own-terminal' | 'opaque'

/** How long a call may be silent before the first look, and how often to look after that. */
export const FIRST_PROBE_MS = 600
export const PROBE_EVERY_MS = 400

/**
 * The cadence to drop to once a wait has lasted a few looks.
 *
 * A pass costs 200–280 ms of a `wsl.exe` process, so a command that is silent for a minute must not be
 * sampled 150 times: the first looks decide quickly, and after {@link LOOKS_BEFORE_SLOWING} the reader
 * settles to this. Both numbers are above the measured cost of one pass, because a cadence faster than
 * the probe is just queueing probes.
 */
export const LOOKS_BEFORE_SLOWING = 6
export const PROBE_SLOW_MS = 2_000

/**
 * How long the two readings that a legitimate long wait can also produce have to hold before the tool
 * acts on them.
 *
 * This used to be eight seconds, on the argument that an unconfirmable wait could be a privileged
 * process talking to a network. That argument was answered by measuring instead of waiting: a probe run
 * through the root plane can read what the process's own owner cannot, so the question "sleeping or
 * waiting for a password" gets an answer rather than a longer silence (see `confirmsTerminalRead`).
 * What is left here is the window for the case where even that plane is unavailable, and it is sized by
 * the observation that a program which has produced no bytes *and* burned no CPU for a second and a half
 * is not making progress whatever it is doing.
 */
export const UNCONFIRMED_WAIT_MS = 1_500

/**
 * The window for a program that polls a terminal this tool created for it (`tty: true`, or the re-run).
 *
 * Longer than {@link UNCONFIRMED_WAIT_MS} on purpose: a program polling its own pty may legitimately be
 * waiting on something else at the same time — `ssh` polls the terminal *and* its socket — so this is
 * the one reading where a second of patience buys real precision. It is still a third of the eight
 * seconds the old design spent on every keyboard wait, and it is only ever paid by a call that asked for
 * a terminal.
 */
export const OWN_TERMINAL_WAIT_MS = 2_500

/** The shortest silence each kind of reading has to hold before the tool acts on it. */
export const MIN_WAIT_MS: Record<StarveKind, number> = {
  terminal: FIRST_PROBE_MS,
  'own-terminal': OWN_TERMINAL_WAIT_MS,
  opaque: UNCONFIRMED_WAIT_MS,
}

/**
 * The shell text the probe runs, as a sibling `wsl.exe` call.
 *
 * One argv element, so it is written as a single line with every separator explicit: joining statement
 * fragments with `'; '` produced `do;`, which bash rejects with exit 2 (measured) — and a probe that
 * never runs looks exactly like a command that is not waiting for anything. The walk is `pgrep -P`
 * eight levels down from the session shell; the shell itself is skipped, because its own state is
 * "waiting for the next frame", which is not a finding.
 */
/**
 * Printed last so a pass that died half-way is recognisable as *not having answered*. A probe that
 * never runs looks exactly like a command that is not waiting for anything, which is the failure this
 * whole layer must not have.
 */
export const PROBE_DONE_SENTINEL = 'DSH_PROBE_DONE'

/**
 * Build the probe's shell text.
 * @param rootPid - the session shell's pid, the root of the walk.
 * @returns one line of bash to hand to `bash -c`.
 */
export function probeScript(rootPid: number): string {
  return `root=${rootPid}; keep=$root; front=$root; depth=0; `
    + 'while [ $depth -lt 8 ]; do next=; '
    + 'for f in $front; do for x in $(pgrep -P $f 2>/dev/null); do next="$next $x"; done; done; '
    + `case $next in '') break ;; esac; keep="$keep $next"; front=$next; depth=$((depth+1)); `
    + 'done; '
    + 'for pid in $keep; do '
    + `[ "$pid" = "$root" ] && continue; [ -r /proc/$pid/stat ] || continue; `
    + 'set -- $(ps -o pid=,pgid=,tpgid=,stat=,comm= -p $pid); '
    + 'wchan=$(cat /proc/$pid/wchan 2>/dev/null); '
    + `cpu=$(cut -d' ' -f1,2 /proc/$pid/schedstat 2>/dev/null | tr ' ' ','); `
    + `if ls /proc/$pid/fd >/dev/null 2>&1; then ttys=$(ls -l /proc/$pid/fd 2>/dev/null | grep -c -e pts/ -e /dev/tty); else ttys=-1; fi; `
    + `echo "P $1 $2 $3 $4 w=$wchan c=$cpu tty=$ttys comm=$5"; `
    + `done; echo ${PROBE_DONE_SENTINEL}`
}

/**
 * Parse one probe pass.
 * @param text - the probe's stdout, whole lines of `P <pid> <pgid> <tpgid> <state> w=… c=<utime>,<stime> tty=…`.
 * @param atMs - when the pass was taken, for the note.
 * @returns the rows it reported; a line that does not match is dropped rather than guessed at.
 */
export function parseProbe(text: string, atMs: number): StarveSample {
  const rows: StarveRow[] = []
  const field = (groups: RegExpExecArray, index: number): string => groups[index] ?? ''
  for (const line of text.split(/\r?\n/)) {
    const match = /^P (\d+) (\d+) (-?\d+) (\S+) w=(\S*) c=([\d,]*) tty=(-?\d+) comm=(.*)$/.exec(line.trim())
    if (match === null) continue
    const [utime = '0', stime = '0'] = field(match, 6).split(',')
    rows.push({
      pid: Number(field(match, 1)),
      pgid: Number(field(match, 2)),
      tpgid: Number(field(match, 3)),
      state: field(match, 4),
      cpuNs: Number(utime) + Number(stime),
      // `0` is what Linux prints for a sleep location this user may not read; an empty field means the
      // process was running. Both matter to the rule, so the empty case is kept as its own value.
      wchan: field(match, 5) === '' ? 'running' : field(match, 5),
      ttyFds: Number(field(match, 7)),
      comm: field(match, 8),
    })
  }
  return { atMs, rows }
}

/**
 * Whether the processes under the shell are waiting for something no one can give them.
 *
 * A process consuming CPU rules the answer out whatever else it looks like: that is the difference
 * between this and a deadline, and the reason a long build is never stopped early.
 * @param previous - the sample before this one, or undefined for the first look.
 * @param current - the sample just taken.
 * @param ownTerminal - true when this call was given a pseudo-terminal of its own (`tty: true`, or the
 *   re-run after a previous stop). A program on that terminal may wait in `poll` beside it rather than
 *   in a bare `read`, and the input side of that pty is ours — so a poll there can be named as
 *   unsatisfiable, though not as cheaply as a `read`: it gets the longer window. Pass false (the
 *   default) for an ordinary pipe call, where `poll_schedule_timeout` is indistinguishable from waiting
 *   on a socket and must not be stopped.
 * @returns which of the three readings the samples support, or undefined when anything is still moving.
 */
export function starveOf(previous: StarveSample | undefined, current: StarveSample,
  ownTerminal = false): StarveKind | undefined {
  if (current.rows.length === 0) return undefined
  for (const row of current.rows) {
    const before = previous?.rows.find(candidate => candidate.pid === row.pid)
    if (before !== undefined && row.cpuNs > before.cpuNs) return undefined
    if (row.state.startsWith('R')) return undefined
  }
  let weaker: StarveKind | undefined
  for (const row of current.rows) {
    if (!row.state.startsWith('S') && !row.state.startsWith('T')) continue
    // The wrapper this tool puts around a command for its own pty sits in a poll of its own while its
    // child runs — measured: a `sleep 3` inside `script` was stopped at 1.5 s because the wrapper's poll
    // looked like a keyboard wait. Skipping it is skipping our own process, not guessing the user's: no
    // other entry in this walk is matched by name.
    if (ownTerminal && row.comm === 'script') continue
    const isForegroundJob = row.tpgid >= 0 && row.pgid === row.tpgid
    if (!isForegroundJob) continue
    if (row.ttyFds > 0 && row.wchan === 'wait_woken') return 'terminal'
    if (ownTerminal && row.ttyFds > 0
      && (row.wchan === 'poll_schedule_timeout' || row.wchan === 'poll_schedule_timeout.constprop.0'
        || row.wchan === 'do_epoll_wait' || row.wchan === 'ep_poll')) weaker = 'own-terminal'
    if (row.wchan === '0' && row.ttyFds < 0) weaker = 'opaque'
  }
  return weaker
}

/**
 * The shell text that stops a wedged foreground job and nothing else.
 *
 * A stopped process ignores `SIGTERM` until it is continued — measured, `timeout` could not remove a
 * `sudo` sitting on its prompt — so `SIGCONT` goes first. Only the pids the probe just reported are
 * named; no pattern is matched against a command line, because a pattern would also hit whatever the
 * user is running in another terminal.
 * @param pids - the processes to stop, in the order the probe found them.
 * @returns shell text to run as the session's user.
 */
export function stopScript(pids: readonly number[]): string {
  const list = pids.filter(pid => Number.isInteger(pid) && pid > 1).join(' ')
  if (list === '') return 'echo DSH_NOTHING_TO_STOP'
  return `for p in ${list}; do kill -CONT $p 2>/dev/null; kill -TERM $p 2>/dev/null; done; `
    + `sleep 0.3; for p in ${list}; do kill -KILL $p 2>/dev/null; done; echo DSH_STOPPED ${list}`
}

/**
 * The sentence that says a command ran twice, and why.
 *
 * The second attempt is what makes the answer useful, and it is also a second execution: a command that
 * had already written a file or posted a request before it reached its prompt did that once, and does it
 * again now. Silence here would be the same defect as running a timed-out command twice without saying
 * so, which is measured history (`echo run >> f` landing twice, 2026-10-04).
 * @param kind - what the first attempt was found to be waiting for.
 * @param atMs - how long the first attempt had been silent when it was stopped.
 * @returns the note to put in the body of the retried call.
 */
export function retryNote(kind: StarveKind, atMs: number, viaRoot = false): string {
  const why = kind === 'opaque'
    ? 'no output and no CPU, with its `/proc` entries unreadable (it runs with privileges this tool cannot see inside)'
    : viaRoot
      ? 'no output and no CPU, asleep in the terminal\'s foreground job — read through the distribution\'s root rights, because this process hides its own `/proc` entries from its user'
      : 'no output and no CPU, asleep in the terminal\'s foreground job with a terminal among its descriptors'
  return `[the first attempt was stopped after ${atMs}ms because it was waiting for keyboard input this shell cannot supply (${why}). The command was then run once more on a pseudo-terminal of its own, so anything it had already done before that prompt has now been done twice — the body below is the second attempt]`
}

/**
 * Whether a reading taken through the root plane confirms a terminal read, or rules it out.
 *
 * This is what replaces waiting eight seconds to be sure. A privileged program hides its `/proc` entries
 * from its own owner (sudo clears its dumpable flag), so the user plane can only ever call such a wait
 * *unconfirmable* — but a probe run as root reads `wchan`, the `syscall` and the fd table of those
 * processes, which is the same evidence the confirmed reading uses. Three answers matter:
 * `confirmed` (a terminal read is really there), `ruled-out` (the root plane read the wait and it is
 * something else — a timer, a socket), and undefined (no root plane answered, so the caller keeps the
 * unconfirmable reading and its own window).
 * @param witness - the rows one root-plane pass reported, or undefined when the pass did not answer.
 * @returns whether the root plane confirms a terminal read, rules it out, or could not say.
 */
export function confirmsTerminalRead(witness: StarveSample | undefined): boolean | undefined {
  if (witness === undefined || witness.rows.length === 0) return undefined
  return starveOf(undefined, witness, false) === 'terminal'
}

/**
 * The sentence that tells the model what was seen, and what it can do about it.
 *
 * Each kind says the reading it actually had — the confirmed one names `/proc`, the unconfirmable ones
 * say they could not be confirmed — because the note is what a caller uses to decide whether to re-run
 * with a longer deadline, ask for a terminal, or hand the prompt to a person.
 * @param kind - which of the three readings the probe returned.
 * @param atMs - how long the call had been silent when it was stopped.
 * @param viaRoot - true when the terminal read was confirmed through the root plane rather than read
 *   directly, which happens for a privileged program whose own `/proc` entries are hidden.
 * @returns the note to put in the body.
 */
export function starveNote(kind: StarveKind, atMs: number, viaRoot = false): string {
  const doors = 'run it with `tty: true` to give it a terminal, or ask a person to run it in the right sidebar\'s terminal tab, where a keyboard is attached'
  if (kind === 'terminal') {
    const how = viaRoot
      ? 'a probe with the distribution\'s root rights read the wait this process hides from its own user (`/proc/<pid>/wchan` = `wait_woken`, a terminal among its descriptors)'
      : 'it was asleep in the terminal\'s foreground job with `/proc/<pid>/wchan` = `wait_woken` and a terminal among its descriptors'
    return `[this command was waiting for keyboard input nobody is able to type into this shell: ${how}. It was stopped so the shell stays usable — ${doors}]`
  }
  if (kind === 'own-terminal') {
    return `[this command was waiting for input on the pseudo-terminal this call gave it: after ${atMs}ms it was still asleep in that terminal's foreground job, polling a terminal nothing can type into, with no output and no CPU. It was stopped so the shell stays usable — ${doors}]`
  }
  return `[this command was waiting for input this shell cannot supply: it had produced no bytes and used no CPU for ${atMs}ms, and it runs with privileges this tool cannot read inside (\`/proc/<pid>/wchan\` unreadable), so the wait could not be confirmed. It was stopped so the shell stays usable — ${doors}]`
}
