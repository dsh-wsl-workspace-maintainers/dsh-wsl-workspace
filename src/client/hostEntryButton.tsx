/**
 * The header entry's button, drawn through the shell's own Tooltip primitive.
 *
 * The host wraps its "Add workspace" control in the shared
 * `@deepseek-ai/dsh-client-ui-primitives` Tooltip (bottom side, 500 ms), which
 * paints the themed bubble and the shortcut keycaps. A native `title` cannot
 * match that: the browser draws it itself, with its own delay and box. So the
 * entry renders the same primitive around the copied host control and only the
 * label differs.
 */
import type { ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Props of the header entry: the shipped class list, its label, and the opener. */
export interface HostEntryButtonProps {
  /** The add control's own class list; the entry marker is appended here. */
  className: string
  /** The localized entry label; the bubble shows exactly this. */
  label: string
  /** Open the "Add WSL workspace" dialog. */
  open: () => void
}

/**
 * One icon button in the Workspaces header, carrying the shell's tooltip.
 * @param props - class list, label and opener.
 * @returns the wrapped button.
 */
export function HostEntryButton({ className, label, open }: HostEntryButtonProps): ReactElement {
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        type="button"
        className={`${className} dww-header-entry`}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={open}
      >
        <span className="dww-letter" aria-hidden="true">W</span>
      </button>
    </Tooltip>
  )
}
