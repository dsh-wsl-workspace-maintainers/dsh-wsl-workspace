/**
 * Unit tests for the WSL preset-variant transformation. Run with
 * `node --import tsx/esm --test tests/variants.test.ts` from the plugin
 * directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWslVariantId, transformPresetForWsl, variantIdFor } from '../src/host/variants.ts'

const SHELL = 'D:/plugin/lib/shell.js'
const FS = 'D:/plugin/lib/fs.js'

/** A standard-like composition (the shape standard/code/cordis share). */
const STANDARD_LIKE = `# identity
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working
      directory is {{cwd}}.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
`

/** The minimal composition's distinctive rows (persistent shell + editor). */
const MINIMAL_LIKE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

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
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
`

test('variantIdFor lowercases source ids', () => {
  assert.equal(variantIdFor('standard'), 'wsl-standard')
  assert.equal(variantIdFor('Code'), 'wsl-code')
})

test('isWslVariantId recognizes plugin-owned preset ids only', () => {
  assert.equal(isWslVariantId('wsl'), true)
  assert.equal(isWslVariantId('wsl-standard'), true)
  assert.equal(isWslVariantId('standard'), false)
  assert.equal(isWslVariantId('wsl-standard-extra'), true)
})

test('standard-like transform drops world rows and injects the WSL realm', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS)
  // Top-level rows sit at column 0; the injected group's rows are indented.
  assert.ok(!/^- id: tool-pwsh$/m.test(out), 'pwsh row dropped')
  assert.ok(!/^- id: tool-bash$/m.test(out), 'top-level bash row dropped')
  assert.ok(!/^- id: tool-fs$/m.test(out), 'top-level fs row dropped')
  assert.ok(!/^- id: tool-fs-search$/m.test(out), 'the Windows ripgrep suite row is dropped')
  assert.ok(out.includes('- id: tool-jobs'), 'jobs row kept')
  assert.ok(out.includes('- id: wsl-world'), 'wsl realm injected')
  assert.ok(out.includes(`name: '${SHELL}'`), 'shell provider path present')
  assert.ok(out.includes(`name: '${FS}'`), 'fs provider path present')
  assert.ok(out.includes('isolate:\n    shell: true\n    fs: true'), 'realm isolates shell+fs')
  assert.ok(out.includes('Your working directory {{cwd}} is inside a WSL'), 'persona amended')
  assert.ok(!out.includes('persistent-shell'), 'no persistent shell for standard-like')
  assert.ok(!out.includes('search-wsl'), 'no search row without a search path to mount')
})

const SEARCH = 'D:/plugin/lib/wsl-search.js'

test('a mode that mounts the search suite gets the in-distribution twin instead', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, undefined, SEARCH)
  assert.ok(out.includes('    - id: search-wsl'), 'the world mounts its own grep/glob')
  assert.ok(out.includes(`      name: '${SEARCH}'`), 'the search row points at this installation')
  assert.ok(!out.includes('@deepseek-ai/dsh-tool-fs-search'), 'no row mounts the Windows ripgrep suite')
  assert.ok(out.indexOf('- id: search-wsl') > out.indexOf('- id: tool-fs'), 'the search row sits with the other tools')
  // A search path with nothing to replace must not add a tool the mode never had.
  assert.ok(!transformPresetForWsl(MINIMAL_LIKE, SHELL, FS, undefined, SEARCH).includes('search-wsl'),
    'a mode without the search suite gains no search tools')
})

test('minimal-like transform keeps persona fixed and uses the cwd-aware fs tools', () => {
  const out = transformPresetForWsl(MINIMAL_LIKE, SHELL, FS)
  assert.ok(!out.includes('fs-local'), 'fs-local dropped')
  assert.ok(out.includes('str-replace-editor'), 'editor re-injected over the session-aware WSL fs')
  assert.ok(!out.includes('persistent-shell'), 'persistent shell dropped (duplicate bash name + unsupported win32 PTY)')
  assert.ok(!out.includes('persistent-bash'), 'persistent-bash dropped')
  assert.ok(!out.includes('complete: true') || out.includes('complete: true'), 'persona untouched')
  assert.ok(!out.includes('inside a WSL'), 'minimal persona not amended (complete prompt)')
})

const RELAY = 'D:/plugin/lib/wsl-relay.js'
const NODE = 'C:/Program Files/nodejs/node.exe'
const SANDBOX = 'D:/plugin/lib/wsl-sandbox.js'
const BASH = 'D:/plugin/lib/wsl-bash-tool.js'
const TERMINAL = 'D:/plugin/lib/wsl-terminal-tool.js'

test('the world mounts a persistent WSL shell when the relay paths are supplied', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' })
  assert.ok(out.includes('    - id: persistent-shell'), 'persistent-shell group injected')
  assert.ok(out.includes('      isolate:\n        terminals: true'), 'the registry keeps its own terminals realm')
  assert.ok(out.includes('        - id: pty'), 'the terminals service is provided')
  assert.ok(out.includes("          name: '@deepseek-ai/dsh-terminal'"), 'host terminal registry mounted')
  assert.ok(out.includes('        - id: terminal-wsl'), 'PTY backend row injected')
  assert.ok(out.includes("          name: '@deepseek-ai/dsh-terminal-bash'"), 'host PTY backend mounted')
  assert.ok(out.includes("          name: '@deepseek-ai/dsh-tool-bash-persistent'"), 'persistent tool mounted')
  assert.ok(out.includes('        - id: persistent-bash'), 'persistent tool row injected')
  assert.ok(out.includes(`            shellPath: '${NODE}'`), 'the relay runs on this installation\'s node')
  assert.ok(out.includes(`              - '${RELAY}'`), 'the relay is this installation\'s script')
  assert.ok(out.includes('            shellDialect: bash'), 'the shell is bash, not pwsh')
  // The PTY backend confines through ctx.sandbox, which cannot describe a Linux
  // path, so the world isolates the capability and provides its own.
  assert.ok(out.includes('    sandbox: true'), 'the sandbox capability is world-local')
  assert.ok(out.includes('    - id: sandbox-wsl'), 'the world sandbox row is injected')
  assert.ok(out.includes(`      name: '${SANDBOX}'`), 'it points at this installation')
  assert.equal((out.match(/backendType: wsl/g) ?? []).length, 2, 'backend and tool agree on the backend type')
  // The persistent tool registers the `bash` name, so it replaces the one-shot
  // row: mounting both fails the whole preset ("tool bash is already registered").
  assert.ok(!out.includes("      name: '@deepseek-ai/dsh-tool-bash'"), 'the one-shot bash tool is replaced')
  assert.equal((out.match(/name: '@deepseek-ai\/dsh-tool-bash('|-persistent')/g) ?? []).length, 1, 'exactly one bash tool row')
  const ids = [...out.matchAll(/^\s*- id: ([a-z0-9-]+)$/gm)].map(match => match[1] ?? '')
  assert.equal(new Set(ids).size, ids.length, `duplicate loader entry id in ${ids.join(',')}`)
})

test('the persistent shell tells the model how state and backgrounding behave', () => {
  // The host tool's default description mentions neither fact, and DSH's own
  // Minimal preset suggests the exact form that trips the host wrapper
  // (`sleep 10 &`): a trailing `&` backgrounds the whole wrapped command, so the
  // call reports exit code 0 and no output while the work is still to come.
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' })
  const block = /            description: \|-\n((?:              .*\n)+)/.exec(out)
  assert.ok(block !== null, 'the persistent tool carries an explicit description')
  const description = (block[1] ?? '').split('\n').map(line => line.trim()).join('\n')
  assert.ok(description.startsWith('Run commands in a persistent bash shell inside this WSL distribution'),
    'it replaces the host default rather than appending to it')
  assert.ok(description.includes('persists across calls'), 'it warns that cwd and exports carry over')
  assert.ok(description.includes('explicit `cd`'), 'it tells the model to cd explicitly')
  assert.ok(description.includes('( long-job > log 2>&1 ) &'), 'it gives the safe backgrounding form')
  assert.ok(description.includes('Never end a `&&` chain with `&`'), 'it names the footgun explicitly')
  assert.ok(description.includes('run_in_background'), 'it points at the background-job tool')
  assert.ok(description.includes('resets the shell and discards its state'), 'it warns that a timeout loses state')
  // Every line of the block scalar is indented past its key, so the loader reads
  // it as one folded string instead of a sibling key.
  for (const line of (block[1] ?? '').split('\n').filter(Boolean)) {
    assert.ok(line.startsWith('              '), `block scalar line is indented: ${line.slice(0, 40)}`)
  }
})

test('the description override does not disturb the rest of the row', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' })
  assert.ok(/- id: persistent-bash\n          name: '@deepseek-ai\/dsh-tool-bash-persistent'\n          config:\n            backendType: wsl\n            description: \|-/.test(out),
    'backendType stays the first config key of the tool row')
  assert.equal((out.match(/backendType: wsl/g) ?? []).length, 2, 'the backend/tool pair still agrees')
  assert.equal((out.match(/description: \|-/g) ?? []).length, 1, 'only the tool row gains a description')
})

test('a persistent world also mounts the background-job producer', () => {
  // The persistent bash tool's schema declares only `command`: without a
  // producer the host's `job_*` tools always answer "no background jobs", and a
  // `run_in_background` argument is silently ignored (a real session found
  // that). The one-shot fallback needs no producer — its tool carries the
  // parameter itself.
  const JOBS = 'D:/plugin/lib/wsl-jobs.js'
  const persistent = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' }, SEARCH, JOBS)
  assert.ok(persistent.includes('    - id: jobs-wsl'), 'the persistent world mounts the producer')
  assert.ok(persistent.includes(`      name: '${JOBS}'`), 'it points at this installation')
  assert.ok(persistent.includes('- id: persistent-bash'), 'and the persistent shell it belongs to')
  assert.ok(persistent.includes('- id: tool-jobs'), 'the mode that gets it also keeps the job control tools')
  const oneShot = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, undefined, SEARCH, JOBS)
  assert.ok(!oneShot.includes('jobs-wsl'), 'the one-shot fallback mounts no producer: its tool has run_in_background')
  assert.ok(oneShot.includes("      name: '@deepseek-ai/dsh-tool-bash'"), 'the one-shot tool is what provides it there')
  const noSearch = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' }, undefined, JOBS)
  assert.ok(noSearch.includes('jobs-wsl'), 'the producer does not depend on the search suite being mounted')
})

test('a producer is never mounted without the job tools that read it', () => {
  // Minimal mode mounts neither: a job id nothing can read is worse than no
  // producer, and the mode's own one-tool shell contract is not ours to widen.
  const JOBS = 'D:/plugin/lib/wsl-jobs.js'
  const minimal = transformPresetForWsl(MINIMAL_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' }, undefined, JOBS)
  assert.ok(!minimal.includes('tool-jobs'), 'the source mounts no job control tools')
  assert.ok(!minimal.includes('jobs-wsl'), 'so the world mounts no producer either')
  assert.ok(minimal.includes('- id: persistent-bash'), 'while the persistent shell itself stays')
  // A source that keeps the job tools but loses them another way still gets the
  // producer only when the row survives the transform.
  const withJobs = transformPresetForWsl(`${MINIMAL_LIKE}\n- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'\n`, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' }, undefined, JOBS)
  assert.ok(withJobs.includes('jobs-wsl'), 'a mode that mounts the job tools gets the producer')
})

