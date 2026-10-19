// The host services a hand-built context has to supply before a host tool can be driven at all.
//
// WHY THIS EXISTS. `@deepseek-ai/dsh-tool-bash` grew a required service in 0.2.1-rc.2: its foreground
// path now reads `const cwd = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(
// exec.agent, exec.signal)` before building the request. A context assembled by these drivers mounts
// `dsh-shell-env`, `dsh-tools`, `dsh-system-prompt` and an executor, and nothing provides
// `workingDirectory`, so every host-arm call died on `Cannot read properties of undefined (reading
// 'ensure')` — and in the parity driver that turned the *control* into a throw, which would have made
// every "differs" reading measure our harness instead of the two tools (measured on the 0.2.1-rc.2 CI
// frame, 2026-10-19: `bash-parity-real: RED` with all four host arms returning `{"kind":"threw"}`).
//
// Mounting the real `@deepseek-ai/dsh-working-directory` is not what these contexts can do: it injects
// `fs`, `sessionProjections` and `systemPrompt`, and the parity arms deliberately compare the *shell*
// plane with no filesystem provider of the product's shape. So this supplies the one method the tool
// calls, answering with the session's own directory — which is what an untouched session carries in the
// product, and what `resolveWorkdir` fell back to before the field existed. The arms stay honest
// because the drivers assert a foreground result comes back: if this stub ever stops being equivalent,
// the host arm throws and the gate reddens instead of comparing against a corpse.
/**
 * Provide `workingDirectory` on a context, returning the session's own cwd the way an unmodified
 * session reports it.
 * @param ctx - the hand-built cordis context, before the host tool is applied.
 * @param sessionCwd - the cwd these drivers give the session (a WSL UNC path, or a Linux path).
 */
export function provideWorkingDirectory(ctx, sessionCwd) {
  const provided = ctx.provide?.('workingDirectory', {
    // The product's service returns the directory the session is *currently* in; these drivers never
    // move it behind the session header, so the header is the answer.
    ensure: async (agent) => agent?.session?.header?.cwd ?? agent?.session?.cwd ?? sessionCwd,
    directory: (agent) => agent?.session?.header?.cwd ?? agent?.session?.cwd ?? sessionCwd,
    dispose: async () => {},
  })
  if (provided === undefined && ctx.workingDirectory === undefined) {
    throw new Error('provideWorkingDirectory: this cordis gives no handle on the service — the host arm would throw on `ensure`')
  }
}
