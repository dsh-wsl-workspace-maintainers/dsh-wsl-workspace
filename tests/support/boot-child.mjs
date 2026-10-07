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

  // `state: FAILED` says something threw and not what. Subscribing to `internal/status` is too late —
  // the transitions happen inside `runProfile` — so the error is read off the fiber afterwards, which
  // means a row that failed quietly stops being a colour with no sentence attached.
  const rowFailures = () => [...(ctx.get('loader')?.entries?.() ?? [])]
    .filter(entry => entry?.fiber !== undefined && entry.fiber.state === 3)
    .map(entry => {
      // Every step guarded: `fiber.error` is a getter that can itself throw, and a probe that throws
      // is recorded as the string `THREW: …`, which is not JSON. Letting that reach the parent turns
      // a diagnostic into a crash — the failure mode this file keeps having to defend against.
      let error = '(no error recorded)'
      try {
        const raw = entry.fiber.error
        error = raw === undefined ? '(no error recorded)' : String(raw?.message ?? raw).slice(0, 300)
      } catch (inner) {
        error = `reading fiber.error threw: ${String(inner?.message ?? inner).slice(0, 160)}`
      }
      return { entry: entry?.options?.id ?? '(unnamed)', error }
    })

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
  probe('rowFailures', () => JSON.stringify(rowFailures()))

  // ── the property: every service the sources reach for, in the realm that will run them ────
  //
  // `plan.requirements` is derived by the parent from `src/**.ts`, not from here, so the list cannot
  // be quietly narrowed to whatever this particular boot happened to provide. Each entry says which
  // module wants the service and how it asks for it.
  //
  // Four levels, weakest to strongest, and the difference between them is the whole point:
  //   1 `declaredInject` echoed — the plugin saying it wants something is not evidence it got it;
  //   2 the row has a fiber at all;
  //   3 the row reached ACTIVE;
  //   4 `ctx.get(name)` resolves in that row's own realm.
  // A property written against level 1 would pass today with the plugin doing nothing, which is why
  // this checks level 4 and prints the others beside it.
  // This plugin's own rows, named by the plan rather than by a literal. The row ids moved from
  // `dsh-wsl-workspace` to `wsl-index` when every entry became its own row, and a stale literal here
  // made every service look unreachable in its own realm while the report said nothing about why.
  const ownFibers = (plan.pluginRowIds ?? [])
    .map(id => [...(ctx.get('loader')?.entries?.() ?? [])].find(entry => entry?.options?.id === id)?.fiber)
    .filter(fiber => fiber !== undefined)

  probe('requirements', () => JSON.stringify((plan.requirements ?? []).map(requirement => {
    const atRoot = ctx.get(requirement.service)
    // The same question asked again **inside this plugin's own realm**. Asking only the root is how
    // a gate would miss the failure where a declaration never reaches the fiber: the service is
    // right there at the root, so a root-level check reports it reachable while the plugin's own
    // context throws `cannot get property "<name>" without inject` the first time it is used. Two
    // realms, two answers, and only the second one is the one the code will feel.
    // Reachable in its own realm means: reachable in **every** one of this plugin's rows, because a
    // service that only some entries can see is a service some entry will throw on.
    const ownRealm = ownFibers.length === 0
      ? undefined
      : ownFibers.every(fiber => fiber.ctx.get(requirement.service) !== undefined)
        ? 'object'
        : 'ABSENT'
    return {
      service: requirement.service,
      module: requirement.module,
      how: requirement.how,
      resolvedAtRoot: atRoot !== undefined ? typeof atRoot : 'ABSENT',
      resolvedInOwnRealm: ownRealm === undefined ? 'UNKNOWN' : ownRealm,
      reachable: atRoot !== undefined && ownRealm !== undefined,
    }
  })))

  // The union of every `inject` this plugin's sources declare, so a bare read that nothing declares
  // anywhere can be named as such rather than showing up as an unexplained absence.
  // The loader keeps its own log and, left alone, keeps it to itself: a row that failed says so with
  // a colour and no sentence. Turning it on before anything is read is the only way the reason reaches
  // the parent's captured stderr.
  probe('logsEnabled', () => {
    const loader = ctx.get('loader')
    if (loader === undefined) return 'no loader'
    loader.enableLogs?.(true)
    return 'enabled'
  })

  // ── the preset tree, and the host's own audit of it ────────────────────────────────────────
  // The registry is asked, not the sources: this plugin does not define a preset, it registers
  // `wsl-<id>` derived from one the host ships. Reading the roster therefore answers "what did the
  // host end up holding" rather than "what did we mean to hand it".
  const registry = ctx.get('agentPresets')
  probe('presetRegistry', () => registry === undefined ? 'ABSENT' : registry.constructor?.name)

  // Awaited, not called synchronously. `list(): Promise<AgentPreset[]>` — reading it synchronously
  // yields a Promise, `?? []` never fires because a Promise is not nullish, and the roster comes back
  // empty. That is not a subtle bug: it is the harness reporting "the host holds no presets" while
  // holding one, which is the exact shape of a false negative.
  // **Settle first.** The plugin registers its variants inside `ctx.effect`, and that effect awaits
  // `supportsPersistentShell(ctx)` and `resolveRelayNode()` — real probes with real I/O. Reading the
  // roster the moment `runProfile` returns therefore races the registration, and the report says "the
  // host holds no `wsl-` preset" while the plugin is still working. A timeout bounded well under the
  // harness's own, so a hang is still a hang and not a silent wait.
  await new Promise(resolve => setTimeout(resolve, 4000))
  try {
    const list = registry === undefined ? [] : await registry.list()
    report.probes.presetRoster = {
      ok: true,
      value: JSON.stringify(list.map(entry => ({
        id: entry?.id,
        name: entry?.name,
        plugins: Array.isArray(entry?.plugins) ? entry.plugins.length : undefined,
        // `broken` is what makes the plugin skip a preset entirely
        // (`presets.filter(preset => preset.broken === undefined && …)`), so it is read here rather
        // than inferred from the preset's absence.
        broken: entry?.broken === undefined ? null : String(entry.broken),
      }))),
    }
  } catch (error) {
    report.probes.presetRoster = { ok: false, value: `THREW: ${String(error?.message ?? error).slice(0, 200)}` }
  }
  // The **transformed** preset, which is the one this plugin contributed. Read from the host rather
  // than from `src/host/variants.ts`: the question is not what the plugin meant to publish but what
  // the host ended up holding, and those are different things often enough to be worth the round trip.
  try {
    const wslDocument = registry === undefined ? null : await registry.readDocument('wsl-standard')
    report.probes.wslPresetDocument = {
      ok: wslDocument !== null,
      value: wslDocument === null ? 'ABSENT' : String(wslDocument.content ?? ''),
    }
  } catch (error) {
    report.probes.wslPresetDocument = { ok: false, value: `THREW: ${String(error?.message ?? error).slice(0, 200)}` }
  }

  try {
    const document = registry === undefined ? null : await registry.readDocument('standard')
    report.probes.presetDocument = {
      ok: document !== null,
      value: document === null ? 'ABSENT' : JSON.stringify({
        name: document.name ?? null,
        bytes: String(document.content ?? '').length,
        head: String(document.content ?? '').slice(0, 120),
      }),
    }
  } catch (error) {
    report.probes.presetDocument = { ok: false, value: `THREW: ${String(error?.message ?? error).slice(0, 200)}` }
  }

  // ── the dynamic half: hand the host a job and read it back with the host's own reader ----------
  //
  // Two registrations of the same work, differing only in **which channel the output travels on**:
  //
  //   `run()` returning `readOutput()` — the shape `src/host/wsl-jobs.ts` offers;
  //   `spec.output[]` pull-sources — the shape `@deepseek-ai/dsh-jobs` documents and reads.
  //
  // Both are read back with `jobs.read()`, the registry's own reader — the same path `job_output`
  // takes. Nothing here knows what any defect is: it registers a job, asks the host to read it, and
  // reports what came back. If one comes back empty and the other does not, the asymmetry is the
  // host's, established by the host rather than by our reading of its source.
  probe('jobRoundTrip', () => {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) return 'ABSENT'
    const MARKER = 'DSH_HOST_CONTRACT_MARKER'
    const makeSpec = withSpecOutput => {
      const spec = {
        kind: 'bash',
        // The marker is **only** in the output channel. It also appeared in `label` at first, which
        // made every read look successful because the label is always echoed back — a probe that
        // cannot fail is worse than no probe.
        label: 'contract probe',
        run: () => ({
          cancel: () => {},
          done: Promise.resolve({ status: 'completed' }),
          readOutput: () => `${MARKER}\n`,
        }),
      }
      if (!withSpecOutput) return spec
      return {
        ...spec,
        output: [{
          channel: 'stdout',
          read: fromByte => ({ text: `${MARKER}\n`, nextOffset: fromByte + MARKER.length + 1, lossy: false }),
        }],
      }
    }
    // Only the **chunks** count. `JSON.stringify` of the whole view matches the marker in `label`
    // and in the job id, which is how the first version of this probe reported both channels readable.
    const carries = value => Array.isArray(value?.chunks) && value.chunks.length > 0
    && value.chunks.some(chunk => String(chunk?.text ?? '').includes(MARKER))
    const viaRun = jobs.read(jobs.start(makeSpec(false)))
    const viaSpec = jobs.read(jobs.start(makeSpec(true)))
    return JSON.stringify({
      viaRunReadOutput: carries(viaRun),
      viaSpecOutput: carries(viaSpec),
      runReadView: JSON.stringify(viaRun ?? null).slice(0, 160),
      specReadView: JSON.stringify(viaSpec ?? null).slice(0, 160),
    })
  })

  probe('presetDeclaredSurface', () => JSON.stringify(plan.declaredInject ?? []))

  probe('ownRowInject', () => JSON.stringify(byId.get('dsh-wsl-workspace')?.declaredInject ?? []))

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