test('the persistent-shell group is indented validly for the loader', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' })
  const lines = out.split('\n')
  const start = lines.findIndex(line => line === '    - id: persistent-shell')
  assert.ok(start > 0, 'group row present')
  const group = lines.slice(start, start + 24)
  // The group's nested config items sit two levels deeper than the row.
  assert.ok(group.includes('      config:'), 'the group owns a config list')
  assert.ok(group.includes('        - id: pty'), 'first nested row indented under config')
  assert.ok(group.includes("          name: '@deepseek-ai/dsh-terminal'"), 'nested keys one level deeper')
  assert.ok(group.some(line => line.startsWith('            shellPath:')), 'the backend\'s keys are two levels below its row')
})

test('a source persistent-shell row is replaced instead of duplicated', () => {
  const source = `${STANDARD_LIKE}\n- id: persistent-bash\n  name: '@deepseek-ai/dsh-tool-bash-persistent'\n- id: terminal-pwsh\n  name: '@deepseek-ai/dsh-terminal-bash'\n`
  const out = transformPresetForWsl(source, SHELL, FS, { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' })
  assert.equal((out.match(/id: persistent-bash/g) ?? []).length, 1, 'exactly one persistent-bash row')
  assert.equal((out.match(/id: persistent-shell/g) ?? []).length, 1, 'exactly one persistent-shell group')
  assert.ok(!out.includes('terminal-pwsh'), 'the source terminal row is dropped')
})

test('without relay paths the world keeps its previous shape', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS)
  assert.ok(!out.includes('terminal-wsl'), 'no PTY backend row')
  assert.ok(!out.includes('persistent-bash'), 'no persistent tool row')
  // A host whose terminal stack cannot allocate a PTY on this platform (the
  // 0.1.0-rc.7 window-inspection gap) must still get a working shell tool, which
  // is what the one-shot row is: every command runs through this plugin's own
  // `ctx.shell` provider, never through the host PTY seam.
  assert.ok(out.includes("      name: '@deepseek-ai/dsh-tool-bash'"), 'the one-shot bash tool is mounted instead')
  assert.equal((out.match(/name: '@deepseek-ai\/dsh-tool-bash('|-persistent')/g) ?? []).length, 1,
    'exactly one bash-capable row, never both')
  assert.ok(!out.includes('sandbox: true'), 'no sandbox realm is needed without the PTY backend')
})

/** A prefab-family composition: win32-only custom bash + local fs group. */
const PREFAB_LIKE = `- id: persona
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

test('third-party transform drops the extra host execution-world rows', () => {
  const out = transformPresetForWsl(PREFAB_LIKE, SHELL, FS)
  assert.ok(!out.includes('custom-bash'), 'custom-bash dropped (would double-register bash)')
  assert.ok(!out.includes('bootstrap-filesystem'), 'bootstrap-filesystem dropped (host-local fs)')
  assert.ok(!/name: '\.\/custom-bash\.mjs'/.test(out), 'custom-bash row file not referenced')
  assert.ok(out.includes('- id: wsl-world'), 'wsl realm injected')
  assert.ok(out.includes('str-replace-editor'), 'editor re-injected over the WSL fs')
  const bashRegistrants = out.match(/name: '@deepseek-ai\/dsh-tool-bash'/g)?.length ?? 0
  assert.equal(bashRegistrants, 1, 'exactly one bash tool registration')
})

test('a top-level editor is replaced instead of registered twice', () => {
  const out = transformPresetForWsl(`- id: str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
`, SHELL, FS)
  const editorRegistrants = out.match(/name: '@deepseek-ai\/dsh-tool-str-replace-editor'/g)?.length ?? 0
  assert.equal(editorRegistrants, 1)
})

/** The same editor row under the id a newer release row set uses. */
test('a tool-str-replace-editor row is replaced too', () => {
  const out = transformPresetForWsl(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a coding agent.

- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000
`, SHELL, FS)
  assert.ok(!/^- id: tool-str-replace-editor$/m.test(out), 'source editor row dropped')
  const editorRegistrants = out.match(/name: '@deepseek-ai\/dsh-tool-str-replace-editor'/g)?.length ?? 0
  assert.equal(editorRegistrants, 1, 'exactly one editor registration')
})

