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
import { CLAIMS, DECLARED_RED_CLAIMS, GREEN_CLAIMS, WATCHED_CONSTANTS } from './parity/claims.mjs'
import { hostConst, objectBody, panelText } from './parity/derive.mjs'
import { zh, en } from '../src/client/locales.ts'

/**
 * Claims whose verdict is about the *absence* of a sentence.
 *
 * Each of these answers "is any sentence making this false claim" — and an absence is satisfied by
 * a document that has lost the paragraph entirely, so deleting the help text would silence exactly
 * the claims that police it. They are listed here rather than inferred because the property is
 * about what the claim *means*, and a test that guessed it from the source text of `run` would be
 * guessing.
 */
const ABSENCE_CLAIMS = [
  'panel-does-not-present-pty-as-the-default-bash',
  'panel-denies-run-in-background',
  'panel-claims-a-ten-second-cache',
]

test('every claim has the shape the runners index it by', () => {
  const ids = new Set()
  for (const claim of CLAIMS) {
    assert.ok(typeof claim.id === 'string' && claim.id !== '', `a claim has no id: ${JSON.stringify(claim.id)}`)
    assert.ok(!ids.has(claim.id), `duplicate claim id ${claim.id}`)
    ids.add(claim.id)
    assert.ok(typeof claim.issue === 'string' && claim.issue !== '', `${claim.id} has no issue`)
    assert.equal(typeof claim.run, 'function', `${claim.id} has no run()`)
    assert.ok(Array.isArray(claim.requires), `${claim.id} has no requires array`)
    for (const anchor of claim.requires) {
      assert.ok(anchor.lang === 'zh' || anchor.lang === 'en', `${claim.id} anchor names lang ${anchor.lang}`)
      assert.ok(anchor.pattern instanceof RegExp, `${claim.id} anchor is not a RegExp`)
      assert.ok(typeof anchor.why === 'string' && anchor.why.length > 10,
        `${claim.id} anchor does not say what sentence it is looking for`)
    }
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

test('a claim that asserts an absence carries the sentence it is about', () => {
  for (const id of ABSENCE_CLAIMS) {
    const claim = CLAIMS.find(entry => entry.id === id)
    assert.ok(claim !== undefined, `${id} is registered as an absence claim but is not in CLAIMS`)
    assert.ok(claim.requires.length > 0,
      `${id} asserts an absence with no anchor, so deleting the paragraph it polices would make it `
      + 'report success about a document that says nothing')
  }
})

test('every anchor matches the panel as it stands', () => {
  // An anchor that does not match today holds its claim red forever. That is the intended verdict,
  // but it is worth failing here too, where the message names the anchor rather than the claim.
  const text = { zh: panelText(zh), en: panelText(en) }
  for (const claim of CLAIMS) {
    for (const anchor of claim.requires) {
      assert.ok(anchor.pattern.test(text[anchor.lang]),
        `${claim.id}: the ${anchor.lang} anchor ${String(anchor.pattern)} does not match the panel — `
        + `it was looking for ${anchor.why}`)
    }
  }
})

test('the completeness half is populated', () => {
  assert.ok(WATCHED_CONSTANTS.length >= 5,
    `${WATCHED_CONSTANTS.length} watched constant(s); the coverage that makes a deleted claim `
    + 'visible is only as wide as this list')
  assert.ok(CLAIMS.some(claim => claim.id === 'every-watched-constant-is-claimed'),
    'no claim covers the watched constants, so deleting one would go unnoticed')
  // Every entry must name a constant that exists, or the coverage claim is asking about a ghost.
  for (const [file, name] of WATCHED_CONSTANTS) {
    assert.ok(Number.isInteger(hostConst(file, name)), `${file}#${name} did not derive to a number`)
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

test('the four outcomes a claim can have are all reachable from this registry', async () => {
  // An earlier version of this file asserted `declared.every(c => c.debt !== null)` and
  // `GREEN_CLAIMS.every(c => c.debt === null)` and `declared.length + GREEN.length === CLAIMS.length`.
  // All three hold for *any* `CLAIMS` array, because those two exports are filters of it — a test
  // that cannot fail is worse than no test, since it reads as coverage. What actually makes the
  // outcomes reachable is that a real debt exists and is really failing, so that is what is checked:
  // evaluating every declared red here must either fail (the debt is still owed) or throw (the gate
  // cannot read its subject). Both are non-green; neither is silently green.
  assert.ok(DECLARED_RED_CLAIMS.length >= 1, 'no declared red exists, so `owed` and `retired` are unreachable')
  for (const claim of DECLARED_RED_CLAIMS) {
    let verdict
    try {
      verdict = await claim.run()
    } catch (error) {
      // Throwing is the fourth state and the runner reports it as its own red; here it only has to
      // be distinguished from "passes", which is the mistake that let a broken derivation report
      // GREEN while printing `could not be evaluated`.
      assert.fail(`declared red ${claim.id} threw rather than being evaluated: ${error?.message ?? error}`)
    }
    assert.equal(verdict.ok, false,
      `declared red ${claim.id} evaluated as passing — the debt was paid, so remove its declaration `
      + 'from tests/parity/claims.mjs in the same commit')
  }
})
