/**
 * The claims registry: what the user-visible documents say, and what the code does.
 *
 * One entry per claim, each a function returning `{ ok, detail }` so the same object can be run by
 * `tests/parity-claims.test.mjs` (the fast gate in `test:unit`) and by `scripts/run-docs-claims.mjs`
 * (the one that knows about declared reds). Keeping one list means a claim cannot be green in one
 * place and red in the other.
 *
 * `debt` is the whole mechanism:
 *
 *   `debt: null`      — the claim must hold. A failure is a regression.
 *   `debt: { … }`     — a **declared red**: it is expected to fail, because the product has not been
 *                       changed to match it yet. Two directions are enforced, the same way
 *                       `tests/deliberate-reds.mjs` enforces them for the seam suite:
 *                         · a declared red that is still red is reported as owed, not as a failure;
 *                         · a declared red that turns **green** is a failure, because the debt was
 *                           paid and the declaration still claims otherwise. A debt cannot be
 *                           retired silently, and neither can the evidence it existed.
 *                       `repair` says who owes what. For both entries below it names the boundary
 *                       that keeps them red: this round ships tests only, and the panel text is a
 *                       product change.
 *
 * Facts are derived from the source wherever they can be (`hostConst`, `registeredToolNames`,
 * `sessionShellDefault`), so a constant that moves takes its claim with it instead of leaving a
 * number here to rot. Claims that are about *prose* rather than a value are directional predicates:
 * they ask what a sentence claims, never whether two words appear near each other — a check of the
 * latter shape reddened on a correct sentence once already.
 */

import { subjectExists } from './derive.mjs'
import { hostConst, objectBody, packageVersion, panelLines, panelText, read, registeredToolNames, sessionShellDefault } from './derive.mjs'
import { findClaims, quote, statesNumberVerdict } from './assertions.mjs'

const SKILLS = 'src/host/wsl-skills.ts'

/**
 * Sentences that deny `bash` has a `run_in_background` parameter — the shape that shipped wrong.
 * A directional predicate: "`bash` is a PTY-backed shell…" does not match, and neither does a
 * sentence about `bash_background`.
 */
const DENIES_RUN_IN_BACKGROUND = [
  /bash\s*本身没有\s*run_in_background/,
  /`bash`[^.]{0,60}\bhas no\b[^.]{0,40}run_in_background/i,
  /`bash`[^.]{0,60}\bignores?\b[^.]{0,40}run_in_background/i,
]

/**
 * A sentence may name the opt-in that makes it accurate; those are true as written.
 *
 * **One predicate per claim, never a shared one.** `DSH_WSL_PTY_SHELL` selects which *shell* is
 * mounted and has nothing to do with `run_in_background`, which selects *synchronous or background*.
 * A single shared exemption suppressed a sentence that denied the parameter and mentioned the
 * variable in passing — measured, and it would have retired a real user-visible red on the strength
 * of an unrelated word. Each claim now passes the exemption that means something for its own
 * subject, and `namesTheBackgroundOptIn` is deliberately the *narrower* of the two: it accepts only a
 * sentence that scopes the parameter itself.
 */
const namesTheOptIn = line => line.includes('DSH_WSL_PTY_SHELL')
const scopesTheParameterItself = line =>
  /(只有在|only |only under|opt[ -]?in)[^。.]{0,40}(那一档|档|tier|this parameter|the parameter)/i.test(line)
  || /run_in_background[^。.]{0,40}(只有在|only)/i.test(line)

/**
 * Sentences that claim a cache lifetime. The skills provider has no TTL: it re-checks on a poll
 * cadence, so any "cached for N seconds" wording describes a mechanism that was replaced.
 *
 * A claim about the lifetime has to survive its own negation, because **the negation is how the
 * debt gets paid**: a maintainer following `repair` may well write "not cached for 10 seconds — it
 * re-checks every 3 s", which is correct and was previously reported as a fresh instance of the
 * defect. `deniesTheLifetime` is that exemption, and it is narrow on purpose: it wants a negation
 * of *this* mechanism, not any sentence that happens to contain the word.
 */
