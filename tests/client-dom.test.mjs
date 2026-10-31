/**
 * G2 — the client's interaction states, rendered (issue #101).
 *
 * The sidebar action's React component was never mounted by anything in this repository:
 * `grep -rn "react-dom|jsdom|AddWslWorkspace" tests/ scripts/` → 0. Three client defects reached
 * users through that gap — #49 (a reference the preview could not open), #52 (a reason that existed
 * but had no way to be seen) and #99 (an empty red error row drawn on every healthy open, because
 * `undefined !== null`). None of them is visible to a test that only calls the injected face: the
 * face answered `undefined` correctly, and the component drew a box around it.
 *
 * So this file mounts **the shipped bundle** (`lib/client.js` — the bytes a user loads) with real
 * React in a real DOM, and asserts what is *rendered*: the presence of a row is not the question,
 * the text in it is. The states are the ones a user can reach, kept as a list rather than as a
 * handful of examples:
 *
 *   healthy open · preset failure · distro list refusal · directory failure ·
 *   help panel toggled · Escape while idle · Escape while busy · Retry
 *
 * `lib/client.js` is the committed artifact, so no build is needed and a stale bundle is what gets
 * tested — which is the point (`tests/verify-lib-sync` keeps it equal to `src/`).
 *
 * jsdom, react and react-dom are **devDependencies**: they never ship (the tarball's `files` list is
 * `lib` + docs), and the bundle keeps taking React from the host's loader.
 *
 *   npm run test:client
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Resolution is CJS on purpose: it keeps this file runnable from a checkout whose `node_modules`
// has not been reified (the maintainer machine), because `NODE_PATH` is honoured by `require` and
// not by `import`. In CI the same specifiers resolve from the ordinary `npm ci` tree.
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node ships its own `navigator` (a getter, and not configurable on every release). React does not
// need it, so a refusal here is not a failure — the DOM's document is what the renderer reads.
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch { /* keep the runtime's own navigator */ }
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { createRoot } = ReactDOMClient
const jsxRuntime = require('react/jsx-runtime')
// The shell's shared primitives table is a platform module, not a package on disk. This stub stands
// in for the one member the header entry uses and leaves the label visible as an attribute, so the
// test can tell the tooltip text from a native `title` bubble.
const primitives = {
  Tooltip: ({ label, children }) => React.cloneElement(children, { 'data-tooltip': label }),
}
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Mount the shipped client over a scripted host.
 *
 * The host answers the same five routes the dialog calls (`variantStatus`, `listDistros`, `listDir`,
 * `describe`, and the two registration methods), and every one of them can be made to refuse — a
 * fixture that can only succeed is a fixture that cannot fail the way the host fails (#47, #52).
 * @param scenario - mutable answers; a test changes them between passes.
 * @returns the mounted root, the rendered container, and the two ways a user acts (click, Escape).
 */
function mount(scenario, { wide = true } = {}) {
  const calls = []
  // The plugin keeps two pieces of module state — the per-session opt-out list
  // (in session storage) and the notice on screen. Both outlive one test's root,
  // so a mount that inherited them would not be describing a fresh page.
  try {
    dom.window.sessionStorage.clear()
  } catch { /* no storage in this engine: the in-memory fallback is per-process */ }
  /** The params of one host call, for an answer that depends on them. */
  const paramsOf = init => (JSON.parse(init.body).params ?? {})
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body)
    calls.push(method)
    // A function answer receives the call's params, so a state can make one distribution's listing fail
    // while another's succeeds — the shape a distro switch needs.
    const raw = scenario[method]
    const answer = typeof raw === 'function' ? raw(paramsOf(init)) : raw
    if (answer === 'refuse') {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: `${method} refused by the host` }) }
    }
    if (answer && answer.then !== undefined) return answer
    return { ok: true, status: 200, json: async () => ({ ok: true, value: answer ?? [] }) }
  }

  let component
  let face
  let dictionaries = {}
  /** Every contribution, keyed by the seat it landed in, for the exits' tests. */
  const seats = new Map()
  /** The agent-preset swaps the plugin asked the host for, in order. */
  const selectCalls = []
  /** The sessions list store the plugin reads; a test mutates it and calls `notifyList`. */
  const listState = scenario.listState ?? { ids: [], byId: {} }
  let listListener = null
  const services = {
    sessions: {
      list: {
        getSnapshot: () => listState,
        subscribe: (fn) => { listListener = fn; return () => { listListener = null } },
      },
    },
    workspaces: scenario.workspaces ?? { create: async () => ({ workspaceId: 'w1' }), startSession: () => {} },
    'remote.agentPresets': {
      list: async () => ({
        ok: true,
        value: {
          presets: scenario.presets === 'none'
            ? [{ id: 'standard', isDefault: true }]
            : [{ id: 'standard', isDefault: true }, { id: 'wsl-standard' }, { id: 'wsl-code' }],
        },
      }),
      // The host locks a preset once a session has produced output, and the
      // exit has to show that refusal rather than swallow it.
      select: async (sessionId, agentPreset) => {
        selectCalls.push({ sessionId, agentPreset })
        if (scenario.selectRefuses === true) return { ok: false, error: { message: 'agent-preset-locked' } }
        return { ok: true }
      },
    },
    uiWorkspace: { startSession: () => {} },
  }
  const ctx = {
    get: key => services[key],
    // Real disposers, collected: the runtime ties an effect and a slot
    // contribution to the plugin's fiber, so a test that leaves them mounted
    // would run several instances of the mirrors over one document at once —
    // which no page does.
    effects: [],
    effect: fn => { const disposer = fn(); if (typeof disposer === 'function') ctx.effects.push(disposer); return () => {} },
    inject: (deps, callback) => { if (deps.every(dep => services[dep] !== undefined)) callback(ctx) },
    locale: {
      register: (_namespace, dictionary) => { dictionaries = dictionary; return () => {} },
      bind: () => key => dictionaries.zh?.[key] ?? key,
    },
    slots: {
      inject: (_name, fn) => { const disposer = fn(); if (typeof disposer === 'function') ctx.effects.push(disposer); },
      register: (config, Component) => {
        const injected = config.inject === undefined ? {} : config.inject()
        seats.set(config.name, { config, Component, injected })
        // The dialog keeps being the default component, so the existing
        // interaction tests do not change meaning; a seat registers without an
        // inject face (the overlay notice) contributes only its component.
        if (config.name === 'sidebar.footer.action') { face = injected; component = Component }
        return () => {}
      },
    },
  }

  let plugin
  dom.window.__ModuleLoader__ = { load: mod => { plugin = mod.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === 'react-dom/client') return ReactDOMClient
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${specifier})`)
  }) } }
  // The DOM's timers, not the host's: the bundle arms a 60-second roster refresh and the process
  // must be allowed to exit.
  const setInterval = dom.window.setInterval
  dom.window.setInterval = () => 1
  dom.window.clearInterval = () => {}
  try {
    new Function('window', 'document', 'require', source)(dom.window, globalThis.document, specifier => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      if (specifier === 'react-dom/client') return ReactDOMClient
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`unexpected require(${specifier})`)
    })
    plugin.apply(ctx)
  } finally {
    dom.window.setInterval = setInterval
  }

  // A fresh container per mount. Two roots must never share one (React refuses
  // it), and every root this helper opens is taken down by `unmount()` below —
  // a root left mounted keeps its `useEffect` mirrors observing the document, and
  // the next test's client then reads a menu the previous one trimmed.
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const act = React.act
  return {
    container,
    root,
    face,
    zh: () => dictionaries.zh ?? {},
    calls,
    act,
    seats,
    selectCalls,
    listState,
    /** Fire the session-list subscription the way a store change would. */
    notifyList: () => { listListener?.() },
    /**
     * Render one contributed seat the way the host renders a slot entry: the
     * owner share merged over the inject face the registration supplied.
     * @param name - the seat, e.g. `sidebar.workspaces.session.menu.item`.
     * @param props - the owner share for one occurrence.
     * @param within - an element to mount inside, for a row that must sit in a menu.
     * @returns the seat's container, a click helper, and a disposer.
     */
    async renderSeat(name, props, within = document.body) {
      const seat = seats.get(name)
      assert.ok(seat !== undefined, `nothing was contributed to ${name}`)
      const seatContainer = document.createElement('div')
      within.appendChild(seatContainer)
      const seatRoot = createRoot(seatContainer)
      await act(async () => { seatRoot.render(React.createElement(seat.Component, { ...seat.injected, ...props })) })
      await act(flush)
      return {
        container: seatContainer,
        async click(selector) {
          const element = seatContainer.querySelector(selector)
          assert.ok(element !== null, `nothing matches ${selector} — rendered: ${seatContainer.innerHTML.slice(0, 300)}`)
          await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
          await act(flush)
          return element
        },
        dispose() { seatRoot.unmount(); seatContainer.remove() },
      }
    },
    async render() {
      await act(async () => { root.render(React.createElement(component, { wide, ...face })) })
      await act(flush)
    },
    async click(selector) {
      const element = container.querySelector(selector)
      assert.ok(element !== null, `nothing matches ${selector} — rendered: ${container.innerHTML.slice(0, 400)}`)
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
      await act(flush)
      return element
    },
    /** Choose a value in a `<select>` the way a user does: set it, then let React see the change. */
    async select(selector, value) {
      const element = container.querySelector(selector)
      assert.ok(element !== null, `nothing matches ${selector} — rendered: ${container.innerHTML.slice(0, 300)}`)
      await act(async () => {
        element.value = value
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await act(flush)
      return element
    },
    async escape() {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await act(flush)
    },
    /**
     * Tear the client down the way unloading its fiber would: the dialog's React
     * root first (its `useEffect` is what mounts the picker mirror, and a mirror
     * left observing the document would trim the next test's menus), then the
     * disposers the plugin registered through effects and slot contributions.
     */
    async unmount() {
      await act(async () => { root.unmount() })
      for (const disposer of ctx.effects.splice(0).reverse()) disposer()
    },
  }
}

/** The default scenario: a healthy install with one distribution and one directory. */
function healthy(overrides = {}) {
  return {
    variantStatus: { state: 'ok', produced: 6, sources: 6, failed: [], truncated: 0, generation: 1, at: 1 },
    listDistros: ['Ubuntu-24.04'],
    listDir: { path: '/', parent: null, entries: [{ name: 'home', kind: 'directory' }] },
    describe: { version: '0.7.8', releases: [] },
    ...overrides,
  }
}

/** Open the dialog and let the open pass settle. */
async function open(client) {
  await client.render()
  await client.click('.dww-action')
}

test('a healthy install opens the dialog and draws no error row at all', { timeout: 10_000 }, async () => {
  // #99: the row rendered on every healthy open because `undefined !== null`. The assertion is on
  // absence *and* on the surrounding state, so a component that fails to open cannot pass it.
  const client = mount(healthy())
  try {
    await open(client)
    assert.ok(client.container.querySelector('.dww-card') !== null, 'the dialog must open')
    assert.ok(client.container.querySelector('.dww-error') === null,
      `an error row was drawn on a healthy install: ${client.container.querySelector('.dww-error')?.outerHTML ?? ''}`)
    assert.ok(client.container.querySelector('.dww-retry') === null, 'no retry control without a failure')
    const options = [...client.container.querySelectorAll('.dww-select option')].map(option => option.textContent)
    assert.deepEqual(options, ['Ubuntu-24.04'], 'the distribution list is what the host answered')
    assert.equal(client.container.querySelectorAll('.dww-dir-row').length, 1, 'the directory tree filled')
  } finally { await client.unmount() }
})

test('a blank message from any path draws nothing', { timeout: 10_000 }, async () => {
  // The second half of #99's fix, and the reason it was stated separately: the row now requires
  // *text*, not merely "not null". No host route can hand the dialog an empty string today
  // (`api.ts` names a reason for every refusal), so this pins the component's own contract — the
  // next path that produces `''` must not draw a bordered box around nothing.
  const client = mount(healthy())
  try {
    client.face.checkPreset = async () => ''
    await open(client)
    assert.ok(client.container.querySelector('.dww-error') === null,
      'an empty message must not draw a row: the condition is about text, not about null')
  } finally { await client.unmount() }
})

test('a failed browse on one distribution is retired by a successful one on another', async () => {
  // The stale-message shape, one layer below #52/#99: `refreshBrowse` set `error.loadDir` on a failure and
  // never cleared it on success, so switching back to a working distribution left "could not browse this
  // directory" over a listing that had just loaded. One `error` string cannot say which failure it holds,
  // so the component tracks the provenance and retires only the browse one.
  const scenario = healthy({
    listDistros: ['Ubuntu-22.04', 'Ubuntu-24.04'],
    listDir: params => (params.distro === 'Ubuntu-24.04'
      ? 'refuse'
      : { path: params.path, parent: null, entries: [{ name: 'home', kind: 'directory' }] }),
  })
  const client = mount(scenario)
  try {
    await open(client)
    assert.ok(client.container.querySelector('.dww-error') === null, 'the healthy open draws no row')

    await client.select('.dww-select', 'Ubuntu-24.04')
    const strip = client.container.querySelector('.dww-error')
    assert.ok(strip !== null, 'the refused listing must draw a row')
    assert.match(strip.textContent ?? '', new RegExp(client.zh()['error.loadDir'].slice(0, 6)),
      `the row must name the browse failure, got: ${strip.textContent}`)

    await client.select('.dww-select', 'Ubuntu-22.04')
    assert.ok(client.container.querySelector('.dww-error') === null,
      'a successful browse must retire the browse failure it replaces')
    assert.ok(client.container.querySelectorAll('.dww-dir-row').length >= 1, 'and the listing is what loaded')
  } finally { await client.unmount() }
})

test('the trigger stays in the tree while the dialog is open, out of the tab order', { timeout: 10_000 }, async () => {
  // The other half of the same dialog: opening used to unmount the trigger, so the footer row
  // collapsed and everything under it jumped (fixed with #98). aria-modal means the button leaves
  // the tab order, not the document.
  const client = mount(healthy())
  try {
    await open(client)
    const trigger = client.container.querySelector('.dww-action')
    assert.ok(trigger !== null, 'the trigger must remain mounted')
    assert.equal(trigger.getAttribute('aria-hidden'), 'true')
    assert.equal(trigger.getAttribute('tabindex'), '-1')
    assert.match(trigger.textContent, /WSL工作区/, 'the wide form carries the label')
  } finally { await client.unmount() }
})

test('a preset failure names the variant and the host\'s own reason', { timeout: 10_000 }, async () => {
  // #52: the reason existed on the host and never reached the dialog. The row must carry it, not a
  // generic sentence — and it must be *rendered*, which is the half no test covered.
  const outcome = {
    state: 'partial', produced: 5, sources: 6, generation: 2, at: 1, truncated: 0,
    failed: [{ id: 'wsl-code', source: 'modes/code/agent-preset.yaml', reason: "Cannot find module 'js-yaml'" }],
  }
  const client = mount(healthy({ variantStatus: outcome, presets: 'none' }))
  try {
    await open(client)
    const strip = client.container.querySelector('.dww-error')
    assert.ok(strip !== null, 'a generation failure must draw a row')
    const text = strip.textContent ?? ''
    assert.match(text, /wsl-code/, `the row must name the variant, got: ${text}`)
    assert.match(text, /Cannot find module 'js-yaml'/, `the row must carry the host's reason, got: ${text}`)
    assert.match(text, /5\/6/, `the row must carry the host's own count, got: ${text}`)
    assert.ok(client.container.querySelector('.dww-retry') !== null, 'a failure offers Retry')
  } finally { await client.unmount() }
})

