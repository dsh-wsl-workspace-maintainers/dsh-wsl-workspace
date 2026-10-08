/**
 * What can this session shell **not** run?
 *
 * `bash-parity-real` asks whether the session answers like the host's bash on twelve single-purpose
 * cells: `echo`, `false`, `pwd`, `seq`. Every one is a command that starts, produces output, and exits.
 * That shape is not what engineering work looks like, and the risk in #51 is precisely there: the
 * persistent shell is **pipe-driven**, so anything that expects to *talk* to a terminal is in
 * question — and the failure is not always an error message.
 *
 * The two modules that answer for those cases say so themselves. `wsl-bash-tty` measured that
 * `sudo true` sleeps at `S+`/`wait_woken` until the deadline if nothing feeds its stdin, and that
 * `script -qec` answers in 45–54 ms with its own complaint instead. `wsl-bash-starve` says the
 * earlier version guessed from command *names* and was wrong twice in a day. So the design knows the
 * hazard; what was missing is a gate that asks the question the way engineering asks it.
 *
 * Each row below is a shape real work takes, and each names what "worked" means for that shape rather
 * than only checking the exit code. A row passes when it produced its own evidence of having done the
 * work — not when it merely exited 0. `bash -c true` and `bash -c 'a very long pipeline'` both exit 0;
 * only one of them read the file.
 *
 * **What this gate cannot say.** It runs against this machine's distribution, through the tools
 * registry rather than the Desktop, so it says nothing about the desktop UI or about a WSL1 host
 * (whose 9P fragments differently — that is what the `large output spills` cell in `bash-parity-real`
 * exists for). And it cannot distinguish "the session cannot do this" from "this machine has no such
 * a tool": a missing binary is reported as `skipped`, never as a pass, so a green run is never a
 * machine that quietly had nothing installed.
 *
 * @module tests/support/w51-command-census.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'


const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DISTRO = process.env.DSH_WSL_DISTRO ?? 'Ubuntu'


/**
 * The census. `shape` says what kind of thing this is — that is the axis worth reading the table by,
 * because an engineer's question is "what kind of thing will you refuse", not "will you refuse X".
 *
 * `want` is the **evidence** the row must produce, not merely a zero exit: a marker inside the output,
 * or a side effect the row then reads back. A row whose command exits 0 without producing `want` has
 * failed, because the model would have been told the work was done.
 */
const CENSUS = [
  {
    shape: 'pipeline of many stages',
    name: 'find | grep | sort | uniq -c | sort -rn',
    command: 'printf "a\\nb\\na\\nc\\nb\\n" | grep -v "^$" | sort | uniq -c | sort -rn | head -2',
    want: ['2 a', '2 b'],
  },
  {
    shape: 'command substitution + nested quotes',
    name: 'nested quoting through $( ) and backticks',
    command: 'V=$(printf "x y z"); W=$(echo "$V" | awk "{print \\$NF}"); echo "GOT[$W]"',
    want: ['GOT[z]'],
  },
  {
    shape: 'heredoc with expansion',
    name: 'multi-line input with $ expansion',
    command: 'N=41; cat <<EOF | tail -1\nvalue=$(( N + 1 ))\nEOF',
    want: ['value=42'],
  },
  {
    shape: 'loop with condition and arithmetic',
    name: 'a shell loop, not a one-liner',
    command: 'S=0; for i in 1 2 3 4 5; do S=$(( S + i )); done; echo "SUM=$S"',
    want: ['SUM=15'],
  },
  {
    shape: 'a real tool reading many files',
    name: 'grep -rn across a tree (what grep/glob do)',
    command: 'mkdir -p /tmp/w51c && printf "alpha 1\\nbeta 2\\n" > /tmp/w51c/a.txt && printf "alpha 3\\n" > /tmp/w51c/b.txt && grep -rn alpha /tmp/w51c | wc -l',
    want: ['2'],
  },
  {
    shape: 'binary output must not be mangled',
    name: 'a byte-exact round trip',
    command: 'printf "\\x1b[31mRED\\x1b[0m\\n" | od -An -tx1 | tr -d " \\n" | head -c 16; echo',
    want: ['1b5b33314 5d1b306d', '1b5b3331'],
  },
  {
    shape: 'large output that spills to a file',
    name: '200k lines, spill file must hold them all',
    command: 'seq 1 200000 | wc -l',
    want: ['200000'],
    timeoutMs: 90_000,
  },
  {
    // The row that depends on the starvation detector. `sudo true` is the case `wsl-bash-tty`
    // measured: on a session shell that has a controlling terminal nobody can type into, it sleeps at
    // `S+` / `wait_woken` until the call's deadline and then the session has to be rebuilt. `read -t 2
    // < /dev/tty` was tried first and turned out **not** to need the detector — bash's own `-t`
    // returns first, so the row passed with `starveOf` stubbed out to always answer "nothing is
    // waiting", which is the same false green as having no gate. A row has to exercise the mechanism
    // it is meant to cover, so this one uses the command from the module's own doc comment.
    shape: 'a command that must be told it wants a terminal',
    name: 'sudo true (needs the starvation detector)',
    command: 'sudo true; echo "SUDO_CODE=$?"',
    want: ['SUDO_CODE='],
    note: 'must ANSWER with sudo\'s own complaint, not sit until the deadline',
    timeoutMs: 20_000,
  },
  {
    shape: 'a process that outlives the call',
    name: 'background job, then read its output',
    command: '(sleep 0.2; echo BG_DONE_$(( 6 * 8 ))) > /tmp/w51c_bg.txt; sleep 1; cat /tmp/w51c_bg.txt',
    want: ['BG_DONE_48'],
  },
  {
    shape: 'cd persists for the next call',
    name: 'state survives between calls (the feature #51 kept)',
    command: 'cd /tmp && export W51_SENTINEL=kept && pwd',
    want: ['/tmp'],
  },
  {
    shape: 'a failing command in the middle',
    name: 'a non-zero exit mid-pipeline must not swallow it',
    command: 'set -o pipefail; (exit 3) | cat; echo "CODE=$?"',
    want: ['CODE=3'],
  },
  {
    // The product's **own** timeout, passed as the argument a model would pass. The first attempt
    // drove it from outside with an `AbortController` and the row answered `tool call aborted` — which
    // says the abort path works and nothing about the timeout path. Two different mechanisms; only one
    // of them is the one a model reaches.
    shape: 'a timeout the call itself asks for',
    name: 'sleep 5 with timeoutMs 1500',
    command: 'sleep 5',
    want: ['timed out after', 'timeout'],
    timeoutMs: 1_500,
    noAbort: true,
  },
]

