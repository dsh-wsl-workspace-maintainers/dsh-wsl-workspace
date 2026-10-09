# Slimming analysis at v0.7.7

Point-in-time inventory of what this repository carries, measured against the commit named below,
for the question "what has grown, and what is cheap to stop carrying". It is a findings document:
no line of `src/`, `lib/` or `package.json` was changed by the pass that produced it.

Evidence labels, same as [engineering-review-0.7.5.md](./engineering-review-0.7.5.md) uses:

- **(A) measured** — a command printed this number in the session that wrote this file.
- **(B) read back** — a claim from the 0.7.5 review re-checked here against the current tree.
- **(C) asserted, not measured** — reasoning stated so the next reader can attack it.

| Item | Value |
|---|---|
| Frame | `origin/main` = `a903147 docs: the hard rules as standards…`; PR #65 = `976a0ba` (open, not merged, not in these numbers) |
| Moment | 2026-10-09 (UTC+8) |
| Tracked bytes | 5,735,959 B (A) |
| Largest single member of the published artifact | `image-3.png`, 2,024,242 B (A) |
| Verdict | 82% of the published tarball is screenshots plus a second copy of `src/` (§2); the source tree's *growth* is mostly prose, not code (§3) |

## 1. How every number here was taken

```bash
git ls-files | xargs wc -c                          # area bytes
git ls-tree -r --long <ref> -- src | awk '{s+=$4} END{print s}'   # src bytes at a past frame
npm pack --dry-run --ignore-scripts --json          # tarball members, committed lib/ (no rebuild)
node -e '…for each lib/*.map: sum(sourcesContent)'  # the second copy of src (§2)
```

The cross-file duplication scan in §6 is a one-off over `git ls-files`, not a committed tool: it
normalizes whitespace, hashes every run of ≥6 consecutive non-trivial lines, and reports runs that
appear in two or more files. It lives in the session's scratch directory; §6 names its output, so
the finding can be re-derived by any reader who wants to argue with it.

`--ignore-scripts` is deliberate: `prepack` rebuilds `lib/`, so a pack that runs it compares a
rebuild against itself. The published 0.7.5 tarball was also fetched and listed
(`registry.npmjs.org`, 2,444,274 B) to check that the member set here matches what users receive.

## 2. 82% of the published artifact is screenshots and a second copy of `src/` (A)

Packing the committed tree of `main` today:

| Case | tarball | unpacked | members |
|---|---|---|---|
| A — as shipped | 2,749,491 B | 4,139,284 B | 79 |
| B — minus `image-2.png` + `image-3.png` | **662,390 B (−75.9%)** | 2,053,050 B | 77 |
| C — B, minus `src/` | **487,056 B (−82.3%)** | 1,493,045 B | 47 |
| D — C, minus `lib/*.map` | 267,018 B | 768,916 B | 32 |

Three facts fall out of that table.

**2.1 Two screenshots are 75.9% of every install.** `image-3.png` is 1542×918 px RGBA, 2,024,242 B;
`image-2.png` is 446×568, 61,992 B. They are PNG (already deflated), so they pass through the
tarball's gzip essentially uncompressed. Their only consumers are the nine READMEs, two references
each, and the alt text is still the placeholder `alt text`; nothing in `src/`, `lib/`, `tests/`,
`scripts/` or `ci/` reads them. They are in `package.json` → `files`, so every
`npm install dsh-wsl-workspace` and every `dsh plugin add` that resolves through npm pulls 2.09 MB
of screenshots. The published 0.7.5 tarball carries both files, unchanged in size.

**2.2 `src/` is shipped twice, in the same tarball.** `files` includes `src` (30 files, 560,005 B),
and the 15 `lib/*.map` carry `sourcesContent` summing to **563,561 B** — the same TypeScript text
inlined. A debugger reads the inlined copy; nothing loads `../src/*.ts` from an installed package
(grepping `src/` paths out of `lib/` and `cordis.patch.yml` returns nothing). So dropping `src` from
`files` costs no debuggability, and dropping `sourcesContent` from the maps while keeping `src`
costs the same — the pair is the redundancy. The two removals add up exactly:
`image-2 + image-3 = 2,086,234 B` and `src/ = 560,005 B` is `2,646,239 B unpacked`, which is case A
minus case C in the table above.