test('a refused distro list is reported in words and leaves the form usable', { timeout: 10_000 }, async () => {
  const client = mount(healthy({ listDistros: 'refuse' }))
  try {
    await open(client)
    const strip = client.container.querySelector('.dww-error')
    assert.ok(strip !== null, 'a refused list must draw a row')
    assert.match(strip.textContent ?? '', new RegExp(client.zh()['error.loadDistros'].slice(0, 8)),
      `the row must carry the host-facing sentence, got: ${strip.textContent}`)
    // The failure is not fatal: the dialog stays open with its fields, which is what makes Retry a
    // sensible offer rather than a dead end.
    assert.ok(client.container.querySelector('.dww-card') !== null, 'the dialog stays open')
    assert.ok(client.container.querySelector('#dww-path') !== null, 'the form is still there')
  } finally { await client.unmount() }
})

test('a directory that cannot be listed names the directory failure, not the distro one', { timeout: 10_000 }, async () => {
  const client = mount(healthy({ listDir: 'refuse' }))
  try {
    await open(client)
    const strip = client.container.querySelector('.dww-error')
    assert.ok(strip !== null, 'a failed browse must draw a row')
    assert.match(strip.textContent ?? '', new RegExp(client.zh()['error.loadDir'].slice(0, 6)),
      `the row must name the browse failure, got: ${strip.textContent}`)
    assert.doesNotMatch(strip.textContent ?? '', new RegExp(client.zh()['error.loadDistros'].slice(0, 6)),
      'the distro failure is a different fact and must not be reported for a browse')
  } finally { await client.unmount() }
})

