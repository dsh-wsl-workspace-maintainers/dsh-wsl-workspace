/**
 * Unit tests for the issue #49 file-reference translation.
 *
 * A WSL session's reference carries an absolute LINUX path, and the host
 * resolves it with `node:path.resolve(cwd, path)` — where a POSIX absolute path
 * is root-relative, so the path names a file that does not exist. These cases
 * pin the two halves of the repair: the path translation, and the address
 * surgery that hands the Sidebar an address for the file the model meant.
 *
 * Run with `node --experimental-strip-types --test tests/references.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostPathForLinuxReference, toPosixSpelling } from '../src/shared/paths.ts'
import {
  distroOfWorkspace,
  fileAddressFor,
  isWslWorkspace,
  mountReferenceNavigation,
  parseSessionFileAddress,
  rewriteReferenceAddress,
  sessionFileAddress,
  type ReferenceSession,
} from '../src/client/references.ts'

/** The Ubuntu distro name every fixture uses. */
const UBUNTU = 'Ubuntu'
/** A drive-spelling workspace root, as `/mnt/d/...` workspaces register. */
const DRIVE_CWD = 'D:\\AORUS\\Documents\\deepseek-harness\\default-workspace'
/** A UNC workspace root inside the distribution. */
const UNC_CWD = '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\memcache'

test('hostPathForLinuxReference maps a drvfs mount back to its drive', () => {
  assert.equal(
    hostPathForLinuxReference('/mnt/d/AORUS/Documents/pkg/package.json', undefined),
    'D:\\AORUS\\Documents\\pkg\\package.json',
  )
  // The drive mount needs no distribution: the mount name IS the drive.
  assert.equal(hostPathForLinuxReference('/mnt/c/Users/mille/a.txt', UBUNTU), 'C:\\Users\\mille\\a.txt')
  // Mixed case and a bare mount point.
  assert.equal(hostPathForLinuxReference('/mnt/D/x', undefined), 'D:\\x')
  assert.equal(hostPathForLinuxReference('/mnt/d', undefined), 'D:\\')
})

test('hostPathForLinuxReference routes anything else through the distribution share', () => {
  assert.equal(
    hostPathForLinuxReference('/root/workspace/memcache/VERSION', UBUNTU),
    '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\memcache\\VERSION',
  )
  assert.equal(hostPathForLinuxReference('/etc/hosts', UBUNTU), '\\\\wsl.localhost\\Ubuntu\\etc\\hosts')
  assert.equal(hostPathForLinuxReference('/home/mille/a b.txt', UBUNTU), '\\\\wsl.localhost\\Ubuntu\\home\\mille\\a b.txt')
})

test('hostPathForLinuxReference leaves what it cannot translate alone', () => {
  // No distribution: an in-distribution path has no host-readable spelling.
  assert.equal(hostPathForLinuxReference('/root/x', undefined), null)
  assert.equal(hostPathForLinuxReference('/root/x', ''), null)
  // Not an absolute Linux path.
  assert.equal(hostPathForLinuxReference('relative/x', UBUNTU), null)
  assert.equal(hostPathForLinuxReference('D:\\x', UBUNTU), null)
  assert.equal(hostPathForLinuxReference('', UBUNTU), null)
  // A forward-slash UNC is already a host path, not a Linux one.
  assert.equal(hostPathForLinuxReference('//wsl.localhost/Ubuntu/root/x', UBUNTU), null)
  // `/mnt/<name>` that is not a single drive letter is a custom mount point.
  assert.equal(hostPathForLinuxReference('/mnt/wsl/x', UBUNTU), '\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x')
})

test('the address grammar round-trips every path shape a reference carries', () => {
  const id = 'session-8f4b3e9e-b48c-4920-b9ac-c4b8b85f1501'
  for (const path of [
    'relative/file.txt',
    'nested/dir/a b.txt',
    '/mnt/d/AORUS/pkg/package.json',
    '/root/workspace/memcache/VERSION',
    'D:/AORUS/pkg/package.json',
    '//wsl.localhost/Ubuntu/root/workspace/memcache/VERSION',
    '',
  ]) {
    const address = sessionFileAddress(id, path)
    const parsed = parseSessionFileAddress(address)
    assert.notEqual(parsed, null, `${path} must parse`)
    assert.equal(parsed?.sessionId, id)
    assert.equal(parsed?.path, toPosixSpelling(path).replace(/^(?:\.\/)+/, ''))
    // The rebuild-check the rewrite relies on: our own encoder reproduces it.
    assert.equal(sessionFileAddress(id, parsed?.path ?? ''), address)
  }
})

