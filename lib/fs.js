import { a as joinUnc, c as parseWslUnc, n as isAbsoluteLinuxPath, o as mntToWindowsPath, u as windowsToMntPath } from "./paths-CkIGMcuV.js";
import { r as defaultDistroSync } from "./wsl-BS2zmAnQ.js";
import { t as resolveLinuxSymlink } from "./links-CUPVdFlL.js";
import z from "@deepseek-ai/schemastery";
import { link, lstat, rename } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { FsError } from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
//#region src/fs.ts
/**
* The WSL filesystem backend. Identity keys are canonical UNC paths; the
* Linux form is derived on demand, so both worlds stay in sync across
* aliases and symlinks.
*/
var WslFileSystem = class WslFileSystem extends LocalFileSystem {
	static Config = z.object({
		cwd: z.string(),
		distro: z.string(),
		diffBasisMaxBytes: z.number().default(10485760)
	});
	distro;
	executionCwd = new AsyncLocalStorage();
	constructor(ctx, config) {
		super(ctx, config);
		this.distro = config.distro;
		ctx.on("tools/execute", (exec, next) => this.executionCwd.run(exec.agent?.session.header.cwd, next));
		this.internals = {
			linkFile: WslFileSystem.publishNoReplace,
			replaceFile: WslFileSystem.replaceOverWrite,
			copyFileDacl: WslFileSystem.skipDaclCopy
		};
	}
	/**
	* No-replace publication for filesystems without hard links. A real
	* collision (a concurrent external creator won) must still surface as the
	* original EEXIST so the guarded-create failure path classifies it; an
	* absent target falls back to rename, which on Windows publishes without
	* replacing anything. Safe against this backend's own writers because the
	* per-target lock serializes them.
	* @param tempPath - the staged file.
	* @param destPath - the destination to create.
	*/
	static async publishNoReplace(tempPath, destPath) {
		try {
			await link(tempPath, destPath);
			return;
		} catch (error) {
			let exists = false;
			try {
				await lstat(destPath);
				exists = true;
			} catch {}
			if (exists) throw error;
			await rename(tempPath, destPath);
		}
	}
	/**
	* Security-preserving replacement boundary: Windows rename replaces an
	* existing destination atomically; no DACL preservation is needed over 9P.
	* @param destPath - the file being replaced.
	* @param tempPath - the staged replacement.
	*/
	static async replaceOverWrite(destPath, tempPath) {
		await rename(tempPath, destPath);
	}
	/** 9P files inherit their directory's DACL; nothing to preserve. */
	static async skipDaclCopy() {}
	/** Translate a model/plugin path into Windows-side coordinates. */
	translate(path, cwd) {
		const unc = parseWslUnc(path);
		if (unc !== null) return {
			input: joinUnc(unc.distro, unc.linuxPath),
			cwd: this.cwdOr(cwd)
		};
		if (isAbsoluteLinuxPath(path)) {
			const win = mntToWindowsPath(path);
			if (win !== null) return {
				input: win,
				cwd: this.cwdOr(cwd)
			};
			return {
				input: joinUnc(this.distroFor(cwd), path),
				cwd: this.cwdOr(cwd)
			};
		}
		if (windowsToMntPath(path) !== null) return {
			input: path,
			cwd: this.cwdOr(cwd)
		};
		return {
			input: path,
			cwd: this.uncCwd(cwd)
		};
	}
	/** A base for absolute inputs (unused by resolution, but the parent needs one). */
	cwdOr(cwd) {
		return cwd ?? this.executionCwd.getStore() ?? this.config.cwd ?? process.cwd();
	}
	uncCwd(cwd) {
		const base = cwd ?? this.executionCwd.getStore() ?? this.config.cwd;
		if (base === void 0 || base === "") throw new FsError("wsl-fs: no cwd and no configured base for relative resolution", "FS_IO_ERROR");
		const unc = parseWslUnc(base);
		if (unc !== null) return joinUnc(unc.distro, unc.linuxPath);
		if (isAbsoluteLinuxPath(base)) return joinUnc(this.distroFor(base), base);
		if (windowsToMntPath(base) !== null) return base;
		throw new FsError(`wsl-fs: cwd "${base}" is not in the WSL execution world`, "FS_IO_ERROR");
	}
	/**
	* Resolve the distribution an absolute Linux path opens inside. The chain:
	* the caller cwd when it is a WSL UNC path, then the current tool
	* execution's session cwd, then the configured `distro`,
	* then the host's default distribution from the Lxss registry. The registry
	* fallback is reserved for calls that genuinely have no session.
	*/
	distroFor(cwd) {
		const fromCwd = parseWslUnc(cwd ?? "");
		if (fromCwd !== null) return fromCwd.distro;
		const fromExecution = parseWslUnc(this.executionCwd.getStore() ?? "");
		if (fromExecution !== null) return fromExecution.distro;
		const distro = this.distro;
		if (distro !== void 0 && distro !== "") return distro;
		const fallback = defaultDistroSync();
		if (fallback !== void 0) return fallback;
		throw new FsError("wsl-fs: Linux path carries no distribution and none is configured", "FS_IO_ERROR");
	}
	/** The Linux display path for a resolved Windows-side path. */
	linuxDisplay(raw) {
		const unc = parseWslUnc(raw);
		if (unc !== null) return unc.linuxPath;
		const mnt = windowsToMntPath(raw);
		if (mnt !== null) return mnt;
		throw new FsError(`wsl-fs: resolved path "${raw}" is outside the WSL execution world`, "FS_IO_ERROR");
	}
	async resolve(path, opts) {
		if (opts?.signal?.aborted) throw new FsError("resolve aborted", "FS_ABORTED");
		const { input, cwd } = this.translate(path, opts?.cwd);
		const resolved = {
			cwd,
			...opts?.signal !== void 0 ? { signal: opts.signal } : {}
		};
		let local;
		try {
			local = await super.resolve(input, resolved);
		} catch (error) {
			const real = await this.linkAwarePath(input, input);
			if (real === void 0) throw error;
			return this.wslTarget(await super.resolve(real, resolved));
		}
		const real = await this.linkAwarePath(input, String(local.targetKey));
		if (real === void 0) return this.wslTarget(local);
		return this.wslTarget(await super.resolve(real, resolved));
	}
	/** Wrap a locally resolved target in this world's Linux-facing identity. */
	wslTarget(local) {
		return {
			targetKey: local.targetKey,
			displayPath: this.linuxDisplay(String(local.displayPath))
		};
	}
	/**
	* The real path a link-aware lookup must use, or `undefined` when the input
	* needs no help. Only a path this share cannot already describe pays for a
	* `wsl.exe` lookup: an existing file or directory resolves directly, while a
	* symlink (in the final segment or anywhere above it), a dangling target and
	* a not-yet-created file all ask the distribution, which answers with the
	* same path when nothing was linked.
	* @param input - the translated input or resolved identity to inspect.
	* @param targetKey - the identity the local resolver produced.
	* @returns the distribution's real path when it differs, else `undefined`.
	*/
	async linkAwarePath(input, targetKey) {
		const unc = parseWslUnc(targetKey) ?? parseWslUnc(input);
		if (unc === null) return void 0;
		const asSpelled = joinUnc(unc.distro, unc.linuxPath);
		if (await this.describable(targetKey)) return void 0;
		const real = await resolveLinuxSymlink(asSpelled);
		if (real === void 0) return void 0;
		return real.toLowerCase() === asSpelled.toLowerCase() ? void 0 : real;
	}
	/** Whether this share can describe a Windows-side identity at all. */
	async describable(winPath) {
		return await super.lstat(winPath, {}).catch(() => void 0) !== void 0;
	}
	/**
	* The host file-effect policy for this call: the tool layer's per-call value
	* when it passes one, else the service's own resolution. `undefined` means
	* the deployment mounts no policy at all — the same state as a host
	* filesystem without `fs-sandbox`, so nothing is fenced.
	*/
	sandboxPolicy(perCall) {
		if (isSandboxPolicy(perCall)) return perCall;
		const service = this.sandboxPolicyService();
		if (service === void 0) return void 0;
		try {
			const policy = service.resolve();
			return isSandboxPolicy(policy) ? policy : void 0;
		} catch {
			return;
		}
	}
	/** The policy service this backend reads, when the deployment mounts one. */
	sandboxPolicyService() {
		const service = this.ctx.get("sandboxPolicy");
		return service !== void 0 && typeof service.resolve === "function" ? service : void 0;
	}
	/**
	* The deployment's default sandbox mode — the capability fact the file tool
	* reads to advertise escalation, mirrored from `SandboxedFileSystem`.
	*/
	get sandboxMode() {
		const mode = this.sandboxPolicyService()?.defaultMode;
		return typeof mode === "string" ? mode : void 0;
	}
	/**
	* Fence a mutation by the policy, then hand back the EXACT target to mutate
	* (no check-here-write-there): `read-only` denies, `workspace-write`
	* re-resolves and requires containment under a writable root, and
	* `danger-full-access` passes through. Mirrors
	* `@deepseek-ai/dsh-fs-sandbox`'s `checkedTarget`, including the
	* `FS_SANDBOX_DENIED` code the tool layer renders as a denial.
	* @param target - the resolved target about to be written.
	* @param perCall - the tool layer's per-call policy, when it passes one.
	* @returns the target the mutation must use.
	*/
	async checkedTarget(target, perCall) {
		const policy = this.sandboxPolicy(perCall);
		if (policy === void 0 || policy.mode === "danger-full-access") return target;
		if (policy.mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
		if (policy.mode !== "workspace-write") return target;
		const fresh = await this.resolve(target.displayPath);
		for (const root of this.writableRoots(policy)) if (this.underRoot(String(fresh.targetKey), root)) return fresh;
		throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
	}
	/**
	* The roots a write may land under: the host's rule verbatim
	* (`writableRoots`: the workspace root plus the platform temp areas) plus,
	* in a WSL session, the distribution's own `/tmp` — the temp area of the
	* world this session actually runs in, which the host-side rule cannot name.
	* @param policy - the resolved policy.
	*/
	writableRoots(policy) {
		const roots = writableRoots(policy);
		const workspace = policy.workspaceRoot;
		const unc = workspace === void 0 ? null : parseWslUnc(workspace);
		if (unc !== null) roots.push(joinUnc(unc.distro, "/tmp"));
		return roots;
	}
	/** Whether a canonical target key is a writable root or sits below one. */
	underRoot(targetKey, root) {
		const key = trimTrailing(canonicalPath(targetKey)).toLowerCase();
		const base = trimTrailing(canonicalPath(root)).toLowerCase();
		if (base === "" || base === "/" || key === base) return key === base;
		return key.startsWith(base.endsWith("/") || base.endsWith("\\") ? base : `${base}\\`) || key.startsWith(`${base}/`);
	}
	/** Fence a full-content write by the policy, then delegate to the parent. */
	async writeText(target, content, expected, signal, sandboxPolicy) {
		return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
	}
	/** Fence an edit by the policy, then delegate to the parent. */
	async editText(target, edit, expected, signal, sandboxPolicy) {
		return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
	}
	processPath(target) {
		const key = String(target.targetKey);
		const unc = parseWslUnc(key);
		if (unc !== null) return unc.linuxPath;
		const mnt = windowsToMntPath(key);
		if (mnt !== null) return mnt;
		throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, "FS_IO_ERROR");
	}
	fileUrl(target) {
		return `file://${this.processPath(target).split("/").map(encodeURIComponent).join("/")}`;
	}
	contains(parent, child) {
		const parentWorld = this.worldPath(parent);
		const childWorld = this.worldPath(child);
		if (parentWorld.distro !== childWorld.distro) return false;
		const parentPath = parentWorld.linuxPath;
		const childPath = childWorld.linuxPath;
		if (childPath === parentPath) return true;
		return parentPath === "/" ? true : childPath.startsWith(`${parentPath}/`);
	}
	/** One target's (distro, linuxPath) pair for containment; `undefined` distro = Windows world. */
	worldPath(target) {
		const key = String(target.targetKey);
		const unc = parseWslUnc(key);
		if (unc !== null) return {
			distro: unc.distro,
			linuxPath: unc.linuxPath
		};
		const mnt = windowsToMntPath(key);
		if (mnt !== null) return {
			distro: void 0,
			linuxPath: mnt
		};
		throw new FsError(`wsl-fs: target "${target.displayPath}" is outside the WSL execution world`, "FS_IO_ERROR");
	}
	async lstat(path, opts, signal) {
		if (signal?.aborted) throw new FsError("lstat aborted", "FS_ABORTED");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const { input, cwd } = this.translate(path, opts?.cwd);
		const info = await super.lstat(input, { cwd }, signal).catch(() => void 0);
		if (info !== void 0) return info;
		const real = await this.linkAwarePath(input, input);
		if (real === void 0) return info;
		return super.lstat(real, { cwd }, signal);
	}
};
/** Whether a value is a usable file-effect policy. */
function isSandboxPolicy(value) {
	return value !== void 0 && typeof value.mode === "string" && value.mode !== "";
}
/** Strip a trailing separator (keeping the root separator itself). */
function trimTrailing(path) {
	return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}
//#endregion
export { WslFileSystem, WslFileSystem as default };

//# sourceMappingURL=fs.js.map