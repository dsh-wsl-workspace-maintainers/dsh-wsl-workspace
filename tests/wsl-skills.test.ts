/**
 * Unit tests for the WSL workspace skill provider. Run with
 * `node --test tests/wsl-skills.test.ts` from the plugin directory
 * (Node >= 23.6 strips types natively).
 *
 * The provider reads the `\\wsl.localhost\…` 9P share through an injectable
 * IO face; these tests drive that face with an in-memory tree, so they run
 * without a live distro. `tests/repro-e2e.mjs` exercises the same provider
 * against a real WSL tree.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WslSkillsProvider, type WslSkillIo } from '../src/host/wsl-skills.ts'

/** In-memory filesystem node. */
interface FakeNode {
  directory: boolean
  content?: string
  symlink?: boolean
  /** Linux path a symlink points at (absent for the "link node is also the target" shorthand). */
  linkTarget?: string
  children?: Map<string, FakeNode>
}

/** Build an in-memory tree below one WSL UNC root. */
function tree(): FakeNode {
  return { directory: true, children: new Map() }
}

function dir(node: FakeNode, path: string[]): FakeNode {
  let current = node
  for (const segment of path) {
    let child = current.children?.get(segment)
    if (child === undefined) {
      child = { directory: true, children: new Map() }
      current.children?.set(segment, child)
    }
    current = child
  }
  return current
}

/** Mark an existing directory as a directory symlink (the fake has real paths, not link targets). */
function markSymlink(node: FakeNode, path: string[]): void {
  dir(node, path).symlink = true
}

/**
 * Point `fromPath` at an arbitrary Linux path (the `ln -s` layout). The link is
 * its own entry: it carries the target's Linux path but no children of its own,
 * so neither `readdir` nor `stat` can traverse it Windows-side.
 */
function linkAt(node: FakeNode, fromPath: string[], target: string[]): void {
  const parent = dir(node, fromPath.slice(0, -1))
  parent.children?.set(fromPath[fromPath.length - 1] ?? '', {
    directory: true,
    symlink: true,
    linkTarget: `/${target.join('/')}`,
  })
}

/** Point `fromPath` at the existing directory `toPath`, modelling a directory symlink. */
function linkDir(node: FakeNode, fromPath: string[], toPath: string[]): void {
  dir(node, toPath)
  linkAt(node, fromPath, toPath)
}

function file(node: FakeNode, path: string[], content: string): void {
  const parent = dir(node, path.slice(0, -1))
  parent.children?.set(path[path.length - 1] ?? '', { directory: false, content })
}

