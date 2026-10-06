//#region src/shared/paths.ts
/** The two UNC hosts WSL exposes a distribution's filesystem under. */
const UNC_HOSTS = ["wsl.localhost", "wsl$"];
/**
* Parse a WSL UNC path into its distro and Linux path. Accepts the WSL2
* `\\wsl.localhost\<distro>\<linux>` form, the legacy `\\wsl$\<distro>\<linux>`
* interop form, and forward-slash spellings of either.
* @param raw - candidate absolute path.
* @returns the parsed target, or null when the path is not a WSL UNC.
*/
function parseWslUnc(raw) {
	const normalized = raw.replace(/\\/g, "/").replace(/\/\/+/g, "//");
	if (!normalized.startsWith("//")) return null;
	const segments = normalized.slice(2).split("/");
	const host = (segments[0] ?? "").toLowerCase();
	if (!UNC_HOSTS.includes(host)) return null;
	const distro = segments[1] ?? "";
	if (distro === "") return null;
	return {
		distro,
		linuxPath: `/${segments.slice(2).filter((segment) => segment.length > 0).join("/")}`
	};
}
/**
* Translate a WSL UNC path to the absolute Linux path a process inside the
* distribution can open. Throws on non-WSL input: callers rely on this
* conversion to hand paths to the Linux world, so a silent pass-through
* would hand a Windows path to bash.
* @param uncPath - a path {@link parseWslUnc} accepts.
* @returns the absolute Linux path.
*/
function uncToLinux(uncPath) {
	const parts = parseWslUnc(uncPath);
	if (parts === null) throw new Error(`wsl-workspace: "${uncPath}" is not a WSL UNC path`);
	return parts.linuxPath;
}
/**
* Normalize a Linux absolute path for the Host: collapse repeated slashes and
* strip a trailing slash (root becomes `/`).
* @param path - absolute Linux path.
* @returns the normalized path.
*/
function normalizeLinuxPath(path) {
	const collapsed = path.replace(/\/+/g, "/");
	return collapsed === "/" ? "/" : collapsed.replace(/\/$/, "");
}
/**
* Whether a path is an absolute, non-empty Linux path.
* @param path - candidate.
* @returns whether it starts with `/` and contains no NUL.
*/
function isAbsoluteLinuxPath(path) {
	return path.startsWith("/") && !path.includes("\0");
}
/**
* Join a distro and a Linux absolute path into the WSL2 UNC form used as the
* workspace identity (`\\wsl.localhost\<distro>\<linux>`, backslash segments).
* @param distro - distro name.
* @param linuxPath - absolute Linux path (leading `/`).
* @returns the UNC path.
*/
function joinUnc(distro, linuxPath) {
	if (!isAbsoluteLinuxPath(linuxPath)) throw new Error(`wsl-workspace: cannot map a non-absolute Linux path "${linuxPath}" to UNC`);
	if (distro === "" || distro === "." || distro === ".." || /[\\/]/.test(distro)) throw new Error(`wsl-workspace: invalid distribution name "${distro}"`);
	const normalized = linuxPath.replace(/\/+/g, "/").replace(/\/$/, "");
	const windowsSegments = (normalized.startsWith("/") ? normalized.slice(1) : normalized).replace(/\//g, "\\");
	return `\\\\wsl.localhost\\${distro}${windowsSegments === "" ? "" : `\\${windowsSegments}`}`;
}
/**
* Translate a Windows drive path to the drvfs mount path WSL distributions
* conventionally expose it at (`C:\foo` → `/mnt/c/foo`). Only single-letter
* drives under `/mnt` are mapped; custom mount points are out of scope.
* @param path - the candidate Windows path.
* @returns the `/mnt/<drive>/…` path, or `null` for non-drive paths.
*/
function windowsToMntPath(path) {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
	if (match === null) return null;
	const rest = (match[2] ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
	return `/mnt/${(match[1] ?? "").toLowerCase()}${rest === "" ? "" : `/${rest}`}`;
}
/**
* Translate a `/mnt/<drive>/…` path back to its Windows drive path.
* @param linuxPath - the candidate Linux path.
* @returns the `X:\…` drive path, or `null` when the path is not a drvfs mount.
*/
function mntToWindowsPath(linuxPath) {
	const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(linuxPath);
	if (match === null) return null;
	const rest = (match[2] ?? "").replace(/\//g, "\\");
	return `${(match[1] ?? "").toUpperCase()}:\\${rest}`;
}
/**
* Canonical Windows drive path for store keys and cross-realm identity:
* separators unified to `\`, trailing separator stripped, and the WHOLE path
* lowercased — Windows paths compare case-insensitively, and the workspace
* registry may realpath a different casing than the caller spelled (8.3 or
* on-disk casing), so the store key must collide across casings.
* @param path - candidate Windows drive path.
* @returns the canonical form, or `null` when not drive-shaped.
*/
function canonicalWindowsPath(path) {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
	if (match === null) return null;
	const rest = (match[2] ?? "").replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
	return `${(match[1] ?? "").toLowerCase()}:\\${rest}`;
}
/**
* True when a value is a Windows-shaped path (drive or UNC), which is how
* the shell executor decides the WSLENV `/p` translation flag: only Windows
* path values need translation when they cross into the Linux process.
* @param value - the environment value to classify.
* @returns whether the value looks like a Windows path.
*/
function isWindowsPathShaped(value) {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
/** Linux username shape for `wsl.exe -u`: starts with a letter or underscore, then letters/digits/`_`/`.`/`-` (max 64). */
const WSL_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/**
* Whether a value is a safe Linux username for `wsl.exe -u`. The check is
* strict on purpose: a value starting with `-` could be parsed as a wsl.exe
* option instead of a username.
* @param value - candidate username.
* @returns whether it matches the Linux username shape.
*/
function isValidWslUsername(value) {
	return WSL_USERNAME_PATTERN.test(value);
}
//#endregion
export { joinUnc as a, parseWslUnc as c, isWindowsPathShaped as i, uncToLinux as l, isAbsoluteLinuxPath as n, mntToWindowsPath as o, isValidWslUsername as r, normalizeLinuxPath as s, canonicalWindowsPath as t, windowsToMntPath as u };

//# sourceMappingURL=paths-CkIGMcuV.js.map