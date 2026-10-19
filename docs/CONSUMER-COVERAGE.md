# 消费方台账：谁在我们切断的 realm 上要服务

**这张表是什么**：由代码派生的一份覆盖清单——**宿主自己的包**在我们生成的 `wsl-*` 世界里，向我们切断过 realm 的服务（现量 `fs`／`sandbox`／`shell`／`terminals`）伸手要东西的每一对 `(服务, 包)`。它由 `tests/consumer-coverage.test.mjs` 逐行核对：少一行、多一行、状态与实际凭据不符，**都变红**。派生规则在 `tests/support/consumer-ledger.mjs`，跑一次约 2.9 秒。

**为什么要有它（这不是又一份用例清单，是换取样轴）**：本仓的装置全部从**我们注册的工具**进。现量整个 `tests/`＋`scripts/` 语料里 `tools.get(…)` 只出现四种名字——`bash` 10 次、`grep` 4 次、`wsl_terminal` 2 次、`glob` 1 次，而 `grep`/`glob` 还是我们自己的搜索工具。**除 `bash` 之外没有任何一枚宿主工具在我们造的世界里被调用过。** 三条 issue 正是从这个盲区来的：

- **#54**：`read_image` 恒报 `cannot get property "fs" without inject`。伸手的是 `@deepseek-ai/dsh-tool-fs`（`read_image` 的注册包，`lib/index.js` 里 `ctx.fs.readBytes(...)`）。我们挂载过这个包 8 处，**没有一处调用它注册的工具**——`read_image` 在 `tests/`＋`scripts/`＋`docs/`＋README 里 **0 命中**。
- **#78**：`run_code` 100% 启动失败 `GetNamedSecurityInfoW failed (Win32 1)`。伸手的是 `@deepseek-ai/dsh-ptc-runtime-node`（`static inject = ["fs","subprocess","sandbox","sandboxPolicy"]`）。这个包**从未被任何装置引用**；我们自己的 no-op provider（`src/host/wsl-sandbox.ts`）也**从未被任何闸调用过 `confine()`**——`confine` 在 `tests/`＋`scripts/` 里唯一的命中是 `tests/variants.test.ts` 对**生成文本**的字符串断言。
- **#60**：重复注册发生在 loader 装配期。我们断言的是"名单里有什么"，从来没按生成的名单真去建一次会话。

**状态词表（只许这三个，且由凭据反推）**：

| 状态 | 含义 | 凭据列要求 |
| --- | --- | --- |
| `已调用` | 有装置**真的执行过**这个消费者 | `文件 :: 锚点字符串`，闸会打开该文件确认字符串在里面 |
| `挂载未调用` | 有装置提到过这个包（挂载或断言其存在），没人调用它 | `-`，后面写出口 |
| `未挂载` | 整个语料里没有一处引用它 | `-`，后面写出口 |

**`挂载未调用` 不是覆盖。** 这一行是这张表存在的全部理由：`tests/host-declare.mjs:219` 断言的是 `world.config.some(row => row.id === 'tool-fs')`，`tests/host-materialize.mjs:390` 断言的是 `minYaml.includes('wsl-sandbox.js')`——两条都只证明**字符串里出现了那个条目**。

**三态里谁是机器说了算**：`未挂载`／`挂载未调用` 由派生判定（闸自己数引用该包的装置文件数，并核对这一列是否与它数到的一致）；`已调用` 是**人写的断言**，是派生给不出的那一层（机器看不出"引用"和"调用"的差别），所以闸会打开你指的凭据文件、确认那个锚点字符串还在里面，并要求该包至少被一处装置引用——**写了真调用就必须拿真调用换**。

**判据形状（这条我写错过，现按实测钉死）**：消费者按四种形状取**并集**——`get("fs"`、`inject` 声明的窗口里含 `"fs"`、`super(ctx, "fs"`、以及源码里的属性形 `ctx.fs`。真数：`dsh-tool-fs` 里 `ctx.fs` 出现 **15** 次，而 `get("fs")` 出现 **0** 次——它是通过注入的代理属性拿到服务的，所以**只看 `get` 那一形就会漏掉这张表存在的理由本身**。本文件的第一版把这件事说反了（声称属性形漏掉 `dsh-tool-fs`）：那次检查是用 bash 双引号跑的，`\\\\.` 到 JavaScript 变成"字面反斜杠"，什么都匹配不上——**错在工具，不在树**。闸给两对被咬过的 pair 各钉了两条形状正对照（`property > 0` 且 `inject > 0`），谁以后删掉一个形状，红的是一条有名字的断言，而不是安静地少几行。

