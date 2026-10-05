import { a as textOf, c as isAbsoluteLinuxPath, d as joinUnc, f as mntToWindowsPath, h as uncToLinux, i as listDistros, l as isValidWslUsername, m as parseWslUnc, p as normalizeLinuxPath, r as execFileResult, t as defaultDistro } from "./wsl-Ckyi3g6C.js";
import { a as listWorkspaceRecords, i as listWorkspaceKeys, n as getWindowsWorkspace, o as registerWindowsWorkspace, r as getWorkspaceUsername, s as setWorkspaceUsername, t as canonicalWslUnc } from "./wsl-credentials-Db3iZ6Rd.js";
import { i as readinessContract, t as CONTROLLED_PROMPT } from "./wsl-env-DqeMFPn-.js";
import { a as buildSessionSpec, n as PROBE_CONFIG, s as probeWslBashSession } from "./wsl-bash-tool-0t9U5_Ua.js";
import { n as resolveLinuxSymlinks } from "./links-9yUwAzq9.js";
import z from "@deepseek-ai/schemastery";
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, posix } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
//#region src/shared/relay-node.ts
/**
* Which node executable runs the persistent-shell relay.
*
* The WSL world's `bash` is the host's persistent-shell stack, and this plugin
* hands its PTY backend a command of its own: `shellPath` is a node executable
* and `shellArgs[0]` is `lib/wsl-relay.js`, because only the relay can read the
* session's distribution and user at spawn time (see
* `src/host/wsl-relay.ts`). Everything in that stack is the host's — only the
* interpreter is this plugin's choice, and it has to be a real one.
*
* On `dsh web` it is: `process.execPath` is node. On DSH Desktop it is not. The
* Desktop's host process *is* the packaged Electron executable running in node
* mode (`ELECTRON_RUN_AS_NODE=1`; its shell writes
* `new DesktopHostProcess(resources.node, …)` with
* `resources.node = process.execPath`), and an Electron binary spawned under a
* ConPTY produces **no stdout at all**: the relay's `wsl.exe` child inherits a
* dead stream, the relay exits 0 without a byte, the backend's readiness probe
* never sees a prompt, and every persistent shell fails with
* `PTY shell exited during startup` (issue #40). Measured with the host's own
* node-pty on Desktop 0.2.0-rc.2 / Electron 38: the identical spec — same relay,
* same `\\wsl.localhost\…` cwd, same environment — reports 93 bytes and a bash
* prompt through a real node, and 0 bytes with an immediate exit 0 through the
* Electron executable.
*
* So the interpreter is resolved deliberately instead of trusted. Candidates,
* best first:
*
*  1. The Desktop's own runtime payload, located from the absolute
*     `…/resources/runtime/primary-runtime` path the Desktop passes to its host
*     process in `process.argv` (that payload carries a real node at
*     `dependencies/node/bin/`, per the `versions.json` beside it).
*  2. The same payload relative to the running executable, which is the layout
*     of an installed Desktop (`<install>/resources/runtime/…`).
*  3. `DSH_DESKTOP_NODE_EXECUTABLE`, but only when it really is node. The
*     Desktop sets that variable to `process.execPath` — the Electron binary:
*     its own `resources/runtime/bin/node.cmd` is
*     `set ELECTRON_RUN_AS_NODE=1` followed by `"%DSH_DESKTOP_NODE_EXECUTABLE%"`,
*     a shim around the Electron executable, not a node. The probe below
*     rejects it.
*  4. A `node.exe`/`node` on `PATH`.
*  5. `process.execPath` — the behaviour before this module existed, and the
*     correct one on any host that is not Electron.
*
* Every candidate is asked what it is rather than inferred from a version
* string, because `--version` cannot tell the two apart: an Electron binary
* answers `v38.4.0` on its own and answers with the *node* version when
* `ELECTRON_RUN_AS_NODE` is inherited — which it always is inside the Desktop
* host, so a `^v\d+\.\d+\.\d+` check would happily select the broken one.
*
* @module dsh-wsl-workspace/shared/relay-node
*/
/** How long one candidate probe may take. */
const PROBE_TIMEOUT_MS = 1e4;
/** The oldest node major the built `lib/` output is known to run on. */
const MINIMUM_NODE_MAJOR = 20;
/** Human text for an unknown rejection. */
function messageOf$1(value) {
	return value instanceof Error ? value.message : String(value);
}
/**
* Whether this process is an Electron host rather than plain node.
*
* `process.versions.electron` is set in both Electron modes — windowed and
* `ELECTRON_RUN_AS_NODE` — so this is the same fact the resolution itself
* turns on, and not a guess from the executable's name.
* @returns true when the host process is Electron (i.e. DSH Desktop).
*/
function isElectronHost() {
	return process.versions.electron !== void 0;
}
/** The bundled node executable name on one platform. */
function nodeExecutableName(platform) {
	return platform === "win32" ? "node.exe" : "node";
}
/**
* The candidate interpreters that do not need a lookup, best first.
*
* Pure on purpose: every fact it reads is a parameter, so a test (or a review)
* can describe a Desktop that is not the one running it.
* @param input - the host facts to derive candidates from.
* @returns candidates that exist, in preference order, without duplicates.
*/
function relayNodeCandidates(input) {
	const exists = input.exists ?? existsSync;
	const name = nodeExecutableName(input.platform);
	const payload = (root) => join(root, "dependencies", "node", "bin", name);
	const candidates = [];
	const add = (path, source) => {
		if (path === void 0 || path === "") return;
		if (candidates.some((candidate) => candidate.path === path)) return;
		candidates.push({
			path,
			source
		});
	};
	for (const arg of input.argv) if (/(^|[\\/])primary-runtime[\\/]?$/.test(arg)) add(payload(arg), `the runtime payload named in argv ("${arg}")`);
	const exeDir = dirname(input.execPath);
	add(payload(join(exeDir, "resources", "runtime", "primary-runtime")), "the runtime payload beside the running executable");
	add(payload(join(exeDir, "..", "Resources", "runtime", "primary-runtime")), "the runtime payload in the macOS bundle Resources directory");
	add(input.env.DSH_DESKTOP_NODE_EXECUTABLE, "DSH_DESKTOP_NODE_EXECUTABLE");
	return candidates.filter((candidate) => exists(candidate.path));
}
/**
* The candidate interpreters a `PATH` lookup finds, in `where`/`which` order.
*
* Windows is asked for `node.exe` specifically: the Desktop puts its
* `runtime/bin` on `PATH` for some children, and that directory holds `node.cmd`
* and `node`, both of which are shims around the Electron executable rather
* than node. A shim is not a usable `shellPath` anyway — `spawn` cannot run a
* `.cmd` without a shell — so leaving them out of the list is the honest
* answer, and the probe would reject them regardless.
* @param platform - the host platform.
* @returns the existing candidates, in the order the lookup reported them.
*/
async function pathNodeCandidates(platform) {
	const name = nodeExecutableName(platform);
	const command = platform === "win32" ? "where.exe" : "which";
	const args = platform === "win32" ? [name] : ["-a", "node"];
	try {
		const result = await execFileResult(command, args, {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS
		});
		return textOf(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "").map((path) => ({
			path,
			source: `"${name}" on PATH`
		}));
	} catch {
		return [];
	}
}
/**
* Judge one probe's output.
*
* Split out from the spawn so the discriminator is testable on its own: the
* strings below are what the two binaries actually print, and no version-shaped
* check can separate them (see the module comment).
* @param stdout - the candidate's captured stdout.
* @returns whether it is a usable node, and either its version or the reason.
*/
function classifyNodeProbe(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return {
			ok: false,
			reason: "did not report a node version"
		};
	}
	if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || parsed[1] !== null && typeof parsed[1] !== "string") return {
		ok: false,
		reason: "did not report a node version"
	};
	if (parsed[1] !== null) return {
		ok: false,
		reason: `is the Electron ${parsed[1]} executable, not node`
	};
	const major = Number(/^(\d+)\./.exec(parsed[0])?.[1] ?? "0");
	if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) return {
		ok: false,
		reason: `is node ${parsed[0]}, older than the ${MINIMUM_NODE_MAJOR} this build needs`
	};
	return {
		ok: true,
		version: parsed[0]
	};
}
/**
* Ask one candidate what it is, by running it once.
*
* The script prints `[process.versions.node, process.versions.electron ?? null]`
* as JSON, so a single spawn answers both questions: whether this is node at
* all, and whether it is the Electron executable that merely answers to node
* mode. `-e` rather than `-p`: `-p` prints the expression's value as well, and
* `process.stdout.write` returns `true`, which would append a stray `true` to
* the JSON. A candidate that cannot be started is reported with the reason
* instead of being accepted on faith.
* @param candidate - absolute path to the executable to ask.
* @returns whether it is a usable node, and either its version or the reason.
*/
async function probeRelayNode(candidate) {
	const script = "process.stdout.write(JSON.stringify([process.versions.node, process.versions.electron ?? null]))";
	try {
		const result = await execFileResult(candidate, ["-e", script], {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS
		});
		return classifyNodeProbe(textOf(result.stdout));
	} catch (error) {
		return {
			ok: false,
			reason: messageOf$1(error)
		};
	}
}
/**
* Resolve the interpreter the persistent-shell relay must be started with.
*
* A host that is not Electron already runs on a real node, so it is returned
* untouched and nothing is spawned — `dsh web` behaves exactly as before.
* @returns the chosen executable, why it was chosen, and what was rejected.
*/
async function resolveRelayNode() {
	if (!isElectronHost()) return {
		path: process.execPath,
		source: "the host process is not Electron, so it is already a real node",
		rejected: [],
		fallback: false
	};
	const candidates = [...relayNodeCandidates({
		argv: process.argv,
		execPath: process.execPath,
		env: process.env,
		platform: process.platform
	}), ...await pathNodeCandidates(process.platform)];
	const rejected = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		const probe = await probeRelayNode(candidate.path);
		if (probe.ok) return {
			path: candidate.path,
			source: `node ${probe.version} from ${candidate.source}`,
			rejected,
			fallback: false
		};
		rejected.push(`${candidate.path} (${probe.reason})`);
	}
	return {
		path: process.execPath,
		source: "no real node executable was found; the Electron host executable is the last resort, and a PTY child started from it produces no output",
		rejected,
		fallback: true
	};
}
/**
* Whether the world may mount the persistent (PTY) shell, given the substrate
* probe's answer and the interpreter the relay would be started with.
*
* A `fallback: true` resolution is not a degraded-but-usable answer: what it
* resolved to is the Electron executable, and `resolveRelayNode()` says in its
* own words that a PTY child started from it produces no output. Mounting the PTY
* world on top of that turns every `bash` call into issue #40's
* `PTY shell exited during startup`, which is what issue #51 reported from a
* Desktop whose payload layout matched none of the candidates. Demoting costs the
* session its shell state — the one-shot executor needs no PTY, so the model
* still gets a working `bash`.
* @param probeSaysYes - what `supportsPersistentShell` answered.
* @param relay - the resolution for the chosen interpreter, absent when the probe already said no.
* @returns true only when both halves agree the shell can start.
*/
function persistentShellAllowed(probeSaysYes, relay) {
	return probeSaysYes && relay !== void 0 && relay.fallback !== true;
}
//#endregion
//#region src/host/pty-readiness.ts
/**
* Boot-time readiness probe for the persistent (PTY) shell.
*
* `supportsPersistentShell` answers a narrow question — can this host build a
* terminal inspector at all — and issue #51 showed what a narrow answer costs: a
* Desktop that passed it mounted a PTY world whose every `bash` call failed,
* because nothing checked whether a WSL shell under that host actually reaches
* the state the host's own completion check looks for. This probe asks the
* second question end to end, once, before the world is published: start the real
* relay the way the backend will start it, send one command through the real
* terminal seam, and require the three facts the backend needs to call the shell
* ready.
*
* What it proves, and what it does not. A pass means the relay interpreter runs,
* the distribution starts, the command round-trips, and the readiness contract
* arrived in the distribution — which is the failure class issue #51 reported as
* a shell that never settles. A pass does NOT prove the host's process-group
* inspection works inside WSL: that lives in `@deepseek-ai/dsh-win32-process`,
* behind a predicate this plugin cannot call. The probe is deliberately honest
* about that limit rather than quietly claiming the whole path.
*
* @module dsh-wsl-workspace/host/pty-readiness
*/
/**
* The ceiling for one probe. Derived from a measurement, not tuned to pass:
* 2026-10-04 on a Windows 10 19045 / WSL 3.0.1.0 machine, the relay's first prompt
* landed at 1087 ms warm and 3962 ms cold (the cold figure is the distro
* auto-starting underneath the first access), and a command round-tripped within
* 3998 ms of spawn. 15 s sits about 3.75x above the slowest legitimate boot here,
* which is margin for a slower disk or a cold Hyper-V host, not headroom for a
* broken one — a host that cannot answer inside 15 s should not be handed a PTY
* world it will fail every call in.
*/
const READINESS_PROBE_BUDGET_MS = 15e3;
/**
* Strip the escape sequences a terminal emulator interprets rather than prints.
*
* The prompt test must not require a trailing space to arrive as a space: measured
* on this machine, ConPTY can render the trailing space of `dsh> ` as a cursor-forward
* sequence (`ESC [ 1 C`), which would fail a byte-for-byte check while the shell is
* in fact sitting at the controlled prompt.
* @param text - raw bytes seen on the wire.
* @returns the printable remainder.
*/
function stripTerminalEscapes(text) {
	return text.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}
