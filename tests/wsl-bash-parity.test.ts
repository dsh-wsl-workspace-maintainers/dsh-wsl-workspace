// The declared surface of our `bash` tool against the host's, with every difference accounted for in
// `docs/bash-parity.md`. This is the maintenance gate for "we forked a host tool": when DSH adds a
// parameter or renames an output field, the row appears here before a user finds it.
//
// The host side is read from the *installed* package, not from a copy of its shape in this file, and
// a missing package is a loud NOT VERIFIED rather than a skipped test — the same rule
// `scripts/check-host-prompt-parity.mjs` follows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as applySessionTool, PROBE_CONFIG } from '../src/host/wsl-bash-tool.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The host's `bash` tool source, from either tree this repo can see. */
function hostToolSource(): string | null {
  const name = join('@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js')
  for (const root of [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]) {
    const candidate = join(root, name)
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  try {
    const required = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tool-bash/lib/index.js')
    return readFileSync(required, 'utf8')
  } catch { /* not installed here */ }
  return null
}

/**
 * The keys at the first level of the object literal that begins at or after `from`.
 *
 * Brace counting rather than a regex over the whole block: the host's parameters contain nested
 * objects (`sandbox_permissions` arms) and a regex stops at the first `}` it likes.
 */
function firstLevelKeysAt(source: string, from: number, minKeys = 3): string[] {
  let depth = 0
  let index = source.indexOf('{', from)
  assert.notEqual(index, -1, 'no object literal follows the anchor')
  const keys: string[] = []
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) break
    } else if (depth === 1) {
      const key = /^([A-Za-z_][\w$]*)\s*:/.exec(source.slice(index, index + 40))?.[1]
      if (key !== undefined && /[{[,:(\s]/.test(source[index - 1] ?? ' ')) {
        if (!keys.includes(key)) keys.push(key)
        index += key.length
      }
    }
  }
  assert.ok(keys.length >= minKeys, `parsed to only ${JSON.stringify(keys)}`)
  return keys
}

/** The host's declared parameter keys: the `parameters` block that is the tool's, not a schema's. */
function hostParameterKeys(source: string): string[] {
  for (let at = source.indexOf('parameters: {'); at >= 0; at = source.indexOf('parameters: {', at + 1)) {
    const keys = firstLevelKeysAt(source, at + 'parameters:'.length)
    // The host adds `run_in_background`, `sandbox_permissions` and `justification` through spread
    // conditionals (`...background ? { run_in_background: {…} } : {}`), whose contents sit at depth 2
    // and are invisible to a first-level scan. They are declared parameters all the same, including
    // the second key of a conditional object.
    for (let spot = source.indexOf('? {', at); spot >= 0 && spot < at + 4_000; spot = source.indexOf('? {', spot + 1)) {
      for (const key of firstLevelKeysAt(source, spot + 2, 1)) if (!keys.includes(key)) keys.push(key)
    }
    if (keys.includes('command') && keys.includes('description')) return keys
  }
  assert.fail('no `parameters` block naming both `command` and `description` was found in the host tool')
  return []
}

/** The host's foreground output fields, located by the arm's own `const` rather than by a name. */
function hostForegroundKeys(source: string): string[] {
  const marker = source.indexOf('const: "foreground"')
  assert.notEqual(marker, -1, 'the host no longer declares a foreground output arm')
  const start = source.lastIndexOf('properties: {', marker)
  assert.notEqual(start, -1, 'no properties block precedes the foreground const')
  return firstLevelKeysAt(source, start + 'properties:'.length)
}

/** The ledger, as rows the gates can check against reality. */
interface LedgerRow { id: string, kind: string, verdict: string }
function ledger(): LedgerRow[] {
  const text = readFileSync(join(repoRoot, 'docs', 'bash-parity.md'), 'utf8')
  return text.split('\n').flatMap((line) => {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|.*\|\s*([^|]+?)\s*\|\s*$/.exec(line)
    if (match === null) return []
    const [id, kind, verdict] = [match[1], match[2], match[3]]
    if (id === undefined || kind === undefined || verdict === undefined) return []
    return [{ id, kind, verdict }]
  })
}

/** Register our tool against a fake context and hand back what it declared. */
function ourToolSurface() {
  let registered: any
  const ctx = {
    get: (name: string) => (name === 'tools'
      ? { register: (tool: any) => { registered = tool } }
      : undefined),
    effect: () => () => {},
  }
  applySessionTool(ctx as never, { ...PROBE_CONFIG } as never)
  assert.ok(registered !== undefined, 'our tool did not register')
  const schema = registered.output.schema
  const arms = schema.oneOf ?? [schema]
  const foreground = arms.find((arm: any) => Object.values(arm.properties ?? {}).some((property: any) =>
    property?.const === 'foreground'))
  assert.ok(foreground !== undefined, 'no foreground arm in our own output schema')
  return {
    parameters: Object.keys(registered.parameters.properties ?? registered.parameters),
    fields: Object.keys(foreground.properties),
    render: registered.output.render as (args: unknown, value: unknown) => { text: string }[],
  }
}

/** What our renderer puts in front of the model for a run that timed out, failed, and spilled. */
function ourRenderedText(): string {
  return ourToolSurface().render({}, {
    kind: 'foreground',
    exitCode: 3,
    signal: null,
    timedOut: true,
    aborted: false,
    timeoutMs: 5_000,
    stdout: { text: 'body', truncated: true, spillPath: '/tmp/dsh-spill.log' },
    stderr: { text: 'noise', truncated: false },
    notes: ['[the shell was restarted]'],
  }).map(part => part.text).join('')
}

const hostSource = hostToolSource()
const rows = ledger()

test('the parity ledger is machine-readable and has the rows the gates need', () => {
  assert.ok(rows.length >= 10, `only ${rows.length} rows parsed from docs/bash-parity.md`)
  const ids = rows.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length, 'a duplicated id makes "every difference is declared" meaningless')
  for (const row of rows) assert.ok(['api', 'behaviour'].includes(row.kind), `${row.id} has kind ${row.kind}`)
})

