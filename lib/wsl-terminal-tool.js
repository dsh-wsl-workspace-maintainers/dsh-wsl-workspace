import { a as joinUnc, c as parseWslUnc } from "./paths-CkIGMcuV.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/host/wsl-terminal-tool.ts
/** The tool name this plugin registers. */
const TOOL_NAME = "wsl_terminal";
/** The defaults, kept as data as well as schema fields (a row without `config:` mounts with none). */
const DEFAULTS = {
	timeoutMs: 6e4,
	quietMs: 1200
};
/** Validated plugin config. */
const Config = z.object({
	timeoutMs: z.number().default(DEFAULTS.timeoutMs),
	quietMs: z.number().default(DEFAULTS.quietMs)
});
/**
* Declared for readers and for a host that mounts the module object. The host's loader
* hands cordis `exports.default`, so a module-level `inject` never reaches the fiber —
* the same lesson `wsl-bash-tool.ts` recorded — and every service below is therefore
* resolved with `ctx.get`.
*/
const inject = ["terminals"];
const SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGTSTP",
	"SIGHUP"
];
/** How many screen lines a `read` returns when the caller names no count. */
const READ_LINES = 40;
/**
* The directory the backend should start the shell in.
*
* The backend hands this string to the PTY child (this plugin's relay) as its working
* directory, so it has to be a path a Windows process can start in: a WSL UNC path, or a
* Windows drive path the relay maps to `/mnt/<drive>`. A Linux path is translated through
* the session's own distribution, which is the only place its distro is known — and when
* the session itself is not a UNC workspace there is nothing to translate through, which
* is said out loud rather than turned into a shell that starts somewhere else.
* @param requested - the caller's `cwd`, if any.
* @param sessionCwd - the session workspace path.
* @returns the backend cwd, or undefined to let the backend use the session workspace.
*/
function backendCwd(requested, sessionCwd) {
	if (requested === void 0 || requested === "") return sessionCwd;
	if (parseWslUnc(requested) !== null || /^[A-Za-z]:[\\/]/.test(requested)) return requested;
	const unc = sessionCwd === void 0 ? null : parseWslUnc(sessionCwd);
	if (unc === null) throw new Error(`wsl_terminal: "${requested}" is a Linux path but this session's workspace is not a WSL UNC path, so its distribution is unknown — pass an absolute WSL path (\\\\wsl.localhost\\<distro>\\…) or a Windows drive path`);
	const tail = requested.replace(/^\/+/, "");
	return joinUnc(unc.distro, requested.startsWith("/") ? requested : `${unc.linuxPath.replace(/\/+$/, "")}/${tail}`);
}
/**
* The one session an action applies to: the named one, or the only one this agent owns.
* @param sessions - the agent's own sessions.
* @param requested - the caller's `session`, if any.
* @returns the session, or undefined when none is open and none was named.
* @throws Error naming the sessions that do exist when the request is ambiguous or unknown.
*/
function pickSession(sessions, requested) {
	if (requested !== void 0 && requested !== "") {
		const found = sessions.find((session) => session.sessionId === requested || session.name === requested);
		if (found === void 0) throw new Error(sessions.length === 0 ? `wsl_terminal: no terminal is open in this session (asked for "${requested}") — action "open" starts one` : `wsl_terminal: no owned terminal "${requested}"; open ones: ${sessions.map((session) => session.sessionId).join(", ")}`);
		return found;
	}
	if (sessions.length === 0) return void 0;
	if (sessions.length === 1) return sessions[0];
	throw new Error(`wsl_terminal: ${sessions.length} terminals are open and none was named — pass session: ${sessions.map((session) => session.sessionId).join(", ")}`);
}
/** One line describing a session's status, for `open`/`list`/`close`. */
function statusOf(status) {
	if (status.kind === "running") return "running";
	return `exited${status.signal === null || status.signal === void 0 ? "" : ` on ${status.signal}`}${status.exitCode === null || status.exitCode === void 0 ? "" : ` (code ${status.exitCode})`}`;
}
/**
* The bracketed line that says how a send ended and what to do next.
*
* The distinction that matters to the caller is "the program is waiting for you" versus
* "nothing has been written for a moment and no prompt was recognised": only the first is
* a fact about a program, and on this platform's PTYs the host's exact foreground probe
* reports zeros (issue #51 point 3), so the second is reported as the uncertainty it is
* instead of being dressed up as readiness.
* @param result - the settled send.
* @param quietMs - the backend's quiet window, so the sentence names the real number.
* @returns the note line, without a trailing newline.
*/
function settleNote(result, quietMs) {
	if (result.sessionStatus.kind === "exited") return `[the shell exited: ${statusOf(result.sessionStatus)} — this terminal is gone; open a new one]`;
	switch (result.waitReason) {
		case "stdin_read": return "[back at the prompt]";
		case "inferred_idle": return `[nothing was written for ~${quietMs} ms and no shell prompt was recognised: the program may be waiting for you, or it may still be working — read again to look]`;
		case "timeout": return "[the door stopped waiting and the command is still running: read again to look, or run long non-interactive work with the bash tool]";
		default: return "";
	}
}
/** The render for one terminal action: the screen (or a line about it) plus bracketed notes. */
function compose(body, notes) {
	const lines = [];
	if (body.length > 0) lines.push(body.replace(/\s+$/, ""));
	for (const note of notes) if (note !== "") lines.push(note);
	return { text: lines.length === 0 ? "(no output)" : lines.join("\n") };
}
/**
* Mount the door.
* @param ctx - plugin context; the terminal registry is looked up with `get` because the
*   host's loader does not carry a module-level `inject` into the fiber.
* @param config - plugin configuration; a row without a `config:` block mounts with none.
*/
function apply(ctx, config) {
	const resolved = {
		...DEFAULTS,
		...config === void 0 ? {} : config
	};
	const tools = ctx.get("tools");
	if (tools?.register === void 0) return;
	const registry = () => {
		const terminals = ctx.get("terminals");
		if (terminals === void 0 || typeof terminals.spawn !== "function" || typeof terminals.startSend !== "function") throw new Error("wsl_terminal: this host exposes no terminal service (the world's `pty` row is missing), so nothing can be typed into");
		return terminals;
	};
	const tool = defineTool({
		name: TOOL_NAME,
		description: "Open an interactive terminal inside this WSL distribution and type into it. Use it for anything that needs a keyboard: a password prompt (`sudo`, `ssh`), an unknown-host fingerprint, a REPL or debugger, an editor or TUI, or a program that refuses to run without a terminal. The terminal is a real interactive bash created by the host's own PTY stack, the same one the right sidebar's terminal tab uses — but owned by this agent, so state (directory, exported variables) persists across actions until `close`. Actions: `open` starts one (returns its id and what is on the screen), `send` types text — with Enter unless `submit: false` — and returns what changed, `read` pages the retained screen, `signal` sends SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP (SIGINT is what Ctrl-C does), `close` ends it, `list` shows the open ones. Anything typed is part of this conversation's record, and the terminal echoes it unless the program turns echo off. There is nobody to ask for a password: if a prompt needs one, ask the user for it in your reply and do not guess. A send returns when the shell is back at a prompt or after the screen has been quiet for a moment; for long non-interactive work use the `bash` tool instead, which waits on the process rather than the screen.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"open",
					"send",
					"read",
					"signal",
					"close",
					"list"
				],
				description: "What to do. `open` starts a terminal; `send` types into one; `read` pages its screen; `signal` delivers a signal to its foreground process; `close` ends it; `list` reports the open ones."
			},
			session: {
				type: "string",
				description: "Which terminal, as returned by `open`. May be omitted while exactly one is open; with several open it must be given."
			},
			text: {
				type: "string",
				description: "For `send`: the text to type, exactly as typed (no trailing newline needed — `submit` adds Enter)."
			},
			submit: {
				type: "boolean",
				description: "For `send`: press Enter after the text. Default true; set false to type without running anything."
			},
			signal: {
				type: "string",
				enum: [...SIGNALS],
				description: "For `signal`: which signal to deliver to the foreground process group."
			},
			offset: {
				type: "number",
				description: "For `read`: how many lines back from the newest to start at. Default 0 (the newest line)."
			},
			count: {
				type: "number",
				description: `For \`read\`: how many lines to return. Default ${READ_LINES}.`
			},
			cwd: {
				type: "string",
				description: "For `open`: where the terminal starts. Defaults to the session workspace; a Linux path is resolved inside this workspace's distribution."
			}
		},
		timeoutMs: resolved.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		presentCall: (args) => ({
			card: "terminal",
			title: args.action === "send" ? `${TOOL_NAME} ${args.text ?? ""}` : `${TOOL_NAME} ${args.action}`
		}),
		async execute(args, exec) {
			const owner = exec.agent;
			if (owner === void 0 || owner.id === void 0) throw new Error("wsl_terminal requires an owning agent session");
			const terminals = registry();
			const action = args.action;
			if (action === "open") {
				const cwd = backendCwd(args.cwd, owner.session?.header?.cwd);
				const spawned = await terminals.spawn(owner, {
					type: "wsl",
					...cwd === void 0 ? {} : { cwd }
				}, exec.signal);
				const notes = [`[terminal ${spawned.sessionId} is open — send: {action: "send", text: "…"}; Ctrl-C is signal: {action: "signal", signal: "SIGINT"}]`];
				if (spawned.motd.trim() !== "") notes.unshift(spawned.motd.trim());
				return compose("", notes);
			}
			if (action === "list") {
				const sessions = terminals.list(owner);
				if (sessions.length === 0) return compose("", ["[no terminal is open — action \"open\" starts one]"]);
				return compose(sessions.map((session) => `${session.sessionId}\t${statusOf(session.status)}${session.name === void 0 ? "" : `\t${session.name}`}`).join("\n"), []);
			}
			let current = pickSession(terminals.list(owner), args.session);
			if (current === void 0 && action === "send") {
				const cwd = backendCwd(args.cwd, owner.session?.header?.cwd);
				current = await terminals.spawn(owner, {
					type: "wsl",
					...cwd === void 0 ? {} : { cwd }
				}, exec.signal);
			}
			if (current === void 0) throw new Error(`wsl_terminal: no terminal is open${args.session === void 0 ? "" : ` as "${args.session}"`} — action "open" starts one`);
			const id = current.sessionId;
			if (current.status.kind === "exited" && (action === "send" || action === "signal")) throw new Error(`wsl_terminal: terminal ${id} has exited (${statusOf(current.status)}) — read it for its last screen, close it, or open a new one`);
			switch (action) {
				case "send": {
					if (typeof args.text !== "string") throw new Error("wsl_terminal: `send` needs `text` (an empty string is allowed: it just waits)");
					const submit = args.submit !== false;
					const operation = terminals.startSend(owner, id, {
						text: args.text,
						submit,
						...exec.signal === void 0 ? {} : { signal: exec.signal }
					});
					const result = await operation.done;
					const read = operation.readOutput();
					const body = read.delta.length > 0 ? read.delta : result.viewport;
					const notes = [settleNote(result, resolved.quietMs)];
					if (read.truncated || result.truncated) notes.push("[earlier output was dropped from this answer; `read` pages the retained screen]");
					return compose(body, notes);
				}
				case "read": {
					const page = terminals.read(owner, id, {
						offset: args.offset ?? 0,
						count: args.count ?? READ_LINES
					});
					return compose(page.text, [`[lines ${page.lineBegin}..${page.lineEnd} of ${page.totalLines} retained (line 0 is the newest); offset pages further back]`, ...page.truncated ? ["[older screen content has been dropped from the retention buffer]"] : []]);
				}
				case "signal": {
					const name = args.signal;
					if (name === void 0 || !SIGNALS.includes(name)) throw new Error(`wsl_terminal: \`signal\` needs one of ${SIGNALS.join(", ")}`);
					return compose("", [`[${name} delivered to the foreground process group ${(await terminals.signal(owner, id, name)).targetPgid}]`]);
				}
				case "close": return compose("", [await terminals.kill(owner, id, "closed by the agent") ? `[terminal ${id} closed]` : `[terminal ${id} was already closing]`]);
				default: throw new Error(`wsl_terminal: unknown action "${String(action)}"`);
			}
		}
	});
	const registered = tools.register(tool);
	if (typeof registered === "function") ctx.effect?.(() => () => {
		registered();
	});
}
//#endregion
export { Config, TOOL_NAME, apply, apply as default, backendCwd, inject, pickSession, settleNote, statusOf };

//# sourceMappingURL=wsl-terminal-tool.js.map