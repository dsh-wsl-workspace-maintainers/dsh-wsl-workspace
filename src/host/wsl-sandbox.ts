/**
 * The WSL world's `sandbox` capability.
 *
 * DSH's confinement seam wraps a command so the host's runner enforces the file
 * policy. That runner describes Windows paths: asked to confine a command whose
 * policy carries a `\\wsl.localhost\…` workspace root it fails outright
 * (`GetNamedSecurityInfoW failed (Win32 1)` — the ACL of a 9P path cannot be
 * read), and even where it worked it could not bound a process that executes on
 * the Linux kernel side. That is why this plugin's bash tool has never gone
 * through it, and why the host's persistent-shell group cannot be reused as-is:
 * its backend calls `sandbox.confine()` before spawning.
 *
 * So the world declares its own provider: commands run unconfined by the
 * Windows runner — the distribution is the boundary — while the file tools keep
 * enforcing the policy themselves, at the resolved real path, in
 * `src/fs.ts`. `enforcement: 'partial'` records that split honestly: within this
 * world the policy is enforced for file effects, not by the wrapped command.
 *
 * @module dsh-wsl-workspace/host/wsl-sandbox
 */

import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'

/** The WSL world's no-op confinement: the caller's argv, unchanged. */
export class WslSandboxProvider extends SandboxProvider {
  constructor(ctx: Context) {
    super(ctx)
  }

  /**
   * Hand back the caller's own argv.
   * @param argv - the command the caller wants to run.
   * @returns the same argv, with the world's honest enforcement claim.
   */
  override async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return {
      argv: [...argv],
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

export default WslSandboxProvider
