/**
 * Boot-time readiness probe for the persistent (PTY) shell.
 *
 * `supportsPersistentShell` answers a narrow question — can this host build a
 * terminal inspector at all — and issue #51 showed what a narrow answer costs: a
 * Desktop that passed it mounted a PTY world whose every `bash` call failed,
 * because nothing checked whether a WSL shell under that host actually reaches
 * the state the host's own completion check looks for. This probe asks the
 * second question end to end, once, before the world is published: start the real
 * relay the way the backend will start it, send one command through the real
 * terminal seam, and require the three facts the backend needs to call the shell
 * ready.
 *
 * What it proves, and what it does not. A pass means the relay interpreter runs,
 * the distribution starts, the command round-trips, and the readiness contract
 * arrived in the distribution — which is the failure class issue #51 reported as
 * a shell that never settles. A pass does NOT prove the host's process-group
 * inspection works inside WSL: that lives in `@deepseek-ai/dsh-win32-process`,
 * behind a predicate this plugin cannot call. The probe is deliberately honest
 * about that limit rather than quietly claiming the whole path.
 *
 * @module dsh-wsl-workspace/host/pty-readiness
 */

import { join } from 'node:path'
import { CONTROLLED_PROMPT, readinessContract } from '../shared/wsl-env.ts'

/**
 * The ceiling for one probe. Derived from a measurement, not tuned to pass:
 * 2026-10-04 on a Windows 10 19045 / WSL 3.0.1.0 machine, the relay's first prompt
 * landed at 1087 ms warm and 3962 ms cold (the cold figure is the distro
 * auto-starting underneath the first access), and a command round-tripped within
 * 3998 ms of spawn. 15 s sits about 3.75x above the slowest legitimate boot here,
 * which is margin for a slower disk or a cold Hyper-V host, not headroom for a
 * broken one — a host that cannot answer inside 15 s should not be handed a PTY
 * world it will fail every call in.
 */
export const READINESS_PROBE_BUDGET_MS = 15_000

/** The part of the `subprocess` service this probe needs, injected for testability. */
export interface ReadinessSpawnFace {
  spawnTerminal(spec: {
    argv: readonly string[]
    cwd: string
    rows: number
    cols: number
    terminalType: string
    graceMs: number
    env: Record<string, string>
  }): Promise<unknown>
}

/** The outcome of one probe. */
export interface ReadinessResult {
  /** Whether the persistent shell may be mounted. */
  ready: boolean
  /** One line saying what was observed, for the boot log and the tests. */
  detail: string
  /** True when the probe could not run its own checks (a face it does not know). */
  unverifiable?: boolean
}

/**
 * Strip the escape sequences a terminal emulator interprets rather than prints.
 *
 * The prompt test must not require a trailing space to arrive as a space: measured
 * on this machine, ConPTY can render the trailing space of `dsh> ` as a cursor-forward
 * sequence (`ESC [ 1 C`), which would fail a byte-for-byte check while the shell is
 * in fact sitting at the controlled prompt.
 * @param text - raw bytes seen on the wire.
 * @returns the printable remainder.
 */
