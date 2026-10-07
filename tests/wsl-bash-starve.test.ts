// The watchdog's rule, pinned against the readings taken off a real distribution.
//
// Every fixture line below is transcribed from `D:\Temp\issue51-s0\v1c-table.txt` (2026-10-05), where
// the same shapes were measured side by side: a program asleep in a terminal read, `sleep`, a network
// wait, a process working, and `sudo` asking for a password with its `/proc` entries unreadable. The
// point of keeping them here is that the rule must not be tuned until a cell passes — `sleep` looks
// like `sudo` in every column except the two the rule reads.
//
// Run: node --experimental-strip-types --test tests/wsl-bash-starve.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmsTerminalRead, culpritPids, describeRows, parseProbe, probeScript, retryNote, starveNote, starveOf, stopScript, FIRST_PROBE_MS, LOOKS_BEFORE_SLOWING, MIN_WAIT_MS, PROBE_EVERY_MS, PROBE_SLOW_MS, OWN_TERMINAL_WAIT_MS, UNCONFIRMED_WAIT_MS, type StarveSample } from '../src/host/wsl-bash-starve.ts'

/** A sample of one row, as the probe would report it. */
function sample(...lines: string[]): StarveSample {
  return parseProbe(lines.join('\n'), 2_000)
}

const TERMINAL_ROW = 'P 18673 18673 18673 S+ w=wait_woken c=1200,300 tty=1 comm=sh role=desc'
/**
 * What the CI runner on **WSL1** answers for a process that is asleep (frame 37494104075, 2026-10-07,
 * `sleep 3` in a real session): `wchan` and `/proc/<pid>/syscall` both come back **empty**, no terminal
 * appears in the fd table, `ps` gives state `S` without the `+`, and the reported `tpgid` is not the
 * process's own group (whether it answers `-1` or just a different number is what the row's own
 * `no-tpgid` / `bg` spelling will say on the next frame). `ps -o tty=` there does name a terminal
 * (`tty1`), so the read really blocks — the kernel simply does not say where anything is waiting.
 *
 * This is deliberately not a shape the rule acts on: on that kernel a `sleep` and a keyboard read are
 * reported with the same four blanks, and stopping a merely-slow command is the one thing this layer
 * may not do. The row is here so the reporting is tested against the measured text, not a guess —
 * the first version of this fixture assumed `w=0`, which is WSL2's spelling of *another user's* process.
 */
const WSL1_ROW = 'P 9303 9303 1 S w= c=800,200 tty=0 comm=sh role=desc'
const WSL1_SLEEP_ROW = 'P 19091 19091 19090 S w= c=400,100 tty=0 comm=sleep role=desc'
const PRIVILEGED_ROW = 'P 18255 18255 18255 S+ w=0 c=900,200 tty=-1 comm=sudo role=desc'
const SLEEP_ROW = 'P 19091 19091 19091 S+ w=hrtimer_nanosleep c=400,100 tty=0 comm=sleep role=desc'
const NETWORK_ROW = 'P 19479 19479 19479 S w=poll_schedule_timeout.constprop.0 c=600,150 tty=0 comm=curl role=desc'
const RUNNING_ROW = 'P 19299 19299 19299 Rl+ w= c=700,18000 tty=0 comm=dd role=desc'

