// Does this suite catch a defect it was not built for?
//
//   node scripts/mutation-sweep.mjs
//   node scripts/mutation-sweep.mjs --only paths-drive-case,client-escape
//
// Why this exists. Everything the repository's gates know about came from an issue: each one was added
// after a defect reached a user (issue #101 measured 20 experience-class defects, **0** of which the
// suite of the time could have found on its own). A regression lock proves a *known* defect cannot come
// back; it says nothing about the next one. The only honest way to ask "would we catch a new problem
// before release" is to plant defects the suite was never designed for and count how many it notices.
//
// So each entry below is a plausible future regression — an off-by-one, a dropped branch, a spelling
// that changed, a handler that stopped firing — applied to the working tree, measured against the
// per-commit gates, and reverted. `expect: 'red'` is the hypothesis; the run reports which gate reddened
// (or that none did). A green row after a planted defect is the finding: it names a surface with no
// gate, which is exactly what the map's "next batch" is supposed to shrink.
//
// Safety: the sweep refuses a dirty tree, only ever touches the files listed here, and reverts each one
// with `git checkout --` before the next mutation. It never writes to `lib/`, so a stale-bundle accident
// cannot hide behind it.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The per-commit gates, cheapest first; the first red one ends the row. */
const GATES = [
  { id: 'unit', script: 'test:unit' },
  { id: 'world', script: 'test:world' },
  { id: 'artifacts', script: 'test:artifacts' },
  { id: 'install', script: 'test:install' },
  { id: 'client', script: 'test:client' },
  { id: 'docs', script: 'test:docs' },
]
/** The host-tree buckets: 50 s each, so only the mutations that need them ask for them. */
const NODE_GATES = [
  { id: 'node', script: 'test:node' },
]

/**
 * One planted defect.
 *
 * Every entry is a *single* edit whose find-string must occur exactly once — a mutation that silently
 * matched nothing would report "not caught" and be indistinguishable from a real gap.
 */
const MUTATIONS = [
  {
    id: 'paths-drive-case',
    file: 'src/shared/paths.ts',
    note: 'a drive letter stops being case-folded, so every /mnt/<drive> key drifts on a lowercase path',
    find: "return `/mnt/${(match[1] ?? '').toLowerCase()}",
    replace: "return `/mnt/${(match[1] ?? '')}",
  },
  {
    id: 'decode-utf8-always',
    file: 'src/shared/wsl.ts',
    note: 'the UTF-16LE sniff is dropped: wsl.exe output is decoded as UTF-8, so every distro name is mojibake',
    find: "return looksUtf16Le(buffer) ? buffer.toString('utf16le') : buffer.toString('utf8')",
    replace: "return buffer.toString('utf8')",
  },
  {
    id: 'variants-world-twice',
    file: 'src/host/variants.ts',
    note: 'the world group is pushed twice (a copy/paste), so every row id is duplicated',
    find: '  result.push(wslWorldGroup(shellPath, fsPath, sawEditor, persistent, sawSearch ? searchPath : undefined, jobsPath, sawJobs, imagePath))',
    replace: '  result.push(wslWorldGroup(shellPath, fsPath, sawEditor, persistent, sawSearch ? searchPath : undefined, jobsPath, sawJobs, imagePath))\n  result.push(wslWorldGroup(shellPath, fsPath, sawEditor, persistent, sawSearch ? searchPath : undefined, jobsPath, sawJobs, imagePath))',
  },
  {
    id: 'search-glob-cap',
    file: 'src/host/wsl-search.ts',
    note: 'the inline-path cap becomes exclusive off-by-one (64 results report as over-cap)',
    find: 'if (paths.length <= caps.maxResults) return paths.join',
    replace: 'if (paths.length < caps.maxResults) return paths.join',
    gates: ['node'],
  },
  {
    id: 'jobs-drop-output',
    file: 'src/host/wsl-jobs.ts',
    note: "the background producer stops feeding the registry ring (#56's shape, back again)",
    find: `    output: [
      { read: readStream('stdout') },
      { channel: 'stderr', read: readStream('stderr') },
    ],
`,
    replace: '',
    gates: ['node'],
  },
  {
    id: 'skills-read-share',
    file: 'src/host/wsl-skills.ts',
    note: 'a drive workspace is read through the 9P share again, which cannot serve drvfs',
    find: 'return mntToWindowsPath(linuxPath) ?? joinUnc(distro, linuxPath)',
    replace: 'return joinUnc(distro, linuxPath)',
  },
  {
    id: 'client-escape-dead',
    file: 'src/client/AddWslWorkspace.tsx',
    note: 'Escape stops closing the dialog (the keydown handler no longer matches)',
    find: "event.key === 'Escape'",
    replace: "event.key === 'Esc'",
  },
  {
    id: 'manifest-drop-dep',
    file: 'package.json',
    note: 'a real dependency disappears from the manifest — installs here, not from the tarball',
    find: '    "js-yaml": "^4.1.0"',
    replace: '    "js-yaml": "^5.0.0"',
  },
  {
    id: 'locales-drop-zh',
    file: 'src/client/locales.ts',
    note: 'one zh dictionary key is renamed, so the dialog renders a raw id in Chinese',
    find: "'error.loadDir': '无法浏览该目录',",
    replace: "'error.loadDir.typo': '无法浏览该目录',",
  },
]

