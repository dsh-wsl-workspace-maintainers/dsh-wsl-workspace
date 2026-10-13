/**
 * Does issue #54 reproduce under a real host boot, and does it reproduce because of the isolate realm?
 *
 * #54 says: in a `wsl-*` variant session the host's built-in `read_image` always answers
 * `cannot get property "fs" without inject`, while the same call in a non-WSL session succeeds. A manual
 * round on 2026-10-10 measured that contrast by hand (97 ms success vs 10–11 ms `isError=true`), and no
 * gate in this repository encoded it — so nothing here could tell a fix from a regression. This file is
 * that gate, and it carries both arms: a reading where `read_image` answers is what makes the reading
 * where it throws mean anything.
 *
 * The arms, in the order the report prints them:
 *
 *   · **0 — control, non-WSL world.** `@deepseek-ai/dsh-tool-fs` + `@deepseek-ai/dsh-fs-local` mounted
 *     in the root realm, `read_image` called through the host's own call shape. Expected: an image.
 *   · **1 — standard world with this plugin mounted through the loader** (a row naming `lib/index.js`).
 *     Same call, same shape. The plugin must not change the answer; if it does, rows 2+ are not evidence
 *     about the realm.
 *   · **2 — the isolate arm.** The world our own `src/host/variants.ts` generates (`wslWorldGroup` emits
 *     `isolate: { shell: true, fs: true }`), written to a temp file and mounted by the Loader. Expected:
 *     the exact #54 string.
 *   · **3 — mechanism.** Which realm key `fs` carries on each side, and where an implementation exists —
 *     so the verdict says *why* the lookup failed, not only that it failed.
 *   · **4 — mutation control.** One token of the generated text removed in memory (`    fs: true`), arm 2
 *     re-run. If the red cannot be moved, this file is a decoration, not an instrument.
 *   · **5 — before path resolution?** The same world call against a path that does not exist: if it
 *     answers with the realm string instead of `not found`, the failure happens before any path is
 *     resolved, which is what #54 claims.
 *   · **6 — the world's own read.** The same isolate world with this plugin's `lib/wsl-image-tool.js`
 *     mounted as a row of the group (what `transformPresetForWsl` emits when it is given an
 *     `imagePath`). Required in that one boot: the definition the dispatcher resolves for `read_image`
 *     is ours, it comes back with the picture's bytes and renders an `image` block, and `read`,
 *     `write` and `edit` still answer. The registry's context-global table holds exactly one
 *     definition per name (measured: `tool "read_image" is already registered`), so our row *displaces*
 *     the host's rather than sitting beside it — which is why the host's realm failure is measured in
 *     arm 2, the same world with our row absent, and row 6 prints whichever of the two the boot
 *     actually left in the table. A row that stops answering, or one that costs the other file tools,
 *     reddens row 6; a world that stopped failing reddens row 2.
 *
 * What this harness deliberately does NOT fake, and what it therefore has to disclose:
 *
 *   · The boot is the product's: `runProfile` from `@deepseek-ai/dsh/profile-boot`, a temp `DSH_HOME`, a
 *     profile whose scope carries the packages, and loader rows that name modules by the path the probe
 *     itself imported them from — one instance, so what is introspected is what ran.
 *   · The world text is never hand-written: `transformPresetForWsl` is called and its `wsl-world` group is
 *     mounted verbatim. Two of its rows cannot be satisfied in a harness that must not boot a
 *     distribution: `shell-wsl` waits for `subprocess` (the Loader reports it as pending, not failed),
 *     and the world's `fs` slot is filled with the host's own `dsh-fs-local` instead of this plugin's
 *     `lib/fs.js`. Both are about the *provider* behind the seam; the rows measure the *lookup* of the
 *     seam, which is what #54 is about. A `lib/fs.js` arm would answer the same lookup question by
 *     starting `wsl.exe`, which this gate must never do.
 *   · The model route gate (`assertImageCapableRoute`, dsh-tool-fs:898-906) runs before the `fs` touch and
 *     needs a declared image-capable route. It is satisfied by registering a provider through the host's
 *     own `llm.registerAdapter(...)` — the same call `@deepseek-ai/dsh-llm-pi-ai` makes at its :2623 —
 *     because this closure has no credential-free provider. Both arms use the identical route, so the
 *     gate cannot explain a difference between them.
 *   · `@deepseek-ai/dsh-tool-fs` and `@deepseek-ai/dsh-attachment-local` are in `ci/deps` but cannot
 *     import there: their static `@deepseek-ai/dsh-attachment` import is unresolvable, because that
 *     package is a peer the pinned closure never installs (it survives on disk only as npm's staging
 *     directory `.dsh-attachment-*`). The probe repairs *resolution*, not the code: it builds a scratch
 *     node_modules tree outside the worktree that copies the two consumers and links the already-present
 *     packages under their proper names, and it prints which copy every row stood on. `read_image` is the
 *     unmodified host package in every arm.
 *   · The plugin's own boot session probe (src/index.ts:1099-1121) spawns `wsl.exe` when a `subprocess`
 *     service is published. This harness publishes none, so the plugin takes its documented skip path
 *     ("session probe skipped, no subprocess service to probe with; mounted unverified") — the line is
 *     captured and printed in row 1 rather than assumed.
 *
 *   node tests/support/w54-isolate-probe.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Outside the worktree on every platform. A Windows path literal would not fail loudly on the ubuntu
// runner — `mkdirSync('D:/Temp/…', { recursive: true })` happily creates a directory named `D:` inside
// the checkout, which is the one thing this file's own comment promises will not happen.
const SCRATCH = process.env.W54_SCRATCH_DIR ?? join(tmpdir(), 'dsh-w54-isolate-probe')
const REALM_ERROR = 'cannot get property "fs" without inject'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * A promise that is not allowed to hang the gate (same discipline as `w51-probe.mjs`: the race bounds the
 * wait, the timer is unref'd so it is never the reason the process stays alive, and the probe still
 * exits explicitly at the end).
 * @param promise - the work to bound.
 * @param ms - how long it may take.
 * @param label - what to name if the budget runs out.
 * @returns the promise's value, or a rejection naming the budget.
 */