/** A preset a user copied out of a generated variant and edited. */
const COPIED_VARIANT_LIKE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a coding agent.

- id: wsl-world
  name: cordis:group
  group: true
  isolate:
    shell: true
    fs: true
  config:
    - id: shell-wsl
      name: 'D:/old-install/lib/shell.js'

    - id: fs-wsl
      name: 'D:/old-install/lib/fs.js'

    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'

    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000

- id: their-own-tool
  name: '@me/dsh-their-own-tool'
`

test('a copied variant is re-worlded instead of carrying two world groups', () => {
  const out = transformPresetForWsl(COPIED_VARIANT_LIKE, SHELL, FS)
  const groups = out.match(/^- id: wsl-world$/gm)?.length ?? 0
  assert.equal(groups, 1, 'exactly one world group')
  assert.ok(!out.includes('D:/old-install'), 'the stale world is replaced, not kept')
  assert.ok(out.includes(`name: '${SHELL}'`), 'the fresh shell provider is the one mounted')
  assert.ok(out.includes(`name: '${FS}'`), 'the fresh fs provider is the one mounted')
  assert.ok(out.includes('- id: their-own-tool'), 'the user row survives')
  const editorRegistrants = out.match(/name: '@deepseek-ai\/dsh-tool-str-replace-editor'/g)?.length ?? 0
  assert.equal(editorRegistrants, 1, 'the editor is mounted once')
})

test('a renamed copy of the world group is recognized by its providers', () => {
  const renamed = COPIED_VARIANT_LIKE.replace('- id: wsl-world', '- id: my-wsl-world')
  const out = transformPresetForWsl(renamed, SHELL, FS)
  assert.ok(!out.includes('my-wsl-world'), 'the copied group is dropped whatever its id')
  assert.equal(out.match(/^- id: wsl-world$/gm)?.length ?? 0, 1, 'one world group injected')
  assert.ok(!out.includes('D:/old-install'), 'no stale provider path left')
})

test('a repeated top-level row id is reduced to one', () => {
  const duplicated = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a coding agent.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 4096
`
  const out = transformPresetForWsl(duplicated, SHELL, FS)
  const ids = [...out.matchAll(/^- id: ([A-Za-z0-9_.-]+)$/gm)].map((m) => m[1])
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(repeated, [], 'no duplicate top-level id survives')
  assert.equal(ids.filter((id) => id === 'agent-instructions').length, 1, 'the first row of a repeated id wins')
})

