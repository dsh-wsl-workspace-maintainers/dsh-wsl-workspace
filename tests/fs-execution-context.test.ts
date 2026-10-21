import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WslFileSystem } from '../src/fs.ts'

const sessionCwd = (distro: string) => `\\\\wsl.localhost\\${distro}\\home\\user\\project`

test('cwd-blind file tools inherit the calling session distribution', async () => {
  const ctx = new Context()
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
  const ctx = new Context()
  await ctx.plugin(WslFileSystem, { distro: 'ConfiguredDistro' })
  const fs = ctx.fs as WslFileSystem
  const translated = (fs as unknown as { translate(path: string): { input: string } }).translate('/tmp/file')
  assert.equal(translated.input, '\\\\wsl.localhost\\ConfiguredDistro\\tmp\\file')
})
