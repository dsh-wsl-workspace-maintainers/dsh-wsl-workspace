import { g as windowsToMntPath, l as isValidWslUsername, m as parseWslUnc, n as defaultDistroSync } from "./wsl-Ckyi3g6C.js";
import { n as bridgeEnv } from "./wsl-env-DqeMFPn-.js";
import { startBackgroundJob } from "./wsl-jobs.js";
import z from "@deepseek-ai/schemastery";
import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
/** The shell-state report every frame ends with: cwd, exported environment, options, aliases. */
const STATE_REPORT_BODY = [
	`printf '%s\\n' '#dsh-section exports'; export -p`,
	`printf '%s\\n' '#dsh-section pwd'; printf 'PWD=%s\\n' "$PWD"`,
	`printf '%s\\n' '#dsh-section aliases'; alias -p`,
	`printf '%s\\n' '#dsh-section options'; set +o`,
	`printf '%s\\n' '#dsh-section shopt'; shopt -p`,
	`printf '%s\\n' '#dsh-section functions-count'; declare -F | wc -l`
].join("; ");
/**
* The conditional that carries function bodies, given the count the session last saw.
*
* Measured on this machine, `declare -f` after the rc files is **61,083 bytes across 85 functions**.
* Base64 on every frame would put ~81 kB through the pipe per command to repeat a snapshot that
* almost never changes, so the shell itself compares its own function count with the one the session
* last recorded and only emits the bodies when they differ (or when the session asks, because the
* command text looked like a definition). A body larger than the cap is skipped with a marker rather
* than truncated: half a function replayed is a syntax error in the restored shell.
*/
const FUNCTION_SNAPSHOT_CAP_BYTES = 65536;
/**
* Build the state-report tail that follows a completion record.
* @param functionCount - the function count the session last saw, or `undefined` to force a snapshot.
* @returns shell text that prints the sections, and the bodies only when they changed.
*/
function stateReport(functionCount) {
	const conditional = functionCount === void 0 ? "" : `; __dsh_n=$(declare -F | wc -l); if [ "$__dsh_n" != '${functionCount}' ]; then __dsh_s=$(declare -f | wc -c); printf '%s\\n' '#dsh-section functions'; if [ "$__dsh_s" -le ${FUNCTION_SNAPSHOT_CAP_BYTES} ]; then declare -f; else printf '%s\\n' "#dsh-functions-skipped $__dsh_s"; fi; fi`;
	return `{ ${STATE_REPORT_BODY}${conditional}; } | base64 -w0`;
}
/**
* Text that exists only inside a frame this module wrote.
*
* A frame's echo does not always arrive whole: measured on this machine, bash's line editor put
* `\r` and the **last 78 bytes** of the echoed frame on stderr, starting in the middle of the nonce,
* so neither the payload nor either record tag was in the bytes that needed recognising. Matching on
* these instead catches the head, the tail, or the whole line.
*/
const FRAME_SIGNATURES = [
	RECORD_TAG,
	STATE_TAG,
	"__dsh_status",
	"#dsh-section"
];
/**
* Build the stdin line that runs `command` and reports its exit code.
* @param command - the user's command, verbatim, any number of lines.
* @param functionCount - the shell's function count as last seen, or `undefined` to ask for a full
*   function snapshot on this frame (the first frame, and any frame whose command looks like a
*   definition).
* @returns the frame to write, and the nonce its completion record must carry.
*/
function encodeFrame(command, functionCount) {
	const nonce = newNonce();
	const payload = encodePayload(command);
	return {
		nonce,
		line: `eval "$(printf %s '${payload}' | base64 -d)" </dev/null; __dsh_status=$?; printf '\\0${RECORD_TAG}\\0%s\\0%s\\0' '${nonce}' "$__dsh_status"; printf '\\0${STATE_TAG}\\0%s\\0%s\\0' '${nonce}' "$( ${stateReport(functionCount)} )" # ${RECORD_TAG}\n`,
		payload
	};
}
/**
* Drop the shell's own echo of a frame from the stderr destined for the model.
*
* An interactive `bash` whose stdin is a pipe writes the line it just read to stderr (measured on
* this machine: `bash-5.1$ eval "$(printf %s 'ZWNoby…' | base64 -d)" …`). That is protocol, not the
* command's output, and showing it would tell the model its own framing was part of the result — and
* in a real Desktop session it was: every call came back with a fragment of its own frame in
* `[stderr]`.
*
* Two shapes have to be caught, because the shell does not deliver the echo whole: the complete line
* (matched by {@link FRAME_SIGNATURES}), and a **tail** cut at any offset — measured at 79 bytes,
* starting mid-nonce. The frame ends with `# <RECORD_TAG>` for that reason, and a line ending in any
* suffix of either tag is treated as protocol too, so no cut point can slip between the two rules.
* Matched on our own text rather than on a prompt pattern, because the prompt is whatever the user's
* rc file says it is.
*
* @param text - stderr accumulated for the command in flight, whole lines only.
* @param payload - {@link CommandFrame.payload} of the frame currently in flight.
* @returns the same text with the echoed frames removed.
*/
function dropProtocolEcho(text, payload) {
	return text.split("\n").filter((line) => !FRAME_SIGNATURES.some((signature) => line.includes(signature)) && !endsWithTagSuffix(line) && !(payload.length > 0 && line.includes(payload))).join("\n");
}
/** Does this line end partway into one of our record tags, i.e. is it the tail of an echoed frame? */
function endsWithTagSuffix(line) {
	const trimmed = line.trimEnd();
	return [RECORD_TAG, STATE_TAG].some((tag) => [
		4,
		8,
		12,
		16
	].some((n) => tag.length > n && trimmed.endsWith(tag.slice(tag.length - n))));
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
* Split one frame's state report into its sections.
* @param state - the decoded value of a state record.
* @returns each section's body, keyed by header name; absent sections are missing, not empty.
*/
function parseState(state) {
	const sections = {};
	let current;
	for (const line of state.split("\n")) {
		if (line.startsWith("#dsh-section ")) {
			current = sections[line.slice(13).trim()] = [];
			continue;
		}
		if (line.startsWith("#dsh-functions-skipped")) current?.push(line);
		else current?.push(line);
	}
	return sections;
}
/**
* Build the script that brings a rebuilt shell back to where the lost one was.
*
* Order matters: options and shell settings first (they change how the rest parses), then the
* exported environment, then aliases and functions, and the `cd` last so a directory that only
* exists because of an earlier section is still reachable.
*
* @param state - the decoded state record of the last settled command.
* @returns the replay script and anything it leaves out, with reasons.
*/
function restoreScript(state) {
	const sections = parseState(state);
	const skipped = [];
	const keep = (name, prefixes) => (sections[name] ?? []).filter((line) => prefixes.some((prefix) => line.startsWith(prefix)));
	const options = keep("options", ["set -o ", "set +o "]);
	const shopt = keep("shopt", ["shopt -"]);
	const exports = keep("exports", ["declare -x "]);
	const aliases = keep("aliases", ["alias "]);
	const functions = (sections.functions ?? []).filter((line) => !line.startsWith("#dsh-"));
	const skippedMarker = (sections.functions ?? []).find((line) => line.startsWith("#dsh-functions-skipped"));
	if (skippedMarker !== void 0) skipped.push(`functions (${skippedMarker.split(" ")[1]} bytes over the ${FUNCTION_SNAPSHOT_CAP_BYTES} byte cap)`);
	const pwd = (sections.pwd ?? []).find((line) => line.startsWith("PWD="))?.slice(4);
	if (pwd === void 0 || pwd === "") skipped.push("working directory (not reported)");
	return {
		script: [
			...options,
			...shopt,
			...exports,
			...aliases,
			...functions,
			...pwd === void 0 || pwd === "" ? [] : [`cd ${JSON.stringify(pwd)} 2>/dev/null || true`]
		].join("\n"),
		skipped
	};
}
/**
* The chunks a rebuilt shell is brought back with, in the order they must be sent.
*
* One frame, not one big one: `eval` parses its whole string before running any of it, so a
* `shopt -s extglob` on line 50 does nothing for the bash-completion function on line 1623 that needs
* extglob to *parse* — measured as `syntax error near unexpected token '('` and exit 2, with the
* replay silently failing and 91 rc functions coming back while the user's own did not. Each chunk is
* its own frame, so each is parsed after the previous one has taken effect.
*
* The bootstrap goes first: it is the baseline the user's state sits on top of, and replaying exports
* and aliases before it would let the rc files overwrite them.
*
* @param state - the decoded state record of the last settled command.
* @returns the scripts to send, in order, and what was left out.
*/
function restoreChunks(state) {
	const plan = restoreScript(state);
	const sections = parseState(state);
	const skipped = plan.skipped;
	const options = [...(sections.options ?? []).filter((line) => line.startsWith("set -o ") || line.startsWith("set +o ")), ...(sections.shopt ?? []).filter((line) => line.startsWith("shopt -"))].join("\n");
	const environment = [...(sections.exports ?? []).filter((line) => line.startsWith("declare -x ")), ...(sections.aliases ?? []).filter((line) => line.startsWith("alias "))].join("\n");
	const functions = (sections.functions ?? []).filter((line) => !line.startsWith("#dsh-")).join("\n");
	const pwdLine = (sections.pwd ?? []).find((line) => line.startsWith("PWD="));
	const cd = pwdLine === void 0 || pwdLine === "PWD=" ? "" : `cd ${JSON.stringify(pwdLine.slice(4))} 2>/dev/null || true`;
	return {
		chunks: [
			BOOTSTRAP_COMMAND,
			options,
			environment,
			functions,
			cd
		].filter((chunk) => chunk.trim().length > 0),
		skipped
	};
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
* A command that defines a function or an alias, by text.
*
* The function snapshot is lazy (measured: 61 kB of `declare -f` after this machine's rc files), and
* a lazy count-based trigger misses a *redefinition* — same count, different body. The textual test
* is the cheap backstop: it only asks for one extra snapshot on the frames that define something.
*/
const DEFINITION = /(?:function\s+[\w.-]+|[\w.-]+\s*\(\s*\)\s*\{|\balias\s+\S+=)/;
/** The function count a state record reported, or undefined when it reported none. */
function functionCountOf(state) {
	const line = (parseState(state)["functions-count"] ?? []).find((candidate) => /^\d+$/.test(candidate.trim()));
	return line === void 0 ? void 0 : Number(line.trim());
}
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
	outSpill;
	/** Absolute byte counts of each stream since the shell started, and how far the file has reached. */
	outSeen = 0;
	outWritten = 0;
	err = Buffer.alloc(0);
	errTruncated = false;
	errSpill;
	errSeen = 0;
	errWritten = 0;
	journal = "";
	functionsBody = "";
	functionCount;
	queue = Promise.resolve();
	disposed = false;
	constructor(ctx, spec) {
		this.ctx = ctx;
		this.spec = spec;
	}
	/** Start the child and run the bootstrap. Safe to call once, before any command. */
	async start() {
		await this.spawn();
		if (!(await this.execute(BOOTSTRAP_COMMAND, this.spec.bootTimeoutMs, void 0, true)).settled) {
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
			const first = await this.execute(command, timeoutMs, signal, DEFINITION.test(command));
			if (first.settled) return first.run;
			const childGone = this.exited;
			const recovered = {
				restarted: true,
				...await this.rebuild()
			};
			if (!childGone || signal?.aborted === true) return {
				...first.run,
				...recovered
			};
			return {
				...(await this.execute(command, timeoutMs, signal, DEFINITION.test(command))).run,
				...recovered
			};
		} finally {
			release();
		}
	}
	/** Take the shell down and stop recovering. */
	async dispose() {
		this.disposed = true;
		await this.kill();
		this.closeSpills();
	}
	/** Spawn the child and attach the readers that feed the protocol. */
	async spawn() {
		this.out = Buffer.alloc(0);
		this.err = Buffer.alloc(0);
		this.outTruncated = false;
		this.errTruncated = false;
		this.outSeen = 0;
		this.outWritten = 0;
		this.errSeen = 0;
		this.errWritten = 0;
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
			this.outSeen += chunk.length;
			const cap = this.spec.maxOutputBytes * 2;
			if (this.out.length > cap) {
				const cut = this.out.length - cap;
				this.spill("stdout", this.out, cut);
				this.out = this.out.subarray(cut);
				this.outTruncated = true;
			}
		});
		handle.stderr?.on("data", (chunk) => {
			this.err = Buffer.concat([this.err, chunk]);
			this.errSeen += chunk.length;
			const cap = this.spec.maxOutputBytes * 2;
			if (this.err.length > cap) {
				const from = this.err.length - this.spec.maxOutputBytes;
				const boundary = this.err.indexOf(10, from < 0 ? 0 : from);
				const cut = boundary < 0 ? this.err.length - cap : boundary + 1;
				this.spill("stderr", this.err, cut);
				this.err = this.err.subarray(cut);
				this.errTruncated = true;
			}
		});
		handle.done.then(() => {
			this.exited = true;
		}, () => {
			this.exited = true;
		});
	}
	/** Append the bytes of the current window that have not reached the stream's spill file yet. */
	spillWindow(key, buffer, upto) {
		const isOut = key === "stdout";
		const target = isOut ? this.outSpill : this.errSpill;
		if (target === void 0) return;
		const streamStart = (isOut ? this.outSeen : this.errSeen) - buffer.length;
		const written = isOut ? this.outWritten : this.errWritten;
		const from = Math.max(written, streamStart);
		const to = streamStart + upto;
		if (to <= from) return;
		try {
			writeSync(target.fd, stripRecords(buffer.subarray(from - streamStart, upto)));
		} catch {}
		if (isOut) this.outWritten = to;
		else this.errWritten = to;
	}
	/** Start the file for a stream that has just overflowed, and write the bytes leaving memory. */
	spill(key, buffer, cut) {
		if ((key === "stdout" ? this.outSpill : this.errSpill) === void 0) this.openSpill(key);
		this.spillWindow(key, buffer, cut);
	}
	/** Create the spill file, named the way the host's one-shot tool names its own. */
	openSpill(key) {
		const directory = mkdtempSync(join(tmpdir(), "dsh-subprocess-"));
		const path = join(directory, `dsh-subprocess-${process.pid}-${key === "stdout" ? 1 : 2}-${this.spec.sessionToken}-${key}.log`);
		const created = {
			path,
			fd: openSync(path, "wx", 384)
		};
		if (key === "stdout") this.outSpill = created;
		else this.errSpill = created;
		return created;
	}
	/** Close the spill files, which is also what makes a rebuilt session stop writing into the old ones. */
	closeSpills() {
		for (const record of [this.outSpill, this.errSpill]) {
			if (record === void 0) continue;
			try {
				closeSync(record.fd);
			} catch {}
		}
		this.outSpill = void 0;
		this.errSpill = void 0;
	}
	/**
	* Write one frame and wait for its records.
	* @returns the run, plus whether the shell answered at all.
	*/
	async execute(command, timeoutMs, signal, forceFunctions = false) {
		const handle = this.handle;
		const stdin = handle?.stdin;
		if (handle === void 0 || stdin === void 0) throw new Error("wsl-bash: the session has no stdin to write to");
		this.closeSpills();
		this.outSeen = this.out.length;
		this.outWritten = 0;
		this.errSeen = this.err.length;
		this.errWritten = 0;
		const frame = encodeFrame(command, forceFunctions ? -1 : this.functionCount);
		const armed = deadline(signal, timeoutMs, "WSL_BASH_TIMEOUT");
		stdin.write(frame.line);
		for (;;) {
			const found = readFrame(this.out, frame.nonce);
			if (found !== void 0) {
				this.spillWindow("stderr", this.err, this.err.length);
				this.spillWindow("stdout", this.out, found.recordStart);
				const stdout = stripRecords(this.out.subarray(0, found.recordStart)).toString("utf8");
				const stderr = this.takeStderr(frame.payload);
				const truncated = this.outTruncated;
				this.out = this.out.subarray(found.nextOffset);
				this.outTruncated = false;
				this.errTruncated = false;
				this.journal = this.journalWithFunctions(found.state);
				this.functionCount = functionCountOf(found.state) ?? this.functionCount;
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
						truncated,
						stderrTruncated: false,
						...this.spillPaths()
					}
				};
			}
			if (armed.signal.aborted || this.exited) {
				armed[Symbol.dispose]();
				const timedOut = timeoutOf(armed.signal, "WSL_BASH_TIMEOUT") !== void 0;
				this.spillWindow("stderr", this.err, this.err.length);
				this.spillWindow("stdout", this.out, this.out.length);
				return {
					settled: false,
					run: {
						stdout: stripRecords(this.out).toString("utf8"),
						stderr: this.takeStderr(frame.payload),
						exitCode: timedOut ? -1 : 1,
						timedOut,
						aborted: !timedOut,
						restarted: false,
						truncated: this.outTruncated,
						stderrTruncated: this.errTruncated,
						...this.spillPaths()
					}
				};
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	}
	/** The complete-stream files, if either stream ever overflowed, in the host's field names. */
	spillPaths() {
		return {
			...this.outSpill === void 0 ? {} : { stdoutSpillPath: this.outSpill.path },
			...this.errSpill === void 0 ? {} : { stderrSpillPath: this.errSpill.path }
		};
	}
	/**
	* The state record of a settled frame, with the function bodies carried forward.
	*
	* The frame only pays for `declare -f` when the function count moved (measured: 61 kB of rc
	* functions), which means the *next* record has no functions section at all. Replacing the journal
	* wholesale lost them — measured: after one more command and a rebuild, 91 rc functions came back
	* and the function defined two calls earlier did not. So the bodies live in their own field and are
	* re-attached to every journal until a newer snapshot replaces them.
	*/
	journalWithFunctions(state) {
		const sections = parseState(state);
		if (sections.functions !== void 0) {
			this.functionsBody = sections.functions.join("\n");
			return state;
		}
		return this.functionsBody === "" ? state : `${state}\n#dsh-section functions\n${this.functionsBody}`;
	}
	/**
	* Hand out the stderr that has completed a line since the last call, keeping any unterminated
	* tail for the next one.
	*
	* The shell echoes each frame line to stderr, and the pipe can deliver that echo in pieces, so a
	* window cut at a byte offset can start in the middle of an echo — and the half without the
	* payload in it is unrecognisable as protocol. That is how every real Desktop call came back
	* with a fragment of its own framing in `[stderr]`. Cutting at line boundaries instead means the
	* filter always sees a whole echo line, whose tags identify it whatever frame wrote it.
	*
	* @param payload - the frame in flight's payload, for the case where the echo is one line.
	* @returns the completed, filtered stderr for this call.
	*/
	takeStderr(payload) {
		const boundary = this.err.lastIndexOf(10);
		if (boundary < 0) return "";
		const window = this.err.subarray(0, boundary + 1).toString("utf8");
		this.err = this.err.subarray(boundary + 1);
		return dropProtocolEcho(window, payload);
	}
	/**
	* Kill the wedged child and bring back one that knows where we left off.
	* @returns what the replay could not restore, and how many detached processes were reaped.
	*/
	async rebuild() {
		const restore = restoreChunks(this.journal);
		await this.kill();
		this.closeSpills();
		const reaped = await this.reapDetached();
		await this.spawn();
		this.functionCount = void 0;
		for (const [index, chunk] of restore.chunks.entries()) await this.execute(chunk, this.spec.bootTimeoutMs, void 0, index === restore.chunks.length - 1);
		return {
			skipped: restore.skipped.length > 0 ? restore.skipped : void 0,
			reaped: reaped > 0 ? reaped : void 0
		};
	}
	/**
	* Stop processes this session started that outlived its shell.
	*
	* Measured: killing `wsl.exe` takes its shell's ordinary children with it (0 survivors), but a
	* command that detached itself (`setsid`, `nohup … &`) survives (2/2). Left alone, every wedged
	* call would accumulate a process for the rest of the distribution's life. The reaper matches the
	* `DSH_WSL_SESSION` token this session puts in its children's environment, not a command name —
	* `pkill -f sleep` would stop a process the user started in another terminal, which is the
	* mis-kill the positive control in `bash-session-real` exists to catch.
	* @returns how many processes were stopped.
	*/
	async reapDetached() {
		if (this.spec.reaperArgv.length === 0) return 0;
		const script = `n=0; for p in /proc/[0-9]*; do if grep -qa 'DSH_WSL_SESSION=${this.spec.sessionToken}' "$p/environ" 2>/dev/null; then pid=\${p#/proc/}; kill -9 "$pid" 2>/dev/null && n=$((n+1)); fi; done; printf 'REAPED=%s\\n' "$n"`;
		const env = { ...this.spec.env };
		delete env.DSH_WSL_SESSION;
		let text = "";
		try {
			const handle = this.ctx.subprocess.spawn({
				argv: [...this.spec.reaperArgv, script],
				cwd: this.spec.cwd,
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore"
				},
				graceMs: this.spec.graceMs,
				env
			});
			handle.stdout?.on("data", (chunk) => {
				text += chunk.toString("utf8");
			});
			await handle.done.catch(() => void 0);
		} catch {
			return 0;
		}
		return Number(/REAPED=(\d+)/.exec(text)?.[1] ?? "0");
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
//#region src/host/wsl-bash-tty.ts
/**
* Running a command that wants a real terminal, inside a shell that has none.
*
* The session protocol gives a command a pipe for stdin and no controlling terminal, which is right
* for everything a model normally runs. It is wrong for the small class that opens `/dev/tty` — a
* password prompt, an editor — and the failure there is not an error message: `sudo true` with no
* terminal was measured to sit there until the call's deadline expired, returning
* `[timed out after 6000ms]` and nothing else, and costing a session rebuild.
*
* `script -qec '<cmd>' /dev/null` gives the command a fresh pseudo-terminal of its own while the
* outer pipe stays ours: the records that end the call are written by the frame, outside `script`,
* so escalation cannot corrupt the protocol. Measured on this machine (2026-10-04): the same
* `sudo true` returns in 476 ms with sudo's own three lines — `[sudo] password for ruler:`,
* `sudo: no password was provided`, `sudo: a password is required` — and exit 1.
*
* What the pty costs is bytes: `script` echoes CR/LF pairs (`\r\r\n`) that the plain path never
* produces, so an escalated call's output is normalised before the model reads it.
*
* @module dsh-wsl-workspace/host/wsl-bash-tty
*/
/**
* First words whose ordinary use is interactive. Deliberately narrow: `git`, `docker` and `curl`
* reach a terminal only in special subcommands, and wrapping them would add CR noise to the
* commands a model runs a hundred times a day.
*/
const TTY_COMMANDS = /* @__PURE__ */ new Set([
	"sudo",
	"su",
	"doas",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"telnet",
	"ftp",
	"passwd",
	"chpasswd",
	"gpg",
	"ssh-copy-id",
	"ssh-keygen",
	"vim",
	"vi",
	"nvim",
	"view",
	"nano",
	"pico",
	"emacs",
	"ed",
	"htop",
	"top",
	"less",
	"more",
	"pg",
	"man",
	"info",
	"mysql",
	"mariadb",
	"psql",
	"sqlplus",
	"redis-cli",
	"mongosh",
	"mongod",
	"gh",
	"az",
	"gcloud",
	"aws",
	"virsh",
	"tmux",
	"screen"
]);
/**
* The command's first word, with leading assignments and an `env` prefix skipped, so
* `LANG=C sudo reboot` and `env -i vim file` are recognised. (Written as a token loop rather than
* one alternation because `scripts/verify-lib.mjs` reads the built chunk for unbound calls, and a
* regex containing `env(` looks like one.)
*/
function firstWord(command) {
	let rest = command.trimStart();
	let afterEnv = false;
	for (;;) {
		const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
		if (assignment !== null) {
			rest = rest.slice(assignment[0].length);
			continue;
		}
		if (!afterEnv && /^env\s+/.test(rest)) {
			afterEnv = true;
			rest = rest.replace(/^env\s+/, "");
			continue;
		}
		const flag = afterEnv ? /^-\S+\s+/.exec(rest) : null;
		if (flag === null) break;
		rest = rest.slice(flag[0].length);
	}
	return /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)?.[1] ?? "";
}
/**
* Whether this command should be given a terminal of its own.
* @param command - the model's command, verbatim.
* @returns true when its first word is in {@link TTY_COMMANDS}.
*/
function needsTty(command) {
	return TTY_COMMANDS.has(firstWord(command));
}
/**
* Wrap a command so it runs on a pseudo-terminal with a sane window size.
*
* The inner command travels base64-encoded for the same reason the frame's payload does: it may
* contain quotes or newlines, and `script -c` takes one string argument. `stty` runs *inside* the
* pty — measured: setting it outside leaves `stty size` answering `0 0` even though `tty` reports
* `/dev/pts/N`.
*
* @param command - the model's command, verbatim.
* @returns a command to run in the session shell that escalates to a pty.
*/
function wrapForTty(command) {
	return `script -qec "$(printf %s '${Buffer.from(`stty rows 24 cols 80 2>/dev/null; ${command}`, "utf8").toString("base64")}' | base64 -d)" /dev/null`;
}
/**
* Fold a pty's line endings and control sequences back into plain text.
*
* Only escalated output goes through this. `script` writes `\r\n` for newlines and, because the
* inner shell also rewrites its own prompt line, sometimes `\r\r\n`; a bare `\r` left in the body
* makes the host's front-end render the tail of a line over its head.
*
* @param text - stdout or stderr as the pty produced it.
* @returns the same text with CR removed and CSI/OSC sequences dropped.
*/
function normaliseTtyOutput(text) {
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
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
/**
* Declared for readers and for a host that mounts the module object. The host's loader
* (`cordis-plugin-loader`, `unwrapExports`) hands cordis `exports.default` — this module's bare
* `apply` — so neither `inject` nor `Config` reaches the fiber, and `ctx.subprocess` then throws
* `cannot get property "subprocess" without inject`. The code below therefore resolves the seam with
* `ctx.get('subprocess')`, which bypasses the inject requirement, as the rest of this plugin does.
*/
const inject = ["subprocess"];
/** Environment facts that must reach the distribution. */
const BRIDGED_KEYS = [
	"DSH_HOME",
	"DSH_SESSION_ID",
	"DSH_WSL_DISTRO",
	"DSH_WSL_USER",
	"DSH_WSL_SESSION",
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
/** The Linux form of a session path: UNC, absolute Linux, or a Windows drive path. */
function linuxOf(path) {
	if (path === void 0 || path === "") return void 0;
	const unc = parseWslUnc(path);
	if (unc !== null) return unc.linuxPath;
	if (path.startsWith("/")) return path;
	return windowsToMntPath(path) ?? void 0;
}
/**
* The Linux directory a call runs in.
*
* A relative `workdir` is joined onto the session's own directory, which is what the host's one-shot
* tool does (`dsh-tool-bash`'s `resolveWorkdir`); measured there, `workdir: "docs"` becomes
* `/home/ruler/docs` and the `cd` fails with bash's own `No such file or directory`. Translating it
* to nothing instead would run the command somewhere the model did not ask for, silently.
*
* @param args - the model's arguments.
* @param exec - the tool execution, whose agent session carries the workspace path.
* @returns the path for the call's `cd`, or undefined to let the session stay where it is.
*/
function resolveCwd(args, exec) {
	if (args.workdir === void 0 || args.workdir === "") return void 0;
	if (args.workdir.startsWith("/") || parseWslUnc(args.workdir) !== null) return linuxOf(args.workdir);
	const base = linuxOf(exec.agent?.session?.header?.cwd);
	if (base === void 0) return linuxOf(args.workdir);
	return `${base.replace(/\/+$/, "")}/${args.workdir.replace(/^\.?\/+/, "")}`;
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
/**
* The host's abort shape. `dsh-tool-bash` throws `toolAborted()` on a caller cancel — a
* `HarnessError` reading `tool call aborted` with `name` set to `AbortError` — and the trace renders
* that as a cancelled call. Returning a result instead would put `[exit code: 1]` on a command the
* user stopped, which reads as if their command had failed.
*/
function toolAborted() {
	const error = /* @__PURE__ */ new Error("tool call aborted");
	error.name = "AbortError";
	return error;
}
/**
* Render one finished run the way the host's tool does, so the trace text is the same shape.
*
* The host's own truncation sentence is `[output truncated; full output: <path>]`
* (`dsh-tool-bash/lib/index.js:137`), copied here verbatim because a model that has learned it in one
* world should not have to learn a second one. Anything the session did that the model could not
* otherwise see — a restart, a skipped section, a reaped process — is appended as its own bracketed
* line rather than left in a log the user of Desktop cannot read.
*/
function renderRun(value) {
	let body = value.stdout.text;
	if (value.stdout.truncated && value.stdout.spillPath !== void 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[output truncated; full output: ${value.stdout.spillPath}]`;
	}
	if (value.stderr.text.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${value.stderr.text}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers = [];
	if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
	if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`);
	else if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`);
	markers.push(...value.notes);
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
function toForeground(run, timeoutMs, escalated) {
	const killed = run.exitCode < 0;
	const notes = [];
	if (run.timedOut) notes.push("[the shell was restarted to recover; for work that outlives one call pass run_in_background: true, or use bash_background]");
	if (run.restarted) notes.push(run.skipped === void 0 || run.skipped.length === 0 ? "[the shell was restarted and its directory, exported variables, options and aliases were replayed]" : `[the shell was restarted; not restored: ${run.skipped.join(", ")}]`);
	if (run.reaped !== void 0 && run.reaped > 0) notes.push(`[${run.reaped} detached process${run.reaped === 1 ? "" : "es"} from the previous shell ${run.reaped === 1 ? "was" : "were"} stopped]`);
	return {
		kind: "foreground",
		exitCode: killed ? null : run.exitCode,
		signal: null,
		timedOut: run.timedOut,
		aborted: run.aborted,
		timeoutMs,
		stdout: {
			text: escalated ? normaliseTtyOutput(run.stdout) : run.stdout,
			truncated: run.truncated,
			...run.stdoutSpillPath === void 0 ? {} : { spillPath: run.stdoutSpillPath }
		},
		stderr: {
			text: escalated ? normaliseTtyOutput(run.stderr) : run.stderr,
			truncated: run.stderrTruncated,
			...run.stderrSpillPath === void 0 ? {} : { spillPath: run.stderrSpillPath }
		},
		notes
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
		},
		spillPath: { type: "string" }
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
	const linuxCwd = linuxOf(headerCwd);
	const sessionToken = randomUUID();
	const prefix = [
		"wsl.exe",
		"-d",
		distro,
		...user === void 0 ? [] : ["-u", user]
	];
	return {
		argv: [
			...prefix,
			...linuxCwd === void 0 ? [] : ["--cd", linuxCwd],
			"-e",
			"bash",
			...SESSION_ARGV
		],
		reaperArgv: [
			...prefix,
			"-e",
			"bash",
			"-c"
		],
		cwd: process.env.SystemRoot ?? "C:\\Windows",
		env: bridgeEnv({
			...ENV_OVERRIDES,
			DSH_WSL_DISTRO: distro,
			DSH_WSL_SESSION: sessionToken,
			...user === void 0 ? {} : { DSH_WSL_USER: user }
		}, BRIDGED_KEYS),
		graceMs: config.graceMs,
		bootTimeoutMs: config.bootTimeoutMs,
		maxOutputBytes: config.maxOutputBytes,
		sessionToken
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
	const spawnHost = () => {
		const subprocess = ctx.get("subprocess");
		if (subprocess === void 0 || typeof subprocess.spawn !== "function") throw new Error("wsl-bash: this host exposes no subprocess service to start a shell with");
		return { subprocess };
	};
	const sessions = /* @__PURE__ */ new Map();
	const cleanup = () => {
		for (const session of sessions.values()) session.dispose();
		sessions.clear();
	};
	ctx.effect?.(() => cleanup);
	const tool = defineTool({
		name: TOOL_NAME,
		description: "Run a bash command inside this WSL distribution. The shell is persistent: `cd`, exported variables, activated virtualenvs, aliases and shell functions survive between calls, so use absolute paths or an explicit `cd` when a call must not depend on where the last one left off. A command that reads from stdin is given /dev/null. Commands that need a real terminal (`sudo`, `ssh`, an editor) are given a pseudo-terminal of their own automatically; pass `tty: true` to force one for anything else. For work that must outlive one call pass `run_in_background: true` — it starts a tracked job (`job_output` to read, `job_kill` to stop) in a separate process, so it does not see this shell's `cd` or `export`.",
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
				description: "Working directory for this call. Defaults to the session workspace; a relative path resolves against it."
			},
			timeoutMs: {
				type: "number",
				description: "Per-call deadline in milliseconds."
			},
			tty: {
				type: "boolean",
				description: "Run the command on a pseudo-terminal. Applied automatically for `sudo`, `ssh`, editors and similar; set it for a program that fails with a terminal-related error."
			},
			run_in_background: {
				type: "boolean",
				description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies, and the job runs in its own process rather than in this shell."
			}
		},
		output: {
			schema: { oneOf: [{
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
					stderr: STREAM_SCHEMA,
					notes: {
						type: "array",
						items: { type: "string" }
					}
				}
			}, {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "background"
					},
					jobId: {
						type: "string",
						required: true
					}
				}
			}] },
			render: (_args, value) => value.kind === "background" ? [{
				type: "text",
				text: `started background job ${value.jobId}`
			}] : renderRun(value)
		},
		presentCall: (args) => ({
			card: "terminal",
			title: args.command
		}),
		async execute(args, exec) {
			const headerCwd = exec.agent?.session?.header?.cwd;
			const timeoutMs = Math.min(args.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs);
			const ownerKey = exec.agent?.id ?? exec.agent?.session?.id ?? "default";
			if (args.run_in_background === true) return {
				kind: "background",
				...startBackgroundJob(ctx, {
					command: args.command,
					...args.workdir === void 0 ? {} : { workdir: args.workdir }
				}, exec)
			};
			const escalated = args.tty === true || needsTty(args.command);
			const payload = escalated ? wrapForTty(args.command) : args.command;
			const workdir = args.workdir === void 0 ? void 0 : resolveCwd(args, exec);
			const command = workdir === void 0 ? payload : `cd ${JSON.stringify(workdir)} && { ${payload}\n}`;
			let session = sessions.get(ownerKey);
			if (session === void 0) {
				const spec = buildSessionSpec(resolved, headerCwd);
				if (spec === void 0) throw new Error("wsl-bash: no WSL distribution could be resolved for this session");
				session = new WslBashSession(spawnHost(), spec);
				sessions.set(ownerKey, session);
				await session.start().catch((error) => {
					sessions.delete(ownerKey);
					throw error instanceof Error ? error : new Error(String(error));
				});
			}
			const run = await session.run(command, timeoutMs, exec.signal);
			if (run.aborted) throw toolAborted();
			return toForeground(run, timeoutMs, escalated);
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

//# sourceMappingURL=wsl-bash-tool-C7flW-l_.js.map