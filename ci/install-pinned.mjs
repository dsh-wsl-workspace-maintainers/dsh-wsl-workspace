// Materialises the pinned @deepseek-ai/* host packages (ci/pinned-deps.json)
// in a clean checkout WITHOUT touching this package.json's dependency surface
// (optional peers must stay optional; the maintainer machine's node_modules
// is a junction into a dsh profile and must not be reified by npm).
//
// Mechanism: a generated standalone npm project under ci/deps/ installs the
// pinned set (npm ci against the committed ci/deps/package-lock.json when it
// matches, npm install otherwise), then the ci/deps/node_modules/@deepseek-ai
// scope directory is linked into the repo root's node_modules so the test
// buckets' bare specifiers resolve. If the root already has a real (non-link)
// @deepseek-ai tree — maintainer junction machine, or a prior full install —
// the link step is skipped and only the presence of each pinned package is
// verified. Same command locally and in CI: `node ci/install-pinned.mjs`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path, { delimiter as PATH_DELIMITER, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const depsDir = path.join(here, 'deps')
const { deps } = JSON.parse(readFileSync(path.join(here, 'pinned-deps.json'), 'utf8'))

// Same npm-spawning pattern as scripts/verify-install.mjs: on win32 a bare
// spawn of npm.cmd throws EINVAL on Node >= 24, and npm_execpath is not set
// outside npm lifecycle.
function runNpm(args, cwd) {
  const execpath = process.env.npm_execpath
  const options = { cwd, stdio: 'inherit' }
  if (execpath !== undefined && execpath.endsWith('.js')) {
    return spawnSync(process.execPath, [execpath, ...args], options).status ?? 1
  }
  // npm on PATH is a program, not a command line. Spawning it needs no shell anywhere but Windows,
  // and the shell is what this whole shape existed to avoid.
  if (process.platform !== 'win32') return spawnSync('npm', args, options).status ?? 1
  return spawnSync(process.execPath, [npmCliPath(), ...args], options).status ?? 1
}

/** The one lookup left, and it is Windows-only: see `runNpm` above. */
function npmCliPath() {
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(besideNode)) return besideNode
  for (const dir of (process.env.PATH ?? '').split(PATH_DELIMITER)) {
    if (dir === '') continue
    const besideLauncher = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(besideLauncher)) return besideLauncher
  }
  throw new Error('npm\'s entry script was not found. Run this through npm (npm_execpath), or install '
    + `npm so its launcher sits beside node_modules (looked beside ${besideNode} and on PATH). `
    + 'A shell is not used to work around this.')
}

// Verification only: `--verify-only` compares the pins against whatever tree is already
// installed and never writes a manifest, never runs npm and never links anything. A gate
// that cannot be pointed at an existing tree cannot be given a sentinel without destroying
// that tree, and this tree is a junction into the maintainer's live profile.
const verifyOnly = process.argv.includes('--verify-only')
const expectFile = (() => {
  const i = process.argv.indexOf('--expect')
  return i > 0 ? path.resolve(process.argv[i + 1]) : undefined
})()
const pins = expectFile === undefined
  ? deps
  : JSON.parse(readFileSync(expectFile, 'utf8')).deps

/** Compare every pin against the installed manifest; returns the mismatch list. */
function verifyPins(expected) {
  const rows = []
  const mismatches = []
  let missing = 0
  for (const [name, pinned] of Object.entries(expected)) {
    let actual = 'MISSING'
    for (const base of [path.join(depsDir, 'node_modules'), path.join(root, 'node_modules')]) {
      const manifest = path.join(base, ...name.split('/'), 'package.json')
      if (existsSync(manifest)) {
        actual = JSON.parse(readFileSync(manifest, 'utf8')).version
        break
      }
    }
    if (actual === 'MISSING') missing += 1
    // Every pin in ci/pinned-deps.json is an exact version, so equality is the contract.
    // Reporting `pinned -> actual` without comparing it meant a tree of entirely the wrong
    // versions printed one row per package and still exited 0.
    else if (actual !== pinned) mismatches.push(`${name}: want ${pinned}, installed ${actual}`)
    rows.push(`pinned: ${name}@${pinned} -> ${actual}`)
  }
  return { rows, mismatches, missing }
}

