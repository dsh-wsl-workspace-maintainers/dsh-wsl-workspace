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

import { parseProbe, probeScript, retryNote, starveNote, starveOf, stopScript, FIRST_PROBE_MS, MIN_WAIT_MS, OPAQUE_WAIT_MS, PROBE_EVERY_MS, type StarveSample } from '../src/host/wsl-bash-starve.ts'

/** A sample of one row, as the probe would report it. */
function sample(...lines: string[]): StarveSample {
  return parseProbe(lines.join('\n'), 2_000)
}

const TERMINAL_ROW = 'P 18673 18673 18673 S+ w=wait_woken c=1200,300 tty=1'
const PRIVILEGED_ROW = 'P 18255 18255 18255 S+ w=0 c=900,200 tty=-1'
const SLEEP_ROW = 'P 19091 19091 19091 S+ w=hrtimer_nanosleep c=400,100 tty=0'
const NETWORK_ROW = 'P 19479 19479 19479 S w=poll_schedule_timeout.constprop.0 c=600,150 tty=0'
const RUNNING_ROW = 'P 19299 19299 19299 Rl+ w= c=700,18000 tty=0'

test('the readings parse into the fields the rule uses', () => {
  const rows = sample(TERMINAL_ROW, PRIVILEGED_ROW, SLEEP_ROW).rows
  assert.deepEqual(rows.map(row => row.pid), [18673, 18255, 19091])
  assert.deepEqual(rows.map(row => row.wchan), ['wait_woken', '0', 'hrtimer_nanosleep'])
  assert.deepEqual(rows.map(row => row.ttyFds), [1, -1, 0])
  // Both schedstat numbers add up to one comparable count.
  assert.equal(rows[2]?.cpuNs, 500)
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
    'P 19091 19091 19091 S+ w=hrtimer_nanosleep c=400,9000 tty=0',
  )
  assert.equal(starveOf(first, second), undefined)
})

test('a process that is not the terminal’s foreground job is left alone', () => {
  // pgid 20001 inside a terminal whose foreground group is 18673: another user's job, not this call's.
  assert.equal(starveOf(undefined, sample('P 20001 20001 18673 S+ w=wait_woken c=1,1 tty=1')), undefined)
})

test('polling a terminal counts as a wait only when this tool is the one that made that terminal', () => {
  const polling = 'P 19999 19999 19999 S w=poll_schedule_timeout.constprop.0 c=700,180 tty=1'
  // On the ordinary pipe a poll beside a pts is indistinguishable from `ssh` waiting on its socket, so
  // nothing may be stopped for it.
  assert.equal(starveOf(undefined, sample(polling)), undefined)
  // On a pty this call created, the input side is ours and nothing can ever arrive: same reading, but
  // it has to hold the silence for the longer window before that is acted on.
  assert.equal(starveOf(undefined, sample(polling), true), 'own-terminal')
  assert.equal(MIN_WAIT_MS['own-terminal'], OPAQUE_WAIT_MS)
  assert.equal(MIN_WAIT_MS.opaque, OPAQUE_WAIT_MS)
  assert.equal(MIN_WAIT_MS.terminal, FIRST_PROBE_MS)
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
  // The shell itself is skipped: its state is "waiting for the next frame", which is not a finding.
  assert.match(script, /\[ "\$pid" = "\$root" \] && continue/)
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
  const opaque = starveNote('opaque', OPAQUE_WAIT_MS)
  assert.match(opaque, /no CPU/)
  assert.match(opaque, /unreadable/)
  assert.doesNotMatch(opaque, /wait_woken/, 'an opaque wait must not claim it saw the terminal read')
  const own = starveNote('own-terminal', OPAQUE_WAIT_MS)
  assert.match(own, /pseudo-terminal this call gave it/)
  assert.doesNotMatch(own, /wait_woken/, 'a poll beside a pty was not a bare read')
})

test('the retried sentence says the command ran twice, without claiming what the first attempt did', () => {
  const note = retryNote('terminal', 1_250)
  assert.match(note, /run once more on a pseudo-terminal/)
  assert.match(note, /done twice/, 'the second execution is the cost the caller has to be able to see')
  assert.match(note, /1250ms/)
  assert.match(retryNote('opaque', OPAQUE_WAIT_MS), /unreadable/)
  // It must not promise the first attempt was harmless: it may have written before it reached its
  // prompt, and the tool cannot know.
  assert.doesNotMatch(note, /had no effect|did nothing|without running/)
})

test('the cadence is inside what the probe costs', () => {
  // Measured 2026-10-05: one pass costs 200-280 ms, so a look can be taken at most about every
  // 500 ms without the watchdog becoming the thing that slows the call down.
  assert.ok(PROBE_EVERY_MS >= 500, `${PROBE_EVERY_MS}`)
  assert.ok(FIRST_PROBE_MS >= 1_000, `${FIRST_PROBE_MS}`)
  assert.ok(OPAQUE_WAIT_MS > FIRST_PROBE_MS)
})
