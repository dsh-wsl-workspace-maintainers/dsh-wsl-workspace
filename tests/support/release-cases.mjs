import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, relative, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [driverFile, outputDir] = process.argv.slice(2)
if (!driverFile || !outputDir) {
  throw new Error('usage: node release-cases.mjs <release-session.mjs> <evidence-directory>')
}
const { withReleaseSession } = await import(pathToFileURL(resolve(driverFile)))
const distro = process.env.DSH_WSL_DISTRO ?? process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const chosen = new Set((process.env.DSH_MATRIX_ROWS ?? '3.6,6.7,10.1,10.3,12.4,12.6').split(','))
const excluded = new Set((process.env.DSH_MATRIX_EXCLUDE ?? '').split(',').map(id => id.trim()).filter(Boolean))
const rootArm = process.env.DSH_WSL_USER === 'root'
const disposableWindows = process.env.GITHUB_ACTIONS === 'true' || process.env.DSH_MATRIX_DISPOSABLE_WINDOWS === '1'
const requestedUser = process.env.DSH_WSL_USER
const wslPrefix = ['-d', distro, ...(requestedUser ? ['-u', requestedUser] : [])]
const evidence = resolve(outputDir)
mkdirSync(evidence, { recursive: true })
const runId = randomUUID()
const rowsPath = join(evidence, 'matrix-rows.jsonl')
writeFileSync(rowsPath, '')

const sh = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const wsl = (command, timeout = 15_000) => {
  const run = spawnSync('wsl.exe', [...wslPrefix, '--exec', 'bash', '-s'], {
    input: command + '\n', encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
  })
  if (run.status !== 0) throw new Error(`WSL setup failed: ${run.error ?? run.stderr ?? run.status}`)
  return run.stdout.trimEnd()
}

const linuxHome = wsl('printf "%s" "$HOME"')
const user = wsl('id -un')
const kernel = wsl('uname -r')
const distroList = spawnSync('wsl.exe', ['--list', '--verbose'], { timeout: 10_000 }).stdout
const distroRow = (distroList?.toString('utf16le') ?? '').split(/\r?\n/).find(line => line.trimStart().replace(/^\*\s*/, '').split(/\s{2,}/)[0] === distro)
const kernelMajor = Number(distroRow?.trim().match(/\s([12])$/)?.[1])
const linuxCwd = `${linuxHome}/dsh-release-matrix-${runId}`
wsl(`mkdir -- ${sh(linuxCwd)}`)
const cwd = `\\\\wsl.localhost\\${distro}${linuxCwd.replaceAll('/', '\\')}`
writeFileSync(join(evidence, 'matrix-environment.json'), JSON.stringify({
  date: new Date().toISOString(), distro, user, kernel, kernelMajor, distroRow, cwd, runId, selectedRows: [...chosen],
}, null, 2))

let nativeSequence = 0
const native = async (command, { interactive = false, nativeLimit = 20_000, pty = false, keepStdinOpen = false } = {}) => {
  const script = `${linuxCwd}/.matrix-native-${++nativeSequence}.sh`
  wsl(`cat > ${sh(script)} <<'DSH_NATIVE_${runId}'\n${command}\nDSH_NATIVE_${runId}`)
  const started = Date.now()
  const timeout = String(Math.max(1, nativeLimit) / 1000)
  const bash = `bash ${interactive ? '-i ' : ''}${sh(script)}`
  const invocation = pty ? `script -q -e -c ${sh(bash)} /dev/null` : bash
  const launcher = `cd ${sh(linuxCwd)} && exec timeout --signal=TERM --kill-after=1s ${timeout}s ${invocation}`
  const proc = spawn('wsl.exe', [...wslPrefix, '--exec', 'bash', '-c', launcher], { windowsHide: true })
  const out = [], err = []
  proc.stdout.on('data', chunk => out.push(chunk))
  proc.stderr.on('data', chunk => err.push(chunk))
  if (!keepStdinOpen) proc.stdin.end()
  const stop = setTimeout(() => proc.kill(), nativeLimit + 3000)
  return await new Promise((res, rej) => {
    proc.on('error', rej)
    proc.on('close', (status, signal) => {
      clearTimeout(stop)
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err)
      res({
        command, status, signal, elapsedMs: Date.now() - started,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'),
      })
    })
  })
}

const equal = (a, b) => Buffer.from(a ?? '').equals(Buffer.from(b ?? ''))
const clean = text => (text ?? '').replace(/^(?:bash: cannot set terminal process group .*|bash: no job control in this shell)\r?\n/gm, '')
const rendered = call => JSON.stringify({ value: call?.value, result: call?.result, error: call?.error })
const stdout = call => call?.value?.stdout?.text ?? ''
const stderr = call => call?.value?.stderr?.text ?? ''
const notes = call => (call?.value?.notes ?? []).join('\n')
const exit = call => call?.value?.exitCode
const verdict = (ok, reason) => ({ verdict: ok ? 'MATCH' : 'DEFECT', reason })
const skip = reason => ({ verdict: 'SKIPPED', reason })
const parity = reason => ({ verdict: 'PARITY-NOT-DEFECT', reason })
const bytes = (p, n) => equal(stdout(p), n.stdout) && equal(stderr(p), clean(n.stderr)) && exit(p) === n.status
const rows = []
const tasks = new Map()
const register = (id, run, isolate = false) => tasks.set(id, { run, isolate })
const productBash = (session, command, args = {}, options = {}) =>
  session.call('bash', { command, description: 'Release matrix', ...args }, options)