test('transform preserves unknown rows verbatim', () => {
  const out = transformPresetForWsl(`${STANDARD_LIKE}\n- id: my-custom-tool\n  name: '@me/dsh-custom'\n`, SHELL, FS)
  assert.ok(out.includes("- id: my-custom-tool\n  name: '@me/dsh-custom'"), 'unknown row kept')
})

test('transform handles an empty source', () => {
  const out = transformPresetForWsl('', SHELL, FS)
  assert.ok(out.includes('- id: wsl-world'), 'realm still injected')
})

/** The v0.1.3-alpha.2+ persona shape: an inline `suffix` plus a folded `prefix`. */
const SUFFIX_PREFIX_LIKE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent powered by the {{model}} model.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`

test('v0.1.3+ persona shape: the note joins the inline suffix sentence', () => {
  const out = transformPresetForWsl(SUFFIX_PREFIX_LIKE, SHELL, FS)
  assert.match(
    out,
    /suffix: >-\n {6}Your working directory is \{\{cwd\}\}\.\n {6}Your working directory \{\{cwd\}\} is inside a WSL/,
    'inline suffix folded into a block scalar carrying the note',
  )
  assert.ok(out.includes('prefix: >-\n      You are a coding agent'), 'prefix left untouched')
  assert.ok(out.indexOf('inside a WSL') < out.indexOf('prefix: >-'), 'note landed in the suffix, not the prefix')
})

test('v0.1.3+ persona shape: a folded suffix block takes the note as a sibling line', () => {
  const out = transformPresetForWsl(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: >-
      Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent.
`, SHELL, FS)
  assert.match(
    out,
    /suffix: >-\n {6}Your working directory is \{\{cwd\}\}\.\n {7}Your working directory \{\{cwd\}\} is inside a WSL/,
    'note appended inside the folded suffix',
  )
  assert.equal(out.match(/suffix:/g)?.length, 1, 'suffix header not duplicated')
})

