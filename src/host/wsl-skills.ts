/**
 * WSL workspace skill provider (host half).
 *
 * DSH's shipped skill-filesystem provider scans only the session cwd's
 * project root (the nearest `.git` ancestor) for `.dsh/skills` / `.agents/skills`
 * and never descends into nested projects. A WSL workspace whose project
 * folders live below the registered workspace root therefore shows an empty
 * skill catalog, even though the same layout works when the session cwd is
 * the project folder itself (issue #10).
 *
 * This provider mirrors the host's discovery rules for WSL UNC session
 * workspaces: it starts at the session cwd's nearest `.git` ancestor (the
 * host's project-root rule; the cwd itself when no ancestor has a `.git`
 * marker), then walks that root (depth- and budget-bounded). Directory
 * symlinks are followed when the substrate resolves them, and — the case the
 * `\\wsl.localhost` 9P share creates, where a link is listed but its Linux
 * target cannot be resolved Windows-side — the distribution itself resolves
 * them through bounded, concurrent `wsl.exe … readlink -f` calls. The walk
 * collects every
 * `.dsh/skills` and `.agents/skills` directory it finds — including nested
 * projects, linked-in projects anywhere on the Linux filesystem, and projects
 * reachable through more than one path — and publishes their skills with the
 * same project ranks and sources the host uses, so precedence and duplicate
 * resolution behave identically. Non-WSL lookups return nothing and leave
 * the host's own providers untouched.
 *
 * All filesystem reads go through `node:fs` against the `\\wsl.localhost\…`
 * 9P share (the same substrate `WslFileSystem` uses); the distribution-side
 * resolution rides `wsl.exe` through `execFile` (no shell interpolation), and
 * an injectable IO face keeps the discovery logic unit-testable without a
 * live distro.
 *
 * @module dsh-wsl-workspace/host/wsl-skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join as joinWindowsPath, posix } from 'node:path'
import { isAbsoluteLinuxPath, joinUnc, parseWslUnc, uncToLinux } from '../shared/paths.ts'
import { resolveLinuxSymlinks } from '../shared/links.ts'

/** Project ranks copied from @deepseek-ai/dsh-skill-filesystem so WSL and host entries interleave identically. */
const PROJECT_DSH_RANK = 100
const PROJECT_AGENTS_RANK = 200

/** How many directory levels below the workspace root are scanned. */
const MAX_SCAN_DEPTH = 4
/** Maximum distinct skill directories published per lookup. */
const MAX_SKILL_ROOTS = 64
/** Maximum directories visited per lookup (an absolute blast-radius cap). */
const MAX_VISITED_DIRECTORIES = 4096
/**
 * How many Linux symlinks one lookup may hand to the distribution (a second
 * blast-radius cap, and a latency cap: each resolution is a short `wsl.exe`
 * call, so a tree with hundreds of links cannot stall the catalog).
 */
const MAX_LINK_RESOLUTIONS = 32
/** How many parent levels above the session cwd are searched for a `.git` project marker. */
const MAX_ANCESTOR_WALK = 64
/**
 * How many directories one discovery layer may probe at once.
 *
 * A `readdir` over the `\\wsl.localhost\…` share measured 15.6 ms against 1.6 ms
 * for a `stat`, and a budget-sized walk is 4096 directories: probing one
 * directory at a time costs 20-30 s, which is what a turn in a large workspace
 * used to wait for. The layer stays bounded so the share is never flooded; node's
 * own filesystem thread pool is what ultimately caps the real parallelism.
 */
const WALK_CONCURRENCY = 16
/** Maximum cached lookups (one entry per distinct scan root across sessions). */
const CACHE_MAX_ENTRIES = 32
/**
 * How often a served scan root is re-checked for catalog changes: the skills
 * directories it published, plus one modification stamp per skill file. This is
 * the pass that makes a skill added — or a description edited — mid-session
 * visible on the model's next request.
 */
const REFRESH_POLL_MS = 3_000
/**
 * How often the full re-discovery walk runs for a served scan root. Only a walk
 * can find a skills directory that did not exist before (a new nested project,
 * say), and it costs one `readdir` per visited directory, so it runs on its own
 * slower cadence instead of on every poll. It used to be the only pass, at
 * {@link REFRESH_POLL_MS}'s old value of 10 s.
 */
