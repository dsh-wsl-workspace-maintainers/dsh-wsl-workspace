/**
 * Which node executable runs the persistent-shell relay.
 *
 * The WSL world's `bash` is the host's persistent-shell stack, and this plugin
 * hands its PTY backend a command of its own: `shellPath` is a node executable
 * and `shellArgs[0]` is `lib/wsl-relay.js`, because only the relay can read the
 * session's distribution and user at spawn time (see
 * `src/host/wsl-relay.ts`). Everything in that stack is the host's — only the
 * interpreter is this plugin's choice, and it has to be a real one.
 *
 * On `dsh web` it is: `process.execPath` is node. On DSH Desktop it is not. The
 * Desktop's host process *is* the packaged Electron executable running in node
 * mode (`ELECTRON_RUN_AS_NODE=1`; its shell writes
 * `new DesktopHostProcess(resources.node, …)` with
 * `resources.node = process.execPath`), and an Electron binary spawned under a
 * ConPTY produces **no stdout at all**: the relay's `wsl.exe` child inherits a
 * dead stream, the relay exits 0 without a byte, the backend's readiness probe
 * never sees a prompt, and every persistent shell fails with
 * `PTY shell exited during startup` (issue #40). Measured with the host's own
 * node-pty on Desktop 0.2.0-rc.2 / Electron 38: the identical spec — same relay,
 * same `\\wsl.localhost\…` cwd, same environment — reports 93 bytes and a bash
 * prompt through a real node, and 0 bytes with an immediate exit 0 through the
 * Electron executable.
 *
 * So the interpreter is resolved deliberately instead of trusted. Candidates,
 * best first:
 *
 *  1. The Desktop's own runtime payload, located from the absolute
 *     `…/resources/runtime/primary-runtime` path the Desktop passes to its host
 *     process in `process.argv` (that payload carries a real node at
 *     `dependencies/node/bin/`, per the `versions.json` beside it).
 *  2. The same payload relative to the running executable, which is the layout
 *     of an installed Desktop (`<install>/resources/runtime/…`).
 *  3. `DSH_DESKTOP_NODE_EXECUTABLE`, but only when it really is node. The
 *     Desktop sets that variable to `process.execPath` — the Electron binary:
 *     its own `resources/runtime/bin/node.cmd` is
 *     `set ELECTRON_RUN_AS_NODE=1` followed by `"%DSH_DESKTOP_NODE_EXECUTABLE%"`,
 *     a shim around the Electron executable, not a node. The probe below
 *     rejects it.
 *  4. A `node.exe`/`node` on `PATH`.
 *  5. `process.execPath` — the behaviour before this module existed, and the
 *     correct one on any host that is not Electron.
 *
 * Every candidate is asked what it is rather than inferred from a version
 * string, because `--version` cannot tell the two apart: an Electron binary
 * answers `v38.4.0` on its own and answers with the *node* version when
 * `ELECTRON_RUN_AS_NODE` is inherited — which it always is inside the Desktop
 * host, so a `^v\d+\.\d+\.\d+` check would happily select the broken one.
 *
 * @module dsh-wsl-workspace/shared/relay-node
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileResult, textOf } from './wsl.ts'

/** How long one candidate probe may take. */
const PROBE_TIMEOUT_MS = 10_000

/** The oldest node major the built `lib/` output is known to run on. */
const MINIMUM_NODE_MAJOR = 20

/** One candidate interpreter and where it came from. */
export interface RelayNodeCandidate {
  /** Absolute path to the executable. */
  path: string
  /** Why this path was considered, for the boot log and for reviews. */
  source: string
}

/** The outcome of one resolution. */
export interface RelayNodeResolution {
  /** The executable the relay will be started with. */
  path: string
  /** Why that one was chosen. */
  source: string
  /** Every candidate that was probed and rejected before it, in order. */
  rejected: string[]
  /** Whether nothing usable was found and `path` is only the last resort. */
  fallback: boolean
}

