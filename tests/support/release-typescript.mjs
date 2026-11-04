// Release behavior row 10.3. The two arms execute the same pinned npm
// invocation from the same new Linux workspace as the same WSL account.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { withReleaseSession } from './release-session.mjs'

const distro = process.env.WSL_COMPAT_DISTRO ?? 'Ubuntu-24.04'
const command = 'npm exec --yes --package typescript@5.9.3 -- tsc --version'
const evidenceDir = resolve(process.env.DSH_RELEASE_EVIDENCE_DIR ?? '.test-runs/release-10.3')
const runWsl = (args, options = {}) => spawnSync('wsl.exe', ['-d', distro, ...args], {
  encoding: 'utf8', timeout: 240_000, ...options,
})
function succeeded(result, context) {
  assert.equal(result.error, undefined, context)
  assert.equal(result.status, 0, context + '\n' + result.stderr)
  return result.stdout.trim()
}

const user = process.env.DSH_WSL_USER ?? succeeded(runWsl(['-e', 'id', '-un']), 'default Linux user')
const linuxCwd = succeeded(runWsl(['-u', user, '-e', 'mktemp', '-d', '/tmp/dsh-release-ts.XXXXXXXX']), 'workspace')
assert.match(linuxCwd, /^\/tmp\/dsh-release-ts\.[A-Za-z0-9]+$/)
const cwd = '\\\\wsl.localhost\\' + distro + linuxCwd.replaceAll('/', '\\')
process.env.DSH_WSL_DISTRO = distro
process.env.DSH_WSL_USER = user
mkdirSync(evidenceDir, { recursive: true })

const facts = [
  "printf 'user=%s\\n' \"$(id -un)\"",
  "printf 'cwd=%s\\n' \"$PWD\"",
  "printf 'npm=%s\\n' \"$(command -v npm)\"",
  "node -p 'process.platform + \":\" + process.version'",
].join('; ')
const direct = (script, extraEnv = []) => {
  const result = runWsl(['-u', user, '--cd', linuxCwd, '-e', 'env', ...extraEnv, 'bash', '-ls'], { input: script + '\n' })
  assert.equal(result.error, undefined)
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status }
}

await withReleaseSession({ cwd, evidenceDir }, async ({ call }) => {
  const nativeFacts = direct(facts)
  assert.equal(nativeFacts.exitCode, 0, JSON.stringify(nativeFacts))
  assert.match(nativeFacts.stdout, /^user=.+\ncwd=\/tmp\/dsh-release-ts\..+\nnpm=\/.+\nlinux:v\d/m)
  assert(!nativeFacts.stdout.includes('\nnpm=/mnt/'), 'fixture needs Linux npm')
  const productFacts = await call('bash', { command: facts, description: 'Record Linux user, cwd, npm and Node' })
  assert.equal(productFacts.value?.exitCode, 0, JSON.stringify(productFacts.error))
  assert.equal(productFacts.value.stdout.text, nativeFacts.stdout)

  // Use separate cold caches so either arm can only obtain the compiler from
  // the same registry and pinned package, not from the other arm's install.
  const env = 'npm_config_registry=https://registry.npmjs.org'
  const native = direct(command, [env, 'npm_config_cache=' + linuxCwd + '/native-cache'])
  const product = await call('bash', {
    command: env + ' npm_config_cache=' + linuxCwd + '/product-cache ' + command,
    description: 'Check the pinned TypeScript compiler version',
    timeoutMs: 180_000,
  }, { timeoutMs: 240_000 })
  const report = {
    row: '10.3', command, distro, user, cwd, nativeFacts, productFacts, native, product,
  }
  writeFileSync(join(evidenceDir, '10.3.json'), JSON.stringify(report, null, 2) + '\n')
  assert.equal(native.exitCode, 0, JSON.stringify(native))
  assert.equal(product.value?.exitCode, 0, JSON.stringify(product.error ?? product.value))
  assert.equal(native.stdout, 'Version 5.9.3\n')
  assert.equal(product.value.stdout.text, native.stdout)
  assert.equal(native.stderr, '')
  assert.equal(product.value.stderr.text, native.stderr)
  assert.equal(product.result.data.message.isError ?? false, false)
  console.log('MATCH 10.3 — both arms: Version 5.9.3, empty stderr, exit 0')
})
