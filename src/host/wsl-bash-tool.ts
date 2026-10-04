/**
 * The WSL world's `bash` tool, backed by a pipe-driven persistent shell.
 *
 * The model-facing contract is deliberately the host one-shot tool's: same `bash` name, same
 * `command`/`description`/`workdir`/`timeoutMs` parameters, same `{kind:'foreground', …}` output and
 * the same marker text (`[exit code: N]`, `[timed out after Nms]`, `[killed by signal: X]`). That is
 * not cosmetic. The session trace renders a call by tool name, and a `bash` call whose arguments
 * carry no `description` is classified as the persistent-shell variant and takes a different
 * rendering path — so matching the shape is what makes this tool indistinguishable from the one it
 * replaces.
 *
 * What differs is everything under the call. The host's persistent tool asks a terminal emulator
 * whether a sentinel line appeared, and issue #51 is what happens when the shell repaints that
 * line: three calls hung 303.8 s each in one real Desktop session before the host wiped the shell.
 * This tool asks a pipe for a record carrying this call's nonce.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'

import { isValidWslUsername, parseWslUnc, windowsToMntPath } from '../shared/paths.ts'
import { defaultDistroSync } from '../shared/wsl.ts'
import { bridgeEnv } from '../shared/wsl-env.ts'
import { SESSION_ARGV } from './wsl-bash-protocol.ts'
import { WslBashSession, type WslBashRun, type WslBashSessionSpec, type WslBashSpawnHost } from './wsl-bash-session.ts'
import { startBackgroundJob } from './wsl-jobs.ts'
import { needsTty, normaliseTtyOutput, wrapForTty } from './wsl-bash-tty.ts'

/** The tool name — the same one the host's tools register, so only one may be mounted. */
export const TOOL_NAME = 'bash'

/** Plugin config. */
export interface Config {
  /** Default per-call deadline in milliseconds. */
  timeoutMs?: number
  /** Ceiling a call may ask for. */
  maxTimeoutMs?: number
  /** Per-stream cap before the tail is kept and `truncated` is set. */
  maxOutputBytes?: number
  /** SIGTERM→SIGKILL grace for the child. */
  graceMs?: number
  /** How long the shell may take to come up, including its bootstrap. */
  bootTimeoutMs?: number
  /** Distribution; empty means resolve from the session path, then `DSH_WSL_DISTRO`, then default. */
  distro?: string
  /** Linux user; empty means the stored workspace user, then `DSH_WSL_USER`, then the default. */
  username?: string
}

/**
 * The defaults as data as well as schema fields: a world row mounted without a `config:` block gets
 * an undefined config, and schemastery's defaults are not applied on that path.
 */
const DEFAULTS: Required<Pick<Config, 'timeoutMs' | 'maxTimeoutMs' | 'maxOutputBytes' | 'graceMs' | 'bootTimeoutMs'>> = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 256 * 1024,
  graceMs: 3_000,
  bootTimeoutMs: 20_000,
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULTS.timeoutMs),
  maxTimeoutMs: z.number().default(DEFAULTS.maxTimeoutMs),
  maxOutputBytes: z.number().default(DEFAULTS.maxOutputBytes),
  graceMs: z.number().default(DEFAULTS.graceMs),
  bootTimeoutMs: z.number().default(DEFAULTS.bootTimeoutMs),
  distro: z.string().default(''),
  username: z.string().default(''),
})

/** A config with every numeric knob resolved; empty strings mean "not set". */
type ResolvedConfig = typeof DEFAULTS & Config

/** The defaults as a resolved config, for callers that build a spec before a plugin row exists. */
export const PROBE_CONFIG: ResolvedConfig = { ...DEFAULTS }

/**
 * Declared for readers and for a host that mounts the module object. The host's loader
 * (`cordis-plugin-loader`, `unwrapExports`) hands cordis `exports.default` — this module's bare
 * `apply` — so neither `inject` nor `Config` reaches the fiber, and `ctx.subprocess` then throws
 * `cannot get property "subprocess" without inject`. The code below therefore resolves the seam with
 * `ctx.get('subprocess')`, which bypasses the inject requirement, as the rest of this plugin does.
 */
export const inject = ['subprocess']

/** The tool-execution face this tool reads. */
interface ToolExecution {
  callId?: string
  agent?: { id?: string; session?: { id?: string; header?: { cwd?: string } } }
  signal?: AbortSignal
}