test('Escape closes an idle dialog and is ignored while a create is in flight', { timeout: 10_000 }, async () => {
  // A busy dialog must not be dismissible: the host call would still complete and create a
  // workspace the user has just walked away from.
  let release
  const pending = new Promise(resolve => { release = resolve })
  const client = mount(healthy({ check: () => pending }))
  try {
    await open(client)
    await client.escape()
    assert.ok(client.container.querySelector('.dww-card') === null, 'Escape closes an idle dialog')

    await client.click('.dww-action')
    await client.click('.dww-btn--primary')
    assert.equal(client.container.querySelector('.dww-btn--primary').disabled, true, 'the create is in flight')
    await client.escape()
    assert.ok(client.container.querySelector('.dww-card') !== null, 'Escape must not close a busy dialog')
    release({ ok: true, status: 200, json: async () => ({ ok: true, value: { exists: true, isDirectory: true } }) })
    await client.act(flush)
  } finally { await client.unmount() }
})

test('the help panel opens over the form and closing it restores the same message', { timeout: 10_000 }, async () => {
  // The panel replaces the body, so an error row is not on screen while it is open. What matters is
  // that the state survives the round trip: the user must not lose the reason by asking for help.
  const client = mount(healthy({ listDistros: 'refuse' }))
  try {
    await open(client)
    const before = client.container.querySelector('.dww-error')?.textContent ?? ''
    await client.click('.dww-help-btn')
    assert.ok(client.container.querySelector('.dww-error') === null, 'the panel replaces the body')
    assert.match(client.container.textContent ?? '', /0\.7\.8/, 'the panel names the build it is describing')
    await client.click('.dww-help-btn')
    assert.equal(client.container.querySelector('.dww-error')?.textContent ?? '', before,
      'closing the panel must return the same message, not a cleared one')
  } finally { await client.unmount() }
})

