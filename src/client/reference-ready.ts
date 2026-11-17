/** Await actual store notifications, not a polling loop or a guessed default.
 * undefined = not ready; null may be used by a caller for a confirmed native
 * session. Subscribe before the second read to avoid losing a ready transition.
 */
export function waitForReferenceReady<T>(
  read: () => T | undefined,
  subscribe: (listener: () => void) => () => void,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let release = (): void => {}
    let settled = false
    const finish = (value: T): void => {
      settled = true; release(); signal.removeEventListener('abort', abort); resolve(value)
    }
    const abort = (): void => {
      if (settled) return
      settled = true; release(); signal.removeEventListener('abort', abort)
      reject(new Error('source-session-not-ready'))
    }
    const check = (): void => {
      if (settled) return
      if (signal.aborted) { abort(); return }
      const value = read()
      if (value !== undefined) finish(value)
    }
    signal.addEventListener('abort', abort, { once: true })
    release = subscribe(check)
    if (settled) release()
    check()
  })
}
