// The host-interface contract: the names this plugin asks the host to honour, and what the host it is
// installed beside actually declares.
//
//   node scripts/check-host-contract.mjs              # gate: red on an unregistered collision
//   node scripts/check-host-contract.mjs --update     # record the contract the current host carries
//   node scripts/check-host-contract.mjs --check      # gate + drift report against the record
//   node scripts/check-host-contract.mjs --self-test  # prove the detector fires on a planted collision
//   node scripts/check-host-contract.mjs --closure <dir>   # read a different host tree (compat job)
//
// Why this exists and the matrix does not. `package.json`'s `dsh.compatibility.dshReleases` is read by
// the README parity checks and shown in the help panel; nothing anywhere verifies that a `compatible`
// row is true, and the compat job that boots real hosts runs a three-version window over 8 mostly
// environmental verdicts in ~10-19 minutes. Meanwhile four of the 20 experience defects (#87/#95, #89,
// #105, and #20 on the old shape) are one sentence: the host's *names* moved and our code still asks
// for the old ones. TypeScript covers the type-level half of that — `npm run typecheck` sees a renamed
// exported type — but it cannot see a string: `ctx.get('remote.agentPresets')`, a row `name:` a host
// package mounts, or two rows claiming one tool name. This script is the device for the string half.
//
// What it does NOT claim: it does not boot anything, so it cannot tell you a service answers correctly,
// only that a name is declared where we ask for it and that no two rows in one world claim the same
// tool. `tests/support/realm-probe.mjs` and `g5-session-probe.mjs` remain the devices for behaviour.
//
// Floors, because an empty scan reads as a pass: every package we scan must yield at least one name,
// every world must yield at least one row, and `--self-test` plants a collision we know is one.
//
// @module scripts/check-host-contract
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

const closureRoot = resolve(repoRoot, valueOf('--closure', join('ci', 'deps', 'node_modules')))
const contractPath = join(repoRoot, 'ci', 'host-contract.json')
const PRESET_DIR = join(closureRoot, '@deepseek-ai', 'dsh-web-app', 'presets')

if (!existsSync(join(closureRoot, '@deepseek-ai'))) {
  console.error(`host-contract: no @deepseek-ai tree at ${closureRoot} — run \`node ci/install-pinned.mjs\` first`)
  process.exit(2)
}

/** The host release this closure carries, for the drift report's own header. */
function hostVersion() {
  for (const name of ['dsh', 'dsh-web-app', 'dsh-tool-fs']) {
    const manifest = join(closureRoot, '@deepseek-ai', name, 'package.json')
    if (existsSync(manifest)) {
      try { return `${name}@${JSON.parse(readFileSync(manifest, 'utf8')).version}` } catch { /* keep looking */ }
    }
  }
  return 'unknown'
}

/**
 * Collisions the world is knowingly shipping, each with the defect that owns it.
 *
 * Empty, and it stays empty unless a gap is earned: the loop below reddens when a registered collision
 * **stops** happening, so an entry cannot outlive its defect, and an unregistered one reddens the gate.
 * #105 sat here from the gate's first run until the product stopped mounting two rows that claim
 * `read_image` — the host's fs row now carries `readImage: false` and the world's own realm-safe answer
 * is the single owner of that name.
 */
const REGISTERED_GAPS = []

/** Which replay unit a name is about, so a drift report can point at the measurement. */
const NAME_UNITS = {
  read_image: '#105 duplicate registration, #54 the world\u2019s own answer',
  agentPresets: '#20 the roster service',
  'remote.agentPresets': '#20 the roster service',
  fs: '#54 the isolated realm',
  shell: '#50 the seam the host calls',
  jobs: '#56 the pull-sources the registry pumps',
  workingDirectory: '#50 the hand the 0.2.x shell grew',
}

const { transformPresetForWsl } = await import('../src/host/variants.ts')

