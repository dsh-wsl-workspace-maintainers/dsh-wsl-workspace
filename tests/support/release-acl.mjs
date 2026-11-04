import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

function run(program, args) {
  const start = performance.now()
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error) throw result.error
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, ms: Math.round(performance.now() - start) }
}

function requireSuccess(result, operation) {
  assert.equal(result.exitCode, 0, operation + ': ' + result.stderr + result.stdout)
  return result.stdout.trim()
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

// Windows owns the ACL on the DrvFS mount. No Windows system folder or shared
// workspace participates, and the ACE applies only to the new fixture directory.
export async function withWindowsAclFixture(useFixture) {
  assert.equal(process.platform, 'win32', 'the ACL fixture requires a Windows host')
  const identity = requireSuccess(run('whoami.exe', ['/user', '/fo', 'csv', '/nh']), 'read Windows SID')
  const sid = /S-1-\d+(?:-\d+)+/.exec(identity)?.[0]
  assert.ok(sid, 'Windows user SID must be present')
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-release-acl-'))
  const directory = join(scratch, 'protected')
  const file = join(directory, 'probe.txt')
  mkdirSync(directory)
  let denied = false
  try {
    writeFileSync(file, '', { flag: 'wx' })
    unlinkSync(file)
    await useFixture({
      directory,
      file,
      denyWrites() {
        assert.equal(denied, false, 'the ACL fixture installs one explicit ACE')
        requireSuccess(run('icacls.exe', [directory, '/deny', '*' + sid + ':(WD,AD)']), 'apply fixture DACL')
        denied = true
        let errorCode
        assert.throws(
          () => writeFileSync(file, '', { flag: 'wx' }),
          error => {
            errorCode = error.code
            return errorCode === 'EACCES' || errorCode === 'EPERM'
          },
          'Windows must refuse a create after applying the directory ACL',
        )
        const entries = readdirSync(directory)
        assert.deepEqual(entries, [], 'Windows can still list the existing empty directory')
        return { errorCode, entries }
      },
    })
  } finally {
    if (denied) requireSuccess(run('icacls.exe', [directory, '/remove:d', '*' + sid]), 'remove fixture ACE')
    if (existsSync(file)) unlinkSync(file)
    rmdirSync(directory)
    rmdirSync(scratch)
  }
}

function verifyWrittenControl(result, file, source) {
  assert.equal(result.exitCode, 0, source + ' pre-ACL control must succeed')
  assert.equal(result.stdout, '', source + ' pre-ACL stdout')
  assert.equal(result.stderr, '', source + ' pre-ACL stderr')
  assert.ok(existsSync(file), source + ' pre-ACL control must create its target')
  unlinkSync(file)
}

function verifyDenied(result, directory, source) {
  assert.equal(result.exitCode, 1, source + ' must surface the nonzero command exit')
  assert.equal(result.stdout, '', source + ' must leave stdout empty')
  assert.match(result.stderr, /^touch: .*(?:Permission denied|Operation not permitted)\n$/, source + ' must surface the OS denial')
  assert.deepEqual(readdirSync(directory), [], source + ' must leave the existing directory unchanged')
}

async function testAcl() {
  const { withReleaseSession } = await import('./release-session.mjs')
  const distro = process.env.DSH_WSL_DISTRO ?? 'Ubuntu-24.04'
  const user = process.env.DSH_WSL_USER ?? requireSuccess(
    run('wsl.exe', ['--distribution', distro, '--exec', 'id', '-un']), 'read the WSL user',
  )
  process.env.DSH_WSL_USER = user
  const evidenceDir = resolve(process.env.DSH_RELEASE_EVIDENCE_DIR ?? 'release-evidence')
  mkdirSync(evidenceDir, { recursive: true })
  const wsl = (...args) => run('wsl.exe', ['--distribution', distro, '--user', user, ...args])
  const linuxWorkspace = requireSuccess(wsl('--exec', 'mktemp', '-d', '/tmp/dsh-release-acl.XXXXXXXX'), 'make WSL workspace')
  assert.match(linuxWorkspace, /^\/tmp\/dsh-release-acl\.[A-Za-z0-9]{8}$/)
  const cwd = '\\\\wsl.localhost\\' + distro + linuxWorkspace.replaceAll('/', '\\')
  const evidence = { row: '4.4', distro, user, acl: { directoryOnly: true, deniedRights: ['WD', 'AD'] } }

  try {
    await withWindowsAclFixture(async ({ directory, file, denyWrites }) => {
      const linuxFile = requireSuccess(wsl('--exec', 'wslpath', '-u', file), 'map the Windows fixture through DrvFS')
      assert.match(linuxFile, /^\/[^\n\r]+\/probe\.txt$/)
      const command = 'LC_ALL=C touch -- ' + shellQuote(linuxFile)
      evidence.command = command
      const nativeTouch = () => wsl('--cd', linuxWorkspace, '--exec', 'bash', '-lc', command)
      await withReleaseSession({ cwd, evidenceDir }, async ({ call, sessionId }) => {
        evidence.sessionId = sessionId
        const currentUser = await call('bash', { command: 'id -un', description: 'Check the Linux user of this DSH session' }, { timeoutMs: 30_000 })
        evidence.userCheck = currentUser
        assert.equal(currentUser.value.exitCode, 0)
        assert.equal(currentUser.value.stdout.text.trim(), user, 'native and DSH must use the same Linux user')
        const productTouch = () => call('bash', {
          command, description: 'Probe write access in the disposable Windows ACL fixture', timeoutMs: 30_000,
        }, { timeoutMs: 45_000 })

        const nativeControl = nativeTouch()
        evidence.nativeControl = nativeControl
        verifyWrittenControl(nativeControl, file, 'native')
        const productControl = await productTouch()
        evidence.productControl = productControl
        verifyWrittenControl({
          exitCode: productControl.value.exitCode,
          stdout: productControl.value.stdout.text,
          stderr: productControl.value.stderr.text,
        }, file, 'DSH')

        evidence.windows = denyWrites()
        const native = nativeTouch()
        evidence.native = native
        verifyDenied(native, directory, 'native')
        const product = await productTouch()
        evidence.product = product
        const actual = { exitCode: product.value.exitCode, stdout: product.value.stdout.text, stderr: product.value.stderr.text }
        verifyDenied(actual, directory, 'DSH')
        assert.deepEqual(actual, { exitCode: native.exitCode, stdout: native.stdout, stderr: native.stderr })
        evidence.noSideEffects = true
        evidence.verdict = 'MATCH'
      })
    })
  } finally {
    writeFileSync(join(evidenceDir, '4.4-windows-acl.json'), JSON.stringify(evidence, null, 2) + '\n')
    requireSuccess(wsl('--exec', 'rmdir', linuxWorkspace), 'remove empty WSL workspace')
  }
  process.stdout.write('4.4 MATCH: native and DSH report the same Windows ACL denial, exit 1, empty stdout, and no file creation\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testAcl()
}
