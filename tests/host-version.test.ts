/**
 * The host-version probe (issue #143).
 *
 * The variant generator decides whether to keep the copied delegation row by comparing the host
 * family release against the release that removed the upstream duplicate-registration defect.
 * That check is only as good as the probe feeding it, and on the one platform this plugin exists
 * for the probe used to answer `undefined`: a DSH Desktop keeps its host inside `app.asar`, and
 * `import.meta.resolve('@deepseek-ai/dsh-tools')` walks the filesystem, not the archive.
 *
 * These arms build real archives rather than stubbing `readArchiveMember`, because the property
 * under test is precisely the container's byte layout: the pickle header, the JSON directory
 * length in its third `uint32`, and the 4-byte-aligned data base every member `offset` is counted
 * from. A stub would pass while the offsets were wrong — which is the failure a packaged host
 * would actually show.
 *
 * The layout written here mirrors an Electron asar exactly; `readArchiveMember` reads it with
 * plain `node:fs`, so no Electron API is involved on either side.
 *
 *   node --experimental-strip-types --test tests/host-version.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveCandidates, hostFamilyVersion, readArchiveMember } from '../src/host/host-version.ts'

/** The family package whose manifest carries the release. */
const FAMILY = '@deepseek-ai/dsh-tools'

/**
 * Pad to the 4-byte alignment the archive uses for its data base.
 * @param value - a byte count.
 * @returns the next multiple of four.
 */
function align4(value: number): number {
  return Math.ceil(value / 4) * 4
}

/**
 * Write a minimal but structurally real asar archive.
 *
 * The container is: 16 bytes of pickle header (`uint32` 4, directory size, payload size, JSON
 * length), the JSON directory, 4-byte alignment padding, then member data. `offset` values are
 * counted from the aligned data base, exactly as the real format specifies.
 * @param path - where to write the archive.
 * @param members - archive path to file text.
 * @returns the path written.
 */
function writeArchive(path: string, members: Record<string, string>): string {
  // Build the directory tree from the flat member paths.
  type Dir = { files: Record<string, unknown> }
  const root: Dir = { files: {} }
  const payloads: Buffer[] = []
  for (const [memberPath, text] of Object.entries(members)) {
    const parts = memberPath.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const existing = node.files[part] as Dir | undefined
      if (existing === undefined) {
        const created: Dir = { files: {} }
        node.files[part] = created
        node = created
      } else {
        node = existing
      }
    }
    const bytes = Buffer.from(text, 'utf8')
    node.files[parts[parts.length - 1] as string] = { size: bytes.length, offset: String(payloads.reduce((sum, b) => sum + b.length, 0)) }
    payloads.push(bytes)
  }
  const directory = Buffer.from(JSON.stringify(root), 'utf8')
  const payload = Buffer.concat(payloads)
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0) // pickle size field
  header.writeUInt32LE(directory.length, 4) // directory size
  header.writeUInt32LE(directory.length, 8) // payload size field
  header.writeUInt32LE(directory.length, 12) // JSON length, what the reader uses
  const prefix = Buffer.concat([header, directory])
  const padding = Buffer.alloc(align4(prefix.length) - prefix.length)
  writeFileSync(path, Buffer.concat([prefix, padding, payload]))
  return path
}

/** A temp directory that is always removed. */
function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wsl-host-version-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The manifest text one host release publishes for the family package. */
function familyManifest(version: string): string {
  return JSON.stringify({ name: FAMILY, version })
}

test('readArchiveMember reads a member out of a real archive container', () => {
  withTempDir((dir) => {
    const archive = writeArchive(join(dir, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: familyManifest('0.2.2-rc.5'),
      'dsh/node_modules/@deepseek-ai/dsh-tool-subagent/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.2-rc.5' }),
      'dsh/README.md': '# a file that is not a manifest\n',
    })
    assert.equal(JSON.parse(readArchiveMember(archive, `dsh/node_modules/${FAMILY}/package.json`) as string).version, '0.2.2-rc.5')
    assert.equal(readArchiveMember(archive, 'dsh/README.md'), '# a file that is not a manifest\n')
    // A member the archive does not carry is absent, not a throw.
    assert.equal(readArchiveMember(archive, 'dsh/node_modules/nope/package.json'), undefined)
    // A directory row has no bytes to read.
    assert.equal(readArchiveMember(archive, 'dsh/node_modules'), undefined)
  })
})

test('readArchiveMember survives a path that is not an archive at all', () => {
  withTempDir((dir) => {
    const notAnArchive = join(dir, 'not-an-archive.asar')
    writeFileSync(notAnArchive, 'this is plainly not an asar container')
    assert.equal(readArchiveMember(notAnArchive, `dsh/node_modules/${FAMILY}/package.json`), undefined)
    assert.equal(readArchiveMember(join(dir, 'missing.asar'), `dsh/node_modules/${FAMILY}/package.json`), undefined)
  })
})