test('Retry re-runs the open pass instead of only clearing the message', { timeout: 10_000 }, async () => {
  // #44 §6 / #52: Retry used to be `setError(null)` — a button that looks like it re-checks and
  // re-checks nothing. The reading is the host call count, not the message.
  const scenario = healthy({ listDistros: 'refuse' })
  const client = mount(scenario)
  try {
    await open(client)
    assert.ok(client.container.querySelector('.dww-error') !== null, 'the first pass failed')
    const firstPass = client.calls.filter(name => name === 'listDistros').length
    scenario.listDistros = ['Ubuntu-24.04']
    await client.click('.dww-retry')
    const secondPass = client.calls.filter(name => name === 'listDistros').length
    assert.equal(secondPass, firstPass + 1, 'Retry must ask the host again')
    assert.ok(client.container.querySelector('.dww-error') === null,
      'the retried pass succeeded, so the row must be gone')
    assert.deepEqual(
      [...client.container.querySelectorAll('.dww-select option')].map(option => option.textContent),
      ['Ubuntu-24.04'],
      'and the values it fetched must be on screen',
    )
  } finally { await client.unmount() }
})

test('the rail form renders the control a collapsed sidebar actually shows', { timeout: 10_000 }, async () => {
  // #96 is why this case exists: the report was about the lone letter in the corner, and every case
  // above mounts the wide form — the rail had never been rendered by a test, so a change to what it
  // draws could not be noticed. The assertion is on the text the rail puts on screen and on the
  // accessible name that has to carry the sentence the letter cannot.
  const client = mount(healthy(), { wide: false })
  try {
    await client.render()
    const rail = client.container.querySelector('.dww-action--rail')
    assert.ok(rail !== null, 'the collapsed form must render the rail class')
    assert.equal((rail.textContent ?? '').trim(), 'W', `the rail draws the letter and nothing else, got: ${rail.textContent}`)
    assert.equal(rail.getAttribute('aria-label'), client.zh()['action.title'],
      'the letter is decorative, so the accessible name has to say what the button is')
    assert.ok(client.container.querySelector('.dww-card') === null, 'rendering the rail does not open the dialog')
    await client.click('.dww-action--rail')
    assert.ok(client.container.querySelector('.dww-card') !== null, 'and the rail control is the way in')
  } finally { await client.unmount() }
})

test('the preset answer is rendered by its text, whichever shape it arrives in', { timeout: 15_000 }, async () => {
  // The #99 class in one table instead of one case per report. `checkPreset` may hand back a sentence,
  // `undefined` (a healthy open, or a read from a replaced boot), `null` (a cleared state), or an empty
  // string from a path that has no reason to give. Only a sentence may draw a strip; and a strip that
  // draws must carry it. This is the row that makes "node exists" impossible to pass on.
  const cases = [
    { value: undefined, draws: false, label: 'undefined (a healthy open)' },
    { value: null, draws: false, label: 'null (a cleared state)' },
    { value: '', draws: false, label: "'' (a message with no text)" },
    { value: 'wsl-code: Cannot find module js-yaml', draws: true, label: 'a sentence' },
  ]
  for (const testCase of cases) {
    const client = mount(healthy())
    try {
      client.face.checkPreset = async () => testCase.value
      await open(client)
      const strip = client.container.querySelector('.dww-error')
      if (!testCase.draws) {
        assert.ok(strip === null, `${testCase.label} must draw no row, got: ${strip?.outerHTML ?? ''}`)
        continue
      }
      assert.ok(strip !== null, `${testCase.label} must draw a row`)
      assert.match(strip.textContent ?? '', /wsl-code/, `${testCase.label}: the row carries its own text`)
      assert.notEqual((strip.textContent ?? '').trim(), '', `${testCase.label}: a drawn row is never empty`)
    } finally { await client.unmount() }
  }
})

