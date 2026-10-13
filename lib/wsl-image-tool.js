import { extname } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/host/wsl-image-tool.ts
/**
* The WSL world's image read.
*
* Why it exists. Issue #54: in a `wsl-*` variant session the host's `read_image` answers
* `cannot get property "fs" without inject` for every call, while the same call in a non-WSL
* session on the same host returns the image. The cause is the realm this plugin's generated
* world cuts, measured in `tests/support/w54-isolate-probe.mjs`: cordis resolves an injected
* proxy property by walking the fiber chain and stops at a realm boundary
* (`@deepseek-ai/cordis/lib/index.js:676-692`), and `read_image` is registered one level below
* the plugin's own fiber — inside `ctx.inject(['attachments'], …)` at
* `@deepseek-ai/dsh-tool-fs/lib/index.js:1204` — so its chain crosses the boundary on the way
* out and never reaches the realm where this world's `fs` lives. `read`, `write` and `edit`
* from the same package are fine: they are registered by the plugin's own fiber, whose
* dependency snapshot already holds the realm's implementation.
*
* Why the realm stays. Dropping `isolate: { fs: true }` would indeed hand the host tool a
* working `fs`, and would also stop this world's own backend from ever mounting: the release's
* base patch already provides `fs` in the root realm (`@deepseek-ai/dsh-base/cordis.patch.yml:518`
* `fs-sandbox`), and cordis refuses a second provider for one realm key. Measured
* (`D:\Temp\realm-fix-2604\w54-fix-shape-data.json`, arm E): the `fs-wsl` row lands in state 3
* and the file tools answer through the *Windows* backend — no UNC translation, no
* `writableRoots` fence (`src/fs.ts`), a WSL session reading `C:\…`. The realm is what keeps
* this world's file effects inside the distribution; it is not the defect. A group-level
* `inject: [fs]` is dead too (arm F): the world then waits for a service only its own children
* can provide and never activates.
*
* What this is. The same call, made where the realm's `fs` resolves. `ctx.get('fs')` reads the
* store by realm key and never walks, so it answers inside the world; the bytes then go into the
* host's own durable attachment service, which falls through from the root realm, so the image
* gets the same normalisation, the same deployment limits and the same attachment id a non-WSL
* session produces. `@deepseek-ai/dsh-tools` keeps registrations in per-scope layers and
* documents that an inner scope shadows the outer one ("Scoped registrations shadow globals",
* `lib/index.js:2670`), measured in arm P of `D:\Temp\realm-fix-2604\w54-candidate-data.json`:
* a row of the world answering for `read_image` takes the name without a duplicate rejection
* and without the preset failing to mount. So the model still sees exactly one image tool,
* under the name it already uses, and it works here.
*
* @module dsh-wsl-workspace/host/wsl-image-tool
*/
/** The tool name. It is the name the model already knows; the world answers for it. */
const TOOL_NAME = "read_image";
/** The formats this read accepts, and the media type each extension declares. */
const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};
/**
* Take the context-global slot for `read_image`. Register through the public path; when the host's
* `tool-fs` row already holds the name with its realm-crossing closure, retire that one table entry
* and insert ours instead, so the world answers for the name regardless of which fiber settled first.
* @param registry - the host tools registry.
* @param tool - the compiled definition to mount.
*/
function mountGlobalRead(registry, tool) {
	try {
		registry.register?.(tool);
		return;
	} catch (error) {
		const duplicate = /already registered/.test(String(error?.message ?? error));
		const table = registry.layers?.global?.tools;
		if (!duplicate || table?.data === void 0 || table.has?.("read_image") !== true) throw error;
		table.data.delete(TOOL_NAME);
		registry.register?.(tool);
	}
}
/** The media type a path claims by extension, or undefined when it claims none. */
function imageMediaTypeForPath(filePath) {
	return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
}
/**
* The media type the bytes declare, for a path whose extension says nothing. The same four
* signatures, and a file that matches none is refused here rather than at a decoder, so the
* answer names the formats the read accepts.
*/
function sniffImageMediaType(data) {
	if (data.length < 12) return void 0;
	const at = (index) => data[index] ?? 0;
	if (at(0) === 137 && at(1) === 80 && at(2) === 78 && at(3) === 71) return "image/png";
	if (at(0) === 255 && at(1) === 216 && at(2) === 255) return "image/jpeg";
	if (at(0) === 82 && at(1) === 73 && at(2) === 70 && at(3) === 70 && at(8) === 87 && at(9) === 69 && at(10) === 66 && at(11) === 80) return "image/webp";
	if (at(0) === 71 && at(1) === 73 && at(2) === 70 && at(3) === 56) return "image/gif";
}
/**
* Refuse a route that has not declared image input. This is not decoration: an image block sent
* to a text-only model fails the whole request, and the host's own read applies the same gate
* (`@deepseek-ai/dsh-tool-fs/lib/index.js:898-906`), so a session that switched to this read
* would otherwise lose the check rather than gain the picture.
*/
async function assertImageCapableRoute(ctx, exec, requestedPath) {
	const routed = exec.agent?.session?.requestHeader?.()?.config;
	const provider = routed?.provider ?? exec.agent?.options?.provider;
	const model = routed?.model ?? exec.agent?.options?.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`);
	const active = await llm.resolveModelInfo(provider, model, exec.signal);
	if (active?.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`);
}
/**
* The model-facing envelope beside the image block. A normalised read says so and gives the
* multiplier back, because a coordinate measured on the attached picture is not a coordinate in
* the file until it is scaled.
*/
function formatImageReadOutput(displayPath, image) {
	let scaled = "";
	if (image.originalDimensions !== void 0) {
		const x = (image.originalDimensions.width / image.width).toFixed(2);
		const y = (image.originalDimensions.height / image.height).toFixed(2);
		const advice = x === y ? `multiply coordinates by ${x}` : `multiply x coordinates by ${x} and y coordinates by ${y}`;
		scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`;
	}
	return `<path>${displayPath}</path>\n<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}\n</content>`;
}
/**
* Register the world's image read, taking over the `read_image` name whose host registration cannot
* reach this world's filesystem.
*
* Services resolve through `ctx.get`, never the injected proxy property: the host loader hands
* cordis `exports.default ?? exports`, so a module-level `inject` never reaches the fiber, and the
* property form is precisely the lookup that cannot cross the realm this world cuts — the mistake
* `src/host/wsl-bash-tool.ts:456-466` already records for the shell.
*
* Registration channel. The name is answered for in the registry's CONTEXT-GLOBAL layer
* (`@deepseek-ai/dsh-tools` keeps one definition per name there; `ToolRuntime.get(name)` without a
* scope resolves only that layer — `view`/`get`, lib/index.js:2959-2997). A per-agent `agent.ctx`
* registration lands in a scoped layer that an unscoped `get` never consults, so it cannot displace
* the host here. The host's `tool-fs` row registers `read_image` from a deferred
* `ctx.inject(['attachments'], …)` callback whose closure crosses the realm (issue #54), and the boot
* ordering of that callback against this row is not fixed — it flips when one process backs more than
* one profile — so simply registering and losing, or re-placing the row, is not a fix. This therefore
* takes the global slot deterministically (see {@link mountGlobalRead}).
* @param ctx - the world's plugin context, in whose scope `fs` is this distribution's backend.
*/
function apply(ctx) {
	const tools = ctx.get("tools");
	if (tools?.register === void 0) return;
	mountGlobalRead(tools, defineTool({
		name: TOOL_NAME,
		description: "Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.",
		parameters: { file_path: {
			type: "string",
			required: true,
			description: "Path to the image file, resolved inside this WSL distribution."
		} },
		isConcurrencySafe: () => true,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					image: {
						type: "object",
						additionalProperties: false,
						properties: {
							attachmentId: {
								type: "string",
								required: true
							},
							mediaType: {
								type: "string",
								required: true
							},
							bytes: {
								type: "number",
								required: true
							},
							width: {
								type: "number",
								required: true
							},
							height: {
								type: "number",
								required: true
							},
							name: { type: "string" },
							originalDimensions: {
								type: "object",
								additionalProperties: false,
								properties: {
									width: {
										type: "number",
										required: true
									},
									height: {
										type: "number",
										required: true
									}
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatImageReadOutput(value.path, value.image)
			}, {
				type: "image",
				attachment: { ...value.image }
			}],
			presentationMeta: (_args, value) => ({ path: value.path })
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Read image ${args.file_path ?? ""}`,
			kind: "read",
			locations: [{ path: args.file_path ?? "" }]
		}),
		async execute(args, exec) {
			if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			const fs = ctx.get("fs");
			if (fs === void 0) throw new Error("cannot read an image: this WSL world mounts no filesystem backend");
			const attachments = ctx.get("attachments");
			if (attachments === void 0) throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`);
			const declared = imageMediaTypeForPath(args.file_path);
			if (declared !== void 0 && !attachments.imageLimits.mediaTypes.includes(declared)) throw new Error(`cannot read "${args.file_path}": ${declared} images are not accepted by this deployment`);
			await assertImageCapableRoute(ctx, exec, args.file_path);
			const cwd = exec.agent?.session?.header?.cwd;
			const target = await fs.resolve(args.file_path, {
				...cwd === void 0 ? {} : { cwd },
				...exec.signal === void 0 ? {} : { signal: exec.signal }
			});
			const displayPath = target.displayPath;
			const info = await fs.stat(target, exec.signal);
			if (info === void 0) {
				ctx.emit("fs/observed", target, { kind: "absent" }, exec);
				throw new Error(`cannot read "${displayPath}": not found`);
			}
			if (info.type !== "file") throw new Error(`cannot read "${displayPath}": not a regular file`);
			const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
			const data = await fs.readBytes(target, exec.signal, byteCap);
			const mediaType = declared ?? sniffImageMediaType(data);
			if (mediaType === void 0) throw new Error(`cannot read "${displayPath}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`);
			if (declared === void 0 && !attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`cannot read "${displayPath}": ${mediaType} images are not accepted by this deployment`);
			const ref = await attachments.saveImage({
				data,
				mediaType,
				name: displayPath.slice(displayPath.lastIndexOf("/") + 1)
			});
			ctx.emit("fs/observed", target, {
				kind: "present",
				version: info.version
			}, exec);
			return {
				path: displayPath,
				image: ref
			};
		}
	}));
}
//#endregion
export { TOOL_NAME, apply, apply as default, formatImageReadOutput, imageMediaTypeForPath, sniffImageMediaType };

//# sourceMappingURL=wsl-image-tool.js.map