/**
* Run one readiness probe against a live terminal seam.
*
* The `cwd` argument is not a detail: the persistent shell is spawned with the
* SESSION's workspace path, and for a WSL workspace that is a
* `\\wsl.localhost\<distro>\…` UNC path. Probing from a Windows directory cannot see a
* startup failure that only happens on a UNC cwd, so the caller passes a registered
* workspace path when one exists and a Windows fallback is reported as the partial
* check it is rather than counted as verifying the UNC case.
* @param face - the `subprocess` service face, or undefined when there is none.
* @param paths - the relay script and the interpreter the backend would start it with.
* @param cwd - the directory to start the relay in, ideally a real workspace path.
* @param budgetMs - the ceiling; defaults to {@link READINESS_PROBE_BUDGET_MS}.
* @returns whether the shell reached the state the host's completion check needs.
*/
async function probePersistentShellReadiness(face, paths, cwd, budgetMs = READINESS_PROBE_BUDGET_MS) {
	if (face === void 0) return {
		ready: true,
		detail: "no subprocess service to probe with; unchanged from the probe that ran before this one",
		unverifiable: true
	};
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const env = {
		SystemRoot: systemRoot,
		PATH: [join(systemRoot, "System32"), process.env.PATH ?? ""].filter(Boolean).join(";"),
		TERM: "dumb",
		...readinessContract()
	};
	const seed = 1e6 + Math.floor(Math.random() * 9e6);
	const expected = `dshwslprobe${seed * 2}`;
	const command = `echo dshwslprobe$(( ${seed} * 2 ))`;
	let handle;
	const started = Date.now();
	try {
		handle = await face.spawnTerminal({
			argv: [paths.nodePath, paths.relayPath],
			cwd,
			rows: 24,
			cols: 80,
			terminalType: "dumb",
			graceMs: 1e3,
			env
		});
	} catch (error) {
		return {
			ready: false,
			detail: `spawnTerminal rejected the relay: ${String(error).slice(0, 160)}`
		};
	}
	const stream = handle?.output;
	if (typeof stream?.on !== "function" || typeof handle?.write !== "function") {
		await Promise.resolve(handle?.terminate?.()).catch(() => {});
		return {
			ready: true,
			detail: "the terminal handle exposes no output stream or write; readiness was NOT verified",
			unverifiable: true
		};
	}
	let wire = "";
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk) => {
		wire += chunk;
	});
	let exitObserved;
	handle.done?.then((outcome) => {
		exitObserved = `resolved ${JSON.stringify(outcome)}`;
	}, (error) => {
		exitObserved = `rejected ${String(error).slice(0, 80)}`;
	});
	let wrote = false;
	let markerSeen = false;
	let promptSeen = false;
	let answerSeen = false;
	try {
		while (Date.now() - started < budgetMs) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			markerSeen ||= wire.includes("]133;D;");
			promptSeen ||= stripTerminalEscapes(wire).includes(CONTROLLED_PROMPT.trimEnd());
			if (!wrote && (markerSeen || promptSeen || wire.length > 0)) {
				wrote = true;
				await handle.write(`${command}\r`);
			}
			answerSeen ||= wire.includes(expected);
			if (exitObserved !== void 0) break;
			if (answerSeen && markerSeen && promptSeen) return {
				ready: true,
				detail: `command round-tripped with the readiness contract in ${Date.now() - started}ms at cwd ${JSON.stringify(cwd)}${parseWslUnc(cwd) !== null ? "" : " (NOT a WSL UNC path, so the UNC startup shape is unverified)"}`
			};
		}
		const missing = [
			...answerSeen ? [] : ["the probe command never produced its computed answer"],
			...markerSeen ? [] : ["no OSC 133;D marker"],
			...promptSeen ? [] : [`no ${JSON.stringify(CONTROLLED_PROMPT.trimEnd())} prompt`]
		];
		return {
			ready: false,
			detail: `${exitObserved !== void 0 ? `the shell ${exitObserved}` : "no ready shell within the budget"} after ${Date.now() - started}ms: ${missing.join(", ") || "unknown"}`
		};
	} finally {
		await Promise.resolve(handle.terminate?.()).catch(() => {});
	}
}
//#endregion
//#region src/host/variants.ts
/**
* WSL preset-variant generator. For every healthy source preset the roster
* supplies, a `wsl-<id>` variant is materialized under the roster's user
* root: the source composition with its shell/filesystem world replaced by
* the WSL providers, so any mode (standard, minimal, code, cordis, user
* presets) can run on top of a WSL execution world. The execution world is
* therefore orthogonal to the mode instead of a mode itself.
*
* The transformation is text-level on the top-level rows of the composition
* (the shape all shipped presets share), with surgical edits for the known
* special groups; unknown shapes are kept verbatim where possible.
* @module dsh-wsl-workspace/host/variants
*/
/** Top-level rows that name the execution world and are replaced by the variant's own. */
const WORLD_ROWS = /* @__PURE__ */ new Set([
	"tool-bash",
	"tool-pwsh",
	"tool-fs",
	"tool-fs-search",
	"str-replace-editor",
	"tool-str-replace-editor",
	"wsl-world",
	"filesystem",
	"persistent-shell",
	"persistent-bash",
	"bash-wsl",
	"persistent-pwsh",
	"terminal-bash",
	"terminal-pwsh",
	"custom-bash",
	"bootstrap-filesystem"
]);
/** Execution-world rows that register the model-facing editor tool. */
const EDITOR_ROWS = /* @__PURE__ */ new Set(["str-replace-editor", "tool-str-replace-editor"]);
/** The row ids this generator mounts inside its own world group. */
const WSL_WORLD_PROVIDER_IDS = ["shell-wsl", "fs-wsl"];
/**
* Whether a top-level row is this generator's own WSL world group.
*
* A preset copied from a generated variant (a user renaming `wsl-standard` to
* their own mode, say) carries the group under whatever id the copy kept, so
* the mounted provider ids identify it even when the row id changed. Without
* that check the variant would carry two world groups and the loader refuses
* the whole preset with `duplicate loader entry id: wsl-world`.
* @param block - the row's lines.
* @returns true when the row mounts this generator's WSL providers.
*/
function isWslWorldGroup(block) {
	const text = block.join("\n");
	return WSL_WORLD_PROVIDER_IDS.some((id) => new RegExp(`^\\s+- id: ${id}$`, "m").test(text));
}
/**
* The persistent-shell rows: the host's own PTY registry and its config-driven
* backend, told to run this plugin's relay (so the shell is a WSL one), plus
* the persistent tool that consumes them.
*
* Two shapes matter here. The registry is an agent-owned service — the shipped
* `persistent-shell` group keeps it in its own `terminals` realm for that
* reason — so this is a nested group of the world rather than three flat rows.
* And the persistent tool registers the tool name **`bash`**, exactly like the
* one-shot `dsh-tool-bash` row it replaces: both cannot be mounted (the tools
* registry rejects the duplicate and the whole preset fails to load), which is
* also why DSH's own Minimal mode describes itself as "a single-tool agent with
* a persistent shell". So a world with the relay paths swaps the shell tool
* instead of adding one, and a world without them keeps the one-shot row.
*/
function persistentShellRows(relayPath, nodePath, bashPath, mode) {
	if (mode === "session") return [
		"    # Persistent shell: this plugin drives one long-lived `bash` over",
		"    # pipes and ends each command with a record carrying its own nonce,",
		"    # so completion is an event rather than a match against a terminal the",
		"    # shell is allowed to repaint (issue #51 point 3: three calls hung",
		"    # 303.8 s in a real Desktop session before the host wiped the shell).",
		"    - id: bash-wsl",
		`      name: '${bashPath.replace(/'/g, "''")}'`,
		"      config:",
		"        timeoutMs: 120000",
		"        bootTimeoutMs: 20000"
	];
	return [
		"    # Persistent shell: the host PTY registry and its backend, running",
		"    # this plugin's relay, which hands the PTY to `wsl.exe … bash`",
		"    # (distribution and user come from the session). It registers the",
		"    # `bash` tool, so it takes the place of the one-shot row above.",
		"    - id: persistent-shell",
		"      name: cordis:group",
		"      group: true",
		"      isolate:",
		"        terminals: true",
		"      config:",
		"        - id: pty",
		"          name: '@deepseek-ai/dsh-terminal'",
		"        - id: terminal-wsl",
		"          name: '@deepseek-ai/dsh-terminal-bash'",
		"          config:",
		"            backendType: wsl",
		"            shellDialect: bash",
		`            shellPath: '${nodePath.replace(/'/g, "''")}'`,
		"            shellArgs:",
		`              - '${relayPath.replace(/'/g, "''")}'`,
		"        - id: persistent-bash",
		"          name: '@deepseek-ai/dsh-tool-bash-persistent'",
		"          config:",
		"            backendType: wsl",
		...SHELL_DESCRIPTION_ROWS
	];
}
/**
* The persistent tool's model-facing description, replacing the host default.
*
* The host tool's default says only that state persists, and its own Minimal
* preset goes further in the wrong direction by suggesting `sleep 10 &`. Both
* facts a WSL session needs are missing, and both were learned the hard way:
*
*  - The shell is one process for the whole Agent, so a `cd` in one call decides
*    where the *next* call starts. A model that read the one-shot tool's contract
*    ("each call runs in a fresh shell — pass `workdir` instead of using `cd`")
*    will be surprised, and a probe left in `/tmp` makes every later relative path
*    resolve somewhere it never named.
*  - The host wraps each command as `eval -- $'…'`. A trailing `&` therefore
*    backgrounds the *whole* wrapped command: the tool's completion marker is
*    printed before the work runs, so the call reports no output and exit code 0
*    while the real output arrives later and can land inside the next call's
*    output window. `( … ) &` on its own line keeps the `&` on the subshell and
*    leaves the wrapper's sequencing intact.
*
* `description` is a supported key on every declared release (its `Config` schema
* carries it from 0.1.0-rc.7 on), so the override is version-safe.
*/
const SHELL_DESCRIPTION_ROWS = [
	"            description: |-",
	"              Run commands in a persistent bash shell inside this WSL distribution. State, including",
	"              the current directory and exported environment variables, persists across calls: use",
	"              absolute paths or an explicit `cd` at the start of a command instead of relying on where",
	"              the previous call left the shell. The shell runs as the workspace's Linux user; Windows",
	"              files are reachable as /mnt/<drive>, and no toolchain install is required.",
	"              * This tool takes `command` only. It has no `run_in_background` parameter, and passing",
	"              one is ignored - use the `bash_background` tool when the mode provides it, or background",
	"              a subshell as below.",
	"              * To leave work running without a tracked job, put it in a subshell with the `&` on its",
	"              own line: `( long-job > log 2>&1 ) &`. Then poll the log file in a later call.",
	"              * Never end a `&&` chain with `&`. That backgrounds the whole command, so the call",
	"              returns immediately with no output and exit code 0, and the real output arrives later,",
	"              possibly inside the next call's output.",
	"              * Avoid commands that wait for stdin: an interactive foreground child can run until the",
	"              command timeout, and a timeout resets the shell and discards its state."
];
/** The injected WSL world group: providers + the bash/fs consumers, entry-local. */
function wslWorldGroup(shellPath, fsPath, includeEditor, persistent, searchPath, jobsPath, sawJobs = false) {
	return [
		"# ── WSL execution world (dsh-wsl-workspace variant) ─────────────────────",
		"# The shell and fs services are provided entry-locally (the isolate",
		"# realm); host services (tools registry, shell-env, jobs) fall through.",
		"- id: wsl-world",
		"  name: cordis:group",
		"  group: true",
		"  isolate:",
		"    shell: true",
		"    fs: true",
		...persistent === void 0 ? [] : ["    sandbox: true"],
		"  config:",
		`    - id: shell-wsl`,
		`      name: '${shellPath.replace(/'/g, "''")}'`,
		"    - id: fs-wsl",
		`      name: '${fsPath.replace(/'/g, "''")}'`,
		...persistent === void 0 ? [] : ["    - id: sandbox-wsl", `      name: '${persistent.sandboxPath.replace(/'/g, "''")}'`],
		...persistent === void 0 ? ["    - id: tool-bash", "      name: '@deepseek-ai/dsh-tool-bash'"] : [],
		"    - id: tool-fs",
		"      name: '@deepseek-ai/dsh-tool-fs'",
		...searchPath === void 0 ? [] : ["    - id: search-wsl", `      name: '${searchPath.replace(/'/g, "''")}'`],
		...jobsPath === void 0 || persistent === void 0 || !sawJobs ? [] : ["    - id: jobs-wsl", `      name: '${jobsPath.replace(/'/g, "''")}'`],
		...includeEditor ? [
			"    - id: str-replace-editor",
			"      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
			"      config:",
			"        maxOutputChars: 16000"
		] : [],
		...persistent === void 0 ? [] : persistentShellRows(persistent.relayPath, persistent.nodePath, persistent.bashPath, persistent.mode),
		""
	].join("\n");
}
/** The sentence appended to a standard-like persona when the variant runs in WSL. */
const PERSONA_APPEND = " Your working directory {{cwd}} is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.";
/** The upstream local-skill provider row, whose watcher cannot watch a UNC share. */
const SKILL_FILESYSTEM_ROW = "skill-filesystem";
/**
* Turn the local skill provider's watcher off inside a WSL variant.
*
* `@deepseek-ai/dsh-skill-filesystem` reports an INCOMPLETE observation when
* its watcher fails to start, and `dsh-tool-skill` withholds the whole catalog
* while a snapshot is incomplete. chokidar cannot watch
* `\\wsl.localhost\<distro>\...`, so in a WSL session the model never sees the
* catalog at all - `skill` still loads one by name, but nothing tells the model
* which skills exist. With the watcher off the discovery completes (the
* plugin's own provider rescans the share on demand, and the next session gets
* a fresh catalog); the price is no live refresh inside one running session,
* which never worked on this substrate anyway.
* @param block - the row's lines.
* @returns the row's lines with `watch: false` merged into its config.
*/
function disableSkillWatch(block) {
	const lines = [...block];
	if (lines.some((line) => /^\s*watch:/.test(line))) return lines;
	const configIndex = lines.findIndex((line) => /^\s*config:\s*$/.test(line));
	if (configIndex >= 0) {
		const childIndent = `${/^(\s*)/.exec(lines[configIndex] ?? "")?.[1] ?? "  "}  `;
		lines.splice(configIndex + 1, 0, `${childIndent}watch: false`);
		return lines;
	}
	const rowIndent = /^(\s*)/.exec(lines[0] ?? "")?.[1] ?? "";
	let insertAt = lines.length;
	while (insertAt > 0 && (lines[insertAt - 1] ?? "").trim() === "") insertAt -= 1;
	lines.splice(insertAt, 0, `${rowIndent}  config:`, `${rowIndent}    watch: false`);
	return lines;
}
/** The top-level rows of one composition, as (startLine, endLineExclusive) spans. */
function topLevelSpans(lines) {
	const spans = [];
	let start = -1;
	for (let index = 0; index < lines.length; index++) if (lines[index]?.startsWith("- id: ") === true) {
		if (start >= 0) spans.push({
			start,
			end: index
		});
		start = index;
	}
	if (start >= 0) spans.push({
		start,
		end: lines.length
	});
	return spans;
}
/** The row id of a top-level span, or undefined when the first line is malformed. */
function spanId(lines, span) {
	return /^- id: ([A-Za-z0-9_.-]+)/.exec(lines[span.start] ?? "")?.[1];
}
/** Persona config scalars that carry model-facing text, in append preference order. */
const PERSONA_TARGET_FIELDS = [
	"suffix",
	"text",
	"prefix"
];
/** Strip one layer of YAML quoting so a value can move into a block scalar. */
function unquoteScalar(value) {
	const single = /^'(.*)'$/s.exec(value);
	if (single !== null) return (single[1] ?? "").replace(/''/g, "'");
	const double = /^"(.*)"$/s.exec(value);
	return double !== null ? double[1] ?? "" : value;
}
/**
* Locate the persona scalar this transform amends.
*
* DSH moved the model-facing prompt text across releases: `text` up to
* v0.1.2-rc.1, and `prefix` + `suffix` from v0.1.3-alpha.2 on. `suffix` wins
* when both exist because it carries the working-directory sentence, so the
* appended note lands exactly where the legacy `text` block put it; `prefix`
* is the last resort for a composition that has neither. A known field with an
* empty value is not amendable.
* @param block - the persona row's lines.
* @returns the target scalar, or undefined when the row carries none.
*/
function personaTarget(block) {
	for (const field of PERSONA_TARGET_FIELDS) for (let index = 0; index < block.length; index += 1) {
		const match = new RegExp(`^(\\s*)${field}:\\s*(.*)$`).exec(block[index] ?? "");
		if (match === null) continue;
		const indent = match[1]?.length ?? 0;
		const rest = (match[2] ?? "").trim();
		if (rest === "" || /^[|>][+-]?$/.test(rest)) return {
			index,
			field,
			indent,
			header: rest,
			inline: ""
		};
		return {
			index,
			field,
			indent,
			header: "",
			inline: unquoteScalar(rest)
		};
	}
}
/**
* Index of the last line belonging to the block scalar whose header is at
* `headerIndex`. A non-blank line at or above the header's indentation is the
* next sibling key and ends the scalar — without that stop a persona carrying
* both `suffix` and `prefix` blocks would take the note in the wrong one.
* @param block - the persona row's lines.
* @param headerIndex - index of the `field: >-` header line.
* @param indent - the header's own indentation.
* @returns the last content line's index, or -1 when the scalar is empty.
*/
function lastBlockLine(block, headerIndex, indent) {
	let last = -1;
	for (let index = headerIndex + 1; index < block.length; index += 1) {
		const line = block[index] ?? "";
		if (line.trim() === "") continue;
		if ((/^(\s*)/.exec(line)?.[1]?.length ?? 0) <= indent) break;
		last = index;
	}
	return last;
}
/** Whether a top-level span is a `persona` row this transform may amend. */
function appendablePersona(lines, span) {
	const block = lines.slice(span.start, span.end);
	if (block.join("\n").includes("complete: true")) return false;
	const target = personaTarget(block);
	if (target === void 0) return false;
	return target.header === "" ? target.inline !== "" : lastBlockLine(block, target.index, target.indent) >= 0;
}
/**
* Append the WSL sentence to a persona row's model-facing scalar, in place.
*
* A block scalar takes the sentence as a sibling line, which is what the
* legacy `text: >-` form always did. An inline scalar cannot: it is folded into
* a block scalar first, so the sentence joins it the same way (and the model
* sees the same text it saw before v0.1.3-alpha.2).
* @param lines - the whole composition's lines.
* @param span - the persona row's span.
* @returns the persona row's lines, amended when a target was found.
*/
function appendPersona(lines, span) {
	const block = [...lines.slice(span.start, span.end)];
	const target = personaTarget(block);
	if (target === void 0) return block;
	const pad = " ".repeat(target.indent);
	if (target.header !== "") {
		const last = lastBlockLine(block, target.index, target.indent);
		if (last < 0) return block;
		const textIndent = /^(\s*)/.exec(block[last] ?? "")?.[1] ?? `${pad}  `;
		block.splice(last + 1, 0, `${textIndent}${PERSONA_APPEND}`);
		return block;
	}
	const child = `${pad}  `;
	block.splice(target.index, 1, `${pad}${target.field}: >-`, `${child}${target.inline}`, `${child}${PERSONA_APPEND.trim()}`);
	return block;
}
/**
* Transform one source preset composition into its WSL variant: drop the
* execution-world rows, keep everything else verbatim, and append the WSL
* world group. A row id that appears twice in the source is kept once, and a
* world group the source already carries (a preset copied from a generated
* variant) is replaced rather than duplicated, so the variant always mounts
* exactly one world pointing at this installation's providers.
*
* The source's own persistent-shell group is not re-added as such: it registers
* the same `bash` tool name as the WSL world's `dsh-tool-bash`, and the tools
* registry rejects duplicates within one preset layer — the whole variant fails
* to mount and the session falls back to another preset. Its PTY *backend*, on
* the other hand, is exactly what a stateful WSL shell needs, and it is
* config-driven: given the relay in {@link persistentShellRows} it runs
* `wsl.exe … bash` under the host's PTY, and its tool registers the separate
* `persistent-bash` name, so the one-shot `bash` above stays as it is.
* @param source - the source composition text.
* @param shellPath - absolute path of the plugin's built WSL shell provider.
* @param fsPath - absolute path of the plugin's built WSL fs provider.
* @param persistent - the relay, interpreter and sandbox provider a stateful
*   shell needs; omit to generate a world without the persistent-shell rows.
* @param searchPath - absolute path of the plugin's built in-distribution
*   `grep`/`glob` tools; mounted only for a source that had `tool-fs-search`.
* @param jobsPath - absolute path of the plugin's built background-job producer
*   for the persistent shell; mounted only alongside that shell.
* @returns the variant composition text.
*/
function transformPresetForWsl(source, shellPath, fsPath, persistent, searchPath, jobsPath) {
	const lines = source.split("\n");
	const spans = topLevelSpans(lines);
	const kept = [];
	const seen = /* @__PURE__ */ new Set();
	let sawEditor = false;
	let sawSearch = false;
	let sawJobs = false;
	let personaAppended = false;
	for (const span of spans) {
		const id = spanId(lines, span);
		if (id === void 0) {
			kept.push(...lines.slice(span.start, span.end));
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		const block = lines.slice(span.start, span.end);
		if (WORLD_ROWS.has(id) || isWslWorldGroup(block)) {
			if (EDITOR_ROWS.has(id)) sawEditor = true;
			if (id === "tool-fs-search") sawSearch = true;
			continue;
		}
		if (id === SKILL_FILESYSTEM_ROW) {
			kept.push(...disableSkillWatch(block));
			continue;
		}
		if (id === "persona" && !personaAppended && appendablePersona(lines, span)) {
			kept.push(...appendPersona(lines, span));
			personaAppended = true;
			continue;
		}
		kept.push(...block);
	}
	if (source.includes("str-replace-editor")) sawEditor = true;
	if (source.includes("tool-fs-search")) sawSearch = true;
	if (source.includes("tool-jobs")) sawJobs = true;
	const result = [...kept];
	if (result.length > 0 && result[result.length - 1] !== "") result.push("");
	result.push(wslWorldGroup(shellPath, fsPath, sawEditor, persistent, sawSearch ? searchPath : void 0, jobsPath, sawJobs));
	return result.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
/** Whether an id is one of this plugin's own preset directories. */
function isWslVariantId(id) {
	return id === "wsl" || /^wsl-[a-z0-9-]+$/.test(id);
}
/** The variant id for one source preset id. */
function variantIdFor(sourceId) {
	return `wsl-${sourceId.toLowerCase()}`;
}
//#endregion
//#region src/host/wsl-skills.ts
/**
* WSL workspace skill provider (host half).
*
* DSH's shipped skill-filesystem provider scans only the session cwd's
* project root (the nearest `.git` ancestor) for `.dsh/skills` / `.agents/skills`
* and never descends into nested projects. A WSL workspace whose project
* folders live below the registered workspace root therefore shows an empty
* skill catalog, even though the same layout works when the session cwd is
* the project folder itself (issue #10).
*
* This provider mirrors the host's discovery rules for WSL UNC session
* workspaces: it starts at the session cwd's nearest `.git` ancestor (the
* host's project-root rule; the cwd itself when no ancestor has a `.git`
* marker), then walks that root (depth- and budget-bounded). Directory
* symlinks are followed when the substrate resolves them, and — the case the
* `\\wsl.localhost` 9P share creates, where a link is listed but its Linux
* target cannot be resolved Windows-side — the distribution itself resolves
* them through bounded, concurrent `wsl.exe … readlink -f` calls. The walk
* collects every
* `.dsh/skills` and `.agents/skills` directory it finds — including nested
* projects, linked-in projects anywhere on the Linux filesystem, and projects
* reachable through more than one path — and publishes their skills with the
* same project ranks and sources the host uses, so precedence and duplicate
* resolution behave identically. Non-WSL lookups return nothing and leave
* the host's own providers untouched.
*
* All filesystem reads go through `node:fs` against the `\\wsl.localhost\…`
* 9P share (the same substrate `WslFileSystem` uses); the distribution-side
* resolution rides `wsl.exe` through `execFile` (no shell interpolation), and
* an injectable IO face keeps the discovery logic unit-testable without a
* live distro.
*
* @module dsh-wsl-workspace/host/wsl-skills
*/
/** Project ranks copied from @deepseek-ai/dsh-skill-filesystem so WSL and host entries interleave identically. */
const PROJECT_DSH_RANK = 100;
const PROJECT_AGENTS_RANK = 200;
/** How many directory levels below the workspace root are scanned. */
const MAX_SCAN_DEPTH = 4;
/** Maximum distinct skill directories published per lookup. */
const MAX_SKILL_ROOTS = 64;
/** Maximum directories visited per lookup (an absolute blast-radius cap). */
const MAX_VISITED_DIRECTORIES = 4096;
/**
* How many Linux symlinks one lookup may hand to the distribution (a second
* blast-radius cap, and a latency cap: each resolution is a short `wsl.exe`
* call, so a tree with hundreds of links cannot stall the catalog).
*/
const MAX_LINK_RESOLUTIONS = 32;
/** How many parent levels above the session cwd are searched for a `.git` project marker. */
const MAX_ANCESTOR_WALK = 64;
/**
* How many directories one discovery layer may probe at once.
*
* A `readdir` over the `\\wsl.localhost\…` share measured 15.6 ms against 1.6 ms
* for a `stat`, and a budget-sized walk is 4096 directories: probing one
* directory at a time costs 20-30 s, which is what a turn in a large workspace
* used to wait for. The layer stays bounded so the share is never flooded; node's
* own filesystem thread pool is what ultimately caps the real parallelism.
*/
const WALK_CONCURRENCY = 16;
/** Maximum cached lookups (one entry per distinct scan root across sessions). */
const CACHE_MAX_ENTRIES = 32;
/**
* How often a served scan root is re-checked for catalog changes: the skills
* directories it published, plus one modification stamp per skill file. This is
* the pass that makes a skill added — or a description edited — mid-session
* visible on the model's next request.
*/
const REFRESH_POLL_MS = 3e3;
/**
* How often the full re-discovery walk runs for a served scan root. Only a walk
* can find a skills directory that did not exist before (a new nested project,
* say), and it costs one `readdir` per visited directory, so it runs on its own
* slower cadence instead of on every poll. It used to be the only pass, at
* {@link REFRESH_POLL_MS}'s old value of 10 s.
*/
const DISCOVERY_POLL_MS = 3e4;
/** Kebab-case skill names, matching the host grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Directory names that never contain project skill roots (safe to prune while walking). */
const PRUNED_DIRECTORY_NAMES = /* @__PURE__ */ new Set([
	".git",
	".hg",
	".svn",
	".bzr",
	"node_modules",
	".venv",
	"venv",
	".tox",
	".pants.d",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"coverage",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".cache",
	".idea",
	".vscode",
	".serverless",
	".terraform",
	".yarn",
	".pnpm-store"
]);
/** The node:fs/promises implementation the provider uses in production. */
const nodeSkillIo = {
	readdir: async (path, options) => readdir(path, options),
	readFile: async (path, options) => readFile(path, options),
	stat: async (path) => stat(path),
	resolveLinks: async (uncPaths) => resolveLinuxSymlinks(uncPaths)
};
/**
* Locate the nearest ancestor of `linuxDir` (the directory itself included)
* containing a `.git` marker, mirroring the host skill-filesystem's
* project-root rule. `.git` may be a directory or a worktree pointer file;
* existence is enough. Bounded so a pathological path cannot spin the walk.
* @param distro - the WSL distribution name.
* @param linuxDir - the session cwd's absolute Linux path.
* @param io - filesystem face.
* @returns the project root's Linux path, or `undefined` when no ancestor carries a `.git`.
*/
async function nearestGitAncestor(distro, linuxDir, io) {
	let current = linuxDir;
	for (let levels = 0; levels <= MAX_ANCESTOR_WALK; levels += 1) {
		try {
			await io.stat(joinUnc(distro, posix.join(current, ".git")));
			return current;
		} catch {}
		const parent = posix.dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
/**
* Everything the walk learns from one directory, in the order the round trips
* are worth paying for: the listing first — it also says which skill markers can
* exist there at all — then the markers it showed.
* @param distro - the WSL distribution name.
* @param dir - the directory's Linux path.
* @param depth - its depth below the scan root.
* @param io - filesystem face.
* @returns the directory's roots, child directories and unresolved links.
*/
async function probeDirectory(distro, dir, depth, io) {
	let entries;
	if (depth < MAX_SCAN_DEPTH) try {
		entries = await io.readdir(joinUnc(distro, dir), { withFileTypes: true });
	} catch {}
	const listed = entries ?? [];
	const allMarkers = PROJECT_SKILL_MARKERS.map(([marker]) => marker);
	const roots = await skillRootsOfDirectory(distro, dir, io, entries === void 0 ? allMarkers : allMarkers.filter((marker) => listed.some((entry) => entry.name === marker)));
	const children = [];
	const links = [];
	for (const entry of listed) {
		if (PRUNED_DIRECTORY_NAMES.has(entry.name)) continue;
		if (entry.name.startsWith(".") && entry.name !== ".dsh" && entry.name !== ".agents") continue;
		if (entry.name === ".dsh" || entry.name === ".agents") continue;
		const childPath = posix.join(dir, entry.name);
		if (entry.isDirectory()) {
			children.push([childPath, depth + 1]);
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		try {
			if ((await io.stat(joinUnc(distro, childPath))).isDirectory()) children.push([childPath, depth + 1]);
			continue;
		} catch {}
		links.push([childPath, depth + 1]);
	}
	return {
		roots,
		children,
		links
	};
}
/**
* Scan a WSL workspace root for nested skill directories.
*
* A layer is probed concurrently but published in frontier order, so the
* catalog never depends on which probe happened to finish first, and the budget
* is claimed before any probe starts: concurrency must not change what is
* visited, only how long it takes.
* @param distro - the WSL distribution name.
* @param linuxRoot - the workspace's absolute Linux path.
* @param io - filesystem face.
* @returns discovered skill directories, bounded by depth and budget.
*/
async function discoverSkillRoots(distro, linuxRoot, io) {
	const roots = [];
	const visited = /* @__PURE__ */ new Set();
	let linksResolved = 0;
	let frontier = [[linuxRoot, 0]];
	while (frontier.length > 0 && roots.length < MAX_SKILL_ROOTS) {
		const layer = [];
		for (const item of frontier) {
			if (visited.size >= MAX_VISITED_DIRECTORIES) break;
			if (visited.has(item[0])) continue;
			visited.add(item[0]);
			layer.push(item);
		}
		if (layer.length === 0) return roots;
		const probes = new Array(layer.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, layer.length) }, async () => {
			for (let index = next; index < layer.length; index = next) {
				next += 1;
				const [dir, depth] = layer[index];
				probes[index] = await probeDirectory(distro, dir, depth, io);
			}
		}));
		const nextLayer = [];
		const links = [];
		for (const probe of probes) {
			if (probe === void 0) continue;
			if (roots.length < MAX_SKILL_ROOTS) roots.push(...probe.roots.slice(0, MAX_SKILL_ROOTS - roots.length));
			nextLayer.push(...probe.children);
			links.push(...probe.links);
		}
		if (visited.size >= MAX_VISITED_DIRECTORIES) return roots;
		if (links.length > 0 && io.resolveLinks !== void 0 && linksResolved < MAX_LINK_RESOLUTIONS) {
			const batch = links.slice(0, MAX_LINK_RESOLUTIONS - linksResolved);
			linksResolved += batch.length;
			const resolved = await io.resolveLinks(batch.map(([path]) => joinUnc(distro, path)));
			for (let index = 0; index < batch.length; index += 1) {
				const real = resolved[index];
				if (real === void 0) continue;
				try {
					if ((await io.stat(real)).isDirectory()) nextLayer.push([uncToLinux(real), batch[index][1]]);
				} catch {}
			}
		}
		frontier = nextLayer;
	}
	return roots;
}
/** The two project skill markers, with the source and rank each publishes. */
const PROJECT_SKILL_MARKERS = [[
	".dsh",
	"project-dsh",
	PROJECT_DSH_RANK
], [
	".agents",
	"project-agents",
	PROJECT_AGENTS_RANK
]];
/**
* Publish the skill roots of one scanned directory (its `.dsh/skills` and
* `.agents/skills`, each with the host's project ranks).
* @param distro - the WSL distribution name.
* @param linuxDir - the scanned directory's Linux path.
* @param io - filesystem face.
* @param markers - the markers worth probing. The walk narrows this to the ones
*   its listing actually showed, because each probe is a round trip and a
*   directory without a `.dsh` entry cannot hold `.dsh/skills`.
* @returns the directory's skill roots that exist.
*/
async function skillRootsOfDirectory(distro, linuxDir, io, markers = PROJECT_SKILL_MARKERS.map(([marker]) => marker)) {
	const result = [];
	for (const [marker, source, rank] of PROJECT_SKILL_MARKERS) {
		if (!markers.includes(marker)) continue;
		const path = joinUnc(distro, posix.join(linuxDir, marker, "skills"));
		try {
			if ((await io.stat(path)).isDirectory()) result.push({
				path,
				source,
				rank
			});
		} catch {}
	}
	return result;
}
/** List one skills directory's entries (directory bundles and flat `.md` skills). */
async function listSkillEntries(root, io) {
	let dirents;
	try {
		dirents = await io.readdir(root.path, { withFileTypes: true });
	} catch {
		return [];
	}
	const entries = [];
	for (const entry of dirents) if (entry.isDirectory()) entries.push({
		name: entry.name,
		kind: "bundle",
		path: join(root.path, entry.name, "SKILL.md")
	});
	else if (entry.isFile() && entry.name.endsWith(".md")) entries.push({
		name: entry.name.slice(0, -3),
		kind: "flat",
		path: join(root.path, entry.name)
	});
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}
/**
* The published shape of one skills directory: its path, then each skill's name,
* kind and modification stamp.
*
* The stamp is what makes an edit to an *existing* skill visible: the catalog the
* model sees is rebuilt only when the registry's revision moves, and a directory
* listing alone cannot tell a rewritten `SKILL.md` from an untouched one. One
* `stat` per skill file (never a read) is the whole cost, and a file that cannot
* be stamped reports the same `gone` marker on every pass, so a substrate that
* does not expose modification times simply never triggers on content.
* @param root - the skills directory.
* @param entries - its entries, as just listed.
* @param io - filesystem face.
* @returns the deterministic shape string for this directory.
*/
async function shapeOfRoot(root, entries, io) {
	const stamps = await Promise.all(entries.map(async (entry) => {
		try {
			const info = await io.stat(entry.path);
			return `${entry.name}:${entry.kind}:${info.mtimeMs ?? 0}:${info.size ?? 0}`;
		} catch {
			return `${entry.name}:${entry.kind}:gone`;
		}
	}));
	return `${root.path}\u0001${stamps.sort().join(",")}`;
}
/** Read and parse one skill file; `undefined` when missing or unparsable. */
async function readSkill(path, io, signal) {
	signal?.throwIfAborted();
	let raw;
	try {
		raw = await io.readFile(path, { encoding: "utf8" });
	} catch {
		return;
	}
	signal?.throwIfAborted();
	return parseSkillFrontmatter(raw, path);
}
/**
* Parse the frontmatter subset skill files use: `---` fenced YAML with
* `name` / `description` / `whenToUse` / `user-invocable` /
* `disable-model-invocation`. Single-line scalars and block scalars
* (`|` literal, `>` folded) are understood; anything else is skipped,
* matching the shipped provider's leniency: a bad file must not fail
* the catalog.
*/
function parseSkillFrontmatter(raw, path) {
	if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
	const start = firstLineEnd + 1;
	const closing = findFrontmatterEnd(raw, start);
	if (closing === void 0) return void 0;
	const lines = raw.slice(start, closing).split("\n");
	const fields = /* @__PURE__ */ new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").replace(/\r$/, "");
		const block = /^([A-Za-z0-9-]+):\s*([|>])[+-]?\s*$/.exec(line);
		if (block !== null) {
			const value = parseBlockScalar(lines, index, block[2] === ">");
			index = value.nextLineIndex;
			if (value.text !== "") fields.set(block[1] ?? "", value.text);
			continue;
		}
		const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = match[2]?.trim() ?? "";
		if (value !== "") fields.set(match[1] ?? "", unquote(value));
	}
	const name = fields.get("name") ?? "";
	const description = fields.get("description") ?? "";
	if (!SKILL_NAME.test(name) || description === "") return;
	const whenToUse = fields.get("whenToUse");
	return {
		name,
		description,
		...whenToUse !== void 0 && whenToUse !== "" ? { whenToUse } : {},
		invocation: {
			modelInvocable: !frontmatterBoolean(fields, "disable-model-invocation"),
			userInvocable: frontmatterBoolean(fields, "user-invocable", true)
		},
		content: raw.slice(closing).trim()
	};
}
/**
* Collect a YAML block scalar (`key: |` literal or `key: >` folded) starting
* at `startIndex`'s following lines. The block runs until the first
* non-indented, non-blank line; its common indentation is stripped.
* @returns the scalar text and the index of the last consumed line.
*/
function parseBlockScalar(lines, startIndex, folded) {
	const collected = [];
	let indent;
	let index = startIndex;
	while (index + 1 < lines.length) {
		index += 1;
		const next = (lines[index] ?? "").replace(/\r$/, "");
		if (next.trim() === "") {
			collected.push("");
			continue;
		}
		const indented = /^([ \t]+)(.*)$/.exec(next);
		if (indented === null) {
			index -= 1;
			break;
		}
		indent ??= indented[1];
		collected.push(indented[1]?.startsWith(indent) === true ? indented[2] : indented[1].replace(/^[ \t]+/, "") + indented[2]);
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	return {
		text: (folded ? collected.filter((line) => line !== "").join(" ") : collected.join("\n")).trim(),
		nextLineIndex: index
	};
}
/** Locate the closing `---` line of a frontmatter block. */
function findFrontmatterEnd(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") return lineEnd + 1;
		if (nextNewline < 0) return void 0;
		lineStart = nextNewline + 1;
	}
}
/** Strip one level of matching quotes from a scalar value. */
function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if (first === "\"" && last === "\"" || first === "'" && last === "'") return value.slice(1, -1);
	}
	return value;
}
/** Boolean semantics for `user-invocable` / `disable-model-invocation` (matches the host parser). */
function frontmatterBoolean(fields, key, dflt = false) {
	const value = fields.get(key);
	if (value === void 0) return dflt;
	switch (value.toLowerCase()) {
		case "true":
		case "yes":
		case "on":
		case "1": return true;
		case "false":
		case "no":
		case "off":
		case "0": return false;
		default: return dflt;
	}
}
/**
* The WSL workspace skill provider. Registered on the host's `ctx.skills`
* registry; serves only lookups whose cwd is a WSL UNC workspace path.
*
* Completed `list()` lookups are cached per scan root and served as-is: a lookup
* is on the session's request path, and re-walking the tree there is what made
* every turn in a large workspace wait for a 4096-directory scan of the 9P
* share. `get()` always re-reads the skill file so body edits are picked up
* immediately.
*
* A scan root that has been served is re-checked every REFRESH_POLL_MS: the
* host cannot watch a `\\wsl.localhost\…` path (which is why the generated
* preset pins `watch: false`), so this provider watches for it instead. A
* changed directory listing clears the cache and calls `control.invalidate()`,
* which bumps the registry's revision; the catalog middleware re-collects on
* the session's next request, so a skill added mid-session reaches the model
* without starting a new session, and the cache is only ever refilled by a
* lookup the detector has already invalidated.
*/
var WslSkillsProvider = class {
	name = "wsl-workspace";
	control;
	io;
	refreshMs;
	/** Cheap polls between two full discovery walks (at least one). */
	walkEveryPolls;
	/** The published catalog per scan root, served until its detector drops it. */
	cache = /* @__PURE__ */ new Map();
	/** One change detector per served scan root, keyed like {@link cache}. */
	detectors = /* @__PURE__ */ new Map();
	constructor(control, io = nodeSkillIo, refreshMs = REFRESH_POLL_MS, discoveryMs = DISCOVERY_POLL_MS) {
		this.control = control;
		this.io = io;
		this.refreshMs = refreshMs;
		this.walkEveryPolls = Math.max(1, Math.round(discoveryMs / refreshMs));
	}
	/**
	* Discover nested project skills for a WSL UNC session workspace.
	* @param options - lookup options; `cwd` selects the WSL workspace.
	* @returns candidates for every `.dsh/skills` / `.agents/skills` under the
	*   session's scan root — the nearest `.git` ancestor of the cwd, else the
	*   cwd itself — or an empty array for non-WSL lookups.
	*/
	async list(options) {
		this.control.signal.throwIfAborted();
		options.signal?.throwIfAborted();
		const unc = options.cwd === void 0 ? null : parseWslUnc(options.cwd);
		if (unc === null) return [];
		const scanRoot = await nearestGitAncestor(unc.distro, unc.linuxPath, this.io) ?? unc.linuxPath;
		const cacheKey = `${unc.distro}\u0000${scanRoot}`;
		const cached = this.cache.get(cacheKey);
		if (cached !== void 0) {
			this.cache.delete(cacheKey);
			this.cache.set(cacheKey, cached);
			return [...cached];
		}
		const roots = await discoverSkillRoots(unc.distro, scanRoot, this.io);
		const candidates = [];
		const seenSkills = /* @__PURE__ */ new Set();
		const signature = [];
		for (const root of roots) {
			const entries = await listSkillEntries(root, this.io);
			signature.push(await shapeOfRoot(root, entries, this.io));
			for (const entry of entries) {
				options.signal?.throwIfAborted();
				const parsed = await readSkill(entry.path, this.io, options.signal);
				if (parsed === void 0) continue;
				const fingerprint = `${parsed.name}\u0000${parsed.content}`;
				if (seenSkills.has(fingerprint)) continue;
				seenSkills.add(fingerprint);
				candidates.push({
					name: parsed.name,
					description: parsed.description,
					...parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {},
					invocation: parsed.invocation,
					source: root.source,
					provider: this.name,
					rank: root.rank,
					locator: {
						path: entry.path,
						directory: entry.kind === "bundle" ? join(entry.path, "..") : root.path
					},
					path: entry.path
				});
			}
		}
		this.cache.set(cacheKey, candidates);
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === void 0) break;
			this.cache.delete(oldest);
		}
		this.watch(cacheKey, unc.distro, scanRoot, signature.join(""), roots);
		return [...candidates];
	}
	/**
	* Keep one scan root's catalog honest for as long as this provider is
	* registered: the host cannot watch a UNC workspace, so the provider polls the
	* shape it just published and, on any difference, drops its own cache and asks
	* the registry to re-collect for the session's next request.
	*
	* Two passes keep that affordable: the cheap one (every
	* {@link REFRESH_POLL_MS}) re-reads the skills directories already published
	* and re-stats their skill files, so an added, removed or edited skill is
	* noticed on its own; the full re-discovery walk (every
	* {@link DISCOVERY_POLL_MS}) is what can find a skills directory that did not
	* exist before. Neither pass reads a skill file: the description the catalog
	* shows changes only through the registry's revision.
	* @param cacheKey - this provider's key for the scan root.
	* @param distro - the WSL distribution.
	* @param scanRoot - the Linux path the lookup scanned.
	* @param signature - the shape the lookup just published.
	* @param roots - the skills directories that lookup found.
	*/
	watch(cacheKey, distro, scanRoot, signature, roots) {
		const existing = this.detectors.get(cacheKey);
		if (existing !== void 0) {
			existing.signature = signature;
			existing.roots = roots;
			return;
		}
		const detector = {
			timer: setInterval(() => void this.detect(cacheKey, distro, scanRoot), this.refreshMs),
			signature,
			roots,
			polls: 0,
			busy: false
		};
		if (typeof detector.timer.unref === "function") detector.timer.unref();
		this.detectors.set(cacheKey, detector);
		this.control.signal.addEventListener("abort", () => {
			clearInterval(detector.timer);
			this.detectors.delete(cacheKey);
		}, { once: true });
	}
	/** One poll: the cheap pass always, the discovery walk on its own cadence. */
	async detect(cacheKey, distro, scanRoot) {
		const detector = this.detectors.get(cacheKey);
		if (detector === void 0 || this.control.signal.aborted) return;
		if (detector.busy) return;
		detector.busy = true;
		try {
			detector.polls += 1;
			const walk = detector.polls % this.walkEveryPolls === 0;
			let signature;
			try {
				signature = await this.shape(distro, walk ? await discoverSkillRoots(distro, scanRoot, this.io) : detector.roots);
			} catch {
				return;
			}
			if (signature === detector.signature) return;
			detector.signature = signature;
			this.cache.delete(cacheKey);
			this.control.invalidate();
		} finally {
			detector.busy = false;
		}
	}
	/** The shape of one root set: paths, entry names, kinds and file stamps. */
	async shape(distro, roots) {
		const parts = [];
		for (const root of roots) parts.push(await shapeOfRoot(root, await listSkillEntries(root, this.io), this.io));
		return parts.join("");
	}
	/**
	* Load a complete skill body for a previously listed candidate.
	* @param candidate - the candidate this provider returned.
	* @param options - lookup options whose signal cancels the read.
	* @returns the full skill, or `undefined` if the file disappeared.
	*/
	async get(candidate, options) {
		this.control.signal.throwIfAborted();
		const parsed = await readSkill(candidate.locator.path, this.io, options.signal);
		if (parsed === void 0 || parsed.name !== candidate.name) return void 0;
		return {
			name: parsed.name,
			description: parsed.description,
			...parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {},
			invocation: parsed.invocation,
			source: candidate.source,
			provider: candidate.provider,
			rank: candidate.rank,
			locator: candidate.locator,
			path: candidate.path,
			content: parsed.content
		};
	}
};
//#endregion
//#region src/index.ts
/** The HTTP route this plugin serves (a relative, same-origin path). */
const DEFAULT_ROUTE = "/wsl-workspace/api";
/**
* Bilingual display labels for the shipped source modes, matching the app's
* own built-in copy in each language — note the `code` preset is "PTC 模式"
* in the Chinese copy but "Code mode" in English. The DSH picker localizes
* only the four built-in ids itself; `wsl-*` variant ids render the
* preset.yml text verbatim, so the plugin writes one bilingual string so
* both locales can identify each variant. Custom presets keep their own
* name.
*
* This table is consulted before anything the release publishes, so every id
* the mode has ever carried needs an entry. `code` was the id up to
* `0.1.0-rc.8` and `ptc` is the id from `0.1.1` on; without the `ptc` entry the
* lookup returned undefined and the variant fell through to the release's own
* display name — which `0.1.7` does not publish at all, leaving the mode named
* `WSL · ptc` with the generic description `WSL execution world for ptc: …`.
*/
const MODE_DISPLAY_LABELS = {
	standard: {
		en: "Standard mode",
		zh: "标准模式"
	},
	code: {
		en: "Code mode",
		zh: "PTC 模式"
	},
	ptc: {
		en: "PTC mode",
		zh: "PTC 模式"
	},
	minimal: {
		en: "Minimal mode",
		zh: "极简模式"
	},
	cordis: {
		en: "Creator mode",
		zh: "创造模式"
	}
};
/**
* Quote a value as a single-line YAML single-quoted scalar. Plain scalars
* cannot contain `: ` (colon + space), which plain English sentences do —
* written unquoted they make the whole preset.yml unparsable, dropping the
* name, description and order together.
*/
function yamlScalar(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
/** The variant name for one shipped mode (bilingual) or a custom preset. */
function variantName(presetId, sourceName) {
	const labels = MODE_DISPLAY_LABELS[presetId];
	return labels === void 0 ? `WSL · ${sourceName}` : `WSL · ${labels.en}（${labels.zh}）`;
}
/** The variant description for one shipped mode (bilingual) or a custom preset. */
function variantDescription(presetId) {
	const labels = MODE_DISPLAY_LABELS[presetId];
	return `WSL execution world for ${labels === void 0 ? presetId : `${labels.en}（${labels.zh}）`}: bash and file tools run inside the WSL distribution.`;
}
const MAX_BODY_BYTES = 1048576;
/** Valid WSL distribution names: one path-safe segment (no separators, no dot-dirs). */
const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
/** The loopback hostnames the data route answers to (DNS-rebinding fence). */
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/** True when a socket address is loopback (any IPv4/IPv6 spelling). */
function isLoopback(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** The hostname part of a `Host` header value (port and IPv6 brackets stripped). */
function hostNameOf(host) {
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end >= 0 ? host.slice(1, end) : host;
	}
	return host.split(":")[0] ?? "";
}
/** True when the request's `Host` header names a loopback host. */
function isLoopbackHost(host) {
	return host !== void 0 && LOOPBACK_HOSTNAMES.has(hostNameOf(host).toLowerCase());
}
/**
* Validate a wire-supplied distribution name before it becomes a UNC segment:
* an attacker-controlled segment containing separators or `..` would escape
* the `\\wsl.localhost\` share structure into arbitrary UNC paths.
* @param value - the raw wire value.
* @returns the validated distro name.
*/
function requireDistro(value) {
	if (typeof value !== "string" || !DISTRO_PATTERN.test(value) || value === "." || value === "..") throw new Error("distro must be a valid WSL distribution name");
	return value;
}
/** Human text for an unknown rejection. */
function messageOf(value) {
	return value instanceof Error ? value.message : String(value);
}
/** Write one JSON envelope. */
function json(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(body));
}
/** Collect and parse the request body, bounded. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
		chunks.push(buffer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/** Normalize a Linux path for the wire (rejecting non-absolute input). */
