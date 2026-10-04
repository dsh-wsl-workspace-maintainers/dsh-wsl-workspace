/**
 * Dev-only verification of the one-shot-bash FALLBACK: the host integration
 * tests (`tests/host-materialize.mjs`, `tests/host-declare.mjs`) can never see
 * this branch. Both drive `apply()` on the CI `runtime-tests` runner, which is
 * ubuntu, where `supportsPersistentShell` short-circuits to "supported" at
 * `src/index.ts:557` (`process.platform !== 'win32'`) before the PTY probe ever
 * runs — so the probe is never executed in CI, and neither is the "a WSL world
 * with no PTY" world it produces. This file forces the win32 branch and drives
 * BOTH outcomes of the probe against the published artifact.
 *
 * It drives the DECLARATION channel (the 0.1.7+ roster face — `readDocument()`
 * + `register()`, like `tests/host-declare.mjs`) and asserts on the variant the
 * plugin publishes: what `agentPresets.register` receives is exactly the
 * generated WSL world, and the persistent-shell rows are decided there
 * (`src/host/variants.ts:149,155-165,186-191,202`).
 *
 * What the probe does (`src/index.ts:554-575`):
 *   - win32 + a `subprocess` service with a defined `spawnTerminal` + that call
 *     rejecting with `/terminal inspection is unsupported on platform/i`
 *     ⇒ `supportsPersistentShell` returns FALSE ⇒ the world is built WITHOUT
 *     the persistent-shell rows (one-shot `tool-bash` kept).
 *   - that call resolving normally, OR no `subprocess` service at all
 *     ⇒ returns TRUE ⇒ the persistent-shell rows ARE mounted.
 *
 * This is the asymmetry it pins: the probe says "supported" on everything
 * except the one exact inspection rejection.
 *
 * Run from the plugin directory: `node tests/persistent-shell-fallback.mjs`
 * Requires cordis + a built `lib/` (see docs/CHECK-CATALOG.md bucket B); lives
 * in `npm run test:node` → ci.yml#runtime-tests.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// This driver's subject is `supportsPersistentShell`'s `spawnTerminal` probe, which is the PTY
// tier's mount decision. The session tier decides on a different seam (`spawn`, and a command that
// must answer), so pinning the tier here keeps those assertions about the thing they test. The
// session tier's own decision table is an open gap, recorded in docs/CHECK-CATALOG.md.
process.env.DSH_WSL_PTY_SHELL = '1'

const { apply, isTerminalInspectionUnsupported } = require('../lib/index.js')

// ── force the branch the ubuntu CI runner never reaches ────────────────────
// `supportsPersistentShell` returns early on any non-win32 host; overriding the
// getter here makes the win32 PTY probe run on every runner. This only affects
// in-process `process.platform` reads (the probe's own gate); it does not switch
// which `node:path` implementation is bound at load — `apply()` normalises every
// generated path with `.replace(/\\/g, '/')`, so the assertions hold identically
// on posix and on a real win32 host.
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

// ── the hand-rolled counter (same shape as the sibling host tests) ──────────
let failures = 0
const assert = (condition, label) => {
  if (condition) {
    console.log(`ok: ${label}`)
    return
  }
  console.log(`not ok: ${label}`)
  failures += 1
}

// A standard-like source that carries every row the persistent branch would
// touch: `tool-fs-search` (so the world gains `search-wsl` either way),
// `tool-jobs` (so the persistent branch would add `jobs-wsl`), and the one-shot
// `tool-bash` the fallback keeps.
const SOURCE = `# standard-like
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: >-
      Your working directory is {{cwd}}.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
`

/** The inspection rejection the probe recognises as "no PTY here". */
const INSPECTION_MESSAGE = 'subprocess-local: terminal inspection is unsupported on platform win32'

/**
 * Run `apply()` once against a fresh fake roster and return the world the plugin
 * published, plus when it settled.
 * @param subprocess - the `subprocess` service the fake context returns for the
 *   probe (absent ⇒ `undefined`; reject / resolve ⇒ a `spawnTerminal` face).
 * @returns the generated WSL world's row ids and backendType values, and the
 *   wall-clock milliseconds from the `apply()` call to the declaration landing.
 */
