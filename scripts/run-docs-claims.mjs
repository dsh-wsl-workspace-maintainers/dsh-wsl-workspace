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
    // A throw is never a pass: the derivation could not read its subject, which is the one outcome
    // that must not be mistaken for agreement.
    verdict = { ok: false, detail: `could not be evaluated: ${String(error?.message ?? error)}` }
  }
  observations.push({ id: claim.id, declared: claim.debt !== null, ...verdict })
}

const declared = observations.filter(o => o.declared)
const undeclared = observations.filter(o => !o.declared)
const owed = declared.filter(o => !o.ok)
const paid = declared.filter(o => o.ok)
const regressions = undeclared.filter(o => !o.ok)

console.log(`docs-claims: ${observations.length} claim(s) — ${GREEN_CLAIMS.length} must hold, `
  + `${DECLARED_RED_CLAIMS.length} declared red`)
console.log(`  held: ${undeclared.filter(o => o.ok).length}/${undeclared.length}`)

if (regressions.length > 0) {
  console.error(`\nFAILED (${regressions.length}) — a claim that must hold does not:`)
  for (const o of regressions) console.error(`  ✗ ${o.id}\n      ${o.detail}`)
} else {
  console.log('  FAILED: none')
}

if (owed.length > 0) {
  console.log(`\nOWED (${owed.length}) — declared red, still true, and the product still says otherwise:`)
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
    owed: owed.map(o => ({ id: o.id, detail: o.detail })),
    retired: paid.map(o => ({ id: o.id, detail: o.detail })),
  }, null, 2)}\n`, 'utf8')
}

const red = regressions.length > 0 || paid.length > 0
if (red) {
  console.error(`\ndocs-claims: RED — expected 0 regressions and 0 retired declarations, `
    + `saw ${regressions.length} and ${paid.length}`)
} else {
  console.log(`\ndocs-claims: GREEN — ${owed.length} red(s) are exactly the declared ones`)
}
process.exit(red ? 1 : 0)
