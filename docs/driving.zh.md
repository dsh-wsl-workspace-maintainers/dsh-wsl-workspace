# 从别的 agent 驱动这枚插件（五问）

这份文件**随包发布**（列在 `package.json#files` 里），因为下面这些事实是一个"新电脑 + 新 agent"
无法自己猜出来的：怎么起宿主、怎么登录、怎么调本插件、怎么把文字送进 composer、以及默认 provider
报 auth 错时改哪一处。所有读数都在 Windows + 打包版 0.2.1-rc.2 运行时上量过；**没量过的会明写"未证"**。

先调一次本插件的 `describe`——它现在返回这页的机器可读形态：`route`／`loopbackOnly`／`methods`／
`installProof`／`driving`。

## 1. 无头起一枚宿主

下面用的是**打包版 Electron 可执行文件的 Node 模式**——桌面壳自己用的就是这条入口。机器上若有独立
`dsh` CLI，参数相同。

```powershell
# 1) 临时 home，绝不指向真实 profile
$env:DSH_HOME = 'D:\scratch\dsh-home'
# 2) 必须删掉的那一枚变量
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

& "<安装目录>\DeepSeek Harness.exe" --expose-internals `
  "<安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  web --no-open --host 127.0.0.1 --port 3981
```

**为什么必须删、以及怎么认出自己在坏模式里**：agent 的 shell 里常被宿主 App 注入了
`ELECTRON_RUN_AS_NODE=1`。带着它启动，同一个 exe **会以 Node 身份运行**——裸启动 **退出码 0、
零输出、零进程**，看起来就像"锁被别人占了"或"没问题、只是自己退了"。判别一发：

```
"<安装目录>\DeepSeek Harness.exe" -v      # 打出 node 版本（如 v24.21.0）⇒ 你在跟 Node 说话
```

那个模式下 `--enable-logging` 会报 `bad option: --enable-logging`（Node 的 argv 解析）。症状表与
单变量读数在插件工作区 `PITFALLS.md #109`。

`web`（只起 HTTP）与 `headless`（不开 HTTP、跑一个任务）是两档；本插件要 **`web`**——它的路由注册在
宿主的 HTTP server 上。

**从哪启动**：任意目录。上面那行里的路径全是绝对路径，工作目录不影响什么；要紧的是进程起在 profile
**外面**（不要 `cd` 进 `profiles\web`，也不要把 `DSH_HOME` 指到真实那一棵）。

**"全新机器"先要什么**：本插件跑在**已装好的宿主里面**——tarball 只是一枚插件，不是运行时。`<安装目录>`
指含 `DeepSeek Harness.exe` 的那一层（打包运行时在它的 `resources\` 下）；或者机器上 `dsh` CLI 在 `PATH`
里，参数同样是 `web --no-open --host … --port …`。

## 2. 登录：打印出来的 URL 与它的 token（实测：进程存活期间不会被用掉）

CLI 会在 stdout 打**恰好一行**：

```
dsh web: http://127.0.0.1:3981/?token=<token>
```

在浏览器里**打开一次**：那个 `?token=` 会被换成签名 cookie——响应是 **303** ＋
`set-cookie: dsh-auth-…`（`location: ./`），页面随后以已认证会话继续。

**实测：这个 token 不会"用掉"。** 在那一枚进程存活期间，同一个 URL 怎么 GET 都是**同一个 303 ＋同一枚
`dsh-auth-…` cookie**（不带 cookie、带过期 cookie、带垃圾 cookie 都一样）；只有**错的** token 才回 **401**
＋ `dsh web authentication required; reopen the URL printed by dsh web`。因此把它当**该进程的密钥**而不是一次性
验证码：不要记日志，**要作废就重启实例**（新进程打印新 token）。不带 token 也不带 cookie，就是同一个 401。

本插件自己的路由**不需要**这枚 cookie——它靠"仅环回"（§3）。cookie 是**UI**要的，包括 §4 的 composer。

## 3. 本插件的 HTTP 面

| | |
|---|---|
| 方法 | `POST`（其余 → `405 method not allowed`） |
| 路径 | 默认 `/wsl-workspace/api`；profile 可覆盖（`Config.route`）——真实路径读 `describe` |
| 请求体 | `{ "method": "<名字>", "params": { … } }`（`params` 必须是对象，否则 `400`） |
| 响应 | `{ "ok": true, "value": … }` 或 `{ "ok": false, "error": "…" }`（校验类错误也是 `200` + `ok:false`） |
| 鉴权 | 无——**仅环回**：非环回的 `remoteAddress` 或 `Host` 头回 `403 {"error":"loopback-only"}` |

方法表要**运行时读**，不要抄进自己的代码：

```bash
curl -s -X POST http://127.0.0.1:3981/wsl-workspace/api \
  -H 'content-type: application/json' -d '{"method":"describe"}'
