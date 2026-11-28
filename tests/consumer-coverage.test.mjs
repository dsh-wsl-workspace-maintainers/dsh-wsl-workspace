/**
 * The consumer-coverage gate: `docs/CONSUMER-COVERAGE.md` must match what the code actually asks for.
 *
 * Why this file exists at all: every harness in this repository enters through a tool **we** register
 * (`ctx.tools.get('bash')` and friends), so nothing could ever reddened when a *host* tool stopped
 * working inside the world we generate. Three issues arrived through exactly that hole — #54
 * (`read_image` asking for `fs`), #78 (`run_code`'s provider asking for `sandbox`), #60 (a tool name
 * colliding at assembly time) — and the corpus's response to each of them was silence, because the
 * corpus does not sample that axis.
 *
 * So the gate does not add cases. It re-derives, from the pinned host closure and from our own
 * generated presets, the complete set of `(service, host package)` pairs that reach across a realm we
 * cut, and requires the ledger to account for every one of them, with a status that its own evidence
 * supports.
 *
 * What each assertion is for:
 *
 *   · **set equality, both ways** — a new consumer appearing (a host upgrade) reddens it, and a consumer
 *     disappearing while the ledger still carries the row reddens it too. A one-way check would let the
 *     table rot into folklore.
 *   · **status must be supported by its evidence** — `已调用` requires the named file to exist and to
 *     contain the named anchor; `挂载未调用` requires that some harness file really does mention the
 *     package; `未挂载` requires that none does. This is the whole lesson in machine form: **mentioning a
 *     package is not calling it**, and the two states used to be indistinguishable in prose.
 *   · **recall controls** — the two pairs we actually got bitten by must be in the derived set, and the
 *     naive `ctx.<id>` property form must be shown to MISS `dsh-tool-fs`. Without those, "36 pairs" is
 *     just a number somebody read out of a script, and a script that finds nothing looks identical to a
 *     tree with nothing to find.
 *   · **the ratchet** — rows that are not `已调用` are counted against a pinned ceiling. Covering one
 *     means lowering the number in this file; growing it means a host upgrade brought a consumer nobody
 *     looked at, which is the event this gate exists to make loud.
 *
 * Static: no boot, no host, no WSL, no spawn. It reads files and matches them. Node >= 24.
 *
 * Run with `node --test --experimental-strip-types tests/consumer-coverage.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closureRelease, derivedConsumers, harnessMentions, isolatedServices, mentionShapes } from './support/consumer-ledger.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(repoRoot, 'docs', 'CONSUMER-COVERAGE.md')

/**
 * Uncovered-row ceilings by host release. The stable 0.2.2-rc.5 window has 56 pairs and 43 uncovered;
 * 0.2.3-alpha.2 adds four ACP/SDK/Timeline/PTC-executor pairs, three of which still need extra
 * environments, so its ceiling is 47. Rows may declare `since <version> —` in their evidence cell:
 * they are documented ahead of the pin but do not make the stable closure look stale.
 *
 * The ten pairs covered before the 0.2.2-rc.1 bump remain covered, and that bump's three optional-bundle
 * calls keep the stable ceiling at 43. Lower a ceiling when a row gains a real call; raise it only with
 * a named host upgrade and an explicit exit for every newly uncovered row.
 */
const NOT_COVERED_CEILINGS = [
  { since: '0.2.2-rc.5', value: 43 },
  { since: '0.2.3-alpha.2', value: 47 },
]

function compareVersions (left, right) {
  const split = value => {
    const at = value.indexOf('-')
    return at === -1
      ? { core: value.split('.').map(Number), pre: [] }
      : { core: value.slice(0, at).split('.').map(Number), pre: value.slice(at + 1).split('.') }
  }
  const a = split(left)
  const b = split(right)
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn !== yn) return xn ? -1 : 1
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