test('a call that timed out after looks that confirmed nothing says what it read', () => {
  // The note is the only place this becomes visible to the model and to a bug report, and it has to
  // keep three facts apart that an empty field could stand for: the process is running so has no sleep
  // location, the location belongs to someone the reader may not look inside (`0`), or the kernel does
  // not fill the file at all. The third is what the WSL1 runner answers for a process that is plainly
  // asleep, and printing it as the first would be a lie about the one thing this layer exists to know.
  const seen = describeRows(sample(TERMINAL_ROW, SLEEP_ROW))
  assert.ok(seen.includes('sh:S+ w=wait_woken 1tty fg'), `the confirmed wait must be in it: ${seen}`)
  assert.ok(seen.includes('sleep:S+ w=hrtimer_nanosleep 0tty fg'), `so must the innocent one: ${seen}`)
  assert.equal(describeRows(sample(RUNNING_ROW)), 'dd:Rl+ w=running 0tty fg', 'empty with state R is running')
  assert.equal(describeRows(sample(PRIVILEGED_ROW)), 'sudo:S+ w=0 fd-unreadable fg',
    'and `0` is a location this reader may not see')
  const blind = describeRows(sample(WSL1_ROW, WSL1_SLEEP_ROW))
  assert.equal(blind, 'sh:S w=not-reported 0tty bg; sleep:S w=not-reported 0tty bg',
    'the WSL1 shape is reportable even though the rule has nothing to act on')
  // Why the rule cannot act there, in the frame's own words rather than in a platform name: these two
  // rows are what a keyboard read and a `sleep` both report on WSL1, identical in every column.
  assert.equal(starveOf(undefined, sample(WSL1_ROW)), undefined, 'a read cannot be told from a timer')
  assert.equal(starveOf(undefined, sample(WSL1_SLEEP_ROW)), undefined, 'and the rule must not guess')
  assert.equal(describeRows(sample('P not-a-row')), '', 'a pass that reported no rows reports nothing')
  assert.equal(describeRows(undefined), '', 'a pass that never answered is not a reading')
})

test('a kernel that names no foreground job is reported as that, not as a background job', () => {
  // `bg` and `no-tpgid` are different findings: one says the wait is somebody else's foreground job,
  // the other says the kernel would not say. The WSL1 frame left this unresolved (both rows printed
  // `bg` for commands that were foreground), so the two spellings are kept apart to be read off the
  // next frame instead of inferred from a runner.
  assert.equal(describeRows(sample('P 7 7 -1 S w= c=1,1 tty=0 comm=x role=desc')),
    'x:S w=not-reported 0tty no-tpgid')
  assert.equal(describeRows(sample('P 7 7 8 S+ w=wait_woken c=1,1 tty=1 comm=x role=desc')),
    'x:S+ w=wait_woken 1tty bg')
})

test('the readings parse into the fields the rule uses', () => {
  const rows = sample(TERMINAL_ROW, PRIVILEGED_ROW, SLEEP_ROW).rows
  assert.deepEqual(rows.map(row => row.pid), [18673, 18255, 19091])
  assert.deepEqual(rows.map(row => row.wchan), ['wait_woken', '0', 'hrtimer_nanosleep'])
  assert.deepEqual(rows.map(row => row.ttyFds), [1, -1, 0])
  // The transcribed table predates the `sc=` field, and a pass from an older probe must still parse —
  // with the field empty rather than guessed at.
  assert.deepEqual(rows.map(row => row.syscall), ['', '', ''])
  // Both schedstat numbers add up to one comparable count.
  assert.equal(rows[2]?.cpuNs, 500)
})

test('the syscall a process is parked in is read and reported, when the kernel says it', () => {
  // `wchan` names the sleep location and WSL2 leaves it `0` for another user's process; the number is
  // the same fact one layer lower, so it is read as well — on x86-64 `0` is `read`, and a foreground
  // process parked in `read` holding a terminal is exactly the case that has to be tellable from a
  // `sleep`. Measured on the WSL2 runner (frame 37494104075): `sleep` answers `sc=230`, the shell's own
  // wait answers `sc=61`. WSL1 answers nothing in either field, which is the row above.
  const withSc = sample('P 9303 9303 9303 S+ w=0 c=800,200 tty=0 sc=0 comm=sh role=desc').rows
  assert.equal(withSc[0]?.syscall, '0', `the field parses: ${JSON.stringify(withSc[0])}`)
  assert.equal(describeRows(sample('P 9303 9303 9303 S+ w=0 c=800,200 tty=0 sc=35 comm=sleep role=desc'))
    .includes('sleep:S+ w=0 sc=35 0tty fg'), true)
  // Reading it costs one more `cut` per process, and the rule does not act on it yet — asserting the
  // probe asks keeps the silence honest: the field is collected so a WSL1 report says what was there.
  assert.ok(probeScript(42).includes('/proc/$pid/syscall'), 'the probe must collect it, not invent it')
})

