/**
 * Join the host's own workspace UI instead of standing beside it.
 *
 * The shell exposes exactly one seat to a third-party client plugin
 * (`sidebar.footer.action`), and neither the browsing region nor the workspace
 * picker offers one: the "add workspace" control in the Workspaces section
 * header and the "Add workspace…" row in that control's menu are host-private
 * markup. The two entries mounted here are runtime mirrors of those two seats —
 * the shipped control's own `className` is copied (so size, radius, hover and
 * focus are the shipped behaviours rather than lookalikes), the header button is
 * drawn through the same Tooltip primitive the shipped control uses (so its
 * hover bubble is the shipped bubble rather than a native `title` box), and the
 * menu row is a clone of the shipped row (so its icon and item classes come with
 * it).
 *
 * Nothing in the host is patched: no module is wrapped and no service is
 * replaced. Every mount is a plain DOM node whose lifecycle this plugin owns,
 * and every mount falls back to the footer action when its seat is absent (rail
 * sidebar, a release that renames the region, a browser without the menu).
 *
 * Both seats mount late — the header with the Workspaces region, the menu on
 * first open — and both are re-rendered by React underneath us, so each mount is
 * kept in place by an observer plus a slow interval rather than assumed to
 * survive a render.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HostEntryButton } from './hostEntryButton.tsx'

/**
 * The shipped label of the row this menu entry follows, in every locale the
 * shell ships. Matching on the row's text is the only handle available: the
 * menu carries no stable id or data attribute for that item.
 */
const HOST_ADD_WORKSPACE_LABELS = ['添加工作区…', 'Add workspace…']

/** How long the trimmed mode menu is held invisible while the host re-measures it. */
const PRESET_SETTLE_MS = 80

/** The shape both mounts need: where to open the dialog, and what to call it. */
export interface HostEntryOptions {
  /** The row/button label, read lazily so a locale change lands on the next pass. */
  label: () => string
  /** Open the dialog. Called from a host-owned click listener. */
  open: () => void
}

/**
 * Mount the W entry in the Workspaces section header, immediately right of the
 * shipped "Add workspace" control.
 *
 * Discovery walks up from the footer slot (the one element this plugin owns)
 * looking for the section header it is mounted beside, then takes that header's
 * action strip and its last button — the add control. The entry is rendered into
 * a slot appended to the strip, so it inherits the strip's gap and the add
 * control's own class list, and it opens the same Tooltip bubble the add
 * control does.
 *
 * @param home - the footer slot's element, or null when it is not mounted.
 * @param options - the label getter and the dialog opener.
 * @param onSeat - told whenever the seat appears or disappears, so the caller
 *   can retire the footer copy while the header carries the entry.
 * @returns a disposer that removes the button and every observer.
 */
