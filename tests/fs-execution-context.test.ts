import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WslFileSystem } from '../src/fs.ts'

const sessionCwd = (distro: string) => `\\\\wsl.localhost\\${distro}\\home\\user\\project`

function referenceWorldRegistry(ctx: Context): Context {
  ctx.provide('agentPresets', { serviceFor: (agent: { ctx?: Context }, name: string) =>
    (agent.ctx ?? ctx).get(name as never) } as never)
  return ctx
}

test('cwd-blind file tools inherit the calling session distribution', async () => {
  const ctx = referenceWorldRegistry(new Context())
  await ctx.plugin(WslFileSystem, { distro: 'DefaultDistro' })
  const fs = ctx.fs as WslFileSystem
  // The middleware under test reads one field off the dispatch (`agent?.session.header.cwd`),
  // while `waterfall` types its payload as the registry's complete execution — a full
  // `SessionHeader` here would be noise about the event shape, not about this behaviour.
  const translate = (cwd: string) => ctx.waterfall(
    'tools/execute',
    { agent: { session: { header: { cwd } } } } as unknown as ToolDispatchExecution,
    async () => (fs as unknown as { translate(path: string): { input: string } })
      .translate('/tmp/file').input as unknown as ToolExecutionResult,
  )

  assert.deepEqual(await Promise.all([
    translate(sessionCwd('Ubuntu')),
    translate(sessionCwd('Debian')),
  ]), [
    '\\\\wsl.localhost\\Ubuntu\\tmp\\file',
    '\\\\wsl.localhost\\Debian\\tmp\\file',
  ])
})

test('agentless file calls retain the configured distribution fallback', async () => {
  const ctx = referenceWorldRegistry(new Context())
  await ctx.plugin(WslFileSystem, { distro: 'ConfiguredDistro' })
  const fs = ctx.fs as WslFileSystem
  const translated = (fs as unknown as { translate(path: string): { input: string } }).translate('/tmp/file')
  assert.equal(translated.input, '\\\\wsl.localhost\\ConfiguredDistro\\tmp\\file')
})


test('reference binding records actual per-source filesystem selection, never another session', async () => {
  const { referenceBinding } = await import('../src/shared/reference-world.ts')
  const contexts: Context[] = []
  {
    for (const [id, distro] of [['ref-ubuntu', 'Ubuntu-20.04'], ['ref-debian', 'Debian']] as const) {
      const ctx = referenceWorldRegistry(new Context()); contexts.push(ctx)
      await ctx.plugin(WslFileSystem, { distro })
      await ctx.waterfall('tools/execute', { agent: { session: { id, header: { cwd: 'D:/projects/demo' } } } } as unknown as ToolDispatchExecution,
        async () => (ctx.fs as unknown as { translate(path: string): unknown }).translate('/root/same.md') as ToolExecutionResult)
      assert.deepEqual(referenceBinding(id!), { status: 'bound', distro })
    }
    assert.deepEqual(referenceBinding('ref-unknown'), { status: 'unknown' })
    // A contradictory observation cannot remap older links to the latest world.
    await contexts[1]!.waterfall('tools/execute', { agent: { session: { id: 'ref-ubuntu', header: { cwd: 'D:/projects/demo' } } } } as unknown as ToolDispatchExecution,
      async () => (contexts[1]!.fs as unknown as { translate(path: string): unknown }).translate('/root/same.md') as ToolExecutionResult)
    assert.deepEqual(referenceBinding('ref-ubuntu'), { status: 'ambiguous' })
  }
})