test('version ordering compares numeric prerelease identifiers numerically', () => {
  assert.ok(compareVersions('0.2.3-alpha.10', '0.2.3-alpha.2') > 0)
  assert.ok(compareVersions('0.2.2-rc.10', '0.2.2-rc.5') > 0)
  assert.ok(compareVersions('0.2.3-alpha.2', '0.2.3-alpha.10') < 0)
})

test('a future since cannot hide a consumer present in the current closure', () => {
  const current = derived[0]
  const futureCurrent = { ...current, status: '未挂载', evidence: 'since 99.0.0 — `-`' }
  assert.equal(rowApplicable(futureCurrent), true)
  assert.equal(rowApplicable({ ...futureCurrent, pkg: 'dsh-not-in-closure' }), false)
})

const hostRelease = closureRelease() ?? '0.0.0'
const sinceOf = row => /^since (\S+) — /.exec(row.evidence)?.[1]
const rowApplicable = (row) => {
  const since = sinceOf(row)
  if (since === undefined || compareVersions(hostRelease, since) >= 0) return true
  return derived.some(consumer => keyOf(consumer) === keyOf(row))
}
const applicableRows = () => rows.filter(rowApplicable)
const notCoveredCeiling = () => NOT_COVERED_CEILINGS
  .filter(entry => compareVersions(hostRelease, entry.since) >= 0)
  .at(-1)?.value ?? 43