**2.3 `docs/` does not ship; `TESTING.md` does, on purpose.** `docs/README.md:30` records that
`TESTING.md` is in `files` deliberately, so it stays at the repository root. There is **no comparable
record for `src` or the images** — they are the two entries whose presence was never decided in
writing. That is the honest framing of 2.1/2.2: not "wrong", but undecided.

What this is *not*: the artifact-identity contract (`scripts/verify-artifact-identity.mjs`, three
packs must hash the same) is indifferent to the member set, and `files` is not derived from anything,
so changing it is a one-line edit with no gate to satisfy — which is exactly why it needs a written
decision rather than a reflex.

## 3. Source growth is prose, not logic (A)

| Frame | `src/` bytes | of which comment bytes | share |
|---|---|---|---|
| `430c259` (0.7.6 release commit) | 310,602 B | 126,892 B | 40.8% |
| `main` today | 560,005 B | 262,484 B | 46.9% |

Between those frames `src/` grew 249,403 B, of which **135,592 B (54%) is comment bytes** — both
figures taken with the same command (`git ls-files src | xargs cat | grep -cE '^\s*(//|\*|/\*)'` for
lines, the same grep through `wc -c` for bytes). The line view agrees: 4,334 of `src/`'s 11,767 lines
are comment lines (36.8%), and `tests/` sits at 22.6%. Byte counts here are UTF-8 bytes; a character
count on the same files reads ~1.3× lower, which is the Chinese prose rather than a discrepancy.

This is not a defect — the convention here is that the reason for a rule lives next to the rule
(`docs/standards.zh.md`). Two consequences follow anyway:

- **The prose has its own failure modes.** The largest comment blocks are file headers of 30–51
  lines (`src/shared/relay-node.ts` 51, `src/host/wsl-search.ts` 41, `src/host/wsl-relay.ts` 36). A
  51-line header is a document, and documents in code are invisible to the docs gates:
  `check-docs-parity.mjs` reads READMEs and CHANGELOGs only, so nothing notices when a header
  contradicts `docs/compatibility-evidence.md`.
- **Some of that prose is machine-read, so it cannot just be deleted.** `tests/parity/derive.mjs`
  parses `src/**` to pull constants and object bodies, and `tests/parity/claims.mjs` pins 7 watched
  constants plus the panel's version label against them. `docs/CHECK-CATALOG.md` cites source
  **line numbers** (16 rows do). So prose trimmed out of `src/` must be re-cited in the same commit,
  or the catalog starts pointing at the wrong lines — silently, because no gate checks those
  citations (C).

## 4. The release narrative has five homes, and only two of them are compared

The same #51 story (~303 s hangs, the nonce record, `wsl_terminal`, the PTY comparison tier) is
written out in: `CHANGELOG.md` (latest entry 5,445 B / 5,421 characters), `CHANGELOG.zh.md` (latest
entry 1,802 B), `README.md` (23,006 B, longest line 6,771 characters), `README.zh.md` (21,523 B), and
`src/client/locales.ts` — whose five help-panel texts are **12,262 characters across the two
dictionaries**: `help.news.body` 1,070 zh / 2,895 en, `help.usage.body` 1,437 / 2,989,
`help.known.body` 1,086 / 2,202, plus titles. All `help.*` literals together are 12,722 of that
file's 16,603 characters — 77% of it (the file is 21,609 B at 1.30 B/char, because the copy is
Chinese). A grep for the marker `303` hits CHANGELOG×2, README×2, locales×2, evidence×3 (A).

What already guards this (B, and it is more than the 0.7.5 review recorded):

- `docs-parity` compares the CHANGELOG pair for release count and newest-version equality with
  `package.json`;
- `panel-names-the-version` asserts both dictionaries' `help.news.title` name the package version;
- `tests/locales.test.ts:26-33` caps every panel bullet at 320 characters;
- `docs-parity` refuses hard-coded versions in a README's Changelog section.

What no gate compares: **the substance** of the four prose bodies. The 0.7.5 review's item 3
(generate `help.news.*` from the newest CHANGELOG entry) is still the open one — it would remove the
duplicated 5.8 KB and would need the 320-character rule moved into the generator.