test('parseSessionFileAddress refuses what this hook must not touch', () => {
  const id = 'session-1'
  assert.equal(parseSessionFileAddress(''), null)
  assert.equal(parseSessionFileAddress('dsh-resource://note/session/1/x'), null)
  assert.equal(parseSessionFileAddress('sidebar://guide'), null)
  // An `absolute` address carries no session to look up.
  assert.equal(parseSessionFileAddress('dsh-resource://file/absolute/D:/x'), null)
  // A missing id, and a malformed escape.
  assert.equal(parseSessionFileAddress('dsh-resource://file/session//x'), null)
  assert.equal(parseSessionFileAddress(`dsh-resource://file/session/${id}/%E0%A4%A`), null)
  // A session address with no path at all parses to the empty path — the
  // workspace root — exactly as the owning package does; the translation then
  // passes it through, because an empty path names no Linux file.
  assert.deepEqual(parseSessionFileAddress(`dsh-resource://file/session/${id}/`), { sessionId: id, path: '' })
  // The positive control: a well-formed address of this scope parses.
  assert.deepEqual(parseSessionFileAddress(sessionFileAddress(id, 'a/b')), { sessionId: id, path: 'a/b' })
})

test('parseSessionFileAddress ignores a query or fragment suffix', () => {
  const id = 'session-1'
  const parsed = parseSessionFileAddress(`${sessionFileAddress(id, '/root/x')}?line=12#L12`)
  assert.deepEqual(parsed, { sessionId: id, path: '/root/x' })
})

test('fileAddressFor keeps a translated path inside the workspace relative', () => {
  const id = 'session-1'
  // Inside the drive workspace: relative, exactly as the Files panel builds it.
  assert.equal(
    fileAddressFor(id, DRIVE_CWD, 'D:\\AORUS\\Documents\\deepseek-harness\\default-workspace\\src\\a.ts'),
    sessionFileAddress(id, 'src/a.ts'),
  )
  // Inside the UNC workspace.
  assert.equal(
    fileAddressFor(id, UNC_CWD, '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\memcache\\VERSION'),
    sessionFileAddress(id, 'VERSION'),
  )
  // The root itself, and a path outside it.
  assert.equal(fileAddressFor(id, DRIVE_CWD, DRIVE_CWD), sessionFileAddress(id, ''))
  assert.equal(fileAddressFor(id, DRIVE_CWD, 'D:\\other\\a.ts'), sessionFileAddress(id, 'D:/other/a.ts'))
  // A relative path is left relative, and an unknown cwd changes nothing.
  assert.equal(fileAddressFor(id, DRIVE_CWD, 'src/a.ts'), sessionFileAddress(id, 'src/a.ts'))
  assert.equal(fileAddressFor(id, undefined, '/root/x'), sessionFileAddress(id, '/root/x'))
})

test('rewriteReferenceAddress fixes the issue’s primary case: a drive workspace', () => {
  const id = 'session-1'
  const session: ReferenceSession = { cwd: DRIVE_CWD, distro: UBUNTU }
  const address = fileAddressFor(id, DRIVE_CWD, '/mnt/d/AORUS/Documents/deepseek-harness/default-workspace/pkg/package.json')
  const rewritten = rewriteReferenceAddress(address, () => session)
  assert.equal(
    rewritten,
    sessionFileAddress(id, 'pkg/package.json'),
  )
  // And the host can open what it now carries.
  const parsed = parseSessionFileAddress(rewritten)
  assert.equal(parsed?.path, 'pkg/package.json')
})

test('rewriteReferenceAddress fixes the issue’s UNC case and keeps working ones intact', () => {
  const id = 'session-1'
  const session: ReferenceSession = { cwd: UNC_CWD, distro: UBUNTU }
  // An in-distribution path under a UNC cwd already resolved correctly through
  // the share; the rewrite makes it the workspace-relative address instead.
  const inside = fileAddressFor(id, UNC_CWD, '/root/workspace/memcache/VERSION')
  assert.equal(rewriteReferenceAddress(inside, () => session), sessionFileAddress(id, 'VERSION'))
  // A drvfs path under a UNC cwd: the host rebased it under the share, where
  // 9P refuses the mount. The drive spelling is the repair.
  const drvfs = fileAddressFor(id, UNC_CWD, '/mnt/d/ProgramData/ws/.test-runs/probe.txt')
  assert.equal(
    rewriteReferenceAddress(drvfs, () => session),
    sessionFileAddress(id, 'D:/ProgramData/ws/.test-runs/probe.txt'),
  )
})

