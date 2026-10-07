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

import { hostConst, objectBody, packageVersion, panelLines, panelText, read, registeredToolNames, sessionShellDefault } from './derive.mjs'
import { findClaims, quote, statesNumberVerdict } from './assertions.mjs'

const SKILLS = 'src/host/wsl-skills.ts'

/** A panel sentence may name the opt-in that makes it accurate; those are true as written. */
const namesTheOptIn = line => line.includes('DSH_WSL_PTY_SHELL')

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
 * Sentences that claim a cache lifetime. The skills provider has no TTL: it re-checks on a poll
 * cadence, so any "cached for N seconds" wording describes a mechanism that was replaced.
 */
const CLAIMS_CACHE_TTL = [
  /缓存\s*\d+\s*秒/,
  /cached[^.]{0,40}for\s*\d+\s*seconds?/i,
]

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

/** A claim that one number from the source is stated in both languages. */
function numberClaim({ id, file, name, zh, en, label }) {
  return {
    id,
    issue: '#52',
    debt: null,
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
  }
}

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
    file: 'src/shared/wsl-stdin.ts',
    name: 'STDIN_CAP_BYTES',
    label: 'help.usage.body (stdin ceiling)',
    zh: [n => `${n / 1024} KiB`],
    en: [n => `${n / 1024} KiB`],
  }),

  // ── the panel describes the build it ships in ────────────────────────────────────────────
  {
    id: 'panel-names-the-version',
    issue: '#52',
    debt: null,
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
  },
  {
    id: 'panel-names-every-registered-tool',
    issue: '#52',
    debt: null,
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
  },
  {
    id: 'panel-does-not-present-pty-as-the-default-bash',
    issue: '#52',
    debt: null,
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
  },

  // ── declared reds: real, user-visible, and owed by the product ────────────────────────────
  {
    id: 'panel-denies-run-in-background',
    issue: '#52 (baseline: the merged issue51 tip)',
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
        hits.push(...findClaims(panel[lang].lines, DENIES_RUN_IN_BACKGROUND, namesTheOptIn)
          .hits.map(h => `${lang} ${h.key}: ${quote(h.line)}`))
      }
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? 'no sentence denies the parameter the schema declares'
          : `the panel denies a parameter the mounted tool declares and uses: ${hits.join(' | ')}`,
      }
    },
  },
  {
    id: 'panel-claims-a-ten-second-cache',
    issue: '#52 (baseline: the merged issue51 tip)',
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
        hits.push(...findClaims(panel[lang].lines, CLAIMS_CACHE_TTL)
          .hits.map(h => `${lang} ${h.key}: ${quote(h.line)}`))
      }
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? 'no sentence claims a cache lifetime the provider does not have'
          : `a time-to-live is claimed but the provider polls instead: ${hits.join(' | ')}`,
      }
    },
  },
]

/** The claims that must hold today. A failure here is a regression. */
export const GREEN_CLAIMS = CLAIMS.filter(claim => claim.debt === null)

/** The claims declared red, with what is owed and by whom. */
export const DECLARED_RED_CLAIMS = CLAIMS.filter(claim => claim.debt !== null)
