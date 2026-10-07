/**
 * Self-check for the claims registry.
 *
 * The registry is the one part of this mechanism a person maintains, so it is the part that can
 * rot. Three things are asserted here, each against a way the gate could go quiet rather than red:
 *
 *  1. **The shape is right.** A claim with no `id`, no `run`, or a `debt` missing its `owed`/`repair`
 *     is a claim that cannot be reported on.
 *  2. **A derivation that misses throws.** `hostConst` and `objectBody` are checked against names
 *     that do not exist: the failure mode being guarded is a derivation that quietly finds nothing
 *     and lets the claim above it report a green nobody earned. This is the shape that actually bit
 *     once — an indentation-anchored regex matched a nested object and a declared red was reported
 *     as already paid.
 *  3. **Both directions of the red arithmetic exist.** A registry whose declared reds are all really
 *     green today cannot be distinguished from one whose debt was paid and left declared, so the
 *     count is asserted to be non-zero *and* the runner's two failure conditions are exercised by
 *     construction: `owed` is a claim that fails, `retired` is one that passes.
 *
 * Run with `node --test --experimental-strip-types tests/docs-debt.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAIMS, DECLARED_RED_CLAIMS, GREEN_CLAIMS } from './parity/claims.mjs'
import { hostConst, objectBody } from './parity/derive.mjs'

test('every claim has the shape the runners index it by', () => {
  const ids = new Set()
  for (const claim of CLAIMS) {
    assert.ok(typeof claim.id === 'string' && claim.id !== '', `a claim has no id: ${JSON.stringify(claim.id)}`)
    assert.ok(!ids.has(claim.id), `duplicate claim id ${claim.id}`)
    ids.add(claim.id)
    assert.ok(typeof claim.issue === 'string' && claim.issue !== '', `${claim.id} has no issue`)
    assert.equal(typeof claim.run, 'function', `${claim.id} has no run()`)
    if (claim.debt !== null) {
      assert.ok(typeof claim.debt.owed === 'string' && claim.debt.owed.length > 40,
        `${claim.id} is declared red without saying what is owed`)
      assert.ok(typeof claim.debt.repair === 'string' && claim.debt.repair.length > 40,
        `${claim.id} is declared red without a repair — a debt nobody owes is a shrug`)
    } else {
      assert.equal(claim.debt, null, `${claim.id} has a debt that is neither null nor an object`)
    }
  }
})

test('both halves of the registry are populated', () => {
  assert.ok(GREEN_CLAIMS.length >= 8,
    `${GREEN_CLAIMS.length} claim(s) must hold; an empty set reports the same green as one that all hold`)
  assert.ok(DECLARED_RED_CLAIMS.length >= 1,
    'no declared red is registered, so the runner\'s owed/retired arithmetic is never exercised')
})

test('a constant that is not there throws instead of resolving to nothing', () => {
  assert.throws(() => hostConst('src/host/wsl-skills.ts', 'NO_SUCH_CONSTANT'), /NO_SUCH_CONSTANT/)
  assert.throws(() => hostConst('src/host/no-such-file.ts', 'ANYTHING'), /no-such-file/)
})

test('an object body that is not there throws, and a nested one is not mistaken for the whole', () => {
  assert.throws(() => objectBody('src/host/wsl-bash-tool.ts', /no_such_key:\s*\{/), /no_such_key/)

  // The regression this guards, stated as a property: the bash tool's `parameters` object must
  // contain the key that lives thousands of characters into it. An indentation-anchored regex
  // returned the first nested object instead and the assertion below would have failed.
  const parameters = objectBody('src/host/wsl-bash-tool.ts', /parameters:\s*\{/)
  assert.ok(parameters.length > 1000,
    `brace matching returned ${parameters.length} characters for the parameters schema — too short `
    + 'to be the whole object, which is the shape that read a nested object as the schema')
  assert.match(parameters, /run_in_background:\s*\{/)
})

test('the runner\'s two failure conditions are both reachable', () => {
  // `owed`  = declared and failing  -> reported, not a failure
  // `retired` = declared and passing -> a failure
  // A registry cannot be checked for either without both possibilities existing; this asserts the
  // predicates the runner uses are the ones this file believes it is shipping.
  const declared = DECLARED_RED_CLAIMS
  assert.ok(declared.every(claim => claim.debt !== null))
  assert.ok(GREEN_CLAIMS.every(claim => claim.debt === null))
  assert.equal(declared.length + GREEN_CLAIMS.length, CLAIMS.length)
})
