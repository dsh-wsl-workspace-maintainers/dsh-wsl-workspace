import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkWslConnection } from '../src/host/wsl-connection.ts'

test('connection means a successful command in the selected distribution and user', async () => {
  let calls = 0
  const options = { run: async (_file: string, args: readonly string[], opts: import('node:child_process').ExecFileOptions) => {
    calls += 1
    assert.deepEqual(args.slice(0, 7), ['--distribution', 'Arch Linux', '--user', 'ray', '--cd', '/', '--exec'])
    assert.equal(args.at(-1), "printf '%s\\n' 'dsh-wsl-connection-ok'")
    assert.equal(opts.timeout, 12_000)
    assert.equal(opts.windowsHide, true)
    return { stdout: Buffer.from('dsh-wsl-connection-ok\n'), stderr: Buffer.alloc(0) }
  } }
  assert.deepEqual(await checkWslConnection('Arch Linux', 'ray', options), { status: 'connected', distro: 'Arch Linux', username: 'ray' })
  await checkWslConnection('Arch Linux', 'ray', options)
  assert.equal(calls, 2, 'a retry must execute again rather than reuse green')
})

test('empty username uses the distribution default user', async () => {
  const result = await checkWslConnection('Ubuntu', '', { run: async (_file, args) => {
    assert.ok(!args.includes('--user'))
    return { stdout: 'dsh-wsl-connection-ok\n', stderr: '' }
  } })
  assert.deepEqual(result, { distro: 'Ubuntu', status: 'connected' })
})

test('success requires the fixed probe response, not merely exit zero', async () => {
  assert.deepEqual(await checkWslConnection('Ubuntu', '', { run: async () => ({ stdout: 'welcome', stderr: '' }) }), { distro: 'Ubuntu', status: 'failed', reason: 'connection-failed' })
})

test('unavailable, timeout and command failures remain distinct without leaking stderr', async () => {
  for (const [error, reason] of [
    [{ code: 'ENOENT' }, 'unavailable'],
    [{ killed: true, signal: 'SIGTERM' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 1, stderr: 'private diagnostic' }, 'connection-failed'],
  ] as const) {
    assert.deepEqual(await checkWslConnection('Ubuntu', '', { run: async () => { throw error } }), { distro: 'Ubuntu', status: 'failed', reason })
  }
})

test('invalid distribution and user input never reaches a process', async () => {
  const options = { run: async () => { throw new Error('must not run') } }
  await assert.rejects(checkWslConnection('Ubuntu; touch /tmp/injected', '', options), /distro/)
  await assert.rejects(checkWslConnection('Ubuntu', 'ray;id', options), /username/)
})

test('missing PATH executable falls back to the absolute Windows executable', async () => {
  const previous = process.env.SystemRoot
  process.env.SystemRoot = 'C:\\Windows'
  try {
    const files: string[] = []
    const result = await checkWslConnection('Ubuntu', '', { run: async file => {
      files.push(file)
      if (files.length === 1) throw Object.assign(new Error('not on PATH'), { code: 'ENOENT' })
      return { stdout: 'dsh-wsl-connection-ok\n', stderr: '' }
    } })
    assert.deepEqual(files, ['wsl.exe', 'C:\\Windows\\System32\\wsl.exe'])
    assert.equal(result.status, 'connected')
  } finally {
    if (previous === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = previous
  }
})
