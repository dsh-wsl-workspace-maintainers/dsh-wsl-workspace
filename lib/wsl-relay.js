import { a as joinUnc, c as parseWslUnc, r as isValidWslUsername, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { n as getWindowsWorkspace, r as getWorkspaceUsername } from "./wsl-credentials-DzKgEzy7.js";
import { n as defaultDistroSync } from "./wsl-JTf2gBat.js";
import { i as bridgeReadiness, o as readinessReassertion } from "./wsl-env-sWOHjH2G.js";
import { spawn } from "node:child_process";
//#region src/host/wsl-relay.ts
/**
* Persistent-shell relay for WSL sessions.
*
* `@deepseek-ai/dsh-terminal-bash` is a config-driven PTY backend: the world
* decides `shellPath`/`shellArgs`, and the backend spawns that command with the
* session's cwd — which for a WSL session is a `\\wsl.localhost\…` path this
* Windows side can hand to a process. This script *is* that command: it reads
* the coordinates the preset cannot know (the distribution and optional user
* come from the session, not from the mode), then hands its own stdio — the
* PTY — to `wsl.exe`, so the model gets a stateful shell inside the
* distribution instead of one process per call.
*
* The inner shell is started as `bash -lc '<cd …> && <re-assert the contract> && exec bash -i'`:
* the login pass loads `/etc/profile` and the user profile (PATH and friends), and the
* interactive shell that replaces it keeps the session directory. A plain
* `bash -l` can be sent to `$HOME` by a profile — that is why the one-shot
* executor in `src/shell.ts` prefixes an explicit `cd` too. The re-assertion is in the
* middle because the login pass is where a distribution can take the prompt contract away:
* see {@link readinessReassertion}.
*
* Resolution mirrors that executor: the UNC cwd names its distribution, else
* `DSH_WSL_DISTRO` (the per-session fact this plugin publishes, normally absent here
* because the host scrubs it — see {@link resolveUser}), else the workspace's stored
* distribution, else the host's default; `DSH_WSL_USER`, else the workspace's stored
* user, selects `wsl.exe -u`. Every failure is reported on stderr and exits non-zero,
* so a broken shell surfaces instead of leaving a silent dead terminal.
*
* The spawn environment is not simply inherited. WSL imports a Windows variable
* into a distribution only when `WSLENV` names it, and the host injects its bash
* readiness contract as ordinary Windows variables — so an inherited environment
* starts a shell whose prompt the host can never recognise, which is the failure
* issue #51 reported as a session that never settles. `bridgeReadiness` names the
* keys the host actually set and leaves everything else alone.
*
* @module dsh-wsl-workspace/host/wsl-relay
*/
/** Shell signals whose arrival means this relay should take the shell down. */
const FORWARDED_SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGHUP",
	"SIGBREAK"
];
/** POSIX single-quote a path so the `cd` command reaches bash as one word. */
function quote(path) {
	return `'${path.replace(/'/g, `'\\''`)}'`;
}
/** Fail loudly: the PTY has no other way to tell the model what went wrong. */
function fail(message) {
	console.error(`dsh-wsl-workspace: ${message}`);
	process.exit(1);
}
/** The distribution this shell belongs to. */
function resolveDistro(uncDistro, storedDistro) {
	if (uncDistro !== void 0 && uncDistro !== "") return uncDistro;
	const fromEnv = process.env.DSH_WSL_DISTRO;
	if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
	if (storedDistro !== void 0 && storedDistro !== "") return storedDistro;
	const fallback = defaultDistroSync();
	if (fallback !== void 0 && fallback !== "") return fallback;
	return fail("persistent shell: the session cwd carries no distribution, DSH_WSL_DISTRO is unset and no WSL default is readable");
}
/**
* The Linux user this shell runs as, when one is configured and safe for `wsl.exe -u`.
*
* The environment is read first because it is the more immediate statement of intent, but it
* is normally empty: the host builds this child's environment itself, and its
* `scrubbedParentEnv()` drops every `DSH_*` variable, so the per-session fact the plugin
* publishes never arrives here. What does survive is the workspace store the dialog writes —
* the same file the one-shot executor and the session `bash` read — and it is keyed by the
* very cwd this relay was started in. Measured 2026-10-06 under the real backend: with only
* the environment consulted, a PTY shell came up as the distribution's default user even
* when the workspace named another one.
* @param storedUser - the username stored for this workspace, if any.
* @returns the username, or undefined for the distribution default user.
*/
function resolveUser(storedUser) {
	const fromEnv = process.env.DSH_WSL_USER;
	const user = fromEnv !== void 0 && fromEnv !== "" ? fromEnv : storedUser;
	if (user === void 0 || user === "") return void 0;
	if (!isValidWslUsername(user)) fail(`persistent shell: refusing the malformed username "${user}"`);
	return user;
}
/**
* The workspace coordinates this cwd has a stored entry for, if any.
*
* A UNC cwd names its distribution itself and only carries a user; a Windows-drive cwd
* (`/mnt/<drive>` workspace) names neither, so both come from the entry the dialog wrote.
* An absent entry is an empty answer, never a guess.
* @param cwd - this process's working directory.
* @param unc - the parsed UNC form of that cwd, when it is one.
* @returns the stored username and/or distribution.
*/
function storedCoordinates(cwd, unc) {
	if (unc !== null) {
		const username = getWorkspaceUsername(joinUnc(unc.distro, unc.linuxPath));
		return username === void 0 ? {} : { username };
	}
	const entry = getWindowsWorkspace(cwd);
	if (entry === void 0) return {};
	return {
		...entry.username === void 0 ? {} : { username: entry.username },
		...entry.distro === void 0 ? {} : { distro: entry.distro }
	};
}
const cwd = process.cwd();
const unc = parseWslUnc(cwd);
const stored = storedCoordinates(cwd, unc);
const distro = resolveDistro(unc?.distro, stored.distro);
const user = resolveUser(stored.username);
const linuxCwd = unc !== null ? unc.linuxPath : windowsToMntPath(cwd) ?? void 0;
const env = bridgeReadiness(process.env);
const command = [
	...linuxCwd === void 0 ? [] : [`cd ${quote(linuxCwd)}`],
	...env["__DSH_READINESS_PROMPT_COMMAND"] === void 0 ? [] : [readinessReassertion()],
	"exec bash -i"
].join(" && ");
const argv = [
	"wsl.exe",
	"-d",
	distro,
	...user === void 0 ? [] : ["-u", user],
	"--cd",
	cwd,
	"-e",
	"bash",
	"-lc",
	command
];
const child = spawn(argv[0] ?? "wsl.exe", argv.slice(1), {
	stdio: "inherit",
	env
});
child.on("error", (error) => fail(`persistent shell: cannot start ${argv[0] ?? "wsl.exe"} (${error.message})`));
child.on("exit", (code, signal) => process.exit(signal === null ? code ?? 0 : 1));
for (const signal of FORWARDED_SIGNALS) process.on(signal, () => {
	if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
//#endregion
export {};

//# sourceMappingURL=wsl-relay.js.map