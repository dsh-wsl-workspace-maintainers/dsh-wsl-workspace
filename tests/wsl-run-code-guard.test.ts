import { test } from 'node:test'
import assert from 'node:assert/strict'
import { denyRunCodeOn9p, isWsl9pRoot, refusalForRoot } from '../src/host/wsl-run-code-guard.ts'

const NINE_P = '\\\\wsl.localhost\\Ubuntu\\home\\ruler\\project'
const runCode = { name: 'run_code', arguments: { code: 'return 1;' } }

// The measured failing shape: everything the guard needs is present, so it must answer with words.
test('the guard refuses run_code on a 9P root under workspace-write', () => {
  const reason = denyRunCodeOn9p(runCode, { mode: 'workspace-write', workspaceRoot: NINE_P })
  assert.equal(typeof reason, 'string')
  assert.match(reason ?? '', /GetNamedSecurityInfoW failed \(Win32 1\)/)
  assert.match(reason ?? '', /read-only/)
  assert.match(reason ?? '', /danger-full-access/)
  assert.match(reason ?? '', /bash/)
  assert.match(reason ?? '', /issue #78/)
  assert.ok((reason ?? '').includes(NINE_P), 'the sentence quotes the root it tested')
})

// Every one of these is a shape where the call does start, so refusing it would take a working
// capability away — the failure mode this file's rule exists to avoid.
test('it stays silent for the three settings that do run', () => {
  for (const mode of ['read-only', 'danger-full-access']) {
    assert.equal(denyRunCodeOn9p(runCode, { mode, workspaceRoot: NINE_P }), undefined, mode)
  }
  assert.equal(denyRunCodeOn9p(runCode, { workspaceRoot: NINE_P }), undefined)
})

test('it stays silent for a root the ACL runner can read', () => {
  assert.equal(denyRunCodeOn9p(runCode, { mode: 'workspace-write', workspaceRoot: 'C:\\Users\\ruler\\project' }), undefined)
  // An ordinary SMB share has a security descriptor; only the WSL 9P roots lack one.
  assert.equal(denyRunCodeOn9p(runCode, { mode: 'workspace-write', workspaceRoot: '\\\\fileserver\\share\\project' }), undefined)
  assert.equal(denyRunCodeOn9p(runCode, { mode: 'workspace-write', workspaceRoot: '/home/ruler/project' }), undefined)
})

test('it stays silent when the user approved a wider mode for this call', () => {
  const escalated = { ...runCode, arguments: { code: 'return 1;', sandbox_permissions: 'danger-full-access' } }
  assert.equal(denyRunCodeOn9p(escalated, { mode: 'workspace-write', workspaceRoot: NINE_P }), undefined)
})

test('it speaks only for run_code', () => {
  for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'wsl_terminal']) {
    assert.equal(denyRunCodeOn9p({ name, arguments: {} }, { mode: 'workspace-write', workspaceRoot: NINE_P }), undefined, name)
  }
})

test('a policy that could not be read is not a refusal', () => {
  assert.equal(denyRunCodeOn9p(runCode, undefined), undefined)
  assert.equal(denyRunCodeOn9p(runCode, {}), undefined)
})

// The root test is what makes the guard narrower than "any UNC", so it gets its own cases: the legacy
// alias must be caught, and the two WSL roots are the only ones the Windows ACL runner cannot open.
test('isWsl9pRoot names exactly the 9P shares', () => {
  assert.ok(isWsl9pRoot(NINE_P))
  assert.ok(isWsl9pRoot('\\\\WSL.localhost\\Ubuntu\\x'), 'case-insensitive')
  assert.ok(isWsl9pRoot('\\\\wsl$\\Ubuntu\\x'), 'the legacy alias')
  assert.ok(!isWsl9pRoot('\\\\wsl.localhost'), 'a bare server with no share is not a workspace')
  assert.ok(!isWsl9pRoot('\\\\server\\share'))
  assert.ok(!isWsl9pRoot('C:\\\\wsl.localhost\\x'))
})

test('the sentence is one paragraph and names the cause before the exits', () => {
  const text = refusalForRoot(NINE_P)
  assert.doesNotMatch(text, /\n/)
  const cause = text.indexOf('security descriptor')
  const exits = text.indexOf('Three settings do run')
  assert.ok(cause >= 0 && exits > cause, 'a reader learns why before being told what to do')
})
