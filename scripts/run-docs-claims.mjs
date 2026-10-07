// The docs-claims gate: every claim in `tests/parity/claims.mjs`, with the arithmetic that makes a
// declared red safe to ship.
//
//   node scripts/run-docs-claims.mjs
//   node scripts/run-docs-claims.mjs --json out.json
//
// Why this is separate from `tests/parity-claims.test.mjs`. `test:unit` is required to be green in
// CI, so a claim the product has not been changed to satisfy cannot live there. The alternative to
// a second gate is a green `test:unit` and a red claimed somewhere nobody reads, which is how a
// debt stops being evidence and becomes a shrug.
//
// The arithmetic is the one `tests/deliberate-reds.mjs` established for the seam suite, applied to
// documents instead of assertions:
//
//   a claim that is not declared and fails          -> RED   (a regression is visible)
//   a claim that is declared and still fails        -> owed  (printed, with who owes what)
//   a claim that is declared and now passes         -> RED   (the debt was paid and the declaration
//                                                             still claims otherwise; neither the
//                                                             debt nor its proof may be retired in
//                                                             silence)
//   a claim that could not be evaluated at all      -> RED   (a gate that cannot run is not a gate)
//
// Exit code is 0 exactly when there is no unexpected red and no retired declaration.

import { CLAIMS, DECLARED_RED_CLAIMS, GREEN_CLAIMS } from '../tests/parity/claims.mjs'
import { writeFileSync } from 'node:fs'

const jsonFlag = process.argv.indexOf('--json')
const jsonPath = jsonFlag > 0 ? process.argv[jsonFlag + 1] : undefined

const observations = []
for (const claim of CLAIMS) {
  let verdict
  try {
    verdict = await claim.run()
  } catch (error) {
    // A throw is never a pass, and — this is the part that was wrong at first — it is not a
    // "the product still disagrees" either. A declared claim that cannot be evaluated used to land
    // in `owed` and take the gate green with it, so a refactor that moved the very constant a
    // declared red is derived from silenced the only signal that would have said so. Measured, not
    // imagined: aiming `objectBody` at a key that does not exist printed
    // `could not be evaluated: …` and then `docs-claims: GREEN`, exit 0.
    verdict = { ok: false, evaluated: false, detail: `could not be evaluated: ${String(error?.message ?? error)}` }
  }
  observations.push({
    id: claim.id,
    declared: claim.debt !== null,
    evaluated: verdict.evaluated !== false,
    ...verdict,
  })
}

const declared = observations.filter(o => o.declared)
const undeclared = observations.filter(o => !o.declared)
// The fourth state, and the one the header below always promised: a claim that could not be run at
// all. It is not a regression (nothing regressed) and it is not a debt (nobody owes it) — it is a
// gate that did not run, which cannot be allowed to read as agreement.
const unevaluable = observations.filter(o => !o.evaluated)
const owed = declared.filter(o => o.evaluated && !o.ok)
const paid = declared.filter(o => o.evaluated && o.ok)
const regressions = undeclared.filter(o => o.evaluated && !o.ok)

console.log(`docs-claims: ${observations.length} claim(s) — ${GREEN_CLAIMS.length} must hold, `
  + `${DECLARED_RED_CLAIMS.length} declared red`)
console.log(`  held: ${undeclared.filter(o => o.ok).length}/${undeclared.length}`)

if (regressions.length > 0) {
  console.error(`\nFAILED (${regressions.length}) — a claim that must hold does not:`)
  for (const o of regressions) console.error(`  ✗ ${o.id}\n      ${o.detail}`)
} else {
  console.log('  FAILED: none')
}

if (unevaluable.length > 0) {
  console.error(`\nNOT EVALUATED (${unevaluable.length}) — the gate could not read what it claims to `
    + 'check. This is neither a regression nor a debt; it is an unmeasured claim, and it is red '
    + 'because a gate that did not run must not read as agreement:')
  for (const o of unevaluable) console.error(`  ∅ ${o.id}${o.declared ? ' (declared red)' : ''}\n      ${o.detail}`)
}

if (owed.length > 0) {
  console.log(`\nOWED (${owed.length}) — declared red, evaluated, and still true:`)
  for (const o of owed) {
    const claim = DECLARED_RED_CLAIMS.find(c => c.id === o.id)
    console.log(`  ○ ${o.id}`)
    console.log(`      ${o.detail}`)
    console.log(`      owed:   ${claim.debt.owed}`)
    console.log(`      repair: ${claim.debt.repair}`)
  }
}

if (paid.length > 0) {
  console.error(`\nRETIRED (${paid.length}) — declared red that now passes; the product was changed, `
    + 'so remove the declaration from tests/parity/claims.mjs in the same commit:')
  for (const o of paid) console.error(`  ! ${o.id} — ${o.detail}`)
}

if (jsonPath !== undefined && jsonPath !== '') {
  writeFileSync(jsonPath, `${JSON.stringify({
    claims: observations.length,
    mustHold: GREEN_CLAIMS.length,
    declaredRed: DECLARED_RED_CLAIMS.length,
    held: undeclared.filter(o => o.ok).length,
    regressions: regressions.map(o => ({ id: o.id, detail: o.detail })),
    notEvaluated: unevaluable.map(o => ({ id: o.id, detail: o.detail })),
    owed: owed.map(o => ({ id: o.id, detail: o.detail })),
    retired: paid.map(o => ({ id: o.id, detail: o.detail })),
  }, null, 2)}\n`, 'utf8')
}

const red = regressions.length > 0 || paid.length > 0 || unevaluable.length > 0
if (red) {
  console.error(`\ndocs-claims: RED — expected 0 regressions, 0 retired declarations and 0 unevaluated `
    + `claims; saw ${regressions.length}, ${paid.length} and ${unevaluable.length}`)
} else {
  console.log(`\ndocs-claims: GREEN — ${owed.length} red(s) are exactly the declared ones, and every `
    + 'claim was evaluated')
}
process.exit(red ? 1 : 0)
