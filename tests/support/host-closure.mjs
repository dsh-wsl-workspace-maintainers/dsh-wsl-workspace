// One way to resolve, mount and judge host packages, so a probe cannot quietly measure the wrong copy.
//
// Every probe in this directory used to carry its own `host()` (three slightly different ones), its own
// version check (one of them), and its own idea of what "the boot did not settle" means. Two of the four
// instrument failures on 2026-10-19 were exactly that duplication:
//   · rows mounted by package NAME resolved a second copy of a class the probe had imported by PATH, so
//     `instanceof` was false for the host's own provider (w78);
//   · a scratch shadow filled incrementally kept serving the previous release's copies (w54).
// This module is the one place that answers "which file is this package", "what release is it", and "why
// did this entry not activate", and every probe imports it instead of re-deriving.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** Both linked trees: the dev closure at the repo root and the pinned one under ci/deps. */
export const hostRoots = () => [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]
const isFile = file => existsSync(file) && statSync(file).isFile()

/**
 * A host package's entry file. `subpath` names a subpath export (e.g. `['lib','profile-boot.js']`); without
 * it the package's `lib/index.js` is used. `overrides` are searched before the linked trees, which is how a
 * probe repairs a closure gap from its own scratch directory.
 * @returns the file path, or null when nothing has it.
 */
export function hostFile (name, { subpath = [], overrides = [] } = {}) {
  for (const root of [...overrides, ...hostRoots()]) {
    if (subpath.length > 0) {
      const candidate = join(root, ...name.split('/'), ...subpath)
      if (isFile(candidate)) return candidate
      continue
    }
    const lib = join(root, ...name.split('/'), 'lib', 'index.js')
    if (isFile(lib)) return lib
  }
  return null
}

export function hostFileOrThrow (name, options = {}) {
  const file = hostFile(name, options)
  if (file === null) throw new Error(`${name}: absent from both node_modules roots — run \`node ci/install-pinned.mjs\` against the pinned tree`)
  return file
}

/** A package's own version, read beside the file that will be mounted. */
export function versionOf (file) {
  try { return JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')).version }
  catch { return '(no package.json beside it)' }
}

/** The release under test: whatever `@deepseek-ai/dsh` this tree actually carries. */
export function releaseUnderTest () {
  const boot = hostFile('@deepseek-ai/dsh', { subpath: ['lib', 'profile-boot.js'] })
  return boot === null ? undefined : versionOf(boot)
}

/**
 * One module instance per file, on Windows too: Node's ESM cache keys on the URL, and `file:///D:/…` and
 * `file:///d:/…` are two different modules (measured 2026-10-19). Realpath plus an upper-case drive letter
 * makes every importer agree.
 */
export function canonicalUrl (file) {
  const real = realpathSync(file)
  return pathToFileURL(real.replace(/^([a-z]):/, (_, letter) => `${letter.toUpperCase()}:`)).href
}

/** The same file as a forward-slash path, for a loader row that takes a path rather than a URL. */
export function canonicalPath (file) {
  return fileURLToPath(canonicalUrl(file)).replaceAll('\\', '/')
}

/**
 * Import a host package the way this repository loads it, and refuse a copy from a different release:
 * a loader takes a path and trusts it, and a stale copy makes the host print `disabling profile plugin row
 * … is incompatible with dsh …` and install nothing while the boot still exits 0. An arm that measured a
 * release nobody shipped is worse than an arm that failed.
 */
export async function hostModule (name, { subpath = [], overrides = [] } = {}) {
  const file = hostFileOrThrow(name, { subpath, overrides })
  const version = versionOf(file)
  const expected = releaseUnderTest()
  if (expected !== undefined && version !== expected) {
    throw new Error(`${name} resolves to ${version} at ${file} but the host under test is @deepseek-ai/dsh ${expected}`)
  }
  const namespace = await import(canonicalUrl(file))
  return { namespace, file, version }
}

/** Two `- insert:` lines mounting one host package by path, at the release under test. */
export function mountedRow (id, name, options = {}) {
  return [`    - id: ${id}`, `      name: '${mountedPath(name, options)}'`]
}

/** The path a loader row should name for this package, at the release under test. */
export function mountedPath (name, options = {}) {
  const file = hostFileOrThrow(name, options)
  const version = versionOf(file)
  const expected = releaseUnderTest()
  if (expected !== undefined && version !== expected) {
    throw new Error(`${name} resolves to ${version} at ${file} but the host under test is @deepseek-ai/dsh ${expected}`)
  }
  return canonicalPath(file)
}

/**
 * Why an entry never activated, in the terms that matter: which of the services it injects are not present
 * at the scope it was mounted into. The host only says "N entries did not activate"; the 0.2.1-rc.2 bump
 * cost an hour of archaeology precisely because `dsh-tool-fs` had grown a fifth hand (`workingDirectory`)
 * and the boot's answer was a silent absence of `read_image`.
 * @returns `[{ id, file, unmet, state }]` for entries whose fiber state is not 2 (activated).
 */
export async function explainInactive (ctx, loader) {
  const report = []
  for (const entry of loader?.entries?.() ?? []) {
    if (entry.fiber?.state === 2) continue
    const name = entry.options?.name
    if (typeof name !== 'string') continue
    let file = null
    try { file = isFile(name) ? name : hostFile(name) } catch { file = null }
    let inject = []
    if (file !== null) {
      try { inject = (await import(canonicalUrl(file))).inject ?? [] } catch { inject = [] }
    }
    const unmet = inject.filter(service => ctx.get(service, false) === undefined)
    report.push({ id: entry.options?.id, file: file ?? name, unmet, state: entry.fiber?.state ?? '(no fiber)' })
  }
  return report
}

/** One line per non-activated entry, for a row's detail. Empty string when every entry activated. */
export async function inactiveDetail (ctx, loader) {
  const report = await explainInactive(ctx, loader)
  if (report.length === 0) return ''
  return report
    .map(item => `${item.id}=state ${item.state}${item.unmet.length > 0 ? ` (unmet: ${item.unmet.join(', ')})` : ''}`)
    .join(', ')
}
