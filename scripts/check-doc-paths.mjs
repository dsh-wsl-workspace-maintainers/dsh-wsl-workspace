#!/usr/bin/env node
// Reachability gate: every repository path a document names must actually exist.
// The defect this exists for: TESTING.md pointed at `.test-runs/desktop-cdp.mjs`,
// which is neither in the repo nor in the package — a fresh reader following it
// hits nothing, and nothing complained.
//
// Two modes, because "exists" means different things:
//   node scripts/check-doc-paths.mjs              repo mode  → target exists in the repository
//   node scripts/check-doc-paths.mjs --pack DIR   pack mode  → target exists in the packed artifact
// A line may name a non-shipped target if it says so on the same line
// ("repository-only" / "仓库内" / "not published" / "不随包发布"),
// and `.test-runs/**` needs the same marker ("dev-only" / "开发树").
// Shipped documents also may not carry concrete local paths (placeholders such as
// `<install>` or `D:\path\to\…` are fine), and the two shipped CHANGELOGs must declare
// near their top that their path citations are append-only history.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const packIndex = argv.indexOf('--pack')
const packMode = packIndex >= 0
const packDir = packMode ? path.resolve(argv[packIndex + 1] ?? '') : null
if (packMode && (packDir === null || !fs.existsSync(packDir))) {
  console.log('INVALID: --pack needs an existing directory')
  process.exit(3)
}

const ROOT = packMode ? packDir : repo
// Default scope: the documents whose links a user is expected to follow.
// `docs/archive/**` is deliberately out of scope — those banners describe what
// superseded them and are historical, so dead links there are a separate debt.
const DOCS = packMode
  ? ['README.md', 'README.zh.md', 'TESTING.md', 'docs/README.md', 'docs/driving.md', 'docs/driving.zh.md']
  : ['README.md', 'README.zh.md', 'TESTING.md', 'docs/README.md', 'docs/driving.md', 'docs/driving.zh.md']

const MARK_REPO_ONLY = /repository-only|仓库内|not published|不随包发布/i
const MARK_DEV_ONLY = /dev-only|开发树|不随包发布/i
// A retired reference is a record, not an instruction: "Retired …: `scripts/x.mjs` used to be …".
// The marker may sit on the same line or up to three lines above it (a paragraph).
const MARK_RETIRED = /retired|已退役|已移除|was removed/i
// A reading that lives on the maintainer's machine must say so; everything else that
// names a real local absolute path is a leak into the published text.
const MARK_MAINTAINER_LOCAL = /maintainer-local|维护者本机/i

// Pack mode: these trees live in the repository and are NOT published. A document
// may reference them, but only after declaring that once in a banner near its top
// (the READMEs and TESTING.md do). Anything outside this list still has to exist
// in the artifact — that is what keeps a shipped link from dying silently.
const REPO_ONLY_PREFIXES = ['src/', 'tests/', 'scripts/', 'ci/', 'docs/', '.test-runs/']
const BANNER_LINES = 12
const declaredRepoOnly = (file) => {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) return false
  const head = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, BANNER_LINES).join(' ')
  return MARK_REPO_ONLY.test(head)
}

// Both CHANGELOGs ship and are append-only: they cite repository-only and
// maintainer-local paths on purpose, as records. That stays legitimate only while the
// file says so near the top, so the banner itself is gated rather than the entries.
const HISTORY_DOCS = ['CHANGELOG.md', 'CHANGELOG.zh.md']
const MARK_HISTORY = /append-only history|只追加的历史/i

const repoRelOf = (rel, fromFile) => {
  const clean = rel.split('#')[0].split('?')[0]
  const base = fromFile === undefined || path.isAbsolute(clean) || /^[A-Za-z]:[\\/]/.test(clean)
    ? ROOT
    : path.dirname(path.join(ROOT, fromFile))
  return path.relative(ROOT, path.resolve(base, clean)).split(path.sep).join('/')
}

const targetExists = (rel, fromFile) => {
  const repoRel = repoRelOf(rel, fromFile)
  if (repoRel.startsWith('..') || path.isAbsolute(repoRel)) return false
  return fs.existsSync(path.join(ROOT, repoRel))
}

const collect = (file) => {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) return []
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/).map((text, index) => ({ file, line: index + 1, text }))
}

// markdown link targets plus backticked repo paths ("lib/x.js:12" style line refs included)
const linkRe = /\]\(([^)\s]+)\)/g
const pathRe = /(?<![\w./-])((?:lib|docs|scripts|tests|ci|src|\.test-runs)\/[A-Za-z0-9_./-]+)(?::(\d+))?/g

