// Client-lifecycle regressions for the browser half, executed against the
// SHIPPED bundle (lib/client.js) rather than the sources, so a bundling or
// entry-point mistake fails here too.
//
// The fixture models the two service shapes the supported DSH lines expose:
//   legacy (<= 0.1.1-rc.2): connection.api.agentPresets + workspaces.startSession
//   current (>= 0.1.2-rc.1): remote.agentPresets namespace + uiWorkspace
// and the session-summary field each line serves for the agent preset
// (`agentPreset` at the top level vs `projectionValues.agentPreset`).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * Mount the shipped client bundle over a fake DSH client runtime.
 * @param options.legacy - model a v0.1.1-rc.2 runtime instead of v0.1.2-rc.1+.
 * @param options.late - register the version-dependent services only after
 *   `apply()` has run, which is what the real runtime does: this plugin applies
 *   before the UI domain publishing `uiWorkspace` registers its service.
 * @param options.startService - which session starter to expose: 'ui',
 *   'legacy' (on `workspaces`), or 'none'.
 * @param options.sidebarRight - expose the right-Sidebar navigation controller
 *   (`sidebarRight`), which DSH gained in 0.1.5-rc.1 along with the document
 *   preview; six declared releases have no such service.
 * @param options.records - the workspace records the host route answers with.
 * @param options.roster - the agent-preset roster entries the preset service
 *   answers with, replacing the fixture's default (six healthy `wsl-*`
 *   variants). `[]` is a roster with nothing published yet, which is what a
 *   profile still inside its boot window looks like.
 * @param options.variantStatus - what the host route answers for the
 *   `variantStatus` method: a VariantOutcome object, or `'absent'` to model an
 *   OLD host that has no such case and answers `{ok:false}`.
 */
