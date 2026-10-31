# 从别的 agent 驱动这枚插件（五问）

> **仓库内引用说明。** `PITFALLS.md` 以及本包之外的其它文件都住在"这枚包来自的那个插件工作区"里、**不随包发布**；驱动本插件需要的东西全在这一份文件与包内。

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
$env:DSH_HOME = 'D:\path\to\dsh-home'
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
里，参数同样是 `web --no-open --host … --port …`。官方安装包就是那个桌面端发行版，下载地址写在随包发布的
`TESTING.md` 里。exe 落在哪由安装方式决定：按用户安装通常落在 `%LOCALAPPDATA%\Programs` 下，以开始菜单
快捷方式的"目标"为准。

**先把本插件装进同一枚临时 home**，否则 §3 没有东西可答：在 `DSH_HOME` 仍设着的情况下
`dsh plugin --profile web add <tarball 或它解包后的目录>`，再按上面那行启动 `dsh web`。`PATH` 上没有 `dsh`
时，上面启动行里的那个 `cli.js` 入口就是同一个 CLI——把它 `web …` 的位置换成 `plugin --profile web add …`。
**优先用 tarball**：裸的解包目录会以 `link:` 加进去，realpath 必须自己解得到本包的依赖（`js-yaml`），
于是可能出现"`describe` 能答、预设生成却失败"的半坏状态；tarball 让 profile 自己把依赖装齐。手上只有解包
目录时，在目录里 `npm pack --ignore-scripts` 就能出一枚 tarball——随包 `package.json` 的 `prepack` 钩子会
去重建一个 tarball 里并不存在的仓库。如果 server
起着、而 `{"method":"describe"}` 没回 `{"ok":true}`，说明插件没装进这枚 profile——先查
`<DSH_HOME>/profiles/web/cordis.patch.yml`，别先怀疑路由拼写。

那行 URL 只在 server 开始监听之后才出现。若一行都没有，说明进程没起来——读 stderr；最常见的原因是端口被占，
换任意空闲 `--port` 即可，打印出来的 URL 会跟着你传的端口走。

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
| 鉴权 | 无——**仅环回**：非环回的 `remoteAddress` 或 `Host` 头回 `403 {"ok":false,"error":"loopback-only"}` |

路径是**profile 配置**（`Config.route`），不是代码里的常量。改过路由的 profile 在补丁文件里说明：

```yaml
# <DSH_HOME>/profiles/web/cordis.patch.yml
- id: wsl-workspace
  config:
    route: /wsl-workspace/api
```

真实生效值一律读 `describe.route.path`，不要假设是默认值。**改路由是"两半一起改"**：随包的侧栏对话框
从一个常量取默认路径，只改路由、不改客户端，对话框会失效而 `curl` 照常能用。

这条路由**不发任何 CORS 头**：从进程里调（`curl`、Node、脚本），或从同一 origin 的页面里调。从别的 origin
的 `fetch` 会失败且拿不到可读错误——那不是路由的 bug。

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
存在于"带这张表的构建"里的字面量（下面的 `<profile>` 指 `<DSH_HOME>/profiles` 下那一层；`web` profile 就是
`<DSH_HOME>/profiles/web`）：

```powershell
Select-String -Path "<profile>\node_modules\dsh-wsl-workspace\lib\index.js" -Pattern "wsl-workspace:methods-v1"
```

计数非 0 ⇒ 加载的那份至少是随带本文件的那个构建。

## 4. 把文字送进 composer 并发出去（内置浏览器／任意页面）

composer 是 **Lexical**（`data-lexical-editor="true"`），而所在页面可能处于 `0×0` 隐藏视口——这两点
合起来排除了两条"看起来最顺"的路，只留下一条：

- `document.execCommand('insertText', …)` 返回 **false**，正文恒空。
- `beforeinput` **和** `input` 各发一次，文字会进**两遍**。

