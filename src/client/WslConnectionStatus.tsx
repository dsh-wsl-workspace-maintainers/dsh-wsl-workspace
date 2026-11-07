/** The selected distribution's command connection, independent of DeepSeek account sign-in. */
import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isValidWslUsername } from '../shared/paths.ts'
import { wslConnectionCheck, type WslConnectionCheck } from './api.ts'

interface WslConnectionStatusProps {
  distro: string
  username: string
  t: (key: string, params?: Record<string, unknown>) => string
}

type Connection = WslConnectionCheck['status'] | 'idle' | 'checking'
type Target = { distro: string; username: string }
type Result = { target: Target; status: Connection; reason?: WslConnectionCheck['reason'] }

/** Re-check whenever the selected distribution or Linux user changes. */
export function WslConnectionStatus({ distro, username, t }: WslConnectionStatusProps): React.ReactElement {
  const selectedDistro = distro.trim()
  const selectedUser = username.trim()
  // Object identity also distinguishes switching A → B → A. A prior green result for A must not
  // become current again before the new A check starts.
  const target = useMemo(() => ({ distro: selectedDistro, username: selectedUser }), [selectedDistro, selectedUser])
  const currentTarget = useRef(target)
  currentTarget.current = target
  const requestSequence = useRef(0)
  const previousDistro = useRef('')
  const [result, setResult] = useState<Result | null>(null)
  const [expanded, setExpanded] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const validUsername = selectedUser === '' || isValidWslUsername(selectedUser)
  const canCheck = selectedDistro !== '' && validUsername
  // A target change immediately hides the old answer, before the effect runs or its debounce ends.
  const connection: Connection = result?.target === target ? result.status : canCheck ? 'checking' : 'idle'
  const reason = result?.target === target ? result.reason : undefined

  async function checkConnection(): Promise<void> {
    if (!canCheck) return
    const request = ++requestSequence.current
    setResult({ target, status: 'checking' })
    try {
      const answer = await wslConnectionCheck(target.distro, target.username)
      if (request !== requestSequence.current || currentTarget.current !== target) return
      setResult({ target, status: answer.status, reason: answer.reason })
    } catch {
      if (request !== requestSequence.current || currentTarget.current !== target) return
      setResult({ target, status: 'failed', reason: 'connection-failed' })
    }
  }

  useEffect(() => {
    const distroChanged = previousDistro.current !== target.distro
    previousDistro.current = target.distro
    const delay = !distroChanged && target.username !== '' ? 300 : 0
    let timer: ReturnType<typeof setTimeout> | undefined
    if (canCheck) {
      if (delay === 0) void checkConnection()
      else timer = setTimeout(() => { void checkConnection() }, delay)
    }
    return () => {
      clearTimeout(timer)
      requestSequence.current += 1
    }
  }, [target])

  useEffect(() => {
    if (!expanded) return
    const outside = (event: MouseEvent): void => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [expanded])

  const statusKey = !validUsername ? 'invalid-user'
    : connection === 'idle' ? 'idle'
      : connection === 'failed' && reason !== undefined ? reason
        : connection
  const statusText = t(`connection.status.${statusKey}`)
  const targetText = `${target.distro || t('connection.noDistro')} · ${target.username || t('connection.defaultUser')}`
  const escape = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false) }
  }

  return (
    <div className="dww-connection" ref={anchor} onKeyDown={escape}>
      <button
        type="button"
        className="dww-connection-chip"
        data-state={connection}
        title={`${targetText}: ${statusText}`}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        onClick={() => setExpanded(value => !value)}
      >
        <span className="dww-connection-dot" aria-hidden="true" />
        {t('connection.chip')}
        <span className="dww-connection-caret" aria-hidden="true">▾</span>
      </button>
      {expanded ? (
        <section className="dww-connection-panel" role="dialog" aria-label={t('connection.title')}>
          <div className="dww-connection-title">{t('connection.title')}</div>
          <p className="dww-connection-target">{targetText}</p>
          <div className="dww-connection-row">
            <div className="dww-connection-status" data-state={connection} role="status" aria-live="polite">
              <span className="dww-connection-dot" aria-hidden="true" />{statusText}
            </div>
            <button
              className="dww-check-btn dww-connection-check"
              type="button"
              disabled={!canCheck || connection === 'checking'}
              onClick={() => { void checkConnection() }}
            >
              {t(connection === 'checking' ? 'connection.checking' : connection === 'failed' ? 'connection.retry' : 'connection.check')}
            </button>
          </div>
          <p className="dww-connection-note">{t('connection.hint')}</p>
        </section>
      ) : null}
    </div>
  )
}
