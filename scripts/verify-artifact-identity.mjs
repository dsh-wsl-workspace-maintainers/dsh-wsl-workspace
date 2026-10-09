// Machine-enforced version of the TESTING.md artifact-identity contract:
// "the tarball from the release path, a fresh npm pack, and npm pack
// --ignore-scripts over the committed lib/ must hash identically".
// Packs three ways into a scratch dir OUTSIDE the worktree, compares the
// SHA-256 of every extracted member (path+bytes), and reports the tarball
// byte hashes as evidence lines. Byte-identical tarballs are the strongest
// form; member-content identity is what the contract means (gzip/tar
// headers may legitimately differ across pack runs).
//   node scripts/verify-artifact-identity.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter as PATH_DELIMITER, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

// Minimal tar reader: npm tarballs are (gz)ustar with small member names.
// System `tar` is not usable portably here (MSYS tar parses `D:\…` as
// host:path), and the digest must cover exactly the packed bytes.
function tarMembers(tgzPath) {
  const buf = gunzipSync(readFileSync(tgzPath))
  const out = []
  let offset = 0
  const cstr = (start, len) => buf.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/s, '')
  const octal = (start, len) => Number.parseInt(buf.subarray(start, start + len).toString('ascii').replace(/\0[\s\S]*$/s, '').trim() || '0', 8)
  while (offset + 512 <= buf.length) {
    if (cstr(offset, 100) === '') break // end-of-archive zero block
    const size = octal(offset + 124, 12)
    const type = String.fromCharCode(buf[offset + 156])
    const prefix = buf.subarray(offset + 345, offset + 379).toString('ascii').replace(/\0[\s\S]*$/s, '')
    const name0 = cstr(offset, 100)
    const full = prefix !== '' ? `${prefix}/${name0}` : name0
    if (type === '0' || type === '\0') {
      const bytes = buf.subarray(offset + 512, offset + 512 + size)
      out.push(`${full.replace(/^package\//, '')}\0${createHash('sha256').update(bytes).digest('hex')}`)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out.sort()
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-artifact-identity-'))
let failed = false
try {
  const packs = []
  // ignore-scripts first: it packs the tree AS COMMITTED; the release-path
  // packs rebuild lib from src. If the committed artifact differs from what
  // a build of the committed sources produces, the digests split — and a
  // later release-path pack would silently heal the tree, hiding the drift.
  for (const [label, extraArgs] of [
    ['ignore-scripts (committed lib)', ['--ignore-scripts']],
    ['release-path (prepack rebuild)', []],
    ['repeat release-path', []],
  ]) {
    const dir = join(scratch, label.replace(/[^a-z-]/g, '_'))
    mkdirSync(dir, { recursive: true })
    const r = runNpm(['pack', '--pack-destination', dir, ...extraArgs], repoRoot)
    const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'))
    if (!tarball) {
      console.error(`artifact-identity: ${label} produced no tarball — ${(r.stdout ?? '') + (r.stderr ?? '')}`)
      failed = true
      continue
    }
    const bytes = readFileSync(join(dir, tarball))
    const members = tarMembers(join(dir, tarball))
    if (members.length === 0) {
      console.error(`artifact-identity: ${label}: ${tarball} contained no members`)
      failed = true
      continue
    }
    packs.push({ label, tarball, tgzSha: createHash('sha256').update(bytes).digest('hex'), digest: createHash('sha256').update(members.join('\n')).digest('hex') })
  }
  for (const p of packs) console.log(`artifact-identity: ${p.label} -> ${p.tarball} tgz=${p.tgzSha.slice(0, 16)}… members=${p.digest.slice(0, 16)}…`)
  if (packs.length !== 3) failed = true
  const digests = new Set(packs.map(p => p.digest))
  if (digests.size !== 1) {
    console.error('artifact-identity: RED — extracted member contents differ between pack modes (committed lib is not what the release path ships)')
    failed = true
  }
  const tgzs = new Set(packs.map(p => p.tgzSha))
  if (tgzs.size === 1) console.log('artifact-identity: tarballs are byte-identical (full TESTING.md contract satisfied)')
  else if (!failed) console.log('artifact-identity: member contents identical; tarball bytes differ (header-level drift only)')
  if (failed) process.exit(1)
  console.log('artifact-identity: OK')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