按这个来。**这里认控件靠结构与行为，不靠界面语言**：模态按"最后一枚按钮"推进（先试已知文案），
composer 按属性去找、发送控件按"disabled→enabled 的翻转"去认。那两条文案正则
（`继续|continue|关闭|close|got it`、`send|发送`）只是兜底——界面既不是英文也不是中文时，把它们补上。

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 首启模态：不认字，认位置——推进/关闭控件是每个对话框的**最后一枚**按钮
//    （两层首启模态都实测过）。见过的文案只作兜底，防止将来某版换了顺序。
for (let i = 0; i < 3; i += 1) {
  const dialog = document.querySelector('[role=dialog]');
  if (!dialog) break;
  const buttons = [...dialog.querySelectorAll('button')];
  const byLabel = buttons.find((b) => /继续|continue|关闭|close|got it/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`));
  (byLabel ?? buttons[buttons.length - 1] ?? dialog).click();
  await sleep(300);
}

// 2) composer：Lexical 会自报家门；role=textbox 那条是改名后的兜底
const ed = document.querySelector('[contenteditable][data-lexical-editor]')
  || [...document.querySelectorAll('[contenteditable][role=textbox]')][0];
if (!ed || ed.getAttribute('contenteditable') !== 'true') throw new Error('composer 未启用：先选工作区');
ed.focus();
const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false);
const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);

// 3) 发送控件按**行为**认：正文进 composer 后，从 disabled 变 enabled 的那枚带 aria-label 的按钮
//    （它的 aria-label 是本地化的：中文 发送消息 / 英文 Send message）
const labelled = () => new Map([...document.querySelectorAll('button[aria-label]')]
  .map((b) => [b.getAttribute('aria-label'), b.disabled]));
const before = labelled();
ed.dispatchEvent(new InputEvent('beforeinput', {
  inputType: 'insertText', data: '只回一个字：好', bubbles: true, cancelable: true, composed: true,
}));
await sleep(150);
const flipped = [...labelled()].filter(([label, disabled]) => before.get(label) === true && disabled === false);
const send = flipped.length === 1
  ? [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === flipped[0][0])
  : [...document.querySelectorAll('button[aria-label]')].find((b) => /send|发送/i.test(b.getAttribute('aria-label')) && !b.disabled);
if (!send) throw new Error('找不到发送控件；这一页的 aria-label 有：' + [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).join(' | '));
send.click();
```

**先选工作区**——在那之前 composer 是 `contenteditable="false"`，注入会静默落空。"选"＝打开一枚会话：
在侧栏点那枚工作区。工作区可以不走 UI、用宿主同源 RPC 建（`path` 填你自己的一个已存在空目录），但**建完
不会自动选中**——随后要点它一下。片段要在页面里跑（devtools 控制台，或自动化工具的 evaluate-script），
且先关掉首启模态：

```js
await fetch('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create',
    payload: { args: { request: { path: 'D:/path/to/scratch-ws' } } } }) });
```

端到端实测：注入 + 点发送后，sensenova 档的真模型 16 秒回了「好」，用量 9.4K tok。

## 5. 默认 provider 报 401 时改哪一处

全新的隔离 home 会落回 `deepseek-official`，那枚 key 通常没有，于是**每一轮都以
`MISSING_CREDENTIAL` / 401 收场**，而别处看不出任何异常。

provider 与默认模型是**profile 配置**，不是插件配置。补丁是按 `id` 串起来的一列行：**改已有的那两行**
（插件装好后 profile 里本来就有 `llm-pi-ai` 与 `agent-default-model`），不要追加一行同 id 的：

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
  选择器）。profile 补丁在启动时读取，所以改完要先重启实例再建那枚会话。本插件 API 上没有模型读数——
  确认方式是行为上的：新会话能正常回答，而不是每轮都以 `MISSING_CREDENTIAL` / 401 结束。
- 同一形状对桌面 profile 也成立（`<home>/profiles/desktop/cordis.patch.yml`）；模型必须是该 provider
  `models` 列表里声明过的。

## 这枚插件刻意不做什么

它只答"仅环回"的数据调用、并注册预设变体。它不启动／停止／重启宿主，不写自己凭据库
（`<DSH_HOME>/wsl-workspaces.json`，home 用默认值时就是 `~/.dsh/wsl-workspaces.json`）之外的地方，也不管理
provider——§5 是宿主配置。