const SKILL_MD = (name: string, description: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`

/** The UNC spelling of a Linux path inside the fake tree's distro. */
function unc(linux: string): string {
  return `\\\\wsl.localhost\\Ubuntu${linux.replace(/\//g, '\\')}`
}

/**
 * Build the injectable IO face over a fake tree.
 * @param root - the fake tree's root.
 * @param options.resolveSymlinks - the share itself follows links (a future or
 *   non-9P substrate); `false` models the `\\wsl.localhost` share.
 * @param options.distributionFallback - implement the `wsl.exe readlink`
 *   fallback face the real `nodeSkillIo` provides.
 */
function createIo(
  root: FakeNode,
  options: { resolveSymlinks?: boolean; distributionFallback?: boolean } = {},
): WslSkillIo {
  const resolveSymlinks = options.resolveSymlinks ?? false
  /** The Linux path a UNC or Windows spelling names. */
  const linuxOf = (path: string): string | undefined => {
    // Provider hands over `\\wsl.localhost\<distro>\<linux>` UNC spellings.
    const forward = path.replace(/\\/g, '/')
    const match = /^\/\/wsl\.localhost\/[^/]+(\/.*)?$/.exec(forward)
    return match === null ? undefined : (match[1] ?? '/')
  }
  const lookup = (linux: string): FakeNode | undefined => {
    let current = root
    for (const segment of linux.split('/').filter(segment => segment.length > 0)) {
      const child = current.children?.get(segment)
      if (child === undefined) return undefined
      current = child
    }
    return current
  }
  /** Follow symlink hops the way the kernel's realpath would. */
  const realNode = (node: FakeNode): FakeNode | undefined => {
    let current: FakeNode | undefined = node
    for (let hops = 0; hops < 40 && current !== undefined; hops += 1) {
      if (current.symlink !== true || current.linkTarget === undefined) return current
      current = lookup(current.linkTarget)
    }
    return undefined
  }
  /** The real Linux path of a link chain, or `undefined` when it does not resolve. */
  const realPath = (linux: string): string | undefined => {
    let current = linux
    for (let hops = 0; hops < 40; hops += 1) {
      const node = lookup(current)
      if (node === undefined) return undefined
      if (node.symlink !== true) return current
      if (node.linkTarget === undefined) return undefined
      current = node.linkTarget
    }
    return undefined
  }
  const io: WslSkillIo = {
    readdir: async (path) => {
      const linux = linuxOf(path)
      const node = linux === undefined ? undefined : lookup(linux)
      if (node === undefined || !node.directory) throw new Error(`ENOENT: ${path}`)
      // The 9P share lists a link entry but cannot list through it.
      const listed = node.symlink === true ? (resolveSymlinks ? realNode(node) : undefined) : node
      if (listed === undefined) throw new Error(`ENOENT (9P cannot follow): ${path}`)
      return [...(listed.children?.entries() ?? [])].map(([name, child]) => ({
        name,
        isDirectory: () => child.directory && child.symlink !== true,
        isFile: () => !child.directory,
        isSymbolicLink: () => child.symlink === true,
      }))
    },
    readFile: async (path) => {
      const linux = linuxOf(path)
      const node = linux === undefined ? undefined : lookup(linux)
      if (node === undefined || node.directory) throw new Error(`ENOENT: ${path}`)
      return node.content ?? ''
    },
    stat: async (path) => {
      const linux = linuxOf(path)
      let node = linux === undefined ? undefined : lookup(linux)
      if (node === undefined) {
        throw new Error(`ENOENT (9P cannot follow): ${path}`)
      }
      if (node.symlink === true) {
        // Model the `\\wsl.localhost` 9P share by default: Linux symlinks are
        // reported by readdir but their targets cannot be resolved Windows-side.
        if (!resolveSymlinks) throw new Error(`ENOENT (9P cannot follow): ${path}`)
        node = realNode(node)
        if (node === undefined) throw new Error(`ENOENT: ${path}`)
      }
      return { isDirectory: () => node.directory, ...stampOf(node) }
    },
  }
  if (options.distributionFallback === true) {
    io.resolveLinks = async (paths) => paths.map((path) => {
      const linux = linuxOf(path)
      const real = linux === undefined ? undefined : realPath(linux)
      return real === undefined ? undefined : unc(real)
    })
  }
  return io
}

/** A no-op registration control (abortable only by the caller). */
function control(): { signal: AbortSignal; invalidate: () => void } {
  return { signal: new AbortController().signal, invalidate: () => {} }
}

/**
 * A content-derived modification stamp for the fake substrate. The real
 * `nodeSkillIo.stat` reports `mtimeMs`/`size`; deriving both from the fixture's
 * content models that without threading a clock through every helper, and it
 * still moves when an edit keeps the file's length unchanged.
 * @param node - the fake file node.
 * @returns the stamp fields `stat` reports.
 */
function stampOf(node: FakeNode): { mtimeMs: number; size: number } {
  const content = node.content ?? ''
  let hash = 7
  for (let index = 0; index < content.length; index += 1) hash = (hash * 31 + content.charCodeAt(index)) % 1_000_000_007
  return { mtimeMs: hash, size: content.length }
}

const CWD_WORKSPACE_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\mille\\repro-ws-root'

test('returns nothing for non-WSL cwds', async () => {
  const provider = new WslSkillsProvider(control(), createIo(tree()))
  assert.deepEqual(await provider.list({ cwd: undefined }), [])
  assert.deepEqual(await provider.list({ cwd: 'D:\\ProgramData\\dsh-wsl-workspace' }), [])
  assert.deepEqual(await provider.list({ cwd: '/home/mille/proj' }), [])
})

test('discovers nested project skills under a WSL workspace root', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'systematic-debugging', 'SKILL.md'],
    SKILL_MD('systematic-debugging', 'Systematic debugging walkthrough'))
  // A nested .agents/skills in a second project.
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-b', '.agents', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-b', '.agents', 'skills', 'writing-plans.md'],
    SKILL_MD('writing-plans', 'Plan writing', 'whenToUse: When a task needs a plan\n'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })

  assert.deepEqual(skills.map(skill => skill.name).sort(), ['brainstorming', 'systematic-debugging', 'writing-plans'])
  const brainstorming = skills.find(skill => skill.name === 'brainstorming')
  assert.ok(brainstorming !== undefined)
  assert.equal(brainstorming.source, 'project-dsh')
  assert.equal(brainstorming.rank, 100)
  assert.equal(brainstorming.provider, 'wsl-workspace')
  assert.equal(brainstorming.locator.path, '\\\\wsl.localhost\\Ubuntu\\home\\mille\\repro-ws-root\\proj-a\\.dsh\\skills\\brainstorming\\SKILL.md')
  assert.equal(brainstorming.locator.directory, '\\\\wsl.localhost\\Ubuntu\\home\\mille\\repro-ws-root\\proj-a\\.dsh\\skills\\brainstorming')
  const plans = skills.find(skill => skill.name === 'writing-plans')
  assert.ok(plans !== undefined)
  assert.equal(plans.source, 'project-agents')
  assert.equal(plans.rank, 200)
  assert.equal(plans.whenToUse, 'When a task needs a plan')
})

