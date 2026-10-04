// The persistent-shell relay runs on an interpreter this plugin picks, and on
// DSH Desktop the obvious pick is wrong: `process.execPath` there is the
// packaged Electron executable, and an Electron binary under a ConPTY writes
// nothing at all (issue #40 — "PTY shell exited during startup").
//
// These cases pin the two halves of the resolution: where the candidates come
// from (pure, so a Desktop that is not this machine can be described), and the
// discriminator that keeps the Electron executable out of the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import {
  classifyNodeProbe,
  isElectronHost,
  pathNodeCandidates,
  persistentShellAllowed,
  probeRelayNode,
  relayNodeCandidates,
  resolveRelayNode,
} from '../src/shared/relay-node.ts';

const ELECTRON = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
const RUNTIME = 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime';
const BUNDLED = `${RUNTIME}\\dependencies\\node\\bin\\node.exe`;

/** A Desktop host command line, as `DesktopHostProcess` builds it. */
const DESKTOP_ARGV = [
  ELECTRON,
  '--expose-internals',
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\bin.js',
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar.unpacked\\dsh',
  'C:\\Users\\tester\\.dsh\\profiles\\desktop',
  RUNTIME,
  'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\pnpm\\bin\\pnpm.mjs',
  'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\bin',
];

test('the Desktop runtime payload named in argv is the first candidate', () => {
  const candidates = relayNodeCandidates({
    argv: DESKTOP_ARGV,
    execPath: ELECTRON,
    env: { DSH_DESKTOP_NODE_EXECUTABLE: ELECTRON },
    platform: 'win32',
    exists: () => true,
  });
  assert.equal(candidates[0].path, BUNDLED);
  assert.match(candidates[0].source, /argv/);
  // The payload the Desktop's own node launcher names is kept, but only after
  // the real payload: on the Desktop it points at the Electron executable.
  const env = candidates.find(candidate => candidate.path === ELECTRON);
  assert.ok(env !== undefined, `the env candidate should still be listed: ${JSON.stringify(candidates)}`);
  assert.match(env.source, /DSH_DESKTOP_NODE_EXECUTABLE/);
  assert.ok(
    candidates.findIndex(candidate => candidate.path === BUNDLED) < candidates.indexOf(env),
    'the bundled payload must be preferred over the env variable',
  );
});

test('the same payload is found beside the executable, and only once', () => {
  const candidates = relayNodeCandidates({
    argv: [ELECTRON, '--expose-internals', 'entry.js', RUNTIME],
    execPath: ELECTRON,
    env: {},
    platform: 'win32',
    exists: () => true,
  });
  // argv and the executable-relative lookup name the same file.
  assert.equal(candidates.filter(candidate => candidate.path === BUNDLED).length, 1);
  assert.match(candidates[0].source, /argv/);
});

test('a candidate that does not exist is dropped', () => {
  const candidates = relayNodeCandidates({
    argv: DESKTOP_ARGV,
    execPath: ELECTRON,
    env: { DSH_DESKTOP_NODE_EXECUTABLE: ELECTRON },
    platform: 'win32',
    exists: path => path === BUNDLED,
  });
  assert.deepEqual(candidates.map(candidate => candidate.path), [BUNDLED]);
});

test('a POSIX host looks for `node`, and a macOS bundle finds its Resources payload', () => {
  // The module always runs on the host's own platform, so `join`/`dirname` are
  // the host's — build the expectation the same way rather than hard-coding a
  // separator the test machine may not use.
  const exe = join('/Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness');
  const bundled = join(dirname(exe), '..', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node');
  const candidates = relayNodeCandidates({
    argv: [exe, 'entry.js'],
    execPath: exe,
    env: {},
    platform: 'darwin',
    exists: () => true,
  });
  assert.ok(candidates.some(candidate => candidate.path === bundled), JSON.stringify(candidates));
  for (const candidate of candidates) assert.match(candidate.path, /node$/, 'a POSIX host looks for `node`, not `node.exe`');
});

test('the probe accepts a real node and rejects the Electron executable', () => {
  assert.deepEqual(classifyNodeProbe('["24.21.0",null]'), { ok: true, version: '24.21.0' });
  // What the Electron executable prints inside a Desktop host, where
  // ELECTRON_RUN_AS_NODE is inherited: the node version *and* the Electron one.
  const electron = classifyNodeProbe('["24.21.0","38.4.0"]');
  assert.equal(electron.ok, false);
  assert.match(electron.ok === false ? electron.reason : '', /Electron 38\.4\.0/);
  // What `--version` prints. A `^v\d+\.\d+\.\d+` check accepts this; it must not.
  const versionShaped = classifyNodeProbe('v38.4.0\n');
  assert.equal(versionShaped.ok, false);
  assert.match(versionShaped.ok === false ? versionShaped.reason : '', /did not report a node version/);
  // `-p` would print the expression's value too, appending `true` to the JSON.
  assert.equal(classifyNodeProbe('["24.13.1",null]true\n').ok, false);
  const tooOld = classifyNodeProbe('["18.20.0",null]');
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.ok === false ? tooOld.reason : '', /older than/);
  assert.equal(classifyNodeProbe('').ok, false);
  assert.equal(classifyNodeProbe('["24.0.0","38.4.0","extra"]').ok, false);
});

test('the running node passes the probe; a missing executable does not', async () => {
  const probe = await probeRelayNode(process.execPath);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.ok === true ? probe.version : '', process.versions.node);
  const missing = await probeRelayNode('dsh-wsl-workspace-no-such-node-9f2c');
  assert.equal(missing.ok, false);
});

test('a non-Electron host keeps process.execPath and spawns nothing', async () => {
  assert.equal(isElectronHost(), false, 'these tests run on plain node');
  const resolution = await resolveRelayNode();
  assert.equal(resolution.path, process.execPath);
  assert.equal(resolution.fallback, false);
  assert.deepEqual(resolution.rejected, []);
});

test('the PATH lookup answers with a list, never throws', async () => {
  const candidates = await pathNodeCandidates(process.platform);
  assert.ok(Array.isArray(candidates));
  for (const candidate of candidates) assert.match(candidate.source, /on PATH/);
});

// The mount decision is this table, and issue #51 is the row that was missing:
// a `fallback: true` resolution names the Electron executable, and an Electron
// binary under a ConPTY writes nothing at all — so mounting the PTY world on it
// makes every `bash` call fail with issue #40's message instead of degrading.
test('a fallback interpreter demotes the persistent shell, and only that', () => {
  const resolved = (fallback) => ({
    path: fallback ? ELECTRON : BUNDLED,
    source: 'fixture',
    rejected: [],
    fallback,
  });
  assert.equal(persistentShellAllowed(true, resolved(false)), true,
    'probe yes + real node: mount, exactly as before');
  assert.equal(persistentShellAllowed(true, resolved(true)), false,
    'probe yes + Electron last resort: demote, which is the issue #51 row');
  assert.equal(persistentShellAllowed(false, resolved(false)), false,
    'a probe that already said no stays no');
  assert.equal(persistentShellAllowed(true, undefined), false,
    'no interpreter answer is not a yes: the mount needs both halves');
  assert.equal(persistentShellAllowed(false, undefined), false,
    'neither half: no mount');
});