function fixture({ legacy = false, late = false, startService = legacy ? 'legacy' : 'ui', sidebarRight = false, records = [], roster, variantStatus = 'absent' } = {}) {
  let plugin, dialog, subscriber, tick;
  // The host's `variantStatus` answer, mutable so a test can move it between
  // two reads (a generation counter that goes BACKWARDS is the stale read).
  let outcome = variantStatus;
  const effects = [], calls = [], opened = [], pending = [];
  const summary = legacy
    ? { blank: true, cwd: '\\\\wsl.localhost\\Ubuntu\\tmp\\fixture', agentPreset: 'standard' }
    : { blank: true, cwd: '\\\\wsl.localhost\\Ubuntu\\tmp\\fixture', projectionValues: { agentPreset: 'standard' } };
  const state = { ids: ['s1'], byId: { s1: summary } };
  const setPreset = value => {
    if (legacy) summary.agentPreset = value;
    else summary.projectionValues = { agentPreset: value };
  };
  const presets = roster ?? ['standard', 'code', 'ptc', 'minimal', 'cordis', 'custom']
    .flatMap(id => [{ id, isDefault: id === 'standard' }, { id: `wsl-${id}` }]);
  const services = {
    sessions: {
      list: { getSnapshot: () => state, subscribe: fn => (subscriber = fn, () => { subscriber = undefined; }) },
    },
    workspaces: {
      create: async () => { calls.push(['create']); return { workspaceId: 'w1' }; },
    },
  };
  if (sidebarRight) {
    services.sidebarRight = {
      openResource: (address, options) => { opened.push(['openResource', address, options]); },
      openResourceIn: (sessionId, address, options) => { opened.push(['openResourceIn', sessionId, address, options]); },
    };
  }
  if (legacy) {
    services.sessions.noteAgentPreset = (_id, id) => { calls.push(['note', id]); setPreset(id); };
  }
  if (startService === 'legacy') {
    services.workspaces.startSession = id => { calls.push(['start', id]); };
  }

  // cordis mixes `inject` onto every context and runs the callback once its
  // dependencies are provided; the fixture runs it as soon as they all are.
  const runInjections = () => {
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      if (!entry.deps.every(dep => services[dep] !== undefined)) continue;
      pending.splice(index, 1);
      entry.callback({ get: key => services[key], effect: fn => effects.push(fn()) });
      index = -1;
    }
  };

  const mount = () => {
    if (legacy) {
      services.connection = { api: { agentPresets: {
        list: async () => ({ result: { ok: true, value: { presets } } }),
        select: async args => {
          calls.push(['select', args.agentPreset]);
          setPreset(args.agentPreset);
          return { result: { ok: true } };
        },
      } } };
      return;
    }
    services['remote.agentPresets'] = {
      list: async () => ({ ok: true, value: { presets } }),
      select: async (_sessionId, presetId) => {
        calls.push(['select', presetId]);
        setPreset(presetId);
        return { ok: true };
      },
    };
    if (startService === 'ui') {
      services.uiWorkspace = { startSession: id => { calls.push(['start', id]); } };
    }
    runInjections();
  };
  if (!late) mount();

  const ctx = {
    get: key => services[key],
    effect: fn => effects.push(fn()),
    inject: (deps, callback) => { pending.push({ deps, callback }); runInjections(); },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: config => { dialog = config.inject(); return () => {}; } },
  };
  services.slots = ctx.slots;

  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: mod => { plugin = mod.factory(() => ({})); } },
      setInterval: fn => (tick = fn, 1),
      clearInterval: () => { tick = undefined; },
    },
    console,
    document: { getElementById: () => ({}), querySelector: () => ({}) },
    // Every route call is bounded by an AbortController, so the sandbox needs
    // the browser globals that budget is built from. The timers are the host
    // ones: a budget that never fires is not what is under test here, and a
    // fake clock would have to be wound by hand on every case.
    AbortController,
    setTimeout,
    clearTimeout,
    // The plugin's host API calls: the workspace record read and the variant
    // outcome have shapes under test, and every other route answers an empty
    // list. `status` is present because the client reads it: a non-2xx body
    // carrying `{ok:true}` must not be mistaken for a value.
    fetch: async (_url, init) => {
      const method = JSON.parse(init.body).method;
      const status = 200;
      if (method === 'variantStatus') {
        // An old host has no such case in its switch, so the route answers
        // `{ok:false, error:'unknown method "variantStatus"'}`.
        return { ok: true, status, json: async () => outcome === 'absent'
          ? { ok: false, error: 'unknown method "variantStatus"' }
          : { ok: true, value: outcome } };
      }
      return { ok: true, status, json: async () => ({ ok: true, value: method === 'listWorkspaceRecords' ? records : [] }) };
    },
  });
  plugin.apply(ctx);
  return {
    calls, services, dialog, mount, summary, setPreset, opened, pending,
    emit: () => subscriber?.(),
    tick: () => tick?.(),
    setVariantStatus: value => { outcome = value; },
    dispose: () => effects.reverse().forEach(fn => typeof fn === 'function' && fn()),
    selected: () => calls.filter(c => c[0] === 'select').map(c => c[1]),
    creates: () => calls.filter(c => c[0] === 'create').length,
    starts: () => calls.filter(c => c[0] === 'start').map(c => c[1]),
  };
}

for (const legacy of [true, false]) {
  const line = legacy ? 'legacy' : 'current';

  test(`${line}: apply() survives a runtime that exposes no version-specific service`, async () => {
    const f = fixture({ legacy, late: true, startService: 'none' });
    await flush();
    assert.equal(f.selected().length, 0);
    f.dispose();
  });

  test(`${line}: a blank WSL session binds to its WSL variant`, async () => {
    const f = fixture({ legacy });
    await flush();
    assert.deepEqual(f.selected(), ['wsl-standard']);
    f.dispose();
  });

  test(`${line}: a blank session binds when the services land after apply`, async () => {
    const f = fixture({ legacy, late: true });
    await flush();
    f.mount();
    f.tick();
    await flush();
    assert.deepEqual(f.selected(), ['wsl-standard']);
    f.dispose();
  });

  test(`${line}: every mode converges to its WSL variant`, async () => {
    const f = fixture({ legacy });
    await flush();
    for (const mode of ['code', 'ptc', 'minimal', 'cordis', 'custom']) {
      f.setPreset(mode);
      f.emit();
      await flush();
      assert.equal(f.selected().at(-1), `wsl-${mode}`);
    }
    f.dispose();
  });

  test(`${line}: create & open starts a session in the new workspace`, async () => {
    const f = fixture({ legacy });
    await flush();
    const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
    assert.equal(error, undefined);
    assert.equal(f.creates(), 1);
    assert.deepEqual(f.starts(), ['w1']);
    f.dispose();
  });
}

