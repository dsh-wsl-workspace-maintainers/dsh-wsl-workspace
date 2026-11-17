/** Observed WSL execution coordinates, never a second distribution selector.
 * Shared by all built Host entries through one code-split module. No ambient
 * default lookup, caller-supplied cwd, filesystem access, or Client writes here.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols } from '@deepseek-ai/cordis'
import { traceReference } from './reference-trace.ts'

export type ReferenceBinding =
  | { status: 'unknown' }
  | { status: 'ambiguous' }
  | { status: 'bound'; distro: string }

const execution = new AsyncLocalStorage<string | undefined>()
const bindings = new Map<string, ReferenceBinding>()
const MAX_SESSIONS = 4096
const waiting = new Map<string, Set<() => void>>()

/** Carry identity from the actual tool dispatch, not the visible session. */
export function inReferenceExecution<T>(sessionId: string | undefined, next: () => T): T {
  return execution.run(sessionId, next)
}

/** Record the already-selected coordinate without influencing tool execution.
 * A session can produce links from several agents/tools. Conflicting evidence
 * is intentionally sticky: an unqualified old link cannot identify its distro.
 */
export function observeReferenceDistro(distro: string, sessionId = execution.getStore(), stage = 'world-observed'): void {
  if (!sessionId || !distro || distro === '.' || distro === '..' || /[\\/\x00-\x1f]/.test(distro)) return
  const previous = bindings.get(sessionId)
  if (previous === undefined && bindings.size >= MAX_SESSIONS) return
  bindings.set(sessionId, previous?.status === 'ambiguous'
    || (previous?.status === 'bound' && previous.distro !== distro)
    ? { status: 'ambiguous' } : { status: 'bound', distro })
  const next = bindings.get(sessionId)!
  if (previous === undefined || previous.status !== next.status) {
    traceReference({ sourceSessionId: sessionId, stage: next.status === 'ambiguous' ? 'world-ambiguous' : stage, distro })
  }
  for (const notify of [...waiting.get(sessionId) ?? []]) notify()
}

/** Read-only, source-session lookup. Missing history stays unknown, not default. */
export function referenceBinding(sessionId: string): ReferenceBinding {
  return { ...(bindings.get(sessionId) ?? { status: 'unknown' }) }
}


/** A first click can race composition. Resume on that session's publication;
 * abort always releases the listener. No tool call or polling is required. */
export function waitForReferenceBinding(sessionId: string, signal: AbortSignal): Promise<ReferenceBinding> {
  const ready = referenceBinding(sessionId)
  if (ready.status !== 'unknown' || signal.aborted) return Promise.resolve(ready)
  return new Promise(resolve => {
    const listeners = waiting.get(sessionId) ?? new Set<() => void>()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      listeners.delete(check)
      if (listeners.size === 0 && waiting.get(sessionId) === listeners) waiting.delete(sessionId)
      signal.removeEventListener('abort', finish)
      resolve(referenceBinding(sessionId))
    }
    const check = (): void => { if (referenceBinding(sessionId).status !== 'unknown') finish() }
    listeners.add(check); waiting.set(sessionId, listeners)
    signal.addEventListener('abort', finish, { once: true })
    check()
    if (signal.aborted) finish()
  })
}


/** Standing preset compositions can all hear agent/created on some hosts.
 * Verify the selected provider by service identity, not by event delivery or
 * preset naming, before publishing a new session's initial coordinate. */
export function ownsReferenceWorld(ctx: { get(name: string): unknown }, agent: unknown, provider = ctx.get('fs')): boolean {
  const registry = ctx.get('agentPresets') as { serviceFor?: (agent: unknown, name: string) => unknown } | undefined
  if (provider === undefined || typeof registry?.serviceFor !== 'function') return false
  const raw = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    const tracked = value as Record<symbol, unknown>
    return tracked[symbols.original]
      ?? (Object.hasOwn(value, symbols.shadow) ? Object.getPrototypeOf(value) : value)
  }
  return raw(registry.serviceFor(agent, 'fs')) === raw(provider)
}
