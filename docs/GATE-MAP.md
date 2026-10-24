# 门禁地图（GATE-MAP）

这份文件回答三个问题：**这道闸守哪类缺陷、跑在哪台机器、红了去看什么**。它是 `docs/CHECK-CATALOG.md` 的阅读版——目录里逐条记录每个装置的实现细节与首次读数，这张表只用来在五分钟内定位。改任何一道闸之前先在这里找它；找不到就说明它在管覆盖之外的事，应该被删掉或说清用途。

缺陷四类来自 issue #101 对 29 条 issue 的归因，`A` 假件比真宿主宽容 / `B` 断言不可能失败 / `C` 这一面根本没有装置 / `D` 只在真机现出形。度量工具是 `npm run test:replay`：把 20 个真实缺陷逐个种回工作树，数有几枚被闸接住。

## 五分钟版：谁守哪一类

| 类别 | 闸（npm script） | 跑在哪 |
| --- | --- | --- |
| A 宿主漂移（契约、名字、注册） | `test:contract` `test:readings` `test:unit` `test:node` `verify:install` `test:compat` `upstream-drift`（drift.yml，每周三） | ubuntu + pinned 闭包；compat 每周 windows；drift 每周 ubuntu |
| B 断言不可能失败（空断言、假绿） | `test:replay`（尺子本身） `test:docs-claims` `deliberate-reds` 台账（`test:seams` 末尾） `typecheck:gate` | 维护者本地 / ubuntu |
| C 输入形状（工作区路径、盘符、UNC） | `test:world` `test:shapes` `test:install` | ubuntu + pinned 闭包；`test:shapes` 真机臂本地 |
| C 前端状态机（渲染出的文字） | `test:client` | ubuntu |
| D 真机现形（发行版、9P、ConPTY） | `test:session` `test:win32` `test:wsl` 的 `*-real` 驱动 `test:seams` 的三台探针 | windows-latest，WSL1/WSL2 × src/lib 两平面 |
| 卫生（已回本，不算覆盖） | `verify` `verify:lib-sync` `verify:artifact` `verify:plane` `test:matrix` `lint:portability` `script-reachability` `check-unit-closure` | ubuntu |

体积基线：见 `ci/apparatus-size.json`（当前 **2.02 倍**，含前十重文件的逐行读数）。数字只记在那份记录里，这张表不抄第二遍；红线见文末。

## 明细：逐道闸