test('get() returns the parsed body', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  const definition = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'Body of brainstorming.')
  assert.equal(definition?.name, 'brainstorming')
})

test("get() keeps the body's first character when it starts right after the delimiter", async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  // No blank line between the closing `---` and the body: the existing
  // SKILL_MD fixture always inserts one, and that blank line is exactly what
  // hides an off-by-one in the body slice.
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'tight', 'SKILL.md'],
    '---\nname: tight\ndescription: Body starts immediately\n---\nBody starts immediately.\nSecond line.\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  const definition = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'Body starts immediately.\nSecond line.')
})

test('get() keeps the whole body of a CRLF skill with no blank line after the delimiter', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'crlf', 'SKILL.md'],
    '---\r\nname: crlf\r\ndescription: CRLF tight body\r\n---\r\nCRLF body first line.\r\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  const definition = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'CRLF body first line.')
})
test('parses a skill saved with a UTF-8 BOM', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  // Notepad, VS Code's "UTF-8 with BOM" and PowerShell redirection all write
  // this prefix; without BOM handling the opening `---` never matches and the
  // skill disappears from the catalog entirely.
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'bom.md'],
    '\uFEFF---\nname: bom\ndescription: Saved with a BOM\n---\nBody after the BOM.\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  assert.equal(candidate.name, 'bom')
  assert.equal(candidate.description, 'Saved with a BOM')
  const definition = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'Body after the BOM.')
})

test('parses a BOM skill whose body follows the delimiter directly', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'bom-tight', 'SKILL.md'],
    '\uFEFF---\r\nname: bom-tight\r\ndescription: BOM and a tight body\r\n---\r\nBOM body first character.\r\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  const definition = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'BOM body first character.')
})
test('skips pruned heavy directories and dot-directories while walking', async () => {
  const root = tree()
  // Skills deep inside node_modules or a dot-dir must NOT be discovered.
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', 'node_modules', 'pkg', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', 'node_modules', 'pkg', '.dsh', 'skills', 'hidden.md'],
    SKILL_MD('hidden', 'Must not appear'))
  dir(root, ['home', 'mille', 'repro-ws-root', '.hidden-zone', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', '.hidden-zone', '.dsh', 'skills', 'dot.md'],
    SKILL_MD('dot', 'Must not appear either'))
  // The workspace root's own .dsh/skills is discovered (host-parity).
  dir(root, ['home', 'mille', 'repro-ws-root', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', '.dsh', 'skills', 'root-skill.md'],
    SKILL_MD('root-skill', 'At the workspace root'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['root-skill'])
})

test('skips files without valid frontmatter and ignores unknown fields', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'ok.md'],
    '---\nname: ok\ndescription: Fine skill\nmetadata: { x: 1 }\nuser-invocable: false\ndisable-model-invocation: true\n---\n\nOK body.\n')
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'bad.md'],
    'no frontmatter at all')
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'noname.md'],
    '---\ndescription: Missing name\n---\n\nNope.\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['ok'])
  assert.deepEqual(skills[0]?.invocation, { modelInvocable: false, userInvocable: false })
})

