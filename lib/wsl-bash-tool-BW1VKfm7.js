import { g as windowsToMntPath, l as isValidWslUsername, m as parseWslUnc, n as defaultDistroSync } from "./wsl-Ckyi3g6C.js";
import { n as bridgeEnv } from "./wsl-env-DqeMFPn-.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
//#region src/host/wsl-bash-protocol.ts
/**
* The record protocol between this plugin and a long-lived WSL `bash`.
*
* The host's persistent bash tool decides "the command finished" by scraping the terminal for a
* sentinel line and requiring the exit-code digits to be followed immediately by a newline. That is
* a byte-exact comparison against a surface the terminal is allowed to repaint, and on WSL the
* interactive shell's readline paints `ESC[<n>X` (fill cells with spaces) — so the recorded line
* arrives as `:0␠␠` and the check never fires (issue #51 point 3, measured 2026-10-04: three calls
* hung 303.8 s, one settled in 4.2 s, and the host's own matcher reproduced 4/4 offline).
*
* This module replaces that arrangement with an event: every command ends with a record written to
* stdout as NUL-delimited bytes carrying a per-command nonce, and the reader only completes on a
* record whose nonce matches. No terminal, no prompt, no repaint is part of the contract.
*
* Why the payload travels base64-encoded: a single line is required because a piped `bash` executes
* each line as it arrives, and the base64 alphabet contains neither `!` (which interactive history
* expansion rewrites — the bug behind the host's own #7858/#6768) nor quotes, backslashes or
* newlines that would need escaping to survive one more layer of quoting.
*
* @module dsh-wsl-workspace/host/wsl-bash-protocol
*/
/** The literal that opens every completion record. Never appears in a command's own output. */
const RECORD_TAG = "__DSH_WSL_BASH_REC";
/** The literal that opens the state record which follows a completion record. */
const STATE_TAG = "__DSH_WSL_BASH_STATE";
/** A per-command identifier. The reader completes only on a record carrying this exact value. */
function newNonce() {
	return randomUUID();
}
/** Base64 with no line wrapping, so the frame stays one line however long the command is. */
function encodePayload(command) {
	return Buffer.from(command, "utf8").toString("base64");
}
/**
* Build the stdin line that runs `command` and reports its exit code.
* @param command - the user's command, verbatim, any number of lines.
* @returns the frame to write, and the nonce its completion record must carry.
*/
function encodeFrame(command) {
	const nonce = newNonce();
	const payload = encodePayload(command);
	return {
		nonce,
		line: `eval "$(printf %s '${payload}' | base64 -d)" </dev/null; __dsh_status=$?; printf '\\0${RECORD_TAG}\\0%s\\0%s\\0' '${nonce}' "$__dsh_status"; printf '\\0${STATE_TAG}\\0%s\\0%s\\0' '${nonce}' "$( { export -p; printf 'PWD=%s\\n' "$PWD"; } | base64 -w0 )"\n`,
		payload
	};
}
/**
* Drop the shell's own echo of a frame from the stderr destined for the model.
*
* An interactive `bash` whose stdin is a pipe writes its prompt and the line it just read to
* stderr (measured on this machine: `bash-5.1$ eval "$(printf %s 'ZWNoby…' | base64 -d)" …`). That
* is protocol, not the command's output, and showing it would tell the model its own framing was
* part of the result. Matched on the payload rather than on a prompt pattern, because the prompt is
* whatever the user's rc file says it is.
*
* @param text - stderr accumulated for the command in flight.
* @param payload - {@link CommandFrame.payload} of the frame that produced it.
* @returns the same text with the echoed frame removed.
*/
function dropProtocolEcho(text, payload) {
	if (payload.length === 0 || !text.includes(payload)) return text;
	return text.split("\n").filter((line) => !line.includes(payload)).join("\n");
}
/** Read one `<tag>\0<nonce>\0<field>\0` record, or undefined if it is absent or incomplete. */
function readRecord(buffer, tag, nonce, from) {
	const head = Buffer.from(`\u0000${tag}\u0000${nonce}\u0000`, "latin1");
	const at = buffer.indexOf(head, from);
	if (at < 0) return void 0;
	const end = buffer.indexOf(0, at + head.length);
	if (end < 0) return void 0;
	return {
		value: buffer.subarray(at + head.length, end).toString("utf8"),
		start: at,
		next: end + 1
	};
}
/**
* Read the completion and state records a frame writes, in that order.
* @param buffer - everything the session has written to stdout since it started.
* @param nonce - the nonce of the frame currently in flight.
* @param fromOffset - where the previous command's window ended.
* @returns the exit code, the shell's state, and where to resume; undefined while still running.
*/
function readFrame(buffer, nonce, fromOffset = 0) {
	const completion = readRecord(buffer, RECORD_TAG, nonce, fromOffset);
	if (completion === void 0) return void 0;
	if (!/^\d+$/.test(completion.value)) return void 0;
	const state = readRecord(buffer, STATE_TAG, nonce, completion.next);
	if (state === void 0) return void 0;
	let decoded = "";
	try {
		decoded = Buffer.from(state.value, "base64").toString("utf8");
	} catch {
		return;
	}
	return {
		status: Number(completion.value),
		state: decoded,
		recordStart: completion.start,
		nextOffset: state.next
	};
}
/**
* Remove our records from bytes destined for the model, leaving the command's own output intact.
* @param buffer - raw stdout for one command's window.
* @returns the same stream with every completion and state record spliced out.
*/
function stripRecords(buffer) {
	return [RECORD_TAG, STATE_TAG].reduce(stripOneTag, buffer);
}
/** Splice out every `<\0tag\0…\0…\0>` record; each carries a nonce field and a value field. */
function stripOneTag(buffer, tag) {
	const head = Buffer.from(`\u0000${tag}\u0000`, "latin1");
	const parts = [];
	let cursor = 0;
	for (;;) {
		const at = buffer.indexOf(head, cursor);
		if (at < 0) {
			parts.push(buffer.subarray(cursor));
			break;
		}
		parts.push(buffer.subarray(cursor, at));
		let end = at + head.length;
		for (let field = 0; field < 2; field += 1) {
			const next = buffer.indexOf(0, end);
			if (next < 0) {
				end = buffer.length;
				break;
			}
			end = next + 1;
		}
		cursor = end;
	}
	return Buffer.concat(parts);
}
/**
* The bootstrap sent once, before any command, as its own frame.
*
* `set +H` turns history expansion off for the session, so a `!` in a command means what the model
* wrote. The rc files are sourced with their own output and complaints discarded: this machine's
* `~/.bashrc` emits `not a valid identifier` on every shell and holds a token-shaped line, and
* neither belongs anywhere a model or a transcript can see. What survives is the environment those
* files set — PATH additions, locale, proxies — which is the part a piped non-interactive shell
* would otherwise be missing.
*/
const BOOTSTRAP_COMMAND = [
	"set +H",
	"shopt -s expand_aliases 2>/dev/null || true",
	"for f in /etc/profile ~/.profile /etc/bash.bashrc ~/.bashrc; do [ -r \"$f\" ] && . \"$f\" >/dev/null 2>&1; done",
	"PS1=",
	"cd \"$PWD\""
].join("; ");
/**
* How the session must be spawned.
*
* `wsl.exe -e` claims any argument beginning with `--` for itself, so `bash -i --norc` dies with
* `bash: --: invalid option` before a shell exists (measured). Ordering the long option first is
* what makes the argv survive the hand-off.
*/
const SESSION_ARGV = ["--norc", "-i"];
//#endregion
//#region src/host/wsl-bash-session.ts
/** How often the reader looks for a frame's records, in milliseconds. */
const POLL_MS = 20;
/**
* One agent's persistent WSL shell.
*
* Commands are serialised: the protocol has one frame in flight, and a second writer would make
* the first frame's records ambiguous.
*/
var WslBashSession = class {
	ctx;
	spec;
	handle;
	exited = false;
	out = Buffer.alloc(0);
	outTruncated = false;
	err = Buffer.alloc(0);
	journal = "";
	queue = Promise.resolve();
	disposed = false;
	constructor(ctx, spec) {
		this.ctx = ctx;
		this.spec = spec;
	}
	/** Start the child and run the bootstrap. Safe to call once, before any command. */
	async start() {
		await this.spawn();
		if (!(await this.execute(BOOTSTRAP_COMMAND, this.spec.bootTimeoutMs, void 0)).settled) {
			await this.kill();
			throw new Error("wsl-bash: the persistent shell did not finish its bootstrap within its deadline");
		}
	}
	/**
	* Run one command, recovering transparently if it wedges the shell.
	* @param command - the model's command, verbatim.
	* @param timeoutMs - this call's deadline.
	* @param signal - the caller's abort signal, if any.
	* @returns the outcome, with `restarted` set when the session had to be rebuilt.
	*/
	async run(command, timeoutMs, signal) {
		const previous = this.queue;
		let release = () => {};
		this.queue = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (this.disposed) throw new Error("wsl-bash: the session is closed");
			const first = await this.execute(command, timeoutMs, signal);
			if (first.settled || signal?.aborted === true) return first.run;
			await this.rebuild();
			return {
				...(await this.execute(command, timeoutMs, signal)).run,
				restarted: true
			};
		} finally {
			release();
		}
	}
	/** Take the shell down and stop recovering. */
	async dispose() {
		this.disposed = true;
		await this.kill();
	}
	/** Spawn the child and attach the readers that feed the protocol. */
	async spawn() {
		this.out = Buffer.alloc(0);
		this.err = Buffer.alloc(0);
		this.outTruncated = false;
		this.exited = false;
		const handle = this.ctx.subprocess.spawn({
			argv: [...this.spec.argv],
			cwd: this.spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe"
			},
			graceMs: this.spec.graceMs,
			env: this.spec.env
		});
		this.handle = handle;
		handle.stdout?.on("data", (chunk) => {
			this.out = Buffer.concat([this.out, chunk]);
			const cap = this.spec.maxOutputBytes * 2;
			if (this.out.length > cap) {
				this.out = this.out.subarray(this.out.length - cap);
				this.outTruncated = true;
			}
		});
		handle.stderr?.on("data", (chunk) => {
			this.err = Buffer.concat([this.err, chunk]);
			if (this.err.length > this.spec.maxOutputBytes * 2) this.err = this.err.subarray(this.err.length - this.spec.maxOutputBytes);
		});
		handle.done.then(() => {
			this.exited = true;
		}, () => {
			this.exited = true;
		});
	}
	/**
	* Write one frame and wait for its records.
	* @returns the run, plus whether the shell answered at all.
	*/
	async execute(command, timeoutMs, signal) {
		const handle = this.handle;
		const stdin = handle?.stdin;
		if (handle === void 0 || stdin === void 0) throw new Error("wsl-bash: the session has no stdin to write to");
		const frame = encodeFrame(command);
		const errStart = this.err.length;
		const armed = deadline(signal, timeoutMs, "WSL_BASH_TIMEOUT");
		stdin.write(frame.line);
		for (;;) {
			const found = readFrame(this.out, frame.nonce);
			if (found !== void 0) {
				const stdout = stripRecords(this.out.subarray(0, found.recordStart)).toString("utf8");
				const stderr = dropProtocolEcho(this.err.subarray(errStart).toString("utf8"), frame.payload);
				const truncated = this.outTruncated;
				this.out = this.out.subarray(found.nextOffset);
				this.outTruncated = false;
				this.journal = found.state;
				armed[Symbol.dispose]();
				return {
					settled: true,
					run: {
						stdout,
						stderr,
						exitCode: found.status,
						timedOut: false,
						aborted: false,
						restarted: false,
						truncated
					}
				};
			}
			if (armed.signal.aborted || this.exited) {
				armed[Symbol.dispose]();
				const timedOut = timeoutOf(armed.signal, "WSL_BASH_TIMEOUT") !== void 0;
				return {
					settled: false,
					run: {
						stdout: stripRecords(this.out).toString("utf8"),
						stderr: dropProtocolEcho(this.err.subarray(errStart).toString("utf8"), frame.payload),
						exitCode: timedOut ? -1 : 1,
						timedOut,
						aborted: !timedOut,
						restarted: false,
						truncated: this.outTruncated
					}
				};
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	}
	/** Kill the wedged child and bring back one that knows where we left off. */
	async rebuild() {
		const journal = this.journal;
		await this.kill();
		await this.spawn();
		const lines = journal.split("\n").filter((line) => line.startsWith("declare -x ") || line.startsWith("PWD="));
		const pwd = lines.find((line) => line.startsWith("PWD="))?.slice(4);
		const restore = [
			...lines.filter((line) => !line.startsWith("PWD=")),
			...pwd === void 0 || pwd === "" ? [] : [`cd ${JSON.stringify(pwd)} 2>/dev/null || true`],
			BOOTSTRAP_COMMAND
		];
		await this.execute(restore.join("\n"), this.spec.bootTimeoutMs, void 0);
	}
	/** Terminate the current child, if any, and wait for the seam to report it gone. */
	async kill() {
		const handle = this.handle;
		this.handle = void 0;
		if (handle === void 0) return;
		handle.terminate();
		await handle.done.catch(() => void 0);
	}
};
/**
* Start a session, run one computed command through it, and take it down again.
*
* This is the question the mount decision actually needs answered: not "can a child be spawned"
* but "does a command come back". The host's own PTY probe could pass a world in which every call
* hung, which is exactly how issue #51 reached a user, so the probe here drives the same protocol
* the tool will use and requires the computed answer rather than any recognizable text.
*
* @param host - the subprocess seam.
* @param spec - the session spec the world would mount.
* @param budgetMs - the ceiling for boot plus one command.
* @returns whether the session is usable, with the reading that decided it.
*/
async function probeWslBashSession(host, spec, budgetMs = 2e4) {
	const seed = Math.floor(Math.random() * 900) + 100;
	const expected = `dshwslbash${seed * 2}`;
	const session = new WslBashSession(host, spec);
	const started = Date.now();
	try {
		await session.start();
		const run = await session.run(`echo dshwslbash$(( ${seed} * 2 ))`, Math.max(1e3, budgetMs - (Date.now() - started)));
		if (run.stdout.includes(expected)) return {
			ready: true,
			detail: `session came up and round-tripped a computed command in ${Date.now() - started}ms`
		};
		return {
			ready: false,
			detail: `the session answered but not with the computed value (stdout ${JSON.stringify(run.stdout.slice(0, 80))})`
		};
	} catch (error) {
		return {
			ready: false,
			detail: `the session did not come up: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`
		};
	} finally {
		await session.dispose().catch(() => void 0);
	}
}
//#endregion
//#region src/host/wsl-bash-tool.ts
/** The tool name — the same one the host's tools register, so only one may be mounted. */
const TOOL_NAME = "bash";
/**
* The defaults as data as well as schema fields: a world row mounted without a `config:` block gets
* an undefined config, and schemastery's defaults are not applied on that path.
*/
const DEFAULTS = {
	timeoutMs: 12e4,
	maxTimeoutMs: 6e5,
	maxOutputBytes: 262144,
	graceMs: 3e3,
	bootTimeoutMs: 2e4
};
const Config = z.object({
	timeoutMs: z.number().default(DEFAULTS.timeoutMs),
	maxTimeoutMs: z.number().default(DEFAULTS.maxTimeoutMs),
	maxOutputBytes: z.number().default(DEFAULTS.maxOutputBytes),
	graceMs: z.number().default(DEFAULTS.graceMs),
	bootTimeoutMs: z.number().default(DEFAULTS.bootTimeoutMs),
	distro: z.string().default(""),
	username: z.string().default("")
});
/** The defaults as a resolved config, for callers that build a spec before a plugin row exists. */
const PROBE_CONFIG = { ...DEFAULTS };
const inject = ["subprocess"];
/** Environment facts that must reach the distribution. */
const BRIDGED_KEYS = [
	"DSH_HOME",
	"DSH_SESSION_ID",
	"DSH_WSL_DISTRO",
	"DSH_WSL_USER",
	"NO_COLOR",
	"TERM",
	"PAGER",
	"GIT_PAGER"
];
/** Model-friendly overrides, matching the one-shot executor's set. */
const ENV_OVERRIDES = {
	NO_COLOR: "1",
	TERM: "dumb",
	PAGER: "cat",
	GIT_PAGER: "cat"
};
/**
* The Linux directory a call runs in.
* @param args - the model's arguments.
* @param exec - the tool execution, whose agent session carries the workspace path.
* @returns the path for `wsl.exe --cd`, or undefined to let the distribution choose.
*/
function resolveCwd(args, exec) {
	const requested = args.workdir ?? exec.agent?.session?.header?.cwd;
	if (requested === void 0 || requested === "") return void 0;
	const unc = parseWslUnc(requested);
	if (unc !== null) return unc.linuxPath;
	if (requested.startsWith("/")) return requested;
	return windowsToMntPath(requested) ?? void 0;
}
/**
* The distribution a call runs in: config, then the session path, then `DSH_WSL_USER`-style facts,
* then the host default — the same order the one-shot executor uses.
*/
function resolveDistro(config, headerCwd) {
	if (config.distro !== void 0 && config.distro !== "") return config.distro;
	const unc = headerCwd === void 0 ? null : parseWslUnc(headerCwd);
	if (unc !== null) return unc.distro;
	const fromEnv = process.env.DSH_WSL_DISTRO;
	if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
	return defaultDistroSync() ?? "";
}
/**
* The Linux user a call runs as, or undefined for the distribution default.
*/
function resolveUser(config) {
	const candidates = [config.username, process.env.DSH_WSL_USER];
	for (const candidate of candidates) if (candidate !== void 0 && candidate !== "" && isValidWslUsername(candidate)) return candidate;
}
/** Render one finished run the way the host's tool does, so the trace text is the same shape. */
function renderRun(value) {
	let body = value.stdout.text;
	if (value.stderr.text.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${value.stderr.text}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers = [];
	if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
	if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`);
	else if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`);
	if (markers.length === 0) return [{
		type: "text",
		text: body
	}];
	if (!body.endsWith("\n")) body += "\n";
	return [{
		type: "text",
		text: body + markers.join("\n")
	}];
}
/** Shape a session run into the host's result contract. */
function toForeground(run, timeoutMs) {
	return {
		kind: "foreground",
		exitCode: run.exitCode < 0 ? null : run.exitCode,
		signal: null,
		timedOut: run.timedOut,
		aborted: run.aborted,
		timeoutMs,
		stdout: {
			text: run.stdout,
			truncated: run.truncated
		},
		stderr: {
			text: run.stderr,
			truncated: false
		}
	};
}
const STREAM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: true,
	properties: {
		text: {
			type: "string",
			required: true
		},
		truncated: {
			type: "boolean",
			required: true
		}
	}
};
/**
* The session spec for one workspace path: which distribution and user, and the child's argv.
*
* Exported because the boot-time mount decision has to build exactly the session the tool will
* later build — probing a different argv than the one that ships is how a readiness check can pass
* a world that then fails every call.
*
* @param config - the resolved plugin configuration.
* @param headerCwd - the session's workspace path, UNC or Linux.
* @returns the spec, or undefined when no distribution could be resolved.
*/
function buildSessionSpec(config, headerCwd) {
	const distro = resolveDistro(config, headerCwd);
	if (distro === "") return void 0;
	const user = resolveUser(config);
	const linuxCwd = headerCwd === void 0 ? void 0 : parseWslUnc(headerCwd)?.linuxPath ?? (headerCwd.startsWith("/") ? headerCwd : windowsToMntPath(headerCwd) ?? void 0);
	return {
		argv: [
			"wsl.exe",
			"-d",
			distro,
			...user === void 0 ? [] : ["-u", user],
			...linuxCwd === void 0 ? [] : ["--cd", linuxCwd],
			"-e",
			"bash",
			...SESSION_ARGV
		],
		cwd: process.env.SystemRoot ?? "C:\\Windows",
		env: bridgeEnv({
			...ENV_OVERRIDES,
			DSH_WSL_DISTRO: distro,
			...user === void 0 ? {} : { DSH_WSL_USER: user }
		}, BRIDGED_KEYS),
		graceMs: config.graceMs,
		bootTimeoutMs: config.bootTimeoutMs,
		maxOutputBytes: config.maxOutputBytes
	};
}
/**
* Mount the tool.
* @param ctx - the host context, providing `subprocess` and the tools registry.
* @param config - plugin configuration; a row without a `config:` block mounts with none.
*/
function apply(ctx, config) {
	const resolved = {
		...DEFAULTS,
		...config === void 0 ? {} : config
	};
	const tools = ctx.get("tools");
	if (tools?.register === void 0) return;
	const sessions = /* @__PURE__ */ new Map();
	const cleanup = () => {
		for (const session of sessions.values()) session.dispose();
		sessions.clear();
	};
	ctx.effect?.(() => cleanup);
	const tool = defineTool({
		name: TOOL_NAME,
		description: "Run a bash command inside this WSL distribution. The shell is persistent: `cd`, exported variables, activated virtualenvs and shell functions survive between calls, so use absolute paths or an explicit `cd` when a call must not depend on where the last one left off. A command that reads from stdin is given /dev/null; run interactive programs with the terminal tool instead. Long-running work belongs in the background-job tool.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The bash command to run."
			},
			description: {
				type: "string",
				required: true,
				description: "A short, user-facing description of what this command does."
			},
			workdir: {
				type: "string",
				description: "Linux working directory for this call. Defaults to the session workspace; a relative path resolves against it."
			},
			timeoutMs: {
				type: "number",
				description: "Per-call deadline in milliseconds."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "foreground"
					},
					exitCode: {
						required: true,
						oneOf: [{ type: "integer" }, { type: "null" }]
					},
					signal: {
						required: true,
						oneOf: [{ type: "string" }, { type: "null" }]
					},
					timedOut: {
						type: "boolean",
						required: true
					},
					aborted: {
						type: "boolean",
						required: true
					},
					timeoutMs: {
						type: "number",
						required: true
					},
					stdout: STREAM_SCHEMA,
					stderr: STREAM_SCHEMA
				}
			},
			render: (_args, value) => renderRun(value)
		},
		presentCall: (args) => ({
			card: "terminal",
			title: args.command
		}),
		async execute(args, exec) {
			const headerCwd = exec.agent?.session?.header?.cwd;
			const timeoutMs = Math.min(args.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs);
			const ownerKey = exec.agent?.id ?? exec.agent?.session?.id ?? "default";
			const workdir = args.workdir === void 0 ? void 0 : resolveCwd(args, exec);
			const command = workdir === void 0 ? args.command : `cd ${JSON.stringify(workdir)} && { ${args.command}\n}`;
			let session = sessions.get(ownerKey);
			if (session === void 0) {
				const spec = buildSessionSpec(resolved, headerCwd);
				if (spec === void 0) throw new Error("wsl-bash: no WSL distribution could be resolved for this session");
				session = new WslBashSession(ctx, spec);
				sessions.set(ownerKey, session);
				await session.start().catch((error) => {
					sessions.delete(ownerKey);
					throw error instanceof Error ? error : new Error(String(error));
				});
			}
			return toForeground(await session.run(command, timeoutMs, exec.signal), timeoutMs);
		}
	});
	const dispose = tools.register(tool);
	if (typeof dispose === "function") ctx.effect?.(() => () => {
		dispose();
		cleanup();
	});
}
//#endregion
export { buildSessionSpec as a, apply as i, PROBE_CONFIG as n, inject as o, TOOL_NAME as r, probeWslBashSession as s, Config as t };

//# sourceMappingURL=wsl-bash-tool-BW1VKfm7.js.map