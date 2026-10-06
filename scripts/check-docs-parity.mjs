#!/usr/bin/env node
// Documentation parity gate.
//
// One place declares what every README must contain. The rule set exists because the
// translated READMEs drifted for months unread: they are condensed on purpose, so nobody
// can compare wording — but the skeleton, the facts, the pointers and the links are all
// mechanically checkable.
//
// Sections are matched by *name*, never by position: v0.7.5 inserted a `## Compatibility`
// section and every positional assumption in a checker broke. A README gaining or losing a
// section must be a decision recorded here.
//
//   node scripts/check-docs-parity.mjs [--root DIR]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = (() => {
  const i = process.argv.indexOf('--root')
  if (i > 0) return path.resolve(process.argv[i + 1])
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)))
})()

// The install/behaviour/changelog/docs/licence/acknowledgment heading of every README, by name.
// `compatibility: null` means that README carries no list of its own — it must point at the
// English one instead, because a duplicated release list rots on the next manifest change.
const FILES = {
  'README.md': {
    install: '## Install', compatibility: '## Compatibility', usage: '## Usage',
    behaviour: '## Behavior notes', changelog: '## Changelog', docs: '## Documentation',
    licence: '## License & attribution', acknowledgments: '## Acknowledgments',
  },
  'README.zh.md': {
    install: '## 安装', compatibility: '## 兼容性', usage: '## 使用',
    behaviour: '## 行为与权限说明', changelog: '## 更新日志', docs: '## 相关文档',
    licence: '## 许可与出处', acknowledgments: '## 致谢',
  },
  'README.ja.md': {
    install: '## インストール', compatibility: null, usage: '## 使い方',
    behaviour: '## 動作メモ', changelog: '## 変更履歴', docs: '## ドキュメント',
    licence: '## ライセンスとクレジット', acknowledgments: '## 謝辞',
  },
  'README.ko.md': {
    install: '## 설치', compatibility: null, usage: '## 사용법',
    behaviour: '## 동작 참고', changelog: '## 변경 이력', docs: '## 문서',
    licence: '## 라이선스 및 출처', acknowledgments: '## 감사의 말',
  },
  'README.fr.md': {
    install: '## Installation', compatibility: null, usage: '## Utilisation',
    behaviour: '## Notes de comportement', changelog: '## Journal des modifications', docs: '## Documentation',
    licence: '## Licence et attribution', acknowledgments: '## Remerciements',
  },
  'README.de.md': {
    install: '## Installation', compatibility: null, usage: '## Verwendung',
    behaviour: '## Verhaltenshinweise', changelog: '## Änderungshistorie', docs: '## Dokumentation',
    licence: '## Lizenz und Namensnennung', acknowledgments: '## Danksagung',
  },
  'README.es.md': {
    install: '## Instalación', compatibility: null, usage: '## Uso',
    behaviour: '## Notas de comportamiento', changelog: '## Historial de versiones', docs: '## Documentación',
    licence: '## Licencia y atribución', acknowledgments: '## Agradecimientos',
  },
  'README.pt.md': {
    install: '## Instalação', compatibility: null, usage: '## Uso',
    behaviour: '## Notas de comportamento', changelog: '## Histórico de versões', docs: '## Documentação',
    licence: '## Licença e atribuição', acknowledgments: '## Agradecimentos',
  },
  'README.ru.md': {
    install: '## Установка', compatibility: null, usage: '## Использование',
    behaviour: '## Примечания о поведении', changelog: '## Журнал изменений', docs: '## Документация',
    licence: '## Лицензия и атрибуция', acknowledgments: '## Благодарности',
  },
}

// A README gaining or losing a behaviour bullet is a decision recorded here: the ninth one arrived
// with the keyboard door (`wsl_terminal`, 2026-10-06), which is a new model-facing tool rather than
// a difference of an existing one — the class of change a reader has to be told about.
const BEHAVIOUR_BULLETS = 9   // bash, file tools, search, skills, shell lifetime, keyboard door, jobs, old hosts, banner
const TOKENS = [
  'wsl-search', 'wsl-relay', 'bash_background', 'readlink', 'wsl_terminal',
  'FS_SANDBOX_DENIED', 'CHANGELOG.md', 'docs/README.md', 'TESTING.md',
]
const STALE = ['danger-full-access']
// The rule above is a documentation *choice*, not a factual correction: the mode really does
// pass writes through (src/fs.ts:319-328, asserted by tests/fs-policy.test.ts:95). It is kept
// out of the READMEs because none of them document how to escalate a sandbox, and the gate's
// job is that a translated README may not advertise something the English authority stopped
// saying. To make the mode user-facing instead, add it to README.md's file-tools bullet and
// drop it from this list — do not delete the check.

const FULL = Object.entries(FILES).filter(([, s]) => s.compatibility !== null).map(([f]) => f)

const red = []
const green = []
const fail = (m) => red.push(m)
const pass = (m) => green.push(m)

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(root, f))