export function mountHeaderEntry(home: HTMLElement | null, options: HostEntryOptions, onSeat: (present: boolean) => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || home === null) return () => {}
  // jsdom and older engines do not all expose it; without an observer the
  // seat simply stays where it was, which is the footer fallback.
  const Observer = (window as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (Observer === undefined) return () => {}

  const slot = document.createElement('span')
  slot.className = 'dww-header-slot'

  // The entry is React-owned from here: the shell's Tooltip clones its child to
  // attach the hover/focus listeners and a ref, so the button cannot be built by
  // hand and then wrapped by the bubble.
  let root: Root | null = null
  let drawn: { className: string; label: string } | null = null
  /** The dialog opener, stable across renders, so a redraw with the same facts is a no-op commit. */
  const open = (): void => options.open()
  /**
   * Draw (or redraw) the entry with the facts of this pass.
   * @param className - the shipped add control's class list.
   * @param label - the localized entry label, which doubles as the tooltip text.
   */
  const draw = (className: string, label: string): void => {
    if (drawn !== null && drawn.className === className && drawn.label === label) return
    drawn = { className, label }
    if (root === null) root = createRoot(slot)
    root.render(createElement(HostEntryButton, { className, label, open }))
  }

  /**
   * The header's action strip and its last button (the add control), found from
   * the footer slot upwards. A region that is not mounted (or a release whose
   * markup moved) answers null, which the caller reads as "no header seat".
   */
  const find = (): { actions: Element; add: HTMLButtonElement } | null => {
    let node: Element | null = home.parentElement
    while (node !== null && node !== document.body) {
      const header = node.querySelector('[class*="_sectionHeader"]')
      if (header !== null) {
        const actions = header.querySelector('[class*="_headerActions"]')
        if (actions === null) return null
        const buttons = [...actions.querySelectorAll('button')]
          .filter(button => !button.classList.contains('dww-header-entry'))
        const add = buttons.at(-1)
        return add === undefined ? null : { actions, add }
      }
      node = node.parentElement
    }
    return null
  }

  let observer: MutationObserver | null = null
  let observed: Element | null = null
  let present = false
  const seat = (value: boolean): void => {
    if (present === value) return
    present = value
    onSeat(value)
  }
  const ensure = (): void => {
    const found = find()
    if (found === null) {
      slot.remove()
      seat(false)
      if (observer !== null) {
        observer.disconnect()
        observer = null
        observed = null
      }
      return
    }
    if (slot.parentElement !== found.actions) found.actions.appendChild(slot)
    draw(found.add.className, options.label())
    if (observed !== found.actions) {
      // The strip is re-rendered by React whenever the sidebar's search state or
      // the workspace list changes, and that drops unknown children with it.
      if (observer !== null) observer.disconnect()
      observed = found.actions
      observer = new Observer(() => ensure())
      observer.observe(observed, { childList: true })
    }
    seat(true)
  }
  ensure()
  // The seat can also be absent at mount (the region renders after the footer
  // slot) and can come back later, which no observer on a missing strip sees.
  // One body observer covers both, and a microtask coalesces a React commit's
  // many mutations into one pass.
  let queued = false
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      ensure()
    })
  }
  const bodyObserver = new Observer(schedule)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  return () => {
    bodyObserver.disconnect()
    if (observer !== null) observer.disconnect()
    // The header is host markup; the root this plugin opened inside it must go too.
    if (root !== null) root.unmount()
    root = null
    slot.remove()
  }
}

/**
 * Add the WSL entry to the workspace picker menu, directly under the shipped
 * "Add workspace…" row.
 *
 * The clone keeps that row's own icon and classes — only the label changes — so
 * the entry is indistinguishable from the shipped row. Clicking it raises the
 * same dialog as the header button; the menu's own click handler closes the
 * menu around it.
 *
 * The same pass trims the mode picker: a WSL session shows only this plugin's
 * `wsl-*` variants, every other session shows only the shipped modes. The host
 * builds the menu with the full list and measures it, so the untrimmed frame is
 * held invisible until the trimmed list has been placed — otherwise the menu
 * flashes above its anchor and jumps below it once the shorter list is measured.
 *
 * @param options - the label getter and the dialog opener.
 * @returns a disposer that stops the observation and removes the injected row.
 */
