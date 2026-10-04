/**
 * Dev-only verification of the preset materializer's DECLARATION path: boots
 * the host plugin's apply() against a roster face shaped like DSH v0.1.7-rc.1
 * (`list()` reporting no directory, `readDocument()` returning a document,
 * `register()` publishing a declaration) with DSH_HOME pointed at a temp
 * directory, then asserts the plugin registered one declaration per healthy
 * source and that the declarations carry an importable world.
 *
 * v0.1.7-rc.1 stopped scanning `$DSH_HOME/.agent-presets/` — a preset is a
 * declarative `@deepseek-ai/dsh-agent-preset` row — so the directory path the
 * sibling test (`tests/host-materialize.mjs`) covers no longer reaches the
 * roster on that release. This file is the coverage for the channel that does.
 *
 * Run from the plugin directory: `node tests/host-declare.mjs`
 */

import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The persistent-shell tier this run declares; `--pty` asks for the host's PTY stack. */
const SESSION_TIER = !process.argv.includes('--pty')
if (!SESSION_TIER) process.env.DSH_WSL_PTY_SHELL = '1'
const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-declare-'))
process.env.DSH_HOME = home

const { apply } = require('../lib/index.js')

// ── source compositions (the entry-list YAML dialect the host documents) ────
// A standard-like source: a persona, the execution world rows the transform
// replaces, the search suite the world re-provides, a `!!js` disabled
// expression that must survive the parse, and the skill row whose watcher is
// pinned off.
const STANDARD_SRC = `# standard
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: >-
      Your working directory is {{cwd}}.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform === 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

# A kept row carrying a !!js expression: the dialect must survive the parse.
- id: data-export
  name: '@me/dsh-data-export'
  disabled: !!js process.platform === 'win32'
`
// A minimal-like source whose world arrives as a nested group, so the
// transform has to keep a group's children addressable too.
const MINIMAL_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true

- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
`
// A custom source: no shipped label exists for its id, so the display name it
// published is what the variant must carry.
const DATA_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a data-mode agent.

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

const PTC_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a PTC agent.

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

const sources = {
  standard: { name: 'Standard mode', order: 1, text: STANDARD_SRC },
  ptc: { name: 'PTC 模式', order: 2, text: PTC_SRC },
  minimal: { name: '极简模式', order: 3, text: MINIMAL_SRC },
  data: { name: 'Data mode', order: 8, text: DATA_SRC },
}

/** Every declaration the plugin published, in call order. */
const registered = []
/** Every declaration id whose disposer ran. */
const disposed = []
/** Effect disposers apply() installed (the variant effect owns registrations). */
const disposers = []

const fakeCtx = {
  get: (key) => {
    if (key === 'webServer') return { register: () => () => {} }
    if (key === 'agentPresets') {
      return {
        // The v0.1.7-rc.1 roster face: display metadata and `order` live on the
        // entry, the composition comes from a document, and there is no `path`.
        list: async () => [
          ...Object.entries(sources).map(([id, source]) => ({ id, name: source.name, order: source.order })),
          { id: 'broken-source', broken: 'row "present" names a plugin that cannot be resolved' },
          { id: 'wsl-already', name: 'WSL already', order: 9 },
        ],
        readDocument: async (id) => ({ agentPreset: id, content: sources[id].text, name: sources[id].name }),
        register: async (definition) => {
          registered.push(definition)
          return async () => { disposed.push(definition.id) }
        },
      }
    }
    // Optional services (subprocess, skills, shellEnv) degrade to absent.
    return undefined
  },
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
}

// Legacy leftovers of the retired directory mechanism: both must go, because
// nothing scans that root on this release and a stale `wsl-standard/` beside
// the registered `wsl-standard` declaration would only mislead.
mkdirSync(join(home, '.agent-presets', 'wsl-standard'), { recursive: true })
writeFileSync(join(home, '.agent-presets', 'wsl-standard', 'agent.cordis.yml'), '# stale\n', 'utf8')
mkdirSync(join(home, '.agent-presets', 'wsl'), { recursive: true })
writeFileSync(join(home, '.agent-presets', 'wsl', 'agent.cordis.yml'), '# legacy\n', 'utf8')

apply(fakeCtx, { route: '/wsl-workspace/api' })

const assert = (condition, label) => {
  if (!condition) throw new Error(`preset declaration: ${label}`)
  console.log(`ok: ${label}`)
}

// Generation is a fire-and-forget effect that first probes the platform's
// terminal stack, so wait for the publish rather than assuming a delay.
const deadline = Date.now() + 15_000
while (registered.length < Object.keys(sources).length && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert(registered.length === Object.keys(sources).length, 'one declaration per healthy source')

const byId = new Map(registered.map(definition => [definition.id, definition]))
assert([...byId.keys()].sort().join(',') === 'wsl-data,wsl-minimal,wsl-ptc,wsl-standard', 'variant ids derive from the source ids')
assert(!byId.has('wsl-already'), 'a source that is already a variant is skipped')
assert(byId.size === registered.length, 'no source is registered twice')

// ── display metadata now comes from the roster face, not a preset.yml ───────
assert(byId.get('wsl-standard').name === 'WSL · Standard mode（标准模式）', 'shipped modes get bilingual display names')
assert(byId.get('wsl-ptc').name === 'WSL · PTC mode（PTC 模式）',
  'the `ptc` id gets a shipped label, not its bare id (0.1.7 publishes no display name to fall back on)')
assert(byId.get('wsl-minimal').name === 'WSL · Minimal mode（极简模式）', 'the shipped label wins over the published name')
assert(byId.get('wsl-data').name === 'WSL · Data mode', 'a custom preset keeps the display name it published')
assert(byId.get('wsl-standard').order === 1 && byId.get('wsl-ptc').order === 2
  && byId.get('wsl-minimal').order === 3 && byId.get('wsl-data').order === 8,
  'each variant inherits the source roster order')
assert(byId.get('wsl-standard').description.includes('WSL execution world for Standard mode（标准模式）'), 'the description is bilingual')
assert(byId.get('wsl-ptc').description.includes('WSL execution world for PTC mode（PTC 模式）'),
  'a labelled mode gets a labelled description instead of its bare id')
assert(!existsSync(join(home, '.agent-presets', 'wsl-standard', 'preset.yml')), 'no preset.yml is written on this channel')

// ── the declaration is an importable entry list ────────────────────────────
const standard = byId.get('wsl-standard')
assert(Array.isArray(standard.plugins), 'the declaration carries a plugin row list')
assert(standard.plugins.every(row => typeof row.id === 'string' && typeof row.name === 'string'),
  'every declared row has an id and a module specifier')

const world = standard.plugins.find(row => row.id === 'wsl-world')
assert(world !== undefined, 'the declaration injects the WSL world realm')
assert(world.group === true && world.isolate.shell === true && world.isolate.fs === true, 'the world is an isolating group')

// The providers are named by THIS installation's absolute paths, and a preset
// mounted from a declaration is imported by the registry's own entry tree —
// which, unlike the boot-time Include, does not turn an absolute path into a
// `file:` URL. Handing it `C:/…` left those rows without a fiber, so the audit
// reported "never started" and refused the whole variant.
const providerIds = ['shell-wsl', 'fs-wsl', 'sandbox-wsl', 'search-wsl', 'jobs-wsl']
for (const id of providerIds) {
  const row = world.config.find(entry => entry.id === id)
  assert(row !== undefined, `${id} is declared inside the world`)
  assert(row.name.startsWith('file://'), `${id} names its provider as a file: URL`)
  assert(existsSync(fileURLToPath(row.name)), `${id} points at a real built file`)
}
assert(standard.plugins.some(row => row.id === 'tool-fs-search') === false, 'the host search suite is replaced by the world\'s own')
assert(world.config.some(row => row.id === 'tool-fs' && row.name === '@deepseek-ai/dsh-tool-fs'),
  'bare package specifiers are left untouched')

// Which persistent shell tier this run declares; `--pty` asks for the host's PTY stack. The two
// tiers are asserted separately because they are different mounts, not two spellings of one.

// Config values are not module specifiers: the PTY backend spawns the relay and
// the interpreter, so those must stay native filesystem paths.
if (SESSION_TIER) {
  const sessionRow = world.config.find(row => row.id === 'bash-wsl')
  assert(sessionRow !== undefined, 'the world mounts its own session bash tool')
  assert(sessionRow.name.startsWith('file://'), 'the session tool is declared as a file: URL like our other providers')
  assert(existsSync(fileURLToPath(sessionRow.name)), 'and it points at a real built file')
  assert(!world.config.some(row => row.id === 'persistent-shell'), 'no PTY group is declared in the session tier')
} else {
const shellGroup = world.config.find(row => row.id === 'persistent-shell')
assert(shellGroup !== undefined, 'the world mounts its own persistent shell')
const terminal = shellGroup.config.find(row => row.id === 'terminal-wsl')
assert(terminal.config.shellPath === process.execPath.replace(/\\/g, '/'), 'the interpreter stays a native path')
assert(terminal.config.shellArgs[0].endsWith('/lib/wsl-relay.js'), 'the relay stays a native path')
assert(!terminal.config.shellArgs[0].startsWith('file://'), 'the relay is not rewritten to a file: URL')
assert(terminal.config.backendType === 'wsl', 'the persistent shell uses the WSL backend')
}

// ── the composition survives the YAML round-trip ───────────────────────────
// `readDocument().content` is the entry-list dialect, whose `!!js` scalars the
// Loader evaluates at activation. Re-parsing must preserve that marker rather
// than freeze one platform's answer into the declaration.
assert(standard.plugins.some(row => row.id === 'tool-pwsh') === false, 'a world row is replaced rather than re-declared')
const jsRow = standard.plugins.find(row => row.id === 'data-export')
assert(jsRow !== undefined, 'a kept row survives the transform')
assert(typeof jsRow.disabled === 'object' && jsRow.disabled.__jsExpr === "process.platform === 'win32'",
  'a !!js disabled expression round-trips as an expression node')
assert(world.config.some(row => row.id === 'jobs-wsl'), 'a source with job tools gets the world\'s background-job producer')

const minimal = byId.get('wsl-minimal')
const minWorld = minimal.plugins.find(row => row.id === 'wsl-world')
assert(minimal.plugins.some(row => row.id === 'persistent-shell') === false, 'the source PTY group is replaced, not duplicated')
assert(minWorld.config.some(row => row.id === (SESSION_TIER ? 'bash-wsl' : 'persistent-shell')), 'the world provides its own shell instead')
assert(minWorld.config.some(row => row.id === 'search-wsl') === false, 'a mode with no search suite gains none')
assert(minimal.plugins.some(row => row.id === 'skill-filesystem') === false, 'minimal declares no skill row to amend')

const standardPersona = standard.plugins.find(row => row.id === 'persona')
assert(standardPersona.config.suffix.includes('inside a WSL'), 'the persona is amended for a WSL working directory')
const skillRow = standard.plugins.find(row => row.id === 'skill-filesystem')
assert(skillRow.config.watch === false, 'the skill watcher is pinned off for the UNC share')

// ── nothing is written to the retired root, and its leftovers are cleared ──
assert(!existsSync(join(home, '.agent-presets', 'wsl-standard')), 'the retired per-variant directory is not rewritten')
assert(!existsSync(join(home, '.agent-presets', 'wsl')), 'the legacy standalone wsl directory is removed')

// ── the effect owns the registrations ─────────────────────────────────────
// apply() installs more than one effect (the variant publisher and the dialog
// route), so the assertion is about the outcome: disposing the plugin retires
// every declaration it published instead of leaving orphans in the roster.
assert(disposers.length >= 1, 'apply installs effect disposers')
for (const dispose of disposers) dispose()
assert(disposed.sort().join(',') === 'wsl-data,wsl-minimal,wsl-ptc,wsl-standard', 'disposing the plugin retires every declaration')

rmSync(home, { recursive: true, force: true })
console.log('HOST DECLARE PASSED')
