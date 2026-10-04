// The host's own `bash` tool, called end to end against the mounted plugin, on a real WSL.
//
//   node --experimental-strip-types scripts/compatibility/tool-bash-real.mjs
//   DSH_WSL_TEST_PLANE=lib node --experimental-strip-types scripts/compatibility/tool-bash-real.mjs
//
// Why this exists. Issue #51 point 4 is a missing method on the seam the *host* calls, and every
// check we had stopped one level short of that: `tests/shell-execute-shape.mjs` asserts the shape
// of the built file against a faked subprocess, and the PTY drivers assert a terminal session.
// Neither one is `dsh-tool-bash` dispatching a tool call. Its foreground path is
// `await (await ctx.shell.execute(ctx.shell.resolve({...request, signal}))).result()`
// (dsh-tool-bash/lib/index.js:683), so this driver builds a real host context, mounts the plugin's
// executor as `ctx.shell` the way the host does, registers the real tool, calls it, and asserts on
// the text the tool itself returns. That is the only level at which "bash works" is a statement
// about the product rather than about our own file.
//
// It carries its own mutation control, because a green at this level is worth nothing unless the
// red is reachable: a copy of the loaded shell module with `execute` renamed — the 0.7.5 shape —
// must make the same call fail with `ctx.shell.execute is not a function` at that line. A control
// that passes is a fixture; a control that fails is an instrument.
//
// Env: WSL_COMPAT_DISTRO (default Ubuntu), WSL_COMPAT_USER (default root). The session cwd is the
// distro home's UNC form, because `resolveWorkdir` reads it off the agent session and the whole
// point is that the UNC is what gets translated.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { load, plane } from './plane.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')

/** Find a host package's entry file in either tree. Probing paths rather than calling
 * `require.resolve` is deliberate: these packages publish an `exports` map that allows the bare
 * specifier but not the deep one, and the drivers on this job import the file directly. */
