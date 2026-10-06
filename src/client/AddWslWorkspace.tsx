/**
 * Sidebar footer action that opens the "Add WSL workspace" dialog. In the
 * wide sidebar it renders a labeled row; in the 56px rail it collapses to a
 * 36px icon button (both honor the shell's `{ wide }` owner share).
 *
 * Registration omits the typed `locale:` seat (the `wslWorkspace` namespace is
 * not merged into `LocaleNamespaceMap`), so the injected face carries the
 * bound translate function instead.
 */

import type * as React from 'react'
import { useEffect, useRef, useState, type UIEventHandler } from 'react'
import { isAbsoluteLinuxPath, isValidWslUsername, normalizeLinuxPath } from '../shared/paths.ts'
import type { WslDirListing, WslPathCheck, WslSelfDescription } from './api.ts'
import { WslHelp } from './help.tsx'

/** Result-level shape of a browse/check/list call we surface uniformly. */
interface ApiCall<T> {
  value: T
}

/** The inject face: plain data + callbacks the dialog drives. */
export interface AddWslWorkspaceInjected {
  /**
   * Confirm the deployment exposes a healthy `wsl` preset.
   * @returns undefined when healthy, else a Chinese/English message to show.
   */
  checkPreset(): Promise<string | undefined>
  /**
   * Read this build's version and its declared DSH compatibility matrix,
   * for the help panel. A host that cannot answer resolves to a fallback
   * description rather than failing the dialog.
   */
  describe(): Promise<WslSelfDescription>
  /** List the WSL distros installed on the host. */
  listDistros(): Promise<string[]>
  /** List one Linux directory level inside a distro. */
  listDir(distro: string, path: string): Promise<WslDirListing>
  /** Check a Linux path's existence/directory facts. */
  check(distro: string, path: string): Promise<WslPathCheck>
  /**
   * Register a WSL workspace and start a session in it. `/mnt/<drive>`
   * paths register under their Windows drive spelling (9P cannot serve
   * drvfs); ext4 paths register as `\\wsl.localhost\<distro>\...` UNC.
   * @param linuxPath - the absolute Linux workspace path.
   * @param username - optional Linux user for the session (empty = distro default).
   * @param distro - the WSL distribution the path belongs to.
   * @returns undefined on success, else a message to show.
   */
  createWorkspace(linuxPath: string, username: string, distro: string): Promise<string | undefined>
  /** Translate a `wslWorkspace` dictionary key (follows the DeepSeek Harness locale). */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Full component props: the owner share plus the injected face. */
export interface AddWslWorkspaceProps extends AddWslWorkspaceInjected {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Build the Linux child path one level below a parent, for the breadcrumb/
 * browse drill.
 * @param parent - the currently listed absolute path (`/` for root).
 * @param name - the child directory name.
 * @returns the child's absolute Linux path.
 */
export function dirChildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** A tiny inline terminal glyph for the dialog's directory rows. */
function WslGlyph({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 9l3.2 2.6L6 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 14h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The "Add WSL workspace…" footer action and its dialog.
 * @param props - owner share + injected face.
 */
export function AddWslWorkspace({ wide, t, describe, checkPreset, listDistros, listDir, check, createWorkspace }: AddWslWorkspaceProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [distros, setDistros] = useState<string[]>([])
  const [distro, setDistro] = useState('')
  const [pathInput, setPathInput] = useState('/home/')
  const [username, setUsername] = useState('')
  const [listing, setListing] = useState<WslDirListing | null>(null)
  const [browsePath, setBrowsePath] = useState('/')
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The "?" panel: help text plus the compatibility list the host reports.
  const [helpOpen, setHelpOpen] = useState(false)
  const [selfDescription, setSelfDescription] = useState<WslSelfDescription | null>(null)
  // Monotone browse-request sequence: stale responses for a superseded browse are dropped.
  const browseSeq = useRef(0)
  // The same for the open flow, which Retry re-runs: a retry supersedes the
  // open still in flight, and its late answers describe a state the dialog has
  // already left.
  const openSeq = useRef(0)

  const refreshBrowse = async (root: string, targetDistro: string): Promise<void> => {
    const seq = ++browseSeq.current
    setBrowsing(true)
    setBrowsePath(root)
    try {
      const value = await listDir(targetDistro, root)
      if (seq === browseSeq.current) setListing(value)
    } catch {
      // A failed browse (permission, missing dir) is non-fatal: keep old listing.
      if (seq === browseSeq.current) {
        setListing(null)
        setError((previous) => previous ?? t('error.loadDir'))
      }
    } finally {
      if (seq === browseSeq.current) setBrowsing(false)
    }
  }

  /**
   * The dialog's open flow: check the preset, list the distros, browse `/`.
   *
   * Named rather than inlined in the effect because Retry has to RUN it. A
   * retry that only cleared the error text left the dialog showing a verdict
   * about the host that nothing had re-read — the exact complaint issue #52 is
   * about, one button away from being unanswerable. Re-running is also what
   * makes the button useful for the `presetPending` case, where the host may
   * well have finished generating by the second press.
   * @returns nothing; every result lands in state.
   */
  const onOpen = async (): Promise<void> => {
    const seq = ++openSeq.current
    setError(null)
    // Advisory data for the help panel: never fatal, never blocking the form.
    void describe().then(value => { if (seq === openSeq.current) setSelfDescription(value) }).catch(() => { if (seq === openSeq.current) setSelfDescription(null) })
    setOpening(true)
    // The preset verdict and the distro list are separate questions with
    // separate answers. Collapsing a failed preset check into "could not list
    // distros" told the user to go look at their WSL installation for a
    // generation that had not finished — so a refusal of the CHECK keeps the
    // host's own words, which name the method that failed.
    let presetIssue: string | undefined
    try {
      presetIssue = await checkPreset()
    } catch (error) {
      presetIssue = error instanceof Error ? error.message : String(error)
    }
    let names: string[]
    try {
      names = await listDistros()
    } catch {
      if (openSeq.current !== seq) return
      setOpening(false)
      setError(t('error.loadDistros'))
      return
    }
    if (openSeq.current !== seq) return
    setDistros(names)
    const first = names[0] ?? ''
    setDistro(first)
    // The default browse root walks from `/`; the input defaults to `/home/`.
    setBrowsing(true)
    setOpening(false)
    if (presetIssue !== undefined) setError(presetIssue)
    if (first !== '') void refreshBrowse('/', first)
  }

  useEffect(() => {
    if (!open) return
    void onOpen()
    return () => { openSeq.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per open against current t.
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  if (!open) {
    // A W-letter action beside Settings at the sidebar foot; the title
    // carries the label in both wide and rail states.
    return (
      <button
        type="button"
        className={wide ? 'dww-action dww-action--wide' : 'dww-action dww-action--rail'}
        title={t('action.title')}
        aria-label={t('action.title')}
        onClick={() => setOpen(true)}
      >
        <span className="dww-letter" aria-hidden="true">W</span>
      </button>
    )
  }

  const onDrill = (name: string): void => {
    const next = dirChildPath(listing?.path ?? browsePath, name)
    setPathInput(next)
    void refreshBrowse(next, distro)
  }

  const onUp = (): void => {
    const parent = listing?.parent ?? null
    if (parent === null) return
    setPathInput(parent)
    void refreshBrowse(parent, distro)
  }

  const onDistroChange = (value: string): void => {
    setDistro(value)
    void refreshBrowse(browsePath, value)
  }

  const onCheck = async (): Promise<void> => {
    const path = normalizeLinuxPath(pathInput)
    setError(null)
    if (!isAbsoluteLinuxPath(path) || path === '/') {
      setError(t('error.invalidPath'))
      return
    }
    let facts: WslPathCheck
    try {
      facts = await check(distro, path)
    } catch {
      setError(t('error.pathNotFound'))
      return
    }
    if (!facts.exists || !facts.isDirectory) {
      setError(t('error.pathNotFound'))
      return
    }
    void refreshBrowse(path, distro)
  }

  const onConfirm = async (): Promise<void> => {
    const path = normalizeLinuxPath(pathInput)
    setError(null)
    if (!isAbsoluteLinuxPath(path) || path === '/') {
      // A workspace at the distribution root would make every session start
      // at `/`; the check flow rejects it and confirm must agree.
      setError(t('error.invalidPath'))
      return
    }
    const user = username.trim()
    if (user !== '' && !isValidWslUsername(user)) {
      setError(t('error.invalidUsername'))
      return
    }
    setBusy(true)
    try {
      let facts: WslPathCheck
      try {
        facts = await check(distro, path)
      } catch {
        setError(t('error.pathNotFound'))
        return
      }
      if (!facts.exists || !facts.isDirectory) {
        setError(t('error.pathNotFound'))
        return
      }
      const failure = await createWorkspace(path, user, distro)
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const children = (listing?.entries.filter(entry => entry.kind === 'directory') ?? []).map(entry => entry.name)
  const maskClick = (): void => { if (!busy) setOpen(false) }
  const listScroll: UIEventHandler<HTMLDivElement> = () => { /* scroll container handles overflow */ }

  return (
    <div className="dww-overlay">
      <div className="dww-overlay-mask" onClick={maskClick} />
      <div className="dww-card" role="dialog" aria-modal="true" aria-label={t('dialog.title')}>
        <div className="dww-header">
          <h2 className="dww-title">{t('dialog.title')}</h2>
          <button
            type="button"
            className="dww-help-btn"
            title={t('help.button')}
            aria-label={t('help.button')}
            aria-pressed={helpOpen}
            onClick={() => setHelpOpen(value => !value)}
          >
            ?
          </button>
          <button type="button" className="dww-close" aria-label={t('dialog.cancel')} onClick={maskClick}>
            ✕
          </button>
        </div>
        <div className="dww-body">
          {helpOpen ? (
            <WslHelp t={t} description={selfDescription} />
          ) : (<>
          {error !== null ? (
            <div className="dww-error">
              {error}
              <button type="button" className="dww-retry" onClick={() => { void onOpen() }}>{t('dialog.retry')}</button>
            </div>
          ) : null}
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-distro">{t('dialog.distro')}</label>
            <select
              id="dww-distro"
              className="dww-select"
              value={distro}
              disabled={opening || busy}
              onChange={event => onDistroChange(event.target.value)}
            >
              {distros.length === 0
                ? <option value="">{opening ? t('dialog.loading') : ''}</option>
                : distros.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-path">{t('dialog.path')}</label>
            <div className="dww-input-row">
              <input
                id="dww-path"
                className="dww-input"
                value={pathInput}
                placeholder={t('dialog.pathPlaceholder')}
                disabled={opening || busy}
                onChange={event => setPathInput(event.target.value)}
              />
              <button type="button" className="dww-check-btn" disabled={opening || busy} onClick={() => void onCheck()}>
                {t('dialog.check')}
              </button>
            </div>
          </div>
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-username">{t('dialog.username')}</label>
            <input
              id="dww-username"
              className="dww-input"
              value={username}
              placeholder={t('dialog.usernamePlaceholder')}
              disabled={opening || busy}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setUsername(event.target.value)}
            />
          </div>
          <div className="dww-feedback">
            <div className="dww-breadcrumb">{browsePath}</div>
            <div className="dww-dirlist" onScroll={listScroll}>
              {browsing ? <div className="dww-dir-empty">{t('dialog.loading')}</div> : (
                listing?.parent !== null && listing !== null
                  ? (
                    <button type="button" className="dww-dir-row dww-dir-row--up" onClick={onUp}>
                      <WslGlyph size={14} />
                      <span>{t('dialog.upLevel')}</span>
                    </button>
                  )
                  : null
              )}
              {!browsing && (children.length === 0)
                ? <div className="dww-dir-empty">{t('dialog.browseEmpty')}</div>
                : children.map(name => (
                  <button type="button" key={name} className="dww-dir-row" onClick={() => onDrill(name)}>
                    <WslGlyph size={14} />
                    <span>{name}</span>
                  </button>
                ))}
            </div>
          </div>
          </>)}
        </div>
        <div className="dww-actions">
          <button type="button" className="dww-btn" disabled={busy} onClick={maskClick}>{t('dialog.cancel')}</button>
          <button type="button" className="dww-btn dww-btn--primary" disabled={busy || opening} onClick={() => void onConfirm()}>
            {busy ? t('dialog.loading') : t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { ApiCall }
