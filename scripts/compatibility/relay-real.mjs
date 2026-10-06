// Real-WSL regression for the persistent-shell relay: the process the host PTY
// backend spawns must hand a stateful WSL shell its stdio, start in the
// session's directory, and resolve the distribution from the cwd/env.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolvePath } from './plane.mjs';

// The relay is spawned by path rather than imported, so the plane is chosen through the same
// table the other drivers use (scripts/compatibility/plane.mjs) and the run prints the line
// verify-plane-log.mjs checks: `lib` here means the shipped lib/wsl-relay.js answered the PTY.
const relay = resolvePath('relay');
const node = process.execPath;
const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu';
const user = process.env.WSL_COMPAT_USER || 'mille';
const workspace = process.env.WSL_COMPAT_RELAY_CWD || '\\\\wsl.localhost\\Ubuntu\\home\\mille\\symprobe\\ws';
/**
 * The Linux path of a `\\wsl.localhost\<distro>\…` spelling (as in skills-real).
 *
 * Both slash spellings are accepted because the Windows side resolves either — `//wsl.localhost/…`
 * is what a bash-driven invocation ends up passing when its own quoting keeps backslashes — and the
 * driver's assertions should not depend on which one the caller typed.
 */
const linuxOf = unc => `/${unc.replace(/^[/\\]+wsl[.]localhost[/\\][^/\\]+[/\\]?/, '').replaceAll('\\', '/')}`;
const reEsc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The premise every spawn here depends on: the distribution's 9P share is answering *for this
 * driver's own directory*, and if it is not, the driver makes the directory and asks again.
 *
 * The keeper did not carry this premise. On the WSL2 frame both `/tmp/dsh-wsl-relay-ws` (the cwd this
 * driver spawns into) and `/tmp/dsh-wsl-compat` were gone at postflight while `wsl -l -v` still said
 * `Running`, and the job's setup step had created them an hour earlier — so a directory created by a
 * step is not a premise a later pass may assume. Two shapes follow from that: the second (lib-plane)
 * pass used to die with `spawn C:\…\node.exe ENOENT`, Windows reporting an unreachable `cwd` as a
 * missing interpreter, and any pass could die on a share that has not finished mounting.
 *
 * So the driver asks for what it is about to use, and says which of the two answers it got. A red from
 * here is an environment verdict, never a product one, and it is stated as such.
 */
function ensureShare() {
  if (existsSync(workspace)) return 'already-mounted'
  const linux = linuxOf(workspace)
  // The path comes from the workflow's own env, but it is about to be quoted into a `bash -c`, so it
  // is checked rather than trusted: no quotes, no globs, no semicolons.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(linux)) throw new Error(`relay-real: RED — refusing the fixture path ${workspace} (its Linux spelling ${linux} is not a plain absolute path)`)
  const made = spawnSync('wsl.exe', ['-d', distro, '-u', user, '--', 'bash', '-c', `mkdir -p -- '${linux}' && echo DSH_MADE`],
    { encoding: 'utf8', timeout: 30_000 })
  const out = `${made.stdout ?? ''}${made.stderr ?? ''}`
  for (let tryToWait = 0; tryToWait < 10; tryToWait += 1) {
    if (existsSync(workspace)) return made.status === 0 ? `created-on-demand (${out.trim().slice(0, 20)})` : `mounted without the driver's mkdir answering (rc=${made.status})`
    // A bounded wait in a synchronous place: `existsSync` on a 9P path can hang, so this cannot be an
    // await, and a loop with no sleep would hammer the redirector instead of giving it time.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
  }
  throw new Error(`relay-real: RED — the 9P share at ${workspace} is not answering, and asking the distribution to create it `
    + `(rc=${made.status}, out=${JSON.stringify(out.slice(0, 80))}) did not make it visible from Windows within 20 s; `
    + 'this is a fixture premise, not a product failure — re-run the step')
}

