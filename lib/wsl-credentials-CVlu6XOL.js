import { a as joinUnc, c as parseWslUnc, r as isValidWslUsername, t as canonicalWindowsPath } from "./paths-BY8nrZc5.js";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/shared/wsl-credentials.ts
/**
* Per-workspace WSL credentials (host side only). The dialog stores the
* optional Linux username of a WSL workspace under the harness home; the
* per-session env contributor and the WSL shell executor read it back so
* `wsl.exe -u <username>` can run commands as that user. Keys are canonical
* UNC workspace paths. This module touches node builtins, so the browser
* half never imports it.
* @module dsh-wsl-workspace/shared/wsl-credentials
*/
/** The store file lives under the harness home so both host halves share it. */
function storePath() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "wsl-workspaces.json");
}
/** Read the store; a missing or corrupt file reads as empty (never throws). */
function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/**
* The creation time of the directory a drive key names right now, in milliseconds,
* or undefined when no directory answers.
*
* Absent says nothing about the record, and that is deliberate: a drive that is not
* mounted this moment, a share that is briefly down, and a folder the user has not
* recreated yet all read the same way as "gone", and a read of the store must not
* destroy a working registration because of them. Only the positive form below — a
* directory is there, and it is not the one that was registered — retires anything.
* @param path - the store key (a canonical Windows drive path).
* @returns the birthtime, or undefined.
*/
function directoryBorn(path) {
	try {
		const stat = statSync(path);
		return stat.isDirectory() ? Math.round(stat.birthtimeMs) : void 0;
	} catch {
		return;
	}
}
/**
* Persist the store. One writer, so every exit path leaves the same shape.
* @param store - the records to write.
*/
function writeStore(store) {
	const file = storePath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}
