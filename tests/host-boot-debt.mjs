/**
 * The host-boot ledger — a **sibling** of `tests/deliberate-reds.mjs`, not an entry in it.
 *
 * Why a sibling: `deliberate-reds.mjs` answers "which reds are expected **on this machine
 * shape**", with two shapes observed on two real machines. This gate runs on the ubuntu runner only
 * and its reds are not machine-dependent — they are the pinned host's own shape. Filing them there
 * would demand a `win32` expectation nobody has ever observed, which is the one thing the
 * bidirectional arithmetic exists to prevent: a declared red that nobody looked at is worse than an
 * undeclared one, because it teaches the reader that reds are negotiable.
 *
 * The arithmetic is the same, and deliberately so: a **new** red fails, a declared red that turned
 * **green** fails (the debt cannot be retired in silence), and a red answered as a skip fails.
 *
 * ## The premise check is the load-bearing part
 *
 * The requirement this file exists to enforce is "no test written *for* a known issue": the system
 * has to be able to find the next one on its own. A rule only people remember is not a rule, so each
 * entry states its invariant as a **`premise`** and this file refuses to load if a premise mentions
 * an issue number or the word "issue". A gate that cannot express the rule cannot enforce it; this
 * one can, and the check is three lines long so there is no excuse not to run it.
 */

import { compareLedger, normalise } from './deliberate-reds.mjs'

/** The shape this gate runs on. Not `win32`: there is no observation to file there. */
export const SHAPE = 'posix'

export const HOST_BOOT_REDS = [
  {
    id: 'a-channel-this-plugin-offers-has-no-reader-in-the-host',
    // Substring-matched against the reported red, so a red that moves or is reworded still lands on
    // the entry that owns it rather than reading as a new, undeclared failure.
    prefix: 'readOutput',
    expect: { posix: 'red' },
    premise: 'every member this plugin hands the host is named by at least one consuming package',
    debt: [
      '`src/host/wsl-jobs.ts` returns `readOutput()` from the job\'s `run()`, and',
      '`@deepseek-ai/dsh-jobs-local` / `dsh-jobs` / `dsh-tool-jobs` at the pinned 0.2.0-rc.2 do not',
      'contain the name `readOutput` at all — zero occurrences, word-boundary counted. What they read',
      'is `spec.output`, a list of pull-sources whose `read(from)` is called on the process\'s',
      'per-stream observed readers. So the member this plugin offers is a channel the host cannot',
      'see, and whatever reads such a job will report it as having produced nothing.',
    ].join(' '),
    repair: [
      'Offer the channel the host reads, not the one it used to: put pull-sources on `spec.output`',
      'over the process\'s per-stream `observed` readers, alongside the existing `readOutput` so the',
      'older registry keeps working. `src/shell.ts` already exposes `process.observed`, and',
      '`@deepseek-ai/dsh-tool-bash` shows the shape the host expects.',
      'Withdrawing this entry is the last step, in the same commit that makes the channel readable —',
      'which is what turns the gate green *for the right reason*.',
    ].join(' '),
  },
]

/**
 * Refuse a ledger that describes itself by reference to a bug report.
 *
 * The rule this whole system is built on is that the properties find defects on their own; a test
 * written *for* a known issue cannot find the next one. Keeping the invariant here, as data, is what
 * makes that rule survive the person who did not read this comment.
 */
export function validateLedger(ledger = HOST_BOOT_REDS) {
  for (const entry of ledger) {
    if (typeof entry.premise !== 'string' || entry.premise.trim() === '') {
      throw new Error(`host-boot-debt: ${entry.id} has no premise. An entry must state the general `
        + 'invariant it stands for, otherwise nobody can tell a real recurrence from a new defect.')
    }
    if (/#[0-9]+/.test(entry.premise) || /\bissue\b/i.test(entry.premise)) {
      throw new Error(`host-boot-debt: ${entry.id}'s premise names a bug ("${entry.premise}"). `
        + 'State it as the invariant it holds for, or the next person cannot tell whether this entry '
        + 'is still the same finding.')
    }
    if (typeof entry.debt !== 'string' || entry.debt.trim().length < 40) {
      throw new Error(`host-boot-debt: ${entry.id} does not say what is owed.`)
    }
    if (typeof entry.repair !== 'string' || entry.repair.trim().length < 40) {
      throw new Error(`host-boot-debt: ${entry.id} does not say how to pay it. A debt nobody owes is `
        + 'a shrug.')
    }
    if (entry.expect?.[SHAPE] !== 'red') {
      throw new Error(`host-boot-debt: ${entry.id} declares expect.${SHAPE} = `
        + `${JSON.stringify(entry.expect?.[SHAPE])}. An entry in this ledger exists to record a red, `
        + 'so anything else is a filing error.')
    }
  }
  return ledger
}

/** Every premise in the ledger, for printing. The reader should be able to audit the rules. */
export function premises(ledger = HOST_BOOT_REDS) {
  return ledger.map(entry => `${entry.id}: ${entry.premise}`)
}

/**
 * Compare what the gate reported against the ledger, with the same arithmetic the seam ledger uses.
 *
 * `observed.red` is a list of substrings rather than test names, because a property here reports a
 * *service or channel*, not a case. `normalise` is applied anyway so a report line that carries a
 * `not ok` prefix still matches its entry — the same tolerance the seam runner has.
 */
export function compareHostBoot(observed, ledger = validateLedger()) {
  return compareLedger(SHAPE, { red: observed.map(normalise), skip: [] }, ledger)
}