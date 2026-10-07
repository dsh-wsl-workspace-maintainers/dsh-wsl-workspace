/**
 * WSL Service Provider for the `ctx.shell` capability seam. Every command
 * runs inside one WSL distribution as `wsl.exe -d <distro> [-u <user>]
 * --cd <linux cwd> -e bash -lc <command>`, so the model-facing bash dialect
 * matches the execution world exactly — the "like direct calls" experience
 * of a WSL workspace session.
 *
 * The executor is a fresh implementation modeled on
 * `@deepseek-ai/dsh-bash-local` (same deadline fusion, bounded collect,
 * background adaptation) but does NOT register the shared `shell` settings
 * namespace: the host composition already registers it through its own
 * executor, and a second registration from a preset realm would collide.
 * Configuration rides the preset row instead.
 * @module dsh-wsl-workspace/shell
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  isWindowsPathShaped,
  isValidWslUsername,
  joinUnc,
  parseWslUnc,
  windowsToMntPath,
} from './shared/paths.ts'
import { getWorkspaceUsername } from './shared/wsl-credentials.ts'
import { defaultDistroSync } from './shared/wsl.ts'

/**
 * Model-friendly environment overrides (same set `dsh-bash-local` hardcodes):
 * disable colors, pagers, and interactive terminal features that would garble
 * tool output. These values cross into the Linux process through WSLENV.
 */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Default SIGTERM→SIGKILL grace period (matches `dsh-bash-local`). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (matches `dsh-bash-local`). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory (a WSL UNC or Linux path); per-call workdir wins. */
  cwd?: string
  /**
   * Default distribution used only when a call's workdir carries no distro
   * (UNC workdirs always do; Linux/Windows drive workdirs do not).
   */
  distro?: string
  /**
   * Linux user bash runs as when the call carries no per-workspace user
   * (`wsl.exe -u <username>`); undefined/empty = the distro default user.
   */
  username?: string
  /** The `wsl.exe` executable (absolute path or PATH name). */
  wslPath?: string
  /** Start bash as a login shell (`-lc`) so user profile PATHs (nvm, cargo…) load. */
  loginShell?: boolean
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'distro' | 'username'>> & Pick<Config, 'cwd' | 'distro' | 'username'>

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`wsl-shell: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved configuration this executor could not run with, so a
 * stored value is refused where it is written instead of failing at the next
 * command.
 * @param config - the schema-validated configuration.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableWslConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`wsl-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.distro !== undefined && resolved.distro.trim() === '') {
    throw new Error('wsl-shell: distro must be a non-empty distribution name')
  }
  if (resolved.username !== undefined && resolved.username !== '' && !isValidWslUsername(resolved.username)) {
    throw new Error('wsl-shell: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*')
  }
}

/** One translated execution plan: the Linux world coordinates plus the argv. */
interface WslPlan {
  /** Distribution the command runs in. */
  distro: string
  /** Linux working directory handed to `wsl.exe --cd`. */
  linuxCwd: string
  /** A valid Windows directory for the `wsl.exe` process itself. */
  windowsCwd: string
  /** Environment map (ENV_OVERRIDES + caller env + dshEnv) with WSLENV set. */
  env: Record<string, string>
  /** Full argv to hand to `ctx.subprocess`. */
  argv: readonly string[]
}

/**
 * WSL bash executor over the LOCAL subprocess service: `wsl.exe` is a Windows
 * executable, so the Windows-side spawn, bounded output, spill files, and
 * process-group termination are the local subprocess seam's mechanics; this
 * executor supplies the Linux-world argv, cwd translation, and WSLENV.
 */
