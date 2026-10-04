/**
 * Carrying the host's readiness contract across the WSL boundary.
 *
 * WSL imports a Windows environment variable into a distribution only when that
 * variable is named in `WSLENV`. `@deepseek-ai/dsh-terminal-bash` injects its bash
 * readiness contract — `PS1` plus a `PROMPT_COMMAND` that emits the OSC `133;D;`
 * marker and re-sets `PS1` — as ordinary Windows variables (its
 * `childEnvironment()`, at `lib/index.js:935-955`), so a relay that spawns
 * `wsl.exe` without naming them produces a shell whose prompt the host can never
 * recognise. Measured on 2026-10-04 under a real ConPTY: with the keys present but
 * unnamed, neither the marker nor the prompt literal reaches the wire; naming them
 * in `WSLENV` makes both appear — and the inner `bash -lc` profile chain does not
 * undo it, because the crossed `PROMPT_COMMAND` re-assigns `PS1` at every prompt.
 *
 * This is a pure function over the environment so it can be asserted offline: the
 * relay module itself spawns `wsl.exe` at load time.
 *
 * @module dsh-wsl-workspace/shared/wsl-env
 */

/**
 * The keys that carry the readiness contract. Prompt text, not paths, so none of
 * them may get the `/p` translation flag — that would rewrite the value as a
 * `/mnt/<drive>` path on the way in.
 */
export const READINESS_KEYS: readonly string[] = ['PS1', 'PROMPT_COMMAND']

/**
 * The environment for `wsl.exe`, with the readiness keys named in `WSLENV`.
 *
 * Ambient `WSLENV` entries survive and are never duplicated; a key absent or empty
 * in the environment is not named, so a host that injects no contract leaves the
 * environment byte-identical to what it was (including having no `WSLENV` at all).
 * @param env - the environment the relay process itself was started with.
 * @returns a shallow copy with `WSLENV` merged, and `undefined` values dropped.
 */
export function bridgeReadiness(env: NodeJS.ProcessEnv): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value
  }
  const named = new Set(
    (merged.WSLENV ?? '').split(':').filter(entry => entry !== '')
      .map(entry => entry.replace(/\/[plu]$/, '')),
  )
  const additions = READINESS_KEYS.filter(key =>
    !named.has(key) && merged[key] !== undefined && merged[key] !== '')
  if (additions.length === 0) return merged
  const entries = (merged.WSLENV ?? '').split(':').filter(entry => entry !== '')
  merged.WSLENV = [...entries, ...additions].join(':')
  return merged
}