test('default-distro selection is observed at execution time, not recomputed by reference lookup', async () => {
  const cp = (await import('node:child_process')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const { referenceBinding } = await import('../src/shared/reference-world.ts')
  const original = cp.execFileSync
  const guid = '{ce0fc2a6-29d7-467c-996a-eab37c96b876}'
  let calls = 0
  cp.execFileSync = ((file: string, args: string[]) => {
    assert.equal(file, 'reg.exe'); calls++
    return Buffer.from(args.includes('DefaultDistribution')
      ? `DefaultDistribution REG_SZ ${guid}` : 'DistributionName REG_SZ DefaultAtExecution')
  }) as typeof cp.execFileSync
  syncBuiltinESMExports()
  const ctx = referenceWorldRegistry(new Context())
  try {
    await ctx.plugin(WslFileSystem, {})
    await ctx.serial('agent/created', { agent: { session: { id: 'ref-default', header: { cwd: 'D:/projects/demo' } } }, source: 'create' } as never)
    assert.deepEqual(referenceBinding('ref-default'), { status: 'bound', distro: 'DefaultAtExecution' }, 'ready before the first tool call')
    await ctx.waterfall('tools/execute', { agent: { session: { id: 'ref-default', header: { cwd: 'D:/projects/demo' } } } } as unknown as ToolDispatchExecution,
      async () => (ctx.fs as unknown as { translate(path: string): unknown }).translate('/home/same.md') as ToolExecutionResult)
    assert.equal(calls, 2)
    cp.execFileSync = (() => { throw new Error('a click must not reselect the default') }) as typeof cp.execFileSync
    syncBuiltinESMExports()
    assert.deepEqual(referenceBinding('ref-default'), { status: 'bound', distro: 'DefaultAtExecution' })
    assert.deepEqual(referenceBinding('ref-missing'), { status: 'unknown' })
  } finally { cp.execFileSync = original; syncBuiltinESMExports() }
})


test('a newly composed WSL agent publishes its provider coordinate before any tool call', async () => {
  const { createScope, scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const { referenceBinding } = await import('../src/shared/reference-world.ts')
  const root = referenceWorldRegistry(new Context())
  const keyA = {}, keyB = {}
  const a = createScope(root, keyA), b = createScope(root, keyB)
  try {
    const realmA = a.ctx.isolate('fs'), realmB = b.ctx.isolate('fs')
    await realmA.plugin(WslFileSystem, { distro: 'Ubuntu-20.04' })
    await realmB.plugin(WslFileSystem, { distro: 'Debian' })
    const agent = { ctx: realmA, session: { id: 'fresh-before-tools', header: { cwd: 'D:/projects/demo' } } }
    await root.serial(scopeTarget(agent, keyA) as never, 'agent/created', { agent, source: 'create' } as never)
    assert.deepEqual(referenceBinding('fresh-before-tools'), { status: 'bound', distro: 'Ubuntu-20.04' })
    const other = { ctx: realmB, session: { id: 'fresh-other', header: { cwd: 'D:/projects/demo' } } }
    await root.serial(scopeTarget(other, keyB) as never, 'agent/created', { agent: other, source: 'create' } as never)
    assert.deepEqual(referenceBinding('fresh-other'), { status: 'bound', distro: 'Debian' })
  } finally { await a.dispose(); await b.dispose() }
})


test('a first binding request resumes on world creation and cancels without polling', async () => {
  const { waitForReferenceBinding, referenceBinding } = await import('../src/shared/reference-world.ts')
  const abort = new AbortController()
  let settled = false
  const pending = waitForReferenceBinding('first-click-await-world', abort.signal).then(value => { settled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  const ctx = referenceWorldRegistry(new Context())
  await ctx.plugin(WslFileSystem, { distro: 'Ubuntu-20.04' })
  await ctx.serial('agent/created', { agent: { session: { id: 'first-click-await-world', header: { cwd: 'D:/projects/demo' } } }, source: 'create' } as never)
  assert.deepEqual(await pending, { status: 'bound', distro: 'Ubuntu-20.04' })
  const cancelled = new AbortController()
  const missing = waitForReferenceBinding('cancelled-first-click', cancelled.signal)
  cancelled.abort()
  assert.deepEqual(await missing, { status: 'unknown' })
  assert.deepEqual(referenceBinding('never-existed'), { status: 'unknown' })
})


test('standing WSL worlds do not initialize another composition or a native Windows agent', async () => {
  const { referenceBinding } = await import('../src/shared/reference-world.ts')
  const root = referenceWorldRegistry(new Context())
  const a = root.isolate('fs'), b = root.isolate('fs')
  const fa = a.plugin(WslFileSystem, { distro: 'Ubuntu-20.04' })
  const fb = b.plugin(WslFileSystem, { distro: 'Debian' })
  try {
    await fa; await fb
    // Deliberately broadcast: on affected hosts all standing compositions hear
    // this event. Only serviceFor's exact selected provider may initialize it.
    await root.serial('agent/created', { agent: { ctx: a, session: { id: 'standing-selected', header: { cwd: 'D:/projects/demo' } } }, source: 'create' } as never)
    assert.deepEqual(referenceBinding('standing-selected'), { status: 'bound', distro: 'Ubuntu-20.04' })
    await root.serial('agent/created', { agent: { ctx: root, session: { id: 'standing-native', header: { cwd: 'D:/projects/demo' } } }, source: 'create' } as never)
    assert.deepEqual(referenceBinding('standing-native'), { status: 'unknown' })
  } finally { await fa.dispose(); await fb.dispose() }
})


test('manually selecting WSL on a fresh Windows agent initializes before its first tool call', async () => {
  const { referenceBinding } = await import('../src/shared/reference-world.ts')
  const root = referenceWorldRegistry(new Context())
  const world = root.isolate('fs')
  const agent = { ctx: root, session: { id: 'fresh-manual-selection', header: { cwd: 'D:/projects/demo' } } }
  root.provide('agents', { get: (id: string) => id === agent.session.id ? agent : undefined } as never)
  const fiber = world.plugin(WslFileSystem, { distro: 'Ubuntu-20.04' })
  try {
    await fiber
    await root.serial('agent/created', { agent, source: 'create' } as never)
    assert.deepEqual(referenceBinding(agent.session.id), { status: 'unknown' }, 'initial native Windows composition')
    agent.ctx = world
    root.emit('agent-preset/selected', agent.session.id as never, 'wsl-standard')
    assert.deepEqual(referenceBinding(agent.session.id), { status: 'bound', distro: 'Ubuntu-20.04' }, 'post-mount selection needs no tool prewarm')
  } finally { await fiber.dispose() }
})
