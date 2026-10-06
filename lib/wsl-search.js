import { c as parseWslUnc, n as isAbsoluteLinuxPath, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { r as getWorkspaceUsername } from "./wsl-credentials-DzKgEzy7.js";
import { n as defaultDistroSync } from "./wsl-JTf2gBat.js";
import z from "@deepseek-ai/schemastery";
import { posix } from "node:path";
import { execFile } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { GLOB_MAX_RESULTS, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, RAW_OUTPUT_MAX_BYTES, SEARCH_META_MAX_BYTES, SEARCH_TIMEOUT_MS, SearchError, formatGlobOutput, formatGrepMatches, formatGrepOutput, parseGlobArgs, parseGrepArgs, presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, previewLine, sampleAcrossTopLevel, trySaveFormattedResult } from "@deepseek-ai/dsh-tool-fs-search";
//#region src/host/wsl-search.ts
/**
* The WSL world's `grep` / `glob` tools.
*
* DSH's own discovery suite (`@deepseek-ai/dsh-tool-fs-search`) spawns the
* *packaged* ripgrep binary through `ctx.subprocess`. That binary is a Windows
* executable and every path the model hands it is a Linux path, so inside a WSL
* session the search either cannot start or looks at the wrong tree — which is
* why the generated WSL world dropped the `tool-fs-search` row outright and left
* the model to grep through the shell.
*
* This module replaces that row with a WSL-native twin. The search executes
* *inside the distribution* (`wsl.exe … bash -c <fixed script>`, every
* model-controlled value passed as a separate argv element and never
* interpolated into the script), so it runs on the Linux kernel over the real
* tree — symlinks, permissions and ownership included — instead of crawling the
* `\\wsl.localhost` 9P share.
*
* The model-facing contract stays DSH's own, not a lookalike: the tool names,
* parameter schemas, caps, output schema, `Line N:` grouping, found-count header,
* capped-result footer and search card all mirror the host suite, and its
* exported formatters (`formatGrepOutput`, `formatGlobOutput`,
* `sampleAcrossTopLevel`, `previewLine`, `present*`) do the rendering. Only the
* projections that package keeps private — the search-card metadata builder and
* the glob page selection — are reproduced here, and `tests/wsl-search.test.ts`
* compares them against the package's own output so drift is caught.
*
* Engine notes, both honest and documented in the UI:
*  - `grep` asks the distribution's GNU grep (`grep -rnIE -Z`), present on every
*    mainstream distribution and requiring no installation. Its dialect is POSIX
*    ERE — `\d`, `\w`, `\b` and `(?i)` work, lookaround and backreferences do
*    not — and it has no `.gitignore` support, so hidden entries and
*    `node_modules` are excluded explicitly while git-ignored files are still
*    searched.
*  - `glob` asks `find` (`-printf` reports each file's mtime without a stat per
*    file) and matches the pattern in this process, because neither GNU find nor
*    a shell reproduces ripgrep's globset semantics faithfully.
*  - Both bound the in-distro output with `head -c`, so a search over a huge tree
*    fails as an overflow instead of buffering the world.
*
* @module dsh-wsl-workspace/host/wsl-search
*/
/**
* The fixed `grep` script the distribution runs. Model-controlled values arrive
* as positional parameters, so no value is ever parsed by a shell; `$0` is the
* literal {@link SCRIPT_ARGV0} marker (not a path).
*
* `-r` recurses, `-n` numbers lines, `-I` skips binary files, `-E` is POSIX ERE,
* `-H` forces the file name onto every record (grep omits it when handed a single
* file, which would break the framing below), and `-Z` terminates each file name
* with NUL so the Node side can frame `path\0line:text` records unambiguously.
*
* The exclusions stand in for ripgrep's default hidden-entry skipping, which GNU
* grep cannot express (it has no `.gitignore` support either). Three GNU quirks
* shape how they are written, each measured against grep 3.12 on Ubuntu:
*  - A file `--exclude` pattern silently cancels `--include` entirely, so the
*    hidden-file guard rides `--include='[!.]*'` instead — and only when the
*    caller passed no filter of its own (repeated includes are OR-ed) and only
*    for a *directory* target, because a file the caller named explicitly is
*    exactly what it asked for.
*  - `--exclude-dir` excludes the search root itself when its base name starts
*    with a dot, so that flag is skipped for a dot-rooted target.
*  - `head -c` bounds the transfer in-distro, `PIPESTATUS[0]` keeps grep's own
*    status rather than head's, and the search root is resolved physically first
*    so a linked-in directory is searched where the file tools would read it.
*
* The search root is resolved physically first, so the printed paths are
* absolute and a linked-in directory is searched at its real path — the same
* place the file tools read and write.
*
* A distribution whose `grep` is not GNU's exits 3 with a diagnostic instead of
* framing records the parser cannot read. Every mainstream WSL distribution
* (Debian, Ubuntu, Fedora, Arch, openSUSE) ships GNU grep; Alpine's busybox grep
* would report that clearly.
*/
const GREP_SCRIPT = [
	"set -u",
	"pattern=$1; include=$2; target=$3; cap=$4",
	"[ -n \"$target\" ] || target=.",
	"if [ -d \"$target\" ]; then",
	"  target=$(cd -- \"$target\" && pwd -P)",
	"  dir=1",
	"else",
	"  case $target in /*) ;; *) target=$PWD/$target ;; esac",
	"  dir=0",
	"fi",
	"if ! grep --version 2>/dev/null | head -n 1 | grep -q GNU; then",
	"  printf \"grep is not GNU grep: %s\\n\" \"$(grep --version 2>/dev/null | head -n 1)\" >&2",
	"  exit 3",
	"fi",
	"opts=(-rnIEH -Z)",
	"if [ \"$dir\" = 1 ]; then",
	"  opts+=(--exclude-dir=node_modules)",
	"  case ${target##*/} in .*) ;; *) opts+=(--exclude-dir=\".*\") ;; esac",
	"  [ -n \"$include\" ] || opts+=(--include=\"[!.]*\")",
	"fi",
	"if [ -n \"$include\" ]; then",
	"  while IFS= read -r one; do [ -n \"$one\" ] && opts+=(--include=\"$one\"); done <<<\"$include\"",
	"fi",
	"grep \"${opts[@]}\" --regexp=\"$pattern\" -- \"$target\" | head -c \"$cap\"",
	"exit \"${PIPESTATUS[0]}\""
].join("\n");
/**
* The fixed `glob` script: an absolute file listing with modification times.
*
* `%T@` is the mtime in seconds (GNU find only), so the caller can order the
* result the way ripgrep's `--sort=modified` does — oldest first — without a
* stat per file and without a 9P round trip per file. VCS metadata directories
* are pruned; the pattern itself is matched in Node.
*
* The header is `G`/`P` (GNU `-printf`, else the plain `-print0` fallback)
* immediately followed by the physically resolved root, **NUL terminated** so a
* path containing a newline cannot split it; every record after it is NUL framed
* too. `PIPESTATUS[0]` is what the script exits with, because a `find` that
* cannot read the target must not look like an empty directory.
*/
const GLOB_SCRIPT = [
	"set -u",
	"target=$1; cap=$2",
	"[ -n \"$target\" ] || target=.",
	"if [ -d \"$target\" ]; then target=$(cd -- \"$target\" && pwd -P); else",
	"  case $target in /*) ;; *) target=$PWD/$target ;; esac",
	"fi",
	"prune=(-name .git -o -name .hg -o -name .svn -o -name .bzr -o -name .jj -o -name .sl)",
	"if find --version 2>/dev/null | head -n 1 | grep -q GNU; then",
	"  { printf 'G%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
	"else",
	"  { printf 'P%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f -print0; } | head -c \"$cap\"",
	"fi",
	"exit \"${PIPESTATUS[0]}\""
].join("\n");
/** The marker `$0` of both scripts; a fixed string, never a path from the model. */
const SCRIPT_ARGV0 = "dsh";
/** GNU grep stderr shapes that mean "the pattern is not a valid regex". */
const INVALID_PATTERN = /Unmatched|Invalid (?:regular expression|range end|character class|back reference|preceding regular expression)|unrecognized|trailing backslash|parentheses not balanced|Invalid collating element/i;
/**
* The defaults, kept as data as well as schema fields. A world row that mounts
* this plugin without a `config:` block hands `apply` an *undefined* config —
* schemastery's defaults are not applied on that path — and a live session
* caught exactly that as `Cannot read properties of undefined (reading
* 'grepMaxMatches')`, which failed the whole world. Reading the defaults from one
* place keeps the schema and the fallback from drifting apart.
*/
const DEFAULTS = {
	grepMaxMatches: GREP_MAX_MATCHES,
	grepMaxLineBytes: GREP_MAX_LINE_BYTES,
	globMaxResults: GLOB_MAX_RESULTS,
	sampleOverCapGlobResults: false,
	searchMetaMaxBytes: SEARCH_META_MAX_BYTES,
	rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
	timeoutMs: SEARCH_TIMEOUT_MS,
	wslPath: "wsl.exe"
};
/** Validated plugin config. */
const Config = z.object({
	grepMaxMatches: z.number().default(DEFAULTS.grepMaxMatches),
	grepMaxLineBytes: z.number().default(DEFAULTS.grepMaxLineBytes),
	globMaxResults: z.number().default(DEFAULTS.globMaxResults),
	sampleOverCapGlobResults: z.boolean().default(DEFAULTS.sampleOverCapGlobResults),
	searchMetaMaxBytes: z.number().default(DEFAULTS.searchMetaMaxBytes),
	rawOutputMaxBytes: z.number().default(DEFAULTS.rawOutputMaxBytes),
	timeoutMs: z.number().default(DEFAULTS.timeoutMs),
	wslPath: z.string().default(DEFAULTS.wslPath),
	distro: z.string()
});
/** Services these tools register into. */
const inject = ["tools"];
/**
* Frame a raw `grep -rnIE -Z` stdout buffer into matches.
*
* GNU grep prints `<path>\0<line>:<text>\n` per match, so splitting on NUL and
* then on the first newline of each following segment recovers all three fields
* even when a path contains spaces, colons or newlines (the text cannot, because
* grep reports one line at a time and `-I` keeps NUL bytes out of the stream).
* @param stdout - the complete raw stdout bytes.
* @returns the matches in output order.
*/
function parseGrepRecords(stdout) {
	const records = [];
	const segments = stdout.toString("utf8").split("\0");
	let path = segments[0] ?? "";
	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		if (segment === "") continue;
		const newline = segment.indexOf("\n");
		const head = newline < 0 ? segment : segment.slice(0, newline);
		const colon = head.indexOf(":");
		const lineNumber = Number.parseInt(colon < 0 ? head : head.slice(0, colon), 10);
		if (Number.isFinite(lineNumber)) records.push({
			path,
			lineNumber,
			line: colon < 0 ? "" : head.slice(colon + 1)
		});
		path = newline < 0 ? "" : segment.slice(newline + 1);
	}
	return records;
}
/**
* Frame a raw `glob` stdout buffer into a listing mode, a resolved root and
* entries.
*
* The script prefixes its output with a NUL-terminated `<mode><root>` header
* (`G` = GNU `-printf`: `mtime\tpath` records; `P` = plain `-print0`: paths only,
* no modification times). NUL framing keeps a root whose own path contains a
* newline in one piece.
* @param stdout - the complete raw stdout bytes.
* @returns the listing; `plain` entries carry `mtimeMs: 0`.
*/
function parseGlobRecords(stdout) {
	const headerEnd = stdout.indexOf(0);
	const header = (headerEnd < 0 ? stdout : stdout.subarray(0, headerEnd)).toString("utf8");
	const mode = header.startsWith("G") ? "gnu" : "plain";
	const root = header.length > 0 ? header.slice(1) : "";
	const files = [];
	const body = headerEnd < 0 ? Buffer.alloc(0) : stdout.subarray(headerEnd + 1);
	for (const entry of body.toString("utf8").split("\0")) {
		if (entry === "") continue;
		if (mode === "plain") {
			files.push({
				path: entry,
				mtimeMs: 0
			});
			continue;
		}
		const tab = entry.indexOf("	");
		if (tab < 0) continue;
		const seconds = Number.parseFloat(entry.slice(0, tab));
		files.push({
			path: entry.slice(tab + 1),
			mtimeMs: Number.isFinite(seconds) ? Math.round(seconds * 1e3) : 0
		});
	}
	return {
		mode,
		root,
		files
	};
}
/**
* Expand one glob's `{a,b,c}` alternations into the equivalent list of plain
* globs. ripgrep's globset understands braces; GNU grep's `--include` does not,
* so the tool passes one `--include` per expansion (repeated includes are OR-ed).
* @param glob - the glob to expand.
* @returns every brace-free alternative, in source order.
*/
function expandBraces(glob) {
	const open = glob.indexOf("{");
	if (open < 0) return [glob];
	const close = glob.indexOf("}", open + 1);
	if (close < 0) return [glob];
	const head = glob.slice(0, open);
	const tail = glob.slice(close + 1);
	return glob.slice(open + 1, close).split(",").flatMap((part) => expandBraces(`${head}${part}${tail}`));
}
/**
* Translate one gitignore-style glob into a regular-expression source (no
* anchors). `*` and `?` never cross a separator, `**` does (a `**` followed by a
* separator also matches zero segments), `[...]` is a character class (negated
* by a leading `!` or `^`), and `{a,b}` is an alternation.
* @param pattern - the glob source.
* @returns the unanchored regex source.
*/
function globSource(pattern) {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:[^/]*/)*";
					index += 3;
					continue;
				}
				source += ".*";
				index += 2;
				continue;
			}
			source += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		if (char === "[") {
			const close = pattern.indexOf("]", index + 2);
			if (close > index + 1) {
				const body = pattern.slice(index + 1, close);
				const negated = body.startsWith("!") || body.startsWith("^");
				const chars = (negated ? body.slice(1) : body).replace(/[\\^\]]/g, "\\$&");
				source += `[${negated ? "^" : ""}${chars}]`;
				index = close + 1;
				continue;
			}
			source += "\\[";
			index += 1;
			continue;
		}
		if (char === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close > index + 1) {
				const alternatives = pattern.slice(index + 1, close).split(",").map((part) => globSource(part));
				source += `(?:${alternatives.join("|")})`;
				index = close + 1;
				continue;
			}
			source += "\\{";
			index += 1;
			continue;
		}
		source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
		index += 1;
	}
	return source;
}
/**
* Compile one glob into a whole-string matcher.
* @param pattern - the glob source.
* @returns the anchored regular expression.
*/
function globToRegExp(pattern) {
	return new RegExp(`^${globSource(pattern)}$`);
}
/**
* Whether one file passes a glob filter. A pattern containing `/` matches the
* path relative to the search root; one without matches the basename at any
* depth. A leading `!` negates the match, so `!*.log` keeps everything that is
* not a log file.
* @param pattern - the glob filter.
* @param relativePath - the candidate's path relative to the search root.
* @returns true when the file is selected.
*/
function matchGlob(pattern, relativePath) {
	let body = pattern;
	let negated = false;
	if (body.startsWith("!")) {
		negated = true;
		body = body.slice(1);
	}
	const candidate = body.includes("/") ? relativePath : posix.basename(relativePath);
	const matched = globToRegExp(body).test(candidate);
	return negated ? !matched : matched;
}
/**
* Map one absolute Linux path to what the model should see: relative to the
* session workdir when it is inside it, absolute otherwise. The POSIX twin of
* the host suite's `toWorkdirRelative`, which is Windows-flavored
* (`path.relative` prints `src\a.ts`).
* @param absolutePath - the search's absolute Linux path.
* @param workdir - the session workdir in Linux coordinates.
* @returns the display path.
*/
function displayPath(absolutePath, workdir) {
	const relative = posix.relative(workdir, absolutePath);
	if (relative === "") return ".";
	return relative.startsWith("..") || posix.isAbsolute(relative) ? absolutePath : relative;
}
/**
* Apply DSH's inline caps to a match list: preview each line and keep the first
* `maxMatches`. Byte-for-byte the outcome of the host suite's private
* `retainGrepMatches` (`ItemRetainer` head + `previewLine`), which that package
* does not export.
* @param matches - every match the search parsed.
* @param maxMatches - the inline match cap.
* @param maxLineBytes - the per-line preview budget.
* @returns the retention outcome, with exact omission metadata.
*/
function retainMatches(matches, maxMatches, maxLineBytes) {
	const items = matches.slice(0, Math.max(0, maxMatches)).map((match) => ({
		...match,
		line: previewLine(match.line, maxLineBytes)
	}));
	const omitted = Math.max(0, matches.length - items.length);
	return {
		items,
		truncated: omitted > 0,
		seen: matches.length,
		kept: items.length,
		omitted: omitted > 0 ? {
			kind: "exact",
			count: omitted
		} : { kind: "none" }
	};
}
/**
* Apply DSH's inline cap to a path list (the host suite's private
* `retainGlobPaths`).
* @param paths - every discovered path.
* @param maxResults - the inline path cap.
* @returns the retention outcome, with exact omission metadata.
*/
function retainPaths(paths, maxResults) {
	const items = paths.slice(0, Math.max(0, maxResults));
	const omitted = Math.max(0, paths.length - items.length);
	return {
		items,
		truncated: omitted > 0,
		seen: paths.length,
		kept: items.length,
		omitted: omitted > 0 ? {
			kind: "exact",
			count: omitted
		} : { kind: "none" }
	};
}
/** The serialized UTF-8 byte size of one card payload (the size persisted and re-sent). */
function metaBytes(meta) {
	return Buffer.byteLength(JSON.stringify(meta), "utf8");
}
/**
* Drop trailing file groups (or paths) until the serialized card metadata fits
* `maxMetaBytes`, marking it truncated. Mirrors the host suite's private
* `capMetaBytes`: `total` keeps counting what the search found, and a single
* oversized item survives rather than producing an empty card.
* @param meta - the projected metadata, already capped to the inline item count.
* @param maxMetaBytes - the serialized byte budget.
* @returns the same metadata when it fits, else a byte-bounded copy.
*/
function capMetaBytes(meta, maxMetaBytes) {
	if (metaBytes(meta) <= maxMetaBytes) return meta;
	if (meta.shape === "matches") {
		const files = [...meta.files];
		while (files.length > 1 && metaBytes({
			...meta,
			files,
			truncated: true
		}) > maxMetaBytes) files.pop();
		return {
			...meta,
			files,
			truncated: true
		};
	}
	const paths = [...meta.paths];
	while (paths.length > 1 && metaBytes({
		...meta,
		paths,
		truncated: true
	}) > maxMetaBytes) paths.pop();
	return {
		...meta,
		paths,
		truncated: true
	};
}
/**
* Project a retained match page into the `matches`-shaped search card: the host
* suite's private `grepSearchMeta` + `groupMatchesByFile`, reproduced verbatim
* (first-seen file order, then the byte cap).
* @param page - the retained page (previewed, capped) or any equivalent subset.
* @param maxMetaBytes - the serialized metadata budget.
* @returns the card metadata.
*/
function grepSearchMeta(page, maxMetaBytes) {
	const byFile = /* @__PURE__ */ new Map();
	for (const match of page.items) {
		const entry = {
			lineNumber: match.lineNumber,
			line: match.line
		};
		const group = byFile.get(match.path);
		if (group === void 0) byFile.set(match.path, [entry]);
		else group.push(entry);
	}
	return capMetaBytes({
		shape: "matches",
		files: Array.from(byFile, ([path, matches]) => ({
			path,
			matches
		})),
		truncated: page.truncated,
		total: page.seen
	}, maxMetaBytes);
}
/**
* Project a retained path page into the `paths`-shaped search card (the host
* suite's private `globSearchMeta`).
* @param page - the retained page (capped) or any equivalent subset.
* @param maxMetaBytes - the serialized metadata budget.
* @returns the card metadata.
*/
function globSearchMeta(page, maxMetaBytes) {
	return capMetaBytes({
		shape: "paths",
		paths: [...page.items],
		truncated: page.truncated,
		total: page.seen
	}, maxMetaBytes);
}
/**
* Format one capped `glob` page in the flat (head) style, mirroring the host
* suite's private `formatGlobPage`.
* @param items - the page shown inline.
* @param seen - how many paths the complete result holds.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function formatGlobPage(items, seen, spillRef) {
	const recovery = spillRef !== void 0 ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}` : "The complete result could not be saved; narrow pattern or path to see more.";
	return `${items.join("\n")}\n\n(Showing ${items.length} of ${seen} paths. ${recovery})`;
}
/**
* Normalize a spill reference for rendering.
*
* The canonical value is validated against the tool's output schema, and a
* backend's `SpillRef` carries fields of its own (`@deepseek-ai/dsh-spill`'s
* `SpillRef` is `{locator, bytes, retrievalHint}`), so the schema cannot close
* the object. This keeps the renderer's contract to the two fields it reads and
* survives a backend that omits the hint.
* @param spill - the backend's reference, as returned into the canonical value.
* @returns a render-ready reference, or undefined when there is nothing to name.
*/
function normalizeSpill(spill) {
	if (spill === void 0 || spill === null) return void 0;
	const locator = spill.locator;
	if (typeof locator !== "string" || locator === "") return void 0;
	const retrievalHint = spill.retrievalHint;
	return {
		...spill,
		locator,
		retrievalHint: typeof retrievalHint === "string" ? retrievalHint : ""
	};
}
/**
* The spill reference's schema: an object whose extra fields are the backend's
* business. Requiring only what the footer prints keeps a version's `SpillRef`
* (which carries `bytes` too, and is branded) from failing the tool's own output
* validation — which is why `additionalProperties` is `true` here.
*/
const SPILL_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: {
		locator: { type: "string" },
		retrievalHint: { type: "string" }
	}
};
/**
* Format one `glob` result exactly as the host suite's private `renderGlobPaths`
* does: whole when within the cap, else the modification-time head or the
* top-level sample, with the same footer.
* @param paths - the complete display-path list, in modification-time order.
* @param caps - the inline cap and the sampling switch.
* @param root - the search root in the same display-path space as `paths`.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function renderGlobText(paths, caps, root, spillRef) {
	if (paths.length === 0) return "No files found";
	if (paths.length <= caps.maxResults) return paths.join("\n");
	if (!caps.sampleOverCapGlobResults) return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef);
	return formatGlobOutput(sampleAcrossTopLevel([...paths], caps.maxResults, root), paths.length, spillRef);
}
/**
* The inline page a `glob` card shows, computed the same way {@link renderGlobText}
* computes its model page so text and card never disagree (the host suite's
* private `globCardPage`).
* @param paths - the complete display-path list.
* @param caps - the inline cap and the sampling switch.
* @param root - the search root in the same display-path space as `paths`.
* @returns the page and whether the complete result was capped.
*/
function globCardPage(paths, caps, root) {
	if (paths.length <= caps.maxResults) return {
		items: [...paths],
		truncated: false
	};
	if (!caps.sampleOverCapGlobResults) return {
		items: paths.slice(0, caps.maxResults),
		truncated: true
	};
	return {
		items: sampleAcrossTopLevel([...paths], caps.maxResults, root).items,
		truncated: true
	};
}
/**
* Format one `grep` result exactly as the host suite's private
* `formatRetainedGrep` does, including its zero-match wording.
* @param matches - every match the search returned, with display paths.
* @param caps - the inline caps.
* @param spillRef - the saved complete-result reference, or undefined when unsaved.
* @returns the model-facing text.
*/
function renderGrepText(matches, caps, spillRef) {
	const retained = retainMatches(matches, caps.maxMatches, caps.maxLineBytes);
	if (retained.seen === 0) return "No matches found";
	return formatGrepOutput(retained, spillRef);
}
/**
* Resolve the distribution and Linux workdir one search runs in, mirroring the
* shell and filesystem providers' chain: a WSL UNC cwd carries both, an absolute
* Linux cwd uses the configured distribution (then the host default).
* @param cwd - the calling session's cwd.
* @param configured - the world's configured distribution, when any.
* @returns the target, or undefined when the cwd is not in a WSL world.
*/
function resolveTarget(cwd, configured) {
	if (cwd === void 0 || cwd === "") return void 0;
	const unc = parseWslUnc(cwd);
	if (unc !== null) {
		const linuxCwd = unc.linuxPath === "" ? "/" : unc.linuxPath;
		const username = getWorkspaceUsername(cwd);
		return {
			distro: unc.distro,
			linuxCwd,
			...username === void 0 ? {} : { username }
		};
	}
	if (!isAbsoluteLinuxPath(cwd)) return void 0;
	const distro = configured !== void 0 && configured.trim() !== "" ? configured.trim() : defaultDistroSync();
	if (distro === void 0 || distro === "") return void 0;
	return {
		distro,
		linuxCwd: cwd
	};
}
/**
* Express a model-supplied search target in Linux coordinates: a WSL UNC path
* becomes its Linux form, a Windows drive path becomes its `/mnt/<drive>` form
* (the same translation the file tools apply, so `grep path='D:\proj'` searches
* what `read D:\proj\a.ts` reads), and everything else — absolute, relative,
* empty — is used as typed and resolved by the distribution against the session
* workdir.
* @param path - the tool call's `path`, when given.
* @returns the script's `target` parameter.
*/
function linuxTarget(path) {
	if (path === void 0) return "";
	const unc = parseWslUnc(path);
	if (unc !== null) return unc.linuxPath === "" ? "/" : unc.linuxPath;
	return windowsToMntPath(path) ?? path;
}
/**
* Build the `wsl.exe` argv for one search. Values ride as positional parameters
* after the fixed script, so nothing the model typed is ever parsed by a shell.
* @param target - where to run.
* @param script - the fixed script.
* @param values - the script's positional parameters.
* @returns the complete argv vector.
*/
function buildWslArgv(target, script, values) {
	return [
		"-d",
		target.distro,
		...target.username === void 0 ? [] : ["-u", target.username],
		"--cd",
		target.linuxCwd,
		"-e",
		"bash",
		"-c",
		script,
		SCRIPT_ARGV0,
		...values
	];
}
/**
* Run one fixed script inside the distribution.
*
* Errors stay in the host suite's two domains: a spawn failure (a missing
* `wsl.exe`) rejects, while every completed or killed run comes back for the
* caller to classify.
* @param argv - the complete `wsl.exe` argv.
* @param wslPath - the executable to run.
* @param timeoutMs - the hard kill deadline.
* @param rawOutputMaxBytes - the stdout budget the script already bounded.
* @param signal - caller cancellation.
* @returns the run outcome.
*/
function runInDistro(argv, wslPath, timeoutMs, rawOutputMaxBytes, signal) {
	return new Promise((settle, fail) => {
		execFile(wslPath, [...argv], {
			maxBuffer: rawOutputMaxBytes + 1048576,
			encoding: "buffer",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			windowsHide: true,
			...signal === void 0 ? {} : { signal }
		}, (error, stdout, stderr) => {
			const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
			const err = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
			if (error === null || error === void 0) {
				settle({
					code: 0,
					stdout: out,
					stderr: err,
					aborted: false,
					signal: null
				});
				return;
			}
			const aborted = error.name === "AbortError";
			const code = typeof error.code === "number" ? error.code : null;
			const killSignal = error.signal ?? null;
			if (code === null && !aborted && killSignal === null) {
				fail(error);
				return;
			}
			settle({
				code,
				stdout: out,
				stderr: err,
				aborted,
				signal: killSignal
			});
		});
	});
}
/**
* Classify one completed run into raw stdout or a `SEARCH_*` failure, using the
* host suite's error vocabulary so retry/permission layers branch identically.
*
* The two engines disagree on exit 1: it is grep's "searched, found nothing",
* while `find` returns non-zero when it could not read the target at all — which
* must not be reported as an empty directory.
* @param run - the completed run.
* @param toolName - `grep` or `glob`, for the message.
* @param rawOutputMaxBytes - the budget the script bounded stdout to.
* @returns the raw stdout bytes.
*/
function acceptRun(run, toolName, rawOutputMaxBytes) {
	if (run.aborted || run.signal !== null) throw new SearchError(`${toolName} was cancelled or timed out before it finished`, "SEARCH_ABORTED");
	if (run.stdout.length > rawOutputMaxBytes) throw new SearchError(`${toolName} produced more than ${rawOutputMaxBytes} bytes of raw output; narrow pattern or path`, "SEARCH_RAW_OUTPUT_OVERFLOW");
	const code = run.code ?? -1;
	if (code === 0 || code === 1 && toolName === "grep") return run.stdout;
	const detail = (run.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
	if (code === 2 && toolName === "grep" && INVALID_PATTERN.test(run.stderr)) throw new SearchError(`${toolName} pattern rejected by the distribution's grep${detail === "" ? "" : `: ${detail}`}`, "SEARCH_INVALID_PATTERN");
	if (code === 3) throw new SearchError(`${toolName} needs a GNU grep inside the distribution${detail === "" ? "" : ` (${detail})`}`, "SEARCH_FAILED");
	if (code === 127) throw new SearchError(`${toolName} could not start its search command inside the distribution${detail === "" ? "" : `: ${detail}`}`, "SEARCH_FAILED");
	throw new SearchError(`${toolName} search failed inside the distribution (exit ${code})${detail === "" ? "" : `: ${detail}`}`, "SEARCH_FAILED");
}
/**
* Register the `grep` and `glob` tools plus their system-prompt guidance.
*
* Both keep the host suite's split of responsibilities: `execute` returns the
* complete canonical value (display paths included) and may spill it, `render`
* applies the inline caps and formats, and `presentationMeta` projects the search
* card from the same retained page so text and card agree.
* @param ctx - plugin context; registrations are effects scoped to it.
* @param config - plugin configuration; a row without a `config:` block mounts
*   this plugin with none, and {@link DEFAULTS} then supplies every knob.
*/
function apply(ctx, config) {
	const resolved = {
		...DEFAULTS,
		...config === void 0 ? {} : config
	};
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	registerGrep(ctx, tools, resolved);
	registerGlob(ctx, tools, resolved);
	registerGuidance(ctx);
}
/**
* Register the model-facing `grep` tool.
* @param ctx - plugin context.
* @param tools - the tool registry.
* @param config - resolved configuration.
*/
function registerGrep(ctx, tools, config) {
	const caps = {
		maxMatches: config.grepMaxMatches,
		maxLineBytes: config.grepMaxLineBytes,
		maxMetaBytes: config.searchMetaMaxBytes
	};
	const tool = defineTool({
		name: "grep",
		description: `Search file contents inside this WSL distribution with a GNU grep extended regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${caps.maxMatches} matches inline; a capped result reports where the complete match list was saved. Use read on a matched file for surrounding context.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Regular expression to search for (GNU grep -E syntax: \\d, \\w, \\b and (?i) work; lookaround and backreferences do not)."
			},
			path: {
				type: "string",
				description: "File or Linux path to search. Defaults to the session workspace; a relative path resolves against it."
			},
			include: {
				type: "string",
				description: "One glob filter on file names for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). A filter containing \"/\" is matched against the path relative to the search root. Not a list; negation is not supported."
			}
		},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					matches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: {
									type: "string",
									required: true
								},
								lineNumber: {
									type: "integer",
									required: true
								},
								line: {
									type: "string",
									required: true
								}
							}
						}
					},
					spill: SPILL_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderGrepText(value.matches, caps, normalizeSpill(value.spill))
			}],
			presentationMeta: (_args, value) => grepSearchMeta(retainMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes)
		},
		async execute(args, exec) {
			const input = parseGrepArgs(args);
			const target = resolveTarget(exec.agent?.session.header.cwd, config.distro);
			if (target === void 0) throw new SearchError("grep is only available in a WSL workspace session", "SEARCH_FAILED");
			const globs = expandBraces(input.include ?? "");
			const pathShaped = globs.filter((glob) => glob.includes("/"));
			const matches = parseGrepRecords(acceptRun(await runInDistro(buildWslArgv(target, GREP_SCRIPT, [
				input.pattern,
				pathShaped.length > 0 ? "" : globs.join("\n"),
				linuxTarget(input.path),
				String(config.rawOutputMaxBytes + 1)
			]), config.wslPath, config.timeoutMs, config.rawOutputMaxBytes, exec.signal), "grep", config.rawOutputMaxBytes)).filter((record) => {
				if (pathShaped.length === 0) return true;
				const relative = posix.relative(target.linuxCwd, record.path);
				const candidate = relative.startsWith("..") ? record.path : relative;
				return pathShaped.some((glob) => matchGlob(glob, candidate));
			}).map((record) => ({
				path: displayPath(record.path, target.linuxCwd),
				lineNumber: record.lineNumber,
				line: record.line
			}));
			if (matches.length <= caps.maxMatches) return { matches };
			const previewed = matches.map((match) => ({
				...match,
				line: previewLine(match.line, caps.maxLineBytes)
			}));
			const spill = await trySaveFormattedResult(ctx, exec, "grep-results.txt", `Found ${matches.length} matches\n\n${formatGrepMatches(previewed)}`);
			return spill === void 0 ? { matches } : {
				matches,
				spill
			};
		},
		presentCall: presentGrepCall,
		presentResult: presentGrepResult
	});
	tools.register(tool);
}
/**
* Register the model-facing `glob` tool.
* @param ctx - plugin context.
* @param tools - the tool registry.
* @param config - resolved configuration.
*/
function registerGlob(ctx, tools, config) {
	const caps = {
		maxResults: config.globMaxResults,
		sampleOverCapGlobResults: config.sampleOverCapGlobResults
	};
	const overCap = caps.sampleOverCapGlobResults ? `a larger result instead returns ${caps.maxResults} paths sampled across top-level entries` : `a larger result returns the first ${caps.maxResults} paths in modification-time order`;
	const tool = defineTool({
		name: "glob",
		description: `Find files inside this WSL distribution whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${caps.maxResults} paths come back in modification-time order (oldest first); ${overCap}, says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth. A leading \"!\" negates the pattern."
			},
			path: {
				type: "string",
				description: "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
			}
		},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					root: {
						type: "string",
						required: true
					},
					paths: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					spill: SPILL_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderGlobText(value.paths, caps, value.root, normalizeSpill(value.spill))
			}],
			presentationMeta: (_args, value) => {
				const page = globCardPage(value.paths, caps, value.root);
				return globSearchMeta({
					items: page.items,
					truncated: page.truncated,
					seen: value.paths.length
				}, config.searchMetaMaxBytes);
			}
		},
		async execute(args, exec) {
			const input = parseGlobArgs(args);
			const target = resolveTarget(exec.agent?.session.header.cwd, config.distro);
			if (target === void 0) throw new SearchError("glob is only available in a WSL workspace session", "SEARCH_FAILED");
			const listing = parseGlobRecords(acceptRun(await runInDistro(buildWslArgv(target, GLOB_SCRIPT, [linuxTarget(input.path), String(config.rawOutputMaxBytes + 1)]), config.wslPath, config.timeoutMs, config.rawOutputMaxBytes, exec.signal), "glob", config.rawOutputMaxBytes));
			const rootAbsolute = listing.root === "" ? target.linuxCwd : listing.root;
			listing.files.sort(listing.mode === "gnu" ? (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path) : (left, right) => left.path.localeCompare(right.path));
			const root = input.path === void 0 ? "." : displayPath(rootAbsolute, target.linuxCwd);
			const paths = [];
			for (const file of listing.files) {
				const relative = posix.relative(rootAbsolute, file.path);
				if (!matchGlob(input.pattern, relative === "" ? posix.basename(file.path) : relative)) continue;
				paths.push(displayPath(file.path, target.linuxCwd));
			}
			if (paths.length <= caps.maxResults) return {
				root,
				paths
			};
			const spill = await trySaveFormattedResult(ctx, exec, "glob-results.txt", paths.join("\n"));
			return spill === void 0 ? {
				root,
				paths
			} : {
				root,
				paths,
				spill
			};
		},
		presentCall: presentGlobCall,
		presentResult: presentGlobResult
	});
	tools.register(tool);
}
/**
* Register the tools' scope-aware system-prompt guidance, mirroring the host
* suite's sections. Best-effort: a release whose `systemPrompt` surface differs
* loses the hint, never the tools.
* @param ctx - plugin context.
*/
function registerGuidance(ctx) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === void 0 || typeof systemPrompt.section !== "function") return;
	const order = (name) => {
		try {
			return systemPrompt.getSectionOrder?.(name);
		} catch {
			return;
		}
	};
	try {
		systemPrompt.section({
			name: "tool:grep",
			order: order("TOOL_GREP"),
			text: () => "Use the grep tool — not shell grep or rg — to search file contents inside this WSL workspace. Use read on a matched file when you need surrounding context."
		});
		systemPrompt.section({
			name: "tool:glob",
			order: order("TOOL_GLOB"),
			text: () => "Use the glob tool — not shell find — to discover files by path pattern inside this WSL workspace. A pattern with no \"/\" matches basenames at any depth, so \"*\" matches every file in the tree rather than its top level. Results are files only, never directories."
		});
	} catch {}
}
//#endregion
export { Config, apply, apply as default, buildWslArgv, capMetaBytes, displayPath, expandBraces, globCardPage, globSearchMeta, globToRegExp, grepSearchMeta, inject, linuxTarget, matchGlob, normalizeSpill, parseGlobRecords, parseGrepRecords, registerGuidance, renderGlobText, renderGrepText, resolveTarget, retainMatches, retainPaths };

//# sourceMappingURL=wsl-search.js.map