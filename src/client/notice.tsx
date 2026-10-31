/**
 * The plugin's own transient notice — the light receipt the exits and the
 * creation flow need.
 *
 * It renders through the shell's **own** `Toast` primitive (the same component
 * the workspace browser uses for "Session archived" and "Copy failed"), mounted
 * on the host's overlay seat (`shell.overlay`, a `list` slot and the documented
 * place for a surface of one's own). An earlier build drew its own card here and
 * guessed at the shell's colour tokens; on screen that came out as text with no
 * plate under it. Nothing is styled here now — the tone, the plate, the hold and
 * the dismissal all belong to the host.
 *
 * Why a notice at all: the workspace browser's own notices (`RowToast`) are a
 * closed set of kinds raised by its internal store, and the `workspace.toast`
 * dispatcher only renders while one of those is on screen, so a third-party
 * bundle cannot push a kind into it.
 * @module dsh-wsl-workspace/client/notice
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

/** One notice on screen. `error` is a refusal the user has to act on. */
export interface WslNotice {
  id: number
  level: 'info' | 'error'
  title: string
  body: string
}

/** How long each level holds, in the shell's own `holdMs` currency. */
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
 * older one's hold.
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
 * The `shell.overlay` entry that shows the notice.
 * @returns the shell's toast, or nothing while no notice is on screen.
 */
export function WslNoticeOverlay(): ReactElement | null {
  const [notice, setNotice] = useState<WslNotice | null>(peekWslNotice())
  useEffect(() => subscribeWslNotice(() => setNotice(peekWslNotice())), [])
  if (notice === null) return null
  const text = notice.body === '' ? notice.title : `${notice.title}：${notice.body}`
  return (
    <Toast
      key={notice.id}
      text={text}
      tone={notice.level === 'error' ? 'danger' : 'success'}
      holdMs={notice.level === 'error' ? ERROR_HOLD_MS : HOLD_MS}
      onDone={() => { dismissWslNotice(notice.id) }}
    />
  )
}
