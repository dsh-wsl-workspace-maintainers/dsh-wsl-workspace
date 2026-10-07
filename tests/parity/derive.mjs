/**
 * The derivation kernel: reads facts out of the sources so a gate never has to state them twice.
 *
 * Why this exists rather than a table someone maintains. Every user-visible number this plugin
 * prints in its help panel is also a constant in `src/host`, and before this file the two were
 * kept in step by hand. They were in step when it was written and nothing kept them there: change
 * `MAX_VISITED_DIRECTORIES` and the panel keeps saying 4096, with every gate still green. That is
 * the shape `TESTING.md` calls out at its end — a budget is not coverage — because a number that
 * appears twice is a number that can disagree with itself.
 *
 * The rule that keeps this honest: **a derivation that cannot find its subject throws.** It never
 * returns `undefined` and it is never skipped, because a gate whose derivation quietly found
 * nothing reports the same green as a gate whose subject is genuinely absent. The wording is the
 * one `check-host-prompt-parity.mjs` uses for the same hazard — not comparing is not the same as
 * having found no drift.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The repository root, from this file's own location (`tests/parity/`). */
export const repoRoot = join(import.meta.dirname, '..', '..')

/** Read a repository-relative file as UTF-8. Throws if it is not there. */
/**
 * Whether a derivation's subject exists on **this** baseline.
 *
 * A gate that reads a file another branch has not introduced yet cannot evaluate its claim, and the
 * two easy answers are both wrong: reporting failure accuses the code of a defect it does not have, and
 * reporting success is the false green this repository keeps removing. So the question is asked
 * explicitly and the answer is printed — "not applicable here" is a third state, beside red and green.
 */
export function subjectExists(relative) {
  return existsSync(join(repoRoot, relative))
}

export function read(relative) {
  try {
    return readFileSync(join(repoRoot, relative), 'utf8')
  } catch (error) {
    throw new Error(`parity/derive: cannot read ${relative} (${error?.code ?? error?.message}). `
      + 'A gate that cannot read its subject must fail, not pass.')
  }
}

/**
 * A module-scope `const` from a source file, as a number or string.
 *
 * Deliberately a text read rather than an import. The constants this gate needs are not exported
 * (`src/host/wsl-skills.ts` keeps its seven as plain `const`), and exporting them to be read would
 * put a product-source change inside a test-only change. Reading the source text is what
 * `check-host-prompt-parity.mjs`, `test:rank` and `verify-lib-sync` already do in this repository.
 *
 * The cost of that choice is a tolerance for formatting: a constant written as a multi-line
 * expression is not matched. That is why a miss throws with the name and the file in it, instead of
 * resolving to nothing.
 *
 * @param {string} file repository-relative path, e.g. `src/host/wsl-skills.ts`
 * @param {string} name the constant's identifier
 */
export function hostConst(file, name) {
  // Blanked first, so a `/* const NAME = … */` left above the real declaration cannot be the answer.
  // A line comment is already safe (the `const` would not start the line); a **block** comment is
  // not, and it is the case that turns a changed constant into a green gate: the real value moves to
  // 8192, the old 4096 survives in a comment above it, and a regex that does not know about comments
  // keeps deriving 4096 and keeps agreeing with a panel that was never updated.
  const source = stripStringsAndComments(read(file))
  const pattern = new RegExp(`(?:^|\\n)(?:export )?const ${name}\\s*=\\s*([^\\n]+?)\\s*;?\\s*(?://[^\\n]*)?$`, 'm')
  const match = pattern.exec(source)
  if (match === null) {
    throw new Error(`parity/derive: no \`const ${name}\` in ${file}. The constant moved or was `
      + 'renamed; re-point this gate rather than letting it report a green it did not earn.')
  }
  const literal = match[1].trim()
  // Single-quoted string.
  const string = /^'([^']*)'$/.exec(literal)
  if (string !== null) return string[1]
  // A plain number, or integer arithmetic over plain numbers (`32 * 1024`). Several of this
  // plugin's budgets are written as an expression, and refusing those would mean stating the
  // number a second time in the gate — which is the thing this file exists to prevent.
  const value = evalIntegerLiteral(literal)
  if (value !== undefined) return value
  throw new Error(`parity/derive: \`const ${name}\` in ${file} is not a literal this gate can read `
    + `(${JSON.stringify(literal)}). Rewrite the derivation for this shape — a silently skipped `
    + 'constant would make the gate below vacuously true.')
}