test('current: create & open starts a session when uiWorkspace registers after apply', async () => {
  // Regression: the plugin applies before the UI domain publishing
  // `uiWorkspace` registers its service, so caching the lookup at apply time
  // made `startSession` unavailable for the whole page life and left the new
  // workspace behind with no session.
  const f = fixture({ legacy: false, late: true });
  await flush();
  assert.equal(typeof f.services.uiWorkspace, 'undefined');
  f.mount();
  const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
  assert.equal(error, undefined);
  assert.equal(f.creates(), 1);
  assert.deepEqual(f.starts(), ['w1']);
  f.dispose();
});

test('create & open refuses without a session starter, and writes nothing', async () => {
  for (const legacy of [true, false]) {
    const f = fixture({ legacy, startService: 'none' });
    await flush();
    const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
    assert.equal(typeof error, 'string');
    assert.match(error, /session API unavailable/);
    // The point of resolving the starter first: no orphaned workspace.
    assert.equal(f.creates(), 0);
    f.dispose();
  }
});

test('current: create & open never falls back to the legacy starter', async () => {
  // A v0.1.2-rc.1+ runtime keeps `uiWorkspace`; `workspaces.startSession` is
  // gone there, so the legacy branch must not be reached even if a stray
  // function of that name exists.
  const f = fixture({ legacy: false, startService: 'ui' });
  await flush();
  const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
  assert.equal(error, undefined);
  assert.deepEqual(f.starts(), ['w1']);
  f.dispose();
});

// Issue #49: a WSL session's file references carry absolute LINUX paths, and
// the host resolves such a path with `node:path.resolve(cwd, path)`, where a
// POSIX absolute path is root-relative — so the preview reports the file
// missing. These cases run the SHIPPED bundle and assert the address the
// right-Sidebar controller receives, which is the whole repair.

/** The address the shipped bundle builds for one path, as the chat view does. */
const addressFor = (sessionId, cwd, path) => {
  const normalized = path.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  return `dsh-resource://file/session/${sessionId}/${relative}`;
};

test('current: a WSL reference is translated to the file the model named', async () => {
  const f = fixture({ legacy: false, sidebarRight: true });
  await flush();
  // The fixture session's cwd is a WSL UNC path, so its references are WSL ones.
  const cwd = f.summary.cwd;
  const drvfs = addressFor('s1', cwd, '/mnt/d/AORUS/Documents/pkg/package.json');
  f.services.sidebarRight.openResource(drvfs);
  assert.deepEqual(f.opened, [['openResource', 'dsh-resource://file/session/s1/D:/AORUS/Documents/pkg/package.json', undefined]]);
  f.opened.length = 0;
  // An in-distribution path becomes the workspace-relative address, which the
  // host resolves against the same cwd — the shape the issue reports for a
  // workspace registered inside the distribution.
  const inside = addressFor('s1', cwd, '/tmp/fixture/VERSION');
  f.services.sidebarRight.openResource(inside);
  assert.deepEqual(f.opened, [['openResource', 'dsh-resource://file/session/s1/VERSION', undefined]]);
  f.dispose();
});

