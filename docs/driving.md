# Driving this plugin from another agent (five questions)

This file ships inside the package (it is listed in `package.json#files`) because the
facts below are the ones a fresh agent cannot invent: how to start a harness, how to
log in, how to call this plugin, how to put text into the composer, and how to move a
session off a broken provider. Everything here was measured against a packaged
0.2.1-rc.2 desktop runtime on Windows; anything unmeasured is marked as such.

`POST` the plugin's route, or call its `describe` method first — `describe` now returns
the machine-readable form of this page: `route`, `loopbackOnly`, `methods`,
`installProof`, `driving`.

## 1. Start a harness headlessly

The start line below uses the **packaged Electron executable in Node mode** — the same
entry the desktop shell uses. A plain `dsh` CLI, if your machine has one, takes the same
`web` arguments.

```powershell
# 1) a scratch home, never the real profile
$env:DSH_HOME = 'D:\scratch\dsh-home'
# 2) THE ONE VARIABLE THAT MUST BE UNSET
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

& "<install>\DeepSeek Harness.exe" --expose-internals `
  "<install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  web --no-open --host 127.0.0.1 --port 3981
```

**Why the unset matters, and how to tell you are in the broken mode:** when
`ELECTRON_RUN_AS_NODE=1` is inherited (agent shells often have it, injected by the host
app), that same executable **runs as Node**. A bare launch then exits with code **0**,
prints **nothing**, and leaves **zero processes** — which reads exactly like "another
instance holds the lock" or "nothing is wrong, it just quit". The tell is:

```
"<install>\DeepSeek Harness.exe" -v      # prints a node version (e.g. v24.21.0) ⇒ you are talking to Node
```

`--enable-logging` in that mode fails with `bad option: --enable-logging` (Node's argv
parser). Full symptom table and the single-variable measurement: `PITFALLS.md #109` in
the plugin workspace this package came from.

Both a `web` (HTTP only) and a `headless` (no HTTP, one task) profile exist. This plugin
needs `web`: its route is registered on the host's HTTP server.

**Where to launch from:** any directory. Every path in the line above is absolute, so the
working directory does not matter — what matters is that the process starts **outside**
the profile (never `cd` into `profiles\web`, and never point `DSH_HOME` at the real one).

