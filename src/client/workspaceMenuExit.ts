/**
 * The workspace's own exit from the WSL world, mirrored into the host's workspace menu.
 *
 * This is the **workspace** half of issue #129's answer: clear the registration
 * itself, so sessions created afterwards are never WSL candidates. The session
 * half has a documented seat (`./sessionMenuExit.tsx`); this one does not. The
 * workspace row's menu is built by the host from a private `items` array
 * (`rename`, `delete.workspace`) handed to ui-primitives' `Menu`, and the
 * browsing region exposes no entry point for it — so the row is mirrored the way
 * the header control and the picker row already are (see `./hostEntry.ts`).
 *
 * Which row the open menu belongs to is *not* guessed from text: the host marks
 * the row whose menu is open with its `menuOpen` class and gives every workspace
 * row a `data-row-key="workspace:<workspaceId>"`. That pair is the target, and
 * the entry is drawn only when the id resolves to a path the plugin's own store
 * carries. No title matching, so a renamed workspace and a duplicated name both
 * land on the right registration.
 * @module dsh-wsl-workspace/client/workspaceMenuExit
 */

import { raiseWslNotice } from './notice.tsx'

/** The shipped row this entry follows, in every locale the shell ships. */
const WORKSPACE_ANCHOR_LABELS = ['删除工作区', 'Delete workspace']

/** The attribute marking the mirrored row; its value is the registration to clear. */
const EXIT_ATTRIBUTE = 'data-dww-ws-exit'

/**
 * Which mount drew the row. A page can hold more than one plugin instance (a
 * hot reload, two windows over one DOM in a test), and two instances that
 * disagree about whether a workspace is registered would otherwise each undo the
 * other's row on every mutation — a loop no user needs to see.
 */
const EXIT_OWNER_ATTRIBUTE = 'data-dww-ws-owner'

let mountSequence = 0

/** What the mirror needs from the plugin. */
export interface WorkspaceExitOptions {
  /** The row label, read lazily so a locale change lands on the next pass. */
  label: () => string
  /** Receipt and refusal copy. */
  doneTitle: () => string
  doneBody: (path: string) => string
  failedTitle: () => string
  /** The registered WSL path behind a host workspace id, or undefined when that workspace is not one. */
  registeredPath: (workspaceId: string) => string | undefined
  /** Clear that registration; resolves with the host's own refusal, or undefined on success. */
  onExit: (path: string) => Promise<string | undefined>
}

/**
 * Read a menu row's visible label, preferring the shell's own name span because
 * a row may carry a shortcut hint beside it.
 * @param button - the shipped row.
 * @returns the trimmed label text.
 */
function rowLabel(button: HTMLButtonElement): string {
  return (button.querySelector('[class*="_itemName"]')?.textContent
    ?? button.querySelector('[class*="_itemLabel"]')?.textContent
    ?? button.textContent ?? '').trim()
}

/**
 * The workspace whose row menu is open, from that row's own `data-row-key`.
 * @param root - the document to search.
 * @returns the workspace id, or null when the shell's markup is not this shape.
 */
function openWorkspaceId(root: ParentNode): string | null {
  const key = root.querySelector('[class*="projectRow"][class*="menuOpen"]')?.getAttribute('data-row-key')
  if (key === undefined || key === null || !key.startsWith('workspace:')) return null
  const id = key.slice('workspace:'.length)
  return id === '' ? null : id
}

/**
 * Clone the shipped delete row into a mirror of our own, label and icon replaced.
 * The clone keeps the shipped wrapper and class list, so the entry inherits the
 * row geometry, hover and focus the host's own rows have.
 * @param anchor - the shipped row this entry follows.
 * @param text - the label to draw.
 * @param owner - the mount that is drawing it.
 * @returns the cloned row element and its button, already inserted after the anchor.
 */
