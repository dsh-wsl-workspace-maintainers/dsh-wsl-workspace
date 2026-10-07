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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * @param options.route - override one method's whole HTTP answer: a
 *   `(method) => { status, body } | undefined`. `status` defaults to 200, and
 *   `body` is what `response.json()` resolves to — a function models a body
 *   that throws while parsing, a STRING is parsed as JSON text (so `null` and
 *   `'"a string"'` are the wire shapes they look like), anything else is
 *   handed over as the parsed value. Returning undefined falls through to the
 *   fixture's default answer for that method.
 */
function fixture({ legacy = false, late = false, startService = legacy ? 'legacy' : 'ui', sidebarRight = false, records = [], roster, variantStatus = 'absent', route } = {}) {
  let plugin, dialog, subscriber, tick;
  // The host's `variantStatus` answer, mutable so a test can move it between
  // two reads (a generation counter that goes BACKWARDS is the stale read).
  let outcome = variantStatus;
  const effects = [], calls = [], opened = [], pending = [];
  // The abort signal handed to each fetch and the delay of each budget timer,
  // so the timeout guard is assertable without waiting a real 20 seconds out.
  const signals = [], budgets = [];
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

  const localeCalls = []
  const ctx = {
    get: key => services[key],
    effect: fn => effects.push(fn()),
    inject: (deps, callback) => { pending.push({ deps, callback }); runInjections(); },
    // `register` **records** instead of discarding. It used to be `() => () => {}`, which made this
    // file prove only that the service *exists* — the dictionaries the user actually reads were
    // handed over and dropped, with nothing able to notice. A stub that accepts everything and
    // remembers nothing is the shape of a test that cannot fail on the half it does not look at.
    locale: { register: (...args) => { localeCalls.push(args); return () => {} }, bind: () => key => key },
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
    // The bundle's ONLY `setTimeout` is the per-call budget, so recording its
    // delay pins the budget without waiting it out. It still forwards to the
    // host timer, so the clearTimeout in the bundle's `finally` keeps behaving.
    setTimeout: (fn, delay) => { budgets.push(delay); return setTimeout(fn, delay); },
    clearTimeout,
    // The plugin's host API calls: the workspace record read and the variant
    // outcome have shapes under test, and every other route answers an empty
    // list. `status` is present because the client reads it: a non-2xx body
    // carrying `{ok:true}` must not be mistaken for a value.
    fetch: async (_url, init) => {
      const method = JSON.parse(init.body).method;
      signals.push(init.signal);
      // A case that overrides this method's answer wins outright: the guards
      // under test are about what the client does with a hostile status/body.
      const override = route?.(method);
      if (override !== undefined) {
        const status = override.status ?? 200;
        const { body } = override;
        return {
          // `Response.ok` is derived from the status in a real fetch, so a 404
          // carrying `{ok:true}` is modelled the only way it can occur: the
          // status says 404 while the BODY claims success.
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            if (typeof body === 'function') return body();
            // A STRING is the wire text, so `null` and `'"a string"'` are the
            // parses they look like — both succeed, neither is an envelope.
            return typeof body === 'string' ? JSON.parse(body) : body;
          },
        };
      }
      if (method === 'variantStatus') {
        // An old host has no such case in its switch, so the route answers
        // `{ok:false, error:'unknown method "variantStatus"'}`.
        return { ok: true, status: 200, json: async () => outcome === 'absent'
          ? { ok: false, error: 'unknown method "variantStatus"' }
          : { ok: true, value: outcome } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: method === 'listWorkspaceRecords' ? records : [] }) };
    },
  });
  plugin.apply(ctx);
  return {
    calls, services, dialog, mount, summary, setPreset, opened, pending, signals, budgets,
    locales: () => localeCalls,
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

// Issue #44 T8b: the silent client failure. `call()` in src/client/api.ts grew
// four guards — read `response.ok`, name the status; a refusal with no reason
// still gets a sentence; every call is bounded by an AbortController; and an
// `ok:true` carrying no `value` is refused. The hole they close: a route that
// is NOT mounted answers 404 with a body some other handler produced, and the
// old code never read the status — so it unwrapped `{ok:true, value:42}` off a
// 404 and handed the caller `42` as its distro list. The user saw an empty
// picker and nothing else.
//
// These run against the SHIPPED bundle, so what is asserted is the artifact the
// browser actually loads, not the sources it was built from.

test('a 404 carrying ok:true is a refusal, not a distro list', async () => {
  // The core assertion of #44 T8b. `value` is a plausible-looking array so the
  // pre-#44 client's `return envelope.value` would have RESOLVED rather than
  // thrown: the bug was not a crash, it was a wrong answer delivered silently.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros'
      ? { status: 404, body: { ok: true, value: ['Ubuntu', 'Debian'] } }
      : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    // The Error is built INSIDE the vm sandbox, so `instanceof Error` is false
    // across the realm boundary — the message is what a caller reads.
    assert.equal(typeof error.message, 'string');
    assert.match(error.message, /404/, `the message must name the status, got: ${error.message}`);
    return true;
  });
  f.dispose();
});

test('a non-2xx whose body is JSON null names the status, not a TypeError', async () => {
  // `JSON.parse('null')` SUCCEEDS, so the body is `null` and reading `.ok` off
  // it throws `TypeError: Cannot read properties of null`. A TypeError names
  // neither the status nor the method, so the caller cannot tell a dead route
  // from a broken client — which is the failure mode this case forbids.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros' ? { status: 502, body: 'null' } : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    assert.ok(!(error instanceof TypeError), `a TypeError is not a usable refusal: ${error}`);
    assert.match(error.message, /502/, `the message must name the status, got: ${error.message}`);
    return true;
  });
  f.dispose();
});