test('respects deep-nesting bounds and skill-root budget', async () => {
  const root = tree()
  // Skills at depth 5 (root=0, proj=1, a=2, b=3, c=4, d=5) exceed MAX_SCAN_DEPTH.
  dir(root, ['home', 'mille', 'repro-ws-root', 'p1', 'p2', 'p3', 'p4', 'deep', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'p1', 'p2', 'p3', 'p4', 'deep', '.dsh', 'skills', 'x.md'],
    SKILL_MD('x', 'Too deep'))
  // An in-bounds skill is still found.
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'shallow.md'],
    SKILL_MD('shallow', 'In bounds'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['shallow'])
})

const CWD_DEEP_IN_PROJECT = '\\\\wsl.localhost\\Ubuntu\\home\\mille\\ws\\proj-a\\src'

test('serves the enclosing project when the cwd sits deeper than the project root', async () => {
  const root = tree()
  // `.git` at `ws` makes it the nearest project root for `ws/proj-a/src`;
  // the host would serve its skills for that cwd, nested ones join via BFS.
  dir(root, ['home', 'mille', 'ws', '.git'])
  dir(root, ['home', 'mille', 'ws', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'ws', '.dsh', 'skills', 'workspace-skill.md'],
    SKILL_MD('workspace-skill', 'At the project root'))
  dir(root, ['home', 'mille', 'ws', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'ws', 'proj-a', '.dsh', 'skills', 'nested-skill.md'],
    SKILL_MD('nested-skill', 'Nested below the project root'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_DEEP_IN_PROJECT })
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['nested-skill', 'workspace-skill'])
})

test('does not leak skills above the nearest .git ancestor', async () => {
  const root = tree()
  // `proj-a` carries the `.git`, so a cwd inside it must see `proj-a`'s
  // skills — and nothing from the enclosing (non-project) directory.
  dir(root, ['home', 'mille', 'ws', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'ws', '.dsh', 'skills', 'outer.md'],
    SKILL_MD('outer', 'Above the project root'))
  dir(root, ['home', 'mille', 'ws', 'proj-a', '.git'])
  dir(root, ['home', 'mille', 'ws', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'ws', 'proj-a', '.dsh', 'skills', 'inner.md'],
    SKILL_MD('inner', 'Inside the project root'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_DEEP_IN_PROJECT })
  assert.deepEqual(skills.map(skill => skill.name), ['inner'])
})

test('never publishes more than the skill-root budget', async () => {
  const root = tree()
  // 63 single-root projects, then one directory carrying both a `.dsh/skills`
  // and an `.agents/skills` root: publishing both unbounded would reach 65.
  for (let i = 0; i < 63; i += 1) {
    dir(root, ['home', 'mille', 'repro-ws-root', `p${i}`, '.dsh', 'skills'])
    file(root, ['home', 'mille', 'repro-ws-root', `p${i}`, '.dsh', 'skills', `s${i}.md`],
      SKILL_MD(`s${i}`, `Skill ${i}`))
  }
  dir(root, ['home', 'mille', 'repro-ws-root', 'last', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'last', '.dsh', 'skills', 'dsh.md'],
    SKILL_MD('dsh', 'Dsh root'))
  dir(root, ['home', 'mille', 'repro-ws-root', 'last', '.agents', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'last', '.agents', 'skills', 'agents.md'],
    SKILL_MD('agents', 'Agents root'))

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.equal(skills.length, 64)
  assert.ok(!skills.some(skill => skill.name === 'agents'))
})

