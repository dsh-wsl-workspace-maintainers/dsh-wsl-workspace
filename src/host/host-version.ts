/**
 * The host family's release, read from wherever this plugin is actually installed.
 *
 * The variant generator needs the family release to decide whether the upstream
 * `tool-subagent` registration gate is present ({@link hostLacksSubagentGate}). Before this
 * module existed the probe was one `import.meta.resolve('@deepseek-ai/dsh-tools')` followed by a
 * walk up for the manifest, which answers only when the host packages sit on a filesystem the
 * plugin's own resolver can walk. On DSH Desktop they do not: the host lives inside
 * `app.asar`, and the plugin is loaded from the profile, so that resolve throws
 * `ERR_MODULE_NOT_FOUND` and the probe returns `undefined` on every Desktop install. Because the
 * predicate is fail-closed, `undefined` reads as "the gate is missing" — which is why narrowing
 * the predicate alone would still have stripped the delegation row from every Desktop session.
 *
 * Two strategies, in order:
 *
 *  1. **Resolve and walk.** Correct and cheap where it works (`dsh web`, a dev tree, any profile
 *     whose closure is on disk). Unchanged from the pre-existing behaviour.
 *  2. **Read the packaged archive.** A DSH Desktop ships its host at
 *     `<resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools`. The archive is a
 *     small header (a pickle: two lengths, then a JSON directory) followed by the file data at
 *     a 4-byte-aligned offset, so one manifest can be read with plain `node:fs` and two small
 *     reads — no Electron API, no `asar` dependency, and no 200 MB slurp.
 *
 * An archive that cannot be found or parsed returns `undefined`, which keeps the caller's
 * fail-closed reading. This module deliberately imports nothing but `node:` builtins: it is
 * loaded during boot and is covered by the pure-node test bucket, which must not drag a host
 * package in (see `scripts/check-unit-closure.mjs`).
 * @module dsh-wsl-workspace/host/host-version
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package whose manifest names the host family's release. */
const FAMILY_PACKAGE = '@deepseek-ai/dsh-tools'

/** Where the host family package sits inside a packaged Desktop archive, most likely first. */
const ARCHIVE_MEMBER_CANDIDATES = [
  `dsh/node_modules/${FAMILY_PACKAGE}/package.json`,
  `node_modules/${FAMILY_PACKAGE}/package.json`,
]

/** The pickle header's byte length: two length fields, then the payload length. */
const PICKLE_HEADER_BYTES = 16

/** Round up to the 4-byte alignment the archive pads its directory to. */
function align4(value: number): number {
  return Math.ceil(value / 4) * 4
}

/**
 * Read one text member out of an asar archive.
 *
 * The container is Electron's, and its shape is small enough to read directly: 16 bytes of
 * pickle header whose third `uint32` is the JSON directory's length, that directory, then the
 * member data at a 4-byte-aligned offset. Every member is described by a `size` and an `offset`
 * counted from that data base.
 * @param archive - absolute path to the `.asar` file.
 * @param member - slash-separated path inside the archive, with no leading slash.
 * @returns the member's text, or `undefined` when it is absent, unpacked, or unreadable.
 */
