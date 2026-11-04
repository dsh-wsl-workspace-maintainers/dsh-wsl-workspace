// Release acceptance driver. Only the model is scripted; the profile, generated
// preset, Agent, tool dispatch and on-disk session log are DSH's real paths.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { hostModule, repoRoot } from './host-closure.mjs'

const provider = 'release-acceptance'
const model = 'scripted'
const packageRoot = resolve(process.env.DSH_RELEASE_PACKAGE ?? repoRoot)
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
const overrides = process.env.DSH_RELEASE_HOST_DIR ? [join(resolve(process.env.DSH_RELEASE_HOST_DIR), 'node_modules')] : []
const bundle = 'dsh-wsl-workspace'

function transcriptFile(root, sessionId) {
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const found = transcriptFile(path, sessionId)
      if (found) return found
    } else if (entry.isFile() && basename(root) === sessionId && /^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) {
      return path
    }
  }
}

async function until(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await read()
    if (answer !== undefined) return answer
    if (Date.now() >= deadline) throw new Error(message)
    await delay(50)
  }
}

async function modelRequestedBlock(options, request, selection) {
  // This local smoke sends one fixed synthetic prompt and one tool schema. The
  // DSH workspace, transcripts, system prompt and unrelated tools stay local.
  assert.equal(request.block.name, 'pwsh', 'real-provider smoke only permits pwsh')
  const expected = JSON.parse(request.block.arguments)
  assert.equal(expected.command, 'Write-Output DSH_RELEASE_SMOKE')
  const base = new URL(selection.base)
  assert.equal(base.protocol, 'https:')
  assert(!base.username && !base.password && !base.search && !base.hash)
  const credential = process.env[selection.credentialEnv]
  assert(credential, 'the requested local model credential variable is unset')
  const tool = options.tools.find(candidate => candidate.name === request.block.name)
  const response = await fetch(base.href.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + credential,
      'User-Agent': 'dsh-wsl-workspace-release-acceptance/0.7.13',
      'x-opencode-session': options.sessionId,
    },
    body: JSON.stringify({
      model: selection.model,
      messages: [{ role: 'user', content: 'Call pwsh once with exactly these arguments: ' + request.block.arguments }],
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
      tool_choice: { type: 'function', function: { name: tool.name } },
      stream: false,
    }),
    signal: options.signal,
  })
  assert(response.ok, 'local model smoke returned HTTP ' + response.status)
  const responseCalls = (await response.json()).choices?.[0]?.message?.tool_calls
  assert.equal(responseCalls?.length, 1, 'local model did not request exactly one tool')
  const selected = responseCalls[0]
  assert.equal(selected.function.name, request.block.name)
  assert.deepEqual(JSON.parse(selected.function.arguments), expected, 'local model requested unexpected arguments')
  return { ...request.block, id: selected.id, arguments: selected.function.arguments }
}

