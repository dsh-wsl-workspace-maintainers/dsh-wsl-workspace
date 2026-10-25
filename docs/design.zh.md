# dsh-wsl-workspace 设计方案

> **文档定位**：本文是 M1 到第五轮的**设计决策与轮次记录**，原文保留不改写；当前行为口径以
> [README.md](../README.md)（中文 [README.zh.md](../README.zh.md)）为准，版本历史见 [CHANGELOG.md](../CHANGELOG.md)，
> 逐版本实测证据见 [compatibility-evidence.md](./compatibility-evidence.md)。
> 已知被后续版本推翻的两处：第四轮的「变体移除 `grep`/`glob`」已由 0.6.0 在发行版内重建（`src/host/wsl-search.ts`）；
> 「持久 shell / 后台任务 / 技能目录实时刷新」在本文写作时尚不存在，见 0.5.0–0.7.0 的记录。

> 目标：在 DSH Web GUI 中提供「添加 WSL/远程工作区」按钮，点击后像 VSCode Remote-WSL 一样把**整个 agent 工作区**切换进 WSL——shell 命令、文件读写、文件树全部落在 WSL 执行世界里——且 **WSL 内零安装**（不需要在 WSL 里配置 DSH 工具链）。
>
> 目标用户：开发人员。运行形态：Windows 宿主机上的 `dsh web` + 本机 WSL2 发行版。

## 1. 现状调研结论（为什么现有插件不够）

| 方案 | 覆盖 | 缺口 |
|---|---|---|
| 官方 `fs-local` / `pwsh-local` | 同机同世界执行 | 无 WSL 概念；`bash-local` 明确 POSIX-only |
| 官方 `fs-e2b` / `subprocess-e2b` | 远程执行世界（E2B 云沙箱） | 面向 E2B 云，不接本机 WSL |
| 官方 `native-path-opener` | WSL 里跑 DSH 时把路径交给 Windows 桌面 | 方向相反，不是「从 Windows 连 WSL」 |
| 社区 `dsh-bash-terminal`（MIT） | `wsl -e bash -lc` 执行 + ConPTY 交互终端 | **只占一个额外 `shell` 工具，不占 `ctx.shell` 接缝**；read/write/edit 文件工具仍在 Windows 世界，不是「整个工作区切换」 |
| 社区 `dsh-side-panel`（BSD-3） | 侧栏文件浏览器/终端/Git 审查面板 | 后端直接用 `node:fs`/`child_process`，不走 `ctx.fs` 接缝，不认识 WSL 世界 |
| 社区 `vpshub`（MIT） | SSH 台账 + 远程执行/传输 | 面向 SSH 远程主机，不是 WSL；无工作区/文件树 UI |

结论：**「整个工作区切换到 WSL」需要换掉一组 capability provider（`ctx.shell` + `ctx.fs`， optionally `ctx.subprocess`），并且按会话生效**。官方架构完全支持这个做法（sandbox README：远程执行「以环境一致的整组替换 capability 的 Service Provider」；`agent-presets` 提供按会话组合挂载），缺的是实现。这正是本插件的位置。

## 2. 总体架构（三层）

```
┌─ Web 前端（client plugin）────────────────────────────────────┐
│  「添加 WSL 工作区」按钮 → 发行版/目录选择对话框               │
│  侧栏文件树面板（树/预览/终端 tab）                            │
└──────────────┬───────────────────────────────────────────────┘
               │ Typert Remote /webServer route + slots
┌──────────────┴───────────────────────────────────────────────┐
│  Host 组合层（bundle patch + preset）                         │
│  · preset `wsl`：tool-bash + shell-wsl + tool-fs + fs-wsl …   │
│  · 会话在 WSL 工作区创建时 join 该 preset（per-session 生效） │
└──────────────┬───────────────────────────────────────────────┘
               │ capability seams（ctx.shell / ctx.fs / ctx.subprocess）
┌──────────────┴───────────────────────────────────────────────┐
│  WSL 执行世界 provider（host 内实现，WSL 内零安装）           │
│  · wsl-world：发行版发现、UNC↔Linux 路径互译（wslpath 缓存）  │
│  · subprocess-wsl：wsl.exe -d <distro> --cd <cwd> -e <argv>   │
│  · shell-wsl：bash -lc over subprocess-wsl                    │
│  · fs-wsl：UNC（\\wsl.localhost\<distro>\…）直接读写          │
└───────────────────────────────────────────────────────────────┘
```

