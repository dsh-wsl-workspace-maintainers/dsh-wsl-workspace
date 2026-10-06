/**
 * The WSL world's keyboard door: an interactive terminal the agent can type into.
 *
 * Why it exists. The session `bash` tool runs commands over a pipe, and a pipe has
 * nobody at the keyboard: `sudo`, `ssh`, a REPL, an editor, a TUI, or anything else
 * that asks a question gets its wait diagnosed and re-run on a one-shot
 * pseudo-terminal (see `wsl-bash-starve.ts`), which is enough for a program to
 * complain about having no terminal but is not enough to answer it. Issue #51's
 * contract is that every command a person can run is reachable by the agent, so
 * the unanswered case gets a door of its own rather than a note telling the model
 * to give up.
 *
 * What it is, and what it is not. The door is the host's own PTY stack — the
 * `@deepseek-ai/dsh-terminal` registry and its `@deepseek-ai/dsh-terminal-bash`
 * backend, pointed at this plugin's relay so the shell is a real interactive bash
 * inside the distribution — driven directly through `ctx.terminals`. No new
 * terminal machinery lives here: this module is the model-facing shape over
 * `spawn`/`startSend`/`read`/`signal`/`kill`/`list`, and the equivalent of the
 * right sidebar's terminal tab, with the agent's hands on the keyboard instead of
 * a person's. The world mounts it only where the host terminal stack and the relay
 * interpreter both proved usable at boot (`src/index.ts`); the `bash` tool stays
 * the pipe-driven default, because a terminal screen is a 160-column rendering
 * with a bounded scrollback while the pipe carries every byte.
 *
 * @module dsh-wsl-workspace/host/wsl-terminal-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { joinUnc, parseWslUnc } from '../shared/paths.ts'

/** The tool name this plugin registers. */
export const TOOL_NAME = 'wsl_terminal'

/** Plugin config. */
export interface Config {
  /** Cooperative tool-call budget in milliseconds for one action. */
  timeoutMs?: number
  /**
   * How long the backend lets a session stay quiet before a send returns control
   * without having recognised a prompt. Declared here as well as in the generated
   * row so the note the model reads names the same number the backend uses.
   */
  quietMs?: number
}

/** The defaults, kept as data as well as schema fields (a row without `config:` mounts with none). */
const DEFAULTS: Required<Config> = {
  timeoutMs: 60_000,
  quietMs: 1_200,
}

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULTS.timeoutMs),
  quietMs: z.number().default(DEFAULTS.quietMs),
})

/**
 * Declared for readers and for a host that mounts the module object. The host's loader
 * hands cordis `exports.default`, so a module-level `inject` never reaches the fiber —
 * the same lesson `wsl-bash-tool.ts` recorded — and every service below is therefore
 * resolved with `ctx.get`.
 */
export const inject = ['terminals']

/** The tool-execution face this tool reads. */
interface ToolExecution {
  signal?: AbortSignal
  agent?: {
    id?: string
    session?: { header?: { cwd?: string } }
  }
}

/** The signals the host's terminal surface permits for a foreground process group. */
export type TerminalSignalName = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** Why one interactive send returned control. A copy of the host's union, on purpose. */
export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'

/** Top-level session status, as the registry reports it. */
export type TerminalStatus =
  | { kind: 'running' }
  | { kind: 'exited', exitCode: number | null, signal: string | null }

/** One owner-visible session summary. */
interface TerminalSnapshot {
  sessionId: string
  name?: string
  type: string
  pid?: number
  status: TerminalStatus
}

/** The settlement of one interactive send. */
interface TerminalSendResult {
  viewport: string
  waitReason: TerminalWaitReason
  sessionStatus: TerminalStatus
  truncated: boolean
}

/** The live handle one send returns. */
interface TerminalSendOperation {
  done: Promise<TerminalSendResult>
  readOutput(): { delta: string, truncated: boolean }
  cancel(): boolean
}