/** Heading lines with their line index. */
function headings(lines) {
  return lines.map((l, i) => [l, i]).filter(([l]) => /^## /.test(l))
}

function sectionBody(lines, heading) {
  const hs = headings(lines)
  const at = hs.findIndex(([l]) => l === heading)
  if (at < 0) return null
  const start = hs[at][1]
  const end = at + 1 < hs.length ? hs[at + 1][1] : lines.length
  return lines.slice(start + 1, end)
}

const manifest = JSON.parse(read('package.json'))
const declared = Object.keys(manifest.dsh.compatibility.dshReleases).sort()
const manifestRepo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(manifest.repository.url)?.[1]

for (const [file, expected] of Object.entries(FILES)) {
  if (!exists(file)) { fail(`${file}: missing`); continue }
  const redBefore = red.length
  const lines = read(file).split('\n')
  const names = headings(lines).map(([l]) => l)

  // 1) the skeleton, by name — including that nothing unregistered was added or dropped
  const want = Object.values(expected).map(v => v).filter(Boolean)
  for (const h of want) if (!names.includes(h)) fail(`${file}: missing section "${h}"`)
  for (const h of names) if (!want.includes(h)) fail(`${file}: section "${h}" is not declared in scripts/check-docs-parity.mjs`)

  // 2) the behaviour section carries the current facts
  const body = sectionBody(lines, expected.behaviour)
  if (!body) { fail(`${file}: cannot read the behaviour section`); continue }
  const bullets = body.filter(l => /^- /.test(l))
  if (bullets.length !== BEHAVIOUR_BULLETS) fail(`${file}: ${bullets.length} behaviour bullets, expected ${BEHAVIOUR_BULLETS}`)
  const text = lines.join('\n')
  for (const t of TOKENS) if (!text.includes(t)) fail(`${file}: never mentions ${t}`)
  for (const s of STALE) if (text.includes(s)) fail(`${file}: still advertises "${s}"`)

  // 3) where the release list lives
  if (expected.compatibility) {
    const cb = sectionBody(lines, expected.compatibility) || []
    const listed = [...new Set([...cb.join('\n').matchAll(/`([^`]+)`/g)].map(m => m[1]))]
      .filter(t => /^0\.\d+\.\d+/.test(t)).sort()
    if (listed.join() !== declared.join()) fail(`${file}: ${expected.compatibility} lists ${listed.length} releases, manifest declares ${declared.length}`)
  } else if (!/README\.md/.test(sectionBody(lines, expected.install)?.length ? text : '')) {
    fail(`${file}: no pointer to the English compatibility section`)
  }

  // 4) the install command must name the repository the manifest names, in every language
  if (!text.includes(`github.com/${manifestRepo}`)) fail(`${file}: does not offer github.com/${manifestRepo}`)

  // The summary line only prints for a file that produced no RED above, so "ok" never
  // contradicts a failure on the same README.
  if (redBefore === red.length) pass(`${file}: ${names.length} declared sections + ${BEHAVIOUR_BULLETS} behaviour bullets`)
}

// 5) the changelog pointer must not enumerate versions — it rots on the next release
for (const [file, expected] of Object.entries(FILES)) {
  if (!exists(file)) continue
  const body = sectionBody(read(file).split('\n'), expected.changelog) || []
  const versions = [...body.join('\n').matchAll(/\b0\.\d+\.\d+/g)].map(m => m[0])
  if (versions.length) fail(`${file}: ${expected.changelog} hard-codes version(s) ${versions.join(', ')} — name the file, not the range`)
}

function markdownFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(p, acc)
    else if (entry.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

function checkLinks() {
  let checked = 0
  let broken = 0
  for (const file of markdownFiles(root)) {
    // Archived documents are kept verbatim: their prose and its references are history, so
    // only the links their banners added (the ones reaching out of the archive) are followed.
    const archived = file.includes(`${path.sep}archive${path.sep}`)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^(https?:|mailto:|#)/.test(target)) continue
      if (archived && !/\.\.\//.test(target)) continue
      checked++
      const abs = path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]))
      if (!fs.existsSync(abs)) { broken++; fail(`${path.relative(root, file)}: broken link ${target}`) }
    }
  }
  if (checked === 0) fail('no relative link was inspected — the check is not measuring anything')
  else if (broken === 0) pass(`${checked} relative links resolve`)
}

function checkChangelogPair() {
  const versions = (f) => exists(f)
    ? [...read(f).matchAll(/^## (0\.[^\s—]+) —/gm)].map(m => m[1])
    : null
  const en = versions('CHANGELOG.md')
  const zh = versions('CHANGELOG.zh.md')
  if (!en || !zh) return fail('CHANGELOG.md / CHANGELOG.zh.md missing')
  if (en.length !== zh.length) fail(`CHANGELOG.md lists ${en.length} releases, CHANGELOG.zh.md lists ${zh.length}`)
  const onlyEn = en.filter(v => !zh.includes(v))
  const onlyZh = zh.filter(v => !en.includes(v))
  if (onlyEn.length) fail(`releases only in CHANGELOG.md: ${onlyEn.join(', ')}`)
  if (onlyZh.length) fail(`releases only in CHANGELOG.zh.md: ${onlyZh.join(', ')}`)
  if (en[0] !== manifest.version) fail(`newest CHANGELOG.md entry is ${en[0]} but package.json says ${manifest.version}`)
  else pass(`CHANGELOG pair agrees on ${en.length} releases, newest ${en[0]} = package.json`)
}

checkLinks()
checkChangelogPair()

for (const g of green) console.log(`  ok   ${g}`)
for (const r of red) console.log(`  RED  ${r}`)
console.log(red.length ? `docs-parity: ${red.length} RED, ${green.length} ok` : `docs-parity: all ${green.length} checks green`)
process.exit(red.length ? 1 : 0)
