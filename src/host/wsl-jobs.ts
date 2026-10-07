/**
 * The WSL world's tracked background jobs.
 *
 * DSH's one-shot `bash` tool is what *starts* a tracked job: `run_in_background:
 * true` calls `ctx.jobs.start(...)` around a `ctx.shell.start(...)` handle, and
 * the host's `job_list` / `job_output` / `job_kill` tools read that registry. A
 * WSL world replaces that tool with the host's *persistent* shell — whose schema
 * declares only `command` — so nothing in a WSL session produced a job. Worse,
 * the parameter schema does not forbid extra properties, so a
 * `run_in_background: true` argument was silently accepted and ignored: the
 * command ran in the foreground and `job_list` stayed empty. A real session found
 * exactly that, after this plugin's own shell description suggested the
 * parameter.
 *
 * This module restores the producer, and only the producer. The registry owns
 * identity, lifecycle, authorization and completion notices; this plugin's shell
 * provider already implements the background process handle (`start()`); the tool
 * bridges the two and nothing else.
 *
 * It is mounted only where it is needed: a world that keeps the *one-shot* bash
 * row (the platform-capability fallback) already gets `run_in_background` from
 * the host tool, so the row is omitted there.
 *
 * @module dsh-wsl-workspace/host/wsl-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** The tool name this plugin registers. */
export const TOOL_NAME = 'bash_background'

/** Plugin config. */
export interface Config {
  /** Cooperative tool-call budget in milliseconds for the *start* call itself. */
  timeoutMs?: number
}

/**
 * The defaults, kept as data as well as schema fields: a world row that mounts
 * this plugin without a `config:` block hands `apply` an *undefined* config, and
 * schemastery's defaults are not applied on that path. The `wsl-search` entry
 * learned this from a live session; this one learned it the same way, which is
 * why both read their defaults from one place.
 */
const DEFAULTS: Required<Config> = {
  timeoutMs: 15_000,
}

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULTS.timeoutMs),
})

/** Services this tool registers into (all three are read with `get`). */
export const inject = ['tools']

/** The tool-execution face this tool reads. */
interface ToolExecution {
  signal?: AbortSignal
  agent?: {
    /** The session id the jobs registry resolves to a live agent. */
    id?: string
    session?: { header?: { cwd?: string } }
  }
}

/** The `ctx.tools` face. */
interface ToolsRegistryFace {
  register(tool: unknown): void
}

/** One captured output stream, read incrementally from a byte offset. */
interface OutputReader {
  /** Return the bytes written since `fromByte`, plus the offset just past them. */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}

/** One background process handle, as this plugin's shell provider returns it. */
interface ShellProcessFace {
  readonly status: 'running' | 'completed' | 'killed'
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly done: Promise<void>
  readOutput(): { delta: string; lossy: boolean; stdoutSpillPath?: string; stderrSpillPath?: string }
  kill(): boolean
  /**
   * Per-stream readers the 0.2.x registry drains through the `output` pull
   * sources below. The 0.1.x registry instead consumes `run()`'s returned
   * `readOutput`, so both are exposed and each release reads the one it knows.
   */
  readonly observed: { stdout: OutputReader; stderr: OutputReader }
}

/** The `ctx.shell` face: resolve a request, then start it in the background. */
interface ShellFace {
  resolve(request: { command: string; workdir?: string; dshEnv?: Record<string, string> }): unknown
  start(spec: unknown): ShellProcessFace
}

/** The `ctx.jobs` face: identity and lifecycle for one produced job. */
interface JobsFace {
  /**
   * Present exactly on the releases whose `start()` takes an owner **session
   * id**, absent on the releases whose `start()` takes the agent itself — the
   * method the newer registry added to make that conversion. See
   * {@link ownerOf}.
   */
  resolveOwner?: unknown
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    /**
     * Pull-sources the 0.2.x registry drains into the job's output ring. Each
     * source's `read(from)` returns the bytes written since `from` plus the next
     * cursor; an optional `channel` keeps the stream on its own lane. The 0.1.x
     * registry ignores this and reads `run()`'s `readOutput` instead (issue #56).
     */
    output?: Array<{ channel?: string; read(from: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }>
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
      readOutput?(): string
    }
  }): unknown
}

