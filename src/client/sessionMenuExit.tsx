/**
 * The session's own exit from the WSL world, contributed to the host's row menu.
 *
 * Issue #129 asked for a way out; the answer needs two exits, because two
 * different things a user may mean are two different operations. This is the
 * **session** half: take *this conversation* out of the WSL world while its
 * workspace stays registered (the per-session opt-out lives in
 * `./session-optout.ts`; the workspace half lives in `./workspaceMenuExit.ts`).
 *
 * Unlike the workspace menu, this one is a documented seat:
 * `sidebar.workspaces.session.menu.item` is a `list` slot the workspace browser
 * declares, and the shipped rows — pin (100), rename (200), fork (300), archive
 * (400), session-id (450) — are ordinary entries of it. So this plugin
 * contributes a row the same way instead of mirroring DOM, and the seat hands
 * over the row's `sessionId` outright: no title matching, no guessing which row
 * the open menu belongs to.
 * @module dsh-wsl-workspace/client/sessionMenuExit
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SessionWslControls } from './index.ts'
import { raiseWslNotice } from './notice.tsx'

/** The locale strings the row draws, read per render so a language change lands. */
export interface SessionExitLabels {
  /** Row label while the session is still in the WSL world. */
  exit: string
  /** Row label after the user took the session out. */
  rejoin: string
  /** What the change failed, named: the host's own reason is appended verbatim. */
  failed: string
  /** Receipts, one per direction. */
  exitedTitle: string
  exitedBody: string
  rejoinedTitle: string
  rejoinedBody: string
}

/** What this entry needs from the plugin, through the slot's inject face. */
export interface SessionExitInjected {
  /** Live controls, or null until the mode-variant effect has published them. */
  controls: () => SessionWslControls | null
  labels: () => SessionExitLabels
}

/** The owner share the seat supplies for one row occurrence. */
export interface SessionExitOwnerProps {
  /** The session this row acts on — handed over by the host, not inferred. */
  sessionId: string
  /** Row display title; this entry does not draw it, it is part of the seat's contract. */
  displayTitle: string
  /** The owning row's menu open state: `setMenuOpen(false)` dismisses this menu. */
  useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
}

/** Full props of one occurrence: the seat's owner share plus this plugin's inject face. */
export type SessionExitProps = SessionExitOwnerProps & SessionExitInjected

/**
 * One row of the session menu.
 * @param props - owner share plus this plugin's inject face.
 * @returns the menu row, or nothing for a session the WSL world does not reach.
 */
export function SessionWslExitRow({ controls, labels, sessionId, useMenuOpenState }: SessionExitProps): ReactElement | null {
  const [, setMenuOpen] = useMenuOpenState()
  const [refusal, setRefusal] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // The shipped rows bring their own class list through ui-primitives'
  // `MenuItemButton`; this entry is a plain button, so it borrows the geometry
  // of a sibling row at mount rather than shipping a lookalike.
  const [skin, setSkin] = useState<{ button: string; label: string }>({ button: '', label: '' })
  useEffect(() => {
    const self = buttonRef.current
    if (self === null) return
    const menu = self.closest('[role="menu"]')
    if (menu === null) return
    const sibling = [...menu.querySelectorAll('button[role="menuitem"]')].find(button => button !== self)
    if (sibling === undefined) return
    const labelNode = sibling.querySelector('[class*="_itemName"]') ?? sibling.firstElementChild
    const next = { button: sibling.className, label: labelNode?.className ?? '' }
    setSkin(previous => (previous.button === next.button && previous.label === next.label ? previous : next))
  })
  const api = controls()
  if (api === null || !api.isWslSession(sessionId)) return null
  const optedOut = api.optedOut(sessionId)
  const copy = labels()
  const text = refusal !== null
    ? `${copy.failed}：${refusal}`
    : (optedOut ? copy.rejoin : copy.exit)
  const spanClass = skin.label === '' ? undefined : skin.label
  const onClick = (): void => {
    const act = optedOut ? api.rejoin(sessionId) : api.exit(sessionId)
    void act.then((message: string | undefined) => {
      if (message !== undefined) {
        // The host refused (a session that already produced output is locked).
        // Say so on screen instead of leaving the row looking like it worked.
        setRefusal(message)
        raiseWslNotice('error', copy.failed, message)
        return
      }
      setRefusal(null)
      raiseWslNotice('info', optedOut ? copy.rejoinedTitle : copy.exitedTitle, optedOut ? copy.rejoinedBody : copy.exitedBody)
      setMenuOpen(false)
    })
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      className={skin.button === '' ? 'dww-menu-row' : skin.button}
      data-dww-session-exit={optedOut ? 'rejoin' : 'exit'}
      onClick={onClick}
    >
      <span className={spanClass}>{text}</span>
    </button>
  )
}

/** The registration face this entry needs, narrowed to what it calls. */
export interface SessionMenuSlotRegistry {
  /** Install an effect for each lifetime of the seat's declaration. */
  inject(key: string, callback: () => (() => void) | void): () => void
  /** Contribute one entry to a slot; the caller's fiber owns its disposal. */
  register(meta: { name: string; id: string; order?: number; inject?: () => SessionExitInjected }, component: (props: never) => unknown): () => void
}

/**
 * Contribute the exit row to the session menu seat, for as long as that seat is
 * declared.
 *
 * The seat name is typed as a plain string here because
 * `@deepseek-ai/dsh-client-ui-workspace` declares it and the standalone
 * typecheck program of a third-party plugin cannot import that package — the
 * same boundary that makes `uiWorkspace` and `remote.agentPresets` dynamic reads.
 * `slots.inject` waits for the declaration instead of throwing, so a release
 * without the seat contributes nothing rather than failing to mount.
 * @param slots - the client context's slot registry.
 * @param injected - the controls and labels face for this entry.
 * @returns the disposer for the contribution.
 */
export function mountSessionMenuExit(slots: SessionMenuSlotRegistry, injected: () => SessionExitInjected): () => void {
  return slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
    {
      name: 'sidebar.workspaces.session.menu.item',
      // Namespaced, per the seat's own contract: reusing a shipped id would
      // shadow that row.
      id: 'wsl-workspace:exit-mode',
      // After `session-id` (450): the exit belongs at the foot of the menu.
      order: 460,
      inject: injected,
    },
    SessionWslExitRow as unknown as (props: never) => unknown,
  ))
}
