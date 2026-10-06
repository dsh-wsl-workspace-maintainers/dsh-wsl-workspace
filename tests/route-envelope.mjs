/**
 * Drives the SHIPPED dialog data route over a real loopback socket.
 *
 * The seam is exact and already proven reachable: `src/index.ts:864-896` registers
 * `{ kind: 'exact', path, handler(req, res) }` on the host's `webServer` service, and
 * `tests/host-materialize.mjs:223` captures that registration but throws the handler away.
 * This file keeps the handler, mounts it in a real `node:http` server bound to
 * `127.0.0.1:0`, and answers it with `fetch`. Nothing is stubbed between the socket and the
 * dispatch: the loopback fence, the method fence, the body cap, the params guard and every
 * `SEARCH`-free envelope shape are the ones `lib/index.js` actually ships.
 *
 * Plane: `lib/` (the committed build output the harness loads), never `src/`.
 *
 * Two deliberate departures from "just use fetch", both forced by the client, not the subject:
 *  - the `Host` fence is driven with `node:http`'s client, because Node's `fetch` (undici)
 *    silently drops a caller-supplied `Host` header, so a fetch-driven rebinding probe would
 *    test the client rather than the fence. The socket is still a real 127.0.0.1 socket and
 *    the header is still real wire bytes.
 *  - a non-loopback PEER address cannot be produced by a socket that is bound to loopback, and
 *    binding outside 127.0.0.1 is out of bounds for this suite. The peer address is therefore
 *    substituted on the request object the handler receives (everything else — method, headers,
 *    body stream, response — stays real). That is labelled below and it is the weaker of the two
 *    fence halves; the `Host` half is genuine wire data.
 *
 *   node tests/route-envelope.mjs
 *
 * @module dsh-wsl-workspace/tests/route-envelope
 */

import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { execFile as execFileRaw } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = 'ROUTE ENVELOPE'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY_BYTES = 1048576
/** TEST-NET-3 documentation prefix: definitively not a loopback address. */
const NON_LOOPBACK_PEER = '203.0.113.9'

let failures = 0
let skips = 0
const assert = (condition, label) => {
  if (condition) {
    console.log(`ok: ${label}`)
    return
  }
  failures += 1
  console.error(`not ok: ${label}`)
}
/** A skip is never a pass: it is printed loudly and reported in the verdict line. */
const skip = (label, reason) => {
  skips += 1
  console.error(`SKIP: ${label} — platform cannot answer it here (${reason})`)
}

/**
 * `execFile` in promise form, WITHOUT `spawnSync`.
 *
 * This suite runs in an environment where the synchronous spawn is refused
 * (`EBUSY`), so the live-distro fixture in section 8c shells out through the
 * callback form the way the plugin's own `shared/links.ts` does — one call per
 * `wsl.exe` invocation, and a rejection carries the same `{ stdout, stderr }`
 * shape the callback received.
 */
const execFileResult = (file, args, options) => new Promise((settle, fail) => {
  execFileRaw(file, args, options, (error, stdout, stderr) => {
    const result = { stdout, stderr }
    if (error != null && error.code !== 0) {
      if (stdout === undefined || stdout === '') error.stdout = stdout
      error.result = result
      fail(error)
      return
    }
    settle(result)
  })
})

const isEnvelope = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.ok === 'boolean'

// ── harness: temp DSH_HOME, the captured route, a real server ──────────────
// The registry store lives under DSH_HOME, so assertion 10 needs it pointed at a
// temp directory *before* the plugin's credential module resolves a path.
const home = mkdtempSync(join(tmpdir(), 'dsh-route-envelope-home-'))
const work = mkdtempSync(join(tmpdir(), 'dsh-route-envelope-'))
process.env.DSH_HOME = home

