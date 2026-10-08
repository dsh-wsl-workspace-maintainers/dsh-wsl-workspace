# 经验库：按 tag 取用，不要整篇读

> **怎么用**：下面每条经验都带一个 tag。用 `grep -n '<tag>' docs/lessons.zh.md` 定位行号，
> **只读那一节**。整篇读完会挤占上下文，而这里大部分内容在多数任务里用不上。
> 反复出错、必须遵守的硬规则已经抽到 [`standards.zh.md`](./standards.zh.md)（S1–S8），那份很短，值得先读。

## tag 索引

| tag | 一句话 | 什么时候读 |
|---|---|---|
| `verify-fake-green` | 三种"看着绿、其实没测"的断言形态 | 写任何断言之前 |
| `verify-runtime` | `node --check` 查不出运行时引用；要在真实路径上跑 | 改完模块、提交之前 |
| `ledger-debt` | 修债必须同提交改账本；控制用例不能读真实数组 | 动 `tests/deliberate-reds.mjs` 或还债时 |
| `control-debt-assertion` | 断言"坏点仍在名单里"的控制用例，还债时必红 | 看到某个控制用例莫名变红时 |
| `ci-red-loop` | 定位要在推送之前；CI 一轮红只告诉你一件事 | 准备推 CI 之前 |
| `ci-latency` | "CI 慢"多数是重复 run 或 runner 挂起，不是活多 | 抱怨 CI 慢时 |
| `ci-parallel` | 按维度拆 matrix；同机并发的取舍要看计时断言余量 | 改 `ci.yml` 结构时 |
| `real-host-strength` | "真机实测"有三种强度，说清是哪一种 | 声称"真机验证过"之前 |
| `env-network` | hosts 改写让 git 通道不通；Git Data API 的三个坑 | push 失败或 `ls-remote` 不通时 |
| `env-local` | 本机跑不了的东西（会让人误判"改坏了"） | 本机测试红了先看这条 |
| `change-surface` | `lib/` 与 `src/` 同步、typecheck 基线 | 改了 `src/` 之后 |
| `collab` | 不看勾选框看代码；数提交；squash 会静默丢东西 | 移植别人的分支时 |
| `portable` | `portability-allow` 是既有豁免机制；扫描器会数自己的散文 | 动 `check-portable-spelling` 时 |

---

## `verify-fake-green`

三种形态，全部出现在本项目，全部是我自己写的：

1. **恒真**：`tool?.name !== undefined || sessionName === 'bash'`，而 `sessionName` 就是
   `TOOL_NAME ?? 'bash'` —— 两个 disjunct 恒为真。要抓"registry 答的是不是宿主的一次性 bash"，
   判据得是**描述**而不是名字：会话工具的 `description` 以
   `Run a bash command inside this WSL distribution. The shell is persistent:` 开头，一次性的不是。
2. **截断**：`grep -n 'pathToFileURL' f | head -3` 之后据此判定"没有别的用处"，而被截掉的那行
   正是唯一的使用点（`w51-probe.mjs:81` 加载 `lib/shell.js`）。
3. **夹具代答**：注入式夹具把 `join` / `AbortSignal` 这类绑定补齐，于是测试通过，而真实文件里
   那个绑定根本不存在（CI 上直接 `ReferenceError`）。

## `verify-runtime`

`node --check` 只查语法。三次真实故障都是运行时引用：`AbortSignal is not defined`（改了 import 没同步）、
`relayNode is not defined`（重构后旧标识符还在用）、`delimiter is not defined`（三个文件里只改了两个的 import）。

**只跑旁路不算验过**：`node ci/install-pinned.mjs --verify-only` 完全不走 `runNpm`，
所以"verify-only 是绿的"对 `runNpm` 毫无信息量。要验就 `node ci/install-pinned.mjs` 真跑一次。

## `ledger-debt`

账本是双向仲裁：未声明的新红 → `run-seams` 失败；**声明过的红转绿 → 也失败**（有人修了产品，欠文件一次编辑）。
所以还债与改账本必须在同一个提交里。

控制用例**不能读真实数组**：它一旦读了，每还清一条债就同时少一条控制。本项目已改为自带合成账本
（`tests/deliberate-reds.test.mjs` 的 `FIXTURE`）。

## `control-debt-assertion`

同一族的另一面：**断言"某个坏点仍在名单里"的控制用例，还债时必红。**本项目三例：

- `check-portable-spelling.test.mjs` 断言 `src/host/wsl-search.ts:841` 在扫描名单上
- `deliberate-reds.test.mjs` 断言账本条目数 `>= 10`
- `tech-debt-exposure` 的 A/B/E 断言 Node 与操作系统自身的行为（argv 过 shell、丢掉子进程的话）

前两种的正解是改成断言**债已还**；第三种根本不该留在门禁里（见 `standards.zh.md` S3）。

## `ci-red-loop`

我把 CI 当调试器：推 → 红 → 读日志 → 改 → 再推。一个改动连红四轮，而其中至少两轮的成因是
**本地就能发现的**（一个未暂存的修改被 `commit --amend` 丢在提交外；一个未使用的 import）。
CI 一轮红只告诉你一件事，且代价是一整轮排队。

**推之前的清单在 `standards.zh.md` S6。** 另外：`git commit --amend` 之前要 `git add -A`，
并用 `git show HEAD:<file>` 复核内容真的进了提交。

## `ci-latency`

"CI 太慢"先分清是**慢**还是**卡**。实例：run #151 从 12:13Z 起 `in_progress` **8 小时**，
其中 1 个 job 无输出，**它自己的 `timeout-minutes: 35` 都没触发** ⇒ runner 侧，日志 blob 已被清理，无法归因。