function host(name) {
  for (const root of [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]) {
    const candidate = join(root, ...name.split('/'), 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const results = []
/** One asserted observation, named and counted. A short run must not be able to report green. */
function check(name, pass, detail) {
  results.push({ name, pass: pass === true })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu'
const username = process.env.WSL_COMPAT_USER ?? 'root'
const linuxHome = username === 'root' ? '/root' : `/home/${username}`
const sessionCwd = `\\\\wsl.localhost\\${distro}${linuxHome.replaceAll('/', '\\')}`
const marker = `BASH_TOOL_OK_$(( 13 * 7 ))`

const missing = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tool-bash']
  .filter(name => host(name) === null)
if (missing.length > 0) {
  console.error(`FAIL host-packages — cannot resolve ${missing.join(', ')} from either node_modules tree`)
  console.error('tool-bash-real: RED — the driver would test nothing without the host it claims to drive')
  process.exit(1)
}
check('host-packages', true, 'all six host modules resolved')

const { Context } = await import(pathToFileURL(host('@deepseek-ai/cordis')).href)
const LocalSubprocessRuntime = (await import(pathToFileURL(host('@deepseek-ai/dsh-subprocess-local')).href)).default
const asPlugin = async (name) => {
  const mod = await import(pathToFileURL(host(name)).href)
  return mod.default ?? mod
}

const shellModule = await load('shell')
const WslShellExecutor = shellModule.default ?? shellModule.WslShellExecutor
if (typeof WslShellExecutor !== 'function') {
  console.error(`FAIL executor — plane=${plane()} exposed ${JSON.stringify(Object.keys(shellModule).slice(0, 8))}`)
  process.exit(1)
}

const config = {
  cwd: sessionCwd,
  distro,
  username,
  timeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  maxOutputBytes: 64 * 1024,
  maxSpillBytes: 1024 * 1024,
  graceMs: 500,
}

/** Boot a context with the real services and the real tool registered; return the tool. */
async function boot(executor) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  for (const name of ['@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
    await ctx.plugin(await asPlugin(name))
  }
  await ctx.plugin(executor, config)
  const bash = await asPlugin('@deepseek-ai/dsh-tool-bash')
  // The tool package registers from `apply`, which the DI lifecycle would call for us; calling it
  // directly is how this repo's other host drivers enter a plugin (tests/host-declare.mjs).
  await bash.apply(ctx, new bash.Config({}))
  await new Promise(resolveTick => setTimeout(resolveTick, 50))
  return ctx
}

const exec = {
  signal: AbortSignal.timeout(30_000),
  agent: { session: { id: 'session-tool-bash-real', header: { cwd: sessionCwd, id: 'session-tool-bash-real' } } },
}
const args = {
  command: 'echo BASH_TOOL_OK_$(( 13 * 7 )); pwd; whoami; false; echo exit_code=$?',
  description: 'compatibility driver: the host bash tool against the mounted plugin',
  timeoutMs: 20_000,
}

let toolFailed = null
let toolResult = undefined
try {
  const ctx = await boot(WslShellExecutor)
  check('ctx.shell is the plugin executor', ctx.shell?.constructor?.name === 'WslShellExecutor',
    `ctx.shell is ${String(ctx.shell?.constructor?.name)}`)
  const tool = ctx.tools.get('bash')
  check('bash tool registered', tool !== undefined)
  if (tool === undefined) throw new Error('no bash tool in the registry')
  const started = Date.now()
  toolResult = await tool.execute(args, exec)
  console.log(`  tool returned in ${Date.now() - started}ms, kind=${String(toolResult?.kind)}`)
} catch (error) {
  toolFailed = error
}

const text = String(toolResult?.stdout?.text ?? '')
check('tool returned a foreground result', toolFailed === null && toolResult?.kind === 'foreground',
  toolFailed === null ? undefined : String(toolFailed?.message ?? toolFailed).slice(0, 160))
check('computed answer came back, not the echoed command', text.includes('BASH_TOOL_OK_91'), JSON.stringify(text.slice(0, 120)))
check('the UNC session cwd became the Linux cwd', text.includes(linuxHome), `expected ${linuxHome} in ${JSON.stringify(text)}`)
check('the command ran as the session user', username === 'root' || text.includes(username), JSON.stringify(text))
check('a failing command reports its exit code through the tool', text.includes('exit_code=1'), JSON.stringify(text))
check('stderr came back empty', String(toolResult?.stderr?.text ?? '') === '', JSON.stringify(String(toolResult?.stderr?.text ?? '').slice(0, 200)))

// Mutation control: the same call against the code under test minus the fix. A green here is worth
// nothing unless the red is reachable, so the check is that the host's own tool fails with
// `ctx.shell.execute is not a function` at dsh-tool-bash/lib/index.js:683.
/** Run the host call against an executor whose `execute` is gone, and report what came back. */
async function expectMutantFailure(executor, how) {
  let mutantError = null
  let mutantResult = undefined
  try {
    const ctx = await boot(executor)
    mutantResult = await ctx.tools.get('bash').execute(args, exec)
  } catch (error) {
    mutantError = error
  }
  const message = String(mutantError?.message ?? '')
  check(`mutation control (${how}): removing \`execute\` breaks the host call`,
    /ctx\.shell\.execute is not a function/.test(message),
    mutantError === null
      ? `the mutant returned ${JSON.stringify(String(mutantResult?.stdout?.text ?? '').slice(0, 60))} — the tool does not need execute, so this driver proves nothing`
      : message.slice(0, 120))
}

if (plane() === 'lib') {
  // The shipped bytes, edited. The copy lives under `node_modules/.cache` so its bare specifiers
  // still resolve, and its relative specifiers are rewritten to absolute file URLs; the directory
  // is gitignored and removed in `finally`.
  const sourcePath = join(repoRoot, 'lib', 'shell.js')
  const source = readFileSync(sourcePath, 'utf8')
  const anchor = '\tasync execute(spec) {'
  if (source.split(anchor).length - 1 !== 1) {
    check('mutation control applies to the built file', false, `anchor found ${source.split(anchor).length - 1} times in ${sourcePath}`)
  } else {
    mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true })
    const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'dsh-tool-bash-real-'))
    try {
      const sourceDir = sourcePath.slice(0, sourcePath.lastIndexOf(sep))
      const relocated = source.replace(/(\bfrom\s+['"])(\.\.?\/[^'"]+)(['"])/g, (_all, open, spec, close) =>
        `${open}${pathToFileURL(resolve(sourceDir, spec.replaceAll('/', sep))).href}${close}`)
      const mutantPath = join(scratch, 'shell-mutant.js')
      writeFileSync(mutantPath, relocated.replace(anchor, anchor.replace('execute(spec)', 'executeRemovedByMutation(spec)')), 'utf8')
      await expectMutantFailure((await import(pathToFileURL(mutantPath).href)).default, 'built lib/shell.js')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
} else {
  // Node refuses to type-strip a file under node_modules, and a scratch directory at the repo root
  // would show up untracked in someone else's `git status`, so the source plane removes the method
  // from the prototype of a subclass instead. Same class, same code path, one method absent.
  class MutantExecutor extends WslShellExecutor {}
  MutantExecutor.prototype.execute = undefined
  await expectMutantFailure(MutantExecutor, 'src class, prototype')
}

const EXPECTED_CHECKS = 10
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} checks passed (plane=${plane()}, distro=${distro}, user=${username}, cwd=${sessionCwd}${sep === '\\' ? ', win32' : ', non-win32'})`)
if (results.length !== EXPECTED_CHECKS) {
  console.error(`tool-bash-real: RED — ran ${results.length} checks, expected ${EXPECTED_CHECKS}; a short run must not report green`)
  process.exitCode = 1
} else if (passed !== results.length) {
  console.error('tool-bash-real: RED — at least one check failed')
  process.exitCode = 1
}
