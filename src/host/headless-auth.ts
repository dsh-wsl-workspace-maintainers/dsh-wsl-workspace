/**
 * Account connectivity for headless, and the credential-free launch overlay that points a headless
 * run at the desktop's account sign-in. Nothing here reads or writes the user's profiles: the
 * overlay is handed to the caller, who loads it per launch with `--patch`.
 */

export interface AccountClientMetadata {
  version: string
  locale: string
  timezoneOffsetSeconds: number
}

/** Only the fresh balance outcome is used; account/profile caches are not proof. */
export interface HeadlessAccount {
  getBalance(client: AccountClientMetadata): Promise<{ status: 'ready' | 'failed' } | null>
}

export interface HeadlessAuthOptions {
  account?: () => HeadlessAccount | undefined
  selection?: () => { provider: string; model: string }
  client: AccountClientMetadata
  /** Test seam; the production wait is always bounded to twelve seconds. */
  checkTimeoutMs?: number
}

export interface HeadlessAuthCheck {
  status: 'connected' | 'signed-out' | 'unavailable' | 'failed'
  reason?: 'timeout' | 'connection-failed' | 'service-unavailable'
}

export interface HeadlessAuthOverlay {
  yaml: string
  filename: string
}

export class HeadlessAuthError extends Error {
  code: 'CONFIG_INVALID'

  constructor(code: HeadlessAuthError['code'], detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'HeadlessAuthError'
    this.code = code
  }
}

const AUTH_IDS = ['credentials', 'authorization', 'deepseek-account'] as const
const MODEL_ID = 'agent-default-model'
const DEFAULT_MODEL = 'deepseek-flash'
const OVERLAY_FILENAME = 'headless-account.patch.yml'
const CHECK_TIMEOUT_MS = 12_000

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The desktop's account model when it uses one, else the account default. */
function selectedModel(options: HeadlessAuthOptions): string {
  let selection: { provider: string; model: string } | undefined
  try { selection = options.selection?.() } catch {
    throw new HeadlessAuthError('CONFIG_INVALID', 'the current model selection could not be read')
  }
  return selection?.provider === 'deepseek-account' && typeof selection.model === 'string' && selection.model.trim() !== '' ? selection.model : DEFAULT_MODEL
}

/**
 * The overlay text. Fixed rows plus one model name; a JSON string is a valid YAML double-quoted
 * scalar, so the model needs no YAML library to be written safely.
 */
function overlayText(model: string): string {
  const rows = AUTH_IDS.map(id => `- id: ${id}\n  disabled: false\n`)
  rows.push(`- id: ${MODEL_ID}\n  config:\n    provider: deepseek-account\n    model: ${JSON.stringify(model)}\n`)
  return rows.join('')
}

/** All inputs are chosen on the host; HTTP callers choose nothing. */
export function createHeadlessAuth(options: HeadlessAuthOptions): {
  check(): Promise<HeadlessAuthCheck>
  overlay(): HeadlessAuthOverlay
} {
  let checking: Promise<HeadlessAuthCheck> | undefined

  async function check(): Promise<HeadlessAuthCheck> {
    if (checking !== undefined) return checking
    checking = (async () => {
      let account: HeadlessAccount | undefined
      try { account = options.account?.() } catch { return { status: 'unavailable', reason: 'service-unavailable' } as const }
      if (account === undefined || typeof account.getBalance !== 'function') return { status: 'unavailable', reason: 'service-unavailable' } as const
      let timeout: ReturnType<typeof setTimeout> | undefined
      const elapsed = new Promise<HeadlessAuthCheck>(resolve => {
        timeout = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), Math.max(1, Math.min(options.checkTimeoutMs ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS)))
      })
      const request = Promise.resolve().then(() => account.getBalance(options.client)).then((result): HeadlessAuthCheck => {
        if (result === null) return { status: 'signed-out' }
        return object(result) && result.status === 'ready' ? { status: 'connected' } : { status: 'failed', reason: 'connection-failed' }
      }, (): HeadlessAuthCheck => ({ status: 'failed', reason: 'connection-failed' }))
      try { return await Promise.race([request, elapsed]) } finally { clearTimeout(timeout) }
    })().finally(() => { checking = undefined })
    return checking
  }

  return { check, overlay: () => ({ yaml: overlayText(selectedModel(options)), filename: OVERLAY_FILENAME }) }
}
