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
  ShellExecution,
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
   * {@link execute}/{@link run}/{@link start}, so those methods receive explicit
   * values. `onExpiry` is defaulted to `'kill'`; a background producer that must
   * outlive `timeoutMs` resolves it to `'none'` instead.
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
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * Execute a resolved spec and return the live handle with its foreground
   * projection. This is the seam shape the 0.2.x host calls —
   * `await (await ctx.shell.execute(ctx.shell.resolve(request))).result()` — and
   * a background caller uses the same handle's `readOutput`/`observed`/`kill`
   * without ever calling {@link ShellExecution.result}, so it never observes that
   * projection's rejection either.
   * @param spec - the resolved execution spec.
   * @returns the live execution handle.
   */
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return this.spawnExecution(spec)
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

  /**
   * Run one command in the foreground and return its settled result. Kept
   * because 0.1.x hosts and this plugin's own checks call it; on 0.2.x the host
   * goes through {@link execute}, so both faces must stay in step — which they
   * do by construction, since this is one line on top of that primitive.
   */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.spawnExecution(spec).result()
  }

  /**
   * Start one command in the background and return its live handle. The host's
   * background producers (and this plugin's `job_*` tools, via
   * `src/host/wsl-jobs.ts`) resolve their request with `onExpiry: 'none'`, which
   * is what leaves `timeoutMs` unarmed here; the deadline policy lives in the
   * spec, not in this method.
   */
  start(spec: ShellExecSpec): ShellProcess {
    return this.spawnExecution(spec)
  }

  /**
   * The seam's only primitive: translate the spec, arm the deadline the spec
   * asks for, spawn, and hand back the live handle.
   *
   * `onExpiry: 'none'` arms nothing — the caller's signal and {@link
   * ShellProcess.kill} are then the only ways to stop the command, and
   * `timeoutMs` is merely echoed into the result. Otherwise one fused deadline
   * drives both the timeout and the caller's cancellation, so
   * {@link ShellRunResult.timedOut} and `aborted` report the single first cause
   * rather than both.
   *
   * The handle's `done` never rejects: a spawn that never produced a process
   * settles as `killed` and leaves its story on the read path, while
   * {@link ShellExecution.result} rejects for exactly that infrastructure
   * failure. Nonzero exits, timeout kills, and abort kills all resolve.
   * @param spec - the resolved execution spec.
   * @returns the live execution handle, foreground-projectionable.
   */
  private spawnExecution(spec: ShellExecSpec): ShellExecution {
    const plan = this.plan(spec)
    const armed = spec.onExpiry === 'none'
      ? undefined
      : deadline(spec.signal, spec.timeoutMs, 'WSL_BASH_TIMEOUT')
    // Explicit, not `using`: the deadline outlives this method, because a
    // background handle is returned while its process is still running. It is
    // released when the process settles, and on the one path that settles
    // synchronously — a spawn that throws before producing a handle.
    const release = (): void => armed?.[Symbol.dispose]()
    let running: SubprocessHandle
    try {
      running = this.ctx.subprocess.spawn(
        this.spawnSpec(plan, spec, spec.stdoutMaxBytes, armed?.signal ?? spec.signal),
      )
    } catch (error) {
      release()
      throw error
    }
    const collected = WslShellExecutor.collected(running)

    // One branch per settlement cause, captured once so both `done` and the
    // on-demand `result()` projection read the same facts.
    type Settled =
      | { ok: true; outcome: Awaited<SubprocessHandle['done']> }
      | { ok: false; error: unknown }
    const settled: Promise<Settled> = running.done.then(
      (outcome): Settled => ({ ok: true, outcome }),
      (error: unknown): Settled => ({ ok: false, error }),
    )

    // A spawn failure produces no process output, so the subprocess service has
    // nothing to buffer; the note is delivered exactly once through the read path.
    let spawnFailure: unknown
    let failureNoted = false
    const consumeSpawnFailure = (): string => {
      if (spawnFailure === undefined || failureNoted) return ''
      failureNoted = true
      return `spawn failed: ${String(spawnFailure)}`
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    let resultPromise: Promise<ShellRunResult> | undefined
    const execution: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: settled.then((settledValue) => {
        release()
        if (!settledValue.ok) {
          spawnFailure = settledValue.error
          execution.status = 'killed'
          return
        }
        if (execution.status === 'running') {
          execution.status = spec.signal?.aborted === true || settledValue.outcome.signal !== null
            ? 'killed'
            : 'completed'
        }
        execution.exitCode = settledValue.outcome.exitCode
        execution.signal = settledValue.outcome.signal
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
      // Independent cursors over the same captured streams `readOutput` drains,
      // so an observer can follow a background command without stealing bytes
      // from the job tool that owns it.
      observed: { stdout: collected.stdout, stderr: collected.stderr },
      kill: (): boolean => {
        if (execution.status !== 'running') return false
        execution.status = 'killed'
        running.terminate()
        return true
      },
      result: (): Promise<ShellRunResult> => {
        if (resultPromise === undefined) {
          resultPromise = settled.then((settledValue) => {
            if (!settledValue.ok) throw settledValue.error
            // Only this executor's timeout reason counts as timedOut; outer
            // deadlines count as aborts.
            const timedOut = armed !== undefined && timeoutOf(armed.signal, 'WSL_BASH_TIMEOUT') !== undefined
            const aborted = armed?.signal.aborted === true && !timedOut
            return {
              ...settledValue.outcome,
              timedOut,
              aborted,
              timeoutMs: spec.timeoutMs,
              stdout: finalOutput(collected.stdout),
              stderr: finalOutput(collected.stderr),
            }
          })
        }
        return resultPromise
      },
    }
    return execution
  }
}

export default WslShellExecutor
