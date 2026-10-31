/**
 * Unit tests for the WSL search tools (host half).
 *
 * Everything here runs without a distribution: the record framing, the glob
 * matcher, the retention, the renderers and the argv builder are pure, and the
 * parts the host suite owns are checked against that package's own exported
 * formatters and its `present*Result` narrowing, so a wording or shape drift in
 * DSH cannot silently diverge from the WSL twin.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'
import {
  formatGlobOutput,
  formatGrepOutput,
  presentGlobResult,
  presentGrepResult,
  sampleAcrossTopLevel,
} from '@deepseek-ai/dsh-tool-fs-search'
import {
  apply,
  buildWslArgv,
  capMetaBytes,
  displayPath,
  expandBraces,
  globCardPage,
  globSearchMeta,
  globToRegExp,
  grepSearchMeta,
  linuxTarget,
  matchGlob,
  normalizeSpill,
  parseGlobRecords,
  parseGrepRecords,
  renderGlobText,
  renderGrepText,
  resolveTarget,
  retainMatches,
  retainPaths,
} from '../src/host/wsl-search.ts'
import { fakeContext } from './support/fake-context.ts'

/** The resolved plugin config (schemastery fills these in a real mount). */
const CONFIG = {
  grepMaxMatches: 250,
  grepMaxLineBytes: 2000,
  globMaxResults: 100,
  sampleOverCapGlobResults: false,
  searchMetaMaxBytes: 65536,
  rawOutputMaxBytes: 20_000_000,
  timeoutMs: 30_000,
  wslPath: 'wsl.exe',
}

/**
 * Run one assertion set against a workspace store the test owns.
 *
 * A `/mnt/<drive>` session resolves its distribution from the registration the dialog wrote,
 * and the CI runners have no WSL registry to fall back to — so a drive case that did not
 * supply its own entry would be measuring "this machine has no default distribution" rather
 * than the branch under test.
 * @param entries - the store contents, keyed by canonical Windows drive path.
 * @param run - the assertions to make while `DSH_HOME` points at them.
 */
function withStore(entries: Record<string, { distro?: string; username?: string }>, run: () => void | Promise<void>): Promise<void> | void {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-search-store-'))
  writeFileSync(join(home, 'wsl-workspaces.json'), JSON.stringify(entries))
  process.env.DSH_HOME = home
  const restore = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
  const outcome = run()
  if (outcome instanceof Promise) return outcome.finally(restore)
  restore()
}

describe('parseGrepRecords', () => {
  it('frames path, line number and text around colons, spaces and NULs', () => {
    // GNU grep prints `<path>\0<line>:<text>\n` per match, so each NUL-framed
    // segment carries the previous line's text AND the next match's path.
    const stdout = Buffer.from(
      '/ws/a file.txt\u000012:needs: a colon\n/ws/ünï.txt\u00003:中文 ünïcode\n',
      'utf8',
    )
    assert.deepEqual(parseGrepRecords(stdout), [
      { path: '/ws/a file.txt', lineNumber: 12, line: 'needs: a colon' },
      { path: '/ws/ünï.txt', lineNumber: 3, line: '中文 ünïcode' },
    ])
  })

  it('keeps a newline inside a path addressable', () => {
    const stdout = Buffer.from('/ws/od\nd name.txt\u00007:body\n', 'utf8')
    assert.deepEqual(parseGrepRecords(stdout), [
      { path: '/ws/od\nd name.txt', lineNumber: 7, line: 'body' },
    ])
  })

  it('drops a truncated tail and an empty stream without losing earlier matches', () => {
    assert.deepEqual(parseGrepRecords(Buffer.alloc(0)), [])
    assert.deepEqual(parseGrepRecords(Buffer.from('/ws/a.txt\u00001:one\n/ws/b.txt\u0000', 'utf8')), [
      { path: '/ws/a.txt', lineNumber: 1, line: 'one' },
    ])
  })
})

