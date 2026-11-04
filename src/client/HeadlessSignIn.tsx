/** Account connection for headless: a status pill in the dialog header with a launch-overlay popover. */
import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { headlessAuthCheck, headlessAuthOverlay } from './api.ts'
import type { HeadlessAuthCheck } from './api.ts'

interface HeadlessSignInProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

type Connection = HeadlessAuthCheck['status'] | 'idle' | 'checking'

const DOCS_URL = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials'

function downloadOverlay(yaml: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** Only an authenticated account request can turn the connection indicator green. */
export function HeadlessSignIn({ t }: HeadlessSignInProps): React.ReactElement {
  const [connection, setConnection] = useState<Connection>('idle')
  const [reason, setReason] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [feedback, setFeedback] = useState<'' | 'downloaded' | 'downloadFailed'>('')
  const [expanded, setExpanded] = useState(false)
  const generation = useRef(0)
  const anchor = useRef<HTMLDivElement>(null)
  const busy = connection === 'checking' || downloading

  useEffect(() => {
    // One check per dialog open, so the header pill answers without opening the popover;
    // the popover's Check button stays for a re-check (e.g. right after signing in on desktop).
    void checkConnection()
    return () => { generation.current += 1 }
  }, [])

  // A press anywhere outside the pill and its popover folds the popover away.
  useEffect(() => {
    if (!expanded) return
    const outside = (event: MouseEvent): void => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [expanded])

  async function checkConnection(): Promise<void> {
    const request = ++generation.current
    setConnection('checking')
    setReason('')
    setFeedback('')
    try {
      const answer = await headlessAuthCheck()
      if (request !== generation.current) return
      setConnection(answer.status)
      setReason(answer.reason ?? '')
    } catch {
      if (request !== generation.current) return
      setConnection('failed')
      setReason('request-failed')
    }
  }

  async function download(): Promise<void> {
    const request = ++generation.current
    setDownloading(true)
    setFeedback('')
    try {
      const overlay = await headlessAuthOverlay()
      if (request !== generation.current) return
      downloadOverlay(overlay.yaml, overlay.filename)
      setFeedback('downloaded')
    } catch {
      if (request === generation.current) setFeedback('downloadFailed')
    } finally {
      if (request === generation.current) setDownloading(false)
    }
  }

  const statusKey = connection === 'failed' && reason === 'timeout' ? 'timeout' : connection
  const statusText = t(`auth.status.${statusKey}`)
  const escape = (event: React.KeyboardEvent): void => {
    // Escape folds the popover first; the dialog's own Escape must not also fire.
    if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false) }
  }

  return (
    <div className="dww-auth" ref={anchor} onKeyDown={escape}>
      <button
        type="button"
        className="dww-auth-chip"
        data-state={connection}
        title={statusText}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        onClick={() => setExpanded(value => !value)}
      >
        <span className="dww-auth-dot" aria-hidden="true" />
        {t('auth.chip')}
        <span className="dww-auth-caret" aria-hidden="true">▾</span>
      </button>
      {expanded ? (
        <section className="dww-signin-notice" role="dialog" aria-label={t('auth.title')}>
          <div className="dww-auth-head">
            <span className="dww-auth-title">{t('auth.title')}</span>
            <a className="dww-help-link" href={DOCS_URL} target="_blank" rel="noreferrer">{t('auth.docs')}</a>
          </div>
          <div className="dww-auth-row">
            <div className="dww-auth-status" data-state={connection} role="status" aria-live="polite">
              <span className="dww-auth-dot" aria-hidden="true" />{statusText}
            </div>
            <button className="dww-check-btn dww-auth-check" type="button" title={t('auth.checkHint')} disabled={busy} onClick={() => { void checkConnection() }}>
              {t(connection === 'checking' ? 'auth.checking' : 'auth.check')}
            </button>
          </div>
          <div className="dww-auth-row">
            <p className="dww-auth-note" data-tone="hint">{t('auth.patchHint')}</p>
            <button className="dww-btn dww-btn--primary dww-auth-apply" type="button" disabled={busy || connection !== 'connected'} onClick={() => { void download() }}>
              {t(downloading ? 'auth.downloading' : 'auth.download')}
            </button>
          </div>
          {feedback !== ''
            ? <p className="dww-auth-note dww-auth-feedback" data-tone={feedback === 'downloaded' ? 'success' : 'error'} role="status">{t(`auth.feedback.${feedback}`)}</p>
            : null}
        </section>
      ) : null}
    </div>
  )
}