test('serves a completed lookup from cache until its watcher invalidates it', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))

  let readdirCalls = 0
  const io = createIo(root)
  const countingIo: WslSkillIo = {
    readdir: async (path, options) => {
      readdirCalls += 1
      return io.readdir(path, options)
    },
    readFile: io.readFile,
    stat: io.stat,
  }
  const lifecycle = new AbortController()
  let invalidations = 0
  const provider = new WslSkillsProvider(
    { signal: lifecycle.signal, invalidate: () => { invalidations += 1 } },
    countingIo,
    10,
  )

  const first = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  const readsAfterFirst = readdirCalls
  assert.equal(first.length, 1)
  assert.ok(readsAfterFirst > 0)

  // Served from cache: no additional filesystem traffic, however many requests
  // are built from it. A request-path rescan is what made every turn in a large
  // WSL workspace wait for a full walk of the 9P share.
  const second = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.equal(readdirCalls, readsAfterFirst)
  assert.deepEqual(second.map(skill => skill.name), ['brainstorming'])

  // The cached array is a copy: callers cannot poison the cache.
  second.push({ ...second[0]!, name: 'poison' })
  const third = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(third.map(skill => skill.name), ['brainstorming'])
  assert.equal(readdirCalls, readsAfterFirst)

  // Only the watcher can move the catalog: it drops the cache, and the next
  // lookup — and only that lookup — walks the tree again.
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'late.md'],
    SKILL_MD('late', 'Added after caching'))
  await delay(60)
  assert.equal(invalidations, 1)
  const fourth = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(readdirCalls > readsAfterFirst)
  assert.deepEqual(fourth.map(skill => skill.name).sort(), ['brainstorming', 'late'])
  lifecycle.abort()
})

test('get() re-reads the body instead of serving a cached one', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))
  const provider = new WslSkillsProvider(control(), createIo(root))
  const [candidate] = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.ok(candidate !== undefined)
  const before = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(before?.content, 'Body of brainstorming.')
  file(root, ['home', 'mille', 'repro-ws-root', 'proj-a', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    '---\nname: brainstorming\ndescription: Structured brainstorming\n---\n\nRewritten body.\n')
  const after = await provider.get(candidate, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(after?.content, 'Rewritten body.')
})

test('prunes unresolvable directory symlinks without failing the scan', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))
  // A Linux symlink into the workspace (the 9P share cannot resolve its
  // target) and a dangling link must both be skipped without noise.
  markSymlink(root, ['home', 'mille', 'repro-ws-root', 'linked-project'])
  {
    const parent = dir(root, ['home', 'mille', 'repro-ws-root'])
    parent.children?.set('dangling', { directory: false, symlink: true })
  }

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['brainstorming'])
})

test('publishes aliased skill files once when the substrate resolves symlinks', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'linked-project'], ['home', 'mille', 'repro-ws-root', 'real-project'])

  // A substrate that resolves symlink targets (e.g. a future share or a
  // local-directory lookup): the project is discovered via both paths and
  // the name+body fingerprint dedupe must publish it exactly once.
  const provider = new WslSkillsProvider(control(), createIo(root, { resolveSymlinks: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['brainstorming'])
})

test('bounds symlink hops by the depth budget on resolving substrates', async () => {
  const root = tree()
  markSymlink(root, ['home', 'mille', 'repro-ws-root', 'p1', 'p2', 'p3', 'p4', 'p5'])
  const provider = new WslSkillsProvider(control(), createIo(root, { resolveSymlinks: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills, [])
})

test('follows a linked-in project through the distribution when the share cannot', async () => {
  const root = tree()
  // The `ln -s` layout issue #10 users hit: the real project lives outside the
  // workspace, only its link is inside it. The 9P share lists the link entry
  // and then cannot resolve it; the distribution can.
  dir(root, ['home', 'mille', 'repro-ws-root'])
  dir(root, ['srv', 'projects', 'linked-project', '.dsh', 'skills'])
  file(root, ['srv', 'projects', 'linked-project', '.dsh', 'skills', 'linked-skill', 'SKILL.md'],
    SKILL_MD('linked-skill', 'Reached through a Linux symlink'))
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'linked-project'], ['srv', 'projects', 'linked-project'])

  const provider = new WslSkillsProvider(control(), createIo(root, { distributionFallback: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })

  assert.deepEqual(skills.map(skill => skill.name), ['linked-skill'])
  // The walk continues at the real path, which is the one this share can read.
  assert.equal(skills[0]?.locator.path,
    '\\\\wsl.localhost\\Ubuntu\\srv\\projects\\linked-project\\.dsh\\skills\\linked-skill\\SKILL.md')
  const definition = await provider.get(skills[0]!, { cwd: CWD_WORKSPACE_ROOT })
  assert.equal(definition?.content, 'Body of linked-skill.')
})

test('keeps walking below a linked-in project and does not publish it twice', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills', 'outer', 'SKILL.md'],
    SKILL_MD('outer', 'At the linked project root'))
  // A nested project under the link target still joins via the BFS.
  dir(root, ['home', 'mille', 'repro-ws-root', 'real-project', 'nested', '.agents', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'real-project', 'nested', '.agents', 'skills', 'nested.md'],
    SKILL_MD('nested', 'Below the linked project'))
  // The same project is reachable directly and through a second link.
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'alias-a'], ['home', 'mille', 'repro-ws-root', 'real-project'])
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'alias-b'], ['home', 'mille', 'repro-ws-root', 'real-project'])

  const provider = new WslSkillsProvider(control(), createIo(root, { distributionFallback: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['nested', 'outer'])
})