describe('parseGlobRecords', () => {
  it('reads the GNU listing with modification times', () => {
    assert.deepEqual(parseGlobRecords(Buffer.from('G/ws\u0000', 'utf8')), { mode: 'gnu', root: '/ws', files: [] })
    const withFiles = Buffer.from('G/ws\u00001700000000.500000000\t/ws/a.txt\u00001700000001.250000000\t/ws/b c.txt\u0000', 'utf8')
    assert.deepEqual(parseGlobRecords(withFiles), {
      mode: 'gnu',
      root: '/ws',
      files: [
        { path: '/ws/a.txt', mtimeMs: 1_700_000_000_500 },
        { path: '/ws/b c.txt', mtimeMs: 1_700_000_001_250 },
      ],
    })
  })

  it('keeps a root whose own name contains a newline in one piece', () => {
    // The header is NUL terminated for exactly this reason: a line-oriented
    // header silently truncated such a root to its first line.
    const stdout = Buffer.from('G/ws/od\nd dir\u00001700000000.000000000\t/ws/od\nd dir/a.txt\u0000', 'utf8')
    assert.deepEqual(parseGlobRecords(stdout), {
      mode: 'gnu',
      root: '/ws/od\nd dir',
      files: [{ path: '/ws/od\nd dir/a.txt', mtimeMs: 1_700_000_000_000 }],
    })
  })

  it('reads the plain fallback listing without times', () => {
    const stdout = Buffer.from('P/ws\u0000/ws/a.txt\u0000/ws/b.txt\u0000', 'utf8')
    assert.deepEqual(parseGlobRecords(stdout), {
      mode: 'plain',
      root: '/ws',
      files: [
        { path: '/ws/a.txt', mtimeMs: 0 },
        { path: '/ws/b.txt', mtimeMs: 0 },
      ],
    })
  })

  it('tolerates an empty or headerless stream', () => {
    assert.deepEqual(parseGlobRecords(Buffer.alloc(0)), { mode: 'plain', root: '', files: [] })
    assert.deepEqual(parseGlobRecords(Buffer.from('G', 'utf8')), { mode: 'gnu', root: '', files: [] })
  })
})

describe('glob matching', () => {
  it('expands brace alternations', () => {
    assert.deepEqual(expandBraces('*.{js,jsx}'), ['*.js', '*.jsx'])
    assert.deepEqual(expandBraces('src/*.{a,b}.{c,d}'), ['src/*.a.c', 'src/*.a.d', 'src/*.b.c', 'src/*.b.d'])
    assert.deepEqual(expandBraces('plain.ts'), ['plain.ts'])
  })

  it('translates star, globstar, question mark, classes and braces', () => {
    assert.equal(globToRegExp('*').test('a/b'), false)
    assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true)
    assert.equal(globToRegExp('src/*.ts').test('src/deep/a.ts'), false)
    assert.equal(globToRegExp('**/*.ts').test('a.ts'), true)
    assert.equal(globToRegExp('**/*.ts').test('deep/nested/a.ts'), true)
    assert.equal(globToRegExp('a?c').test('abc'), true)
    assert.equal(globToRegExp('a?c').test('a/c'), false)
    assert.equal(globToRegExp('file[0-9].txt').test('file7.txt'), true)
    assert.equal(globToRegExp('file[!0-9].txt').test('filea.txt'), true)
    assert.equal(globToRegExp('*.{js,jsx}').test('a.jsx'), true)
    assert.equal(globToRegExp('a.b').test('axb'), false)
  })

  it('matches a basename when the pattern carries no separator, a path otherwise', () => {
    assert.equal(matchGlob('*.ts', 'src/deep/a.ts'), true)
    assert.equal(matchGlob('src/*.ts', 'src/deep/a.ts'), false)
    assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true)
    assert.equal(matchGlob('!*.md', 'src/a.ts'), true)
    assert.equal(matchGlob('!*.md', 'src/a.md'), false)
  })
})

describe('displayPath', () => {
  it('relativizes inside the workdir and keeps outside paths absolute', () => {
    assert.equal(displayPath('/ws/src/a.ts', '/ws'), 'src/a.ts')
    assert.equal(displayPath('/ws', '/ws'), '.')
    assert.equal(displayPath('/other/a.ts', '/ws'), '/other/a.ts')
    assert.equal(displayPath('/ws-sibling/a.ts', '/ws'), '/ws-sibling/a.ts')
  })
})