/** Parse the ledger's table body: rows whose first cell is a backticked service name. */
function ledgerRows () {
  if (!existsSync(LEDGER)) return []
  return readFileSync(LEDGER, 'utf8').split('\n')
    .map(line => /^\|\s*`([a-z][a-z0-9_-]*)`\s*\|\s*`(dsh-[a-z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line))
    .filter(match => match !== null)
    .map(match => ({ service: match[1], pkg: match[2], status: match[3], evidence: match[4] }))
}

/** The `文件 :: 锚点` half of an evidence cell, when the row claims a real call. */
function anchorOf (evidence) {
  const match = /`([^`]+?)\s*::\s*([^`]+?)`/.exec(evidence)
  return match === null ? null : { file: match[1], token: match[2] }
}

const services = isolatedServices()
const derived = derivedConsumers()
const rows = ledgerRows()
const keyOf = row => `${row.service} x ${row.pkg}`

test('the ledger exists and the derivation is not empty, so a green run means something', () => {
  assert.ok(existsSync(LEDGER), `no ledger at ${LEDGER} — a missing table must not read as "nothing to cover"`)
  assert.ok(services.length >= 3,
    `only ${services.length} isolated service names were read from the generated presets (${services.join(', ')}); `
    + 'a world that stops emitting `isolate:` blocks would make every row below vacuously green')
  assert.ok(derived.length >= 20,
    `only ${derived.length} consumer pairs were derived — the pinned host closure is what this reads, `
    + 'and an empty or partial ci/deps must not look like "no consumers"')
})

test('the recall controls hold: each pair we were bitten by is found by two independent shapes', () => {
  const keys = new Set(derived.map(keyOf))
  // #54: the package that registers `read_image`. #78: the PTC runtime that `run_code` runs on.
  assert.ok(keys.has('fs x dsh-tool-fs'),
    'the extractor lost the `fs` consumer behind issue #54 — the pair is no longer derived, so the gate is blind again')
  assert.ok(keys.has('sandbox x dsh-ptc-runtime-node'),
    'the extractor lost the `sandbox` consumer behind issue #78 — same failure mode, different service')
  // Each of those pairs must be found by **two** shapes, and the shapes are named so a future edit that
  // drops one reddens a specific claim. Measured 2026-10-13 on `dsh-tool-fs`: `ctx.fs` appears 15 times
  // and `get("fs")` appears **0** times — the package reaches the service through the injected proxy
  // property, not a `get` call. So a matcher anchored on the lookup shape alone would have missed the
  // very pair this gate exists to catch, which is the mistake the first draft of this file made (in the
  // other direction: it claimed the property form was the one that missed it, because the check was run
  // through a bash double-quoted string where `\\\\.` arrived as "a literal backslash" and matched
  // nothing). The union of shapes is what survives both kinds of bundling.
  for (const pair of [['fs', 'dsh-tool-fs'], ['sandbox', 'dsh-ptc-runtime-node']]) {
    const [id, pkg] = pair
    const shapes = mentionShapes(pkg, id)
    assert.ok(shapes.property > 0, `${pkg} must still be findable through the ctx.${id} property form (read ${shapes.property})`)
    assert.ok(shapes.inject > 0, `${pkg} must still be findable through its inject declaration (read ${shapes.inject})`)
  }
})

test('every pair the code asks for has a ledger row, and no row is left behind', () => {
  const documented = new Set(rows.map(keyOf))
  const missing = derived.filter(row => !documented.has(keyOf(row))).map(keyOf)
  const stale = applicableRows().filter(row => !new Set(derived.map(keyOf)).has(keyOf(row))).map(keyOf)
  assert.deepEqual(missing, [],
    `${missing.length} host consumer(s) reach across a realm we cut and have no row: ${missing.join(' | ')}. `
    + 'Look at each one before writing it down — that look is the coverage this repository was missing.')
  assert.deepEqual(stale, [],
    `${stale.length} row(s) name a pair the current closure no longer asks for: ${stale.join(' | ')}. `
    + 'A table nobody maintains becomes folklore, which is the failure this gate replaced.')
})

test('each row\'s status is supported by its own evidence', () => {
  const bad = []
  for (const row of rows) {
    const mentions = harnessMentions(row.pkg)
    const anchor = anchorOf(row.evidence)
    if (row.status === '已调用') {
      // A call cannot exist in a package no harness references: `已调用` is the one hand-written claim
      // on this table, and it outranks the derived floor (未挂载 / 挂载未调用) rather than replacing it.
      if (mentions.length === 0) {
        bad.push(`${keyOf(row)}: claims a real call, but no harness file mentions the package at all`)
        continue
      }
      if (anchor === null) {
        bad.push(`${keyOf(row)}: claims a real call with no \`file :: anchor\``)
        continue
      }
      const full = join(repoRoot, anchor.file)
      if (!existsSync(full)) {
        bad.push(`${keyOf(row)}: the evidence file is gone (${anchor.file})`)
      } else if (!readFileSync(full, 'utf8').includes(anchor.token)) {
        bad.push(`${keyOf(row)}: ${anchor.file} no longer contains "${anchor.token}"`)
      }
    } else if (row.status === '挂载未调用') {
      if (mentions.length === 0) bad.push(`${keyOf(row)}: claims a harness mentions it, and none does (${mentions})`)
    } else if (row.status === '未挂载') {
      if (mentions.length > 0) bad.push(`${keyOf(row)}: claims nothing mentions it, but ${mentions.join(', ')} do`)
    } else {
      bad.push(`${keyOf(row)}: status "${row.status}" is outside the vocabulary 已调用 / 挂载未调用 / 未挂载`)
    }
  }
  assert.deepEqual(bad, [], `${bad.length} ledger row(s) are not supported by their evidence:\n  ${bad.join('\n  ')}`)
})

test('the uncovered count sits at its ceiling, so a new consumer cannot enter quietly', () => {
  const applicable = applicableRows()
  const uncovered = applicable.filter(row => row.status !== '已调用').length
  const ceiling = notCoveredCeiling()
  assert.ok(uncovered <= ceiling,
    `${uncovered} of ${applicable.length} applicable consumer pairs have never been executed, above the ceiling of `
    + `${ceiling} for host ${hostRelease}. A host upgrade added a consumer: probe it first, then decide what it costs.`)
  assert.equal(uncovered, ceiling,
    `${uncovered} uncovered of ${applicable.length} applicable rows for host ${hostRelease}, and the table still says ${ceiling} — `
    + 'a row got covered (lower the ceiling) or the table and the derivation disagree.')
})