test('skips links the distribution resolves to a file or cannot resolve at all', async () => {
  const root = tree()
  file(root, ['home', 'mille', 'repro-ws-root', 'notes.md'], '# notes\n')
  linkAt(root, ['home', 'mille', 'repro-ws-root', 'notes-link'], ['home', 'mille', 'repro-ws-root', 'notes.md'])
  // Dangling: `readlink -f` answers with a path that does not exist.
  linkAt(root, ['home', 'mille', 'repro-ws-root', 'broken'], ['srv', 'never-created'])
  // A project symlink whose target the share still cannot stat after resolution.
  linkAt(root, ['home', 'mille', 'repro-ws-root', 'ghost'], ['srv', 'ghost-project'])
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'real.md'],
    SKILL_MD('real', 'A plain in-workspace project'))

  const provider = new WslSkillsProvider(control(), createIo(root, { distributionFallback: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['real'])
})

test('stays bounded when the distribution resolves a link back to an ancestor', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'once.md'],
    SKILL_MD('once', 'Published once despite the loop'))
  // `proj/loop -> workspace root`: a cycle the visited set must absorb.
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'proj', 'loop'], ['home', 'mille', 'repro-ws-root'])

  const provider = new WslSkillsProvider(control(), createIo(root, { distributionFallback: true }))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['once'])
})

test('does not call the distribution when the share resolves links itself', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'real-project', '.dsh', 'skills', 'brainstorming', 'SKILL.md'],
    SKILL_MD('brainstorming', 'Structured brainstorming'))
  linkDir(root, ['home', 'mille', 'repro-ws-root', 'linked-project'], ['home', 'mille', 'repro-ws-root', 'real-project'])

  const base = createIo(root, { resolveSymlinks: true, distributionFallback: true })
  let resolveCalls = 0
  const io: WslSkillIo = {
    ...base,
    resolveLinks: async (paths) => {
      resolveCalls += 1
      return base.resolveLinks!(paths)
    },
  }
  const provider = new WslSkillsProvider(control(), io)
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['brainstorming'])
  assert.equal(resolveCalls, 0)
})

test('caps how many links one lookup hands to the distribution', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root'])
  for (let i = 0; i < 70; i += 1) {
    dir(root, ['srv', 'targets', `t${i}`, '.dsh', 'skills'])
    file(root, ['srv', 'targets', `t${i}`, '.dsh', 'skills', `s${i}.md`], SKILL_MD(`s${i}`, `Linked skill ${i}`))
    linkDir(root, ['home', 'mille', 'repro-ws-root', `link-${String(i).padStart(2, '0')}`], ['srv', 'targets', `t${i}`])
  }
  const base = createIo(root, { distributionFallback: true })
  let requested = 0
  const io: WslSkillIo = {
    ...base,
    resolveLinks: async (paths) => {
      requested += paths.length
      return base.resolveLinks!(paths)
    },
  }
  const provider = new WslSkillsProvider(control(), io)
  await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  // 70 links in one layer, but the per-lookup budget stops at 32.
  assert.equal(requested, 32)
})