| 闸门 | 守什么 | 跑在哪 | 红灯时看什么 |
| --- | --- | --- | --- |
| `npm run test:unit`（232 例） | 纯 node 平面：变体生成、路径与译名、locale、#22/#87 的 persona 形状扫描、#35 的 `execFile` 结果形状 | ubuntu `lint-build`；本地任意平台 | 断言名自带缺陷号；`tests/` 里同名测试的 `#NN` 就是归属 issue |
| `npm run test:client`（13 例） | 对话框**渲染出来的文字**：健康态不得出现错误条、失败态必须带变体号与宿主原话、轨道形(rail)的字与无障碍名 | ubuntu `lint-build`（需 `npm ci` 装上 jsdom/react） | `tests/client-dom.test.mjs` 的 state 表；#49/#52/#96/#99 的归属写在用例名里 |
| `npm run test:world` | 一张工作区形状表喂给所有"决定我会话在哪个发行版哪个 Linux 目录"的 provider，要求逐格一致或显式拒绝 | ubuntu `runtime-tests`（需 pinned 闭包） | `tests/replay/shapes.mjs` 是形状的唯一出处；某格开始同意已登记的洞→红灯是设计如此 |
| `npm run test:contract` | TypeScript 看不见的半张契约：`ctx.get('…')` 服务名、世界行的 `name:`、同一个世界两行抢一个工具名 | ubuntu `runtime-tests`，**发布前也跑**（`release.yml`） | 先看 `ci/host-contract.json` 的 diff；漂移行会点名对应的重放单元。冲突没登记就红，登记过的洞自己合上也会红 |
| `npm run test:readings` | 每次发布的两项固定读数：重放命中率、契约闸看到的名字/世界/冲突数 | ubuntu `runtime-tests`，发布前 | 红=没录读数、读数是按别一把尺取的（`tableSha` 变了）、或契约现读数与记录不符。修法就是 `npm run release:readings` 重录一次 |
| `npm run test:install` | 安装形状：清单表面（真依赖、不得在调用点 import 宿主包）＋ profile 形树的加载 | ubuntu `runtime-tests` | #47/#89 那一族；`P1-P7` 前提是 fixture 的问题不是产品的问题 |
| `npm run test:node` | 宿主包在场时的装配：shell 执行形、jobs、search、terminal、client 生命周期、`host-materialize`（含 #78 的挂载格）、fallback 与 execute 接缝 | ubuntu `runtime-tests` | 每个 `assert(...)` 的第二参数就是结论；`--pty`/默认两档分别跑 |
| `npm run test:seams` | 六套接缝驱动（route-envelope、search-run-fakes、tech-debt-exposure、三台真宿主探针）＋故意红台账：观察到的红必须等于声明的红 | ubuntu `runtime-tests` | 台账会写"一票红无人认领"；要么修要么进 `tests/deliberate-reds.mjs` 并附债与修法 |
| `npm run test:win32` | Windows 语义：技能目录扫描、fs 策略、relay 解释器与持久 shell 降级 | windows `wsl-gate` | #10/#12/#25/#40 那一族；在 ubuntu 上它本就该缺席 |
| `npm run test:session` | 一个真宿主、一个真会话、六个工具格（bash/read/grep/glob/read_image/job_output）＋每格的耗时上限 | windows `wsl-gate`（需发行版） | `notMeasured` 只许是声明过的格；耗时超上限就是 #25 那一类回来了 |
| `npm run test:profile` | profile 形树里"调用时才 import 宿主包"的隔离后果 | ubuntu `runtime-tests` | 前提行 P1-P7 红了是装置问题 |
| `npm run test:wsl`（`*-real` 驱动） | 真实发行版上的 fs/search/skills/relay/bash/ConPTY 现场 | windows `wsl-gate`，WSL1 与 WSL2 分别 | 每格自己声明断的是"读法起作用"还是"读法声明"；artifact `wsl-gate-logs-*` 里能看出是哪台 |
| `npm run test:compat` | 指定宿主版本上装→起→探→卸→再探 | windows，每周 3 个版本窗口 | 只有 `PASS compatible` 算绿；八种判词大多数是环境问题，不是接口漂移 |
| `upstream-drift`（drift.yml，每周三 03:37） | 上游**未声明**的漂移：registry 上越过 pinned 的最高版本（看 `versions` 而非 dist-tag——rc.3 比 latest 早到一天），锁步组改写后装上，跑 world/contract/node，一版一 issue（绿=窗口可升，红=有人要适配，FAMILY-INCOMPLETE=上游发一半下周再看） | ubuntu（ephemeral、无 pinned 缓存，故意的） | issue 正文带每道门禁的红名与 #56/#87/#60 的历史形态；探测脚本本身的状态机与"只动锁步组"的边界写在 `scripts/probe-upstream.mjs` 头注 |
| `npm run test:replay` | 尺子：20 枚真实缺陷重放 | **不进 CI**（它改写工作树，约 5 分钟），发布前由 `release:readings` 跑一次 | 只信"植入后必须有闸红"；`--dry` 抓过时植点，`DSH_REPLAY_SKIP_GATES` 回答"这道闸承不承重" |
| `npm run test:shapes` | 每个形状走最短一轮：登记→打开→列出→放下 | 本地/维护者；真机臂要 `DSH_SMOKE_REAL=1` | 控制格（默认发行版的 `/` 必须列得出）没过的话，整片"拒绝"读数不算数 |
| 卫生层：`verify` / `verify:lib-sync` / `verify:artifact` / `verify:plane` / `test:matrix` / `lint:portability` / `typecheck:gate` | 产物同一性、构建可重现、提交产物与源码一致、平面日志、发布矩阵形状、可移植拼写、类型债不增长 | ubuntu `lint-build` / `runtime-tests` / 发布前 | 这些是已回本的地板，重放命中率不是它们的评价标准；要动它们请单独提审 |

## 真机平面的对账（2026-10-21 量 seams/session；2026-10-24 量 wsl，31 枚植入逐枚询闸）

| 平面 | 询到它的耗时 | 接住的植入 | 其中独占（日常闸接不住的） |
| --- | --- | --- | --- |
| `test:seams`（route-envelope / search-run-fakes / tech-debt-exposure / 三台真宿主探针） | 851 s | **3**（#35 `execFile` 结果形、#36 UTF-16 解码、#105 世界组重复） | **0** |
| `test:session`（一个真宿主一个真会话六格） | 183 s | **0** | **0** |
| `test:wsl`（`test:wsl` 链的 10 台真机驱动；CI windows+WSL2，replay-plane dispatch，run 40060136498） | 1 699 s | **4** 枚植入（单元口径 2/20：#10、#35 整单元；#86、#36 各一半） | **0** |

`test:wsl` 的读数来得很晚是因为环境：本机 `TMP=D:\Temp` 的拼写让 `smoke.ts` 在干净树上就红（同一格在 CI 的 src 平面绿），本机 9P 对 `skills-real` 的符号链接又是另一个形状——两条环境红都不是读数。2026-10-24 起这个问题有了通解：`.github/workflows/replay-plane.yml`（dispatch-only，复用 wsl-gate 的环境与钉版缓存）在任何时候把尺子搬到全部驱动都绿的 runner 形状上，裁定产物随 `replay-plane-reading` artifact 落盘。本机不可裁不再是"未量"的理由。