export function stripTerminalEscapes(text: string): string {
  return text.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * Run one readiness probe against a live terminal seam.
 * @param face - the `subprocess` service face, or undefined when there is none.
 * @param paths - the relay script and the interpreter the backend would start it with.
 * @param budgetMs - the ceiling; defaults to {@link READINESS_PROBE_BUDGET_MS}.
 * @returns whether the shell reached the state the host's completion check needs.
 */
export async function probePersistentShellReadiness(
  face: ReadinessSpawnFace | undefined,
  paths: { relayPath: string; nodePath: string },
  budgetMs: number = READINESS_PROBE_BUDGET_MS,
): Promise<ReadinessResult> {
  if (face === undefined) {
    return { ready: true, detail: 'no subprocess service to probe with; unchanged from the probe that ran before this one', unverifiable: true }
  }
  // A minimal, deterministic environment. Not `process.env`: handing a distribution
  // the plugin host's whole environment to "check readiness" would both leak and
  // make the result depend on whatever is lying around in the caller's shell.
  // `wsl.exe` is resolved by name, so System32 has to be reachable.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const env: Record<string, string> = {
    SystemRoot: systemRoot,
    PATH: [join(systemRoot, 'System32'), process.env.PATH ?? ''].filter(Boolean).join(';'),
    TERM: 'dumb',
    ...readinessContract(),
  }
  // The command is arithmetic, not a bare token. A PTY echoes what it is handed
  // before it runs anything, so `echo <nonce>` would let a shell that never
  // executes a command satisfy the check — measured: the first version of this
  // probe reported ready against exactly such a fake. The doubled value can only
  // appear if a shell actually evaluated the line.
  const seed = 1_000_000 + Math.floor(Math.random() * 9_000_000)
  const expected = `dshwslprobe${seed * 2}`
  const command = `echo dshwslprobe$(( ${seed} * 2 ))`

  let handle: {
    output?: { setEncoding?: (c: string) => void, on?: (e: string, cb: (c: string) => void) => void }
    write?: (data: string) => Promise<void> | void
    terminate?: () => Promise<void> | void
    done?: Promise<unknown>
  } | undefined
  const started = Date.now()
  try {
    handle = await face.spawnTerminal({
      argv: [paths.nodePath, paths.relayPath],
      cwd: systemRoot,
      rows: 24,
      cols: 80,
      terminalType: 'dumb',
      graceMs: 1_000,
      env,
    }) as typeof handle
  } catch (error) {
    return { ready: false, detail: `spawnTerminal rejected the relay: ${String(error).slice(0, 160)}` }
  }

  const stream = handle?.output
  if (typeof stream?.on !== 'function' || typeof handle?.write !== 'function') {
    // An unknown handle is not evidence of a broken shell. Keep the previous
    // behaviour and say so loudly — the alternative is demoting every host whose
    // terminal face this probe has not been taught to read.
    // `terminate` may be synchronous, so the settlement is wrapped rather than chained.
    await Promise.resolve(handle?.terminate?.()).catch(() => {})
    return { ready: true, detail: 'the terminal handle exposes no output stream or write; readiness was NOT verified', unverifiable: true }
  }

  let wire = ''
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk: string) => { wire += chunk })
  let exitObserved: string | undefined
  handle.done?.then(
    (outcome) => { exitObserved = `resolved ${JSON.stringify(outcome)}` },
    (error) => { exitObserved = `rejected ${String(error).slice(0, 80)}` },
  )

  let wrote = false
  let markerSeen = false
  let promptSeen = false
  let answerSeen = false
  try {
    while (Date.now() - started < budgetMs) {
      await new Promise(resolve => setTimeout(resolve, 100))
      markerSeen ||= wire.includes(']133;D;')
      promptSeen ||= stripTerminalEscapes(wire).includes(CONTROLLED_PROMPT.trimEnd())
      if (!wrote && (markerSeen || promptSeen || wire.length > 0)) {
        // Send only once the shell has produced something: writing into a PTY whose
        // shell has not started yet is how a probe turns a slow boot into a failure.
        wrote = true
        await handle.write(`${command}\r`)
      }
      answerSeen ||= wire.includes(expected)
      if (exitObserved !== undefined) break
      if (answerSeen && markerSeen && promptSeen) {
        return {
          ready: true,
          detail: `command round-tripped with the readiness contract in ${Date.now() - started}ms`,
        }
      }
    }
    const missing = [
      ...answerSeen ? [] : ['the probe command never produced its computed answer'],
      ...markerSeen ? [] : ['no OSC 133;D marker'],
      ...promptSeen ? [] : [`no ${JSON.stringify(CONTROLLED_PROMPT.trimEnd())} prompt`],
    ]
    return {
      ready: false,
      detail: `${exitObserved !== undefined ? `the shell ${exitObserved}` : 'no ready shell within the budget'} after ${Date.now() - started}ms: ${missing.join(', ') || 'unknown'}`,
    }
  } finally {
    await Promise.resolve(handle.terminate?.()).catch(() => {})
  }
}
