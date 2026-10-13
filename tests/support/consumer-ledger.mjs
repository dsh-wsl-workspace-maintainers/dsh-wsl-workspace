/**
 * The consumer ledger's extractor: **which host packages ask for a service our world isolates.**
 *
 * This exists because three issues arrived from the same place and no gate could see it. Every
 * harness in this repository enters through a tool *we* register (`ctx.tools.get('bash')`, and
 * `read_image` appears in `tests/`, `scripts/` and `docs/` zero times), so the axis "the host's own
 * tool consumes a service inside the world we generated" was never sampled. #54 is `read_image`
 * asking for `fs`, #78 is `run_code`'s provider asking for `sandbox`, and #60 is a tool name
 * colliding at assembly time. None of them can be reached from our side of the seam.
 *
 * So the ledger is **derived from the trees, not from a list somebody remembers**:
 *
 *   · the service names come from the presets this plugin actually generates — the `isolate:` keys
 *     emitted by `wslWorldGroup` (`src/host/variants.ts`). Those keys are exactly the seams where a
 *     realm boundary can starve a consumer, which is what makes them the right set to ask about.
 *   · the consumers come from the pinned host closure (`ci/deps/node_modules/@deepseek-ai/<pkg>/lib`),
 *     matched on the **service id as a string literal**: `get("fs")`, an `inject` declaration
 *     naming `"fs"`, or `super(ctx, "fs")` for a provider. Anchoring on `ctx.fs` instead would
 *     silently miss every bundled package, because the bundler renames `ctx` — measured 2026-10-13:
 *     the property form found 2 consumers of `fs` and missed `dsh-tool-fs`, the string form finds
 *     both. The known pairs from #54 and #78 are pinned as positive controls in
 *     `tests/consumer-coverage.test.mjs`, so "the extractor returned a small set" can never again be
 *     read as "there is no more to find".
 *
 * `tests/consumer-coverage.test.mjs` is what reads this; it can also be run by hand:
 *
 *   node --experimental-strip-types tests/support/consumer-ledger.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { transformPresetForWsl } from '../../src/host/variants.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOST_ROOT = join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai')

/** Bundle outputs above this size are skipped: they are vendored toolchains, not service consumers. */
const MAX_SOURCE_BYTES = 3_000_000

/** The paths a generated world needs, in the shape `tests/variants.test.ts` uses. */
const SHELL = 'D:/plugin/lib/shell.js'
const FS = 'D:/plugin/lib/fs.js'
const RELAY = 'D:/plugin/lib/wsl-relay.js'
const NODE = 'C:/Program Files/nodejs/node.exe'
const SANDBOX = 'D:/plugin/lib/wsl-sandbox.js'
const BASH = 'D:/plugin/lib/wsl-bash-tool.js'
const TERMINAL = 'D:/plugin/lib/wsl-terminal-tool.js'

/** A standard-like source preset, so the generator has something to transform. */
const STANDARD_LIKE = `# identity
- id: persona
  name: '@deepseek-ai/dsh-persona'
`

/**
 * The service names our generated worlds cut a realm around.
 *
 * Both shapes are read, because the one-shot world and the persistent-shell world do not isolate the
 * same set: `sandbox` is emitted only when a shell that would call confinement is mounted
 * (`src/host/variants.ts`, the conditional `sandbox: true` row). Reading one shape and reporting the
 * other's consumers as covered would be the same mistake as asserting a preset's text without
 * mounting it.
 * @returns the service names, sorted, across both generated shapes.
 */
export function isolatedServices () {
  const texts = [
    transformPresetForWsl(STANDARD_LIKE, SHELL, FS),
    transformPresetForWsl(STANDARD_LIKE, SHELL, FS, {
      relayPath: RELAY, nodePath: NODE, sandboxPath: SANDBOX, bashPath: BASH, terminalTool: TERMINAL, mode: 'pty',
    }),
  ]
  const names = new Set()
  for (const text of texts) {
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const head = /^(\s*)isolate:\s*$/.exec(lines[index] ?? '')
      if (head === null) continue
      const indent = head[1].length
      for (let next = index + 1; next < lines.length; next += 1) {
        const row = /^(\s+)([a-z][a-z0-9_-]*):\s*true\s*$/.exec(lines[next] ?? '')
        if (row === null) break
        // A deeper indent is a nested map (`terminals: true` sits under the registry's own isolate
        // block in the persistent shape); anything at or left of the key's own level ends the block.
        if (row[1].length <= indent) break
        names.add(row[2])
      }
    }
  }
  return [...names].sort()
}

