/**
 * File-reference path translation for the client half.
 *
 * A conversation's file references, the Files panel, and a turn tail's produced
 * files all open a file through the right Sidebar's navigation controller:
 * `ctx.sidebarRight.openResource(address)`. The address is a
 * `dsh-resource://file/session/<sessionId>/<path>` URL carrying the path EXACTLY
 * as it was written, and for a WSL session the model writes absolute LINUX
 * paths. The host decodes that address and resolves the path with
 * `node:path.resolve(cwd, path)`, where a POSIX absolute path is root-relative:
 * `/mnt/d/x` lands on the workspace drive (`D:\mnt\d\x`) and an in-distribution
 * path lands under the cwd share's root. Neither is the file the model named, so
 * the document pane reports `error.notFound` — or `EPERM`, for the drvfs mount
 * 9P cannot serve.
 *
 * The plugin cannot repair this on the host plane: `fs` and the
 * `workspaceFiles` endpoint belong to other plugins, and cordis refuses a second
 * `provide` for a name another fiber owns (`ctx.provide` "throws if the name is
 * already provided in this scope"), while neither publishes a path-resolution
 * hook. What the client half CAN do is hand the Sidebar the address of the file
 * the model actually meant, which is what this module computes. One hook at the
 * single navigation entry point covers every reference surface, because the
 * address a tab carries is also the address its metadata is read under.
 *
 * @module dsh-wsl-workspace/client/references
 */

import { canonicalWindowsPath, hostPathForLinuxReference, isWslUnc, parseWslUnc, toPosixSpelling } from '../shared/paths.ts'

/** What the translation needs to know about one session. */
export interface ReferenceSession {
  /** The session's workspace root; the base a relative path resolves against. */
  readonly cwd: string
  /**
   * The session's WSL distribution, when known: from a UNC cwd, or from the
   * registered workspace behind a `/mnt/<drive>` cwd.
   */
  readonly distro: string | undefined
}

/**
 * Look one session up, or answer `undefined` for a session this plugin does not
 * treat as WSL-bound — whose references must be left exactly as written.
 */
export type SessionLookup = (sessionId: string) => ReferenceSession | undefined

/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** The address scope whose path is resolved against one session's workspace. */
const SESSION_SCOPE = 'session'

/**
 * Component-encode one id or path segment, keeping `:` literal for drive
 * letters — the same rule `@deepseek-ai/dsh-util-workspace-path` encodes with.
 * @param segment - one path segment or the session id.
 * @returns the encoded segment.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * Build the address of a file read through one Session.
 *
 * Mirrors `sessionFileAddress` from `@deepseek-ai/dsh-util-workspace-path`,
 * which cannot be imported here: six of the eleven declared DSH releases
 * (0.1.0-rc.7 … 0.1.3-alpha.2) ship no such package, or ship it without the
 * address grammar — that arrived with the document preview itself, in
 * 0.1.5-rc.1. The grammar is the wire contract both halves already share.
 * @param sessionId - the Session whose workspace resolves the path.
 * @param path - absolute or workspace-relative path.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = toPosixSpelling(path).replace(/^(?:\.\/)+/, '')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `${FILE_ADDRESS_PREFIX}${SESSION_SCOPE}/${encodeSegment(sessionId)}/${encoded}`
}

/** The session and path one `session`-scoped file address names. */
export interface SessionFileAddress {
  readonly sessionId: string
  readonly path: string
}

/**
 * Read a `session`-scoped file address back into its parts.
 *
 * Mirrors `parseFileAddress` from `@deepseek-ai/dsh-util-workspace-path` for the
 * one scope this hook rewrites. Query and fragment suffixes are ignored, so a
 * caller that appended navigation parameters still matches.
 * @param address - a candidate address.
 * @returns the parts, or `null` for anything this hook does not understand.
 */