export class WslShellExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    distro: z.string(),
    username: z.string(),
    wslPath: z.string().default('wsl.exe'),
    loginShell: z.boolean().default(true),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  private readonly resolved: ResolvedConfig

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.resolved
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const entry = config as ResolvedConfig
    assertServiceableWslConfig(entry)
    this.resolved = entry
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd`, and `timeoutMs` from `config.timeoutMs`, capped at
   * `config.maxTimeoutMs`. The tool layer calls this before
   * {@link run}/{@link start}, so those methods receive explicit values.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'wsl-shell: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * Translate a resolved spec into the Linux execution plan. Fails loud on a
   * workdir that names neither the WSL world (UNC or Linux path) nor a
   * Windows drive path (reached through `/mnt/<drive>`).
   * @param spec - the resolved execution spec.
   * @returns the translated plan, including the complete argv.
   */
  private plan(spec: ShellExecSpec): WslPlan {
    const workdir = spec.workdir
    let distro: string
    let linuxCwd: string
    let windowsCwd: string
    let username: string | undefined
    const unc = parseWslUnc(workdir)
    if (unc !== null) {
      distro = unc.distro
      linuxCwd = unc.linuxPath
      // The `wsl.exe` process itself needs a plain Windows directory: its own
      // cwd is irrelevant (`--cd` sets the Linux side), and spawning with a
      // UNC cwd is a documented Node/Windows edge. SystemRoot always exists.
      windowsCwd = process.env.SystemRoot ?? process.cwd()
      username = this.resolveUser(spec, joinUnc(unc.distro, unc.linuxPath))
    } else if (workdir.startsWith('/')) {
      distro = this.resolveDistro(spec)
      linuxCwd = workdir
      windowsCwd = process.cwd()
      username = this.resolveUser(spec, undefined)
    } else {
      const mnt = windowsToMntPath(workdir)
      if (mnt === null) {
        throw new Error(`wsl-shell: workdir "${workdir}" is not in the WSL execution world`)
      }
      distro = this.resolveDistro(spec)
      linuxCwd = mnt
      windowsCwd = workdir
      username = this.resolveUser(spec, undefined)
    }
    const env = this.withWslEnv(spec)
    // A login shell (`-lc`) loads /etc/profile + the user profile chain, and
    // several of those reset the cwd to $HOME (observed on Ubuntu 22.04 with
    // a zsh user default: `wsl.exe --cd <dir> -e bash -lc 'pwd'` prints the
    // home directory, while `-c` honors `--cd`). The model-facing cwd must
    // be the resolved workdir in both modes, so prefix an explicit `cd`
    // when the login shell runs. `cd` into a deleted directory fails the
    // command exactly like `--cd` would; the failure text is unchanged.
    const command = this.config.loginShell
      ? `cd '${linuxCwd.replace(/'/g, `'\\''`)}' && ${spec.command}`
      : spec.command
    const argv = [
      this.config.wslPath,
      '-d', distro,
      ...(username !== undefined && username !== '' ? ['-u', username] : []),
      '--cd', linuxCwd,
      '-e', 'bash',
      this.config.loginShell ? '-lc' : '-c',
      command,
    ]
    return { distro, linuxCwd, windowsCwd, env, argv }
  }

  /**
   * Resolve the distribution for a workdir that carries none. The chain:
   * the calling session's distribution (`DSH_WSL_DISTRO`, contributed by the
   * host half from the session's UNC workspace cwd — the common case for a
   * model passing a Linux `workdir`), then the configured `distro`, then the
   * host's default distribution (cached registry read) as a last resort for
   * plugin-driven calls with no session. Fails loud when every source is
   * absent rather than guessing a distro the path does not belong to.
   * @param spec - the resolved execution spec (its dshEnv carries the session fact).
   * @returns the distribution name.
   */
  private resolveDistro(spec: ShellExecSpec): string {
    const fromEnv = spec.dshEnv?.DSH_WSL_DISTRO
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    const configured = this.config.distro
    if (configured !== undefined && configured !== '') return configured
    const fallback = defaultDistroSync()
    if (fallback !== undefined) return fallback
    throw new Error(
      'wsl-shell: Linux workdir carries no distribution; no session DSH_WSL_DISTRO, distro config, '
      + 'or default distribution is available',
    )
  }

  /**
   * Resolve the Linux user bash runs as. The chain: the calling session's
   * workspace user (`DSH_WSL_USER`, contributed by the host half), then the
   * workspace's stored username when the workdir is a UNC path, then the
   * configured `username`. Absent everywhere, the distribution's default
   * user runs. Invalid values are skipped (they were validated on write;
   * the guard is defense in depth).
   * @param spec - the resolved execution spec (its dshEnv carries the session fact).
   * @param uncKey - canonical UNC key of the workdir when it is a UNC path.
   * @returns the username, or undefined for the distro default user.
   */
  private resolveUser(spec: ShellExecSpec, uncKey: string | undefined): string | undefined {
    const candidates = [
      spec.dshEnv?.DSH_WSL_USER,
      uncKey === undefined ? undefined : getWorkspaceUsername(uncKey),
      this.config.username,
    ]
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== '' && isValidWslUsername(candidate)) return candidate
    }
    return undefined
  }

  /**
   * Merge the caller env layers and inject `WSLENV` so the Windows-side
   * values reach the Linux process. Windows-path-shaped values get the `/p`
   * translation flag (they become `/mnt/<drive>/…` inside WSL); the ambient
   * `WSLENV` value is preserved and extended.
   * @param spec - the resolved execution spec.
   * @returns the explicit environment map for the spawn.
   */
  private withWslEnv(spec: ShellExecSpec): Record<string, string> {
    const env: Record<string, string> = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
    const flags: string[] = []
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === 'WSLENV') continue
      flags.push(isWindowsPathShaped(value) ? `${key}/p` : key)
    }
    const ambient = process.env.WSLENV
    const merged = [ambient, flags.join(':')].filter(part => part !== undefined && part !== '').join(':')
    env.WSLENV = merged
    return env
  }

  /** Map a plan onto a fully-specified subprocess spawn. */
  private spawnSpec(plan: WslPlan, spec: ShellExecSpec, stdoutMaxBytes: number, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: plan.argv,
      cwd: plan.windowsCwd,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: plan.env,
    }
  }

  /** The collect-mode readers this executor requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('wsl-shell: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  /** Run one command in the foreground. */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const plan = this.plan(spec)
    using d = deadline(spec.signal, spec.timeoutMs, 'WSL_BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = WslShellExecutor.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'WSL_BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr),
    }
  }

  /** Start one command in the background and return its live handle. */
  start(spec: ShellExecSpec): ShellProcess {
    const plan = this.plan(spec)
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    const running = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, this.config.maxOutputBytes, spec.signal))
    const collected = WslShellExecutor.collected(running)

    // A spawn failure produces no process output, so the subprocess service has
    // nothing to buffer; the note is delivered exactly once through the read path.
    let spawnFailureNote: string | undefined
    const consumeSpawnFailure = (): string => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }

    let stdoutOffset = 0
    let stderrOffset = 0

    /**
     * The non-consuming observers `ShellProcess.observed` is required to carry.
     *
     * `observed` is **not optional** in the host's `ShellProcess` contract, and the host spells out
     * what it is for: "Independent observers read here at their own offsets without stealing bytes
     * from `readOutput`." That is precisely what issue #56 needs — `dsh-jobs-local@0.2.x` drains a
     * job's ring through offset readers and never calls `readOutput`, so a producer that offered
     * only `readOutput` shipped an empty `job_output`. This executor offered neither, and the 0.2.x
     * registry silently got an empty ring.
     *
     * The offsets live **here** rather than being derived from `stdoutOffset`/`stderrOffset` above,
     * because those track the consuming cursor. Sharing them would make the two readers steal bytes
     * from each other: whichever ran first would advance the other's start. The host asks for
     * independence explicitly, so the cursors are independent too.
     *
     * A rejected spawn leaves the subprocess service with nothing buffered, so `readFrom` yields an
     * empty delta forever. The failure note is served as the **whole stderr stream** instead — once,
     * to whichever observer asks first — because a reader cannot be told "nothing happened, here is
     * why" any other way, and a job that never ran is exactly the case a user needs to see.
     */
    let spawnFailureObserved = false
    const readObserved = (
      which: 'stdout' | 'stderr',
      from: number,
    ): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } => {
      const reader = collected[which]
      const read = reader.readFrom(from)
      if (which === 'stderr' && read.text.length === 0 && !spawnFailureObserved) {
        const note = consumeSpawnFailure()
        if (note !== '') return { text: note, nextOffset: note.length, lossy: false }
      }
      if (which === 'stderr' && read.text.length > 0) spawnFailureObserved = true
      return read
    }

    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
      }, (error: unknown) => {
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${String(error)}`
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      observed: {
        stdout: { readFrom: from => readObserved('stdout', from) },
        stderr: { readFrom: from => readObserved('stderr', from) },
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}

export default WslShellExecutor