/** One bounded scrollback page. */
interface TerminalReadResult {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

/** The registry face this tool drives (a structural copy; `ctx.get` hands the real service). */
interface TerminalRegistryFace {
  spawn(owner: unknown, request: { type: string, name?: string, cwd?: string }, signal?: AbortSignal): Promise<TerminalSnapshot & { motd: string }>
  startSend(owner: unknown, id: string, request: { text: string, submit: boolean, signal?: AbortSignal }): TerminalSendOperation
  read(owner: unknown, id: string, request?: { offset?: number, count?: number }): TerminalReadResult
  signal(owner: unknown, id: string, signal: TerminalSignalName): Promise<{ delivered: true, targetPgid: number }>
  kill(owner: unknown, id: string, reason?: string): Promise<boolean>
  list(owner: unknown): TerminalSnapshot[]
}

/** The arguments the model may pass. */
interface TerminalArgs {
  action: 'open' | 'send' | 'read' | 'signal' | 'close' | 'list'
  session?: string
  text?: string
  submit?: boolean
  signal?: TerminalSignalName
  offset?: number
  count?: number
  cwd?: string
}

const SIGNALS: readonly TerminalSignalName[] = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']

/** How many screen lines a `read` returns when the caller names no count. */
const READ_LINES = 40

/**
 * The directory the backend should start the shell in.
 *
 * The backend hands this string to the PTY child (this plugin's relay) as its working
 * directory, so it has to be a path a Windows process can start in: a WSL UNC path, or a
 * Windows drive path the relay maps to `/mnt/<drive>`. A Linux path is translated through
 * the session's own distribution, which is the only place its distro is known — and when
 * the session itself is not a UNC workspace there is nothing to translate through, which
 * is said out loud rather than turned into a shell that starts somewhere else.
 * @param requested - the caller's `cwd`, if any.
 * @param sessionCwd - the session workspace path.
 * @returns the backend cwd, or undefined to let the backend use the session workspace.
 */
export function backendCwd(requested: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (requested === undefined || requested === '') return sessionCwd
  if (parseWslUnc(requested) !== null || /^[A-Za-z]:[\\/]/.test(requested)) return requested
  const unc = sessionCwd === undefined ? null : parseWslUnc(sessionCwd)
  if (unc === null) {
    throw new Error(`wsl_terminal: "${requested}" is a Linux path but this session's workspace is not a WSL UNC path, so its distribution is unknown — pass an absolute WSL path (\\\\wsl.localhost\\<distro>\\…) or a Windows drive path`)
  }
  const tail = requested.replace(/^\/+/, '')
  return joinUnc(unc.distro, requested.startsWith('/') ? requested : `${unc.linuxPath.replace(/\/+$/, '')}/${tail}`)
}

/**
 * The one session an action applies to: the named one, or the only one this agent owns.
 * @param sessions - the agent's own sessions.
 * @param requested - the caller's `session`, if any.
 * @returns the session, or undefined when none is open and none was named.
 * @throws Error naming the sessions that do exist when the request is ambiguous or unknown.
 */
export function pickSession(sessions: readonly TerminalSnapshot[], requested: string | undefined): TerminalSnapshot | undefined {
  if (requested !== undefined && requested !== '') {
    const found = sessions.find(session => session.sessionId === requested || session.name === requested)
    if (found === undefined) {
      throw new Error(sessions.length === 0
        ? `wsl_terminal: no terminal is open in this session (asked for "${requested}") — action "open" starts one`
        : `wsl_terminal: no owned terminal "${requested}"; open ones: ${sessions.map(session => session.sessionId).join(', ')}`)
    }
    return found
  }
  if (sessions.length === 0) return undefined
  if (sessions.length === 1) return sessions[0]
  throw new Error(`wsl_terminal: ${sessions.length} terminals are open and none was named — pass session: ${sessions.map(session => session.sessionId).join(', ')}`)
}

/** One line describing a session's status, for `open`/`list`/`close`. */
export function statusOf(status: TerminalStatus): string {
  if (status.kind === 'running') return 'running'
  const signal = status.signal === null || status.signal === undefined ? '' : ` on ${status.signal}`
  const code = status.exitCode === null || status.exitCode === undefined ? '' : ` (code ${status.exitCode})`
  return `exited${signal}${code}`
}

/**
 * The bracketed line that says how a send ended and what to do next.
 *
 * The distinction that matters to the caller is "the program is waiting for you" versus
 * "nothing has been written for a moment and no prompt was recognised": only the first is
 * a fact about a program, and on this platform's PTYs the host's exact foreground probe
 * reports zeros (issue #51 point 3), so the second is reported as the uncertainty it is
 * instead of being dressed up as readiness.
 * @param result - the settled send.
 * @param quietMs - the backend's quiet window, so the sentence names the real number.
 * @returns the note line, without a trailing newline.
 */
export function settleNote(result: TerminalSendResult, quietMs: number): string {
  if (result.sessionStatus.kind === 'exited') {
    return `[the shell exited: ${statusOf(result.sessionStatus)} — this terminal is gone; open a new one]`
  }
  switch (result.waitReason) {
    case 'stdin_read':
      return '[back at the prompt]'
    case 'inferred_idle':
      return `[nothing was written for ~${quietMs} ms and no shell prompt was recognised: the program may be waiting for you, or it may still be working — read again to look]`
    case 'timeout':
      return '[the door stopped waiting and the command is still running: read again to look, or run long non-interactive work with the bash tool]'
    default:
      return ''
  }
}

/** The render for one terminal action: the screen (or a line about it) plus bracketed notes. */
function compose(body: string, notes: readonly string[]): { text: string } {
  const lines: string[] = []
  if (body.length > 0) lines.push(body.replace(/\s+$/, ''))
  for (const note of notes) if (note !== '') lines.push(note)
  return { text: lines.length === 0 ? '(no output)' : lines.join('\n') }
}

/**
 * Mount the door.
 * @param ctx - plugin context; the terminal registry is looked up with `get` because the
 *   host's loader does not carry a module-level `inject` into the fiber.
 * @param config - plugin configuration; a row without a `config:` block mounts with none.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved: Required<Config> = { ...DEFAULTS, ...config === undefined ? {} : config }
  const tools = ctx.get('tools') as unknown as { register?: (tool: unknown) => unknown } | undefined
  if (tools?.register === undefined) return

  const registry = (): TerminalRegistryFace => {
    const terminals = ctx.get('terminals') as unknown as TerminalRegistryFace | undefined
    if (terminals === undefined || typeof terminals.spawn !== 'function' || typeof terminals.startSend !== 'function') {
      throw new Error('wsl_terminal: this host exposes no terminal service (the world\'s `pty` row is missing), so nothing can be typed into')
    }
    return terminals
  }

  const tool = defineTool({
    name: TOOL_NAME,
    description: 'Open an interactive terminal inside this WSL distribution and type into it. Use it for anything that needs a keyboard: a password prompt (`sudo`, `ssh`), an unknown-host fingerprint, a REPL or debugger, an editor or TUI, or a program that refuses to run without a terminal. The terminal is a real interactive bash created by the host\'s own PTY stack, the same one the right sidebar\'s terminal tab uses — but owned by this agent, so state (directory, exported variables) persists across actions until `close`. Actions: `open` starts one (returns its id and what is on the screen), `send` types text — with Enter unless `submit: false` — and returns what changed, `read` pages the retained screen, `signal` sends SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP (SIGINT is what Ctrl-C does), `close` ends it, `list` shows the open ones. Anything typed is part of this conversation\'s record, and the terminal echoes it unless the program turns echo off. There is nobody to ask for a password: if a prompt needs one, ask the user for it in your reply and do not guess. A send returns when the shell is back at a prompt or after the screen has been quiet for a moment; for long non-interactive work use the `bash` tool instead, which waits on the process rather than the screen.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['open', 'send', 'read', 'signal', 'close', 'list'],
        description: 'What to do. `open` starts a terminal; `send` types into one; `read` pages its screen; `signal` delivers a signal to its foreground process; `close` ends it; `list` reports the open ones.',
      },
      session: {
        type: 'string',
        description: 'Which terminal, as returned by `open`. May be omitted while exactly one is open; with several open it must be given.',
      },
      text: {
        type: 'string',
        description: 'For `send`: the text to type, exactly as typed (no trailing newline needed — `submit` adds Enter).',
      },
      submit: {
        type: 'boolean',
        description: 'For `send`: press Enter after the text. Default true; set false to type without running anything.',
      },
      signal: {
        type: 'string',
        enum: [...SIGNALS],
        description: 'For `signal`: which signal to deliver to the foreground process group.',
      },
      offset: {
        type: 'number',
        description: 'For `read`: how many lines back from the newest to start at. Default 0 (the newest line).',
      },
      count: {
        type: 'number',
        description: `For \`read\`: how many lines to return. Default ${READ_LINES}.`,
      },
      cwd: {
        type: 'string',
        description: 'For `open`: where the terminal starts. Defaults to the session workspace; a Linux path is resolved inside this workspace\'s distribution.',
      },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args: TerminalArgs) => ({
      card: 'terminal',
      title: args.action === 'send' ? `${TOOL_NAME} ${args.text ?? ''}` : `${TOOL_NAME} ${args.action}`,
    }),
    async execute(args: TerminalArgs, exec: ToolExecution) {
      const owner = exec.agent
      if (owner === undefined || owner.id === undefined) {
        throw new Error('wsl_terminal requires an owning agent session')
      }
      const terminals = registry()
      const action = args.action

      if (action === 'open') {
        const cwd = backendCwd(args.cwd, owner.session?.header?.cwd)
        const spawned = await terminals.spawn(owner, {
          // The door's own backend type, registered by the world row that names this plugin's
          // relay. The session `bash` tool never touches a PTY, so this type exists only here.
          type: 'wsl',
          ...cwd === undefined ? {} : { cwd },
        }, exec.signal)
        const notes = [`[terminal ${spawned.sessionId} is open — send: {action: "send", text: "…"}; Ctrl-C is signal: {action: "signal", signal: "SIGINT"}]`]
        if (spawned.motd.trim() !== '') notes.unshift(spawned.motd.trim())
        return compose('', notes)
      }

      if (action === 'list') {
        const sessions = terminals.list(owner)
        if (sessions.length === 0) return compose('', ['[no terminal is open — action "open" starts one]'])
        return compose(sessions.map(session =>
          `${session.sessionId}\t${statusOf(session.status)}${session.name === undefined ? '' : `\t${session.name}`}`).join('\n'), [])
      }

      const sessions = terminals.list(owner)
      let current = pickSession(sessions, args.session)
      // `send` is the one action that may start the terminal it types into: a model that
      // reached for the keyboard has already decided it wants one, and an extra round trip
      // is exactly the "extra workload" this door exists to remove.
      if (current === undefined && action === 'send') {
        const cwd = backendCwd(args.cwd, owner.session?.header?.cwd)
        current = await terminals.spawn(owner, { type: 'wsl', ...cwd === undefined ? {} : { cwd } }, exec.signal)
      }
      if (current === undefined) {
        throw new Error(`wsl_terminal: no terminal is open${args.session === undefined ? '' : ` as "${args.session}"`} — action "open" starts one`)
      }
      const id = current.sessionId
      // `read` still answers on a shell that exited (its last screen is the evidence of why);
      // typing into one or signalling it cannot, and the host's own error does not say so.
      if (current.status.kind === 'exited' && (action === 'send' || action === 'signal')) {
        throw new Error(`wsl_terminal: terminal ${id} has exited (${statusOf(current.status)}) — read it for its last screen, close it, or open a new one`)
      }

      switch (action) {
        case 'send': {
          if (typeof args.text !== 'string') throw new Error('wsl_terminal: `send` needs `text` (an empty string is allowed: it just waits)')
          const submit = args.submit !== false
          const operation = terminals.startSend(owner, id, {
            text: args.text,
            submit,
            ...exec.signal === undefined ? {} : { signal: exec.signal },
          })
          const result = await operation.done
          // The operation's own buffer is read exactly once: `result.viewport` is the same
          // content, and reading both would show the caller everything twice.
          const read = operation.readOutput()
          const body = read.delta.length > 0 ? read.delta : result.viewport
          const notes = [settleNote(result, resolved.quietMs)]
          if (read.truncated || result.truncated) notes.push('[earlier output was dropped from this answer; `read` pages the retained screen]')
          return compose(body, notes)
        }
        case 'read': {
          const page = terminals.read(owner, id, {
            offset: args.offset ?? 0,
            count: args.count ?? READ_LINES,
          })
          return compose(page.text, [
            `[lines ${page.lineBegin}..${page.lineEnd} of ${page.totalLines} retained (line 0 is the newest); offset pages further back]`,
            ...page.truncated ? ['[older screen content has been dropped from the retention buffer]'] : [],
          ])
        }
        case 'signal': {
          const name = args.signal
          if (name === undefined || !SIGNALS.includes(name)) {
            throw new Error(`wsl_terminal: \`signal\` needs one of ${SIGNALS.join(', ')}`)
          }
          const delivered = await terminals.signal(owner, id, name)
          return compose('', [`[${name} delivered to the foreground process group ${delivered.targetPgid}]`])
        }
        case 'close': {
          const closed = await terminals.kill(owner, id, 'closed by the agent')
          return compose('', [closed ? `[terminal ${id} closed]` : `[terminal ${id} was already closing]`])
        }
        default:
          throw new Error(`wsl_terminal: unknown action "${String(action)}"`)
      }
    },
  })

  const registered = tools.register(tool)
  if (typeof registered === 'function') {
    ctx.effect?.(() => () => {
      ;(registered as () => void)()
    })
  }
}

export default apply