### 2.1 关键决策一：WSL 工作区的路径身份用 UNC 形式

工作区在 DSH 里以 canonical path 字符串为键（`ui-workspace`）。WSL 工作区统一用 UNC 路径登记：

```
\\wsl.localhost\Ubuntu\home\user\proj
```

- **零安装可读**：Windows 的 Node `fs` 原生可读写该路径（9P 共享），`fs-wsl` 的 v1 直接基于此实现，连 `tool-fs` 的 read/write/edit 都能工作。
- **可判定**：任何组件看到 `\\wsl.localhost\` / `\\wsl$\` 前缀即可判定「这是 WSL 工作区」，前端用它来自动选择 `wsl` preset。
- **可互译**：`wslpath -u/-w` 双向转换（带缓存），shell 执行时把 cwd 译成 Linux 路径喂给 `wsl.exe --cd`。

### 2.2 关键决策二：按会话切换执行世界 = preset，不是全局路由

候选做法 A（全局路由 provider：按路径前缀分发到 local/WSL）被否决：模型侧工具方言随组合固定——Windows 组合挂 `tool-pwsh`（PowerShell 方言），WSL 会话应当看到 `tool-bash`（POSIX 方言、Linux 路径）。单组合无法按会话换工具集，两个工具都挂则双倍 schema 成本且误导模型。

采用做法 B：**preset**（官方 `agent-presets` 机制，天然 per-session）：

- 插件随附 preset `wsl`（一个 `agent.cordis.yml`），组合 `tool-bash` + `shell-wsl` + `tool-fs` + `fs-wsl` + `fs-observation-policy` + `shell-env` + `jobs` 等——即 Linux/bash 工具链替换 pwsh 工具链。
- 机制已验证的事实：preset 挂载一次、会话经 scope 链（agent → preset → global）加入；preset 内的服务须放 `isolate` realm（root realm 服务会被 mount 拒绝）；仅空白会话可换 preset（`recompose` 限制），所以**绑定必须在会话创建时**完成。
- 绑定路径：前端「添加 WSL 工作区」流程提交工作区后，调 `agentPreset.select`（官方 Remote，未锁 loopback）把会话意图的 preset 置为 `wsl`；`session.create` 自带 `agentPreset` 参数，创建即加入。之后「就像直接调用一样使用」——模型看到的是 bash 工具，命令在 WSL 里跑，文件工具读写 WSL 文件。

### 2.3 关键决策三：文件操作 v1 走 UNC，不装 WSL 侧代理

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| UNC 直通（`\\wsl.localhost\…`） | 零安装；Node fs 直接用；原子写/rename 可用 | 9P 性能一般；无 inotify；stat 粒度粗 | **v1 默认** |
| WSL 侧 thin agent（stdio JSON-RPC） | 性能好；原生 inotify；PTY 保真高 | 首次需自举拷贝一个文件进 WSL（`wsl.exe bash -c` 即可完成，仍免手工配置） | v5 可选增强 |
| SSH 进 WSL | 与远程主机统一 | 要在 WSL 里配 sshd，违背「免配置」 | 不做（SSH 留给真正的远程主机场景，见 §6 M4） |

`fs-wsl` 实现 `FileSystem` 的 12 个原语（resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText）。`processPath(target)` 返回 **Linux 路径**（供 WSL 内子进程打开），`displayPath` 对模型/UI 也显示 Linux 路径（`fs-e2b` 先例：display 用执行世界语法）；`resolve` 接受 UNC 或 Linux 形式输入并归一到同一 `targetKey`。版本守卫用 stat 元数据（mtime+size），9P 下粒度够用（M1 验证点）。

### 2.4 关键决策四：前端挂载点——优先官方 slot，面板用已验证的 overlay 路线

- **入口按钮**：`sidebar.workspaces.directoryFlow` 洞是 `kind: 'single'`——**只能有一个占据者**，无法与官方目录选择器并存。两条路线：
  - **R1（v1 推荐，非侵入）**：`sidebar.footer.action` 是 `kind: 'list'` 的侧栏底部动作槽，注册「添加 WSL 工作区…」按钮，点击弹出自研对话框（列发行版 → 浏览/输入 Linux 目录 → 提交）。提交后走与官方 adoption 相同的对象层 API 添加工作区（M1 验证点：`useWorkspaces` 对象层的 add 入口），再 `agentPreset.select('wsl')`。
  - **R2（v2 打磨）**：占据 `sidebar.workspaces.directoryFlow`（及 hero 的同名洞），提供复合流程：「本机文件夹…（委托 `host.pickDirectory`）/ WSL 工作区…」。体验最接近原生，但要替换官方占据者（组合层二选一）。
- **文件树面板**：官方侧栏只声明 `sidebar.workspaces` / `sidebar.settings` / `sidebar.footer.action` 三个槽，没有通用面板洞。`dsh-side-panel` 已验证可行路线：Host 注册 route + 前端 overlay 面板（挂 app shell 网格）。我们沿用该模式但做两处改进：后端改走 `ctx.fs` 接缝（因此 WSL/本地世界通吃，而不是裸 `node:fs` 只认 Windows）、树根绑定**当前会话的工作区 cwd**。
- 若接受对本仓库打一处小补丁，可在 `ui-sidebar` 声明正式 `sidebar.panel` 洞（`kind: 'single'`），面板即成一等公民。列为可选增强，不作为依赖。

### 2.5 关键决策五：沙箱立场

Windows ACL 沙箱无法有意义地包裹 `wsl.exe`（子进程在 Linux 内核侧）。采用与 `dsh-bash-terminal` 一致的立场：**WSL 独立 Linux VM 即隔离边界**，结果报告 `enforcement: 'wsl-isolation'`；受限模式下不假装提供 Windows 级文件策略。fail-closed 语义保留：部署若强制要求内核级 confinement，WSL provider 应明确报 `SANDBOX_UNAVAILABLE` 而非裸跑——做成 config 开关 `assumeWslIsolation`（默认 true，面向开发人员单机场景）。

## 3. 模块拆解（包结构）

```
dsh-wsl-workspace/                    # 一个仓库，多包（或单包多入口，见下）
├─ src/
│  ├─ world/        # wsl-world：distro 发现(wsl.exe -l -q)、wslpath 互译缓存、UNC 判定
│  ├─ subprocess/   # WslSubprocessRuntime extends SubprocessRuntime
│  ├─ shell/        # WslShellExecutor extends ShellExecutor（config 镜像 bash-local 旋钮）
│  ├─ fs/           # WslFileSystem extends FileSystem（UNC 后端）
│  ├─ host/         # Host Remote：wslWorkspaces.listDistros/listDir（供前端选择器与文件树）
│  ├─ client/       # 前端插件：footer 按钮、发行版/目录对话框、文件树面板
│  └─ preset/wsl/   # 随附 preset：agent.cordis.yml + preset.yml（显示名「WSL」）
├─ cordis.patch.yml # bundle manifest：挂载 host/client 行
└─ NOTICE           # 第三方代码出处与许可（见 §5）
```

打包形态建议：**单 npm 包 + 多 export**（`.` host 半 / `./client` 浏览器半 / `./preset` 预设目录），`dsh plugin add` 一次到位；`dsh.bundle` manifest + `cordis.patch.yml` 走官方 bundle 机制。preset 目录由安装流程拷贝/注册到 `<dshHome>/.agent-presets/wsl`（user root，`agent-presets` 自动扫描）。

注意 `dsh-bash-terminal` 的教训：DSH api-gateway 对 Web 设置面有 settings namespace 白名单，第三方设置项会被拒。本设计**不依赖设置 UI**——distro 列表自动发现，路径由对话框显式选择——从而避开 install.ps1 式补丁。

## 4. 前端交互流程（M1 闭环）

1. 侧栏底部出现「添加 WSL 工作区…」按钮（`sidebar.footer.action`）。
2. 点击 → 对话框：调用 Host Remote `wslWorkspaces.listDistros()`（后端 `wsl.exe -l -q` 解析）列出发行版；选定后 `wslWorkspaces.listDir(distro, linuxPath)` 提供目录浏览（或直接输入路径，带存在性校验）。
3. 提交：前端把 `\\wsl.localhost\<distro>\<path>` 作为工作区加入（对象层 add API），随后 `agentPreset.select('wsl')` 把会话意图切到 WSL 组合。
4. 新建会话即运行于 WSL：模型持有 `bash` 工具（Linux 方言），`read/write/edit` 经 `fs-wsl` 落 UNC；会话 cwd 显示 Linux 路径。
5. 文件树面板（M2）：侧栏 footer 另一个动作「工作区文件」开合右侧面板，树数据来自 Host Remote（内部走 `ctx.fs`），点击文件预览（`readText` 有界读取），本地/WSL 工作区通吃。

## 5. 可复用/改写的开源组件与许可注明

以下来源均为**宽松许可证**（MIT/BSD-3-Clause），允许修改、再发布乃至商用，义务是保留版权与许可声明。将全部列入插件根 `NOTICE` 文件，改写文件头部保留原版权声明：

| 来源 | 许可证 | 复用内容 |
|---|---|---|
| [MAXeaglet/dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal) | MIT | WSL argv 构造（`wsl -d <distro> --cd <dir> -e bash -lc`）、WSLENV 环境透传、ConPTY+wsl.exe 交互终端的已知坑（0x8007072c 偶发 RPC 错误）、进程树终止参数 |
| [ccq1/dsh-side-panel](https://github.com/ccq1/dsh-side-panel) | BSD-3-Clause | 文件树/预览/终端面板的挂接模式（Host route + 前端 overlay）、目录列举/预览的大小与二进制护栏；后端改为走 `ctx.fs` 接缝 |
| [Sdongmaker/vpshub](https://github.com/Sdongmaker/vpshub) | MIT | （M4 SSH 扩展）连接台账模型、密钥仅路径引用的凭据立场 |
| 官方仓库先例 | MIT（随仓库） | `fs-e2b`/`subprocess-e2b`（远程执行世界 provider 模板）、`bash-local`（executor config 旋钮）、`ui-directory-picker-browse`（directoryFlow 洞契约）、`agent-presets`（per-session 组合） |

> 说明：需求里提到「遵循不商用开源」——实际调研发现这几个候选插件都是 MIT/BSD 这类**比“不商用”更宽松**的许可证（允许商用，只要求署名），因此改写合规，按要求注明出处即可。若后续引入 copyleft（GPL 系）组件需单独评估。

## 6. 分阶段实施计划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 核心闭环** | wsl-world + subprocess-wsl + shell-wsl + fs-wsl(UNC) + preset `wsl` + footer 按钮 + 发行版/目录对话框 + 自动 preset 绑定 | WSL 工作区里建会话，bash 命令在 WSL 跑（`uname -a` 见 Linux），read/write/edit 落 WSL 文件；本地工作区行为不变 |
| **M2 文件树** | 树面板（改写 dsh-side-panel）+ Host Remote 走 `ctx.fs` + 预览 | 面板显示当前工作区树，WSL/本地均正确；大文件/二进制护栏生效 |
| **M3 交互终端** | `spawnTerminal`（ConPTY 包 wsl.exe）+ 面板终端 tab | REPL/ssh 等交互会话可用；记录并规避 ConPTY 已知问题（PS5.1、WSL RPC 偶发） |
| **M4 SSH 远程工作区** | 抽象 `ExecWorld`（resolve/spawn/fs），新增 ssh 后端（spawn=ssh、fs=sftp/ssh），按钮升级为「添加 WSL/远程工作区」源选择 | 同一 UI 可加 SSH 主机工作区（vpshub 式台账） |
| **M5 性能（可选）** | WSL 侧单文件 helper：首用时经 `wsl.exe` 自举拷贝，fs/list/search 改走 stdio JSON-RPC | 大目录列举/搜索明显提速；UNC 模式保留为默认与回退 |

## 7. 风险与待验证点（M1 开工前先验）

1. **工作区 add 的对象层 API**：footer action 路线需要在 ui-workspace 之外添加工作区——确认 `useWorkspaces`/`workspaces` 服务对象暴露的 add 入口及其 canonicalization（UNC 路径是否会原样保留为键）。若不暴露，退回 R2（占 directoryFlow 洞，复用 owner 的 adoption）。
2. **`agentPreset.select` 的作用域**：确认它影响的是「下一个新会话」还是可绑定到具体 workspace；必要时把「workspace→preset」映射存在插件自己的 Host 存储里，在会话创建参数上补齐。
3. **9P 上的 fs 语义**：原子 rename、stat mtime 粒度、symlink 行为（`lstat` 原语依赖）——用真实 WSL2 环境跑 `fs-observation-policy` 的读-改-写闭环验证版本守卫不误报 `FS_STALE_VERSION`。
4. **`wsl.exe` 进程模型**：每次 spawn 起一个 wsl.exe 的启动开销（~100-300ms）；后台进程在 wsl.exe 退出后的存活语义（发行版实例随最后进程退出而关闭）——background job 需要保活策略或文档化限制。
5. **工具搜索**：`tool-fs-search` 走 `@vscode/ripgrep` 经 `ctx.subprocess`——在 WSL 组合下 rg 会从 Windows 侧经 UNC 扫 9P，慢。M1 可在 preset 里先不带 search 工具，M3/M5 用 WSL 内 rg 解决。

## 8. 与官方架构的契合声明

- 不改动 agent-loop、不新增 loop 行为；全部行为挂在已文档化的扩展点（capability seam provider / preset 组合 / slots / Remote）。
- provider 实现遵循接缝契约：`SubprocessRuntime`（argv 不经 shell 解释、spec 全显式）、`ShellExecutor`（request→spec resolve 分离）、`FileSystem`（12 原语 + FsError 码）。
- 无可硬编码旋钮：distro 发现自动、超时/字节上限镜像 `bash-local` 的 Config 字段、隔离立场走 `assumeWslIsolation` 配置项。
- 配置错误 fail loud：发行版不存在、路径不在 WSL 世界、UNC 不可达都在最早可判定点抛结构化错误。

## 9. 实现状态（M1 已完成并实测）

**M1 核心闭环已实现并验证**（`plugins/dsh-wsl-workspace/`）：

| 组件 | 状态 | 验证 |
|---|---|---|
| `shared/paths`（UNC↔Linux 互译） | ✅ | 16 项单元测试 |
| `shared/wsl`（`wsl.exe -l -q` UTF-16 解码 + 注册表默认发行版） | ✅ | 真实 WSL（Ubuntu/docker-desktop） |
| `fs-wsl`（子类化 `LocalFileSystem`，UNC 后端） | ✅ | 真实 WSL：resolve/write/read/edit/stat/版本/listDir/contains/fileUrl 全通过 |
| `shell-wsl`（`wsl.exe -d … --cd … -e bash -lc` + WSLENV） | ✅ | 真实 WSL：cwd 翻译、`uname` 见 Linux、`$DSH_*` 经 WSLENV 透传、stdin、后台任务 |
| host 插件（preset 安装器 + `/wsl-workspace/api` 路由） | ✅ | materialize 断言：isolate realm、绝对路径行指向真实 lib 文件 |
| client（footer 按钮 + 对话框 + 空白会话自动绑 `wsl` preset） | ✅ 类型检查通过 | 需在真实 GUI 中点击验证 |
| 构建（tsdown：lib/{index,shell,fs,client}.js） | ✅ | 产物可在纯 Node 加载 |

**实测发现并解决**：WSL 9P 共享不支持硬链接，`fs-local` 默认的原子写 `link(tmp,dest)` 在 9P 上失败（`ENOTSUP: operation not supported on socket`）。`fs-wsl` 通过 `internals` 钩子把发布原语替换为 rename 基（no-replace 发布先探测后 rename，替换发布直接 rename——Windows rename 原子替换），并跳过 9P 无意义的 DACL 拷贝。

**开发运行解析**：仓库根 node_modules 不含 workspace 链接，测试运行时靠 `plugins/dsh-wsl-workspace/node_modules` junction → `$env:USERPROFILE\.dsh\profiles\node_modules`（195 个 @deepseek-ai 包的 profile 回退镜像）。

**剩余验证**：把插件装进真实 profile（`dsh plugin --profile web add <path>`）后重启，走一遍「添加 WSL 工作区 → 新会话 bash/文件工具全程在 WSL」的端到端点击流程；这是 M2 之前的最后一道闸。

## 10. 第二轮需求（已实现）

| 需求 | 实现 | 验证 |
|---|---|---|
| 选了 WSL 后无法切回其它模式 | 根因：自动绑 preset 的 effect 会覆盖 hero 里的显式选择。修复：**每会话只自动绑定一次**（首次出现时）；此后用户的选择被尊重并保持；在某工作区显式切走过模式的，该工作区新会话不再自动绑定 | 逻辑审查 + 类型检查 |
| 按钮移到区头「搜索/视图选项/添加工作区」旁并列 | **上游没有这个席位**（见下节）：改为运行时镜像宿主区头控件，不再改官方包 | `tests/client-dom.test.mjs` 区头/菜单两例 + `client-classnames` |
| 联合访问（同时访问本机文件系统与 WSL） | `fs-wsl` 的 translate 新增 `/mnt/<drive>/...` 输入分支（映射回 Windows 盘直接读写，显示仍为 /mnt 形式）；bash 侧 `/mnt/<drive>` 本就可达；persona 明确引导迁移方式（跨路径 read/write 或 bash cp） | 冒烟新增用例：`dual access OK (Windows files via /mnt/<drive>)` 实测通过 |

#### 区头入口没有官方 slot（2026-10 复核）

实测运行中的 GUI（`cordis_inspect` → client `Slots`）与上游 master 的 [Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots) 树一致：`sidebar.workspaces`（`single`）的 child 只有 `sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、`sidebar.workspaces.directoryFlow`、`sidebar.session.row.leading`、`sidebar.session.row.hover`；选择器 `conversation.hero.workspace`（`single`）只有 `conversation.hero.workspace.directoryFlow`。侧栏里唯一的通用 React 席位是 `sidebar.footer.action`（`list`，owner `{ wide }`），插件已占用它作为回退。

