# DSH release compatibility evidence

The `dsh.compatibility.dshReleases` records in `package.json` are backed by the
reproducible procedure in `scripts/verify-dsh-compat.sh`. Re-run it before
changing any declaration:

scripts/verify-dsh-compat.sh 0.1.0-rc.7 0.1.0-rc.8 0.1.1-rc.1 0.1.1-rc.2 0.1.2-rc.1
## Method

For every declared release the script:

1. installs the published `@deepseek-ai/dsh@<version>` into an isolated temp
   prefix (never the live installation);
2. redirects `DSH_HOME` to a fresh temp tree and picks an unused port, so the
   live profile and the running harness are untouched;
3. runs `dsh plugin --profile web add dsh-wsl-workspace` (the normal user
   install path);
4. boots `dsh web --port <port>`, requires the web UI to serve, the plugin's
   `POST /wsl-workspace/api` to answer `200`, and the boot log to be free of
   plugin errors;
5. runs `dsh plugin --profile web remove dsh-wsl-workspace`, boots again, and
   requires the plugin route to be gone (clean uninstall).

A release is declared `compatible` only when install, start, and uninstall all
hold. Any failure would be declared `unknown` together with the failing step.

## Results (2026-09-03, plugin 0.4.1, Windows 11 + WSL2 Ubuntu)
| DSH release | install | start (route 200, no plugin errors) | uninstall (route gone) | verdict |
|---|---|---|---|---|
| 0.1.0-rc.7 | ✔ | ✔ | ✔ (route 405) | compatible |
| 0.1.0-rc.8 | ✔ | ✔ | ✔ (route gone) | compatible |
| 0.1.1-rc.1 | ✔ | ✔ | ✔ | compatible |
| 0.1.1-rc.2 | ✔ | ✔ | ✔ | compatible |
| 0.1.2-rc.1 | ✔ | ✔ | ✔ | compatible |
All five boots produced logs without a single `dsh-wsl-workspace` error line;
the verification transcript (per-version `boot-with-plugin.log`,
`boot-without-plugin.log`, `plugin-add.log`, `plugin-remove.log`) is retained
in the runner's temp directory by the script and printed as a summary table of
`<version> PASS compatible` lines at the end.

## Follow-up verification (2026-09-10, plugin 0.4.2)

`0.1.3-alpha.1` is gone from the declaration: npm publishes no
`@deepseek-ai/dsh@0.1.3-alpha.1` (`npm view` answers 404), so that entry could
never be verified by the procedure above. The published `0.1.3-alpha.2` takes its
place; every other declared release is unchanged.

Each declared release was re-verified on the isolated-case harness
(`scripts/compatibility/`), which pins every `dsh-*` dependency of the target
release and installs the plugin with its peers resolved from that same runtime:

```powershell
& ./scripts/compatibility/Prepare-Case.ps1 -Version '<release>' -RunId '<id>' -Port <port>
& ./scripts/compatibility/Start-Case.ps1 -Manifest '<case>/runtime.json'
& ./scripts/compatibility/Run-Checks.ps1  -Manifest '<case>/runtime.json'
```

| DSH release | boot | `POST /wsl-workspace/api` | checks exit 0 | Create & open: workspace `sessionIds` | session variant |
|---|---|---|---|---|---|
| 0.1.0-rc.7 | ok | `listDistros` | 9/10 | non-empty | `wsl-standard` |
| 0.1.0-rc.8 | ok | `listDistros` | 9/10 | not exercised | - |
| 0.1.1-rc.1 | ok | `listDistros` | 9/10 | not exercised | - |
| 0.1.1-rc.2 | ok | `listDistros` | 9/10 | non-empty | `wsl-standard` |
| 0.1.2-rc.1 | ok | `listDistros` | 9/10 | non-empty | `wsl-standard` |
| 0.1.3-alpha.2 | ok | `listDistros` | 9/10 | non-empty | `wsl-standard` |

`typecheck` is the tenth check and the only non-zero one; it sits at its
pre-existing baseline (module resolution for peers that exist only inside a DSH
install, plus the older `src/fs.ts` / `src/host/wsl-skills.ts:294,366` /
`tests/*` findings, none of them on a line this plugin's changes touch).

Create & open is asserted server-side rather than from the dialog: the workspace
record must carry the new session id, and the session log must contain
`agent-preset/selected` with `wsl-standard`. On the base commit `0.1.2-rc.1` left
`sessionIds` empty here - the workspace was created, no session was opened, and
the dialog reported success, because the plugin had cached its `uiWorkspace`
lookup at apply time, before that service existed.

### Model turn on 0.1.2-rc.1 (real API, final build)

One turn in a WSL workspace holding `offbyone-skill` (UTF-8 BOM, body on the line
immediately after the closing `---`) and a no-BOM control:

- `skill {name: "offbyone-skill"}` delivered
  `<skill_instructions>\nOFFBYONE-MARKER-Z9Q7\nsecond line\n</skill_instructions>`
  - the body's first character is intact and the BOM is stripped;
- `bash uname -sr; pwd` answered `Linux 6.18.33.2-microsoft-standard-WSL2` and
  `/home/mille/fu-rc1`;
- `write` + `read` round-tripped `notes/probe.txt` as `WSL-WRITE-OK`, and an
  independent `stat` from inside the distribution reported `644 mille`.

### The published artifact (2026-09-10, plugin 0.4.2)

Every check above installs the plugin from the working tree. The artifact users
actually receive was verified on its own: `npm pack` was extracted into a fresh
case whose plugin payload is exactly the tarball's `files` set (`lib`, `src`,
`cordis.patch.yml`, `package.json`, READMEs, LICENSE, NOTICE, images - no
`tests/`, no `scripts/`), keeping only the harness's junctioned `node_modules`.

| step | result |
|---|---|
| all three fixes present in the packed `lib` | BOM strip, lazy session starter, fail-loud message |
| `dsh plugin --profile web add <tarball payload>` | ok |
| check suite on that payload | 9/10 (`skills-real`, `host-api` exit 0; `typecheck` at baseline) |
| browser Create & open on `0.1.2-rc.1` | workspace `sessionIds` non-empty, session `wsl-standard` |
| uninstall (`dsh plugin remove`, boot again) | ok, route gone (405) |

### Model turn on the legacy line (0.1.1-rc.2, final build)

The same prompt on the legacy service shape (`connection.api.agentPresets` +
`workspaces.startSession`) returned the same results: the `skill` tool delivered
`<skill_instructions>\nOFFBYONE-MARKER-Z9Q7\nsecond line\n</skill_instructions>`,
`bash uname -sr; pwd` answered `Linux 6.18.33.2-microsoft-standard-WSL2` and
`/home/mille/fu-legacy`, and `write` + `read` round-tripped `WSL-WRITE-OK` with
an in-distribution `stat` of `644 mille`.

## Persona-format change and the dialog help panel (2026-09-11, plugin 0.4.3)

### The defect (issue #22)

`dsh-persona` moved its model-facing scalar in `0.1.3-alpha.2`: `text` became an
inline `suffix` plus a folded `prefix`. `appendablePersona()` matched `text: >-`
only, so from that release on the variant generator appended nothing and the
model was never told its working directory was a Linux path - silently, with the
WSL execution world itself unaffected (`bash`, the file tools and the skills all
kept working, which is why no earlier check noticed).

The generated preset proves it, and needs no boot: an isolated case keeps
`.agent-presets/<variant>/agent.cordis.yml`.

| DSH release | generated persona shape | WSL sentence before 0.4.3 | after 0.4.3 |
|---|---|---|---|
| 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2, 0.1.2-rc.1 | `text: >-` | present | present, byte-identical to the previous build |
| 0.1.3-alpha.2 | `suffix:` + `prefix: >-` | **missing** | present |
| 0.1.5-rc.1, 0.1.5-rc.2 | `suffix:` + `prefix: >-` | **missing** | present |

End-to-end on `0.1.5-rc.2`: the session log carries a `system/message` event
whose text includes `is inside a WSL (Windows Subsystem for Linux) distribution:
the bash tool and the file read/write/edit tools use Linux paths`.

### Full matrix with the final build

| DSH release | boot | `POST /wsl-workspace/api` | checks exit 0 | generated persona |
|---|---|---|---|---|
| 0.1.0-rc.7 | ok | `listDistros` | 9/10 | amended |
| 0.1.0-rc.8 | ok | `listDistros` | 9/10 | amended |
| 0.1.1-rc.1 | ok | `listDistros` | 9/10 | amended |
| 0.1.1-rc.2 | ok | `listDistros` | 9/10 | amended |
| 0.1.2-rc.1 | ok | `listDistros` | 9/10 | amended |
| 0.1.3-alpha.2 | ok | `listDistros` | 9/10 | amended |
| 0.1.5-rc.1 | ok | `listDistros` | 9/10 | amended |
| 0.1.5-rc.2 | ok | `listDistros` | 9/10 | amended |

`typecheck` is again the only non-zero check, at its pre-existing baseline.
Only `typecheck` failed anywhere: no `unit`, `lib`, `materialize`, `rank`,
`smoke-*`, `shell-extra`, `skills-real` or `host-api` regression on any release.

### The two gates that let it through

- `tests/host-materialize.mjs` drove only the legacy `text` shape, so the
  matcher looked correct. It now also drives a source preset in the new shape
  and one that opts out with `complete: true`, and asserts the sentence lands in
  the `suffix` rather than the `prefix`.
- `verify-lib`'s comment/string stripper could pair a lone apostrophe inside a
  comment with a later one and swallow the rest of the bundle; every `node:*`
  import then looked tree-shaken. Its quote rules now stop at a newline, as a
  JavaScript string does, so an innocent comment edit can no longer fail it.

### Dialog help panel

The W dialog gained a "?" button: the panel shows the plugin version and the
declared release matrix, read from the package's own `package.json` through the
host `describe` method (so the list cannot drift from the manifest), plus how the
plugin is used, what it does, and the limitations it cannot fix. Verified in the
browser on both client API lines - `0.1.5-rc.2` (current) and `0.1.1-rc.2`
(legacy): the panel opens and closes in place, renders the version line, the
release chips and three sections, and fits the card without overflow.

### The skill catalog over a UNC workspace

A session registered at `\\wsl.localhost\...` received **no** skill catalog: the
host's `dsh-skill-filesystem` starts a `chokidar` watcher on the workspace, that
watcher fails on the 9P share, the observation is reported with
`complete: false`, and `dsh-tool-skill` withholds the whole catalog line while a
snapshot is incomplete (`if (!snapshot.complete) return decision`). Since the
plugin controls the generated preset YAML, the fix needs no upstream change: the
materializer pins `watch: false` on the `skill-filesystem` row.

Evidence (2026-09-11, real model turns, browser, one case per client-API line):

| Probe | Before | After |
|---|---|---|
| generated `wsl-standard` row | `- id: skill-filesystem` (no config) | same row + `config:` / `watch: false` |
| generated `wsl-cordis` row | `config:` already held `customSkillDirs` | `watch: false` merged as the first child, `customSkillDirs` intact |
| model context, `0.1.5-rc.2` (current line) | no catalog | catalog injects the fixture skills |
| model answer, `0.1.5-rc.2` | no skills visible | names all three fixture skills |
| model answer, `0.1.1-rc.2` (legacy line) | *"There's no skill catalog shown in this context… I don't see an available skills list"* (the model's own reasoning, screenshot in the session at 19:06) | same case, workspace re-registered at 19:32: the prompt names the injection (`上下文注入 skill-catalog`) and the model answers *"共有 3 个 skill：browser4agent、offbyone-skill、tight-nobom"* |

The legacy-line session created after the fix was then driven through the whole
feature surface again (`0.1.1-rc.2`, `mtx3-cat`): `write` →
`/home/mille/mtx3-cat/notes/probe2.txt`, `read` back `WSL-WRITE-OK-112`, bash
`uname -sr` → `Linux 6.18.33.2-microsoft-standard-WSL2`, `pwd` →
`/home/mille/mtx3-cat`, `stat -c '%a %U %n'` → `644 mille notes/probe2.txt`, and
`skill offbyone-skill` delivered `<skill_instructions>\nOFFBYONE-MARKER-Z9Q7\n…`
with the body's first character intact.

`watch: false` is also the documented shape in the host schema
(`watch: z.boolean().default(true)`), and it is accepted on all eight declared
releases. A source preset that sets `watch` itself is left untouched. Regressions
are locked by three unit tests plus a `skill-filesystem` row in both
`tests/host-materialize.mjs` fixtures (with and without a pre-existing `config:`
block).

Why `watch: false` is the right key, read off the host source rather than guessed:

- `list()` flips `complete` to `false` **only** when `watchManager.observeRoots()`
  throws; every other path returns a plain candidate array.
- `observeRoots()` → `retainRoot()` calls `ensureWatcher()` only
  `if (this.config.enabled)`, and `resolveWatchConfig` computes
  `enabled: config.watch ?? true`.
- So with `watch: false` no watcher is ever opened, nothing throws, `complete`
  stays `true` and the catalog is injected. The `unhealthy` flag that starts as
  `true` is only ever consulted by watcher management, never by completeness.

The provider bundle is byte-identical on every declared release —
`@deepseek-ai/dsh-skill-filesystem/lib/index.js`, sha256 `1AEA87781BA5B4D4…`,
29591 bytes, the same in all eight case runtimes — so the behaviour above holds
wherever the plugin is installed, not just on `0.1.5-rc.2`.

Every declared release was then re-gated with this build: each case was
restarted (which regenerates its presets), the ten checks were re-run, and the
generated variants inspected. `typecheck` is the only non-zero check on all
eight (its pre-existing baseline); every case's `wsl-standard`, `wsl-cordis`
(and the `0.1.0` line's `wsl-code`, the `0.1.5` line's `wsl-ptc`) row carries
`watch: false`, and no variant is left with the watcher enabled.

### Final-build browser pass (2026-09-11)

The multi-release browser matrix above was captured before the skill-watch fix,
and the two real-model catalog proofs above ran on an intermediate build, so the
shipped tree was put through the browser once more. Each target was verified to
run a `lib/client.js` byte-identical to the extracted tarball
(`sha256 D99E6B11DB304F2C…`), so this pass covers exactly the bytes that would be
published:

| Target | Build | Dialog + help panel | Create & open | Real model turn |
|---|---|---|---|---|
| `0.1.5-rc.2` (current line) | **the packed `npm pack` tarball installed as the plugin payload** | 3 sections, 8 release chips, 4 known-issue bullets (incl. the 0.4.3 fix note), panel scrolls inside the card | workspace `mtx6-pub`, draft chip `WSL · Standard mode（标准模式）` | catalog names (`browser4agent`, `offbyone-skill`, `tight-nobom`); `write`→`read` `PUB-ARTIFACT-OK`; `Linux 6.18.33.2-microsoft-standard-WSL2`, `/home/mille/mtx6-pub`, `644 mille notes/pub.txt`; skill body `OFFBYONE-MARKER-Z9Q7` |
| `0.1.0-rc.7` (oldest declared) | final source build | same panel, same 8 chips / 4 bullets | workspace `mtx5-rc7`, WSL draft chip correct | catalog injection chip + the same three names; `RC7-OK`; `644 mille notes/rc7.txt`; skill body intact |
| `0.1.1-rc.2` (legacy client line) | final source build | same panel, same 8 chips / 4 bullets | workspace `mtx5-rc112`, WSL draft chip correct | visible `skill-catalog` injection + the same three names; `LEGACY-OK`; `644 mille notes/legacy.txt`; skill body intact |

Scope of this pass, stated exactly: the three targets above were driven through
the browser on the final build; the remaining five declared releases were
re-gated (ten checks, generated-preset inspection) on the same build without a
browser pass. Between that browser pass and the published bytes the only
difference is the help panel's known-issue wording, which the `0.1.5-rc.2` target
(the packed artifact) exercises directly.


## Copied-variant world duplication (2026-09-19, plugin 0.4.4)

### The defect
The variant generator recognises its own output by id prefix (`isWslVariantId`), and
`transformPresetForWsl` appended its world group unconditionally. A user preset that
began as a copy of a generated variant (`wsl-standard` renamed to a custom "data
mode", carrying the old world group with whatever install path it was copied from)
was therefore processed as a plain source preset and received a **second**
`wsl-world` row. DSH refuses such a composition, so the mode could not be entered
at all.

Reproduced on `0.1.5-rc.2` with both builds, source preset = a copy of the generated
`wsl-standard`:

| build | generated rows | runtime |
|---|---|---|
| 0.4.3 (`main`) | `wsl-world` x2 | picker: `duplicate loader entry id: wsl-world` |
| #24 (`6e8558a`) | `wsl-world` x2 | picker: `duplicate loader entry id: wsl-world` |
| 0.4.4 (this fix) | `wsl-world` x1, this install's paths | mode selected; session mounted; real model answered and `pwd` = `/home/mille/fixworld-rc215` |

### The fix
The world group is now *replaced* rather than appended: the row is matched by the
provider ids it mounts (`shell-wsl` / `fs-wsl`), so a copy whose group was renamed is
still recognised, and a top-level row id repeated in a source is reduced to its first
occurrence (DSH rejects the whole preset on a duplicate id). `tool-str-replace-editor`
joined `WORLD_ROWS` like its `str-replace-editor` predecessor, and the variant's
display name is unquoted before it is re-emitted.

`tool-cordis` was deliberately **not** disabled: a `disabled` row never applies, which
removed `cordis_inspect_list` / `cordis_inspect_query` from the WSL variant of Creator
mode (0.4.3 answers with host `Service`/`Event`/`Builtin`/`Tool` plus five client
providers; the 0.4.4 build answers identically).

### Gates run
- Transform invariants over every shipped preset of the 17 installed runtimes, both
  builds: **136 transforms, 0 failures**, and **68/68** simulated copied-variant
  sources resolving to a single fresh world group with no stale install path.
- Ten-check harness on all eight declared releases (`0.1.0-rc.7` … `0.1.5-rc.2`):
  8/10 each — only the documented `typecheck` baseline and `host-api` (which requires
  a live server) fail, matching the 0.4.3 baseline.
- Browser + real model (`DeepSeek-V41-Flash`, `0.1.5-rc.2`): the copied-variant mode
  switches, mounts and answers (`pwd` = `/home/mille/fixworld-rc215`); Creator mode
  still exposes `cordis_inspect_list`.
- Browser + real model (`DeepSeek-V4-Flash`, `0.1.0-rc.7`, oldest declared): dialog →
  `WSL · Standard mode`, skill-catalog injection with 3 names, `write`→`read`
  `FIXWORLD-RC7-OK`, `644 mille`, `6.18.33.2-microsoft-standard-WSL2`.
## Per-mode matrix and help-panel pass (2026-09-19, plugin 0.4.4)

Every WSL variant was driven on four releases with a real model, asking for the
three capabilities that matter in a WSL workspace: a file written with the file
tool, a bash command executed inside the distribution whose output is redirected
into the workspace, and the file read back.

| release | modes | evidence left in `/home/mille/<ws>/notes/` | loader errors |
|---|---|---|---|
| `0.1.0-rc.7` (oldest declared) | Standard, PTC, Minimal, Creator | `MODE-<mode>-OK` plus `uname -r` = `6.18.33.2-microsoft-standard-WSL2`, `pwd` = the Linux workspace, `whoami` = `mille` | 0 |
| `0.1.1-rc.2` (legacy client line) | same four | same | 0 |
| `0.1.3-alpha.2` (persona split) | same four | same | 0 |
| `0.1.5-rc.2` (current line) | same four | same | 0 |
| `0.1.2-rc.1`, `0.1.5-rc.1` | same four | mode selected and a real turn answered (no file/bash assertions) | 0 |

In every mode the follow-up bash call lands back in the workspace, i.e. the shell
is per call: the source PTY group stays dropped, because it double-registers
`bash` and its win32 backend cannot spawn a terminal.

Help panel, verified in the browser on `0.1.5-rc.2`: the greeting line and the
repository link render first, a "What's new" section carries this release, and the
known-issue list is down to the two limitations that still hold — the historical
"fixed in 0.4.3" note, the per-generation API paragraph and the "only
plugin-registered workspaces default to a WSL variant" note are gone.

Both remaining limitations were re-checked and kept on purpose, and neither is a
dead end:

- **Linux symlinks are not resolvable over the share.** The discovery walk is this
  plugin's own provider, and its symlink branch (`src/host/wsl-skills.ts`:
  `entry.isSymbolicLink()` → `io.stat(joinUnc(...))`) already tries to follow a
  linked directory; it gives up only because 9P answers `EISDIR`/`ENOENT` for
  those entries. A `wsl.exe -d <distro> -- readlink -f <linux path>` fallback on
  that branch — the plugin already owns the UNC↔Linux helpers and the WSL
  execution channel — resolves the target and lets the walk continue. That is a
  new feature (loop/depth accounting, real-path dedupe, one WSL round-trip per
  candidate link, cross-release re-testing), not a one-line fix; the file tools
  would need the same fallback inside `WslFileSystem`'s resolution, which is a
  larger change. **Done for the scan in 0.4.5** (see the next section); the file
  tools are still open, and the panel now says exactly that.
- **No live catalog refresh** for UNC workspaces: the deliberate trade-off behind
  the catalog fix, as the panel says.

## Skill-scan symlink fallback (2026-09-19, plugin 0.4.5)

### The defect

A project linked into a workspace with `ln -s` was invisible to the skill
catalog — not a crash, a silent skip. Reproduced on the real share before the
fix (`node .test-runs/symlink/probe.mjs`, workspace `/home/mille/symprobe/ws`):

```text
linked-project   dir=false link=true stat: THROWS ENOENT
chain-a          dir=false link=true stat: THROWS ENOENT
notes-link       dir=false link=true stat: THROWS ENOENT
broken           dir=false link=true stat: THROWS ENOENT
```

`readdir` reports the entry as a symlink (`S_IFLNK`), and every Windows-side
`stat` on it fails, so the walk's follow branch never fires. The distribution
resolves the same paths trivially: `wsl.exe -d Ubuntu -- readlink -f /home/mille/symprobe/ws/chain-b`
→ `/home/mille/symprobe/deep/target`.

### The fix

`WslSkillIo` gained an optional `resolveLinks(uncPaths)` face; the production
face (`nodeSkillIo`) asks the distribution, and `discoverSkillRoots` collects the
symlink entries the share could not follow in each BFS layer, resolves them, and
pushes the **real** path into the frontier. Consequences that were checked, not
assumed:

- the walk continues where this share can actually read, so `readdir`/`stat`/
  `get()` all work again below a link;
- a project reachable both directly and through a link collapses onto one visit
  (the resolved path is the visited key, and the `(name, body)` fingerprint
  dedupe still backs it up);
- a link pointing back at the workspace root is absorbed by the visited set;
- a link to a file, and a link the distribution cannot resolve (dangling,
  missing intermediate component) are skipped exactly as before;
- a substrate that follows links itself never triggers a distribution call, and
  neither does a workspace without links (asserted, not observed).

Bounds: at most 32 links per lookup, four `wsl.exe` calls in flight, 10 s per
call, and the pre-existing depth / visited-directory / skill-directory budgets
are unchanged. One process per link is deliberate — see below.

### Why not one batched call

Measured against this WSL build (`wsl.exe` 2.7.10.0, Ubuntu):

| shape | result |
|---|---|
| `sh -c 'echo ARGC:$# ARG1:$1' sh a b c` | `ARGC:0 ARG1:` — arguments after the command are dropped |
| `sh -c 'for p in "$@"; do readlink -f "$p"; done' sh /path` | loop never sees the path (same cause) |
| any `sh -c` script containing a `"` | truncated at that quote by `wsl.exe`'s parser, silently |
| `readlink -f good missing/component good` | prints the first line and exits 1 — the rest of the batch is lost |
| `readlink -f '/path with spaces' "/path/with'quote"` | correct: a process argument carries any path |
| 6 links, one call each, concurrency 1 | 656 ms |
| 6 links, one call each, concurrency 4 | 208 ms |
| 6 links in one batched `sh` call (quote-free script) | 111 ms |

The batched form is faster but needs shell quoting that survives a parser which
truncates on double quotes; a quote character in a directory name would either
break the batch or need escaping that the same parser rewrites. One short call
per link keeps the path a *process argument* — no quoting anywhere — and costs
about 35 ms warm. On the full fixture: 6 links resolved in 179 ms inside a
`list()`, and a link-free workspace scans in 12–20 ms without starting a
distribution process at all.

### Gates

- **Real 9P** (`scripts/compatibility/skills-real.mjs`, part of the ten-check
  harness): builds a workspace whose only path in is a symlink to a second
  fixture **outside** the scan root, plus a nested project below the link target,
  a file link, a dangling link and a loop back to the root. Asserts the linked
  project and its nested project are published, that `get()` reads their bodies
  through the real path, and — in the same run — that the identical walk with the
  `resolveLinks` face removed finds neither. Passes.
- **Live WSL fixture** (`/home/mille/symprobe/ws`, `node .test-runs/symlink/probe.mjs`):
  catalog `["plain-skill","root-skill"]` before the fix → `["deep-skill","linked-skill",
  "nested-skill","plain-skill","root-skill"]` after it; `linked-skill` is served at
  `\\wsl.localhost\Ubuntu\home\mille\symprobe\elsewhere\linked-project\.dsh\skills\linked-skill\SKILL.md`
  (outside the workspace, i.e. only reachable through the link) and every body
  reads back.
- **Unit** (`tests/wsl-skills.test.ts`): seven new cases — linked-in project
  through the distribution, nested walk + no double publish, file/dangling links
  ignored, ancestor loop bounded, no distribution call when the share resolves
  links, per-lookup link budget, and no call at all in a link-free workspace.
  26/26 in the file, and the harness's `unit` check passes on every release.
- **Ten-check harness on the eight declared releases** (`0.1.0-rc.7` … `0.1.5-rc.2`,
  run `symlink-01`): 8/10 each, the same two documented baseline failures
  (`typecheck` exit 2 and `host-api`, which needs a live server). `skills-real`
  passes on all eight — the first run of `0.1.1-rc.1` failed because a manual
  fixture cleanup deleted `/tmp/dsh-wsl-compat` while that check was running; it
  passed when re-run, and `0.1.1-rc.2` passed immediately afterwards in the same
  sweep.
- **Real model on `0.1.5-rc.2`** (browser, `WSL · Standard mode`, workspace
  `/home/mille/symprobe/ws`): the model was asked to run `uname -r; pwd; whoami`
  in bash and redirect the output into the linked project, to write a marker with
  the file tool into the linked project's real path, and to list the skills it
  can see. It reported the catalog as `browser4agent`, `deep-skill`,
  `linked-skill`, `nested-skill`, `plain-skill`, `root-skill` — i.e. the three
  skills that are only reachable through a symlink (one of them through a chain)
  are in the injected catalog, interleaved with the host's own skills. On disk:
  `elsewhere/linked-project/notes/agent.txt` = `SKILL-LINK-OK` (file tool, real
  path outside the workspace) and `notes/bash.txt` =
  `6.18.33.2-microsoft-standard-WSL2` / `/home/mille/symprobe/ws` / `mille`
  (bash inside the distribution, redirect landed). The same session read the
  file back through `ws/linked-project/...` as well.

### Observation outside this change (not fixed here)

The same session probed the access mode and found it is **not enforced for the
file tools in a WSL session**. With the session on `workspace-write`
("工作区内修改"), `write` to `/home/mille/symprobe/policy-probe.txt` (outside the
workspace, no symlink involved) and to `D:\ProgramData\dsh-policy-probe.txt`
succeeded, with no denial — the second came back as
`/mnt/d/ProgramData/dsh-policy-probe.txt` created, and `read` confirmed its
content.

This is independent of the symlink change (no code touched by 0.4.5 is in that
path), and the mechanism is visible in the composition rather than guessed:

```
$ dsh --profile web --dump-config | grep -E 'sandbox|permission'
- id: sandbox            name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy     name: '@deepseek-ai/dsh-sandbox-policy'
      mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
- id: fs-sandbox         name: '@deepseek-ai/dsh-fs-sandbox'
- id: permission         name: '@deepseek-ai/dsh-permission-presets'
```

The policy is host-plane and wraps the host `fs` service, while a WSL variant
mounts its own entry-local `fs` provider (`lib/fs.js`) inside the preset's
`isolate` realm and its `tool-fs` consumes that one, so the wrapper is not in the
call path. The variant shape is the same on every declared release (the transform
matrix asserts the injected world and its providers for all eight). The non-WSL
half of the statement — that those sessions keep the documented behaviour — rests
on that composition, not on a live probe: the attempt to start a control session
in a Windows workspace through the browser stalled on the workspace switcher.

Corrections that followed from the observation:

- `README.md` / `README.zh.md`, "File tools" behaviour note: no longer claims
  that `workspace-write` restricts writes in a WSL session; it states the measured
  behaviour, the mechanism, and that non-WSL sessions keep the documented one.
- Help panel known issues: a bullet says the access mode does not constrain a WSL
  session's file tools.
- `README.md` / `README.zh.md` also gained the missing **bash shell lifetime**
  note (one command per call, no persistent shell) — the limitation the per-mode
  matrix kept demonstrating while no document stated it. **Both of those
  limitations were then fixed**, and the 0.5.0 section below records that.

## WSL world parity (2026-09-19, plugin 0.5.0)

Four gaps between a WSL variant and the host closed in one release, each with the
mechanism it needed rather than a workaround:

| gap | mechanism |
|---|---|
| file tools could not read or write through a Linux symlink | `resolve`/`lstat` retry through the distribution (`wsl.exe … readlink -f`) whenever this share cannot describe the path, and continue at the real path |
| the access mode did not constrain a WSL session's file tools | `writeText`/`editText` fence exactly as `dsh-fs-sandbox` does: `ctx.sandboxPolicy`, `writableRoots` (plus the distro's `/tmp`), `FS_SANDBOX_DENIED`, `sandboxMode` |
| the skill catalog was frozen for the session | a per-scan-root change detector polls the published directory shape every 10 s and calls `control.invalidate()` |
| `bash` was one process per call | the world mounts the host's PTY registry + config-driven backend, pointed at this plugin's relay, which hands the PTY to `wsl.exe … bash` |