test('archiveCandidates derives the packaged host locations without duplicates', () => {
  // Electron's own answer comes first, and the executable derivation repeats it — deduped.
  assert.deepEqual(
    archiveCandidates({ resourcesPath: '/app/resources', execPath: '/app/DeepSeek Harness.exe', platform: 'win32' }),
    [join('/app/resources', 'app.asar')],
    'the two derivations name the same archive, so it must appear once',
  )
  // With only an executable, the resources directory is derived beside it.
  assert.deepEqual(
    archiveCandidates({ execPath: '/opt/app/DeepSeek Harness.exe', platform: 'win32' }),
    [join('/opt/app', 'resources', 'app.asar')],
  )
  // A macOS bundle keeps its resources one level up from Contents/MacOS.
  const mac = archiveCandidates({ execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', platform: 'darwin' })
  assert.equal(mac[0], join('/Applications/DeepSeek Harness.app/Contents/MacOS', 'resources', 'app.asar'))
  assert.ok(
    mac.includes(join('/Applications/DeepSeek Harness.app/Contents', 'Resources', 'app.asar')),
    `the macOS Resources shape is missing (got ${JSON.stringify(mac)})`,
  )
  // A host with neither fact names nothing rather than guessing.
  assert.deepEqual(archiveCandidates({}), [])
})

test('hostFamilyVersion reads a packaged host through its archive when nothing resolves', () => {
  withTempDir((dir) => {
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeArchive(join(resources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: familyManifest('0.2.2-rc.5'),
    })
    // This is the Desktop shape: the resolver throws exactly as it does on a real profile whose
    // host lives in app.asar, and the archive is the only remaining source.
    const version = hostFamilyVersion({
      resolve: () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }) },
      resourcesPath: resources,
      execPath: join(dir, 'DeepSeek Harness.exe'),
      platform: 'win32',
      electron: true,
    })
    assert.equal(version, '0.2.2-rc.5')
  })
})

test('hostFamilyVersion prefers a resolved copy over the archive', () => {
  withTempDir((dir) => {
    const packageDir = join(dir, 'node_modules', FAMILY)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), familyManifest('0.2.1-rc.2'))
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeArchive(join(resources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: familyManifest('0.2.2-rc.5'),
    })
    const version = hostFamilyVersion({
      resolve: () => join(packageDir, 'lib', 'index.js'),
      resourcesPath: resources,
      execPath: join(dir, 'exe'),
      platform: 'win32',
    })
    assert.equal(version, '0.2.1-rc.2', 'a resolvable on-disk closure must win over a stale archive')
  })
})

test('hostFamilyVersion prefers the Electron archive over a profile-local copy', () => {
  withTempDir((dir) => {
    const packageDir = join(dir, 'node_modules', FAMILY)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), familyManifest('0.2.1-rc.2'))
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeArchive(join(resources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: familyManifest('0.2.2-rc.5'),
    })
    const version = hostFamilyVersion({
      resolve: () => join(packageDir, 'lib', 'index.js'),
      resourcesPath: resources,
      execPath: join(dir, 'DeepSeek Harness.exe'),
      platform: 'win32',
      electron: true,
    })
    assert.equal(version, '0.2.2-rc.5', 'the running Desktop archive must win over a stale profile copy')
  })
})

test('hostFamilyVersion fails closed when an Electron archive exists but is unreadable', () => {
  withTempDir((dir) => {
    const packageDir = join(dir, 'node_modules', FAMILY)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), familyManifest('0.2.2-rc.5'))
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'app.asar'), 'not an archive')
    const version = hostFamilyVersion({
      resolve: () => join(packageDir, 'lib', 'index.js'),
      resourcesPath: resources,
      execPath: join(dir, 'DeepSeek Harness.exe'),
      platform: 'win32',
      electron: true,
    })
    assert.equal(version, undefined, 'a profile-local copy must not override an unreadable running archive')
  })
})

test('hostFamilyVersion does not fall through a malformed authoritative Electron archive', () => {
  withTempDir((dir) => {
    const badResources = join(dir, 'bad-resources')
    const goodResources = join(dir, 'app', 'resources')
    mkdirSync(badResources, { recursive: true })
    mkdirSync(goodResources, { recursive: true })
    writeFileSync(join(badResources, 'app.asar'), 'not an archive')
    writeArchive(join(goodResources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: familyManifest('0.2.2-rc.5'),
    })
    const version = hostFamilyVersion({
      resourcesPath: badResources,
      execPath: join(dir, 'app', 'DeepSeek Harness.exe'),
      platform: 'win32',
      electron: true,
    })
    assert.equal(version, undefined, 'the first existing archive is authoritative even when malformed')
  })
})

test('hostFamilyVersion falls back to resolve on Electron when no archive exists', () => {
  withTempDir((dir) => {
    const packageDir = join(dir, 'node_modules', FAMILY)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), familyManifest('0.2.2-rc.5'))
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    const version = hostFamilyVersion({
      resolve: () => join(packageDir, 'lib', 'index.js'),
      resourcesPath: resources,
      execPath: join(dir, 'DeepSeek Harness.exe'),
      platform: 'win32',
      electron: true,
    })
    assert.equal(version, '0.2.2-rc.5')
  })
})

test('hostFamilyVersion returns undefined when neither strategy names the family', () => {
  withTempDir((dir) => {
    // A resolver that finds nothing, and no archive anywhere.
    const version = hostFamilyVersion({
      resolve: () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }) },
      execPath: join(dir, 'exe'),
      platform: 'win32',
    })
    assert.equal(version, undefined, 'an unidentified host must stay unidentified rather than guess')
  })
})

test('hostFamilyVersion ignores a non-string archive version', () => {
  withTempDir((dir) => {
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeArchive(join(resources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: JSON.stringify({ name: FAMILY, version: 123 }),
    })
    assert.equal(hostFamilyVersion({ resourcesPath: resources, electron: true }), undefined)
  })
})

test('hostFamilyVersion ignores an archive whose manifest names another package', () => {
  withTempDir((dir) => {
    const resources = join(dir, 'resources')
    mkdirSync(resources, { recursive: true })
    writeArchive(join(resources, 'app.asar'), {
      [`dsh/node_modules/${FAMILY}/package.json`]: JSON.stringify({ name: '@deepseek-ai/dsh-something-else', version: '9.9.9' }),
    })
    const version = hostFamilyVersion({
      resolve: () => { throw new Error('nope') },
      resourcesPath: resources,
      execPath: join(dir, 'exe'),
      platform: 'win32',
    })
    assert.equal(version, undefined, 'a manifest that does not name the family is not the family’s release')
  })
})
