/**
 * Per-workspace WSL credentials (host side only). The dialog stores the
 * optional Linux username of a WSL workspace under the harness home; the
 * per-session env contributor and the WSL shell executor read it back so
 * `wsl.exe -u <username>` can run commands as that user. Keys are canonical
 * UNC workspace paths. This module touches node builtins, so the browser
 * half never imports it.
 * @module dsh-wsl-workspace/shared/wsl-credentials
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalWindowsPath, isValidWslUsername, joinUnc, parseWslUnc } from './paths.ts'

/** One workspace's stored credentials. */
interface WorkspaceEntry {
  /** The Linux user bash runs as inside the distribution (absent = distro default). */
  username?: string
  /**
   * The WSL distribution of a Windows-drive workspace (`/mnt/<drive>` path).
   * 9P cannot serve drvfs mounts, so such workspaces register under their
   * Windows drive path; this entry is what the per-session env contributor
   * uses to hand a distro to the shell executor.
   */
  distro?: string
}

/** The stored form: canonical UNC or Windows drive workspace path → credentials. */
type WorkspaceStore = Record<string, WorkspaceEntry>

/** The store file lives under the harness home so both host halves share it. */
function storePath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'wsl-workspaces.json')
}

/** Read the store; a missing or corrupt file reads as empty (never throws). */
function readStore(): WorkspaceStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as WorkspaceStore
  } catch {
    return {}
  }
}

/**
 * Canonicalize any accepted WSL UNC spelling into the store's key form.
 * @param path - candidate workspace path (either UNC host form).
 * @returns the canonical UNC path, or null when the path is not a WSL UNC.
 */
export function canonicalWslUnc(path: string): string | null {
  const parsed = parseWslUnc(path)
  return parsed === null ? null : joinUnc(parsed.distro, parsed.linuxPath)
}

/**
 * Read the stored username for a WSL workspace.
 * @param uncPath - the workspace path (any accepted WSL UNC spelling).
 * @returns the username, or undefined when none is stored.
 */
export function getWorkspaceUsername(uncPath: string): string | undefined {
  const key = canonicalWslUnc(uncPath)
  if (key === null) return undefined
  const username = readStore()[key]?.username
  return username === undefined || username === '' ? undefined : username
}

/**
 * Store (or clear) the username of a WSL workspace.
 * @param uncPath - the workspace path (any accepted WSL UNC spelling).
 * @param username - the username; empty or undefined clears the stored value.
 */
export function setWorkspaceUsername(uncPath: string, username: string | undefined): void {
  const key = canonicalWslUnc(uncPath)
  if (key === null) throw new Error('wsl-workspace: workspace path is not a WSL UNC path')
  const store = readStore()
  if (username === undefined || username.trim() === '') {
    delete store[key]
  } else {
    const trimmed = username.trim()
    if (!isValidWslUsername(trimmed)) {
      throw new Error('wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*')
    }
    store[key] = { username: trimmed }
  }
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/**
 * Register the WSL distribution (and optional Linux username) of a
 * Windows-drive workspace (`/mnt/<drive>` path). Keys are canonical Windows
 * drive paths; the per-session env contributor reads the entry back so
 * `wsl.exe -d <distro>` can run when the session cwd is a drive path.
 * @param winPath - the Windows drive path (any spelling).
 * @param distro - the WSL distribution the workspace belongs to.
 * @param username - optional Linux username (distro default when absent).
 */
export function registerWindowsWorkspace(winPath: string, distro: string, username: string | undefined): void {
  const key = canonicalWindowsPath(winPath)
  if (key === null) throw new Error('wsl-workspace: workspace path is not a Windows drive path')
  const entry: WorkspaceEntry = { distro }
  if (username !== undefined && username.trim() !== '') {
    const trimmed = username.trim()
    if (!isValidWslUsername(trimmed)) {
      throw new Error('wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*')
    }
    entry.username = trimmed
  }
  const store = readStore()
  store[key] = entry
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/**
 * Read the stored credentials of a Windows-drive workspace.
 * @param winPath - the Windows drive path (any spelling).
 * @returns the stored entry, or undefined when none is registered.
 */
export function getWindowsWorkspace(winPath: string): WorkspaceEntry | undefined {
  const key = canonicalWindowsPath(winPath)
  if (key === null) return undefined
  return readStore()[key]
}

/** Every stored workspace key (canonical UNC and Windows drive paths). */
export function listWorkspaceKeys(): string[] {
  return Object.keys(readStore())
}

/** One stored workspace as the client reads it back. */
export interface WorkspaceRecord {
  /** The store key: a canonical UNC path or a canonical Windows drive path. */
  path: string
  /** The WSL distribution, present for a `/mnt/<drive>` workspace. */
  distro?: string
  /** The Linux user bash runs as, when one is configured. */
  username?: string
}

/**
 * Every stored workspace with its credentials.
 *
 * The client half needs more than the keys: to translate a file reference it has
 * to know which distribution a `/mnt/<drive>` workspace belongs to, because a
 * path outside the drive mounts can only be opened through that distribution's
 * UNC share. The keys alone cannot say.
 * @returns one record per stored workspace.
 */
export function listWorkspaceRecords(): WorkspaceRecord[] {
  return Object.entries(readStore()).map(([path, entry]) => {
    const record: WorkspaceRecord = { path }
    if (entry.distro !== undefined && entry.distro !== '') record.distro = entry.distro
    if (entry.username !== undefined && entry.username !== '') record.username = entry.username
    return record
  })
}