describe('retention', () => {
  const matches = [1, 2, 3].map(index => ({ path: '/ws/a.txt', lineNumber: index, line: `line ${index}` }))

  it('matches the host suite\u2019s own ItemRetainer outcome', () => {
    const reference = new ItemRetainer({ kind: 'head', maxItems: 2 })
    for (const match of matches) reference.push(match)
    const expected = reference.finish()
    const actual = retainMatches(matches, 2, 2000)
    assert.deepEqual(actual, expected)

    const whole = new ItemRetainer({ kind: 'head', maxItems: 5 })
    for (const match of matches) whole.push(match)
    assert.deepEqual(retainMatches(matches, 5, 2000), whole.finish())
  })

  it('previews an over-long line inside the retention pass', () => {
    const retained = retainMatches([{ path: '/ws/a.txt', lineNumber: 1, line: 'x'.repeat(30) }], 250, 10)
    assert.equal(retained.items[0]?.line, 'xxxxxxxxxx (line truncated)')
  })

  it('caps a path list', () => {
    assert.deepEqual(retainPaths(['a', 'b', 'c'], 2), {
      items: ['a', 'b'],
      truncated: true,
      seen: 3,
      kept: 2,
      omitted: { kind: 'exact', count: 1 },
    })
    assert.deepEqual(retainPaths(['a'], 2).omitted, { kind: 'none' })
  })
})

describe('model-facing renderers', () => {
  const matches = [
    { path: 'src/a.ts', lineNumber: 3, line: 'one' },
    { path: 'src/a.ts', lineNumber: 9, line: 'two' },
    { path: 'lib/b.ts', lineNumber: 4, line: 'three' },
  ]

  it('renders grep exactly like the host suite when nothing is capped', () => {
    const caps = { maxMatches: 250, maxLineBytes: 2000 }
    assert.equal(renderGrepText(matches, caps), formatGrepOutput(retainMatches(matches, 250, 2000), undefined))
    assert.equal(renderGrepText(matches, caps).startsWith('Found 3 matches'), true)
  })

  it('renders grep exactly like the host suite when capped', () => {
    const caps = { maxMatches: 2, maxLineBytes: 2000 }
    const reference = formatGrepOutput(retainMatches(matches, 2, 2000), undefined)
    assert.equal(renderGrepText(matches, caps), reference)
    assert.equal(renderGrepText(matches, caps).startsWith('Found 2 of 3 matches'), true)
    assert.equal(renderGrepText(matches, caps).includes('The complete result could not be saved'), true)
  })

  it('words an empty grep result like the host suite', () => {
    assert.equal(renderGrepText([], { maxMatches: 250, maxLineBytes: 2000 }), 'No matches found')
  })

  it('treats the inline cap as inclusive: exactly maxResults is not a capped page', () => {
    // The boundary was never asserted: the uncapped case used 2 paths against a cap of 3, so flipping
    // `<=` to `<` left every assertion green while a result of exactly the cap started rendering the
    // "(Showing 3 of 3 paths … narrow your pattern)" footer. A mutation sweep planted that flip and the
    // suite did not notice (scripts/mutation-sweep.mjs, 2026-10-20); this is the lock it earned.
    const head = { maxResults: 3, sampleOverCapGlobResults: false }
    assert.equal(renderGlobText(['a', 'b', 'c'], head, '.'), 'a\nb\nc',
      'exactly maxResults is the inline page, with no capped footer')
    assert.match(renderGlobText(['a', 'b', 'c', 'd'], head, '.') ?? '', new RegExp('\\(Showing 3 of 4 paths'),
      'one over the cap is a capped page')
    assert.deepEqual(globCardPage(['a', 'b', 'c'], head, '.'), { items: ['a', 'b', 'c'], truncated: false },
      'and the card agrees with the text at the same boundary')
  })

  it('renders glob exactly like the host suite in both cap modes', () => {
    const paths = ['a', 'b', 'c', 'd', 'e']
    const head = { maxResults: 3, sampleOverCapGlobResults: false }
    const sampled = { maxResults: 3, sampleOverCapGlobResults: true }
    assert.equal(renderGlobText(paths, head, '.'), `${['a', 'b', 'c'].join('\n')}\n\n(Showing 3 of 5 paths. The complete result could not be saved; narrow pattern or path to see more.)`)
    assert.equal(
      renderGlobText(paths, sampled, '.'),
      formatGlobOutput(sampleAcrossTopLevel(paths, 3, '.'), 5, undefined),
    )
    assert.equal(renderGlobText(paths.slice(0, 2), head, '.'), 'a\nb')
    assert.equal(renderGlobText([], head, '.'), 'No files found')
    assert.deepEqual(globCardPage(paths, head, '.'), { items: ['a', 'b', 'c'], truncated: true })
    assert.deepEqual(globCardPage(paths.slice(0, 2), head, '.'), { items: ['a', 'b'], truncated: false })
    assert.deepEqual(globCardPage(paths, sampled, '.'), { items: sampleAcrossTopLevel(paths, 3, '.').items, truncated: true })
  })
})