### What the browser pass caught that the unit checks could not

The generated preset looked right in every host-side check and failed three
different ways in a real session, which is why the session was driven at all:

1. `2 row(s) did not activate: terminal-wsl … waiting for terminals` — the world
   drops the source's `persistent-shell` group, and that group is what *provides*
   the `terminals` service. Fixed by mounting the world's own nested group
   (`isolate: terminals: true`) with the `pty` row.
2. `failed to apply loader entry persistent-bash … tool "bash" is already
   registered in this scope` — `@deepseek-ai/dsh-tool-bash-persistent` registers
   the tool name `bash`, not `persistent-bash`, so it can never sit beside the
   one-shot `dsh-tool-bash` row. Fixed by replacing that row (which is also what
   DSH's Minimal mode does, describing itself as a persistent-shell-only agent).
3. `GetNamedSecurityInfoW failed (Win32 1): \\wsl.localhost\…\ws` — the PTY
   backend confines through `ctx.sandbox` before spawning, and the host's Windows
   runner cannot read the ACL of a 9P path. Fixed by isolating the capability and
   providing the world's own no-op provider (`src/host/wsl-sandbox.ts`) that
   returns the caller's argv with `enforcement: 'partial'` — the policy stays
   where it is meaningful in this world (the file tools).

### Verification

- **Unit** — `tests/fs-policy.test.ts` (7 fence cases: inside/outside under
  `workspace-write`, `read-only`, `danger-full-access`, no policy service at all,
  edits, and the platform temp allowance), the three skill-refresh cases, and the
  three world-shape cases in `tests/variants.test.ts`. The harness's `unit` check
  runs them on every release.
- **Real 9P** — `scripts/compatibility/fs-real.mjs`: a link resolves to its real
  path, reads work through a link, a link chain and a directory link, a dangling
  link's target is created while the link survives, a write through a link
  reaches its target, the fence denies a link out of the workspace, and the
  distribution's `/tmp` is writable. `scripts/compatibility/relay-real.mjs`
  drives the relay itself: it starts in the session workspace, `export` and `cd`
  survive between sends, the distribution resolves from the UNC cwd and from
  `DSH_WSL_DISTRO`, `DSH_WSL_USER` is honored, and the shell exits cleanly.
- **Real session, `0.1.5-rc.2`, `WSL · Standard mode`, workspace
  `/home/mille/symprobe/ws`** (one session, four turns):
  - *persistent shell*: `export PERSIST_MARK=ok42; cd /tmp; pwd` → `/tmp`, then a
    separate call `echo MARK=$PERSIST_MARK; pwd` → `MARK=ok42` and `/tmp`;
  - *policy fence*: `write` to `/home/mille/symprobe/outside-probe.txt` (outside
    the workspace) came back as `[sandbox: file access denied under
    workspace-write mode]` plus DSH's escalation hint, and `ls` confirmed no file
    was created — i.e. the tool layer renders the world's `FS_SANDBOX_DENIED`
    exactly as it renders the host backend's;
  - *catalog*: the injected list carried the four symlink-only skills, and after a
    skill was created from WSL mid-session the next turn's list had exactly one
    more entry (`fresh-probe`), which the model itself described as the catalog
    refreshing while the session runs.
- **Twelve-check harness, all eight declared releases** (`0.1.0-rc.7` …
  `0.1.5-rc.2`, runs `parity-01` and `parity-02`): `unit`, `lib`, `materialize`,
  `rank`, `smoke-source`, `smoke-built`, `shell-extra`, `skills-real`, `fs-real`
  and `relay-real` pass; the only failures are the documented `typecheck`
  baseline (2) and `host-api`, which needs a live server. In `parity-01` the
  first six cases ran a stale `materialize` expectation (the source's
  persistent-shell group versus the world's own), which was fixed in the same
  commit and re-run green on all six; `parity-02` ran the final code everywhere.

## Search tools and a live catalog (2026-09-20, plugin 0.7.0)

The two remaining known issues from the 0.5.0 panel, closed with the mechanism
each needed:

| limitation | mechanism |
|---|---|
| a WSL session had no `grep`/`glob` tool | the world mounts its own twin (`src/host/wsl-search.ts` → `lib/wsl-search.js`) that runs **inside the distribution** — GNU `grep -rnIEH -Z` and GNU `find` — and keeps the host suite's model-facing contract by calling `@deepseek-ai/dsh-tool-fs-search`'s own exported formatters; the `tool-fs-search` row is replaced, and only for modes whose source preset mounted it |
| the catalog could not see an *edit* to an existing skill | the cheap poll (3 s) now also stamps every skill file with its modification time and size, so a rewritten `SKILL.md` moves the registry's revision — the catalog message is rebuilt only when that revision moves; the full re-discovery walk moved to its own 30 s cadence (it used to be the only pass, at 10 s) |

### What only a real substrate caught

Every one of these passed the host-side suite at some point:

1. **GNU grep silently cancels `--include` when any file `--exclude` is present**
   (grep 3.12): `--include=alpha.*` alone kept one file, and adding
   `--exclude='.*'` made it keep everything — measured, then designed around:
   the hidden-*file* guard now rides `--include='[!.]*'` and only when the caller
   passed no filter of its own, while hidden *directories* and `node_modules` are
   pruned with `--exclude-dir`, which does not disturb `--include`.
2. **`grep -r` prints no file name for a single-file operand**, so the NUL framing
   yielded `5:Body…` with no path and the tool returned zero matches for
   `grep path=<file>` — caught by `search-real`, fixed with `-H`.
3. **`--exclude-dir='.*'` also excludes the search root** when its base name
   starts with a dot, so a search rooted at `.dsh`/`.git`/any dot-directory
   returned nothing; the flag is now skipped for a dot-rooted target.
4. **A row without a `config:` block hands the plugin an undefined config.** The
   first real 0.6.0 session failed to mount the entire world:
   `failed to apply loader entry search-wsl … Cannot read properties of
   undefined (reading 'grepMaxMatches')`. Fixed with in-code defaults (one
   `DEFAULTS` object that the schema also reads) plus a unit test that mounts
   with `undefined` and with `{}`.
5. **`lib/` was shipping stale code-split chunks.** Because `clean: false` and two
   tsdown configurations share `outDir`, entries from earlier builds survived and
   `verify-lib` began reporting tree-shaken imports in `shell.js`. And because
   the search suite was not a declared peer, the first build *inlined* it: a
   285 KB `lib/wsl-search.js` that bundled a second copy of DSH's tool stack.
   Fixed by declaring the three runtime peers (which is also what keeps them
   external) and clearing `lib/` before every build.

### Verification

- **Thirteen-check harness, all eight declared releases** (`0.1.0-rc.7` …
  `0.1.5-rc.2`, run `parity-04`): `unit`, `lib`, `materialize`, `rank`,
  `smoke-source`, `smoke-built`, `shell-extra`, `skills-real`, `fs-real`,
  `relay-real` and the new `search-real` pass on every release; the only failures
  are the documented `typecheck` baseline (2) and `host-api`, which needs a live
  server. `search-real` drives the real tools against a real distribution
  fixture: record framing (colons, spaces, unicode, newlines in paths), include
  filters and `{a,b}` expansion, a path-shaped include, caps and footers, the
  spill backend present and absent, search-card projection, every `SEARCH_*`
  error code, argv-safety (a backtick pattern never reaches a shell), glob
  ordering by modification time, hidden/`node_modules`/VCS pruning and the
  in-tree-symlink rule.
- **Real sessions on three releases** — `0.1.0-rc.7`, `0.1.2-rc.1` and
  `0.1.5-rc.2`, each `WSL · Standard mode` on `/home/mille/wsprobe/ws`. Per
  release, from the session log: the offered `grep`/`glob` carry *this* plugin's
  descriptions (`tools=25/26/27 WSL-specific=glob,grep`); `grep
  NEEDLE_SESSION_TOKEN` returned 3 matches in 2 files with POSIX display paths
  and `node_modules` skipped; `glob **/*.js` returned 3 files *including*
  `node_modules` (ripgrep's `--no-ignore --hidden` parity). Then an existing
  skill's description was rewritten and a new skill added from WSL; the next
  turn's log carries a **replacement** catalog (`"update":true`) with
  `first-skill: EDITED mid-session on <release>` and
  `skill-<release>: ADDED mid-session on <release>` — and each model reported the
  diff itself. Before this release the edit could not move the revision at all.
- Unit tests: `tests/wsl-search.test.ts` (28 cases) checks the framing, the glob
  matcher, retention against `ItemRetainer`, byte-equality of both renderers with
  the host suite's own formatters, card metadata narrowed back through its
  `present*Result`, argv construction, and the config-less mount; the skill
  provider gained an edit-detection case and a cadence case (a brand-new skills
  directory waits for the walk), and `skills-real` proves on the real 9P share
  that a rewritten skill file invalidates exactly once.

### Still not fixed (now stated in the panel's known issues)

- `grep` is the distribution's GNU grep: POSIX ERE (no lookaround or
  backreferences) and no `.gitignore` support, so git-ignored files are searched;
  only hidden entries, `node_modules` and VCS directories are skipped. A
  distribution without GNU grep fails loudly (exit 3) instead of framing records
  the parser cannot read.
- An `include` containing `/` is matched in this process, so that call scans
  every file before filtering (a performance, not a semantic, difference).
- `glob`'s modification-order listing needs GNU `find -printf`; a busybox `find`
  falls back to path order, which the script reports as a different listing mode.
- The catalog refresh is still a poll: an add, remove or edit inside a published
  skills directory lands within about 3 s; a new project's *first* skills
  directory waits for the next walk, up to 30 s.

## Worst-case pass over the new code (2026-09-20, plugin 0.7.0)

A second sweep over what this release added — hunting inputs that could break it
rather than confirming the happy path — found six defects. Every one of them had
passed the host-side suite.

### Four in the search tools

| input | what happened | fix |
|---|---|---|
| `grep path=.env` | **zero matches** for a file the caller named: the hidden-file guard (`--include='[!.]*'`) applied to file targets too | the guard is added only when the target is a directory (the script tracks `dir`); a file the caller names is what it asked for |
| `glob path=/nope-missing` | `{root, paths: []}` with **no error** — `find`'s non-zero exit was swallowed by the pipeline, so an unreadable target looked like an empty directory | both scripts now `exit "${PIPESTATUS[0]}"`, and `acceptRun` treats exit 1 as success **only** for grep, where it means "searched, no match" |
| a search root whose name contains a newline | `root: "od"` and every returned path wrong — the header was `<mode> <root>\n`, so the newline split it | the header is NUL terminated (`G<root>\0`), like every record after it |
| `grep path='D:\proj'` | `SEARCH_FAILED … No such file or directory`, while `read D:\proj\a.ts` opens the same file | `linuxTarget` maps a drive path through the shared `windowsToMntPath`, so search and the file tools open one tree |

Two more came from reading the contracts rather than probing:

- **The spill schema was closed.** The canonical value is validated against
  `tool.output.schema` (`createSuccessResult` throws `ToolOutputError` on a
  violation), and `@deepseek-ai/dsh-spill`'s `SpillRef` is
  `{locator, bytes, retrievalHint}` — so `additionalProperties: false` on the
  `spill` field would have failed the tool's own result on *every capped search
  with a spill backend mounted*, exactly when the model needs the recovery path.
  The field is now open (extra fields belong to the backend) and `normalizeSpill`
  narrows it to the two fields the footer prints.
- **The catalog detector could stack polls.** A pass over a slow share can outlast
  the 3 s interval, and the interval callback was fire-and-forget, so walks would
  pile up on the 9P share and later polls could read a half-finished shape. One
  pass in flight per scan root now.

### Two in the shell — both the host's, both reported by the operator

1. **The host's wrapper and a trailing `&`.**
   `@deepseek-ai/dsh-tool-bash-persistent` wraps every command as
   `printf …START; eval -- $'…'; status=$?; printf …END`. A command ending in `&`
   backgrounds the *whole* eval'd command, so the END marker and its status are
   printed before the work runs: the call returns exit code 0 with no output, and
   the real output arrives later — it can land inside the next call's output
   window. Reproduced inside a real PTY with the host's own `wrapCommand`, which
   shows `__START__ / [1] 459 / __END__:0 / one` — the output arriving *after* the
   marker; the same harness shows the documented form (`( … ) &` on its own line)
   keeping the sequencing intact. **Every release from `0.1.0-rc.7` on carries the
   identical wrapper**, and the host's own Minimal preset recommends exactly the
   hazardous form (`sleep 10 &`). `description` is a supported config key on all
   eight releases, so the world now overrides it with both facts (state carries
   over across calls; background a subshell) plus the safe form. Confirmed in a
   real `0.1.0-rc.7` session: the model quoted the override verbatim.

2. **`0.1.0-rc.7` cannot run a PTY shell on Windows at all.** Its
   `@deepseek-ai/dsh-subprocess-local` builds a process inspector inside
   `spawnTerminal` and supports only `linux`/`darwin`, throwing
   `subprocess-local: terminal inspection is unsupported on platform win32`
   before any process starts. A real session on that release showed the model
   getting exactly that error for every `bash` call, while grep/glob — which never
   touch the PTY — kept working. The capability arrived in `0.1.0-rc.8`
   (`createWindowsProcessInspector`), which the host itself relies on: that
   release's Minimal preset mounts `persistent-bash` with no Windows guard, so the
   host ships the same gap.

   The plugin now **probes the substrate instead of assuming**: it hands
   `spawnTerminal` a program that cannot exist, which reaches the inspector check
   and nothing else — no process is created either way, and the rejection says
   which half failed (`isTerminalInspectionUnsupported`). When the answer is "no
   inspector", the world keeps the one-shot `dsh-tool-bash` row, which runs
   through this plugin's own `ctx.shell` and never touches the PTY.

   Verified per release by booting each prepared case and reading the generated
   preset: `0.1.0-rc.7` gets the one-shot row, `0.1.0-rc.8` and `0.1.5-rc.2` get
   the persistent group with the description override. A real session on
   `0.1.0-rc.7` then showed `pwd && echo BASH_OK && uname -s` returning
   `/home/mille/manualtest`, `BASH_OK`, `Linux` (exit 0) — previously every call
   failed — and a follow-up pair of calls confirming the fallback is stateless
   (`cd /tmp` in one call, `pwd` in the next → `/home/mille/manualtest`), which is
   what that tool's own description tells the model.

### Verification of the fixes

- 152 unit tests green, including the new cases pinning each defect: framing
  around a newline in a root, the explicit dot-file, the `/mnt` mapping, the spill
  schema shape, the description block, the poll-stacking guard, and the
  background-job producer's registry contract (start arguments, hook bridging,
  outcome mapping, workdir default, abort, and the config-less mount).
- `search-real` gained six regressions (explicit dot-file, unreadable root, root
  name with a newline, `/mnt` path, cooperative timeout → `SEARCH_ABORTED`,
  raw-output overflow) alongside the existing framing, include, cap, spill, card
  and argv-safety checks.
- Thirteen checks × eight declared releases re-run with the fixes, each 11/13 with
  only the two documented baselines. Booting each case confirms the shape per
  release: `0.1.0-rc.7` gets the one-shot row and no producer, `0.1.0-rc.8` and
  later get the persistent shell plus `bash_background`.

### Frontend pass on every declared release (2026-09-20, plugin 0.7.0)

The 0.4.x line got a frontend pass on three releases; the 0.7.0 work had only been
driven in a browser on one. Since the client surfaces are what an operator
actually touches, all eight declared releases were booted side by side (isolated
`DSH_HOME`, ports 3310–3317) and each was walked through the same flow against the
same build:

| Step | What it proves | 0.1.0-rc.7 | 0.1.0-rc.8 | 0.1.1-rc.1 | 0.1.1-rc.2 | 0.1.2-rc.1 | 0.1.3-alpha.2 | 0.1.5-rc.1 | 0.1.5-rc.2 |
|---|---|---|---|---|---|---|---|---|---|
| `添加 WSL 工作区…` entry | the plugin registers into this frontend | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dialog fields | distribution list (`Ubuntu`, `docker-desktop`), path, username | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `检查` | the path is resolved and browsed **inside the distribution** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `创建并打开` | the workspace is registered and a session draft opens | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mode picker | 4 WSL variants (`Standard` / `Code` / `Minimal` / `Creator`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `?` help panel | the 0.7.0 news / usage / known-issue text renders | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Panel metadata | **v0.7.0** and **8** declared-release chips | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The `?` panel is reached from the WSL dialog's own header on every release, and on
all eight it renders the same three sections with the 0.7.0 text — including the
new `bash_background` / `job_kill` usage line and the rewritten five-bullet
known-issue list.

One behaviour that differs by release and is worth knowing: on the
`0.1.0-rc.*` and `0.1.1-rc.*` frontends the workspace list lives behind the
sidebar toggle, which starts **collapsed**, so the plugin's entry point is not in
the DOM until it is opened. That is the host's layout, not this plugin's, and it is
the same on the current line.

## The background-job producer (2026-09-20, plugin 0.7.0)

An operator's own session surfaced the last one, and it was this plugin's doing —
twice over.

**What they saw.** `bash` accepted `run_in_background: true`, ran the command in
the *foreground* (a `sleep 3` really took three seconds), returned its output
inline instead of a job id, and `job_list` answered `(no background jobs)` every
time.

**Why.** DSH's *one-shot* `dsh-tool-bash` is what starts a registry job:
`run_in_background: true` calls `ctx.jobs.start({kind: 'bash', …, run})` around a
`ctx.shell.start(...)` handle, and the host's `job_list`/`job_output`/`job_kill`
read that registry. A WSL world replaces that tool with the host's **persistent**
one, whose schema declares only `command` — so nothing produced a job. The
parameter schema does not set `additionalProperties: false` either, so the
unknown argument passed validation, was ignored by the tool, and no layer
reported it. The model had been *told* to use that parameter by this plugin's own
shell description, which mentioned `run_in_background: true` while describing how
to background work — a promise the tool it was attached to cannot keep.

**Fix, in two parts.**

1. The description now says what the tool is: `command` only, no
   `run_in_background` (and passing one is ignored), background a subshell as
   `( long-job > log 2>&1 ) &` and poll the log.
2. The world mounts `bash_background` (`src/host/wsl-jobs.ts` → `lib/wsl-jobs.js`),
   a thin producer over the host's own seams: `ctx.jobs.start` for identity and
   lifecycle, this plugin's `ctx.shell.start` for the process handle, and the
   registry's `JobHooks` for cancel/done/readOutput. It is mounted only alongside
   the persistent shell — a world that keeps the one-shot bash row already has
   `run_in_background` on that tool, so mounting both would be redundant.

**Verified in a real session** (`0.1.3-alpha.2`, WSL · Standard mode):

```
bash_background: started background job bash-1
job_list:        bash-1 [bash] running — for i in 1 2 3; do echo tick $i; sleep 1; done
job_output:      tick 1 / tick 2 / [status: running]
(4 s later)      tick 3 / [status: completed, exit code: 0]
```

The reads are incremental (the second read returned only the new line), the status
transitioned `running` → `completed`, and the runtime pushed its own completion
notice — the same behaviour the host's one-shot tool gives a non-WSL session.

**A second defect, caught by the same session.** The first attempt failed to mount
at all: `failed to apply loader entry jobs-wsl … Cannot read properties of
undefined (reading 'timeoutMs')` — a world row with no `config:` block hands a
function plugin an *undefined* config, which is the same mistake `wsl-search` made
one release earlier. Both entries now keep their defaults in one `DEFAULTS` object
the schema also reads, and both have a unit test that mounts with `undefined` and
with `{}`. That two entries made the identical mistake in one release is the
argument for the test rather than the convention.

**Two more, found by auditing the new tool before shipping it.**

- **A producer without a reader.** The world mounted `bash_background` whenever the
  persistent shell was mounted, but Minimal mode's source preset has no
  `tool-jobs` row — so a WSL Minimal session would have handed out job ids with no
  `job_output` or `job_kill` to read them. The row is now gated on the source
  mounting `tool-jobs`, the same `sawSearch`/`sawEditor` rule the other rows
  follow: a mode never gains a capability it did not have.
- **The job's working directory.** `bash_background` passed only the caller's
  `workdir`, so an omitted one fell through to this plugin's shell provider, whose
  fallback is its own configured cwd — in a WSL world, the *host process's*
  Windows directory, which the distribution cannot use. The persistent `bash`
  starts in the session workspace (the relay's `cd`), so the producer now defaults
  to the session cwd (`exec.agent.session.header.cwd`) and matches it. Verified in
  a real session: `bash_background` with no `workdir` reported
  `/home/mille/manualtest`, and `job_kill` on a long loop returned
  `[status: killed, exit code: 1]` with no further output.

## The per-turn stall in a UNC workspace (2026-09-21, plugin 0.7.2, issue #25)

The first defect on this project reported by someone other than the operator, and
it was this plugin's doing.

**What they saw** (DSH `0.1.6-alpha`): a conversation whose workspace is a UNC path
finished *every* request in about 30 seconds, with the UI showing the thinking
state for the whole time. The same conversation on a normal Windows folder path was
unaffected.

**Why.** The host rebuilds the skill catalog during a request and awaits each
provider's `list()`, and this plugin's provider for WSL UNC workspaces served a
completed lookup from cache for `CACHE_TTL_MS = 10 s` only — so every re-collection
(a new session or scope, or simply a lookup more than 10 s after the last one) paid
a full re-discovery walk, on the request path, and that walk was sequential: for
each directory one `stat` for `.dsh/skills`, one for `.agents/skills`, then one
`readdir`. Measured on this machine against `\\wsl.localhost\Ubuntu`:

```
readdir (9P share)                                        3.34 - 15.55 ms/op
stat    (9P share)                                        1.18 -  1.61 ms/op
list()  69-directory tree                                  1.5 - 2.7 s
list()  budget-sized tree (/usr, 4096 directories)        20.4 s, 0 skills found
repeat  list() of one cached root, before the fix          132 ms (a full re-walk)
repeat  list() of one cached root, after the fix             1-3 ms (no I/O)
```

The walk's budget (`MAX_VISITED_DIRECTORIES = 4096`) is what made the delay
*constant* rather than proportional to the workspace: any tree large enough to
reach it paid the same 20-30 s, which is exactly the "fixed 30 seconds" in the
report. One part of the report was not ours: `parseWslUnc` accepts only the
`\\wsl.localhost\…` and `\\wsl$\…` hosts, so a plain SMB workspace never reaches
this provider — `list()` returns `[]` before any I/O.

**Fix, in two parts.**

1. A published catalog is served as-is. The provider already runs a change detector
   per served scan root (`REFRESH_POLL_MS = 3 s` over the roots it published,
   `DISCOVERY_POLL_MS = 30 s` for the full re-discovery walk), and that detector is
   what drops the cache and bumps the registry's revision: the request-path rescan
   was redundant with it and *was* the stall. The freshness contract is unchanged —
   an added, removed or edited skill is still visible within 3 s, and a new nested
   skills directory within 30 s, which is what the panel has always documented.
2. The walk itself is cheaper. One BFS layer is probed concurrently
   (`WALK_CONCURRENCY = 16`, bounded so the share is not flooded) and published in
   frontier order, so the catalog does not depend on which probe finishes first; the
   4096-directory budget is claimed before any probe starts, so concurrency cannot
   change *what* is visited, only how long it takes. A directory's markers are
   probed only when its own listing showed them, which removes two round trips per
   directory for the common case. The budget-sized walk went from 20.4 s to 4.8 s;
   node's filesystem thread pool (4 threads by default) is what caps the real
   parallelism.

**Verification.**

- The numbers above come from `node --experimental-strip-types
  .test-runs/probe-skills-walk.mjs`, against the same share, before and after.
- `tests/wsl-skills.test.ts` gained the regression test the defect deserved: a
  served lookup must cost *zero* further `readdir` calls across repeated requests,
  and may only move once its watcher has invalidated it (32/32 in that file, 139/139
  across the suite).
- The published `0.7.1` tarball was confirmed to carry the old code —
  `CACHE_TTL_MS = 1e4`, `expiresAt`, and the sequential
  `for (const [dir, depth] of frontier)` loop — so the version the reporter runs is
  the one this fixes.
- The eight-release matrix re-ran the real-9P `skills-real` check — the same walk,
  against a real distribution — on every declared release: green on all eight, with
  the two documented red baselines unchanged (11/13 each: `typecheck` and the
  `host-api` check, which needs a live server).
- The host chain that puts the walk on the request path is in `dsh-skill` itself:
  `list()` → `snapshot()` → `collect()`, and a collect-cache miss reaches
  `collectFresh()`, whose `collectLayer` does
  `await waitWithAbort(provider.list(options), options.signal)`
  (`dsh-skill/lib/index.js:350`).

**What did not reproduce here.** The reporter's *per-turn* shape did not. With the
published 0.7.1 installed on `0.1.0-rc.7` and on `0.1.6-alpha.2`, against the same
budget-sized workspace (4204 directories), a repeat turn inside one session was
already fast — 253 ms then 807 ms on rc.7, 1415 ms then ~1 s on 0.1.6-alpha.2 — and
a newly created session reached a usable composer in 202 ms. The host's own collect
cache (`dsh-skill`, keyed by cwd + scope + revision) absorbs later turns, so this
provider is only asked when that cache misses. What this release fixes is what was
actually measured: the walk's cost (20.4 s → 4.8 s) and the fact that a
re-collection no longer pays it at all. Whether that closes the report depends on
what the reporter's sessions re-collect on, so the next step is to ask them for the
exact workspace path form (a `\\wsl.localhost\…` or `\\wsl$\…` path reaches this
provider, a plain SMB share never does — `parseWslUnc` returns null and `list()`
answers `[]` before any I/O) and whether the delay is per turn or per session.

## The preset channel moved from directories to declarations (2026-09-23, plugin 0.7.3, DSH 0.1.7-rc.1)

The first upstream change that stopped the plugin **loading** rather than breaking a
session. Its own load path is guarded (one unreadable source preset must not take the
plugin down), so the failure was one log line and a silently empty mode roster.

**What the host logged** (`0.1.7-rc.1`, at every boot):

```
dsh-wsl-workspace: WSL preset-variant generation failed: agentPresets.read is not a function
```

`$DSH_HOME/.agent-presets/` kept only the user's own entries; every `wsl-*` mode the
picker used to offer was gone, and nothing else in the boot log said why.

**Why, in four parts.** The first three are the host API moving; the fourth only
becomes visible once the first three are adapted.

1. **`read()` became `readDocument()`.** The host preset service is now
   `@deepseek-ai/dsh-agent-preset-registry` (the key is still `agentPresets`). It
   exposes `list()`, `resolve()`, `readDocument()`, `select()`, `register()` — and no
   `read()`. `readDocument(id)` returns an `AgentPresetDocument`
   (`{agentPreset, content, name, description}`) rather than the composition text.
   Note the Remote face kept the *method* name `read` (`@Remote('read')
   readDocument(...)`), so the browser half is unaffected; this is a host-side rename.
2. **`AgentPreset` no longer carries `path`.** Its shape is now
   `{id, name?, description?, order?, broken?}`. The generator used `path` for two
   things — mirroring the source preset directory and reading its `preset.yml` for
   `name`/`order` — and both are gone. Display metadata now comes from the roster face
   itself (`name`, `order` on the entry; `readDocument().name`).
3. **The directory root is no longer scanned at all.** `0.1.7-rc.1`'s own skill says it
   outright: *"Before declaration rows, a user preset was a directory
   `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` … and `agent.cordis.yml` …
   **Nothing reads that directory any more.**"* Shipped presets moved to
   `dsh-web-app/presets/*.patch.yml`, each declaring one
   `@deepseek-ai/dsh-agent-preset` row with `config: {id, plugins: […], name?,
   description?, order?}`. A variant therefore has to be **registered** — the API for
   that is `ctx.agentPresets.register(definition)`, which returns a disposer.
   The boundary is exact in the published packages: `@deepseek-ai/dsh-agent-preset` and
   `@deepseek-ai/dsh-agent-preset-registry` first ship in `0.1.7-alpha.1`, and the old
   plural `@deepseek-ai/dsh-agent-presets` ends at `0.1.6-alpha.2`. The release verified
   here is `0.1.7-rc.1`; `0.1.7-alpha.1`/`alpha.2` carry the same shape but are not
   declared, because they have not been run through the matrix.
4. **A registered declaration's rows are imported by a tree that does not resolve
   absolute paths.** Only the boot-time root Include rewrites an absolute specifier to
   a `file:` URL before importing it (`dsh-app-boot/lib/index.js`, `class
   HostResolvedRootInclude extends Include { import(name) { const specifier =
   isAbsolute(name) ? pathToFileURL(name).href : name … } }`). The directory channel
   inherited that because its rows lived in an Include-backed tree; a preset mounted
   through `register()` is loaded by the registry's own `PresetTree`, whose import is
   the plain one. Handing it `C:/…/lib/shell.js` leaves every provider row without a
   fiber, `auditRows` reports it as `never started`, `mountPreset` throws, and
   `activate()` records the whole variant as broken. Observed on the first working
   declaration build:

   ```
   wsl-standard: "shell-wsl (…/lib/shell.js): never started
                  fs-wsl (…/lib/fs.js): never started
                  sandbox-wsl (…/lib/wsl-sandbox.js): never started
                  search-wsl (…/lib/wsl-search.js): never started
                  jobs-wsl (…/lib/wsl-jobs.js): never started"
   ```

**Fix.** `src/index.ts`: the roster face is probed by capability
(`readDocument`/`register` present ⇒ declaration channel; otherwise `read` + `path` ⇒
the directory channel, unchanged). On the declaration channel the plugin expands the
composed variant back into an entry list with the very schema the harness uses for that
dialect (`@deepseek-ai/cordis-plugin-include`'s exported `entryListSchema`, whose
docblock says it exists so config tooling can round-trip the format), rewrites every
absolute `name` to a `file:` URL while leaving config values (the relay path, the
interpreter path) native, and publishes the declaration. The plugin's `ctx.effect`
collects the returned disposers, so an unload or hot reload retires the variants rather
than leaving orphans the next apply cannot replace. The retired root is swept: nothing
reads it any more, so a leftover `wsl-<mode>/` beside a registered `wsl-<mode>`
declaration would only mislead. `transformPresetForWsl` (the text-level transform) is
untouched — the entry-list text is the same in both channels, so only the channel that
carries it changed.

**Verification.**

- **Isolated case, `@deepseek-ai/dsh@0.1.7-rc.1`** (own npm prefix, own `DSH_HOME`, own
  port; never the live installation) — the procedure of
  `scripts/verify-dsh-compat.sh`, run with the local tarball because the published
  0.7.2 predates this change:
  - **install** — `dsh plugin --profile web add <tarball>` exit 0, and
    `$DSH_HOME/profiles/web/package.json` lists the plugin.
  - **start** — boot is clean (`stderr` carried only the disposable roster probe below),
    the server listens, and `POST /wsl-workspace/api {"method":"listDistros"}` answers
    **200** with `{"ok":true,"value":["Ubuntu-24.04","docker-desktop"]}`.
  - **preset roster in that isolated case** (disposable probe added to the *installed
    copy only*, since the runner has no roster probe): four variants registered
    (`wsl-standard` 16 rows, `wsl-ptc` 17, `wsl-minimal` 2, `wsl-cordis` 17) and the
    roster reads
    `standard(1) / wsl-standard(1) / ptc(2) / wsl-ptc(2) / minimal(3) / wsl-minimal(3) / cordis(4) / wsl-cordis(4)`
    — every `wsl-*` entry `broken: null`, and each inherits its source's roster order.
  - **uninstall** — `remove` exit 0, the profile manifest no longer lists the plugin,
    and after a re-boot the plugin route answers **405** (not 200), which is the
    script's clean-uninstall criterion.
- **Live profile on the same release** — the operator's own `web` profile, with the
  patched plugin: identical roster (four healthy variants, same order), clean boot, and
  the route answering 200 with the same two distributions.
- **`tests/host-declare.mjs`** (new, 50 assertions) — the declaration channel against a
  fake roster face: the capability switch, one declaration per healthy source (broken
  sources and existing `wsl-*` presets skipped), metadata taken from the roster rather
  than a `preset.yml`, the row list being an importable entry list (world group and its
  isolating realm, a `!!js` disabled expression that must round-trip as an expression
  node, the relay/interpreter paths that must *not* become `file:` URLs), the world's
  providers named as `file:` URLs pointing at real built files, no write to the retired
  root plus its leftovers removed, and disposal retiring every declaration.
- **Unchanged channels** — `tests/host-materialize.mjs` (the directory channel, 73
  assertions) still passes untouched, confirming the older releases' path is intact.
- **Gates** — unit suite 139/139, `tests/client-lifecycle.test.mjs` 13/13,
  `scripts/verify-lib.mjs` OK (11 entries), `scripts/check-rank-parity.mjs` OK, and
  `tsc --noEmit` at exactly its previous count (232 errors, all pre-existing in the
  harness's own declarations and the test files; the only moving lines are the two
  `@deepseek-ai/*` module-resolution errors that shift with the longer docblock).
- **Plain-npm installability** — the gate's question is whether plain npm can install
  this tarball and whether it pulls the new peers. `npm install
  dsh-wsl-workspace-0.7.3.tgz` into an empty directory: exit 0, version 0.7.3 on disk,
  and **neither** `@deepseek-ai/cordis-plugin-include` nor `js-yaml` installed (both are
  optional peers), so the 0.7.1 `E404` class cannot come back.
  `scripts/verify-install.mjs` performs that same install as the published-artifact gate
  and runs in `prepublishOnly`.

  > Superseded **as a design claim**, not as a measurement (2026-10-01, plugin 0.7.6,
  > issue #47): that install was read as the wanted end state, and on a real DSH Desktop
  > profile it is the defect — the variant generator resolved both modules at call time,
  > so an install carrying neither installs a plugin that generates no variant, silently.
  > The install of that day and its readout stand; the conclusion drawn from them is
  > replaced by the section `Issue #47: a profile that cannot lend the generator its
  > modules` below, and `scripts/verify-install.mjs` now asserts the runtime surface is
  > present instead of certifying that it is absent.

**Note on the committed `lib/`.** The rebuild that ships with this change moves every
chunk hash and reflows comments in files this change does not touch, because `tsdown`
depends on `rolldown: "latest"` and neither lockfile is committed (`.gitignore` excludes
`package-lock.json` and `pnpm-lock.yaml`). A build of the **unmodified** tree churns the
same way, so the churn is the toolchain's, not this change's; `lib/index.js` is the only
entry whose *code* differs.

**Legacy directory presets: the host's migration.** `$DSH_HOME/.agent-presets/` stops being
read for *every* legacy user preset, not just the variants this plugin generated — a
hand-written preset left there is now invisible to the roster, and so gets no `wsl-<mode>`
variant. That migration belongs to the host, whose own skill documents the route: turn the
legacy directory into a bundle declaration (`preset.yml` → `name`/`description`/`order`,
`agent.cordis.yml` → `plugins`), install it, then delete the directory. This plugin only
sweeps the `wsl*` entries in that root, which its own directory channel wrote.

## The Desktop host wrapper stripped `execFile`'s promisify metadata (2026-09-28, plugin 0.7.4, issues #35/#36)

The first report that the plugin was **installed and mounted but unusable in DSH Desktop**:
the "Add WSL workspace" dialog opened, the distribution picker stayed empty, and
"Create & open" could not be completed — while `wsl.exe -l -q` listed the distribution
normally in a terminal, which is what made the report look like "the plugin cannot find
WSL2" (issue #36). Issue #35 reported the same flow failing from the dialog side.

**The failure is a host-side patch, not a missing WSL.** DSH Desktop loads a Node
`--import` hook (`resources/windows-child-process-hide.mjs`) *before* any plugin module
runs. It replaces `child_process.exec`/`execFile` with plain function wrappers that only
inject `windowsHide: true`, then re-exports them with
`syncBuiltinESMExports()`. The replacement function carries no
`util.promisify.custom`, so `util.promisify(execFile)` falls back to the generic
implementation — which resolves with the **first callback argument only**, i.e. the
stdout value itself. Every call therefore produced a string where the plugin expected
`{ stdout, stderr }`, and the distribution lookup read `result.stdout`:

```
{"ok":false,"error":"Cannot read properties of undefined (reading 'includes')"}
```

That is the exact body the dialog's own API route returned on the published `0.7.3`
under a Desktop-equivalent wrapper, and `web.err` stayed at **0 bytes** — the frontend
catches the rejection and renders an empty picker, so nothing reaches the log. The plugin
was not "finding no WSL"; the *shape* of the `execFile` result had been changed by the host
it runs under.

**The fix.** All three call sites (`listDistros`, `defaultDistro`, `resolveLinuxSymlink`)
now go through `execFileResult()` in `src/shared/wsl.ts`, which calls `execFile` in its
**callback** form — a signature no wrapper can reshape — and resolves `{ stdout, stderr }`
itself; `textOf()` narrows either stream shape to text. The `wsl.exe` lookup also became a
candidate list (`wsl.exe` on `PATH`, then `%SystemRoot%\System32\wsl.exe`), and a lookup
that fails now names every candidate it tried with the error each produced, instead of
surfacing a type error from inside the decoder.

**Reproduction, before and after** — `NODE_OPTIONS="--import file:///…/child-process-hide.mjs"`
on a real `dsh web` process, with a stand-in that reproduces the Desktop wrapper
(plain wrappers + `syncBuiltinESMExports()`), all on `0.1.5-rc.2`:

| Instance | Installed artifact | `POST /wsl-workspace/api` → `listDistros` | Dialog picker | Create & open | Six-item pass | `host-api.mjs` |
|---|---|---|---|---|---|---|
| port 3380 | registry `0.7.3` | `{"ok":false,"error":"Cannot read properties of undefined (reading 'includes')"}` | **empty** | fails | fails | 11/12 (only `distros`) |
| port 3381 | `0.7.4` (first pack) | `{"ok":true,"value":["Ubuntu","docker-desktop"]}` | `Ubuntu`, `docker-desktop` | works | 6/6 | — |
| port 3382 | `0.7.4` (release tarball) | same | same | works | 6/6 | 12/12 |

**Regression test.** `tests/exec-shape.mjs` writes a Desktop-equivalent wrapper, spawns a
probe process with and without `--import`, asserts the wrapped shape really is broken
(otherwise the test proves nothing) and that the helpers are right, then runs the three
real functions through both shapes and asserts the two runs agree on the distribution list.
It is registered as the `exec-shape` check in `scripts/compatibility/Run-Checks.ps1`, so a
future refactor cannot quietly go back to `promisify(execFile)`.

**The frontend pass, six items on every declared release.** The runbook's §3 gained an
unconditional item 6 ("open the WSL workspace from the frontend"): the picker must list the
distribution, `listWorkspaces` must report the `\\wsl.localhost\…` path, the workspace row
must appear in the sidebar, and a page reload must still open it — none of which the
script-level harness can see. All ten declared releases (`0.1.0-rc.7` … `0.1.7-rc.2`, the
last one newly declared here) plus a Desktop-wrapped instance of the release artifact passed
all six with `web.err` at 0 bytes, and the written file was re-read independently on the
Linux side (`COMPAT_<port>_OK`, 14 bytes). `0.1.0-rc.7` keeps its documented one-shot bash
(that release has no Windows process inspector).

**Harness and gates.** Ten releases × 15 checks: 13/15 each, the two failures being the
documented baseline — `typecheck` (the pre-existing `tsc --noEmit` errors) and `host-api`
run from the harness, which needs a *running* frontend (`manifest.port` is `undefined`
there; pointed at the live instances it is 12/12 on every release). The first pass also
caught a real one: the new help-panel news body had a 433/453-character bullet, over the
320-character limit `tests/locales.test.ts` enforces, so the bullets were split. Pack
identity was verified at that point (the tarball, a fresh `npm pack`, and
`npm pack --ignore-scripts` over the committed `lib/` all hashed to
`C34F317F86526289A0EE47059CDD2912744312DBFEAE1CDA5FDB0183244D9AA7`), and the plain-npm gate
(`scripts/verify-install.mjs`, also `prepublishOnly`) reports
`verify-install: OK - plain npm installs dsh-wsl-workspace@0.7.4`.

## The published artifact, installed the way a user installs it (2026-09-28, plugin 0.7.4)

`npm publish --tag next` uploaded 0.7.4 and the registry needed a couple of minutes to
serve it (`npm view dsh-wsl-workspace@0.7.4` answered `E404` at first, and the packument
only listed it at `2026-09-28T16:18:23Z`). The published artifact is:

```
version  0.7.4
shasum   1d797509cf3eb0d916aa4366ceebd333b5ad7a3a
sha256   182F78CF2311C53F7E28F0BD61AA48FEE190F2011493C0F440B056BADDCDD802
57 files, unpacked 3,135,851 B
dist-tags: next = 0.7.4, latest = 0.7.3
```

**It differs from the tarball the compatibility pass ran on in exactly three files.**
Comparing the published tarball against the one packed before the last documentation
edits: `README.md`, `README.zh.md` and `TESTING.md` are the only entries whose hash
differs — the published copies are the *newer* ones, carrying the 0.7.4 changelog, the
six-item compatibility rule and the harness notes. **Every code entry is byte-identical**
(`lib/index.js`, `lib/wsl-*.js`, `lib/links-*.js`, `lib/shell.js`, `lib/fs.js`,
`lib/wsl-search.js`, `lib/client.js`, the maps, and `src/`), so the ten-release pass above
describes the published behaviour. The same delta also explains why the earlier
`C34F317F…` pack is not the published byte sequence: the doc edits landed after it, and
the publish's own `prepublishOnly`/`prepack` rebuild left `lib/` unchanged.

**Install, the way a user does it** — both paths into the registry, on an empty directory
with no pnpm and no host packages present:

| Command | Result |
|---|---|
| `npm install dsh-wsl-workspace@0.7.4` | exit 0, `added 1 package`, version 0.7.4, 10 declared releases, 11 `lib/*.js` chunks |
| `npm install dsh-wsl-workspace@next` | exit 0, resolves to 0.7.4 |

**Behaviour of the published bytes** — five isolated `dsh web` instances, each installed
by name from the registry (the launcher asserts the installed version is the requested
one), one of them wrapped the way DSH Desktop wraps `child_process`:

| Port | Release | `listDistros` | Dialog | Six-item pass | `host-api` | `web.err` | Linux re-read |
|---|---|---|---|---|---|---|---|
| 3390 | 0.1.0-rc.7 | ok (Ubuntu, docker-desktop) | lists + creates | 6/6 (one-shot bash, expected) | 12/12 | 0 B | 14 B ✓ |
| 3391 | 0.1.2-rc.1 | ok | lists + creates | 6/6 (persistent bash `/tmp`) | 12/12 | 0 B | 14 B ✓ |
| 3392 | 0.1.5-rc.2 | ok | lists + creates | 6/6 (persistent bash `/tmp`) | 12/12 | 0 B | 14 B ✓ |
| 3393 | 0.1.7-rc.2 | ok | lists + creates | 6/6 (declaration channel, persistent bash) | 12/12 | 0 B | 14 B ✓ |
| 3394 | 0.1.5-rc.2 + Desktop wrapper | ok | lists + creates | 6/6 (persistent bash `/tmp`) | **12/12** | 0 B | 14 B ✓ |

The help panel on the published build reports **v0.7.4**, "本次更新（0.7.4）" and **10**
release chips; the same wrapper against the published **0.7.3** answers `listDistros` with
`{"ok":false,"error":"Cannot read properties of undefined (reading 'includes')"}`, an empty
picker and 11/12 `host-api` checks — the before/after of issues #35/#36, now measured on
the artifact users actually install.

**The older versions are deprecated on the registry.** The defect predates the fix by the
whole published history — the earliest release, `0.1.0`, already shipped the
`promisify(execFile)` lookup (checked by unpacking its tarball) — so all **16** versions
before 0.7.4 carry it, and 0.7.4 is the only clean one:

```powershell
npm deprecate "dsh-wsl-workspace@<0.7.4" "DSH Desktop 下对话框发行版列表为空（issues #35/#36）。Fixed in 0.7.4 - upgrade: npm i dsh-wsl-workspace@latest"
```

Registry state afterwards: `dist-tags` = `latest: 0.7.4`, `next: 0.7.4`; 16 of 17 versions
carry the message and 0.7.4 carries none (`npm view dsh-wsl-workspace@0.7.3 deprecated`
prints it). The warning reaches the user on the npm path — `npm install
dsh-wsl-workspace@0.7.3` prints `npm warn deprecated dsh-wsl-workspace@0.7.3: …` and still
installs, while installing by name resolves to 0.7.4 with no warning — and on the pnpm path
when pnpm actually fetches the metadata (`[WARN] deprecated …`, plus a `deprecated` marker
and "0.7.4 is available" in the dependency list). `dsh plugin add` shows it only then: with
a warm pnpm metadata cache it printed no warning in testing, which is why the release note
and the issue comments matter as well. Deprecation is advisory — it never blocks an install
— and is reversible with an empty message.

## The Desktop PTY ran on the Electron executable (2026-09-30, plugin 0.7.5, issue #40)

The second DSH Desktop report, and the first one that is not about the dialog. There the
dialog works and the workspace is created, and then **every** `bash` call fails:

```
Error: PTY shell exited during startup
```

while `glob`/`read`/`write` keep working — which is why the report reads as "the bash tool
is broken in WSL". The reporter's host is DSH Desktop `0.2.0-rc.2` with plugin `0.7.4`.

**The plugin hands the PTY backend a command of its own.** A WSL variant does not mount the
host's one-shot `dsh-tool-bash`; it mounts the host's PTY registry and its config-driven
backend (`@deepseek-ai/dsh-terminal-bash`) and tells that backend what to run: `shellPath`
is a node executable and `shellArgs[0]` is `lib/wsl-relay.js`. The relay has to be there
because only it can read the session's distribution and user at spawn time. Everything else
in that stack belongs to the host — the interpreter is the plugin's one choice, and it was
`process.execPath`.

**On DSH Desktop `process.execPath` is the Electron executable.** The official Windows
installer (`dsh-latest-windows-x64.exe`, `0.2.0-rc.2`) unpacks to `DeepSeek Harness.exe`
plus `resources/app.asar` and `resources/runtime/`, and its own code says so:

- `runtimeResources()` returns `{ node: process.execPath, … }`, and `DesktopHostProcess` is
  constructed with `resources.node` as its executable;
- `desktopNodeEnvironment(executable, bin, environment)` sets `ELECTRON_RUN_AS_NODE: "1"`
  for every node-mode child;
- `resources/runtime/bin/node.cmd` is `set ELECTRON_RUN_AS_NODE=1` followed by
  `"%DSH_DESKTOP_NODE_EXECUTABLE%"` — that variable is the *Electron* executable, not a
  node, which is what makes it a trap for a fix that trusts it;
- the payload beside it, `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`,
  is a real node (`versions.json` says `24.18.1`; the shipped binary reports `24.21.0`).

The plugin's host process is spawned with `desktopNodeEnvironment(this.node, void 0, …)`, so
it gets `ELECTRON_RUN_AS_NODE=1` and **not** `DSH_DESKTOP_NODE_EXECUTABLE`; its
`process.argv` carries the absolute `…/resources/runtime/primary-runtime` path.

**An Electron binary writes nothing at all under a ConPTY.** Measured on this machine with
the host's own node-pty (`1.2.0-beta.15`), the plugin's real `lib/wsl-relay.js`, the PTY
backend's own child environment and a real `\\wsl.localhost\Ubuntu\home\mille` cwd — the
interpreter is the only variable:

| Interpreter | Output | Exit |
|---|---|---|
| `DeepSeek Harness.exe` (Electron 44, node mode) | **0 bytes** | `0` after 4.1–6.8 s |
| `…/primary-runtime/dependencies/node/bin/node.exe` (node 24.21.0) | 170 bytes, prompt `mille@mikao:~$` | still running |

Zero bytes and a clean exit is exactly `waitReason === 'session_exit'` in
`LocalPtySession.initialize()`, i.e. the `PTY shell exited during startup` the reporter saw.
The same interpreter under plain pipes works, which is why the relay itself was never
suspected.

**The fix** is `src/shared/relay-node.ts`. The interpreter is resolved deliberately: the
payload named in `process.argv` first, then the same payload beside the running executable
(`Contents/Resources/…` on macOS), then `DSH_DESKTOP_NODE_EXECUTABLE`, then a `node` on
`PATH`, then `process.execPath`. Every candidate is asked what it is — one spawn of
`-e "process.stdout.write(JSON.stringify([process.versions.node, process.versions.electron ?? null]))"`
— because a version string cannot answer the question:

```
electronVersionFlag: "v24.18.1"        <- `--version` on the Electron executable, which
electronProbe: { ok: false, reason: "is the Electron 44.0.0 executable, not node" }
```

`--version` prints the *node* version whenever `ELECTRON_RUN_AS_NODE` is inherited, which it
always is inside the Desktop host, so a `^v\d+\.\d+\.\d+` check happily selects the broken
interpreter. PR #39 proposed exactly that check with `DSH_DESKTOP_NODE_EXECUTABLE` as its
first candidate; on the shipped Desktop that variable is the Electron executable. Its
direction was right and its second candidate is the one that works, but the chain it shipped
is one host change away from silently reverting.

**What the host process actually has in its environment.** A throwaway probe plugin was
installed into the scratch Desktop profile and mounted, so this is measured rather than read
off the Desktop's source:

```json
{"execPath":"D:\\…\\DeepSeek Harness.exe","electron":"44.0.0","node":"24.18.1",
 "DSH_DESKTOP_NODE_EXECUTABLE":null,"ELECTRON_RUN_AS_NODE":"1","pathHasRuntimeBin":false,
 "argv":["…\\DeepSeek Harness.exe","…\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js",
         "…\\app.asar\\dsh","…\\profiles\\desktop","…\\resources\\runtime\\primary-runtime",
         "…\\resources\\runtime\\pnpm\\bin\\pnpm.mjs","…\\resources\\runtime\\bin"]}
```

Three consequences for the review of PR #39:

- `DSH_DESKTOP_NODE_EXECUTABLE` is **absent**, so PR #39's first candidate is skipped today
  and the fix does work — entirely because of its second candidate, the bundled payload.
- `pathHasRuntimeBin` is **false**, so its third candidate (`node.exe` on `PATH`) finds
  nothing on a Desktop machine without a system node; the Desktop's own `runtime/bin` holds
  `node.cmd`/`node` shims around the Electron executable, not `node.exe`.
- `ELECTRON_RUN_AS_NODE` **is** set and `process.execPath` is the Electron executable, so
  the `--version` check would accept that executable if it were ever offered as a candidate
  — which is what `desktopNodeEnvironment(executable, bin, …)` does the moment it is called
  with a `bin` directory.

The probe was uninstalled and the scratch profile is back to the single plugin under test.

**PR #39 was then installed and run on the same Desktop.** Its two changed files were taken
from the PR head (`18d870e2`), everything else from `main`, packed with `--ignore-scripts` so
its committed `lib/` was used as-is, and linked into the scratch Desktop profile. `bash` then
worked — `6.18.33.2-microsoft-standard-WSL2 / /home/mille/fx-3381 / mille`, no
`PTY shell exited during startup` — so the PR **does** fix issue #40 today. It does so through
its second candidate, with its first candidate skipped because that variable is absent from
the host environment, and with no diagnostic at all if that ever changes.


A host that is not Electron returns `process.execPath` and spawns nothing, so `dsh web` is
unchanged; on the Desktop the chosen interpreter and every rejected candidate are written to
the boot log (`dsh-wsl-workspace: persistent shell: relay interpreter is …`), so the next
report of this kind carries its own diagnosis.

**The simulation, on the real binaries.** `.test-runs/desktop-pty-sim.mjs` runs the resolver
*inside* the extracted `DeepSeek Harness.exe` (Electron 44, node mode) with the Desktop's own
argv and environment, then runs the real relay under a real ConPTY twice. The first run
reports `isElectronHost: true`, `execPath: …\DeepSeek Harness.exe`, and resolves to
`…\primary-runtime\dependencies\node\bin\node.exe` — from the argv payload and, in a second
run without it, from the executable-relative lookup. The ConPTY comparison is the table
above. The stand-in is node-pty itself, taken from the DSH checkout because the Desktop keeps
its copy inside `app.asar`; both arms use that same copy.

**Regression tests.** `tests/relay-node.test.mjs` (unit, picked up by the harness's `unit`
check) pins candidate derivation — argv, executable-relative, the macOS bundle, the
environment variable, de-duplication and order — and the discriminator, including the
version-shaped output that must be refused. `scripts/compatibility/conpty-relay.mjs` is a new
standing gate: it resolves the interpreter on the release under test and requires it to
produce a live bash prompt through a real ConPTY. Nothing checked that invariant before,
which is why a defect that broke every persistent shell on Desktop could ship.

**Harness and gates.** Eleven releases × 16 checks: **14/16 each**, the two failures being
the documented baseline (`typecheck`, and `host-api` from the harness, which needs a running
frontend). `conpty-relay` is green on all eleven. Pointed at the eleven live instances,
`host-api` is **12/12** on every one.

**The frontend pass, six items on every declared release.** `0.1.0-rc.7` … `0.2.0-rc.2` (the
last one newly declared here, and the DSH release DSH Desktop `0.2.0-rc.2` ships), each on
its own `dsh web` instance with the packed `0.7.5` tarball installed: the picker listed
`Ubuntu` and `docker-desktop`, "Create & open" produced a session whose header names the WSL
variant, the file tools wrote and read `compat.txt` (re-read independently on the Linux side:
`COMPAT_<port>_OK`, 14 bytes each), bash reported `6.18.33.2-microsoft-standard-WSL2` /
`/home/mille/fx-<port>` / `mille`, `cd /tmp` survived into the next independent `bash` call on
all ten releases that have a Windows process inspector, `0.1.0-rc.7` stayed one-shot as
documented, the `compat-probe` skill reported its `SKILL_TOKEN_<port>`, and the workspace row
reappeared in the sidebar after a page reload and opened again. `web.err` was **0 bytes** on
all eleven. The help panel renders `v0.7.5` with eleven chips and the 0.7.5 news block.

**The Desktop itself was run afterwards.** This section's measurements are on the Desktop's
own binaries; the next section starts the real application from the unpacked installer and
runs the six-item pass inside it, first on 0.7.4 (which reproduces both errors) and then on
0.7.5. The manual recipe is in `TESTING.md`.

## The real DSH Desktop, end to end (2026-09-30, plugin 0.7.5, issue #40)

Everything above was measured on the Desktop's *binaries*; this is the Desktop
itself. The official installer (`dsh-latest-windows-x64.exe`, `0.2.0-rc.2`) was
unpacked with 7-Zip — no installation — and `DeepSeek Harness.exe` was started
directly, with:

- `DSH_HOME` pointed at a scratch directory, so the real profile was never touched;
- `--remote-debugging-port`, which Electron honours, so the window could be read
  and driven over CDP (`.test-runs/desktop-cdp.mjs`);
- the plugin installed and enabled through the Desktop's **own plugin panel**
  (添加插件 → a local directory path → 安装 → 启用), which is the path a user takes.

**0.7.4 reproduces both halves of issue #40.** With the published artifact
installed, a WSL workspace was created at `/home/mille/fx-3380` and the agent was
asked to run bash:

```
第 1 步：uname -r; pwd; whoami
原样输出（4 次重试，结果完全一致）：
Error: PTY shell exited during startup
...
bash_background    另一种故障：session "[object Object]" has no live agent
```

In the same session the dialog listed `Ubuntu` and `docker-desktop`, the preset
was `WSL · Standard mode（标准模式）`, and the `compat-probe` skill loaded and
reported `SKILL_TOKEN_3380` — so the failure is exactly and only the persistent
shell, which is what the report said.

**The second error is a plugin bug, not a symptom of the first.**
`bash_background` passed `owner: exec.agent` to `ctx.jobs.start()`.
`@deepseek-ai/dsh-jobs-local`'s `resolveOwner(session)` does
`agents.get(session)` and throws `session "<session>" has no live agent` when that
misses — and a session **id** is what it wants, which is what the host's own
producers pass (`owner: parent.id` in `dsh-tool-subagent` and
`dsh-tool-workflow`). Handing it the agent object could only ever stringify to
`[object Object]`. The plugin now passes `agent.id`, and `tests/wsl-jobs.test.ts`
— which had pinned the wrong contract — asserts the session id instead.

**0.7.5 passes the whole six-item run on the same Desktop.** After uninstalling
0.7.4 and installing 0.7.5 through the panel, the boot log reads

```
dsh-wsl-workspace: persistent shell: relay interpreter is D:\…\resources\runtime\primary-runtime\dependencies\node\bin\node.exe — node 24.21.0 from the runtime payload named in argv ("D:\…\resources\runtime\primary-runtime")
```

and the session reports, in order: `compat.txt` written with the file tool and
read back as `COMPAT_3381_OK`; bash returning
`6.18.33.2-microsoft-standard-WSL2`, `/home/mille/fx-3381`, `mille`; a second
independent `pwd` still returning `/tmp`; `bash_background` returning job id
`bash-1` with `job_list` reporting `bash-1 [bash] running`; the skill reporting
`SKILL_TOKEN_3381`. The window header shows `1 个后台任务`. After a window reload
the workspace row was still in the sidebar and opened again, with the WSL preset
and a live composer.

**Independent checks.** `wsl.exe … cat` on the Linux side: `compat.txt` 14 bytes
`COMPAT_3381_OK`, `bg.txt` 11 bytes `BG_3381_OK`. The help panel renders `v0.7.5`
with eleven chips.

**What this adds over the binary-level simulation.** The simulation proved the
failing mechanism (Electron + ConPTY → zero bytes) and the resolution; the real
run proves the rest of the path a user actually takes — the Desktop's plugin
manager (install, enable, uninstall), the host booting with the resolved
interpreter, preset generation, the PTY backend, the jobs registry, the client
panel and a window reload — and it is where the `bash_background` owner bug
surfaced, which no interpreter-level simulation would have found.

**Cost and cleanliness.** The Desktop ran against a scratch `DSH_HOME` and a
scratch Electron `--user-data-dir`; the window was closed and the processes
stopped after the run. The app's own updater reported
`Update for version 0.2.0-rc.2 is not available`, so nothing was downloaded. The
plugin was installed as a `link:` dependency on the unpacked tarball, so the
Desktop profile holds no copy of the published artifact.

**The payload path is not a guess, and the fallback chain was exercised too.**
Renaming `resources/runtime/primary-runtime` away made the Desktop itself die at
boot with

```
DesktopHostFatalError: ENOENT: no such file or directory, stat 'D:\…\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
```

— the shell stats that exact file before starting its host, which is why the
resolver's first candidate is the one file the Desktop itself requires. In that
state the plugin's resolution still ran (the host had started) and fell through to
the next candidate:

```
dsh-wsl-workspace: persistent shell: relay interpreter is C:\nvm4w\nodejs\node.exe — node 24.13.1 from "node.exe" on PATH
```

so the PATH arm is real as well. With the payload restored the log returns to the
bundled node and the app boots clean. (Launching with a `PATH` that contains no
node at all did not reach the plugin — the Desktop failed to start its host first —
so the last-resort branch is covered by `tests/relay-node.test.mjs` rather than by
this machine.)

## The jobs registry's owner contract, and the pre-release pass that caught it (2026-09-30, plugin 0.7.5)

The pre-release acceptance pass — the runbook's six items plus the `bash_background`
path, one isolated instance per declared release — found a **compatibility defect
introduced by this release's own fix**, before it shipped.

**The contract.** `ctx.jobs.start()` takes an `owner`, and what that owner *is*
changed at `0.1.7-rc.1`:

- `0.1.0-rc.7` … `0.1.5-rc.2`: the **agent object**. The registry checks
  `agents.get(owner.id) !== owner` and reads `owner.ctx` for scope cleanup.
- `0.1.7-rc.1` and later: the **session id**, resolved with `agents.get(id)`.

The host's own producers moved at the same boundary — `owner: parent` in
`dsh-tool-subagent` before, `owner: parent.id` after — which is what makes the split
the plugin's business rather than a host quirk.

**What the plugin did.** 0.7.4 passed the agent object, so on `0.1.7`+ every
`bash_background` call failed with `session "[object Object]" has no live agent` (the
second error in issue #40). The first version of the 0.7.5 fix passed the session id,
which repaired those three releases and broke the other eight with
`Cannot read properties of undefined (reading 'Symbol(dsh.scope)')`. Both mistakes
fail loudly; neither is silent, which is why the acceptance pass could see them.

**The fix.** `ownerOf()` in `src/host/wsl-jobs.ts` picks the shape from the registry:
`typeof jobs.resolveOwner === 'function'` is present exactly on the releases that take
a session id — measured on all eleven declared releases (`resolveOwner` absent on the
eight through `0.1.5-rc.2`; present on `0.1.7-rc.1`, `0.1.7-rc.2` and `0.2.0-rc.2`).
`tests/wsl-jobs.test.ts` pins both contracts plus the no-agent case, and the typecheck
baseline did not move.

**The acceptance run, all eleven releases.** Each on its own `dsh web` instance with
the packed `0.7.5` tarball, asked to start a background job, poll `job_list` until it
settled, and read back the file it wrote:

| Release | Owner contract | Job id | Final state | Output file | `has no live agent` | `Symbol(dsh.scope)` |
|---|---|---|---|---|---|---|
| `0.1.0-rc.7` | agent | `bash-1` | completed | `BG_3382_OK` | no | no |
| `0.1.0-rc.8` | agent | `bash-1` | completed | `BG_3383_OK` | no | no |
| `0.1.1-rc.1` | agent | `bash-1` | completed | `BG_3384_OK` | no | no |
| `0.1.1-rc.2` | agent | `bash-1` | completed | `BG_3385_OK` | no | no |
| `0.1.2-rc.1` | agent | `bash-1` | completed | `BG_3386_OK` | no | no |
| `0.1.3-alpha.2` | agent | `bash-1` | completed | `BG_3387_OK` | no | no |
| `0.1.5-rc.1` | agent | `bash-1` | completed | `BG_3388_OK` | no | no |
| `0.1.5-rc.2` | agent | `bash-1` | completed | `BG_3389_OK` | no | no |
| `0.1.7-rc.1` | session id | `bash-1` | completed | `BG_3390_OK` | no | no |
| `0.1.7-rc.2` | session id | `bash-1` | completed | `BG_3391_OK` | no | no |
| `0.2.0-rc.2` | session id | `bash-1` | completed | `BG_3392_OK` | no | no |

Every job reported exit code 0, and the written file was re-read independently on the
Linux side (`.test-runs/check-bg-files.sh`): eleven `bg.txt`, 11 bytes each, contents
matching their port.

**Real DSH Desktop, final artifact.** `bash_background` went `bash-1` `running` →
`completed`, exit 0, with `bg3.txt` = `BG3_3381_OK` re-read on the Linux side; a window
reload still reopened the workspace with its WSL preset; the help panel renders
`v0.7.5` with eleven chips, the 0.7.5 news block, and the repository's new location.

**A gate caught a gate.** The new `tests/readme-compat.test.mjs` failed inside the
harness: a prepared case copies the plugin's sources but not its prose, so the
README-parity cases had no READMEs to read. The copy list in
`scripts/compatibility/Prepare-Case.ps1` and `.test-runs/harness.mjs` now carries the
two full READMEs, and the test skips with a named reason in a copy that has none
instead of reporting a missing file as a documentation defect.

## Issue #47: a profile that cannot lend the generator its modules (2026-10-01, plugin 0.7.6)

**The claim, and who measured it.** A reporter running DSH Desktop 0.2.0-rc.2 on
Windows found that no `wsl-*` variant exists at all: the add-workspace dialog answers
that it found no healthy preset, sessions bound to a `\\wsl$\…` workspace stay on the
Windows tools, and four leftover directories of the retired mechanism outlived every
boot. Their own report states plainly that its two most load-bearing sentences are
reconstructions from code paths and filesystem residue, not captured host output, and
that the check which would settle it is one grep against the host console.

**What this machine could settle.** Not the host *process* — see the limits below. What it
did settle is the deployment shape, and it turned out to be sitting on this machine all
along: `AppData\Local\Programs\DeepSeek Harness` is a real DSH Desktop install, and its own
profile at `.dsh\profiles\desktop` declares `dsh-wsl-workspace@0.7.5` under
`nodeLinker: hoisted` with `autoInstallPeers: false`, while that profile's `node_modules`
carries no `js-yaml` for the plugin and no `cordis-plugin-include` anywhere. Asking the ESM
loader, from the *installed* `lib/index.js`, what the two borrowed specifiers resolve to
answered `ERR_MODULE_NOT_FOUND` for both — and for `@deepseek-ai/schemastery` too, which the
running host plainly does provide by some route of its own. That last answer is why this
section does not claim the host process was reproduced: a bare Node walk cannot see what the
packaged host resolves by a route this section first guessed at and later retracted (see the
retraction below: the report's own profile listing shows the host scope as ordinary files on
the walk-up, so no injected channel is needed to explain it). The arms emulate the *shortage*
the report measured, not the host's resolver. (An earlier draft of this section said there is no DSH Desktop on this machine.
That was wrong, found by looking; the limit is narrower than that and is stated below.)

**Both legs, in a temp dir, laid out by the real installer.** Two profile trees were built
under the temp dir with this profile's own settings (`nodeLinker: hoisted`,
`autoInstallPeers: false`) and a manifest declaring the host scope plus the sibling package
the report names — `dsh-config-manager@0.1.68`, whose own dependency hoists `js-yaml` 5.4.2 —
then each was booted through the plugin's real `apply()` with a roster face:

| leg | pnpm installed | layout it chose | result |
| --- | --- | --- | --- |
| A | `dsh-wsl-workspace@0.7.5` from the registry | root `js-yaml` 5.4.2, nothing under the plugin, no include package anywhere | zero variants, the stale directory survived, and the one line the frame wrote was the failure naming the include package |
| B | the tarball of this build | root still 5.4.2, **4.3.2 nested under the plugin** | `WSL preset variants: 2/2 registered`, stale swept, the `!!js` row still an expression node, zero failure lines |

The first run of this pair reported leg B as failing. That was this harness's bug, not the
product's: it counted Node's own `DEP0190` shell warning as "the frame said something", ended
the wait early, and deleted the tree while the fire-and-forget generation was still running,
so the ENOENT it then saw was its own. After filtering to the plugin's own lines and waiting
for the frame to finish, both legs read as above. The scratch trees and the scripts were
removed afterwards; the machine's own `.dsh` was only ever read.

The shape was established with real packages before either tree existed:

- the registry offers `js-yaml` `latest` = 5.4.2 and keeps 4.3.2 under `v4-legacy`, the
  line the umbrella hoists; both are installed side by side on purpose
  (`ci/deps` and `ci/deps-conflict`, the second never linked into the repo root).
- a schema built against 4.3.2 and loaded through 5.4.2 fails inside the loader, on a
  message that names neither package nor version nor path. Measured directly with the
  two real releases, not inferred from the report.
- 5.4.2 exposes no `Type`; the dialect this plugin needs is built from that class. So an
  API-shape probe is not a guard: the load still dies with the schema built by the other
  major. That is why the fix probes by *parsing one document* rather than by inspecting
  exports.

**The apparatus.** `tests/host-profile-isolation.mjs` (`npm run test:profile`) builds a
profile-shaped tree per arm under the temp dir and boots each arm's own copy of the
plugin against a roster face. Two properties had to be learned by going red first, and
both are recorded in the file: the plugin copy must never be a link (the loader resolves
through links to their targets, which silently dissolves the hostility), and containment
cannot be read off a resolved path on Windows (both loaders dereference a junction), so
the file performs the ancestor walk Node performs and cross-checks it against the
loader's own answer.

**Frames.**

| frame | where | reading |
| --- | --- | --- |
| before the fix, at `2f913e9` | win32 maintainer machine, node v24.21.0 | 60 ok / 8 not ok, exit 1 |
| before the fix, at `2f913e9` | CI run 36864563398 (ubuntu, `workflow_dispatch`) | the same 8 named, exit 1; the same run shows the conflict copy materialising there too |
| after the fix, at `a14ae1c` | win32 maintainer machine | 68 ok / 0 not ok, exit 0 |
| after the fix | `npm run test:node`, `test:unit`, `scripts/typecheck-gate.mjs`, `npm run test:docs` | all exit 0 (typecheck at its recorded count, 212; docs 11/11) |
| after the fix | CI run 36867538094 (`checks`, head `430c259`) | success on all three jobs, `test:profile` included on a second machine shape (symlinks, not junctions) |
| after the fix | CI run 36867543543 (`compat-window`, head `430c259`) | all three window releases `PASS compatible`, each booting with `WSL preset variants: 4/4 registered` asserted from the real host's own log |
| published 0.7.5 in a real installer tree | win32, pnpm hoisted, `autoInstallPeers: false`, sibling `dsh-config-manager@0.1.68` | zero variants; the host-console line is the include package being unreachable from the installed `lib/index.js` |
| this build in the same installer shape | win32, same settings, tarball from `npm pack` | nested engine copy at 4.3.2 under the plugin, loader inside the install answers that copy, `WSL preset variants: 2/2 registered`, the `!!js` row still an expression node |

The eight reds decompose into the two defects plus the amplifier: three arms are the
missing loaned schema, the hoisted wrong engine major, and both together; two are the
all-or-nothing shape (one unreadable source removing the others, and the retired
directory sweep never running); three are the repair-side arms (the plugin standing on a
copy that is not its own, and a failure that names nothing). The control arm, the
dialect-equivalence control against the pinned Host schema, and the activation probe over
every provider path the declarations name were green on the *same* frame as the reds,
which is what lets those reds mean the product.

**The apparatus was shown to bite.** Three rehearsals, each reverted and each verified by
hash (`lib/index.js` returned to the byte-for-byte output of a rebuild, sha 4848ebd2…):
putting the borrowed schema back reddens the two arms that need it absent; deleting the
declared dependency reddens the three arms that depend on the plugin's own copy;
rethrowing from the per-source catch reddens exactly the two fault-tolerance arms and
leaves the dependency arms green. Each red set is a different set, so no two of these
defects are being reported as one.

**A gate caught this change, and the change was wrong first.** The first green of
`npm run test:node` did not happen: `tests/host-materialize.mjs` pins that a vanished
source leaves the previous complete variant untouched, and it had been satisfied by
accident — the abort skipped the sweep. Making the sweep run, which is what the report
asked for, deleted the user's working variant. The sweep now honours a failed variant's
previous publication as well, the contract stays, and the accident it depended on is
gone.

**The installer act, measured rather than assumed.** The frame that decides whether this
fix works on a real profile is not a tree this repository builds — it is the layout an
installer chooses. So it was run for real: a temp project with `nodeLinker: hoisted` and
`autoInstallPeers: false` (the deployment in the report's environment table), the sibling
package `dsh-config-manager@0.1.68` that hoists `js-yaml` 5.x, and the plugin twice — once
as the **published 0.7.5** from the registry, once as a tarball from `npm pack` of this
build. Nothing about the tree was hand-shaped; pnpm laid it out.

- published 0.7.5: no engine copy under the plugin at all, the profile root hoisting 5.4.2,
  and generation registering **zero** variants — the failure arrives as the borrowed
  include package being unreachable from the installed `lib/index.js`, i.e. the report's
  defect #1 as the first thing the real installer produces.
- this build: pnpm nests 4.3.2 under the plugin's own `node_modules` while the profile root
  keeps the sibling's 5.4.2; `import.meta.resolve('js-yaml')` answered from *inside* the
  installed plugin returns the nested 4.3.2, that namespace really carries the 4.x `Type`
  export, and generation completes (`2/2`) with the `!!js` row surviving as an expression
  node. That is the exact conflict the report describes, resolved by the manifest rather
  than by luck.

Replay: build a temp dir with that `pnpm-workspace.yaml` and a manifest depending on
`dsh-config-manager@0.1.68`, `@deepseek-ai/schemastery@3.18.4` and the plugin (either
`0.7.5` or `file:<npm pack output>`), `pnpm install`, then boot the installed
`lib/index.js` against a roster face exposing `register`/`readDocument`. The scratch trees
and their homes were removed after both readings.

**Confirmed on the reporter's own machine, three days later.** In his `#47` follow-up of
2026-10-03 he listed `profiles/desktop/node_modules/dsh-wsl-workspace/node_modules/` on a real
DSH Desktop 0.2.0-rc.2 profile after dropping his manual workaround and installing this build as
a local tarball: `js-yaml → 4.3.2` present, `cordis-plugin-include` absent — the same layout our
temp installer leg produced, now read off a deployment we do not control. His four-consumer probe
also shows the nesting is per-package rather than global (`dsh-config-manager` still resolves
5.4.2 from its own nested copy), and he measured the WSL execution path end-to-end: the relay run
with cwd `\\wsl$\archlinux\root` reported `user=root`, `pwd=/root` and the WSL2 kernel with exit
0, and a Windows-side write through the UNC share read back identical inside the distribution and
vice versa. What his frame does **not** contain is a dialog-level reading taken against this
branch — his 2026-10-01 confirmation that the picker showed `wsl-*` presets was of the manual
workaround, and the declaration channel writes no directories, so a count of entries under
`~/.dsh/.agent-presets/` is not evidence either way. That one leg still waits for a published
0.7.6 (registry `latest` was 0.7.5 as of 2026-10-03, verified with `npm view`) or for a maintainer
to boot the packaged host.

**Two things he corrected in us, both kept rather than quietly fixed.**

- Our reply text told him to `dsh plugin --profile desktop add <clone directory>`. On Desktop that
  produces a `link:` whose realpath is wherever the clone sits, so nothing on that walk-up — not
  even a host package — resolves, and the plugin fails at module load: a worse shape than the
  defect being tested. Our own `scripts/verify-dsh-compat.sh:82-85` already documents this staging
  requirement, and `TESTING.md` now says it out loud.
- `8bbd2f2`'s message offered `git log --all -S host-profile-isolation` as evidence that an
  uncommitted coverage matrix had never reached a commit. That query is about the test file, not the
  matrix, and it returns 2 hits here (`2f913e9`, `430c259`). The on-topic queries are
  `git log --all -S N34` and `-S "⑤ evidence"` — and those were 0 only until **this very commit put
  the strings `N34` and `⑤ evidence` into the repository**, after which they each return 1: itself.
  Asking the same question with markers this section never quotes gives the durable answer:
  `-S "⑦ evidence"`, `-S "unmet \`N35\`"` and `-S "same as \`smoke.ts\`"` are all 0, and
  `git grep ⑦ e11a36b -- TESTING.md docs/CHECK-CATALOG.md` finds nothing either. So the claim
  survives; both stated proofs before this line were defective — first the wrong target, then a
  self-polluted query. **Method note, kept because it generalises: a `git log -S` claim stops being
  evidence as soon as the commit making it writes the searched string into the tree.**

**What remains unverified, stated as limits.** The installer act above is measured for
pnpm's hoisted linker with the reporter's own settings on this machine, on this machine's own
Desktop profile shape; what still has no reading is the **packaged host process**. A real DSH
Desktop install exists here (`AppData\Local\Programs\DeepSeek Harness`, plugin installed at
`.dsh\profiles\desktop`) and was read, never launched — starting it means a GUI process, the
self-updater, and a window on a machine its owner is using, so that leg waits for a nod. Until
someone boots that process with this build, the claim is "the shortage the report measured is
reproduced and repaired in profile-shaped trees laid out by the real installer", not "the
Desktop dialog was seen to work". One reading this section first drew was wrong and is
retracted here: the probe could not resolve even `@deepseek-ai/schemastery` from this
machine's installed copy, and that was taken as evidence the packaged host injects a
resolution channel. It is not — the report's own listing shows `@deepseek-ai/cosmokit` and
`schemastery` sitting **inside** `profiles/desktop/node_modules`, so on a profile like his the
host packages are ordinary files on the walk-up and nothing mysterious is needed. This
machine's profile is the different one (its host runs out of the archive), which is why the
same probe found nothing to resolve. What the reporter's listing does show, alongside the
hoisted scope, is the absence of `cordis-plugin-include` and a hoisted `js-yaml` 5.x — the
exact two shortages the arms and the installer legs reproduce, and the reason the nested copy
under the plugin wins the walk-up rather than competing with an injected path.
The reporter's host-console line has not been read by anyone here, and it turns out **he
cannot read it either**: on a healthy DSH Desktop boot nothing the host logs is persisted —
the install's log directory holds crash bundles only, which embed a child's stderr solely
when that child exited non-zero and capture only *renderer* console output. A main-process
`console.error` has no sink. So the decisive check his report nominated is a maintainer-side
one, and the reply drafted for #47 asks him for the observable instead: whether the dialog
lists the variants.
`@deepseek-ai/schemastery` is still a peer the plugin imports statically at module load:
the installer tree above had to be given it explicitly, which is exactly how a real profile
differs from this analog, and the activation probe covers that shape only inside the trees
it builds. The compatibility matrix's real-host job now asserts the outcome count line
rather than only route liveness — measured for the window releases in CI run 36867543543 —
and it stays structurally the positive control for the peer question, never the
reproduction, because its staging puts the plugin where a walk-up can find the host's
packages.

**How #47 was closed (2026-10-03), and what that does and does not cover.** The reporter closed
it himself after his fourth verification pass, whose substance we re-checked where we could:
his real Desktop profile shows the engine nested under the plugin (`js-yaml → 4.3.2`) with the
borrowed include package still absent, his relay run inside `\\wsl$\archlinux\root` returned
`user=root` / `pwd=/root` / WSL2 kernel with exit 0, and UNC↔`/mnt` round-trips matched. The
user-level statement behind closure is "the plugin links into WSL normally now".

What closure therefore rests on: the **defect's mechanism** (both shortages), the **repair's
mechanism** (installer nesting, per-source fault tolerance, a self-describing failure), and the
**execution path's parts** — each measured, most of them twice, once on a machine we do not
control. What it does not rest on: a reading of the picker on this build. The dialog question
he answered in his 2026-10-01 comment belonged to his manual workaround, and the declaration
channel writes no directories, so an empty `~/.dsh/.agent-presets/` says nothing either way —
that count must not be cited as evidence again.

Three things survive the closure, each with a stated verdict rather than silence:

1. **Republish-and-retest by name.** `0.7.6` is not on the registry (verified 2026-10-03:
   `latest` = 0.7.5), so every real-machine reading so far is of a local tarball. Once published,
   the reporter's own by-name install closes the picker leg from the outside; a maintainer booting
   the packaged host closes it from the inside.
2. **A Desktop failure currently has nowhere to be written.** Nothing the host logs is persisted
   on a healthy Desktop boot, so "look at the log" is not an option on that platform and the GUI
   is the only channel. Filed separately because it changes `describeSelf`'s shape and the client
   locale strings, which the documentation-parity gate governs.
3. Small, but it bit a contributor: `dsh plugin add <directory>` on Desktop links, and a link out
   of a package-carrying tree makes the plugin fail to load at all — worse-looking than the defect.
   `TESTING.md` now states the precondition where the Desktop pass meets it.

## Issue #51: a Desktop 0.2.x workspace where every `bash` call failed (2026-10-04, plugin 0.7.6)

**What the reporter saw.** DSH Desktop 0.2.0-rc.2, workspace `\wsl.localhost\Ubuntu\home`,
plugin 0.7.5: every `bash` call returns `Error: PTY shell exited during startup`, while the file
tools work. Their report lists four independent incompatibilities and asks for host-side help on
two of them. The report is attached to the issue, so this section records what could be measured
here and what could not.

**Proven from this tree, and fixed here (point 4 of four).** `@deepseek-ai/dsh-shell@0.2.0-rc.2`
declares the seam as `abstract resolve` + `abstract execute(spec): Promise<ShellExecution>`
(`lib/types/index.d.ts:61,69`), and the host's `@deepseek-ai/dsh-tool-bash` calls
`await (await ctx.shell.execute(ctx.shell.resolve(request))).result()`. `WslShellExecutor`
implemented `resolve`/`run`/`start` — the 0.1.x contract — and did not implement `execute`.
The compiler has been saying so in these words:

```
src/shell.ts(157,14): error TS2515: Non-abstract class 'WslShellExecutor' does not implement
  inherited abstract member execute from class 'ShellExecutor'.
```

read from `tsc --noEmit` on 2026-10-04, together with two sibling gaps of the same family
(`onExpiry` missing on the spec at `:202`, `observed` missing on the handle at `:410`). The
count-only budget hid all three: the gate compares the number of `error TS` lines with
`ci/typecheck-baseline.json`, and the tree reported **212 of 212** — the budget met exactly.
Because `src/host/variants.ts` mounts that same host tool whenever there is no persistent shell,
the fallback leg was broken too, which is why the reporter's workaround had to patch both files.
The fix is one primitive (`spawnExecution`) with three faces on it, plus
`tests/shell-execute-shape.mjs`, plus a `banned` code list in the same baseline — see
[CHECK-CATALOG.md](CHECK-CATALOG.md) for the controls run against it.

**Proven from this tree, and fixed here (a cause the report did not name).** When
`resolveRelayNode()` finds no real node it returns `fallback: true`, whose `source` states in its
own words that "a PTY child started from it produces no output" — and 0.7.5/0.7.6 mounted the PTY
world anyway after a `console.warn`. Measured in issue #40's table (this file, above): the Electron
binary under a real ConPTY writes **0 bytes** and exits 0, which is exactly
`waitReason === 'session_exit'` in `LocalPtySession.initialize()` — the reporter's literal error
message, reachable without any UNC path involved. The decision is now
`persistentShellAllowed(probe, relay)` in `src/shared/relay-node.ts`, and a fallback answer demotes
the world to the one-shot `bash` instead of shipping a terminal that cannot start.

**Not reproduced, and therefore not fixed here (point 1).** "node.exe crashes instantly when
started with a `\wsl.localhost\…` cwd" contradicts two first-hand readings already in this
repository: the interpreter table directly above, run on this machine with the same payload node
the reporter names (24.21.0) under a real ConPTY at cwd `\wsl.localhost\Ubuntu\home\mille`,
produced 170 bytes and a live prompt; and the retraction recorded in
[CHECK-CATALOG.md](CHECK-CATALOG.md), where 20/20 spawns with a UNC cwd succeeded once the shell
stopped eating an escaping layer. Both readings are of *spawn*, not of node's own nearest
`package.json` walk, so they do not refute the mechanism — but the failing read in their error text
is `\?\UNC\wsl.localhost\package.json`, which is the 9P root, and `connection reset by peer` there
is the signature this file already documents for an idle distro whose share has vanished. Two
differences between their workspace and every green run recorded here are candidates and neither
can be settled without a live measurement: `/home` versus a user home (the walk stops at the first
ancestor carrying a `package.json`), and a cold share versus a held-open one.

**Not settled, and the report's own mechanism has a hole in it (points 2 and 3).** Point 2 is true
as a fact about the host: `childEnvironment()` injects `PS1`/`PROMPT_COMMAND` as *Windows*
environment variables, and nothing in this plugin puts them in `WSLENV` — grep finds the two names
only inside `scripts/compatibility/conpty-relay.mjs:62-63`, hand-copied. This file even records the
consequence without naming it: the green run's captured prompt was `mille@mikao:~$`, the
distribution default, not `dsh> `. What is not settled is the cost, because the host has an idle
fallback (`pollReadiness`, `inferred_idle`, `idleSilenceMs` default 3000) that should complete a
command at a latency penalty rather than hang. Point 3's hang cannot be explained by the predicate
the report cites: `foreground?.processGroupId === this.shellPgid` compares `undefined` with
`undefined` when the inspection returns nothing, which is *true*, and an inspection that throws
routes to `failActive` — an error, not 300 seconds. `@deepseek-ai/dsh-win32-process` is not vendored
in this repository, so `inspectForeground()`'s real shape can only be measured on a Desktop install;
and the 300 s was measured on the report's own hand-edited `shellPath = wsl.exe` topology, not on
the shipped `node → wsl-relay → wsl.exe` one.

**Not implementable as written (their suggested remedy 4).** `dsh.compatibility.blocklist` does not
exist: the string appears zero times outside `node_modules` in this tree and zero times in any
vendored host file, and no vendored `@deepseek-ai` module reads `dshReleases` at all — the reading
lives in `dsh-plugin-manager`, which is not vendored. So whether an unlisted release fails open or
closed cannot be answered from here, and the honest interim change to the declaration is a decision
for the maintainer, not an invention of a key.

### The #51 matrix, run on this machine (2026-10-04, plugin 0.7.6 at `14c444d`)

Harness, stated first because two of the readings depend on it: Windows 10.0.19045,
WSL 3.0.1.0 / kernel 6.18.40.1, distro Ubuntu (default user `ruler` from `/etc/wsl.conf`),
the reporter's **own payload executable** (`…/primary-runtime/dependencies/node/bin/node.exe`,
`v24.21.0`), and the **real** terminal seam — `@deepseek-ai/dsh-subprocess-local@0.2.0-rc.2`
over `dsh-win32-process@0.2.0-rc.2` and `node-pty@1.2.0-beta.15`, all three at the versions the
0.2.0-rc.2 host declares. Driver scripts live outside the repository (`D:/Temp/issue51-matrix/`).
Two writes landed inside the distribution and are stated rather than glossed: the fixture
directories under `/home/ruler/` that these runs created and removed again, and `/home/ruler/.bash_history`,
which the interactive probe shells appended to (last entries `echo T3_MARKER`, `echo T5_MARKER`,
mtime 2026-10-04 10:26) — the user's own history file was not otherwise modified, and removing
those lines is left as an offer rather than done unasked. Both distros were left `Stopped`, which is
how they were found.

**Point 1 — node.exe with a UNC cwd does not crash here, cold or warm.** Five cwd cells
(`\wsl.localhost\Ubuntu`, `\home`, `\home\ruler`, and two depths under a fixture tree, one with a
`package.json` at the parent and one without) × two states (distro freshly `--terminate`d, and
running): `--version` exits **0 in 117–167 ms warm, 1251–186 ms cold** in every cell, printing
`v24.21.0`. The `package.json`-walk hypothesis is refuted as a *necessary* condition — the deep
cell without any ancestor `package.json` boots fine, so reaching for `\?\UNC\wsl.localhost\package.json`
is not by itself fatal on this kernel. What the reporter saw is still a real signature
(`connection reset by peer` on a 9P read); it is just not a property of node-with-a-UNC-cwd, and
this machine cannot produce it. **Not fixed, because there is nothing here to fix**, and the
claim is narrowed rather than dismissed: their error names the provider root, which is where a
share that has vanished answers from.

**Point 2 — the contract really does not cross, and it is fixable on the plugin side.** The
shipped relay under a real ConPTY at the reporter's exact cwd (`\wsl.localhost\Ubuntu\home`)
starts, stays up, and reaches a prompt — but the prompt is the **distribution default**:
`OSC 133;D` absent, `dsh> ` absent, over 1591 bytes. Naming the two keys in `WSLENV` — one
environment line in the relay, `src/shared/wsl-env.ts` — flips both readings to present on the
same wire with nothing else changed. One nuance the report did not have: `PS1` itself does not
survive the crossing (an interactive `bash` assigns its own), and that does not matter, because
the host's `PROMPT_COMMAND` text re-assigns `PS1` at every prompt. So the bridge needs the
marker variable, and the profile chain the relay runs (`bash -lc`) does not undo it.
This is what `scripts/compatibility/conpty-relay.mjs` now asserts. Its previous assertion was
`/[$#]\s*$/` against an injected `'DSH> '` — uppercase, so it could never have matched the host's
lowercase prompt, and a distribution default ending in `$ ` satisfied it anyway. The gate that
was supposed to cover this stage was constructed to pass without the contract.

**Point 3 — the mechanism the report names cannot be what fails here.** `inspectForeground()`
was polled six times per topology, 800 ms apart, through the real seam: the shipped topology
(node → relay → `wsl.exe`) and the report's own topology (`wsl.exe` + an in-distro rcfile) both
returned the **same** `{processGroupId: 0, inputWaiting: false}` at every poll, wire quiet
between polls — no churn, no `undefined`, no throw. `processGroupId === shellPgid` is therefore
`0 === 0`, which is *true*: on this machine the foreground leg of the strict predicate is
satisfied trivially, and cannot explain a 300 s wait. Note `pid` is `0` for every PTY this host
build spawns — `cmd.exe` included, measured through raw `node-pty` as well as the seam — so a
zero-valued answer is this platform's norm, not a WSL blind spot. What is also true is that the
rcfile topology does produce marker + literal prompt, so their contract was satisfied and the
settle failure lives in whatever the host build they run reports; that half cannot be measured
from a repository that does not vendor `dsh-win32-process`'s Desktop copy, and was left open at the
time of writing. It is no longer open: the term that fails here is the host's post-marker prompt
window, and a native Windows bash with no WSL in the picture hits it identically — see
"Point 3's failing term, pinned" at the end of this section.

**Attempting to *produce* the crash, not just to fail to reproduce it (M1-teardown, 2026-10-04).**
Refuting a universal claim and explaining a particular reading are different jobs, so the next step
was to give node.exe the same UNC cwd while the 9P channel was genuinely being taken away:
`wsl --shutdown`, then boot `--version` at `\wsl.localhost\Ubuntu\home` six times through the
teardown window, then poll until the share reads as gone, then boot again. Positive control first —
warm, share readable, `exit 0 in 203 ms` — because a run whose control crashes proves nothing either
way. Result: **the reporter's `Cannot read package config … connection reset by peer` appeared in 0
of 8 cells.** Two readings out of it matter more than the zero:

- The first post-`--shutdown` attempt returned **exit 0 in 4078 ms**. That number is the distro
  auto-starting underneath the access. So on this build (WSL 3.0.1.0 / kernel 6.18.40.1) a share
  that has gone away does not answer with a refused read — it answers by coming back.
- Consequently my own earlier explanation — "their error is the signature of an idled-out share" —
  is **not supported here and is withdrawn as an account of their reading**. The poll loop never
  observed the vanished state at all (`readable=true` through 10 polls), which means that state is
  not reachable by shutdown-racing on this machine, not that it does not exist on theirs.

What is left standing is narrower than either story: point 1 is a real failure on the reporter's
host that this machine cannot enter through the path they describe, and the discriminating fact is
now their WSL build rather than our reasoning. `docs/compatibility-evidence.md` above keeps the
cold/warm matrix as the refutation of the universal claim; this paragraph is the record that the
refutation was not mistaken for an explanation. Machine state was restored after the run
(`--terminate`, then `--shutdown` when `vmmem` held 605 MB past both distros reporting `Stopped`;
both `Stopped` and no `vmmem` afterwards, matching the pre-run baseline).

### The 267 that was mine, not the platform's (m1c/m1d, 2026-10-04)

After M1-teardown, one ConPTY-gate run failed with `the interpreter wrote nothing to the ConPTY (exit {"exitCode":267} after 1580ms)` while the distro was stopped, and I read that as the production differential: node-pty (what the backend actually uses) failing at a UNC cwd where plain `child_process.spawn` does not. Two measurements killed that reading inside one turn:

- **m1d** ran the production shape directly — `node-pty` from the pinned tree, the payload `node.exe`, `{UNC home, SystemRoot} × {distro stopped, distro warm}`, with a plain-spawn reading at the same instant. **All four cells: `ok`, exit 0, 154 bytes, ~1.2 s.** There is no cwd-or-state differential in the production spawn shape.
- The gate then **passed (1534 bytes, marker + controlled prompt) when re-run under a stable interpreter**. The 267 was the interpreter path this CLI session was launched through — an `fnm_multishells\<pid>_<ts>\node.exe` directory that fnm had since removed. 267 is `ERROR_DIRECTORY`, and it named the *executable's* directory, not the UNC cwd.
- A third artifact of the same instrument: m1c's `dir \wsl.localhost` column reported the provider root as absent **in every cell, including before the shutdown** — listing the share-list level is not a state signal on this platform, so that column measured nothing and its "8 of 8 cells with the root absent" line in the log is noise. The m1c run's real output is only the negative: 8 cells, node exits 0 at the UNC cwd in all of them.

This is recorded rather than quietly dropped, because it is the same mistake the gate in `conpty-relay.mjs` was built to make: a failing instrument that produces a plausible mechanism. The M1-teardown conclusion above stands — the reporter's crash text was not produced in any cell here — and the attribution now has one fewer candidate explanation, since "share state breaks the PTY spawn shape" is refuted for the four states measured.

### Point 1, re-opened: their error text IS reachable here — as a read, not as a crash (2026-10-04, later the same day)

The paragraph above saying the reporter's crash was "not produced" was reached with an instrument that
could not see the window it was about, so it is narrowed here. M1 and M1-teardown each *started a
process* at a UNC cwd, and starting a process through the share revives the distro — every cell
therefore measured a live provider and came back `exit 0`. Reading the path first, without spawning,
shows the other face:

| state | read `\?\UNC\wsl.localhost\package.json` | node `--version` @ `\wsl.localhost\Ubuntu\home` |
| --- | --- | --- |
| instance terminated, provider still advertising (first read) | **ECONNRESET: connection reset by peer** | (not attempted before the read) |
| instance running | ENOENT at `…\Ubuntu\package.json`, UNKNOWN/ECONNRESET at the provider root, varying by cycle | **boots, exit 0**, 3 of 3 cycles |
| after `--shutdown` | UNKNOWN | `spawn … ENOENT` |

So the reporter's words — `Cannot read package config \?\UNC\wsl.localhost\package.json:
connection reset by peer` — name a state this machine does enter: the provider root answers
`ECONNRESET` rather than "no such file", which is the one answer that turns node's nearest
`package.json` walk from "keep walking" into a thrown error. What is **still** not produced is node's
own crash stack in that state, and the reason is now concrete rather than absence of evidence: the
two conditions the crash needs are mutually exclusive in every state reachable here. When the
provider is up, the walk stops at the share root and node boots (3/3). When the provider is
half-gone, the read answers `ECONNRESET` but a UNC-cwd process does not start at all — the failure
arrives one level early as a spawn `ENOENT` naming the executable, which is the same misleading
shape already recorded for `relay-real`. Their log shows a node process that got far enough to read
a package config, so their provider was in a third state: advertising a browsable share and resetting
mid-walk. That is a race, and it is not a state this machine enters on command.

One further measurement cut the other way and is worth keeping: `pathcheck` saw the UNC-cwd spawn
fail with `ENOENT` in the terminated state *after* reading the provider root, while `probe-live2`
started the shipped relay at the same workspace UNC in the same terminated state and reached the
controlled prompt in 1172 ms. The order of the first touch therefore decides the outcome, which is
consistent with a transient provider state and inconsistent with any standing property of
"node + UNC cwd". Consequence for the product: point 1 stays unreproduced as a *mechanism*, and the
mount decision now verifies the shape it would actually fail on — see the cwd row for
`src/host/pty-readiness.ts` in [CHECK-CATALOG.md](CHECK-CATALOG.md).

### Point 3's failing term, pinned: the 6-character prompt window (2026-10-04)

The paragraph that left point 3 open did so because the foreground leg measured innocent and the
300 s could not be produced. Both remaining unknowns are now settled by three runs on this machine,
after WSL came back on its own — it had been refusing a VM with
`Wsl/Service/CreateInstance/CreateVm/HCS/ERROR_NO_SYSTEM_RESOURCES`, and no elevated service start
turned out to be needed: the same command returned exit 0 once free physical memory reached
3563 MB of 15195.

**The 2×2 that the earlier disagreement demanded** (`grid.mjs` — one real `BashTerminalBackend`
session per cell, cwd `{\\wsl.localhost\\Ubuntu\\home, SystemRoot}` × instance `{running, terminated,
running}`): **six of six cells identical** — boot 521–4637 ms, `waitReason=inferred_idle` in
3543–3581 ms, `output=true`, `promptSeen=true`, `promptTextSeen=false`, tail `"dsh> \0"`, `pgid=0`.
No cell threw, so the instance state that separated the two earlier baseline runs explains nothing,
and the UNC cwd is neither slower nor crash-prone in any of those numbers — point 1's table above,
restated through the backend instead of through `child_process`.

The uniformity buys the name of the failing term, which is the same in all six: `promptTextSeen`
did not hold in any of them. Two more bounded runs say why.

- `tailbytes.mjs` recorded one raw relay session at the reporter's exact cwd through the same
  `spawnTerminal` face (1627 bytes, two `133;D` markers). After the post-command marker the stream
  reads `]133;D;0 BEL ESC[?2004h TAIL_OK_42 CRLF dsh> ESC[22;6H ESC[?25h` — **the command's own
  output arrives after the marker**, and the prompt line is followed by five padding spaces.
- `replay-tail.mjs` fed that captured stream through the host's shipped `TerminalSanitizer` and the
  shipped `onData` body, sliced out of `dsh-terminal-bash/lib/index.js:82-236` and `:647-659` by
  line span rather than retyped. The window fills with `TAIL_O` and the code takes its own poison
  branch (`:657`: more than 6 characters after a marker rewrites the tail to the controlled prompt
  plus a NUL sentinel), so the comparison at `:658` — tail equal to the prompt — is false by
  construction. The escape that would extend the deadline cannot help either: `:725` grants
  `promptTailGraceMs` only when the prompt *starts with* the current tail, and the sentinel is
  longer than the prompt, so a poisoned tail is disqualified from its own grace.

**This corrects a claim made earlier in this same section.** The window is 6 characters and the
controlled prompt is 5, so a single leftover byte — the newline that ends the command's output —
is fatal, and `promptTextSeen` is therefore a *transient*: it holds only in the interval between
the prompt being drawn and the next printable arriving. One run caught that interval (the C1
reproduction cell: `waitReason=stdin_read` 74 ms after the send, which is `:713` firing while the
boot prompt still stood clean); the nine runs taken since did not, and paid `inferred_idle` at
3.5 s. So the accurate statement is not "the strict leg can never fire" but **"`promptTextSeen` is
not a state a command settles in reliably — which of the two paths `:713` or `:726` answers a
command depends on byte timing we do not control."** Two candidate explanations for the
disagreement were tested and are refuted, recorded so nobody re-runs them:

- *the command's shape decides* — `cmdshape.mjs` sent the grid's short `echo`, then C1's exact
  compound line (`echo …; pwd; whoami; false; echo exit_code=$?`), then the short form again, in
  **one** session: `inferred_idle` 3555 / 3562 / 3584 ms, `promptTextSeen=false` in all three, the
  tail starting `"\ndsh>"` in the last two. Command shape is not it.
- *the byte-chunk boundary decides* — `chunkflip.mjs` fed the identical captured stream through the
  shipped sanitizer at 1, 2, 3, 5, 7, 11, 200, 1024 and whole-buffer sizes: poisoned at **9 of 9**
  sizes. Chunking is not it either.

What is left standing is the ordering fact the raw capture shows: the marker reached the wire
**before** the command's own output, and the earlier C1 run is a wire where that did not happen.
Whether ConPTY emits the OSC passthrough before or after the pending cell output is not something
this repository can influence.


**Whether any of that is ours** — a control cell answers it: same backend, same injected contract,
but the shell is a native Windows bash with no relay, no node in front and no WSL
(`control-local.mjs`, this machine's `bash.exe -i` at `SystemRoot`): boot 4540 ms,
`waitReason=inferred_idle` in 8126 ms, `promptTextSeen=false`, tail `"dsh> \0"`, `pgid=0`. The
identical shape. So a post-marker window filled by output is a property of this host's completion
check running against a Windows pseudo-console — not of `src/host/wsl-relay.ts`, not of `WSLENV`,
not of the distribution; our shipped topology is no worse than the host's own local bash here. One
nuance kept honest: the padding-after-prompt variant was seen in the `TERM=dumb` capture while the
grid and the control ran on the backend's own environment — the poison in all three came from the
output text, so `TERM` is not load-bearing for the conclusion.

Consequences, as what changes and what does not. **Nothing in the plugin moves.** The window size,
`idleSilenceMs` and the tail comparison are host-side (`:49`, `:51`, `:655-658`) and the preset rows
we emit carry none of them, so there is no knob to turn and no fix to land — this is a host ask with
a measurement attached, and it replaces the "left open" clause above rather than adding to it.
`src/host/pty-readiness.ts` is not implicated and stays as shipped: it asserts marker + computed
answer + prompt **on the wire**, which all six cells satisfied, and never claimed the host's internal
predicate passes. It also gains a reason to exist beyond the wire — a shell can satisfy every part of
the contract and still cost 3.5 s per command, and that gap is not a state a boot probe can demote a
world for.

### The host's own `bash` tool, called for real (2026-10-04)

Every reading above stops one level short of the product. The grid drives `BashTerminalBackend`;
`tests/shell-execute-shape.mjs` asserts the shape of the built file against a faked subprocess.
Neither is `dsh-tool-bash` dispatching a call, which is the level point 4 lives at — its foreground
path is `await (await ctx.shell.execute(ctx.shell.resolve({...request, signal}))).result()`
(`dsh-tool-bash/lib/index.js:683`). So a context was built from the real host packages, the plugin
mounted as `ctx.shell`, the real tool registered, and one call made:

```
tool returned in 489ms, kind=foreground
stdout="BASH_TOOL_OK_91\n/home/ruler\nruler\nexit_code=1\n"   stderr=""
```

The computed value came back rather than the echoed command, the UNC session cwd became
`/home/ruler`, the user is the session's, and a deliberately failing command reports its exit code
through the tool. **This is the end-to-end confirmation that point 4 is fixed at the only level that
matters**, and it narrows the "not yet observed inside a real host dispatch" caveat above — with one
limit stated: it is the host's tool dispatch and the host's WSL executor, not the Desktop UI, and it
exercises the **one-shot** path. The persistent path is covered by the grid, not by this call.

The same driver run against a mutant — the shipped `lib/shell.js` with `execute` renamed — fails with
`ctx.shell.execute is not a function` at `:683`, on both planes. That is the 0.7.5 shape reproducing
the reporter's complaint through the host's own code, which is what makes the green above a
measurement rather than a demo. It is now a gate: `scripts/compatibility/tool-bash-real.mjs`, wired
into `ci.yml#wsl-gate` on both planes and into the compat case's `Run-Checks.ps1`, with 10 counted
checks so a short run cannot report green.

One instrument note, recorded because it looked like a product defect for a minute: with an `exec`
whose session had no `id`, the host's `shellEnv.collect()` returned `DSH_SESSION_ID: undefined` and
our `withWslEnv` crashed in `isWindowsPathShaped`. Giving the fixture a session id made it disappear,
so it is **our incomplete stand-in, not the plugin** — a real session always carries an id — and no
production code was changed for it. The lesson is the one already written down twice in this file: a
driver's fixture must match the runtime's shape, or its red is about the driver.

## The hang is a Windows-console-path property; the WSL1 runner does not have it (2026-10-04)

The session-tier gate (`scripts/compatibility/bash-session-real.mjs`) ran on both machines inside
one hour, and the persistent-shell half of its result differs:

| where | the host's PTY tier, one `echo` | our session tier, same command |
| --- | --- | --- |
| this machine: Win10 + WSL2 + Desktop 0.2.x | **timed out** — 303.8 s in the real Desktop session, 8 s when the deadline was shortened | first call 3.9 s including boot, ~30 ms after |
| `ci.yml#wsl-gate`: windows-latest + **WSL1** Ubuntu-24.04 | **answered in 0.52–0.59 s, cleanly** | 11/13 on both planes; the 2 reds are named below |

Two statements come out of that, of different kinds. The product one is unchanged: the failure mode
is real on the desktop path we ship into, and the session tier answers there. The gate one is a
correction of my own overreach — the driver's last cell asserted that the PTY tier *must* hang,
which promoted one machine's pseudo-console behaviour to a universal expectation, and the runner
disproved it in half a second. That cell now asserts only that the control ran, and prints which
outcome it saw; the hang stays where evidence belongs, in this file. The other red was the same
class of mistake in smaller form: `sudo -n true` returns 1 here and **0** on the runner, whose root
is NOPASSWD, so the assertion is now boundedness (`< 8 s`, not timed out), not the exit code.

The mechanism claim the two frames support jointly is narrower and better: the sentinel is corrupted
by **repaint padding on the Windows console path** — which is also why a native Windows bash hits
the sibling predicate (the 6-character prompt window) on this machine, and why a WSL1 instance
behind a different terminal stack hits neither. It is not "WSL is slow" and not "the command is
complex".

And one planning consequence, said plainly: **`ci.yml#wsl-gate` cannot catch this bug.** A green
WSL1 frame establishes that our session protocol works; it establishes nothing about the PTY tier's
hang, because that tier does not hang there. The frames that can see it are this machine and a real
Desktop session — which is why the Desktop reading is still on the list rather than assumed covered.

## The host's plugin loader unwraps `exports.default`, and my driver did not (2026-10-04)

The Desktop E2E pass over the session tier failed, and the product's own transcript
(`~/.dsh/sessions/--wsl.localhost-Ubuntu-home-ruler--/session-b7b8f571-…/session.v4.jsonl.zstd`,
read back with `D:\Temp\issue51-matrix\count-in-transcript.mjs`) says why:

| seq | what the log holds |
| --- | --- |
| 21, 33, 49 | the **PTY** tier still in place: three calls each burned the host's 300 s deadline |
| 73 | `Error: invalid arguments: missing required property "description"` — the model's first call after our tool replaced the PTY one |
| 81, 86, 94 | `Error: cannot get property "subprocess" without inject`, three tool results, 15 mentions of the string across the log |
| 105 onward | the agent gave up on `bash` and pivoted to `bash_background` — 9 `started background job` |

The last two rows answer the question "why did the working directory and the exported variable not
survive": they were never run by the session shell. Every `bash` call errored at the seam, and the
model's workaround was the background-job tool, whose jobs are separate processes — so `export` in
one job cannot be seen by the next. The persistence cells in the driver were green; the calls the
model actually made were not ours.

Row 73 is **not** a defect: the host's own one-shot tool declares `description` required too
(`@deepseek-ai/dsh-tool-bash/lib/index.js:496-499`), so a model omitting it gets the same error from
the tool this plugin replaces. Row 81 is ours.

### The mechanism

`cordis-plugin-loader` normalises a module before mounting it — `unwrapExports` returns
`exports.default ?? exports` (`lib/index.js:663-669`), and `Context.registry.plugin` then reads
`plugin.inject` and `plugin.Config` off whatever it got (`cordis/lib/index.js:1635`). A module whose
default export is a **bare function** therefore arrives with no `inject`: the fiber has no declared
service, the proxy trap refuses the property, and the message is exactly
`cannot get property "subprocess" without inject` (`cordis/lib/index.js:676`). The one-shot executor
never showed this because its default export is a **class** carrying `static inject`
(`src/shell.ts:159,543`), which survives the same unwrap.

So `export const inject = ['subprocess']` in `src/host/wsl-bash-tool.ts` was a declaration nothing
read. The fix is the one this repository already uses everywhere else — resolve the seam with
`ctx.get('subprocess')`, which is documented as the read that bypasses the inject requirement
(`cordis/lib/index.js:756`) — in `wsl-bash-tool.ts`, and the tool now fails with
`this host exposes no subprocess service` if the service genuinely is not there.

### Why 13/13 could coexist with every real call failing

The driver mounted the plugin as `ctx.plugin(moduleObject)`, and cordis does read `inject` off a
module object. The product mounts `moduleObject.default`. Same file, same config, opposite outcome —
the driver was measuring a channel the product does not use. `bash-session-real.mjs` now calls
`ctx.plugin(sessionTool.default ?? sessionTool)`, which is the loader's shape; it went red with the
Desktop message verbatim before the one-line product fix and 13/13 after, on both planes:

| plane | first call | after that | the PTY control, same command |
| --- | --- | --- | --- |
| `src` | 520 ms (session boot included) | 22-34 ms | did **not** answer inside 8 s — `Your command timed out after 8 seconds` |
| `lib` | ~500 ms | ~30 ms | answered in 4256 ms |

The control needed its own correction. `dsh-terminal-bash` builds the PTY child's environment
itself — a fixed set, `TERM`/`PS1`/`PROMPT_COMMAND`/`DSH_SESSION_ID` (`lib/index.js:936-955`) — so
`DSH_WSL_USER` set in the driver's process never reaches the relay, and the shell comes up as the
distribution's default user. Pointed at the driver's own session directory (`…\Ubuntu\root`) it died
with `chdir(/root) Permission denied` and the cell reported "PTY shell exited during startup": a
control that cannot start is the vacuous green this file already names twice. It now starts in
`/tmp`, which every user can enter, and the command being compared does not depend on the directory.
Its two outcomes above, hang here and answer there in the same hour, are why the cell asserts only
that the control ran.

## Every Desktop call carried a fragment of its own frame (2026-10-04, after the seam fix)

The seam fix worked, and the user's reading of the new run was right in a different way. The seven
prompts all answered fast — `PROBE_6` + `/home/ruler` + `ruler` in 523 ms, `cd /tmp` then `pwd` →
`/tmp`, `READ_BACK=kept_42`, `false` → `[exit code: 1]`, `sudo -n true` → 114 ms — and every one of
them also carried this in its body:

```
[stderr]
<b9-31ba5cefb5f0' "$( { export -p; printf 'PWD=%s\n' "$PWD"; } | base64 -w0 )"
```

That is our own framing, and the model was reading it on every call. The driver reported 13/13.

### What the bytes actually do

Instrumented at the raw pipe (`D:\Temp\issue51-matrix\stderr-windows.mjs`, then the session's own
windows in `stderr-windows2.mjs`): bash echoes each line it reads to stderr, but the echo of a frame
does not arrive as the line. Measured chunk for chunk:

| what arrived on stderr | bytes |
| --- | --- |
| the prompt text, as its own chunk | 10 (`bash-5.1$ `) |
| then a `\r` followed by **the last 78 bytes of the frame line**, starting in the middle of the nonce | 80 |
| the frame's two records, on stdout as designed | 59 + 1660 |

So the head of the echoed line — where the payload and both record tags live — is never written. The
first version of the fix assumed the echo was cut by *my* window boundaries and made the windows
line-aligned (`takeStderr` in `wsl-bash-session.ts`); measuring again showed the cut is the shell's,
one frame per chunk, terminated by a newline, unrecognisable by payload or tag. Line alignment is
still correct and stays, but what closes the leak is recognising the frame by text that only a frame
contains: `RECORD_TAG`, `STATE_TAG`, `__dsh_status`, and the state-report command itself
(`FRAME_SIGNATURES` in `wsl-bash-protocol.ts`).

### The instrument lesson, which is the same one as issue #51

This is the sentinel-scrape failure again, one layer down. My first two filters keyed on bytes the
shell chose how to deliver — the payload, then the tags — and both were in the part that did not
arrive. The rule that survives is the one the plan wrote for the completion check: never recognise
protocol by a rendering; recognise it by text that exists only in what we ourselves wrote.

The gate cell that now enforces it read the **rendered body** (`output.render`, which composes stdout
plus `[stderr]`) instead of `stdout.text`, because every one of the thirteen existing cells looked at
`stdout.text` and the leak was outside all of them. Two cells went in, and the first was written
deliberately weak to test the test: keyed on `__DSH_WSL_BASH`, `eval "$(printf %s` and
`| base64 -d)"` it reported green on a run whose every body still held the fragment. Keyed on the
frame's own `{ export -p;` text it went **11 of 11 red**, and green after the `FRAME_SIGNATURES`
change: `15/15` here on both planes and as both users (`root`, `ruler`), with the companion positive
control (`echo oops >&2` → `[stderr]\noops\n`) riding along so a filter that dropped all stderr could
not pass either.

## A day of bash, and the three things it was not yet doing (2026-10-04)

With the leak closed, the question became the user's: do *ordinary* commands behave as an ordinary
shell? A matrix of 34 everyday commands through the mounted tool
(`D:\Temp\issue51-matrix\common-ops\probe.mjs`) ran twice, before and after the changes it caused.
Every row that passed, passed in 20-300 ms: `cd` chains, `ls`/glob, pipes, `grep -c`, heredocs,
command substitution, `for` loops, quoting, `tar` round-trip, `find`, `sed -i`, `awk`,
`git init`+`commit`+`log`, `node -v` / `python3 -V` / `npm -v` resolving from the sourced login
environment, CJK, 20 000-line output, `export` read back in the next call, `pipefail` shape, `&` with
`wait`.

Four readings were not everyday-good, and all four were product behaviour rather than shell semantics:

| reading | what it meant |
| --- | --- |
| `sleep 30` with an 8 s deadline took **16 485 ms** | the recovery path re-executed the frame, so the deadline was spent twice |
| `echo run >> f; sleep 6` left **two** lines in `f` | the same retry repeats effects — a second `git commit`, a second `curl -X POST` |
| the call after a cancelled `sleep 20` took **18 520 ms** | a cancel did not stop the command, so the next call queued behind it |
| `sudo true` | 6 000 ms, `(no output)`, `[timed out after 6000ms]` — while the README claimed a bounded failure *and a message* |

The first two are one bug: `run()` rebuilt the session and then ran the command again. It now rebuilds
on any non-settle — which is what frees the shell — but re-executes only when the child was already
gone, because that is the one case where the command demonstrably did not finish. The third: a caller
cancel now throws the host's own shape (`dsh-tool-bash`'s `toolAborted()`, an `AbortError` reading
`tool call aborted`) instead of returning a result that renders as `[exit code: 1]`, which would tell
the model the user's command had failed.

The fourth was the plan's step 4, never built: the README asserted a message that the code did not
produce. Implemented as `src/host/wsl-bash-tty.ts` — `script -qec` started inside the session, with the
records still written by the frame *outside* it, so escalation cannot reach the protocol; the command's
first word decides, `tty: true` forces it. Measured after: `sudo true` 45-54 ms with sudo's own
verdict, `stty size` → `24 80`, `tty` → `/dev/pts/N`, and the pty's `\r\r\n` folded back into plain
text (`normaliseTtyOutput`) before the model reads it. `stty` has to run *inside* the pty — set
outside, `stty size` answered `0 0` while `tty` still reported a pts. `less` and `ssh` came back
healthy without escalation, which is why the whitelist is the narrow list it is.

### Two readings that were about my instrument, not the shell

The matrix's `cancel bounded` row reported NOTE on the second run — because the fixture still expected
a return value where the product now throws. Stale instrument, fixed in the instrument.

And the new `sudo` cell first asserted the word `password`, which is a fact about *this
distribution's sudoers*: as `ruler` sudo asks, as `root` (this machine's other user, and the WSL1
runner's) it is NOPASSWD and answers `(no output)` with exit 0. The cell now asserts the universal
property — escalated, inside budget, sudo's own verdict — and the run is 22/22 as both users on both
planes. That is the third time in this issue that a machine-specific reading was written as a rule;
the check that belongs to me is whether an assertion survives changing users.




## Round two: what a day of bash costs, and where it still differs from the other bash (2026-10-05)

Four measurements were taken before any of this round's code, in `D:\Temp\wsl-bash-round2\`.

**Frame length.** A command travels as one line, so the question is what one line costs. Payload of
1 kB → 55 ms; 8 kB → 110 ms; 16 kB → 303 ms; 32 kB → 1 039 ms; 64 kB → 3 840 ms; 96 kB → 8 499 ms;
128 kB → 15 108 ms; 256 kB → 59 256 ms. **Nothing was truncated at any size** — each frame answered
with the exact byte count it asked for — which closes the P0 question this round opened with: an
unclosed quote, an unterminated heredoc, a dangling `|` and an unclosed `for` each settle with bash's
own syntax error (exit 2) in 21-484 ms, and the next command answers normally (`SURVIVED_42`,
29 ms), because the command text never reaches bash as input lines — it is decoded inside `eval`.
The cost is latency that grows with length, recorded as `behaviour-long-frame-latency`.

**Journal size.** `export -p` is 2 471 bytes, `set +o` 542, `shopt -p` 1 086 — but `declare -f` after
this machine's rc files is **61 083 bytes across 85 functions**. That is why the bodies ride only on
the frame where the function count moved, and why the cap reports itself: an unconditional snapshot
would put ~81 kB of base64 through the pipe per command to repeat something that changes almost never.

**Rebuild replay, and the parse-time trap.** Sending the whole journal as one command failed with
`syntax error near unexpected token '('` and exit 2: `eval` parses its entire string before running
any of it, so `shopt -s extglob` on line 50 cannot help the bash-completion function on line 1623
that needs extglob *to be parsed*. Symptom worth remembering — the restart reported success, 91
functions came back (from re-sourcing rc) and the function the user defined two calls earlier did
not. Fixed by chunking the restore (bootstrap, options, environment, functions, `cd`), each its own
frame. Two smaller bugs found on the way: the frame's definition-detection regex missed
`eval "dshbig$i() { …"` because it demanded a delimiter before the name, and the over-cap marker
printed the literal `$__dsh_s` inside single quotes instead of a number.

**Detached processes.** Killing `wsl.exe` takes the shell's ordinary children with it (0 survivors,
twice) but not ones that detached themselves: `setsid sleep 45` and `nohup sleep 46 &` both lived
(2/2). The reaper therefore matches a `DSH_WSL_SESSION` token in `/proc/*/environ`.

**Correction, same day (2026-10-05).** The sentence above ended "and the control that makes the cell
mean something is a sleep started **without** the token: it must survive, and it does." It does not.
A `setsid sleep 40` whose `wsl.exe` exits **normally** is gone immediately on this machine's WSL2 —
measured `DEAD` at t=0 with the instance demonstrably up (`echo $$` answered in the same PID range) —
and the distinction is survival of the *session*, not of the shell: the 2/2 reading was a child of a
shell killed **abnormally**. So the control as written was never a live process, the mis-kill guard
underneath the reap cell was vacuous, and nothing asserted `outsideState` anyway. The cell now holds
its control open with a `wsl.exe` of its own (`exec sleep 41`, launcher still running: measured
`COUNT=1`, and `COUNT=0` after killing the launcher), counts the session's child by its duration
before and after the rebuild, and asserts both.

**Footprint, measured on this machine.** One session costs about **9.1 MB of Windows working set
across two `wsl.exe` processes** (3 sessions → 6 processes, 54.7 MB total) plus **3.4 MB of RSS for
the bash inside the distribution**; `vmmem` stayed at 552 MB whether shells were up or not, and free
physical memory returned from 2 521 MB to 2 640 MB when the shells were killed. Disk: the shipped
`lib/` is 633 kB total, of which this tool's chunk is 24.83 kB (with a map of similar size). Nothing
is written at runtime until a stream overflows, and a spill file is now per command — measured
before that fix, every probe after a 200 000-line command reported the earlier command's spill path,
which `bash-parity-real` caught as an undeclared difference.

**Differential result.** With the same per-stream cap on both sides, 6 of 10 comparable probes agree
exactly on the fields that matter (including the spill file's line count, 200 000 in both worlds) and
3 differ in ways now written into [bash-parity.md](bash-parity.md): `$-` (`himBs` vs `hBc`, because
interactive mode is what buys aliases and functions), the layer that reports a missing `workdir`
(`wsl.exe`'s `chdir … failed 2` there, bash's own `cd:` error here), and state persisting here but not
in a one-shot call. 2 probes are **not covered** — the host's background and promote paths need a jobs
registry the in-process harness does not mount, and saying so is the point of the row rather than
silently dropping it.

## The nine clicks, read from the product's own transcript (2026-10-05, Desktop 0.2.x)

He ran them in a real Desktop session in this WSL workspace (`~/.dsh/sessions/--wsl.localhost-Ubuntu-home-ruler--/session-b7b8f571-…`,
`session.v4.jsonl.zstd`, 623 events, transcript written 2026-10-05 08:02 local). Read out of the file
rather than retold: 51 `tool/call` / `tool/result` pairs — `bash` 25, `bash_background` 9, `job_output`
10, `read` 6, `glob` 1. The newest nine `bash` results are the nine prompts; the earlier ones in the
same file are the *previous* round's traffic and are excluded below (they show two defects already
fixed, including three calls answered by the host's persistent tier with
`Your command timed out after 300 seconds`).

| prompt | what the product returned | reading |
| --- | --- | --- |
| `echo PROBE_$((21*2)); pwd; whoami` | `PROBE_42 /home/ruler ruler` | answers, and **0 of the 9 newest bodies carry a frame signature** — the leak check's own signature list run against the product's transcript |
| `cd /tmp && export DSH51=kept_$((6*7))` then `pwd; echo READ_BACK=$DSH51` | `/tmp READ_BACK=kept_42` | directory and export cross the call boundary |
| `seq 1 200000` | 49 931 bytes kept, `[output truncated; full output: …\dsh-subprocess-…-stdout.log]`, then the host's own `(Omitted 470266 bytes. Full formatted result stored at: D:\Temp\dsh-spill-…)` | spill works and the two layers stack without fighting; the model is pointed at a file twice, once by us and once by the host's retention layer |
| `echo run >> /tmp/x51; sleep 6` then `wc -l /tmp/x51` | `1 /tmp/x51` | **exactly-once holds inside the product** — the timeout-replay defect's fix confirmed at the tier it was found in |
| `alias m51='echo ALIAS_OK_7'; m51` | `[stderr] Command 'm51' not found, did you mean: … [exit code: 127]` | **not our defect, and not a difference from bash**: measured the same day on this distribution, `bash -ic "alias m51p=echo; m51p HI"` also answers `m51p: command not found`, while feeding the two as separate lines to `bash -i` answers `HI`. Aliases resolve when bash *parses* a line, so an alias is usable on the following call and never on the one that defines it — which is what the session tier gives (the row above, and `bash-session-real`'s replay cell). The sentence differs from the one-shot path only in who prints it, now `behaviour-command-not-found` |
| `sudo true` | `[sudo] password for ruler: sudo: no password was provided / sudo: a password is required [exit code: 1]` | the escalation reached sudo (a prompt was delivered and answered inside the deadline, not the old burn-6 s-then-timeout), and this distribution's `ruler` is **not** NOPASSWD — so "sudo 用不了" is sudoers, not the shell. What we could fix is the silence about it: the body now says so (`…this shell has nobody to type it: run the session as a user with NOPASSWD, or as root`), gated by a cell that asserts the note rides the complaint and does not appear where no complaint is printed |
| `stty size; tty` | `not a tty` + `stty: 'standard input': Inappropriate ioctl for device`, exit 1 | the declared `behaviour-no-tty` difference, in the product |
| the one `glob` in the file | `Error: glob search failed inside the distribution (exit 1): find: '/tmp/systemd-private-…': Permission denied` | **the host's own classification, mirrored**: `dsh-tool-fs-search/lib/index.js` has `classifyRunFailure(…) → new SearchError(… "SEARCH_FAILED")` for a non-zero exit with stderr, so a directory containing an unreadable subdirectory fails the search in both worlds. Recorded, not fixed here — changing it would move us off the host's contract that `tests/wsl-search.test.ts` holds |

## Isolation between agents, and the leak the first cell found (2026-10-05)

`bash-session-real` grew six cells for the boundaries nobody had driven: a second agent arriving
through the same registered tool, two calls in one flight, a rebuild's reaper aimed at another
agent's processes, that other agent's shell after a rebuild, and one agent's scope ending while the
other keeps working.

Four passed on the first run and one **failed with a number that names the defect**:
`{"bDisposers":0,"beforeAgentEnd":6,"afterAgentEnd":6}` — the tool registered a disposer on the
*plugin* scope only, so every agent that ever called `bash` left its shell alive (two `wsl.exe`,
≈9 MB of Windows working set each) until the whole world was disposed. The fix is the registration
the agent scope was asking for (`exec.agent.ctx.effect`, cordis's own scope hook: the function it
returns runs when that agent ends). After it, on both planes:
`{"bDisposers":1,"beforeAgentEnd":6,"afterAgentEnd":4,"a":"A_AFTER_B_25"}` — one agent's scope ending
takes exactly its two `wsl.exe`, the other agent still answers, and the plugin's own dispose still
takes what is left (`4 → 2`). State isolation was never the problem: a second agent saw
`/home/ruler ISO=[]` while the first kept `/tmp ISO=from_A_42`, a concurrent pair settled
`{"one":"ONE_4","two":"TWO_8"}`, and a rebuild left the other session's detached child alone
(`beforeForeignReap:1, afterForeignReap:1`). 39 checks ran green on `src` and `lib` before the sudo
note cell was added, 40 after; the parity driver went to 11 probes with `alias used on the line that
defines it: differs, as behaviour-command-not-found`.

**Not covered by this pass, named:** two *Desktop windows* (two separate host processes, two plugin
instances) are not driven by anything — the isolation cells cover agents inside one mounted world;
`job_list` visibility across agents belongs to the host's jobs registry, which the harness stubs; and
the `dsh-spill-*` directory the host's retention layer writes is the host's lifecycle, not ours.

## The pseudo-terminal's seams, driven rather than reasoned about (2026-10-05)

Two scratch drivers mounted the registered `bash` through `ctx.plugin` and called it with the shapes a
model actually writes, each call bounded by its own `timeoutMs` (files under `D:\Temp\wsl-bash-round2`,
outside the repository; nothing installed, no Desktop instance touched). Readings on this machine
(WSL2, `Ubuntu`, user `ruler`, whose sudoers is **not** NOPASSWD):

| the call | what came back | what it says |
| --- | --- | --- |
| `echo out; echo err >&2`, `tty: true` | `out err ` — **no `[stderr]` section** | a terminal has one stream; separation exists only on the pipe. Mechanism, and the same for the host's PTY tier |
| `echo out; echo err >&2`, plain | `out [stderr] err ` | the contract the ledger already describes |
| `man ls` (auto-escalated) | 743 ms, `N\bNA\bAM\bME\bE ls - list …` | emphasis reaches the model as overstrike — unreadable, and the fold never saw it |
| `man ls \| head -c 120` (plain) | `LS(1) … LS(1)\n\nNAME\n` | clean, because `man` writes overstrike only when it is on a terminal |
| `bash -c 'sudo true'` | **5289 ms, `timedOut: true`, `(no output)`, plus a session rebuild** | the issue's own symptom one layer in: the decision read the first word, which was `bash` |
| `sudo true` | 46 ms, `[sudo] password for ruler: … a password is required`, exit 1 | the escalation works; the distribution, not the shell, is what needs a password |
| `less /etc/hostname` | 6076 ms, `WARNING: terminal is not fully functional Press RETURN to continue`, timeout + rebuild | the frame gives the pty `/dev/null` for input, so a program waiting for a key gets EOF-ish noise and burns its deadline |
| `vim /etc/hostname` | 5715 ms, `"/etc/hostname" [readonly] 1L, 9B`, timeout | same class; it opened read-only and did not touch the file |
| `top` | 6124 ms, a screen dump, timeout | same class, and it costs CPU while it waits |
| `top -bn1 \| head -3` | 222 ms, batch output | batch mode needs no terminal, yet the first-word rule escalated it anyway |
| `cat`, `tty: true` | 82 ms, `(no output)` | input really is `/dev/null`: a reader sees EOF at once rather than hanging |
| `sleep 45`, `tty: true`, aborted at 800 ms | `AbortError` at 2922 ms, then `SLEEP=0 SCRIPT=0` | cancelling an escalated call takes the inner program with it — the leak a `setsid` child showed on rebuild is not present here |
| `sudo true` after the fix | body ends `[sudo asked for a password and this shell has nobody to type it: run the session as a user with NOPASSWD, or as root]` | the added note, gated by a cell that asserts the note and the complaint appear together |

Three of those were defects and are fixed here: the overstrike fold (`N\bN`→`N`, `_\bX`→`X`, the two
shapes actually measured — a bare `.\b` deletion rule was tried first and ate characters, which the
unit test now pins), the wrapper read (one layer; an unreadable wrapper is left alone rather than
escalated on a guess), and `tty: false` as a veto (measured: with only `true` honoured, `man ls`
`tty: false` came back byte-identical to the escalated call). Two cells went into `bash-session-real`
for the first two — the fold is asserted on the exact bytes rather than on `man`, because whether `man`
reaches its pager at all is a property of the distribution, not of this plugin — and the veto is
asserted offline, since the only live way to see it would be to let a program hang.
**42/42 on both planes**, and `12/12` on the parity driver's two planes with the single-stream probe
added (14 probes, the two the one-shot world cannot answer still skipped and named); unit 160 tests /
0 fail, node 72/72, docs 11/11, typecheck still 209.

Two more rows went into the ledger: `behaviour-escalated-streams` (one stream, mechanism, with a probe
that shows it) and `behaviour-overstrike` (the fold), and `param-tty` now states all three of its
values. A duplicated ledger row id was introduced and removed during this pass, found by `grep` rather
than by the gates — `tests/wsl-bash-parity.test.ts` already asserts ids are unique, and the duplicate
was cleared before that bucket was run, so the gate never got to say anything about it.

**Then the list became classes, on agent-cost grounds.** The default per-call deadline is 120 s
(`timeoutMs: 120_000`, max 600 s), and a program waiting for a keyboard that never arrives cannot be
satisfied inside any deadline — so the question was not "does it get a terminal" but "what does an
agent pay for the guess". Three sets, each with its own treatment:

| class | members | terminal | deadline | why |
| --- | --- | --- | --- | --- |
| credential | `sudo su doas ssh scp sftp rsync passwd chpasswd gpg ssh-copy-id ssh-keygen mysql mariadb psql sqlplus redis-cli mongosh` (18) | always | as configured | nothing else answers them; escalated, `sudo` returns in 46-166 ms with its own words |
| keyboard | `vim vi nvim view nano pico emacs ed tmux screen telnet ftp` (12) | always | **8 s**, and only when the call names neither `tty` nor `timeoutMs` | an agent does write the batch forms (`vim -es -c '…' -c wq`, `tmux new -d 'cmd'`), so refusing outright would close a door; waiting two minutes to say "no keyboard" is the worst of the three |
| optional | `htop top less more pg man info gh az gcloud aws virsh mongod` (13) | never, unless asked | — | each has a pipe form that is strictly better: measured `man ls` on the pipe = 177 ms and the whole page, auto-escalated = 743 ms into a pager; `top -bn1`, `gh --version`, `mongod --version` print and exit |

The bound is asserted on the **bound** (`value.timeoutMs === 8000`), not on the hang, because whether
`vim` hangs or exits is the distribution's business — a runner without `vim` still shows the cap
applied. Writing the classes also found a dead letter: `firstWord` stopped at a hyphen, so
`ssh-copy-id`, `ssh-keygen` and `redis-cli` were in the whitelist and could never match anything. They
can now, which is a behaviour change for three commands and is said so in the changelog rather than
slipped in. Measured after the change, both planes: `man ls > /dev/null; tty` ⇒
`{"ms":177,"tail":"RC=0 not a tty"}`, `vim /etc/hostname` ⇒
`{"ms":9634,"deadline":8000,"timedOut":true,"note":true}`.

**Left unmeasured, and what it would take:** a distribution without `script` (only Ubuntu is installed
here, so the fallback is untested and would surface as `script: command not found` for a `sudo` call);
`sudo`'s behaviour under `Defaults requiretty`; wrappers deeper than one layer
(`bash -c "bash -c 'sudo x'"`); and whether `script` propagates an inner exit code on every util-linux
version (it did here: sudo's `1` came back). Unchanged by this pass: an escalated call still has one
stream, and the keyboard class still costs 8 s plus a session rebuild when it is genuinely run
interactively — bounded now, not eliminated.

## Cloud frame 37221289492, read step by step, and the cell that turned out to be about the fixture (2026-10-05)

Dispatched on `fix/issue51-shell-execute-seam` at head `21b8ee6`. Job conclusions:
`gates on the committed artifact plane (ubuntu)` **success**, `node buckets against the pinned host
tree (ubuntu)` **success**, `real-WSL hard gates (windows + WSL1 Ubuntu)` **failure** — one step,
`run every WSL gate`, with `every gate must say which plane it loaded` **success** after it.

The pure-node bucket being green is the point of this frame: the previous one (37220551085) died in
that step, because `tests/wsl-bash-parity.test.ts` was filed under `test:unit`, which runs after
`npm ci` with no host packages installed, and it imports the module that imports
`@deepseek-ai/schemastery` — `ERR_MODULE_NOT_FOUND` at load, before a single assert. Locally that is
invisible: the development tree has the pinned packages hoisted, which is the exact property the
bucket is defined by not having.

From the job's own `wsl-gate-logs` artefact, per gate: `smoke`, `exec-shape`, `shell-extra`,
`make-smoke-built`, `smoke-built`, `fs-real`, `skills-real`, `search-real`, `relay-real`,
`tool-bash-real` PASS on the `src` plane; `bash-parity-real` 10/10; `bash-session-real` **32/33** —
the failing cell being `a detached child of the session is reaped on restart`, payload
`{"note":"…[2 detached processes from the previous shell were stopped]","outsideState":"ALIVE",
"sleepCount":"2"}`. On the `lib` plane of the **same frame** every gate PASSed and
`bash-session-real` reported **33/33**.

Same commit, same machine, different plane, different answer: that is a device reading, not a product
one, and the artefact says which. The cell asserted `pgrep -c -x sleep <= 1` after the rebuild. The
job's own `fixture preparation` step starts a `nohup sleep 900` on purpose (the 9P share disappears
when the instance idles out), so a correct reaper still saw 2 processes named `sleep` — the keep-warm
and the outside control — and the `src` plane was red for counting them. The `lib` plane then passed
because the `src` plane's cleanup line `pkill -x sleep` had killed the CI fixture's keep-warm, a
process the driver does not own, in a distribution the rest of the job continues to use. Rewritten to
count by the duration each probe carries, to assert before and after, to hold its control open with a
launcher of its own, and to clean up by pattern instead of by process name.

Controls run on this machine after the rewrite (WSL2, `Ubuntu`, user `ruler`): `src` plane 33/33 and
`lib` plane 33/33, cell payload `{"beforeReap":1,"afterReap":0,"controlAlive":1}`; mutation control —
`kill -9` → `kill -0` inside the reaper script, which still counts and still claims
"[1 detached process … was stopped]" — FAIL `{"beforeReap":1,"afterReap":1}`, then restored
byte-identical (`git diff --stat` empty for that file) and re-green 33/33.

**Not covered by this frame, named rather than folded into the green:** `compat.yml` did not run (it
is a separate workflow on its own schedule), `scripts/compatibility/installed-copy.mjs` is not wired
into `ci.yml` at all (it needs this machine's Desktop profile), and the reap cell was checked only for
the `sleep`-named probes — the 4 000-function journal cell and the spill cell were not re-instrumented.

The first gap was closed the same evening: `compat.yml` dispatched on this branch at head `9d91b78`
(frame **37223406931**, the whole rolling window, repo is PUBLIC so the Windows minutes are not
billed). `read-window` ✓, and one job per entry, each ending `verify-dsh-compat: OK — 1 verdict(s),
all PASS compatible` with its own verdict line: `0.2.0-rc.2 PASS compatible`, `0.2.0-rc.1 PASS
compatible`, `0.1.7-rc.2 PASS compatible`. Those jobs pack the **working tree** and install that tarball
(the step is named `pack and unpack the working tree (never test a published artifact for an
unpublished commit)`), so this is the first compat pass that ever carried the session `bash`, and the
rc.2 log shows the new chunk in the pack (`lib/wsl-bash-tool-C7flW-l_.js`, 49.4 kB with an 88.7 kB map).
What the compat matrix does **not** look at, stated because a green there is often read as more than
it is: it probes install → boot → the plugin's HTTP route → uninstall → reprobe (`✔ no plugin errors
in the boot log`, `✔ plugin route gone after removal (405)`), and never enumerates which tools
mounted — so it does not say whether the persistent-bash world came up on that runner, and it is not
evidence about `bash` behaviour. The behaviour claim is `bash-session-real` / `bash-parity-real` above.


## The checklist driven through a real dsh session (2026-10-05, second round)

Everything above drives the tool from a harness. This section is the same commands sent through the
product's own agent loop, so the readings are the bytes a model would read.

**How it was run, and what it did not touch.** `E:\dsh-plugins\docs\PLUGIN-RULES.md` §H.5/§H.7 records
the official surfaces, so no new device was invented: the installed 0.2.0-rc.2 CLI was launched over
channel ② (`ELECTRON_RUN_AS_NODE=1` + `--expose-internals` on the `app.asar` tree) as `--profile web
--no-open --host 127.0.0.1 --port 19411` with `DSH_HOME=D:\Temp\issue51-dsh-drive\home`; the plugin was
installed into that profile with `dsh plugin --profile web add file:…`; the model was the local scripted
provider `E:\dsh-plugins\tools\mock-llm-provider\server.mjs` on 19410, declared as a `ck51mock` route in
the profile patch — **so no inference request was bought and DeepSeek's balance was not used**. The
session was created and prompted over the host's own remotes (`session/create`, `session/prompt`) after
exchanging the launch token for the cookie, and the answers were read back from the session's own
durable log (`session.v4.jsonl.zstd`, 87 frames, decoded frame by frame). The user's running instance
(19387, PID 21164) was never connected to: both ports were confirmed to have **0 listeners** after
teardown and 19387 still had its original owner.

Two passes, because one fixture could not ask the question. Pass one prefixed each command with a
`printf` marker so the scripted provider could find its place in the history — and that prefix turned out
to change what the tool does, so pass two re-sent the six terminal-shaped commands exactly as a model
writes them.

### Pass one — 27 rows, marker-prefixed (times are `tool/result.time − tool/call.time` from the log)

| # | the call | ms | what the product returned |
| --- | --- | --- | --- |
| 1 | `pwd` | 655 | /home/ruler/ck51-workspace |
| 2 | `export CK51_VAR=hello42; echo set=$?` | 36 | set=0 |
| 3 | `echo "[$CK51_VAR]"` | 39 | [hello42] |
| 4 | `cd /tmp && pwd` | 35 | /tmp |
| 5 | `pwd` | 30 | /tmp |
| 6 | `cat > ck51-note.txt <<'CK51EOF' line one $notexpand...` | 36 | 2 |
| 7 | `cat ck51-note.txt` | 27 | line one $notexpanded `backtick` line two |
| 8 | `printf '%s\n' "中文 éèü ✓ 🎯"` | 56 | 中文 éèü ✓ 🎯 |
| 9 | `git status --porcelain; echo exit=$?` | 55 | exit=128 [stderr] fatal: not a git repository (or any of the parent direct |
| 10 | `git init -q ck51repo && cd ck51repo && git log --on...` | 83 | exit=128 [stderr] fatal: your current branch 'master' does not have any co |
| 11 | `python3 -c "print(sum(range(10)))"` | 113 | 45 |
| 12 | `node -e 'console.log(process.platform, 6*7)'` | 485 | linux 42 |
| 13 | `seq 1 5000 \| grep -n 4777 \| head -3` | 68 | 4777:4777 |
| 14 | `seq 1 200000 \| sed 's/^/row /'` | 131 | 42 row 152743 row 152744 row 152745 row 152746 row 152747 row 152748 row 1 |
| 15 | `( sleep 2; echo BG_DONE > ck51-bg.txt ) & echo laun...` | 26 | launched [stderr] [1] 36163 |
| 16 | `cat ck51-bg.txt 2>/dev/null; echo exit=$?` | 34 | exit=1 |
| 17 | `sh -c "exit 7"` | 29 | [exit code: 7] |
| 18 | `sudo -n true; echo exit=$?` | 97 | exit=1 [stderr] sudo: a password is required |
| 19 | `bash -c 'sudo -n true; echo wrap=$?'` | 68 | wrap=1 [stderr] sudo: a password is required |
| 20 | `man ls 2>/dev/null \| head -3; echo exit=$?` | 162 | LS(1) User Commands |
| 21 | `top -bn1 2>/dev/null \| head -4; echo exit=$?` | 200 | top - 10:26:20 up 9:24, 0 users, load average: 0.07, 0.02, 0.00 Tasks: |
| 22 | `vim ck51-note.txt` | 121703 | [24;1H"ck51-note.txt" [New][2;1H~ |
| 23 | `echo "it's $(echo sub) $(echo '

### Pass two — the same shape with pristine commands

| # | pristine call | ms | reading |
| --- | --- | --- | --- |
| 1 | `top` | 687 | [stderr] top: failed tty get [exit code: 1] |
| 2 | `vim ck51-note.txt` | 9829 | "ck51-note.txt" 2L, 18Bline one line two ~ |
| 3 | `sudo true` | 130 | [sudo] password for ruler: sudo: no password was provided sudo: a passwor |
| 4 | `less ck51-note.txt` | 73 | line one line two |
| 5 | `bash -c 'sudo true'` | 118 | [sudo] password for ruler: sudo: no password was provided sudo: a passwor |
| 6 | `git status` | 55 | [stderr] fatal: not a git repository (or any of the parent directories): . |

### What this pass settled

| row | verdict | whose behaviour |
| --- | --- | --- |
| 1-5, 27 | state is real in the product: `export` reaches the next call, `cd` reaches the next call, and the shell is still the same one after a 1.5 s timeout and a restart | ours, **[measured in a live session]** |
| 6-8, 23-24 | the framing holds for heredocs, multi-line loops, nested quotes, `$( )` and non-ASCII — nothing was re-written or lost on the way in | ours, **[measured in a live session]** |
| 9-10, 17 | failures arrive as the program's own words plus `[exit code: N]`, including `128` from git; the `[stderr]` section appears on the pipe path | ours, **[measured in a live session]** |
| 13-14 | a pipeline behaves, and a 2.2 MB stream is not truncated: the body says `Omitted 470246 bytes. Full formatted result stored at: …` and points at a readable file | the host's retention layer, **[measured in a live session]** |
| 15-16 | a command ending in `&` returns at once with `[1] 36163` on stderr, and the *next* call cannot see its output yet (`exit=1`) — the hazard the tool description warns about, reproduced in the model's own face | documented, **[measured in a live session]** |
| 20-21, pass-two 4 | the pager class stays on the pipe and answers in tens of milliseconds (`man` 162 ms, `less` 73 ms); no pager was opened, no overstrike reached the model | ours, **[measured in a live session]** |
| 18-19 | `sudo -n` answers with sudo's own verdict in 68-97 ms; with the `-n` form neither call needed a terminal, and pass two shows bare `sudo true` escalated in 130 ms with the password note attached | ours, **[measured in a live session]** |
| 25 | `head: cannot open 'ck51-link.txt'` is **correct**: row 10 had `cd ck51repo`, so the link was made there and `ck51-note.txt` is not in that directory — the expectation in the checklist was written without the earlier `cd`, not a product defect | the fixture's, **[measured in a live session]** |
| 22 | **a real defect, and the reason pass two exists.** The older rule read only the command's first word, so `printf 'x\n'; vim note.txt` was not escalated at all: it sat out the configured two-minute default (**121 703 ms**) and returned the screen's raw escapes (`\u001b[24;1H`, `~` rows) because the pipe path never folds them. Pass two's bare `vim` was escalated, cut at 8 s, and folded — the same program, 9 829 ms, with the note | ours, fixed the same round |

**The fix, and what it cost to know.** The class is now the strongest one carried by *any* top-level
segment (`cd /tmp && vim f` is an editor case; a quoted word is not a command position; the keyboard
part outranks the credential part because it is the part that sets the deadline). Two live cells pin it:
`printf 'x\n'; vim /etc/hostname` must report an 8000 ms deadline, and bare `top` must **not** be one —
pass two measured `top: failed tty get`, exit 1, 687 ms, which also corrected a sentence the tool had
been telling models: a live display on a pipe does not print a document, it refuses outright, so the
description now says `top -bn1`. The whole checklist costs about 2 300 s of wall clock, and 121 s of
that was the single defect it found.

**Not covered by this pass, named rather than folded into the readings.** The provider is scripted, so
this says nothing about whether a *real* model picks these commands or reads these notes well — it says
what the tool returns when the calls arrive. Only one session existed in one window, so cross-instance
(two Desktop windows) isolation is still unmeasured. The `wsl-standard` preset was absent for the first
~10 s after the port listened (the variants are published by a fire-and-forget effect during profile
boot) and the driver polls for it — a timing fact about boot, not about `bash`, and not verified against
the desktop profile. Pass one's row 14 spill path and row 26 restart are the host's own retention and
recovery shapes; they were read, not instrumented.
)" && echo 'single...` | 29 | it's sub $ single'quoted |
| 24 | `for i in 1 2 3; do echo "loop=$i" done` | 58 | loop=1 loop=2 loop=3 |
| 25 | `ln -sfn ck51-note.txt ck51-link.txt && readlink ck5...` | 55 | ck51-note.txt [stderr] head: cannot open 'ck51-link.txt' for reading: No s |
| 26 | `sleep 30` | 3145 | [timed out after 1500ms] [the shell was restarted to recover; for work tha |
| 27 | `echo ALIVE_$(( 20 + 6 )) && pwd` | 73 | ALIVE_26 /tmp/ck51repo |

### Pass two — the same shape with pristine commands

<<TABLE2>>

### What this pass settled

| row | verdict | whose behaviour |
| --- | --- | --- |
| 1-5, 27 | state is real in the product: `export` reaches the next call, `cd` reaches the next call, and the shell is still the same one after a 1.5 s timeout and a restart | ours, **[measured in a live session]** |
| 6-8, 23-24 | the framing holds for heredocs, multi-line loops, nested quotes, `$( )` and non-ASCII — nothing was re-written or lost on the way in | ours, **[measured in a live session]** |
| 9-10, 17 | failures arrive as the program's own words plus `[exit code: N]`, including `128` from git; the `[stderr]` section appears on the pipe path | ours, **[measured in a live session]** |
| 13-14 | a pipeline behaves, and a 2.2 MB stream is not truncated: the body says `Omitted 470246 bytes. Full formatted result stored at: …` and points at a readable file | the host's retention layer, **[measured in a live session]** |
| 15-16 | a command ending in `&` returns at once with `[1] 36163` on stderr, and the *next* call cannot see its output yet (`exit=1`) — the hazard the tool description warns about, reproduced in the model's own face | documented, **[measured in a live session]** |
| 20-21, pass-two 4 | the pager class stays on the pipe and answers in tens of milliseconds (`man` 162 ms, `less` 73 ms); no pager was opened, no overstrike reached the model | ours, **[measured in a live session]** |
| 18-19 | `sudo -n` answers with sudo's own verdict in 68-97 ms; with the `-n` form neither call needed a terminal, and pass two shows bare `sudo true` escalated in 130 ms with the password note attached | ours, **[measured in a live session]** |
| 25 | `head: cannot open 'ck51-link.txt'` is **correct**: row 10 had `cd ck51repo`, so the link was made there and `ck51-note.txt` is not in that directory — the expectation in the checklist was written without the earlier `cd`, not a product defect | the fixture's, **[measured in a live session]** |
| 22 | **a real defect, and the reason pass two exists.** The older rule read only the command's first word, so `printf 'x\n'; vim note.txt` was not escalated at all: it sat out the configured two-minute default (**121 703 ms**) and returned the screen's raw escapes (`\u001b[24;1H`, `~` rows) because the pipe path never folds them. Pass two's bare `vim` was escalated, cut at 8 s, and folded — the same program, 9 829 ms, with the note | ours, fixed the same round |

**The fix, and what it cost to know.** The class is now the strongest one carried by *any* top-level
segment (`cd /tmp && vim f` is an editor case; a quoted word is not a command position; the keyboard
part outranks the credential part because it is the part that sets the deadline). Two live cells pin it:
`printf 'x\n'; vim /etc/hostname` must report an 8000 ms deadline, and bare `top` must **not** be one —
pass two measured `top: failed tty get`, exit 1, 687 ms, which also corrected a sentence the tool had
been telling models: a live display on a pipe does not print a document, it refuses outright, so the
description now says `top -bn1`. The whole checklist costs about 2 300 s of wall clock, and 121 s of
that was the single defect it found.

**Not covered by this pass, named rather than folded into the readings.** The provider is scripted, so
this says nothing about whether a *real* model picks these commands or reads these notes well — it says
what the tool returns when the calls arrive. Only one session existed in one window, so cross-instance
(two Desktop windows) isolation is still unmeasured. The `wsl-standard` preset was absent for the first
~10 s after the port listened (the variants are published by a fire-and-forget effect during profile
boot) and the driver polls for it — a timing fact about boot, not about `bash`, and not verified against
the desktop profile. Pass one's row 14 spill path and row 26 restart are the host's own retention and
recovery shapes; they were read, not instrumented.

## The installed desktop's own turn, and the two things it said (2026-10-05, third round)

The user restarted DSH Desktop at **11:26:20** (backend PID 13276, read from `Get-Process.StartTime`) and
sent `printf x; vim note.txt` into his own WSL session at **11:52:40**. My install of the current build
landed at **11:51:03** — after his restart — so that turn ran on the 00:43 bytes, and it read as a
failure of the fix when it was a failure of ordering. Recorded here because the ordering is now a check,
not an assumption: before asking anyone to restart, read the backend's start time and compare it with the
installed `lib` mtime.

The turn itself is worth more than the ordering mistake, because it is the first reading of **what a real
model actually sends** (his provider, `sensenova / deepseek-v4-flash`, so real tokens):

| field | reading from `session-b7b8f571…` |
| --- | --- |
| `agent-preset/selected` | `wsl-standard` — our variant, in his window |
| the model's call | `{"command":"printf x; vim note.txt","description":"Print x then open note.txt in vim",`**`"timeoutMs":15000`**`}` |
| the tool's body | `x` + `\u001b[24;1H"note.txt" [New]~ …` + `[stderr] Vim: Warning: Output is not to a terminal` |
| what that proves | not escalated (a pty has no `[stderr]` section and vim would not warn), so the first-word rule was defeated by the model's own `printf` — the same shape pass one measured at 121 703 ms |
| what the model did next | called `read /tmp/note.txt` → `not found`, then summarised in Chinese and completed the turn |

**The design fact it exposed.** A model names its own deadline. Under the rule as written — the 8 s bound
applies only when the call gave neither `tty` nor `timeoutMs` — that call would have been escalated by the
new per-segment rule and still have received a generic sentence instead of the non-interactive form, which
is the half of the requirement that says *provide the solution*. So the hint is now keyed to the **class**
and the deadline stays the caller's: we do not silently shorten what we were told, but a keyboard-class
timeout always says what to use instead. Two cells, 49 total now:

- `vim /etc/hostname` with `timeoutMs: 4000` → deadline stays 4000, hint present. Measured `{"ms":5104,"deadline":4000,"hint":true}` on both planes.
- `sleep 5` with `tty: true, timeoutMs: 1000` → the body may claim a restart only if the session reports one; the two sentences are produced from different facts and are asserted against each other. Measured `{"claimedRecovery":true,"actuallyRestarted":true}` — **an escalated timeout really does rebuild the session**, which is a cost of that tier worth knowing.

**What this pass did not measure.** It is one turn in one window on the *old* bytes; the new bytes have
not yet been driven through his desktop, only through the harness (49/49 both planes) and the scripted
session. Cross-instance isolation, a distribution without `script`, and `Defaults requiretty` remain
unmeasured.

## The same prompt, his desktop, before and after (2026-10-05 12:14)

He restarted the installed desktop at **12:12:54** (backend PID 9924, read from `Get-Process.StartTime`),
which is after the 12:08:41 install — the ordering check this time, not an assumption. He then sent the
identical line into the same WSL session (`session-b7b8f571…`, `wsl-standard`, his own
`sensenova / deepseek-v4-flash`). Turn 22 is the old bytes, turn 23 the new ones, same arguments:

| field | turn 22 — old bytes, 11:52 | turn 23 — new bytes, 12:14 |
| --- | --- | --- |
| the model's call | `{"command":"printf x; vim note.txt","timeoutMs":15000}` | identical, character for character |
| elapsed | 16 777 ms | 16 889 ms |
| `ESC[` sequences in the body | **26** | **0** |
| `[stderr]` section | present — which is the pipe talking | absent — a pseudo-terminal has one stream |
| `Vim: Warning: Output is not to a terminal` | in the body | gone: vim believed it had a terminal |
| what the notes said | timeout + a generic restart sentence | timeout + **the non-interactive forms to use instead** + restart/replay + `[1 detached process from the previous shell was stopped]` |

Turn 24, sent seconds later: `sudo true` with `timeoutMs: 30000` → **112 ms**, sudo's own three lines,
`[exit code: 1]`, and the note that there is nobody to type a password. That is the credential class
answering inside its budget in the real product, which is what the 10-04 clicks could not show.

**What this did not buy.** The wall clock did not drop, and it was never going to: the model named
15 000 ms and we now honour what we were told, so the 8 s bound is not applied to this call — the fix
moved the *content* of the answer, not its length. If the wait itself is the thing to shorten, the
honest options are a sentence in the tool description telling the model not to set a deadline for an
editor (copy, not judgement), or overriding a named deadline (we have decided against that twice: it is
the same shape as ignoring `run_in_background`). One residual: a single `\f` still survives the fold in
turn 23's body — cosmetic, and no cell claims it is stripped.

## The name lists are deleted: what the distribution actually reports about a waiting command (2026-10-05, fourth round)

Every claim in the three sections above about *which* commands get a pseudo-terminal — the 43 words, the
credential/keyboard/pager classes, the 8-second ceiling and its cap sentence — is **superseded** by this
section. They were drafted into an unreleased version, so nothing published ever carried them; the
measurements stay in the record because they are what justified each rule and each deletion.

The reason for the change is not taste about maintenance. Two of this ticket's own defects came out of
the lists (a scan that stopped at a hyphen, so `ssh-copy-id`/`ssh-keygen`/`redis-cli` were dead letters;
a decision that read only the first word, costing **121 703 ms** in a real session), and the property
they were approximating is directly observable: a command waiting for a keyboard can be *seen*, from
outside the shell, while the call is in flight.

### The premise, corrected

`src/host/wsl-bash-session.ts` and `src/host/wsl-bash-protocol.ts` both said the session has *no*
terminal, and that the repaint which broke the host's matcher was readline's `ESC[<n>X`. Neither is what
the artefacts show:

- `ps -o tty= -p $$` inside the session answers **`pts/1`** and `$-` is **`himBs`**, so the piped
  interactive shell does have a controlling terminal and job control. What the pipes replace is the
  terminal *as stdio*: the input side of that pts belongs to WSL, and nothing on this machine can type
  into it. A program that reads `/dev/tty` therefore **waits** rather than failing.
- The captured raw stream (`tailbytes.raw.txt`, 1 627 B) contains `ESC[K` x7, `ESC[2J`, cursor
  positioning `ESC[<n>;nH`, `ESC[m`, `ESC[25l` and literal spaces — and **no `ESC[<n>X` at all**. So what
  this protocol defends against is the measured shape (bytes between the digits and the newline: proved
  against the host's own `commandOutput()` — `:0 SP SP` never settles, `:0 SP` never settles, `:0 CRLF`
  settles), not a named erase recipe.

Both wordings are corrected in the source, in the two READMEs and in the changelog pair.

### What the readings look like (`D:\Temp\issue51-s0\v1c-report.txt`, `v1c-table.txt`)

Sampled through a sibling `wsl.exe` as the same user the session runs as, against the production session,
with the fields the shipped probe prints (`ps -o pid=,ppid=,pgid=,tpgid=,stat=`, `/proc/<pid>/wchan`,
`/proc/<pid>/schedstat`, the `fd` table).

| the command is | state | `wchan` | a terminal in its fds | CPU | classified as |
| --- | --- | --- | --- | --- | --- |
| `sh -c 'read x < /dev/tty'` | `S+`, `pgid == tpgid` | `wait_woken` | yes — reported as **`/dev/tty`**, not `pts/N` | flat | `terminal` |
| `sudo true` asking for a password, user plane | `S+` | `0` (unreadable) | unreadable (`links=[]`) | flat | `opaque` |
| the same, root plane | `S+` | `wait_woken` | yes, `/dev/tty` present; `/proc/<pid>/syscall` first field `0` = `read` | flat | would be `terminal` |
| `sleep 6` | `S+`, `pgid == tpgid` | `hrtimer_nanosleep` | no | flat | nothing |
| `getent` / `curl` on a dead host | `S` | `poll_schedule_timeout` | no | flat | nothing |
| `dd if=/dev/zero bs=1M count=800` piped to `sha256sum` | `Rl+` | empty, i.e. running | writing to a pipe | rising | nothing |
| `vim` on a pty this tool created | `S+` | `poll_schedule_timeout` | yes | flat | `own-terminal`, and only because the pty is ours |

`sudo` clears its dumpable flag, which is why its `/proc` entries are invisible even to its own owner;
that is the whole difference between the confirmed and the unconfirmable reading, and it is why the note
says which of the two it was rather than claiming a terminal read it did not see. Reaching the root plane
(`wsl -u root`, passwordless on this machine, 827–1207 ms per pass against 200–280 ms on the user plane)
would turn `opaque` into `terminal` and let `sudo` be caught in 1.2 s instead of 8 s. It is **not** used:
a diagnostic that needs privilege in order to be quick is a capability the plugin would be asking for to
save seven seconds, and the distribution's own answer arrives anyway.

### The cadence, priced and then bounded by the price

One probe pass costs **200–280 ms** with the small script and 400–600 ms with the fd and syscall columns
added; the first cold `wsl.exe` of a session costs 586–1251 ms. Hence the shipped numbers: first look
after **1.2 s** of silence, then at most every **500 ms**, and the unconfirmable window at **8 s** — the
ceiling this tool had already committed to for a keyboard wait, reused so the plugin does not quietly
invent a second one. Nothing about the wait can be decided from `state` alone: `sleep 6` and `sudo` on its
prompt are both `S+` in the terminal's foreground job, which is exactly the pair the rule has to separate.

### Does stopping it from outside keep the protocol in step? Yes, and better than the deadline

With the frame in flight, `SIGCONT -> SIGTERM -> (0.3 s) -> SIGKILL` to the pids the probe just named:

```
exit=1  timedOut=false  restarted=undefined  after 3669ms   (the call had a 30 s budget)
next call:  echo PWD=$PWD; echo ALIVE2=$((6*7))  ->  /home/ruler   ALIVE2=42
```

The frame still writes its own completion record, so **no rebuild and no replay** — the state the wedged
command left behind survives, which is strictly more than the deadline path preserves (it rebuilds the
shell and replays the journal). That is why the reaction is a stop-and-retry rather than a
report-and-continue.

### End to end, through the real tool (`v5-run.txt`)

| call | result | reading |
| --- | --- | --- |
| `sh -c 'read x < /dev/tty; echo GOT=$?'` | **2 342 ms, exit 0**, body `GOT=1`, note says stopped at 1 200 ms and re-run | `terminal` then retry |
| `bash -c 'read x < /dev/tty; echo GOT=$?'` | 2 205 ms, exit 0, `GOT=1` | caught without reading a single word |
| `printf 'x\n'` then the same read | 2 299 ms, body `x GOT=1` | bytes arriving first do not blind the probe |
| same command with `{timeoutMs: 60000}` | **2 233 ms** | a longer deadline does not buy the wait back |
| same command with `tty: false` | 2 344 ms, **exit 143**, note names the `/proc` field and the doors, **no second attempt** | the veto holds |
| `sleep 4; echo SLEPT_RIGHT` | 4 195 ms, exit 0, no note | quiet is not stuck |
| `sudo true` as `ruler`, no `tty` argument at all | **9 529 ms, exit 1**, sudo's own three lines plus the password note | `opaque` at 8 s then retry |
| `vim -u NONE -i NONE -n note.txt` with `tty: true` | 9 594 ms, **exit 137**, `own-terminal` note | bounded by evidence, not by a name |
| `tar -cf /dev/null /usr/bin` | 52 ms | untouched |
| afterwards: `echo ALIVE_$((6*7))` | 27 ms, `ALIVE_42` | the same shell, still alive |

The gate carries all of these as cells (`bash-session-real`, 51 -> **56 checks**), and each reactive cell
first reads whether *this* distribution has the premise at all (`ps -o tty= -p $$`) and prints which
branch it took — on a distro where `/dev/tty` cannot be opened, `read x < /dev/tty` fails at once and the
cell must not claim a wait was caught. Writing this machine's premise as a universal rule is the mistake
this file has recorded twice already.

### Three device bugs found on the way, each of which would have produced a false green

1. **The probe script did not parse.** Joining statement fragments with `'; '` produced
   `while … ]; do;`, which bash answers with `syntax error near unexpected token ';'`, exit 2 and **empty
   stdout**. Inside the session the failure was invisible: no rows looks exactly like "no process is
   waiting", so the whole layer was inert while every deadline cell still passed. Rewritten as one
   explicit line; the unit test now asserts that `do;`, `then;` and `else;` cannot appear, and the pass
   prints a completion sentinel (`DSH_PROBE_DONE`) which the session requires before trusting an empty
   result.
2. **Counting only `pts/` links missed `/dev/tty`.** `ls -l /proc/<pid>/fd` reports the redirect as
   `-> /dev/tty`, not as the pts it resolves to, so the confirmed rule could not fire for the one command
   built to test it. Now `grep -c -e pts/ -e /dev/tty`, and the test pins the pattern.
3. **The measurement device anchored the session shell once.** A cell that reached its deadline rebuilt
   the shell, after which the driver sampled a dead pid and reported "no processes" — which reads like a
   product finding. Re-anchoring per cell changed `sudo` from "no rows" to "`S+`, opaque, stopped at 8 s".
   A stale anchor is also why the compound editor cell first looked untouched.

And the honesty item that stays open: `ForegroundOutput` has no `restarted` field (the host's arm does not
either), so a driver can only see a restart through its note — the cell that reads `value.restarted` gets
`undefined` even when the body says the shell was rebuilt.

### Round five: the eight-second window is gone, and why eight was the wrong price

The 8 s window was the price of "we cannot see why this privileged process is silent". The price was
mispriced, because the premise was wrong: the process hides its `/proc` entries from *its own user*, not
from the distribution root. One more pass of the same probe, run as `wsl ... -u root`, reads `wchan`, the
fd table and the syscall of exactly those processes — measured in `v6-report.txt`: a root-owned child of
`sudo` shows `S ... w=hrtimer_nanosleep tty=0` to that plane, so "asleep on a timer" and "asleep reading
the terminal" are separable there, which is the discrimination the user plane cannot make for a setuid
program.

| reading | before | now | why it can be shorter |
| --- | --- | --- | --- |
| a terminal read seen directly | 1.2 s | **600 ms** | nothing else a `wait_woken` with a terminal among the fds can mean |
| a privileged wait (sudo's prompt) | 8 s | **1.5 s, and the witness usually answers inside it** | root reads the wait, so this is a reading rather than a silence to sit out |
| a program polling a pty this tool made | 8 s | **2.5 s** | the one reading where patience buys precision: `ssh` polls its socket and the terminal together |

| call, driven through the tool (`v5-run.txt`) | before | now |
| --- | --- | --- |
| `sh -c 'read x < /dev/tty'` | 2 342 ms | **1 760 ms**, stopped at 628 ms |
| `sudo true` as `ruler` | 9 529 ms | **2 412 ms**, stopped at 601 ms and confirmed through the root plane |
| `vim` with `tty: true` | 9 594 ms | **4 106 ms**, stopped at 2 913 ms |
| the veto case (`tty: false`) | 2 344 ms | **1 587 ms** |
| `sleep 3` with `tty: true` (a legitimate silent pty program) | 3 101 ms, untouched | 3 104 ms, untouched |
| `tar -cf /dev/null /usr/bin` | 52 ms | 46 ms |

The cadence was re-priced against the probe instead of guessed: first look at **600 ms**, every **400 ms**
for the first six looks, then every **2 s** — a pass costs 200-280 ms, so anything faster only queues
probes behind each other. A call that is working still pays **zero**: one byte arriving resets the timer.

**The shorter window immediately produced a false stop, which is why it was worth measuring.** With the
own-terminal window at 1.5 s, a legitimate `sleep 3` under `tty: true` was stopped at 1 549 ms — the
polling process was `script`, the wrapper *this tool* puts around a command for its own pty, not the
command. The fix skips that one process by name for an own-terminal reading (`comm=script`): skipping our
own wrapper, not guessing the user's command. The unit test pins the rule, and the cell that ran red now
reports `3 104 ms, exit 0, notes []`.

**What the witness costs, and what it asks for.** It is a diagnostic process run as root inside the
user's distribution: one pass per call, only when a privileged wait is suspected, reading `/proc` and
nothing else; and one failed attempt is remembered for the session, so a distribution without a usable
root account pays for that discovery once and afterwards falls back to the unconfirmable reading and its
1.5 s window. The note says which of the two happened — a certainty this tool cannot support is exactly
what the note channel exists to prevent.

### Round six: the answer stops waiting for the state record (2026-10-06)

Per-call cost against the two baselines, same command, five samples each, warm on all sides
(`D:Tempissue51-s0speed-report.txt`, `terminal-report.txt`):

| shape | median | what the number is made of |
| --- | --- | --- |
| one `wsl.exe … bash -c` per command | **222-236 ms** | the Windows process plus the WSL session, not the command |
| this tier before this round | **33 ms** | 20 ms poll interval + a 5 564-byte / ~25 ms state record awaited in every call |
| this tier now | **8 ms** | one frame round trip, woken on arrival, with the state record collected between calls |
| a person typing into an already-open terminal | **16 ms** | bash fork+exec plus the pty round trip |

Three changes, each measured before it was written:

1. **The state record leaves the critical path.** Every frame ends with an exit-code record and then a
   `#dsh-section` report of `export -p`, `PWD`, the pid, `alias -p`, `set +o`, `shopt -p` and the
   function count — **5 564 bytes and 25 ms of the shell's own work**, measured by running the same
   `{ … } | base64 -w0` under `date +%s%N`. Nothing a call answers needs it: it exists so a *future*
   rebuild can replay the shell. `readCompletion` now settles a call on the exit-code record alone and
   the state is drained between calls — and, when it matters, in `rebuild()` before the replay is built.
2. **The reader wakes on output instead of on a clock.** A fixed 20 ms sleep sat between every look at
   the buffer; `waitForOutput` resolves the moment stdout or stderr moves, with the timer only as the
   safety net for a deadline, a probe verdict or a death.
3. **The watchdog no longer blocks the reader.** A probe costs 200-280 ms, and awaiting it inside the
   read loop delayed every silent command by that much (measured: `sleep 3` answered 0.27 s late). It is
   fired and its verdict applied when it lands, guarded by `watch.settled`.

**Three defects surfaced, all by the gate, all of them invisible to the offline suite.** Each is worth
recording because each looked like something else:

- **stderr arrived one call late.** stdout carries the exit-code record and stderr carries half the
  answer, on two pipes with no ordering between them; settling on the record beat the command's own
  `echo oops >&2`, so the body read `(no output)` and the bytes landed in the *next* call's window. A
  timer-based grace was written first and failed too (it cannot tell "no stderr yet" from "stderr long
  over"). The fix is an event: the frame writes one NUL byte on stderr after the command and after the
  record, so "everything the command wrote on fd 2 has been written" is ordered by the writing process
  itself. The byte is dropped before the model could see it.
- **The first version of the marker did not run at all**: it was written after the frame's trailing
  `# __DSH_WSL_BASH_REC` comment, where bash treats it as comment text — found by tracing the frame and
  reading `stderr-end seen=false` on every call (the 100 ms budget was being spent every time).
- **The pid and the journal arrived one call late.** Nothing was wrong with the drain itself, but the
  watchdog needs the shell pid from the state record to look at anything, and it now lived in the
  *next* call's future. Measured through a raw session (`{shellPid:0, pending:true, out:0}` after the
  first call) and fixed where a wait is invisible: `start()` settles the bootstrap's tail before any
  user call, and `rebuild()` settles the replay's tail before the new shell takes work.

A fourth hazard was written and never shipped: the first cut consumed the previous window only when the
state record arrived, and a 200 000-line spill trims the buffer from the front — after a trim, the
record's offsets no longer meant anything, the drain never landed, and the next call's stdout window
began with the previous command's output (`stdout="25740
125741
…"` in a repro). Consuming the
window at settle and keeping the pending record at the head of the buffer removes the whole class: past
that point, offsets are only ever taken against a buffer that starts where the last consumption ended.

The gate carries all of it: 55 cells on two planes as two users, after this round as before it.

### Round seven: a live model found the case the cells could not (2026-10-06)

The run: this build installed into an isolated `DSH_HOME` (own port, its own web profile, `remove` then
`add`, with the installed chunk asserted to carry `wait_woken`), one session in the WSL workspace, one
prompt asking for four real things — report the environment and compute something; run a command that
waits for the keyboard; run `sudo`; run a quiet command — with the model free to choose every command.
Provider: his own free token-plan credential, read from `~/.dsh/.credentials.yaml` in-process and never
written to disk nor printed.

| call the model chose (first run) | wall clock | what came back |
| --- | --- | --- |
| `uname -r; grep PRETTY_NAME /etc/os-release; whoami; pwd; echo "13*7 = $((13*7))"` | 593 ms | real distribution data and 91 |
| `read -r line < /dev/tty; echo "line=[$line]"` | **31 282 ms — timed out, shell rebuilt** | nothing, and no note |
| `sudo id` | 2 125 ms | sudo's own three lines, plus the root-plane re-run note |
| `sleep 3; echo "exit=$?"` | 3 021 ms | `exit=0` |

The second call is the finding. Every cell here wrote `sh -c 'read …'`, which blocks a *child*; the walk
looked only at descendants; a builtin has none. Measured while it happens, the shell's own row is
`Ss+ pgid==tpgid wchan=wait_woken fd0=/dev/tty` with CPU flat — the same signature one level up — so the
shell is now in the walk, marked (between commands it waits on a pipe, which must not read as a wait).

The first attempt at freeing it was a guess, and it was measured wrong: `kill -INT` left the call running
to its deadline, because bash catches the signal and the read syscall restarts. What ships is the reaction
that works — the shell is stopped like any other wedged process (`CONT`, `TERM`, `KILL`), the session
rebuilds from its journal, and the tool re-runs the command on a terminal where the read meets
end-of-file. New cell, 56 total: `a builtin that reads the terminal is ended and re-run, not left to the
deadline`.

Four more defects were announced by cells while that landed: the stop set named every row in the sample
(the shell is now always in it, so a child reading its terminal dragged the shell along); the privileged
path took its stop set from the user-plane rows, where `sudo` shows `wchan=0 tty=-1` — the witness
confirmed the wait and the stop set was empty, so the call ran to its 25 s deadline; a watchdog-stopped
call was reported as `aborted`, the caller-cancel shape, which made the live gate abort its own run; and
one cell's regex was written `/LINE=[]/` — an empty character class that can never match — instead of a
string test, which is a reminder that a red cell has to be read for whose defect it is before anything is
changed.

Second run of the same prompt, after the fix: ① 513 ms; ② **3 104 ms**, body `read-exit=1 x=''` plus
`[the first attempt was ended by restarting the shell … after 606ms …]`; ③ `sudo -n id` 51 ms with
`sudo: a password is required`; ④ 3 040 ms — and the model's closing message quoted the note and
explained the difference between the two cases. Usage: two billed requests, 1 490 + 8 379 and
10 084 + 3 301 tokens (the file also records a first attempt whose 8 192-token cap was spent entirely on
reasoning and which produced no tool call — the failure his provider config documents).

### Round eight: the same eight-step task on three transports (2026-10-06)

"Normal dsh on WSL" is not a hypothetical: it is the host's own PTY tier — `dsh-terminal-bash` plus
`dsh-tool-bash-persistent`, pointed at this plugin's relay — which is what existed before this plugin
wrote its own shell, and the tier issue #51 was filed against. So the comparison is measurable:
one task, eight steps (make a directory, write a file, edit it, generate 200 lines, count them, tar
them, run a language runtime, clean up), each step one call, on three transports.

| arm | what it is | total | worst step | steps that never settled |
| --- | --- | --- | --- | --- |
| A | this plugin's `bash` (pipe session) | **390 ms** | 232 ms | **0/8** |
| B | the host's PTY tier — "dsh using WSL normally" | **86 785 ms** | 23 787 ms | **3/8** |
| C | a real terminal, typed into (`script -qec "bash -i"`) | **282 ms** | 120 ms | 0/8 |

Per step, arm B: `mkdir … && cd … && pwd` 23 787 ms **never settled**; `printf … > f.txt; wc -l` 20 265 ms
**never settled**; `sed -i …` 4 141 ms; `for i in $(seq 1 200) …` 23 709 ms **never settled`; `grep -c .` 4 115 ms;
`tar` 3 565 ms; `node -e` 3 610 ms; clean-up 3 593 ms. The three that never settled were bounded by this
driver at 20 s per step; in the product they run to the host tool's own `timeoutMs` (300 s by default),
which is the 303.8 s measured in the reporter's Desktop session.

Arm A's steps: 25-51 ms each, with `node -e` the slowest at 232 ms (a runtime starting, not the
transport). Arm C: 13-38 ms each, the 200-line loop the slowest at 120 ms.

Three things this does and does not say. (1) On a task like this one, arm A and a person's own terminal
cost the same order of magnitude — 8-50 ms per step against 13-38 ms — because neither waits for a
terminal to be scraped. (2) Arm B is not slow, it is *unreliable*: half its steps took the host's
idle-silence path (3.5-4.1 s) and the other three never completed at all inside 20 s. (3) Arm C's
typing time is the driver's, not a person's, and it ran its steps from `/mnt/d/…` while the others ran
in `~` — same commands, a different mount.

Report files: `D:\Temp\issue51-s0\three-arms-report.txt`, `speed-report.txt`, `terminal-report.txt`.

### Round nine: the keyboard door, driven through the tool the world mounts (2026-10-06)

The last gap in the ticket's contract was the class a pipe cannot answer: a program that asks a
question. Round eight priced the answer that existed — diagnose, stop, re-run on a one-shot
pseudo-terminal, read the complaint — and it ends with a person taking over. `wsl_terminal` is the
door that makes the answer *answerable*: the host's own PTY registry and `dsh-terminal-bash` backend
pointed at this plugin's relay, driven through the model-facing tool, with the agent's hands on the
keyboard.

Driven this time through **`ctx.tools.get('wsl_terminal')`** — the registry channel the model uses,
not a hand-call into the service — with a real `wsl.exe … bash -i` under the host's ConPTY, on a real
distribution, both build planes, as `root` and as `ruler` (66/66 cells each). Readings from the
`src`/`root` run:

- `open` **477–490 ms** (warm distribution), and the shell counted as a process: `bash -i` 0 → 1 in
  the distribution, which is the reading that separates "a real shell started" from "a welcome
  message was printed".
- **The keystroke cell**: `sh -c 'read x < /dev/tty; echo GOT=$x'` sent (1 235 ms — the send settles
  on the quiet window while the program waits), then `hello-from-the-door` sent (1 777 ms) — the
  screen answered `GOT=hello-from-the-door`. This is the thing the pipe cannot do and the one-shot
  pseudo-terminal cannot do either: nobody can type into the second one.
- `submit: false` typed `echo TYPED_NOT_RUN` without running it, and the next send's Enter ran it.
- **The user cell**: the workspace store named `root` for the door's own cwd while the distribution
  default on this machine is `ruler`; `whoami` in the door answered `root`. This is the relay reading
  the workspace store back, because the host builds a PTY child's environment itself and its
  `scrubbedParentEnv()` drops every `DSH_*` variable — measured, so the environment route is not
  available at all. On the `ruler` legs the two users coincide and the cell says so instead of
  claiming a discrimination it did not have.
- `SIGINT` was delivered to the foreground process group (9 ms) and ended a `sleep 30`; the shell
  survived it and answered the next command.
- `close` took the session and its shell down: `list` answered "no terminal is open" and `bash -i`
  went 1 → 0 — counted in the distribution, not read off the tool's own sentence.

**The cost shape, measured rather than promised.** Eight sends: `1762, 1277, 1764, 1281, 1762, 1733,
1218, 1729` ms — every one settled on the backend's quiet window, none on its 30 s deadline. The
host's quiet window is lowered to 1200 ms from its 3000 ms default (source note in
`src/host/variants.ts`), which is what turns the earlier 3.0–3.6 s reading into this one. Worth
recording honestly: **the host's fast prompt-recognition path did not fire in this run at all** — the
2026-10-05 V4 measurement saw it fire on some sends (75–136 ms) and not others (3.0–3.6 s), both on
this same machine and host build. That path compares the prompt tail six characters after the OSC
marker, a sibling of the comparison issue #51 is about, and it lives in the host's code: the gate
therefore asserts the computed answer and *reports* which path settled each send rather than requiring
the fast one, and the door's note names the difference to the model.

What this round does and does not say. It does: the door starts a real shell, a real program blocked
on `/dev/tty` receives typed bytes, the shell is the workspace's user, signals reach the foreground
process, and closing leaves nothing behind — on both planes and both users. It does not: that the
host's fast path is reliable (it is not, see above); that the door was driven inside a live Desktop
session (the chain driven here is the same host packages and the same relay the world mounts, and the
Desktop end-to-end from round seven covered the pipe tier, not this tool); or that the shape holds on
the other declared releases (the multi-version matrix has not been re-run on this tip).

### The stdin channel (2026-10-06, same day, four cells)

The protocol owns the session shell's stdin, so a command's stdin was `/dev/null` by construction.
That is right for most calls and fatal for the class that reads a program's input from a pipe, so the
call's `stdin` text now travels inside the frame and is decoded into a temporary file the command's
stdin is redirected from (removed after the exit status is read). The cells that matter are not "the
bytes arrived" but the two ways this could be worse than not having it: `cat` fed two lines printed
both **and the call still settled** (the command must not eat the record that ends the call — the
reason the channel exists at all is that the shell's stdin is the protocol), and the *next* call
answered normally (the session's own stdin was not consumed). On the escalated path the same input
arrives too — `read x; echo GOT=$x` under `script` answered `GOT=typed-by-stdin` in 306 ms, because
`script` forwards its stdin to the pty it creates. One byte over the 32 KiB ceiling refuses by name
(`wsl-bash: stdin is 32769 bytes, over the 32768-byte ceiling …`) with nothing run; the ceiling is
half the measured 64 kB frame point (a 64 kB command answers in ~3.8 s, 256 kB in ~59 s), and a
program fed half its input fails in ways that look like the program's fault, which is why the answer
is a refusal and not a truncation. The **background** arm was measured by actually running the job the
producer recorded (the registry double never calls `run()`): `cat` there printed
`FED_TO_BACKGROUND\nRC=0` and the job settled `completed`, so the one-shot executor — the same code the
host's own background arm uses — carries the input too. First version of that cell asserted on `''`,
because the producer's `readOutput()` is a rendered string (the registry's contract) and the cell read
it as the shell handle's `{delta}`. Recorded because the first run of these cells showed
`shell-init: error retrieving current directory` inside the escalated cell: the driver's earlier
relative-`workdir` cell leaves the session inside a directory a later cell deletes, and the *first new
bash* started there says so. The section now starts with a `cd` home and the line is gone — the
artifact was the driver's, not the channel's, and it was measured rather than assumed.

Found while adding the cells, and fixed in the same pass: `tests/host-profile-isolation.mjs` was red
on **Windows only**. Its two "a healthy frame says nothing / a failing source is reported once" cells
count `console.warn` output as failures, and the plugin legitimately warns once at boot on win32 when
its session probe has no `subprocess` service to probe with (`session probe skipped … mounted
unverified`) — a line the Linux CI never sees, because the whole win32 probe branch is skipped there.
The tree at `60354d5` (before this round) reproduces both reds; the cells now separate diagnostics
from failures, with the platform note attached to the constant.

### Round ten: his Desktop, a real model, an eleven-step development workflow (2026-10-06)

The strongest device this repository has is the one it cannot run itself: the user's own DSH Desktop,
with the plugin installed from this branch and a real model choosing the commands. He ran one prompt
— an eleven-step workflow (environment, `git init`/branch/two commits, heredoc scaffolding, 200
generated files with a `find | xargs sed -i` pass, a tar/sha256 bundle, word-frequency pipelines, a
15 s progress loop, a background job read twice and killed, `stdin`, the interactive cases, and four
boundary commands) — and the readings below come from the session transcript
(`~/.dsh/sessions/--wsl.localhost-Ubuntu-home-ruler--/session-76fd6b4b…/session.v4.jsonl.zstd`), not
from his summary.

Shape of the run: **29 tool calls, 481 s wall clock of which ≈45 s is tool time** — the rest is the
provider's own retries (nine `sensenova` retries on `EMPTY_RESPONSE`/`RATE_LIMIT`) and the model's
reasoning. Nine of the eleven steps passed on the first attempt; neither of the two that did not was a
plugin defect (below).

| step | what it did | reading |
| --- | --- | --- |
| 1 | environment + workspace dir | **762 ms** (first call, session boot included); `Linux 6.18.40.1-microsoft-standard-WSL2`, `ruler`, node v22.22.0, Python 3.10.12 |
| 2 | `git init`, two commits, branch, `log --graph`, `diff --stat` | **85 ms** |
| 3 | two scripts written by heredoc, `chmod +x` | **37 ms** |
| 4 | 200 `.log` files × 20 lines (CJK, quotes, `$`, backslash), `find \| xargs sed -i`, `grep -rl` = 200 files | **604 ms** |
| 5 | `tar czf` + `sha256sum` + `git status` shows no `dist/` | **42 ms** |
| 6 | word frequency, `wc -l`, a Node script and a Python script | **162 ms** |
| 7 | 30 × 0.5 s progress loop | **15 122 ms**, `exit=0`, not interrupted — the "merely slow" case stays untouched |
| 8 | background job appended to a file; two `job_output` reads; `job_kill` | start **55 ms**; both reads `(no new output) [status: running]` (the loop wrote to a file, so there was nothing on stdout to give); 35 lines before the kill, `tail -3` named them |
| 9 | `stdin` → `python3 -c '…sys.stdin.read()…'` | **85 ms**; 45 characters in, the same characters echoed back — the first real-model use of the channel |
| 10a | `read -r line < /dev/tty` | **3 084 ms**: stopped at **603 ms**, **the shell restarted** (the blocked process was the shell itself), re-run on a pty → `got:` empty; both facts in the note the model read |
| 10b | `sudo true` | **2 153 ms**: stopped at **623 ms** through the **root plane** — the note says why (`read through the distribution's root rights, because this process hides its own /proc entries from its user`) — re-run on a pty → sudo's own three lines, `exit=1`. **First real-Desktop confirmation of the root witness** |
| 10c | `wsl_terminal`: `open` → `python3 -i` → two expressions → `SIGINT` → `read` → `close` | **528 / 1 328 / 1 276 / 1 236 / 14 / 8 / 170 ms**. `1+1` → `2`, `print("ok" * 3)` → `okokok`, `SIGINT` → `KeyboardInterrupt` back at `>>>`, the screen re-read from the retained scrollback, close answered `[terminal pty-1 closed]`. **The door, on the real Desktop, in a real model's hands** |
| 11 | space+CJK filename, symlink, `echo hi!`, `seq 1 100000` | one failure, and it was the model's own command: `ln -s dist/target.txt dist/link.txt` makes a link whose target resolves to `dist/dist/target.txt`, so `readlink -f` exited 1 and the `&&` chain stopped — **correct shell semantics**, found and fixed by the model itself in the next two calls; `echo hi!` printed `hi!` (history expansion off), and the bare `seq` came back truncated with the spill path plus a 100 000-line copy it had written itself |

What it says, and what it does not. It says: the whole development-flow class works — pipelines, bulk
file generation and in-place editing, archives, hashes, git, interpreters, a slow command that is left
alone, a background job with the host's own `job_*` tools, `stdin`, the two keyboard-diagnosis paths
(including the root-plane one), the door end to end, and the boundary cases. It does not say: that a
password was ever typed (the machine's `sudo` wants one and nothing here holds it), that the door was
driven from outside this one workflow, or that the eleven-release matrix holds on this tip.

Two observations recorded rather than fixed: the door's screen carries the five `bash: export: … not a
valid identifier` lines his own rc file prints on an interactive start (reproduced under a plain
`wsl.exe -e bash -i` earlier the same day — his distro's PATH gains Windows entries with spaces), and
the door's prompt is the host's controlled `dsh>` rather than his own `PS1`, which is what makes a
send's prompt recognition possible at all. The model noticed both and worked around them; a person
sees the same lines in any WSL terminal on this machine.

Residue after the run, read from the distribution and from `tasklist`: `bash -i` **0**, `wsl-relay`
**0**, `node.exe` **0** — the door's shell and the relay were both gone, and the only shell left is
the session's own `bash --norc -i`, which is the session still being open.

## The outside run's three findings, measured here before any of them was believed or fixed (2026-10-06, eleventh round)

An adversarial re-run of this branch arrived as a file (67 independent cells, its author's own gate at
68/71, the eleven-release matrix at 17/20). It claimed three defects. None of them reproduced on this
machine as described, and one of them could not: this distribution is Ubuntu 22.04, which ships no
`/etc/profile.d/80-systemd-osc-context.sh`. So each claim was measured here before a line was written,
and the first was reproduced by **simulating the profile that takes the contract away**, in a scratch
`HOME` (`/tmp/dsh-relay-guard-<pid>`, removed at the end of the same script).

**Finding 1 — the readiness contract depended on the distribution's startup files leaving it alone.**
Four arms, each running the relay's own command shape and asking the inner interactive shell what it
actually inherited:

| arm | command | `PROMPT_COMMAND` exported into the inner shell | `133;D;` on the wire | prompt |
|---|---|---|---|---|
| 1 | old, hostile profile (the 26.04 shape) | `0` | no | the distribution's own |
| 2 | old, benign profile (what this machine is) | `1` | yes | `dsh> ` |
| 3 | **new, hostile profile** | **`1`** | **yes** | **`dsh> `** |
| 4 | new, no contract bridged at all | `0` | no | its own — the guard is inert |

The mechanism, measured on this machine directly: `PROMPT_COMMAND=x; PROMPT_COMMAND+=(y)` then export
answers `0` — bash does not export arrays — while `unset` first answers `1`. A plain re-assignment
without the `unset` also answers `0`, because assigning to an array writes element `[0]` and keeps the
array attribute. That is why the relay now bridges the value a second time under
`__DSH_READINESS_PROMPT_COMMAND` (a name no startup file has a reason to touch) and re-asserts it
between the login pass and `exec`. The consequence the report described is real and was confirmed by
reading: a session whose contract never arrives still gets the pipe-driven `bash` (which needs no
prompt at all), while `wsl_terminal` pays its quiet window on every keystroke.

**Finding 2 — the function snapshot's 64 KiB cap was applied to the whole dump.** The report's
distribution has 86,954 bytes of startup functions, so every function in the shell — the one the model
had just defined included — was thrown away. Costs measured here first, in a shell that has sourced the
same rc files the session sources:

| what | reading |
|---|---|
| startup set on this machine | 91 names, 61,881 bytes (under the cap by 3,655) |
| the `sort`/`comm` set difference against a recorded baseline | 7 ms |
| a walk of all 91 bodies one at a time | 150 ms |
| snapshot emitted when nothing of the user's is defined | 0 bytes |
| snapshot emitted after one user function | 68 bytes |
| snapshot emitted with 120 kB of user functions present | 64,039 bytes, the rest named |

The snapshot now carries only the functions the distribution's own files did not define (a rebuilt
shell re-sources those, so replaying them proved nothing), budgets them one at a time, and names what
does not fit. The 150 ms walk is paid only on a frame whose function count moved; an ordinary call still
pays the comparison alone, which is why the loop lives in a helper the bootstrap defines rather than in
the frame that goes out on every call.

**The fix itself introduced a defect, and the live matrix caught it.** The first version read function
names by cutting the prefix off `declare -F`. With `set -o allexport` in effect — which one of the
existing cells turns on, in the same call that defines the function — bash prints `declare -fx name`, so
every name came out as `declare -fx name`, every function looked new, the lookup found no such name, and
the snapshot came back empty. Run through the frame shape directly, that reads as:

```
probe again: RCFLINES=92 NOW=96 NEW=declare -fx dshafter declare -fx dshrealfn2 declare -fx dshrealfnC dshrealfn
```

Names now come from `compgen -A function`, both in the baseline and in the snapshot, so a flag change
cannot make the two sides disagree. Same three cells after the switch: the defining call's note reports
`dshhugefn(70025)` by name and `dshsmallfn` comes back; `alias, function, shopt and set options survive
a restart` carries `FN_OK_9` again; and a new cell — the builtin that reads the terminal, which rebuilds
the shell inside the starve handling — now puts `not restored: functions dshhugefn2(70026)` in the body
of the call that asked for the terminal, instead of losing it with the first attempt.

**Finding 3 — a rebuild that had something to report was not believed by the cell that checks it.** The
note renders as `was restarted and its directory …` when nothing was left out and `was restarted; not
restored: …` when something was, and the check matched only the first form, so on a reporting machine
the claim and the fact were both true and the cell still read them as disagreeing. Both forms count
now, and the count that guards a short run moved with them: `EXPECTED_CHECKS` is 72.

**What this round does not claim.** The four-arm table simulates the offending profile rather than
running on a distribution that ships it, so `conpty-relay` on a 26.04-class machine is still unproven
here; the eleven-release matrix has not been re-run on this tip; an *override* of a function the
distribution itself defines is still not restored (the count does not move, so no snapshot is asked —
the same behaviour as before this change, now written down); and the door on this machine settles on the
quiet window even though the controlled prompt is on the screen, which is the host's own matcher not
firing on a typed send, not the contract failing to arrive — recorded, not chased, and the tool says
which of the two happened on every send.

**The gates this round re-ran after the three fixes**, on the same machine and distro as the tables
above: `bash-session-real` **72/72 on all four legs** (`src`/`lib` planes × `root`/`ruler` users — the
count moved from 71 because the starve-reporting cell is new), `tool-bash-real` 10/10 and
`bash-parity-real` 12/12 on both planes, unit 195 (194 pass, 1 skip), node bucket 85/85, win32 51/51,
docs parity 11/11, profile isolation PASSED, typecheck 209 = baseline, `lint:portability` rc 0. The
three cells that were red on the outside machine and the two this branch made red on the way are all
green here: `alias, function, shopt and set options survive a restart` (answers `FN_OK_9`),
`a function over the cap is named, and the others still come back` (names `dshhugefn(70025)`, keeps
`SMALL_OK_6`), and `a rebuild triggered by a terminal wait reports what it could not restore` (the body
of the call that asked for the terminal carries `not restored: functions dshhugefn2(70026)`).
