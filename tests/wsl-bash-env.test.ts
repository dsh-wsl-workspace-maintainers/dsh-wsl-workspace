/**
 * The persistent shell's process environment, offline.
 *
 * The host's own persistent bash (`@deepseek-ai/dsh-terminal-bash`,
 * `childEnvironment`) tells every PTY child that it is a harness shell and which
 * session owns it: `DSH_SHELL=1` and `DSH_SESSION_ID=<owner>`. A WSL session
 * that omits them is not the shell the host contracts for — a script that asks
 * `[ "$DSH_SHELL" = 1 ]` or groups work by `$DSH_SESSION_ID` takes the wrong
 * branch, and does so silently because the variables are simply unset.
 *
 * `buildSessionSpec` is a pure function over its inputs, so the arithmetic is
 * pinned here without starting a distribution.
 *
 * @module dsh-wsl-workspace/tests/wsl-bash-env
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionSpec } from '../src/host/wsl-bash-tool.ts'

/** The fields `buildSessionSpec` reads, at their defaults. */
const CONFIG = {
  distro: '',
  username: '',
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  graceMs: 3_000,
  bootTimeoutMs: 30_000,
} as never

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\ubuntu'

test('the persistent shell states the host PTY contract', () => {
  const spec = buildSessionSpec(CONFIG, UNC, 'session-abc')
  assert.ok(spec !== undefined, 'the UNC workspace resolves a distribution')
  assert.equal(spec.env.DSH_SHELL, '1', 'the shell says it is a harness shell')
  assert.equal(spec.env.DSH_SESSION_ID, 'session-abc', 'and which session owns it')
})

test('both facts are named in WSLENV, which is what carries them across', () => {
  const spec = buildSessionSpec(CONFIG, UNC, 'session-abc')
  const named = (spec?.env.WSLENV ?? '').split(':')
  assert.ok(named.includes('DSH_SHELL'), 'DSH_SHELL is imported into the distribution')
  assert.ok(named.includes('DSH_SESSION_ID'), 'DSH_SESSION_ID too')
  assert.equal(named.filter(entry => entry === 'DSH_SHELL').length, 1, 'named once')
})

test('a call without an owning session does not invent an id', () => {
  const spec = buildSessionSpec(CONFIG, UNC)
  assert.equal(spec?.env.DSH_SHELL, '1', 'the shell fact is unconditional')
  assert.equal('DSH_SESSION_ID' in (spec?.env ?? {}), false, 'nothing to name, so nothing is named')
  assert.ok(!(spec?.env.WSLENV ?? '').split(':').includes('DSH_SESSION_ID'))
})

test('an empty session id is treated as absent', () => {
  const spec = buildSessionSpec(CONFIG, UNC, '')
  assert.equal('DSH_SESSION_ID' in (spec?.env ?? {}), false)
})

test('an ambient WSLENV entry is preserved and never duplicated', () => {
  const previous = process.env.WSLENV
  process.env.WSLENV = 'DSH_SHELL:/p'
  try {
    const spec = buildSessionSpec(CONFIG, UNC, 'session-abc')
    const named = (spec?.env.WSLENV ?? '').split(':')
    assert.equal(named.filter(entry => entry.replace(/\/[plu]$/, '') === 'DSH_SHELL').length, 1,
      'the ambient spelling is kept rather than named twice')
    assert.ok(named.includes('DSH_SESSION_ID'), 'the new fact is still added')
  } finally {
    if (previous === undefined) delete process.env.WSLENV
    else process.env.WSLENV = previous
  }
})
