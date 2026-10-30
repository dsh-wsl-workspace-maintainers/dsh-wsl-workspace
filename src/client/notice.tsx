/**
 * The plugin's own transient notice — the light receipt the two exits and the
 * creation flow need, mounted through the host's own overlay seat.
 *
 * `shell.overlay` is a `list` slot (`dsh-client-runtime`'s slot registry says so
 * in as many words: for a surface of your own that floats over the whole app,
 * register into `shell.overlay`), so this entry sits beside the host's dialogs
 * instead of opening a second portal this plugin has to keep above them.
 *
 * Why this exists at all: the workspace browser's own notices (`RowToast`) are a
 * CLOSED set of kinds raised by the browser's internal store, and the
 * `workspace.toast` dispatcher only renders while one of those is on screen. A
 * third-party bundle cannot push a kind into it, which is why the exits'
 * receipts and refusals are carried here — the failure half matters as much as
 * the success half, because a refusal the user cannot see is issue #129's
 * silence wearing a new face.
 * @module dsh-wsl-workspace/client/notice
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

/** One notice on screen. `error` is a refusal the user has to act on. */
export interface WslNotice {
  id: number
  level: 'info' | 'error'
  title: string
  body: string
}

/** How long a notice holds before it takes itself down (a refusal gets more). */
const HOLD_MS = 5_000
const ERROR_HOLD_MS = 9_000

let current: WslNotice | null = null
let sequence = 0
const listeners = new Set<() => void>()

/** Tell every subscriber the notice changed. */
function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Put a notice on screen, replacing whatever was there.
 * @param level - `error` for a refusal, `info` for a receipt.
 * @param title - short line naming what happened.
 * @param body - the detail, including the host's own words when it refused.
 */
export function raiseWslNotice(level: 'info' | 'error', title: string, body: string): void {
  current = { id: ++sequence, level, title, body }
  emit()
}

/**
 * Take a notice down, but only the one named — a newer notice must survive the
 * older one's timer.
 * @param id - the notice whose hold expired.
 */
export function dismissWslNotice(id: number): void {
  if (current === null || current.id !== id) return
  current = null
  emit()
}

/** The notice on screen, or none. */
export function peekWslNotice(): WslNotice | null {
  return current
}

/**
 * Observe notice changes.
 * @param listener - called whenever the notice appears, changes or leaves.
 * @returns the unsubscribe.
 */
export function subscribeWslNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The `shell.overlay` entry that renders the notice.
 * @returns the notice card, or nothing while no notice is on screen.
 */
export function WslNoticeOverlay(): ReactElement | null {
  const [notice, setNotice] = useState<WslNotice | null>(peekWslNotice())
  useEffect(() => subscribeWslNotice(() => setNotice(peekWslNotice())), [])
  useEffect(() => {
    if (notice === null) return
    const hold = notice.level === 'error' ? ERROR_HOLD_MS : HOLD_MS
    const timer = window.setTimeout(() => { dismissWslNotice(notice.id) }, hold)
    return () => { window.clearTimeout(timer) }
  }, [notice])
  if (notice === null) return null
  return (
    <div className="dww-notice" data-level={notice.level} role="status">
      <div className="dww-notice-title">{notice.title}</div>
      <div className="dww-notice-body">{notice.body}</div>
      <button
        type="button"
        className="dww-notice-close"
        onClick={() => { dismissWslNotice(notice.id) }}
      >
        ×
      </button>
    </div>
  )
}