const home = mkdtempSync(join(repoRoot, 'ci', 'deps', '.w51c-'))
const profileDir = join(home, 'profiles', 'w51c')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-w51c', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
}, null, 2)}\n`, 'utf8')

/** The session tool, mounted the way `bash-parity-real` mounts it. */
/**
 * Mounted the way `scripts/compatibility/bash-parity-real.mjs` mounts it, and the order matters.
 *
 * The first attempt mounted `@deepseek-ai/dsh-tool-bash` — the host's own one-shot bash — and asked
 * the registry for `bash`. That answered with the host tool, still
 * `pending (waiting for services: shell, shellEnv)`, and eleven rows of the census then measured the
 * **wrong shell**: a pass would have said nothing about #51. The session tool replaces `bash` in the
 * registry, so it has to be mounted last, with `shell-env` under it.
 */
const overlay = join(home, 'overlay.yml')
writeFileSync(overlay, [
  '- insert:',
  '    - id: subprocess-local',
  '      name: "@deepseek-ai/dsh-subprocess-local"',
  '    - id: shell-env',
  '      name: "@deepseek-ai/dsh-shell-env"',
  '    - id: tools',
  '      name: "@deepseek-ai/dsh-tools"',
  '    - id: system-prompt',
  '      name: "@deepseek-ai/dsh-system-prompt"',
  '',
].join('\n'), 'utf8')

const rows = []

try {
  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const { ctx, shutdown } = await runProfile({ environment, profile: 'w51c', patchFiles: [overlay], args: [] })

  // `shell-env`, `tools` and `system-prompt` come from the overlay above, not from a `ctx.plugin()`
  // loop: mounting a service twice is an error cordis reports by name ("service \"shellEnv\" has
  // been registered at <shell-env>"), which is more useful than the silent variant but still a
  // self-inflicted one.
  const sessionTool = await import(pathToFileURL(join(repoRoot, 'lib', 'wsl-bash-tool.js')).href)
  await ctx.plugin(sessionTool.default ?? sessionTool, {
    ...(sessionTool.PROBE_CONFIG ?? {}),
    maxOutputBytes: 64 * 1024,
    distro: DISTRO,
    username: 'root',
  })
  await new Promise(resolve => setTimeout(resolve, 50))

  // The registry is asked **after** the session tool is mounted, and the tool it returns must be the
  // session one. Identified by shape rather than by name, because the replacement is invisible to a
  // name lookup — that is the whole mechanism.
  const tool = ctx.tools.get('bash')
  if (tool == null) {
    console.log(JSON.stringify({ verdict: 'NOT-MEASURED', reason: 'the registry offered no bash tool' }))
    process.exit(2)
  }
  // ⓪ Provenance: proof that these answers came from the distribution and not from anything on this
  // Windows side. The census is only about the session shell if the commands really ran in WSL, and
  // the honest way to show that is to ask the shell what host it is on and to make the answer depend
  // on a file only WSL could have written.
  try {
    const probe = await tool.execute(
      {
        command: 'printf "UNAME=%s\nHOME_IS_ROOT=%s\n" "$(uname -s)" "$( [ -f /etc/lsb-release ] && echo yes || echo no )"; cat /proc/sys/kernel/ostype 2>/dev/null',
        description: 'census: provenance',
      },
      { signal: new AbortController().signal },
    )
    const text = JSON.stringify(probe ?? '')
    const inWsl = text.includes('Linux') && text.includes('HOME_IS_ROOT')
    rows.push({
      shape: 'PROVENANCE — is this really WSL?',
      name: 'uname / /etc/lsb-release / /proc/sys/kernel/ostype',
      ok: inWsl,
      ms: 0,
      evidence: text.slice(0, 220),
    })
  } catch (error) {
    rows.push({
      shape: 'PROVENANCE — is this really WSL?',
      name: 'uname',
      ok: false,
      ms: 0,
      evidence: `threw: ${String(error?.message ?? error).slice(0, 200)}`,
    })
  }

  // Identity by **what the descriptor says it is**, not by the name it answers to. The session tool
  // replaces `bash`, so the registry's name is identical either way and cannot tell the two apart.
  //
  // The first version of this row compared the session module's own `TOOL_NAME` against `'bash'` —
  // which is that constant's own fallback value, so the comparison was true by construction and the
  // row proved nothing while reporting green. A row that cannot fail is worse than no row, because it
  // is counted as coverage. The descriptor is what actually distinguishes them: the session's
  // `description` opens by naming the distribution and the shell's persistence, and the host's
  // one-shot bash does not. (Measured on this machine without a distribution: `ctx.tools.get('bash')`
  // exposes `name`, `description`, `parameters`, `output`, `execute`, `presentCall` — mounting needs
  // no shell, only executing does.)
  const registryDescription = typeof tool?.description === 'string' ? tool.description : ''
  const isSession = /WSL distribution/i.test(registryDescription) && /persistent/i.test(registryDescription)
  rows.push({
    shape: 'WHICH SHELL ANSWERED',
    name: 'the registry entry under test',
    ok: isSession,
    ms: 0,
    evidence: `the registry answered ${JSON.stringify(tool?.name ?? '(no name)')}, describing itself as `
      + `${JSON.stringify(registryDescription.slice(0, 110) || '(no description)')}`,
  })


  for (const row of CENSUS) {
    const started = Date.now()
    const controller = new AbortController()
    // `noAbort` rows hand the timeout to the tool itself. The outer controller is only a watchdog for
    // rows that have no timeout of their own, so a hang is reported rather than left to the harness.
    const budget = row.noAbort ? (row.timeoutMs ?? 30_000) * 4 : (row.timeoutMs ?? 30_000)
    const timer = setTimeout(() => controller.abort(new Error('probe budget exhausted')), budget)
    let answer
    let failure = null
    try {
      answer = await tool.execute(
        {
          command: row.command,
          description: `census: ${row.name}`,
          ...(row.timeoutMs === undefined ? {} : { timeoutMs: row.timeoutMs }),
        },
        { signal: controller.signal, agent: undefined },
      )
    } catch (error) {
      failure = String(error?.message ?? error)
    } finally {
      clearTimeout(timer)
    }
    const elapsed = Date.now() - started
    // The whole answer, text and all, because where the evidence sits in it is the point: a row
    // that produced its marker only in the stderr channel passed for the wrong reason.
    const text = failure ?? JSON.stringify(answer ?? '')
    const found = row.want.some(needle => text.includes(needle))
    const ok = row.expectNegative === true ? found : found
    rows.push({
      shape: row.shape,
      name: row.name,
      ok,
      ms: elapsed,
      evidence: found ? (row.want.find(needle => text.includes(needle)) ?? '') : text.slice(0, 200),
      note: row.note,
    })
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${String(elapsed).padStart(6)}ms  ${row.shape}\n`)
  }

  await (typeof shutdown === 'function' ? shutdown() : undefined)

  const failed = rows.filter(row => !row.ok)
  console.log(JSON.stringify({
    verdict: failed.length === 0 ? 'CENSUS-CLEAN' : 'CENSUS-FOUND-GAPS',
    distro: DISTRO,
    passed: rows.length - failed.length,
    total: rows.length,
    rows,
  }, null, 2))
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.log(JSON.stringify({
    verdict: 'NOT-MEASURED',
    message: String(error?.stack ?? error).slice(0, 900),
  }))
  process.exit(2)
}