describe('search-card metadata', () => {
  const matches = [
    { path: 'src/a.ts', lineNumber: 3, line: 'one' },
    { path: 'src/a.ts', lineNumber: 9, line: 'two' },
    { path: 'lib/b.ts', lineNumber: 4, line: 'three' },
  ]

  it('narrows back into a search view through the host suite\u2019s own reader', () => {
    const meta = grepSearchMeta(retainMatches(matches, 250, 2000), 65536)
    const result = { content: [], isError: false, meta }
    const view = presentGrepResult({ pattern: 'x' }, result)
    assert.deepEqual(view, {
      card: 'search',
      shape: 'matches',
      files: [
        { path: 'src/a.ts', matches: [{ lineNumber: 3, line: 'one' }, { lineNumber: 9, line: 'two' }] },
        { path: 'lib/b.ts', matches: [{ lineNumber: 4, line: 'three' }] },
      ],
      truncated: false,
      total: 3,
    })
    assert.equal(presentGrepResult({ pattern: 'x' }, { ...result, meta: { shape: 'nope' } }), undefined)
  })

  it('projects a glob card the host suite\u2019s reader accepts', () => {
    const view = presentGlobResult({ pattern: 'x' }, { content: [], isError: false, meta: globSearchMeta(retainPaths(['a', 'b'], 1), 65536) })
    assert.deepEqual(view, { card: 'search', shape: 'paths', paths: ['a'], truncated: true, total: 2 })
  })

  it('drops trailing groups to fit the metadata budget but never empties the card', () => {
    const long = { path: 'src/a.ts', lineNumber: 1, line: `${'x'.repeat(400)}` }
    const meta = grepSearchMeta(retainMatches([long, long, long], 250, 2000), 500)
    assert.equal(meta.truncated, true)
    assert.equal(meta.total, 3)
    assert.ok('files' in meta, 'a matches-shaped meta carries its groups')
    assert.equal(meta.files.length, 1)
    const single = capMetaBytes({ shape: 'paths', paths: ['x'.repeat(500)], truncated: false, total: 1 }, 10)
    assert.ok('paths' in single, 'a paths-shaped meta carries its paths')
    assert.equal(single.paths.length, 1, 'one oversized item survives rather than emptying the card')
  })
})