if (verifyOnly) {
  const { rows, mismatches, missing } = verifyPins(pins)
  console.log(rows.join('\n'))
  if (mismatches.length > 0 || missing > 0) {
    for (const line of mismatches) console.error(`install-pinned: MISMATCH ${line}`)
    console.error(`install-pinned: FAILED — ${mismatches.length} mismatch(es), ${missing} missing`)
    process.exit(1)
  }
  console.log(`install-pinned: OK (verified ${Object.keys(pins).length} pin(s), nothing installed)`)
  process.exit(0)
}

mkdirSync(depsDir, { recursive: true })
const generated = {
  name: 'dsh-wsl-workspace-ci-deps',
  private: true,
  description: 'Generated by ci/install-pinned.mjs from ci/pinned-deps.json — edit the pin file, not this manifest.',
  dependencies: deps,
}
const manifestPath = path.join(depsDir, 'package.json')
const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
if (!current || JSON.stringify(current.dependencies) !== JSON.stringify(generated.dependencies)) {
  writeFileSync(manifestPath, JSON.stringify(generated, null, 2) + '\n')
}
writeFileSync(path.join(depsDir, '.npmrc'), 'legacy-peer-deps=true\n')

const lockPath = path.join(depsDir, 'package-lock.json')
let status
if (existsSync(lockPath)) {
  status = runNpm(['ci', '--no-audit', '--no-fund'], depsDir)
  if (status !== 0) {
    console.log('install-pinned: npm ci out of sync with pins — falling back to npm install (if pins changed, commit the refreshed ci/deps/package-lock.json)')
    status = runNpm(['install', '--no-audit', '--no-fund'], depsDir)
  }
} else {
  status = runNpm(['install', '--no-audit', '--no-fund'], depsDir)
}
if (status !== 0) {
  console.error(`install-pinned: dependency install in ${depsDir} failed with exit status ${status}`)
  process.exit(1)
}

const depsModules = path.join(depsDir, 'node_modules')
// Link the @deepseek-ai scope and the listed unscoped bare imports (pin file
// 'unscoped' — e.g. js-yaml, which src/index.ts dynamic-imports) from
// ci/deps/node_modules into the root; nothing else, so transitive bloat never
// multiplies links. Existing root entries — including the maintainer's
// junction — are never touched.
const { unscoped } = JSON.parse(readFileSync(path.join(here, 'pinned-deps.json'), 'utf8'))
mkdirSync(path.join(root, 'node_modules'), { recursive: true })
let linked = 0
function linkOrSkip(src, dst) {
  if (existsSync(dst)) return
  try {
    // `fs.symlinkSync` rather than `cmd /c mklink /J`: it is the same junction, and the failure
    // arrives as an Error carrying EEXIST/EPERM/ENOSPC. The subprocess form ran with
    // `stdio:'ignore'`, which discarded the linker's own sentence and left the operator a bare exit
    // number — the shape hazard B is about, and the reason the reason could not be printed here.
    symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    const reason = error?.code === undefined ? '' : ` (${error.code})`
    console.error(`install-pinned: linking ${src} -> ${dst} failed${reason}: `
      + `${String(error?.message ?? error).trim()}`)
    process.exit(1)
  }
  linked++
}
const scopeSrc = path.join(depsModules, '@deepseek-ai')
const scopeDst = path.join(root, 'node_modules', '@deepseek-ai')
// Always per-package (an existing scope dir may still be missing individual
// names); on the maintainer junction machine every existsSync below is true
// through the junction, so nothing is created.
mkdirSync(scopeDst, { recursive: true })
for (const name of Object.keys(deps)) {
  if (!name.startsWith('@deepseek-ai/')) continue
  const short = name.slice('@deepseek-ai/'.length)
  linkOrSkip(path.join(scopeSrc, short), path.join(scopeDst, short))
}
for (const name of unscoped ?? []) linkOrSkip(path.join(depsModules, name), path.join(root, 'node_modules', name))
console.log(`install-pinned: linked ${linked} package(s) from ci/deps into the root node_modules`)

