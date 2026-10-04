/**
 * Dev-only verification of the preset materializer: boots the host plugin's
 * apply() against a fake context with DSH_HOME pointed at a temp directory,
 * then asserts the generated preset rows reference real built lib files and
 * the composition carries the WSL execution-world realm.
 *
 * Run from the plugin directory: `node tests/host-materialize.mjs`
 */

import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Which persistent shell tier this run materializes. `--pty` asks for the host's PTY stack; the
// default is the session tier the plugin now mounts by default. The switch is set before the plugin
// is loaded because the mount decision reads it at boot, not at assertion time.
const SESSION_TIER = !process.argv.includes('--pty')
if (!SESSION_TIER) process.env.DSH_WSL_PTY_SHELL = '1'
const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-home-'))
process.env.DSH_HOME = home

const { apply } = require('../lib/index.js')

// ── fake roster: one standard-like and one minimal-like source preset ──────
const STANDARD_SRC = `# standard
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    directories:
      - .agents/skills
`
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
      config:
        timeoutMs: 300000
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config:
        timeoutMs: 300000

- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
`
const PREFAB_SRC = `# prefab-like source preset (win32-only custom bash + local fs group)
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

- id: custom-bash
  name: ./custom-bash.mjs
  disabled: !!js process.platform !== 'win32'
  config:
    bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe'

- id: bootstrap-filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
`
// DSH v0.1.3-alpha.2 renamed the persona's model-facing scalar: `text` became
// an inline `suffix` plus a folded `prefix`. A source in that shape must be
// amended too - the pre-0.4.3 matcher only looked for `text: >-` and silently
// dropped the WSL sentence (issue #22).
const SUFFIX_PREFIX_SRC = `# v0.1.3-alpha.2+ persona shape
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent powered by the {{model}} model.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`
// The new shape with the runtime-context opt-out: never amended.
const SUFFIX_COMPLETE_SRC = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent.
    complete: true
`
// A user preset a person copied out of a generated variant and then edited: it
// already carries this plugin's world group (with the install path of whatever
// copy it came from) and a row id that got duplicated while editing. Generating
// its variant must REPLACE that world instead of appending a second group - two
// `wsl-world` rows make the loader refuse the preset with
// `duplicate loader entry id: wsl-world`, so the mode cannot be picked at all.
const COPIED_VARIANT_SRC = `# user preset copied from a generated WSL variant
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a data-mode agent.

- id: wsl-world
  name: cordis:group
  group: true
  isolate:
    shell: true
    fs: true
  config:
    - id: shell-wsl
      name: 'C:/stale-install/lib/shell.js'

    - id: fs-wsl
      name: 'C:/stale-install/lib/fs.js'

    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'

    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000

- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000

- id: data-export
  name: '@me/dsh-data-export'

- id: data-export
  name: '@me/dsh-data-export'
`