**What "a fresh machine" needs first:** this plugin runs *inside* an installed harness —
the tarball alone is a plugin, not a runtime. `<install>` is the folder that contains
`DeepSeek Harness.exe` (the packaged runtime lives under its `resources\`), or a machine
where a `dsh` CLI is on `PATH`, in which case the same `web --no-open --host … --port …`
arguments apply to it.

## 2. Log in: the printed URL and its token (measured: not consumed while that process lives)

The CLI prints exactly one line on stdout:

```
dsh web: http://127.0.0.1:3981/?token=<token>
```

Open it in a browser **once**. The `?token=` is exchanged for a signed cookie: the
response is **303** with `set-cookie: dsh-auth-…` (and `location: ./`), and the page
continues as an authenticated session.

**Measured: the token is not consumed.** For the lifetime of that process, every `GET`
of the same URL — with no cookie, with a stale one, even with a junk one — answers the
same **303 + the same `dsh-auth-…` cookie**; only a *wrong* token gets **401** with
`dsh web authentication required; reopen the URL printed by dsh web`. Treat it as a
**secret for that process**, not a one-time code: do not log it, and **restart the
instance to invalidate it** (a new process prints a new token). Without a token and
without the cookie, the page is that same 401.

The plugin's own route does **not** need that cookie — it is loopback-only instead
(§3). The cookie is what the **UI** needs, including the composer in §4.

## 3. This plugin's HTTP surface

| | |
|---|---|
| method | `POST` (anything else → `405 method not allowed`) |
| path | `/wsl-workspace/api` by default; the profile can override it (`Config.route`) — read the real one from `describe` |
| body | `{ "method": "<name>", "params": { … } }` (`params` must be an object → else `400`) |
| response | `{ "ok": true, "value": … }` or `{ "ok": false, "error": "…" }` (validation errors come back as `200` with `ok:false`) |
| auth | none — **loopback only**: a non-loopback socket address or `Host` header gets `403 {"error":"loopback-only"}` |

Discover the methods **at runtime**, never from a list copied into your own code:

```bash
curl -s -X POST http://127.0.0.1:3981/wsl-workspace/api \
  -H 'content-type: application/json' -d '{"method":"describe"}'
```

`describe` returns `{ version, releases, route, loopbackOnly, methods, installProof, driving }`.
`methods` is the authoritative table (`name`, `mutates`, `params`, `returns`); it is
generated from the same constant the dispatcher reads, and a gate fails the build if the
two disagree. The ten methods are:

`listDistros`, `listDir`, `check`, `registerWindows`, `listWorkspaces`, `removeWorkspace`,
`listWorkspaceRecords`, `setUser`, `variantStatus`, `describe`.

Examples (read-only first):

```bash
curl -s -X POST http://127.0.0.1:3981/wsl-workspace/api -H 'content-type: application/json' \
  -d '{"method":"check","params":{"distro":"Ubuntu","path":"/home"}}'
# {"ok":true,"value":{"exists":true,"isDirectory":true}}
```

**Which bytes are installed?** The version string cannot answer that — a `file:` install
is a copy and goes stale silently. `describe.installProof` names a literal marker that
exists only in builds carrying this table:

```powershell
Select-String -Path "<profile>\node_modules\dsh-wsl-workspace\lib\index.js" -Pattern "wsl-workspace:methods-v1"
```

A non-zero count means the loaded copy is at least the build that ships this file.

## 4. Put text into the composer and send it (built-in browser / any page)

The composer is **Lexical** (`data-lexical-editor="true"`) and lives in a page that may
be hidden with a 0×0 viewport — that combination rules out two obvious approaches and
leaves one:

- `document.execCommand('insertText', …)` returns **false** and the text stays empty.
- Dispatching `input` **as well as** `beforeinput` inserts the text **twice**.

Do this instead (in-page JS; `evaluate_script` in a built-in browser works):

```js
const ed = document.querySelector('[contenteditable][data-lexical-editor]');
if (!ed || ed.getAttribute('contenteditable') !== 'true') throw new Error('composer disabled: select a workspace first');
ed.focus();
const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
const s = getSelection(); s.removeAllRanges(); s.addRange(r);
ed.dispatchEvent(new InputEvent('beforeinput', {
  inputType: 'insertText', data: '只回一个字：好', bubbles: true, cancelable: true, composed: true,
}));
// then
[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '发送消息').click();
```

Prerequisites, in order: dismiss the first-run dialogs (`预览版说明` → `继续`, then
`开始使用` → `关闭`), and **select a workspace** — until then the composer is
`contenteditable="false"`, and the injection silently has nowhere to go. A workspace can
be created without the UI through the host's same-origin RPC:

```js
await fetch('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create',
    payload: { args: { request: { path: 'D:/Temp/scratch-ws' } } } }) });
```

Measured end to end: injecting and clicking send produced a real reply ("好", 16 s,
9.4K tok) on a sensenova-backed instance.

## 5. Move the session off a provider that answers 401

A fresh isolated home falls back to `deepseek-official`, whose key is usually absent, and
**every turn ends with `MISSING_CREDENTIAL` / 401** while nothing else looks wrong.

Provider and default model are **profile configuration**, not plugin configuration:

`<DSH_HOME>/profiles/web/cordis.patch.yml`

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      sensenova:                      # any name; referenced below
        api: openai-completions
        baseURL: https://token.sensenova.cn/v1
        apiKeyEnv: SENSENOVA_TOKEN_PLAN_API_KEY   # the NAME, never the value
        models:
          - id: deepseek-v4-flash
            contextWindow: 131072
            maxTokens: 8192
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: sensenova
    model: deepseek-v4-flash
```

- **Keep the key off disk**: export the variable named by `apiKeyEnv` **in the launching
  environment**; the patch carries only the name.
- **Only new sessions pick it up.** A session created before the patch keeps the model it
  recorded; create a new one (or use the host's model picker) after editing the patch.
- The same shape works on a desktop profile (`<home>/profiles/desktop/cordis.patch.yml`);
  the model must be one the provider's `models` list declares.

## What this plugin deliberately does not do

It answers loopback-only data calls and registers preset variants. It does not start,
stop or restart the harness, does not write outside its own credential store
(`~/.dsh/wsl-workspaces.json`), and does not manage providers — §5 is host configuration.
