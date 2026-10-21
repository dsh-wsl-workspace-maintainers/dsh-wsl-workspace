// The workspace shapes a session can be started in, in one table.
//
// Why a table and not a per-issue fixture. #86 was one provider missing the drive-path branch while
// six siblings had it; #78 is a root shape (`\\wsl.localhost\…` + `workspace-write`) that makes a
// host tool die. Both are the same statement: the shape of a workspace path is a small, enumerable
// set, and every surface that decides "which distribution, which Linux directory" must answer for
// each of them. Before this file, the set lived inside `tests/world-consistency.test.mjs` as six
// rows, and the four shapes below — spaces, symlink, very long, unreadable — existed nowhere.
//
// Two consumers, deliberately the only ones:
//   · `tests/world-consistency.test.mjs` drives the decision seams over every row (milliseconds), and
//   · `scripts/smoke-shapes.mjs` runs the shortest real chain (register → open → list → close).
// Neither runs the 72-cell unit matrix per shape; that would be the same over-investment in a new coat.
//
// `real` marks the rows whose interesting behaviour is only visible against a live distribution — a
// symlink the 9P share presents differently, a directory the user cannot read. The smoke driver names
// them and says SKIP rather than pretending the offline seam covered them.
//
// @module tests/replay/shapes

/** The drive-letter workspace the table registers in a temp `DSH_HOME` store. */
export const DRIVE_CWD = 'F:\\TechEnergy\\Code\\Scanner'
export const DRIVE_DISTRO = 'Ubuntu-G1'
/** The same shape with a space in the last segment, which is what a pasted Windows path looks like. */
export const DRIVE_CWD_SPACES = 'F:\\TechEnergy\\Code\\My Project'

/**
 * A path past the 260-character window: 39 segments of a fixed width, spelled in both the Windows and
 * the Linux form so the cell's expectation is not computed by the code the cell reads.
 */
const LONG_TAIL = Array.from({ length: 39 }, (_unused, index) => `segment-${index}-xxxxxxxxxxxx`).join('/')
const LONG_LINUX_CWD = `/home/u/proj/${LONG_TAIL}`
const LONG_UNC_CWD = `\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\proj\\${LONG_TAIL.replaceAll('/', '\\')}`

/**
 * One row: the cwd as the host hands it, the world every provider must derive from it, and who is on
 * point. `expect` is per provider: `world` (derives the pair), `refused` (says so by throwing) or
 * `quiet` (declines without an error, the way a catalog answers "nothing here").
 */
export const WORKSPACE_SHAPES = [
  {
    id: 'wsl-unc',
    cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\proj',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/home/u/proj' },
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'linux-absolute',
    cwd: '/home/u/proj',
    configured: 'Ubuntu-24.04',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/home/u/proj' },
    // Two contracts, both honest: search and bash answer a *tool argument* and can serve a bare Linux
    // path from the configured distribution; the keyboard door takes a *session path* a Windows process
    // must start in, so it refuses out loud. No workspace shape produces a bare Linux cwd.
    expect: { search: 'world', bash: 'world', terminal: 'refused', skills: 'quiet' },
  },
  {
    id: 'linux-mnt',
    cwd: '/mnt/f/proj',
    configured: 'Ubuntu-24.04',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/mnt/f/proj' },
    expect: { search: 'world', bash: 'world', terminal: 'refused', skills: 'quiet' },
  },
  {
    id: 'drive-workspace',
    cwd: DRIVE_CWD,
    sessionEnv: { DSH_WSL_DISTRO: DRIVE_DISTRO },
    world: { distro: DRIVE_DISTRO, linuxCwd: '/mnt/f/TechEnergy/Code/Scanner' },
    // #86's shape: the one where six providers had a branch and the seventh did not.
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'relative',
    cwd: 'proj/src',
    sessionEnv: {},
    world: undefined,
    expect: { search: 'refused', bash: 'refused', terminal: 'refused', skills: 'quiet' },
  },
  {
    id: 'absent',
    cwd: undefined,
    sessionEnv: {},
    world: undefined,
    expect: { search: 'refused', bash: 'refused', terminal: 'refused', skills: 'quiet' },
  },
  // The four rows stage 3 added. Their expectations were measured against the seams on 2026-10-21,
  // not guessed: a cell that disagrees with the code is a finding, and the table is where it lands.
  {
    id: 'drive-workspace-spaces',
    cwd: DRIVE_CWD_SPACES,
    sessionEnv: { DSH_WSL_DISTRO: DRIVE_DISTRO },
    world: { distro: DRIVE_DISTRO, linuxCwd: '/mnt/f/TechEnergy/Code/My Project' },
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'wsl-unc-spaces',
    cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\My Project',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/home/u/My Project' },
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'wsl-unc-symlink',
    cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\current',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/home/u/current' },
    // The world decision does not resolve the link — that is the file layer's job — so every provider
    // must answer the same pair. What the *share* does with the link is the `real` half.
    real: 'the 9P share presents an external symlink as another owner; skills-real has carried that reading since 2026-09-30',
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'wsl-unc-long',
    cwd: LONG_UNC_CWD,
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: LONG_LINUX_CWD },
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
  {
    id: 'wsl-unc-unreadable',
    cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\root-not-mine',
    sessionEnv: { DSH_WSL_DISTRO: 'Ubuntu-24.04' },
    world: { distro: 'Ubuntu-24.04', linuxCwd: '/root-not-mine' },
    // Deciding the world does not touch the share, so the derivation is the same as any UNC row; the
    // failure this row exists for is the *listing*, which has to come back as a sentence.
    real: 'needs a live distribution: the point is that a refused read reaches the user in words, not as a crash',
    expect: { search: 'world', bash: 'world', terminal: 'world', skills: 'world' },
  },
]

/** Providers the table drives, in the order a failure is reported. */
export const PROVIDERS = ['search', 'bash', 'terminal', 'skills']

/** The drive registrations a temp `DSH_HOME` store needs for the drive rows to be deterministic. */
export function workspaceStoreEntries() {
  return {
    [DRIVE_CWD.toLowerCase()]: { distro: DRIVE_DISTRO, username: 'g1user' },
    [DRIVE_CWD_SPACES.toLowerCase()]: { distro: DRIVE_DISTRO, username: 'g1user' },
  }
}