test('current: the translation also covers a tab action, and is undone on dispose', async () => {
  const f = fixture({ legacy: false, sidebarRight: true });
  await flush();
  const controller = f.services.sidebarRight;
  const address = addressFor('s1', f.summary.cwd, '/mnt/d/x.txt');
  controller.openResourceIn('s1', address, { line: 3 });
  assert.deepEqual(f.opened, [['openResourceIn', 's1', 'dsh-resource://file/session/s1/D:/x.txt', { line: 3 }]]);
  // Disposal restores the controller's own methods, so an unloaded plugin
  // leaves no wrapper behind.
  f.dispose();
  f.opened.length = 0;
  controller.openResourceIn('s1', address, { line: 3 });
  assert.deepEqual(f.opened, [['openResourceIn', 's1', address, { line: 3 }]]);
});

test('current: a drive workspace is translated from the registered distribution', async () => {
  const cwd = 'D:\\AORUS\\Documents\\deepseek-harness\\default-workspace';
  const f = fixture({
    legacy: false,
    sidebarRight: true,
    records: [{ path: 'd:\\aorus\\documents\\deepseek-harness\\default-workspace', distro: 'Ubuntu', username: 'mille' }],
  });
  f.summary.cwd = cwd;
  await flush();
  f.services.sidebarRight.openResource(addressFor('s1', cwd, '/mnt/d/AORUS/Documents/deepseek-harness/default-workspace/pkg/a.json'));
  assert.deepEqual(f.opened, [['openResource', 'dsh-resource://file/session/s1/pkg/a.json', undefined]]);
  f.opened.length = 0;
  // `/etc/hosts` is on no drive mount: only the distribution's share can serve
  // it, and the record above is where that distribution comes from.
  f.services.sidebarRight.openResource(addressFor('s1', cwd, '/etc/hosts'));
  assert.deepEqual(f.opened, [['openResource', 'dsh-resource://file/session/s1///wsl.localhost/Ubuntu/etc/hosts', undefined]]);
  f.dispose();
});

test('current: a session outside the WSL world keeps its references untouched', async () => {
  const f = fixture({ legacy: false, sidebarRight: true });
  f.summary.cwd = 'C:\\Users\\mille\\plain-workspace';
  await flush();
  const address = addressFor('s1', f.summary.cwd, '/mnt/d/x.txt');
  f.services.sidebarRight.openResource(address);
  assert.deepEqual(f.opened, [['openResource', address, undefined]]);
  f.dispose();
});

test('a release without a right Sidebar loads, and the hook simply does not install', async () => {
  // DSH 0.1.0-rc.7 … 0.1.3-alpha.2 ship no right Sidebar, no document preview
  // and no resource model: there is no reference surface to fix, and the plugin
  // must still mount (the W action and the variant binding are its other jobs).
  const f = fixture({ legacy: false, sidebarRight: false });
  await flush();
  assert.equal(f.pending.length, 1);
  assert.equal(f.services.sidebarRight, undefined);
  assert.deepEqual(f.selected(), ['wsl-standard']);
  f.dispose();
});

// Issue #52: why a `wsl-*` variant failed to generate used to reach the DSH
// Desktop user as one flat sentence — "no healthy wsl preset" — because the
// reason only ever went to the host's stdout, which Desktop does not persist.
// The host now serves that outcome as a module fact (`variantStatus`), and
// these cases pin what the dialog does with it: name the variant, carry the
// host's reason.
//
// The fixture's `t` is the identity, so a dictionary key comes back as itself —
// which is what lets a case assert on the KEY (which branch spoke) separately
// from the detail text the client composes around it (the evidence).

/** A `partial` outcome: most variants published, `wsl-code` did not. */
const partialOutcome = (generation = 3) => ({
  state: 'partial',
  produced: 5,
  sources: 6,
  failed: [{
    id: 'wsl-code',
    source: 'modes/code/agent-preset.yaml',
    reason: 'Cannot find module \'js-yaml\'',
  }],
  truncated: 0,
  generation,
  at: 1767225600000,
});

