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
/**
 * How long one call may take before it is abandoned.
 *
 * Without a ceiling a request that never settles is indistinguishable from a slow one, and the
 * dialog's Retry button is the only way out — a user who opened the Add-workspace dialog on a host
 * that is not answering has to click it to learn nothing. 30s is far above any measured local call
 * (the slowest, a `describe` that boots a profile, is well under 2 s) and far below the point where a
 * spinner becomes indistinguishable from a hang.
 */
const CALL_TIMEOUT_MS = 30_000

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
 * Three failure shapes are answered in words rather than in shape. **`response.ok` is checked before
 * the body is trusted**: a 500 from a proxy answers HTML, and parsing it would report "non-JSON" —
 * naming the symptom and hiding the status that says what happened. The status leads even when the
 * body IS readable, because an `ok:true` on a 404 is exactly the hole this closes; the envelope's own
 * `error` is appended as detail when there is one, and never allowed to replace the status.
 * **The fetch carries a timeout**, so a request that never settles reports that instead of leaving the
 * caller waiting on a promise that cannot resolve (issue #44 §6, `T8`). **An `ok:true` with no
 * `value` is refused too**: returning `undefined` as a value would push the discovery into every
 * caller, none of which can tell it apart from an empty answer.
 * @param method - the Host method name.
 * @param params - the method payload.
 * @returns the unwrapped value, or throws an Error on transport, timeout, non-2xx, or `ok:false`.
 */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  // `AbortSignal.timeout` is the one whose timer the platform owns, so there is no timer to leak when
  // the call finishes first — a `setTimeout` + `clearTimeout` pair is where a `return` between them
  // leaves a handle up until the deadline.
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS)
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal,
    })
  } catch (error) {
    // The transport refused before answering (offline, origin mismatch, 404), or the timeout above
    // fired. The two are told apart by name, because "could not reach the host" and "the host did not
    // answer in 30 s" call for different things from the reader.
    if (signal.aborted) {
      throw new Error(`wsl-workspace: ${method} did not answer within ${CALL_TIMEOUT_MS / 1000}s (${ENDPOINT})`)
    }
    throw new Error(`wsl-workspace request failed: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    // Named before the body is trusted, and never lost to it: a proxy answering an HTML error page
    // fails to parse, and that is precisely the case where the status is the only fact available. So
    // the body is read inside a guard, and the status leads the sentence either way — an envelope is
    // consulted only for its detail here, never for its verdict, because an `ok:true` on a 404 is
    // exactly the hole this closes. The parsed value is itself treated as optional: a non-2xx is
    // the one case where something OTHER than this plugin's route answered, and `JSON.parse('null')`
    // and `JSON.parse('"…"')` both succeed while carrying no `ok` to read.
    let detail = ''
    try {
      const body: unknown = await response.json()
      const answered = typeof body === 'object' && body !== null
        ? body as { ok?: unknown; error?: unknown }
        : undefined
      if (answered?.ok === false) detail = `: ${refusalText(answered.error, method)}`
    } catch {
      // Not JSON at all. The status below is the whole answer, and quoting an HTML page at a user
      // would be worse than the number alone.
    }
    throw new Error(`wsl-workspace: ${method} answered HTTP ${response.status}${detail}`)
  }
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    // A non-JSON body on a 2xx means a proxy/loader answered instead of the Host route.
    throw new Error(`wsl-workspace answered non-JSON on 2xx (${response.status}) — ${ENDPOINT}`)
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