/**
 * Evaluate an integer constant expression, or return `undefined` when the text is not one.
 *
 * A hand-written parser rather than `new Function`: the input is repository source, but turning
 * source text into executed code is exactly the habit this gate is supposed to be sceptical of,
 * and the grammar here is four operators over non-negative integers. `/` floors, matching the
 * integer arithmetic these constants are written in.
 */
function evalIntegerLiteral(text) {
  const src = text.replaceAll('_', '')
  if (!/^[\d\s+\-*/()]+$/.test(src)) return undefined
  let i = 0
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  const fail = () => undefined
  let broken = false
  function expr() {
    let value = term()
    skip()
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++]
      const right = term()
      value = op === '+' ? value + right : value - right
      skip()
    }
    return value
  }
  function term() {
    let value = factor()
    skip()
    while (src[i] === '*' || src[i] === '/') {
      const op = src[i++]
      const right = factor()
      value = op === '*' ? value * right : Math.floor(value / right)
      skip()
    }
    return value
  }
  function factor() {
    skip()
    if (src[i] === '(') {
      i++
      const value = expr()
      skip()
      if (src[i] !== ')') { broken = true; return 0 }
      i++
      return value
    }
    const digits = /^\d+/.exec(src.slice(i))
    if (digits === null) { broken = true; return 0 }
    i += digits[0].length
    return Number(digits[0])
  }
  const value = expr()
  skip()
  if (broken || i !== src.length) return fail()
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * The tool names this plugin registers.
 *
 * `export const TOOL_NAME` is a deliberate contract — it is the name the host's own tools use, so
 * only one may be mounted (`src/host/wsl-bash-tool.ts:35-36`) — plus the two search tools, which
 * register a literal `name:` field instead.
 */
export function registeredToolNames() {
  const names = new Set()
  for (const file of readdirSync(join(repoRoot, 'src', 'host'))) {
    if (!file.endsWith('.ts')) continue
    const source = read(join('src', 'host', file))
    for (const match of source.matchAll(/export const TOOL_NAME = '([^']+)'/g)) names.add(match[1])
    for (const match of source.matchAll(/^\s+name: '(grep|glob)',$/gm)) names.add(match[1])
  }
  return [...names].sort()
}

/**
 * Which shell the plugin mounts as the default `bash`, read from the contract in `src/index.ts`.
 *
 * The ternary is the fact: `DSH_WSL_PTY_SHELL === '1' ? 'pty' : 'session'` means the PTY tier is
 * opt-in. Two sentences in the help panel once described PTY as what provides `bash` — one of them
 * was corrected, and the point of deriving this is that the next rewrite does not have to remember.
 *
 * @returns {'session'|'pty'|undefined} `undefined` when the contract is not in the shape this
 *   gate knows how to read, which the caller must treat as a failure rather than as agreement.
 */
export function sessionShellDefault() {
  const source = read(join('src', 'index.ts'))
  if (/DSH_WSL_PTY_SHELL === '1' \? 'pty' : 'session'/.test(source)) return 'session'
  if (/DSH_WSL_PTY_SHELL === '1' \? 'session' : 'pty'/.test(source)) return 'pty'
  return undefined
}

/** Every help string of one language, joined — the text a user actually reads. */
export function panelText(dict) {
  return Object.entries(dict)
    .filter(([key]) => key.startsWith('help.'))
    .map(([, value]) => value)
    .join('\n')
}

