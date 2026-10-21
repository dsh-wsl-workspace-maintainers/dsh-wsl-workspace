/**
 * WSL Service Provider for the `ctx.fs` capability seam. Backed by the host
 * filesystem over the `\\wsl.localhost\<distro>\…` 9P share — zero install
 * inside the distribution — while every model/UI-facing path is the Linux
 * path a WSL process would open (`processPath`, `displayPath`, `fileUrl`).
 * Reuses `LocalFileSystem`'s mechanics (realpath identity, atomic writes,
 * per-target locks, version guards) unchanged, because those operate on the
 * UNC path Node can open directly.
 *
 * Both UNC paths and Linux absolute paths resolve; Windows drive paths
 * resolve through their `/mnt/<drive>` form, so a WSL-composed session can
 * still touch the Windows filesystem coherently.
 *
 * Two seams the host's own provider supplies are re-established here, because
 * a WSL world mounts this backend in a preset realm where the host's
 * `fs-sandbox` wrapper (and therefore both behaviours) is not in the call
 * path:
 *
 * - **Linux symlinks**: the share lists a link but cannot resolve it, so a link
 *   path used to fail as missing. `resolve`/`lstat` now retry through the
 *   distribution (`wsl.exe … readlink -f`, see `shared/links.ts`) and continue
 *   at the real path — never silently replacing the link, since the fallback
 *   only runs when the direct resolution failed.
 * - **The file policy**: writes are fenced by `ctx.sandboxPolicy` exactly like
 *   `@deepseek-ai/dsh-fs-sandbox` fences the host backend — the same
 *   `writableRoots` allow-list, the same `FS_SANDBOX_DENIED` error the tool
 *   layer turns into its model-facing denial and escalation hint, and the same
 *   `sandboxMode` capability fact it reads to advertise escalation.
 *
 * @module dsh-wsl-workspace/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, lstat, rename } from 'node:fs/promises'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveLinuxSymlink } from './shared/links.ts'
import {
  isAbsoluteLinuxPath,
  joinUnc,
  mntToWindowsPath,
  parseWslUnc,
  windowsToMntPath,
} from './shared/paths.ts'
import { defaultDistroSync } from './shared/wsl.ts'

/** Plugin config. `cwd`/`distro` are optional because UNC workdirs carry both. */
export interface Config {
  /** Base directory for relative paths without a per-call cwd (UNC or Linux). */
  cwd?: string
  /** Default distribution for Linux-absolute paths without a UNC cwd. */
  distro?: string
  /** Exclusive UTF-8 byte limit on each overwrite-diff side (see fs-local). */
  diffBasisMaxBytes?: number
}

/** The host file-effect policy for one call, as `ctx.sandboxPolicy` resolves it. */
export interface SandboxPolicyLike {
  mode: string
  workspaceRoot?: string
}

/** The `ctx.sandboxPolicy` face this backend fences its writes with (optional service). */
export interface SandboxPolicyFace {
  /** Deployment default mode, mirrored as this backend's `sandboxMode`. */
  defaultMode?: SandboxMode
  /** Per-call (or session-resolved) policy. */
  resolve(): SandboxPolicyLike
}


/** One translated coordinate: the input the local backend opens plus its cwd. */
interface Translated {
  /** Absolute path to hand to the local backend (UNC or Windows drive). */
  input: string
  /** Absolute Windows-side base for relative inputs (UNC or Windows drive). */
  cwd: string
}

/**
 * The WSL filesystem backend. Identity keys are canonical UNC paths; the
 * Linux form is derived on demand, so both worlds stay in sync across
 * aliases and symlinks.
 */
export class WslFileSystem extends LocalFileSystem {
  static override Config: z<Config> = z.object({
    cwd: z.string(),
    distro: z.string(),
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
  })

  private readonly distro: string | undefined
  private readonly executionCwd = new AsyncLocalStorage<string | undefined>()

