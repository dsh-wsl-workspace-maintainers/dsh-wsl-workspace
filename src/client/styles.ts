/**
 * Third-party stylesheet injection for the WSL workspace UI (the plugin
 * builds no CSS bundle, so styles are injected as one idempotent `<style>`).
 * Colors derive exclusively from the `--dsw-*` design tokens.
 */

const STYLE_TAG_DATA_ATTRIBUTE = 'data-plugin="dsh-wsl-workspace"'

const STYLES = `
/* Sidebar-foot icon action beside Settings (28px round in the wide sidebar,
   36px round in the rail), matching the shell's icon-button language. */
.dww-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition:
    background-color 120ms var(--dsw-ease-in-out, ease-in-out),
    color 120ms var(--dsw-ease-in-out, ease-in-out);
}
.dww-action:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dww-action:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-pressed, var(--dsw-alias-interactive-bg-hover));
}
.dww-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dww-action:disabled { cursor: default; opacity: 0.6; }
.dww-action--rail {
  width: 36px;
  height: 36px;
  color: var(--dsw-alias-label-primary);
}
/* The wide counterpart of the rail button: the same control in the dialog's header, where it is
   laid out by the container rather than by a fixed box. It existed only as the wide/rail branch of
   the className in AddWslWorkspace.tsx with no rule behind it, so the wide form silently inherited
   the base .dww-action padding at the dialog's density — which is where the "the dialog's button
   looks smaller than the sidebar's" report came from. */
.dww-action--wide {
  width: auto;
  min-width: 96px;
  height: 32px;
  padding: 0 12px;
}
.dww-action svg { flex: none; }

/* The W letter mark of the sidebar action (sized for wide/rail buttons). */
.dww-letter {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  user-select: none;
}
.dww-action--rail .dww-letter { font-size: 17px; }

/* Full-viewport overlay + centered card (mirrors the platform Mask/Dialog). */
.dww-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dww-overlay-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.dww-card {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  max-height: min(640px, 90vh);
  padding: 0 0 20px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  font-family: var(--dsw-font-family);
}
.dww-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 18px 20px 12px;
}
.dww-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dww-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.dww-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dww-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 0 20px;
  overflow: auto;
}
.dww-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dww-field-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dww-select {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dww-input-row { display: flex; gap: 8px; align-items: center; }
.dww-input {
  box-sizing: border-box;
  flex: 1;
  height: 36px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dww-input:focus, .dww-select:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dww-check-btn {
  flex: none;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 12px;
}
.dww-check-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-check-btn:disabled { cursor: default; }

/* Directory browse list. */
.dww-dirlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  min-height: 120px;
  max-height: 200px;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.dww-feedback {
  /* The browse block: the path above the listing, as one visual group. It carried a class in
     AddWslWorkspace.tsx and no rule here, so the breadcrumb sat flush against the list box with
     nothing tying them together — the two read as unrelated rows rather than as one path-and-tree
     control. The listing keeps its own border (.dww-dirlist below); this only groups them. */
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dww-breadcrumb {
  padding: 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dww-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.dww-dir-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-dir-row:disabled { cursor: default; color: var(--dsw-alias-label-tertiary); }
.dww-dir-row--up { color: var(--dsw-alias-label-secondary); }
.dww-dir-row svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.dww-dir-empty {
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Error strip. */
.dww-error {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dww-retry {
  margin-left: 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}

/* Dialog footer actions. */
.dww-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 0;
}
.dww-btn {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 14px;
}
.dww-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dww-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dww-btn:disabled { cursor: default; opacity: 0.6; }
/* Help panel behind the dialog's "?" button. */
.dww-help-btn {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.dww-help-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dww-help-btn[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dww-help {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 4px;
}
.dww-help-section { display: flex; flex-direction: column; gap: 6px; }
.dww-help-greeting {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dww-help-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dww-help-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dww-help-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dww-help-chip {
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dww-help-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dww-help-list--known { color: var(--dsw-alias-label-primary); }
.dww-help-footer {
  display: flex;
  gap: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dww-help-link { font-size: 12px; color: var(--dsw-alias-label-tertiary); text-decoration: underline; }
.dww-help-link:hover { color: var(--dsw-alias-label-primary); }
`

/**
 * Idempotently inject the plugin stylesheet. No-op when a tag with the
 * plugin's data attribute already exists.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_TAG_DATA_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'dsh-wsl-workspace')
  style.textContent = STYLES
  document.head.appendChild(style)
}
