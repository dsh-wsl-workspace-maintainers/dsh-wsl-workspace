/**
 * Unit tests for the WSL world's background-job producer.
 *
 * The point of this tool is narrow and worth pinning: a WSL world's `bash` is
 * the host's *persistent* tool, whose schema declares only `command`, so nothing
 * started a tracked job — a `run_in_background: true` argument was silently
 * ignored (the schema does not forbid extra properties) and the host's `job_*`
 * tools always answered "no background jobs". A real session found exactly that.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, outcomeOf, renderRead, TOOL_NAME } from '../src/host/wsl-jobs.ts'
import { fakeContext } from './support/fake-context.ts'

const CONFIG = { timeoutMs: 15_000 }

/** One incremental output read, as the shell provider and the registry both define it. */
interface ReadResult {
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

/** A fake captured-stream reader, matching the `observed` shape the producer hands the 0.2.x registry. */
interface FakeReader {
  readFrom(from: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}
function makeReader(chunks: string[]): FakeReader {
  const full = chunks.join('')
  // The real reader tracks a read cursor; this one just replays the whole
  // stream from the requested offset, which is all a finished job needs.
  return { readFrom: (from: number) => ({ text: full.slice(from), nextOffset: full.length, lossy: false }) }
}

/** The background process the fake shell hands back, as the producer's hooks bridge uses it. */
interface FakeProcess {
  status: 'running' | 'completed' | 'killed'
  exitCode: number | null
  signal: NodeJS.Signals | null
  done: Promise<void>
  readOutput(): ReadResult
  kill(): boolean
  observed: { stdout: FakeReader; stderr: FakeReader }
}

/** The request {@link startBackgroundJob} builds and the fake shell records. */
interface ResolveRequest {
  command: string
  workdir?: string
  stdin?: string
  dshEnv?: Record<string, string>
  onExpiry?: string
}

/** The hooks the registry calls on a started job. */
interface FakeHooks {
  cancel(reason?: string): void
  done: Promise<{ status: string; detail?: string }>
  readOutput?(): string
}

/** The spec this producer hands `jobs.start`. */
interface JobSpec {
  kind: string
  label: string
  owner?: unknown
  output?: Array<{ channel?: string; read(from: number): ReturnType<FakeReader['readFrom']> }>
  /** The 0.2.x registry calls `run()` with an argument of its own; the producer takes none. */
  run(arg?: unknown): FakeHooks
}

/** The tool object `defineTool` builds, read through what these tests assert on. */
interface FakeTool {
  name: string
  description: string
  timeoutMs: number
  parameters: { required: string[]; properties: Record<string, unknown> }
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  execute(args: { command: string; workdir?: string }, exec: unknown): Promise<{ jobId: string }>
}

/** What one test may replace: any of the three services, or the process they hand back. */
interface HarnessOverrides {
  process?: Partial<FakeProcess>
  shell?: { resolve?: (request: ResolveRequest) => unknown; start?: ((spec: unknown) => FakeProcess) | undefined }
  jobs?: { resolveOwner?: unknown; start?: (spec: JobSpec) => unknown }
  noShell?: boolean
  noJobs?: boolean
}

/** A fake `ctx` carrying the three services the tool reads. */
function harness(overrides: HarnessOverrides = {}) {
  const registered = new Map<string, FakeTool>()
  const calls: { started: JobSpec[]; resolved: ResolveRequest[]; started_: unknown[] } = { started: [], resolved: [], started_: [] }
  const process: FakeProcess = {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: 'hello\n', lossy: false }),
    kill: () => true,
    observed: { stdout: makeReader([]), stderr: makeReader([]) },
    ...overrides.process,
  }
  const shell = {
    resolve: (request: ResolveRequest) => {
      calls.resolved.push(request)
      return { spec: request }
    },
    start: (spec: unknown) => {
      calls.started_.push(spec)
      return process
    },
    ...overrides.shell,
  }
  const jobs = {
    start: (spec: JobSpec) => {
      calls.started.push(spec)
      return 'bash-7'
    },
    ...overrides.jobs,
  }
  const ctx = fakeContext({
    tools: { register: (tool: FakeTool) => registered.set(tool.name, tool) },
    shell: overrides.noShell === true ? undefined : shell,
    jobs: overrides.noJobs === true ? undefined : jobs,
    shellEnv: { collect: () => ({ DSH_SESSION_ID: 's' }) },
  })
  apply(ctx, CONFIG)
  const tool = registered.get(TOOL_NAME)
  assert.ok(tool !== undefined, 'the producer registered its own tool')
  return { tool, calls, process, registered }
}

