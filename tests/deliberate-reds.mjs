/**
 * The deliberate-red ledger — the single machine-readable record of which assertions this repo
 * ships RED on purpose, and on which machine shape each one is red.
 *
 * WHY A LEDGER INSTEAD OF "CI IS ALLOWED TO BE RED"
 *   #46 carries reproductions of issue #44 §6 and of the four tech-debt hazards. They must stay red
 *   to be evidence, but a permanently red frame disarms the one arbiter this project agreed on
 *   (cloud checks green = accepted). So the gate moved from "did the suites pass" to "is the set of
 *   reds exactly the declared set":
 *     - a NEW red (not declared here)          -> run-seams fails  (a real regression is visible)
 *     - a declared red that turned GREEN       -> run-seams fails  (someone fixed the product and
 *                                                    owes this file an edit; the debt cannot be
 *                                                    silently retired, and neither can its proof)
 *     - a red that moved to a shape not declared, or became a skip -> fails too
 *   The assertions themselves are untouched by this: every red still runs and still prints its full
 *   failure text. Only the aggregate verdict changed, and it changed toward stricter, not laxer.
 *
 * `prefix` is matched as a substring of the suite's own `not ok:` / `✖` line, with the node:test
 * duration suffix removed. Keep prefixes long enough to be unique inside their suite.
 */

/** @typedef {'red'|'skip'} Observed */
export const SHAPES = ['win32', 'posix']

/**
 * @type {{id: string, suite: string, prefix: string, skipPrefix?: string, issue: string,
 *   expect: Record<string, Observed>, debt: string, repair: string}[]}
 */
export const DELIBERATE_REDS = [
  // Empty, and that is the point rather than a lapse: every entry this ledger held was a debt with a
  // stated repair, and all ten have now been paid. The mechanism did not go with them — the gate
  // still fails on a NEW red nobody declared, and `tests/deliberate-reds.test.mjs` still exercises
  // every direction against its own synthetic ledger, because a control that reads this array stops
  // covering the gate the moment the last debt is closed.
  //
  // What each entry bought, and where the rule now lives:
  //   - `exists:false` on an unreadable path, NUL-laced details, a byte-counted budget, a classifier
  //     that could not match, a dropped reason, hazards A–E → fixed in the product, and the two shapes
  //     that were only ever measurements of Node and the OS (argv through a shell, a discarded child
  //     sentence) are now assertions about this repository's own call sites in
  //     `tests/tech-debt-exposure.test.ts`. `scripts/check-portable-spelling.mjs` carries the same
  //     shapes for anything those assertions do not cover.
  //   - A new debt is added the same way as ever: an entry here, with both a debt and a repair
  //     direction, before the assertion is allowed to ship red.
]

/** Strip the runner's own decorations so a ledger prefix can match the name. */
export function normalise(line) {
  return String(line ?? '')
    .replace(/^not ok:\s*/, '')
    .replace(/^✖\s*/, '')
    .replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, '')
    .trim()
}

/**
 * Turn raw suite output into the unique names the ledger compares.
 *
 * node:test prints every failing name twice (in the list and again under a bare
 * `✖ failing tests:` header), and that header names no assertion — keeping it would make the gate
 * report an undeclared red on every run of the .ts suite, which is noise about the runner, not about
 * the product.
 *
 * @param {Iterable<string>} lines
 * @returns {{red: string[], skip: string[]}}
 */
export function collectObserved(lines) {
  const red = []
  const skip = []
  const seenRed = new Set()
  const seenSkip = new Set()
  for (const raw of lines) {
    const line = String(raw ?? '').trim()
    const isRed = line.startsWith('not ok:') || line.startsWith('✖ ')
    const isSkip = line.startsWith('SKIP:')
    if (!isRed && !isSkip) continue
    const name = normalise(line)
    if (name === '' || name === 'failing tests:') continue
    if (isRed) {
      if (seenRed.has(name)) continue
      seenRed.add(name)
      red.push(name)
    } else {
      if (seenSkip.has(name)) continue
      seenSkip.add(name)
      skip.push(name)
    }
  }
  return { red, skip }
}

/**
 * Compare what the suites actually produced with what this file declares.
 *
 * @param {string} shape - 'win32' or 'posix'.
 * @param {{red: string[], skip: string[]}} observed - normalised names, already deduplicated.
 * @param {typeof DELIBERATE_REDS} [ledger]
 * @returns {{ok: boolean, shape: string, declared: number, observedRed: number, missing: string[],
 *   extraRed: string[], extraSkip: string[], moved: string[]}}
 */
export function compareLedger(shape, observed, ledger = DELIBERATE_REDS) {
  if (!SHAPES.includes(shape)) throw new Error(`compareLedger: unknown shape ${JSON.stringify(shape)}`)
  const reds = observed.red ?? []
  const skips = observed.skip ?? []
  const missing = []
  const moved = []
  const claimed = new Set()
  const verdicts = []
  for (const entry of ledger) {
    const want = entry.expect[shape]
    if (want === undefined) throw new Error(`ledger entry ${entry.id} declares no expectation for shape ${shape}`)
    const hit = reds.findIndex(name => name.includes(entry.prefix))
    if (hit >= 0) claimed.add(hit)
    if (want === 'red' && hit < 0) {
      // Was it answered as a skip instead? That is a moved premise, not a fixed product.
      const skipHit = entry.skipPrefix !== undefined
        && skips.some(name => name.includes(entry.skipPrefix))
      if (skipHit) moved.push(`${entry.id} (declared red on ${shape}, observed as skip)`)
      else missing.push(`${entry.id} — ${entry.prefix}`)
      verdicts.push(`${entry.id}:${skipHit ? 'moved' : 'MISSING'}≠red`)
      continue
    }
    if (want === 'skip') {
      if (hit >= 0) {
        moved.push(`${entry.id} (declared skip on ${shape}, observed red)`)
        verdicts.push('moved≠skip')
      } else if (!skips.some(name => name.includes(entry.skipPrefix ?? entry.prefix))) {
        missing.push(`${entry.id} — the skip line itself disappeared (premise no longer stated)`)
        verdicts.push('MISSING-skip')
      } else verdicts.push('skip')
      continue
    }
    verdicts.push('red')
  }
  const extraRed = reds.filter((_, index) => !claimed.has(index))
  const declaredSkipPrefixes = ledger.map(e => e.skipPrefix).filter(p => p !== undefined)
  const extraSkip = skips.filter(name => !declaredSkipPrefixes.some(p => name.includes(p)))
  return {
    ok: missing.length === 0 && extraRed.length === 0 && moved.length === 0,
    shape,
    declared: ledger.length,
    observedRed: reds.length,
    missing,
    extraRed,
    extraSkip,
    moved,
  }
}