async function runOnce(subprocess) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-fallback-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // Registered immediately, before any await: the cleanup at the bottom of this function only
  // runs on the path that reaches it, so a throw in the middle of a scenario would leave the
  // DSH_HOME tree behind. On this machine os.tmpdir() is D:\Temp, where leaked fixture
  // directories are invisible in `git status` and accumulate in silence.
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ } })

  const registered = []
  const disposers = []
  const fakeCtx = {
    get: (key) => {
      if (key === 'webServer') return { register: () => () => {} }
      if (key === 'agentPresets') {
        return {
          list: async () => [{ id: 'standard', name: 'Standard mode', order: 1 }],
          readDocument: async () => ({ agentPreset: 'standard', content: SOURCE, name: 'Standard mode' }),
          register: async (definition) => {
            registered.push(definition)
            return async () => {}
          },
        }
      }
      if (key === 'subprocess') return subprocess
      // Optional services (skills, shellEnv) degrade to absent.
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  const started = Date.now()
  apply(fakeCtx, { route: '/wsl-workspace/api' })

  // Generation is a fire-and-forget effect that first probes the platform's
  // terminal stack, so wait for the publish rather than assuming a delay. The
  // deadline is deliberately well above the waitForSubprocess bound (`src/index
  // .ts:608-615`, ~20×100ms) so the timing assertion measures, not caps.
  const deadline = Date.now() + 15_000
  while (registered.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const elapsed = Date.now() - started

  for (const dispose of disposers) dispose()
  process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })

  const world = registered.length === 1
    ? registered[0].plugins.find((row) => row.id === 'wsl-world')
    : undefined

  const ids = new Set()
  const backendTypes = []
  const collect = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) collect(child)
      return
    }
    if (node !== null && typeof node === 'object') {
      if (typeof node.id === 'string') ids.add(node.id)
      if (Object.prototype.hasOwnProperty.call(node, 'backendType')) backendTypes.push(node.backendType)
      for (const [key, value] of Object.entries(node)) {
        if (key === 'backendType') continue
        collect(value)
      }
    }
  }
  if (world !== undefined) collect(world.config)

  return {
    published: registered.length === 1 && world !== undefined,
    ids,
    backendTypes,
    elapsed,
  }
}

const hasPersistentRows = (world) =>
  world.ids.has(PTY_SHELL_ROW) || world.ids.has('terminal-wsl') || world.backendTypes.includes('wsl')

// ── the three probe outcomes ───────────────────────────────────────────────
const rejected = await runOnce({
  spawnTerminal: async () => {
    throw new Error(INSPECTION_MESSAGE)
  },
})
const resolved = await runOnce({
  spawnTerminal: async () => ({ terminate: async () => {} }),
})
const absent = await runOnce(undefined)

// Each scenario must publish exactly one variant carrying the WSL world, or the
// rest of the assertions are meaningless (the fixture, not the probe, broke).
assert(rejected.published && resolved.published && absent.published, 'each probe outcome publishes one WSL world variant (fixture sanity)')

const PTY_SHELL_ROW = 'persistent-bash'
// ── (1) rejecting spawnTerminal ⇒ no persistent-shell rows anywhere ────────
assert(!rejected.ids.has(PTY_SHELL_ROW), '(1) fallback world has no persistent-bash row')
assert(!rejected.ids.has('terminal-wsl'), '(1) fallback world has no terminal-wsl row')
assert(!rejected.backendTypes.includes('wsl'), '(1) fallback world declares no backendType: wsl')
assert(!rejected.ids.has('sandbox-wsl'), '(1) fallback world has no sandbox-wsl row')
assert(!rejected.ids.has('jobs-wsl'), '(1) fallback world has no jobs-wsl row (no producer without a persistent shell)')

// ── (2) the fallback is a WSL world without a PTY, not "no WSL world" ──────
assert(rejected.ids.has('tool-bash'), '(2) fallback keeps the one-shot tool-bash row')
assert(rejected.ids.has('shell-wsl'), '(2) fallback still mounts the WSL shell provider')
assert(rejected.ids.has('fs-wsl'), '(2) fallback still mounts the WSL fs provider')
assert(rejected.ids.has('search-wsl'), '(2) fallback still mounts the in-distribution search twin')

// ── (3) positive control: identical fixture, resolving spawnTerminal ────────
// This is what makes (1)/(2) attributable to the probe rather than to the
// fixture: the ONLY thing that changed between the two runs is what
// spawnTerminal does, and the persistent rows appear.
assert(resolved.ids.has(PTY_SHELL_ROW), '(3) positive control: resolving spawnTerminal mounts persistent-bash')
assert(resolved.ids.has('terminal-wsl'), '(3) positive control: resolving spawnTerminal mounts terminal-wsl')
assert(resolved.backendTypes.includes('wsl'), '(3) positive control: resolving spawnTerminal declares backendType: wsl')
assert(!resolved.ids.has('tool-bash'), '(3) positive control: the persistent bash takes the one-shot row\'s place (same `bash` name)')