test('a persona opted out of runtime context is never amended', () => {
  const out = transformPresetForWsl(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    complete: true
`, SHELL, FS)
  assert.ok(!out.includes('inside a WSL'), 'complete: true leaves the persona alone')
  assert.ok(out.includes('suffix: Your working directory is {{cwd}}.'), 'suffix left verbatim')
})

test('a prefix-only persona is still amended', () => {
  const out = transformPresetForWsl(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: >-
      You are a coding agent.
`, SHELL, FS)
  assert.match(out, /prefix: >-\n {6}You are a coding agent\.\n {7}Your working directory \{\{cwd\}\} is inside a WSL/, 'note appended to the folded prefix')
})

test('legacy text personas keep the exact appended line they always had', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS)
  // Byte-for-byte what the pre-0.1.3 path produced: the block's own indentation
  // plus the fragment's leading space.
  assert.match(out, /\n {7}Your working directory \{\{cwd\}\} is inside a WSL/, 'legacy append unchanged')
})

/** A composition carrying the upstream local-skill provider row. */
const SKILL_FILESYSTEM_LIKE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent.

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
`

test('a WSL variant turns the local skill watcher off', () => {
  // chokidar cannot watch \\wsl.localhost\...; the provider then reports an
  // incomplete observation and dsh-tool-skill withholds the whole catalog, so
  // the model never learns which skills exist (issue #22 follow-up).
  const out = transformPresetForWsl(SKILL_FILESYSTEM_LIKE, SHELL, FS)
  assert.ok(
    out.includes("- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    watch: false\n"),
    'watcher disabled on the provider row',
  )
  assert.ok(out.includes('- id: tool-jobs'), 'other rows kept')
})

test('the disabled watcher merges into an existing config block', () => {
  const out = transformPresetForWsl(`- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "x"