**派生规则**：服务名来自我们自己生成的 preset 里的 `isolate:` 键（`src/host/variants.ts` 的 `wslWorldGroup`），一次性世界与持久 shell 世界都读（`sandbox` 只在挂了会走 confinement 的 shell 时才发出）；消费者来自 `ci/deps/node_modules/@deepseek-ai/<包>/lib` 下的全部 `.js`（>3 MB 的 vendored bundle 跳过）。现量 **4 个服务 / 48 对 / 40 个包**，跑一次约 3 秒。48 对是宿主升到 `0.2.1-rc.2` 之后的数：升级带进 5 对（`fs`×worktree、`fs`×working-directory、`fs`×workspace-changes、`sandbox`×worktree、`terminals`×`dsh-tool-terminal`），也带走 2 对（`shell`×`dsh-hooks-claude-code`、`shell`×`dsh-hooks-codex`——这两枚包在新闭包里不存在了）。

**棘轮**：状态非 `已调用` 的行数钉在闸里（今天 **46/48**；两枚探针在 ubuntu runner 上是 `SKIP:`——`dsh-attachment` 不在钉住的闭包里、windows-acl 那条链在 linux 上不存在，所以"探针进了 CI"不等于"CI 测到了"，只许降不许升；升了说明宿主升级带来了一个我们没看过的新消费者——先探针看清它，再改这张表。