  constructor(ctx: Context, config: Config) {
    // schemastery fills the defaults before construction; the parent validates
    // `diffBasisMaxBytes` and stores the resolved shape.
    super(ctx, config)
    this.distro = config.distro
    ctx.on('tools/execute', (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => (
      this.executionCwd.run(exec.agent?.session.header.cwd, next)
    ))
    // The 9P/drvfs substrate has no hard links and no Win32 security semantics:
    // replace the atomic-publication boundaries the parent's fsio defaults to.
    this.internals = {
      linkFile: WslFileSystem.publishNoReplace,
      replaceFile: WslFileSystem.replaceOverWrite,
      copyFileDacl: WslFileSystem.skipDaclCopy,
    }
  }

  /**
   * No-replace publication for filesystems without hard links. A real
   * collision (a concurrent external creator won) must still surface as the
   * original EEXIST so the guarded-create failure path classifies it; an
   * absent target falls back to rename, which on Windows publishes without
   * replacing anything. Safe against this backend's own writers because the
   * per-target lock serializes them.
   * @param tempPath - the staged file.
   * @param destPath - the destination to create.
   */
  private static async publishNoReplace(tempPath: string, destPath: string): Promise<void> {
    try {
      await link(tempPath, destPath)
      return
    } catch (error) {
      let exists = false
      try {
        await lstat(destPath)
        exists = true
      } catch {
        // Absent destination: rename publishes the staged file.
      }
      if (exists) throw error
      await rename(tempPath, destPath)
    }
  }

  /**
   * Security-preserving replacement boundary: Windows rename replaces an
   * existing destination atomically; no DACL preservation is needed over 9P.
   * @param destPath - the file being replaced.
   * @param tempPath - the staged replacement.
   */
  private static async replaceOverWrite(destPath: string, tempPath: string): Promise<void> {
    await rename(tempPath, destPath)
  }

  /** 9P files inherit their directory's DACL; nothing to preserve. */
  private static async skipDaclCopy(): Promise<void> {}

  /** Translate a model/plugin path into Windows-side coordinates. */
  private translate(path: string, cwd?: string): Translated {
    const unc = parseWslUnc(path)
    if (unc !== null) {
      return { input: joinUnc(unc.distro, unc.linuxPath), cwd: this.cwdOr(cwd) }
    }
    if (isAbsoluteLinuxPath(path)) {
      // /mnt/<drive>/… names the Windows filesystem inside the Linux world
      // (the dual-access path for migration): open the drive path directly so
      // both worlds stay coherent — the display stays the /mnt form.
      const win = mntToWindowsPath(path)
      if (win !== null) return { input: win, cwd: this.cwdOr(cwd) }
      return { input: joinUnc(this.distroFor(cwd), path), cwd: this.cwdOr(cwd) }
    }
    if (windowsToMntPath(path) !== null) {
      // Windows drive paths open directly; the Linux world reaches them via /mnt.
      return { input: path, cwd: this.cwdOr(cwd) }
    }
    // Relative: resolve against the caller cwd (or the configured base).
    const base = this.uncCwd(cwd)
    return { input: path, cwd: base }
  }

  /** A base for absolute inputs (unused by resolution, but the parent needs one). */
  private cwdOr(cwd?: string): string {
    return cwd ?? this.executionCwd.getStore() ?? this.config.cwd ?? process.cwd()
  }

  private uncCwd(cwd?: string): string {
    const base = cwd ?? this.executionCwd.getStore() ?? this.config.cwd
    if (base === undefined || base === '') {
      throw new FsError('wsl-fs: no cwd and no configured base for relative resolution', 'FS_IO_ERROR')
    }
    const unc = parseWslUnc(base)
    if (unc !== null) return joinUnc(unc.distro, unc.linuxPath)
    if (isAbsoluteLinuxPath(base)) return joinUnc(this.distroFor(base), base)
    if (windowsToMntPath(base) !== null) return base
    throw new FsError(`wsl-fs: cwd "${base}" is not in the WSL execution world`, 'FS_IO_ERROR')
  }

  /**
   * Resolve the distribution an absolute Linux path opens inside. The chain:
   * the caller cwd when it is a WSL UNC path, then the current tool
   * execution's session cwd, then the configured `distro`,
   * then the host's default distribution from the Lxss registry. The registry
   * fallback is reserved for calls that genuinely have no session.
   */
  private distroFor(cwd?: string): string {
    const fromCwd = parseWslUnc(cwd ?? '')
    if (fromCwd !== null) return fromCwd.distro
    const fromExecution = parseWslUnc(this.executionCwd.getStore() ?? '')
    if (fromExecution !== null) return fromExecution.distro
    const distro = this.distro
    if (distro !== undefined && distro !== '') return distro
    const fallback = defaultDistroSync()
    if (fallback !== undefined) return fallback
    throw new FsError('wsl-fs: Linux path carries no distribution and none is configured', 'FS_IO_ERROR')
  }

  /** The Linux display path for a resolved Windows-side path. */
  private linuxDisplay(raw: string): string {
    const unc = parseWslUnc(raw)
    if (unc !== null) return unc.linuxPath
    const mnt = windowsToMntPath(raw)
    if (mnt !== null) return mnt
    throw new FsError(`wsl-fs: resolved path "${raw}" is outside the WSL execution world`, 'FS_IO_ERROR')
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const { input, cwd } = this.translate(path, opts?.cwd)
    const resolved = { cwd, ...opts?.signal !== undefined ? { signal: opts.signal } : {} }
    let local: FsTarget
    try {
      local = await super.resolve(input, resolved)
    } catch (error) {
      const real = await this.linkAwarePath(input, input)
      if (real === undefined) throw error
      return this.wslTarget(await super.resolve(real, resolved))
    }
    // The share resolves a link path to a *lexical* identity: `lstat` on a
    // Linux symlink fails, so the local resolver hands back the deepest
    // existing ancestor plus the remaining segments. Ask the distribution
    // before accepting that identity, or a link would be treated as a plain
    // missing file (and a write through it would escape the policy).
    const real = await this.linkAwarePath(input, String(local.targetKey))
    if (real === undefined) return this.wslTarget(local)
    return this.wslTarget(await super.resolve(real, resolved))
  }

  /** Wrap a locally resolved target in this world's Linux-facing identity. */
  private wslTarget(local: FsTarget): FsTarget {
    return { targetKey: local.targetKey, displayPath: this.linuxDisplay(String(local.displayPath)) }
  }

  /**
   * The real path a link-aware lookup must use, or `undefined` when the input
   * needs no help. Only a path this share cannot already describe pays for a
   * `wsl.exe` lookup: an existing file or directory resolves directly, while a
   * symlink (in the final segment or anywhere above it), a dangling target and
   * a not-yet-created file all ask the distribution, which answers with the
   * same path when nothing was linked.
   * @param input - the translated input or resolved identity to inspect.
   * @param targetKey - the identity the local resolver produced.
   * @returns the distribution's real path when it differs, else `undefined`.
   */
  private async linkAwarePath(input: string, targetKey: string): Promise<string | undefined> {
    const unc = parseWslUnc(targetKey) ?? parseWslUnc(input)
    if (unc === null) return undefined
    const asSpelled = joinUnc(unc.distro, unc.linuxPath)
    if (await this.describable(targetKey)) return undefined
    const real = await resolveLinuxSymlink(asSpelled)
    if (real === undefined) return undefined
    return real.toLowerCase() === asSpelled.toLowerCase() ? undefined : real
  }

  /** Whether this share can describe a Windows-side identity at all. */
  private async describable(winPath: string): Promise<boolean> {
    return await super.lstat(winPath, {}).catch(() => undefined) !== undefined
  }

  /**
   * The host file-effect policy for this call: the tool layer's per-call value
   * when it passes one, else the service's own resolution. `undefined` means
   * the deployment mounts no policy at all — the same state as a host
   * filesystem without `fs-sandbox`, so nothing is fenced.
   */
  protected sandboxPolicy(perCall?: SandboxPolicyLike): SandboxPolicyLike | undefined {
    if (isSandboxPolicy(perCall)) return perCall
    const service = this.sandboxPolicyService()
    if (service === undefined) return undefined
    try {
      const policy = service.resolve()
      return isSandboxPolicy(policy) ? policy : undefined
    } catch {
      // A policy that cannot resolve (no session in scope) fences nothing.
      return undefined
    }
  }

  /** The policy service this backend reads, when the deployment mounts one. */
  private sandboxPolicyService(): SandboxPolicyFace | undefined {
    const service = this.ctx.get('sandboxPolicy') as SandboxPolicyFace | undefined
    return service !== undefined && typeof service.resolve === 'function' ? service : undefined
  }

  /**
   * The deployment's default sandbox mode — the capability fact the file tool
   * reads to advertise escalation, mirrored from `SandboxedFileSystem`.
   */
  override get sandboxMode(): SandboxMode | undefined {
    const mode = this.sandboxPolicyService()?.defaultMode
    return typeof mode === 'string' ? mode : undefined
  }

  /**
   * Fence a mutation by the policy, then hand back the EXACT target to mutate
   * (no check-here-write-there): `read-only` denies, `workspace-write`
   * re-resolves and requires containment under a writable root, and
   * `danger-full-access` passes through. Mirrors
   * `@deepseek-ai/dsh-fs-sandbox`'s `checkedTarget`, including the
   * `FS_SANDBOX_DENIED` code the tool layer renders as a denial.
   * @param target - the resolved target about to be written.
   * @param perCall - the tool layer's per-call policy, when it passes one.
   * @returns the target the mutation must use.
   */
  private async checkedTarget(target: FsTarget, perCall?: SandboxPolicyLike): Promise<FsTarget> {
    const policy = this.sandboxPolicy(perCall)
    if (policy === undefined || policy.mode === 'danger-full-access') return target
    if (policy.mode === 'read-only') {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (policy.mode !== 'workspace-write') return target
    const fresh = await this.resolve(target.displayPath)
    for (const root of this.writableRoots(policy)) {
      if (this.underRoot(String(fresh.targetKey), root)) return fresh
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      'FS_SANDBOX_DENIED',
    )
  }

  /**
   * The roots a write may land under: the host's rule verbatim
   * (`writableRoots`: the workspace root plus the platform temp areas) plus,
   * in a WSL session, the distribution's own `/tmp` — the temp area of the
   * world this session actually runs in, which the host-side rule cannot name.
   * @param policy - the resolved policy.
   */
  private writableRoots(policy: SandboxPolicyLike): string[] {
    const roots = writableRoots(policy as Parameters<typeof writableRoots>[0]) as string[]
    const workspace = policy.workspaceRoot
    const unc = workspace === undefined ? null : parseWslUnc(workspace)
    if (unc !== null) roots.push(joinUnc(unc.distro, '/tmp'))
    return roots
  }

  /** Whether a canonical target key is a writable root or sits below one. */
  private underRoot(targetKey: string, root: string): boolean {
    const key = trimTrailing(canonicalPath(targetKey)).toLowerCase()
    const base = trimTrailing(canonicalPath(root)).toLowerCase()
    if (base === '' || base === '/' || key === base) return key === base
    return key.startsWith(base.endsWith('/') || base.endsWith('\\') ? base : `${base}\\`)
      || key.startsWith(`${base}/`)
  }

  /** Fence a full-content write by the policy, then delegate to the parent. */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicyLike,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /** Fence an edit by the policy, then delegate to the parent. */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicyLike,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  override processPath(target: FsTarget): string {
    const key = String(target.targetKey)
    const unc = parseWslUnc(key)
    if (unc !== null) return unc.linuxPath
    const mnt = windowsToMntPath(key)
    if (mnt !== null) return mnt
    throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, 'FS_IO_ERROR')
  }

  override fileUrl(target: FsTarget): string {
    const linux = this.processPath(target)
    const encoded = linux.split('/').map(encodeURIComponent).join('/')
    return `file://${encoded}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentWorld = this.worldPath(parent)
    const childWorld = this.worldPath(child)
    if (parentWorld.distro !== childWorld.distro) return false
    const parentPath = parentWorld.linuxPath
    const childPath = childWorld.linuxPath
    if (childPath === parentPath) return true
    return parentPath === '/' ? true : childPath.startsWith(`${parentPath}/`)
  }

  /** One target's (distro, linuxPath) pair for containment; `undefined` distro = Windows world. */
  private worldPath(target: FsTarget): { distro: string | undefined; linuxPath: string } {
    const key = String(target.targetKey)
    const unc = parseWslUnc(key)
    if (unc !== null) return { distro: unc.distro, linuxPath: unc.linuxPath }
    const mnt = windowsToMntPath(key)
    if (mnt !== null) return { distro: undefined, linuxPath: mnt }
    throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, 'FS_IO_ERROR')
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const { input, cwd } = this.translate(path, opts?.cwd)
    const info = await super.lstat(input, { cwd }, signal).catch(() => undefined)
    if (info !== undefined) return info
    // Same substrate limit as `resolve`: a link path must describe its target,
    // because the share cannot describe the link itself.
    const real = await this.linkAwarePath(input, input)
    if (real === undefined) return info
    return super.lstat(real, { cwd }, signal)
  }
}

/** Whether a value is a usable file-effect policy. */
function isSandboxPolicy(value: SandboxPolicyLike | undefined): value is SandboxPolicyLike {
  return value !== undefined && typeof value.mode === 'string' && value.mode !== ''
}

/** Strip a trailing separator (keeping the root separator itself). */
function trimTrailing(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

export default WslFileSystem