/** The `ctx.shellEnv` face, read opportunistically like the host tool does. */
interface ShellEnvFace {
  collect(exec: unknown): Record<string, string> | undefined
}

/**
 * The `owner` entry for one job, in the shape this release's registry accepts.
 *
 * The registry changed that contract at `0.1.7-rc.1`, and the host's own
 * producers changed with it (`owner: parent` before, `owner: parent.id` after):
 *
 *  - `0.1.0-rc.7` … `0.1.5-rc.2`: `start()` takes the **agent object**. It
 *    resolves the owner with `agents.get(owner.id) !== owner` and reads
 *    `owner.ctx` for scope cleanup, so handing it a session id throws
 *    `Cannot read properties of undefined (reading 'Symbol(dsh.scope)')`.
 *  - `0.1.7-rc.1` and later: `start()` takes the **session id** and resolves it
 *    with `agents.get(id)`, so handing it the agent object throws
 *    `session "[object Object]" has no live agent` — the second error in
 *    issue #40.
 *
 * The two shapes are mutually exclusive and both mistakes fail loudly, so the
 * release has to be asked which one it wants. The discriminator is
 * `resolveOwner`, the method the newer registry added for exactly this
 * conversion: measured present on `0.1.7-rc.1`, `0.1.7-rc.2` and `0.2.0-rc.2`,
 * absent on all eight releases before them.
 * @param jobs - the jobs registry.
 * @param agent - the calling agent from the tool execution, when there is one.
 * @returns the owner entry, or nothing for unowned work.
 */
export function ownerOf(jobs: JobsFace, agent: ToolExecution['agent']): { owner?: unknown } {
  if (agent === undefined) return {}
  if (typeof jobs.resolveOwner !== 'function') return { owner: agent }
  return agent.id === undefined ? {} : { owner: agent.id }
}

/**
 * Turn one finished background process into the registry's outcome shape.
 * @param process - the settled shell process handle.
 * @returns the job outcome with a kind-specific detail line.
 */
export function outcomeOf(process: ShellProcessFace): { status: 'completed' | 'killed' | 'failed'; detail?: string } {
  const detail = process.signal !== null
    ? `signal: ${process.signal}`
    : process.exitCode !== null ? `exit code: ${process.exitCode}` : undefined
  const status = process.status === 'killed' ? 'killed' : process.status === 'completed' ? 'completed' : 'failed'
  return detail === undefined ? { status } : { status, detail }
}

/**
 * Render one consuming output read as the string the registry hands to
 * `job_output`. The delta is the payload; a lossy read and any full-stream spill
 * files are named, because the consumer cannot see them otherwise.
 * @param read - the shell provider's incremental read.
 * @returns the text for this read.
 */
export function renderRead(read: { delta: string; lossy: boolean; stdoutSpillPath?: string; stderrSpillPath?: string }): string {
  const parts = [read.delta]
  if (read.lossy) parts.push('[output truncated: unread bytes were dropped]')
  if (read.stdoutSpillPath !== undefined) parts.push(`[full stdout: ${read.stdoutSpillPath}]`)
  if (read.stderrSpillPath !== undefined) parts.push(`[full stderr: ${read.stderrSpillPath}]`)
  return parts.filter(part => part !== '').join('\n')
}