/** The arguments the model may pass. */
interface BashArgs {
  command: string
  description?: string
  workdir?: string
  timeoutMs?: number
  tty?: boolean
  run_in_background?: boolean
}

/** Environment facts that must reach the distribution. */
const BRIDGED_KEYS = ['DSH_HOME', 'DSH_SESSION_ID', 'DSH_WSL_DISTRO', 'DSH_WSL_USER', 'DSH_WSL_SESSION', 'NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER']

/** Model-friendly overrides, matching the one-shot executor's set. */
const ENV_OVERRIDES: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/** The Linux form of a session path: UNC, absolute Linux, or a Windows drive path. */
function linuxOf(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  const unc = parseWslUnc(path)
  if (unc !== null) return unc.linuxPath
  if (path.startsWith('/')) return path
  return windowsToMntPath(path) ?? undefined
}

/**
 * The Linux directory a call runs in.
 *
 * A relative `workdir` is joined onto the session's own directory, which is what the host's one-shot
 * tool does (`dsh-tool-bash`'s `resolveWorkdir`); measured there, `workdir: "docs"` becomes
 * `/home/ruler/docs` and the `cd` fails with bash's own `No such file or directory`. Translating it
 * to nothing instead would run the command somewhere the model did not ask for, silently.
 *
 * @param args - the model's arguments.
 * @param exec - the tool execution, whose agent session carries the workspace path.
 * @returns the path for the call's `cd`, or undefined to let the session stay where it is.
 */
function resolveCwd(args: BashArgs, exec: ToolExecution): string | undefined {
  if (args.workdir === undefined || args.workdir === '') return undefined
  if (args.workdir.startsWith('/') || parseWslUnc(args.workdir) !== null) return linuxOf(args.workdir)
  const base = linuxOf(exec.agent?.session?.header?.cwd)
  if (base === undefined) return linuxOf(args.workdir)
  return `${base.replace(/\/+$/, '')}/${args.workdir.replace(/^\.?\/+/, '')}`
}

/**
 * The distribution a call runs in: config, then the session path, then `DSH_WSL_USER`-style facts,
 * then the host default — the same order the one-shot executor uses.
 */
function resolveDistro(config: ResolvedConfig, headerCwd: string | undefined): string {
  if (config.distro !== undefined && config.distro !== '') return config.distro
  const unc = headerCwd === undefined ? null : parseWslUnc(headerCwd)
  if (unc !== null) return unc.distro
  const fromEnv = process.env.DSH_WSL_DISTRO
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return defaultDistroSync() ?? ''
}

/**
 * The Linux user a call runs as, or undefined for the distribution default.
 */
function resolveUser(config: ResolvedConfig): string | undefined {
  const candidates = [config.username, process.env.DSH_WSL_USER]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && isValidWslUsername(candidate)) return candidate
  }
  return undefined
}

/**
 * The host's abort shape. `dsh-tool-bash` throws `toolAborted()` on a caller cancel — a
 * `HarnessError` reading `tool call aborted` with `name` set to `AbortError` — and the trace renders
 * that as a cancelled call. Returning a result instead would put `[exit code: 1]` on a command the
 * user stopped, which reads as if their command had failed.
 */