/** Run the relay, feed it lines, and collect its output. */
async function drive(lines, options = {}) {
  const share = ensureShare()
  if (share !== 'already-mounted') console.log(`relay-real: the fixture share was not mounted; ${share}`)
  const child = spawn(node, ['--experimental-strip-types', relay], {
    cwd: options.cwd ?? workspace,
    env: { ...process.env, ...options.env ?? {} },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  /** Set when the spawn itself failed, so the assertion below can name it. */
  let spawnFailure = ''
  let settleExit = () => {}
  // Attach before feeding: a fast shell can exit while the writes are pending.
  const exited = new Promise(resolve => { settleExit = resolve; child.on('exit', (code) => resolve(code)) })
  // Without this, a spawn that cannot even start (a share that stopped answering) surfaces as an
  // unhandled 'error' event with a stack about `node.exe` — the reason is in a message Node cannot
  // produce. Report it as the code the caller already asserts on, naming the program and the cwd.
  child.on('error', (error) => {
    spawnFailure = `${error.code ?? error.message}: program=${node} cwd=${options.cwd ?? workspace}`
    settleExit(`spawn failed (${spawnFailure})`)
  })
  child.stdout.on('data', (chunk) => { out += chunk.toString() })
  child.stderr.on('data', (chunk) => { err += chunk.toString() })
  for (const line of lines) {
    // A child that never started has no stdin, and an EPIPE here would bury the reason above.
    if (spawnFailure !== '') break
    await new Promise(resolve => setTimeout(resolve, 1200))
    child.stdin.write(`${line}\n`)
  }
  await new Promise(resolve => setTimeout(resolve, 1500))
  child.stdin.end()
  const code = await Promise.race([
    exited,
    new Promise(resolve => setTimeout(() => resolve('timeout'), 20_000)),
  ])
  if (code === 'timeout') {
    child.kill()
    throw new Error(`relay did not exit; output so far: ${out.slice(0, 300)} / ${err.slice(0, 300)}`)
  }
  return { out, err, code }
}

// 1. The shell starts in the session workspace, and state survives between
//    sends (each line is one model call).
const session = await drive(['pwd', 'export PERSIST_MARK=ok42; cd /tmp; pwd', 'echo MARK=$PERSIST_MARK; pwd', 'exit'])
assert.equal(session.code, 0, `relay exited ${session.code}; stderr=${session.err.slice(0, 300)}`)
assert.match(session.out, new RegExp(`${reEsc(linuxOf(workspace))}\n`), `pwd should start in the workspace: ${JSON.stringify(session.out.slice(0, 200))}`)
assert.match(session.out, /\/tmp\n/, `cd /tmp should print /tmp: ${JSON.stringify(session.out.slice(0, 200))}`)
assert.match(session.out, /MARK=ok42/, `state lost between sends: ${JSON.stringify(session.out.slice(0, 300))}`)
assert.equal((session.out.match(/\/tmp/g) ?? []).length >= 2, true, `cd /tmp should persist: ${JSON.stringify(session.out.slice(0, 300))}`)

// 2. The distribution resolves from DSH_WSL_DISTRO when the cwd does not name
//    one, and DSH_WSL_USER is honored (here: the same user, to prove the flag
//    reaches wsl.exe without changing the result).
const envSession = await drive(['echo distro=$WSL_DISTRO_NAME; whoami', 'exit'], {
  cwd: process.env.WSL_COMPAT_DRIVE_CWD || 'C:\\',
  env: { DSH_WSL_DISTRO: distro, DSH_WSL_USER: user },
})
assert.equal(envSession.code, 0, `relay exited ${envSession.code}; stderr=${envSession.err.slice(0, 300)}`)
assert.match(envSession.out, new RegExp(`distro=${distro}`), `DSH_WSL_DISTRO not honored: ${envSession.out.slice(0, 300)}`)
assert.match(envSession.out, new RegExp(`\\b${reEsc(user)}\\b`), `DSH_WSL_USER not honored: ${envSession.out.slice(0, 300)}`)

console.log('PASS relay: stateful shell (export + cd persist between sends), starts in the session cwd,');
console.log('PASS relay: distro from the UNC cwd and from DSH_WSL_DISTRO, DSH_WSL_USER honored, clean exit');
