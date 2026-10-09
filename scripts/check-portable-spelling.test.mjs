/**
 * Positive controls for the portability scanner: every rule must catch the shape it names, and
 * must not catch the spelling it asks for. A lint without its own counter-example is a list
 * nobody can trust — it can be vacuously green forever.
 *
 *   node --test scripts/check-portable-spelling.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES, enforceable, scan } from './check-portable-spelling.mjs'

const byId = new Map(RULES.map((rule) => [rule.id, rule]))

/** [ruleId, a file the rule applies to, the violating line, the spelling the rule asks for]. */
const CONTROLS = [
  ['child-output-decoded-as-utf8', 'src/host/wsl-search.ts',
    "const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')",
    'const err = decodeWslOutput(stderr)'],
  ['child-output-decoded-as-utf8', 'src/shared/links.ts',
    "        { encoding: 'utf8', timeout: LINK_RESOLVE_TIMEOUT_MS, windowsHide: true },",
    '        { timeout: LINK_RESOLVE_TIMEOUT_MS, windowsHide: true },',
    ["        const output = await execFileResult(candidate,",
      "          ['-d', unc.distro, '--', 'readlink', '-f', unc.linuxPath],"]],
  ['execfilesync-outside-wsl-ts', 'src/host/wsl.ts',
    "const out = execFileSync('wsl.exe', ['-l', '-q'])",
    "execFileSync('wsl.exe', ['-l', '-q']) // portability-allow: owned by src/shared/wsl.ts"],
  ['unc-rewrite-outside-paths-ts', 'src/index.ts',
    "const forward = winPath.replace(/\\\\/g, '/')",
    'const forward = mntToLinuxPath(winPath)'],
  ['wsl-distro-arg-unchecked', 'src/shared/links.ts',
    "execFile('wsl.exe', ['-d', unc.distro, '--', 'readlink', '-f', p], cb)",
    "execFile('wsl.exe', ['-d', requireDistro(unc.distro), '--', 'readlink'], cb)"],
  ['spawn-through-a-shell-with-args', 'scripts/verify-install.mjs',
    "  return spawnSync(program, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1", // portability-allow: a control fixture — the rule must match this string or it is not tested
    '  return spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" }).status ?? 1'],
  ['cmd-exe-as-an-api', 'ci/install-pinned.mjs',
    "  ? spawnSync('cmd', ['/c', 'mklink', '/J', dst, src], { stdio: 'ignore', shell: false }).status ?? 1", // portability-allow: a control fixture, as above
    "  ? symlinkSync(src, dst, 'junction')"],
  ['stdio-ignore-discards-the-reason', 'ci/install-pinned.mjs',
    "spawnSync('cmd', ['/c', 'mklink', '/J', dst, src], { stdio: 'ignore', shell: false })", // portability-allow: a control fixture, as above
    "spawnSync('cmd', ['/c', 'mklink', '/J', dst, src], { encoding: 'utf8', shell: false })"],
  ['abs-posix-path-in-windows-bash-step', '.github/workflows/ci.yml',
    '          WSL_COMPAT_ROOT=/tmp/dsh-wsl-lib wsl.exe -d Ubuntu -- true',
    '          MSYS_NO_PATHCONV=1 WSL_COMPAT_ROOT=/tmp/dsh-wsl-lib wsl.exe -d Ubuntu -- true'],
  ['abs-posix-path-in-windows-bash-step', '.github/workflows/compat.yml',
    '      TEMP: /tmp/compat-work',
    '      COMPAT_LEAF: dsh-compat-work'],
]

for (const [ruleId, rel, violation, replacement, context] of CONTROLS) {
  const rule = byId.get(ruleId)
  assert(rule !== undefined, `the control names a rule that exists (${ruleId})`)
  // The scanner hands each rule the six lines above it too; a control that leaves the context
  // out would be asserting against a different harness than the one the repository is scanned
  // with — the mistake this control just caught.
  const window = (line) => [...(context ?? []), line].join('\n')
  test(`${ruleId}: flags the shape and accepts the spelling it asks for`, () => {
    assert.ok(rule.match(rel, violation, window(violation)),
      `the rule did not catch its own example: ${violation}`)
    assert.ok(!rule.match(rel, replacement, window(replacement)),
      `the rule still catches the repaired spelling: ${replacement}`)
  })
}

test('a comment naming the shape is not a finding, nor is a bash-internal assignment', () => {
  const rule = byId.get('abs-posix-path-in-windows-bash-step')
  assert.ok(!rule.match('.github/workflows/ci.yml',
    '          # WSL_COMPAT_ROOT=/tmp/x reached node as C:\\tmp\\x — documented, not a step'),
  'a comment must not be a finding')
  assert.ok(!rule.match('scripts/verify-dsh-compat.sh', 'VAR=/tmp/plain-bash-assignment'),
    'a bash variable assignment is not argv; MSYS leaves it alone and the compat script depends on that')
})

test('the enforceable tier is a subset of the findings, and lib/ is never scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-portability-control-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'),
      "export const x = 1\nconst err = stderr.toString('utf8')\n", 'utf8')
    writeFileSync(join(root, 'lib', 'a.js'), 'const err = stderr.toString("utf8")\n', 'utf8')
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  wsl-gate:\n    steps:\n      - run: WSL_COMPAT_ROOT=/tmp/x wsl.exe -d Ubuntu -- true\n', 'utf8')
    const findings = scan(root)
    const paths = findings.map((f) => f.path)
    assert.ok(!paths.includes('lib/a.js'), `generated lib/ must be skipped (got ${paths.join(', ')})`)
    assert.ok(findings.some((f) => f.path === 'src/a.ts'
      && f.ruleId === 'child-output-decoded-as-utf8' && f.line === 2),
      `the src hit is reported with its line (${JSON.stringify(findings)})`)
    const blocking = enforceable(findings)
    assert.equal(blocking.length, 1,
      `exactly one enforceable hit in the control tree (${JSON.stringify(blocking)})`)
    assert.equal(blocking[0].path, '.github/workflows/ci.yml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the repository as it stands has a named worklist, not a silent pass', () => {
  const findings = scan()
  // The scan must find *something* in the real tree, or the rule set is decoration.
  assert.ok(findings.length > 0, 'a zero-hit scan of the real tree would mean the rules never fire')
  // The §6 stderr call site **was** on this list and is not any more. `wsl-search.ts` used to decode
  // stderr at the capture point, which is the single thing the three §6 transport debts shared, and it
  // is paid: a run now carries bytes and the decode happens where the text is used. This control
  // asserted the debt's presence, so paying it would otherwise have read as a broken scanner — the
  // mirror image of the rule that keeps firing on a fixed site.
  //
  // The file still appears twice under the same rule, on **stdout** (the NUL-delimited search stream,
  // which is UTF-8 by protocol). Those are a separate question and are not this debt.
  assert.ok(!findings.some((f) => f.path === 'src/host/wsl-search.ts' && /stderr/.test(f.text)),
    'the §6 capture-point stderr decode is paid: nothing in src/host/wsl-search.ts decodes stderr any more')
  assert.ok(findings.some((f) => f.path === 'src/shared/links.ts'
    && f.ruleId === 'child-output-decoded-as-utf8'),
    'links.ts is on the list by its option spelling, not only by toString')
  assert.ok(findings.some((f) => f.ruleId === 'abs-posix-path-in-windows-bash-step'
    && f.path === '.github/workflows/compat.yml'),
    'compat.yml TEMP is named as the one open enforceable hit this round')
})