test('a non-2xx whose body parses to a bare string is still refused', async () => {
  // `JSON.parse('"just a string"')` also succeeds and is not an envelope
  // either; `.ok` on a string is `undefined` (falsy), which would otherwise
  // walk into the refusal path with no reason to report.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros' ? { status: 500, body: '"just a string"' } : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    assert.ok(!(error instanceof TypeError), `a TypeError is not a usable refusal: ${error}`);
    assert.match(error.message, /500/, `the message must name the status, got: ${error.message}`);
    return true;
  });
  f.dispose();
});

test('a refusal carrying no reason still reads as a sentence', async () => {
  // `new Error(undefined)` renders as the word "undefined", which tells the
  // reader nothing. This is the shape a proxy inventing an envelope produces.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros' ? { status: 200, body: { ok: false, error: undefined } } : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
    assert.doesNotMatch(error.message, /undefined/, `the message must not be the word "undefined"`);
    assert.match(error.message, /refused without a reason/,
      `the message must say the refusal had no reason, got: ${error.message}`);
    return true;
  });
  f.dispose();
});

test('a refusal whose reason is an object carries that reason', async () => {
  // An Error serialized through JSON arrives as `{message}`, and the reason it
  // holds is the only diagnostic the user gets — flattening it to "[object
  // Object]" would throw away the cause.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros'
      ? { status: 200, body: { ok: false, error: { message: 'nested reason' } } }
      : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), /nested reason/);
  f.dispose();
});

test('ok:true with no value is refused rather than returned as undefined', async () => {
  // Returning `undefined` here is the quiet failure in its purest form: every
  // caller treats a missing value as an empty list and carries on, so a broken
  // route looks exactly like a host with no WSL distros installed.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros' ? { status: 200, body: { ok: true } } : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    assert.equal(typeof error.message, 'string');
    assert.match(error.message, /without a value/);
    return true;
  });
  f.dispose();
});

test('a body that is not JSON at all is refused with the status', async () => {
  // A proxy or a SPA index.html answering in place of the route: `json()`
  // throws, and the client must name the status rather than surface a raw
  // SyntaxError the user cannot act on.
  const f = fixture({
    legacy: false,
    route: method => method === 'listDistros'
      ? { status: 200, body: () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } }
      : undefined,
  });
  await flush();
  await assert.rejects(() => f.dialog.listDistros(), error => {
    assert.equal(typeof error.message, 'string');
    assert.doesNotMatch(error.message, /SyntaxError|Unexpected token/,
      `the raw parse failure is not a usable refusal, got: ${error.message}`);
    return true;
  });
  f.dispose();
});

test('every call is bounded, and the filesystem walks get the longer budget', async () => {
  // A call that never answers would leave the dialog's spinner up for the life
  // of the page. The budgets are asserted from the recorded timer delays and
  // the recorded abort signals — never by waiting them out.
  const f = fixture({ legacy: false });
  await flush();
  // `apply()` makes its own calls during the first flush (the workspace-record
  // read), so the budget ledger is cleared to pin exactly the two calls here.
  f.budgets.length = 0;
  f.signals.length = 0;
  // A directory level crosses the 9P share entry by entry, and the observed
  // cost of a large one exceeds the interactive default: a timeout there would
  // be a lie about a call still making progress.
  await f.dialog.listDir('Ubuntu', '/home/mille');
  await f.dialog.listDistros();
  assert.deepEqual(f.budgets, [60_000, 20_000],
    'listDir walks the filesystem and gets 60s; the interactive default is 20s');
  // The signal is the proof the budget is wired to the request at all: without
  // it the timer would fire into nothing and the call would hang forever.
  assert.equal(f.signals.length, 2);
  for (const signal of f.signals) {
    assert.ok(signal, 'every fetch must carry the AbortController signal');
    assert.equal(signal.aborted, false, 'the budget must not have fired during a call that answered');
  }
  f.dispose();
});

test('the client hands its dictionaries to the host, in both languages', () => {
  // The user-visible half of this plugin is its panel. `register('wslWorkspace', …)` is how the panel
  // reaches the host, and until the `register` above recorded its arguments nothing could tell whether
  // the handover happened at all — the fixture accepted the call and threw the payload away.
  const { locales } = fixture()
  const registration = locales().find(args => args[0] === 'wslWorkspace')
  assert.ok(registration !== undefined,
    `nothing registered a locale namespace; saw ${JSON.stringify(locales().map(a => a[0]))}`)
  const [, dictionaries] = registration
  assert.deepEqual(Object.keys(dictionaries ?? {}).sort(), ['en', 'zh'],
    'both languages go over, because a missing one renders as raw keys in the other language')

  // Derived, not listed: the keys the panel reads are read off the panel component, so a key the UI
  // asks for and the dictionary does not carry is a blank label with nothing to notice it.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'help.tsx'), 'utf8')
  const used = [...source.matchAll(/t\(\s*['"]([\w.]+)['"]/g)].map(match => match[1])
  assert.ok(used.length > 0, 'the panel reads no keys at all, so this test cannot fail')
  for (const language of ['zh', 'en']) {
    const missing = used.filter(key => dictionaries?.[language]?.[key] === undefined)
    assert.deepEqual(missing, [],
      `${language} is missing key(s) the panel renders: ${missing.join(', ')}`)
  }
})
