import { a as joinUnc, c as parseWslUnc, i as isWindowsPathShaped, r as isValidWslUsername, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { r as getWorkspaceUsername } from "./wsl-credentials-DzKgEzy7.js";
import { r as defaultDistroSync } from "./wsl-BS2zmAnQ.js";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
//#region src/shell.ts
/**
* Model-friendly environment overrides (same set `dsh-bash-local` hardcodes):
* disable colors, pagers, and interactive terminal features that would garble
* tool output. These values cross into the Linux process through WSLENV.
*/
const ENV_OVERRIDES = {
	NO_COLOR: "1",
	TERM: "dumb",
	PAGER: "cat",
	GIT_PAGER: "cat"
};
/** Default SIGTERM→SIGKILL grace period (matches `dsh-bash-local`). */
const DEFAULT_GRACE_MS = 3e3;
/** Default per-stream spill cap (matches `dsh-bash-local`). */
const DEFAULT_MAX_SPILL_BYTES = 67108864;
/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader) {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...read.spillPath !== void 0 ? { spillPath: read.spillPath } : {}
	};
}
function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`wsl-shell: ${name} must be a positive finite number`);
}
/**
* Reject a resolved configuration this executor could not run with, so a
* stored value is refused where it is written instead of failing at the next
* command.
* @param config - the schema-validated configuration.
* @throws Error naming the field that cannot be used.
*/
function assertServiceableWslConfig(config) {
	const resolved = config;
	assertPositiveFinite("timeoutMs", resolved.timeoutMs);
	assertPositiveFinite("maxTimeoutMs", resolved.maxTimeoutMs);
	assertPositiveFinite("maxOutputBytes", resolved.maxOutputBytes);
	assertPositiveFinite("maxSpillBytes", resolved.maxSpillBytes);
	assertPositiveFinite("graceMs", resolved.graceMs);
	if (resolved.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`wsl-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	if (resolved.distro !== void 0 && resolved.distro.trim() === "") throw new Error("wsl-shell: distro must be a non-empty distribution name");
	if (resolved.username !== void 0 && resolved.username !== "" && !isValidWslUsername(resolved.username)) throw new Error("wsl-shell: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
}
/**
* WSL bash executor over the LOCAL subprocess service: `wsl.exe` is a Windows
* executable, so the Windows-side spawn, bounded output, spill files, and
* process-group termination are the local subprocess seam's mechanics; this
* executor supplies the Linux-world argv, cwd translation, and WSLENV.
*/
var WslShellExecutor = class WslShellExecutor extends ShellExecutor {
	static inject = ["subprocess"];
	static Config = z.object({
		cwd: z.string(),
		distro: z.string(),
		username: z.string(),
		wslPath: z.string().default("wsl.exe"),
		loginShell: z.boolean().default(true),
		timeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		maxOutputBytes: z.number().default(64e3),
		maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
		graceMs: z.number().default(DEFAULT_GRACE_MS)
	});
	resolved;
	/** Validated config (schemastery applied the defaults before construction). */
	get config() {
		return this.resolved;
	}
	constructor(ctx, config) {
		super(ctx);
		const entry = config;
		assertServiceableWslConfig(entry);
		this.resolved = entry;
	}
	/**
	* Resolve a request into a fully-specified spec: fill `workdir` from
	* `config.cwd`, and `timeoutMs` from `config.timeoutMs`, capped at
	* `config.maxTimeoutMs`. The tool layer calls this before
	* {@link execute}/{@link run}/{@link start}, so those methods receive explicit
	* values. `onExpiry` is defaulted to `'kill'`; a background producer that must
	* outlive `timeoutMs` resolves it to `'none'` instead.
	*/
	resolve(request) {
		const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, "wsl-shell: request.timeoutMs");
		const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes;
		assertPositiveFinite("request.stdoutMaxBytes", stdoutMaxBytes);
		return {
			command: request.command,
			workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
			timeoutMs,
			onExpiry: request.onExpiry ?? "kill",
			stdoutMaxBytes,
			...request.signal ? { signal: request.signal } : {},
			...request.stdin !== void 0 ? { stdin: request.stdin } : {},
			...request.env !== void 0 ? { env: request.env } : {},
			...request.dshEnv !== void 0 ? { dshEnv: request.dshEnv } : {},
			sandboxPolicy: request.sandboxPolicy
		};
	}
	/**
	* Execute a resolved spec and return the live handle with its foreground
	* projection. This is the seam shape the 0.2.x host calls —
	* `await (await ctx.shell.execute(ctx.shell.resolve(request))).result()` — and
	* a background caller uses the same handle's `readOutput`/`observed`/`kill`
	* without ever calling {@link ShellExecution.result}, so it never observes that
	* projection's rejection either.
	* @param spec - the resolved execution spec.
	* @returns the live execution handle.
	*/
	async execute(spec) {
		return this.spawnExecution(spec);
	}
	/**
	* Translate a resolved spec into the Linux execution plan. Fails loud on a
	* workdir that names neither the WSL world (UNC or Linux path) nor a
	* Windows drive path (reached through `/mnt/<drive>`).
	* @param spec - the resolved execution spec.
	* @returns the translated plan, including the complete argv.
	*/
	plan(spec) {
		const workdir = spec.workdir;
		let distro;
		let linuxCwd;
		let windowsCwd;
		let username;
		const unc = parseWslUnc(workdir);
		if (unc !== null) {
			distro = unc.distro;
			linuxCwd = unc.linuxPath;
			windowsCwd = process.env.SystemRoot ?? process.cwd();
			username = this.resolveUser(spec, joinUnc(unc.distro, unc.linuxPath));
		} else if (workdir.startsWith("/")) {
			distro = this.resolveDistro(spec);
			linuxCwd = workdir;
			windowsCwd = process.cwd();
			username = this.resolveUser(spec, void 0);
		} else {
			const mnt = windowsToMntPath(workdir);
			if (mnt === null) throw new Error(`wsl-shell: workdir "${workdir}" is not in the WSL execution world`);
			distro = this.resolveDistro(spec);
			linuxCwd = mnt;
			windowsCwd = workdir;
			username = this.resolveUser(spec, void 0);
		}
		const env = this.withWslEnv(spec);
		const command = this.config.loginShell ? `cd '${linuxCwd.replace(/'/g, `'\\''`)}' && ${spec.command}` : spec.command;
		const argv = [
			this.config.wslPath,
			"-d",
			distro,
			...username !== void 0 && username !== "" ? ["-u", username] : [],
			"--cd",
			linuxCwd,
			"-e",
			"bash",
			this.config.loginShell ? "-lc" : "-c",
			command
		];
		return {
			distro,
			linuxCwd,
			windowsCwd,
			env,
			argv
		};
	}
	/**
	* Resolve the distribution for a workdir that carries none. The chain:
	* the calling session's distribution (`DSH_WSL_DISTRO`, contributed by the
	* host half from the session's UNC workspace cwd — the common case for a
	* model passing a Linux `workdir`), then the configured `distro`, then the
	* host's default distribution (cached registry read) as a last resort for
	* plugin-driven calls with no session. Fails loud when every source is
	* absent rather than guessing a distro the path does not belong to.
	* @param spec - the resolved execution spec (its dshEnv carries the session fact).
	* @returns the distribution name.
	*/
	resolveDistro(spec) {
		const fromEnv = spec.dshEnv?.DSH_WSL_DISTRO;
		if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
		const configured = this.config.distro;
		if (configured !== void 0 && configured !== "") return configured;
		const fallback = defaultDistroSync();
		if (fallback !== void 0) return fallback;
		throw new Error("wsl-shell: Linux workdir carries no distribution; no session DSH_WSL_DISTRO, distro config, or default distribution is available");
	}
	/**
	* Resolve the Linux user bash runs as. The chain: the calling session's
	* workspace user (`DSH_WSL_USER`, contributed by the host half), then the
	* workspace's stored username when the workdir is a UNC path, then the
	* configured `username`. Absent everywhere, the distribution's default
	* user runs. Invalid values are skipped (they were validated on write;
	* the guard is defense in depth).
	* @param spec - the resolved execution spec (its dshEnv carries the session fact).
	* @param uncKey - canonical UNC key of the workdir when it is a UNC path.
	* @returns the username, or undefined for the distro default user.
	*/
	resolveUser(spec, uncKey) {
		const candidates = [
			spec.dshEnv?.DSH_WSL_USER,
			uncKey === void 0 ? void 0 : getWorkspaceUsername(uncKey),
			this.config.username
		];
		for (const candidate of candidates) if (candidate !== void 0 && candidate !== "" && isValidWslUsername(candidate)) return candidate;
	}
	/**
	* Merge the caller env layers and inject `WSLENV` so the Windows-side
	* values reach the Linux process. Windows-path-shaped values get the `/p`
	* translation flag (they become `/mnt/<drive>/…` inside WSL); the ambient
	* `WSLENV` value is preserved and extended.
	* @param spec - the resolved execution spec.
	* @returns the explicit environment map for the spawn.
	*/
	withWslEnv(spec) {
		const env = {
			...ENV_OVERRIDES,
			...spec.env,
			...spec.dshEnv
		};
		const flags = [];
		for (const [key, value] of Object.entries(env)) {
			if (key.toUpperCase() === "WSLENV") continue;
			flags.push(isWindowsPathShaped(value) ? `${key}/p` : key);
		}
		env.WSLENV = [process.env.WSLENV, flags.join(":")].filter((part) => part !== void 0 && part !== "").join(":");
		return env;
	}
	/** Map a plan onto a fully-specified subprocess spawn. */
	spawnSpec(plan, spec, stdoutMaxBytes, signal) {
		const collect = (maxBytes) => ({
			maxBytes,
			spill: { maxBytes: this.config.maxSpillBytes }
		});
		return {
			argv: plan.argv,
			cwd: plan.windowsCwd,
			stdio: {
				stdin: spec.stdin !== void 0 ? { data: spec.stdin } : "ignore",
				stdout: collect(stdoutMaxBytes),
				stderr: collect(this.config.maxOutputBytes)
			},
			graceMs: this.config.graceMs,
			signal,
			env: plan.env
		};
	}
	/** The collect-mode readers this executor requested (present by construction). */
	static collected(handle) {
		const { stdout, stderr } = handle.collected;
		/* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
		if (stdout === void 0 || stderr === void 0) throw new Error("wsl-shell: subprocess implementation dropped a requested collect stream");
		/* v8 ignore stop */
		return {
			stdout,
			stderr
		};
	}
	/**
	* Run one command in the foreground and return its settled result. Kept
	* because 0.1.x hosts and this plugin's own checks call it; on 0.2.x the host
	* goes through {@link execute}, so both faces must stay in step — which they
	* do by construction, since this is one line on top of that primitive.
	*/
	async run(spec) {
		return this.spawnExecution(spec).result();
	}
	/**
	* Start one command in the background and return its live handle. The host's
	* background producers (and this plugin's `job_*` tools, via
	* `src/host/wsl-jobs.ts`) resolve their request with `onExpiry: 'none'`, which
	* is what leaves `timeoutMs` unarmed here; the deadline policy lives in the
	* spec, not in this method.
	*/
	start(spec) {
		return this.spawnExecution(spec);
	}
	/**
	* The seam's only primitive: translate the spec, arm the deadline the spec
	* asks for, spawn, and hand back the live handle.
	*
	* `onExpiry: 'none'` arms nothing — the caller's signal and {@link
	* ShellProcess.kill} are then the only ways to stop the command, and
	* `timeoutMs` is merely echoed into the result. Otherwise one fused deadline
	* drives both the timeout and the caller's cancellation, so
	* {@link ShellRunResult.timedOut} and `aborted` report the single first cause
	* rather than both.
	*
	* The handle's `done` never rejects: a spawn that never produced a process
	* settles as `killed` and leaves its story on the read path, while
	* {@link ShellExecution.result} rejects for exactly that infrastructure
	* failure. Nonzero exits, timeout kills, and abort kills all resolve.
	* @param spec - the resolved execution spec.
	* @returns the live execution handle, foreground-projectionable.
	*/
	spawnExecution(spec) {
		const plan = this.plan(spec);
		const armed = spec.onExpiry === "none" ? void 0 : deadline(spec.signal, spec.timeoutMs, "WSL_BASH_TIMEOUT");
		const release = () => armed?.[Symbol.dispose]();
		let running;
		try {
			running = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, spec.stdoutMaxBytes, armed?.signal ?? spec.signal));
		} catch (error) {
			release();
			throw error;
		}
		const collected = WslShellExecutor.collected(running);
		const settled = running.done.then((outcome) => ({
			ok: true,
			outcome
		}), (error) => ({
			ok: false,
			error
		}));
		let spawnFailure;
		let failureNoted = false;
		const consumeSpawnFailure = () => {
			if (spawnFailure === void 0 || failureNoted) return "";
			failureNoted = true;
			return `spawn failed: ${String(spawnFailure)}`;
		};
		let stdoutOffset = 0;
		let stderrOffset = 0;
		let resultPromise;
		/**
		* The non-consuming observers `ShellProcess.observed` is required to carry.
		*
		* `observed` is **not optional** in the host's `ShellProcess` contract, and the host spells out
		* what it is for: "Independent observers read here at their own offsets without stealing bytes
		* from `readOutput`." `dsh-jobs-local@0.2.x` drains a job's ring through offset readers and never
		* calls `readOutput`, so a handle that offered only the latter shipped an empty `job_output`
		* (issue #56).
		*
		* The offsets are **not** `stdoutOffset` / `stderrOffset` above: those track the consuming
		* cursor, and sharing them would make the two readers steal bytes from each other. The host asks
		* for independence explicitly.
		*
		* A rejected spawn leaves the subprocess service with nothing buffered, so `readFrom` yields an
		* empty delta forever. The failure note is served as the **whole stderr stream** instead — once,
		* to whichever observer asks first — because a reader cannot be told "nothing happened, here is
		* why" any other way, and a job that never ran is exactly the case a user needs to see.
		*/
		let spawnFailureObserved = false;
		const readObserved = (which, from) => {
			const read = collected[which].readFrom(from);
			if (which === "stderr" && read.text.length === 0 && !spawnFailureObserved) {
				const note = consumeSpawnFailure();
				if (note !== "") return {
					text: note,
					nextOffset: note.length,
					lossy: false
				};
			}
			if (which === "stderr" && read.text.length > 0) spawnFailureObserved = true;
			return read;
		};
		const execution = {
			status: "running",
			exitCode: null,
			signal: null,
			done: settled.then((settledValue) => {
				release();
				if (!settledValue.ok) {
					spawnFailure = settledValue.error;
					execution.status = "killed";
					return;
				}
				if (execution.status === "running") execution.status = spec.signal?.aborted === true || settledValue.outcome.signal !== null ? "killed" : "completed";
				execution.exitCode = settledValue.outcome.exitCode;
				execution.signal = settledValue.outcome.signal;
			}),
			readOutput: () => {
				const out = collected.stdout.readFrom(stdoutOffset);
				const err = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = out.nextOffset;
				stderrOffset = err.nextOffset;
				const errText = err.text.length > 0 ? err.text : consumeSpawnFailure();
				const separator = out.text.length > 0 && !out.text.endsWith("\n") ? "\n" : "";
				return {
					delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
					lossy: out.lossy || err.lossy,
					...out.spillPath !== void 0 ? { stdoutSpillPath: out.spillPath } : {},
					...err.spillPath !== void 0 ? { stderrSpillPath: err.spillPath } : {}
				};
			},
			observed: {
				stdout: { readFrom: (from) => readObserved("stdout", from) },
				stderr: { readFrom: (from) => readObserved("stderr", from) }
			},
			kill: () => {
				if (execution.status !== "running") return false;
				execution.status = "killed";
				running.terminate();
				return true;
			},
			result: () => {
				if (resultPromise === void 0) resultPromise = settled.then((settledValue) => {
					if (!settledValue.ok) throw settledValue.error;
					const timedOut = armed !== void 0 && timeoutOf(armed.signal, "WSL_BASH_TIMEOUT") !== void 0;
					const aborted = armed?.signal.aborted === true && !timedOut;
					return {
						...settledValue.outcome,
						timedOut,
						aborted,
						timeoutMs: spec.timeoutMs,
						stdout: finalOutput(collected.stdout),
						stderr: finalOutput(collected.stderr)
					};
				});
				return resultPromise;
			}
		};
		return execution;
	}
};
//#endregion
export { WslShellExecutor, WslShellExecutor as default, assertServiceableWslConfig };

//# sourceMappingURL=shell.js.map