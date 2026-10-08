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
 */
/**
 * The deadline every host call gets inside these tests.
 *
 * The product asks for 30 000 ms. Waiting that long to reach the timeout branch would put half a
 * minute on every run for one assertion, so the sandbox intercepts `AbortSignal.timeout` and clamps
 * to this. It is a shortened clock, not a stubbed signal: what fires is the real `abort` event on a
 * real `AbortSignal`, so the code path under test is the one a user reaches.
 */
const TEST_DEADLINE_MS = 60

function fixture({ legacy = false, late = false, startService = legacy ? 'legacy' : 'ui', sidebarRight = false, records = [], roster, variantStatus = 'absent', apiHttpStatus = null, apiHangs = false } = {}) {
  let plugin, dialog, subscriber, tick;
  // The host's `variantStatus` answer, mutable so a test can move it between two reads: a generation
  // counter that goes BACKWARDS is the stale read the client has to ignore.
  let outcome = variantStatus;
  const effects = [], calls = [], opened = [], pending = [];
  const apiSignals = [];
  const summary = legacy
    ? { blank: true, cwd: '\\\\wsl.localhost\\Ubuntu\\tmp\\fixture', agentPreset: 'standard' }
    : { blank: true, cwd: '\\\\wsl.localhost\\Ubuntu\\tmp\\fixture', projectionValues: { agentPreset: 'standard' } };
  const state = { ids: ['s1'], byId: { s1: summary } };
  const setPreset = value => {
    if (legacy) summary.agentPreset = value;
    else summary.projectionValues = { agentPreset: value };
  };
  // `roster` replaces the derived list when a test needs a roster that a real boot could produce: a
  // variant that could not be GENERATED never reaches the roster at all, so the failure has to be
  // modelled as an absent entry rather than a broken one. `[]` is a generation still running.
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
    // `api.ts` gives every host call a deadline, so the client needs this global. Two things about
    // how it is supplied:
    //
    //  · **It is the platform's own implementation, not a stub.** A fake answering `{aborted: false}`
    //    for ever would keep these tests green while proving nothing about the semantics the product
    //    relies on — the same shape of false green this file's siblings exist to prevent.
    //  · **Only the clock is shortened.** `AbortSignal.timeout` is intercepted so a 30-second deadline
    //    becomes 60 ms, which is what lets a test actually reach the timeout branch instead of waiting
    //    half a minute for it. Everything else — the class, `aborted`, the `abort` event, the
    //    `reason` — is the real thing, so `instanceof AbortSignal` still holds and the branch under
    //    test is the branch the product runs.
    //
    // The #52 branch had reached for `AbortController` + `setTimeout` here, because its own `call()`
    // was built from those. This one is built from `AbortSignal.timeout`, so only the class is needed
    // — a global handed in for machinery the source no longer uses is a global that hides the day the
    // machinery changes.
    AbortSignal: new Proxy(AbortSignal, {
      get: (target, key) => key === 'timeout'
        ? ms => target.timeout(Math.min(ms, TEST_DEADLINE_MS))
        : Reflect.get(target, key, target),
    }),
    // The plugin's host API calls: only the workspace record read has a shape
    // under test, and every other route answers an empty list.
    //
    // `init.signal` is recorded and honoured rather than ignored: the deadline the product attaches
    // to a call is a claim until something drives it, and a fake that drops the argument cannot tell
    // a call that carries a deadline from one that carries none. `status` is present because the
    // client reads it: the status leads every refusal, so a body claiming `{ok:true}` on a 404 must
    // not be mistaken for a value.
    fetch: async (_url, init) => {
      apiSignals.push(init.signal);
      if (apiHangs) {
        // Fetch rejects with an error named `AbortError` when its signal aborts, and the product
        // tells that apart from a transport refusal by name, so the fake has to as well. The plain
        // timer is this realm's, and exists because the deadline's own timer is unref'd — without
        // something ref'd the event loop would empty and the test would end mid-call.
        //
        // The second timer is a bound on the fake itself, and it is not decoration: without it, a
        // product that has **lost** its deadline leaves this promise unsettled for ever, the test
        // never returns, and the runner cancels the tests after it
        // (`cancelledByParent … the event loop has already resolved`). Measured by reverting
        // `api.ts` — four unrelated tests went red from that cascade. A fake that can hang the suite
        // is a fake that reports the defect as damage somewhere else.
        return await new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(() => {}, 60_000)
          const giveUp = setTimeout(() => {
            clearTimeout(keepAlive)
            reject(new Error(
              `the fixture waited ${TEST_DEADLINE_MS * 20} ms and the call was never aborted: `
              + 'the product attached no deadline to it',
            ))
          }, TEST_DEADLINE_MS * 20)
          const abort = () => {
            clearTimeout(keepAlive)
            clearTimeout(giveUp)
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          }
          if (init.signal?.aborted === true) abort()
          else init.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (apiHttpStatus !== null) {
        // A non-2xx answer, with a body that is not JSON: a proxy's error page is the real case, and
        // it is exactly what used to be reported as "non-JSON" with the status lost.
        return {
          ok: false,
          status: apiHttpStatus,
          statusText: 'Internal Server Error',
          json: async () => { throw new Error('the body is an error page, not JSON'); },
        };
      }
      const method = JSON.parse(init.body).method;
      if (method === 'variantStatus') {
        // An old host has no such case in its switch, so the route answers
        // `{ok:false, error:'unknown method "variantStatus"'}` — which the client has to read as
        // "this host predates the outcome", and not as a failure.
        return {
          ok: true,
          status: 200,
          json: async () => outcome === 'absent'
            ? { ok: false, error: 'unknown method "variantStatus"' }
            : { ok: true, value: outcome },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: method === 'listWorkspaceRecords' ? records : [] }),
      };
    },
  });
  plugin.apply(ctx);
  return {
    calls, services, dialog, mount, summary, setPreset, opened, pending,
    emit: () => subscriber?.(),
    tick: () => tick?.(),
    dispose: () => effects.reverse().forEach(fn => typeof fn === 'function' && fn()),
    selected: () => calls.filter(c => c[0] === 'select').map(c => c[1]),
    creates: () => calls.filter(c => c[0] === 'create').length,
    starts: () => calls.filter(c => c[0] === 'start').map(c => c[1]),
    apiSignals: () => apiSignals,
    setVariantStatus: value => { outcome = value; },
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

// Issue #44 §6: the two ways a host call used to fail without saying so. Both are about the shape
// of the answer rather than the transport: the call reached the host, the host said something, and
// the dialog reported neither what it said nor that it had said anything at all.
//
// `createWorkspace` is the vehicle because it is the one entry point these fixtures already drive
// through `api.ts` — it makes a host call and hands the message back, which is exactly the seam the
// two defects sat on.

test('a host call that never answers is reported as a timeout, not awaited for ever', async () => {
  // Before the deadline existed, a request that never settled left the dialog waiting on a promise
  // that could not resolve: no message, no error, and Retry as the only way out — which a user has
  // no reason to press, because nothing told them anything was wrong.
  const f = fixture({ legacy: false, apiHangs: true });
  await flush();
  const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
  // The product's own sentence, naming the deadline it asked for. The sandbox clamps the *clock* to
  // `TEST_DEADLINE_MS`; it does not change what the message says, so this also pins that the two
  // have not drifted apart.
  assert.match(String(error), /did not answer within 30s/)
  f.dispose();
})

test('a non-2xx answer names its status instead of reporting a parse failure', async () => {
  // A proxy answering an error page: the body is not JSON, so the old code failed inside
  // `response.json()` and reported "non-JSON" — which is true, and names the symptom while losing
  // the status that says what actually happened.
  const f = fixture({ legacy: false, apiHttpStatus: 500 });
  await flush();
  const error = await f.dialog.createWorkspace('/home/mille/ws', 'mille', 'Ubuntu');
  assert.match(String(error), /HTTP 500/)
  assert.doesNotMatch(String(error), /non-JSON/)
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
  // The `n/m` count, from the host's own tally (`partialOutcome` publishes 5 of 6 sources). Asserted
  // on the numbers rather than on the key, because the numbers are the fact: the fixture's `t` is the
  // identity, so the key alone would come back as its own name and would pass even if the client
  // printed a placeholder.
  assert.ok(message.includes('5/6'),
    `the message must carry the host's published count, got: ${message}`);
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

test('a host-marked-broken variant reports its own reason when nothing healthy is left', async () => {
  // Issue #52's second criterion, in the only state where it is reachable — and the state the old
  // client answered with the generic sentence. Layer 2 says one healthy `wsl-*` settles the question,
  // so a broken entry BESIDE a working one is deliberately silent (asserted above). The reason is
  // shown when there is nothing healthy to fall back on, which is what this pins: the roster's own
  // `broken` string, verbatim, instead of `error.presetMissing`.
  //
  // No outcome either, on purpose. This is the arm that reads the roster rather than the host's
  // generation record, and it has to work on a host that predates `variantStatus` — which is exactly
  // the host where the roster is all there is. The case above exercises that arm's silent verdict;
  // this one exercises its speaking one, which no other case reaches.
  const f = fixture({
    legacy: false,
    roster: [
      { id: 'standard', isDefault: true },
      { id: 'wsl-code', broken: 'preset file is not readable' },
    ],
    variantStatus: 'absent',
  });
  await flush();
  const message = await f.dialog.checkPreset();
  assert.equal(typeof message, 'string');
  assert.ok(message.includes('wsl-code'), `the message must name the variant, got: ${message}`);
  assert.ok(message.includes('preset file is not readable'),
    `the message must carry the roster's own reason, got: ${message}`);
  // Neither the sentence this arm exists to replace nor a bare key, for the same reason as the
  // outcome arm: both would leave the user with the variant and the reason still unknown.
  assert.notEqual(message, 'error.presetMissing');
  assert.notEqual(message, 'error.presetBroken');
  f.dispose();
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
