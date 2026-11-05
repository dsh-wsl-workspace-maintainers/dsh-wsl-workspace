/** Probe the selected distribution/user with one fixed, read-only Linux command. */
import type { ExecFileOptions } from 'node:child_process'
import { isValidWslUsername } from '../shared/paths.ts'
import { decodeWslOutput, execFileResult, wslExecutableCandidates, type ExecFileResult } from '../shared/wsl.ts'

export interface WslConnectionCheck {
  status: 'connected' | 'failed'
  reason?: 'timeout' | 'unavailable' | 'connection-failed'
  distro: string
  username?: string
}

export interface WslConnectionOptions {
  run?: (file: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecFileResult>
  wslPath?: string
}

const MARKER = 'dsh-wsl-connection-ok'
const PROBE = `printf '%s\\n' '${MARKER}'`

/** No user input is inserted into shell text; the target is passed as argv. */
export async function checkWslConnection(
  distro: string,
  username = '',
  options: WslConnectionOptions = {},
): Promise<WslConnectionCheck> {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(distro)) throw new Error('distro must be a valid WSL distribution name')
  if (username !== '' && !isValidWslUsername(username)) throw new Error('username must be a valid Linux username')
  const target = { distro, ...(username === '' ? {} : { username }) }
  const args = ['--distribution', distro, ...(username === '' ? [] : ['--user', username]), '--cd', '/', '--exec', '/bin/sh', '-c', PROBE]
  const run = options.run ?? execFileResult
  for (const executable of wslExecutableCandidates(options.wslPath ?? 'wsl.exe')) {
    try {
      const result = await run(executable, args, {
        encoding: 'buffer',
        timeout: 12_000,
        maxBuffer: 8192,
        windowsHide: true,
        cwd: process.env.SystemRoot ?? process.cwd(),
      })
      return decodeWslOutput(result.stdout).trim() === MARKER
        ? { ...target, status: 'connected' }
        : { ...target, status: 'failed', reason: 'connection-failed' }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
      if (failure.code === 'ENOENT') continue
      return { ...target, status: 'failed', reason: failure.killed === true || failure.code === 'ETIMEDOUT' ? 'timeout' : 'connection-failed' }
    }
  }
  return { ...target, status: 'failed', reason: 'unavailable' }
}
