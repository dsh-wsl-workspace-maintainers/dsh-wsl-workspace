// The replay table: one unit per real experience-class defect, each with the smallest edit that puts
// that defect back into this working tree.
//
// Where the numbers come from. Issue #101 read every issue in this repository and kept the 20 that are
// user-visible degradations whose repair lives here, then asked whether the suite of the time could
// have found each one: **0 of 20**. It grouped them by how they escaped — A the fake was kinder than
// the real host, B an assertion that cannot fail, C no apparatus on that surface, D only reproduces on
// a real machine. Those 20 ids are the denominator of `replay: X of 20`, and they are the units marked
// `canonical` below. Three more units carry `extra`: #95 and #96 and #105 are experience defects that
// post-date that audit (or, for #95, were closed as a duplicate of #87 and survive here only as the
// packaging facet — a shipped bundle that does not match `src/`).
//
// What a plant is meant to be. Not "the one line that commit changed" — the smallest edit that makes
// the defect's **class** live again, so that a gate which reddens on it is a gate that would also
// redden on the next instance. Each plant's `note` says which class property it is testing.
//
// `MEASURED` lines are readings, written by `node tests/replay/run.mjs` runs, not expectations. When a
// reading goes stale the row below it is what needs re-running.

/** The six fast per-commit gates, in run order; a unit may add planes or override the list. */
const FAST = ['unit', 'world', 'artifacts', 'install', 'client', 'docs']

/** @returns a multi-line find-string from its lines (keeps the table free of backslash soup). */
const span = (...lines) => lines.join('\n')

