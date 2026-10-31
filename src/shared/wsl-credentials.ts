/**
 * Per-workspace WSL credentials (host side only). The dialog stores the
 * optional Linux username of a WSL workspace under the harness home; the
 * per-session env contributor and the WSL shell executor read it back so
 * `wsl.exe -u <username>` can run commands as that user. Keys are canonical
 * UNC workspace paths. This module touches node builtins, so the browser
 * half never imports it.
 * @module dsh-wsl-workspace/shared/wsl-credentials
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  /**
   * The registered directory's creation time, in milliseconds. The store is
   * keyed by a path STRING, so deleting the directory and creating one with the
   * same name hits the same key — which is how issue #129's repro step 2 read as
   * "the new folder inherited the old one's WSL mode". This stamp is what tells
   * the two directories apart; absent on records written before it existed, and
   * never trusted for a UNC record (a 9P `stat` is not worth the latency here).
   */
  born?: number
}

/** The stored form: canonical UNC or Windows drive workspace path → credentials. */
type WorkspaceStore = Record<string, WorkspaceEntry>

/** What a directory lookup can say about a registered path. */
type DirectoryState =
  /** Present, with its creation time in whole seconds. */
  | { state: 'present'; born: number }
  /** Gone: ENOENT or not a directory any more. */
  | { state: 'missing' }
  /** Unreadable for another reason (locked, transient share error) — say nothing. */
  | { state: 'unknown' }

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
 * What the file system says about a registered directory right now.
 * @param path - the store key (a canonical Windows drive path).
 * @returns present with its creation time, missing, or unknown.
 */
function directoryState(path: string): DirectoryState {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return { state: 'missing' }
    return { state: 'present', born: Math.round(stat.birthtimeMs) }
  } catch (error) {
    // Only a missing directory retires a record. A share that is briefly
    // unavailable, or a path this process cannot open, must not read as
    // "the user deleted it" — that would silently drop a working registration.
    const code = (error as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'missing' } : { state: 'unknown' }
  }
}

/**
 * Persist the store. One writer, so every exit path leaves the same shape.
 * @param store - the records to write.
 */
function writeStore(store: WorkspaceStore): void {
  const file = storePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/**
 * The store as the file system supports it right now.
 *
 * A drive-shaped record is dropped when its directory is gone, or when the
 * directory that answers to the path was created at a different time than the
 * one registered — the same-name-new-folder case in issue #129's repro. The drop
 * is written back, so the client's next read sees one fewer workspace instead of
 * re-deciding it per lookup. UNC records are left alone: their share is the
 * distribution's own, and a 9P `stat` per read is not a price worth paying when
 * the reported symptom is about drive paths.
 * @returns the surviving records, and the keys retired on the way.
 */
function liveStore(): { store: WorkspaceStore; dropped: string[] } {
  const store = readStore()
  const dropped: string[] = []
  for (const [key, entry] of Object.entries(store)) {
    if (entry.distro === undefined) continue
    const directory = directoryState(key)
    if (directory.state === 'unknown') continue
    if (directory.state === 'missing') {
      delete store[key]
      dropped.push(key)
      continue
    }
    if (entry.born !== undefined && entry.born !== directory.born) {
      delete store[key]
      dropped.push(key)
    }
  }
  if (dropped.length > 0) writeStore(store)
  return { store, dropped }
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
  // Stamp the directory this registration was made for, so a same-name
  // replacement is recognised as a different folder (see {@link WorkspaceEntry.born}).
  const directory = directoryState(key)
  if (directory.state === 'present') entry.born = directory.born
  writeStore(store)
}

/**
 * Read the stored credentials of a Windows-drive workspace.
 * @param winPath - the Windows drive path (any spelling).
 * @returns the stored entry, or undefined when none is registered — including
 * when a record exists but its directory is gone or has been replaced.
 */
export function getWindowsWorkspace(winPath: string): WorkspaceEntry | undefined {
  const key = canonicalWindowsPath(winPath)
  if (key === null) return undefined
  return liveStore().store[key]
}

/**
 * Remove one workspace's registration, whichever dialog route wrote it.
 *
 * The store had exactly one exit before this function: `setWorkspaceUsername`'s
 * `delete`, which resolves its key through `canonicalWslUnc()` and therefore
 * throws on a drive key. A `/mnt/<drive>` workspace written by `registerWindows`
 * had no way back out — deleting the session, deleting the workspace in the host,
 * and deleting the directory itself all leave the record behind, and the client
 * re-binds every new session from it (issue #129).
 * @param path - a WSL UNC path or a Windows drive path, in any spelling.
 * @returns the key removed from the store, or null when the path names neither.
 */
export function unregisterWorkspace(path: string): string | null {
  const key = canonicalWslUnc(path) ?? canonicalWindowsPath(path)
  if (key === null) return null
  const store = readStore()
  if (!(key in store)) return null
  delete store[key]
  writeStore(store)
  return key
}

/** Every stored workspace key (canonical UNC and Windows drive paths). */
export function listWorkspaceKeys(): string[] {
  return Object.keys(liveStore().store)
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
 * @returns one record per stored workspace whose directory still answers as the
 * registered one (a replaced or deleted folder retires its record here).
 */
export function listWorkspaceRecords(): WorkspaceRecord[] {
  return Object.entries(liveStore().store).map(([path, entry]) => {
    const record: WorkspaceRecord = { path }
    if (entry.distro !== undefined && entry.distro !== '') record.distro = entry.distro
    if (entry.username !== undefined && entry.username !== '') record.username = entry.username
    return record
  })
}
