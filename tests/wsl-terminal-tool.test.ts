// The keyboard door's model-facing contract, pinned without a terminal.
//
// Everything here runs against a stand-in registry: the cells are about what the tool ASKS the
// host for and what it tells the model, not about PTY mechanics (those are measured in
// `scripts/compatibility/bash-session-real.mjs` against a real `wsl.exe … bash -i` under a real
// ConPTY). Two of the cells exist because their absence would be silent: the quiet note must not
// read like a prompt, and a Linux `cwd` must not be handed to a Windows PTY child as-is.
//
// Run: node --experimental-strip-types --test tests/wsl-terminal-tool.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, backendCwd, pickSession, settleNote } from '../src/host/wsl-terminal-tool.ts'

/** One published session, as the registry reports it. */
type Snapshot = { sessionId: string, name?: string, type: string, status: { kind: 'running' } | { kind: 'exited', exitCode: number | null, signal: string | null } }

/** A settled send, as the backend hands it back. */
function sendResult(waitReason: 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit' = 'stdin_read') {
  return {
    viewport: '',
    waitReason,
    sessionStatus: { kind: 'running' as const },
    truncated: false,
  }
}

/** A registry double that records every call and answers scripted results. */
function harness(options: { sessions?: Snapshot[], delta?: string, result?: ReturnType<typeof sendResult>, spawnId?: string, spawnMotd?: string, spawnThrows?: string } = {}) {
  const calls: { method: string, args: unknown[] }[] = []
  const sessions = options.sessions ?? []
  const registry = {
    spawn: async (...args: unknown[]) => {
      calls.push({ method: 'spawn', args })
      if (options.spawnThrows !== undefined) throw new Error(options.spawnThrows)
      const id = options.spawnId ?? 'pty-1'
      sessions.push({ sessionId: id, type: 'wsl', status: { kind: 'running' } })
      return { sessionId: id, type: 'wsl', status: { kind: 'running' }, motd: options.spawnMotd ?? 'dsh> ' }
    },
    startSend: (...args: unknown[]) => {
      calls.push({ method: 'startSend', args })
      return {
        done: Promise.resolve(options.result ?? sendResult()),
        readOutput: () => ({ delta: options.delta ?? '', truncated: false }),
        cancel: () => false,
      }
    },
    read: (...args: unknown[]) => {
      calls.push({ method: 'read', args })
      return { text: 'line one\nline two', totalLines: 120, lineBegin: 0, lineEnd: 2, truncated: false }
    },
    signal: async (...args: unknown[]) => {
      calls.push({ method: 'signal', args })
      return { delivered: true as const, targetPgid: 0 }
    },
    kill: async (...args: unknown[]) => {
      calls.push({ method: 'kill', args })
      return true
    },
    list: (...args: unknown[]) => {
      calls.push({ method: 'list', args })
      return [...sessions]
    },
  }
  let registered: { execute: (args: unknown, exec: unknown) => Promise<{ text: string }> } | undefined
  const ctx = {
    get: (key: string) => {
      if (key === 'tools') return { register: (tool: unknown) => { registered = tool as typeof registered } }
      if (key === 'terminals') return registry
      return undefined
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  }
  apply(ctx as never)
  return { calls, sessions, registry, tool: registered as NonNullable<typeof registered> }
}

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\ruler\\proj'
const exec = { agent: { id: 'agent-door', session: { header: { cwd: UNC } } } }

/** The recorded arguments of the nth call to one method. */
function callArgs(calls: { method: string, args: unknown[] }[], method: string, index = 0): unknown[] {
  const found = calls.filter(call => call.method === method)
  const entry = found[index]
  assert.ok(entry !== undefined, `expected a ${method} call (${index}) — got ${calls.map(call => call.method).join(', ')}`)
  return entry.args
}

test('a Linux cwd is translated through the session distribution, never handed to the PTY raw', () => {
  assert.equal(backendCwd(undefined, UNC), UNC, 'no request keeps the session workspace')
  assert.equal(backendCwd('/tmp', UNC), '\\\\wsl.localhost\\Ubuntu\\tmp', 'a Linux path becomes this distribution\'s UNC path')
  assert.equal(backendCwd('sub/dir', UNC), '\\\\wsl.localhost\\Ubuntu\\home\\ruler\\proj\\sub\\dir', 'a relative path joins the session directory')
  assert.equal(backendCwd('D:\\work', UNC), 'D:\\work', 'a Windows drive path passes through (the relay maps it)')
  assert.equal(backendCwd('\\\\wsl.localhost\\Other\\srv', UNC), '\\\\wsl.localhost\\Other\\srv', 'a UNC path is already usable')
  assert.throws(() => backendCwd('/tmp', 'D:\\plain'), /not a WSL UNC path/, 'a Linux path with no distribution to translate through is refused, not guessed')
})

test('the only open session needs no name, and an ambiguous pick says which ones exist', () => {
  const one: Snapshot[] = [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'running' } }]
  assert.equal(pickSession(one, undefined)?.sessionId, 'pty-1', 'the only session needs no name')
  const two: Snapshot[] = [
    { sessionId: 'pty-1', name: 'build', type: 'wsl', status: { kind: 'running' } },
    { sessionId: 'pty-2', type: 'wsl', status: { kind: 'running' } },
  ]
  assert.equal(pickSession(two, 'pty-2')?.sessionId, 'pty-2', 'by id')
  assert.equal(pickSession(two, 'build')?.sessionId, 'pty-1', 'by name')
  assert.throws(() => pickSession(two, undefined), /2 terminals are open.*pty-1, pty-2/, 'two open and none named lists them')
  assert.throws(() => pickSession(two, 'pty-9'), /no owned terminal "pty-9"; open ones: pty-1, pty-2/, 'an unknown id lists the real ones')
  assert.equal(pickSession([], undefined), undefined, 'nothing open is not an error here — `send` may open one')
})