export const UNITS = [
  // ---------------------------------------------------------------- A: the fake is kinder than the host
  {
    id: 'presets-namespace',
    issue: 20,
    escape: 'A',
    klass: 'host-drift',
    canonical: true,
    symptom: 'plugin load dies on 0.1.2-rc.1: `Cannot read properties of undefined (reading agentPresets)`',
    trigger: 'a host that publishes the roster only as the `remote.agentPresets` namespace service',
    // Class property: reading a host service by a bare name instead of its namespace key.
    plants: [{
      file: 'src/client/index.ts',
      find: "    ctx.get('remote.agentPresets') as unknown as WslAgentPresetsNamespace | undefined",
      replace: "    ctx.get('agentPresets') as unknown as WslAgentPresetsNamespace | undefined",
      build: true,
      gates: [...FAST, 'node'],
      note: 'the service key drifts back to the pre-0.1.2 spelling',
    }],
  },
  {
    id: 'persona-target-fields',
    issue: 22,
    escape: 'A',
    klass: 'host-drift',
    canonical: true,
    symptom: 'the WSL persona note is silently not appended, so the model loses its environment',
    trigger: 'a persona config whose model-facing text sits in `suffix:`/`prefix:` rather than `text:`',
    // Class property: the transform only knows one persona field shape.
    plants: [{
      file: 'src/host/variants.ts',
      find: "const PERSONA_TARGET_FIELDS = ['suffix', 'text', 'prefix'] as const",
      replace: "const PERSONA_TARGET_FIELDS = ['text'] as const",
      note: 'the append target list shrinks back to the single field the 0.1.2 presets used',
    }],
  },
  {
    id: 'execfile-result-shape',
    issue: 35,
    escape: 'A',
    klass: 'host-drift',
    canonical: true,
    symptom: 'the distribution picker reports "cannot list WSL distributions" although `wsl.exe -l` works',
    trigger: "a host that patches `child_process.execFile` with a wrapper lacking `util.promisify.custom`",
    // Class property: trusting a captured result to be `{ stdout, stderr }`.
    plants: [{
      file: 'src/shared/wsl.ts',
      find: '      settle({ stdout, stderr })',
      replace: '      settle(stdout as unknown as ExecFileResult)',
      note: 'the promise resolves the raw stream instead of the pair every caller destructures',
    }],
  },
  {
    id: 'js-yaml-unpinned',
    issue: 47,
    escape: 'A',
    klass: 'packaging',
    canonical: true,
    symptom: '`未找到健康的 wsl preset`: zero `wsl-*` variants generated on Desktop',
    trigger: 'a sibling plugin hoists an incompatible major over this package’s `*` range for js-yaml',
    // Class property: a parse-critical dependency left to whatever the install tree hoists.
    plants: [{
      file: 'package.json',
      find: '    "js-yaml": "^4.1.0"',
      replace: '    "js-yaml": "*"  ',
      note: 'the pinned 4.x range becomes whatever the hoisted tree happens to carry',
    }],
  },
  {
    id: 'jobs-pull-sources',
    issue: 56,
    escape: 'A',
    klass: 'host-drift',
    canonical: true,
    symptom: '`job_output` always answers `(no new output)` for a running background bash job',
    trigger: 'a 0.2.x jobs registry that pumps its ring only from `spec.output` pull-sources',
    // Class property: handing the producer only, and nothing for the registry to pull.
    plants: [{
      file: 'src/host/wsl-jobs.ts',
      find: span(
        "    output: [",
        "      { read: readStream('stdout') },",
        "      { channel: 'stderr', read: readStream('stderr') },",
        '    ],',
        '',
      ),
      replace: '',
      gates: [...FAST, 'node'],
      note: "the spec stops declaring pull-sources, so the registry sees a silent job",
    }],
  },
  {
    id: 'undeclared-bare-import',
    issue: 89,
    escape: 'A',
    klass: 'packaging',
    canonical: true,
    symptom: 'every `wsl-*` variant shows 加载失败; five `file:` rows "never started"',
    trigger: 'a mounted provider file whose bare import resolves in no closure the profile carries',
    // Class property: a mounted file importing something no tree in the profile provides. #89 itself
    // was a resolution shape (`link:` installs), which no line of `src/` answers — this is the
    // package-level signal `artifact-semantics` was written to read.
    plants: [{
      file: 'src/host/wsl-image-tool.ts',
      find: "import { extname } from 'node:path'",
      replace: span("import { extname } from 'node:path'", "import { safeLoad } from 'js-yaml-safe'", ''),
      build: true,
      note: 'a bare specifier that is in no closure enters a mounted file',
    }],
  },

  // ---------------------------------------------------------------- B: an assertion that cannot fail
  {
    id: 'jobs-producer-without-tools',
    issue: 5,
    escape: 'B',
    klass: 'host-drift',
    canonical: true,
    symptom: 'a minimal mode whose roster the transform changed anyway (the reported chain-of-thought loss was never a plugin fix)',
    trigger: 'a source preset that carries the job tools, detected by a rule that stopped matching',
    // Class property: deriving "does this preset already have the job tools" from its roster text.
    plants: [{
      file: 'src/host/variants.ts',
      find: "  if (source.includes('tool-jobs')) sawJobs = true",
      replace: "  if (source.includes('tool-jobs-none')) sawJobs = true",
      note: 'the roster probe stops matching, so the world mounts a producer beside no job tools',
    }],
  },
  {
    id: 'frontmatter-block-scalar',
    issue: 12,
    escape: 'B',
    klass: 'input-shape',
    canonical: true,
    symptom: 'a skill whose `description:` is a YAML block scalar is dropped from the catalog in silence',
    trigger: '`description: |` (literal) or `description: >` (folded) in a SKILL.md frontmatter block',
    // Class property: the frontmatter parser handling only single-line scalars. #12 item 5.
    plants: [{
      file: 'src/host/wsl-skills.ts',
      find: "      if (value.text !== '') fields.set(block[1] ?? '', value.text)",
      replace: "      if (value.text !== '' && block[2] === '>') fields.set(block[1] ?? '', value.text)",
      gates: [...FAST, 'win32'],
      note: 'one of the two block-scalar spellings stops being stored',
    }],
  },
  {
    id: 'persona-placeholder',
    issue: 87,
    escape: 'B',
    klass: 'host-drift',
    canonical: true,
    symptom: 'every `wsl-*` session fails at turn 1 step 1: `unknown prompt variable "{{cwd}}"`',
    trigger: 'the appended persona sentence carries a `{{…}}` group the host no longer registers',
    // Class property: introducing a prompt variable into text this plugin appends. The lock is the
    // shape scan (no `{{` in what we add, on four persona shapes), not the byte string `{{cwd}}`.
    plants: [{
      file: 'src/host/variants.ts',
      find: "const PERSONA_APPEND = ' Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.'",
      replace: "const PERSONA_APPEND = ' Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration. The session directory is {{cwd}}.'",
      note: 'a template group re-enters the sentence this plugin appends',
    }],
  },

  // ---------------------------------------------------------------- C: no apparatus on that surface
  {
    id: 'skill-scan-root',
    issue: 10,
    escape: 'C',
    klass: 'input-shape',
    canonical: true,
    symptom: 'the session sees an empty skill catalog although the workspace has nested projects with skills',
    trigger: 'a `\\\\wsl.localhost\\<distro>\\<root>` workspace with no `.git` at the root and skills below it',
    // Class property: scanning only the session cwd instead of the enclosing project.
    plants: [{
      file: 'src/host/wsl-skills.ts',
      find: '    const scanRoot = (await nearestGitAncestor(unc.distro, unc.linuxPath, this.io)) ?? unc.linuxPath',
      replace: '    const scanRoot = unc.linuxPath',
      gates: [...FAST, 'win32'],
      note: 'the scan root stops walking up to the enclosing project',
    }],
  },
  {
    id: 'skill-cache-serve',
    issue: 25,
    escape: 'C',
    klass: 'lifecycle',
    canonical: true,
    symptom: 'every request in a UNC workspace takes ~30 s before it answers',
    trigger: 'a catalog already collected, on a tree big enough that re-walking the share costs seconds',
    // Class property: re-deriving published state on the request path instead of serving it.
    plants: [{
      file: 'src/host/wsl-skills.ts',
      find: span(
        '      this.cache.delete(cacheKey)',
        '      this.cache.set(cacheKey, cached)',
        '      return [...cached]',
        '',
      ),
      replace: '      this.cache.delete(cacheKey)\n',
      gates: [...FAST, 'win32'],
      note: 'the published catalog is dropped instead of served, so the walk runs again per request',
    }],
  },
  {
    id: 'reference-translation',
    issue: 49,
    escape: 'C',
    klass: 'input-shape',
    canonical: true,
    symptom: 'a file reference in a WSL session opens as `error.notFound`',
    trigger: 'a reference address carrying an absolute Linux path (`/mnt/d/…`, `/etc/hosts`) in a WSL session',
    // Class property: the client half not translating Linux paths into the host’s address space.
    plants: [{
      file: 'src/client/references.ts',
      find: '  const translated = hostPathForLinuxReference(parsed.path, session.distro)',
      replace: '  const translated: string | null = null',
      build: true,
      gates: [...FAST, 'node'],
      note: 'the client stops translating, so the reference addresses a file that is not there',
    }],
  },
  {
    id: 'roster-failure-anonymous',
    issue: 52,
    escape: 'C',
    klass: 'frontend-state',
    canonical: true,
    symptom: 'generation fails and the dialog shows one generic "plugin missing" sentence; the reason goes only to host stdout',
    trigger: 'a roster whose `wsl-*` entries carry a `broken` reason',
    // Class property: dropping the attributed reason on the way to the user.
    plants: [{
      file: 'src/client/index.ts',
      find: '      if (rosterFailures.length > 0) return brokenMessage(rosterFailures, 0)',
      replace: "      if (rosterFailures.length > 0) return t('error.presetMissing')",
      build: true,
      gates: [...FAST, 'node'],
      note: 'the named variant list collapses back into the generic sentence',
    }],
  },
  {
    id: 'image-row-unmounted',
    issue: 54,
    escape: 'C',
    klass: 'packaging',
    canonical: true,
    symptom: '`read_image` always fails `cannot get property "fs" without inject` in a WSL session',
    trigger: "a world that isolates `fs`, where the host's injected-proxy lookup cannot cross the realm",
    // Class property: the world having no realm-safe answer for a tool name the model calls.
    plants: [{
      file: 'src/index.ts',
      find: String.raw`  const imagePath = join(packageRoot, 'lib', 'wsl-image-tool.js').replace(/\\/g, '/')`,
      replace: '  const imagePath: string | undefined = undefined',
      build: true,
      gates: [...FAST, 'node'],
      note: 'the plugin stops mounting its own answer for `read_image`',
    }],
  },
  {
    id: 'run-code-guard-shape',
    issue: 78,
    escape: 'C',
    klass: 'input-shape',
    canonical: true,
    symptom: '`run_code` dies at worker start on a UNC workspace root: `GetNamedSecurityInfoW failed (Win32 1)`',
    trigger: 'a `wsl-*` session, `workspace-write`, root `\\\\wsl.localhost\\…`',
    // Two plants, because #78 has two surfaces: the predicate that names the shape, and the mount that
    // installs it. A unit is only "caught" when both reddened.
    plants: [
      {
        file: 'src/host/wsl-run-code-guard.ts',
        find: String.raw`  return lowered.startsWith('\\\\wsl.localhost\\') || lowered.startsWith('\\\\wsl$\\')`,
        replace: String.raw`  return lowered.startsWith('\\\\wsl$\\')`,
        note: 'one of the two 9P root spellings stops being recognised',
      },
      {
        file: 'src/index.ts',
        find: '  applyRunCodeGuard(ctx)',
        replace: '  // planted: the guard is no longer mounted',
        gates: [...FAST, 'node'],
        note: 'the guard exists but nothing installs it — the whole surface, not one branch',
      },
    ],
  },
  {
    id: 'drive-cwd-refused',
    issue: 86,
    escape: 'C',
    klass: 'input-shape',
    canonical: true,
    symptom: '`grep`/`glob` always answer "only available in a WSL workspace session" in a `/mnt/<drive>` workspace',
    trigger: 'a session cwd that is a registered Windows drive path (`F:\\TechEnergy\\Code\\Scanner`)',
    // Class property: a provider that knows only the UNC and absolute-Linux cwd shapes, refusing the
    // drive shape instead of reading the distribution from the registration.
    plants: [{
      file: 'src/host/wsl-search.ts',
      find: '  const mnt = windowsToMntPath(cwd)',
      replace: '  const mnt = null as unknown as ReturnType<typeof windowsToMntPath>',
      gates: [...FAST, 'node'],
      note: 'the drive branch disappears, so a drive cwd names no world',
    }],
  },
  {
    id: 'empty-error-strip',
    issue: 99,
    escape: 'C',
    klass: 'frontend-state',
    canonical: true,
    symptom: 'a healthy install draws a red-bordered error strip containing no text at all',
    trigger: '`checkPreset()` answers `undefined` (healthy, or a stale generation) and the strip keys off `!== null`',
    // Two plants: the fold that lets `undefined` through, and the render condition that asks only
    // "is it not null" instead of "is there text". #99 needed both halves.
    plants: [
      {
        file: 'src/client/AddWslWorkspace.tsx',
        find: '      setError(presetIssue ?? null)',
        replace: '      setError(presetIssue as string | null)',
        build: true,
        gates: [...FAST, 'node'],
        note: 'the undefined/null fold is removed, so `undefined` reaches the state',
      },
      {
        file: 'src/client/AddWslWorkspace.tsx',
        find: '          {error ? (',
        replace: '          {error !== null ? (',
        build: true,
        gates: [...FAST, 'node'],
        note: 'the strip asks only whether the value is not null, not whether it says anything',
      },
    ],
  },

  // ---------------------------------------------------------------- D: only reproduces on a real machine
  {
    id: 'wsl-exe-path-fallback',
    issue: 36,
    escape: 'D',
    klass: 'host-drift',
    canonical: true,
    symptom: 'the distribution picker is empty / reports WSL2 missing while `wsl.exe -l -q` works in a terminal',
    trigger: "a host `PATH` that omits `System32`, so the bare `wsl.exe` name is unstartable",
    // Class property: spawning a PATH name with no absolute fallback.
    plants: [{
      file: 'src/shared/wsl.ts',
      find: '  return [wslPath, absolute]',
      replace: '  return [wslPath]',
      note: 'the absolute candidate is dropped from the list',
    }],
  },
  {
    id: 'fallback-interpreter-demotes',
    issue: 40,
    escape: 'D',
    klass: 'host-drift',
    canonical: true,
    symptom: 'every `bash` call in a WSL workspace returns `PTY shell exited during startup`',
    trigger: 'the relay interpreter resolves to the Electron executable while the substrate probe says PTY works',
    // Class property: trusting the substrate probe alone about whether a persistent shell can start.
    plants: [{
      file: 'src/shared/relay-node.ts',
      find: '  return probeSaysYes && relay !== undefined && relay.fallback !== true',
      replace: '  return probeSaysYes && relay !== undefined',
      gates: [...FAST, 'win32'],
      note: 'a fallback interpreter no longer demotes the persistent shell',
    }],
  },
  {
    id: 'shell-seam-and-tier',
    issue: 50,
    escape: 'D',
    klass: 'host-drift',
    canonical: true,
    symptom: 'WSL bash is entirely unusable on 0.2.0-rc.2 while the file tools work (four independent points)',
    trigger: "the 0.2.x seam `ctx.shell.execute(resolve(spec)) → result()`, and a PTY assumed where the pipe session is the tier that works",
    // Two plants: the seam the host calls, and the tier decision that selects which world is generated.
    plants: [
      {
        file: 'src/shell.ts',
        find: '  async execute(spec: ShellExecSpec): Promise<ShellExecution> {',
        replace: '  async executeRenamed(spec: ShellExecSpec): Promise<ShellExecution> {',
        build: true,
        gates: [...FAST, 'node'],
        note: 'the plugin stops answering the seam the 0.2.x host calls',
      },
      {
        file: 'src/index.ts',
        find: "        const shellMode: 'session' | 'pty' = process.env.DSH_WSL_PTY_SHELL === '1' ? 'pty' : 'session'",
        replace: "        const shellMode: 'session' | 'pty' = 'pty'",
        build: true,
        gates: [...FAST, 'node'],
        note: 'the PTY tier is assumed rather than chosen, so the pipe session is never generated',
      },
    ],
  },

  // ---------------------------------------------------------------- extras (post-audit / duplicate reports)
  {
    id: 'stale-bundle-ships',
    issue: 95,
    escape: 'A',
    klass: 'packaging',
    canonical: false,
    symptom: 'the same `{{cwd}}` failure as #87, but against the published tarball',
    trigger: 'an artifact built before the fix landed, published anyway, so `lib/` carries text `src/` no longer does',
    // #95 was closed as a duplicate of #87; what is separately replayable is the pipeline facet — the
    // shipped bytes diverging from the source. This plant edits `lib/` on purpose and reverts it.
    plants: [{
      file: 'lib/index.js',
      find: 'const PERSONA_APPEND = " Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.";',
      replace: 'const PERSONA_APPEND = " Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration. The session directory is {{cwd}}.";',
      gates: ['libsync', ...FAST],
      note: 'the committed bundle carries a placeholder the source does not',
    }],
  },
  {
    id: 'rail-letter-blank',
    issue: 96,
    escape: 'C',
    klass: 'frontend-state',
    canonical: false,
    symptom: 'a lone "W" sits in the bottom-left corner of the collapsed sidebar',
    trigger: 'the rail form of the trigger (`wide === false`) renders only the letter glyph',
    // Class property: a rendered surface no test opens. The rail shape has never been mounted by the
    // suite; this plant is here to keep that statement measured rather than asserted.
    plants: [{
      file: 'src/client/AddWslWorkspace.tsx',
      find: '      <span className="dww-letter" aria-hidden="true">W</span>',
      replace: '      <span className="dww-letter" aria-hidden="true"> </span>',
      build: true,
      note: 'the glyph the user complains about changes; nothing compares what the rail renders',
    }],
  },
  {
    id: 'duplicate-tool-name',
    issue: 105,
    escape: 'A',
    klass: 'host-drift',
    canonical: false,
    symptom: '`wsl-standard` never mounts: `tool "read_image" is already registered in this scope`',
    trigger: 'a generated world in which two rows register the same model-facing tool name',
    // Class property: two rows claiming one tool name. Offline gates compare row **ids** and the row
    // count, never the name set the host will reject — so this plant is the measurement of that gap.
    plants: [{
      file: 'src/host/variants.ts',
      patch: before => {
        const lines = before.split('\n')
        const hits = lines.reduce((count, line) => (line.includes('- id: ${IMAGE_ROW_ID}') ? count + 1 : count), 0)
        if (hits !== 1) return before
        const index = lines.findIndex(line => line.includes('- id: ${IMAGE_ROW_ID}'))
        const pair = [lines[index], lines[index + 1]]
        const twin = [pair[0].replace('- id: ${IMAGE_ROW_ID}', '- id: ${IMAGE_ROW_ID}-twin'), pair[1]]
        return [...lines.slice(0, index + 2), ...twin, ...lines.slice(index + 2)].join('\n')
      },
      build: true,
      gates: [...FAST, 'node'],
      note: 'a second row mounts the same tool name under a different id',
    }],
  },
]

/** The canonical denominator: the 20 experience-class defects issue #101 counted. */
export const CANONICAL = UNITS.filter(unit => unit.canonical)

/** @returns the gate ids a unit runs, in order, deduped. */
export function gatesFor(unit) {
  const lists = unit.plants.map(plant => plant.gates ?? FAST)
  const merged = []
  for (const list of lists) for (const id of list) if (!merged.includes(id)) merged.push(id)
  return merged
}