const EXEC = { agent: { id: 'session-7f2c', session: { header: { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\mille\\ws' } } } }

test('registers one bash_background tool with a narrow schema', () => {
  const { tool, registered } = harness()
  assert.deepEqual([...registered.keys()], [TOOL_NAME])
  assert.deepEqual(tool.parameters.required, ['command'])
  assert.deepEqual(Object.keys(tool.parameters.properties), ['command', 'workdir'])
  assert.equal(tool.description.includes('same producer'), true,
    'it says it is the producer `bash`’s run_in_background delegates to, not a rival registry')
  assert.equal(tool.description.includes('does not see a `cd` or `export`'), true,
    'and it says the job runs in its own process, so a session `cd` is not inherited')
  assert.equal(tool.timeoutMs, CONFIG.timeoutMs)
})

test('starts a tracked job and returns its id', async () => {
  const { tool, calls } = harness()
  const value = await tool.execute({ command: 'sleep 30' }, EXEC)
  assert.deepEqual(value, { jobId: 'bash-7' })
  assert.equal(calls.started.length, 1)
  const [spec] = calls.started
  assert.ok(spec !== undefined, 'the registry was handed one spec')
  assert.equal(spec.kind, 'bash', 'the id namespace the host tools expect')
  assert.equal(spec.label, 'sleep 30')
  assert.equal(spec.owner, EXEC.agent,
    'through 0.1.5-rc.2 the registry takes the agent itself (it reads owner.id and owner.ctx)')
  const [rendered] = tool.output.render({ command: 'sleep 30' }, value)
  assert.equal(rendered?.text, 'started background job bash-7')
})

test('a registry that resolves an owner takes the session id instead (0.1.7+)', async () => {
  // 0.1.7-rc.1 changed the contract: `start()` takes the session id and the
  // registry resolves it with `agents.get(id)`. Handing it the agent object is
  // the `session "[object Object]" has no live agent` failure of issue #40, and
  // the presence of `resolveOwner` is what tells the two apart.
  const { tool, calls } = harness({ jobs: { resolveOwner: (session: string) => ({ id: session }) } })
  await tool.execute({ command: 'sleep 30' }, EXEC)
  const [spec] = calls.started
  assert.equal(spec?.owner, 'session-7f2c', 'the newer registry takes the session id')
})

test('a call with no agent produces an unowned job rather than a wrong owner', async () => {
  for (const jobs of [{}, { resolveOwner: (session: string) => ({ id: session }) }]) {
    const { tool, calls } = harness({ jobs })
    await tool.execute({ command: 'sleep 30' }, {})
    const [spec] = calls.started
    assert.equal(spec !== undefined && 'owner' in spec, false, 'no agent means no owner entry at all')
  }
})

test('the producer runs through this world\u2019s shell, with the caller\u2019s workdir', async () => {
  const { tool, calls } = harness()
  await tool.execute({ command: 'pwd', workdir: '/tmp' }, EXEC)
  const [started] = calls.started
  assert.ok(started !== undefined, 'the registry was handed one spec')
  const hooks = started.run()
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(calls.resolved.length, 1)
  const [request] = calls.resolved
  assert.ok(request !== undefined, 'the shell was asked to resolve one request')
  assert.equal(request.command, 'pwd')
  assert.equal(request.workdir, '/tmp')
  assert.deepEqual(request.dshEnv, { DSH_SESSION_ID: 's' }, 'managed DSH_* facts ride along')
  // The shell executor honours `timeoutMs` unless the spec says otherwise
  // (`src/shell.ts`'s `spawnExecution` arms a deadline for every policy but
  // `'none'`). Before issue #51 the background path ignored timeouts entirely;
  // this is the fact that replaces that behaviour, so a dropped `'none'` would
  // kill every `job_*` at the executor's 120 s foreground timeout.
  assert.equal(request.onExpiry, 'none', 'a job outlives one command timeout by policy, not accident')
  assert.equal(calls.started_.length, 1, 'run() starts exactly one process')
})

test('defaults the workdir to the session workspace, not the host process', async () => {
  // The world's shell provider falls back to its own configured cwd (or the
  // host process's), which in a WSL world is a Windows directory the
  // distribution cannot use. The persistent `bash` starts in the session
  // workspace, so a background job must too.
  const { tool, calls } = harness()
  await tool.execute({ command: 'pwd' }, EXEC)
  const [started] = calls.started
  assert.ok(started !== undefined, 'the registry was handed one spec')
  started.run()
  const [request] = calls.resolved
  assert.ok(request !== undefined, 'the shell was asked to resolve one request')
  assert.equal(request.workdir, EXEC.agent.session.header.cwd)
  const bare = harness()
  await bare.tool.execute({ command: 'pwd' }, {})
  const [bareStarted] = bare.calls.started
  assert.ok(bareStarted !== undefined, 'the registry was handed one spec')
  bareStarted.run()
  const [bareRequest] = bare.calls.resolved
  assert.ok(bareRequest !== undefined, 'the shell was asked to resolve one request')
  assert.equal('workdir' in bareRequest, false, 'no cwd anywhere: let the provider decide')
})

test('refuses an aborted call before starting anything', async () => {
  const { tool, calls } = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ command: 'x' }, { ...EXEC, signal: controller.signal }),
    error => (error as Error).name === 'AbortError')
  assert.equal(calls.started.length, 0, 'nothing was registered')
})

test('the hooks bridge cancel, done and readOutput to the registry', async () => {
  let killed = 0
  const { tool, calls } = harness({
    process: {
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      readOutput: () => ({ delta: 'partial\n', lossy: true, stdoutSpillPath: '/tmp/spill' }),
      kill: () => { killed += 1; return true },
    },
  })
  await tool.execute({ command: 'sleep 30' }, EXEC)
  const [started] = calls.started
  assert.ok(started !== undefined, 'the registry was handed one spec')
  const hooks = started.run()
  hooks.cancel()
  assert.equal(killed, 1)
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'signal: SIGTERM' })
  assert.equal(hooks.readOutput?.(), 'partial\n\n[output truncated: unread bytes were dropped]\n[full stdout: /tmp/spill]')
})