let server
try {
  const { apply } = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href)
  const registrations = []
  // Only `webServer` is answered: with `agentPresets` absent the preset materializer
  // never runs, so this harness spawns nothing and writes nothing but the temp home.
  const fakeCtx = {
    get: (key) =>
      key === 'webServer'
        ? { register: (route) => { registrations.push(route); return () => {} } }
        : undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  apply(fakeCtx, { route: '/dsh-wsl-workspace/api' })

  assert(registrations.length === 1, 'the shipped apply() registers exactly one webServer route')
  assert(registrations[0]?.kind === 'exact' && registrations[0]?.path === '/dsh-wsl-workspace/api',
    'the registration is an exact mount on the configured path')
  assert(typeof registrations[0]?.handler === 'function',
    'the captured registration carries a handler function')

  const handler = registrations[0].handler
  server = createServer((req, res) => {
    // An early response while the client is still uploading can surface an ECONNRESET on the
    // request side; that is the harness's problem, not the subject's.
    req.on('error', () => {})
    if (req.headers['x-test-non-loopback-peer'] === '1') {
      Object.defineProperty(req, 'socket', {
        value: { remoteAddress: NON_LOOPBACK_PEER },
        configurable: true,
      })
    }
    res.on('finish', () => { req.resume() })
    try {
      const answered = handler(req, res)
      if (answered !== undefined && typeof answered?.catch === 'function') {
        answered.catch((error) => {
          console.error(`handler rejected: ${String(error?.message ?? error)}`)
          if (!res.headersSent) res.writeHead(500), res.end('{}')
        })
      }
    } catch (error) {
      failures += 1
      console.error(`not ok: the handler threw synchronously (${String(error?.message ?? error)})`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }), res.end('{"ok":false}')
    }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/dsh-wsl-workspace/api`
  assert(server.address().address === '127.0.0.1', 'the server is bound to 127.0.0.1 only')

  /** One real request; every fetch carries an AbortSignal.timeout. */
  async function post(body, options = {}) {
    const response = await fetch(url, {
      method: options.method ?? 'POST',
      body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: options.headers,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      envelope = undefined
    }
    return { status: response.status, text, envelope, headers: response.headers }
  }

  /**
   * The `Host` fence over real wire bytes. Node's fetch drops a caller-set `Host`,
   * so this is `node:http`'s client: the header arrives at the subject as bytes on
   * a genuine 127.0.0.1 socket.
   */
  function postHost(host, body) {
    return new Promise((settle, fail) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/dsh-wsl-workspace/api',
          method: 'POST',
          headers: { host, 'content-type': 'application/json' },
          timeout: 20_000,
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { text += chunk })
          response.on('end', () => {
            let envelope
            try {
              envelope = JSON.parse(text)
            } catch {
              envelope = undefined
            }
            settle({ status: response.statusCode, text, envelope, headers: response.headers })
          })
        },
      )
      req.on('timeout', () => { req.destroy(new Error('host-probe timed out')) })
      req.on('error', fail)
      req.end(body === undefined ? '{}' : JSON.stringify(body))
    })
  }

  // ── 1. the loopback fence ───────────────────────────────────────────────
  const allowed = await post({ method: 'describe' })
  assert(allowed.status === 200 && allowed.envelope?.ok === true,
    'a real loopback request with a loopback Host is answered (the fence is not blanket-403)')

  const foreignPeer = await post({ method: 'describe' }, {
    headers: { 'x-test-non-loopback-peer': '1' },
  })
  assert(foreignPeer.status === 403 && foreignPeer.envelope?.ok === false
    && foreignPeer.envelope?.error === 'loopback-only',
    `a non-loopback socket peer gets 403 loopback-only (peer ${NON_LOOPBACK_PEER}, substituted address)`)

  const rebound = await postHost('evil.example.com', { method: 'describe' })
  assert(rebound.status === 403 && rebound.envelope?.ok === false && rebound.envelope?.error === 'loopback-only',
    'a spoofed non-loopback Host header gets 403 loopback-only (DNS-rebinding class)')
  const spoofedHostSeen = rebound.text
  assert(spoofedHostSeen.includes('loopback-only'), 'the Host-fence answer is the fence envelope, not a dispatch result')

  const bareLoopbackHost = await postHost('127.0.0.1', { method: 'describe' })
  assert(bareLoopbackHost.status === 200 && bareLoopbackHost.envelope?.ok === true,
    'Host "127.0.0.1" without a port is accepted (hostNameOf strips ports, does not reject)')
  const localhostHost = await postHost('localhost', { method: 'describe' })
  assert(localhostHost.status === 200 && localhostHost.envelope?.ok === true,
    'Host "localhost" is accepted')
  const looksLoopbackButIsNot = await postHost('evil.localhost.example.com', { method: 'describe' })
  assert(looksLoopbackButIsNot.status === 403,
    'a Host that merely contains "localhost" is refused (the fence is an exact hostname set, not a substring test)')

  // ── 2. the method fence ─────────────────────────────────────────────────
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const answer = await post(undefined, { method })
    assert(answer.status === 405 && answer.envelope?.ok === false
      && answer.envelope?.error === 'method not allowed',
      `${method} gets 405 method not allowed`)
  }

  // ── 3. the body cap, at the exact boundary ──────────────────────────────
  // readBody() counts bytes of the whole body, so the fixture is padded to an exact
  // length rather than to an approximate one. `describe` ignores params, so the
  // padding is inert and the two halves differ only by one byte.
  const padded = (extra) => {
    const overhead = Buffer.byteLength(JSON.stringify({ method: 'describe', params: { pad: '' } }))
    return JSON.stringify({ method: 'describe', params: { pad: 'x'.repeat(MAX_BODY_BYTES - overhead + extra) } })
  }
  const atCap = padded(0)
  const overCap = padded(1)
  assert(Buffer.byteLength(atCap) === MAX_BODY_BYTES,
    `the at-cap fixture is exactly ${MAX_BODY_BYTES} bytes (built ${Buffer.byteLength(atCap)})`)
  assert(Buffer.byteLength(overCap) === MAX_BODY_BYTES + 1,
    `the over-cap fixture is exactly ${MAX_BODY_BYTES + 1} bytes (built ${Buffer.byteLength(overCap)})`)

  const atCapAnswer = await post(undefined, { raw: atCap })
  assert(atCapAnswer.status === 200 && atCapAnswer.envelope?.ok === true,
    'a body of exactly 1 MiB is accepted')
  const overCapAnswer = await post(undefined, { raw: overCap })
  assert(overCapAnswer.status === 400 && overCapAnswer.envelope?.ok === false
    && typeof overCapAnswer.envelope?.error === 'string'
    && /too large/.test(overCapAnswer.envelope.error),
    'a body of 1 MiB + 1 byte is refused with a parseable envelope naming the size limit')

  // ── 4. params that is not an object ─────────────────────────────────────
  // The ticket asks for "a parseable 200 {ok:false} envelope naming the bad field,
  // not a 500 and not an empty body". The shipped route answers 400, not 200
  // (`lib/index.js:1902-1908`): the substance — parseable, ok:false, names `params`,
  // never a 500, never empty — is asserted, and the exact status is pinned as well so
  // a change in either direction is visible. The 200-vs-400 wording gap is reported.
  for (const [label, params] of [['null', null], ['an array', ['a', 'b']], ['a string', 'oops']]) {
    const answer = await post({ method: 'describe', params })
    assert(isEnvelope(answer.envelope) && answer.envelope.ok === false,
      `params as ${label} yields a parseable {ok:false} envelope`)
    assert(answer.status !== 500, `params as ${label} is not a 500`)
    assert(answer.text.length > 0, `params as ${label} is not an empty body`)
    assert(typeof answer.envelope.error === 'string' && /params/.test(answer.envelope.error),
      `params as ${label} names the offending field ("${answer.envelope?.error ?? ''}")`)
    assert(answer.status === 400,
      `params as ${label} answers HTTP 400 (the shipped status; pinned so a drift either way is visible)`)
  }

  // ── 5. unknown method ───────────────────────────────────────────────────
  const unknown = await post({ method: 'noSuchMethod' })
  assert(unknown.status === 200 && isEnvelope(unknown.envelope) && unknown.envelope.ok === false
    && /unknown method/.test(String(unknown.envelope.error)),
    `an unknown method answers 200 {ok:false} naming it ("${unknown.envelope?.error ?? ''}")`)

  // ── variantStatus ──
  // The route half of issue #52. `tests/client-lifecycle.test.mjs` already drives the
  // CLIENT against a stubbed answer, which leaves the host's own duty unverified: whether
  // `dispatch` has a `case 'variantStatus'` at all, and what it answers. Delete that case and
  // every other test in this file still passes — a green suite over a route that does not
  // exist. These two assertions are what make the deletion red.
  //
  // Only the SHAPE is pinned. This harness deliberately answers `webServer` and nothing else
  // (:75-81), so the preset materializer never runs and `state` is the boot-time `'pending'`.
  // Asserting `'partial'` here would pin this harness's fixture, not the contract: the value
  // depends on whether the WSL machine has distros, which is the wrong thing for a
  // platform-independent gate to depend on. What must hold everywhere is that the answer
  // parses, says ok, and carries every field the dialog reads.
  const outcome = await post({ method: 'variantStatus' })
  const state = outcome.envelope?.value?.state
  assert(outcome.status === 200 && isEnvelope(outcome.envelope) && outcome.envelope.ok === true
    && typeof state === 'string' && ['pending', 'ok', 'partial', 'failed'].includes(state)
    && typeof outcome.envelope.value.generation === 'number'
    && typeof outcome.envelope.value.at === 'number'
    && Array.isArray(outcome.envelope.value.failed),
  `variantStatus answers 200 {ok:true} carrying a bounded outcome (got state=${JSON.stringify(state)})`)
  // A host WITHOUT this case answers {ok:false, error:'unknown method "variantStatus"'} — and
  // that refusal is exactly what the client's fallback branch is written against, so reading it
  // as a pass would let the client's fallback silently become the only tested path. The error
  // field is where the missing case names itself, which is what makes this half discriminating.
  assert(!/variantStatus/.test(String(outcome.envelope?.error ?? '')),
    'the positive half above is a real case, not a route that merely answered 200')

  // ── 6. describe answers the manifest, live ──────────────────────────────
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const declared = manifest?.dsh?.compatibility?.dshReleases
  assert(declared !== undefined && typeof declared === 'object' && !Array.isArray(declared)
    && Object.keys(declared).length > 0,
    `package.json declares a non-empty dsh.compatibility.dshReleases (${Object.keys(declared ?? {}).length} entries)`)
  const described = await post({ method: 'describe' })
  assert(described.status === 200 && described.envelope?.ok === true, 'describe answers {ok:true}')
  const runtime = described.envelope?.value
  assert(Array.isArray(runtime?.releases), 'describe reports a releases array')
  const runtimeIds = (runtime?.releases ?? []).map((entry) => entry.id).sort()
  const declaredIds = Object.keys(declared ?? {}).sort()
  assert(JSON.stringify(runtimeIds) === JSON.stringify(declaredIds),
    `describe's release ids equal package.json's (runtime ${runtimeIds.length} vs manifest ${declaredIds.length}; ` +
      `missing ${JSON.stringify(declaredIds.filter((id) => !runtimeIds.includes(id)))} ` +
      `extra ${JSON.stringify(runtimeIds.filter((id) => !declaredIds.includes(id)))})`)
  const runtimeStatuses = (runtime?.releases ?? [])
    .map((entry) => `${entry.id}=${entry.status}`)
    .sort()
    .join(',')
  const declaredStatuses = Object.entries(declared ?? {})
    .map(([id, status]) => `${id}=${status}`)
    .sort()
    .join(',')
  assert(runtimeStatuses === declaredStatuses,
    'describe reports each release with the status the manifest declares')
  assert(runtime?.version === manifest?.version,
    `describe reports package.json's version (runtime ${runtime?.version} vs manifest ${manifest?.version})`)

  // ── 7. the headers the code sets ────────────────────────────────────────
  for (const [label, answer] of [
    ['200 ok', allowed],
    ['403 loopback fence', foreignPeer],
    ['405 method fence', await post(undefined, { method: 'GET' })],
    ['200 {ok:false} dispatch error', unknown],
  ]) {
    assert(answer.headers.get('content-type') === 'application/json; charset=utf-8',
      `${label}: content-type is application/json; charset=utf-8`)
    assert(answer.headers.get('cache-control') === 'no-store', `${label}: cache-control is no-store`)
    assert(answer.headers.get('x-content-type-options') === 'nosniff', `${label}: nosniff is set`)
  }

  // ── 8. check: the path and distro gates ─────────────────────────────────
  const relative = await post({ method: 'check', params: { distro: 'Ubuntu', path: 'relative/dir' } })
  assert(relative.status === 200 && relative.envelope?.ok === false
    && /path/.test(String(relative.envelope.error)) && !/distro/.test(String(relative.envelope.error)),
    `check with a relative path answers {ok:false} naming path ("${relative.envelope?.error ?? ''}")`)

  // The distro gate runs BEFORE the UNC is built (src/index.ts:315-319: requireDistro,
  // then requireLinuxPath, then joinUnc/statSync). That ordering is what makes this
  // discriminating rather than message-matching: both paths below carry a perfectly
  // valid absolute Linux path, so if the bad distro reached joinUnc the 9P read would
  // simply miss and the route would answer the SUCCESS shape
  // {ok:true, value:{exists:false, isDirectory:false}} — never {ok:false} naming distro.
  for (const badDistro of ['..', '../evil', 'a/b', 'C:\\evil', 'Ubuntu/..']) {
    const answer = await post({ method: 'check', params: { distro: badDistro, path: '/home/none/such/dir' } })
    assert(answer.status === 200 && isEnvelope(answer.envelope) && answer.envelope.ok === false
      && /distro/.test(String(answer.envelope.error)),
      `check with distro ${JSON.stringify(badDistro)} answers {ok:false} naming distro`)
    assert(!(answer.envelope?.ok === true && answer.envelope?.value?.exists === false),
      `check with distro ${JSON.stringify(badDistro)} did not fall through to a constructed UNC read`)
  }

  // ── 8b. a path that exists but cannot be read must not be called absent ──
  // `src/index.ts:319-325` folds ANY `statSync` throw into `{exists:false}`, so the dialog
  // answers "this directory does not exist" for a path that is there and merely unreadable —
  // and then offers to create a workspace on top of it. This is #44 §6's visible one; the
  // product fix was stripped out of this branch by ruling, so the assertion below is RED on
  // purpose and is the reproduction, not a regression.
  //
  // Tier: win32, and the fixture is the OS's own machinery rather than a stubbed fs, measured
  // on this machine before writing it: a junction cycle makes `statSync` throw
  // `code=ELOOP errno=-4067`, while `chmod 000` on the parent or the directory does NOT deny
  // stat on Windows (measured: NO THROW) — that is why the shape is a reparse loop, not a
  // permission bit. The posix tier is declared, not passed: `joinUnc` there produces a
  // `\\wsl.localhost\…` string that is only a filename, so no unreadable-but-existing path is
  // reachable through this route on the ubuntu runner.
  if (process.platform !== 'win32') {
    skip('an unreadable existing path is not reported as absent',
      'no unreadable-but-existing path is reachable through this route on posix')
  } else {
    const loopRoot = mkdtempSync(join(tmpdir(), 'dsh-route-envelope-loop-'))
    try {
      const dirA = join(loopRoot, 'A')
      mkdirSync(dirA)
      symlinkSync(dirA, join(dirA, 'J'), 'junction')
      const deep = join(dirA, ...Array.from({ length: 40 }, () => 'J'))
      let statCode
      try {
        statSync(deep)
        statCode = 'NO THROW'
      } catch (error) {
        statCode = String(error?.code)
      }
      // The premise, asserted: if the fixture stopped producing a non-absent error, this line
      // goes red rather than the case below quietly passing on nothing.
      assert(statCode !== 'NO THROW' && statCode !== 'ENOENT' && statCode !== 'ENOTDIR',
        `the fixture really makes statSync throw something other than "absent" (got ${statCode})`)
      const winToMnt = (winPath) => {
        const driven = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
        return driven === null ? null
          : `/mnt/${String(driven[1]).toLowerCase()}/${String(driven[2]).replace(/[\\/]+/g, '/')}`
      }
      const mnt = winToMnt(deep)
      assert(mnt !== null, `the Windows fixture has a /mnt spelling the route accepts (${deep})`)

      const unreadable = await post({ method: 'check', params: { distro: 'Ubuntu', path: mnt } })
      assert(unreadable.status === 200 && isEnvelope(unreadable.envelope),
        `check on the unreadable path still answers an envelope (status ${unreadable.status})`)
      assert(!(unreadable.envelope?.ok === true && unreadable.envelope?.value?.exists === false),
        `an unreadable existing path is NOT answered as {exists:false} (got `
          + `${JSON.stringify(unreadable.envelope?.value ?? unreadable.envelope?.error ?? null)})`)

      // The half that must stay true after the fix: a genuinely absent path is still "absent",
      // not an error. Without it the red above could be "closed" by making every read fail.
      const absent = await post({ method: 'check',
        params: { distro: 'Ubuntu', path: winToMnt(join(loopRoot, 'no-such-directory-here')) } })
      assert(absent.envelope?.ok === true && absent.envelope?.value?.exists === false,
        `a path that really is missing still answers {exists:false} (got `
          + `${JSON.stringify(absent.envelope?.value ?? absent.envelope?.error ?? null)})`)
    } finally {
      rmSync(loopRoot, { recursive: true, force: true })
    }
  }

  // ── 8c. check: a symlinked DIRECTORY is a directory (issue #10) ─────────
  // The 9P share describes a Linux symlink as a reparse point and `statSync` reports
  // BOTH link kinds as a plain non-directory file, so `check` used to answer
  // {exists:true, isDirectory:false} for a linked project directory — and the add-workspace
  // dialog then refused it as path-not-found (AddWslWorkspace.tsx:239/269). Measured on the
  // live share before the fix: dir link, file link and broken link all stat {isDirectory:false,
  // isFile:true, isSymbolicLink:false}; `lstatSync` is what separates them (EISDIR vs a file),
  // and `wsl.exe readlink -f` returns the link's IMMEDIATE target (one hop), which the route
  // then stats.
  //
  // Tier: this case needs a live distribution, which this suite cannot assume — `check` reaches
  // the real share only through a running distro. So it follows the suite's same TWO-part
  // gating as the unreachable-platform halves above: probe with the real wsl.exe FIRST and SKIP
  // loudly (never pass) when no distro answers, exactly as the non-win32 branch skips on win32.
  // Everything else in the file stays independent of a distro, so a machine without WSL still
  // gets the full non-skipped suite.
  const distroList = await (async () => {
    try {
      const probed = await execFileResult('wsl.exe', ['-l', '-q'], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
      const names = String(probed.stdout ?? '').replace(/\0/g, '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
      return names.length > 0 ? names : undefined
    } catch {
      return undefined
    }
  })()

  if (distroList === undefined) {
    skip('a symlinked directory is reported as a directory by check',
      'no live WSL distribution answered `wsl.exe -l -q` on this machine')
  } else {
    const distro = distroList[0]
    // The probe asserted the premise: a distro that answers `-l -q` must also serve its share.
    const probe = await execFileResult('wsl.exe',
      ['-d', distro, '--', 'sh', '-c', 'echo ok'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert(String(probe.stdout ?? '').trim() === 'ok',
      `the live distribution ${JSON.stringify(distro)} can run a command (${JSON.stringify(String(probe.stdout ?? '').trim())})`)

    // Fixture under /tmp, removed in the finally: a real directory, a real file, a directory
    // link, a file link and a broken link. `-s`/`-n` keep every creation idempotent.
    const fixture = `/tmp/dsh-route-envelope-links-${process.pid}`
    const run = (command) => execFileResult('wsl.exe',
      ['-d', distro, '--', 'sh', '-c', command],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const created = await run(
      `rm -rf ${fixture}/real-dir ${fixture}/real-file ${fixture}/link-dir ${fixture}/link-file ${fixture}/link-broken ${fixture}/no-such; `
      + `mkdir -p ${fixture}/real-dir && printf x > ${fixture}/real-file `
      + `&& ln -sfn ${fixture}/real-dir ${fixture}/link-dir `
      + `&& ln -sfn ${fixture}/real-file ${fixture}/link-file `
      + `&& ln -sfn ${fixture}/no-such ${fixture}/link-broken`)
    assert(String(created.stdout ?? '').trim() === '' && (created.stderr ?? '') === '',
      `the symlink fixture was created under ${fixture}`)

    // The fixture premise, asserted: the share really does misreport the link as a non-directory.
    // Without this line the case below could pass on a share that stopped describing links.
    const linkOnShare = statSync(`\\\\wsl.localhost\\${distro}${fixture.replace(/\//g, '\\')}\\link-dir`)
    assert(linkOnShare.isDirectory() === false,
      'the fixture premise: the share itself reports the directory link as not-a-directory')
    assert(linkOnShare.isFile() === true,
      'the fixture premise: the share reports the directory link as a plain file '
        + '(which is why statSync alone cannot answer this)')

    try {
      const dirLink = await post({ method: 'check', params: { distro, path: `${fixture}/link-dir` } })
      assert(dirLink.status === 200 && dirLink.envelope?.ok === true
        && dirLink.envelope?.value?.exists === true && dirLink.envelope?.value?.isDirectory === true,
        `check reports a symlinked directory as a directory (got `
          + `${JSON.stringify(dirLink.envelope?.value ?? dirLink.envelope?.error ?? null)})`)

      // The discriminating half: a link to a real FILE must still be "not a directory", or the
      // fallback could "close" the case above by calling every link a directory.
      const fileLink = await post({ method: 'check', params: { distro, path: `${fixture}/link-file` } })
      assert(fileLink.envelope?.ok === true && fileLink.envelope?.value?.exists === true
        && fileLink.envelope?.value?.isDirectory === false,
        `check still reports a symlinked file as not-a-directory (got `
          + `${JSON.stringify(fileLink.envelope?.value ?? fileLink.envelope?.error ?? null)})`)

      // A link the distribution cannot resolve keeps its pre-existing "exists, not a directory"
      // answer: it must NOT become not-found, or a broken link would look like a missing path.
      const brokenLink = await post({ method: 'check', params: { distro, path: `${fixture}/link-broken` } })
      assert(brokenLink.envelope?.ok === true && brokenLink.envelope?.value?.exists === true
        && brokenLink.envelope?.value?.isDirectory === false,
        `check does not turn an unresolvable link into not-found (got `
          + `${JSON.stringify(brokenLink.envelope?.value ?? brokenLink.envelope?.error ?? null)})`)

      // The fast path and the plain-directory answer must be untouched.
      const realDir = await post({ method: 'check', params: { distro, path: `${fixture}/real-dir` } })
      assert(realDir.envelope?.value?.exists === true && realDir.envelope?.value?.isDirectory === true,
        `check still reports a real directory as a directory (got ${JSON.stringify(realDir.envelope?.value ?? null)})`)
      const absent = await post({ method: 'check', params: { distro, path: `${fixture}/no-such` } })
      assert(absent.envelope?.value?.exists === false && absent.envelope?.value?.isDirectory === false,
        `check still reports a missing path as absent (got ${JSON.stringify(absent.envelope?.value ?? null)})`)
    } finally {
      await run(`rm -rf ${fixture}`)
    }
  }

  // ── 10. setUser: refused before any registry call ──────────────────────
  // The store is DSH_HOME/wsl-workspaces.json. A sentinel is planted, then a non-UNC
  // path is offered WITH a username: had requireWslUnc not thrown first, the registry
  // write would have rewritten the file. Untouched bytes are the observable.
  const store = join(home, 'wsl-workspaces.json')
  const sentinel = { '\\\\wsl.localhost\\SentinelDistro\\home\\kept': { username: 'keptuser' } }
  writeFileSync(store, JSON.stringify(sentinel, null, 2) + '\n', 'utf8')
  const before = readFileSync(store, 'utf8')
  for (const badPath of ['C:\\Users\\me\\project', '/home/me/project', '\\\\otherhost\\share\\x']) {
    const answer = await post({ method: 'setUser', params: { path: badPath, username: 'attacker' } })
    assert(answer.status === 200 && isEnvelope(answer.envelope) && answer.envelope.ok === false
      && /path/.test(String(answer.envelope.error)),
      `setUser with a non-UNC path ${JSON.stringify(badPath)} is refused naming path`)
  }
  const after = readFileSync(store, 'utf8')
  assert(after === before, 'the registry store is byte-for-byte untouched after the refused setUser calls')
  assert(!after.includes('attacker'), 'no refused setUser left a username in the registry store')

  // ── 9. an empty picker is a reported failure (fake spawn, child process) ─
  // `listDistros()` cannot be answered honestly in this process: without the fake it
  // would run the real wsl.exe. So this one assertion runs in a child with
  // tests/support/fake-child-process.mjs installed via --import, scripted so wsl.exe
  // cannot start at all — the visible shape of issues #35/#36.
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\WINDOWS'
  const absoluteCandidate = `${systemRoot.replace(/[\\/]+$/, '')}\\System32\\wsl.exe`
  const scriptPath = join(work, 'list-distros-failure.json')
  writeFileSync(scriptPath, JSON.stringify({
    calls: [
      { match: { file: 'wsl.exe', argsContains: ['-l'] }, code: 'ENOENT' },
      { match: { file: absoluteCandidate, argsContains: ['-l'] }, code: 'ENOENT' },
    ],
    default: 'error',
  }, null, 2), 'utf8')
  const fakeModule = pathToFileURL(join(repo, 'tests', 'support', 'fake-child-process.mjs')).href
  const probePath = join(work, 'list-distros-probe.mjs')
  writeFileSync(probePath, `
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { fakeArmed, fakeCalls } from ${JSON.stringify(fakeModule)}
const { apply } = await import(${JSON.stringify(pathToFileURL(join(repo, 'lib', 'index.js')).href)})
const registrations = []
const ctx = {
  get: (key) => key === 'webServer'
    ? { register: (route) => { registrations.push(route); return () => {} } }
    : undefined,
  effect: (fn) => { fn(); return () => {} },
}
apply(ctx, { route: '/api' })
const server = createServer((req, res) => { req.on('error', () => {}); registrations[0].handler(req, res) })
await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
const port = server.address().port
let report = {}
try {
  const response = await fetch('http://127.0.0.1:' + port + '/api', {
    method: 'POST',
    body: JSON.stringify({ method: 'listDistros' }),
    signal: AbortSignal.timeout(20000),
  })
  report = {
    status: response.status,
    envelope: await response.json(),
    armed: fakeArmed(),
    calls: fakeCalls().map((call) => ({ file: call.file, args: call.args, matched: call.matched })),
  }
} finally {
  server.close()
}
console.log('PROBE:' + JSON.stringify(report))
`, 'utf8')

  const probe = spawnSync(process.execPath,
    ['--import', fakeModule, probePath],
    {
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, DSH_FAKE_CHILD_PROCESS: scriptPath },
    })
  const line = (probe.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('PROBE:'))
  if (line === undefined) {
    failures += 1
    console.error(`not ok: the listDistros probe produced no report (exit ${probe.status}): `
      + `${String(probe.stderr ?? '').slice(-400)}`)
  } else {
    const report = JSON.parse(line.slice('PROBE:'.length))
    assert(report.armed === true, 'the listDistros probe reached the faked child_process (positive control)')
    assert((report.calls ?? []).length > 0 && (report.calls ?? []).every((call) => call.matched === true),
      `every spawn the probe made was answered by the script, so nothing reached a real wsl.exe (${JSON.stringify(report.calls)})`)
    assert(report.status === 200 && report.envelope?.ok === false,
      `an unstartable wsl.exe answers 200 {ok:false}, not a 500 (got ${report.status} ${JSON.stringify(report.envelope?.ok)})`)
    assert(report.envelope?.ok === false,
      'a discovery that cannot run is a REPORTED failure, not an empty distribution list')
    assert(!(report.envelope?.ok === true && Array.isArray(report.envelope?.value)
      && report.envelope.value.length === 0),
      `the route never answers {ok:true, value: []} when wsl.exe cannot start (got ${JSON.stringify(report.envelope)})`)
    assert(/wsl\.exe|is WSL installed|cannot list WSL distributions/i.test(String(report.envelope?.error)),
      `the reported failure names wsl.exe / the failure itself ("${String(report.envelope?.error).slice(0, 180)}")`)
  }

  if (process.platform !== 'win32') {
    // The ticket's literal assertion 9: on non-win32 the picker must not answer
    // {ok:true, value: []}. Run the same probe WITHOUT the fake installed — no --import,
    // no script env — so this is the real platform, not a simulation. The forbidden shape
    // is the silent empty list; a machine that genuinely has a wsl.exe on PATH answering a
    // real list is a legitimate success and is allowed.
    const native = spawnSync(process.execPath, [probePath], {
      encoding: 'utf8',
      timeout: 90_000,
      env: (() => {
        const env = { ...process.env }
        delete env.DSH_FAKE_CHILD_PROCESS
        return env
      })(),
    })
    const nativeLine = (native.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('PROBE:'))
    if (nativeLine === undefined) {
      failures += 1
      console.error(`not ok: the native non-win32 listDistros probe produced no report `
        + `(exit ${native.status}): ${String(native.stderr ?? '').slice(-400)}`)
    } else {
      const nativeReport = JSON.parse(nativeLine.slice('PROBE:'.length))
      assert(nativeReport.armed === false,
        'the native probe ran with no fake installed (the platform itself answered)')
      const silentEmpty = nativeReport.envelope?.ok === true && Array.isArray(nativeReport.envelope?.value)
        && nativeReport.envelope.value.length === 0
      assert(silentEmpty === false,
        `on ${process.platform} the route never answers {ok:true, value: []} for an unavailable `
          + `wsl.exe (got ${JSON.stringify(nativeReport.envelope).slice(0, 200)})`)
      if (nativeReport.envelope?.ok === false) {
        assert(/wsl\.exe|is WSL installed|cannot list WSL distributions/i.test(String(nativeReport.envelope.error)),
          `the native non-win32 failure names wsl.exe / the failure itself `
            + `("${String(nativeReport.envelope.error).slice(0, 160)}")`)
      } else {
        console.log(`note: this ${process.platform} host resolved a real distribution list `
          + `(${(nativeReport.envelope?.value ?? []).length} entries), so the reported-failure half of `
          + 'assertion 9 is pinned by the faked scenario above; the silent-empty shape is pinned here.')
      }
    }
  } else {
    skip('the native non-win32 listDistros run', 'this run is win32, so no non-win32 platform is reachable')
    console.log('note: on win32 the literal non-win32 branch above is unreachable, so assertion 9 pins the '
      + 'same contract by making wsl.exe unstartable. That is equivalent, not a stand-in: '
      + 'wslExecutableCandidates() and listDistros() read no platform flag at all, so "not win32" and '
      + '"wsl.exe cannot start" reach the same code path.')
  }
} finally {
  if (server !== undefined) server.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0
  ? `${NAME} PASSED${skips > 0 ? ` (${skips} skipped — a skip is not a pass)` : ''}`
  : `${NAME} FAILED (${failures} failing)`)
process.exit(failures === 0 ? 0 : 1)