/**
 * The tool names one of our own provider files registers.
 *
 * Keyed on the emitted file name because that is what a world row points at. Only files that import
 * `defineTool` are tool hosts — everything else would be guesswork about what a `name:` field means.
 * @returns a map of `lib/<file>.js` to the model-facing names it claims.
 */
function ourClaims() {
  const files = readdirSync(join(repoRoot, 'src', 'host'))
  const claims = new Map()
  for (const name of files) {
    if (!name.endsWith('.ts')) continue
    const source = readFileSync(join(repoRoot, 'src', 'host', name), 'utf8')
    if (!source.includes('defineTool')) continue
    const names = new Set()
    for (const match of source.matchAll(/TOOL_NAME\s*=\s*'([a-z_][a-z0-9_]*)'/g)) names.add(match[1])
    for (const match of source.matchAll(/\n\s*name:\s*'([a-z_][a-z0-9_]*)'/g)) names.add(match[1])
    if (names.size === 0) continue
    claims.set(`lib/${name.replace(/\.ts$/, '.js')}`, [...names].sort())
  }
  if (claims.size < 4) {
    throw new Error(`host-contract: only ${claims.size} tool-hosting files found in src/host — the scanner is blind, not the plugin`)
  }
  return claims
}

/**
 * The tool names a host package registers, read out of its shipped JavaScript.
 *
 * The host spells these `name: "…"` inside a `defineTool`/register call; a package that yields nothing
 * is reported rather than skipped, because "the shape moved" is exactly the reading that must not be
 * silent — that is how #105 arrived.
 */
function hostClaims(packageName) {
  const dir = join(closureRoot, '@deepseek-ai', packageName)
  if (!existsSync(dir)) return { names: undefined, note: 'not in this closure' }
  const names = new Set()
  const walk = current => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith('.js')) continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/name:\s*["']([a-z_][a-z0-9_]*)["']/g)) names.add(match[1])
    }
  }
  try { walk(dir) } catch { /* unreadable package layout */ }
  return { names: [...names].sort(), note: '' }
}

/**
 * The worlds this plugin generates, as the rows they mount.
 *
 * Driven from the shipped presets rather than a transcription of them (the same choice
 * `tests/artifact-semantics.test.mjs` made): a row list we wrote ourselves would keep agreeing with
 * itself after the transform changed.
 * @param ownClaims - this package's `lib/<file>.js` to tool-name map.
 * @returns one entry per generated variant, with its rows and their resolved claims.
 */
function worlds(ownClaims) {
  const presets = existsSync(PRESET_DIR)
    ? readdirSync(PRESET_DIR).filter(name => name.endsWith('.patch.yml')).sort()
    : []
  if (presets.length < 4) {
    throw new Error(`host-contract: ${presets.length} shipped presets under ${PRESET_DIR} — the closure is not the one the tests were written against`)
  }
  const libPath = file => join(repoRoot, 'lib', file).replaceAll('\\', '/')
  const variants = []
  for (const preset of presets) {
    for (const mode of ['session', 'pty']) {
      const source = compositionOf(join(PRESET_DIR, preset))
      const generated = transformPresetForWsl(
        source,
        libPath('shell.js'),
        libPath('fs.js'),
        {
          relayPath: libPath('wsl-relay.js'),
          nodePath: process.execPath.replaceAll('\\', '/'),
          sandboxPath: libPath('wsl-sandbox.js'),
          bashPath: libPath('wsl-bash-tool.js'),
          terminalTool: libPath('wsl-terminal-tool.js'),
          mode,
        },
        libPath('wsl-search.js'),
        libPath('wsl-jobs.js'),
        libPath('wsl-image-tool.js'),
      )
      for (const variant of splitVariants(generated)) {
        variants.push({
          preset: preset.replace(/\.patch\.yml$/, ''),
          mode,
          id: variant.id,
          rows: variant.rows.map(row => {
            const claims = claimsOf(row.name, ownClaims)
            const off = toolOff(row.config ?? {})
            const all = claims.names ?? []
            return {
              ...row,
              claims: { ...claims, names: all.filter(tool => !off.has(tool)) },
              suppressed: all.filter(tool => off.has(tool)),
            }
          }),
        })
      }
    }
  }
  return variants
}

