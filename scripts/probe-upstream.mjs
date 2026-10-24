// The upstream drift probe: ask the registry whether the @deepseek-ai family has published past
// the pinned release, and if it has, write the bumped pin set over ci/pinned-deps.json so the
// workflow can install it and run the everyday gates against the moved family.
//
//   node scripts/probe-upstream.mjs                  # detect; write the bumped pins when moved
//   node scripts/probe-upstream.mjs --version 0.2.1-rc.3   # probe an explicit version, even the pinned one
//
// Why this exists: the biggest escape class in this repository's history is the host moving
// underneath the plugin (#56, #87, #60 — 8 of the 20 replayed defects), and until this probe the
// moved family was invisible until a maintainer bumped ci/pinned-deps.json by hand. The target is
// the highest published version of the umbrella, **not** `dist-tags.latest`: 0.2.1-rc.3 sat on the
// registry a full day before latest moved, and a probe that watched only the dist-tag would have
// spent that day saying "no drift".
//
// What moves: only the lockstep group — the family members whose pin equals the umbrella's pin
// (the "0.2.x siblings" ci/pinned-deps.json's own comment names). cordis, schemastery and
// dsh-client-runtime follow their own version lines upstream and are held at their pins.
//
// Verdicts (each also written to $GITHUB_OUTPUT as `state=`/`target=`/`pinned=`):
//   NO-DRIFT          nothing published sorts past the pinned umbrella
//   FAMILY-INCOMPLETE the umbrella moved but a lockstep member has not published that version —
//                     upstream mid-release (standalone dsh-* tags drift by their own comment);
//                     probing again next week costs nothing
//   READY             every lockstep pin resolves at the new version; ci/pinned-deps.json is
//                     overwritten in the working tree — an ephemeral runner, or locally
//                     `git checkout -- ci/pinned-deps.json`
//
// This script answers exactly one question and owns no verdicts beyond it: the workflow runs the
// gates and files the issue, because a probe that also judged would be a second definition of red.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pinPath = join(here, '..', 'ci', 'pinned-deps.json')
const UMBRELLA = '@deepseek-ai/dsh'
const registry = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const pinned = JSON.parse(readFileSync(pinPath, 'utf8'))
const explicitIndex = process.argv.indexOf('--version')
const explicitArg = explicitIndex === -1 ? undefined : process.argv[explicitIndex + 1]
// A dispatch without the input still arrives as `--version ""` — the empty string is "unspecified",
// not a version (first live dispatch answered INVALID with "has no version " until this line).
const explicit = explicitArg === '' ? undefined : explicitArg

/** Semver precedence with prerelease identifiers (numeric sorts below alphanumeric, absence of a prerelease wins). */
function compare(a, b) {
  const split = v => {
    const i = v.indexOf('-')
    return i === -1 ? { core: v.split('.').map(Number), pre: [] } : { core: v.slice(0, i).split('.').map(Number), pre: v.slice(i + 1).split('.') }
  }
  const A = split(a), B = split(b)
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1
  if (A.pre.length === 0 && B.pre.length === 0) return 0
  if (A.pre.length === 0) return 1
  if (B.pre.length === 0) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The registry's abbreviated metadata for one package — `versions` keyed by version string. */
async function versionsOf(name) {
  const res = await fetch(`${registry}/${encodeURIComponent(name)}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${name}`)
  return Object.keys((await res.json()).versions ?? {})
}

function emit(state, extra = {}) {
  console.log(`drift-probe: ${state}${extra.note ? ` — ${extra.note}` : ''}`)
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\ntarget=${extra.target ?? ''}\npinned=${extra.pinned ?? ''}\n`)
  }
}

const pinnedHead = pinned.deps[UMBRELLA]
const published = await versionsOf(UMBRELLA)
if (published.length === 0) throw new Error('the registry publishes no version of the umbrella')
if (explicit !== undefined && !published.includes(explicit)) {
  emit('INVALID', { note: `@deepseek-ai/dsh has no version ${explicit}`, target: explicit, pinned: pinnedHead })
  process.exit(2)
}
const target = explicit ?? published.reduce((best, v) => (compare(v, best) > 0 ? v : best))
if (explicit === undefined && compare(target, pinnedHead) <= 0) {
  emit('NO-DRIFT', { note: `highest published ${target}, pinned ${pinnedHead}`, target, pinned: pinnedHead })
  process.exit(0)
}
const lockstep = Object.entries(pinned.deps).filter(([, v]) => v === pinnedHead).map(([name]) => name)
const answers = await Promise.all(lockstep.map(async name => [name, await versionsOf(name)]))
const missing = answers.filter(([, versions]) => !versions.includes(target)).map(([name]) => name)
if (missing.length > 0) {
  emit('FAMILY-INCOMPLETE', { note: `${UMBRELLA} published ${target} but ${missing.join(', ')} did not; pinned ${pinnedHead}`, target, pinned: pinnedHead })
  process.exit(0)
}
writeFileSync(pinPath, `${JSON.stringify({
  ...pinned,
  deps: Object.fromEntries(Object.entries(pinned.deps).map(([name, v]) => [name, v === pinnedHead ? target : v])),
}, null, 2)}\n`, 'utf8')
emit('READY', { note: `${lockstep.length} lockstep pin(s) written at ${target} over ${pinnedHead} — restore with \`git checkout -- ci/pinned-deps.json\``, target, pinned: pinnedHead })