/** The panel's lines with the key each came from, so a failure can name the sentence. */
export function panelLines(dict) {
  const out = []
  for (const [key, value] of Object.entries(dict)) {
    if (!key.startsWith('help.')) continue
    for (const line of value.split('\n')) out.push({ key, line })
  }
  return out
}

/**
 * The body of an object literal in a source file, found by brace matching.
 *
 * A regex over indentation is not enough and this was measured, not assumed: `parameters: \{[\s\S]*?\n {6}\}`
 * against `src/host/wsl-bash-tool.ts` matched a **nested** object 245 characters long, while the
 * key being looked for sat 26 000 characters further on — so the check reported "the schema does not
 * declare it" about a schema that does, and a declared red was reported as already paid. That is
 * the failure mode this file exists to prevent, in the one place where it is hardest to notice.
 *
 * Braces inside strings and comments are skipped first, because a description here is prose and
 * prose contains braces.
 *
 * @param {string} file repository-relative path
 * @param {RegExp} key a pattern ending at the object's `{` (e.g. `/parameters:\s*\{/`)
 * @returns {string} the object body, braces included
 */
export function objectBody(file, key) {
  const source = stripStringsAndComments(read(file))
  const match = key.exec(source)
  if (match === null) {
    throw new Error(`parity/derive: ${key} not found in ${file}. The shape moved; re-point this `
      + 'derivation rather than letting it report a fact nobody checked.')
  }
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`parity/derive: unbalanced braces after ${key} in ${file}`)
}

/**
 * Replace the contents of string literals and comments with spaces, keeping every offset and every
 * brace that is real code. Keeping the length means an index found in the stripped text is the same
 * index in the original.
 */
/**
 * Blank out every string literal and comment, **preserving offsets** — the reason this exists rather
 * than a strip-everything pass: `objectBody` brace-matches by index afterwards.
 *
 * Exported because the host-contract derivations need the same discipline. Measured on this
 * repository: an un-stripped scan of `src/**.ts` for `ctx.<name>` reports eight hits that are
 * documentation — `src/fs.ts:2`, `src/host/wsl-jobs.ts:5`, `src/host/wsl-search.ts:5` and
 * `src/host/wsl-bash-tool.ts:88` are all prose or a shell example, not code. A property test built on
 * the raw text would assert against the comment.
 */