/** The shipped preset composition the transform consumes: its `config.plugins:` list, dedented. */
function compositionOf(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const indentOf = line => (/^[ ]*/.exec(line) ?? [''])[0].length
  const start = lines.findIndex(line => /^[ ]+plugins:[ ]*$/.test(line))
  if (start === -1) throw new Error(`host-contract: ${file} has no config.plugins block — the preset dialect changed`)
  const base = indentOf(lines[start])
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() !== '' && indentOf(line) <= base) break
    body.push(line.slice(Math.min(base, indentOf(line))))
  }
  return body.join('\n')
}

/** One generated file per `wsl-*` variant id, so a collision is attributed to the variant that ships. */
function splitVariants(text) {
  const lines = text.split('\n')
  const out = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const id = /^- id: ([A-Za-z0-9._-]+)\s*$/.exec(lines[index] ?? '')
    if (id !== null) {
      current = { id: id[1], body: [] }
      out.push(current)
      continue
    }
    if (current !== null) current.body.push(lines[index] ?? '')
  }
  if (out.length === 0) throw new Error('host-contract: the transform emitted no top-level variant — nothing to read')
  return out.map(variant => ({ id: variant.id, rows: rowsFrom(variant.body.join('\n')) }))
}

/** The `- id:`/`name:` pairs inside one variant body. */
function rowsFrom(body) {
  const lines = body.split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const id = /^[ ]*- id: ([A-Za-z0-9._-]+)\s*$/.exec(lines[index] ?? '')
    if (id === null) continue
    const named = /^[ ]*name: '?([^'\n]+?)'?\s*$/.exec(lines[index + 1] ?? '')
    if (named === null) continue
    rows.push({ id: id[1], name: named[1], config: scalarConfigOf(lines, index + 2) })
  }
  if (rows.length < 4) throw new Error(`host-contract: a generated world carried ${rows.length} rows — the row reader is blind`)
  return rows
}

/**
 * The scalar `config:` entries a row carries, read from the lines that follow it.
 *
 * A tool the author switched off is not a claim: `readImage: false` on the host's fs row is what keeps
 * `read_image` single-registered (#105), and a checker that counted package claims without the row's own
 * config would report a collision the world does not have.
 */
function scalarConfigOf(lines, from) {
  const config = {}
  let configIndent = -1
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || /^[ ]*- id: /.test(line)) break
    const indent = (/^(\s*)/.exec(line) ?? [''])[0].length
    if (/^[ ]*config:[ ]*$/.test(line)) {
      configIndent = indent
      continue
    }
    if (configIndent < 0) continue
    if (indent <= configIndent) {
      configIndent = -1
      continue
    }
    const entry = /^([A-Za-z0-9_]+):[ ]*(\S.*)$/.exec(line.trim())
    if (entry !== null) config[entry[1]] = entry[2]
  }
  return config
}

/**
 * The tool names a row's config turns off.
 *
 * The host spells its toggles in camelCase and its tools in snake_case (`readImage` → `read_image`).
 * That convention is asserted in `--self-test`: a checker that quietly stopped suppressing anything
 * would report zero collisions for exactly the wrong reason.
 */
function toolOff(config) {
  return new Set(Object.entries(config)
    .filter(([, value]) => value === 'false')
    .map(([key]) => key.replace(/[A-Z0-9]/g, letter => `_${letter.toLowerCase()}`)))
}

/** What a row's `name:` claims: a host package, or one of our files. */
function claimsOf(name, ownClaims) {
  const scoped = /^@deepseek-ai\/([a-z0-9-]+)$/.exec(name)
  if (scoped !== null) {
    const host = hostClaims(scoped[1])
    return { kind: 'host', key: scoped[1], names: host.names ?? null, note: host.note }
  }
  const local = /lib[\\/](wsl-[a-z-]+\.js|shell\.js|fs\.js)$/.exec(name)
  if (local !== null) {
    const key = `lib/${local[1]}`
    return { kind: 'own', key, names: ownClaims.get(key) ?? null, note: '' }
  }
  return { kind: 'other', key: name, names: null, note: '' }
}