export function parseSessionFileAddress(address: string): SessionFileAddress | null {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return null
  const end = address.search(/[?#]/)
  const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const [scope, ...rest] = body.split('/')
  if (scope !== SESSION_SCOPE) return null
  const [id, ...segments] = rest
  if (id === undefined || id === '' || segments.length === 0) return null
  try {
    return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
  } catch {
    // A malformed escape is not an address this hook can rebuild.
    return null
  }
}

/** Whether a path is absolute in either spelling the host accepts. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}

/**
 * Build the address for a path as a caller holds it, relative to the session's
 * workspace when it lies inside it. Mirrors `fileAddressFor` from
 * `@deepseek-ai/dsh-util-workspace-path`: keeping a translated path inside the
 * workspace makes the address identical to the one the Files panel builds for
 * the same file, so the Sidebar reveals the open tab instead of duplicating it.
 * @param sessionId - the Session the path is read in.
 * @param cwd - that Session's workspace root.
 * @param path - the path to address.
 * @returns the `dsh-resource://file/…` address.
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = toPosixSpelling(path)
  if (!isAbsolutePath(normalized)) return sessionFileAddress(sessionId, normalized)
  const root = cwd === undefined ? '' : toPosixSpelling(cwd).replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) {
    return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  }
  return sessionFileAddress(sessionId, normalized)
}

/**
 * The address of the file a WSL session's reference actually names.
 *
 * Anything the hook does not fully understand is returned untouched: an address
 * outside this scope, a path that is already host-readable, a session the plugin
 * does not know, or a path whose distribution is unknown. Rewriting is only
 * worth doing when the result is certain to name the same file, so a
 * non-matching address is a pass-through rather than a guess.
 * @param address - the address a caller is about to open.
 * @param sessionOf - the lookup answering each address's session.
 * @returns the address to open: the translated one, or the caller's own.
 */
export function rewriteReferenceAddress(address: string, sessionOf: SessionLookup): string {
  const parsed = parseSessionFileAddress(address)
  if (parsed === null) return address
  // Rebuild-check: an address whose own encoding this module cannot reproduce
  // byte-for-byte is a grammar it does not understand, so it is left alone
  // instead of being rewritten into something the host would read differently.
  if (!address.startsWith(sessionFileAddress(parsed.sessionId, parsed.path))) return address
  const session = sessionOf(parsed.sessionId)
  if (session === undefined) return address
  const translated = hostPathForLinuxReference(parsed.path, session.distro)
  if (translated === null) return address
  return fileAddressFor(parsed.sessionId, session.cwd, translated)
}

/**
 * The distribution a session's workspace belongs to.
 *
 * A UNC cwd names it directly. A drive cwd is a `/mnt/<drive>` workspace, whose
 * distribution the host stored at registration time and the client caches; when
 * that cache is empty the answer is `undefined` and in-distribution references
 * stay untranslated rather than being rewritten to a wrong share.
 * @param cwd - the session's workspace root.
 * @param driveDistros - registered Windows drive workspaces, by canonical key.
 * @returns the distribution name, or undefined when it is not known.
 */
export function distroOfWorkspace(cwd: string, driveDistros: ReadonlyMap<string, string>): string | undefined {
  const unc = parseWslUnc(cwd)
  if (unc !== null) return unc.distro
  const canonical = canonicalWindowsPath(cwd)
  return canonical === null ? undefined : driveDistros.get(canonical)
}

/**
 * Whether a workspace root makes its sessions WSL-bound: a WSL UNC path, or a
 * Windows drive path registered as a `/mnt/<drive>` workspace (9P cannot serve
 * drvfs, so those workspaces carry drive cwds).
 * @param cwd - the session's workspace root.
 * @param wslWindowsPaths - canonical drive keys of the registered `/mnt/<drive>` workspaces.
 * @returns whether the session runs in the WSL world.
 */
export function isWslWorkspace(cwd: string, wslWindowsPaths: ReadonlySet<string>): boolean {
  if (isWslUnc(cwd)) return true
  const canonical = canonicalWindowsPath(cwd)
  return canonical !== null && wslWindowsPaths.has(canonical)
}
