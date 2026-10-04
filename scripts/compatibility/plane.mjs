// Which plane a compatibility driver tests: the sources, or the committed bundle the harness
// actually loads.
//
// Before this existed every `scripts/compatibility/*-real.mjs` driver imported `../../src/*.ts`
// under `--experimental-strip-types`, so a green `wsl-gate` meant "the source works under WSL"
// and said nothing about `lib/` — the bytes that ship. The switch is here to make that
// difference explicit and checkable rather than to flip it silently: the default stays `src`
// tonight, `lib` runs as an additional pass, and only a runner frame that is green on both
// planes twice can justify changing the default (docs/CHECK-CATALOG.md, issue #44 §1).
//
// The rule that keeps this honest: a module that has no `lib/` entry throws. It never falls
// back to `src/`, because a silent fallback is the exact false green being repaired. Reaching
// those two would mean scraping a content-hashed chunk (`lib/wsl-Ckyi3g6C.js` exports
// `joinUnc as d`) or a class that is file-local to `lib/index.js:1122` — both brittle by
// construction, so the gap is declared instead.
//
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/fs-real.mjs
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { join } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plane in effect. `src` remains the default until the lib plane is proven on a runner. */
export function plane() {
  const value = process.env.DSH_WSL_TEST_PLANE ?? 'src'
  if (value !== 'src' && value !== 'lib') {
    throw new Error(`plane: DSH_WSL_TEST_PLANE must be "src" or "lib", got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Where each subject module lives on each plane. Only the thing a driver is *testing* belongs
 * here: fixture helpers (`joinUnc` et al.) stay pinned to src/ in the driver, because importing
 * `lib/wsl-Ckyi3g6C.js` for a minified alias would be scraping a content hash, not testing a
 * plane. `null` on the lib side means no entry point was ever built for that module — a
 * build-config decision, not this file's to invent.
 */
const LOCATIONS = {
  fs: { src: 'src/fs.ts', lib: 'lib/fs.js' },
  search: { src: 'src/host/wsl-search.ts', lib: 'lib/wsl-search.js' },
  relay: { src: 'src/host/wsl-relay.ts', lib: 'lib/wsl-relay.js' },
  shell: { src: 'src/shell.ts', lib: 'lib/shell.js' },
  'wsl-bash-tool': { src: 'src/host/wsl-bash-tool.ts', lib: 'lib/wsl-bash-tool.js' },
  skills: { src: 'src/host/wsl-skills.ts', lib: null },
}

/** The repo-relative specifier for one subject module on the active plane. */
export function specifierFor(key) {
  const table = LOCATIONS[key]
  if (table === undefined) {
    throw new Error(`plane: unknown subject module ${JSON.stringify(key)}; add it to LOCATIONS `
      + 'with its src and lib specifiers (lib: null when tsdown declares no entry)')
  }
  const active = plane()
  const specifier = table[active]
  if (specifier === null) {
    throw new Error(`plane: plane=lib has no lib/ entry for "${key}". tsdown.config.ts does not `
      + 'declare an entry for it; reaching it would mean importing a content-hashed chunk or a '
      + 'file-local class, so this driver stays on the src plane and says so. Add a tsdown entry '
      + '(a shipped-file decision) to make it testable as published.')
  }
  return specifier
}

/**
 * Resolve and import a subject module on the active plane, printing the one line
 * `scripts/verify-plane-log.mjs` looks for. The line is the evidence that the driver really
 * loaded what it claimed to.
 */
export async function load(key) {
  const specifier = specifierFor(key)
  const absolute = join(repoRoot, specifier)
  console.log(`plane-module: ${key} -> ${specifier}`)
  return await import(pathToFileURL(absolute).href)
}

/** The filesystem path of a subject module, for drivers that spawn it rather than import it. */
export function resolvePath(key) {
  const specifier = specifierFor(key)
  console.log(`plane-module: ${key} -> ${specifier}`)
  return join(repoRoot, specifier)
}
