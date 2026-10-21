// The size red line: apparatus may not outgrow the product it defends.
//
//   npm run test:apparatus-size            # gate: red above the ratio in ci/apparatus-size.json
//   npm run test:apparatus-size -- --record  # re-baseline after a reviewed change
//
// Why a number and not a rule in prose. The repository's test weight grew faster than anyone could
// keep a map of it, and the response to "this is too big to hold in your head" was always another
// gate. A ceiling turns that into a trade: a new gate is paid for by retiring existing weight, and
// the trade is measured in the same units every time — lines under `tests/` and `scripts/` per line
// under `src/`.
//
// What it deliberately does not do: it does not judge any individual file, and it is not a coverage
// claim. The reading that says whether the apparatus works is `npm run test:replay`; this one only
// says whether it is affordable to keep adding to it.
//
// @module scripts/check-apparatus-size
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const record = process.argv.includes('--record')
const budgetPath = join(repoRoot, 'ci', 'apparatus-size.json')
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.ps1', '.sh']

/**
 * Lines of code under a directory, skipping installed trees and generated bundles.
 *
 * `ci/deps` and `ci/deps-conflict` are the host's own packages, not this repository's apparatus, and
 * `lib/` is generated from `src/` — counting either would let a dependency refresh move the number.
 */
function countLines(dir, skip = []) {
  let lines = 0
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || skip.includes(full)) continue
        walk(full)
        continue
      }
      if (!SOURCE_EXTENSIONS.includes(entry.name.replace(/^.*\./, '.'))) continue
      lines += readFileSync(full, 'utf8').split('\n').length
    }
  }
  if (existsSync(dir)) walk(dir)
  return lines
}

const src = countLines(join(repoRoot, 'src'))
const apparatus = countLines(join(repoRoot, 'tests')) + countLines(join(repoRoot, 'scripts'))
const ratio = Number((apparatus / src).toFixed(2))
const heaviest = [join(repoRoot, 'tests'), join(repoRoot, 'scripts')]
  .flatMap(root => {
    const out = []
    const walk = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full)
          continue
        }
        if (!SOURCE_EXTENSIONS.includes(entry.name.replace(/^.*\./, '.'))) continue
        out.push({ file: relative(repoRoot, full).replaceAll('\\', '/'), lines: readFileSync(full, 'utf8').split('\n').length })
      }
    }
    walk(root)
    return out
  })
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 10)

if (record) {
  const budget = {
    note: 'the size red line, written by `npm run test:apparatus-size -- --record`. Apparatus (`tests/` + `scripts/`) may not exceed `limitRatio` times `src/`; a new gate is paid for by retiring existing weight.',
    recorded: new Date().toISOString().slice(0, 10),
    srcLines: src,
    apparatusLines: apparatus,
    ratio,
    limitRatio: Math.max(2, ratio),
    heaviest,
  }
  writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8')
  console.log(`apparatus-size: recorded ${apparatus} apparatus lines over ${src} src lines = ${ratio}x, limit ${budget.limitRatio}x`)
  process.exit(0)
}

if (!existsSync(budgetPath)) {
  console.error('apparatus-size: no recorded budget — run `npm run test:apparatus-size -- --record`')
  process.exit(2)
}
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
console.log(`apparatus-size: ${apparatus} apparatus lines / ${src} src lines = ${ratio}x (limit ${budget.limitRatio}x, recorded ${budget.ratio}x on ${budget.recorded})`)
for (const entry of heaviest) console.log(`  ${String(entry.lines).padStart(6)}  ${entry.file}`)
if (ratio > budget.limitRatio) {
  console.error(`apparatus-size: the apparatus is over its ceiling. A new gate has to be paid for: retire an equal weight, or re-record with a reviewed justification in the PR that changes the limit.`)
  process.exit(1)
}
if (ratio < budget.ratio - 0.05) {
  console.log(`apparatus-size: note — the apparatus shrank by ${(budget.ratio - ratio).toFixed(2)}x since the recording; consider lowering the limit instead of spending the headroom.`)
}
