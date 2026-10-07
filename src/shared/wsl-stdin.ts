/**
 * The `stdin` ceiling of one `bash` call, with no host package behind it.
 *
 * This lives in `src/shared` rather than in `src/host/wsl-bash-tool.ts` because the tool module
 * imports `@deepseek-ai/schemastery`, which is an *optional peer dependency* — a plain `npm ci`
 * does not install it. The pure-node unit bucket (`npm run test:unit`, the `lint-build` job) has no
 * host packages at all, and a test that needed the ceiling had to import the tool to get it:
 * measured on the cloud frame at `ed08a5b`, two test files failed to load with
 * `Cannot find package '@deepseek-ai/schemastery'`. The number and its sentence are pure text and
 * arithmetic, so they belong where a test can read them.
 *
 * @module dsh-wsl-workspace/shared/wsl-stdin
 */

/**
 * The ceiling on one call's `stdin`, and the reason it is where it is.
 *
 * The text travels inside the frame line (base64, like the command), so its cost is the frame's cost,
 * and that was measured on this machine (2026-10-05, `D:\Temp\issue51-s0`): a 64 kB command answers in
 * ~3.8 s and a 256 kB one in ~59 s, because a piped bash reads the line as fast as the pipe delivers
 * it. Half the measured 64 kB point is the ceiling — a command plus its input at the frame size
 * nobody has measured past should still feel like a tool call — and a larger input is refused by name
 * rather than truncated, because a program fed half its input fails in ways that look like the
 * program's fault.
 */
export const STDIN_CAP_BYTES = 32 * 1024

/**
 * Whether a call's `stdin` is beyond what the frame can carry.
 * @param stdin - the caller's input, if any.
 * @returns the sentence to throw for the tool, or undefined when the input fits.
 */
export function stdinRefusal(stdin: string | undefined): string | undefined {
  if (stdin === undefined) return undefined
  const bytes = Buffer.byteLength(stdin, 'utf8')
  if (bytes <= STDIN_CAP_BYTES) return undefined
  return `wsl-bash: stdin is ${bytes} bytes, over the ${STDIN_CAP_BYTES}-byte ceiling. The input travels in the same line as the command, and a frame's cost grows with its length (measured: a 64 kB frame answers in ~3.8 s, 256 kB in ~59 s). Write the data to a file first and redirect the command\'s stdin from it (\`command < file\`) — nothing was truncated and nothing ran`
}
