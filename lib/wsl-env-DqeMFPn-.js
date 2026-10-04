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
* The prompt string the host compares the tail against. This is a COPY of a host
* constant, which is exactly the shape that rots silently — `scripts/check-host-prompt-parity.mjs`
* is the gate that compares it against the installed `@deepseek-ai/dsh-terminal-bash`
* and reddens on drift. Keep one declaration here; `scripts/compatibility/conpty-relay.mjs`
* and the boot-time readiness probe both read it rather than re-typing it.
*/
const CONTROLLED_PROMPT = "dsh> ";
/**
* The contract values as the host injects them: `CONTROLLED_PROMPT`, and the
* `PROMPT_COMMAND` that emits the OSC `133;D;` marker and re-assigns `PS1` at every
* prompt. Byte-for-byte the pair `dsh-terminal-bash` writes into its PTY children.
* @returns the two entries the backend expects to see in a bash child environment.
*/
function readinessContract() {
	return {
		PS1: CONTROLLED_PROMPT,
		PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`
	};
}
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
	return bridgeEnv(env, READINESS_KEYS);
}
/**
* The environment for `wsl.exe`, with an arbitrary set of keys named in `WSLENV`.
*
* Same rules as {@link bridgeReadiness}, which is this with the prompt keys: ambient entries
* survive and are never duplicated, and a key that is absent or empty is not named at all.
* @param env - the environment to bridge from.
* @param keys - the names that must reach the Linux process.
* @returns a shallow copy with `WSLENV` merged, and `undefined` values dropped.
*/
function bridgeEnv(env, keys) {
	const merged = {};
	for (const [key, value] of Object.entries(env)) if (value !== void 0) merged[key] = value;
	const named = new Set((merged.WSLENV ?? "").split(":").filter((entry) => entry !== "").map((entry) => entry.replace(/\/[plu]$/, "")));
	const additions = keys.filter((key) => !named.has(key) && merged[key] !== void 0 && merged[key] !== "");
	if (additions.length === 0) return merged;
	merged.WSLENV = [...(merged.WSLENV ?? "").split(":").filter((entry) => entry !== ""), ...additions].join(":");
	return merged;
}
//#endregion
export { readinessContract as i, bridgeEnv as n, bridgeReadiness as r, CONTROLLED_PROMPT as t };

//# sourceMappingURL=wsl-env-DqeMFPn-.js.map