function toolAborted(): Error {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Render one finished run the way the host's tool does, so the trace text is the same shape.
 *
 * The host's own truncation sentence is `[output truncated; full output: <path>]`
 * (`dsh-tool-bash/lib/index.js:137`), copied here verbatim because a model that has learned it in one
 * world should not have to learn a second one. Anything the session did that the model could not
 * otherwise see — a restart, a skipped section, a reaped process — is appended as its own bracketed
 * line rather than left in a log the user of Desktop cannot read.
 */
function renderRun(value: ForegroundOutput): { type: 'text'; text: string }[] {
  let body = value.stdout.text
  if (value.stdout.truncated && value.stdout.spillPath !== undefined) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[output truncated; full output: ${value.stdout.spillPath}]`
  }
  if (value.stderr.text.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr.text}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  markers.push(...value.notes)
  if (markers.length === 0) return [{ type: 'text', text: body }]
  if (!body.endsWith('\n')) body += '\n'
  return [{ type: 'text', text: body + markers.join('\n') }]
}

/** The `foreground` arm of the host tool's output union. */
interface ForegroundOutput {
  kind: 'foreground'
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
  /** What the session did on this call that the model could not otherwise see. */
  notes: string[]
}

/** The `background` arm of the host tool's output union. */
interface BackgroundOutput {
  kind: 'background'
  jobId: string
}

/** Shape a session run into the host's result contract. */
function toForeground(run: WslBashRun, timeoutMs: number, escalated: boolean): ForegroundOutput {
  const killed = run.exitCode < 0
  const notes: string[] = []
  if (run.timedOut) {
    notes.push('[the shell was restarted to recover; for work that outlives one call pass run_in_background: true, or use bash_background]')
  }
  if (run.restarted) {
    notes.push(run.skipped === undefined || run.skipped.length === 0
      ? '[the shell was restarted and its directory, exported variables, options and aliases were replayed]'
      : `[the shell was restarted; not restored: ${run.skipped.join(', ')}]`)
  }
  if (run.reaped !== undefined && run.reaped > 0) {
    notes.push(`[${run.reaped} detached process${run.reaped === 1 ? '' : 'es'} from the previous shell ${run.reaped === 1 ? 'was' : 'were'} stopped]`)
  }
  return {
    kind: 'foreground',
    exitCode: killed ? null : run.exitCode,
    signal: null,
    timedOut: run.timedOut,
    aborted: run.aborted,
    timeoutMs,
    stdout: {
      text: escalated ? normaliseTtyOutput(run.stdout) : run.stdout,
      truncated: run.truncated,
      ...(run.stdoutSpillPath === undefined ? {} : { spillPath: run.stdoutSpillPath }),
    },
    stderr: {
      text: escalated ? normaliseTtyOutput(run.stderr) : run.stderr,
      truncated: run.stderrTruncated,
      ...(run.stderrSpillPath === undefined ? {} : { spillPath: run.stderrSpillPath }),
    },
    notes,
  }
}

const STREAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    spillPath: { type: 'string' },
  },
} as const

/**
 * The session spec for one workspace path: which distribution and user, and the child's argv.
 *
 * Exported because the boot-time mount decision has to build exactly the session the tool will
 * later build — probing a different argv than the one that ships is how a readiness check can pass
 * a world that then fails every call.
 *
 * @param config - the resolved plugin configuration.
 * @param headerCwd - the session's workspace path, UNC or Linux.
 * @returns the spec, or undefined when no distribution could be resolved.
 */
export function buildSessionSpec(config: ResolvedConfig, headerCwd: string | undefined): WslBashSessionSpec | undefined {
  const distro = resolveDistro(config, headerCwd)
  if (distro === '') return undefined
  const user = resolveUser(config)
  const linuxCwd = linuxOf(headerCwd)
  // One token per session, carried by every process the shell starts. It is what lets a rebuild stop
  // the children that detached themselves from the shell without touching a process the user owns.
  const sessionToken = randomUUID()
  const prefix = ['wsl.exe', '-d', distro, ...(user === undefined ? [] : ['-u', user])]
  return {
    argv: [...prefix, ...(linuxCwd === undefined ? [] : ['--cd', linuxCwd]), '-e', 'bash', ...SESSION_ARGV],
    // The reaper runs a script of its own, so it gets the same distribution and user without the
    // session's working directory: it is not running the user's command.
    reaperArgv: [...prefix, '-e', 'bash', '-c'],
    // The child never starts inside the UNC share: spawning with a UNC cwd is a documented
    // Node/Windows edge, and `wsl.exe --cd` already decides the Linux side.
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
    env: bridgeEnv(
      {
        ...ENV_OVERRIDES,
        DSH_WSL_DISTRO: distro,
        DSH_WSL_SESSION: sessionToken,
        ...(user === undefined ? {} : { DSH_WSL_USER: user }),
      },
      BRIDGED_KEYS,
    ),
    graceMs: config.graceMs,
    bootTimeoutMs: config.bootTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    sessionToken,
  }
}

/**
 * Mount the tool.
 * @param ctx - the host context, providing `subprocess` and the tools registry.
 * @param config - plugin configuration; a row without a `config:` block mounts with none.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved: ResolvedConfig = { ...DEFAULTS, ...config === undefined ? {} : config }
  const tools = ctx.get('tools') as unknown as { register?: (tool: unknown) => (() => void) | void } | undefined
  if (tools?.register === undefined) return

  // `ctx.get` rather than `ctx.subprocess`, even though `inject` names the service: the host's
  // loader passes `exports.default ?? exports` to `ctx.plugin`, so a module-level `inject` never
  // reaches the fiber and every property access the tool made threw
  // `cannot get property "subprocess" without inject`. It passed 13/13 in a driver that mounted the
  // module object directly, and failed every call in Desktop.
  const spawnHost = (): WslBashSpawnHost => {
    const subprocess = ctx.get('subprocess') as unknown as WslBashSpawnHost['subprocess'] | undefined
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      throw new Error('wsl-bash: this host exposes no subprocess service to start a shell with')
    }
    return { subprocess }
  }

  const sessions = new Map<string, WslBashSession>()
  const cleanup = () => {
    for (const session of sessions.values()) void session.dispose()
    sessions.clear()
  }
  ctx.effect?.(() => cleanup)

  const tool = defineTool({
    name: TOOL_NAME,
    description: 'Run a bash command inside this WSL distribution. The shell is persistent: `cd`, exported variables, activated virtualenvs, aliases and shell functions survive between calls, so use absolute paths or an explicit `cd` when a call must not depend on where the last one left off. A command that reads from stdin is given /dev/null. Commands that need a real terminal (`sudo`, `ssh`, an editor) are given a pseudo-terminal of their own automatically; pass `tty: true` to force one for anything else. For work that must outlive one call pass `run_in_background: true` — it starts a tracked job (`job_output` to read, `job_kill` to stop) in a separate process, so it does not see this shell\'s `cd` or `export`.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run.' },
      description: {
        type: 'string',
        required: true,
        description: 'A short, user-facing description of what this command does.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for this call. Defaults to the session workspace; a relative path resolves against it.',
      },
      timeoutMs: { type: 'number', description: 'Per-call deadline in milliseconds.' },
      tty: {
        type: 'boolean',
        description: 'Run the command on a pseudo-terminal. Applied automatically for `sudo`, `ssh`, editors and similar; set it for a program that fails with a terminal-related error.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies, and the job runs in its own process rather than in this shell.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: STREAM_SCHEMA,
              stderr: STREAM_SCHEMA,
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args: unknown, value: ForegroundOutput | BackgroundOutput) =>
        value.kind === 'background'
          ? [{ type: 'text', text: `started background job ${value.jobId}` }]
          : renderRun(value),
    },
    presentCall: (args: BashArgs) => ({ card: 'terminal', title: args.command }),
    async execute(args: BashArgs, exec: ToolExecution) {
      const headerCwd = exec.agent?.session?.header?.cwd
      const timeoutMs = Math.min(args.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs)
      const ownerKey = exec.agent?.id ?? exec.agent?.session?.id ?? 'default'
      // `run_in_background` goes to the jobs producer — the same one `bash_background` uses, so there
      // is one registration of a background bash and one shape of job for `job_list` to read. It is
      // not the persistent shell's process, which is what the tool description says.
      if (args.run_in_background === true) {
        return {
          kind: 'background' as const,
          ...startBackgroundJob(ctx, { command: args.command, ...(args.workdir === undefined ? {} : { workdir: args.workdir }) },
            exec as unknown as Parameters<typeof startBackgroundJob>[2]),
        }
      }
      // The terminal is decided here, before the working-directory wrapper, so `script` inherits the
      // directory the call asked for.
      const escalated = args.tty === true || needsTty(args.command)
      const payload = escalated ? wrapForTty(args.command) : args.command
      // The session already starts in the workspace; an explicit `workdir` only has to move it.
      const workdir = args.workdir === undefined ? undefined : resolveCwd(args, exec)
      const command = workdir === undefined ? payload : `cd ${JSON.stringify(workdir)} && { ${payload}\n}`

      let session = sessions.get(ownerKey)
      if (session === undefined) {
        const spec = buildSessionSpec(resolved, headerCwd)
        if (spec === undefined) {
          throw new Error('wsl-bash: no WSL distribution could be resolved for this session')
        }
        session = new WslBashSession(spawnHost(), spec)
        sessions.set(ownerKey, session)
        await session.start().catch((error: unknown) => {
          sessions.delete(ownerKey)
          throw error instanceof Error ? error : new Error(String(error))
        })
      }
      const run = await session.run(command, timeoutMs, exec.signal)
      if (run.aborted) throw toolAborted()
      return toForeground(run, timeoutMs, escalated)
    },
  })

  const dispose = tools.register(tool)
  if (typeof dispose === 'function') ctx.effect?.(() => () => { dispose(); cleanup() })
}

export default apply