test('a line that is not a row is dropped rather than guessed at', () => {
  const rows = sample('DSH_PROBE_DONE', '', 'P 1 1 1 S+', 'garbage', TERMINAL_ROW).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.pid, 18673)
})

test('a process asleep in a terminal read is called what it is', () => {
  assert.equal(starveOf(undefined, sample(TERMINAL_ROW)), 'terminal')
})

test('`sleep` and a network wait are not: the same state, a different sleep location', () => {
  assert.equal(starveOf(undefined, sample(SLEEP_ROW)), undefined)
  assert.equal(starveOf(undefined, sample(NETWORK_ROW)), undefined)
  assert.equal(starveOf(undefined, sample(RUNNING_ROW)), undefined)
})

test('a privileged sleeper whose /proc cannot be read is reported as opaque, never as confirmed', () => {
  assert.equal(starveOf(undefined, sample(PRIVILEGED_ROW)), 'opaque')
})

test('anything gaining CPU rules the answer out, even next to a terminal read', () => {
  const first = sample(TERMINAL_ROW, SLEEP_ROW)
  const second = sample(
    TERMINAL_ROW,
    'P 19091 19091 19091 S+ w=hrtimer_nanosleep c=400,9000 tty=0 comm=sleep role=desc',
  )
  assert.equal(starveOf(first, second), undefined)
})

test('a process that is not the terminal’s foreground job is left alone', () => {
  // pgid 20001 inside a terminal whose foreground group is 18673: another user's job, not this call's.
  assert.equal(starveOf(undefined, sample('P 20001 20001 18673 S+ w=wait_woken c=1,1 tty=1 comm=sh role=desc')), undefined)
})

test('polling a terminal counts as a wait only when this tool is the one that made that terminal', () => {
  const polling = 'P 19999 19999 19999 S w=poll_schedule_timeout.constprop.0 c=700,180 tty=1 comm=vim role=desc'
  // On the ordinary pipe a poll beside a pts is indistinguishable from `ssh` waiting on its socket, so
  // nothing may be stopped for it.
  assert.equal(starveOf(undefined, sample(polling)), undefined)
  // On a pty this call created, the input side is ours and nothing can ever arrive: same reading, but
  // it has to hold the silence for the longer window before that is acted on.
  assert.equal(starveOf(undefined, sample(polling), true), 'own-terminal')
  assert.equal(MIN_WAIT_MS['own-terminal'], OWN_TERMINAL_WAIT_MS)
  assert.equal(MIN_WAIT_MS.opaque, UNCONFIRMED_WAIT_MS)
  // A pty this tool made gets a little more patience than an unconfirmable wait: a program polling its
  // own terminal may be waiting on something else at the same time (`ssh` polls the socket too).
  assert.ok(OWN_TERMINAL_WAIT_MS > UNCONFIRMED_WAIT_MS && OWN_TERMINAL_WAIT_MS <= 3_000, `${OWN_TERMINAL_WAIT_MS}`)
  assert.equal(MIN_WAIT_MS.terminal, FIRST_PROBE_MS)
  // The unconfirmable window is short because it is no longer the only evidence: a root-plane pass
  // answers the same question (see the witness tests below). Eight seconds was the old answer to "we
  // cannot tell", and it was paid by every privileged wait in the product.
  assert.ok(UNCONFIRMED_WAIT_MS <= 2_000, `${UNCONFIRMED_WAIT_MS}ms`)
})

test('the wrapper this tool made for its own pty is not read as a wait', () => {
  // Measured: shortening the own-terminal window to 1.5 s stopped a legitimate silent `sleep 3` run
  // under `tty: true`, because `script` — the wrapper this tool put there — polls the pty it created
  // while its child sleeps. The child is the real waiter, and a timer wait is not a keyboard wait.
  const wrapper = 'P 26455 26455 26455 S+ w=poll_schedule_timeout.constprop.0 c=700,180 tty=1 comm=script role=desc'
  const inner = 'P 26456 26456 26456 S+ w=hrtimer_nanosleep c=700,180 tty=3 comm=sleep role=desc'
  assert.equal(starveOf(undefined, sample(wrapper), true), undefined, 'the wrapper alone is not a finding')
  assert.equal(starveOf(undefined, sample(wrapper, inner), true), undefined, 'nor when its child sleeps on a timer')
  assert.equal(starveOf(undefined, sample(wrapper), false), undefined, 'and never on the plain pipe')
})

