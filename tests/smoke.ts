/**
 * Real-WSL integration smoke: distro discovery, the UNC-backed filesystem
 * (resolve/write/read/edit/stat/listDir/contains/processPath) and the WSL bash
 * executor (cwd translation, execution, WSLENV pass-through), all mounted in a
 * minimal cordis composition against the LOCAL subprocess service.
 *
 * Run from the plugin directory:
 *   node --import tsx/esm tests/smoke.ts
 *
 * Requires a running WSL distribution; the first listed distro is used.
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WslFileSystem } from '../src/fs.ts'
import { WslShellExecutor } from '../src/shell.ts'
import { defaultDistro, listDistros } from '../src/shared/wsl.ts'
import { joinUnc, windowsToMntPath } from '../src/shared/paths.ts'

async function main(): Promise<void> {
  const distros = await listDistros()
  console.log('distros:', distros)
  if (distros.length === 0) throw new Error('no WSL distribution available')
  const def = await defaultDistro()
  console.log('default distro:', def)
  // Skip infrastructure distros (docker-desktop and friends) whose 9P share
  // is not a user filesystem; the dialog lets the user pick, the smoke just
  // needs a usable one.
  const distro = distros.find(name => !name.toLowerCase().includes('docker'))
    ?? def ?? distros[0]!
  console.log('smoke distro:', distro)

  const root = new Context()
  await root.plugin(LocalSubprocessRuntime)
  await root.plugin(WslFileSystem, { distro })
  await root.plugin(WslShellExecutor, { distro, timeoutMs: 30_000, maxOutputBytes: 32_000 })

  const unc = joinUnc(distro, '/tmp')
  const file = '/tmp/dsh-wsl-smoke.txt'
  const fileUnc = joinUnc(distro, '/tmp/dsh-wsl-smoke.txt')

  // Leftover from an interrupted run must not fail the pre-write assertion.
  rmSync(fileUnc, { force: true })

  try {
    // ── filesystem round-trip ──────────────────────────────────────────────────
    const target = await root.fs.resolve(file, { cwd: unc })
    console.log('resolve displayPath:', target.displayPath, '| processPath:', root.fs.processPath(target))
    if (target.displayPath !== file || root.fs.processPath(target) !== file) {
      throw new Error('display/process path not in Linux form')
    }

    const before = await root.fs.stat(target)
    if (before !== undefined) throw new Error('smoke file should not exist yet')
  await root.fs.writeText(target, 'hello wsl\nline2\n', { kind: 'createIfAbsent' })
  const afterWrite = await root.fs.stat(target)
  if (afterWrite === undefined) throw new Error('stat after write missing')
  const read = await root.fs.readText(target)
  if (read !== 'hello wsl\nline2\n') throw new Error(`read mismatch: ${JSON.stringify(read)}`)

  await root.fs.editText(target, { oldString: 'hello wsl', newString: 'hello DSH', replaceAll: false }, { version: afterWrite.version })
  const afterEdit = await root.fs.readText(target)
  if (afterEdit !== 'hello DSH\nline2\n') throw new Error(`edit mismatch: ${JSON.stringify(afterEdit)}`)

  const editedStat = await root.fs.stat(target)
  if (editedStat === undefined || editedStat.version === afterWrite.version) {
    throw new Error('version must change across an edit')
  }
  console.log('fs round-trip OK (write/read/edit/stat/version)')

  const listing = await root.fs.listDir(await root.fs.resolve('/tmp', { cwd: unc }))
  if (!listing.some(entry => entry.name === 'dsh-wsl-smoke.txt')) throw new Error('listDir missed the smoke file')
  console.log('listDir OK')

  const parent = await root.fs.resolve('/tmp', { cwd: unc })
  if (!root.fs.contains(parent, target)) throw new Error('contains should hold for /tmp parent')
  if (root.fs.contains(target, parent)) throw new Error('contains must be directional')
  console.log('contains OK')

  const url = root.fs.fileUrl(target)
  if (url !== 'file:///tmp/dsh-wsl-smoke.txt') throw new Error(`fileUrl mismatch: ${url}`)
  console.log('fileUrl OK')

  // ── shell execution inside WSL ─────────────────────────────────────────────
  // The face this smoke drives is the provider it just mounted, not the host's
  // abstract `ShellExecutor`: `run` and `start` are what this class adds.
  const shell = root.shell as unknown as WslShellExecutor
  const spec = shell.resolve({
    command: 'pwd && uname -s && printf "DSH=%s\\n" "$DSH_SESSION_ID" && printf "HOME=%s\\n" "$HOME"',
    workdir: unc,
    dshEnv: { DSH_SESSION_ID: 'smoke-1' } as never,
  })
  const result = await shell.run(spec)
  console.log('shell exit:', result.exitCode, '| stdout:', JSON.stringify(result.stdout.text))
  if (result.exitCode !== 0) throw new Error(`shell failed: ${result.stderr.text}`)
  const text = result.stdout.text
  if (!text.includes('/tmp') || !text.includes('Linux') || !text.includes('DSH=smoke-1')) {
    throw new Error(`unexpected shell output: ${JSON.stringify(text)}`)
  }
  if (!text.includes('HOME=/root') && !text.includes('HOME=/home/')) {
    // A login shell sets HOME; a WSL root login defaults to /root.
    console.log('note: unexpected HOME value (informational):', text.match(/HOME=[^\n]*/)?.[0])
  }
  console.log('shell execution OK (cwd translation + WSLENV)')

  // ── Linux workdir resolved through the session distro fact ────────────────
  // Mirrors the reported failure: the model passes a plain Linux workdir and
  // the managed env carries DSH_WSL_DISTRO (contributed by the host half from
  // the session's UNC cwd).
  const linuxSpec = shell.resolve({
    command: 'pwd && printf "DISTRO=%s\\n" "$DSH_WSL_DISTRO"',
    workdir: '/tmp',
    dshEnv: { DSH_SESSION_ID: 'smoke-2', DSH_WSL_DISTRO: distro } as never,
  })
  const linuxResult = await shell.run(linuxSpec)
  if (linuxResult.exitCode !== 0) throw new Error(`linux-workdir shell failed: ${linuxResult.stderr.text}`)
  if (!linuxResult.stdout.text.includes('/tmp') || !linuxResult.stdout.text.includes(`DISTRO=${distro}`)) {
    throw new Error(`linux-workdir output mismatch: ${JSON.stringify(linuxResult.stdout.text)}`)
  }
  console.log('linux workdir OK (session distro fact + WSLENV)')

  // ── dual access: Windows files through /mnt/<drive> ───────────────────────
  // The WSL session's file tools must read and write the Windows filesystem
  // via its Linux-facing /mnt form (migration path).
  const winDir = tmpdir()
  const mntDir = windowsToMntPath(winDir)
  if (mntDir === null) throw new Error(`tmpdir is not a drive path: ${winDir}`)
  const dualFile = `${mntDir}/dsh-wsl-dual.txt`
  const dualTarget = await root.fs.resolve(dualFile)
  if (root.fs.processPath(dualTarget) !== dualFile) {
    throw new Error(`dual target not in /mnt form: ${root.fs.processPath(dualTarget)}`)
  }
  await root.fs.writeText(dualTarget, 'dual access\n', { kind: 'createIfAbsent' })
  const dualRead = await root.fs.readText(dualTarget)
  if (dualRead !== 'dual access\n') throw new Error(`dual read mismatch: ${JSON.stringify(dualRead)}`)
  rmSync(join(winDir, 'dsh-wsl-dual.txt'), { force: true })
  console.log('dual access OK (Windows files via /mnt/<drive>)')

  // ── stdin + background ─────────────────────────────────────────────────────
  const echoSpec = shell.resolve({ command: 'cat', workdir: unc, stdin: 'from-stdin\n' })
  const echoResult = await shell.run(echoSpec)
  if (!echoResult.stdout.text.includes('from-stdin')) throw new Error('stdin was not relayed into WSL')
  console.log('stdin OK')

  const bg = shell.start(shell.resolve({ command: 'sleep 0.3 && echo background-done', workdir: unc }))
  await bg.done
  const bgOut = bg.readOutput().delta
  if (!bgOut.includes('background-done')) throw new Error(`background output mismatch: ${JSON.stringify(bgOut)}`)
  console.log('background OK')

  // ── no-config distro resolution (default-distro fallback) ────────────────
  // Provider-level calls without a session may still resolve through the Lxss
  // default. Model-facing tools use the calling session cwd instead.
  const bare = new Context()
  await bare.plugin(LocalSubprocessRuntime)
  await bare.plugin(WslFileSystem, {})
  const bareTarget = await bare.fs.resolve('/etc/hostname')
  if (bareTarget.displayPath !== '/etc/hostname') {
    throw new Error(`bare resolve displayPath mismatch: ${bareTarget.displayPath}`)
  }
  const bareInfo = await bare.fs.stat(bareTarget)
  if (bareInfo === undefined || bareInfo.type !== 'file') {
    throw new Error('bare resolve should stat /etc/hostname as a file')
  }
  console.log('no-config distro fallback OK (default distribution)')
  } finally {
    // ── cleanup ─────────────────────────────────────────────────────────────
    rmSync(fileUnc, { force: true })
  }
  console.log('SMOKE PASSED')
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error)
  process.exitCode = 1
})