/**
 * Every tool name two rows of the same world both claim.
 * @param variants - the generated worlds.
 * @returns one entry per collision, carrying the rows that claim it.
 */
export function findCollisions(variants) {
  const found = []
  for (const variant of variants) {
    const byTool = new Map()
    for (const row of variant.rows) {
      const names = row.claims.names
      if (names === null) continue
      for (const tool of names) {
        if (!/^[a-z_][a-z0-9_]*$/.test(tool)) continue
        byTool.set(tool, [...(byTool.get(tool) ?? []), row.id])
      }
    }
    for (const [tool, ids] of byTool) {
      if (ids.length > 1) found.push({ variant: `${variant.preset}/${variant.mode}/${variant.id}`, tool, rows: [...new Set(ids)].sort() })
    }
  }
  return found
}

/** A planted collision, and the one config line that excuses it — both asserted, or the rule is a wish. */
function selfTest() {
  const rows = (config, second) => [{
    preset: 'fixture',
    mode: 'session',
    id: 'wsl-standard',
    rows: [
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config, claims: { names: ['read', 'read_image'] } },
      { id: 'read-image-wsl', name: 'file:lib/wsl-image-tool.js', claims: { names: second } },
    ],
  }]
  const apply = variant => {
    variant.rows = variant.rows.map(row => {
      const off = toolOff(row.config ?? {})
      return { ...row, claims: { names: (row.claims.names ?? []).filter(tool => !off.has(tool)) } }
    })
    return variant
  }
  const withBoth = rows({}, ['read_image'])
  const fired = findCollisions(withBoth).some(hit => hit.tool === 'read_image' && hit.rows.join(',') === 'read-image-wsl,tool-fs')
  // The config text is parsed the way a generated world's is, so the control exercises the reader too.
  const configured = scalarConfigOf(['      config:', '        readImage: false', ''], 0)
  const excused = findCollisions([apply(rows(configured, ['read_image'])[0])])
  const spelling = toolOff(configured).has('read_image')
  const ok = fired && excused.length === 0 && spelling
  console.log(`host-contract: self-test collision-fires=${fired} config-excused=${excused.length === 0} camel-to-snake=${spelling}`)
  process.exit(ok ? 0 : 1)
}

if (flag('--self-test')) selfTest()

const own = await ourClaims()
const variants = worlds(own)
const collisions = findCollisions(variants)

// The services this plugin asks the host for, by string. TypeScript cannot see any of these.
const services = new Set()
const scanServices = file => {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/ctx\.get\(\s*'([a-zA-Z0-9._-]+)'/g)) services.add(match[1])
  for (const match of source.matchAll(/ctx\.inject\(\[([^\]]*)\]/g)) {
    for (const item of match[1].split(',')) {
      const name = /^\s*'([a-zA-Z0-9._-]+)'/.exec(item)
      if (name !== null) services.add(name[1])
    }
  }
  for (const match of source.matchAll(/super\(\s*ctx\s*,\s*'([a-zA-Z0-9._-]+)'/g)) services.add(match[1])
}
for (const dir of ['host', 'client', 'shared']) {
  for (const name of readdirSync(join(repoRoot, 'src', dir))) {
    if (name.endsWith('.ts') || name.endsWith('.tsx')) scanServices(join(repoRoot, 'src', dir, name))
  }
}
for (const name of ['index.ts', 'fs.ts', 'shell.ts']) scanServices(join(repoRoot, 'src', name))
if (services.size < 8) throw new Error(`host-contract: ${services.size} service names derived — the string reader is blind`)