test('the quiet note does not read like a prompt, and the recognised one does', () => {
  assert.match(settleNote(sendResult('stdin_read'), 1200), /back at the prompt/)
  const quiet = settleNote(sendResult('inferred_idle'), 1200)
  assert.match(quiet, /nothing was written for ~1200 ms/)
  assert.ok(!/prompt\]$/.test(quiet), 'a quiet screen must not be reported as a prompt')
  assert.match(settleNote(sendResult('timeout'), 1200), /still running/)
  assert.match(settleNote({ ...sendResult(), sessionStatus: { kind: 'exited', exitCode: 3, signal: null } }, 1200), /exited: exited \(code 3\)/)
})

test('open spawns on the door\'s backend type in the session directory, and shows the first screen', async () => {
  const { tool, calls } = harness({ spawnId: 'pty-7', spawnMotd: 'welcome dsh> ' })
  const value = await tool.execute({ action: 'open' }, exec)
  const [owner, request] = callArgs(calls, 'spawn') as [unknown, { type: string, cwd?: string }]
  assert.equal(request.type, 'wsl', 'the door uses the world\'s own backend type')
  assert.equal(request.cwd, UNC, 'and starts in the session workspace')
  assert.equal((owner as { id: string }).id, 'agent-door', 'as the live owner, so the registry can scope cleanup to it')
  assert.match(value.text, /welcome dsh>/, 'the first screen is shown')
  assert.match(value.text, /terminal pty-7 is open/, 'and the id the caller needs next')
})

test('send types the text with Enter unless asked not to, and answers with the delta', async () => {
  const { tool, calls } = harness({ sessions: [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'running' } }], delta: 'typed\nGOT=hello\n' })
  const value = await tool.execute({ action: 'send', session: 'pty-1', text: 'hello' }, exec)
  const [, id, request] = callArgs(calls, 'startSend') as [unknown, string, { text: string, submit: boolean }]
  assert.equal(id, 'pty-1')
  assert.deepEqual({ text: request.text, submit: request.submit }, { text: 'hello', submit: true }, 'Enter is the default')
  assert.match(value.text, /GOT=hello/, 'the delta is the body')
  assert.match(value.text, /back at the prompt/, 'and how it ended is stated')

  const second = harness({ sessions: [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'running' } }] })
  await second.tool.execute({ action: 'send', text: 'yes', submit: false }, exec)
  const request2 = callArgs(second.calls, 'startSend')[2] as { submit: boolean }
  assert.equal(request2.submit, false, 'submit:false types without running anything')
})