export function readArchiveMember(archive: string, member: string): string | undefined {
  let fd: number | undefined
  try {
    if (!existsSync(archive) || !statSync(archive).isFile()) return undefined
    fd = openSync(archive, 'r')
    const head = Buffer.alloc(PICKLE_HEADER_BYTES)
    if (readSync(fd, head, 0, PICKLE_HEADER_BYTES, 0) < PICKLE_HEADER_BYTES) return undefined
    const directorySize = head.readUInt32LE(12)
    // A directory larger than the archive itself is a malformed header, not a big archive.
    if (directorySize === 0 || directorySize > statSync(archive).size) return undefined
    const directoryText = Buffer.alloc(directorySize)
    if (readSync(fd, directoryText, 0, directorySize, PICKLE_HEADER_BYTES) < directorySize) return undefined
    const directory = JSON.parse(directoryText.toString('utf8')) as { files?: Record<string, unknown> }
    let node: unknown = directory
    for (const part of member.split('/')) {
      const files = (node as { files?: Record<string, unknown> }).files
      node = files === undefined ? undefined : files[part]
      if (node === undefined) return undefined
    }
    const entry = node as { size?: unknown; offset?: unknown; unpacked?: unknown; files?: unknown }
    // A directory row, or a member kept outside the archive, has no in-archive bytes.
    if (entry.files !== undefined || entry.unpacked === true) return undefined
    const size = Number(entry.size)
    const offset = Number(entry.offset)
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0) return undefined
    const start = align4(PICKLE_HEADER_BYTES + directorySize) + offset
    const bytes = Buffer.alloc(size)
    if (readSync(fd, bytes, 0, size, start) < size) return undefined
    return bytes.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The archive paths a DSH Desktop install of this process could be running from.
 *
 * Pure on purpose: every fact is a parameter, so a test can describe a Desktop that is not the
 * one running it. `resourcesPath` is Electron's own answer and comes first; the derivation from
 * the executable covers a host that launches before that property is set (and keeps the check
 * meaningful when a test passes only an `execPath`).
 * @param input - the facts to derive candidates from.
 * @returns candidate archive paths, without duplicates, most likely first.
 */
export function archiveCandidates(input: { resourcesPath?: string | undefined, execPath?: string | undefined, platform?: string | undefined }): string[] {
  const found: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    if (!found.includes(value)) found.push(value)
  }
  if (input.resourcesPath !== undefined && input.resourcesPath !== '') add(join(input.resourcesPath, 'app.asar'))
  if (input.execPath !== undefined && input.execPath !== '') {
    const dir = dirname(input.execPath)
    add(join(dir, 'resources', 'app.asar'))
    // A macOS bundle keeps its resources one level deeper, beside `Contents/MacOS`.
    if (input.platform === 'darwin' || dir.includes('Contents')) add(join(dir, '..', 'Resources', 'app.asar'))
  }
  return found
}

/**
 * Walk up from one resolved module URL until a manifest names the family package.
 *
 * A manifest at the package root names the package; the walk stops there rather than trusting
 * whatever a hoisted parent claims.
 * @param entry - the module URL the resolver returned.
 * @returns the version it declares, or `undefined` when no manifest on the way names it.
 */
function versionFromResolvedEntry(entry: string): string | undefined {
  // `describeResolvedCopy` in `src/index.ts` does the same walk. The URL is decoded with
  // `fileURLToPath` rather than string surgery, because a Windows path behind a `file:` URL has
  // a drive letter that a naive `pathname` slice gets wrong (`/C:/…`), and `%20` for every space
  // in `DeepSeek Harness`.
  const start = entry.startsWith('file:') ? fileURLToPath(entry) : entry
  let dir = dirname(start)
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string, version?: string }
      if (manifest.name === FAMILY_PACKAGE) return manifest.version
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** The host facts the probe reads, injectable so a test can describe another install. */
export interface HostVersionProbe {
  /** The runtime's resolver, when it has one. */
  resolve?: ((specifier: string) => string) | undefined
  /** Electron's `process.resourcesPath`, when there is one. */
  resourcesPath?: string | undefined
  /** The running executable, used to derive the resources directory. */
  execPath?: string | undefined
  /** `process.platform`, for the macOS bundle shape. */
  platform?: string | undefined
}

/**
 * The host family's release, when it can be named.
 *
 * @param probe - the host facts; defaults to this process.
 * @returns the version string, or `undefined` when neither strategy names it.
 */
export function hostFamilyVersion(probe: HostVersionProbe = {}): string | undefined {
  if (probe.resolve !== undefined) {
    try {
      const resolved = probe.resolve(FAMILY_PACKAGE)
      const version = versionFromResolvedEntry(resolved)
      if (version !== undefined) return version
    } catch {
      // Not on this host's filesystem: fall through to the packaged archive.
    }
  }
  for (const archive of archiveCandidates({
    resourcesPath: probe.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath,
    execPath: probe.execPath ?? process.execPath,
    platform: probe.platform ?? process.platform,
  })) {
    for (const member of ARCHIVE_MEMBER_CANDIDATES) {
      const text = readArchiveMember(archive, member)
      if (text === undefined) continue
      try {
        const manifest = JSON.parse(text) as { name?: string, version?: string }
        if (manifest.name === FAMILY_PACKAGE && manifest.version !== undefined) return manifest.version
      } catch {
        // A member that is not JSON is not this package; try the next spelling.
      }
    }
  }
  return undefined
}

/**
 * The resolver `hostFamilyVersion` should be given for this runtime.
 * @returns the default resolver bound to this module, or `undefined` when the runtime has none.
 */
export function defaultResolver(): ((specifier: string) => string) | undefined {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve
  if (typeof resolve !== 'function') return undefined
  return (specifier: string) => resolve.call(import.meta, specifier)
}