const toolNamesByOwnFile = Object.fromEntries([...own.entries()].sort())
const observed = {
  host: hostVersion(),
  services: [...services].sort(),
  toolNamesByOwnFile,
  worlds: variants.map(variant => ({
    key: `${variant.preset}/${variant.mode}/${variant.id}`,
    rows: variant.rows.map(row => ({
      id: row.id,
      name: row.name,
      claims: row.claims.names,
      // Named, so a config line that switched off nothing is visible in the record instead of reading
      // as "no collision anywhere".
      ...(row.suppressed.length === 0 ? {} : { suppressed: row.suppressed }),
    })),
  })),
  collisions: collisions.map(hit => `${hit.variant} ${hit.tool} ${hit.rows.join('+')}`).sort(),
}

const unregistered = collisions.filter(hit => !REGISTERED_GAPS.some(gap =>
  gap.tool === hit.tool && gap.rows.slice().sort().join(',') === hit.rows.slice().sort().join(',')))

if (flag('--update')) {
  writeFileSync(contractPath, `${JSON.stringify({
    note: 'derived by `node scripts/check-host-contract.mjs --update`; the contract this plugin stands on, as the pinned host carried it. Do not hand-edit.',
    host: observed.host,
    contract: observed,
  }, null, 2)}\n`, 'utf8')
  console.log(`host-contract: wrote ci/host-contract.json (${observed.services.length} service names, ${observed.worlds.length} worlds, ${collisions.length} collision(s))`)
  process.exit(0)
}

let drift = []
if (flag('--check') && existsSync(contractPath)) {
  const recorded = JSON.parse(readFileSync(contractPath, 'utf8')).contract
  const diff = (before, after, label) => {
    const missing = before.filter(item => !after.includes(item))
    const added = after.filter(item => !before.includes(item))
    for (const item of missing) drift.push(`- ${label}: ${item} [gone from the host]`)
    for (const item of added) drift.push(`+ ${label}: ${item} [new in the host]`)
  }
  diff(recorded.services ?? [], observed.services, 'service')
  diff(recorded.collisions ?? [], observed.collisions, 'collision')
  for (const [file, names] of Object.entries(recorded.toolNamesByOwnFile ?? {})) {
    const now = observed.toolNamesByOwnFile[file] ?? []
    diff(names, now, `${file} tool`)
  }
}

for (const gap of REGISTERED_GAPS) {
  // "Still colliding" is about the tool, not the exact row pair: when the world grows a third row
  // claiming `read_image`, the registered gap has not closed — it has got worse, and the unregistered
  // check below is what reddens. Matching the pair here would tell the operator to delete the row.
  const still = collisions.some(hit => hit.tool === gap.tool)
  console.log(`registered gap  ${gap.tool} (${gap.rows.join(' + ')}) #${gap.issue}: ${still ? 'still colliding' : 'NO LONGER COLLIDING — delete this row, it is the shape that lets a fixed gap outlive its ticket'}`)
  if (!still) {
    console.error('host-contract: a registered gap closed itself and nobody updated the table')
    process.exit(1)
  }
}

if (drift.length > 0) {
  console.log('')
  console.log(`host-contract: the host interface moved since ci/host-contract.json was recorded (${observed.host}):`)
  for (const line of drift) {
    const name = line.split(': ')[1]?.split(' ')[0] ?? ''
    console.log(`  ${line}${NAME_UNITS[name] === undefined ? '' : `  -> replay unit ${NAME_UNITS[name]}`}`)
  }
}

if (unregistered.length > 0) {
  console.error('')
  console.error(`host-contract: ${unregistered.length} unregistered tool-name collision(s) in the generated worlds:`)
  for (const hit of unregistered) {
    console.error(`  ${hit.variant} registers "${hit.tool}" from rows ${hit.rows.join(', ')} — the host refuses the whole variant`)
    console.error(`  ${NAME_UNITS[hit.tool] ?? 'no replay unit names this tool yet'}`)
  }
  process.exit(1)
}

console.log(`host-contract: ${observed.services.length} service names, ${observed.worlds.length} worlds, ${collisions.length} collision(s) all registered; host ${observed.host}`)
