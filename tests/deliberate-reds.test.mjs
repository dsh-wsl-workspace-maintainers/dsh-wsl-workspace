/**
 * The ledger gate's own controls, offline.
 *
 * A gate that never fails is decoration, so each direction is exercised against synthetic
 * observations — nothing here spawns a suite, which is what makes it runnable in the `test:unit`
 * bucket on any host.
 *
 *   node --test --experimental-strip-types tests/deliberate-reds.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DELIBERATE_REDS, SHAPES, collectObserved, compareLedger, normalise } from './deliberate-reds.mjs'

/**
 * A synthetic ledger, so these controls test the **mechanism** and not the repository's current debt
 * count. They used to read `DELIBERATE_REDS`, which tied the mechanism's coverage to the debt list:
 * every entry retired to close a debt silently retired the controls that prove a green suite is
 * reported. The ids and prefixes are the ones the controls below already name, so the scenarios they
 * drive are unchanged.
 */
const FIXTURE = [
  {
    id: 'nul-sniff-false-positive',
    suite: 'fixture (controls)',
    prefix: 'D: a NUL inside a UTF-8 stream does not flip the decode to UTF-16LE',
    issue: 'fixture',
    expect: { win32: 'red', posix: 'red' },
    debt: 'fixture',
    repair: 'fixture',
  },
  {
    id: 'fold-unreadable-path',
    suite: 'fixture (controls)',
    prefix: 'an unreadable existing path is NOT answered as {exists:false}',
    skipPrefix: 'an unreadable existing path is not reported as absent',
    issue: 'fixture',
    expect: { win32: 'red', posix: 'skip' },
    debt: 'fixture',
    repair: 'fixture',
  },
]

/** What the suites would produce if every declared entry behaved exactly as declared. */
function observedAsDeclared(shape) {
  const red = []
  const skip = []
  for (const entry of FIXTURE) {
    if (entry.expect[shape] === 'red') red.push(entry.prefix)
    else skip.push(entry.skipPrefix ?? entry.prefix)
  }
  return { red, skip }
}

test('the ledger is self-consistent: both shapes declared, prefixes unique inside a suite', () => {
  // The real ledger is allowed to be **empty** — that is what closing every debt looks like — so what
  // is asserted here is that whatever is in it is complete, not that there is something in it.
  const bySuite = new Map()
  for (const entry of DELIBERATE_REDS) {
    assert.deepEqual(Object.keys(entry.expect).sort(), [...SHAPES].sort(),
      `${entry.id} must declare an expectation for every shape, not just the one it was seen on`)
    assert.ok(entry.debt.length > 0 && entry.repair.length > 0,
      `${entry.id} must name both the debt and the repair direction — a red without a stated repair is `
      + 'noise, not a reproduction')
    const prefixes = bySuite.get(entry.suite) ?? []
    assert.ok(!prefixes.some(other => entry.prefix.includes(other) || other.includes(entry.prefix)),
      `${entry.id}: prefix collides with another entry in ${entry.suite}, so a match would be ambiguous`)
    bySuite.set(entry.suite, [...prefixes, entry.prefix])
  }
})

test('POSITIVE CONTROL: the declared set, observed on each shape, passes', () => {
  for (const shape of SHAPES) {
    const report = compareLedger(shape, observedAsDeclared(shape), FIXTURE)
    assert.equal(report.ok, true, `${shape}: the ledger must accept its own declaration: `
      + JSON.stringify(report))
  }
})

test('POSITIVE CONTROL: a new red that nobody declared fails the gate and is named', () => {
  const shape = 'posix'
  const observed = observedAsDeclared(shape)
  observed.red.push('G: a hypothetical regression nobody owned yet')
  const report = compareLedger(shape, observed, FIXTURE)
  assert.equal(report.ok, false, 'an undeclared red must not read as coverage')
  assert.deepEqual(report.extraRed, ['G: a hypothetical regression nobody owned yet'])
})