function requireLinuxPath(value, label) {
	if (typeof value !== "string" || !isAbsoluteLinuxPath(value)) throw new Error(`${label} must be an absolute Linux path`);
	return normalizeLinuxPath(value);
}
/** Validate a wire-supplied workspace path and return its canonical UNC form. */
function requireWslUnc(value) {
	if (typeof value !== "string") throw new Error("path must be a string");
	const canonical = canonicalWslUnc(value);
	if (canonical === null) throw new Error("path must be a WSL UNC workspace path");
	return canonical;
}
/**
* Resolve one directory listing for the dialog. The 9P share (`\\wsl.localhost\…`)
* serves only the ext4 volume: `/mnt/<drive>` (drvfs) reads return Access
* denied, so drvfs paths are read through their Windows drive spelling and
* `/mnt` itself is synthesized from the drives present on the host.
*/
function listWslDir(distro, linuxPath) {
	if (linuxPath === "/mnt") {
		const entries = [];
		for (let i = 0; i < 26; i++) {
			const letter = String.fromCharCode(65 + i);
			try {
				if (statSync(`${letter}:\\`).isDirectory()) entries.push({
					name: letter.toLowerCase(),
					kind: "directory"
				});
			} catch {}
		}
		return {
			path: "/mnt",
			parent: "/",
			entries
		};
	}
	const winPath = mntToWindowsPath(linuxPath);
	const readPath = winPath !== null ? winPath : joinUnc(distro, linuxPath);
	const entries = readdirSync(readPath, { withFileTypes: true }).slice(0, 1e3).map((dirent) => {
		const kind = dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other";
		return {
			name: dirent.name,
			kind
		};
	}).sort((a, b) => {
		if (a.kind === "directory" && b.kind !== "directory") return -1;
		if (a.kind !== "directory" && b.kind === "directory") return 1;
		return a.name.localeCompare(b.name);
	});
	return {
		path: linuxPath,
		parent: linuxPath === "/" ? null : linuxPath.split("/").slice(0, -1).join("/") || "/",
		entries
	};
}
/** Cached self-description for the dialog's help panel. */
let selfDescription;
/**
* Read this plugin's own `package.json` for the dialog's help panel: the
* published version and the declared `dsh.compatibility.dshReleases` matrix.
* A plugin directory that cannot be read reports empty values rather than
* failing the dialog, and the result is cached for the process lifetime.
* @returns the self-description served by the `describe` method.
*/
function describeSelf() {
	if (selfDescription !== void 0) return selfDescription;
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw);
		selfDescription = {
			version: typeof parsed.version === "string" ? parsed.version : "unknown",
			releases: Object.entries(parsed.dsh?.compatibility?.dshReleases ?? {}).map(([id, status]) => ({
				id,
				status: String(status)
			}))
		};
	} catch {
		selfDescription = {
			version: "unknown",
			releases: []
		};
	}
	return selfDescription;
}
/** Route one method dispatch. */
async function dispatch(method, params) {
	switch (method) {
		case "listDistros": {
			const distros = await listDistros();
			const fallback = await defaultDistro();
			if (fallback !== void 0 && distros.includes(fallback)) return [fallback, ...distros.filter((name) => name !== fallback)];
			return distros;
		}
		case "listDir": return listWslDir(requireDistro(params.distro), requireLinuxPath(params.path, "path"));
		case "check": {
			const distro = requireDistro(params.distro);
			const path = requireLinuxPath(params.path, "path");
			const winPath = mntToWindowsPath(path);
			const readPath = winPath !== null ? winPath : joinUnc(distro, path);
			try {
				return {
					exists: true,
					isDirectory: statSync(readPath).isDirectory()
				};
			} catch {
				return {
					exists: false,
					isDirectory: false
				};
			}
		}
		case "registerWindows": {
			const distro = requireDistro(params.distro);
			const linuxPath = requireLinuxPath(params.linuxPath, "path");
			const winPath = mntToWindowsPath(linuxPath);
			if (winPath === null) throw new Error("registerWindows requires a /mnt/<drive> Linux path");
			const username = typeof params.username === "string" ? params.username : void 0;
			registerWindowsWorkspace(winPath, distro, username);
			return null;
		}
		case "listWorkspaces": return listWorkspaceKeys();
		case "listWorkspaceRecords": return listWorkspaceRecords();
		case "describe": return describeSelf();
		case "setUser": {
			const path = requireWslUnc(params.path);
			const username = params.username;
			if (username === void 0 || username === "") setWorkspaceUsername(path, void 0);
			else {
				if (typeof username !== "string" || !isValidWslUsername(username)) throw new Error("username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
				setWorkspaceUsername(path, username);
			}
			return null;
		}
		default: throw new Error(`unknown method "${method}"`);
	}
}
/**
* Read one preset's declared composition across both roster generations.
* @param agentPresets - the roster face.
* @param preset - the roster entry to read.
* @returns the composition text, plus the display name when the face publishes it.
*/
async function readPresetComposition(agentPresets, preset) {
	if (typeof agentPresets.readDocument === "function") {
		const document = await agentPresets.readDocument(preset.id);
		return document.name === void 0 ? { content: document.content } : {
			content: document.content,
			name: document.name
		};
	}
	if (typeof agentPresets.read === "function") return { content: await agentPresets.read(preset.id) };
	throw new Error(`agentPresets: this DSH release exposes neither readDocument() nor read() (preset "${preset.id}")`);
}
/**
* Name the copy of a bare specifier this file is standing on.
*
* Issue #47 was invisible for as long as it existed because the failure it produced
* named nothing: `state.schema.lookupSequenceTag is not a function` says neither
* which package, nor which version, nor from where. Every dialect failure below
* therefore carries this line, and it is measured rather than asserted — a hoisted
* wrong major, a nested copy that was never installed, and a bundler that inlined a
* different release all answer differently here.
* @param specifier - the bare specifier the loader was asked for.
* @returns `name version at path`, or why it could not be said.
*/
function describeResolvedCopy(specifier) {
	const resolve = import.meta.resolve;
	if (typeof resolve !== "function") return `${specifier} (this runtime exposes no resolver)`;
	try {
		let dir = dirname(fileURLToPath(resolve.call(import.meta, specifier)));
		for (let depth = 0; depth < 8; depth += 1) {
			const manifestPath = join(dir, "package.json");
			if (existsSync(manifestPath)) {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (manifest.name === specifier) return `${specifier} ${manifest.version ?? "version-unknown"} at ${dir}`;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return `${specifier} resolved to ${dir}, above which no manifest names it`;
	} catch (error) {
		return `${specifier} did not resolve (${messageOf(error)})`;
	}
}
/**
* Build the entry-list dialect from the engine namespace that will parse with it.
*
* `@deepseek-ai/cordis-plugin-include` exports an `entryListSchema` precisely so
* config tooling can round-trip this dialect, and this plugin used to borrow it at
* call time. That borrow cost the plugin its core feature on any host that packages
* itself as an archive: a bare `import()` walks the filesystem upward, and an
* archive-backed host's tree is not on it (issue #47). Only the load half of that
* schema is ever used here — `predicate` and `represent` serve a dump path this
* plugin does not take — so the dialect is ~six lines, and building it from the same
* namespace that supplies `load()` is what makes it impossible for the schema and
* the engine to come from different majors.
* @param ns - the js-yaml namespace the same call parses with.
* @returns the schema, or undefined when this copy cannot express the dialect.
*/
function entryListSchemaFrom(ns) {
	const Type = ns.Type ?? ns.default?.Type;
	const JsonSchema = ns.JSON_SCHEMA ?? ns.default?.JSON_SCHEMA;
	if (typeof Type !== "function" || JsonSchema?.extend === void 0) return void 0;
	const jsExpr = new Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		resolve: (data) => typeof data === "string",
		construct: (data) => ({ __jsExpr: data })
	});
	return JsonSchema.extend(jsExpr);
}
/**
* Parse one transformed composition back into declaration rows.
*
* The composition is the entry-list YAML dialect, whose `!!js` scalars are
* expression nodes the Loader evaluates when the row activates; parsing the text
* back is what lets the (text-level) WSL transform keep working now that a variant
* is a declaration row instead of a directory of YAML.
*
* The engine is still resolved at call time rather than at module load: a release
* that ever loses it must fail the variants and not refuse to load the whole plugin.
* What it no longer borrows is the dialect, so the only thing to be reachable is one
* package this plugin now declares for itself.
* @param content - the variant composition text.
* @returns the declaration's plugin rows.
*/
async function parseVariantComposition(content) {
	const specifier = "js-yaml";
	const ns = await import(specifier);
	const load = ns.load ?? ns.default?.load;
	if (typeof load !== "function") throw new Error(`${specifier}: no load() export (${describeResolvedCopy(specifier)})`);
	const schema = entryListSchemaFrom(ns);
	if (schema === void 0) throw new Error(`${specifier}: this copy cannot express the entry-list dialect, which needs the 4.x Type / JSON_SCHEMA.extend API (${describeResolvedCopy(specifier)})`);
	const probe = load("- id: probe\n  disabled: !!js true\n", { schema });
	if ((Array.isArray(probe) ? probe[0] : void 0)?.disabled?.__jsExpr !== "true") throw new Error(`${specifier}: the entry-list dialect did not round-trip (${describeResolvedCopy(specifier)})`);
	const rows = load(content, { schema });
	if (!Array.isArray(rows)) throw new Error("the transformed composition did not parse as an entry list");
	return toImportableSpecifiers(rows);
}
/**
* Rewrite every absolute local module specifier as a `file:` URL.
*
* The generated world names THIS package's built providers (`shell.js`,
* `fs.js`, …) by absolute path. That is what the directory mechanism needed:
* those rows sat in an Include-backed tree, and the boot-time Include
* translates an absolute path into a `file:` URL before importing it. A preset
* mounted from a *declaration* is loaded by the registry's own entry tree,
* which has no such translation — handing it `C:/…/lib/shell.js` leaves those
* rows without a fiber, the audit reports them "never started", and the whole
* variant is refused. Rewriting the specifier is therefore part of adapting to
* the declaration mechanism, not a change to what the variant mounts.
*
* Only `name` is touched: config values (the relay path handed to the PTY
* backend, the interpreter path in `shellPath`) must stay native filesystem
* paths. Group rows carry their children in a `config` array, so those are
* walked too.
* @param rows - the parsed declaration rows.
* @returns the same rows with their module specifiers made importable.
*/
function toImportableSpecifiers(rows) {
	const rewrite = (row) => {
		if (row === null || typeof row !== "object") return row;
		const entry = row;
		if (typeof entry.name === "string" && isAbsolute(entry.name)) entry.name = pathToFileURL(entry.name).href;
		if (Array.isArray(entry.config)) entry.config = entry.config.map(rewrite);
		return row;
	};
	return rows.map(rewrite);
}
/**
* Publish a fully staged preset directory while preserving the last complete
* variant if publication fails. Stable sibling names also let the next boot
* recover an interrupted old-to-backup rename before doing new work.
*/
function publishVariant(staging, dest) {
	const previous = `${dest}.previous`;
	if (!existsSync(dest) && existsSync(previous)) renameSync(previous, dest);
	if (existsSync(previous)) rmSync(previous, {
		recursive: true,
		force: true
	});
	if (existsSync(dest)) renameSync(dest, previous);
	try {
		renameSync(staging, dest);
	} catch (error) {
		if (!existsSync(dest) && existsSync(previous)) renameSync(previous, dest);
		throw error;
	}
	rmSync(previous, {
		recursive: true,
		force: true
	});
}
/**
* The directory the readiness probe should start the relay in.
*
* The backend spawns the persistent shell with the session's workspace path, which
* for a WSL workspace is a UNC path — so a probe that always starts in a Windows
* directory can certify a shell shape no session will ever use. The registered
* workspaces are the closest thing to that path available at profile boot; with none
* stored yet, the Windows fallback is used and the probe says it did not verify the
* UNC case rather than implying it did.
* @returns a canonical UNC workspace path when one is registered, else a Windows directory.
*/
function readinessCwd() {
	for (const key of listWorkspaceKeys()) {
		const canonical = canonicalWslUnc(key);
		if (canonical !== null) return canonical;
	}
	return process.env.SystemRoot ?? process.cwd();
}
/**
* Whether a host's terminal stack can allocate a PTY process *on this platform*.
*
* The world's `bash` is the host's persistent-shell stack, and on Windows that
* stack needs a platform process inspector. `@deepseek-ai/dsh-subprocess-local`
* only grew one in `0.1.0-rc.8`: in `0.1.0-rc.7` `spawnTerminal` throws
* `subprocess-local: terminal inspection is unsupported on platform win32`
* before the process is started, so *every* persistent shell fails there — a
* real session shows the model getting that error for each `bash` call while
* grep/glob (which never touch the PTY) keep working. The host itself ships the
* same gap: that release's Minimal preset mounts `persistent-bash` with no
* `disabled:` guard for Windows.
*
* The probe asks the substrate the question directly instead of pattern-matching
* a version: `spawnTerminal` builds its inspector before `node-pty` starts the
* program, so handing it a program that cannot exist reaches that check and
* nothing else — no process is created either way, and the failure message says
* which half failed. A release that can build the inspector reports an ordinary
* spawn failure instead, which is the "supported" answer.
* @param ctx - plugin context; the `subprocess` service is looked up with `get`
*   and waited for briefly, because the world is generated during profile boot.
* @returns whether the persistent shell may be mounted, and the service face the
*   readiness stage probes with (undefined when there was nothing to probe).
*/
async function supportsPersistentShell(ctx) {
	if (process.platform !== "win32") return {
		ok: true,
		subprocess: void 0
	};
	const subprocess = await waitForSubprocess(ctx);
	if (subprocess?.spawnTerminal === void 0) return {
		ok: true,
		subprocess
	};
	try {
		await (await subprocess.spawnTerminal({
			argv: ["dsh-wsl-workspace-pty-probe-does-not-exist"],
			cwd: process.cwd(),
			rows: 24,
			cols: 80,
			graceMs: 1e3
		}))?.terminate?.();
		return {
			ok: true,
			subprocess
		};
	} catch (error) {
		return {
			ok: !isTerminalInspectionUnsupported(error),
			subprocess
		};
	}
}
/**
* Whether one spawn failure is the missing-platform-inspector error.
* @param error - the rejection from `spawnTerminal`.
* @returns true when the host cannot inspect terminal processes here.
*/
function isTerminalInspectionUnsupported(error) {
	return /terminal inspection is unsupported on platform/i.test(messageOf(error));
}
/**
* Look up the `subprocess` service, giving profile boot a moment to publish it.
*
* Bounded: the world is generated in a fire-and-forget effect, so this wait never
* blocks profile boot, and the service is normally already published by the base
* bundles the web app mounts before this plugin's own injection resolves. An
* absent service is answered as "supported" by the caller, which is the
* behaviour this plugin shipped before the probe existed.
* @param ctx - plugin context.
* @returns the service, or undefined when this deployment has none yet.
*/
async function waitForSubprocess(ctx) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const service = ctx.get("subprocess");
		if (service !== void 0) return service;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
/** Materialize one WSL variant per healthy source preset. */
async function materializeVariants(agentPresets, dshHome, paths, persistentShell, track) {
	const presets = await agentPresets.list();
	const userRoot = join(dshHome, ".agent-presets");
	const generated = /* @__PURE__ */ new Set();
	const sources = presets.filter((preset) => preset.broken === void 0 && !isWslVariantId(preset.id));
	let produced = 0;
	const retained = /* @__PURE__ */ new Set();
	for (const preset of sources) {
		const variantId = variantIdFor(preset.id);
		try {
			await materializeOne(agentPresets, preset, userRoot, paths, persistentShell, track, generated);
			produced += 1;
		} catch (error) {
			retained.add(variantId);
			console.error(`dsh-wsl-workspace: WSL variant ${variantId} was not published — ${messageOf(error)}`);
		}
	}
	console.log(retained.size === 0 ? `dsh-wsl-workspace: WSL preset variants: ${produced}/${sources.length} registered` : `dsh-wsl-workspace: WSL preset variants: ${produced}/${sources.length} registered, ${retained.size} not`);
	if (existsSync(userRoot)) for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!/^wsl(-[a-z0-9-]+)?$/.test(entry.name)) continue;
		if (generated.has(entry.name) || retained.has(entry.name)) continue;
		rmSync(join(userRoot, entry.name), {
			recursive: true,
			force: true
		});
	}
}
/**
* Turn one healthy roster entry into its WSL variant, on whichever channel this
* release publishes.
* @param agentPresets - the roster face.
* @param preset - the source entry to copy and amend.
* @param userRoot - `<dshHome>/.agent-presets`, the retired directory root the
*                   directory channel still publishes into.
* @param paths - this installation's built provider files.
* @param persistentShell - whether the world may mount the host PTY stack.
* @param track - hand a registration's disposer to the effect that owns it.
* @param generated - collects the directories this boot wrote, so the sweep can
*                   tell them from leftovers.
*/
async function materializeOne(agentPresets, preset, userRoot, paths, persistentShell, track, generated) {
	const variantId = variantIdFor(preset.id);
	const composition = await readPresetComposition(agentPresets, preset);
	const transformed = transformPresetForWsl(composition.content, paths.shell, paths.fs, persistentShell ? {
		relayPath: paths.relay,
		nodePath: paths.node,
		sandboxPath: paths.sandbox,
		bashPath: paths.bashTool,
		mode: paths.shellMode
	} : void 0, paths.search, paths.jobs);
	if (typeof agentPresets.register === "function") {
		const plugins = await parseVariantComposition(transformed);
		const declaration = {
			id: variantId,
			name: variantName(preset.id, composition.name ?? preset.name ?? preset.id),
			description: variantDescription(preset.id),
			...preset.order === void 0 ? {} : { order: preset.order },
			plugins
		};
		track(await agentPresets.register(declaration));
		return;
	}
	if (preset.path === void 0) throw new Error(`agentPresets: roster entry "${preset.id}" carries no path on this release`);
	const dir = join(userRoot, variantId);
	const staging = `${dir}.staging`;
	rmSync(staging, {
		recursive: true,
		force: true
	});
	cpSync(dirname(preset.path), staging, {
		recursive: true,
		force: true
	});
	writeFileSync(join(staging, "agent.cordis.yml"), transformed, "utf8");
	const labels = MODE_DISPLAY_LABELS[preset.id];
	let name = variantName(preset.id, preset.id);
	let orderLine = "";
	try {
		const meta = readFileSync(join(dirname(preset.path), "preset.yml"), "utf8");
		if (labels === void 0) {
			const match = /^name:\s*(.+)$/m.exec(meta);
			if (match?.[1] !== void 0 && match[1].trim() !== "") name = variantName(preset.id, unquoteScalar(match[1].trim()));
		}
		const orderMatch = /^order:\s*(\d+)\s*$/m.exec(meta);
		if (orderMatch?.[1] !== void 0) orderLine = `order: ${orderMatch[1]}\n`;
	} catch {}
	writeFileSync(join(staging, "preset.yml"), `name: ${yamlScalar(name)}\n` + orderLine + `description: ${yamlScalar(variantDescription(preset.id))}\n`, "utf8");
	publishVariant(staging, dir);
	generated.add(variantId);
}
/** Function-plugin plugin contract. */
const name = "dsh-wsl-workspace";
/** Required services. */
const inject = ["webServer"];
/** Validated plugin config (schemastery applied the defaults). */
const Config = z.object({ route: z.string().default(DEFAULT_ROUTE) });
/**
* Apply the host half: materialize a `wsl-<mode>` variant for every healthy
* roster preset, register the data route, and
* contribute the per-session `DSH_WSL_DISTRO` managed-env fact so the WSL
* shell executor can resolve a plain Linux `workdir` to the calling
* session's distribution.
* @param ctx - the host plugin context.
* @param config - the validated configuration.
*/
function apply(ctx, config) {
	const resolved = config;
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const shellPath = join(packageRoot, "lib", "shell.js").replace(/\\/g, "/");
	const fsPath = join(packageRoot, "lib", "fs.js").replace(/\\/g, "/");
	const relayPath = join(packageRoot, "lib", "wsl-relay.js").replace(/\\/g, "/");
	const bashToolPath = join(packageRoot, "lib", "wsl-bash-tool.js").replace(/\\/g, "/");
	const sandboxPath = join(packageRoot, "lib", "wsl-sandbox.js").replace(/\\/g, "/");
	const searchPath = join(packageRoot, "lib", "wsl-search.js").replace(/\\/g, "/");
	const jobsPath = join(packageRoot, "lib", "wsl-jobs.js").replace(/\\/g, "/");
	const agentPresets = ctx.get("agentPresets");
	if (agentPresets !== void 0) ctx.effect(() => {
		let stopped = false;
		const disposers = [];
		const track = (dispose) => {
			if (typeof dispose !== "function") return;
			const retire = dispose;
			if (stopped) {
				Promise.resolve(retire()).catch(() => {});
				return;
			}
			disposers.push(retire);
		};
		(async () => {
			const probe = await supportsPersistentShell(ctx);
			const relay = probe.ok ? await resolveRelayNode() : void 0;
			let persistentShell = persistentShellAllowed(probe.ok, relay);
			const shellMode = process.env.DSH_WSL_PTY_SHELL === "1" ? "pty" : "session";
			if (relay !== void 0 && isElectronHost()) {
				const detail = relay.rejected.length === 0 ? "" : ` (rejected: ${relay.rejected.join("; ")})`;
				if (relay.fallback) console.warn(`dsh-wsl-workspace: persistent shell: not mounted, ${relay.source}${detail}`);
				else console.log(`dsh-wsl-workspace: persistent shell: relay interpreter is ${relay.path} — ${relay.source}${detail}`);
			}
			if (persistentShell && process.platform === "win32" && shellMode === "session") {
				const spec = buildSessionSpec(PROBE_CONFIG, readinessCwd());
				if (spec === void 0) {
					persistentShell = false;
					console.warn("dsh-wsl-workspace: persistent shell: not mounted, no WSL distribution resolved for the session probe");
				} else if (probe.subprocess === void 0) console.warn("dsh-wsl-workspace: persistent shell: session probe skipped, no subprocess service to probe with; mounted unverified");
				else {
					const readiness = await probeWslBashSession({ subprocess: probe.subprocess }, spec);
					if (!readiness.ready) {
						persistentShell = false;
						console.warn(`dsh-wsl-workspace: persistent shell: not mounted, session probe failed — ${readiness.detail}`);
					} else console.log(`dsh-wsl-workspace: persistent shell: session probe passed — ${readiness.detail}`);
				}
			} else if (persistentShell && process.platform === "win32") {
				const readiness = await probePersistentShellReadiness(probe.subprocess, {
					relayPath,
					nodePath: relay?.path ?? process.execPath
				}, readinessCwd());
				if (!readiness.ready) {
					persistentShell = false;
					console.warn(`dsh-wsl-workspace: persistent shell: not mounted, readiness probe failed — ${readiness.detail}`);
				} else if (readiness.unverifiable === true) console.warn(`dsh-wsl-workspace: persistent shell: mounted unverified — ${readiness.detail}`);
				else console.log(`dsh-wsl-workspace: persistent shell: readiness probe passed — ${readiness.detail}`);
			}
			await materializeVariants(agentPresets, dshHome, {
				shell: shellPath,
				fs: fsPath,
				relay: relayPath,
				node: (relay?.path ?? process.execPath).replace(/\\/g, "/"),
				sandbox: sandboxPath,
				search: searchPath,
				jobs: jobsPath,
				bashTool: bashToolPath,
				shellMode
			}, persistentShell, track);
		})().catch((error) => {
			console.error(`dsh-wsl-workspace: WSL preset-variant generation failed: ${messageOf(error)}`);
		});
		return () => {
			stopped = true;
			for (const retire of disposers.splice(0, disposers.length)) Promise.resolve(retire()).catch(() => {});
		};
	}, "dsh-wsl-workspace: WSL preset variants");
	const skills = ctx.get("skills");
	if (skills !== void 0 && typeof skills.registerProvider === "function") ctx.effect(() => skills.registerProvider((control) => new WslSkillsProvider(control)), "dsh-wsl-workspace: WSL workspace skills provider");
	const shellEnv = ctx.get("shellEnv");
	if (shellEnv !== void 0) ctx.effect(() => shellEnv.register({
		name: "wsl-workspace-distro",
		variables: {
			DSH_WSL_DISTRO: { description: "The WSL distribution of the calling session workspace, when the session cwd is a WSL UNC path." },
			DSH_WSL_USER: { description: "The Linux user of the calling session workspace, when the workspace has one configured." }
		},
		resolve(execution) {
			const cwd = execution.agent?.session.header.cwd;
			const unc = cwd === void 0 ? null : parseWslUnc(cwd);
			if (unc !== null) {
				const username = getWorkspaceUsername(joinUnc(unc.distro, unc.linuxPath));
				return username === void 0 || username === "" ? { DSH_WSL_DISTRO: unc.distro } : {
					DSH_WSL_DISTRO: unc.distro,
					DSH_WSL_USER: username
				};
			}
			if (cwd !== void 0 && /^[A-Za-z]:[\\/]/.test(cwd)) {
				const entry = getWindowsWorkspace(cwd);
				if (entry !== void 0 && entry.distro !== void 0 && entry.distro !== "") return entry.username === void 0 || entry.username === "" ? { DSH_WSL_DISTRO: entry.distro } : {
					DSH_WSL_DISTRO: entry.distro,
					DSH_WSL_USER: entry.username
				};
			}
			return {};
		}
	}), "dsh-wsl-workspace: per-session distro env fact");
	const webServer = ctx.get("webServer");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: resolved.route,
		handler: async (req, res) => {
			if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
				json(res, 403, {
					ok: false,
					error: "loopback-only"
				});
				return;
			}
			if (req.method !== "POST") {
				json(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				json(res, 400, {
					ok: false,
					error: messageOf(error)
				});
				return;
			}
			const method = typeof body.method === "string" ? body.method : "";
			const params = body.params === void 0 ? {} : body.params;
			if (params === null || typeof params !== "object" || Array.isArray(params)) {
				json(res, 400, {
					ok: false,
					error: "params must be an object"
				});
				return;
			}
			try {
				json(res, 200, {
					ok: true,
					value: await dispatch(method, params)
				});
			} catch (error) {
				json(res, 200, {
					ok: false,
					error: messageOf(error)
				});
			}
		}
	}), "dsh-wsl-workspace: dialog data route");
}
//#endregion
export { Config, DEFAULT_ROUTE, apply, inject, isTerminalInspectionUnsupported, name };

//# sourceMappingURL=index.js.map