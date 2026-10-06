/**
 * The record protocol between this plugin and a long-lived WSL `bash`.
 *
 * The host's persistent bash tool decides "the command finished" by scraping the terminal for a
 * sentinel line and requiring the exit-code digits to be followed immediately by a newline. That is
 * a byte-exact comparison against a surface the terminal is allowed to repaint: an interactive Linux
 * shell redraws its prompt line, the emulator leaves the erased cells as spaces, and the recorded line
 * arrives as `:0␠␠` so the check never fires (issue #51 point 3, measured 2026-10-04: three calls
 * hung 303.8 s, one settled in 4.2 s, and the host's own matcher reproduced 4/4 offline). The erase was
 * first attributed to readline's `ESC[<n>X`; the captured stream on disk holds no `ESC[<n>X` at all —
 * only `ESC[K`, `ESC[2J`, cursor positioning and literal spaces — so what this protocol defends
 * against is the measured shape (bytes between the digits and the newline), not a named recipe.
 *
 * This module replaces that arrangement with an event: every command ends with a record written to
 * stdout as NUL-delimited bytes carrying a per-command nonce, and the reader only completes on a
 * record whose nonce matches. No terminal, no prompt, no repaint is part of the contract.
 *
 * Why the payload travels base64-encoded: a single line is required because a piped `bash` executes
 * each line as it arrives, and the base64 alphabet contains neither `!` (which interactive history
 * expansion rewrites — the bug behind the host's own #7858/#6768) nor quotes, backslashes or
 * newlines that would need escaping to survive one more layer of quoting.
 *
 * @module dsh-wsl-workspace/host/wsl-bash-protocol
 */

import { randomUUID } from 'node:crypto'

/** The literal that opens every completion record. Never appears in a command's own output. */
export const RECORD_TAG = '__DSH_WSL_BASH_REC'

/** The literal that opens the state record which follows a completion record. */
export const STATE_TAG = '__DSH_WSL_BASH_STATE'

/** A per-command identifier. The reader completes only on a record carrying this exact value. */
export function newNonce(): string {
  return randomUUID()
}

/** One command's worth of protocol: the payload, and the nonce its record must carry. */
export interface CommandFrame {
  /** The nonce to pass to {@link findCompletion}. */
  nonce: string
  /** The exact bytes to write to the session's stdin, newline included. */
  line: string
  /** The encoded payload, which {@link dropProtocolEcho} matches stderr against. */
  payload: string
  /** The encoded stdin text, when the call brought one, for the same echo-matching purpose. */
  stdinPayload?: string
}

/** Base64 with no line wrapping, so the frame stays one line however long the command is. */
function encodePayload(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64')
}

/** The shell-state report every frame ends with: cwd, exported environment, options, aliases. */
const STATE_REPORT_BODY = [
  `printf '%s\\n' '#dsh-section exports'; export -p`,
  `printf '%s\\n' '#dsh-section pwd'; printf 'PWD=%s\\n' "$PWD"`,
  // The shell's own pid: the reader watches for a command that is waiting for a keyboard, and the
  // only way to find that command from outside is to walk this process's descendants.
  `printf '%s\\n' '#dsh-section pid'; printf 'PID=%s\\n' "$$"`,
  `printf '%s\\n' '#dsh-section aliases'; alias -p`,
  // `set +o`, not `set -o`: the former prints each option as the command that *sets* it
  // (`set -o allexport` / `set +o ignoreeof`), so the section replays verbatim; the latter prints
  // `allexport    on`, which is not a command.
  `printf '%s\\n' '#dsh-section options'; set +o`,
  `printf '%s\\n' '#dsh-section shopt'; shopt -p`,
  `printf '%s\\n' '#dsh-section functions-count'; declare -F | wc -l`,
].join('; ')