`, SHELL, FS)
  assert.ok(out.includes('config:\n    watch: false\n    customSkillDirs:\n'), 'watch merged first, author config kept')
  const rows = out.split('- id: ').filter(row => row.startsWith('skill-filesystem'))
  assert.equal(rows.length, 1, 'exactly one skill-filesystem row')
  assert.ok(rows[0]?.includes('config:\n    watch: false\n    customSkillDirs:\n'), 'single merged config key')
})

test('an explicit watch setting wins', () => {
  const out = transformPresetForWsl(`- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    watch: true
`, SHELL, FS)
  assert.ok(out.includes('watch: true'), 'author value kept')
  assert.ok(!out.includes('watch: false'), 'not overridden')
})

test('the session tier mounts the pipe tool and the keyboard door, never the host tool', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS,
    { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'session' }, SEARCH, 'D:/plugin/lib/wsl-jobs.js')
  assert.ok(out.includes(`- id: bash-wsl\n      name: '${BASH}'`), 'our bash tool row is mounted')
  assert.ok(!out.includes('dsh-tool-bash-persistent'), 'the host persistent tool is gone — it is the thing that hangs')
  assert.ok(!out.includes(`'@deepseek-ai/dsh-tool-bash'`), 'the one-shot bash is replaced, not added beside it')
  assert.equal(out.match(/id: bash-wsl/g)?.length, 1, 'exactly one bash producer')
  // The keyboard door rides the same host stack the pty tier used — registry, backend and relay —
  // but with this plugin's tool at the keyboard instead of the host tool whose completion check hangs.
  assert.ok(out.includes('    - id: terminal-door'), 'the door group is mounted beside the pipe shell')
  assert.ok(out.includes('- id: terminal-wsl'), 'the door uses the host PTY backend')
  assert.ok(out.includes("name: '@deepseek-ai/dsh-terminal'"), 'and the host terminal registry')
  assert.ok(out.includes(`name: '${TERMINAL}'`), 'the door row points at this installation\'s tool')
  assert.ok(out.includes('idleSilenceMs: 1200'), 'the quiet fallback is bounded (source note in variants.ts)')
  assert.ok(out.includes('quietMs: 1200'), 'and the tool names the same number to the model')
  assert.equal(out.match(/- id: pty\n/g)?.length, 1, 'exactly one terminals registry is provided')
})

test('the pty tier still reaches the host stack when asked for', () => {
  const out = transformPresetForWsl(STANDARD_LIKE, SHELL, FS,
    { relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty' }, SEARCH, 'D:/plugin/lib/wsl-jobs.js')
  assert.ok(out.includes('dsh-tool-bash-persistent'), 'the escape hatch keeps the old tier reachable')
  assert.ok(out.includes(`shellPath: '${NODE}'`), 'the relay interpreter is still handed to the backend')
  assert.ok(!out.includes('id: bash-wsl'), 'and our tool is not mounted alongside it')
})
