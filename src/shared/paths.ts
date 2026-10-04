/**
 * WSL path helpers shared by the client and host halves. Pure and
 * dependency-free so both planes can import them without a runtime edge.
 */

/** WSL2 default loopback bridge host: `\\wsl.localhost\<distro>\...`. */
const WSL_LOCALHOST_HOST = 'wsl.localhost'
/** Legacy WSL interop host: `\\wsl$\<distro>\...`. */
const WSL_LEGACY_HOST = 'wsl$'

/** The two UNC hosts WSL exposes a distribution's filesystem under. */
const UNC_HOSTS = [WSL_LOCALHOST_HOST, WSL_LEGACY_HOST]

/** One WSL workspace coordinate parsed out of a UNC path. */
export interface WslUncTarget {
  /** Distro name (e.g. `Ubuntu`) as `wsl -l -q` reports it. */
  readonly distro: string
  /** Normalized absolute Linux path (leading `/`; no trailing slash except root). */
  readonly linuxPath: string
}

/**
 * Parse a WSL UNC path into its distro and Linux path. Accepts the WSL2
 * `\\wsl.localhost\<distro>\<linux>` form, the legacy `\\wsl$\<distro>\<linux>`
 * interop form, and forward-slash spellings of either.
 * @param raw - candidate absolute path.
 * @returns the parsed target, or null when the path is not a WSL UNC.
 */
export function parseWslUnc(raw: string): WslUncTarget | null {
  const normalized = raw.replace(/\\/g, '/').replace(/\/\/+/g, '//')
  if (!normalized.startsWith('//')) return null
  const segments = normalized.slice(2).split('/')
  const host = (segments[0] ?? '').toLowerCase()
  if (!UNC_HOSTS.includes(host)) return null
  const distro = segments[1] ?? ''
  if (distro === '') return null
  const rest = segments.slice(2).filter(segment => segment.length > 0)
  return { distro, linuxPath: `/${rest.join('/')}` }
}

/**
 * Whether a path resolves into a WSL distro through either UNC form.
 * @param raw - candidate absolute path.
 * @returns whether the path parses as a WSL UNC.
 */
export function isWslUnc(raw: string): boolean {
  return parseWslUnc(raw) !== null
}

/**
 * Translate a WSL UNC path to the absolute Linux path a process inside the
 * distribution can open. Throws on non-WSL input: callers rely on this
 * conversion to hand paths to the Linux world, so a silent pass-through
 * would hand a Windows path to bash.
 * @param uncPath - a path {@link parseWslUnc} accepts.
 * @returns the absolute Linux path.
 */
export function uncToLinux(uncPath: string): string {
  const parts = parseWslUnc(uncPath)
  if (parts === null) {
    throw new Error(`wsl-workspace: "${uncPath}" is not a WSL UNC path`)
  }
  return parts.linuxPath
}

/**
 * Normalize a Linux absolute path for the Host: collapse repeated slashes and
 * strip a trailing slash (root becomes `/`).
 * @param path - absolute Linux path.
 * @returns the normalized path.
 */
export function normalizeLinuxPath(path: string): string {
  const collapsed = path.replace(/\/+/g, '/')
  return collapsed === '/' ? '/' : collapsed.replace(/\/$/, '')
}

/**
 * Rewrite a path's separators to `/`, the spelling every comparison and the
 * address grammar use. Windows spellings reach this plugin from workspace roots,
 * tool arguments and the workspace store, so the rewrite lives here with the
 * other spelling pairs instead of being repeated by each caller.
 * @param value - the path to normalize.
 * @returns the same path with `\` written as `/`.
 */
export function toPosixSpelling(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * Whether a path is an absolute, non-empty Linux path.
 * @param path - candidate.
 * @returns whether it starts with `/` and contains no NUL.
 */
export function isAbsoluteLinuxPath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\0')
}

/**
 * Join a distro and a Linux absolute path into the WSL2 UNC form used as the
 * workspace identity (`\\wsl.localhost\<distro>\<linux>`, backslash segments).
 * @param distro - distro name.
 * @param linuxPath - absolute Linux path (leading `/`).
 * @returns the UNC path.
 */
