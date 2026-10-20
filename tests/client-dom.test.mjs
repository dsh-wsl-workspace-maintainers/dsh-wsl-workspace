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
const { createRoot } = require('react-dom/client')
const jsxRuntime = require('react/jsx-runtime')
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
function mount(scenario) {
  const calls = []
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
  const services = {
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
    workspaces: { create: async () => ({ workspaceId: 'w1' }), startSession: () => {} },
    'remote.agentPresets': {
      list: async () => ({
        ok: true,
        value: {
          presets: scenario.presets === 'none'
            ? [{ id: 'standard', isDefault: true }]
            : [{ id: 'standard', isDefault: true }, { id: 'wsl-standard' }, { id: 'wsl-code' }],
        },
      }),
      select: async () => ({ ok: true }),
    },
    uiWorkspace: { startSession: () => {} },
  }
  const ctx = {
    get: key => services[key],
    effect: fn => { fn(); return () => {} },
    inject: (deps, callback) => { if (deps.every(dep => services[dep] !== undefined)) callback(ctx) },
    locale: {
      register: (_namespace, dictionary) => { dictionaries = dictionary; return () => {} },
      bind: () => key => dictionaries.zh?.[key] ?? key,
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (config, Component) => { face = config.inject(); component = Component; return () => {} },
    },
  }

  let plugin
  dom.window.__ModuleLoader__ = { load: mod => { plugin = mod.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
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
      throw new Error(`unexpected require(${specifier})`)
    })
    plugin.apply(ctx)
  } finally {
    dom.window.setInterval = setInterval
  }

  // A fresh container per mount. Two roots must never share one (React refuses it), and tearing a
  // root down while a host answer is still in flight is a React-internals race this file does not
  // need to depend on — the process exits with the window, so the roots go with it.
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
    async render() {
      await act(async () => { root.render(React.createElement(component, { wide: true, ...face })) })
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
    unmount() { /* nothing to tear down: see the container comment above */ },
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
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
  } finally { client.unmount() }
})

test.after(() => { dom.window.close() })