/**
 * The buckets one mutation is judged by: the fast set, plus the host-tree bucket when the edit lives in
 * a module only `test:node` loads.
 */
function gatesFor(mutation) {
  const ids = mutation.gates ?? []
  return ids.includes('node') ? [...GATES, ...NODE_GATES] : GATES
}

/** A clean tree is a precondition: the sweep reverts with `git checkout -- <file>`. */
function assertCleanTree() {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (dirty !== '') {
    console.error(`mutation-sweep: the working tree is not clean; refusing to plant defects\n${dirty}`)
    process.exit(2)
  }
}

/** Apply one mutation; returns the number of replacements (must be exactly 1). */
function plant(mutation) {
  const path = join(repoRoot, mutation.file)
  const before = readFileSync(path, 'utf8')
  const after = mutation.patch !== undefined
    ? mutation.patch(before)
    : before.split(mutation.find).join(mutation.replace)
  if (after === before) return 0
  writeFileSync(path, after, 'utf8')
  return mutation.patch !== undefined ? 1 : before.split(mutation.find).length - 1
}

/** Run the gates in order and stop at the first red; returns the id that caught it, or null. */
function firstRed(gates) {
  for (const gate of gates) {
    const run = spawnSync('npm', ['run', gate.script], { cwd: repoRoot, encoding: 'utf8', shell: true })
    if (run.status !== 0) return gate.id
  }
  return null
}

const only = (() => {
  const index = process.argv.indexOf('--only')
  return index === -1 ? undefined : new Set(process.argv[index + 1].split(','))
})()

assertCleanTree()

// Every gate must be green on the clean tree before a single defect is planted. Without this, a gate that
// is red for an environment reason (jsdom not installed in this checkout, a stale host tree) answers
// "caught" for every mutation, and the sweep reports a detection rate it never measured.
for (const gate of [...GATES, ...NODE_GATES]) {
  const baseline = spawnSync('npm', ['run', gate.script], { cwd: repoRoot, encoding: 'utf8', shell: true })
  if (baseline.status !== 0) {
    console.error(`mutation-sweep: \`${gate.script}\` is red on a clean tree — this is an environment, not a measurement.`)
    console.error((baseline.stderr ?? '').trim().split('\n').slice(-6).join('\n'))
    process.exit(2)
  }
}

const selected = MUTATIONS.filter(mutation => only === undefined || only.has(mutation.id))
if (selected.length === 0) {
  console.error(`mutation-sweep: --only named nothing in the table (${MUTATIONS.map(m => m.id).join(', ')})`)
  process.exit(2)
}

const rows = []
for (const mutation of selected) {
  const applied = plant(mutation)
  if (applied !== 1) {
    execFileSync('git', ['checkout', '--', mutation.file], { cwd: repoRoot })
    rows.push({ id: mutation.id, verdict: 'INVALID', detail: `the find-string matched ${applied} times, not once — the mutation did not apply` })
    continue
  }
  let caught = null
  let detail = ''
  try {
    // The client gate reads the **committed** `lib/`, so a `src/` edit is invisible until it is built —
    // which is the product's own order (lint-build rebuilds, then the client gate reads the bundle). A
    // sweep that skipped the build would report "missed" for defects the suite does catch.
    const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', shell: true })
    if (build.status !== 0) throw new Error(`the mutation does not compile: ${(build.stderr ?? '').slice(-400)}`)
    caught = firstRed(gatesFor(mutation))
  } catch (error) {
    detail = String(error?.message ?? error)
  } finally {
    execFileSync('git', ['checkout', '--', mutation.file, 'lib'], { cwd: repoRoot })
  }
  rows.push({
    id: mutation.id,
    verdict: caught === null ? 'NOT CAUGHT' : 'caught',
    detail: caught === null ? `${mutation.note} — no per-commit gate reddened` : `${caught}: ${mutation.note}`,
  })
  console.log(`${caught === null ? 'MISS' : 'ok  '} ${mutation.id.padEnd(22)} ${rows.at(-1).detail}`)
}

const missed = rows.filter(row => row.verdict === 'NOT CAUGHT')
const invalid = rows.filter(row => row.verdict === 'INVALID')
console.log('')
console.log(JSON.stringify({
  verdict: missed.length === 0 && invalid.length === 0 ? 'PASSED' : 'FAILED',
  measured: rows.length,
  caught: rows.length - missed.length - invalid.length,
  missed: missed.map(row => row.id),
  invalid: invalid.map(row => row.id),
}))
if (invalid.length > 0) {
  console.error('mutation-sweep: a mutation that does not apply is not a measurement — fix the table')
  process.exit(2)
}
if (missed.length > 0) {
  console.error(`mutation-sweep: ${missed.length} planted defect(s) survived every per-commit gate: ${missed.map(row => row.id).join(', ')}`)
  process.exit(1)
}
