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
import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BOOTSTRAP_COMMAND, dropProtocolEcho, encodeFrame, parseState, readFrame, restoreChunks, stripRecords } from './wsl-bash-protocol.ts'

/** How often the reader looks for a frame's records, in milliseconds. */
const POLL_MS = 20

/**
 * A command that defines a function or an alias, by text.
 *
 * The function snapshot is lazy (measured: 61 kB of `declare -f` after this machine's rc files), and
 * a lazy count-based trigger misses a *redefinition* — same count, different body. The textual test
 * is the cheap backstop: it only asks for one extra snapshot on the frames that define something.
 */
const DEFINITION = /(?:function\s+[\w.-]+|[\w.-]+\s*\(\s*\)\s*\{|\balias\s+\S+=)/

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
  /** Per-stream cap; overflow keeps the tail in memory and spills the whole stream to a file. */
  maxOutputBytes: number
  /** Marks every process this session starts, so a rebuild can reap exactly its own leftovers. */
  sessionToken: string
  /**
   * `wsl.exe … -e bash -c`, without the script: what {@link WslBashSession.reapDetached} runs when a
   * rebuild has to stop processes that detached themselves from the shell being replaced.
   */
  reaperArgv: readonly string[]
}

/** The function count a state record reported, or undefined when it reported none. */
function functionCountOf(state: string): number | undefined {
  const section = parseState(state)['functions-count'] ?? []
  const line = section.find(candidate => /^\d+$/.test(candidate.trim()))
  return line === undefined ? undefined : Number(line.trim())
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
  /** True when stderr overflowed its cap. */
  stderrTruncated: boolean
  /** Complete-stream files for the overflowed streams, in the host one-shot tool's shape. */
  stdoutSpillPath?: string | undefined
  stderrSpillPath?: string | undefined
  /** What a rebuild could not restore, each with its reason. */
  skipped?: string[] | undefined
  /** Detached processes this session reaped while rebuilding. */
  reaped?: number | undefined
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
  private outSpill: { path: string, fd: number } | undefined
  /** Absolute byte counts of each stream since the shell started, and how far the file has reached. */
  private outSeen = 0
  private outWritten = 0
  private err = Buffer.alloc(0)
  private errTruncated = false
  private errSpill: { path: string, fd: number } | undefined
  private errSeen = 0
  private errWritten = 0
  private journal = ''
  private functionsBody = ''
  private functionCount: number | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(ctx: WslBashSpawnHost, spec: WslBashSessionSpec) {
    this.ctx = ctx
    this.spec = spec
  }

  /** Start the child and run the bootstrap. Safe to call once, before any command. */
  async start(): Promise<void> {
    await this.spawn()
    const boot = await this.execute(BOOTSTRAP_COMMAND, this.spec.bootTimeoutMs, undefined, true)
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
      const first = await this.execute(command, timeoutMs, signal, DEFINITION.test(command))
      if (first.settled) return first.run
      // The frame went out and no record came back. Two different worlds, and the difference that
      // matters is whether the command may have run. A dead child cannot still hold the shell, so
      // replaying there is safe and keeps a crash transparent. A live one may be mid-command, and a
      // command that merely exceeded its deadline must not be executed a second time — `git commit`,
      // `curl -X POST`, `rm`. So rebuild either way, which kills whatever is wedged and stops the
      // *next* call queueing behind it, and re-execute only when the child was already gone.
      const childGone = this.exited
      const recovery = await this.rebuild()
      const recovered = { restarted: true, ...recovery }
      if (!childGone || signal?.aborted === true) return { ...first.run, ...recovered }
      const second = await this.execute(command, timeoutMs, signal, DEFINITION.test(command))
      return { ...second.run, ...recovered }
    } finally {
      release()
    }
  }

  /** Take the shell down and stop recovering. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.kill()
    this.closeSpills()
  }

  /** Spawn the child and attach the readers that feed the protocol. */
  private async spawn(): Promise<void> {
    this.out = Buffer.alloc(0)
    this.err = Buffer.alloc(0)
    this.outTruncated = false
    this.errTruncated = false
    this.outSeen = 0
    this.outWritten = 0
    this.errSeen = 0
    this.errWritten = 0
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
      this.outSeen += chunk.length
      const cap = this.spec.maxOutputBytes * 2
      if (this.out.length > cap) {
        // The record we are waiting for is at the END of the stream, so the head is what goes — and
        // "goes" means into the spill file, because a model that asked for `seq 1 200000` should not
        // lose the head of it.
        const cut = this.out.length - cap
        this.spill('stdout', this.out, cut)
        this.out = this.out.subarray(cut)
        this.outTruncated = true
      }
    })
    handle.stderr?.on('data', (chunk: Buffer) => {
      this.err = Buffer.concat([this.err, chunk])
      this.errSeen += chunk.length
      const cap = this.spec.maxOutputBytes * 2
      if (this.err.length > cap) {
        // Drop from the start up to the next line boundary: a frame's echo must never reach the
        // reader as two half-lines, because the half that carries the payload is the only half the
        // filter can recognise.
        const from = this.err.length - this.spec.maxOutputBytes
        const boundary = this.err.indexOf(0x0a, from < 0 ? 0 : from)
        const cut = boundary < 0 ? this.err.length - cap : boundary + 1
        this.spill('stderr', this.err, cut)
        this.err = this.err.subarray(cut)
        this.errTruncated = true
      }
    })
    void handle.done.then(
      () => { this.exited = true },
      () => { this.exited = true },
    )
  }

  /** Append the bytes of the current window that have not reached the stream's spill file yet. */
  private spillWindow(key: 'stdout' | 'stderr', buffer: Buffer, upto: number): void {
    const isOut = key === 'stdout'
    const target = isOut ? this.outSpill : this.errSpill
    if (target === undefined) return
    const streamStart = (isOut ? this.outSeen : this.errSeen) - buffer.length
    const written = isOut ? this.outWritten : this.errWritten
    const from = Math.max(written, streamStart)
    const to = streamStart + upto
    if (to <= from) return
    try {
      writeSync(target.fd, stripRecords(buffer.subarray(from - streamStart, upto)))
    } catch {
      // A spill failure leaves the result with `truncated` and no path, which is what the host's own
      // reader does (`Spill failures reach the plugin logger; the log line is the only trace`).
    }
    if (isOut) this.outWritten = to
    else this.errWritten = to
  }

  /** Start the file for a stream that has just overflowed, and write the bytes leaving memory. */
  private spill(key: 'stdout' | 'stderr', buffer: Buffer, cut: number): void {
    if ((key === 'stdout' ? this.outSpill : this.errSpill) === undefined) this.openSpill(key)
    this.spillWindow(key, buffer, cut)
  }

  /** Create the spill file, named the way the host's one-shot tool names its own. */
  private openSpill(key: 'stdout' | 'stderr'): { path: string, fd: number } {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
    const path = join(directory, `dsh-subprocess-${process.pid}-${key === 'stdout' ? 1 : 2}-${this.spec.sessionToken}-${key}.log`)
    const created = { path, fd: openSync(path, 'wx', 0o600) }
    if (key === 'stdout') this.outSpill = created
    else this.errSpill = created
    return created
  }

  /** Close the spill files, which is also what makes a rebuilt session stop writing into the old ones. */
  private closeSpills(): void {
    for (const record of [this.outSpill, this.errSpill]) {
      if (record === undefined) continue
      try { closeSync(record.fd) } catch { /* already gone */ }
    }
    this.outSpill = undefined
    this.errSpill = undefined
  }

  /**
   * Write one frame and wait for its records.
   * @returns the run, plus whether the shell answered at all.
   */
  private async execute(command: string, timeoutMs: number, signal: AbortSignal | undefined,
    forceFunctions = false):
    Promise<{ run: WslBashRun; settled: boolean }> {
    const handle = this.handle
    const stdin = handle?.stdin
    if (handle === undefined || stdin === undefined) {
      throw new Error('wsl-bash: the session has no stdin to write to')
    }
    // `-1` is a function count no shell can report, which is how "send the bodies whatever the
    // count" reaches the frame; `this.functionCount` asks the shell to compare and stay quiet.
    const frame = encodeFrame(command, forceFunctions ? -1 : this.functionCount)
    const armed = deadline(signal, timeoutMs, 'WSL_BASH_TIMEOUT')
    stdin.write(frame.line)
    for (;;) {
      const found = readFrame(this.out, frame.nonce)
      if (found !== undefined) {
        // The spill file also gets the bytes that never left memory, so the path the model is given
        // really is the complete stream.
        this.spillWindow('stderr', this.err, this.err.length)
        this.spillWindow('stdout', this.out, found.recordStart)
        const stdout = stripRecords(this.out.subarray(0, found.recordStart)).toString('utf8')
        const stderr = this.takeStderr(frame.payload)
        const truncated = this.outTruncated
        // Consume this window so the next command reads from a fresh buffer.
        this.out = this.out.subarray(found.nextOffset)
        this.outTruncated = false
        this.errTruncated = false
        this.journal = this.journalWithFunctions(found.state)
        this.functionCount = functionCountOf(found.state) ?? this.functionCount
        armed[Symbol.dispose]()
        return {
          settled: true,
          run: {
            stdout, stderr, exitCode: found.status, timedOut: false, aborted: false, restarted: false,
            truncated, stderrTruncated: false, ...this.spillPaths(),
          },
        }
      }
      const caused = armed.signal.aborted
      if (caused || this.exited) {
        armed[Symbol.dispose]()
        const timedOut = timeoutOf(armed.signal, 'WSL_BASH_TIMEOUT') !== undefined
        this.spillWindow('stderr', this.err, this.err.length)
        this.spillWindow('stdout', this.out, this.out.length)
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
            stderrTruncated: this.errTruncated,
            ...this.spillPaths(),
          },
        }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  }

  /** The complete-stream files, if either stream ever overflowed, in the host's field names. */
  private spillPaths(): Pick<WslBashRun, 'stdoutSpillPath' | 'stderrSpillPath'> {
    return {
      ...(this.outSpill === undefined ? {} : { stdoutSpillPath: this.outSpill.path }),
      ...(this.errSpill === undefined ? {} : { stderrSpillPath: this.errSpill.path }),
    }
  }

  /**
   * The state record of a settled frame, with the function bodies carried forward.
   *
   * The frame only pays for `declare -f` when the function count moved (measured: 61 kB of rc
   * functions), which means the *next* record has no functions section at all. Replacing the journal
   * wholesale lost them — measured: after one more command and a rebuild, 91 rc functions came back
   * and the function defined two calls earlier did not. So the bodies live in their own field and are
   * re-attached to every journal until a newer snapshot replaces them.
   */
  private journalWithFunctions(state: string): string {
    const sections = parseState(state)
    if (sections.functions !== undefined) {
      this.functionsBody = sections.functions.join('\n')
      return state
    }
    return this.functionsBody === '' ? state : `${state}\n#dsh-section functions\n${this.functionsBody}`
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

  /**
   * Kill the wedged child and bring back one that knows where we left off.
   * @returns what the replay could not restore, and how many detached processes were reaped.
   */
  private async rebuild(): Promise<{ skipped?: string[] | undefined, reaped?: number | undefined }> {
    const restore = restoreChunks(this.journal)
    await this.kill()
    this.closeSpills()
    const reaped = await this.reapDetached()
    await this.spawn()
    this.functionCount = undefined
    // Each chunk is its own frame, and only the last one pays for a function snapshot.
    for (const [index, chunk] of restore.chunks.entries()) {
      await this.execute(chunk, this.spec.bootTimeoutMs, undefined, index === restore.chunks.length - 1)
    }
    return {
      skipped: restore.skipped.length > 0 ? restore.skipped : undefined,
      reaped: reaped > 0 ? reaped : undefined,
    }
  }

  /**
   * Stop processes this session started that outlived its shell.
   *
   * Measured: killing `wsl.exe` takes its shell's ordinary children with it (0 survivors), but a
   * command that detached itself (`setsid`, `nohup … &`) survives (2/2). Left alone, every wedged
   * call would accumulate a process for the rest of the distribution's life. The reaper matches the
   * `DSH_WSL_SESSION` token this session puts in its children's environment, not a command name —
   * `pkill -f sleep` would stop a process the user started in another terminal, which is the
   * mis-kill the positive control in `bash-session-real` exists to catch.
   * @returns how many processes were stopped.
   */
  private async reapDetached(): Promise<number> {
    if (this.spec.reaperArgv.length === 0) return 0
    const script = `n=0; for p in /proc/[0-9]*; do if grep -qa 'DSH_WSL_SESSION=${this.spec.sessionToken}' "$p/environ" 2>/dev/null; then pid=${'${p#/proc/}'}; kill -9 "$pid" 2>/dev/null && n=$((n+1)); fi; done; printf 'REAPED=%s\\n' "$n"`
    const env: Record<string, string> = { ...this.spec.env }
    // The reaper must not carry the token it is looking for, or it would find itself.
    delete env.DSH_WSL_SESSION
    let text = ''
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [...this.spec.reaperArgv, script],
        cwd: this.spec.cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
        graceMs: this.spec.graceMs,
        env,
      })
      handle.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      await handle.done.catch(() => undefined)
    } catch {
      return 0
    }
    return Number(/REAPED=(\d+)/.exec(text)?.[1] ?? '0')
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
