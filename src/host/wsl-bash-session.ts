/**
 * A long-lived WSL `bash`, driven over pipes.
 *
 * This replaces the arrangement that produced issue #51 point 3: the host's persistent bash tool
 * decides "the command finished" by matching bytes in a terminal the shell is allowed to repaint,
 * and an interactive Linux shell repaints with `ESC[<n>X`, which leaves spaces after the sentinel
 * and hangs the call until its 300 s deadline. Here there is no terminal in the loop at all —
 * completion is a NUL-delimited record carrying a per-command nonce, read straight off the child's
 * stdout.
 *
 * What is kept is the part the persistent shell exists for: one process, so `cd`, exported
 * variables, activated virtualenvs and shell functions survive between calls. What is added is a
 * way to survive a command that never returns. Every frame also reports the shell's working
 * directory and exported environment, so when a call is killed on its deadline the session can be
 * rebuilt and the *next* call sees the state the wedged one left behind — the failure mode the host
 * handles by wiping the shell and telling nobody.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-session
 */

import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

import { BOOTSTRAP_COMMAND, dropProtocolEcho, encodeFrame, readFrame, stripRecords } from './wsl-bash-protocol.ts'

/** How often the reader looks for a frame's records, in milliseconds. */
const POLL_MS = 20

/** Everything the session needs to start a child and keep one alive. */
export interface WslBashSessionSpec {
  /** `wsl.exe` plus the distribution, user and `bash --norc -i`. */
  argv: readonly string[]
  /** Windows-side working directory for the child. Never the UNC session path. */
  cwd: string
  /** Explicit child environment, `WSLENV` already merged. */
  env: Record<string, string>
  /** SIGTERM→SIGKILL grace handed to the subprocess seam. */
  graceMs: number
  /** How long the bootstrap may take before the session counts as unusable. */
  bootTimeoutMs: number
  /** Per-stream cap; overflow keeps the tail and says so. */
  maxOutputBytes: number
}

/** One command's outcome, in the shape the tool layer renders. */
export interface WslBashRun {
  stdout: string
  stderr: string
  exitCode: number
  /** True when the deadline killed the command. */
  timedOut: boolean
  /** True when the caller's own signal ended it. */
  aborted: boolean
  /** True when the session had to be rebuilt to recover from this call. */
  restarted: boolean
  /** True when stdout was longer than `maxOutputBytes`. */
  truncated: boolean
}

/** The seam a session needs: enough of the host context to spawn a child. */
export interface WslBashSpawnHost {
  subprocess: {
    spawn(spec: unknown): SubprocessHandle
  }
}

/**
 * One agent's persistent WSL shell.
 *
 * Commands are serialised: the protocol has one frame in flight, and a second writer would make
 * the first frame's records ambiguous.
 */
export class WslBashSession {
  private readonly ctx: WslBashSpawnHost
  private readonly spec: WslBashSessionSpec
  private handle: SubprocessHandle | undefined
  private exited = false
  private out = Buffer.alloc(0)
  private outTruncated = false
  private err = Buffer.alloc(0)
  private journal = ''
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(ctx: WslBashSpawnHost, spec: WslBashSessionSpec) {
    this.ctx = ctx
    this.spec = spec
  }

  /** Start the child and run the bootstrap. Safe to call once, before any command. */
  async start(): Promise<void> {
    await this.spawn()
    const boot = await this.execute(BOOTSTRAP_COMMAND, this.spec.bootTimeoutMs, undefined)
    if (!boot.settled) {
      await this.kill()
      throw new Error('wsl-bash: the persistent shell did not finish its bootstrap within its deadline')
    }
  }