/** Human text for an unknown rejection. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Whether this process is an Electron host rather than plain node.
 *
 * `process.versions.electron` is set in both Electron modes — windowed and
 * `ELECTRON_RUN_AS_NODE` — so this is the same fact the resolution itself
 * turns on, and not a guess from the executable's name.
 * @returns true when the host process is Electron (i.e. DSH Desktop).
 */
export function isElectronHost(): boolean {
  return process.versions.electron !== undefined
}

/** The bundled node executable name on one platform. */
function nodeExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * The candidate interpreters that do not need a lookup, best first.
 *
 * Pure on purpose: every fact it reads is a parameter, so a test (or a review)
 * can describe a Desktop that is not the one running it.
 * @param input - the host facts to derive candidates from.
 * @returns candidates that exist, in preference order, without duplicates.
 */
export function relayNodeCandidates(input: {
  argv: readonly string[]
  execPath: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  exists?: (path: string) => boolean
}): RelayNodeCandidate[] {
  const exists = input.exists ?? existsSync
  const name = nodeExecutableName(input.platform)
  const payload = (root: string): string => join(root, 'dependencies', 'node', 'bin', name)
  const candidates: RelayNodeCandidate[] = []
  const add = (path: string | undefined, source: string): void => {
    if (path === undefined || path === '') return
    if (candidates.some(candidate => candidate.path === path)) return
    candidates.push({ path, source })
  }
  // 1. The payload the Desktop handed this host process on its command line.
  for (const arg of input.argv) {
    if (/(^|[\\/])primary-runtime[\\/]?$/.test(arg)) {
      add(payload(arg), `the runtime payload named in argv ("${arg}")`)
    }
  }
  // 2. The same payload beside the running executable.
  const exeDir = dirname(input.execPath)
  add(
    payload(join(exeDir, 'resources', 'runtime', 'primary-runtime')),
    'the runtime payload beside the running executable',
  )
  add(
    payload(join(exeDir, '..', 'Resources', 'runtime', 'primary-runtime')),
    'the runtime payload in the macOS bundle Resources directory',
  )
  // 3. The interpreter the Desktop's own node launcher names. On the Desktop
  //    this is the Electron executable, and the probe is what rejects it.
  add(input.env.DSH_DESKTOP_NODE_EXECUTABLE, 'DSH_DESKTOP_NODE_EXECUTABLE')
  return candidates.filter(candidate => exists(candidate.path))
}

/**
 * The candidate interpreters a `PATH` lookup finds, in `where`/`which` order.
 *
 * Windows is asked for `node.exe` specifically: the Desktop puts its
 * `runtime/bin` on `PATH` for some children, and that directory holds `node.cmd`
 * and `node`, both of which are shims around the Electron executable rather
 * than node. A shim is not a usable `shellPath` anyway — `spawn` cannot run a
 * `.cmd` without a shell — so leaving them out of the list is the honest
 * answer, and the probe would reject them regardless.
 * @param platform - the host platform.
 * @returns the existing candidates, in the order the lookup reported them.
 */
export async function pathNodeCandidates(platform: NodeJS.Platform): Promise<RelayNodeCandidate[]> {
  const name = nodeExecutableName(platform)
  const command = platform === 'win32' ? 'where.exe' : 'which'
  const args = platform === 'win32' ? [name] : ['-a', 'node']
  try {
    const result = await execFileResult(command, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
    const lines = textOf(result.stdout)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '')
    return lines.map(path => ({ path, source: `"${name}" on PATH` }))
  } catch {
    // `where`/`which` missing or finding nothing is not an error: the caller
    // still has the fallback.
    return []
  }
}

/** What one probe learned about a candidate. */
export type RelayNodeProbe =
  | { ok: true; version: string }
  | { ok: false; reason: string }

/**
 * Judge one probe's output.
 *
 * Split out from the spawn so the discriminator is testable on its own: the
 * strings below are what the two binaries actually print, and no version-shaped
 * check can separate them (see the module comment).
 * @param stdout - the candidate's captured stdout.
 * @returns whether it is a usable node, and either its version or the reason.
 */
