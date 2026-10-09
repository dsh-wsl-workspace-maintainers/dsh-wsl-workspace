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
// §0 names the states this column may hold, SKIPPED included (工具不存在时记 SKIPPED 且不算 MATCH).
const STANDING = /待跑|未定|SKIPPED|已入|已跑|实测|已定案|规程|必跑|已知敏感|三形之一/

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
  const counts = { pending: 0, undecided: 0 }
  const listed = []
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
      if (standing.includes("待跑")) counts.pending++
      if (standing.includes("未定")) counts.undecided++
      ids.set(id, standing)
      listed.push({ group, id, command, standing })
      if (command !== "") commands.set(command, id)
    } else if (section === "3") {
      if (cells[0] === "行") continue
      if (cells.length !== 3) { bad.push("section 3: a row with " + cells.length + " columns, not 3: " + line.slice(0, 70)); continue }
      const [row, verdict, proof] = cells
      if (!/MATCH|PARITY-NOT-DEFECT|DEFECT|未定/.test(verdict)) bad.push("section 3: " + row + " carries no verdict word")
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
  return { bad, rows: ids.size, counts, listed }
}
/**
 * Split a group's rows into what a release run can paste and what it must handle by hand. A cell that
 * opens with one backticked span is a command, and anything after it is the author's note
 * (`（若 PATH 里有）`); a cell that opens with prose is a procedure — 6.9's open→send→read, 8.1's two
 * calls, 11.4's re-run on WSL1 — and must never go out as a command line.
 */
function emitCommands(rows) {
  const pasteable = []
  const hand = []
  for (const row of rows) {
    const unescaped = row.command.replace(/\\\|/g, '|')
    const span = /^`([^`]+)`(.*)$/.exec(unescaped)
    if (span === null) hand.push(`${row.id}: ${unescaped}`)
    else pasteable.push(span[1] + (span[2].trim() === '' ? '' : `   # ${row.id} ${span[2].trim()}`))
  }
  return { pasteable, hand }
}

/**
 * Each mutation must turn the audit red *with the message named in `expect`*: a broken copy that
 * reddens for an unrelated reason proves nothing about the rule it was built to test. Mutation 2 is
 * deliberately not anchored to a row id, because rows leave 待跑 as they get sunk — the first version
 * of it quietly stopped applying when row 1.5 did, and only the "did not apply" line caught that.
 */
const MUTATIONS = [
  { name: 'an unescaped pipe inside a command', expect: 'columns, not 5',
    apply: t => t.replace(/\\\|/, '|') },
  { name: 'a row whose standing column was emptied', expect: 'an empty cell',
    apply: t => {
      const lines = t.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (/^\| \d+\.\d+ \|/.test(lines[i])) {
          lines[i] = lines[i].replace(/\|[^|]+\|\s*$/, '|  |')
          return lines.join('\n')
        }
      }
      return t
    } },
  { name: 'a verdict naming a row that is not in the matrix', expect: 'not in the matrix',
    apply: t => t.replace('| 4.5 `du -sh /mnt/c/Users` |', '| 99.9 `du -sh /mnt/c/Users` |') },
  { name: 'a DEFECT with no ledger line', expect: 'no ledger line',
    apply: t => t.replace('MATCH（经 #68 修复） | 原生终端会关掉', 'DEFECT | 本轮不修，只在本文记着') },
]

const docPath = join(ROOT, DOC)
let text
try {
  text = readFileSync(docPath, "utf8")
} catch {
  console.error(`release-matrix: cannot read ${docPath}`)
  process.exit(1)
}
const { bad, rows, counts, listed } = audit(text)
// `--commands G1,G2` prints those groups' commands, one per line, in document order: the round a
// release run pastes is generated from the rows being judged, never typed out next to them.
const at = argv.indexOf('--commands')
if (at !== -1) {
  const wanted = (argv[at + 1] ?? '').split(',').filter(group => group !== '')
  const picked = listed.filter(row => wanted.includes(row.group))
  const { pasteable, hand } = emitCommands(picked)
  for (const line of pasteable) console.log(line)
  for (const line of hand) console.log(`# 手工行 ${line}`)
  console.error(`release-matrix: ${pasteable.length} pasteable commands and ${hand.length} 手工行 `
    + `from ${wanted.join(',')} of ${listed.length} rows`)
  console.error(`release-matrix: ${picked.length - hand.length} pasteable commands and ${hand.length} 手工行 `
    + `from ${wanted.join(',')} of ${listed.length} rows`)
  process.exit(picked.length > 0 ? 0 : 1)
}
if (argv.includes("--self-test")) {
  // The classifier needs to be seen working both ways, because the audit deliberately does not reject
  // a command cell that carries prose: a command with the author's note beside it stays pasteable and
  // the note travels as a comment, while a cell that is only prose is a procedure and must not go out
  // as a command line. (My first version of this control asserted the *wrong* semantics for the
  // annotated row — the emitted line was right and the expectation was not.)
  const classified = emitCommands([
    { id: 'x.1', command: '`exit 0`' },
    { id: 'x.2', command: '`exit 0` 单独一行' },
    { id: 'x.3', command: '两个会话并发各自 `cd`' },
    { id: 'x.4', command: '`git ls-files -z \\| head -c 40`' },
  ])
  const classifiedOk = classified.pasteable.length === 3 && classified.hand.length === 1
    && classified.pasteable[0] === 'exit 0'
    && classified.pasteable[1] === 'exit 0   # x.2 单独一行'
    && classified.pasteable[2] === 'git ls-files -z | head -c 40'
    && classified.hand[0].startsWith('x.3')
  if (classifiedOk) console.log('self-test: classifier sorts the four cell shapes the document uses')
  else console.error(`self-test: CLASSIFIER WRONG — ${JSON.stringify(classified)}`)
  let reddened = 0
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(text)
    if (mutated === text) {
      console.error(`self-test: the mutation did not apply, so it proves nothing: ${mutation.name}`)
      continue
    }
    const probe = audit(mutated)
    // Red is not enough: a mutation that breaks some *other* rule would prove nothing about this one.
    const named = probe.bad.some(line => line.includes(mutation.expect))
    if (probe.bad.length === 0) console.error(`self-test: STILL GREEN — ${mutation.name}`)
    else if (!named) console.error(`self-test: RED FOR THE WRONG REASON — ${mutation.name}: wanted the message ${JSON.stringify(mutation.expect)}, got ${probe.bad[0]}`)
    else if (named) {
      reddened++
      console.log(`self-test: reddened by ${mutation.name}: ${probe.bad[0]}`)
    }
  }
  if (bad.length > 0) for (const failure of bad) console.error(`  the unmutated document is not clean either: ${failure}`)
  const ok = reddened === MUTATIONS.length && bad.length === 0 && classifiedOk
  console.log(`release-matrix self-test: ${reddened}/${MUTATIONS.length} mutations reddened (${DOC})`)
  process.exit(ok ? 0 : 1)
}
if (bad.length > 0) {
  for (const failure of bad) console.error(`  release-matrix: ${failure}`)
  console.error(`release-matrix: ${bad.length} structural failure(s) in ${DOC}`)
  process.exit(1)
}
console.log(`release-matrix: OK — ${rows} rows over ${GROUPS.length} groups, ` +
  `${counts.pending} 待跑 and ${counts.undecided} 未定 still stand between this document and a release (${DOC})`)