test("a builtin reading the terminal is caught on the shell's own row", () => {
  // A real model chose `read -r line < /dev/tty` where this plugin's cells used `sh -c …`: a builtin
  // blocks the shell itself, so there is no child to find. Measured while it happened: the shell row
  // is `Ss+ wchan=wait_woken fd0=/dev/tty` with CPU flat.
  const shell = 'P 12 12 12 Ss+ w=wait_woken c=82120900,3098300 tty=1 comm=bash role=shell'
  assert.equal(starveOf(undefined, sample(shell)), 'terminal')
  // Between commands the same row waits on a pipe, which is not a finding — and it never counts as
  // the weaker readings either, because those are about a command's own process.
  const idle = 'P 12 12 12 Ss+ w=poll_schedule_timeout.constprop.0 c=1,2 tty=0 comm=bash role=shell'
  assert.equal(starveOf(undefined, sample(idle)), undefined)
  assert.equal(starveOf(undefined, sample(idle), true), undefined, 'a shell poll is not an own-terminal wait')
})


test('a stop names the rows that justify it, not the shell that is always in the walk', () => {
  // The sample always contains the shell now; a child blocking on its terminal must not drag the shell
  // into the stop set (measured: it did, and the note then claimed the shell had been restarted).
  const shellRow = 'P 12 12 12 Ss+ w=do_wait c=1,2 tty=0 comm=bash role=shell'
  const childRow = 'P 44 44 44 S+ w=wait_woken c=5,6 tty=1 comm=sh role=desc'
  const both = sample(shellRow, childRow)
  assert.deepEqual(culpritPids(both, 'terminal'), [44], 'only the child')
  const blockedShell = sample('P 12 12 12 Ss+ w=wait_woken c=5,6 tty=1 comm=bash role=shell')
  assert.deepEqual(culpritPids(blockedShell, 'terminal'), [12], 'the shell, when it is the one waiting')
  assert.deepEqual(culpritPids(both, 'terminal').includes(12), false, 'and never the shell for a child')
})

test('the root plane can confirm a read the process hides from its own user, or rule it out', () => {
  // Root reads what sudo hides: the same fields the user plane uses, only reachable.
  assert.equal(confirmsTerminalRead(sample(TERMINAL_ROW)), true)
  // The privileged process is asleep on a timer, not on a terminal — root can see that, and the answer
  // is "do not stop it", which is the whole point of asking.
  assert.equal(confirmsTerminalRead(sample(SLEEP_ROW)), false)
  assert.equal(confirmsTerminalRead(sample(NETWORK_ROW)), false)
  // No witness at all (no root plane on this distribution, or the pass failed): the caller keeps the
  // unconfirmable reading rather than inventing a verdict.
  assert.equal(confirmsTerminalRead(undefined), undefined)
  assert.equal(confirmsTerminalRead(sample('DSH_PROBE_DONE')), undefined)
})

test('no rows means the probe saw nothing, which is not evidence of anything', () => {
  assert.equal(starveOf(undefined, sample('DSH_PROBE_DONE')), undefined)
  assert.equal(starveOf(sample('DSH_PROBE_DONE'), sample('DSH_PROBE_DONE')), undefined)
})

