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

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The repository root, from this file's own location (`tests/parity/`). */
export const repoRoot = join(import.meta.dirname, '..', '..')

/** Read a repository-relative file as UTF-8. Throws if it is not there. */
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

/** Every service name read through `ctx.get('name')` — the guarded form, listed for contrast. */
export function dynamicContextReads(file) {
  const ts = typescript()
  const source = read(file)
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true)
  const found = new Map()
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ctx'
      && node.expression.name.text === 'get' && node.arguments.length >= 1
      && ts.isStringLiteral(node.arguments[0])) {
      const name = node.arguments[0].text
      if (!CORDIS_API.has(name) && !found.has(name)) {
        found.set(name, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...found.entries()].map(([name, line]) => ({ name, line })).sort((a, b) => a.name.localeCompare(b.name))
}