真正的"慢"来自另一处：`concurrency.group` 用 `github.ref`，而 push 是 `refs/heads/<分支>`、
PR 是 `refs/pull/<n>/merge` ⇒ **两个不同组**，`cancel-in-progress` 拦不住 ⇒ **每次推送跑两遍完整 CI**，
而且**卡住的总是那个重复 run**（#151 卡 1 个、#153 卡 4 个，孪生 run 都 7:48 全绿）。
修法一行：`group: checks-${{ github.workflow }}-${{ github.head_ref || github.ref_name }}`，
实测重复 run 在 3 秒内被取消。

## `ci-parallel`

`wsl-gate` 的 matrix 从 `wslVersion` 扩到 `wslVersion × plane`，src/lib 跑在不同 runner 上：
**12 min 47 s → 7 min 34 s**，覆盖率逐 gate 核对无缩水（src 13 个 + lib 7 个 = 20）。

**没有采用"同 job 内并发"**：本地 WSL2 实测两条计时断言都没变差（pager cell `<3_000` 读到 412 ms，
quiet sentinel `>3_500` 读到 4016 ms），但 WSL1 上那条 pager cell **曾在无并发时**实测 6187 ms。
本地 WSL2 的余量对那台机器没有推论力，而 WSL1 在 runner 外无法复现 ⇒ 选"拆到不同 runner"这种
**零争用**的并行。

## `real-host-strength`

"真机实测"有三种强度，说清是哪一种，别混用：

1. **命令真跑，但接线是手工的** —— 用 `runProfile` 之外的方式自己拼命令
2. **真启宿主 + 走宿主给模型的 registry** —— `runProfile` 起真 profile，工具从 `ctx.tools.get('bash')` 取
   （`tests/support/w51-command-census.mjs` 是这一档）
3. **再叠一层结果正确性** —— 不止"调用成功"，而是**与同发行版直接运行逐字节比对**

第 3 档抓到过真东西：`wsl.exe … bash -c '<文本>'` 会多过一层 shell，`$?` 在到达 `bash` 前就被展开，
于是"基准"给出 `code=0` 而会话给出正确的 `code=3`。修法是两边跑**同一个脚本文件**，输入按构造即相同。

## `env-network`

本机到 `github.com` 的 git 通道会整体不通：hosts 把 `github.com` / `api.github.com` 都改写到
`127.0.0.1`（Watt Toolkit），而 `api.github.com` 还能用。症状是 `fatal: ... 500/502`、
`Failed to connect to github.com:443 over proxy`、`CONNECT tunnel failed`，而 `gh api` 时好时坏。

**走 Git Data API（`gh api`）时的三个坑**：

1. **必须先上传 blob 再建 tree**，否则报 `is not a valid blob` 或 `BadObjectState`（树里引用的对象必须已在服务端）
2. `--input -`（body 来自 stdin）与 `-f/-F` 字段**不能混用**；`force` 要放进 JSON 载荷
3. `parent` 用**远端 head**；要从 main 重建则需 `force: true`

还有一条：`Everything up-to-date` 会和 `fatal:` **同时出现**（见 `standards.zh.md` S7）。
一次 push 还可能触发**两个 run**（push 与 PR 是不同 concurrency group），于是"某个 job 失败"与
"整轮绿"可以同时出现在检查列表里 —— 判断状态要看**每个 run**。

## `env-local`

本机有三类东西跑不了，看到它们变红**先别当成改坏了**：

- **`npm run test:unit` 有 9 条环境性失败**（`--import` 夹具与 probe 子进程起不来），CI 上它们是绿的
  ⇒ 判据是"**没有新失败**"
- **`node` 启不了 `git`**（`spawnSync git EBUSY`）⇒ `verify-lib-sync`、`verify:artifact` 本机跑不了
- **缺 `@deepseek-ai/dsh-scope`** ⇒ `bash-parity-real` 本机跑不了

## `change-surface`

- `lib/` 是**提交进仓库**的构建产物，CI 有 byte-for-byte 的重建校验。改了 `src/` 必须重新构建并提交
  （见 `standards.zh.md` S4）
- `ci/typecheck-baseline.json` 记录错误数（209）与被禁代码，`scripts/typecheck-gate.mjs` 要求不增长
- 改动常常同时落在**两个必须一起改的地方**（`src/` 与 `lib/`、`ci.yml` 与 `docs/CHECK-CATALOG.md`）

## `collab`

- **不看勾选框，看代码**：一次"9 项里 6 项已完成"的核实，是逐条读实现得出的，不是读 issue 的复选框
- **数提交要数准**：以为从别人分支移植过来是 2 个提交，实际是 3 个（第三个是 fixture 支撑）
- **squash 会静默丢掉东西**：合并后要单独核实落地结果，别信"已合并"
- **合并后立刻在 main 上复核**关键锚点（grep 具体的函数名/字段），比看 PR 状态可靠

## `portable`

- `portability-allow` 是这个仓库**既有的**豁免机制：在行尾写它，那一行就不算违规。用它标注合法例外，
  比在扫描器里开白名单好
- **扫描器会数自己的散文**：`check-portable-spelling.mjs` 目前会把"注释里解释为什么禁 `shell: true`"
  计成命中（实测 116 → 112 的量级里混着我自己写的注释）。一个不跳过注释的扫描器没法当闸门
- 断言"这个形状不存在"时，**把注释涂空而不是删除**（保留行号，且规则不数自己的说明）
