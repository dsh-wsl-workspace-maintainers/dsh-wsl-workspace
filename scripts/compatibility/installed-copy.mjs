// Drive the bytes that are actually installed in the user's Desktop profile — not the repo's copy.
//
//   node --experimental-strip-types scripts/compatibility/installed-copy.mjs
//
// The profile's `node_modules` holds only the plugins (the host packages live inside the app
// archive), so the installed copy cannot resolve `@deepseek-ai/*` from where it sits. This copies it
// under `node_modules/.cache/`, where the repository's own host packages resolve upward, and imports
// it from there. It is the same channel the product uses: `ctx.plugin(module.default ?? module)`.
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolvePath(import.meta.dirname, '..', '..')
const at = p => pathToFileURL(p).href
const DEPS = `${repoRoot}/ci/deps/node_modules/@deepseek-ai`
const hostModule = (m) => m.default ?? m

const profile = process.env.DSH_PROFILE ?? 'desktop'
const installed = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-wsl-workspace')
if (!readdirSync(installed).includes('lib')) {
  console.error(`installed-copy: RED — no lib/ in ${installed}; the plugin is not installed in that profile`)
  process.exit(1)
}
const staging = join(repoRoot, 'node_modules', '.cache', 'installed-copy-probe')
rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'lib'), { recursive: true })
cpSync(join(installed, 'lib'), join(staging, 'lib'), { recursive: true })
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }))
console.log(`driving the installed copy: ${manifest.name}@${manifest.version} from ${installed}`)

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const username = process.env.WSL_COMPAT_USER ?? 'ruler'
const linuxHome = username === 'root' ? '/root' : `/home/${username}`
const sessionCwd = `\\\\wsl.localhost\\${distro}${linuxHome.replaceAll('/', '\\')}`

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: pass === true })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
for (const module of [
  await import(at(`${DEPS}/dsh-shell-env/lib/index.js`)),
  await import(at(`${DEPS}/dsh-tools/lib/index.js`)),
  await import(at(`${DEPS}/dsh-system-prompt/lib/index.js`)),
]) await ctx.plugin(hostModule(module))
const shellModule = await import(at(join(staging, 'lib', 'shell.js')))
await ctx.plugin(shellModule.default ?? shellModule.WslShellExecutor, {
  cwd: sessionCwd, distro, username, timeoutMs: 30_000, maxTimeoutMs: 60_000,
  maxOutputBytes: 64 * 1024, maxSpillBytes: 4 * 1024 * 1024, graceMs: 500,
})
let jobRequest
ctx.provide?.('jobs', { start: (request) => { jobRequest = request; return 'job-installed-copy' } })
const sessionTool = await import(at(join(staging, 'lib', 'wsl-bash-tool.js')))
const fiber = ctx.plugin(sessionTool.default ?? sessionTool, { ...sessionTool.PROBE_CONFIG, distro, username })
await fiber
await new Promise(resolve => setTimeout(resolve, 50))
const tool = ctx.tools.get('bash')
check('the installed copy registers `bash`', tool !== undefined, `typeof ${typeof tool}`)
if (tool === undefined) {
  console.log('installed-copy: RED — nothing to call')
  rmSync(staging, { recursive: true, force: true })
  process.exit(1)
}
const owner = {
  id: 'agent-installed-copy',
  session: { id: 'session-installed-copy', cwd: sessionCwd, header: { cwd: sessionCwd, id: 'session-installed-copy' } },
  ctx: { on: () => () => {}, effect: (fn) => { try { fn?.() } catch { /* no lifecycle */ } return () => {} } },
}
const exec = { signal: AbortSignal.timeout(180_000), agent: owner }
const bodies = []
async function call(command, options = {}) {
  const started = Date.now()
  const args = { command, description: 'installed-copy probe', ...options }
  const value = await tool.execute(args, exec)
  const rendered = (tool.output?.render?.(args, value) ?? []).map(part => String(part?.text ?? '')).join('')
  bodies.push(rendered)
  return { ms: Date.now() - started, value, text: String(value?.stdout?.text ?? ''), rendered }
}

