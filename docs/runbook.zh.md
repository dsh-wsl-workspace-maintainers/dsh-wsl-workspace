# 维护者手册（回路版）

这页按"你现在要做的事"组织入口。每道闸的权威描述在 [TESTING.md](../TESTING.md)、[GATE-MAP.md](./GATE-MAP.md) 与 [CHECK-CATALOG.md](./CHECK-CATALOG.md)——本页不复抄任何数字与清单，冲突时以那三份为准。

## 日常回路（改代码的每一小时）

- 快闸：`npm run test:unit`（秒级，不需要宿主闭包）。红了先读用例名里的 `#NN`——每道闸都是某个真实缺陷换来的，issue 正文比代码注释更能说明它为什么存在。
- 动了宿主装配面（`index` / `variants` / `jobs` / `search` / `terminal` / `fs`）：加跑 `npm run test:node`（分钟级，前置 `node ci/install-pinned.mjs`；钉版树已是目标版本时会直接跳过重装）。
- 本地全部离线闸合计两分钟量级。如果哪天这个回路明显变慢，先修回路再干活——工具慢是维护成本，不是纪律。
- 涉及 bash 会话生命周期：`node --experimental-strip-types --test tests/wsl-bash-session.test.ts` 已离线可跑，不必为状态机改动起真机。

## 合并前回路（每次 push，CI 全帧约 7 分钟）

- push 即触发 checks：ubuntu 两段 + windows×WSL 三个 cell。红灯按 GATE-MAP「红灯该找谁」的顺序归因；真机红先取 `wsl-gate-logs-*` artifact 看原帧，别急着在本地归因给产品。
- 改装置：`test:apparatus-size` 必须绿；新增闸先在 GATE-MAP 建条目，找不到条目的闸在这个仓库没有存在的理由。

## 发布回路（固定节奏：默认六周，到点就发、攒多少发多少——调整就改这一行）

1. `npm run release:readings`——重放尺子（分钟级，会改写工作树），两项读数写入 `ci/release-readings.json`。这是唯一不能跳的步骤：没跑过尺子的版本发不出去。
2. 改 `package.json` 版本、写 CHANGELOG（中英成对）、`npm run build` 并提交 `lib/`。
3. 推 tag。release.yml 自动校验「tag 指向的 commit 有绿色 checks 运行」与两项读数，然后经 Trusted Publishing 发布并开 GitHub Release（中文 notes）。tag 就是全部发布手势。
4. 最后一关是人：按 [release-behaviour-matrix.zh.md](./release-behaviour-matrix.zh.md) 在真 dsh 里逐条跑完。这一步刻意不自动化——测试文化最重的项目（SQLite）也把发布清单留给一个不断问"这真的对吗"的人。
5. 升上游窗口（drift.yml 的 issue 报绿时）：`ci/pinned-deps.json` + `ci/compat-window.json` + 重录 host-contract 与 readings，同一个 PR。

## 说不得台账

拒绝是产品决策，必须留下价格标签，否则会被反复重议（包括被自己在深夜重议）。已记录的拒绝：

- **在发行版内重写 PTC 运行时**（#78 的"彻底修法"）：等于替宿主维护一个子系统。拒绝，改为有引导的拒绝 + 报上游。
- **confine 押 Windows 临时目录**：伪装成修复的安全降级。拒绝。
- **G3 / docs-parity 两道闸**：重放证明不承重。退役（闸的退役也入这本账——减重与拒绝同权）。

新增拒绝在此登记一行：决定 + 代价 + 替代方案。

## 节奏与动机（给半年后的自己）

- 上游漂移不用你盯：drift.yml 每周三自动探测、按版本开/更新 issue，全绿时它只是提醒"窗口可升"。**不要让上游的发布节奏决定你的节奏。**
- 固定发布节奏优于攒大招。一个月五版的密度是还债模式，不是常态。
- 低谷是正常的。维护了 curl 二十五年的人至今承认"有时觉得无聊且做完了"，他的办法是找一个不重要但好玩的角落戳一戳，或者干脆少做一阵。用户的正向反馈是燃料，收着用。
- bug 报告天然带着羞耻感的推力——好用，但别让它垄断排期；说不得台账里的决定不在深夜重新心软。

## 如果我不在

- 基础设施不绑定个人：发布走 Trusted Publishing（tag 即全部手势）、CI 与探测全是 workflow、仓库里没有个人 token。
- 接手者入口顺序：README → 本页 → GATE-MAP 的五分钟版 → CHECK-CATALOG。五平面的概念从 GATE-MAP 的表进入，不需要先读懂 6.8k 行真机驱动才能干活（那层的裁定读数在 GATE-MAP 对账表里）。
- 这个仓库的续命机制已经自持：装置天花板防膨胀、退役按读数执行、重放尺子在每个发布前重测自己。