const DISCOVERY_POLL_MS = 30_000

/** Kebab-case skill names, matching the host grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Directory names that never contain project skill roots (safe to prune while walking). */
const PRUNED_DIRECTORY_NAMES = new Set([
  '.git', '.hg', '.svn', '.bzr', 'node_modules', '.venv', 'venv', '.tox',
  '.pants.d', '.next', '.nuxt', 'dist', 'build', 'out', 'coverage',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache',
  '.idea', '.vscode', '.serverless', '.terraform', '.yarn', '.pnpm-store',
])

/** One `name: value` frontmatter line pair the parser understands. */
interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  content: string
}

/** The provider's minimal skill-candidate contract (mirrors @deepseek-ai/dsh-skill). */
export interface WslSkillCandidate {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { modelInvocable: boolean; userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly rank: number
  readonly locator: { path: string; directory: string }
  readonly path: string
}

/** The provider's minimal skill-definition contract (candidate plus body). */
export interface WslSkillDefinition extends WslSkillCandidate {
  readonly content: string
}

/** Lookup options the registry passes to `list`/`get`. */
export interface WslSkillLookupOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
}

/** Registration-scoped lifecycle face passed to the provider constructor. */
export interface WslSkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** The `ctx.skills` registry face this provider registers on (optional service). */
export interface WslSkillsRegistryFace {
  registerProvider(create: (control: WslSkillProviderControl) => {
    readonly name: string
    list(options: WslSkillLookupOptions): Promise<unknown>
    get(candidate: WslSkillCandidate, options: WslSkillLookupOptions): Promise<unknown>
  }): () => void
}

/** Injectable filesystem face (defaults to node:fs/promises on the real 9P share). */
export interface WslSkillIo {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  readFile(path: string, options: { encoding: 'utf8' }): Promise<string>
  /**
   * Stat one path. `mtimeMs`/`size` are optional because the change detector
   * uses them only where the substrate reports them: a face without them still
   * lists skills, it just cannot notice an edit to an existing skill file.
   */
  stat(path: string): Promise<{ isDirectory(): boolean; mtimeMs?: number; size?: number }>
  /**
   * Resolve Linux symlink targets the share itself cannot follow, returning
   * each real path in the same UNC spelling (`undefined` where a link cannot
   * be resolved). Optional: a substrate that follows links locally leaves this
   * unimplemented, and the walk then never pays for a distribution round trip.
   */
  resolveLinks?(uncPaths: readonly string[]): Promise<(string | undefined)[]>
}

/** The node:fs/promises implementation the provider uses in production. */
export const nodeSkillIo: WslSkillIo = {
  readdir: async (path, options) => readdir(path, options),
  readFile: async (path, options) => readFile(path, options),
  stat: async path => stat(path),
  resolveLinks: async uncPaths => resolveLinuxSymlinks(uncPaths),
}

/** One discovered skill directory under a WSL workspace. */
interface SkillRoot {
  /** Absolute UNC path of the skills directory (`…\.dsh\skills`). */
  path: string
  /** Host source label ('project-dsh' | 'project-agents'). */
  source: 'project-dsh' | 'project-agents'
  /** Host project rank so same-name wins and precedence stay consistent. */
  rank: number
}

/** Whether a skills-directory entry is a directory-bundle or a flat markdown skill. */
interface SkillEntry {
  name: string
  kind: 'bundle' | 'flat'
  path: string
}

/**
 * Locate the nearest ancestor of `linuxDir` (the directory itself included)
 * containing a `.git` marker, mirroring the host skill-filesystem's
 * project-root rule. `.git` may be a directory or a worktree pointer file;
 * existence is enough. Bounded so a pathological path cannot spin the walk.
 * @param distro - the WSL distribution name.
 * @param linuxDir - the session cwd's absolute Linux path.
 * @param io - filesystem face.
 * @returns the project root's Linux path, or `undefined` when no ancestor carries a `.git`.
 */
