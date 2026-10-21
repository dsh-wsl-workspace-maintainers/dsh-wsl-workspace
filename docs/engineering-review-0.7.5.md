# Engineering review at v0.7.5

Point-in-time review of the repository as published in the plugin version `0.7.5`, recorded against the commit named in the Frame section below. It is a findings document, not a task list: nothing here is scheduled, and no line of `src/` was changed by the pass that produced it.

Evidence labels used throughout:

- **(A) measured** — a command in this session printed the number or the line.
- **(B) read back** — reported by a reviewer subagent, then confirmed here by reading the cited source lines.
- **(C) inferred** — reasoned from the code, not exercised.
- **(U) untested** — the mechanism was read but never run.

Claims that this document withdrew or corrected are quarantined in [Withdrawn during the pass](#withdrawn-during-the-pass) so nobody copies them forward.

## Frame

| Field | Value | How obtained |
|---|---|---|
| Commit | `c8c4185` (`Merge pull request #42 … docs/governance`) | (A) `git log -1` |
| Remote state | local `main` equals `origin/main` at `c8c4185`; `git status --porcelain` empty | (A) `git fetch --all --prune`, `git status -sb` |
| Version | `0.7.5` | (A) `package.json` |
| History span | 82 commits, `2026-08-14T21:25:23+08:00` … `2026-09-30T21:17:56+08:00` | (A) `git rev-list --count HEAD`, `git log --reverse --format=%cI`, `git log -1 --format=%cI` |
| Single-day concentration | 34 of 82 commits carry a `%cI` date of `2026-09-30` | (A) `git log --format=%cI \| grep -c '^2026-09-30'` |

Every date in this document is `%cI` (committer date). Document-written timestamps were not used as evidence anywhere.

## Verdict

The source is careful and heavily commented; the *verification apparatus* is the young part of the tree and it is aimed at a different object than the one the package ships.

- The CI orchestration is brand-new and unaired. `.github/workflows/ci.yml` is 176 lines, all of them dated `2026-09-30`, and 143 of those come from one commit (`b01d525`). **(A)**
- The gates that need a real distribution do not read the published artifact. Every `*-real.mjs` driver imports `../../src/*.ts` under `--experimental-strip-types`, so `lib/index.js`, `lib/wsl-search.js` and `lib/wsl-jobs.js` — the bytes the harness actually loads — are never executed under WSL in CI. **(A)**: `scripts/compatibility/fs-real.mjs:10-11`, `scripts/compatibility/search-real.mjs:10`, `scripts/compatibility/skills-real.mjs:7`, `scripts/compatibility/relay-real.mjs:10`.
- The one gate that compares the shipped bundle against its source detects *modified* tracked files only, and history shows the failure it is meant to catch happened at least twice. **(A/B)** — see [The committed `lib/`](#the-committed-lib).

## Headings, each traceable to one decision

| # | Finding | Evidence | Strength | Which decision it weakens | Cheapest next step |
|---|---|---|---|---|---|
| 1 | Real-WSL gates exercise `src/`, not the published `lib/` | `scripts/compatibility/fs-real.mjs:10-11` and the three sibling drivers | (A) | "the cloud frame is green" is read as "verified under real WSL" | repoint the drivers' imports at `lib/` |
| 2 | `lib/` drift gate is blind to added and deleted files | `.github/workflows/ci.yml:33-40` (`git diff --quiet -- lib`); grep for `git status`/`--porcelain`/`ls-files` across `scripts`, `ci`, `.github` → no hits | (A) | a clean clone can install a `lib/index.js` that imports an untracked file | `git status --porcelain -- lib`, placed before any build step in that job |
| 3 | `compat.yml` interpolates free-text input into a single-quoted shell argument | `.github/workflows/compat.yml:12-15` (`type: string`), `:105` `bash scripts/verify-dsh-compat.sh '${{ matrix.version }}'` | (A) shape; (U) exploit | a dispatched value containing a quote alters the command the runner executes | pass the value through `env:` and use `"$VERSION"` |
| 4 | The typecheck gate counts, and counts zero when it never ran | `ci/typecheck-baseline.json` (`errors: 212`); `scripts/typecheck-gate.mjs:19-24` reads only stdout/stderr and never `tsc.status`; the sibling `scripts/verify-install.mjs:46` does use `?? 1` | (A) + (B) reproduction of ENOENT → 0 errors → exit 0 | 212 type errors are institutionalised, and head-room is bought by any unrelated decrease | fail on non-zero `tsc.status` before comparing counts |
| 5 | One compatibility verdict can never be written | `scripts/verify-dsh-compat.sh:17` (`set -uo pipefail`) vs `:77` (`"$Version"`, undefined) | (A) + (B) probed shape | the evidence ledger can lose an install failure silently and skip the remaining versions in that call | `$VERSION` |
| 6 | A wrong-version host tree installs green | `ci/install-pinned.mjs:111` fails only on the literal `MISSING`; `:112` prints `pinned: <name>@<want> -> <got>` and never compares them | (A) | every prerequisite of bucket B (`npm run test:node`) | three lines: compare and fail on inequality |
| 7 | `verify-lib` has no floor | `scripts/verify-lib.mjs:272-289` iterates entries and asserts nothing about how many it saw; an empty `lib/` prints `verify-lib OK: 0 lib entries` and exits 0 | (A) | "the artifact plane was verified" | assert the entry count against the entry points declared in `tsdown.config.ts` |
| 8 | The dialog has a dead control and two unstyled classes | `src/client/AddWslWorkspace.tsx:293` `onClick={() => setError(null)}` re-clears without re-fetching; `.dww-action--wide` (`:175`) and `.dww-feedback` (`:339`) have zero rules in `src/client/styles.ts` (`grep -c` → 0); `src/client/api.ts:65` throws `envelope.error` with no fallback and the file never inspects `response.ok` | (A) | his stated bottom line: a visible action must actually act, and a failure must render something | re-run the open flow from Retry; check `response.ok`; one real-DOM read as the gate |
| 9 | The release narrative has four正本 and no gate compares any pair | `CHANGELOG.md:5` (0.7.5 entry), `CHANGELOG.zh.md`, `src/client/locales.ts:45` (zh `help.news.body`) and `:93` (en); `:44`/`:92` hard-code the version label, and grep for `manifest.version` in `tests/` hits only `scripts/check-docs-parity.mjs:205` | (A) | a forgotten bump ships a help panel advertising the previous release | generate `help.news.*` from the newest CHANGELOG entry |
| 10 | The documentation gate measures shape, not fact | eight of nine READMEs are exactly 67 lines (`README.md` 79, `README.zh.md` 73); `README.ru.md` is 21468 bytes but 13385 characters, i.e. *shorter* than English — the byte count is Cyrillic encoding (1.60 B/char vs 1.01); reviewer deleted a compatibility pointer and added an undeclared `README.it.md`: both stayed green | (A) skeleton; (B) mutations | "the seven translations are on the current facts" | keep en+zh as正本, reduce the other seven to pointer stubs (≈ −290 lines / −96 KB) |

## Structural violations

Not bugs — shapes that make bugs cheap to write and expensive to notice.

- **Two implementations of one routine, asymmetric about failure.** `src/shared/wsl.ts:143-158` (async, decodes through `textOf`) and `src/shared/wsl.ts:171-189` (sync, `String(buffer)`, cached forever in the module-level `syncDefaultResolved`/`syncDefault` at `:161-162`, and it swallows its own failure). A default-distro change is invisible for the host's lifetime. **(A)**
- **Two YAML unquoters that disagree.** `src/host/variants.ts:283-289` collapses `''` back to `'`; `src/host/wsl-skills.ts:558-566` only strips the outer pair. The scalar `name: 'it''s'` therefore unquotes to two different values depending on which path reads it. **(A)**
- **`messageOf` declared three times verbatim.** `src/index.ts:182`, `src/shared/wsl.ts:18`, `src/shared/relay-node.ts:84`. **(A)**
- **One 1166-line module carrying seven jobs, landed as one commit.** `src/host/wsl-search.ts` holds in-distro script templates, raw-output framing, a glob→RegExp compiler, re-implementations of the host package's output caps, path resolution, process running and tool registration. `git blame` attributes 1165 of its 1166 lines to a single commit (`d701fbe`); distinct blame commits = 1. `src/index.ts` by contrast has 14 distinct blame commits — an unreviewed surface versus a stabilization cost. **(A)**
- **A write that has no effect.** `src/host/variants.ts:442-443` sets `sawEditor` and `sawSearch` inside the row loop, and `:462-463` recomputes both unconditionally from `source.includes(...)`, a substring test that also fires on comments and config values. **(A)**
- **Truncation before ordering.** `src/index.ts:252-255` slices `readdirSync` output to the first 1000 entries and only then sorts directories first, so past 1000 entries the directories a sort would have surfaced can be dropped entirely. **(A)**
- **Unbounded resources next to bounded ones.** `src/host/wsl-skills.ts:618` `detectors` has no cap and eviction never clears its `setInterval` (`:738-758`), while the neighbouring `cache` is LRU-capped at 32 (`:709-713`). **(B)**
- **Validation on one plane only.** The wire path rejects a bad distro name (`src/index.ts:143`, `:174-179`), while the read path feeds `parseWslUnc(cwd).distro` straight into `-d` (`src/host/wsl-search.ts:751`, `:791`). **(B)**
- **A copy of the host's private formatters.** Roughly 140 lines (`src/host/wsl-search.ts:511-653`) reproduce output-shaping that lives in `@deepseek-ai/dsh-tool-fs-search`, guarded only by `scripts/check-rank-parity.mjs`, which compares *two integers* from *one* resolvable host build — not the eleven declared releases, and not rank semantics. **(B)**
- **Four version lists, authority declared only in prose.** `package.json:51-63` (11 releases), `ci/compat-window.json:3` (3), `scripts/compatibility/versions.json:2-20` (17), `ci/pinned-deps.json:4-24`. No code compares any pair; `scripts/compatibility/Prepare-Case.ps1:11` rejects the three releases the current CI matrix installs. **(B)**

## The test layer: full green, real gap

Two distinct mechanisms, both present.

**The stub cannot fail the way the host fails.** `src/index.ts:559` returns `true` from the persistent-shell probe when the `subprocess` service is absent (`subprocess?.spawnTerminal === undefined`), and the fake context in `tests/host-materialize.mjs:229` declares every optional service absent. So the two host integration tests always take the persistent-shell branch, and `tests/host-declare.mjs:222` asserts that the terminal's `shellPath` equals `process.execPath` with backslashes replaced by forward slashes — under the test runner that value is node, so the assertion is satisfied by the same fact that makes it blind. Issue #40 was exactly "the host's `execPath` is not a usable interpreter". **(A)** for the lines, **(B)** for the consequence.

**Coverage tracks file size backwards.** The offline suites test pure helpers and tool registration; the fragile execution branches live behind a live distribution. `grep -c 'SIGKILL\|runInDistro\|killSignal' tests/wsl-search.test.ts` → 0, while the spawn/kill code sits at `src/host/wsl-search.ts:825-854` (`killSignal: 'SIGKILL'` at `:836`). `grep -rn 'utf16' tests/` → one hit, `tests/exec-shape.mjs:42`; the decode branch at `src/shared/wsl.ts:102` has no offline test. Process timeout and cancellation of the bash executor has no offline assertion at all — only `tests/shell-extra.mjs:19-27`, which needs a real distro. **(A)**

**Fixtures read the product's current constants.** `tests/wsl-skills.test.ts:415` asserts a count of 64 (the skill-root budget) and `:642` asserts 32 (the per-lookup link cap); `tests/host-materialize.mjs:351` asserts a config key count of 2. Legitimately widening a constant breaks the suite with no product bug. **(B)**

**Subset and full runs share output names.** `tests/smoke.ts:42` and `tests/smoke-built.ts:43` both target `/tmp/dsh-wsl-smoke.txt`; `tests/shell-extra.mjs:6` defaults to the same `/tmp/dsh-wsl-compat` tree used by every `scripts/compatibility/*-real.mjs` driver, and `tests/shell-extra.mjs` contains no removal call (`grep -n 'rm\|cleanup'` → no hits), so a previous round's directory can be read as this round's state. **(A)**

**Harness grouping does not track platform dependence.** `package.json:21-22` puts the pure in-memory `wsl-skills` suite in `test:win32` while `docs/CHECK-CATALOG.md` bucket A records why (`path.join` shapes differ per platform), and `tests/relay-node.test.mjs:119-133` spawns the real interpreter inside that "deterministic" bucket. **(B)**

**Preset fixtures are triplicated.** The same `STANDARD`/`MINIMAL` preset blocks appear in `tests/variants.test.ts:15-90`, `tests/host-materialize.mjs:22-87` and `tests/host-declare.mjs:34-85`; a bespoke `assert(cond,label)` helper is declared in three files (`tests/host-materialize.mjs:241`, `tests/host-declare.mjs:159`, `tests/exec-shape.mjs:28`). Roughly 250-300 lines of test text are one fixture written three times. **(B)**

## Is there an end-to-end test?

**No executable one. Three things fill the slot, and they are not equivalent.**

1. `scripts/repro-e2e.mjs` is named end-to-end (`:1`) and is described as carrying assertions in two registers: `TESTING.md:102` says "four assertions print" and `docs/CHECK-CATALOG.md:84` says "(4 printed assertions)". The file contains no `assert`, no `throw` and no non-zero exit — `grep -cE 'assert|throw|exit' scripts/repro-e2e.mjs` → 0 across its 34 lines. It prints a listing (`:18-33`) and the operator reads it. It is also referenced by no npm script and no workflow. **(A)**
2. The `*-real.mjs` drivers do assert, and they do run end-to-end against a real distribution — but against `src/`, on Windows-only runners, behind a distro that CI provisions from a third-party action. They are the closest thing to an E2E suite, and they never see the shipped bytes (finding 1). **(A)**
3. `docs/CHECK-CATALOG.md:86-95` bucket F, "Still human": the W button, the picker being non-empty by eye, the mode picker landing on `WSL · <mode>`, F5 persistence, and a six-item frontend pass per release. The end of the product — the GUI the user clicks — is verified by a person, per release, undocumented in automation. **(A)**

So the automated chain covers *host wiring* and *distribution behaviour*, and the gap is precisely where they meet: nobody drives `GUI → HTTP api → cordis plugin → lib/ → wsl.exe → distro → 9P share → GUI` as one asserted pass on the committed artifact.

## Silent failure: yes, in three distinct shapes

**Shape 1 — a guard that exits 0 when its own prerequisite is missing.** This is the highest-severity class in the repository because it produces a green frame with no measurement behind it.

- `scripts/typecheck-gate.mjs:19-24` counts `error TS\d+` lines in the captured stdout only. If `node_modules/typescript` is absent the spawn yields nothing, the count is 0, `0 < 212` reaches the "below baseline" branch (`:47-48`) and the process exits 0. A reviewer reproduced the ENOENT shape and observed `errors counted: 0`, exit 0. **(B)**
- `scripts/verify-lib.mjs:272-289` prints `verify-lib OK: 0 lib entries` and exits 0 for an empty or absent `lib/`. **(A)**
- `scripts/check-rank-parity.mjs:46-54` exits 0 with a warning when the host package is not resolvable, and `:61-69` skips a comparison when the host bundle no longer declares the constant; only `--strict` converts either into a failure. CI passes `--strict` (`package.json:23,25`); every documented local invocation of the non-strict mode is a green skip. **(A)**
- `ci/install-pinned.mjs:111` treats "wrong version" as success (finding 6). **(A)**
- `scripts/verify-dsh-compat.sh:77` cannot record its failure verdict at all (finding 5), and `:69`/`:87`/`:93` build paths through `cygpath`, which does not exist off Windows; a failed command substitution yields an empty `DSH_HOME` and the script continues. **(B)**

**Shape 2 — the product catches a failure and renders "nothing happened".** These are user-visible and they contradict the repository's own rule that a fix must leave a working path rather than a silent one.

- `src/index.ts:320-325` collapses any `statSync` error (EACCES, EBUSY, a stopped distribution) to `{ exists: false }`, so the dialog offers "create" over a directory it merely could not stat. **(A)**
- `src/host/wsl-skills.ts:448` maps a read failure to `undefined` and `src/shared/links.ts:31-34` never throws, so a broken share presents as an empty skill catalog. **(A)**
- `src/fs.ts:278` and `src/fs.ts:431` resolve `lstat` failures to `undefined` via `.catch(() => undefined)`. **(A)**
- `src/client/api.ts:65` throws `new Error(envelope.error)`; when the host returns `{ok: false}` without a message the thrown `message` is empty, `src/client/index.ts:201` and `:239` pass it through, and `src/client/AddWslWorkspace.tsx:290-292` renders an empty bordered error box while the dialog stays open. **(B)**
- `src/index.ts:766` and `:806` retire variants with `void Promise.resolve(retire()).catch(() => {})`, and the fire-and-forget wrapper at `:771-802` logs only `messageOf(error)`; the un-awaited host calls at `:625-653` carry no timeout, so a hung roster never rejects and never logs. **(B)**
- `src/client/AddWslWorkspace.tsx:128` swallows the description request into `null`, and `src/client/index.ts:287`, `:304`, `:339` each end a chain with a bare `.catch(() => {`. **(A)**

A grep-derived tally of `} catch` sites in `src/` whose first following line is a bare closing brace, `return undefined`, `return {}` or `return null` returned 20 matching lines out of 50 total `catch` occurrences; the tally is a search shape, not a verified defect count. **(A)** for the numbers, no strength for "these 20 are all wrong".

**Shape 3 — encoding and parsing that lose information without a trace.**

- `src/shared/wsl.ts:102` chooses UTF-16LE by probing for a NUL byte. It is the only place in `src/` that does this; every other consumer takes UTF-8 (`grep -rniE 'utf16|ucs2' src/` → `src/shared/wsl.ts` only). **(A)**
- `src/host/wsl-search.ts:841` decodes wsl.exe's stderr with `toString('utf8')` unconditionally. Decoding UTF-16LE that way does **not** drop the NUL bytes — measured here, the result re-encodes back to the original bytes (`Buffer.from(text, 'utf8').equals(buffer)` is true), so nothing vanishes and the symptom is not "shorter text". What is lost is the content: the 300-character detail budget spends half of it on NULs (a 645-character first line arrives as 150 readable characters), and every substring judgement after it (`INVALID_PATTERN` at `:886`) can never fire, because `Unmatched` is spelled `U\0n\0m\0a…`. Which stream carries the UTF-16LE is build-dependent: measured on this machine (Win10 19045 + WSL 2.1.5) wsl.exe puts its own human-readable diagnostics on **stdout** as UTF-16LE with an **empty stderr** (exit 127, 128 bytes), while its `<3>WSL (n) ERROR:` lines are UTF-8 on stderr — so on this build the reachable harm at that call site is worse than garbled: `acceptRun` reads only stderr and throws the reason away. Both halves have red tests now (`tests/search-run-fakes.mjs` §6b/§6c). The WSL1 runner's stream shapes are unverified. **(A, measured 2026-10-01)**
- Capability is decided by string-matching an error message in `src/index.ts:582-584`, by `grep --version | grep -q GNU` in `src/host/wsl-search.ts:120`/`:159`, and by regex over `reg.exe` text in `src/shared/wsl.ts:148`, `:153`, `:178`, `:183` — while genuinely capability-based probes exist at `src/index.ts:432-438` and `src/host/wsl-jobs.ts:140-144`. The tree does not consistently trust one method. **(A)**
- `src/shared/links.ts:11-16` documents that `wsl.exe` truncates an argument containing a double quote; `buildWslArgv` (`src/host/wsl-search.ts:785-798`) routes the model's search pattern through that same surface without the mitigation the links path uses. **(C)**

## The committed `lib/`

`lib/` is tracked and published verbatim so that a git clone installs without a build (`.gitignore:1-4`, `.gitattributes:13` `lib/** -text`). Everything below exists to keep that one decision honest.

- It is the largest churn sink in the tree: 32 non-merge commits touch `lib` (`git log --no-merges --format=%h -- lib | wc -l`). **(A)**
- Five commits changed `lib/` with no `src/` change in the same commit: `7553d69`, `bcd12bb`, `c2e383c`, `b3c3f22`, `c3be1fd`. **(B)** — enumeration loop over `git log --no-merges --format=%H`, comparing the two pathspecs' file lists per commit.
- Two of them edited `lib/*.js` while touching no `.map`: `e0ce516` (`lib/index.js` +63/−1, `src/index.ts` +75/−1, no map entry) and `78e9849` (three `lib/*.js`, no map entry). A real build emits maps, so those bytes were not produced by a build of that commit's source. Whether they were typed or copied is not something history can show. **(A)** for the numstat, **(C)** for "hand-written".
- `c3be1fd`'s own message states it: *"lib was hand-patched earlier … the quote-escaping typo in the hand-patch is gone"*. **(B)**
- The only drift gate is `.github/workflows/ci.yml:33-40`, a byte compare of tracked `lib/` after a rebuild. `git diff --quiet -- lib` is silent about untracked additions — a reviewer demonstrated `?? lib/b.js` with exit 0 in a scratch repository — so adding an entry point to `tsdown.config.ts` without committing its output, or deleting `lib/`, is green. No gate anywhere checks this: grep for `git status`, `--porcelain` and `ls-files` across `scripts`, `ci` and `.github` returned no results. **(A)** for the grep, **(B)** for the demonstration.
- The publish path does not pass the artifact gate: `package.json:28-29` runs `prepack` → `build` (which rewrites `lib/`) and `prepublishOnly` → `verify:install` only. `verify:artifact` is not in that chain, so published bytes are the publish machine's build. **(A)**

## Maintenance-cost reductions, ranked

Ranked by lines removed against risk admitted, and only where the change makes the repository smaller or single-sourced. Items marked *(fix, not shrink)* add lines and are listed because they remove a class of failure rather than a file.

1. **Repoint the four `*-real.mjs` drivers at `lib/`** *(fix, not shrink)*. Four import lines. Removes the gap between "the WSL gate is green" and "the shipped bundle works under WSL". Admits: the drivers then depend on a build having run in that job, which `ci.yml:135` already does.
2. **Delete the seven condensed READMEs down to pointer stubs.** ≈ 290 lines and ≈ 96 KB of prose, plus seven `FILES` entries in `scripts/check-docs-parity.mjs:39-73`. Their behaviour notes are already incomplete relative to the English authority (one recorded instance: `README.ja.md:42` omits a documented scan bound that `README.md` and `README.ko.md:42` state). Admits: no native-language behaviour notes. The gate keeps its meaning — those seven already carry no release list.
3. **Generate `help.news.*` from the newest CHANGELOG entry.** ≈ 3.6 KB of literals in `src/client/locales.ts:44-45` and `:92-93`, and it deletes the only version string no gate checks. Admits: hand-tuned panel phrasing; the ≤320-character rule in `tests/locales.test.ts:31` must move into the generator.
4. **Single-source the reproduced host formatters** (`src/host/wsl-search.ts:511-653`, ≈140 lines) by having `@deepseek-ai/dsh-tool-fs-search` export them, which also removes the drift guard they exist to be checked against. Admits: blocked if upstream cannot export; today `scripts/check-rank-parity.mjs` is the only guard and it compares two integers from one build.
5. **One `src/shared/coord.ts` for the Windows↔Linux coordinate chain.** Three copies of the same tail (`src/fs.ts:207-217`, `src/shell.ts:286-297`, `src/host/wsl-relay.ts:51`) plus three near-clones inside `src/fs.ts` (`:220-226`, `:392-399`, `:418-425`); ≈ 50 lines removed. `fs.ts` and `shell.ts` are not twins — `diff` reports 782 of 902 lines differ — so only the coordinate and error-text seams are shared. Admits: nothing behavioural if the `FsError` wrapper stays at the fs boundary.
6. **Collapse `defaultDistro` and `defaultDistroSync`** (`src/shared/wsl.ts:143-189`) onto one query taking a runner; merge the two YAML unquoters onto `src/host/variants.ts:283`; put `messageOf` in one module. ≈ 45 lines, and it removes two classes of "fixed in one place only".
7. **Merge the three wsl-variant id regexes** so the cleanup in `src/index.ts:710` calls `isWslVariantId` (`src/host/variants.ts:472-473`). They have already drifted in acceptance of a bare `wsl`. Admits: none.
8. **Extract the shared preset fixtures** into `tests/fixtures/presets.mjs` (≈ 250-300 lines). Admits: nothing if the moved strings stay byte-identical.
9. **Delete `tests/smoke-built.ts`** (177 lines) — it is `tests/smoke.ts` with two import swaps, produced by `scripts/make-smoke-built.mjs`; one flag in `smoke.ts` replaces the generator and the committed-artifact signal that `verify-lib` and `tests/client-lifecycle.test.mjs` already carry. Admits: the explicit "src-import silently broke bundling" probe.
10. **Delete `scripts/repro-e2e.mjs` (34 lines) and `scripts/repro-setup.sh`
    (48 lines)**, and correct `TESTING.md:102` and `docs/CHECK-CATALOG.md:84`.
    Nothing references either script, they cannot fail, and the behaviour they
    demonstrate is asserted by `tests/wsl-skills.test.ts` plus
    `scripts/compatibility/skills-real.mjs`. Admits: losing the manual issue-#10
    scaffold.
11. **Untrack `ci/deps/package.json`** (27 lines) — regenerated in place by
    `ci/install-pinned.mjs:44-47`; a stale copy is invisible because the only
    content gate diffs `lib/`. Admits: none.
12. **Delete the `paths` block at `tsconfig.json:26-43`** (18 lines). Every entry
    targets `../../vendor/…` or `../../packages/…`, which exist only inside the
    harness monorepo; in any checkout of this repository they convert the typecheck
    baseline into module-resolution noise, which is what makes the number 212
    meaningless. Admits: one rebaseline, and genuinely hidden type errors surfacing.
13. **Delete the source-plane lint rule in `scripts/verify-lib.mjs:255-267`**
    (13 lines) — unused-import detection, already covered by `noUnusedLocals`
    (`tsconfig.json:21`) — and the non-strict skip mode of
    `scripts/check-rank-parity.mjs:46-54` (9 lines) with its `TESTING.md` entry.
    Admits: a stale import list in `src/` shipping unnoticed.
14. *(fix, not shrink)* **Client correctness** ≈ +25 lines: derive one `phase`
    union instead of twelve `useState` flags (`src/client/AddWslWorkspace.tsx:88-101`),
    make Retry re-run the open effect (`:293`), check `response.ok` and add a
    timeout (`src/client/api.ts:46-67`; grep for `AbortController` across
    `src/client` → no hits), call `refreshWorkspaces()` on the existing 60-second
    timer (`src/client/index.ts:309` is its only call site; `:355` refreshes only
    the roster), and add a class-name cross-check between `src/client/styles.ts`
    and the TSX (it would fail today on the two classes named in finding 8).
15. *(fix, not shrink)* **Make the host stub able to fail**: inject a fake
    `subprocess` whose `spawnTerminal` rejects with the inspection-unsupported
    message so `apply()` exercises the one-shot fallback offline (≈ 15 lines), and
    split `tests/relay-node.test.mjs:119-133` (which spawns the real interpreter)
    out of the deterministic bucket.

## Corrections after the pass

Three judgements above were wrong or over-extended once the apparatus was actually run and the CI environment was reasoned about properly. They are corrected here rather than deleted, and the versions in the published issue #44 carry the same corrections as a follow-up comment.

1. **Finding 2 / "The committed `lib/`" — "`git diff --quiet -- lib` is half-blind in CI" was wrong about the venue.** A CI job checks out `HEAD` into a fresh tree, so no untracked file can exist there, and deletions of tracked files *are* reported by `git diff`. The scratch-repository demonstration (a `lib/b.js` untracked with `git diff --quiet` exiting 0) is valid but only proves the **local** case. The genuine holes are: `verify-lib.mjs` had no floor (an empty `lib/` printed `OK: 0 lib entries` and exited 0 — still true, measured), and the **publish path** runs neither drift check, because `prepublishOnly` was only `verify:install` (`package.json:29`) while `prepack` rebuilds. So the right fix is a local/publish gate (`scripts/verify-lib-sync.mjs`, now wired into `prepublishOnly`), with the `ci.yml` step placed before the rebuild as a cheap committed-tree assertion — not a claim that CI was blind to untracked files.
2. **§4 "the stub cannot fail the way the host fails" — the venue was mis-stated, and the real shape is worse than described.** I wrote that "on a win32 runner both tests silently default to persistent shell". `tests/host-materialize.mjs` and `tests/host-declare.mjs` run in `runtime-tests` on **ubuntu**, where `src/index.ts:557` (`process.platform !== 'win32'`) short-circuits before the probe is ever called — so the CI frame does not merely take the wrong branch, it **never executes the probe at all**. Consequence for the repair: the fallback is testable offline by redefining `process.platform` before `apply()`, which is how `tests/persistent-shell-fallback.mjs` now covers it (24 labelled assertions, plus a mutation control that flipped `=== void 0` to `!==` in `lib/index.js` and produced 8 failures).
3. **§5 "Is there an end-to-end test?" — I under-credited `scripts/compatibility/host-api.mjs`.** It is not an assertion-free printer: it performs 12 probes, each checking `response.ok` plus a semantic verifier (`:14-31`), and sets `process.exitCode = 1` on any failure (`:34`). What it lacked is a floor — `[].some(…)` is false, so a run that probed nothing printed `0/0 checks passed` and exited 0, the same no-floor class as `verify-lib`. That is now fixed and measured (`0 probes -> RED … expected 12`, rc 1). The §5 conclusion is unchanged: it is wired to no CI job, because it needs a booted harness.
4. **A claim of mine that survived testing.** `cd ci/deps && npm ci --dry-run` exits 0 with `up to date`, so the reviewer argument that the lock file's root entry (19 dependencies) cannot satisfy `ci/deps/package.json` (20) and therefore `npm ci` never runs was false, and stays withdrawn above.

Nothing else in this document was re-graded. Items whose evidence was `(A) measured` here were re-measured on this frame; `(C)`/`(U)` items remain unproven and are still labelled as such.

## Withdrawn during the pass

- **"The deterministic install branch of `ci/install-pinned.mjs` is dead code, because `ci/deps/package-lock.json` cannot satisfy `npm ci`."** A reviewer derived this from a real observation — the lock's root entry declares 19 dependencies while `ci/deps/package.json:4-24` declares 20, with `@deepseek-ai/cordis-plugin-include` absent from the lock root — and from it concluded `npm ci` must fail. Measured here: `npm ci --no-audit --no-fund --dry-run` in `ci/deps` reports `up to date` and exits 0. The 19-versus-20 difference is real; the conclusion drawn from it is not. Do not reuse that argument. The adjacent finding that survives is the missing version comparison (`ci/install-pinned.mjs:111`).
- **"UTF-16 mis-decode produces null-laced mojibake."** — and the sentence that "corrected" it, which claimed Node *drops* the NUL bytes. Both are wrong, and I wrote the second one. Measured here: decoding UTF-16LE as UTF-8 is lossless and reversible (852 bytes → 852 characters, `Buffer.from(text, 'utf8').equals(buffer)` true; every NUL is still there). The real harms are the halved detail budget, the substring tests that can never match, and an operator reading text with a gap between every letter. Reproduced as red tests in `tests/search-run-fakes.mjs` §6b, and pinned as a claim guard in `tests/wsl-output-decode.test.ts` ("keeps every byte and costs the reader something else").
- Reviewer figures replaced by measurements taken here: `src/host/wsl-search.ts` blame attribution is 1165 of 1166 lines to `d701fbe` (not 1166), `src/index.ts` has 14 distinct blame commits (not 15), and the unreachable-commit tally across stale remote branches is 17 branches holding 54 commits (not "17 branches, 53").

## Untested when this was written

- The `compat.yml` interpolation (finding 3) is proven as a shape only. No workflow was dispatched and `main` was not touched.
- The UTF-16 stderr path (`src/host/wsl-search.ts:841`) was read, not run, when this review was written; it is exercised now, offline, by `tests/search-run-fakes.mjs` §6b/§6c, and the stream shapes around it are recorded as measurements in `docs/CHECK-CATALOG.md` (bucket D). predicted symptom is inference.
- Whether the missing `tsc.status` check has ever produced a green frame in this repository's CI is not established; only the code path and a reproduction of its shape outside the repository.
- Bucket F (`docs/CHECK-CATALOG.md:86-95`) is unmeasured by construction, and no browser pass was performed in this session, so no DOM reading backs finding 8 — the two unstyled classes and the dead Retry were read in source.
