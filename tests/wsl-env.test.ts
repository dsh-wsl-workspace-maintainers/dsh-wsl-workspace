/**
 * The readiness bridge, offline.
 *
 * issue #51 point 2 is that the host injects its bash readiness contract as
 * Windows environment variables, and WSL imports a variable into a distribution
 * only when `WSLENV` names it — so the persistent shell came up with the
 * distribution's own prompt and the host could never recognise it. The live half of
 * this is measured by `scripts/compatibility/conpty-relay.mjs` (which now reddens on
 * the missing marker); this file pins the arithmetic that decides what gets named,
 * because the relay module spawns `wsl.exe` at load and cannot be imported to test.
 *
 * @module dsh-wsl-workspace/tests/wsl-env
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeReadiness, READINESS_KEYS } from '../src/shared/wsl-env.ts'

test('the contract keys are named when the host injected them', () => {
  const merged = bridgeReadiness({ PATH: 'C:\\Windows', PS1: 'dsh> ', PROMPT_COMMAND: 'printf x' })
  assert.equal(merged.WSLENV, 'PS1:PROMPT_COMMAND', 'both keys named, in declaration order')
  assert.equal(merged.PATH, 'C:\\Windows', 'the rest of the environment survives')
})

test('a key the host did not inject is not named', () => {
  // The pwsh dialect gets no PS1/PROMPT_COMMAND at all, and an unrelated host env
  // must not have a dangling name added to WSLENV for a variable that does not exist.
  assert.equal(bridgeReadiness({ PATH: 'x' }).WSLENV, undefined,
    'nothing to bridge: WSLENV is not invented out of nowhere')
  assert.equal(bridgeReadiness({ PS1: '', PROMPT_COMMAND: 'printf x' }).WSLENV, 'PROMPT_COMMAND',
    'an empty value is skipped the same way an absent one is')
})

test('ambient WSLENV is preserved and never duplicated', () => {
  const merged = bridgeReadiness({ WSLENV: 'FOO/p:BAR', PS1: 'dsh> ', PROMPT_COMMAND: 'printf x' })
  assert.equal(merged.WSLENV, 'FOO/p:BAR:PS1:PROMPT_COMMAND', 'existing entries keep their flags and order')
  const already = bridgeReadiness({ WSLENV: 'PS1/p', PS1: 'dsh> ' })
  assert.equal(already.WSLENV, 'PS1/p', 'a name already present is not added a second time')
  assert.equal(already.WSLENV?.split(':').filter(entry => entry.replace(/\/[plu]$/, '') === 'PS1').length, 1,
    'exactly one PS1 entry — a duplicate would make wsl.exe resolve it twice')
})

test('prompt values never get the path-translation flag', () => {
  // `/p` rewrites a Windows path into /mnt/<drive>/… on the way in. The contract
  // strings contain backslashes and colons that are part of the prompt, not paths,
  // so a bridge that "helpfully" flagged them would ship a mangled PROMPT_COMMAND.
  const merged = bridgeReadiness({ PS1: 'dsh> ', PROMPT_COMMAND: 'C:\\Users\\x; printf y' })
  assert.ok(merged.WSLENV !== undefined, 'both keys were injected, so WSLENV exists to inspect')
  for (const entry of merged.WSLENV.split(':')) {
    assert.ok(!/\/p$/.test(entry), `${entry} must not carry /p`)
  }
  assert.equal(merged.PROMPT_COMMAND, 'C:\\Users\\x; printf y', 'the value itself is handed over untouched')
})

test('the caller environment object is not mutated', () => {
  const source = { PS1: 'dsh> ' }
  const merged = bridgeReadiness(source)
  merged.WSLENV = 'mutated'
  assert.equal((source as { WSLENV?: string }).WSLENV, undefined, 'the input stays as the caller left it')
})

test('the declared key list is the only place the names appear', () => {
  assert.deepEqual([...READINESS_KEYS], ['PS1', 'PROMPT_COMMAND'],
    'a second list would let the two halves drift apart')
})