export function classifyNodeProbe(stdout: string): RelayNodeProbe {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { ok: false, reason: 'did not report a node version' }
  }
  if (
    !Array.isArray(parsed)
    || typeof parsed[0] !== 'string'
    || (parsed[1] !== null && typeof parsed[1] !== 'string')
  ) {
    return { ok: false, reason: 'did not report a node version' }
  }
  if (parsed[1] !== null) {
    return { ok: false, reason: `is the Electron ${parsed[1]} executable, not node` }
  }
  const major = Number(/^(\d+)\./.exec(parsed[0])?.[1] ?? '0')
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    return { ok: false, reason: `is node ${parsed[0]}, older than the ${MINIMUM_NODE_MAJOR} this build needs` }
  }
  return { ok: true, version: parsed[0] }
}

/**
 * Ask one candidate what it is, by running it once.
 *
 * The script prints `[process.versions.node, process.versions.electron ?? null]`
 * as JSON, so a single spawn answers both questions: whether this is node at
 * all, and whether it is the Electron executable that merely answers to node
 * mode. `-e` rather than `-p`: `-p` prints the expression's value as well, and
 * `process.stdout.write` returns `true`, which would append a stray `true` to
 * the JSON. A candidate that cannot be started is reported with the reason
 * instead of being accepted on faith.
 * @param candidate - absolute path to the executable to ask.
 * @returns whether it is a usable node, and either its version or the reason.
 */
export async function probeRelayNode(candidate: string): Promise<RelayNodeProbe> {
  const script = 'process.stdout.write(JSON.stringify([process.versions.node, process.versions.electron ?? null]))'
  try {
    const result = await execFileResult(candidate, ['-e', script], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    return classifyNodeProbe(textOf(result.stdout))
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }
}

/**
 * Resolve the interpreter the persistent-shell relay must be started with.
 *
 * A host that is not Electron already runs on a real node, so it is returned
 * untouched and nothing is spawned — `dsh web` behaves exactly as before.
 * @returns the chosen executable, why it was chosen, and what was rejected.
 */
export async function resolveRelayNode(): Promise<RelayNodeResolution> {
  if (!isElectronHost()) {
    return {
      path: process.execPath,
      source: 'the host process is not Electron, so it is already a real node',
      rejected: [],
      fallback: false,
    }
  }
  const candidates = [
    ...relayNodeCandidates({
      argv: process.argv,
      execPath: process.execPath,
      env: process.env,
      platform: process.platform,
    }),
    ...await pathNodeCandidates(process.platform),
  ]
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    const probe = await probeRelayNode(candidate.path)
    if (probe.ok) {
      return {
        path: candidate.path,
        source: `node ${probe.version} from ${candidate.source}`,
        rejected,
        fallback: false,
      }
    }
    rejected.push(`${candidate.path} (${probe.reason})`)
  }
  return {
    path: process.execPath,
    source: 'no real node executable was found; the Electron host executable is the last resort, and a PTY child started from it produces no output',
    rejected,
    fallback: true,
  }
}

/**
 * Whether the world may mount the persistent (PTY) shell, given the substrate
 * probe's answer and the interpreter the relay would be started with.
 *
 * A `fallback: true` resolution is not a degraded-but-usable answer: what it
 * resolved to is the Electron executable, and `resolveRelayNode()` says in its
 * own words that a PTY child started from it produces no output. Mounting the PTY
 * world on top of that turns every `bash` call into issue #40's
 * `PTY shell exited during startup`, which is what issue #51 reported from a
 * Desktop whose payload layout matched none of the candidates. Demoting costs the
 * session its shell state — the one-shot executor needs no PTY, so the model
 * still gets a working `bash`.
 * @param probeSaysYes - what `supportsPersistentShell` answered.
 * @param relay - the resolution for the chosen interpreter, absent when the probe already said no.
 * @returns true only when both halves agree the shell can start.
 */
export function persistentShellAllowed(
  probeSaysYes: boolean,
  relay: RelayNodeResolution | undefined,
): boolean {
  return probeSaysYes && relay !== undefined && relay.fallback !== true
}
