// Join hard-wrapped prose back into logical lines.
//
//   node scripts/unwrap-prose.mjs --check CHANGELOG.md README.zh.md
//   node scripts/unwrap-prose.mjs --write CHANGELOG.md …
//   node scripts/unwrap-prose.mjs --stdout CHANGELOG.zh.md --section 0.7.9
//   node scripts/unwrap-prose.mjs --check --tree        every prose file this repository ships
//
// Why. Every paragraph in this repository's prose files was written wrapped at ~100 columns. In a
// README that is invisible (GitHub joins soft line breaks inside a paragraph), but in the places GitHub
// renders with `breaks: true` — issue bodies, **release notes**, comments — each source line becomes a
// hard break, so a paragraph arrives as a ragged column of fragments. The release note for 0.7.8 and
// 0.7.9 looked like that (measured 2026-10-21), and the same wrapped text is what a reader sees in a
// diff, a terminal, or any renderer that honours the file's own line breaks.
//
// The joining rule is deliberately conservative: a paragraph is a run of lines that are not blank and
// do not open a block, and lines are joined with a space. Two CJK characters are joined with nothing,
// because a space there is a typographic error rather than a separator. Anything the tool is not sure
// about — fenced or indented code, tables, headings, HTML, list markers, explicit hard breaks, link
// definitions — ends the run and is copied through untouched.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join as pathJoin, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Codepoints that are CJK (or fullwidth) on either side of a join, where a space would be wrong. */
const isWide = (character) => {
  if (character === undefined) return false
  const code = character.codePointAt(0)
  return (code >= 0x2e80 && code <= 0x9fff) // radicals, kana, CJK unified ideographs
    || (code >= 0xac00 && code <= 0xd7af) // hangul
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    || (code >= 0xff00 && code <= 0xff60) // fullwidth forms
    || (code >= 0x3000 && code <= 0x303f) // CJK punctuation
}

/** Punctuation that must not be preceded by a space after a join (CJK closing marks). */
const NO_LEADING_SPACE = new Set([...'，。、；：？！）】》」』”’…'])
/** Openers that must not be followed by a space. */
const NO_TRAILING_SPACE = /[（【《「『“‘]$/
/** CJK openers: no space *before* them after CJK text or a code span — `… ）` is not how this reads. */
const OPENERS = new Set([...'（【《「『“‘'])

/** Does this line end a paragraph the author meant to end (so the break is semantic, not layout)? */
const endsHard = (line) => / {2,}$/.test(line) || line.endsWith('\\')

/** Does this line open a block, so the next line is not a continuation of a paragraph? */
const opensBlock = (line) => {
  const trimmed = line.trimStart()
  return trimmed === ''
    || /^#{1,6} /.test(trimmed)
    || /^```|^~~~/.test(trimmed)
    || /^\|/.test(trimmed)
    || /^>/.test(trimmed)
    || /^[-*+] /.test(trimmed) || /^[-*+]$/.test(trimmed)
    || /^\d+[.)] /.test(trimmed)
    || /^<(?:!--|\/?[a-zA-Z])/.test(trimmed)
    || /^\[[^\]]+\]:/.test(trimmed) // link reference definition
    || /^!\[/.test(trimmed)
    || /^ {4,}\S/.test(line) // indented code
}

/** Join `next` onto `line`, with a space unless both sides are CJK. */
const joinLine = (line, next) => {
  const left = line.replace(/[ \t]+$/, '')
  const right = next.replace(/^[ \t]+/, '')
  if (left === '') return right
  const last = [...left].at(-1)
  const first = [...right][0]
  // Both sides CJK: a space would be a typographic error (`中文` + `继续`).
  if (isWide(last) && isWide(first)) return left + right
  // CJK punctuation never takes a leading space, and an opening bracket never a trailing one.
  if (NO_LEADING_SPACE.has(first) || NO_TRAILING_SPACE.test(last ?? '')) return left + right
  // Chinese prose runs straight into its own punctuation: `…，` + `[#83]` and ``…` `` + `（` both take no space.
  if (NO_LEADING_SPACE.has(last) || (OPENERS.has(first) && (isWide(last) || last === '`'))) return left + right
  // Everything else — including CJK followed by a code span or a Latin word — keeps a space: `没有 ` +
  // `` `lib/…` `` reads as this repository writes it, and the first attempt at this rule silently glued
  // them together in the 0.7.8 release notes.
  return `${left} ${right}`
}

/**
 * Join the soft-wrapped lines of one markdown source.
 * @param text - the file's contents.
 * @returns the contents with paragraphs on one line each.
 */
export function unwrapProse(text) {
  const source = text.split('\n')
  const out = []
  /** Lines of the paragraph being accumulated, or null outside one. */
  let run = null
  let inFence = false
  let fenceMarker = ''
  let inFrontMatter = false

  const flush = () => {
    if (run !== null && run.length > 0) out.push(run.reduce((line, next) => joinLine(line, next)))
    run = null
  }

  for (const [index, line] of source.entries()) {
    // YAML front matter: only at the very top.
    if (index === 0 && line.trim() === '---') {
      inFrontMatter = true
      out.push(line)
      continue
    }
    if (inFrontMatter) {
      out.push(line)
      if (line.trim() === '---') inFrontMatter = false
      continue
    }
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (inFence) {
      out.push(line)
      if (fence !== null && fence[1].startsWith(fenceMarker.slice(0, 3))) { inFence = false; fenceMarker = '' }
      continue
    }
    if (fence !== null) {
      flush()
      inFence = true
      fenceMarker = fence[1]
      out.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      out.push(line)
      continue
    }
    if (opensBlock(line)) {
      flush()
      // A list item may be followed by indented continuation lines; it still starts a run, so those join
      // into the item instead of becoming their own paragraph.
      const isMarker = /^\s*(?:[-*+]|\d+[.)]) /.test(line)
      if (isMarker && !/^\s{4,}/.test(line)) {
        run = [line]
      } else {
        out.push(line)
      }
      continue
    }
    if (run === null) {
      run = [line]
      continue
    }
    const previous = run.at(-1)
    if (endsHard(previous)) {
      flush()
      run = [line]
      continue
    }
    run.push(line)
  }
  flush()
  return out.join('\n')
}