test('rewriteReferenceAddress leaves a reference alone when it cannot be sure', () => {
  const id = 'session-1'
  const session: ReferenceSession = { cwd: DRIVE_CWD, distro: UBUNTU }
  // A session this plugin does not treat as WSL-bound.
  const wslAddress = fileAddressFor(id, DRIVE_CWD, '/mnt/d/x.txt')
  assert.equal(rewriteReferenceAddress(wslAddress, () => undefined), wslAddress)
  // Already host-readable: a relative path, and a Windows path.
  const relative = sessionFileAddress(id, 'src/a.ts')
  assert.equal(rewriteReferenceAddress(relative, () => session), relative)
  const windows = fileAddressFor(id, DRIVE_CWD, 'D:\\AORUS\\a.ts')
  assert.equal(rewriteReferenceAddress(windows, () => session), windows)
  // In-distribution path with no known distribution: untouched rather than
  // rewritten to a share that may belong to another distribution.
  const noDistro: ReferenceSession = { cwd: DRIVE_CWD, distro: undefined }
  const inDistro = fileAddressFor(id, DRIVE_CWD, '/etc/hosts')
  assert.equal(rewriteReferenceAddress(inDistro, () => noDistro), inDistro)
  // Addresses outside the scope, and a non-address.
  for (const other of ['sidebar://guide', 'dsh-resource://file/absolute/D:/x', 'not-an-address']) {
    assert.equal(rewriteReferenceAddress(other, () => session), other)
  }
})

test('a drvfs path is translated even when the distribution is unknown', () => {
  const id = 'session-1'
  const address = fileAddressFor(id, DRIVE_CWD, '/mnt/d/x.txt')
  assert.equal(
    rewriteReferenceAddress(address, () => ({ cwd: DRIVE_CWD, distro: undefined })),
    sessionFileAddress(id, 'D:/x.txt'),
  )
})

test('workspace classification and distribution lookup use the canonical drive key', () => {
  const driveKeys = new Set(['d:\\aorus\\documents\\deepseek-harness\\default-workspace'])
  const distros = new Map([['d:\\aorus\\documents\\deepseek-harness\\default-workspace', UBUNTU]])
  assert.equal(isWslWorkspace(DRIVE_CWD, driveKeys), true)
  assert.equal(isWslWorkspace('D:\\AORUS\\Documents\\deepseek-harness\\DEFAULT-WORKSPACE', driveKeys), true)
  assert.equal(isWslWorkspace(UNC_CWD, new Set()), true)
  assert.equal(isWslWorkspace('C:\\Users\\mille\\plain', driveKeys), false)
  assert.equal(distroOfWorkspace(DRIVE_CWD, distros), UBUNTU)
  assert.equal(distroOfWorkspace(UNC_CWD, new Map()), UBUNTU)
  assert.equal(distroOfWorkspace('C:\\Users\\mille\\plain', distros), undefined)
  assert.equal(distroOfWorkspace(DRIVE_CWD, new Map()), undefined)
})

/**
 * The address grammar this module mirrors, cross-checked against the package
 * that owns it.
 *
 * The mirror exists because the grammar is not importable in six of the eleven
 * declared releases: four (0.1.0-rc.7 … 0.1.1-rc.2) ship no
 * `@deepseek-ai/dsh-util-workspace-path` at all, and the next two
 * (0.1.2-rc.1, 0.1.3-alpha.2) export only the display helpers — the grammar
 * arrived with the document preview itself, in 0.1.5-rc.1. So the client bundle
 * cannot import it, which makes drift the real risk — and this case is the
 * guard. Where the owning package is resolvable AND exports the
 * grammar, every address shape must agree with it byte for byte.
 */
test('the mirrored address grammar agrees with the package that owns it', async (t) => {
  let owner: {
    sessionFileAddress?(sessionId: string, path: string): string
    parseFileAddress?(address: string): { scope: string; sessionId?: string; path: string } | undefined
  }
  // The specifier is indirect on purpose: the package is optional here (six of
  // the declared releases do not ship it), so a literal import would make
  // `tsc` demand a dependency this plugin deliberately does not declare.
  const specifier = '@deepseek-ai/dsh-util-workspace-path'
  try {
    owner = await import(specifier) as unknown as typeof owner
  } catch {
    t.skip('@deepseek-ai/dsh-util-workspace-path is not resolvable from this copy: the client bundle inlines the mirror, and only a checkout with the harness packages installed can cross-check it')
    return
  }
  if (typeof owner.sessionFileAddress !== 'function' || typeof owner.parseFileAddress !== 'function') {
    t.skip('this release\'s copy exports no address grammar: it arrived with the document preview in 0.1.5-rc.1, and the releases that have no preview have no file addresses to translate')
    return
  }
  const build = owner.sessionFileAddress
  const parse = owner.parseFileAddress
  const id = 'session-8f4b3e9e-b48c-4920-b9ac-c4b8b85f1501'
  for (const path of [
    'relative/file.txt',
    'nested/dir/a b.txt',
    '/mnt/d/AORUS/pkg/package.json',
    '/root/workspace/memcache/VERSION',
    'D:/AORUS/pkg/package.json',
    '//wsl.localhost/Ubuntu/root/workspace/memcache/VERSION',
    'a:b/c:d',
    'unicode/文件.txt',
  ]) {
    assert.equal(sessionFileAddress(id, path), build(id, path), `encode ${path}`)
    assert.deepEqual(
      parseSessionFileAddress(sessionFileAddress(id, path)),
      { sessionId: id, path: parse(build(id, path))?.path ?? '' },
      `decode ${path}`,
    )
  }
})