test('our declared surface differs from the installed host tool only in ways the ledger names', {
  skip: hostSource === null && 'NOT VERIFIED: @deepseek-ai/dsh-tool-bash is not installed here',
}, () => {
  const theirs = hostParameterKeys(hostSource ?? '')
  const ours = ourToolSurface().parameters
  const missing = theirs.filter(key => !ours.includes(key)).map(key => `param-${key}`)
  const extra = ours.filter(key => !theirs.includes(key)).map(key => `param-${key}`)
  const declared = new Set(rows.filter(row => row.kind === 'api').map(row => row.id))
  const undeclared = [...missing, ...extra].filter(id => !declared.has(id) && !declared.has(`param-${id.slice(7)}`))
  assert.deepEqual(undeclared, [],
    `undocumented parameter difference: ${JSON.stringify({ onlyTheirs: missing, onlyOurs: extra })} — add a row to docs/bash-parity.md`)
  for (const row of rows.filter(entry => entry.kind === 'api' && entry.id.startsWith('param-'))) {
    const key = row.id.slice('param-'.length)
    const aligned = /^aligned/.test(row.verdict)
    const differs = !ours.includes(key) !== !theirs.includes(key)
    assert.equal(differs, !aligned,
      `the row ${row.id} says "${row.verdict}" but the two tools ${differs ? 'differ' : 'agree'} on \`${key}\``)
  }
})

test('the foreground result carries the same fields, plus only what the ledger declares', {
  skip: hostSource === null && 'NOT VERIFIED: @deepseek-ai/dsh-tool-bash is not installed here',
}, () => {
  const theirs = hostForegroundKeys(hostSource ?? '').filter(key => key !== 'kind')
  const ours = ourToolSurface().fields.filter(key => key !== 'kind')
  const declared = new Set(rows.filter(row => row.kind === 'api').map(row => row.id))
  const undeclared = [...ours.filter(key => !theirs.includes(key)), ...theirs.filter(key => !ours.includes(key))]
    .filter(key => !declared.has(`field-${key}`))
  assert.deepEqual(undeclared, [],
    `undocumented output field difference: ${JSON.stringify({ onlyOurs: ours.filter(k => !theirs.includes(k)), onlyTheirs: theirs.filter(k => !ours.includes(k)) })}`)
})

test('the markers the client parses are the ones we emit, in the host’s sentences', () => {
  const rendered = ourRenderedText()
  // `client.js` recognises `[exit code: N]` and `[killed by signal: X]` and nothing else as a status
  // pill; the truncation sentence is the host's own wording, copied so one learned sentence works in
  // both worlds.
  assert.ok(rendered.includes('[exit code: 3]'), rendered)
  assert.ok(rendered.includes('[timed out after 5000ms]'), rendered)
  assert.ok(rendered.includes('[output truncated; full output: /tmp/dsh-spill.log]'), rendered)
  assert.ok(rendered.includes('[stderr]\nnoise'), rendered)
  assert.ok(rendered.includes('[the shell was restarted]'), rendered)
})