/** The one CHANGELOG section whose notes a release publishes, unwrapped and with the heading dropped. */
export function sectionOf(text, version) {
  const start = text.search(new RegExp(`^## ${version.replaceAll('.', '\\.')} — `, 'm'))
  if (start === -1) return ''
  const rest = text.slice(start)
  const next = rest.slice(1).search(/^## /m)
  const section = next === -1 ? rest : rest.slice(0, next + 1)
  return unwrapProse(section).replace(/^## [^\n]*\n+/, '').replace(/\n+$/, '')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { argv } = process
  const mode = argv.includes('--check') ? 'check' : argv.includes('--write') ? 'write' : argv.includes('--stdout') ? 'stdout' : ''
  const sectionFlag = argv.indexOf('--section')
  const section = sectionFlag === -1 ? undefined : argv[sectionFlag + 1]
  // `--tree` is the whole shipped prose set: the root markdown files and `docs/`. It exists so the gate
  // does not depend on a shell expanding `README*.md` — a glob that does not expand is a file named
  // `README*.md`, and the check would then pass while reading nothing.
  const tree = argv.includes('--tree')
  const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const treeFiles = tree
    ? [
        ...readdirSync(root).filter((name) => name.endsWith('.md')).map((name) => pathJoin(root, name)),
        ...readdirSync(pathJoin(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => pathJoin(root, 'docs', name)),
      ].sort()
    : []
  const files = tree ? treeFiles : argv.slice(2).filter((arg) => !arg.startsWith('--') && arg !== section)
  if (mode === '' || files.length === 0) {
    console.error('usage: node scripts/unwrap-prose.mjs (--check|--write) <file…> | --stdout <file> [--section <version>]')
    process.exit(2)
  }
  let changed = 0
  for (const file of files) {
    const before = readFileSync(file, 'utf8')
    const after = mode === 'stdout' && section !== undefined
      ? sectionOf(before, section)
      : unwrapProse(before)
    if (mode === 'stdout') {
      process.stdout.write(after.endsWith('\n') ? after : `${after}\n`)
      continue
    }
    if (mode === 'write') {
      if (after !== before) { writeFileSync(file, after, 'utf8'); changed += 1 }
      continue
    }
    if (after !== before) {
      changed += 1
      const beforeLines = before.split('\n').length
      const afterLines = after.split('\n').length
      console.log(`would change ${file}: ${beforeLines} → ${afterLines} lines`)
    }
  }
  if (mode === 'check') {
    console.log(changed === 0 ? 'unwrap-prose: every file is already unwrapped' : `unwrap-prose: ${changed} file(s) still wrapped`)
    process.exit(changed === 0 ? 0 : 1)
  }
}
