/** Minimal path-resolution diagnostics. Never accept a context, options, body,
 * environment, error object or document contents here. */
export function traceReference(fields: {
  sourceSessionId: string
  stage: string
  path?: string
  cwd?: string
  preset?: string
  distro?: string
  method?: string
}): void {
  // Explicit, non-persistent opt-in. Normal operation must not emit session
  // identities or paths to the console. Never enumerate the environment.
  const browserDebug = (globalThis as { __DSH_WSL_REFERENCE_DEBUG__?: boolean }).__DSH_WSL_REFERENCE_DEBUG__ === true
  const hostDebug = typeof process !== 'undefined' && process.env.DSH_WSL_REFERENCE_DEBUG === '1'
  if (browserDebug || hostDebug) console.debug('[wsl-reference]', fields)
}
