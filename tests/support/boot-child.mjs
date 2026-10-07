/**
 * One real `@deepseek-ai/dsh` boot, in one process, reported as one line of JSON.
 *
 * **Why a child process.** `runProfile` installs SIGINT/SIGTERM listeners
 * (`profile-boot-*.js:249-254`) and an `installFailLoud` handler (`:255-257`), and neither has an
 * uninstall path. A process that boots the host once cannot boot it again, so every measurement
 * needs a fresh process. The repository already does this for the same reason —
 * `tests/default-distro-parity.test.ts:40-92` notes that the sync variant caches the whole process
 * lifetime in module scope.
 *
 * **Async spawn, not `spawnSync`.** Measured on the machine this was written on:
 * `spawnSync('wsl.exe', …)` returns `EBUSY` while `spawn` runs the same argv. Synchronous children
 * are what the harness refuses; nothing here needs synchronous, so it does not ask.
 *
 * **The child must live inside the repository.** Bare specifiers resolve against the module scope
 * chain, so a script under a temp directory cannot see `@deepseek-ai/dsh`. That is why this file is
 * `tests/support/boot-child.mjs` and not something written to a tmpdir at run time.
 *
 * **The environment snapshot is taken before the host is imported.** `runProfile`'s first side
 * effect is `installProxyFromEnvironment(options.environment)`.
 *
 * The report is written to stdout with a `##BOOT##` prefix rather than as a file: the parent's
 * `spawn` captures both streams, and a file would be a second thing that can go missing.
 */

import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'

const plan = JSON.parse(process.argv[2])
const report = { stage: 'start', probes: {} }

/** Record one probe without letting a throwing probe swallow the rest of the report. */
function probe(label, fn) {
  try {
    const value = fn()
    report.probes[label] = { ok: value !== undefined && value !== false, value: serialise(value) }
  } catch (error) {
    report.probes[label] = { ok: false, value: `THREW: ${String(error?.message ?? error).slice(0, 300)}` }
  }
}

function serialise(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return `[unserialisable ${Object.prototype.toString.call(value)}]`
  }
}

/** Fiber state names, from `@deepseek-ai/cordis`'s own enum (lib/types/fiber.d.ts:66-73). */
const STATE_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

try {
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  report.stage = 'snapshot-taken'

  const { ctx, shutdown } = await runProfile({
    environment,
    profile: plan.profile,
    patchFiles: plan.patchFiles,
    args: [],
  })
  report.stage = 'booted'

  // ── what the host actually did with every row it was given ──────────────────────────────
  probe('rows', () => [...(ctx.get('loader')?.entries?.() ?? [])].map(entry => ({
    id: entry?.options?.id,
    // `fiber === undefined` means the entry never got a fiber at all — a different failure from
    // "activated and unhappy", and the distinction matters when reading a report.
    state: entry?.fiber?.state ?? null,
    stateName: entry?.fiber === undefined ? 'NO_FIBER' : (STATE_NAMES[entry.fiber.state] ?? 'UNKNOWN'),
    declaredInject: Object.keys(entry?.fiber?.inject ?? {}),
    name: String(entry?.options?.name ?? ''),
  })))

  // `entries()` returns an iterable, not an array — `.length` on it is `undefined`, which is how a
  // count can silently become "not measured".
  probe('rowCount', () => [...(ctx.get('loader')?.entries?.() ?? [])].length)

  // ── P1: a loader, and it has entries at all ─────────────────────────────────────────────
  probe('p1_loaderPresent', () => ctx.get('loader') !== undefined)
  probe('p1_loaderClass', () => ctx.get('loader')?.constructor?.name)

  // ── P2: $DSH_HOME was really read, and it is the directory the parent built ─────────────
  // `dshHomePath` is a *function* (it joins segments), so comparing it to a string would compare
  // a string to `[Function: dshHomePath]` and quietly pass on nothing.
  probe('p2_dshHomePath', () => {
    const fn = ctx.get('dshHomePath')
    if (typeof fn !== 'function') return `not a function: ${typeof fn}`
    return String(fn())
  })

  // ── P3: the host's own plugins mounted ─────────────────────────────────────────────────
  const rows = ctx.get('loader')?.entries?.() ?? []
  const byId = new Map(rows.map(entry => [entry?.options?.id, entry]))
  probe('p3_hostRows', () => JSON.stringify(
    ['tool-fs', 'jobs', 'tool-jobs', 'host-webserver'].map(id => `${id}=${byId.get(id)?.fiber === undefined ? 'NO_FIBER' : (STATE_NAMES[byId.get(id)?.fiber?.state] ?? '?')}`)))

  // ── P4: those rows resolved to real packages inside ci/deps, not to this repo's src ─────
  probe('p4_resolvedInside', () => JSON.stringify(
    [...(ctx.get('loader')?.entries?.() ?? [])]
      .filter(entry => String(entry?.options?.name ?? '').startsWith('@deepseek-ai/'))
      .map(entry => `${entry.options.id} -> ${String(entry.options.name)}`)
      .slice(0, 20)))

  // ── P5: this plugin's own row mounted ───────────────────────────────────────────────────
  probe('p5_ownRow', () => {
    const own = byId.get('dsh-wsl-workspace')
    if (own === undefined) return 'ABSENT from the loader entirely'
    if (own.fiber === undefined) return 'NO_FIBER'
    return STATE_NAMES[own.fiber.state] ?? `state=${own.fiber.state}`
  })

  // ── P6: the services this plugin declares it needs are really there ────────────────────
  probe('p6_services', () => JSON.stringify(Object.fromEntries(
    ['webServer', 'jobs', 'fs', 'subprocess', 'terminals', 'tools', 'systemPrompt', 'skills', 'shellEnv', 'agentPresets']
      .map(name => [name, ctx.get(name) === undefined ? 'ABSENT' : typeof ctx.get(name)]))))

  // ── P7: nothing in this context came from a hand-rolled face ────────────────────────────
  // The positive controls above all pass if the harness quietly hands the properties a fake: a fake
  // can be made to have a loader, rows, and services. What a fake cannot do is *be* the host, so
  // this probe asks whether anything at all looks like it was substituted.
  probe('p7_sentinels', () => JSON.stringify(
    ['__fake', '__stub', '__harness', '__handrolled'].filter(name => ctx.get(name) !== undefined)))
  probe('p7_hostOwnServices', () => JSON.stringify(
    ['loader', 'dshHomePath', 'profileContext', 'pluginPackages'].filter(name => ctx.get(name) !== undefined)))

  probe('webServerPort', () => String(ctx.get('webServer')?.port))

  try { await ctx.fiber.dispose?.() } catch { /* the host is going away regardless */ }
  try { shutdown.interrupt(0) } catch { /* ditto */ }
} catch (error) {
  report.stage = 'threw'
  report.error = String(error?.message ?? error).slice(0, 1500)
  // StartupError carries the per-plugin reasons `auditStartupEntries` collected.
  report.startup = error?.startup === undefined ? null : JSON.stringify(error.startup).slice(0, 3000)
}

process.stdout.write(`##BOOT##${JSON.stringify(report)}\n`)
// Explicit exit: runProfile owns the signal handlers, so letting the loop drain is not an option.
process.exit(0)