// Real-WSL gate for the readiness contract when the distribution's login pass rewrites it.
//
// Why this exists next to `conpty-relay.mjs`. That driver proves the contract reaches the wire on the
// distro the runner happens to ship, and every distro we have run it on (this machine's Ubuntu 22.04,
// CI's Ubuntu-24.04) leaves `PROMPT_COMMAND` alone — which is how the claim "the profile chain does
// not undo it" got written from one measurement. A distribution shipping
// `/etc/profile.d/80-systemd-osc-context.sh` does undo it: that file runs `PROMPT_COMMAND+=(…)`, bash
// refuses to export an array, and the interactive shell the relay `exec`s inherits no contract at all
// (measured by the outside report on 2026-10-06: the marker never reached the wire, so `wsl_terminal`
// paid its quiet window on every keystroke and the `DSH_WSL_PTY_SHELL=1` tier never settled).
//
// This gate makes the case *independent of the distro* by installing the clobber itself, through
// `BASH_ENV` named in `WSLENV`: a login shell sources that file and an interactive one does not, so it
// lands in exactly the pass the real profile script would. Nothing is written to a home directory or
// to `/etc`, and the scratch is removed in a `finally`.
//
// All three arms drive the same shipped relay, so they share its start-up, its stdin path and its
// plane. The control differs from the product by exactly one mechanism: the copy key the relay
// re-asserts from is held back, which is what the pre-fix relay did.
//
//   DSH_WSL_TEST_PLANE=src node --experimental-strip-types scripts/compatibility/relay-profile-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/relay-profile-real.mjs
//
// 1. control  — hostile profile, no copy across → the shell answers, the marker never appears;
// 2. product  — hostile profile, the shipped relay → marker *and* the controlled prompt reach the wire;
// 3. boundary — host injected no contract at all  → the shell answers and no marker is invented.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { resolvePath } from './plane.mjs'

const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu'
const user = process.env.WSL_COMPAT_USER || 'root'
/** The Linux-side scratch this gate owns: the profile script and the directory the shells start in. */
const root = process.env.WSL_COMPAT_ROOT || '/tmp/dsh-wsl-compat'
const profile = `${root}/dsh-hostile-profile.sh`
const startDir = `${root}/relay-profile-ws`
// The subject is the relay itself, on the plane the run names: `lib` here means the shipped
// `lib/wsl-relay.js` carried the contract through a login pass that rewrites it.
const relay = resolvePath('relay')
const node = process.execPath
/** The contract values come from this repo's own source, so the fixture cannot drift from the product. */
const { CONTROLLED_PROMPT, READINESS_COPY_KEY, readinessContract, readinessReassertion } = await import('../../src/shared/wsl-env.ts')
const contract = readinessContract()
const probeLine = 'echo PROFILE_GATE_$(( 6 * 7 ))'

/** Run the shipped relay in the distribution, feeding it the probe the way the host would. */
function driveRelay(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['--experimental-strip-types', relay], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString() })
    child.stderr.on('data', (chunk) => { err += chunk.toString() })
    const exited = new Promise(resolve2 => child.on('exit', code => resolve2(code)))
    child.on('error', reject)
    // Fed after the login pass has run, and ended by closing stdin — the shape `relay-real.mjs` uses.
    setTimeout(() => child.stdin.write(`${probeLine}\n`), 2_500)
    setTimeout(() => child.stdin.write('exit\n'), 4_000)
    setTimeout(() => child.stdin.end(), 4_500)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`relay did not exit in 40 s; out=${out.slice(0, 240)} err=${err.slice(0, 240)}`)) }, 40_000)
    exited.then(code => {
      clearTimeout(timer)
      resolve({ out, err, code })
    })
  })
}

/**
 * The environment of one arm: the distribution's own login files, plus the clobber, plus (or not) the
 * host's contract, plus (or not) the copy the relay re-asserts from.
 */
