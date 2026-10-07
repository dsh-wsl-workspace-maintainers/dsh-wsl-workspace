/**
 * Persistent-shell relay for WSL sessions.
 *
 * `@deepseek-ai/dsh-terminal-bash` is a config-driven PTY backend: the world
 * decides `shellPath`/`shellArgs`, and the backend spawns that command with the
 * session's cwd — which for a WSL session is a `\\wsl.localhost\…` path this
 * Windows side can hand to a process. This script *is* that command: it reads
 * the coordinates the preset cannot know (the distribution and optional user
 * come from the session, not from the mode), then hands its own stdio — the
 * PTY — to `wsl.exe`, so the model gets a stateful shell inside the
 * distribution instead of one process per call.
 *
 * The inner shell is started as `bash -lc '<cd …> && <re-assert the contract> && exec bash -i'`:
 * the login pass loads `/etc/profile` and the user profile (PATH and friends), and the
 * interactive shell that replaces it keeps the session directory. A plain
 * `bash -l` can be sent to `$HOME` by a profile — that is why the one-shot
 * executor in `src/shell.ts` prefixes an explicit `cd` too. The re-assertion is in the
 * middle because the login pass is where a distribution can take the prompt contract away:
 * see {@link readinessReassertion}.
 *
 * Resolution mirrors that executor: the UNC cwd names its distribution, else
 * `DSH_WSL_DISTRO` (the per-session fact this plugin publishes, normally absent here
 * because the host scrubs it — see {@link resolveUser}), else the workspace's stored
 * distribution, else the host's default; `DSH_WSL_USER`, else the workspace's stored
 * user, selects `wsl.exe -u`. Every failure is reported on stderr and exits non-zero,
 * so a broken shell surfaces instead of leaving a silent dead terminal.
 *
 * The spawn environment is not simply inherited. WSL imports a Windows variable
 * into a distribution only when `WSLENV` names it, and the host injects its bash
 * readiness contract as ordinary Windows variables — so an inherited environment
 * starts a shell whose prompt the host can never recognise, which is the failure
 * issue #51 reported as a session that never settles. `bridgeReadiness` names the
 * keys the host actually set and leaves everything else alone.
 *
 * @module dsh-wsl-workspace/host/wsl-relay
 */

import { spawn } from 'node:child_process'
import { isValidWslUsername, joinUnc, parseWslUnc, windowsToMntPath } from '../shared/paths.ts'
import { getWindowsWorkspace, getWorkspaceUsername } from '../shared/wsl-credentials.ts'
import { READINESS_COPY_KEY, bridgeReadiness, readinessReassertion } from '../shared/wsl-env.ts'
import { defaultDistroSync } from '../shared/wsl.ts'

/** Shell signals whose arrival means this relay should take the shell down. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']

/** POSIX single-quote a path so the `cd` command reaches bash as one word. */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** Fail loudly: the PTY has no other way to tell the model what went wrong. */
function fail(message: string): never {
  console.error(`dsh-wsl-workspace: ${message}`)
  process.exit(1)
}

/** The distribution this shell belongs to. */
function resolveDistro(uncDistro: string | undefined, storedDistro: string | undefined): string {
  if (uncDistro !== undefined && uncDistro !== '') return uncDistro
  const fromEnv = process.env.DSH_WSL_DISTRO
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // A Windows-drive workspace registers its distribution, because its path names none.
  if (storedDistro !== undefined && storedDistro !== '') return storedDistro
  const fallback = defaultDistroSync()
  if (fallback !== undefined && fallback !== '') return fallback
  return fail('persistent shell: the session cwd carries no distribution, DSH_WSL_DISTRO is unset and no WSL default is readable')
}

/**
 * The Linux user this shell runs as, when one is configured and safe for `wsl.exe -u`.
 *
 * The environment is read first because it is the more immediate statement of intent, but it
 * is normally empty: the host builds this child's environment itself, and its
 * `scrubbedParentEnv()` drops every `DSH_*` variable, so the per-session fact the plugin
 * publishes never arrives here. What does survive is the workspace store the dialog writes —
 * the same file the one-shot executor and the session `bash` read — and it is keyed by the
 * very cwd this relay was started in. Measured 2026-10-06 under the real backend: with only
 * the environment consulted, a PTY shell came up as the distribution's default user even
 * when the workspace named another one.
 * @param storedUser - the username stored for this workspace, if any.
 * @returns the username, or undefined for the distribution default user.
 */
function resolveUser(storedUser: string | undefined): string | undefined {
  const fromEnv = process.env.DSH_WSL_USER
  const user = fromEnv !== undefined && fromEnv !== '' ? fromEnv : storedUser
  if (user === undefined || user === '') return undefined
  if (!isValidWslUsername(user)) fail(`persistent shell: refusing the malformed username "${user}"`)
  return user
}

/**
 * The workspace coordinates this cwd has a stored entry for, if any.
 *
 * A UNC cwd names its distribution itself and only carries a user; a Windows-drive cwd
 * (`/mnt/<drive>` workspace) names neither, so both come from the entry the dialog wrote.
 * An absent entry is an empty answer, never a guess.
 * @param cwd - this process's working directory.
 * @param unc - the parsed UNC form of that cwd, when it is one.
 * @returns the stored username and/or distribution.
 */
function storedCoordinates(cwd: string, unc: { distro: string, linuxPath: string } | null): { username?: string, distro?: string } {
  if (unc !== null) {
    const username = getWorkspaceUsername(joinUnc(unc.distro, unc.linuxPath))
    return username === undefined ? {} : { username }
  }
  const entry = getWindowsWorkspace(cwd)
  if (entry === undefined) return {}
  return {
    ...entry.username === undefined ? {} : { username: entry.username },
    ...entry.distro === undefined ? {} : { distro: entry.distro },
  }
}

const cwd = process.cwd()
const unc = parseWslUnc(cwd)
const stored = storedCoordinates(cwd, unc)
const distro = resolveDistro(unc?.distro, stored.distro)
const user = resolveUser(stored.username)
// The PTY's cwd is what `wsl.exe` inherits; it accepts both the UNC form of its
// own filesystem and a drive path (mapped to `/mnt/<drive>`), so it is handed
// through unchanged and only the login shell's `cd` needs the Linux spelling.
const linuxCwd = unc !== null ? unc.linuxPath : windowsToMntPath(cwd) ?? undefined
const env = bridgeReadiness(process.env)
// The login pass can rewrite the readiness contract — a distribution whose profile turns
// `PROMPT_COMMAND` into an array exports nothing at all to the shell that replaces it — so the
// bridged copy is put back after the pass and before `exec`. Only when the host bridged a
// contract: a host that injected none gets the shell its own startup files describe.
const steps = [
  ...linuxCwd === undefined ? [] : [`cd ${quote(linuxCwd)}`],
  ...env[READINESS_COPY_KEY] === undefined ? [] : [readinessReassertion()],
  'exec bash -i',
]
const command = steps.join(' && ')
const argv = [
  'wsl.exe',
  '-d', distro,
  ...user === undefined ? [] : ['-u', user],
  '--cd', cwd,
  '-e', 'bash',
  '-lc', command,
]

const child = spawn(argv[0] ?? 'wsl.exe', argv.slice(1), { stdio: 'inherit', env })
child.on('error', (error: Error) => fail(`persistent shell: cannot start ${argv[0] ?? 'wsl.exe'} (${error.message})`))
child.on('exit', (code, signal) => process.exit(signal === null ? code ?? 0 : 1))
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  })
}