const CLAIMS_CACHE_TTL = [
  /缓存\s*\d+\s*秒/,
  /cached[^.]{0,40}for\s*\d+\s*seconds?/i,
]

/** A sentence that denies having a cache lifetime, rather than asserting one. */
const deniesTheLifetime = line =>
  /(不|没有|无|不再|并非|没有)\s*(缓存|cached?)/i.test(line)
  || /\bnot\s+cached\b|\bno\s+cache\b|\bnever\s+cached\b/i.test(line)

/**
 * Does the mounted `bash` tool declare `run_in_background`?
 *
 * Read from the source rather than by importing the module: the parameter lives in the tool's
 * `parameters` schema, and importing the plugin pulls its peer packages for a fact that one brace
 * match away.
 *
 * Two sources have to agree, and a disagreement throws rather than resolving to a fact. The schema
 * and the description are both model-facing and both mention this parameter today; if the schema
 * loses the key while the description still tells the model to pass it, that is a contradiction in
 * the product, and a gate that quietly picked the schema's side would report the panel as correct
 * on the strength of a derivation that had gone wrong. (This is not hypothetical: an earlier
 * revision of this function used an indentation-anchored regex that matched a nested object, would
 * have reported "the schema does not declare it", and would have retired a declared red that was
 * still owed.)
 */