function bridged({ withContract = true, withCopy = true } = {}) {
  const env = { ...process.env, BASH_ENV: profile, WSLENV: 'BASH_ENV', DSH_WSL_DISTRO: distro }
  if (!withContract) return env
  env.PROMPT_COMMAND = contract.PROMPT_COMMAND
  env.PS1 = contract.PS1
  env.WSLENV = 'BASH_ENV:PROMPT_COMMAND:PS1'
  if (withCopy) {
    env[READINESS_COPY_KEY] = contract.PROMPT_COMMAND
    env.WSLENV = `${env.WSLENV}:${READINESS_COPY_KEY}`
  } else {
    // Held back, not merely absent: an empty value is a name `bridgeReadiness` will not mirror or
    // publish, which is exactly the state the relay was in before the fix.
    env[READINESS_COPY_KEY] = ''
  }
  return env
}

/** Lay the fixture: the array promotion a systemd-provided profile script performs. */
function writeProfile() {
  const r = spawnSync('wsl.exe', ['-d', distro, '-u', user, '-e', 'bash', '-c',
    `mkdir -p '${startDir}' && printf '%s\\n' 'PROMPT_COMMAND+=(__dsh_gate_sim)' > '${profile}'`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cannot lay the fixture: ${(r.stderr ?? '').slice(0, 200)}`)
}

assert.ok(readinessReassertion().includes(READINESS_COPY_KEY),
  'the relay re-asserts from the same key this driver bridges — if that changed, arm 2 proves nothing')
writeProfile()
try {
  // 1. The control. If this arm ever *delivers* the marker, the clobber is not reaching the login pass
  //    and arms 2-3 would be passing for the wrong reason.
  const before = await driveRelay(bridged({ withCopy: false }))
  assert.match(before.out, /PROFILE_GATE_42/, `the control shell must still work: ${JSON.stringify(before.out.slice(0, 240))}`)
  assert.ok(!/133;D;/.test(`${before.out}${before.err}`),
    'RED — the fixture is inert: the contract survived the login pass without the copy key, so this '
    + 'gate cannot see the defect it exists for')

  // 2. The shipped relay, same hostile profile: the marker and the controlled prompt have to reach the
  //    wire, because that pair is what the host's completion check compares.
  const after = await driveRelay(bridged())
  assert.match(after.out, /PROFILE_GATE_42/, `the relay shell must answer: ${JSON.stringify(after.out.slice(0, 240))}`)
  // The prompt and the marker are written by `PROMPT_COMMAND`, and an interactive bash whose stdin is a
  // pipe puts its prompt on stderr — so the wire is both streams together, exactly what the host's PTY
  // backend sees when the relay's stdio *is* the PTY.
  const wire = `${after.out}${after.err}`
  assert.match(wire, /133;D;/,
    `the readiness marker did not survive the login pass: ${JSON.stringify(wire.slice(0, 240))}`)
  assert.ok(wire.includes(CONTROLLED_PROMPT.trim()),
    `the controlled prompt is missing: ${JSON.stringify(wire.slice(-240))}`)

  // 3. A host that injects no contract: the re-assertion must be inert, not inventive.
  const bare = await driveRelay(bridged({ withContract: false }))
  assert.match(bare.out, /PROFILE_GATE_42/, `a contract-free host still needs a working shell: ${JSON.stringify(bare.out.slice(0, 240))}`)
  assert.ok(!/133;D;/.test(`${bare.out}${bare.err}`), 'the relay must not invent a marker the host never injected')

  console.log(`relay-profile-real: GREEN — with a distribution that turns PROMPT_COMMAND into an array, the `
    + `contract is lost without the copy (control: no marker on the wire), carried through by the shipped `
    + `relay (marker + ${JSON.stringify(CONTROLLED_PROMPT)}), and not invented when the host injects none `
    + `(plane=${process.env.DSH_WSL_TEST_PLANE}, distro=${distro}, user=${user})`)
} finally {
  spawnSync('wsl.exe', ['-d', distro, '-u', user, '-e', 'bash', '-c',
    `rm -f -- '${profile}'; rmdir -- '${startDir}' 2>/dev/null; true`])
}