describe('target and argv resolution', () => {
  it('resolves a WSL UNC cwd into its distribution and Linux workdir', () => {
    const target = resolveTarget('\\\\wsl.localhost\\Ubuntu\\home\\mille\\ws', undefined)
    assert.equal(target?.distro, 'Ubuntu')
    assert.equal(target?.linuxCwd, '/home/mille/ws')
  })

  it('refuses a cwd that names no world at all', () => {
    // Issue #86: this cell used to also assert `resolveTarget('C:\\Users\\mille\\ws') === undefined`,
    // which encoded the defect as the contract — a Windows-drive cwd is not "no world", it is the
    // `/mnt/<drive>` workspace shape the file, shell and env providers already serve. What genuinely
    // names no world is a missing, empty or relative cwd, and those stay refused.
    assert.equal(resolveTarget(undefined, undefined), undefined)
    assert.equal(resolveTarget('', undefined), undefined)
    assert.equal(resolveTarget('home/mille/ws', undefined), undefined, 'a relative cwd names no world')
  })

  it('resolves a registered drive-letter workspace from its registration (issue #86)', () => {
    // The reported shape: cwd `F:\TechEnergy\Code\Scanner`, registered because 9P cannot export
    // drvfs. The generated `search-wsl` row carries no `config:` block, so `configured` is
    // undefined here exactly as it is in a real session — the distribution can only come from the
    // registration, and the Linux workdir only from the drive translation.
    // The path is synthetic on purpose: this cell measures string derivation, and a fixture folder
    // can only be created on the platform whose drive letters it names (the ubuntu runner has no
    // `F:`), which would make the reading platform-shaped rather than code-shaped.
    withStore({ 'f:\\techenergy\\code\\scanner': { distro: 'Ubuntu-24.04', username: 'linte' } }, () => {
      const target = resolveTarget('F:\\TechEnergy\\Code\\Scanner', undefined)
      assert.equal(target?.distro, 'Ubuntu-24.04', 'the registered distribution, not whatever the registry calls default')
      assert.equal(target?.linuxCwd, '/mnt/f/TechEnergy/Code/Scanner', 'the same translation the file tools apply')
      assert.equal(target?.username, 'linte', 'the stored run-as user, symmetric with the UNC branch')
    })
  })

  it('keeps the distribution chain of its sibling providers for a drive cwd', () => {
    withStore({ 'f:\\proj': { distro: 'Ubuntu-24.04' } }, () => {
      // configured → stored entry → registry default, the order src/host/wsl-relay.ts walks, so
      // `grep` searches the distribution the session's `bash` runs in.
      assert.equal(resolveTarget('F:\\proj', 'Debian')?.distro, 'Debian', 'the row config wins over the registration')
      assert.equal(resolveTarget('F:\\proj', '   ')?.distro, 'Ubuntu-24.04', 'a blank config is no config')
      const stored = resolveTarget('F:\\proj', undefined)
      assert.equal(stored?.linuxCwd, '/mnt/f/proj')
      assert.equal('username' in (stored ?? {}), false, 'no stored user means the distribution default, stated by absence not by an empty string')
    })
  })

  it('uses the configured or default distribution for a Linux-absolute cwd', () => {
    const configured = resolveTarget('/home/mille/ws', 'Debian')
    assert.equal(configured?.distro, 'Debian')
    assert.equal(configured?.linuxCwd, '/home/mille/ws')
  })

  it('maps a UNC target back to its Linux spelling', () => {
    assert.equal(linuxTarget('\\\\wsl.localhost\\Ubuntu\\home\\mille\\ws'), '/home/mille/ws')
    assert.equal(linuxTarget('src'), 'src')
    assert.equal(linuxTarget(undefined), '')
  })

  it('maps a Windows drive path to the /mnt form the file tools also open', () => {
    assert.equal(linuxTarget('D:\\ProgramData\\proj'), '/mnt/d/ProgramData/proj')
    assert.equal(linuxTarget('c:/Users/me'), '/mnt/c/Users/me')
    assert.equal(linuxTarget('D:\\'), '/mnt/d')
    assert.equal(linuxTarget('/already/linux'), '/already/linux')
    // A bare `D:` is drive-relative rather than a path, and the shared helper's
    // scope is a single-letter drive followed by a separator; it passes through
    // and the distribution reports the missing path.
    assert.equal(linuxTarget('D:'), 'D:')
  })

  it('passes every model value as its own argv element after the fixed script', () => {
    const target = { distro: 'Ubuntu', linuxCwd: '/home/mille/ws', username: 'mille' }
    const script = 'set -u; exit 0'
    const values = ['a $(rm -rf /) b', '*.{ts,js}', '', '20000001']
    const argv = buildWslArgv(target, script, values)
    assert.deepEqual(argv.slice(0, 5), ['-d', 'Ubuntu', '-u', 'mille', '--cd'])
    assert.equal(argv[5], '/home/mille/ws')
    assert.deepEqual(argv.slice(6, 11), ['-e', 'bash', '-c', script, 'dsh'])
    assert.deepEqual(argv.slice(11), values)
    assert.equal(argv.includes('a $(rm -rf /) b'), true, 'the value stays one intact element')
  })

  it('omits the user flag when the workspace stores none', () => {
    assert.equal(buildWslArgv({ distro: 'Ubuntu', linuxCwd: '/ws' }, 'exit 0', []).includes('-u'), false)
  })
})