const first = await call('echo INSTALLED_$(( 21 * 2 ))')
check('computed answer came back from the installed bytes', first.text.includes('INSTALLED_42'), `${first.ms}ms`)
await call('cd /tmp && export INSTALLED_VAR=kept_$(( 6 * 7 ))')
const persisted = await call('pwd; echo READ=$INSTALLED_VAR')
check('cd and export survive into the next call', persisted.text.includes('/tmp') && persisted.text.includes('READ=kept_42'),
  JSON.stringify(persisted.text.trim()))
const failing = await call('false')
check('a nonzero exit renders the host marker', failing.value?.exitCode === 1 && failing.rendered.includes('[exit code: 1]'),
  JSON.stringify(failing.rendered))
const escalated = await call('sudo -n true')
check('sudo answers inside its budget', escalated.ms < 4_000 && escalated.value?.timedOut === false,
  `${escalated.ms}ms exit=${escalated.value?.exitCode}`)
const spill = await call('seq 1 200000', { timeoutMs: 60_000 })
const spillPath = spill.value?.stdout?.spillPath
const spillLines = spillPath === undefined ? 0 : readFileSync(spillPath, 'utf8').trim().split('\n').length
check('large output spills a complete stream and says where', spill.value?.stdout?.truncated === true
  && spillLines === 200_000 && spill.rendered.includes(`[output truncated; full output: ${spillPath}]`),
  `lines=${spillLines} path=${JSON.stringify(spillPath ?? null)}`)
const relative = await call('pwd', { workdir: 'definitely-not-here-installed' })
check('a missing relative workdir fails in bash’s own words', relative.value?.exitCode !== 0
  && /No such file or directory/.test(relative.rendered), JSON.stringify(relative.rendered.slice(0, 70)))
await call("alias installed_alias='echo ALIAS_BACK_OK_7'; installed_fn() { echo FN_BACK_OK_9; }")
const wedged = await call('sleep 4', { timeoutMs: 1_500 })
check('a wedged call restarts the shell and says so', wedged.value?.timedOut === true
  && /the shell was restarted/.test(wedged.rendered), JSON.stringify(wedged.rendered.slice(-70)))
const replayed = await call("installed_alias; installed_fn")
check('alias and function come back after the restart', replayed.text.includes('ALIAS_BACK_OK_7')
  && replayed.text.includes('FN_BACK_OK_9'), JSON.stringify(replayed.text.trim()))
const bg = await tool.execute({ command: 'echo BG', description: 'installed-copy background', run_in_background: true }, exec)
check('run_in_background hands off to the jobs producer', bg?.kind === 'background' && bg?.jobId === 'job-installed-copy'
  && jobRequest?.kind === 'bash', JSON.stringify({ kind: bg?.kind, jobId: bg?.jobId }))
const SIGNATURES = ['__DSH_WSL_BASH', 'eval "$(printf %s', '| base64 -d)"', '#dsh-section', 'declare -F', '__dsh_status']
const dirty = bodies.filter(body => SIGNATURES.some(signature => body.includes(signature)))
check('no protocol byte reaches the model, in any call', bodies.length >= 10 && dirty.length === 0,
  `${dirty.length} of ${bodies.length}`)
const wslCount = () => (String(spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq wsl.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '')
  .match(/wsl\.exe/gi) ?? []).length
const beforeDispose = wslCount()
fiber.dispose?.()
await new Promise(resolve => setTimeout(resolve, 2_000))
check('disposing the plugin takes the shell down', wslCount() <= beforeDispose - 1, `${beforeDispose} → ${wslCount()}`)

const EXPECTED_CHECKS = 12
const passed = results.filter(row => row.pass).length
console.log(`${passed}/${results.length} checks passed against the installed copy (profile=${profile}, distro=${distro}, user=${username})`)
rmSync(staging, { recursive: true, force: true })
console.log(`staging copy removed: ${!readdirSync(join(repoRoot, 'node_modules', '.cache')).includes('installed-copy-probe')}`)
if (passed !== results.length || results.length !== EXPECTED_CHECKS) {
  console.error('installed-copy: RED')
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
