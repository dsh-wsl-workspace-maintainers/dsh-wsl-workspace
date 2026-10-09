# Documentation index

Where each document lives, what language it is in, and whether it still describes
the current build. Naming rule: `kebab-case`, with a `.zh` suffix when the text is
Chinese (English carries no suffix). Superseded documents move to
[`archive/`](./archive/) unchanged — the banner at the top of each one names what
replaced it.

| Path | Language | What it is | Status |
|---|---|---|---|
| [design.zh.md](./design.zh.md) | zh | Design decisions and round-by-round history (M1 → fifth round) | Background; two claims it makes were reversed later — see its header |
| [standards.zh.md](./standards.zh.md) | zh | **提交之前必须成立的硬规则**（S1–S8）：假绿的三种形态、`node --check` 的边界、还债必须同提交改账本、`lib/` 与 `src/` 同步、类型基线、推送前的检查清单。每条都对应本项目真实发生过、且本可本地拦下的失败 | Active; read this before committing |
| [lessons.zh.md](./lessons.zh.md) | zh | **按 tag 取用的经验库**：13 个 tag（假绿、运行时引用、账本、CI 红循环、CI 延迟、真机强度分级、本机环境、协作…）。顶部有索引表，`grep '<tag>'` 定位后**只读那一节** | Active; read on demand |
| [CHECK-CATALOG.md](./CHECK-CATALOG.md) | en | The single inventory of every test, gate and manual pass: command, prerequisites, CI home, and what still needs a human | Active — added by #41, and it lists this index's own gate in bucket A |
| [compatibility-evidence.md](./compatibility-evidence.md) | en | Per-release verification evidence, appended run by run | Active |
| [tty-triage.md](./tty-triage.md) | en | Triage sheet for `bash` calls: which symptom belongs to the pipe, to the pseudo-terminal, or to the host's PTY tier, with the one re-run that settles each | Active — every line it names is asserted by a cell in `scripts/compatibility/bash-session-real.mjs` |
| [bash-parity.md](./bash-parity.md) | en | The ledger of every difference between this plugin's session `bash` and the host's own `bash` tool, each row naming whose behaviour it is and what the user sees | Active — read by `tests/wsl-bash-parity.test.ts` and `scripts/compatibility/bash-parity-real.mjs`, which fail when a difference is undeclared or a declared one disappears |
| [engineering-review-0.7.5.md](./engineering-review-0.7.5.md) | en | Point-in-time review of the `0.7.5` frame: findings graded by how they were measured, the end-to-end and silent-failure catalogues, and the ranked cost reductions | Snapshot at `c8c4185` — its 13 ranked reductions are re-audited against today's tree in [slimming-analysis-0.7.7.md](./slimming-analysis-0.7.7.md) §5 |
| [slimming-analysis-0.7.7.md](./slimming-analysis-0.7.7.md) | en | Where the bulk actually is, measured: the published tarball's composition (82% screenshots and a second copy of `src/`), the prose-vs-code growth of `src/`, the multi-home release narrative, and a re-audit of the 0.7.5 reduction list with 11 ranked actions | Snapshot at `a903147` — analysis only, nothing in it has been acted on |
| [archive/publish-checklist.zh.md](./archive/publish-checklist.zh.md) | zh | One-off checklist for turning the plugin directory into a GitHub repo | Superseded 2026-09-30, kept verbatim |
| [archive/compatibility-summary-0.4.1.zh.md](./archive/compatibility-summary-0.4.1.zh.md) | zh | Compatibility conclusions as of 0.4.1 | Superseded 2026-09-30, kept verbatim |

## Outside `docs/`

| Path | Language | What it is |
|---|---|---|
| [README.md](../README.md) | en | Canonical entry point: install, declared compatibility, usage, current behaviour |
| [README.zh.md](../README.zh.md) | zh | Same content, Chinese |
| [README.ja.md](../README.ja.md) · [README.ko.md](../README.ko.md) · [README.fr.md](../README.fr.md) · [README.de.md](../README.de.md) · [README.es.md](../README.es.md) · [README.pt.md](../README.pt.md) · [README.ru.md](../README.ru.md) | 7 languages | Condensed entry points: install, usage, current behaviour, licence. They point at the English `## Compatibility` section instead of repeating the release list, and they carry no release history of their own |
| [CHANGELOG.md](../CHANGELOG.md) / [CHANGELOG.zh.md](../CHANGELOG.zh.md) | en / zh | Release history, newest first, every version |
| [TESTING.md](../TESTING.md) | en | How to verify a change or a release, with the fast path CI runs; the per-check inventory is [CHECK-CATALOG.md](./CHECK-CATALOG.md). Shipped in the npm tarball (`package.json` `files`), so it stays at the repository root |
| [LICENSE](../LICENSE) / [NOTICE](../NOTICE) | en | Licence text and the third-party attribution list |
| [src/client/locales.ts](../src/client/locales.ts) | zh + en | The dialog's "?" help panel: the product-side copy of usage and known limitations. Not prose documentation — it is what the shipped build renders, and its version label is hard-coded there |

## What keeps this honest

Two checks read the prose, and neither is optional:

- `node --test tests/readme-compat.test.mjs` — upstream of this index: both full READMEs must
  list exactly the releases `package.json` declares, and the READMEs plus the help panel must
  name the same repository the manifest does.
- `node scripts/check-docs-parity.mjs` (`npm run test:docs`) — this index's own gate. It
  declares every README's section **names** (not positions: v0.7.5 inserted
  `## Compatibility` and shifted everything a position-based checker relied on), the eight
  behaviour bullets each must carry, the language-neutral tool tokens (`wsl-search`,
  `wsl-relay`, `bash_background`, `readlink`, `FS_SANDBOX_DENIED`), that no README keeps a
  claim the English authority dropped, that no README hard-codes a version range in its
  changelog pointer, that all nine offer the repository `package.json` names, that every
  relative link resolves, and that the CHANGELOG pair agrees on the release list with the
  newest entry equal to `package.json`'s version.

The gate is docs-only, so it needs node ≥ 24 and nothing else — no host packages, no WSL, no
network. Its mutation control: pointed at a tree before this split (`npm run test:docs --
--root <dir>`) it reports every stale translation by name and still exits 1.

Since #41 is merged, the gate runs in CI too: `npm run test:docs` is a step of the `checks`
workflow's `lint-build` job, and it is registered in bucket A of
[CHECK-CATALOG.md](./CHECK-CATALOG.md).
