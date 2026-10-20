// Every probe ends the same way: rows, a verdict, and an exit that does not wait for the event loop.
//
// The exit is part of the contract, not a convenience. A probe that prints its verdict and then stays alive
// because some handle never closed looks like a dead suite to a runner that waits on the pipe: on
// 2026-10-19 `run-seams` reported `ETIMEDOUT` and a `harness-exit` red for a suite that had already
// answered, and the leaked processes held a native DLL in `ci/deps` so the next `npm ci` failed with
// EPERM/EBUSY. `finish()` is the only exit path a probe in this directory may use.
/**
 * @param rows - `{ id, ok, detail }` in the order they were measured.
 * @param options.label - the suite's own name, e.g. `W92-RC2-CONSUMERS`.
 * @param options.summary - parenthetical text appended to the verdict line.
 * @param options.metrics - extra fields for the machine-readable verdict line.
 * @param options.partial - when set, the run is a diagnosis (e.g. one arm under a filter): it is printed as
 *   PARTIAL and says it is not the gate's verdict.
 */
export function finish (rows, { label, summary = '', metrics = {}, partial = '', verdictOverride = '', conclusion = '' } = {}) {
  for (const entry of rows) console.log(JSON.stringify(entry))
  const failed = rows.filter(entry => entry.ok === false)
  const verdict = failed.length === 0 ? 'PASSED' : `FAILED (${failed.length} failing)`
  console.log(JSON.stringify({ verdict, ...metrics }))
  const tail = verdictOverride !== ''
    ? `${label} ${verdictOverride}`
    : failed.length === 0
      ? `${label} PASSED (${rows.length} rows${summary}${conclusion !== '' ? ` — ${conclusion}` : ''}${partial ? ` ${partial}` : ''})`
      : `${label} FAILED (${failed.length} failing): ${failed.map(entry => entry.id).join(', ')}${partial ? ` ${partial}` : ''}`
  console.log(tail)
  // The exit is decided by the rows alone. `verdictOverride` only changes the sentence a probe prints (e.g.
  // w54's "NOT-MEASURED —" form), never whether the suite failed.
  process.exit(failed.length === 0 ? 0 : 1)
}