| 服务 | 宿主包 | 状态 | 凭据（`文件 :: 锚点`）与出口 |
| `fs` | `dsh-agent-instructions` | `挂载未调用` | `-`；与 #54 同一条 realm 题，探针覆盖 `fs` 时一并判 |
| `fs` | `dsh-api-session-controller` | `未挂载` | `-`；Desktop 侧才装配，待 #78 的装配类探针 |
| `fs` | `dsh-api-workspace-files` | `未挂载` | `-`；它同时是 `sandbox.confine` 的调用方，属 #78 一族 |
| `fs` | `dsh-client-ui-deliverables` | `未挂载` | `-`；UI 面，本仓无对应表面 |
| `fs` | `dsh-cordis-host-runner` | `未挂载` | `-`；宿主 runner |
| `fs` | `dsh-experimental-worktree` | `未挂载` | `-`；0.2.1-rc.2 新入表（0.2.0-rc.2 的闭包里没有这枚包）。形状：`static inject` 含 `"fs"`（`lib/index.js:186-192`）＋属性形 `ctx.fs.resolve / processPath / lstat`（`:270`、`:274`、`:297`），全在工具调用里懒取。我们的 `wsl-*` 世界没有它的 `name:` 行。出口：拿 `tests/support/w54-isolate-probe.mjs` 那对臂判"挂上后在切断的 realm 里取 `fs` 会不会回 `cannot get property "fs" without inject`"，判完再改状态 |
| `fs` | `dsh-fs` | `挂载未调用` | `-`；`fs` 服务接口包本身 |
| `fs` | `dsh-fs-local` | `挂载未调用` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `fs` | `dsh-fs-sandbox` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `fs` | `dsh-headless` | `未挂载` | `-`；headless 装配，非 Desktop 路径 |
| `fs` | `dsh-llm` | `挂载未调用` | `-`；模型侧读文件（附件/图片）——#54 的邻居，值得单独判 |
| `fs` | `dsh-llm-pi-ai` | `挂载未调用` | `-`；同上 |
| `fs` | `dsh-office-to-pdf` | `未挂载` | `-`；文档转换工具面 |
| `fs` | `dsh-ptc-runtime-node` | `挂载未调用` | `-`；**#78**，见下面 `sandbox` 那行 |
| `fs` | `dsh-repeat-tool-reminder` | `未挂载` | `-`；装配期插件，#60 同族 |
| `fs` | `dsh-skill-filesystem` | `挂载未调用` | `-`；skill 提供方。我们的 skill 面另有 `scripts/compatibility/skills-real.mjs`，但它不调这个包 |
| `fs` | `dsh-spill-policy` | `未挂载` | `-`；宿主的溢写策略与我们那两套，B1 相关，值得单独判 |
| `fs` | `dsh-tmux-context` | `未挂载` | `-`；UI 上下文 |
| `fs` | `dsh-tool-fs` | `已调用` | `tests/support/w54-isolate-probe.mjs :: get('read_image')`——两臂都在：root-realm 世界 60 ms 回 `image/png`，isolate 世界 1 ms 回 `cannot get property "fs" without inject`，且抽掉 `fs: true` 一个 token 后那句话消失（#54 定案） |
| `fs` | `dsh-tool-fs-search` | `挂载未调用` | `-`；我们的 `grep`/`glob` 与之的同名冲突由 `scripts/check-rank-parity.mjs` 管，但没人调用它 |
| `fs` | `dsh-tool-present` | `未挂载` | `-`；展示类工具 |
| `fs` | `dsh-tool-str-replace-editor` | `挂载未调用` | `-`；文件编辑面，`workspace-write` 下会撞策略 |
| `fs` | `dsh-working-directory` | `挂载未调用` | `-`；0.2.1-rc.2 新入表，宿主"每会话工作目录"服务：`static inject` 含 `"fs"`（`lib/index.js:13-17`），`ctx.fs.resolve / stat` 在 `ensure()`、`directory()` 里懒取（`:90-91`、`:125-132`）。语料里引用它的一处是 `scripts/compatibility/host-services.mjs` 的**注释**——它说明为什么三枚真机驱动只 `provide` 一个 `ensure` 而不挂真包（挂上就要连带 `fs`/`sessionProjections`/`systemPrompt`），引用≠挂载，所以这行是 `挂载未调用` 而不是 `未挂载`。它也是宿主前台结果新加的 `cwd` 那一条的供给方（见 docs/bash-parity.md 的 `field-cwd`）——我们的世界用会话 cwd＋重启重放维持目录、不挂它。出口：探针要先答"宿主挂上后目录由谁供给" |
| `fs` | `dsh-workspace-changes` | `未挂载` | `-`；包不新，**pair 新**：0.2.0-rc.2 的 `inject` 只有 `["subprocess"]`，0.2.1-rc.2 扩成 `["subprocess","fs"]`（`lib/index.js:949`，`ctx.fs.processPath` 在写意图事件里懒取，`:1073`）。这条是宿主升级自己带进来的新消费面，不是我们改了它 |
| `sandbox` | `dsh-bash-sandbox` | `未挂载` | `-`；宿主 bash 的沙箱封装 |
| `sandbox` | `dsh-experimental-worktree` | `未挂载` | `-`；同一枚包的另一只手：`await ctx.sandbox.confine(command, {`（`lib/index.js:131`），与 #78 的 `dsh-ptc-runtime-node` 同族——我们的 `wsl-sandbox` provider 让它拒还是放行，只能靠真调一次 `confine` 判，不靠散文。出口同 `sandbox x dsh-ptc-runtime-node` 那行（`tests/support/w78-confine-probe.mjs`） |
| `sandbox` | `dsh-ptc-runtime-node` | `挂载未调用` | `-`；**#78**。出口：`tests/support/w78-confine-probe.mjs`（判 run_code 拿到的是谁的 provider，并真调一次 `confine`） |
| `sandbox` | `dsh-pwsh-local` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `sandbox` | `dsh-pwsh-sandbox` | `未挂载` | `-`；pwsh 侧同类 |
| `sandbox` | `dsh-sandbox` | `挂载未调用` | `-`；`SandboxProvider` 接口包本体 |
| `sandbox` | `dsh-sandbox-local` | `挂载未调用` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `sandbox` | `dsh-terminal-bash` | `挂载未调用` | `-`；PTY 后端在 spawn 前调 `confine`，与我们世界的 `sandbox: true` 直接相关 |
| `shell` | `dsh-bash-sandbox` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `shell` | `dsh-client-ui-settings-shell` | `未挂载` | `-`；UI 面 |
| `shell` | `dsh-fs-sandbox` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `shell` | `dsh-permission-presets` | `未挂载` | `-`；权限预设——**#70 的宿主侧就在这一族**，值得单独判 |
| `shell` | `dsh-pwsh-sandbox` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `shell` | `dsh-shell` | `挂载未调用` | `-`；`shell` 服务接口包 |
| `shell` | `dsh-tmux-context` | `未挂载` | `-`；UI 上下文 |
| `shell` | `dsh-tool-bash` | `已调用` | `scripts/compatibility/bash-parity-real.mjs :: tools.get('bash')`——一次性世界里执行宿主 bash 工具、由我们的 executor 承接（#51 的 gate）。这是两处真调用之一（另一处 `fs`×`dsh-tool-fs`） |
| `shell` | `dsh-tool-cordis` | `未挂载` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `shell` | `dsh-tool-fs-search` | `挂载未调用` | `-`；新入表（并集形状后才发现的消费者），出口待判 |
| `shell` | `dsh-tool-pwsh` | `挂载未调用` | `-`；pwsh 工具面，我们不生成它 |
| `terminals` | `dsh-terminal` | `挂载未调用` | `-`；终端注册表。`wsl_terminal` 是我们的工具，不是它 |
| `terminals` | `dsh-terminal-bash` | `挂载未调用` | `-`；见上面 `sandbox` 那行 |
| `terminals` | `dsh-tool-bash-persistent` | `挂载未调用` | `-`；宿主持久 shell——**#51 的 303.8 s 那一族**，我们只对照过它的声明 |
| `terminals` | `dsh-tool-pwsh-persistent` | `未挂载` | `-`；pwsh 持久面 |
| `terminals` | `dsh-tool-terminal` | `未挂载` | `-`；0.2.1-rc.2 新入表，`terminal_*` 那组模型工具：`inject` 含 `"terminals"`（`lib/index.js:150-155`），`ctx.terminals.spawn / startSend / read / signal / kill / list` 全在每次 execute 里懒取（`:304`、`:414`、`:518`、`:619`）。我们的世界挂的是 `dsh-terminal`＋`dsh-terminal-bash`＋自家 `wsl-terminal-tool.js`，这枚工具没进生成的名单。出口：#60 那条规矩——按生成的名单真建一次会话并调用它注册的工具，别再只断言"名单里有什么" |
**这一次升了，理由是具名的**：把钉住的宿主从 `0.2.0-rc.2` 抬到 `0.2.1-rc.2` 那一票带来 5 个我们没挂过的新消费方（43→46，另两对随 `dsh-hooks-*` 一起消失）。闸按设计变红，本文件逐行记下"看清"的那一半——每枚包的伸手形状、行号、是启动期还是调用期取的、以及我们的世界为什么没挂它；**探针那一半是各行"出口"列里点名的装置，还没写**，所以上面那句"先探针看清它再改表"这一轮只做到"看清"，没做到"探到"。这次抬由维护者在 2026-10-19 具名批准，条件是那 5 个出口必须留在表里、不许被数字本身忘掉；把这 5 行里任何一行改成 `已调用`，就是来还这笔债。

**维护规矩**：

1. 升级宿主依赖（`ci/pinned-deps.json`）后这闸变红，**先别改表**：新出现的那一对就是本次升级带来的真实风险，按 #54/#78 的样子先写探针，再决定状态。
2. 把某行升成 `已调用`，凭据必须指到**真调用**；闸会打开那个文件核对锚点字符串。"某测试引用了这个包名"不算。
3. 这张表只登记"伸手要服务"的关系。行为期望仍写 `docs/bash-parity.md` 与 `docs/release-behaviour-matrix.zh.md`；而那两处的基准线，按这轮教训必须是**同一宿主在 `standard` 世界里的同一次调用**（对照臂），不是"无故障原生 bash"——#54/#78/#60 三条没有一个能用原生 bash 当参照物测出来。
