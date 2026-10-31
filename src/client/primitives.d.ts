/**
 * Type surface for the shell's shared primitives module.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is not a package on disk: the Web
 * shell seeds it into the frozen platform module table (`PLATFORM_MODULES`) and
 * every client bundle resolves the specifier there. Only the members this
 * plugin renders are declared.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'

  /** Props of the shell's Tooltip: one child element, a label, optional keycaps. */
  export interface TooltipProps {
    /** Bubble text, or a function read on every show. */
    label: ReactNode | (() => ReactNode)
    /** Keycap sequence drawn on the bubble's trailing edge. */
    shortcutKeys?: readonly string[]
    /** Which side of the child the bubble prefers; it flips at the viewport edge. */
    side?: 'top' | 'right' | 'bottom' | 'left'
    /** Cross-axis alignment with the child. */
    align?: 'start' | 'center' | 'end'
    /** Hover delay in milliseconds; keyboard focus uses `focusDelayMs`. */
    delayMs?: number
    focusDelayMs?: number
    gap?: number
    disabled?: boolean
    portal?: boolean
    maxWidth?: number
    openOnClick?: boolean
    /** The single element the bubble describes; cloned to attach the listeners. */
    children: ReactElement
  }

  /** The themed hover/focus bubble the shell's own controls use. */
  export function Tooltip(props: TooltipProps): ReactElement

  /** Props of the shell's transient notice: one line, a tone, and its own dismissal. */
  export interface ToastProps {
    /** The line to show; the host passes localized text here. */
    text: ReactNode
    /** Called when the bubble is dismissed or its hold expires — the host's own clock. */
    onDone: () => void
    /** The shell's tone vocabulary, as used by its own notices. */
    tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
    /** Leading icon; the host supplies one for a warning. */
    icon?: ReactElement
    /** How long the bubble holds before it reports done. */
    holdMs?: number
    /** Trailing actions; the host puts an undo here for its archive notice. */
    actions?: ReactNode
  }

  /** The transient notice the shell uses for its own receipts (archive, copy, failure). */
  export function Toast(props: ToastProps): ReactElement

  /**
   * The upper-right arrow the shell draws for "leave this / send elsewhere"
   * affordances. Declared with the same empty-props shape the host's own call
   * sites use (`jsx(IconRightUpOutlineRegular, {})`), so a menu row contributed
   * by this plugin carries the shipped glyph instead of a hand-drawn lookalike.
   */
  export function IconRightUpOutlineRegular(props: Record<never, never>): ReactElement
}
