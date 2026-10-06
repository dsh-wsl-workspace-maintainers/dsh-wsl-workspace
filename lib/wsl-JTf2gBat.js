import { execFile, execFileSync } from "node:child_process";
//#region src/shared/wsl.ts
/**
* WSL discovery helpers (host side): enumerate installed distributions
* through `wsl.exe -l -q` and read the default distribution from the Lxss
* registry key. `wsl.exe` output is UTF-16LE on most builds, so decoding
* sniffs for NUL bytes before choosing an encoding.
* @module dsh-wsl-workspace/shared/wsl
*/
/** Executable timeout for the short discovery calls. */
const DISCOVERY_TIMEOUT_MS = 1e4;
const LXSS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
/** Human text for an unknown rejection. */
function messageOf(value) {
	return value instanceof Error ? value.message : String(value);
}
/**
* Run `execFile` through its callback API and resolve `{ stdout, stderr }`.
*
* `util.promisify(execFile)` only resolves that object because `execFile`
* carries `util.promisify.custom`. A host that replaces
* `child_process.execFile` with a plain wrapper loses that metadata, and
* `promisify` then falls back to "resolve the first callback value" — which is
* stdout itself, so `result.stdout` is `undefined` (issue #35: DSH Desktop
* injects `windowsHide: true` that way, and `listDistros()` died with
* `Cannot read properties of undefined (reading 'includes')`).
*
* The callback form is what every such wrapper preserves, so this does not
* depend on how the host patched the module.
* @param file - the executable.
* @param args - its arguments.
* @param options - `execFile` options, including the requested encoding.
* @returns both streams; the caller narrows them by the encoding it asked for.
*/
function execFileResult(file, args, options) {
	return new Promise((settle, fail) => {
		execFile(file, [...args], options, (error, stdout, stderr) => {
			if (error !== null && error !== void 0) {
				fail(error);
				return;
			}
			settle({
				stdout,
				stderr
			});
		});
	});
}
/** Read a captured stream as text, whichever way the encoding arrived. */
function textOf(stream) {
	return typeof stream === "string" ? stream : stream.toString("utf8");
}
/**
* The `wsl.exe` spellings to try, in order.
*
* The bare name relies on `PATH`. A host whose `PATH` omits `System32` can run
* every other part of this plugin — `listDir`/`check` go through the
* `\\wsl.localhost\…` share and never spawn anything — while `listDistros`
* reports that WSL is missing, which is what issue #36 describes. The
* absolute fallback removes that failure mode.
* @param wslPath - the configured executable.
* @returns the candidates, without duplicates.
*/
function wslExecutableCandidates(wslPath) {
	if (wslPath !== "wsl.exe") return [wslPath];
	const root = process.env.SystemRoot ?? process.env.windir;
	if (root === void 0 || root === "") return [wslPath];
	return [wslPath, `${root.replace(/[\\/]+$/, "")}\\System32\\wsl.exe`];
}
/**
* Decode `wsl.exe -l -q` output. Newer builds emit UTF-8; most emit UTF-16LE
* with NUL bytes interleaved — the NUL probe picks the right one. A host that
* handed back something other than the captured stream is reported as such
* instead of throwing `Cannot read properties of undefined`.
* @param buffer - the raw captured output.
* @returns the decoded text.
*/
function decodeWslOutput(buffer) {
	if (typeof buffer === "string") return buffer;
	if (!(buffer instanceof Uint8Array)) throw new Error(`wsl-workspace: expected captured output, got ${typeof buffer}`);
	return buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
}
/**
* List installed WSL distributions in `wsl.exe` order.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns distribution names, blank lines dropped.
*/
async function listDistros(wslPath = "wsl.exe") {
	const candidates = wslExecutableCandidates(wslPath);
	let stdout;
	let lastError;
	for (const candidate of candidates) try {
		stdout = (await execFileResult(candidate, ["-l", "-q"], {
			encoding: "buffer",
			timeout: DISCOVERY_TIMEOUT_MS
		})).stdout;
		break;
	} catch (error) {
		lastError = error;
	}
	if (stdout === void 0) throw new Error(`wsl-workspace: cannot list WSL distributions (tried ${candidates.join(" and ")}: ${messageOf(lastError)}); is WSL installed?`);
	return decodeWslOutput(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
/**
* Read the user's default distribution from the Lxss registry. Non-fatal:
* returns `undefined` when the value is absent or unreadable (the caller
* falls back to list order).
* @returns the default distribution name, or `undefined`.
*/
async function defaultDistro() {
	try {
		const value = await execFileResult("reg.exe", [
			"query",
			LXSS_KEY,
			"/v",
			"DefaultDistribution"
		], { timeout: DISCOVERY_TIMEOUT_MS });
		const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(textOf(value.stdout))?.[1];
		if (guid === void 0) return void 0;
		const name = await execFileResult("reg.exe", [
			"query",
			`${LXSS_KEY}\\${guid}`,
			"/v",
			"DistributionName"
		], { timeout: DISCOVERY_TIMEOUT_MS });
		const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(textOf(name.stdout))?.[1]?.trim();
		return distro === void 0 || distro === "" ? void 0 : distro;
	} catch {
		return;
	}
}
/** Module-level cache for {@link defaultDistroSync} (one registry read per process). */
let syncDefaultResolved = false;
let syncDefault;
/**
* Synchronous variant of {@link defaultDistro} for executors that must
* resolve a distribution inside a synchronous plan step. Cached after the
* first read; non-fatal (returns `undefined` when the registry is
* unreadable, letting the caller fail loud with its own message).
* @returns the default distribution name, or `undefined`.
*/
function defaultDistroSync() {
	if (syncDefaultResolved) return syncDefault;
	syncDefaultResolved = true;
	try {
		const value = execFileSync("reg.exe", [
			"query",
			LXSS_KEY,
			"/v",
			"DefaultDistribution"
		], { timeout: DISCOVERY_TIMEOUT_MS });
		const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(String(value))?.[1];
		if (guid === void 0) return void 0;
		const name = execFileSync("reg.exe", [
			"query",
			`${LXSS_KEY}\\${guid}`,
			"/v",
			"DistributionName"
		], { timeout: DISCOVERY_TIMEOUT_MS });
		const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(String(name))?.[1]?.trim();
		syncDefault = distro === void 0 || distro === "" ? void 0 : distro;
	} catch {
		syncDefault = void 0;
	}
	return syncDefault;
}
//#endregion
export { textOf as a, listDistros as i, defaultDistroSync as n, wslExecutableCandidates as o, execFileResult as r, defaultDistro as t };

//# sourceMappingURL=wsl-JTf2gBat.js.map