export function stripStringsAndComments(source) {
  const out = [...source]
  let i = 0
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    const quote = source[i]
    if (quote === "'" || quote === '"' || quote === '`') {
      let k = i + 1
      while (k < source.length) {
        if (source[k] === '\\') { k += 2; continue }
        if (source[k] === quote) break
        k++
      }
      blank(i + 1, Math.min(k, source.length))
      i = k + 1
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * The version this package ships, which the panel's "what's new" heading must name.
 */
export function packageVersion() {
  const parsed = JSON.parse(read('package.json'))
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error('parity/derive: package.json has no version string')
  }
  return parsed.version
}

// ── host-contract derivations ────────────────────────────────────────────────────────────────
//
// These read the plugin's **sources**, not the built artifact, per the same rule
// `check-host-prompt-parity.mjs:66` states: a gate that can be fed a rebuilt bundle is not a gate.
// But unlike the number derivations above, they cannot use regexes, and the reason is measured
// rather than theoretical.
//
// `stripStringsAndComments` is a hand-rolled scanner, and this repository breaks it.
// `src/shell.ts:279` is:
//
//     ? `cd '${linuxCwd.replace(/'/g, `'\\''`)}' && ${spec.command}`
//
// A regex literal containing a quote, inside a template literal, inside another quoted string. The
// scanner reads that `'` as the start of a string, and the damage cascades: on the current file it
// turns 544 lines into 188 and **deletes `this.ctx.subprocess` at line 441** — the exact line whose
// reachability is the point. A derivation built on it would have reported one bare context read in
// the whole tree instead of two, and the missing one is the load-bearing one.
//
// So these use the TypeScript parser, which is already a devDependency (`typecheck-gate.mjs`
// requires it, and `check-unit-closure.mjs` only rejects `@deepseek-ai/*` imports, which a
// compiler is not).

/** Members of `Context` / `Fiber` that are framework API rather than an injected service. */
const CORDIS_API = new Set([
  'get', 'set', 'provide', 'plugin', 'effect', 'on', 'off', 'emit', 'registry', 'extend', 'bind',
  'setInterval', 'setTimeout', 'logger', 'config', 'env', 'baseUrl', 'scope', 'start', 'stop',
  'entry', 'ctx', 'inject', 'runtime', 'uid', 'state', 'parent', 'toString', 'inspect', 'root',
  'internal', 'builtins', 'name', 'envData', 'call', 'apply',
])

let tsModule = null
function typescript() {
  if (tsModule === null) {
    // Through `createRequire` rather than a static import so the compiler is only loaded when one of
    // the host-contract derivations is actually called — the number claims above run in the unit
    // bucket on every `test:unit`, and nothing there should pay for a parser.
    tsModule = createRequire(import.meta.url)('typescript')
  }
  return tsModule
}

/** The `inject` a module declares, as the host will read it: `export const` or `static`. */
export function declaredInject(file) {
  const ts = typescript()
  const source = read(file)
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true)
  let found = null
  const visit = node => {
    if (found !== null) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'inject') {
      const names = []
      if (node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) names.push(element.text)
        }
      }
      found = names
      return
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'inject'
      && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      const names = []
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) names.push(element.text)
      }
      found = names
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * Every `ctx.<name>` / `this.ctx.<name>` read that is not framework API, with the line it is on.
 *
 * Returns a sorted, de-duplicated list because the caller asserts on the *set*: a service read in
 * three places is one reachability requirement, and reporting it three times would make the failure
 * count a measure of the code's length rather than of the wiring.
 */
export function bareContextReads(file) {
  const ts = typescript()
  const source = read(file)
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true)
  const found = new Map()
  const visit = node => {
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression
      const viaThis = ts.isPropertyAccessExpression(target)
        && target.expression.kind === ts.SyntaxKind.ThisKeyword
        && target.name.text === 'ctx'
      const viaBare = ts.isIdentifier(target) && target.text === 'ctx'
      if ((viaThis || viaBare) && !CORDIS_API.has(node.name.text)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        if (!found.has(node.name.text)) found.set(node.name.text, line)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...found.entries()].map(([name, line]) => ({ name, line })).sort((a, b) => a.name.localeCompare(b.name))
}


// ── the producer/consumer derivation ─────────────────────────────────────────────────────────
//
// The plugin hands the host a job and expects the host to be able to read that job's output. Which
// member carries it is a **contract between two packages**, and a contract whose shape changed
// without either side noticing is invisible from inside either.
//
// So this asks a mechanical question of the *consumer's own source*: for each member name the
// producer offers, does the consuming package mention it at all? Not "does the plugin's test say so"
// — whether `@deepseek-ai/dsh-jobs-local`, `@deepseek-ai/dsh-jobs` and `@deepseek-ai/dsh-tool-jobs`
// still name `readOutput` anywhere. Measured on the pinned 0.2.0-rc.2 tree: `spec.output` appears
// three times and `readFrom` three times, and `readOutput` **zero times in all three packages**.
//
// Deriving the reader list from the consumer's text rather than hardcoding it is the whole point: a
// list written by hand would be this repository's own second copy of the contract, which is the
// failure this whole branch exists to remove.

/** The host packages that consume a job's output, and where their entry point lives. */
const JOB_CONSUMERS = [
  ['@deepseek-ai/dsh-jobs-local', 'ci/deps/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'],
  ['@deepseek-ai/dsh-jobs', 'ci/deps/node_modules/@deepseek-ai/dsh-jobs/lib/index.js'],
  ['@deepseek-ai/dsh-tool-jobs', 'ci/deps/node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js'],
]