/** Every host package directory in the pinned closure, sorted. */
function hostPackages () {
  if (!existsSync(HOST_ROOT)) return []
  return readdirSync(HOST_ROOT).filter(entry => entry !== '.bin')
}

/** The `lib/*.js` files of one host package, skipping vendored megabyte bundles. */
function packageSources (pkg) {
  const dir = join(HOST_ROOT, pkg, 'lib')
  if (!existsSync(dir)) return []
  const found = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      if (statSync(full).size > MAX_SOURCE_BYTES) continue
      found.push(full)
    }
  }
  walk(dir)
  return found
}

/**
 * The four shapes counted separately, across one package's whole `lib/` tree.
 *
 * `tests/consumer-coverage.test.mjs` pins a known pair on **two** shapes each, so dropping a shape from
 * the union reddens a named assertion instead of quietly shrinking the ledger. That is the lesson from
 * this file's first draft, which claimed the property form missed `dsh-tool-fs` because the check was
 * run through a bash double-quoted string and `\\\\.` arrived at JavaScript as "a literal backslash".
 * @param pkg - the package directory name.
 * @param id - the service name.
 * @returns `{ lookup, inject, provider, property }` occurrence counts.
 */
export function mentionShapes (pkg, id) {
  const quoted = [`"${id}"`, `'${id}'`, `\`${id}\``]
    .map(q => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const builders = [
    ['lookup', new RegExp(`get\\(\\s*(?:${quoted})\\s*[,)]`, 'g')],
    ['inject', new RegExp(`inject[^;]{0,240}?(?:${quoted})`, 'g')],
    ['provider', new RegExp(`super\\([^,()]{0,40},\\s*(?:${quoted})\\s*[,)]`, 'g')],
    ['property', new RegExp(`\\bctx\\.${id}\\b`, 'g')],
  ]
  const totals = { lookup: 0, inject: 0, provider: 0, property: 0 }
  for (const file of packageSources(pkg)) {
    const source = readFileSync(file, 'utf8')
    for (const [key, pattern] of builders) totals[key] += (source.match(pattern) ?? []).length
  }
  return totals
}

/**
 * The derived ledger rows: one per (service, host package) pair that actually asks for it.
 * @returns rows of `{ service, pkg, mentions }`, sorted by service then package.
 */
export function derivedConsumers () {
  const rows = []
  for (const service of isolatedServices()) {
    for (const pkg of hostPackages()) {
      const mentions = Object.values(mentionShapes(pkg, service)).reduce((sum, count) => sum + count, 0)
      if (mentions > 0) rows.push({ service, pkg, mentions })
    }
  }
  return rows.sort((a, b) => a.service.localeCompare(b.service) || a.pkg.localeCompare(b.pkg))
}

/**
 * How many of this repository's own harness files name a host package.
 *
 * This is the difference the ledger exists to make visible: a file may mention `@deepseek-ai/dsh-tool-fs`
 * while never calling a single tool that package registers, and that is *not* coverage. The list is
 * derived rather than remembered, so a harness deleted or renamed cannot leave a stale row claiming
 * coverage.
 * @param pkg - the package directory name, without the `@deepseek-ai/` scope.
 * @returns the repository-relative paths that mention it, sorted.
 */
export function harnessMentions (pkg) {
  const needle = `@deepseek-ai/${pkg}`
  const walk = (dir, found = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/node_modules|\.git/.test(entry.name)) continue
        walk(full, found)
      } else if (/\.(?:mjs|js|ts)$/.test(entry.name)) {
        found.push(full)
      }
    }
    return found
  }
  const files = [...walk(join(repoRoot, 'tests')), ...walk(join(repoRoot, 'scripts'))]
  return files
    .filter(file => readFileSync(file, 'utf8').includes(needle))
    .map(file => relative(repoRoot, file).replaceAll('\\', '/'))
    .sort()
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const services = isolatedServices()
  const rows = derivedConsumers()
  console.log(JSON.stringify({
    services,
    pairs: rows.length,
    packages: new Set(rows.map(row => row.pkg)).size,
    rows,
  }, null, 2))
}
