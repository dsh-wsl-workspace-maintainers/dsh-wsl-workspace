# Testing

This document describes how to verify `dsh-wsl-workspace` after a change or before a release. The suite covers unit tests, the two preset-channel integration tests (the retired directory generation and the declaration generation), a real-WSL smoke test, and a post-build lib verification gate.

> **Fast path (same commands CI runs):** after `npm ci && node ci/install-pinned.mjs`,
> run `npm run test:unit`, `npm run test:node`, `npm run test:profile`, `npm run test:wsl`
> (Windows + a real distribution), `npm run typecheck:gate` and `npm run verify:artifact`.
> The full inventory of every check — command, prerequisites, CI home, and what is
> still human — is [docs/CHECK-CATALOG.md](docs/CHECK-CATALOG.md). This document keeps
> the background and the release checklist.

## Prerequisites

- Windows host with WSL2 and at least one distribution installed (`wsl.exe` on `PATH`).
- Node.js 24+ (the tests run with Node's built-in TypeScript support; `tsx` is not required).
- The DeepSeek Harness checkout (for `tsc`/`tsdown` and the `@deepseek-ai/*` type declarations the `tsconfig.json` paths point at).

## Unit tests

Run the unit tests from the plugin directory:

```powershell
node --experimental-strip-types --test tests/variants.test.ts tests/fs-execution-context.test.ts tests/shell.test.ts tests/paths.test.ts tests/wsl-skills.test.ts
```

Coverage:

| File | What it verifies |
|---|---|
| `tests/variants.test.ts` | The WSL preset-variant transform: world rows are dropped, the WSL realm is injected, `str-replace-editor` is re-injected exactly once (and only when the source references it), prefab-family rows (`custom-bash`, `bootstrap-filesystem`) are removed, unknown rows are preserved verbatim. |
| `tests/fs-execution-context.test.ts` | `WslFileSystem` inherits the calling session's cwd through `AsyncLocalStorage` on `tools/execute`; agentless calls fall back to the configured distro. |
| `tests/shell.test.ts` | The login-shell `cd` prefix preserves the resolved workdir (including single-quote escaping); non-login shells leave the command unchanged. |
| `tests/paths.test.ts` | UNC ↔ Linux path translation, `/mnt/<drive>` mapping, canonical Windows path keys, WSL username validation. |
| `tests/wsl-skills.test.ts` | The WSL skill provider (issue #10): non-WSL lookups return nothing, nested `.dsh/skills` / `.agents/skills` discovery with host ranks/sources, `get()` body loading, pruning of `node_modules` / dot-directories, frontmatter validation **including block scalars**, depth and skill-root budgets, the nearest-`.git`-ancestor rule (a cwd deeper than the project root still sees the project's skills, and skills above that ancestor do not leak), the skill-root cap, the **10-second per-scan-root lookup cache** (copy semantics, TTL expiry, `get()` staying live), **directory-symlink following** (linked projects discovered, aliasing deduplicated, dangling symlinks pruned, hops bounded by depth). |

## Provider parity and compatibility checks

- `node scripts/check-rank-parity.mjs` — the provider's project ranks are copied from `@deepseek-ai/dsh-skill-filesystem` (the host does not export them). This script parses the host's built lib when the package is resolvable on this machine and fails on drift. Strict by default: no resolvable host package is `NOT VERIFIED` and exits 1 (pass `--lenient` for the old warning-and-skip, `--host FILE` to compare against one explicit bundle). Run it before every release on a machine with the harness installed.
- `node ci/install-pinned.mjs --verify-only` — compares every pin in `ci/pinned-deps.json` against the tree that is already installed, without writing a manifest, running npm or linking anything. Use it as the read-only probe when you need to prove the version comparison bites; installing against a changed pin rewrites `ci/deps/`, which on the maintainer machine is a junction into the live profile.
- `scripts/verify-dsh-compat.sh <version>...` — disposable-Profile install/start/uninstall evidence against specific `@deepseek-ai/dsh` releases: fully isolated (`DSH_HOME` redirected to a temp tree, own port), boots the published harness version with the plugin added by name, probes `POST /wsl-workspace/api`, then removes the plugin and verifies the route disappears. Emits per-version verdict lines used for the `dsh.compatibility.dshReleases` manifest records.

## Preset materialization integration test

Boots the host plugin's `apply()` against a fake context with `DSH_HOME` pointed at a temp directory, then asserts the generated variant rows reference real built lib files and the composition carries the WSL execution-world realm:

```powershell
node tests/host-materialize.mjs
```

This covers variant generation, opaque source-directory mirroring (third-party assets travel with the variant), atomic publication (a failed regeneration preserves the previous complete variant), stale-variant cleanup, and legacy `wsl` preset removal. Its fake roster face is the **directory generation** (`list()` reporting a `path`, `read()` returning text), i.e. the channel every release up to `0.1.5-rc.2` uses.

## Preset declaration integration test

Boots the same `apply()` against the **declaration generation** of the roster face — `list()` reporting metadata without a directory, `readDocument()` returning a composition document, `register()` publishing a declaration — which is the channel `0.1.7-alpha.1` and later use, because that line stopped scanning `$DSH_HOME/.agent-presets/`:

```powershell
node tests/host-declare.mjs
```

This covers the capability switch, one declaration per healthy source (broken sources and existing `wsl-*` presets skipped), display name/description/order taken from the roster face rather than a `preset.yml`, the declaration's row list being an importable entry list (the world group, its isolating realm, the `!!js` disabled expression that must round-trip as an expression node, config values such as the relay and interpreter paths that must *not* become `file:` URLs), the world's own providers named as `file:` URLs pointing at real built files, that the retired root is neither written nor left holding stale leftovers, and that disposing the plugin retires every declaration it published.

Run both before a release: the two files are the two halves of the same generator, and a change to either channel must not silently break the other.

## Real-WSL smoke test

Requires a running WSL distribution (the first listed distro is used; infrastructure distros such as `docker-desktop` are skipped):

```powershell
node --experimental-strip-types tests/smoke.ts
```

This exercises the filesystem round-trip (resolve/write/read/edit/stat/version/listDir/contains/fileUrl), bash execution inside WSL (cwd translation, WSLENV pass-through, stdin, background jobs), Linux-workdir resolution through the session distro fact, `/mnt/<drive>` dual access, and the no-config default-distro fallback.

## Post-build lib verification

`scripts/verify-lib.mjs` parses every `lib/*.js` entry and fails the build when a bare call to a Node builtin export has no matching `node:*` import. This catches the class of bug where a symbol is used but never imported (for example `statSync` in 0.2.3, which made the Add-WSL-Workspace dialog report every path as non-existent at runtime):

```powershell
node scripts/verify-lib.mjs
```

The `build` script clears the committed `lib/` first and chains the gate after `tsdown`:

```powershell
pnpm build   # node scripts/clean-lib.mjs && tsdown && node scripts/verify-lib.mjs
```

The clean step is not optional: `tsdown` runs with `clean: false` and the node and
client configurations share `lib/` as their output directory, so without it every
code-split chunk an earlier build emitted stays in the tree (and, once a file is
renamed, ships in the tarball as dead weight).

## Nested skill-catalog regression (issue #10)

The WSL skill provider publishes `.dsh/skills` / `.agents/skills` from nested projects below a WSL workspace (and from the cwd's nearest `.git` ancestor). Regression-test it on the real 9P share:

1. Rebuild the repro tree inside the distribution (`scripts/repro-setup.sh` creates `~/repro-ws-root` with nested projects, pruned traps, and an over-budget deep skill):

   ```powershell
   cp scripts/repro-setup.sh //wsl.localhost/<distro>/tmp/
   wsl -d <distro> -- bash -c "bash /tmp/repro-setup.sh"
   ```

2. Drive the provider against the real `\\wsl.localhost` share — ten assertions, all `node:assert/strict`, non-zero exit on any failure (workspace-root cwd finds its own skill **and** the nested projects, the pruned trees stay absent, every entry carries a source and a rank, nested-project cwd finds its own project and **not** a sibling's, `get()` returns a non-empty body for the entry asked for, a non-WSL cwd returns nothing). This file previously *printed* four listings and exited 0 whatever they contained, while this document described those prints as assertions — measured, `grep -cE 'assert|throw|exit'` on the old 34 lines returned 0.

   ```powershell
   node scripts/repro-e2e.mjs
   ```

   The target defaults to `\\wsl.localhost\<distro>\home\<user>\repro-ws-root`; override the distro/user with `WSL_COMPAT_DISTRO` / `WSL_COMPAT_USER` and the tree location with `WSL_REPRO_ROOT` (no path editing needed).
   Two Git Bash traps, both hit on the maintainer machine while re-establishing this run: a bare
   `wsl.exe -d <distro> -- bash /tmp/repro-setup.sh` has its `/tmp/…` argument rewritten to the
   Windows temp directory (run it through `bash -c "…"` instead, as above), and
   `WSL_REPRO_ROOT=/home/…` is rewritten the same way by MSYS, so prefix the run with
   `MSYS_NO_PATHCONV=1`. The second one is silent and total: the UNC becomes
   `…\C:\Users\…\.qoder-cn\bin\git\home\…`, the listing comes back empty, and — before this
   change — the script still exited 0.
3. In the running harness, open a session on the repro workspace and ask the agent to load the nested skills (`brainstorming`, `systematic-debugging`, `writing-plans`) through its skill tool — each must load with the `wsl-workspace` provider attribution, and no duplicate entries may appear. In a non-WSL workspace session the same skills must be "unknown".
4. Clean-install check (simulates another user): `npm pack`, `npm install <tarball>` in an empty temp project (peers must resolve), then `dsh plugin --profile web add <extracted tarball dir>`, restart `dsh web`, and repeat the end-to-end checks below plus the nested-skill probe above.

## End-to-end verification in the running harness

After installing the plugin into a profile and restarting `dsh web`:

1. The **W** button appears beside Settings at the sidebar foot.
2. Open "Add WSL workspace…" and check the **distribution picker really lists the
   distributions of this machine**. An empty picker, or one stuck on "Loading…", is a
   failure: the frontend swallows a rejected `listDistros` and renders the dialog anyway
   (that is exactly how issues #35/#36 looked — the dialog opened, the picker was empty,
   and `wsl.exe -l -q` worked fine in a terminal). Browse to a directory (e.g. `/home`)
   and click "Create & open" — the workspace must be created without a "path does not
   exist" error.
3. In the new session, the mode picker shows the WSL variant (e.g. `WSL · Standard mode（标准模式）`); the bash tool runs inside the distribution (`pwd` returns a Linux path, `uname -s` returns `Linux`).
4. `read`/`write`/`edit` operate on WSL files; Windows files stay reachable under `/mnt/<drive>`.
5. Switch modes (Standard / PTC / Minimal / Creative) — each lands on its WSL variant and the tool catalog matches the mode.
6. The plugin API responds correctly: `POST /wsl-workspace/api` with `{"method":"check","params":{"distro":"<distro>","path":"/home"}}` returns `{"ok":true,"value":{"exists":true,"isDirectory":true}}`.
7. **Open the WSL workspace from the frontend** — the workspace must be visible in the
   sidebar, clicking it must enter a session, and a **page reload (F5) must still open
   it**. `POST /wsl-workspace/api` with `{"method":"listWorkspaces","params":{}}` must
   report the `\\wsl.localhost\<distro>\…` path, and neither the console nor `web.err` may
   contain a `wsl-workspace:` error. This is the only check that covers the client half
   end to end; a script-level harness cannot see it.

### The compatibility pass on every declared release

Whenever compatibility testing is requested, each release under test must cover **all six
items**, not just the harness checks: (1) the dialog lists the distributions and
"Create & open" produces a session, (2) a file-tool write, (3) a file-tool read,
(4) `bash` one-shot *and* its persistence across two separate calls (record which of the
two it is — `0.1.0-rc.7` has no Windows process inspector and keeps a one-shot shell),
(5) `skills` loading a fixture skill and reporting its token, and (6) the frontend
open/reload check in step 7 above. Re-read the written file independently on the Linux
side (`wsl.exe … cat`), and keep `web.err` at 0 bytes. The version *count* is conditional
(spread it out before a release or when asked); the six items are not.

Because issue #35/#36 only reproduce under the Desktop host, a release that touches the
`wsl.exe` call path should also be exercised with the wrapper simulated: load
`.test-runs/child-process-hide.mjs` (plain `exec`/`execFile` wrappers plus
`syncBuiltinESMExports()`, the same shape as the Desktop hook) into a real `dsh web` via
`NODE_OPTIONS="--import file:///…/child-process-hide.mjs"`, and compare the published
release against the fixed build through `POST /wsl-workspace/api`.

### The persistent shell on DSH Desktop (issue #40)

A release that touches the relay's interpreter — or anything else the PTY backend is told
to run — must be checked on the Desktop side too, because that is the only host where
`process.execPath` is not a node. DSH Desktop's host process is the packaged Electron
executable in node mode, and an Electron binary spawned under a ConPTY writes **no bytes at
all**, so the relay exits 0 with nothing on the stream and every `bash` call reports
`PTY shell exited during startup` while the file tools keep working.

Two levels, in order of cost:

1. **Simulation, on the real binaries** (no Desktop install needed beyond the extracted
   installer):

   ```powershell
   # 1. Download the official installer and extract it (7-Zip handles the NSIS payload):
   #    https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe  ->  <dir>/
   # 2. Point the simulation at it and run:
   $env:DSH_DESKTOP_DIR = 'D:\path\to\extracted'
   node .test-runs/desktop-pty-sim.mjs
   ```

   It runs `resolveRelayNode()` *inside* the extracted `DeepSeek Harness.exe` (node mode,
   the Desktop's own argv and environment) and asserts it picks
   `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` rather than the
   Electron executable — from the argv payload and, without it, from the
   executable-relative lookup — then runs the real `lib/wsl-relay.js` under a real ConPTY
   on both interpreters and asserts the Electron one gives 0 bytes and an exit while the
   resolved one gives a live bash prompt. The extracted installer is ~1 GB; nothing is
   installed and nothing is launched beyond that binary in node mode.

2. **End to end inside the real Desktop.** This needs no installation: the unpacked installer
   from step 1 *is* a runnable Electron application. Run it against a scratch `DSH_HOME` and
   with remote debugging on, install the build through the Desktop's own plugin panel, and
   drive the window over CDP:

   ```powershell
   $env:DSH_HOME = 'D:\scratch\dsh-desktop-home'   # never the real profile
   # copy settings.yaml / .credentials.yaml in, so the first-run welcome is skipped
   Start-Process '<dir>\DeepSeek Harness.exe' -ArgumentList `
     '--remote-debugging-port=9333','--remote-allow-origins=*','--user-data-dir=D:\scratch\ud'

   node .test-runs/desktop-cdp.mjs 9333 text                      # read the window
   node .test-runs/desktop-cdp.mjs 9333 eval .test-runs/<probe>.mjs
   node .test-runs/desktop-cdp.mjs 9333 reload                    # the F5 check
   ```

   In the window: 插件 → 添加插件 → a local directory path (the unpacked tarball) → 安装 →
   the switch on the installed card. Then run the six-item pass above. `bash` must reach a
   prompt; `pwd` in a second, separate call must still be where the first one left the shell
   (`cd /tmp` → `/tmp`), which is the persistence the Desktop lost in #40; and
   `bash_background` + `job_list` must produce a job id and a `running`/`completed` status
   (that path failed separately — see below). The boot log must contain
   `dsh-wsl-workspace: persistent shell: relay interpreter is …`, naming the interpreter it
   chose. When no candidate answers as a real node the line instead reads
   `persistent shell: not mounted, …` and lists every candidate it rejected and why — since
   issue #51 that is a **demotion, not a warning**: the Electron executable is what such a
   host falls back to, #40 measured that a PTY child started from it writes nothing, so the
   world ships without the PTY rows and keeps the one-shot `bash` (no shell state across
   calls, but every call works). Close the window and stop the process when done.

   **A local directory is added as a link, so where you point it decides whether the plugin can
   load at all.** `dsh plugin add <dir>` writes a `link:` dependency, and Node resolves bare
   specifiers by walking up from the *realpath* — the directory you named, not the profile. So an
   unpacked clone sitting in a bare temp folder resolves neither this package's own dependency nor
   any host package, and the plugin fails at module load, which looks worse than the defect it is
   meant to test. Either point at a directory inside a tree that already carries those packages
   (that is why `scripts/verify-dsh-compat.sh` stages the plugin under the case's `node_modules`
   before adding it, and why the item-4 clean-install check installs the tarball into a temp
   project first), or hand the profile a tarball/by-name entry so pnpm lays the package out
   itself. `#47`'s reporter hit exactly this while testing PR #48 — his own repro is the reason
   this paragraph exists.

   `bash_background` deserves its own line here because the Desktop run is what caught it:
   the jobs registry resolves a job's `owner` with `ctx.agents.get(owner)`, so the owner must
   be the session **id** (`agent.id`, as the host's own producers pass). Passing the agent
   object — which `tests/wsl-jobs.test.ts` used to assert — fails at runtime with
   `session "[object Object]" has no live agent`, and no unit test with a fake registry can
   see that. The real run is the gate.

## Release checklist

1. `pnpm build` — clears `lib/`, rebuilds it, and runs the verification gate.
2. `node --experimental-strip-types --test tests/*.test.ts` — all green (locales, variants, paths, shell, fs execution context, fs policy, wsl skills, wsl search).
3. `node tests/host-materialize.mjs` — all assertions pass (the directory channel).
4. `node tests/host-declare.mjs` — all assertions pass (the declaration channel).
   - `node ci/install-pinned.mjs && npm run test:profile` — every arm green (issue #47: profile-shaped trees laid out by Node's own resolution, the hostile `js-yaml` major from `ci/deps-conflict`, one unreadable source among healthy ones). This is the CI step placed after `verify:install`, so a red there silences no other gate; its premise lines P1–P7 must stay green, because a red on one of those is the fixture, never the product.
5. `node --experimental-strip-types tests/smoke.ts` — real-WSL round-trip passes.
6. `node scripts/check-rank-parity.mjs` — host rank constants still match our copies.
7. `node scripts/repro-e2e.mjs` (after `scripts/repro-setup.sh`) — nested skill-catalog assertions pass.
8. `npm pack --dry-run` — confirm the tarball carries only live `lib/` chunks, `cordis.patch.yml`, the READMEs, `TESTING.md`, both CHANGELOGs, `LICENSE`, and `NOTICE`. It does **not** carry `src/` or the screenshots: measured 2026-10-09 with `npm pack --ignore-scripts` over a pristine `git archive` export, `files` including them yields 79 members / 2,757,545 B and excluding them 47 members / 492,454 B, and the only difference between the two member lists is those 32 entries. The nine READMEs' screenshots are absolute `raw.githubusercontent.com/…` URLs so the npm page renders without the bytes; `lib/` is what the host loads, and nothing that reads `src/**` reads it from an installed copy.
9. `npm run verify:install` — packs the tree and installs the tarball with **plain npm** into a scratch directory, with no pnpm and no host packages present. This is the gate that would have caught 0.7.0, whose `peerDependencies` made npm auto-install an unpublished package (`E404 @deepseek-ai/dsh-retention`): every other check and every real session goes through `dsh plugin add` (pnpm), which only *warns* about unmet peers and installs anyway. `prepublishOnly` runs it, so `npm publish` now refuses to ship a package that npm users cannot install.
10. Install the tarball into a clean profile (`dsh plugin --profile web add <tarball>`), restart `dsh web`, and run the end-to-end checks above plus the nested-skill probe. When the compatibility manifest changes, also run `scripts/verify-dsh-compat.sh` for every declared release.
11. For a release, install the *published* version by name into one isolated case per declared release and confirm each boots (the launcher only reports ready once the plugin's API route answers) — the check that proves the artifact on the registry, not just the local tree.
12. For a release, drive the **six-item frontend pass** on every declared release (see "The compatibility pass on every declared release" above), and — when the `wsl.exe` call path changed — the Desktop-wrapper comparison as well. When the persistent-shell path changed (the relay, its interpreter, or the PTY rows the variant generates), also run the Desktop PTY simulation above.
13. Confirm the artifact identity before publishing: the tarball from the release path, a fresh `npm pack`, and `npm pack --ignore-scripts` over the committed `lib/` must hash identically, and `npm run verify:install` must print `verify-install: OK`. This is now machine-run: `npm run verify:artifact` (ci.yml#lint-build) packs all three ways and compares them.

### The multi-release check harness

`scripts/compatibility/` prepares one isolated case per declared release (its own
`DSH_HOME`, its own dependency tree pinned to that release, the plugin installed
into it) and runs a fixed check list inside it. The drivers require PowerShell 7.2
and Windows-only features (junctions, `Get-NetTCPConnection`), so they are the
maintainer-machine deep tool. Drive a case with:

```powershell
scripts/compatibility/Prepare-Case.ps1 -Version 0.1.5-rc.2 ...   # build the case
scripts/compatibility/Start-Case.ps1 ... ; Run-Checks.ps1 ...    # boot + 15 checks
scripts/compatibility/Stop-Case.ps1 ; Check-Uninstall.ps1 ...    # stop + uninstall probe
```

For the lighter rolling-window pass (what GitHub Actions `compat.yml` runs
weekly), use the Git-Bash driver instead — no PowerShell needed:

```bash
npm run test:compat -- 0.2.0-rc.2 0.1.7-rc.2   # PLUGIN_REF=<tarball> to test an unpublished commit
```

Nine checks need a live WSL distribution (`skills-real`, `fs-real`, `relay-real`,
`relay-profile-real`, `tool-bash-real`,
`bash-session-real`, `bash-parity-real`, `search-real`, and `conpty-relay`); they build their own
fixtures under `/tmp/dsh-wsl-compat` (override with `WSL_COMPAT_ROOT`, and the distribution with
`WSL_COMPAT_DISTRO`) and remove them again. `bash-parity-real` writes its spill files under the
system temp directory and compares **two tools against each other**, so a difference that nobody
wrote down in [docs/bash-parity.md](docs/bash-parity.md) is a red build; the same table is read by
`tests/wsl-bash-parity.test.ts`, which needs the installed host package and says `NOT VERIFIED`
rather than skipping when it is absent.
Those same live gates run in CI on **two WSL kernels** — `ci.yml`'s `real-WSL hard gates` job is
matrixed over `wslVersion: [1, 2]` Ubuntu-24.04, and the log artifact carries which one it came from
(`wsl-gate-logs-wsl1` / `-wsl2`). They are not interchangeable: the WSL1 runner reports no sleep location
for any process, so a command waiting on the keyboard is left to the deadline the call asked for and the
body prints the rows the reading took, while on WSL2 the same wait is stopped in about 0.6 s and re-run.
Each cell says which of the two it asserted — `branch:"reading-acts"` or `"reading-declares"` — and both
spellings are in a passing frame's logs: frame 37506092966 (head `ff626e6`, 2026-10-06T17:59:13Z) reads
`reading-acts` with `canAct` true on the `src` and `lib` planes of the WSL2 arm, and `reading-declares` on
the WSL1 one.
`docs/CHECK-CATALOG.md` states which cells assert which of the two shapes.
**Which persistent shell is being tested matters**: the world now mounts the pipe-driven session by
default, so `host-materialize` and `host-declare` each run twice in `test:node` — once per tier — and
`persistent-shell-fallback` is pinned to the PTY tier because its subject is that tier's
`spawnTerminal` probe. The session tier's own boot-decision table (probe passes / `spawn` missing /
probe throws) is **not** covered offline yet; `bash-session-real` covers the protocol and the mount
shape on a real distribution, and the gap is recorded here rather than counted as covered.
`exec-shape` reproduces the DSH Desktop
`child_process` wrapper (plain `exec`/`execFile` wrappers + `syncBuiltinESMExports()`, which
strips `util.promisify.custom`) in a probe process and asserts both the wrapped and the plain
shapes produce a correct `{ stdout, stderr }`. `conpty-relay` takes the case's
`runtime.json` so it can load that release's own node-pty, resolves the relay's interpreter
the way the plugin does, and requires a live bash prompt through a real ConPTY — the
invariant issue #40 broke. `host-api` needs a running `dsh web` for the case, so it is
expected to fail in a sweep — point it at a live instance's `runtime.json` instead (an
absolute path; it is 12/12 there). The `typecheck` check exits non-zero because of the
pre-existing `tsc --noEmit` errors in this tree; the gate is that the count does not grow —
machine-enforced since the CI consolidation by `npm run typecheck:gate` against
`ci/typecheck-baseline.json` (`--record` to rebaseline after a reviewed change; the count
is environment-bound, record it from the environment the gate runs in).

**A budget is not coverage, and issue #51 is the proof.** The same baseline also carries
`banned: ["TS2515"]`: a line with a banned code reddens **at any count**. `src/shell.ts` has
been reporting "does not implement inherited abstract member execute" since the 0.2.x seam
landed, and it sat inside a budget that was met exactly (212 of 212) — so a provider missing
the very method its host calls passed CI. `node scripts/typecheck-gate.mjs --self-test`,
which `npm run test:node` now runs, proves that second rule bites without needing a broken
tree, and `--record` refuses while a banned violation stands.