/**
* The store as the file system supports it right now.
*
* A drive-shaped record is dropped when a directory answers to its path but is not
* the directory that was registered — a different creation time means the folder in
* `F:\proj` is a NEW folder that happens to wear the old one's name, which is issue
* #129's repro step 2 reading as "the new project inherited the old one's WSL mode".
* The drop is written back, so the client's next read sees one fewer workspace
* instead of re-deciding it per lookup.
*
* What does NOT drop a record: the directory being absent. That reads identically for
* "the user deleted it" and "this drive is not mounted right now", and the second is
* a working registration a cold read would destroy. Deleting the workspace in the
* host is the exit for the first, and the client reconciles it (see `src/client/index.ts`).
* UNC records are left alone either way: their share is the distribution's own, and a
* 9P `stat` per read is not a price worth paying when the reported symptom is about drive paths.
* @returns the surviving records, and the keys retired on the way.
*/
function liveStore() {
	const store = readStore();
	const dropped = [];
	for (const [key, entry] of Object.entries(store)) {
		if (entry.distro === void 0 || entry.born === void 0) continue;
		const born = directoryBorn(key);
		if (born !== void 0 && born !== entry.born) {
			delete store[key];
			dropped.push(key);
		}
	}
	if (dropped.length > 0) writeStore(store);
	return {
		store,
		dropped
	};
}
/**
* Canonicalize any accepted WSL UNC spelling into the store's key form.
* @param path - candidate workspace path (either UNC host form).
* @returns the canonical UNC path, or null when the path is not a WSL UNC.
*/
function canonicalWslUnc(path) {
	const parsed = parseWslUnc(path);
	return parsed === null ? null : joinUnc(parsed.distro, parsed.linuxPath);
}
/**
* Read the stored username for a WSL workspace.
* @param uncPath - the workspace path (any accepted WSL UNC spelling).
* @returns the username, or undefined when none is stored.
*/
function getWorkspaceUsername(uncPath) {
	const key = canonicalWslUnc(uncPath);
	if (key === null) return void 0;
	const username = readStore()[key]?.username;
	return username === void 0 || username === "" ? void 0 : username;
}
/**
* Store (or clear) the username of a WSL workspace.
* @param uncPath - the workspace path (any accepted WSL UNC spelling).
* @param username - the username; empty or undefined clears the stored value.
*/
function setWorkspaceUsername(uncPath, username) {
	const key = canonicalWslUnc(uncPath);
	if (key === null) throw new Error("wsl-workspace: workspace path is not a WSL UNC path");
	const store = readStore();
	if (username === void 0 || username.trim() === "") delete store[key];
	else {
		const trimmed = username.trim();
		if (!isValidWslUsername(trimmed)) throw new Error("wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
		store[key] = { username: trimmed };
	}
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}
/**
* Register the WSL distribution (and optional Linux username) of a
* Windows-drive workspace (`/mnt/<drive>` path). Keys are canonical Windows
* drive paths; the per-session env contributor reads the entry back so
* `wsl.exe -d <distro>` can run when the session cwd is a drive path.
* @param winPath - the Windows drive path (any spelling).
* @param distro - the WSL distribution the workspace belongs to.
* @param username - optional Linux username (distro default when absent).
*/
function registerWindowsWorkspace(winPath, distro, username) {
	const key = canonicalWindowsPath(winPath);
	if (key === null) throw new Error("wsl-workspace: workspace path is not a Windows drive path");
	const entry = { distro };
	if (username !== void 0 && username.trim() !== "") {
		const trimmed = username.trim();
		if (!isValidWslUsername(trimmed)) throw new Error("wsl-workspace: username must match the Linux username pattern [A-Za-z_][A-Za-z0-9_.-]*");
		entry.username = trimmed;
	}
	const store = readStore();
	store[key] = entry;
	const born = directoryBorn(key);
	if (born !== void 0) entry.born = born;
	writeStore(store);
}
/**
* Read the stored credentials of a Windows-drive workspace.
* @param winPath - the Windows drive path (any spelling).
* @returns the stored entry, or undefined when none is registered — including when
* a record exists but a different directory now answers to its path.
*/
function getWindowsWorkspace(winPath) {
	const key = canonicalWindowsPath(winPath);
	if (key === null) return void 0;
	return liveStore().store[key];
}
/**
* Remove one workspace's registration, whichever dialog route wrote it.
*
* The store had exactly one exit before this function: `setWorkspaceUsername`'s
* `delete`, which resolves its key through `canonicalWslUnc()` and therefore
* throws on a drive key. A `/mnt/<drive>` workspace written by `registerWindows`
* had no way back out — deleting the session, deleting the workspace in the host,
* and deleting the directory itself all leave the record behind, and the client
* re-binds every new session from it (issue #129).
* @param path - a WSL UNC path or a Windows drive path, in any spelling.
* @returns the key removed from the store, or null when the path names neither.
*/
function unregisterWorkspace(path) {
	const key = canonicalWslUnc(path) ?? canonicalWindowsPath(path);
	if (key === null) return null;
	const store = readStore();
	if (!(key in store)) return null;
	delete store[key];
	writeStore(store);
	return key;
}
/** Every stored workspace key (canonical UNC and Windows drive paths). */
function listWorkspaceKeys() {
	return Object.keys(liveStore().store);
}
/**
* Every stored workspace with its credentials.
*
* The client half needs more than the keys: to translate a file reference it has
* to know which distribution a `/mnt/<drive>` workspace belongs to, because a
* path outside the drive mounts can only be opened through that distribution's
* UNC share. The keys alone cannot say.
* @returns one record per stored workspace whose directory still answers as the
* registered one (a folder replaced by a newer one retires its record here).
*/
function listWorkspaceRecords() {
	return Object.entries(liveStore().store).map(([path, entry]) => {
		const record = { path };
		if (entry.distro !== void 0 && entry.distro !== "") record.distro = entry.distro;
		if (entry.username !== void 0 && entry.username !== "") record.username = entry.username;
		return record;
	});
}
//#endregion
export { listWorkspaceRecords as a, unregisterWorkspace as c, listWorkspaceKeys as i, getWindowsWorkspace as n, registerWindowsWorkspace as o, getWorkspaceUsername as r, setWorkspaceUsername as s, canonicalWslUnc as t };

//# sourceMappingURL=wsl-credentials-CVlu6XOL.js.map