function cloneRow(anchor: HTMLButtonElement, text: string, owner: string): { row: HTMLElement; button: HTMLButtonElement } | null {
  const parent = anchor.parentElement
  const source = parent === null || parent.getAttribute('role') === 'menu' ? anchor : parent
  const row = source.cloneNode(true) as HTMLElement
  // `tagName`, not `instanceof`: this bundle runs in the host's realm, where the
  // platform constructors are not the ones the comparing code can see.
  const button = row.tagName === 'BUTTON'
    ? row as unknown as HTMLButtonElement
    : row.querySelector<HTMLButtonElement>('button[role="menuitem"]')
  if (button === null) return null
  row.setAttribute(EXIT_ATTRIBUTE, '')
  row.setAttribute(EXIT_OWNER_ATTRIBUTE, owner)
  button.setAttribute('role', 'menuitem')
  button.removeAttribute('aria-keyshortcuts')
  for (const icon of button.querySelectorAll('svg')) icon.remove()
  const label = button.querySelector('[class*="_itemName"]') ?? button.querySelector('[class*="_itemLabel"]')
  if (label === null) button.textContent = text
  else label.textContent = text
  source.after(row)
  return { row, button }
}

/**
 * Keep the workspace menu's exit row in place. An observer plus a slow interval,
 * because the host re-renders its menu underneath us.
 * @param options - label, target probe and the un-registration action.
 * @returns a disposer that stops the observation and drops the mirrored rows.
 */
export function mountWorkspaceMenuExit(options: WorkspaceExitOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const Observer = (window as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (Observer === undefined) return () => {}

  const owner = String(++mountSequence)
  const sync = (): void => {
    for (const menu of [...document.querySelectorAll('[role="menu"]')]) {
      const drawn = menu.querySelector<HTMLElement>(`[${EXIT_ATTRIBUTE}]`)
      if (drawn !== null && drawn.getAttribute(EXIT_OWNER_ATTRIBUTE) !== owner) continue
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      const anchor = buttons.find(button => WORKSPACE_ANCHOR_LABELS.includes(rowLabel(button)))
      if (anchor === undefined) {
        // Not the workspace menu: leave it exactly as the host drew it.
        drawn?.remove()
        continue
      }
      const workspaceId = openWorkspaceId(document)
      const path = workspaceId === null ? undefined : options.registeredPath(workspaceId)
      if (path === undefined) {
        // Not a WSL workspace — or a release whose row markup this plugin no
        // longer recognises. Either way there is no honest exit to draw.
        drawn?.remove()
        continue
      }
      let row = drawn
      let button = drawn === null
        ? null
        : drawn.tagName === 'BUTTON' ? drawn as unknown as HTMLButtonElement : drawn.querySelector<HTMLButtonElement>('button[role="menuitem"]')
      if (row === null || button === null) {
        const cloned = cloneRow(anchor, options.label(), owner)
        if (cloned === null) continue
        row = cloned.row
        button = cloned.button
        cloned.button.addEventListener('click', () => {
          const target = cloned.row.getAttribute(EXIT_ATTRIBUTE)
          if (target === null || target === '') return
          void options.onExit(target).then((message: string | undefined) => {
            if (message !== undefined) {
              raiseWslNotice('error', options.failedTitle(), message)
              return
            }
            raiseWslNotice('info', options.doneTitle(), options.doneBody(target))
          })
        })
      }
      // Re-target on every pass: the portal element outlives the row that opened
      // it, and a stale registration here would clear the wrong workspace.
      row.setAttribute(EXIT_ATTRIBUTE, path)
    }
  }

  let observer: MutationObserver | null = null
  try {
    observer = new Observer(sync)
    observer.observe(document.body, { childList: true, subtree: true })
  } catch {
    observer = null
  }
  const timer = window.setInterval(sync, 1000)
  sync()
  return () => {
    observer?.disconnect()
    window.clearInterval(timer)
    for (const stale of document.querySelectorAll(`[${EXIT_OWNER_ATTRIBUTE}="${owner}"]`)) stale.remove()
  }
}