async function nearestGitAncestor(distro: string, linuxDir: string, io: WslSkillIo): Promise<string | undefined> {
  let current = linuxDir
  for (let levels = 0; levels <= MAX_ANCESTOR_WALK; levels += 1) {
    try {
      await io.stat(joinUnc(distro, posix.join(current, '.git')))
      return current
    } catch {
      // No `.git` marker at this level; keep walking towards the filesystem root.
    }
    const parent = posix.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** What one walk step learns about one directory. */
interface DirectoryProbe {
  /** The skill roots the directory publishes, `.dsh` before `.agents`. */
  readonly roots: SkillRoot[]
  /** Its child directories to descend into, as `[linux path, depth]`. */
  readonly children: [string, number][]
  /** Links its listing showed that the share itself could not follow. */
  readonly links: [string, number][]
}

/**
 * Everything the walk learns from one directory, in the order the round trips
 * are worth paying for: the listing first — it also says which skill markers can
 * exist there at all — then the markers it showed.
 * @param distro - the WSL distribution name.
 * @param dir - the directory's Linux path.
 * @param depth - its depth below the scan root.
 * @param io - filesystem face.
 * @returns the directory's roots, child directories and unresolved links.
 */
async function probeDirectory(distro: string, dir: string, depth: number, io: WslSkillIo): Promise<DirectoryProbe> {
  let entries: Dirent[] | undefined
  if (depth < MAX_SCAN_DEPTH) {
    try {
      entries = await io.readdir(joinUnc(distro, dir), { withFileTypes: true })
    } catch {
      // An unreadable directory (permissions, vanished mid-walk) prunes its
      // subtree, but the directory's own markers may still be worth probing.
    }
  }
  const listed = entries ?? []
  const allMarkers = PROJECT_SKILL_MARKERS.map(([marker]) => marker)
  const markers = entries === undefined
    ? allMarkers
    : allMarkers.filter(marker => listed.some(entry => entry.name === marker))
  const roots = await skillRootsOfDirectory(distro, dir, io, markers)
  const children: [string, number][] = []
  const links: [string, number][] = []
  for (const entry of listed) {
    if (PRUNED_DIRECTORY_NAMES.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.name !== '.dsh' && entry.name !== '.agents') continue
    if (entry.name === '.dsh' || entry.name === '.agents') continue
    const childPath = posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      children.push([childPath, depth + 1])
      continue
    }
    if (!entry.isSymbolicLink()) continue
    // A project may be linked into the workspace via a directory symlink;
    // follow it when the target is a directory. Symlink cycles stay
    // bounded: every hop increments the depth (capped by MAX_SCAN_DEPTH)
    // and the walk as a whole by MAX_VISITED_DIRECTORIES.
    try {
      const target = await io.stat(joinUnc(distro, childPath))
      if (target.isDirectory()) {
        // A substrate that resolves Linux links itself answers here with the
        // target's own type: follow the link directly.
        children.push([childPath, depth + 1])
        continue
      }
      // The stat answered and did not report a directory on a path the listing
      // called a symlink. On the `\\wsl.localhost` 9P share that is what a link
      // to a Linux directory looks like on both substrates: the stat SUCCEEDS
      // (it does not throw) because the share describes the reparse point,
      // never its target, so `isDirectory()` is false and `isFile()` is true
      // for a directory link exactly as for a file link. Dropping it here is
      // what used to make a linked-in project invisible; the distinction is
      // real, not a guess (measured on WSL1 and WSL2: link-dir `stat` succeeds
      // with dir=false, `lstat` throws EISDIR). Hand it to the distribution
      // below, which resolves the target from inside Linux and re-stats it:
      // that re-stat at the resolution step is what still rejects a link to a
      // file, so it never costs a directory walk over one.
    } catch {
      // The share reports the link entry but every Windows-side stat on it
      // fails (a dangling link, or a build that answers `lstat` with EISDIR);
      // the distribution below can still resolve it.
    }
    links.push([childPath, depth + 1])
  }
  return { roots, children, links }
}

/** The result of one discovery walk: the roots it published and what its link budget could not afford. */
interface DiscoveryResult {
  /** The skill directories the walk found, bounded by depth, visited-set and root budget. */
  readonly roots: SkillRoot[]
  /**
   * How many links this walk queued for distribution resolution but never handed
   * to `resolveLinks` because {@link MAX_LINK_RESOLUTIONS} was exhausted. Zero on
   * a walk that stayed within budget (or one whose substrate resolves links
   * itself, where no resolution was ever requested). Counted at the point the
   * budget is spent rather than derived from a running total afterwards, so the
   * figure cannot drift from what the call site actually did.
   */
  readonly linksDropped: number
}

/**
 * Scan a WSL workspace root for nested skill directories.
 *
 * A layer is probed concurrently but published in frontier order, so the
 * catalog never depends on which probe happened to finish first, and the budget
 * is claimed before any probe starts: concurrency must not change what is
 * visited, only how long it takes.
 * @param distro - the WSL distribution name.
 * @param linuxRoot - the workspace's absolute Linux path.
 * @param io - filesystem face.
 * @returns the discovered skill directories (bounded by depth and budget) and
 *   the count of links the link budget forced it to leave unresolved.
 */
async function discoverSkillRoots(distro: string, linuxRoot: string, io: WslSkillIo): Promise<DiscoveryResult> {
  const roots: SkillRoot[] = []
  const visited = new Set<string>()
  let linksResolved = 0
  let linksDropped = 0
  // BFS layers so the budget prunes the widest, most redundant levels first
  // (shallow skill dirs matter most): [path, depth] pairs.
  let frontier: [string, number][] = [[linuxRoot, 0]]
  while (frontier.length > 0 && roots.length < MAX_SKILL_ROOTS) {
    const layer: [string, number][] = []
    for (const item of frontier) {
      if (visited.size >= MAX_VISITED_DIRECTORIES) break
      if (visited.has(item[0])) continue
      visited.add(item[0])
      layer.push(item)
    }
    if (layer.length === 0) return { roots, linksDropped }
    const probes = new Array<DirectoryProbe | undefined>(layer.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, layer.length) }, async () => {
      for (let index = next; index < layer.length; index = next) {
        next += 1
        const [dir, depth] = layer[index]!
        probes[index] = await probeDirectory(distro, dir, depth, io)
      }
    }))
    const nextLayer: [string, number][] = []
    // Symlink targets the share could not follow, resolved for this whole
    // layer in one distribution round trip after the layer is enumerated.
    const links: [string, number][] = []
    for (const probe of probes) {
      if (probe === undefined) continue
      if (roots.length < MAX_SKILL_ROOTS) {
        roots.push(...probe.roots.slice(0, MAX_SKILL_ROOTS - roots.length))
      }
      nextLayer.push(...probe.children)
      links.push(...probe.links)
    }
    // The budget ran out inside this layer: stop where the walk stops, without
    // paying for this layer's link resolution either.
    if (visited.size >= MAX_VISITED_DIRECTORIES) return { roots, linksDropped }
    if (links.length > 0 && io.resolveLinks !== undefined) {
      const remaining = MAX_LINK_RESOLUTIONS - linksResolved
      const batch = links.slice(0, Math.max(0, remaining))
      // Whatever this layer queued beyond the remaining budget never reaches the
      // distribution. It used to vanish with no trace: the cap was documented but
      // the shortfall was not, so a catalog truncated at exactly 32 links was
      // indistinguishable from a complete one. Count it here, where the slice
      // happens, so the number is the amount this guard actually withheld.
      if (batch.length < links.length) linksDropped += links.length - batch.length
      if (batch.length > 0) {
        linksResolved += batch.length
        const resolved = await io.resolveLinks(batch.map(([path]) => joinUnc(distro, path)))
        for (let index = 0; index < batch.length; index += 1) {
          const real = resolved[index]
          if (real === undefined) continue
          // The walk continues at the link's real path, which also collapses a
          // project reachable both directly and through a link onto one visit.
          try {
            const info = await io.stat(real)
            if (info.isDirectory()) nextLayer.push([uncToLinux(real), batch[index]![1]])
          } catch {
            // The distribution resolved a target this share still cannot stat.
          }
        }
      }
    }
    frontier = nextLayer
  }
  return { roots, linksDropped }
}