第四轮曾在本仓库给 `ui-workspace` 打补丁新增 `sidebar.workspaces.headerAction`（`list`，owner `{ wide }`），第五轮按「官方包零改动」回退，上游从未合并过这个洞。

所以「插到添加工作区旁边」只能靠运行时镜像（`src/client/hostEntry.ts`）：复制该按钮的 `className`（盒子就是宿主盒子）、按 `role="menu"` 克隆「添加工作区…」行，并把 `_headerActions` 的 60px 上限撑到 92px 以容纳第三个控件。悬浮提示用共享原语 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`（`side="bottom"`、`delayMs={500}`），与宿主同一份实现，因此气泡、延迟、翻转都一致。真正的零注入要等上游在 `sidebar.workspaces` 下声明 header child slot，届时改成 `ctx.slots.inject()` 即可，镜像逻辑可整体删除。

### 加固轮（代码审查后）

| 问题 | 性质 | 修复 |
|---|---|---|
| 路由 `distro` 参数未校验，含分隔符/`..` 可逃逸 `\\wsl.localhost\` 共享结构 | **安全（UNC 遍历）** | 路由层 `requireDistro` 严格校验 + `joinUnc` 纵深防御校验（含单测） |
| 路由无 Host 头校验 | 安全（DNS rebinding） | 仅接受 localhost/127.0.0.1/::1 Host 头 |
| 模型传 Linux `workdir` 报「no distro is configured」 | **功能缺陷（真实故障）** | host 插件注册 `DSH_WSL_DISTRO` 会话事实（shell-env 贡献者，从会话 UNC cwd 取发行版）；执行器解析链：会话事实 → config.distro → 缓存默认发行版；persona 提示同步更新 |
| preset 路径含单引号会破坏 YAML | 健壮性 | 单引号翻倍转义 |
| `fs-wsl` 的 `config.cwd` 传 Linux 路径时抛错 | 功能缺陷 | `uncCwd` 支持 Linux 形式（经 distroFor 转 UNC） |
| `wsl.exe` 进程以 UNC cwd 启动（Node 边界风险） | 健壮性 | UNC workdir 时进程侧 cwd 改用 `SystemRoot` |
| 对话框允许以发行版根 `/` 建工作区 | 一致性 | 确认时与检查时一致拒绝 `/` |
| 自动绑 preset 失败会每次列表变更都重试 | 健壮性 | 每会话最多 3 次尝试 |
| CSS token 核对 | 验证 | 全部 17 个 `--dsw-*` token 在 ui-theme 中真实存在 |

### 第三轮：执行世界与模式正交（WSL 变体族）

用户反馈「选 WSL 后无法再用标准/PTC/极简/创造等模式」——根因是把「WSL 执行世界」做成了独占 preset。重构为**变体族**：

- host 启动时枚举 roster 全部健康 preset（`ctx.agentPresets` 服务），为每个生成 `wsl-<模式>` 变体（`wsl-standard`/`wsl-code`/`wsl-minimal`/`wsl-cordis`…）：把源 preset 目录作为不透明、自包含单元完整镜像，再由 `src/host/variants.ts` 删除宿主执行世界行并注入 WSL realm（shell-wsl + fs-wsl + tool-bash + tool-fs，以及源 preset 需要的 str-replace-editor）。WSL fs 从当前 `tools/execute` 上下文继承 session cwd，因此未显式传 cwd 的旧文件工具也保持会话发行版亲和；真正无 session 的 provider 调用才回退默认发行版。`persistent-shell` 不重加。标准类 persona 追加 WSL 引导句；陈旧变体（源 preset 消失）自动清理。
- 前端自动绑定改为**模式映射**：WSL 工作区的空白会话，从当前模式（含部署默认）映射到 `wsl-<模式>` 变体；选择器里也直接可见「WSL · 标准模式」等条目。全局引导注入（上一轮治标方案）按用户意见移除。
- 验证：变体变换 6 项单测 + materialize 全流程断言（变体生成/内容/persona/PTY 改向/陈旧清理）+ 构建/冒烟全绿。

### 第四轮（按真实会话记录 debug）：grep 工具与独立 wsl 模式

- **会话记录实证**：`wsl-cordis` 会话里 `grep` 工具对 `/mnt/d/...` 路径报「拒绝访问 (os error 5)」——变体保留的 `tool-fs-search` 在 Windows 侧跑 ripgrep，无法打开 Linux 路径。修复：`tool-fs-search` 加入 WORLD_ROWS（所有变体移除 grep 工具，搜索交给 WSL 内的 bash grep）；README 记录。
- **独立 `wsl` 模式移除**（用户要求）：插件不再物化 standalone `wsl` preset，启动时清理其遗留目录；前端映射把遗留 `wsl` 会话重定向到默认模式的变体；`presetId` 配置删除。materialize 测试新增「遗留目录清理」断言。

### 第五轮：模式选择器按工作区过滤 + 顺序对齐（后回退）

- 曾通过官方 `ui-agent-preset` 的 `agentPresetOptionFilter` 服务接缝实现按工作区过滤模式列表，并让变体继承源模式 `order` 对齐顺序。
- **用户决策：官方包零改动，回退功能**。本仓库曾给官方包打的两个补丁（`ui-workspace` 里本地新增的 `sidebar.workspaces.headerAction` 洞、`ui-agent-preset` 的过滤接缝）已完整还原（源码 + README + 重建 lib），官方测试 278 项全绿。
- 保留：变体族、模式自动映射、`/mnt` 联合访问、变体 `order` 继承（roster 显示顺序对齐仍生效）。回退的只是「按工作区隐藏/过滤模式条目」这一 UI 层。`src/shared/presets.ts` 及测试删除。入口位置后来改成区头运行时镜像（见上一节「区头入口没有官方 slot」），不再使用 `sidebar.footer.action` 作为宽栏主入口。