test('a finished job reports its exit code, and a live one is not an outcome', () => {
  assert.deepEqual(outcomeOf({ status: 'completed', exitCode: 0, signal: null }), { status: 'completed', detail: 'exit code: 0' })
  assert.deepEqual(outcomeOf({ status: 'completed', exitCode: 3, signal: null }), { status: 'completed', detail: 'exit code: 3' })
  assert.deepEqual(outcomeOf({ status: 'killed', exitCode: null, signal: 'SIGKILL' }), { status: 'killed', detail: 'signal: SIGKILL' })
  assert.deepEqual(outcomeOf({ status: 'running', exitCode: null, signal: null }), { status: 'failed' },
    'a hook that settles while still running is a failure, not a success')
})

test('renderRead passes a clean delta through untouched', () => {
  assert.equal(renderRead({ delta: 'line\n', lossy: false }), 'line\n')
  assert.equal(renderRead({ delta: '', lossy: false }), '')
})

test('refuses clearly when the deployment cannot track jobs', async () => {
  await assert.rejects(harness({ noJobs: true }).tool.execute({ command: 'x' }, EXEC), /no jobs registry/)
  await assert.rejects(harness({ noShell: true }).tool.execute({ command: 'x' }, EXEC), /no shell with background support/)
  await assert.rejects(
    harness({ shell: { start: undefined } }).tool.execute({ command: 'x' }, EXEC),
    /no shell with background support/,
  )
})