const problems = []
let checked = 0
let declared = 0
for (const file of HISTORY_DOCS) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) continue
  const head = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, BANNER_LINES).join(' ')
  checked += 1
  if (!MARK_HISTORY.test(head)) {
    problems.push({ file, line: 1, target: file, why: 'shipped changelog must declare near its top that its path citations are append-only history' })
  }
}
for (const file of DOCS) {
  const rows = collect(file)
  const texts = rows.map((r) => r.text)
  for (const row of rows) {
    // Markers may sit on the same line, a few lines above (a paragraph) or just below
    // (an annotation under a quote) — all three are how people actually write them.
    const context = texts.slice(Math.max(0, row.line - 4), Math.min(texts.length, row.line + 3)).join(' ')
    const seen = new Set()
    for (const [re, fromFile] of [[linkRe, row.file], [pathRe, undefined]]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(row.text)) !== null) {
        const raw = m[1]
        if (/^(?:https?:|mailto:|#)/i.test(raw)) continue
        const target = raw.replace(/^<|>$/g, '')
        if (seen.has(target)) continue
        seen.add(target)
        checked += 1
        const repoRel = repoRelOf(target, fromFile)
        const isDev = repoRel.startsWith('.test-runs/')
        const ok = targetExists(target, fromFile)
        if (ok) continue
        if (isDev && MARK_DEV_ONLY.test(context)) continue
        if (MARK_RETIRED.test(context)) continue
        if (MARK_REPO_ONLY.test(context)) continue
        if (packMode && REPO_ONLY_PREFIXES.some((p) => repoRel.startsWith(p)) && declaredRepoOnly(file)) {
          declared += 1
          continue
        }
        problems.push({ file, line: row.line, target, why: isDev ? 'dev-only path without a marker' : 'path not present' })
      }
    }
    // "lib/x.js:1234" line reference must fit inside the file
    for (const m of row.text.matchAll(/\b((?:lib|src)\/[A-Za-z0-9_./-]+):(\d+)\b/g)) {
      const target = path.join(ROOT, m[1])
      if (!fs.existsSync(target)) continue
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).length
      if (Number(m[2]) > lines) problems.push({ file, line: row.line, target: `${m[1]}:${m[2]}`, why: `line ${m[2]} > ${lines}` })
    }
    // Bare file names (`PITFALLS.md`, `CHECK-CATALOG.md`): they must be published, or the
    // document must declare that repository-only references exist (a banner near the top).
    for (const m of row.text.matchAll(/(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9_-]*\.md)(?![\w/])/g)) {
      const name = m[1]
      if (seen.has(name)) continue
      seen.add(name)
      checked += 1
      if (fs.existsSync(path.join(ROOT, name))) continue
      if (declaredRepoOnly(file) || MARK_RETIRED.test(context)) { declared += 1; continue }
      problems.push({ file, line: row.line, target: name, why: 'file is not published and the document has no repository-only banner' })
    }
    // Absolute local paths (`D:\…`, `C:/…`): placeholders (`<install>`, `D:\path\to\…`,
    // an elided `…`) are fine; a concrete local path is either a maintainer reading or a
    // leak of the maintainer's disk layout into the shipped text — both need a mark.
    for (const m of row.text.matchAll(/\b([A-Za-z]:[\\/][^\s`'"()\[\]]+)/g)) {
      const raw = m[1].replace(/[.,;:]+$/, '')
      if (/<[^>]*>|…|\.\.\.|(?:^|[\\/])path[\\/](?:to|from)(?:[\\/]|$)/i.test(raw)) continue
      checked += 1
      if (MARK_MAINTAINER_LOCAL.test(context)) continue
      problems.push({ file, line: row.line, target: raw, why: 'concrete absolute local path (use a placeholder such as <install> or D:\\path\\to\\…, or mark it maintainer-local)' })
    }
  }
}

console.log(`scope: ${packMode ? `pack ${packDir}` : `repo ${repo}`} | documents: ${DOCS.length} | targets: ${checked} | declared repo-only: ${declared}`)
if (problems.length === 0) {
  console.log('DOC PATHS OK — every named repository path exists')
  process.exit(0)
}
for (const p of problems) console.log(`FAIL ${p.file}:${p.line} → ${p.target} (${p.why})`)
console.log(`${problems.length} dead path(s)`)
process.exit(1)