/**
 * The conditional that carries function bodies, given the count the session last saw.
 *
 * Measured on this machine, `declare -f` after the rc files is **61,083 bytes across 85 functions**.
 * Base64 on every frame would put ~81 kB through the pipe per command to repeat a snapshot that
 * almost never changes, so the shell itself compares its own function count with the one the session
 * last recorded and only emits the bodies when they differ (or when the session asks, because the
 * command text looked like a definition). A body larger than the cap is skipped with a marker rather
 * than truncated: half a function replayed is a syntax error in the restored shell.
 */
export const FUNCTION_SNAPSHOT_CAP_BYTES = 65_536

/** The section headers the state record is allowed to contain, in the order the frame writes them. */
export const STATE_SECTIONS = ['exports', 'pwd', 'pid', 'aliases', 'options', 'shopt', 'functions-count', 'functions'] as const

/**
 * The session shell's own pid, as one frame reported it.
 * @param state - the decoded state record.
 * @returns the pid, or undefined when the record did not carry one.
 */
export function shellPidOf(state: string): number | undefined {
  const line = (parseState(state).pid ?? []).find(candidate => candidate.startsWith('PID='))
  const pid = Number(line?.slice(4) ?? '')
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Build the state-report tail that follows a completion record.
 * @param functionCount - the function count the session last saw, or `undefined` to force a snapshot.
 * @returns shell text that prints the sections, and the bodies only when they changed.
 */
export function stateReport(functionCount: number | undefined): string {
  const conditional = functionCount === undefined ? '' : `; __dsh_n=$(declare -F | wc -l)`
    + `; if [ "$__dsh_n" != '${functionCount}' ]; then __dsh_s=$(declare -f | wc -c)`
    + `; printf '%s\\n' '#dsh-section functions'`
    + `; if [ "$__dsh_s" -le ${FUNCTION_SNAPSHOT_CAP_BYTES} ]; then declare -f;`
    + ` else printf '%s\\n' "#dsh-functions-skipped $__dsh_s"; fi; fi`
  return `{ ${STATE_REPORT_BODY}${conditional}; } | base64 -w0`
}

/**
 * Text that exists only inside a frame this module wrote.
 *
 * A frame's echo does not always arrive whole: measured on this machine, bash's line editor put
 * `\r` and the **last 78 bytes** of the echoed frame on stderr, starting in the middle of the nonce,
 * so neither the payload nor either record tag was in the bytes that needed recognising. Matching on
 * these instead catches the head, the tail, or the whole line.
 */
export const FRAME_SIGNATURES: readonly string[] = [RECORD_TAG, STATE_TAG, '__dsh_status', '#dsh-section']

/**
 * Build the stdin line that runs `command` and reports its exit code.
 * @param command - the user's command, verbatim, any number of lines.
 * @param functionCount - the shell's function count as last seen, or `undefined` to ask for a full
 *   function snapshot on this frame (the first frame, and any frame whose command looks like a
 *   definition).
 * @param stdin - the caller's `stdin` text, when the call brought one. It travels inside this same
 *   line (base64, like the command) and is decoded into a temporary file the command's stdin is
 *   redirected from — the pipe itself cannot carry it, because a command that reads stdin from a
 *   pipe would eat the protocol bytes that end the call. Without it the command gets `/dev/null`,
 *   which is what a model running ordinary commands wants.
 * @returns the frame to write, and the nonce its completion record must carry.
 */
export function encodeFrame(command: string, functionCount?: number, stdin?: string): CommandFrame {
  const nonce = newNonce()
  const payload = encodePayload(command)
  const stdinPayload = stdin === undefined ? undefined : encodePayload(stdin)
  // `</dev/null` on the eval: a command that reads stdin must never consume protocol bytes.
  // The state record that follows the completion record is what makes a restart transparent: it
  // carries the working directory and the exported environment of the shell that just ran.
  const input = stdinPayload === undefined
    ? { setup: '', redirect: '</dev/null' }
    : {
        // `mktemp` with a fallback, because the failure mode of a missing name is a redirect to `""`
        // and a message nobody can act on. The file is removed after the status is read, so its
        // existence never outlives the call.
        setup: `__dsh_in=$(mktemp 2>/dev/null || printf %s "/tmp/dsh-stdin-$$"); `
          + `printf %s '${stdinPayload}' | base64 -d > "$__dsh_in"; `,
        redirect: `< "$__dsh_in"`,
      }
  const line = input.setup
    + `eval "$(printf %s '${payload}' | base64 -d)" ${input.redirect}; `
    + `__dsh_status=$?; `
    + (stdinPayload === undefined ? '' : 'rm -f -- "$__dsh_in"; ')
    + `printf '\\0${RECORD_TAG}\\0%s\\0%s\\0' '${nonce}' "$__dsh_status"; `
    // One NUL byte on stderr, written after the command and after the completion record: stdout carries
    // the record while stderr carries half the answer, on two pipes with no order between them, so a
    // reader that settles on stdout can beat the command's own stderr and report a body with the stderr
    // still in flight (measured: `echo oops >&2` came back `(no output)` and those bytes landed in the
    // *next* call's window). This byte is ordered after that stderr by the writing process itself, which
    // makes "the command's stderr has all been written" an event instead of a guess about pipe timing.
    // It goes before the state report because the state report costs ~25 ms and would delay it for no
    // reason. (Written first as `… # TAG; printf …`, where bash treated it as part of the comment.)
    + `printf '\\0' >&2; `
    + `printf '\\0${STATE_TAG}\\0%s\\0%s\\0' '${nonce}' `
    // The trailing comment is not decoration. The shell's line editor writes the echo of a frame as
    // its **last ~78 bytes** (measured: `\r` then 79 bytes starting mid-nonce, terminated by a
    // newline), so the head — where the payload and the record tags are — never reaches stderr.
    // Putting a tag at the very end means every possible tail carries something recognisable.
    + `"$( ${stateReport(functionCount)} )" # ${RECORD_TAG}\n`
  return stdinPayload === undefined ? { nonce, line, payload } : { nonce, line, payload, stdinPayload }
}

/**
 * Drop the shell's own echo of a frame from the stderr destined for the model.
 *
 * An interactive `bash` whose stdin is a pipe writes the line it just read to stderr (measured on
 * this machine: `bash-5.1$ eval "$(printf %s 'ZWNoby…' | base64 -d)" …`). That is protocol, not the
 * command's output, and showing it would tell the model its own framing was part of the result — and
 * in a real Desktop session it was: every call came back with a fragment of its own frame in
 * `[stderr]`.
 *
 * Two shapes have to be caught, because the shell does not deliver the echo whole: the complete line
 * (matched by {@link FRAME_SIGNATURES}), and a **tail** cut at any offset — measured at 79 bytes,
 * starting mid-nonce. The frame ends with `# <RECORD_TAG>` for that reason, and a line ending in any
 * suffix of either tag is treated as protocol too, so no cut point can slip between the two rules.
 * Matched on our own text rather than on a prompt pattern, because the prompt is whatever the user's
 * rc file says it is.
 *
 * @param text - stderr accumulated for the command in flight, whole lines only.
 * @param payload - {@link CommandFrame.payload} of the frame currently in flight.
 * @param stdinPayload - {@link CommandFrame.stdinPayload} of that frame, when it carried one: it is
 *   part of the same echoed line, so a line containing it is protocol too.
 * @returns the same text with the echoed frames removed.
 */
export function dropProtocolEcho(text: string, payload: string, stdinPayload?: string): string {
  return text
    .split('\n')
    .filter((line) => !FRAME_SIGNATURES.some(signature => line.includes(signature))
      && !endsWithTagSuffix(line)
      && !(payload.length > 0 && line.includes(payload))
      && !(stdinPayload !== undefined && stdinPayload.length > 0 && line.includes(stdinPayload)))
    .join('\n')
}

/** Does this line end partway into one of our record tags, i.e. is it the tail of an echoed frame? */
function endsWithTagSuffix(line: string): boolean {
  const trimmed = line.trimEnd()
  return [RECORD_TAG, STATE_TAG].some(tag => [4, 8, 12, 16].some(n =>
    tag.length > n && trimmed.endsWith(tag.slice(tag.length - n))))
}

/** What one frame reported. */
export interface FrameResult {
  /** The exit code the shell reported. */
  status: number
  /** The shell's `export -p` plus its `PWD=…` line, decoded, for the restart journal. */
  state: string
  /** Byte offset where the completion record began, i.e. the end of the command's own output. */
  recordStart: number
  /** Byte offset just past the records, i.e. where the next command's output begins. */
  nextOffset: number
}

/** Read one `<tag>\0<nonce>\0<field>\0` record, or undefined if it is absent or incomplete. */
function readRecord(buffer: Buffer, tag: string, nonce: string, from: number): { value: string; start: number; next: number } | undefined {
  const head = Buffer.from(`\u0000${tag}\u0000${nonce}\u0000`, 'latin1')
  const at = buffer.indexOf(head, from)
  if (at < 0) return undefined
  const end = buffer.indexOf(0, at + head.length)
  // A record is only complete once its terminating NUL has arrived; a partial read must not settle.
  if (end < 0) return undefined
  return { value: buffer.subarray(at + head.length, end).toString('utf8'), start: at, next: end + 1 }
}

/** The exit code a frame reported, and where its own output ended. */
export interface CompletionResult {
  /** The exit code the shell reported. */
  status: number
  /** Byte offset where the completion record began, i.e. the end of the command's own output. */
  recordStart: number
  /** Byte offset just past the completion record, i.e. where the state record begins. */
  nextOffset: number
}

/**
 * Read only the completion record: exit code and where the command's own output ended.
 *
 * The state record is written by the same frame but *after* this one (the shell computes it second), and
 * it costs 5 564 bytes and ~25 ms of the distribution's own work on this machine — measured. Nothing in
 * a call's answer needs it: it exists so a *future* rebuild can replay the shell's state. Splitting the
 * two lets a call settle the moment its exit code is on the wire and leaves the state to be collected
 * between calls.
 * @param buffer - everything the session has written to stdout since it started.
 * @param nonce - the nonce of the frame in flight.
 * @param fromOffset - where the previous command's window ended.
 * @returns the status and the offsets, or undefined while the completion record is incomplete.
 */
export function readCompletion(buffer: Buffer, nonce: string, fromOffset = 0): CompletionResult | undefined {
  const completion = readRecord(buffer, RECORD_TAG, nonce, fromOffset)
  if (completion === undefined) return undefined
  if (!/^\d+$/.test(completion.value)) return undefined
  return { status: Number(completion.value), recordStart: completion.start, nextOffset: completion.next }
}

/** The shell's state as one frame reported it, and where the next command's output begins. */
export interface StateResult {
  /** The decoded `#dsh-section` report. */
  state: string
  /** Byte offset just past the state record. */
  nextOffset: number
}

/**
 * Read the state record that follows a completion record.
 * @param buffer - everything the session has written to stdout since it started.
 * @param nonce - the nonce of the frame that wrote it.
 * @param fromOffset - the completion record's `nextOffset`.
 * @returns the decoded state and where to resume, or undefined while it is incomplete.
 */
export function readStateRecord(buffer: Buffer, nonce: string, fromOffset: number): StateResult | undefined {
  const state = readRecord(buffer, STATE_TAG, nonce, fromOffset)
  if (state === undefined) return undefined
  try {
    return { state: Buffer.from(state.value, 'base64').toString('utf8'), nextOffset: state.next }
  } catch {
    return undefined
  }
}

/**
 * Read the completion and state records a frame writes, in that order.
 * @param buffer - everything the session has written to stdout since it started.
 * @param nonce - the nonce of the frame currently in flight.
 * @param fromOffset - where the previous command's window ended.
 * @returns the exit code, the shell's state, and where to resume; undefined while still running.
 */
export function readFrame(buffer: Buffer, nonce: string, fromOffset = 0): FrameResult | undefined {
  const completion = readCompletion(buffer, nonce, fromOffset)
  if (completion === undefined) return undefined
  const state = readStateRecord(buffer, nonce, completion.nextOffset)
  if (state === undefined) return undefined
  return { status: completion.status, state: state.state, recordStart: completion.recordStart, nextOffset: state.nextOffset }
}

/**
 * Remove our records from bytes destined for the model, leaving the command's own output intact.
 * @param buffer - raw stdout for one command's window.
 * @returns the same stream with every completion and state record spliced out.
 */
export function stripRecords(buffer: Buffer): Buffer {
  return [RECORD_TAG, STATE_TAG].reduce(stripOneTag, buffer)
}

/** Splice out every `<\0tag\0…\0…\0>` record; each carries a nonce field and a value field. */
function stripOneTag(buffer: Buffer, tag: string): Buffer {
  const head = Buffer.from(`\u0000${tag}\u0000`, 'latin1')
  const parts: Buffer[] = []
  let cursor = 0
  for (;;) {
    const at = buffer.indexOf(head, cursor)
    if (at < 0) {
      parts.push(buffer.subarray(cursor))
      break
    }
    parts.push(buffer.subarray(cursor, at))
    // Two NUL-delimited fields follow the head (nonce, value). Skipping one of them leaves the
    // exit code, or the whole base64 environment dump, in the text the model reads.
    let end = at + head.length
    for (let field = 0; field < 2; field += 1) {
      const next = buffer.indexOf(0, end)
      if (next < 0) {
        end = buffer.length
        break
      }
      end = next + 1
    }
    cursor = end
  }
  return Buffer.concat(parts)
}

/**
 * Split one frame's state report into its sections.
 * @param state - the decoded value of a state record.
 * @returns each section's body, keyed by header name; absent sections are missing, not empty.
 */
export function parseState(state: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of state.split('\n')) {
    if (line.startsWith('#dsh-section ')) {
      current = sections[line.slice('#dsh-section '.length).trim()] = []
      continue
    }
    if (line.startsWith('#dsh-functions-skipped')) current?.push(line)
    else current?.push(line)
  }
  return sections
}