const regular = (id, command, opts = {}) => register(id, async (session, record) => {
  if (opts.setup) opts.setup()
  const n = await native(command, opts.native)
  record.native.push(n)
  if (opts.restore) opts.restore()
  const p = await productBash(session, command, opts.args, opts.callOptions)
  record.product.push(p)
  return opts.judge ? opts.judge(p, n) : verdict(bytes(p, n), 'stdout, stderr and exit status must match')
}, opts.isolate)

// Priority cells whose historical evidence is incomplete.
regular('3.6', 'cmd.exe /c ver 2>&1 | head -2', {
  native: { interactive: true },
  judge: (p, n) => !bytes(p, n)
    ? verdict(false, 'Windows interop bytes/CRLF differ from native interactive bash')
    : /command not found/.test(n.stdout)
      ? parity('same-day native interactive PATH also lacks cmd.exe; Windows-version CRLF arm remains unmeasured')
      : verdict(/Microsoft Windows[^\r\n]*\r\n/i.test(n.stdout), 'native Windows-version CRLF was observed and matched'),
})
register('6.7', async (session, record) => {
  const command = 'read -t 2 x < /dev/tty; echo RC=$?'
  const n = await native(command, { nativeLimit: 7000, keepStdinOpen: true })
  record.native.push(n)
  const pty = await native(command, { nativeLimit: 7000, keepStdinOpen: true, pty: true })
  record.native.push(pty)
  const p = await productBash(session, command, { timeoutMs: 7000 }, { timeoutMs: 20_000 })
  record.product.push(p)
  const result = stdout(p).trim()
  const observed = (n.stdout + pty.stdout).split(/\r?\n/).filter(line => /^RC=\d+$/.test(line))
  return verdict(observed.includes(result) && /^RC=\d+$/.test(result) && !p.value?.timedOut
    && !/re-ran|re-run|twice/i.test(notes(p)), 'read keeps a real native Bash RC (piped or PTY arm) without a tool deadline or replay')
})
const repo10 = `${linuxCwd}/r101`
const commit = `git init -q ${sh(repo10)} && cd ${sh(repo10)} && git commit -q --allow-empty -m wip; git log --oneline | wc -l`
regular('10.1', commit, {
  isolate: true,
  setup: () => wsl(`git init -q ${sh(repo10)} && git -C ${sh(repo10)} config user.name "DSH release matrix" && git -C ${sh(repo10)} config user.email "matrix@example.invalid"`),
  restore: () => wsl(`git -C ${sh(repo10)} update-ref -d HEAD`),
  judge: (p, n) => {
    const actualCommits = wsl(`git -C ${sh(repo10)} rev-list --count HEAD`)
    return verdict(bytes(p, n) && n.stdout.trim() === '1' && actualCommits === '1', `native and product each create one commit; independently counted ${actualCommits}`)
  },
})
regular('10.3', 'npm exec --yes --package typescript -- tsc --version', {
  native: { nativeLimit: 150_000 },
  args: { timeoutMs: 150_000 },
  callOptions: { timeoutMs: 160_000 },
  judge: (p, n) => verdict(exit(p) === 0 && n.status === 0 && /^Version \d+\.\d+\.\d+/.test(n.stdout) && equal(stdout(p), n.stdout),
    'both invoke the compiler from the typescript package and return the same version'),
})
register('12.4', async (session, record) => {
  const passing = []
  for (const timeoutMs of [0, -1]) {
    const marker = sh(`${linuxCwd}/nonpositive-timeout-${timeoutMs}`)
    const p = await productBash(session, `touch ${marker}; printf "DEADLINE_OK\\n"`, { timeoutMs })
    record.product.push(p)
    const rejected = rendered(p).includes('timeoutMs must be a positive finite number')
      && wsl(`if test -e ${marker}; then printf exists; fi`) === ''
    const clamped = exit(p) === 0 && stdout(p).includes('DEADLINE_OK') && p.value?.timeoutMs > 0
    passing.push(rejected || clamped)
  }
  return verdict(passing.every(Boolean), 'both zero and negative timeouts must be rejected explicitly or reported as positive effective deadlines')
})
register('12.6', async (session, record) => {
  const marker = `${linuxCwd}/cancel-started`
  const done = `${linuxCwd}/cancel-completed`
  const command = `touch ${sh(marker)}; sleep 25; touch ${sh(done)}`
  let cancelled = false
  let cancelRequest
  const p = await productBash(session, command, { timeoutMs: 30_000 }, {
    timeoutMs: 35_000,
    onCall: () => {
      cancelRequest = (async () => {
        for (let tries = 0; tries < 20; tries++) {
          if (wsl(`if test -f ${sh(marker)}; then printf yes; fi`) === 'yes') {
            await session.controller.cancel({ sessionId: session.sessionId })
            cancelled = true
            return
          }
          await new Promise(r => setTimeout(r, 100))
        }
      })()
      return cancelRequest
    },
  })
  await cancelRequest
  record.product.push(p)
  const recovery = await productBash(session, 'printf "AFTER_CANCEL\\n"')
  record.product.push(recovery)
  const completed = wsl(`if test -f ${sh(done)}; then printf yes; fi`) === 'yes'
  return verdict(cancelled && !completed && /abort|cancel/i.test(rendered(p))
    && !/\[exit code:/.test(rendered(p)) && stdout(recovery).includes('AFTER_CANCEL'),
  'the real session was cancelled after the command started, never reached its final side effect, and handled the next tool call')
})

// Pure parity rows can use the same collector. Staged fixtures are private per run.
for (const [id, command] of [
  ['1.2', `bash -c 'echo out; echo err >&2; exit 3'`],
  ['1.3', 'set -o pipefail; (exit 3) | cat; echo CODE=$?'],
  ['1.4', 'false; echo STILL=$?'],
  ['1.5', 'echo hi | head -n1; echo PIPE=$?'],
  ['1.8', `bash -c 'trap "echo TR" EXIT; exit 7'`],
  ['2.1', `printf 'a\\x00b\\xff\\xfe' | wc -c`],
  ['2.2', `printf 'a\\x00b\\xff\\xfe' | od -An -tx1 | tr -d ' \\n'`],
  ['2.5', `printf '中文 \\r\\n CJK\\r' | od -c | head -3`],
  ['2.7', `printf 'x\\x1b[31mRED\\x1b[0m\\n'`],
  ['2.8', 'base64 <<< hello | base64 -d'],
  ['3.1', `wslpath -u 'C:\\Program Files\\node\\node.exe'`],
  ['3.2', `ls -ld "$(wslpath -u 'C:\\Program Files')"`],
  ['3.7', 'node.exe --version 2>&1 | head -1'],
  ['4.6', "find /usr -name '*.h' | wc -l"],
  ['5.2', 'sudo -n true 2>&1 | head -1; echo RC=$?'],
  ['5.3', 'id -u; whoami'],
  ['6.6', 'ssh -o BatchMode=yes localhost true 2>&1 | head -2'],
  ['8.4', 'f84(){ echo FN_OK; }; export -f f84; bash -c f84'],
  ['8.6', `IFS=: read a b <<< 'x:y'; echo "[$a][$b]"`],
  ['9.1', 'seq 1 200000 | wc -l'],
  ['9.2', 'seq 1 5000 | tail -40'],
  ['9.5', 'yes | head -c 100000 | wc -c'],
  ['10.7', 'systemctl is-system-running 2>&1 | head -1'],
  ['12.1', "grep -E '*' /etc/hostname"],
]) regular(id, command, { native: { interactive: id === '3.7' } })

register('12.2', async (session, record) => {
  const guard = 'if test -r /etc/shadow; then printf ACCESSIBLE; else printf INACCESSIBLE; fi'
  const [nativeGuard, productGuard] = await Promise.all([native(guard), productBash(session, guard)])
  record.native.push(nativeGuard)
  record.product.push(productGuard)
  if (nativeGuard.stdout !== 'INACCESSIBLE' || stdout(productGuard) !== 'INACCESSIBLE') {
    return skip('requires a Linux user that lacks read access to /etc/shadow in both arms')
  }
  const command = 'cat /etc/shadow 2>&1 | head -1'
  const [n, p] = await Promise.all([native(command), productBash(session, command)])
  record.native.push(n)
  record.product.push(p)
  return verdict(bytes(p, n) && /Permission denied/.test(n.stdout), 'native and product show permission denied')
})

const shellExit = (id, command, expected) => register(id, async (session, record) => {
  const n = await native(command)
  record.native.push(n)
  const p = await productBash(session, command)
  record.product.push(p)
  const next = await productBash(session, 'printf "NEXT_SHELL_OK\\n"')
  record.product.push(next)
  return verdict(n.status === expected && exit(p) === expected && equal(stdout(p), n.stdout)
    && equal(stderr(p), n.stderr) && /(?:ended|exited|terminat).*shell|shell.*(?:ended|exited|terminat)/i.test(notes(p))
    && stdout(next).includes('NEXT_SHELL_OK'), 'shell ending is disclosed and the next tool call starts a usable shell')
}, true)
shellExit('1.1', 'echo out; echo err >&2; exit 3', 3)
shellExit('1.6', 'exit 0', 0)
shellExit('7.5', 'exec bash --norc', 0)
shellExit('8.5', 'set -e; false; echo NEVER', 1)

regular('1.7', "sh -c 'echo A; kill -9 $$'; echo K=$?", {
  judge: (p, n) => verdict(equal(stdout(p), n.stdout) && exit(p) === n.status && /^A\nK=137/m.test(n.stdout)
    && /Killed/.test(stderr(p)) && /Killed/.test(n.stderr), 'both report SIGKILL of the child and preserve the session'),
})

const fixture = (name, body = '') => wsl(`printf '%s' ${sh(body)} > ${sh(`${linuxCwd}/${name}`)}`)
regular('2.3', "find . -name '*.txt' -print0 | xargs -0 grep -l alpha", {
  setup: () => { fixture('one.txt', 'alpha\n'); fixture('with spaces.txt', 'alpha\n'); fixture('other.txt', 'beta\n') },
  judge: (p, n) => verdict(bytes(p, n) && n.stdout.includes('./with spaces.txt'), 'NUL-separated filenames with spaces reach grep intact'),
})
regular('2.4', 'git ls-files -z | head -c 40 | cat -v', {
  setup: () => {
    fixture('one.txt', 'alpha\n')
    fixture('with spaces.txt', 'alpha\n')
    wsl(`git -C ${sh(linuxCwd)} init -q && git -C ${sh(linuxCwd)} add one.txt "with spaces.txt"`)
  },
  judge: (p, n) => verdict(bytes(p, n) && n.stdout.includes('^@'), 'git’s NUL-separated names are rendered identically'),
})
regular('2.6', 'LC_ALL=zh_CN.UTF-8 date 2>/dev/null | head -1', {
  judge: (p, n) => !/zh_CN\.utf-?8/i.test(wsl('locale -a'))
    ? skip('native distribution has no zh_CN.UTF-8 locale')
    : verdict(exit(p) === n.status && stdout(p).replace(/\d\d:\d\d:\d\d/g, '<clock>') === n.stdout.replace(/\d\d:\d\d:\d\d/g, '<clock>'),
      'localized date format agrees aside from sampling time'),
})
regular('3.3', 'cd /mnt/d && pwd && ls | head -3', { isolate: true })
regular('3.4', `mkdir -p ${sh(`${linuxCwd}/带 空格 与中文 目录`)} && ls -d ${sh(linuxCwd)}/带*`)
regular('3.5', `printf 'x\\n' > ${sh(linuxCwd)}/"nl$(printf '\\n')file" && ls ${sh(linuxCwd)} | grep -c nl`)
register('3.8', async (session, record) => {
  if (!disposableWindows) return skip('requires a disposable Windows runner to inspect recycle directory entries')
  const command = 'ls /mnt/c/\\$Recycle.Bin 2>&1 | head -2'
  const [n, p] = await Promise.all([native(command), productBash(session, command)])
  record.native.push(n)
  record.product.push(p)
  return verdict(bytes(p, n), 'recycle-bin access or refusal matches the same Windows runner')
})
const link = sh(`${linuxCwd}/l41`)
regular('4.1', `ln -s /etc/hostname ${link} && readlink -f ${link} && cat ${link}`, {
  restore: () => wsl(`test -L ${link} && unlink ${link}`),
  judge: (p, n) => verdict(bytes(p, n) && n.stdout.startsWith('/etc/hostname\n'), 'WSL resolves and reads the Linux symlink'),
})
regular('4.2', `ls -l ${link} && readlink -f ${link}`, {
  setup: () => wsl(`test -L ${link} || ln -s /etc/hostname ${link}`),
  judge: (p, n) => verdict(bytes(p, n) && n.stdout.endsWith('/etc/hostname\n'), 'workspace symlink survives listing and resolves in Linux'),
})
const vanished = sh(`${linuxCwd}/d43/a/b`)
regular('4.3', `mkdir -p ${vanished}/c && (cd ${vanished} && rmdir ${vanished}/c ${vanished} && pwd)`)
const denied = process.env.DSH_MATRIX_DENIED_PATH
register('4.4', async (session, record) => {
  if (!denied?.startsWith('/mnt/c/') || !denied.includes('dsh-matrix-denied-')) {
    return skip('requires an intentionally ACL-denied Windows scratch directory under /mnt/c')
  }
  const command = `touch ${sh(`${denied}/x`)} 2>&1 | head -1`
  const n = await native(command)
  const p = await productBash(session, command)
  record.native.push(n)
  record.product.push(p)
  return verdict(bytes(p, n) && /Permission denied|Operation not permitted/.test(n.stdout), 'both report the same Windows ACL denial for the isolated DrvFS fixture')
})
register('4.5', async (session, record) => {
  if (!disposableWindows) return skip('requires a disposable Windows runner for the Windows users directory scan')
  const command = 'du -sh /mnt/c/Users'
  const [n, p] = await Promise.all([native(command, { nativeLimit: 5000 }), productBash(session, command, { timeoutMs: 1500 })])
  record.native.push(n)
  record.product.push(p)
  return n.status === 124 && p.value?.timedOut
    ? parity('native scan also exceeds the observation budget and the product reports its own timeout')
    : verdict(bytes(p, n), 'must answer like native or clearly report a deadline during a native-slow scan')
})
const bigFile = sh(`${linuxCwd}/f47`)
regular('4.7', `dd if=/dev/zero of=${bigFile} bs=1M count=64 status=none && wc -c < ${bigFile} && rm ${bigFile}`)
regular('5.1', 'sudo true; echo SUDO_CODE=$?', {
  args: { timeoutMs: 15_000 },
  judge: (p, n) => verdict(equal(stdout(p).match(/SUDO_CODE=\d+/)?.[0], n.stdout.match(/SUDO_CODE=\d+/)?.[0])
    && /SUDO_CODE=\d+/.test(n.stdout) && !p.value?.timedOut
    && (!/password/i.test(n.stderr) || /password/i.test(rendered(p))),
  'sudo reports its own result without hanging for a password'),
})
regular('5.4', `su - -c 'echo SU_OK' 2>&1 | head -2`)
const permission = sh(`${linuxCwd}/f55`)
regular('5.5', `chmod 000 ${permission} 2>/dev/null; ls -l ${permission}; cat ${permission} 2>&1 | head -1`, {
  setup: () => fixture('f55', 'permission test only\n'),
  judge: (p, n) => verdict(bytes(p, n) && (rootArm || /Permission denied/.test(n.stdout)), 'Linux permission diagnostics match native'),
})
register('5.6', async (session, record) => {
  if (!rootArm) return skip('this matrix row runs as a separate DSH_WSL_USER=root arm')
  const p = await productBash(session, 'id -u; whoami')
  const n = await native('id -u; whoami')
  record.product.push(p)
  record.native.push(n)
  return verdict(bytes(p, n) && n.stdout === '0\nroot\n', 'root arm has root provenance; separately run the required G1, G2 and G4 rows in this arm')
})

regular('6.1', `sh -c 'read x < /dev/tty; echo GOT=$?'`, {
  args: { timeoutMs: 12_000 },
  judge: (p, n) => verdict(!p.value?.timedOut && /GOT=\d+/.test(stdout(p) + stderr(p)) && /GOT=\d+/.test(n.stdout)
    && /twice|re-ran|re-run/i.test(notes(p)), 'product reports the PTY retry rather than concealing repeated side effects'),
})
regular('6.2', 'git log --oneline -n 5', {
  setup: () => wsl(`git -C ${sh(linuxCwd)} init -q && git -C ${sh(linuxCwd)} -c user.name=Matrix -c user.email=matrix@example.invalid commit -q --allow-empty -m pager-fixture`),
  judge: (p, n) => verdict(bytes(p, n) && !/twice|re-ran|re-run/i.test(notes(p)), 'piped git log matches native and does not trigger automatic PTY promotion'),
})
regular('6.3', `vim -c 'q' /tmp/x 2>&1 | head -2`, {
  judge: (p, n) => /command not found/.test(n.stdout) ? skip('vim is absent') : verdict(bytes(p, n), 'vim’s piped warning is identical'),
})
regular('6.4', 'top -bn1 | head -3', {
  judge: (p, n) => verdict(exit(p) === n.status && /^top - /m.test(n.stdout) && /^top - /m.test(stdout(p))
    && !/twice|re-ran|re-run/i.test(notes(p)), 'both return a top snapshot without promoting a noninteractive command'),
})
regular('6.5', 'timeout 3 cat', {
  native: { keepStdinOpen: true },
  judge: (p, n) => verdict(exit(p) === n.status && exit(p) === 124 && !p.value?.timedOut && !notes(p).includes('timed out'),
    'the timeout command owns the deadline and returns 124'),
})
regular('6.8', 'stty -a | head -2', {
  judge: (p, n) => bytes(p, n) && /ioctl/i.test(n.stderr)
    ? parity('native pipeline also lacks a controlling terminal for stty')
    : verdict(false, 'stty’s native non-terminal failure must be preserved'),
})
register('6.9', async (session, record) => {
  for (const args of [{ action: 'open' }, { action: 'send', text: 'printf "TERM_21\\n"' }, { action: 'read' }, { action: 'close' }]) {
    record.product.push(await session.call('wsl_terminal', args))
  }
  const [open, send, read] = record.product
  return verdict(/terminal .*open/i.test(rendered(open)) && rendered(send).includes('TERM_21')
    && /(?:\\n|\r|\n)TERM_21/.test(rendered(read)), 'open, send and read are distinct tool calls and the retained screen contains the actual output')
}, true)

const sleepName = `sleep 40 dsh-matrix-${runId}`
const targetedSleep = () => wsl(`(exec -a ${sh(sleepName)} sleep 40) </dev/null >/dev/null 2>&1 &`)
regular('7.1', `pkill -f ${sh(sleepName)}; echo RC=$?`, {
  setup: targetedSleep,
  restore: targetedSleep,
  judge: (p, n) => verdict(bytes(p, n) && n.stdout === 'RC=0\n', 'pkill reaches only the uniquely named fixture process, leaving the active shell alive'),
})
register('7.2', async (session, record) => {
  const command = `setsid --wait bash -c 'kill -INT -- -$$'`
  const n = await native(command)
  const p = await productBash(session, command)
  const alive = await productBash(session, 'printf "SIGINT_SESSION_OK\\n"')
  record.native.push(n)
  record.product.push(p, alive)
  return verdict(bytes(p, n) && n.status === 130 && stdout(alive).includes('SIGINT_SESSION_OK'),
    'SIGINT affects the dedicated subprocess group and leaves the product shell alive')
}, true)
const detached = '(setsid sleep 37 </dev/null >/dev/null 2>&1 & disown); echo DETACHED=$!'
regular('7.3', detached, {
  judge: (p, n) => verdict(bytes(p, n) && /^DETACHED=\d*\n$/.test(n.stdout), 'detaching a subshell job reports the same parent-shell job id semantics'),
  isolate: true,
})
register('7.4', async (session, record) => {
  const command = 'jobs -l | wc -l'
  const n = await native(`${detached}\n${command}`)
  const first = await productBash(session, detached)
  const next = await productBash(session, command)
  record.native.push(n)
  record.product.push(first, next)
  return verdict(equal(stdout(first) + stdout(next), n.stdout) && stdout(next).trim() === '0', 'detached job does not remain in the parent shell job table')
}, true)
regular('7.6', `nohup sleep 5 > ${sh(`${linuxCwd}/n76.log`)} 2>&1 & sleep 6; cat ${sh(`${linuxCwd}/n76.log`)}`, {
  judge: (p, n) => verdict(bytes(p, n) && n.stdout === '' && wsl(`test -f ${sh(`${linuxCwd}/n76.log`)} && printf yes`) === 'yes',
    'nohup creates the fixture and neither side invents output'),
})

const statePair = (id, commands, judge, nativeOptions) => register(id, async (session, record) => {
  const n = await native(commands.join('\n'), nativeOptions)
  record.native.push(n)
  for (const command of commands) record.product.push(await productBash(session, command))
  return judge(record.product, n)
}, true)
statePair('8.1', ['cd /tmp && export V81=kept && pwd', 'pwd; echo V81=$V81'], (p, n) => verdict(
  equal(p.map(stdout).join(''), n.stdout) && n.stdout.endsWith('V81=kept\n'), 'cwd and exported variables persist in the same session'))
statePair('8.2', ["alias zzz='echo ALIAS_OK'; zzz"], (p, n) => bytes(p[0], n)
  ? parity('native interactive bash also does not expand a newly defined alias on the same line')
  : verdict(exit(p[0]) === 127 && n.status === 127 && /not found/.test(stderr(p[0])) && /not found/.test(n.stderr), 'same-line alias fails with the same bash status'), { interactive: true })
statePair('8.3', ["alias yyy='echo YYY_OK'", 'yyy'], (p, n) => verdict(
  equal(p.map(stdout).join(''), n.stdout) && n.stdout === 'YYY_OK\n', 'alias is effective in a later call'), { interactive: true })
regular('8.7', "echo '!历史' ; echo 1!2", {
  judge: (p, n) => verdict(bytes(p, n) && !/event not found/.test(rendered(p)), 'literal exclamation marks survive the tool shell'),
})
register('8.8', async (session, record) => {
  const peer = await session.newSession(cwd, 'wsl-standard')
  const dirs = [`${linuxCwd}/owner-a`, `${linuxCwd}/owner-b`]
  wsl(`mkdir ${dirs.map(sh).join(' ')}`)
  const peers = [session, peer]
  const commands = dirs.map(dir => `cd ${sh(dir)}`)
  record.product.push(...await Promise.all(commands.map((command, index) => productBash(peers[index], command))))
  const p = await Promise.all(peers.map(owner => productBash(owner, 'pwd')))
  record.product.push(...p)
  record.native.push(...await Promise.all(commands.map(command => native(`${command}\npwd`))))
  return verdict(p.every((call, index) => bytes(call, record.native[index]) && stdout(call).trim() === dirs[index]),
    'two concurrent Agent sessions keep independent directories')
})

regular('9.4', `python3 -c "print('x'*300000)"`, {
  judge: (p, n) => /command not found/.test(n.stderr) ? skip('python3 is absent') : verdict(
    exit(p) === n.status && n.stdout.length === 300001 && /^x+$/.test(stdout(p).trim()) && p.value?.stdout?.truncated === true,
    'large one-line output is marked truncated and contains only the expected bytes'),
})
regular('9.6', 'echo BEFORE; sleep 6; echo AFTER', {
  native: { nativeLimit: 10_000 },
  args: { timeoutMs: 1500 },
  judge: (p, n) => verdict(n.stdout === 'BEFORE\nAFTER\n' && stdout(p).includes('BEFORE') && !stdout(p).includes('AFTER')
    && p.value?.timedOut && /run_in_background|bash_background/.test(rendered(p)),
  'product stops at its declared deadline, retains the early bytes and names the background option'),
})

const spillBytes = path => {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^dsh-subprocess-.*-(?:stdout|stderr)\.log$/.test(basename(path))) {
    throw new Error('result does not name a valid process spill file')
  }
  const withinTemp = relative(resolve(tmpdir()), resolve(path))
  if (withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('result names a path outside the test process temporary directory')
  return readFileSync(path)
}
const runSpill = (id, command, stream, expectedLines, checkPointer = false) => register(id, async (session, record) => {
  const n = await native(command)
  const p = await productBash(session, command)
  record.native.push(n)
  record.product.push(p)
  const resultStream = p.value?.[stream]
  const entire = spillBytes(resultStream?.spillPath)
  const ref = Buffer.from(n[`${stream}Base64`], 'base64')
  const lines = entire.toString('utf8').trimEnd().split('\n')
  const complete = n.status === 0 && exit(p) === 0 && resultStream?.truncated && entire.equals(ref)
    && lines.length === expectedLines && lines[0] === '1' && lines.at(-1) === String(expectedLines)
  const text = rendered(p)
  const honestPointer = !checkPointer || /path above holds the whole stream/i.test(text)
  const namedStream = stream === 'stdout' || /stderr truncated/i.test(text)
  return verdict(complete && honestPointer && namedStream, `the ${stream} spill contains all ${expectedLines} lines and the product labels the complete output`)
})
runSpill('9.3', 'seq 1 200000', 'stdout', 200000)
runSpill('9.7', 'seq 1 200000 >&2', 'stderr', 200000)
runSpill('9.8', 'seq 1 250000', 'stdout', 250000, true)
regular('10.2', `npm install --no-audit --prefix ${sh(`${linuxCwd}/r102`)} js-yaml 2>&1 | tail -3`, {
  restore: () => wsl(`mv -- ${sh(`${linuxCwd}/r102`)} ${sh(`${linuxCwd}/r102-native`)}`),
  native: { nativeLimit: 150_000 },
  args: { timeoutMs: 150_000 },
  callOptions: { timeoutMs: 160_000 },
  judge: (p, n) => verdict(exit(p) === n.status && !p.value?.timedOut && !stdout(p).includes('\x1b')
    && /packages?/i.test(n.stdout) && /packages?/i.test(stdout(p)), 'same package installation finishes and the result is free of ANSI progress noise'),
})
const venv = sh(`${linuxCwd}/r104`)
regular('10.4', `python3 -m venv ${venv} && source ${venv}/bin/activate && which python`, {
  isolate: true,
  judge: (p, n) => /ensurepip|not found/.test(n.stderr + n.stdout)
    ? skip('native Python venv support is absent') : verdict(bytes(p, n), 'venv activation resolves the same Python'),
})
register('10.5', async (session, record) => {
  if (!wsl('command -v python3 || :') || !wsl('command -v curl || :')) return skip('requires python3 and curl')
  const portFile = sh(`${linuxCwd}/http-port`)
  const serverFile = sh(`${linuxCwd}/http-server.py`)
  const program = [
    'import sys,time',
    'from http.server import BaseHTTPRequestHandler,HTTPServer',
    'class Handler(BaseHTTPRequestHandler):',
    '  def do_GET(self):',
    '    self.send_response(200)',
    '    self.end_headers()',
    '    for i in range(8):',
    '      self.wfile.write(b"0123456789")',
    '      self.wfile.flush()',
    '      time.sleep(0.3)',
    'with HTTPServer(("127.0.0.1",0),Handler) as server:',
    '  with open(sys.argv[1],"w") as file: file.write(str(server.server_port))',
    '  server.serve_forever()',
  ].join('\n')
  fixture('http-server.py', program)
  const pid = wsl(`python3 ${serverFile} ${portFile} </dev/null >/dev/null 2>&1 &\nprintf '%s' "$!"`)
  try {
    const port = wsl(`for i in {1..30}; do if test -s ${portFile}; then cat ${portFile}; exit; fi; sleep 0.1; done; exit 1`)
    if (!/^\d+$/.test(port)) throw new Error('loopback streaming fixture did not publish a port')
    const command = `curl -sS -N --max-time 4 http://127.0.0.1:${port}/ | wc -c`
    const n = await native(command)
    const p = await productBash(session, command, { timeoutMs: 8000 })
    record.native.push(n)
    record.product.push(p)
    return verdict(bytes(p, n) && n.stdout === '80\n' && !/re-run|twice/i.test(notes(p)),
      'local loopback stream transfers every byte and is never mistaken for a keyboard wait')
  } finally {
    if (/^\d+$/.test(pid)) wsl(`if grep -Fq -- ${serverFile} /proc/${pid}/cmdline 2>/dev/null; then kill ${pid}; fi`)
  }
})
regular('10.6', 'docker run --rm alpine echo DOCKER_OK 2>&1 | head -2', {
  judge: (p, n) => /not found|could not be found|Cannot connect/i.test(n.stdout)
    ? skip('native Docker CLI or daemon is absent') : verdict(bytes(p, n) && n.stdout.includes('DOCKER_OK'), 'Docker returns the same container output'),
})
regular('10.8', 'make -C /tmp 2>&1 | head -2', {
  judge: (p, n) => /command not found/.test(n.stdout) ? skip('make is absent') : verdict(bytes(p, n), 'make reports the same directory result'),
})
regular('11.1', 'sleep 2 & p=$!; cat "/proc/$p/wchan"; wait "$p"', {
  judge: (p, n) => verdict(bytes(p, n) && (kernelMajor !== 1 || n.stdout.trim() === 'not-reported'),
    'kernel-specific wait position is recorded and raw WSL1 absence is preserved'),
})
runSpill('11.2', 'seq 1 200000', 'stdout', 200000)
regular('11.3', 'uname -r', {
  judge: (p, n) => verdict(bytes(p, n) && n.stdout.trim() === kernel && [1, 2].includes(kernelMajor), 'session and native kernel agree, and the Windows distribution table identifies WSL1/WSL2'),
})
register('11.4', async (_session, record) => {
  if (kernelMajor !== 1) return skip('WSL1-only deadline row')
  const required = ['1.1', '1.6', '6.7', '9.6']
  record.basis = Object.fromEntries(required.map(id => [id, rows.find(row => row.id === id)?.verdict ?? 'unrun']))
  return verdict(Object.values(record.basis).every(v => v === 'MATCH'), 'WSL1 release candidate passes G1/G6/G9 session ending, timed read and timeout checks')
})
register('12.3', async (session, record) => {
  const marker = sh(`${linuxCwd}/stdin-must-not-run`)
  const p = await productBash(session, `touch ${marker}`, { stdin: 'x'.repeat(32 * 1024 + 1) })
  record.product.push(p)
  return verdict(/stdin.*(?:bytes|large|KiB|cap)/i.test(rendered(p)) && wsl(`if test -e ${marker}; then printf exists; fi`) === '',
    'oversize stdin is refused by name before executing the command')
})
register('12.5', async (session, record) => {
  const command = 'bash -c "exit 42"'
  const n = await native(command)
  record.native.push(n)
  for (let count = 0; count < 3; count++) record.product.push(await productBash(session, command))
  return verdict(record.product.every(p => exit(p) === n.status) && /(?:3|three).*fail|fail.*(?:3|three)/i.test(notes(record.product[2])),
    'all three calls execute and the third reports the failure streak')
})
register('12.7', async (session, record) => {
  const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lO0AAAAASUVORK5CYII='
  const linuxPath = `${linuxCwd}/matrix.png`
  const windowsCwd = join(evidence, 'windows-control')
  mkdirSync(windowsCwd, { recursive: true })
  writeFileSync(join(windowsCwd, 'matrix.png'), Buffer.from(fixturePng, 'base64'))
  wsl(`printf %s ${sh(fixturePng)} | base64 -d > ${sh(linuxPath)}`)
  const image = await session.call('read_image', { file_path: linuxPath })
  const control = await session.newSession(windowsCwd, 'standard')
  const other = await control.call('read_image', { file_path: join(windowsCwd, 'matrix.png') })
  record.product.push(image, other)
  return verdict([image, other].every(p => p.value?.image?.mediaType === 'image/png'
    && p.value.image.width === 1 && p.value.image.height === 1 && /"type":"image"/.test(rendered(p))),
  'WSL and host control each pass host output validation and render the same fixture as an image block')
})
register('12.8', async (session, record) => {
  const ptc = await session.newSession(cwd, 'wsl-ptc')
  if (typeof ptc.setSandboxMode !== 'function') return skip('driver does not expose the isolated session sandbox mode')
  const args = { code: 'return 1;', description: 'Release matrix' }
  for (const mode of ['workspace-write', 'read-only', 'danger-full-access']) {
    await ptc.setSandboxMode(mode)
    record.product.push(await ptc.call('run_code', args))
  }
  const [denial, readOnly, full] = record.product
  return verdict(/run_code cannot start in this session/.test(rendered(denial))
    && /read-only/.test(rendered(denial)) && /danger-full-access/.test(rendered(denial))
    && readOnly.value?.result === 1 && full.value?.result === 1,
  'workspace-write has the WSL 9P guard, and read-only/full-access preserve real successful code execution')
})

const required = ['3.6', '6.7', '10.1', '10.3', '12.4', '12.6']
const selected = (chosen.has('implemented')
  ? [...new Set([...required, ...tasks.keys()])].sort((a, b) => Number(a) - Number(b))
  : [...chosen]).filter(id => !excluded.has(id))
for (const id of selected) if (!tasks.has(id)) throw new Error(`Matrix row ${id} has no scripted implementation`)

await withReleaseSession({ cwd, evidenceDir: join(evidence, 'product') }, async session => {
  for (const id of selected) {
    const record = { id, product: [], native: [] }
    try {
      const task = tasks.get(id)
      const active = task.isolate ? await session.newSession(cwd, 'wsl-standard') : session
      if ((rootArm || user === 'root') && ['5.1', '5.2', '5.4', '12.2'].includes(id)) {
        Object.assign(record, skip('requires an ordinary test account'))
      } else {
        Object.assign(record, await task.run(active, record))
      }
    } catch (error) {
      Object.assign(record, { verdict: 'DEFECT', reason: `probe failed: ${error?.message ?? error}` })
    }
    rows.push(record)
    appendFileSync(rowsPath, JSON.stringify(record) + '\n')
    console.log(`${id} ${record.verdict}: ${record.reason}`)
  }
})
const totals = Object.fromEntries([...new Set(rows.map(row => row.verdict))].map(name => [name, rows.filter(row => row.verdict === name).length]))
writeFileSync(join(evidence, 'matrix-summary.json'), JSON.stringify({
  distro, user, kernel, kernelMajor, totals,
  excludedRows: [...excluded],
  rowsNotSelected: [...tasks.keys()].filter(id => !selected.includes(id)),
  skippedRows: rows.filter(row => row.verdict === 'SKIPPED').map(({ id, reason }) => ({ id, reason })),
}, null, 2))
if (totals.DEFECT) process.exitCode = 1