// ── (4) absent service ⇒ persistent shell mounted AND boot stays bounded ───
// `waitForSubprocess` polls ~20×100ms then answers "supported" (`src/index.ts
// :559,604`), so an absent service must still mount the world AND settle within
// the documented wait. A regression that lets this wait block profile boot — an
// unbounded poll, say — trips the timing half here.
assert(absent.ids.has(PTY_SHELL_ROW), '(4) absent subprocess service still mounts the persistent shell')
assert(
  absent.elapsed > 1_000 && absent.elapsed < 3_000,
  `(4) the absent-service wait is bounded to the ~2s poll, not shorter and not blocking (${absent.elapsed}ms)`,
)

// ── (5) isTerminalInspectionUnsupported, in isolation (exported) ────────────
assert(
  isTerminalInspectionUnsupported(new Error(INSPECTION_MESSAGE)) === true,
  '(5) the inspection Error is recognised',
)
assert(
  isTerminalInspectionUnsupported(new Error('spawn ENOENT')) === false,
  '(5) an ordinary spawn failure is NOT the inspection error',
)
assert(
  isTerminalInspectionUnsupported(new Error('EPERM: operation not permitted')) === false,
  '(5) an unrelated Error message is NOT the inspection error',
)
assert(
  isTerminalInspectionUnsupported(undefined) === false,
  '(5) a non-Error value is false: messageOf() stringifies it ("undefined") and the pattern is absent',
)
// Honest pin, NOT the ticket\'s stated "false": the pattern at `src/index.ts:583`
// / `lib/index.js:1694` is `/terminal inspection is unsupported on platform/i` —
// it stops at "on platform" and never inspects the OS token, so a "linux" message
// matches too. Asserting `false` here would be an invented assertion.
assert(
  isTerminalInspectionUnsupported(new Error('terminal inspection is unsupported on platform linux')) === true,
  '(5) a non-win32 platform word still matches: the regex checks the phrase, not the OS token (spec said "false"; the code says "true")',
)

// ── (6) the three branches are mutually distinguishable ────────────────────
// reject / resolve / absent are three different probe answers. Their (world,
// timing) signatures must all differ — the delta, not "it did not throw":
//   reject  → no persistent shell, settles fast (spawnTerminal rejects at once)
//   resolve → persistent shell,  settles fast (spawnTerminal resolves at once)
//   absent  → persistent shell,  settles slowly (waitForSubprocess exhausts ~2s)
const rejectKey = `${rejected.ids.has(PTY_SHELL_ROW) ? 'persistent' : 'one-shot'}/fast`
const resolveKey = `${resolved.ids.has(PTY_SHELL_ROW) ? 'persistent' : 'one-shot'}/fast`
const absentKey = `${absent.ids.has(PTY_SHELL_ROW) ? 'persistent' : 'one-shot'}/slow`
assert(
  new Set([rejectKey, resolveKey, absentKey]).size === 3,
  `(6) the three branches yield three distinct (shell, timing) answers: ${rejectKey} | ${resolveKey} | ${absentKey}`,
)
// The reject/resolve pair is separated by the WORLD, at the SAME speed: this is
// the probe reacting to the inspection rejection, isolated from timing entirely.
assert(
  rejected.ids.has(PTY_SHELL_ROW) !== resolved.ids.has(PTY_SHELL_ROW)
  && rejected.elapsed < 1_000 && resolved.elapsed < 1_000,
  `(6) reject vs resolve differ in content while both settle fast (${rejected.elapsed}ms vs ${resolved.elapsed}ms)`,
)
// The resolve/absent pair is separated by TIMING, at the SAME content: this is
// the waitForSubprocess bound, isolated from the world shape.
assert(
  resolved.ids.has(PTY_SHELL_ROW) === absent.ids.has(PTY_SHELL_ROW)
  && resolved.elapsed < absent.elapsed,
  `(6) resolve vs absent share a world but differ in wait (${resolved.elapsed}ms vs ${absent.elapsed}ms)`,
)

if (failures > 0) {
  console.log(`PERSISTENT SHELL FALLBACK FAILED (${failures} failing)`)
  process.exitCode = 1
} else {
  console.log('PERSISTENT SHELL FALLBACK PASSED')
}
