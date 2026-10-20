/**
 * Probe hygiene: the two instrument failures that cost a whole evening must be un-writable, not merely
 * fixed once.
 *
 * On 2026-10-19 three probes each carried a private way of resolving host packages, and two of those ways
 * lied:
 *   · a loader row mounted by package NAME resolved a second copy of the same class, so `instanceof` was
 *     false for the host's own provider (w78's two reds);
 *   · a probe printed its verdict and then stayed alive, so `run-seams` read `ETIMEDOUT` and reported a
 *     `harness-exit` red for a suite that had already answered (w92), and the leaked process held a native
 *     DLL that made the next `npm ci` fail with EPERM.
 *
 * Both are now structural: probes mount host rows through `host-closure.mjs` (which asserts the release and
 * canonicalises the module URL) and exit through `report.mjs`.
 *
 * The scan covers the suites `scripts/run-seams.mjs` actually runs, derived from that file rather than
 * listed here, so a probe added to the gate is covered the day it is wired in and a probe removed from it
 * stops being checked. `w51-probe` and `w51-command-census` are older manual probes that still mount rows by
 * name; they are out of scope until they join the gate, and this test says so by not naming them.
 *
 * The checker carries its own positive control: a scan that can only ever say "clean" is the failure mode
 * these files exist to prevent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_SEAMS = join(repoRoot, 'scripts', 'run-seams.mjs')

/** Probe files the seam gate runs, read out of the runner itself. */
function gatedProbes () {
  const runner = readFileSync(RUN_SEAMS, 'utf8')
  const names = [...new Set([...runner.matchAll(/tests\/support\/(w[\w-]+\.mjs)/g)].map(match => match[1]))]
  return names.map(name => ({ name, path: join(repoRoot, 'tests', 'support', name) }))
}

/** The two shapes, as matchers a caller can run against any text — that is what makes the control possible. */
const RULES = [
  {
    id: 'exit-through-finish',
    why: 'a probe that prints a verdict and keeps running reads as a dead suite to a runner that waits on the pipe; `report.mjs` exits for you',
    hook: /process\.exitCode\s*=/,
  },
  {
    id: 'mount-by-mount-row',
    why: 'a loader row naming a host package resolves a second copy of the same file; mount it through `mountedRow`/`mountedPath` so the row and the probe agree on one module',
    hook: /^ {6}name: ['"]@deepseek-ai\//m,
  },
]

test('the gate actually names probes, so a clean scan means something', () => {
  const probes = gatedProbes()
  assert.ok(probes.length >= 3, `run-seams names ${probes.length} probe file(s) — a scan over nothing is vacuously green`)
  for (const probe of probes) assert.ok(existsSync(probe.path), `run-seams names a probe that does not exist: ${probe.name}`)
})

test('no gated probe uses the two shapes the shared helpers replaced', () => {
  const violations = []
  for (const { name, path } of gatedProbes()) {
    const text = readFileSync(path, 'utf8')
    for (const rule of RULES) {
      if (rule.hook.test(text)) violations.push(`${name}: ${rule.id} — ${rule.why}`)
    }
  }
  assert.deepEqual(violations, [], `${violations.length} gated probe(s) bypass the shared instrument:\n  ${violations.join('\n  ')}`)
})

test('every gated probe takes rows from host-closure and exits through report', () => {
  const missing = []
  for (const { name, path } of gatedProbes()) {
    const text = readFileSync(path, 'utf8')
    if (!text.includes("from './report.mjs'")) missing.push(`${name}: does not import ./report.mjs`)
    if (/@deepseek-ai\/dsh-/.test(text) && !text.includes("from './host-closure.mjs'")) {
      missing.push(`${name}: names a host package but does not import ./host-closure.mjs`)
    }
  }
  assert.deepEqual(missing, [], `${missing.length} gated probe(s) re-derive what the shared modules answer:\n  ${missing.join('\n  ')}`)
})

test('the checker catches both shapes in a sample — the rules are not ornament', () => {
  const sample = [
    "      name: '@deepseek-ai/dsh-tool-fs'",
    'process.exitCode = 1',
  ].join('\n')
  const caught = RULES.filter(rule => rule.hook.test(sample)).map(rule => rule.id)
  assert.deepEqual(caught, RULES.map(rule => rule.id), `the sample should trip every rule; it tripped ${caught.join(', ') || '(none)'}`)
})