test('no reachable state draws an error row around nothing', { timeout: 20_000 }, async () => {
  // The sweep across the states this gate can already build, in both forms. Per-state cases assert what
  // a failure says; this one asserts the property that every state shares, so the next state added to
  // the list inherits it instead of needing its own empty-row test.
  const scenarios = {
    'healthy install': healthy(),
    'a refused distro list': healthy({ listDistros: 'refuse' }),
    'a partial generation': healthy({
      variantStatus: {
        state: 'partial', produced: 5, sources: 6, generation: 3, at: 1, truncated: 0,
        failed: [{ id: 'wsl-code', source: 'modes/code/agent-preset.yaml', reason: 'boom' }],
      },
      presets: 'none',
    }),
  }
  for (const [label, scenario] of Object.entries(scenarios)) {
    for (const wide of [true, false]) {
      const client = mount(scenario, { wide })
      try {
        await open(client)
        const strips = [...client.container.querySelectorAll('.dww-error')]
        for (const strip of strips) {
          assert.notEqual((strip.textContent ?? '').trim(), '',
            `${label} in the ${wide ? 'wide' : 'rail'} form drew an empty row: ${strip.outerHTML}`)
        }
        if (label === 'a partial generation') {
          assert.ok(strips.length >= 1, `${label}: the failure state must draw its row in both forms`)
        }
      } finally { await client.unmount() }
    }
  }
})

test.after(() => { dom.window.close() })

/**
 * The host's own workspace UI carries the entry too (#96 is why this file exists; these two cases
 * are why the answer is not "a button at the foot").
 *
 * The shell gives a client plugin one seat — `sidebar.footer.action` — and the Workspaces section
 * header and the picker menu are host-private markup. These cases draw that markup around the
 * mounted root and assert the entry joins it: the shipped control's class list (so the box is the
 * shipped box), the shipped row's icon and classes, and the same dialog behind both.
 */

/** The host markup the header entry discovers: a section header with an action strip and the add control. */
function hostHeader() {
  const region = document.createElement('div')
  region.className = 'host_region'
  region.innerHTML = '<div class="host_sectionHeader"><div class="host_headerActions">'
    + '<button type="button" class="host_icon" aria-label="search"></button>'
    + '<button type="button" class="host_icon" aria-label="add workspace"></button>'
    + '</div></div>'
  document.body.appendChild(region)
  return region
}

