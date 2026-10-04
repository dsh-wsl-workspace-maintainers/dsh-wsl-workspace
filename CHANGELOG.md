# Changelog

All notable changes to `dsh-wsl-workspace`, newest first. Back to the [README](README.md); the Chinese record is [CHANGELOG.zh.md](CHANGELOG.zh.md).

## 0.7.6 — 2026-10-01

- **A DSH Desktop profile generated no WSL variant at all (issue #47).** The variant
  generator asked the host for two modules at call time — the entry-list dialect and the
  YAML engine under it — on the assumption that host and plugin share a `node_modules`.
  Desktop ships the host inside an archive, and Node finds a bare specifier by walking the
  filesystem upward, so that walk never reaches it. The first healthy source preset threw,
  the throw left the generation loop, and everything after the loop — including the sweep
  of the retired mechanism's leftovers — was skipped. The dialog's only answer was that no
  healthy `wsl` preset exists, and the cause sat in one swallowed host-console line.
  Reproduced on this machine with real packages rather than inferred: a dialect built
  against the release the host umbrella hoists, loaded through the release a sibling plugin
  hoists, fails inside the loader, on wording that names neither package, version nor path.
- **The dialect is built in the plugin now** (`src/index.ts`), from the same engine
  namespace that parses with it, so schema and engine cannot come from different majors.
  Only the read half of the published schema was ever used here; its write half serves a
  path this plugin does not take. Six lines, no new dependency.
- **The engine is a real dependency** (`js-yaml: ^4.1.0`, resolving to 4.3.2 — the release
  the host umbrella itself hoists). Declaring it an optional peer with a `*` range had
  handed the choice of major to whichever release the profile happened to carry, and with
  `autoInstallPeers` off an optional peer is never installed at all. The sibling plugin that
  keeps working in the same profile keeps working precisely because it declares a real
  dependency; this now matches. The two peer entries nothing imports anymore are deleted,
  so the manifest stops describing an import that does not exist.
- **One failing source is one variant's failure.** Generation is fault-tolerant per source,
  the retired-directory sweep runs regardless, and the outcome is a count line —
  `WSL preset variants: n/m registered` — because proving that routes answer had never
  proved that anything was generated. On `dsh web` that line is in the boot log and the
  compatibility matrix now asserts it; **on DSH Desktop it is not persisted anywhere**
  (measured on a real install: its log directory holds only crash bundles, which embed a
  child's stderr solely when that child exits non-zero, and capture only *renderer* console
  output — so a main-process `console.error` has no sink). Making the outcome visible there is
  issue #47's own recommendation #3 and is now filed as a separate ticket, on measured
  grounds rather than as polish. Before this change, a source that vanished
  mid-update preserved the previous complete variant only by accident: the abort skipped
  the sweep that would otherwise delete it. The accident is gone, the contract stays, and
  `tests/host-materialize.mjs` caught the difference on the first run.
- **A dialect failure names what it stood on** — package, version and path. That act is
  decided on a user's machine by an installer; it has since been measured through a real pnpm
  layout rather than assumed (see the last bullet), and the line still names the copy so a
  frame on some other installer carries its own conclusion.
- **New gate** `tests/host-profile-isolation.mjs` (`npm run test:profile`): profile-shaped
  trees under the temp dir, each booting the plugin's own copy — the loaned schema absent,
  the hoisted engine on the wrong major, both at once, and one unreadable source among
  healthy ones. Its control arm, its dialect-equivalence check against the pinned host
  schema, and its probe that every provider path a declaration names really imports were
  green on the *same* frame as the eight reds it was written to produce; three separate
  mutations of the fix each reddened a different subset, which is what keeps the two
  defects from being reported as one. `ci/install-pinned.mjs` materialises the hostile
  engine release in a second tree that is never linked into the repo root.
- **Two older gates were asking the wrong question.** `scripts/verify-install.mjs` now
  asserts the installed tree's runtime surface too: every declared dependency must be
  reachable from the installed `lib/` and on the declared version line, and an empty
  `dependencies` is itself a refusal — its earlier green was *produced* by the engine being
  absent, which is the state the issue reported. `scripts/verify-dsh-compat.sh` asserts the
  outcome count per matrix release: generating less than it was offered is `VARIANTS_FAIL`,
  and a line that never appears is `VARIANTS_NOT_VERIFIED`, never a pass.
- **What this machine could not decide, and what it did.** Measured for real, with pnpm's
  hoisted linker and the reporter's own `autoInstallPeers: false`: the published 0.7.5 in a
  profile tree whose sibling package hoists `js-yaml` 5.x generates nothing, and this build
  in that same tree gets its engine nested under itself and registers every source it was
  offered. The same pair was then run in this machine's own Desktop profile shape — and it
  turned out the real thing is installed here: `.dsh\profiles\desktop` carries 0.7.5 under
  exactly those settings with no engine and no include package on its walk-up, which is the
  report's shortage sitting on a maintainer machine the whole time. Still unmeasured: the
  packaged host **process** — reading that profile is free, launching a GUI plus its
  self-updater on a machine its owner is using is not, and it waits for a nod. The
  reporter's host-console line, which his report nominated as decisive, turns out not to be
  reachable by him at all: a healthy Desktop boot persists no host output (above), so that
  check is asked of a maintainer with a shell, and the reply drafted for #47 asks him instead
  for the observable — whether the dialog lists the variants.
  Both limits, and the frames that back the rest, are in `docs/compatibility-evidence.md`.

## 0.7.5 — 2026-09-30

- **The persistent shell works on DSH Desktop again (issue #40).** The Desktop
  host process *is* the packaged Electron executable running in node mode
  (`ELECTRON_RUN_AS_NODE=1`; the Desktop's own code is
  `new DesktopHostProcess(resources.node, …)` with
  `resources.node = process.execPath`), and the plugin pointed the PTY backend's
  `shellPath` at `process.execPath` with `shellArgs[0] = lib/wsl-relay.js`. An
  Electron binary writes **nothing at all** under a ConPTY: the relay's
  `wsl.exe` child inherits a dead stream, the relay exits 0 with zero bytes, the
  backend's readiness probe never sees a prompt, and **every** `bash` call fails
  with `PTY shell exited during startup`. The `0.1.0-rc.7` one-shot fallback is
  unaffected, which is exactly what hid the failure behind a mode that works.
  Measured with the host's own node-pty: same relay, same `\\wsl.localhost\…`
  cwd, same environment — a real node gives a bash prompt, the Electron binary
  gives 0 bytes and a clean exit.
- **The relay's interpreter is now resolved deliberately**
  (`src/shared/relay-node.ts`): first the runtime payload the Desktop passes to
  its host process (the `…/resources/runtime/primary-runtime` path in
  `process.argv`, which carries a real node), then the same payload beside the
  running executable (inside `Contents/Resources/…` on macOS), then
  `DSH_DESKTOP_NODE_EXECUTABLE`, then a `node` on `PATH`, and only then
  `process.execPath`. Every candidate is **asked what it is** (`-e` printing
  `process.versions.electron`), because `--version` cannot tell them apart: with
  `ELECTRON_RUN_AS_NODE` inherited the Electron executable answers with the
  *node* version (measured: `v24.18.1`), so any `^v\d+\.\d+\.\d+` test selects
  the broken one. A host that is not Electron (`dsh web`) keeps
  `process.execPath` and spawns no probe at all, so its behaviour is identical
  to 0.7.4; on the Desktop the chosen interpreter and every rejected candidate
  go to the boot log.
- PR #39 diagnosed this correctly and pointed the same way, but its first
  candidate, `DSH_DESKTOP_NODE_EXECUTABLE`, **is the Electron executable** — the
  Desktop's own `resources/runtime/bin/node.cmd` is `set
  ELECTRON_RUN_AS_NODE=1` followed by that variable — and its `--version` check
  cannot tell the two apart. This fix takes the same direction with the payload
  path first and a discriminator that actually rejects Electron.
- `tests/relay-node.test.mjs`: candidate derivation (argv / beside the
  executable / the environment variable, including de-duplication and order) and
  the Electron discriminator, including the version-shaped output that must be
  refused.
- `scripts/compatibility/conpty-relay.mjs`: **a new standing gate** — it drives
  the relay through a real ConPTY with the host's own node-pty and requires the
  resolved interpreter to produce a live bash prompt. That is the invariant
  issue #40 broke, and nothing checked it before. Registered in
  `Run-Checks.ps1` and the harness, so it runs on every declared release.
- **The second error in issue #40 is fixed too**: `bash_background` handed the jobs
  registry an `owner` of the wrong shape, which failed with
  `session "[object Object]" has no live agent` on `0.1.7` and later. That contract
  **changed at `0.1.7-rc.1`**: `start()` took the agent object before (the registry
  reads `owner.id` and `owner.ctx`) and takes the session id after (resolving it with
  `agents.get(id)`) — the host's own producers moved the same way, from
  `owner: parent` to `owner: parent.id`. The plugin now picks the shape from whether
  the registry offers `resolveOwner`; `tests/wsl-jobs.test.ts`, which had pinned the
  wrong half as correct behaviour, now pins both contracts, and all eleven declared
  releases were exercised one by one.
- `dsh.compatibility.dshReleases` declares `0.2.0-rc.2` (the DSH release DSH
  Desktop 0.2.0-rc.2 ships), so this build claims eleven releases instead of ten.
- **The second error in issue #40 is fixed too**: `bash_background` handed the
  jobs registry the agent object as the job owner, but the registry resolves that
  owner with `ctx.agents.get(owner)` and wants the **session id**, so every call
  failed with `session "[object Object]" has no live agent`. The host's own
  producers pass `agent.id`. `tests/wsl-jobs.test.ts` had asserted the broken
  contract as if it were correct; it now asserts the session id.
- **Verification**: sixteen harness checks on each of the eleven declared
  releases (14/16 everywhere — the two failures are the documented baseline:
  `typecheck`, and `host-api`, which needs a *running* frontend and passes 12/12
  when pointed at one), plus the runbook's six-item frontend pass on all eleven
  (dialog distro list, create & open, write, read, one-shot/persistent bash,
  skills, reopen from the UI) with `web.err` at 0 bytes and every file re-read
  independently on the Linux side.
- **And a full pass inside the real DSH Desktop.** The official installer was
  unpacked and the Electron application itself was started (isolated `DSH_HOME`,
  window driven over CDP, plugin installed and enabled through the Desktop's own
  plugin panel). With **0.7.4** installed, every `bash` call returned
  `PTY shell exited during startup` and `bash_background` returned
  `session "[object Object]" has no live agent`, while the dialog, the
  distribution list and the skills all worked. With **0.7.5**, bash returned
  `6.18.33.2-microsoft-standard-WSL2` / `/home/mille/fx-3381` / `mille`, a second
  independent `pwd` still said `/tmp`, `bash_background` returned `bash-1` with
  `job_list` reporting `bash-1 [bash] running` and `bg.txt` really containing
  `BG_3381_OK`, and the workspace still opened after a window reload. The boot log
  names the interpreter it chose. The whole run is written up in
  `docs/compatibility-evidence.md`.

## 0.7.4 — 2026-09-28

- **The dialog works in DSH Desktop again (issues #35, #36).** The Desktop host
  wraps `child_process` before the plugin is loaded: it installs plain
  `exec`/`execFile` wrappers and re-exports them with
  `syncBuiltinESMExports()`. That copy of `execFile` carries no
  `util.promisify.custom`, so `promisify(execFile)` fell back to the generic
  implementation, which resolves with the **first** callback argument only —
  the stdout string — and `result.stdout` was `undefined` on every call. The
  distro lookup read `.stdout` and threw
  `Cannot read properties of undefined (reading 'includes')`, the frontend
  caught it and rendered an empty picker: the dialog opened, the distribution
  list stayed empty, and "Create & open" could not be completed, while
  `wsl.exe -l -q` in a terminal listed the distribution normally. All three
  call sites now use the **callback** form of `execFile`, which no wrapper can
  reshape.
- **The `wsl.exe` lookup is a candidate list.** `wsl.exe` is tried on `PATH`
  first, then the absolute `%SystemRoot%\System32\wsl.exe`, and a lookup that
  fails now names every candidate it tried and the error each one produced,
  instead of a type error from inside the decoder.
- `tests/exec-shape.mjs` reproduces the Desktop wrapper (plain wrappers plus
  `syncBuiltinESMExports()`), spawns a probe with and without `--import`,
  asserts the wrapped shape is broken and the new helpers are right, and runs
  the real `listDistros`/`defaultDistro`/`resolveLinuxSymlink` through both
  shapes. It is registered as the `exec-shape` check in
  `scripts/compatibility/Run-Checks.ps1` so a future refactor cannot
  reintroduce the promisified call.
- `dsh.compatibility.dshReleases` declares `0.1.7-rc.2` as well, so this build
  claims ten releases instead of nine.
- **Verification**: fifteen harness checks on each of the ten declared releases
  (13/15 everywhere — the two failures are the documented baseline: `typecheck`
  and `host-api`, which needs a *running* frontend and passes 12/12 when pointed
  at one), plus the runbook's six-item frontend pass on all ten (dialog distro
  list, create & open, write, read, one-shot bash, persistent bash, skills) with
  `web.err` at 0 bytes and the file re-read independently on the Linux side.
  The Desktop-wrapper reproduction is in `docs/compatibility-evidence.md`,
  together with the pack-identity hash and the plain-npm install gate.

## 0.7.3 — 2026-09-23

- **The plugin loads on DSH `0.1.7-rc.1` again, and its modes come back.** The
  `0.1.7` line renamed the host preset face — `read()` became `readDocument()`, which
  returns a document (`{agentPreset, content, name, description}`) instead of the
  composition text, and `AgentPreset` lost its `path` — so the variant generator
  threw `agentPresets.read is not a function` on every boot and no `wsl-*` mode
  ever reached the picker. The roster face is now probed by capability and both
  generations are served: `readDocument()` where it exists, `read()` behind it.
- **A variant is a declaration row on that line.** `0.1.7` stopped scanning
  `$DSH_HOME/.agent-presets/` — a preset there is a declarative
  `@deepseek-ai/dsh-agent-preset` row, and the directory a variant used to be
  written to is read by nothing at all. The generator now expands the composed
  variant back into an entry list and publishes it through
  `ctx.agentPresets.register()`; the plugin's effect owns the returned disposers, so
  an unload or hot reload retires the variants instead of leaving orphans the next
  apply could not replace (`Duplicate agent preset: wsl-<mode>`). Earlier releases
  keep the directory channel, unchanged.
- **The world's own providers are named as `file:` URLs on that channel.** A preset
  mounted from a declaration is imported by the registry's entry tree, which —
  unlike the boot-time Include — does not turn an absolute path into a `file:` URL.
  Without the rewrite the provider rows never started, the audit reported each as
  `never started`, and the whole variant was refused as unusable.
- **The PTC variant is named again on `0.1.7`.** The label table that gives the
  shipped modes their bilingual `WSL · …` names carried the mode's older id
  (`code`) but not `ptc`, the id it has used since `0.1.1`. That stayed invisible
  as long as the release published its own display name, because the lookup fell
  through to it — but `0.1.7` publishes none, so the mode reached the picker as
  `WSL · ptc` with the generic `WSL execution world for ptc: …` description. Both
  ids are covered now, and the variant reads `WSL · PTC mode（PTC 模式）` on every
  channel, like the other three shipped modes.
- `dsh.compatibility.dshReleases` declares `0.1.7-rc.1`. The two modules the
  declaration channel needs (`@deepseek-ai/cordis-plugin-include`, `js-yaml`) are
  resolved at call time and declared as **optional** peers, so a release that lacks
  them fails one variant rather than refusing to load the plugin.

## 0.7.2 — 2026-09-21

- **The WSL skill catalog is no longer re-walked on the request path (issue #25).**
  The host rebuilds the catalog during a request and awaits each provider's
  `list()`, and this provider kept its own answer for only 10 s — so every time the
  catalog was re-collected (a new session or scope, or simply a lookup more than
  10 s after the last one) that request paid a full walk of the workspace, one
  directory at a time: two `stat`s and one `readdir` each. A `readdir` over the
  `\\wsl.localhost\…` 9P share measures 3-16 ms here and the walk's budget is 4096
  directories, which is why a large workspace cost 20.4 s, on the request path. A
  published catalog is now served as-is, and only the provider's own change detector
  can drop it: a repeat lookup costs 1-3 ms and no filesystem traffic. The freshness
  contract is unchanged — a new nested skills directory still appears within 30 s,
  and an added, removed or edited skill within 3 s.
- The walk itself is cheaper: one BFS layer is probed concurrently (bounded) and
  published in frontier order, so the catalog stays deterministic, and a
  directory's `.dsh/skills` / `.agents/skills` are probed only when its own listing
  showed that marker. The budget-sized walk went from 20.4 s to 4.8 s on the same
  machine; node's filesystem thread pool caps the real parallelism.

## 0.7.1 — 2026-09-20

- **`npm install dsh-wsl-workspace` no longer fails.** Verifying the published
  artifact turned up a regression this release introduced: npm auto-installs
  missing peer dependencies, and the `@deepseek-ai/dsh-tool-fs-search` peer added in
  0.6.0 itself peers on `@deepseek-ai/dsh-retention`, which is **not published** — so
  a plain `npm install` died with `E404 … @deepseek-ai/dsh-retention` (0.4.3 installs
  fine, so it was ours). `dsh plugin add` uses pnpm, which only *warns* about unmet
  peers, which is why every harness run and real install passed. All ten host peers
  are now marked optional in `peerDependenciesMeta`: the package still declares what
  the host must provide, but npm no longer tries to fetch it.

## 0.7.0 — 2026-09-20

The WSL world now matches the host everywhere a session can tell the difference,
and the last two known issues are closed. Everything below ships together: a WSL
variant gets Linux symlinks, the session's access mode, in-distribution search, a
live skill catalog, a stateful shell, and tracked background jobs.

- **The host's `bash` contract is stated in the tool description.** The persistent
  tool wraps each command as `eval -- $'…'`, so a command ending in `&` backgrounds
  the *whole* wrapped command — the call returns immediately with exit code 0 and
  no output while the real output arrives later, possibly inside the next call's.
  And the shell is one process for the whole Agent, so a `cd` carries into the next
  call. The host default says neither, and DSH's own Minimal preset recommends the
  hazardous form (`sleep 10 &`). The world now overrides `description` (a supported
  key on every declared release) with both facts and the safe forms.
- **`0.1.0-rc.7` falls back to a working one-shot shell.** That release's
  `dsh-subprocess-local` has no Windows process inspector, so the host's PTY-backed
  persistent shell cannot start on Windows at all — every `bash` call failed with
  `subprocess-local: terminal inspection is unsupported on platform win32` (the
  host ships the same gap: its Minimal preset mounts `persistent-bash` there with
  no Windows guard). The plugin now *probes* the substrate instead of assuming —
  it hands `spawnTerminal` a program that cannot exist, which reaches the inspector
  check and nothing else — and when the answer is no, the world keeps the one-shot
  `dsh-tool-bash` row: a working, stateless shell rather than an error per call.
- **Tracked background jobs, restored.** Replacing the one-shot bash tool with the
  persistent one also removed the only thing that started a registry job, so
  `job_list` always answered "no background jobs" and a `run_in_background: true`
  argument handed to `bash` was silently ignored (the parameter schema allows extra
  properties, so nothing complained). The world now mounts `bash_background`
  (`src/host/wsl-jobs.ts`), a thin producer over the host's own `ctx.jobs.start`
  plus this plugin's `ctx.shell.start`: it returns a job id, and
  `job_list`/`job_output`/`job_kill` work on it as usual. It is mounted only where
  the source mode also mounts the `job_*` tools, and only alongside the persistent
  shell.
- **Six defects found by hunting the new code with worst-case input**: a hidden-file
  guard that also applied to an explicitly named file (`grep path=.env` returned
  nothing), a discarded `find` exit status (`glob path=/nope-missing` looked like an
  empty directory), a line-terminated glob header (a root whose name contains a
  newline came back truncated), untranslated Windows paths (`grep path='D:\proj'`
  failed where `read` worked), a closed spill schema (which would have failed the
  tool's own output validation on every capped search), and a catalog detector that
  could stack polls on a slow share. Plus two in the new producer: it was mounted in
  a mode with no `job_*` tools to read its ids, and it defaulted a job's working
  directory to the host process's rather than the session workspace.
- **Verification**: thirteen checks on each of the eight declared releases
  (`0.1.0-rc.7` … `0.1.5-rc.2`) — `search-real` drives the real tools against a real
  distribution fixture — leaving only the two pre-existing baseline failures
  (`typecheck`, and `host-api` which needs a live server). 152 unit tests, including
  a parity check of every renderer against the host suite's own formatters. Real
  browser sessions on five releases for the tool behaviour, and a **frontend pass on
  all eight** (entry button, dialog, path check, create & open, mode picker, help
  panel with v0.7.0 and 8 release chips), with the session log as evidence for the
  tool set, the search results, the catalog replacement, the shell fallback and the
  background-job lifecycle.

## 0.6.0 — 2026-09-19

- **WSL sessions get `grep` and `glob`**: the host suite spawns the packaged Windows ripgrep and every path the model hands it is a Linux one, so the generated world dropped `tool-fs-search` and left the model to grep through the shell — the last bullet of the panel's known issues. The world now mounts an in-distribution twin that keeps the host suite's contract: the same tool names, parameter schemas, inline caps (250 matches / 100 paths), output schema, `Line N:` grouping, found-count header, capped-result footer, search card and formatted-result spill — the rendering comes from `@deepseek-ai/dsh-tool-fs-search`'s own exported formatters, and the two projections that package keeps private (the card metadata and the glob page) are reproduced and compared against it in unit tests. `grep` runs GNU grep inside the distribution (`-rnIEH -Z`, POSIX ERE, hidden entries and `node_modules` skipped like ripgrep's defaults, no `.gitignore` support), `glob` uses GNU `find` with in-process gitignore-style matching and ripgrep's oldest-first modification order. Model-controlled values travel as separate argv elements after a fixed script, so nothing the model types is ever parsed by a shell.
- **The skill catalog notices an edited skill, not just an added one**: the catalog message is rebuilt only when the registry's revision moves, and the old detector compared directory listings — so rewriting an existing `SKILL.md` (a description, say) changed nothing it could see and the model kept the old text until a new session. The cheap pass now also stamps every skill file with its modification time and size, and runs every 3 seconds instead of 10. The full re-discovery walk — the only pass that can find a skills directory that did not exist before — moved to its own 30-second cadence, so the change detection is both faster and cheaper than the single 10-second poll it replaces.
- **`lib/` is rebuilt deterministically**: `tsdown` writes into a committed `lib/`, and stale code-split chunks from an earlier build survived every rebuild (`clean: false` plus two configurations sharing one output directory). Local build tooling now clears the directory first, and the three new runtime peers (`@deepseek-ai/dsh-tool-fs-search`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) are declared, which is also what keeps them external instead of bundling a second copy of DSH's tool stack into this plugin.
- **Four defects found by hunting the new code with worst-case input**: a hidden-file guard that also applied to an explicitly named file (`grep path=.env` returned nothing), a discarded `find` exit status (`glob path=/nope-missing` looked like an empty directory), a line-terminated glob header (a root whose name contains a newline came back truncated) and untranslated Windows paths (`grep path='D:\proj'` failed where `read` worked). The spill schema was also closed, which would have failed the tool's own output validation on every capped search, and the catalog detector gained an in-flight guard so a slow poll cannot stack `wsl.exe` calls.
- **The host's `bash` wrapper is documented in the tool description**: the persistent tool wraps each command as `eval -- $'…'`, so a trailing `&` backgrounds the whole wrapped command and the call reports exit code 0 with no output; and the shell is one process, so a `cd` carries into the next call. The host default says neither, and DSH's own Minimal preset recommends `sleep 10 &` — the world now overrides the description with both facts and the safe forms.
- **`0.1.0-rc.7` no longer gets a broken shell**: that release's `dsh-subprocess-local` has no Windows process inspector, so the host's PTY-backed persistent shell cannot start on Windows at all (the host ships the same gap: its Minimal preset mounts `persistent-bash` there with no Windows guard). The world probes the substrate at startup and, when the answer is no, keeps the one-shot `bash` row — a working stateless shell — instead of failing every call. Verified by a real session on that release.
- **Tracked background jobs are back in WSL sessions**: replacing the one-shot bash tool with the persistent one also removed the only thing that started a registry job, so `job_list` always said "no background jobs" and `run_in_background: true` handed to `bash` was silently ignored (the parameter schema allows extra properties, so nothing complained) — the exact defect an operator's session surfaced. The world now mounts `bash_background` (`src/host/wsl-jobs.ts`), a thin producer over the host's own `ctx.jobs.start` + this plugin's `ctx.shell.start`: the tool returns a job id, and `job_list`/`job_output`/`job_kill` work on it as usual. Verified in a real session: `started background job bash-1` → `job_list` shows `running` → incremental `job_output` reads (`tick 1`, `tick 2`, then `tick 3`) → `[status: completed, exit code: 0]` plus the runtime's completion notice.
- **Verification**: thirteen checks on each of the eight declared releases (`0.1.0-rc.7` … `0.1.5-rc.2`) — `search-real` joins the suite, driving the real tools against a real distribution fixture (framing, includes and braces, caps and footers, spill, cards, error codes, argv-safety, explicit dot-files, unreadable roots, odd root names, `/mnt` paths, abort and overflow, glob ordering and pruning) — leaving only the two pre-existing baseline failures (`typecheck`, and `host-api` which needs a live server). Unit tests add `tests/wsl-search.test.ts` (33 cases) and the refresh, cadence, stacking and description cases; `skills-real` proves an edited skill file invalidates the catalog through the share's own modification times. Real browser sessions on five releases confirm the behaviour end to end, including the `0.1.0-rc.7` fallback.

## 0.5.0 — 2026-09-19

- **The file tools now follow Linux symlinks**: the `\\wsl.localhost` share lists a link entry but cannot describe it — `lstat`, `stat` and `readFile` on the link all fail and `resolve()` hands back a lexical identity for it — so a link path behaved like a missing file and a linked-in project's files could not be read or written at all. `resolve`/`lstat` now ask the distribution (`wsl.exe … readlink -f`, the same resolver the skill scan uses) whenever this share cannot already describe the path, and continue at the real path. A link is never replaced by a regular file, and writing through a dangling link creates its target while keeping the link.
- **The access mode constrains a WSL session again**: a variant mounts its own `fs` provider in the preset's isolate realm, so the host's `fs-sandbox` wrapper was not in the call path and `workspace-write` did not stop a write outside the workspace (measured before the fix: a Linux path and a `D:\...` path both went through). `writeText`/`editText` now fence the mutation exactly as `@deepseek-ai/dsh-fs-sandbox` does: `ctx.sandboxPolicy` (the tool layer's per-call value, else the service), the same `writableRoots` allow-list plus the distribution's `/tmp`, the same `FS_SANDBOX_DENIED`, and the `sandboxMode` getter the tool reads to advertise escalation. Because the fence runs after link resolution it judges the real path, so a link out of the workspace is an outside write.
- **Live skill catalog**: with `watch: false` pinned on the UNC-hostile watcher, a skill added while a session ran only appeared in the next session. The provider now keeps a change detector per scan root it has served, re-checking the published directory shape every 10 s (roots plus entry names and kinds, never re-reading skill files) and calling `control.invalidate()` when it changed, which makes the catalog middleware re-collect on the session's next turn.
- **`bash` is now a stateful WSL shell** — the capability the per-mode matrix kept showing was missing (every `bash` call used to be a fresh process). DSH's PTY registry takes replaceable backends and `@deepseek-ai/dsh-terminal-bash` is a config-driven one, so the world mounts it (inside its own `persistent-shell` group, because the registry is an agent-owned service) with `backendType: wsl` and points it at this plugin's relay (`src/host/wsl-relay.ts` → `lib/wsl-relay.js`) run by the host's own node. The relay resolves the distribution (session UNC cwd → `DSH_WSL_DISTRO` → host default) and the optional `DSH_WSL_USER`, then hands its stdio — the PTY — to `wsl.exe -d … --cd … -e bash -lc 'cd … && exec bash -i'`: login environment, interactive, and the session directory preserved. `@deepseek-ai/dsh-tool-bash-persistent` registers the **`bash`** name, so it takes the place of the one-shot `dsh-tool-bash` row (mounting both fails the whole preset — the same collision DSH's Minimal mode sidesteps by being a persistent-shell-only agent). The world also isolates and provides its own no-op `sandbox` capability: the PTY backend confines through `ctx.sandbox` before spawning, and the host's Windows runner cannot read the security descriptor of a `\\wsl.localhost\…` workspace root (`GetNamedSecurityInfoW failed (Win32 1)`), so a WSL session declares `enforcement: 'partial'` and keeps the policy where it is meaningful — in the file tools.
- **Verification**: the eight declared releases (`0.1.0-rc.7` … `0.1.5-rc.2`) run twelve harness checks — `fs-real` (link resolution through the real backend, reads through links and chains, dangling-link creation, link preservation, the fence on an outside link target, the distro `/tmp` allowance) and `relay-real` (stateful shell against real WSL, distribution and user resolution, clean exit) are new — with the same two documented baseline failures (`typecheck`, and `host-api` needing a live server). Unit: `tests/fs-policy.test.ts` (7 fence cases) and the skill-provider refresh cases, on top of the existing suite.

## 0.4.5 — 2026-09-19

- **A project linked into a WSL workspace is discoverable now**: the `\\wsl.localhost` 9P share lists a Linux symlink but cannot resolve its target, so the skill scan — which already followed directory links on substrates that resolve them — skipped every linked-in project, and with it every nested project below it (the layout issue [#10](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/10) describes). When the share reports a link it cannot follow, the provider now asks the distribution itself (`wsl.exe -d <distro> -- readlink -f <linux path>`) and continues the walk at the real path. The fallback is bounded on purpose: at most 32 links per lookup, four calls in flight, a 10 s timeout each, and the existing depth / visited-directory / skill-directory budgets are untouched. Because the walk continues at the resolved path, a project reachable both directly and through a link is visited once, and a link that points back at the workspace root is absorbed by the visited set instead of looping.
- **What the fallback does not cover**: `read/write/edit` still resolve their paths through `WslFileSystem`, which does not follow Linux links, so reading or writing a link path reports it missing — use the real path. The help panel's known-issues list now states that instead of promising a fallback "not implemented yet".
- **Why one `wsl.exe` per link** (measured, and worth recording): `wsl.exe` silently drops the arguments that follow a command (`sh -c 'echo $#' sh a b c` answers 0), and its command-line parser truncates an argument containing a double quote, so a batched `sh` loop cannot be made reliable through it. A bare `readlink -f a b c` is no better: GNU `readlink` stops at the first path it cannot resolve and still exits non-zero, which would silently starve the rest of the batch. Passing each path as a process argument to one short call avoids quoting entirely — paths with spaces, quotes and backslashes all resolve — at the cost of one process per link (about 35 ms warm; six links cost 179 ms end to end on this machine, and a workspace with no links never starts a distribution process at all).
- **Verification**: the eight declared releases (`0.1.0-rc.7` … `0.1.5-rc.2`) pass the same 8/10 harness checks as 0.4.4 — only the documented `typecheck` baseline and the check that needs a live server fail. The real-9P check now builds a fixture whose only path in is a symlink and asserts the linked project, its nested project and its service through `get()`; the same walk with the fallback face removed finds neither, which is the pre-fix behaviour reproduced in the same run. On a live WSL fixture (`/home/mille/symprobe/ws`: a link out of the workspace, a link chain, a file link, a dangling link and a loop back to the root) the catalog went from 2 skills to 5, and `get()` read every body through the resolved locator.

## 0.4.4 — 2026-09-19

- **A preset built on top of a WSL variant could not be used at all**: this generator recognises its own output by id prefix (`wsl-`), so a user preset that started life as a copy of `wsl-standard` or `wsl-cordis` — a "data mode" that carries its own world, say — was treated as a plain source preset and had a *second* world group appended to it. DSH refuses a composition carrying two `wsl-world` rows, so choosing that mode failed outright with `无法切换到「WSL · <name>」：duplicate loader entry id: wsl-world`; on a release that mounts the group before validating row ids the same duplication surfaces one step later as `tool "str replace editor" is already registered in this scope` (the report in [#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24)). The generator now replaces the world group it finds — identified by the mounted `shell-wsl`/`fs-wsl` provider ids, so a copy whose group was renamed is caught too — and every variant ends up with exactly one world pointing at this installation's providers. A top-level row id that appears twice in a source is reduced to its first occurrence as well, because DSH rejects the whole preset on a duplicate id rather than the offending row.
- **`tool-str-replace-editor` rows are replaced like the older `str-replace-editor` row** ([#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24)): newer rosters name the editor row that way, and it registers the same `str_replace_editor` tool as the world group's own editor row, so the source row is dropped just like its predecessor and the WSL-aware editor the variant injects stays.
- **Variant display names are no longer double-quoted**: the variant's `preset.yml` copied the source's `name:` scalar verbatim, so a quoted `name: 'Data mode'` reached the mode picker as `WSL · ''Data mode''`. The scalar is unquoted before it is re-emitted.
- **Not adopted from [#24](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/pull/24)**: disabling the `tool-cordis` row to avoid a duplicate inspect-provider registration. A `disabled` row never applies, so the WSL variant of Creator mode silently lost `cordis_inspect_list` / `cordis_inspect_query` (checked against 0.4.3, where both are present and answer with the host and the client providers); the PR's own description that the model "can still see the tools in the catalog" is not what happens. The registration their report shows needs that row applied twice, which the row-id reduction above now prevents where a copied preset caused it.
- **Help panel tidied up**: the panel now opens with a greeting line and the repository link, carries a "What's new" section for this build, and lists only the limitations that still apply — the historical "fixed in 0.4.3" note and the per-generation API walkthrough are gone. The compatibility chips are untouched: they are the manifest this build declares, not history.
- **Verification**: the eight declared releases (`0.1.0-rc.7` … `0.1.5-rc.2`) pass the same 8/10 harness checks as 0.4.3 — only the documented `typecheck` baseline and the check that needs a live server fail; 136 transforms over every shipped preset of the 17 installed runtimes are unchanged apart from the repair, and all 68 "copied variant" cases resolve to a single fresh world group.
- **Per-mode matrix with a real model** (every WSL variant, not just the default one): on `0.1.0-rc.7`, `0.1.1-rc.2`, `0.1.3-alpha.2` and `0.1.5-rc.2` each of the four variants — Standard, PTC, Minimal, Creator — was driven through the browser and asked to write a file with its file tool, run `uname -r; pwd; whoami` in bash and land that output in the workspace, then read the file back. Every mode produced `MODE-<mode>-OK` and a WSL2 kernel line in `/home/mille/<workspace>/notes/` with no loader error; the follow-up bash call lands in the workspace again, which is the documented per-call shell (the PTY group stays dropped). `0.1.2-rc.1` and `0.1.5-rc.1` were driven through all four modes without the file/bash assertions.
- Browser + real-model spot checks of the copied-variant mode (mounts and answers), Creator mode (inspect tools intact) and the `0.1.0-rc.7` standard flow complete the pass.

## 0.4.3 — 2026-09-11

- **The persona text moved in `0.1.3-alpha.2`** ([#22](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/22)): DSH renamed the persona's model-facing scalar from `text` to an inline `suffix` plus a folded `prefix`, and the variant generator only recognised `text: >-`. On that line the WSL environment sentence was never appended - the session still ran inside the distribution, but the model was never told that its working directory is a Linux path reachable from Windows as `/mnt/<drive>`. The generator now amends `suffix`, `text` or `prefix` (folding an inline scalar into a block scalar when needed, so the sentence joins the working-directory line exactly where the legacy `text` block put it), and a persona carrying `complete: true` is still left alone. Verified on seven releases: the five older ones keep their persona block byte-identical, and the two newer ones now carry the sentence into the model's system message.
- **Help panel**: the dialog gained a "?" button that opens an in-place panel - the DSH releases this build declares (read from `package.json` through the host route, so the list can never drift from the manifest), how the plugin is used, its features, and the limitations it cannot fix.
- **The skill catalog now reaches UNC workspaces**: the host skill provider watches a workspace through `chokidar`, and watching a `\\wsl.localhost\...` path fails; the failed watcher makes the skill snapshot report `complete: false`, and `dsh-tool-skill` withholds the *entire* catalog message while a snapshot is incomplete — so a WSL session's model saw no skills at all, not even the ones the plugin had discovered. The variant generator now pins `watch: false` on the `skill-filesystem` row (merged into an existing `config:` block when there is one, and left alone when the source declares `watch` itself), which makes the host collect the catalog once at session start instead. Verified end to end on `0.1.5-rc.2`: the model's context carries the `<available_skills>` list. Trade-off: a skill added mid-session appears in the next session rather than the running one; skill bodies are still read live.
- **`verify-lib` hardening**: its comment/string stripper could pair a lone apostrophe inside a comment with a later one and swallow the rest of the bundle, which made every `node:*` import look tree-shaken. The quote rules now stop at a newline, exactly as a JavaScript string does.

## 0.4.2 — 2026-09-10

- **Create & open in a `0.1.2-rc.1` workspace**: the session starter is now resolved when the dialog writes, not when the plugin applies. This plugin applies *before* the UI domain that publishes `uiWorkspace` registers its service, so the lookup cached at apply time stayed `undefined` for the whole page life: `Create & open` created the workspace and then silently opened no session, leaving `sessionIds` empty while the dialog reported success. A release exposing neither `uiWorkspace.startSession` nor `workspaces.startSession` now fails *before* anything is written, instead of leaving an orphaned workspace behind.
- **Skill body integrity**: skill bodies no longer lose their first character. `findFrontmatterEnd` already returns the index of the body's first character (the closing delimiter's newline plus one), so the slice must start there; the previous offset dropped that character and made the one after the delimiter look like the body. The existing fixtures always put a blank line after the delimiter, which is exactly what hid it.
- **UTF-8 BOM skills are no longer dropped**: a `SKILL.md` saved with a leading BOM (Notepad, VS Code's "UTF-8 with BOM", PowerShell redirection) did not match the opening `---` and disappeared from the catalog entirely. The parser strips the BOM before the fence check.
- **Binding converges on late inputs**: the agent-preset roster and the registered `/mnt/<drive>` workspace set are both inputs to binding, and both land asynchronously after the plugin's first pass. Each now re-runs the pass when it arrives instead of waiting for a session-store event that may never come.
- **Compatibility manifest corrected**: `0.1.3-alpha.1` is not published (`npm view @deepseek-ai/dsh@0.1.3-alpha.1` is a 404), so the declaration could never be verified; it is replaced by the published `0.1.3-alpha.2`.
- **Reproducible publishes**: a new `.gitattributes` (`* text=auto eol=lf`, `lib/** -text`) pins line endings. `core.autocrlf=true` used to rewrite text files to CRLF on checkout, and since `lib/` is committed and published verbatim the same commit produced different npm tarballs depending on the machine; the repository already stored LF, so no renormalisation was needed.
- **Closed-loop tests**: `tests/client-lifecycle.test.mjs` drives the browser half through the shipped `lib/client.js` for both service shapes — legacy (`connection.api.agentPresets` + `workspaces.startSession`) and current (`remote.agentPresets` + `uiWorkspace`) — and asserts `Create & open` for the normal, late-registration and no-starter cases. The skill tests now cover a body that starts on the delimiter's next line, for LF and CRLF files.

## 0.4.1 — 2026-09-03

- **DSH v0.1.2-rc.1 compatibility**: Added backward compatibility support for DSH v0.1.2-rc.1 and later versions through feature detection and compatibility wrappers. The plugin now automatically detects the DSH version at runtime and uses the appropriate API:
  - `uiWorkspace.startSession()` for v0.1.2-rc.1+
  - `workspaces.startSession()` for v0.1.1-rc.2 and earlier
  - `summary.projectionValues?.agentPreset` for v0.1.2-rc.1+
  - `summary.agentPreset` for v0.1.1-rc.2 and earlier
  - Projection-based auto-sync for v0.1.2-rc.1+
  - `sessions.noteAgentPreset()` for v0.1.1-rc.2 and earlier
- **Updated compatibility manifest**: Added v0.1.2-rc.1 to the `dsh.compatibility.dshReleases` declaration.
- **Fixed `without inject` crash on v0.1.2-rc.1+**: the agent-preset roster is read through the `remote.agentPresets` namespace service via `ctx.get('remote.agentPresets')` (topology-free store lookup) instead of the `remote` aggregate's `agentPresets` property, which Cordis' associate proxy rejects when the dotted property is not declared in `inject`. `inject` stays limited to the services both DSH generations share (`slots`, `locale`, `sessions`, `workspaces`).
- **Compatibility manifest**: declared v0.1.3-alpha.1 compatible (its plugin-facing API surface matches v0.1.2-rc.1). Final adaptation notes consolidated in `docs/archive/compatibility-summary-0.4.1.zh.md` (supersedes the root-level draft plans).

## 0.4.0 — 2026-08-29

Follow-ups from the [#12](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/12) limitation list and the [#13](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/13) compatibility work:

- **Lookup cache**: completed skill-catalog lookups are cached per scan root for 10 seconds, so repeated catalog builds no longer rescan the workspace over the slow 9P share; `get()` keeps reading skill bodies live, and freshly added skills appear within the TTL window.
- **Symlinked projects — investigated in 0.4.0, resolved in 0.4.5**: the discovery walk now recognizes directory symlinks explicitly and prunes them safely (no crashes, no loops), and the probe showed that following them is impossible over the `\\wsl.localhost` share itself (the Windows side cannot resolve Linux symlink targets: `readlink` → `EISDIR`, `stat`/`readdir` → `ENOENT`); 0.4.5 resolves them through the distribution instead, so linked-in projects are discoverable (see that changelog entry). A name+body fingerprint dedupe also guarantees aliased skill files can never publish twice on substrates that do resolve links.
- **Block-scalar frontmatter**: `description:` / `whenToUse:` written as YAML block scalars (`|` literal, `>` folded) now parse — such skills were silently dropped before.
- **Compatibility manifest**: `dsh.compatibility.dshReleases` declares per-release compatibility with the official DSH versions, backed by reproducible disposable-Profile install/start/uninstall evidence (`scripts/verify-dsh-compat.sh`), and `engines` declares the Node.js floor.
- **Guard scripts**: `scripts/check-rank-parity.mjs` fails the release when the copied project-rank constants drift from the host's `dsh-skill-filesystem`.

## 0.3.2 — 2026-08-29

- **WSL workspace sessions now inject nested-project skill catalogs** ([#10](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace/issues/10)): `.dsh/skills` and `.agents/skills` directories of projects nested below the registered workspace root are discovered and published with the host's project ranks and sources, so the model sees the same skill catalog it would see when the session cwd is the project folder itself. Discovery is depth- and budget-bounded, prunes `node_modules`/dot-directories, and leaves non-WSL sessions untouched.
- **Host-parity scan root**: lookups from inside a project subtree resolve the nearest `.git` ancestor first, so the enclosing project's skills stay visible from deeper cwds; skills above that ancestor do not leak.
- **Hardening**: the skill-root budget is enforced per push, and the `skills.registerProvider` call is guarded so a host whose `skills` service has a different shape can no longer break plugin load.
- **Housekeeping**: removed stale prebuilt `lib/` chunks that shipped dead vendor code (including an inlined schemastery copy that triggered dsh.so's `new Function` static rule); added `scripts/repro-setup.sh` plus a nested skill-catalog regression suite, and a matching TESTING.md section.
