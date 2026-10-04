// Compare this plugin's copy of the host's bash readiness contract against the host
// package that actually defines it.
//
//   node scripts/check-host-prompt-parity.mjs [--lenient]
//
// WHY THIS EXISTS. Three places in this plugin need the host's prompt facts: the
// boot-time readiness probe (src/host/pty-readiness.ts), the WSLENV bridge's key list
// (src/shared/wsl-env.ts), and the ConPTY gate (scripts/compatibility/conpty-relay.mjs).
// All three previously spelled the values out by hand, and one of them got it wrong in a
// way that hid a shipped defect: the gate injected an uppercase `'DSH> '` while the host
// compares against lowercase `"dsh> "`, so the gate could never have observed the
// contract arriving — issue #51 point 2 stayed green through it. A hand copy of a fact
// that lives in another package is the same class of thing this repo already gates for
// the skill ranks (scripts/check-rank-parity.mjs), so it gets the same treatment here:
// one declaration in src/shared/wsl-env.ts, and this gate compares it to the host.
//
// The default is strict: an unresolvable host package is NOT VERIFIED and exits 1, because
// "nothing to compare" must not look like "nothing drifted". `--lenient` downgrades that
// one case to a warning for a machine without the pinned tree installed.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strict = !process.argv.includes('--lenient')

/** Find the host lib: the pinned/linked tree, or whatever npm hoisted. */
function hostLibPath() {
  const candidates = [
    join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
    join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const ourSource = readFileSync(join(repoRoot, 'src', 'shared', 'wsl-env.ts'), 'utf8')
const hostArgIndex = process.argv.findIndex(arg => arg === '--host')
const hostPath = hostArgIndex > 0 ? resolve(process.argv[hostArgIndex + 1]) : hostLibPath()

if (hostPath === undefined) {
  const message = 'check-host-prompt-parity: NOT VERIFIED — @deepseek-ai/dsh-terminal-bash is not '
    + 'installed in either the repo root or the pinned ci/deps tree, so no comparison ran. '
    + 'Run `node ci/install-pinned.mjs` (or `npm run ci:pinned`) first. '
    + 'This is a failure, not a skip; pass --lenient if you want a warning instead.'
  if (strict) {
    console.error(message)
    process.exit(1)
  }
  console.warn(message)
  process.exit(0)
}

const hostSource = readFileSync(hostPath, 'utf8')

/** The right-hand value of one `const NAME = "literal";` line in a source text. */
function hostLiteral(name) {
  // `RegExp.exec` answers `null` when it finds nothing, not `undefined` — a guard
  // written against `undefined` lets the "the host changed shape" branch die with a
  // TypeError instead of the message, which is how the first draft of this gate
  // failed its own control (it still exited 1, but by crashing, so it said nothing).
  const match = new RegExp(`const ${name} = ("(?:[^"\\\\]|\\\\.)*")`).exec(hostSource)
  if (match === null) return undefined
  return JSON.parse(match[1])
}

/** Our own declaration, read as source so the gate cannot be fed a rebuilt artifact. */
function ourLiteral(pattern, what) {
  const match = pattern.exec(ourSource)
  if (match === null) {
    console.error(`check-host-prompt-parity: NOT VERIFIED — ${what} is no longer declared in the shape expected `
      + `(looked for ${pattern} in src/shared/wsl-env.ts). The comparison did not run.`)
    process.exit(1)
  }
  return match[1]
}

const hostPrompt = hostLiteral('CONTROLLED_PROMPT')
if (hostPrompt === undefined) {
  console.error('check-host-prompt-parity: NOT VERIFIED — the host lib no longer declares `const CONTROLLED_PROMPT = "…"`; '
    + 'the host renamed or reshaped it, and this gate has nothing to compare. Check by hand, then update the pattern.')
  process.exit(1)
}

const ourPrompt = ourLiteral(/export const CONTROLLED_PROMPT = '([^']*)'/, 'CONTROLLED_PROMPT')
const ourKeys = ourLiteral(/export const READINESS_KEYS[^=]*= \[([^\]]*)\]/, 'READINESS_KEYS')

/** The keys the host actually writes into a bash child environment. */
function hostReadinessKeys() {
  const body = /function childEnvironment[\s\S]*?\n\}/.exec(hostSource)
  if (body === null) {
    console.error('check-host-prompt-parity: NOT VERIFIED — `function childEnvironment` is gone from the host lib; '
      + 'the readiness contract may no longer be injected this way at all.')
    process.exit(1)
  }
  const keys = []
  for (const name of ['PS1', 'PROMPT_COMMAND']) {
    if (new RegExp(`(^|\\s)${name}: `, 'm').test(body[0])) keys.push(name)
  }
  return keys
}

const hostKeys = hostReadinessKeys()
const ourKeyList = ourKeys.split(',').map(entry => entry.trim().replace(/^'|'$/g, '')).filter(Boolean)

let failed = false
const compare = (label, ours, theirs) => {
  if (ours === theirs) {
    console.log(`ok: ${label} matches the host (${JSON.stringify(theirs)})`)
    return
  }
  console.error(`check-host-prompt-parity: RED — ${label} is ${JSON.stringify(ours)} here but ${JSON.stringify(theirs)} in ${hostPath}`)
  failed = true
}

compare('CONTROLLED_PROMPT', ourPrompt, hostPrompt)
compare('READINESS_KEYS', ourKeyList.join(','), hostKeys.join(','))

// The marker the backend watches for. Not a constant in the host source — it is inside
// the PROMPT_COMMAND it builds — so it is checked as a substring of the host's injection.
if (!hostSource.includes('133;D;')) {
  console.error('check-host-prompt-parity: RED — the host no longer emits an OSC `133;D;` marker; '
    + 'the readiness probe looks for exactly that string and must be updated together with it.')
  failed = true
} else {
  console.log('ok: the host still emits the OSC 133;D marker the probe looks for')
}

if (failed) process.exit(1)
console.log(`check-host-prompt-parity: the plugin's copy of the host readiness contract agrees with ${hostPath}`)