const sources = {
  standard: { path: join(home, 'src-standard', 'agent.cordis.yml'), text: STANDARD_SRC },
  ptc: { path: join(home, 'src-ptc', 'agent.cordis.yml'), text: STANDARD_SRC },
  minimal: { path: join(home, 'src-minimal', 'agent.cordis.yml'), text: MINIMAL_SRC },
  'third-party-local': { path: join(home, 'src-third-party', 'agent.cordis.yml'), text: PREFAB_SRC },
  'standard-new': { path: join(home, 'src-standard-new', 'agent.cordis.yml'), text: SUFFIX_PREFIX_SRC },
  'standard-new-complete': { path: join(home, 'src-standard-new-complete', 'agent.cordis.yml'), text: SUFFIX_COMPLETE_SRC },
  'copied-variant': { path: join(home, 'src-copied-variant', 'agent.cordis.yml'), text: COPIED_VARIANT_SRC },
}
// Source display metadata with declared roster order (the shipped layout).
mkdirSync(join(home, 'src-standard'), { recursive: true })
mkdirSync(join(home, 'src-ptc'), { recursive: true })
mkdirSync(join(home, 'src-minimal'), { recursive: true })
mkdirSync(join(home, 'src-third-party'), { recursive: true })
writeFileSync(join(home, 'src-standard', 'preset.yml'), 'name: 标准模式\norder: 1\n', 'utf8')
writeFileSync(join(home, 'src-ptc', 'preset.yml'), 'name: PTC 模式\norder: 2\n', 'utf8')
writeFileSync(join(home, 'src-minimal', 'preset.yml'), 'name: 极简模式\norder: 3\n', 'utf8')
writeFileSync(join(home, 'src-third-party', 'preset.yml'), 'name: Third Party Local\norder: 8\n', 'utf8')
mkdirSync(join(home, 'src-standard-new'), { recursive: true })
mkdirSync(join(home, 'src-standard-new-complete'), { recursive: true })
writeFileSync(join(home, 'src-standard-new', 'preset.yml'), 'name: New Shape\norder: 9\n', 'utf8')
writeFileSync(join(home, 'src-standard-new-complete', 'preset.yml'), 'name: New Shape Complete\norder: 10\n', 'utf8')
// A quoted display name: the generator copies the scalar out of this file, so it
// must unquote it rather than hand the quotes to the picker twice over.
mkdirSync(join(home, 'src-copied-variant'), { recursive: true })
writeFileSync(join(home, 'src-copied-variant', 'preset.yml'), "name: 'Data mode（数据模式）'\norder: 8\n", 'utf8')
// A source preset is an opaque, self-contained unit. Assets must travel
// without the WSL plugin knowing their names, extensions, or consumers.
mkdirSync(join(home, 'src-third-party', 'plugin-data'), { recursive: true })
writeFileSync(join(home, 'src-third-party', 'plugin-data', 'trajectory.bin'), 'opaque preset data\n', 'utf8')
const registrations = []
const fakeCtx = {
  get: (key) => {
    if (key === 'webServer') return { register: (route) => { registrations.push(route); return () => {} } }
    if (key === 'agentPresets') return {
      list: async () => Object.entries(sources).map(([id, source]) => ({ id, path: source.path })),
      read: async (id) => sources[id].text,
    }
    // Optional services (shellEnv) degrade to absent in this harness.
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
}

// The legacy standalone `wsl` preset dir from an earlier plugin version must
// be removed: the execution world now folds into the mode variants.
mkdirSync(join(home, '.agent-presets', 'wsl'), { recursive: true })
writeFileSync(join(home, '.agent-presets', 'wsl', 'agent.cordis.yml'), '# legacy\n', 'utf8')

apply(fakeCtx, { route: '/wsl-workspace/api' })

const assert = (condition, label) => {
  if (!condition) throw new Error(`preset materialization: ${label}`)
  console.log(`ok: ${label}`)
}

assert(registrations.length === 1 && registrations[0].kind === 'exact' && registrations[0].path === '/wsl-workspace/api', 'route registered')

// ── variants: generated asynchronously by the apply effect ─────────────────
// Wait for the fire-and-forget generation to settle. It is not a fixed delay:
// generation first probes whether this host's terminal stack can allocate a PTY
// on this platform, so the settle time depends on the host.
const variantDeadline = Date.now() + 15_000
while (!existsSync(join(home, '.agent-presets', 'wsl-standard', 'agent.cordis.yml')) && Date.now() < variantDeadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert(existsSync(join(home, '.agent-presets', 'wsl-standard', 'agent.cordis.yml')), 'variant generation settles')

assert(!existsSync(join(home, '.agent-presets', 'wsl')), 'legacy standalone wsl preset removed')

const stdVariant = join(home, '.agent-presets', 'wsl-standard')
const stdYaml = readFileSync(join(stdVariant, 'agent.cordis.yml'), 'utf8')
const stdMeta = readFileSync(join(stdVariant, 'preset.yml'), 'utf8')
assert(existsSync(stdVariant), 'wsl-standard variant generated')
assert(existsSync(join(stdVariant, 'preset.yml')), 'wsl-standard metadata generated')
assert(stdMeta.includes("name: 'WSL · Standard mode（标准模式）'"), 'shipped modes get bilingual display names')
assert(stdMeta.includes("description: 'WSL execution world for Standard mode（标准模式）"), 'variant description is bilingual')
assert(stdMeta.includes('order: 1'), 'variant inherits the source roster order')
// The `ptc` id is the one the mode carries from 0.1.1 on: a label table with
// only the older `code` entry left this variant named after its bare id (and
// `0.1.7` publishes no display name to fall back on at all).
const ptcMeta = readFileSync(join(home, '.agent-presets', 'wsl-ptc', 'preset.yml'), 'utf8')
assert(ptcMeta.includes("name: 'WSL · PTC mode（PTC 模式）'"), 'the ptc id gets its shipped label rather than its bare id')
assert(ptcMeta.includes('order: 2'), 'the ptc variant inherits its source order')
// Regression guard: a `: ` inside an unquoted plain scalar makes the whole
// preset.yml unparsable, silently dropping name/description/order.
const yaml = require('js-yaml')
const stdParsed = yaml.load(stdMeta)
assert(stdParsed !== null && typeof stdParsed === 'object', 'variant metadata parses as YAML')
assert(stdParsed.name === 'WSL · Standard mode（标准模式）', 'variant metadata name survives YAML parsing')
assert(typeof stdParsed.description === 'string' && stdParsed.description.includes('bash and file tools run inside'), 'variant metadata description survives YAML parsing')
assert(!/^- id: tool-pwsh$/m.test(stdYaml), 'variant drops pwsh row')
assert(!/^- id: tool-bash$/m.test(stdYaml), 'variant drops top-level bash row')
assert(!/^- id: tool-fs-search$/m.test(stdYaml), 'the host search-suite row is replaced by the world\'s own')
assert(stdYaml.includes('- id: search-wsl'), 'the world mounts its in-distribution grep/glob twin')
const searchRow = /name: '(.+wsl-search\.js)'/.exec(stdYaml)
assert(searchRow !== null && existsSync(searchRow[1]), 'the search row points at a real lib file')
assert((stdYaml.match(/name: '@deepseek-ai\/dsh-tool-fs-search'/g) ?? []).length === 0, 'no row mounts the Windows ripgrep suite')
assert(stdYaml.includes('- id: wsl-world'), 'variant injects wsl realm')
assert(stdYaml.includes('inside a WSL'), 'variant persona amended')
const shellRow = /name: '(.+shell\.js)'/.exec(stdYaml)
assert(shellRow !== null && existsSync(shellRow[1]), 'variant shell row points at a real lib file')

// ── skill catalog over UNC: the watcher must be off ───────────────────────
// A //wsl.localhost/... workspace cannot be watched by chokidar; the failed
// watcher makes the observation incomplete and withholds the whole catalog.
// The materializer therefore pins `watch: false` on the skill-filesystem row.
assert(stdYaml.includes('- id: skill-filesystem'), 'variant keeps the skill-filesystem row')
assert(
  /- id: skill-filesystem\n(?:.*\n)*?\s+config:\n\s+watch: false\n/.test(stdYaml),
  'skill watch is disabled as the first config child of a row that already had config',
)
assert(stdYaml.includes('directories:\n      - .agents/skills'), 'the row\'s pre-existing config survives the merge')
assert(!/watch: true/.test(stdYaml), 'no variant leaves the skill watcher enabled')

const newVariant = join(home, '.agent-presets', 'wsl-standard-new')
assert(existsSync(newVariant), 'v0.1.3+ persona-shape variant generated')
const newYaml = readFileSync(join(newVariant, 'agent.cordis.yml'), 'utf8')
assert(newYaml.includes('inside a WSL'), 'v0.1.3+ persona shape is amended (issue #22 guard)')
assert(
  /suffix: >-\n\s+Your working directory is \{\{cwd\}\}\.\n\s+Your working directory \{\{cwd\}\} is inside a WSL/.test(newYaml),
  'the note joins the suffix sentence it belongs to',
)
assert(newYaml.indexOf('inside a WSL') < newYaml.indexOf('prefix: >-'), 'the note stays in the suffix block, not the prefix')

const newCompleteVariant = join(home, '.agent-presets', 'wsl-standard-new-complete')
assert(existsSync(newCompleteVariant), 'v0.1.3+ opt-out variant generated')
const newCompleteYaml = readFileSync(join(newCompleteVariant, 'agent.cordis.yml'), 'utf8')
assert(!newCompleteYaml.includes('inside a WSL'), 'a v0.1.3+ persona with complete: true is left alone')
assert(newCompleteYaml.includes('suffix: Your working directory is {{cwd}}.'), 'its suffix stays a plain inline scalar')
const minVariant = join(home, '.agent-presets', 'wsl-minimal')
const minYaml = readFileSync(join(minVariant, 'agent.cordis.yml'), 'utf8')
assert(existsSync(minVariant), 'wsl-minimal variant generated')
assert(!minYaml.includes('fs-local'), 'minimal variant drops fs-local')
assert(!minYaml.includes('search-wsl'), 'minimal mode gains no search tools: its source mounts none')
assert(minYaml.includes('str-replace-editor'), 'minimal variant re-injects the editor over the WSL fs')
// Which persistent shell the world mounts is the plugin's decision, and the two tiers must not be
// confused for one another: the session tier replaces the source's PTY group with a single row of
// ours, while the PTY tier keeps the host registry, its backend and its tool. This file is run
// twice in `test:node`, once per tier, so both shapes are pinned by a real materialization.
if (SESSION_TIER) {
  assert(!minYaml.includes('persistent-shell'), 'the source PTY group is gone, not re-declared')
  assert(!minYaml.includes('dsh-terminal-bash'), 'no PTY backend is mounted for the session tier')
  assert(!minYaml.includes('dsh-tool-bash-persistent'), 'the host persistent tool is not mounted either')
  assert((minYaml.match(/- id: bash-wsl\n/g) ?? []).length === 1, 'minimal variant mounts exactly one bash-wsl row')
  assert(minYaml.includes('wsl-bash-tool.js'), 'the row points at this installation\'s session tool')
  const minParsedSession = yaml.load(minYaml)
  const sessionWorld = minParsedSession.find(row => row.id === 'wsl-world')
  const sessionRow = sessionWorld.config.find(row => row.id === 'bash-wsl')
  assert(sessionRow !== undefined, 'the parsed world carries the session bash row')
  assert(typeof sessionRow.config.timeoutMs === 'number' && typeof sessionRow.config.bootTimeoutMs === 'number',
    `its config survives YAML as a mapping: ${JSON.stringify(sessionRow.config)}`)
} else {
assert(!minYaml.includes('persistent-shell"') && minYaml.includes('- id: persistent-shell'), 'the source PTY group is replaced by the world\'s own')
// The world mounts its OWN persistent shell instead of the source's group:
// the host's PTY registry and backend pointed at this plugin's relay, plus the
// persistent tool. That tool registers the `bash` name, so the one-shot
// dsh-tool-bash row must be gone (both mounted fails the whole preset).
assert((minYaml.match(/- id: persistent-bash\n/g) ?? []).length === 1, 'minimal variant mounts exactly one persistent-bash row')
assert(minYaml.includes("name: '@deepseek-ai/dsh-tool-bash-persistent'"), 'the persistent bash tool is mounted')
assert(minYaml.includes('- id: terminal-wsl'), 'the host PTY backend is mounted for it')
assert(minYaml.includes('- id: pty'), 'the terminals service it needs is provided')
assert(minYaml.includes('terminals: true'), 'the registry keeps its own terminals realm')
assert(minYaml.includes('backendType: wsl'), 'the persistent shell uses the WSL backend')
// The persistent tool's own description is what the model reads, and the host
// default mentions neither the cross-call `cd` nor the wrapper's `&` hazard, so
// the generated row must carry the override — and it must survive real YAML
// parsing (a mis-indented block scalar would silently become a sibling key).
const minParsed = yaml.load(minYaml)
const world = minParsed.find(row => row.id === 'wsl-world')
const shellGroup = world.config.find(row => row.id === 'persistent-shell')
const shellTool = shellGroup.config.find(row => row.id === 'persistent-bash')
assert(shellTool !== undefined, 'the parsed world carries the persistent tool row')
assert(shellTool.config.backendType === 'wsl', 'its parsed backendType survives YAML')
assert(typeof shellTool.config.description === 'string' && shellTool.config.description.includes('persists across calls'),
  'the shell description parses as one string and warns about cross-call state')
assert(shellTool.config.description.includes('Never end a `&&` chain with `&`'), 'the & footgun is spelled out for the model')
assert(shellTool.config.description.includes('( long-job > log 2>&1 ) &'), 'the safe backgrounding form is given')
assert(Object.keys(shellTool.config).length === 2, `the tool row carries only backendType and description: ${Object.keys(shellTool.config).join(',')}`)
assert(minYaml.includes('wsl-relay.js'), 'the backend runs this installation\'s relay')
}
assert(minYaml.includes('wsl-sandbox.js'), 'the world provides its own sandbox capability')
assert(minYaml.includes('sandbox: true'), 'the sandbox capability is world-local')
assert(!minYaml.includes("name: '@deepseek-ai/dsh-tool-bash'"), 'the one-shot bash tool row is replaced, not duplicated')
assert((minYaml.match(/name: 'bash'/g) ?? []).length <= 1, 'no two rows claim the bash tool name')
assert(
  /- id: skill-filesystem\n  name: '[^']+'\n  config:\n    watch: false\n/.test(minYaml),
  'a skill-filesystem row with no config gets one carrying watch: false',
)

const prefabVariant = join(home, '.agent-presets', 'wsl-third-party-local')
const prefabYaml = readFileSync(join(prefabVariant, 'agent.cordis.yml'), 'utf8')
assert(existsSync(prefabVariant), 'third-party WSL variant generated')
assert(!prefabYaml.includes('custom-bash'), 'third-party variant drops custom-bash (would double-register bash)')
assert(!prefabYaml.includes('bootstrap-filesystem'), 'third-party variant drops bootstrap-filesystem (host-local fs)')
assert(prefabYaml.includes('- id: wsl-world'), 'third-party variant injects wsl realm')
assert(
  SESSION_TIER
    ? (prefabYaml.match(/name: '@deepseek-ai\/dsh-tool-bash(-persistent)?'/g) ?? []).length === 0
      && (prefabYaml.match(/- id: bash-wsl\n/g) ?? []).length === 1
    : (prefabYaml.match(/name: '@deepseek-ai\/dsh-tool-bash(-persistent)?'/g) ?? []).length === 1,
  'third-party variant registers the bash tool exactly once (our session row, or one host tool, never both)',
)
assert(prefabYaml.includes('str-replace-editor'), 'third-party variant re-injects the editor over the WSL fs')
assert(existsSync(join(prefabVariant, 'plugin-data', 'trajectory.bin')), 'third-party opaque asset directory is mirrored')

// ── a preset copied out of a generated variant ────────────────────────────
const copiedVariant = join(home, '.agent-presets', 'wsl-copied-variant')
const copiedYaml = readFileSync(join(copiedVariant, 'agent.cordis.yml'), 'utf8')
const copiedMeta = readFileSync(join(copiedVariant, 'preset.yml'), 'utf8')
assert(existsSync(copiedVariant), 'copied-variant WSL variant generated')
assert((copiedYaml.match(/^- id: wsl-world$/gm) ?? []).length === 1, 'a copied variant carries exactly one world group')
assert(!copiedYaml.includes('C:/stale-install'), 'the copied world group is replaced, not duplicated')
const copiedShellRow = /name: '(.+shell\.js)'/.exec(copiedYaml)
assert(copiedShellRow !== null && existsSync(copiedShellRow[1]), "the copied variant mounts this install's shell provider")
const copiedIds = [...copiedYaml.matchAll(/^- id: ([A-Za-z0-9_.-]+)$/gm)].map(match => match[1])
assert(copiedIds.length === new Set(copiedIds).size, 'no duplicate top-level row id survives the transform')
assert((copiedYaml.match(/name: '@deepseek-ai\/dsh-tool-str-replace-editor'/g) ?? []).length === 1, 'the copied variant mounts the editor once')
assert(copiedYaml.includes('- id: data-export'), 'the user row survives')
const copiedParsed = yaml.load(copiedMeta)
assert(copiedParsed.name === 'WSL · Data mode（数据模式）', 'a quoted source display name loses its quotes')

// Stale variant cleanup: a wsl-ghost dir whose source vanished must go.
mkdirSync(join(home, '.agent-presets', 'wsl-ghost'), { recursive: true })
writeFileSync(join(home, '.agent-presets', 'wsl-ghost', 'agent.cordis.yml'), '- id: x\n', 'utf8')
// Rerun apply to exercise cleanup.
rmSync(join(home, 'src-third-party', 'plugin-data', 'trajectory.bin'))
apply(fakeCtx, { route: '/wsl-workspace/api' })
// Poll instead of sleeping a fixed span: each apply re-runs the platform probe,
// so the settle time is the host's, not a constant this test may assume.
const cleanupDeadline = Date.now() + 15_000
while (existsSync(join(home, '.agent-presets', 'wsl-ghost')) && Date.now() < cleanupDeadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert(!existsSync(join(home, '.agent-presets', 'wsl-ghost')), 'stale variant cleaned up')
assert(existsSync(join(home, '.agent-presets', 'wsl-standard')), 'kept variant survives rerun')
assert(!existsSync(join(prefabVariant, 'plugin-data', 'trajectory.bin')), 'removed source asset does not survive regeneration')

// A failed source mirror must leave the previous complete variant untouched.
sources['third-party-local'].text = `${PREFAB_SRC}\n# incomplete-update-must-not-publish\n`
sources['third-party-local'].path = join(home, 'missing-source', 'agent.cordis.yml')
apply(fakeCtx, { route: '/wsl-workspace/api' })
await new Promise(resolve => setTimeout(resolve, 3_000))
assert(!readFileSync(join(prefabVariant, 'agent.cordis.yml'), 'utf8').includes('incomplete-update-must-not-publish'), 'failed regeneration preserves the previous complete variant')

rmSync(home, { recursive: true, force: true })
console.log('HOST MATERIALIZE PASSED')
