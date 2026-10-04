// The persistent shell's interpreter, checked where it matters: under a real
// ConPTY.
//
// Issue #40: the plugin hands the host PTY backend a command of its own —
// `shellPath` is a node executable, `shellArgs[0]` is `lib/wsl-relay.js` — and
// on DSH Desktop `process.execPath` is the packaged Electron executable. An
// Electron binary spawned under a ConPTY writes nothing at all, so the relay
// never reaches the backend's readiness probe and every session fails with
// "PTY shell exited during startup".
//
// This check pins the invariant rather than the symptom: whatever
// `resolveRelayNode()` picks must produce a live bash prompt through a real
// ConPTY, with the backend's own child environment and a real `\\wsl.localhost`
// cwd. It runs on every declared release, on the interpreter that release's
// host would have chosen.
//
// Usage: node --experimental-strip-types scripts/compatibility/conpty-relay.mjs <case>/runtime.json
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveRelayNode } from '../../src/shared/relay-node.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '../..');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const distro = process.env.WSL_COMPAT_DISTRO || 'Ubuntu';
const cwd = process.env.WSL_COMPAT_RELAY_CWD || `\\\\wsl.localhost\\${distro}\\home\\mille\\symprobe\\ws`;
const relay = path.join(plugin, 'lib', 'wsl-relay.js');

/**
 * Locate the runtime's own node-pty, the one the host's PTY backend uses.
 * @param runtimeRoot - the case's installed DSH runtime.
 * @returns an absolute path to a `node-pty` package directory.
 */
function nodePtyPath(runtimeRoot) {
  const candidates = [
    path.join(runtimeRoot, 'node_modules', '.pnpm', 'node_modules', 'node-pty'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'node_modules', 'node-pty'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'lib', 'index.js'))) return candidate;
  }
  throw new Error(`conpty-relay: no node-pty under ${runtimeRoot} (tried ${candidates.join(', ')})`);
}

/** The PTY backend's own child environment: scrubbed parent, then overrides. */
function childEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
    if (key.toUpperCase().startsWith('DSH_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    // The host's own values, not a paraphrase: `CONTROLLED_PROMPT` is lowercase
    // `"dsh> "` and the backend compares the prompt tail against it byte for byte
    // (`dsh-terminal-bash/lib/index.js:76,951-952`). An earlier draft of this gate
    // injected an uppercase `'DSH> '`, so it could never have observed the contract
    // arriving even if the relay had carried it across.
    PS1: 'dsh> ',
    PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"; PS1=\'dsh> \'',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    DSH_SHELL: '1',
    DSH_SESSION_ID: 'compat-session',
    DSH_PTY_SESSION_ID: 'compat-pty',
    ...process.env.WSL_COMPAT_USER === undefined ? {} : { DSH_WSL_USER: process.env.WSL_COMPAT_USER },
  };
}

/** Run one command under a real ConPTY and report what came back. */
function underConpty(pty, exe, args, ms) {
  const chunks = [];
  let exit;
  const done = Promise.withResolvers();
  const terminal = pty.spawn(exe, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: childEnvironment() });
  const started = Date.now();
  terminal.onData(data => { chunks.push(data) });
  terminal.onExit(event => { exit = event; done.resolve() });
  return Promise.race([done.promise, new Promise(resolve => setTimeout(resolve, ms))]).then(() => {
    const output = chunks.join('');
    try { terminal.kill() } catch { /* already gone */ }
    return { output, exit, ms: Date.now() - started };
  });
}

const pty = createRequire(import.meta.url)(nodePtyPath(manifest.runtimeRoot));
const resolution = await resolveRelayNode();
assert.equal(resolution.fallback, false, `no real node interpreter was found: ${resolution.source}`);
console.log(`conpty-relay: interpreter ${resolution.path} (${resolution.source})`);

const run = await underConpty(pty, resolution.path, [relay], 10_000);
// Two different views of the same bytes: the readiness marker is an OSC sequence, so
// it must be matched on the RAW output — the `printable` strip below deletes exactly
// what it is looking for.
const printable = run.output.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
assert.ok(
  run.output.length > 0,
  `the interpreter wrote nothing to the ConPTY (exit ${JSON.stringify(run.exit)} after ${run.ms}ms) — this is the issue #40 failure`,
);
assert.equal(run.exit, undefined, `the shell exited instead of staying up: ${JSON.stringify(run.exit)}`);
// The question is no longer "did some prompt appear" — a distribution default prompt
// answers that while the session is still broken, which is what this assertion used to
// certify (issue #51 point 2: the host injects its contract as Windows variables, and
// nothing named them in WSLENV, so the shell came up as `user@host:~$` and the backend
// could never recognise it). It is now "did the host's contract arrive", which is the
// pair the backend itself compares.
assert.ok(run.output.includes(']133;D;'),
  `no OSC 133;D readiness marker reached the wire — PROMPT_COMMAND did not cross into the distribution: ${JSON.stringify(printable.slice(0, 200))}`);
assert.match(printable, /dsh> /,
  `the host's controlled prompt never appeared — the readiness contract is not in effect: ${JSON.stringify(printable.slice(0, 200))}`);

console.log(`PASS conpty-relay: ${resolution.path} gives the host's controlled prompt under a real ConPTY (${run.output.length} bytes, marker + ${JSON.stringify('dsh> ')} both present)`);
console.log('PASS conpty-relay: the interpreter is not the Electron executable, and the resolution reported no fallback');
