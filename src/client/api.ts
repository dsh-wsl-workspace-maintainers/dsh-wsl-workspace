/**
 * Thin fetch client for the Host plugin route. The browser calls
 * POST /wsl-workspace/api with a `{ method, params }` envelope and the Host
 * answers `{ ok: true, value }` or `{ ok: false, error }`.
 */

/** Relative route the Host half registers (same-origin with the web server). */
const ENDPOINT = '/wsl-workspace/api'

/** One directory entry as the Host lists it. */
export interface WslDirEntry {
  name: string
  kind: 'directory' | 'file' | 'other'
}

/** One directory level plus its breadcrumb ancestry. */
export interface WslDirListing {
  /** The listed absolute Linux path. */
  path: string
  /** Parent Linux path, or null at the filesystem root. */
  parent: string | null
  /** The level's children (in name order; the client filters to directories). */
  entries: WslDirEntry[]
}

/** Existence/directory check result for one Linux path. */
export interface WslPathCheck {
  exists: boolean
  isDirectory: boolean
}

/** Wire envelope the Host route answers with. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

/** Human text for an unknown rejection, reusing the repository's idiom. */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Perform one POST call and unwrap the envelope.
 * @param method - the Host method name.
 * @param params - the method payload.
 * @returns the unwrapped value, or throws an Error on network or `ok:false`.
 */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
  } catch (error) {
    // The transport refused before answering (offline, origin mismatch, 404).
    throw new Error(`wsl-workspace request failed: ${errorMessage(error)}`)
  }
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    // A non-JSON body means a proxy/loader answered instead of the Host route.
    throw new Error(`wsl-workspace answered non-JSON (${response.status})`)
  }
  if (!envelope.ok) throw new Error(envelope.error)
  return envelope.value
}

/**
 * List the WSL distros installed on the host.
 * @returns distro names in registry order.
 */
export async function listDistros(): Promise<string[]> {
  return call<string[]>('listDistros', {})
}

/**
 * List one directory level inside a distro.
 * @param distro - distro name.
 * @param path - absolute Linux directory to list.
 * @returns the level's listing with ancestry.
 */
export async function listDir(distro: string, path: string): Promise<WslDirListing> {
  return call<WslDirListing>('listDir', { distro, path })
}

/**
 * Check whether a Linux path exists and is a directory.
 * @param distro - distro name.
 * @param path - absolute Linux path.
 * @returns existence and directory facts.
 */
export async function check(distro: string, path: string): Promise<WslPathCheck> {
  return call<WslPathCheck>('check', { distro, path })
}

/**
 * Store (or clear, with an empty string) the username of one WSL workspace.
 * @param path - the workspace UNC path.
 * @param username - the Linux username; empty string clears the stored value.
 */
export async function setWorkspaceUser(path: string, username: string): Promise<void> {
  return call<void>('setUser', { path, username })
}

/**
 * Register a `/mnt/<drive>` WSL workspace under its Windows drive path,
 * recording the distro (and optional username) for the session env.
 * @param linuxPath - the `/mnt/<drive>/…` Linux path.
 * @param distro - the WSL distribution the workspace belongs to.
 * @param username - optional Linux username.
 */
export async function registerWindows(linuxPath: string, distro: string, username: string): Promise<void> {
  return call<void>('registerWindows', { linuxPath, distro, username })
}

/**
 * List every registered WSL workspace key (canonical UNC and Windows drive
 * spellings). The client uses the drive keys to recognize `/mnt` workspaces
 * across page reloads.
 *
 * `listWorkspaceRecords` below is what the plugin itself reads, because it needs
 * each workspace's distribution as well; this key list stays published as the
 * route's own contract (the compatibility suite checks it directly).
 */
export async function listWorkspaces(): Promise<string[]> {
  return call<string[]>('listWorkspaces', {})
}

/** One registered WSL workspace with its stored credentials. */
export interface WslWorkspaceRecord {
  /** The store key: a canonical UNC path or a canonical Windows drive path. */
  path: string
  /** The WSL distribution, present for a `/mnt/<drive>` workspace. */
  distro?: string
  /** The Linux user bash runs as, when one is configured. */
  username?: string
}

/**
 * List every registered WSL workspace with its stored credentials.
 *
 * File-reference translation needs the distribution behind a `/mnt/<drive>`
 * workspace, which the key list alone does not carry.
 * @returns one record per registered workspace.
 */
export async function listWorkspaceRecords(): Promise<WslWorkspaceRecord[]> {
  return call<WslWorkspaceRecord[]>('listWorkspaceRecords', {})
}

/** One declared DSH release and its declared status. */
export interface WslDeclaredRelease {
  id: string
  status: string
}

/** Self-description of the running plugin build (shown by the help panel). */
export interface WslSelfDescription {
  version: string
  releases: WslDeclaredRelease[]
}

/**
 * Read the plugin build version and its declared DSH compatibility matrix,
 * for the dialog help panel.
 * @returns the self-description reported by the host plugin.
 */
export async function describe(): Promise<WslSelfDescription> {
  return call<WslSelfDescription>('describe', {})
}