/**
 * Register the world's background-bash producer.
 *
 * The tool returns the registry's job id immediately; `job_output` reads the
 * stream and `job_kill` cancels it, exactly as for the host's one-shot tool.
 * @param ctx - plugin context; registrations are effects scoped to it.
 * @param config - plugin configuration; a row without a `config:` block mounts
 *   this plugin with none, and {@link DEFAULTS} then supplies every knob.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved: Required<Config> = { ...DEFAULTS, ...config === undefined ? {} : config }
  const tools = ctx.get('tools') as unknown as ToolsRegistryFace | undefined
  if (tools === undefined) return
  const tool = defineTool({
    name: TOOL_NAME,
    description: 'Run one command in the background inside this WSL distribution and return a job id immediately. Read its output with job_output and stop it with job_kill. The `bash` tool is a persistent shell and takes `command` only - it has no `run_in_background` parameter, so this tool is its equivalent.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The bash command to run in the background.',
      },
      workdir: {
        type: 'string',
        description: 'Linux working directory for the command. Defaults to the session workspace; a relative path resolves against it.',
      },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { jobId: string }) => [{
        type: 'text',
        text: `started background job ${value.jobId}`,
      }],
    },
    async execute(args: { command: string; workdir?: string }, exec: ToolExecution) {
      const jobs = ctx.get('jobs') as unknown as JobsFace | undefined
      if (jobs === undefined) {
        throw new Error('background jobs unavailable: this deployment mounts no jobs registry (load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs)')
      }
      const shell = ctx.get('shell') as unknown as ShellFace | undefined
      if (shell === undefined || typeof shell.start !== 'function' || typeof shell.resolve !== 'function') {
        throw new Error('background jobs unavailable: the WSL world provides no shell with background support')
      }
      if (exec.signal?.aborted === true) {
        const error = new Error('tool call aborted')
        error.name = 'AbortError'
        throw error
      }
      const shellEnv = ctx.get('shellEnv') as unknown as ShellEnvFace | undefined
      const dshEnv = typeof shellEnv?.collect === 'function' ? shellEnv.collect(exec) : undefined
      // The session workspace is the default, exactly as the persistent `bash`
      // tool's shell starts there: this plugin's shell provider falls back to its
      // own configured cwd (or the host process's), which in a WSL world is a
      // Windows directory the distribution cannot use.
      const workdir = args.workdir ?? exec.agent?.session?.header?.cwd
      const request = {
        command: args.command,
        ...workdir === undefined ? {} : { workdir },
        ...dshEnv === undefined ? {} : { dshEnv },
      }
  // The 0.2.x registry drains the job's output ring only from `spec.output`
  // pull-sources; it never touches the `readOutput` that `run()` returns. A
  // producer that set only the latter shipped an empty `job_output` on
  // 0.2.0-rc.2 (issue #56). So expose both: `output` pull-sources over the
  // process's own per-stream readers, and `readOutput` for the 0.1.x registry.
  // `proc` is captured in this outer scope because `run()` assigns it *before*
  // the registry ever calls a source's `read()` — start() invokes run()
  // synchronously, then arms the pump on later ticks.
  let proc: ShellProcessFace | undefined
  const readStream = (which: 'stdout' | 'stderr') => (from: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } => {
    const reader = proc?.observed[which]
    if (reader === undefined) return { text: '', nextOffset: from, lossy: false }
    return reader.readFrom(from)
  }
  const jobId = jobs.start({
    kind: 'bash',
    label: args.command,
    // `owner` is a session id on 0.1.7+ and the agent object before that;
    // see `ownerOf`. Getting it wrong is a loud failure either way.
    ...ownerOf(jobs, exec.agent),
    output: [
      { read: readStream('stdout') },
      { channel: 'stderr', read: readStream('stderr') },
    ],
    run: () => {
      const process = shell.start(shell.resolve(request))
      proc = process
      return {
        cancel: () => {
          process.kill()
        },
        done: process.done.then(() => outcomeOf(process)),
        readOutput: () => renderRead(process.readOutput()),
      }
    },
  })
      return { jobId: String(jobId) }
    },
    presentCall: (args: { command: string }) => ({
      card: 'generic',
      title: `Bash (background) ${args.command}`,
      kind: 'execute',
      rawInput: args.command,
    }),
  })
  tools.register(tool)
}

export default apply