describe('apply', () => {
  /** One JSON-Schema node, read through what these tests assert on. */
  interface SchemaNode {
    type?: string
    additionalProperties?: boolean
    required?: string[] | boolean
    properties?: Record<string, SchemaNode>
    items?: SchemaNode
  }

  /** A registered tool, read through what these tests assert on. */
  interface FakeTool {
    name: string
    description: string
    timeoutMs: number
    parameters: { required?: string[]; properties?: Record<string, { description?: string }> }
    output: {
      schema: SchemaNode
      render(args: unknown, value: unknown): Array<{ type: string; text: string }>
      presentationMeta?(args: unknown, value: unknown): unknown
    }
    presentCall(args: unknown): { title?: string }
    execute(args: unknown, exec: unknown): Promise<unknown>
  }

  /** A registry stand-in: the tools it captured, and the `ctx` to hand `apply`. */
  function registry() {
    const tools = new Map<string, FakeTool>()
    return {
      tools,
      ctx: fakeContext({
        tools: { register: (tool: FakeTool) => tools.set(tool.name, tool) },
        spillStore: undefined,
      }),
    }
  }

  /** The captured tool, named in the failure when a registration went missing. */
  function mustGet(tools: Map<string, FakeTool>, name: string): FakeTool {
    const tool = tools.get(name)
    assert.ok(tool !== undefined, `${name} was not registered`)
    return tool
  }

  it('registers exactly the grep and glob tools with WSL-honest descriptions', () => {
    const { ctx, tools } = registry()
    apply(ctx, CONFIG)
    assert.deepEqual([...tools.keys()], ['grep', 'glob'])
    const grep = mustGet(tools, 'grep')
    assert.deepEqual(grep.parameters.required, ['pattern'])
    assert.deepEqual(Object.keys(grep.parameters.properties ?? {}), ['pattern', 'path', 'include'])
    assert.equal(grep.parameters.properties?.pattern?.description?.includes('GNU grep -E'), true)
    assert.equal(grep.parameters.properties?.include?.description?.includes('relative to the search root'), true)
    assert.equal(grep.description.includes('GNU grep extended regular expression'), true)
    assert.equal(grep.timeoutMs, CONFIG.timeoutMs)
    const glob = mustGet(tools, 'glob')
    assert.deepEqual(glob.parameters.required, ['pattern'])
    assert.equal(glob.description.includes('oldest first'), true)
    assert.equal(typeof grep.presentCall, 'function')
    assert.deepEqual(grep.presentCall({ pattern: 'foo', path: 'src', include: '*.ts' }).title, 'Grep foo in src (*.ts)')
    assert.deepEqual(glob.presentCall({ pattern: '**/*.ts' }).title, 'Glob **/*.ts')
    assert.deepEqual(Object.keys(grep.output).sort(), ['presentationMeta', 'render', 'schema'])
  })

  it('does nothing when the tools registry is absent', () => {
    assert.doesNotThrow(() => apply(fakeContext({}), CONFIG))
  })

  it('does not refuse a drive-letter session cwd (issue #86)', async () => {
    // Where the defect actually surfaced: both tools threw `grep is only available in a WSL
    // workspace session` for a `/mnt/<drive>` session while `bash`, `read`, `write` and `edit` in
    // the same session worked. `wslPath` names a command that cannot start, so reaching the spawn
    // is observable without a distribution — and the assertion is about the refusal sentence, not
    // about search results.
    return withStore({ 'f:\\techenergy\\code\\scanner': { distro: 'Ubuntu-24.04' } }, async () => {
      const { ctx, tools } = registry()
      // A command that cannot start is the point: the tools must reach the spawn
      // instead of refusing the session, so no distribution is needed here.
      apply(ctx, { ...CONFIG, wslPath: 'dsh-issue-86-no-such-command' })
      const exec = { agent: { session: { header: { cwd: 'F:\\TechEnergy\\Code\\Scanner' } } }, signal: undefined }
      for (const name of ['grep', 'glob']) {
        let message = 'the call returned without reaching the spawn'
        try {
          await mustGet(tools, name).execute({ pattern: 'x' }, exec)
          message = ''
        } catch (error) {
          message = (error as Error).message
        }
        assert.equal(message.includes('only available in a WSL workspace session'), false, `${name} refused a WSL drive workspace`)
        assert.equal(message.includes('dsh-issue-86-no-such-command'), true, `${name} never reached the distribution spawn: ${message}`)
      }
    })
  })

  it('mounts with schema defaults when the row carries no config at all', () => {
    // A world row with no `config:` block hands apply an undefined config; a real
    // session failed the whole world on exactly that (`Cannot read properties of
    // undefined (reading 'grepMaxMatches')`).
    const { ctx, tools } = registry()
    assert.doesNotThrow(() => apply(ctx, undefined))
    assert.deepEqual([...tools.keys()], ['grep', 'glob'])
    assert.equal(mustGet(tools, 'grep').timeoutMs, CONFIG.timeoutMs)
    assert.deepEqual(mustGet(tools, 'grep').parameters.required, ['pattern'])
    const run = registry()
    apply(run.ctx, {})
    assert.deepEqual([...run.tools.keys()], ['grep', 'glob'])
  })

  it('declares a spill schema a backend\u2019s own SpillRef satisfies', () => {
    // The canonical value is validated against `output.schema`, and the spill
    // backend's `SpillRef` is `{locator, bytes, retrievalHint}` — a closed object
    // would fail the tool's own result.
    const { ctx, tools } = registry()
    apply(ctx, CONFIG)
    for (const name of ['grep', 'glob']) {
      const spill = mustGet(tools, name).output.schema.properties?.spill
      assert.ok(spill !== undefined, `${name} declares a spill field`)
      assert.equal(spill.type, 'object')
      assert.equal(spill.additionalProperties, true)
      assert.deepEqual(Object.keys(spill.properties ?? {}).sort(), ['locator', 'retrievalHint'])
    }
    assert.deepEqual(
      normalizeSpill({ locator: 'spill://x', bytes: 12, retrievalHint: 'read it' }),
      { locator: 'spill://x', bytes: 12, retrievalHint: 'read it' },
    )
    assert.equal(normalizeSpill(undefined), undefined)
    assert.equal(normalizeSpill({ bytes: 1 }), undefined, 'a reference with no locator is not renderable')
    assert.deepEqual(normalizeSpill({ locator: 'spill://x' })?.retrievalHint, '')
  })

  it('renders a capped result through a spill reference the backend supplied', () => {
    const { ctx, tools } = registry()
    apply(ctx, CONFIG)
    const grep = mustGet(tools, 'grep')
    const matches = Array.from({ length: 300 }, (_, index) => ({ path: 'a.ts', lineNumber: index + 1, line: 'x' }))
    const spill = { locator: 'spill://session/grep-results.txt', bytes: 10, retrievalHint: 'Read it with the read tool.' }
    const rendered = grep.output.render({ pattern: 'x' }, { matches, spill }).map(part => part.text).join('\n')
    assert.equal(rendered.includes('Full grep result stored at: spill://session/grep-results.txt. Read it with the read tool.'), true)
    assert.equal(rendered.startsWith('Found 250 of 300 matches'), true)
  })
})