/** What {@link restoreScript} decided, so the outcome can be told to the model rather than hidden. */
export interface RestorePlan {
  /** Shell text that replays everything the session can restore, in a safe order. */
  script: string
  /** Sections deliberately not restored, each with the reason. */
  skipped: string[]
}

/**
 * Build the script that brings a rebuilt shell back to where the lost one was.
 *
 * Order matters: options and shell settings first (they change how the rest parses), then the
 * exported environment, then aliases and functions, and the `cd` last so a directory that only
 * exists because of an earlier section is still reachable.
 *
 * @param state - the decoded state record of the last settled command.
 * @returns the replay script and anything it leaves out, with reasons.
 */
export function restoreScript(state: string): RestorePlan {
  const sections = parseState(state)
  const skipped: string[] = []
  const keep = (name: string, prefixes: string[]): string[] => (sections[name] ?? [])
    .filter(line => prefixes.some(prefix => line.startsWith(prefix)))
  const options = keep('options', ['set -o ', 'set +o '])
  const shopt = keep('shopt', ['shopt -'])
  const exports = keep('exports', ['declare -x '])
  const aliases = keep('aliases', ['alias '])
  // `declare -f` output starts with the *function's own name*, not with `declare -f`, so this section
  // is taken verbatim apart from the over-cap marker.
  const functions = (sections.functions ?? []).filter(line => !line.startsWith('#dsh-'))
  const skippedMarker = (sections.functions ?? []).find(line => line.startsWith('#dsh-functions-skipped'))
  if (skippedMarker !== undefined) skipped.push(`functions (${skippedMarker.split(' ')[1]} bytes over the ${FUNCTION_SNAPSHOT_CAP_BYTES} byte cap)`)
  const pwdLine = (sections.pwd ?? []).find(line => line.startsWith('PWD='))
  const pwd = pwdLine?.slice(4)
  if (pwd === undefined || pwd === '') skipped.push('working directory (not reported)')
  const script = [
    ...options, ...shopt, ...exports, ...aliases, ...functions,
    ...(pwd === undefined || pwd === '' ? [] : [`cd ${JSON.stringify(pwd)} 2>/dev/null || true`]),
  ].join('\n')
  return { script, skipped }
}