export async function withReleaseSession({ cwd, preset = 'wsl-standard', evidenceDir = process.env.DSH_RELEASE_EVIDENCE_DIR, realModel }, run) {
  assert(typeof cwd === 'string' && cwd.length > 0, 'an isolated workspace is required')
  assert(typeof evidenceDir === 'string' && evidenceDir.length > 0, 'an evidence directory is required')
  const output = resolve(evidenceDir)
  mkdirSync(output, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-release-session-'))
  const home = join(scratch, 'home')
  const sessionRoot = join(home, 'sessions')
  const profile = 'release-acceptance'
  const profileDir = join(home, 'profiles', profile)
  const profileModules = join(profileDir, 'node_modules')
  mkdirSync(profileModules, { recursive: true })
  symlinkSync(packageRoot, join(profileModules, bundle), 'junction')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-release-acceptance',
    private: true,
    dependencies: { [bundle]: version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', bundle] } },
  }))
  const overlay = join(scratch, 'release.yml')
  writeFileSync(overlay, [
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: ' + JSON.stringify(sessionRoot),
    '- id: agent-default-model',
    '  config:',
    '    provider: ' + provider,
    '    model: ' + model,
    '',
  ].join('\n'))
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const { namespace: { runProfile }, version: hostVersion } = await hostModule('@deepseek-ai/dsh', { subpath: ['lib', 'profile-boot.js'], overrides })
  const { namespace: { createLaunchEnvironmentSnapshot } } = await hostModule('@deepseek-ai/dsh-launch-environment', { overrides })
  const { namespace: { setSandboxMode: switchSandboxMode } } = await hostModule('@deepseek-ai/dsh-sandbox-policy', { overrides })
  const { namespace: { LlmAdapter } } = await hostModule('@deepseek-ai/dsh-llm', { overrides })
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const { ctx, shutdown } = await runProfile({ environment, profile, patchFiles: [overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
  let finished = false
  const pending = new Map()
  const executions = new Map()
  class ScriptedAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Release acceptance scripted model' } }
    async listModels(route) { return [{ provider: route, id: model, name: 'Release acceptance scripted model', inputModalities: ['text', 'image'] }] }
    async resolveModel(route, id, signal) {
      return { ...(await super.resolveModel(route, id, signal)), inputModalities: ['text', 'image'] }
    }
    async *stream(options) {
      options.signal?.throwIfAborted()
      const request = pending.get(options.sessionId)
      if (options.purpose || request?.sent) {
        const block = { type: 'text', text: 'Acceptance command finished.' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: block.text }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      assert(request, 'scripted model received a request outside an acceptance call')
      assert(options.tools?.some(tool => tool.name === request.block.name), request.block.name + ' missing from model tool list')
      request.sent = true
      const block = realModel ? await modelRequestedBlock(options, request, realModel) : request.block
      request.block = block
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const releaseAdapter = ctx.get('llm').registerAdapter([provider], new ScriptedAdapter())
  const stopObserve = ctx.on('tools/result', (execution, result) => {
    if ([...pending.values()].some(request => request.block.id === execution.callId)) {
      executions.set(execution.callId, result)
    }
  })
  const controller = ctx.get('sessionController')
  assert(controller, 'DSH web session controller did not start')
  const persistence = ctx.get('sessionPersistence')
  assert(persistence, 'DSH durable session storage did not start')
  async function newSession(workspace = cwd, agentPreset = preset) {
    if (agentPreset.startsWith('wsl-')) {
      const presets = ctx.get('agentPresets')
      await untilAsyncPreset(presets, agentPreset)
    }
    const created = await controller.create({ cwd: workspace, agentPreset })
    const { sessionId } = created
    assert.equal(created.agentPreset, agentPreset)
    await persistence.flush()
    await controller.selectModel({ sessionId, provider, model })
    async function call(name, args, { timeoutMs = 120_000, onCall } = {}) {
      assert(!pending.has(sessionId), 'cannot overlap calls in the same acceptance session')
      const id = 'call_' + randomUUID().replaceAll('-', '')
      const block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
      const request = { block, sent: false }
      pending.set(sessionId, request)
      let transcript
      try {
        const signal = AbortSignal.timeout(timeoutMs)
        await controller.prompt({
          requestId: randomUUID(), sessionId, mode: 'queue',
          content: [{ type: 'text', text: 'Execute one scripted release acceptance tool call.' }],
        }, signal)
        transcript = await until(async () => {
          try {
            return await persistence.open(sessionId, 'read', { signal })
          } catch (error) {
            if (error?.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== sessionId) throw error
            return undefined
          }
        }, timeoutMs, 'DSH did not make the new session durable: ' + sessionId)
        const persisted = await until(async () => {
          const { events: records } = await transcript.read(undefined, undefined, { signal })
          const call = records.find(event => event.type === 'tool/call' && event.data.callId === request.block.id)
          if (!call) return
          return call
        }, timeoutMs, name + ' did not produce a persisted tool call ' + id + '; scratch ' + scratch)
        assert.equal(persisted.data.name, name)
        assert.deepEqual(JSON.parse(persisted.data.arguments), args)
        if (onCall) await onCall(persisted)
        const result = await until(async () => {
          const { events: records } = await transcript.read(undefined, undefined, { signal })
          const result = records.find(event => event.type === 'tool/result' && event.data.message.toolCallId === request.block.id)
          if (result && records.some(event => event.type === 'turn/end' &&
              event.data.turn === persisted.data.turn && event.seq > result.seq)) return result
        }, timeoutMs, name + ' did not settle in the persisted transcript ' + id + '; scratch ' + scratch)
        await persistence.flush()
        const source = transcriptFile(sessionRoot, sessionId)
        assert(source, 'default compressed DSH transcript not found for ' + sessionId)
        const transcriptName = sessionId + '.' + basename(source)
        copyFileSync(source, join(output, transcriptName))
        const structured = executions.get(request.block.id)
        assert(structured || result.data.message.isError, 'tool observer did not record execution ' + id)
        const evidence = { sessionId, transcript: transcriptName, call: persisted, result, value: structured?.value, error: structured?.error ?? result.data.error }
        writeFileSync(join(output, id + '.json'), JSON.stringify(evidence, null, 2) + '\n')
        return evidence
      } finally {
        pending.delete(sessionId)
        executions.delete(request.block.id)
        await transcript?.close()
      }
    }
    function setSandboxMode(mode) {
      const agent = ctx.get('agents').get(sessionId)
      assert(agent, 'sandbox mode switch requires an active acceptance agent')
      switchSandboxMode(agent.session, mode)
    }
    return { call, sessionId, controller, setSandboxMode }
  }
  try {
    writeFileSync(join(output, 'build.json'), JSON.stringify({
      version, host: hostVersion,
      git: process.env.GITHUB_SHA,
      bundleSha256: createHash('sha256').update(readFileSync(join(packageRoot, 'lib', 'index.js'))).digest('hex'),
      preset,
      providerModel: realModel?.model ?? model,
    }, null, 2) + '\n')
    const first = await newSession()
    const value = await run({ ...first, newSession })
    finished = true
    return value
  } finally {
    stopObserve()
    releaseAdapter()
    await shutdown.shutdown(finished ? 0 : 1)
  }
}

async function untilAsyncPreset(presets, wanted) {
  assert(presets, 'DSH agent preset roster did not start')
  const deadline = Date.now() + 30_000
  do {
    const entries = await presets.list()
    if (entries.some(entry => entry.id === wanted && !entry.broken)) return
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error('generated preset did not register: ' + wanted)
}
