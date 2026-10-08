import { a as joinUnc, c as parseWslUnc, r as isValidWslUsername, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { n as getWindowsWorkspace, r as getWorkspaceUsername } from "./wsl-credentials-DzKgEzy7.js";
import { n as defaultDistroSync } from "./wsl-JTf2gBat.js";
import { r as bridgeEnv } from "./wsl-env-sWOHjH2G.js";
import { startBackgroundJob } from "./wsl-jobs.js";
import z from "@deepseek-ai/schemastery";
import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
//#region src/shared/wsl-stdin.ts
/**
* The `stdin` ceiling of one `bash` call, with no host package behind it.
*
* This lives in `src/shared` rather than in `src/host/wsl-bash-tool.ts` because the tool module
* imports `@deepseek-ai/schemastery`, which is an *optional peer dependency* — a plain `npm ci`
* does not install it. The pure-node unit bucket (`npm run test:unit`, the `lint-build` job) has no
* host packages at all, and a test that needed the ceiling had to import the tool to get it:
* measured on the cloud frame at `ed08a5b`, two test files failed to load with
* `Cannot find package '@deepseek-ai/schemastery'`. The number and its sentence are pure text and
* arithmetic, so they belong where a test can read them.
*
* @module dsh-wsl-workspace/shared/wsl-stdin
*/
/**
* The ceiling on one call's `stdin`, and the reason it is where it is.
*
* The text travels inside the frame line (base64, like the command), so its cost is the frame's cost,
* and that was measured on this machine (2026-10-05, `D:\Temp\issue51-s0`): a 64 kB command answers in
* ~3.8 s and a 256 kB one in ~59 s, because a piped bash reads the line as fast as the pipe delivers
* it. Half the measured 64 kB point is the ceiling — a command plus its input at the frame size
* nobody has measured past should still feel like a tool call — and a larger input is refused by name
* rather than truncated, because a program fed half its input fails in ways that look like the
* program's fault.
*/
const STDIN_CAP_BYTES = 32768;
/**
* Whether a call's `stdin` is beyond what the frame can carry.
* @param stdin - the caller's input, if any.
* @returns the sentence to throw for the tool, or undefined when the input fits.
*/
function stdinRefusal(stdin) {
	if (stdin === void 0) return void 0;
	const bytes = Buffer.byteLength(stdin, "utf8");
	if (bytes <= 32768) return void 0;
	return `wsl-bash: stdin is ${bytes} bytes, over the ${STDIN_CAP_BYTES}-byte ceiling. The input travels in the same line as the command, and a frame's cost grows with its length (measured: a 64 kB frame answers in ~3.8 s, 256 kB in ~59 s). Write the data to a file first and redirect the command\'s stdin from it (\`command < file\`) — nothing was truncated and nothing ran`;
}
//#endregion
//#region src/host/wsl-bash-protocol.ts
/**
* The record protocol between this plugin and a long-lived WSL `bash`.
*
* The host's persistent bash tool decides "the command finished" by scraping the terminal for a
* sentinel line and requiring the exit-code digits to be followed immediately by a newline. That is
* a byte-exact comparison against a surface the terminal is allowed to repaint: an interactive Linux
* shell redraws its prompt line, the emulator leaves the erased cells as spaces, and the recorded line
* arrives as `:0␠␠` so the check never fires (issue #51 point 3, measured 2026-10-04: three calls
* hung 303.8 s, one settled in 4.2 s, and the host's own matcher reproduced 4/4 offline). The erase was
* first attributed to readline's `ESC[<n>X`; the captured stream on disk holds no `ESC[<n>X` at all —
* only `ESC[K`, `ESC[2J`, cursor positioning and literal spaces — so what this protocol defends
* against is the measured shape (bytes between the digits and the newline), not a named recipe.
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
	`printf '%s\\n' '#dsh-section pid'; printf 'PID=%s\\n' "$$"`,
	`printf '%s\\n' '#dsh-section aliases'; alias -p`,
	`printf '%s\\n' '#dsh-section options'; set +o`,
	`printf '%s\\n' '#dsh-section shopt'; shopt -p`,
	`printf '%s\\n' '#dsh-section functions-count'; declare -F | wc -l`
].join("; ");
/**
* The conditional that carries function bodies, given the count the session last saw.
*
* Measured on this machine, `declare -f` after the rc files is **61,881 bytes across 91 functions**.
* Base64 on every frame would put ~81 kB through the pipe per command to repeat a snapshot that
* almost never changes, so the shell itself compares its own function count with the one the session
* last recorded and only asks {@link BOOTSTRAP_COMMAND}'s helper when they differ (or when the
* session asks, because the command text looked like a definition).
*
* What the helper sends is the functions the distribution's own startup files did not define — a
* rebuilt shell re-sources those files, so replaying them costs the pipe and proves nothing. The cap
* is then applied per function, not to the whole snapshot: measured 2026-10-06 on a distribution
* whose rc functions alone are 86,954 bytes, an all-or-nothing cap threw away *every* function in
* the shell, including the one the user had just defined. Functions that individually do not fit are
* reported by name.
*/
const FUNCTION_SNAPSHOT_CAP_BYTES = 65536;
/** The header of the section the snapshot writes. */
const FUNCTIONS_SECTION = "#dsh-section functions";
/** The marker that names the functions the cap could not carry. */
const FUNCTIONS_SKIPPED = "#dsh-functions-skipped";
/** The marker a shell writes when it has no snapshot helper to ask. */
const FUNCTIONS_MISSING = "#dsh-functions-missing";
/**
* The helper the session's own shell defines at bootstrap: write one function snapshot.
*
* It walks only the names the baseline does not already contain, so the loop body runs as many times
* as there are functions the user defined. Measured on this machine's 91 startup functions: the
* `sort`/`comm` set difference costs 7 ms and a walk of all 91 bodies would cost 150 ms — both
* paid only on a frame whose function count moved, never on an ordinary call (which is why the frame
* asks this helper instead of carrying the loop itself: the frame goes out on every call).
*
* The names come from `compgen -A function`, not from `declare -F` with its prefix cut off: with
* `set -o allexport` in effect bash prints `declare -fx name`, and a filter anchored on `declare -f `
* then turns every name into `declare -fx name` — measured the day it was found, when the live cell
* that sets `allexport` lost the function it had just defined, because the "new" name it looked up
* with `declare -f --` did not exist.
*/
const SNAPSHOT_HELPER = `__dsh_snapshot() { printf '%s\\n' '${FUNCTIONS_SECTION}'; __dsh_new=$(comm -13 <(printf '%s\\n' "$__dsh_rcf" | sort) <(compgen -A function | sort)); __dsh_left=${FUNCTION_SNAPSHOT_CAP_BYTES}; __dsh_over=''; while IFS= read -r __dsh_f; do [ -n "$__dsh_f" ] || continue; __dsh_b=$(declare -f -- "$__dsh_f"); if [ "\${#__dsh_b}" -le "$__dsh_left" ]; then printf '%s\\n' "$__dsh_b"; __dsh_left=$((__dsh_left - \${#__dsh_b} - 1)); else __dsh_over="\${__dsh_over}\${__dsh_over:+,}\${__dsh_f}(\${#__dsh_b})"; fi; done <<< "$__dsh_new"; [ -n "$__dsh_over" ] && printf '%s\\n' "${FUNCTIONS_SKIPPED} $__dsh_over"; return 0; }`;
/**
* The session shell's own pid, as one frame reported it.
* @param state - the decoded state record.
* @returns the pid, or undefined when the record did not carry one.
*/
function shellPidOf(state) {
	const line = (parseState(state).pid ?? []).find((candidate) => candidate.startsWith("PID="));
	const pid = Number(line?.slice(4) ?? "");
	return Number.isInteger(pid) && pid > 0 ? pid : void 0;
}
/**
* Build the state-report tail that follows a completion record.
* @param functionCount - the function count the session last saw, or `undefined` to force a snapshot.
* @returns shell text that prints the sections, and the bodies only when they changed.
*/
function stateReport(functionCount) {
	const conditional = functionCount === void 0 ? "" : `; __dsh_n=$(declare -F | wc -l); if [ "$__dsh_n" != '${functionCount}' ]; then if declare -F __dsh_snapshot >/dev/null 2>&1; then __dsh_snapshot; else printf '%s\\n' '${FUNCTIONS_SECTION}' '${FUNCTIONS_MISSING} __dsh_snapshot: the session bootstrap did not run in this shell'; fi; fi`;
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
* @param stdin - the caller's `stdin` text, when the call brought one. It travels inside this same
*   line (base64, like the command) and is decoded into a temporary file the command's stdin is
*   redirected from — the pipe itself cannot carry it, because a command that reads stdin from a
*   pipe would eat the protocol bytes that end the call. Without it the command gets `/dev/null`,
*   which is what a model running ordinary commands wants.
* @returns the frame to write, and the nonce its completion record must carry.
*/
function encodeFrame(command, functionCount, stdin) {
	const nonce = newNonce();
	const payload = encodePayload(command);
	const stdinPayload = stdin === void 0 ? void 0 : encodePayload(stdin);
	const input = stdinPayload === void 0 ? {
		setup: "",
		redirect: "</dev/null"
	} : {
		setup: `__dsh_in=$(mktemp 2>/dev/null || printf %s "/tmp/dsh-stdin-$$"); printf %s '${stdinPayload}' | base64 -d > "$__dsh_in"; `,
		redirect: `< "$__dsh_in"`
	};
	const line = input.setup + `eval "$(printf %s '${payload}' | base64 -d)" ${input.redirect}; __dsh_status=$?; ` + (stdinPayload === void 0 ? "" : "rm -f -- \"$__dsh_in\"; ") + `printf '\\0${RECORD_TAG}\\0%s\\0%s\\0' '${nonce}' "$__dsh_status"; printf '\\0' >&2; printf '\\0${STATE_TAG}\\0%s\\0%s\\0' '${nonce}' "$( ${stateReport(functionCount)} )" # ${RECORD_TAG}\n`;
	return stdinPayload === void 0 ? {
		nonce,
		line,
		payload
	} : {
		nonce,
		line,
		payload,
		stdinPayload
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
* @param stdinPayload - {@link CommandFrame.stdinPayload} of that frame, when it carried one: it is
*   part of the same echoed line, so a line containing it is protocol too.
* @returns the same text with the echoed frames removed.
*/
function dropProtocolEcho(text, payload, stdinPayload) {
	return text.split("\n").filter((line) => !FRAME_SIGNATURES.some((signature) => line.includes(signature)) && !endsWithTagSuffix(line) && !(payload.length > 0 && line.includes(payload)) && !(stdinPayload !== void 0 && stdinPayload.length > 0 && line.includes(stdinPayload))).join("\n");
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
* Read only the completion record: exit code and where the command's own output ended.
*
* The state record is written by the same frame but *after* this one (the shell computes it second), and
* it costs 5 564 bytes and ~25 ms of the distribution's own work on this machine — measured. Nothing in
* a call's answer needs it: it exists so a *future* rebuild can replay the shell's state. Splitting the
* two lets a call settle the moment its exit code is on the wire and leaves the state to be collected
* between calls.
* @param buffer - everything the session has written to stdout since it started.
* @param nonce - the nonce of the frame in flight.
* @param fromOffset - where the previous command's window ended.
* @returns the status and the offsets, or undefined while the completion record is incomplete.
*/
function readCompletion(buffer, nonce, fromOffset = 0) {
	const completion = readRecord(buffer, RECORD_TAG, nonce, fromOffset);
	if (completion === void 0) return void 0;
	if (!/^\d+$/.test(completion.value)) return void 0;
	return {
		status: Number(completion.value),
		recordStart: completion.start,
		nextOffset: completion.next
	};
}
/**
* Read the state record that follows a completion record.
* @param buffer - everything the session has written to stdout since it started.
* @param nonce - the nonce of the frame that wrote it.
* @param fromOffset - the completion record's `nextOffset`.
* @returns the decoded state and where to resume, or undefined while it is incomplete.
*/
function readStateRecord(buffer, nonce, fromOffset) {
	const state = readRecord(buffer, STATE_TAG, nonce, fromOffset);
	if (state === void 0) return void 0;
	try {
		return {
			state: Buffer.from(state.value, "base64").toString("utf8"),
			nextOffset: state.next
		};
	} catch {
		return;
	}
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
	const skippedMarker = (sections.functions ?? []).find((line) => line.startsWith(`${FUNCTIONS_SKIPPED} `));
	const missingMarker = (sections.functions ?? []).find((line) => line.startsWith(`${FUNCTIONS_MISSING} `));
	if (missingMarker !== void 0) skipped.push(`functions (${missingMarker.slice(`${FUNCTIONS_MISSING} `.length).trim()})`);
	if (skippedMarker !== void 0) {
		const names = skippedMarker.slice(`${FUNCTIONS_SKIPPED} `.length).split(",").filter((entry) => entry !== "");
		if (names.length > 0) skipped.push(`functions ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""} (over the ${FUNCTION_SNAPSHOT_CAP_BYTES} byte cap; the distribution's own functions were left for its startup files)`);
	}
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
*
* The last two lines are the snapshot machinery's own: the helper writes a function snapshot, and
* the name list it compares against is taken **after** both are in place, so the helper is one of
* the distribution's own functions from the snapshot's point of view. A rebuilt shell re-runs this
* bootstrap, so it re-derives both — which is why the snapshot only has to carry what the rc files
* did not define.
*/
const BOOTSTRAP_COMMAND = [
	"set +H",
	"shopt -s expand_aliases 2>/dev/null || true",
	"for f in /etc/profile ~/.profile /etc/bash.bashrc ~/.bashrc; do [ -r \"$f\" ] && . \"$f\" >/dev/null 2>&1; done",
	"PS1=",
	SNAPSHOT_HELPER,
	"__dsh_rcf=$(compgen -A function)",
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
const PROBE_SLOW_MS = 2e3;
/** The shortest silence each kind of reading has to hold before the tool acts on it. */
const MIN_WAIT_MS = {
	terminal: 600,
	"own-terminal": 2500,
	opaque: 1500
};
/**
* The shell text the probe runs, as a sibling `wsl.exe` call.
*
* One argv element, so it is written as a single line with every separator explicit: joining statement
* fragments with `'; '` produced `do;`, which bash rejects with exit 2 (measured) — and a probe that
* never runs looks exactly like a command that is not waiting for anything. The walk is `pgrep -P`
* eight levels down from the session shell; the shell itself is skipped, because its own state is
* "waiting for the next frame", which is not a finding.
*/
/**
* Printed last so a pass that died half-way is recognisable as *not having answered*. A probe that
* never runs looks exactly like a command that is not waiting for anything, which is the failure this
* whole layer must not have.
*/
const PROBE_DONE_SENTINEL = "DSH_PROBE_DONE";
/**
* Build the probe's shell text.
* @param rootPid - the session shell's pid, the root of the walk.
* @returns one line of bash to hand to `bash -c`.
*/
function probeScript(rootPid) {
	return `root=${rootPid}; keep=$root; front=$root; depth=0; while [ \$depth -lt 8 ]; do next=; for f in \$front; do for x in \$(pgrep -P \$f 2>/dev/null); do next="\$next \$x"; done; done; case $next in '') break ;; esac; keep="$keep $next"; front=$next; depth=$((depth+1)); done; for pid in \$keep; do [ -r /proc/$pid/stat ] || continue; set -- \$(ps -o pid=,pgid=,tpgid=,stat=,comm= -p \$pid); wchan=\$(cat /proc/\$pid/wchan 2>/dev/null); sc=$(cut -d\' \' -f1 /proc/$pid/syscall 2>/dev/null); cpu=$(cut -d' ' -f1,2 /proc/$pid/schedstat 2>/dev/null | tr ' ' ','); if ls /proc/$pid/fd >/dev/null 2>&1; then ttys=$(ls -l /proc/$pid/fd 2>/dev/null | grep -c -e pts/ -e /dev/tty); else ttys=-1; fi; role=desc; [ "$pid" = "$root" ] && role=shell; echo "P $1 $2 $3 $4 w=$wchan c=$cpu tty=$ttys sc=$sc comm=$5 role=$role"; done; echo ${PROBE_DONE_SENTINEL}`;
}
/**
* Parse one probe pass.
* @param text - the probe's stdout, whole lines of `P <pid> <pgid> <tpgid> <state> w=… c=<utime>,<stime> tty=…`.
* @param atMs - when the pass was taken, for the note.
* @returns the rows it reported; a line that does not match is dropped rather than guessed at.
*/
function parseProbe(text, atMs) {
	const rows = [];
	const field = (groups, index) => groups[index] ?? "";
	for (const line of text.split(/\r?\n/)) {
		const match = /^P (\d+) (\d+) (-?\d+) (\S+) w=(\S*) c=([\d,]*) tty=(-?\d+)(?: sc=(\S*))? comm=(.*?) role=(\S+)$/.exec(line.trim());
		if (match === null) continue;
		const [utime = "0", stime = "0"] = field(match, 6).split(",");
		rows.push({
			pid: Number(field(match, 1)),
			pgid: Number(field(match, 2)),
			tpgid: Number(field(match, 3)),
			state: field(match, 4),
			cpuNs: Number(utime) + Number(stime),
			wchan: field(match, 5) === "" ? "running" : field(match, 5),
			ttyFds: Number(field(match, 7)),
			syscall: field(match, 8),
			comm: field(match, 9),
			shell: field(match, 10) === "shell"
		});
	}
	return {
		atMs,
		rows
	};
}
/**
* Whether the processes under the shell are waiting for something no one can give them.
*
* A process consuming CPU rules the answer out whatever else it looks like: that is the difference
* between this and a deadline, and the reason a long build is never stopped early.
* @param previous - the sample before this one, or undefined for the first look.
* @param current - the sample just taken.
* @param ownTerminal - true when this call was given a pseudo-terminal of its own (`tty: true`, or the
*   re-run after a previous stop). A program on that terminal may wait in `poll` beside it rather than
*   in a bare `read`, and the input side of that pty is ours — so a poll there can be named as
*   unsatisfiable, though not as cheaply as a `read`: it gets the longer window. Pass false (the
*   default) for an ordinary pipe call, where `poll_schedule_timeout` is indistinguishable from waiting
*   on a socket and must not be stopped.
* @returns which of the three readings the samples support, or undefined when anything is still moving.
*/
function starveOf(previous, current, ownTerminal = false) {
	if (current.rows.length === 0) return void 0;
	for (const row of current.rows) {
		const before = previous?.rows.find((candidate) => candidate.pid === row.pid);
		if (before !== void 0 && row.cpuNs > before.cpuNs) return void 0;
		if (row.state.startsWith("R")) return void 0;
	}
	let weaker;
	for (const row of current.rows) {
		if (!row.state.startsWith("S") && !row.state.startsWith("T")) continue;
		if (ownTerminal && row.comm === "script") continue;
		if (!(row.tpgid >= 0 && row.pgid === row.tpgid)) continue;
		if (row.ttyFds > 0 && row.wchan === "wait_woken") return "terminal";
		if (row.shell) continue;
		if (ownTerminal && row.ttyFds > 0 && (row.wchan === "poll_schedule_timeout" || row.wchan === "poll_schedule_timeout.constprop.0" || row.wchan === "do_epoll_wait" || row.wchan === "ep_poll")) weaker = "own-terminal";
		if (row.wchan === "0" && row.ttyFds < 0) weaker = "opaque";
	}
	return weaker;
}
/**
* The processes that justify a verdict, so a stop names them and not every row in the sample.
*
* The shell has been part of the walk since a builtin reading the terminal was measured to block it,
* which means a sample now always contains at least that row: stopping "the pids the probe reported"
* would take the shell down for a child that is merely reading its own terminal.
* @param sample - the sample the verdict came from.
* @param kind - the verdict.
* @param ownTerminal - whether the call was given a pty of its own (the weaker reading needs it).
* @returns the pids responsible, in the order the probe found them.
*/
function culpritPids(sample, kind, ownTerminal = false) {
	return sample.rows.filter((row) => {
		if (!row.state.startsWith("S") && !row.state.startsWith("T")) return false;
		if (ownTerminal && row.comm === "script") return false;
		if (row.tpgid < 0 || row.pgid !== row.tpgid) return false;
		if (kind === "terminal") return row.ttyFds > 0 && row.wchan === "wait_woken";
		if (kind === "own-terminal") return !row.shell && ownTerminal && row.ttyFds > 0 && (row.wchan === "poll_schedule_timeout" || row.wchan === "poll_schedule_timeout.constprop.0" || row.wchan === "do_epoll_wait" || row.wchan === "ep_poll");
		return !row.shell && row.wchan === "0" && row.ttyFds < 0;
	}).map((row) => row.pid);
}
/**
* The shell text that stops a wedged foreground job and nothing else.
*
* A stopped process ignores `SIGTERM` until it is continued — measured, `timeout` could not remove a
* `sudo` sitting on its prompt — so `SIGCONT` goes first. Only the pids the probe just reported are
* named; no pattern is matched against a command line, because a pattern would also hit whatever the
* user is running in another terminal.
* @param pids - the processes to stop, in the order the probe found them.
* @returns shell text to run as the session's user.
*/
function stopScript(pids) {
	const list = pids.filter((pid) => Number.isInteger(pid) && pid > 1).join(" ");
	if (list === "") return "echo DSH_NOTHING_TO_STOP";
	return `for p in ${list}; do kill -CONT $p 2>/dev/null; kill -TERM $p 2>/dev/null; done; sleep 0.3; for p in ${list}; do kill -KILL $p 2>/dev/null; done; echo DSH_STOPPED ${list}`;
}
/**
* The sentence that says a command ran twice, and why.
*
* The second attempt is what makes the answer useful, and it is also a second execution: a command that
* had already written a file or posted a request before it reached its prompt did that once, and does it
* again now. Silence here would be the same defect as running a timed-out command twice without saying
* so, which is measured history (`echo run >> f` landing twice, 2026-10-04).
* @param kind - what the first attempt was found to be waiting for.
* @param atMs - how long the first attempt had been silent when it was stopped.
* @returns the note to put in the body of the retried call.
*/
function retryNote(kind, atMs, viaRoot = false, shellInterrupted = false) {
	return `[the first attempt was ${shellInterrupted ? "ended by restarting the shell (the blocked process was the shell itself, which no signal frees)" : "stopped"} after ${atMs}ms because it was waiting for keyboard input this shell cannot supply (${kind === "opaque" ? "no output and no CPU, with its `/proc` entries unreadable (it runs with privileges this tool cannot see inside)" : viaRoot ? "no output and no CPU, asleep in the terminal's foreground job — read through the distribution's root rights, because this process hides its own `/proc` entries from its user" : "no output and no CPU, asleep in the terminal's foreground job with a terminal among its descriptors"}). The command was then run once more on a pseudo-terminal of its own, so anything it had already done before that prompt has now been done twice — the body below is the second attempt]`;
}
/**
* What one probe pass saw, in the shortest form that is still a measurement.
*
* A call that reached its deadline with the watchdog having looked and looked and never confirmed is
* the shape this exists for: on the WSL1 runner the reading takes its rows and calls none of them a
* terminal wait, so the call burns its whole deadline and the body says only "timed out". Saying *what
* was seen* is what makes that attributable — on the kernel that can read it, the same line carries
* `w=wait_woken 1tty fg` — and it keeps the note honest about the tool looking and not finding, rather
* than about nothing having run.
*
* What each kernel actually answers was measured on the CI runners, not assumed: frame 37494104075
* reads `shell:Ss w=do_wait sc=61 1tty bg; sleep:S+ w=hrtimer_nanosleep sc=230 0tty fg` on WSL2 and
* `shell:S w= 1tty bg; sleep:S w= 0tty bg` on WSL1 — there `wchan` and `syscall` come back *empty*,
* which is not the same fact as WSL2's `0` ("another user's process, not readable from here"), and not
* the same fact as an empty `wchan` on a process in state `R` ("running, so nowhere asleep"). The
* three are printed apart below because a note that calls an asleep process `running` is a lie about
* the one thing this layer is supposed to know.
* @param sample - the rows of one pass, or undefined when the pass never answered.
* @returns a clause for the note, or `''` when there was nothing to report.
*/
function describeRows(sample) {
	const rows = sample?.rows ?? [];
	if (rows.length === 0) return "";
	return `${rows.slice(0, 4).map((row) => {
		const w = row.wchan === "running" && !row.state.startsWith("R") ? "not-reported" : row.wchan;
		const fg = row.tpgid < 0 ? "no-tpgid" : row.tpgid === row.pgid ? "fg" : "bg";
		const tty = row.ttyFds < 0 ? "fd-unreadable" : `${row.ttyFds}tty`;
		const sc = row.syscall === "" ? "" : ` sc=${row.syscall}`;
		return `${row.shell ? "shell" : row.comm}:${row.state} w=${w}${sc} ${tty} ${fg}`;
	}).join("; ")}${rows.length > 4 ? `; +${rows.length - 4} more` : ""}`;
}
/**
* Whether a reading taken through the root plane confirms a terminal read, or rules it out.
*
* This is what replaces waiting eight seconds to be sure. A privileged program hides its `/proc` entries
* from its own owner (sudo clears its dumpable flag), so the user plane can only ever call such a wait
* *unconfirmable* — but a probe run as root reads `wchan`, the `syscall` and the fd table of those
* processes, which is the same evidence the confirmed reading uses. Three answers matter:
* `confirmed` (a terminal read is really there), `ruled-out` (the root plane read the wait and it is
* something else — a timer, a socket), and undefined (no root plane answered, so the caller keeps the
* unconfirmable reading and its own window).
* @param witness - the rows one root-plane pass reported, or undefined when the pass did not answer.
* @returns whether the root plane confirms a terminal read, rules it out, or could not say.
*/
function confirmsTerminalRead(witness) {
	if (witness === void 0 || witness.rows.length === 0) return void 0;
	return starveOf(void 0, witness, false) === "terminal";
}
/**
* The sentence that tells the model what was seen, and what it can do about it.
*
* Each kind says the reading it actually had — the confirmed one names `/proc`, the unconfirmable ones
* say they could not be confirmed — because the note is what a caller uses to decide whether to re-run
* with a longer deadline, ask for a terminal, or hand the prompt to a person.
* @param kind - which of the three readings the probe returned.
* @param atMs - how long the call had been silent when it was stopped.
* @param viaRoot - true when the terminal read was confirmed through the root plane rather than read
*   directly, which happens for a privileged program whose own `/proc` entries are hidden.
* @returns the note to put in the body.
*/
function starveNote(kind, atMs, viaRoot = false, shellInterrupted = false) {
	const doors = "run it with `tty: true` to give it a terminal, or ask a person to run it in the right sidebar's terminal tab, where a keyboard is attached";
	if (kind === "terminal") {
		const what = shellInterrupted ? "the process waiting was the shell itself (a builtin that read the terminal), which no signal frees, so the shell was restarted with its state replayed" : "it was stopped so the shell stays usable";
		return `[this command was waiting for keyboard input nobody is able to type into this shell: ${viaRoot ? "a probe with the distribution's root rights read the wait this process hides from its own user (`/proc/<pid>/wchan` = `wait_woken`, a terminal among its descriptors)" : "it was asleep in the terminal's foreground job with `/proc/<pid>/wchan` = `wait_woken` and a terminal among its descriptors"}. ${what === void 0 ? "" : ""}${what} — ${doors}]`;
	}
	if (kind === "own-terminal") return `[this command was waiting for input on the pseudo-terminal this call gave it: after ${atMs}ms it was still asleep in that terminal's foreground job, polling a terminal nothing can type into, with no output and no CPU. It was stopped so the shell stays usable — ${doors}]`;
	return `[this command was waiting for input this shell cannot supply: it had produced no bytes and used no CPU for ${atMs}ms, and it runs with privileges this tool cannot read inside (\`/proc/<pid>/wchan\` unreadable), so the wait could not be confirmed. It was stopped so the shell stays usable — ${doors}]`;
}
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
	/**
	* The code the child came back with, once it has come back. Kept because the call that ended the
	* shell has to report a code, and the only code available to it is the shell's own — which for
	* `exit 3` is the command's, since bash leaves with the status it was handed.
	*/
	exitStatus = void 0;
	out = Buffer.alloc(0);
	outTruncated = false;
	outSpill;
	/** Absolute byte counts of each stream since the shell started, and how far the file has reached. */
	outSeen = 0;
	outWritten = 0;
	err = Buffer.alloc(0);
	/** True once the frame in flight has written its stderr-end marker (a NUL byte) on fd 2. */
	errEnded = false;
	/** Set when the blocked process was the shell itself, so the note says the shell was restarted. */
	shellInterrupted = false;
	errTruncated = false;
	errSpill;
	errSeen = 0;
	errWritten = 0;
	journal = "";
	functionsBody = "";
	functionCount;
	/** Readers parked in {@link waitForOutput}, resolved the moment stdout moves. */
	readers = [];
	/**
	* The frame that settled but whose state record has not been consumed yet, if any. The record is the
	* *first* thing in `out` while this is set — the buffer is consumed up to the completion record, and
	* the shell writes the state record immediately after it — so it is read from offset 0 and, until it
	* arrives, `stripRecords` already keeps it out of anything a later window would show.
	*/
	pendingState;
	/**
	* The session shell's own pid inside the distribution, read off the last frame's state record. Zero
	* until the first frame has settled — which is also the only frame that cannot be watched.
	*/
	shellPid = 0;
	/**
	* Whether the root-plane witness has ever answered for this shell. `undefined` until it is asked,
	* `false` once an attempt came back empty, so a distribution without a usable root account pays for
	* that discovery once rather than on every privileged wait.
	*/
	witnessAvailable;
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
		await this.settleTail();
	}
	/**
	* Run one command, recovering transparently if it wedges the shell.
	* @param command - the model's command, verbatim.
	* @param timeoutMs - this call's deadline.
	* @param signal - the caller's abort signal, if any.
	* @param ownTerminal - true when this command was wrapped onto a pseudo-terminal that the session
	*   itself created. The watchdog reads a poll wait on that terminal as unsatisfiable; on an ordinary
	*   pipe call the same reading would be indistinguishable from a network wait.
	* @param stdin - the caller's `stdin` text, when the call brought one. It travels inside the frame
	*   and becomes a file the command's stdin is redirected from (see {@link encodeFrame}); without it
	*   the command reads `/dev/null`.
	* @returns the outcome, with `restarted` set when the session had to be rebuilt.
	*/
	async run(command, timeoutMs, signal, ownTerminal = false, stdin) {
		const previous = this.queue;
		let release = () => {};
		this.queue = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (this.disposed) throw new Error("wsl-bash: the session is closed");
			const first = await this.execute(command, timeoutMs, signal, DEFINITION.test(command), ownTerminal, stdin);
			if (first.settled) return first.run;
			const childGone = this.exited;
			const recovered = {
				restarted: true,
				...await this.rebuild()
			};
			if (!childGone || signal?.aborted === true || first.run.starved !== void 0) return {
				...first.run,
				...recovered
			};
			return {
				...(await this.execute(command, timeoutMs, signal, DEFINITION.test(command), ownTerminal, stdin)).run,
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
		this.exitStatus = void 0;
		this.pendingState = void 0;
		this.readers = [];
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
			this.wakeReaders();
			const cap = this.spec.maxOutputBytes * 2;
			if (this.out.length > cap) {
				const cut = this.out.length - cap;
				this.spill("stdout", this.out, cut);
				this.out = this.out.subarray(cut);
				this.outTruncated = true;
			}
		});
		handle.stderr?.on("data", (chunk) => {
			const hasMarker = chunk.indexOf(0) >= 0;
			if (hasMarker) this.errEnded = true;
			const kept = hasMarker ? Buffer.from(chunk.filter((byte) => byte !== 0)) : chunk;
			this.err = Buffer.concat([this.err, kept]);
			this.errSeen += kept.length;
			this.wakeReaders();
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
		handle.done.then((outcome) => {
			this.exited = true;
			this.exitStatus = outcome?.exitCode ?? void 0;
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
	* @param ownTerminal - whether this command runs on a pseudo-terminal the session created.
	* @returns the run, plus whether the shell answered at all.
	*/
	async execute(command, timeoutMs, signal, forceFunctions = false, ownTerminal = false, stdinText) {
		const handle = this.handle;
		const stdin = handle?.stdin;
		if (handle === void 0 || stdin === void 0) throw new Error("wsl-bash: the session has no stdin to write to");
		if (process.env.DSH_WSL_TRACE === "1") console.error(`[trace] start shellPid=${this.shellPid} pending=${String(this.pendingState !== void 0)} out=${this.out.length}`);
		this.drainState();
		if (process.env.DSH_WSL_TRACE === "1") console.error(`[trace] drained shellPid=${this.shellPid} pending=${String(this.pendingState !== void 0)} out=${this.out.length}`);
		this.errEnded = false;
		this.shellInterrupted = false;
		this.closeSpills();
		this.outSeen = this.out.length;
		this.outWritten = 0;
		this.errSeen = this.err.length;
		this.errWritten = 0;
		const frame = encodeFrame(command, forceFunctions ? -1 : this.functionCount, stdinText);
		const armed = deadline(signal, timeoutMs, "WSL_BASH_TIMEOUT");
		const watch = {
			startedAt: Date.now(),
			lastBytes: this.out.length + this.err.length,
			lastLookAt: 0,
			ownTerminal,
			looks: 0,
			failed: 0,
			witnessed: false,
			viaRoot: false
		};
		stdin.write(frame.line);
		for (;;) {
			const done = readCompletion(this.out, frame.nonce);
			if (done !== void 0) {
				this.spillWindow("stderr", this.err, this.err.length);
				await this.settleStderr();
				this.spillWindow("stdout", this.out, this.out.length);
				const stdout = stripRecords(this.out.subarray(0, done.recordStart)).toString("utf8");
				const stderr = this.takeStderr(frame.payload, frame.stdinPayload);
				const truncated = this.outTruncated;
				this.out = this.out.subarray(done.nextOffset);
				this.outTruncated = false;
				this.errTruncated = false;
				this.pendingState = frame.nonce;
				this.drainState();
				watch.settled = true;
				armed[Symbol.dispose]();
				return {
					settled: true,
					run: {
						stdout,
						stderr,
						exitCode: done.status,
						timedOut: false,
						aborted: false,
						shellExited: false,
						restarted: false,
						truncated,
						stderrTruncated: false,
						...this.spillPaths(),
						...this.starvedFields(watch)
					}
				};
			}
			const caused = armed.signal.aborted;
			const timedOut = timeoutOf(armed.signal, "WSL_BASH_TIMEOUT") !== void 0;
			const shellExited = this.exited && !caused && !timedOut;
			if (caused || this.exited) {
				armed[Symbol.dispose]();
				this.spillWindow("stderr", this.err, this.err.length);
				this.spillWindow("stdout", this.out, this.out.length);
				watch.settled = true;
				return {
					settled: false,
					run: {
						stdout: stripRecords(this.out).toString("utf8"),
						stderr: this.takeStderr(frame.payload, frame.stdinPayload),
						exitCode: timedOut ? -1 : this.exitStatus ?? 1,
						timedOut,
						aborted: !timedOut && watch.stop === void 0 && !shellExited,
						shellExited,
						restarted: false,
						truncated: this.outTruncated,
						stderrTruncated: this.errTruncated,
						...this.spillPaths(),
						...this.starvedFields(watch)
					}
				};
			}
			this.watchFrame(watch);
			await this.waitForOutput(POLL_MS);
		}
	}
	/** Resolve every reader waiting on output, so a record is noticed the moment it arrives. */
	wakeReaders() {
		const waiting = this.readers;
		this.readers = [];
		for (const resolve of waiting) resolve();
	}
	/**
	* Wait for stdout to move, or for the poll interval to pass.
	*
	* The reader used to sleep a fixed 20 ms between checks, which put up to that much latency on every
	* call on top of whatever the shell needed. Waking on arrival removes it; the timer stays as the
	* safety net for the cases where nothing more will arrive (a timeout, a probe verdict, a death).
	* @param ms - the longest to wait without any output.
	*/
	waitForOutput(ms) {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				this.readers = this.readers.filter((reader) => reader !== done);
				resolve();
			}, ms);
			this.readers.push(done);
		});
	}
	/**
	* Wait for the frame's stderr-end marker before a settled call reports its answer.
	*
	* stdout carries the completion record and stderr carries half the answer, on two pipes with no order
	* between them, so "the command is over" and "its stderr has arrived" are not the same instant. The
	* frame writes one NUL byte on stderr after everything else, so this waits for an event, not for a
	* guess about how long a pipe takes; without it a cell measured `(no output)` where a command wrote
	* `oops` to fd 2, with those bytes landing in the *next* call's window.
	*/
	async settleStderr() {
		const until = Date.now() + 100;
		while (!this.errEnded && Date.now() < until) await this.waitForOutput(2);
	}
	/**
	* Consume the state record of the frame that just settled, when it has arrived.
	*
	* Called right after settling and again before the next frame goes out, so the journal is up to date
	* without any call paying for it.
	*/
	drainState() {
		const nonce = this.pendingState;
		if (nonce === void 0 || this.out.length === 0) return;
		const state = readStateRecord(this.out, nonce, 0);
		if (state === void 0) return;
		this.journal = this.journalWithFunctions(state.state);
		this.functionCount = functionCountOf(state.state) ?? this.functionCount;
		this.shellPid = shellPidOf(state.state) ?? this.shellPid;
		this.out = this.out.subarray(state.nextOffset);
		this.pendingState = void 0;
	}
	/**
	* Wait for a previous frame's state record before the next one is written.
	*
	* Bounded: a state record that never arrives means the shell died between the two, which the next
	* frame's own timeout reports. The journal simply keeps what it had.
	*/
	async settleTail() {
		if (this.pendingState === void 0) return;
		const until = Date.now() + 1e3;
		while (this.pendingState !== void 0 && Date.now() < until) {
			await this.waitForOutput(20);
			this.drainState();
		}
	}
	/**
	* Look once, and stop the command if the look says it is waiting for a keyboard.
	*
	* Rate-limited by {@link PROBE_EVERY_MS} and only started after {@link FIRST_PROBE_MS} of silence,
	* because the look is a second `wsl.exe` and was measured to cost 200–280 ms. A frame that has
	* written bytes at all is not waited on: the watchdog only ever fires on a call that is silent.
	*
	* The look itself is **not awaited**: it is fired here and its verdict is applied by
	* {@link applyLook} whenever it lands, so the reader keeps consuming output while a probe runs. That
	* is worth about 0.25 s on a silent command (measured: `sleep 3` used to answer 0.27 s late).
	* @param watch - this frame's watchdog state.
	*/
	watchFrame(watch) {
		if (this.shellPid === 0 || this.spec.reaperArgv.length === 0) return;
		if (watch.stop !== void 0 || watch.settled === true || watch.probing === true) return;
		const elapsed = Date.now() - watch.startedAt;
		const bytes = this.out.length + this.err.length;
		if (bytes !== watch.lastBytes) {
			watch.lastBytes = bytes;
			watch.lastLookAt = elapsed;
			watch.previous = void 0;
			return;
		}
		if (elapsed < 600) return;
		const cadence = watch.looks < 6 ? 400 : PROBE_SLOW_MS;
		if (elapsed - watch.lastLookAt < cadence) return;
		watch.lastLookAt = elapsed;
		watch.probing = true;
		this.probeStarve(watch, elapsed).then((sample) => this.applyLook(watch, sample, elapsed)).catch(() => void 0).finally(() => {
			watch.probing = false;
		});
	}
	/**
	* Apply one look's verdict: classify it, let the root plane settle a privileged wait, and stop the
	* command when the reading and its window agree.
	* @param watch - this frame's watchdog state.
	* @param sample - the rows the pass read, or undefined when the pass did not answer.
	* @param elapsed - how long the call had been in flight when the look was taken.
	*/
	async applyLook(watch, sample, elapsed) {
		if (sample === void 0 || watch.settled === true || watch.stop !== void 0) return;
		let kind = starveOf(watch.previous, sample, watch.ownTerminal);
		let culprits = sample;
		watch.previous = sample;
		if (kind === void 0) return;
		if (kind === "opaque" && !watch.witnessed && this.witnessAvailable !== false) {
			watch.witnessed = true;
			const witness = await this.probeOnce(this.spec.witnessArgv, elapsed);
			this.witnessAvailable = witness !== void 0;
			const verdict = confirmsTerminalRead(witness);
			if (verdict === true) {
				kind = "terminal";
				watch.viaRoot = true;
				if (witness !== void 0) culprits = witness;
			} else if (verdict === false) return;
		}
		if (elapsed < MIN_WAIT_MS[kind]) return;
		watch.stop = {
			kind,
			atMs: elapsed,
			pids: culpritPids(culprits, kind, watch.ownTerminal)
		};
		await this.stopJob(watch.stop.pids);
	}
	/** The run fields that carry a watchdog stop, or nothing when there was none. */
	starvedFields(watch) {
		if (watch.stop !== void 0) return {
			starved: watch.stop.kind,
			starvedAtMs: watch.stop.atMs,
			starvedViaRoot: watch.viaRoot,
			...this.shellInterrupted ? { starvedShellInterrupt: true } : {}
		};
		if (watch.looks === 0 && watch.failed > 0) return { starveProbeBroken: true };
		const saw = describeRows(watch.previous);
		if (saw !== "") return { starveSaw: saw };
		if (watch.looks > 0) return { starveSaw: `the walk answered ${watch.looks} time(s) and reported no child processes (shell pid ${this.shellPid ?? "unknown"})` };
		return { starveSaw: `no look ran before the deadline (shell pid ${this.shellPid ?? "unknown"})` };
	}
	/**
	* One pass of the `/proc` walk, run as the session's own user in a process of its own.
	* @param watch - this frame's counters, so "the probe never answered" can be told to the caller.
	* @param atMs - how long the call has been in flight.
	* @returns the rows it read, or undefined when the pass did not answer — a probe that did not answer
	*   is never read as "nothing is waiting", and the run says so.
	*/
	async probeStarve(watch, atMs) {
		const sample = await this.probeOnce(this.spec.reaperArgv, atMs);
		if (sample === void 0) watch.failed += 1;
		else watch.looks += 1;
		return sample;
	}
	/**
	* One probe pass through whichever plane is asked for.
	* @param argv - the argv prefix the probe travels on (the session's own user, or root for a witness).
	* @param atMs - how long the call has been in flight.
	* @returns the rows it read, or undefined when that plane did not answer.
	*/
	async probeOnce(argv, atMs) {
		if (argv.length === 0) return void 0;
		const env = { ...this.spec.env };
		delete env.DSH_WSL_SESSION;
		let text = "";
		try {
			const handle = this.ctx.subprocess.spawn({
				argv: [...argv, probeScript(this.shellPid)],
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
			return;
		}
		return text.includes("DSH_PROBE_DONE") ? parseProbe(text, atMs) : void 0;
	}
	/**
	* Stop the processes the probe just named, and nothing else.
	* @param pids - the descendant ids from the last pass.
	*/
	async stopJob(pids) {
		const env = { ...this.spec.env };
		delete env.DSH_WSL_SESSION;
		if (pids.includes(this.shellPid)) this.shellInterrupted = true;
		const scripts = [stopScript(pids)];
		for (const script of scripts) try {
			await this.ctx.subprocess.spawn({
				argv: [...this.spec.reaperArgv, script],
				cwd: this.spec.cwd,
				stdio: {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore"
				},
				graceMs: this.spec.graceMs,
				env
			}).done.catch(() => void 0);
		} catch {}
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
		if (process.env.DSH_WSL_TRACE === "1") console.error(`[trace] state record: functions section=${String(sections.functions !== void 0)} bodies=${Buffer.byteLength((sections.functions ?? []).join("\n"))} markers=${JSON.stringify((sections.functions ?? []).filter((line) => line.startsWith("#dsh-functions-")))}`);
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
	* @param stdinPayload - that frame's stdin payload, which is part of the same echoed line.
	* @returns the completed, filtered stderr for this call.
	*/
	takeStderr(payload, stdinPayload) {
		const boundary = this.err.lastIndexOf(10);
		if (boundary < 0) return "";
		const window = this.err.subarray(0, boundary + 1).toString("utf8");
		this.err = this.err.subarray(boundary + 1);
		return dropProtocolEcho(window, payload, stdinPayload);
	}
	/**
	* Kill the wedged child and bring back one that knows where we left off.
	* @returns what the replay could not restore, and how many detached processes were reaped.
	*/
	async rebuild() {
		await this.settleTail();
		const restore = restoreChunks(this.journal);
		if (process.env.DSH_WSL_TRACE === "1") console.error(`[trace] rebuild: chunks=${restore.chunks.length} functions chunk=${String(restore.chunks.some((chunk) => chunk.includes("()")))} skipped=${JSON.stringify(restore.skipped)}`);
		await this.kill();
		this.closeSpills();
		const reaped = await this.reapDetached();
		await this.spawn();
		this.functionCount = void 0;
		for (const [index, chunk] of restore.chunks.entries()) await this.execute(chunk, this.spec.bootTimeoutMs, void 0, index === restore.chunks.length - 1);
		await this.settleTail();
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
* Running a command on a real terminal, inside a shell that nobody is typing into.
*
* The session gives a command pipes for stdin. That is right for everything a model normally runs,
* and wrong for the programs that read the terminal instead — and the failure there is not an error
* message. Measured on this machine (2026-10-05, `D:\Temp\issue51-s0\v1b-report.txt`): the session
* shell *does* have a controlling terminal (`ps -o tty=` answers `pts/1`) and job control (`$-` is
* `himBs`), so a command that reads `/dev/tty` is put in the foreground of a terminal whose input
* side nothing can feed. `sudo true` sleeps there as `S+` with `wchan=wait_woken` until the call's
* deadline expires, and the session then has to be rebuilt to be usable again.
*
* `script -qec '<cmd>' /dev/null` gives the command a pseudo-terminal of its own while the outer pipe
* stays ours: the records that end the call are written by the frame, outside `script`, so escalation
* cannot corrupt the protocol. It also changes the outcome, because `script`'s stdin is the frame's
* `/dev/null` — a program that reaches for the keyboard is handed **end of file** and answers with its
* own complaint. Measured: the same `sudo true` returns in 45–54 ms with sudo's three lines
* (`[sudo] password for ruler:`, `sudo: no password was provided`, `sudo: a password is required`) and
* exit 1, instead of costing the deadline.
*
* Nothing here decides *which* commands need a terminal: that judgement used to be three lists of
* command names and it was wrong twice in one day (`ssh-copy-id` never matched because the scan stopped
* at a hyphen; `printf x; vim note.txt` burnt 121 703 ms because only the first word was read). The
* decision is made by watching the process — see `wsl-bash-starve` — and `tty: true` remains the door
* for a caller who knows it wants a terminal before running anything.
*
* What a terminal costs is bytes: `script` echoes CR/LF pairs (`\r\r\n`) that the plain path never
* produces, and a program that cannot see a capable terminal writes emphasis as overstrike, so an
* escalated call's output is normalised before the model reads it. A pseudo-terminal also has no second
* channel: stdout and stderr arrive as one stream, which the parity ledger records as a difference from
* the plain path rather than something to paper over.
*
* @module dsh-wsl-workspace/host/wsl-bash-tty
*/
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
* Fold a pty's line endings, overstrike and control sequences back into plain text.
*
* Only escalated output goes through this. `script` writes `\r\n` for newlines and, because the
* inner shell also rewrites its own prompt line, sometimes `\r\r\n`; a bare `\r` left in the body
* makes the host's front-end render the tail of a line over its head.
*
* Overstrike is folded the way a terminal resolves it. Measured on this distribution, `man` writes
* every emphasised glyph as itself twice with a backspace between — `N\bNA\bAM\bME\bE` for `NAME` —
* which the model reads as garbage where a person at a real terminal reads `NAME`. Only those two
* shapes are folded (doubled glyph, and the `_\b` an underline marker leaves); a backspace that is
* none of those is left alone rather than eating a character that has not been overwritten.
*
* @param text - stdout or stderr as the pty produced it.
* @returns the same text with CR removed, overstrike resolved and CSI/OSC sequences dropped.
*/
function normaliseTtyOutput(text) {
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/.\x08/g, "").replace(/\r/g, "");
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
/**
* The ceiling on one call's `stdin`, and the refusal it earns when exceeded, both live in
* `src/shared/wsl-stdin.ts` — see the note there for why a test must not need this module.
*/
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
* The Linux user a call runs as.
*
* The chain is the one `src/shell.ts` resolves, in the same order, so the persistent tier and
* the one-shot fallback agree about who a workspace runs as: the session's own fact
* (`DSH_WSL_USER`, contributed by the host half), then the workspace's stored username, then
* the configured one. The stored step was missing here: the store is keyed by the workspace
* path, the one-shot executor reads it, the dialog writes it — and a WSL workspace configured
* for a user other than the distribution's default silently ran as that default instead.
* @param config - the resolved plugin configuration.
* @param headerCwd - the session's workspace path, when it has one.
* @returns the username, or undefined for the distribution default user.
*/
function resolveUser(config, headerCwd) {
	const unc = headerCwd === void 0 ? null : parseWslUnc(headerCwd);
	const stored = unc !== null ? getWorkspaceUsername(joinUnc(unc.distro, unc.linuxPath)) : headerCwd !== void 0 && /^[A-Za-z]:[\\/]/.test(headerCwd) ? getWindowsWorkspace(headerCwd)?.username : void 0;
	const candidates = [
		process.env.DSH_WSL_USER,
		stored,
		config.username
	];
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
/**
* How many times each exact command has been attempted since this shell started, per session. A
* `WeakMap` on the session object so a rebuild — which *is* a change in the environment — starts a
* clean count, and so nothing outlives the shell it describes.
*/
const attempts = /* @__PURE__ */ new WeakMap();
/** Shape a session run into the host's result contract. */
function toForeground(run, timeoutMs, escalated, before = [], repeats = 0) {
	const killed = run.exitCode < 0;
	const notes = [...before];
	if (run.starved !== void 0) notes.push(starveNote(run.starved, run.starvedAtMs ?? timeoutMs, run.starvedViaRoot === true, run.starvedShellInterrupt === true));
	if (run.timedOut) {
		if (run.starveProbeBroken === true) notes.push("[the check for a command waiting on a keyboard could not run in this distribution — its `/proc` walk did not answer — so nothing was stopped early: if this command was waiting for input, pass `tty: true`, run it in a `wsl_terminal` session, or ask a person to run it in the right sidebar's terminal tab]");
		if (run.restarted) notes.push("[the shell was restarted to recover; for work that outlives one call pass run_in_background: true, or use bash_background]");
		else notes.push("[the call reached its deadline; for work that outlives one call pass run_in_background: true, or use bash_background]");
		if (run.starveSaw !== void 0) notes.push(`[the check for a command waiting on a keyboard looked and read (/proc/<pid>/wchan, /proc/<pid>/syscall, its fd table): ${run.starveSaw}]`);
	}
	if (run.shellExited) notes.push("[this command ended the session shell itself (bash left with the code reported here), so it was run once more after the shell was rebuilt: anything it did before ending has been done twice, and this answer is from that second run. A command that must exit non-zero without ending its shell should wrap itself in its own `bash -c` body, or use `wsl_terminal`]");
	if (run.restarted) notes.push(run.skipped === void 0 || run.skipped.length === 0 ? "[the shell was restarted and its directory, exported variables, options and aliases were replayed]" : `[the shell was restarted; not restored: ${run.skipped.join(", ")}]`);
	if (run.reaped !== void 0 && run.reaped > 0) notes.push(`[${run.reaped} detached process${run.reaped === 1 ? "" : "es"} from the previous shell ${run.reaped === 1 ? "was" : "were"} stopped]`);
	if (escalated && run.exitCode !== 0 && /sudo: (a password is required|no password was provided)/.test(`${run.stdout}\n${run.stderr}`)) notes.push("[sudo asked for a password and this shell has nobody to type it: a person can run this once in the right sidebar's terminal tab; an agent-side answer is `wsl_terminal` (open a terminal, type the password the user gives you there — never guess one); or give the session user NOPASSWD in sudoers (or start the session as root with DSH_WSL_USER) so the agent can run it alone]");
	if (escalated && (run.exitCode !== 0 || run.timedOut) && !notes.some((note) => /password|keyboard|terminal/.test(note))) notes.push("[this call ran on a pseudo-terminal (`script -qec`, one stream): re-run the same command with `tty: false` to rule this layer out before looking anywhere else]");
	if (repeats >= 2 && (run.exitCode !== 0 || run.timedOut)) notes.push(`[this exact command has failed ${repeats} times in this shell with nothing succeeding in it since: it will answer the same way — change the command (a non-interactive flag, a different tool, an absolute path) or stop and report that it cannot be done here]`);
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
	const user = resolveUser(config, headerCwd);
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
		witnessArgv: [
			"wsl.exe",
			"-d",
			distro,
			"-u",
			"root",
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
	const logging = ctx.get("logger");
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
		description: "Run a bash command inside this WSL distribution. The shell is persistent: `cd`, exported variables, activated virtualenvs, aliases and shell functions survive between calls, so use absolute paths or an explicit `cd` when a call must not depend on where the last one left off. A command that reads from stdin is given /dev/null unless the call passes `stdin`. A command that instead reaches for the keyboard (`sudo`, `ssh`, an editor, a database client asking for a password) is caught by watching the process rather than guessed from its name: when a call goes silent with nothing running, the tool stops it and runs it again on a pseudo-terminal of its own inside the same call, so the body is the program's own complaint about having no terminal. A live display (`top`, `htop`) exits on its own without a terminal, so ask for `top -bn1` unless you pass `tty: true`. For work that must outlive one call pass `run_in_background: true` — it starts a tracked job (`job_output` to read, `job_kill` to stop) in a separate process, so it does not see this shell's `cd` or `export`. Nothing in this shell can be typed into, so a prompt there is unanswerable here by design: the second attempt is where the program gets to say what it wanted, and an answer has a door of its own — `wsl_terminal` opens an interactive terminal this agent can type into (ask the user for a password; never guess one), while a person can run the same command in the right sidebar's terminal tab, which has a keyboard attached.",
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
				description: "Per-call deadline in milliseconds, for a long build or install. A call that is caught waiting for keyboard input is stopped and re-run on a terminal inside the same deadline, so a longer deadline never means a longer silent wait for a prompt."
			},
			tty: {
				type: "boolean",
				description: "Run the command on a pseudo-terminal from the start. Set true when a terminal is what the command needs (a pager whose drawing matters, a program that refuses to run without a tty). Set false to keep the ordinary pipe even if the command goes quiet waiting for input — that vetoes the automatic re-run. Left out, the tool decides by watching the process instead of its name."
			},
			run_in_background: {
				type: "boolean",
				description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies, and the job runs in its own process rather than in this shell."
			},
			stdin: {
				type: "string",
				description: `Text to feed the command\'s standard input (up to ${STDIN_CAP_BYTES} bytes; larger input is refused by name, never truncated — write it to a file and redirect instead). Without it a command that reads stdin gets end-of-file, which is why a program that reaches for the keyboard is handled by \`tty\` and by \`wsl_terminal\` instead.`
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
			const overCap = stdinRefusal(args.stdin);
			if (overCap !== void 0) throw new Error(overCap);
			if (args.run_in_background === true) return {
				kind: "background",
				...startBackgroundJob(ctx, {
					command: args.command,
					...args.workdir === void 0 ? {} : { workdir: args.workdir },
					...args.stdin === void 0 ? {} : { stdin: args.stdin }
				}, exec)
			};
			const vetoTty = args.tty === false;
			let escalated = args.tty === true;
			const workdir = args.workdir === void 0 ? void 0 : resolveCwd(args, exec);
			const wrap = (payload) => workdir === void 0 ? payload : `cd ${JSON.stringify(workdir)} && { ${payload}\n}`;
			let command = wrap(escalated ? wrapForTty(args.command) : args.command);
			let session = sessions.get(ownerKey);
			if (session === void 0) {
				const spec = buildSessionSpec(resolved, headerCwd);
				if (spec === void 0) throw new Error("wsl-bash: no WSL distribution could be resolved for this session");
				session = new WslBashSession(spawnHost(), spec);
				sessions.set(ownerKey, session);
				const created = session;
				const register = (exec.agent?.ctx)?.effect;
				if (typeof register === "function") register(() => () => {
					if (sessions.get(ownerKey) !== created) return;
					sessions.delete(ownerKey);
					created.dispose();
				});
				await session.start().catch((error) => {
					sessions.delete(ownerKey);
					throw error instanceof Error ? error : new Error(String(error));
				});
			}
			const signature = args.command.replace(/\s+/g, " ").trim();
			let tally = attempts.get(session);
			if (tally === void 0) {
				tally = /* @__PURE__ */ new Map();
				attempts.set(session, tally);
			}
			const tried = (tally.get(signature) ?? 0) + 1;
			tally.set(signature, tried);
			let run = await session.run(command, timeoutMs, exec.signal, escalated, args.stdin);
			const before = [];
			if (!escalated && !vetoTty && run.starved !== void 0 && !run.aborted) {
				const first = {
					kind: run.starved,
					atMs: run.starvedAtMs ?? 0,
					viaRoot: run.starvedViaRoot === true,
					shellInterrupted: run.starvedShellInterrupt === true
				};
				logging?.debug?.(`wsl-bash: stopped a command waiting for input (${first.kind}${first.viaRoot ? " via the root plane" : ""} at ${first.atMs}ms) and re-running it on a pseudo-terminal`);
				escalated = true;
				before.push(retryNote(first.kind, first.atMs, first.viaRoot, first.shellInterrupted));
				command = wrap(wrapForTty(args.command));
				const firstRun = run;
				const retry = await session.run(command, timeoutMs, exec.signal, true, args.stdin);
				run = {
					...retry,
					restarted: retry.restarted || firstRun.restarted,
					skipped: retry.skipped ?? firstRun.skipped
				};
			}
			if (run.aborted) throw toolAborted();
			if (run.exitCode === 0 && !run.timedOut) tally.clear();
			return toForeground(run, timeoutMs, escalated, before, tried);
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

//# sourceMappingURL=wsl-bash-tool-COGn6HSt.js.map