  /**
   * Run one command, recovering transparently if it wedges the shell.
   * @param command - the model's command, verbatim.
   * @param timeoutMs - this call's deadline.
   * @param signal - the caller's abort signal, if any.
   * @returns the outcome, with `restarted` set when the session had to be rebuilt.
   */
  async run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<WslBashRun> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (this.disposed) throw new Error('wsl-bash: the session is closed')
      const first = await this.execute(command, timeoutMs, signal)
      if (first.settled) return first.run
      // The frame went out and no record came back. Two different worlds, and the difference that
      // matters is whether the command may have run. A dead child cannot still hold the shell, so
      // replaying there is safe and keeps a crash transparent. A live one may be mid-command, and a
      // command that merely exceeded its deadline must not be executed a second time — `git commit`,
      // `curl -X POST`, `rm`. So rebuild either way, which kills whatever is wedged and stops the
      // *next* call queueing behind it, and re-execute only when the child was already gone.
      const childGone = this.exited
      await this.rebuild()
      if (!childGone || signal?.aborted === true) return { ...first.run, restarted: true }
      const second = await this.execute(command, timeoutMs, signal)
      return { ...second.run, restarted: true }
    } finally {
      release()
    }
  }

  /** Take the shell down and stop recovering. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.kill()
  }

  /** Spawn the child and attach the readers that feed the protocol. */
  private async spawn(): Promise<void> {
    this.out = Buffer.alloc(0)
    this.err = Buffer.alloc(0)
    this.outTruncated = false
    this.exited = false
    const handle = this.ctx.subprocess.spawn({
      argv: [...this.spec.argv],
      cwd: this.spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.spec.graceMs,
      env: this.spec.env,
    })
    this.handle = handle
    handle.stdout?.on('data', (chunk: Buffer) => {
      this.out = Buffer.concat([this.out, chunk])
      const cap = this.spec.maxOutputBytes * 2
      if (this.out.length > cap) {
        // The record we are waiting for is at the END of the stream, so the head is what goes.
        this.out = this.out.subarray(this.out.length - cap)
        this.outTruncated = true
      }
    })
    handle.stderr?.on('data', (chunk: Buffer) => {
      this.err = Buffer.concat([this.err, chunk])
      const cap = this.spec.maxOutputBytes * 2
      if (this.err.length > cap) {
        // Drop from the start up to the next line boundary: a frame's echo must never reach the
        // reader as two half-lines, because the half that carries the payload is the only half the
        // filter can recognise.
        const from = this.err.length - this.spec.maxOutputBytes
        const boundary = this.err.indexOf(0x0a, from < 0 ? 0 : from)
        this.err = boundary < 0 ? this.err.subarray(this.err.length - cap) : this.err.subarray(boundary + 1)
      }
    })
    void handle.done.then(
      () => { this.exited = true },
      () => { this.exited = true },
    )
  }

  /**
   * Write one frame and wait for its records.
   * @returns the run, plus whether the shell answered at all.
   */
  private async execute(command: string, timeoutMs: number, signal: AbortSignal | undefined):
    Promise<{ run: WslBashRun; settled: boolean }> {
    const handle = this.handle
    const stdin = handle?.stdin
    if (handle === undefined || stdin === undefined) {
      throw new Error('wsl-bash: the session has no stdin to write to')
    }
    const frame = encodeFrame(command)
    const armed = deadline(signal, timeoutMs, 'WSL_BASH_TIMEOUT')
    stdin.write(frame.line)
    for (;;) {
      const found = readFrame(this.out, frame.nonce)
      if (found !== undefined) {
        const stdout = stripRecords(this.out.subarray(0, found.recordStart)).toString('utf8')
        const stderr = this.takeStderr(frame.payload)
        const truncated = this.outTruncated
        // Consume this window so the next command reads from a fresh buffer.
        this.out = this.out.subarray(found.nextOffset)
        this.outTruncated = false
        this.journal = found.state
        armed[Symbol.dispose]()
        return {
          settled: true,
          run: { stdout, stderr, exitCode: found.status, timedOut: false, aborted: false, restarted: false, truncated },
        }
      }
      const caused = armed.signal.aborted
      if (caused || this.exited) {
        armed[Symbol.dispose]()
        const timedOut = timeoutOf(armed.signal, 'WSL_BASH_TIMEOUT') !== undefined
        return {
          settled: false,
          run: {
            stdout: stripRecords(this.out).toString('utf8'),
            stderr: this.takeStderr(frame.payload),
            exitCode: timedOut ? -1 : 1,
            timedOut,
            aborted: !timedOut,
            restarted: false,
            truncated: this.outTruncated,
          },
        }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  }

  /**
   * Hand out the stderr that has completed a line since the last call, keeping any unterminated
   * tail for the next one.
   *
   * The shell echoes each frame line to stderr, and the pipe can deliver that echo in pieces, so a
   * window cut at a byte offset can start in the middle of an echo — and the half without the
   * payload in it is unrecognisable as protocol. That is how every real Desktop call came back
   * with a fragment of its own framing in `[stderr]`. Cutting at line boundaries instead means the
   * filter always sees a whole echo line, whose tags identify it whatever frame wrote it.
   *
   * @param payload - the frame in flight's payload, for the case where the echo is one line.
   * @returns the completed, filtered stderr for this call.
   */
  private takeStderr(payload: string): string {
    const boundary = this.err.lastIndexOf(0x0a)
    if (boundary < 0) return ''
    const window = this.err.subarray(0, boundary + 1).toString('utf8')
    this.err = this.err.subarray(boundary + 1)
    return dropProtocolEcho(window, payload)
  }

  /** Kill the wedged child and bring back one that knows where we left off. */
  private async rebuild(): Promise<void> {
    const journal = this.journal
    await this.kill()
    await this.spawn()
    const lines = journal.split('\n').filter(line =>
      line.startsWith('declare -x ') || line.startsWith('PWD='))
    const pwd = lines.find(line => line.startsWith('PWD='))?.slice(4)
    const restore = [
      ...lines.filter(line => !line.startsWith('PWD=')),
      ...(pwd === undefined || pwd === '' ? [] : [`cd ${JSON.stringify(pwd)} 2>/dev/null || true`]),
      BOOTSTRAP_COMMAND,
    ]
    await this.execute(restore.join('\n'), this.spec.bootTimeoutMs, undefined)
  }

  /** Terminate the current child, if any, and wait for the seam to report it gone. */
  private async kill(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (handle === undefined) return
    handle.terminate()
    await handle.done.catch(() => undefined)
  }
}

/** What a boot-time readiness probe concluded. */
export interface WslBashProbeResult {
  ready: boolean
  detail: string
}

/**
 * Start a session, run one computed command through it, and take it down again.
 *
 * This is the question the mount decision actually needs answered: not "can a child be spawned"
 * but "does a command come back". The host's own PTY probe could pass a world in which every call
 * hung, which is exactly how issue #51 reached a user, so the probe here drives the same protocol
 * the tool will use and requires the computed answer rather than any recognizable text.
 *
 * @param host - the subprocess seam.
 * @param spec - the session spec the world would mount.
 * @param budgetMs - the ceiling for boot plus one command.
 * @returns whether the session is usable, with the reading that decided it.
 */
export async function probeWslBashSession(
  host: WslBashSpawnHost,
  spec: WslBashSessionSpec,
  budgetMs = 20_000,
): Promise<WslBashProbeResult> {
  const seed = Math.floor(Math.random() * 900) + 100
  const expected = `dshwslbash${seed * 2}`
  const session = new WslBashSession(host, spec)
  const started = Date.now()
  try {
    await session.start()
    const run = await session.run(`echo dshwslbash$(( ${seed} * 2 ))`, Math.max(1_000, budgetMs - (Date.now() - started)))
    if (run.stdout.includes(expected)) {
      return { ready: true, detail: `session came up and round-tripped a computed command in ${Date.now() - started}ms` }
    }
    return { ready: false, detail: `the session answered but not with the computed value (stdout ${JSON.stringify(run.stdout.slice(0, 80))})` }
  } catch (error) {
    return { ready: false, detail: `the session did not come up: ${String(error instanceof Error ? error.message : error).slice(0, 160)}` }
  } finally {
    await session.dispose().catch(() => undefined)
  }
}