test('the entry joins the section header beside the shipped add control', { timeout: 10_000 }, async () => {
  const client = mount(healthy())
  const region = hostHeader()
  try {
    await client.render()
    // The seat is discovered from the footer element upwards, so the host region has to be an
    // ancestor of the mounted root — in the shell it is the sidebar the slot sits in.
    await client.act(async () => { region.appendChild(client.container) })
    await client.act(flush)
    const entry = region.querySelector('.dww-header-entry')
    assert.ok(entry !== null, `the header carries no entry: ${region.innerHTML.slice(0, 300)}`)
    assert.equal(entry.className, 'host_icon dww-header-entry',
      'the shipped control`s own class list is what makes the box the shipped box')
    assert.equal(entry.getAttribute('data-tooltip'), client.zh()['action.entry'],
      'the hover label is the entry`s own sentence, drawn by the shell`s tooltip primitive')
    assert.equal(entry.title, '', 'the entry must not fall back to the browser`s native title bubble')
    assert.equal(entry.closest('[class*="_headerActions"]')?.lastElementChild?.contains(entry), true,
      'the entry sits inside the action strip, not beside it')
    assert.equal(client.container.querySelector('.dww-action').hidden, true,
      'the footer row steps aside while the header carries the entry')
    await client.act(async () => { entry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await client.act(flush)
    assert.ok(client.container.querySelector('.dww-card') !== null, 'the header entry opens the same dialog')
    await client.escape()
    assert.ok(region.querySelector('.dww-header-entry') !== null,
      'the header entry returns after the dialog closes, without a page reload')
  } finally {
    region.remove()
    await client.unmount()
  }
})

test('the workspace picker menu carries the WSL row under the shipped one', { timeout: 10_000 }, async () => {
  const client = mount(healthy())
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.innerHTML = '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item" aria-keyshortcuts="Alt+N">'
    + '<span class="host_itemLabel">添加工作区…</span><span class="host_itemHint">Ctrl+N</span></button></div>'
  document.body.appendChild(menu)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(flush)
    const entry = menu.querySelector('[data-dww-menu-entry]')
    assert.ok(entry !== null, `the menu carries no entry: ${menu.innerHTML.slice(0, 300)}`)
    assert.equal(entry.previousElementSibling, menu.querySelector('.host_itemWrap'),
      'the entry is the row directly under the shipped one')
    assert.equal(entry.querySelector('.host_itemLabel')?.textContent, client.zh()['action.entry'],
      'the label is the only thing the clone changes')
    assert.equal(entry.querySelector('svg, .host_item') !== null, true, 'the shipped icon and classes come with the row')
    await client.act(async () => {
      entry.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await client.act(flush)
    assert.ok(client.container.querySelector('.dww-card') !== null, 'the menu row opens the same dialog')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

test('the mode picker lists one family, whichever workspace the session belongs to', { timeout: 10_000 }, async () => {
  const client = mount(healthy())
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const row = (label, selected) => '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + `<span class="host_itemName">${label}</span>${selected ? '<span class="host_check"></span>' : ''}</button></div>`
  menu.innerHTML = row('标准模式', true) + row('WSL · 标准模式', false) + row('PTC 模式', false) + row('WSL · PTC 模式', false)
  document.body.appendChild(menu)
  const visible = () => [...menu.querySelectorAll('.host_itemWrap')]
    .filter(wrap => wrap.style.display !== 'none')
    .map(wrap => wrap.querySelector('.host_itemName').textContent)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(flush)
    assert.deepEqual(visible(), ['标准模式', 'PTC 模式'], 'a shipped-mode session lists the shipped modes')
    assert.equal(menu.querySelector('.host_item[disabled]')?.closest('.host_itemWrap').style.display, 'none',
      'a hidden row also leaves the keyboard order')

    // The same menu, one selection later: the checked row is now a WSL variant.
    await client.act(async () => {
      const rows = [...menu.querySelectorAll('.host_itemWrap')]
      rows[0].querySelector('.host_check').remove()
      const check = document.createElement('span')
      check.className = 'host_check'
      rows[1].querySelector('button').appendChild(check)
    })
    await client.act(flush)
    assert.deepEqual(visible(), ['WSL · 标准模式', 'WSL · PTC 模式'], 'a WSL session lists the WSL variants')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

test('a WSL session whose family has no other variant in the menu is not left with a one-row mode picker', { timeout: 10_000 }, async () => {
  // Issue #129's second exit. The trim matches on the row's *display name*, which
  // is the host's, not ours: a checked WSL row with no other WSL row beside it
  // would trim to a menu containing only the mode already selected — a picker the
  // user cannot choose from at all.
  const client = mount(healthy({ presets: 'none' }))
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const row = (label, selected) => '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + `<span class="host_itemName">${label}</span>${selected ? '<span class="host_check"></span>' : ''}</button></div>`
  menu.innerHTML = row('WSL · 标准模式', true) + row('标准模式', false) + row('PTC 模式', false)
  document.body.appendChild(menu)
  const visible = () => [...menu.querySelectorAll('.host_itemWrap')]
    .filter(wrap => wrap.style.display !== 'none')
    .map(wrap => wrap.querySelector('.host_itemName').textContent)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(flush)
    assert.deepEqual(visible().slice().sort(), ['PTC 模式', 'WSL · 标准模式', '标准模式'],
      'a menu with no second WSL row stays untrimmed rather than collapsing to the selected row')
    assert.equal([...menu.querySelectorAll('button')].every(button => !button.disabled), true,
      'and no row is left disabled, so one is always selectable')
    // Past PRESET_SETTLE_MS: the released flag is what makes the menu visible.
    await client.act(() => new Promise(resolve => setTimeout(resolve, 100)))
    assert.equal(menu.getAttribute('data-dww-presets-ready'), '', 'the released menu is visible')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

test('a healthy WSL roster still trims the menu to its own family', { timeout: 10_000 }, async () => {
  // The pair of the row above, and the boundary of this fix: with a real variant
  // family present the menu still lists only WSL modes — which is the documented
  // design. The way back to a plain workspace is `removeWorkspace`, not a row here.
  const client = mount(healthy())
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const row = (label, selected) => '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + `<span class="host_itemName">${label}</span>${selected ? '<span class="host_check"></span>' : ''}</button></div>`
  menu.innerHTML = row('标准模式', false)
    + row('WSL · 标准模式', true) + row('WSL · PTC 模式', false) + row('WSL · 精简模式', false)
  document.body.appendChild(menu)
  const visible = () => [...menu.querySelectorAll('.host_itemWrap')]
    .filter(wrap => wrap.style.display !== 'none')
    .map(wrap => wrap.querySelector('.host_itemName').textContent)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(flush)
    assert.deepEqual(visible(), ['WSL · 标准模式', 'WSL · PTC 模式', 'WSL · 精简模式'],
      'a WSL session with a variant family lists that family (the documented design)')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

test('a menu that only resembles the preset picker is not left hidden', { timeout: 10_000 }, async () => {
  const client = mount(healthy())
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.innerHTML = '<button type="button" role="menuitem"><span class="host_itemName"></span></button>'
  document.body.appendChild(menu)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(() => new Promise(resolve => setTimeout(resolve, 100)))
    assert.equal(menu.getAttribute('data-dww-presets-ready'), '',
      'an unrecognized menu must release the temporary hidden state')
    assert.equal(menu.querySelector('button')?.parentElement, menu,
      'releasing the menu must not move or filter its contents')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

// ---------------------------------------------------------------------------
// Issue #129's two exits: one conversation out of the WSL world, and one
// workspace's registration out. Both are rendered here rather than called,
// because the defect was never a missing method — it was a surface with no way
// back, and a refusal no one could see.
// ---------------------------------------------------------------------------

const SESSION_MENU_SEAT = 'sidebar.workspaces.session.menu.item'
const OVERLAY_SEAT = 'shell.overlay'
/** One blank session in a UNC workspace, already composed onto the WSL variant. */
const WSL_UNC = '\\\\wsl.localhost\\Ubuntu\\home\\ruler'

/** The host's session menu, carrying the shipped row this plugin borrows geometry from. */
function sessionMenuDom() {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.innerHTML = '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + '<span class="host_itemName">复制 Session ID</span></button></div>'
  document.body.appendChild(menu)
  return menu
}

/** The host's project rows and its workspace menu, as detached nodes. */
function workspaceMenuDom() {
  const rowOf = (workspaceId) => {
    const element = document.createElement('div')
    element.className = 'host_projectRow'
    element.setAttribute('data-row-key', `workspace:${workspaceId}`)
    element.innerHTML = '<span class="host_title">issue129</span>'
    return element
  }
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.innerHTML = '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + '<span class="host_itemName">重命名</span></button></div>'
    + '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item host_danger">'
    + '<svg viewBox="0 0 16 16"></svg><span class="host_itemName">删除工作区</span></button></div>'
  return { w1: rowOf('w1'), w2: rowOf('w2'), menu }
}

/**
 * Mount the overlay seat, which is also the only thing that can take a notice
 * down — notices are module state and outlive one test's root.
 * @param client - a mounted client.
 * @returns the live seat, with nothing on screen.
 */
async function openNoticeSeat(client) {
  const seat = await client.renderSeat(OVERLAY_SEAT, {})
  if (seat.container.querySelector('.dww-notice-close') !== null) await seat.click('.dww-notice-close')
  return seat
}

test('the session menu gives one conversation its own way out of the WSL world', { timeout: 10_000 }, async () => {
  const listState = { ids: ['s1'], byId: { s1: { blank: true, cwd: WSL_UNC, projectionValues: { agentPreset: 'wsl-standard' } } } }
  const client = mount(healthy({ listState }))
  const menu = sessionMenuDom()
  let closed = false
  const useMenuOpenState = () => [true, (open) => { closed = !open }]
  let seat = null
  let notice = null
  try {
    await client.render()
    notice = await openNoticeSeat(client)
    assert.ok(notice.container.querySelector('.dww-notice') === null, 'no receipt before anything happens')
    seat = await client.renderSeat(SESSION_MENU_SEAT, { sessionId: 's1', displayTitle: 'issue129', useMenuOpenState }, menu)
    const row = seat.container.querySelector('[data-dww-session-exit]')
    assert.ok(row !== null, `the seat contributed no row: ${menu.innerHTML.slice(0, 300)}`)
    assert.equal(row.textContent.trim(), client.zh()['exit.session'], 'the row names the exit')
    assert.equal(row.className, 'host_item', 'the row borrows the shipped row geometry instead of a lookalike')
    assert.equal(row.querySelector('span')?.className, 'host_itemName', 'and the shipped label span')

    await seat.click('[data-dww-session-exit]')
    assert.deepEqual(client.selectCalls.filter(call => call.sessionId === 's1'),
      [{ sessionId: 's1', agentPreset: 'standard' }], 'the session is composed back onto the plain mode')
    assert.equal(closed, true, 'the menu comes down once the host accepted')
    assert.equal(notice.container.querySelector('.dww-notice')?.dataset.level, 'info', 'the receipt is on screen')
    assert.match(notice.container.textContent, /该会话已退出 WSL 模式/)

    // Redrawn for the next open, the row offers the way back in — the state is
    // the session's, not the menu's.
    seat.dispose()
    seat = await client.renderSeat(SESSION_MENU_SEAT, { sessionId: 's1', displayTitle: 'issue129', useMenuOpenState }, menu)
    assert.equal(seat.container.querySelector('[data-dww-session-exit]')?.textContent.trim(),
      client.zh()['exit.session.rejoin'], 'and it can be undone from the same place')

    // The regression lock for the late-input trap: the roster and the workspace
    // registry land after the first pass, and a binder that re-scans must not
    // recompose a session the user just took out.
    const before = client.selectCalls.length
    client.notifyList()
    await client.act(flush)
    assert.equal(client.selectCalls.length, before, 'the binder left the opted-out session alone')
  } finally {
    seat?.dispose()
    notice?.dispose()
    menu.remove()
    await client.unmount()
  }
})

test('a refused session exit says why, in the host’s own words, and does not pretend', { timeout: 10_000 }, async () => {
  // The host locks a preset once a session has produced output. Swallowing that
  // refusal is how #129 read as "nothing happened".
  const listState = { ids: ['s1'], byId: { s1: { blank: true, cwd: WSL_UNC, projectionValues: { agentPreset: 'wsl-standard' } } } }
  const client = mount(healthy({ listState, selectRefuses: true }))
  const menu = sessionMenuDom()
  let closed = false
  const useMenuOpenState = () => [true, (open) => { closed = !open }]
  let seat = null
  let notice = null
  try {
    await client.render()
    notice = await openNoticeSeat(client)
    seat = await client.renderSeat(SESSION_MENU_SEAT, { sessionId: 's1', displayTitle: 'issue129', useMenuOpenState }, menu)
    await seat.click('[data-dww-session-exit]')
    const row = seat.container.querySelector('[data-dww-session-exit]')
    assert.match(row.textContent, /agent-preset-locked/, 'the host\'s own reason is on the row')
    assert.equal(closed, false, 'the menu stays open so the refusal is not missed')
    assert.equal(row.dataset.dwwSessionExit, 'exit', 'the session is still in the WSL world: the opt-out was rolled back')
    assert.equal(notice.container.querySelector('.dww-notice')?.dataset.level, 'error')
    assert.match(notice.container.textContent, /更改 WSL 模式失败/)
  } finally {
    seat?.dispose()
    notice?.dispose()
    menu.remove()
    await client.unmount()
  }
})

test('a session the WSL world does not reach is offered no exit row', { timeout: 10_000 }, async () => {
  // The pair of the row above: the seat renders for every session, so a plain
  // workspace's row must draw nothing rather than a control that cannot work.
  const listState = { ids: ['s9'], byId: { s9: { blank: true, cwd: 'C:\\Users\\ruler\\proj', projectionValues: { agentPreset: 'standard' } } } }
  const client = mount(healthy({ listState }))
  const menu = sessionMenuDom()
  let seat = null
  try {
    await client.render()
    seat = await client.renderSeat(SESSION_MENU_SEAT, {
      sessionId: 's9', displayTitle: 'plain', useMenuOpenState: () => [true, () => {}],
    }, menu)
    assert.equal(seat.container.querySelector('[data-dww-session-exit]'), null,
      `a plain session was offered a WSL exit: ${seat.container.innerHTML}`)
  } finally {
    seat?.dispose()
    menu.remove()
    await client.unmount()
  }
})

test('the workspace menu clears the registration of a WSL workspace, and only that one', { timeout: 10_000 }, async () => {
  const workspaces = {
    create: async () => ({ workspaceId: 'w1' }),
    startSession: () => {},
    list: {
      getSnapshot: () => ({
        items: [
          { workspaceId: 'w1', path: 'D:\\temp\\issue129' },
          { workspaceId: 'w2', path: 'C:\\Users\\ruler\\proj' },
        ],
      }),
    },
  }
  const client = mount(healthy({
    listWorkspaceRecords: [{ path: 'd:\\temp\\issue129', distro: 'Ubuntu', username: 'ruler' }],
    removeWorkspace: { removed: 'd:\\temp\\issue129' },
    workspaces,
  }))
  const { w1, w2, menu } = workspaceMenuDom()
  let notice = null
  try {
    await client.render()
    notice = await openNoticeSeat(client)
    await client.act(async () => {
      document.body.append(w1, w2, menu)
      w1.classList.add('host_menuOpen')
    })
    await client.act(flush)
    const exit = menu.querySelector('[data-dww-ws-exit]')
    assert.ok(exit !== null, `the workspace menu carries no exit: ${menu.innerHTML.slice(0, 400)}`)
    assert.equal(exit.getAttribute('data-dww-ws-exit'), 'D:\\temp\\issue129',
      'the row targets the host path of the workspace whose menu is open')
    assert.equal(exit.textContent.trim(), client.zh()['exit.workspace'])
    assert.equal(exit.previousElementSibling?.querySelector('.host_itemName')?.textContent, '删除工作区',
      'and it sits directly under the shipped delete row')
    assert.equal(exit.querySelector('svg'), null, 'the cloned trash icon does not come with the row')

    await client.act(async () => { exit.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await client.act(flush)
    assert.ok(client.calls.includes('removeWorkspace'), 'the click clears the registration through the host route')
    assert.match(notice.container.textContent, /已退出 WSL 工作区/, 'with a receipt naming the path')
    assert.match(notice.container.textContent, /D:\\temp\\issue129/, 'the receipt carries the registration it removed')

    // The negative, on the same fixture: the menu re-opens on the *other*
    // workspace, which has no registration to clear. Closing and re-opening the
    // menu is the tree mutation the mirror keys on, the same one the host's
    // portal makes when a user right-clicks a different row.
    await client.act(async () => {
      w1.classList.remove('host_menuOpen')
      w2.classList.add('host_menuOpen')
      menu.remove()
      document.body.append(menu)
    })
    await client.act(flush)
    assert.equal(menu.querySelector('[data-dww-ws-exit]'), null,
      'a workspace that is not a WSL one is offered no exit')
  } finally {
    notice?.dispose()
    w1.remove()
    w2.remove()
    menu.remove()
    await client.unmount()
  }
})

test('the mode picker is the blank session’s exit: it lists every mode it can still accept', { timeout: 10_000 }, async () => {
  // Measured on a real host: a blank session row carries NO action strip (`!row.blank`
  // in the host's own rows), so the session menu above is unreachable for the one
  // session that is allowed to change. Trimming that session's mode menu to the WSL
  // family would therefore leave no way out at all.
  const listState = {
    ids: ['s1'],
    byId: { s1: { blank: true, cwd: WSL_UNC, retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'wsl-standard' } } },
  }
  const client = mount(healthy({ listState }))
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const row = (label, selected) => '<div class="host_itemWrap"><button type="button" role="menuitem" class="host_item">'
    + `<span class="host_itemName">${label}</span>${selected ? '<span class="host_check"></span>' : ''}</button></div>`
  menu.innerHTML = row('标准模式', false)
    + row('WSL · 标准模式', true) + row('WSL · PTC 模式', false) + row('WSL · 精简模式', false)
  document.body.appendChild(menu)
  const visible = () => [...menu.querySelectorAll('.host_itemWrap')]
    .filter(wrap => wrap.style.display !== 'none')
    .map(wrap => wrap.querySelector('.host_itemName').textContent)
  try {
    await client.render()
    await client.act(async () => { document.body.appendChild(menu) })
    await client.act(() => new Promise(resolve => setTimeout(resolve, 100)))
    assert.deepEqual(visible(), ['标准模式', 'WSL · 标准模式', 'WSL · PTC 模式', 'WSL · 精简模式'],
      'a blank session is offered the plain modes too')
    assert.equal(menu.getAttribute('data-dww-presets-ready'), '', 'and the menu is released, not left hidden')
    assert.equal([...menu.querySelectorAll('button')].every(b => !b.disabled), true, 'no row is left unusable')
  } finally {
    menu.remove()
    await client.unmount()
  }
})

test('a blank session the user moved off a WSL variant is not bound back', { timeout: 10_000 }, async () => {
  // The other half: picking 标准模式 in the picker above only stays picked if the
  // binder reads it as a choice. Without the diff it recomposes the session on the
  // next store change, which is what made the picker look broken.
  const listState = {
    ids: ['s1'],
    byId: { s1: { blank: true, cwd: WSL_UNC, retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'wsl-standard' } } },
  }
  const client = mount(healthy({ listState }))
  try {
    await client.render()
    await client.act(flush)
    assert.equal(client.selectCalls.length, 0, 'nothing to bind: it is already a WSL variant')
    // The user picks a plain mode in the picker; the host writes the projection.
    listState.byId.s1.projectionValues = { agentPreset: 'standard' }
    client.notifyList()
    await client.act(flush)
    client.notifyList()
    await client.act(flush)
    assert.deepEqual(client.selectCalls.filter(call => call.sessionId === 's1'), [],
      `the binder recomposed the mode the user just chose: ${JSON.stringify(client.selectCalls)}`)
  } finally {
    await client.unmount()
  }
})

test('creating a WSL workspace leaves a light receipt telling the user both ways out', { timeout: 10_000 }, async () => {  const client = mount(healthy())
  let notice = null
  try {
    await client.render()
    notice = await openNoticeSeat(client)
    assert.equal(notice.container.querySelector('.dww-notice'), null, 'nothing on screen before the create')
    const failure = await client.face.createWorkspace('/mnt/d/temp/issue129', 'ruler', 'Ubuntu')
    await client.act(flush)
    assert.equal(failure, undefined, 'the create itself succeeded')
    const card = notice.container.querySelector('.dww-notice')
    assert.ok(card !== null, 'the create left no receipt')
    assert.equal(card.dataset.level, 'info')
    assert.match(card.textContent, /已登记为 WSL 工作区/)
    assert.match(card.textContent, /退出 WSL 工作区/, 'the receipt names the workspace exit')
    assert.match(card.textContent, /模式选择器/, 'and points the single-session exit at the picker, which a blank session actually has')
    assert.doesNotMatch(card.textContent, /会话的菜单/, 'the session menu is NOT offered: a blank session has none')
    await notice.click('.dww-notice-close')
    assert.equal(notice.container.querySelector('.dww-notice'), null, 'the user can take it down')
  } finally {
    notice?.dispose()
    await client.unmount()
  }
})