test('send is the one action that may open the terminal it types into', async () => {
  const { tool, calls } = harness({ spawnId: 'pty-3' })
  const value = await tool.execute({ action: 'send', text: 'whoami' }, exec)
  assert.ok(calls.some(call => call.method === 'spawn'), 'a keyboard request with nothing open starts a terminal')
  assert.ok(calls.some(call => call.method === 'startSend'), 'and then types into it')
  assert.match(value.text, /back at the prompt/)
})

test('read pages the screen and says where the page sits', async () => {
  const { tool, calls } = harness({ sessions: [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'running' } }] })
  const value = await tool.execute({ action: 'read', offset: 40, count: 10 }, exec)
  const [, , request] = callArgs(calls, 'read') as [unknown, string, { offset: number, count: number }]
  assert.deepEqual(request, { offset: 40, count: 10 })
  assert.match(value.text, /lines 0\.\.2 of 120 retained/)
})

test('an exited shell takes no more typing, but its last screen is still readable, and it can be closed', async () => {
  const exited: Snapshot[] = [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'exited', exitCode: 130, signal: null } }]
  const { tool, calls } = harness({ sessions: exited })
  await assert.rejects(() => tool.execute({ action: 'send', text: 'ls' }, exec), /has exited \(exited \(code 130\)\)/)
  await assert.rejects(() => tool.execute({ action: 'signal', signal: 'SIGINT' }, exec), /has exited/)
  const read = await tool.execute({ action: 'read' }, exec)
  assert.match(read.text, /line one/, 'the last screen is the evidence of why it exited')
  const closed = await tool.execute({ action: 'close' }, exec)
  assert.match(closed.text, /terminal pty-1 closed/)
  assert.ok(calls.some(call => call.method === 'kill'), 'close reaches the registry')
})

test('signal names the delivered group, and both a bad and a missing name are refused', async () => {
  const { tool, calls } = harness({ sessions: [{ sessionId: 'pty-1', type: 'wsl', status: { kind: 'running' } }] })
  const value = await tool.execute({ action: 'signal', signal: 'SIGINT' }, exec)
  assert.match(value.text, /SIGINT delivered to the foreground process group 0/)
  const [, , name] = callArgs(calls, 'signal') as [unknown, string, string]
  assert.equal(name, 'SIGINT')
  // An out-of-enum name never reaches this tool: the host's argument validation refuses it first.
  await assert.rejects(() => tool.execute({ action: 'signal', signal: 'SIGUSR1' as never }, exec), /must be one of \[\"SIGINT\"/)
  // A missing one gets past that validation, so the tool's own sentence is what the model reads.
  await assert.rejects(() => tool.execute({ action: 'signal' }, exec), /needs one of SIGINT/)
})

test('list reports the open terminals, and an empty list says how to start one', async () => {
  const empty = harness()
  assert.match((await empty.tool.execute({ action: 'list' }, exec)).text, /no terminal is open — action "open"/)
  const open = harness({ sessions: [{ sessionId: 'pty-1', name: 'build', type: 'wsl', status: { kind: 'running' } }] })
  const value = await open.tool.execute({ action: 'list' }, exec)
  assert.match(value.text, /pty-1\trunning\tbuild/)
})

test('a host with no terminal service says so instead of failing at the call site', async () => {
  let registered: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
  const ctx = {
    get: (key: string) => key === 'tools' ? { register: (tool: unknown) => { registered = tool as typeof registered } } : undefined,
    effect: (fn: () => unknown) => { fn(); return () => {} },
  }
  apply(ctx as never)
  await assert.rejects(() => registered!.execute({ action: 'list' }, exec), /no terminal service/)
})

test('the tool registers under its own name with the action set the schema advertises', () => {
  let registered: { name: string, parameters: { required?: string[], properties: Record<string, { enum?: string[] }> } } | undefined
  const ctx = {
    get: (key: string) => key === 'tools' ? { register: (tool: unknown) => { registered = tool as typeof registered } } : undefined,
    effect: (fn: () => unknown) => { fn(); return () => {} },
  }
  apply(ctx as never)
  assert.equal(registered?.name, 'wsl_terminal')
  assert.deepEqual(registered?.parameters.properties.action?.enum, ['open', 'send', 'read', 'signal', 'close', 'list'])
  assert.deepEqual(registered?.parameters.required, ['action'], 'only the action is required — every other key belongs to one action')
})
