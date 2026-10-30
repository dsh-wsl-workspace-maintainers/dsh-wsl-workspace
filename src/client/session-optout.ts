/**
 * Per-session opt-out from the WSL world.
 *
 * The mode-variant binding in `./index.ts` scans **blank** sessions and recomposes
 * any whose cwd names a registered WSL workspace onto its `wsl-<mode>` variant. That
 * late-input pass is what makes a workspace registered after the page loaded take
 * effect without a reload — and it is also why a session-level "exit WSL mode"
 * cannot be a single `select(standard)`: the next scan would bind the session right
 * back. (Measured on a real instance 2026-10-30: a session that was still blank
 * flipped back to `wsl-standard` once its workspace was re-registered.)
 *
 * So the exit is recorded here, per session id, and the binder skips it. The
 * workspace-level exit is a different thing — it clears the registration, so
 * sessions created afterwards are never candidates in the first place.
 *
 * `sessionStorage` (not `localStorage`): the decision belongs to the tab that made
 * it, and a new tab on the same workspace should get the workspace's own answer.
 * @module dsh-wsl-workspace/client/session-optout
 */

const KEY = 'dsh-wsl-workspace:session-exits'

/** Where the list lives when there is no session storage (node, a worker, privacy mode). */
let memory: string[] | null = null

function store(): { read: () => string[]; write: (ids: string[]) => void } {
  let backing: Storage | null = null
  try {
    backing = typeof window !== 'undefined' ? window.sessionStorage : null
    backing?.getItem(KEY)
  } catch {
    backing = null
  }
  if (backing === null) {
    return {
      read: () => memory ?? [],
      write: (ids) => { memory = ids },
    }
  }
  const site = backing
  return {
    read: () => {
      try {
        const parsed: unknown = JSON.parse(site.getItem(KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
      } catch {
        return []
      }
    },
    write: (ids) => {
      try {
        site.setItem(KEY, JSON.stringify(ids))
      } catch {
        memory = ids
      }
    },
  }
}

/** Sessions this tab has taken out of the WSL world. */
export function optedOutSessionIds(): string[] {
  return store().read()
}

/** Whether this session was taken out of the WSL world by choice. */
export function hasOptedOut(sessionId: string): boolean {
  return store().read().includes(sessionId)
}

/**
 * Take one session out of the WSL world, so the binder stops recomposing it.
 * @param sessionId - the session the user exited from.
 */
export function optOutSession(sessionId: string): void {
  const ids = store().read()
  if (ids.includes(sessionId)) return
  store().write([...ids, sessionId])
}

/**
 * Put one session back, so the binder may recompose it again.
 * @param sessionId - the session the user re-enabled.
 */
export function optInSession(sessionId: string): void {
  const ids = store().read()
  if (!ids.includes(sessionId)) return
  store().write(ids.filter(id => id !== sessionId))
}

/**
 * Undo one opt-out without promising the caller the session got recomposed.
 * @param sessionId - the session whose recorded exit should be dropped.
 */
export function unmarkOptOut(sessionId: string): void {
  store().write(store().read().filter(id => id !== sessionId))
}