/** The two project skill markers, with the source and rank each publishes. */
const PROJECT_SKILL_MARKERS = [
  ['.dsh', 'project-dsh', PROJECT_DSH_RANK],
  ['.agents', 'project-agents', PROJECT_AGENTS_RANK],
] as const

/**
 * Publish the skill roots of one scanned directory (its `.dsh/skills` and
 * `.agents/skills`, each with the host's project ranks).
 * @param distro - the WSL distribution name.
 * @param linuxDir - the scanned directory's Linux path.
 * @param io - filesystem face.
 * @param markers - the markers worth probing. The walk narrows this to the ones
 *   its listing actually showed, because each probe is a round trip and a
 *   directory without a `.dsh` entry cannot hold `.dsh/skills`.
 * @returns the directory's skill roots that exist.
 */
async function skillRootsOfDirectory(
  distro: string,
  linuxDir: string,
  io: WslSkillIo,
  markers: readonly string[] = PROJECT_SKILL_MARKERS.map(([marker]) => marker),
): Promise<SkillRoot[]> {
  const result: SkillRoot[] = []
  for (const [marker, source, rank] of PROJECT_SKILL_MARKERS) {
    if (!markers.includes(marker)) continue
    const path = joinUnc(distro, posix.join(linuxDir, marker, 'skills'))
    try {
      const info = await io.stat(path)
      if (info.isDirectory()) result.push({ path, source, rank })
    } catch {
      // Absent skills directory: nothing to publish.
    }
  }
  return result
}

