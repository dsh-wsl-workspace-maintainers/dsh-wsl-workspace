/**
 * The tool-contract property: **does the far side accept what the description told it to send?**
 *
 * A tool's `description` is not documentation. It is the only thing the model reads before choosing
 * arguments, so every parameter named in it is an instruction. Three things can then be true, and only
 * the first two are defects:
 *
 *   · the description instructs a parameter the schema does not accept — the model is told to do
 *     something that cannot be done;
 *   · the schema accepts a parameter the implementation never reads — accepted and ignored, which is
 *     the same defect wearing a quieter hat, and the one that produces `run_in_background`;
 *   · the schema accepts a parameter **this repository** never reads but the host does — a legitimate
 *     case that must be *declared*, never assumed, because the difference is invisible from here.
 *
 * Nothing in this repository compared a tool description to anything. `tests/locales.test.ts` checked
 * the help *panel* against the code; the descriptions, which the model actually reads, were never
 * checked against anything at all. That is the same missing stage as the rest of this branch — the
 * handoff — with the model as the far side.
 *
 * Static: no boot, no host, no WSL. Node ≥ 24 (`node --test`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describedParameterNames, registeredToolNames, toolContracts } from './parity/derive.mjs'

/**
 * Parameters this repository declares but does not read, with the reason each is legitimate.
 *
 * A key here is a **claim about the host**, and it is a claim this repository cannot verify for
 * itself — which is exactly why it is written down instead of being quietly tolerated by the
 * derivation. Deleting a key makes the gate red, so a parameter cannot stop being read without
 * somebody deciding whether the host still needs it.
 */
const READ_BY_THE_HOST = {
  // `bash` requires the model to write a one-line summary of every command it runs. This repository
  // never reads it; the host's own tool-call record is the only plausible consumer, and the model is
  // being made to produce it on every call either way.
  'bash:description': 'the host renders it beside the tool call; nothing in this repository reads it',
}

/**
 * Reds this gate is carrying, and why.
 *
 * A gate that finds a real defect must be able to **file** it rather than only fail on it, or it
 * cannot be merged into a branch that still has the defect — and "merge it once the code is fixed"
 * is not an option when the gate's whole value is noticing before anyone looks. The arithmetic is the
 * same as `tests/parity/claims.mjs`: a new red fails, a declared red that turns **green** fails, and
 * a debt retires only by being withdrawn in the commit that pays it.
 *
 * `premise` states the invariant and must not name an issue; `validateLedger` refuses one that does.
 */
const DECLARED = [
  {
    id: 'a-description-instructs-a-parameter-the-schema-rejects',
    premise: 'every parameter a description tells the model to pass is one the schema accepts',
    match: value => value.some(entry => entry.tool === 'bash_background' && entry.instructed === 'run_in_background'),
    owed: '`src/host/wsl-jobs.ts`: the `bash_background` description tells the model to pass '
      + '`run_in_background`, and that tool\'s schema does not accept it. The sentence is a '
      + 'cross-reference to `bash`\'s parameter, so whether it reads as an instruction at all '
      + '**depends on the wording** — which is the fragile part, and is stated here rather than left '
      + 'to be discovered when the sentence is reworded.',
    repair: 'Either say it without naming the parameter, or accept the parameter. What must not '
      + 'remain is a sentence that reads to the model as an instruction the schema rejects.',
  },
]

function validateLedger(ledger = DECLARED) {
  for (const entry of ledger) {
    if (typeof entry.premise !== 'string' || entry.premise.trim() === '') {
      throw new Error(`tool-contract: ${entry.id} has no premise. An entry must state the invariant it `
        + 'stands for, or nobody can tell a recurrence from a new defect.')
    }
    if (/#[0-9]+/.test(entry.premise) || /\bissue\b/i.test(entry.premise)) {
      throw new Error(`tool-contract: ${entry.id}'s premise names a bug. State it as the invariant.`)
    }
    if (typeof entry.owed !== 'string' || entry.owed.trim().length < 40) {
      throw new Error(`tool-contract: ${entry.id} does not say what is owed.`)
    }
    if (typeof entry.repair !== 'string' || entry.repair.trim().length < 40) {
      throw new Error(`tool-contract: ${entry.id} does not say how to pay it.`)
    }
  }
  return ledger
}

const contracts = toolContracts()
/** One row per tool, whichever file it lives in. */
const rows = contracts.flatMap(contract => contract.perTool.map(tool => ({ ...tool, file: contract.file, handled: contract.handled })))

