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

const CONFIG = { timeoutMs: 15_000 }

/** A fake `ctx` carrying the three services the tool reads. */
function harness(overrides = {}) {
  const registered = new Map()
  const calls = { started: [], resolved: [], started_: [] }
  const process = {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: 'hello\n', lossy: false }),
    kill: () => true,
    ...overrides.process,
  }
  const shell = {
    resolve: request => {
      calls.resolved.push(request)
      return { spec: request }
    },
    start: spec => {
      calls.started_.push(spec)
      return process
    },
    ...overrides.shell,
  }
  const jobs = {
    start: spec => {
      calls.started.push(spec)
      return 'bash-7'
    },
    ...overrides.jobs,
  }
  const ctx = {
    get: name => {
      if (name === 'tools') return { register: tool => registered.set(tool.name, tool) }
      if (name === 'shell') return overrides.noShell === true ? undefined : shell
      if (name === 'jobs') return overrides.noJobs === true ? undefined : jobs
      if (name === 'shellEnv') return { collect: () => ({ DSH_SESSION_ID: 's' }) }
      return undefined
    },
  }
  apply(ctx, CONFIG)
  return { tool: registered.get(TOOL_NAME), calls, process, registered }
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
  const spec = calls.started[0]
  assert.equal(spec.kind, 'bash', 'the id namespace the host tools expect')
  assert.equal(spec.label, 'sleep 30')
  assert.equal(spec.owner, EXEC.agent,
    'through 0.1.5-rc.2 the registry takes the agent itself (it reads owner.id and owner.ctx)')
  assert.equal(tool.output.render({ command: 'sleep 30' }, value)[0].text, 'started background job bash-7')
})

test('a registry that resolves an owner takes the session id instead (0.1.7+)', async () => {
  // 0.1.7-rc.1 changed the contract: `start()` takes the session id and the
  // registry resolves it with `agents.get(id)`. Handing it the agent object is
  // the `session "[object Object]" has no live agent` failure of issue #40, and
  // the presence of `resolveOwner` is what tells the two apart.
  const { tool, calls } = harness({ jobs: { resolveOwner: (session: string) => ({ id: session }) } })
  await tool.execute({ command: 'sleep 30' }, EXEC)
  const spec = calls.started[0] as { owner?: unknown } | undefined
  assert.equal(spec?.owner, 'session-7f2c', 'the newer registry takes the session id')
})

test('a call with no agent produces an unowned job rather than a wrong owner', async () => {
  for (const jobs of [{}, { resolveOwner: (session: string) => ({ id: session }) }]) {
    const { tool, calls } = harness({ jobs })
    await tool.execute({ command: 'sleep 30' }, {})
    const spec = calls.started[0] as { owner?: unknown } | undefined
    assert.equal(spec !== undefined && 'owner' in spec, false, 'no agent means no owner entry at all')
  }
})

test('the producer runs through this world\u2019s shell, with the caller\u2019s workdir', async () => {
  const { tool, calls } = harness()
  await tool.execute({ command: 'pwd', workdir: '/tmp' }, EXEC)
  const hooks = calls.started[0].run()
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(calls.resolved.length, 1)
  assert.equal(calls.resolved[0].command, 'pwd')
  assert.equal(calls.resolved[0].workdir, '/tmp')
  assert.deepEqual(calls.resolved[0].dshEnv, { DSH_SESSION_ID: 's' }, 'managed DSH_* facts ride along')
  // The shell executor honours `timeoutMs` unless the spec says otherwise
  // (`src/shell.ts`'s `spawnExecution` arms a deadline for every policy but
  // `'none'`). Before issue #51 the background path ignored timeouts entirely;
  // this is the fact that replaces that behaviour, so a dropped `'none'` would
  // kill every `job_*` at the executor's 120 s foreground timeout.
  // Read through a cast rather than `resolved[0].onExpiry`: the harness types
  // `resolved` as an empty array literal, so a plain access would add a 211th
  // typecheck error to a file that already carries 38 of the baseline's own.
  const [firstRequest] = calls.resolved as Array<{ onExpiry?: string }>
  assert.equal(firstRequest?.onExpiry, 'none', 'a job outlives one command timeout by policy, not accident')
  assert.equal(calls.started_.length, 1, 'run() starts exactly one process')
})

test('defaults the workdir to the session workspace, not the host process', async () => {
  // The world's shell provider falls back to its own configured cwd (or the
  // host process's), which in a WSL world is a Windows directory the
  // distribution cannot use. The persistent `bash` starts in the session
  // workspace, so a background job must too.
  const { tool, calls } = harness()
  await tool.execute({ command: 'pwd' }, EXEC)
  calls.started[0].run()
  assert.equal(calls.resolved[0].workdir, EXEC.agent.session.header.cwd)
  const bare = harness()
  await bare.tool.execute({ command: 'pwd' }, {})
  bare.calls.started[0].run()
  assert.equal('workdir' in bare.calls.resolved[0], false, 'no cwd anywhere: let the provider decide')
})

test('refuses an aborted call before starting anything', async () => {
  const { tool, calls } = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ command: 'x' }, { ...EXEC, signal: controller.signal }), error => error.name === 'AbortError')
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
  const hooks = calls.started[0].run()
  hooks.cancel()
  assert.equal(killed, 1)
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'signal: SIGTERM' })
  assert.equal(hooks.readOutput(), 'partial\n\n[output truncated: unread bytes were dropped]\n[full stdout: /tmp/spill]')
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
  assert.doesNotThrow(() => apply({ get: () => undefined }, CONFIG))
})

test('mounts with schema defaults when the row carries no config at all', () => {
  // A world row with no `config:` block hands apply an undefined config. The
  // wsl-search entry failed a whole world on exactly that, and this entry then
  // repeated the mistake until a live session caught it
  // (`Cannot read properties of undefined (reading 'timeoutMs')`).
  const registered = new Map()
  const ctx = { get: name => name === 'tools' ? { register: tool => registered.set(tool.name, tool) } : undefined }
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.deepEqual([...registered.keys()], [TOOL_NAME])
  assert.equal(registered.get(TOOL_NAME).timeoutMs, CONFIG.timeoutMs)
  const empty = new Map()
  apply({ get: name => name === 'tools' ? { register: tool => empty.set(tool.name, tool) } : undefined }, {})
  assert.deepEqual([...empty.keys()], [TOOL_NAME])
})
