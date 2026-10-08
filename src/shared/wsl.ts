/**
 * WSL discovery helpers (host side): enumerate installed distributions
 * through `wsl.exe -l -q` and read the default distribution from the Lxss
 * registry key. `wsl.exe` output is UTF-16LE on most builds, so decoding
 * sniffs for NUL bytes before choosing an encoding.
 * @module dsh-wsl-workspace/shared/wsl
 */

import { execFile, execFileSync } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'

/** Executable timeout for the short discovery calls. */
const DISCOVERY_TIMEOUT_MS = 10_000

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/** Human text for an unknown rejection. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One `execFile` outcome: the two streams, as `encoding` asked for them. */
export interface ExecFileResult {
  stdout: Buffer | string
  stderr: Buffer | string
}

/**
 * Run `execFile` through its callback API and resolve `{ stdout, stderr }`.
 *
 * `util.promisify(execFile)` only resolves that object because `execFile`
 * carries `util.promisify.custom`. A host that replaces
 * `child_process.execFile` with a plain wrapper loses that metadata, and
 * `promisify` then falls back to "resolve the first callback value" — which is
 * stdout itself, so `result.stdout` is `undefined` (issue #35: DSH Desktop
 * injects `windowsHide: true` that way, and `listDistros()` died with
 * `Cannot read properties of undefined (reading 'includes')`).
 *
 * The callback form is what every such wrapper preserves, so this does not
 * depend on how the host patched the module.
 * @param file - the executable.
 * @param args - its arguments.
 * @param options - `execFile` options, including the requested encoding.
 * @returns both streams; the caller narrows them by the encoding it asked for.
 */
export function execFileResult(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  // `settle`/`fail` rather than `resolve`/`reject`, matching
  // `src/host/wsl-search.ts`; `scripts/verify-lib.mjs` reads a bare
  // `resolve(` call as an unbound `node:path` export.
  return new Promise<ExecFileResult>((settle, fail) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        fail(error)
        return
      }
      settle({ stdout, stderr })
    })
  })
}

/**
 * Read a captured stream as text, whichever way the encoding arrived.
 *
 * One decode policy for every captured stream in the plugin: a `reg.exe` answer written in UTF-16LE
 * used to reach this function's hard `toString('utf8')` and came back as mojibake, which the caller
 * could not tell from "the registry said nothing" — an empty picker, no throw, no log.
 * @param stream - the captured output, or text that arrived as text.
 * @returns the decoded text.
 */
export function textOf(stream: Buffer | string): string {
  return decodeWslOutput(stream)
}

/**
 * The `wsl.exe` spellings to try, in order.
 *
 * The bare name relies on `PATH`. A host whose `PATH` omits `System32` can run
 * every other part of this plugin — `listDir`/`check` go through the
 * `\\wsl.localhost\…` share and never spawn anything — while `listDistros`
 * reports that WSL is missing, which is what issue #36 describes. The
 * absolute fallback removes that failure mode.
 * @param wslPath - the configured executable.
 * @returns the candidates, without duplicates.
 */
export function wslExecutableCandidates(wslPath: string): string[] {
  if (wslPath !== 'wsl.exe') return [wslPath]
  const root = process.env.SystemRoot ?? process.env.windir
  if (root === undefined || root === '') return [wslPath]
  const absolute = `${root.replace(/[\\/]+$/, '')}\\System32\\wsl.exe`
  return [wslPath, absolute]
}

/**
 * Decide whether a captured buffer is UTF-16LE, structurally.
 *
 * The old rule asked only whether a NUL was **present**. That is not a UTF-16 marker, it is the byte
 * 0x00, and UTF-8 streams carry those legitimately — `find -print0`, `grep -Z` and `git ls-files -z`
 * all speak NUL-delimited, which is why this plugin's own search path splits stdout on a NUL delimiter. A
 * UTF-16LE console answer has its NULs at a **regular parity** (for ASCII text, every odd byte) and at
 * a **high density**; a NUL-delimited or error-bearing UTF-8 stream has them at no parity in
 * particular and rarely.
 * @param buffer - the captured bytes.
 * @returns whether the shape says UTF-16LE.
 */
function looksUtf16Le(buffer: Buffer): boolean {
  const sample = Math.min(buffer.length, 4096)
  let even = 0
  let odd = 0
  for (let index = 0; index < sample; index += 1) {
    if (buffer[index] !== 0) continue
    if (index % 2 === 0) even += 1
    else odd += 1
  }
  const nuls = even + odd
  if (nuls === 0) return false
  const parity = Math.max(even, odd) / nuls
  const density = nuls / sample
  // Density is the weaker half of the guard and is set low on purpose: CJK console output carries
  // fewer NULs per byte than ASCII does. The BOM check in `decodeWslOutput` is what covers the rest.
  return parity >= 0.9 && density >= 0.1
}