test('does nothing when the tools registry is absent', () => {
  assert.doesNotThrow(() => apply(fakeContext({}), CONFIG))
})

test('mounts with schema defaults when the row carries no config at all', () => {
  // A world row with no `config:` block hands apply an undefined config. The
  // wsl-search entry failed a whole world on exactly that, and this entry then
  // repeated the mistake until a live session caught it
  // (`Cannot read properties of undefined (reading 'timeoutMs')`).
  const registered = new Map<string, FakeTool>()
  const ctx = fakeContext({ tools: { register: (tool: FakeTool) => registered.set(tool.name, tool) } })
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.deepEqual([...registered.keys()], [TOOL_NAME])
  const tool = registered.get(TOOL_NAME)
  assert.ok(tool !== undefined, 'the producer registered its own tool')
  assert.equal(tool.timeoutMs, CONFIG.timeoutMs)
  const empty = new Map<string, FakeTool>()
  apply(fakeContext({ tools: { register: (registeredTool: FakeTool) => empty.set(registeredTool.name, registeredTool) } }), {})
  assert.deepEqual([...empty.keys()], [TOOL_NAME])
})

test('the produced job feeds the registry\'s pull-source output channel, so job_output is never silently empty', async () => {
  // The 0.2.x registry drains bytes only from `spec.output` pull-sources; it
  // never calls `run()`'s `readOutput`. The fake below mirrors that drain loop,
  // so a producer that set only `readOutput` (the pre-fix shape) would surface
  // here as an empty ring instead of the bytes the command wrote — exactly the
  // `job_output` → `(no new output)` failure on DSH 0.2.0-rc.2 (issue #56).
  const captured: { output?: JobSpec['output'] } = {}
  const { tool } = harness({
    process: {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: 'legacy-only\n', lossy: false }),
      observed: {
        stdout: makeReader(['tick 1\n', 'tick 2\n']),
        stderr: makeReader(['warn\n']),
      },
      kill: () => true,
    },
    jobs: {
      start: (spec: JobSpec) => {
        captured.output = spec.output
        // Mirror the 0.2.x pump: start() calls run() to register the process
        // (assigning the producer's closure capture) before any source is read.
        spec.run({})
        return 'bash-7'
      },
    },
  })
  await tool.execute({ command: 'echo' }, EXEC)
  const sources = captured.output
  // The array is asserted before it is indexed rather than assumed from a cast: `assert.ok`
  // narrows in TypeScript, so the length and the element type are both established by the check
  // instead of by an assertion that would be wrong the moment the producer's shape changes.
  assert.ok(Array.isArray(sources) && sources.length === 2, 'producer exposes stdout + stderr pull sources')
  const [stdout, stderr] = sources
  assert.ok(stdout !== undefined && stderr !== undefined, 'both pull sources are present')
  assert.equal(stdout.channel, undefined, 'stdout carries no channel tag')
  assert.equal(stderr.channel, 'stderr', 'stderr is tagged so the registry keeps it on its own channel')
  const first = stdout.read(0)
  assert.equal(first.text, 'tick 1\ntick 2\n', 'stdout source yields the process output')
  assert.equal(first.nextOffset, 'tick 1\ntick 2\n'.length, 'the cursor advances past what was read')
  const after = stdout.read(first.nextOffset)
  assert.equal(after.text, '', 'a read past the end yields nothing')
  const err = stderr.read(0)
  assert.equal(err.text, 'warn\n', 'the stderr source yields its own stream')
})
