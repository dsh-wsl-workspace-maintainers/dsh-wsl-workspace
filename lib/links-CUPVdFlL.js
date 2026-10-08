import { a as joinUnc, c as parseWslUnc, n as isAbsoluteLinuxPath } from "./paths-CkIGMcuV.js";
import { i as execFileResult, o as textOf, s as wslExecutableCandidates } from "./wsl-BS2zmAnQ.js";
/** How long the distribution may take to answer one `readlink` call. */
const LINK_RESOLVE_TIMEOUT_MS = 1e4;
/**
* Resolve Linux symlinks through the distribution that owns them.
*
* Never throws: a link the distribution cannot resolve (a missing component, a
* stopped distribution, a `readlink` that fails) stays unresolved, and callers
* keep whatever behaviour they had before this fallback existed.
*
* @param uncPaths - the links to resolve, in UNC spelling.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns one entry per input, in order: the resolved real path as a UNC
*   path, or `undefined` when the link or the distribution could not answer.
*/
async function resolveLinuxSymlinks(uncPaths, wslPath = "wsl.exe") {
	const resolved = uncPaths.map(() => void 0);
	let next = 0;
	const workers = Array.from({ length: Math.min(4, uncPaths.length) }, async () => {
		for (let index = next; index < uncPaths.length; index = next) {
			next += 1;
			resolved[index] = await resolveLinuxSymlink(uncPaths[index] ?? "", wslPath);
		}
	});
	await Promise.all(workers);
	return resolved;
}
/**
* Resolve one Linux symlink the share cannot follow.
* @param uncPath - the link, in UNC spelling.
* @param wslPath - the `wsl.exe` executable (absolute or PATH name).
* @returns the real path as a UNC path, or `undefined` when it does not resolve.
*/
async function resolveLinuxSymlink(uncPath, wslPath = "wsl.exe") {
	const unc = parseWslUnc(uncPath);
	if (unc === null || /[\r\n]/.test(unc.linuxPath)) return void 0;
	try {
		for (const candidate of wslExecutableCandidates(wslPath)) try {
			const output = await execFileResult(candidate, [
				"-d",
				unc.distro,
				"--",
				"readlink",
				"-f",
				unc.linuxPath
			], {
				encoding: "utf8",
				timeout: LINK_RESOLVE_TIMEOUT_MS,
				windowsHide: true
			});
			const target = textOf(output.stdout).trim();
			return isAbsoluteLinuxPath(target) ? joinUnc(unc.distro, target) : void 0;
		} catch {}
		return;
	} catch {
		return;
	}
}
//#endregion
export { resolveLinuxSymlinks as n, resolveLinuxSymlink as t };

//# sourceMappingURL=links-CUPVdFlL.js.map