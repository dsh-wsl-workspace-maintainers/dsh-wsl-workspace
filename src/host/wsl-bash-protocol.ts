/**
 * The record protocol between this plugin and a long-lived WSL `bash`.
 *
 * The host's persistent bash tool decides "the command finished" by scraping the terminal for a
 * sentinel line and requiring the exit-code digits to be followed immediately by a newline. That is
 * a byte-exact comparison against a surface the terminal is allowed to repaint, and on WSL the
 * interactive shell's readline paints `ESC[<n>X` (fill cells with spaces) — so the recorded line
 * arrives as `:0␠␠` and the check never fires (issue #51 point 3, measured 2026-10-04: three calls
 * hung 303.8 s, one settled in 4.2 s, and the host's own matcher reproduced 4/4 offline).
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
}

/** Base64 with no line wrapping, so the frame stays one line however long the command is. */
function encodePayload(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64')
}

/** The shell-state report every frame ends with: the working directory and the exported environment. */
const STATE_REPORT = `{ export -p; printf 'PWD=%s\\n' "$PWD"; } | base64 -w0`

/**
 * Text that exists only inside a frame this module wrote.
 *
 * A frame's echo does not always arrive whole: measured on this machine, bash's line editor put
 * `\r` and the **last 78 bytes** of the echoed frame on stderr, starting in the middle of the nonce,
 * so neither the payload nor either record tag was in the bytes that needed recognising. Matching on
 * these instead catches the head, the tail, or the whole line.
 */
export const FRAME_SIGNATURES: readonly string[] = [RECORD_TAG, STATE_TAG, '__dsh_status', STATE_REPORT]

/**
 * Build the stdin line that runs `command` and reports its exit code.
 * @param command - the user's command, verbatim, any number of lines.
 * @returns the frame to write, and the nonce its completion record must carry.
 */
export function encodeFrame(command: string): CommandFrame {
  const nonce = newNonce()
  const payload = encodePayload(command)
  // `</dev/null` on the eval: a command that reads stdin must never consume protocol bytes.
  // The state record that follows the completion record is what makes a restart transparent: it
  // carries the working directory and the exported environment of the shell that just ran.
  const line = `eval "$(printf %s '${payload}' | base64 -d)" </dev/null; `
    + `__dsh_status=$?; `
    + `printf '\\0${RECORD_TAG}\\0%s\\0%s\\0' '${nonce}' "$__dsh_status"; `
    + `printf '\\0${STATE_TAG}\\0%s\\0%s\\0' '${nonce}' `
    + `"$( ${STATE_REPORT} )"\n`
  return { nonce, line, payload }
}

/**
 * Drop the shell's own echo of a frame from the stderr destined for the model.
 *
 * An interactive `bash` whose stdin is a pipe writes the line it just read to stderr (measured on
 * this machine: `bash-5.1$ eval "$(printf %s 'ZWNoby…' | base64 -d)" …`). That is protocol, not the
 * command's output, and showing it would tell the model its own framing was part of the result — and
 * in a real Desktop session it was: every call came back with a fragment of its own frame in
 * `[stderr]`. Matched on {@link FRAME_SIGNATURES} plus this frame's payload rather than on a prompt
 * pattern, because the prompt is whatever the user's rc file says it is, and because the echo can
 * arrive as the tail of a line whose head belongs to an earlier call.
 *
 * @param text - stderr accumulated for the command in flight, whole lines only.
 * @param payload - {@link CommandFrame.payload} of the frame currently in flight.
 * @returns the same text with the echoed frames removed.
 */
export function dropProtocolEcho(text: string, payload: string): string {
  return text
    .split('\n')
    .filter((line) => !FRAME_SIGNATURES.some(signature => line.includes(signature))
      && !(payload.length > 0 && line.includes(payload)))
    .join('\n')
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

/**
 * Read the completion and state records a frame writes, in that order.
 * @param buffer - everything the session has written to stdout since it started.
 * @param nonce - the nonce of the frame currently in flight.
 * @param fromOffset - where the previous command's window ended.
 * @returns the exit code, the shell's state, and where to resume; undefined while still running.
 */
export function readFrame(buffer: Buffer, nonce: string, fromOffset = 0): FrameResult | undefined {
  const completion = readRecord(buffer, RECORD_TAG, nonce, fromOffset)
  if (completion === undefined) return undefined
  if (!/^\d+$/.test(completion.value)) return undefined
  const state = readRecord(buffer, STATE_TAG, nonce, completion.next)
  if (state === undefined) return undefined
  let decoded = ''
  try {
    decoded = Buffer.from(state.value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
  return { status: Number(completion.value), state: decoded, recordStart: completion.start, nextOffset: state.next }
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
