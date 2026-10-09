// The release behaviour matrix gates a version, so its shape carries the gate: a row that lost a
// column, a command whose pipe was left unescaped, a verdict naming a row that is not in the matrix,
// or a DEFECT with no ledger behind it all read fine to a person and mean nothing to the next run.
//
//   node scripts/check-release-matrix.mjs [--root <dir>] [--self-test]
//
// --self-test re-runs the audit over four mutated copies of the real document and requires each to
// redden: the control that separates a gate seen failing from a checker drawn next to prose.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const rootAt = argv.indexOf('--root')
const ROOT = rootAt === -1 ? resolve(import.meta.dirname, '..') : resolve(argv[rootAt + 1] ?? '.')
const DOC = 'docs/release-behaviour-matrix.zh.md'
const SECTIONS = ['0', '1', '2', '3', '4', '5', '6']
const GROUPS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12']
const STANDING = /待跑|已入|已跑|实测|已定案|规程|必跑|已知敏感|三形之一/

/** Split a table row into cells; an escaped `\|` stays text and is not a column boundary. */
function cellsOf(line) {
  const guarded = line.split('\\|').join('\u0001')
  return guarded.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
    .map(cell => cell.replace(/\u0001/g, '\\|').trim())
}
/** One pass over the document text; returns every structural failure it can see. */
function audit(text) {
  const bad = []
  for (const section of SECTIONS) {
    if (!text.includes("## " + section + ". ")) bad.push("lost section ## " + section + ".")
  }
  for (const group of GROUPS) if (!text.includes("### " + group + " ")) bad.push("lost group " + group)
  if (!/MATCH/.test(text) || !/PARITY-NOT-DEFECT/.test(text) || !/DEFECT/.test(text)) {
    bad.push("the three verdicts of section 0 are not all named")
  }
  const ids = new Map()
  const commands = new Map()
  let section = ""
  let group = ""
  for (const line of text.split("\n")) {
    const head = /^## (\d+)\./.exec(line)
    if (head !== null) { section = head[1]; group = ""; continue }
    const groupHead = /^### (G\d+)\b/.exec(line)
    if (groupHead !== null) { group = groupHead[1]; continue }
    if (!line.trimStart().startsWith("|")) continue
    const cells = cellsOf(line)
    if (/^:?-{2,}$/.test(cells[0] ?? "")) continue
    if (section === "2") {
      if (cells[0] === "#") continue
      if (cells.length !== 5) { bad.push(group + ": a row with " + cells.length + " columns, not 5: " + line.slice(0, 70)); continue }
      const [id, command, , mustSee, standing] = cells
      const number = group.slice(1)
      if (!id.startsWith(number + ".")) bad.push("row " + id + " does not sit under " + group)
      if (command === "" || mustSee === "" || standing === "") bad.push(id + ": an empty cell")
      if (ids.has(id)) bad.push("duplicate row id " + id)
      if (command !== "" && commands.has(command)) bad.push("the command of " + id + " is also row " + commands.get(command))
      if (!STANDING.test(standing)) bad.push(id + ": standing outside the vocabulary: " + standing)
      ids.set(id, standing)
      if (command !== "") commands.set(command, id)
    } else if (section === "3") {
      if (cells[0] === "行") continue
      if (cells.length !== 3) { bad.push("section 3: a row with " + cells.length + " columns, not 3: " + line.slice(0, 70)); continue }
      const [row, verdict, proof] = cells
      if (!/MATCH|PARITY-NOT-DEFECT|DEFECT/.test(verdict)) bad.push("section 3: " + row + " carries no verdict word")
      const named = [...row.matchAll(/\d+\.\d+/g)]
      if (named.length === 0) bad.push("section 3: a verdict that names no matrix id: " + row)
      for (const one of named) if (!ids.has(one[0])) bad.push("section 3: adjudicates " + one[0] + ", which is not in the matrix")
      if (proof === "") bad.push("section 3: " + row + " has no reading behind it")
      // Section 6.3: a DEFECT the release does not fix has to live in a ledger, not only in this file.
      if (/DEFECT/.test(verdict) && !/PARITY-NOT-DEFECT/.test(verdict)
        && !/tests\/|台账|账本|census|ledger/.test(proof)) {
        bad.push("section 3: " + row + " is a DEFECT with no ledger line behind it")
      }
    }
  }
  return { bad, rows: ids.size }
}
/** Each of these must turn the audit red: a gate nobody has seen fail is a sentence about a gate. */
const MUTATIONS = [
  { name: "an unescaped pipe inside a command",
    apply: t => t.replace(/\\\|/, "|") },
  { name: "a row whose standing column was emptied",
    apply: t => t.replace("之类我们加的字 | 待跑 |", "之类我们加的字 |  |") },
  { name: "a verdict naming a row that is not in the matrix",
    apply: t => t.replace("| 4.5 `du -sh /mnt/c/Users` |", "| 99.9 `du -sh /mnt/c/Users` |") },
  { name: "a DEFECT with no ledger line",
    apply: t => t.replace("MATCH（经 #68 修复） | 原生终端会关掉", "DEFECT | 本轮不修，只在本文记着") },
]

const docPath = join(ROOT, DOC)
let text
try {
  text = readFileSync(docPath, "utf8")
} catch {
  console.error(`release-matrix: cannot read ${docPath}`)
  process.exit(1)
}
const { bad, rows } = audit(text)
if (argv.includes("--self-test")) {
  let reddened = 0
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(text)
    if (mutated === text) {
      console.error(`self-test: the mutation did not apply, so it proves nothing: ${mutation.name}`)
      continue
    }
    const probe = audit(mutated)
    if (probe.bad.length === 0) console.error(`self-test: STILL GREEN — ${mutation.name}`)
    else {
      reddened++
      console.log(`self-test: reddened by ${mutation.name}: ${probe.bad[0]}`)
    }
  }
  if (bad.length > 0) for (const failure of bad) console.error(`  the unmutated document is not clean either: ${failure}`)
  const ok = reddened === MUTATIONS.length && bad.length === 0
  console.log(`release-matrix self-test: ${reddened}/${MUTATIONS.length} mutations reddened (${DOC})`)
  process.exit(ok ? 0 : 1)
}
if (bad.length > 0) {
  for (const failure of bad) console.error(`  release-matrix: ${failure}`)
  console.error(`release-matrix: ${bad.length} structural failure(s) in ${DOC}`)
  process.exit(1)
}
console.log(`release-matrix: OK — ${rows} rows over ${GROUPS.length} groups (${DOC})`)
