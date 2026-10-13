/**
 * The WSL world's answer for `run_code` when the host's Windows sandbox cannot be started at all.
 *
 * Issue #78, measured on the maintainer machine 2026-10-13 in a real session with a real model:
 *   · `wsl-ptc` + `workspace-write` + a `\\wsl.localhost\…` root — 83 ms,
 *     `code run failed (worker-exit): GetNamedSecurityInfoW failed (Win32 1)`;
 *   · the same program under `read-only` — 826 ms, answers `1`, and the host itself says
 *     `File sandbox enforcement is partial on this host.`;
 *   · the same program under `danger-full-access` — 558 ms, answers `1`;
 *   · and with this plugin entirely absent, a plain host `ptc` session over the same UNC root fails
 *     with the same sentence, so the fault is not the world this plugin mounts.
 *
 * Why the host reaches here: the Windows sandbox grants write by reading the workspace root's security
 * descriptor (`GetNamedSecurityInfoW`) and setting it back. A `\\wsl.localhost\…` root is a 9P share,
 * which carries no Windows security descriptor, so that read answers `ERROR_INVALID_FUNCTION` and the
 * worker dies before the program runs. Only `workspace-write` asks for the grant, which is why the other
 * two modes answer.
 *
 * What this module does NOT do: it does not make the sandbox work. A real confinement for this world
 * would have to be enforced inside the distribution (the shape discussion
 * deepseek-ai/deepseek-harness#8644 reports for `dsh-plugin-wsl-env`: `wsl.exe … --exec bwrap`). Until
 * someone builds that, the honest options were "let it run under a no-op sandbox" and "say plainly that
 * it cannot run, with the ways out". The first is a door that looks closed and is open; this file takes
 * the second. The guard fires only in the exact shape that was measured to fail, and the sentence names
 * the settings that do work.
 */
/** The tool the PTC runtime registers; a guard sees every call, so this is the only name it speaks for. */
const RUN_CODE_NAME = 'run_code'

/** The one mode whose grant path is the failing one. */
const WRITE_MODE = 'workspace-write'

/**
 * A root the Windows ACL runner cannot read a security descriptor from: the per-distribution 9P shares
 * (`\\wsl.localhost\<distro>\…` and the legacy `\\wsl$\<distro>\…`). Deliberately narrower than "any UNC",
 * because an ordinary SMB share does have a security descriptor and does not fail.
 * @param root - an absolute path as the policy resolved it.
 */
export function isWsl9pRoot (root: string): boolean {
  const lowered = root.toLowerCase()
  return lowered.startsWith('\\\\wsl.localhost\\') || lowered.startsWith('\\\\wsl$\\')
}

/**
 * The refusal. Four sentences, in the order a reader needs them: what was asked, why it cannot start,
 * that this is not a problem with their program, and the three settings that do run.
 * @param root - the session's workspace root, quoted back so the reader sees which path was tested.
 */
export function refusalForRoot (root: string): string {
  return 'run_code cannot start in this session: the Windows file sandbox grants write access by reading '
    + `the workspace root's security descriptor, and the root here is a WSL 9P share (${root}), which has `
    + 'none — the host reports `GetNamedSecurityInfoW failed (Win32 1)` before any program runs, so this is '
    + 'not a problem with the code asked for. Three settings do run: switch this session to read-only (the '
    + 'host reports enforcement as partial), switch it to danger-full-access, or use the world\'s own tools '
    + '(`bash`, `wsl_terminal`, `read`, `write`, `edit`, `grep`, `glob`), which run inside the distribution. '
    + 'A sandbox enforced inside the distribution itself is the open work tracked as issue #78.'
}

/** What a guard may read about one call, narrowed to the fields this decision uses. */
interface ExecFace {
  name?: string
  arguments?: Record<string, unknown>
  agent?: { session?: Record<string, unknown> }
}

/** The policy service slice this guard reads; `resolve` is the host's own per-call resolution. */
interface PolicyFace {
  resolve (request: { session?: Record<string, unknown> }): { mode?: string; workspaceRoot?: string }
}

/**
 * The decision, kept away from the registration so a test can drive all six shapes without a host.
 * @param exec - the tool execution the guard was asked about.
 * @param policy - the session's resolved sandbox policy, or undefined when it cannot be read.
 * @returns the refusal sentence, or undefined to let the call proceed.
 */
export function denyRunCodeOn9p (exec: ExecFace, policy: { mode?: string; workspaceRoot?: string } | undefined): string | undefined {
  if (exec.name !== RUN_CODE_NAME || policy === undefined) return undefined
  // An escalated call carries the mode the user approved; only the plain session setting is ours to read.
  if (typeof exec.arguments?.sandbox_permissions === 'string') return undefined
  if (policy.mode !== WRITE_MODE) return undefined
  const root = policy.workspaceRoot
  if (typeof root !== 'string' || !isWsl9pRoot(root)) return undefined
  return refusalForRoot(root)
}

/**
 * The slice of a cordis context this module touches. Typed structurally rather than by importing
 * `@deepseek-ai/cordis`, because `tests/wsl-run-code-guard.test.ts` lives in the pure-node bucket and
 * `scripts/check-unit-closure.mjs` reddens that whole bucket over one host package it cannot install.
 */
interface GuardContext {
  get (key: string): unknown
}

/**
 * Register the guard. It goes through `ctx.get`, not an injected proxy property — the host loader hands
 * out `exports.default ?? exports`, so module-level `inject` never reaches the fiber (the same reason
 * recorded for the shell at `src/host/wsl-bash-tool.ts:456-466` and for the image read in
 * `src/host/wsl-image-tool.ts:213-216`).
 * @param ctx - the plugin's own context; the guard is registered where the tool registry lives.
 */
export function applyRunCodeGuard (ctx: GuardContext): void {
  const tools = ctx.get('tools') as unknown as { guard?: (guard: (exec: ExecFace) => string | undefined) => unknown } | undefined
  if (typeof tools?.guard !== 'function') return
  const policy = ctx.get('sandboxPolicy') as unknown as PolicyFace | undefined
  tools.guard((exec: ExecFace) => denyRunCodeOn9p(exec, policy === undefined ? undefined : policy.resolve({
    ...exec.agent?.session === undefined ? {} : { session: exec.agent.session },
  })))
}

export default applyRunCodeGuard
