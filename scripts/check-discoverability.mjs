#!/usr/bin/env node
// Cold-start discoverability gate (proxy).
//
// The question this answers, in the coordinator's words: "a fresh agent on a new
// machine, with only what the package publishes — can it start a harness, log in,
// call the plugin, drive the composer, and repoint the provider?"
//
// This script is a PROXY: it builds the packed artifact (package.json#files),
// searches it for the facts each question needs, and fails when a fact is not
// there. The verdict that counts is a cold-start agent reading only that artifact;
// this gate exists so the same regression turns red in CI instead of only in a
// review.
//
//   node scripts/check-discoverability.mjs [--keep]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))

const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-ws-pack-'))
const copy = (rel) => {
  const src = path.join(repo, rel)
  const dst = path.join(packDir, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (fs.statSync(src).isDirectory()) {
    for (const child of fs.readdirSync(src)) copy(path.join(rel, child))
  } else {
    fs.copyFileSync(src, dst)
  }
}
for (const entry of pkg.files ?? []) copy(entry)

const textFiles = []
const walk = (rel) => {
  const abs = path.join(packDir, rel)
  if (fs.statSync(abs).isDirectory()) {
    for (const child of fs.readdirSync(abs)) walk(path.join(rel, child))
    return
  }
  if (/\.(?:md|js|json|yml)$/i.test(rel)) textFiles.push(rel)
}
for (const entry of pkg.files ?? []) walk(entry)

const where = (re) => {
  for (const rel of textFiles) {
    const lines = fs.readFileSync(path.join(packDir, rel), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) return `${rel}:${i + 1}`
  }
  return null
}

const QUESTIONS = [
  {
    id: 'Q1 start a harness headlessly',
    needs: [
      ['unset-variable warning', /ELECTRON_RUN_AS_NODE/],
      ['explicit entry + args', /--expose-internals/],
      ['scratch home', /DSH_HOME/],
      ['web profile args', /web\s+--no-open/],
      ['how to unset it', /Remove-Item Env:ELECTRON_RUN_AS_NODE|unset ELECTRON_RUN_AS_NODE/i],
      ['working directory', /working directory|cwd|任意目录|从哪启动/i],
    ],
  },
  {
    id: 'Q2 login URL / one-time token',
    needs: [
      ['stdout line', /dsh web: http/],
      ['token parameter', /token=/],
      ['cookie exchange', /set-cookie|cookie/i],
      ['replay behaviour (measured)', /not consumed|不会用掉|303/],
    ],
  },
  {
    id: 'Q3 plugin HTTP surface',
    needs: [
      ['route path', /\/wsl-workspace\/api/],
      ['method table discoverable', /methods/],
      ['request envelope', /"method"/],
      ['loopback-only auth', /loopback/i],
      ['describe returns the table', /describe/],
      ['install proof marker', /wsl-workspace:methods-v1/],
    ],
  },
  {
    id: 'Q4 composer injection',
    needs: [
      ['editor element', /data-lexical-editor/],
      ['event to dispatch', /beforeinput/],
      ['what not to do', /execCommand/],
      ['send action', /发送消息|send/i],
    ],
  },
  {
    id: 'Q5 switch provider',
    needs: [
      ['patch file', /cordis\.patch\.yml/],
      ['provider entry', /agent-default-model/],
      ['key stays off disk', /apiKeyEnv/],
    ],
  },
]

const rows = []
let missing = 0
for (const q of QUESTIONS) {
  const found = q.needs.map(([label, re]) => ({ label, at: where(re) }))
  const gaps = found.filter((f) => f.at === null)
  if (gaps.length > 0) missing += 1
  rows.push({ id: q.id, verdict: gaps.length === 0 ? 'DOCUMENTED' : 'MISSING', found, gaps })
}

// Method table vs dispatcher: the table must not advertise a method the switch
// does not serve, and the switch must not grow a method the table omits.
const libText = fs.readFileSync(path.join(packDir, 'lib', 'index.js'), 'utf8')
const tableStart = libText.indexOf('const METHOD_TABLE')
const tableEnd = tableStart < 0 ? -1 : libText.indexOf('\n]', tableStart)
const tableNames = tableStart < 0 || tableEnd < 0 ? [] : [...libText.slice(tableStart, tableEnd).matchAll(/name:\s*["']([A-Za-z]+)["']/g)].map((m) => m[1])
const dispatchStart = libText.indexOf('switch (method)')
let depth = 0
let dispatchEnd = -1
for (let i = dispatchStart; i >= 0 && i < libText.length; i += 1) {
  if (libText[i] === '{') depth += 1
  else if (libText[i] === '}') {
    depth -= 1
    if (depth === 0) { dispatchEnd = i; break }
  }
}
const caseNames = dispatchEnd < 0 ? [] : [...libText.slice(dispatchStart, dispatchEnd).matchAll(/case\s*["']([A-Za-z]+)["']\s*:/g)].map((m) => m[1])
const onlyInTable = tableNames.filter((n) => !caseNames.includes(n))
const onlyInSwitch = caseNames.filter((n) => !tableNames.includes(n))
const tableOk = tableNames.length > 0 && onlyInTable.length === 0 && onlyInSwitch.length === 0
if (!tableOk) missing += 1

console.log(`packed artifact: ${packDir} (${textFiles.length} text files)`)
for (const r of rows) {
  console.log(`\n${r.verdict.padEnd(12)} ${r.id}`)
  for (const f of r.found) console.log(`   ${f.at === null ? 'MISSING  ' : 'evidence '}${f.label.padEnd(28)} ${f.at ?? ''}`)
}
console.log(`\n${tableOk ? 'TABLE OK    ' : 'TABLE DRIFT'} methods=${tableNames.length} cases=${caseNames.length}${onlyInTable.length ? ` only-in-table=${onlyInTable.join(',')}` : ''}${onlyInSwitch.length ? ` only-in-switch=${onlyInSwitch.join(',')}` : ''}`)
console.log('\nnote: this is a PROXY gate over the packed artifact; the verdict that counts is a cold-start agent run with only this artifact.')

if (!keep) fs.rmSync(packDir, { recursive: true, force: true })
else console.log(`kept: ${packDir}`)
process.exit(missing === 0 ? 0 : 1)