const { rows, mismatches, missing } = verifyPins(deps)
console.log(rows.join('\n'))
if (mismatches.length > 0) {
  console.error(`install-pinned: FAILED — ${mismatches.length} package(s) resolved to a version `
    + 'other than the pin:')
  console.error(mismatches.map(line => `  ${line}`).join('\n'))
  console.error('Re-run `node ci/install-pinned.mjs` after committing the refreshed '
    + 'ci/deps/package-lock.json, or correct ci/pinned-deps.json.')
}
if (missing > 0 || mismatches.length > 0) {
  console.error(`install-pinned: FAILED — ${missing} package(s) did not materialise, `
    + `${mismatches.length} at the wrong version`)
  process.exit(1)
}

// The second tree: the version the umbrella does NOT carry. Nothing here is
// linked into the repo root — a hoisted 5.x at the root would flip
// tests/host-materialize.mjs's `require('js-yaml')` and poison the development
// tree. Only the arm builders in tests/host-profile-isolation.mjs reach into
// ci/deps-conflict, because a profile-shaped tree is exactly where a hoisted
// wrong-major is the point.
const { conflict } = JSON.parse(readFileSync(path.join(here, 'pinned-deps.json'), 'utf8'))
if (conflict !== undefined && Object.keys(conflict).length > 0) {
  const conflictDir = path.join(here, 'deps-conflict')
  mkdirSync(conflictDir, { recursive: true })
  const conflictManifest = {
    name: 'dsh-wsl-workspace-ci-deps-conflict',
    private: true,
    description: 'Generated by ci/install-pinned.mjs from ci/pinned-deps.json `conflict` — the hostile copy, never linked into the repo root.',
    dependencies: conflict,
  }
  const conflictManifestPath = path.join(conflictDir, 'package.json')
  const conflictCurrent = existsSync(conflictManifestPath)
    ? JSON.parse(readFileSync(conflictManifestPath, 'utf8'))
    : null
  if (!conflictCurrent || JSON.stringify(conflictCurrent.dependencies) !== JSON.stringify(conflictManifest.dependencies)) {
    writeFileSync(conflictManifestPath, JSON.stringify(conflictManifest, null, 2) + '\n')
  }
  writeFileSync(path.join(conflictDir, '.npmrc'), 'legacy-peer-deps=true\n')
  // Already satisfied means no npm run at all, so a repeat `node ci/install-pinned.mjs`
  // stays offline-capable the same way the main tree does.
  const versionOf = (dir) => {
    const manifest = path.join(dir, 'package.json')
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'MISSING'
  }
  const conflictModules = path.join(conflictDir, 'node_modules')
  const stale = Object.entries(conflict).some(([name, want]) => versionOf(path.join(conflictModules, name)) !== want)
  if (stale) {
    const conflictStatus = runNpm(['install', '--no-audit', '--no-fund'], conflictDir)
    if (conflictStatus !== 0) {
      console.error(`install-pinned: conflict install in ${conflictDir} failed with exit status ${conflictStatus}`)
      process.exit(1)
    }
  }
  let conflictFailed = false
  const conflictRows = []
  for (const [name, want] of Object.entries(conflict)) {
    const actual = versionOf(path.join(conflictModules, ...name.split('/')))
    if (actual !== want) conflictFailed = true
    conflictRows.push(`conflict (never linked into the root): ${name}@${want} -> ${actual}`)
  }
  console.log(conflictRows.join('\n'))
  if (conflictFailed) {
    console.error('install-pinned: FAILED — the hostile conflict copy did not materialise at the pinned version')
    process.exit(1)
  }
}
console.log('install-pinned: OK')