test('rewriting retains navigation suffixes and encoded special filename characters', () => {
  const name = '目录/a b#%?.md'
  const suffix = '?line=12&column=3#L12'
  const address = sessionFileAddress('source #1', `/mnt/d/projects/demo/${name}`) + suffix
  assert.equal(rewriteReferenceAddress(address, () => ({ cwd: 'D:/projects/demo', distro: undefined })),
    sessionFileAddress('source #1', name) + suffix)
})


test('nonstandard mounts are never mistaken for drives and native spellings are untouched', () => {
  const known = () => ({ cwd: 'D:/projects/demo', distro: 'Debian' })
  const unknown = () => ({ cwd: 'D:/projects/demo', distro: undefined })
  for (const path of ['/media/d/report.md', '/mnt/data/report.md', '/mnt/dd/report.md', '/home/user/report.md', '/root/report.md']) {
    const address = sessionFileAddress('source', path)
    assert.equal(rewriteReferenceAddress(address, unknown), address)
    assert.equal(rewriteReferenceAddress(address, known), sessionFileAddress('source', `//wsl.localhost/Debian${path}`))
  }
  for (const path of ['relative/a b#%?.md', 'D:/projects/demo/report.md', '//server/share/report.md', '//wsl$/Ubuntu/home/a.md']) {
    const address = sessionFileAddress('source', path)
    assert.equal(rewriteReferenceAddress(address, known), address)
  }
})

test('repeated mounting retires previous hooks, including later chains, without duplicate lookup', () => {
  const calls: unknown[][] = []
  let lookups = 0
  const sessionOf = () => { lookups++; return { cwd: 'D:/projects/demo', distro: undefined } }
  const originalOpen = (address: string, options?: unknown) => { calls.push([address, options]) }
  const originalIn = (id: string, address: string, options?: unknown) => { calls.push([id, address, options]) }
  const controller = { openResource: originalOpen, openResourceIn: originalIn }
  const first = mountReferenceNavigation(controller, sessionOf)
  const previousIn = controller.openResourceIn
  const laterIn = (id: string, address: string, options?: unknown) => previousIn(id, address, options)
  controller.openResourceIn = laterIn
  const second = mountReferenceNavigation(controller, sessionOf)
  first() // a stale disposer must not remove the newer installation
  const address = sessionFileAddress('source', '/mnt/d/projects/demo/report.md')
  const options = { params: { line: 2 }, revealIfOpened: true }
  controller.openResource(address, options)
  controller.openResourceIn('target', address, options)
  assert.equal(lookups, 2)
  assert.deepEqual(calls, [[sessionFileAddress('source', 'report.md'), options], ['target', sessionFileAddress('source', 'report.md'), options]])
  second()
  second() // disposal is idempotent
  assert.equal(controller.openResource, originalOpen)
  assert.equal(controller.openResourceIn, laterIn)
  controller.openResourceIn('target', address)
  assert.equal(lookups, 2, 'a wrapper retained by another component is inert')
  assert.equal(calls.at(-1)?.[1], address)
})


test('async internal translation keeps encoded identity, navigation, and metadata/content coordinate', async () => {
  const calls: string[] = []
  const source = { cwd: 'D:/projects/demo', distro: undefined }
  const controller = {
    openResource(address: string) { calls.push(address) },
    openResourceIn(_id: string, address: string) { calls.push(address) },
  }
  const id = 'source #1'
  const path = '/root/目录/a b#%?.md'
  const suffix = '?line=12&column=2#L12'
  const address = sessionFileAddress(id, path) + suffix
  const dispose = mountReferenceNavigation(controller, () => source, async sessionId => {
    assert.equal(sessionId, id)
    return { ...source, distro: 'Ubuntu-20.04' }
  })
  controller.openResource(address)
  controller.openResourceIn('visible-other-session', address)
  await new Promise(resolve => setImmediate(resolve))
  const expected = sessionFileAddress(id, `//wsl.localhost/Ubuntu-20.04${path}`) + suffix
  assert.deepEqual(calls, [expected, expected])
  // The metadata provider and document reader both decode this exact pair.
  assert.deepEqual(calls.map(parseSessionFileAddress), [
    { sessionId: id, path: `//wsl.localhost/Ubuntu-20.04${path}` },
    { sessionId: id, path: `//wsl.localhost/Ubuntu-20.04${path}` },
  ])
  dispose()
})