export function joinUnc(distro: string, linuxPath: string): string {
  if (!isAbsoluteLinuxPath(linuxPath)) {
    throw new Error(`wsl-workspace: cannot map a non-absolute Linux path "${linuxPath}" to UNC`)
  }
  // Defense in depth: a distribution name with separators or dot-dirs would
  // escape the `\\wsl.localhost\` share structure (the host route validates
  // wire-supplied names too; every other caller passes through here).
  if (distro === '' || distro === '.' || distro === '..' || /[\\/]/.test(distro)) {
    throw new Error(`wsl-workspace: invalid distribution name "${distro}"`)
  }
  const normalized = linuxPath.replace(/\/+/g, '/').replace(/\/$/, '')
  const withoutLeading = normalized.startsWith('/') ? normalized.slice(1) : normalized
  const windowsSegments = withoutLeading.replace(/\//g, '\\')
  const suffix = windowsSegments === '' ? '' : `\\${windowsSegments}`
  return `\\\\wsl.localhost\\${distro}${suffix}`
}

/**
 * Translate a Windows drive path to the drvfs mount path WSL distributions
 * conventionally expose it at (`C:\foo` → `/mnt/c/foo`). Only single-letter
 * drives under `/mnt` are mapped; custom mount points are out of scope.
 * @param path - the candidate Windows path.
 * @returns the `/mnt/<drive>/…` path, or `null` for non-drive paths.
 */
export function windowsToMntPath(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return `/mnt/${(match[1] ?? '').toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

/**
 * Translate a `/mnt/<drive>/…` path back to its Windows drive path.
 * @param linuxPath - the candidate Linux path.
 * @returns the `X:\…` drive path, or `null` when the path is not a drvfs mount.
 */
export function mntToWindowsPath(linuxPath: string): string | null {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(linuxPath)
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${(match[1] ?? '').toUpperCase()}:\\${rest}`
}

/**
 * The spelling of an absolute Linux path that the HARNESS HOST can open.
 *
 * A file reference in a WSL session carries the path exactly as the model wrote
 * it — an absolute Linux path — and the client hands that path to the host,
 * which resolves it with `node:path.resolve(cwd, path)`. On Windows a POSIX
 * absolute path is root-relative there, so `/mnt/d/x` becomes
 * `<cwd drive>:\mnt\d\x` and `/etc/hosts` becomes `<cwd drive>:\etc\hosts`;
 * when the cwd is itself a UNC share the path lands under that share's root
 * instead. Neither is the file the model named, so the document preview reports
 * it missing. This maps the path onto a spelling that names the same file for
 * the host: a drvfs mount back to its drive letter, and anything else through
 * the distribution's UNC share.
 *
 * `/mnt/<drive>` needs no distribution: the mount name IS the drive. Every
 * other path is inside the distribution's own filesystem, so it needs one —
 * from the session's UNC cwd, or from the registered workspace of a drive cwd.
 *
 * @param linuxPath - the absolute Linux path a reference carries.
 * @param distro - the session's WSL distribution, when known.
 * @returns the host-readable spelling, or `null` when the path cannot be translated.
 */
export function hostPathForLinuxReference(linuxPath: string, distro: string | undefined): string | null {
  if (!isAbsoluteLinuxPath(linuxPath)) return null
  // A `//`-prefixed spelling is already a UNC host path, not a Linux one.
  if (linuxPath.startsWith('//')) return null
  const drive = mntToWindowsPath(linuxPath)
  if (drive !== null) return drive
  if (distro === undefined || distro === '') return null
  return joinUnc(distro, linuxPath)
}

/**
 * Canonical Windows drive path for store keys and cross-realm identity:
 * separators unified to `\`, trailing separator stripped, and the WHOLE path
 * lowercased — Windows paths compare case-insensitively, and the workspace
 * registry may realpath a different casing than the caller spelled (8.3 or
 * on-disk casing), so the store key must collide across casings.
 * @param path - candidate Windows drive path.
 * @returns the canonical form, or `null` when not drive-shaped.
 */
export function canonicalWindowsPath(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return `${(match[1] ?? '').toLowerCase()}:\\${rest}`
}

/**
 * True when a value is a Windows-shaped path (drive or UNC), which is how
 * the shell executor decides the WSLENV `/p` translation flag: only Windows
 * path values need translation when they cross into the Linux process.
 * @param value - the environment value to classify.
 * @returns whether the value looks like a Windows path.
 */
export function isWindowsPathShaped(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Linux username shape for `wsl.exe -u`: starts with a letter or underscore, then letters/digits/`_`/`.`/`-` (max 64). */
const WSL_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

/**
 * Whether a value is a safe Linux username for `wsl.exe -u`. The check is
 * strict on purpose: a value starting with `-` could be parsed as a wsl.exe
 * option instead of a username.
 * @param value - candidate username.
 * @returns whether it matches the Linux username shape.
 */
export function isValidWslUsername(value: string): boolean {
  return WSL_USERNAME_PATTERN.test(value)
}