function bashSchemaDeclaresRunInBackground() {
  const body = objectBody('src/host/wsl-bash-tool.ts', /parameters:\s*\{/)
  const declared = /^\s+run_in_background:\s*\{/m.test(body)
  const descriptionTellsTheModel = /pass\s+`run_in_background: true`/.test(read('src/host/wsl-bash-tool.ts'))
  if (declared !== descriptionTellsTheModel) {
    throw new Error('parity/claims: the bash tool\'s schema and its own description disagree about '
      + `run_in_background (schema says ${declared}, description says ${descriptionTellsTheModel}). `
      + 'One of the two derivations is reading the wrong thing; settle that before trusting either.')
  }
  return declared
}

/** Both languages' panels, with the dictionaries and their joined text. */
async function panels() {
  const { zh, en } = await import('../../src/client/locales.ts')
  return {
    zh: { dict: zh, text: panelText(zh), lines: panelLines(zh) },
    en: { dict: en, text: panelText(en), lines: panelLines(en) },
  }
}

/**
 * A claim, plus the sentences it is *about* — asserted to be present before its own verdict counts.
 *
 * This is the completeness half, and it exists because half of the claims here assert an
 * **absence**: "no sentence makes PTY the provider of `bash`", "no sentence claims a cache
 * lifetime". An absence is vacuously satisfied by an empty document, so deleting the panel would
 * silence exactly the claims that police it. A claim whose subject is gone is not satisfied, it is
 * unanswerable — and this repository treats unanswerable as red, the same way
 * `check-host-prompt-parity.mjs` treats "could not compare" as drift rather than as agreement.
 *
 * The forward direction needs no anchor of its own (a claim that a number is stated fails when the
 * sentence stating it is deleted), but every claim carries `requires` so the shape is uniform and
 * the self-check can insist on it.
 *
 * @param {{ id: string, issue: string, debt?: object|null,
 *           requires?: {lang: 'zh'|'en', pattern: RegExp, why: string}[],
 *           run: () => Promise<{ok: boolean, detail: string}> }} claim
 */
function defineClaim({ id, issue, debt = null, requires = [], run, ...carried }) {
  return {
    id,
    issue,
    debt,
    requires,
    ...carried,
    async run() {
      if (requires.length > 0) {
        const panel = await panels()
        const missing = requires.filter(req => !req.pattern.test(panel[req.lang].text))
        if (missing.length > 0) {
          return {
            ok: false,
            detail: 'the sentence this claim is about is gone: '
              + missing.map(m => `${m.lang} ${String(m.pattern)} (${m.why})`).join('; ')
              + '. Re-register the claim against the new wording, or delete the claim in the same '
              + 'commit — an absence is otherwise satisfied by a document that no longer says '
              + 'anything.',
          }
        }
      }
      return run()
    },
  }
}

/**
 * Every number this gate watches, so that deleting a claim is noticed.
 *
 * The claims below derive their values, which means a constant can be covered without anyone
 * writing the number down — but it also means a claim can be *deleted* and the registry still look
 * healthy. This list is the other half of that bargain: it is the set of facts the panel is known
 * to make statements about, and each one has to be claimed by something. Add a budget to the panel
 * and it belongs here; remove a claim and its entry here reddens.
 */
export const WATCHED_CONSTANTS = [
  ['src/host/wsl-skills.ts', 'MAX_SCAN_DEPTH', 'the panel states the scan depth'],
  ['src/host/wsl-skills.ts', 'MAX_SKILL_ROOTS', 'the panel states the number of skill directories'],
  ['src/host/wsl-skills.ts', 'MAX_VISITED_DIRECTORIES', 'the panel states the visited-directory cap'],
  ['src/host/wsl-skills.ts', 'MAX_LINK_RESOLUTIONS', 'the panel states the per-lookup link cap'],
  ['src/host/wsl-skills.ts', 'REFRESH_POLL_MS', 'the panel states the re-check cadence'],
  ['src/host/wsl-skills.ts', 'DISCOVERY_POLL_MS', 'the panel states the re-discovery cadence'],
  ['src/shared/wsl-stdin.ts', 'STDIN_CAP_BYTES', 'the panel states the stdin ceiling'],
]

/** A claim that one number from the source is stated in both languages. */
function numberClaim({ id, file, name, zh, en, label, not_applicable_without }) {
  return defineClaim({
    id,
    issue: '#52',
    // Passed through rather than dropped: a claim whose subject is absent on this baseline has to be
    // able to say so, and a helper that silently discards the field would make that unexpressible.
    ...(not_applicable_without === undefined ? {} : { not_applicable_without }),
    async run() {
      const value = hostConst(file, name)
      const panel = await panels()
      const results = [
        statesNumberVerdict(panel.zh.text, `zh ${label}`, value, zh),
        statesNumberVerdict(panel.en.text, `en ${label}`, value, en),
      ]
      const failed = results.filter(r => !r.ok)
      return {
        ok: failed.length === 0,
        detail: failed.length === 0
          ? `${name} = ${value} is stated in both languages`
          : failed.map(r => r.detail).join(' | '),
      }
    },
    // Kept on the claim so the coverage check below can see which constants are spoken for.
    covered: { file, name },
  })
}

/**
 * Claims whose subject does not exist on **this** baseline.
 *
 * Two of these read files that only a later branch introduces, so on the branch this suite is being
 * merged into they cannot be evaluated at all. They are not red — the code has not been accused of
 * anything — and they are not green, because nothing was compared. They are **not applicable**, and
 * the report says so by name, which is the only honest description.
 *
 * They come back the moment their subject exists, and because they are listed by subject rather
 * than by name, that resumption needs no edit here.
 */
const BASELINE_ABSENT = new Set([
  'src/shared/wsl-stdin.ts',
  'src/host/wsl-bash-tool.ts',
])

export const CLAIMS = [
  // ── values the panel states, derived from the constant that decides them ──────────────────
  numberClaim({
    id: 'skills-scan-depth',
    file: SKILLS,
    name: 'MAX_SCAN_DEPTH',
    label: 'help.usage.body (scan depth)',
    zh: ['上限 {n} 层目录'],
    en: ['bounded to {n} levels'],
  }),
  numberClaim({
    id: 'skills-max-roots',
    file: SKILLS,
    name: 'MAX_SKILL_ROOTS',
    label: 'help.usage.body (skill directories)',
    zh: ['{n} 个技能目录'],
    en: ['{n} skill directories'],
  }),
  numberClaim({
    id: 'skills-visited-directories',
    file: SKILLS,
    name: 'MAX_VISITED_DIRECTORIES',
    label: 'help.usage.body (visited directories)',
    zh: ['{n} 个已访问目录'],
    en: ['{n} visited directories'],
  }),
  numberClaim({
    id: 'skills-link-resolutions',
    file: SKILLS,
    name: 'MAX_LINK_RESOLUTIONS',
    label: 'help.usage.body (link lookups)',
    zh: ['最多 {n} 条'],
    en: ['at most {n} per lookup'],
  }),
  numberClaim({
    id: 'skills-refresh-poll',
    file: SKILLS,
    name: 'REFRESH_POLL_MS',
    label: 'help.known.body (refresh cadence)',
    zh: [n => `每 ${n / 1000} 秒`],
    en: [n => `every ${n / 1000} seconds`],
  }),
  numberClaim({
    id: 'skills-discovery-poll',
    file: SKILLS,
    name: 'DISCOVERY_POLL_MS',
    label: 'help.known.body (re-discovery cadence)',
    zh: [n => `每 ${n / 1000} 秒`],
    en: [n => `a ${n / 1000}-second walk`],
  }),
  numberClaim({
    id: 'stdin-ceiling',
    // Not evaluated on a baseline without this file; see BASELINE_ABSENT.
    not_applicable_without: 'src/shared/wsl-stdin.ts',
    file: 'src/shared/wsl-stdin.ts',
    name: 'STDIN_CAP_BYTES',
    label: 'help.usage.body (stdin ceiling)',
    zh: [n => `${n / 1024} KiB`],
    en: [n => `${n / 1024} KiB`],
  }),

  // ── the panel describes the build it ships in ────────────────────────────────────────────
  defineClaim({
    id: 'panel-names-the-version',
    issue: '#52',
    async run() {
      const version = packageVersion()
      const panel = await panels()
      const wrong = ['zh', 'en'].filter(lang => !(panel[lang].dict['help.news.title'] ?? '').includes(version))
      return {
        ok: wrong.length === 0,
        detail: wrong.length === 0
          ? `help.news.title names ${version} in both languages`
          : `${wrong.join(' and ')} help.news.title does not name the package version ${version}`,
      }
    },
  }),
  defineClaim({
    id: 'panel-names-every-registered-tool',
    issue: '#52',
    // Filed rather than fixed. The panel genuinely omits a tool the registry exposes, and **filing it is
    // what the gate is for** — a gate that can only fail cannot be merged into a branch that still
    // has the defect. The repair belongs to whoever next edits the help text, and withdrawing this
    // entry has to happen in the same commit that fixes the panel, or the arithmetic reports the
    // discrepancy instead of forgetting it.
    debt: {
      owed: 'The panel omits a tool the repository registers. `registeredToolNames()` is derived, and '
        + 'one tool it returns has no name in either dictionary — reachable by the model, '
        + 'undiscernible by the user.',
      repair: 'Name it in both dictionaries. The claim re-derives the tool list rather than holding a '
        + 'written copy, so it goes green when the panel agrees and red again when they drift.',
    },
    async run() {
      const tools = registeredToolNames()
      if (tools.length < 4) {
        return { ok: false, detail: `derived only ${tools.length} tool name(s): ${JSON.stringify(tools)}` }
      }
      const panel = await panels()
      const missing = []
      for (const lang of ['zh', 'en']) {
        for (const tool of tools) {
          if (!panel[lang].text.includes(tool)) missing.push(`${lang}:${tool}`)
        }
      }
      return {
        ok: missing.length === 0,
        detail: missing.length === 0
          ? `both panels name all of ${tools.join(', ')}`
          : `the panel never names ${missing.join(', ')} — a capability the user cannot discover`,
      }
    },
  }),
  defineClaim({
    id: 'panel-does-not-present-pty-as-the-default-bash',
    issue: '#52',
    // Filed rather than fixed: the panel still says PTY where the code now defaults to the session
    // shell. The claim reads the code's own answer rather than a recorded one, which is why it can
    // be filed before the text is corrected and still mean something afterwards.
    debt: {
      owed: '`src/client/locales.ts` describes `bash` as backed by a PTY shell, while the '
        + 'session-shell contract this gate derives says the default is the pipe-driven session '
        + 'shell, with PTY reachable only behind an opt-in variable. The panel documents the tier that '
        + 'is off by default.',
      repair: 'Describe the default tier and name the variable that switches it. The claim reads the '
        + 'contract from source, so it stops being red when the sentence matches the code — and turns '
        + 'red again if they drift apart later.',
    },
    // This claim asserts an *absence*, so it needs the sentence that carries the claim to still be
    // there: with the whole usage paragraph deleted it would find no offending sentence and report
    // success about a panel that says nothing at all.
    requires: [
      { lang: 'zh', pattern: /会话 shell/, why: 'the sentence naming which shell provides bash' },
      { lang: 'en', pattern: /session shell/, why: 'the sentence naming which shell provides bash' },
    ],
    async run() {
      const shell = sessionShellDefault()
      if (shell === undefined) {
        throw new Error('parity/claims: could not read the session-shell contract from src/index.ts '
          + "(expected the `DSH_WSL_PTY_SHELL === '1' ? 'pty' : 'session'` ternary).")
      }
      if (shell !== 'session') return { ok: true, detail: `the default shell is ${shell}; nothing to check` }
      const panel = await panels()
      const hits = []
      for (const lang of ['zh', 'en']) {
        // A sentence identifying PTY as what provides `bash`. Not "mentions both words".
        const provides = [/bash\s*由\s*PTY/, /`bash`[^.]{0,60}\bis\b[^.]{0,60}PTY/i]
        hits.push(...findClaims(panel[lang].lines, provides, namesTheOptIn).hits.map(h => `${lang} ${h.key}: ${quote(h.line)}`))
      }
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? 'no sentence makes PTY the provider of `bash`'
          : `PTY is described as what provides \`bash\` while the default is the pipe-driven session `
            + `shell (PTY is opt-in via DSH_WSL_PTY_SHELL=1): ${hits.join(' | ')}`,
      }
    },
  }),

  // ── declared reds: real, user-visible, and owed by the product ────────────────────────────
  defineClaim({
    id: 'panel-denies-run-in-background',
    // Not evaluated on a baseline without this file; see BASELINE_ABSENT.
    not_applicable_without: 'src/host/wsl-bash-tool.ts',
    issue: '#52 (baseline: the merged issue51 tip)',
    // An absence again: the red is declared because a sentence is there, so the red would otherwise
    // be "paid" by deleting the sentence — which is the opposite of what happened.
    requires: [
      { lang: 'zh', pattern: /后台任务/, why: 'the sentence about work that outlives a call' },
      { lang: 'en', pattern: /background job/, why: 'the sentence about work that outlives a call' },
    ],
    debt: {
      owed: 'src/client/locales.ts help.usage.body tells the user that `bash` has no '
        + '`run_in_background` parameter and ignores one. `src/host/wsl-bash-tool.ts` declares the '
        + 'parameter in `BashArgs`, puts it in the tool\'s `parameters` schema, branches on it to '
        + 'return `kind: \'background\'`, and the same tool\'s own description tells the model to '
        + 'pass `run_in_background: true` for work that must outlive one call. The panel contradicts '
        + 'the tool it documents, and the model reads the other side of that contradiction.',
      repair: 'Correct the panel sentence in both languages: drop the denial and describe the '
        + 'parameter, as the tool description already does. Owned by whoever next touches the help '
        + 'text — this round ships tests only, so the red is declared rather than fixed.',
    },
    async run() {
      const declares = bashSchemaDeclaresRunInBackground()
      if (!declares) {
        return { ok: true, detail: 'the bash schema no longer declares run_in_background; the panel matches' }
      }
      const panel = await panels()
      const hits = []
      for (const lang of ['zh', 'en']) {
        hits.push(...findClaims(panel[lang].lines, DENIES_RUN_IN_BACKGROUND, scopesTheParameterItself)
          .hits.map(h => `${lang} ${h.key}: ${quote(h.line)}`))
      }
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? 'no sentence denies the parameter the schema declares'
          : `the panel denies a parameter the mounted tool declares and uses: ${hits.join(' | ')}`,
      }
    },
  }),
  defineClaim({
    id: 'panel-claims-a-ten-second-cache',
    issue: '#52 (baseline: the merged issue51 tip)',
    // An absence as well, and one whose subject is the same sentence the "10 seconds" sits in:
    // deleting that sentence must not read as the debt having been paid.
    requires: [
      { lang: 'zh', pattern: /技能目录/, why: 'the sentence describing skill-catalog discovery' },
      { lang: 'en', pattern: /skill catalog/i, why: 'the sentence describing skill-catalog discovery' },
    ],
    debt: {
      owed: 'src/client/locales.ts says the skill catalog is "cached per scan root for 10 seconds". '
        + 'The skills provider has no TTL: `src/host/wsl-skills.ts` re-checks a served scan root '
        + 'every `REFRESH_POLL_MS` (3 s) and runs a full re-discovery every `DISCOVERY_POLL_MS` '
        + '(30 s), and its own comment records that 10 s was the *old* value of the refresh poll '
        + 'before the two-tier split. The sentence describes a mechanism that was replaced.',
      repair: 'Restate the sentence as the two cadences it actually has (re-check ~3 s, full '
        + 're-discovery ~30 s) — the same two numbers `help.known.body` already states. Owned by '
        + 'whoever next touches the help text.',
    },
    async run() {
      const panel = await panels()
      const hits = []
      for (const lang of ['zh', 'en']) {
        hits.push(...findClaims(panel[lang].lines, CLAIMS_CACHE_TTL, deniesTheLifetime)
          .hits.map(h => `${lang} ${h.key}: ${quote(h.line)}`))
      }
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? 'no sentence claims a cache lifetime the provider does not have'
          : `a time-to-live is claimed but the provider polls instead: ${hits.join(' | ')}`,
      }
    },
  }),

  // ── completeness: a fact the panel speaks about cannot lose its claim ─────────────────────
  //
  // Every other claim here answers "is what the document says true". This one answers the other
  // question, "is everything the document says being checked" — the half that a suite of positive
  // assertions cannot see, and the half issue #51's own postmortem is about (`TESTING.md`: a budget
  // met exactly, hiding a violation that any count would have accepted). Deleting a claim is the
  // cheapest way to make a gate green, and this is what makes that visible.
  defineClaim({
    id: 'every-watched-constant-is-claimed',
    issue: '#52',
    async run() {
      const covered = new Set(CLAIMS.filter(c => c.covered !== undefined)
        .map(c => `${c.covered.file}#${c.covered.name}`))
      const uncovered = WATCHED_CONSTANTS
        .map(([file, name, why]) => ({ key: `${file}#${name}`, why }))
        .filter(entry => !covered.has(entry.key))
      if (uncovered.length === 0) {
        return {
          ok: true,
          detail: `all ${WATCHED_CONSTANTS.length} watched constant(s) are claimed: `
            + `${[...covered].join(', ')}`,
        }
      }
      return {
        ok: false,
        detail: `${uncovered.length} constant(s) the panel makes statements about have no claim: `
          + uncovered.map(e => `${e.key} (${e.why})`).join('; ')
          + '. Either re-register the claim or drop the entry from WATCHED_CONSTANTS in the same '
          + 'commit — a number the panel states with nothing checking it is the shape this gate exists '
          + 'to refuse.',
      }
    },
  }),
]

/** The claims that must hold today. A failure here is a regression. */
/** Claims whose subject is present on this baseline, and so can actually be compared. */
export const APPLICABLE_CLAIMS = CLAIMS.filter(claim =>
  claim.not_applicable_without === undefined || subjectExists(claim.not_applicable_without))
/** Claims this baseline cannot compare, named so the report can list them. */
export const INAPPLICABLE_CLAIMS = CLAIMS.filter(claim => !APPLICABLE_CLAIMS.includes(claim))

export const GREEN_CLAIMS = APPLICABLE_CLAIMS.filter(claim => claim.debt === null)

/** The claims declared red, with what is owed and by whom. */
export const DECLARED_RED_CLAIMS = APPLICABLE_CLAIMS.filter(claim => claim.debt !== null)