test('the derivation found every tool this repository registers', () => {
  // Zero hits would make both properties vacuously green, so the count is pinned rather than assumed.
  const tools = rows.map(row => row.tool).filter(name => name !== '(unnamed)')
  // A floor of **zero** would make both properties below vacuous; a floor of *five* would be a written
  // -down number that goes stale the first time a tool is renamed or removed — which is exactly what
  // happened here: `main` registers three tools, not five. Derived from the registry, never literal.
  assert.ok(tools.length > 0,
    'the derivation found no tools at all, which would make every property below pass without '
    + 'checking anything')
  assert.ok(tools.length === registeredToolNames().length,
    `the gate read ${tools.length} tool(s) but the repository registers ${registeredToolNames().length}`)
  // Against the registry the parity kernel already derives, **not** a written-out list. A list of
  // tool names is a second copy of what the repository registers; it was already wrong on `main`, where
  // it named a tool that branch does not have, and a pin that is wrong about the present cannot catch
  // anything about the future.
  assert.deepEqual([...new Set(tools)].sort(), [...registeredToolNames()].sort(),
    'the tools this gate read are not the tools the repository registers')
})

test('every declared parameter is either read here or declared as the host\'s', () => {
  const unread = []
  for (const row of rows) {
    for (const parameter of row.declared) {
      if (row.handled.includes(parameter)) continue
      const key = `${row.tool}:${parameter}`
      if (READ_BY_THE_HOST[key] !== undefined) continue
      unread.push({ tool: row.tool, parameter, file: row.file })
    }
  }
  // Today this is green: `bash:description` is the one parameter nobody here reads, and it is filed
  // above with the reason. A new accepted-and-ignored parameter lands here instead.
  assert.deepEqual(unread, [],
    `the schema accepts parameter(s) this repository never reads, which is accepted-and-ignored:\n`
    + unread.map(entry => `  ${entry.tool}: ${entry.parameter}  (${entry.file})`).join('\n')
    + '\n  Either the implementation should read it, or add it to READ_BY_THE_HOST with why.')
})

test('every parameter the description instructs is one the schema accepts', () => {
  // The set of names a description may legitimately contain beyond its own parameters: other tools
  // it points at, and words that are not parameter names at all (`sudo`, `htop`). Anything left that
  // is neither a declared parameter nor one of those is an instruction the tool cannot honour.
  const otherTools = new Set(['bash', 'bash_background', 'wsl_terminal', 'job_list', 'job_output', 'job_kill', 'grep', 'glob'])
  const notParameterNames = new Set([
    'sudo', 'ssh', 'top', 'htop', 'design', 'export', 'keyboard', 'close', 'list', 'open', 'read', 'send',
  ])
  const unroutable = []
  for (const row of rows) {
    for (const instructed of row.instructed) {
      if (row.declared.includes(instructed)) continue
      if (otherTools.has(instructed) || notParameterNames.has(instructed)) continue
      unroutable.push({ tool: row.tool, instructed, file: row.file })
    }
  }
  // A declared red that **appears** is the ledger doing its job. One that has **stopped** appearing
  // is the failure: the debt was paid and nobody withdrew the entry, so the gate has forgotten it.
  const ledger = validateLedger()
  const undeclared = unroutable.filter(entry => !ledger.some(item => item.match([entry])))
  const stillOpen = ledger.filter(entry => !entry.match(unroutable))
  assert.deepEqual(undeclared, [],
    `the description tells the model to pass parameter(s) the schema does not accept:\n`
    + undeclared.map(entry => `  ${entry.tool}: ${entry.instructed}  (${entry.file})`).join('\n'))
  assert.deepEqual(stillOpen.map(entry => entry.id), [],
    `declared red(s) no longer appear: ${stillOpen.map(entry => entry.id).join(', ')}. Pay the debt in `
    + 'the same commit that withdraws the entry, or the gate has silently forgotten it.')
})

test('the parameter-name extractor still reads what it is supposed to', () => {
  // A pin on the extractor, because both properties above are defined in terms of it and a broken
  // extractor returns an empty set, which both read as perfect health.
  const names = describedParameterNames(
    'For work that must outlive one call pass `run_in_background: true`; it starts a tracked job '
    + '(`job_output` to read). A command that reaches for the keyboard (`sudo`) is caught.',
  )
  assert.deepEqual(names, ['job_output', 'run_in_background', 'sudo'])
  // A cross-reference is not an instruction. `bash_background`'s own description contains one — "the
  // same producer the `bash` tool's `run_in_background: true` argument uses" — and reading it as an
  // instruction reports a defect on a sentence that is exactly right.
  const crossed = describedParameterNames(
    'It is the same producer the `bash` tool\u2019s `run_in_background: true` argument uses, so pass `tty: true`.',
  )
  // The whole span goes, including the other tool's name: `bash` is not a parameter of this tool
  // either, and leaving it in would put a tool name into the parameter set.
  assert.deepEqual(crossed, ['tty'])
})