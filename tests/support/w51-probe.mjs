/**
 * Does issue #51's fix work on a real 0.2.x host?
 *
 * #51 names four independent incompatibilities. Two are plugin-side and can be measured directly:
 *
 *   · **(1) `node.exe` crashes when started with a `\\wsl.localhost\…` cwd**, so the PTY relay never
 *     runs. The fix routes `wsl.exe`'s own cwd to a plain Windows directory (`SystemRoot`) and lets
 *     `--cd` carry the Linux side. Measured here by resolving a UNC workdir and reading the plan's
 *     `windowsCwd` — if it is still the UNC path, `wsl.exe` is being spawned into a cwd Node cannot
 *     use.
 *   · **(4) the 0.2.x shell seam is `execute(spec) → (await process).result()`** while this plugin
 *     implemented only 0.1.x's `resolve`/`run`/`start`. Measured by calling **the host's own call
 *     shape** against the real executor and awaiting the result — the exact expression the host
 *     evaluates, not a shape invented here.
 *
 * (2) and (3) need a real PTY under a real ConPTY with the host's own readiness contract, which this
 * probe does not fake: `shell.start()` with `tty: true` spawns the relay, and the relay's readiness
 * wait is reported rather than timed out silently.
 *
 * The executor under test is `lib/shell.js`'s own. A fake would agree with the fix and disagree with
 * the product — which is how the first half of #56 stayed green on CI and stayed broken on a host.
 *
 *   node tests/support/w51-probe.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// `@deepseek-ai/dsh-launch-environment` is a peer of `dsh-app-boot`, so it belongs in
// `ci/pinned-deps.json` — that is what makes `ci/install-pinned.mjs` install it into `ci/deps` and
// link it into the repo root. Before it was pinned, a bare import resolved on the maintainer junction
// and nowhere else, which is why this file briefly carried a path import instead.
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHELL_EXECUTOR = join(repoRoot, 'lib', 'shell.js')
const DISTRO = process.env.DSH_WSL_DISTRO ?? 'Ubuntu'

const report = (rows, verdict) => {
  console.log(JSON.stringify({ verdict, distro: DISTRO, rows }, null, 2))
  const failed = rows.filter(row => row.ok === false)
  process.exit(failed.length === 0 ? 0 : 1)
}

function makeHome () {
  const home = mkdtempSync(join(repoRoot, 'ci', 'deps', '.w51-home-'))
  const profile = 'w51'
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-w51', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  return { home, profile }
}

function writeOverlay (home) {
  const yaml = ['- insert:']
  const row = (id, name) => yaml.push(`    - id: ${id}`, `      name: "${name}"`)
  // `subprocess-local` provides `subprocess` itself; listing `dsh-subprocess` beside it collides.
  row('subprocess-local', '@deepseek-ai/dsh-subprocess-local')
  yaml.push('')
  const file = join(home, 'overlay.yml')
  writeFileSync(file, yaml.join('\n'), 'utf8')
  return file
}

const { home, profile } = makeHome()
const patchFiles = [writeOverlay(home)]

try {
  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const { ctx, shutdown } = await runProfile({ environment, profile, patchFiles, args: [] })

  const rows = []
  const add = (id, ok, detail) => rows.push({ id, ok, detail })

  // The real executor, constructed with a resolved config — `src/shell.ts:180` takes `(ctx, config)`
  // and `assertServiceableWslConfig` runs on what it is given.
  const { WslShellExecutor } = await import(pathToFileURL(SHELL_EXECUTOR).href)
  const config = {
    cwd: `\\\\wsl.localhost\\${DISTRO}\\home`,
    distro: DISTRO,
    username: '',
    wslPath: 'wsl.exe',
    loginShell: true,
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 8 * 1024 * 1024,
    graceMs: 2_000,
  }
  const executor = new WslShellExecutor(ctx, config)

  // ── (4) the host's own call shape ────────────────────────────────────────────────────────
  // `await (await ctx.shell.execute(ctx.shell.resolve(request))).result()` — copied out of the
  // type's own documentation, because a shape invented here would be a shape the host never calls.
  const MARKER = 'W51PROBE5b2e77'
  try {
    const request = executor.resolve({ command: `sh -c "echo ${MARKER}"` })
    const process_ = await executor.execute(request)
    const result = await process_.result()
    // `ShellRunResult.stdout` is a `CollectedOutput`, not a string — coercing it with `String()`
    // yields `[object Object]`, which is how a probe reports "no marker" about output that arrived.
    // Read the field the interface actually declares, and print the whole object when the shape is
    // unfamiliar, so a future change to the contract is visible instead of silently false.
    const stdout = result.stdout
    const text = typeof stdout === 'string' ? stdout : (stdout?.text ?? '')
    const carried = text.includes(MARKER)
    add('4-execute-result', carried,
      carried
        ? `execute→result returned the marker (stdout ${JSON.stringify(text.slice(0, 60))})`
        : `execute→result returned no marker — stdout ${JSON.stringify(stdout)?.slice(0, 160)}, exit ${result.exitCode}`)
  } catch (error) {
    add('4-execute-result', false, `threw: ${String(error?.message ?? error).slice(0, 300)}`)
  }

  // ── (1) a UNC workdir must not become wsl.exe's own cwd ────────────────────────────────
  try {
    const plan = executor.plan(executor.resolve({ command: 'pwd', workdir: `\\\\wsl.localhost\\${DISTRO}\\home` }))
    const isUnc = String(plan.windowsCwd).startsWith('\\\\')
    add('1-unc-cwd-not-spawn-cwd', !isUnc,
      isUnc
        ? `plan kept the UNC path as windowsCwd: ${plan.windowsCwd} — node.exe crashes on that`
        : `windowsCwd=${plan.windowsCwd} (a plain Windows directory), --cd carries the Linux side`)
    add('1-argv-carries-linux-cwd', String(plan.argv).includes('--cd'),
      `argv=${JSON.stringify(plan.argv).slice(0, 200)}`)
  } catch (error) {
    add('1-unc-cwd-not-spawn-cwd', false, `threw: ${String(error?.message ?? error).slice(0, 300)}`)
  }

  // ── (2)+(3): a tty start is the relay; report what it did rather than timing out ────────
  try {
    const tty = executor.resolve({ command: 'echo ready', tty: true })
    const started = executor.start(tty)
    const settled = await Promise.race([
      started.done.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('still-running'), 45_000)),
    ])
    add('2-3-tty-start', settled === 'settled',
      settled === 'settled'
        ? `a tty start settled (status=${started.status})`
        : `a tty start was still running after 45s — the relay's readiness wait did not settle`)
    started.kill()
  } catch (error) {
    add('2-3-tty-start', false, `threw: ${String(error?.message ?? error).slice(0, 300)}`)
  }

  await (typeof shutdown === 'function' ? shutdown() : undefined)
  report(rows)
} catch (error) {
  console.log(JSON.stringify({ verdict: 'NOT-MEASURED', message: String(error?.stack ?? error).slice(0, 900) }))
  process.exit(2)
}