```

`describe` 回 `{ version, releases, route, loopbackOnly, methods, installProof, driving }`。
`methods` 是权威表（`name`／`mutates`／`params`／`returns`），它与派发器读同一个常量；两者不一致时构建红。
十枚方法是：

`listDistros`、`listDir`、`check`、`registerWindows`、`listWorkspaces`、`removeWorkspace`、
`listWorkspaceRecords`、`setUser`、`variantStatus`、`describe`。

先只读地打一发：

```bash
curl -s -X POST http://127.0.0.1:3981/wsl-workspace/api -H 'content-type: application/json' \
  -d '{"method":"check","params":{"distro":"Ubuntu","path":"/home"}}'
# {"ok":true,"value":{"exists":true,"isDirectory":true}}
```

**装的是哪批字节？** 版本号答不了——`file:` 安装是拷贝，会静默变旧。`describe.installProof` 给出一枚只
存在于"带这张表的构建"里的字面量：

```powershell
Select-String -Path "<profile>\node_modules\dsh-wsl-workspace\lib\index.js" -Pattern "wsl-workspace:methods-v1"
```

计数非 0 ⇒ 加载的那份至少是随带本文件的那个构建。

## 4. 把文字送进 composer 并发出去（内置浏览器／任意页面）

composer 是 **Lexical**（`data-lexical-editor="true"`），而所在页面可能处于 `0×0` 隐藏视口——这两点
合起来排除了两条"看起来最顺"的路，只留下一条：

- `document.execCommand('insertText', …)` 返回 **false**，正文恒空。
- `beforeinput` **和** `input` 各发一次，文字会进**两遍**。

按这个来（页内 JS；内置浏览器的 `evaluate_script` 可用）：

```js
const ed = document.querySelector('[contenteditable][data-lexical-editor]');
if (!ed || ed.getAttribute('contenteditable') !== 'true') throw new Error('composer 未启用：先选工作区');
ed.focus();
const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
const s = getSelection(); s.removeAllRanges(); s.addRange(r);
ed.dispatchEvent(new InputEvent('beforeinput', {
  inputType: 'insertText', data: '只回一个字：好', bubbles: true, cancelable: true, composed: true,
}));
// 然后
[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '发送消息').click();
```

前置条件按顺序：先点掉首启两层模态（`预览版说明` → `继续`，再 `开始使用` → `关闭`），再**选中工作区**
——在那之前 composer 是 `contenteditable="false"`，注入会静默落空。工作区可以不走 UI，用宿主同源 RPC：

```js
await fetch('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create',
    payload: { args: { request: { path: 'D:/Temp/scratch-ws' } } } }) });
```

端到端实测：注入 + 点发送后，sensenova 档的真模型 16 秒回了「好」，用量 9.4K tok。

## 5. 默认 provider 报 401 时改哪一处

全新的隔离 home 会落回 `deepseek-official`，那枚 key 通常没有，于是**每一轮都以
`MISSING_CREDENTIAL` / 401 收场**，而别处看不出任何异常。

provider 与默认模型是**profile 配置**，不是插件配置：

`<DSH_HOME>/profiles/web/cordis.patch.yml`

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      sensenova:                      # 名字随意，下面引用它
        api: openai-completions
        baseURL: https://token.sensenova.cn/v1
        apiKeyEnv: SENSENOVA_TOKEN_PLAN_API_KEY   # 只写变量名，绝不写值
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

- **key 不落盘**：把 `apiKeyEnv` 点名的那枚环境变量**在启动环境里 export**；patch 里只有名字。
- **只有新会话会用它**。补丁之前建好的会话保持它记录下的模型；改完补丁要**新建**会话（或用宿主的模型
  选择器）。
- 同一形状对桌面 profile 也成立（`<home>/profiles/desktop/cordis.patch.yml`）；模型必须是该 provider
  `models` 列表里声明过的。

## 这枚插件刻意不做什么

它只答"仅环回"的数据调用、并注册预设变体。它不启动／停止／重启宿主，不写自己凭据库
（`~/.dsh/wsl-workspaces.json`）之外的地方，也不管理 provider——§5 是宿主配置。
