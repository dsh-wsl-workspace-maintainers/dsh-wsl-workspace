/**
 * Unit tests for the pure path-translation core. Run with
 * `node --import tsx/esm --test tests/paths.test.ts` from the plugin directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalWindowsPath,
  isAbsoluteLinuxPath,
  isValidWslUsername,
  isWindowsPathShaped,
  isWslUnc,
  joinUnc,
  mntToWindowsPath,
  normalizeLinuxPath,
  parseWslUnc,
  uncToLinux,
  windowsToMntPath,
} from '../src/shared/paths.ts'

test('parseWslUnc accepts the WSL2 localhost form', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'), {
    distro: 'Ubuntu',
    linuxPath: '/home/me/proj',
  })
})

test('parseWslUnc accepts the legacy wsl$ interop form', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl$\\Debian\\etc\\hosts'), {
    distro: 'Debian',
    linuxPath: '/etc/hosts',
  })
})

test('parseWslUnc accepts forward-slash spellings', () => {
  assert.deepEqual(parseWslUnc('//wsl.localhost/Ubuntu/var/log'), {
    distro: 'Ubuntu',
    linuxPath: '/var/log',
  })
})

test('parseWslUnc maps the distribution root to "/"', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\'), {
    distro: 'Ubuntu',
    linuxPath: '/',
  })
})

test('parseWslUnc rejects non-WSL paths', () => {
  for (const bad of ['C:\\work', '\\\\server\\share\\x', '/home/me', 'wsl.localhost\\Ubuntu\\x', '']) {
    assert.equal(parseWslUnc(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('isWslUnc mirrors parseWslUnc', () => {
  assert.equal(isWslUnc('\\\\wsl.localhost\\Ubuntu\\x'), true)
  assert.equal(isWslUnc('C:\\x'), false)
})

test('uncToLinux strips the UNC prefix', () => {
  assert.equal(uncToLinux('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'), '/home/me/proj')
})

test('uncToLinux throws on non-WSL input', () => {
  assert.throws(() => uncToLinux('C:\\work'), /not a WSL UNC path/)
})

test('joinUnc round-trips with parseWslUnc', () => {
  const unc = joinUnc('Ubuntu', '/home/me/proj')
  assert.equal(unc, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')
  assert.deepEqual(parseWslUnc(unc), { distro: 'Ubuntu', linuxPath: '/home/me/proj' })
})

test('joinUnc maps the root to a bare distro share', () => {
  assert.equal(joinUnc('Ubuntu', '/'), '\\\\wsl.localhost\\Ubuntu')
  assert.deepEqual(parseWslUnc(joinUnc('Ubuntu', '/')), { distro: 'Ubuntu', linuxPath: '/' })
})

test('joinUnc rejects non-absolute Linux paths', () => {
  assert.throws(() => joinUnc('Ubuntu', 'relative/path'), /non-absolute Linux path/)
})

test('joinUnc rejects separator or dot-dir distro names (UNC escape guard)', () => {
  for (const bad of ['', '.', '..', 'Ubuntu\\x', 'a/b']) {
    assert.throws(() => joinUnc(bad, '/home'), /invalid distribution name/, `expected reject for ${JSON.stringify(bad)}`)
  }
})

test('normalizeLinuxPath collapses slashes and trims trailing slash', () => {
  assert.equal(normalizeLinuxPath('/home//me///proj/'), '/home/me/proj')
  assert.equal(normalizeLinuxPath('/'), '/')
})

test('isAbsoluteLinuxPath requires a leading slash', () => {
  assert.equal(isAbsoluteLinuxPath('/home'), true)
  assert.equal(isAbsoluteLinuxPath('home'), false)
  assert.equal(isAbsoluteLinuxPath('/bad\u0000'), false)
})

test('a path with repeated separators or a non-ASCII name maps to one canonical /mnt form', () => {
  // Users paste paths, and a tool that doubles a separator should not produce a second spelling of the
  // same directory: `/mnt/c//项目` and `/mnt/c/项目` became two cache keys, so the skill scan root and the
  // workspace store disagreed about which path this is (measured 2026-10-20 while looking for the next
  // unguarded surface).
  //
  // The backslash is spelled `String.fromCharCode(92)` on purpose: this file has been edited through
  // tooling that mangles a literal escape, and a test whose input is not what it reads is worse than none.
  const BS = String.fromCharCode(92)
  const win = (...parts: string[]): string => parts.join(BS)
  assert.equal(windowsToMntPath(`C://项目//src`), '/mnt/c/项目/src')
  assert.equal(windowsToMntPath(`C:/${BS}/项目`), '/mnt/c/项目')
  assert.equal(windowsToMntPath(win('C:', '', '用户', '', '项目')), '/mnt/c/用户/项目')
  assert.equal(windowsToMntPath(win('C:', 'Program Files', 'x')), '/mnt/c/Program Files/x')
  // The drive root has no segment to append, and must not gain a trailing slash.
  assert.equal(windowsToMntPath(`F:${BS}`), '/mnt/f')
  // …and the inverse round-trips a non-ASCII path.
  assert.equal(mntToWindowsPath('/mnt/c/用户/项目'), win('C:', '用户', '项目'))
})

test('windowsToMntPath maps drive letters under /mnt', () => {
  assert.equal(windowsToMntPath('C:\\work\\src'), '/mnt/c/work/src')
  assert.equal(windowsToMntPath('D:/other'), '/mnt/d/other')
  assert.equal(windowsToMntPath('C:\\'), '/mnt/c')
  assert.equal(windowsToMntPath('x:\\'), '/mnt/x')
  assert.equal(windowsToMntPath('no-drive'), null)
})

test('mntToWindowsPath round-trips with windowsToMntPath', () => {
  for (const win of ['C:\\work\\src', 'D:\\', 'E:\\a b\\c']) {
    const mnt = windowsToMntPath(win)
    assert.notEqual(mnt, null)
    assert.equal(mntToWindowsPath(mnt!), win.replace(/\//g, '\\'))
  }
  assert.equal(mntToWindowsPath('/home/me'), null)
})

test('canonicalWindowsPath unifies drive-path spellings for store keys', () => {
  assert.equal(canonicalWindowsPath('C:\\Users\\Me\\Proj'), 'c:\\users\\me\\proj')
  assert.equal(canonicalWindowsPath('D:/Work//Src\\'), 'd:\\work\\src')
  assert.equal(canonicalWindowsPath('C:\\'), 'c:\\')
  assert.equal(canonicalWindowsPath('no-drive'), null)
  assert.equal(canonicalWindowsPath('/home/me'), null)
  assert.equal(canonicalWindowsPath('\\\\wsl.localhost\\Ubuntu'), null)
})

test('isWindowsPathShaped classifies path values for WSLENV', () => {
  assert.equal(isWindowsPathShaped('C:\\Users\\me'), true)
  assert.equal(isWindowsPathShaped('\\\\wsl.localhost\\Ubuntu'), true)
  assert.equal(isWindowsPathShaped('/home/me'), false)
  assert.equal(isWindowsPathShaped('plain-value'), false)
})

test('isValidWslUsername accepts Linux-shaped usernames', () => {
  for (const good of ['root', 'me', '_svc', 'user.name', 'user-1', 'U_2.x']) {
    assert.equal(isValidWslUsername(good), true, `expected accept for ${JSON.stringify(good)}`)
  }
})

test('isValidWslUsername rejects option-like or malformed usernames', () => {
  for (const bad of ['', '-x', '1abc', 'a b', 'a/b', 'a\nb', 'x'.repeat(65), '..', '.', 'a\\b']) {
    assert.equal(isValidWslUsername(bad), false, `expected reject for ${JSON.stringify(bad)}`)
  }
})
