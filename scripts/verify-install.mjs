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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

/**
 * Run one npm command in a directory, inheriting stdio, and return its status.
 *
 * npm's own entry script is used when npm exposes it (`npm_execpath`, set for
 * every lifecycle script including `prepublishOnly`), which avoids a shell
 * entirely. On Windows a bare `npm.cmd` cannot be spawned without one, so the
 * fallback — running this file by hand, outside npm — goes through the shell.
 * Nothing here takes user input: the arguments are this file's own literals.
 * @param args - npm arguments.
 * @param cwd - working directory.
 * @returns the exit status.
 */
function runNpm(args, cwd) {
  const execpath = process.env.npm_execpath
  if (execpath !== undefined && execpath.endsWith('.js')) {
    return spawnSync(process.execPath, [execpath, ...args], { cwd, stdio: 'inherit' }).status ?? 1
  }
  const program = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return spawnSync(program, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1
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
if (runNpm(['pack', '--silent'], repo) !== 0) fail('npm pack failed')

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
  const status = runNpm(['install', tarball, '--no-audit', '--no-fund', '--prefer-online'], scratch)
  if (status !== 0) {
    fail(`plain \`npm install ${manifest.name}@${manifest.version}\` failed with exit ${status} - a user installing this package with npm cannot complete the install`)
  }
  const installed = JSON.parse(readFileSync(join(scratch, 'node_modules', manifest.name, 'package.json'), 'utf8'))
  if (installed.version !== manifest.version) fail(`installed version ${installed.version} is not ${manifest.version}`)
  checkRuntimeDependencies(scratch)
  console.log(`verify-install: OK - plain npm installs ${manifest.name}@${installed.version} with its runtime surface present`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