/** List one skills directory's entries (directory bundles and flat `.md` skills). */
async function listSkillEntries(root: SkillRoot, io: WslSkillIo): Promise<SkillEntry[]> {
  let dirents: Dirent[]
  try {
    dirents = await io.readdir(root.path, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: SkillEntry[] = []
  for (const entry of dirents) {
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: 'bundle', path: joinWindowsPath(root.path, entry.name, 'SKILL.md') })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      entries.push({ name: entry.name.slice(0, -3), kind: 'flat', path: joinWindowsPath(root.path, entry.name) })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The published shape of one skills directory: its path, then each skill's name,
 * kind and modification stamp.
 *
 * The stamp is what makes an edit to an *existing* skill visible: the catalog the
 * model sees is rebuilt only when the registry's revision moves, and a directory
 * listing alone cannot tell a rewritten `SKILL.md` from an untouched one. One
 * `stat` per skill file (never a read) is the whole cost, and a file that cannot
 * be stamped reports the same `gone` marker on every pass, so a substrate that
 * does not expose modification times simply never triggers on content.
 * @param root - the skills directory.
 * @param entries - its entries, as just listed.
 * @param io - filesystem face.
 * @returns the deterministic shape string for this directory.
 */
async function shapeOfRoot(root: SkillRoot, entries: readonly SkillEntry[], io: WslSkillIo): Promise<string> {
  const stamps = await Promise.all(entries.map(async (entry) => {
    try {
      const info = await io.stat(entry.path)
      return `${entry.name}:${entry.kind}:${info.mtimeMs ?? 0}:${info.size ?? 0}`
    } catch {
      return `${entry.name}:${entry.kind}:gone`
    }
  }))
  return `${root.path}\u0001${stamps.sort().join(',')}`
}

/** Read and parse one skill file; `undefined` when missing or unparsable. */
async function readSkill(path: string, io: WslSkillIo, signal?: AbortSignal): Promise<ParsedSkill | undefined> {
  signal?.throwIfAborted()
  let raw: string
  try {
    raw = await io.readFile(path, { encoding: 'utf8' })
  } catch {
    return undefined
  }
  signal?.throwIfAborted()
  return parseSkillFrontmatter(raw, path)
}

/**
 * Parse the frontmatter subset skill files use: `---` fenced YAML with
 * `name` / `description` / `whenToUse` / `user-invocable` /
 * `disable-model-invocation`. Single-line scalars and block scalars
 * (`|` literal, `>` folded) are understood; anything else is skipped,
 * matching the shipped provider's leniency: a bad file must not fail
 * the catalog.
 */
function parseSkillFrontmatter(raw: string, path: string): ParsedSkill | undefined {
  // Windows editors save UTF-8 with a BOM; a leading BOM must not make the
  // opening `---` line unmatchable and silently drop the skill.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findFrontmatterEnd(raw, start)
  if (closing === undefined) return undefined
  const lines = raw.slice(start, closing).split('\n')
  const fields = new Map<string, string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '')
    const block = /^([A-Za-z0-9-]+):\s*([|>])[+-]?\s*$/.exec(line)
    if (block !== null) {
      const value = parseBlockScalar(lines, index, block[2] === '>')
      index = value.nextLineIndex
      if (value.text !== '') fields.set(block[1] ?? '', value.text)
      continue
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2]?.trim() ?? ''
    if (value !== '') fields.set(match[1] ?? '', unquote(value))
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (!SKILL_NAME.test(name) || description === '') {
    return undefined
  }
  const whenToUse = fields.get('whenToUse')
  return {
    name,
    description,
    ...whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {},
    invocation: {
      modelInvocable: !frontmatterBoolean(fields, 'disable-model-invocation'),
      userInvocable: frontmatterBoolean(fields, 'user-invocable', true),
    },
    // `findFrontmatterEnd` returns the index of the body's FIRST character
    // (the newline after the closing `---` plus one), so slicing at `closing`
    // is what keeps it: `closing + 1` dropped the body's first character and
    // made the byte after the delimiter look like the body.
    content: raw.slice(closing).trim(),
  }
}

/**
 * Collect a YAML block scalar (`key: |` literal or `key: >` folded) starting
 * at `startIndex`'s following lines. The block runs until the first
 * non-indented, non-blank line; its common indentation is stripped.
 * @returns the scalar text and the index of the last consumed line.
 */
function parseBlockScalar(
  lines: string[],
  startIndex: number,
  folded: boolean,
): { text: string; nextLineIndex: number } {
  const collected: string[] = []
  let indent: string | undefined
  let index = startIndex
  while (index + 1 < lines.length) {
    index += 1
    const next = (lines[index] ?? '').replace(/\r$/, '')
    if (next.trim() === '') {
      collected.push('')
      continue
    }
    const indented = /^([ \t]+)(.*)$/.exec(next)
    if (indented === null) {
      index -= 1
      break
    }
    indent ??= indented[1]
    collected.push(indented[1]?.startsWith(indent) === true ? indented[2] : indented[1].replace(/^[ \t]+/, '') + indented[2])
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  const text = (folded ? collected.filter(line => line !== '').join(' ') : collected.join('\n')).trim()
  return { text, nextLineIndex: index }
}

/** Locate the closing `---` line of a frontmatter block. */
function findFrontmatterEnd(raw: string, start: number): number | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') return lineEnd + 1
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** Strip one level of matching quotes from a scalar value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Boolean semantics for `user-invocable` / `disable-model-invocation` (matches the host parser). */
function frontmatterBoolean(fields: Map<string, string>, key: string, dflt = false): boolean {
  const value = fields.get(key)
  if (value === undefined) return dflt
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false
    default:
      return dflt
  }
}

/**
 * The WSL workspace skill provider. Registered on the host's `ctx.skills`
 * registry; serves only lookups whose cwd is a WSL UNC workspace path.
 *
 * Completed `list()` lookups are cached per scan root and served as-is: a lookup
 * is on the session's request path, and re-walking the tree there is what made
 * every turn in a large workspace wait for a 4096-directory scan of the 9P
 * share. `get()` always re-reads the skill file so body edits are picked up
 * immediately.
 *
 * A scan root that has been served is re-checked every REFRESH_POLL_MS: the
 * host cannot watch a `\\wsl.localhost\…` path (which is why the generated
 * preset pins `watch: false`), so this provider watches for it instead. A
 * changed directory listing clears the cache and calls `control.invalidate()`,
 * which bumps the registry's revision; the catalog middleware re-collects on
 * the session's next request, so a skill added mid-session reaches the model
 * without starting a new session, and the cache is only ever refilled by a
 * lookup the detector has already invalidated.
 */
export class WslSkillsProvider {
  readonly name = 'wsl-workspace'
  private readonly control: WslSkillProviderControl
  private readonly io: WslSkillIo
  private readonly refreshMs: number
  /** Cheap polls between two full discovery walks (at least one). */
  private readonly walkEveryPolls: number
  /** The published catalog per scan root, served until its detector drops it. */
  private readonly cache = new Map<string, WslSkillCandidate[]>()
  /** One change detector per served scan root, keyed like {@link cache}. */
  private readonly detectors = new Map<string, {
    timer: ReturnType<typeof setInterval>
    signature: string
    roots: readonly SkillRoot[]
    polls: number
    /** True while a poll is still in flight, so a slow pass cannot stack up. */
    busy: boolean
  }>()

  constructor(
    control: WslSkillProviderControl,
    io: WslSkillIo = nodeSkillIo,
    refreshMs: number = REFRESH_POLL_MS,
    discoveryMs: number = DISCOVERY_POLL_MS,
  ) {
    this.control = control
    this.io = io
    this.refreshMs = refreshMs
    // Counted in polls rather than read off the clock: a poll is what the
    // cadence is measured in, and an injected clock (tests) may stand still.
    this.walkEveryPolls = Math.max(1, Math.round(discoveryMs / refreshMs))
  }

  /**
   * Discover nested project skills for a WSL UNC session workspace.
   * @param options - lookup options; `cwd` selects the WSL workspace.
   * @returns candidates for every `.dsh/skills` / `.agents/skills` under the
   *   session's scan root — the nearest `.git` ancestor of the cwd, else the
   *   cwd itself — or an empty array for non-WSL lookups.
   */
  async list(options: WslSkillLookupOptions): Promise<WslSkillCandidate[]> {
    this.control.signal.throwIfAborted()
    options.signal?.throwIfAborted()
    const unc = options.cwd === undefined ? null : parseWslUnc(options.cwd)
    if (unc === null) return []
    // Host parity: the session's project root is the nearest `.git` ancestor
    // of the cwd, so lookups from inside a project subtree still see that
    // project's skills; nested projects below it join via the bounded BFS.
    // Without a `.git` ancestor the session cwd itself is the scan root (the
    // issue #10 workspace layout).
    const scanRoot = (await nearestGitAncestor(unc.distro, unc.linuxPath, this.io)) ?? unc.linuxPath
    const cacheKey = `${unc.distro}\u0000${scanRoot}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      // Published already: serve it without touching the share again. The
      // detector this lookup once started is what notices a change, and it
      // drops this entry before the next request can be served from it.
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return [...cached]
    }
    const { roots, linksDropped } = await discoverSkillRoots(unc.distro, scanRoot, this.io)
    // The catalog a caller receives is only ever the survivors of the walk's
    // caps, and until this point none of them said so. The link budget is the one
    // that became easy to hit (every directory link costs a unit since the walk
    // started handing unresolvable directory links to the distribution), so a
    // monorepo aggregating 30+ linked packages could be served a catalog missing
    // every skill past the 32nd with nothing to distinguish it from a complete
    // one. Reported once per lookup, not once per dropped link, and at warn
    // because it means the answer is known to be partial.
    if (linksDropped > 0) {
      console.warn(
        `dsh-wsl-workspace: skills: link budget (${MAX_LINK_RESOLUTIONS}) exhausted; `
        + `${linksDropped} link${linksDropped === 1 ? '' : 's'} under ${scanRoot} were not resolved, `
        + 'so skills reached only through them are missing from this catalog',
      )
    }
    const candidates: WslSkillCandidate[] = []
    const seenSkills = new Set<string>()
    // The catalog's shape (roots, entry names, kinds and one modification stamp
    // per skill file) is collected as the candidates are built, so the change
    // detector starts from what this lookup actually saw instead of paying for a
    // second walk and a second round of stats.
    const signature: string[] = []
    for (const root of roots) {
      const entries = await listSkillEntries(root, this.io)
      signature.push(await shapeOfRoot(root, entries, this.io))
      for (const entry of entries) {
        options.signal?.throwIfAborted()
        const parsed = await readSkill(entry.path, this.io, options.signal)
        if (parsed === undefined) continue
        // A project reachable through both its real path and a directory
        // symlink yields aliasing roots whose locators differ; publish each
        // distinct (name, body) once so the catalog shows no duplicates.
        const fingerprint = `${parsed.name}\u0000${parsed.content}`
        if (seenSkills.has(fingerprint)) continue
        seenSkills.add(fingerprint)
        candidates.push({
          name: parsed.name,
          description: parsed.description,
          ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
          invocation: parsed.invocation,
          source: root.source,
          provider: this.name,
          rank: root.rank,
          locator: {
            path: entry.path,
            directory: entry.kind === 'bundle'
              ? joinWindowsPath(entry.path, '..')
              : root.path,
          },
          path: entry.path,
        })
      }
    }
    this.cache.set(cacheKey, candidates)
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.watch(cacheKey, unc.distro, scanRoot, signature.join('\u0002'), roots)
    // A copy, so a caller that mutates the list it got cannot poison the cache.
    return [...candidates]
  }

  /**
   * Keep one scan root's catalog honest for as long as this provider is
   * registered: the host cannot watch a UNC workspace, so the provider polls the
   * shape it just published and, on any difference, drops its own cache and asks
   * the registry to re-collect for the session's next request.
   *
   * Two passes keep that affordable: the cheap one (every
   * {@link REFRESH_POLL_MS}) re-reads the skills directories already published
   * and re-stats their skill files, so an added, removed or edited skill is
   * noticed on its own; the full re-discovery walk (every
   * {@link DISCOVERY_POLL_MS}) is what can find a skills directory that did not
   * exist before. Neither pass reads a skill file: the description the catalog
   * shows changes only through the registry's revision.
   * @param cacheKey - this provider's key for the scan root.
   * @param distro - the WSL distribution.
   * @param scanRoot - the Linux path the lookup scanned.
   * @param signature - the shape the lookup just published.
   * @param roots - the skills directories that lookup found.
   */
  private watch(cacheKey: string, distro: string, scanRoot: string, signature: string, roots: readonly SkillRoot[]): void {
    const existing = this.detectors.get(cacheKey)
    if (existing !== undefined) {
      existing.signature = signature
      existing.roots = roots
      return
    }
    const detector = {
      timer: setInterval(() => void this.detect(cacheKey, distro, scanRoot), this.refreshMs),
      signature,
      roots,
      polls: 0,
      busy: false,
    }
    // A pending poll must never hold the host process open (or outlive it).
    if (typeof detector.timer.unref === 'function') detector.timer.unref()
    this.detectors.set(cacheKey, detector)
    this.control.signal.addEventListener('abort', () => {
      clearInterval(detector.timer)
      this.detectors.delete(cacheKey)
    }, { once: true })
  }

  /** One poll: the cheap pass always, the discovery walk on its own cadence. */
  private async detect(cacheKey: string, distro: string, scanRoot: string): Promise<void> {
    const detector = this.detectors.get(cacheKey)
    if (detector === undefined || this.control.signal.aborted) return
    // A pass over a slow share can outlast the interval; letting the timer start
    // another one would stack `wsl.exe` calls and make every later poll read a
    // half-finished shape. One pass at a time per scan root.
    if (detector.busy) return
    detector.busy = true
    try {
      detector.polls += 1
      const walk = detector.polls % this.walkEveryPolls === 0
      let signature: string
      try {
        signature = await this.shape(
          distro,
          walk ? (await discoverSkillRoots(distro, scanRoot, this.io)).roots : detector.roots,
        )
      } catch {
        // A transient read failure keeps the last known shape and retries.
        return
      }
      if (signature === detector.signature) return
      detector.signature = signature
      this.cache.delete(cacheKey)
      this.control.invalidate()
    } finally {
      detector.busy = false
    }
  }

  /** The shape of one root set: paths, entry names, kinds and file stamps. */
  private async shape(distro: string, roots: readonly SkillRoot[]): Promise<string> {
    const parts: string[] = []
    for (const root of roots) {
      parts.push(await shapeOfRoot(root, await listSkillEntries(root, this.io), this.io))
    }
    return parts.join('\u0002')
  }

  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the candidate this provider returned.
   * @param options - lookup options whose signal cancels the read.
   * @returns the full skill, or `undefined` if the file disappeared.
   */
  async get(candidate: WslSkillCandidate, options: WslSkillLookupOptions): Promise<WslSkillDefinition | undefined> {
    this.control.signal.throwIfAborted()
    const parsed = await readSkill(candidate.locator.path, this.io, options.signal)
    if (parsed === undefined || parsed.name !== candidate.name) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      source: candidate.source,
      provider: candidate.provider,
      rank: candidate.rank,
      locator: candidate.locator,
      path: candidate.path,
      content: parsed.content,
    }
  }
}