/**
 * How many times each of `names` occurs across the job-consuming host packages.
 *
 * A count rather than a boolean because one occurrence is a name in a comment or a string and two
 * is usually code; the caller reports the counts so a reader can judge, and a package whose sources
 * cannot be read raises rather than reporting zero — "no reader" and "could not look" must not look
 * the same, which is the mistake `run-docs-claims.mjs` made with an unevaluated claim.
 */
export function hostMentions(names) {
  const counts = Object.fromEntries(names.map(name => [name, 0]))
  const read = []
  for (const [pkg, relative] of JOB_CONSUMERS) {
    let source
    try {
      source = readFileSync(join(repoRoot, relative), 'utf8')
    } catch (error) {
      throw new Error(`parity/derive: cannot read ${pkg}'s entry (${relative}) `
        + `(${error?.code ?? error?.message}). A consumer whose source is unreadable cannot be `
        + 'searched for a reader, and reporting "no reader" for it would be a fabricated finding.')
    }
    read.push(pkg)
    for (const name of names) {
      // Word-boundary counted, so `readOutput` is not found inside `readOutputChannels`.
      const matches = source.match(new RegExp(`\\b${name}\\b`, 'g'))
      counts[name] += matches === null ? 0 : matches.length
    }
  }
  return { counts, packages: read }
}

/**
 * The channels `src/host/wsl-jobs.ts` offers: members placed on the `spec` it hands over, and
 * members of the object its `run()` returns.
 *
 * Read from the source with the TypeScript parser for the same reason the reachability
 * derivations do: a hand-rolled scanner would take `src/shell.ts:279`'s regex-in-template for a
 * string opener and delete the answer.
 */