test('the probe walks descendants of the shell it was given and prints a completion sentinel', () => {
  const script = probeScript(1234)
  assert.match(script, /^root=1234/)
  assert.match(script, /pgrep -P \$f/)
  assert.match(script, /\/proc\/\$pid\/wchan/)
  assert.match(script, /\/proc\/\$pid\/schedstat/)
  assert.match(script, /DSH_PROBE_DONE/)
  // The shell's own row is INCLUDED and marked: a builtin that reads the terminal blocks the shell
  // itself, and the walk has to see it (measured: `stat=Ss+ wchan=wait_woken fd0=/dev/tty`).
  assert.match(script, /role=shell/)
  // Counting only `pts/` links was measured to miss a program reading `/dev/tty` — the shell reports
  // that descriptor as `/dev/tty`, not as the pts it resolves to, and the cell died on its deadline.
  assert.match(script, /grep -c -e pts\/ -e \/dev\/tty/)
  // Statement fragments joined with `'; '` produced `do;`, and bash answered exit 2 with nothing on
  // stdout — which the reader would have taken as "nothing is waiting". `done;` and `esac;` are legal
  // (they terminate a compound); `do;` and `then;` are not.
  for (const forbidden of ['do;', 'then;', 'else;']) {
    assert.ok(!script.includes(forbidden), `${forbidden} is a bash syntax error`)
  }
})

test('the stop sequence continues a stopped job before signalling it, and names only the pids it found', () => {
  const script = stopScript([18255, 18256])
  assert.match(script, /kill -CONT \$p 2>\/dev\/null; kill -TERM \$p/)
  assert.match(script, /kill -KILL \$p/)
  assert.match(script, /18255 18256/)
  // CONT must come first: a stopped process ignores TERM until it runs again, measured with `timeout`.
  assert.ok(script.indexOf('-CONT') < script.indexOf('-TERM'))
})

test('the stop refuses to name anything that is not a real pid', () => {
  assert.equal(stopScript([0, 1, -9, Number.NaN]), 'echo DSH_NOTHING_TO_STOP')
})

test('the note names the doors that exist and says which kind of wait was seen', () => {
  const confirmed = starveNote('terminal', 1_600)
  assert.match(confirmed, /tty: true/)
  assert.match(confirmed, /sidebar/)
  assert.match(confirmed, /wait_woken/)
  assert.match(confirmed, /keyboard input nobody is able to type into/, 'a person taking over is the first way out')
  const opaque = starveNote('opaque', UNCONFIRMED_WAIT_MS)
  assert.match(opaque, /no CPU/)
  assert.match(opaque, /unreadable/)
  assert.doesNotMatch(opaque, /wait_woken/, 'an opaque wait must not claim it saw the terminal read')
  const own = starveNote('own-terminal', UNCONFIRMED_WAIT_MS)
  assert.match(own, /pseudo-terminal this call gave it/)
  assert.doesNotMatch(own, /wait_woken/, 'a poll beside a pty was not a bare read')
})

test('the retried sentence says the command ran twice, without claiming what the first attempt did', () => {
  const note = retryNote('terminal', 1_250)
  assert.match(note, /run once more on a pseudo-terminal/)
  assert.match(note, /done twice/, 'the second execution is the cost the caller has to be able to see')
  assert.match(note, /1250ms/)
  assert.match(retryNote('opaque', UNCONFIRMED_WAIT_MS), /unreadable/)
  // It must not promise the first attempt was harmless: it may have written before it reached its
  // prompt, and the tool cannot know.
  assert.doesNotMatch(note, /had no effect|did nothing|without running/)
})

test('the cadence is priced by what a pass costs, and it slows down', () => {
  // Measured 2026-10-05: one pass costs 200-280 ms (a `wsl.exe` of its own), so a faster cadence would
  // only queue probes behind each other, and a long silent call must not be sampled 150 times a minute.
  assert.ok(PROBE_EVERY_MS >= 300, `${PROBE_EVERY_MS}`)
  assert.ok(FIRST_PROBE_MS >= 500, `${FIRST_PROBE_MS}`)
  assert.ok(PROBE_SLOW_MS > PROBE_EVERY_MS, 'the cadence has to slow down, not speed up')
  assert.ok(LOOKS_BEFORE_SLOWING >= 2, 'the fast cadence has to cover more than one look')
  assert.ok(UNCONFIRMED_WAIT_MS > FIRST_PROBE_MS)
})