/**
 * The chunks a rebuilt shell is brought back with, in the order they must be sent.
 *
 * One frame, not one big one: `eval` parses its whole string before running any of it, so a
 * `shopt -s extglob` on line 50 does nothing for the bash-completion function on line 1623 that needs
 * extglob to *parse* — measured as `syntax error near unexpected token '('` and exit 2, with the
 * replay silently failing and 91 rc functions coming back while the user's own did not. Each chunk is
 * its own frame, so each is parsed after the previous one has taken effect.
 *
 * The bootstrap goes first: it is the baseline the user's state sits on top of, and replaying exports
 * and aliases before it would let the rc files overwrite them.
 *
 * @param state - the decoded state record of the last settled command.
 * @returns the scripts to send, in order, and what was left out.
 */
export function restoreChunks(state: string): { chunks: string[]; skipped: string[] } {
  const plan = restoreScript(state)
  const sections = parseState(state)
  const skipped = plan.skipped
  const options = [
    ...(sections.options ?? []).filter(line => line.startsWith('set -o ') || line.startsWith('set +o ')),
    ...(sections.shopt ?? []).filter(line => line.startsWith('shopt -')),
  ].join('\n')
  const environment = [
    ...(sections.exports ?? []).filter(line => line.startsWith('declare -x ')),
    ...(sections.aliases ?? []).filter(line => line.startsWith('alias ')),
  ].join('\n')
  const functions = (sections.functions ?? []).filter(line => !line.startsWith('#dsh-')).join('\n')
  const pwdLine = (sections.pwd ?? []).find(line => line.startsWith('PWD='))
  const cd = pwdLine === undefined || pwdLine === 'PWD=' ? '' : `cd ${JSON.stringify(pwdLine.slice(4))} 2>/dev/null || true`
  return {
    chunks: [BOOTSTRAP_COMMAND, options, environment, functions, cd].filter(chunk => chunk.trim().length > 0),
    skipped,
  }
}