test('the dialog names the failed variant and the host\'s own reason', async () => {
  // The assertion that makes a generic sentence fail: BOTH the variant id and
  // the host's reason text must appear verbatim. "No healthy wsl preset" names
  // neither, and a reworded reason is not the reason.
  //
  // The roster is the shape this failure actually produces: a variant that
  // could not be GENERATED never reaches the roster, so the roster carries no
  // `wsl-*` entry at all and the host's outcome is the only evidence there is.
  // That is why the pre-#52 client answered the flat "no healthy wsl preset"
  // sentence here — the reason existed, on the host's stdout, unreadable.
  const f = fixture({
    legacy: false,
    roster: [{ id: 'standard', isDefault: true }],
    variantStatus: partialOutcome(),
  });
  await flush();
  const message = await f.dialog.checkPreset();
  assert.equal(typeof message, 'string');
  assert.ok(message.includes('wsl-code'), `the message must name the variant, got: ${message}`);
  assert.ok(message.includes('Cannot find module \'js-yaml\''),
    `the message must carry the host's reason verbatim, got: ${message}`);
  // Neither the sentence this case exists to replace, nor a bare key: both
  // would leave the user with the variant and the reason still unknown.
  assert.notEqual(message, 'error.presetMissing');
  assert.notEqual(message, 'error.presetBroken');
  f.dispose();
});

test('a healthy boot shows no preset error at all', async () => {
  // `state:'ok'` is the whole generation having published, and the roster is
  // healthy too, so neither layer has anything to report. The dialog must stay
  // silent rather than invent a warning.
  const f = fixture({
    legacy: false,
    variantStatus: { state: 'ok', produced: 6, sources: 6, failed: [], truncated: 0, generation: 4, at: 1767225600000 },
  });
  await flush();
  assert.equal(await f.dialog.checkPreset(), undefined);
  f.dispose();
});

test('an empty roster is a generation still running, not a missing plugin', async () => {
  // The window this issue lives in: the open flow checks the preset while the
  // profile is still booting, so a roster with nothing published yet is the
  // NORMAL state — not a deployment without the plugin. Reporting the missing
  // plugin here sends the user to install something they already have.
  const f = fixture({ legacy: false, roster: [] });
  await flush();
  assert.equal(await f.dialog.checkPreset(), 'error.presetPending');
  f.dispose();
});

test('a host without the outcome still answers from the roster, as before', async () => {
  // An old host answers `{ok:false, error:'unknown method "variantStatus"'}`
  // (pinned by tests/route-envelope.mjs), so the client must fall back to the
  // roster and reach the SAME verdicts it reached before the outcome existed:
  // silent when a `wsl-*` variant is healthy, and silent when one healthy
  // variant sits beside a broken one.
  for (const roster of [
    undefined,
    [
      { id: 'standard', isDefault: true },
      { id: 'wsl-standard' },
      { id: 'wsl-code', broken: 'preset file is not readable' },
    ],
  ]) {
    const f = fixture({ legacy: false, roster, variantStatus: 'absent' });
    await flush();
    assert.equal(await f.dialog.checkPreset(), undefined);
    f.dispose();
  }
});

test('an outcome older than one already read is not shown', async () => {
  // `generation` increments per host effect apply and per dispose, so a SMALLER
  // value is a read that lost its race with a re-apply. Reporting it would
  // describe a failure from a boot that is already over.
  // The roster holds no `wsl-*` entry, so the outcome is the only evidence —
  // which is what makes the generation counter the deciding fact here.
  const f = fixture({
    legacy: false,
    roster: [{ id: 'standard', isDefault: true }],
    variantStatus: partialOutcome(9),
  });
  await flush();
  const first = await f.dialog.checkPreset();
  assert.ok(first.includes('wsl-code'), `the fresh outcome is reported, got: ${first}`);
  f.setVariantStatus(partialOutcome(8));
  assert.equal(await f.dialog.checkPreset(), undefined,
    'a stale generation must not reach the dialog');
  f.dispose();
});