三行合起来的结论要写清楚：**"这 20 枚里没有一枚依赖真机平面"是真的**（31/31 都被离线闸先接住，三平面独占全为 0），"**真机平面没有价值**"不是。wsl 平面接住的那 4 枚全部是**驱动自身消费了被植入的缝**（发行版发现、`/mnt` 路径翻译、技能扫描）——它是一个会自己走过真缝的深度冒烟网，而不是回归网：`bash-session-real`（1 094 行）、`bash-parity-real`、`tool-bash-real`、两枚 relay 驱动在 31 枚植入上贡献 0 接住，它们守的是"发版前这十二台驱动在真发行版上还能不能用"和"下一个只会在硬件上现形的新形状"，这两样离线闸按定义给不了。所以减重裁决：**这层没有"证明不承重"的可删大块**——接住集中在 smoke/skills-real/search-real 三处；想裁行数就得接受冒烟深度下降，那是产品决策；2026-10-24 P1 把天花板抬到 2.02 的账，更现实的还法是分母增长（功能开发）与下一轮对元装置的逐条审计。

## 已退役（2026-10-21，带读数）

- `tests/artifact-semantics.test.mjs`（G3，245 行）与 `npm run test:artifacts`。
- `scripts/check-docs-parity.mjs` 与 `npm run test:docs`（11 项文档 parity）。`scripts/unwrap-prose.mjs` **保留**：它不只是校验——`release.yml` 用 `--stdout --section` 从英文 CHANGELOG 生成中文 release notes，砍它会砍掉产品功能。

依据是上面那条裁决读数：摘掉这两道，重放仍 20/20。**随它们一起离开的断言，写清楚免得将来重新发现**：① 生成的世界里每个挂载路径都必须在包里存在；② README 的章节名集合、CHANGELOG 中英成对、相对链接图、十语一致。这两条现在没有任何装置守——`tests/readme-compat.test.mjs`（仍在 `test:unit`）还守着 README 的兼容表与发布清单，算半个。

## 红灯该找谁

这个仓库只有一个维护者，所以"找谁"实际是"按哪条线索走"：

1. 先读用例名里的 `#NN` —— 每一道闸都是某个真实缺陷换来的，缺陷正文比代码注释更能说明它为什么存在。
2. 类别是 A（宿主漂移）时，先看 `ci/host-contract.json` 与 `ci/release-readings.json`：是宿主改了名字，还是我们改了名字。
3. 类别是 D（真机）时，取 `wsl-gate-logs-wsl1` / `-wsl2` 或 `compat-*` artifact 里的原帧，别在本地复现前先归因给产品。
4. 只有"正确性缺口"才阻塞合并；"只是没人看过"是待办，不是红灯理由。

## 发布前必须做的两件事

1. `npm run release:readings` —— 它跑一次重放基准（约 5 分钟，改写工作树，所以**不在**日常 CI 里）并把两项读数写进 `ci/release-readings.json`：命中率 `X of 20` 与契约闸看到的名字/世界/冲突数。
2. 打 tag。`release.yml` 在 Trusted Publishing 之前跑 `npm run test:readings`：没有这一版读数、或读数不是按当前这把尺子取的（`tableSha` 变了）、或契约现读数和记录不符，发布就红。**没跑过重放就发不出去**，这是"每次发布报两项读数"的实现方式，不靠人记得。

## 本轮瘦身实测过的两处"看着冗余"，结论是不动

- `tests/support/` 的五枚探针：改名了，一枚都没退役。每一枚持有离线重放拿不到的现场读数（真宿主 boot、realm 边界、Windows ACL 链）。
- `scripts/compatibility/`：目录总共 2,959 行，重复的 fixture-root 与清理只出现在 4 个文件（`WSL_COMPAT_ROOT` 4 次、`mkdtempSync` 6 次、`rmSync` 6 次），能抽掉的上限约 150 行；为此新增一个 builder 文件是把复杂度从"重复"换成"间接"，不划算。
- `tests/parity/derive.mjs`：删掉的 218 行是**两边都证明不承重**的死推导（既无文件 import，也无文件内调用）：`offeredJobChannels`、`hostMentions`、`declaredInject`、`bareContextReads`、`CORDIS_API`。剩下的不是模板机器，是逐条 claim 的读取器——把它们换成硬编码结论就等于把"派生"退回"抄写"，那正是 #101 的 B 类缺陷。

## 红线：装置体积

装置体积不得超过产品代码的 **2 倍**，且新增一道闸必须先有等量旧装置退役。`npm run test:apparatus-size` 在比值越线时红灯，并把当前比值与最重的十个文件打出来——**当前基线 2.02 倍**（本轮从 2.03 降下来：删掉的比新增的多，余量就还给后来的闸），即此刻起任何净增都必须先还体积；每减一处，余量就还给后来的闸。
