import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/host/wsl-jobs.ts
/** The tool name this plugin registers. */
const TOOL_NAME = "bash_background";
/**
* The defaults, kept as data as well as schema fields: a world row that mounts
* this plugin without a `config:` block hands `apply` an *undefined* config, and
* schemastery's defaults are not applied on that path. The `wsl-search` entry
* learned this from a live session; this one learned it the same way, which is
* why both read their defaults from one place.
*/
const DEFAULTS = { timeoutMs: 15e3 };
/** Validated plugin config. */
const Config = z.object({ timeoutMs: z.number().default(DEFAULTS.timeoutMs) });
/** Services this tool registers into (all three are read with `get`). */
const inject = ["tools"];
/**
* The `owner` entry for one job, in the shape this release's registry accepts.
*
* The registry changed that contract at `0.1.7-rc.1`, and the host's own
* producers changed with it (`owner: parent` before, `owner: parent.id` after):
*
*  - `0.1.0-rc.7` … `0.1.5-rc.2`: `start()` takes the **agent object**. It
*    resolves the owner with `agents.get(owner.id) !== owner` and reads
*    `owner.ctx` for scope cleanup, so handing it a session id throws
*    `Cannot read properties of undefined (reading 'Symbol(dsh.scope)')`.
*  - `0.1.7-rc.1` and later: `start()` takes the **session id** and resolves it
*    with `agents.get(id)`, so handing it the agent object throws
*    `session "[object Object]" has no live agent` — the second error in
*    issue #40.
*
* The two shapes are mutually exclusive and both mistakes fail loudly, so the
* release has to be asked which one it wants. The discriminator is
* `resolveOwner`, the method the newer registry added for exactly this
* conversion: measured present on `0.1.7-rc.1`, `0.1.7-rc.2` and `0.2.0-rc.2`,
* absent on all eight releases before them.
* @param jobs - the jobs registry.
* @param agent - the calling agent from the tool execution, when there is one.
* @returns the owner entry, or nothing for unowned work.
*/
function ownerOf(jobs, agent) {
	if (agent === void 0) return {};
	if (typeof jobs.resolveOwner !== "function") return { owner: agent };
	return agent.id === void 0 ? {} : { owner: agent.id };
}
/**
* Turn one finished background process into the registry's outcome shape.
* @param process - the settled shell process handle.
* @returns the job outcome with a kind-specific detail line.
*/
function outcomeOf(process) {
	const detail = process.signal !== null ? `signal: ${process.signal}` : process.exitCode !== null ? `exit code: ${process.exitCode}` : void 0;
	const status = process.status === "killed" ? "killed" : process.status === "completed" ? "completed" : "failed";
	return detail === void 0 ? { status } : {
		status,
		detail
	};
}
/**
* Render one consuming output read as the string the registry hands to
* `job_output`. The delta is the payload; a lossy read and any full-stream spill
* files are named, because the consumer cannot see them otherwise.
* @param read - the shell provider's incremental read.
* @returns the text for this read.
*/
function renderRead(read) {
	const parts = [read.delta];
	if (read.lossy) parts.push("[output truncated: unread bytes were dropped]");
	if (read.stdoutSpillPath !== void 0) parts.push(`[full stdout: ${read.stdoutSpillPath}]`);
	if (read.stderrSpillPath !== void 0) parts.push(`[full stderr: ${read.stderrSpillPath}]`);
	return parts.filter((part) => part !== "").join("\n");
}
/**
* Register the world's background-bash producer.
*
* The tool returns the registry's job id immediately; `job_output` reads the
* stream and `job_kill` cancels it, exactly as for the host's one-shot tool.
* @param ctx - plugin context; registrations are effects scoped to it.
* @param config - plugin configuration; a row without a `config:` block mounts
*   this plugin with none, and {@link DEFAULTS} then supplies every knob.
*/
/**
* Start one tracked background job and return its id.
*
* Exported because the session `bash` tool accepts `run_in_background: true` and has to hand the call
* to *this* producer rather than grow a second one — two registrations of a background bash would
* give `job_list` two shapes of job and `job_output` two ways to be wrong.
*
* The job runs in its own process, not in the persistent shell: it therefore does not inherit a `cd`
* or an `export` from earlier `bash` calls, which is what the tool descriptions say.
*
* @param ctx - the host context, providing `jobs`, `shell` and `shellEnv`.
* @param args - the command, an optional working directory, and the caller's `stdin` text when the
*   call brought one (the one-shot executor accepts it on the resolved spec, so a backgrounded
*   command is fed the same way a foreground one is).
* @param exec - the tool execution, whose agent owns the job.
* @returns the registry job id.
*/
function startBackgroundJob(ctx, args, exec) {
	const jobs = ctx.get("jobs");
	if (jobs === void 0) throw new Error("background jobs unavailable: this deployment mounts no jobs registry (load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs)");
	const shell = ctx.get("shell");
	if (shell === void 0 || typeof shell.start !== "function" || typeof shell.resolve !== "function") throw new Error("background jobs unavailable: the WSL world provides no shell with background support");
	if (exec.signal?.aborted === true) {
		const error = /* @__PURE__ */ new Error("tool call aborted");
		error.name = "AbortError";
		throw error;
	}
	const shellEnv = ctx.get("shellEnv");
	const dshEnv = typeof shellEnv?.collect === "function" ? shellEnv.collect(exec) : void 0;
	const workdir = args.workdir ?? exec.agent?.session?.header?.cwd;
	const request = {
		command: args.command,
		onExpiry: "none",
		...workdir === void 0 ? {} : { workdir },
		...args.stdin === void 0 ? {} : { stdin: args.stdin },
		...dshEnv === void 0 ? {} : { dshEnv }
	};
	let proc;
	const readStream = (which) => (from) => {
		const reader = proc?.observed[which];
		if (reader === void 0) return {
			text: "",
			nextOffset: from,
			lossy: false
		};
		return reader.readFrom(from);
	};
	const jobId = jobs.start({
		kind: "bash",
		label: args.command,
		...ownerOf(jobs, exec.agent),
		output: [{ read: readStream("stdout") }, {
			channel: "stderr",
			read: readStream("stderr")
		}],
		run: () => {
			const process = shell.start(shell.resolve(request));
			proc = process;
			return {
				cancel: () => {
					process.kill();
				},
				done: process.done.then(() => outcomeOf(process)),
				readOutput: () => renderRead(process.readOutput())
			};
		}
	});
	return { jobId: String(jobId) };
}
function apply(ctx, config) {
	const resolved = {
		...DEFAULTS,
		...config === void 0 ? {} : config
	};
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const tool = defineTool({
		name: TOOL_NAME,
		description: "Run one command in the background inside this WSL distribution and return a job id immediately. Read its output with job_output and stop it with job_kill. It is the same producer the `bash` tool’s `run_in_background: true` argument uses, so a job started either way appears in `job_list`; neither one runs inside the persistent shell, so a job does not see a `cd` or `export` made by an earlier `bash` call.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The bash command to run in the background."
			},
			workdir: {
				type: "string",
				description: "Linux working directory for the command. Defaults to the session workspace; a relative path resolves against it."
			}
		},
		timeoutMs: resolved.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { jobId: {
					type: "string",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: `started background job ${value.jobId}`
			}]
		},
		async execute(args, exec) {
			return startBackgroundJob(ctx, args, exec);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Bash (background) ${args.command}`,
			kind: "execute",
			rawInput: args.command
		})
	});
	tools.register(tool);
}
//#endregion
export { Config, TOOL_NAME, apply, apply as default, inject, outcomeOf, ownerOf, renderRead, startBackgroundJob };

//# sourceMappingURL=wsl-jobs.js.map