## 5. Re-audit of the 0.7.5 ranked list, against today's tree (B)

| # | 0.7.5 item | Status now | Measurement / reason |
|---|---|---|---|
| 1 | Repoint the four `*-real` drivers at `lib/` | **paid, and beyond it** | `scripts/compatibility/` holds 12 `.mjs` drivers (19 files counting the PowerShell and shell helpers); 8 of them resolve their module through `scripts/compatibility/plane.mjs`, and CI runs the src and lib planes as separate jobs |
| 2 | Reduce seven condensed READMEs to pointer stubs (≈290 lines / 96 KB) | open, and bigger than when it was written | the seven are now 68 lines each — **476 lines, 125,490 B** — and `check-docs-parity.mjs:39-73` carries 7 `FILES` entries for them |
| 3 | Generate `help.news.*` from the newest CHANGELOG entry | open | see §4; the version label is now *asserted*, which does not deduplicate it |
| 4 | Single-source the reproduced host formatters | open | `src/host/wsl-search.ts:511-653` is still 143 lines, still guarded only by `scripts/check-rank-parity.mjs` comparing two integers |
| 5 | One `src/shared/coord.ts` for the Windows↔Linux coordinate chain | **partly paid, differently** | the ad-hoc `replace(/\\/g,'/')` spellings the item named are gone from `src/fs.ts`/`src/shell.ts`/`src/host/wsl-relay.ts` (0 hits); the path spellings now live in `src/shared/paths.ts` |
| 6 | Collapse `defaultDistro`/`defaultDistroSync`, the two YAML unquoters, `messageOf` | open, and now evidenced | both distro readers still exist; PR #65 had to apply the same `encoding:'buffer'` fix **twice**, once per reader (that is the item's whole argument, paid in a red frame) |
| 7 | Merge the three wsl-variant-id regexes | **partly paid** | `isWslVariantId` exists (`src/host/variants.ts:548`) and `src/index.ts:846` calls it, but `src/index.ts:896` still inlines `/^wsl(-[a-z0-9-]+)?$/` |
| 8 | Extract the shared preset fixtures (≈250-300 lines) | open | `STANDARD`/`MINIMAL` blocks are in 4 files (`host-declare.mjs`, `host-materialize.mjs`, `host-profile-isolation.mjs`, `variants.test.ts`); §6's scan finds identical runs between two of them |
| 9 | Delete `tests/smoke-built.ts` (177 lines) | **paid by generation, not deletion** | the file is no longer tracked; `scripts/make-smoke-built.mjs` writes it in CI, so the duplicate is now build-time instead of committed |
| 10 | Delete `scripts/repro-e2e.mjs`, `scripts/repro-setup.sh` | not acted; they are cited now | both are referenced by `TESTING.md`, `docs/CHECK-CATALOG.md` and `tests/wsl-skills.test.ts` |
| 11 | Untrack `ci/deps/package.json` | open, and it bit | still tracked (27 lines); the pins it mirrors moved without it, so CI ran `npm ci` → out of sync → fallback on every job (§6.3) |
| 12 | Delete the `paths` block in `tsconfig.json` (18 lines) | open | still at `tsconfig.json:28`, still pointing at `../../vendor/…`, which exists in no checkout of this repository |
| 13 | Delete `verify-lib`'s source-plane lint rule and rank-parity's skip mode | **paid** | neither rule remains (`verify-lib.mjs` has no unused-import pass; `check-rank-parity.mjs:67` now says "This is a failure, not a skip") |

Score: 4 paid (1, 5 partly, 9, 13), 2 partly paid (7, 10 changed shape), 7 open.

## 6. New duplication found by mechanical scan (A)

A run-scan for identical blocks of ≥6 normalized lines over `src tests scripts ci` returned 26
groups. Three groups are worth acting on; the rest are import blocks and `finally { rmSync(…) }`
clutter that would cost more to share than to repeat.