export function mountWorkspaceMenuEntry(options: HostEntryOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  // jsdom and older engines do not all expose it; without an observer the
  // seat simply stays where it was, which is the footer fallback.
  const Observer = (window as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (Observer === undefined) return () => {}

  const releasePresets = (menu: Element): void => {
    if (menu.hasAttribute('data-dww-presets-ready') || menu.hasAttribute('data-dww-presets-pending')) return
    menu.setAttribute('data-dww-presets-pending', '')
    document.body.setAttribute('data-dww-presets-pending', '')
    window.setTimeout(() => {
      document.body.removeAttribute('data-dww-presets-pending')
      if (!menu.isConnected) return
      menu.setAttribute('data-dww-presets-ready', '')
    }, PRESET_SETTLE_MS)
  }

  const filterPresets = (menu: Element, buttons: NodeListOf<HTMLButtonElement>): void => {
    // A generic menu can carry an itemName without using the button-based menu
    // shape this filter understands. The stylesheet must not leave it hidden.
    if (buttons.length === 0) {
      if (menu.querySelector('[class*="_itemName"]') !== null) releasePresets(menu)
      return
    }
    const rows = [...buttons].map(button => ({
      button,
      name: (button.querySelector('[class*="_itemName"]')?.textContent ?? '').trim(),
      checked: button.querySelector('[class*="_check"]') !== null,
    }))
    // A menu whose rows carry no recognizable name is not the preset picker;
    // leaving it alone is the only safe answer.
    if (!rows.some(row => row.name !== '')) {
      releasePresets(menu)
      return
    }
    const selected = rows.find(row => row.checked)
    if (selected === undefined) {
      releasePresets(menu)
      return
    }
    const wslOnly = /^WSL\b/i.test(selected.name)
    for (const row of rows) {
      const wrap = row.button.parentElement
      if (wrap === null) continue
      const matches = /^WSL\b/i.test(row.name) === wslOnly
      wrap.style.display = matches ? '' : 'none'
      // Hidden rows must also leave the keyboard order, or the arrow keys walk
      // into rows nothing can see.
      row.button.disabled = !matches
    }
    releasePresets(menu)
  }

  const sync = (): void => {
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const buttons = menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
      let addWrap: Element | null = null
      for (const button of buttons) {
        // The row's text may carry a shortcut hint beside its label, so the
        // label span is read when the row has one.
        const text = (button.querySelector('[class*="_itemLabel"]')?.textContent ?? button.textContent ?? '').trim()
        if (HOST_ADD_WORKSPACE_LABELS.includes(text)) {
          addWrap = button.parentElement
          break
        }
      }
      if (addWrap !== null) {
        const label = options.label()
        let entry = menu.querySelector('[data-dww-menu-entry]')
        if (entry === null) {
          entry = addWrap.cloneNode(true) as Element
          entry.setAttribute('data-dww-menu-entry', '')
          const created = entry.querySelector('button[role="menuitem"]')
          if (created !== null) {
            created.removeAttribute('aria-keyshortcuts')
            created.addEventListener('click', () => options.open())
          }
        }
        const clone = entry.querySelector('button[role="menuitem"]')
        const labelSpan = clone?.querySelector('[class*="_itemLabel"]') ?? null
        if (labelSpan !== null && labelSpan.textContent !== label) labelSpan.textContent = label
        if (entry.parentElement === null || entry.previousElementSibling !== addWrap) addWrap.after(entry)
      }
      filterPresets(menu, buttons)
    }
  }

  /**
   * The hero workspace picker's menu is anchored by rect, so its trigger chip
   * sits outside the menu's root. The host closes the menu on an outside
   * pointerdown and the chip's click then toggles it open again, so a second
   * click could never close it. Keep that one press from reaching the outside
   * handler; the chip's click still closes the menu.
   */
  const keepWorkspaceToggle = (event: Event): void => {
    const target = event.target as Element | null
    if (target === null || typeof target.closest !== 'function') return
    if (target.closest('button[aria-haspopup="menu"][aria-expanded="true"][class*="_workspace"]') === null) return
    event.stopPropagation()
  }

  for (const stale of document.querySelectorAll('[data-dww-menu-entry]')) stale.remove()
  document.addEventListener('pointerdown', keepWorkspaceToggle, true)
  const observer = new Observer(sync)
  observer.observe(document.body, { childList: true, subtree: true })
  sync()
  return () => {
    document.removeEventListener('pointerdown', keepWorkspaceToggle, true)
    observer.disconnect()
    for (const stale of document.querySelectorAll('[data-dww-menu-entry]')) stale.remove()
  }
}
