/**
 * Pre-publish gate: can a *plain npm* user actually install this package?
 *
 * 0.7.0 shipped with `peerDependencies` that npm auto-installs: the
 * `@deepseek-ai/dsh-tool-fs-search` peer pulls `@deepseek-ai/dsh-retention`,
 * which is not published, so `npm install dsh-wsl-workspace` died with E404 —
 * while `dsh plugin add` (pnpm) only warned and installed fine. Every harness
 * check and real session used the pnpm path, so nothing caught it; the first
 * plain-npm install happened after the release. This script is that missing
 * check, and `prepublishOnly` runs it, so an uninstallable package cannot be
 * published again.
 *
 * It packs the current tree, installs the tarball into a scratch directory with
 * the npm on PATH (no pnpm, no workspace, no host packages present), and fails
 * on a non-zero exit or a version mismatch. Child processes inherit stdio: the
 * sandbox forbids piped stdio for spawned programs, and the exit status is all
 * this needs.
 *
 * It then asks the second question, the one whose absence this gate used to
 * certify: see `checkRuntimeDependencies`.
 *
 * @module dsh-wsl-workspace/scripts/verify-install
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter as PATH_DELIMITER, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

/**
 * Run one npm command in a directory, and return its status.
 *
 * No interpreter ever sees these arguments, which is the whole of hazard A/E: `shell: true` is gone
 * from every call site. How npm itself is reached is deliberately boring, because the clever version
 * was wrong twice — first it looked only beside `node.exe` (absent on a hosted tool cache), then it
 * walked `PATH` reading symlinks (still not found there, and a second thing to get wrong). What the
 * hazard forbids is the interpreter, not the spawn.
 *
 * @param args - npm arguments.
 * @param cwd - working directory.
 * @param stdio - stdio for the child.
 * @param encoding - encoding when the caller wants captured output.
 * @returns the child's result.
 */
function runNpm(args, cwd, stdio, encoding) {
  const execpath = process.env.npm_execpath
  const options = { cwd, ...(stdio === undefined ? {} : { stdio }), ...(encoding === undefined ? {} : { encoding }) }
  if (execpath !== undefined && execpath.endsWith('.js')) {
    return spawnSync(process.execPath, [execpath, ...args], options)
  }
  // npm on PATH is a program, not a command line: spawning it needs no shell on any platform that
  // has an executable one, which is every platform this gate runs on except Windows.
  if (process.platform !== 'win32') return spawnSync('npm', args, options)
  // Windows: a bare `npm.cmd` cannot be spawned without one, and the entry script beside `node.exe`
  // is where a normal install keeps it. Named, never guessed.
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(beside)) {
    throw new Error('npm\'s entry script was not found. Run this through npm (npm_execpath), or place '
      + `npm-cli.js beside node.exe (${beside}). A shell is not used to work around this.`)
  }
  return spawnSync(process.execPath, [beside, ...args], options)
}

/**
 * The one lookup left, and it is Windows-only: see `runNpm`.
 *
 * Two layouts, because npm is installed two ways: beside the launcher (`npm.cmd` and
 * `node_modules/npm/bin/npm-cli.js` in the same directory — a normal Windows install) and beside
 * node (`node.exe` next to `node_modules/npm/…`). A hosted tool cache is the second one, and CI
 * measured the first as absent there, which killed a job that was never broken.
 * @returns the CLI script's path.
 */
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

/** Fail loudly with one line, so the gate is readable in a publish log. */
function fail(message) {
  console.error(`verify-install: ${message}`)
  process.exit(1)
}

// `fail` above exits from inside the try, and a `finally` does not run when the
// process exits — which left a packed tarball at the repository root after the
// first refusing frame. Cleanup belongs to the exit path itself, not to the block
// that can be left by it.
let cleanup = () => {}
process.on('exit', () => cleanup())

/**
 * Assert the runtime surface on the tree a plain-npm user actually ends up with.
 *
 * Until issue #47 this gate asked only "does `npm install` succeed", and its green
 * was *caused* by the thing that broke the deployment: every module the variant
 * generator resolved at call time was declared an optional peer with a `*` range,
 * so a clean install produced a package that installed perfectly and generated
 * nothing — and a profile where some sibling plugin had already hoisted a different
 * major of the same module could not install the missing one either, because
 * optional peers are not installed. One question about installation cannot answer
 * "is there anything for the plugin to run against", so this asks that directly:
 * the declared dependency must be present, in a release whose line this package was
 * built on, reachable by the same upward walk `lib/` performs.
 * @param scratch - the directory the tarball was installed into.
 */
function checkRuntimeDependencies(scratch) {
  const declared = Object.entries(manifest.dependencies ?? {})
  if (declared.length === 0) {
    fail('the manifest declares no dependency at all — the engine that parses a variant composition has to '
      + 'ship with this package rather than be inherited from whatever a profile happens to hoist (issue #47)')
  }
  for (const [name, range] of declared) {
    const wantedLine = /^\^?(\d+)/.exec(range)?.[1]
    const candidates = [
      join(scratch, 'node_modules', manifest.name, 'node_modules', name),
      join(scratch, 'node_modules', name),
    ]
    const found = candidates.find(dir => existsSync(dir))
    if (found === undefined) {
      fail(`plain npm installed ${manifest.name} but left ${name} unreachable from it (looked in: ${candidates.join(', ')})`)
    }
    const version = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8')).version
    const line = /^\d+/.exec(String(version))?.[0]
    if (wantedLine !== undefined && line !== wantedLine) {
      fail(`${name}@${version} at ${found} is not on the ${range} line this package was built against`)
    }
    console.log(`verify-install:   ${name} ${version} reachable at ${found}`)
  }
}

console.log(`verify-install: packing ${manifest.name}@${manifest.version} ...`)
const pack = runNpm(['pack', '--silent'], repo, 'inherit')
if (pack.status !== 0) {
  fail(`npm pack failed with exit ${pack.status}${pack.error === undefined ? '' : ` (${pack.error.message})`}`)
}

// `npm pack` prints the tarball name on stdout, which inherited stdio swallowed;
// the deterministic name is the manifest's.
const tarball = join(repo, `${manifest.name}-${manifest.version}.tgz`)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-verify-install-'))
cleanup = () => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
try {
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'verify-install', private: true, version: '1.0.0' }, null, 2))
  console.log('verify-install: installing the tarball with plain npm (no pnpm, no peers present) ...')
  const install = runNpm(['install', tarball, '--no-audit', '--no-fund', '--prefer-online'], scratch, 'inherit')
  if (install.status !== 0) {
    fail(`plain \`npm install ${manifest.name}@${manifest.version}\` failed with exit ${install.status} - a user installing this package with npm cannot complete the install`)
  }
  const installed = JSON.parse(readFileSync(join(scratch, 'node_modules', manifest.name, 'package.json'), 'utf8'))
  if (installed.version !== manifest.version) fail(`installed version ${installed.version} is not ${manifest.version}`)
  checkRuntimeDependencies(scratch)
  console.log(`verify-install: OK - plain npm installs ${manifest.name}@${installed.version} with its runtime surface present`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
