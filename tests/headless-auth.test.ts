/** Fresh account checks and the credential-free headless launch overlay. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHeadlessAuth, type HeadlessAuthOptions } from '../src/host/headless-auth.ts'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }
const client = { version: '0.2.1-rc.2', locale: 'en', timezoneOffsetSeconds: 28_800 }

function service(options: Partial<HeadlessAuthOptions> = {}) {
  return createHeadlessAuth({ client, ...options })
}

type OverlayRow = { id: string; disabled?: boolean; config?: { provider: string; model: string } }

test('a green check requires a fresh ready balance result and returns no account data', async () => {
  let calls = 0
  const auth = service({ account: () => ({ getBalance: async metadata => {
    calls += 1
    assert.deepEqual(metadata, client)
    return { status: 'ready' }
  } }) })
  assert.deepEqual(await auth.check(), { status: 'connected' })
  assert.deepEqual(await auth.check(), { status: 'connected' })
  assert.equal(calls, 2, 'the second check must not reuse an earlier green result')
})

test('unavailable, signed-out and failed account checks remain distinct', async () => {
  assert.deepEqual(await service().check(), { status: 'unavailable', reason: 'service-unavailable' })
  assert.deepEqual(await service({ account: () => ({ getBalance: async () => null }) }).check(), { status: 'signed-out' })
  assert.deepEqual(await service({ account: () => ({ getBalance: async () => ({ status: 'failed' }) }) }).check(), { status: 'failed', reason: 'connection-failed' })
  assert.deepEqual(await service({ account: () => ({ getBalance: async () => { throw new Error('private response') } }) }).check(), { status: 'failed', reason: 'connection-failed' })
  assert.deepEqual(await service({ account: () => { throw new Error('no service') } }).check(), { status: 'unavailable', reason: 'service-unavailable' })
})

test('a timed-out check cannot become green when the abandoned request later resolves', async () => {
  let finish: ((value: { status: 'ready' }) => void) | undefined
  let calls = 0
  const auth = service({ checkTimeoutMs: 5, account: () => ({ getBalance: async () => {
    calls += 1
    if (calls > 1) return null
    return new Promise(resolve => { finish = resolve })
  } }) })
  assert.deepEqual(await auth.check(), { status: 'failed', reason: 'timeout' })
  finish?.({ status: 'ready' })
  assert.deepEqual(await auth.check(), { status: 'signed-out' }, 'a retry must make its own request')
})

test('the overlay enables the account services and routes the desktop account model', () => {
  const result = service({ selection: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }) }).overlay()
  assert.equal(result.filename, 'headless-account.patch.yml')
  const rows = yaml.load(result.yaml) as OverlayRow[]
  assert.deepEqual(rows.slice(0, 3).map(row => [row.id, row.disabled]), [['credentials', false], ['authorization', false], ['deepseek-account', false]])
  assert.deepEqual(rows[3], { id: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } })
  assert.equal(rows.length, 4, 'the overlay carries only the rows it needs')
})

test('a different provider model is not copied onto the account route', () => {
  const rows = yaml.load(service({ selection: () => ({ provider: 'another-provider', model: 'another-model' }) }).overlay().yaml) as OverlayRow[]
  assert.equal(rows[3]?.config?.model, 'deepseek-flash')
})

test('a model name with YAML-significant characters stays one plain string', () => {
  const model = `odd: "name" # not a comment\n- id: injected`
  const rows = yaml.load(service({ selection: () => ({ provider: 'deepseek-account', model }) }).overlay().yaml) as OverlayRow[]
  assert.equal(rows.length, 4, 'the model name must not be able to add rows')
  assert.equal(rows[3]?.config?.model, model)
})

test('an unreadable model selection is reported, not silently replaced', () => {
  const auth = service({ selection: () => { throw new Error('boom') } })
  assert.throws(() => auth.overlay(), /CONFIG_INVALID/)
})
