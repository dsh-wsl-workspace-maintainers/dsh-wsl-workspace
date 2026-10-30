window.__ModuleLoader__.load({
	id: "dsh-wsl-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/**
		* Thin fetch client for the Host plugin route. The browser calls
		* POST /wsl-workspace/api with a `{ method, params }` envelope and the Host
		* answers `{ ok: true, value }` or `{ ok: false, error }`.
		*/
		/** Relative route the Host half registers (same-origin with the web server). */
		const ENDPOINT = "/wsl-workspace/api";
		/** Human text for an unknown rejection, reusing the repository's idiom. */
		function errorMessage(value) {
			return value instanceof Error ? value.message : String(value);
		}
		/**
/**
		* How long one call may take before it is abandoned.
		*
		* Without a ceiling a request that never settles is indistinguishable from a slow one, and the
		* dialog's Retry button is the only way out — a user who opened the Add-workspace dialog on a host
		* that is not answering has to click it to learn nothing. 30s is far above any measured local call
		* (the slowest, a `describe` that boots a profile, is well under 2 s) and far below the point where a
		* spinner becomes indistinguishable from a hang.
		*/
		const CALL_TIMEOUT_MS = 3e4;
		/**
		* The text of a refusal. A host that answers `{ok:false}` without a usable
		* `error` (a proxy inventing an envelope, a future host shape) must still
		* produce a sentence: `new Error(undefined)` renders as the word "undefined",
		* which tells the reader nothing about what went wrong.
		* @param error - whatever the envelope carried in `error`.
		* @param method - the Host method name, used when the envelope had no reason.
		* @returns the refusal text, never empty.
		*/
		function refusalText(error, method) {
			if (typeof error === "string" && error !== "") return error;
			if (error === void 0 || error === null) return `wsl-workspace ${method} was refused without a reason`;
			if (typeof error === "object") {
				const message = error.message;
				if (typeof message === "string" && message !== "") return message;
			}
			return `wsl-workspace ${method} was refused: ${errorMessage(error)}`;
		}
		/**
		* Perform one POST call and unwrap the envelope.
		*
		* Three failure shapes are answered in words rather than in shape. **`response.ok` is checked before
		* the body is trusted**: a 500 from a proxy answers HTML, and parsing it would report "non-JSON" —
		* naming the symptom and hiding the status that says what happened. The status leads even when the
		* body IS readable, because an `ok:true` on a 404 is exactly the hole this closes; the envelope's own
		* `error` is appended as detail when there is one, and never allowed to replace the status.
		* **The fetch carries a timeout**, so a request that never settles reports that instead of leaving the
		* caller waiting on a promise that cannot resolve (issue #44 §6, `T8`). **An `ok:true` with no
		* `value` is refused too**: returning `undefined` as a value would push the discovery into every
		* caller, none of which can tell it apart from an empty answer.
		* @param method - the Host method name.
		* @param params - the method payload.
		* @returns the unwrapped value, or throws an Error on transport, timeout, non-2xx, or `ok:false`.
		*/
		async function call(method, params = {}) {
			let response;
			const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
			try {
				response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						method,
						params
					}),
					signal
				});
			} catch (error) {
				if (signal.aborted) throw new Error(`wsl-workspace: ${method} did not answer within ${CALL_TIMEOUT_MS / 1e3}s (${ENDPOINT})`);
				throw new Error(`wsl-workspace request failed: ${errorMessage(error)}`);
			}
			if (!response.ok) {
				let detail = "";
				try {
					const body = await response.json();
					const answered = typeof body === "object" && body !== null ? body : void 0;
					if (answered?.ok === false) detail = `: ${refusalText(answered.error, method)}`;
				} catch {}
				throw new Error(`wsl-workspace: ${method} answered HTTP ${response.status}${detail}`);
			}
			let envelope;
			try {
				envelope = await response.json();
			} catch {
				throw new Error(`wsl-workspace answered non-JSON on 2xx (${response.status}) — ${ENDPOINT}`);
			}
			if (!envelope.ok) throw new Error(refusalText(envelope.error, method));
			if (!("value" in envelope)) throw new Error(`wsl-workspace ${method} answered ok without a value`);
			return envelope.value;
		}
		/**
		* List the WSL distros installed on the host.
		* @returns distro names in registry order.
		*/
		async function listDistros() {
			return call("listDistros", {});
		}
		/**
		* List one directory level inside a distro.
		* @param distro - distro name.
		* @param path - absolute Linux directory to list.
		* @returns the level's listing with ancestry.
		*/
		async function listDir(distro, path) {
			return call("listDir", {
				distro,
				path
			});
		}
		/**
		* Check whether a Linux path exists and is a directory.
		* @param distro - distro name.
		* @param path - absolute Linux path.
		* @returns existence and directory facts.
		*/
		async function check(distro, path) {
			return call("check", {
				distro,
				path
			});
		}
		/**
		* Store (or clear, with an empty string) the username of one WSL workspace.
		* @param path - the workspace UNC path.
		* @param username - the Linux username; empty string clears the stored value.
		*/
		async function setWorkspaceUser(path, username) {
			return call("setUser", {
				path,
				username
			});
		}
		/**
		* Register a `/mnt/<drive>` WSL workspace under its Windows drive path,
		* recording the distro (and optional username) for the session env.
		* @param linuxPath - the `/mnt/<drive>/…` Linux path.
		* @param distro - the WSL distribution the workspace belongs to.
		* @param username - optional Linux username.
		*/
		async function registerWindows(linuxPath, distro, username) {
			return call("registerWindows", {
				linuxPath,
				distro,
				username
			});
		}
		/**
		* Remove one workspace's registration — the exit `registerWindows` had no
		* partner for (issue #129). A `/mnt/<drive>` workspace is stored under its
		* Windows drive key, and the store's only delete resolved UNC keys, so the
		* record outlived the session, the workspace and the directory itself.
		* @param path - the store key: a canonical Windows drive path or a WSL UNC path.
		* @returns the canonical key the host removed from the store.
		*/
		async function removeWorkspace(path) {
			return call("removeWorkspace", { path });
		}
		/**
		* List every registered WSL workspace with its stored credentials.
		*
		* File-reference translation needs the distribution behind a `/mnt/<drive>`
		* workspace, which the key list alone does not carry.
		* @returns one record per registered workspace.
		*/
		async function listWorkspaceRecords() {
			return call("listWorkspaceRecords", {});
		}
		/**
		* Read the plugin build version and its declared DSH compatibility matrix,
		* for the dialog help panel.
		* @returns the self-description reported by the host plugin.
		*/
		async function describe() {
			return call("describe", {});
		}
		/**
		* Read how this boot's variant generation ended.
		*
		* A host without this case answers `{ok:false, error:'unknown method
		* "variantStatus"'}` — the rejection IS the signal that the roster is the only
		* source available, so callers must treat it as a fallback rather than a fault.
		* @returns the host's outcome record.
		*/
		async function variantStatus() {
			return call("variantStatus", {});
		}
		//#endregion
		//#region src/client/session-optout.ts
		/**
		* Per-session opt-out from the WSL world.
		*
		* The mode-variant binding in `./index.ts` scans **blank** sessions and recomposes
		* any whose cwd names a registered WSL workspace onto its `wsl-<mode>` variant. That
		* late-input pass is what makes a workspace registered after the page loaded take
		* effect without a reload — and it is also why a session-level "exit WSL mode"
		* cannot be a single `select(standard)`: the next scan would bind the session right
		* back. (Measured on a real instance 2026-10-30: a session that was still blank
		* flipped back to `wsl-standard` once its workspace was re-registered.)
		*
		* So the exit is recorded here, per session id, and the binder skips it. The
		* workspace-level exit is a different thing — it clears the registration, so
		* sessions created afterwards are never candidates in the first place.
		*
		* `sessionStorage` (not `localStorage`): the decision belongs to the tab that made
		* it, and a new tab on the same workspace should get the workspace's own answer.
		* @module dsh-wsl-workspace/client/session-optout
		*/
		const KEY = "dsh-wsl-workspace:session-exits";
		/** Where the list lives when there is no session storage (node, a worker, privacy mode). */
		let memory = null;
		function store() {
			let backing = null;
			try {
				backing = typeof window !== "undefined" ? window.sessionStorage : null;
				backing?.getItem(KEY);
			} catch {
				backing = null;
			}
			if (backing === null) return {
				read: () => memory ?? [],
				write: (ids) => {
					memory = ids;
				}
			};
			const site = backing;
			return {
				read: () => {
					try {
						const parsed = JSON.parse(site.getItem(KEY) ?? "[]");
						return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
					} catch {
						return [];
					}
				},
				write: (ids) => {
					try {
						site.setItem(KEY, JSON.stringify(ids));
					} catch {
						memory = ids;
					}
				}
			};
		}
		/** Whether this session was taken out of the WSL world by choice. */
		function hasOptedOut(sessionId) {
			return store().read().includes(sessionId);
		}
		/**
		* Take one session out of the WSL world, so the binder stops recomposing it.
		* @param sessionId - the session the user exited from.
		*/
		function optOutSession(sessionId) {
			const ids = store().read();
			if (ids.includes(sessionId)) return;
			store().write([...ids, sessionId]);
		}
		/**
		* Put one session back, so the binder may recompose it again.
		* @param sessionId - the session the user re-enabled.
		*/
		function optInSession(sessionId) {
			const ids = store().read();
			if (!ids.includes(sessionId)) return;
			store().write(ids.filter((id) => id !== sessionId));
		}
		/**
		* Undo one opt-out without promising the caller the session got recomposed.
		* @param sessionId - the session whose recorded exit should be dropped.
		*/
		function unmarkOptOut(sessionId) {
			store().write(store().read().filter((id) => id !== sessionId));
		}
		//#endregion
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
		* Whether a path resolves into a WSL distro through either UNC form.
		* @param raw - candidate absolute path.
		* @returns whether the path parses as a WSL UNC.
		*/
		function isWslUnc(raw) {
			return parseWslUnc(raw) !== null;
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
		* Rewrite a path's separators to `/`, the spelling every comparison and the
		* address grammar use. Windows spellings reach this plugin from workspace roots,
		* tool arguments and the workspace store, so the rewrite lives here with the
		* other spelling pairs instead of being repeated by each caller.
		* @param value - the path to normalize.
		* @returns the same path with `\` written as `/`.
		*/
		function toPosixSpelling(value) {
			return value.replace(/\\/g, "/");
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
		* The spelling of an absolute Linux path that the HARNESS HOST can open.
		*
		* A file reference in a WSL session carries the path exactly as the model wrote
		* it — an absolute Linux path — and the client hands that path to the host,
		* which resolves it with `node:path.resolve(cwd, path)`. On Windows a POSIX
		* absolute path is root-relative there, so `/mnt/d/x` becomes
		* `<cwd drive>:\mnt\d\x` and `/etc/hosts` becomes `<cwd drive>:\etc\hosts`;
		* when the cwd is itself a UNC share the path lands under that share's root
		* instead. Neither is the file the model named, so the document preview reports
		* it missing. This maps the path onto a spelling that names the same file for
		* the host: a drvfs mount back to its drive letter, and anything else through
		* the distribution's UNC share.
		*
		* `/mnt/<drive>` needs no distribution: the mount name IS the drive. Every
		* other path is inside the distribution's own filesystem, so it needs one —
		* from the session's UNC cwd, or from the registered workspace of a drive cwd.
		*
		* @param linuxPath - the absolute Linux path a reference carries.
		* @param distro - the session's WSL distribution, when known.
		* @returns the host-readable spelling, or `null` when the path cannot be translated.
		*/
		function hostPathForLinuxReference(linuxPath, distro) {
			if (!isAbsoluteLinuxPath(linuxPath)) return null;
			if (linuxPath.startsWith("//")) return null;
			const drive = mntToWindowsPath(linuxPath);
			if (drive !== null) return drive;
			if (distro === void 0 || distro === "") return null;
			return joinUnc(distro, linuxPath);
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
		//#region src/client/hostEntryButton.tsx
		/**
		* One icon button in the Workspaces header, carrying the shell's tooltip.
		* @param props - class list, label and opener.
		* @returns the wrapped button.
		*/
		function HostEntryButton({ className, label, open }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				side: "bottom",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: `${className} dww-header-entry`,
					"aria-haspopup": "dialog",
					"aria-label": label,
					onClick: open,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dww-letter",
						"aria-hidden": "true",
						children: "W"
					})
				})
			});
		}
		//#endregion
		//#region src/client/hostEntry.ts
		/**
		* Join the host's own workspace UI instead of standing beside it.
		*
		* The shell exposes exactly one seat to a third-party client plugin
		* (`sidebar.footer.action`), and neither the browsing region nor the workspace
		* picker offers one: the "add workspace" control in the Workspaces section
		* header and the "Add workspace…" row in that control's menu are host-private
		* markup. The two entries mounted here are runtime mirrors of those two seats —
		* the shipped control's own `className` is copied (so size, radius, hover and
		* focus are the shipped behaviours rather than lookalikes), the header button is
		* drawn through the same Tooltip primitive the shipped control uses (so its
		* hover bubble is the shipped bubble rather than a native `title` box), and the
		* menu row is a clone of the shipped row (so its icon and item classes come with
		* it).
		*
		* Nothing in the host is patched: no module is wrapped and no service is
		* replaced. Every mount is a plain DOM node whose lifecycle this plugin owns,
		* and every mount falls back to the footer action when its seat is absent (rail
		* sidebar, a release that renames the region, a browser without the menu).
		*
		* Both seats mount late — the header with the Workspaces region, the menu on
		* first open — and both are re-rendered by React underneath us, so each mount is
		* kept in place by an observer plus a slow interval rather than assumed to
		* survive a render.
		*/
		/**
		* The shipped label of the row this menu entry follows, in every locale the
		* shell ships. Matching on the row's text is the only handle available: the
		* menu carries no stable id or data attribute for that item.
		*/
		const HOST_ADD_WORKSPACE_LABELS = ["添加工作区…", "Add workspace…"];
		/** How long the trimmed mode menu is held invisible while the host re-measures it. */
		const PRESET_SETTLE_MS = 80;
		/**
		* Mount the W entry in the Workspaces section header, immediately right of the
		* shipped "Add workspace" control.
		*
		* Discovery walks up from the footer slot (the one element this plugin owns)
		* looking for the section header it is mounted beside, then takes that header's
		* action strip and its last button — the add control. The entry is rendered into
		* a slot appended to the strip, so it inherits the strip's gap and the add
		* control's own class list, and it opens the same Tooltip bubble the add
		* control does.
		*
		* @param home - the footer slot's element, or null when it is not mounted.
		* @param options - the label getter and the dialog opener.
		* @param onSeat - told whenever the seat appears or disappears, so the caller
		*   can retire the footer copy while the header carries the entry.
		* @returns a disposer that removes the button and every observer.
		*/
		function mountHeaderEntry(home, options, onSeat) {
			if (typeof document === "undefined" || typeof window === "undefined" || home === null) return () => {};
			const Observer = window.MutationObserver;
			if (Observer === void 0) return () => {};
			const slot = document.createElement("span");
			slot.className = "dww-header-slot";
			let root = null;
			let drawn = null;
			/** The dialog opener, stable across renders, so a redraw with the same facts is a no-op commit. */
			const open = () => options.open();
			/**
			* Draw (or redraw) the entry with the facts of this pass.
			* @param className - the shipped add control's class list.
			* @param label - the localized entry label, which doubles as the tooltip text.
			*/
			const draw = (className, label) => {
				if (drawn !== null && drawn.className === className && drawn.label === label) return;
				drawn = {
					className,
					label
				};
				if (root === null) root = (0, react_dom_client.createRoot)(slot);
				root.render((0, react.createElement)(HostEntryButton, {
					className,
					label,
					open
				}));
			};
			/**
			* The header's action strip and its last button (the add control), found from
			* the footer slot upwards. A region that is not mounted (or a release whose
			* markup moved) answers null, which the caller reads as "no header seat".
			*/
			const find = () => {
				let node = home.parentElement;
				while (node !== null && node !== document.body) {
					const header = node.querySelector("[class*=\"_sectionHeader\"]");
					if (header !== null) {
						const actions = header.querySelector("[class*=\"_headerActions\"]");
						if (actions === null) return null;
						const add = [...actions.querySelectorAll("button")].filter((button) => !button.classList.contains("dww-header-entry")).at(-1);
						return add === void 0 ? null : {
							actions,
							add
						};
					}
					node = node.parentElement;
				}
				return null;
			};
			let observer = null;
			let observed = null;
			let present = false;
			const seat = (value) => {
				if (present === value) return;
				present = value;
				onSeat(value);
			};
			const ensure = () => {
				const found = find();
				if (found === null) {
					slot.remove();
					seat(false);
					if (observer !== null) {
						observer.disconnect();
						observer = null;
						observed = null;
					}
					return;
				}
				if (slot.parentElement !== found.actions) found.actions.appendChild(slot);
				draw(found.add.className, options.label());
				if (observed !== found.actions) {
					if (observer !== null) observer.disconnect();
					observed = found.actions;
					observer = new Observer(() => ensure());
					observer.observe(observed, { childList: true });
				}
				seat(true);
			};
			ensure();
			let queued = false;
			const schedule = () => {
				if (queued) return;
				queued = true;
				queueMicrotask(() => {
					queued = false;
					ensure();
				});
			};
			const bodyObserver = new Observer(schedule);
			bodyObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			return () => {
				bodyObserver.disconnect();
				if (observer !== null) observer.disconnect();
				if (root !== null) root.unmount();
				root = null;
				slot.remove();
			};
		}
		/**
		* Add the WSL entry to the workspace picker menu, directly under the shipped
		* "Add workspace…" row.
		*
		* The clone keeps that row's own icon and classes — only the label changes — so
		* the entry is indistinguishable from the shipped row. Clicking it raises the
		* same dialog as the header button; the menu's own click handler closes the
		* menu around it.
		*
		* The same pass trims the mode picker: a WSL session shows only this plugin's
		* `wsl-*` variants, every other session shows only the shipped modes. The host
		* builds the menu with the full list and measures it, so the untrimmed frame is
		* held invisible until the trimmed list has been placed — otherwise the menu
		* flashes above its anchor and jumps below it once the shorter list is measured.
		*
		* @param options - the label getter and the dialog opener.
		* @returns a disposer that stops the observation and removes the injected row.
		*/
		function mountWorkspaceMenuEntry(options) {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const Observer = window.MutationObserver;
			if (Observer === void 0) return () => {};
			const releasePresets = (menu) => {
				if (menu.hasAttribute("data-dww-presets-ready") || menu.hasAttribute("data-dww-presets-pending")) return;
				menu.setAttribute("data-dww-presets-pending", "");
				document.body.setAttribute("data-dww-presets-pending", "");
				window.setTimeout(() => {
					document.body.removeAttribute("data-dww-presets-pending");
					if (!menu.isConnected) return;
					menu.setAttribute("data-dww-presets-ready", "");
				}, PRESET_SETTLE_MS);
			};
			const filterPresets = (menu, buttons) => {
				if (buttons.length === 0) {
					if (menu.querySelector("[class*=\"_itemName\"]") !== null) releasePresets(menu);
					return;
				}
				const rows = [...buttons].map((button) => ({
					button,
					name: (button.querySelector("[class*=\"_itemName\"]")?.textContent ?? "").trim(),
					checked: button.querySelector("[class*=\"_check\"]") !== null
				}));
				if (!rows.some((row) => row.name !== "")) {
					releasePresets(menu);
					return;
				}
				const selected = rows.find((row) => row.checked);
				if (selected === void 0) {
					releasePresets(menu);
					return;
				}
				const wslSelected = /^WSL\b/i.test(selected.name);
				if (wslSelected && !rows.some((row) => row !== selected && /^WSL\b/i.test(row.name))) {
					releasePresets(menu);
					return;
				}
				const wslOnly = wslSelected;
				for (const row of rows) {
					const wrap = row.button.parentElement;
					if (wrap === null) continue;
					const matches = /^WSL\b/i.test(row.name) === wslOnly;
					wrap.style.display = matches ? "" : "none";
					row.button.disabled = !matches;
				}
				releasePresets(menu);
			};
			const sync = () => {
				for (const menu of document.querySelectorAll("[role=\"menu\"]")) {
					const buttons = menu.querySelectorAll("button[role=\"menuitem\"]");
					let addWrap = null;
					for (const button of buttons) {
						const text = (button.querySelector("[class*=\"_itemLabel\"]")?.textContent ?? button.textContent ?? "").trim();
						if (HOST_ADD_WORKSPACE_LABELS.includes(text)) {
							addWrap = button.parentElement;
							break;
						}
					}
					if (addWrap !== null) {
						const label = options.label();
						let entry = menu.querySelector("[data-dww-menu-entry]");
						if (entry === null) {
							entry = addWrap.cloneNode(true);
							entry.setAttribute("data-dww-menu-entry", "");
							const created = entry.querySelector("button[role=\"menuitem\"]");
							if (created !== null) {
								created.removeAttribute("aria-keyshortcuts");
								created.addEventListener("click", () => options.open());
							}
						}
						const labelSpan = entry.querySelector("button[role=\"menuitem\"]")?.querySelector("[class*=\"_itemLabel\"]") ?? null;
						if (labelSpan !== null && labelSpan.textContent !== label) labelSpan.textContent = label;
						if (entry.parentElement === null || entry.previousElementSibling !== addWrap) addWrap.after(entry);
					}
					filterPresets(menu, buttons);
				}
			};
			/**
			* The hero workspace picker's menu is anchored by rect, so its trigger chip
			* sits outside the menu's root. The host closes the menu on an outside
			* pointerdown and the chip's click then toggles it open again, so a second
			* click could never close it. Keep that one press from reaching the outside
			* handler; the chip's click still closes the menu.
			*/
			const keepWorkspaceToggle = (event) => {
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				if (target.closest("button[aria-haspopup=\"menu\"][aria-expanded=\"true\"][class*=\"_workspace\"]") === null) return;
				event.stopPropagation();
			};
			for (const stale of document.querySelectorAll("[data-dww-menu-entry]")) stale.remove();
			document.addEventListener("pointerdown", keepWorkspaceToggle, true);
			const observer = new Observer(sync);
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			sync();
			return () => {
				document.removeEventListener("pointerdown", keepWorkspaceToggle, true);
				observer.disconnect();
				for (const stale of document.querySelectorAll("[data-dww-menu-entry]")) stale.remove();
			};
		}
		//#endregion
		//#region src/client/help.tsx
		/**
		* Split one dictionary entry into its bullet lines.
		* @param value - the multi-line dictionary string.
		* @returns the non-empty lines, trimmed.
		*/
		function bullets(value) {
			return value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
		}
		/** One titled section of the panel. */
		function Section({ title, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dww-help-section",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
					className: "dww-help-title",
					children: title
				}), children]
			});
		}
		/**
		* Render the help panel shown behind the dialog's "?" button.
		* @param props - translate function plus the host's self-description.
		*/
		function WslHelp({ t, description }) {
			const releases = description?.releases ?? [];
			const version = description === null ? t("help.compat.unknown") : `${t("help.compat.versionLabel")} v${description.version}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dww-help",
				role: "region",
				"aria-label": t("help.button"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dww-help-greeting",
						children: [
							t("help.greeting"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "dww-help-link",
								href: "https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace",
								target: "_blank",
								rel: "noreferrer",
								children: t("help.greeting.repo")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: t("help.compat.title"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dww-help-meta",
								children: version
							}),
							releases.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dww-help-chips",
								children: releases.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dww-help-chip",
									children: entry.id
								}, entry.id))
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dww-help-list",
								children: bullets(t("help.compat.body")).map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: line }, line))
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("help.news.title"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dww-help-list",
							children: bullets(t("help.news.body")).map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: line }, line))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("help.usage.title"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dww-help-list",
							children: bullets(t("help.usage.body")).map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: line }, line))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("help.known.title"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dww-help-list dww-help-list--known",
							children: bullets(t("help.known.body")).map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: line }, line))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dww-help-footer",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: "dww-help-link",
							href: "https://www.npmjs.com/package/dsh-wsl-workspace",
							target: "_blank",
							rel: "noreferrer",
							children: t("help.footer.npm")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: "dww-help-link",
							href: "https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace",
							target: "_blank",
							rel: "noreferrer",
							children: t("help.footer.repo")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/AddWslWorkspace.tsx
		/**
		* Build the Linux child path one level below a parent, for the breadcrumb/
		* browse drill.
		* @param parent - the currently listed absolute path (`/` for root).
		* @param name - the child directory name.
		* @returns the child's absolute Linux path.
		*/
		function dirChildPath(parent, name) {
			return parent === "/" ? `/${name}` : `${parent}/${name}`;
		}
		/** A tiny inline terminal glyph for the dialog's directory rows. */
		function WslGlyph({ size = 16 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2.5",
						y: "4.5",
						width: "19",
						height: "15",
						rx: "2.5",
						stroke: "currentColor",
						strokeWidth: "1.6"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6 9l3.2 2.6L6 14",
						stroke: "currentColor",
						strokeWidth: "1.6",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12 14h5",
						stroke: "currentColor",
						strokeWidth: "1.6",
						strokeLinecap: "round"
					})
				]
			});
		}
		/**
		* The "Add WSL workspace…" footer action and its dialog.
		* @param props - owner share + injected face.
		*/
		function AddWslWorkspace({ wide, t, describe, checkPreset, listDistros, listDir, check, createWorkspace }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [opening, setOpening] = (0, react.useState)(false);
			const [distros, setDistros] = (0, react.useState)([]);
			const [distro, setDistro] = (0, react.useState)("");
			const [pathInput, setPathInput] = (0, react.useState)("/home/");
			const [username, setUsername] = (0, react.useState)("");
			const [listing, setListing] = (0, react.useState)(null);
			const [browsePath, setBrowsePath] = (0, react.useState)("/");
			const [browsing, setBrowsing] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [helpOpen, setHelpOpen] = (0, react.useState)(false);
			const [selfDescription, setSelfDescription] = (0, react.useState)(null);
			const browseSeq = (0, react.useRef)(0);
			const browseFailed = (0, react.useRef)(false);
			const homeRef = (0, react.useRef)(null);
			const openRef = (0, react.useRef)(() => {});
			const labelRef = (0, react.useRef)("");
			labelRef.current = t("action.entry");
			(0, react.useEffect)(() => {
				openRef.current = () => setOpen(true);
			});
			const [headerSeat, setHeaderSeat] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!wide) {
					setHeaderSeat(false);
					return;
				}
				return mountHeaderEntry(homeRef.current, {
					label: () => labelRef.current,
					open: () => openRef.current()
				}, setHeaderSeat);
			}, [wide]);
			(0, react.useEffect)(() => mountWorkspaceMenuEntry({
				label: () => labelRef.current,
				open: () => openRef.current()
			}), []);
			const refreshBrowse = async (root, targetDistro) => {
				const seq = ++browseSeq.current;
				setBrowsing(true);
				setBrowsePath(root);
				try {
					const value = await listDir(targetDistro, root);
					if (seq === browseSeq.current) {
						setListing(value);
						if (browseFailed.current) {
							browseFailed.current = false;
							setError((previous) => previous === t("error.loadDir") ? null : previous);
						}
					}
				} catch {
					if (seq === browseSeq.current) {
						setListing(null);
						browseFailed.current = true;
						setError((previous) => previous ?? t("error.loadDir"));
					}
				} finally {
					if (seq === browseSeq.current) setBrowsing(false);
				}
			};
			/**
			* The whole "open the dialog" pass: preset health, distro list, and the default browse root.
			*
			* Extracted from the open effect so **Retry can re-run it** (issue #44 §6, `T8`). It used to be an
			* inline `useEffect([open])` body, which left Retry with nothing to call but `setError(null)` — the
			* button cleared the message and the stale answer stayed, so the dialog reported the same failure
			* it had just been asked to re-check. A Retry that does not retry is worse than no button, because
			* it looks like the answer was refreshed.
			*
			* @param cancelled - reads `true` once the effect that owns this pass has been torn down, so a
			*   late answer cannot set state on an unmounted dialog.
			*/
			const runOpenPass = (cancelled) => {
				describe().then((value) => {
					if (!cancelled()) setSelfDescription(value);
				}).catch(() => {
					if (!cancelled()) setSelfDescription(null);
				});
				setOpening(true);
				(async () => {
					let presetIssue;
					try {
						presetIssue = await checkPreset();
					} catch {
						presetIssue = t("error.loadDistros");
					}
					let names;
					try {
						names = await listDistros();
					} catch {
						if (cancelled()) return;
						setOpening(false);
						setError(t("error.loadDistros"));
						return;
					}
					if (cancelled()) return;
					setDistros(names);
					const first = names[0] ?? "";
					setDistro(first);
					setBrowsing(true);
					setOpening(false);
					setError(presetIssue ?? null);
					if (first !== "") refreshBrowse("/", first);
				})();
			};
			/**
			* Retry: re-run the open pass, keeping the dialog open. A separate sequence number guards it the
			* way `browseSeq` guards browsing — a Retry clicked three times must not leave three passes racing
			* to write the same state, and the last one to answer is not necessarily the last one asked.
			*/
			const [retrySeq, setRetrySeq] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (!open || retrySeq === 0) return;
				let cancelled = false;
				runOpenPass(() => cancelled);
				return () => {
					cancelled = true;
				};
			}, [open, retrySeq]);
			(0, react.useEffect)(() => {
				if (!open) return;
				let cancelled = false;
				setError(null);
				runOpenPass(() => cancelled);
				return () => {
					cancelled = true;
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape" && !busy) setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open, busy]);
			const trigger = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				ref: homeRef,
				type: "button",
				className: wide ? "dww-action dww-action--wide" : "dww-action dww-action--rail",
				title: t("action.title"),
				"aria-label": t("action.title"),
				"aria-hidden": open || headerSeat || void 0,
				hidden: headerSeat && wide,
				tabIndex: open ? -1 : void 0,
				onClick: () => setOpen(true),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dww-letter",
					"aria-hidden": "true",
					children: "W"
				}), wide ? t("action.add") : null]
			});
			if (!open) return trigger;
			const onDrill = (name) => {
				const next = dirChildPath(listing?.path ?? browsePath, name);
				setPathInput(next);
				refreshBrowse(next, distro);
			};
			const onUp = () => {
				const parent = listing?.parent ?? null;
				if (parent === null) return;
				setPathInput(parent);
				refreshBrowse(parent, distro);
			};
			const onDistroChange = (value) => {
				setDistro(value);
				refreshBrowse(browsePath, value);
			};
			const onCheck = async () => {
				const path = normalizeLinuxPath(pathInput);
				setError(null);
				if (!isAbsoluteLinuxPath(path) || path === "/") {
					setError(t("error.invalidPath"));
					return;
				}
				let facts;
				try {
					facts = await check(distro, path);
				} catch {
					setError(t("error.pathNotFound"));
					return;
				}
				if (!facts.exists || !facts.isDirectory) {
					setError(t("error.pathNotFound"));
					return;
				}
				refreshBrowse(path, distro);
			};
			const onConfirm = async () => {
				const path = normalizeLinuxPath(pathInput);
				setError(null);
				if (!isAbsoluteLinuxPath(path) || path === "/") {
					setError(t("error.invalidPath"));
					return;
				}
				const user = username.trim();
				if (user !== "" && !isValidWslUsername(user)) {
					setError(t("error.invalidUsername"));
					return;
				}
				setBusy(true);
				try {
					let facts;
					try {
						facts = await check(distro, path);
					} catch {
						setError(t("error.pathNotFound"));
						return;
					}
					if (!facts.exists || !facts.isDirectory) {
						setError(t("error.pathNotFound"));
						return;
					}
					const failure = await createWorkspace(path, user, distro);
					if (failure !== void 0) {
						setError(failure);
						return;
					}
					setOpen(false);
				} finally {
					setBusy(false);
				}
			};
			const children = (listing?.entries.filter((entry) => entry.kind === "directory") ?? []).map((entry) => entry.name);
			const maskClick = () => {
				if (!busy) setOpen(false);
			};
			const listScroll = () => {};
			const dialog = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dww-overlay",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dww-overlay-mask",
					onClick: maskClick
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dww-card",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("dialog.title"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dww-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "dww-title",
									children: t("dialog.title")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dww-help-btn",
									title: t("help.button"),
									"aria-label": t("help.button"),
									"aria-pressed": helpOpen,
									onClick: () => setHelpOpen((value) => !value),
									children: "?"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dww-close",
									"aria-label": t("dialog.cancel"),
									onClick: maskClick,
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dww-body",
							children: helpOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WslHelp, {
								t,
								description: selfDescription
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								error ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-error",
									children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dww-retry",
										onClick: () => setRetrySeq((sequence) => sequence + 1),
										children: t("dialog.retry")
									})]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-field",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "dww-field-label",
										htmlFor: "dww-distro",
										children: t("dialog.distro")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										id: "dww-distro",
										className: "dww-select",
										value: distro,
										disabled: opening || busy,
										onChange: (event) => onDistroChange(event.target.value),
										children: distros.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: opening ? t("dialog.loading") : ""
										}) : distros.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: name,
											children: name
										}, name))
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-field",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "dww-field-label",
										htmlFor: "dww-path",
										children: t("dialog.path")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dww-input-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "dww-path",
											className: "dww-input",
											value: pathInput,
											placeholder: t("dialog.pathPlaceholder"),
											disabled: opening || busy,
											onChange: (event) => setPathInput(event.target.value)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dww-check-btn",
											disabled: opening || busy,
											onClick: () => void onCheck(),
											children: t("dialog.check")
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-field",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "dww-field-label",
										htmlFor: "dww-username",
										children: t("dialog.username")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "dww-username",
										className: "dww-input",
										value: username,
										placeholder: t("dialog.usernamePlaceholder"),
										disabled: opening || busy,
										autoComplete: "off",
										spellCheck: false,
										onChange: (event) => setUsername(event.target.value)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-feedback",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dww-breadcrumb",
										children: browsePath
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dww-dirlist",
										onScroll: listScroll,
										children: [browsing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dww-dir-empty",
											children: t("dialog.loading")
										}) : listing?.parent !== null && listing !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dww-dir-row dww-dir-row--up",
											onClick: onUp,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WslGlyph, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dialog.upLevel") })]
										}) : null, !browsing && children.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dww-dir-empty",
											children: t("dialog.browseEmpty")
										}) : children.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dww-dir-row",
											onClick: () => onDrill(name),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WslGlyph, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name })]
										}, name))]
									})]
								})
							] })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dww-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dww-btn",
								disabled: busy,
								onClick: maskClick,
								children: t("dialog.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dww-btn dww-btn--primary",
								disabled: busy || opening,
								onClick: () => void onConfirm(),
								children: busy ? t("dialog.loading") : t("dialog.confirm")
							})]
						})
					]
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [trigger, dialog] });
		}
		//#endregion
		//#region src/client/notice.tsx
		/**
		* The plugin's own transient notice — the light receipt the two exits and the
		* creation flow need, mounted through the host's own overlay seat.
		*
		* `shell.overlay` is a `list` slot (`dsh-client-runtime`'s slot registry says so
		* in as many words: for a surface of your own that floats over the whole app,
		* register into `shell.overlay`), so this entry sits beside the host's dialogs
		* instead of opening a second portal this plugin has to keep above them.
		*
		* Why this exists at all: the workspace browser's own notices (`RowToast`) are a
		* CLOSED set of kinds raised by the browser's internal store, and the
		* `workspace.toast` dispatcher only renders while one of those is on screen. A
		* third-party bundle cannot push a kind into it, which is why the exits'
		* receipts and refusals are carried here — the failure half matters as much as
		* the success half, because a refusal the user cannot see is issue #129's
		* silence wearing a new face.
		* @module dsh-wsl-workspace/client/notice
		*/
		/** How long a notice holds before it takes itself down (a refusal gets more). */
		const HOLD_MS = 5e3;
		const ERROR_HOLD_MS = 9e3;
		let current = null;
		let sequence = 0;
		const listeners = /* @__PURE__ */ new Set();
		/** Tell every subscriber the notice changed. */
		function emit() {
			for (const listener of listeners) listener();
		}
		/**
		* Put a notice on screen, replacing whatever was there.
		* @param level - `error` for a refusal, `info` for a receipt.
		* @param title - short line naming what happened.
		* @param body - the detail, including the host's own words when it refused.
		*/
		function raiseWslNotice(level, title, body) {
			current = {
				id: ++sequence,
				level,
				title,
				body
			};
			emit();
		}
		/**
		* Take a notice down, but only the one named — a newer notice must survive the
		* older one's timer.
		* @param id - the notice whose hold expired.
		*/
		function dismissWslNotice(id) {
			if (current === null || current.id !== id) return;
			current = null;
			emit();
		}
		/** The notice on screen, or none. */
		function peekWslNotice() {
			return current;
		}
		/**
		* Observe notice changes.
		* @param listener - called whenever the notice appears, changes or leaves.
		* @returns the unsubscribe.
		*/
		function subscribeWslNotice(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/**
		* The `shell.overlay` entry that renders the notice.
		* @returns the notice card, or nothing while no notice is on screen.
		*/
		function WslNoticeOverlay() {
			const [notice, setNotice] = (0, react.useState)(peekWslNotice());
			(0, react.useEffect)(() => subscribeWslNotice(() => setNotice(peekWslNotice())), []);
			(0, react.useEffect)(() => {
				if (notice === null) return;
				const hold = notice.level === "error" ? ERROR_HOLD_MS : HOLD_MS;
				const timer = window.setTimeout(() => {
					dismissWslNotice(notice.id);
				}, hold);
				return () => {
					window.clearTimeout(timer);
				};
			}, [notice]);
			if (notice === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dww-notice",
				"data-level": notice.level,
				role: "status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dww-notice-title",
						children: notice.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dww-notice-body",
						children: notice.body
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dww-notice-close",
						onClick: () => {
							dismissWslNotice(notice.id);
						},
						children: "×"
					})
				]
			});
		}
		//#endregion
		//#region src/client/sessionMenuExit.tsx
		/**
		* The session's own exit from the WSL world, contributed to the host's row menu.
		*
		* Issue #129 asked for a way out; the answer needs two exits, because two
		* different things a user may mean are two different operations. This is the
		* **session** half: take *this conversation* out of the WSL world while its
		* workspace stays registered (the per-session opt-out lives in
		* `./session-optout.ts`; the workspace half lives in `./workspaceMenuExit.ts`).
		*
		* Unlike the workspace menu, this one is a documented seat:
		* `sidebar.workspaces.session.menu.item` is a `list` slot the workspace browser
		* declares, and the shipped rows — pin (100), rename (200), fork (300), archive
		* (400), session-id (450) — are ordinary entries of it. So this plugin
		* contributes a row the same way instead of mirroring DOM, and the seat hands
		* over the row's `sessionId` outright: no title matching, no guessing which row
		* the open menu belongs to.
		* @module dsh-wsl-workspace/client/sessionMenuExit
		*/
		/**
		* One row of the session menu.
		* @param props - owner share plus this plugin's inject face.
		* @returns the menu row, or nothing for a session the WSL world does not reach.
		*/
		function SessionWslExitRow({ controls, labels, sessionId, useMenuOpenState }) {
			const [, setMenuOpen] = useMenuOpenState();
			const [refusal, setRefusal] = (0, react.useState)(null);
			const buttonRef = (0, react.useRef)(null);
			const [skin, setSkin] = (0, react.useState)({
				button: "",
				label: ""
			});
			(0, react.useEffect)(() => {
				const self = buttonRef.current;
				if (self === null) return;
				const menu = self.closest("[role=\"menu\"]");
				if (menu === null) return;
				const sibling = [...menu.querySelectorAll("button[role=\"menuitem\"]")].find((button) => button !== self);
				if (sibling === void 0) return;
				const labelNode = sibling.querySelector("[class*=\"_itemName\"]") ?? sibling.firstElementChild;
				const next = {
					button: sibling.className,
					label: labelNode?.className ?? ""
				};
				setSkin((previous) => previous.button === next.button && previous.label === next.label ? previous : next);
			});
			const api = controls();
			if (api === null || !api.isWslSession(sessionId)) return null;
			const optedOut = api.optedOut(sessionId);
			const copy = labels();
			const text = refusal !== null ? `${copy.failed}：${refusal}` : optedOut ? copy.rejoin : copy.exit;
			const spanClass = skin.label === "" ? void 0 : skin.label;
			const onClick = () => {
				(optedOut ? api.rejoin(sessionId) : api.exit(sessionId)).then((message) => {
					if (message !== void 0) {
						setRefusal(message);
						raiseWslNotice("error", copy.failed, message);
						return;
					}
					setRefusal(null);
					raiseWslNotice("info", optedOut ? copy.rejoinedTitle : copy.exitedTitle, optedOut ? copy.rejoinedBody : copy.exitedBody);
					setMenuOpen(false);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				ref: buttonRef,
				type: "button",
				role: "menuitem",
				className: skin.button === "" ? "dww-menu-row" : skin.button,
				"data-dww-session-exit": optedOut ? "rejoin" : "exit",
				onClick,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: spanClass,
					children: text
				})
			});
		}
		/**
		* Contribute the exit row to the session menu seat, for as long as that seat is
		* declared.
		*
		* The seat name is typed as a plain string here because
		* `@deepseek-ai/dsh-client-ui-workspace` declares it and the standalone
		* typecheck program of a third-party plugin cannot import that package — the
		* same boundary that makes `uiWorkspace` and `remote.agentPresets` dynamic reads.
		* `slots.inject` waits for the declaration instead of throwing, so a release
		* without the seat contributes nothing rather than failing to mount.
		* @param slots - the client context's slot registry.
		* @param injected - the controls and labels face for this entry.
		* @returns the disposer for the contribution.
		*/
		function mountSessionMenuExit(slots, injected) {
			return slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "wsl-workspace:exit-mode",
				order: 460,
				inject: injected
			}, SessionWslExitRow));
		}
		//#endregion
		//#region src/client/workspaceMenuExit.ts
		/**
		* The workspace's own exit from the WSL world, mirrored into the host's workspace menu.
		*
		* This is the **workspace** half of issue #129's answer: clear the registration
		* itself, so sessions created afterwards are never WSL candidates. The session
		* half has a documented seat (`./sessionMenuExit.tsx`); this one does not. The
		* workspace row's menu is built by the host from a private `items` array
		* (`rename`, `delete.workspace`) handed to ui-primitives' `Menu`, and the
		* browsing region exposes no entry point for it — so the row is mirrored the way
		* the header control and the picker row already are (see `./hostEntry.ts`).
		*
		* Which row the open menu belongs to is *not* guessed from text: the host marks
		* the row whose menu is open with its `menuOpen` class and gives every workspace
		* row a `data-row-key="workspace:<workspaceId>"`. That pair is the target, and
		* the entry is drawn only when the id resolves to a path the plugin's own store
		* carries. No title matching, so a renamed workspace and a duplicated name both
		* land on the right registration.
		* @module dsh-wsl-workspace/client/workspaceMenuExit
		*/
		/** The shipped row this entry follows, in every locale the shell ships. */
		const WORKSPACE_ANCHOR_LABELS = ["删除工作区", "Delete workspace"];
		/** The attribute marking the mirrored row; its value is the registration to clear. */
		const EXIT_ATTRIBUTE = "data-dww-ws-exit";
		/**
		* Which mount drew the row. A page can hold more than one plugin instance (a
		* hot reload, two windows over one DOM in a test), and two instances that
		* disagree about whether a workspace is registered would otherwise each undo the
		* other's row on every mutation — a loop no user needs to see.
		*/
		const EXIT_OWNER_ATTRIBUTE = "data-dww-ws-owner";
		let mountSequence = 0;
		/**
		* Read a menu row's visible label, preferring the shell's own name span because
		* a row may carry a shortcut hint beside it.
		* @param button - the shipped row.
		* @returns the trimmed label text.
		*/
		function rowLabel(button) {
			return (button.querySelector("[class*=\"_itemName\"]")?.textContent ?? button.querySelector("[class*=\"_itemLabel\"]")?.textContent ?? button.textContent ?? "").trim();
		}
		/**
		* The workspace whose row menu is open, from that row's own `data-row-key`.
		* @param root - the document to search.
		* @returns the workspace id, or null when the shell's markup is not this shape.
		*/
		function openWorkspaceId(root) {
			const key = root.querySelector("[class*=\"projectRow\"][class*=\"menuOpen\"]")?.getAttribute("data-row-key");
			if (key === void 0 || key === null || !key.startsWith("workspace:")) return null;
			const id = key.slice(10);
			return id === "" ? null : id;
		}
		/**
		* Clone the shipped delete row into a mirror of our own, label and icon replaced.
		* The clone keeps the shipped wrapper and class list, so the entry inherits the
		* row geometry, hover and focus the host's own rows have.
		* @param anchor - the shipped row this entry follows.
		* @param text - the label to draw.
		* @param owner - the mount that is drawing it.
		* @returns the cloned row element and its button, already inserted after the anchor.
		*/
		function cloneRow(anchor, text, owner) {
			const parent = anchor.parentElement;
			const source = parent === null || parent.getAttribute("role") === "menu" ? anchor : parent;
			const row = source.cloneNode(true);
			const button = row.tagName === "BUTTON" ? row : row.querySelector("button[role=\"menuitem\"]");
			if (button === null) return null;
			row.setAttribute(EXIT_ATTRIBUTE, "");
			row.setAttribute(EXIT_OWNER_ATTRIBUTE, owner);
			button.setAttribute("role", "menuitem");
			button.removeAttribute("aria-keyshortcuts");
			for (const icon of button.querySelectorAll("svg")) icon.remove();
			const label = button.querySelector("[class*=\"_itemName\"]") ?? button.querySelector("[class*=\"_itemLabel\"]");
			if (label === null) button.textContent = text;
			else label.textContent = text;
			source.after(row);
			return {
				row,
				button
			};
		}
		/**
		* Keep the workspace menu's exit row in place. An observer plus a slow interval,
		* because the host re-renders its menu underneath us.
		* @param options - label, target probe and the un-registration action.
		* @returns a disposer that stops the observation and drops the mirrored rows.
		*/
		function mountWorkspaceMenuExit(options) {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const Observer = window.MutationObserver;
			if (Observer === void 0) return () => {};
			const owner = String(++mountSequence);
			const sync = () => {
				for (const menu of [...document.querySelectorAll("[role=\"menu\"]")]) {
					const drawn = menu.querySelector(`[${EXIT_ATTRIBUTE}]`);
					if (drawn !== null && drawn.getAttribute(EXIT_OWNER_ATTRIBUTE) !== owner) continue;
					const anchor = [...menu.querySelectorAll("button[role=\"menuitem\"]")].find((button) => WORKSPACE_ANCHOR_LABELS.includes(rowLabel(button)));
					if (anchor === void 0) {
						drawn?.remove();
						continue;
					}
					const workspaceId = openWorkspaceId(document);
					const path = workspaceId === null ? void 0 : options.registeredPath(workspaceId);
					if (path === void 0) {
						drawn?.remove();
						continue;
					}
					let row = drawn;
					let button = drawn === null ? null : drawn.tagName === "BUTTON" ? drawn : drawn.querySelector("button[role=\"menuitem\"]");
					if (row === null || button === null) {
						const cloned = cloneRow(anchor, options.label(), owner);
						if (cloned === null) continue;
						row = cloned.row;
						button = cloned.button;
						cloned.button.addEventListener("click", () => {
							const target = cloned.row.getAttribute(EXIT_ATTRIBUTE);
							if (target === null || target === "") return;
							options.onExit(target).then((message) => {
								if (message !== void 0) {
									raiseWslNotice("error", options.failedTitle(), message);
									return;
								}
								raiseWslNotice("info", options.doneTitle(), options.doneBody(target));
							});
						});
					}
					row.setAttribute(EXIT_ATTRIBUTE, path);
				}
			};
			let observer = null;
			try {
				observer = new Observer(sync);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
			} catch {
				observer = null;
			}
			const timer = window.setInterval(sync, 1e3);
			sync();
			return () => {
				observer?.disconnect();
				window.clearInterval(timer);
				for (const stale of document.querySelectorAll(`[${EXIT_OWNER_ATTRIBUTE}="${owner}"]`)) stale.remove();
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Third-party stylesheet injection for the WSL workspace UI (the plugin
		* builds no CSS bundle, so styles are injected as one idempotent `<style>`).
		* Colors derive exclusively from the `--dsw-*` design tokens.
		*/
		const STYLE_TAG_DATA_ATTRIBUTE = "data-plugin=\"dsh-wsl-workspace\"";
		const STYLES = `
/* Sidebar-foot icon action beside Settings (28px round in the wide sidebar,
   36px round in the rail), matching the shell's icon-button language. */
.dww-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition:
    background-color 120ms var(--dsw-ease-in-out, ease-in-out),
    color 120ms var(--dsw-ease-in-out, ease-in-out);
}
.dww-action:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dww-action:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-pressed, var(--dsw-alias-interactive-bg-hover));
}
.dww-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dww-action:disabled { cursor: default; opacity: 0.6; }
.dww-action--rail {
  width: 36px;
  height: 36px;
}
/* Same box as the shell's own footer actions: the base rule's 50% radius resolves per axis,
   so a wide box needs the length restated or it draws an ellipse. */
.dww-action--wide {
  flex: 0 0 auto;
  width: 100%;
  height: 42px;
  padding: 0 10px 0 8px;
  justify-content: flex-start;
  border-radius: 12px;
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
}
/* The base rule is the dimmed rail tone. */
.dww-action--rail,
.dww-action--wide { color: var(--dsw-alias-label-primary); }
.dww-action svg { flex: none; }

/* The W letter mark of the sidebar action (sized for wide/rail buttons). */
.dww-letter {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  user-select: none;
}
.dww-action--rail .dww-letter { font-size: 17px; }
/* The neighbours start their label at 8 + 16 + 8; a 16px box centres the W on that line. */
.dww-action--wide .dww-letter {
  flex: none;
  width: 16px;
  margin-right: 8px;
  text-align: center;
}

/* Full-viewport overlay + centered card (mirrors the platform Mask/Dialog). */
.dww-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dww-overlay-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.dww-card {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  max-height: min(640px, 90vh);
  padding: 0 0 20px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  font-family: var(--dsw-font-family);
}
.dww-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 18px 20px 12px;
}
.dww-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dww-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.dww-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dww-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 0 20px;
  overflow: auto;
}
.dww-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dww-field-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dww-select {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dww-input-row { display: flex; gap: 8px; align-items: center; }
.dww-input {
  box-sizing: border-box;
  flex: 1;
  height: 36px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dww-input:focus, .dww-select:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dww-check-btn {
  flex: none;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 12px;
}
.dww-check-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-check-btn:disabled { cursor: default; }

/* Directory browse list. */
.dww-dirlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  min-height: 120px;
  max-height: 200px;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.dww-feedback {
  /* The browse block: the path above the listing, as one visual group. It carried a class in
     AddWslWorkspace.tsx and no rule here, so the breadcrumb sat flush against the list box with
     nothing tying them together — the two read as unrelated rows rather than as one path-and-tree
     control. The listing keeps its own border (.dww-dirlist below); this only groups them. */
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dww-breadcrumb {
  padding: 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dww-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.dww-dir-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-dir-row:disabled { cursor: default; color: var(--dsw-alias-label-tertiary); }
.dww-dir-row--up { color: var(--dsw-alias-label-secondary); }
.dww-dir-row svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.dww-dir-empty {
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Error strip. */
.dww-error {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dww-retry {
  margin-left: 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}

/* Dialog footer actions. */
.dww-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 0;
}
.dww-btn {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 14px;
}
.dww-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dww-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dww-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dww-btn:disabled { cursor: default; opacity: 0.6; }
/* Help panel behind the dialog's "?" button. */
.dww-help-btn {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.dww-help-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dww-help-btn[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dww-help {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 4px;
}
.dww-help-section { display: flex; flex-direction: column; gap: 6px; }
.dww-help-greeting {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dww-help-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dww-help-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dww-help-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dww-help-chip {
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dww-help-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dww-help-list--known { color: var(--dsw-alias-label-primary); }
.dww-help-footer {
  display: flex;
  gap: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dww-help-link { font-size: 12px; color: var(--dsw-alias-label-tertiary); text-decoration: underline; }
.dww-help-link:hover { color: var(--dsw-alias-label-primary); }

/* The footer row stays mounted in a wide sidebar because the header entry
   discovers its seat from it; it is hidden, not removed, once that entry is
   in place. (A class rule beats the UA's [hidden] display:none.) */
.dww-action[hidden] { display: none !important; }

/* The header entry: the add control's own class list carries the box, so this
   seat only groups it with the strip. The strip caps at 60px for two 28px
   controls, so one more control needs the cap widened; the search-expanded
   state must still collapse it. */
.dww-header-slot {
  display: flex;
  flex: none;
  align-items: center;
}
[class*='_headerActions']:has(.dww-header-entry) { max-width: 92px; }
[class*='_headerActions'][class*='_headerActionsHidden']:has(.dww-header-entry) { max-width: 0; }

/* The mode menu is built and measured with every mode before this plugin trims
   it; hold that untrimmed frame (and its backdrop) invisible so it cannot
   flash above the anchor before the trimmed list has been placed. */
[role='menu']:has(button[role='menuitem'] [class*='_itemName']):not([data-dww-presets-ready]) {
  visibility: hidden !important;
}
body[data-dww-presets-pending] [data-menu-backing] {
  visibility: hidden !important;
}

/* The plugin's own notice, rendered inside the host's overlay seat. It reuses
   the card geometry and the shell's own alias tokens, so it reads as one of the
   shell's surfaces rather than a browser dialog. The seat is click-through by
   default, so the card opts itself back in. */
.dww-notice {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 360px;
  padding: 12px 34px 12px 14px;
  border: 1px solid var(--dsw-alias-interactive-border-default);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-surface-elevated);
  box-shadow: var(--dsw-alias-shadow-elevated);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 18px;
  pointer-events: auto;
}
.dww-notice[data-level='error'] {
  border-color: var(--dsw-alias-state-error);
}
.dww-notice-title { font-weight: 600; }
.dww-notice-body {
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dww-notice-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.dww-notice-close:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Fallback for a menu row contributed to a seat whose shipped rows this plugin
   cannot read a class list from (a release that restructured the menu). */
.dww-menu-row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  text-align: start;
  cursor: pointer;
}
.dww-menu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
`;
		/**
		* Idempotently inject the plugin stylesheet. No-op when a tag with the
		* plugin's data attribute already exists.
		*/
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[${STYLE_TAG_DATA_ATTRIBUTE}]`) !== null) return;
			const style = document.createElement("style");
			style.setAttribute("data-plugin", "dsh-wsl-workspace");
			style.textContent = STYLES;
			document.head.appendChild(style);
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Bilingual dictionaries for the `wslWorkspace` locale namespace. Product copy
		* is Chinese; English is the parallel export for the standalone bundle.
		*/
		/**
		* The `wslWorkspace` translations (Chinese, the primary product copy).
		*/
		const zh = {
			"action.add": "WSL工作区",
			"action.title": "添加 WSL 工作区…",
			"action.entry": "添加WSL工作区",
			"exit.session": "退出 WSL 模式",
			"exit.session.rejoin": "重新启用 WSL 模式",
			"exit.workspace": "退出 WSL 工作区",
			"exit.failed": "更改 WSL 模式失败",
			"exit.session.done": "该会话已退出 WSL 模式",
			"exit.session.done.body": "这个会话改按普通模式运行；工作区仍保持登记，其他会话不受影响。",
			"exit.session.rejoin.done": "该会话已重新启用 WSL 模式",
			"exit.session.rejoin.done.body": "bash 与文件工具重新落在该发行版内。",
			"exit.workspace.done": "已退出 WSL 工作区",
			"exit.workspace.done.body": "登记记录已删除，之后的新会话不再使用 WSL 模式。路径：",
			"exit.workspace.failed": "删除 WSL 登记失败",
			"exit.toast": "已登记为 WSL 工作区",
			"exit.toast.body": "新会话会自动用 WSL 模式。要退出：工作区菜单选「退出 WSL 工作区」，或只在某一个会话的菜单里选「退出 WSL 模式」。",
			"dialog.title": "添加 WSL 工作区",
			"dialog.distro": "发行版",
			"dialog.path": "路径",
			"dialog.pathPlaceholder": "/home/",
			"dialog.username": "用户名",
			"dialog.usernamePlaceholder": "留空则使用发行版默认用户",
			"dialog.loading": "正在加载…",
			"dialog.browseEmpty": "此目录没有子文件夹",
			"dialog.upLevel": "..（返回上级）",
			"dialog.browse": "浏览",
			"dialog.check": "检查",
			"dialog.confirm": "创建并打开",
			"dialog.cancel": "取消",
			"dialog.retry": "重试",
			"error.loadDistros": "无法获取 WSL 发行版列表，请确认已安装 WSL 且插件宿主端可用",
			"error.rateLimited": "操作过于频繁，请稍后重试",
			"error.loadDir": "无法浏览该目录",
			"error.presetMissing": "未找到健康的 wsl preset，请确认插件宿主端已安装并配置该 preset",
			"error.presetPending": "wsl 变体还在生成中，请稍后重试；若长时间没有变体请查看宿主端日志",
			"error.presetBroken": "部分 wsl 变体没有发布出来：",
			"error.presetBrokenCount": "已发布 ",
			"error.presetBrokenOne": "• ",
			"error.presetBrokenMore": "…… 未列出的失败变体数：",
			"error.invalidPath": "请输入以 / 开头的 Linux 绝对路径",
			"error.invalidUsername": "用户名无效：需以字母或下划线开头，仅含字母、数字、_、.、-",
			"error.pathNotFound": "该路径不存在或是文件，请选择一个文件夹",
			"error.createFailed": "创建工作区失败",
			"help.button": "插件说明",
			"help.greeting": "当你看到这句话的时候，说明你的插件已经Cia进来llo～(∠・ω< )⌒★，star一下吗？",
			"help.greeting.repo": "github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace",
			"help.compat.title": "兼容性",
			"help.compat.versionLabel": "插件版本",
			"help.compat.unknown": "未能读取版本与兼容声明（宿主端没有响应）",
			"help.compat.body": "上方是这份构建声明兼容的 DSH 版本，每一条都在隔离实例上实测过（独立 DSH_HOME、依赖固定到该版本、跑满整套门禁，含真实 ConPTY 下的持久 shell）。\n插件在运行时自动识别 DSH 版本并选用对应的 API；两边都不支持时会明确报错，而不是留下一个空工作区。\n版本不在列表里通常仍然可用，但未经验证。",
			"help.news.title": "本次更新（0.7.12）",
			"help.news.body": "本次更新补的是“别的 agent 能不能照着包里的说明用起来”。\n- `describe` 现在直接给出路由、仅环回、方法表、安装校验用的字面量与 driving 卡。\n- 随包发布 `docs/driving.zh.md`：起实例（含必须删掉的 `ELECTRON_RUN_AS_NODE`）、登录 URL 与 token、调用插件、驱动 composer、换 provider。\n- 两份 README 声明哪些路径只在仓库里；两把文档闸挂在 `npm run test:unit` 末尾。\n- 细节见 CHANGELOG 的 0.7.12 段。",
			"help.usage.title": "用法与特性",
			"help.usage.body": "点击工作区区头的 W 按钮（或在「添加工作区」菜单里直接选「添加WSL工作区」）→ 选发行版 → 输入或浏览 Linux 路径 → 检查 → 创建并打开。\n创建出的会话里，bash 与文件工具都落在该发行版内，模型看到的路径全是 Linux 路径；Windows 盘可从会话内通过 /mnt/<盘符> 访问。\n四种模式（标准 / PTC / 极简 / 创造）各有 WSL 变体，在模式选择器里直接选即可，名字形如 WSL · Standard mode（标准模式）。\n用户名可选，等价于 wsl.exe -u <用户名>，只改变 bash 与 persistent-bash 的运行身份；文件工具走 Windows 侧共享，不受它影响。\n技能目录从会话 cwd 最近的 .git 祖先开始向下扫描 .dsh/skills 与 .agents/skills（含嵌套项目），上限 4 层目录 / 64 个技能目录 / 4096 个已访问目录，并按扫描根缓存 10 秒。9P 解不开的符号链接交给发行版 readlink 解析出真实路径（每次查找最多 32 条）后继续扫描，链接进来的项目与它下面的嵌套项目都能扫到。\n目录不再冻结：对 UNC 关闭文件监视之后，插件每 3 秒重查一次已发布的技能目录、并比对每个技能文件的修改时间与大小，所以新增、删除与改写都会在下一个回合生效；完整重新发现每 30 秒一次，用于找到此前不存在的技能目录（技能正文始终实时读取）。\n文件搜索由发行版内的 grep / glob 提供，源预设没有这两个工具的模式（极简）不会多出来：grep 用 GNU grep -E（\\d、\\w、(?i) 可用，环视与反向引用不支持），跳过隐藏项与 node_modules，不读 .gitignore；glob 用 GNU find 列文件、按 gitignore 风格匹配（* 不跨目录、** 跨、{a,b}、前导 ! 取反），按修改时间从旧到新排序。\n文件工具在链接处按真实路径工作，并按真实路径判策略：链接指向工作区外就等于工作区外。\nbash 由插件自持的会话 shell 提供（管道驱动，完成信号是本次调用独有的记录）：登录环境、起始目录就是会话工作区，cd / export / 别名 / 函数 / venv / 后台任务跨调用保留；shell 不再应答时按台账重建并重放。\n它会认出在等键盘输入的程序，停下并改用伪终端重跑一遍（正文写明跑过两次）；需要能敲键的终端时（sudo 密码、ssh 首次指纹、REPL、TUI）用 wsl_terminal 开一扇门。\n命令要读标准输入就传 stdin：上限 32 KiB，超了会点名拒绝且什么都不执行。宿主那条 PTY 常驻 shell 保留为对照档，只有 DSH_WSL_PTY_SHELL=1 才挂它。\n需要可跟踪的后台任务时用 bash_background：它立刻返回 job id，job_list / job_output（增量读取）/ job_kill 都作用于它；bash 本身没有 run_in_background 参数，传了会被忽略。job id 只在本次 DSH 进程内唯一，重启后会重新编号，引用前先用 job_list 确认。\nbash 与文件工具的 shell 都在发行版内运行、不受 DSH 文件策略约束；文件工具（read/write/edit）受策略约束，工作区内修改模式下只能写工作区内。\n图片用 read_image 读取：在发行版内解析路径、返回图像本身（PNG/JPEG/WebP/GIF，大图为宿主统一缩放），这条世界内的读取修好了 #54 里宿主 read_image 在 wsl 会话恒报 cannot get property \"fs\" without inject 的问题。",
			"help.known.title": "已知问题",
			"help.known.body": "grep 用的是发行版自带的 GNU grep：方言是 POSIX ERE（环视与反向引用不支持），且不读 .gitignore，被 git 忽略的文件照样会被搜到；只有隐藏项、node_modules 与版本库目录会被跳过。发行版没有 GNU grep（如 Alpine 的 busybox）时会明确报错，而不是给出错位的结果。\nglob 的\"按修改时间排序\"依赖 GNU find -printf，busybox 会退化成路径排序；含 / 的 include 在插件进程里过滤，因此那种调用会先扫描全部文件再筛。\n技能目录刷新仍是轮询：已发布目录内的增删改约 3 秒生效，而一个新项目里第一次出现的技能目录要等下一次完整重新发现（最多 30 秒）。\n0.1.0-rc.7 的宿主没有 Windows 进程检查器，PTY 承载的 shell 在那里起不来（宿主自己也这样）；那只影响 DSH_WSL_PTY_SHELL=1 那一档与 wsl_terminal，默认的会话 shell 不需要 PTY、也不需要中继解释器。\n极简模式本身不挂 job_* 工具，所以那个模式里也没有 bash_background（与宿主的极简模式一致）。\n在 DSH Desktop 上，wsl_terminal 与对照档用的中继跑的是 Desktop 自带的那个 node（`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`）——Desktop 自己在启动时会 stat 这个文件，缺了就直接 `DesktopHostFatalError`，所以这条路径不是猜的。\n实测把它改名后，解析链会退到 PATH 上的 node（日志里写 `\"node.exe\" on PATH`）；只有连 PATH 也没有 node 时才退回 Electron 可执行文件，那时那一档的 bash 会以 PTY shell exited during startup 失败，启动日志里写明选中的解释器与被拒绝的候选；默认的会话 shell 不走中继，不受这件事影响。\n文件引用的翻译只认插件自己认定为 WSL 的会话：工作区必须注册成 WSL 工作区（对话框创建的都会注册），否则地址原样不动。\n发行版内的绝对路径还需要知道发行版：UNC 工作区自带，/mnt/<盘符> 工作区取自 wsl-workspaces.json 的记录；那条记录删掉后这类引用不再翻译。/mnt/<盘符> 不受影响——盘符就是盘符。",
			"help.footer.npm": "npm 包",
			"help.footer.repo": "GitHub 仓库"
		};
		/**
		* The `wslWorkspace` translations (English).
		*/
		const en = {
			"action.add": "WSL Workspace",
			"action.title": "Add WSL workspace…",
			"action.entry": "Add WSL workspace",
			"exit.session": "Exit WSL mode",
			"exit.session.rejoin": "Re-enable WSL mode",
			"exit.workspace": "Exit WSL workspace",
			"exit.failed": "Could not change the WSL mode",
			"exit.session.done": "This session left WSL mode",
			"exit.session.done.body": "The session now runs as a plain one; the workspace stays registered and other sessions are unaffected.",
			"exit.session.rejoin.done": "This session is back in WSL mode",
			"exit.session.rejoin.done.body": "bash and the file tools run inside the distribution again.",
			"exit.workspace.done": "Left the WSL workspace",
			"exit.workspace.done.body": "The registration is deleted, so new sessions no longer use WSL mode. Path: ",
			"exit.workspace.failed": "Could not delete the WSL registration",
			"exit.toast": "Registered as a WSL workspace",
			"exit.toast.body": "New sessions open in a WSL mode. To undo it: choose \"Exit WSL workspace\" in the workspace menu, or \"Exit WSL mode\" in one session’s menu.",
			"dialog.title": "Add WSL workspace",
			"dialog.distro": "Distro",
			"dialog.path": "Path",
			"dialog.pathPlaceholder": "/home/",
			"dialog.username": "Username",
			"dialog.usernamePlaceholder": "Leave empty to use the distro default user",
			"dialog.loading": "Loading…",
			"dialog.browseEmpty": "No subdirectories here",
			"dialog.upLevel": ".. (up)",
			"dialog.browse": "Browse",
			"dialog.check": "Check",
			"dialog.confirm": "Create & open",
			"dialog.cancel": "Cancel",
			"dialog.retry": "Retry",
			"error.loadDistros": "Could not list WSL distros; confirm WSL is installed and the plugin host side is reachable",
			"error.rateLimited": "Too many attempts; retry in a moment",
			"error.loadDir": "Could not browse this directory",
			"error.presetMissing": "No healthy \"wsl\" preset found; confirm the plugin host side installed and configured it",
			"error.presetPending": "The wsl variants are still being generated; retry in a moment, and read the host log if none appear",
			"error.presetBroken": "Some wsl variants did not publish:",
			"error.presetBrokenCount": "Published ",
			"error.presetBrokenOne": "• ",
			"error.presetBrokenMore": "… further failures not listed: ",
			"error.invalidPath": "Enter an absolute Linux path starting with /",
			"error.invalidUsername": "Invalid username: start with a letter or underscore; only letters, digits, _ . -",
			"error.pathNotFound": "The path does not exist or is a file; choose a folder",
			"error.createFailed": "Failed to create the workspace",
			"help.button": "About this plugin",
			"help.greeting": "If you can read this, the plugin has already Cia~llo'd its way in～(∠・ω< )⌒★ Care to star the repo?",
			"help.greeting.repo": "github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace",
			"help.compat.title": "Compatibility",
			"help.compat.versionLabel": "Plugin version",
			"help.compat.unknown": "Version and compatibility declaration unavailable (the host side did not answer)",
			"help.compat.body": "The chips above are the DSH releases this build declares, each verified on an isolated instance (own DSH_HOME, dependencies pinned to that release, full check suite).\nThe plugin detects the DSH generation at runtime and picks the matching API; a release exposing neither fails loudly instead of leaving an empty workspace.\nA release outside the list usually still works, but is unverified.",
			"help.news.title": "What's new in 0.7.12",
			"help.news.body": "This build answers a different question: can another agent use the package from its own shipped text?\n- `describe` now returns the route, the loopback fence, the method table, the install-proof marker and a driving card.\n- `docs/driving.md` ships and answers five questions: headless start (including the variable that must be unset), login URL and token, calling the plugin, driving the composer, and moving off a 401 provider.\n- The READMEs declare which paths are repository-only, and two document gates run at the end of `npm run test:unit`.\nThe details are in the 0.7.12 section of CHANGELOG.",
			"help.usage.title": "Usage and features",
			"help.usage.body": "Click the W button in the Workspaces section header (or pick “Add WSL workspace” in the “Add workspace…” menu), pick a distribution, type or browse to a Linux path, press Check, then Create & open.\nIn that session the bash tool and the file tools run inside the distribution, so every path the model sees is a Linux path; Windows drives stay reachable as /mnt/<drive>.\nEach mode (Standard / PTC / Minimal / Creator) has a WSL variant in the mode picker, named like WSL · Standard mode.\nThe optional username behaves like wsl.exe -u <user> for bash and persistent-bash; the file tools go through the Windows-side share and are unaffected.\nThe skill catalog is discovered from the nearest .git ancestor of the session cwd downwards (.dsh/skills and .agents/skills, nested projects included), bounded to 4 levels / 64 skill directories / 4096 visited directories, and cached per scan root for 10 seconds.\nA link the share cannot follow is resolved through the distribution (wsl.exe readlink, at most 32 per lookup) and the scan continues at the real path, so a linked-in project and its own nested projects are found too.\nThe catalog is not frozen: published skills directories are re-checked every 3 seconds (skill file mtime + size), so an add, remove or edit appears on the next turn; a 30-second walk finds a skills directory that did not exist before.\nFile search comes from grep / glob inside the distribution, and a mode that mounts no search suite (Minimal) gains none. grep is GNU grep -E (no lookaround or backreferences), skips hidden entries and node_modules, and does not read .gitignore; glob matches gitignore-style patterns here, oldest first.\nThe file tools work at the resolved real path of a link, and the policy is judged there too: a link out of the workspace is an outside write.\n`bash` is a session shell this plugin drives over a pipe: login environment, the session workspace as its starting directory, and cd / exports / aliases / functions / venv / background jobs survive between calls — a shell that stops answering is rebuilt and replayed from the journal.\nIt recognises a command waiting on the keyboard, stops it and re-runs it on a pseudo-terminal inside the same call (the body says it ran twice); for a terminal an agent can type into — `sudo` passwords, first `ssh` fingerprints, REPLs, TUIs — there is `wsl_terminal`.\nA command that reads standard input takes `stdin`: a 32 KiB ceiling, refused by name with nothing executed. The host's PTY-backed persistent shell stays reachable as the comparison tier under `DSH_WSL_PTY_SHELL=1`.\nFor a tracked background job use bash_background: it returns a job id immediately, and job_list / job_output (incremental) / job_kill act on it.\n`bash` itself has no run_in_background parameter and ignores one; job ids are unique within this DSH process, so confirm with job_list before acting on one.\nBoth it and the file tools' shell run inside the distribution, outside the DSH file policy; read/write/edit are inside it, and workspace-write only writes inside the workspace.\nImages are read with read_image: it resolves the path inside the distribution and returns the picture itself (PNG/JPEG/WebP/GIF), downscaled by the host the same way a non-WSL session does.",
			"help.known.title": "Known issues",
			"help.known.body": "grep is the distribution's GNU grep: POSIX ERE (no lookaround or backreferences), and it does not read .gitignore, so git-ignored files are searched too; only hidden entries, node_modules and VCS directories are skipped.\nglob's modification-time order needs GNU find -printf (busybox falls back to path order), and an include containing \"/\" is filtered in this process, so that call scans every file first.\nThe catalog refresh is still a poll: an add, remove or edit inside a published skills directory lands within about 3 seconds, while a new project's first skills directory waits for the next full re-discovery (up to 30 seconds).\n0.1.0-rc.7 has no Windows process inspector, so a PTY-backed shell cannot start there (the host has the same gap). That reaches only the `DSH_WSL_PTY_SHELL=1` tier and `wsl_terminal`; the default session shell needs no PTY and no relay interpreter.\nMinimal mode mounts no job_* tools, so it gets no bash_background either - the same as the host's own Minimal mode.\nOn DSH Desktop the relay that `wsl_terminal` and the comparison tier type through runs on the node bundled with the Desktop (resources/runtime/primary-runtime/dependencies/node/bin/node.exe). The Desktop stats that file at boot and dies with DesktopHostFatalError without it, so the path is not a guess.\nRenaming it away made the resolution fall through to a node on PATH (\"node.exe\" on PATH, in the log); only with no node anywhere does it fall back to the Electron executable, where that tier's bash fails with \"PTY shell exited during startup\" and the log names every rejected candidate.\nThe default session shell does not go through the relay, so none of that reaches it.\nReference translation only applies to sessions the plugin itself recognizes as WSL ones: the workspace must be registered as a WSL workspace (everything the dialog creates is), otherwise addresses are left alone.\nAn in-distribution absolute path also needs the distribution: a UNC workspace carries it, a /mnt/<drive> workspace takes it from the record in wsl-workspaces.json, and deleting that record stops those references from being translated. /mnt/<drive> paths are unaffected - the mount name is the drive.",
			"help.footer.npm": "npm package",
			"help.footer.repo": "GitHub repository"
		};
		//#endregion
		//#region src/client/references.ts
		/**
		* File-reference path translation for the client half.
		*
		* A conversation's file references, the Files panel, and a turn tail's produced
		* files all open a file through the right Sidebar's navigation controller:
		* `ctx.sidebarRight.openResource(address)`. The address is a
		* `dsh-resource://file/session/<sessionId>/<path>` URL carrying the path EXACTLY
		* as it was written, and for a WSL session the model writes absolute LINUX
		* paths. The host decodes that address and resolves the path with
		* `node:path.resolve(cwd, path)`, where a POSIX absolute path is root-relative:
		* `/mnt/d/x` lands on the workspace drive (`D:\mnt\d\x`) and an in-distribution
		* path lands under the cwd share's root. Neither is the file the model named, so
		* the document pane reports `error.notFound` — or `EPERM`, for the drvfs mount
		* 9P cannot serve.
		*
		* The plugin cannot repair this on the host plane: `fs` and the
		* `workspaceFiles` endpoint belong to other plugins, and cordis refuses a second
		* `provide` for a name another fiber owns (`ctx.provide` "throws if the name is
		* already provided in this scope"), while neither publishes a path-resolution
		* hook. What the client half CAN do is hand the Sidebar the address of the file
		* the model actually meant, which is what this module computes. One hook at the
		* single navigation entry point covers every reference surface, because the
		* address a tab carries is also the address its metadata is read under.
		*
		* @module dsh-wsl-workspace/client/references
		*/
		/** The scheme and type every file address opens with. */
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
		/** The address scope whose path is resolved against one session's workspace. */
		const SESSION_SCOPE = "session";
		/**
		* Component-encode one id or path segment, keeping `:` literal for drive
		* letters — the same rule `@deepseek-ai/dsh-util-workspace-path` encodes with.
		* @param segment - one path segment or the session id.
		* @returns the encoded segment.
		*/
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}
		/**
		* Build the address of a file read through one Session.
		*
		* Mirrors `sessionFileAddress` from `@deepseek-ai/dsh-util-workspace-path`,
		* which cannot be imported here: six of the eleven declared DSH releases
		* (0.1.0-rc.7 … 0.1.3-alpha.2) ship no such package, or ship it without the
		* address grammar — that arrived with the document preview itself, in
		* 0.1.5-rc.1. The grammar is the wire contract both halves already share.
		* @param sessionId - the Session whose workspace resolves the path.
		* @param path - absolute or workspace-relative path.
		* @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
		*/
		function sessionFileAddress(sessionId, path) {
			const encoded = toPosixSpelling(path).replace(/^(?:\.\/)+/, "").split("/").map(encodeSegment).join("/");
			return `${FILE_ADDRESS_PREFIX}${SESSION_SCOPE}/${encodeSegment(sessionId)}/${encoded}`;
		}
		/**
		* Read a `session`-scoped file address back into its parts.
		*
		* Mirrors `parseFileAddress` from `@deepseek-ai/dsh-util-workspace-path` for the
		* one scope this hook rewrites. Query and fragment suffixes are ignored, so a
		* caller that appended navigation parameters still matches.
		* @param address - a candidate address.
		* @returns the parts, or `null` for anything this hook does not understand.
		*/
		function parseSessionFileAddress(address) {
			if (!address.startsWith(FILE_ADDRESS_PREFIX)) return null;
			const end = address.search(/[?#]/);
			const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
			if (scope !== SESSION_SCOPE) return null;
			const [id, ...segments] = rest;
			if (id === void 0 || id === "" || segments.length === 0) return null;
			try {
				return {
					sessionId: decodeURIComponent(id),
					path: segments.map(decodeURIComponent).join("/")
				};
			} catch {
				return null;
			}
		}
		/** Whether a path is absolute in either spelling the host accepts. */
		function isAbsolutePath(path) {
			return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
		}
		/**
		* Build the address for a path as a caller holds it, relative to the session's
		* workspace when it lies inside it. Mirrors `fileAddressFor` from
		* `@deepseek-ai/dsh-util-workspace-path`: keeping a translated path inside the
		* workspace makes the address identical to the one the Files panel builds for
		* the same file, so the Sidebar reveals the open tab instead of duplicating it.
		* @param sessionId - the Session the path is read in.
		* @param cwd - that Session's workspace root.
		* @param path - the path to address.
		* @returns the `dsh-resource://file/…` address.
		*/
		function fileAddressFor(sessionId, cwd, path) {
			const normalized = toPosixSpelling(path);
			if (!isAbsolutePath(normalized)) return sessionFileAddress(sessionId, normalized);
			const root = cwd === void 0 ? "" : toPosixSpelling(cwd).replace(/\/+$/, "");
			if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
			if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
			return sessionFileAddress(sessionId, normalized);
		}
		/**
		* The address of the file a WSL session's reference actually names.
		*
		* Anything the hook does not fully understand is returned untouched: an address
		* outside this scope, a path that is already host-readable, a session the plugin
		* does not know, or a path whose distribution is unknown. Rewriting is only
		* worth doing when the result is certain to name the same file, so a
		* non-matching address is a pass-through rather than a guess.
		* @param address - the address a caller is about to open.
		* @param sessionOf - the lookup answering each address's session.
		* @returns the address to open: the translated one, or the caller's own.
		*/
		function rewriteReferenceAddress(address, sessionOf) {
			const parsed = parseSessionFileAddress(address);
			if (parsed === null) return address;
			if (!address.startsWith(sessionFileAddress(parsed.sessionId, parsed.path))) return address;
			const session = sessionOf(parsed.sessionId);
			if (session === void 0) return address;
			const translated = hostPathForLinuxReference(parsed.path, session.distro);
			if (translated === null) return address;
			return fileAddressFor(parsed.sessionId, session.cwd, translated);
		}
		/**
		* The distribution a session's workspace belongs to.
		*
		* A UNC cwd names it directly. A drive cwd is a `/mnt/<drive>` workspace, whose
		* distribution the host stored at registration time and the client caches; when
		* that cache is empty the answer is `undefined` and in-distribution references
		* stay untranslated rather than being rewritten to a wrong share.
		* @param cwd - the session's workspace root.
		* @param driveDistros - registered Windows drive workspaces, by canonical key.
		* @returns the distribution name, or undefined when it is not known.
		*/
		function distroOfWorkspace(cwd, driveDistros) {
			const unc = parseWslUnc(cwd);
			if (unc !== null) return unc.distro;
			const canonical = canonicalWindowsPath(cwd);
			return canonical === null ? void 0 : driveDistros.get(canonical);
		}
		/**
		* Whether a workspace root makes its sessions WSL-bound: a WSL UNC path, or a
		* Windows drive path registered as a `/mnt/<drive>` workspace (9P cannot serve
		* drvfs, so those workspaces carry drive cwds).
		* @param cwd - the session's workspace root.
		* @param wslWindowsPaths - canonical drive keys of the registered `/mnt/<drive>` workspaces.
		* @returns whether the session runs in the WSL world.
		*/
		function isWslWorkspace(cwd, wslWindowsPaths) {
			if (isWslUnc(cwd)) return true;
			const canonical = canonicalWindowsPath(cwd);
			return canonical !== null && wslWindowsPaths.has(canonical);
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"sessions",
			"workspaces"
		];
		/** The legacy standalone WSL preset id (folded into the mode variants). */
		const LEGACY_WSL_PRESET_ID = "wsl";
		/**
		* The session-level exit, published by the mode-variant binding effect below.
		*
		* That effect is the only place holding the roster, the select channel and the
		* opt-out list together, so it owns the implementation; the host context-menu
		* mirror renders from here. A boot without the effect (no sessions service)
		* leaves this null and the menu offers nothing rather than half-working.
		*/
		let sessionWslControls = null;
		/**
		* Mount the sidebar action and the auto-binding effect.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const workspaces = ctx.get("workspaces");
			const sessions = ctx.get("sessions");
			const legacyApi = () => ctx.get("connection")?.api;
			const remoteAgentPresets = () => ctx.get("remote.agentPresets");
			const uiWorkspaceService = () => ctx.get("uiWorkspace");
			const hasNoteAgentPreset = typeof sessions.noteAgentPreset === "function";
			/** Unified agent-preset list: new `remote.agentPresets` namespace (v0.1.2-rc.1+) or legacy `connection.api` (v0.1.1-rc.2). */
			const listAgentPresets = async () => {
				const agentPresets = remoteAgentPresets();
				if (agentPresets !== void 0) {
					const r = await agentPresets.list();
					if (!r.ok) return {
						ok: false,
						presets: [],
						error: r.error?.message ?? "list failed"
					};
					return {
						ok: true,
						presets: r.value?.presets ?? []
					};
				}
				const api = legacyApi();
				if (api !== void 0) {
					const r = await api.agentPresets.list({});
					if (!r.result.ok) return {
						ok: false,
						presets: [],
						error: r.result.error?.message ?? "list failed"
					};
					return {
						ok: true,
						presets: r.result.value?.presets ?? []
					};
				}
				return {
					ok: false,
					presets: [],
					error: "no remote api available"
				};
			};
			/**
			* Unified agent-preset select: new `agentPresets.select(id, preset)` or legacy
			* `connection.api.select({...})`.
			*
			* The refusal travels with the result because the session-level exit has to
			* say *why* it did not happen: the host locks a preset once a session has
			* produced output, and a row that simply stays there is issue #129's silence
			* again.
			*/
			const selectAgentPreset = async (sessionId, presetId) => {
				const agentPresets = remoteAgentPresets();
				if (agentPresets !== void 0) {
					const r = await agentPresets.select(sessionId, presetId);
					return r.ok ? { ok: true } : {
						ok: false,
						error: r.error?.message ?? `${presetId}: the host refused the change`
					};
				}
				const api = legacyApi();
				if (api !== void 0) {
					const r = await api.agentPresets.select({
						sessionId,
						agentPreset: presetId
					});
					return r.result.ok ? { ok: true } : {
						ok: false,
						error: r.result.error?.message ?? `${presetId}: the host refused the change`
					};
				}
				return {
					ok: false,
					error: `${presetId}: this release exposes no agent-preset channel`
				};
			};
			/**
			* Resolve how this release opens a session for a workspace - v0.1.2-rc.1+
			* exposes `uiWorkspace.startSession`, v0.1.1-rc.2 keeps it on `workspaces`.
			*
			* Resolved BEFORE the workspace is written. A release that offers neither
			* cannot open a session, and a silent fall-through would leave the workspace
			* behind with an empty `sessionIds` while the dialog still reports success;
			* failing here names the missing capability instead.
			* @returns the starter for the service this release actually exposes.
			* @throws Error naming both candidates when neither service is available.
			*/
			const resolveSessionStarter = () => {
				const ui = uiWorkspaceService();
				if (ui !== void 0) return (workspaceId) => {
					ui.startSession(workspaceId);
				};
				const legacyStart = workspaces.startSession;
				if (typeof legacyStart === "function") return (workspaceId) => {
					Reflect.apply(legacyStart, workspaces, [workspaceId]);
				};
				throw new Error("workspace session API unavailable: this DSH release exposes neither uiWorkspace.startSession nor workspaces.startSession");
			};
			/** Read agent preset — v0.1.2-rc.1+ uses projectionValues; v0.1.1-rc.2 uses direct field. */
			const getAgentPreset = (summary) => {
				if (summary.projectionValues?.agentPreset !== void 0) {
					const v = summary.projectionValues.agentPreset;
					return v === null ? void 0 : v;
				}
				return summary.agentPreset;
			};
			/** Note preset change — v0.1.1-rc.2 calls noteAgentPreset; v0.1.2-rc.1+ is auto-synced via projection. */
			const noteAgentPresetCompat = (sessionId, presetId) => {
				if (hasNoteAgentPreset && sessions.noteAgentPreset) sessions.noteAgentPreset(sessionId, presetId);
			};
			ensureStyles();
			ctx.effect(() => ctx.locale.register("wslWorkspace", {
				zh,
				en
			}), "dsh-wsl-workspace: locale dictionaries");
			const t = ctx.locale.bind("wslWorkspace");
			let wslWindowsPaths = /* @__PURE__ */ new Set();
			let driveDistros = /* @__PURE__ */ new Map();
			let brokenVariants = /* @__PURE__ */ new Map();
			let seenGeneration;
			/**
			* Compose the message for a generation that published only some of its
			* variants, out of the host's own failure records.
			*
			* The detail lines are assembled HERE rather than through `t()`: the bound
			* translate function comes from `@deepseek-ai/dsh-client-locale`, whose
			* interpolation support this repository cannot verify, so `t()` supplies
			* only a prefix and the client supplies the evidence. A rewording of the
			* host's `reason` would also defeat the purpose — the reason is the thing
			* the user cannot see anywhere else.
			* @param failed - the host's per-variant failures, already capped host-side.
			* @param truncated - how many failures the host's own cap dropped.
			* @param count - the host's own tally, when this boot has one. Omitted on the roster path: see
			*   below for why a number derived from the roster would not be the same number.
			* @returns one message naming every failed variant and its cause.
			*/
			const brokenMessage = (failed, truncated, count) => {
				const lines = [t("error.presetBroken")];
				if (count !== void 0) lines.push(`${t("error.presetBrokenCount")}${count.produced}/${count.sources}`);
				for (const failure of failed) lines.push(`${t("error.presetBrokenOne")}${failure.id}：${failure.reason}`);
				if (truncated > 0) lines.push(`${t("error.presetBrokenMore")}${truncated}`);
				return lines.join("\n");
			};
			/** The receipt the creation flow leaves behind: what happened, and where the way out is. */
			const noticeCreated = () => {
				raiseWslNotice("info", t("exit.toast"), t("exit.toast.body"));
			};
			/** The session menu row's copy, read per render so a language change lands. */
			const sessionExitLabels = () => ({
				exit: t("exit.session"),
				rejoin: t("exit.session.rejoin"),
				failed: t("exit.failed"),
				exitedTitle: t("exit.session.done"),
				exitedBody: t("exit.session.done.body"),
				rejoinedTitle: t("exit.session.rejoin.done"),
				rejoinedBody: t("exit.session.rejoin.done.body")
			});
			/** Is this a WSL workspace's row, from the host's own path for it? */
			const registeredWslPath = (workspaceId) => {
				const item = workspaces.list?.getSnapshot().items.find((view) => view.workspaceId === workspaceId);
				if (item === void 0) return void 0;
				return isWslWorkspace(item.path, wslWindowsPaths) ? item.path : void 0;
			};
			/**
			* Drop the workspace's WSL registration and retire what this page derived from it.
			*
			* The drive key set is what makes a `/mnt/<drive>` cwd look like WSL, so
			* leaving it behind would keep binding new sessions to a workspace the user
			* just opted out of, until the sixty-second refresh happened to clear it.
			* @param path - the workspace path as the host spells it.
			* @returns undefined on success, the host's own refusal otherwise.
			*/
			const exitWorkspace = async (path) => {
				let removed;
				try {
					removed = (await removeWorkspace(path)).removed;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
				const canonical = canonicalWindowsPath(removed);
				if (canonical !== null) {
					wslWindowsPaths = new Set([...wslWindowsPaths].filter((key) => key !== canonical));
					driveDistros = new Map([...driveDistros].filter(([key]) => key !== canonical));
					maybeBindNow();
				}
			};
			/**
			* The binding pass, published by the mode-variant effect below so an exit can
			* re-run it immediately instead of waiting for the next store change. A no-op
			* until that effect mounts.
			*/
			let maybeBindNow = () => {};
			const injected = () => ({
				t,
				checkPreset: async () => {
					let outcome;
					try {
						outcome = await variantStatus();
					} catch {
						outcome = void 0;
					}
					if (outcome !== void 0) {
						if (seenGeneration !== void 0 && outcome.generation < seenGeneration) return;
						seenGeneration = outcome.generation;
					}
					let roster;
					try {
						roster = await listAgentPresets();
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
					if (!roster.ok) return roster.error;
					const variants = roster.presets.filter((entry) => entry.id.startsWith("wsl-"));
					if (variants.find((entry) => entry.broken === void 0) !== void 0) return void 0;
					if (variants.length === 0 && (outcome === void 0 || outcome.failed.length === 0)) return t("error.presetPending");
					const rosterFailures = brokenVariants.size > 0 ? [...brokenVariants].map(([id, reason]) => ({
						id,
						reason
					})) : variants.filter((entry) => entry.broken !== void 0).map((entry) => ({
						id: entry.id,
						reason: entry.broken
					}));
					if (rosterFailures.length > 0) return brokenMessage(rosterFailures, 0);
					if (outcome !== void 0 && (outcome.state === "partial" || outcome.state === "failed")) {
						const failed = outcome.failed.length > 0 ? outcome.failed : outcome.error !== void 0 ? [{
							id: "wsl-*",
							reason: outcome.error
						}] : [];
						if (failed.length > 0) return brokenMessage(failed, outcome.truncated, outcome);
					}
					return t("error.presetMissing");
				},
				listDistros: () => listDistros(),
				describe: () => describe(),
				listDir: (distro, path) => listDir(distro, path),
				check: (distro, path) => check(distro, path),
				createWorkspace: async (linuxPath, username, distro) => {
					try {
						const startSession = resolveSessionStarter();
						const winPath = mntToWindowsPath(linuxPath);
						if (winPath !== null) {
							const view = await workspaces.create({ path: winPath });
							await registerWindows(linuxPath, distro, username);
							const canonical = canonicalWindowsPath(winPath);
							if (canonical !== null) {
								wslWindowsPaths = new Set(wslWindowsPaths).add(canonical);
								driveDistros = new Map(driveDistros).set(canonical, distro);
							}
							await startSession(view.workspaceId);
							noticeCreated();
							return;
						}
						const uncPath = joinUnc(distro, linuxPath);
						const view = await workspaces.create({ path: uncPath });
						await setWorkspaceUser(uncPath, username);
						await startSession(view.workspaceId);
						noticeCreated();
						return;
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
				}
			});
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "wsl-workspace",
				inject: injected
			}, AddWslWorkspace)), "dsh-wsl-workspace: sidebar footer action");
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "wsl-workspace:notice"
			}, WslNoticeOverlay)), "dsh-wsl-workspace: overlay notice");
			ctx.effect(() => mountSessionMenuExit(ctx.slots, () => ({
				controls: () => sessionWslControls,
				labels: sessionExitLabels
			})), "dsh-wsl-workspace: session menu exit row");
			ctx.effect(() => mountWorkspaceMenuExit({
				label: () => t("exit.workspace"),
				doneTitle: () => t("exit.workspace.done"),
				doneBody: (path) => `${t("exit.workspace.done.body")}${path}`,
				failedTitle: () => t("exit.workspace.failed"),
				registeredPath: registeredWslPath,
				onExit: exitWorkspace
			}), "dsh-wsl-workspace: workspace menu exit row");
			ctx.effect(() => {
				const inFlight = /* @__PURE__ */ new Set();
				const attempts = /* @__PURE__ */ new Map();
				const MAX_ATTEMPTS = 3;
				let variants = /* @__PURE__ */ new Set();
				let defaultPreset;
				const refreshRoster = () => {
					listAgentPresets().then((result) => {
						if (!result.ok) return;
						variants = new Set(result.presets.filter((entry) => entry.broken === void 0 && entry.id.startsWith("wsl-")).map((entry) => entry.id));
						brokenVariants = new Map(result.presets.filter((entry) => entry.broken !== void 0 && entry.id.startsWith("wsl-")).map((entry) => [entry.id, entry.broken]));
						defaultPreset = result.presets.find((entry) => entry.isDefault === true)?.id;
						maybeBind();
					}).catch(() => {});
				};
				refreshRoster();
				const refreshWorkspaces = () => {
					listWorkspaceRecords().then((records) => {
						const keys = /* @__PURE__ */ new Set();
						const distros = /* @__PURE__ */ new Map();
						for (const record of records) {
							const canonical = canonicalWindowsPath(record.path);
							if (canonical === null) continue;
							keys.add(canonical);
							if (record.distro !== void 0 && record.distro !== "") distros.set(canonical, record.distro);
						}
						wslWindowsPaths = keys;
						driveDistros = distros;
						maybeBind();
					}).catch(() => {});
				};
				refreshWorkspaces();
				const maybeBind = () => {
					const state = sessions.list.getSnapshot();
					for (const id of state.ids) {
						const summary = state.byId[id];
						if (summary === void 0 || !summary.blank || summary.cwd === void 0) continue;
						const canonical = canonicalWindowsPath(summary.cwd);
						if (!(isWslUnc(summary.cwd) || canonical !== null && wslWindowsPaths.has(canonical))) continue;
						if (hasOptedOut(id)) continue;
						const current = getAgentPreset(summary);
						if (current !== void 0 && current.startsWith("wsl-")) continue;
						const base = current === LEGACY_WSL_PRESET_ID ? defaultPreset ?? "standard" : current ?? defaultPreset;
						if (base === void 0 || base === LEGACY_WSL_PRESET_ID || base.startsWith("wsl-")) continue;
						const target = `wsl-${base.toLowerCase()}`;
						if (!variants.has(target)) continue;
						if (inFlight.has(id) || (attempts.get(id) ?? 0) >= MAX_ATTEMPTS) continue;
						inFlight.add(id);
						selectAgentPreset(id, target).then((result) => {
							if (result.ok) noteAgentPresetCompat(id, target);
						}).catch(() => {
							attempts.set(id, (attempts.get(id) ?? 0) + 1);
						}).finally(() => {
							inFlight.delete(id);
						});
					}
				};
				maybeBind();
				maybeBindNow = maybeBind;
				const summaryOf = (id) => sessions.list.getSnapshot().byId[id];
				/** The WSL test the binder itself uses, so the menu offers an exit for exactly the sessions the binder reaches. */
				const isWslSession = (id) => {
					const cwd = summaryOf(id)?.cwd;
					if (cwd === void 0) return false;
					const canonical = canonicalWindowsPath(cwd);
					return isWslUnc(cwd) || canonical !== null && wslWindowsPaths.has(canonical);
				};
				/** The plain mode a `wsl-<mode>` variant was composed from. */
				const baseModeOf = (summary) => {
					const current = getAgentPreset(summary);
					if (current !== void 0 && current.startsWith("wsl-")) return current.slice(4);
					return current === LEGACY_WSL_PRESET_ID ? defaultPreset ?? "standard" : current ?? defaultPreset ?? "standard";
				};
				sessionWslControls = {
					isWslSession,
					optedOut: (id) => hasOptedOut(id),
					exit: async (id) => {
						const summary = summaryOf(id);
						if (summary === void 0) return "this session is no longer in the list";
						const base = baseModeOf(summary);
						optOutSession(id);
						const result = await selectAgentPreset(id, base).catch((error) => ({
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						}));
						if (!result.ok) {
							unmarkOptOut(id);
							return result.error ?? `the host would not move this session back to ${base}`;
						}
						noteAgentPresetCompat(id, base);
					},
					rejoin: async (id) => {
						const summary = summaryOf(id);
						if (summary === void 0) return "this session is no longer in the list";
						const target = `wsl-${baseModeOf(summary).toLowerCase()}`;
						if (!variants.has(target)) return `${target} is not published as a healthy variant`;
						const result = await selectAgentPreset(id, target).catch((error) => ({
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						}));
						if (!result.ok) return result.error ?? `the host would not move this session to ${target}`;
						optInSession(id);
						noteAgentPresetCompat(id, target);
					}
				};
				const unsubscribe = sessions.list.subscribe(() => maybeBind());
				const timer = window.setInterval(() => {
					refreshRoster();
					refreshWorkspaces();
				}, 6e4);
				return () => {
					unsubscribe();
					window.clearInterval(timer);
					sessionWslControls = null;
					maybeBindNow = () => {};
				};
			}, "dsh-wsl-workspace: WSL mode-variant binding");
			ctx.inject(["sidebarRight"], (scope) => {
				scope.effect(() => {
					const controller = scope.get("sidebarRight");
					const openResource = controller?.openResource;
					const openResourceIn = controller?.openResourceIn;
					if (controller === void 0 || typeof openResource !== "function" || typeof openResourceIn !== "function") return () => {};
					const sessionOf = (sessionId) => {
						const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
						if (cwd === void 0 || cwd === "") return void 0;
						if (!isWslWorkspace(cwd, wslWindowsPaths)) return void 0;
						return {
							cwd,
							distro: distroOfWorkspace(cwd, driveDistros)
						};
					};
					controller.openResource = (address, options) => {
						openResource.call(controller, rewriteReferenceAddress(address, sessionOf), options);
					};
					controller.openResourceIn = (sessionId, address, options) => {
						openResourceIn.call(controller, sessionId, rewriteReferenceAddress(address, sessionOf), options);
					};
					return () => {
						controller.openResource = openResource;
						controller.openResourceIn = openResourceIn;
					};
				}, "dsh-wsl-workspace: file-reference path translation");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		Object.defineProperty(exports, "sessionWslControls", {
			enumerable: true,
			get: function() {
				return sessionWslControls;
			}
		});
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map