export function offeredJobChannels(file = 'src/host/wsl-jobs.ts') {
  const ts = typescript()
  const sf = ts.createSourceFile('probe.ts', read(file), ts.ScriptTarget.ESNext, true)

  const specMembers = new Set()
  const runResultMembers = new Set()

  /** Property names of an object *type* literal or an object literal, syntactically. */
  const memberNames = container => {
    const names = []
    const members = ts.isTypeLiteralNode(container) ? container.members : container.properties
    for (const member of members ?? []) {
      const name = member.name
      if (name === undefined) continue
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.push(name.text)
    }
    return names
  }

  const visit = node => {
    // `start(spec: { … })` — the parameter's type literal is the shape the host will read.
    // Walked syntactically rather than through `ts.getTypeAtLocation`, which needs a Program and a
    // checker: this file only ever builds a SourceFile, and asking for the checker here would mean
    // type-checking the whole plugin on every call.
    if (ts.isParameter(node) && node.name.getText(sf) === 'spec' && node.type
      && ts.isTypeLiteralNode(node.type)) {
      for (const name of memberNames(node.type)) specMembers.add(name)
    }
    // `run() { return { … } }` — the object literal it returns is one place the channel set is
    // written. The other is the **declared** contract, `run(): { … }` on the registry interface,
    // and that one is the more honest of the two: it is what a reader is told to expect rather than
    // what one implementation happens to return today. Both are collected, because they can disagree
    // and that disagreement is worth seeing.
    if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
      && node.name.getText(sf) === 'run') {
      if (node.type && ts.isTypeLiteralNode(node.type)) {
        for (const name of memberNames(node.type)) runResultMembers.add(name)
      }
      const body = ts.isMethodDeclaration(node) ? node.body : undefined
      if (body) {
        for (const statement of body.statements) {
          if (!ts.isReturnStatement(statement) || statement.expression === undefined) continue
          if (ts.isObjectLiteralExpression(statement.expression)) {
            for (const name of memberNames(statement.expression)) runResultMembers.add(name)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return {
    spec: [...specMembers].sort(),
    runResult: [...runResultMembers].sort(),
  }
}

// ── the tool-contract derivation ───────────────────────────────────────────────────────────
//
// A tool's `description` is not documentation. It is **the only thing the model reads** before
// choosing arguments, so a sentence in it is an instruction, and an instruction naming an argument
// the schema does not accept is worse than no sentence: the model is told to do something that
// cannot be done.
//
// That is a handoff surface of exactly the kind this branch is built around — *does the far side
// accept what I told it?* — with the model as the far side. Nothing in this repository covered it:
// `tests/locales.test.ts` checked the panel against the code, and the tool descriptions were never
// compared to anything.
//
// Three sets, all derived, none of them written down here:
//   · **declared** — the parameters the tool's schema accepts;
//   · **handled** — the parameters the implementation actually reads, so a declared parameter nobody
//     reads shows up as accepted-and-ignored;
//   · **instructed** — the parameter names the `description` tells the model to pass.
//
// Written with the TypeScript parser because the same two hazards apply as for the reachability
// derivations: `src/shell.ts:279`'s regex-in-template defeats a hand-rolled scanner, and a
// hand-written list of "parameters that matter" would be this repository's second copy of a schema
// that already exists in the source.

/**
 * Where tools live, **discovered rather than listed**.
 *
 * A hand-written list of source files is a second copy of the repository's own shape: it went stale
 * the moment a tool moved, and on `main` it named `src/host/wsl-bash-tool.ts`, which does not exist
 * there — so the gate could not run at all on the branch it was supposed to police. Reading the
 * directory answers the question the gate actually asks ("every tool this repository registers")
 * instead of the question someone remembered to answer.
 */
function toolSources() {
  const out = []
  for (const dir of ['src/host', 'src']) {
    for (const name of readdirSync(join(repoRoot, dir))) {
      if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(`${dir}/${name}`)
    }
  }
  return out.sort()
}

/**
 * Parameter names a `description` instructs the model to pass.
 *
 * Two shapes, because the sources use both: a bare backticked name (`` `tty: true` `` is one token
 * with a value, `` `bash_background` `` is a bare tool name) and a `name: value` pair in prose.
 * Everything that is not identifier-shaped is dropped rather than guessed at — a mention that cannot
 * be read as a name is not an instruction we can check, and pretending otherwise would make this
 * derivation report findings it cannot support.
 */
export function describedParameterNames(description) {
  // Cross-references are **removed** rather than filtered after the fact, so that what is scanned is
  // exactly the set of names this tool instructs and nothing else. Measured case: `bash_background`'s
  // description says "It is the same producer the `bash` tool's `run_in_background: true` argument
  // uses" — a true statement about *another* tool's parameter, not a demand that this tool accept
  // one. Filtering per mention meant re-testing a context window at every hit, and it kept letting a
  // name through; deleting the span cannot.
  const withoutCrossReferences = description
    .replace(/`([a-z][a-z0-9_]{2,})`?\s*(?:tool|command)?\s*[\u2019']s\s*`([a-z][a-z0-9_]{2,})(?::[^`]*)?`/gi, ' ')
    .replace(/`([a-z][a-z0-9_]{2,})`?\s+(?:tool|command)[\u2019']s?\s+`([a-z][a-z0-9_]{2,})(?::[^`]*)?`/gi, ' ')

  const names = new Set()
  for (const match of withoutCrossReferences.matchAll(/`([a-z][a-z0-9_]{2,})(?::[^`]*)?`/g)) {
    names.add(match[1])
  }
  for (const match of withoutCrossReferences.matchAll(/\b([a-z][a-z0-9_]{2,})\s*:\s*(?:true|false|'[^']*'|"[^"]*"|an?\b|the\b)/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/**
 * One file's tools: their names, the parameters their schemas accept, the ones the implementation
 * reads, and the ones their descriptions instruct.
 *
 * `handled` is collected from the whole file rather than per tool, which is a real limitation and is
 * stated in the report: a file that defines two tools would attribute one's implementation reads to
 * both. Every tool here currently lives in its own file, and the report says how many files were
 * scanned so a future violation of that is visible rather than silent.
 */
export function toolContracts(files = toolSources()) {
  const ts = typescript()
  const out = []
  for (const file of files) {
    const source = read(file)
    const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true)

    const toolNames = new Set()
    const handled = new Set()
    const perTool = []

    // `const TOOL_NAME = 'bash'` first, so a tool object whose `name:` is the **shorthand**
    // `name: TOOL_NAME` can be resolved. Measured: all of `bash`, `bash_background` and
    // `wsl_terminal` name themselves that way, and a parser reading only string literals reported
    // them as `(unnamed)` — which reads as "no tool here", not as "cannot tell".
    const constStrings = new Map()
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer
          && ts.isStringLiteral(declaration.initializer)) {
          constStrings.set(declaration.name.text, declaration.initializer.text)
        }
      }
    }
    const nameOf = property => {
      if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        return constStrings.get(property.name.text)
      }
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        const key = property.name.text
        if (key !== 'name') return undefined
        if (ts.isStringLiteral(property.initializer)) return property.initializer.text
        if (ts.isIdentifier(property.initializer)) return constStrings.get(property.initializer.text)
      }
      return undefined
    }

    // `args.workdir` / `input.pattern` — the two conventions this repository uses for a tool's
    // parameter object, read anywhere in the file. **Not** scoped to the tool object:
    // `bash_background` reads `args.workdir` at line 224 and declares it at line 269, so a scan
    // limited to the tool literal reports a parameter as accepted-and-ignored when it is read fifty
    // lines earlier. The limitation is real and the gate prints it: a third naming convention would
    // be invisible here, because "which identifier holds the parameters" is a convention rather than
    // something the source states.
    const PARAM_OBJECT_NAMES = new Set(['args', 'input'])
    const scanHandled = node => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && PARAM_OBJECT_NAMES.has(node.expression.text)) {
        handled.add(node.name.text)
      }
      ts.forEachChild(node, scanHandled)
    }

    // One record **per tool object**, because a file may define more than one: `wsl-search.ts`
    // carries both `grep` and `glob`, and a single `description` per file meant whichever came last
    // was reported for both — which read as "grep instructs nothing".
    const collectTool = node => {
      const declared = new Set()
      let description = ''
      let name = ''
      const read = inner => {
        const propertyName = nameOf(inner)
        if (propertyName !== undefined) name = propertyName
        if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name)) {
          if (inner.name.text === 'description' && inner.initializer
            && (ts.isStringLiteral(inner.initializer) || ts.isNoSubstitutionTemplateLiteral(inner.initializer))) {
            description = inner.initializer.text
          }
          if (inner.name.text === 'parameters' && ts.isObjectLiteralExpression(inner.initializer)) {
            for (const property of inner.initializer.properties) {
              const key = property.name
              if (key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))) declared.add(key.text)
            }
            // Not descending: every parameter carries a `description` of its own, and descending
            // would overwrite the tool's with whichever came last. Measured on `wsl-bash-tool.ts`:
            // the tool's description is 1499 characters and the last one in the file is 183.
            return
          }
        }
        ts.forEachChild(inner, read)
      }
      read(node)
      if (name !== '') toolNames.add(name)
      if (declared.size > 0) {
        perTool.push({
          tool: name === '' ? '(unnamed)' : name,
          declared: [...declared].sort(),
          instructed: description === '' ? [] : describedParameterNames(description),
        })
      }
    }

    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /_NAME$/.test(node.name.text) && node.initializer
        && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
        toolNames.add(node.initializer.text)
      }
      if (ts.isObjectLiteralExpression(node)
        && node.properties.some(property => ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name) && property.name.text === 'parameters')) {
        collectTool(node)
      }
      scanHandled(node)
      ts.forEachChild(node, visit)
    }
    visit(sf)

    out.push({
      file,
      tools: [...toolNames].sort(),
      handled: [...handled].sort(),
      perTool,
    })
  }
  return out
}
