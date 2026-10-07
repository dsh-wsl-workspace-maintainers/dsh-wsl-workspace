/**
 * Assertion primitives for the parity gate.
 *
 * The one that matters is {@link statesNumber}. A number that appears in the panel and again as a
 * constant in `src/host` is a number that can disagree with itself, and the way to stop that is to
 * never write it twice: the value comes from the constant, and the panel is only asked whether it
 * states that value. Change the constant and the panel has to change with it; change the panel and
 * the constant has to move. Neither side can drift alone.
 *
 * Two rules learned the hard way and encoded here:
 *
 *  - **Direction, not co-occurrence.** A gate that asks "does this line mention both `bash` and
 *    `PTY`" reddens on a *correct* sentence that scopes PTY to the opt-in tier. Every check here
 *    asks a directional question about what a sentence claims, and allows an explicit exemption.
 *  - **The failure names the sentence.** A red that says "expected 4096" without quoting the line
 *    it looked at cannot be acted on, so the detail always carries the text.
 */

/**
 * Does one language's text state `value` in any of the accepted spellings?
 *
 * @param {string} text the whole panel for one language
 * @param {number} value the value derived from the source
 * @param {string[]|((value: number) => string)[]} forms accepted spellings. A `{n}` placeholder is
 *   replaced by the value, so `'上限 {n} K'` and `'a {n} ceiling'` are both expressible.
 * @returns {{ stated: boolean, attempted: string[] }}
 */
export function statesNumber(text, value, forms) {
  const attempted = forms.map(form => (typeof form === 'function' ? form(value) : form.replaceAll('{n}', String(value))))
  return { stated: attempted.some(spelling => text.includes(spelling)), attempted }
}

/**
 * Assert that a document states a number derived from the source.
 *
 * `label` names the document and the fact, because the failure has to be actionable on its own:
 * whoever reads it needs to know which sentence is wrong and which constant it should have agreed
 * with.
 *
 * @param {string} text
 * @param {string} label e.g. `help.usage.body`
 * @param {number} value
 * @param {string[]|((value: number) => string)[]} forms
 * @returns {{ ok: boolean, detail: string }}
 */
export function statesNumberVerdict(text, label, value, forms) {
  const { stated, attempted } = statesNumber(text, value, forms)
  if (stated) return { ok: true, detail: `${label} states ${value}` }
  return {
    ok: false,
    detail: `${label} does not state ${value}; it was expected to contain one of `
      + `${JSON.stringify(attempted)}. Either the constant moved and this sentence is now stale, `
      + 'or the sentence was reworded and this gate has to learn the new spelling.',
  }
}

/**
 * A directional predicate over the panel's lines.
 *
 * @param {{key: string, line: string}[]} lines
 * @param {RegExp[]} patterns sentences that make the claim being checked for
 * @param {(line: string) => boolean} [exempt] a sentence that names its own scope is true even when
 *   it matches, e.g. one that mentions the opt-in variable that makes it accurate
 * @returns {{ hits: {key: string, line: string}[] }}
 */
export function findClaims(lines, patterns, exempt = () => false) {
  return {
    hits: lines.filter(({ line }) => patterns.some(pattern => pattern.test(line)) && !exempt(line)),
  }
}

/** Render a sentence for a failure message, bounded so one long bullet cannot flood the log. */
export function quote(line, limit = 140) {
  return JSON.stringify(line.length > limit ? `${line.slice(0, limit)}…` : line)
}
