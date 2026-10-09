/**
 * Portability spellings: the shapes that only work by accident of one platform.
 *
 * Why a rule list rather than more tests: the ruling for this round was that the cheap fix is
 * the wrong one — "正确方法不是给涉及 cmd.exe 的代码加好几个测试, 是直接禁止写 cmd.exe, 转头去直接
 * 调用 node.exe". A test over a fragile spelling moves the cost to whoever debugs it next;
 * refusing the spelling moves it to the author, once. So every rule below is a SHAPE, and each
 * names the spelling it wants instead.
 *
 * Tiers, because this branch may not touch `src/`:
 *   - report (the default): every rule prints its hits with file:line and the run exits 0.
 *   - strict: only `abs-posix-path-in-windows-bash-step` may fail the run, and only outside
 *     `src/`. It is the one shape with no legitimate hit in the tooling tree and a known
 *     repair (leaf names, or MSYS_NO_PATHCONV=1 on the same line). The other rules become
 *     strict in the round that changes the product; marking them strict now would only teach
 *     the next person to add an exemption.
 *   - `lib/` is skipped entirely: it is the committed build output of `src/`, so a hit there
 *     is the same defect counted twice, and the src line is the one that owes the fix.
 *
 *   node scripts/check-portable-spelling.mjs                 # report
 *   node scripts/check-portable-spelling.mjs --strict        # gate the enforceable tier
 *   node --test scripts/check-portable-spelling.test.mjs     # the controls
 *
 * @module dsh-wsl-workspace/scripts/check-portable-spelling
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isProduct = (relPath) => relPath.startsWith('src/')
const isTooling = (relPath) => !isProduct(relPath)

/** A line-level shape plus the repair it asks for. `enforceable` gates the strict tier. */
export const RULES = [
  {
    id: 'child-output-decoded-as-utf8',
    shape: 'a child-process stream decoded by an explicit utf8 spelling at the call site',
    instead: 'decodeWslOutput(buffer) from src/shared/wsl.ts — wsl.exe writes UTF-16LE, and the '
      + 'NUL sniff belongs in one place',
    enforceable: 'none',
    match: (_rel, line, window = line) => {
      if (/decodeWslOutput/.test(line)) return false
      if (/\.toString\(\s*['"]utf8['"]\s*\)/.test(line)) {
        return /execFile|spawn|stdout|stderr|stream|buffer/i.test(line)
      }
      if (/encoding:\s*['"]utf8['"]/.test(line)) return /execFile|spawn/i.test(window)
      return false
    },
  },
  {
    id: 'execfilesync-outside-wsl-ts',
    shape: 'execFileSync called outside the one module allowed to own it',
    instead: 'the async execFileResult, or add the read to src/shared/wsl.ts so encoding and '
      + 'timeout policy stay in one file',
    // Not strict yet: the only non-src hits are the live-machine harness (tests/exec-shape.mjs),
    // whose job is to spawn for real.
    enforceable: 'none',
    match: (rel, line) => /execFileSync\s*\(/.test(line)
      && rel !== 'src/shared/wsl.ts' && !/portability-allow/.test(line),
  },
  {
    id: 'unc-rewrite-outside-paths-ts',
    shape: 'a backslash-to-slash path rewrite done ad hoc',
    instead: 'src/shared/paths.ts, which owns every spelling pair the plugin speaks',
    enforceable: 'none',
    match: (_rel, line) => /replace\(\/\\\\\/g,\s*'\/'\)/.test(line),
  },
  {
    id: 'wsl-distro-arg-unchecked',
    shape: "a '-d'/'-u' argument handed to wsl.exe",
    instead: 'a requireDistro/requireLinuxPath-guarded value, so an unvalidated name can never '
      + 'reach the 9P share through argv',
    enforceable: 'none',
    // Shape, not semantics: a '-d'/'-u' element whose value was not put through a named
    // validator on the same line. A file that validates upstream can carry
    // `// portability-allow: distro already required` and stop appearing.
    match: (_rel, line) => /['"]-[du]['"]/.test(line)
      && /execFile|spawn|wsl\.exe/.test(line)
      && !/require[A-Z]|assert[A-Z]|portability-allow/.test(line),
  },
  // The three shapes the 2026-10-01 tech-debt pass turned into red tests
  // (tests/tech-debt-exposure.test.ts). They belong here because a passing test wrapped around a
  // fragile spelling only moves the cost to whoever debugs it next; the spelling has to go.
  {
    id: 'spawn-through-a-shell-with-args',
    shape: 'a spawn that hands an argument list to a command interpreter (shell: true, or ' // portability-allow: the rule's own description of the shape; a rule that could not name it could not be tested
      + 'shell: process.platform === "win32")',
    instead: 'spawnSync(process.execPath, [entryScript, ...args]) with no shell at all. The '
      + 'interpreter RE-TOKENISES argv — Node says so itself (DEP0190: the arguments are not '
      + 'escaped, only concatenated) — so one space inside a path-derived argument becomes two '
      + 'arguments. Measured on this machine: the same argv through shell:true exits 1 with '
      + '"Cannot find module D:\\Temp\\dsh-spaced"; through shell:false the child receives exactly '
      + 'one intact argument',
    enforceable: 'none',
    match: (_rel, line) => /\bshell:\s*(true|process\.platform)/.test(line)
      && !/portability-allow/.test(line),
  },
  {
    id: 'cmd-exe-as-an-api',
    shape: 'spawning cmd.exe to do something Node\'s own API can already do',
    instead: 'the API. fs.symlinkSync(target, path, "junction") stands in for cmd /c mklink /J and '
      + 'throws an Error carrying EEXIST/EPERM/ENOENT instead of a bare exit status. Measured on '
      + 'spaced paths: both forms succeed, so the debt here is the interpreter and the lost errno, '
      + 'NOT a quoting crash — the report predicted a syntax failure and measurement refuted it',
    enforceable: 'none',
    match: (_rel, line) => /['"]cmd(\.exe)?['"]/.test(line)
      && /spawn|execFile/.test(line) && !/portability-allow/.test(line),
  },
  {
    id: 'stdio-ignore-discards-the-reason',
    shape: 'stdio: "ignore" on a child process whose exit status the caller checks', // portability-allow: as above — this is the rule's own description of the shape
    instead: 'capture stderr (encoding: "utf8") and print it in the failure message, so a red run '
      + 'names its cause — the rule the WSL gates already hold themselves to. Measured: the same '
      + 'failing mklink carries cmd\'s own sentence as soon as stdio is not ignored',
    enforceable: 'none',
    match: (_rel, line) => /stdio:\s*['"]ignore['"]/.test(line) && !/portability-allow/.test(line),
  },
  {
    id: 'abs-posix-path-in-windows-bash-step',
    shape: 'an absolute /tmp-style path assigned in a bash step that runs on a Windows runner',
    instead: 'a leaf name the driver prefixes itself, or MSYS_NO_PATHCONV=1 on the SAME line — '
      + 'Git Bash rewrites /tmp/x into C:\\tmp\\x before the program ever sees it',
    enforceable: 'outside-src',
    // Two shapes, both of them the mechanism rather than the look of a path: an `env:`
    // mapping value, and an assignment written INLINE before a native command (`VAR=/tmp/x
    // wsl.exe …`). A plain `VAR=/tmp/x` on its own bash line is not flagged — MSYS rewrites
    // argv handed to a native executable, not the shell's own variables, and verify-dsh-compat
    // .sh depends on that distinction today (all three matrix versions green).
    match: (rel, line) => {
      if (!/^\.github\/workflows\//.test(rel)) return false
      const text = line.trim()
      if (text.startsWith('#')) return false
      const inline = /(^|\s)[A-Z_]+=\/(tmp|var|usr)\b/.test(line) && /\bwsl\.exe\b/.test(line)
      const mapping = /^-[\s]+[A-Z_]+:\s*\|?\s*\/?\/(tmp|var|usr)\b/.test(text)
        || /^[A-Z_]+:\s+\/(tmp|var|usr)\b/.test(text)
      return (inline || mapping) && !/MSYS_NO_PATHCONV=1/.test(line)
    },
  },
]

function listFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name.startsWith('.') && name !== '.github') continue
      listFiles(full, out)
    } else if (/\.(ts|tsx|mjs|cjs|js|yml|yaml|sh)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Scan every rule's shape over the tree.
 * @param root - repository root, or the directory a control hands in.
 * @returns findings as `{ ruleId, path, line, text }` in file order.
 */
export function scan(root = repo) {
  const files = listFiles(root, [])
    .map((full) => ({ full, rel: relative(root, full).replace(/\\/g, '/') }))
    .filter(({ rel }) => !rel.startsWith('lib/')
      && !rel.startsWith('scripts/check-portable-spelling'))
  const findings = []
  for (const { full, rel } of files) {
    let lines
    try {
      lines = readFileSync(full, 'utf8').split('\n')
    } catch {
      continue // an unreadable entry is not a portability finding
    }
    lines.forEach((text, index) => {
      // A six-line look-back, because an option object is written below the call that owns it:
      // `encoding:'utf8'` on its own line is also what fs uses innocently, and the rule wants
      // the child-process call, not the word.
      const window = lines.slice(Math.max(0, index - 6), index + 1).join('\n')
      for (const rule of RULES) {
        if (rule.match(rel, text, window)) {
          findings.push({ ruleId: rule.id, path: rel, line: index + 1, text: text.trim().slice(0, 160) })
        }
      }
    })
  }
  return findings
}

/** The findings the strict tier is allowed to fail on. */
export function enforceable(findings) {
  const strictIds = new Set(RULES.filter((r) => r.enforceable === 'outside-src').map((r) => r.id))
  return findings.filter((f) => strictIds.has(f.ruleId) && isTooling(f.path))
}

/** The findings that are a worklist for the product round. */
export function productWorklist(findings) {
  return findings.filter((f) => isProduct(f.path))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const strict = process.argv.includes('--strict')
  const findings = scan()
  const byRule = new Map()
  for (const finding of findings) {
    if (!byRule.has(finding.ruleId)) byRule.set(finding.ruleId, [])
    byRule.get(finding.ruleId).push(finding)
  }
  for (const rule of RULES) {
    const hits = byRule.get(rule.id) ?? []
    console.log(`[${rule.id}] ${hits.length} hit(s) — ${rule.enforceable === 'outside-src'
      ? 'strict outside src' : 'report only this round'}`)
    console.log(`    shape: ${rule.shape}`)
    console.log(`    instead: ${rule.instead}`)
    for (const hit of hits) console.log(`      ${hit.path}:${hit.line}  ${hit.text}`)
  }
  console.log(`check-portable-spelling: ${findings.length} finding(s), `
    + `${enforceable(findings).length} enforceable, ${productWorklist(findings).length} under src/`)
  if (strict) {
    const blocking = enforceable(findings)
    if (blocking.length > 0) {
      console.error(`check-portable-spelling: RED — ${blocking.length} enforceable finding(s)`)
      for (const hit of blocking) console.error(`  ${hit.path}:${hit.line} ${hit.text}`)
      process.exit(1)
    }
  }
  process.exit(0)
}