**6.1 The npm-spawn helper, three private copies.** `runNpm` exists in `ci/install-pinned.mjs:27`,
`scripts/verify-install.mjs:46` and `scripts/verify-artifact-identity.mjs:45`. On `main` two return
`.status ?? 1` and one returns the child's whole result object. PR #65 rewrote all three to return
the object — and left `verify-install.mjs`'s two call sites comparing the result with `!== 0`,
an object never equals `0`, so the publish gate failed while `npm pack` succeeded. That frame
(#166) is the item's evidence: the divergence was not stylistic, it was the contract between copies.
PR #65 also pastes a second helper, `npmCliPath`, into all three files; two of the three copies have
zero call sites (3 definitions, 1 used) (A).

**6.2 The host-package search path, ten spellings.** `[repoRoot/node_modules, repoRoot/ci/deps/node_modules]`
is written out in 10 files (`bash-parity-real`, `tool-bash-real`, `installed-copy`,
`check-host-prompt-parity`, `check-rank-parity`, `host-profile-isolation`, `parity/derive`,
`wsl-bash-parity.test`, `ci/install-pinned`, `bash-session-real`), and `m.default ?? m` in 5.
`scripts/compatibility/bash-session-real.mjs:239`'s sibling in `tests/support/w51-command-census.mjs`
carried the failure mode that keeps this list interesting: it reached for a host module by an
absolute path to one machine, which passed locally and red on both lib-plane jobs.

**6.3 Pins without a lock.** `ci/pinned-deps.json` declared 24 pins while `ci/deps/package-lock.json`
declared 19 in its root block — five names missing (`cordis-plugin-include`, `-group`, `-loader`,
`dsh-home-paths`, `dsh-launch-environment`). `ci/install-pinned.mjs` answers that by falling back to
`npm install` and printing "commit the refreshed ci/deps/package-lock.json"; every job in frames
#165–#168 took that branch. PR #65 refreshes the lock (24/24), which closes the fallback but not the
shape: nothing *asserts* pins↔lock agreement, so the next pin bump repeats it (C).

**6.4 Small dead ends.** Seven exported names have no consumer outside their own file —
`FUNCTION_SNAPSHOT_CAP_BYTES`, `STATE_SECTIONS`, `stateReport` (all `src/host/wsl-bash-protocol.ts`),
`WslSandboxProvider`, `registerGuidance`, `statusOf`, `LINK_RESOLVE_CONCURRENCY` — each is used 1–4
times inside its file and 0 times in `src`/`tests`/`scripts`/`ci` elsewhere.
`scripts/compatibility/Bootstrap-Tools.ps1` (19 lines) is referenced by nothing at all.
`docs/engineering-review-0.7.5.md` (474 lines) is referenced once, by this index, and describes a
superseded frame — it belongs in `docs/archive/` by the rule stated at the top of `docs/README.md`.

**6.5 Two quoting dialects, each with a named helper and a pile of inline copies.** The YAML
single-quoted scalar is written once as `yamlScalar()` (`src/index.ts:79-81`, with its reason in the
header above it) and **11 more times inline** as `replace(/'/g, "''")` in `src/host/variants.ts`.
The POSIX single-quote escape (`replace(/'/g, `'\\''`)`) is written once as `quote()`
(`src/host/wsl-relay.ts:48-50`) and once inline at `src/shell.ts:279` (A). This is 0.7.5 item 6 seen
from the other side: it is not only that two distro readers exist — the *dialects* they and the
variant writer speak are declared in one place and re-typed in another.

## 7. Ranked actions

Order is by (bytes or lines removed) ÷ (risk admitted). Nothing here is applied in this document.

1. **Drop `image-2.png`, `image-3.png` and `src` from `package.json` → `files`.** −2,646,239 B of
   shipped bytes (2,086,234 + 560,005); tarball 2,749,491 → 487,056 B, i.e. −82.3% (measured, §2). Admits: the npm page's screenshots
   depend on how the registry resolves a relative README image — unverified here, so the safe form is
   to switch the nine READMEs to absolute raw URLs in the same commit, or to keep the images at the
   repository root and simply stop shipping them. Needs a decision, not a cleanup: it changes what
   users install.
2. **One npm-spawn helper module** used by `ci/install-pinned.mjs` and both `verify-*.mjs` scripts;
   delete the three copies and the two dead lookups. ~90 lines. Admits: the hazard A/E assertion
   (`tests/tech-debt-exposure.test.ts`) and `check-portable-spelling` scan call sites by file, so the
   exemption markers must move with the code — which is *also* what makes this worth doing.
3. **Assert pins↔lock instead of falling back.** A short check in `ci/install-pinned.mjs`: if
   `npm ci` reports a pin missing from the lock, say which name and fail, unless the pins were
   deliberately re-blessed. Adds lines; removes the class where every CI job silently resolves a
   different tree from the one the lock names. *(fix, not shrink.)*
4. **Move `docs/engineering-review-0.7.5.md` to `docs/archive/`** with the banner this repo's own rule
   requires, and register the successor. −474 live lines. Admits: its "nothing acted on" status line
   has to be rewritten as superseded-per-item, using §5 of this file as the successor.
5. **Reduce the seven condensed READMEs to pointers** (item 2 of the 0.7.5 list, still the largest
   prose win in the repo: −476 lines / −125,490 B, plus 7 `FILES` entries). Admits: no native-language
   behaviour notes; `docs-parity` must be edited in the same commit or it reddens on its own skeleton
   rule.
6. **Generate `help.news.*` from the newest CHANGELOG entry** (0.7.5 item 3): the pair it replaces is
   3,965 characters (1,070 zh + 2,895 en, §4), and the ≤320-character bullet rule moves into the
   generator. Admits: hand-tuned panel phrasing.
7. **Derive the unit-bucket file list** instead of enumerating 21 paths in `package.json`
   (`test:unit` names 19 files under `tests/` and 2 under `scripts/`). Admits:
   `scripts/check-unit-closure.mjs` and `tests/script-reachability.test.mjs` both read that literal
   list, so the derivation must land before the list goes, and the closure gate keeps its meaning
   only if it walks the derived set.
8. **Collapse `defaultDistro`/`defaultDistroSync`** (0.7.5 item 6) — 45 lines and one class of
   "fixed in one place only", the class that cost frame #166.
9. **Single-source the two quoting dialects** (§6.5): move `yamlScalar()` out of `src/index.ts` into a
   shared module and use it at the 11 inline sites in `src/host/variants.ts`; let `src/shell.ts:279`
   call the POSIX quoter `src/host/wsl-relay.ts:48-50` already names. 13 sites, no behaviour change if
   the escaping is byte-identical. The witness that a merge can be checked against exists —
   `tests/host-materialize.mjs:272` pins the literal line `name: 'WSL · Standard mode（标准模式）'` in
   the generated preset — but it carries no apostrophe, so **the escape branch itself is unexercised**:
   a merge that breaks only `'`-containing names would stay green (A). If this item is taken, it owes
   that apostrophe case as part of the same commit.
10. **Un-inline `src/index.ts:896`** onto `isWslVariantId`, and extract the preset fixtures to
    `tests/fixtures/presets.mjs` (0.7.5 items 7 and 8, both still open).
11. **Delete the seven `export` keywords with no consumer, and `Bootstrap-Tools.ps1`.** 7 keywords and
    one 19-line script. Admits: an export is a promise to the next test, so this is the one item here
    that could be wrong for reasons nobody can see today.

## 8. What looks like bloat and is not

- **The comment mass in `src/`** (§3) is the project's stated convention, and part of it is parsed by
  `tests/parity/*`. Shrinking prose here is a documentation decision with a machine consumer, not a
  trim.
- **`lib/` in the repository** (1,133,696 B, 31 files) is the committed artifact plane: issue #44 §1
  made it the thing that ships, and `verify-lib-sync`, `verify-artifact-identity` and the whole
  src/lib matrix test design stand on it.
- **`ci/deps/package-lock.json` (363,397 B)** is the largest tracked file after the screenshots and
  is load-bearing for `npm ci`; the finding in §6.3 is that it is not *checked*, not that it should
  go.
- **The 9-file i18n README set** — English and Chinese are authorities, and the condensed seven are
  what makes the plugin legible to the users who filed #47 and #49. Item 5 is a trade, not a fix.
- **`tests/` at 12,610 lines** is 1.6× the shipped `lib/` JS by bytes (648,580 B against 409,567 B of
  `.js` excluding maps) and 22.6% comment; the reachability gate confirms every file in it is run by
  something (§7 item 7's constraint).
