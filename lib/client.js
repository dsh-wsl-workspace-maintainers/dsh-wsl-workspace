window.__ModuleLoader__.load({
	id: "dsh-wsl-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
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
		* Perform one POST call and unwrap the envelope.
		* @param method - the Host method name.
		* @param params - the method payload.
		* @returns the unwrapped value, or throws an Error on network or `ok:false`.
		*/
		async function call(method, params = {}) {
			let response;
			try {
				response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						method,
						params
					})
				});
			} catch (error) {
				throw new Error(`wsl-workspace request failed: ${errorMessage(error)}`);
			}
			let envelope;
			try {
				envelope = await response.json();
			} catch {
				throw new Error(`wsl-workspace answered non-JSON (${response.status})`);
			}
			if (!envelope.ok) throw new Error(envelope.error);
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
			const refreshBrowse = async (root, targetDistro) => {
				const seq = ++browseSeq.current;
				setBrowsing(true);
				setBrowsePath(root);
				try {
					const value = await listDir(targetDistro, root);
					if (seq === browseSeq.current) setListing(value);
				} catch {
					if (seq === browseSeq.current) {
						setListing(null);
						setError((previous) => previous ?? t("error.loadDir"));
					}
				} finally {
					if (seq === browseSeq.current) setBrowsing(false);
				}
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				let cancelled = false;
				setError(null);
				describe().then((value) => {
					if (!cancelled) setSelfDescription(value);
				}).catch(() => {
					if (!cancelled) setSelfDescription(null);
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
						if (cancelled) return;
						setOpening(false);
						setError(t("error.loadDistros"));
						return;
					}
					if (cancelled) return;
					setDistros(names);
					const first = names[0] ?? "";
					setDistro(first);
					setBrowsing(true);
					setOpening(false);
					if (presetIssue !== void 0) setError(presetIssue);
					if (first !== "") refreshBrowse("/", first);
				})();
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
			if (!open) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: wide ? "dww-action dww-action--wide" : "dww-action dww-action--rail",
				title: t("action.title"),
				"aria-label": t("action.title"),
				onClick: () => setOpen(true),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dww-letter",
					"aria-hidden": "true",
					children: "W"
				})
			});
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dww-error",
									children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dww-retry",
										onClick: () => setError(null),
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
  color: var(--dsw-alias-label-primary);
}
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
			"action.add": "WSL 工作区",
			"action.title": "添加 WSL 工作区…",
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
			"help.news.title": "本次更新（0.7.6）",
			"help.news.body": "DSH Desktop 上「未找到健康的 wsl preset」、一个 WSL 变体也生成不出来的问题修好了（issue #47）。\n原因是生成器在调用时向宿主借方言和 YAML 引擎；Desktop 把宿主打在归档包里，而 Node 找裸包名只沿文件系统往上走，这条路走不进去。\n引擎改成本包的正式依赖（4.x 那条版本线），方言也由插件自己构建、与加载它的那个引擎出自同一份命名空间；profile 里别人把 js-yaml 顶到哪个大版本，都不再决定生成能不能跑。\n一个源读不到只算它那一个变体失败，退役目录的清扫照常执行；引擎相关的失败会报出实际解析到的包名、版本与路径。\n新增 npm run test:profile：在临时目录里搭出与真实 profile 同形状的树来验这件事；安装闸门也改成同时断言运行面是否在场。\n文件引用又能预览了（issue #49）。会话里的文件链接、工具行的行号引用、回合末尾的「已改动文件」都走右侧栏，而地址里带的是模型原样写下的 Linux 路径；宿主用 node:path.resolve(cwd, path) 解析它，POSIX 绝对路径在 Windows 上是「当前盘根目录下的相对路径」，所以 /mnt/d/x 落到工作区所在的盘、发行版内的路径落到 cwd 共享的根下，UNC cwd 下的 /mnt/<盘符> 引用还会变成 9P 服务不了的路径（EPERM）。\n客户端半边现在先把地址翻译好再交给侧栏：/mnt/<盘符>/… 换回 X:\\…，其余 Linux 路径走该发行版的 UNC 共享（发行版取自会话的 UNC 工作区，或 /mnt/<盘符> 工作区注册时存下的记录——为此新增了宿主路由 listWorkspaceRecords）。\n不是 WSL 会话、逐字节重建不出来、或发行版未知的地址一律原样透传。只有 0.1.5-rc.1 及以后才有右侧栏与文档预览，更早的六个已声明版本不安装这个钩子。",
			"help.usage.title": "用法与特性",
			"help.usage.body": "点击侧边栏底部的 W 按钮 → 选发行版 → 输入或浏览 Linux 路径 → 检查 → 创建并打开。\n创建出的会话里，bash 与文件工具都落在该发行版内，模型看到的路径全是 Linux 路径；Windows 盘可从会话内通过 /mnt/<盘符> 访问。\n四种模式（标准 / PTC / 极简 / 创造）各有 WSL 变体，在模式选择器里直接选即可，名字形如 WSL · Standard mode（标准模式）。\n用户名可选，等价于 wsl.exe -u <用户名>，只改变 bash 与 persistent-bash 的运行身份；文件工具走 Windows 侧共享，不受它影响。\n技能目录从会话 cwd 最近的 .git 祖先开始向下扫描 .dsh/skills 与 .agents/skills（含嵌套项目），上限 4 层目录 / 64 个技能目录 / 4096 个已访问目录，并按扫描根缓存 10 秒。9P 解不开的符号链接交给发行版 readlink 解析出真实路径（每次查找最多 32 条）后继续扫描，链接进来的项目与它下面的嵌套项目都能扫到。\n目录不再冻结：对 UNC 关闭文件监视之后，插件每 3 秒重查一次已发布的技能目录、并比对每个技能文件的修改时间与大小，所以新增、删除与改写都会在下一个回合生效；完整重新发现每 30 秒一次，用于找到此前不存在的技能目录（技能正文始终实时读取）。\n文件搜索由发行版内的 grep / glob 提供，源预设没有这两个工具的模式（极简）不会多出来：grep 用 GNU grep -E（\\d、\\w、(?i) 可用，环视与反向引用不支持），跳过隐藏项与 node_modules，不读 .gitignore；glob 用 GNU find 列文件、按 gitignore 风格匹配（* 不跨目录、** 跨、{a,b}、前导 ! 取反），按修改时间从旧到新排序。\n文件工具在链接处按真实路径工作，并按真实路径判策略：链接指向工作区外就等于工作区外。\nbash 由 PTY 承载的持久 shell 提供：登录环境、起始目录就是会话工作区，cd / export / venv / 后台任务跨调用保留（它取代了原先一次性 bash）。\n需要可跟踪的后台任务时用 bash_background：它立刻返回 job id，job_list / job_output（增量读取）/ job_kill 都作用于它；bash 本身没有 run_in_background 参数，传了会被忽略。job id 只在本次 DSH 进程内唯一，重启后会重新编号，引用前先用 job_list 确认。\nbash 与文件工具的 shell 都在发行版内运行、不受 DSH 文件策略约束；文件工具（read/write/edit）受策略约束，工作区内修改模式下只能写工作区内。",
			"help.known.title": "已知问题",
			"help.known.body": "grep 用的是发行版自带的 GNU grep：方言是 POSIX ERE（环视与反向引用不支持），且不读 .gitignore，被 git 忽略的文件照样会被搜到；只有隐藏项、node_modules 与版本库目录会被跳过。发行版没有 GNU grep（如 Alpine 的 busybox）时会明确报错，而不是给出错位的结果。\nglob 的\"按修改时间排序\"依赖 GNU find -printf，busybox 会退化成路径排序；含 / 的 include 在插件进程里过滤，因此那种调用会先扫描全部文件再筛。\n技能目录刷新仍是轮询：已发布目录内的增删改约 3 秒生效，而一个新项目里第一次出现的技能目录要等下一次完整重新发现（最多 30 秒）。\n0.1.0-rc.7 的宿主没有 Windows 进程检查器，PTY 持久 shell 无法启动（宿主自己也这样），插件回退到一次性 bash：能正常用，但 cd / export 不跨调用保留。\n极简模式本身不挂 job_* 工具，所以那个模式里也没有 bash_background（与宿主的极简模式一致）。\n在 DSH Desktop 上，持久 shell 跑的是 Desktop 自带的那个 node（`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`）——Desktop 自己在启动时会 stat 这个文件，缺了就直接 `DesktopHostFatalError`，所以这条路径不是猜的。\n实测把它改名后，解析链会退到 PATH 上的 node（日志里写 `\"node.exe\" on PATH`）；只有连 PATH 也没有 node 时才退回 Electron 可执行文件，那时 bash 会以 PTY shell exited during startup 失败，启动日志里写明选中的解释器与被拒绝的候选。\n文件引用的翻译只认插件自己认定为 WSL 的会话：工作区必须注册成 WSL 工作区（对话框创建的都会注册），否则地址原样不动。\n发行版内的绝对路径还需要知道发行版：UNC 工作区自带，/mnt/<盘符> 工作区取自 wsl-workspaces.json 的记录；那条记录删掉后这类引用不再翻译。/mnt/<盘符> 不受影响——盘符就是盘符。",
			"help.footer.npm": "npm 包",
			"help.footer.repo": "GitHub 仓库"
		};
		/**
		* The `wslWorkspace` translations (English).
		*/
		const en = {
			"action.add": "WSL Workspace",
			"action.title": "Add WSL workspace…",
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
			"help.news.title": "What's new in 0.7.6",
			"help.news.body": "Fixed DSH Desktop reporting no healthy wsl preset while generating not a single WSL variant (issue #47).\nThe generator used to borrow the entry-list dialect and its YAML engine from the host at call time. Desktop ships the host inside an archive, and Node looks for a bare specifier by walking the filesystem upward, so that walk never reaches it.\nThe first source preset threw, the throw left the whole generation loop, and the leftovers of the retired mechanism stayed where they were.\nThe engine is now a real dependency of this package, on the 4.x line, and the dialect is built inside the plugin from that same engine namespace, so schema and loader can no longer come from different majors. Which release a sibling plugin hoisted into the profile no longer decides whether variants can be generated.\nOne unreadable source is now one variant's own failure: the other variants still publish, the stale-directory sweep still runs, and an engine problem reports the package, version and path it actually resolved.\nNew gate npm run test:profile builds profile-shaped trees under the temp dir and boots the plugin's own copy inside them, including the release the host umbrella does not carry; the install gate now asserts that the runtime surface is present rather than certifying that it is absent.\nFile references preview again (issue #49). The conversation's file links, a tool row's line reference and the turn tail's changed files open through the right Sidebar, and the address carries the path exactly as the model wrote it - a Linux path.\nThe host resolves that with node:path.resolve(cwd, path), where a POSIX absolute path is root-relative: /mnt/d/x landed on the workspace drive, and an in-distribution path under the cwd share's root.\nThe client half now translates the address first: /mnt/<drive>/... back to X:\\..., and every other Linux path through the distribution's UNC share.\nThe distribution comes from the session's UNC workspace, or from the record stored for a /mnt/<drive> workspace (a new host route, listWorkspaceRecords).\nA session the plugin does not treat as WSL-bound, an address it cannot rebuild byte-for-byte, or one whose distribution is unknown, is passed through untouched.\nOnly 0.1.5-rc.1 and later ship a right Sidebar and a document preview; the six earlier declared releases get no hook.",
			"help.usage.title": "Usage and features",
			"help.usage.body": "Click the W button at the sidebar foot, pick a distribution, type or browse to a Linux path, press Check, then Create & open.\nIn that session the bash tool and the file tools run inside the distribution, so every path the model sees is a Linux path; Windows drives stay reachable as /mnt/<drive>.\nEach mode (Standard / PTC / Minimal / Creator) has a WSL variant in the mode picker, named like WSL · Standard mode.\nThe optional username behaves like wsl.exe -u <user> for bash and persistent-bash; the file tools go through the Windows-side share and are unaffected.\nThe skill catalog is discovered from the nearest .git ancestor of the session cwd downwards (.dsh/skills and .agents/skills, nested projects included), bounded to 4 levels / 64 skill directories / 4096 visited directories, and cached per scan root for 10 seconds.\nA link the share cannot follow is resolved through the distribution (wsl.exe readlink, at most 32 per lookup) and the scan continues at the real path, so a linked-in project and its own nested projects are found too.\nThe catalog is not frozen: published skills directories are re-checked every 3 seconds (skill file mtime + size), so an add, remove or edit appears on the next turn; a 30-second walk finds a skills directory that did not exist before.\nFile search comes from grep / glob inside the distribution, and a mode that mounts no search suite (Minimal) gains none. grep is GNU grep -E (no lookaround or backreferences), skips hidden entries and node_modules, and does not read .gitignore; glob matches gitignore-style patterns here, oldest first.\nThe file tools work at the resolved real path of a link, and the policy is judged there too: a link out of the workspace is an outside write.\n`bash` is a PTY-backed stateful shell: login environment, starting directory the session workspace, and cd / exports / background jobs survive between calls.\nFor a tracked background job use bash_background: it returns a job id immediately, and job_list / job_output (incremental) / job_kill act on it.\n`bash` itself has no run_in_background parameter and ignores one; job ids are unique within this DSH process, so confirm with job_list before acting on one.\nBoth it and the file tools' shell run inside the distribution, outside the DSH file policy; read/write/edit are inside it, and workspace-write only writes inside the workspace.",
			"help.known.title": "Known issues",
			"help.known.body": "grep is the distribution's GNU grep: POSIX ERE (no lookaround or backreferences), and it does not read .gitignore, so git-ignored files are searched too; only hidden entries, node_modules and VCS directories are skipped.\nglob's modification-time order needs GNU find -printf (busybox falls back to path order), and an include containing \"/\" is filtered in this process, so that call scans every file first.\nThe catalog refresh is still a poll: an add, remove or edit inside a published skills directory lands within about 3 seconds, while a new project's first skills directory waits for the next full re-discovery (up to 30 seconds).\n0.1.0-rc.7 has no Windows process inspector, so its PTY persistent shell cannot start (the host has the same gap) and the plugin falls back to a one-shot bash: it works, but cd / exports do not survive.\nMinimal mode mounts no job_* tools, so it gets no bash_background either - the same as the host's own Minimal mode.\nOn DSH Desktop the persistent shell runs on the node bundled with the Desktop (resources/runtime/primary-runtime/dependencies/node/bin/node.exe). The Desktop stats that file at boot and dies with DesktopHostFatalError without it, so the path is not a guess.\nRenaming it away made the resolution fall through to a node on PATH (\"node.exe\" on PATH, in the log); only with no node anywhere does it fall back to the Electron executable, where bash fails with \"PTY shell exited during startup\" and the log names every rejected candidate.\nReference translation only applies to sessions the plugin itself recognizes as WSL ones: the workspace must be registered as a WSL workspace (everything the dialog creates is), otherwise addresses are left alone.\nAn in-distribution absolute path also needs the distribution: a UNC workspace carries it, a /mnt/<drive> workspace takes it from the record in wsl-workspaces.json, and deleting that record stops those references from being translated. /mnt/<drive> paths are unaffected - the mount name is the drive.",
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
			/** Unified agent-preset select: new `agentPresets.select(id, preset)` or legacy `connection.api.select({...})`. */
			const selectAgentPreset = async (sessionId, presetId) => {
				const agentPresets = remoteAgentPresets();
				if (agentPresets !== void 0) return agentPresets.select(sessionId, presetId);
				const api = legacyApi();
				if (api !== void 0) return { ok: (await api.agentPresets.select({
					sessionId,
					agentPreset: presetId
				})).result.ok };
				return { ok: false };
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
			const injected = () => ({
				t,
				checkPreset: async () => {
					let roster;
					try {
						roster = await listAgentPresets();
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
					if (!roster.ok) return roster.error;
					if (roster.presets.find((entry) => entry.id.startsWith("wsl-") && entry.broken === void 0) === void 0) return t("error.presetMissing");
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
							return;
						}
						const uncPath = joinUnc(distro, linuxPath);
						const view = await workspaces.create({ path: uncPath });
						await setWorkspaceUser(uncPath, username);
						await startSession(view.workspaceId);
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
				const unsubscribe = sessions.list.subscribe(() => maybeBind());
				const timer = window.setInterval(refreshRoster, 6e4);
				return () => {
					unsubscribe();
					window.clearInterval(timer);
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
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map