/**
 * The bootstrap sent once, before any command, as its own frame.
 *
 * `set +H` turns history expansion off for the session, so a `!` in a command means what the model
 * wrote. The rc files are sourced with their own output and complaints discarded: this machine's
 * `~/.bashrc` emits `not a valid identifier` on every shell and holds a token-shaped line, and
 * neither belongs anywhere a model or a transcript can see. What survives is the environment those
 * files set — PATH additions, locale, proxies — which is the part a piped non-interactive shell
 * would otherwise be missing.
 */
export const BOOTSTRAP_COMMAND = [
  'set +H',
  'shopt -s expand_aliases 2>/dev/null || true',
  'for f in /etc/profile ~/.profile /etc/bash.bashrc ~/.bashrc; do [ -r "$f" ] && . "$f" >/dev/null 2>&1; done',
  // Prompt bytes are noise here: completion is a record, and an interactive shell with a piped
  // stdin writes its prompt to stderr, where the model would read it as output.
  'PS1=',
  'cd "$PWD"',
].join('; ')

/**
 * How the session must be spawned.
 *
 * `wsl.exe -e` claims any argument beginning with `--` for itself, so `bash -i --norc` dies with
 * `bash: --: invalid option` before a shell exists (measured). Ordering the long option first is
 * what makes the argv survive the hand-off.
 */
export const SESSION_ARGV: readonly string[] = ['--norc', '-i']
