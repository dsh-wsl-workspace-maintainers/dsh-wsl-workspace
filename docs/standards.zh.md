# 项目标准：提交之前必须成立的事

> 这份文件只放**反复出错**的硬规则。每一条都对应本项目里真实发生过、并且**本可以本地拦下**的失败。
> 经验与背景在 [`lessons.zh.md`](./lessons.zh.md)，按 tag 取用；本文件不需要读别处。
> 违反其中任何一条，CI 会红，或者更糟——绿灯但结论是假的。

## S1 绿灯不等于通过

**一条不能失败的断言不是覆盖率，是覆盖率的样子。**本项目出现过三种形态，都是我自己写的：

- 恒真：`sessionName === 'bash'`（`sessionName` 就是 `TOOL_NAME ?? 'bash'`，两边都是同一个值）
- 截断：`grep … | head -3` 之后据此断言"没有别的用处"，而被截掉的那行正在用这个标识符
- 夹具代答：注入式测试夹具把依赖（`join`、`AbortSignal`）补齐，于是测试通过，而真实文件里那个绑定并不存在

**做法**：写完断言，反过来问一次"什么情况下它会是红的"。答不上来，它就不是断言。

## S2 `node --check` 不等于能跑

它只查语法。三次真实故障都是运行时引用：`AbortSignal is not defined`、`relayNode is not defined`、`delimiter is not defined`。

**做法**：改动一个模块后，**在真实执行路径上跑一次**。特别地——

- 只跑 `--verify-only` 之类的旁路，**不算**验过（`install-pinned --verify-only` 就不走 `runNpm`）
- 用注入式夹具验函数时，夹具**不得**补齐被测代码缺少的绑定；要么只注入纯数据，要么真跑文件

## S3 修债必须同提交改账本

`tests/deliberate-reds.mjs` 的仲裁规则是双向的：

- 出现**未声明**的新红 → `run-seams` 失败
- **声明过的红转绿** → 同样失败（"有人修了产品，欠这个文件一次编辑"）

所以修产品的那一个提交里，必须同时改账本。

**并且**：账本机制的控制用例**不能读真实数组**。它一旦读了，每还清一条债就同时少一条控制。本项目已因此改过一次（`tests/deliberate-reds.test.mjs` 改用自带合成账本）。

**同族陷阱**：任何"断言某个坏点仍在名单里"的控制用例，还债时必红。本项目三例：`check-portable-spelling.test.mjs`（断言 §6 坏点在列）、`tech-debt-exposure` 的 A/B/E（断言 Node/操作系统自身行为）。这类断言要改成断言**债已还**。

## S4 提交里的 `lib/` 必须与 `src/` 同步

`lib/` 是**提交进仓库**的构建产物，CI 有 `rebuild must reproduce the committed lib/ byte-for-byte`。

**做法**：改完 `src/` 一定跑 `npm run build` 并把 `lib/` 一起提交；再跑一次 build，`git status lib/` 必须为空（证明可复现）。

## S5 类型错误不许增长

`ci/typecheck-baseline.json` 记录当前错误数（209）与被禁的代码（`TS2515`）。`scripts/typecheck-gate.mjs` 要求**不增长**，`--record` 才会重写它。

**做法**：改完先数一遍。增长了就**修掉**再提交；确实要抬高基线，必须是有意识的动作并写明理由，不能顺手 `--record`。

## S6 定位要发生在推送之前

CI 很贵，而且一轮红只告诉你一件事。**推之前**至少做到：

| 检查 | 命令 |
|---|---|
| 真跑一遍改动模块 | 见 S2 |
| 单元桶无**新**失败 | `npm run test:unit`（本机有 9 条环境性失败，判据是"没有新的"，不是"全绿"） |
| 构建可复现 | 再 `npm run build`，`git status lib/` 为空 |
| 类型不增长 | `npx tsc -p tsconfig.json --noEmit \| grep -c "error TS"` |
| 文档门禁 | `npm run test:docs`、`npm run test:docs-claims` |

## S7 判断"推成功了吗"要看远端 SHA

`git push` 可能在输出 `fatal:` 的**同一行后面**跟着 `Everything up-to-date`。判据只有一个：远端 ref 的 SHA。

相关：本机到 `github.com` 的 git 通道可能整体不通（见 `lessons.zh.md` 的 tag `env-network`），此时改走 Git Data API，注意三条：**先传 blob 再建 tree**、`--input` 与 `-f/-F` 不能混用、`force` 要放进 JSON 载荷。

## S8 可移植性：禁的是解释器，不是 spawn

hazards A/E 禁的是把 argv 交给命令解释器（`shell: true`），**不是**禁止 spawn 一个程序。

`npm` 在 POSIX 上就是一个可执行程序，`spawnSync('npm', args)` 不需要 shell。需要 shell 的只有 Windows 上
的 `npm.cmd`；那里的正解是找到 `bin/npm-cli.js` 并用 `node` 跑它（`npm_execpath` → `node.exe` 旁边 →
`PATH` 上启动器旁边，**两种布局都要试**，hosted tool cache 只中其中一种），找不到就**明确报错**，不要猜。