test('reports exactly how many links the budget forced it to leave unresolved', async () => {
  // Same 70-link shape as the cap test above: one layer, 70 links queued, 32
  // resolved. The walk used to drop the other 38 in silence, so a caller could
  // not tell a complete catalog from a truncated one. The reported figure must
  // equal queued-minus-resolved exactly — an off-by-one would be worse than the
  // silence it replaced.
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root'])
  const LINKS = 70
  for (let i = 0; i < LINKS; i += 1) {
    dir(root, ['srv', 'targets', `t${i}`, '.dsh', 'skills'])
    file(root, ['srv', 'targets', `t${i}`, '.dsh', 'skills', `s${i}.md`], SKILL_MD(`s${i}`, `Linked skill ${i}`))
    linkDir(root, ['home', 'mille', 'repro-ws-root', `link-${String(i).padStart(2, '0')}`], ['srv', 'targets', `t${i}`])
  }
  const base = createIo(root, { distributionFallback: true })
  let resolved = 0
  const io: WslSkillIo = {
    ...base,
    resolveLinks: async (paths) => {
      resolved += paths.length
      return base.resolveLinks!(paths)
    },
  }
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const provider = new WslSkillsProvider(control(), io)
    await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(resolved, 32)
  // One warning per lookup, not one per dropped link.
  assert.equal(warnings.length, 1)
  // The exact shortfall, not merely "some signal": 70 queued − 32 resolved.
  assert.match(warnings[0] ?? '', new RegExp(`\\b${String(LINKS - resolved)}\\b`))
})

test('never asks the distribution for link targets when no lookup needs it', async () => {
  // A plain workspace with no links: the fallback must stay off the hot path.
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'plain.md'], SKILL_MD('plain', 'No links here'))
  const base = createIo(root, { distributionFallback: true })
  let requested = 0
  const io: WslSkillIo = {
    ...base,
    resolveLinks: async (paths) => {
      requested += paths.length
      return base.resolveLinks!(paths)
    },
  }
  const provider = new WslSkillsProvider(control(), io)
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name), ['plain'])
  assert.equal(requested, 0)
})

/** A registration control that counts the invalidations this provider requests. */
function countingControl(): {
  signal: AbortSignal
  invalidate: () => void
  invalidations: () => number
  dispose: () => void
} {
  const lifecycle = new AbortController()
  let count = 0
  return {
    signal: lifecycle.signal,
    invalidate: () => { count += 1 },
    invalidations: () => count,
    dispose: () => lifecycle.abort(),
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('re-checks a served scan root and invalidates when a skill appears', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'first.md'], SKILL_MD('first', 'First skill'))
  const control = countingControl()
  // Only the detector can explain a fresh catalog; a short poll keeps the test
  // quick.
  const provider = new WslSkillsProvider(control, createIo(root), 10)
  assert.deepEqual((await provider.list({ cwd: CWD_WORKSPACE_ROOT })).map(skill => skill.name), ['first'])

  // Nothing changed yet: a few polls must not disturb the registry.
  await delay(40)
  assert.equal(control.invalidations(), 0)

  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'second.md'],
    SKILL_MD('second', 'Added while the session runs'))
  await delay(60)
  assert.equal(control.invalidations(), 1)
  // The detector dropped this provider's cache, so the re-collect sees it.
  assert.deepEqual(
    (await provider.list({ cwd: CWD_WORKSPACE_ROOT })).map(skill => skill.name).sort(),
    ['first', 'second'],
  )

  // A second change invalidates again; without one it stays quiet.
  await delay(40)
  assert.equal(control.invalidations(), 1)
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'third.md'], SKILL_MD('third', 'Third skill'))
  await delay(60)
  assert.equal(control.invalidations(), 2)
  control.dispose()
})

test('stops watching when the registration is disposed', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'first.md'], SKILL_MD('first', 'First skill'))
  const lifecycle = new AbortController()
  let invalidations = 0
  const provider = new WslSkillsProvider(
    { signal: lifecycle.signal, invalidate: () => { invalidations += 1 } },
    createIo(root),
    10,
  )
  await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  lifecycle.abort()
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'late.md'], SKILL_MD('late', 'Too late'))
  await delay(50)
  assert.equal(invalidations, 0)
})

test('publishes a project skill added mid-session as a new scan root too', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root'])
  const control = countingControl()
  const provider = new WslSkillsProvider(control, createIo(root), 10, 10)
  assert.deepEqual(await provider.list({ cwd: CWD_WORKSPACE_ROOT }), [])

  dir(root, ['home', 'mille', 'repro-ws-root', 'late-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'late-project', '.dsh', 'skills', 'late.md'],
    SKILL_MD('late', 'A project added mid-session'))
  await delay(60)
  assert.equal(control.invalidations(), 1)
  assert.deepEqual(
    (await provider.list({ cwd: CWD_WORKSPACE_ROOT })).map(skill => skill.name),
    ['late'],
  )
  control.dispose()
})