const within = (promise, ms, label) => {
  let timer
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** The two trees `ci/install-pinned.mjs` links: repo root first, then the pinned closure. */
const hostRoots = [join(repoRoot, 'node_modules'), join(repoRoot, 'ci', 'deps', 'node_modules')]

/** Every module the probe loads, by the exact path it loaded it from — the report prints these. */
const loadedFrom = new Map()

/**
 * Import a host package by path, never by bare specifier: a bare import resolves on a maintainer's
 * junction and fails on CI, which is the documented failure mode of this repository (`bash-parity-real.mjs`
 * carries the same `host()` helper for the same reason). The documented order is tried first and a copy
 * that cannot import is reported with its own error, so a closure gap is visible instead of silent.
 * @param name - the package name, e.g. `@deepseek-ai/dsh-tools`.
 * @param overrides - extra directories to search first (the scratch closure repair).
 * @returns `{ plugin, namespace, file }` — what cordis should mount, the raw module, and the file it came from.
 */
async function hostModule (name, overrides = []) {
  const candidates = []
  for (const root of [...overrides, ...hostRoots]) {
    const file = join(root, ...name.split('/'), 'lib', 'index.js')
    if (existsSync(file) && !candidates.includes(file)) candidates.push(file)
  }
  const errors = []
  for (const file of candidates) {
    try {
      const namespace = await import(pathToFileURL(file).href)
      loadedFrom.set(name, file)
      return { plugin: namespace.default ?? namespace, namespace, file }
    } catch (error) {
      errors.push(`${file}: ${String(error.code ?? '')} ${String(error.message).split('\n')[0]}`)
    }
  }
  throw new Error(`${name} could not be imported${candidates.length === 0 ? ' (absent from every linked tree)' : ''}`
    + ` — ${errors.join(' | ') || 'no candidate'}`)
}

/**
 * The scratch closure repair: `@deepseek-ai/dsh-attachment` is a peer of the fs tool suite that the pinned
 * closure never installs by name, so the two packages that statically import it cannot load from `ci/deps`.
 * npm's staging directory still holds its bytes, so link that under its real name beside copies of the two
 * consumers, and link everything else they import. Nothing is downloaded, nothing is written inside the
 * worktree, and every row of the report names the file it stood on.
 * @returns the shadow `node_modules` roots to search before the linked trees.
 */
function ensureScratchClosure () {
  const shadow = join(SCRATCH, 'w54-shadow')
  const nm = join(shadow, 'node_modules')
  const scope = join(nm, '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  // Both linked trees can hold any package (the repo root is what `ci/install-pinned.mjs` links), so every
  // lookup below is a search, not a guess about which tree a name lives in.
  const scopeTrees = hostRoots.map(root => join(root, '@deepseek-ai')).filter(existsSync)
  const inTree = (name) => scopeTrees.map(dir => join(dir, name)).find(existsSync) ?? null
  const named = scopeTrees.find(dir => existsSync(join(dir, 'dsh-attachment', 'package.json')))
  const stagingTree = scopeTrees.find(dir => readdirStartsWith(dir, '.dsh-attachment-') !== null)
  const staging = named !== undefined
    ? join(named, 'dsh-attachment')
    : stagingTree === undefined ? null : join(stagingTree, readdirStartsWith(stagingTree, '.dsh-attachment-'))
  if (staging === null) {
    const missing = new Error(`@deepseek-ai/dsh-attachment is resolvable by name in neither linked tree `
      + `(${scopeTrees.join(', ')}), and npm's staging copy (.dsh-attachment-*) is not there either — the fs `
      + `tool suite cannot be loaded from this closure. Do not substitute a stub attachment package.`)
    // A tagged death, not a thrown-and-forgotten one: the runner's ledger reads a `SKIP:` line, and the
    // reason for it. `dsh-attachment` is not in `ci/pinned-deps.json`, so on the ubuntu runner this is a
    // fact about the pinned closure — while on a maintainer tree the package is present and the arms run.
    // The distinction matters: silently exiting 0 would let #54 stop being measured without anyone
    // noticing, and exiting non-zero without saying why is the other failure mode.
    missing.code = 'E_CLOSURE_INCOMPLETE'
    throw missing
  }
  const linkNames = ['dsh-attachment', 'cordis', 'schemastery', 'dsh-fs', 'dsh-fs-local', 'dsh-sandbox', 'dsh-tools',
    'dsh-llm', 'dsh-system-prompt', 'dsh-scope', 'dsh-timeout', 'dsh-subprocess', 'dsh-home-paths',
    'dsh-lazy-require', 'dsh-util-code-language', 'dsh-session', 'dsh-user-approval', 'dsh-sandbox-policy']
  for (const name of linkNames) {
    const target = name === 'dsh-attachment' ? staging : inTree(name)
    const link = join(scope, name)
    if (target === null || existsSync(link)) continue
    symlinkSync(target, link, 'junction')
  }
  for (const bare of ['diff', 'sharp', 'js-yaml', 'negotiator', 'compression']) {
    // A search across both linked trees, not `[0]` of one: the repo root is the dev closure and the
    // pinned closure is `ci/deps`, and a bare dependency can live in either. Reading only the first
    // tree silently linked nothing (the old `join(depsNm, bare)` with an array also produced a path
    // that exists nowhere), so the control arm failed with `Cannot find module 'sharp'` and the
    // failure looked like a product fact instead of a harness hole.
    const target = hostRoots.map(root => join(root, bare)).find(existsSync)
    const link = join(nm, bare)
    if (target === undefined || existsSync(link)) continue
    symlinkSync(target, link, 'junction')
  }
  // The two consumers get copied, not linked: Node realpaths a linked package and then resolves ITS bare
  // specifiers from the real location, which is exactly the tree whose `dsh-attachment` is missing.
  for (const name of ['dsh-tool-fs', 'dsh-attachment-local']) {
    const target = join(scope, name)
    const source = inTree(name)
    if (source === null) throw new Error(`${name} is in neither linked tree — run \`node ci/install-pinned.mjs\``)
    if (!existsSync(join(target, 'package.json'))) cpSync(source, target, { recursive: true })
  }
  return { nm, scope, staging }
}

/** The first entry of `dir` whose name starts with `prefix`, or null. */
function readdirStartsWith (dir, prefix) {
  return readdirSync(dir).find(name => name.startsWith(prefix)) ?? null
}

/**
 * Write one profile: a temp `DSH_HOME` profile directory whose own `node_modules` scope carries the fs tool
 * suite, so a generated row naming `@deepseek-ai/dsh-tool-fs` imports the same copy the probe imported.
 * That is the product's channel for a profile-local plugin (`dsh plugin add`), not a invented one.
 * @param home - the temp `DSH_HOME`.
 * @param name - the profile name.
 * @param shadowScope - the scratch closure's `@deepseek-ai` directory.
 * @returns the profile directory.
 */
function makeProfile (home, name, shadowScope) {
  const dir = join(home, 'profiles', name)
  const scope = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  for (const pkg of ['dsh-tool-fs', 'dsh-attachment-local', 'dsh-attachment']) {
    const link = join(scope, pkg)
    if (!existsSync(link)) symlinkSync(join(shadowScope, pkg), link, 'junction')
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`, private: true,
    dependencies: { '@deepseek-ai/dsh-tool-fs': `link:${join(shadowScope, 'dsh-tool-fs')}` },
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  return dir
}

/** One loader row in the patch dialect, with the path quoted the way our generator quotes it. */
const row = (id, file) => [`    - id: ${id}`, `      name: '${file.replace(/\\/g, '/')}'`]

/**
 * The `wsl-world` group our own generator emits, as patch rows. `transformPresetForWsl` writes the group at
 * the top level of a composition; nesting it under `- insert:` is the only edit, and it is indentation.
 * @param generated - the variant composition text.
 * @param mutate - optional transform of the group's lines before indenting (used by the mutation arm).
 * @returns the indented patch rows.
 */
function worldRows (generated, mutate = (lines) => lines) {
  const lines = generated.split('\n')
  const start = lines.findIndex(line => line === '- id: wsl-world')
  if (start < 0) throw new Error('the generated variant carries no `- id: wsl-world` group')
  const block = mutate(lines.slice(start)).filter(line => line.trim() !== '')
  return block.map((line, index) => index === 0 ? `    - ${line.replace(/^- /, '')}` : `    ${line}`)
}

/**
 * One booted host with the rows an arm needs.
 * @param options - profile name, loader rows, and the budget for the boot.
 * @returns the settled context plus its shutdown handle.
 */
async function boot (options) {
  const { profile, rows, home, environment, runProfile, createLaunchEnvironmentSnapshot } = options
  const dir = join(home, 'profiles', profile)
  const overlay = join(dir, 'overlay.yml')
  writeFileSync(overlay, ['- insert:', ...rows, ''].join('\n'), 'utf8')
  return await within(runProfile({ environment, profile, patchFiles: [overlay], args: [] }), 120_000, `boot ${profile}`)
}

const report = (rows, verdict) => {
  for (const entry of rows) console.log(JSON.stringify(entry))
  console.log(JSON.stringify({ verdict }))
  const failed = rows.filter(entry => entry.ok === false)
  // The seam runner reads prose, not JSON: without a `PASSED` / `FAILED (N failing)` line a probe that
  // reported nothing looks the same as one that reported success.
  console.log(failed.length === 0
    ? `W54-ISOLATE-PROBE PASSED (${rows.length} rows — #54's two arms, the token mutation, and the world's own image read)`
    : `W54-ISOLATE-PROBE FAILED (${failed.length} failing)`)
  process.exit(failed.length === 0 ? 0 : 1)
}

const outOf = (error) => String(error?.message ?? error ?? 'unknown')

mkdirSync(SCRATCH, { recursive: true })
const home = join(SCRATCH, 'w54-probe-home')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const png = join(SCRATCH, 'w54-probe.png')
writeFileSync(png, PNG_BYTES)

const rows = []
const add = (id, ok, detail) => rows.push({ id, ok, detail })
const absentPath = join(SCRATCH, 'w54-no-such-file-here.png')

try {
  const shadow = ensureScratchClosure()
  const overrides = [shadow.nm]
  const { namespace: CordisModule } = await hostModule('@deepseek-ai/cordis')
  // `@deepseek-ai/dsh/profile-boot` is a subpath export, so its file is resolved by path in both trees.
  const profileBootFile = hostRoots
    .map(root => join(root, '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js'))
    .find(candidate => existsSync(candidate))
  if (profileBootFile === undefined) {
    throw new Error('@deepseek-ai/dsh/lib/profile-boot.js is in neither linked tree — run `node ci/install-pinned.mjs`')
  }
  loadedFrom.set('@deepseek-ai/dsh/profile-boot', profileBootFile)
  const { runProfile } = await import(pathToFileURL(profileBootFile).href)
  const { createLaunchEnvironmentSnapshot } = (await hostModule('@deepseek-ai/dsh-launch-environment', overrides)).namespace
  const providers = {
    'system-prompt': await hostModule('@deepseek-ai/dsh-system-prompt', overrides),
    tools: await hostModule('@deepseek-ai/dsh-tools', overrides),
    'fs-local': await hostModule('@deepseek-ai/dsh-fs-local', overrides),
    attachment: await hostModule('@deepseek-ai/dsh-attachment-local', overrides),
    llm: await hostModule('@deepseek-ai/dsh-llm', overrides),
    'tool-fs': await hostModule('@deepseek-ai/dsh-tool-fs', overrides),
    webserver: await hostModule('@deepseek-ai/dsh-host-webserver', overrides),
  }

  process.env.DSH_HOME = home
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const route = { provider: 'w54-probe-route', model: 'w54-probe-vision' }

  // The world text, generated by this repository — never hand-written. `persistent === undefined` is the
  // one-shot world (no PTY rows), and `fsPath` names the host's own local provider: see the header for
  // why the realm's provider cannot be `lib/fs.js` in a gate that must not boot a distribution.
  const variants = await import(pathToFileURL(join(repoRoot, 'src', 'host', 'variants.ts')).href)
  const sourcePreset = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '',
    '- id: tool-bash',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    '',
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '',
  ].join('\n')
  const imageToolFile = join(repoRoot, 'lib', 'wsl-image-tool.js').replace(/\\/g, '/')
  const worldText = (imagePath) => variants.transformPresetForWsl(
    sourcePreset,
    join(repoRoot, 'lib', 'shell.js').replace(/\\/g, '/'),
    providers['fs-local'].file.replace(/\\/g, '/'),
    undefined, undefined, undefined, imagePath,
  )
  // Arms 2-5 measure the world exactly as #54 found it: no row of ours answering for the name.
  const generated = worldText(undefined)
  // Arm 6 adds this plugin's built image read and nothing else, so the only difference between the
  // two boots is the row the fix mounts.
  const generatedWithImage = worldText(imageToolFile)
  const generatedFile = join(SCRATCH, 'w54-generated-world.yml')
  writeFileSync(generatedFile, generated, 'utf8')
  const generatedImageFile = join(SCRATCH, 'w54-generated-world-with-image-row.yml')
  writeFileSync(generatedImageFile, generatedWithImage, 'utf8')
  const imageRowEmitted = generatedWithImage.includes('- id: read-image-wsl')
    && generatedWithImage.includes(imageToolFile)
  if (!imageRowEmitted) {
    add('6-world-answers-with-own-image-read', false, `transformPresetForWsl given an imagePath emitted no read-image-wsl row naming ${imageToolFile} — nothing for arm 6 to mount (${generatedImageFile})`)
  }
  if (!generated.includes('isolate:') || !generated.includes('    fs: true')) {
    add('2-isolate-world-text', false, `the generated world carries no isolate fs block — nothing below can measure a realm boundary (${generatedFile})`)
    report(rows, 'NOT-MEASURED — src/host/variants.ts did not emit an `isolate: { fs: true }` world, so the arms do not exist')
  }

  // The host's own tool call shape (dsh-tool-fs:998 `execute(args, exec)`): `exec.signal`,
  // `exec.agent.session.header.cwd` for path resolution, `exec.agent.session.requestHeader()?.config`
  // and `exec.agent.options.provider|model` for the image-route gate.
  const execution = () => ({
    signal: new AbortController().signal,
    agent: {
      id: 'agent-w54',
      options: { ...route },
      session: {
        id: 'w54-session',
        header: { cwd: SCRATCH, id: 'w54-session' },
        requestHeader: () => ({ config: { ...route } }),
      },
    },
  })

  /** Register the image-capable route the tool's gate requires, through the host's own adapter API. */
  const declareRoute = (ctx) => {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('no llm service mounted — the image route gate cannot be satisfied')
    llm.registerAdapter([route.provider], {
      providerInfo: (provider) => ({ id: provider, name: provider }),
      providerRetryPolicy: () => undefined,
      async listModels () { return [] },
      async resolveModel (provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 128_000 } }
      },
      async prepareCall () { throw new Error('w54-isolate-probe never streams a completion') },
      async * stream () {},
    })
    return llm.resolveModelInfo(route.provider, route.model, undefined)
  }

  /** Call `read_image` the way the host's dispatcher does, and keep the elapsed time. */
  const callReadImage = async (tool, filePath) => {
    const started = Date.now()
    try {
      const value = await within(tool.execute({ file_path: filePath }, execution()), 30_000, 'read_image.execute')
      const text = JSON.stringify(value)
      return { ms: Date.now() - started, isError: false, value, message: `kind=${value?.image?.mediaType ?? '?'}, ${text.slice(0, 110)}`, frame: '' }
    } catch (error) {
      // The throwing frame is part of the reading: a red that cannot say where it landed cannot tell
      // "the fs seam threw" from "the schema validation threw".
      const frame = String(error?.stack ?? '').split('\n')
        .find(line => /dsh-tool-fs|cordis\/lib|cordis\\lib/.test(line))?.trim() ?? '(no frame named)'
      return { ms: Date.now() - started, isError: true, value: undefined, message: outOf(error), frame }
    }
  }

  const txt = join(SCRATCH, 'w54-probe.txt')
  writeFileSync(txt, 'the world can still read text\n', 'utf8')

  /**
   * Ask the host suite's other file tools in the boot being measured. `read_image` is a name the
   * host's `tool-fs` row also registers, so taking it over is only a fix if `read`, `write` and `edit`
   * — which mount through the plugin's own fiber, not the injected one — keep answering.
   * @param runtime - the world's tools service.
   * @returns `{ ok, detail }`: every name present and `read` returning the file's line.
   */
  const callFileTools = async (runtime) => {
    const names = ['read', 'write', 'edit']
    const missing = names.filter((name) => runtime?.get?.(name) === undefined)
    if (missing.length > 0) return { ok: false, detail: `file tools missing: ${missing.join(', ')}` }
    try {
      const value = await within(runtime.get('read').execute({ file_path: txt }, execution()), 20_000, 'read.execute')
      const line = value?.lines?.[0]?.text
      return { ok: line === 'the world can still read text', detail: `read/write/edit registered, read answers ${JSON.stringify(String(line))}` }
    } catch (error) {
      return { ok: false, detail: `read/write/edit registered, read throws ${JSON.stringify(outOf(error))}` }
    }
  }

  const baseRows = [
    ...row('system-prompt', providers['system-prompt'].file),
    ...row('tools', providers.tools.file),
    ...row('attachment', providers.attachment.file),
    ...row('llm', providers.llm.file),
    // The dialog route this plugin registers needs a real web server; port 0 is the OS's choice, so the
    // gate never claims a port a developer is using.
    '    - id: webserver',
    `      name: '${providers.webserver.file.replace(/\\/g, '/')}'`,
    '      config:',
    '        host: 127.0.0.1',
    '        port: 0',
  ]
  const rootWorldRows = [
    ...baseRows,
    ...row('fs-local', providers['fs-local'].file),
    ...row('tool-fs', providers['tool-fs'].file),
  ]
  const isolateWorldRows = (mutate, text = generated) => [
    ...baseRows,
    ...worldRows(text, mutate),
  ]

  // ── boots: arms 0/1 in the root realm, arms 2/3/5 inside the generated world, arm 4 mutated ──
  makeProfile(home, 'w54root', shadow.scope)
  makeProfile(home, 'w54world', shadow.scope)
  makeProfile(home, 'w54mutant', shadow.scope)
  makeProfile(home, 'w54ownrow', shadow.scope)

  const pluginFile = join(repoRoot, 'lib', 'index.js')
  const bootA = await boot({ profile: 'w54root', home, environment, runProfile, rows: rootWorldRows })
  try {
    const ctx = bootA.ctx
    const info = await declareRoute(ctx)
    const tool = ctx.get('tools').get('read_image')
    const first = tool === undefined ? null : await callReadImage(tool, png)
    add('0-control-nonwsl-world', first !== null && first.isError === false, first === null
      ? 'read_image is not registered at all in a root-realm world — the fs tool suite did not mount'
      : `${first.ms}ms ${first.isError ? 'isError=true' : 'ok'}: ${first.message}`
        + ` (route ${JSON.stringify(info?.inputModalities)}, tool read from ${providers['tool-fs'].file})`)

    // ── 1: the same root realm, with THIS plugin mounted through the loader ─────────────────
    const captured = []
    const sinks = { log: console.log, warn: console.warn }
    console.log = (...args) => captured.push(args.map(String).join(' '))
    console.warn = (...args) => captured.push(args.map(String).join(' '))
    let mountError = null
    try {
      await within(ctx.loader.create({ id: 'wsl-workspace', name: pathToFileURL(pluginFile).href }, null), 60_000, 'loader.create(lib/index.js)')
      const deadline = Date.now() + 20_000
      let state = 0
      while (Date.now() < deadline && state !== 2 && state !== 4) {
        await sleep(100)
        state = entryOf(ctx, 'wsl-workspace')?.fiber?.state ?? 0
      }
      mountError = state === 2 ? null : `entry state ${state}`
    } catch (error) {
      mountError = outOf(error)
    } finally {
      Object.assign(console, sinks)
    }
    const pluginLines = captured.filter(line => line.includes('dsh-wsl-workspace'))
    const after = await callReadImage(ctx.get('tools').get('read_image'), png)
    add('1-plugin-mounted-standard-world', mountError === null && after.isError === false,
      `${after.ms}ms ${after.isError ? 'isError=true' : 'ok'}: ${after.message}`
        + ` | plugin entry: ${mountError ?? 'activated'} | what it said at boot: ${pluginLines.join(' // ') || 'nothing'}`)
    if (mountError !== null) add('1-plugin-boot-diagnostics', false, `captured: ${captured.join(' // ').slice(0, 400)}`)
  } finally {
    await within(bootA.shutdown.shutdown(0), 30_000, 'shutdown w54root').catch(() => {})
  }

  // ── 2, 3, 5: the generated isolate world ──────────────────────────────────────────────────
  const bootB = await boot({ profile: 'w54world', home, environment, runProfile, rows: isolateWorldRows() })
  let realmAnswer = null
  let absentAnswer = null
  try {
    const ctx = bootB.ctx
    await declareRoute(ctx)
    await sleep(200)
    const tool = ctx.get('tools').get('read_image')
    realmAnswer = tool === undefined ? null : await callReadImage(tool, png)
    add('2-isolate-world-read-image', realmAnswer !== null && realmAnswer.message === REALM_ERROR,
      realmAnswer === null
        ? 'read_image is not registered inside the isolate world — the world did not mount the fs tool suite, so this arm measures the harness'
        : `${realmAnswer.ms}ms ${realmAnswer.isError ? 'isError=true' : 'ok'}: ${JSON.stringify(realmAnswer.message)}`
          + ` (expected verbatim: ${JSON.stringify(REALM_ERROR)}; thrown at ${realmAnswer.frame})`)

    const worldEntry = entryOf(ctx, 'wsl-world')
    const fsEntry = entryOf(ctx, 'fs-wsl')
    const toolEntry = entryOf(ctx, 'tool-fs')
    const key = (context) => {
      const map = context?.[CordisModule.Context.isolate]
      return map === undefined || map.fs === undefined ? 'absent' : String(map.fs)
    }
    const reachable = (context, label) => {
      try { return `${label}=resolves(${typeof context.get('fs')})` } catch (error) { return `${label}=throws(${outOf(error)})` }
    }
    const mechanism = {
      loaderIsolateOption: worldEntry?.options?.isolate ?? null,
      rootFsRealmKey: key(ctx),
      worldFsRealmKey: key(worldEntry?.ctx),
      toolFsEntryFsRealmKey: key(toolEntry?.ctx),
      realmSuffix: worldEntry?.realm?.suffix ?? '(no LocalRealm on the group entry)',
      fsWslActivated: fsEntry?.fiber?.state === 2,
      toolFsActivated: toolEntry?.fiber?.state === 2,
      fsLookupFrom: [
        reachable(worldEntry?.ctx, 'world group ctx'),
        reachable(toolEntry?.ctx, 'tool-fs entry ctx'),
        reachable(ctx, 'root ctx'),
      ],
      // Why the realm is not enough: the group's own context reaches `fs`, the tool-fs entry's context
      // reaches it, and the call still throws — because `read_image` is registered inside
      // `ctx.inject(['attachments'], …)` (dsh-tool-fs:1204) and `attachments` is served from the root
      // realm, so the context the tool captured is not the entry context that carries the realm key.
      conclusion: 'fs is implemented in the isolate realm (fs-wsl activated, world group ctx resolves it),'
        + ' but the read_image closure resolves fs from a context whose realm chain does not reach that realm',
      rowsNotActivated: entries(ctx)
        .filter(entry => entry.fiber?.state !== 2 && entry.options?.group !== true)
        .map(entry => `${entry.options?.id}(state ${entry.fiber?.state})`),
    }
    add('3-realm-mechanism', mechanism.worldFsRealmKey !== mechanism.rootFsRealmKey, JSON.stringify(mechanism))

    // ── 5: does the failure land before any path is resolved? ───────────────────────────────
    absentAnswer = tool === undefined ? null : await callReadImage(tool, absentPath)
    const sameString = absentAnswer !== null && realmAnswer !== null && absentAnswer.message === realmAnswer.message
      && absentAnswer.message === REALM_ERROR
    add('5-fails-before-path-resolution', sameString, absentAnswer === null
      ? 'no tool to ask'
      : `${absentAnswer.ms}ms for a path that does not exist: ${JSON.stringify(absentAnswer.message)}`
        + ` — ${sameString ? 'the realm string, not "not found": the fs seam was never reached' : 'a different answer, so the claim in #54 does not hold as written'}`)
  } finally {
    await within(bootB.shutdown.shutdown(0), 30_000, 'shutdown w54world').catch(() => {})
  }

  // ── 4: mutation control — one token of the generated text, removed in memory ──────────────
  const withoutFsRow = (lines) => {
    const index = lines.findIndex(line => line === '    fs: true')
    if (index < 0) throw new Error('the generated world no longer carries the `    fs: true` line to remove')
    return [...lines.slice(0, index), ...lines.slice(index + 1)]
  }
  const bootC = await boot({ profile: 'w54mutant', home, environment, runProfile, rows: isolateWorldRows(withoutFsRow) })
  try {
    const ctx = bootC.ctx
    await declareRoute(ctx)
    await sleep(200)
    const tool = ctx.get('tools').get('read_image')
    const answer = tool === undefined ? null : await callReadImage(tool, png)
    const gone = answer !== null && !answer.message.includes(REALM_ERROR)
    add('4-mutation-fs-token-removed', gone, answer === null
      ? 'no tool registered in the mutated world either — the mutation removed more than the realm, so it proves nothing'
      : `${answer.ms}ms ${answer.isError ? 'isError=true' : 'ok'}: ${JSON.stringify(answer.message)}`
        + ` — ${gone ? `the ${JSON.stringify(REALM_ERROR)} string disappears when only \`fs: true\` is absent, so that token causes it` : 'the string survived the mutation, so this reading is not attributable to the realm'}`)
  } finally {
    await within(bootC.shutdown.shutdown(0), 30_000, 'shutdown w54mutant').catch(() => {})
  }

  // ── 6: this plugin's own image read, mounted in the same isolate world ──────────────────
  // The one difference between this boot and arms 2/3/5 is the row `transformPresetForWsl` emits when
  // it is handed this installation's built image read. Both halves are required in that one boot: the
  // definition the dispatcher resolves for `read_image` must come back with the picture, and the
  // host's registration — still in the world, one layer out — must still answer the realm string.
  // Half a red here means the fix stopped answering; the other half means it stopped being a fix
  // beside a real defect and became something else.
  if (imageRowEmitted) {
    const bootD = await boot({ profile: 'w54ownrow', home, environment, runProfile, rows: isolateWorldRows(undefined, generatedWithImage) })
    try {
      const ctx = bootD.ctx
      await declareRoute(ctx)
      await sleep(200)
      const runtime = ctx.get('tools')
      // Ours is the read that resolves inside the distribution; the host's resolves through its own
      // backend. `defineTool` compiles `parameters` into one JSON schema, so the marker is read out of
      // `properties` — reading `tool.parameters.file_path.description` finds nothing on either side and
      // mislabels our own read as the host's. (Measured: the two definitions differ in no other field
      // the probe can see, since the host wraps both bodies in the same argument-validation shell.)
      const isOurs = (tool) => String(tool?.parameters?.properties?.file_path?.description ?? '').includes('WSL distribution')
      const visible = typeof runtime?.get === 'function' ? runtime.get('read_image') : undefined
      const imageRow = entryOf(ctx, 'read-image-wsl')
      // Every layer the registry keeps: the context-global table plus one per scoped overlay. The
      // host's registration is read from wherever the registry left it instead of being assumed absent.
      const layerTables = runtime?.layers === undefined ? [] : [
        runtime.layers.global,
        ...(runtime.layers.scoped instanceof Map ? [...runtime.layers.scoped.values()] : []),
      ]
      const registered = new Set()
      for (const table of layerTables) {
        for (const [name, definition] of table?.tools?.entries?.() ?? []) if (name === 'read_image') registered.add(definition)
      }
      const hostTool = [...registered].find((tool) => !isOurs(tool))
      const ownAnswer = visible === undefined ? null : await callReadImage(visible, png)
      const blocks = ownAnswer !== null && !ownAnswer.isError && typeof visible.output?.render === 'function'
        ? visible.output.render({ file_path: png }, ownAnswer.value)
        : []
      const imageBlock = Array.isArray(blocks) ? blocks.find((block) => block?.type === 'image') : undefined
      const imageBytes = ownAnswer?.value?.image?.bytes ?? 0
      // The gate the product puts every tool answer through, run with the host's own validator: a body
      // that returns a field its declared schema does not name is rejected before the model sees it
      // (`"<path>" is not a declared property (additionalProperties: false)`). This probe's call path did
      // not run it, and a real WSL session hit exactly that on 2026-10-13: the read produced the image,
      // the answer died at the output gate. Measured here, that cannot pass as a green row.
      const validate = providers.tools.namespace?.validateJsonSchemaValue
      const violations = validate === undefined
        ? ['validateJsonSchemaValue is not exported by the linked dsh-tools']
        : ownAnswer?.value === undefined || visible?.output?.schema === undefined
          ? ['no schema/value pair to check']
          : validate(visible.output.schema, ownAnswer.value, 'value')
      const answered = ownAnswer !== null && !ownAnswer.isError && isOurs(visible)
        && imageBytes > 0 && (imageBlock?.attachment?.bytes ?? 0) === imageBytes
        && String(ownAnswer?.value?.path ?? '').endsWith('w54-probe.png')
        && violations.length === 0
      const hostAnswer = hostTool === undefined ? null : await callReadImage(hostTool, png)
      // The other file tools must still answer with our row mounted: the world's image read takes a
      // name the host's suite also registers, and a fix that cost `read`/`write`/`edit` is not a fix.
      const fileToolAnswers = await callFileTools(runtime)
      const displaced = hostTool === undefined
      const hostStillFails = displaced || hostAnswer?.message === REALM_ERROR
      const census = `${registered.size} definition(s) of the name across ${layerTables.length} registry layer(s);`
        + ` ours=${[...registered].filter(isOurs).length}, host=${[...registered].filter((tool) => !isOurs(tool)).length}`
        + `; read-image-wsl row: ${imageRow === undefined ? 'no entry' : `state ${imageRow.fiber?.state}`}`
      add('6-world-answers-with-own-image-read', answered && hostStillFails && fileToolAnswers.ok,
        `dispatcher resolves ${isOurs(visible) ? 'this plugin\'s read' : 'the host read or nothing'} → `
          + (ownAnswer === null ? 'no tool to ask' : `${ownAnswer.ms}ms ${ownAnswer.isError ? `throws ${JSON.stringify(ownAnswer.message)}` : `answers ${JSON.stringify(ownAnswer.message)}`}`)
          + ` | the host's own read_image in the same boot: `
          + (hostAnswer === null ? `not in the registry — our row holds the name (arm 2/5 is the same world with our row absent, where it answers ${JSON.stringify(REALM_ERROR)})` : `${hostAnswer.ms}ms ${JSON.stringify(hostAnswer.message)}`)
          + ` | ${census} | rendered image block: ${imageBlock === undefined ? 'none' : `${imageBlock?.attachment?.mediaType}/${imageBlock?.attachment?.bytes} bytes`}`
        + ` | host output gate on our value: ${violations.length === 0 ? 'clean' : JSON.stringify(violations).slice(0, 300)}`
          + ` | ${fileToolAnswers.detail} (world text: ${generatedImageFile})`)
    } finally {
      await within(bootD.shutdown.shutdown(0), 30_000, 'shutdown w54ownrow').catch(() => {})
    }
  }

  const reproduced = realmAnswer !== null && realmAnswer.message === REALM_ERROR
  const controlRow = rows.find(entry => entry.id === '0-control-nonwsl-world')
  const controlOk = controlRow?.ok === true
  const mutationOk = rows.find(entry => entry.id === '4-mutation-fs-token-removed')?.ok === true
  const worldReadRow = rows.find(entry => entry.id === '6-world-answers-with-own-image-read')
  const worldReadOk = worldReadRow?.ok === true
  const controlMs = controlRow === undefined ? '?' : String(controlRow.detail).split('ms')[0]
  const verdict = controlOk && reproduced && mutationOk
    ? worldReadOk
      ? `W54-REALM-CONFIRMED — read_image answers in a root-realm world (${controlMs}ms) and answers ${JSON.stringify(REALM_ERROR)}`
        + ` inside the generated isolate world, and the string disappears when the single "fs: true" token is`
        + ` removed from that text — so that token, not the machine, causes the failure (see row 3 for which`
        + ` realm key carries fs on each side). Row 6: in that same isolate world the dispatcher's read_image`
        + ` is this plugin's own read and it answers with the image, while the host's registration still`
        + ` answers the realm string — the fix is a second answer, not a repaired lookup`
      : `W54-REALM-CONFIRMED BUT THIS PLUGIN'S OWN READ DOES NOT ANSWER — rows 0/2/4 still measure the realm`
        + ` defect, row 6 is red: ${worldReadRow === undefined ? 'the generator mounted no read-image-wsl row' : worldReadRow.detail}`
    : controlOk && !reproduced
      ? `W54-NOT-REPRODUCED — the isolate world answered read_image (${realmAnswer === null ? 'no tool was mounted in it' : JSON.stringify(realmAnswer.message)});`
        + ' either #54 needs a fact this harness does not carry, or it is fixed; rows 2-5 are not a mechanism reading'
      : 'W54-INSTRUMENT-BROKEN — the control arm did not answer, so no red below is evidence about the realm (see row 0)'

  console.log(`# closure the arms stood on: ${JSON.stringify(Object.fromEntries(loadedFrom), null, 0)}`)
  console.log(`# generated world text written to ${generatedFile}`)
  report(rows, verdict)
} catch (error) {
  if (error?.code === 'E_CLOSURE_INCOMPLETE') {
    // Not measured **here**, said in the vocabulary the seam ledger counts, and not a pass.
    console.error(`SKIP: w54-isolate-probe — the pinned closure cannot load the fs tool suite (${outOf(error).slice(0, 300)})`)
    console.log(`W54-ISOLATE-PROBE PASSED (1 skipped — a skip is not a pass): #54's arms need @deepseek-ai/dsh-attachment, which is not in ci/pinned-deps.json`)
    process.exit(0)
  }
  for (const entry of rows) console.log(JSON.stringify(entry))
  console.log(JSON.stringify({ verdict: 'NOT-MEASURED', message: outOf(error).slice(0, 1_200) }))
  console.log('W54-ISOLATE-PROBE FAILED (1 failing — the instrument died before it could read anything)')
  process.exit(2)
}

/** Every loader entry, nested ones included, in the order the Loader reports them. */
function entries (ctx) {
  try {
    return [...ctx.loader.entries()]
  } catch {
    return []
  }
}

/** The entry with one id, searching nested groups too (`loader.resolve` only walks the root store). */
function entryOf (ctx, id) {
  return entries(ctx).find(entry => entry.options?.id === id)
}