test('POSITIVE CONTROL: a declared red that quietly turned green fails the gate', () => {
  const shape = 'win32'
  const observed = observedAsDeclared(shape)
  observed.red = observed.red.filter(name => !name.startsWith('D:'))
  const report = compareLedger(shape, observed, FIXTURE)
  assert.equal(report.ok, false, 'a reproduction that stops reproducing must be re-registered, not ` '
      + 'retired silently')
  assert.equal(report.missing.length, 1)
  assert.match(report.missing[0], /nul-sniff-false-positive/)
})

test('POSITIVE CONTROL: a win32-only red appearing on posix is a MOVED premise, not extra noise', () => {
  const observed = observedAsDeclared('posix')
  const fold = FIXTURE.find(entry => entry.id === 'fold-unreadable-path')
  observed.red.push(fold.prefix)
  observed.skip = observed.skip.filter(name => !name.includes(fold.skipPrefix))
  const report = compareLedger('posix', observed, FIXTURE)
  assert.equal(report.ok, false, 'posix is declared to SKIP that one; a red there means the premise '
      + 'changed and the ledger has to say which shape now shows it')
  assert.equal(report.moved.length, 1)
  assert.match(report.moved[0], /fold-unreadable-path/)
})

test('POSITIVE CONTROL: the skip line vanishing is itself a failure', () => {
  const observed = observedAsDeclared('posix')
  observed.skip = []
  const report = compareLedger('posix', observed, FIXTURE)
  assert.equal(report.ok, false, 'a silently green suite and a suite whose premise is unreachable are '
      + 'different answers; the skip line is what records which one happened')
  assert.equal(report.missing.length, 1)
  assert.match(report.missing[0], /skip line itself disappeared/)
})

test('an unknown shape is refused rather than answered as "no reds declared"', () => {
  assert.throws(() => compareLedger('plan9', { red: [], skip: [] }), /unknown shape/)
})

test('normalise strips the runner decorations that would defeat a prefix match', () => {
  assert.equal(normalise('✖ A: spaced path (288.8315ms)'), 'A: spaced path')
  assert.equal(normalise('not ok: utf16le: the detail carries no NUL'),
    'utf16le: the detail carries no NUL')
})

test('collectObserved counts each red once and refuses the runner\'s own summary header', () => {
  // Measured shape of a `node --test` run: every failing name appears twice, and the run closes with
  // a bare `✖ failing tests:` header that names no assertion. Treating that header as a red would
  // make the gate cry wolf on every win32 run.
  const collected = collectObserved([
    '✖ A: a spaced path handed to the shell fallback arrives as one argument (288.83ms)',
    'not ok: utf16le: the detail carries no NUL (found 150 in 300 chars)',
    '✖ A: a spaced path handed to the shell fallback arrives as one argument (288.83ms)',
    '✖ failing tests:',
    '  ✖ B: a failed link must be able to say why it failed (3.13ms)',
    'SKIP: an unreadable existing path is not reported as absent — platform cannot answer it here',
    'ok 3 - something that passed',
  ])
  assert.deepEqual(collected.red, [
    'A: a spaced path handed to the shell fallback arrives as one argument',
    'utf16le: the detail carries no NUL (found 150 in 300 chars)',
    'B: a failed link must be able to say why it failed',
  ])
  assert.equal(collected.skip.length, 1)
  assert.match(collected.skip[0], /an unreadable existing path is not reported as absent/)

  // …and the whole point of the header rule: a run that produced nothing but the header contributes
  // no red, so the gate still reports the declared reds as missing rather than as matched.
  const headerOnly = collectObserved(['✖ failing tests:'])
  assert.deepEqual(headerOnly.red, [])
  const report = compareLedger('win32', headerOnly, FIXTURE)
  assert.equal(report.ok, false)
  assert.equal(report.missing.length, FIXTURE.filter(e => e.expect.win32 === 'red').length)
})
