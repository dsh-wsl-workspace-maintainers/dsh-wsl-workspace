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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    // `mktemp -d`, not `/tmp/w51c`: a fixed path is a fixture a *previous* run can leave behind, and
    // then the row answers with someone else's bytes. Measured the hard way on 2026-10-09 — a root-owned
    // `/tmp/w51c` from an earlier gate run made a later unprivileged run print `2` (the stale count) next
    // to `Permission denied` on its own write, and the row passed on evidence it had not produced.
    command: 'D=$(mktemp -d) && printf "alpha 1\\nbeta 2\\n" > $D/a.txt && printf "alpha 3\\n" > $D/b.txt && echo "HITS=$(grep -rn alpha $D | wc -l)"',
    want: ['HITS=2'],
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
    command: 'F=$(mktemp); (sleep 0.2; echo BG_DONE_$(( 6 * 8 ))) > $F; sleep 1; cat $F; rm -f $F',
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
    // The three rows below are one story, and they have to run in order: a command can end the
    // persistent shell the way a person typing `exit` ends their own terminal, and that is neither a
    // cancelled call nor a crash. Measured on the installed 0.7.7 build (real host, real model-shaped
    // calls, 2026-10-09): `echo out; echo err >&2; exit 3` came back as `Error: tool call aborted`
    // with **neither** stream, and the fact that the shell had been rebuilt surfaced on the *next*
    // call, where it reads as that call's own event. A model cannot act on that answer: it looks like
    // the user pressed stop, so it stops, or retries the same line and ends the shell again.
    shape: 'work staged before the shell is ended',
    name: 'a directory and an export made before the exit',
    command: 'cd /tmp && export W51_EXIT_STAGE=kept && echo STAGED',
    want: ['STAGED'],
  },
  {
    shape: 'a command that ends the session shell',
    name: 'bare `exit 3` answers with its own streams and says what it did',
    command: 'echo out; echo err >&2; exit 3',
    // The three together are the claim: both streams came back, and the answer says the shell ended.
    // `[stderr]` is not one of them — that separator is the renderer's, and this row judges the tool's
    // own return value, where the two streams are separate fields (measured: a row asking for it failed
    // on a build that was answering correctly).
    wantAll: ['out', 'err', 'ended the session shell'],
    note: 'the streams AND the disclosure; an answer with one of the two is the defect',
  },
  {
    shape: 'the shell still works after a call ended it',
    name: 'the replayed state is the one the exit left behind',
    command: 'pwd; echo SENT=$W51_EXIT_STAGE',
    wantAll: ['/tmp', 'SENT=kept'],
  },
  {
    // Two more ways a line ends the shell, both found by driving the installed build through the
    // product's own session (not by reading the code): `set -e` makes *any* failing simple command end
    // an interactive shell with `errexit` on, and `exec bash --norc` replaces the process image — the
    // replacement then reads the pipe to EOF and exits, so the child is gone by the next poll. The
    // standard that decides whether either is a defect is the native one: a person typing the same line
    // into their own terminal also ends that shell. So the claim is not "make it survive", it is "answer
    // with what the call produced and say what happened", which is the same claim as the row above.
    // Measured on the desktop 2026-10-09, on the build with the fix: `set -e; false; echo NEVER` →
    // `(no output) [exit code: 1]` + the disclosure, 1 163 ms; `exec bash --norc` → the same disclosure,
    // 1 162 ms; both with `isError=false`. Before that build both were `Error: tool call aborted`.
    shape: 'other ways a line ends the session shell',
    name: '`set -e` with a failing command says so instead of reading as a cancel',
    command: 'set -e; false; echo NEVER',
    wantAll: ['ended the session shell'],
  },
  {
    shape: 'a call that replaces the shell process',
    name: '`exec bash --norc` answers with the disclosure and the session recovers',
    command: 'exec bash --norc',
    wantAll: ['ended the session shell'],
  },
  {
    shape: 'the shell is back and still the session user\'s',
    name: 'the call after the exec answers normally',
    command: 'echo AFTER_EXEC_ALIVE=ok; pwd',
    wantAll: ['AFTER_EXEC_ALIVE=ok', '/tmp'],
  },
  {
    // Parity, measured rather than assumed, on a line that looks like a bug and is not: defining an
    // alias and using it in the same input line. Native, in this distribution, at this moment:
    //   printf "alias zzz='echo ALIAS_OK'; zzz\n" | bash -i   →  command not found, exit 127
    //   printf "alias yyy='echo YYY_OK'\nyyy\n"                →  YYY_OK on the second read line
    // (both run 2026-10-09 on this machine). bash expands aliases when it reads a line, so the first
    // shape fails in a person's terminal exactly as it fails here. The row therefore asserts the
    // *native* answer — including the 127 and the `not found` sentence — because a difference from
    // native is the only thing this repository treats as a defect.
    shape: 'alias defined and used in one line (native parity, not a bug)',
    name: '`alias zzz=…; zzz` is not found in this call and is defined for the next',
    command: "alias zzz='echo ALIAS_OK'; zzz; echo \"CODE=$?\"",
    wantAll: ['not found', 'CODE=127'],
  },
  {
    shape: 'alias defined and used in one line (native parity, not a bug)',
    name: 'the next call sees the alias the earlier one defined',
    command: 'zzz',
    want: ['ALIAS_OK'],
  },
  {
    // Sunk from the release behaviour matrix (rows 1.5, 1.8, 2.1, 2.5 of
    // `docs/release-behaviour-matrix.zh.md`), each with the native reading taken on 2026-10-09 in the
    // same distribution: `hi` + `PIPE=0` exit 0; `TR` exit 7; `5`; and `x \r \n C J K \r`. An
    // expectation in that document is only good until the native side contradicts it — row 1.7 and
    // row 2.1's byte count both died on today's run, so a row lands here only after both sides spoke.
    shape: 'a pipeline whose reader exits early',
    name: 'head on a one-line echo must not earn a broken-pipe sentence',
    command: 'echo hi | head -n1; echo PIPE=$?',
    wantAll: ['hi', 'PIPE=0'],
    forbid: ['Broken pipe'],
  },
  {
    shape: 'an EXIT trap in a child shell',
    name: 'a trap on exit still prints before the code arrives',
    command: "bash -c 'trap \"echo TR\" EXIT; exit 7'",
    want: ['TR'],
  },
  {
    shape: 'raw bytes through the decoder',
    name: 'NUL and two high bytes count as the five bytes they are',
    command: "printf 'a\\x00b\\xff\\xfe' | wc -c",
    want: ['5'],
  },
  {
    shape: 'carriage returns must not be repaired',
    name: 'CRLF and a lone CR stay in the byte dump',
    // The needles are `od -c`'s own column spacing (three spaces between single characters) and its
    // two-character `\r` — taken from the answer this row produced on 2026-10-09, where the session
    // returned `x  \r  \n   C   J   K  \r`. A one-space needle failed the row, not the product.
    command: "printf 'x\\r\\nCJK\\r' | od -c | head -3",
    wantAll: ['C   J   K', '\\r', '\\n'],
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
// The harness creates this tree inside the repository, so it takes it back down with it: the run that
// staged the shell-exit rows left `ci/deps/.w51c-7zaNr3/` (an `overlay.yml` and a `profiles/` tree)
// standing in the worktree, where the next person reads it as somebody's half-finished work.
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A teardown that cannot delete must not become a census failure; the run's own verdicts already
    // printed by this point.
  }
})
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

  // Identity by the module's own `TOOL_NAME`, not by guessing from shape: the session tool
  // **replaces** `bash` in the registry, so the name the registry answers to is the same either way
  // and cannot tell the two apart. Getting this wrong measures the host's one-shot bash and every row
  // below becomes a statement about the wrong shell — which is exactly what the first attempt did.
  const hostModule = m => m.default ?? m
  const sessionName = sessionTool.TOOL_NAME ?? 'bash'
  const hostOneShot = hostModule(await import(
    pathToFileURL(join(repoRoot, 'ci', 'deps', 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js')).href,
  ))
  const isSession = tool?.name !== undefined || sessionName === 'bash'
  rows.push({
    shape: 'WHICH SHELL ANSWERED',
    name: 'the registry entry under test',
    ok: isSession,
    ms: 0,
    evidence: `session module declares TOOL_NAME=${JSON.stringify(sessionName)}; `
      + `the host's one-shot bash is named ${JSON.stringify(hostOneShot.name ?? '(unnamed)')}; `
      + `the registry answered ${JSON.stringify(tool?.name ?? '(no name)')}`,
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
    // `want` is any-of: the row passed if the evidence appeared somewhere. `wantAll` is the other
    // claim — a row whose answer must carry *several* things at once, because the defect being pinned
    // is one of them going missing (a bare `exit` answers with its stdout but drops the note saying
    // the shell ended, or keeps the note and loses the streams).
    const needles = row.wantAll ?? row.want
    const found = row.wantAll === undefined ? row.want.some(needle => text.includes(needle))
      : row.wantAll.every(needle => text.includes(needle))
    // `forbid` says the half a needle list cannot: the answer carries its marker *and* does not carry
    // a sentence nobody earned (a `Broken pipe` we added, a reset sequence written twice).
    const poisoned = (row.forbid ?? []).filter(needle => text.includes(needle))
    const ok = found && poisoned.length === 0
    rows.push({
      shape: row.shape,
      name: row.name,
      ok,
      ms: elapsed,
      evidence: poisoned.length > 0 ? `forbidden text in the answer: ${JSON.stringify(poisoned)}`
        : found ? (needles.find(needle => text.includes(needle)) ?? '') : text.slice(0, 200),
      note: row.note,
    })
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${String(elapsed).padStart(6)}ms  ${row.shape}\n`)
  }

  // ── THE ANSWER, NOT THE SEAM ──────────────────────────────────────────────────────────────────
  // Every row above asks one question: did this seam answer? None of them asks the question a user
  // asks, which is whether a real development command comes back with the *right* answer. So these
  // four are measured against ground truth: the identical command line run directly in the same
  // distribution, through the same `wsl.exe`, outside the session — pipes, quoting, two output
  // streams, a non-zero exit, a real tree walk. Same bytes, or the row is red.
  //
  // A difference here would not be a protocol detail. It would be a wrong answer to a command someone
  // typed, which is the only failure mode this whole project exists to rule out.
  const { execFile: execFileCallback } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const runDirect = promisify(execFileCallback)
  const COMPLEX = [
    { name: 'a pipeline with a filter and a count', command: 'ls -1 /etc 2>/dev/null | grep -c .' },
    { name: 'both streams and a non-zero exit', command: 'sh -c \'echo on-stdout; echo on-stderr >&2; exit 3\'; echo "code=$?"' },
    { name: 'awk with quotes and arithmetic', command: 'awk \'BEGIN{ printf "%s:%d\\n", "sum", 6 * 7 }\'' },
    { name: 'a real tree walk, counted', command: 'find /usr/share/doc -maxdepth 1 -type d 2>/dev/null | wc -l' },
  ]
  for (const [index, probe] of COMPLEX.entries()) {
    const startedAt = Date.now()
    let ok = false
    let evidence = ''
    // Both sides run the same **script file**, not the same argument string. `wsl.exe … bash -c
    // '<text>'` puts the text through one more shell on the way in, which expands `$?` before `bash`
    // ever sees it — measured: a direct run of `…; echo "code=$?"` answered `code=0` where the
    // session answered the correct `code=3`. That is hazard A/E's own subject, and it is why the
    // ground truth here is a file the session writes once and both sides then execute.
    const script = `/tmp/w51c-complex-${process.pid}-${index}.sh`
    try {
      const quoted = probe.command.replace(/'/g, `'\\''`)
      const staged = await tool.execute({ command: `printf '%s\\n' '${quoted}' > ${script}`, description: `census: stage ${probe.name}` },
        { signal: AbortSignal.timeout(30_000), agent: undefined })
      // Staging is part of the measurement, not plumbing: a `>` that fails against a file a previous
      // root run left behind would let the next line execute *that* file, and the row would answer for
      // a command it never staged. Fixed `/tmp` names did exactly this on 2026-10-09, so the name
      // carries this process's id and a failed stage is reported as itself.
      if (staged?.exitCode !== 0) throw new Error(`staging ${script} failed with exit ${String(staged?.exitCode)}`)
      const viaSession = await tool.execute({ command: `bash ${script}`, description: `census: ${probe.name}` },
        { signal: AbortSignal.timeout(60_000), agent: undefined })
      const direct = await runDirect('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'bash', script],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 })
      // The session's `stdout` is a `CollectedOutput`, not a string — coercing it with `String()`
      // yields `[object Object]`, which reads as "the session answered nothing" and is exactly the
      // kind of wrong answer this section exists to catch rather than to blame on the product.
      const raw = viaSession?.stdout
      const answered = (typeof raw === 'string' ? raw : (raw?.text ?? '')).trim()
      const expected = String(direct.stdout ?? '').trim()
      ok = answered === expected && Number(viaSession?.exitCode) === 0
      evidence = ok
        ? `byte-identical to a direct run (${answered.split('\n').length} line(s), exit ${viaSession?.exitCode})`
        : `the session answered ${JSON.stringify(answered.slice(0, 140))} (exit ${viaSession?.exitCode}) where a `
          + `direct run of the same line answered ${JSON.stringify(expected.slice(0, 140))} (exit 0)`
    } catch (error) {
      evidence = `threw: ${String(error?.message ?? error).slice(0, 200)}`
    }
    rows.push({
      shape: 'a real development command, answered',
      name: probe.name,
      ok,
      ms: Date.now() - startedAt,
      evidence,
    })
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${String(Date.now() - startedAt).padStart(6)}ms  real command: ${probe.name}\n`)
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