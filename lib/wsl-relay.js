import { g as windowsToMntPath, l as isValidWslUsername, m as parseWslUnc, n as defaultDistroSync } from "./wsl-Ckyi3g6C.js";
import { spawn } from "node:child_process";
//#region src/shared/wsl-env.ts
/**
* Carrying the host's readiness contract across the WSL boundary.
*
* WSL imports a Windows environment variable into a distribution only when that
* variable is named in `WSLENV`. `@deepseek-ai/dsh-terminal-bash` injects its bash
* readiness contract — `PS1` plus a `PROMPT_COMMAND` that emits the OSC `133;D;`
* marker and re-sets `PS1` — as ordinary Windows variables (its
* `childEnvironment()`, at `lib/index.js:935-955`), so a relay that spawns
* `wsl.exe` without naming them produces a shell whose prompt the host can never
* recognise. Measured on 2026-10-04 under a real ConPTY: with the keys present but
* unnamed, neither the marker nor the prompt literal reaches the wire; naming them
* in `WSLENV` makes both appear — and the inner `bash -lc` profile chain does not
* undo it, because the crossed `PROMPT_COMMAND` re-assigns `PS1` at every prompt.
*
* This is a pure function over the environment so it can be asserted offline: the
* relay module itself spawns `wsl.exe` at load time.
*
* @module dsh-wsl-workspace/shared/wsl-env
*/
/**
* The keys that carry the readiness contract. Prompt text, not paths, so none of
* them may get the `/p` translation flag — that would rewrite the value as a
* `/mnt/<drive>` path on the way in.
*/
const READINESS_KEYS = ["PS1", "PROMPT_COMMAND"];
/**
* The environment for `wsl.exe`, with the readiness keys named in `WSLENV`.
*
* Ambient `WSLENV` entries survive and are never duplicated; a key absent or empty
* in the environment is not named, so a host that injects no contract leaves the
* environment byte-identical to what it was (including having no `WSLENV` at all).
* @param env - the environment the relay process itself was started with.
* @returns a shallow copy with `WSLENV` merged, and `undefined` values dropped.
*/
function bridgeReadiness(env) {
	const merged = {};
	for (const [key, value] of Object.entries(env)) if (value !== void 0) merged[key] = value;
	const named = new Set((merged.WSLENV ?? "").split(":").filter((entry) => entry !== "").map((entry) => entry.replace(/\/[plu]$/, "")));
	const additions = READINESS_KEYS.filter((key) => !named.has(key) && merged[key] !== void 0 && merged[key] !== "");
	if (additions.length === 0) return merged;
	merged.WSLENV = [...(merged.WSLENV ?? "").split(":").filter((entry) => entry !== ""), ...additions].join(":");
	return merged;
}
//#endregion
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
* The inner shell is started as `bash -lc '<cd …> && exec bash -i'`: the login
* pass loads `/etc/profile` and the user profile (PATH and friends), and the
* interactive shell that replaces it keeps the session directory. A plain
* `bash -l` can be sent to `$HOME` by a profile — that is why the one-shot
* executor in `src/shell.ts` prefixes an explicit `cd` too.
*
* Resolution mirrors that executor: the UNC cwd names its distribution, else
* `DSH_WSL_DISTRO` (the per-session fact this plugin publishes), else the
* host's default distribution; `DSH_WSL_USER` selects `wsl.exe -u`. Every
* failure is reported on stderr and exits non-zero, so a broken shell surfaces
* instead of leaving a silent dead terminal.
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
function resolveDistro(uncDistro) {
	if (uncDistro !== void 0 && uncDistro !== "") return uncDistro;
	const fromEnv = process.env.DSH_WSL_DISTRO;
	if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
	const fallback = defaultDistroSync();
	if (fallback !== void 0 && fallback !== "") return fallback;
	return fail("persistent shell: the session cwd carries no distribution, DSH_WSL_DISTRO is unset and no WSL default is readable");
}
/** The workspace user, when one is configured and safe for `wsl.exe -u`. */
function resolveUser() {
	const user = process.env.DSH_WSL_USER;
	if (user === void 0 || user === "") return void 0;
	if (!isValidWslUsername(user)) fail(`persistent shell: refusing the malformed username "${user}"`);
	return user;
}
const cwd = process.cwd();
const unc = parseWslUnc(cwd);
const distro = resolveDistro(unc?.distro);
const user = resolveUser();
const linuxCwd = unc !== null ? unc.linuxPath : windowsToMntPath(cwd) ?? void 0;
const command = `${linuxCwd === void 0 ? "" : `cd ${quote(linuxCwd)} && `}exec bash -i`;
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
	env: bridgeReadiness(process.env)
});
child.on("error", (error) => fail(`persistent shell: cannot start ${argv[0] ?? "wsl.exe"} (${error.message})`));
child.on("exit", (code, signal) => process.exit(signal === null ? code ?? 0 : 1));
for (const signal of FORWARDED_SIGNALS) process.on(signal, () => {
	if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
//#endregion
export {};

//# sourceMappingURL=wsl-relay.js.map