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

/**
 * Per-call budget for the methods that answer immediately or not at all.
 *
 * A call that never answers would leave the dialog's spinner up for the life of
 * the page, so every method is bounded; only the filesystem walks need longer.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The budget for `listDir` and `check`. A directory level with a thousand
 * entries crosses the 9P share entry by entry, and the observed cost of a
 * large one exceeds the interactive default — a timeout there would be a lie
 * about a call that was still making progress.
 */
const FILESYSTEM_TIMEOUT_MS = 60_000

/** The methods that walk a distribution's filesystem, and so get the longer budget. */
const SLOW_METHODS = new Set(['listDir', 'check'])

/** Human text for an unknown rejection, reusing the repository's idiom. */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * The text of a refusal. A host that answers `{ok:false}` without a usable
 * `error` (a proxy inventing an envelope, a future host shape) must still
 * produce a sentence: `new Error(undefined)` renders as the word "undefined",
 * which tells the reader nothing about what went wrong.
 * @param error - whatever the envelope carried in `error`.
 * @param method - the Host method name, used when the envelope had no reason.
 * @returns the refusal text, never empty.
 */
function refusalText(error: unknown, method: string): string {
  if (typeof error === 'string' && error !== '') return error
  if (error === undefined || error === null) return `wsl-workspace ${method} was refused without a reason`
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return `wsl-workspace ${method} was refused: ${errorMessage(error)}`
}

/**
 * Perform one POST call and unwrap the envelope.
 *
 * The status is consulted BEFORE the body is trusted. A route that is not
 * mounted answers 404 with a body some other handler produced, and reading
 * `{ok:true, value:…}` out of that hands the caller a number it will then treat
 * as a distro list. An `ok:true` carrying no `value` is refused for the same
 * reason: a success with nothing in it is a shape this client cannot use, and
 * returning `undefined` as a value would push the discovery into every caller.
 *
 * Every method is bounded, because a call that never answers would leave the
 * dialog's spinner up for the life of the page. `listDir` and `check` walk a
 * distribution's filesystem over 9P and get the longer budget for it.
 * @param method - the Host method name.
 * @param params - the method payload.
 * @returns the unwrapped value, or throws an Error naming the status, the
 *   method, or the budget that ran out.
 */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const budget = SLOW_METHODS.has(method) ? FILESYSTEM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`wsl-workspace ${method} timed out after ${budget}ms`)
    // The transport refused before answering (offline, origin mismatch, 404).
    throw new Error(`wsl-workspace request failed: ${errorMessage(error)}`)
  } finally {
    clearTimeout(timer)
  }
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    // A non-JSON body means a proxy/loader answered instead of the Host route.
    throw new Error(`wsl-workspace answered non-JSON (${response.status})`)
  }
  if (!response.ok) {
    // The status leads: it is the fact a body cannot contradict. An `ok:true`
    // body on a 404 or a 5xx is exactly the hole this closes, so the value is
    // not unwrapped here even when the envelope claims success. The envelope is
    // read through a guard because a non-2xx is precisely the case where
    // something OTHER than this plugin's route answered: `JSON.parse('null')`
    // and `JSON.parse('"…"')` both succeed and neither is an envelope, and
    // reading `.ok` off those would throw a TypeError instead of naming the
    // status the caller needs.
    const answered = typeof envelope === 'object' && envelope !== null ? envelope : undefined
    const detail = answered?.ok === true ? '' : `: ${refusalText(answered?.error, method)}`
    throw new Error(`wsl-workspace ${method} failed with HTTP ${response.status}${detail}`)
  }
  if (!envelope.ok) throw new Error(refusalText(envelope.error, method))
  if (!('value' in envelope)) throw new Error(`wsl-workspace ${method} answered ok without a value`)
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

/** One variant this boot could not publish, with the cause the host recorded. */
export interface WslVariantFailure {
  /** The variant id that was not published (`wsl-code`, …). */
  id: string
  /** The source preset the variant is generated from. */
  source: string
  /** Why it failed, as the host recorded it. */
  reason: string
}

/**
 * How the last boot's variant generation ended.
 *
 * The host owns this because the reason used to reach only its stdout, which
 * DSH Desktop does not persist: the user saw "no healthy wsl preset" and never
 * learned which variant failed or why. `state` starts at `pending` rather than
 * being absent, so "this boot has not answered yet" is distinguishable from
 * "this boot was partial" — they need different sentences.
 */
export interface WslVariantOutcome {
  state: 'pending' | 'ok' | 'partial' | 'failed'
  /** How many variants were published. */
  produced: number
  /** How many sources were read. */
  sources: number
  /** The variants that were not published, with their causes. */
  failed: WslVariantFailure[]
  /** How many failures the host's own cap dropped from `failed`. */
  truncated: number
  /**
   * Incremented once per host effect apply and once per dispose, so a reader
   * can tell a stale outcome from this boot's without trusting `at` alone. A
   * value SMALLER than one already seen is a read that lost its race.
   */
  generation: number
  /** When the host recorded it, in epoch milliseconds. */
  at: number
  /** A boot-level cause, for a failure with no per-variant attribution. */
  error?: string
}

/**
 * Read how this boot's variant generation ended.
 *
 * A host without this case answers `{ok:false, error:'unknown method
 * "variantStatus"'}` — the rejection IS the signal that the roster is the only
 * source available, so callers must treat it as a fallback rather than a fault.
 * @returns the host's outcome record.
 */
export async function variantStatus(): Promise<WslVariantOutcome> {
  return call<WslVariantOutcome>('variantStatus', {})
}