/**
 * Decode a captured stream the way the writer meant it.
 *
 * `wsl.exe -l -q` and `reg.exe query` answer in UTF-16LE on most Windows builds and in UTF-8 on
 * newer ones, so the encoding has to be decided per stream — but decided **structurally**, not by the
 * existence of a NUL (see {@link looksUtf16Le}).
 *
 * A caller that knows its stream never goes through the heuristic: `find -print0` output is NUL-
 * delimited UTF-8 by definition and reads its buffer directly, and a caller with a documented
 * encoding passes it.
 *
 * Known limit, stated rather than hidden: UTF-16LE text with no Latin characters at all (pure CJK,
 * say) carries so few NUL bytes that the density guard declines it. The `ff fe` BOM covers that case
 * for any writer that emits one, which includes the Windows console; a BOM-less, NUL-free UTF-16LE
 * answer would read as mojibake rather than as an error.
 * @param buffer - the captured output, or text that arrived as text.
 * @param encoding - the encoding when the caller knows it, which skips the sniff entirely.
 * @returns the decoded text.
 */
export function decodeWslOutput(buffer: Buffer | string, encoding?: 'utf8' | 'utf16le'): string {
  if (typeof buffer === 'string') return buffer
  if (!(buffer instanceof Uint8Array)) {
    throw new Error(`wsl-workspace: expected captured output, got ${typeof buffer}`)
  }
  if (encoding === 'utf8') return buffer.toString('utf8')
  if (encoding === 'utf16le') return buffer.toString('utf16le')
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le')
  return looksUtf16Le(buffer) ? buffer.toString('utf16le') : buffer.toString('utf8')
}

/**
 * List installed WSL distributions in `wsl.exe` order.
 * @param wslPath - the `wsl.exe` executable (absolute or PATH name).
 * @returns distribution names, blank lines dropped.
 */
export async function listDistros(wslPath = 'wsl.exe'): Promise<string[]> {
  const candidates = wslExecutableCandidates(wslPath)
  let stdout: Buffer | string | undefined
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const result = await execFileResult(candidate, ['-l', '-q'], {
        encoding: 'buffer',
        timeout: DISCOVERY_TIMEOUT_MS,
      })
      stdout = result.stdout
      break
    } catch (error) {
      lastError = error
    }
  }
  if (stdout === undefined) {
    throw new Error(
      `wsl-workspace: cannot list WSL distributions (tried ${candidates.join(' and ')}: ${messageOf(lastError)}); is WSL installed?`,
    )
  }
  return decodeWslOutput(stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Read the user's default distribution from the Lxss registry. Non-fatal:
 * returns `undefined` when the value is absent or unreadable (the caller
 * falls back to list order).
 * @returns the default distribution name, or `undefined`.
 */
export async function defaultDistro(): Promise<string | undefined> {
  try {
    const value = await execFileResult('reg.exe', ['query', LXSS_KEY, '/v', 'DefaultDistribution'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(textOf(value.stdout))?.[1]
    if (guid === undefined) return undefined
    const name = await execFileResult('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(textOf(name.stdout))?.[1]?.trim()
    return distro === undefined || distro === '' ? undefined : distro
  } catch {
    return undefined
  }
}

/** Module-level cache for {@link defaultDistroSync} (one registry read per process). */
let syncDefaultResolved = false
let syncDefault: string | undefined

/**
 * Synchronous variant of {@link defaultDistro} for executors that must
 * resolve a distribution inside a synchronous plan step. Cached after the
 * first read; non-fatal (returns `undefined` when the registry is
 * unreadable, letting the caller fail loud with its own message).
 * @returns the default distribution name, or `undefined`.
 */
export function defaultDistroSync(): string | undefined {
  if (syncDefaultResolved) return syncDefault
  syncDefaultResolved = true
  try {
    const value = execFileSync('reg.exe', ['query', LXSS_KEY, '/v', 'DefaultDistribution'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(String(value))?.[1]
    if (guid === undefined) return undefined
    const name = execFileSync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(String(name))?.[1]?.trim()
    syncDefault = distro === undefined || distro === '' ? undefined : distro
  } catch {
    syncDefault = undefined
  }
  return syncDefault
}