test('invalidates when an existing skill file is edited, without a directory change', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  const skillFile = ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'first.md']
  file(root, skillFile, SKILL_MD('first', 'Original description'))
  const control = countingControl()
  // The discovery walk is out of reach, so only the cheap pass can explain a
  // fresh catalog: this is the case a directory listing alone cannot see.
  const provider = new WslSkillsProvider(control, createIo(root), 10, 1_000_000)
  assert.deepEqual((await provider.list({ cwd: CWD_WORKSPACE_ROOT })).map(skill => skill.description), ['Original description'])

  await delay(40)
  assert.equal(control.invalidations(), 0, 'an unchanged catalog stays quiet')

  file(root, skillFile, SKILL_MD('first', 'Edited description'))
  await delay(60)
  assert.equal(control.invalidations(), 1, 'an edited skill file invalidates the catalog')
  assert.deepEqual(
    (await provider.list({ cwd: CWD_WORKSPACE_ROOT })).map(skill => skill.description),
    ['Edited description'],
  )

  // Re-publishing the same content must not keep invalidating the registry.
  await delay(40)
  assert.equal(control.invalidations(), 1)
  control.dispose()
})

test('a brand-new skills directory waits for the discovery cadence, not the cheap pass', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root'])
  const control = countingControl()
  const provider = new WslSkillsProvider(control, createIo(root), 10, 1_000_000)
  assert.deepEqual(await provider.list({ cwd: CWD_WORKSPACE_ROOT }), [])

  dir(root, ['home', 'mille', 'repro-ws-root', 'late-project', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'late-project', '.dsh', 'skills', 'late.md'],
    SKILL_MD('late', 'A project added mid-session'))
  await delay(60)
  assert.equal(control.invalidations(), 0, 'the cheap pass only re-checks roots it already published')
  control.dispose()
})

test('a slow poll never stacks up behind itself', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'first.md'], SKILL_MD('first', 'First skill'))
  const control = countingControl()
  const base = createIo(root)
  let reads = 0
  let stalling = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const io: WslSkillIo = {
    ...base,
    readdir: async (path, options) => {
      if (stalling) {
        reads += 1
        // The first poll stalls far past the interval: a second pass must not
        // start on top of it.
        if (reads === 1) await gate
      }
      return base.readdir(path, options)
    },
  }
  const provider = new WslSkillsProvider(control, io, 10)
  await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  stalling = true
  await delay(80)
  const duringStall = reads
  release()
  await delay(40)
  // Without the guard the interval would have started several overlapping walks
  // while the first was still awaiting; with it, one pass at a time.
  assert.equal(duringStall <= 1, true, `polls stacked: ${duringStall} readdir calls while one was stalled`)
  control.dispose()
})

test('parses block scalars in frontmatter', async () => {
  const root = tree()
  dir(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills'])
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'literal.md'],
    '---\nname: literal\ndescription: |\n  First line of the description.\n  Second line.\nwhenToUse: >\n  Folded when-to-use\n  spanning two lines.\nuser-invocable: false\n---\n\nLiteral body.\n')
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'folded.md'],
    '---\nname: folded\ndescription: >\n  A folded description\n  on two source lines.\n---\n\nFolded body.\n')
  file(root, ['home', 'mille', 'repro-ws-root', 'proj', '.dsh', 'skills', 'mixed.md'],
    '---\nname: mixed\ndescription: Single line stays unchanged\nwhenToUse: |\n  Multi-line\n  when to use\n---\n\nMixed body.\n')

  const provider = new WslSkillsProvider(control(), createIo(root))
  const skills = await provider.list({ cwd: CWD_WORKSPACE_ROOT })
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['folded', 'literal', 'mixed'])
  const literal = skills.find(skill => skill.name === 'literal')
  assert.equal(literal?.description, 'First line of the description.\nSecond line.')
  assert.equal(literal?.whenToUse, 'Folded when-to-use spanning two lines.')
  const folded = skills.find(skill => skill.name === 'folded')
  assert.equal(folded?.description, 'A folded description on two source lines.')
  const mixed = skills.find(skill => skill.name === 'mixed')
  assert.equal(mixed?.whenToUse, 'Multi-line\nwhen to use')
})