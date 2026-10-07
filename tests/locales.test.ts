/**
 * Locale dictionary parity, and the help panel's parity with the build.
 *
 * The first two tests are the original question: the `wslWorkspace` namespace is registered from
 * both dictionaries at once, so a key that exists in only one of them renders as a bare key (or an
 * untranslated string) in the other language.
 *
 * The rest exist because those two cannot see the defect that shipped in 0.7.6. That panel listed
 * #47 and #49, never mentioned #51, and still described `bash` as provided by "a PTY-backed
 * persistent shell" — the mechanism the release replaced with a pipe-driven session shell. Every
 * check above compared the two languages to each other; none compared either to the code, so a
 * panel that was internally consistent and externally false passed. The gate's question was "is
 * the translation complete", never "is the text true".
 *
 * Each fact is derived from the source rather than kept in a hand-written list, so a new tool or a
 * moved mechanism trips the gate instead of quietly leaving the panel behind. When a derivation
 * itself can no longer find its contract (a refactor moved the shape), the test fails loudly and
 * says so — a gate that silently skips is the failure mode this file was written to remove.
 *
 * Run with `node --test --experimental-strip-types tests/locales.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { en, zh } from '../src/client/locales.ts'

const repoRoot = join(import.meta.dirname, '..')
const hostDir = join(repoRoot, 'src', 'host')

test('zh and en expose exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('no dictionary value is blank', () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim() !== '', `zh ${key} is blank`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() !== '', `en ${key} is blank`)
  }
})

// ── the panel must describe the build it ships in ────────────────────────────

/** Every help string of one language, joined — the text a user actually reads. */
function panelText(dict: Record<string, string>): string {
  return Object.entries(dict)
    .filter(([key]) => key.startsWith('help.'))
    .map(([, value]) => value)
    .join('\n')
}

/** The panel's lines, with the key each came from, for a failure a reader can act on. */
function panelLines(dict: Record<string, string>): { key: string, line: string }[] {
  const out: { key: string, line: string }[] = []
  for (const [key, value] of Object.entries(dict)) {
    if (!key.startsWith('help.')) continue
    for (const line of value.split('\n')) out.push({ key, line })
  }
  return out
}

/**
 * The tool names this plugin registers, read from the `TOOL_NAME` contracts in `src/host` plus the
 * two search tools that register a literal `name:` field.
 *
 * `TOOL_NAME` is an exported const on purpose — it is the name the host's own tools use, so only
 * one may be mounted (`src/host/wsl-bash-tool.ts:35`). That makes it the contract to read, not the
 * registry, which is only populated once a context exists.
 */
function registeredToolNames(): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(hostDir)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(join(hostDir, file), 'utf8')
    for (const match of source.matchAll(/export const TOOL_NAME = '([^']+)'/g)) names.add(match[1])
    for (const match of source.matchAll(/^\s+name: '(grep|glob)',$/gm)) names.add(match[1])
  }
  return [...names].sort()
}

test('the tool-name contract still parses, so the checks below mean something', () => {
  const tools = registeredToolNames()
  assert.ok(tools.length >= 4,
    `read ${tools.length} tool name(s) from ${hostDir}: ${JSON.stringify(tools)}. The \`export const `
    + 'TOOL_NAME\` contract (or the `name:` literal the search tools use) moved; this gate derived '
    + 'nothing and must not report success from an empty set.')
  for (const expected of ['bash', 'bash_background', 'wsl_terminal']) {
    assert.ok(tools.includes(expected), `the contract no longer yields \`${expected}\`: ${JSON.stringify(tools)}`)
  }
})

test('every tool this plugin registers is named in the help panel, in both languages', () => {
  const tools = registeredToolNames()
  for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
    const text = panelText(dict as Record<string, string>)
    for (const tool of tools) {
      assert.ok(text.includes(tool),
        `${lang} help panel never names \`${tool}\`, a tool this build registers. The user cannot `
        + 'discover a capability the panel does not mention — that is how `wsl_terminal` shipped in '
        + '0.7.6 unnamed.')
    }
  }
})

test('the help panel names the version this package ships', () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
    const title = (dict as Record<string, string>)['help.news.title'] ?? ''
    assert.ok(title.includes(version),
      `${lang} help.news.title is ${JSON.stringify(title)} but the package version is ${version}. `
      + 'A bumped release with stale notes tells the user about the wrong build.')
  }
})

/**
 * The session shell's mechanism, derived from the source.
 *
 * `src/index.ts:1156` is the contract: `process.env.DSH_WSL_PTY_SHELL === '1' ? 'pty' : 'session'`.
 * While that ternary reads this way, the PTY tier is **opt-in** and the default `bash` is the
 * pipe-driven session shell — so no sentence may *identify* `bash`'s mechanism as PTY unless it
 * also names the escape hatch that makes it true.
 *
 * The shape being caught is a provider claim, not the co-occurrence of two words. An earlier
 * revision of this check flagged any line holding both `bash` and `PTY`, and the correct copy
 * f108379 wrote tripped it: the known-issues bullet says "that tier's bash fails with `PTY shell
 * exited during startup` … the default session shell is unaffected" — accurate, and it scopes PTY
 * to the opt-in. A gate that cannot tell a true sentence from a false one is noise, so this asks
 * the narrow question instead: does the sentence make PTY the thing that provides `bash`?
 */
function ptyTierIsOptIn(): boolean | undefined {
  const source = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8')
  if (/DSH_WSL_PTY_SHELL === '1' \? 'pty' : 'session'/.test(source)) return true
  if (/'pty' : 'session'/.test(source) || /'session' : 'pty'/.test(source)) return false
  return undefined
}

/** A sentence that makes PTY the mechanism `bash` is provided by. */
const PRESENTS_BASH_AS_PTY: readonly RegExp[] = [
  /bash\s*由\s*PTY/,                       // zh: "bash 由 PTY 承载的持久 shell 提供"
  /`bash`[^.]{0,60}\bis\b[^.]{0,60}PTY/i,  // en: "`bash` is a PTY-backed stateful shell"
  /`bash`[^.]{0,60}\bruns?\s+on\b[^.]{0,40}PTY/i,
]

test('the panel does not present the opt-in PTY shell as the default bash', () => {
  const optIn = ptyTierIsOptIn()
  assert.notStrictEqual(optIn, undefined,
    'could not read the session-shell contract from src/index.ts (expected the '
    + "`DSH_WSL_PTY_SHELL === '1' ? 'pty' : 'session'` ternary). The mechanism moved; re-point this "
    + 'gate rather than deleting it — this is the check that catches a panel describing a shell the '
    + 'build no longer mounts.')

  for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
    for (const { key, line } of panelLines(dict as Record<string, string>)) {
      if (!PRESENTS_BASH_AS_PTY.some(pattern => pattern.test(line))) continue
      // Naming the opt-in makes the sentence true, so it is allowed.
      if (line.includes('DSH_WSL_PTY_SHELL')) continue
      assert.fail(
        `${lang} ${key} presents PTY as what provides \`bash\` (${JSON.stringify(line.slice(0, 120))}) `
        + `while the build's default session shell is ${optIn === true ? 'the pipe-driven session shell, with PTY opt-in via DSH_WSL_PTY_SHELL=1' : 'the PTY tier'}. `
        + 'Either correct the sentence or name the opt-in in it.')
    }
  }
})
